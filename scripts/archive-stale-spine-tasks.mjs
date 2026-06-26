#!/usr/bin/env npx tsx
// One-shot journaled archive sweep of the Task Spine (Amy E2E overhaul rank 12,
// approved 2026-06-11). Usage:
//   npx tsx scripts/archive-stale-spine-tasks.mjs --dry-run
//   npx tsx scripts/archive-stale-spine-tasks.mjs
//   npx tsx scripts/archive-stale-spine-tasks.mjs --rollback <journal.jsonl>
import path from 'node:path';
import { sweepArchive, rollbackSweep } from '../src/main/task-archive';

const APPDATA = process.env.APPDATA || '';
const TASKS_DIR = process.env.SB_TASKS_DIR || path.join(APPDATA, 'secondbrain', 'data', 'tasks');
const REPO = path.resolve(new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), '..');
const JOURNAL = path.join(REPO, 'data', 'agent', `spine-archive-sweep-${new Date().toISOString().slice(0, 10)}.jsonl`);

const args = process.argv.slice(2);
if (args[0] === '--rollback') {
  const restored = rollbackSweep(TASKS_DIR, args[1]);
  console.log(`[rollback] restored ${restored} tasks from ${args[1]}`);
} else {
  const dryRun = args.includes('--dry-run');
  const summary = sweepArchive(TASKS_DIR, Date.now(), JOURNAL, { dryRun });
  console.log(
    `[sweep${dryRun ? ' DRY-RUN' : ''}] scanned=${summary.scanned} archived=${summary.archived} skipped=${summary.skipped} unparseable=${summary.unparseable}`
  );
  if (!dryRun && summary.archived) console.log(`journal: ${JOURNAL}`);
}
