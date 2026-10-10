import React, { useCallback, useEffect, useState } from 'react';

// The shape mirrors src/main/task-store.ts Task. Kept local so env.d.ts can
// reference it without coupling the renderer to a main-process import.
export interface TaskHistoryEntry {
  status: string;
  ts: string;
  note?: string;
}

export interface TaskRecord {
  id: string;
  kind: 'action' | 'coding' | 'ingest';
  origin: string;
  prompt: string;
  title: string;
  status:
    | 'queued'
    | 'running'
    | 'awaiting-review'
    | 'requires-feedback'
    | 'done'
    | 'failed'
    | 'cancelled'
    | 'removed_non_actionable';
  createdAt: string;
  updatedAt: string;
  resultSummary?: string;
  error?: string;
  history: TaskHistoryEntry[];
  source?: { type: string; ref: string };
  parentId?: string;
  approved?: boolean;
  visibleStatusLabel?: string;
  duplicateTaskIds?: string[];
  feedbackRequest?: {
    tldr: string;
    question: string;
    requestedAt: string;
    replies?: { text: string; ts: string }[];
  };
}

type Status = TaskRecord['status'];

// Display order: live work first, finished work last.
const STATUS_ORDER: Status[] = [
  'running',
  'requires-feedback',
  'queued',
  'awaiting-review',
  'failed',
  'done',
  'cancelled',
  'removed_non_actionable',
];

const STATUS_STYLE: Record<Status, { label: string; fg: string; bg: string; border: string }> = {
  running: { label: 'Running', fg: '#60a5fa', bg: '#0f2540', border: '#1e3a5f' },
  queued: { label: 'Waiting to start', fg: '#fbbf24', bg: '#3a2f0f', border: '#7f5f1d' },
  'requires-feedback': { label: 'Needs your reply', fg: '#fb923c', bg: '#3a1f0f', border: '#7c2d12' },
  'awaiting-review': { label: 'Awaiting review', fg: '#c084fc', bg: '#2a1f3a', border: '#5f3f7f' },
  failed: { label: 'Failed', fg: '#f87171', bg: '#3a0f0f', border: '#7f1d1d' },
  done: { label: 'Done', fg: '#4ade80', bg: '#14532d', border: '#166534' },
  cancelled: { label: 'Cancelled', fg: '#888', bg: '#1e1e1e', border: '#333' },
  removed_non_actionable: { label: 'Removed', fg: '#888', bg: '#1e1e1e', border: '#333' },
};

function statusLabel(task: TaskRecord): string {
  if (task.visibleStatusLabel) return task.visibleStatusLabel;
  if (task.status === 'queued' && !task.approved) return 'Needs approval';
  return STATUS_STYLE[task.status].label;
}

