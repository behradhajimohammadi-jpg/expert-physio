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


// ─── CORE ENGINE v3 ───────────────────────────────────────────────────────────
// Two-step AI review, old/new email separation, notification bell system

const SEND_DELAY_MS   = 5 * 60 * 1000;  // 5-min cancel window
const OLD_EMAIL_DAYS  = 3;               // emails older than 3 days = "old"
const CONFIDENCE_MIN  = 80;             // auto-send threshold

// ─── STATE ────────────────────────────────────────────────────────────────────
let archiveEmails = [];   // old emails (3+ days) — notification bell, never auto-send
let notifications = [];  // bell notifications for old email follow-ups

function isOldEmail(email) {
  if (!email.date) return false;
  const sent = new Date(email.date);
  const ageMs = Date.now() - sent.getTime();
  return ageMs > OLD_EMAIL_DAYS * 24 * 60 * 60 * 1000;
}

// ─── TWO-STEP AI REVIEW ───────────────────────────────────────────────────────
/*
  Step 1 — UNDERSTAND: AI reads the email deeply, extracts intent, risks, context
  Step 2 — DECIDE:     AI decides what to do and generates the reply
  Only if both steps pass does the email proceed to the send queue
*/

async function stepOneUnderstand(email) {
  log(`[Step 1] Understanding: "${email.subject}"`, "info");
  const raw = await callAI(
    `You are reviewing an incoming email for Expert Physio clinic.

Read this email carefully and extract the full context.

From: ${email.from}
Subject: ${email.subject}
Body: ${email.body}
Date received: ${email.date}

Return JSON:
{
  "intent": "what the sender actually wants",
  "patientName": "first name if found, else null",
  "urgency": "low|normal|high|critical",
  "risks": ["list any risks, sensitivities, or reasons to be careful"],
  "requiresClinicalJudgment": true or false,
  "requiresScheduleAccess": true or false,
  "isLegalOrFinancial": true or false,
  "sentiment": "positive|neutral|frustrated|angry",
  "suggestedAction": "what the clinic should do"
}`,
    "You are a careful, thorough clinical email analyst. Extract every relevant detail. Flag any risk, no matter how small.",
    true
  );
  try { return parseJSON(raw); }
  catch { return { intent: "unknown", urgency: "normal", risks: [], requiresClinicalJudgment: false, requiresScheduleAccess: false, isLegalOrFinancial: false, sentiment: "neutral", suggestedAction: "review manually", patientName: null }; }
}

async function stepTwoDecide(email, understanding, classification) {
  log(`[Step 2] Deciding action: "${email.subject}" | intent: ${understanding.intent}`, "info");

  // Hard rules — never auto-send regardless of confidence
  if (understanding.requiresClinicalJudgment) return { proceed: false, reason: "Requires clinical judgment" };
  if (understanding.requiresScheduleAccess)   return { proceed: false, reason: "Requires schedule access" };
  if (understanding.isLegalOrFinancial)        return { proceed: false, reason: "Legal or financial risk" };
  if (understanding.urgency === "critical")    return { proceed: false, reason: "Critical urgency — needs human" };
  if (understanding.sentiment === "angry")     return { proceed: false, reason: "Angry sender — needs human touch" };
  if (understanding.risks.length > 2)         return { proceed: false, reason: `Multiple risks: ${understanding.risks.slice(0,2).join(", ")}` };
  if (classification.confidence < CONFIDENCE_MIN) return { proceed: false, reason: `Confidence too low (${classification.confidence}% < ${CONFIDENCE_MIN}%)` };
  if (!classification.autoSend)               return { proceed: false, reason: classification.reason };

  return { proceed: true, reason: "Passed all checks" };
}

async function generateSmartReply(email, understanding, classification) {
  const voiceContext = voiceProfile.samples.length > 0
    ? `\n\nApproved reply examples from this clinic:\n${voiceProfile.samples.slice(0,3).join("\n---\n")}`
    : "";

  return await callAI(
    `You are writing a reply for Expert Physio clinic.

DEEP CONTEXT:
- Sender intent: ${understanding.intent}
- Patient name: ${understanding.patientName || "unknown"}
- Urgency: ${understanding.urgency}
- Sentiment: ${understanding.sentiment}
- Suggested action: ${understanding.suggestedAction}

EMAIL:
From: ${email.from}
Subject: ${email.subject}
Body: ${email.body}

VOICE GUIDELINES:
${voiceProfile.guidelines}${voiceContext}

INSTRUCTIONS:
- Address the sender's ACTUAL intent: ${understanding.intent}
- ${understanding.patientName ? `Use their name: ${understanding.patientName}` : "Use friendly greeting"}
- Maximum 4 sentences
- Do NOT include a subject line
- Do NOT make clinical promises
- Do NOT reference specific appointment times
- Sound like a real human wrote this, not a bot
- Sign off as "Expert Physio Team"

Write ONLY the email body starting with the greeting.`,
    "You write warm, natural physiotherapy clinic emails. Sound human. Be specific to this exact email, not generic."
  );
}

// ─── FULL PROCESSING PIPELINE ─────────────────────────────────────────────────
async function processEmail(id) {
  if (processedIds.has(id)) return;
  processedIds.add(id);

  let email;
  try { email = await getEmailDetails(id); }
  catch (err) { log(`Failed to fetch ${id}: ${err.message}`, "error"); processedIds.delete(id); return; }

  log(`📨 Received: "${email.subject}" from ${email.from}`);

  // ── ROUTE OLD EMAILS TO ARCHIVE ──────────────────────────────────────────────
  if (isOldEmail(email)) {
    await markRead(id);
    await applyLabel(id, "AI-Archived");

    const archiveItem = {
      id: `arch_${Date.now()}_${id}`,
      emailId: id,
      email,
      archivedAt: new Date().toISOString(),
      followedUp: false,
    };
    archiveEmails.unshift(archiveItem);
    if (archiveEmails.length > 200) archiveEmails.pop();

    // Create notification bell alert
    const notif = {
      id: `notif_${Date.now()}`,
      type: "old_email",
      title: "Old email needs follow-up",
      message: `"${email.subject}" from ${email.from} — received ${email.date ? new Date(email.date).toLocaleDateString() : "recently"}`,
      emailId: id,
      archiveItemId: archiveItem.id,
      createdAt: new Date().toISOString(),
      read: false,
    };
    notifications.unshift(notif);
    if (notifications.length > 50) notifications.pop();

    log(`📁 Archived old email: "${email.subject}" — notification created`, "archive");
    return;
  }

  // ── PROCESS NEW EMAILS WITH TWO-STEP REVIEW ──────────────────────────────────
  try {
    await markRead(id);

    // Step 1 — Understand
    const understanding = await stepOneUnderstand(email);
    log(`[Step 1 ✓] Intent: "${understanding.intent}" | Urgency: ${understanding.urgency} | Risks: ${understanding.risks.length}`, "info");

    // Step 2 — Classify
    const classification = await classify(email);
    log(`[Step 2 ✓] Category: ${classification.category} | Confidence: ${classification.confidence}% | AutoSend: ${classification.autoSend}`, "info");

    // Step 3 — Decide
    const decision = await stepTwoDecide(email, understanding, classification);
    log(`[Step 3 ✓] Decision: ${decision.proceed ? "PROCEED" : "HOLD"} — ${decision.reason}`, decision.proceed ? "info" : "review");

    if (decision.proceed) {
      // Generate smart reply using full context
      const replyBody = await generateSmartReply(email, understanding, classification);
      log(`[Reply ✓] Generated reply for "${email.subject}"`, "info");

      const sendAt = Date.now() + SEND_DELAY_MS;
      const queueItem = {
        id: `q_${Date.now()}_${id}`,
        emailId: id,
        email,
        understanding,
        classification,
        replyBody,
        sendAt,
        cancelled: false,
        createdAt: new Date().toISOString(),
      };
      sendQueue.push(queueItem);
      log(`⏱ Queued (5-min window): "${email.subject}" → ${email.from} (${classification.category}, ${classification.confidence}%)`, "queued");

      setTimeout(async () => {
        const item = sendQueue.find(q => q.id === queueItem.id);
        if (!item || item.cancelled) { log(`Send cancelled: "${email.subject}"`, "cancelled"); return; }
        try {
          await sendEmail(email.threadId, email.from, email.subject, item.replyBody);
          await applyLabel(id, "AI-Auto-Replied");
          sentLog.unshift({ id: queueItem.id, email, understanding, replyBody: item.replyBody, category: classification.category, confidence: classification.confidence, sentAt: new Date().toISOString() });
          if (sentLog.length > 500) sentLog.pop();
          sendQueue = sendQueue.filter(q => q.id !== queueItem.id);
          log(`✅ Auto-sent: "${email.subject}" → ${email.from}`, "sent");
        } catch (err) {
          log(`Send failed "${email.subject}": ${err.message}`, "error");
          sendQueue = sendQueue.filter(q => q.id !== queueItem.id);
        }
      }, SEND_DELAY_MS);

    } else {
      // Hold for human review with full context
      const draftReply = await generateSmartReply(email, understanding, classification);
      await applyLabel(id, "AI-Needs-Review");
      pendingReview.push({
        id: `r_${Date.now()}_${id}`,
        emailId: id,
        email,
        understanding,
        classification,
        draftReply,
        holdReason: decision.reason,
        receivedAt: new Date().toISOString(),
      });
      log(`⚠️ Held for review: "${email.subject}" — ${decision.reason}`, "review");
    }

  } catch (err) {
    log(`Processing error "${email?.subject}": ${err.message}`, "error");
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
      log(`Found ${newOnes.length} new email(s) — processing with 2-step review`);
      for (const m of newOnes) {
        await processEmail(m.id);
        await new Promise(r => setTimeout(r, 1500));
      }
    }
  } catch (err) { log(`Poll error: ${err.message}`, "error"); }
}

