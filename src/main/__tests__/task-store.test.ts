/**
 * Tests for task-store.ts, the Task Spine.
 *
 * Covers: create, persistence and reload from disk, the in-memory index,
 * listing and filtering, the legal-transition state machine (legal moves,
 * illegal moves throwing, idempotent same-status no-op), the embedded
 * history journal, and source / parentId linkage.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  setTasksDir,
  createTask,
  getTask,
  listTasks,
  transition,
  updateTask,
  approveTask,
  taskEmitter,
  IllegalTransitionError,
  type Task,
} from '../task-store';

let testRoot: string;

beforeEach(() => {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'task-store-'));
  setTasksDir(path.join(testRoot, 'tasks'));
});

afterAll(() => {
  try {
    if (testRoot) fs.rmSync(testRoot, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

// -- create --------------------------------------------------------------------

describe('createTask', () => {
  it('creates a queued task with an id, timestamps, and a history entry', () => {
    const t = createTask({ kind: 'action', origin: 'telegram', prompt: 'do the thing' });
    expect(t.id).toBeTruthy();
    expect(t.status).toBe('queued');
    expect(t.kind).toBe('action');
    expect(t.origin).toBe('telegram');
    expect(t.createdAt).toBeTruthy();
    expect(t.history).toEqual([{ status: 'queued', ts: t.createdAt }]);
  });

  it('derives a title from the first line of the prompt when none is given', () => {
    const t = createTask({
      kind: 'action',
      origin: 'app',
      prompt: 'Call the dentist back\nand confirm the time',
    });
    expect(t.title).toBe('Call the dentist back');
  });

  it('keeps an explicit title and truncates a very long derived one', () => {
    const explicit = createTask({ kind: 'action', origin: 'app', prompt: 'x', title: 'Pinned' });
    expect(explicit.title).toBe('Pinned');
    const longLine = 'a'.repeat(200);
    const derived = createTask({ kind: 'action', origin: 'app', prompt: longLine });
    expect(derived.title.length).toBe(80);
    expect(derived.title.endsWith('...')).toBe(true);
  });

  it('persists source and parentId when provided', () => {
    const parent = createTask({ kind: 'ingest', origin: 'gmail', prompt: 'triage inbox' });
    const child = createTask({
      kind: 'action',
      origin: 'gmail',
      prompt: 'reply to invoice',
      parentId: parent.id,
      source: { type: 'gmail', ref: 'msg-123' },
    });
    expect(child.parentId).toBe(parent.id);
    expect(child.source).toEqual({ type: 'gmail', ref: 'msg-123' });
  });

  it('writes the task to disk as one JSON file per task', () => {
    const t = createTask({ kind: 'action', origin: 'voice', prompt: 'book a table' });
    const file = path.join(testRoot, 'tasks', `${t.id}.json`);
    expect(fs.existsSync(file)).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8')) as Task;
    expect(onDisk.id).toBe(t.id);
    expect(onDisk.prompt).toBe('book a table');
  });
});

// -- persistence and reload ----------------------------------------------------

describe('persistence and reload', () => {
  it('reloads tasks from disk into a fresh index', () => {
    const a = createTask({ kind: 'action', origin: 'telegram', prompt: 'task a' });
    const b = createTask({ kind: 'coding', origin: 'command-queue', prompt: 'task b' });
    // Re-point at the same directory to force an index rebuild from disk.
    setTasksDir(path.join(testRoot, 'tasks'));
    expect(getTask(a.id)?.prompt).toBe('task a');
    expect(getTask(b.id)?.prompt).toBe('task b');
    expect(listTasks()).toHaveLength(2);
  });

  it('returns null for an unknown id', () => {
    expect(getTask('nope')).toBeNull();
  });
});

// -- listing and filtering -----------------------------------------------------

describe('listTasks', () => {
  it('filters by status, origin, and kind', () => {
    const t1 = createTask({ kind: 'coding', origin: 'telegram', prompt: 'one' });
    createTask({ kind: 'action', origin: 'briefing', prompt: 'two' });
    transition(t1.id, 'running');

    expect(listTasks({ status: 'running' }).map((t) => t.id)).toEqual([t1.id]);
    expect(listTasks({ status: ['queued', 'running'] })).toHaveLength(2);
    expect(listTasks({ origin: 'briefing' })).toHaveLength(1);
    expect(listTasks({ kind: 'coding' }).map((t) => t.id)).toEqual([t1.id]);
  });

  it('filters child tasks by parentId', () => {
    const parent = createTask({ kind: 'ingest', origin: 'otter', prompt: 'analyze convo' });
    const child = createTask({
      kind: 'action',
      origin: 'otter',
      prompt: 'follow up',
      parentId: parent.id,
    });
    expect(listTasks({ parentId: parent.id }).map((t) => t.id)).toEqual([child.id]);
  });
});

// -- state machine -------------------------------------------------------------

describe('transition', () => {
  it('allows a legal lifecycle and records every move in history', () => {
    const t = createTask({ kind: 'coding', origin: 'command-queue', prompt: 'ship it' });
    transition(t.id, 'running');
    transition(t.id, 'awaiting-review');
    const done = transition(t.id, 'done');
    expect(done.status).toBe('done');
    expect(done.history.map((h) => h.status)).toEqual([
      'queued',
      'running',
      'awaiting-review',
      'done',
    ]);
    expect(done.startedAt).toBeTruthy();
    expect(done.completedAt).toBeTruthy();
  });

  it('throws IllegalTransitionError on an illegal move', () => {
    const t = createTask({ kind: 'action', origin: 'app', prompt: 'x' });
    expect(() => transition(t.id, 'done')).toThrow(IllegalTransitionError);
    transition(t.id, 'running');
    transition(t.id, 'done');
    // A terminal task cannot move again.
    expect(() => transition(t.id, 'running')).toThrow(IllegalTransitionError);
  });

  it('treats a same-status transition as an idempotent no-op', () => {
    const t = createTask({ kind: 'action', origin: 'app', prompt: 'x' });
    transition(t.id, 'running');
    const again = transition(t.id, 'running');
    expect(again.status).toBe('running');
    expect(again.history.filter((h) => h.status === 'running')).toHaveLength(1);
  });

  it('allows a failed task to be re-queued for retry', () => {
    const t = createTask({ kind: 'action', origin: 'app', prompt: 'x' });
    transition(t.id, 'running');
    transition(t.id, 'failed', 'claude exited non-zero');
    const requeued = transition(t.id, 'queued');
    expect(requeued.status).toBe('queued');
  });

  it('can terminally disqualify a qualified input as non-actionable', () => {
    const t = createTask({ kind: 'ingest', origin: 'gmail', prompt: 'scan this email' });
    const removed = transition(t.id, 'removed_non_actionable', 'no follow-up after scan');
    expect(removed.status).toBe('removed_non_actionable');
    expect(removed.completedAt).toBeTruthy();
    expect(removed.history.at(-1)?.note).toMatch(/no follow-up/i);
  });

  it('persists transitions so they survive a reload', () => {
    const t = createTask({ kind: 'action', origin: 'app', prompt: 'x' });
    transition(t.id, 'running', 'spawned');
    setTasksDir(path.join(testRoot, 'tasks'));
    const reloaded = getTask(t.id);
    expect(reloaded?.status).toBe('running');
    expect(reloaded?.history.at(-1)?.note).toBe('spawned');
  });

  it('throws when transitioning an unknown task', () => {
    expect(() => transition('missing', 'running')).toThrow(/not found/i);
  });
});

// -- updateTask ----------------------------------------------------------------

describe('updateTask', () => {
  it('patches non-status fields without touching status', () => {
    const t = createTask({ kind: 'coding', origin: 'command-queue', prompt: 'x' });
    const updated = updateTask(t.id, { pid: 4242, sessionId: 'sess-abc', resultSummary: 'done ok' });
    expect(updated.status).toBe('queued');
    expect(updated.pid).toBe(4242);
    expect(updated.sessionId).toBe('sess-abc');
    expect(updated.resultSummary).toBe('done ok');
  });
});

// -- approval gate -------------------------------------------------------------

describe('approveTask', () => {
  it('marks a task approved and records it in history', () => {
    const t = createTask({ kind: 'action', origin: 'otter', prompt: 'scraped directive' });
    expect(t.approved).toBeUndefined();
    const approved = approveTask(t.id);
    expect(approved.approved).toBe(true);
    expect(approved.history.at(-1)?.note).toMatch(/approved/i);
  });

  it('can revoke approval', () => {
    const t = createTask({ kind: 'action', origin: 'otter', prompt: 'x' });
    approveTask(t.id, true);
    const revoked = approveTask(t.id, false);
    expect(revoked.approved).toBe(false);
  });

  it('persists approval across a reload', () => {
    const t = createTask({ kind: 'action', origin: 'otter', prompt: 'x' });
    approveTask(t.id);
    setTasksDir(path.join(testRoot, 'tasks'));
    expect(getTask(t.id)?.approved).toBe(true);
  });
});

// -- live updates --------------------------------------------------------------

describe('taskEmitter', () => {
  it('emits a task event on create and on transition', () => {
    const seen: Task[] = [];
    const handler = (t: Task): void => {
      seen.push(t);
    };
    taskEmitter.on('task', handler);
    try {
      const t = createTask({ kind: 'action', origin: 'app', prompt: 'x' });
      transition(t.id, 'running');
      expect(seen.length).toBe(2);
      expect(seen[1].status).toBe('running');
    } finally {
      taskEmitter.off('task', handler);
    }
  });
});
