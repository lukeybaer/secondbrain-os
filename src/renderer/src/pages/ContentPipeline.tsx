import React, { useState, useEffect, useRef } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PendingVideo {
  id: string;
  title: string;
  channel: 'Channel1' | 'Channel2';
  status:
    | 'pending_approval'
    | 'approved'
    | 'rejected'
    | 'video_rejected'
    | 'thumbnail_rejected'
    | 'regen_queued'
    | 'trashed';
  generated_date: string;
  video_path?: string;
  thumbnail_path?: string;
  rejection_note?: string;
  video_rejection_note?: string;
  thumbnail_rejection_note?: string;
  video_needs_regen?: boolean;
  thumbnail_needs_regen?: boolean;
  transcript_file?: string;
  transcript?: {
    words: { word: string; start: number; end: number; emphasis?: boolean }[];
    text: string;
  };
  build_notes?: string;
  previous_feedback?: string;
  fix_summary?: string;
  youtube_url?: string;
  scheduled_upload_at?: string;
  upload_status?: 'scheduled' | 'uploading' | 'posted';
}

export interface PublishedVideo {
  id: string;
  title: string;
  channel: 'Channel1' | 'Channel2';
  youtube_url?: string;
  published_date?: string;
  video_path?: string;
  thumbnail_path?: string;
}

export interface SocialPost {
  id: string;
  platform: 'x' | 'linkedin';
  status: 'draft' | 'pending_approval' | 'approved' | 'rejected' | 'posted' | 'trashed';
  content: string;
  source_idea?: string;
  media_paths?: string[];
  created_at: string;
  approved_at?: string;
  posted_at?: string;
  post_url?: string;
  rejection_note?: string;
  scheduled_for?: string;
  tweet_id?: string;
  exported_at?: string;
  export_url?: string;
  export_note?: string;
  variants?: {
    id: string;
    content: string;
    created_at: string;
    source: string;
    active: boolean;
  }[];
  active_variant_id?: string;
  history?: {
    id: string;
    type: string;
    at: string;
    note?: string;
    actor?: string;
    metadata?: Record<string, unknown>;
  }[];
  media_validation?: {
    path: string;
    exists: boolean;
    kind: 'image' | 'video' | 'file';
    file_name: string;
    warning?: string;
  }[];
  learnings?: {
    id: string;
    type: 'rejection' | 'engagement';
    platform: 'x' | 'linkedin';
    content_excerpt: string;
    note?: string;
    metrics?: Record<string, unknown>;
    created_at: string;
  }[];
  engagement?: {
    views?: number;
    likes?: number;
    retweets?: number;
    replies?: number;
    last_checked?: string;
  };
}

// ---------------------------------------------------------------------------
// Demo fallback data
// ---------------------------------------------------------------------------

const DEMO_PENDING: PendingVideo[] = [
  {
    id: 'mit_30_agents',
    title: 'MIT Audited 30 AI Agents. Every Single One Failed.',
    channel: 'Channel1',
    status: 'pending_approval',
    generated_date: '2026-03-14',
  },
  {
    id: 'ai_agent_income_formula',
    title: 'She Replaced Her $1,400/Month VA , Income Doubled',
    channel: 'Channel1',
    status: 'pending_approval',
    generated_date: '2026-03-14',
  },
  {
    id: 'nine_free_ai_tools_2026',
    title: "9 Free AI Tools Your Competition Hasn't Found Yet",
    channel: 'Channel1',
    status: 'pending_approval',
    generated_date: '2026-03-14',
  },
  {
    id: 'kids_tiny_elephant',
    title: 'The Tiny Elephant Who Never Forgot a Friend',
    channel: 'Channel2',
    status: 'pending_approval',
    generated_date: '2026-03-14',
  },
  {
    id: 'kids_little_whale',
    title: 'The Little Whale Who Learned to Sing',
    channel: 'Channel2',
    status: 'pending_approval',
    generated_date: '2026-03-14',
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Next scheduled upload times: 9am, 1pm, 5pm CT
function nextUploadTime(): Date {
  const now = new Date();
  // Convert to CT offset (UTC-6 standard, UTC-5 daylight , approximate as UTC-6 for display)
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
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
    timeZone: 'America/Chicago',
  });
}

// Use the registered media:// protocol to serve local files.
// Using file:// directly in <video src> fails when the renderer is loaded from
// http://localhost (dev mode) , Chromium's media pipeline blocks cross-protocol
// loads even when webSecurity is disabled.  The media:// scheme is privileged
// and streams files via net.fetch in the main process, bypassing this restriction.
// URL format: media://local/C:/path/to/file.mp4
function localFileUrl(filePath: string): string {
  if (!filePath) return '';
  const normalized = filePath.replace(/\\/g, '/').replace(/^\//, '');
  return `media://local/${normalized}`;
}

async function ipcInvoke(channel: string, ...args: unknown[]): Promise<unknown> {
  return (window as any).electron?.ipcRenderer?.invoke(channel, ...args);
}

// ---------------------------------------------------------------------------
// Style constants (matching existing app patterns from Calls.tsx)
// ---------------------------------------------------------------------------

const s = {
  page: { padding: 24, flex: 1, overflow: 'auto' as const, color: '#e0e0e0' },
  title: { fontSize: 18, fontWeight: 700, color: '#fff', marginBottom: 4 },
  subtitle: { fontSize: 12, color: '#555', marginBottom: 24 },
  sectionTitle: {
    fontSize: 12,
    fontWeight: 600,
    color: '#666',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.07em',
    marginBottom: 12,
  },
  card: {
    background: '#141414',
    border: '1px solid #1e1e1e',
    borderRadius: 8,
    padding: 16,
    marginBottom: 12,
  },
  videoTitle: { fontSize: 14, fontWeight: 600, color: '#fff', marginBottom: 8 },
  meta: { fontSize: 11, color: '#555' },
  btnSmall: {
    padding: '4px 10px',
    background: '#2a2a2a',
    border: '1px solid #333',
    borderRadius: 5,
    color: '#e0e0e0',
    cursor: 'pointer',
    fontSize: 12,
  },
  btnApprove: {
    padding: '6px 14px',
    background: '#14532d',
    border: '1px solid #166534',
    borderRadius: 6,
    color: '#4ade80',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 600,
  },
  btnReject: {
    padding: '6px 14px',
    background: '#3a0f0f',
    border: '1px solid #7f1d1d',
    borderRadius: 6,
    color: '#f87171',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 600,
  },
  btnLink: {
    background: 'none',
    border: 'none',
    color: '#7c3aed',
    cursor: 'pointer',
    fontSize: 12,
    padding: 0,
  },
  input: {
    width: '100%',
    padding: '7px 10px',
    background: '#1a1a1a',
    border: '1px solid #2a2a2a',
    borderRadius: 6,
    color: '#e0e0e0',
    fontSize: 12,
    outline: 'none',
    boxSizing: 'border-box' as const,
    fontFamily: 'inherit',
    marginTop: 6,
  },
};

// ---------------------------------------------------------------------------
// Channel badge
// ---------------------------------------------------------------------------

function ChannelBadge({ channel }: { channel: PendingVideo['channel'] }) {
  const isALH = channel === 'Channel1';
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: '0.04em',
        textTransform: 'uppercase' as const,
        padding: '2px 7px',
        borderRadius: 4,
        background: isALH ? '#0e1b2e' : '#1a0e2e',
        color: isALH ? '#60a5fa' : '#a78bfa',
        border: `1px solid ${isALH ? '#1e3a5f' : '#3a1e5f'}`,
      }}
    >
      {channel}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Video card (pending review) , Shorts layout (9:16 tall + thumbnail beside)
// ---------------------------------------------------------------------------

// Shorts are 9:16. Render video + thumbnail at matching height side-by-side.
// Rejection model:
//   - Reject Video (with note)   → mark video for re-render with feedback
//   - Reject Thumbnail (w/ note) → mark thumbnail for re-generate with feedback
//   - No note on either reject   → trash that asset entirely
//   - Approve                    → both assets approved, enter upload queue

type RejectTarget = 'video' | 'thumbnail';

