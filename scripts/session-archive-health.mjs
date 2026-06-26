#!/usr/bin/env node
// session-archive-health.mjs
//
// ExampleCo 2026-06-14: "we need health checks for spine and archive disconnected -
// number of sessions detailed, fully swept, swept as of end of activity time."
// Reports the spine<->archive connection for live sessions so a session that the
// spine knows is live but has nothing on S3 (the disconnect ExampleCo called out)
// surfaces as a defect, not silence.
//
// Reuses classifySession from the sweep so the briefing and the sweep agree on
// what "fully swept / lagging / disconnected" means.
//
// Usage: node scripts/session-archive-health.mjs [--json]

import { readFileSync, statSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { classifySession } from './session-sweep.mjs';

const HOME = os.homedir();
const TASKS_DIR =
  process.env.SECONDBRAIN_TASKS_DIR ||
  path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'secondbrain', 'data', 'tasks');
const PROJECTS_DIR = path.join(HOME, '.claude', 'projects');

const LIVE_WINDOW_MS = 30 * 60 * 1000; // align with the sweep's selection window

/**
 * Pure: summarize archival health across live sessions. Each entry is
 * { sessionId, task, transcriptSize }. Returns counts + a status + detail line.
 * Disconnect (live but unarchived/stale) drives red, lagging drives yellow.
 */
export function summarizeArchiveHealth(entries, nowMs) {
  const counts = { live: 0, fullySwept: 0, archiving: 0, caughtUp: 0, lagging: 0, disconnected: 0 };
  const disconnectedIds = [];
  for (const e of entries) {
    counts.live++;
    const cls = classifySession(e.task, e.transcriptSize, nowMs);
    if (cls === 'fully-swept') counts.fullySwept++;
    else if (cls === 'archiving') counts.archiving++;
    else if (cls === 'caught-up') counts.caughtUp++;
    else if (cls === 'lagging') counts.lagging++;
    else if (cls === 'disconnected') {
      counts.disconnected++;
      disconnectedIds.push(String(e.sessionId).slice(0, 8));
    }
  }
  const status = counts.disconnected > 0 ? 'red' : counts.lagging > 0 ? 'yellow' : 'green';
  const swept = counts.fullySwept + counts.archiving + counts.caughtUp;
  let detail =
    `${counts.live} live session${counts.live === 1 ? '' : 's'}: ${swept} swept/current, ` +
    `${counts.lagging} lagging, ${counts.disconnected} disconnected`;
  if (disconnectedIds.length) detail += ` (no archive: ${disconnectedIds.join(', ')})`;
  if (counts.live === 0) detail = 'no live sessions to archive';
  return { status, detail, counts, disconnectedIds };
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function findTranscript(sessionId) {
  if (!existsSync(PROJECTS_DIR)) return null;
  for (const slug of readdirSync(PROJECTS_DIR)) {
    const p = path.join(PROJECTS_DIR, slug, `${sessionId}.jsonl`);
    if (existsSync(p)) return p;
  }
  return null;
}

/** Read the live spine sessions + transcript sizes and summarize. */
export function probeSessionArchive(nowMs = Date.now()) {
  if (!existsSync(TASKS_DIR)) return { status: 'yellow', detail: 'spine task store not found', counts: {} };
  const entries = [];
  for (const f of readdirSync(TASKS_DIR)) {
    if (!f.startsWith('spine-session-') || !f.endsWith('.json')) continue;
    const task = readJson(path.join(TASKS_DIR, f));
    if (!task || !task.sessionId) continue;
    const transcript = findTranscript(task.sessionId);
    if (!transcript) continue;
    const st = statSync(transcript);
    const spineUpdated = Date.parse(task.updatedAt || task.startedAt || '') || 0;
    const recency = Math.max(st.mtimeMs, spineUpdated);
    if (nowMs - recency > LIVE_WINDOW_MS) continue; // only live sessions
    entries.push({ sessionId: task.sessionId, task, transcriptSize: st.size });
  }
  return summarizeArchiveHealth(entries, nowMs);
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const r = probeSessionArchive(Date.now());
  if (process.argv.includes('--json')) console.log(JSON.stringify(r, null, 2));
  else console.log(`[session-archive-health] ${r.status.toUpperCase()}: ${r.detail}`);
}
