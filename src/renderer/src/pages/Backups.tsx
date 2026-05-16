import React, { useState, useEffect } from "react";

type BackupTier = "daily" | "tri-daily" | "weekly" | "monthly" | "quarterly" | "yearly" | "pre-restore";
type IntegrityStatus = "ok" | "warning" | "failed";
type S3Availability = "available" | "unavailable" | "not_configured";
type S3ArchiveStatus = "synced" | "missing" | "unknown";
type SecuritySensitivity = "none_detected" | "sensitive" | "encrypted_sensitive";
type OffsiteEncryptionStatus = "encrypted" | "unknown" | "not_configured" | "unavailable";

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

interface BackupIntegrityReport {
  id: string;
  status: IntegrityStatus;
  checks: Record<string, boolean>;
  fileCount: number;
  dataBytes: number;
  expectedFileCount: number;
  expectedDataBytes: number;
  warnings: string[];
  errors: string[];
}

interface TestRestorePreview {
  tempPath: string;
  fileCount: number;
  dataBytes: number;
  hasConfig: boolean;
  hasDatabase: boolean;
  warnings: string[];
}

interface BackupS3StatusReport {
  availability: S3Availability;
  bucket?: string;
  prefix: string;
  snapshots: { id: string; archiveKey: string; status: S3ArchiveStatus }[];
  summary: {
    localSnapshots: number;
    s3Archives: number;
    missingFromS3: number;
    s3Unreachable: boolean;
  };
  error?: string;
}

interface BackupSecurityReport {
  id: string;
  hasConfig: boolean;
  hasEncryptedPiiVault: boolean;
  sensitivePaths: string[];
  sensitivity: SecuritySensitivity;
  localProtection: "local_filesystem";
  offsiteEncryption: OffsiteEncryptionStatus;
  warnings: string[];
}

interface RestoreWizardState {
  snapshot: SnapshotMeta;
  step: 1 | 2 | 3 | 4;
  integrity?: BackupIntegrityReport;
  preview?: TestRestorePreview;
  security?: BackupSecurityReport;
  error?: string;
}

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

const HEALTH_LABELS: Record<IntegrityStatus, string> = {
  ok: "Health OK",
  warning: "Health Warning",
  failed: "Health Failed",
};

const S3_LABELS: Record<S3ArchiveStatus, string> = {
  synced: "S3 Synced",
  missing: "S3 Missing",
  unknown: "S3 Unknown",
};

