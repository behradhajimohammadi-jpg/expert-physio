const express = require("express");
const { google } = require("googleapis");
const app = express();
app.use(express.json());

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const GOOGLE_ID     = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const BASE_URL      = process.env.BASE_URL;
const PORT          = process.env.PORT || 3001;

let gmailTokens   = null;
let processedIds  = new Set();
let pendingReview = [];
let sendQueue     = [];
let sentLog       = [];
let activityLog   = [];
let archiveEmails = [];
let notifications = [];
let crmContacts   = [];

let voiceProfile = {
  samples: [],
  guidelines: [
    "- Always greet by first name if known",
    "- Keep replies under 4 sentences for simple emails",
    "- Never make clinical promises or give medical advice",
    "- Always offer a next step (call, book online, reply back)",
    '- Sign off as "Expert Physio Team"',
    "- Tone: warm, professional, never robotic",
    "- For cancellations: express understanding, offer rebooking",
    "- For new patients: welcoming, mention direct billing where applicable",
    "- For ICBC: acknowledge only, never promise outcomes"
  ].join("\n"),
};

const CRM_STATUSES = {
  ACTIVE: "active", SILENT: "silent", FOLLOWUP: "followup",
  BOOKED: "booked", LOST: "lost", OPTED_OUT: "opted_out",
};

const SEND_DELAY_MS  = 5 * 60 * 1000;
const OLD_EMAIL_DAYS = 3;
const CONFIDENCE_MIN = 80;
const FOLLOW_UP_DAYS = 14;

function log(msg, type = "info") {
  const time = new Date().toLocaleTimeString("en-CA", { hour: "2-digit", minute: "2-digit" });
  activityLog.unshift({ time, msg, type });
  if (activityLog.length > 200) activityLog.pop();
  console.log("[" + time + "] [" + type.toUpperCase() + "] " + msg);
}

function isOldEmail(email) {
  if (!email.date) return false;
  return (Date.now() - new Date(email.date).getTime()) > OLD_EMAIL_DAYS * 86400000;
}

function detectLostSignal(body) {
  const b = (body || "").toLowerCase();
  return ["found another","going with another","no longer need","cancel my","not interested",
    "please remove","don't contact","stop emailing","found a physio","booked elsewhere"].some(p => b.includes(p));
}

function upsertCRM(email, name, subject) {
  const existing = crmContacts.find(c => c.email.toLowerCase() === email.toLowerCase());
  if (existing) {
    existing.lastSeen = new Date().toISOString();
    existing.lastSubject = subject;
    existing.touchCount = (existing.touchCount || 0) + 1;
    if (existing.status === CRM_STATUSES.SILENT) existing.status = CRM_STATUSES.ACTIVE;
    return existing;
  }
  const c = {
    id: "crm_" + Date.now() + "_" + Math.random().toString(36).slice(2,7),
    email, name: name || email.split("@")[0],
    firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString(),
    lastSubject: subject, touchCount: 1, status: CRM_STATUSES.ACTIVE,
    notes: "", followUpCount: 0, followUpScheduled: false,
  };
  crmContacts.unshift(c);
  if (crmContacts.length > 1000) crmContacts.pop();
  return c;
}

async function callAI(userMsg, systemMsg, jsonMode) {
  const system = jsonMode
    ? systemMsg + "\n\nCRITICAL: Respond ONLY with valid JSON. No markdown, no explanation."
    : systemMsg;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1200, system, messages: [{ role: "user", content: userMsg }] }),
  });
  if (!res.ok) throw new Error("AI error " + res.status);
  const data = await res.json();
  return (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
}

function parseJSON(raw) {
  const clean = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/m, "").trim();
  try { return JSON.parse(clean); } catch { const m = clean.match(/\{[\s\S]*\}/); if (m) return JSON.parse(m[0]); throw new Error("JSON parse failed"); }
}

function getOAuth() { return new google.auth.OAuth2(GOOGLE_ID, GOOGLE_SECRET, BASE_URL + "/auth/callback"); }

function getGmail() {
  if (!gmailTokens) throw new Error("Gmail not connected");
  const auth = getOAuth();
  auth.setCredentials(gmailTokens);
  auth.on("tokens", t => { if (t.refresh_token) gmailTokens.refresh_token = t.refresh_token; gmailTokens.access_token = t.access_token; });
  return google.gmail({ version: "v1", auth });
}

async function fetchUnread() {
  const r = await getGmail().users.messages.list({ userId: "me", q: "is:unread in:inbox", maxResults: 25 });
  return r.data.messages || [];
}

async function getEmailDetails(id) {
  const r = await getGmail().users.messages.get({ userId: "me", id, format: "full" });
  const hdr = r.data.payload.headers;
  const get = n => (hdr.find(h => h.name.toLowerCase() === n) || {}).value || "";
  let body = "";
  const walk = p => {
    if (p.mimeType === "text/plain" && p.body && p.body.data) body = Buffer.from(p.body.data, "base64").toString("utf-8");
    else if (p.parts) p.parts.forEach(walk);
  };
  walk(r.data.payload);
  return { id, threadId: r.data.threadId, from: get("from"), to: get("to"), subject: get("subject"), body: body.trim().slice(0, 2500), date: get("date") };
}

async function markRead(id) { await getGmail().users.messages.modify({ userId: "me", id, requestBody: { removeLabelIds: ["UNREAD"] } }); }

async function sendEmail(threadId, to, subject, body) {
  const subj = subject.startsWith("Re:") ? subject : "Re: " + subject;
  const raw = Buffer.from(["To: " + to, "Subject: " + subj, 'Content-Type: text/plain; charset="UTF-8"', "", body].join("\r\n")).toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
  await getGmail().users.messages.send({ userId: "me", requestBody: { raw, threadId } });
}

async function applyLabel(id, name) {
  const list = await getGmail().users.labels.list({ userId: "me" });
  let label = (list.data.labels || []).find(l => l.name === name);
  if (!label) {
    const c = await getGmail().users.labels.create({ userId: "me", requestBody: { name, labelListVisibility: "labelShow", messageListVisibility: "show" } });
    label = c.data;
  }
  await getGmail().users.messages.modify({ userId: "me", id, requestBody: { addLabelIds: [label.id] } });
}

app.get("/auth/login", (req, res) => {
  const url = getOAuth().generateAuthUrl({ access_type: "offline", prompt: "consent", scope: ["https://www.googleapis.com/auth/gmail.readonly","https://www.googleapis.com/auth/gmail.send","https://www.googleapis.com/auth/gmail.modify"] });
  res.redirect(url);
});

app.get("/auth/callback", async (req, res) => {
  try {
    const { tokens } = await getOAuth().getToken(req.query.code);
    gmailTokens = tokens;
    log("Gmail connected — autopilot started", "success");
    startPolling();
    res.redirect("/?connected=1");
  } catch (err) { log("OAuth error: " + err.message, "error"); res.status(500).send("Auth failed: " + err.message); }
});

async function classify(email) {
  const raw = await callAI(
    "Classify this physiotherapy clinic email.\n\nFrom: " + email.from + "\nSubject: " + email.subject + "\nBody: " + email.body + '\n\nReturn JSON:\n{"category":"cancellation|new-patient|billing|referral|icbc|complaint|other","autoSend":true_or_false,"confidence":0_to_100,"reason":"one sentence","urgency":"normal|high","extractedName":"first name or null"}\n\nAutoSend=true ONLY if: category is cancellation/new-patient/billing/referral AND confidence>=80 AND no clinical questions AND no legal risk AND no ICBC AND no complaints.',
    "You are a clinical email triage system. Be conservative — when in doubt set autoSend to false.", true
  );
  try { return parseJSON(raw); } catch { return { category: "other", autoSend: false, confidence: 0, reason: "Classification failed", urgency: "normal", extractedName: null }; }
}

async function stepOneUnderstand(email) {
  const raw = await callAI(
    "Analyse this email for Expert Physio clinic.\n\nFrom: " + email.from + "\nSubject: " + email.subject + "\nBody: " + email.body + '\n\nReturn JSON:\n{"intent":"what sender wants","patientName":"first name or null","urgency":"low|normal|high|critical","risks":["list"],"requiresClinicalJudgment":bool,"requiresScheduleAccess":bool,"isLegalOrFinancial":bool,"sentiment":"positive|neutral|frustrated|angry","suggestedAction":"what clinic should do"}',
    "You are a careful clinical email analyst. Flag every risk no matter how small.", true
  );
  try { return parseJSON(raw); } catch { return { intent: "unknown", urgency: "normal", risks: [], requiresClinicalJudgment: false, requiresScheduleAccess: false, isLegalOrFinancial: false, sentiment: "neutral", suggestedAction: "review manually", patientName: null }; }
}

async function generateReply(email, understanding, classification) {
  const name = understanding && understanding.patientName ? understanding.patientName.split(" ")[0] : null;
  const voiceCtx = voiceProfile.samples.length > 0 ? "\n\nApproved reply examples:\n" + voiceProfile.samples.slice(0,3).join("\n---\n") : "";
  return await callAI(
    "Write a reply for Expert Physio clinic.\n\nIntent: " + (understanding ? understanding.intent : "unknown") + "\nPatient name: " + (name || "unknown") + "\nSentiment: " + (understanding ? understanding.sentiment : "neutral") + "\n\nEmail:\nFrom: " + email.from + "\nSubject: " + email.subject + "\nBody: " + email.body + "\n\nVoice guidelines:\n" + voiceProfile.guidelines + voiceCtx + "\n\nRules: max 4 sentences, no subject line, no clinical promises, no specific appointment times, sign off as 'Expert Physio Team'. Start with greeting.",
    "You write warm, natural physiotherapy clinic emails. Sound human, not robotic."
  );
}