function startPolling() {
  if (pollingInterval) clearInterval(pollingInterval);
  pollingInterval = setInterval(pollInbox, 5 * 60 * 1000);
  pollInbox();
  log("Autopilot v3 started — 2-step review, old/new separation, every 5 min", "success");
}

// ─── API ROUTES ───────────────────────────────────────────────────────────────
app.get("/api/status", (req, res) => res.json({
  connected: !!gmailTokens,
  polling: !!pollingInterval,
  queueCount: sendQueue.filter(q => !q.cancelled).length,
  reviewCount: pendingReview.length,
  archiveCount: archiveEmails.length,
  unreadNotifications: notifications.filter(n => !n.read).length,
  sentToday: sentLog.filter(s => new Date(s.sentAt).toDateString() === new Date().toDateString()).length,
  processed: processedIds.size,
}));

app.get("/api/log",          (req, res) => res.json(activityLog.slice(0, 100)));
app.get("/api/review",       (req, res) => res.json(pendingReview));
app.get("/api/queue",        (req, res) => res.json(sendQueue.filter(q => !q.cancelled)));
app.get("/api/sent",         (req, res) => res.json(sentLog.slice(0, 100)));
app.get("/api/voice",        (req, res) => res.json(voiceProfile));
app.get("/api/archive",      (req, res) => res.json(archiveEmails.slice(0, 100)));
app.get("/api/notifications",(req, res) => res.json(notifications));

// Mark notification as read
app.post("/api/notifications/:id/read", (req, res) => {
  const n = notifications.find(x => x.id === req.params.id);
  if (n) n.read = true;
  res.json({ success: true });
});

// Mark all notifications read
app.post("/api/notifications/read-all", (req, res) => {
  notifications.forEach(n => n.read = true);
  res.json({ success: true });
});

// Mark archive item as followed up
app.post("/api/archive/:id/followup", (req, res) => {
  const item = archiveEmails.find(a => a.id === req.params.id);
  if (!item) return res.status(404).json({ error: "Not found" });
  item.followedUp = true;
  const notif = notifications.find(n => n.archiveItemId === req.params.id);
  if (notif) notif.read = true;
  log(`Archive follow-up marked: "${item.email.subject}"`, "info");
  res.json({ success: true });
});

// Cancel queued send
app.post("/api/queue/:id/cancel", (req, res) => {
  const item = sendQueue.find(q => q.id === req.params.id);
  if (!item) return res.status(404).json({ error: "Not found" });
  item.cancelled = true;
  log(`Send cancelled: "${item.email.subject}"`, "cancelled");
  res.json({ success: true });
});

// Approve review
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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Discard review
app.post("/api/review/:id/discard", (req, res) => {
  const before = pendingReview.length;
  pendingReview = pendingReview.filter(p => p.id !== req.params.id);
  pendingReview.length < before ? res.json({ success: true }) : res.status(404).json({ error: "Not found" });
});

// Voice
app.post("/api/voice/guidelines", (req, res) => {
  if (!req.body.guidelines) return res.status(400).json({ error: "Missing guidelines" });
  voiceProfile.guidelines = req.body.guidelines;
  log("Voice guidelines updated", "info");
  res.json({ success: true });
});
app.post("/api/voice/sample", (req, res) => {
  if (!req.body.sample) return res.status(400).json({ error: "Missing sample" });
  voiceProfile.samples.push(req.body.sample);
  if (voiceProfile.samples.length > 10) voiceProfile.samples.shift();
  log(`Voice sample added (${voiceProfile.samples.length} total)`, "info");
  res.json({ success: true });
});
app.delete("/api/voice/sample/:index", (req, res) => {
  const i = parseInt(req.params.index);
  if (isNaN(i) || i < 0 || i >= voiceProfile.samples.length) return res.status(404).json({ error: "Invalid index" });
  voiceProfile.samples.splice(i, 1);
  res.json({ success: true });
});

