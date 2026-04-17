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

// ─── CRM — PAST CUSTOMER FOLLOW-UP ───────────────────────────────────────────
/*
  Every person the agent has ever communicated with gets a CRM record.
  The follow-up engine runs daily and:
  - Checks if any patient has gone silent (no reply in X days)
  - Generates a personalised re-engagement email
  - Queues it for review before sending
  - Marks patients as "lost" only if they explicitly say they've moved on
*/
let crmContacts = [];   // { id, email, name, lastSeen, lastSubject, touchCount, status, notes, followUpScheduled }

const CRM_STATUSES = {
  ACTIVE:    "active",       // currently engaged
  SILENT:    "silent",       // no reply in 14+ days — needs follow-up
  FOLLOWUP:  "followup",     // follow-up sent, waiting for response
  BOOKED:    "booked",       // confirmed appointment
  LOST:      "lost",         // explicitly said they found another solution
  OPTED_OUT: "opted_out",    // asked not to be contacted
};

const FOLLOW_UP_DAYS = 14;   // days of silence before follow-up triggers

function upsertCRMContact(email, name, subject) {
  const existing = crmContacts.find(c => c.email.toLowerCase() === email.toLowerCase());
  if (existing) {
    existing.lastSeen      = new Date().toISOString();
    existing.lastSubject   = subject;
    existing.touchCount    = (existing.touchCount || 0) + 1;
    if (existing.status === CRM_STATUSES.SILENT) existing.status = CRM_STATUSES.ACTIVE;
    return existing;
  }
  const contact = {
    id:                `crm_${Date.now()}_${Math.random().toString(36).slice(2,7)}`,
    email,
    name:              name || email.split("@")[0],
    firstSeen:         new Date().toISOString(),
    lastSeen:          new Date().toISOString(),
    lastSubject:       subject,
    touchCount:        1,
    status:            CRM_STATUSES.ACTIVE,
    notes:             "",
    followUpCount:     0,
    followUpScheduled: false,
    followUpSentAt:    null,
  };
  crmContacts.unshift(contact);
  if (crmContacts.length > 1000) crmContacts.pop();
  log(`CRM: New contact added — ${name || email}`, "info");
  return contact;
}

function detectLostSignal(emailBody) {
  const body = emailBody.toLowerCase();
  const lostPhrases = [
    "found another", "going with another", "decided on another",
    "found a different", "found someone else", "no longer need",
    "cancel my", "not interested anymore", "please remove",
    "don't contact", "stop emailing", "unsubscribe",
    "found a physio", "booked elsewhere", "going elsewhere",
  ];
  return lostPhrases.some(p => body.includes(p));
}

async function runFollowUpEngine() {
  if (!gmailTokens) return;
  const now = Date.now();
  const threshold = FOLLOW_UP_DAYS * 24 * 60 * 60 * 1000;

  const needsFollowUp = crmContacts.filter(c => {
    if (c.status === CRM_STATUSES.LOST)      return false;
    if (c.status === CRM_STATUSES.OPTED_OUT) return false;
    if (c.status === CRM_STATUSES.BOOKED)    return false;
    if (c.followUpCount >= 3)                return false; // max 3 follow-ups
    if (c.followUpScheduled)                 return false;
    const daysSilent = (now - new Date(c.lastSeen).getTime()) / threshold;
    return daysSilent >= 1;
  });

  if (needsFollowUp.length > 0) {
    log(`Follow-up engine: ${needsFollowUp.length} contact(s) need re-engagement`, "info");
  }

  for (const contact of needsFollowUp) {
    try {
      const daysSilent = Math.round((now - new Date(contact.lastSeen).getTime()) / (24*60*60*1000));
      const reEngageEmail = await generateReEngagementEmail(contact, daysSilent);

      // Hold ALL re-engagement emails for human review — never auto-send
      pendingReview.push({
        id:           `fu_${Date.now()}_${contact.id}`,
        emailId:      null,
        email:        { from: contact.email, subject: `Re-engagement: ${contact.name}`, body: `Follow-up for ${contact.name} — silent for ${daysSilent} days` },
        classification: { category: "follow-up", confidence: 95, reason: "Scheduled re-engagement" },
        draftReply:   reEngageEmail,
        holdReason:   `Re-engagement email — ${contact.name} silent for ${daysSilent} days`,
        isFollowUp:   true,
        contactId:    contact.id,
        receivedAt:   new Date().toISOString(),
      });

      contact.followUpScheduled = true;
      contact.status = CRM_STATUSES.FOLLOWUP;
      log(`Follow-up queued for review: ${contact.name} (${daysSilent} days silent)`, "review");
    } catch (err) {
      log(`Follow-up generation failed for ${contact.email}: ${err.message}`, "error");
    }
    await new Promise(r => setTimeout(r, 1000));
  }
}

async function generateReEngagementEmail(contact, daysSilent) {
  const voiceCtx = voiceProfile.samples.length > 0
    ? `\nApproved reply examples:\n${voiceProfile.samples.slice(0,2).join("\n---\n")}`
    : "";

  return await callAI(
    `Write a warm, non-pushy re-engagement email for a physiotherapy clinic.

Patient: ${contact.name}
Their last email was about: "${contact.lastSubject}"
Days since last contact: ${daysSilent}
Number of previous follow-ups: ${contact.followUpCount}

${contact.followUpCount === 0
  ? "This is the first follow-up. Be warm and check in genuinely."
  : contact.followUpCount === 1
  ? "This is the second follow-up. Be gentle, offer value, mention specific benefits."
  : "This is the final follow-up. Be gracious, leave the door open, no pressure."}

Voice guidelines:
${voiceProfile.guidelines}${voiceCtx}

Rules:
- Do NOT be pushy or salesy
- Do NOT offer discounts (they haven't asked)
- Reference their last topic naturally: "${contact.lastSubject}"
- Offer a clear, easy next step (reply, call, or book online)
- If this is the 3rd follow-up, end with "No worries if the timing isn't right — we're always here when you need us"
- Maximum 4 sentences
- Sign off as "Expert Physio Team"

Write ONLY the email body starting with greeting.`,
    "You write warm, human physiotherapy clinic follow-up emails. Never pushy. Always genuine."
  );
}

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

  // ── CRM: UPSERT CONTACT + DETECT LOST SIGNAL
  const senderName = (email.from.match(/^([^<]+)</) || [])[1]?.trim() || email.from.split("@")[0];
  const crmContact = upsertCRMContact(email.from, senderName, email.subject);
  if (detectLostSignal(email.body)) {
    crmContact.status = CRM_STATUSES.LOST;
    log(`CRM: ${senderName} marked as lost`, "info");
  }
  if (crmContact.status === CRM_STATUSES.OPTED_OUT) {
    log(`CRM: Skipping ${senderName} — opted out`, "info");
    await markRead(id);
    return;
  }
  if (crmContact.followUpScheduled) {
    crmContact.followUpScheduled = false;
    crmContact.status = CRM_STATUSES.ACTIVE;
    log(`CRM: ${senderName} responded to follow-up — back to active`, "info");
  }

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
  // Run follow-up engine once daily at startup and every 24 hours
  runFollowUpEngine();
  setInterval(runFollowUpEngine, 24 * 60 * 60 * 1000);
  log("Autopilot v3 started — 2-step review, CRM follow-up, old/new separation", "success");
}

