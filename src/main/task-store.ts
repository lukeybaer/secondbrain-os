// task-store.ts
//
// The Task Spine: one durable, observable record for every unit of work Amy
// does, no matter which surface dispatched it (Telegram, Vapi, the command
// queue, the briefing, ingest analyzers, the app).
//
// Problem: SecondBrain has six-plus independent dispatch and ingest pipelines,
// each with its own (or no) storage. Nothing holds a shared record of work, so
// dispatches feel flaky (a hung run spins forever with nothing recording that
// it died) and the morning briefing can never list "all of Amy's tasks"
// because there is no single list to query.
//
// Solution: one Task record per unit of work, persisted one-file-per-task at
// data/tasks/{id}.json (the same idiom as calls.ts and projects.ts), with a
// validated state machine and an embedded append-only `history` journal. The
// record is the single authoritative store: one writer (transition / persist),
// so the snapshot and the journal can never drift. An in-memory Map indexes
// every task for O(1) listing.
//
// Path resolution: setTasksDir() lets the main process point this at the real
// data dir on boot and lets tests point it at a temp dir. If never set, it
// lazily resolves getConfig().dataDir (the lazy require keeps this module
// importable in tests without an electron mock).

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';

// -- Types ---------------------------------------------------------------------

/** What kind of work the task is. `coding` tasks run a Codex review step. */
export type TaskKind = 'action' | 'coding' | 'ingest';

/** Which surface dispatched the task. */
export type TaskOrigin =
  | 'telegram'
  | 'mobile'
  | 'briefing'
  | 'app'
  | 'voice'
  | 'claude-code'
  | 'codex'
  | 'amy-chat'
  | 'mcp'
  | 'schedule'
  | 'command-queue'
  | 'gmail'
  | 'otter'
  | 'linkedin'
  | 'whatsapp'
  | 'sms';

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'awaiting-review'
  | 'requires-feedback'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'removed_non_actionable';

export interface TaskHistoryEntry {
  status: TaskStatus;
  ts: string;
  note?: string;
}

/** The inbound artifact that spawned this task, for example a Gmail message. */
export interface TaskSource {
  type: string;
  ref: string;
}

/** Reserved execution context. Worktree fields land here in a later phase. */
export interface TaskExecution {
  cwd?: string;
  repo?: string;
  worktree?: string;
  branch?: string;
  base?: string;
}

export interface TaskFeedbackReply {
  text: string;
  ts: string;
}

export interface TaskFeedbackRequest {
  tldr: string;
  question: string;
  requestedAt: string;
  replies?: TaskFeedbackReply[];
}

export interface Task {
  id: string;
  kind: TaskKind;
  origin: TaskOrigin;
  prompt: string;
  title: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  pid?: number;
  sessionId?: string;
  resultSummary?: string;
  error?: string;
  history: TaskHistoryEntry[];
  source?: TaskSource;
  parentId?: string;
  execution?: TaskExecution;
  feedbackRequest?: TaskFeedbackRequest;
  meta?: Record<string, ExampleCo>;
  /**
   * Human-approved for autonomous execution by the act worker. The worker
   * runs ONLY approved tasks, so a raw directive scraped from a call or email
   * can never auto-execute. Tasks created by intake start unapproved; a human
   * approves them from the Tasks tab. Tasks dispatched directly via runTask do
   * not need this, they are already an explicit human action.
   */
  approved?: boolean;
}

// -- Live updates --------------------------------------------------------------

/** Fires 'task' with the updated Task on every create / transition / update. */
export const taskEmitter = new EventEmitter();

// -- Directory resolution ------------------------------------------------------

let _tasksDir: string | null = null;
let _index: Map<string, Task> | null = null;

/** Point the store at a directory. Called on boot and by tests. */
export function setTasksDir(dir: string): void {
  _tasksDir = dir;
  _index = null;
}

function tasksDir(): string {
  if (!_tasksDir) {
    // setTasksDir must be called on boot (index.ts) and by tests. Fail loud
    // rather than lazy-require('./config'), which is unresolvable inside the
    // electron-vite main bundle.
    throw new Error('task-store: setTasksDir() must be called before any task operation');
  }
  return _tasksDir;
}

