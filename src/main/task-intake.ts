// task-intake.ts
//
// The cross-process bridge into the Task Spine.
//
// Out-of-process surfaces (the Vapi end-of-call script, EC2-side ingest, the
// Otter and Gmail analyzers) cannot import Electron main-process modules, so
// they cannot call task-service.runTask directly. What they CAN do, and
// already do today, is append an actionable #amy directive to the shared
// intake inbox at data/agent/dispatch-queue.jsonl.
//
// This module watches that inbox and turns each new directive into a durable
// Task. Each raw directive runs through smart extraction (task-extract.ts): an
// LLM rewrites the often-garbled scraped chunk into a clean instruction and
// says whether it is confident. A confident extraction is auto-approved, so
// the act worker runs it unattended. An unclear one is still recorded as a
// queued Task but left unapproved for a human. So nothing is dropped, and only
// what we clearly understood auto-executes.
//
// Idempotency: a sidecar consumed-key set prevents the same directive from
// becoming a Task twice, even across app restarts.

import * as fs from 'fs';
import * as path from 'path';
import { createTask, approveTask, type TaskOrigin } from './task-store';
import { extractDispatch, type ExtractedDispatch } from './task-extract';

interface DispatchEntry {
  ts?: string;
  source?: string;
  section?: string;
  itemRef?: string;
  comment?: string;
  title?: string;
  match_hash?: string;
  status?: string;
}

/** Injectable for tests so they do not hit the LLM. */
export type ExtractFn = (rawComment: string, context?: string) => Promise<ExtractedDispatch>;

/** Map a dispatch-queue source string onto a Task origin. */
function mapOrigin(source: string | undefined): TaskOrigin {
  switch ((source ?? '').toLowerCase()) {
    case 'gmail':
      return 'gmail';
    case 'otter':
      return 'otter';
    case 'vapi':
    case 'voice':
    case 'call':
      return 'voice';
    case 'telegram':
      return 'telegram';
    default:
      return 'app';
  }
}

/** Stable dedup key for a dispatch entry. */
function consumedKey(entry: DispatchEntry): string {
  if (entry.match_hash) return entry.match_hash;
  return `${entry.ts ?? ''}|${entry.itemRef ?? ''}|${(entry.comment ?? '').slice(0, 64)}`;
}

function readConsumed(consumedPath: string): Set<string> {
  try {
    const raw = JSON.parse(fs.readFileSync(consumedPath, 'utf8'));
    return new Set(Array.isArray(raw) ? (raw as string[]) : []);
  } catch {
    return new Set();
  }
}

function writeConsumed(consumedPath: string, keys: Set<string>): void {
  fs.mkdirSync(path.dirname(consumedPath), { recursive: true });
  fs.writeFileSync(consumedPath, JSON.stringify([...keys], null, 2), 'utf8');
}

export interface DrainResult {
  created: number;
  approved: number;
  skipped: number;
}

/**
 * Read the dispatch inbox and create a Task for every directive not seen
 * before. Each directive runs through smart extraction; confident extractions
 * are auto-approved for the act worker, unclear ones are held for a human.
 * Idempotent. The extractor is injectable so tests do not hit the LLM.
 */
// Directives older than this are still recorded as Tasks but never
// auto-approved: on first boot the inbox may hold a stale backlog, and a
// half-hour-old scraped directive must not silently auto-execute.
const MAX_AUTO_APPROVE_AGE_MS = 30 * 60_000;

export async function drainIntake(
  dispatchQueuePath: string,
  consumedPath: string,
  extractFn: ExtractFn = extractDispatch,
  maxAutoApproveAgeMs: number = MAX_AUTO_APPROVE_AGE_MS,
): Promise<DrainResult> {
  if (!fs.existsSync(dispatchQueuePath)) return { created: 0, approved: 0, skipped: 0 };

  const consumed = readConsumed(consumedPath);
  const lines = fs
    .readFileSync(dispatchQueuePath, 'utf8')
    .split('\n')
    .filter((l) => l.trim());

  let created = 0;
  let approved = 0;
  let skipped = 0;

  for (const line of lines) {
    let entry: DispatchEntry;
    try {
      entry = JSON.parse(line) as DispatchEntry;
    } catch {
      continue; // skip malformed lines
    }
    const raw = (entry.comment ?? '').trim();
    if (!raw) {
      skipped++;
      continue;
    }
    const key = consumedKey(entry);
    if (consumed.has(key)) {
      skipped++;
      continue;
    }

    // Smart extraction: clean the raw chunk into an actionable instruction.
    let extracted: ExtractedDispatch;
    try {
      extracted = await extractFn(raw, entry.section);
    } catch {
      extracted = { prompt: raw, confident: false, reason: 'extraction error, held for review' };
    }

    const task = createTask({
      kind: 'action',
      origin: mapOrigin(entry.source),
      prompt: extracted.prompt,
      source: { type: entry.source ?? 'dispatch', ref: entry.itemRef ?? key },
    });

    // Stale directives (older than the age gate) are recorded but never
    // auto-approved, so a backlog on first boot does not auto-execute.
    const entryTime = entry.ts ? Date.parse(entry.ts) : NaN;
    const stale = Number.isFinite(entryTime) && Date.now() - entryTime > maxAutoApproveAgeMs;

    // Confident, fresh extractions are approved for autonomous execution;
    // unclear or stale ones wait for a human in the Tasks tab.
    if (extracted.confident && !stale) {
      approveTask(task.id, true);
      approved++;
    }

    consumed.add(key);
    created++;
  }

  if (created > 0) writeConsumed(consumedPath, consumed);
  return { created, approved, skipped };
}

// -- Production wiring ---------------------------------------------------------

let watchTimer: ReturnType<typeof setInterval> | null = null;
let draining = false;

function defaultDispatchQueuePath(): string {
  const { getConfig } = require('./config') as typeof import('./config');
  return path.join(getConfig().dataDir, 'agent', 'dispatch-queue.jsonl');
}

function defaultConsumedPath(): string {
  const { getConfig } = require('./config') as typeof import('./config');
  return path.join(getConfig().dataDir, 'tasks', 'intake-consumed.json');
}

/**
 * Start polling the dispatch inbox every `intervalMs` (default 30s) and on
 * boot. Safe to call once from main-process init.
 */
export function startIntakeWatcher(intervalMs = 30_000): void {
  if (watchTimer) return;
  const run = (): void => {
    // Single-flight: a slow drain (LLM extraction is async) must not overlap
    // the next 30s tick, which could double-create tasks.
    if (draining) return;
    draining = true;
    drainIntake(defaultDispatchQueuePath(), defaultConsumedPath())
      .catch((err) => {
        console.error('[task-intake] drain error:', err);
      })
      .finally(() => {
        draining = false;
      });
  };
  run();
  watchTimer = setInterval(run, intervalMs);
}

export function stopIntakeWatcher(): void {
  if (watchTimer) {
    clearInterval(watchTimer);
    watchTimer = null;
  }
}
