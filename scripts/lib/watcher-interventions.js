'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { briefingRunWindow } = require('./briefing-run-window.js');
const { filterQuarantinedObservations } = require('./watch-observation-trust.js');

function watcherObservationPath(dataDir) {
  return path.join(dataDir, 'agent', 'overnight-watch-observations.jsonl');
}

function watcherHeartbeatPath(dataDir) {
  return path.join(dataDir, 'agent', 'watcher-heartbeat.json');
}

function watcherWatchReportPath(dataDir, date) {
  return path.join(dataDir, 'briefings', `watch-report-${String(date).slice(0, 10)}.html`);
}

// States the launcher writes while the watcher is actually alive. Anything else
// (crashed, exhausted, failed, an unknown future string, or a missing value) is
// not proof of life and must not read as green.
// Wait states the model-free terminal coordinator writes between polls
// (2026-09-06: these were missing from the contract, so the supervisor graded
// a live coordinator as WATCHER-DOWN all night and escalated twice). Every
// state overnight-watcher-launcher.js can setState() must appear here;
// overnight-report-goal-ranking.test.js derives that list from the launcher
// source so a new state cannot silently read as a crash again.
const COORDINATOR_WAIT_STATES = [
  'waiting-materialized-state',
  'waiting-settlement-lock',
  'waiting-terminal-assessment-reserve',
  'report-research',
  'terminal-delivery',
];
const LIVE_WATCHER_STATES = new Set([
  'running',
  'starting',
  'relaunching',
  'waiting-assessment-cap',
  'waiting-evidence-gate-retry',
  'waiting-night-spend-circuit',
  'waiting-unchanged',
  ...COORDINATOR_WAIT_STATES,
  'finished-early',
  'finished',
  'repair-cutoff',
]);
// Of those, only the in-progress states are expected to keep beating. A watcher
// that reached `finished`, `finished-early`, or `repair-cutoff` deliberately stopped its 60s
// heartbeat, so its last beat is settled history, not staleness. Grading a
// terminal state on beat freshness turns every successful night red a few
// minutes after the watcher exits. Verified 2026-08-03 against the real night:
// the watcher closed finished-early at 5:07 AM CT with a finalized report on
// the cloud root, and the measurement still read red.
const IN_PROGRESS_WATCHER_STATES = new Set([
  'running',
  'starting',
  'relaunching',
  'waiting-assessment-cap',
  'waiting-evidence-gate-retry',
  'waiting-night-spend-circuit',
  'waiting-unchanged',
  ...COORDINATOR_WAIT_STATES,
]);
// The states the launcher writes when the watcher has STOPPED for the night.
// Once it has stopped, the report is due: there is nothing left that could
// still write it.
const TERMINAL_WATCHER_STATES = new Set(['finished', 'finished-early', 'repair-cutoff']);
const WATCHER_HEARTBEAT_MAX_AGE_MS = 45 * 60 * 1000;
const WATCHER_EXPECTED_START_EARLY_MS = 15 * 60 * 1000;
const HEARTBEAT_MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
// Kept in sync with FINALIZED_REPORT_MARKER / LLM_ANALYSIS_MARKER in
// scripts/overnight-watch-report.js. Duplicated rather than imported because
// that module requires this one; `watcher-liveness-health.test.js` pins the
// markers against the real constants so the copies cannot drift.
const FINALIZED_REPORT_MARKER = '<meta name="watch-report-finalized" content="true">';
const LLM_ANALYSIS_MARKER = '<meta name="watch-report-analysis" content="llm">';

function rootStoresWatchReports(dataDir) {
  try {
    return fs
      .readdirSync(path.join(dataDir, 'briefings'))
      .some((name) => /^watch-report-\d{4}-\d{2}-\d{2}\.html$/.test(name));
  } catch {
    return false;
  }
}

function finalizedWatchReportExists(dataDir, day) {
  let html;
  try {
    html = fs.readFileSync(watcherWatchReportPath(dataDir, day), 'utf8');
  } catch {
    return false;
  }
  return html.includes(FINALIZED_REPORT_MARKER) && html.includes(LLM_ANALYSIS_MARKER);
}

function readJsonFile(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    // A missing or torn heartbeat is absent evidence, not permission to
    // conclude the watcher was alive.
    return null;
  }
}

