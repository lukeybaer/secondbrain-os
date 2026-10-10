'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { attemptRowsFromCycleReceipts } = require('./healer-attempt-history.js');
const { buildOtterCallGraph } = require('./otter-call-processing-graph.js');
const { pauseState, RECOVERY_SCHEMA } = require('./otter-healer-pause.js');

const THROUGHPUT_STALL_MINUTES = 12 * 60;

// Completion-throughput honesty facts: an open queue with zero closures for
// half a day and no valid (unexpired) pause is a defect, not quiet; the
// 2026-07-31 overnight produced exactly that state with zero signal. An
// expired pause file still present means the lane runner/cron is not
// observing pauses and is independently red.
function completionThroughputFacts({ vpDir, ledger, nowMs, fsApi = fs }) {
  const settlementsDir = path.join(vpDir, 'otter-call-closure-settlements');
  // Only a COMMITTED settlement counts as a closure. Journals are written in
  // `prepared` and intermediate states before commitment, so a crashed or
  // half-finished settlement must never refresh throughput (Codex diff
  // review 2026-08-02, finding 3). Timestamps come from the receipt itself,
  // never file mtime.
  const committed = [];
  try {
    for (const name of fsApi.readdirSync(settlementsDir)) {
      // Only canonical settlement journals count: sha256-named .json with the
      // settlement schema and exact call identity. A crash-orphaned tmp file
      // or foreign JSON claiming "committed" must never refresh throughput
      // (Codex review f40fbcb97dc5).
      if (!/^[a-f0-9]{64}\.json$/i.test(name)) continue;
      let row;
      try {
        row = JSON.parse(
          String(fsApi.readFileSync(path.join(settlementsDir, name), 'utf8')).replace(/^﻿/, ''),
        );
      } catch {
        continue;
      }
      if (String(row?.schema || '') !== 'life_archive_otter_call_closure_settlement.v1') continue;
      if (
        !String(row?.otid || '') ||
        !/^[a-f0-9]{64}$/.test(String(row?.source_revision_hash || ''))
      ) {
        continue;
      }
      // The filename must equal sha256(otid NUL revision) of the BODY: a
      // misplaced or corrupt journal whose identity does not derive its own
      // name can never refresh throughput (Codex review bcd58db8151d).
      const expectedName = `${crypto
        .createHash('sha256')
        .update([String(row.otid), String(row.source_revision_hash)].join(String.fromCharCode(0)))
        .digest('hex')}.json`;
      if (name.toLowerCase() !== expectedName) continue;
      if (String(row?.state || '').toLowerCase() !== 'committed') continue;
      const committedMs = Date.parse(
        String(row?.committed_at || row?.verified_at || row?.generated_at || ''),
      );
      if (Number.isFinite(committedMs)) {
        committed.push({ otid: String(row?.otid || ''), committedMs });
      }
    }
  } catch {
    /* no settlements dir yet: last closure stays unknown */
  }
  const lastClosureMs = committed.length
    ? Math.max(...committed.map((row) => row.committedMs))
    : null;
  const historicalPause = pauseState(path.join(vpDir, 'otter-historical-backfill.pause'), {
    nowMs,
    fsApi,
  });
  const livePause = pauseState(path.join(vpDir, 'otter-live-healer.pause'), {
    nowMs,
    fsApi,
  });
  const lastClosureAgeMinutes =
    lastClosureMs == null ? null : Math.max(0, Math.floor((nowMs - lastClosureMs) / 60000));
  const problems = [];
  // Throughput is judged PER LANE whenever the ledger carries per-call rows:
  // one global clock lets a fresh live closure mask a completely stalled
  // historical lane forever, and vice versa (Codex review ed5ec165dc14).
  // Each lane's stall alarm is suppressed only by that lane's own active
  // pause. When per-call rows are unavailable (summary-only ledgers), the
  // global fallback suppresses only when BOTH lanes are validly benched.
  const openCalls = Number(ledger?.summary?.calls_open || 0);
  const calls = Array.isArray(ledger?.calls) ? ledger.calls : [];
  const baselineMs = Date.parse(String(ledger?.baseline?.captured_at || ''));
  const lanes = {};
  let stalled = false;
  const laneAge = (ms) => (ms == null ? null : Math.max(0, Math.floor((nowMs - ms) / 60000)));
  if (calls.length && Number.isFinite(baselineMs)) {
    const laneOf = (call) => {
      const landedMs = Date.parse(String(call?.landed_at || ''));
      return !Number.isFinite(landedMs) || landedMs <= baselineMs ? 'historical' : 'live';
    };
    const callLane = new Map(calls.map((call) => [String(call.otid || ''), laneOf(call)]));
    const isOpen = (call) =>
      !(call?.closed === true || String(call?.status || call?.state || '') === 'closed');
    for (const lane of ['live', 'historical']) {
      const laneOpen = calls.filter((call) => isOpen(call) && laneOf(call) === lane).length;
      const laneClosureMs = committed
        .filter((row) => callLane.get(row.otid) === lane)
        .reduce((max, row) => (max == null || row.committedMs > max ? row.committedMs : max), null);
      const pause = lane === 'live' ? livePause : historicalPause;
      const ageMinutesLane = laneAge(laneClosureMs);
      const laneStalled =
        laneOpen > 0 &&
        !pause.active &&
        (ageMinutesLane == null || ageMinutesLane > THROUGHPUT_STALL_MINUTES);
      lanes[lane] = {
        open_calls: laneOpen,
        last_closure_age_minutes: ageMinutesLane,
        stalled: laneStalled,
      };
      if (laneStalled) {
        stalled = true;
        problems.push(
          `${lane} lane completion throughput is zero: ${laneOpen} open call(s) with ${
            ageMinutesLane == null
              ? 'no recorded closure'
              : `no closure in ${Math.floor(ageMinutesLane / 60)}h`
          } and no active ${lane} pause`,
        );
      }
    }
  } else {
    const pausedValidly = livePause.active && historicalPause.active;
    stalled =
      openCalls > 0 &&
      !pausedValidly &&
      (lastClosureAgeMinutes == null || lastClosureAgeMinutes > THROUGHPUT_STALL_MINUTES);
    if (stalled) {
      problems.push(
        `completion throughput is zero: ${openCalls} open call(s) with ${
          lastClosureAgeMinutes == null
            ? 'no recorded closure'
            : `no closure in ${Math.floor(lastClosureAgeMinutes / 60)}h`
        } and no active pause`,
      );
    }
  }
  for (const [lane, pause] of [
    ['historical', historicalPause],
    ['live', livePause],
  ]) {
    if (pause.error) {
      problems.push(
        `${lane} healer pause state is unreadable (${pause.error}); failing closed as paused`,
      );
    } else if (pause.exists && pause.expired) {
      problems.push(
        `${lane} healer pause expired at ${pause.expires_at} but the pause file is still present; the lane runner or its cron is not observing pauses`,
      );
    }
  }
  return {
    open_calls: openCalls,
    last_closure_age_minutes: lastClosureAgeMinutes,
    historical_pause: historicalPause,
    live_pause: livePause,
    lanes,
    stalled,
    problems,
  };
}

