// ClaudeChatOverlay.tsx
// Floating Claude Code chat button + overlay panel.
// Lives on top of every page in the app.
// Also handles the Ctrl+Shift+Space hotkey overlay positioning.

import React, { useState, useEffect, useRef } from "react";

interface OverlayPosition {
  x: number;
  y: number;
  screenshotPath?: string;
}

interface CommandResult {
  id: string;
  prompt: string;
  commandId?: string;
  status: "sending" | "queued" | "worker-timeout" | "processing" | "done" | "error";
  result?: string;
  error?: string;
  timestamp: number;
}

export default function ClaudeChatOverlay({ currentPage }: { currentPage: string }) {
  const [panelOpen, setPanelOpen] = useState(false);
  const [hotkeyOverlay, setHotkeyOverlay] = useState<OverlayPosition | null>(null);
  const [input, setInput] = useState("");
  const [hotkeyInput, setHotkeyInput] = useState("");
  const [results, setResults] = useState<CommandResult[]>([]);
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const hotkeyInputRef = useRef<HTMLInputElement>(null);
  // Tracks setTimeout IDs for "worker-timeout" warnings, keyed by local result id
  const workerTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Listen for command:status IPC events (processing / complete / error)
  useEffect(() => {
    const electron = (window as any).electron;
    if (!electron?.ipcRenderer) return;

    function handleCommandStatus(_e: unknown, event: { commandId: string; status: "processing" | "complete" | "error"; success?: boolean; summary?: string }) {
      setResults(prev => prev.map(r => {
        if (r.commandId !== event.commandId) return r;
        // Clear the worker-timeout timer for this result
        const timer = workerTimers.current.get(r.id);
        if (timer !== undefined) { clearTimeout(timer); workerTimers.current.delete(r.id); }
        if (event.status === "processing") return { ...r, status: "processing" };
        if (event.status === "complete") return { ...r, status: "done", result: event.summary };
        return { ...r, status: "error", error: event.summary ?? "Worker error" };
      }));
    }

    electron.ipcRenderer.on("command:status", handleCommandStatus);
    return () => {
      electron.ipcRenderer.removeAllListeners("command:status");
      // Clear all pending timers on unmount
      workerTimers.current.forEach(t => clearTimeout(t));
      workerTimers.current.clear();
    };
  }, []);

  // Listen for hotkey overlay signal from main process
  useEffect(() => {
    function handleShowOverlay(data: OverlayPosition) {
      setHotkeyOverlay(data);
      setHotkeyInput("");
      // Focus hotkey input on next tick
      setTimeout(() => hotkeyInputRef.current?.focus(), 50);
    }

    const electron = (window as any).electron;
    if (electron?.ipcRenderer) {
      electron.ipcRenderer.on("claude:showOverlay", (_e: unknown, data: OverlayPosition) => handleShowOverlay(data));
      return () => {
        electron.ipcRenderer.removeAllListeners("claude:showOverlay");
      };
    }
    return () => {};
  }, []);

  async function sendCommand(prompt: string, screenshotPath?: string) {
    if (!prompt.trim() || sending) return;
    setSending(true);

    const context = `Page: ${currentPage}${screenshotPath ? ` | Screenshot: ${screenshotPath}` : ""}`;
    const id = `cmd_${Date.now()}`;

    setResults(prev => [...prev, {
      id,
      prompt: prompt.slice(0, 80) + (prompt.length > 80 ? "…" : ""),
      status: "sending",
      timestamp: Date.now(),
    }]);

    try {
      const result = await (window.api as any).claude?.sendCommand(prompt, context);
      if (result?.success) {
        setResults(prev => prev.map(r => r.id === id
          ? { ...r, status: "queued", commandId: result.commandId }
          : r
        ));
        // If worker hasn't picked it up within 10 seconds, show a warning
        const timer = setTimeout(() => {
          setResults(prev => prev.map(r =>
            r.id === id && r.status === "queued" ? { ...r, status: "worker-timeout" } : r
          ));
          workerTimers.current.delete(id);
        }, 10_000);
        workerTimers.current.set(id, timer);
      } else {
        setResults(prev => prev.map(r => r.id === id
          ? { ...r, status: "error", error: result?.error ?? "Failed to queue" }
          : r
        ));
      }
    } catch (err: any) {
      setResults(prev => prev.map(r => r.id === id
        ? { ...r, status: "error", error: err.message }
        : r
      ));
    } finally {
      setSending(false);
    }
  }

  async function handlePanelSend() {
    if (!input.trim()) return;
    const prompt = input.trim();
    setInput("");
    await sendCommand(prompt);
  }

  async function handleHotkeySend() {
    if (!hotkeyInput.trim()) return;
    const prompt = hotkeyInput.trim();
    const screenshotPath = hotkeyOverlay?.screenshotPath;
    setHotkeyOverlay(null);
    setHotkeyInput("");
    setPanelOpen(true); // Open panel to show result
    await sendCommand(prompt, screenshotPath);
  }

  function onPanelKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handlePanelSend();
    }
  }

  return (
    <>
      {/* Floating action button — always visible, bottom-right */}
      <button
        onClick={() => setPanelOpen(v => !v)}
        title="Claude Code (Ctrl+Shift+Space)"
        style={{
          position: "fixed",
          bottom: 24,
          right: 24,
          width: 48,
          height: 48,
          borderRadius: "50%",
          background: panelOpen ? "#5b21b6" : "#7c3aed",
          border: "2px solid rgba(255,255,255,0.12)",
          color: "#fff",
          fontSize: 20,
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 9998,
          boxShadow: "0 4px 24px rgba(124,58,237,0.45)",
          transition: "background 0.15s, transform 0.1s",
          transform: panelOpen ? "scale(0.92)" : "scale(1)",
        }}
        onMouseEnter={e => { if (!panelOpen) (e.currentTarget as HTMLButtonElement).style.background = "#6d28d9"; }}
        onMouseLeave={e => { if (!panelOpen) (e.currentTarget as HTMLButtonElement).style.background = "#7c3aed"; }}
      >
        🧠
      </button>

      {/* Chat panel — slides up from button */}
      {panelOpen && (
        <div
          style={{
            position: "fixed",
            bottom: 84,
            right: 24,
            width: 360,
            maxHeight: 480,
            background: "#111",
            border: "1px solid #2a2060",
            borderRadius: 12,
            boxShadow: "0 8px 40px rgba(0,0,0,0.6)",
            zIndex: 9997,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
          {/* Header */}
          <div style={{
            padding: "10px 14px",
            borderBottom: "1px solid #1e1e1e",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            background: "#0d0d0d",
          }}>
            <div>
              <span style={{ fontSize: 13, fontWeight: 700, color: "#a78bfa" }}>Claude Code</span>
              <span style={{ fontSize: 11, color: "#444", marginLeft: 8 }}>{currentPage}</span>
            </div>
            <button
              onClick={() => setPanelOpen(false)}
              style={{ background: "none", border: "none", color: "#444", cursor: "pointer", fontSize: 16, lineHeight: 1, padding: "0 2px" }}
            >
              ×
            </button>
          </div>

          {/* Results */}
          <div style={{ flex: 1, overflowY: "auto", padding: "8px 0" }}>
            {results.length === 0 ? (
              <div style={{ padding: "16px 14px", fontSize: 12, color: "#444", lineHeight: 1.6 }}>
                Send commands to Claude Code from here.<br />
                <span style={{ color: "#333" }}>Ctrl+Shift+Space to annotate anything on screen.</span>
              </div>
            ) : (
              results.slice(-10).reverse().map(r => (
                <div key={r.id} style={{
                  padding: "8px 14px",
                  borderBottom: "1px solid #1a1a1a",
                  fontSize: 12,
                }}>
                  <div style={{ color: "#ccc", marginBottom: 3 }}>{r.prompt}</div>
                  {r.status === "sending" && <div style={{ color: "#7c3aed" }}>Sending…</div>}
                  {r.status === "queued" && (
                    <div style={{ color: "#888" }}>Queued — waiting for worker…</div>
                  )}
                  {r.status === "worker-timeout" && (
                    <div style={{ color: "#f59e0b" }}>Worker not responding — check Telegram for result</div>
                  )}
                  {r.status === "processing" && (
                    <div style={{ color: "#60a5fa" }}>Processing…</div>
                  )}
                  {r.status === "done" && (
                    <div style={{ color: "#6dbf6d" }}>
                      Done{r.result ? `: ${r.result.slice(0, 140)}${r.result.length > 140 ? "…" : ""}` : ""}
                    </div>
                  )}
                  {r.status === "error" && (
                    <div style={{ color: "#e07070" }}>Error: {r.error}</div>
                  )}
                </div>
              ))
            )}
          </div>

          {/* Input */}
          <div style={{ padding: 10, borderTop: "1px solid #1e1e1e", background: "#0d0d0d" }}>
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={onPanelKeyDown}
              placeholder="Ask Claude Code anything… (Enter to send)"
              disabled={sending}
              rows={2}
              style={{
                width: "100%",
                padding: "8px 10px",
                background: "#1a1a1a",
                border: "1px solid #2a2a2a",
                borderRadius: 6,
                color: "#e0e0e0",
                fontSize: 12,
                outline: "none",
                fontFamily: "inherit",
                resize: "none",
                boxSizing: "border-box",
              }}
            />
            <button
              onClick={handlePanelSend}
              disabled={!input.trim() || sending}
              style={{
                marginTop: 6,
                width: "100%",
                padding: "6px 0",
                background: input.trim() && !sending ? "#7c3aed" : "#1a1a1a",
                border: "none",
                borderRadius: 6,
                color: input.trim() && !sending ? "#fff" : "#333",
                cursor: input.trim() && !sending ? "pointer" : "default",
                fontSize: 12,
                fontWeight: 600,
              }}
            >
              {sending ? "Sending…" : "Send to Claude Code"}
            </button>
          </div>
        </div>
      )}

      {/* Hotkey overlay — appears at cursor position */}
      {hotkeyOverlay && (
        <div
          style={{
            position: "fixed",
            left: Math.min(hotkeyOverlay.x, window.innerWidth - 420),
            top: Math.min(hotkeyOverlay.y, window.innerHeight - 120),
            width: 400,
            background: "#111",
            border: "2px solid #5b21b6",
            borderRadius: 10,
            padding: 12,
            boxShadow: "0 8px 32px rgba(91,33,182,0.5)",
            zIndex: 9999,
          }}
        >
          <div style={{ fontSize: 11, color: "#7c3aed", marginBottom: 8, fontWeight: 700 }}>
            🧠 Claude Code — {hotkeyOverlay.screenshotPath ? "Screenshot captured" : "No screenshot"} · {currentPage}
          </div>
          <input
            ref={hotkeyInputRef}
            type="text"
            value={hotkeyInput}
            onChange={e => setHotkeyInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter") handleHotkeySend();
              if (e.key === "Escape") { setHotkeyOverlay(null); setHotkeyInput(""); }
            }}
            placeholder='Describe the issue or instruction… (Enter to send, Esc to cancel)'
            style={{
              width: "100%",
              padding: "8px 10px",
              background: "#1a1a1a",
              border: "1px solid #3d2a7a",
              borderRadius: 6,
              color: "#e0e0e0",
              fontSize: 13,
              outline: "none",
              fontFamily: "inherit",
              boxSizing: "border-box",
            }}
          />
          <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
            <button
              onClick={handleHotkeySend}
              disabled={!hotkeyInput.trim()}
              style={{
                flex: 1,
                padding: "6px 0",
                background: hotkeyInput.trim() ? "#5b21b6" : "#1a1a1a",
                border: "none",
                borderRadius: 6,
                color: hotkeyInput.trim() ? "#fff" : "#333",
                cursor: hotkeyInput.trim() ? "pointer" : "default",
                fontSize: 12,
                fontWeight: 600,
              }}
            >
              Send
            </button>
            <button
              onClick={() => { setHotkeyOverlay(null); setHotkeyInput(""); }}
              style={{
                padding: "6px 12px",
                background: "transparent",
                border: "1px solid #333",
                borderRadius: 6,
                color: "#666",
                cursor: "pointer",
                fontSize: 12,
              }}
            >
              Esc
            </button>
          </div>
        </div>
      )}
    </>
  );
}
