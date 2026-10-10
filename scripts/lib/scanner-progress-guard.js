'use strict';

// scripts/lib/scanner-progress-guard.js
//
// ExampleCo 2026-08-24: "tasks can't run 95 times doing the same thing. I thought
// things checked for last attempt and changed approach etc."
//
// THE CLASS OF DEFECT. The self-heal NO-REPEAT TACTIC invariant
// (dev-plans/core/self-heal.md invariant 4) governs HEALERS: the same tactic
// plus the same failure fingerprint never repeats, and a repeat must carry
// prior history into diagnosis. It does NOT govern SCHEDULED REPAIR SCANNERS.
// A scanner is the thing that decides there is work; if its own filters
// exclude every queued item, it reports "no work to do" and exits 0 forever
// while the queue stays stuck. Nothing notices, because "no work" and "queue
// is empty" look identical from the outside.
//
// The worked instance: scripts/auto-regen-rejected-videos.js ran 95 times over
// two days printing "no work to do" while 30 of 31 videos in
// content-review/pending/manifest.json carried needs_regen=true AND
// regen_status='dead-letter'. Every one was filtered out by
// isAbandonedNoArtifactStub. Worse, the caller (healVideoFeedbackLoop in
// scripts/health-self-heal.js) then reported healed:true and sent ExampleCo a
// Telegram claiming it had regenerated them.
//
// THE RULE THIS ENCODES. Zero work claimed against a NON-EMPTY queue is not
// success, it is a no-progress run. The same no-progress fingerprint repeating
// is the scanner equivalent of a repeated tactic, and it must escalate rather
// than log the same line forever.
//
// REUSE, NOT A SECOND MECHANISM. The fingerprint hash and the eight-cycle
// ceiling both come from scripts/self-heal/briefing-repair-ledger.js, the
// existing no-repeat machinery. This module adds only the scanner-shaped
// entry point and its durable run history; it deliberately does not restate
// the hashing or the cap.

const fs = require('node:fs');
const path = require('node:path');

const {
  defaultDataDir,
  hashTacticInput,
  MAX_PROCESS_CYCLES,
} = require('../self-heal/briefing-repair-ledger.js');

// Escalate on the third consecutive identical no-progress run. Matches the
// masking-guard threshold in scripts/self-heal/mechanical-recurrence.js so the
// fleet has ONE "this keeps happening" number, and hard-stops at the shared
// MAX_PROCESS_CYCLES ceiling so a scanner can never out-run the no-repeat cap.
const NO_PROGRESS_ESCALATION_THRESHOLD = 3;

function ledgerPath(opts = {}) {
  return path.join(opts.dataDir || defaultDataDir(), 'agent', 'scanner-progress-guard.jsonl');
}

// Stable identity for "this scanner, looking at exactly this stuck set".
// Sorted + de-duped so queue ordering churn never mints a fresh fingerprint
// and silently resets the streak.
function scanFingerprint({ scanner, pendingIds = [] } = {}) {
  const ids = [
    ...new Set((pendingIds || []).map((id) => String(id || '').trim()).filter(Boolean)),
  ].sort();
  return hashTacticInput({ scanner: String(scanner || '').trim(), pendingIds: ids });
}

// A run made no progress when it claimed nothing while the queue still held
// something. An empty queue is a legitimate no-op and never counts.
function isNoProgressRun({ claimed, pendingCount } = {}) {
  return Number(claimed || 0) === 0 && Number(pendingCount || 0) > 0;
}

function readScanRuns(scanner, opts = {}) {
  const file = ledgerPath(opts);
  if (!fs.existsSync(file)) return [];
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed);
      if (!scanner || row.scanner === scanner) rows.push(row);
    } catch {
      /* skip a corrupt line, never wedge the reader */
    }
  }
  return rows;
}