// Exact System Health measurement `system_health:watcher-liveness`.
//
// The one practical question this row answers: did the overnight watcher
// actually run and finish its report last night? That matters because the
// watcher is what repairs the briefing while ExampleCo sleeps. If it never ran, or
// ran and died without finishing, the morning briefing is unrepaired and
// nobody noticed.
//
// Green requires the watcher to be either still working right now, or stopped
// with its dated report written. Red covers never started, started under a
// stale or inherited record, stopped in a failure state, gone silent
// mid-night, stopped without writing the report, or past the 5:30 AM briefing
// deadline with no report. Audit-only: it states what the durable receipts
// show and never repairs anything.
function watcherLivenessHealth({ dataDir, date, nowMs = Date.now() } = {}) {
  const day = String(date || '').slice(0, 10);
  const dated = /^\d{4}-\d{2}-\d{2}$/.test(day);
  if (!dated) {
    // A caller that never named a night has not asked an answerable question.
    // Absence of a question is not evidence of a dead watcher, and a render
    // path that omits the date must not manufacture a defect. Every production
    // caller supplies it; `watcher-liveness-call-sites` pins that mechanically.
    return {
      ok: true,
      heartbeatPresent: false,
      reportPresent: false,
      atOrPastDelivery: false,
      state: '',
      sessionCount: 0,
      lastBeatAt: '',
      runtime: '',
      undated: true,
      detail:
        'The overnight watcher check needs a briefing date; none was supplied for this render.',
    };
  }
  const heartbeat = dataDir ? readJsonFile(watcherHeartbeatPath(dataDir)) : null;
  // A heartbeat from a previous night proves nothing about tonight, and a
  // heartbeat that exists but reports a dead or exhausted watcher is evidence
  // of failure, not of life. Parseability is not health.
  const sameNight = Boolean(heartbeat) && String(heartbeat.date || '').slice(0, 10) === day;
  const state = sameNight
    ? String(heartbeat.state || '')
        .trim()
        .toLowerCase()
    : '';
  const stateAlive = LIVE_WATCHER_STATES.has(state);
  const attemptId = sameNight ? String(heartbeat.attemptId || '').trim() : '';
  const startedAtMs = sameNight ? Date.parse(String(heartbeat.startedAt || '')) : NaN;
  const runWindow = briefingRunWindow(day);
  const sameAttempt =
    Boolean(attemptId) &&
    Number.isFinite(startedAtMs) &&
    startedAtMs >= runWindow.inputStartMs - WATCHER_EXPECTED_START_EARLY_MS &&
    startedAtMs <= Number(nowMs) + HEARTBEAT_MAX_CLOCK_SKEW_MS;
  const beatMs = sameNight ? Date.parse(String(heartbeat.lastBeatAt || '')) : NaN;
  // The launcher beats every 60s. Allow a wide multiple so a slow host is not
  // called dead, while a heartbeat frozen for the better part of an hour is.
  const inProgress = IN_PROGRESS_WATCHER_STATES.has(state);
  const beatFresh =
    !inProgress ||
    (Number.isFinite(beatMs) && Number(nowMs) - beatMs <= WATCHER_HEARTBEAT_MAX_AGE_MS);
  // A terminal heartbeat must still be readable: an unparseable lastBeatAt is
  // absent evidence in every state.
  const heartbeatPresent =
    sameNight && sameAttempt && stateAlive && beatFresh && Number.isFinite(beatMs);
  // Existence is not proof: an empty or unfinalized preview must not clear the
  // deadline condition. Require the same finalized markers the delivery audit
  // requires, without importing the report module back into this one.
  const reportPresent = dataDir ? finalizedWatchReportExists(dataDir, day) : false;
  const reportArtifactPresent = dataDir
    ? fs.existsSync(watcherWatchReportPath(dataDir, day))
    : false;
  // Dated watch reports are written on the cloud root. A root that has never
  // stored one does not own the artifact, so a missing report there is not
  // evidence of a failed night. Ownership is proven from reports already on
  // disk, never assumed: once a root has stored one, a gap is real. Verified
  // 2026-08-03 against the live roots, where the desktop runtime root held the
  // synced heartbeat and zero watch reports while EC2 held both.
  const rootOwnsReports = reportPresent || (dataDir ? rootStoresWatchReports(dataDir) : false);
  const deliveryDueMs = /^\d{4}-\d{2}-\d{2}$/.test(day)
    ? briefingRunWindow(day, { dataDir }).deliveryDeadlineMs
    : null;
  const atOrPastDelivery = Number.isFinite(deliveryDueMs) && Number(nowMs) >= deliveryDueMs;
  // OUTCOME GRADING (2026-08-24 redesign). The practical thing this row
  // protects is the finished overnight report, not the existence of a
  // heartbeat file. A watcher that has already STOPPED owes that report now,
  // whether or not the 5:30 CT delivery deadline has passed. Before this
  // change the only report condition was keyed to the deadline, and the
  // overnight render that produces ExampleCo's briefing runs BEFORE the deadline,
  // so a night where the watcher started, wrote a heartbeat, then stopped
  // without ever finishing a report rendered green in the briefing he reads.
  // The proxy (a heartbeat file exists) passed while the outcome (a finished
  // report) was missing. Fail closed on the outcome instead.
  const watcherStopped = TERMINAL_WATCHER_STATES.has(state);
  const reportMissingAfterStop =
    heartbeatPresent && watcherStopped && !reportPresent && rootOwnsReports;
  const reportOverdue =
    (atOrPastDelivery && !reportPresent && rootOwnsReports) || reportMissingAfterStop;
  const ok = heartbeatPresent && !reportOverdue;
  const reasons = [];
  if (!sameNight) {
    reasons.push(`nothing shows the overnight watcher started for ${day}`);
  } else if (!sameAttempt) {
    reasons.push(
      !attemptId
        ? `the ${day} watcher record carries no launch id, so it may be left over from an earlier night`
        : `the ${day} watcher record started outside the overnight window, so it is not last night's run`,
    );
  } else if (!stateAlive) {
    reasons.push(
      `the overnight watcher is neither running nor finished; its last status was "${state || 'unset'}"`,
    );
  } else if (!beatFresh) {
    reasons.push(
      `the overnight watcher last checked in at ${String(heartbeat.lastBeatAt || 'an unreadable time')} and has been silent since`,
    );
  }
  if (reportMissingAfterStop) {
    reasons.push(
      reportArtifactPresent
        ? `the overnight watcher stopped leaving only an unfinished draft of its ${day} report`
        : `the overnight watcher stopped without writing its ${day} report`,
    );
  } else if (reportOverdue) {
    reasons.push(
      reportArtifactPresent
        ? `the ${day} watcher report was still an unfinished draft at the 5:30 AM briefing deadline`
        : `the ${day} watcher report was still missing at the 5:30 AM briefing deadline`,
    );
  }
  // Never claim a report this root does not hold. A root that has never stored
  // one grades the run alone, and says only that.
  const sessionCount = sameNight ? Number(heartbeat.sessionCount || 0) : 0;
  const detail = ok
    ? reportPresent
      ? `The overnight watcher ran on its own and finished its ${day} report.`
      : watcherStopped
        ? `The overnight watcher ran on its own for ${day} and finished.`
        : `The overnight watcher is running now for ${day}${
            sessionCount ? ` (${sessionCount} session${sessionCount === 1 ? '' : 's'} so far)` : ''
          }.`
    : `${reasons.join('; ')}.`;
  const recovery = ok
    ? 'No repair needed.'
    : heartbeatPresent && reportOverdue
      ? 'Fix whatever stopped the watcher from finishing its report, then run the night again. Never add report markers or drop a placeholder report to clear this row.'
      : 'Fix the scheduled overnight watcher task or the machine it runs on, then run the night again. Never hand-write the watcher record to clear this row.';
  return {
    ok,
    heartbeatPresent,
    reportPresent,
    reportArtifactPresent,
    atOrPastDelivery,
    sameNight,
    sameAttempt,
    attemptId,
    startedAt: sameNight ? String(heartbeat.startedAt || '') : '',
    stateAlive,
    beatFresh,
    state: sameNight ? String(heartbeat.state || '') : '',
    sessionCount: sameNight ? Number(heartbeat.sessionCount || 0) : 0,
    lastBeatAt: sameNight ? String(heartbeat.lastBeatAt || '') : '',
    runtime: sameNight ? String(heartbeat.runtime || '') : '',
    watcherStopped,
    reportMissingAfterStop,
    detail,
    conclusion: ok
      ? 'The overnight watcher ran.'
      : 'The overnight watcher did not finish its night.',
    recovery,
    action: ok ? 'Continue nightly verification.' : recovery,
    topLevelDetail: ok
      ? detail
      : `Expected: the overnight watcher runs by itself overnight and finishes its ${day} report before the 5:30 AM briefing. Actual: ${detail} Fix: ${recovery}`,
  };
}

