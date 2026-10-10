#!/usr/bin/env node
/**
 * backfill-dispatch-queue.js — one-shot: take all kind:"dispatch" entries
 * from briefing-actions.jsonl (EC2 source of truth for dashboard clicks) and
 * write them into dispatch-queue.jsonl so process-dispatches.js can process
 * them. Only entries from the last 48h that aren't already in the queue.
 *
 * Usage:
 *   node scripts/backfill-dispatch-queue.js [--since 48h] [--dry-run]
 */

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const ROOT = fs.existsSync('/opt/secondbrain') ? '/opt/secondbrain' : REPO;
const ACTIONS = path.join(ROOT, 'data', 'agent', 'briefing-actions.jsonl');
const QUEUE = path.join(ROOT, 'data', 'agent', 'dispatch-queue.jsonl');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const sinceArg = (() => {
  const i = args.indexOf('--since');
  return i >= 0 ? args[i + 1] : '48h';
})();

function parseSince(s) {
  const m = s.match(/^(\d+)([hdm])$/);
  if (!m) return 48 * 3600 * 1000;
  const n = Number(m[1]);
  const unit = m[2];
  const mult = unit === 'h' ? 3600000 : unit === 'd' ? 86400000 : 60000;
  return n * mult;
}

const cutoff = Date.now() - parseSince(sinceArg);

if (!fs.existsSync(ACTIONS)) {
  console.error(`[backfill] ${ACTIONS} does not exist`);
  process.exit(2);
}

const queued = new Set();
if (fs.existsSync(QUEUE)) {
  for (const line of fs.readFileSync(QUEUE, 'utf8').split('\n').filter(Boolean)) {
    try {
      const e = JSON.parse(line);
      queued.add([e.ts, e.section, e.itemRef, e.comment].join('|'));
    } catch { /* skip */ }
  }
}

const lines = fs.readFileSync(ACTIONS, 'utf8').split('\n').filter(Boolean);
const pending = [];
for (const line of lines) {
  let e; try { e = JSON.parse(line); } catch { continue; }
  if (e.kind !== 'dispatch') continue;
  const t = Date.parse(e.ts);
  if (!t || t < cutoff) continue;
  const key = [e.ts, e.section, e.itemRef || '', e.comment || ''].join('|');
  if (queued.has(key)) continue;
  pending.push({
    ts: e.ts,
    source: 'dashboard_backfill',
    date: e.date || null,
    section: e.section || null,
    itemRef: e.itemRef || null,
    comment: e.comment || '',
    status: 'queued',
  });
}

if (dryRun) {
  console.log(JSON.stringify({ pendingCount: pending.length, sample: pending.slice(0, 3) }, null, 2));
  process.exit(0);
}

fs.mkdirSync(path.dirname(QUEUE), { recursive: true });
for (const e of pending) fs.appendFileSync(QUEUE, JSON.stringify(e) + '\n');
console.log(JSON.stringify({ backfilled: pending.length, queue: QUEUE }, null, 2));
