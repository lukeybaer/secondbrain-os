import React, { useState, useEffect, useRef } from "react";

// ── Message type ─────────────────────────────────────────────────────────────

interface UnifiedMessage {
  id: string;
  messageId: string;
  channel: "sms";
  source: "inbound" | "outbound";
  from: string;
  to: string;
  body: string;
  timestamp: string;
  contactName?: string;
  mediaUrls?: string[];
  mediaTypes?: string[];
  createdAt: string;
}

type TimeFilter = "all" | "today" | "7days" | "30days";

function localFileUrl(filePath: string): string {
  return `media://local/${filePath.replace(/\\/g, "/")}`;
}

function timeFilterDate(filter: TimeFilter): Date | null {
  if (filter === "all") return null;
  const now = new Date();
  if (filter === "today") return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (filter === "7days") return new Date(now.getTime() - 7 * 86400000);
  if (filter === "30days") return new Date(now.getTime() - 30 * 86400000);
  return null;
}

// ── Styles ──────────────────────────────────────────────────────────────────

const s = {
  page: { padding: 24, flex: 1, overflow: "auto" as const, color: "#e0e0e0" },
  title: { fontSize: 18, fontWeight: 700, color: "#fff", marginBottom: 6 },
  subtitle: { fontSize: 12, color: "#555", marginBottom: 20, lineHeight: 1.5 },
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
  btnSmall: {
    padding: "4px 10px",
    background: "#2a2a2a",
    border: "1px solid #333",
    borderRadius: 5,
    color: "#e0e0e0",
    cursor: "pointer",
    fontSize: 12,
  },
  error: { fontSize: 12, color: "#f87171", marginTop: 6 },
  meta: { fontSize: 11, color: "#555", marginBottom: 4 },
  filterPill: (active: boolean) => ({
    padding: "4px 12px",
    background: active ? "#7c3aed" : "#1a1a1a",
    border: `1px solid ${active ? "#7c3aed" : "#2a2a2a"}`,
    borderRadius: 20,
    color: active ? "#fff" : "#888",
    cursor: "pointer",
    fontSize: 12,
    fontWeight: active ? 600 : 400,
  }),
};

const CHANNEL_BADGE: Record<string, { bg: string; color: string; label: string }> = {
  sms: { bg: "#1e3a5f", color: "#60a5fa", label: "SMS" },
};

// ── Component ───────────────────────────────────────────────────────────────

