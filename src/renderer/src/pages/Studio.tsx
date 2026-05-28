import React, { useState, useEffect, useRef } from 'react';

// ─── Types ──────────────────────────────────────────────────────────────

interface DetectedDevice {
  name: string;
  type: 'video' | 'audio';
}

interface StudioConfig {
  recordingDir: string;
  defaultFormat: 'linkedin' | 'youtube' | 'both';
  lowerThirdName: string;
  lowerThirdTitle: string;
  recordScreen: boolean;
  useNvenc: boolean;
  cameras: Camera[];
}

interface Camera {
  id: string;
  name: string;
  audioDevice?: string;
  position: 'front' | 'side' | 'overhead' | 'extra';
  enabled: boolean;
}

interface TranscriptWord {
  word: string;
  start: number;
  end: number;
  confidence: number;
}

interface Recording {
  id: string;
  startedAt: string;
  stoppedAt?: string;
  durationSeconds?: number;
  status: string;
  markers: Marker[];
  cameras: Camera[];
  files?: Record<string, string>;
  screenFile?: string;
  outputFiles?: { linkedin?: string; youtube?: string };
  transcript?: {
    words: TranscriptWord[];
    fullText: string;
    sections: { start: number; end: number; text: string }[];
  };
  error?: string;
}

interface Marker {
  timestamp: number;
  type: 'retake' | 'highlight' | 'section';
  label?: string;
}

type Tab = 'record' | 'recordings' | 'settings';

function localFileUrl(filePath: string): string {
  if (!filePath) return '';
  // Prefer .mp4 over .mkv for better browser playback
  const mp4Path = filePath.replace(/\.mkv$/, '.mp4');
  const normalized = mp4Path.replace(/\\/g, '/').replace(/^\//, '');
  return `media://local/${normalized}`;
}

function fmtTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

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
  btn: (color: string, size: 'sm' | 'md' | 'lg' = 'md') => ({
    background: color,
    border: 'none',
    borderRadius: 6,
    color: '#fff',
    cursor: 'pointer',
    fontWeight: 600,
    fontSize: size === 'lg' ? 16 : size === 'md' ? 13 : 12,
    padding: size === 'lg' ? '14px 32px' : size === 'md' ? '8px 16px' : '6px 12px',
  }),
  dot: (on: boolean) => ({
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: on ? '#22c55e' : '#ef4444',
    display: 'inline-block',
    marginRight: 8,
  }),
  recordBtn: (recording: boolean) => ({
    width: 80,
    height: 80,
    borderRadius: '50%',
    border: `4px solid ${recording ? '#ef4444' : '#444'}`,
    background: recording ? '#ef4444' : '#222',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    transition: 'all 0.2s',
  }),
  recordInner: (recording: boolean) => ({
    width: recording ? 28 : 36,
    height: recording ? 28 : 36,
    borderRadius: recording ? 4 : '50%',
    background: recording ? '#fff' : '#ef4444',
    transition: 'all 0.2s',
  }),
  markerBtn: {
    background: '#333',
    border: '1px solid #444',
    borderRadius: 6,
    padding: '8px 14px',
    color: '#e0e0e0',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 500,
  },
  timer: {
    fontSize: 48,
    fontWeight: 700,
    fontFamily: 'monospace',
    color: '#fff',
    letterSpacing: 2,
  },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 16 },
  badge: (status: string) => ({
    display: 'inline-block',
    padding: '2px 8px',
    borderRadius: 10,
    fontSize: 11,
    fontWeight: 600,
    background:
      status === 'complete'
        ? '#16432a'
        : status === 'recording'
          ? '#4a1616'
          : status === 'error'
            ? '#4a1616'
            : '#2a2a16',
    color:
      status === 'complete'
        ? '#4ade80'
        : status === 'recording'
          ? '#f87171'
          : status === 'error'
            ? '#f87171'
            : '#fbbf24',
  }),
};

// ─── Component ──────────────────────────────────────────────────────────

