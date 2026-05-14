import React, { useEffect, useMemo, useRef, useState } from 'react';

// Warm Editorial accent (from awesome-claude-design research 2026-04-20)
const COPPER = '#c96442';
const COPPER_SOFT = '#d9795a';
const CREAM = '#f4f3ee';
const CREAM_DIM = '#bdbab2';
const INK = '#191817';

interface BriefingSection {
  id: string;
  title: string;
  body: string;
  startLine: number;
}

interface BriefingData {
  date: string;
  filename: string;
  generatedAt: string | null;
  llm: string | null;
  greeting: string;
  sections: BriefingSection[];
  raw: string;
}

interface BriefingDay {
  date: string;
  filename: string;
  filePath: string;
  sizeBytes: number;
  mtimeMs: number;
}

declare global {
  interface Window {
    api: any;
  }
}

export default function Briefing() {
  const [days, setDays] = useState<BriefingDay[]>([]);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [briefing, setBriefing] = useState<BriefingData | null>(null);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [comment, setComment] = useState<{ sectionTitle: string } | null>(null);
  const [commentText, setCommentText] = useState('');
  const [sending, setSending] = useState(false);
  const sectionRefs = useRef<Record<string, HTMLDivElement | null>>({});

  useEffect(() => {
    refreshDays();
  }, []);

  useEffect(() => {
    if (!selectedDate) return;
    loadBriefing(selectedDate);
  }, [selectedDate]);

  async function refreshDays() {
    try {
      const list = await window.api.briefing.listDays();
      setDays(list);
      if (list.length > 0 && !selectedDate) {
        setSelectedDate(list[0].date);
      }
    } catch (e) {
      setToast(`Could not list briefings: ${(e as Error).message}`);
    }
  }

  async function loadBriefing(date: string) {
    setLoading(true);
    try {
      const data = await window.api.briefing.get(date);
      setBriefing(data);
    } catch (e) {
      setToast(`Could not load ${date}: ${(e as Error).message}`);
      setBriefing(null);
    } finally {
      setLoading(false);
    }
  }

  async function onGenerate() {
    setGenerating(true);
    try {
      const result = await window.api.briefing.generate(true);
      if (result.ok) {
        setToast('Briefing generated');
        await refreshDays();
        const today = new Date().toISOString().slice(0, 10);
        setSelectedDate(today);
      } else {
        setToast(`Generation failed: ${result.error}`);
      }
    } finally {
      setGenerating(false);
    }
  }

  async function onExport() {
    if (!selectedDate) return;
    const result = await window.api.briefing.export(selectedDate);
    if (result.ok) {
      setToast(`Exported to ${result.filePath}`);
    } else if (result.error !== 'cancelled') {
      setToast(`Export failed: ${result.error}`);
    }
  }

  async function onSendComment() {
    if (!comment || !selectedDate || !commentText.trim()) return;
    setSending(true);
    try {
      const result = await window.api.briefing.dispatch({
        date: selectedDate,
        sectionTitle: comment.sectionTitle,
        comment: commentText.trim(),
      });
      if (result.ok) {
        setToast(`Dispatched to Amy: ${comment.sectionTitle}`);
        setComment(null);
        setCommentText('');
      } else {
        setToast(`Dispatch failed: ${result.error}`);
      }
    } finally {
      setSending(false);
    }
  }

  function scrollToSection(id: string) {
    const el = sectionRefs.current[id];
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function handleContextMenu(e: React.MouseEvent, sectionTitle: string) {
    e.preventDefault();
    setComment({ sectionTitle });
    setCommentText('');
  }

  const bodyLinkified = useMemo(() => {
    if (!briefing) return null;
    return briefing.sections.map((sec) => (
      <SectionCard
        key={sec.id}
        section={sec}
        refFn={(el) => {
          sectionRefs.current[sec.id] = el;
        }}
        onContextMenu={(e) => handleContextMenu(e, sec.title)}
      />
    ));
  }, [briefing]);

  const greetingLinkified = useMemo(
    () =>
      briefing ? (
        <GreetingBlock
          greeting={briefing.greeting}
          generatedAt={briefing.generatedAt}
          llm={briefing.llm}
        />
      ) : null,
    [briefing],
  );

  return (
    <div style={{ display: 'flex', flex: 1, overflow: 'hidden', background: '#0f0f0f' }}>
      {/* Sidebar: TOC + days */}
      <div
        style={{
          width: 240,
          borderRight: `1px solid #1e1e1e`,
          background: '#0b0b0b',
          display: 'flex',
          flexDirection: 'column',
          flexShrink: 0,
        }}
      >
        <div
          style={{
            padding: '14px 16px 10px',
            borderBottom: '1px solid #1e1e1e',
            fontSize: 11,
            color: CREAM_DIM,
            letterSpacing: 0.4,
            textTransform: 'uppercase',
          }}
        >
          Last 3 days
        </div>
        {days.map((d) => {
          const active = d.date === selectedDate;
          const label = formatDayLabel(d.date);
          return (
            <button
              key={d.date}
              onClick={() => setSelectedDate(d.date)}
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
              {label}
              <div style={{ fontSize: 10, color: '#444', marginTop: 2 }}>{d.date}</div>
            </button>
          );
        })}

        <div
          style={{
            padding: '14px 16px 10px',
            borderTop: '1px solid #1e1e1e',
            marginTop: 12,
            fontSize: 11,
            color: CREAM_DIM,
            letterSpacing: 0.4,
            textTransform: 'uppercase',
          }}
        >
          Sections
        </div>
        <div style={{ flex: 1, overflow: 'auto' }}>
          {briefing?.sections.map((sec) => (
            <button
              key={sec.id}
              onClick={() => scrollToSection(sec.id)}
              title={sec.title}
              style={{
                display: 'block',
                width: '100%',
                padding: '7px 16px',
                background: 'none',
                border: 'none',
                color: '#888',
                textAlign: 'left',
                cursor: 'pointer',
                fontSize: 12,
                lineHeight: 1.35,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.color = COPPER_SOFT)}
              onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.color = '#888')}
            >
              {sec.title}
            </button>
          ))}
        </div>
      </div>

      {/* Main */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div
          style={{
            padding: '14px 24px',
            borderBottom: '1px solid #1e1e1e',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: CREAM }}>Daily Briefing</div>
            <div style={{ fontSize: 11, color: CREAM_DIM, marginTop: 2 }}>
              Right-click any section to dispatch feedback to Amy. Last 3 days retained.
            </div>
          </div>
          <button
            onClick={onGenerate}
            disabled={generating}
            style={{
              padding: '7px 14px',
              background: generating ? '#333' : '#1e1e1e',
              color: generating ? '#888' : CREAM,
              border: `1px solid ${COPPER}`,
              borderRadius: 4,
              cursor: generating ? 'not-allowed' : 'pointer',
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            {generating ? 'Generating...' : 'Generate Now'}
          </button>
          <button
            onClick={onExport}
            disabled={!selectedDate}
            style={{
              padding: '7px 14px',
              background: COPPER,
              color: CREAM,
              border: 'none',
              borderRadius: 4,
              cursor: selectedDate ? 'pointer' : 'not-allowed',
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            Export MD
          </button>
          <button
            onClick={() => selectedDate && loadBriefing(selectedDate)}
            disabled={!selectedDate || loading}
            style={{
              padding: '7px 14px',
              background: '#1e1e1e',
              color: CREAM,
              border: `1px solid #333`,
              borderRadius: 4,
              cursor: selectedDate ? 'pointer' : 'not-allowed',
              fontSize: 12,
            }}
          >
            {loading ? 'Loading...' : 'Reload'}
          </button>
        </div>

        <div
          style={{
            flex: 1,
            overflow: 'auto',
            padding: '20px 28px 60px',
            color: '#d0cfc8',
            fontFamily: 'Georgia, "Times New Roman", serif',
            fontSize: 14.5,
            lineHeight: 1.6,
          }}
        >
          {!briefing && !loading && (
            <div style={{ color: '#666', fontStyle: 'italic' }}>
              No briefing loaded. Pick a date from the left.
            </div>
          )}
          {briefing && (
            <>
              {greetingLinkified}
              {bodyLinkified}
            </>
          )}
        </div>
      </div>

      {/* Comment modal */}
      {comment && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.72)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 50,
          }}
          onClick={() => !sending && setComment(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 520,
              background: INK,
              border: `1px solid ${COPPER}`,
              borderRadius: 8,
              padding: 22,
              color: CREAM,
              boxShadow: '0 24px 60px rgba(0,0,0,0.5)',
            }}
          >
            <div style={{ fontSize: 13, color: CREAM_DIM, marginBottom: 6 }}>
              Dispatch to Amy (sent as #Amy email)
            </div>
            <div style={{ fontSize: 15, fontWeight: 600, color: COPPER_SOFT, marginBottom: 14 }}>
              {comment.sectionTitle}
            </div>
            <textarea
              autoFocus
              value={commentText}
              onChange={(e) => setCommentText(e.target.value)}
              placeholder="What should Amy do? (e.g. 'dig into item 3, check if still open')"
              rows={6}
              style={{
                width: '100%',
                background: '#0f0f0f',
                color: CREAM,
                border: `1px solid #333`,
                borderRadius: 4,
                padding: 10,
                fontSize: 13,
                fontFamily: 'inherit',
                resize: 'vertical',
                boxSizing: 'border-box',
              }}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 14, justifyContent: 'flex-end' }}>
              <button
                onClick={() => !sending && setComment(null)}
                style={{
                  padding: '7px 14px',
                  background: 'none',
                  color: CREAM_DIM,
                  border: `1px solid #333`,
                  borderRadius: 4,
                  cursor: 'pointer',
                  fontSize: 12,
                }}
              >
                Cancel
              </button>
              <button
                onClick={onSendComment}
                disabled={sending || !commentText.trim()}
                style={{
                  padding: '7px 18px',
                  background: COPPER,
                  color: CREAM,
                  border: 'none',
                  borderRadius: 4,
                  cursor: sending || !commentText.trim() ? 'not-allowed' : 'pointer',
                  fontSize: 12,
                  fontWeight: 600,
                  opacity: sending || !commentText.trim() ? 0.6 : 1,
                }}
              >
                {sending ? 'Sending...' : 'Dispatch'}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && <Toast text={toast} onDone={() => setToast(null)} />}
    </div>
  );
}

