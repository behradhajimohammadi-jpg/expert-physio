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


// ─── DASHBOARD (fast vanilla JS — no Babel, no CDN delays) ───────────────────
app.get("*", (req, res) => {
  const connected = !!gmailTokens;
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>Expert Physio AI Agent</title>
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=DM+Serif+Display&display=swap" rel="stylesheet">
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'DM Sans','Helvetica Neue',sans-serif;background:#F8FAFC;color:#111827;height:100vh;overflow:hidden;display:flex;flex-direction:column}
    @keyframes spin{to{transform:rotate(360deg)}}
    @keyframes fadeIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
    ::-webkit-scrollbar{width:4px}
    ::-webkit-scrollbar-thumb{background:#CBD5E1;border-radius:4px}
    input,textarea,button{font-family:inherit}
    textarea:focus,input:focus{outline:2px solid #0EA5E9;outline-offset:1px;border-radius:4px}
    .tab-btn{width:100%;padding:10px 16px;background:transparent;border:none;border-left:3px solid transparent;cursor:pointer;text-align:left;font-size:13px;font-weight:400;color:#374151;display:flex;align-items:center;justify-content:space-between;transition:background .1s}
    .tab-btn.active{background:#F0F9FF;border-left-color:#0EA5E9;font-weight:600;color:#0284C7}
    .tab-btn:hover:not(.active){background:#F8FAFC}
    .badge{border-radius:10px;font-size:10px;font-weight:700;padding:1px 6px;color:#fff}
    .btn{padding:9px 18px;border:none;border-radius:8px;cursor:pointer;font-size:13px;font-weight:600;display:inline-flex;align-items:center;gap:6px;transition:opacity .15s}
    .btn:disabled{opacity:.5;cursor:not-allowed}
    .btn-blue{background:#0EA5E9;color:#fff}
    .btn-green{background:#059669;color:#fff}
    .btn-gray{background:#F1F5F9;color:#475569;border:1px solid #E2E8F0}
    .btn-red{background:#FEE2E2;color:#C0392B}
    .card{background:#fff;border:1px solid #E5E7EB;border-radius:12px;padding:18px;margin-bottom:14px}
    .spinner{width:14px;height:14px;border-radius:50%;border:2px solid #E5E7EB;border-top-color:#0EA5E9;animation:spin .7s linear infinite;flex-shrink:0}
    .tag{font-size:10px;font-weight:600;padding:2px 8px;border-radius:20px}
    #toast{position:fixed;top:20px;right:20px;z-index:9999;background:#111827;color:#fff;padding:11px 20px;border-radius:10px;font-size:13px;font-weight:500;box-shadow:0 4px 24px rgba(0,0,0,.25);display:none;align-items:center;gap:12px;max-width:380px;animation:fadeIn .25s ease}
    .email-row{padding:11px 14px;cursor:pointer;border-bottom:1px solid #F9FAFB;border-left:3px solid transparent;transition:background .1s}
    .email-row:hover{background:#F8FAFC}
    .email-row.selected{background:#EFF6FF;border-left-color:#0EA5E9}
    .email-row.unread{background:#FAFFFE}
    .section-title{font-family:'DM Serif Display',serif;font-size:22px;margin-bottom:4px;color:#0F172A}
    .section-sub{font-size:13px;color:#64748B;margin-bottom:20px}
    .conf-badge{font-size:10px;font-weight:700;padding:2px 8px;border-radius:20px}
    .rule-row{display:flex;align-items:center;justify-content:space-between;padding:9px 0;border-bottom:1px solid #F3F4F6}
  </style>
</head>
<body>

<div id="toast"><span id="toast-msg"></span><button onclick="hideToast()" style="background:none;border:none;color:#9CA3AF;cursor:pointer;font-size:18px;line-height:1">×</button></div>

<!-- HEADER -->
<div style="background:#0B1F3A;height:56px;display:flex;align-items:center;justify-content:space-between;padding:0 22px;flex-shrink:0;border-bottom:1px solid #1E3A5F">
  <div style="display:flex;align-items:center;gap:10px">
    <div style="width:32px;height:32px;border-radius:8px;background:linear-gradient(135deg,#0EA5E9,#0369A1);display:flex;align-items:center;justify-content:center;font-size:16px">🤖</div>
    <div>
      <div style="font-family:'DM Serif Display',serif;font-size:16px;color:#fff">Expert Physio AI Agent</div>
      <div id="status-line" style="font-size:10px;color:${connected?'#6EE7B7':'#FCA5A5'}">
        <span style="width:6px;height:6px;border-radius:50%;background:${connected?'#6EE7B7':'#FCA5A5'};display:inline-block;margin-right:4px;${connected?'animation:pulse 2s infinite':''}"></span>
        ${connected ? 'Autopilot running — inbox monitored every 5 min' : 'Gmail not connected — click Connect Gmail to start'}
      </div>
    </div>
  </div>
  <div style="display:flex;gap:8px;align-items:center">
    <div id="header-badges"></div>
    ${!connected ? '<a href="/auth/login" style="padding:7px 16px;background:#0EA5E9;color:#fff;border-radius:8px;font-size:12px;font-weight:600;text-decoration:none">Connect Gmail →</a>' : ''}
  </div>
</div>

<!-- BODY -->
<div style="display:flex;flex:1;overflow:hidden">

  <!-- SIDEBAR -->
  <div style="width:200px;background:#fff;border-right:1px solid #E5E7EB;display:flex;flex-direction:column;flex-shrink:0">
    <div style="padding:14px 0;flex:1">
      <button class="tab-btn active" id="tab-Autopilot" onclick="showTab('Autopilot')"><span>⚡ Autopilot</span><span id="badge-Autopilot" class="badge" style="background:#F59E0B;display:none"></span></button>
      <button class="tab-btn" id="tab-Queue" onclick="showTab('Queue')"><span>👁 Queue</span><span id="badge-Queue" class="badge" style="background:#EF4444;display:none"></span></button>
      <button class="tab-btn" id="tab-Voice" onclick="showTab('Voice')"><span>🎙 Voice</span></button>
      <button class="tab-btn" id="tab-Inbox" onclick="showTab('Inbox')"><span>📬 Inbox</span><span id="badge-Inbox" class="badge" style="background:#0EA5E9;display:none"></span></button>
      <button class="tab-btn" id="tab-Compose" onclick="showTab('Compose')"><span>✏️ Compose</span></button>
      <button class="tab-btn" id="tab-Sent" onclick="showTab('Sent')"><span>📊 Sent Log</span></button>
    </div>
    <div style="margin:0 10px 14px;padding:12px;background:#F8FAFC;border-radius:10px;border:1px solid #E5E7EB">
      <div style="font-size:10px;font-weight:700;color:#6B7280;margin-bottom:7px;letter-spacing:.5px">TODAY</div>
      <div id="sidebar-stats" style="font-size:12px;color:#374151;line-height:1.9">Loading…</div>
    </div>
  </div>

  <!-- MAIN -->
  <div style="flex:1;overflow:hidden;display:flex;flex-direction:column">
    <div id="err-banner" style="display:none;background:#FFF0F0;border:1px solid #FECACA;border-radius:8px;padding:10px 16px;font-size:13px;color:#B91C1C;display:none;justify-content:space-between;align-items:center;margin:8px 16px 0">
      <span id="err-msg"></span>
      <button onclick="hideErr()" style="background:none;border:none;color:#B91C1C;cursor:pointer;font-weight:700;font-size:16px;margin-left:12px">×</button>
    </div>

    <div style="flex:1;overflow:hidden;display:flex">

      <!-- AUTOPILOT TAB -->
      <div id="pane-Autopilot" style="flex:1;overflow-y:auto;padding:28px">
        <div style="max-width:780px">
          <div class="section-title">Autopilot Status</div>
          <div class="section-sub">The agent monitors the inbox every 5 minutes. Simple emails auto-send after a 5-minute cancel window. Complex emails wait in the review queue.</div>

          ${!connected ? `
          <div style="background:#FFF7ED;border:1px solid #FED7AA;border-radius:12px;padding:20px;margin-bottom:20px;display:flex;align-items:center;justify-content:space-between;gap:16px">
            <div><div style="font-weight:600;color:#92400E;margin-bottom:4px">Gmail not connected</div><div style="font-size:13px;color:#B45309">Click Connect Gmail in the top right to authorise the agent.</div></div>
            <a href="/auth/login" style="padding:10px 20px;background:#F59E0B;color:#fff;border-radius:8px;font-size:13px;font-weight:600;text-decoration:none;white-space:nowrap;flex-shrink:0">Connect Gmail →</a>
          </div>` : ''}

          <div id="send-queue-panel" style="display:none;background:#FFFBEB;border:1px solid #FDE68A;border-radius:12px;padding:18px;margin-bottom:16px">
            <div style="font-size:14px;font-weight:700;margin-bottom:12px;color:#92400E">⏱ Sending Soon — Cancel Window Active</div>
            <div id="send-queue-items"></div>
          </div>

          <div class="card">
            <div style="font-size:14px;font-weight:700;margin-bottom:14px">⚡ Auto-Send Rules</div>
            ${[
              ['📅','Cancellations','Auto-reply offering reschedule',true],
              ['🙋','New Patient Inquiries','Auto-reply with welcome + booking info',true],
              ['💳','Simple Billing Questions','Auto-reply acknowledging, 1-2 day follow-up',true],
              ['👨‍⚕️','Doctor Referrals','Auto-reply confirming receipt',true],
              ['🏥','ICBC Claims','Held — staff review required',false],
              ['😤','Complaints','Held — staff review required',false],
              ['❓','Low Confidence (<80%)','Held — AI not certain enough',false],
            ].map(([icon,label,action,auto]) => `
            <div class="rule-row">
              <div style="display:flex;align-items:center;gap:10px">
                <span style="font-size:18px">${icon}</span>
                <div><div style="font-size:13px;font-weight:600">${label}</div><div style="font-size:11px;color:#6B7280">${action}</div></div>
              </div>
              <span style="font-size:11px;font-weight:600;padding:3px 10px;border-radius:20px;background:${auto?'#F0FFF4':'#FFF0F0'};color:${auto?'#166534':'#C0392B'}">${auto?'✓ Auto-Send':'👁 Review First'}</span>
            </div>`).join('')}
          </div>

          <div class="card">
            <div style="font-size:14px;font-weight:700;margin-bottom:14px">📊 Live Activity</div>
            <div id="live-log"><div style="font-size:13px;color:#9CA3AF">No activity yet — connect Gmail to start.</div></div>
          </div>
        </div>
      </div>

      <!-- QUEUE TAB -->
      <div id="pane-Queue" style="display:none;flex:1;overflow-y:auto;padding:28px">
        <div style="max-width:740px">
          <div class="section-title">Review Queue</div>
          <div class="section-sub">Emails the agent held for human approval. Draft reply is pre-written — edit if needed and send.</div>
          <div id="review-queue-items"><div style="font-size:13px;color:#9CA3AF">Loading…</div></div>
        </div>
      </div>

      <!-- VOICE TAB -->
      <div id="pane-Voice" style="display:none;flex:1;overflow-y:auto;padding:28px">
        <div style="max-width:680px">
          <div class="section-title">Voice Profile</div>
          <div class="section-sub">Train the agent to write in Expert Physio's exact tone. The more samples you add, the better the match.</div>

          <div class="card">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
              <div style="font-size:14px;font-weight:700">🎙 Voice Guidelines</div>
              <button class="btn btn-gray" style="padding:5px 12px;font-size:12px" onclick="toggleEditGuidelines()">Edit</button>
            </div>
            <div id="guidelines-view" style="font-size:13px;color:#374151;line-height:1.8;white-space:pre-wrap;background:#F8FAFC;padding:12px;border-radius:8px">Loading…</div>
            <div id="guidelines-edit" style="display:none">
              <textarea id="guidelines-textarea" style="width:100%;min-height:200px;padding:12px;border:1px solid #D1D5DB;border-radius:8px;font-size:13px;line-height:1.7;resize:vertical"></textarea>
              <div style="display:flex;gap:6px;margin-top:8px">
                <button class="btn btn-green" style="padding:7px 16px;font-size:12px" onclick="saveGuidelines()">Save</button>
                <button class="btn btn-gray" style="padding:7px 12px;font-size:12px" onclick="toggleEditGuidelines()">Cancel</button>
              </div>
            </div>
          </div>

          <div class="card">
            <div style="font-size:14px;font-weight:700;margin-bottom:6px">✍️ Approved Reply Samples</div>
            <div style="font-size:12px;color:#6B7280;margin-bottom:14px">Paste real replies that Expert Physio staff have approved. The AI uses these to match their exact voice and style.</div>
            <div id="voice-samples"></div>
            <textarea id="new-sample-input" placeholder="Paste an approved reply example here…" style="width:100%;min-height:100px;padding:12px;border:1px solid #D1D5DB;border-radius:8px;font-size:13px;line-height:1.65;resize:vertical;margin-bottom:8px"></textarea>
            <button class="btn btn-blue" onclick="addSample()">+ Add Sample</button>
          </div>
        </div>
      </div>

      <!-- INBOX TAB -->
      <div id="pane-Inbox" style="display:none;flex:1;overflow:hidden;display:none">
        <div style="width:296px;border-right:1px solid #E5E7EB;overflow-y:auto;background:#fff;flex-shrink:0;height:100%">
          <div style="padding:11px 14px 9px;border-bottom:1px solid #F3F4F6;font-size:11px;font-weight:700;color:#6B7280;letter-spacing:.5px">DEMO EMAILS</div>
          <div id="email-list"></div>
        </div>
        <div id="email-detail" style="flex:1;overflow-y:auto;padding:26px">
          <div style="height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#9CA3AF;gap:10px">
            <div style="font-size:44px">📬</div>
            <div style="font-size:14px">Select an email to read and reply</div>
          </div>
        </div>
      </div>

      <!-- COMPOSE TAB -->
      <div id="pane-Compose" style="display:none;flex:1;overflow-y:auto;padding:30px">
        <div style="max-width:620px">
          <div class="section-title">Compose Email</div>
          <div class="section-sub">Describe what you want sent — the agent writes it in Expert Physio's voice.</div>
          <textarea id="compose-input" placeholder='e.g. "Email Sarah Mitchell to reschedule her Thursday appointment to Tuesday at 11am"' style="width:100%;min-height:90px;padding:14px;border:1px solid #D1D5DB;border-radius:10px;font-size:13px;line-height:1.6;resize:vertical;margin-bottom:14px"></textarea>
          <button class="btn btn-blue" id="compose-btn" onclick="generateEmail()">✨ Generate Email</button>
          <div id="compose-spinner" style="display:none;margin-top:10px"><div style="display:flex;align-items:center;gap:8px;color:#6B7280;font-size:13px"><div class="spinner"></div>Composing in Expert Physio's voice…</div></div>
          <div id="composed-email" style="display:none;margin-top:16px;animation:fadeIn .25s ease">
            <div class="card" style="padding:0;overflow:hidden">
              <div style="padding:10px 16px;border-bottom:1px solid #F1F5F9;display:flex;align-items:center;gap:10px">
                <span style="font-size:10px;font-weight:700;color:#94A3B8;width:54px;flex-shrink:0;letter-spacing:.5px">TO</span>
                <input id="c-to" style="flex:1;border:none;font-size:13.5px;color:#1E293B;background:transparent;padding:0"/>
              </div>
              <div style="padding:10px 16px;border-bottom:1px solid #F1F5F9;display:flex;align-items:center;gap:10px">
                <span style="font-size:10px;font-weight:700;color:#94A3B8;width:54px;flex-shrink:0;letter-spacing:.5px">SUBJECT</span>
                <input id="c-subject" style="flex:1;border:none;font-size:13.5px;color:#1E293B;background:transparent;padding:0"/>
              </div>
              <div style="padding:12px 16px">
                <div style="font-size:10px;font-weight:700;color:#94A3B8;margin-bottom:8px;letter-spacing:.5px">BODY</div>
                <textarea id="c-body" style="width:100%;min-height:200px;border:none;font-size:13.5px;line-height:1.75;color:#1E293B;resize:vertical;background:transparent;padding:0"></textarea>
              </div>
            </div>
            <div style="display:flex;gap:8px;margin-top:12px">
              <button class="btn btn-green" onclick="sendComposed()">📤 Send via Gmail</button>
              <button class="btn btn-gray" onclick="discardComposed()">Discard</button>
            </div>
          </div>
        </div>
      </div>

      <!-- SENT LOG TAB -->
      <div id="pane-Sent" style="display:none;flex:1;overflow-y:auto;padding:28px">
        <div style="max-width:740px">
          <div class="section-title">Sent Log</div>
          <div class="section-sub">Every email the agent has sent — full content, confidence score, timestamp.</div>
          <div id="sent-log-items"><div style="font-size:13px;color:#9CA3AF">No emails sent yet.</div></div>
        </div>
      </div>

    </div>
  </div>
</div>

<script>
// ─── STATE ────────────────────────────────────────────────────────────────────
let currentTab = 'Autopilot';
let serverData = { status: null, log: [], review: [], queue: [], sent: [], voice: null };
let selectedEmailId = null;
let editingGuidelines = false;

const DEMO_EMAILS = [
  {id:1,name:'Sarah Mitchell',from:'sarah.mitchell@gmail.com',subject:'Appointment Cancellation - Thursday 2pm',preview:'Hi, I need to cancel my appointment...',body:'Hi, I need to cancel my appointment this Thursday at 2pm. I have a conflict at work. Can we reschedule? Any time Tuesday or Wednesday works. Thanks, Sarah',time:'9:14 AM',status:'unread',tag:'cancellation'},
  {id:2,name:'ICBC Claims',from:'icbc.claims@icbc.com',subject:'Claim #4892-B: Treatment Authorization Required',preview:'Please submit updated treatment plan...',body:'Please submit updated treatment plan for claimant John Patel (Claim #4892-B). Authorization is required before proceeding with further sessions. Please respond within 5 business days.',time:'8:30 AM',status:'unread',tag:'icbc'},
  {id:3,name:'Dr. Angela Lee',from:'drlee@familyclinic.ca',subject:'Referral: Marcus Huang - Lower Back Pain',preview:'I am referring Marcus Huang, 42...',body:'I am referring Marcus Huang, 42, for physiotherapy following a lumbar strain. Three weeks of lower back pain. Please book him at your earliest convenience.',time:'Yesterday',status:'read',tag:'referral'},
  {id:4,name:'Kevin Tran',from:'kevin.tran88@hotmail.com',subject:'Question about my invoice',preview:'Hi there, I received an invoice...',body:'Hi there, I received an invoice for $180 but think my insurance covers 80%. Can you resubmit to Pacific Blue Cross? Policy number PBC-2291-TK.',time:'Yesterday',status:'read',tag:'billing'},
  {id:5,name:'Amanda Shore',from:'amanda.shore@gmail.com',subject:'New Patient Inquiry',preview:'Hello, I found you on Google...',body:'Hello, I found you on Google and wondering if you accept new patients? I have a rotator cuff injury. Available weekday mornings. Do you direct bill to MSP?',time:'Mon',status:'read',tag:'new-patient'},
];
const TAGS = {cancellation:{bg:'#FFF0F0',color:'#C0392B',label:'Cancellation'},icbc:{bg:'#EEF2FF',color:'#4338CA',label:'ICBC'},referral:{bg:'#F0FFF4',color:'#166534',label:'Referral'},billing:{bg:'#FFFBEB',color:'#92400E',label:'Billing'},'new-patient':{bg:'#F0F9FF',color:'#0369A1',label:'New Patient'}};
let draftReplies = {};

// ─── TOAST & ERROR ────────────────────────────────────────────────────────────
function showToast(msg) {
  const t = document.getElementById('toast');
  document.getElementById('toast-msg').textContent = msg;
  t.style.display = 'flex';
  setTimeout(() => t.style.display = 'none', 3500);
}
function hideToast() { document.getElementById('toast').style.display = 'none'; }
function showErr(msg) {
  const b = document.getElementById('err-banner');
  document.getElementById('err-msg').textContent = msg;
  b.style.display = 'flex';
}
function hideErr() { document.getElementById('err-banner').style.display = 'none'; }

// ─── TABS ─────────────────────────────────────────────────────────────────────
function showTab(name) {
  document.querySelectorAll('[id^="pane-"]').forEach(p => p.style.display = 'none');
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  const pane = document.getElementById('pane-' + name);
  if (pane) pane.style.display = name === 'Inbox' ? 'flex' : 'block';
  const btn = document.getElementById('tab-' + name);
  if (btn) btn.classList.add('active');
  currentTab = name;
  if (name === 'Inbox') renderEmailList();
}

// ─── API FETCH ────────────────────────────────────────────────────────────────
async function apiFetch(path, opts = {}) {
  const r = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || 'Request failed'); }
  return r.json();
}

async function callClaude(msg) {
  const d = await apiFetch('/api/claude', {
    method: 'POST',
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 900,
      system: 'You are the AI assistant for Expert Physio, a physiotherapy clinic in Burnaby, BC. Tone: warm, professional, concise. Sign as "Expert Physio Team".',
      messages: [{ role: 'user', content: msg }] })
  });
  const t = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('\\n').trim();
  if (!t) throw new Error('Empty response');
  return t;
}

// ─── DATA REFRESH ─────────────────────────────────────────────────────────────
async function refreshData() {
  try {
    const [status, log, review, queue, sent, voice] = await Promise.all([
      apiFetch('/api/status'), apiFetch('/api/log'), apiFetch('/api/review'),
      apiFetch('/api/queue'), apiFetch('/api/sent'), apiFetch('/api/voice'),
    ]);
    serverData = { status, log, review, queue, sent, voice };
    updateUI();
  } catch(e) { console.error('Refresh error:', e.message); }
}

function updateUI() {
  const { status, log, review, queue, sent, voice } = serverData;
  if (!status) return;

  // Sidebar stats
  document.getElementById('sidebar-stats').innerHTML =
    \`<div>⚡ \${status.sentToday || 0} auto-sent</div>
     <div>⏱ \${status.queueCount || 0} in queue</div>
     <div>⚠️ \${status.reviewCount || 0} for review</div>
     <div>📊 \${status.processed || 0} processed</div>\`;

  // Badges
  const qBadge = document.getElementById('badge-Autopilot');
  const rBadge = document.getElementById('badge-Queue');
  const iBadge = document.getElementById('badge-Inbox');
  if (status.queueCount > 0) { qBadge.textContent = status.queueCount; qBadge.style.display = 'inline'; } else qBadge.style.display = 'none';
  if (status.reviewCount > 0) { rBadge.textContent = status.reviewCount; rBadge.style.display = 'inline'; } else rBadge.style.display = 'none';
  const unread = DEMO_EMAILS.filter(e => e.status === 'unread').length;
  if (unread > 0) { iBadge.textContent = unread; iBadge.style.display = 'inline'; } else iBadge.style.display = 'none';

  // Header badges
  let headerHtml = '';
  if (status.reviewCount > 0) headerHtml += \`<span style="background:#EF4444;color:#fff;border-radius:20px;font-size:11px;font-weight:700;padding:3px 10px;margin-right:6px">⚠️ \${status.reviewCount} need review</span>\`;
  if (status.queueCount > 0) headerHtml += \`<span style="background:#F59E0B;color:#fff;border-radius:20px;font-size:11px;font-weight:700;padding:3px 10px">⏱ \${status.queueCount} sending soon</span>\`;
  document.getElementById('header-badges').innerHTML = headerHtml;

  // Send queue panel
  const sqPanel = document.getElementById('send-queue-panel');
  const sqItems = document.getElementById('send-queue-items');
  if (queue && queue.length > 0) {
    sqPanel.style.display = 'block';
    sqItems.innerHTML = queue.map(item => {
      const secsLeft = Math.max(0, Math.round((new Date(item.sendAt || Date.now() + 300000) - Date.now()) / 1000));
      const m = Math.floor(secsLeft / 60), s = secsLeft % 60;
      return \`<div style="padding:10px 12px;background:#fff;border-radius:8px;margin-bottom:8px;border:1px solid #FDE68A;display:flex;align-items:center;justify-content:space-between;gap:12px">
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">\${item.email?.subject || 'Email'}</div>
          <div style="font-size:11px;color:#6B7280;margin-top:2px">To: \${item.email?.from || ''} · \${item.classification?.confidence || 0}% confidence</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
          <span style="font-size:12px;color:#D97706;font-weight:600">Sending in \${m}:\${String(s).padStart(2,'0')}</span>
          <button onclick="cancelSend('\${item.id}')" style="font-size:11px;padding:3px 10px;background:#FEF3C7;color:#92400E;border:1px solid #FCD34D;border-radius:6px;cursor:pointer;font-weight:600">Cancel</button>
        </div>
      </div>\`;
    }).join('');
  } else { sqPanel.style.display = 'none'; }

  // Live log
  const liveLog = document.getElementById('live-log');
  if (log && log.length > 0) {
    liveLog.innerHTML = log.slice(0, 15).map((item, i) => {
      const dotColor = item.type === 'sent' ? '#059669' : item.type === 'review' ? '#EF4444' : item.type === 'queued' ? '#F59E0B' : item.type === 'error' ? '#DC2626' : '#0EA5E9';
      return \`<div style="display:flex;gap:12px;padding-bottom:10px;padding-left:14px;margin-left:6px;border-left:2px solid \${i===log.slice(0,15).length-1?'transparent':'#E5E7EB'};position:relative;animation:fadeIn .15s ease">
        <div style="width:6px;height:6px;border-radius:50%;background:\${dotColor};position:absolute;left:-4px;top:4px"></div>
        <div style="font-size:11px;color:#9CA3AF;white-space:nowrap;min-width:48px">\${item.time}</div>
        <div style="font-size:12px;color:#374151;line-height:1.5">\${item.msg}</div>
      </div>\`;
    }).join('');
  }

  // Review queue
  const rqItems = document.getElementById('review-queue-items');
  if (review && review.length > 0) {
    rqItems.innerHTML = review.map(item => \`
      <div id="review-\${item.id}" style="border:1px solid #FEE2E2;border-radius:12px;margin-bottom:12px;overflow:hidden;animation:fadeIn .2s ease">
        <div style="padding:12px 16px;display:flex;align-items:center;justify-content:space-between;gap:12px;background:#FFF5F5;cursor:pointer" onclick="toggleReview('\${item.id}')">
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">\${item.email?.subject || ''}</div>
            <div style="font-size:11px;color:#6B7280;margin-top:2px">From: \${item.email?.from || ''} · \${item.classification?.category || ''} · \${item.classification?.confidence || 0}% confidence</div>
            <div style="font-size:11px;color:#B91C1C;margin-top:2px">Held: \${item.classification?.reason || ''}</div>
          </div>
          <div style="display:flex;gap:6px;flex-shrink:0">
            <button onclick="event.stopPropagation();discardReview('\${item.id}')" class="btn btn-red" style="padding:6px 11px;font-size:12px">Discard</button>
            <span style="font-size:12px;color:#6B7280;padding:6px 4px">▼</span>
          </div>
        </div>
        <div id="review-body-\${item.id}" style="display:none;padding:14px 16px;border-top:1px solid #FEE2E2">
          <div style="font-size:12px;color:#374151;background:#F8FAFC;border:1px solid #E5E7EB;border-radius:8px;padding:12px;margin-bottom:12px;line-height:1.65">\${item.email?.body || ''}</div>
          <div style="font-size:10px;font-weight:700;color:#6B7280;margin-bottom:6px;letter-spacing:.5px">🤖 AI DRAFT — edit before sending</div>
          <textarea id="review-draft-\${item.id}" style="width:100%;min-height:150px;padding:10px 12px;border:1px solid #D1D5DB;border-radius:8px;font-size:13px;line-height:1.7;resize:vertical;margin-bottom:10px">\${item.draftReply || ''}</textarea>
          <button class="btn btn-green" onclick="approveReview('\${item.id}')">✓ Approve & Send</button>
        </div>
      </div>
    \`).join('');
  } else {
    rqItems.innerHTML = '<div style="background:#F0FFF4;border:1px solid #86EFAC;border-radius:12px;padding:24px;text-align:center;color:#166534;font-size:14px;font-weight:500">✓ Nothing waiting for review — the agent is handling everything.</div>';
  }

  // Voice profile
  if (voice) {
    document.getElementById('guidelines-view').textContent = voice.guidelines || '';
    if (!editingGuidelines) {
      const ta = document.getElementById('guidelines-textarea');
      if (ta) ta.value = voice.guidelines || '';
    }
    const samplesEl = document.getElementById('voice-samples');
    if (samplesEl) {
      samplesEl.innerHTML = (voice.samples || []).length === 0
        ? '<div style="font-size:13px;color:#9CA3AF;margin-bottom:14px">No samples yet — add approved replies below.</div>'
        : (voice.samples || []).map((s, i) => \`
          <div style="background:#F8FAFC;border:1px solid #E5E7EB;border-radius:8px;padding:12px;margin-bottom:8px;display:flex;gap:10px">
            <div style="flex:1;font-size:13px;color:#374151;line-height:1.6">\${s}</div>
            <button onclick="removeSample(\${i})" style="background:none;border:none;color:#EF4444;cursor:pointer;font-size:16px;flex-shrink:0;align-self:flex-start">×</button>
          </div>
        \`).join('');
    }
  }

  // Sent log
  const sentEl = document.getElementById('sent-log-items');
  if (sentEl && sent && sent.length > 0) {
    sentEl.innerHTML = sent.slice(0, 50).map(item => \`
      <div style="background:#fff;border:1px solid #E5E7EB;border-radius:12px;margin-bottom:10px;overflow:hidden;animation:fadeIn .2s ease;cursor:pointer" onclick="toggleSent('\${item.id}')">
        <div style="padding:12px 16px;display:flex;align-items:center;justify-content:space-between;gap:12px">
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">\${item.email?.subject || ''}</div>
            <div style="font-size:11px;color:#6B7280;margin-top:2px;display:flex;gap:8px;flex-wrap:wrap">
              <span>To: \${item.email?.from || ''}</span>
              <span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:20px;background:\${(item.confidence||0)>=80?'#F0FFF4':(item.confidence||0)>=60?'#FFFBEB':'#FFF0F0'};color:\${(item.confidence||0)>=80?'#059669':(item.confidence||0)>=60?'#D97706':'#DC2626'}">\${item.confidence||0}% confidence</span>
              \${item.manualApproval ? '<span style="font-size:10px;font-weight:600;padding:2px 7px;border-radius:20px;background:#EFF6FF;color:#1D4ED8">Staff approved</span>' : ''}
            </div>
          </div>
          <div style="font-size:11px;color:#9CA3AF;text-align:right;flex-shrink:0">
            <div>\${new Date(item.sentAt).toLocaleDateString()}</div>
            <div>\${new Date(item.sentAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</div>
          </div>
        </div>
        <div id="sent-body-\${item.id}" style="display:none;padding:0 16px 14px;border-top:1px solid #F3F4F6">
          <div style="font-size:10px;font-weight:700;color:#6B7280;margin:10px 0 6px;letter-spacing:.5px">SENT REPLY</div>
          <div style="background:#F8FAFC;border:1px solid #E5E7EB;border-radius:8px;padding:12px;font-size:13px;color:#374151;line-height:1.7;white-space:pre-wrap">\${item.replyBody || ''}</div>
        </div>
      </div>
    \`).join('');
  }
}

// ─── ACTIONS ──────────────────────────────────────────────────────────────────
async function cancelSend(id) {
  try { await apiFetch('/api/queue/' + id + '/cancel', { method: 'POST' }); showToast('Send cancelled'); await refreshData(); }
  catch(e) { showErr(e.message); }
}

function toggleReview(id) {
  const body = document.getElementById('review-body-' + id);
  body.style.display = body.style.display === 'none' ? 'block' : 'none';
}

async function approveReview(id) {
  const draft = document.getElementById('review-draft-' + id)?.value;
  try { await apiFetch('/api/review/' + id + '/approve', { method: 'POST', body: JSON.stringify({ reply: draft }) }); showToast('✓ Reply sent'); await refreshData(); }
  catch(e) { showErr(e.message); }
}

async function discardReview(id) {
  try { await apiFetch('/api/review/' + id + '/discard', { method: 'POST' }); showToast('Discarded'); await refreshData(); }
  catch(e) { showErr(e.message); }
}

function toggleSent(id) {
  const body = document.getElementById('sent-body-' + id);
  if (body) body.style.display = body.style.display === 'none' ? 'block' : 'none';
}

// ─── VOICE ────────────────────────────────────────────────────────────────────
function toggleEditGuidelines() {
  editingGuidelines = !editingGuidelines;
  document.getElementById('guidelines-view').style.display = editingGuidelines ? 'none' : 'block';
  document.getElementById('guidelines-edit').style.display = editingGuidelines ? 'block' : 'none';
  if (editingGuidelines) document.getElementById('guidelines-textarea').value = serverData.voice?.guidelines || '';
}

async function saveGuidelines() {
  const guidelines = document.getElementById('guidelines-textarea').value;
  try { await apiFetch('/api/voice/guidelines', { method: 'POST', body: JSON.stringify({ guidelines }) }); toggleEditGuidelines(); showToast('✓ Voice guidelines saved'); await refreshData(); }
  catch(e) { showErr(e.message); }
}

async function addSample() {
  const sample = document.getElementById('new-sample-input').value.trim();
  if (!sample) return;
  try { await apiFetch('/api/voice/sample', { method: 'POST', body: JSON.stringify({ sample }) }); document.getElementById('new-sample-input').value = ''; showToast('✓ Voice sample added'); await refreshData(); }
  catch(e) { showErr(e.message); }
}

async function removeSample(i) {
  try { await apiFetch('/api/voice/sample/' + i, { method: 'DELETE' }); showToast('Sample removed'); await refreshData(); }
  catch(e) { showErr(e.message); }
}

// ─── INBOX ────────────────────────────────────────────────────────────────────
function renderEmailList() {
  const list = document.getElementById('email-list');
  list.innerHTML = DEMO_EMAILS.map(e => {
    const tag = TAGS[e.tag];
    return \`<div class="email-row \${e.status==='unread'?'unread':''} \${selectedEmailId===e.id?'selected':''}" onclick="selectEmail(\${e.id})">
      <div style="display:flex;justify-content:space-between;margin-bottom:2px">
        <span style="font-size:13px;font-weight:\${e.status==='unread'?700:500};color:#0F172A;display:flex;align-items:center;gap:5px;overflow:hidden;flex:1">
          \${e.status==='unread'?'<span style="width:6px;height:6px;border-radius:50%;background:#0EA5E9;flex-shrink:0;display:inline-block"></span>':''}
          \${e.status==='replied'?'<span style="font-size:10px;color:#059669;font-weight:600;flex-shrink:0">✓</span>':''}
          <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">\${e.name}</span>
        </span>
        <span style="font-size:11px;color:#9CA3AF;flex-shrink:0;margin-left:4px">\${e.time}</span>
      </div>
      <div style="font-size:12px;font-weight:500;color:#334155;margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">\${e.subject}</div>
      <span class="tag" style="background:\${tag.bg};color:\${tag.color}">\${tag.label}</span>
    </div>\`;
  }).join('');
}

async function selectEmail(id) {
  selectedEmailId = id;
  const email = DEMO_EMAILS.find(e => e.id === id);
  if (!email) return;
  email.status = email.status === 'unread' ? 'read' : email.status;
  renderEmailList();

  const detail = document.getElementById('email-detail');
  const tag = TAGS[email.tag];
  detail.innerHTML = \`
    <div style="max-width:640px;animation:fadeIn .2s ease">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:6px">
        <div style="font-family:'DM Serif Display',serif;font-size:20px;line-height:1.3">\${email.subject}</div>
        <span class="tag" style="background:\${tag.bg};color:\${tag.color};flex-shrink:0;padding:3px 9px;font-size:11px">\${tag.label}</span>
      </div>
      <div style="font-size:12px;color:#64748B;margin-bottom:14px">From: <strong>\${email.name}</strong> · \${email.time}</div>
      <div style="background:#fff;border:1px solid #E2E8F0;border-radius:10px;padding:18px;margin-bottom:14px;font-size:14px;line-height:1.75;color:#334155">\${email.body}</div>
      <div id="summary-area"><div style="display:flex;align-items:center;gap:8px;color:#6B7280;font-size:13px;padding:6px 0"><div class="spinner"></div>Analysing email…</div></div>
      \${email.status === 'replied' ?
        '<div style="padding:10px 14px;background:#F0FFF4;border:1px solid #86EFAC;border-radius:8px;font-size:13px;color:#166534;font-weight:500">✓ Reply sent</div>' :
        \`<div id="reply-section">
          <button class="btn btn-blue" id="draft-btn" onclick="draftReply(\${email.id})">✨ Draft Reply</button>
          <div id="reply-area" style="display:none;margin-top:14px;animation:fadeIn .25s ease">
            <div style="font-size:11px;font-weight:700;color:#64748B;margin-bottom:8px;letter-spacing:.5px">DRAFTED REPLY — edit before sending</div>
            <textarea id="reply-text" style="width:100%;min-height:180px;padding:14px;border:1px solid #CBD5E1;border-radius:10px;font-size:13.5px;line-height:1.75;resize:vertical;color:#1E293B"></textarea>
            <div style="display:flex;gap:8px;margin-top:10px">
              <button class="btn btn-green" onclick="sendReply(\${email.id})">📤 Send via Gmail</button>
              <button class="btn btn-gray" onclick="discardReply()">Discard</button>
            </div>
          </div>
        </div>\`
      }
    </div>
  \`;

  // Auto-summarise
  try {
    const summary = await callClaude('Summarise in 1-2 sentences and state the best next action for the clinic.\\n\\nFrom: ' + email.name + '\\nSubject: ' + email.subject + '\\nBody: ' + email.body);
    const sa = document.getElementById('summary-area');
    if (sa) sa.innerHTML = \`<div style="background:#F0F9FF;border:1px solid #BAE6FD;border-radius:10px;padding:13px 16px;margin-bottom:14px;animation:fadeIn .25s ease"><div style="font-size:10px;font-weight:700;color:#0284C7;margin-bottom:5px;letter-spacing:.5px">🤖 AI ANALYSIS</div><div style="font-size:13px;color:#1E40AF;line-height:1.65">\${summary}</div></div>\`;
  } catch(e) {
    const sa = document.getElementById('summary-area');
    if (sa) sa.innerHTML = '';
  }
}

async function draftReply(id) {
  const email = DEMO_EMAILS.find(e => e.id === id);
  if (!email) return;
  const btn = document.getElementById('draft-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<div class="spinner"></div> Drafting…'; }
  try {
    const reply = await callClaude('Write a professional reply for Expert Physio. No subject line. Start with greeting. End with Expert Physio Team.\\n\\nFrom: ' + email.name + '\\nSubject: ' + email.subject + '\\nBody: ' + email.body);
    draftReplies[id] = reply;
    const ra = document.getElementById('reply-area');
    const rt = document.getElementById('reply-text');
    if (ra && rt) { rt.value = reply; ra.style.display = 'block'; }
    if (btn) btn.style.display = 'none';
  } catch(e) {
    showErr('Draft failed: ' + e.message);
    if (btn) { btn.disabled = false; btn.innerHTML = '✨ Draft Reply'; }
  }
}

function sendReply(id) {
  const email = DEMO_EMAILS.find(e => e.id === id);
  if (email) { email.status = 'replied'; showToast('✓ Reply sent to ' + email.name); renderEmailList(); }
  const detail = document.getElementById('email-detail');
  if (detail) detail.querySelector('#reply-section').innerHTML = '<div style="padding:10px 14px;background:#F0FFF4;border:1px solid #86EFAC;border-radius:8px;font-size:13px;color:#166534;font-weight:500">✓ Reply sent via Gmail</div>';
}

function discardReply() {
  const ra = document.getElementById('reply-area');
  const btn = document.getElementById('draft-btn');
  if (ra) ra.style.display = 'none';
  if (btn) { btn.style.display = 'inline-flex'; btn.innerHTML = '✨ Draft Reply'; }
}

// ─── COMPOSE ──────────────────────────────────────────────────────────────────
async function generateEmail() {
  const text = document.getElementById('compose-input').value.trim();
  if (!text) return;
  const btn = document.getElementById('compose-btn');
  const spinner = document.getElementById('compose-spinner');
  const composed = document.getElementById('composed-email');
  btn.disabled = true; spinner.style.display = 'block'; composed.style.display = 'none';
  try {
    const raw = await callClaude('Compose a clinic email for Expert Physio: "' + text + '"\\n\\nReturn ONLY valid JSON with keys: to, subject, body (ending with Expert Physio Team). No markdown, no backticks.');
    const clean = raw.replace(/^\`\`\`(?:json)?\\s*/i,'').replace(/\\s*\`\`\`\\s*$/,'').trim();
    const obj = JSON.parse(clean);
    document.getElementById('c-to').value = obj.to || '';
    document.getElementById('c-subject').value = obj.subject || '';
    document.getElementById('c-body').value = obj.body || '';
    composed.style.display = 'block';
  } catch(e) {
    showErr('Compose failed: ' + e.message);
  } finally {
    btn.disabled = false; spinner.style.display = 'none';
  }
}

function sendComposed() {
  const subj = document.getElementById('c-subject').value;
  const to = document.getElementById('c-to').value;
  showToast('✓ Email sent: "' + subj + '" to ' + (to || 'recipient'));
  discardComposed();
}

function discardComposed() {
  document.getElementById('composed-email').style.display = 'none';
  document.getElementById('compose-input').value = '';
}

// ─── INIT ─────────────────────────────────────────────────────────────────────
refreshData();
setInterval(refreshData, 8000);
showTab('Autopilot');
</script>
</body>
</html>`);
});

app.listen(parseInt(PORT), () => log(`Expert Physio Agent v2 running on port ${PORT}`, "success"));
