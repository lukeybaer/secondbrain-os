#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  ctDate,
  filesystemSnapshot,
  storageDecision,
  freeSpaceStatus,
} = require('./lib/storage-pressure-maintenance.js');
const { planRetention, applyRetention } = require('./lib/storage-pressure-retention.js');
const datedLedger = require('./lib/dated-jsonl-ledger.js');

const DATA_DIR = process.env.SECONDBRAIN_DATA_DIR || '/opt/secondbrain/data';
const ROOT = path.join(DATA_DIR, 'agent', 'storage-pressure');
const BASELINE = path.join(ROOT, 'cleanup-baseline.json');
const AGENT_DIR = path.join(DATA_DIR, 'agent');
// PACKET C (item 2, 2026-09-01; self-heal-runs split added in the fix round):
// retention window for the dated-ledger directories
// (overnight-agentic-healer-runs, overnight-self-heal-runs) plus a residual
// age-trim of the frozen legacy flat self-heal-runs file. 14 days
// comfortably covers the longest observed resumable-repair gap (test
// fixtures span 07-22 to 07-26, a 4-day gap) and the report/window reads
// that only ever need 2. overnight-report-events is deliberately excluded --
// scripts/lib/storage-pressure-retention.js's deny-list already says report
// events are never touched by any storage-pressure maintenance path, and a
// second compaction path here silently pruned it anyway until the 2026-09-01
// fix round removed it (see compactLedgers below).
const LEDGER_RETENTION_DAYS = datedLedger.DEFAULT_RETENTION_DAYS;

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

function readDailySamples() {
  const directory = path.join(ROOT, 'daily');
  let files = [];
  try {
    files = fs.readdirSync(directory).filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name));
  } catch {
    return [];
  }
  return files.map((name) => readJson(path.join(directory, name))).filter(Boolean);
}

// Rewrites a flat JSONL ledger in place, atomically, dropping only rows
// older than retainDays. A row with no parseable `ts`/`date` is KEPT -- a
// compaction bug must never silently erase evidence it cannot date. Used for
// the pre-split overnight-self-heal-runs.jsonl legacy file: it stopped
// receiving new writes once overnight-self-heal-orchestrator.js's production
// path started routing into the dated ledger directory (fix round,
// 2026-09-01), but its residual pre-split history still benefits from an age
// ceiling on top of the readers' own bounded windows.
function compactFlatJsonlByAge(
  file,
  { retainDays = LEDGER_RETENTION_DAYS, now = new Date() } = {},
) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { present: false, kept: 0, removed: 0 };
  }
  const cutoffMs =
    now.getTime() - Math.max(1, Number(retainDays) || LEDGER_RETENTION_DAYS) * 24 * 60 * 60 * 1000;
  const lines = text.split(/\r?\n/).filter(Boolean);
  const kept = [];
  let removed = 0;
  for (const line of lines) {
    let row = null;
    try {
      row = JSON.parse(line);
    } catch {
      // an unparseable line is kept, not dropped: compaction is not the
      // place to also be the corruption filter.
    }
    const tsMs = row ? Date.parse(String(row.ts || row.date || '')) : NaN;
    if (Number.isFinite(tsMs) && tsMs < cutoffMs) {
      removed += 1;
      continue;
    }
    kept.push(line);
  }
  if (removed > 0) {
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temp, kept.length ? `${kept.join('\n')}\n` : '', 'utf8');
    fs.renameSync(temp, file);
  }
  return { present: true, kept: kept.length, removed };
}

