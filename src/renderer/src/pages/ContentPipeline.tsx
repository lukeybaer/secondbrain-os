import React, { useState, useEffect, useRef } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PendingVideo {
  id: string;
  title: string;
  channel: "AILifeHacks" | "BedtimeStories";
  status: "pending_approval" | "approved" | "rejected";
  generated_date: string;
  video_path?: string;
  thumbnail_path?: string;
  rejection_note?: string;
  youtube_url?: string;
  scheduled_upload_at?: string;
  upload_status?: "scheduled" | "uploading" | "posted";
}

// ---------------------------------------------------------------------------
// Demo fallback data
// ---------------------------------------------------------------------------

const DEMO_PENDING: PendingVideo[] = [
  { id: "mit_30_agents", title: "MIT Audited 30 AI Agents. Every Single One Failed.", channel: "AILifeHacks", status: "pending_approval", generated_date: "2026-03-14" },
  { id: "ai_agent_income_formula", title: "She Replaced Her $1,400/Month VA — Income Doubled", channel: "AILifeHacks", status: "pending_approval", generated_date: "2026-03-14" },
  { id: "nine_free_ai_tools_2026", title: "9 Free AI Tools Your Competition Hasn't Found Yet", channel: "AILifeHacks", status: "pending_approval", generated_date: "2026-03-14" },
  { id: "kids_tiny_elephant", title: "The Tiny Elephant Who Never Forgot a Friend", channel: "BedtimeStories", status: "pending_approval", generated_date: "2026-03-14" },
  { id: "kids_little_whale", title: "The Little Whale Who Learned to Sing", channel: "BedtimeStories", status: "pending_approval", generated_date: "2026-03-14" },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Next scheduled upload times: 9am, 1pm, 5pm CT
function nextUploadTime(): Date {
  const now = new Date();
  // Convert to CT offset (UTC-6 standard, UTC-5 daylight — approximate as UTC-6 for display)
  const CT_OFFSET_MS = 6 * 60 * 60 * 1000;
  const nowCT = new Date(now.getTime() - CT_OFFSET_MS);
  const y = nowCT.getUTCFullYear();
  const m = nowCT.getUTCMonth();
  const d = nowCT.getUTCDate();
  const slots = [9, 13, 17]; // 9am, 1pm, 5pm
  for (const h of slots) {
    const slot = new Date(Date.UTC(y, m, d, h) + CT_OFFSET_MS);
    if (slot > now) return slot;
  }
  // Next day 9am
  const tomorrow = new Date(Date.UTC(y, m, d + 1, 9) + CT_OFFSET_MS);
  return tomorrow;
}

function formatNextUpload(date: Date): string {
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    timeZone: "America/Chicago",
  });
}

