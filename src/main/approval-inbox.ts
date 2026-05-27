// approval-inbox.ts
//
// Declarative approval workflow. Foreground code that wants Luke's sign-off on a
// risky or irreversible action (send email, place outbound call, make payment,
// delete data, deploy) enqueues an ApprovalRequest. The Tasks tab / briefing
// dashboard / Telegram surfaces pending requests; Luke approves or rejects;
// the original caller polls or reads the result.
//
// Convergence across four agent frameworks confirms this pattern:
//   - humanlayer/12-factor-agents factor 7: request_human_approval()
//   - crewAI: @human_feedback decorator + approval gate tasks
//   - letta: requires_approval flag on tool calls
//   - smolagents: final_answer_checks gates the terminal step
//
// Storage shape: append-only JSONL ground truth + derived state cache. The
// JSONL is the audit trail (every decision is an event); the cache is a fast
// snapshot for tier-1 briefing reads.
//
// This module is dependency-free, pure file I/O, and ships with regression
// tests in src/main/__tests__/approval-inbox.test.ts.

import * as fs from 'fs';
import * as path from 'path';

// Types

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export type ApprovalSurface =
  | 'telegram'
  | 'briefing'
  | 'tasks-tab'
  | 'vapi-call'
  | 'gmail'
  | 'background-worker'
  | 'unknown';

export interface ApprovalRequest {
  id: string;
  createdAt: string;
  surface: ApprovalSurface;
  action: string;
  reason: string;
  payload?: Record<string, unknown>;
  expiresAt?: string;
  status: ApprovalStatus;
  decidedAt?: string;
  decidedBy?: string;
  notes?: string;
}

export interface EnqueueOptions {
  surface: ApprovalSurface;
  action: string;
  reason: string;
  payload?: Record<string, unknown>;
  ttlMinutes?: number;
  now?: Date;
  idGenerator?: () => string;
}

export interface DecideOptions {
  decision: 'approved' | 'rejected';
  decidedBy: string;
  notes?: string;
  now?: Date;
}

export interface ListOptions {
  surface?: ApprovalSurface;
  now?: Date;
}

// Path helpers

function logPath(dir: string): string {
  return path.join(dir, 'approval-inbox.jsonl');
}

function cachePath(dir: string): string {
  return path.join(dir, 'approval-inbox-state.json');
}

// Default id generator: time-prefixed random suffix for stable sort + uniqueness

function defaultIdGenerator(): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `appr_${t}_${r}`;
}

// Append an event line to the audit log

function appendEvent(dir: string, event: ApprovalRequest): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(logPath(dir), JSON.stringify(event) + '\n');
}

// Read every event line, fold latest event per id

function loadState(dir: string): Map<string, ApprovalRequest> {
  const p = logPath(dir);
  if (!fs.existsSync(p)) return new Map();

  const lines = fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim().length > 0);
  const byId = new Map<string, ApprovalRequest>();

  for (const line of lines) {
    try {
      const ev = JSON.parse(line) as ApprovalRequest;
      if (!ev || typeof ev.id !== 'string') continue;
      byId.set(ev.id, ev);
    } catch {
      /* skip malformed */
    }
  }

  return byId;
}

// Write derived state cache for fast briefing reads

function writeCache(dir: string, state: Map<string, ApprovalRequest>): void {
  const items = Array.from(state.values());
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      cachePath(dir),
      JSON.stringify({ updatedAt: new Date().toISOString(), items }, null, 2),
    );
  } catch {
    /* best-effort */
  }
}

// Public API

export function enqueueApproval(dir: string, opts: EnqueueOptions): ApprovalRequest {
  const now = opts.now ?? new Date();
  const idGen = opts.idGenerator ?? defaultIdGenerator;
  const id = idGen();

  const req: ApprovalRequest = {
    id,
    createdAt: now.toISOString(),
    surface: opts.surface,
    action: opts.action,
    reason: opts.reason,
    ...(opts.payload ? { payload: opts.payload } : {}),
    ...(opts.ttlMinutes && opts.ttlMinutes > 0
      ? { expiresAt: new Date(now.getTime() + opts.ttlMinutes * 60_000).toISOString() }
      : {}),
    status: 'pending',
  };

  appendEvent(dir, req);

  const state = loadState(dir);
  writeCache(dir, state);

  return req;
}

