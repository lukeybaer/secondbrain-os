import { useEffect, useState, useMemo } from 'react';

const CREAM = '#f5f0e8';
const CREAM_DIM = '#a89f94';
const COPPER = '#c87941';
const COPPER_SOFT = '#d4956a';
const BG = '#0f0f0f';
const SIDEBAR_BG = '#0b0b0b';
const BORDER = '#1e1e1e';

interface HistoryEntry {
  id: string;
  date: string;
  generated_at: string;
  section_count: number;
  word_count: number;
  delivered: number;
}

interface FullBriefing extends HistoryEntry {
  raw_markdown: string;
}

function formatDayLabel(date: string) {
  const d = new Date(date + 'T00:00:00');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((d.getTime() - today.getTime()) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === -1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function MarkdownView({ markdown }: { markdown: string }) {
  // Render markdown as styled HTML-like blocks without external deps
  const lines = markdown.split('\n');
  const elements: JSX.Element[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith('## ')) {
      elements.push(
        <h2
          key={i}
          style={{
            color: COPPER,
            fontSize: 16,
            fontWeight: 700,
            margin: '24px 0 8px',
            borderBottom: `1px solid #2a2a2a`,
            paddingBottom: 6,
          }}
        >
          {line.slice(3)}
        </h2>,
      );
    } else if (line.startsWith('# ')) {
      elements.push(
        <h1
          key={i}
          style={{
            color: CREAM,
            fontSize: 20,
            fontWeight: 700,
            margin: '0 0 16px',
          }}
        >
          {line.slice(2)}
        </h1>,
      );
    } else if (line.startsWith('### ')) {
      elements.push(
        <h3 key={i} style={{ color: COPPER_SOFT, fontSize: 13, fontWeight: 600, margin: '16px 0 4px' }}>
          {line.slice(4)}
        </h3>,
      );
    } else if (line.startsWith('- ') || line.startsWith('* ')) {
      elements.push(
        <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 3 }}>
          <span style={{ color: COPPER, flexShrink: 0, marginTop: 2 }}>•</span>
          <span style={{ color: '#ccc', fontSize: 13, lineHeight: 1.6 }}>{line.slice(2)}</span>
        </div>,
      );
    } else if (line.trim() === '') {
      elements.push(<div key={i} style={{ height: 8 }} />);
    } else {
      elements.push(
        <p key={i} style={{ color: '#ccc', fontSize: 13, lineHeight: 1.6, margin: '0 0 4px' }}>
          {line}
        </p>,
      );
    }
    i++;
  }

  return <div style={{ padding: '24px 32px', overflowY: 'auto', flex: 1 }}>{elements}</div>;
}

export default function BriefingHistory() {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [fullBriefing, setFullBriefing] = useState<FullBriefing | null>(null);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    loadList();
  }, []);

  useEffect(() => {
    if (selected) loadFull(selected);
  }, [selected]);

  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(null), 3000);
      return () => clearTimeout(t);
    }
  }, [toast]);

  async function loadList() {
    try {
      const list = await (window as any).api.briefingHistory.list();
      setEntries(list ?? []);
      if (list?.length && !selected) setSelected(list[0].date);
    } catch (e) {
      setToast(`Could not load briefing history: ${(e as Error).message}`);
    }
  }

  async function loadFull(date: string) {
    setLoading(true);
    setFullBriefing(null);
    try {
      const data = await (window as any).api.briefingHistory.get(date);
      setFullBriefing(data ?? null);
    } catch (e) {
      setToast(`Could not load briefing: ${(e as Error).message}`);
    } finally {
      setLoading(false);
    }
  }

  const selectedEntry = useMemo(
    () => entries.find((e) => e.date === selected) ?? null,
    [entries, selected],
  );

  return (
    <div style={{ display: 'flex', flex: 1, overflow: 'hidden', background: BG }}>
      {/* Sidebar */}
      <div
        style={{
          width: 220,
          borderRight: `1px solid ${BORDER}`,
          background: SIDEBAR_BG,
          display: 'flex',
          flexDirection: 'column',
          flexShrink: 0,
        }}
      >
        <div
          style={{
            padding: '14px 16px 10px',
            borderBottom: `1px solid ${BORDER}`,
            fontSize: 11,
            color: CREAM_DIM,
            letterSpacing: 0.4,
            textTransform: 'uppercase',
          }}
        >
          Briefing Archive
        </div>

        <div style={{ flex: 1, overflowY: 'auto' }}>
          {entries.length === 0 && (
            <div style={{ padding: '16px', fontSize: 12, color: '#555' }}>
              No briefings stored yet.
              <br />
              <br />
              Briefings are saved automatically after they are generated.
            </div>
          )}
          {entries.map((entry) => {
            const active = entry.date === selected;
            return (
              <button
                key={entry.date}
                onClick={() => setSelected(entry.date)}
                style={{
                  display: 'block',
                  width: '100%',
                  padding: '10px 16px',
                  background: 'none',
                  border: 'none',
                  borderLeft: `3px solid ${active ? COPPER : 'transparent'}`,
                  color: active ? CREAM : '#666',
                  textAlign: 'left',
                  cursor: 'pointer',
                  fontSize: 13,
                  fontWeight: active ? 600 : 400,
                }}
              >
                {formatDayLabel(entry.date)}
                <div style={{ fontSize: 10, color: '#444', marginTop: 2 }}>{entry.date}</div>
                <div style={{ fontSize: 10, color: '#3a3a3a', marginTop: 1 }}>
                  {entry.section_count} sections · {entry.word_count} words
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Main */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Header */}
        <div
          style={{
            padding: '14px 24px',
            borderBottom: `1px solid ${BORDER}`,
            display: 'flex',
            alignItems: 'center',
            gap: 16,
          }}
        >
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: CREAM }}>
              {selected ? `Briefing — ${formatDayLabel(selected)}` : 'Select a briefing'}
            </div>
            {selectedEntry && (
              <div style={{ fontSize: 11, color: CREAM_DIM, marginTop: 2 }}>
                Generated {new Date(selectedEntry.generated_at).toLocaleString()} ·{' '}
                {selectedEntry.section_count} sections · {selectedEntry.word_count} words ·{' '}
                {selectedEntry.delivered ? (
                  <span style={{ color: '#5a9' }}>Delivered</span>
                ) : (
                  <span style={{ color: '#955' }}>Not delivered</span>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Content */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {loading && (
            <div style={{ padding: 32, color: '#555', fontSize: 13 }}>Loading…</div>
          )}
          {!loading && !fullBriefing && selected && (
            <div style={{ padding: 32, color: '#555', fontSize: 13 }}>
              No content found for this date.
            </div>
          )}
          {!loading && !selected && (
            <div style={{ padding: 32, color: '#555', fontSize: 13 }}>
              Select a date from the sidebar to view a briefing.
            </div>
          )}
          {!loading && fullBriefing && (
            <MarkdownView markdown={fullBriefing.raw_markdown} />
          )}
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div
          style={{
            position: 'fixed',
            bottom: 24,
            right: 24,
            background: '#1e1e1e',
            border: `1px solid ${COPPER}`,
            color: CREAM,
            padding: '10px 16px',
            borderRadius: 6,
            fontSize: 13,
            zIndex: 9999,
          }}
        >
          {toast}
        </div>
      )}
    </div>
  );
}
