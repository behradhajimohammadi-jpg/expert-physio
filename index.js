const express = require("express");
const { google } = require("googleapis");
const app = express();
app.use(express.json());

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const GOOGLE_ID     = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const BASE_URL      = process.env.BASE_URL; // e.g. https://your-app.railway.app
const PORT          = process.env.PORT || 3001;

// ─── STATE (use a DB in production) ──────────────────────────────────────────
let gmailTokens   = null;
let processedIds  = new Set();
let pendingReview = [];       // held for human review
let sendQueue     = [];       // scheduled to auto-send after delay
let sentLog       = [];       // full log of every sent email
let activityLog   = [];
let voiceProfile  = {         // Expert Physio's voice — editable from dashboard
  samples: [],                // approved reply samples
  guidelines: `
- Always greet by first name if known
- Keep replies under 4 sentences for simple emails
- Never make clinical promises or give medical advice
- Always offer a next step (call, book online, reply back)
- Sign off as "Expert Physio Team"
- Tone: warm, professional, never robotic
- For cancellations: express understanding, offer rebooking
- For new patients: welcoming, mention direct billing where applicable
- For ICBC: acknowledge only, never promise outcomes
`.trim(),
};

// ─── LOGGING ──────────────────────────────────────────────────────────────────
function log(msg, type = "info") {
  const time = new Date().toLocaleTimeString("en-CA", { hour: "2-digit", minute: "2-digit" });
  const entry = { time, msg, type };
  activityLog.unshift(entry);
  if (activityLog.length > 200) activityLog.pop();
  console.log(`[${time}] [${type.toUpperCase()}] ${msg}`);
}

// ─── ANTHROPIC AI ─────────────────────────────────────────────────────────────
async function callAI(userMsg, systemMsg, jsonMode = false) {
  const system = jsonMode
    ? systemMsg + "\n\nCRITICAL: Respond ONLY with a valid JSON object. No markdown fences, no explanation."
    : systemMsg;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1200,
      system,
      messages: [{ role: "user", content: userMsg }],
    }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e?.error?.message || `AI API error ${res.status}`);
  }
  const data = await res.json();
  const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
  if (!text) throw new Error("Empty AI response");
  return text;
}

function parseJSON(raw) {
  const clean = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/m, "").trim();
  try { return JSON.parse(clean); }
  catch { const m = clean.match(/\{[\s\S]*\}/); if (m) return JSON.parse(m[0]); throw new Error("JSON parse failed"); }
}

// ─── GMAIL ────────────────────────────────────────────────────────────────────
function getOAuthClient() {
  return new google.auth.OAuth2(GOOGLE_ID, GOOGLE_SECRET, `${BASE_URL}/auth/callback`);
}

function getGmail() {
  if (!gmailTokens) throw new Error("Gmail not connected");
  const auth = getOAuthClient();
  auth.setCredentials(gmailTokens);
  auth.on("tokens", t => {
    if (t.refresh_token) gmailTokens.refresh_token = t.refresh_token;
    gmailTokens.access_token = t.access_token;
  });
  return google.gmail({ version: "v1", auth });
}

async function fetchUnread() {
  const gmail = getGmail();
  const res = await gmail.users.messages.list({ userId: "me", q: "is:unread in:inbox", maxResults: 25 });
  return res.data.messages || [];
}

async function getEmailDetails(id) {
  const gmail = getGmail();
  const res = await gmail.users.messages.get({ userId: "me", id, format: "full" });
  const msg = res.data;
  const hdr = msg.payload.headers;
  const get = name => hdr.find(h => h.name.toLowerCase() === name)?.value || "";
  let body = "";
  const walk = part => {
    if (part.mimeType === "text/plain" && part.body?.data)
      body = Buffer.from(part.body.data, "base64").toString("utf-8");
    else if (part.parts) part.parts.forEach(walk);
  };
  walk(msg.payload);
  return {
    id,
    threadId: msg.threadId,
    from: get("from"),
    to: get("to"),
    subject: get("subject"),
    body: body.trim().slice(0, 2500),
    date: get("date"),
  };
}

async function markRead(id) {
  const gmail = getGmail();
  await gmail.users.messages.modify({ userId: "me", id, requestBody: { removeLabelIds: ["UNREAD"] } });
}

async function sendEmail(threadId, to, subject, body) {
  const gmail = getGmail();
  const subj = subject.startsWith("Re:") ? subject : `Re: ${subject}`;
  const raw = Buffer.from(
    [`To: ${to}`, `Subject: ${subj}`, `Content-Type: text/plain; charset="UTF-8"`, ``, body].join("\r\n")
  ).toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
  await gmail.users.messages.send({ userId: "me", requestBody: { raw, threadId } });
}

async function applyLabel(id, name) {
  const gmail = getGmail();
  const list = await gmail.users.labels.list({ userId: "me" });
  let label = list.data.labels.find(l => l.name === name);
  if (!label) {
    const c = await gmail.users.labels.create({
      userId: "me",
      requestBody: { name, labelListVisibility: "labelShow", messageListVisibility: "show" },
    });
    label = c.data;
  }
  await gmail.users.messages.modify({ userId: "me", id, requestBody: { addLabelIds: [label.id] } });
}

// ─── OAUTH ROUTES ─────────────────────────────────────────────────────────────
app.get("/auth/login", (req, res) => {
  const auth = getOAuthClient();
  const url = auth.generateAuthUrl({
    access_type: "offline", prompt: "consent",
    scope: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/gmail.modify",
    ],
  });
  res.redirect(url);
});

app.get("/auth/callback", async (req, res) => {
  try {
    const auth = getOAuthClient();
    const { tokens } = await auth.getToken(req.query.code);
    gmailTokens = tokens;
    log("Gmail connected — autopilot started", "success");
    startPolling();
    res.redirect("/?connected=1");
  } catch (err) {
    log("OAuth error: " + err.message, "error");
    res.status(500).send("Authentication failed: " + err.message);
  }
});

// ─── CLASSIFICATION + CONFIDENCE SCORING ──────────────────────────────────────
/*
  Returns:
  {
    category: "cancellation" | "new-patient" | "billing" | "referral" | "icbc" | "complaint" | "other",
    autoSend: true | false,
    confidence: 0-100,        // how sure the AI is
    reason: "string",         // why it made this decision
    urgency: "normal" | "high"
  }

  autoSend = true ONLY when:
  - category is cancellation, new-patient, billing, or referral
  - confidence >= 80
  - No clinical claims, legal risk, or ambiguity detected
*/
async function classify(email) {
  const voiceContext = voiceProfile.samples.length > 0
    ? `\n\nVoice samples from this clinic:\n${voiceProfile.samples.slice(0, 3).join("\n---\n")}`
    : "";

  const raw = await callAI(
    `Classify this physiotherapy clinic email and determine if it is safe to auto-reply without human review.

From: ${email.from}
Subject: ${email.subject}
Body: ${email.body}

Return JSON with these exact keys:
{
  "category": "cancellation|new-patient|billing|referral|icbc|complaint|other",
  "autoSend": true or false,
  "confidence": 0-100,
  "reason": "one sentence explaining your decision",
  "urgency": "normal|high",
  "extractedName": "patient first name if found, else null"
}

Auto-send rules — set autoSend to TRUE only if ALL of these are true:
1. Category is one of: cancellation, new-patient, billing, referral
2. Confidence is 80 or above
3. No clinical questions requiring a therapist's judgment
4. No legal risk, complaints, or expressions of dissatisfaction
5. No ICBC claim numbers or authorization requests
6. No requests for specific appointment times (those need schedule access)

Set autoSend to FALSE for: ICBC, complaints, anything ambiguous, anything requiring clinical judgment, anything with legal implications.${voiceContext}`,
    "You are a clinical email triage system for a physiotherapy clinic. Be conservative — when in doubt, set autoSend to false. Patient safety and clinic reputation come first.",
    true
  );

  try {
    return parseJSON(raw);
  } catch {
    return { category: "other", autoSend: false, confidence: 0, reason: "Classification failed", urgency: "normal", extractedName: null };
  }
}