function callGraphHealthOverlay(graph) {
  if (!graph?.ok) {
    return {
      problems: ['live exact-call graph is unavailable'],
      detail: 'Live exact-call graph unavailable.',
    };
  }
  const durations = graph.event_clocks || {};
  const clockText = ['queue', 'cold_start', 'execution', 'handoff', 'closure']
    .map((name) => {
      const value = durations[name]?.duration_ms;
      return `${name.replace(/_/g, ' ')}=${Number.isFinite(value) ? `${Math.round(value / 1000)}s` : '?'}`;
    })
    .join(', ');
  const bad = [
    'open_red',
    'open_critical',
    'architecture_release_blocked',
    'state_divergence',
  ].includes(String(graph.status || ''));
  return {
    problems: bad ? [`live exact-call graph is ${graph.status}`] : [],
    detail: `Live exact-call graph ${graph.status}; ${clockText}.`,
  };
}

function readJson(file, fallback = null, fsApi = fs) {
  try {
    return JSON.parse(fsApi.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

function ageMinutes(value, nowMs) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? Math.max(0, Math.floor((nowMs - parsed) / 60000)) : null;
}

function readCycleProcessHealth(vpDir, fsApi = fs) {
  const receiptsDir = path.join(vpDir, 'otter-call-processing-cycles', 'receipts');
  let names = [];
  try {
    names = fsApi.readdirSync(receiptsDir).filter((name) => name.endsWith('.jsonl'));
  } catch {
    return { processes: [], exhausted: [], cycles_consumed: 0 };
  }
  const processes = [];
  for (const name of names) {
    let rows = [];
    try {
      rows = fsApi
        .readFileSync(path.join(receiptsDir, name), 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {
      processes.push({
        file: name,
        process_key: '',
        cycles_consumed: 0,
        exhausted: true,
        reason: 'corrupt_cycle_receipt_log',
      });
      continue;
    }
    const reopenRows = rows.filter((row) => row.event === 'repair_generation_started');
    const latestReopen = reopenRows.at(-1) || null;
    const generationStart = latestReopen ? rows.lastIndexOf(latestReopen) + 1 : 0;
    const generationRows = rows.slice(generationStart);
    const allocations = generationRows.filter((row) => row.event === 'cycle_allocated');
    const allAllocations = rows.filter((row) => row.event === 'cycle_allocated');
    const terminals = generationRows.filter(
      (row) => row.event === 'cycle_completed' || row.event === 'lease_expired',
    );
    const allTerminals = rows.filter(
      (row) => row.event === 'cycle_completed' || row.event === 'lease_expired',
    );
    const deferredLeaseIds = new Set(
      terminals
        .filter((row) =>
          ['DEFERRED_ASYNC', 'DEFERRED_CAPACITY', 'WAITING_CAPACITY'].includes(
            String(row?.outcome || '').toUpperCase(),
          ),
        )
        .map((row) => row.lease_id)
        .filter(Boolean),
    );
    const consumedAllocations = allocations.filter((row) => !deferredLeaseIds.has(row.lease_id));
    const allDeferredLeaseIds = new Set(
      allTerminals
        .filter((row) =>
          ['DEFERRED_ASYNC', 'DEFERRED_CAPACITY', 'WAITING_CAPACITY'].includes(
            String(row?.outcome || '').toUpperCase(),
          ),
        )
        .map((row) => row.lease_id)
        .filter(Boolean),
    );
    const allConsumedAllocations = allAllocations.filter(
      (row) => !allDeferredLeaseIds.has(row.lease_id),
    );
    const attemptTerminals = terminals.filter((row) => !deferredLeaseIds.has(row.lease_id));
    const lastTerminal = attemptTerminals.at(-1) || null;
    const explicitBlock =
      generationRows.filter((row) => row.event === 'process_blocked').at(-1) || null;
    const lastRejection =
      generationRows
        .slice()
        .reverse()
        .find((row) => row.event === 'allocation_rejected') || null;
    let consecutiveNoProgress = 0;
    for (let index = attemptTerminals.length - 1; index >= 0; index -= 1) {
      if (
        !['NO_PROGRESS', 'UNCHANGED', 'CRASHED_LEASE_EXPIRED'].includes(
          String(attemptTerminals[index]?.outcome || '').toUpperCase(),
        )
      ) {
        break;
      }
      consecutiveNoProgress += 1;
    }
    const rejectionReason = String(lastRejection?.status || lastRejection?.outcome || '');
    const cleared = String(lastTerminal?.outcome || '').toUpperCase() === 'CLEARED';
    const explicitBlockReason = String(explicitBlock?.status || explicitBlock?.outcome || '');
    const exhausted =
      !cleared &&
      (Boolean(explicitBlock) ||
        consumedAllocations.length >= 8 ||
        consecutiveNoProgress >= 3 ||
        [
          'BLOCKED_EXHAUSTED',
          'BLOCKED_NO_PROGRESS',
          'BLOCKED_NO_NEW_APPROACH',
          'BLOCKED_AGENT_FAILED',
        ].includes(rejectionReason));
    processes.push({
      file: name,
      process_key: String(rows.at(-1)?.process_key || allocations.at(-1)?.process_key || ''),
      otid: String(rows.at(-1)?.otid || allocations.at(-1)?.otid || ''),
      stage: String(rows.at(-1)?.stage || allocations.at(-1)?.stage || ''),
      cycles_consumed: consumedAllocations.length,
      total_cycles_consumed: allConsumedAllocations.length,
      allocation_count: allocations.length,
      total_allocation_count: allAllocations.length,
      repair_generation: Number(latestReopen?.repair_generation || 1),
      consecutive_no_progress: consecutiveNoProgress,
      agentic_attempts: consumedAllocations.filter(
        (row) => row?.tactic_descriptor?.kind === 'otter-call-agentic-repair',
      ).length,
      attempt_history: attemptRowsFromCycleReceipts(rows, {
        processKey: String(rows.at(-1)?.process_key || allocations.at(-1)?.process_key || ''),
      }),
      cleared,
      exhausted,
      reason:
        explicitBlockReason ||
        rejectionReason ||
        (consumedAllocations.length >= 8
          ? 'BLOCKED_EXHAUSTED'
          : consecutiveNoProgress >= 3
            ? 'BLOCKED_NO_PROGRESS'
            : ''),
    });
  }
  return {
    processes,
    exhausted: processes.filter((row) => row.exhausted),
    cycles_consumed: processes.reduce((total, row) => total + Number(row.cycles_consumed || 0), 0),
    total_cycles_consumed: processes.reduce(
      (total, row) => total + Number(row.total_cycles_consumed || 0),
      0,
    ),
  };
}

function activeExhaustedCycleProcesses(cycleHealth, ledger) {
  const exhausted = Array.isArray(cycleHealth?.exhausted) ? cycleHealth.exhausted : [];
  if (!Array.isArray(ledger?.healer_targets)) return exhausted;
  const activeTargets = new Set(
    ledger.healer_targets
      .map((row) => {
        const otid = String(row?.otid || '').trim();
        const stage = String(row?.failed_stage || '').trim();
        return otid && stage ? `${otid}\u0000${stage}` : '';
      })
      .filter(Boolean),
  );
  return exhausted.filter((row) => {
    if (row?.reason === 'corrupt_cycle_receipt_log') return true;
    const otid = String(row?.otid || '').trim();
    const stage = String(row?.stage || '').trim();
    if (!otid || !stage) return true;
    return activeTargets.has(`${otid}\u0000${stage}`);
  });
}

function readOtterCallProcessingHealth({
  dataDir,
  nowMs = Date.now(),
  maxArtifactAgeMinutes = 20,
  fsApi = fs,
} = {}) {
  const vpDir = path.join(dataDir, 'life-archive', 'voiceprints');
  const ledger = readJson(
    path.join(vpDir, 'otter-call-processing-ledger-latest.json'),
    null,
    fsApi,
  );
  const conflicts = readJson(path.join(vpDir, 'voice-name-conflicts-latest.json'), null, fsApi);
  const healerJobs = readJson(
    path.join(vpDir, 'otter-call-processing-healer-jobs-latest.json'),
    { jobs: [] },
    fsApi,
  );
  const ledgerAge = ageMinutes(ledger?.generated_at, nowMs);
  const conflictAge = ageMinutes(conflicts?.generated_at, nowMs);
  const jobs = Array.isArray(healerJobs?.jobs) ? healerJobs.jobs : [];
  const cycleHealth = readCycleProcessHealth(vpDir, fsApi);
  const latestCall = [...(ledger?.calls || [])].sort(
    (left, right) =>
      Date.parse(String(right?.landed_at || '')) - Date.parse(String(left?.landed_at || '')),
  )[0];
  const liveGraph = latestCall
    ? buildOtterCallGraph({
        dataDir,
        otid: latestCall.otid,
        nowMs,
        fsApi,
      })
    : null;
  const graphOverlay = liveGraph ? callGraphHealthOverlay(liveGraph) : null;
  const staleRunningJobs = jobs.filter(
    (job) =>
      job?.status === 'running' &&
      Number(ageMinutes(job?.updated_at || job?.started_at, nowMs)) > 60,
  );
  const exhaustedJobs = activeExhaustedCycleProcesses(cycleHealth, ledger);
  const currentCycleHealth = { ...cycleHealth, exhausted: exhaustedJobs };
  const throughput = completionThroughputFacts({ vpDir, ledger, nowMs, fsApi });
  const lifetimeProblems = [];
  const slaProblems = [];
  lifetimeProblems.push(...throughput.problems);
  const pauseRecovery = {};
  for (const lane of ['live', 'historical']) {
    const recovery = readJson(
      path.join(dataDir, 'agent', `otter-healer-pause-recovery-${lane}-latest.json`),
      null,
      fsApi,
    );
    pauseRecovery[lane] = recovery;
    const pause = lane === 'live' ? throughput.live_pause : throughput.historical_pause;
    const trustedRecovery = recovery?.schema === RECOVERY_SCHEMA;
    if (
      trustedRecovery &&
      recovery?.status === 'blocked' &&
      ((pause?.exists && pause?.active) || recovery?.evidence_risk === true)
    ) {
      lifetimeProblems.push(
        `${lane} healer pause recovery is blocked: ${recovery.blocked_reason || 'unknown guard'}`,
      );
    }
  }
  // The historical lane persists a read-only paperwork cohort report each
  // pass; a ledger-closed call lacking a committed settlement is a named,
  // durable defect, never a silent one (Codex review eb16d6c7cf6b). A report
  // that exists but is unreadable, wrong-schema, or stale while the
  // historical lane is unbenched is itself a defect: missing-or-corrupt must
  // never read as "no settlementless closures" (Codex review 8b62e5c66ed2).
  const paperworkReportFile = path.join(vpDir, 'otter-paperwork-cohort-latest.json');
  const paperworkReport = readJson(paperworkReportFile, null, fsApi);
  let paperworkReportExists = false;
  try {
    paperworkReportExists = fsApi.statSync(paperworkReportFile).isFile();
  } catch {
    paperworkReportExists = false;
  }
  if (
    !paperworkReportExists &&
    !throughput.historical_pause?.active &&
    Number(ledger?.summary?.calls_open || 0) > 0
  ) {
    // The deploy seeds the first report, so a missing report on a live
    // system with open calls means it was deleted or never generated: an
    // unbounded blind spot, red (Codex review ed5ec165dc14).
    lifetimeProblems.push(
      'paperwork cohort report is missing while the historical lane is unbenched',
    );
  } else if (paperworkReportExists && !paperworkReport) {
    lifetimeProblems.push('paperwork cohort report exists but is unreadable');
  } else if (
    paperworkReport &&
    !String(paperworkReport.schema || '').startsWith('life_archive_otter_paperwork_cohort_report')
  ) {
    lifetimeProblems.push('paperwork cohort report has an unexpected schema');
  } else if (paperworkReport && !throughput.historical_pause?.active) {
    const reportAge = ageMinutes(paperworkReport.generated_at, nowMs);
    if (reportAge == null || reportAge > 6 * 60) {
      lifetimeProblems.push(
        'paperwork cohort report is stale while the historical lane is unbenched',
      );
    }
  }
  // Per-lane dispatch artifacts make undispatchable targets and handoff
  // creation failures named red facts instead of cron stdout (Codex review
  // 12103d9f3576).
  for (const lane of ['live', 'historical']) {
    const dispatch = readJson(
      path.join(vpDir, `otter-call-healer-dispatch-${lane}-latest.json`),
      null,
      fsApi,
    );
    if (!dispatch) continue;
    const creationFailures = Array.isArray(dispatch.handoff_creation_failures)
      ? dispatch.handoff_creation_failures
      : [];
    const handoffless = Array.isArray(dispatch.handoffless_targets)
      ? dispatch.handoffless_targets
      : [];
    if (creationFailures.length) {
      lifetimeProblems.push(
        `${creationFailures.length} ${lane}-lane handoff creation failure(s): ${creationFailures
          .slice(0, 3)
          .map((row) => String(row?.otid || 'unknown'))
          .join(', ')}`,
      );
    }
    if (handoffless.length) {
      lifetimeProblems.push(
        `${handoffless.length} ${lane}-lane target(s) are undispatchable without a durable handoff: ${handoffless
          .slice(0, 3)
          .map((row) => String(row?.otid || 'unknown'))
          .join(', ')}`,
      );
    }
  }
  const settlementlessClosures = Array.isArray(paperworkReport?.closed_without_committed_settlement)
    ? paperworkReport.closed_without_committed_settlement
    : [];
  if (settlementlessClosures.length) {
    lifetimeProblems.push(
      `${settlementlessClosures.length} ledger-closed call(s) lack a committed settlement: ${settlementlessClosures
        .slice(0, 5)
        .join(', ')}${settlementlessClosures.length > 5 ? ', ...' : ''}`,
    );
  }
  if (!ledger) {
    lifetimeProblems.push('call-processing ledger is missing');
    slaProblems.push('call-processing ledger is missing');
  } else {
    if (ledgerAge == null || ledgerAge > maxArtifactAgeMinutes) {
      lifetimeProblems.push('call-processing ledger is stale');
      slaProblems.push('call-processing ledger is stale');
    }
    if (Number(ledger?.summary?.deadline_breaches_last_24h || 0) > 0) {
      slaProblems.push(
        `${Number(ledger.summary.deadline_breaches_last_24h)} call(s) landed in the past 24h breached a stage deadline or the 60-minute completion SLA`,
      );
    }
    if (Number(ledger?.summary?.stage_deadline_breaches || 0) > 0) {
      lifetimeProblems.push(
        `${Number(ledger.summary.stage_deadline_breaches)} call-stage deadline breach(es) require exact-call repair`,
      );
    }
    if (Number(ledger?.summary?.calls_over_60_minutes || 0) > 0) {
      lifetimeProblems.push(
        `${Number(ledger.summary.calls_over_60_minutes)} calls exceed the 60-minute processing SLA`,
      );
    }
    if (Number(ledger?.summary?.historical_incomplete_calls || 0) > 0) {
      lifetimeProblems.push(
        `${Number(
          ledger.summary.historical_incomplete_calls,
        )} historical calls lack terminal processing receipts`,
      );
    }
    if (Number(ledger?.summary?.exact_envelopes_required_missing_or_invalid || 0) > 0) {
      lifetimeProblems.push(
        `${Number(
          ledger.summary.exact_envelopes_required_missing_or_invalid,
        )} exact-call completion envelope(s) are missing or invalid after cutover`,
      );
    }
    if (Number(ledger?.summary?.state_divergences || 0) > 0) {
      lifetimeProblems.push(
        `${Number(
          ledger.summary.state_divergences,
        )} STATE_DIVERGENCE exact-call contradiction(s) require repair`,
      );
    }
    if (Number(ledger?.summary?.architecture_provenance_mismatches || 0) > 0) {
      lifetimeProblems.push(
        `${Number(
          ledger.summary.architecture_provenance_mismatches,
        )} exact-call architecture provenance mismatch(es) block release trust`,
      );
    }
    if (Number(ledger?.summary?.exact_envelope_cutover_invalid || 0) > 0) {
      lifetimeProblems.push(
        'the exact-call envelope cutover marker is invalid and blocks release trust',
      );
    }
    if (String(ledger?.stage_budget_calibration?.status || '').toUpperCase() !== 'GREEN') {
      lifetimeProblems.push(
        `stage-budget calibration is not current: ${
          (ledger?.stage_budget_calibration?.problems || []).join('; ') || 'proof missing'
        }`,
      );
    }
  }
  if (staleRunningJobs.length) {
    lifetimeProblems.push(`${staleRunningJobs.length} healer job(s) have stale running leases`);
  }
  if (exhaustedJobs.length) {
    lifetimeProblems.push(
      `${exhaustedJobs.length} exact-call stage process(es) stopped after agent failure, no new approach, three no-progress cycles, or the eight-cycle ceiling`,
    );
  }
  if (graphOverlay) {
    lifetimeProblems.push(...graphOverlay.problems);
  }
  const conflictProblems = [];
  const pendingConflictExamples = (conflicts?.pending_sandbox_candidates || [])
    .slice(0, 5)
    .map(
      (row) =>
        `${row.observation_key || `${row.otid}|${row.speaker_model_label}`} -> ${
          row.candidate_person_id || 'unknown person'
        } (${row.reason || 'marked-call gate incomplete'})`,
    );
  if (!conflicts) conflictProblems.push('voiceprint contradiction audit is missing');
  else {
    const acousticV2 =
      String(conflicts.schema || '') === 'life_archive_voiceprint_acoustic_contradictions.v2';
    if (conflictAge == null || conflictAge > 36 * 60) {
      conflictProblems.push('voiceprint contradiction audit is stale');
    }
    if (acousticV2 && Number(conflicts.confident_acoustic_contradictions || 0) > 0) {
      conflictProblems.push(
        `${Number(
          conflicts.confident_acoustic_contradictions,
        )} calibrated high-confidence acoustic contradiction(s)`,
      );
    } else if (!acousticV2 && Number(conflicts.confirmed_voice_text_name_conflicts || 0) > 0) {
      conflictProblems.push(
        `${Number(conflicts.confirmed_voice_text_name_conflicts)} legacy voice/text name conflict(s); refresh the v2 acoustic audit`,
      );
    }
    if (Number(conflicts.conflicts_without_playable_audio || 0) > 0) {
      conflictProblems.push(
        `${Number(
          conflicts.conflicts_without_playable_audio,
        )} conflict row(s) lack playable voiceprint audio`,
      );
    }
    if (
      !acousticV2 &&
      Number(conflicts.sandbox_candidates_without_marked_call_disposition || 0) > 0
    ) {
      conflictProblems.push(
        `${Number(
          conflicts.sandbox_candidates_without_marked_call_disposition,
        )} strict voice reference candidate(s) lack marked-call name disposition`,
      );
    }
  }
  // Oct 3 2026: every breach in the rolling window can be elapsed history while
  // the current ledger names zero open healer targets. The launch preflight
  // then starts no repair session, so the face says so instead of implying a
  // repair is pending. Only a current ledger with a measured zero qualifies.
  const slaBreaches = Number(ledger?.summary?.deadline_breaches_last_24h || 0);
  const elapsedHistoryOnly =
    Boolean(ledger) &&
    slaBreaches > 0 &&
    ledger?.summary?.healer_target_count === 0 &&
    ledgerAge != null &&
    ledgerAge <= maxArtifactAgeMinutes;
  const elapsedHistoryNote = !elapsedHistoryOnly
    ? ''
    : slaBreaches === 1
      ? ' It is elapsed history with no open repair target; no repair session runs, and the row clears as it leaves the 24-hour window.'
      : ` All ${slaBreaches} are elapsed history with no open repair target; no repair session runs, and the row clears as they leave the 24-hour window.`;
  return {
    call_sla: {
      status: slaProblems.length ? 'red' : 'green',
      detail: ledger
        ? `${Number(
            ledger.summary?.deadline_breaches_last_24h || 0,
          )} call(s) landed in the past 24h breached a stage deadline or the 60-minute completion SLA out of ${Number(
            ledger.summary?.calls_landed_last_24h || 0,
          )} landed; proof ${ledgerAge == null ? 'undated' : `${ledgerAge}m old`}.${elapsedHistoryNote}`
        : 'No call-processing ledger exists.',
      elapsed_history_only: elapsedHistoryOnly,
      problems: slaProblems,
      window: {
        hours: 24,
        calls_landed: Number(ledger?.summary?.calls_landed_last_24h || 0),
        deadline_breaches: Number(ledger?.summary?.deadline_breaches_last_24h || 0),
        proof_generated_at: ledger?.generated_at || '',
      },
    },
    lifetime_completion: {
      status: lifetimeProblems.length ? 'red' : 'green',
      detail: ledger
        ? `${Number(ledger.summary?.calls_closed || 0)}/${Number(
            ledger.summary?.calls_total || 0,
          )} lifetime calls have terminal processing receipts; ${Number(
            ledger.summary?.calls_open || 0,
          )} remain open, including ${Number(
            ledger.summary?.historical_incomplete_calls || 0,
          )} historical calls; ${Number(
            ledger.summary?.exact_envelopes_required_missing_or_invalid || 0,
          )} required exact-call completion envelope(s) are missing or invalid; ${Number(
            ledger.summary?.state_divergences || 0,
          )} state divergence(s); ${cycleHealth.processes.length} exact stage process(es) consumed ${
            cycleHealth.total_cycles_consumed ?? cycleHealth.cycles_consumed
          } total cycle(s), ${exhaustedJobs.length} exhausted; proof ${
            ledgerAge == null ? 'undated' : `${ledgerAge}m old`
          }.`
        : 'No lifetime call-processing ledger exists.',
      problems: lifetimeProblems,
      artifact: ledger,
      live_graph: liveGraph,
      completion_throughput: throughput,
      healer_jobs: healerJobs,
      cycle_health: currentCycleHealth,
      pause_recovery: pauseRecovery,
      exact_envelope_failures: Number(
        ledger?.summary?.exact_envelopes_required_missing_or_invalid || 0,
      ),
      state_divergences: Number(ledger?.summary?.state_divergences || 0),
      architecture_provenance_mismatches: Number(
        ledger?.summary?.architecture_provenance_mismatches || 0,
      ),
      exact_envelope_cutover_invalid: Number(ledger?.summary?.exact_envelope_cutover_invalid || 0),
    },
    name_conflicts: {
      status: conflictProblems.length ? 'red' : 'green',
      detail: conflicts
        ? `${Number(
            conflicts.confident_acoustic_contradictions ??
              conflicts.confirmed_voice_text_name_conflicts ??
              0,
          )} calibrated acoustic contradiction(s), ${Number(
            conflicts.provisional_promotion_name_conflicts || 0,
          )} unresolved-candidate marked-speaker name conflict(s), ${Number(
            conflicts.conflicts_without_playable_audio || 0,
          )} without playable audio; ${Number(
            conflicts.sandbox_candidates_without_marked_call_disposition || 0,
          )} pending marked-call naming gate(s), which block promotion but do not contradict a confirmed voiceprint; proof ${
            conflictAge == null ? 'undated' : `${conflictAge}m old`
          }${
            pendingConflictExamples.length ? `; pending ${pendingConflictExamples.join('; ')}` : ''
          }.`
        : 'No voice/text name-conflict audit exists.',
      problems: conflictProblems,
      artifact: conflicts,
    },
  };
}

module.exports = {
  callGraphHealthOverlay,
  completionThroughputFacts,
  readCycleProcessHealth,
  readOtterCallProcessingHealth,
};
