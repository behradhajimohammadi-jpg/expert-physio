const express = require("express");
const app = express();
app.use(express.json());

// ── Anthropic proxy ──────────────────────────────────────────────────────────
app.post("/api/claude", async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set on server" });
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(req.body),
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Proxy failed: " + err.message });
  }
});

// ── Health check ─────────────────────────────────────────────────────────────
app.get("/api/health", (req, res) => res.json({ status: "ok" }));

// ── Serve the entire React app as inline HTML ────────────────────────────────
app.get("*", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Expert Physio AI Agent</title>
  <script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
  <script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
  <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&family=DM+Serif+Display&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'DM Sans', 'Helvetica Neue', sans-serif; background: #F8FAFC; }
    @keyframes spin { to { transform: rotate(360deg); } }
    @keyframes fadeIn { from { opacity:0; transform:translateY(5px); } to { opacity:1; transform:none; } }
    @keyframes slideDown { from { opacity:0; transform:translateY(-8px); } to { opacity:1; transform:none; } }
    ::-webkit-scrollbar { width: 4px; }
    ::-webkit-scrollbar-thumb { background: #D1D5DB; border-radius: 4px; }
    textarea, input, button { font-family: 'DM Sans', sans-serif; }
    textarea:focus, input:focus { outline: 2px solid #0EA5E9; outline-offset: 1px; border-radius: 4px; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script type="text/babel">
    const { useState, useRef } = React;

    // All API calls go through /api/claude — server adds the secret key
    async function callClaude(userMessage, systemPrompt) {
      const res = await fetch("/api/claude", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 1000,
          system: systemPrompt || SYSTEM,
          messages: [{ role: "user", content: userMessage }],
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error?.message || err.error || "Server error " + res.status);
      }
      const data = await res.json();
      const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\\n").trim();
      if (!text) throw new Error("Empty response from AI");
      return text;
    }

    async function callClaudeJSON(userMessage, systemPrompt) {
      const raw = await callClaude(userMessage, systemPrompt);
      const clean = raw.replace(/^\`\`\`(?:json)?\\s*/i, "").replace(/\\s*\`\`\`\\s*$/, "").trim();
      try { return JSON.parse(clean); } catch {
        const m = clean.match(/\\{[\\s\\S]*\\}/);
        if (m) return JSON.parse(m[0]);
        throw new Error("Could not parse AI response");
      }
    }

    const SYSTEM = \`You are the professional AI assistant for Expert Physio, a busy physiotherapy clinic in Burnaby, BC, Canada. You manage emails and paperwork on behalf of the clinic staff. Your replies are warm, professional, concise, and clinically appropriate. Always sign emails as "Expert Physio Team". Never invent clinical information.\`;

    const INIT_EMAILS = [
      { id:1, from:"sarah.mitchell@gmail.com", name:"Sarah Mitchell", subject:"Appointment Cancellation - Thursday 2pm", preview:"Hi, I need to cancel my appointment this Thursday…", body:"Hi, I need to cancel my appointment this Thursday at 2pm. I have a conflict at work. Can we reschedule to next week? Any time Tuesday or Wednesday works for me. Thanks, Sarah", time:"9:14 AM", status:"unread", tag:"cancellation" },
      { id:2, from:"icbc.claims@icbc.com", name:"ICBC Claims", subject:"Claim #4892-B: Treatment Authorization Required", preview:"Please submit updated treatment plan for claimant…", body:"Please submit updated treatment plan for claimant John Patel (Claim #4892-B). Authorization is required before proceeding with further sessions. Please respond within 5 business days.", time:"8:30 AM", status:"unread", tag:"icbc" },
      { id:3, from:"drlee@familyclinic.ca", name:"Dr. Angela Lee", subject:"Referral: Marcus Huang - Lower Back Pain", preview:"I am referring Marcus Huang, 42, for physiotherapy…", body:"I am referring Marcus Huang, 42, for physiotherapy treatment following a lumbar strain. He has been experiencing lower back pain for 3 weeks. Please book him in at your earliest convenience.", time:"Yesterday", status:"read", tag:"referral" },
      { id:4, from:"kevin.tran88@hotmail.com", name:"Kevin Tran", subject:"Question about my invoice", preview:"Hi there, I received an invoice but I think…", body:"Hi there, I received an invoice for $180 but I think my insurance covers 80% of physiotherapy. Can you check and resubmit to Pacific Blue Cross? My policy number is PBC-2291-TK. Thanks", time:"Yesterday", status:"read", tag:"billing" },
      { id:5, from:"amanda.shore@gmail.com", name:"Amanda Shore", subject:"New Patient Inquiry", preview:"Hello, I found you on Google and was wondering…", body:"Hello, I found you on Google and was wondering if you're accepting new patients? I have a rotator cuff injury. I'm available weekday mornings. Do you direct bill to MSP?", time:"Mon", status:"read", tag:"new-patient" },
    ];

    const INIT_DOCS = [
      { id:1, name:"ICBC Initial Assessment Form", patient:"John Patel", due:"Today", urgent:true, status:"pending", draft:"" },
      { id:2, name:"Treatment Plan — Marcus Huang", patient:"Marcus Huang", due:"Tomorrow", urgent:false, status:"draft", draft:"" },
      { id:3, name:"Discharge Summary — Claire Wu", patient:"Claire Wu", due:"Overdue", urgent:true, status:"ready", draft:"Claire Wu has completed her physiotherapy program following rotator cuff repair. She has achieved full range of motion and reports no residual pain. Home exercise program provided. Discharge recommended." },
      { id:4, name:"Pacific Blue Cross Resubmission", patient:"Kevin Tran", due:"This week", urgent:false, status:"pending", draft:"" },
      { id:5, name:"Progress Notes — Amanda Shore", patient:"Amanda Shore", due:"Friday", urgent:false, status:"draft", draft:"" },
    ];

    const TAGS = {
      cancellation: { bg:"#FFF0F0", color:"#C0392B", label:"Cancellation" },
      icbc:         { bg:"#EEF2FF", color:"#4338CA", label:"ICBC" },
      referral:     { bg:"#F0FFF4", color:"#166534", label:"Referral" },
      billing:      { bg:"#FFFBEB", color:"#92400E", label:"Billing" },
      "new-patient":{ bg:"#F0F9FF", color:"#0369A1", label:"New Patient" },
    };

    function Spinner({ label="Agent working…" }) {
      return (
        <div style={{display:"flex",alignItems:"center",gap:10,color:"#6B7280",fontSize:13,padding:"8px 0"}}>
          <div style={{width:16,height:16,borderRadius:"50%",border:"2px solid #E5E7EB",borderTop:"2px solid #0EA5E9",animation:"spin 0.7s linear infinite",flexShrink:0}} />
          {label}
        </div>
      );
    }

    function Toast({ msg, onClose }) {
      return (
        <div style={{position:"fixed",top:20,right:20,zIndex:9999,background:"#111827",color:"#fff",padding:"11px 20px",borderRadius:10,fontSize:13,fontWeight:500,boxShadow:"0 4px 24px rgba(0,0,0,.25)",animation:"slideDown .25s ease",display:"flex",alignItems:"center",gap:12,maxWidth:380}}>
          <span style={{flex:1}}>{msg}</span>
          <button onClick={onClose} style={{background:"none",border:"none",color:"#9CA3AF",cursor:"pointer",fontSize:18,lineHeight:1}}>×</button>
        </div>
      );
    }

    function ErrBanner({ msg, onClose }) {
      if (!msg) return null;
      return (
        <div style={{background:"#FFF0F0",border:"1px solid #FECACA",borderRadius:8,padding:"10px 16px",fontSize:13,color:"#B91C1C",display:"flex",justifyContent:"space-between",alignItems:"center",margin:"8px 16px"}}>
          <span>⚠️ {msg}</span>
          <button onClick={onClose} style={{background:"none",border:"none",color:"#B91C1C",cursor:"pointer",fontWeight:700,fontSize:16,marginLeft:12}}>×</button>
        </div>
      );
    }

    function App() {
      const [tab, setTab] = useState("Inbox");
      const [emails, setEmails] = useState(INIT_EMAILS);
      const [selEmail, setSelEmail] = useState(null);
      const [summaries, setSummaries] = useState({});
      const [replies, setReplies] = useState({});
      const [emailLoadId, setEmailLoadId] = useState(null);
      const [emailLoadAction, setEmailLoadAction] = useState(null);
      const [composeText, setComposeText] = useState("");
      const [composed, setComposed] = useState(null);
      const [composeLoading, setComposeLoading] = useState(false);
      const [docs, setDocs] = useState(INIT_DOCS);
      const [docLoadId, setDocLoadId] = useState(null);
      const [log, setLog] = useState([
        { time:"9:14 AM", action:"New email from Sarah Mitchell — tagged as Cancellation" },
        { time:"8:30 AM", action:"ICBC authorization request received — added to Paperwork queue" },
        { time:"8:00 AM", action:"Daily briefing: 2 unread emails, 1 overdue document" },
      ]);
      const [toast, setToast] = useState(null);
      const [err, setErr] = useState(null);
      const replyRef = useRef(null);

      const addLog = (action) => {
        const t = new Date().toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});
        setLog(p => [{time:t,action},...p]);
      };
      const showToast = (msg) => { setToast(msg); setTimeout(()=>setToast(null),3500); };
      const unread = emails.filter(e=>e.status==="unread").length;
      const pending = docs.filter(d=>d.status!=="filed").length;
      const isBusy = (id,action) => emailLoadId===id && emailLoadAction===action;

      const selectEmail = async (email) => {
        setErr(null); setSelEmail(email);
        setEmails(p=>p.map(e=>e.id===email.id?{...e,status:e.status==="unread"?"read":e.status}:e));
        if (summaries[email.id]) return;
        setEmailLoadId(email.id); setEmailLoadAction("summarize");
        try {
          const s = await callClaude(
            "Summarise in 1-2 sentences and state the single best next action.\\n\\nFrom: "+email.name+" <"+email.from+">\\nSubject: "+email.subject+"\\nBody: "+email.body,
            "You are a clinical inbox triage assistant for a physiotherapy clinic. Be concise."
          );
          setSummaries(p=>({...p,[email.id]:s}));
          addLog("Email from "+email.name+" summarised");
        } catch(e) { setErr("Could not summarise: "+e.message); }
        finally { setEmailLoadId(null); setEmailLoadAction(null); }
      };

      const draftReply = async () => {
        if (!selEmail) return;
        setErr(null);
        if (replies[selEmail.id]) { setTimeout(()=>replyRef.current?.scrollIntoView({behavior:"smooth"}),50); return; }
        setEmailLoadId(selEmail.id); setEmailLoadAction("reply");
        try {
          const r = await callClaude("Write a professional reply for Expert Physio. No subject line. Start with a greeting. End with Expert Physio Team.\\n\\nFrom: "+selEmail.name+"\\nSubject: "+selEmail.subject+"\\nBody: "+selEmail.body);
          setReplies(p=>({...p,[selEmail.id]:r}));
          addLog("Reply drafted for "+selEmail.name);
          setTimeout(()=>replyRef.current?.scrollIntoView({behavior:"smooth"}),100);
        } catch(e) { setErr("Could not draft reply: "+e.message); }
        finally { setEmailLoadId(null); setEmailLoadAction(null); }
      };

      const sendReply = () => {
        if (!selEmail) return;
        setEmails(p=>p.map(e=>e.id===selEmail.id?{...e,status:"replied"}:e));
        setReplies(p=>{const n={...p};delete n[selEmail.id];return n;});
        setSummaries(p=>{const n={...p};delete n[selEmail.id];return n;});
        addLog("Reply sent to "+selEmail.name+" via Gmail");
        showToast("✓ Reply sent to "+selEmail.name);
        setSelEmail(null);
      };

      const compose = async () => {
        if (!composeText.trim()) return;
        setErr(null); setComposeLoading(true); setComposed(null);
        try {
          const r = await callClaudeJSON(
            'Compose an email for Expert Physio based on: "'+composeText+'"\\n\\nReturn ONLY valid JSON: {"to":"recipient email","subject":"subject line","body":"full email body ending with Expert Physio Team"}',
            "You compose professional clinic emails. Return ONLY valid JSON, nothing else."
          );
          if (!r.subject||!r.body) throw new Error("Incomplete response");
          setComposed({to:r.to||"",subject:r.subject,body:r.body});
          addLog("Email composed: \\""+r.subject+"\\"");
        } catch(e) { setErr("Could not compose: "+e.message); }
        finally { setComposeLoading(false); }
      };

      const sendComposed = () => {
        addLog("Email sent to \\""+composed?.to+"\\" — \\""+composed?.subject+"\\"");
        showToast("✓ Email sent: \\""+composed?.subject+"\\"");
        setComposed(null); setComposeText("");
      };

      const processDoc = async (doc) => {
        setErr(null); setDocLoadId(doc.id);
        try {
          const draft = await callClaude(
            "Draft a brief "+doc.name+" for patient "+doc.patient+". Write 3-4 professional sentences for a physiotherapy clinic record.",
            "You draft professional physiotherapy clinic documents. Be concise and use appropriate medical administrative language."
          );
          setDocs(p=>p.map(d=>d.id===doc.id?{...d,status:"ready",draft}:d));
          addLog(doc.name+" drafted — ready for review");
          showToast("✓ \\""+doc.name+"\\" ready for review");
        } catch(e) { setErr("Could not process \\""+doc.name+'": '+e.message); }
        finally { setDocLoadId(null); }
      };

      const approveDoc = (doc) => {
        setDocs(p=>p.map(d=>d.id===doc.id?{...d,status:"filed"}:d));
        addLog(doc.name+" approved and filed");
        showToast("✓ \\""+doc.name+"\\" filed");
      };

      const TABS = ["Inbox","Compose","Paperwork","Activity Log"];
      const ICONS = {Inbox:"📬",Compose:"✏️",Paperwork:"📋","Activity Log":"📊"};
      const curReply = selEmail ? (replies[selEmail.id]||"") : "";
      const curSum   = selEmail ? (summaries[selEmail.id]||"") : "";

      return (
        <div style={{display:"flex",flexDirection:"column",height:"100vh",overflow:"hidden",color:"#111827"}}>
          {toast && <Toast msg={toast} onClose={()=>setToast(null)} />}

          {/* Header */}
          <div style={{background:"#0B1F3A",borderBottom:"1px solid #1E3A5F",height:56,display:"flex",alignItems:"center",justifyContent:"space-between",padding:"0 22px",flexShrink:0}}>
            <div style={{display:"flex",alignItems:"center",gap:10}}>
              <div style={{width:32,height:32,borderRadius:8,background:"linear-gradient(135deg,#0EA5E9,#0369A1)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:16}}>🤖</div>
              <div>
                <div style={{fontFamily:"'DM Serif Display',serif",fontSize:16,color:"#fff"}}>Expert Physio AI Agent</div>
                <div style={{fontSize:10,color:"#64B5D9"}}>Burnaby, BC · Gmail Connected</div>
              </div>
            </div>
            <div style={{display:"flex",gap:6}}>
              {["Gmail","ICBC","Paperwork"].map(t=>(
                <span key={t} style={{fontSize:11,fontWeight:500,padding:"3px 10px",borderRadius:20,background:"rgba(14,165,233,0.15)",color:"#7DD3FC",border:"1px solid rgba(14,165,233,0.3)"}}>● {t}</span>
              ))}
            </div>
          </div>

          <div style={{display:"flex",flex:1,overflow:"hidden"}}>
            {/* Sidebar */}
            <div style={{width:206,background:"#fff",borderRight:"1px solid #E5E7EB",display:"flex",flexDirection:"column",flexShrink:0}}>
              <div style={{padding:"14px 0",flex:1}}>
                {TABS.map(t=>{
                  const active=tab===t;
                  return (
                    <button key={t} onClick={()=>setTab(t)} style={{width:"100%",padding:"10px 16px",background:active?"#F0F9FF":"transparent",borderLeft:"3px solid "+(active?"#0EA5E9":"transparent"),border:"none",cursor:"pointer",textAlign:"left",fontSize:13,fontWeight:active?600:400,color:active?"#0284C7":"#374151",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                      <span>{ICONS[t]} {t}</span>
                      {t==="Inbox"&&unread>0&&<span style={{background:"#0EA5E9",color:"#fff",borderRadius:10,fontSize:11,fontWeight:700,padding:"1px 7px"}}>{unread}</span>}
                      {t==="Paperwork"&&pending>0&&<span style={{background:"#F59E0B",color:"#fff",borderRadius:10,fontSize:11,fontWeight:700,padding:"1px 7px"}}>{pending}</span>}
                    </button>
                  );
                })}
              </div>
              <div style={{margin:"0 10px 14px",padding:12,background:"#F8FAFC",borderRadius:10,border:"1px solid #E5E7EB"}}>
                <div style={{fontSize:10,fontWeight:700,color:"#6B7280",marginBottom:7,letterSpacing:.5}}>TODAY</div>
                {[["📬",emails.length+" emails"],["🔵",unread+" unread"],["✅",emails.filter(e=>e.status==="replied").length+" replied"],["📋",pending+" docs pending"]].map(([ic,tx])=>(
                  <div key={tx} style={{fontSize:12,color:"#374151",lineHeight:1.9}}>{ic} {tx}</div>
                ))}
              </div>
            </div>

            {/* Main */}
            <div style={{flex:1,overflow:"hidden",display:"flex",flexDirection:"column"}}>
              {err && <ErrBanner msg={err} onClose={()=>setErr(null)} />}
              <div style={{flex:1,overflow:"hidden",display:"flex"}}>

                {/* INBOX */}
                {tab==="Inbox" && (
                  <>
                    <div style={{width:300,borderRight:"1px solid #E5E7EB",overflowY:"auto",background:"#fff",flexShrink:0}}>
                      <div style={{padding:"11px 14px 9px",borderBottom:"1px solid #F3F4F6",fontSize:11,fontWeight:700,color:"#6B7280",letterSpacing:.5}}>ALL EMAILS — {emails.length}</div>
                      {emails.map(e=>{
                        const tag=TAGS[e.tag]; const isSel=selEmail?.id===e.id;
                        return (
                          <div key={e.id} onClick={()=>selectEmail(e)} style={{padding:"11px 14px",cursor:"pointer",borderBottom:"1px solid #F9FAFB",background:isSel?"#EFF6FF":e.status==="unread"?"#FAFFFE":"#fff",borderLeft:"3px solid "+(isSel?"#0EA5E9":"transparent"),transition:"background .12s"}}>
                            <div style={{display:"flex",justifyContent:"space-between",marginBottom:2}}>
                              <span style={{fontSize:13,fontWeight:e.status==="unread"?700:500,color:"#111827",display:"flex",alignItems:"center",gap:5,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",flex:1}}>
                                {e.status==="unread"&&<span style={{width:6,height:6,borderRadius:"50%",background:"#0EA5E9",flexShrink:0,display:"inline-block"}} />}
                                {e.status==="replied"&&<span style={{fontSize:10,color:"#059669",fontWeight:600,flexShrink:0}}>✓</span>}
                                {e.name}
                              </span>
                              <span style={{fontSize:11,color:"#9CA3AF",flexShrink:0,marginLeft:4}}>{e.time}</span>
                            </div>
                            <div style={{fontSize:12,fontWeight:500,color:"#374151",marginBottom:4,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{e.subject}</div>
                            <span style={{fontSize:10,fontWeight:600,padding:"2px 8px",borderRadius:20,background:tag.bg,color:tag.color}}>{tag.label}</span>
                          </div>
                        );
                      })}
                    </div>

                    <div style={{flex:1,overflowY:"auto",padding:26}}>
                      {!selEmail ? (
                        <div style={{height:"100%",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",color:"#9CA3AF",gap:10}}>
                          <div style={{fontSize:44}}>📬</div>
                          <div style={{fontSize:14}}>Select an email to read and reply</div>
                        </div>
                      ) : (
                        <div style={{maxWidth:640,animation:"fadeIn .2s ease"}}>
                          <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:12,marginBottom:6}}>
                            <div style={{fontFamily:"'DM Serif Display',serif",fontSize:20,lineHeight:1.3}}>{selEmail.subject}</div>
                            <span style={{fontSize:11,fontWeight:600,padding:"3px 9px",borderRadius:20,flexShrink:0,background:TAGS[selEmail.tag].bg,color:TAGS[selEmail.tag].color}}>{TAGS[selEmail.tag].label}</span>
                          </div>
                          <div style={{fontSize:12,color:"#6B7280",marginBottom:14}}>From: <strong>{selEmail.name}</strong> &lt;{selEmail.from}&gt; · {selEmail.time}</div>
                          <div style={{background:"#fff",border:"1px solid #E5E7EB",borderRadius:12,padding:20,marginBottom:16,fontSize:14,lineHeight:1.75,color:"#374151"}}>{selEmail.body}</div>

                          {isBusy(selEmail.id,"summarize") && <Spinner label="Analysing email…" />}
                          {curSum && !isBusy(selEmail.id,"summarize") && (
                            <div style={{background:"#F0F9FF",border:"1px solid #BAE6FD",borderRadius:10,padding:"12px 16px",marginBottom:16,animation:"fadeIn .25s ease"}}>
                              <div style={{fontSize:10,fontWeight:700,color:"#0284C7",marginBottom:5,letterSpacing:.5}}>🤖 AI ANALYSIS</div>
                              <div style={{fontSize:13,color:"#1E40AF",lineHeight:1.65}}>{curSum}</div>
                            </div>
                          )}

                          {selEmail.status==="replied" ? (
                            <div style={{padding:"10px 14px",background:"#F0FFF4",border:"1px solid #86EFAC",borderRadius:8,fontSize:13,color:"#166534",fontWeight:500}}>✓ Reply sent via Gmail</div>
                          ) : (
                            <>
                              <button onClick={draftReply} disabled={!!emailLoadId} style={{padding:"9px 18px",background:"#0EA5E9",color:"#fff",border:"none",borderRadius:8,cursor:emailLoadId?"not-allowed":"pointer",fontSize:13,fontWeight:600,marginBottom:14,opacity:emailLoadId?.65:1}}>
                                {isBusy(selEmail.id,"reply")?"Drafting…":curReply?"↺ Re-draft":"✨ Draft Reply"}
                              </button>
                              {isBusy(selEmail.id,"reply") && <Spinner label="Writing your reply…" />}
                              {curReply && !isBusy(selEmail.id,"reply") && (
                                <div ref={replyRef} style={{animation:"fadeIn .25s ease"}}>
                                  <div style={{fontSize:11,fontWeight:700,color:"#374151",marginBottom:8,letterSpacing:.3}}>DRAFTED REPLY — edit before sending</div>
                                  <textarea value={curReply} onChange={ev=>setReplies(p=>({...p,[selEmail.id]:ev.target.value}))} style={{width:"100%",minHeight:190,padding:14,border:"1px solid #D1D5DB",borderRadius:10,fontSize:13,lineHeight:1.75,resize:"vertical",color:"#374151",background:"#fff"}} />
                                  <div style={{display:"flex",gap:10,marginTop:10}}>
                                    <button onClick={sendReply} style={{padding:"9px 20px",background:"#059669",color:"#fff",border:"none",borderRadius:8,cursor:"pointer",fontSize:13,fontWeight:600}}>📤 Send via Gmail</button>
                                    <button onClick={()=>setReplies(p=>{const n={...p};delete n[selEmail.id];return n;})} style={{padding:"9px 14px",background:"#F3F4F6",color:"#374151",border:"none",borderRadius:8,cursor:"pointer",fontSize:13}}>Discard</button>
                                  </div>
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  </>
                )}

                {/* COMPOSE */}
                {tab==="Compose" && (
                  <div style={{flex:1,overflowY:"auto",padding:32}}>
                    <div style={{maxWidth:640}}>
                      <div style={{fontFamily:"'DM Serif Display',serif",fontSize:22,marginBottom:5}}>Compose Email</div>
                      <div style={{fontSize:13,color:"#6B7280",marginBottom:22}}>Tell the agent what to write — it handles the rest.</div>
                      <label style={{fontSize:11,fontWeight:700,color:"#374151",display:"block",marginBottom:6,letterSpacing:.3}}>INSTRUCTION</label>
                      <textarea value={composeText} onChange={ev=>setComposeText(ev.target.value)} placeholder={'e.g. "Email Sarah Mitchell to reschedule her Thursday appointment to Tuesday at 11am"'} style={{width:"100%",minHeight:90,padding:14,border:"1px solid #D1D5DB",borderRadius:10,fontSize:13,lineHeight:1.6,resize:"vertical",color:"#374151",background:"#fff",marginBottom:14}} />
                      <button onClick={compose} disabled={composeLoading||!composeText.trim()} style={{padding:"10px 20px",background:"#0EA5E9",color:"#fff",border:"none",borderRadius:8,cursor:composeLoading||!composeText.trim()?"not-allowed":"pointer",fontSize:13,fontWeight:600,marginBottom:20,opacity:composeLoading||!composeText.trim()?.65:1}}>
                        {composeLoading?"Composing…":"✨ Generate Email"}
                      </button>
                      {composeLoading && <Spinner label="Composing your email…" />}
                      {composed && !composeLoading && (
                        <div style={{animation:"fadeIn .25s ease"}}>
                          <div style={{background:"#fff",border:"1px solid #E5E7EB",borderRadius:12,padding:20}}>
                            {[{lb:"TO",k:"to"},{lb:"SUBJECT",k:"subject"}].map(({lb,k})=>(
                              <div key={k} style={{marginBottom:14}}>
                                <div style={{fontSize:10,fontWeight:700,color:"#6B7280",marginBottom:4,letterSpacing:.5}}>{lb}</div>
                                <input value={composed[k]} onChange={ev=>setComposed(p=>({...p,[k]:ev.target.value}))} style={{width:"100%",padding:"8px 10px",border:"1px solid #E5E7EB",borderRadius:6,fontSize:13,color:"#111827",background:"#FAFAFA"}} />
                              </div>
                            ))}
                            <div>
                              <div style={{fontSize:10,fontWeight:700,color:"#6B7280",marginBottom:4,letterSpacing:.5}}>BODY</div>
                              <textarea value={composed.body} onChange={ev=>setComposed(p=>({...p,body:ev.target.value}))} style={{width:"100%",minHeight:200,padding:"8px 10px",border:"1px solid #E5E7EB",borderRadius:6,fontSize:13,lineHeight:1.75,resize:"vertical",color:"#374151",background:"#FAFAFA"}} />
                            </div>
                          </div>
                          <div style={{display:"flex",gap:10,marginTop:12}}>
                            <button onClick={sendComposed} style={{padding:"9px 20px",background:"#059669",color:"#fff",border:"none",borderRadius:8,cursor:"pointer",fontSize:13,fontWeight:600}}>📤 Send via Gmail</button>
                            <button onClick={()=>{setComposed(null);setComposeText("");}} style={{padding:"9px 14px",background:"#F3F4F6",color:"#374151",border:"none",borderRadius:8,cursor:"pointer",fontSize:13}}>Discard</button>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* PAPERWORK */}
                {tab==="Paperwork" && (
                  <div style={{flex:1,overflowY:"auto",padding:32}}>
                    <div style={{maxWidth:720}}>
                      <div style={{fontFamily:"'DM Serif Display',serif",fontSize:22,marginBottom:5}}>Paperwork Queue</div>
                      <div style={{fontSize:13,color:"#6B7280",marginBottom:22}}>AI drafts each document — you review and approve before filing.</div>
                      <div style={{display:"flex",flexDirection:"column",gap:12}}>
                        {docs.map(doc=>{
                          const isFiled=doc.status==="filed", isReady=doc.status==="ready", isLoading=docLoadId===doc.id;
                          return (
                            <div key={doc.id} style={{background:"#fff",border:"1px solid "+(isReady?"#BBF7D0":"#E5E7EB"),borderRadius:12,padding:16,opacity:isFiled?.5:1,animation:"fadeIn .2s ease"}}>
                              <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:12}}>
                                <div style={{flex:1}}>
                                  <div style={{fontSize:14,fontWeight:600,marginBottom:3}}>{doc.name}</div>
                                  <div style={{fontSize:12,color:"#6B7280",marginBottom:8}}>Patient: {doc.patient}</div>
                                  <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                                    <span style={{fontSize:11,fontWeight:600,padding:"2px 9px",borderRadius:20,background:isFiled?"#F3F4F6":isReady?"#F0FFF4":doc.status==="draft"?"#FFFBEB":"#F3F4F6",color:isFiled?"#9CA3AF":isReady?"#166534":doc.status==="draft"?"#92400E":"#6B7280"}}>
                                      {isFiled?"✓ Filed":isReady?"✓ Ready":doc.status==="draft"?"Draft":"Pending"}
                                    </span>
                                    <span style={{fontSize:11,fontWeight:600,padding:"2px 9px",borderRadius:20,background:doc.urgent&&!isFiled?"#FFF0F0":"#F3F4F6",color:doc.urgent&&!isFiled?"#C0392B":"#6B7280"}}>Due: {doc.due}</span>
                                  </div>
                                </div>
                                {!isFiled && (
                                  <div style={{flexShrink:0}}>
                                    {!isReady
                                      ? <button onClick={()=>processDoc(doc)} disabled={!!docLoadId} style={{padding:"8px 14px",background:isLoading?"#E5E7EB":"#0EA5E9",color:isLoading?"#6B7280":"#fff",border:"none",borderRadius:8,cursor:docLoadId?"not-allowed":"pointer",fontSize:12,fontWeight:600,whiteSpace:"nowrap"}}>{isLoading?"Processing…":"✨ Process"}</button>
                                      : <button onClick={()=>approveDoc(doc)} style={{padding:"8px 14px",background:"#059669",color:"#fff",border:"none",borderRadius:8,cursor:"pointer",fontSize:12,fontWeight:600,whiteSpace:"nowrap"}}>✓ Approve & File</button>
                                    }
                                  </div>
                                )}
                              </div>
                              {isLoading && <div style={{marginTop:10}}><Spinner label={"Drafting "+doc.name+"…"} /></div>}
                              {doc.draft && !isLoading && (
                                <div style={{marginTop:12,animation:"fadeIn .25s ease"}}>
                                  <div style={{fontSize:10,fontWeight:700,color:"#6B7280",marginBottom:6,letterSpacing:.5}}>🤖 AI DRAFT — review before approving</div>
                                  <textarea value={doc.draft} onChange={ev=>setDocs(p=>p.map(d=>d.id===doc.id?{...d,draft:ev.target.value}:d))} style={{width:"100%",minHeight:100,padding:"8px 10px",border:"1px solid #D1D5DB",borderRadius:8,fontSize:12,lineHeight:1.65,resize:"vertical",color:"#374151",background:"#FAFAFA"}} />
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                )}

                {/* ACTIVITY LOG */}
                {tab==="Activity Log" && (
                  <div style={{flex:1,overflowY:"auto",padding:32}}>
                    <div style={{maxWidth:640}}>
                      <div style={{fontFamily:"'DM Serif Display',serif",fontSize:22,marginBottom:5}}>Activity Log</div>
                      <div style={{fontSize:13,color:"#6B7280",marginBottom:22}}>Every action the agent has taken today.</div>
                      {log.map((item,i)=>(
                        <div key={i} style={{display:"flex",gap:14,paddingBottom:14,paddingLeft:16,marginLeft:6,borderLeft:"2px solid #E5E7EB",animation:"fadeIn .15s ease"}}>
                          <div style={{fontSize:11,color:"#9CA3AF",whiteSpace:"nowrap",paddingTop:2,minWidth:54}}>{item.time}</div>
                          <div style={{fontSize:13,color:"#374151",lineHeight:1.55}}>{item.action}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

              </div>
            </div>
          </div>
        </div>
      );
    }

    const root = ReactDOM.createRoot(document.getElementById("root"));
    root.render(<App />);
  </script>
</body>
</html>`);
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Expert Physio Agent running on port ${PORT}`));