// Use the registered media:// protocol to serve local files.
// Using file:// directly in <video src> fails when the renderer is loaded from
// http://localhost (dev mode) — Chromium's media pipeline blocks cross-protocol
// loads even when webSecurity is disabled.  The media:// scheme is privileged
// and streams files via net.fetch in the main process, bypassing this restriction.
// URL format: media://local/C:/path/to/file.mp4
function localFileUrl(filePath: string): string {
  if (!filePath) return "";
  const normalized = filePath.replace(/\\/g, "/").replace(/^\//, "");
  return `media://local/${normalized}`;
}

async function ipcInvoke(channel: string, ...args: unknown[]): Promise<unknown> {
  return (window as any).electron?.ipcRenderer?.invoke(channel, ...args);
}

// ---------------------------------------------------------------------------
// Style constants (matching existing app patterns from Calls.tsx)
// ---------------------------------------------------------------------------

const s = {
  page: { padding: 24, flex: 1, overflow: "auto" as const, color: "#e0e0e0" },
  title: { fontSize: 18, fontWeight: 700, color: "#fff", marginBottom: 4 },
  subtitle: { fontSize: 12, color: "#555", marginBottom: 24 },
  sectionTitle: {
    fontSize: 12,
    fontWeight: 600,
    color: "#666",
    textTransform: "uppercase" as const,
    letterSpacing: "0.07em",
    marginBottom: 12,
  },
  card: {
    background: "#141414",
    border: "1px solid #1e1e1e",
    borderRadius: 8,
    padding: 16,
    marginBottom: 12,
  },
  videoTitle: { fontSize: 14, fontWeight: 600, color: "#fff", marginBottom: 8 },
  meta: { fontSize: 11, color: "#555" },
  btnSmall: {
    padding: "4px 10px",
    background: "#2a2a2a",
    border: "1px solid #333",
    borderRadius: 5,
    color: "#e0e0e0",
    cursor: "pointer",
    fontSize: 12,
  },
  btnApprove: {
    padding: "6px 14px",
    background: "#14532d",
    border: "1px solid #166534",
    borderRadius: 6,
    color: "#4ade80",
    cursor: "pointer",
    fontSize: 12,
    fontWeight: 600,
  },
  btnReject: {
    padding: "6px 14px",
    background: "#3a0f0f",
    border: "1px solid #7f1d1d",
    borderRadius: 6,
    color: "#f87171",
    cursor: "pointer",
    fontSize: 12,
    fontWeight: 600,
  },
  btnLink: {
    background: "none",
    border: "none",
    color: "#7c3aed",
    cursor: "pointer",
    fontSize: 12,
    padding: 0,
  },
  input: {
    width: "100%",
    padding: "7px 10px",
    background: "#1a1a1a",
    border: "1px solid #2a2a2a",
    borderRadius: 6,
    color: "#e0e0e0",
    fontSize: 12,
    outline: "none",
    boxSizing: "border-box" as const,
    fontFamily: "inherit",
    marginTop: 6,
  },
};

// ---------------------------------------------------------------------------
// Channel badge
// ---------------------------------------------------------------------------

function ChannelBadge({ channel }: { channel: PendingVideo["channel"] }) {
  const isALH = channel === "AILifeHacks";
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: "0.04em",
        textTransform: "uppercase" as const,
        padding: "2px 7px",
        borderRadius: 4,
        background: isALH ? "#0e1b2e" : "#1a0e2e",
        color: isALH ? "#60a5fa" : "#a78bfa",
        border: `1px solid ${isALH ? "#1e3a5f" : "#3a1e5f"}`,
      }}
    >
      {channel}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Video card (pending review) — Shorts layout (9:16 tall + thumbnail beside)
// ---------------------------------------------------------------------------

// Shorts are 9:16. Render video + thumbnail at matching height side-by-side.
// Rejection model:
//   - Reject Video (with note)   → mark video for re-render with feedback
//   - Reject Thumbnail (w/ note) → mark thumbnail for re-generate with feedback
//   - No note on either reject   → trash that asset entirely
//   - Approve                    → both assets approved, enter upload queue

type RejectTarget = "video" | "thumbnail";