// ─── REPLY GENERATION WITH VOICE MATCHING ────────────────────────────────────
const REPLY_TEMPLATES = {
  cancellation: (name) => `Thank you for letting us know, ${name || ""}. We completely understand that things come up! We'd love to find a new time that works for you — please reply with a few days and times that suit you, or give us a call and we'll get you rebooked right away.`,
  "new-patient": (name) => `Hi ${name || "there"}, thank you for reaching out to Expert Physio! We'd be happy to welcome you as a new patient. We do direct bill to most major insurance providers. To book your initial assessment, please call us or reply with your availability and we'll find a time that works for you.`,
  billing: (name) => `Hi ${name || "there"}, thank you for getting in touch about your account. Our admin team will look into this and follow up with you within 1-2 business days. If you have your insurance policy number handy, please include it in your reply to help us process this faster.`,
  referral: (name) => `Thank you for the referral. We've received your note and will be in touch with the patient within 2 business days to schedule their initial assessment. Please don't hesitate to reach out if you need anything in the meantime.`,
  other: (name) => `Hi ${name || "there"}, thank you for your message. A member of our team will review this and get back to you within 1-2 business days.`,
};

async function generateReply(email, classification) {
  const { category, extractedName } = classification;
  const name = extractedName ? extractedName.split(" ")[0] : null;

  // Build voice context from approved samples
  const voiceContext = voiceProfile.samples.length > 0
    ? `\n\nHere are examples of approved replies from this clinic to match the tone and style:\n${voiceProfile.samples.slice(0, 3).map((s, i) => `Example ${i + 1}:\n${s}`).join("\n\n")}`
    : "";

  const baseTemplate = REPLY_TEMPLATES[category] ? REPLY_TEMPLATES[category](name) : REPLY_TEMPLATES.other(name);

  const reply = await callAI(
    `You are writing an email reply on behalf of Expert Physio, a physiotherapy clinic in Burnaby, BC.

Voice guidelines:
${voiceProfile.guidelines}${voiceContext}

Base template to improve upon:
"${baseTemplate}"

Original email context:
From: ${email.from}
Subject: ${email.subject}
Body: ${email.body}

Instructions:
- Use the base template as a starting point but make it feel natural and specific to this email
- Use the patient's name "${name || "the sender"}" if appropriate
- Do NOT add a subject line
- Do NOT make any clinical promises or give medical advice
- Do NOT mention specific appointment times or dates (no schedule access)
- Sign off as "Expert Physio Team"
- Maximum 4 sentences
- Sound human, not robotic

Write ONLY the email body, starting with the greeting.`,
    "You write warm, professional physiotherapy clinic emails. Match the clinic's voice exactly."
  );

  return reply;
}

// ─── CORE PROCESSING ──────────────────────────────────────────────────────────
const SEND_DELAY_MS = 5 * 60 * 1000; // 5 minutes

async function processEmail(id) {
  if (processedIds.has(id)) return;
  processedIds.add(id);

  let email;
  try { email = await getEmailDetails(id); }
  catch (err) { log(`Failed to fetch ${id}: ${err.message}`, "error"); processedIds.delete(id); return; }

  log(`Received: "${email.subject}" from ${email.from}`);

  try {
    const classification = await classify(email);
    log(`Classified: ${classification.category} | confidence: ${classification.confidence}% | autoSend: ${classification.autoSend} — ${classification.reason}`);

    await markRead(id);

    if (classification.autoSend && classification.confidence >= 80) {
      // Generate reply
      const replyBody = await generateReply(email, classification);

      // Schedule for send after 5-minute delay window
      const sendAt = Date.now() + SEND_DELAY_MS;
      const queueItem = {
        id: `q_${Date.now()}_${id}`,
        emailId: id,
        email,
        classification,
        replyBody,
        sendAt,
        cancelled: false,
        createdAt: new Date().toISOString(),
      };
      sendQueue.push(queueItem);

      log(`Queued to send in 5 min: "${email.subject}" → ${email.from} (${classification.category}, ${classification.confidence}% confidence)`, "queued");

      // Schedule the actual send
      setTimeout(async () => {
        const item = sendQueue.find(q => q.id === queueItem.id);
        if (!item || item.cancelled) {
          log(`Send cancelled for: "${email.subject}"`, "cancelled");
          return;
        }
        try {
          await sendEmail(email.threadId, email.from, email.subject, item.replyBody);
          await applyLabel(id, "AI-Auto-Replied");

          // Move to sent log
          sentLog.unshift({
            id: queueItem.id,
            email,
            replyBody: item.replyBody,
            category: classification.category,
            confidence: classification.confidence,
            sentAt: new Date().toISOString(),
          });
          if (sentLog.length > 500) sentLog.pop();

          // Remove from queue
          sendQueue = sendQueue.filter(q => q.id !== queueItem.id);

          log(`✅ Auto-sent to ${email.from}: "${email.subject}" (${classification.category})`, "sent");
        } catch (err) {
          log(`Send failed for "${email.subject}": ${err.message}`, "error");
          sendQueue = sendQueue.filter(q => q.id !== queueItem.id);
        }
      }, SEND_DELAY_MS);

    } else {
      // Hold for human review
      const draftReply = await generateReply(email, classification);
      await applyLabel(id, "AI-Needs-Review");

      pendingReview.push({
        id: `r_${Date.now()}_${id}`,
        emailId: id,
        email,
        classification,
        draftReply,
        receivedAt: new Date().toISOString(),
      });

      const reason = classification.confidence < 80
        ? `low confidence (${classification.confidence}%)`
        : classification.reason;

      log(`⚠️ Held for review: "${email.subject}" — ${reason}`, "review");
    }

  } catch (err) {
    log(`Processing error for "${email?.subject}": ${err.message}`, "error");
    processedIds.delete(id);
  }
}

// ─── POLLING ──────────────────────────────────────────────────────────────────
let pollingInterval = null;

async function pollInbox() {
  if (!gmailTokens) return;
  try {
    const messages = await fetchUnread();
    const newOnes = messages.filter(m => !processedIds.has(m.id));
    if (newOnes.length > 0) {
      log(`Found ${newOnes.length} new email(s)`);
      for (const m of newOnes) {
        await processEmail(m.id);
        await new Promise(r => setTimeout(r, 1500));
      }
    }
  } catch (err) {
    log(`Poll error: ${err.message}`, "error");
  }
}

function startPolling() {
  if (pollingInterval) clearInterval(pollingInterval);
  pollingInterval = setInterval(pollInbox, 5 * 60 * 1000);
  pollInbox();
  log("Autopilot started — inbox check every 5 minutes", "success");
}

// ─── API ROUTES ───────────────────────────────────────────────────────────────

app.get("/api/status", (req, res) => res.json({
  connected: !!gmailTokens,
  polling: !!pollingInterval,
  queueCount: sendQueue.filter(q => !q.cancelled).length,
  reviewCount: pendingReview.length,
  sentToday: sentLog.filter(s => new Date(s.sentAt).toDateString() === new Date().toDateString()).length,
  processed: processedIds.size,
}));

app.get("/api/log",    (req, res) => res.json(activityLog.slice(0, 100)));
app.get("/api/review", (req, res) => res.json(pendingReview));
app.get("/api/queue",  (req, res) => res.json(sendQueue.filter(q => !q.cancelled)));
app.get("/api/sent",   (req, res) => res.json(sentLog.slice(0, 100)));
app.get("/api/voice",  (req, res) => res.json(voiceProfile));