function readJsonlRows(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') rows.push(parsed);
    } catch {
      // A torn observation line is absent evidence, not permission to invent it.
    }
  }
  return rows;
}

function watcherInterventionIdentity(row = {}, { canonicalKeyByAlias } = {}) {
  const date = String(row.date || '').slice(0, 10);
  const key = String(row.key || '')
    .trim()
    .toLowerCase();
  let canonicalKey = key;
  // Correction rows may name a differently-worded alias that represents the
  // same attended action. Resolve aliases before calculating the durable
  // identity so the append-only ledger can be corrected without rewriting its
  // original evidence.
  const seen = new Set();
  while (canonicalKey && canonicalKeyByAlias?.has(`${date}\u0000${canonicalKey}`)) {
    if (seen.has(canonicalKey)) break;
    seen.add(canonicalKey);
    canonicalKey = canonicalKeyByAlias.get(`${date}\u0000${canonicalKey}`);
  }
  const processId = String(row.processId || '')
    .trim()
    .toLowerCase();
  // `key` is the durable intervention identity. A corrected receipt may be
  // produced by a different controller/process, but it is still the same
  // attended rescue and must not inflate the daily defect count. Legacy rows
  // without a key fall back to their process identity.
  if (canonicalKey) return `${date}\u0000key:${canonicalKey}`;
  if (processId) return `${date}\u0000process:${processId}`;
  return '';
}