function AssetRejectPanel({
  label,
  onConfirm,
  onCancel,
}: {
  label: string;
  onConfirm: (note: string) => void;
  onCancel: () => void;
}) {
  const [note, setNote] = useState("");
  return (
    <div style={{ marginTop: 8 }}>
      <input
        type="text"
        placeholder={`Why reject ${label}? (blank = trash it)`}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        style={s.input}
        autoFocus
        onKeyDown={(e) => {
          if (e.key === "Enter") onConfirm(note.trim());
          if (e.key === "Escape") onCancel();
        }}
      />
      <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
        <button
          style={{ ...s.btnReject, fontSize: 11 }}
          onClick={() => onConfirm(note.trim())}
        >
          {note.trim() ? "Reject & Re-queue with Feedback" : "Trash It"}
        </button>
        <button style={s.btnSmall} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

// Shorts aspect ratio = 9:16 → width = height * 9/16
const SHORTS_HEIGHT = 400;
const SHORTS_WIDTH = Math.round(SHORTS_HEIGHT * 9 / 16); // 225px

function VideoCard({
  video,
  onApprove,
  onReject,
}: {
  video: PendingVideo;
  onApprove: (id: string) => void;
  onReject: (id: string, target: RejectTarget | "both", note: string) => void;
}) {
  const [rejectTarget, setRejectTarget] = useState<RejectTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const [muted, setMuted] = useState(false);
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const [videoDiag, setVideoDiag] = useState<{
    readyState: number; error: string | null; videoWidth: number; videoHeight: number;
    offsetW: number; offsetH: number; muted: boolean; volume: number; src: string;
  } | null>(null);

  function captureDiag() {
    const el = videoRef.current;
    if (!el) return;
    el.volume = 1.0;
    const diag = {
      readyState: el.readyState,
      error: el.error ? `code=${el.error.code} msg=${el.error.message}` : null,
      videoWidth: el.videoWidth,
      videoHeight: el.videoHeight,
      offsetW: el.offsetWidth,
      offsetH: el.offsetHeight,
      muted: el.muted,
      volume: el.volume,
      src: el.src,
    };
    console.log(`[ContentPipeline] diag "${video.id}":`, diag);
    setVideoDiag(diag);
  }

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.muted = muted;
    captureDiag();
  }, [muted]);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;

    captureDiag();
    el.addEventListener("loadedmetadata", captureDiag);
    el.addEventListener("loadeddata", captureDiag);
    el.addEventListener("error", captureDiag);
    el.addEventListener("volumechange", captureDiag);
    el.addEventListener("play", captureDiag);

    return () => {
      el.removeEventListener("loadedmetadata", captureDiag);
      el.removeEventListener("loadeddata", captureDiag);
      el.removeEventListener("error", captureDiag);
      el.removeEventListener("volumechange", captureDiag);
      el.removeEventListener("play", captureDiag);
    };
  }, [video.video_path, video.id]);

  async function handleApprove() {
    setBusy(true);
    await onApprove(video.id);
    setBusy(false);
  }

  async function handleRejectConfirm(note: string) {
    if (!rejectTarget) return;
    setBusy(true);
    await onReject(video.id, rejectTarget, note);
    setBusy(false);
    setRejectTarget(null);
  }

  return (
    <div style={{ ...s.card, borderLeft: "3px solid #1e1e1e" }}>
      {/* Title row */}
      <div style={{ marginBottom: 12 }}>
        <div style={s.videoTitle}>{video.title}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
          <ChannelBadge channel={video.channel} />
          <span style={s.meta}>Generated {video.generated_date}</span>
        </div>
      </div>

      {/* Media row — video (9:16) + thumbnail (9:16) side by side */}
      <div style={{ display: "flex", gap: 12, marginBottom: 12, alignItems: "flex-start" }}>

        {/* Video — Shorts 9:16 */}
        <div style={{ flexShrink: 0 }}>
          <div style={{ fontSize: 10, color: "#555", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.06em" }}>Video</div>
          {video.video_path ? (
            <>
              <video
                ref={videoRef}
                controls
                preload="metadata"
                style={{
                  width: SHORTS_WIDTH,
                  height: SHORTS_HEIGHT,
                  borderRadius: 6,
                  background: "#000",
                  display: "block",
                }}
                src={localFileUrl(video.video_path)}
              />
              {/* Mute/Unmute — Chromium collapses native volume control at 225px */}
              <button
                onClick={() => setMuted(m => !m)}
                style={{
                  marginTop: 4,
                  width: SHORTS_WIDTH,
                  padding: "4px 0",
                  fontSize: 11,
                  background: muted ? "#7f1d1d" : "#1a2e1a",
                  color: muted ? "#fca5a5" : "#86efac",
                  border: `1px solid ${muted ? "#991b1b" : "#166534"}`,
                  borderRadius: 4,
                  cursor: "pointer",
                  fontFamily: "monospace",
                  letterSpacing: "0.05em",
                }}
              >
                {muted ? "UNMUTE" : "MUTE"}
              </button>
              {/* Diagnostic overlay — proves video loaded, shows actual DOM state */}
              {videoDiag && (
                <div style={{
                  fontSize: 9,
                  fontFamily: "monospace",
                  marginTop: 3,
                  padding: "4px 6px",
                  background: "#0a0a0a",
                  borderRadius: 4,
                  border: "1px solid #222",
                  lineHeight: 1.6,
                }}>
                  <span style={{ color: videoDiag.readyState >= 2 ? "#4ade80" : "#facc15" }}>
                    ready={videoDiag.readyState}
                  </span>
                  {" | "}
                  <span style={{ color: videoDiag.videoWidth > 0 ? "#4ade80" : "#f87171" }}>
                    {videoDiag.videoWidth}×{videoDiag.videoHeight}
                  </span>
                  {" | "}
                  <span style={{ color: videoDiag.muted ? "#f87171" : "#4ade80" }}>
                    {videoDiag.muted ? "MUTED" : `vol=${videoDiag.volume.toFixed(2)}`}
                  </span>
                  {videoDiag.error && (
                    <span style={{ color: "#f87171", display: "block" }}>ERR: {videoDiag.error}</span>
                  )}
                  <span style={{ color: "#555", display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: SHORTS_WIDTH }}>
                    {videoDiag.src.slice(0, 60)}
                  </span>
                </div>
              )}
            </>
          ) : (
            <div style={{
              width: SHORTS_WIDTH,
              height: SHORTS_HEIGHT,
              background: "#0a0a0a",
              border: "1px solid #1e1e1e",
              borderRadius: 6,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#333",
              fontSize: 11,
            }}>
              No video file
            </div>
          )}
          {/* Per-asset reject button */}
          <button
            style={{ ...s.btnReject, marginTop: 6, width: SHORTS_WIDTH, textAlign: "center" as const, fontSize: 11 }}
            disabled={busy}
            onClick={() => setRejectTarget(t => t === "video" ? null : "video")}
          >
            Reject Video
          </button>
          {rejectTarget === "video" && (
            <AssetRejectPanel
              label="video"
              onConfirm={handleRejectConfirm}
              onCancel={() => setRejectTarget(null)}
            />
          )}
        </div>

        {/* Thumbnail — same 9:16 dimensions */}
        <div style={{ flexShrink: 0 }}>
          <div style={{ fontSize: 10, color: "#555", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.06em" }}>Thumbnail</div>
          {video.thumbnail_path ? (
            <img
              src={localFileUrl(video.thumbnail_path)}
              alt="Thumbnail"
              style={{
                width: SHORTS_WIDTH,
                height: SHORTS_HEIGHT,
                objectFit: "cover",
                borderRadius: 6,
                display: "block",
              }}
            />
          ) : (
            <div style={{
              width: SHORTS_WIDTH,
              height: SHORTS_HEIGHT,
              background: "#0a0a0a",
              border: "1px solid #1e1e1e",
              borderRadius: 6,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#333",
              fontSize: 11,
            }}>
              No thumbnail
            </div>
          )}
          <button
            style={{ ...s.btnReject, marginTop: 6, width: SHORTS_WIDTH, textAlign: "center" as const, fontSize: 11 }}
            disabled={busy}
            onClick={() => setRejectTarget(t => t === "thumbnail" ? null : "thumbnail")}
          >
            Reject Thumbnail
          </button>
          {rejectTarget === "thumbnail" && (
            <AssetRejectPanel
              label="thumbnail"
              onConfirm={handleRejectConfirm}
              onCancel={() => setRejectTarget(null)}
            />
          )}
        </div>
      </div>

      {/* Main actions */}
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button
          style={{ ...s.btnApprove, opacity: busy ? 0.5 : 1 }}
          disabled={busy}
          onClick={handleApprove}
        >
          Approve Both
        </button>
        <button
          style={{ ...s.btnReject, opacity: busy ? 0.5 : 1, fontSize: 11 }}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await onReject(video.id, "both", "");
            setBusy(false);
          }}
        >
          Trash Both
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Upload queue row
// ---------------------------------------------------------------------------

function UploadRow({
  video,
  nextUpload,
  onMarkUploaded,
}: {
  video: PendingVideo;
  nextUpload: Date;
  onMarkUploaded: (id: string) => void;
}) {
  const uploadStatus = video.upload_status ?? "scheduled";
  const [marking, setMarking] = useState(false);
  const [urlInput, setUrlInput] = useState("");
  const [showUrlInput, setShowUrlInput] = useState(false);

  const statusColor: Record<string, string> = {
    scheduled: "#facc15",
    uploading: "#60a5fa",
    posted: "#4ade80",
  };

  async function handleMark() {
    setMarking(true);
    await ipcInvoke("empire:markUploaded", video.id, urlInput || undefined);
    setMarking(false);
    setShowUrlInput(false);
    onMarkUploaded(video.id);
  }

  return (
    <div
      style={{
        ...s.card,
        borderLeft: `3px solid ${statusColor[uploadStatus] ?? "#333"}`,
        padding: "12px 16px",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#e0e0e0", marginBottom: 4 }}>
            {video.title}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" as const }}>
            <ChannelBadge channel={video.channel} />
            {uploadStatus === "scheduled" && (
              <span style={{ fontSize: 11, color: "#555" }}>
                Next slot: {formatNextUpload(nextUpload)}
              </span>
            )}
            {uploadStatus === "uploading" && (
              <span style={{ fontSize: 11, color: "#60a5fa" }}>Uploading now…</span>
            )}
            {uploadStatus === "posted" && video.youtube_url && (
              <a
                href={video.youtube_url}
                target="_blank"
                rel="noreferrer"
                style={{ fontSize: 11, color: "#4ade80", textDecoration: "none" }}
              >
                View on YouTube
              </a>
            )}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          {uploadStatus !== "posted" && (
            <button
              style={{ ...s.btnSmall, background: showUrlInput ? "#1a3a1a" : "#2a2a2a", color: showUrlInput ? "#4ade80" : "#e0e0e0" }}
              disabled={marking}
              onClick={() => setShowUrlInput(v => !v)}
            >
              {marking ? "Saving…" : "Mark Uploaded"}
            </button>
          )}
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              textTransform: "uppercase" as const,
              letterSpacing: "0.06em",
              color: statusColor[uploadStatus] ?? "#888",
              background: "#0f0f0f",
              border: `1px solid ${statusColor[uploadStatus] ?? "#333"}`,
              borderRadius: 4,
              padding: "2px 7px",
            }}
          >
            {uploadStatus}
          </span>
        </div>
      </div>

      {showUrlInput && uploadStatus !== "posted" && (
        <div style={{ marginTop: 10, display: "flex", gap: 6 }}>
          <input
            type="text"
            placeholder="YouTube URL (optional)"
            value={urlInput}
            onChange={e => setUrlInput(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") handleMark(); if (e.key === "Escape") setShowUrlInput(false); }}
            style={{ ...s.input, flex: 1 }}
            autoFocus
          />
          <button style={{ ...s.btnApprove, fontSize: 11 }} onClick={handleMark} disabled={marking}>
            Confirm
          </button>
          <button style={s.btnSmall} onClick={() => setShowUrlInput(false)}>Cancel</button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function ContentPipeline() {
  const [videos, setVideos] = useState<PendingVideo[]>([]);
  const [loading, setLoading] = useState(true);
  const [usingDemo, setUsingDemo] = useState(false);
  const nextUpload = nextUploadTime();
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    load();
    intervalRef.current = setInterval(load, 30_000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  async function load() {
    try {
      const result = await ipcInvoke("empire:getPendingVideos") as PendingVideo[] | null | undefined;
      if (result && Array.isArray(result) && result.length > 0) {
        setVideos(result);
        setUsingDemo(false);
      } else {
        setVideos(DEMO_PENDING);
        setUsingDemo(true);
      }
    } catch {
      setVideos(DEMO_PENDING);
      setUsingDemo(true);
    } finally {
      setLoading(false);
    }
  }

  async function handleApprove(id: string) {
    try {
      await ipcInvoke("empire:approveVideo", id);
    } catch { /* IPC not wired yet — update local state only */ }
    setVideos((prev) =>
      prev.map((v) => (v.id === id ? { ...v, status: "approved" } : v))
    );
  }

  async function handleReject(id: string, target: RejectTarget | "both", note: string) {
    try {
      await ipcInvoke("empire:rejectVideo", id, target, note);
    } catch { /* IPC not wired yet — update local state only */ }
    // With no note → trash (remove from list). With note → mark rejected so the
    // agent can re-queue with feedback.
    if (!note) {
      setVideos((prev) => prev.filter((v) => v.id !== id));
    } else {
      setVideos((prev) =>
        prev.map((v) =>
          v.id === id
            ? { ...v, status: "rejected", rejection_note: `[${target}] ${note}` }
            : v
        )
      );
    }
  }

  const pending = videos.filter((v) => v.status === "pending_approval");
  const approved = videos.filter((v) => v.status === "approved");

  return (
    <div style={s.page}>
      {/* Header */}
      <div style={s.title}>Content Pipeline</div>
      <div style={s.subtitle}>
        {loading
          ? "Loading…"
          : `${pending.length} video${pending.length !== 1 ? "s" : ""} pending review${usingDemo ? " — demo data" : ""}`}
      </div>

      {/* Pending Review */}
      <div style={{ marginBottom: 32 }}>
        <div style={s.sectionTitle}>Pending Review ({pending.length})</div>
        {!loading && pending.length === 0 && (
          <div style={{ fontSize: 13, color: "#444" }}>No videos pending review.</div>
        )}
        {pending.map((v) => (
          <VideoCard
            key={v.id}
            video={v}
            onApprove={handleApprove}
            onReject={(id, target, note) => handleReject(id, target, note)}
          />
        ))}
      </div>

      {/* Upload Queue */}
      <div>
        <div style={s.sectionTitle}>Upload Queue ({approved.length})</div>
        {approved.length === 0 ? (
          <div style={{ fontSize: 13, color: "#444" }}>
            No approved videos queued. Approve a video above to schedule it.
          </div>
        ) : (
          approved.map((v) => (
            <UploadRow
              key={v.id}
              video={v}
              nextUpload={nextUpload}
              onMarkUploaded={(id) => setVideos(prev => prev.map(p => p.id === id ? { ...p, upload_status: "posted" } : p))}
            />
          ))
        )}
      </div>
    </div>
  );
}
