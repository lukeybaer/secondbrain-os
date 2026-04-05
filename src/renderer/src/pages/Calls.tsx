import React, { useState, useEffect, useRef } from "react";
import { startListening, type ListenConnection } from "../lib/listenAudio";

interface CallRecord {
  id: string;
  createdAt: string;
  phoneNumber: string;
  instructions: string;
  personalContext: string;
  personaId?: string;
  status: "queued" | "ringing" | "in-progress" | "forwarding" | "ended" | "error";
  listenUrl?: string;
  endedReason?: string;
  transcript?: string;
  summary?: string;
  durationSeconds?: number;
}

const STATUS_COLORS: Record<string, string> = {
  queued: "#facc15",
  ringing: "#60a5fa",
  "in-progress": "#4ade80",
  forwarding: "#a78bfa",
  ended: "#555",
  error: "#f87171",
};

const TERMINAL_STATUSES = new Set(["ended", "error"]);

const style = {
  page: { padding: 24, flex: 1, overflow: "auto" as const, color: "#e0e0e0" },
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
    padding: "8px 12px",
    background: "#1a1a1a",
    border: "1px solid #2a2a2a",
    borderRadius: 6,
    color: "#e0e0e0",
    fontSize: 13,
    outline: "none",
    resize: "vertical" as const,
    marginBottom: 8,
    boxSizing: "border-box" as const,
    fontFamily: "inherit",
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
  btnLink: {
    background: "none",
    border: "none",
    color: "#7c3aed",
    cursor: "pointer",
    fontSize: 12,
    padding: 0,
  },
  error: { fontSize: 12, color: "#f87171", marginTop: 6 },
  label: { fontSize: 12, color: "#888", marginBottom: 6, display: "block" as const },
  meta: { fontSize: 11, color: "#555" },
};



function StatusBadge({ status }: { status: string }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        fontSize: 11,
        color: STATUS_COLORS[status] ?? "#888",
        fontWeight: 600,
        textTransform: "uppercase" as const,
        letterSpacing: "0.05em",
      }}
    >
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: STATUS_COLORS[status] ?? "#888",
          display: "inline-block",
        }}
      />
      {status}
    </span>
  );
}