function dedupeWatcherInterventions(rows = []) {
  const canonicalKeyByAlias = new Map();
  for (const row of rows) {
    if (!row || String(row.kind || '').toLowerCase() !== 'intervention') continue;
    const date = String(row.date || '').slice(0, 10);
    const key = String(row.key || '')
      .trim()
      .toLowerCase();
    const canonicalKey = String(row.canonicalKey || '')
      .trim()
      .toLowerCase();
    if (date && key && canonicalKey && key !== canonicalKey) {
      canonicalKeyByAlias.set(`${date}\u0000${key}`, canonicalKey);
    }
  }
  const unique = new Map();
  for (const row of rows) {
    if (!row || String(row.kind || '').toLowerCase() !== 'intervention') continue;
    const identity = watcherInterventionIdentity(row, { canonicalKeyByAlias });
    if (!identity.replace(/\u0000/g, '')) continue;
    // The observation ledger is append-only. A later row with the same stable
    // identity is a correction/retry receipt, not a second attended rescue.
    // When a different alias names an existing canonical key, preserve the
    // canonical receipt for presentation while retaining both ledger rows.
    const current = unique.get(identity);
    const rowIsCanonical = watcherInterventionIdentity(row) === identity;
    const currentIsCanonical = current && watcherInterventionIdentity(current) === identity;
    if (!current || rowIsCanonical || !currentIsCanonical) unique.set(identity, row);
  }
  return [...unique.values()];
}