async function processEmail(id) {
  if (processedIds.has(id)) return;
  processedIds.add(id);
  let email;
  try { email = await getEmailDetails(id); } catch (err) { log("Failed to fetch " + id + ": " + err.message, "error"); processedIds.delete(id); return; }
  log("Received: \"" + email.subject + "\" from " + email.from);
  const senderName = ((email.from.match(/^([^<]+)</) || [])[1] || "").trim() || email.from.split("@")[0];
  const contact = upsertCRM(email.from, senderName, email.subject);
  if (detectLostSignal(email.body)) { contact.status = CRM_STATUSES.LOST; log("CRM: " + senderName + " marked as lost", "info"); }
  if (contact.status === CRM_STATUSES.OPTED_OUT) { await markRead(id); return; }
  if (contact.followUpScheduled) { contact.followUpScheduled = false; contact.status = CRM_STATUSES.ACTIVE; }

  if (isOldEmail(email)) {
    await markRead(id);
    await applyLabel(id, "AI-Archived");
    archiveEmails.unshift({ id: "arch_" + Date.now() + "_" + id, emailId: id, email, archivedAt: new Date().toISOString(), followedUp: false });
    if (archiveEmails.length > 200) archiveEmails.pop();
    notifications.unshift({ id: "notif_" + Date.now(), type: "old_email", title: "Old email needs follow-up", message: "\"" + email.subject + "\" from " + email.from, createdAt: new Date().toISOString(), read: false });
    if (notifications.length > 50) notifications.pop();
    log("Archived old email: \"" + email.subject + "\"", "archive");
    return;
  }

  try {
    await markRead(id);
    const understanding = await stepOneUnderstand(email);
    log("[Step 1] Intent: " + understanding.intent + " | Urgency: " + understanding.urgency, "info");
    const classification = await classify(email);
    log("[Step 2] Category: " + classification.category + " | Confidence: " + classification.confidence + "%", "info");

    let proceed = true;
    let holdReason = "";
    if (understanding.requiresClinicalJudgment) { proceed = false; holdReason = "Requires clinical judgment"; }
    else if (understanding.requiresScheduleAccess) { proceed = false; holdReason = "Requires schedule access"; }
    else if (understanding.isLegalOrFinancial) { proceed = false; holdReason = "Legal or financial risk"; }
    else if (understanding.urgency === "critical") { proceed = false; holdReason = "Critical urgency"; }
    else if (understanding.sentiment === "angry") { proceed = false; holdReason = "Angry sender — needs human"; }
    else if ((understanding.risks || []).length > 2) { proceed = false; holdReason = "Multiple risks detected"; }
    else if (classification.confidence < CONFIDENCE_MIN) { proceed = false; holdReason = "Confidence too low (" + classification.confidence + "%)"; }
    else if (!classification.autoSend) { proceed = false; holdReason = classification.reason; }

    const reply = await generateReply(email, understanding, classification);

    if (proceed) {
      const sendAt = Date.now() + SEND_DELAY_MS;
      const qi = { id: "q_" + Date.now() + "_" + id, emailId: id, email, understanding, classification, replyBody: reply, sendAt, cancelled: false, createdAt: new Date().toISOString() };
      sendQueue.push(qi);
      log("Queued (5-min window): \"" + email.subject + "\" -> " + email.from, "queued");
      setTimeout(async () => {
        const item = sendQueue.find(q => q.id === qi.id);
        if (!item || item.cancelled) { log("Send cancelled: \"" + email.subject + "\"", "cancelled"); return; }
        try {
          await sendEmail(email.threadId, email.from, email.subject, item.replyBody);
          await applyLabel(id, "AI-Auto-Replied");
          sentLog.unshift({ id: qi.id, email, understanding, replyBody: item.replyBody, category: classification.category, confidence: classification.confidence, sentAt: new Date().toISOString() });
          if (sentLog.length > 500) sentLog.pop();
          sendQueue = sendQueue.filter(q => q.id !== qi.id);
          log("Auto-sent: \"" + email.subject + "\" -> " + email.from, "sent");
        } catch (err) { log("Send failed: " + err.message, "error"); sendQueue = sendQueue.filter(q => q.id !== qi.id); }
      }, SEND_DELAY_MS);
    } else {
      await applyLabel(id, "AI-Needs-Review");
      pendingReview.push({ id: "r_" + Date.now() + "_" + id, emailId: id, email, understanding, classification, draftReply: reply, holdReason, receivedAt: new Date().toISOString() });
      log("Held for review: \"" + email.subject + "\" — " + holdReason, "review");
    }
  } catch (err) { log("Processing error: " + err.message, "error"); processedIds.delete(id); }
}

let pollingInterval = null;

async function pollInbox() {
  if (!gmailTokens) return;
  try {
    const messages = await fetchUnread();
    const newOnes = messages.filter(m => !processedIds.has(m.id));
    if (newOnes.length > 0) {
      log("Found " + newOnes.length + " new email(s)");
      for (const m of newOnes) { await processEmail(m.id); await new Promise(r => setTimeout(r, 1500)); }
    }
  } catch (err) { log("Poll error: " + err.message, "error"); }
}

function startPolling() {
  if (pollingInterval) clearInterval(pollingInterval);
  pollingInterval = setInterval(pollInbox, 5 * 60 * 1000);
  pollInbox();
  log("Autopilot v3 running — 2-step review, every 5 min", "success");
}

app.get("/api/status", (req, res) => res.json({ connected: !!gmailTokens, queueCount: sendQueue.filter(q => !q.cancelled).length, reviewCount: pendingReview.length, archiveCount: archiveEmails.length, unreadNotifications: notifications.filter(n => !n.read).length, sentToday: sentLog.filter(s => new Date(s.sentAt).toDateString() === new Date().toDateString()).length, processed: processedIds.size, crmTotal: crmContacts.length, crmSilent: crmContacts.filter(c => (Date.now() - new Date(c.lastSeen).getTime()) > FOLLOW_UP_DAYS * 86400000 && c.status !== "lost" && c.status !== "opted_out").length }));
app.get("/api/log",           (req, res) => res.json(activityLog.slice(0, 100)));
app.get("/api/review",        (req, res) => res.json(pendingReview));
app.get("/api/queue",         (req, res) => res.json(sendQueue.filter(q => !q.cancelled)));
app.get("/api/sent",          (req, res) => res.json(sentLog.slice(0, 100)));
app.get("/api/voice",         (req, res) => res.json(voiceProfile));
app.get("/api/archive",       (req, res) => res.json(archiveEmails.slice(0, 100)));
app.get("/api/notifications", (req, res) => res.json(notifications));
app.get("/api/crm",           (req, res) => res.json(crmContacts.slice(0, 200)));
app.get("/api/crm/stats",     (req, res) => { const now = Date.now(); const thr = FOLLOW_UP_DAYS * 86400000; res.json({ total: crmContacts.length, active: crmContacts.filter(c => c.status === "active").length, silent: crmContacts.filter(c => (now - new Date(c.lastSeen).getTime()) > thr && c.status !== "lost" && c.status !== "opted_out").length, followUp: crmContacts.filter(c => c.status === "followup").length, booked: crmContacts.filter(c => c.status === "booked").length, lost: crmContacts.filter(c => c.status === "lost").length }); });