export default function Messages({ onCountChange }: { onCountChange?: () => void }) {
  const [allMessages, setAllMessages] = useState<UnifiedMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [timeFilter, setTimeFilter] = useState<TimeFilter>("all");
  const [search, setSearch] = useState("");
  const searchTimer = useRef<ReturnType<typeof setTimeout>>();

  // Send form state
  const [sendChannel] = useState<"sms">("sms");
  const [sendTo, setSendTo] = useState("");
  const [sendBody, setSendBody] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");

  // File attach
  const fileRef = useRef<HTMLInputElement>(null);
  const [attachedFile, setAttachedFile] = useState<File | null>(null);
  const [attachPreview, setAttachPreview] = useState<string>("");

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    try {
      const smsList = await window.api.sms.list();
      const msgs: UnifiedMessage[] = smsList.map((m: any) => ({ ...m, channel: "sms" as const }));
      msgs.sort((a, b) => (b.createdAt || b.timestamp).localeCompare(a.createdAt || a.timestamp));
      setAllMessages(msgs);
      onCountChange?.();
    } finally {
      setLoading(false);
    }
  }

  // Filtered messages
  const filtered = allMessages.filter(m => {
    const cutoff = timeFilterDate(timeFilter);
    if (cutoff && new Date(m.timestamp || m.createdAt) < cutoff) return false;
    if (search) {
      const q = search.toLowerCase();
      return (
        m.body.toLowerCase().includes(q) ||
        m.from.includes(q) ||
        m.to.includes(q) ||
        (m.contactName && m.contactName.toLowerCase().includes(q))
      );
    }
    return true;
  });

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    setSendError("");
    if (!sendTo.trim() || !sendBody.trim()) return;
    setSending(true);
    try {
      const result = await window.api.sms.send(sendTo.trim(), sendBody.trim());
      if (result.success) {
        setSendBody("");
        setAttachedFile(null);
        setAttachPreview("");
        load();
      } else {
        setSendError(result.error ?? "Failed to send");
      }
    } finally {
      setSending(false);
    }
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setAttachedFile(file);
    if (file.type.startsWith("image/") || file.type.startsWith("video/")) {
      const reader = new FileReader();
      reader.onload = () => setAttachPreview(reader.result as string);
      reader.readAsDataURL(file);
    } else {
      setAttachPreview("");
    }
  }

  function onSearchChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value;
    setSearch(val);
  }

  return (
    <div style={s.page}>
      <h1 style={s.title}>SMS Messages</h1>
      <p style={s.subtitle}>
        SMS messaging via Twilio. Send, receive, and search. For WhatsApp, use the WhatsApp tab.
      </p>

      {/* ── Filter bar ────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>

        {/* Time filter */}
        <select
          value={timeFilter}
          onChange={e => setTimeFilter(e.target.value as TimeFilter)}
          style={{
            padding: "4px 8px",
            background: "#1a1a1a",
            border: "1px solid #2a2a2a",
            borderRadius: 6,
            color: "#e0e0e0",
            fontSize: 12,
            outline: "none",
          }}
        >
          <option value="all">All time</option>
          <option value="today">Today</option>
          <option value="7days">Last 7 days</option>
          <option value="30days">Last 30 days</option>
        </select>

        {/* Search */}
        <input
          type="text"
          placeholder="Search messages..."
          value={search}
          onChange={onSearchChange}
          style={{
            ...s.input,
            marginBottom: 0,
            flex: 1,
            minWidth: 160,
          }}
        />

        {/* Refresh */}
        <button onClick={() => load()} style={s.btnSmall} title="Refresh">↺</button>
      </div>

      {/* ── Send card ─────────────────────────────────────────────────────── */}
      <div style={s.card}>
        <div style={{ fontSize: 12, color: "#888", marginBottom: 10 }}>Send SMS</div>
        <form onSubmit={handleSend}>
          <input
            type="text"
            placeholder="To (e.g. +15551234567)"
            value={sendTo}
            onChange={e => setSendTo(e.target.value)}
            style={s.input}
          />
          <textarea
            placeholder="Message text"
            value={sendBody}
            onChange={e => setSendBody(e.target.value)}
            rows={3}
            style={{ ...s.input, minHeight: 60 }}
          />
          {/* Attach */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <input
              ref={fileRef}
              type="file"
              accept="image/*,video/*"
              onChange={handleFileSelect}
              style={{ display: "none" }}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              style={s.btnSmall}
            >
              Attach file
            </button>
            {attachedFile && (
              <span style={{ fontSize: 11, color: "#888" }}>
                {attachedFile.name} ({(attachedFile.size / 1024).toFixed(0)} KB)
                <button
                  type="button"
                  onClick={() => { setAttachedFile(null); setAttachPreview(""); }}
                  style={{ background: "none", border: "none", color: "#f87171", cursor: "pointer", marginLeft: 4, fontSize: 11 }}
                >
                  remove
                </button>
              </span>
            )}
          </div>
          {attachPreview && attachedFile?.type.startsWith("image/") && (
            <img src={attachPreview} alt="" style={{ maxWidth: 120, maxHeight: 120, borderRadius: 4, marginBottom: 8 }} />
          )}
          {sendError && <div style={s.error}>{sendError}</div>}
          <button type="submit" style={s.btn} disabled={sending}>
            {sending ? "Sending..." : "Send"}
          </button>
        </form>
      </div>

      {/* ── Message list ──────────────────────────────────────────────────── */}
      <div style={s.card}>
        <div style={{ fontSize: 12, color: "#888", marginBottom: 10 }}>
          Messages ({filtered.length})
        </div>
        {loading ? (
          <div style={{ color: "#555", fontSize: 13 }}>Loading...</div>
        ) : filtered.length === 0 ? (
          <div style={{ color: "#555", fontSize: 13 }}>
            No SMS messages. Send one or wait for inbound.
          </div>
        ) : (
          <div style={{ maxHeight: 500, overflow: "auto" }}>
            {filtered.map(m => (
              <MessageRow key={m.id} message={m} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Message row ─────────────────────────────────────────────────────────────

function MessageRow({ message: m }: { message: UnifiedMessage }) {
  const badge = CHANNEL_BADGE[m.channel];

  return (
    <div style={{
      ...s.card,
      marginBottom: 8,
      borderLeft: `3px solid ${m.source === "inbound" ? "#4ade80" : "#60a5fa"}`,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
        {/* Channel badge */}
        <span style={{
          fontSize: 9,
          fontWeight: 700,
          textTransform: "uppercase" as const,
          letterSpacing: "0.05em",
          color: badge.color,
          background: badge.bg,
          borderRadius: 3,
          padding: "1px 5px",
        }}>
          {badge.label}
        </span>
        <span style={s.meta}>
          {m.source === "inbound" ? "From" : "To"}: {m.source === "inbound" ? m.from : m.to}
          {m.contactName && ` (${m.contactName})`}
        </span>
        <span style={{ ...s.meta, marginLeft: "auto" }}>
          {new Date(m.timestamp || m.createdAt).toLocaleString()}
        </span>
      </div>
      <div style={{ fontSize: 13, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
        {m.body}
      </div>
      {/* Media attachments */}
      {m.mediaUrls && m.mediaUrls.length > 0 && (
        <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
          {m.mediaUrls.map((url, i) => {
            const type = m.mediaTypes?.[i] || "";
            const src = url.startsWith("http") ? url : localFileUrl(url);
            if (type.startsWith("video/") || url.endsWith(".mp4")) {
              return (
                <video key={i} src={src} controls muted
                  style={{ maxWidth: 225, maxHeight: 300, borderRadius: 4 }}
                />
              );
            }
            return (
              <img key={i} src={src} alt=""
                style={{ maxWidth: 200, maxHeight: 200, borderRadius: 4, objectFit: "cover" }}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