// ─── API ROUTES ───────────────────────────────────────────────────────────────
app.get("/api/status", (req, res) => res.json({
  connected: !!gmailTokens,
  polling: !!pollingInterval,
  queueCount: sendQueue.filter(q => !q.cancelled).length,
  reviewCount: pendingReview.length,
  archiveCount: archiveEmails.length,
  crmTotal: crmContacts.length,
  crmSilent: crmContacts.filter(c => c.status === CRM_STATUSES.SILENT || (Date.now() - new Date(c.lastSeen).getTime()) > FOLLOW_UP_DAYS * 24*60*60*1000 && c.status === CRM_STATUSES.ACTIVE).length,
  crmFollowUp: crmContacts.filter(c => c.status === CRM_STATUSES.FOLLOWUP).length,
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


// ─── CRM ROUTES ───────────────────────────────────────────────────────────────
app.get("/api/crm", (req, res) => res.json(crmContacts.slice(0, 200)));

app.get("/api/crm/stats", (req, res) => {
  const now = Date.now();
  const threshold = FOLLOW_UP_DAYS * 24 * 60 * 60 * 1000;
  res.json({
    total:     crmContacts.length,
    active:    crmContacts.filter(c => c.status === CRM_STATUSES.ACTIVE).length,
    silent:    crmContacts.filter(c => (now - new Date(c.lastSeen).getTime()) > threshold && c.status !== CRM_STATUSES.LOST && c.status !== CRM_STATUSES.OPTED_OUT).length,
    followUp:  crmContacts.filter(c => c.status === CRM_STATUSES.FOLLOWUP).length,
    booked:    crmContacts.filter(c => c.status === CRM_STATUSES.BOOKED).length,
    lost:      crmContacts.filter(c => c.status === CRM_STATUSES.LOST).length,
    optedOut:  crmContacts.filter(c => c.status === CRM_STATUSES.OPTED_OUT).length,
  });
});

app.post("/api/crm", (req, res) => {
  const { email, name, notes } = req.body;
  if (!email) return res.status(400).json({ error: "Email required" });
  const contact = upsertCRMContact(email, name || email.split("@")[0], "Manually added");
  if (notes) contact.notes = notes;
  res.json({ success: true, contact });
});

app.patch("/api/crm/:id", (req, res) => {
  const contact = crmContacts.find(c => c.id === req.params.id);
  if (!contact) return res.status(404).json({ error: "Not found" });
  const { status, notes, name } = req.body;
  if (status) contact.status = status;
  if (notes !== undefined) contact.notes = notes;
  if (name)  contact.name  = name;
  log(`CRM: Updated ${contact.name} — status: ${contact.status}`, "info");
  res.json({ success: true, contact });
});

app.post("/api/crm/followup-now", async (req, res) => {
  await runFollowUpEngine();
  res.json({ success: true, message: "Follow-up engine triggered" });
});

// ─── DASHBOARD v3 — EXPERT PHYSIO LUXURY CLINICAL DESIGN ─────────────────────
app.get("*", (req, res) => {
  const connected = !!gmailTokens;
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>Expert Physio — AI Agent</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,500;0,600;1,300;1,400&family=Outfit:wght@300;400;500;600&display=swap" rel="stylesheet">
  <style>
    :root {
      --sage:       #6B8C6E;
      --sage-lt:    #A8C5A0;
      --sage-pale:  #EEF4EE;
      --sage-deep:  #3D5C40;
      --cream:      #FAF8F5;
      --warm-white: #FFFFFF;
      --stone:      #8C8479;
      --stone-lt:   #C4BDB4;
      --charcoal:   #2C2C2C;
      --text:       #3A3730;
      --text-muted: #7A7570;
      --border:     #E8E2DA;
      --border-lt:  #F2EDE8;
      --amber:      #C4913A;
      --amber-lt:   #F5E8D0;
      --red-soft:   #C4604A;
      --red-lt:     #F5E8E4;
      --blue-soft:  #4A7AB5;
      --blue-lt:    #E4EEF8;
      --shadow-sm:  0 2px 8px rgba(44,44,44,0.06);
      --shadow-md:  0 4px 20px rgba(44,44,44,0.10);
      --shadow-lg:  0 8px 40px rgba(44,44,44,0.14);
      --radius:     14px;
      --radius-sm:  8px;
    }
    *{box-sizing:border-box;margin:0;padding:0}
    html,body{height:100%;overflow:hidden}
    body{font-family:'Outfit',sans-serif;background:var(--cream);color:var(--text);display:flex;flex-direction:column}

    /* Animations */
    @keyframes spin{to{transform:rotate(360deg)}}
    @keyframes fadeUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}
    @keyframes fadeIn{from{opacity:0}to{opacity:1}}
    @keyframes slideRight{from{opacity:0;transform:translateX(-12px)}to{opacity:1;transform:none}}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
    @keyframes shimmer{0%{background-position:200% center}100%{background-position:-200% center}}
    @keyframes bellRing{0%,100%{transform:rotate(0)}15%{transform:rotate(-20deg)}30%{transform:rotate(20deg)}45%{transform:rotate(-15deg)}60%{transform:rotate(15deg)}75%{transform:rotate(-8deg)}}
    @keyframes introFade{0%{opacity:0;transform:scale(1.02)}100%{opacity:1;transform:scale(1)}}

    /* Scrollbar */
    ::-webkit-scrollbar{width:3px}
    ::-webkit-scrollbar-thumb{background:var(--stone-lt);border-radius:3px}

    /* Typography */
    .serif{font-family:'Cormorant Garamond',serif}
    .page-title{font-family:'Cormorant Garamond',serif;font-size:26px;font-weight:500;color:var(--charcoal);letter-spacing:-0.3px;line-height:1.2}
    .page-sub{font-size:13px;color:var(--text-muted);margin-top:4px;font-weight:300;line-height:1.6}

    /* Buttons */
    .btn{display:inline-flex;align-items:center;gap:7px;padding:9px 18px;border:none;border-radius:var(--radius-sm);cursor:pointer;font-size:12.5px;font-weight:500;font-family:'Outfit',sans-serif;transition:all .2s;letter-spacing:.01em}
    .btn:disabled{opacity:.45;cursor:not-allowed}
    .btn-primary{background:var(--sage);color:#fff;box-shadow:var(--shadow-sm)}
    .btn-primary:hover:not(:disabled){background:var(--sage-deep);box-shadow:var(--shadow-md);transform:translateY(-1px)}
    .btn-success{background:var(--sage-deep);color:#fff;box-shadow:var(--shadow-sm)}
    .btn-success:hover:not(:disabled){background:#2D4830;box-shadow:var(--shadow-md);transform:translateY(-1px)}
    .btn-ghost{background:transparent;color:var(--text-muted);border:1px solid var(--border)}
    .btn-ghost:hover:not(:disabled){background:var(--border-lt);color:var(--text)}
    .btn-amber{background:var(--amber-lt);color:var(--amber);border:1px solid #E8D0A8}
    .btn-danger{background:var(--red-lt);color:var(--red-soft)}
    .btn-sm{padding:6px 12px;font-size:11.5px}

    /* Cards */
    .card{background:var(--warm-white);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow-sm);padding:22px}
    .card-tight{padding:16px}

    /* Tags / Badges */
    .tag{font-size:10px;font-weight:600;padding:3px 9px;border-radius:20px;letter-spacing:.03em;display:inline-block}
    .badge{border-radius:20px;font-size:10px;font-weight:600;padding:1px 6px;color:#fff;display:none}

    /* Sidebar */
    .tab-btn{width:100%;padding:10px 18px;background:transparent;border:none;border-left:2px solid transparent;cursor:pointer;text-align:left;font-size:13px;font-weight:400;color:var(--text-muted);display:flex;align-items:center;justify-content:space-between;transition:all .15s;font-family:'Outfit',sans-serif}
    .tab-btn .tab-icon{font-size:14px;margin-right:8px;opacity:.7}
    .tab-btn.active{background:linear-gradient(90deg,var(--sage-pale),transparent);border-left-color:var(--sage);font-weight:600;color:var(--sage-deep)}
    .tab-btn.active .tab-icon{opacity:1}
    .tab-btn:hover:not(.active){background:var(--border-lt);color:var(--text)}

    /* Input/Textarea */
    input,textarea{font-family:'Outfit',sans-serif;color:var(--text);background:var(--warm-white);border:1px solid var(--border);border-radius:var(--radius-sm);font-size:13px}
    input:focus,textarea:focus{outline:none;border-color:var(--sage);box-shadow:0 0 0 3px rgba(107,140,110,0.12)}

    /* Spinner */
    .spinner{width:14px;height:14px;border-radius:50%;border:2px solid var(--border);border-top-color:var(--sage);animation:spin .7s linear infinite;flex-shrink:0}

    /* Toast */
    #toast{position:fixed;top:20px;right:20px;z-index:9999;background:var(--charcoal);color:#fff;padding:12px 20px;border-radius:var(--radius);font-size:13px;font-weight:500;box-shadow:var(--shadow-lg);display:none;align-items:center;gap:12px;max-width:380px;animation:fadeUp .3s ease}

    /* Notification panel */
    #notif-panel{position:fixed;top:64px;right:16px;width:360px;background:var(--warm-white);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow-lg);z-index:500;display:none;max-height:480px;overflow-y:auto}

    /* Email row */
    .email-row{padding:13px 16px;cursor:pointer;border-bottom:1px solid var(--border-lt);border-left:2px solid transparent;transition:all .12s}
    .email-row:hover{background:var(--sage-pale)}
    .email-row.selected{background:var(--sage-pale);border-left-color:var(--sage)}
    .email-row.unread{background:#FAFFF9}

    /* Status dot */
    .status-dot{width:7px;height:7px;border-radius:50%;display:inline-block;flex-shrink:0}

    /* Rule row */
    .rule-row{display:flex;align-items:center;justify-content:space-between;padding:11px 0;border-bottom:1px solid var(--border-lt)}
    .rule-row:last-child{border-bottom:none}

    /* Step badge */
    .step-badge{font-size:10px;font-weight:600;padding:2px 8px;border-radius:20px;background:var(--blue-lt);color:var(--blue-soft);display:inline-block}

    /* Intro overlay */
    #intro{position:fixed;inset:0;z-index:1000;background:var(--cream);display:flex;flex-direction:column;animation:introFade .6s ease}
    #intro.hidden{display:none}

    /* Shimmer loading */
    .shimmer{background:linear-gradient(90deg,var(--border-lt) 25%,var(--border) 50%,var(--border-lt) 75%);background-size:400% 100%;animation:shimmer 1.5s infinite;border-radius:4px}
  </style>
</head>
<body>

<!-- ── INTRO SCREEN ─────────────────────────────────────────────────────────── -->
<div id="intro">
  <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px;text-align:center">

    <!-- Logo mark -->
    <div style="position:relative;margin-bottom:32px">
      <div style="width:88px;height:88px;border-radius:24px;background:linear-gradient(135deg,var(--sage-deep),var(--sage));display:flex;align-items:center;justify-content:center;box-shadow:var(--shadow-lg);animation:fadeUp .5s ease .1s both">
        <svg width="44" height="44" viewBox="0 0 44 44" fill="none">
          <path d="M22 8C22 8 12 14 12 22C12 30 22 36 22 36C22 36 32 30 32 22C32 14 22 8 22 8Z" stroke="white" stroke-width="2" fill="none" stroke-linecap="round"/>
          <path d="M16 22H28M22 16V28" stroke="white" stroke-width="2.5" stroke-linecap="round"/>
        </svg>
      </div>
      <div style="position:absolute;bottom:-4px;right:-4px;width:22px;height:22px;border-radius:50%;background:var(--amber);display:flex;align-items:center;justify-content:center;animation:fadeUp .5s ease .3s both;box-shadow:0 2px 8px rgba(196,145,58,.4)">
        <svg width="11" height="11" viewBox="0 0 11 11" fill="white"><path d="M5.5 1L6.8 4H10L7.5 6.2L8.4 9.5L5.5 7.8L2.6 9.5L3.5 6.2L1 4H4.2L5.5 1Z" fill="white"/></svg>
      </div>
    </div>

    <!-- Brand -->
    <div style="animation:fadeUp .5s ease .2s both">
      <div style="font-family:'Cormorant Garamond',serif;font-size:38px;font-weight:500;color:var(--charcoal);letter-spacing:-0.5px;line-height:1.1">Expert Physio</div>
      <div style="font-size:13px;color:var(--sage);font-weight:600;letter-spacing:.12em;text-transform:uppercase;margin-top:4px">AI Agent — v3</div>
    </div>

    <!-- Tagline -->
    <div style="margin-top:20px;max-width:420px;animation:fadeUp .5s ease .35s both">
      <div style="font-family:'Cormorant Garamond',serif;font-size:20px;color:var(--text-muted);font-weight:300;font-style:italic;line-height:1.6">
        "Automating every email, following up every lead, and protecting every patient relationship — so your team can focus on what they do best."
      </div>
    </div>

    <!-- Feature pills -->
    <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center;margin-top:28px;animation:fadeUp .5s ease .45s both">
      ${["2-Step AI Review","Gmail Autopilot","Patient CRM","Lead Follow-Up","Voice Profile","Sent Log"].map(f =>
        "<span style='font-size:11.5px;font-weight:500;padding:5px 13px;border-radius:20px;background:var(--warm-white);border:1px solid var(--border);color:var(--text-muted);box-shadow:var(--shadow-sm)'>" + f + "</span>"
      ).join("")}
    </div>

    <!-- Status -->
    <div style="margin-top:32px;animation:fadeUp .5s ease .5s both">
      <div style="display:inline-flex;align-items:center;gap:8px;padding:10px 20px;border-radius:30px;background:var(--warm-white);border:1px solid var(--border);box-shadow:var(--shadow-sm);font-size:13px">
        <span class="status-dot" style="background:${connected?"#6B8C6E":"#C4604A"};${connected?"animation:pulse 2s infinite":""}"></span>
        <span style="color:var(--text);font-weight:500">${connected ? "Gmail connected — Autopilot active" : "Gmail not connected"}</span>
      </div>
    </div>

    <!-- Enter button -->
    <button onclick="dismissIntro()" style="margin-top:28px;padding:14px 40px;background:var(--sage-deep);color:#fff;border:none;border-radius:var(--radius);cursor:pointer;font-family:'Outfit',sans-serif;font-size:14px;font-weight:500;letter-spacing:.03em;box-shadow:var(--shadow-md);transition:all .2s;animation:fadeUp .5s ease .6s both" onmouseover="this.style.transform='translateY(-2px)';this.style.boxShadow='0 8px 32px rgba(44,44,44,.18)'" onmouseout="this.style.transform='none';this.style.boxShadow='var(--shadow-md)'">
      Open Dashboard →
    </button>

    ${!connected ? `
    <a href="/auth/login" style="display:inline-block;margin-top:12px;font-size:12.5px;color:var(--sage);text-decoration:none;font-weight:500;animation:fadeUp .5s ease .7s both">
      Connect Gmail first →
    </a>` : ""}
  </div>

  <!-- Footer -->
  <div style="padding:20px;text-align:center;border-top:1px solid var(--border-lt)">
    <div style="font-size:11.5px;color:var(--stone-lt)">Built for Expert Physio · Burnaby, BC · Powered by Claude AI</div>
  </div>
</div>

<!-- ── TOAST ────────────────────────────────────────────────────────────────── -->
<div id="toast"><span id="toast-msg"></span><button onclick="hideToast()" style="background:none;border:none;color:rgba(255,255,255,.5);cursor:pointer;font-size:18px;line-height:1;padding:0">×</button></div>

<!-- ── NOTIFICATION PANEL ───────────────────────────────────────────────────── -->
<div id="notif-panel">
  <div style="padding:16px 18px;border-bottom:1px solid var(--border-lt);display:flex;align-items:center;justify-content:space-between">
    <div style="font-family:'Cormorant Garamond',serif;font-size:18px;font-weight:500">Notifications</div>
    <button onclick="markAllRead()" style="font-size:12px;color:var(--sage);background:none;border:none;cursor:pointer;font-weight:500;font-family:'Outfit',sans-serif">Mark all read</button>
  </div>
  <div id="notif-list"><div style="padding:24px;text-align:center;color:var(--stone-lt);font-size:13px">No notifications</div></div>
</div>

<!-- ── HEADER ───────────────────────────────────────────────────────────────── -->
<div style="background:var(--warm-white);border-bottom:1px solid var(--border);height:60px;display:flex;align-items:center;justify-content:space-between;padding:0 24px;flex-shrink:0;box-shadow:var(--shadow-sm)">
  <div style="display:flex;align-items:center;gap:12px">
    <button onclick="showIntro()" style="width:38px;height:38px;border-radius:10px;background:linear-gradient(135deg,var(--sage-deep),var(--sage));display:flex;align-items:center;justify-content:center;border:none;cursor:pointer;box-shadow:var(--shadow-sm);flex-shrink:0">
      <svg width="20" height="20" viewBox="0 0 44 44" fill="none"><path d="M22 8C22 8 12 14 12 22C12 30 22 36 22 36C22 36 32 30 32 22C32 14 22 8 22 8Z" stroke="white" stroke-width="2" fill="none" stroke-linecap="round"/><path d="M16 22H28M22 16V28" stroke="white" stroke-width="2.5" stroke-linecap="round"/></svg>
    </button>
    <div>
      <div style="font-family:'Cormorant Garamond',serif;font-size:17px;font-weight:500;color:var(--charcoal);letter-spacing:-.2px;line-height:1.1">Expert Physio <span style="font-weight:300;font-style:italic">AI Agent</span></div>
      <div id="status-line" style="font-size:10.5px;font-weight:500;letter-spacing:.03em;display:flex;align-items:center;gap:5px;margin-top:1px">
        <span class="status-dot" id="status-dot" style="background:var(--red-soft)"></span>
        <span id="status-text" style="color:var(--text-muted)">Gmail not connected</span>
      </div>
    </div>
  </div>
  <div style="display:flex;gap:10px;align-items:center">
    <div id="header-badges" style="display:flex;gap:8px;align-items:center"></div>
    <button id="bell-btn" onclick="toggleNotifPanel()" style="position:relative;background:none;border:none;cursor:pointer;padding:6px;color:var(--stone);font-size:19px;line-height:1">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
      <span id="bell-badge" class="badge" style="position:absolute;top:-2px;right:-2px;background:var(--red-soft)"></span>
    </button>
    <div id="connect-btn-area"></div>
  </div>
</div>

<!-- ── BODY ─────────────────────────────────────────────────────────────────── -->
<div style="display:flex;flex:1;overflow:hidden">

  <!-- SIDEBAR -->
  <div style="width:212px;background:var(--warm-white);border-right:1px solid var(--border);display:flex;flex-direction:column;flex-shrink:0">
    <div style="padding:16px 0 8px;flex:1">
      <button class="tab-btn" id="tab-Autopilot" onclick="showTab('Autopilot')"><span><span class="tab-icon">⚡</span>Autopilot</span><span id="badge-Autopilot" class="badge" style="background:var(--sage)"></span></button>
<button class="tab-btn" id="tab-Queue" onclick="showTab('Queue')"><span><span class="tab-icon">👁</span>Review Queue</span><span id="badge-Queue" class="badge" style="background:var(--sage)"></span></button>
<button class="tab-btn" id="tab-Archive" onclick="showTab('Archive')"><span><span class="tab-icon">📁</span>Old Emails</span><span id="badge-Archive" class="badge" style="background:var(--sage)"></span></button>
<button class="tab-btn" id="tab-CRM" onclick="showTab('CRM')"><span><span class="tab-icon">👥</span>Patients</span><span id="badge-CRM" class="badge" style="background:var(--sage)"></span></button>
<button class="tab-btn" id="tab-Voice" onclick="showTab('Voice')"><span><span class="tab-icon">🎙</span>Voice Profile</span><span id="badge-Voice" class="badge" style="background:var(--sage)"></span></button>
<button class="tab-btn" id="tab-Inbox" onclick="showTab('Inbox')"><span><span class="tab-icon">📬</span>Demo Inbox</span><span id="badge-Inbox" class="badge" style="background:var(--sage)"></span></button>
<button class="tab-btn" id="tab-Compose" onclick="showTab('Compose')"><span><span class="tab-icon">✏️</span>Compose</span><span id="badge-Compose" class="badge" style="background:var(--sage)"></span></button>
<button class="tab-btn" id="tab-Sent" onclick="showTab('Sent')"><span><span class="tab-icon">📊</span>Sent Log</span><span id="badge-Sent" class="badge" style="background:var(--sage)"></span></button>
    </div>
    <!-- Stats card -->
    <div style="margin:0 12px 14px;padding:14px;background:var(--sage-pale);border-radius:var(--radius-sm);border:1px solid rgba(107,140,110,.15)">
      <div style="font-size:10px;font-weight:600;color:var(--sage-deep);margin-bottom:8px;letter-spacing:.08em;text-transform:uppercase">Today</div>
      <div id="sidebar-stats" style="font-size:12px;color:var(--text-muted);line-height:2">—</div>
    </div>
  </div>

  <!-- MAIN -->
  <div style="flex:1;overflow:hidden;display:flex;flex-direction:column">
    <div id="err-banner" style="display:none;background:var(--red-lt);border-bottom:1px solid #E8C8C0;padding:10px 20px;font-size:13px;color:var(--red-soft);justify-content:space-between;align-items:center">
      <span id="err-msg"></span>
      <button onclick="hideErr()" style="background:none;border:none;color:var(--red-soft);cursor:pointer;font-size:16px;margin-left:12px">×</button>
    </div>

    <div style="flex:1;overflow:hidden;display:flex">

      <!-- ══ AUTOPILOT ══ -->
      <div id="pane-Autopilot" style="flex:1;overflow-y:auto;padding:32px">
        <div style="max-width:760px">
          <div class="page-title">Autopilot Status</div>
          <div class="page-sub">Every email passes a 2-step AI review before anything is sent. Old emails are separated and flagged for follow-up.</div>

          <div id="connect-banner" style="margin-top:20px"></div>

          <!-- 2-Step cards -->
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:20px 0">
            <div class="card card-tight" style="border-left:3px solid var(--sage)">
              <div class="step-badge" style="margin-bottom:8px">Step 1 — Understand</div>
              <div style="font-size:12.5px;color:var(--text-muted);line-height:1.7">Reads intent, name, urgency, sentiment, and flags every risk before taking any action.</div>
            </div>
            <div class="card card-tight" style="border-left:3px solid var(--amber)">
              <div class="step-badge" style="background:var(--amber-lt);color:var(--amber);margin-bottom:8px">Step 2 — Decide</div>
              <div style="font-size:12.5px;color:var(--text-muted);line-height:1.7">Checks 6 safety gates. Confidence ≥ 80% required. Then 5-minute cancel window before send.</div>
            </div>
          </div>

          <!-- Send queue -->
          <div id="send-queue-panel" style="display:none;background:var(--amber-lt);border:1px solid #E8D0A8;border-radius:var(--radius);padding:18px;margin-bottom:16px">
            <div style="font-size:13.5px;font-weight:600;margin-bottom:12px;color:var(--amber);display:flex;align-items:center;gap:8px">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
              Cancel Window Active — Sending Soon
            </div>
            <div id="send-queue-items"></div>
          </div>

          <!-- Rules -->
          <div class="card" style="margin-bottom:16px">
            <div style="font-family:'Cormorant Garamond',serif;font-size:19px;font-weight:500;margin-bottom:4px">Auto-Send Rules</div>
            <div style="font-size:11.5px;color:var(--stone-lt);margin-bottom:16px">Confidence threshold: 80% · Old emails (3+ days): archived, never auto-sent</div>
            <div class="rule-row">
              <div style="display:flex;align-items:center;gap:12px">
                <span style="font-size:17px;width:24px;text-align:center">📅</span>
                <div>
                  <div style="font-size:13px;font-weight:500;color:var(--charcoal)">Cancellations</div>
                  <div style="font-size:11.5px;color:var(--text-muted);margin-top:1px">Acknowledge + offer reschedule</div>
                </div>
              </div>
              <span class="tag" style="background:var(--sage-pale);color:var(--sage-deep);flex-shrink:0">✓ Auto</span>
            </div><div class="rule-row">
              <div style="display:flex;align-items:center;gap:12px">
                <span style="font-size:17px;width:24px;text-align:center">🙋</span>
                <div>
                  <div style="font-size:13px;font-weight:500;color:var(--charcoal)">New Patient Inquiries</div>
                  <div style="font-size:11.5px;color:var(--text-muted);margin-top:1px">Welcome + booking information</div>
                </div>
              </div>
              <span class="tag" style="background:var(--sage-pale);color:var(--sage-deep);flex-shrink:0">✓ Auto</span>
            </div><div class="rule-row">
              <div style="display:flex;align-items:center;gap:12px">
                <span style="font-size:17px;width:24px;text-align:center">💳</span>
                <div>
                  <div style="font-size:13px;font-weight:500;color:var(--charcoal)">Simple Billing Questions</div>
                  <div style="font-size:11.5px;color:var(--text-muted);margin-top:1px">Acknowledge + 1-2 day follow-up</div>
                </div>
              </div>
              <span class="tag" style="background:var(--sage-pale);color:var(--sage-deep);flex-shrink:0">✓ Auto</span>
            </div><div class="rule-row">
              <div style="display:flex;align-items:center;gap:12px">
                <span style="font-size:17px;width:24px;text-align:center">👨‍⚕️</span>
                <div>
                  <div style="font-size:13px;font-weight:500;color:var(--charcoal)">Doctor Referrals</div>
                  <div style="font-size:11.5px;color:var(--text-muted);margin-top:1px">Confirm receipt + contact timeline</div>
                </div>
              </div>
              <span class="tag" style="background:var(--sage-pale);color:var(--sage-deep);flex-shrink:0">✓ Auto</span>
            </div><div class="rule-row">
              <div style="display:flex;align-items:center;gap:12px">
                <span style="font-size:17px;width:24px;text-align:center">🏥</span>
                <div>
                  <div style="font-size:13px;font-weight:500;color:var(--charcoal)">ICBC Claims</div>
                  <div style="font-size:11.5px;color:var(--text-muted);margin-top:1px">Always held for staff review</div>
                </div>
              </div>
              <span class="tag" style="background:var(--red-lt);color:var(--red-soft);flex-shrink:0">👁 Review</span>
            </div><div class="rule-row">
              <div style="display:flex;align-items:center;gap:12px">
                <span style="font-size:17px;width:24px;text-align:center">😤</span>
                <div>
                  <div style="font-size:13px;font-weight:500;color:var(--charcoal)">Complaints / Anger</div>
                  <div style="font-size:11.5px;color:var(--text-muted);margin-top:1px">Always held — human touch required</div>
                </div>
              </div>
              <span class="tag" style="background:var(--red-lt);color:var(--red-soft);flex-shrink:0">👁 Review</span>
            </div><div class="rule-row">
              <div style="display:flex;align-items:center;gap:12px">
                <span style="font-size:17px;width:24px;text-align:center">🩺</span>
                <div>
                  <div style="font-size:13px;font-weight:500;color:var(--charcoal)">Clinical Questions</div>
                  <div style="font-size:11.5px;color:var(--text-muted);margin-top:1px">Held — therapist judgment needed</div>
                </div>
              </div>
              <span class="tag" style="background:var(--red-lt);color:var(--red-soft);flex-shrink:0">👁 Review</span>
            </div><div class="rule-row">
              <div style="display:flex;align-items:center;gap:12px">
                <span style="font-size:17px;width:24px;text-align:center">❓</span>
                <div>
                  <div style="font-size:13px;font-weight:500;color:var(--charcoal)">Confidence < 80%</div>
                  <div style="font-size:11.5px;color:var(--text-muted);margin-top:1px">Held — AI not certain enough</div>
                </div>
              </div>
              <span class="tag" style="background:var(--red-lt);color:var(--red-soft);flex-shrink:0">👁 Review</span>
            </div>
          </div>

          <!-- Live log -->
          <div class="card">
            <div style="font-family:'Cormorant Garamond',serif;font-size:19px;font-weight:500;margin-bottom:16px">Live Activity</div>
            <div id="live-log"><div style="font-size:13px;color:var(--stone-lt);font-style:italic">No activity yet — connect Gmail to begin.</div></div>
          </div>
        </div>
      </div>

      <!-- ══ REVIEW QUEUE ══ -->
      <div id="pane-Queue" style="display:none;flex:1;overflow-y:auto;padding:32px">
        <div style="max-width:720px">
          <div class="page-title">Review Queue</div>
          <div class="page-sub">Emails the AI held for human approval. Draft reply is pre-written — edit and send with one click.</div>
          <div id="review-queue-items" style="margin-top:24px"></div>
        </div>
      </div>

      <!-- ══ ARCHIVE ══ -->
      <div id="pane-Archive" style="display:none;flex:1;overflow-y:auto;padding:32px">
        <div style="max-width:720px">
          <div class="page-title">Old Emails <span style="font-family:'Outfit',sans-serif;font-size:14px;color:var(--amber);font-weight:500">(3+ days old)</span></div>
          <div class="page-sub">Separated from new emails so nothing gets lost. These senders are waiting — follow up as soon as possible.</div>
          <div style="margin-top:12px;padding:10px 14px;background:var(--red-lt);border-radius:var(--radius-sm);font-size:12.5px;color:var(--red-soft);font-weight:500;display:flex;align-items:center;gap:8px">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            These senders have not received a reply — each one is a potential lost patient.
          </div>
          <div id="archive-items" style="margin-top:16px"></div>
        </div>
      </div>

      <!-- ══ CRM ══ -->
      <div id="pane-CRM" style="display:none;flex:1;overflow-y:auto;padding:32px">
        <div style="max-width:920px">
          <div class="page-title">Patient CRM</div>
          <div class="page-sub">Every person the agent has communicated with. Follow-ups auto-queue after 14 days of silence — held for your review before sending.</div>
          <div id="crm-stats" style="display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin:20px 0"></div>
          <div class="card card-tight" style="margin-bottom:14px">
            <div style="font-size:13px;font-weight:600;margin-bottom:12px;color:var(--charcoal)">Add Past Patient Manually</div>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <input id="crm-email" placeholder="Email address *" style="flex:2;min-width:180px;padding:9px 12px"/>
              <input id="crm-name" placeholder="Name" style="flex:1;min-width:130px;padding:9px 12px"/>
              <input id="crm-notes" placeholder="Notes (optional)" style="flex:2;min-width:180px;padding:9px 12px"/>
              <button class="btn btn-primary" onclick="addCRMContact()">Add Contact</button>
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">
            <button class="btn btn-ghost btn-sm" onclick="triggerFollowUp()">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
              Run Follow-Up Engine Now
            </button>
            <span style="font-size:11.5px;color:var(--stone-lt)">Checks for contacts silent 14+ days — runs daily automatically</span>
          </div>
          <div id="crm-list"></div>
        </div>
      </div>

      <!-- ══ VOICE PROFILE ══ -->
      <div id="pane-Voice" style="display:none;flex:1;overflow-y:auto;padding:32px">
        <div style="max-width:660px">
          <div class="page-title">Voice Profile</div>
          <div class="page-sub">Train the agent to write exactly like Expert Physio's team. The more approved samples you add, the more natural every reply sounds.</div>
          <div class="card" style="margin-top:24px">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
              <div style="font-family:'Cormorant Garamond',serif;font-size:19px;font-weight:500">Voice Guidelines</div>
              <button class="btn btn-ghost btn-sm" onclick="toggleEditGuidelines()">Edit</button>
            </div>
            <div id="guidelines-view" style="font-size:13px;color:var(--text-muted);line-height:1.85;white-space:pre-wrap;background:var(--sage-pale);padding:14px;border-radius:var(--radius-sm)">Loading…</div>
            <div id="guidelines-edit" style="display:none">
              <textarea id="guidelines-textarea" style="width:100%;min-height:200px;padding:13px;margin-top:10px;line-height:1.7;resize:vertical"></textarea>
              <div style="display:flex;gap:8px;margin-top:10px">
                <button class="btn btn-success btn-sm" onclick="saveGuidelines()">Save Guidelines</button>
                <button class="btn btn-ghost btn-sm" onclick="toggleEditGuidelines()">Cancel</button>
              </div>
            </div>
          </div>
          <div class="card" style="margin-top:14px">
            <div style="font-family:'Cormorant Garamond',serif;font-size:19px;font-weight:500;margin-bottom:4px">Approved Reply Samples</div>
            <div style="font-size:12.5px;color:var(--stone-lt);margin-bottom:16px">Paste real replies the clinic team has written and approved. The AI uses these to match their exact tone on every email.</div>
            <div id="voice-samples"></div>
            <textarea id="new-sample-input" placeholder="Paste an approved reply example here…" style="width:100%;min-height:100px;padding:13px;line-height:1.65;resize:vertical;margin-bottom:10px"></textarea>
            <button class="btn btn-primary btn-sm" onclick="addSample()">+ Add Sample</button>
          </div>
        </div>
      </div>

      <!-- ══ INBOX (DEMO) ══ -->
      <div id="pane-Inbox" style="display:none;flex:1;overflow:hidden">
        <div style="width:290px;border-right:1px solid var(--border);overflow-y:auto;background:var(--warm-white);flex-shrink:0;height:100%">
          <div style="padding:13px 16px 11px;border-bottom:1px solid var(--border-lt);font-size:10.5px;font-weight:600;color:var(--sage-deep);letter-spacing:.08em;text-transform:uppercase">Demo Inbox</div>
          <div id="email-list"></div>
        </div>
        <div id="email-detail" style="flex:1;overflow-y:auto;padding:28px;display:flex;align-items:center;justify-content:center">
          <div style="text-align:center;color:var(--stone-lt)">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" style="margin-bottom:12px;opacity:.4"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
            <div style="font-size:14px;font-weight:500">Select an email to read</div>
            <div style="font-size:12px;margin-top:4px">The AI analyses it instantly</div>
          </div>
        </div>
      </div>

      <!-- ══ COMPOSE ══ -->
      <div id="pane-Compose" style="display:none;flex:1;overflow-y:auto;padding:32px">
        <div style="max-width:620px">
          <div class="page-title">Compose Email</div>
          <div class="page-sub">Describe what you want to send — the agent writes it in Expert Physio's exact voice.</div>
          <div style="margin-top:24px">
            <textarea id="compose-input" placeholder='e.g. "Email Sarah Mitchell to reschedule her Thursday appointment to Tuesday at 11am"' style="width:100%;min-height:90px;padding:14px;line-height:1.65;resize:vertical;margin-bottom:12px"></textarea>
            <button class="btn btn-primary" id="compose-btn" onclick="generateEmail()">✨ Generate Email</button>
            <div id="compose-spinner" style="display:none;margin-top:12px;align-items:center;gap:8px;color:var(--text-muted);font-size:13px"><div class="spinner"></div>Composing in Expert Physio's voice…</div>
          </div>
          <div id="composed-email" style="display:none;margin-top:20px">
            <div class="card" style="padding:0;overflow:hidden">
              <div style="padding:11px 16px;border-bottom:1px solid var(--border-lt);display:flex;gap:10px;align-items:center">
                <span style="font-size:10px;font-weight:600;color:var(--stone-lt);width:54px;flex-shrink:0;letter-spacing:.06em;text-transform:uppercase">To</span>
                <input id="c-to" style="flex:1;border:none;font-size:13px;padding:0;background:transparent"/>
              </div>
              <div style="padding:11px 16px;border-bottom:1px solid var(--border-lt);display:flex;gap:10px;align-items:center">
                <span style="font-size:10px;font-weight:600;color:var(--stone-lt);width:54px;flex-shrink:0;letter-spacing:.06em;text-transform:uppercase">Subject</span>
                <input id="c-subject" style="flex:1;border:none;font-size:13px;padding:0;background:transparent"/>
              </div>
              <div style="padding:14px 16px">
                <div style="font-size:10px;font-weight:600;color:var(--stone-lt);margin-bottom:8px;letter-spacing:.06em;text-transform:uppercase">Body</div>
                <textarea id="c-body" style="width:100%;min-height:200px;border:none;font-size:13px;line-height:1.75;resize:vertical;padding:0;background:transparent"></textarea>
              </div>
            </div>
            <div style="display:flex;gap:8px;margin-top:12px">
              <button class="btn btn-success" onclick="sendComposed()">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
                Send via Gmail
              </button>
              <button class="btn btn-ghost" onclick="discardComposed()">Discard</button>
            </div>
          </div>
        </div>
      </div>

      <!-- ══ SENT LOG ══ -->
      <div id="pane-Sent" style="display:none;flex:1;overflow-y:auto;padding:32px">
        <div style="max-width:740px">
          <div class="page-title">Sent Log</div>
          <div class="page-sub">Full record of every email sent — content, AI analysis, confidence score, timestamp.</div>
          <div id="sent-log-items" style="margin-top:24px"><div style="font-size:13px;color:var(--stone-lt);font-style:italic">No emails sent yet.</div></div>
        </div>
      </div>

    </div>
  </div>
</div>

<script>
// ── STATE ──────────────────────────────────────────────────────────────────────
let currentTab='Autopilot';
let serverData={};
let editingGuidelines=false;
let notifPanelOpen=false;
let selectedEmailId=null;

const DEMO_EMAILS=[
  {id:1,name:'Sarah Mitchell',from:'sarah.mitchell@gmail.com',subject:'Appointment Cancellation - Thursday 2pm',preview:'Hi, I need to cancel my appointment...',body:'Hi, I need to cancel my appointment this Thursday at 2pm. I have a conflict at work. Can we reschedule? Any time Tuesday or Wednesday works. Thanks, Sarah',time:'9:14 AM',status:'unread',tag:'cancellation'},
  {id:2,name:'ICBC Claims',from:'icbc.claims@icbc.com',subject:'Claim #4892-B: Treatment Authorization Required',preview:'Please submit updated treatment plan...',body:'Please submit updated treatment plan for claimant John Patel (Claim #4892-B). Authorization is required before proceeding with further sessions. Please respond within 5 business days.',time:'8:30 AM',status:'unread',tag:'icbc'},
  {id:3,name:'Dr. Angela Lee',from:'drlee@familyclinic.ca',subject:'Referral: Marcus Huang - Lower Back Pain',preview:'I am referring Marcus Huang, 42...',body:'I am referring Marcus Huang, 42, for physiotherapy following a lumbar strain. Three weeks of lower back pain. Please book at your earliest convenience.',time:'Yesterday',status:'read',tag:'referral'},
  {id:4,name:'Kevin Tran',from:'kevin.tran88@hotmail.com',subject:'Question about my invoice',preview:'Hi there, I received an invoice...',body:'Hi there, I received an invoice for $180 but think my insurance covers 80%. Can you resubmit to Pacific Blue Cross? Policy PBC-2291-TK.',time:'Yesterday',status:'read',tag:'billing'},
  {id:5,name:'Amanda Shore',from:'amanda.shore@gmail.com',subject:'New Patient Inquiry',preview:'Hello, I found you on Google...',body:'Hello, I found you on Google and wondering if you accept new patients? I have a rotator cuff injury. Available weekday mornings. Do you direct bill to MSP?',time:'Mon',status:'read',tag:'new-patient'},
];
const TAGS={
  cancellation:{bg:'#FCF0EE',color:'#B85A48',label:'Cancellation'},
  icbc:{bg:'#EEF2FA',color:'#4A7AB5',label:'ICBC'},
  referral:{bg:'var(--sage-pale)',color:'var(--sage-deep)',label:'Referral'},
  billing:{bg:'#FAF4EA',color:'#B87A38',label:'Billing'},
  'new-patient':{bg:'#EEF6FA',color:'#3A7A9E',label:'New Patient'},
};
const CRM_STATUS_LABELS={
  active:{label:'Active',bg:'var(--sage-pale)',color:'var(--sage-deep)'},
  silent:{label:'Silent',bg:'var(--amber-lt)',color:'var(--amber)'},
  followup:{label:'Follow-up Sent',bg:'var(--blue-lt)',color:'var(--blue-soft)'},
  booked:{label:'Booked ✓',bg:'var(--sage-pale)',color:'var(--sage-deep)'},
  lost:{label:'Lost',bg:'var(--border-lt)',color:'var(--stone)'},
  opted_out:{label:'Opted Out',bg:'var(--border-lt)',color:'var(--stone)'},
};
let draftReplies={};

// ── UTILS ──────────────────────────────────────────────────────────────────────
function showToast(msg){const t=document.getElementById('toast');document.getElementById('toast-msg').textContent=msg;t.style.display='flex';setTimeout(()=>t.style.display='none',3500);}
function hideToast(){document.getElementById('toast').style.display='none';}
function showErr(msg){const b=document.getElementById('err-banner');document.getElementById('err-msg').textContent=msg;b.style.display='flex';}
function hideErr(){document.getElementById('err-banner').style.display='none';}
function dismissIntro(){document.getElementById('intro').classList.add('hidden');}
function showIntro(){document.getElementById('intro').classList.remove('hidden');}

// ── TABS ───────────────────────────────────────────────────────────────────────
function showTab(name){
  document.querySelectorAll('[id^="pane-"]').forEach(p=>{p.style.display='none';});
  document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
  const pane=document.getElementById('pane-'+name);
  if(pane)pane.style.display=name==='Inbox'?'flex':'block';
  const btn=document.getElementById('tab-'+name);
  if(btn)btn.classList.add('active');
  currentTab=name;
  if(name==='Inbox')renderEmailList();
  if(name==='CRM')renderCRM();
}

// ── API ────────────────────────────────────────────────────────────────────────
async function apiFetch(path,opts={}){
  const r=await fetch(path,{headers:{'Content-Type':'application/json'},...opts});
  if(!r.ok){const e=await r.json().catch(()=>({}));throw new Error(e.error||'Request failed');}
  return r.json();
}
async function callClaude(msg){
  const d=await apiFetch('/api/claude',{method:'POST',body:JSON.stringify({model:'claude-sonnet-4-6',max_tokens:900,system:'You are the AI assistant for Expert Physio, a physiotherapy clinic in Burnaby, BC. Tone: warm, professional, concise. Sign as "Expert Physio Team".',messages:[{role:'user',content:msg}]})});
  const t=(d.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('\\n').trim();
  if(!t)throw new Error('Empty response');
  return t;
}

// ── REFRESH ────────────────────────────────────────────────────────────────────
async function refreshData(){
  try{
    const [status,log,review,queue,sent,voice,archive,notifications,crm,crmStats]=await Promise.all([
      apiFetch('/api/status'),apiFetch('/api/log'),apiFetch('/api/review'),
      apiFetch('/api/queue'),apiFetch('/api/sent'),apiFetch('/api/voice'),
      apiFetch('/api/archive'),apiFetch('/api/notifications'),
      apiFetch('/api/crm'),apiFetch('/api/crm/stats'),
    ]);
    serverData={status,log,review,queue,sent,voice,archive,notifications,crm,crmStats};
    updateUI();
  }catch(e){console.error('Refresh:',e.message);}
}

function setB(id,n,show,color){
  const el=document.getElementById('badge-'+id);
  if(!el)return;
  el.textContent=n;
  el.style.display=show?'inline':'none';
  if(color)el.style.background=color;
}

function updateUI(){
  const {status,log,review,queue,sent,voice,archive,notifications,crm,crmStats}=serverData;
  if(!status)return;

  // Status line
  const dot=document.getElementById('status-dot');
  const txt=document.getElementById('status-text');
  if(dot){dot.style.background=status.connected?'var(--sage)':'var(--red-soft)';dot.style.animation=status.connected?'pulse 2s infinite':'';}
  if(txt){txt.textContent=status.connected?'Autopilot running — 2-step review active':'Gmail not connected';txt.style.color=status.connected?'var(--sage-deep)':'var(--text-muted)';}

  // Connect areas
  const cba=document.getElementById('connect-btn-area');
  if(cba)cba.innerHTML=status.connected?'':
    '<a href="/auth/login" style="padding:8px 16px;background:var(--sage);color:#fff;border-radius:var(--radius-sm);font-size:12.5px;font-weight:500;text-decoration:none;display:inline-flex;align-items:center;gap:6px">Connect Gmail →</a>';
  const cb=document.getElementById('connect-banner');
  if(cb)cb.innerHTML=status.connected?'':
    '<div style="background:var(--amber-lt);border:1px solid #E8D0A8;border-radius:var(--radius);padding:18px;display:flex;align-items:center;justify-content:space-between;gap:16px"><div><div style="font-weight:600;color:var(--amber);margin-bottom:3px">Gmail not connected</div><div style="font-size:12.5px;color:var(--stone)">Connect Gmail in the top right to start the autopilot.</div></div><a href="/auth/login" style="padding:9px 18px;background:var(--amber);color:#fff;border-radius:var(--radius-sm);font-size:12.5px;font-weight:500;text-decoration:none;white-space:nowrap;flex-shrink:0">Connect Gmail →</a></div>';

  // Sidebar stats
  const ss=document.getElementById('sidebar-stats');
  if(ss)ss.innerHTML=
    '<div>⚡ '+(status.sentToday||0)+' auto-sent</div><div>⏱ '+(status.queueCount||0)+' in queue</div><div>⚠️ '+(status.reviewCount||0)+' for review</div><div>👥 '+(crmStats?.total||0)+' contacts</div>';

  // Badges
  const aq=(queue||[]).filter(q=>!q.cancelled).length;
  setB('Autopilot',aq,aq>0,'var(--amber)');
  setB('Queue',status.reviewCount||0,(status.reviewCount||0)>0,'var(--red-soft)');
  setB('Archive',status.archiveCount||0,(status.archiveCount||0)>0,'var(--amber)');
  setB('CRM',status.crmSilent||0,(status.crmSilent||0)>0,'var(--amber)');

  // Bell
  const unN=status.unreadNotifications||0;
  const bb=document.getElementById('bell-badge');
  if(bb){bb.textContent=unN;bb.style.display=unN>0?'inline':'none';}
  const bellBtn=document.getElementById('bell-btn');
  if(bellBtn&&unN>0){bellBtn.style.animation='bellRing 1s ease';setTimeout(()=>{if(bellBtn)bellBtn.style.animation='';},1000);}

  // Header badges
  let hb='';
  if(status.reviewCount>0)hb+='<span style="background:var(--red-lt);color:var(--red-soft);border:1px solid #E8C8C0;border-radius:20px;font-size:11px;font-weight:600;padding:3px 10px">⚠️ '+status.reviewCount+' for review</span>';
  if(aq>0)hb+='<span style="background:var(--amber-lt);color:var(--amber);border:1px solid #E8D0A8;border-radius:20px;font-size:11px;font-weight:600;padding:3px 10px;margin-left:6px">⏱ '+aq+' sending</span>';
  const hbEl=document.getElementById('header-badges');
  if(hbEl)hbEl.innerHTML=hb;

  // Send queue panel
  const sqP=document.getElementById('send-queue-panel');
  const sqI=document.getElementById('send-queue-items');
  const activeQ=(queue||[]).filter(q=>!q.cancelled);
  if(sqP)sqP.style.display=activeQ.length>0?'block':'none';
  if(sqI)sqI.innerHTML=activeQ.map(item=>{
    const sec=Math.max(0,Math.round((new Date(item.sendAt||Date.now()+300000)-Date.now())/1000));
    const m=Math.floor(sec/60),s=sec%60;
    return \`<div style="padding:11px 13px;background:var(--warm-white);border-radius:var(--radius-sm);margin-bottom:8px;border:1px solid #E8D0A8;display:flex;align-items:center;justify-content:space-between;gap:12px">
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">\${item.email?.subject||''}</div>
        <div style="font-size:11.5px;color:var(--text-muted);margin-top:2px">To: \${item.email?.from||''} · \${item.classification?.confidence||0}% confidence</div>
      </div>
      <div style="display:flex;align-items:center;gap:10px;flex-shrink:0">
        <span style="font-size:12px;color:var(--amber);font-weight:600">Sending in \${m}:\${String(s).padStart(2,'0')}</span>
        <button onclick="cancelSend('\${item.id}')" class="btn btn-amber btn-sm">Cancel</button>
      </div>
    </div>\`;
  }).join('');

  // Live log
  const ll=document.getElementById('live-log');
  if(ll&&log&&log.length>0){
    ll.innerHTML=log.slice(0,15).map((item,i)=>{
      const dotC=item.type==='sent'?'var(--sage)':item.type==='review'?'var(--red-soft)':item.type==='queued'?'var(--amber)':item.type==='archive'?'#8B5CF6':item.type==='error'?'var(--red-soft)':'var(--stone-lt)';
      return \`<div style="display:flex;gap:12px;padding-bottom:11px;padding-left:15px;margin-left:7px;border-left:1px solid var(--border-lt);position:relative;animation:slideRight .2s ease">
        <div style="width:6px;height:6px;border-radius:50%;background:\${dotC};position:absolute;left:-4px;top:5px;flex-shrink:0"></div>
        <div style="font-size:11px;color:var(--stone-lt);white-space:nowrap;min-width:46px;padding-top:1px">\${item.time}</div>
        <div style="font-size:12.5px;color:var(--text-muted);line-height:1.55">\${item.msg}</div>
      </div>\`;
    }).join('');
  }

  // Review queue
  const rq=document.getElementById('review-queue-items');
  if(rq){
    if(!review||review.length===0){
      rq.innerHTML='<div style="background:var(--sage-pale);border:1px solid rgba(107,140,110,.2);border-radius:var(--radius);padding:24px;text-align:center"><div style="font-size:28px;margin-bottom:8px">✓</div><div style="font-family:\'Cormorant Garamond\',serif;font-size:18px;color:var(--sage-deep)">Queue is clear</div><div style="font-size:13px;color:var(--text-muted);margin-top:4px">The agent is handling everything automatically.</div></div>';
    }else{
      rq.innerHTML=review.map(item=>\`
        <div id="review-\${item.id}" style="border:1px solid var(--border);border-radius:var(--radius);margin-bottom:12px;overflow:hidden;animation:fadeUp .2s ease;box-shadow:var(--shadow-sm)">
          <div style="padding:14px 16px;background:var(--warm-white);cursor:pointer" onclick="toggleReview('\${item.id}')">
            <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:8px">
              <div style="flex:1;min-width:0">
                <div style="font-size:13.5px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--charcoal)">\${item.email?.subject||''}</div>
                <div style="font-size:12px;color:var(--text-muted);margin-top:2px">From: \${item.email?.from||''}</div>
              </div>
              <div style="display:flex;gap:6px;flex-shrink:0;align-items:center">
                <button onclick="event.stopPropagation();discardReview('\${item.id}')" class="btn btn-danger btn-sm">Discard</button>
                <span style="font-size:12px;color:var(--stone-lt);padding:0 2px">▼</span>
              </div>
            </div>
            \${item.understanding?\`<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px">
              <span class="step-badge">Intent: \${item.understanding.intent||''}</span>
              <span class="tag" style="background:var(--amber-lt);color:var(--amber)">Urgency: \${item.understanding.urgency||''}</span>
              <span class="tag" style="background:\${(item.classification?.confidence||0)>=80?'var(--sage-pale)':'var(--red-lt)'};color:\${(item.classification?.confidence||0)>=80?'var(--sage-deep)':'var(--red-soft)'}">\${item.classification?.confidence||0}% confidence</span>
            </div>\`:''}
            <div style="font-size:12px;color:var(--red-soft);font-weight:500">🛑 \${item.holdReason||item.classification?.reason||''}</div>
          </div>
          <div id="review-body-\${item.id}" style="display:none;padding:16px;border-top:1px solid var(--border-lt);background:var(--cream)">
            <div style="font-size:13px;color:var(--text-muted);background:var(--warm-white);border:1px solid var(--border);border-radius:var(--radius-sm);padding:13px;margin-bottom:13px;line-height:1.7">\${item.email?.body||''}</div>
            \${item.understanding?.risks?.length>0?\`<div style="font-size:12px;color:var(--amber);background:var(--amber-lt);padding:9px 12px;border-radius:var(--radius-sm);margin-bottom:12px;border:1px solid #E8D0A8">⚠️ Risks flagged: \${item.understanding.risks.join(', ')}</div>\`:''}
            <div style="font-size:10.5px;font-weight:600;color:var(--stone-lt);margin-bottom:7px;letter-spacing:.06em;text-transform:uppercase">AI Draft — edit before sending</div>
            <textarea id="review-draft-\${item.id}" style="width:100%;min-height:150px;padding:12px;border-radius:var(--radius-sm);line-height:1.7;resize:vertical;margin-bottom:11px">\${item.draftReply||''}</textarea>
            <button class="btn btn-success" onclick="approveReview('\${item.id}')">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
              Approve & Send
            </button>
          </div>
        </div>
      \`).join('');
    }
  }

  // Archive
  const archEl=document.getElementById('archive-items');
  if(archEl){
    if(!archive||archive.length===0){
      archEl.innerHTML='<div style="font-size:13px;color:var(--stone-lt);font-style:italic">No old emails archived yet.</div>';
    }else{
      archEl.innerHTML=archive.slice(0,50).map(item=>\`
        <div style="background:var(--warm-white);border:1px solid \${item.followedUp?'rgba(107,140,110,.2)':'var(--border)'};border-radius:var(--radius);padding:16px;margin-bottom:10px;opacity:\${item.followedUp?.5:1};box-shadow:var(--shadow-sm)">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px">
            <div style="flex:1;min-width:0">
              <div style="font-size:13.5px;font-weight:500;margin-bottom:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--charcoal)">\${item.email?.subject||''}</div>
              <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">From: \${item.email?.from||''}</div>
              <span class="tag" style="background:\${item.followedUp?'var(--sage-pale)':'var(--amber-lt)'};color:\${item.followedUp?'var(--sage-deep)':'var(--amber)'}">\${item.followedUp?'✓ Followed up':'⚠️ Needs follow-up'}</span>
            </div>
            \${!item.followedUp?
              \`<button onclick="markFollowedUp('\${item.id}')" class="btn btn-amber btn-sm" style="flex-shrink:0">Mark Done</button>\`
              :''}
          </div>
          <div style="margin-top:12px;font-size:13px;color:var(--text-muted);background:var(--cream);border:1px solid var(--border-lt);border-radius:var(--radius-sm);padding:11px;line-height:1.65">\${item.email?.body?.slice(0,300)||''}…</div>
        </div>
      \`).join('');
    }
  }

  // Notifications
  const nl=document.getElementById('notif-list');
  if(nl){
    if(!notifications||notifications.length===0){
      nl.innerHTML='<div style="padding:24px;text-align:center;color:var(--stone-lt);font-size:13px">No notifications</div>';
    }else{
      nl.innerHTML=notifications.slice(0,20).map(n=>\`
        <div style="padding:13px 16px;border-bottom:1px solid var(--border-lt);background:\${n.read?'var(--warm-white)':'var(--sage-pale)'};cursor:pointer" onclick="handleNotifClick('\${n.id}','\${n.type}')">
          <div style="display:flex;gap:10px;align-items:flex-start">
            <span style="font-size:16px;flex-shrink:0">📁</span>
            <div style="flex:1;min-width:0">
              <div style="font-size:12.5px;font-weight:\${n.read?400:600};color:var(--charcoal);margin-bottom:2px">\${n.title}</div>
              <div style="font-size:11.5px;color:var(--text-muted);line-height:1.5">\${n.message}</div>
              <div style="font-size:10.5px;color:var(--stone-lt);margin-top:4px">\${new Date(n.createdAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</div>
            </div>
            \${!n.read?'<span class="status-dot" style="background:var(--amber);margin-top:4px;flex-shrink:0"></span>':''}
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
        ?'<div style="font-size:13px;color:var(--stone-lt);margin-bottom:14px;font-style:italic">No samples yet — add approved replies below.</div>'
        :(voice.samples||[]).map((s,i)=>\`<div style="background:var(--sage-pale);border:1px solid rgba(107,140,110,.15);border-radius:var(--radius-sm);padding:13px;margin-bottom:8px;display:flex;gap:10px"><div style="flex:1;font-size:13px;color:var(--text-muted);line-height:1.65">\${s}</div><button onclick="removeSample(\${i})" style="background:none;border:none;color:var(--stone-lt);cursor:pointer;font-size:16px;flex-shrink:0;padding:0;line-height:1">×</button></div>\`).join('');
    }
  }

  // Sent log
  const sentEl=document.getElementById('sent-log-items');
  if(sentEl&&sent&&sent.length>0){
    sentEl.innerHTML=sent.slice(0,50).map(item=>\`
      <div style="background:var(--warm-white);border:1px solid var(--border);border-radius:var(--radius);margin-bottom:10px;overflow:hidden;cursor:pointer;box-shadow:var(--shadow-sm)" onclick="toggleSent('\${item.id}')">
        <div style="padding:13px 16px;display:flex;align-items:center;justify-content:space-between;gap:12px">
          <div style="flex:1;min-width:0">
            <div style="font-size:13.5px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--charcoal)">\${item.email?.subject||''}</div>
            <div style="font-size:12px;color:var(--text-muted);margin-top:3px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
              <span>To: \${item.email?.from||''}</span>
              <span class="tag" style="background:\${(item.confidence||0)>=80?'var(--sage-pale)':'var(--amber-lt)'};color:\${(item.confidence||0)>=80?'var(--sage-deep)':'var(--amber)'}">\${item.confidence||0}%</span>
              \${item.manualApproval?'<span class="tag" style="background:var(--blue-lt);color:var(--blue-soft)">Staff approved</span>':''}
            </div>
          </div>
          <div style="font-size:11px;color:var(--stone-lt);text-align:right;flex-shrink:0"><div>\${new Date(item.sentAt).toLocaleDateString()}</div><div>\${new Date(item.sentAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</div></div>
        </div>
        <div id="sent-body-\${item.id}" style="display:none;padding:0 16px 16px;border-top:1px solid var(--border-lt)">
          \${item.understanding?\`<div style="font-size:11.5px;color:var(--blue-soft);background:var(--blue-lt);padding:8px 11px;border-radius:var(--radius-sm);margin:12px 0 9px;display:flex;gap:6px;align-items:center"><span class="step-badge" style="flex-shrink:0">AI</span>Intent: \${item.understanding.intent||''} · \${item.understanding.sentiment||''} sentiment</div>\`:''}
          <div style="font-size:10.5px;font-weight:600;color:var(--stone-lt);margin-bottom:7px;letter-spacing:.06em;text-transform:uppercase">Sent Reply</div>
          <div style="background:var(--cream);border:1px solid var(--border-lt);border-radius:var(--radius-sm);padding:13px;font-size:13px;color:var(--text-muted);line-height:1.75;white-space:pre-wrap">\${item.replyBody||''}</div>
        </div>
      </div>
    \`).join('');
  }

  // CRM (only re-render if on tab)
  if(currentTab==='CRM')renderCRM();
}

// ── CRM ────────────────────────────────────────────────────────────────────────
function renderCRM(){
  const crm=serverData.crm||[];
  const stats=serverData.crmStats;
  const now=Date.now();

  const statsEl=document.getElementById('crm-stats');
  if(statsEl&&stats){
    statsEl.innerHTML=[
      {label:'Total',val:stats.total,bg:'var(--warm-white)',vc:'var(--charcoal)'},
      {label:'Active',val:stats.active,bg:'var(--sage-pale)',vc:'var(--sage-deep)'},
      {label:'Need Follow-Up',val:stats.silent,bg:'var(--amber-lt)',vc:'var(--amber)'},
      {label:'Follow-Up Sent',val:stats.followUp,bg:'var(--blue-lt)',vc:'var(--blue-soft)'},
      {label:'Lost',val:stats.lost,bg:'var(--border-lt)',vc:'var(--stone)'},
    ].map(s=>\`<div style="background:\${s.bg};border:1px solid var(--border);border-radius:var(--radius);padding:16px;text-align:center;box-shadow:var(--shadow-sm)">
      <div style="font-family:'Cormorant Garamond',serif;font-size:28px;font-weight:500;color:\${s.vc};line-height:1">\${s.val}</div>
      <div style="font-size:11px;color:var(--text-muted);margin-top:5px;font-weight:500">\${s.label}</div>
    </div>\`).join('');
  }

  const listEl=document.getElementById('crm-list');
  if(!listEl)return;
  if(crm.length===0){
    listEl.innerHTML='<div style="font-size:13px;color:var(--stone-lt);font-style:italic;padding:20px 0">No contacts yet — they appear automatically as emails come in, or add them manually above.</div>';
    return;
  }

  listEl.innerHTML=\`<div style="background:var(--warm-white);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;box-shadow:var(--shadow-sm)">
    <div style="display:grid;grid-template-columns:2fr 2fr 1fr 1fr 1.2fr 1fr;border-bottom:1px solid var(--border);background:var(--cream)">
      \${['Contact','Last Topic','Last Seen','Touches','Status','Action'].map(h=>\`<div style="padding:10px 13px;font-size:10.5px;font-weight:600;color:var(--stone);letter-spacing:.06em;text-transform:uppercase">\${h}</div>\`).join('')}
    </div>
    \${crm.slice(0,100).map((c,i)=>{
      const st=CRM_STATUS_LABELS[c.status]||CRM_STATUS_LABELS.active;
      const days=Math.round((now-new Date(c.lastSeen).getTime())/(24*60*60*1000));
      const isSilent=days>=14&&c.status!=='lost'&&c.status!=='opted_out';
      const rowBg=isSilent?'#FEFAF3':i%2===0?'var(--warm-white)':'var(--cream)';
      return \`
        <div style="display:contents">
          <div style="padding:11px 13px;border-bottom:1px solid var(--border-lt);background:\${rowBg}">
            <div style="font-size:13px;font-weight:500;color:var(--charcoal)">\${c.name}</div>
            <div style="font-size:11px;color:var(--stone-lt);margin-top:1px">\${c.email}</div>
          </div>
          <div style="padding:11px 13px;border-bottom:1px solid var(--border-lt);font-size:12.5px;color:var(--text-muted);background:\${rowBg};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px">\${c.lastSubject||'—'}</div>
          <div style="padding:11px 13px;border-bottom:1px solid var(--border-lt);font-size:12.5px;color:\${isSilent?'var(--amber)':'var(--text-muted)'};font-weight:\${isSilent?600:400};background:\${rowBg}">\${isSilent?'⚠️ ':''}\${days}d ago</div>
          <div style="padding:11px 13px;border-bottom:1px solid var(--border-lt);font-size:12.5px;color:var(--text-muted);background:\${rowBg};text-align:center">\${c.touchCount||1}</div>
          <div style="padding:11px 13px;border-bottom:1px solid var(--border-lt);background:\${rowBg}">
            <span class="tag" style="background:\${st.bg};color:\${st.color}">\${st.label}</span>
          </div>
          <div style="padding:8px 10px;border-bottom:1px solid var(--border-lt);background:\${rowBg}">
            <select onchange="updateCRMStatus('\${c.id}',this.value)" style="font-size:11.5px;padding:4px 7px;border:1px solid var(--border);border-radius:var(--radius-sm);cursor:pointer;background:var(--warm-white);color:var(--text-muted);width:100%">
              <option value="">Change…</option>
              <option value="active">Active</option>
              <option value="booked">Booked ✓</option>
              <option value="lost">Lost</option>
              <option value="opted_out">Opted Out</option>
            </select>
          </div>
        </div>
      \`;
    }).join('')}
  </div>\`;
}

async function addCRMContact(){
  const email=document.getElementById('crm-email').value.trim();
  const name=document.getElementById('crm-name').value.trim();
  const notes=document.getElementById('crm-notes').value.trim();
  if(!email){showErr('Email address is required');return;}
  try{
    await apiFetch('/api/crm',{method:'POST',body:JSON.stringify({email,name,notes})});
    document.getElementById('crm-email').value='';
    document.getElementById('crm-name').value='';
    document.getElementById('crm-notes').value='';
    showToast('✓ Contact added to CRM');
    await refreshData();
  }catch(e){showErr(e.message);}
}
async function updateCRMStatus(id,status){
  if(!status)return;
  try{await apiFetch('/api/crm/'+id,{method:'PATCH',body:JSON.stringify({status})});showToast('✓ Status updated');await refreshData();}
  catch(e){showErr(e.message);}
}
async function triggerFollowUp(){
  try{await apiFetch('/api/crm/followup-now',{method:'POST'});showToast('✓ Follow-up engine triggered — check Review Queue');await refreshData();}
  catch(e){showErr(e.message);}
}

// ── ACTIONS ────────────────────────────────────────────────────────────────────
async function cancelSend(id){try{await apiFetch('/api/queue/'+id+'/cancel',{method:'POST'});showToast('Send cancelled');await refreshData();}catch(e){showErr(e.message);}}
function toggleReview(id){const b=document.getElementById('review-body-'+id);if(b)b.style.display=b.style.display==='none'?'block':'none';}
async function approveReview(id){
  const draft=document.getElementById('review-draft-'+id)?.value;
  try{await apiFetch('/api/review/'+id+'/approve',{method:'POST',body:JSON.stringify({reply:draft})});showToast('✓ Reply sent');await refreshData();}
  catch(e){showErr(e.message);}
}
async function discardReview(id){
  try{await apiFetch('/api/review/'+id+'/discard',{method:'POST'});showToast('Discarded');await refreshData();}
  catch(e){showErr(e.message);}
}
function toggleSent(id){const b=document.getElementById('sent-body-'+id);if(b)b.style.display=b.style.display==='none'?'block':'none';}
async function markFollowedUp(id){
  try{await apiFetch('/api/archive/'+id+'/followup',{method:'POST'});showToast('✓ Marked as followed up');await refreshData();}
  catch(e){showErr(e.message);}
}
function toggleNotifPanel(){
  notifPanelOpen=!notifPanelOpen;
  document.getElementById('notif-panel').style.display=notifPanelOpen?'block':'none';
}
async function markAllRead(){
  try{await apiFetch('/api/notifications/read-all',{method:'POST'});await refreshData();}catch{}
}
async function handleNotifClick(id,type){
  await apiFetch('/api/notifications/'+id+'/read',{method:'POST'}).catch(()=>{});
  if(type==='old_email')showTab('Archive');
  toggleNotifPanel();
  await refreshData();
}

// ── VOICE ──────────────────────────────────────────────────────────────────────
function toggleEditGuidelines(){
  editingGuidelines=!editingGuidelines;
  document.getElementById('guidelines-view').style.display=editingGuidelines?'none':'block';
  document.getElementById('guidelines-edit').style.display=editingGuidelines?'block':'none';
  if(editingGuidelines){const ta=document.getElementById('guidelines-textarea');if(ta)ta.value=serverData.voice?.guidelines||'';}
}
async function saveGuidelines(){
  const g=document.getElementById('guidelines-textarea').value;
  try{await apiFetch('/api/voice/guidelines',{method:'POST',body:JSON.stringify({guidelines:g})});toggleEditGuidelines();showToast('✓ Voice guidelines saved');await refreshData();}
  catch(e){showErr(e.message);}
}
async function addSample(){
  const s=document.getElementById('new-sample-input').value.trim();
  if(!s)return;
  try{await apiFetch('/api/voice/sample',{method:'POST',body:JSON.stringify({sample:s})});document.getElementById('new-sample-input').value='';showToast('✓ Sample added');await refreshData();}
  catch(e){showErr(e.message);}
}
async function removeSample(i){
  try{await apiFetch('/api/voice/sample/'+i,{method:'DELETE'});showToast('Sample removed');await refreshData();}
  catch(e){showErr(e.message);}
}

// ── INBOX ──────────────────────────────────────────────────────────────────────
function renderEmailList(){
  const list=document.getElementById('email-list');
  if(!list)return;
  list.innerHTML=DEMO_EMAILS.map(e=>{
    const tag=TAGS[e.tag];
    return \`<div class="email-row \${e.status==='unread'?'unread':''} \${selectedEmailId===e.id?'selected':''}" onclick="selectEmail(\${e.id})">
      <div style="display:flex;justify-content:space-between;margin-bottom:3px;gap:6px">
        <span style="font-size:13px;font-weight:\${e.status==='unread'?600:400};color:var(--charcoal);display:flex;align-items:center;gap:6px;overflow:hidden;flex:1">
          \${e.status==='unread'?'<span class="status-dot" style="background:var(--sage);flex-shrink:0"></span>':''}
          \${e.status==='replied'?'<span style="font-size:10px;color:var(--sage);font-weight:600;flex-shrink:0">✓</span>':''}
          <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">\${e.name}</span>
        </span>
        <span style="font-size:10.5px;color:var(--stone-lt);flex-shrink:0">\${e.time}</span>
      </div>
      <div style="font-size:12px;font-weight:500;color:var(--text-muted);margin-bottom:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">\${e.subject}</div>
      <span class="tag" style="background:\${tag.bg};color:\${tag.color}">\${tag.label}</span>
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
  detail.style.alignItems='flex-start';
  detail.innerHTML=\`<div style="max-width:640px;width:100%;animation:fadeUp .2s ease">
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:6px">
      <div style="font-family:'Cormorant Garamond',serif;font-size:22px;font-weight:500;line-height:1.3;color:var(--charcoal)">\${email.subject}</div>
      <span class="tag" style="background:\${tag.bg};color:\${tag.color};flex-shrink:0">\${tag.label}</span>
    </div>
    <div style="font-size:12px;color:var(--text-muted);margin-bottom:16px">From: <strong>\${email.name}</strong> · \${email.time}</div>
    <div style="background:var(--warm-white);border:1px solid var(--border);border-radius:var(--radius);padding:18px;margin-bottom:16px;font-size:13.5px;line-height:1.8;color:var(--text-muted);box-shadow:var(--shadow-sm)">\${email.body}</div>
    <div id="summary-area"><div style="display:flex;align-items:center;gap:8px;color:var(--stone-lt);font-size:13px;padding:6px 0"><div class="spinner"></div>Running 2-step analysis…</div></div>
    \${email.status==='replied'
      ?'<div style="padding:11px 14px;background:var(--sage-pale);border:1px solid rgba(107,140,110,.2);border-radius:var(--radius-sm);font-size:13px;color:var(--sage-deep);font-weight:500;display:flex;align-items:center;gap:6px"><svg width="13" height="13" viewBox=\'0 0 24 24\' fill=\'none\' stroke=\'currentColor\' stroke-width=\'2.5\'><polyline points=\'20 6 9 17 4 12\'/></svg>Reply sent via Gmail</div>'
      :\`<div id="reply-section">
          <button class="btn btn-primary" id="draft-btn" onclick="draftReply(\${email.id})">✨ Draft Reply</button>
          <div id="reply-area" style="display:none;margin-top:16px;animation:fadeUp .25s ease">
            <div style="font-size:10.5px;font-weight:600;color:var(--stone-lt);margin-bottom:8px;letter-spacing:.06em;text-transform:uppercase">Drafted Reply — edit before sending</div>
            <textarea id="reply-text" style="width:100%;min-height:180px;padding:14px;border-radius:var(--radius);font-size:13.5px;line-height:1.8;resize:vertical;color:var(--text)"></textarea>
            <div style="display:flex;gap:8px;margin-top:11px">
              <button class="btn btn-success" onclick="sendReply(\${email.id})">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
                Send via Gmail
              </button>
              <button class="btn btn-ghost" onclick="discardReply()">Discard</button>
            </div>
          </div>
        </div>\`
    }
  </div>\`;

  try{
    const s=await callClaude('Run a 2-step analysis.\\n\\nStep 1: What does this person actually want? What is their mood?\\nStep 2: What should Expert Physio do?\\n\\nMax 2 sentences total. Be direct.\\n\\nFrom: '+email.name+'\\nSubject: '+email.subject+'\\nBody: '+email.body);
    const sa=document.getElementById('summary-area');
    if(sa)sa.innerHTML=\`<div style="background:var(--sage-pale);border:1px solid rgba(107,140,110,.2);border-radius:var(--radius-sm);padding:13px 15px;margin-bottom:16px;animation:fadeIn .3s ease">
      <div style="display:flex;gap:6px;margin-bottom:6px">
        <span class="step-badge">Step 1 + 2</span>
        <span style="font-size:10.5px;font-weight:600;color:var(--sage-deep);padding:2px 8px;border-radius:20px;background:rgba(107,140,110,.15)">Analysis Complete</span>
      </div>
      <div style="font-size:13px;color:var(--sage-deep);line-height:1.65">\${s}</div>
    </div>\`;
  }catch{const sa=document.getElementById('summary-area');if(sa)sa.innerHTML='';}
}

async function draftReply(id){
  const email=DEMO_EMAILS.find(e=>e.id===id);
  if(!email)return;
  const btn=document.getElementById('draft-btn');
  if(btn){btn.disabled=true;btn.innerHTML='<div class="spinner"></div> Drafting…';}
  try{
    const r=await callClaude('Write a professional reply for Expert Physio. No subject line. Start with greeting. End with Expert Physio Team.\\n\\nFrom: '+email.name+'\\nSubject: '+email.subject+'\\nBody: '+email.body);
    const ra=document.getElementById('reply-area');const rt=document.getElementById('reply-text');
    if(ra&&rt){rt.value=r;ra.style.display='block';}
    if(btn)btn.style.display='none';
  }catch(e){showErr('Draft failed: '+e.message);if(btn){btn.disabled=false;btn.innerHTML='✨ Draft Reply';}}
}
function sendReply(id){
  const email=DEMO_EMAILS.find(e=>e.id===id);
  if(email){email.status='replied';showToast('✓ Reply sent to '+email.name);renderEmailList();}
  const rs=document.getElementById('reply-section');
  if(rs)rs.innerHTML='<div style="padding:11px 14px;background:var(--sage-pale);border:1px solid rgba(107,140,110,.2);border-radius:var(--radius-sm);font-size:13px;color:var(--sage-deep);font-weight:500">✓ Reply sent via Gmail</div>';
}
function discardReply(){
  const ra=document.getElementById('reply-area');const btn=document.getElementById('draft-btn');
  if(ra)ra.style.display='none';
  if(btn){btn.style.display='inline-flex';btn.innerHTML='✨ Draft Reply';btn.disabled=false;}
}

// ── COMPOSE ────────────────────────────────────────────────────────────────────
async function generateEmail(){
  const text=document.getElementById('compose-input').value.trim();
  if(!text)return;
  const btn=document.getElementById('compose-btn');
  const sp=document.getElementById('compose-spinner');
  const comp=document.getElementById('composed-email');
  btn.disabled=true;sp.style.display='flex';comp.style.display='none';
  try{
    const raw=await callClaude('Compose an Expert Physio clinic email: "'+text+'"\\n\\nReturn ONLY valid JSON: {"to":"email","subject":"subject","body":"body ending with Expert Physio Team"}. No markdown.');
    const clean=raw.replace(/^\`\`\`(?:json)?\\s*/i,'').replace(/\\s*\`\`\`\\s*$/,'').trim();
    const obj=JSON.parse(clean);
    document.getElementById('c-to').value=obj.to||'';
    document.getElementById('c-subject').value=obj.subject||'';
    document.getElementById('c-body').value=obj.body||'';
    comp.style.display='block';
  }catch(e){showErr('Compose failed: '+e.message);}
  finally{btn.disabled=false;sp.style.display='none';}
}
function sendComposed(){
  const s=document.getElementById('c-subject').value;
  showToast('✓ Email sent: "'+s+'"');
  discardComposed();
}
function discardComposed(){
  document.getElementById('composed-email').style.display='none';
  document.getElementById('compose-input').value='';
}

// ── INIT ───────────────────────────────────────────────────────────────────────
document.addEventListener('click',e=>{
  if(notifPanelOpen&&!document.getElementById('notif-panel').contains(e.target)&&!document.getElementById('bell-btn').contains(e.target)){
    notifPanelOpen=false;
    document.getElementById('notif-panel').style.display='none';
  }
});
refreshData();
setInterval(refreshData,8000);
showTab('Autopilot');
</script>
</body>
</html>`);
});

app.listen(parseInt(PORT), () => log(`Expert Physio Agent v3 running on port ${PORT}`, "success"));