// PACKET C (item 2): daily compaction/retention for the ledgers that used to
// grow unbounded forever (overnight-agentic-healer-runs.jsonl was 29MB/3,257
// lines with no rotation anywhere -- scripts/install-ec2-storage-pressure-maintenance.sh
// only rotates *.log files, never data/agent/*.jsonl). Runs from this
// script's existing 06:05 CT daily invocation, well outside the self-heal
// core doc's 05:00-05:30:59 repair/delivery window, so it never needs a
// second schedule. Best-effort per ledger: one ledger's failure never blocks
// the others or the storage sample itself.
function compactLedgers({ now = new Date(), retainDays = LEDGER_RETENTION_DAYS } = {}) {
  const results = {};
  try {
    results.healerRuns = datedLedger.pruneLedgerDir(
      datedLedger.ledgerDir(DATA_DIR, 'overnight-agentic-healer-runs'),
      { retainDays, now },
    );
  } catch (error) {
    results.healerRuns = { error: error.message || String(error) };
  }
  // overnight-report-events is NEVER pruned or compacted here, or by any
  // other path. scripts/lib/storage-pressure-retention.js's deny-list
  // (FORBIDDEN_PATH_SUBSTRINGS) already refuses to plan or apply against it
  // no matter what root a caller passes; this age-based dated-ledger prune
  // used to bypass that deny-list entirely by pruning the same directory
  // through a second, unguarded path (2026-09-01 fix round). Report events
  // are the raw overnight evidence trail the final delivery audit and report
  // closure bind their evidence-package hash to -- deleting a date's file
  // here silently invalidates that same-date evidence, independent of
  // whatever the reader-side dashboard windows only ever need.
  try {
    // PACKET C (item 2, fix round 2026-09-01): overnight-self-heal-runs.jsonl
    // is now a split per-briefing-date ledger (same shape as healerRuns
    // above), so it gets the same directory prune.
    results.selfHealRuns = datedLedger.pruneLedgerDir(
      datedLedger.ledgerDir(DATA_DIR, 'overnight-self-heal-runs'),
      { retainDays, now },
    );
  } catch (error) {
    results.selfHealRuns = { error: error.message || String(error) };
  }
  try {
    // The frozen pre-split legacy flat file: no longer written to, but a
    // residual age trim keeps its already-committed history from being the
    // one un-bounded thing left in this directory.
    results.selfHealRunsLegacy = compactFlatJsonlByAge(
      path.join(AGENT_DIR, 'overnight-self-heal-runs.jsonl'),
      { retainDays, now },
    );
  } catch (error) {
    results.selfHealRunsLegacy = { error: error.message || String(error) };
  }
  return results;
}

function sample({ markBaseline = false, now = new Date(), statfsSync = fs.statfsSync } = {}) {
  const sampledAt = now.toISOString();
  const snapshot = filesystemSnapshot(statfsSync(DATA_DIR));
  const status = freeSpaceStatus(snapshot.available_bytes);
  const row = {
    schema: 'secondbrain.storage-pressure-sample.v1',
    sampled_at: sampledAt,
    ct_date: ctDate(now),
    mount_path: DATA_DIR,
    ...snapshot,
    ...status,
  };
  writeJsonAtomic(path.join(ROOT, 'daily', `${row.ct_date}.json`), row);
  writeJsonAtomic(path.join(ROOT, 'latest.json'), row);
  const priorBaseline = readJson(BASELINE, null);
  if (markBaseline && !priorBaseline?.completed_at) {
    writeJsonAtomic(BASELINE, {
      schema: 'secondbrain.storage-cleanup-baseline.v1',
      completed_at: sampledAt,
      note: 'post log-rotation and strict no-force worktree cleanup baseline',
      filesystem: snapshot,
    });
  }
  const baseline = readJson(BASELINE, {});
  const decision = storageDecision({
    samples: readDailySamples(),
    baselineAt: baseline.completed_at || '',
  });
  writeJsonAtomic(path.join(ROOT, 'decision.json'), decision);
  const compaction = compactLedgers({ now });
  return { sample: row, baseline: baseline.completed_at || null, decision, compaction };
}

// The actual prune pass (Packet S, 2026-09-01). Dry-run by default: builds the
// plan and writes a receipt of what WOULD be removed. `apply:true` (wired to
// the CLI --apply flag, which only the timer's run wrapper passes) executes
// it. Either way a receipt lands under data/agent/storage-pressure/ -- a
// dry-run receipt is proof the job ran even on a night nothing was eligible.
function retention({ apply = false, now = new Date() } = {}) {
  const ctToday = ctDate(now);
  const plan = planRetention({ dataDir: DATA_DIR, now, todayCtDate: ctToday });
  const receipt = applyRetention({ dataDir: DATA_DIR, plan, apply });
  writeJsonAtomic(path.join(ROOT, 'retention', `${ctToday}.json`), receipt);
  writeJsonAtomic(path.join(ROOT, 'retention-latest.json'), receipt);
  return receipt;
}

const KNOWN_ARGS = ['--sample', '--mark-baseline', '--retention', '--apply'];

function main() {
  try {
    const args = new Set(process.argv.slice(2));
    for (const arg of args) {
      if (!KNOWN_ARGS.includes(arg)) throw new Error(`unknown argument: ${arg}`);
    }
    if (args.has('--retention')) {
      const result = retention({ apply: args.has('--apply') });
      console.log(JSON.stringify(result));
      return;
    }
    if (args.has('--apply') && !args.has('--retention')) {
      throw new Error('--apply requires --retention');
    }
    const result = sample({ markBaseline: args.has('--mark-baseline') });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(`[storage-pressure] ${error.message || error}`);
    process.exitCode = 2;
  }
}

if (require.main === module) main();

module.exports = {
  readDailySamples,
  sample,
  retention,
  compactLedgers,
  compactFlatJsonlByAge,
  LEDGER_RETENTION_DAYS,
};