function GreetingBlock({
  greeting,
  generatedAt,
  llm,
}: {
  greeting: string;
  generatedAt: string | null;
  llm: string | null;
}) {
  return (
    <div
      style={{
        marginBottom: 24,
        padding: '0 0 18px',
        borderBottom: '1px solid #1e1e1e',
      }}
    >
      <pre
        style={{
          whiteSpace: 'pre-wrap',
          color: CREAM,
          fontFamily: 'Georgia, serif',
          fontSize: 16,
          margin: 0,
        }}
      >
        {greeting}
      </pre>
      <div style={{ fontSize: 11, color: '#555', marginTop: 10, fontFamily: 'monospace' }}>
        {generatedAt && <>Generated {generatedAt}</>}
        {llm && <>  ·  LLM: {llm}</>}
      </div>
    </div>
  );
}

function SectionCard({
  section,
  onContextMenu,
  refFn,
}: {
  section: BriefingSection;
  onContextMenu: (e: React.MouseEvent) => void;
  refFn: (el: HTMLDivElement | null) => void;
}) {
  const [expanded, setExpanded] = useState(true);

  return (
    <div
      ref={refFn}
      onContextMenu={onContextMenu}
      style={{
        marginBottom: 18,
        border: '1px solid #1e1e1e',
        borderRadius: 6,
        background: '#141312',
      }}
    >
      <button
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          width: '100%',
          padding: '12px 16px',
          background: 'none',
          border: 'none',
          borderBottom: expanded ? '1px solid #1e1e1e' : 'none',
          cursor: 'pointer',
          textAlign: 'left',
          color: COPPER_SOFT,
          fontSize: 13,
          fontWeight: 700,
          letterSpacing: 0.3,
          textTransform: 'uppercase',
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        <span style={{ color: COPPER, fontSize: 11 }}>{expanded ? '▼' : '▶'}</span>
        <span>{section.title}</span>
      </button>
      {expanded && (
        <div style={{ padding: '14px 18px 16px' }}>
          <LinkifiedText text={section.body} />
        </div>
      )}
    </div>
  );
}

