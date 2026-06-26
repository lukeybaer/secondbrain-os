// agent-task-envelope.ts
//
// Typed task envelope for inter-agent handoff. Models the Google A2A
// (Agent-to-Agent) Task lifecycle so claude-code, codex, the Electron app,
// and any future external agent share one schema instead of bespoke JSON
// blobs in data/agent-collab/*.json.
//
// Port of the A2A v0.2 Task spec
// (https://a2a-protocol.org/latest/specification/):
//   - Task is the unit of work, identified by stable id.
//   - Lifecycle states: submitted -> working -> input-required -> [completed
//     | failed | canceled | rejected]. Terminal states are immutable.
//   - Message Parts (text | data | file) carry the payload.
//   - History is append-only; status_history records every transition.
//
// Plus SecondBrain-specific guards:
//   - actor enum constrained to {ExampleCo, claude-code, codex, amy-app,
//     external}.
//   - transitions validated by transitionTask; an invalid edge throws so a
//     downstream consumer cannot quietly corrupt the mailbox.
//   - artifacts kept separate from history (one is the audit log, the
//     other is the deliverable).
//
// Pure module. No fs, no network. The file-backed store lives in
// data/agent-collab/ and is layered on top.

export type ActorId = 'ExampleCo' | 'claude-code' | 'codex' | 'amy-app' | 'external';

export type TaskState =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'rejected';

export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set([
  'completed',
  'failed',
  'canceled',
  'rejected',
]);

export interface TextPart {
  kind: 'text';
  text: string;
  mime?: string;
}

export interface DataPart {
  kind: 'data';
  data: ExampleCo;
}

export interface FilePart {
  kind: 'file';
  uri: string;
  mime: string;
  bytes?: number;
}

export type MessagePart = TextPart | DataPart | FilePart;

export interface Message {
  role: 'user' | 'agent' | 'system';
  parts: MessagePart[];
  ts: string;
  from?: ActorId;
}

export interface StatusEntry {
  state: TaskState;
  ts: string;
  by: ActorId;
  note?: string;
}

export interface Artifact {
  name: string;
  parts: MessagePart[];
  ts: string;
}

export interface TaskEnvelope {
  id: string;
  parent_id?: string;
  kind: string;
  from: ActorId;
  to: ActorId;
  state: TaskState;
  created_at: string;
  updated_at: string;
  history: Message[];
  status_history: StatusEntry[];
  artifacts: Artifact[];
  meta?: Record<string, ExampleCo>;
}

const ID_SAFE = /^[A-Za-z0-9_.\-]{1,128}$/;

const ALLOWED_TRANSITIONS: ReadonlyMap<TaskState, ReadonlySet<TaskState>> = new Map([
  [
    'submitted',
    new Set<TaskState>(['working', 'rejected', 'canceled']),
  ],
  [
    'working',
    new Set<TaskState>([
      'input-required',
      'completed',
      'failed',
      'canceled',
    ]),
  ],
  [
    'input-required',
    new Set<TaskState>(['working', 'canceled', 'failed']),
  ],
  ['completed', new Set<TaskState>()],
  ['failed', new Set<TaskState>()],
  ['canceled', new Set<TaskState>()],
  ['rejected', new Set<TaskState>()],
]);

export class TaskEnvelopeError extends Error {
  constructor(public code: string, message: string) {
    super(`[${code}] ${message}`);
    this.name = 'TaskEnvelopeError';
  }
}

function nowIso(now?: Date): string {
  return (now ?? new Date()).toISOString();
}

export interface CreateTaskInput {
  id: string;
  kind: string;
  from: ActorId;
  to: ActorId;
  parent_id?: string;
  initial_message?: Message;
  meta?: Record<string, ExampleCo>;
}