const SECURITY_LABELS: Record<SecuritySensitivity, string> = {
  none_detected: "No Sensitive Paths",
  sensitive: "Sensitive",
  encrypted_sensitive: "Encrypted PII",
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
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

function badgeColors(kind: "ok" | "warning" | "failed" | "neutral") {
  if (kind === "ok") return { background: "#052e1a", color: "#4ade80", borderColor: "#14532d" };
  if (kind === "warning") return { background: "#2b2106", color: "#fbbf24", borderColor: "#713f12" };
  if (kind === "failed") return { background: "#2a0b0b", color: "#f87171", borderColor: "#7f1d1d" };
  return { background: "#1e1e1e", color: "#999", borderColor: "#333" };
}

function healthKind(status?: IntegrityStatus): "ok" | "warning" | "failed" | "neutral" {
  if (!status) return "neutral";
  return status === "ok" ? "ok" : status === "warning" ? "warning" : "failed";
}

function s3Kind(status?: S3ArchiveStatus): "ok" | "warning" | "failed" | "neutral" {
  if (status === "synced") return "ok";
  if (status === "missing") return "warning";
  return "neutral";
}

function securityKind(report?: BackupSecurityReport): "ok" | "warning" | "failed" | "neutral" {
  if (!report) return "neutral";
  if (report.sensitivity === "none_detected" || report.sensitivity === "encrypted_sensitive") return "ok";
  return "warning";
}

function StatusBadge({ label, kind }: { label: string; kind: "ok" | "warning" | "failed" | "neutral" }) {
  const colors = badgeColors(kind);
  return (
    <span style={{ ...badgeStyle, ...colors }}>
      {label}
    </span>
  );
}

export default function Backups() {
  const [snapshots, setSnapshots] = useState<SnapshotMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [tierFilter, setTierFilter] = useState<BackupTier | "all">("all");
  const [integrityReports, setIntegrityReports] = useState<Record<string, BackupIntegrityReport>>({});
  const [securityReports, setSecurityReports] = useState<Record<string, BackupSecurityReport>>({});
  const [s3Status, setS3Status] = useState<BackupS3StatusReport | null>(null);
  const [wizard, setWizard] = useState<RestoreWizardState | null>(null);

  const [inspecting, setInspecting] = useState<string | null>(null);
  const [inspectPath, setInspectPath] = useState<string[]>([]);
  const [inspectFiles, setInspectFiles] = useState<FileEntry[]>([]);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileContentName, setFileContentName] = useState<string | null>(null);

  const [querySnapshotId, setQuerySnapshotId] = useState<string | null>(null);
  const [sqlQuery, setSqlQuery] = useState("SELECT name FROM sqlite_master WHERE type='table'");
  const [queryResult, setQueryResult] = useState<unknown[] | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);

  useEffect(() => {
    refresh();
  }, []);

  async function refresh() {
    setLoading(true);
    try {
      const list = await window.api.backups.list();
      setSnapshots(list);
      await refreshReports(list);
    } catch {
      /* ignore */
    }
    setLoading(false);
  }

  async function refreshReports(list: SnapshotMeta[]) {
    const [s3Result, integrityResults, securityResults] = await Promise.all([
      window.api.backups.s3Status(),
      Promise.all(list.map((snapshot) => window.api.backups.verify(snapshot.id))),
      Promise.all(list.map((snapshot) => window.api.backups.security(snapshot.id))),
    ]);
    if (s3Result.success) setS3Status(s3Result.report);
    setIntegrityReports(
      Object.fromEntries(
        integrityResults
          .filter((result) => result.success)
          .map((result) => [result.report.id, result.report]),
      ),
    );
    setSecurityReports(
      Object.fromEntries(
        securityResults
          .filter((result) => result.success)
          .map((result) => [result.report.id, result.report]),
      ),
    );
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
    } catch (e: any) {
      flash(`Error: ${e.message}`);
    }
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
    } catch (e: any) {
      flash(`Error: ${e.message}`);
    }
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
    } catch (e: any) {
      flash(`Error: ${e.message}`);
    }
    setBusy(null);
  }

  async function openRestoreWizard(snapshot: SnapshotMeta) {
    const current: RestoreWizardState = { snapshot, step: 1 };
    setWizard(current);
    setBusy(`Checking ${snapshot.id}...`);
    try {
      const [integrityResult, securityResult] = await Promise.all([
        window.api.backups.verify(snapshot.id),
        window.api.backups.security(snapshot.id),
      ]);
      setWizard({
        ...current,
        integrity: integrityResult.success ? integrityResult.report : undefined,
        security: securityResult.success ? securityResult.report : undefined,
        error: integrityResult.success ? undefined : integrityResult.error,
      });
    } catch (e: any) {
      setWizard({ ...current, error: e.message });
    }
    setBusy(null);
  }

  async function runWizardDryRun() {
    if (!wizard) return;
    setBusy(`Test-restoring ${wizard.snapshot.id}...`);
    try {
      const res = await window.api.backups.testRestore(wizard.snapshot.id);
      if (res.success) {
        setWizard({ ...wizard, step: 3, preview: res, error: undefined });
      } else {
        setWizard({ ...wizard, step: 3, error: res.error });
      }
    } catch (e: any) {
      setWizard({ ...wizard, step: 3, error: e.message });
    }
    setBusy(null);
  }

  async function commitWizardRestore() {
    if (!wizard || !canCommitWizard(wizard)) return;
    setBusy(`Restoring to ${wizard.snapshot.id}...`);
    try {
      const res = await window.api.backups.commitRestore(wizard.snapshot.id);
      if (res.success) {
        flash(`Restored to ${wizard.snapshot.id}. Pre-restore safety copy: ${res.preRestoreId}. Restart app to load new data.`);
        setWizard(null);
        await refresh();
      } else {
        setWizard({ ...wizard, error: res.error });
      }
    } catch (e: any) {
      setWizard({ ...wizard, error: e.message });
    }
    setBusy(null);
  }

  function canCommitWizard(state: RestoreWizardState): boolean {
    return state.integrity?.status !== "failed" && !!state.preview && !state.error;
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
    } catch (e: any) {
      flash(`Error: ${e.message}`);
    }
    setBusy(null);
  }

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
    } catch (e: any) {
      setQueryError(e.message);
    }
  }

  const filtered = tierFilter === "all" ? snapshots : snapshots.filter((snapshot) => snapshot.tier === tierFilter);
  const tierCounts = snapshots.reduce<Record<string, number>>((acc, snapshot) => {
    acc[snapshot.tier] = (acc[snapshot.tier] || 0) + 1;
    return acc;
  }, {});
  const totalBytes = snapshots.reduce((sum, snapshot) => sum + snapshot.dataBytes, 0);
  const s3ById = Object.fromEntries((s3Status?.snapshots ?? []).map((snapshot) => [snapshot.id, snapshot]));
  const securityWarnings = Object.values(securityReports).reduce((count, report) => count + (report.warnings.length > 0 ? 1 : 0), 0);

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
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 20 }}>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>Backups</h1>
        <button style={btnStyle("primary")} onClick={handleCreate} disabled={!!busy}>Create Snapshot</button>
        <button style={btnStyle()} onClick={handleRunDaily} disabled={!!busy}>Run Daily Backup</button>
        <button style={btnStyle()} onClick={handlePrune} disabled={!!busy}>Prune</button>
        <button style={btnStyle()} onClick={handleRollForward} disabled={!!busy}>Roll Forward</button>
      </div>

      {busy && <div style={bannerStyle("#1a1a2e", "#a78bfa")}>{busy}</div>}
      {statusMsg && <div style={bannerStyle("#1a2e1a", "#4ade80")}>{statusMsg}</div>}

      <div style={{ display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
        <div style={statCard}>
          <div style={statValue}>{snapshots.length}</div>
          <div style={statLabel}>Local snapshots</div>
        </div>
        <div style={statCard}>
          <div style={statValue}>{formatBytes(totalBytes)}</div>
          <div style={statLabel}>Total size</div>
        </div>
        <div style={statCard}>
          <div style={statValue}>{s3Status?.summary.s3Archives ?? 0}</div>
          <div style={statLabel}>S3 archives</div>
        </div>
        <div style={statCard}>
          <div style={statValue}>{s3Status?.summary.missingFromS3 ?? 0}</div>
          <div style={statLabel}>Missing from S3</div>
        </div>
        <div style={statCard}>
          <div style={statValue}>{s3Status?.availability === "unavailable" ? "Yes" : "No"}</div>
          <div style={statLabel}>S3 unreachable</div>
        </div>
        <div style={statCard}>
          <div style={statValue}>{securityWarnings}</div>
          <div style={statLabel}>Security warnings</div>
        </div>
        {Object.entries(tierCounts).map(([tier, count]) => (
          <div key={tier} style={{ ...statCard, borderTop: `2px solid ${TIER_COLORS[tier as BackupTier] || "#444"}` }}>
            <div style={statValue}>{count}</div>
            <div style={statLabel}>{TIER_LABELS[tier as BackupTier] || tier}</div>
          </div>
        ))}
      </div>

      <div style={panelStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <strong style={{ fontSize: 13 }}>Offsite/S3</strong>
          <StatusBadge
            label={s3Status?.availability === "available" ? "Available" : s3Status?.availability === "unavailable" ? "Unavailable" : "Not Configured"}
            kind={s3Status?.availability === "available" ? "ok" : s3Status?.availability === "unavailable" ? "failed" : "neutral"}
          />
          <span style={mutedText}>{s3Status?.bucket ? `Bucket: ${s3Status.bucket}` : "SECONDBRAIN_BACKUP_BUCKET is not configured."}</span>
        </div>
      </div>

      <div style={panelStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <strong style={{ fontSize: 13 }}>Security</strong>
          <span style={mutedText}>Reports config inclusion, encrypted PII vault presence, sensitive path categories, and S3 encryption metadata.</span>
        </div>
      </div>

      <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
        {["all", "daily", "tri-daily", "weekly", "monthly", "quarterly", "yearly", "pre-restore"].map((tier) => (
          <button
            key={tier}
            onClick={() => setTierFilter(tier as BackupTier | "all")}
            style={{
              padding: "4px 10px",
              borderRadius: 4,
              border: "none",
              cursor: "pointer",
              background: tierFilter === tier ? "#7c3aed" : "#1e1e1e",
              color: tierFilter === tier ? "#fff" : "#888",
              fontSize: 11,
            }}
          >
            {tier === "all" ? "All" : TIER_LABELS[tier as BackupTier]}
          </button>
        ))}
      </div>

      {loading ? (
        <div style={{ color: "#666", padding: 20 }}>Loading...</div>
      ) : filtered.length === 0 ? (
        <div style={{ color: "#666", padding: 20 }}>No snapshots. Click "Create Snapshot" or "Run Daily Backup" to start.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {filtered.map((snapshot) => {
            const integrity = integrityReports[snapshot.id];
            const security = securityReports[snapshot.id];
            const s3 = s3ById[snapshot.id];
            return (
              <div key={snapshot.id} style={rowStyle}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, flexWrap: "wrap" }}>
                  <span style={{ ...tierBadge, background: `${TIER_COLORS[snapshot.tier]}22`, color: TIER_COLORS[snapshot.tier] }}>
                    {TIER_LABELS[snapshot.tier]}
                  </span>
                  <span style={{ fontSize: 13, fontWeight: 500, fontFamily: "monospace" }}>{snapshot.id}</span>
                  <span style={{ fontSize: 12, color: "#666" }}>{formatTimestamp(snapshot.timestamp)}</span>
                  <span style={{ fontSize: 11, color: "#555" }}>{timeAgo(snapshot.timestamp)}</span>
                  <StatusBadge label={integrity ? HEALTH_LABELS[integrity.status] : "Health Pending"} kind={healthKind(integrity?.status)} />
                  <StatusBadge label={s3 ? S3_LABELS[s3.status] : "S3 Pending"} kind={s3Kind(s3?.status)} />
                  <StatusBadge label={security ? SECURITY_LABELS[security.sensitivity] : "Security Pending"} kind={securityKind(security)} />
                  {snapshot.note && <span style={{ fontSize: 11, color: "#94a3b8", fontStyle: "italic" }}>{snapshot.note}</span>}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 11, color: "#666" }}>{snapshot.fileCount} files</span>
                  <span style={{ fontSize: 11, color: "#666" }}>{formatBytes(snapshot.dataBytes)}</span>
                  <button style={smallBtn} onClick={() => openInspector(snapshot.id)} title="Browse files">Browse</button>
                  <button style={smallBtn} onClick={() => { setQuerySnapshotId(snapshot.id); setQueryResult(null); setQueryError(null); }} title="Query SQLite">SQL</button>
                  <button style={{ ...smallBtn, color: "#f97316" }} onClick={() => openRestoreWizard(snapshot)} disabled={!!busy} title="Open restore wizard">Restore</button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {wizard && (
        <div style={overlayStyle}>
          <div style={{ ...modalStyle, maxWidth: 760 }}>
            <div style={modalHeaderStyle}>
              <h2 style={{ margin: 0, fontSize: 16 }}>Restore Wizard: {wizard.snapshot.id}</h2>
              <button style={smallBtn} onClick={() => setWizard(null)}>Close</button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6, marginBottom: 16 }}>
              {["Summary", "Integrity", "Dry Run", "Commit"].map((label, index) => (
                <button
                  key={label}
                  style={{
                    ...stepBtn,
                    background: wizard.step === index + 1 ? "#7c3aed" : "#1e1e1e",
                    color: wizard.step === index + 1 ? "#fff" : "#999",
                  }}
                  onClick={() => setWizard({ ...wizard, step: (index + 1) as RestoreWizardState["step"] })}
                >
                  {index + 1}. {label}
                </button>
              ))}
            </div>

            {wizard.error && <div style={bannerStyle("#2a0b0b", "#f87171")}>{wizard.error}</div>}

            {wizard.step === 1 && (
              <div style={wizardBodyStyle}>
                <InfoRow label="Tier" value={TIER_LABELS[wizard.snapshot.tier]} />
                <InfoRow label="Created" value={formatTimestamp(wizard.snapshot.timestamp)} />
                <InfoRow label="Size" value={formatBytes(wizard.snapshot.dataBytes)} />
                <InfoRow label="Files" value={`${wizard.snapshot.fileCount}`} />
                <InfoRow label="Note" value={wizard.snapshot.note ?? "None"} />
                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  <button style={btnStyle("primary")} onClick={() => setWizard({ ...wizard, step: 2 })}>Next</button>
                </div>
              </div>
            )}

            {wizard.step === 2 && (
              <div style={wizardBodyStyle}>
                {wizard.integrity ? (
                  <>
                    <StatusBadge label={HEALTH_LABELS[wizard.integrity.status]} kind={healthKind(wizard.integrity.status)} />
                    <div style={gridTwo}>
                      {Object.entries(wizard.integrity.checks).map(([key, value]) => (
                        <InfoRow key={key} label={key} value={value ? "Pass" : "Needs attention"} />
                      ))}
                    </div>
                    <MessageList title="Warnings" messages={wizard.integrity.warnings} />
                    <MessageList title="Errors" messages={wizard.integrity.errors} />
                  </>
                ) : (
                  <div style={mutedText}>Integrity report is loading.</div>
                )}
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <button style={btnStyle()} onClick={() => setWizard({ ...wizard, step: 1 })}>Back</button>
                  <button style={btnStyle("primary")} onClick={runWizardDryRun} disabled={!!busy || wizard.integrity?.status === "failed"}>
                    Run Dry-Run Restore
                  </button>
                </div>
              </div>
            )}

            {wizard.step === 3 && (
              <div style={wizardBodyStyle}>
                {wizard.preview ? (
                  <>
                    <div style={gridTwo}>
                      <InfoRow label="Temp path" value={wizard.preview.tempPath} />
                      <InfoRow label="Files restored" value={`${wizard.preview.fileCount}`} />
                      <InfoRow label="Bytes restored" value={formatBytes(wizard.preview.dataBytes)} />
                      <InfoRow label="Config present" value={wizard.preview.hasConfig ? "Yes" : "No"} />
                      <InfoRow label="Database present" value={wizard.preview.hasDatabase ? "Yes" : "No"} />
                    </div>
                    <MessageList title="Warnings" messages={wizard.preview.warnings} />
                  </>
                ) : (
                  <div style={mutedText}>Run the dry-run restore to preview extracted files before commit.</div>
                )}
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <button style={btnStyle()} onClick={() => setWizard({ ...wizard, step: 2 })}>Back</button>
                  <button style={btnStyle("primary")} onClick={() => setWizard({ ...wizard, step: 4 })} disabled={!wizard.preview}>
                    Continue
                  </button>
                </div>
              </div>
            )}

            {wizard.step === 4 && (
              <div style={wizardBodyStyle}>
                <div style={panelStyle}>
                  <strong style={{ fontSize: 13 }}>Final commit restore confirmation</strong>
                  <div style={{ ...mutedText, marginTop: 6 }}>
                    Commit restore will create a pre-restore safety snapshot before replacing live data.
                  </div>
                </div>
                {wizard.security && (
                  <div style={panelStyle}>
                    <strong style={{ fontSize: 13 }}>Security</strong>
                    <div style={gridTwo}>
                      <InfoRow label="Config included" value={wizard.security.hasConfig ? "Yes" : "No"} />
                      <InfoRow label="Encrypted PII vault" value={wizard.security.hasEncryptedPiiVault ? "Present" : "Missing"} />
                      <InfoRow label="Offsite encryption" value={wizard.security.offsiteEncryption} />
                      <InfoRow label="Sensitive paths" value={wizard.security.sensitivePaths.join(", ") || "None detected"} />
                    </div>
                    <MessageList title="Security warnings" messages={wizard.security.warnings} />
                  </div>
                )}
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <button style={btnStyle()} onClick={() => setWizard({ ...wizard, step: 3 })}>Back</button>
                  <button style={btnStyle("danger")} onClick={commitWizardRestore} disabled={!!busy || !canCommitWizard(wizard)}>
                    Commit Restore
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {inspecting && (
        <div style={overlayStyle}>
          <div style={modalStyle}>
            <div style={modalHeaderStyle}>
              <h2 style={{ margin: 0, fontSize: 16 }}>
                Browse: {inspecting}
                {inspectPath.length > 0 && <span style={{ color: "#666", fontWeight: 400 }}> / {inspectPath.join(" / ")}</span>}
              </h2>
              <button style={smallBtn} onClick={() => { setInspecting(null); setFileContent(null); }}>Close</button>
            </div>

            {inspectPath.length > 0 && (
              <button style={{ ...smallBtn, marginBottom: 8, alignSelf: "flex-start" }} onClick={navigateUp}>Up</button>
            )}

            {fileContent !== null ? (
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{fileContentName}</span>
                  <button style={smallBtn} onClick={() => { setFileContent(null); setFileContentName(null); }}>Back to list</button>
                </div>
                <pre style={preStyle}>
                  {fileContent.length > 50000 ? `${fileContent.slice(0, 50000)}\n\n... (truncated)` : fileContent}
                </pre>
              </div>
            ) : (
              <div style={{ maxHeight: 400, overflowY: "auto" }}>
                {inspectFiles.map((file) => (
                  <div
                    key={file.name}
                    onClick={() => file.isDir ? navigateDir(file.name) : openFile(file.name)}
                    style={fileRowStyle}
                    onMouseEnter={(e) => (e.currentTarget.style.background = "#1a1a2e")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                  >
                    <span>{file.isDir ? "[dir] " : "[file] "}{file.name}</span>
                    <span style={{ color: "#666" }}>{file.isDir ? "" : formatBytes(file.size)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {querySnapshotId && (
        <div style={overlayStyle}>
          <div style={{ ...modalStyle, maxWidth: 800 }}>
            <div style={modalHeaderStyle}>
              <h2 style={{ margin: 0, fontSize: 16 }}>Query: {querySnapshotId}</h2>
              <button style={smallBtn} onClick={() => { setQuerySnapshotId(null); setQueryResult(null); setQueryError(null); }}>Close</button>
            </div>

            <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
              <input
                style={inputStyle}
                value={sqlQuery}
                onChange={(e) => setSqlQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && runQuery()}
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
                        {Object.keys(queryResult[0] as Record<string, unknown>).map((col) => (
                          <th key={col} style={tableHeadStyle}>{col}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {queryResult.map((row, i) => (
                        <tr key={i}>
                          {Object.values(row as Record<string, unknown>).map((val, j) => (
                            <td key={j} style={tableCellStyle}>
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

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 10, color: "#666", textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontSize: 12, color: "#ddd", wordBreak: "break-word" }}>{value}</div>
    </div>
  );
}

function MessageList({ title, messages }: { title: string; messages: string[] }) {
  if (messages.length === 0) return null;
  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>{title}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {messages.map((message) => (
          <div key={message} style={{ fontSize: 12, color: "#cbd5e1", background: "#151515", borderRadius: 6, padding: "6px 8px" }}>
            {message}
          </div>
        ))}
      </div>
    </div>
  );
}

const bannerStyle = (background: string, color: string): React.CSSProperties => ({
  padding: "8px 12px",
  background,
  borderRadius: 6,
  marginBottom: 12,
  fontSize: 13,
  color,
});

const statCard: React.CSSProperties = {
  background: "#151515",
  borderRadius: 8,
  padding: "12px 16px",
  minWidth: 80,
};

const statValue: React.CSSProperties = {
  fontSize: 20,
  fontWeight: 700,
};

const statLabel: React.CSSProperties = {
  fontSize: 11,
  color: "#666",
};

const panelStyle: React.CSSProperties = {
  background: "#111",
  border: "1px solid #222",
  borderRadius: 8,
  padding: "10px 12px",
  marginBottom: 12,
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

const tierBadge: React.CSSProperties = {
  padding: "2px 8px",
  borderRadius: 4,
  fontSize: 10,
  fontWeight: 600,
};

const badgeStyle: React.CSSProperties = {
  padding: "2px 7px",
  borderRadius: 4,
  fontSize: 10,
  fontWeight: 700,
  border: "1px solid",
  whiteSpace: "nowrap",
};

const mutedText: React.CSSProperties = {
  fontSize: 12,
  color: "#777",
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

const modalHeaderStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  marginBottom: 12,
  gap: 12,
};

const stepBtn: React.CSSProperties = {
  padding: "7px 8px",
  borderRadius: 6,
  border: "1px solid #333",
  cursor: "pointer",
  fontSize: 11,
};

const wizardBodyStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 14,
  minHeight: 280,
  overflow: "auto",
};

const gridTwo: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
  gap: 12,
};

const preStyle: React.CSSProperties = {
  background: "#0a0a0a",
  padding: 12,
  borderRadius: 6,
  fontSize: 11,
  maxHeight: 400,
  overflow: "auto",
  whiteSpace: "pre-wrap",
  color: "#ccc",
  border: "1px solid #222",
};

const fileRowStyle: React.CSSProperties = {
  padding: "6px 10px",
  display: "flex",
  justifyContent: "space-between",
  cursor: "pointer",
  borderBottom: "1px solid #1a1a1a",
  fontSize: 12,
};

const inputStyle: React.CSSProperties = {
  flex: 1,
  background: "#0a0a0a",
  border: "1px solid #333",
  borderRadius: 6,
  padding: "8px 12px",
  color: "#e0e0e0",
  fontSize: 12,
  fontFamily: "monospace",
};

const tableHeadStyle: React.CSSProperties = {
  padding: "6px 8px",
  borderBottom: "1px solid #333",
  textAlign: "left",
  color: "#888",
};

const tableCellStyle: React.CSSProperties = {
  padding: "4px 8px",
  borderBottom: "1px solid #1a1a1a",
  color: "#ccc",
  fontFamily: "monospace",
};