const URL_REGEX = /(https?:\/\/[^\s<>)]+)/g;

function LinkifiedText({ text }: { text: string }) {
  const parts = useMemo(() => {
    const out: React.ReactNode[] = [];
    let last = 0;
    let m: RegExpExecArray | null;
    const re = new RegExp(URL_REGEX);
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) out.push(text.slice(last, m.index));
      const url = m[0];
      out.push(
        <a
          key={m.index}
          href={url}
          onClick={(e) => {
            e.preventDefault();
            window.api.briefing.openExternal(url);
          }}
          style={{ color: COPPER, textDecoration: 'underline' }}
        >
          {url}
        </a>,
      );
      last = m.index + url.length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  }, [text]);

  return (
    <pre
      style={{
        whiteSpace: 'pre-wrap',
        margin: 0,
        color: '#d0cfc8',
        fontFamily: 'Georgia, "Times New Roman", serif',
        fontSize: 14,
        lineHeight: 1.65,
      }}
    >
      {parts}
    </pre>
  );
}

function Toast({ text, onDone }: { text: string; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 3500);
    return () => clearTimeout(t);
  }, [onDone]);
  return (
    <div
      style={{
        position: 'fixed',
        bottom: 28,
        left: '50%',
        transform: 'translateX(-50%)',
        background: INK,
        color: CREAM,
        padding: '10px 18px',
        borderRadius: 6,
        border: `1px solid ${COPPER}`,
        fontSize: 13,
        zIndex: 60,
        boxShadow: '0 12px 32px rgba(0,0,0,0.5)',
      }}
    >
      {text}
    </div>
  );
}

function formatDayLabel(date: string): string {
  const d = new Date(date + 'T12:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}