function recordScanRun(row, opts = {}) {
  const file = ledgerPath(opts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const entry = {
    scanner: String(row.scanner || ''),
    fingerprint: String(row.fingerprint || ''),
    pendingCount: Number(row.pendingCount || 0),
    claimed: Number(row.claimed || 0),
    noProgress: isNoProgressRun(row),
    ts: row.ts || new Date().toISOString(),
  };
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
  return entry;
}

// Walk BACKWARD from the most recent run and count the trailing streak of
// no-progress runs carrying this exact fingerprint. Any run that claimed work,
// or that carried a different fingerprint (the stuck set actually changed),
// breaks the streak. That is the "changed input" escape hatch: real movement
// in the queue always resets the counter.
function noProgressState({ scanner, fingerprint, claimed, pendingCount, history } = {}) {
  const rows = (history || []).filter((row) => row && row.scanner === scanner);
  const current = {
    scanner,
    fingerprint,
    claimed: Number(claimed || 0),
    pendingCount: Number(pendingCount || 0),
  };
  const noProgress = isNoProgressRun(current);

  let consecutiveRuns = 0;
  if (noProgress) {
    consecutiveRuns = 1; // this run
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const row = rows[i];
      if (!row.noProgress || row.fingerprint !== fingerprint) break;
      consecutiveRuns += 1;
    }
  }

  const escalate = consecutiveRuns >= NO_PROGRESS_ESCALATION_THRESHOLD;
  const capped = consecutiveRuns >= MAX_PROCESS_CYCLES;

  let reason;
  if (!noProgress) {
    reason =
      current.pendingCount === 0
        ? `${scanner}: queue empty, a no-op run is correct`
        : `${scanner}: claimed ${current.claimed} item(s), progress made`;
  } else if (escalate) {
    reason =
      `${scanner} has now run ${consecutiveRuns} consecutive time(s) claiming zero work while ` +
      `${current.pendingCount} item(s) stayed stuck in its queue. The stuck set has not changed, so ` +
      `re-running the same scan cannot clear it. This needs a changed approach, not another pass` +
      (capped ? `; the ${MAX_PROCESS_CYCLES}-cycle no-repeat ceiling is reached` : '');
  } else {
    reason =
      `${scanner}: ${consecutiveRuns} consecutive no-progress run(s) against ${current.pendingCount} ` +
      `stuck item(s), below the ${NO_PROGRESS_ESCALATION_THRESHOLD}-run escalation threshold`;
  }

  return { noProgress, consecutiveRuns, escalate, capped, reason };
}

// The single call a scheduled scanner (or its caller) makes: record this run
// and get back whether the scanner is spinning. Recording happens BEFORE the
// verdict is computed for the caller's convenience, but the verdict is
// computed against the PRIOR history plus this run, so a run is never counted
// twice.
function evaluateScanRun({ scanner, pendingIds = [], claimed = 0 } = {}, opts = {}) {
  const fingerprint = scanFingerprint({ scanner, pendingIds });
  const pendingCount = new Set(
    (pendingIds || []).map((id) => String(id || '').trim()).filter(Boolean),
  ).size;
  const history = readScanRuns(scanner, opts);
  const state = noProgressState({ scanner, fingerprint, claimed, pendingCount, history });
  recordScanRun({ scanner, fingerprint, pendingCount, claimed }, opts);
  return { ...state, fingerprint, pendingCount, claimed: Number(claimed || 0) };
}

// The control-prefixed line a scanner prints so ANY caller (cron, a healer, a
// human tailing a log) can tell a no-progress run from a real one without
// re-deriving the ledger. Callers must key off this, never off the exit code
// alone, because a fully-filtered scan and a cleared queue both exit zero.
const NO_PROGRESS_MARKER = 'SCANNER-NO-PROGRESS';

// Pre-execution admission. Codex review 2026-08-24 correctly flagged that a
// `capped` flag which still lets the run proceed is advisory, not a ceiling.
// This is the hard stop: once the same no-progress fingerprint has burned the
// shared MAX_PROCESS_CYCLES budget, the scanner is REFUSED before it does any
// work, and only changed input (a different stuck set, or real progress) can
// admit it again.
function scannerAdmission({ scanner, pendingIds = [] } = {}, opts = {}) {
  const fingerprint = scanFingerprint({ scanner, pendingIds });
  const pendingCount = new Set((pendingIds || []).map((id) => String(id || '').trim()).filter(Boolean))
    .size;
  const state = noProgressState({
    scanner,
    fingerprint,
    claimed: 0,
    pendingCount,
    history: readScanRuns(scanner, opts),
  });
  // consecutiveRuns here counts prior no-progress runs plus this hypothetical
  // one, so refuse at the point where admitting it would exceed the ceiling.
  const blocked = pendingCount > 0 && state.consecutiveRuns > MAX_PROCESS_CYCLES;
  return {
    blocked,
    fingerprint,
    pendingCount,
    priorNoProgressRuns: Math.max(0, state.consecutiveRuns - 1),
    reason: blocked
      ? `${scanner} already burned the ${MAX_PROCESS_CYCLES}-run no-repeat budget against this exact ` +
        `stuck set of ${pendingCount} item(s). Refusing to scan again: the input has not changed, so ` +
        `another identical pass cannot help. This needs a changed approach or owner action`
      : `${scanner} admitted`,
  };
}

module.exports = {
  NO_PROGRESS_MARKER,
  scannerAdmission,
  MAX_PROCESS_CYCLES,
  NO_PROGRESS_ESCALATION_THRESHOLD,
  evaluateScanRun,
  isNoProgressRun,
  ledgerPath,
  noProgressState,
  readScanRuns,
  recordScanRun,
  scanFingerprint,
};