function watcherInterventionsForDate({ dataDir, date } = {}) {
  const day = String(date || '').slice(0, 10);
  if (!dataDir || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return [];
  const datedRows = readJsonlRows(watcherObservationPath(dataDir)).filter(
    (row) => String(row.date || '').slice(0, 10) === day,
  );
  return dedupeWatcherInterventions(
    filterQuarantinedObservations(datedRows, { dataDir, date: day }).rows,
  );
}

function watcherInterventionHealth({ dataDir, date } = {}) {
  const day = String(date || '').slice(0, 10);
  const rows = watcherInterventionsForDate({ dataDir, date: day });
  const count = rows.length;
  return {
    // An intervention is immutable dated evidence that an autonomy service
    // target failed. Keep that exact metric red and non-actionable, while its
    // classification/date prevent it from masquerading as current watcher,
    // report, or delivery health.
    ok: count === 0,
    status: count === 0 ? 'green' : 'red',
    classification: count === 0 ? 'current-no-failure' : 'historical-service-target-failure',
    date: day,
    actionable: false,
    count,
    rows,
    detail:
      count === 0
        ? `0 interventions recorded for ${day}; the autonomous loops needed no attended rescue.`
        : `Dated service-target failure for ${day}: ${count} watcher intervention${count === 1 ? '' : 's'} recorded; the current watcher, report, and delivery states are graded independently from their same-cutoff evidence.`,
  };
}

// Single definition of "what does the live board's watcher-interventions row
// say", shared by every caller that needs to compare a board against the
// canonical same-date ledger (overnight-watch-report.js's reconciler and
// briefing-final-delivery-audit.js's delivery gate previously each carried
// their own copy of this lookup, which could drift).
function watcherInterventionBoardMetric(board) {
  const systemHealth = (Array.isArray(board?.cards) ? board.cards : []).find(
    (card) => String(card?.id || '').toLowerCase() === 'system_health',
  );
  const topLevelMeasurements = Array.isArray(board?.systemHealthMeasurements)
    ? board.systemHealthMeasurements
    : [];
  const nestedMeasurements = Array.isArray(systemHealth?.workUnits) ? systemHealth.workUnits : [];
  // The production live-board artifact keeps canonical work-unit truth in the
  // top-level systemHealthMeasurements array. Older fixtures and callers may
  // still carry it on the System Health card, so retain that as a compatibility
  // fallback without allowing a stale nested row to override the canonical one.
  return [...topLevelMeasurements, ...nestedMeasurements].find(
    (workUnit) =>
      String(workUnit?.id || '').toLowerCase() === 'system_health:watcher-interventions',
  );
}

// Full proof object: whether the board's watcher-interventions row agrees
// with the canonical same-date ledger count, both as individual fields
// (present/status/count/expectedStatus/countMatches/statusMatches, the shape
// briefing-final-delivery-audit.js's delivery gate has always used) and as a
// single `matches` boolean (the shape overnight-watch-report.js's reconciler
// has always used).
function watcherInterventionMetricProof(board, expectedCount) {
  const metric = watcherInterventionBoardMetric(board);
  const present = Boolean(metric);
  const status = present
    ? String(metric.status || '')
        .trim()
        .toLowerCase()
    : '';
  const detail = present ? String(metric.detail || '') : '';
  const countMatch = detail.match(/\b(\d+)\s+(?:watcher\s+)?interventions?\b/i);
  const count = countMatch ? Number(countMatch[1]) : null;
  // A same-date watcher intervention is a current autonomy failure, so a
  // positive count must read red; zero must read green. Keep every caller on
  // this one truth vocabulary.
  const expectedStatus = Number(expectedCount) > 0 ? 'red' : 'green';
  const statusMatches = status === expectedStatus;
  const countMatches = Number.isFinite(count) && count === Number(expectedCount);
  // Delivery-gate status rule: the board must never HIDE a rescue. A red row
  // whose exact count is zero overstates but hides nothing, so it is honest
  // enough to deliver. Yellow, unknown, or empty with zero is neither the
  // expected green nor an honest red, so it still fails.
  const statusDeliverable =
    statusMatches ||
    (status === 'red' && countMatches && Number(expectedCount) === 0);
  return {
    present,
    status,
    count,
    expectedCount: Number(expectedCount) || 0,
    expectedStatus,
    countMatches,
    statusMatches,
    statusDeliverable,
    matches: present && statusMatches && countMatches,
  };
}

// Exported so the exact-metric source contract can put the delivery-due phase in
// its evidence digest: this measurement's status depends on wall-clock time, not
// only on file contents.
function watcherReportDueMs(date) {
  const day = String(date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return Number.POSITIVE_INFINITY;
  return briefingRunWindow(day).deliveryDeadlineMs;
}

module.exports = {
  IN_PROGRESS_WATCHER_STATES,
  LIVE_WATCHER_STATES,
  dedupeWatcherInterventions,
  watcherReportDueMs,
  watcherHeartbeatPath,
  watcherLivenessHealth,
  readJsonlRows,
  watcherInterventionBoardMetric,
  watcherInterventionHealth,
  watcherInterventionIdentity,
  watcherInterventionMetricProof,
  watcherInterventionsForDate,
  watcherObservationPath,
};