function ageOf(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

export default function Tasks({ active }: { active: boolean }): React.ReactElement {
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [prompt, setPrompt] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [feedbackReply, setFeedbackReply] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const list = await window.api.tasks.list();
      setTasks(list);
    } catch {
      /* main process may not be ready */
    }
  }, []);

  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);

  useEffect(() => {
    // Live updates refresh through the projected list so duplicate intake
    // records keep collapsing to one Amy Projects card.
    const onPush = (): void => {
      void refresh();
    };
    window.api.tasks.onPush(onPush);
    return () => window.api.tasks.offPush();
  }, [refresh]);

  const dispatch = useCallback(async () => {
    const text = prompt.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      await window.api.tasks.run({ origin: 'app', kind: 'action', prompt: text });
      setPrompt('');
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [prompt, busy, refresh]);

  const cancel = useCallback(
    async (id: string) => {
      await window.api.tasks.cancel(id);
      await refresh();
    },
    [refresh],
  );

  const approve = useCallback(
    async (id: string) => {
      await window.api.tasks.approve(id, true);
      await refresh();
    },
    [refresh],
  );

  const reply = useCallback(
    async (id: string) => {
      const text = feedbackReply.trim();
      if (!text) return;
      await window.api.tasks.reply(id, text);
      setFeedbackReply('');
      await refresh();
    },
    [feedbackReply, refresh],
  );

  const grouped = STATUS_ORDER.map((status) => ({
    status,
    items: tasks.filter((t) => t.status === status),
  })).filter((g) => g.items.length > 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#0f0f0f', color: '#e0e0e0' }}>
      <div style={{ padding: '20px 24px', borderBottom: '1px solid #1e1e1e' }}>
        <div style={{ fontSize: 18, fontWeight: 700 }}>Tasks</div>
        <div style={{ fontSize: 12, color: '#888', marginTop: 4 }}>
          Everything Amy is working on, from every surface, in one durable list.
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          <input
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void dispatch();
            }}
            placeholder="Dispatch a task to Amy (Ctrl+Enter)"
            data-testid="task-composer"
            style={{
              flex: 1,
              background: '#111',
              border: '1px solid #333',
              borderRadius: 4,
              color: '#e0e0e0',
              padding: '8px 12px',
              fontSize: 13,
            }}
          />
          <button
            onClick={() => void dispatch()}
            disabled={busy || !prompt.trim()}
            data-testid="task-run"
            style={{
              background: busy || !prompt.trim() ? '#333' : '#7c3aed',
              color: '#fff',
              border: 'none',
              borderRadius: 4,
              padding: '8px 18px',
              fontSize: 13,
              cursor: busy || !prompt.trim() ? 'default' : 'pointer',
            }}
          >
            Run
          </button>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 24px' }}>
        {grouped.length === 0 && (
          <div style={{ color: '#555', fontSize: 13, marginTop: 40, textAlign: 'center' }}>
            No tasks yet. Dispatch one above, or wait for a call, email, or briefing to create one.
          </div>
        )}
        {grouped.map((group) => (
          <div key={group.status} style={{ marginBottom: 24 }}>
            <div
              style={{
                fontSize: 11,
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                color: STATUS_STYLE[group.status].fg,
                marginBottom: 8,
              }}
            >
              {STATUS_STYLE[group.status].label} ({group.items.length})
            </div>
            {group.items.map((task) => {
              const s = STATUS_STYLE[task.status];
              const label = statusLabel(task);
              const open = selected === task.id;
              return (
                <div
                  key={task.id}
                  data-testid="task-card"
                  data-status={task.status}
                  onClick={() => setSelected(open ? null : task.id)}
                  style={{
                    background: '#111',
                    border: `1px solid ${s.border}`,
                    borderRadius: 6,
                    padding: '10px 12px',
                    marginBottom: 8,
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span
                      style={{
                        fontSize: 10,
                        color: s.fg,
                        background: s.bg,
                        border: `1px solid ${s.border}`,
                        borderRadius: 3,
                        padding: '1px 6px',
                      }}
                    >
                      {label}
                    </span>
                    <span style={{ fontSize: 10, color: '#666' }}>{task.origin}</span>
                    <span style={{ fontSize: 10, color: '#666' }}>{task.kind}</span>
                    <span style={{ flex: 1 }} />
                    <span style={{ fontSize: 10, color: '#555' }}>{ageOf(task.createdAt)}</span>
                  </div>
                  <div style={{ fontSize: 13, marginTop: 6, color: '#e0e0e0' }}>{task.title}</div>
                      {task.resultSummary && (
                    <div style={{ fontSize: 11, color: '#888', marginTop: 4 }}>{task.resultSummary}</div>
                  )}
                  {task.duplicateTaskIds && task.duplicateTaskIds.length > 0 && (
                    <div style={{ fontSize: 10, color: '#666', marginTop: 4 }}>
                      {task.duplicateTaskIds.length + 1} intake records folded into this card
                    </div>
                  )}
                  {open && (
                    <div style={{ marginTop: 10, borderTop: '1px solid #1e1e1e', paddingTop: 8 }}>
                      <div style={{ fontSize: 11, color: '#888', whiteSpace: 'pre-wrap' }}>{task.prompt}</div>
                      {task.status === 'requires-feedback' && task.feedbackRequest && (
                        <div
                          style={{
                            marginTop: 10,
                            padding: 10,
                            border: '1px solid #7c2d12',
                            borderRadius: 4,
                            background: '#1b120b',
                          }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <div style={{ fontSize: 11, color: '#fb923c', fontWeight: 700 }}>
                            {task.feedbackRequest.tldr}
                          </div>
                          <div style={{ fontSize: 12, color: '#e0e0e0', marginTop: 6 }}>
                            {task.feedbackRequest.question}
                          </div>
                          <textarea
                            value={feedbackReply}
                            onChange={(e) => setFeedbackReply(e.target.value)}
                            placeholder="Reply to Amy"
                            data-testid="task-feedback-reply"
                            style={{
                              width: '100%',
                              minHeight: 72,
                              marginTop: 8,
                              resize: 'vertical',
                              background: '#111',
                              border: '1px solid #333',
                              borderRadius: 4,
                              color: '#e0e0e0',
                              padding: '8px 10px',
                              fontSize: 12,
                              boxSizing: 'border-box',
                            }}
                          />
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              void reply(task.id);
                            }}
                            disabled={!feedbackReply.trim()}
                            style={{
                              marginTop: 8,
                              background: feedbackReply.trim() ? '#7c2d12' : '#333',
                              color: '#fff',
                              border: '1px solid #9a3412',
                              borderRadius: 4,
                              padding: '5px 12px',
                              fontSize: 11,
                              cursor: feedbackReply.trim() ? 'pointer' : 'default',
                            }}
                          >
                            Send reply
                          </button>
                        </div>
                      )}
                      {task.error && (
                        <div style={{ fontSize: 11, color: '#f87171', marginTop: 6 }}>{task.error}</div>
                      )}
                      <div style={{ fontSize: 10, color: '#555', marginTop: 8 }}>
                        {task.history.map((h, i) => (
                          <div key={i}>
                            {STATUS_STYLE[h.status as Status]?.label ?? h.status} at{' '}
                            {new Date(h.ts).toLocaleString()}
                            {h.note ? ` (${h.note})` : ''}
                          </div>
                        ))}
                      </div>
                      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                        {task.status === 'queued' && !task.approved && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              void approve(task.id);
                            }}
                            title="Approve this task so the act worker may run it autonomously"
                            style={{
                              background: '#14532d',
                              color: '#4ade80',
                              border: '1px solid #166534',
                              borderRadius: 4,
                              padding: '4px 12px',
                              fontSize: 11,
                              cursor: 'pointer',
                            }}
                          >
                            Approve to auto-run
                          </button>
                        )}
                        {task.status === 'queued' && task.approved && (
                          <span style={{ fontSize: 11, color: '#4ade80', alignSelf: 'center' }}>
                            Approved for autonomous run
                          </span>
                        )}
                        {(task.status === 'running' ||
                          task.status === 'queued' ||
                          task.status === 'requires-feedback') && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              void cancel(task.id);
                            }}
                            style={{
                              background: '#3a0f0f',
                              color: '#f87171',
                              border: '1px solid #7f1d1d',
                              borderRadius: 4,
                              padding: '4px 12px',
                              fontSize: 11,
                              cursor: 'pointer',
                            }}
                          >
                            Cancel
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
