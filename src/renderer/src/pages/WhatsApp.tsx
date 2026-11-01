import React, { useState, useEffect, useRef } from "react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface WAChat {
  id: string;
  name: string;
  lastMessage: string;
  lastMessageTime: number;
  unreadCount: number;
  isGroup: boolean;
}

interface WAMessage {
  id: string;
  chatId: string;
  from: string;
  fromName?: string;
  to: string;
  body: string;
  timestamp: number;
  fromMe: boolean;
  type: string;
}

type WAStatus = "disconnected" | "initializing" | "qr" | "authenticated" | "ready" | "auth_failure";

// ── Styles ────────────────────────────────────────────────────────────────────

const s = {
  page: {
    display: "flex" as const,
    flex: 1,
    overflow: "hidden" as const,
    background: "#0f0f0f",
    color: "#e0e0e0",
  },
  sidebar: {
    width: 260,
    flexShrink: 0,
    borderRight: "1px solid #1e1e1e",
    display: "flex" as const,
    flexDirection: "column" as const,
    overflow: "hidden" as const,
  },
  sidebarHeader: {
    padding: "12px 14px",
    borderBottom: "1px solid #1e1e1e",
    display: "flex" as const,
    alignItems: "center" as const,
    gap: 8,
  },
  chatItem: (active: boolean) => ({
    padding: "10px 14px",
    cursor: "pointer" as const,
    background: active ? "#1a1a1a" : "transparent",
    borderBottom: "1px solid #141414",
    transition: "background 0.1s",
  }),
  main: {
    flex: 1,
    display: "flex" as const,
    flexDirection: "column" as const,
    overflow: "hidden" as const,
  },
  msgArea: {
    flex: 1,
    overflowY: "auto" as const,
    padding: "12px 16px",
    display: "flex" as const,
    flexDirection: "column" as const,
    gap: 6,
  },
  bubble: (fromMe: boolean) => ({
    maxWidth: "70%",
    alignSelf: fromMe ? ("flex-end" as const) : ("flex-start" as const),
    background: fromMe ? "#4c1d95" : "#1a1a1a",
    borderRadius: fromMe ? "16px 16px 4px 16px" : "16px 16px 16px 4px",
    padding: "8px 12px",
  }),
  sendBar: {
    padding: "10px 14px",
    borderTop: "1px solid #1e1e1e",
    display: "flex" as const,
    gap: 8,
    alignItems: "flex-end" as const,
  },
  input: {
    flex: 1,
    padding: "8px 12px",
    background: "#1a1a1a",
    border: "1px solid #2a2a2a",
    borderRadius: 20,
    color: "#e0e0e0",
    fontSize: 13,
    outline: "none",
    resize: "none" as const,
    lineHeight: 1.4,
  },
  btn: {
    padding: "8px 16px",
    background: "#7c3aed",
    border: "none",
    borderRadius: 20,
    color: "#fff",
    cursor: "pointer" as const,
    fontSize: 13,
    fontWeight: 600 as const,
    whiteSpace: "nowrap" as const,
  },
  btnGhost: {
    padding: "6px 12px",
    background: "none",
    border: "1px solid #2a2a2a",
    borderRadius: 6,
    color: "#888",
    cursor: "pointer" as const,
    fontSize: 12,
  },
};