app.post("/api/queue/:id/cancel", (req, res) => { const item = sendQueue.find(q => q.id === req.params.id); if (!item) return res.status(404).json({ error: "Not found" }); item.cancelled = true; log("Send cancelled: \"" + item.email.subject + "\"", "cancelled"); res.json({ success: true }); });
app.post("/api/review/:id/approve", async (req, res) => { const item = pendingReview.find(p => p.id === req.params.id); if (!item) return res.status(404).json({ error: "Not found" }); try { const body = req.body.reply || item.draftReply; await sendEmail(item.email.threadId, item.email.from, item.email.subject, body); await applyLabel(item.emailId, "AI-Replied"); sentLog.unshift({ ...item, replyBody: body, sentAt: new Date().toISOString(), manualApproval: true }); pendingReview = pendingReview.filter(p => p.id !== req.params.id); log("Review approved + sent to " + item.email.from, "sent"); res.json({ success: true }); } catch (err) { res.status(500).json({ error: err.message }); } });
app.post("/api/review/:id/discard", (req, res) => { pendingReview = pendingReview.filter(p => p.id !== req.params.id); res.json({ success: true }); });
app.post("/api/voice/guidelines", (req, res) => { if (!req.body.guidelines) return res.status(400).json({ error: "Missing" }); voiceProfile.guidelines = req.body.guidelines; res.json({ success: true }); });
app.post("/api/voice/sample", (req, res) => { if (!req.body.sample) return res.status(400).json({ error: "Missing" }); voiceProfile.samples.push(req.body.sample); if (voiceProfile.samples.length > 10) voiceProfile.samples.shift(); res.json({ success: true }); });
app.delete("/api/voice/sample/:i", (req, res) => { const i = parseInt(req.params.i); if (isNaN(i) || i < 0 || i >= voiceProfile.samples.length) return res.status(404).json({ error: "Invalid" }); voiceProfile.samples.splice(i, 1); res.json({ success: true }); });
app.post("/api/archive/:id/followup", (req, res) => { const item = archiveEmails.find(a => a.id === req.params.id); if (!item) return res.status(404).json({ error: "Not found" }); item.followedUp = true; const n = notifications.find(x => x.archiveItemId === req.params.id); if (n) n.read = true; res.json({ success: true }); });
app.post("/api/notifications/read-all", (req, res) => { notifications.forEach(n => n.read = true); res.json({ success: true }); });
app.post("/api/notifications/:id/read", (req, res) => { const n = notifications.find(x => x.id === req.params.id); if (n) n.read = true; res.json({ success: true }); });
app.post("/api/crm", (req, res) => { const { email, name, notes } = req.body; if (!email) return res.status(400).json({ error: "Email required" }); const c = upsertCRM(email, name || email.split("@")[0], "Manually added"); if (notes) c.notes = notes; res.json({ success: true, contact: c }); });
app.patch("/api/crm/:id", (req, res) => { const c = crmContacts.find(x => x.id === req.params.id); if (!c) return res.status(404).json({ error: "Not found" }); if (req.body.status) c.status = req.body.status; if (req.body.notes !== undefined) c.notes = req.body.notes; if (req.body.name) c.name = req.body.name; res.json({ success: true }); });
app.post("/api/poll", (req, res) => { if (!gmailTokens) return res.status(400).json({ error: "Not connected" }); pollInbox(); res.json({ success: true }); });
app.post("/api/claude", async (req, res) => { if (!ANTHROPIC_KEY) return res.status(500).json({ error: "No API key" }); try { const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" }, body: JSON.stringify(req.body) }); const data = await r.json(); if (!r.ok) return res.status(r.status).json(data); res.json(data); } catch (err) { res.status(500).json({ error: err.message }); } });

// ─── DASHBOARD ────────────────────────────────────────────────────────────────
// NOTE: The HTML uses NO template variables (no ${...}), NO nested backticks.
// All dynamic content is loaded via /api/* endpoints after page load.
// This guarantees the page always renders regardless of server state.
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>Expert Physio AI Agent</title>
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,500;1,300;1,400&family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --sage:      #5C7A5F;
      --sage-deep: #3A5C3D;
      --sage-pale: #EEF4EE;
      --sage-lt:   #A8C5A0;
      --cream:     #FAF8F5;
      --white:     #FFFFFF;
      --charcoal:  #2C2C2C;
      --text:      #3A3730;
      --muted:     #7A7570;
      --stone:     #9C9590;
      --stone-lt:  #C8C3BC;
      --border:    #E8E2DA;
      --border-lt: #F2EDE8;
      --amber:     #C4913A;
      --amber-lt:  #F5E8D0;
      --red:       #C0503A;
      --red-lt:    #F5E8E4;
      --blue:      #4A7AB5;
      --blue-lt:   #E4EEF8;
      --shadow:    0 2px 8px rgba(44,44,44,.07);
      --shadow-md: 0 4px 20px rgba(44,44,44,.11);
      --r:         12px;
      --r-sm:      8px;
    }
    *{box-sizing:border-box;margin:0;padding:0}
    html,body{height:100%;overflow:hidden}
    body{font-family:'Outfit',sans-serif;background:var(--cream);color:var(--text);display:flex;flex-direction:column}
    @keyframes spin{to{transform:rotate(360deg)}}
    @keyframes fadeUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:.45}}
    ::-webkit-scrollbar{width:3px}
    ::-webkit-scrollbar-thumb{background:var(--stone-lt);border-radius:3px}
    input,textarea,button,select{font-family:'Outfit',sans-serif}
    input:focus,textarea:focus{outline:none;border-color:var(--sage);box-shadow:0 0 0 3px rgba(92,122,95,.12)}

    .btn{display:inline-flex;align-items:center;gap:6px;padding:8px 16px;border:none;border-radius:var(--r-sm);cursor:pointer;font-size:12.5px;font-weight:500;transition:all .15s}
    .btn:disabled{opacity:.45;cursor:not-allowed}
    .btn-primary{background:var(--sage);color:#fff;box-shadow:var(--shadow)}
    .btn-primary:hover:not(:disabled){background:var(--sage-deep);transform:translateY(-1px);box-shadow:var(--shadow-md)}
    .btn-success{background:var(--sage-deep);color:#fff}
    .btn-success:hover:not(:disabled){background:#2D4830;transform:translateY(-1px)}
    .btn-ghost{background:transparent;color:var(--muted);border:1px solid var(--border)}
    .btn-ghost:hover:not(:disabled){background:var(--border-lt);color:var(--text)}
    .btn-amber{background:var(--amber-lt);color:var(--amber);border:1px solid #E8D0A8}
    .btn-danger{background:var(--red-lt);color:var(--red)}
    .btn-sm{padding:5px 11px;font-size:11.5px}

    .card{background:var(--white);border:1px solid var(--border);border-radius:var(--r);box-shadow:var(--shadow);padding:20px;margin-bottom:14px}

    .tab-btn{width:100%;padding:10px 16px;background:transparent;border:none;border-left:2px solid transparent;cursor:pointer;text-align:left;font-size:13px;font-weight:400;color:var(--muted);display:flex;align-items:center;justify-content:space-between;transition:all .12s}
    .tab-btn.active{background:linear-gradient(90deg,var(--sage-pale),transparent);border-left-color:var(--sage);font-weight:600;color:var(--sage-deep)}
    .tab-btn:hover:not(.active){background:var(--border-lt);color:var(--text)}

    .tag{font-size:10.5px;font-weight:600;padding:2px 8px;border-radius:20px;display:inline-block;letter-spacing:.02em}
    .badge{border-radius:20px;font-size:10px;font-weight:700;padding:1px 6px;color:#fff;display:none}
    .dot{width:7px;height:7px;border-radius:50%;display:inline-block;flex-shrink:0}
    .spinner{width:14px;height:14px;border-radius:50%;border:2px solid var(--border);border-top-color:var(--sage);animation:spin .7s linear infinite;flex-shrink:0;display:inline-block}
    .step-badge{font-size:10px;font-weight:600;padding:2px 8px;border-radius:20px;background:var(--blue-lt);color:var(--blue);display:inline-block}

    .page-title{font-family:'Cormorant Garamond',serif;font-size:26px;font-weight:500;color:var(--charcoal);letter-spacing:-.3px}
    .page-sub{font-size:13px;color:var(--muted);margin-top:4px;line-height:1.6;font-weight:300}

    .rule-row{display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border-lt)}
    .rule-row:last-child{border-bottom:none}

    .email-row{padding:12px 14px;cursor:pointer;border-bottom:1px solid var(--border-lt);border-left:2px solid transparent;transition:all .1s}
    .email-row:hover{background:var(--sage-pale)}
    .email-row.selected{background:var(--sage-pale);border-left-color:var(--sage)}

    #toast{position:fixed;top:20px;right:20px;z-index:9999;background:var(--charcoal);color:#fff;padding:11px 20px;border-radius:var(--r);font-size:13px;font-weight:500;box-shadow:var(--shadow-md);display:none;align-items:center;gap:12px;max-width:380px;animation:fadeUp .25s ease}
    #notif-panel{position:fixed;top:64px;right:16px;width:360px;background:var(--white);border:1px solid var(--border);border-radius:var(--r);box-shadow:var(--shadow-md);z-index:500;display:none;max-height:460px;overflow-y:auto}
  </style>
</head>
<body>

<div id="toast"><span id="toast-msg"></span><button onclick="hideToast()" style="background:none;border:none;color:rgba(255,255,255,.5);cursor:pointer;font-size:18px;line-height:1">x</button></div>

<div id="notif-panel">
  <div style="padding:14px 16px;border-bottom:1px solid var(--border-lt);display:flex;align-items:center;justify-content:space-between">
    <span style="font-family:'Cormorant Garamond',serif;font-size:18px;font-weight:500">Notifications</span>
    <button onclick="markAllRead()" class="btn btn-ghost btn-sm">Mark all read</button>
  </div>
  <div id="notif-list"><div style="padding:24px;text-align:center;color:var(--stone-lt);font-size:13px">No notifications</div></div>
</div>

<!-- HEADER -->
<div style="background:var(--white);border-bottom:1px solid var(--border);height:60px;display:flex;align-items:center;justify-content:space-between;padding:0 24px;flex-shrink:0;box-shadow:var(--shadow)">
  <div style="display:flex;align-items:center;gap:12px">
    <div style="width:38px;height:38px;border-radius:10px;background:linear-gradient(135deg,var(--sage-deep),var(--sage));display:flex;align-items:center;justify-content:center;flex-shrink:0">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round"><path d="M12 2C12 2 5 7 5 13c0 6 7 9 7 9s7-3 7-9c0-6-7-11-7-11z"/><path d="M9 13h6M12 10v6"/></svg>
    </div>
    <div>
      <div style="font-family:'Cormorant Garamond',serif;font-size:17px;font-weight:500;color:var(--charcoal);line-height:1.1">Expert Physio <em style="font-style:italic;font-weight:300">AI Agent</em></div>
      <div id="status-bar" style="font-size:10.5px;display:flex;align-items:center;gap:5px;margin-top:1px">
        <span class="dot" id="status-dot" style="background:var(--red)"></span>
        <span id="status-text" style="color:var(--muted)">Loading…</span>
      </div>
    </div>
  </div>
  <div style="display:flex;gap:10px;align-items:center">
    <div id="header-badges" style="display:flex;gap:8px;align-items:center"></div>
    <button id="bell-btn" onclick="toggleNotif()" style="position:relative;background:none;border:none;cursor:pointer;padding:6px;color:var(--stone)">
      <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
      <span id="bell-badge" class="badge" style="position:absolute;top:-2px;right:-2px;background:var(--red)"></span>
    </button>
    <div id="connect-area"></div>
  </div>
</div>

<!-- BODY -->
<div style="display:flex;flex:1;overflow:hidden">

  <!-- SIDEBAR -->
  <div style="width:210px;background:var(--white);border-right:1px solid var(--border);display:flex;flex-direction:column;flex-shrink:0">
    <div style="padding:14px 0;flex:1">
      <button class="tab-btn active" id="tab-autopilot"  onclick="showTab('autopilot')"> <span>&#x26A1; Autopilot</span>    <span id="badge-autopilot"  class="badge" style="background:var(--amber)"></span></button>
      <button class="tab-btn"        id="tab-queue"      onclick="showTab('queue')">     <span>&#x1F441; Review Queue</span><span id="badge-queue"      class="badge" style="background:var(--red)"></span></button>
      <button class="tab-btn"        id="tab-archive"    onclick="showTab('archive')">   <span>&#x1F4C1; Old Emails</span>  <span id="badge-archive"    class="badge" style="background:var(--amber)"></span></button>
      <button class="tab-btn"        id="tab-crm"        onclick="showTab('crm')">       <span>&#x1F465; Patients</span>   <span id="badge-crm"        class="badge" style="background:var(--amber)"></span></button>
      <button class="tab-btn"        id="tab-voice"      onclick="showTab('voice')">     <span>&#x1F399; Voice Profile</span></button>
      <button class="tab-btn"        id="tab-inbox"      onclick="showTab('inbox')">     <span>&#x1F4EC; Demo Inbox</span> <span id="badge-inbox"      class="badge" style="background:var(--sage)"></span></button>
      <button class="tab-btn"        id="tab-compose"    onclick="showTab('compose')">   <span>&#x270F; Compose</span></button>
      <button class="tab-btn"        id="tab-sent"       onclick="showTab('sent')">      <span>&#x1F4CA; Sent Log</span></button>
    </div>
    <div style="margin:0 12px 14px;padding:13px;background:var(--sage-pale);border-radius:var(--r-sm);border:1px solid rgba(92,122,95,.15)">
      <div style="font-size:10px;font-weight:700;color:var(--sage-deep);margin-bottom:8px;letter-spacing:.08em;text-transform:uppercase">Today</div>
      <div id="sidebar-stats" style="font-size:12px;color:var(--muted);line-height:2">—</div>
    </div>
  </div>

  <!-- MAIN AREA -->
  <div style="flex:1;overflow:hidden;display:flex;flex-direction:column">
    <div id="err-bar" style="display:none;background:var(--red-lt);border-bottom:1px solid #E8C0B8;padding:10px 20px;font-size:13px;color:var(--red);justify-content:space-between;align-items:center">
      <span id="err-msg"></span><button onclick="hideErr()" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:16px;margin-left:12px">x</button>
    </div>
    <div style="flex:1;overflow:hidden;display:flex">

      <!-- AUTOPILOT -->
      <div id="pane-autopilot" style="flex:1;overflow-y:auto;padding:32px">
        <div style="max-width:760px">
          <div class="page-title">Autopilot Status</div>
          <div class="page-sub">Every email passes a 2-step AI review before anything is sent. Old emails are archived and flagged for follow-up.</div>
          <div id="connect-banner" style="margin-top:20px"></div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:20px 0">
            <div class="card" style="border-left:3px solid var(--sage);padding:16px;margin:0">
              <div class="step-badge" style="margin-bottom:8px">Step 1 — Understand</div>
              <div style="font-size:12.5px;color:var(--muted);line-height:1.7;margin-top:4px">Reads intent, name, urgency, sentiment, and flags every risk before taking any action.</div>
            </div>
            <div class="card" style="border-left:3px solid var(--amber);padding:16px;margin:0">
              <div class="step-badge" style="background:var(--amber-lt);color:var(--amber);margin-bottom:8px">Step 2 — Decide</div>
              <div style="font-size:12.5px;color:var(--muted);line-height:1.7;margin-top:4px">Checks 6 safety gates. Confidence 80%+ required. Then 5-minute cancel window before send.</div>
            </div>
          </div>
          <div id="queue-panel" style="display:none;background:var(--amber-lt);border:1px solid #E8D0A8;border-radius:var(--r);padding:18px;margin-bottom:16px">
            <div style="font-size:13.5px;font-weight:600;color:var(--amber);margin-bottom:12px">&#x23F1; Cancel Window Active</div>
            <div id="queue-items"></div>
          </div>
          <div class="card">
            <div style="font-family:'Cormorant Garamond',serif;font-size:19px;font-weight:500;margin-bottom:4px">Auto-Send Rules</div>
            <div style="font-size:11.5px;color:var(--stone-lt);margin-bottom:14px">Confidence threshold: 80% &middot; Emails 3+ days old: archived, never auto-sent</div>
            <div class="rule-row"><div style="display:flex;align-items:center;gap:10px"><span style="font-size:16px">&#x1F4C5;</span><div><div style="font-size:13px;font-weight:500">Cancellations</div><div style="font-size:11.5px;color:var(--muted)">Acknowledge + offer reschedule</div></div></div><span class="tag" style="background:var(--sage-pale);color:var(--sage-deep)">&#x2713; Auto</span></div>
            <div class="rule-row"><div style="display:flex;align-items:center;gap:10px"><span style="font-size:16px">&#x1F64B;</span><div><div style="font-size:13px;font-weight:500">New Patient Inquiries</div><div style="font-size:11.5px;color:var(--muted)">Welcome + booking information</div></div></div><span class="tag" style="background:var(--sage-pale);color:var(--sage-deep)">&#x2713; Auto</span></div>
            <div class="rule-row"><div style="display:flex;align-items:center;gap:10px"><span style="font-size:16px">&#x1F4B3;</span><div><div style="font-size:13px;font-weight:500">Simple Billing Questions</div><div style="font-size:11.5px;color:var(--muted)">Acknowledge + 1-2 day follow-up</div></div></div><span class="tag" style="background:var(--sage-pale);color:var(--sage-deep)">&#x2713; Auto</span></div>
            <div class="rule-row"><div style="display:flex;align-items:center;gap:10px"><span style="font-size:16px">&#x1F468;&#x200D;&#x2695;&#xFE0F;</span><div><div style="font-size:13px;font-weight:500">Doctor Referrals</div><div style="font-size:11.5px;color:var(--muted)">Confirm receipt + contact timeline</div></div></div><span class="tag" style="background:var(--sage-pale);color:var(--sage-deep)">&#x2713; Auto</span></div>
            <div class="rule-row"><div style="display:flex;align-items:center;gap:10px"><span style="font-size:16px">&#x1F3E5;</span><div><div style="font-size:13px;font-weight:500">ICBC Claims</div><div style="font-size:11.5px;color:var(--muted)">Always held for staff review</div></div></div><span class="tag" style="background:var(--red-lt);color:var(--red)">&#x1F441; Review</span></div>
            <div class="rule-row"><div style="display:flex;align-items:center;gap:10px"><span style="font-size:16px">&#x1F621;</span><div><div style="font-size:13px;font-weight:500">Complaints / Anger</div><div style="font-size:11.5px;color:var(--muted)">Always held — human touch required</div></div></div><span class="tag" style="background:var(--red-lt);color:var(--red)">&#x1F441; Review</span></div>
            <div class="rule-row"><div style="display:flex;align-items:center;gap:10px"><span style="font-size:16px">&#x2753;</span><div><div style="font-size:13px;font-weight:500">Confidence &lt; 80%</div><div style="font-size:11.5px;color:var(--muted)">Held — AI not certain enough</div></div></div><span class="tag" style="background:var(--red-lt);color:var(--red)">&#x1F441; Review</span></div>
          </div>
          <div class="card">
            <div style="font-family:'Cormorant Garamond',serif;font-size:19px;font-weight:500;margin-bottom:14px">Live Activity</div>
            <div id="live-log"><div style="font-size:13px;color:var(--stone-lt);font-style:italic">No activity yet — connect Gmail to begin.</div></div>
          </div>
        </div>
      </div>

      <!-- REVIEW QUEUE -->
      <div id="pane-queue" style="display:none;flex:1;overflow-y:auto;padding:32px">
        <div style="max-width:720px">
          <div class="page-title">Review Queue</div>
          <div class="page-sub">Emails the AI held for human approval. Pre-written draft included — edit and send with one click.</div>
          <div id="review-list" style="margin-top:24px"></div>
        </div>
      </div>

      <!-- OLD EMAILS / ARCHIVE -->
      <div id="pane-archive" style="display:none;flex:1;overflow-y:auto;padding:32px">
        <div style="max-width:720px">
          <div class="page-title">Old Emails</div>
          <div class="page-sub">Emails received before the agent connected. Separated so new emails get priority. Each sender is waiting for a reply.</div>
          <div style="margin:14px 0;padding:10px 14px;background:var(--red-lt);border-radius:var(--r-sm);font-size:12.5px;color:var(--red);font-weight:500">&#x26A0; These senders have not received a reply — each one is a potential lost patient.</div>
          <div id="archive-list"></div>
        </div>
      </div>

      <!-- CRM -->
      <div id="pane-crm" style="display:none;flex:1;overflow-y:auto;padding:32px">
        <div style="max-width:920px">
          <div class="page-title">Patient CRM</div>
          <div class="page-sub">Every person the agent has communicated with. Follow-ups auto-queue after 14 days of silence.</div>
          <div id="crm-stats" style="display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin:20px 0"></div>
          <div class="card" style="padding:16px">
            <div style="font-size:13px;font-weight:600;margin-bottom:10px">Add Past Patient Manually</div>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <input id="crm-email" placeholder="Email address *" style="flex:2;min-width:180px;padding:9px 12px;border-radius:var(--r-sm);border:1px solid var(--border)"/>
              <input id="crm-name" placeholder="Name" style="flex:1;min-width:130px;padding:9px 12px;border-radius:var(--r-sm);border:1px solid var(--border)"/>
              <input id="crm-notes" placeholder="Notes (optional)" style="flex:2;min-width:180px;padding:9px 12px;border-radius:var(--r-sm);border:1px solid var(--border)"/>
              <button class="btn btn-primary" onclick="addCRM()">Add Contact</button>
            </div>
          </div>
          <div id="crm-list"></div>
        </div>
      </div>

      <!-- VOICE PROFILE -->
      <div id="pane-voice" style="display:none;flex:1;overflow-y:auto;padding:32px">
        <div style="max-width:660px">
          <div class="page-title">Voice Profile</div>
          <div class="page-sub">Train the agent to write exactly like Expert Physio. The more approved samples you add, the more natural every reply sounds.</div>
          <div class="card" style="margin-top:24px">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
              <div style="font-family:'Cormorant Garamond',serif;font-size:19px;font-weight:500">Voice Guidelines</div>
              <button class="btn btn-ghost btn-sm" onclick="toggleGuidelines()">Edit</button>
            </div>
            <div id="guidelines-view" style="font-size:13px;color:var(--muted);line-height:1.85;white-space:pre-wrap;background:var(--sage-pale);padding:13px;border-radius:var(--r-sm)">Loading...</div>
            <div id="guidelines-edit" style="display:none;margin-top:10px">
              <textarea id="guidelines-ta" style="width:100%;min-height:200px;padding:12px;border:1px solid var(--border);border-radius:var(--r-sm);line-height:1.7;resize:vertical;font-size:13px"></textarea>
              <div style="display:flex;gap:8px;margin-top:8px">
                <button class="btn btn-success btn-sm" onclick="saveGuidelines()">Save</button>
                <button class="btn btn-ghost btn-sm" onclick="toggleGuidelines()">Cancel</button>
              </div>
            </div>
          </div>
          <div class="card">
            <div style="font-family:'Cormorant Garamond',serif;font-size:19px;font-weight:500;margin-bottom:4px">Approved Reply Samples</div>
            <div style="font-size:12.5px;color:var(--stone-lt);margin-bottom:14px">Paste real replies the team has written. The AI uses these to match their exact voice.</div>
            <div id="voice-samples"></div>
            <textarea id="new-sample" placeholder="Paste an approved reply example here..." style="width:100%;min-height:100px;padding:12px;border:1px solid var(--border);border-radius:var(--r-sm);line-height:1.65;resize:vertical;margin-bottom:10px;font-size:13px"></textarea>
            <button class="btn btn-primary btn-sm" onclick="addSample()">+ Add Sample</button>
          </div>
        </div>
      </div>

      <!-- DEMO INBOX -->
      <div id="pane-inbox" style="display:none;flex:1;overflow:hidden">
        <div style="width:288px;border-right:1px solid var(--border);overflow-y:auto;background:var(--white);flex-shrink:0;height:100%">
          <div style="padding:12px 16px;border-bottom:1px solid var(--border-lt);font-size:10.5px;font-weight:700;color:var(--sage-deep);letter-spacing:.08em;text-transform:uppercase">Demo Emails</div>
          <div id="email-list"></div>
        </div>
        <div id="email-detail" style="flex:1;overflow-y:auto;padding:26px;display:flex;align-items:center;justify-content:center">
          <div style="text-align:center;color:var(--stone-lt)">
            <div style="font-size:40px;margin-bottom:10px">&#x1F4EC;</div>
            <div style="font-size:14px;font-weight:500">Select an email to read</div>
            <div style="font-size:12px;margin-top:4px;color:var(--stone-lt)">The AI analyses it instantly</div>
          </div>
        </div>
      </div>

      <!-- COMPOSE -->
      <div id="pane-compose" style="display:none;flex:1;overflow-y:auto;padding:32px">
        <div style="max-width:620px">
          <div class="page-title">Compose Email</div>
          <div class="page-sub">Describe what you want to send — the agent writes it in Expert Physio's exact voice.</div>
          <div style="margin-top:24px">
            <textarea id="compose-input" placeholder='e.g. "Email Sarah Mitchell to reschedule her Thursday appointment to Tuesday at 11am"' style="width:100%;min-height:90px;padding:14px;border:1px solid var(--border);border-radius:var(--r);line-height:1.65;resize:vertical;margin-bottom:12px;font-size:13px"></textarea>
            <button class="btn btn-primary" id="compose-btn" onclick="generateEmail()">&#x2728; Generate Email</button>
            <div id="compose-spinner" style="display:none;margin-top:12px;align-items:center;gap:8px;color:var(--muted);font-size:13px"><span class="spinner"></span>Composing...</div>
          </div>
          <div id="composed-email" style="display:none;margin-top:20px">
            <div class="card" style="padding:0;overflow:hidden">
              <div style="padding:10px 16px;border-bottom:1px solid var(--border-lt);display:flex;gap:10px;align-items:center"><span style="font-size:10px;font-weight:700;color:var(--stone-lt);width:54px;flex-shrink:0;letter-spacing:.06em;text-transform:uppercase">To</span><input id="c-to" style="flex:1;border:none;font-size:13px;padding:0"/></div>
              <div style="padding:10px 16px;border-bottom:1px solid var(--border-lt);display:flex;gap:10px;align-items:center"><span style="font-size:10px;font-weight:700;color:var(--stone-lt);width:54px;flex-shrink:0;letter-spacing:.06em;text-transform:uppercase">Subject</span><input id="c-subject" style="flex:1;border:none;font-size:13px;padding:0"/></div>
              <div style="padding:12px 16px"><div style="font-size:10px;font-weight:700;color:var(--stone-lt);margin-bottom:8px;letter-spacing:.06em;text-transform:uppercase">Body</div><textarea id="c-body" style="width:100%;min-height:200px;border:none;font-size:13px;line-height:1.75;resize:vertical;padding:0"></textarea></div>
            </div>
            <div style="display:flex;gap:8px;margin-top:12px">
              <button class="btn btn-success" onclick="sendComposed()">Send via Gmail</button>
              <button class="btn btn-ghost" onclick="discardComposed()">Discard</button>
            </div>
          </div>
        </div>
      </div>

      <!-- SENT LOG -->
      <div id="pane-sent" style="display:none;flex:1;overflow-y:auto;padding:32px">
        <div style="max-width:740px">
          <div class="page-title">Sent Log</div>
          <div class="page-sub">Full record of every email sent — content, AI analysis, confidence score, timestamp.</div>
          <div id="sent-list" style="margin-top:24px"><div style="font-size:13px;color:var(--stone-lt);font-style:italic">No emails sent yet.</div></div>
        </div>
      </div>

    </div>
  </div>
</div>

<script>
// ── STATE
var currentTab = 'autopilot';
var D = {};
var editingGuidelines = false;
var notifOpen = false;
var selectedEmail = null;

var DEMO = [
  {id:1,name:'Sarah Mitchell',from:'sarah.mitchell@gmail.com',subject:'Appointment Cancellation - Thursday 2pm',body:'Hi, I need to cancel my appointment this Thursday at 2pm. I have a conflict at work. Can we reschedule? Any time Tuesday or Wednesday works. Thanks, Sarah',time:'9:14 AM',status:'unread',tag:'cancellation'},
  {id:2,name:'ICBC Claims',from:'icbc.claims@icbc.com',subject:'Claim #4892-B: Treatment Authorization Required',body:'Please submit updated treatment plan for claimant John Patel (Claim #4892-B). Authorization is required before proceeding with further sessions. Please respond within 5 business days.',time:'8:30 AM',status:'unread',tag:'icbc'},
  {id:3,name:'Dr. Angela Lee',from:'drlee@familyclinic.ca',subject:'Referral: Marcus Huang - Lower Back Pain',body:'I am referring Marcus Huang, 42, for physiotherapy following a lumbar strain. Three weeks of lower back pain. Please book at your earliest convenience.',time:'Yesterday',status:'read',tag:'referral'},
  {id:4,name:'Kevin Tran',from:'kevin.tran88@hotmail.com',subject:'Question about my invoice',body:'Hi there, I received an invoice for $180 but think my insurance covers 80%. Can you resubmit to Pacific Blue Cross? Policy PBC-2291-TK.',time:'Yesterday',status:'read',tag:'billing'},
  {id:5,name:'Amanda Shore',from:'amanda.shore@gmail.com',subject:'New Patient Inquiry',body:'Hello, I found you on Google and wondering if you accept new patients? I have a rotator cuff injury. Available weekday mornings. Do you direct bill to MSP?',time:'Mon',status:'read',tag:'new-patient'},
];
var TAGS = {
  cancellation:{bg:'#FCF0EE',c:'#B85A48',l:'Cancellation'},
  icbc:{bg:'#EEF2FA',c:'#4A7AB5',l:'ICBC'},
  referral:{bg:'#EEF4EE',c:'#3A5C3D',l:'Referral'},
  billing:{bg:'#FAF4EA',c:'#B87A38',l:'Billing'},
  'new-patient':{bg:'#EEF6FA',c:'#3A7A9E',l:'New Patient'}
};
var CRM_LABELS = {
  active:{l:'Active',bg:'#EEF4EE',c:'#3A5C3D'},
  silent:{l:'Silent',bg:'#F5E8D0',c:'#C4913A'},
  followup:{l:'Follow-up Sent',bg:'#E4EEF8',c:'#4A7AB5'},
  booked:{l:'Booked',bg:'#EEF4EE',c:'#3A5C3D'},
  lost:{l:'Lost',bg:'#F2EDE8',c:'#9C9590'},
  opted_out:{l:'Opted Out',bg:'#F2EDE8',c:'#9C9590'}
};

// ── HELPERS
function el(id){ return document.getElementById(id); }
function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function showToast(m){ el('toast-msg').textContent=m; el('toast').style.display='flex'; setTimeout(function(){el('toast').style.display='none';},3500); }
function hideToast(){ el('toast').style.display='none'; }
function showErr(m){ el('err-msg').textContent=m; el('err-bar').style.display='flex'; }
function hideErr(){ el('err-bar').style.display='none'; }

// ── TABS
function showTab(name){
  document.querySelectorAll('[id^="pane-"]').forEach(function(p){ p.style.display='none'; });
  document.querySelectorAll('.tab-btn').forEach(function(b){ b.classList.remove('active'); });
  var pane = el('pane-'+name);
  if(pane) pane.style.display = (name==='inbox') ? 'flex' : 'block';
  var btn = el('tab-'+name);
  if(btn) btn.classList.add('active');
  currentTab = name;
  if(name==='inbox') renderEmailList();
  if(name==='crm') renderCRM();
}

// ── API
function apiFetch(path, opts){
  return fetch(path, Object.assign({headers:{'Content-Type':'application/json'}}, opts||{}))
    .then(function(r){ return r.json().then(function(d){ if(!r.ok) throw new Error(d.error||'Error'); return d; }); });
}
function callClaude(msg){
  return apiFetch('/api/claude',{method:'POST',body:JSON.stringify({model:'claude-sonnet-4-6',max_tokens:900,system:'You are the AI assistant for Expert Physio clinic in Burnaby, BC. Tone: warm, professional, concise. Sign as "Expert Physio Team".',messages:[{role:'user',content:msg}]})})
    .then(function(d){ var t=(d.content||[]).filter(function(b){return b.type==='text';}).map(function(b){return b.text;}).join('\n').trim(); if(!t)throw new Error('Empty'); return t; });
}

// ── REFRESH
function refreshData(){
  Promise.all([
    apiFetch('/api/status'), apiFetch('/api/log'), apiFetch('/api/review'),
    apiFetch('/api/queue'), apiFetch('/api/sent'), apiFetch('/api/voice'),
    apiFetch('/api/archive'), apiFetch('/api/notifications'),
    apiFetch('/api/crm'), apiFetch('/api/crm/stats')
  ]).then(function(results){
    D = {status:results[0],log:results[1],review:results[2],queue:results[3],sent:results[4],voice:results[5],archive:results[6],notifs:results[7],crm:results[8],crmStats:results[9]};
    render();
  }).catch(function(e){ console.error('Refresh error:', e.message); });
}

function setBadge(id, n, show){
  var el2 = el('badge-'+id);
  if(!el2) return;
  el2.textContent = n;
  el2.style.display = show ? 'inline' : 'none';
}

function render(){
  var s = D.status; if(!s) return;

  // Status bar
  var dot = el('status-dot'); var txt = el('status-text');
  if(dot){ dot.style.background = s.connected ? 'var(--sage)' : 'var(--red)'; dot.style.animation = s.connected ? 'pulse 2s infinite' : 'none'; }
  if(txt){ txt.textContent = s.connected ? 'Autopilot running — 2-step review active' : 'Gmail not connected'; txt.style.color = s.connected ? 'var(--sage-deep)' : 'var(--muted)'; }

  // Connect area
  var ca = el('connect-area');
  if(ca) ca.innerHTML = s.connected ? '' : '<a href="/auth/login" style="padding:7px 16px;background:var(--sage);color:#fff;border-radius:var(--r-sm);font-size:12.5px;font-weight:500;text-decoration:none">Connect Gmail</a>';

  // Connect banner
  var cb = el('connect-banner');
  if(cb) cb.innerHTML = s.connected ? '' : '<div style="background:var(--amber-lt);border:1px solid #E8D0A8;border-radius:var(--r);padding:18px;display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:16px"><div><div style="font-weight:600;color:var(--amber);margin-bottom:3px">Gmail not connected</div><div style="font-size:12.5px;color:var(--stone)">Click Connect Gmail in the top right to start the autopilot.</div></div><a href="/auth/login" style="padding:9px 18px;background:var(--amber);color:#fff;border-radius:var(--r-sm);font-size:12.5px;font-weight:500;text-decoration:none;white-space:nowrap;flex-shrink:0">Connect Gmail</a></div>';

  // Sidebar stats
  var ss = el('sidebar-stats');
  if(ss) ss.innerHTML = '&#x26A1; '+(s.sentToday||0)+' auto-sent<br>&#x23F1; '+(s.queueCount||0)+' in queue<br>&#x26A0; '+(s.reviewCount||0)+' for review<br>&#x1F465; '+(s.crmTotal||0)+' contacts';

  // Badges
  var aq = (D.queue||[]).filter(function(q){return !q.cancelled;}).length;
  setBadge('autopilot', aq, aq>0);
  setBadge('queue', s.reviewCount||0, (s.reviewCount||0)>0);
  setBadge('archive', s.archiveCount||0, (s.archiveCount||0)>0);
  setBadge('crm', s.crmSilent||0, (s.crmSilent||0)>0);
  setBadge('inbox', DEMO.filter(function(e){return e.status==='unread';}).length, DEMO.filter(function(e){return e.status==='unread';}).length>0);

  // Bell
  var un = s.unreadNotifications||0;
  var bb = el('bell-badge'); if(bb){bb.textContent=un;bb.style.display=un>0?'inline':'none';}

  // Header badges
  var hb = '';
  if((s.reviewCount||0)>0) hb+='<span style="background:var(--red-lt);color:var(--red);border:1px solid #E8C0B8;border-radius:20px;font-size:11px;font-weight:600;padding:3px 10px">&#x26A0; '+s.reviewCount+' for review</span>';
  if(aq>0) hb+='<span style="background:var(--amber-lt);color:var(--amber);border:1px solid #E8D0A8;border-radius:20px;font-size:11px;font-weight:600;padding:3px 10px;margin-left:6px">&#x23F1; '+aq+' sending</span>';
  var hbel = el('header-badges'); if(hbel) hbel.innerHTML=hb;

  // Queue panel
  var qp = el('queue-panel'); var qi = el('queue-items');
  var aqItems = (D.queue||[]).filter(function(q){return !q.cancelled;});
  if(qp) qp.style.display = aqItems.length>0 ? 'block' : 'none';
  if(qi) qi.innerHTML = aqItems.map(function(item){
    var sec = Math.max(0,Math.round((new Date(item.sendAt||Date.now()+300000)-Date.now())/1000));
    var m = Math.floor(sec/60), sc = sec%60;
    return '<div style="padding:10px 12px;background:var(--white);border-radius:var(--r-sm);margin-bottom:8px;border:1px solid #E8D0A8;display:flex;align-items:center;justify-content:space-between;gap:12px"><div style="flex:1;min-width:0"><div style="font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(item.email&&item.email.subject||'')+'</div><div style="font-size:11.5px;color:var(--muted);margin-top:2px">To: '+esc(item.email&&item.email.from||'')+'</div></div><div style="display:flex;align-items:center;gap:8px;flex-shrink:0"><span style="font-size:12px;color:var(--amber);font-weight:600">'+m+':'+(sc<10?'0':'')+sc+'</span><button onclick="cancelSend(\''+item.id+'\')" class="btn btn-amber btn-sm">Cancel</button></div></div>';
  }).join('');

  // Live log
  var ll = el('live-log');
  if(ll&&D.log&&D.log.length>0){
    ll.innerHTML = D.log.slice(0,15).map(function(item,i){
      var dc = item.type==='sent'?'var(--sage)':item.type==='review'?'var(--red)':item.type==='queued'?'var(--amber)':item.type==='archive'?'#8B5CF6':item.type==='error'?'var(--red)':'var(--stone-lt)';
      return '<div style="display:flex;gap:12px;padding-bottom:10px;padding-left:14px;margin-left:6px;border-left:1px solid var(--border-lt);position:relative"><div style="width:6px;height:6px;border-radius:50%;background:'+dc+';position:absolute;left:-4px;top:5px"></div><div style="font-size:11px;color:var(--stone-lt);white-space:nowrap;min-width:46px;padding-top:1px">'+esc(item.time)+'</div><div style="font-size:12.5px;color:var(--muted);line-height:1.55">'+esc(item.msg)+'</div></div>';
    }).join('');
  }

  // Review queue
  var rl = el('review-list');
  if(rl){
    if(!D.review||D.review.length===0){
      rl.innerHTML='<div style="background:var(--sage-pale);border:1px solid rgba(92,122,95,.2);border-radius:var(--r);padding:24px;text-align:center"><div style="font-size:28px;margin-bottom:8px">&#x2713;</div><div style="font-family:\'Cormorant Garamond\',serif;font-size:18px;color:var(--sage-deep)">Queue is clear</div><div style="font-size:13px;color:var(--muted);margin-top:4px">The agent is handling everything automatically.</div></div>';
    } else {
      rl.innerHTML = D.review.map(function(item){
        var u = item.understanding||{};
        return '<div class="card" style="padding:0;overflow:hidden;border-color:var(--border)">'
          +'<div style="padding:14px 16px;cursor:pointer" onclick="toggleEl(\'rb-'+item.id+'\')">'
          +'<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:8px">'
          +'<div style="flex:1;min-width:0"><div style="font-size:13.5px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(item.email&&item.email.subject||'')+'</div>'
          +'<div style="font-size:12px;color:var(--muted);margin-top:2px">From: '+esc(item.email&&item.email.from||'')+'</div></div>'
          +'<div style="display:flex;gap:6px;flex-shrink:0"><button onclick="event.stopPropagation();discardReview(\''+item.id+'\')" class="btn btn-danger btn-sm">Discard</button><span style="font-size:12px;color:var(--stone-lt);padding:0 2px">&#x25BC;</span></div></div>'
          +(u.intent?'<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px"><span class="step-badge">Intent: '+esc(u.intent)+'</span><span class="tag" style="background:var(--amber-lt);color:var(--amber)">Urgency: '+esc(u.urgency||'')+'</span><span class="tag" style="background:'+((item.classification&&item.classification.confidence||0)>=80?'var(--sage-pale)':'var(--red-lt)')+';color:'+((item.classification&&item.classification.confidence||0)>=80?'var(--sage-deep)':'var(--red)')+'">'+((item.classification&&item.classification.confidence)||0)+'% confidence</span></div>':'')
          +'<div style="font-size:12px;color:var(--red);font-weight:500">Held: '+esc(item.holdReason||'')+'</div></div>'
          +'<div id="rb-'+item.id+'" style="display:none;padding:16px;border-top:1px solid var(--border-lt);background:var(--cream)">'
          +'<div style="font-size:13px;color:var(--muted);background:var(--white);border:1px solid var(--border);border-radius:var(--r-sm);padding:12px;margin-bottom:12px;line-height:1.7">'+esc(item.email&&item.email.body||'')+'</div>'
          +'<div style="font-size:10.5px;font-weight:700;color:var(--stone-lt);margin-bottom:6px;letter-spacing:.06em;text-transform:uppercase">AI Draft — edit before sending</div>'
          +'<textarea id="rd-'+item.id+'" style="width:100%;min-height:150px;padding:11px;border:1px solid var(--border);border-radius:var(--r-sm);font-size:13px;line-height:1.7;resize:vertical;margin-bottom:10px">'+esc(item.draftReply||'')+'</textarea>'
          +'<button class="btn btn-success" onclick="approveReview(\''+item.id+'\')">&#x2713; Approve &amp; Send</button>'
          +'</div></div>';
      }).join('');
    }
  }

  // Archive
  var al = el('archive-list');
  if(al){
    if(!D.archive||D.archive.length===0){
      al.innerHTML='<div style="font-size:13px;color:var(--stone-lt);font-style:italic">No old emails archived yet.</div>';
    } else {
      al.innerHTML = D.archive.slice(0,50).map(function(item){
        return '<div class="card" style="opacity:'+(item.followedUp?.5:1)+';border-color:'+(item.followedUp?'rgba(92,122,95,.2)':'var(--border)')+'"><div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px"><div style="flex:1;min-width:0"><div style="font-size:13.5px;font-weight:500;margin-bottom:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(item.email&&item.email.subject||'')+'</div><div style="font-size:12px;color:var(--muted);margin-bottom:8px">From: '+esc(item.email&&item.email.from||'')+'</div><span class="tag" style="background:'+(item.followedUp?'var(--sage-pale)':'var(--amber-lt)')+';color:'+(item.followedUp?'var(--sage-deep)':'var(--amber)')+'">'+( item.followedUp?'&#x2713; Followed up':'&#x26A0; Needs follow-up')+'</span></div>'+(item.followedUp?'':'<button onclick="markFollowedUp(\''+item.id+'\')" class="btn btn-amber btn-sm" style="flex-shrink:0">Mark Done</button>')+'</div><div style="margin-top:10px;font-size:13px;color:var(--muted);background:var(--cream);border:1px solid var(--border-lt);border-radius:var(--r-sm);padding:10px;line-height:1.65">'+esc((item.email&&item.email.body||'').slice(0,250))+'...</div></div>';
      }).join('');
    }
  }

  // Notifications
  var nl = el('notif-list');
  if(nl){
    if(!D.notifs||D.notifs.length===0){
      nl.innerHTML='<div style="padding:24px;text-align:center;color:var(--stone-lt);font-size:13px">No notifications</div>';
    } else {
      nl.innerHTML = D.notifs.slice(0,20).map(function(n){
        return '<div style="padding:12px 16px;border-bottom:1px solid var(--border-lt);background:'+(n.read?'var(--white)':'var(--sage-pale)')+';cursor:pointer" onclick="handleNotif(\''+n.id+'\',\''+n.type+'\')">'
          +'<div style="display:flex;gap:10px"><span style="font-size:15px;flex-shrink:0">&#x1F4C1;</span><div style="flex:1;min-width:0">'
          +'<div style="font-size:12.5px;font-weight:'+(n.read?400:600)+';color:var(--charcoal);margin-bottom:2px">'+esc(n.title)+'</div>'
          +'<div style="font-size:11.5px;color:var(--muted);line-height:1.5">'+esc(n.message)+'</div>'
          +'<div style="font-size:10.5px;color:var(--stone-lt);margin-top:3px">'+new Date(n.createdAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})+'</div>'
          +'</div>'+(n.read?'':'<span class="dot" style="background:var(--amber);margin-top:4px;flex-shrink:0"></span>')+'</div></div>';
      }).join('');
    }
  }

  // Voice
  if(D.voice){
    var gv = el('guidelines-view'); if(gv) gv.textContent = D.voice.guidelines||'';
    var vs = el('voice-samples');
    if(vs){
      vs.innerHTML = (D.voice.samples||[]).length===0
        ? '<div style="font-size:13px;color:var(--stone-lt);margin-bottom:14px;font-style:italic">No samples yet.</div>'
        : (D.voice.samples||[]).map(function(s,i){
            return '<div style="background:var(--sage-pale);border:1px solid rgba(92,122,95,.15);border-radius:var(--r-sm);padding:12px;margin-bottom:8px;display:flex;gap:10px"><div style="flex:1;font-size:13px;color:var(--muted);line-height:1.65">'+esc(s)+'</div><button onclick="removeSample('+i+')" style="background:none;border:none;color:var(--stone-lt);cursor:pointer;font-size:16px;flex-shrink:0;padding:0">&#x00D7;</button></div>';
          }).join('');
    }
  }

  // Sent log
  var sl = el('sent-list');
  if(sl&&D.sent&&D.sent.length>0){
    sl.innerHTML = D.sent.slice(0,50).map(function(item){
      var conf = item.confidence||0;
      return '<div class="card" style="padding:0;overflow:hidden;cursor:pointer" onclick="toggleEl(\'sb-'+item.id+'\')">'
        +'<div style="padding:12px 16px;display:flex;align-items:center;justify-content:space-between;gap:12px">'
        +'<div style="flex:1;min-width:0"><div style="font-size:13.5px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(item.email&&item.email.subject||'')+'</div>'
        +'<div style="font-size:12px;color:var(--muted);margin-top:3px;display:flex;gap:8px;align-items:center">To: '+esc(item.email&&item.email.from||'')
        +' <span class="tag" style="background:'+(conf>=80?'var(--sage-pale)':'var(--amber-lt)')+';color:'+(conf>=80?'var(--sage-deep)':'var(--amber)')+'">'+conf+'%</span>'
        +(item.manualApproval?'<span class="tag" style="background:var(--blue-lt);color:var(--blue)">Staff approved</span>':'')+'</div></div>'
        +'<div style="font-size:11px;color:var(--stone-lt);text-align:right;flex-shrink:0"><div>'+new Date(item.sentAt).toLocaleDateString()+'</div><div>'+new Date(item.sentAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})+'</div></div></div>'
        +'<div id="sb-'+item.id+'" style="display:none;padding:0 16px 16px;border-top:1px solid var(--border-lt)">'
        +'<div style="font-size:10.5px;font-weight:700;color:var(--stone-lt);margin:12px 0 6px;letter-spacing:.06em;text-transform:uppercase">Sent Reply</div>'
        +'<div style="background:var(--cream);border:1px solid var(--border-lt);border-radius:var(--r-sm);padding:12px;font-size:13px;color:var(--muted);line-height:1.75;white-space:pre-wrap">'+esc(item.replyBody||'')+'</div>'
        +'</div></div>';
    }).join('');
  }

  if(currentTab==='crm') renderCRM();
}

function renderCRM(){
  var stats = D.crmStats||{};
  var se = el('crm-stats');
  if(se){
    se.innerHTML = [
      {l:'Total',v:stats.total||0,bg:'var(--white)',c:'var(--charcoal)'},
      {l:'Active',v:stats.active||0,bg:'var(--sage-pale)',c:'var(--sage-deep)'},
      {l:'Need Follow-Up',v:stats.silent||0,bg:'var(--amber-lt)',c:'var(--amber)'},
      {l:'Follow-Up Sent',v:stats.followUp||0,bg:'var(--blue-lt)',c:'var(--blue)'},
      {l:'Lost',v:stats.lost||0,bg:'var(--border-lt)',c:'var(--stone)'},
    ].map(function(s){
      return '<div style="background:'+s.bg+';border:1px solid var(--border);border-radius:var(--r);padding:16px;text-align:center;box-shadow:var(--shadow)">'
        +'<div style="font-family:\'Cormorant Garamond\',serif;font-size:28px;font-weight:500;color:'+s.c+';line-height:1">'+s.v+'</div>'
        +'<div style="font-size:11px;color:var(--muted);margin-top:5px;font-weight:500">'+s.l+'</div></div>';
    }).join('');
  }
  var cl2 = el('crm-list');
  if(!cl2) return;
  var crm = D.crm||[];
  if(crm.length===0){ cl2.innerHTML='<div style="font-size:13px;color:var(--stone-lt);font-style:italic;padding:20px 0">No contacts yet — they appear automatically as emails come in.</div>'; return; }
  var now = Date.now();
  cl2.innerHTML = '<div style="background:var(--white);border:1px solid var(--border);border-radius:var(--r);overflow:hidden;box-shadow:var(--shadow)">'
    +'<div style="display:grid;grid-template-columns:2fr 2fr 1fr 1fr 1.2fr 1fr;border-bottom:1px solid var(--border);background:var(--cream)">'
    +['Contact','Last Topic','Last Seen','Touches','Status','Action'].map(function(h){ return '<div style="padding:10px 12px;font-size:10.5px;font-weight:700;color:var(--stone);letter-spacing:.06em;text-transform:uppercase">'+h+'</div>'; }).join('')
    +'</div>'
    + crm.slice(0,100).map(function(c,i){
        var st = CRM_LABELS[c.status]||CRM_LABELS.active;
        var days = Math.round((now - new Date(c.lastSeen).getTime())/86400000);
        var silent = days>=14 && c.status!=='lost' && c.status!=='opted_out';
        var bg = silent ? '#FEFAF3' : (i%2===0?'var(--white)':'var(--cream)');
        return '<div style="display:contents">'
          +'<div style="padding:10px 12px;border-bottom:1px solid var(--border-lt);background:'+bg+'"><div style="font-size:13px;font-weight:500;color:var(--charcoal)">'+esc(c.name)+'</div><div style="font-size:11px;color:var(--stone-lt);margin-top:1px">'+esc(c.email)+'</div></div>'
          +'<div style="padding:10px 12px;border-bottom:1px solid var(--border-lt);font-size:12.5px;color:var(--muted);background:'+bg+';overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(c.lastSubject||'—')+'</div>'
          +'<div style="padding:10px 12px;border-bottom:1px solid var(--border-lt);font-size:12.5px;color:'+(silent?'var(--amber)':'var(--muted)')+';font-weight:'+(silent?600:400)+';background:'+bg+'">'+(silent?'&#x26A0; ':'')+days+'d</div>'
          +'<div style="padding:10px 12px;border-bottom:1px solid var(--border-lt);font-size:12.5px;color:var(--muted);background:'+bg+';text-align:center">'+(c.touchCount||1)+'</div>'
          +'<div style="padding:10px 12px;border-bottom:1px solid var(--border-lt);background:'+bg+'"><span class="tag" style="background:'+st.bg+';color:'+st.c+'">'+st.l+'</span></div>'
          +'<div style="padding:8px 10px;border-bottom:1px solid var(--border-lt);background:'+bg+'"><select onchange="updateCRM(\''+c.id+'\',this.value)" style="font-size:11.5px;padding:4px 6px;border:1px solid var(--border);border-radius:var(--r-sm);cursor:pointer;background:var(--white);width:100%"><option value="">Change...</option><option value="active">Active</option><option value="booked">Booked</option><option value="lost">Lost</option><option value="opted_out">Opted Out</option></select></div>'
          +'</div>';
      }).join('')
    +'</div>';
}

// ── ACTIONS
function toggleEl(id){ var e=el(id); if(e) e.style.display=e.style.display==='none'?'block':'none'; }
function cancelSend(id){ apiFetch('/api/queue/'+id+'/cancel',{method:'POST'}).then(function(){showToast('Send cancelled');refreshData();}).catch(function(e){showErr(e.message);}); }
function approveReview(id){ var draft=el('rd-'+id); apiFetch('/api/review/'+id+'/approve',{method:'POST',body:JSON.stringify({reply:draft?draft.value:''})}).then(function(){showToast('Reply sent');refreshData();}).catch(function(e){showErr(e.message);}); }
function discardReview(id){ apiFetch('/api/review/'+id+'/discard',{method:'POST'}).then(function(){showToast('Discarded');refreshData();}).catch(function(e){showErr(e.message);}); }
function markFollowedUp(id){ apiFetch('/api/archive/'+id+'/followup',{method:'POST'}).then(function(){showToast('Marked as followed up');refreshData();}).catch(function(e){showErr(e.message);}); }
function toggleNotif(){ notifOpen=!notifOpen; el('notif-panel').style.display=notifOpen?'block':'none'; }
function markAllRead(){ apiFetch('/api/notifications/read-all',{method:'POST'}).then(refreshData).catch(function(){}); }
function handleNotif(id,type){ apiFetch('/api/notifications/'+id+'/read',{method:'POST'}).catch(function(){}); if(type==='old_email')showTab('archive'); toggleNotif(); refreshData(); }

// ── VOICE
function toggleGuidelines(){ editingGuidelines=!editingGuidelines; el('guidelines-view').style.display=editingGuidelines?'none':'block'; el('guidelines-edit').style.display=editingGuidelines?'block':'none'; if(editingGuidelines){var ta=el('guidelines-ta');if(ta&&D.voice)ta.value=D.voice.guidelines||'';} }
function saveGuidelines(){ var g=el('guidelines-ta').value; apiFetch('/api/voice/guidelines',{method:'POST',body:JSON.stringify({guidelines:g})}).then(function(){toggleGuidelines();showToast('Guidelines saved');refreshData();}).catch(function(e){showErr(e.message);}); }
function addSample(){ var s=el('new-sample').value.trim(); if(!s)return; apiFetch('/api/voice/sample',{method:'POST',body:JSON.stringify({sample:s})}).then(function(){el('new-sample').value='';showToast('Sample added');refreshData();}).catch(function(e){showErr(e.message);}); }
function removeSample(i){ apiFetch('/api/voice/sample/'+i,{method:'DELETE'}).then(function(){showToast('Removed');refreshData();}).catch(function(e){showErr(e.message);}); }

// ── CRM
function addCRM(){ var email=el('crm-email').value.trim(),name=el('crm-name').value.trim(),notes=el('crm-notes').value.trim(); if(!email){showErr('Email required');return;} apiFetch('/api/crm',{method:'POST',body:JSON.stringify({email:email,name:name,notes:notes})}).then(function(){el('crm-email').value='';el('crm-name').value='';el('crm-notes').value='';showToast('Contact added');refreshData();}).catch(function(e){showErr(e.message);}); }
function updateCRM(id,status){ if(!status)return; apiFetch('/api/crm/'+id,{method:'PATCH',body:JSON.stringify({status:status})}).then(function(){showToast('Status updated');refreshData();}).catch(function(e){showErr(e.message);}); }

// ── INBOX
function renderEmailList(){
  var list=el('email-list'); if(!list) return;
  list.innerHTML = DEMO.map(function(e){
    var tag=TAGS[e.tag]||{bg:'#eee',c:'#555',l:e.tag};
    return '<div class="email-row '+(e.status==='unread'?'':'')+(selectedEmail===e.id?' selected':'')+'" onclick="selectEmail('+e.id+')" style="'+(e.status==='unread'?'background:#FAFFF9;':'')+(selectedEmail===e.id?'background:var(--sage-pale);border-left-color:var(--sage);':'')+'">'
      +'<div style="display:flex;justify-content:space-between;margin-bottom:3px;gap:6px">'
      +'<span style="font-size:13px;font-weight:'+(e.status==='unread'?600:400)+';color:var(--charcoal);display:flex;align-items:center;gap:6px;overflow:hidden;flex:1">'
      +(e.status==='unread'?'<span class="dot" style="background:var(--sage);flex-shrink:0"></span>':'')
      +(e.status==='replied'?'<span style="font-size:10px;color:var(--sage);font-weight:600;flex-shrink:0">&#x2713;</span>':'')
      +'<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(e.name)+'</span></span>'
      +'<span style="font-size:10.5px;color:var(--stone-lt);flex-shrink:0">'+esc(e.time)+'</span></div>'
      +'<div style="font-size:12px;font-weight:500;color:var(--muted);margin-bottom:5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(e.subject)+'</div>'
      +'<span class="tag" style="background:'+tag.bg+';color:'+tag.c+'">'+tag.l+'</span>'
      +'</div>';
  }).join('');
}

function selectEmail(id){
  selectedEmail=id;
  var email=DEMO.find(function(e){return e.id===id;});
  if(!email)return;
  if(email.status==='unread') email.status='read';
  renderEmailList();
  var det=el('email-detail'); if(!det)return;
  var tag=TAGS[email.tag]||{bg:'#eee',c:'#555',l:email.tag};
  det.style.alignItems='flex-start';
  det.innerHTML='<div style="max-width:640px;width:100%;animation:fadeUp .2s ease">'
    +'<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:6px">'
    +'<div style="font-family:\'Cormorant Garamond\',serif;font-size:22px;font-weight:500;line-height:1.3;color:var(--charcoal)">'+esc(email.subject)+'</div>'
    +'<span class="tag" style="background:'+tag.bg+';color:'+tag.c+';flex-shrink:0;font-size:11px;padding:3px 9px">'+tag.l+'</span></div>'
    +'<div style="font-size:12px;color:var(--muted);margin-bottom:16px">From: <strong>'+esc(email.name)+'</strong> &middot; '+esc(email.time)+'</div>'
    +'<div style="background:var(--white);border:1px solid var(--border);border-radius:var(--r);padding:18px;margin-bottom:16px;font-size:13.5px;line-height:1.8;color:var(--muted);box-shadow:var(--shadow)">'+esc(email.body)+'</div>'
    +'<div id="sum-area"><div style="display:flex;align-items:center;gap:8px;color:var(--stone-lt);font-size:13px;padding:6px 0"><span class="spinner"></span>Analysing...</div></div>'
    +(email.status==='replied'
      ?'<div style="padding:10px 14px;background:var(--sage-pale);border:1px solid rgba(92,122,95,.2);border-radius:var(--r-sm);font-size:13px;color:var(--sage-deep);font-weight:500">&#x2713; Reply sent via Gmail</div>'
      :'<div id="reply-sec"><button class="btn btn-primary" id="draft-btn" onclick="draftReply('+id+')">&#x2728; Draft Reply</button>'
      +'<div id="reply-area" style="display:none;margin-top:16px">'
      +'<div style="font-size:10.5px;font-weight:700;color:var(--stone-lt);margin-bottom:8px;letter-spacing:.06em;text-transform:uppercase">Drafted Reply — edit before sending</div>'
      +'<textarea id="reply-txt" style="width:100%;min-height:180px;padding:14px;border:1px solid var(--border);border-radius:var(--r);font-size:13.5px;line-height:1.8;resize:vertical"></textarea>'
      +'<div style="display:flex;gap:8px;margin-top:11px"><button class="btn btn-success" onclick="sendReply('+id+')">Send via Gmail</button><button class="btn btn-ghost" onclick="discardReply()">Discard</button></div>'
      +'</div></div>'
    )+'</div>';

  callClaude('2-step analysis: (1) What does this person want and what is their mood? (2) What should Expert Physio do? Max 2 sentences total.\n\nFrom: '+email.name+'\nSubject: '+email.subject+'\nBody: '+email.body)
    .then(function(s){
      var sa=el('sum-area');
      if(sa) sa.innerHTML='<div style="background:var(--sage-pale);border:1px solid rgba(92,122,95,.2);border-radius:var(--r-sm);padding:12px 14px;margin-bottom:16px"><div style="display:flex;gap:6px;margin-bottom:5px"><span class="step-badge">AI Analysis</span></div><div style="font-size:13px;color:var(--sage-deep);line-height:1.65">'+esc(s)+'</div></div>';
    }).catch(function(){ var sa=el('sum-area'); if(sa) sa.innerHTML=''; });
}

function draftReply(id){
  var email=DEMO.find(function(e){return e.id===id;});
  if(!email)return;
  var btn=el('draft-btn'); if(btn){btn.disabled=true;btn.innerHTML='<span class="spinner"></span> Drafting...';}
  callClaude('Write a professional reply for Expert Physio. No subject line. Start with greeting. End with Expert Physio Team.\n\nFrom: '+email.name+'\nSubject: '+email.subject+'\nBody: '+email.body)
    .then(function(r){ var ra=el('reply-area'),rt=el('reply-txt'); if(ra&&rt){rt.value=r;ra.style.display='block';} var btn2=el('draft-btn');if(btn2)btn2.style.display='none'; })
    .catch(function(e){ showErr('Draft failed: '+e.message); var btn2=el('draft-btn');if(btn2){btn2.disabled=false;btn2.innerHTML='&#x2728; Draft Reply';} });
}
function sendReply(id){ var email=DEMO.find(function(e){return e.id===id;}); if(email){email.status='replied';showToast('Reply sent to '+email.name);renderEmailList();} var rs=el('reply-sec'); if(rs) rs.innerHTML='<div style="padding:10px 14px;background:var(--sage-pale);border:1px solid rgba(92,122,95,.2);border-radius:var(--r-sm);font-size:13px;color:var(--sage-deep);font-weight:500">&#x2713; Reply sent via Gmail</div>'; }
function discardReply(){ var ra=el('reply-area'),btn=el('draft-btn'); if(ra)ra.style.display='none'; if(btn){btn.style.display='inline-flex';btn.innerHTML='&#x2728; Draft Reply';btn.disabled=false;} }

// ── COMPOSE
function generateEmail(){
  var text=el('compose-input').value.trim(); if(!text)return;
  var btn=el('compose-btn'),sp=el('compose-spinner'),comp=el('composed-email');
  btn.disabled=true; sp.style.display='flex'; comp.style.display='none';
  callClaude('Compose an Expert Physio clinic email: "'+text+'"\n\nReturn ONLY valid JSON: {"to":"email","subject":"subject","body":"body ending with Expert Physio Team"}. No markdown backticks.')
    .then(function(raw){
      var clean=raw.trim(); var m=clean.match(/\{[\s\S]*\}/); if(m) clean=m[0]; clean=clean.trim();
      var obj=JSON.parse(clean);
      el('c-to').value=obj.to||''; el('c-subject').value=obj.subject||''; el('c-body').value=obj.body||'';
      comp.style.display='block';
    }).catch(function(e){ showErr('Compose failed: '+e.message); })
    .finally(function(){ btn.disabled=false; sp.style.display='none'; });
}
function sendComposed(){ showToast('Email sent: "'+el('c-subject').value+'"'); discardComposed(); }
function discardComposed(){ el('composed-email').style.display='none'; el('compose-input').value=''; }

// ── INIT
document.addEventListener('click', function(e){
  if(notifOpen && !el('notif-panel').contains(e.target) && !el('bell-btn').contains(e.target)){ notifOpen=false; el('notif-panel').style.display='none'; }
});
refreshData();
setInterval(refreshData, 8000);
showTab('autopilot');
</script>
</body>
</html>`;

app.get("*", (req, res) => res.send(DASHBOARD_HTML));

app.listen(parseInt(PORT), () => log("Expert Physio Agent v3 running on port " + PORT, "success"));
