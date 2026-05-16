import React, { useState, useEffect, useRef } from 'react';

// ─── Types ──────────────────────────────────────────────────────────────

interface TmStatus {
  running: boolean;
  paused: boolean;
  captureCount: number;
  lastCaptureAt: string | null;
  audioRecording: boolean;
  conversationsToday: number;
  privacyActive: boolean;
  privacyReason: string | null;
  privacySkipCount: number;
}

interface TmConfig {
  enabled: boolean;
  captureIntervalMs: number;
  screenshotQuality: number;
  captureAudio: boolean;
  captureMic: boolean;
  captureSystemAudio: boolean;
  retentionScreenshotDays: number;
  retentionAudioDays: number;
  silenceThresholdSeconds: number;
  s3Bucket: string;
  s3Prefix: string;
  privacy: {
    zones: { id: string; label: string; x: number; y: number; width: number; height: number; enabled: boolean }[];
    pauseSchedules: { id: string; label: string; days: number[]; startTime: string; endTime: string; enabled: boolean }[];
    excludedApps: string[];
    excludedTitlePatterns: string[];
    excludedDomains: string[];
  };
  dedupe: {
    enabled: boolean;
    sizeDriftThreshold: number;
    chunkBytes: number;
    recentWindowSize: number;
  };
  clustering: {
    idleGapMinutes: number;
    topTermCount: number;
  };
}

interface TmFrame {
  id: number;
  timestamp: string;
  ocr_text: string;
  s3_key: string | null;
  local_path: string | null;
  file_size: number;
}

interface TmSearchResult {
  type: 'screenshot' | 'audio';
  timestamp: string;
  text: string;
  s3_key?: string;
  local_path?: string;
}

interface TmStats {
  totalFrames: number;
  totalAudioSegments: number;
  totalConversations: number;
  todayFrames: number;
  todayConversations: number;
}

interface TmForecast {
  averageScreenshotBytes: number;
  screenshotsPerDay: number;
  estimatedScreenshotRetentionBytes: number;
  existingLocalScreenshotBytes: number;
  existingLocalAudioBytes: number;
  estimatedRetainedTotalBytes: number;
}

interface TmCluster {
  id: string;
  start: string;
  end: string;
  frameCount: number;
  representativeFrame: TmFrame | null;
  topOcrTerms: string[];
  frames?: TmFrame[];
}

type Tab = 'timeline' | 'search' | 'settings';
type TimelineView = 'frames' | 'clusters';

// ─── Time Ranges ────────────────────────────────────────────────────────

const TIME_RANGES = [
  { label: '30s', ms: 30_000 },
  { label: '1m', ms: 60_000 },
  { label: '5m', ms: 5 * 60_000 },
  { label: '15m', ms: 15 * 60_000 },
  { label: '30m', ms: 30 * 60_000 },
  { label: '1h', ms: 60 * 60_000 },
  { label: '5h', ms: 5 * 60 * 60_000 },
  { label: '1d', ms: 24 * 60 * 60_000 },
  { label: '5d', ms: 5 * 24 * 60 * 60_000 },
  { label: '30d', ms: 30 * 24 * 60 * 60_000 },
];

// ─── Styles ─────────────────────────────────────────────────────────────

const S = {
  container: {
    display: 'flex',
    flexDirection: 'column' as const,
    height: '100%',
    background: '#0f0f0f',
    color: '#e0e0e0',
    overflow: 'hidden',
  },
  header: {
    padding: '16px 24px',
    borderBottom: '1px solid #1e1e1e',
    display: 'flex',
    alignItems: 'center',
    gap: 16,
  },
  title: { fontSize: 18, fontWeight: 700, color: '#fff', flex: 1 },
  tabs: { display: 'flex', gap: 4, padding: '0 24px', borderBottom: '1px solid #1e1e1e' },
  tab: (active: boolean) => ({
    padding: '10px 16px',
    fontSize: 13,
    fontWeight: active ? 600 : 400,
    color: active ? '#e0e0e0' : '#666',
    background: 'none',
    border: 'none',
    borderBottom: `2px solid ${active ? '#7c3aed' : 'transparent'}`,
    cursor: 'pointer',
  }),
  body: { flex: 1, overflow: 'auto', padding: 24 },
  card: {
    background: '#161616',
    borderRadius: 8,
    border: '1px solid #222',
    padding: 20,
    marginBottom: 16,
  },
  label: { fontSize: 12, color: '#888', marginBottom: 6, display: 'block' as const },
  input: {
    background: '#111',
    border: '1px solid #333',
    borderRadius: 4,
    padding: '8px 12px',
    color: '#e0e0e0',
    fontSize: 13,
    width: '100%',
  },
  btn: (color: string, size: 'sm' | 'md' = 'md') => ({
    background: color,
    border: 'none',
    borderRadius: 6,
    color: '#fff',
    cursor: 'pointer',
    fontWeight: 600,
    fontSize: size === 'md' ? 13 : 12,
    padding: size === 'md' ? '8px 16px' : '6px 12px',
  }),
  dot: (on: boolean) => ({
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: on ? '#22c55e' : '#ef4444',
    display: 'inline-block',
    marginRight: 8,
  }),
  rangeBtn: (active: boolean) => ({
    background: active ? '#7c3aed' : '#222',
    border: '1px solid ' + (active ? '#7c3aed' : '#333'),
    borderRadius: 4,
    padding: '4px 10px',
    color: active ? '#fff' : '#888',
    cursor: 'pointer',
    fontSize: 11,
    fontWeight: 600,
  }),
  thumbnail: (selected: boolean) => ({
    width: 120,
    height: 68,
    borderRadius: 4,
    objectFit: 'cover' as const,
    cursor: 'pointer',
    border: `2px solid ${selected ? '#7c3aed' : '#222'}`,
    flexShrink: 0,
    background: '#111',
  }),
  ocrPanel: {
    background: '#111',
    borderRadius: 6,
    padding: 16,
    fontSize: 12,
    color: '#aaa',
    maxHeight: 300,
    overflow: 'auto',
    whiteSpace: 'pre-wrap' as const,
    lineHeight: 1.6,
  },
};