export default function Studio() {
  const [tab, setTab] = useState<Tab>('record');
  const [config, setConfig] = useState<StudioConfig | null>(null);
  const [devices, setDevices] = useState<DetectedDevice[]>([]);
  const [hasNvenc, setHasNvenc] = useState(false);
  const [recording, setRecording] = useState<Recording | null>(null);
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [selectedRecording, setSelectedRecording] = useState<string | null>(null);
  const [processing, setProcessing] = useState<string | null>(null);
  const [processProgress, setProcessProgress] = useState<{ stage: string; pct: number } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    loadConfig();
    refreshDevices();
    loadRecordings();
    window.api.studio
      .checkNvenc()
      .then(setHasNvenc)
      .catch(() => {});

    window.api.studio.onProgress((data) => {
      setProcessProgress({ stage: data.stage, pct: data.pct });
    });

    return () => {
      window.api.studio.offProgress();
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  async function loadConfig() {
    try {
      setConfig(await window.api.studio.config.get());
    } catch {}
  }

  async function refreshDevices() {
    try {
      setDevices(await window.api.studio.detectDevices());
    } catch {}
  }

  async function loadRecordings() {
    try {
      setRecordings((await window.api.studio.list()) || []);
    } catch {}
  }

  const videoCams = devices.filter((d) => d.type === 'video');
  const audioDevs = devices.filter((d) => d.type === 'audio');

  async function handleStartRecording() {
    if (starting) return; // Prevent double-click
    setStarting(true);
    setError(null);
    try {
      const result = await window.api.studio.start();
      if (result.success) {
        const active = await window.api.studio.active();
        setRecording(active);
        setElapsed(0);
        timerRef.current = setInterval(() => setElapsed((p) => p + 1), 1000);
      } else {
        setError(result.error || 'Failed to start recording');
      }
    } catch (err: any) {
      setError(err.message || 'Recording failed');
    } finally {
      setStarting(false);
    }
  }

  async function handleStopRecording() {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    const result = await window.api.studio.stop();
    if (result.success) {
      setRecording(null);
      setElapsed(0);
      loadRecordings();
    }
  }

  async function handleMarker(type: 'retake' | 'highlight' | 'section') {
    await window.api.studio.marker(type);
    setRecording(await window.api.studio.active());
  }

  async function handleProcess(id: string) {
    setProcessing(id);
    setProcessProgress(null);
    await window.api.studio.process(id);
    setProcessing(null);
    setProcessProgress(null);
    loadRecordings();
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this recording and all its files?')) return;
    try {
      const result = await window.api.studio.delete(id);
      if (!result.success) {
        setError(result.error || 'Delete failed');
        return;
      }
      if (selectedRecording === id) setSelectedRecording(null);
      await loadRecordings();
    } catch (err: any) {
      setError(err.message || 'Delete failed');
    }
  }

  async function saveConfig(updates: Partial<StudioConfig>) {
    setConfig(await window.api.studio.config.save(updates));
  }

  function fmt(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function fmtDate(iso: string): string {
    return new Date(iso).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  // ─── Record Tab ─────────────────────────────────────────────────────

  function renderRecordTab() {
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 24,
          paddingTop: 24,
        }}
      >
        {/* Detected Cameras */}
        <div style={{ ...S.card, width: '100%', maxWidth: 500 }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 10,
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 600 }}>
              Cameras ({videoCams.length} detected)
            </div>
            <button style={S.btn('#333', 'sm')} onClick={refreshDevices}>
              Refresh
            </button>
          </div>
          {videoCams.length === 0 ? (
            <div style={{ color: '#666', fontSize: 12 }}>
              No cameras detected. Check that no other app is using the camera, then click Refresh.
            </div>
          ) : (
            videoCams.map((cam, i) => (
              <div
                key={i}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '4px 0',
                  fontSize: 12,
                }}
              >
                <span style={S.dot(true)} />
                <span style={{ color: '#e0e0e0', flex: 1 }}>{cam.name}</span>
                <span style={{ color: '#555' }}>
                  {(['front', 'side', 'overhead', 'extra'] as const)[i] || 'extra'}
                </span>
              </div>
            ))
          )}
          {config?.recordScreen && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '4px 0',
                fontSize: 12,
                borderTop: '1px solid #222',
                marginTop: 4,
                paddingTop: 8,
              }}
            >
              <span style={S.dot(true)} />
              <span style={{ color: '#e0e0e0', flex: 1 }}>Screen Capture</span>
              <span style={{ color: '#555' }}>{hasNvenc ? 'ddagrab+NVENC' : 'gdigrab'}</span>
            </div>
          )}
        </div>

        {/* Timer */}
        <div style={S.timer}>{fmt(elapsed)}</div>

        {/* Record Button */}
        <div
          style={{
            ...S.recordBtn(!!recording),
            opacity: starting ? 0.5 : 1,
            pointerEvents: starting ? ('none' as const) : ('auto' as const),
          }}
          onClick={recording ? handleStopRecording : handleStartRecording}
          title={starting ? 'Starting...' : recording ? 'Stop Recording' : 'Start Recording'}
        >
          {starting ? (
            <div style={{ color: '#888', fontSize: 11, fontWeight: 600 }}>...</div>
          ) : (
            <div style={S.recordInner(!!recording)} />
          )}
        </div>
        {starting && <div style={{ fontSize: 12, color: '#fbbf24' }}>Starting cameras...</div>}

        {/* Error message */}
        {error && (
          <div style={{ fontSize: 12, color: '#f87171', maxWidth: 400, textAlign: 'center' }}>
            {error}
          </div>
        )}

        {/* Marker Buttons */}
        {recording && (
          <div style={{ display: 'flex', gap: 12 }}>
            <button style={S.markerBtn} onClick={() => handleMarker('retake')}>
              Retake
            </button>
            <button style={S.markerBtn} onClick={() => handleMarker('highlight')}>
              Highlight
            </button>
            <button style={S.markerBtn} onClick={() => handleMarker('section')}>
              New Section
            </button>
          </div>
        )}

        {/* Markers */}
        {recording && recording.markers.length > 0 && (
          <div style={{ ...S.card, width: '100%', maxWidth: 500 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Markers</div>
            {recording.markers.map((m, i) => (
              <div
                key={i}
                style={{ display: 'flex', gap: 8, padding: '4px 0', fontSize: 12, color: '#aaa' }}
              >
                <span
                  style={{
                    color:
                      m.type === 'retake'
                        ? '#f87171'
                        : m.type === 'highlight'
                          ? '#fbbf24'
                          : '#60a5fa',
                    fontWeight: 600,
                  }}
                >
                  {m.type}
                </span>
                <span>{fmt(Math.round(m.timestamp))}</span>
              </div>
            ))}
          </div>
        )}

        {/* Info */}
        {hasNvenc && (
          <div style={{ fontSize: 11, color: '#555' }}>NVENC GPU encoding available</div>
        )}
      </div>
    );
  }

  // ─── Recordings Tab ─────────────────────────────────────────────────

  function renderRecordingsTab() {
    if (recordings.length === 0) {
      return (
        <div style={{ color: '#666', textAlign: 'center', paddingTop: 60, fontSize: 14 }}>
          No recordings yet.
        </div>
      );
    }

    return (
      <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 16 }}>
        {recordings.map((rec) => {
          const isSelected = selectedRecording === rec.id;
          return (
            <div
              key={rec.id}
              style={{ ...S.card, cursor: 'pointer', borderColor: isSelected ? '#7c3aed' : '#222' }}
            >
              {/* Header — always visible, clickable */}
              <div
                onClick={() => setSelectedRecording(isSelected ? null : rec.id)}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: isSelected ? 16 : 0,
                }}
              >
                <div>
                  <span style={{ fontSize: 14, fontWeight: 600 }}>{fmtDate(rec.startedAt)}</span>
                  {rec.durationSeconds != null && (
                    <span style={{ fontSize: 12, color: '#888', marginLeft: 12 }}>
                      {fmt(rec.durationSeconds)}
                    </span>
                  )}
                  {rec.cameras && (
                    <span style={{ fontSize: 12, color: '#888', marginLeft: 12 }}>
                      {rec.cameras.length} cam{rec.cameras.length !== 1 ? 's' : ''}
                    </span>
                  )}
                  {rec.transcript && (
                    <span style={{ fontSize: 12, color: '#4ade80', marginLeft: 12 }}>
                      transcribed
                    </span>
                  )}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={S.badge(rec.status)}>{rec.status}</span>
                  <span style={{ fontSize: 12, color: '#555' }}>{isSelected ? '▲' : '▼'}</span>
                </div>
              </div>

              {/* Processing progress */}
              {processing === rec.id && processProgress && (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 11, color: '#fbbf24', marginBottom: 4 }}>
                    {processProgress.stage}... {processProgress.pct}%
                  </div>
                  <div
                    style={{ background: '#222', borderRadius: 4, height: 4, overflow: 'hidden' }}
                  >
                    <div
                      style={{
                        background: '#7c3aed',
                        height: '100%',
                        width: `${processProgress.pct}%`,
                        transition: 'width 0.3s',
                      }}
                    />
                  </div>
                </div>
              )}

              {rec.error && !isSelected && (
                <div style={{ fontSize: 12, color: '#f87171', marginTop: 8 }}>{rec.error}</div>
              )}

              {/* Expanded detail view */}
              {isSelected && (
                <div>
                  {rec.error && (
                    <div
                      style={{
                        fontSize: 12,
                        color: '#f87171',
                        marginBottom: 12,
                        padding: 8,
                        background: '#1a0a0a',
                        borderRadius: 4,
                      }}
                    >
                      {rec.error}
                    </div>
                  )}

                  {/* Video playback — source recordings */}
                  <div style={{ marginBottom: 16 }}>
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 600,
                        color: '#888',
                        textTransform: 'uppercase' as const,
                        letterSpacing: '0.06em',
                        marginBottom: 8,
                      }}
                    >
                      Source Recordings
                    </div>
                    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' as const }}>
                      {rec.files &&
                        Object.entries(rec.files).map(([pos, filePath]) => (
                          <div key={pos} style={{ flex: '0 0 auto' }}>
                            <div
                              style={{
                                fontSize: 11,
                                color: '#666',
                                marginBottom: 4,
                                textTransform: 'uppercase' as const,
                              }}
                            >
                              {pos}
                            </div>
                            <video
                              controls
                              preload="none"
                              style={{
                                width: 240,
                                height: 135,
                                borderRadius: 4,
                                background: '#000',
                                display: 'block',
                              }}
                              src={localFileUrl(filePath)}
                            />
                          </div>
                        ))}
                      {rec.screenFile && (
                        <div>
                          <div
                            style={{
                              fontSize: 11,
                              color: '#666',
                              marginBottom: 4,
                              textTransform: 'uppercase' as const,
                            }}
                          >
                            screen
                          </div>
                          <video
                            controls
                            preload="none"
                            style={{
                              width: 240,
                              height: 135,
                              borderRadius: 4,
                              background: '#000',
                              display: 'block',
                            }}
                            src={localFileUrl(rec.screenFile?.replace(/\.mkv$/, '.mp4') ?? '')}
                          />
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Output videos */}
                  {rec.outputFiles && (rec.outputFiles.linkedin || rec.outputFiles.youtube) && (
                    <div style={{ marginBottom: 16 }}>
                      <div
                        style={{
                          fontSize: 12,
                          fontWeight: 600,
                          color: '#888',
                          textTransform: 'uppercase' as const,
                          letterSpacing: '0.06em',
                          marginBottom: 8,
                        }}
                      >
                        Rendered Output
                      </div>
                      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' as const }}>
                        {rec.outputFiles.linkedin && (
                          <div>
                            <div style={{ fontSize: 11, color: '#4ade80', marginBottom: 4 }}>
                              LinkedIn (4:5)
                            </div>
                            <video
                              controls
                              preload="none"
                              style={{
                                width: 162,
                                height: 202,
                                borderRadius: 4,
                                background: '#000',
                                display: 'block',
                              }}
                              src={localFileUrl(rec.outputFiles.linkedin)}
                            />
                          </div>
                        )}
                        {rec.outputFiles.youtube && (
                          <div>
                            <div style={{ fontSize: 11, color: '#4ade80', marginBottom: 4 }}>
                              YouTube (16:9)
                            </div>
                            <video
                              controls
                              preload="none"
                              style={{
                                width: 320,
                                height: 180,
                                borderRadius: 4,
                                background: '#000',
                                display: 'block',
                              }}
                              src={localFileUrl(rec.outputFiles.youtube)}
                            />
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Transcript with word timestamps */}
                  {rec.transcript && (
                    <div style={{ marginBottom: 16 }}>
                      <div
                        style={{
                          fontSize: 12,
                          fontWeight: 600,
                          color: '#888',
                          textTransform: 'uppercase' as const,
                          letterSpacing: '0.06em',
                          marginBottom: 8,
                        }}
                      >
                        Transcript
                      </div>
                      <div
                        style={{
                          background: '#0f0f0f',
                          border: '1px solid #1a1a1a',
                          borderRadius: 6,
                          padding: 12,
                        }}
                      >
                        <div
                          style={{ fontSize: 13, color: '#ccc', lineHeight: 1.6, marginBottom: 12 }}
                        >
                          {rec.transcript.fullText}
                        </div>
                        <div
                          style={{ fontSize: 12, fontWeight: 600, color: '#666', marginBottom: 6 }}
                        >
                          Word Timestamps
                        </div>
                        <div style={{ display: 'flex', flexWrap: 'wrap' as const, gap: 4 }}>
                          {rec.transcript.words.map((w, i) => (
                            <span
                              key={i}
                              title={`${fmtTimestamp(w.start)} → ${fmtTimestamp(w.end)} (${Math.round(w.confidence * 100)}% confidence)`}
                              style={{
                                fontSize: 12,
                                padding: '2px 6px',
                                borderRadius: 3,
                                background:
                                  w.confidence > 0.8
                                    ? '#0a1a0a'
                                    : w.confidence > 0.5
                                      ? '#1a1a0a'
                                      : '#1a0a0a',
                                border: `1px solid ${w.confidence > 0.8 ? '#1a3a1a' : w.confidence > 0.5 ? '#3a3a1a' : '#3a1a1a'}`,
                                color:
                                  w.confidence > 0.8
                                    ? '#86efac'
                                    : w.confidence > 0.5
                                      ? '#fde68a'
                                      : '#fca5a5',
                                cursor: 'default',
                              }}
                            >
                              <span style={{ color: '#555', fontSize: 10, marginRight: 4 }}>
                                {fmtTimestamp(w.start)}
                              </span>
                              {w.word}
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Action buttons */}
                  <div style={{ display: 'flex', gap: 8 }}>
                    {(rec.status === 'stopped' || rec.status === 'error') && (
                      <button
                        style={S.btn('#7c3aed', 'sm')}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleProcess(rec.id);
                        }}
                        disabled={processing === rec.id}
                      >
                        {processing === rec.id ? 'Processing...' : 'Process Video'}
                      </button>
                    )}
                    <button
                      style={S.btn('#333', 'sm')}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDelete(rec.id);
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  // ─── Settings Tab ─────────────────────────────────────────────────────

  function renderSettingsTab() {
    if (!config) return null;

    return (
      <div style={{ maxWidth: 600 }}>
        {/* Output Format */}
        <div style={S.card}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Output Format</div>
          <div style={{ display: 'flex', gap: 8 }}>
            {(['linkedin', 'youtube', 'both'] as const).map((fmt) => (
              <button
                key={fmt}
                style={{
                  ...S.btn(config.defaultFormat === fmt ? '#7c3aed' : '#333', 'sm'),
                  textTransform: 'capitalize' as const,
                }}
                onClick={() => saveConfig({ defaultFormat: fmt })}
              >
                {fmt === 'both' ? 'Both' : fmt === 'linkedin' ? 'LinkedIn (4:5)' : 'YouTube (16:9)'}
              </button>
            ))}
          </div>
        </div>

        {/* Recording Options */}
        <div style={S.card}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Recording</div>
          <div style={{ display: 'flex', gap: 16, marginBottom: 12 }}>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 13,
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={config.recordScreen}
                onChange={(e) => saveConfig({ recordScreen: e.target.checked })}
              />
              Record screen
            </label>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 13,
                cursor: 'pointer',
                color: hasNvenc ? '#e0e0e0' : '#666',
              }}
            >
              <input
                type="checkbox"
                checked={config.useNvenc}
                disabled={!hasNvenc}
                onChange={(e) => saveConfig({ useNvenc: e.target.checked })}
              />
              Use NVENC (GPU) {!hasNvenc && '— not available'}
            </label>
          </div>
        </div>

        {/* Lower Third */}
        <div style={S.card}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Lower Third</div>
          <div style={{ marginBottom: 12 }}>
            <label style={S.label}>Name</label>
            <input
              style={S.input}
              value={config.lowerThirdName}
              onChange={(e) => setConfig({ ...config, lowerThirdName: e.target.value })}
              onBlur={() => saveConfig({ lowerThirdName: config.lowerThirdName })}
            />
          </div>
          <div>
            <label style={S.label}>Title</label>
            <input
              style={S.input}
              value={config.lowerThirdTitle}
              onChange={(e) => setConfig({ ...config, lowerThirdTitle: e.target.value })}
              onBlur={() => saveConfig({ lowerThirdTitle: config.lowerThirdTitle })}
            />
          </div>
        </div>

        {/* Detected Devices */}
        <div style={S.card}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 12,
            }}
          >
            <div style={{ fontSize: 14, fontWeight: 600 }}>Detected Devices</div>
            <button style={S.btn('#333', 'sm')} onClick={refreshDevices}>
              Scan
            </button>
          </div>
          {devices.length === 0 ? (
            <div style={{ color: '#666', fontSize: 12 }}>
              No devices found. Is FFmpeg installed?
            </div>
          ) : (
            <>
              <div style={{ fontSize: 12, color: '#888', marginBottom: 8 }}>Video</div>
              {videoCams.map((d, i) => (
                <div key={i} style={{ fontSize: 12, color: '#e0e0e0', padding: '3px 0' }}>
                  {d.name}
                </div>
              ))}
              {audioDevs.length > 0 && (
                <>
                  <div style={{ fontSize: 12, color: '#888', marginTop: 12, marginBottom: 8 }}>
                    Audio
                  </div>
                  {audioDevs.map((d, i) => (
                    <div key={i} style={{ fontSize: 12, color: '#e0e0e0', padding: '3px 0' }}>
                      {d.name}
                    </div>
                  ))}
                </>
              )}
            </>
          )}
        </div>
      </div>
    );
  }

  // ─── Render ─────────────────────────────────────────────────────────

  return (
    <div style={S.container}>
      <div style={S.header}>
        <div style={S.title}>Studio</div>
        <span style={{ fontSize: 12, color: '#555' }}>
          {videoCams.length} camera{videoCams.length !== 1 ? 's' : ''}
        </span>
      </div>

      <div style={S.tabs}>
        <button style={S.tab(tab === 'record')} onClick={() => setTab('record')}>
          Record
        </button>
        <button
          style={S.tab(tab === 'recordings')}
          onClick={() => {
            setTab('recordings');
            loadRecordings();
          }}
        >
          Recordings
        </button>
        <button style={S.tab(tab === 'settings')} onClick={() => setTab('settings')}>
          Settings
        </button>
      </div>

      <div style={S.body}>
        {tab === 'record' && renderRecordTab()}
        {tab === 'recordings' && renderRecordingsTab()}
        {tab === 'settings' && renderSettingsTab()}
      </div>
    </div>
  );
}