function ensureDir(): void {
  fs.mkdirSync(tasksDir(), { recursive: true });
}

function taskPath(id: string): string {
  return path.join(tasksDir(), `${id}.json`);
}

// -- Index ---------------------------------------------------------------------

function index(): Map<string, Task> {
  if (_index) return _index;
  _index = new Map();
  ensureDir();
  for (const f of fs.readdirSync(tasksDir())) {
    if (!f.endsWith('.json')) continue;
    try {
      const t = JSON.parse(fs.readFileSync(path.join(tasksDir(), f), 'utf8')) as Task;
      _index.set(t.id, t);
    } catch {
      // skip corrupt records
    }
  }
  return _index;
}

function persist(task: Task): void {
  ensureDir();
  fs.writeFileSync(taskPath(task.id), JSON.stringify(task, null, 2), 'utf8');
  index().set(task.id, task);
  taskEmitter.emit('task', task);
}

// -- Title derivation ----------------------------------------------------------

function deriveTitle(prompt: string): string {
  const firstLine = prompt.trim().split('\n')[0].trim();
  if (!firstLine) return 'Untitled task';
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
}

// -- Create --------------------------------------------------------------------

export interface CreateTaskInput {
  kind: TaskKind;
  origin: TaskOrigin;
  prompt: string;
  title?: string;
  source?: TaskSource;
  parentId?: string;
  execution?: TaskExecution;
  meta?: Record<string, ExampleCo>;
}

export function createTask(input: CreateTaskInput): Task {
  const now = new Date().toISOString();
  const task: Task = {
    id: randomUUID(),
    kind: input.kind,
    origin: input.origin,
    prompt: input.prompt,
    title: input.title?.trim() || deriveTitle(input.prompt),
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    history: [{ status: 'queued', ts: now }],
    ...(input.source ? { source: input.source } : {}),
    ...(input.parentId ? { parentId: input.parentId } : {}),
    ...(input.execution ? { execution: input.execution } : {}),
    ...(input.meta ? { meta: input.meta } : {}),
  };
  persist(task);
  return task;
}

// -- Read ----------------------------------------------------------------------

export function getTask(id: string): Task | null {
  return index().get(id) ?? null;
}

export interface ListTasksFilter {
  status?: TaskStatus | TaskStatus[];
  origin?: TaskOrigin;
  kind?: TaskKind;
  parentId?: string;
}

/** All tasks, newest first, optionally filtered. */
export function listTasks(filter?: ListTasksFilter): Task[] {
  // Out-of-process ingress scripts write Task JSON directly into this
  // directory, so listings rescan disk instead of trusting a possibly stale
  // in-memory index.
  _index = null;
  let tasks = [...index().values()];
  if (filter?.status) {
    const allowed = new Set(Array.isArray(filter.status) ? filter.status : [filter.status]);
    tasks = tasks.filter((t) => allowed.has(t.status));
  }
  if (filter?.origin) tasks = tasks.filter((t) => t.origin === filter.origin);
  if (filter?.kind) tasks = tasks.filter((t) => t.kind === filter.kind);
  if (filter?.parentId) tasks = tasks.filter((t) => t.parentId === filter.parentId);
  return tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// -- State machine -------------------------------------------------------------

const LEGAL_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  queued: ['running', 'cancelled', 'failed', 'removed_non_actionable'],
  running: [
    'awaiting-review',
    'requires-feedback',
    'done',
    'failed',
    'cancelled',
    'removed_non_actionable',
  ],
  'awaiting-review': [
    'running',
    'requires-feedback',
    'done',
    'failed',
    'cancelled',
    'removed_non_actionable',
  ],
  'requires-feedback': ['queued', 'running', 'failed', 'cancelled', 'removed_non_actionable'],
  done: [],
  failed: ['queued', 'removed_non_actionable'], // retry re-queues the task
  cancelled: [],
  removed_non_actionable: [],
};

const TERMINAL: ReadonlySet<TaskStatus> = new Set(['done', 'cancelled', 'removed_non_actionable']);

