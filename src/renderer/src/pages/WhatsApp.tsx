import React, { useState, useEffect } from "react";

interface WhatsAppMessage {
  id: string;
  messageId: string;
  source: "inbound" | "outbound";
  from: string;
  to: string;
  body: string;
  timestamp: string;
  contactName?: string;
  createdAt: string;
}

export default function WhatsApp({ onCountChange }: { onCountChange?: () => void }) {
  const [messages, setMessages] = useState<WhatsAppMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [sendTo, setSendTo] = useState("");
  const [sendBody, setSendBody] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const [webhookPaste, setWebhookPaste] = useState("");
  const [ingesting, setIngesting] = useState(false);
  const [ingestResult, setIngestResult] = useState("");

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setLoading(true);
    try {
      const list = await window.api.whatsapp.list();
      setMessages(list);
      onCountChange?.();
    } finally {
      setLoading(false);
    }
  }

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    setSendError("");
    if (!sendTo.trim() || !sendBody.trim()) return;
    setSending(true);
    try {
      const result = await window.api.whatsapp.send(sendTo.trim(), sendBody.trim());
      if (result.success) {
        setSendBody("");
        load();
      } else {
        setSendError(result.error ?? "Failed to send");
      }
    } finally {
      setSending(false);
    }
  }

  async function handleIngest() {
    if (!webhookPaste.trim()) return;
    setIngesting(true);
    setIngestResult("");
    try {
      let payload: unknown;
      try {
        payload = JSON.parse(webhookPaste);
      } catch {
        setIngestResult("Invalid JSON");
        return;
      }
      const count = await window.api.whatsapp.ingest(payload);
      setIngestResult(`Saved ${count} message(s).`);
      setWebhookPaste("");
      load();
    } finally {
      setIngesting(false);
    }
  }

  const style = {
    page: {
      padding: 24,
      flex: 1,
      overflow: "auto" as const,
      color: "#e0e0e0",
    },
    title: { fontSize: 18, fontWeight: 700, color: "#fff", marginBottom: 20 },
    card: {
      background: "#141414",
      border: "1px solid #1e1e1e",
      borderRadius: 8,
      padding: 16,
      marginBottom: 16,
    },
    input: {
      width: "100%",
      padding: "8px 12px",
      background: "#1a1a1a",
      border: "1px solid #2a2a2a",
      borderRadius: 6,
      color: "#e0e0e0",
      fontSize: 13,
      outline: "none",
      marginBottom: 8,
      boxSizing: "border-box" as const,
    },
    textarea: {
      width: "100%",
      minHeight: 120,
      padding: "8px 12px",
      background: "#1a1a1a",
      border: "1px solid #2a2a2a",
      borderRadius: 6,
      color: "#e0e0e0",
      fontSize: 12,
      fontFamily: "monospace",
      outline: "none",
      resize: "vertical" as const,
      marginBottom: 8,
      boxSizing: "border-box" as const,
    },
    btn: {
      padding: "8px 16px",
      background: "#7c3aed",
      border: "none",
      borderRadius: 6,
      color: "#fff",
      cursor: "pointer",
      fontSize: 13,
      fontWeight: 600,
    },
    btnSecondary: {
      padding: "8px 16px",
      background: "#2a2a2a",
      border: "1px solid #333",
      borderRadius: 6,
      color: "#e0e0e0",
      cursor: "pointer",
      fontSize: 13,
    },
    error: { fontSize: 12, color: "#f87171", marginTop: 6 },
    meta: { fontSize: 11, color: "#555", marginBottom: 4 },
  };

  return (
    <div style={style.page}>
      <h1 style={style.title}>WhatsApp</h1>
      <p style={{ fontSize: 12, color: "#555", marginBottom: 20, lineHeight: 1.5 }}>
        Send messages via WhatsApp Cloud API. Inbound messages: configure your app webhook to POST here, or paste webhook JSON below to ingest.
      </p>

      <div style={style.card}>
        <div style={{ fontSize: 12, color: "#888", marginBottom: 10 }}>Send message</div>
        <form onSubmit={handleSend}>
          <input
            type="text"
            placeholder="To (e.g. 15551234567)"
            value={sendTo}
            onChange={e => setSendTo(e.target.value)}
            style={style.input}
          />
          <textarea
            placeholder="Message text"
            value={sendBody}
            onChange={e => setSendBody(e.target.value)}
            rows={3}
            style={{ ...style.input, minHeight: 60 }}
          />
          {sendError && <div style={style.error}>{sendError}</div>}
          <button type="submit" style={style.btn} disabled={sending}>
            {sending ? "Sending…" : "Send"}
          </button>
        </form>
      </div>

      <div style={style.card}>
        <div style={{ fontSize: 12, color: "#888", marginBottom: 10 }}>Ingest webhook payload (paste JSON)</div>
        <textarea
          placeholder='Paste Cloud API webhook body, e.g. {"object":"whatsapp_business_account","entry":[...]}'
          value={webhookPaste}
          onChange={e => setWebhookPaste(e.target.value)}
          style={style.textarea}
        />
        {ingestResult && <div style={{ fontSize: 12, color: "#4ade80", marginBottom: 8 }}>{ingestResult}</div>}
        <button type="button" style={style.btnSecondary} onClick={handleIngest} disabled={ingesting}>
          {ingesting ? "Ingesting…" : "Ingest messages"}
        </button>
      </div>

      <div style={style.card}>
        <div style={{ fontSize: 12, color: "#888", marginBottom: 10 }}>
          Messages ({messages.length})
        </div>
        {loading ? (
          <div style={{ color: "#555", fontSize: 13 }}>Loading…</div>
        ) : messages.length === 0 ? (
          <div style={{ color: "#555", fontSize: 13 }}>No WhatsApp messages yet. Send one or ingest a webhook payload.</div>
        ) : (
          <div style={{ maxHeight: 400, overflow: "auto" }}>
            {messages.map(m => (
              <div
                key={m.id}
                style={{
                  ...style.card,
                  marginBottom: 8,
                  borderLeft: `3px solid ${m.source === "inbound" ? "#4ade80" : "#60a5fa"}`,
                }}
              >
                <div style={style.meta}>
                  {m.source === "inbound" ? "From" : "To"}: {m.source === "inbound" ? m.from : m.to}
                  {m.contactName && ` (${m.contactName})`} · {new Date(m.timestamp || m.createdAt).toLocaleString()}
                </div>
                <div style={{ fontSize: 13, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                  {m.body}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