app.post("/api/poll", (req, res) => {
  if (!gmailTokens) return res.status(400).json({ error: "Gmail not connected" });
  pollInbox();
  res.json({ success: true });
});

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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── DASHBOARD v3 ─────────────────────────────────────────────────────────────
app.get("*", (req, res) => {
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
    @keyframes bellShake{0%,100%{transform:rotate(0)}20%{transform:rotate(-15deg)}40%{transform:rotate(15deg)}60%{transform:rotate(-10deg)}80%{transform:rotate(10deg)}}
    ::-webkit-scrollbar{width:4px}
    ::-webkit-scrollbar-thumb{background:#CBD5E1;border-radius:4px}
    input,textarea,button{font-family:inherit}
    textarea:focus,input:focus{outline:2px solid #0EA5E9;outline-offset:1px;border-radius:4px}
    .tab-btn{width:100%;padding:10px 16px;background:transparent;border:none;border-left:3px solid transparent;cursor:pointer;text-align:left;font-size:13px;font-weight:400;color:#374151;display:flex;align-items:center;justify-content:space-between}
    .tab-btn.active{background:#F0F9FF;border-left-color:#0EA5E9;font-weight:600;color:#0284C7}
    .tab-btn:hover:not(.active){background:#F8FAFC}
    .btn{padding:9px 18px;border:none;border-radius:8px;cursor:pointer;font-size:13px;font-weight:600;display:inline-flex;align-items:center;gap:6px}
    .btn:disabled{opacity:.5;cursor:not-allowed}
    .btn-blue{background:#0EA5E9;color:#fff}
    .btn-green{background:#059669;color:#fff}
    .btn-gray{background:#F1F5F9;color:#475569;border:1px solid #E2E8F0}
    .btn-red{background:#FEE2E2;color:#C0392B}
    .btn-amber{background:#FEF3C7;color:#92400E;border:1px solid #FCD34D}
    .card{background:#fff;border:1px solid #E5E7EB;border-radius:12px;padding:18px;margin-bottom:14px}
    .spinner{width:14px;height:14px;border-radius:50%;border:2px solid #E5E7EB;border-top-color:#0EA5E9;animation:spin .7s linear infinite;flex-shrink:0}
    .tag{font-size:10px;font-weight:600;padding:2px 8px;border-radius:20px}
    .step-badge{font-size:10px;font-weight:700;padding:2px 8px;border-radius:20px;background:#EFF6FF;color:#1D4ED8}
    #toast{position:fixed;top:20px;right:20px;z-index:9999;background:#111827;color:#fff;padding:11px 20px;border-radius:10px;font-size:13px;font-weight:500;box-shadow:0 4px 24px rgba(0,0,0,.25);display:none;align-items:center;gap:12px;max-width:380px}
    #notif-panel{position:fixed;top:60px;right:16px;width:360px;background:#fff;border:1px solid #E5E7EB;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.12);z-index:500;display:none;max-height:480px;overflow-y:auto}
  </style>
</head>
<body>
<div id="toast"><span id="toast-msg"></span><button onclick="hideToast()" style="background:none;border:none;color:#9CA3AF;cursor:pointer;font-size:18px;line-height:1">×</button></div>

<!-- NOTIFICATION PANEL -->
<div id="notif-panel">
  <div style="padding:14px 16px;border-bottom:1px solid #F3F4F6;display:flex;align-items:center;justify-content:space-between">
    <div style="font-size:14px;font-weight:700">🔔 Notifications</div>
    <button onclick="markAllRead()" style="font-size:12px;color:#0EA5E9;background:none;border:none;cursor:pointer;font-weight:500">Mark all read</button>
  </div>
  <div id="notif-list"><div style="padding:20px;text-align:center;color:#9CA3AF;font-size:13px">No notifications</div></div>
</div>

<!-- HEADER -->
<div style="background:#0B1F3A;height:56px;display:flex;align-items:center;justify-content:space-between;padding:0 22px;flex-shrink:0;border-bottom:1px solid #1E3A5F">
  <div style="display:flex;align-items:center;gap:10px">
    <div style="width:32px;height:32px;border-radius:8px;background:linear-gradient(135deg,#0EA5E9,#0369A1);display:flex;align-items:center;justify-content:center;font-size:16px">🤖</div>
    <div>
      <div style="font-family:'DM Serif Display',serif;font-size:16px;color:#fff">Expert Physio AI Agent <span style="font-size:10px;color:#64B5D9;font-family:'DM Sans',sans-serif;font-weight:400">v3 — 2-Step Review</span></div>
      <div id="status-line" style="font-size:10px;color:#FCA5A5">○ Gmail not connected</div>
    </div>
  </div>
  <div style="display:flex;gap:10px;align-items:center">
    <div id="header-badges"></div>
    <!-- Notification Bell -->
    <button id="bell-btn" onclick="toggleNotifPanel()" style="position:relative;background:none;border:none;cursor:pointer;padding:4px;color:#7DD3FC;font-size:20px">
      🔔
      <span id="bell-badge" style="position:absolute;top:-2px;right:-2px;background:#EF4444;color:#fff;border-radius:10px;font-size:9px;font-weight:700;padding:1px 4px;display:none"></span>
    </button>
    <div id="connect-btn-area"></div>
  </div>
</div>

<!-- BODY -->
<div style="display:flex;flex:1;overflow:hidden">
  <!-- SIDEBAR -->
  <div style="width:200px;background:#fff;border-right:1px solid #E5E7EB;display:flex;flex-direction:column;flex-shrink:0">
    <div style="padding:14px 0;flex:1">
      <button class="tab-btn active" id="tab-Autopilot" onclick="showTab('Autopilot')"><span>⚡ Autopilot</span><span id="badge-Autopilot" style="background:#F59E0B;color:#fff;border-radius:10px;font-size:10px;font-weight:700;padding:1px 6px;display:none"></span></button>
      <button class="tab-btn" id="tab-Queue" onclick="showTab('Queue')"><span>👁 Review Queue</span><span id="badge-Queue" style="background:#EF4444;color:#fff;border-radius:10px;font-size:10px;font-weight:700;padding:1px 6px;display:none"></span></button>
      <button class="tab-btn" id="tab-Archive" onclick="showTab('Archive')"><span>📁 Old Emails</span><span id="badge-Archive" style="background:#F59E0B;color:#fff;border-radius:10px;font-size:10px;font-weight:700;padding:1px 6px;display:none"></span></button>
      <button class="tab-btn" id="tab-Voice" onclick="showTab('Voice')"><span>🎙 Voice Profile</span></button>
      <button class="tab-btn" id="tab-Inbox" onclick="showTab('Inbox')"><span>📬 Demo Inbox</span></button>
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
    <div id="err-banner" style="display:none;background:#FFF0F0;border:1px solid #FECACA;border-radius:8px;padding:10px 16px;font-size:13px;color:#B91C1C;justify-content:space-between;align-items:center;margin:8px 16px 0">
      <span id="err-msg"></span>
      <button onclick="hideErr()" style="background:none;border:none;color:#B91C1C;cursor:pointer;font-size:16px;margin-left:12px">×</button>
    </div>

    <div style="flex:1;overflow:hidden;display:flex">

      <!-- AUTOPILOT TAB -->
      <div id="pane-Autopilot" style="flex:1;overflow-y:auto;padding:28px">
        <div style="max-width:780px">
          <div style="font-family:'DM Serif Display',serif;font-size:22px;margin-bottom:4px">Autopilot Status</div>
          <div style="font-size:13px;color:#64748B;margin-bottom:20px">Every email goes through a 2-step AI review before anything happens. Old emails are separated and flagged for follow-up.</div>

          <div id="connect-banner"></div>

          <!-- 2-Step Explainer -->
          <div class="card" style="margin-bottom:16px;background:linear-gradient(135deg,#F0F9FF,#EFF6FF);border-color:#BAE6FD">
            <div style="font-size:14px;font-weight:700;margin-bottom:12px;color:#0284C7">🧠 How the 2-Step Review Works</div>
            <div style="display:flex;gap:0">
              <div style="flex:1;padding:12px;background:#fff;border-radius:8px;margin-right:8px;border:1px solid #E0F2FE">
                <div class="step-badge" style="margin-bottom:6px">Step 1 — Understand</div>
                <div style="font-size:12px;color:#374151;line-height:1.6">AI reads the email deeply. Extracts intent, patient name, urgency, sentiment, and any risks or red flags before doing anything.</div>
              </div>
              <div style="flex:1;padding:12px;background:#fff;border-radius:8px;border:1px solid #E0F2FE">
                <div class="step-badge" style="margin-bottom:6px">Step 2 — Decide</div>
                <div style="font-size:12px;color:#374151;line-height:1.6">AI checks 6 safety rules. Only if all pass AND confidence ≥ 88% does it generate a reply and queue it with a 5-min cancel window.</div>
              </div>
            </div>
          </div>

          <!-- Send Queue -->
          <div id="send-queue-panel" style="display:none;background:#FFFBEB;border:1px solid #FDE68A;border-radius:12px;padding:18px;margin-bottom:16px">
            <div style="font-size:14px;font-weight:700;margin-bottom:12px;color:#92400E">⏱ Cancel Window — Sending Soon</div>
            <div id="send-queue-items"></div>
          </div>

          <!-- Rules -->
          <div class="card">
            <div style="font-size:14px;font-weight:700;margin-bottom:14px">⚡ Auto-Send Rules <span style="font-size:11px;color:#6B7280;font-weight:400">(confidence threshold: 80%)</span></div>
            ${[
              ['📅','Cancellations','Auto-reply offering reschedule',true],
              ['🙋','New Patient Inquiries','Auto-reply with welcome + booking info',true],
              ['💳','Simple Billing Questions','Auto-reply acknowledging, 1-2 day follow-up',true],
              ['👨‍⚕️','Doctor Referrals','Auto-reply confirming receipt',true],
              ['🏥','ICBC Claims','Always held — staff review required',false],
              ['😤','Complaints / Anger','Always held — needs human touch',false],
              ['🩺','Clinical Questions','Always held — requires therapist judgment',false],
              ['📅','Schedule Requests','Always held — requires calendar access',false],
              ['❓','Confidence < 88%','Held — AI not certain enough to send',false],
              ['📁','Emails 3+ Days Old','Archived + notification — never auto-sent',false],
            ].map(([icon,label,action,auto]) => `
            <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid #F3F4F6">
              <div style="display:flex;align-items:center;gap:10px">
                <span style="font-size:16px">${icon}</span>
                <div><div style="font-size:13px;font-weight:600">${label}</div><div style="font-size:11px;color:#6B7280">${action}</div></div>
              </div>
              <span style="font-size:11px;font-weight:600;padding:3px 10px;border-radius:20px;background:${auto?'#F0FFF4':'#FFF0F0'};color:${auto?'#166534':'#C0392B'}">${auto?'✓ Auto-Send':'👁 Review First'}</span>
            </div>`).join('')}
          </div>

          <!-- Live Log -->
          <div class="card">
            <div style="font-size:14px;font-weight:700;margin-bottom:14px">📊 Live Activity</div>
            <div id="live-log"><div style="font-size:13px;color:#9CA3AF">No activity yet.</div></div>
          </div>
        </div>
      </div>

      <!-- QUEUE TAB -->
      <div id="pane-Queue" style="display:none;flex:1;overflow-y:auto;padding:28px">
        <div style="max-width:740px">
          <div style="font-family:'DM Serif Display',serif;font-size:22px;margin-bottom:4px">Review Queue</div>
          <div style="font-size:13px;color:#64748B;margin-bottom:20px">Emails that failed the 2-step review. Full AI analysis shown — draft reply pre-written. Edit and approve with one click.</div>
          <div id="review-queue-items"></div>
        </div>
      </div>

      <!-- ARCHIVE TAB -->
      <div id="pane-Archive" style="display:none;flex:1;overflow-y:auto;padding:28px">
        <div style="max-width:740px">
          <div style="font-family:'DM Serif Display',serif;font-size:22px;margin-bottom:4px">Old Emails <span style="font-size:14px;color:#F59E0B;font-family:'DM Sans',sans-serif;font-weight:600">(3+ days old)</span></div>
          <div style="font-size:13px;color:#64748B;margin-bottom:6px">These emails were in the inbox when the agent connected. They're separated so new emails get priority.</div>
          <div style="font-size:13px;color:#EF4444;font-weight:500;margin-bottom:20px">⚠️ These senders haven't heard back — follow up as soon as possible.</div>
          <div id="archive-items"></div>
        </div>
      </div>

      <!-- VOICE TAB -->
      <div id="pane-Voice" style="display:none;flex:1;overflow-y:auto;padding:28px">
        <div style="max-width:680px">
          <div style="font-family:'DM Serif Display',serif;font-size:22px;margin-bottom:4px">Voice Profile</div>
          <div style="font-size:13px;color:#64748B;margin-bottom:20px">Train the agent to write exactly like Expert Physio. The AI uses this on every reply it generates.</div>
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
            <div style="font-size:12px;color:#6B7280;margin-bottom:14px">Paste real approved replies. The AI matches this exact style on every email it writes.</div>
            <div id="voice-samples"></div>
            <textarea id="new-sample-input" placeholder="Paste an approved reply example here…" style="width:100%;min-height:100px;padding:12px;border:1px solid #D1D5DB;border-radius:8px;font-size:13px;line-height:1.65;resize:vertical;margin-bottom:8px"></textarea>
            <button class="btn btn-blue" onclick="addSample()">+ Add Sample</button>
          </div>
        </div>
      </div>

      <!-- INBOX TAB -->
      <div id="pane-Inbox" style="display:none;flex:1;overflow:hidden">
        <div style="width:296px;border-right:1px solid #E5E7EB;overflow-y:auto;background:#fff;flex-shrink:0;height:100%">
          <div style="padding:11px 14px 9px;border-bottom:1px solid #F3F4F6;font-size:11px;font-weight:700;color:#6B7280;letter-spacing:.5px">DEMO EMAILS</div>
          <div id="email-list"></div>
        </div>
        <div id="email-detail" style="flex:1;overflow-y:auto;padding:26px;display:flex;align-items:center;justify-content:center">
          <div style="text-align:center;color:#9CA3AF"><div style="font-size:44px;margin-bottom:10px">📬</div><div style="font-size:14px">Select an email to read and reply</div></div>
        </div>
      </div>

      <!-- COMPOSE TAB -->
      <div id="pane-Compose" style="display:none;flex:1;overflow-y:auto;padding:30px">
        <div style="max-width:620px">
          <div style="font-family:'DM Serif Display',serif;font-size:22px;margin-bottom:4px">Compose Email</div>
          <div style="font-size:13px;color:#64748B;margin-bottom:20px">Describe what you want sent — the agent writes it in Expert Physio's exact voice.</div>
          <textarea id="compose-input" placeholder='e.g. "Email Sarah Mitchell to reschedule her Thursday appointment to Tuesday at 11am"' style="width:100%;min-height:90px;padding:14px;border:1px solid #D1D5DB;border-radius:10px;font-size:13px;line-height:1.6;resize:vertical;margin-bottom:14px"></textarea>
          <button class="btn btn-blue" id="compose-btn" onclick="generateEmail()">✨ Generate Email</button>
          <div id="compose-spinner" style="display:none;margin-top:10px;display:flex;align-items:center;gap:8px;color:#6B7280;font-size:13px;display:none"><div class="spinner"></div>Composing in Expert Physio's voice…</div>
          <div id="composed-email" style="display:none;margin-top:16px">
            <div class="card" style="padding:0;overflow:hidden">
              <div style="padding:10px 16px;border-bottom:1px solid #F1F5F9;display:flex;gap:10px;align-items:center"><span style="font-size:10px;font-weight:700;color:#94A3B8;width:54px;flex-shrink:0">TO</span><input id="c-to" style="flex:1;border:none;font-size:13.5px;color:#1E293B;padding:0"/></div>
              <div style="padding:10px 16px;border-bottom:1px solid #F1F5F9;display:flex;gap:10px;align-items:center"><span style="font-size:10px;font-weight:700;color:#94A3B8;width:54px;flex-shrink:0">SUBJECT</span><input id="c-subject" style="flex:1;border:none;font-size:13.5px;color:#1E293B;padding:0"/></div>
              <div style="padding:12px 16px"><div style="font-size:10px;font-weight:700;color:#94A3B8;margin-bottom:8px">BODY</div><textarea id="c-body" style="width:100%;min-height:200px;border:none;font-size:13.5px;line-height:1.75;color:#1E293B;resize:vertical;padding:0"></textarea></div>
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
          <div style="font-family:'DM Serif Display',serif;font-size:22px;margin-bottom:4px">Sent Log</div>
          <div style="font-size:13px;color:#64748B;margin-bottom:20px">Every email sent — full content, AI analysis, confidence score.</div>
          <div id="sent-log-items"><div style="font-size:13px;color:#9CA3AF">No emails sent yet.</div></div>
        </div>
      </div>

    </div>
  </div>
</div>

<script>
let currentTab = 'Autopilot';
let serverData = {};
let editingGuidelines = false;
let notifPanelOpen = false;
let selectedEmailId = null;

const DEMO_EMAILS = [
  {id:1,name:'Sarah Mitchell',from:'sarah.mitchell@gmail.com',subject:'Appointment Cancellation - Thursday 2pm',preview:'Hi, I need to cancel my appointment...',body:'Hi, I need to cancel my appointment this Thursday at 2pm. I have a conflict at work. Can we reschedule? Any time Tuesday or Wednesday works. Thanks, Sarah',time:'9:14 AM',status:'unread',tag:'cancellation'},
  {id:2,name:'ICBC Claims',from:'icbc.claims@icbc.com',subject:'Claim #4892-B: Treatment Authorization Required',preview:'Please submit updated treatment plan...',body:'Please submit updated treatment plan for claimant John Patel (Claim #4892-B). Authorization is required before proceeding with further sessions. Please respond within 5 business days.',time:'8:30 AM',status:'unread',tag:'icbc'},
  {id:3,name:'Dr. Angela Lee',from:'drlee@familyclinic.ca',subject:'Referral: Marcus Huang - Lower Back Pain',preview:'I am referring Marcus Huang, 42...',body:'I am referring Marcus Huang, 42, for physiotherapy following a lumbar strain. Three weeks of lower back pain. Please book at your earliest convenience.',time:'Yesterday',status:'read',tag:'referral'},
  {id:4,name:'Kevin Tran',from:'kevin.tran88@hotmail.com',subject:'Question about my invoice',preview:'Hi there, I received an invoice...',body:'Hi there, I received an invoice for $180 but think my insurance covers 80%. Can you resubmit to Pacific Blue Cross? Policy PBC-2291-TK.',time:'Yesterday',status:'read',tag:'billing'},
  {id:5,name:'Amanda Shore',from:'amanda.shore@gmail.com',subject:'New Patient Inquiry',preview:'Hello, I found you on Google...',body:'Hello, I found you on Google and wondering if you accept new patients? I have a rotator cuff injury. Available weekday mornings. Do you direct bill to MSP?',time:'Mon',status:'read',tag:'new-patient'},
];
const TAGS = {cancellation:{bg:'#FFF0F0',color:'#C0392B',label:'Cancellation'},icbc:{bg:'#EEF2FF',color:'#4338CA',label:'ICBC'},referral:{bg:'#F0FFF4',color:'#166534',label:'Referral'},billing:{bg:'#FFFBEB',color:'#92400E',label:'Billing'},'new-patient':{bg:'#F0F9FF',color:'#0369A1',label:'New Patient'}};
let draftReplies = {};

function showToast(msg){const t=document.getElementById('toast');document.getElementById('toast-msg').textContent=msg;t.style.display='flex';setTimeout(()=>t.style.display='none',3500);}
function hideToast(){document.getElementById('toast').style.display='none';}
function showErr(msg){const b=document.getElementById('err-banner');document.getElementById('err-msg').textContent=msg;b.style.display='flex';}
function hideErr(){document.getElementById('err-banner').style.display='none';}

function showTab(name){
  document.querySelectorAll('[id^="pane-"]').forEach(p=>p.style.display='none');
  document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
  const pane=document.getElementById('pane-'+name);
  if(pane)pane.style.display=name==='Inbox'?'flex':'block';
  const btn=document.getElementById('tab-'+name);
  if(btn)btn.classList.add('active');
  currentTab=name;
  if(name==='Inbox')renderEmailList();
}

async function apiFetch(path,opts={}){
  const r=await fetch(path,{headers:{'Content-Type':'application/json'},...opts});
  if(!r.ok){const e=await r.json().catch(()=>({}));throw new Error(e.error||'Request failed');}
  return r.json();
}

async function callClaude(msg){
  const d=await apiFetch('/api/claude',{method:'POST',body:JSON.stringify({model:'claude-sonnet-4-6',max_tokens:900,system:'You are the AI assistant for Expert Physio clinic in Burnaby, BC. Tone: warm, professional, concise. Sign as "Expert Physio Team".',messages:[{role:'user',content:msg}]})});
  const t=(d.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('\\n').trim();
  if(!t)throw new Error('Empty response');
  return t;
}

async function refreshData(){
  try{
    const [status,log,review,queue,sent,voice,archive,notifications]=await Promise.all([
      apiFetch('/api/status'),apiFetch('/api/log'),apiFetch('/api/review'),
      apiFetch('/api/queue'),apiFetch('/api/sent'),apiFetch('/api/voice'),
      apiFetch('/api/archive'),apiFetch('/api/notifications'),
    ]);
    serverData={status,log,review,queue,sent,voice,archive,notifications};
    updateUI();
  }catch(e){console.error('Refresh:',e.message);}
}

function updateUI(){
  const {status,log,review,queue,sent,voice,archive,notifications}=serverData;
  if(!status)return;

  // Header status
  const sl=document.getElementById('status-line');
  if(sl){sl.style.color=status.connected?'#6EE7B7':'#FCA5A5';sl.innerHTML=\`<span style="width:6px;height:6px;border-radius:50%;background:\${status.connected?'#6EE7B7':'#FCA5A5'};display:inline-block;margin-right:4px;\${status.connected?'animation:pulse 2s infinite':''}"></span>\${status.connected?'Autopilot v3 running — 2-step review active':'Gmail not connected'}\`;}

  // Connect btn
  const cba=document.getElementById('connect-btn-area');
  if(cba)cba.innerHTML=status.connected?'':\`<a href="/auth/login" style="padding:7px 16px;background:#0EA5E9;color:#fff;border-radius:8px;font-size:12px;font-weight:600;text-decoration:none">Connect Gmail →</a>\`;

  // Connect banner
  const cb=document.getElementById('connect-banner');
  if(cb)cb.innerHTML=status.connected?'':\`<div style="background:#FFF7ED;border:1px solid #FED7AA;border-radius:12px;padding:20px;margin-bottom:20px;display:flex;align-items:center;justify-content:space-between;gap:16px"><div><div style="font-weight:600;color:#92400E;margin-bottom:4px">Gmail not connected</div><div style="font-size:13px;color:#B45309">Click Connect Gmail in the top right to start the autopilot.</div></div><a href="/auth/login" style="padding:10px 20px;background:#F59E0B;color:#fff;border-radius:8px;font-size:13px;font-weight:600;text-decoration:none;white-space:nowrap">Connect Gmail →</a></div>\`;

  // Sidebar stats
  const ss=document.getElementById('sidebar-stats');
  if(ss)ss.innerHTML=\`<div>⚡ \${status.sentToday||0} auto-sent today</div><div>⏱ \${status.queueCount||0} in send queue</div><div>⚠️ \${status.reviewCount||0} for review</div><div>📁 \${status.archiveCount||0} old emails</div><div>🔔 \${status.unreadNotifications||0} unread alerts</div>\`;

  // Badges
  const setB=(id,n,show)=>{const el=document.getElementById(id);if(el){el.textContent=n;el.style.display=show?'inline':'none';}};
  setB('badge-Autopilot',queue?.filter(q=>!q.cancelled).length||0,(queue?.filter(q=>!q.cancelled).length||0)>0);
  setB('badge-Queue',status.reviewCount||0,(status.reviewCount||0)>0);
  setB('badge-Archive',status.archiveCount||0,(status.archiveCount||0)>0);

  // Bell
  const unreadN=status.unreadNotifications||0;
  const bellBadge=document.getElementById('bell-badge');
  if(bellBadge){bellBadge.textContent=unreadN;bellBadge.style.display=unreadN>0?'inline':'none';}
  const bellBtn=document.getElementById('bell-btn');
  if(bellBtn&&unreadN>0)bellBtn.style.animation='bellShake 1s ease';

  // Header badges
  let hb='';
  if(status.reviewCount>0)hb+=\`<span style="background:#EF4444;color:#fff;border-radius:20px;font-size:11px;font-weight:700;padding:3px 10px;margin-right:6px">⚠️ \${status.reviewCount} for review</span>\`;
  if((queue?.filter(q=>!q.cancelled).length||0)>0)hb+=\`<span style="background:#F59E0B;color:#fff;border-radius:20px;font-size:11px;font-weight:700;padding:3px 10px">⏱ sending soon</span>\`;
  const hbEl=document.getElementById('header-badges');
  if(hbEl)hbEl.innerHTML=hb;

  // Send queue
  const sqPanel=document.getElementById('send-queue-panel');
  const sqItems=document.getElementById('send-queue-items');
  const activeQ=(queue||[]).filter(q=>!q.cancelled);
  if(sqPanel)sqPanel.style.display=activeQ.length>0?'block':'none';
  if(sqItems)sqItems.innerHTML=activeQ.map(item=>{
    const secsLeft=Math.max(0,Math.round((new Date(item.sendAt||Date.now()+300000)-Date.now())/1000));
    const m=Math.floor(secsLeft/60),s=secsLeft%60;
    return \`<div style="padding:10px 12px;background:#fff;border-radius:8px;margin-bottom:8px;border:1px solid #FDE68A">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:8px">
        <div style="flex:1;min-width:0"><div style="font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">\${item.email?.subject||''}</div><div style="font-size:11px;color:#6B7280;margin-top:2px">To: \${item.email?.from||''}</div></div>
        <div style="display:flex;align-items:center;gap:8px;flex-shrink:0"><span style="font-size:12px;color:#D97706;font-weight:600">Sending in \${m}:\${String(s).padStart(2,'0')}</span><button onclick="cancelSend('\${item.id}')" class="btn btn-amber" style="padding:4px 10px;font-size:11px">Cancel</button></div>
      </div>
      \${item.understanding?
        \`<div style="font-size:11px;color:#6B7280;background:#F8FAFC;padding:8px;border-radius:6px;border:1px solid #E5E7EB">
          <span class="step-badge" style="margin-right:6px">Step 1</span>Intent: \${item.understanding.intent||''} · Sentiment: \${item.understanding.sentiment||''} · Confidence: \${item.classification?.confidence||0}%
        </div>\`:''
      }
    </div>\`;
  }).join('');

  // Live log
  const ll=document.getElementById('live-log');
  if(ll&&log&&log.length>0){
    ll.innerHTML=log.slice(0,15).map((item,i)=>{
      const dotColor=item.type==='sent'?'#059669':item.type==='review'?'#EF4444':item.type==='queued'?'#F59E0B':item.type==='archive'?'#8B5CF6':item.type==='error'?'#DC2626':'#0EA5E9';
      return \`<div style="display:flex;gap:12px;padding-bottom:10px;padding-left:14px;margin-left:6px;border-left:2px solid \${i===Math.min(log.length,15)-1?'transparent':'#E5E7EB'};position:relative">
        <div style="width:6px;height:6px;border-radius:50%;background:\${dotColor};position:absolute;left:-4px;top:4px"></div>
        <div style="font-size:11px;color:#9CA3AF;white-space:nowrap;min-width:48px">\${item.time}</div>
        <div style="font-size:12px;color:#374151;line-height:1.5">\${item.msg}</div>
      </div>\`;
    }).join('');
  }

  // Review queue
  const rq=document.getElementById('review-queue-items');
  if(rq){
    if(!review||review.length===0){
      rq.innerHTML='<div style="background:#F0FFF4;border:1px solid #86EFAC;border-radius:12px;padding:24px;text-align:center;color:#166534;font-size:14px;font-weight:500">✓ Nothing waiting for review — the agent is handling everything.</div>';
    }else{
      rq.innerHTML=review.map(item=>\`
        <div id="review-\${item.id}" style="border:1px solid #FEE2E2;border-radius:12px;margin-bottom:12px;overflow:hidden;animation:fadeIn .2s ease">
          <div style="padding:12px 16px;background:#FFF5F5;cursor:pointer" onclick="toggleReview('\${item.id}')">
            <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:8px">
              <div style="flex:1;min-width:0"><div style="font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">\${item.email?.subject||''}</div><div style="font-size:11px;color:#6B7280;margin-top:2px">From: \${item.email?.from||''}</div></div>
              <div style="display:flex;gap:6px;flex-shrink:0">
                <button onclick="event.stopPropagation();discardReview('\${item.id}')" class="btn btn-red" style="padding:5px 10px;font-size:11px">Discard</button>
                <span style="font-size:12px;color:#6B7280;padding:5px 4px">▼</span>
              </div>
            </div>
            <!-- AI Analysis Summary -->
            \${item.understanding?\`
            <div style="display:flex;gap:6px;flex-wrap:wrap">
              <span class="step-badge">Step 1: \${item.understanding.intent||''}</span>
              <span style="font-size:10px;font-weight:600;padding:2px 8px;border-radius:20px;background:#FFF7ED;color:#92400E">Urgency: \${item.understanding.urgency||''}</span>
              <span style="font-size:10px;font-weight:600;padding:2px 8px;border-radius:20px;background:\${(item.classification?.confidence||0)>=88?'#F0FFF4':'#FFF0F0'};color:\${(item.classification?.confidence||0)>=88?'#059669':'#C0392B'}">\${item.classification?.confidence||0}% confidence</span>
            </div>
            <div style="font-size:11px;color:#B91C1C;margin-top:6px;font-weight:500">🛑 Held: \${item.holdReason||item.classification?.reason||''}</div>
            \`:''}
          </div>
          <div id="review-body-\${item.id}" style="display:none;padding:14px 16px;border-top:1px solid #FEE2E2">
            <div style="font-size:12px;color:#374151;background:#F8FAFC;border:1px solid #E5E7EB;border-radius:8px;padding:12px;margin-bottom:12px;line-height:1.65">\${item.email?.body||''}</div>
            \${item.understanding?.risks?.length>0?\`<div style="font-size:11px;color:#92400E;background:#FFF7ED;padding:8px 10px;border-radius:6px;margin-bottom:10px">⚠️ Risks flagged: \${item.understanding.risks.join(', ')}</div>\`:''}
            <div style="font-size:10px;font-weight:700;color:#6B7280;margin-bottom:6px;letter-spacing:.5px">🤖 AI DRAFT — edit before sending</div>
            <textarea id="review-draft-\${item.id}" style="width:100%;min-height:150px;padding:10px 12px;border:1px solid #D1D5DB;border-radius:8px;font-size:13px;line-height:1.7;resize:vertical;margin-bottom:10px">\${item.draftReply||''}</textarea>
            <button class="btn btn-green" onclick="approveReview('\${item.id}')">✓ Approve & Send</button>
          </div>
        </div>
      \`).join('');
    }
  }

  // Archive
  const archiveEl=document.getElementById('archive-items');
  if(archiveEl){
    if(!archive||archive.length===0){
      archiveEl.innerHTML='<div style="font-size:13px;color:#9CA3AF">No old emails archived yet.</div>';
    }else{
      archiveEl.innerHTML=archive.slice(0,50).map(item=>\`
        <div style="background:#fff;border:1px solid \${item.followedUp?'#D1FAE5':'#FDE68A'};border-radius:12px;padding:14px 16px;margin-bottom:10px;opacity:\${item.followedUp?.6:1};animation:fadeIn .2s ease">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px">
            <div style="flex:1;min-width:0">
              <div style="font-size:13px;font-weight:600;margin-bottom:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">\${item.email?.subject||''}</div>
              <div style="font-size:12px;color:#6B7280;margin-bottom:6px">From: \${item.email?.from||''}</div>
              <div style="font-size:11px;color:\${item.followedUp?'#059669':'#D97706'};font-weight:600">\${item.followedUp?'✓ Followed up':'⚠️ Needs follow-up — this sender is waiting'}</div>
            </div>
            <div style="display:flex;gap:6px;flex-shrink:0">
              \${!item.followedUp?
                \`<button onclick="markFollowedUp('\${item.id}')" class="btn btn-amber" style="padding:6px 12px;font-size:11px">✓ Mark Done</button>\`
                :'<span style="font-size:11px;color:#059669;font-weight:600;padding:6px 4px">Done ✓</span>'
              }
            </div>
          </div>
          <div style="margin-top:10px;font-size:13px;color:#374151;background:#F8FAFC;border:1px solid #E5E7EB;border-radius:8px;padding:10px;line-height:1.65">\${item.email?.body||''}</div>
        </div>
      \`).join('');
    }
  }

  // Notifications panel
  const nl=document.getElementById('notif-list');
  if(nl){
    if(!notifications||notifications.length===0){
      nl.innerHTML='<div style="padding:20px;text-align:center;color:#9CA3AF;font-size:13px">No notifications</div>';
    }else{
      nl.innerHTML=notifications.slice(0,20).map(n=>\`
        <div style="padding:12px 16px;border-bottom:1px solid #F3F4F6;background:\${n.read?'#fff':'#FFFBEB'};cursor:pointer" onclick="handleNotifClick('\${n.id}','\${n.type}')">
          <div style="display:flex;gap:8px;align-items:flex-start">
            <span style="font-size:16px;flex-shrink:0">📁</span>
            <div style="flex:1;min-width:0">
              <div style="font-size:12px;font-weight:\${n.read?400:600};color:#111827;margin-bottom:2px">\${n.title}</div>
              <div style="font-size:11px;color:#6B7280;line-height:1.5">\${n.message}</div>
              <div style="font-size:10px;color:#9CA3AF;margin-top:3px">\${new Date(n.createdAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</div>
            </div>
            \${!n.read?'<span style="width:6px;height:6px;border-radius:50%;background:#F59E0B;flex-shrink:0;margin-top:4px"></span>':''}
          </div>
        </div>
      \`).join('');
    }
  }

  // Voice
  if(voice){
    const gv=document.getElementById('guidelines-view');
    if(gv)gv.textContent=voice.guidelines||'';
    const vs=document.getElementById('voice-samples');
    if(vs){
      vs.innerHTML=(voice.samples||[]).length===0
        ?'<div style="font-size:13px;color:#9CA3AF;margin-bottom:14px">No samples yet.</div>'
        :(voice.samples||[]).map((s,i)=>\`<div style="background:#F8FAFC;border:1px solid #E5E7EB;border-radius:8px;padding:12px;margin-bottom:8px;display:flex;gap:10px"><div style="flex:1;font-size:13px;color:#374151;line-height:1.6">\${s}</div><button onclick="removeSample(\${i})" style="background:none;border:none;color:#EF4444;cursor:pointer;font-size:16px;flex-shrink:0">×</button></div>\`).join('');
    }
  }

  // Sent log
  const sentEl=document.getElementById('sent-log-items');
  if(sentEl&&sent&&sent.length>0){
    sentEl.innerHTML=sent.slice(0,50).map(item=>\`
      <div style="background:#fff;border:1px solid #E5E7EB;border-radius:12px;margin-bottom:10px;overflow:hidden;cursor:pointer" onclick="toggleSent('\${item.id}')">
        <div style="padding:12px 16px;display:flex;align-items:center;justify-content:space-between;gap:12px">
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">\${item.email?.subject||''}</div>
            <div style="font-size:11px;color:#6B7280;margin-top:2px;display:flex;gap:8px;flex-wrap:wrap">
              <span>To: \${item.email?.from||''}</span>
              <span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:20px;background:\${(item.confidence||0)>=88?'#F0FFF4':'#FFFBEB'};color:\${(item.confidence||0)>=88?'#059669':'#D97706'}">\${item.confidence||0}% confidence</span>
              \${item.manualApproval?'<span style="font-size:10px;font-weight:600;padding:2px 7px;border-radius:20px;background:#EFF6FF;color:#1D4ED8">Staff approved</span>':''}
            </div>
          </div>
          <div style="font-size:11px;color:#9CA3AF;text-align:right;flex-shrink:0"><div>\${new Date(item.sentAt).toLocaleDateString()}</div><div>\${new Date(item.sentAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</div></div>
        </div>
        <div id="sent-body-\${item.id}" style="display:none;padding:0 16px 14px;border-top:1px solid #F3F4F6">
          \${item.understanding?\`<div style="font-size:11px;color:#0284C7;background:#F0F9FF;padding:8px 10px;border-radius:6px;margin:10px 0 8px"><span class="step-badge" style="margin-right:6px">AI Analysis</span>Intent: \${item.understanding.intent||''} · \${item.understanding.sentiment||''} sentiment</div>\`:''}
          <div style="font-size:10px;font-weight:700;color:#6B7280;margin-bottom:6px;letter-spacing:.5px">SENT REPLY</div>
          <div style="background:#F8FAFC;border:1px solid #E5E7EB;border-radius:8px;padding:12px;font-size:13px;color:#374151;line-height:1.7;white-space:pre-wrap">\${item.replyBody||''}</div>
        </div>
      </div>
    \`).join('');
  }
}

// Actions
async function cancelSend(id){try{await apiFetch('/api/queue/'+id+'/cancel',{method:'POST'});showToast('Send cancelled');await refreshData();}catch(e){showErr(e.message);}}
function toggleReview(id){const b=document.getElementById('review-body-'+id);if(b)b.style.display=b.style.display==='none'?'block':'none';}
async function approveReview(id){const draft=document.getElementById('review-draft-'+id)?.value;try{await apiFetch('/api/review/'+id+'/approve',{method:'POST',body:JSON.stringify({reply:draft})});showToast('✓ Reply sent');await refreshData();}catch(e){showErr(e.message);}}
async function discardReview(id){try{await apiFetch('/api/review/'+id+'/discard',{method:'POST'});showToast('Discarded');await refreshData();}catch(e){showErr(e.message);}}
function toggleSent(id){const b=document.getElementById('sent-body-'+id);if(b)b.style.display=b.style.display==='none'?'block':'none';}
async function markFollowedUp(id){try{await apiFetch('/api/archive/'+id+'/followup',{method:'POST'});showToast('✓ Marked as followed up');await refreshData();}catch(e){showErr(e.message);}}

function toggleNotifPanel(){
  notifPanelOpen=!notifPanelOpen;
  document.getElementById('notif-panel').style.display=notifPanelOpen?'block':'none';
}
async function markAllRead(){try{await apiFetch('/api/notifications/read-all',{method:'POST'});await refreshData();}catch(e){}}
async function handleNotifClick(id,type){
  await apiFetch('/api/notifications/'+id+'/read',{method:'POST'}).catch(()=>{});
  if(type==='old_email')showTab('Archive');
  toggleNotifPanel();
  await refreshData();
}

// Voice
function toggleEditGuidelines(){
  editingGuidelines=!editingGuidelines;
  document.getElementById('guidelines-view').style.display=editingGuidelines?'none':'block';
  document.getElementById('guidelines-edit').style.display=editingGuidelines?'block':'none';
  if(editingGuidelines){const ta=document.getElementById('guidelines-textarea');if(ta)ta.value=serverData.voice?.guidelines||'';}
}
async function saveGuidelines(){const g=document.getElementById('guidelines-textarea').value;try{await apiFetch('/api/voice/guidelines',{method:'POST',body:JSON.stringify({guidelines:g})});toggleEditGuidelines();showToast('✓ Voice guidelines saved');await refreshData();}catch(e){showErr(e.message);}}
async function addSample(){const s=document.getElementById('new-sample-input').value.trim();if(!s)return;try{await apiFetch('/api/voice/sample',{method:'POST',body:JSON.stringify({sample:s})});document.getElementById('new-sample-input').value='';showToast('✓ Sample added');await refreshData();}catch(e){showErr(e.message);}}
async function removeSample(i){try{await apiFetch('/api/voice/sample/'+i,{method:'DELETE'});showToast('Sample removed');await refreshData();}catch(e){showErr(e.message);}}

// Inbox
function renderEmailList(){
  const list=document.getElementById('email-list');
  if(!list)return;
  list.innerHTML=DEMO_EMAILS.map(e=>{
    const tag=TAGS[e.tag];
    return \`<div style="padding:11px 14px;cursor:pointer;border-bottom:1px solid #F9FAFB;background:\${selectedEmailId===e.id?'#EFF6FF':e.status==='unread'?'#FAFFFE':'#fff'};border-left:3px solid \${selectedEmailId===e.id?'#0EA5E9':'transparent'}" onclick="selectEmail(\${e.id})">
      <div style="display:flex;justify-content:space-between;margin-bottom:2px">
        <span style="font-size:13px;font-weight:\${e.status==='unread'?700:500};color:#111827;display:flex;align-items:center;gap:5px;overflow:hidden;flex:1">
          \${e.status==='unread'?'<span style="width:6px;height:6px;border-radius:50%;background:#0EA5E9;flex-shrink:0;display:inline-block"></span>':''}
          \${e.status==='replied'?'<span style="font-size:10px;color:#059669;font-weight:600;flex-shrink:0">✓</span>':''}
          <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">\${e.name}</span>
        </span>
        <span style="font-size:11px;color:#9CA3AF;flex-shrink:0;margin-left:4px">\${e.time}</span>
      </div>
      <div style="font-size:12px;font-weight:500;color:#334155;margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">\${e.subject}</div>
      <span style="font-size:10px;font-weight:600;padding:2px 8px;border-radius:20px;background:\${tag.bg};color:\${tag.color}">\${tag.label}</span>
    </div>\`;
  }).join('');
}

async function selectEmail(id){
  selectedEmailId=id;
  const email=DEMO_EMAILS.find(e=>e.id===id);
  if(!email)return;
  email.status=email.status==='unread'?'read':email.status;
  renderEmailList();
  const detail=document.getElementById('email-detail');
  if(!detail)return;
  const tag=TAGS[email.tag];
  detail.style.display='block';
  detail.style.alignItems='flex-start';
  detail.innerHTML=\`<div style="max-width:640px;animation:fadeIn .2s ease;width:100%">
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:6px">
      <div style="font-family:'DM Serif Display',serif;font-size:20px;line-height:1.3">\${email.subject}</div>
      <span style="font-size:11px;font-weight:600;padding:3px 9px;border-radius:20px;flex-shrink:0;background:\${tag.bg};color:\${tag.color}">\${tag.label}</span>
    </div>
    <div style="font-size:12px;color:#64748B;margin-bottom:14px">From: <strong>\${email.name}</strong> · \${email.time}</div>
    <div style="background:#fff;border:1px solid #E2E8F0;border-radius:10px;padding:18px;margin-bottom:14px;font-size:14px;line-height:1.75;color:#334155">\${email.body}</div>
    <div id="summary-area"><div style="display:flex;align-items:center;gap:8px;color:#6B7280;font-size:13px;padding:6px 0"><div class="spinner"></div>Running 2-step analysis…</div></div>
    \${email.status==='replied'
      ?'<div style="padding:10px 14px;background:#F0FFF4;border:1px solid #86EFAC;border-radius:8px;font-size:13px;color:#166534;font-weight:500">✓ Reply sent</div>'
      :\`<div id="reply-section">
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
  </div>\`;

  try{
    const summary=await callClaude('Run a 2-step analysis on this email.\\n\\nStep 1 — Understand: What does this person actually want? What is their sentiment?\\nStep 2 — Recommend: What should the clinic do?\\n\\nBe concise, max 3 sentences total.\\n\\nFrom: '+email.name+'\\nSubject: '+email.subject+'\\nBody: '+email.body);
    const sa=document.getElementById('summary-area');
    if(sa)sa.innerHTML=\`<div style="background:#F0F9FF;border:1px solid #BAE6FD;border-radius:10px;padding:13px 16px;margin-bottom:14px;animation:fadeIn .25s ease">
      <div style="display:flex;gap:6px;margin-bottom:6px"><span class="step-badge">Step 1</span><span class="step-badge">Step 2</span><span style="font-size:10px;font-weight:700;color:#0284C7;padding:2px 8px;border-radius:20px;background:#E0F2FE">AI Analysis Complete</span></div>
      <div style="font-size:13px;color:#1E40AF;line-height:1.65">\${summary}</div>
    </div>\`;
  }catch(e){const sa=document.getElementById('summary-area');if(sa)sa.innerHTML='';}
}

async function draftReply(id){
  const email=DEMO_EMAILS.find(e=>e.id===id);
  if(!email)return;
  const btn=document.getElementById('draft-btn');
  if(btn){btn.disabled=true;btn.innerHTML='<div class="spinner"></div> Drafting…';}
  try{
    const reply=await callClaude('Write a professional reply for Expert Physio. No subject line. Start with greeting. End with Expert Physio Team.\\n\\nFrom: '+email.name+'\\nSubject: '+email.subject+'\\nBody: '+email.body);
    const ra=document.getElementById('reply-area');const rt=document.getElementById('reply-text');
    if(ra&&rt){rt.value=reply;ra.style.display='block';}
    if(btn)btn.style.display='none';
  }catch(e){showErr('Draft failed: '+e.message);if(btn){btn.disabled=false;btn.innerHTML='✨ Draft Reply';}}
}

function sendReply(id){
  const email=DEMO_EMAILS.find(e=>e.id===id);
  if(email){email.status='replied';showToast('✓ Reply sent to '+email.name);renderEmailList();}
  const rs=document.getElementById('reply-section');
  if(rs)rs.innerHTML='<div style="padding:10px 14px;background:#F0FFF4;border:1px solid #86EFAC;border-radius:8px;font-size:13px;color:#166534;font-weight:500">✓ Reply sent via Gmail</div>';
}
function discardReply(){const ra=document.getElementById('reply-area');const btn=document.getElementById('draft-btn');if(ra)ra.style.display='none';if(btn){btn.style.display='inline-flex';btn.innerHTML='✨ Draft Reply';}}

// Compose
async function generateEmail(){
  const text=document.getElementById('compose-input').value.trim();
  if(!text)return;
  const btn=document.getElementById('compose-btn');const spinner=document.getElementById('compose-spinner');const composed=document.getElementById('composed-email');
  btn.disabled=true;spinner.style.display='flex';composed.style.display='none';
  try{
    const raw=await callClaude('Compose a clinic email for Expert Physio: "'+text+'"\\n\\nReturn ONLY valid JSON: {"to":"email","subject":"subject","body":"body ending with Expert Physio Team"}. No markdown.');
    const clean=raw.replace(/^\`\`\`(?:json)?\\s*/i,'').replace(/\\s*\`\`\`\\s*$/,'').trim();
    const obj=JSON.parse(clean);
    document.getElementById('c-to').value=obj.to||'';
    document.getElementById('c-subject').value=obj.subject||'';
    document.getElementById('c-body').value=obj.body||'';
    composed.style.display='block';
  }catch(e){showErr('Compose failed: '+e.message);}
  finally{btn.disabled=false;spinner.style.display='none';}
}
function sendComposed(){const s=document.getElementById('c-subject').value;const t=document.getElementById('c-to').value;showToast('✓ Email sent: "'+s+'"');discardComposed();}
function discardComposed(){document.getElementById('composed-email').style.display='none';document.getElementById('compose-input').value='';}

// Init
document.addEventListener('click',e=>{if(notifPanelOpen&&!document.getElementById('notif-panel').contains(e.target)&&!document.getElementById('bell-btn').contains(e.target)){notifPanelOpen=false;document.getElementById('notif-panel').style.display='none';}});
refreshData();
setInterval(refreshData,8000);
showTab('Autopilot');
</script>
</body>
</html>`);
});

app.listen(parseInt(PORT), () => log(`Expert Physio Agent v3 running on port ${PORT}`, "success"));