// Cancel a queued send (within 5-min window)
app.post("/api/queue/:id/cancel", (req, res) => {
  const item = sendQueue.find(q => q.id === req.params.id);
  if (!item) return res.status(404).json({ error: "Not found or already sent" });
  item.cancelled = true;
  log(`Send cancelled by staff: "${item.email.subject}"`, "cancelled");
  res.json({ success: true });
});

// Approve a review item and send
app.post("/api/review/:id/approve", async (req, res) => {
  const item = pendingReview.find(p => p.id === req.params.id);
  if (!item) return res.status(404).json({ error: "Not found" });
  try {
    const body = req.body.reply || item.draftReply;
    await sendEmail(item.email.threadId, item.email.from, item.email.subject, body);
    await applyLabel(item.emailId, "AI-Replied");
    sentLog.unshift({ ...item, replyBody: body, sentAt: new Date().toISOString(), manualApproval: true });
    pendingReview = pendingReview.filter(p => p.id !== req.params.id);
    log(`✅ Review approved + sent to ${item.email.from}`, "sent");
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Discard a review item
app.post("/api/review/:id/discard", (req, res) => {
  const before = pendingReview.length;
  pendingReview = pendingReview.filter(p => p.id !== req.params.id);
  pendingReview.length < before
    ? res.json({ success: true })
    : res.status(404).json({ error: "Not found" });
});

// Update voice profile guidelines
app.post("/api/voice/guidelines", (req, res) => {
  if (!req.body.guidelines) return res.status(400).json({ error: "Missing guidelines" });
  voiceProfile.guidelines = req.body.guidelines;
  log("Voice guidelines updated", "info");
  res.json({ success: true });
});

// Add a voice sample (approved reply example)
app.post("/api/voice/sample", (req, res) => {
  if (!req.body.sample) return res.status(400).json({ error: "Missing sample" });
  voiceProfile.samples.push(req.body.sample);
  if (voiceProfile.samples.length > 10) voiceProfile.samples.shift(); // keep last 10
  log(`Voice sample added (${voiceProfile.samples.length} total)`, "info");
  res.json({ success: true, count: voiceProfile.samples.length });
});

// Remove a voice sample
app.delete("/api/voice/sample/:index", (req, res) => {
  const i = parseInt(req.params.index);
  if (isNaN(i) || i < 0 || i >= voiceProfile.samples.length)
    return res.status(404).json({ error: "Invalid index" });
  voiceProfile.samples.splice(i, 1);
  res.json({ success: true });
});

// Manual poll trigger
app.post("/api/poll", (req, res) => {
  if (!gmailTokens) return res.status(400).json({ error: "Gmail not connected" });
  pollInbox();
  res.json({ success: true });
});

// Proxy for frontend AI calls
app.post("/api/claude", async (req, res) => {
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set" });
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(req.body),
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DASHBOARD ────────────────────────────────────────────────────────────────
app.get("*", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>Expert Physio AI Agent</title>
  <script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
  <script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
  <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&family=DM+Serif+Display&display=swap" rel="stylesheet">
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'DM Sans','Helvetica Neue',sans-serif;background:#F8FAFC;color:#111827}
    @keyframes spin{to{transform:rotate(360deg)}}
    @keyframes fadeIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
    ::-webkit-scrollbar{width:4px}
    ::-webkit-scrollbar-thumb{background:#CBD5E1;border-radius:4px}
    textarea,input,button{font-family:inherit}
    textarea:focus,input:focus{outline:2px solid #0EA5E9;outline-offset:1px;border-radius:4px}
  </style>
</head>
<body>
<div id="root"></div>
<script type="text/babel">
  const {useState,useRef,useEffect} = React;

  async function api(path,opts={}){
    const r=await fetch(path,{headers:{"Content-Type":"application/json"},...opts});
    if(!r.ok){const e=await r.json().catch(()=>({}));throw new Error(e.error||"Request failed "+r.status);}
    return r.json();
  }
  async function callClaude(msg,sys){
    const d=await api("/api/claude",{method:"POST",body:JSON.stringify({model:"claude-sonnet-4-6",max_tokens:900,system:sys||SYSTEM,messages:[{role:"user",content:msg}]})});
    const t=(d.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("\\n").trim();
    if(!t)throw new Error("Empty response");
    return t;
  }
  async function callClaudeJSON(msg,sys){
    const raw=await callClaude(msg,sys);
    const clean=raw.replace(/^\`\`\`(?:json)?\\s*/i,"").replace(/\\s*\`\`\`\\s*$/,"").trim();
    try{return JSON.parse(clean);}catch{const m=clean.match(/\\{[\\s\\S]*\\}/);if(m)return JSON.parse(m[0]);throw new Error("JSON parse failed");}
  }

  const SYSTEM=\`You are the AI assistant for Expert Physio, a physiotherapy clinic in Burnaby, BC. Tone: warm, professional, concise. Sign as "Expert Physio Team".\`;

  const INIT_EMAILS=[
    {id:1,from:"sarah.mitchell@gmail.com",name:"Sarah Mitchell",subject:"Appointment Cancellation - Thursday 2pm",preview:"Hi, I need to cancel my appointment...",body:"Hi, I need to cancel my appointment this Thursday at 2pm. I have a conflict at work. Can we reschedule? Any time Tuesday or Wednesday works. Thanks, Sarah",time:"9:14 AM",status:"unread",tag:"cancellation"},
    {id:2,from:"icbc.claims@icbc.com",name:"ICBC Claims",subject:"Claim #4892-B: Treatment Authorization Required",preview:"Please submit updated treatment plan...",body:"Please submit updated treatment plan for claimant John Patel (Claim #4892-B). Authorization is required before proceeding with further sessions. Please respond within 5 business days.",time:"8:30 AM",status:"unread",tag:"icbc"},
    {id:3,from:"drlee@familyclinic.ca",name:"Dr. Angela Lee",subject:"Referral: Marcus Huang - Lower Back Pain",preview:"I am referring Marcus Huang, 42...",body:"I am referring Marcus Huang, 42, for physiotherapy following a lumbar strain. Three weeks of lower back pain. Please book him at your earliest convenience.",time:"Yesterday",status:"read",tag:"referral"},
    {id:4,from:"kevin.tran88@hotmail.com",name:"Kevin Tran",subject:"Question about my invoice",preview:"Hi there, I received an invoice...",body:"Hi there, I received an invoice for $180 but think my insurance covers 80%. Can you resubmit to Pacific Blue Cross? Policy number PBC-2291-TK.",time:"Yesterday",status:"read",tag:"billing"},
    {id:5,from:"amanda.shore@gmail.com",name:"Amanda Shore",subject:"New Patient Inquiry",preview:"Hello, I found you on Google...",body:"Hello, I found you on Google and was wondering if you're accepting new patients? I have a rotator cuff injury. Available weekday mornings. Do you direct bill to MSP?",time:"Mon",status:"read",tag:"new-patient"},
  ];
  const TAGS={cancellation:{bg:"#FFF0F0",color:"#C0392B",label:"Cancellation"},icbc:{bg:"#EEF2FF",color:"#4338CA",label:"ICBC"},referral:{bg:"#F0FFF4",color:"#166534",label:"Referral"},billing:{bg:"#FFFBEB",color:"#92400E",label:"Billing"},"new-patient":{bg:"#F0F9FF",color:"#0369A1",label:"New Patient"}};

  function Spinner({label="Working…"}){return <div style={{display:"flex",alignItems:"center",gap:8,color:"#6B7280",fontSize:13,padding:"6px 0"}}><div style={{width:14,height:14,borderRadius:"50%",border:"2px solid #E5E7EB",borderTop:"2px solid #0EA5E9",animation:"spin .7s linear infinite",flexShrink:0}}/>{label}</div>;}
  function Toast({msg,onClose}){return <div style={{position:"fixed",top:20,right:20,zIndex:9999,background:"#111827",color:"#fff",padding:"11px 20px",borderRadius:10,fontSize:13,fontWeight:500,boxShadow:"0 4px 24px rgba(0,0,0,.25)",animation:"fadeIn .25s ease",display:"flex",gap:12,alignItems:"center",maxWidth:380}}><span style={{flex:1}}>{msg}</span><button onClick={onClose} style={{background:"none",border:"none",color:"#9CA3AF",cursor:"pointer",fontSize:18,lineHeight:1}}>×</button></div>;}
  function Err({msg,onClose}){if(!msg)return null;return <div style={{background:"#FFF0F0",border:"1px solid #FECACA",borderRadius:8,padding:"10px 14px",fontSize:13,color:"#B91C1C",display:"flex",justifyContent:"space-between",alignItems:"center",margin:"8px 16px 0"}}><span>⚠️ {msg}</span><button onClick={onClose} style={{background:"none",border:"none",color:"#B91C1C",cursor:"pointer",fontWeight:700,fontSize:16,marginLeft:12}}>×</button></div>;}

  function ConfidenceBadge({score}){
    const color=score>=80?"#059669":score>=60?"#D97706":"#DC2626";
    const bg=score>=80?"#F0FFF4":score>=60?"#FFFBEB":"#FFF0F0";
    return <span style={{fontSize:10,fontWeight:700,padding:"2px 8px",borderRadius:20,background:bg,color}}>{score}% confidence</span>;
  }

  function CountdownTimer({sendAt,onCancel}){
    const [sec,setSec]=useState(Math.max(0,Math.round((sendAt-Date.now())/1000)));
    useEffect(()=>{
      if(sec<=0)return;
      const t=setInterval(()=>setSec(s=>{if(s<=1){clearInterval(t);return 0;}return s-1;}),1000);
      return()=>clearInterval(t);
    },[]);
    const m=Math.floor(sec/60),s=sec%60;
    if(sec<=0)return <span style={{fontSize:12,color:"#059669",fontWeight:600}}>Sent ✓</span>;
    return <div style={{display:"flex",alignItems:"center",gap:8}}>
      <span style={{fontSize:12,color:"#D97706",fontWeight:600}}>Sending in {m}:{String(s).padStart(2,"0")}</span>
      <button onClick={onCancel} style={{fontSize:11,padding:"3px 10px",background:"#FEF3C7",color:"#92400E",border:"1px solid #FCD34D",borderRadius:6,cursor:"pointer",fontWeight:600}}>Cancel</button>
    </div>;
  }

  function App(){
    const [tab,setTab]=useState("Autopilot");
    const [status,setStatus]=useState(null);
    const [serverLog,setServerLog]=useState([]);
    const [reviewQueue,setReviewQueue]=useState([]);
    const [sendQueue,setSendQueue]=useState([]);
    const [sentLog,setSentLog]=useState([]);
    const [voice,setVoice]=useState(null);
    const [expandedReview,setExpandedReview]=useState(null);
    const [expandedSent,setExpandedSent]=useState(null);
    const [emails,setEmails]=useState(INIT_EMAILS);
    const [selEmail,setSelEmail]=useState(null);
    const [summaries,setSummaries]=useState({});
    const [replies,setReplies]=useState({});
    const [loadId,setLoadId]=useState(null);
    const [loadAction,setLoadAction]=useState(null);
    const [composeText,setComposeText]=useState("");
    const [composed,setComposed]=useState(null);
    const [composeBusy,setComposeBusy]=useState(false);
    const [editingGuidelines,setEditingGuidelines]=useState(false);
    const [guidelinesText,setGuidelinesText]=useState("");
    const [newSample,setNewSample]=useState("");
    const [toast,setToast]=useState(null);
    const [err,setErr]=useState(null);
    const replyRef=useRef(null);

    const showToast=msg=>{setToast(msg);setTimeout(()=>setToast(null),3500);};

    useEffect(()=>{
      const refresh=async()=>{
        try{
          const [s,l,r,q,sent,v]=await Promise.all([
            api("/api/status"),api("/api/log"),api("/api/review"),
            api("/api/queue"),api("/api/sent"),api("/api/voice"),
          ]);
          setStatus(s);setServerLog(l);setReviewQueue(r);
          setSendQueue(q);setSentLog(sent);setVoice(v);
        }catch{}
      };
      refresh();
      const t=setInterval(refresh,8000);
      return()=>clearInterval(t);
    },[]);

    const cancelSend=async id=>{
      try{await api("/api/queue/"+id+"/cancel",{method:"POST"});showToast("Send cancelled — email moved to review");}
      catch(e){setErr(e.message);}
    };

    const approveReview=async(item,editedReply)=>{
      try{
        await api("/api/review/"+item.id+"/approve",{method:"POST",body:JSON.stringify({reply:editedReply})});
        setReviewQueue(q=>q.filter(x=>x.id!==item.id));
        setExpandedReview(null);
        showToast("✓ Reply sent to "+item.email.from);
      }catch(e){setErr(e.message);}
    };

    const discardReview=async id=>{
      await api("/api/review/"+id+"/discard",{method:"POST"});
      setReviewQueue(q=>q.filter(x=>x.id!==id));
    };

    const saveGuidelines=async()=>{
      try{await api("/api/voice/guidelines",{method:"POST",body:JSON.stringify({guidelines:guidelinesText})});setEditingGuidelines(false);showToast("✓ Voice guidelines saved");}
      catch(e){setErr(e.message);}
    };

    const addSample=async()=>{
      if(!newSample.trim())return;
      try{await api("/api/voice/sample",{method:"POST",body:JSON.stringify({sample:newSample})});setNewSample("");showToast("✓ Voice sample added");}
      catch(e){setErr(e.message);}
    };

    const removeSample=async i=>{
      await api("/api/voice/sample/"+i,{method:"DELETE"});
      showToast("Sample removed");
    };

    const selectEmail=async email=>{
      setErr(null);setSelEmail(email);
      setEmails(p=>p.map(e=>e.id===email.id?{...e,status:e.status==="unread"?"read":e.status}:e));
      if(summaries[email.id])return;
      setLoadId(email.id);setLoadAction("sum");
      try{const s=await callClaude("Summarise in 1-2 sentences and state the best next action.\\n\\nFrom: "+email.name+"\\nSubject: "+email.subject+"\\nBody: "+email.body);setSummaries(p=>({...p,[email.id]:s}));}
      catch(e){setErr("Summary failed: "+e.message);}
      finally{setLoadId(null);setLoadAction(null);}
    };

    const draftReply=async()=>{
      if(!selEmail||loadId)return;
      setErr(null);setLoadId(selEmail.id);setLoadAction("rep");
      try{
        const r=await callClaude("Write a professional reply for Expert Physio. No subject line. Start with greeting. End with Expert Physio Team.\\n\\nFrom: "+selEmail.name+"\\nSubject: "+selEmail.subject+"\\nBody: "+selEmail.body);
        setReplies(p=>({...p,[selEmail.id]:r}));
        setTimeout(()=>replyRef.current?.scrollIntoView({behavior:"smooth"}),100);
      }catch(e){setErr("Draft failed: "+e.message);}
      finally{setLoadId(null);setLoadAction(null);}
    };

    const compose=async()=>{
      if(!composeText.trim())return;
      setComposeBusy(true);setComposed(null);setErr(null);
      try{
        const r=await callClaudeJSON('Compose a clinic email: "'+composeText+'"\\n\\nReturn ONLY JSON: {"to":"email","subject":"subject","body":"body ending Expert Physio Team"}');
        if(!r.subject||!r.body)throw new Error("Incomplete");
        setComposed({to:r.to||"",subject:r.subject,body:r.body});
      }catch(e){setErr("Compose failed: "+e.message);}
      finally{setComposeBusy(false);}
    };

    const TABS=["Autopilot","Queue","Voice","Inbox","Compose","Sent Log"];
    const ICONS={Autopilot:"⚡",Queue:"👁",Voice:"🎙",Inbox:"📬",Compose:"✏️","Sent Log":"📊"};
    const unread=emails.filter(e=>e.status==="unread").length;
    const curReply=selEmail?(replies[selEmail.id]||")":"";
    const curSum=selEmail?(summaries[selEmail.id]||""):"";
    const activeQueue=sendQueue.filter(q=>!q.cancelled);

    return(
      <div style={{display:"flex",flexDirection:"column",height:"100vh",overflow:"hidden"}}>
        {toast&&<Toast msg={toast} onClose={()=>setToast(null)}/>}

        {/* Header */}
        <div style={{background:"#0B1F3A",height:56,display:"flex",alignItems:"center",justifyContent:"space-between",padding:"0 22px",flexShrink:0,borderBottom:"1px solid #1E3A5F"}}>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <div style={{width:32,height:32,borderRadius:8,background:"linear-gradient(135deg,#0EA5E9,#0369A1)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:16}}>🤖</div>
            <div>
              <div style={{fontFamily:"'DM Serif Display',serif",fontSize:16,color:"#fff"}}>Expert Physio AI Agent</div>
              <div style={{fontSize:10,color:status?.connected?"#6EE7B7":"#FCA5A5",display:"flex",alignItems:"center",gap:4}}>
                <span style={{width:6,height:6,borderRadius:"50%",background:status?.connected?"#6EE7B7":"#FCA5A5",display:"inline-block",animation:status?.connected?"pulse 2s infinite":"none"}}/>
                {status?.connected?"Autopilot running — inbox monitored every 5 min":"Gmail not connected"}
              </div>
            </div>
          </div>
          <div style={{display:"flex",gap:8,alignItems:"center"}}>
            {reviewQueue.length>0&&<span style={{background:"#EF4444",color:"#fff",borderRadius:20,fontSize:11,fontWeight:700,padding:"3px 10px"}}>⚠️ {reviewQueue.length} need review</span>}
            {activeQueue.length>0&&<span style={{background:"#F59E0B",color:"#fff",borderRadius:20,fontSize:11,fontWeight:700,padding:"3px 10px"}}>⏱ {activeQueue.length} sending soon</span>}
            {!status?.connected&&<a href="/auth/login" style={{padding:"7px 16px",background:"#0EA5E9",color:"#fff",borderRadius:8,fontSize:12,fontWeight:600,textDecoration:"none"}}>Connect Gmail →</a>}
          </div>
        </div>

        <div style={{display:"flex",flex:1,overflow:"hidden"}}>
          {/* Sidebar */}
          <div style={{width:200,background:"#fff",borderRight:"1px solid #E5E7EB",display:"flex",flexDirection:"column",flexShrink:0}}>
            <div style={{padding:"14px 0",flex:1}}>
              {TABS.map(t=>{
                const active=tab===t;
                return <button key={t} onClick={()=>setTab(t)} style={{width:"100%",padding:"9px 16px",background:active?"#F0F9FF":"transparent",borderLeft:"3px solid "+(active?"#0EA5E9":"transparent"),border:"none",cursor:"pointer",textAlign:"left",fontSize:13,fontWeight:active?600:400,color:active?"#0284C7":"#374151",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                  <span>{ICONS[t]} {t}</span>
                  {t==="Inbox"&&unread>0&&<span style={{background:"#0EA5E9",color:"#fff",borderRadius:10,fontSize:10,fontWeight:700,padding:"1px 6px"}}>{unread}</span>}
                  {t==="Queue"&&reviewQueue.length>0&&<span style={{background:"#EF4444",color:"#fff",borderRadius:10,fontSize:10,fontWeight:700,padding:"1px 6px"}}>{reviewQueue.length}</span>}
                  {t==="Autopilot"&&activeQueue.length>0&&<span style={{background:"#F59E0B",color:"#fff",borderRadius:10,fontSize:10,fontWeight:700,padding:"1px 6px"}}>{activeQueue.length}</span>}
                </button>;
              })}
            </div>
            <div style={{margin:"0 10px 14px",padding:12,background:"#F8FAFC",borderRadius:10,border:"1px solid #E5E7EB"}}>
              <div style={{fontSize:10,fontWeight:700,color:"#6B7280",marginBottom:7,letterSpacing:.5}}>TODAY</div>
              {[["⚡",status?.sentToday||0+" auto-sent"],["⏱",activeQueue.length+" in queue"],["⚠️",reviewQueue.length+" for review"],["📊",status?.processed||0+" processed"]].map(([ic,tx])=>(
                <div key={tx} style={{fontSize:12,color:"#374151",lineHeight:1.9}}>{ic} {tx}</div>
              ))}
            </div>
          </div>

          {/* Main */}
          <div style={{flex:1,overflow:"hidden",display:"flex",flexDirection:"column"}}>
            {err&&<Err msg={err} onClose={()=>setErr(null)}/>}
            <div style={{flex:1,overflow:"hidden",display:"flex"}}>

              {/* ══ AUTOPILOT ══ */}
              {tab==="Autopilot"&&(
                <div style={{flex:1,overflowY:"auto",padding:28}}>
                  <div style={{maxWidth:780}}>
                    <div style={{fontFamily:"'DM Serif Display',serif",fontSize:22,marginBottom:4}}>Autopilot Status</div>
                    <div style={{fontSize:13,color:"#6B7280",marginBottom:22}}>The agent monitors the inbox every 5 minutes. Simple emails auto-send after a 5-minute cancel window. Complex emails wait for your review.</div>

                    {!status?.connected&&(
                      <div style={{background:"#FFF7ED",border:"1px solid #FED7AA",borderRadius:12,padding:20,marginBottom:20,display:"flex",alignItems:"center",justifyContent:"space-between",gap:16}}>
                        <div>
                          <div style={{fontWeight:600,color:"#92400E",marginBottom:4}}>Gmail not connected</div>
                          <div style={{fontSize:13,color:"#B45309"}}>One-time authorisation needed to start the autopilot.</div>
                        </div>
                        <a href="/auth/login" style={{padding:"10px 20px",background:"#F59E0B",color:"#fff",borderRadius:8,fontSize:13,fontWeight:600,textDecoration:"none",whiteSpace:"nowrap",flexShrink:0}}>Connect Gmail →</a>
                      </div>
                    )}

                    {/* Send queue - 5 min window */}
                    {activeQueue.length>0&&(
                      <div style={{background:"#FFFBEB",border:"1px solid #FDE68A",borderRadius:12,padding:18,marginBottom:16}}>
                        <div style={{fontSize:14,fontWeight:700,marginBottom:12,color:"#92400E",display:"flex",alignItems:"center",gap:8}}>⏱ Sending Soon — 5 Minute Cancel Window</div>
                        {activeQueue.map(item=>(
                          <div key={item.id} style={{padding:"10px 12px",background:"#fff",borderRadius:8,marginBottom:8,border:"1px solid #FDE68A",display:"flex",alignItems:"center",justifyContent:"space-between",gap:12}}>
                            <div style={{flex:1,minWidth:0}}>
                              <div style={{fontSize:13,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{item.email.subject}</div>
                              <div style={{fontSize:11,color:"#6B7280",marginTop:2,display:"flex",gap:8,alignItems:"center"}}>
                                <span>To: {item.email.from}</span>
                                <ConfidenceBadge score={item.classification.confidence}/>
                              </div>
                            </div>
                            <CountdownTimer sendAt={item.sendAt} onCancel={()=>cancelSend(item.id)}/>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Auto-send rules */}
                    <div style={{background:"#fff",border:"1px solid #E5E7EB",borderRadius:12,padding:20,marginBottom:16}}>
                      <div style={{fontSize:14,fontWeight:700,marginBottom:14}}>⚡ Auto-Send Rules</div>
                      {[
                        {icon:"📅",label:"Cancellations",action:"Auto-reply offering reschedule",auto:true},
                        {icon:"🙋",label:"New Patient Inquiries",action:"Auto-reply with welcome + booking info",auto:true},
                        {icon:"💳",label:"Simple Billing Questions",action:"Auto-reply acknowledging, 1-2 day follow-up",auto:true},
                        {icon:"👨‍⚕️",label:"Doctor Referrals",action:"Auto-reply confirming receipt",auto:true},
                        {icon:"🏥",label:"ICBC Claims",action:"Held — staff review required",auto:false},
                        {icon:"😤",label:"Complaints",action:"Held — staff review required",auto:false},
                        {icon:"❓",label:"Low Confidence (<80%)",action:"Held — AI not certain enough",auto:false},
                      ].map(r=>(
                        <div key={r.label} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"9px 0",borderBottom:"1px solid #F3F4F6"}}>
                          <div style={{display:"flex",alignItems:"center",gap:10}}>
                            <span style={{fontSize:18}}>{r.icon}</span>
                            <div>
                              <div style={{fontSize:13,fontWeight:600}}>{r.label}</div>
                              <div style={{fontSize:11,color:"#6B7280"}}>{r.action}</div>
                            </div>
                          </div>
                          <span style={{fontSize:11,fontWeight:600,padding:"3px 10px",borderRadius:20,background:r.auto?"#F0FFF4":"#FFF0F0",color:r.auto?"#166534":"#C0392B"}}>{r.auto?"✓ Auto-Send":"👁 Review First"}</span>
                        </div>
                      ))}
                    </div>

                    {/* Live log */}
                    <div style={{background:"#fff",border:"1px solid #E5E7EB",borderRadius:12,padding:20}}>
                      <div style={{fontSize:14,fontWeight:700,marginBottom:14}}>📊 Live Activity</div>
                      {serverLog.length===0
                        ?<div style={{fontSize:13,color:"#9CA3AF"}}>No activity yet.</div>
                        :serverLog.slice(0,15).map((item,i)=>(
                          <div key={i} style={{display:"flex",gap:12,paddingBottom:10,paddingLeft:14,marginLeft:6,borderLeft:"2px solid #E5E7EB",position:"relative",animation:"fadeIn .15s ease"}}>
                            <div style={{width:6,height:6,borderRadius:"50%",background:item.type==="sent"?"#059669":item.type==="review"?"#EF4444":item.type==="queued"?"#F59E0B":item.type==="error"?"#DC2626":"#0EA5E9",position:"absolute",left:-4,top:4}}/>
                            <div style={{fontSize:11,color:"#9CA3AF",whiteSpace:"nowrap",minWidth:48}}>{item.time}</div>
                            <div style={{fontSize:12,color:"#374151",lineHeight:1.5}}>{item.msg}</div>
                          </div>
                        ))
                      }
                    </div>
                  </div>
                </div>
              )}

              {/* ══ QUEUE (review) ══ */}
              {tab==="Queue"&&(
                <div style={{flex:1,overflowY:"auto",padding:28}}>
                  <div style={{maxWidth:740}}>
                    <div style={{fontFamily:"'DM Serif Display',serif",fontSize:22,marginBottom:4}}>Review Queue</div>
                    <div style={{fontSize:13,color:"#6B7280",marginBottom:20}}>Emails the agent held for human approval. Draft reply is pre-written — edit if needed and send.</div>
                    {reviewQueue.length===0
                      ?<div style={{background:"#F0FFF4",border:"1px solid #86EFAC",borderRadius:12,padding:24,textAlign:"center",color:"#166534",fontSize:14,fontWeight:500}}>✓ Nothing waiting for review — the agent is handling everything.</div>
                      :reviewQueue.map(item=>{
                        const isOpen=expandedReview===item.id;
                        return <ReviewCard key={item.id} item={item} isOpen={isOpen} onToggle={()=>setExpandedReview(isOpen?null:item.id)} onApprove={approveReview} onDiscard={()=>{discardReview(item.id);showToast("Discarded");}}/>;
                      })
                    }
                  </div>
                </div>
              )}

              {/* ══ VOICE PROFILE ══ */}
              {tab==="Voice"&&(
                <div style={{flex:1,overflowY:"auto",padding:28}}>
                  <div style={{maxWidth:680}}>
                    <div style={{fontFamily:"'DM Serif Display',serif",fontSize:22,marginBottom:4}}>Voice Profile</div>
                    <div style={{fontSize:13,color:"#6B7280",marginBottom:22}}>Train the agent to write in Expert Physio's exact tone. The more samples you add, the better the match.</div>

                    {/* Guidelines */}
                    <div style={{background:"#fff",border:"1px solid #E5E7EB",borderRadius:12,padding:20,marginBottom:16}}>
                      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
                        <div style={{fontSize:14,fontWeight:700}}>🎙 Voice Guidelines</div>
                        {!editingGuidelines
                          ?<button onClick={()=>{setGuidelinesText(voice?.guidelines||"");setEditingGuidelines(true);}} style={{fontSize:12,padding:"5px 12px",background:"#F3F4F6",border:"none",borderRadius:7,cursor:"pointer",fontWeight:500}}>Edit</button>
                          :<div style={{display:"flex",gap:6}}>
                            <button onClick={saveGuidelines} style={{fontSize:12,padding:"5px 12px",background:"#059669",color:"#fff",border:"none",borderRadius:7,cursor:"pointer",fontWeight:600}}>Save</button>
                            <button onClick={()=>setEditingGuidelines(false)} style={{fontSize:12,padding:"5px 12px",background:"#F3F4F6",border:"none",borderRadius:7,cursor:"pointer"}}>Cancel</button>
                          </div>
                        }
                      </div>
                      {editingGuidelines
                        ?<textarea value={guidelinesText} onChange={e=>setGuidelinesText(e.target.value)} style={{width:"100%",minHeight:200,padding:12,border:"1px solid #D1D5DB",borderRadius:8,fontSize:13,lineHeight:1.7,resize:"vertical",color:"#374151"}}/>
                        :<div style={{fontSize:13,color:"#374151",lineHeight:1.8,whiteSpace:"pre-wrap",background:"#F8FAFC",padding:12,borderRadius:8}}>{voice?.guidelines||"Loading…"}</div>
                      }
                    </div>

                    {/* Samples */}
                    <div style={{background:"#fff",border:"1px solid #E5E7EB",borderRadius:12,padding:20}}>
                      <div style={{fontSize:14,fontWeight:700,marginBottom:6}}>✍️ Approved Reply Samples</div>
                      <div style={{fontSize:12,color:"#6B7280",marginBottom:14}}>Paste real replies that Expert Physio staff have written and approved. The AI uses these to match their exact voice.</div>
                      {(voice?.samples||[]).length===0
                        ?<div style={{fontSize:13,color:"#9CA3AF",marginBottom:14}}>No samples yet — add approved replies below.</div>
                        :(voice?.samples||[]).map((s,i)=>(
                          <div key={i} style={{background:"#F8FAFC",border:"1px solid #E5E7EB",borderRadius:8,padding:12,marginBottom:8,display:"flex",gap:10}}>
                            <div style={{flex:1,fontSize:13,color:"#374151",lineHeight:1.6}}>{s}</div>
                            <button onClick={()=>removeSample(i)} style={{background:"none",border:"none",color:"#EF4444",cursor:"pointer",fontSize:16,flexShrink:0,alignSelf:"flex-start"}}>×</button>
                          </div>
                        ))
                      }
                      <div style={{marginTop:8}}>
                        <textarea value={newSample} onChange={e=>setNewSample(e.target.value)} placeholder="Paste an approved reply example here…" style={{width:"100%",minHeight:100,padding:12,border:"1px solid #D1D5DB",borderRadius:8,fontSize:13,lineHeight:1.65,resize:"vertical",marginBottom:8}}/>
                        <button onClick={addSample} disabled={!newSample.trim()} style={{padding:"8px 18px",background:newSample.trim()?"#0EA5E9":"#E5E7EB",color:newSample.trim()?"#fff":"#9CA3AF",border:"none",borderRadius:8,cursor:newSample.trim()?"pointer":"not-allowed",fontSize:13,fontWeight:600}}>+ Add Sample</button>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* ══ INBOX (demo) ══ */}
              {tab==="Inbox"&&(
                <>
                  <div style={{width:296,borderRight:"1px solid #E5E7EB",overflowY:"auto",background:"#fff",flexShrink:0}}>
                    <div style={{padding:"11px 14px 9px",borderBottom:"1px solid #F3F4F6",fontSize:11,fontWeight:700,color:"#6B7280",letterSpacing:.5}}>DEMO EMAILS — {emails.length}</div>
                    {emails.map(e=>{
                      const tag=TAGS[e.tag];const isSel=selEmail?.id===e.id;
                      return <div key={e.id} onClick={()=>selectEmail(e)} style={{padding:"11px 14px",cursor:"pointer",borderBottom:"1px solid #F9FAFB",background:isSel?"#EFF6FF":e.status==="unread"?"#FAFFFE":"#fff",borderLeft:"3px solid "+(isSel?"#0EA5E9":"transparent")}}>
                        <div style={{display:"flex",justifyContent:"space-between",marginBottom:2}}>
                          <span style={{fontSize:13,fontWeight:e.status==="unread"?700:500,color:"#111827",display:"flex",alignItems:"center",gap:5,overflow:"hidden",flex:1}}>
                            {e.status==="unread"&&<span style={{width:6,height:6,borderRadius:"50%",background:"#0EA5E9",flexShrink:0,display:"inline-block"}}/>}
                            {e.status==="replied"&&<span style={{fontSize:10,color:"#059669",fontWeight:600,flexShrink:0}}>✓</span>}
                            <span style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{e.name}</span>
                          </span>
                          <span style={{fontSize:11,color:"#9CA3AF",flexShrink:0,marginLeft:4}}>{e.time}</span>
                        </div>
                        <div style={{fontSize:12,fontWeight:500,color:"#374151",marginBottom:4,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{e.subject}</div>
                        <span style={{fontSize:10,fontWeight:600,padding:"2px 8px",borderRadius:20,background:tag.bg,color:tag.color}}>{tag.label}</span>
                      </div>;
                    })}
                  </div>
                  <div style={{flex:1,overflowY:"auto",padding:26}}>
                    {!selEmail
                      ?<div style={{height:"100%",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",color:"#9CA3AF",gap:10}}><div style={{fontSize:44}}>📬</div><div style={{fontSize:14}}>Select an email to read and reply</div></div>
                      :<div style={{maxWidth:640,animation:"fadeIn .2s ease"}}>
                        <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:12,marginBottom:6}}>
                          <div style={{fontFamily:"'DM Serif Display',serif",fontSize:20,lineHeight:1.3}}>{selEmail.subject}</div>
                          <span style={{fontSize:11,fontWeight:600,padding:"3px 9px",borderRadius:20,flexShrink:0,background:TAGS[selEmail.tag].bg,color:TAGS[selEmail.tag].color}}>{TAGS[selEmail.tag].label}</span>
                        </div>
                        <div style={{fontSize:12,color:"#6B7280",marginBottom:14}}>From: <strong>{selEmail.name}</strong> · {selEmail.time}</div>
                        <div style={{background:"#fff",border:"1px solid #E5E7EB",borderRadius:12,padding:20,marginBottom:16,fontSize:14,lineHeight:1.75,color:"#374151"}}>{selEmail.body}</div>
                        {loadId===selEmail.id&&loadAction==="sum"&&<Spinner label="Analysing…"/>}
                        {curSum&&loadAction!=="sum"&&<div style={{background:"#F0F9FF",border:"1px solid #BAE6FD",borderRadius:10,padding:"12px 16px",marginBottom:16,animation:"fadeIn .25s ease"}}><div style={{fontSize:10,fontWeight:700,color:"#0284C7",marginBottom:5,letterSpacing:.5}}>🤖 AI ANALYSIS</div><div style={{fontSize:13,color:"#1E40AF",lineHeight:1.65}}>{curSum}</div></div>}
                        {selEmail.status==="replied"
                          ?<div style={{padding:"10px 14px",background:"#F0FFF4",border:"1px solid #86EFAC",borderRadius:8,fontSize:13,color:"#166534",fontWeight:500}}>✓ Reply sent</div>
                          :<>
                            <button onClick={draftReply} disabled={!!loadId} style={{padding:"9px 18px",background:"#0EA5E9",color:"#fff",border:"none",borderRadius:8,cursor:loadId?"not-allowed":"pointer",fontSize:13,fontWeight:600,marginBottom:14,opacity:loadId?.65:1}}>
                              {loadId===selEmail.id&&loadAction==="rep"?"Drafting…":"✨ Draft Reply"}
                            </button>
                            {loadId===selEmail.id&&loadAction==="rep"&&<Spinner label="Writing reply…"/>}
                            {curReply&&loadAction!=="rep"&&<div ref={replyRef} style={{animation:"fadeIn .25s ease"}}>
                              <div style={{fontSize:11,fontWeight:700,color:"#374151",marginBottom:8,letterSpacing:.3}}>DRAFTED REPLY</div>
                              <textarea value={curReply} onChange={ev=>setReplies(p=>({...p,[selEmail.id]:ev.target.value}))} style={{width:"100%",minHeight:180,padding:14,border:"1px solid #D1D5DB",borderRadius:10,fontSize:13,lineHeight:1.75,resize:"vertical",color:"#374151"}}/>
                              <div style={{display:"flex",gap:10,marginTop:10}}>
                                <button onClick={()=>{setEmails(p=>p.map(e=>e.id===selEmail.id?{...e,status:"replied"}:e));setReplies(p=>{const n={...p};delete n[selEmail.id];return n;});showToast("✓ Sent to "+selEmail.name);setSelEmail(null);}} style={{padding:"9px 20px",background:"#059669",color:"#fff",border:"none",borderRadius:8,cursor:"pointer",fontSize:13,fontWeight:600}}>📤 Send</button>
                                <button onClick={()=>setReplies(p=>{const n={...p};delete n[selEmail.id];return n;})} style={{padding:"9px 14px",background:"#F3F4F6",color:"#374151",border:"none",borderRadius:8,cursor:"pointer",fontSize:13}}>Discard</button>
                              </div>
                            </div>}
                          </>
                        }
                      </div>
                    }
                  </div>
                </>
              )}

              {/* ══ COMPOSE ══ */}
              {tab==="Compose"&&(
                <div style={{flex:1,overflowY:"auto",padding:30}}>
                  <div style={{maxWidth:620}}>
                    <div style={{fontFamily:"'DM Serif Display',serif",fontSize:22,marginBottom:4}}>Compose Email</div>
                    <div style={{fontSize:13,color:"#6B7280",marginBottom:20}}>Describe what you want sent — the agent writes it in Expert Physio's voice.</div>
                    <textarea value={composeText} onChange={e=>setComposeText(e.target.value)} placeholder={'e.g. "Email Sarah Mitchell to reschedule her Thursday appointment to Tuesday at 11am"'} style={{width:"100%",minHeight:90,padding:14,border:"1px solid #D1D5DB",borderRadius:10,fontSize:13,lineHeight:1.6,resize:"vertical",marginBottom:14}}/>
                    <button onClick={compose} disabled={composeBusy||!composeText.trim()} style={{padding:"10px 18px",background:composeBusy||!composeText.trim()?"#E5E7EB":"#0EA5E9",color:composeBusy||!composeText.trim()?"#9CA3AF":"#fff",border:"none",borderRadius:8,cursor:composeBusy||!composeText.trim()?"not-allowed":"pointer",fontSize:13,fontWeight:600,marginBottom:16}}>
                      {composeBusy?"Composing…":"✨ Generate Email"}
                    </button>
                    {composeBusy&&<Spinner label="Composing in Expert Physio's voice…"/>}
                    {composed&&!composeBusy&&<div style={{animation:"fadeIn .25s ease"}}>
                      <div style={{background:"#fff",border:"1px solid #E5E7EB",borderRadius:12,padding:20}}>
                        {[{lb:"TO",k:"to"},{lb:"SUBJECT",k:"subject"}].map(({lb,k})=>(
                          <div key={k} style={{marginBottom:14}}>
                            <div style={{fontSize:10,fontWeight:700,color:"#6B7280",marginBottom:4,letterSpacing:.5}}>{lb}</div>
                            <input value={composed[k]} onChange={e=>setComposed(p=>({...p,[k]:e.target.value}))} style={{width:"100%",padding:"8px 10px",border:"1px solid #E5E7EB",borderRadius:6,fontSize:13}}/>
                          </div>
                        ))}
                        <div style={{fontSize:10,fontWeight:700,color:"#6B7280",marginBottom:4,letterSpacing:.5}}>BODY</div>
                        <textarea value={composed.body} onChange={e=>setComposed(p=>({...p,body:e.target.value}))} style={{width:"100%",minHeight:200,padding:"8px 10px",border:"1px solid #E5E7EB",borderRadius:6,fontSize:13,lineHeight:1.75,resize:"vertical"}}/>
                      </div>
                      <div style={{display:"flex",gap:8,marginTop:12}}>
                        <button onClick={()=>{showToast("✓ Email sent");setComposed(null);setComposeText("");}} style={{padding:"9px 18px",background:"#059669",color:"#fff",border:"none",borderRadius:8,cursor:"pointer",fontSize:13,fontWeight:600}}>📤 Send via Gmail</button>
                        <button onClick={()=>setComposed(null)} style={{padding:"9px 13px",background:"#F3F4F6",color:"#374151",border:"none",borderRadius:8,cursor:"pointer",fontSize:13}}>Discard</button>
                      </div>
                    </div>}
                  </div>
                </div>
              )}

              {/* ══ SENT LOG ══ */}
              {tab==="Sent Log"&&(
                <div style={{flex:1,overflowY:"auto",padding:28}}>
                  <div style={{maxWidth:740}}>
                    <div style={{fontFamily:"'DM Serif Display',serif",fontSize:22,marginBottom:4}}>Sent Log</div>
                    <div style={{fontSize:13,color:"#6B7280",marginBottom:20}}>Every email the agent has sent — full content, confidence score, timestamp.</div>
                    {sentLog.length===0
                      ?<div style={{fontSize:13,color:"#9CA3AF"}}>No emails sent yet.</div>
                      :sentLog.map((item,i)=>{
                        const isOpen=expandedSent===item.id;
                        return <div key={item.id||i} style={{background:"#fff",border:"1px solid #E5E7EB",borderRadius:12,marginBottom:10,overflow:"hidden",animation:"fadeIn .2s ease"}}>
                          <div style={{padding:"12px 16px",display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,cursor:"pointer"}} onClick={()=>setExpandedSent(isOpen?null:item.id)}>
                            <div style={{flex:1,minWidth:0}}>
                              <div style={{fontSize:13,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{item.email?.subject}</div>
                              <div style={{fontSize:11,color:"#6B7280",marginTop:2,display:"flex",gap:8,flexWrap:"wrap"}}>
                                <span>To: {item.email?.from}</span>
                                <ConfidenceBadge score={item.confidence||0}/>
                                {item.manualApproval&&<span style={{fontSize:10,fontWeight:600,padding:"2px 7px",borderRadius:20,background:"#EFF6FF",color:"#1D4ED8"}}>Staff approved</span>}
                              </div>
                            </div>
                            <div style={{fontSize:11,color:"#9CA3AF",flexShrink:0,textAlign:"right"}}>
                              <div>{new Date(item.sentAt).toLocaleDateString()}</div>
                              <div>{new Date(item.sentAt).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}</div>
                            </div>
                          </div>
                          {isOpen&&<div style={{padding:"0 16px 14px",borderTop:"1px solid #F3F4F6"}}>
                            <div style={{fontSize:10,fontWeight:700,color:"#6B7280",margin:"10px 0 6px",letterSpacing:.5}}>SENT REPLY</div>
                            <div style={{background:"#F8FAFC",border:"1px solid #E5E7EB",borderRadius:8,padding:12,fontSize:13,color:"#374151",lineHeight:1.7,whiteSpace:"pre-wrap"}}>{item.replyBody}</div>
                          </div>}
                        </div>;
                      })
                    }
                  </div>
                </div>
              )}

            </div>
          </div>
        </div>
      </div>
    );
  }

  function ReviewCard({item,isOpen,onToggle,onApprove,onDiscard}){
    const [draft,setDraft]=useState(item.draftReply);
    return <div style={{border:"1px solid #FEE2E2",borderRadius:12,marginBottom:12,overflow:"hidden",animation:"fadeIn .2s ease"}}>
      <div style={{padding:"12px 16px",display:"flex",alignItems:"center",justifyContent:"space-between",gap:12,background:"#FFF5F5",cursor:"pointer"}} onClick={onToggle}>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontSize:13,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{item.email.subject}</div>
          <div style={{fontSize:11,color:"#6B7280",marginTop:2,display:"flex",gap:8,flexWrap:"wrap"}}>
            <span>From: {item.email.from}</span>
            <span style={{fontSize:10,fontWeight:600,padding:"2px 7px",borderRadius:20,background:"#EEF2FF",color:"#4338CA"}}>{item.classification.category}</span>
            <ConfidenceBadge score={item.classification.confidence}/>
          </div>
          <div style={{fontSize:11,color:"#B91C1C",marginTop:2}}>Held: {item.classification.reason}</div>
        </div>
        <div style={{display:"flex",gap:6,flexShrink:0}}>
          <button onClick={e=>{e.stopPropagation();onDiscard();}} style={{padding:"6px 11px",background:"#FEE2E2",color:"#C0392B",border:"none",borderRadius:7,cursor:"pointer",fontSize:12,fontWeight:500}}>Discard</button>
          <span style={{fontSize:12,color:"#6B7280",padding:"6px 4px"}}>{isOpen?"▲":"▼"}</span>
        </div>
      </div>
      {isOpen&&<div style={{padding:"14px 16px",borderTop:"1px solid #FEE2E2"}}>
        <div style={{fontSize:12,color:"#374151",background:"#F8FAFC",border:"1px solid #E5E7EB",borderRadius:8,padding:12,marginBottom:12,lineHeight:1.65}}>{item.email.body}</div>
        <div style={{fontSize:10,fontWeight:700,color:"#6B7280",marginBottom:6,letterSpacing:.5}}>🤖 AI DRAFT — edit before sending</div>
        <textarea value={draft} onChange={e=>setDraft(e.target.value)} style={{width:"100%",minHeight:150,padding:"10px 12px",border:"1px solid #D1D5DB",borderRadius:8,fontSize:13,lineHeight:1.7,resize:"vertical",marginBottom:10}}/>
        <button onClick={()=>onApprove(item,draft)} style={{padding:"9px 20px",background:"#059669",color:"#fff",border:"none",borderRadius:8,cursor:"pointer",fontSize:13,fontWeight:600}}>✓ Approve & Send</button>
      </div>}
    </div>;
  }

  ReactDOM.createRoot(document.getElementById("root")).render(<App/>);
</script>
</body>
</html>`);
});

app.listen(parseInt(PORT), () => log(`Expert Physio Agent v2 running on port ${PORT}`, "success"));