export class IllegalTransitionError extends Error {
  constructor(
    public readonly from: TaskStatus,
    public readonly to: TaskStatus,
  ) {
    super(`Illegal task transition: ${from} -> ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

/**
 * Move a task to a new status. Validates against the legal-transition table,
 * throws IllegalTransitionError on an illegal move, appends to the history
 * journal, and persists. Transitioning to the same status is an idempotent
 * no-op so callers can be safely re-run.
 */
export function transition(id: string, to: TaskStatus, note?: string): Task {
  const task = getTask(id);
  if (!task) throw new Error(`Task not found: ${id}`);
  if (task.status === to) return task;
  if (!LEGAL_TRANSITIONS[task.status].includes(to)) {
    throw new IllegalTransitionError(task.status, to);
  }
  const now = new Date().toISOString();
  task.status = to;
  task.updatedAt = now;
  task.history.push({ status: to, ts: now, ...(note ? { note } : {}) });
  if (to === 'running' && !task.startedAt) task.startedAt = now;
  if (TERMINAL.has(to) || to === 'failed') task.completedAt = now;
  persist(task);
  return task;
}

/** Patch non-status fields (pid, sessionId, result, error, execution, title). */
export function updateTask(
  id: string,
  patch: Partial<
    Pick<
      Task,
      | 'pid'
      | 'sessionId'
      | 'resultSummary'
      | 'error'
      | 'execution'
      | 'title'
      | 'meta'
      | 'feedbackRequest'
    >
  >,
): Task {
  const task = getTask(id);
  if (!task) throw new Error(`Task not found: ${id}`);
  Object.assign(task, patch);
  task.updatedAt = new Date().toISOString();
  persist(task);
  return task;
}

export interface RequestTaskFeedbackInput {
  tldr: string;
  question: string;
  note?: string;
}

export function requestTaskFeedback(id: string, input: RequestTaskFeedbackInput): Task {
  const task = getTask(id);
  if (!task) throw new Error(`Task not found: ${id}`);
  if (!LEGAL_TRANSITIONS[task.status].includes('requires-feedback')) {
    throw new IllegalTransitionError(task.status, 'requires-feedback');
  }
  const now = new Date().toISOString();
  task.status = 'requires-feedback';
  task.updatedAt = now;
  task.feedbackRequest = {
    tldr: input.tldr.trim() || 'Amy needs one answer before continuing.',
    question: input.question.trim(),
    requestedAt: now,
    replies: [],
  };
  task.history.push({
    status: 'requires-feedback',
    ts: now,
    note: input.note || task.feedbackRequest.tldr,
  });
  persist(task);
  return task;
}

export function replyTaskFeedback(id: string, reply: string): Task {
  const task = getTask(id);
  if (!task) throw new Error(`Task not found: ${id}`);
  if (task.status !== 'requires-feedback') {
    throw new IllegalTransitionError(task.status, 'queued');
  }
  const text = reply.trim();
  if (!text) throw new Error('Feedback reply cannot be empty');
  const now = new Date().toISOString();
  const request: TaskFeedbackRequest = task.feedbackRequest ?? {
    tldr: 'Amy asked for follow-up before continuing.',
    question: '',
    requestedAt: now,
    replies: [],
  };
  request.replies = [...(request.replies ?? []), { text, ts: now }];
  task.feedbackRequest = request;
  task.prompt = `${task.prompt.trim()}\n\nExampleCo replied to Amy's follow-up:\n${text}`;
  task.status = 'queued';
  task.updatedAt = now;
  task.history.push({
    status: 'queued',
    ts: now,
    note: 'feedback received; resumed',
  });
  persist(task);
  return task;
}

/**
 * Mark a task human-approved for autonomous execution by the act worker. This
 * is the gate that stops a raw scraped directive from auto-running: a human
 * must approve a task before the worker will ever pick it up.
 */
export function approveTask(id: string, approved = true): Task {
  const task = getTask(id);
  if (!task) throw new Error(`Task not found: ${id}`);
  task.approved = approved;
  task.updatedAt = new Date().toISOString();
  task.history.push({
    status: task.status,
    ts: task.updatedAt,
    note: approved ? 'approved for autonomous execution' : 'approval revoked',
  });
  persist(task);
  return task;
}
