#!/usr/bin/env node
/**
 * One-time migration: revoke execution authority from legacy Gmail ingest tasks.
 *
 * Until 2026-08-02 `recordGmailMessage()` set `approved` and
 * `meta.explicitRequest` from an unauthenticated marker in the raw email body,
 * and `ec2-spine-worker.claimOne()` admits on either flag. The code fix stops
 * NEW poisoned rows, but `approved: true` already on disk is sticky, so every
 * pre-fix nonterminal Gmail ingest task stays claimable after deploy. Codex
 * adversarial review 2026-08-02 required this migration alongside the fix.
 *
 * A Gmail ingest record is history. Execution for email belongs solely to the
 * authenticated dispatch task. This revokes the flags, records why in task
 * history, and never deletes anything.
 *
 * Usage:
 *   node scripts/quarantine-legacy-gmail-ingest-authority.js            # report only
 *   node scripts/quarantine-legacy-gmail-ingest-authority.js --apply
 */

const fs = require('fs');
const path = require('path');

// The canonical terminal set, shared rather than duplicated so a change to the
// state machine cannot silently desync this migration. `failed` is NOT terminal
// there: a retry re-queues the task, so a poisoned failed task would otherwise
// keep its authority and regain claimability on the next retry.
const { TERMINAL_STATUSES } = require('./lib/task-terminal-status');

const TERMINAL = new Set(TERMINAL_STATUSES);
const REASON =
  'Execution authority revoked: a Gmail ingest record is history, never a command. ' +
  'It was approved from an unauthenticated email marker before 2026-08-02.';

function defaultTasksDir() {
  if (process.env.SECONDBRAIN_SPINE_TASKS_DIR) return process.env.SECONDBRAIN_SPINE_TASKS_DIR;
  if (process.env.SECONDBRAIN_DATA_DIR) return path.join(process.env.SECONDBRAIN_DATA_DIR, 'tasks');
  if (process.platform === 'linux' && fs.existsSync('/opt/secondbrain')) {
    return '/opt/secondbrain/data/tasks';
  }
  return path.join(process.env.APPDATA || process.cwd(), 'secondbrain', 'data', 'tasks');
}

/** A task the worker could claim purely because of the legacy ingest bug. */
function isLegacyClaimableGmailIngest(task) {
  if (!task || String(task.origin || '').toLowerCase() !== 'gmail') return false;
  if (((task.source || {}).type || '') !== 'gmail-message') return false;
  if (TERMINAL.has(String(task.status || ''))) return false;
  const meta = task.meta || {};
  return task.approved === true || meta.explicitRequest === true;
}

function revoke(task, nowIso) {
  const next = {
    ...task,
    approved: false,
    meta: { ...(task.meta || {}), explicitRequest: false, executionAuthorityRevoked: true },
    history: [
      ...(Array.isArray(task.history) ? task.history : []),
      { at: nowIso, event: 'execution_authority_revoked', detail: REASON },
    ],
  };
  return next;
}

function run({
  tasksDir = defaultTasksDir(),
  apply = false,
  nowIso = new Date().toISOString(),
} = {}) {
  if (!fs.existsSync(tasksDir)) return { scanned: 0, revoked: [], tasksDir };
  const revoked = [];
  let scanned = 0;
  for (const file of fs.readdirSync(tasksDir)) {
    if (!file.endsWith('.json')) continue;
    const full = path.join(tasksDir, file);
    let task;
    try {
      task = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch {
      continue;
    }
    scanned++;
    if (!isLegacyClaimableGmailIngest(task)) continue;
    revoked.push({ file, title: task.title || '', status: task.status || '' });
    if (apply) fs.writeFileSync(full, JSON.stringify(revoke(task, nowIso), null, 2));
  }
  return { scanned, revoked, tasksDir, applied: apply };
}

if (require.main === module) {
  const apply = process.argv.includes('--apply');
  const result = run({ apply });
  console.log(
    `[quarantine] tasksDir=${result.tasksDir} scanned=${result.scanned} ` +
      `claimable-legacy=${result.revoked.length} ${apply ? 'REVOKED' : '(dry run, pass --apply)'}`,
  );
  for (const row of result.revoked) console.log(`  - ${row.file} [${row.status}] ${row.title}`);
}

module.exports = { run, isLegacyClaimableGmailIngest, revoke, defaultTasksDir };
