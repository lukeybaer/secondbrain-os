import React, { useState, useRef, useEffect } from "react";

interface CallAction {
  phoneNumber: string;
  instructions: string;
  personalContext: string;
  leaveVoicemail: boolean;
  personaId?: string;
  personaName?: string;
}

interface ProjectAction {
  name: string;
  description: string;
  strategy: string;
  tags: string[];
}

interface Message {
  role: "user" | "assistant";
  content: string;
  callAction?: CallAction;
  callStatus?: "pending" | "placing" | "placed" | "error" | "cancelled";
  callId?: string;
  callError?: string;
  projectAction?: ProjectAction;
  projectStatus?: "pending" | "creating" | "created" | "error" | "cancelled";
  projectId?: string;
  projectError?: string;
}

interface Session {
  id: string;
  startedAt: string;
  messages: Message[];
  contextSummary?: string;
}

const EXAMPLES = [
  "Summarize my last 5 meetings",
  "What decisions have we made about the product roadmap?",
  "Call the dentist at +1 555 123 4567 to reschedule my appointment",
  "Who have I spoken to most about hiring?",
];

export default function Chat({ onConversationSaved }: { onConversationSaved?: () => void }) {
  const [session, setSession] = useState<Session | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [newChatMenu, setNewChatMenu] = useState(false);
  const [summarizing, setSummarizing] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const loadedMsgCountRef = useRef(0);
  const sessionRef = useRef<Session | null>(null);

  // Keep sessionRef in sync so callbacks can access latest session
  useEffect(() => { sessionRef.current = session; }, [session]);

  // Load latest session on mount
  useEffect(() => {
    (async () => {
      try {
        const latest = await window.api.chats.loadLatest();
        if (latest && latest.messages?.length > 0) {
          setSession(latest);
          setMessages(latest.messages);
          loadedMsgCountRef.current = latest.messages.length;
        } else {
          const newSession: Session = {
            id: `chat_${Date.now().toString(36)}`,
            startedAt: new Date().toISOString(),
            messages: [],
          };
          setSession(newSession);
          await window.api.chats.save(newSession);
        }
      } catch {
        const newSession: Session = {
          id: `chat_${Date.now().toString(36)}`,
          startedAt: new Date().toISOString(),
          messages: [],
        };
        setSession(newSession);
      }
    })();
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamText]);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";
  }, [input]);

  // Close menu on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setNewChatMenu(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  async function persistMessages(msgs: Message[], sess: Session) {
    const updatedSession: Session = { ...sess, messages: msgs };
    setSession(updatedSession);
    await window.api.chats.save(updatedSession).catch(() => {});
    window.api.chats.autoTag(updatedSession).catch(() => {});
  }

  async function send() {
    if (!input.trim() || loading || !session) return;
    const question = input.trim();
    setInput("");
    setLoading(true);
    setStreamText("");

    const updatedMessages = [...messages, { role: "user" as const, content: question }];
    setMessages(updatedMessages);

    window.api.chat.onDelta(delta => setStreamText(prev => prev + delta));

    try {
      const result = await window.api.chat.send(question, messages);
      if (result.success && result.response) {
        const newMsg: Message = { role: "assistant", content: result.response };

        if (result.action?.type === "initiate_call") {
          newMsg.callAction = {
            phoneNumber: result.action.phoneNumber,
            instructions: result.action.instructions,
            personalContext: result.action.personalContext,
            leaveVoicemail: result.action.leaveVoicemail,
            personaId: result.action.personaId,
            personaName: result.action.personaName,
          };
          newMsg.callStatus = "pending";
        } else if (result.action?.type === "create_project") {
          newMsg.projectAction = {
            name: result.action.name,
            description: result.action.description,
            strategy: result.action.strategy,
            tags: result.action.tags,
          };
          newMsg.projectStatus = "pending";
        }

        const finalMessages = [...updatedMessages, newMsg];
        setMessages(finalMessages);
        await persistMessages(finalMessages, sessionRef.current ?? session);
      } else {
        const finalMessages = [...updatedMessages, { role: "assistant" as const, content: `❌ ${result.error || "Something went wrong"}` }];
        setMessages(finalMessages);
        await persistMessages(finalMessages, sessionRef.current ?? session);
      }
    } catch (err: any) {
      const finalMessages = [...updatedMessages, { role: "assistant" as const, content: `❌ ${err.message}` }];
      setMessages(finalMessages);
    } finally {
      window.api.chat.offDelta();
      setStreamText("");
      setLoading(false);
    }
  }

  async function handleConfirmCall(msgIndex: number) {
    const msg = messages[msgIndex];
    if (!msg.callAction) return;

    const placing = messages.map((m, i) =>
      i === msgIndex ? { ...m, callStatus: "placing" as const } : m
    );
    setMessages(placing);

    const { phoneNumber, instructions, personalContext, leaveVoicemail, personaId } = msg.callAction;
    const result = await window.api.calls.initiate(phoneNumber, instructions, personalContext, personaId, leaveVoicemail);

    if (result.success) {
      const placed = placing.map((m, i) =>
        i === msgIndex ? { ...m, callStatus: "placed" as const, callId: result.callId } : m
      );
      setMessages(placed);
      const sess = sessionRef.current;
      if (sess) await persistMessages(placed, sess);
    } else {
      const errored = placing.map((m, i) =>
        i === msgIndex ? { ...m, callStatus: "error" as const, callError: result.error } : m
      );
      setMessages(errored);
      const sess = sessionRef.current;
      if (sess) await persistMessages(errored, sess);
    }
  }

  async function handleConfirmProject(msgIndex: number) {
    const msg = messages[msgIndex];
    if (!msg.projectAction) return;

    const creating = messages.map((m, i) =>
      i === msgIndex ? { ...m, projectStatus: "creating" as const } : m
    );
    setMessages(creating);

    const { name, description, strategy, tags } = msg.projectAction;
    try {
      const proj = await window.api.projects.create({ name, description, strategy, tags });
      const created = creating.map((m, i) =>
        i === msgIndex ? { ...m, projectStatus: "created" as const, projectId: proj?.id } : m
      );
      setMessages(created);
      const sess = sessionRef.current;
      if (sess) await persistMessages(created, sess);
    } catch (err: any) {
      const errored = creating.map((m, i) =>
        i === msgIndex ? { ...m, projectStatus: "error" as const, projectError: err.message } : m
      );
      setMessages(errored);
    }
  }

  function handleCancelProject(msgIndex: number) {
    const cancelled = messages.map((m, i) =>
      i === msgIndex ? { ...m, projectStatus: "cancelled" as const } : m
    );
    setMessages(cancelled);
    const sess = sessionRef.current;
    if (sess) persistMessages(cancelled, sess);
  }

  function handleCancelCall(msgIndex: number) {
    const cancelled = messages.map((m, i) =>
      i === msgIndex ? { ...m, callStatus: "cancelled" as const } : m
    );
    setMessages(cancelled);
    const sess = sessionRef.current;
    if (sess) persistMessages(cancelled, sess);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  async function startFresh() {
    setNewChatMenu(false);
    if (session && messages.length >= 2) {
      await window.api.chats.finish(session).catch(() => {});
      onConversationSaved?.();
    }
    const newSession: Session = {
      id: `chat_${Date.now().toString(36)}`,
      startedAt: new Date().toISOString(),
      messages: [],
    };
    setSession(newSession);
    setMessages([]);
    loadedMsgCountRef.current = 0;
    await window.api.chats.save(newSession).catch(() => {});
  }

  async function startWithContext() {
    if (!session || messages.length < 2) {
      startFresh();
      return;
    }
    setNewChatMenu(false);
    setSummarizing(true);

    try {
      await window.api.chats.finish(session).catch(() => {});
      onConversationSaved?.();

      const res = await window.api.chats.summarize(session);
      const summary = res?.summary || "";

      const newSession: Session = {
        id: `chat_${Date.now().toString(36)}`,
        startedAt: new Date().toISOString(),
        messages: [],
        contextSummary: summary || undefined,
      };
      setSession(newSession);
      setMessages([]);
      loadedMsgCountRef.current = 0;
      await window.api.chats.save(newSession).catch(() => {});
    } finally {
      setSummarizing(false);
    }
  }

  const hasMessages = messages.length > 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Top bar */}
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "flex-end",
        padding: "8px 16px",
        borderBottom: "1px solid #1e1e1e",
        background: "#111",
        gap: 8,
        flexShrink: 0,
      }}>
        <div style={{ position: "relative" }} ref={menuRef}>
          <button
            onClick={() => setNewChatMenu(v => !v)}
            disabled={loading || summarizing}
            style={{
              padding: "5px 12px",
              background: "none",
              border: "1px solid #2a2a2a",
              borderRadius: 6,
              color: "#666",
              cursor: "pointer",
              fontSize: 12,
              display: "flex",
              alignItems: "center",
              gap: 5,
            }}
          >
            {summarizing ? "Summarizing…" : "+ New Chat"} <span style={{ fontSize: 9 }}>▼</span>
          </button>

          {newChatMenu && (
            <div style={{
              position: "absolute",
              top: "calc(100% + 4px)",
              right: 0,
              background: "#1a1a1a",
              border: "1px solid #2a2a2a",
              borderRadius: 8,
              overflow: "hidden",
              zIndex: 100,
              minWidth: 200,
              boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
            }}>
              <MenuOption
                label="Start fresh"
                desc="Clear this chat, save it as a conversation"
                onClick={startFresh}
              />
              <MenuOption
                label="Start with context"
                desc="Summarize this chat, carry it forward"
                onClick={startWithContext}
                disabled={messages.length < 2}
              />
            </div>
          )}
        </div>
      </div>

      {/* Messages area */}
      <div style={{ flex: 1, overflow: "auto", padding: "24px 0" }}>
        {!hasMessages ? (
          <div style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            height: "100%",
            padding: "0 24px",
          }}>
            {session?.contextSummary ? (
              <ContextBanner summary={session.contextSummary} />
            ) : (
              <>
                <div style={{ fontSize: 40, marginBottom: 12 }}>🧠</div>
                <div style={{ fontSize: 18, fontWeight: 600, color: "#ccc", marginBottom: 6 }}>
                  Ask anything. Make calls.
                </div>
                <div style={{ fontSize: 13, color: "#555", textAlign: "center", maxWidth: 440, lineHeight: 1.6 }}>
                  Search your Otter.ai transcripts, or ask me to place a phone call on your behalf.
                </div>
                <div style={{ marginTop: 28, display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center", maxWidth: 520 }}>
                  {EXAMPLES.map(ex => (
                    <button
                      key={ex}
                      onClick={() => setInput(ex)}
                      style={{
                        padding: "7px 14px",
                        background: "#1a1a1a",
                        border: "1px solid #2a2a2a",
                        borderRadius: 20,
                        color: "#777",
                        cursor: "pointer",
                        fontSize: 12,
                        transition: "border-color 0.15s, color 0.15s",
                      }}
                      onMouseEnter={e => { (e.target as HTMLElement).style.borderColor = "#7c3aed"; (e.target as HTMLElement).style.color = "#ccc"; }}
                      onMouseLeave={e => { (e.target as HTMLElement).style.borderColor = "#2a2a2a"; (e.target as HTMLElement).style.color = "#777"; }}
                    >
                      {ex}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        ) : (
          <div style={{ maxWidth: 820, margin: "0 auto", padding: "0 24px" }}>
            {session?.contextSummary && (
              <ContextBanner summary={session.contextSummary} compact />
            )}

            {messages.map((msg, i) => (
              <MessageBubble
                key={i}
                message={msg}
                msgIndex={i}
                isExpiredPending={i < loadedMsgCountRef.current && msg.callStatus === "pending"}
                onConfirmCall={handleConfirmCall}
                onCancelCall={handleCancelCall}
                onConfirmProject={handleConfirmProject}
                onCancelProject={handleCancelProject}
              />
            ))}

            {loading && streamText && (
              <MessageBubble
                message={{ role: "assistant", content: streamText }}
                msgIndex={-1}
                streaming
                onConfirmCall={() => {}}
                onCancelCall={() => {}}
              />
            )}
            {loading && !streamText && (
              <div style={{ display: "flex", gap: 12, marginBottom: 20 }}>
                <Avatar role="assistant" />
                <div style={{
                  padding: "10px 14px",
                  background: "#1a1a1a",
                  border: "1px solid #222",
                  borderRadius: "4px 12px 12px 12px",
                  fontSize: 13,
                  color: "#555",
                }}>
                  Thinking...
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Input */}
      <div style={{
        padding: "12px 24px 16px",
        borderTop: "1px solid #1e1e1e",
        background: "#111",
      }}>
        <div style={{ maxWidth: 820, margin: "0 auto" }}>
          <div style={{ display: "flex", gap: 10, alignItems: "flex-end" }}>
            <textarea
              ref={textareaRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder='Ask about meetings, or "call [name] at [number] to…"'
              rows={1}
              style={{
                flex: 1,
                padding: "10px 14px",
                background: "#1a1a1a",
                border: "1px solid #2a2a2a",
                borderRadius: 8,
                color: "#e0e0e0",
                fontSize: 14,
                resize: "none",
                outline: "none",
                lineHeight: 1.5,
                fontFamily: "inherit",
                transition: "border-color 0.15s",
              }}
              onFocus={e => (e.target.style.borderColor = "#7c3aed")}
              onBlur={e => (e.target.style.borderColor = "#2a2a2a")}
            />
            <button
              onClick={send}
              disabled={loading || !input.trim()}
              style={{
                padding: "10px 18px",
                background: loading || !input.trim() ? "#1a1a1a" : "#7c3aed",
                border: "1px solid " + (loading || !input.trim() ? "#2a2a2a" : "#7c3aed"),
                borderRadius: 8,
                color: loading || !input.trim() ? "#444" : "#fff",
                cursor: loading || !input.trim() ? "not-allowed" : "pointer",
                fontSize: 14,
                fontWeight: 600,
                whiteSpace: "nowrap",
                flexShrink: 0,
              }}
            >
              Send
            </button>
          </div>

          {hasMessages && (
            <div style={{ textAlign: "center", marginTop: 8 }}>
              <span style={{ fontSize: 11, color: "#2a2a2a" }}>
                {messages.length} message{messages.length !== 1 ? "s" : ""} · saved automatically
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────────

function ContextBanner({ summary, compact }: { summary: string; compact?: boolean }) {
  return (
    <div style={{
      background: "#13111f",
      border: "1px solid #2d2060",
      borderRadius: 8,
      padding: compact ? "10px 14px" : "16px 20px",
      marginBottom: compact ? 20 : 0,
      maxWidth: compact ? "100%" : 520,
    }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: "#7c3aed", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>
        Context from previous chat
      </div>
      <div style={{ fontSize: 13, color: "#aaa", lineHeight: 1.6 }}>{summary}</div>
    </div>
  );
}

function MenuOption({ label, desc, onClick, disabled }: {
  label: string; desc: string; onClick: () => void; disabled?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onClick={disabled ? undefined : onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "block",
        width: "100%",
        padding: "10px 14px",
        background: hovered && !disabled ? "#222" : "transparent",
        border: "none",
        borderBottom: "1px solid #222",
        textAlign: "left",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.4 : 1,
      }}
    >
      <div style={{ fontSize: 13, color: "#e0e0e0", fontWeight: 500 }}>{label}</div>
      <div style={{ fontSize: 11, color: "#666", marginTop: 2 }}>{desc}</div>
    </button>
  );
}

function Avatar({ role }: { role: "user" | "assistant" }) {
  return (
    <div style={{
      width: 30,
      height: 30,
      borderRadius: "50%",
      background: role === "user" ? "#7c3aed" : "#1e1e1e",
      border: "1px solid " + (role === "user" ? "#7c3aed" : "#2a2a2a"),
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      fontSize: 13,
      flexShrink: 0,
    }}>
      {role === "user" ? "U" : "🧠"}
    </div>
  );
}

function MessageBubble({
  message,
  msgIndex,
  streaming,
  isExpiredPending,
  onConfirmCall,
  onCancelCall,
  onConfirmProject,
  onCancelProject,
}: {
  message: Message;
  msgIndex: number;
  streaming?: boolean;
  isExpiredPending?: boolean;
  onConfirmCall: (i: number) => void;
  onCancelCall: (i: number) => void;
  onConfirmProject?: (i: number) => void;
  onCancelProject?: (i: number) => void;
}) {
  const isUser = message.role === "user";
  return (
    <div style={{ display: "flex", gap: 12, marginBottom: 20, flexDirection: isUser ? "row-reverse" : "row" }}>
      <Avatar role={message.role} />
      <div style={{ maxWidth: "80%", display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{
          padding: "10px 14px",
          borderRadius: isUser ? "12px 4px 12px 12px" : "4px 12px 12px 12px",
          background: isUser ? "#1e1530" : "#1a1a1a",
          border: `1px solid ${isUser ? "#3d2d6a" : "#222"}`,
          fontSize: 14,
          lineHeight: 1.65,
          color: "#ddd",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}>
          {message.content}
          {streaming && (
            <span style={{ animation: "blink 1s infinite", color: "#7c3aed" }}>▌</span>
          )}
        </div>

        {/* Call confirm card */}
        {!isUser && message.callAction && !streaming && (
          <CallConfirmCard
            action={message.callAction}
            status={isExpiredPending ? "cancelled" : (message.callStatus ?? "pending")}
            callId={message.callId}
            error={message.callError}
            onConfirm={() => onConfirmCall(msgIndex)}
            onCancel={() => onCancelCall(msgIndex)}
          />
        )}

        {/* Project create card */}
        {!isUser && message.projectAction && !streaming && (
          <ProjectConfirmCard
            action={message.projectAction}
            status={message.projectStatus ?? "pending"}
            projectId={message.projectId}
            error={message.projectError}
            onConfirm={() => onConfirmProject?.(msgIndex)}
            onCancel={() => onCancelProject?.(msgIndex)}
          />
        )}
      </div>
    </div>
  );
}

function CallConfirmCard({
  action,
  status,
  callId,
  error,
  onConfirm,
  onCancel,
}: {
  action: CallAction;
  status: "pending" | "placing" | "placed" | "error" | "cancelled";
  callId?: string;
  error?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [confirmHover, setConfirmHover] = useState(false);
  const [cancelHover, setCancelHover] = useState(false);

  return (
    <div style={{
      background: "#111820",
      border: "1px solid #1e3a5f",
      borderRadius: 10,
      padding: "14px 16px",
      fontSize: 13,
    }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 12 }}>
        <span style={{ fontSize: 16 }}>📞</span>
        <span style={{ fontWeight: 600, color: "#7eb8f7", fontSize: 13 }}>Call Request</span>
      </div>

      {/* Details */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 14 }}>
        <Row label="To" value={action.phoneNumber} />
        <Row label="Goal" value={action.instructions} />
        {action.personalContext && <Row label="Context" value={action.personalContext} />}
        {action.personaName && <Row label="Persona" value={action.personaName} />}
        {action.leaveVoicemail && (
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 11, background: "#1a3a1a", color: "#6dbf6d", border: "1px solid #2a5a2a", borderRadius: 4, padding: "1px 6px" }}>
              Leave voicemail if no answer
            </span>
          </div>
        )}
      </div>

      {/* Status / actions */}
      {status === "pending" && (
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={onConfirm}
            onMouseEnter={() => setConfirmHover(true)}
            onMouseLeave={() => setConfirmHover(false)}
            style={{
              padding: "7px 16px",
              background: confirmHover ? "#1a7a3a" : "#145a2a",
              border: "1px solid #2a8a4a",
              borderRadius: 6,
              color: "#7ddf9d",
              cursor: "pointer",
              fontSize: 13,
              fontWeight: 600,
            }}
          >
            Place Call
          </button>
          <button
            onClick={onCancel}
            onMouseEnter={() => setCancelHover(true)}
            onMouseLeave={() => setCancelHover(false)}
            style={{
              padding: "7px 16px",
              background: cancelHover ? "#2a2a2a" : "transparent",
              border: "1px solid #333",
              borderRadius: 6,
              color: "#666",
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            Cancel
          </button>
        </div>
      )}

      {status === "placing" && (
        <div style={{ color: "#7eb8f7", fontSize: 13 }}>Placing call…</div>
      )}

      {status === "placed" && (
        <div style={{ color: "#6dbf6d", fontSize: 13 }}>
          ✓ Call placed{callId ? ` · ID: ${callId.slice(0, 8)}…` : ""} · Check the Calls tab for status
        </div>
      )}

      {status === "error" && (
        <div style={{ color: "#e07070", fontSize: 13 }}>
          ❌ {error || "Failed to place call"}
        </div>
      )}

      {status === "cancelled" && (
        <div style={{ color: "#555", fontSize: 13 }}>Call was not placed</div>
      )}
    </div>
  );
}

function ProjectConfirmCard({
  action,
  status,
  projectId,
  error,
  onConfirm,
  onCancel,
}: {
  action: ProjectAction;
  status: "pending" | "creating" | "created" | "error" | "cancelled";
  projectId?: string;
  error?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div style={{
      background: "#151211",
      border: "1px solid #3d2d1e",
      borderRadius: 10,
      padding: "14px 16px",
      fontSize: 13,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 12 }}>
        <span style={{ fontSize: 16 }}>📋</span>
        <span style={{ fontWeight: 600, color: "#f7c67e", fontSize: 13 }}>Create Project</span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 14 }}>
        <Row label="Name" value={action.name} />
        {action.description && <Row label="About" value={action.description} />}
        {action.strategy && <Row label="Strategy" value={action.strategy} />}
        {action.tags.length > 0 && <Row label="Tags" value={action.tags.join(", ")} />}
      </div>

      {status === "pending" && (
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={onConfirm}
            style={{
              padding: "7px 16px",
              background: "#3d2000",
              border: "1px solid #7c5a00",
              borderRadius: 6,
              color: "#f7c67e",
              cursor: "pointer",
              fontSize: 13,
              fontWeight: 600,
            }}
          >
            Create Project
          </button>
          <button
            onClick={onCancel}
            style={{
              padding: "7px 16px",
              background: "transparent",
              border: "1px solid #333",
              borderRadius: 6,
              color: "#666",
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            Cancel
          </button>
        </div>
      )}

      {status === "creating" && (
        <div style={{ color: "#f7c67e", fontSize: 13 }}>Creating project…</div>
      )}

      {status === "created" && (
        <div style={{ color: "#6dbf6d", fontSize: 13 }}>
          ✓ Project created — check the Projects tab
        </div>
      )}

      {status === "error" && (
        <div style={{ color: "#e07070", fontSize: 13 }}>❌ {error || "Failed to create project"}</div>
      )}

      {status === "cancelled" && (
        <div style={{ color: "#555", fontSize: 13 }}>Project was not created</div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
      <span style={{ color: "#4a7a9b", fontSize: 12, minWidth: 55, paddingTop: 1 }}>{label}</span>
      <span style={{ color: "#ccc", fontSize: 13, lineHeight: 1.5 }}>{value}</span>
    </div>
  );
}