function AssetRejectPanel({
  label,
  onConfirm,
  onCancel,
}: {
  label: string;
  onConfirm: (note: string) => void;
  onCancel: () => void;
}) {
  const [note, setNote] = useState('');
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
          if (e.key === 'Enter') onConfirm(note.trim());
          if (e.key === 'Escape') onCancel();
        }}
      />
      <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
        <button style={{ ...s.btnReject, fontSize: 11 }} onClick={() => onConfirm(note.trim())}>
          {note.trim() ? 'Reject & Re-queue with Feedback' : 'Trash It'}
        </button>
        <button style={s.btnSmall} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// Shorts aspect ratio = 9:16 → width = height * 9/16
const SHORTS_HEIGHT = 400;
const SHORTS_WIDTH = Math.round((SHORTS_HEIGHT * 9) / 16); // 225px

// ---------------------------------------------------------------------------
// Custom video player , replaces broken native controls at 225px width.
// Chromium's native <video controls> collapse at narrow widths: the progress
// bar becomes undraggable, seek buttons overlap, and forward sometimes
// triggers backward. This component provides a working scrubber + skip.
// ---------------------------------------------------------------------------

function ShortsPlayer({
  src,
  width = SHORTS_WIDTH,
  height = SHORTS_HEIGHT,
}: {
  src: string;
  width?: number;
  height?: number;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const scrubRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.muted = muted;
  }, [muted]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onTime = () => {
      if (!dragging) setCurrentTime(el.currentTime);
    };
    const onMeta = () => setDuration(el.duration || 0);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    el.addEventListener('timeupdate', onTime);
    el.addEventListener('loadedmetadata', onMeta);
    el.addEventListener('play', onPlay);
    el.addEventListener('pause', onPause);
    return () => {
      el.removeEventListener('timeupdate', onTime);
      el.removeEventListener('loadedmetadata', onMeta);
      el.removeEventListener('play', onPlay);
      el.removeEventListener('pause', onPause);
    };
  }, [dragging]);

  function togglePlay() {
    const el = ref.current;
    if (!el) return;
    if (el.paused) el.play();
    else el.pause();
  }

  function skip(seconds: number) {
    const el = ref.current;
    if (!el) return;
    el.currentTime = Math.max(0, Math.min(el.duration || 0, el.currentTime + seconds));
    setCurrentTime(el.currentTime);
  }

  function seekFromEvent(e: React.MouseEvent<HTMLDivElement>) {
    const bar = scrubRef.current;
    const el = ref.current;
    if (!bar || !el || !el.duration) return;
    const rect = bar.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    el.currentTime = pct * el.duration;
    setCurrentTime(el.currentTime);
  }

  function onScrubDown(e: React.MouseEvent<HTMLDivElement>) {
    setDragging(true);
    seekFromEvent(e);

    const onMove = (ev: MouseEvent) => {
      const bar = scrubRef.current;
      const el = ref.current;
      if (!bar || !el || !el.duration) return;
      const rect = bar.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
      el.currentTime = pct * el.duration;
      setCurrentTime(el.currentTime);
    };
    const onUp = () => {
      setDragging(false);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  const pct = duration > 0 ? (currentTime / duration) * 100 : 0;

  function fmt(t: number) {
    const m = Math.floor(t / 60);
    const sec = Math.floor(t % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  }

  return (
    <div style={{ width }}>
      {/* Video element , no native controls */}
      <video
        ref={ref}
        preload="metadata"
        onClick={togglePlay}
        style={{
          width,
          height,
          borderRadius: 6,
          background: '#000',
          display: 'block',
          cursor: 'pointer',
        }}
        src={src}
      />

      {/* Scrubber bar , click or drag to seek */}
      <div
        ref={scrubRef}
        onMouseDown={onScrubDown}
        style={{
          width,
          height: 14,
          background: '#1a1a1a',
          borderRadius: 3,
          marginTop: 4,
          cursor: 'pointer',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        {/* Progress fill */}
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            height: '100%',
            width: `${pct}%`,
            background: '#7c3aed',
            borderRadius: 3,
            transition: dragging ? 'none' : 'width 0.15s linear',
          }}
        />
        {/* Thumb dot */}
        <div
          style={{
            position: 'absolute',
            top: 1,
            left: `calc(${pct}% - 6px)`,
            width: 12,
            height: 12,
            borderRadius: '50%',
            background: '#a78bfa',
            border: '2px solid #1a1a1a',
            transition: dragging ? 'none' : 'left 0.15s linear',
          }}
        />
      </div>

      {/* Time display */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          fontSize: 9,
          fontFamily: 'monospace',
          color: '#555',
          marginTop: 2,
          width,
        }}
      >
        <span>{fmt(currentTime)}</span>
        <span>{fmt(duration)}</span>
      </div>

      {/* Control buttons */}
      <div style={{ display: 'flex', gap: 4, marginTop: 4, width }}>
        <button
          onClick={togglePlay}
          style={{
            flex: 1,
            padding: '4px 0',
            fontSize: 11,
            background: '#1a1a2e',
            color: '#a5b4fc',
            border: '1px solid #2e2e4e',
            borderRadius: 4,
            cursor: 'pointer',
            fontFamily: 'monospace',
          }}
        >
          {playing ? '⏸ Pause' : '▶ Play'}
        </button>
        <button
          onClick={() => setMuted((m) => !m)}
          style={{
            padding: '4px 8px',
            fontSize: 11,
            background: muted ? '#7f1d1d' : '#1a2e1a',
            color: muted ? '#fca5a5' : '#86efac',
            border: `1px solid ${muted ? '#991b1b' : '#166534'}`,
            borderRadius: 4,
            cursor: 'pointer',
            fontFamily: 'monospace',
          }}
        >
          {muted ? '🔇' : '🔊'}
        </button>
        <button
          onClick={() => skip(-10)}
          style={{
            padding: '4px 6px',
            fontSize: 11,
            background: '#1a1a2e',
            color: '#a5b4fc',
            border: '1px solid #2e2e4e',
            borderRadius: 4,
            cursor: 'pointer',
            fontFamily: 'monospace',
          }}
        >
          -10s
        </button>
        <button
          onClick={() => skip(10)}
          style={{
            padding: '4px 6px',
            fontSize: 11,
            background: '#1a1a2e',
            color: '#a5b4fc',
            border: '1px solid #2e2e4e',
            borderRadius: 4,
            cursor: 'pointer',
            fontFamily: 'monospace',
          }}
        >
          +10s
        </button>
      </div>
    </div>
  );
}

function VideoCard({
  video,
  onApprove,
  onReject,
}: {
  video: PendingVideo;
  onApprove: (id: string) => void;
  onReject: (id: string, target: RejectTarget | 'both', note: string) => void;
}) {
  const [rejectTarget, setRejectTarget] = useState<RejectTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const [muted, setMuted] = useState(false);
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const [videoDiag, setVideoDiag] = useState<{
    readyState: number;
    error: string | null;
    videoWidth: number;
    videoHeight: number;
    offsetW: number;
    offsetH: number;
    muted: boolean;
    volume: number;
    src: string;
    hasAudio: boolean | null;
  } | null>(null);

  function captureDiag() {
    const el = videoRef.current;
    if (!el) return;
    el.volume = 1.0;
    // Detect audio: audioTracks API (Chromium supports it) , null means unknown
    const audioTrackCount = (el as any).audioTracks?.length ?? null;
    const hasAudio = audioTrackCount === null ? null : audioTrackCount > 0;
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
      hasAudio,
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
    el.addEventListener('loadedmetadata', captureDiag);
    el.addEventListener('loadeddata', captureDiag);
    el.addEventListener('error', captureDiag);
    el.addEventListener('volumechange', captureDiag);
    el.addEventListener('play', captureDiag);

    return () => {
      el.removeEventListener('loadedmetadata', captureDiag);
      el.removeEventListener('loadeddata', captureDiag);
      el.removeEventListener('error', captureDiag);
      el.removeEventListener('volumechange', captureDiag);
      el.removeEventListener('play', captureDiag);
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
    <div style={{ ...s.card, borderLeft: '3px solid #1e1e1e' }}>
      {/* Title row */}
      <div style={{ marginBottom: 12 }}>
        <div style={s.videoTitle}>{video.title}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
          <ChannelBadge channel={video.channel} />
          <span style={s.meta}>Generated {video.generated_date}</span>
        </div>
      </div>

      {/* Media row , video (9:16) + thumbnail (9:16) side by side */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 12, alignItems: 'flex-start' }}>
        {/* Video , Shorts 9:16 */}
        <div style={{ flexShrink: 0 }}>
          <div
            style={{
              fontSize: 10,
              color: '#555',
              marginBottom: 4,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
            }}
          >
            Video
          </div>
          {video.video_path ? (
            <ShortsPlayer src={localFileUrl(video.video_path)} />
          ) : (
            <div
              style={{
                width: SHORTS_WIDTH,
                height: SHORTS_HEIGHT,
                background: '#0a0a0a',
                border: '1px solid #1e1e1e',
                borderRadius: 6,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#333',
                fontSize: 11,
              }}
            >
              No video file
            </div>
          )}
          {/* Per-asset reject button */}
          <button
            style={{
              ...s.btnReject,
              marginTop: 6,
              width: SHORTS_WIDTH,
              textAlign: 'center' as const,
              fontSize: 11,
            }}
            disabled={busy}
            onClick={() => setRejectTarget((t) => (t === 'video' ? null : 'video'))}
          >
            Reject Video
          </button>
          {rejectTarget === 'video' && (
            <AssetRejectPanel
              label="video"
              onConfirm={handleRejectConfirm}
              onCancel={() => setRejectTarget(null)}
            />
          )}
        </div>

        {/* Thumbnail , same 9:16 dimensions */}
        <div style={{ flexShrink: 0 }}>
          <div
            style={{
              fontSize: 10,
              color: '#555',
              marginBottom: 4,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
            }}
          >
            Thumbnail
          </div>
          {video.thumbnail_path ? (
            <img
              src={localFileUrl(video.thumbnail_path)}
              alt="Thumbnail"
              style={{
                width: SHORTS_WIDTH,
                height: SHORTS_HEIGHT,
                objectFit: 'cover',
                borderRadius: 6,
                display: 'block',
              }}
            />
          ) : (
            <div
              style={{
                width: SHORTS_WIDTH,
                height: SHORTS_HEIGHT,
                background: '#0a0a0a',
                border: '1px solid #1e1e1e',
                borderRadius: 6,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#333',
                fontSize: 11,
              }}
            >
              No thumbnail
            </div>
          )}
          <button
            style={{
              ...s.btnReject,
              marginTop: 6,
              width: SHORTS_WIDTH,
              textAlign: 'center' as const,
              fontSize: 11,
            }}
            disabled={busy}
            onClick={() => setRejectTarget((t) => (t === 'thumbnail' ? null : 'thumbnail'))}
          >
            Reject Thumbnail
          </button>
          {rejectTarget === 'thumbnail' && (
            <AssetRejectPanel
              label="thumbnail"
              onConfirm={handleRejectConfirm}
              onCancel={() => setRejectTarget(null)}
            />
          )}
        </div>
      </div>

      {/* Main actions */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
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
            await onReject(video.id, 'both', '');
            setBusy(false);
          }}
        >
          Trash Both
        </button>
      </div>

      {/* Previous feedback + fix summary (for re-presented videos) */}
      {video.previous_feedback && (
        <div
          style={{
            marginTop: 12,
            background: '#1a1a0a',
            border: '1px solid #554400',
            borderRadius: 6,
            padding: '10px 12px',
          }}
        >
          <div
            style={{
              fontSize: 10,
              color: '#facc15',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              marginBottom: 4,
            }}
          >
            Previous Feedback
          </div>
          <div style={{ fontSize: 12, color: '#fbbf24', marginBottom: 8 }}>
            {video.previous_feedback}
          </div>
          {video.fix_summary && (
            <>
              <div
                style={{
                  fontSize: 10,
                  color: '#4ade80',
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                  marginBottom: 4,
                }}
              >
                What Changed
              </div>
              <div style={{ fontSize: 12, color: '#86efac' }}>{video.fix_summary}</div>
            </>
          )}
        </div>
      )}

      {/* Transcript + word timestamps */}
      {video.transcript && (
        <div style={{ marginTop: 12 }}>
          <div
            style={{
              fontSize: 10,
              color: '#555',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              marginBottom: 6,
            }}
          >
            Transcript ({video.transcript.words?.length ?? 0} words with timestamps)
          </div>
          <div
            style={{
              background: '#0a0a0a',
              border: '1px solid #222',
              borderRadius: 6,
              padding: '10px 12px',
              maxHeight: 200,
              overflowY: 'auto',
              fontSize: 12,
              lineHeight: 1.8,
            }}
          >
            {video.transcript.words?.map(
              (w: { word: string; start: number; end: number; emphasis?: boolean }, i: number) => (
                <span
                  key={i}
                  title={`${w.start.toFixed(2)}s , ${w.end.toFixed(2)}s`}
                  style={{
                    color: w.emphasis ? '#00FF88' : '#ccc',
                    fontWeight: w.emphasis ? 700 : 400,
                    cursor: 'default',
                    borderBottom: '1px dotted #333',
                    marginRight: 4,
                    display: 'inline-block',
                  }}
                >
                  {w.word}
                </span>
              ),
            ) ?? <span style={{ color: '#555' }}>{video.transcript.text}</span>}
          </div>
        </div>
      )}
      {video.build_notes && (
        <div style={{ marginTop: 8, fontSize: 11, color: '#666', fontStyle: 'italic' }}>
          {video.build_notes}
        </div>
      )}
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
  onReject,
}: {
  video: PendingVideo;
  nextUpload: Date;
  onMarkUploaded: (id: string) => void;
  onReject: (id: string, target: string, note: string) => Promise<void>;
}) {
  const uploadStatus = video.upload_status ?? 'scheduled';
  const [marking, setMarking] = useState(false);
  const [urlInput, setUrlInput] = useState('');
  const [showUrlInput, setShowUrlInput] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [muted, setMuted] = useState(false);
  const videoRef = React.useRef<HTMLVideoElement>(null);

  React.useEffect(() => {
    if (videoRef.current) videoRef.current.muted = muted;
  }, [muted]);

  const statusColor: Record<string, string> = {
    scheduled: '#facc15',
    uploading: '#60a5fa',
    posted: '#4ade80',
  };

  const [queuing, setQueuing] = useState(false);
  const [showReject, setShowReject] = useState(false);
  const [rejectNote, setRejectNote] = useState('');
  const [rejecting, setRejecting] = useState(false);

  async function handleReject() {
    if (!rejectNote.trim()) return;
    setRejecting(true);
    await onReject(video.id, 'both', rejectNote.trim());
    setRejecting(false);
    setShowReject(false);
    setRejectNote('');
  }

  async function handleQueueUpload() {
    setQueuing(true);
    try {
      const result = (await ipcInvoke('empire:queueForUpload', video.id)) as {
        success: boolean;
        position?: number;
        error?: string;
      };
      if (result?.success) {
        onMarkUploaded(video.id);
      } else {
        alert('Queue failed: ' + (result?.error ?? 'unknown error'));
      }
    } catch (e) {
      alert('Queue error: ' + String(e));
    }
    setQueuing(false);
  }

  async function handleMark() {
    setMarking(true);
    await ipcInvoke('empire:markUploaded', video.id, urlInput || undefined);
    setMarking(false);
    setShowUrlInput(false);
    onMarkUploaded(video.id);
  }

  return (
    <div
      style={{
        ...s.card,
        borderLeft: `3px solid ${statusColor[uploadStatus] ?? '#333'}`,
        padding: '12px 16px',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: 8,
        }}
      >
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#e0e0e0', marginBottom: 4 }}>
            {video.title}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' as const }}>
            <ChannelBadge channel={video.channel} />
            {uploadStatus === 'scheduled' && (
              <span style={{ fontSize: 11, color: '#555' }}>
                Next slot: {formatNextUpload(nextUpload)}
              </span>
            )}
            {uploadStatus === 'uploading' && (
              <span style={{ fontSize: 11, color: '#60a5fa' }}>
                Queued on EC2 , next upload slot
              </span>
            )}
            {uploadStatus === 'posted' && video.youtube_url && (
              <a
                href={video.youtube_url}
                target="_blank"
                rel="noreferrer"
                style={{ fontSize: 11, color: '#4ade80', textDecoration: 'none' }}
              >
                View on YouTube
              </a>
            )}
          </div>
        </div>
        {video.thumbnail_path && (
          <img
            src={localFileUrl(video.thumbnail_path)}
            alt="Thumbnail"
            style={{
              width: 54,
              height: 96,
              objectFit: 'cover',
              borderRadius: 4,
              border: '1px solid #333',
              flexShrink: 0,
            }}
          />
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          {video.video_path && (
            <button
              style={{ ...s.btnSmall, fontSize: 11, background: expanded ? '#1a2d1a' : '#2a2a2a' }}
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? 'Hide' : '▶ Play'}
            </button>
          )}
          {uploadStatus !== 'posted' && uploadStatus !== 'uploading' && (
            <button
              style={{
                ...s.btnSmall,
                background: '#1a2a3a',
                color: '#60a5fa',
              }}
              disabled={queuing}
              onClick={handleQueueUpload}
            >
              {queuing ? 'Pushing…' : 'Queue for Upload'}
            </button>
          )}
          {uploadStatus !== 'posted' && (
            <button
              style={{
                ...s.btnSmall,
                background: showReject ? '#3a1a1a' : '#2a2a2a',
                color: showReject ? '#f87171' : '#e0e0e0',
                fontSize: 10,
              }}
              onClick={() => setShowReject((v) => !v)}
            >
              Reject
            </button>
          )}
          {uploadStatus !== 'posted' && (
            <button
              style={{
                ...s.btnSmall,
                background: showUrlInput ? '#1a3a1a' : '#2a2a2a',
                color: showUrlInput ? '#4ade80' : '#e0e0e0',
                fontSize: 10,
              }}
              disabled={marking}
              onClick={() => setShowUrlInput((v) => !v)}
            >
              {marking ? 'Saving…' : 'Mark Uploaded'}
            </button>
          )}
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              textTransform: 'uppercase' as const,
              letterSpacing: '0.06em',
              color: statusColor[uploadStatus] ?? '#888',
              background: '#0f0f0f',
              border: `1px solid ${statusColor[uploadStatus] ?? '#333'}`,
              borderRadius: 4,
              padding: '2px 7px',
            }}
          >
            {uploadStatus}
          </span>
        </div>
      </div>

      {/* Reject form */}
      {showReject && (
        <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            value={rejectNote}
            onChange={(e) => setRejectNote(e.target.value)}
            placeholder="What needs to change?"
            style={{
              flex: 1,
              padding: '6px 8px',
              background: '#1a1a1a',
              color: '#e0e0e0',
              border: '1px solid #991b1b',
              borderRadius: 4,
              fontSize: 12,
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleReject();
            }}
          />
          <button
            style={{ ...s.btnSmall, background: '#7f1d1d', color: '#fca5a5', fontSize: 11 }}
            disabled={rejecting || !rejectNote.trim()}
            onClick={handleReject}
          >
            {rejecting ? 'Rejecting...' : 'Send Back'}
          </button>
        </div>
      )}

      {expanded && video.video_path && (
        <div style={{ marginTop: 12 }}>
          <ShortsPlayer src={localFileUrl(video.video_path)} />
        </div>
      )}

      {showUrlInput && uploadStatus !== 'posted' && (
        <div style={{ marginTop: 10, display: 'flex', gap: 6 }}>
          <input
            type="text"
            placeholder="YouTube URL (optional)"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleMark();
              if (e.key === 'Escape') setShowUrlInput(false);
            }}
            style={{ ...s.input, flex: 1 }}
            autoFocus
          />
          <button style={{ ...s.btnApprove, fontSize: 11 }} onClick={handleMark} disabled={marking}>
            Confirm
          </button>
          <button style={s.btnSmall} onClick={() => setShowUrlInput(false)}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rejected row , awaiting regeneration (read-only)
// ---------------------------------------------------------------------------

function RejectedRow({
  video,
  onRegenComplete,
}: {
  video: PendingVideo;
  onRegenComplete?: () => void;
}) {
  const notes: string[] = [];
  if (video.video_rejection_note) notes.push(`Video: ${video.video_rejection_note}`);
  if (video.thumbnail_rejection_note) notes.push(`Thumbnail: ${video.thumbnail_rejection_note}`);
  if (notes.length === 0 && video.rejection_note) notes.push(video.rejection_note);

  const [expanded, setExpanded] = useState(false);
  const [muted, setMuted] = useState(false);
  const [regenState, setRegenState] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [regenError, setRegenError] = useState<string | null>(null);
  const videoRef = React.useRef<HTMLVideoElement>(null);

  React.useEffect(() => {
    if (videoRef.current) videoRef.current.muted = muted;
  }, [muted]);

  async function handleRegenNow() {
    setRegenState('running');
    setRegenError(null);
    try {
      const result = (await ipcInvoke('empire:regenRejected')) as {
        success: boolean;
        queued: number;
        succeeded: string[];
        failed: { id: string; error: string }[];
        error?: string;
      };
      if (!result.success) {
        setRegenState('error');
        setRegenError(result.error || 'Unknown error');
      } else {
        const thisFailed = result.failed?.find((f) => f.id === video.id);
        if (thisFailed) {
          setRegenState('error');
          setRegenError(thisFailed.error);
        } else {
          setRegenState('done');
          if (onRegenComplete) onRegenComplete();
        }
      }
    } catch (e: any) {
      setRegenState('error');
      setRegenError(e.message);
    }
  }

  return (
    <div
      style={{
        ...s.card,
        borderLeft: '3px solid #7f1d1d',
        background: '#110a0a',
        padding: '12px 16px',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: 8,
        }}
      >
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#e0e0e0', marginBottom: 4 }}>
            {video.title}
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              flexWrap: 'wrap' as const,
              marginBottom: notes.length > 0 ? 6 : 0,
            }}
          >
            <ChannelBadge channel={video.channel} />
            <span
              style={{
                fontSize: 10,
                fontWeight: 700,
                textTransform: 'uppercase' as const,
                letterSpacing: '0.06em',
                color: '#fb923c',
                background: '#1c0f00',
                border: '1px solid #7c2d12',
                borderRadius: 4,
                padding: '2px 7px',
              }}
            >
              NEEDS REGEN
            </span>
          </div>
          {notes.map((note, i) => (
            <div key={i} style={{ fontSize: 11, color: '#666', fontStyle: 'italic', marginTop: 2 }}>
              {note}
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          {video.video_path && (
            <button
              style={{ ...s.btnSmall, fontSize: 11, background: expanded ? '#2d1a1a' : '#2a2a2a' }}
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? 'Hide' : '▶ Play'}
            </button>
          )}
          {regenState === 'idle' && (
            <button
              style={{ ...s.btnSmall, fontSize: 11, background: '#1a2a1a', color: '#4ade80' }}
              onClick={handleRegenNow}
            >
              Regen Now
            </button>
          )}
          {regenState === 'running' && (
            <span style={{ fontSize: 11, color: '#7a6a00', fontFamily: 'monospace' }}>
              Rebuilding…
            </span>
          )}
          {regenState === 'done' && (
            <span style={{ fontSize: 11, color: '#4ade80', fontFamily: 'monospace' }}>
              Rebuild queued
            </span>
          )}
          {regenState === 'error' && (
            <span style={{ fontSize: 11, color: '#f87171', fontFamily: 'monospace' }}>
              {regenError || 'Regen failed'}
            </span>
          )}
        </div>
      </div>
      {expanded && video.video_path && (
        <div style={{ marginTop: 12 }}>
          <ShortsPlayer src={localFileUrl(video.video_path)} />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Published video row , compact playable card with YouTube link
// ---------------------------------------------------------------------------

function PublishedRow({ video }: { video: PublishedVideo }) {
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      style={{
        ...s.card,
        borderLeft: '3px solid #14532d',
        padding: '12px 16px',
        background: '#0d1a0d',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        {/* Thumbnail */}
        {video.thumbnail_path && (
          <img
            src={localFileUrl(video.thumbnail_path)}
            alt=""
            style={{ width: 56, height: 100, objectFit: 'cover', borderRadius: 4, flexShrink: 0 }}
          />
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: '#e0e0e0',
              marginBottom: 4,
              lineHeight: 1.3,
            }}
          >
            {video.title}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' as const }}>
            <ChannelBadge channel={video.channel} />
            {video.published_date && (
              <span style={{ fontSize: 11, color: '#555' }}>{video.published_date}</span>
            )}
            <span
              style={{
                fontSize: 10,
                fontWeight: 700,
                textTransform: 'uppercase' as const,
                letterSpacing: '0.06em',
                color: '#4ade80',
                background: '#0d2d0d',
                border: '1px solid #14532d',
                borderRadius: 4,
                padding: '2px 7px',
              }}
            >
              PUBLISHED
            </span>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            {video.youtube_url && (
              <a
                href={video.youtube_url}
                target="_blank"
                rel="noreferrer"
                style={{
                  fontSize: 11,
                  color: '#4ade80',
                  textDecoration: 'none',
                  background: '#0d2d0d',
                  border: '1px solid #14532d',
                  borderRadius: 4,
                  padding: '2px 8px',
                }}
              >
                View on YouTube ↗
              </a>
            )}
            {video.video_path && (
              <button
                style={{
                  ...s.btnSmall,
                  fontSize: 11,
                  background: expanded ? '#1a2d1a' : '#2a2a2a',
                }}
                onClick={() => setExpanded((v) => !v)}
              >
                {expanded ? 'Hide Video' : '▶ Play'}
              </button>
            )}
          </div>
        </div>
      </div>
      {expanded && video.video_path && (
        <div style={{ marginTop: 12 }}>
          <ShortsPlayer src={localFileUrl(video.video_path)} />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Platform badge (X, LinkedIn)
// ---------------------------------------------------------------------------

function PlatformBadge({ platform }: { platform: SocialPost['platform'] }) {
  const isX = platform === 'x';
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: '0.04em',
        textTransform: 'uppercase' as const,
        padding: '2px 7px',
        borderRadius: 4,
        background: isX ? '#0e1b2e' : '#0e2e1b',
        color: isX ? '#60a5fa' : '#60fab4',
        border: `1px solid ${isX ? '#1e3a5f' : '#1e5f3a'}`,
      }}
    >
      {isX ? 'X' : 'LinkedIn'}
    </span>
  );
}

function toDatetimeLocalValue(value?: string): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function fromDatetimeLocalValue(value: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

// ---------------------------------------------------------------------------
// Social post card (review/approve/reject)
// ---------------------------------------------------------------------------

function SocialPostCard({
  post,
  onApprove,
  onSchedule,
  onClearSchedule,
  onReject,
  onEdit,
  onSetActiveVariant,
  onPublish,
  onExport,
  onTrash,
  onRefreshEngagement,
}: {
  post: SocialPost;
  onApprove: (id: string, scheduledFor?: string) => void;
  onSchedule: (id: string, scheduledFor: string) => void;
  onClearSchedule: (id: string) => void;
  onReject: (id: string, note: string) => void;
  onEdit: (id: string, content: string) => void;
  onSetActiveVariant: (id: string, variantId: string) => void;
  onPublish: (id: string) => void;
  onExport: (id: string) => void;
  onTrash: (id: string) => void;
  onRefreshEngagement: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState(post.content);
  const [rejecting, setRejecting] = useState(false);
  const [rejectNote, setRejectNote] = useState('');
  const [scheduleValue, setScheduleValue] = useState(toDatetimeLocalValue(post.scheduled_for));
  const [busy, setBusy] = useState(false);
  const activeVariantId = post.active_variant_id || post.variants?.find((v) => v.active)?.id;
  const charLimit = post.platform === 'x' ? 280 : 3000;
  const charCount = editContent.length;
  const overLimit = charCount > charLimit;

  useEffect(() => {
    setEditContent(post.content);
    setScheduleValue(toDatetimeLocalValue(post.scheduled_for));
  }, [post.content, post.scheduled_for]);

  async function handleSaveEdit() {
    setBusy(true);
    await onEdit(post.id, editContent);
    setEditing(false);
    setBusy(false);
  }

  async function handleApprove() {
    setBusy(true);
    await onApprove(post.id);
    setBusy(false);
  }

  async function handleApproveScheduled() {
    const scheduledFor = fromDatetimeLocalValue(scheduleValue);
    if (!scheduledFor) return;
    setBusy(true);
    await onApprove(post.id, scheduledFor);
    setBusy(false);
  }

  async function handleSchedule() {
    const scheduledFor = fromDatetimeLocalValue(scheduleValue);
    if (!scheduledFor) return;
    setBusy(true);
    await onSchedule(post.id, scheduledFor);
    setBusy(false);
  }

  async function handleClearSchedule() {
    setBusy(true);
    await onClearSchedule(post.id);
    setScheduleValue('');
    setBusy(false);
  }

  async function handleRejectConfirm() {
    setBusy(true);
    await onReject(post.id, rejectNote.trim());
    setRejecting(false);
    setRejectNote('');
    setBusy(false);
  }

  async function handlePublish() {
    setBusy(true);
    await onPublish(post.id);
    setBusy(false);
  }

  async function handleExport() {
    setBusy(true);
    await onExport(post.id);
    setBusy(false);
  }

  async function handleCopy() {
    await navigator.clipboard?.writeText(post.content);
  }

  async function handleVariantChange(variantId: string) {
    setBusy(true);
    await onSetActiveVariant(post.id, variantId);
    const variant = post.variants?.find((v) => v.id === variantId);
    if (variant) setEditContent(variant.content);
    setBusy(false);
  }

  const isPending = post.status === 'pending_approval' || post.status === 'draft';
  const isApproved = post.status === 'approved';
  const isPosted = post.status === 'posted';
  const isRejected = post.status === 'rejected';
  const isLinkedIn = post.platform === 'linkedin';

  return (
    <div
      style={{
        ...s.card,
        borderLeft: `3px solid ${isPosted ? '#166534' : isRejected ? '#7f1d1d' : isApproved ? '#1e3a5f' : '#1e1e1e'}`,
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <PlatformBadge platform={post.platform} />
        <span style={s.meta}>
          {new Date(post.created_at).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
          })}
        </span>
          {isPosted && post.posted_at && (
            <span style={{ ...s.meta, color: '#4ade80' }}>
            {post.exported_at ? 'Exported' : 'Posted'}{' '}
            {new Date(post.posted_at).toLocaleDateString('en-US', {
              month: 'short',
              day: 'numeric',
            })}
          </span>
        )}
        {isApproved && post.scheduled_for && (
          <span style={{ ...s.meta, color: '#facc15' }}>
            Scheduled {new Date(post.scheduled_for).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
          </span>
        )}
        {isApproved && !post.scheduled_for && (
          <span style={{ ...s.meta, color: '#60a5fa' }}>Ready to publish</span>
        )}
      </div>

      {isPending && (post.variants?.length ?? 0) > 1 && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
          <span style={s.meta}>Variant</span>
          <select
            value={activeVariantId}
            onChange={(e) => handleVariantChange(e.target.value)}
            disabled={busy}
            style={{ ...s.input, width: 'auto', padding: '5px 8px' }}
          >
            {post.variants?.map((variant, index) => (
              <option key={variant.id} value={variant.id}>
                {index + 1} · {variant.source}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Content */}
      {editing ? (
        <div>
          <textarea
            value={editContent}
            onChange={(e) => setEditContent(e.target.value)}
            style={{
              ...s.input,
              height: 100,
              resize: 'vertical',
              fontFamily: 'inherit',
            }}
            autoFocus
          />
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginTop: 6,
            }}
          >
            <span style={{ fontSize: 11, color: overLimit ? '#f87171' : '#555' }}>
              {charCount}/{charLimit}
            </span>
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                style={{ ...s.btnApprove, fontSize: 11 }}
                disabled={busy || overLimit}
                onClick={handleSaveEdit}
              >
                Save
              </button>
              <button
                style={s.btnSmall}
                onClick={() => {
                  setEditing(false);
                  setEditContent(post.content);
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div
          style={{
            fontSize: 13,
            color: '#ccc',
            lineHeight: 1.5,
            whiteSpace: 'pre-wrap',
            background: '#0f0f0f',
            borderRadius: 6,
            padding: 12,
            marginBottom: 8,
            cursor: isPending ? 'pointer' : 'default',
            border: '1px solid #1a1a1a',
          }}
          onClick={isPending ? () => setEditing(true) : undefined}
          title={isPending ? 'Click to edit' : undefined}
        >
          {post.content}
          {isPending && (
            <span style={{ fontSize: 10, color: '#444', display: 'block', marginTop: 6 }}>
              Click to edit
            </span>
          )}
        </div>
      )}

      {/* Source idea */}
      {post.source_idea && (
        <details style={{ marginBottom: 8 }}>
          <summary style={{ fontSize: 11, color: '#555', cursor: 'pointer' }}>Source idea</summary>
          <div
            style={{
              fontSize: 12,
              color: '#666',
              marginTop: 4,
              padding: 8,
              background: '#0a0a0a',
              borderRadius: 4,
              fontStyle: 'italic',
            }}
          >
            {post.source_idea}
          </div>
        </details>
      )}

      {(post.media_validation?.length ?? post.media_paths?.length ?? 0) > 0 && (
        <div style={{ marginBottom: 8 }}>
          {(post.media_validation ?? post.media_paths?.map((p) => ({
            path: p,
            exists: true,
            kind: 'file' as const,
            file_name: p.split(/[\\/]/).pop() || p,
          })) ?? []).map((media) => (
            <div
              key={media.path}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                marginTop: 6,
                padding: 8,
                borderRadius: 4,
                background: '#0a0a0a',
                border: `1px solid ${media.warning ? '#3a1a1a' : '#1a1a1a'}`,
              }}
            >
              {media.exists && media.kind === 'image' && (
                <img
                  src={localFileUrl(media.path)}
                  alt={media.file_name}
                  style={{ width: 56, height: 40, objectFit: 'cover', borderRadius: 4 }}
                />
              )}
              {media.exists && media.kind === 'video' && (
                <video
                  src={localFileUrl(media.path)}
                  style={{ width: 56, height: 40, objectFit: 'cover', borderRadius: 4 }}
                  muted
                />
              )}
              <span style={{ fontSize: 12, color: media.warning ? '#f87171' : '#888' }}>
                {media.file_name}{media.warning ? ` · ${media.warning}` : ''}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Rejection note */}
      {isRejected && post.rejection_note && (
        <div
          style={{
            fontSize: 12,
            color: '#f87171',
            background: '#1a0a0a',
            borderRadius: 4,
            padding: 8,
            marginBottom: 8,
            border: '1px solid #2a1010',
          }}
        >
          Rejected: {post.rejection_note}
        </div>
      )}

      {(post.learnings?.length ?? 0) > 0 && (
        <div
          style={{
            fontSize: 12,
            color: '#a3e635',
            background: '#0d1a0a',
            borderRadius: 4,
            padding: 8,
            marginBottom: 8,
            border: '1px solid #1f3a10',
          }}
        >
          Learnings: {post.learnings!.slice(-2).map((learning) =>
            learning.type === 'rejection'
              ? learning.note
              : `Engagement snapshot captured ${new Date(learning.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`,
          ).join(' · ')}
        </div>
      )}

      {/* Engagement metrics */}
      {isPosted && post.engagement && (
        <div
          style={{
            display: 'flex',
            gap: 16,
            marginBottom: 8,
            fontSize: 12,
            color: '#888',
          }}
        >
          <span>{(post.engagement.views ?? 0).toLocaleString()} views</span>
          <span>{(post.engagement.likes ?? 0).toLocaleString()} likes</span>
          <span>{(post.engagement.retweets ?? 0).toLocaleString()} retweets</span>
          <span>{(post.engagement.replies ?? 0).toLocaleString()} replies</span>
          {post.engagement.last_checked && (
            <span style={{ color: '#444' }}>
              checked{' '}
              {new Date(post.engagement.last_checked).toLocaleTimeString('en-US', {
                hour: 'numeric',
                minute: '2-digit',
              })}
            </span>
          )}
        </div>
      )}

      {/* Action buttons */}
      {!editing && !rejecting && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {isPending && (
            <>
              <button style={s.btnApprove} disabled={busy} onClick={handleApprove}>
                Approve
              </button>
              <input
                type="datetime-local"
                value={scheduleValue}
                onChange={(e) => setScheduleValue(e.target.value)}
                style={{ ...s.input, width: 180, padding: '5px 8px', fontSize: 11 }}
              />
              <button
                style={s.btnSmall}
                disabled={busy || !scheduleValue}
                onClick={handleApproveScheduled}
              >
                Approve Scheduled
              </button>
              <button style={{ ...s.btnSmall }} onClick={() => setEditing(true)}>
                Edit
              </button>
              <button style={s.btnReject} disabled={busy} onClick={() => setRejecting(true)}>
                Reject
              </button>
              <button
                style={{ ...s.btnSmall, color: '#666' }}
                disabled={busy}
                onClick={() => onTrash(post.id)}
              >
                Trash
              </button>
            </>
          )}
          {isApproved && (
            <>
              <input
                type="datetime-local"
                value={scheduleValue}
                onChange={(e) => setScheduleValue(e.target.value)}
                style={{ ...s.input, width: 180, padding: '5px 8px', fontSize: 11 }}
              />
              <button style={s.btnSmall} disabled={busy || !scheduleValue} onClick={handleSchedule}>
                {post.scheduled_for ? 'Reschedule' : 'Schedule'}
              </button>
              {post.scheduled_for && (
                <button style={s.btnSmall} disabled={busy} onClick={handleClearSchedule}>
                  Clear Schedule
                </button>
              )}
              {isLinkedIn ? (
                <>
                  <button style={s.btnSmall} disabled={busy} onClick={handleCopy}>
                    Copy Text
                  </button>
                  <button
                    style={{
                      ...s.btnApprove,
                      background: '#0e2e1b',
                      color: '#60fab4',
                      borderColor: '#1e5f3a',
                    }}
                    disabled={busy}
                    onClick={handleExport}
                  >
                    Mark Exported
                  </button>
                </>
              ) : (
                <button
                  style={{
                    ...s.btnApprove,
                    background: '#0e1b2e',
                    color: '#60a5fa',
                    borderColor: '#1e3a5f',
                  }}
                  disabled={busy}
                  onClick={handlePublish}
                >
                  Publish Now
                </button>
              )}
            </>
          )}
          {isPosted && isLinkedIn && (
            <>
              <button style={s.btnSmall} disabled={busy} onClick={handleCopy}>
                Copy Text
              </button>
              <span style={{ ...s.meta, color: '#60fab4' }}>LinkedIn export prepared</span>
            </>
          )}
          {isPosted && post.post_url && !isLinkedIn && (
            <>
              <a
                href={post.post_url}
                target="_blank"
                rel="noopener noreferrer"
                style={{ ...s.btnLink, fontSize: 12 }}
              >
                View on X
              </a>
              <button
                style={s.btnSmall}
                onClick={() => onRefreshEngagement(post.id)}
                disabled={busy}
              >
                Refresh Stats
              </button>
            </>
          )}
        </div>
      )}

      {(post.history?.length ?? 0) > 0 && (
        <details style={{ marginTop: 10 }}>
          <summary style={{ fontSize: 11, color: '#555', cursor: 'pointer' }}>History</summary>
          <div style={{ marginTop: 6, display: 'grid', gap: 4 }}>
            {post.history!.slice(-8).map((entry) => (
              <div key={entry.id} style={{ fontSize: 11, color: '#666' }}>
                {entry.type} · {new Date(entry.at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                {entry.note ? ` · ${entry.note}` : ''}
              </div>
            ))}
          </div>
        </details>
      )}

      {/* Reject panel */}
      {rejecting && (
        <div style={{ marginTop: 8 }}>
          <input
            type="text"
            placeholder="Why reject? (blank = trash)"
            value={rejectNote}
            onChange={(e) => setRejectNote(e.target.value)}
            style={s.input}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleRejectConfirm();
              if (e.key === 'Escape') setRejecting(false);
            }}
          />
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <button style={{ ...s.btnReject, fontSize: 11 }} onClick={handleRejectConfirm}>
              {rejectNote.trim() ? 'Reject with Feedback' : 'Trash It'}
            </button>
            <button style={s.btnSmall} onClick={() => setRejecting(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Social Posts tab content
// ---------------------------------------------------------------------------

function SocialPostsTab() {
  const [posts, setPosts] = useState<SocialPost[]>([]);
  const [loading, setLoading] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    loadPosts();
    intervalRef.current = setInterval(loadPosts, 30_000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  async function loadPosts() {
    try {
      const result = (await ipcInvoke('social:getPosts')) as SocialPost[] | null;
      if (result && Array.isArray(result)) setPosts(result);
    } catch {
      /* best-effort */
    } finally {
      setLoading(false);
    }
  }

  async function handleApprove(id: string, scheduledFor?: string) {
    const result = (await ipcInvoke('social:approvePost', id, scheduledFor)) as any;
    if (result?.post) {
      setPosts((prev) => prev.map((p) => (p.id === id ? result.post : p)));
      return;
    }
    setPosts((prev) =>
      prev.map((p) =>
        p.id === id
          ? {
              ...p,
              status: 'approved',
              approved_at: new Date().toISOString(),
              scheduled_for: scheduledFor,
            }
          : p,
      ),
    );
  }

  async function handleSchedule(id: string, scheduledFor: string) {
    const result = (await ipcInvoke('social:schedulePost', id, scheduledFor)) as any;
    setPosts((prev) =>
      prev.map((p) =>
        p.id === id ? result?.post ?? { ...p, status: 'approved', scheduled_for: scheduledFor } : p,
      ),
    );
  }

  async function handleClearSchedule(id: string) {
    const result = (await ipcInvoke('social:clearSchedule', id)) as any;
    setPosts((prev) =>
      prev.map((p) =>
        p.id === id ? result?.post ?? { ...p, scheduled_for: undefined } : p,
      ),
    );
  }

  async function handleReject(id: string, note: string) {
    const result = (await ipcInvoke('social:rejectPost', id, note)) as any;
    if (!note) {
      setPosts((prev) => prev.filter((p) => p.id !== id));
    } else {
      setPosts((prev) =>
        prev.map((p) =>
          p.id === id ? result?.post ?? { ...p, status: 'rejected', rejection_note: note } : p,
        ),
      );
    }
  }

  async function handleEdit(id: string, content: string) {
    const result = (await ipcInvoke('social:editPost', id, content)) as any;
    setPosts((prev) => prev.map((p) => (p.id === id ? result?.post ?? { ...p, content } : p)));
  }

  async function handleSetActiveVariant(id: string, variantId: string) {
    const result = (await ipcInvoke('social:setActiveVariant', id, variantId)) as any;
    setPosts((prev) => prev.map((p) => (p.id === id ? result?.post ?? p : p)));
  }

  async function handlePublish(id: string) {
    const result = (await ipcInvoke('social:publishPost', id)) as any;
    if (result?.success) {
      setPosts((prev) =>
        prev.map((p) =>
          p.id === id
            ? {
                ...p,
                status: 'posted',
                posted_at: new Date().toISOString(),
                post_url: result.postUrl,
              }
            : p,
        ),
      );
    }
  }

  async function handleExport(id: string) {
    const result = (await ipcInvoke('social:exportPost', id)) as any;
    if (result?.success) {
      setPosts((prev) =>
        prev.map((p) =>
          p.id === id
            ? result.post ?? { ...p, status: 'posted', exported_at: new Date().toISOString() }
            : p,
        ),
      );
    }
  }

  async function handleTrash(id: string) {
    await ipcInvoke('social:trashPost', id);
    setPosts((prev) => prev.filter((p) => p.id !== id));
  }

  async function handleRefreshEngagement(id: string) {
    const result = (await ipcInvoke('social:refreshEngagement', id)) as any;
    if (result?.success) {
      setPosts((prev) =>
        prev.map((p) => (p.id === id ? { ...p, engagement: result.engagement } : p)),
      );
    }
  }

  const pending = posts.filter((p) => p.status === 'pending_approval' || p.status === 'draft');
  const scheduled = posts.filter((p) => p.status === 'approved' && p.scheduled_for);
  const ready = posts.filter((p) => p.status === 'approved' && !p.scheduled_for);
  const posted = posts
    .filter((p) => p.status === 'posted')
    .sort((a, b) => (b.posted_at ?? '').localeCompare(a.posted_at ?? ''));
  const rejected = posts.filter((p) => p.status === 'rejected');

  const renderSection = (title: string, items: SocialPost[], emptyMsg: string) => (
    <div style={{ marginBottom: 32 }}>
      <div style={s.sectionTitle}>
        {title} ({items.length})
      </div>
      {items.length === 0 ? (
        <div style={{ fontSize: 13, color: '#444' }}>{emptyMsg}</div>
      ) : (
        items.map((p) => (
          <SocialPostCard
            key={p.id}
            post={p}
            onApprove={handleApprove}
            onSchedule={handleSchedule}
            onClearSchedule={handleClearSchedule}
            onReject={handleReject}
            onEdit={handleEdit}
            onSetActiveVariant={handleSetActiveVariant}
            onPublish={handlePublish}
            onExport={handleExport}
            onTrash={handleTrash}
            onRefreshEngagement={handleRefreshEngagement}
          />
        ))
      )}
    </div>
  );

  return (
    <div>
      {loading && <div style={{ fontSize: 13, color: '#555' }}>Loading...</div>}
      {renderSection(
        'Pending Review',
        pending,
        'No posts pending review. Amy will queue drafts here for your approval.',
      )}
      {renderSection('Scheduled', scheduled, 'No scheduled posts waiting.')}
      {renderSection('Ready to Publish', ready, 'No approved posts waiting.')}
      {renderSection('Posted / Exported', posted, 'No posts published or exported yet.')}
      {rejected.length > 0 && renderSection('Rejected', rejected, '')}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page (tabbed: YouTube Videos | Social Posts)
// ---------------------------------------------------------------------------

type ContentTab = 'videos' | 'social';

function YouTubeVideosTab() {
  const [videos, setVideos] = useState<PendingVideo[]>([]);
  const [published, setPublished] = useState<PublishedVideo[]>([]);
  const [loading, setLoading] = useState(true);
  const [usingDemo, setUsingDemo] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [syncState, setSyncState] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
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
      const result = (await ipcInvoke('empire:getPendingVideos')) as
        | PendingVideo[]
        | null
        | undefined;
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
    // Load historical published videos from OpenClaw
    try {
      const pub = (await ipcInvoke('empire:getPublishedVideos')) as PublishedVideo[] | null;
      if (pub && Array.isArray(pub)) setPublished(pub);
    } catch {
      /* best-effort */
    }
  }

  async function handleSyncFromEC2() {
    setSyncState('running');
    setSyncMsg(null);
    try {
      const result = (await ipcInvoke('empire:syncFromEC2')) as {
        success: boolean;
        stdout?: string;
        error?: string;
      };
      if (result.success) {
        setSyncState('done');
        const match = result.stdout?.match(/(\d+) new videos? synced/);
        setSyncMsg(match ? match[0] : 'Sync complete');
        await load();
      } else {
        setSyncState('error');
        setSyncMsg(result.error || 'Sync failed');
      }
    } catch (e: any) {
      setSyncState('error');
      setSyncMsg(e.message);
    }
    setTimeout(() => setSyncState('idle'), 6000);
  }

  async function handleApprove(id: string) {
    try {
      await ipcInvoke('empire:approveVideo', id);
    } catch {
      /* IPC not wired yet , update local state only */
    }
    setVideos((prev) => prev.map((v) => (v.id === id ? { ...v, status: 'approved' } : v)));
    // Auto-advance: keep activeIndex pointed at next pending video
    setActiveIndex((i) => {
      const newPending = videos.filter((v) => v.status === 'pending_approval' && v.id !== id);
      return Math.min(i, Math.max(0, newPending.length - 1));
    });
  }

  async function handleReject(id: string, target: RejectTarget | 'both', note: string) {
    const video = videos.find((v) => v.id === id);
    try {
      await ipcInvoke('empire:rejectVideo', id, target, note);
    } catch {
      /* IPC not wired yet , update local state only */
    }
    // RSL: fire-and-forget , classify feedback, update rubric, append LEARNINGS.md
    if (note && video) {
      ipcInvoke('empire:processRejectionLearning', {
        videoId: id,
        videoTitle: video.title,
        channel: video.channel,
        target,
        note,
      }).catch(() => {
        /* best-effort */
      });
    }
    if (!note) {
      setVideos((prev) => prev.filter((v) => v.id !== id));
    } else {
      setVideos((prev) =>
        prev.map((v) =>
          v.id === id ? { ...v, status: 'rejected', rejection_note: `[${target}] ${note}` } : v,
        ),
      );
    }
    // Auto-advance after reject
    setActiveIndex((i) => {
      const newPending = videos.filter((v) => v.status === 'pending_approval' && v.id !== id);
      return Math.min(i, Math.max(0, newPending.length - 1));
    });
  }

  const pending = videos.filter((v) => v.status === 'pending_approval');
  // Posted videos (upload_status="posted") move to Published section; other approved go to Upload Queue
  const uploadQueue = videos.filter((v) => v.status === 'approved' && v.upload_status !== 'posted');
  const postedFromQueue: PublishedVideo[] = videos
    .filter((v) => v.status === 'approved' && v.upload_status === 'posted')
    .map((v) => ({
      id: v.id,
      title: v.title,
      channel: v.channel,
      youtube_url: v.youtube_url,
      published_date: v.generated_date,
      video_path: v.video_path ?? undefined,
      thumbnail_path: v.thumbnail_path ?? undefined,
    }));
  // Merge: queue-posted first (most recent), then historical (dedupe by id)
  const publishedIds = new Set(postedFromQueue.map((v) => v.id));
  const allPublished: PublishedVideo[] = [
    ...postedFromQueue,
    ...published.filter((v) => !publishedIds.has(v.id)),
  ].sort((a, b) => (b.published_date ?? '').localeCompare(a.published_date ?? ''));
  const rejected = videos.filter(
    (v) =>
      v.status === 'video_rejected' ||
      v.status === 'thumbnail_rejected' ||
      v.status === 'rejected' ||
      v.status === 'regen_queued' ||
      v.status === 'trashed',
  );

  // Clamp activeIndex in case videos list shrinks
  const clampedIndex = Math.min(activeIndex, Math.max(0, pending.length - 1));
  const activeVideo = pending[clampedIndex] ?? null;

  return (
    <div>
      <div style={{ ...s.subtitle, marginBottom: 16 }}>
        {loading
          ? 'Loading...'
          : `${pending.length} video${pending.length !== 1 ? 's' : ''} pending review${usingDemo ? ' , demo data' : ''}`}
      </div>

      {/* Pending Review */}
      <div style={{ marginBottom: 32 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 12,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={s.sectionTitle}>
              Pending Review ({pending.length})
              {pending.length > 0 && (
                <span style={{ fontWeight: 400, color: '#444', marginLeft: 8 }}>
                  {clampedIndex + 1} of {pending.length}
                </span>
              )}
            </div>
            <button
              style={{
                ...s.btnSmall,
                fontSize: 11,
                background: syncState === 'running' ? '#1a1a2a' : '#1a2a1a',
                color:
                  syncState === 'error' ? '#f87171' : syncState === 'done' ? '#4ade80' : '#7dd3fc',
                opacity: syncState === 'running' ? 0.7 : 1,
              }}
              disabled={syncState === 'running'}
              onClick={handleSyncFromEC2}
              title="Pull new built videos from EC2"
            >
              {syncState === 'running'
                ? 'Syncing…'
                : syncState === 'done'
                  ? syncMsg || 'Synced'
                  : syncState === 'error'
                    ? syncMsg || 'Error'
                    : '↓ Sync EC2'}
            </button>
          </div>
          {pending.length > 1 && (
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                style={{
                  ...s.btnSmall,
                  opacity: clampedIndex === 0 ? 0.35 : 1,
                  cursor: clampedIndex === 0 ? 'default' : 'pointer',
                }}
                disabled={clampedIndex === 0}
                onClick={() => setActiveIndex((i) => Math.max(0, i - 1))}
              >
                ← Previous
              </button>
              <button
                style={{
                  ...s.btnSmall,
                  opacity: clampedIndex >= pending.length - 1 ? 0.35 : 1,
                  cursor: clampedIndex >= pending.length - 1 ? 'default' : 'pointer',
                }}
                disabled={clampedIndex >= pending.length - 1}
                onClick={() => setActiveIndex((i) => Math.min(pending.length - 1, i + 1))}
              >
                Next →
              </button>
            </div>
          )}
        </div>

        {!loading && pending.length === 0 && (
          <div style={{ fontSize: 13, color: '#444' }}>No videos pending review.</div>
        )}
        {activeVideo && (
          <VideoCard
            key={activeVideo.id}
            video={activeVideo}
            onApprove={handleApprove}
            onReject={(id, target, note) => handleReject(id, target, note)}
          />
        )}
      </div>

      {/* Upload Queue */}
      <div>
        <div style={s.sectionTitle}>Upload Queue ({uploadQueue.length})</div>
        {uploadQueue.length === 0 ? (
          <div style={{ fontSize: 13, color: '#444' }}>
            No approved videos queued. Approve a video above to schedule it.
          </div>
        ) : (
          uploadQueue.map((v) => (
            <UploadRow
              key={v.id}
              video={v}
              nextUpload={nextUpload}
              onMarkUploaded={(id) =>
                setVideos((prev) =>
                  prev.map((p) => (p.id === id ? { ...p, upload_status: 'posted' } : p)),
                )
              }
              onReject={async (id, target, note) => {
                await ipcInvoke('empire:rejectUploadedVideo', id, note);
                setVideos((prev) =>
                  prev.map((p) =>
                    p.id === id
                      ? {
                          ...p,
                          status: 'video_rejected',
                          video_rejection_note: note,
                          video_needs_regen: true,
                        }
                      : p,
                  ),
                );
              }}
            />
          ))
        )}
      </div>

      {/* Rejected */}
      {rejected.length > 0 && (
        <div style={{ marginTop: 32 }}>
          <div style={s.sectionTitle}>Rejected , Awaiting Regeneration ({rejected.length})</div>
          {rejected.map((v) => (
            <RejectedRow key={v.id} video={v} />
          ))}
        </div>
      )}

      {/* Published */}
      <div style={{ marginTop: 32 }}>
        <div style={s.sectionTitle}>Published ({allPublished.length})</div>
        {allPublished.length === 0 ? (
          <div style={{ fontSize: 13, color: '#444' }}>No published videos yet.</div>
        ) : (
          allPublished.map((v) => <PublishedRow key={v.id} video={v} />)
        )}
      </div>
    </div>
  );
}

export default function ContentPipeline() {
  const [activeTab, setActiveTab] = useState<ContentTab>(
    () => (localStorage.getItem('contentPipelineTab') as ContentTab) || 'social',
  );

  function switchTab(tab: ContentTab) {
    setActiveTab(tab);
    localStorage.setItem('contentPipelineTab', tab);
  }

  return (
    <div style={s.page}>
      <div style={s.title}>Content Pipeline</div>

      {/* Tab switcher */}
      <div
        style={{
          display: 'flex',
          gap: 0,
          marginBottom: 20,
          borderBottom: '1px solid #222',
        }}
      >
        {(
          [
            { id: 'social' as ContentTab, label: 'Social Posts' },
            { id: 'videos' as ContentTab, label: 'YouTube Videos' },
          ] as const
        ).map((tab) => (
          <button
            key={tab.id}
            onClick={() => switchTab(tab.id)}
            style={{
              padding: '8px 18px',
              fontSize: 13,
              fontWeight: activeTab === tab.id ? 600 : 400,
              color: activeTab === tab.id ? '#fff' : '#555',
              background: 'none',
              border: 'none',
              borderBottom: activeTab === tab.id ? '2px solid #7c3aed' : '2px solid transparent',
              cursor: 'pointer',
              transition: 'color 0.15s, border-color 0.15s',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'social' && <SocialPostsTab />}
      {activeTab === 'videos' && <YouTubeVideosTab />}
    </div>
  );
}