// ─── Component ──────────────────────────────────────────────────────────

// Persistent thumbnail cache across re-renders (survives state resets)
const thumbCache: Record<number, string> = {};

export default function TimeMachine() {
  const [tab, setTab] = useState<Tab>('timeline');
  const [status, setStatus] = useState<TmStatus | null>(null);
  const [config, setConfig] = useState<TmConfig | null>(null);
  const [stats, setStats] = useState<TmStats | null>(null);
  const [forecast, setForecast] = useState<TmForecast | null>(null);
  const [frames, setFrames] = useState<TmFrame[]>([]);
  const [clusters, setClusters] = useState<TmCluster[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(-1); // index into frames[]
  const [timelineView, setTimelineView] = useState<TimelineView>('frames');
  const [fullScreenUrl, setFullScreenUrl] = useState<string | null>(null);
  const [thumbUrls, setThumbUrls] = useState<Record<number, string>>(thumbCache);
  const [stepSize, setStepSize] = useState(TIME_RANGES[4]); // controls arrow step
  const [viewAnchor, setViewAnchor] = useState(Date.now()); // right edge of timeline
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<TmSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const searchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stripRef = useRef<HTMLDivElement>(null);

  const selectedFrame =
    selectedIdx >= 0 && selectedIdx < frames.length ? frames[selectedIdx] : null;

  useEffect(() => {
    loadAll();
    pollRef.current = setInterval(refreshStatus, 5000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  // Reload frames when anchor changes
  useEffect(() => {
    loadFrames();
  }, [viewAnchor]);

  // Load thumbnails in parallel batches when frames change
  useEffect(() => {
    loadThumbnailsBatch();
  }, [frames]);

  // Keyboard: Esc closes fullscreen, arrows navigate
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setFullScreenUrl(null);
        return;
      }
      if (fullScreenUrl) {
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          navigateFrame(1);
        }
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          navigateFrame(-1);
        }
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullScreenUrl, selectedIdx, frames]);

  // ── Thumbnail loading , parallel batch ────────────────────────────────

  async function loadThumbnailsBatch() {
    const visible = frames.slice(0, 50);
    const toLoad = visible.filter((f) => !thumbCache[f.id] && (f.local_path || f.s3_key));
    if (toLoad.length === 0) return;

    // Fire all requests in parallel (max 8 concurrent)
    const batchSize = 8;
    for (let i = 0; i < toLoad.length; i += batchSize) {
      const batch = toLoad.slice(i, i + batchSize);
      await Promise.all(
        batch.map(async (frame) => {
          try {
            const result = await window.api.timemachine.screenshot(frame.local_path, frame.s3_key);
            if (result.success) {
              const url = result.dataUrl || result.url || '';
              thumbCache[frame.id] = url;
              setThumbUrls((prev) => ({ ...prev, [frame.id]: url }));
            }
          } catch {}
        }),
      );
    }
  }

  // ── Full-screen navigation ────────────────────────────────────────────

  async function openFullScreen(idx: number) {
    setSelectedIdx(idx);
    const frame = frames[idx];
    if (!frame) return;
    // Use cached thumbnail first for instant display, then load full-res
    if (thumbCache[frame.id]) setFullScreenUrl(thumbCache[frame.id]);
    try {
      const result = await window.api.timemachine.screenshot(frame.local_path, frame.s3_key);
      if (result.success) setFullScreenUrl(result.dataUrl || result.url || null);
    } catch {}
  }

  async function navigateFrame(delta: number) {
    const newIdx = Math.max(0, Math.min(frames.length - 1, selectedIdx + delta));
    if (newIdx === selectedIdx) return;
    await openFullScreen(newIdx);
  }

  // ── Timeline navigation (step-based) ──────────────────────────────────

  function stepBack() {
    setViewAnchor((prev) => prev - stepSize.ms);
  }
  function stepForward() {
    setViewAnchor(Math.min(Date.now(), viewAnchor + stepSize.ms));
  }
  function jumpToNow() {
    setViewAnchor(Date.now());
  }

  // ── Data loading ──────────────────────────────────────────────────────

  async function loadAll() {
    try {
      setStatus(await window.api.timemachine.status());
    } catch {}
    try {
      setConfig(await window.api.timemachine.config.get());
    } catch {}
    try {
      setStats(await window.api.timemachine.stats());
    } catch {}
    try {
      setForecast(await window.api.timemachine.forecast());
    } catch {}
    loadFrames();
  }

  async function refreshStatus() {
    try {
      setStatus(await window.api.timemachine.status());
    } catch {}
  }

  async function loadFrames() {
    // Load a window of frames around the anchor (2x step size to fill the strip)
    const windowMs = Math.max(stepSize.ms * 10, 30 * 60_000); // at least 30 min
    const end = new Date(viewAnchor).toISOString();
    const start = new Date(viewAnchor - windowMs).toISOString();
    try {
      const f = await window.api.timemachine.frames.range(start, end);
      setFrames(f || []);
    } catch {}
    try {
      const c = await window.api.timemachine.clusters.range(start, end);
      setClusters(c || []);
    } catch {}
  }

  async function handleStart() {
    await window.api.timemachine.start();
    refreshStatus();
  }

  async function handleStop() {
    await window.api.timemachine.stop();
    refreshStatus();
  }

  async function handlePause() {
    await window.api.timemachine.pause();
    refreshStatus();
  }

  async function handleResume() {
    await window.api.timemachine.resume();
    refreshStatus();
  }

  async function saveConfig(updates: Partial<TmConfig>) {
    const result = await window.api.timemachine.config.save(updates);
    setConfig(result);
    try {
      setForecast(await window.api.timemachine.forecast());
    } catch {}
  }

  async function handleSearch(query: string) {
    setSearchQuery(query);
    if (searchDebounce.current) clearTimeout(searchDebounce.current);
    if (!query.trim()) {
      setSearchResults([]);
      return;
    }
    searchDebounce.current = setTimeout(async () => {
      setSearching(true);
      try {
        const results = await window.api.timemachine.search(query);
        setSearchResults(results || []);
      } catch {}
      setSearching(false);
    }, 300);
  }

  function fmtTime(iso: string): string {
    return new Date(iso).toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  function fmtDate(iso: string): string {
    return new Date(iso).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  function fmtBytes(bytes: number): string {
    if (bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const idx = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / 1024 ** idx).toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
  }

  function updatePrivacy(next: Partial<TmConfig['privacy']>) {
    if (!config) return;
    saveConfig({ privacy: { ...config.privacy, ...next } } as Partial<TmConfig>);
  }

  function textList(value: string[]): string {
    return value.join('\n');
  }

  function parseTextList(value: string): string[] {
    return value
      .split('\n')
      .map((v) => v.trim())
      .filter(Boolean);
  }

  // ─── Timeline Tab ───────────────────────────────────────────────────

  function renderTimelineTab() {
    return (
      <div>
        {/* Status Bar */}
        <div
          style={{
            ...S.card,
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            padding: '12px 20px',
          }}
        >
          <span style={S.dot((status?.running && !status?.paused) || false)} />
          <span style={{ fontSize: 13, fontWeight: 600 }}>
            {status?.running ? (status?.paused ? 'Paused' : 'Recording') : 'Stopped'}
          </span>
          <span style={{ fontSize: 12, color: '#666' }}>{status?.captureCount || 0} captures</span>
          {stats && (
            <span style={{ fontSize: 12, color: '#666' }}>
              {stats.todayConversations} conversation{stats.todayConversations !== 1 ? 's' : ''}{' '}
              today
            </span>
          )}
          {status?.privacyActive && (
            <span style={{ fontSize: 12, color: '#f59e0b' }}>
              Privacy active: {status.privacyReason}
            </span>
          )}
          {status && status.privacySkipCount > 0 && (
            <span style={{ fontSize: 12, color: '#666' }}>
              {status.privacySkipCount} privacy skips
            </span>
          )}
          <div style={{ flex: 1 }} />
          {!status?.running ? (
            <button style={S.btn('#7c3aed', 'sm')} onClick={handleStart}>
              Start
            </button>
          ) : status?.paused ? (
            <button style={S.btn('#7c3aed', 'sm')} onClick={handleResume}>
              Resume
            </button>
          ) : (
            <>
              <button style={S.btn('#333', 'sm')} onClick={handlePause}>
                Pause
              </button>
              <button style={S.btn('#4a1616', 'sm')} onClick={handleStop}>
                Stop
              </button>
            </>
          )}
        </div>

        {/* Navigation: Back arrow | Step size buttons | Forward arrow | Now */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 16, alignItems: 'center' }}>
          <button
            style={{ ...S.btn('#333', 'sm'), fontSize: 16, padding: '4px 10px' }}
            onClick={stepBack}
            title="Step back"
          >
            &larr;
          </button>
          {TIME_RANGES.map((r) => (
            <button
              key={r.label}
              style={S.rangeBtn(stepSize.label === r.label)}
              onClick={() => setStepSize(r)}
            >
              {r.label}
            </button>
          ))}
          <button
            style={{ ...S.btn('#333', 'sm'), fontSize: 16, padding: '4px 10px' }}
            onClick={stepForward}
            title="Step forward"
          >
            &rarr;
          </button>
          <button style={S.btn('#7c3aed', 'sm')} onClick={jumpToNow}>
            Now
          </button>
        </div>

        {/* Thumbnail Strip */}
        <div style={{ ...S.card, padding: 12 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 8,
            }}
          >
            <div style={{ fontSize: 12, color: '#666' }}>
              {timelineView === 'frames'
                ? `${frames.length} frames`
                : `${clusters.length} clusters`}{' '}
              &mdash; step: {stepSize.label}
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                style={S.rangeBtn(timelineView === 'frames')}
                onClick={() => setTimelineView('frames')}
              >
                Frames
              </button>
              <button
                style={S.rangeBtn(timelineView === 'clusters')}
                onClick={() => setTimelineView('clusters')}
              >
                Clusters
              </button>
            </div>
          </div>
          {timelineView === 'clusters' ? (
            clusters.length === 0 ? (
              <div style={{ color: '#444', fontSize: 13, padding: '20px 0', textAlign: 'center' }}>
                No activity clusters in this window.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {clusters.map((cluster) => (
                  <div
                    key={cluster.id}
                    data-testid="tm-cluster"
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '120px 1fr',
                      gap: 12,
                      padding: 10,
                      border: '1px solid #242424',
                      borderRadius: 6,
                      cursor: 'pointer',
                    }}
                    onClick={() => {
                      setViewAnchor(new Date(cluster.end).getTime() + 60_000);
                      if (cluster.frames) setFrames(cluster.frames);
                      setTimelineView('frames');
                    }}
                  >
                    {cluster.representativeFrame && thumbUrls[cluster.representativeFrame.id] ? (
                      <img
                        src={thumbUrls[cluster.representativeFrame.id]}
                        style={S.thumbnail(false)}
                      />
                    ) : (
                      <div
                        style={{
                          ...S.thumbnail(false),
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: 10,
                          color: '#555',
                        }}
                      >
                        no img
                      </div>
                    )}
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
                        {fmtTime(cluster.start)} - {fmtTime(cluster.end)}
                      </div>
                      <div style={{ fontSize: 12, color: '#888', marginBottom: 6 }}>
                        {cluster.frameCount} frame{cluster.frameCount !== 1 ? 's' : ''}
                      </div>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {cluster.topOcrTerms.map((term) => (
                          <span
                            key={term}
                            style={{
                              fontSize: 10,
                              color: '#aaa',
                              background: '#222',
                              borderRadius: 4,
                              padding: '2px 6px',
                            }}
                          >
                            {term}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )
          ) : frames.length === 0 ? (
            <div style={{ color: '#444', fontSize: 13, padding: '20px 0', textAlign: 'center' }}>
              {status?.running
                ? 'Waiting for captures...'
                : 'Start recording to see screenshots here.'}
            </div>
          ) : (
            <div
              ref={stripRef}
              style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 8 }}
            >
              {frames.map((f, i) => (
                <div key={f.id} style={{ flexShrink: 0, textAlign: 'center' }}>
                  {thumbUrls[f.id] ? (
                    <img
                      src={thumbUrls[f.id]}
                      style={S.thumbnail(selectedIdx === i)}
                      onClick={() => openFullScreen(i)}
                    />
                  ) : (
                    <div
                      style={{
                        ...S.thumbnail(selectedIdx === i),
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: 10,
                        color: '#555',
                      }}
                      onClick={() => openFullScreen(i)}
                    >
                      {f.local_path || f.s3_key ? '...' : 'no img'}
                    </div>
                  )}
                  <div style={{ fontSize: 9, color: '#555', marginTop: 2 }}>
                    {fmtTime(f.timestamp)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Selected Frame Detail (below strip) */}
        {selectedFrame && !fullScreenUrl && (
          <div style={S.card}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
              <span style={{ fontSize: 14, fontWeight: 600 }}>
                {fmtDate(selectedFrame.timestamp)}
              </span>
              <span style={{ fontSize: 12, color: '#666' }}>
                {(selectedFrame.file_size / 1024).toFixed(0)} KB
              </span>
            </div>
            {selectedFrame.ocr_text ? (
              <div style={S.ocrPanel}>{selectedFrame.ocr_text}</div>
            ) : (
              <div style={{ color: '#444', fontSize: 12 }}>No OCR text for this frame.</div>
            )}
          </div>
        )}
      </div>
    );
  }

  // ─── Search Tab ─────────────────────────────────────────────────────

  function renderSearchTab() {
    return (
      <div>
        <div style={{ marginBottom: 16 }}>
          <input
            style={{ ...S.input, fontSize: 15, padding: '12px 16px' }}
            placeholder="Search everything you've seen and heard..."
            value={searchQuery}
            onChange={(e) => handleSearch(e.target.value)}
            autoFocus
          />
        </div>

        {searching && (
          <div style={{ color: '#888', fontSize: 13, marginBottom: 12 }}>Searching...</div>
        )}

        {searchResults.length > 0 && (
          <div style={{ fontSize: 12, color: '#666', marginBottom: 12 }}>
            {searchResults.length} result{searchResults.length !== 1 ? 's' : ''}
          </div>
        )}

        {searchResults.map((r, i) => (
          <div
            key={i}
            style={{
              ...S.card,
              padding: 14,
              cursor: r.type === 'screenshot' ? 'pointer' : 'default',
            }}
            onClick={async () => {
              if (r.type === 'screenshot' && (r.local_path || r.s3_key)) {
                setViewAnchor(new Date(r.timestamp).getTime() + 60_000);
                try {
                  const result = await window.api.timemachine.screenshot(
                    r.local_path || null,
                    r.s3_key || null,
                  );
                  if (result.success) {
                    setFullScreenUrl(result.dataUrl || result.url || null);
                    setSelectedIdx(-1);
                  }
                } catch {}
                setTab('timeline');
              }
            }}
          >
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  padding: '2px 6px',
                  borderRadius: 4,
                  background: r.type === 'screenshot' ? '#1a2a3a' : '#2a1a3a',
                  color: r.type === 'screenshot' ? '#60a5fa' : '#c084fc',
                }}
              >
                {r.type === 'screenshot' ? 'SCREEN' : 'AUDIO'}
              </span>
              <span style={{ fontSize: 12, color: '#888' }}>{fmtDate(r.timestamp)}</span>
              {r.type === 'screenshot' && (
                <span style={{ fontSize: 10, color: '#555' }}>click to view</span>
              )}
            </div>
            <div style={{ fontSize: 12, color: '#ccc', lineHeight: 1.5 }}>
              {r.text.length > 300 ? r.text.slice(0, 300) + '...' : r.text}
            </div>
          </div>
        ))}

        {searchQuery && !searching && searchResults.length === 0 && (
          <div style={{ color: '#444', fontSize: 13, textAlign: 'center', paddingTop: 40 }}>
            No results found.
          </div>
        )}
      </div>
    );
  }

  // ─── Settings Tab ─────────────────────────────────────────────────────

  function renderSettingsTab() {
    if (!config) return null;

    return (
      <div style={{ maxWidth: 600 }}>
        {/* Capture Controls */}
        <div style={S.card}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Capture</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 13,
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={config.enabled}
                onChange={(e) => saveConfig({ enabled: e.target.checked })}
              />
              Auto-start on app launch
            </label>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 13,
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={config.captureAudio}
                onChange={(e) => saveConfig({ captureAudio: e.target.checked })}
              />
              Capture system audio
            </label>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 13,
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={config.captureMic}
                onChange={(e) => saveConfig({ captureMic: e.target.checked })}
              />
              Capture microphone (privacy-sensitive)
            </label>
          </div>
        </div>

        {/* Intervals */}
        <div style={S.card}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Intervals</div>
          <div style={{ marginBottom: 12 }}>
            <label style={S.label}>Screenshot interval (ms)</label>
            <input
              style={S.input}
              type="number"
              value={config.captureIntervalMs}
              onChange={(e) =>
                setConfig({ ...config, captureIntervalMs: parseInt(e.target.value) || 3000 })
              }
              onBlur={() => saveConfig({ captureIntervalMs: config.captureIntervalMs })}
            />
          </div>
          <div>
            <label style={S.label}>Silence threshold for new conversation (seconds)</label>
            <input
              style={S.input}
              type="number"
              value={config.silenceThresholdSeconds}
              onChange={(e) =>
                setConfig({ ...config, silenceThresholdSeconds: parseInt(e.target.value) || 60 })
              }
              onBlur={() => saveConfig({ silenceThresholdSeconds: config.silenceThresholdSeconds })}
            />
          </div>
        </div>

        {/* Retention */}
        <div style={S.card}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Retention</div>
          <div style={{ marginBottom: 12 }}>
            <label style={S.label}>Keep local screenshots (days)</label>
            <input
              style={S.input}
              type="number"
              value={config.retentionScreenshotDays}
              onChange={(e) =>
                setConfig({ ...config, retentionScreenshotDays: parseInt(e.target.value) || 7 })
              }
              onBlur={() => saveConfig({ retentionScreenshotDays: config.retentionScreenshotDays })}
            />
          </div>
          <div>
            <label style={S.label}>Keep local audio (days)</label>
            <input
              style={S.input}
              type="number"
              value={config.retentionAudioDays}
              onChange={(e) =>
                setConfig({ ...config, retentionAudioDays: parseInt(e.target.value) || 30 })
              }
              onBlur={() => saveConfig({ retentionAudioDays: config.retentionAudioDays })}
            />
          </div>
          <div style={{ fontSize: 11, color: '#555', marginTop: 8 }}>
            OCR text and transcripts are kept in SQLite forever. Screenshots and audio upload to S3
            then delete locally.
          </div>
        </div>

        {/* Storage Forecast */}
        {forecast && (
          <div style={S.card}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>
              Storage Forecast
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 12 }}>
              <div style={{ color: '#888' }}>Average screenshot</div>
              <div>{fmtBytes(forecast.averageScreenshotBytes)}</div>
              <div style={{ color: '#888' }}>Projected screenshots/day</div>
              <div>{forecast.screenshotsPerDay.toLocaleString()}</div>
              <div style={{ color: '#888' }}>Projected retained screenshots</div>
              <div>{fmtBytes(forecast.estimatedScreenshotRetentionBytes)}</div>
              <div style={{ color: '#888' }}>Local screenshots now</div>
              <div>{fmtBytes(forecast.existingLocalScreenshotBytes)}</div>
              <div style={{ color: '#888' }}>Local audio now</div>
              <div>{fmtBytes(forecast.existingLocalAudioBytes)}</div>
              <div style={{ color: '#888' }}>Estimated retained total</div>
              <div>{fmtBytes(forecast.estimatedRetainedTotalBytes)}</div>
            </div>
          </div>
        )}

        {/* Privacy */}
        <div style={S.card}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Privacy</div>
          <div style={{ marginBottom: 14 }}>
            <label style={S.label}>Privacy zones</label>
            {config.privacy.zones.map((zone, idx) => (
              <div
                key={zone.id}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1.4fr repeat(4, 0.8fr) auto auto',
                  gap: 6,
                  marginBottom: 6,
                  alignItems: 'center',
                }}
              >
                <input
                  style={S.input}
                  value={zone.label}
                  onChange={(e) => {
                    const zones = [...config.privacy.zones];
                    zones[idx] = { ...zone, label: e.target.value };
                    setConfig({ ...config, privacy: { ...config.privacy, zones } });
                  }}
                  onBlur={() => updatePrivacy({ zones: config.privacy.zones })}
                />
                {(['x', 'y', 'width', 'height'] as const).map((field) => (
                  <input
                    key={field}
                    aria-label={`zone-${field}`}
                    style={S.input}
                    type="number"
                    value={zone[field]}
                    onChange={(e) => {
                      const zones = [...config.privacy.zones];
                      zones[idx] = { ...zone, [field]: parseInt(e.target.value) || 0 };
                      setConfig({ ...config, privacy: { ...config.privacy, zones } });
                    }}
                    onBlur={() => updatePrivacy({ zones: config.privacy.zones })}
                  />
                ))}
                <input
                  type="checkbox"
                  checked={zone.enabled}
                  onChange={(e) => {
                    const zones = [...config.privacy.zones];
                    zones[idx] = { ...zone, enabled: e.target.checked };
                    updatePrivacy({ zones });
                  }}
                />
                <button
                  style={S.btn('#333', 'sm')}
                  onClick={() =>
                    updatePrivacy({ zones: config.privacy.zones.filter((z) => z.id !== zone.id) })
                  }
                >
                  Remove
                </button>
              </div>
            ))}
            <button
              data-testid="tm-add-zone"
              style={S.btn('#333', 'sm')}
              onClick={() =>
                updatePrivacy({
                  zones: [
                    ...config.privacy.zones,
                    {
                      id: `zone_${Date.now()}`,
                      label: 'New zone',
                      x: 0,
                      y: 0,
                      width: 320,
                      height: 180,
                      enabled: true,
                    },
                  ],
                })
              }
            >
              Add Zone
            </button>
          </div>

          <div style={{ marginBottom: 14 }}>
            <label style={S.label}>Pause schedules</label>
            {config.privacy.pauseSchedules.map((schedule, idx) => (
              <div
                key={schedule.id}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 1.2fr 0.8fr 0.8fr auto auto',
                  gap: 6,
                  marginBottom: 6,
                  alignItems: 'center',
                }}
              >
                <input
                  style={S.input}
                  value={schedule.label}
                  onChange={(e) => {
                    const pauseSchedules = [...config.privacy.pauseSchedules];
                    pauseSchedules[idx] = { ...schedule, label: e.target.value };
                    setConfig({ ...config, privacy: { ...config.privacy, pauseSchedules } });
                  }}
                  onBlur={() => updatePrivacy({ pauseSchedules: config.privacy.pauseSchedules })}
                />
                <input
                  aria-label="schedule-days"
                  style={S.input}
                  value={schedule.days.join(',')}
                  onChange={(e) => {
                    const pauseSchedules = [...config.privacy.pauseSchedules];
                    pauseSchedules[idx] = {
                      ...schedule,
                      days: e.target.value
                        .split(',')
                        .map((v) => parseInt(v.trim(), 10))
                        .filter((v) => Number.isFinite(v) && v >= 0 && v <= 6),
                    };
                    setConfig({ ...config, privacy: { ...config.privacy, pauseSchedules } });
                  }}
                  onBlur={() => updatePrivacy({ pauseSchedules: config.privacy.pauseSchedules })}
                />
                <input
                  aria-label="schedule-start"
                  style={S.input}
                  type="time"
                  value={schedule.startTime}
                  onChange={(e) => {
                    const pauseSchedules = [...config.privacy.pauseSchedules];
                    pauseSchedules[idx] = { ...schedule, startTime: e.target.value };
                    setConfig({ ...config, privacy: { ...config.privacy, pauseSchedules } });
                  }}
                  onBlur={() => updatePrivacy({ pauseSchedules: config.privacy.pauseSchedules })}
                />
                <input
                  aria-label="schedule-end"
                  style={S.input}
                  type="time"
                  value={schedule.endTime}
                  onChange={(e) => {
                    const pauseSchedules = [...config.privacy.pauseSchedules];
                    pauseSchedules[idx] = { ...schedule, endTime: e.target.value };
                    setConfig({ ...config, privacy: { ...config.privacy, pauseSchedules } });
                  }}
                  onBlur={() => updatePrivacy({ pauseSchedules: config.privacy.pauseSchedules })}
                />
                <input
                  type="checkbox"
                  checked={schedule.enabled}
                  onChange={(e) => {
                    const pauseSchedules = [...config.privacy.pauseSchedules];
                    pauseSchedules[idx] = { ...schedule, enabled: e.target.checked };
                    updatePrivacy({ pauseSchedules });
                  }}
                />
                <button
                  style={S.btn('#333', 'sm')}
                  onClick={() =>
                    updatePrivacy({
                      pauseSchedules: config.privacy.pauseSchedules.filter(
                        (s) => s.id !== schedule.id,
                      ),
                    })
                  }
                >
                  Remove
                </button>
              </div>
            ))}
            <button
              style={S.btn('#333', 'sm')}
              onClick={() =>
                updatePrivacy({
                  pauseSchedules: [
                    ...config.privacy.pauseSchedules,
                    {
                      id: `pause_${Date.now()}`,
                      label: 'Focus block',
                      days: [1, 2, 3, 4, 5],
                      startTime: '09:00',
                      endTime: '17:00',
                      enabled: true,
                    },
                  ],
                })
              }
            >
              Add Schedule
            </button>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
            <div>
              <label style={S.label}>Excluded apps</label>
              <textarea
                style={{ ...S.input, minHeight: 90 }}
                value={textList(config.privacy.excludedApps)}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    privacy: { ...config.privacy, excludedApps: parseTextList(e.target.value) },
                  })
                }
                onBlur={() => updatePrivacy({ excludedApps: config.privacy.excludedApps })}
              />
            </div>
            <div>
              <label style={S.label}>Excluded domains</label>
              <textarea
                style={{ ...S.input, minHeight: 90 }}
                value={textList(config.privacy.excludedDomains)}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    privacy: { ...config.privacy, excludedDomains: parseTextList(e.target.value) },
                  })
                }
                onBlur={() => updatePrivacy({ excludedDomains: config.privacy.excludedDomains })}
              />
            </div>
            <div>
              <label style={S.label}>Excluded title patterns</label>
              <textarea
                style={{ ...S.input, minHeight: 90 }}
                value={textList(config.privacy.excludedTitlePatterns)}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    privacy: {
                      ...config.privacy,
                      excludedTitlePatterns: parseTextList(e.target.value),
                    },
                  })
                }
                onBlur={() =>
                  updatePrivacy({ excludedTitlePatterns: config.privacy.excludedTitlePatterns })
                }
              />
            </div>
          </div>
        </div>

        {/* Dedupe */}
        <div style={S.card}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Dedupe</div>
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 13,
              cursor: 'pointer',
              marginBottom: 12,
            }}
          >
            <input
              type="checkbox"
              checked={config.dedupe.enabled}
              onChange={(e) => saveConfig({ dedupe: { ...config.dedupe, enabled: e.target.checked } } as any)}
            />
            Enable duplicate screenshot detection
          </label>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
            <div>
              <label style={S.label}>Size drift threshold</label>
              <input
                style={S.input}
                type="number"
                step="0.01"
                value={config.dedupe.sizeDriftThreshold}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    dedupe: {
                      ...config.dedupe,
                      sizeDriftThreshold: parseFloat(e.target.value) || 0,
                    },
                  })
                }
                onBlur={() => saveConfig({ dedupe: config.dedupe } as any)}
              />
            </div>
            <div>
              <label style={S.label}>Chunk bytes</label>
              <input
                style={S.input}
                type="number"
                value={config.dedupe.chunkBytes}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    dedupe: { ...config.dedupe, chunkBytes: parseInt(e.target.value) || 4096 },
                  })
                }
                onBlur={() => saveConfig({ dedupe: config.dedupe } as any)}
              />
            </div>
            <div>
              <label style={S.label}>Recent window</label>
              <input
                style={S.input}
                type="number"
                value={config.dedupe.recentWindowSize}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    dedupe: {
                      ...config.dedupe,
                      recentWindowSize: parseInt(e.target.value) || 12,
                    },
                  })
                }
                onBlur={() => saveConfig({ dedupe: config.dedupe } as any)}
              />
            </div>
          </div>
        </div>

        {/* Clustering */}
        <div style={S.card}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Clustering</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div>
              <label style={S.label}>Idle gap (minutes)</label>
              <input
                style={S.input}
                type="number"
                value={config.clustering.idleGapMinutes}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    clustering: {
                      ...config.clustering,
                      idleGapMinutes: parseInt(e.target.value) || 5,
                    },
                  })
                }
                onBlur={() => saveConfig({ clustering: config.clustering } as any)}
              />
            </div>
            <div>
              <label style={S.label}>Top OCR terms</label>
              <input
                style={S.input}
                type="number"
                value={config.clustering.topTermCount}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    clustering: {
                      ...config.clustering,
                      topTermCount: parseInt(e.target.value) || 5,
                    },
                  })
                }
                onBlur={() => saveConfig({ clustering: config.clustering } as any)}
              />
            </div>
          </div>
        </div>

        {/* Storage Stats */}
        {stats && (
          <div style={S.card}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Storage</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 12 }}>
              <div style={{ color: '#888' }}>Total screenshots</div>
              <div>{stats.totalFrames.toLocaleString()}</div>
              <div style={{ color: '#888' }}>Total audio segments</div>
              <div>{stats.totalAudioSegments.toLocaleString()}</div>
              <div style={{ color: '#888' }}>Total conversations</div>
              <div>{stats.totalConversations.toLocaleString()}</div>
              <div style={{ color: '#888' }}>Today's captures</div>
              <div>{stats.todayFrames.toLocaleString()}</div>
            </div>
            <button
              style={{ ...S.btn('#333', 'sm'), marginTop: 12 }}
              onClick={async () => {
                await window.api.timemachine.prune();
                setStats(await window.api.timemachine.stats());
              }}
            >
              Prune Now
            </button>
          </div>
        )}

        {/* S3 */}
        <div style={S.card}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>S3 Storage</div>
          <div style={{ marginBottom: 12 }}>
            <label style={S.label}>Bucket</label>
            <input style={S.input} value={config.s3Bucket} readOnly />
          </div>
          <div>
            <label style={S.label}>Prefix</label>
            <input
              style={S.input}
              value={config.s3Prefix}
              onChange={(e) => setConfig({ ...config, s3Prefix: e.target.value })}
              onBlur={() => saveConfig({ s3Prefix: config.s3Prefix })}
            />
          </div>
        </div>
      </div>
    );
  }

  // ─── Render ─────────────────────────────────────────────────────────

  return (
    <div style={S.container}>
      <div style={S.header}>
        <div style={S.title}>Time Machine</div>
        <span style={S.dot((status?.running && !status?.paused) || false)} />
        <span style={{ fontSize: 12, color: status?.running ? '#22c55e' : '#666' }}>
          {status?.running ? (status?.paused ? 'Paused' : 'Capturing') : 'Off'}
        </span>
      </div>

      <div style={S.tabs}>
        <button
          style={S.tab(tab === 'timeline')}
          onClick={() => {
            setTab('timeline');
            loadFrames();
          }}
        >
          Timeline
        </button>
        <button style={S.tab(tab === 'search')} onClick={() => setTab('search')}>
          Search
        </button>
        <button
          style={S.tab(tab === 'settings')}
          onClick={() => {
            setTab('settings');
            loadAll();
          }}
        >
          Settings
        </button>
      </div>

      <div style={S.body}>
        {tab === 'timeline' && renderTimelineTab()}
        {tab === 'search' && renderSearchTab()}
        {tab === 'settings' && renderSettingsTab()}
      </div>

      {/* Full-screen screenshot overlay */}
      {fullScreenUrl && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(0,0,0,0.95)',
            zIndex: 9999,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
          }}
          onClick={() => setFullScreenUrl(null)}
        >
          <img
            src={fullScreenUrl}
            style={{ maxWidth: '95vw', maxHeight: '85vh', objectFit: 'contain', borderRadius: 4 }}
          />
          {selectedFrame && (
            <div style={{ marginTop: 12, display: 'flex', gap: 16, alignItems: 'center' }}>
              <span style={{ fontSize: 14, color: '#aaa' }}>
                {fmtDate(selectedFrame.timestamp)}
              </span>
              <span style={{ fontSize: 12, color: '#666' }}>
                {(selectedFrame.file_size / 1024).toFixed(0)} KB
              </span>
              <span style={{ fontSize: 12, color: '#555' }}>Press Esc to close</span>
            </div>
          )}
          {selectedFrame?.ocr_text && (
            <div
              style={{
                marginTop: 8,
                maxWidth: '80vw',
                maxHeight: 120,
                overflow: 'auto',
                fontSize: 11,
                color: '#666',
                padding: '8px 16px',
                background: 'rgba(255,255,255,0.05)',
                borderRadius: 4,
              }}
            >
              {selectedFrame.ocr_text.slice(0, 500)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