// ── Status badge ──────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: WAStatus }) {
  const cfg: Record<WAStatus, { color: string; label: string }> = {
    disconnected:  { color: "#555",    label: "Disconnected" },
    initializing:  { color: "#f59e0b", label: "Starting…" },
    qr:            { color: "#f59e0b", label: "Scan QR Code" },
    authenticated: { color: "#4ade80", label: "Authenticated" },
    ready:         { color: "#4ade80", label: "Connected" },
    auth_failure:  { color: "#f87171", label: "Auth Failed" },
  };
  const { color, label } = cfg[status] ?? cfg.disconnected;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12 }}>
      <span style={{ width: 7, height: 7, borderRadius: "50%", background: color, flexShrink: 0 }} />
      <span style={{ color }}>{label}</span>
    </span>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function WhatsApp() {
  const [status, setStatus]           = useState<WAStatus>("disconnected");
  const [qrDataUrl, setQrDataUrl]     = useState<string>("");
  const [chats, setChats]             = useState<WAChat[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [messages, setMessages]       = useState<WAMessage[]>([]);
  const [sendText, setSendText]       = useState("");
  const [sending, setSending]         = useState(false);
  const [sendErr, setSendErr]         = useState("");
  const [searchQ, setSearchQ]         = useState("");
  const [searchResults, setSearchResults] = useState<WAMessage[] | null>(null);
  const [searching, setSearching]     = useState(false);
  const [connecting, setConnecting]   = useState(false);
  const msgEndRef = useRef<HTMLDivElement>(null);

  const activeChat = chats.find(c => c.id === activeChatId) ?? null;

  // ── Init ───────────────────────────────────────────────────────────────────

  useEffect(() => {
    // Get current status
    window.api.whatsapp.status().then(r => setStatus(r.status as WAStatus));

    // Subscribe to events
    window.api.whatsapp.onStatusChange(({ status: s, qrDataUrl: q }) => {
      setStatus(s as WAStatus);
      if (q) setQrDataUrl(q);
      if (s === "ready") {
        setQrDataUrl("");
        loadChats();
      }
    });
    window.api.whatsapp.onMessage((msg: WAMessage) => {
      // Append live messages if we're viewing that chat
      setMessages(prev => {
        if (prev.length > 0 && prev[0].chatId === msg.chatId) {
          if (prev.some(m => m.id === msg.id)) return prev;
          return [...prev, msg];
        }
        return prev;
      });
      // Refresh chat list so last-message updates
      loadChats();
    });

    return () => {
      window.api.whatsapp.offStatusChange();
      window.api.whatsapp.offMessage();
    };
  }, []);

  // Scroll to bottom whenever messages change
  useEffect(() => {
    msgEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // ── Data loaders ───────────────────────────────────────────────────────────

  async function loadChats() {
    const list = await window.api.whatsapp.chats();
    setChats(list.sort((a: WAChat, b: WAChat) => b.lastMessageTime - a.lastMessageTime));
  }

  async function openChat(chatId: string) {
    setActiveChatId(chatId);
    setSearchResults(null);
    setSearchQ("");
    const msgs = await window.api.whatsapp.messages(chatId, 60);
    setMessages(msgs);
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  async function handleConnect() {
    setConnecting(true);
    await window.api.whatsapp.connect();
    setConnecting(false);
  }

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!activeChatId || !sendText.trim()) return;
    setSendErr("");
    setSending(true);
    try {
      const res = await window.api.whatsapp.send(activeChatId, sendText.trim());
      if (res.success) {
        setSendText("");
        // Optimistically append
        const optimistic: WAMessage = {
          id: `opt_${Date.now()}`,
          chatId: activeChatId,
          from: "me",
          to: activeChatId,
          body: sendText.trim(),
          timestamp: Date.now(),
          fromMe: true,
          type: "chat",
        };
        setMessages(prev => [...prev, optimistic]);
      } else {
        setSendErr(res.error ?? "Failed to send");
      }
    } finally {
      setSending(false);
    }
  }

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!searchQ.trim()) return;
    setSearching(true);
    const results = await window.api.whatsapp.search(searchQ.trim());
    setSearchResults(results);
    setSearching(false);
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  // Not connected — show connection panel
  if (status === "disconnected" || status === "auth_failure") {
    return (
      <div style={{ ...s.page, alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 16 }}>
        <div style={{ fontSize: 32 }}>💬</div>
        <div style={{ fontSize: 17, fontWeight: 600, color: "#fff" }}>WhatsApp</div>
        <StatusBadge status={status} />
        {status === "auth_failure" && (
          <div style={{ fontSize: 12, color: "#f87171" }}>Authentication failed. Try connecting again.</div>
        )}
        <button
          style={s.btn}
          onClick={handleConnect}
          disabled={connecting}
        >
          {connecting ? "Starting…" : "Connect WhatsApp"}
        </button>
      </div>
    );
  }

  // Initializing / QR
  if (status === "initializing" || status === "qr" || status === "authenticated") {
    return (
      <div style={{ ...s.page, alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 20 }}>
        <div style={{ fontSize: 17, fontWeight: 600, color: "#fff" }}>WhatsApp</div>
        <StatusBadge status={status} />
        {status === "qr" && qrDataUrl ? (
          <>
            <img
              src={qrDataUrl}
              alt="WhatsApp QR code"
              style={{ width: 240, height: 240, borderRadius: 12, background: "#fff", padding: 8 }}
            />
            <div style={{ fontSize: 12, color: "#666", textAlign: "center", maxWidth: 280, lineHeight: 1.6 }}>
              Open WhatsApp on your phone → <strong style={{ color: "#aaa" }}>Settings → Linked Devices → Link a Device</strong>
            </div>
          </>
        ) : (
          <div style={{ color: "#555", fontSize: 13 }}>Starting Puppeteer… this takes ~15 seconds.</div>
        )}
        <button style={s.btnGhost} onClick={() => window.api.whatsapp.disconnect()}>Cancel</button>
      </div>
    );
  }

  // Ready — full chat UI
  return (
    <div style={s.page}>
      {/* ── Sidebar ──────────────────────────────────────────────────────── */}
      <div style={s.sidebar}>
        {/* Header */}
        <div style={s.sidebarHeader}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "#fff", flex: 1 }}>WhatsApp</span>
          <StatusBadge status={status} />
          <button style={s.btnGhost} title="Refresh chats" onClick={loadChats}>↺</button>
          <button style={{ ...s.btnGhost, color: "#f87171", borderColor: "#3a1a1a" }} title="Disconnect" onClick={() => window.api.whatsapp.disconnect()}>✕</button>
        </div>

        {/* Search bar */}
        <form onSubmit={handleSearch} style={{ padding: "8px 10px", borderBottom: "1px solid #1e1e1e" }}>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              type="text"
              placeholder="Search messages…"
              value={searchQ}
              onChange={e => { setSearchQ(e.target.value); if (!e.target.value) setSearchResults(null); }}
              style={{ ...s.input, borderRadius: 6, flex: 1 }}
            />
            <button type="submit" style={{ ...s.btn, padding: "6px 10px", borderRadius: 6 }} disabled={searching}>
              {searching ? "…" : "Go"}
            </button>
          </div>
        </form>

        {/* Chat list */}
        <div style={{ flex: 1, overflowY: "auto" as const }}>
          {chats.length === 0 ? (
            <div style={{ padding: 16, color: "#444", fontSize: 12 }}>No chats loaded. Click ↺ to refresh.</div>
          ) : (
            chats.map(chat => (
              <div
                key={chat.id}
                style={s.chatItem(chat.id === activeChatId)}
                onClick={() => openChat(chat.id)}
                onMouseEnter={e => {
                  if (chat.id !== activeChatId)
                    (e.currentTarget as HTMLElement).style.background = "#161616";
                }}
                onMouseLeave={e => {
                  if (chat.id !== activeChatId)
                    (e.currentTarget as HTMLElement).style.background = "transparent";
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontSize: 13, fontWeight: 500, color: "#e0e0e0", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {chat.isGroup ? "👥 " : ""}{chat.name}
                  </span>
                  {chat.unreadCount > 0 && (
                    <span style={{ background: "#4ade80", color: "#000", borderRadius: 10, fontSize: 10, fontWeight: 700, padding: "1px 6px" }}>
                      {chat.unreadCount}
                    </span>
                  )}
                </div>
                {chat.lastMessage && (
                  <div style={{ fontSize: 11, color: "#555", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {chat.lastMessage}
                  </div>
                )}
                {chat.lastMessageTime > 0 && (
                  <div style={{ fontSize: 10, color: "#3a3a3a", marginTop: 1 }}>
                    {new Date(chat.lastMessageTime).toLocaleString()}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>

      {/* ── Main panel ───────────────────────────────────────────────────── */}
      <div style={s.main}>
        {searchResults !== null ? (
          /* Search results */
          <div style={{ flex: 1, overflowY: "auto" as const, padding: "12px 16px" }}>
            <div style={{ fontSize: 12, color: "#888", marginBottom: 10 }}>
              {searchResults.length} result{searchResults.length !== 1 ? "s" : ""} for "{searchQ}"
              <button style={{ ...s.btnGhost, marginLeft: 8 }} onClick={() => { setSearchResults(null); setSearchQ(""); }}>Clear</button>
            </div>
            {searchResults.length === 0 ? (
              <div style={{ color: "#444", fontSize: 13 }}>No messages matched.</div>
            ) : (
              searchResults.map(m => (
                <div
                  key={m.id}
                  onClick={() => openChat(m.chatId)}
                  style={{ padding: "10px 12px", background: "#141414", borderRadius: 8, marginBottom: 8, cursor: "pointer", borderLeft: "3px solid #7c3aed" }}
                >
                  <div style={{ fontSize: 11, color: "#555", marginBottom: 4 }}>
                    {chats.find(c => c.id === m.chatId)?.name ?? m.chatId} · {new Date(m.timestamp).toLocaleString()}
                  </div>
                  <div style={{ fontSize: 13 }}>{m.body}</div>
                </div>
              ))
            )}
          </div>
        ) : activeChatId ? (
          /* Message thread */
          <>
            {/* Chat header */}
            <div style={{ padding: "10px 16px", borderBottom: "1px solid #1e1e1e", display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: "#fff", flex: 1 }}>
                {activeChat?.isGroup ? "👥 " : ""}{activeChat?.name ?? activeChatId}
              </span>
              <button style={s.btnGhost} onClick={() => openChat(activeChatId)}>↺</button>
            </div>

            {/* Messages */}
            <div style={s.msgArea}>
              {messages.length === 0 ? (
                <div style={{ color: "#444", fontSize: 13, alignSelf: "center" as const, marginTop: 40 }}>No messages loaded.</div>
              ) : (
                messages.map(m => (
                  <div key={m.id} style={s.bubble(m.fromMe)}>
                    {!m.fromMe && m.fromName && (
                      <div style={{ fontSize: 10, color: "#7c3aed", marginBottom: 2 }}>{m.fromName}</div>
                    )}
                    <div style={{ fontSize: 13, lineHeight: 1.5, wordBreak: "break-word" as const }}>{m.body}</div>
                    <div style={{ fontSize: 10, color: m.fromMe ? "#9f7aea" : "#444", marginTop: 4, textAlign: m.fromMe ? "right" as const : "left" as const }}>
                      {new Date(m.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </div>
                  </div>
                ))
              )}
              <div ref={msgEndRef} />
            </div>

            {/* Send bar */}
            <form onSubmit={handleSend} style={s.sendBar}>
              <textarea
                value={sendText}
                onChange={e => setSendText(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSend(e as any);
                  }
                }}
                placeholder="Type a message… (Enter to send, Shift+Enter for newline)"
                rows={1}
                style={{ ...s.input, maxHeight: 120 }}
              />
              <button type="submit" style={s.btn} disabled={sending || !sendText.trim()}>
                {sending ? "…" : "Send"}
              </button>
            </form>
            {sendErr && <div style={{ padding: "4px 14px 8px", fontSize: 12, color: "#f87171" }}>{sendErr}</div>}
          </>
        ) : (
          /* Empty state */
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 10, color: "#333" }}>
            <div style={{ fontSize: 32 }}>💬</div>
            <div style={{ fontSize: 13 }}>Select a chat to start messaging</div>
            {chats.length === 0 && (
              <button style={s.btn} onClick={loadChats}>Load Chats</button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