function CallCard({
  call,
  onRefresh,
  onRepeat,
  onMarkComplete,
  pcRef,
}: {
  call: CallRecord;
  onRefresh: (id: string) => void;
  onRepeat: (call: CallRecord) => void;
  onMarkComplete: (id: string, completed: boolean) => void;
  pcRef: React.MutableRefObject<Map<string, ListenConnection>>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [muted, setMuted] = useState(false);
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const isActive = !TERMINAL_STATUSES.has(call.status);
  const isEnded = call.status === "ended";
  const isListening = pcRef.current.has(call.id);

  // Auto-scroll transcript to bottom when it updates during active calls
  useEffect(() => {
    if (isActive && call.transcript) {
      transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [call.transcript, isActive]);

  function toggleMute() {
    const conn = pcRef.current.get(call.id);
    if (!conn) return;
    conn.setMuted(!muted);
    setMuted(!muted);
  }

  return (
    <div
      style={{
        ...style.card,
        marginBottom: 10,
        borderLeft: `3px solid ${call.completed ? "#22c55e" : (STATUS_COLORS[call.status] ?? "#333")}`,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
        <div style={{ display: "flex", flexDirection: "column" as const, gap: 4 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: "#fff" }}>{call.phoneNumber}</div>
            {call.isCallback && (
              <span style={{ fontSize: 10, color: "#60a5fa", background: "#0a1a2a", border: "1px solid #1a3a5a", borderRadius: 4, padding: "1px 6px", fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase" as const }}>
                Callback
              </span>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <StatusBadge status={call.status} />
            {isEnded && (
              <span style={{
                fontSize: 10, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: "0.06em",
                color: call.completed ? "#22c55e" : "#f59e0b",
                background: call.completed ? "#052e16" : "#1c1000",
                border: `1px solid ${call.completed ? "#166534" : "#78350f"}`,
                borderRadius: 4, padding: "1px 6px",
              }}>
                {call.completed ? "Completed" : "Incomplete"}
              </span>
            )}
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" as const, justifyContent: "flex-end" }}>
          {isActive && (
            <button style={style.btnSmall} onClick={() => onRefresh(call.id)}>
              Refresh
            </button>
          )}
          {isEnded && (
            <button
              style={{ ...style.btnSmall, color: call.completed ? "#f87171" : "#4ade80", borderColor: call.completed ? "#3a1414" : "#143a14" }}
              onClick={() => onMarkComplete(call.id, !call.completed)}
            >
              {call.completed ? "Mark Incomplete" : "Mark Complete"}
            </button>
          )}
          <button
            style={{ ...style.btnSmall, borderColor: "#3a2a5a", color: "#a78bfa" }}
            onClick={() => onRepeat(call)}
          >
            Repeat
          </button>
          <span style={style.meta}>{new Date(call.createdAt).toLocaleString()}</span>
        </div>
      </div>

      <div style={{ fontSize: 12, color: "#aaa", marginBottom: 6, lineHeight: 1.5 }}>
        {call.instructions.length > 120 ? call.instructions.slice(0, 120) + "…" : call.instructions}
      </div>

      {call.durationSeconds !== undefined && (
        <div style={{ fontSize: 11, color: "#555", marginBottom: 6 }}>
          Duration: {Math.floor(call.durationSeconds / 60)}m {call.durationSeconds % 60}s
          {call.endedReason && ` · ${call.endedReason}`}
        </div>
      )}

      {isListening && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            background: "#0d1f0d",
            border: "1px solid #1a3a1a",
            borderRadius: 6,
            padding: "6px 12px",
            marginBottom: 8,
          }}
        >
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#4ade80", display: "inline-block" }} />
          <span style={{ fontSize: 12, color: "#4ade80", flex: 1 }}>
            Listening live… <span style={{ color: "#2d6a2d", fontSize: 10 }}>({pcRef.current.get(call.id)?.getDebugInfo() ?? "…"})</span>
          </span>
          <button style={style.btnSmall} onClick={toggleMute}>
            {muted ? "Unmute" : "Mute"}
          </button>
        </div>
      )}

      {/* Live transcript — always visible during active calls, toggle for ended */}
      {call.transcript && isActive && (
        <div style={{
          marginTop: 4,
          padding: "8px 12px",
          background: "#0a1a0a",
          border: "1px solid #1a3a1a",
          borderRadius: 6,
          fontSize: 12,
          color: "#b0d0b0",
          whiteSpace: "pre-wrap" as const,
          maxHeight: 200,
          overflow: "auto",
        }}>
          <div style={{ fontSize: 10, color: "#3a6a3a", marginBottom: 4, fontWeight: 600, letterSpacing: "0.05em", textTransform: "uppercase" as const }}>
            Live transcript
          </div>
          {call.transcript}
          <div ref={transcriptEndRef} />
        </div>
      )}

      {call.transcript && !isActive && (
        <div>
          <button style={style.btnLink} onClick={() => setExpanded(!expanded)}>
            {expanded ? "Hide transcript" : "Show transcript"}
          </button>
          {expanded && (
            <div
              style={{
                marginTop: 8,
                padding: "10px 12px",
                background: "#0f0f0f",
                border: "1px solid #222",
                borderRadius: 6,
                fontSize: 12,
                color: "#ccc",
                whiteSpace: "pre-wrap" as const,
                maxHeight: 300,
                overflow: "auto",
              }}
            >
              {call.transcript}
            </div>
          )}
        </div>
      )}

      {call.summary && !call.transcript && (
        <div style={{ fontSize: 12, color: "#888", fontStyle: "italic" as const, marginTop: 4 }}>
          {call.summary}
        </div>
      )}
    </div>
  );
}

interface Persona {
  id: string;
  name: string;
  instructions: string;
  summary?: string;
}

interface PendingCall {
  phoneNumber: string;
  instructions: string;
  listenIn?: boolean;
  personaId?: string;
}

export default function Calls({ active, pendingCall, autoListen }: {
  active?: boolean;
  pendingCall?: PendingCall | null;
  autoListen?: boolean;
}) {
  const [calls, setCalls] = useState<CallRecord[]>([]);
  const [loading, setLoading] = useState(true);

  const [personas, setPersonas] = useState<Persona[]>([]);
  const [selectedPersonaId, setSelectedPersonaId] = useState<string>("");
  const [editingPersona, setEditingPersona] = useState<Persona | null>(null);
  const [editName, setEditName] = useState("");
  const [editInstructions, setEditInstructions] = useState("");
  const [editSaving, setEditSaving] = useState(false);

  const [phoneNumber, setPhoneNumber] = useState("");
  const [instructions, setInstructions] = useState("");
  const [listenIn, setListenIn] = useState(false);

  const [leaveVoicemail, setLeaveVoicemail] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [placeError, setPlaceError] = useState("");

  const pcMap = useRef<Map<string, ListenConnection>>(new Map());
  // callId → listenUrl, waiting until call goes active before connecting audio
  const pendingListenRef = useRef<Map<string, string>>(new Map());
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const formRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    load();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pcMap.current.forEach((conn) => conn.cleanup());
      pendingListenRef.current.clear();
    };
  }, []);

  // When page becomes active: load list immediately, then sync inbound in background
  useEffect(() => {
    if (!active) return;
    loadPersonas();
    // Load immediately so newly-placed workflow calls appear right away
    window.api.calls.list().then(setCalls);
    // Sync inbound callbacks in background (slower network call)
    window.api.calls.syncInbound().then(() =>
      window.api.calls.list().then(setCalls)
    );
  }, [active]);

  // Refresh call list every 2s while active — picks up calls placed by the workflow
  // mid-session when active never changes (page stays on calls between workflow tasks)
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => {
      window.api.calls.list().then(setCalls);
    }, 2000);
    return () => clearInterval(id);
  }, [active]);

  // Auto-listen: mute when leaving page, connect/unmute when returning
  useEffect(() => {
    if (!autoListen) return;
    if (!active) {
      // Mute all active connections when user leaves the page
      pcMap.current.forEach((conn) => conn.setMuted(true));
      return;
    }
    // Page is active + autoListen on: connect to any live call we're not already on
    calls.forEach((call) => {
      if (TERMINAL_STATUSES.has(call.status)) return;
      const existing = pcMap.current.get(call.id);
      if (existing) {
        existing.setMuted(false);
        return;
      }
      if (!call.listenUrl) return;
      if (["ringing", "in-progress"].includes(call.status)) {
        startListening(call.listenUrl)
          .then((conn) => { pcMap.current.set(call.id, conn); setCalls((prev) => [...prev]); })
          .catch(() => {});
      } else {
        // Still queued — let the poll loop connect once it's ringing
        if (!pendingListenRef.current.has(call.id)) {
          pendingListenRef.current.set(call.id, call.listenUrl);
        }
      }
    });
  }, [active, autoListen, calls]);

  // Pre-fill form when a pending call is passed in from another page
  useEffect(() => {
    if (!pendingCall) return;
    setPhoneNumber(pendingCall.phoneNumber);
    setInstructions(pendingCall.instructions);
    if (pendingCall.listenIn) setListenIn(true);
    if (pendingCall.personaId) setSelectedPersonaId(pendingCall.personaId);
    formRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [pendingCall]);

  async function loadPersonas() {
    const list = await window.api.personas.list();
    setPersonas(list);
  }

  // Auto-poll active calls every 5 seconds
  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    const activeCalls = calls.filter((c) => !TERMINAL_STATUSES.has(c.status));
    if (activeCalls.length === 0) return;
    pollRef.current = setInterval(async () => {
      for (const call of activeCalls) {
        const res = await window.api.calls.refresh(call.id);
        if (res.success && res.record) {
          setCalls((prev) => prev.map((c) => (c.id === call.id ? res.record! : c)));
          const newStatus = res.record.status;
          // Connect audio once call is active (not while still queued)
          if (
            ["ringing", "in-progress"].includes(newStatus) &&
            pendingListenRef.current.has(call.id) &&
            !pcMap.current.has(call.id)
          ) {
            const url = pendingListenRef.current.get(call.id)!;
            pendingListenRef.current.delete(call.id);
            const tryListen = (attemptsLeft: number) => {
              startListening(url)
                .then((conn) => {
                  pcMap.current.set(call.id, conn);
                  setCalls((prev) => [...prev]);
                })
                .catch((err) => {
                  if (attemptsLeft > 0 && !TERMINAL_STATUSES.has(newStatus)) {
                    setTimeout(() => tryListen(attemptsLeft - 1), 2000);
                  } else {
                    setPlaceError(`Audio connect failed: ${err.message}`);
                  }
                });
            };
            tryListen(2);
          }
          if (TERMINAL_STATUSES.has(newStatus)) {
            pendingListenRef.current.delete(call.id);
            if (pcMap.current.has(call.id)) {
              pcMap.current.get(call.id)!.cleanup();
              pcMap.current.delete(call.id);
            }
            // Fire post-call reflection to update EA agent memory (fire-and-forget)
            if (newStatus === "ended") {
              const updatedCall = res.record!;
              (window.api as any).agent?.postCallReflection({
                callId: updatedCall.id,
                phoneNumber: updatedCall.phoneNumber,
                instructions: updatedCall.instructions,
                outcome: updatedCall.endedReason ?? "ended",
                transcript: updatedCall.transcript,
                durationSeconds: updatedCall.durationSeconds,
              }).catch(() => {});
            }
          }
        }
      }
    }, 5000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [calls.map((c) => c.status).join(",")]);

  async function load() {
    setLoading(true);
    try {
      // Pull any inbound callbacks from Vapi we don't have locally yet
      await window.api.calls.syncInbound();
      const list = await window.api.calls.list();
      setCalls(list);
    } finally {
      setLoading(false);
    }
  }

  function startEditPersona(p: Persona) {
    setEditingPersona(p);
    setEditName(p.name);
    setEditInstructions(p.instructions);
  }

  async function saveEditPersona() {
    if (!editingPersona) return;
    setEditSaving(true);
    try {
      const updated = await window.api.personas.save({
        id: editingPersona.id,
        name: editName.trim(),
        instructions: editInstructions.trim(),
        summary: undefined,
      });
      setPersonas((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
      setEditingPersona(null);
    } finally {
      setEditSaving(false);
    }
  }

  async function handlePlace(e: React.FormEvent) {
    e.preventDefault();
    setPlaceError("");
    if (!phoneNumber.trim() || !instructions.trim()) return;
    setPlacing(true);
    try {
      const res = await window.api.calls.initiate(
        phoneNumber.trim(),
        instructions.trim(),
        "",
        selectedPersonaId || undefined,
        leaveVoicemail,
      );
      if (!res.success) {
        setPlaceError(res.error ?? "Failed to place call");
        return;
      }
      const list = await window.api.calls.list();
      setCalls(list);
      setPhoneNumber("");
      setInstructions("");

      // Queue listen connection — will activate once call reaches ringing/in-progress
      if (listenIn && res.listenUrl && res.callId) {
        pendingListenRef.current.set(res.callId, res.listenUrl);
      }
    } finally {
      setPlacing(false);
    }
  }

  function handleRepeat(call: CallRecord) {
    setPhoneNumber(call.phoneNumber);
    setInstructions(call.instructions);
    setSelectedPersonaId(call.personaId ?? "");
    setLeaveVoicemail(call.leaveVoicemail ?? false);
    setEditingPersona(null);
    setPlaceError("");
    formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function handleRefresh(callId: string) {
    const res = await window.api.calls.refresh(callId);
    if (res.success && res.record) {
      setCalls((prev) => prev.map((c) => (c.id === callId ? res.record! : c)));
    }
  }

  async function handleMarkComplete(callId: string, completed: boolean) {
    const updated = await window.api.calls.markComplete(callId, completed);
    if (updated) {
      setCalls((prev) => prev.map((c) => (c.id === callId ? updated : c)));
    }
  }

  const selectedPersona = personas.find((p) => p.id === selectedPersonaId);

  return (
    <div style={style.page}>
      <h1 style={style.title}>Phone Calls</h1>
      <p style={{ fontSize: 12, color: "#555", marginBottom: 20, lineHeight: 1.5 }}>
        Make outbound AI-powered calls on your behalf. The AI will conduct the conversation and complete your task.
        Powered by <span style={{ color: "#888" }}>Vapi.ai</span> — add your API key in Settings.
      </p>

      <div style={style.card} ref={formRef}>
        <div style={{ fontSize: 12, color: "#888", marginBottom: 12 }}>New call</div>
        <form onSubmit={handlePlace}>
          <label style={style.label}>Phone number</label>
          <input
            type="tel"
            placeholder="+1 (555) 123-4567"
            value={phoneNumber}
            onChange={(e) => setPhoneNumber(e.target.value)}
            style={style.input}
          />

          <label style={style.label}>Persona <span style={{ color: "#444" }}>(optional)</span></label>
          {personas.length === 0 ? (
            <div style={{ fontSize: 12, color: "#444", marginBottom: 12 }}>
              No personas yet — create one in the Personas page to pre-configure how the AI behaves.
            </div>
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap" as const, gap: 6, marginBottom: 8 }}>
              <button
                type="button"
                onClick={() => { setSelectedPersonaId(""); setEditingPersona(null); }}
                style={{
                  padding: "5px 12px", borderRadius: 20,
                  border: `1px solid ${!selectedPersonaId ? "#7c3aed" : "#2a2a2a"}`,
                  background: !selectedPersonaId ? "#2a1a4a" : "#1a1a1a",
                  color: !selectedPersonaId ? "#c4b5fd" : "#555",
                  fontSize: 12, cursor: "pointer",
                }}
              >
                None
              </button>
              {personas.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => { setSelectedPersonaId(p.id); setEditingPersona(null); }}
                  title={p.summary ?? p.instructions.slice(0, 120)}
                  style={{
                    padding: "5px 12px", borderRadius: 20,
                    border: `1px solid ${selectedPersonaId === p.id ? "#7c3aed" : "#2a2a2a"}`,
                    background: selectedPersonaId === p.id ? "#2a1a4a" : "#1a1a1a",
                    color: selectedPersonaId === p.id ? "#c4b5fd" : "#888",
                    fontSize: 12, cursor: "pointer",
                  }}
                >
                  {p.name}
                </button>
              ))}
            </div>
          )}

          {/* Inline persona editor */}
          {selectedPersona && !editingPersona && (
            <div style={{ marginBottom: 10 }}>
              {selectedPersona.summary && (
                <div style={{ fontSize: 11, color: "#555", marginBottom: 6, lineHeight: 1.5 }}>
                  {selectedPersona.summary}
                </div>
              )}
              <button type="button" style={style.btnLink} onClick={() => startEditPersona(selectedPersona)}>
                Edit persona
              </button>
            </div>
          )}

          {editingPersona && (
            <div style={{ background: "#0f0f0f", border: "1px solid #2a1a4a", borderRadius: 6, padding: 12, marginBottom: 10 }}>
              <div style={{ fontSize: 11, color: "#7c3aed", marginBottom: 8 }}>Editing: {editingPersona.name}</div>
              <input
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                style={{ ...style.input, marginBottom: 8 }}
                placeholder="Persona name"
              />
              <textarea
                value={editInstructions}
                onChange={(e) => setEditInstructions(e.target.value)}
                rows={6}
                style={{ ...style.textarea, marginBottom: 8 }}
              />
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  type="button"
                  style={{ ...style.btn, fontSize: 12, padding: "5px 12px" }}
                  onClick={saveEditPersona}
                  disabled={editSaving || !editName.trim() || !editInstructions.trim()}
                >
                  {editSaving ? "Saving…" : "Save"}
                </button>
                <button type="button" style={style.btnSmall} onClick={() => setEditingPersona(null)}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          <label style={{ ...style.label, marginTop: 4 }}>
            {selectedPersonaId ? "Call-specific instructions" : "Instructions"}
          </label>
          <textarea
            placeholder={
              selectedPersonaId
                ? "What should the AI accomplish on this specific call? (layered on top of the persona)"
                : "Order a large pepperoni pizza for delivery. My address is 123 Main St."
            }
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            rows={3}
            style={style.textarea}
          />

          <div style={{ display: "flex", flexDirection: "column" as const, gap: 8, marginBottom: 14 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#aaa", cursor: "pointer", userSelect: "none" as const }}>
              <input
                type="checkbox"
                checked={listenIn}
                onChange={(e) => setListenIn(e.target.checked)}
                style={{ accentColor: "#7c3aed", width: 14, height: 14 }}
              />
              Listen live through my speakers
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#aaa", cursor: "pointer", userSelect: "none" as const }}>
              <input
                type="checkbox"
                checked={leaveVoicemail}
                onChange={(e) => setLeaveVoicemail(e.target.checked)}
                style={{ accentColor: "#7c3aed", width: 14, height: 14 }}
              />
              Leave a voicemail if no answer
            </label>
          </div>

          {placeError && <div style={style.error}>{placeError}</div>}
          <button
            type="submit"
            style={{ ...style.btn, opacity: placing ? 0.6 : 1 }}
            disabled={placing || !phoneNumber.trim() || !instructions.trim()}
          >
            {placing ? "Placing call…" : "Place Call"}
          </button>
        </form>
      </div>

      <div style={{ fontSize: 12, color: "#555", marginBottom: 10 }}>
        Call history ({calls.length})
      </div>

      {loading ? (
        <div style={{ color: "#555", fontSize: 13 }}>Loading…</div>
      ) : calls.length === 0 ? (
        <div style={{ color: "#555", fontSize: 13 }}>No calls yet. Place your first call above.</div>
      ) : (
        calls.map((call) => (
          <CallCard
            key={call.id}
            call={call}
            onRefresh={handleRefresh}
            onRepeat={handleRepeat}
            onMarkComplete={handleMarkComplete}
            pcRef={pcMap}
          />
        ))
      )}
    </div>
  );
}