export function listPending(dir: string, opts: ListOptions = {}): ApprovalRequest[] {
  const state = loadState(dir);
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();

  const pending: ApprovalRequest[] = [];
  for (const req of state.values()) {
    if (req.status !== 'pending') continue;
    if (opts.surface && req.surface !== opts.surface) continue;
    if (req.expiresAt && new Date(req.expiresAt).getTime() <= nowMs) continue;
    pending.push(req);
  }

  pending.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return pending;
}

export function getApproval(dir: string, id: string): ApprovalRequest | null {
  const state = loadState(dir);
  return state.get(id) ?? null;
}

export function decideApproval(
  dir: string,
  id: string,
  opts: DecideOptions,
): ApprovalRequest {
  const state = loadState(dir);
  const existing = state.get(id);
  if (!existing) throw new Error(`approval ${id} not found`);
  if (existing.status !== 'pending') {
    throw new Error(`approval ${id} already ${existing.status} at ${existing.decidedAt}`);
  }

  const now = opts.now ?? new Date();
  const decided: ApprovalRequest = {
    ...existing,
    status: opts.decision,
    decidedAt: now.toISOString(),
    decidedBy: opts.decidedBy,
    ...(opts.notes ? { notes: opts.notes } : {}),
  };

  appendEvent(dir, decided);
  state.set(id, decided);
  writeCache(dir, state);

  return decided;
}

// Sweep stale pending requests whose expiresAt has passed. Each becomes an
// 'expired' event in the audit log so the decision history stays consistent.

export function expireStale(dir: string, now: Date = new Date()): ApprovalRequest[] {
  const state = loadState(dir);
  const nowMs = now.getTime();
  const expired: ApprovalRequest[] = [];

  for (const req of state.values()) {
    if (req.status !== 'pending') continue;
    if (!req.expiresAt) continue;
    if (new Date(req.expiresAt).getTime() > nowMs) continue;

    const event: ApprovalRequest = {
      ...req,
      status: 'expired',
      decidedAt: now.toISOString(),
      decidedBy: 'system:ttl-sweep',
    };
    appendEvent(dir, event);
    state.set(req.id, event);
    expired.push(event);
  }

  if (expired.length > 0) writeCache(dir, state);
  return expired;
}

// Briefing-shaped tier-1 line. CEO test: decide fine vs not fine in 3 seconds.

export function formatPendingForBriefing(
  dir: string,
  opts: ListOptions = {},
): string {
  const pending = listPending(dir, opts);
  if (pending.length === 0) return 'Approval inbox: 0 pending.';

  const head = pending.slice(0, 3).map((p) => `${p.surface}:${p.action}`).join(', ');
  const more = pending.length > 3 ? ` +${pending.length - 3} more` : '';
  return `Approval inbox: ${pending.length} pending (${head}${more}).`;
}

// Audit summary for the per-item tier-2 expansion: counts by status + recent
// decisions so Luke can see what was approved/rejected at a glance.

export interface InboxStats {
  pending: number;
  approved: number;
  rejected: number;
  expired: number;
  total: number;
  oldestPendingAt: string | null;
}

export function getInboxStats(dir: string, now: Date = new Date()): InboxStats {
  const state = loadState(dir);
  const stats: InboxStats = {
    pending: 0,
    approved: 0,
    rejected: 0,
    expired: 0,
    total: 0,
    oldestPendingAt: null,
  };
  const nowMs = now.getTime();

  for (const req of state.values()) {
    stats.total++;
    let effective: ApprovalStatus = req.status;
    if (
      effective === 'pending' &&
      req.expiresAt &&
      new Date(req.expiresAt).getTime() <= nowMs
    ) {
      effective = 'expired';
    }
    stats[effective]++;
    if (effective === 'pending') {
      if (!stats.oldestPendingAt || req.createdAt < stats.oldestPendingAt) {
        stats.oldestPendingAt = req.createdAt;
      }
    }
  }

  return stats;
}
