import React, { useState, useEffect } from "react";

// ── Types ────────────────────────────────────────────────────────────────────

type BackupTier = "daily" | "tri-daily" | "weekly" | "monthly" | "quarterly" | "yearly" | "pre-restore";

interface SnapshotMeta {
  id: string;
  timestamp: string;
  tier: BackupTier;
  fileCount: number;
  dataBytes: number;
  durationMs: number;
  note?: string;
}

interface FileEntry {
  name: string;
  isDir: boolean;
  size: number;
}

// ── Constants ────────────────────────────────────────────────────────────────

const TIER_COLORS: Record<BackupTier, string> = {
  daily: "#60a5fa",
  "tri-daily": "#a78bfa",
  weekly: "#34d399",
  monthly: "#fbbf24",
  quarterly: "#f97316",
  yearly: "#f43f5e",
  "pre-restore": "#94a3b8",
};

const TIER_LABELS: Record<BackupTier, string> = {
  daily: "Daily",
  "tri-daily": "Tri-Daily",
  weekly: "Weekly",
  monthly: "Monthly",
  quarterly: "Quarterly",
  yearly: "Yearly",
  "pre-restore": "Pre-Restore",
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit",
  });
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

// ── Component ────────────────────────────────────────────────────────────────

export default function Backups() {
  const [snapshots, setSnapshots] = useState<SnapshotMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null); // action name or null
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [tierFilter, setTierFilter] = useState<BackupTier | "all">("all");

  // Inspector state
  const [inspecting, setInspecting] = useState<string | null>(null);
  const [inspectPath, setInspectPath] = useState<string[]>([]);
  const [inspectFiles, setInspectFiles] = useState<FileEntry[]>([]);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileContentName, setFileContentName] = useState<string | null>(null);

  // SQL query state
  const [querySnapshotId, setQuerySnapshotId] = useState<string | null>(null);
  const [sqlQuery, setSqlQuery] = useState("SELECT name FROM sqlite_master WHERE type='table'");
  const [queryResult, setQueryResult] = useState<unknown[] | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);

  useEffect(() => { refresh(); }, []);

  async function refresh() {
    setLoading(true);
    try {
      const list = await window.api.backups.list();
      setSnapshots(list);
    } catch { /* ignore */ }
    setLoading(false);
  }

  function flash(msg: string) {
    setStatusMsg(msg);
    setTimeout(() => setStatusMsg(null), 4000);
  }

  async function handleCreate() {
    setBusy("Creating snapshot...");
    try {
      const res = await window.api.backups.create();
      if (res.success) {
        flash(`Snapshot created: ${res.snapshot.id} (${formatBytes(res.snapshot.dataBytes)})`);
        await refresh();
      } else {
        flash(`Error: ${res.error}`);
      }
    } catch (e: any) { flash(`Error: ${e.message}`); }
    setBusy(null);
  }

  async function handleRunDaily() {
    setBusy("Running daily backup...");
    try {
      const res = await window.api.backups.runDaily();
      if (res.success) {
        const pruneMsg = res.pruned?.length ? `, pruned ${res.pruned.length}` : "";
        flash(`Daily backup complete: ${res.snapshot.id}${pruneMsg}`);
        await refresh();
      } else {
        flash(`Error: ${res.error}`);
      }
    } catch (e: any) { flash(`Error: ${e.message}`); }
    setBusy(null);
  }

  async function handlePrune() {
    setBusy("Pruning...");
    try {
      const res = await window.api.backups.prune();
      if (res.success) {
        flash(`Pruned ${res.deleted.length} snapshot(s)`);
        await refresh();
      } else {
        flash(`Error: ${res.error}`);
      }
    } catch (e: any) { flash(`Error: ${e.message}`); }
    setBusy(null);
  }

  async function handleTestRestore(id: string) {
    setBusy(`Test-restoring ${id}...`);
    try {
      const res = await window.api.backups.testRestore(id);
      if (res.success) {
        flash(`Test restore extracted to: ${res.tempPath}`);
      } else {
        flash(`Error: ${res.error}`);
      }
    } catch (e: any) { flash(`Error: ${e.message}`); }
    setBusy(null);
  }

  async function handleCommitRestore(id: string) {
    if (!confirm(`Restore to snapshot ${id}?\n\nA safety snapshot of current state will be created first. You can roll forward to undo.`)) return;
    setBusy(`Restoring to ${id}...`);
    try {
      const res = await window.api.backups.commitRestore(id);
      if (res.success) {
        flash(`Restored to ${id}. Pre-restore safety copy: ${res.preRestoreId}. Restart app to load new data.`);
        await refresh();
      } else {
        flash(`Error: ${res.error}`);
      }
    } catch (e: any) { flash(`Error: ${e.message}`); }
    setBusy(null);
  }

  async function handleRollForward() {
    if (!confirm("Roll forward to the state before the last restore?")) return;
    setBusy("Rolling forward...");
    try {
      const res = await window.api.backups.rollForward();
      if (res.success) {
        flash(`Rolled forward from: ${res.restoredFromId}. Restart app to load.`);
        await refresh();
      } else {
        flash(`Error: ${res.error}`);
      }
    } catch (e: any) { flash(`Error: ${e.message}`); }
    setBusy(null);
  }

  // ── Inspector ──────────────────────────────────────────────────────────────

  async function openInspector(id: string) {
    setInspecting(id);
    setInspectPath([]);
    setFileContent(null);
    setFileContentName(null);
    await loadDir(id, "");
  }

  async function loadDir(id: string, subPath: string) {
    const res = await window.api.backups.inspect(id, subPath || undefined);
    if (res.success && res.files) {
      setInspectFiles(res.files.sort((a: FileEntry, b: FileEntry) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      }));
    }
  }

  async function navigateDir(name: string) {
    if (!inspecting) return;
    const newPath = [...inspectPath, name];
    setInspectPath(newPath);
    setFileContent(null);
    setFileContentName(null);
    await loadDir(inspecting, newPath.join("/"));
  }

  async function navigateUp() {
    if (!inspecting || inspectPath.length === 0) return;
    const newPath = inspectPath.slice(0, -1);
    setInspectPath(newPath);
    setFileContent(null);
    setFileContentName(null);
    await loadDir(inspecting, newPath.join("/"));
  }

  async function openFile(name: string) {
    if (!inspecting) return;
    const relPath = [...inspectPath, name].join("/");
    const res = await window.api.backups.readFile(inspecting, relPath);
    if (res.success) {
      setFileContent(res.content ?? "(empty)");
      setFileContentName(name);
    }
  }

  // ── SQL query ──────────────────────────────────────────────────────────────

  async function runQuery() {
    if (!querySnapshotId) return;
    setQueryError(null);
    setQueryResult(null);
    try {
      const res = await window.api.backups.queryDb(querySnapshotId, sqlQuery);
      if (res.success) {
        setQueryResult(res.rows);
      } else {
        setQueryError(res.error);
      }
    } catch (e: any) { setQueryError(e.message); }
  }

  // ── Filter ─────────────────────────────────────────────────────────────────

  const filtered = tierFilter === "all" ? snapshots : snapshots.filter(s => s.tier === tierFilter);

  // ── Tier summary ───────────────────────────────────────────────────────────

  const tierCounts = snapshots.reduce<Record<string, number>>((acc, s) => {
    acc[s.tier] = (acc[s.tier] || 0) + 1;
    return acc;
  }, {});

  const totalBytes = snapshots.reduce((sum, s) => sum + s.dataBytes, 0);

  // ── Render ─────────────────────────────────────────────────────────────────

  const btnStyle = (variant: "primary" | "danger" | "ghost" = "ghost"): React.CSSProperties => ({
    padding: "6px 14px",
    background: variant === "primary" ? "#7c3aed" : variant === "danger" ? "#991b1b" : "transparent",
    color: variant === "primary" ? "#fff" : variant === "danger" ? "#fca5a5" : "#999",
    border: variant === "ghost" ? "1px solid #333" : "none",
    borderRadius: 6,
    cursor: busy ? "not-allowed" : "pointer",
    fontSize: 12,
    fontWeight: 500,
    opacity: busy ? 0.5 : 1,
  });

  return (
    <div style={{ padding: 24, height: "100%", overflowY: "auto", color: "#e0e0e0" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 20 }}>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>Backups</h1>
        <button style={btnStyle("primary")} onClick={handleCreate} disabled={!!busy}>
          Create Snapshot
        </button>
        <button style={btnStyle()} onClick={handleRunDaily} disabled={!!busy}>
          Run Daily Backup
        </button>
        <button style={btnStyle()} onClick={handlePrune} disabled={!!busy}>
          Prune
        </button>
        <button style={btnStyle()} onClick={handleRollForward} disabled={!!busy}>
          Roll Forward
        </button>
      </div>

      {/* Status */}
      {busy && <div style={{ padding: "8px 12px", background: "#1a1a2e", borderRadius: 6, marginBottom: 12, fontSize: 13, color: "#a78bfa" }}>{busy}</div>}
      {statusMsg && <div style={{ padding: "8px 12px", background: "#1a2e1a", borderRadius: 6, marginBottom: 12, fontSize: 13, color: "#4ade80" }}>{statusMsg}</div>}

      {/* Summary */}
      <div style={{ display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
        <div style={statCard}>
          <div style={{ fontSize: 20, fontWeight: 700 }}>{snapshots.length}</div>
          <div style={{ fontSize: 11, color: "#666" }}>Total snapshots</div>
        </div>
        <div style={statCard}>
          <div style={{ fontSize: 20, fontWeight: 700 }}>{formatBytes(totalBytes)}</div>
          <div style={{ fontSize: 11, color: "#666" }}>Total size</div>
        </div>
        {Object.entries(tierCounts).map(([tier, count]) => (
          <div key={tier} style={{ ...statCard, borderTop: `2px solid ${TIER_COLORS[tier as BackupTier] || "#444"}` }}>
            <div style={{ fontSize: 20, fontWeight: 700 }}>{count}</div>
            <div style={{ fontSize: 11, color: "#666" }}>{TIER_LABELS[tier as BackupTier] || tier}</div>
          </div>
        ))}
      </div>

      {/* Tier filter */}
      <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
        {["all", "daily", "tri-daily", "weekly", "monthly", "quarterly", "yearly", "pre-restore"].map(t => (
          <button
            key={t}
            onClick={() => setTierFilter(t as any)}
            style={{
              padding: "4px 10px", borderRadius: 4, border: "none", cursor: "pointer",
              background: tierFilter === t ? "#7c3aed" : "#1e1e1e",
              color: tierFilter === t ? "#fff" : "#888", fontSize: 11,
            }}
          >
            {t === "all" ? "All" : TIER_LABELS[t as BackupTier]}
          </button>
        ))}
      </div>

      {/* Snapshot list */}
      {loading ? (
        <div style={{ color: "#666", padding: 20 }}>Loading...</div>
      ) : filtered.length === 0 ? (
        <div style={{ color: "#666", padding: 20 }}>No snapshots. Click "Create Snapshot" or "Run Daily Backup" to start.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {filtered.map(s => (
            <div key={s.id} style={rowStyle}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1 }}>
                <span style={{
                  padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 600,
                  background: `${TIER_COLORS[s.tier]}22`, color: TIER_COLORS[s.tier],
                }}>
                  {TIER_LABELS[s.tier]}
                </span>
                <span style={{ fontSize: 13, fontWeight: 500, fontFamily: "monospace" }}>{s.id}</span>
                <span style={{ fontSize: 12, color: "#666" }}>{formatTimestamp(s.timestamp)}</span>
                <span style={{ fontSize: 11, color: "#555" }}>{timeAgo(s.timestamp)}</span>
                {s.note && <span style={{ fontSize: 11, color: "#94a3b8", fontStyle: "italic" }}>{s.note}</span>}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 11, color: "#666" }}>{s.fileCount} files</span>
                <span style={{ fontSize: 11, color: "#666" }}>{formatBytes(s.dataBytes)}</span>
                <button style={smallBtn} onClick={() => openInspector(s.id)} title="Browse files">Browse</button>
                <button style={smallBtn} onClick={() => { setQuerySnapshotId(s.id); setQueryResult(null); setQueryError(null); }} title="Query SQLite">SQL</button>
                <button style={smallBtn} onClick={() => handleTestRestore(s.id)} disabled={!!busy} title="Extract to temp dir">Test</button>
                <button style={{ ...smallBtn, color: "#f97316" }} onClick={() => handleCommitRestore(s.id)} disabled={!!busy} title="Restore (creates safety snapshot first)">Restore</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── File Inspector Modal ────────────────────────────────────────────── */}
      {inspecting && (
        <div style={overlayStyle}>
          <div style={modalStyle}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <h2 style={{ margin: 0, fontSize: 16 }}>
                Browse: {inspecting}
                {inspectPath.length > 0 && <span style={{ color: "#666", fontWeight: 400 }}> / {inspectPath.join(" / ")}</span>}
              </h2>
              <button style={smallBtn} onClick={() => { setInspecting(null); setFileContent(null); }}>Close</button>
            </div>

            {inspectPath.length > 0 && (
              <button style={{ ...smallBtn, marginBottom: 8 }} onClick={navigateUp}>&larr; Up</button>
            )}

            {fileContent !== null ? (
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{fileContentName}</span>
                  <button style={smallBtn} onClick={() => { setFileContent(null); setFileContentName(null); }}>Back to list</button>
                </div>
                <pre style={{
                  background: "#0a0a0a", padding: 12, borderRadius: 6, fontSize: 11,
                  maxHeight: 400, overflow: "auto", whiteSpace: "pre-wrap", color: "#ccc",
                  border: "1px solid #222",
                }}>
                  {fileContent.length > 50000 ? fileContent.slice(0, 50000) + "\n\n... (truncated)" : fileContent}
                </pre>
              </div>
            ) : (
              <div style={{ maxHeight: 400, overflowY: "auto" }}>
                {inspectFiles.map(f => (
                  <div
                    key={f.name}
                    onClick={() => f.isDir ? navigateDir(f.name) : openFile(f.name)}
                    style={{
                      padding: "6px 10px", display: "flex", justifyContent: "space-between", cursor: "pointer",
                      borderBottom: "1px solid #1a1a1a", fontSize: 12,
                    }}
                    onMouseEnter={e => (e.currentTarget.style.background = "#1a1a2e")}
                    onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                  >
                    <span>{f.isDir ? "📁 " : "📄 "}{f.name}</span>
                    <span style={{ color: "#666" }}>{f.isDir ? "" : formatBytes(f.size)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── SQL Query Modal ─────────────────────────────────────────────────── */}
      {querySnapshotId && (
        <div style={overlayStyle}>
          <div style={{ ...modalStyle, maxWidth: 800 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <h2 style={{ margin: 0, fontSize: 16 }}>Query: {querySnapshotId}</h2>
              <button style={smallBtn} onClick={() => { setQuerySnapshotId(null); setQueryResult(null); setQueryError(null); }}>Close</button>
            </div>

            <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
              <input
                style={{
                  flex: 1, background: "#0a0a0a", border: "1px solid #333", borderRadius: 6,
                  padding: "8px 12px", color: "#e0e0e0", fontSize: 12, fontFamily: "monospace",
                }}
                value={sqlQuery}
                onChange={e => setSqlQuery(e.target.value)}
                onKeyDown={e => e.key === "Enter" && runQuery()}
                placeholder="SELECT * FROM ..."
              />
              <button style={btnStyle("primary")} onClick={runQuery}>Run</button>
            </div>

            {queryError && <div style={{ color: "#f87171", fontSize: 12, marginBottom: 8 }}>{queryError}</div>}

            {queryResult && (
              <div style={{ maxHeight: 400, overflow: "auto" }}>
                {queryResult.length === 0 ? (
                  <div style={{ color: "#666", fontSize: 12 }}>No rows returned.</div>
                ) : (
                  <table style={{ width: "100%", fontSize: 11, borderCollapse: "collapse" }}>
                    <thead>
                      <tr>
                        {Object.keys(queryResult[0] as Record<string, unknown>).map(col => (
                          <th key={col} style={{ padding: "6px 8px", borderBottom: "1px solid #333", textAlign: "left", color: "#888" }}>{col}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {queryResult.map((row, i) => (
                        <tr key={i}>
                          {Object.values(row as Record<string, unknown>).map((val, j) => (
                            <td key={j} style={{ padding: "4px 8px", borderBottom: "1px solid #1a1a1a", color: "#ccc", fontFamily: "monospace" }}>
                              {val === null ? <span style={{ color: "#555" }}>NULL</span> : String(val)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────

const statCard: React.CSSProperties = {
  background: "#151515",
  borderRadius: 8,
  padding: "12px 16px",
  minWidth: 80,
};

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  padding: "8px 12px",
  background: "#111",
  borderRadius: 4,
  gap: 8,
};

const smallBtn: React.CSSProperties = {
  padding: "3px 8px",
  background: "#1e1e1e",
  border: "1px solid #333",
  borderRadius: 4,
  color: "#999",
  fontSize: 11,
  cursor: "pointer",
};

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.7)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 100,
};

const modalStyle: React.CSSProperties = {
  background: "#111",
  borderRadius: 12,
  padding: 24,
  maxWidth: 700,
  width: "90%",
  maxHeight: "80vh",
  overflow: "hidden",
  display: "flex",
  flexDirection: "column",
  border: "1px solid #222",
};