export function createTask(input: CreateTaskInput, now?: Date): TaskEnvelope {
  if (!ID_SAFE.test(input.id)) {
    throw new TaskEnvelopeError('invalid_id', `task id failed safety regex: ${input.id}`);
  }
  if (input.parent_id !== undefined && !ID_SAFE.test(input.parent_id)) {
    throw new TaskEnvelopeError('invalid_parent_id', `parent_id failed regex: ${input.parent_id}`);
  }
  if (input.kind.length === 0 || input.kind.length > 64) {
    throw new TaskEnvelopeError('invalid_kind', 'kind must be 1..64 chars');
  }
  const ts = nowIso(now);
  const history: Message[] = input.initial_message ? [input.initial_message] : [];
  const env: TaskEnvelope = {
    id: input.id,
    parent_id: input.parent_id,
    kind: input.kind,
    from: input.from,
    to: input.to,
    state: 'submitted',
    created_at: ts,
    updated_at: ts,
    history,
    status_history: [{ state: 'submitted', ts, by: input.from }],
    artifacts: [],
    meta: input.meta,
  };
  return env;
}

export function transitionTask(
  env: TaskEnvelope,
  next: TaskState,
  by: ActorId,
  opts: { note?: string; now?: Date } = {},
): TaskEnvelope {
  if (TERMINAL_STATES.has(env.state)) {
    throw new TaskEnvelopeError(
      'terminal_state',
      `task ${env.id} is in terminal state ${env.state}; cannot transition to ${next}`,
    );
  }
  const allowed = ALLOWED_TRANSITIONS.get(env.state) ?? new Set<TaskState>();
  if (!allowed.has(next)) {
    throw new TaskEnvelopeError(
      'invalid_transition',
      `task ${env.id}: ${env.state} -> ${next} not allowed`,
    );
  }
  const ts = nowIso(opts.now);
  return {
    ...env,
    state: next,
    updated_at: ts,
    status_history: [...env.status_history, { state: next, ts, by, note: opts.note }],
  };
}

export function appendMessage(env: TaskEnvelope, msg: Message): TaskEnvelope {
  if (TERMINAL_STATES.has(env.state)) {
    throw new TaskEnvelopeError(
      'terminal_state',
      `cannot append message to terminal task ${env.id}`,
    );
  }
  if (msg.parts.length === 0) {
    throw new TaskEnvelopeError('empty_parts', 'message must have at least one part');
  }
  for (const part of msg.parts) {
    if (part.kind === 'text' && typeof part.text !== 'string') {
      throw new TaskEnvelopeError('invalid_part', 'text part missing text');
    }
    if (part.kind === 'file' && (!part.uri || !part.mime)) {
      throw new TaskEnvelopeError('invalid_part', 'file part needs uri and mime');
    }
  }
  return {
    ...env,
    history: [...env.history, msg],
    updated_at: msg.ts,
  };
}

export function addArtifact(env: TaskEnvelope, artifact: Artifact): TaskEnvelope {
  if (artifact.parts.length === 0) {
    throw new TaskEnvelopeError('empty_artifact', 'artifact must have at least one part');
  }
  return {
    ...env,
    artifacts: [...env.artifacts, artifact],
    updated_at: artifact.ts,
  };
}

export function summariseTask(env: TaskEnvelope): {
  id: string;
  kind: string;
  state: TaskState;
  age_ms: number;
  messages: number;
  artifacts: number;
  participants: ActorId[];
  terminal: boolean;
} {
  const participants = new Set<ActorId>([env.from, env.to]);
  for (const m of env.history) {
    if (m.from) participants.add(m.from);
  }
  for (const s of env.status_history) participants.add(s.by);
  const created = Date.parse(env.created_at);
  const updated = Date.parse(env.updated_at);
  return {
    id: env.id,
    kind: env.kind,
    state: env.state,
    age_ms: Math.max(0, updated - created),
    messages: env.history.length,
    artifacts: env.artifacts.length,
    participants: Array.from(participants),
    terminal: TERMINAL_STATES.has(env.state),
  };
}

export function isTerminal(state: TaskState): boolean {
  return TERMINAL_STATES.has(state);
}

export function canTransition(from: TaskState, to: TaskState): boolean {
  const allowed = ALLOWED_TRANSITIONS.get(from);
  return !!allowed && allowed.has(to);
}
