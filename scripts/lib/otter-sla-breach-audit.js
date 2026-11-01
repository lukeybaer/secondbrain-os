'use strict';

// Per-breach audit for system_health:otter-call-processing-sla (Oct 19 2026).
//
// The row stayed red for real breaches, but its face said only "31 call(s)
// breached", so healers kept re-diagnosing an elapsed-history row. This pure
// module explains each breach from the exact ledger plus the landing log:
// which stage missed its deadline and by how many minutes, how long the call
// waited before Fargate versus how long it ran, whether it is complete now,
// and a cause per call. It never changes what counts as a breach, the row
// status, or the 60-minute SLA (The owner: "breech is a breech").
//
// Honesty rules: minute math uses landed_at, landing events and stage
// completed_at only. Stage ready_at is never read (reprocessed calls carry
// stale values, for example a June ready_at on an October call). Missing
// landing proof yields `unclassified`, never a guess.

const SLA_MINUTES = 60;
const BURST_MIN_CALLS = 5;
const BURST_WINDOW_MINUTES = 10;
// Any launch failure or repair requeue that is not a provider limit marks a
// stuck stage.
const STUCK_LAUNCH_FAILURES = 1;
const PROVIDER_LIMIT_REASON_RE = /throttl|rate exceeded|too many|limit|quota|capacity|RESOURCE:/i;
const WORST_CALLS = 3;
const MAX_SUFFIX_CHARS = 900;

const STAGE_ORDER = [
  'full_audio',
  'voice_completion',
  'name_disposition',
  'people_file_projection',
  'exact_completion_envelope',
  'exact_revision_closure',
];
// Post-envelope EC2 steps, each measured from the previous step's completion.
const TAIL_STEPS = [
  ['name_disposition', 'voice_completion'],
  ['people_file_projection', 'name_disposition'],
  ['exact_revision_closure', 'people_file_projection'],
];
const CAUSES = ['burst_backlog', 'stuck_stage', 'provider_limit', 'slow_tail_stage'];

function timeMs(value) {
  if (!value) return null;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function minutesBetween(fromMs, toMs) {
  if (fromMs == null || toMs == null) return null;
  return Math.round((toMs - fromMs) / 60000);
}

function median(values) {
  const nums = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : Math.round((nums[mid - 1] + nums[mid]) / 2);
}

function minOf(values) {
  const nums = values.filter((value) => Number.isFinite(value));
  return nums.length ? Math.min(...nums) : null;
}

function maxOf(values) {
  const nums = values.filter((value) => Number.isFinite(value));
  return nums.length ? Math.max(...nums) : null;
}

function isClosedCall(call) {
  return call?.closed === true || String(call?.status || call?.state || '') === 'closed';
}

function isProviderLimitEvent(event) {
  const type = String(event?.type || '');
  if (type !== 'launch_deferred' && type !== 'launch_expired') return false;
  const reason = String(event?.reason || '');
  // The owner launch switch is not a provider limit.
  if (reason.trim().toLowerCase() === 'disabled') return false;
  return PROVIDER_LIMIT_REASON_RE.test(`${reason} ${String(event?.detail || '')}`);
}

// Calls that landed together: a call is in a burst when at least
// BURST_MIN_CALLS calls, itself included, landed inside one
// BURST_WINDOW_MINUTES window.
function detectBursts(calls) {
  const windowMs = BURST_WINDOW_MINUTES * 60000;
  const landed = calls
    .map((call) => ({ otid: String(call?.otid || ''), ms: timeMs(call?.landed_at) }))
    .filter((row) => row.otid && row.ms != null)
    .sort((a, b) => a.ms - b.ms || a.otid.localeCompare(b.otid));
  const inBurst = new Array(landed.length).fill(false);
  let end = 0;
  for (let start = 0; start < landed.length; start += 1) {
    if (end < start) end = start;
    while (end + 1 < landed.length && landed[end + 1].ms - landed[start].ms <= windowMs) end += 1;
    if (end - start + 1 >= BURST_MIN_CALLS) {
      for (let i = start; i <= end; i += 1) inBurst[i] = true;
    }
  }
  const bursts = [];
  let current = null;
  for (let i = 0; i < landed.length; i += 1) {
    if (!inBurst[i]) {
      current = null;
      continue;
    }
    if (!current || landed[i].ms - current.endMs > windowMs) {
      current = { startMs: landed[i].ms, endMs: landed[i].ms, otids: [] };
      bursts.push(current);
    }
    current.endMs = landed[i].ms;
    current.otids.push(landed[i].otid);
  }
  return bursts.map((burst) => ({
    start_at: new Date(burst.startMs).toISOString(),
    end_at: new Date(burst.endMs).toISOString(),
    calls: burst.otids.length,
    span_seconds: Math.round((burst.endMs - burst.startMs) / 1000),
    otids: burst.otids,
  }));
}

function stageBreachRows({ call, breachedStages, landedMs, asOfMs }) {
  const orchestration = call?.orchestration || {};
  return breachedStages
    .map((stage) => {
      const row = orchestration[stage] || {};
      const deadlineMs = timeMs(row.deadline_at);
      const deferredMs = Math.max(0, Number(row.deferred_by_host_admission_ms || 0) || 0);
      const effectiveMs = deadlineMs == null ? null : deadlineMs + deferredMs;
      const completedMs = timeMs(row.completed_at);
      const completed = completedMs != null;
      return {
        stage,
        deadline_at: row.deadline_at || '',
        deadline_minutes_after_landing: minutesBetween(landedMs, deadlineMs),
        budget_minutes: Number.isFinite(Number(row.budget_minutes))
          ? Number(row.budget_minutes)
          : null,
        host_admission_deferred_ms: deferredMs,
        host_admission_deferred_minutes: Math.round(deferredMs / 60000),
        effective_deadline_at: effectiveMs == null ? '' : new Date(effectiveMs).toISOString(),
        completed_at: completed ? row.completed_at : null,
        late_minutes: minutesBetween(effectiveMs, completed ? completedMs : asOfMs),
        still_late: !completed,
        _deadlineMs: deadlineMs,
      };
    })
    .sort(
      (a, b) =>
        (a._deadlineMs ?? Infinity) - (b._deadlineMs ?? Infinity) ||
        STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage),
    );
}

// launch_deferred reasons that are launch failures on our side (RunTask threw,
// the trigger threw, a stage before Fargate failed), not holds. A deferral with
// one of these reasons counts as stuck-stage evidence unless its detail names a
// provider limit. Holds (deferred_capacity, disabled, no_otids) never do.
const NON_PROVIDER_DEFER_FAILURE_REASONS = new Set([
  'active_task_lookup_failed',
  'missing_network_config',
  'raw_stage_failed',
  'registry_stage_failed',
  'run_task_failed',
  'stage_budget_stage_failed',
  'trigger_threw',
]);

function landingTimeline({ call, events, landedMs, envelopeMs, closedMs }) {
  const revision = String(call?.source_revision_hash || '').toLowerCase();
  const otid = String(call?.otid || '');
  const own = (events || [])
    .filter(
      (row) =>
        String(row?.otid || '') === otid &&
        revision &&
        String(row?.source_revision || '').toLowerCase() === revision &&
        timeMs(row?.at) != null &&
        // Events after closure are not part of this breach.
        (closedMs == null || timeMs(row.at) <= closedMs),
    )
    .sort((a, b) => timeMs(a.at) - timeMs(b.at));
  const ofType = (type) => own.filter((row) => row.type === type);
  const enqueued = ofType('enqueued');
  if (!enqueued.length) return null;
  const enqueuedMs = timeMs(enqueued[0].at);
  const launched = ofType('launched');
  const launchedBeforeEnvelope =
    envelopeMs == null ? launched : launched.filter((row) => timeMs(row.at) <= envelopeMs);
  const firstLaunchMs = launched.length ? timeMs(launched[0].at) : null;
  const lastLaunchMs = launchedBeforeEnvelope.length
    ? timeMs(launchedBeforeEnvelope[launchedBeforeEnvelope.length - 1].at)
    : null;
  const expired = ofType('launch_expired');
  const exhausted = ofType('retry_exhausted');
  const failures = [...expired, ...exhausted];
  const deferredFailures = ofType('launch_deferred').filter(
    (row) =>
      NON_PROVIDER_DEFER_FAILURE_REASONS.has(String(row.reason || '')) && !isProviderLimitEvent(row),
  );
  const providerEvents = own.filter(isProviderLimitEvent);
  const nonProviderFailures = [
    ...failures.filter((row) => !isProviderLimitEvent(row)),
    ...deferredFailures,
  ];
  const deferredReasons = [
    ...new Set(ofType('launch_deferred').map((row) => String(row.reason || 'deferred'))),
  ].sort();
  const expiryReasons = [...new Set(expired.map((row) => String(row.reason || '')).filter(Boolean))].sort();
  const repairEvents = ofType('repair_enqueued');
  const preQueue = minutesBetween(landedMs, enqueuedMs);
  const queue = minutesBetween(enqueuedMs, firstLaunchMs);
  const retryLoss =
    launched.length > 1 && firstLaunchMs != null && lastLaunchMs != null
      ? minutesBetween(firstLaunchMs, lastLaunchMs)
      : firstLaunchMs != null
        ? 0
        : null;
  const processing = minutesBetween(lastLaunchMs, envelopeMs);
  const tail = minutesBetween(envelopeMs, closedMs);
  const wait =
    preQueue == null || queue == null || retryLoss == null ? null : preQueue + queue + retryLoss;
  return {
    enqueued_at: enqueued[0].at,
    first_launched_at: firstLaunchMs == null ? null : launched[0].at,
    last_launched_at:
      lastLaunchMs == null ? null : launchedBeforeEnvelope[launchedBeforeEnvelope.length - 1].at,
    launches: launched.length,
    task_stops: expired.length,
    retry_exhausted: exhausted.length,
    failed_launches: failures.length,
    deferred_failures: deferredFailures.length,
    deferred_failure_reasons: [
      ...new Set(
        deferredFailures.map((row) =>
          [row.reason, row.detail].filter(Boolean).map(String).join(': ').slice(0, 80),
        ),
      ),
    ],
    non_provider_failures: nonProviderFailures.length,
    repair_enqueued: repairEvents.length,
    repair_reasons: [...new Set(repairEvents.map((row) => String(row.reason || '')).filter(Boolean))],
    deferred_reasons: deferredReasons,
    expiry_reasons: expiryReasons,
    provider_limit_reasons: [
      ...new Set(
        providerEvents.map((row) =>
          [row.reason, row.detail].filter(Boolean).map(String).join(': ').slice(0, 80),
        ),
      ),
    ],
    pre_queue_minutes: preQueue,
    queue_minutes: queue,
    retry_loss_minutes: retryLoss,
    processing_minutes: processing,
    tail_minutes: tail,
    wait_minutes: wait,
  };
}

function slowestTailStep(call, landedMs) {
  const orchestration = call?.orchestration || {};
  let best = null;
  for (const [stage, previous] of TAIL_STEPS) {
    const doneMs = timeMs(orchestration[stage]?.completed_at);
    const prevMs = timeMs(orchestration[previous]?.completed_at);
    // A stage timestamp from before this call landed is stale history.
    if (doneMs == null || prevMs == null || doneMs < prevMs) continue;
    if (landedMs != null && (doneMs < landedMs || prevMs < landedMs)) continue;
    const minutes = minutesBetween(prevMs, doneMs);
    if (!best || minutes > best.minutes) best = { stage, minutes };
  }
  return best;
}

function classify({ entry, call, timeline, burstOf, asOfMs }) {
  if (!call) return ['unclassified', 'call row missing from the ledger'];
  if (!timeline) return ['unclassified', 'landing events unavailable'];
  const orchestration = call.orchestration || {};
  const openPastDeadline = Object.entries(orchestration).find(([, row]) => {
    if (!row || row.status === 'complete') return false;
    const deadlineMs = timeMs(row.deadline_at);
    if (deadlineMs == null) return false;
    const deferredMs = Math.max(0, Number(row.deferred_by_host_admission_ms || 0) || 0);
    return asOfMs > deadlineMs + deferredMs;
  });
  if (
    timeline.non_provider_failures >= STUCK_LAUNCH_FAILURES ||
    timeline.repair_enqueued > 0 ||
    (!entry.completed && openPastDeadline)
  ) {
    const parts = [];
    if (timeline.task_stops) {
      parts.push(
        `${timeline.task_stops} Fargate task stop(s) without an envelope${
          timeline.expiry_reasons.length ? ` (${timeline.expiry_reasons.join(' | ')})` : ''
        }`,
      );
    }
    if (timeline.retry_exhausted) parts.push('retries exhausted');
    if (timeline.deferred_failures) {
      parts.push(
        `${timeline.deferred_failures} launch failure(s) before Fargate (${timeline.deferred_failure_reasons.join(' | ')})`,
      );
    }
    if (timeline.repair_enqueued) {
      parts.push(
        `${timeline.repair_enqueued} repair requeue(s)${
          timeline.repair_reasons.length ? ` (${timeline.repair_reasons.join(' | ')})` : ''
        }`,
      );
    }
    if (!entry.completed && openPastDeadline) parts.push(`${openPastDeadline[0]} still open past its deadline`);
    parts.push(`${timeline.launches} launch(es)`);
    return ['stuck_stage', parts.join(', ')];
  }
  const hostHeld = entry.stage_breaches.filter((row) => row.host_admission_deferred_ms > 0);
  if (timeline.provider_limit_reasons.length || hostHeld.length) {
    const parts = [];
    if (timeline.provider_limit_reasons.length) {
      parts.push(`launch limited: ${timeline.provider_limit_reasons.join(' | ')}`);
    }
    for (const row of hostHeld) {
      parts.push(`host admission held ${row.stage} ${row.host_admission_deferred_minutes}m`);
    }
    return ['provider_limit', parts.join('; ')];
  }
  const wait = timeline.wait_minutes;
  const processing = timeline.processing_minutes;
  const tail = timeline.tail_minutes;
  const burst = burstOf.get(entry.otid);
  if (burst && wait != null && processing != null && wait >= processing) {
    return [
      'burst_backlog',
      `${burst.calls} calls landed within ${Math.max(1, Math.ceil(burst.span_seconds / 60))} min; waited ${wait}m before Fargate (${timeline.pre_queue_minutes}m pre-queue, ${timeline.queue_minutes}m queued), ran ${processing}m`,
    ];
  }
  if (
    tail != null &&
    (wait == null || tail >= wait) &&
    (processing == null || tail >= processing)
  ) {
    const slowest = slowestTailStep(call, timeMs(call.landed_at));
    return [
      'slow_tail_stage',
      slowest
        ? `slowest tail stage ${slowest.stage} took ${slowest.minutes}m of a ${tail}m tail`
        : `${tail}m post-envelope tail`,
    ];
  }
  if (wait == null || processing == null) {
    return ['unclassified', 'no Fargate launch or envelope time for this revision'];
  }
  return [
    'unclassified',
    `no single bucket dominates: waited ${wait}m, ran ${processing}m, tail ${tail == null ? '?' : `${tail}m`}${
      burst ? '' : ', not in a burst'
    }`,
  ];
}

function buildSlaBreachAudit({ ledger, landingEvents = null, nowMs = Date.now() } = {}) {
  const breaches = Array.isArray(ledger?.breaches_last_24h) ? ledger.breaches_last_24h : [];
  if (!breaches.length) return null;
  // Anchor to the ledger's own clock so the audit text is stable for one
  // ledger generation; open calls then agree with the ledger's age_minutes.
  const asOfMs = timeMs(ledger?.generated_at) ?? nowMs;
  const calls = Array.isArray(ledger?.calls) ? ledger.calls : [];
  const callsByOtid = new Map(calls.map((call) => [String(call?.otid || ''), call]));
  const windowStartMs = asOfMs - 24 * 60 * 60 * 1000;
  const recentCalls = calls.filter((call) => {
    const ms = timeMs(call?.landed_at);
    return ms != null && ms >= windowStartMs && ms <= asOfMs;
  });
  const bursts = detectBursts(recentCalls);
  const burstOf = new Map();
  for (const burst of bursts) for (const otid of burst.otids) burstOf.set(otid, burst);
  const events = Array.isArray(landingEvents) ? landingEvents : null;

  const entries = breaches.map((breach) => {
    const otid = String(breach?.otid || '');
    const call = callsByOtid.get(otid) || null;
    const landedAt = breach?.landed_at || call?.landed_at || '';
    const landedMs = timeMs(landedAt);
    const completed = call ? isClosedCall(call) : false;
    const closureRow = call?.orchestration?.exact_revision_closure;
    let closedMs = null;
    if (completed) {
      closedMs = timeMs(closureRow?.completed_at);
      if (closedMs == null) {
        closedMs = maxOf(
          Object.values(call?.orchestration || {}).map((row) => timeMs(row?.completed_at)),
        );
      }
    }
    const envelopeMs =
      timeMs(call?.stages?.exact_completion_envelope?.completed_at) ??
      timeMs(call?.orchestration?.exact_completion_envelope?.completed_at);
    const breachedStages = (Array.isArray(breach?.breached_stages) ? breach.breached_stages : [])
      .map(String)
      .filter(Boolean);
    const stageBreaches = call
      ? stageBreachRows({ call, breachedStages, landedMs, asOfMs })
      : breachedStages.map((stage) => ({ stage, late_minutes: null, still_late: true }));
    const totalMinutes = completed
      ? minutesBetween(landedMs, closedMs)
      : Number.isFinite(Number(call?.age_minutes))
        ? Number(call.age_minutes)
        : minutesBetween(landedMs, asOfMs);
    const timeline =
      call && events
        ? landingTimeline({
            call,
            events,
            landedMs,
            envelopeMs: envelopeMs != null && landedMs != null && envelopeMs < landedMs ? null : envelopeMs,
            closedMs,
          })
        : null;
    const worst = stageBreaches.reduce(
      (best, row) =>
        row.late_minutes != null && (!best || row.late_minutes > best.late_minutes) ? row : best,
      null,
    );
    const entry = {
      otid,
      landed_at: landedAt,
      completed,
      closed_at: closedMs == null ? null : new Date(closedMs).toISOString(),
      total_minutes: totalMinutes,
      over_sla: totalMinutes != null && totalMinutes > SLA_MINUTES,
      first_missed_stage: stageBreaches[0]?.stage || null,
      worst_stage: worst?.stage || null,
      worst_late_minutes: worst?.late_minutes ?? null,
      stage_breaches: stageBreaches.map(({ _deadlineMs, ...row }) => row),
      envelope_at: envelopeMs == null ? null : new Date(envelopeMs).toISOString(),
      timeline,
    };
    const [cause, basis] = classify({ entry, call, timeline, burstOf, asOfMs });
    entry.cause = cause;
    entry.cause_basis = basis;
    if (cause === 'slow_tail_stage') {
      entry.slowest_tail_stage = slowestTailStep(call, landedMs)?.stage || null;
    }
    return entry;
  });

  const byStage = {};
  for (const stage of STAGE_ORDER) {
    const rows = entries
      .map((entry) => ({ entry, row: entry.stage_breaches.find((item) => item.stage === stage) }))
      .filter((item) => item.row);
    if (!rows.length) continue;
    const late = rows.map((item) => item.row.late_minutes);
    byStage[stage] = {
      calls: rows.length,
      first_missed_calls: rows.filter((item) => item.entry.first_missed_stage === stage).length,
      deadline_minutes: median(rows.map((item) => item.row.deadline_minutes_after_landing)),
      min_late_minutes: minOf(late),
      median_late_minutes: median(late),
      max_late_minutes: maxOf(late),
    };
  }
  const byCause = {};
  for (const cause of [...CAUSES, 'unclassified']) {
    const rows = entries.filter((entry) => entry.cause === cause);
    const pick = (field) => rows.map((entry) => entry.timeline?.[field]);
    byCause[cause] = {
      calls: rows.length,
      otids: rows.map((entry) => entry.otid),
      median_wait_minutes: median(pick('wait_minutes')),
      median_pre_queue_minutes: median(pick('pre_queue_minutes')),
      median_queue_minutes: median(pick('queue_minutes')),
      median_processing_minutes: median(pick('processing_minutes')),
      median_tail_minutes: median(pick('tail_minutes')),
      median_total_minutes: median(rows.map((entry) => entry.total_minutes)),
      max_total_minutes: maxOf(rows.map((entry) => entry.total_minutes)),
    };
  }
  const breachedBursts = bursts.filter((burst) =>
    entries.some((entry) => entry.cause === 'burst_backlog' && burst.otids.includes(entry.otid)),
  );
  const largestBurst = [...(breachedBursts.length ? breachedBursts : bursts)].sort(
    (a, b) => b.calls - a.calls || a.start_at.localeCompare(b.start_at),
  )[0];
  const unmatched = entries.filter((entry) => !entry.timeline).map((entry) => entry.otid);
  return {
    schema: 'otter_sla_breach_audit.v1',
    as_of: new Date(asOfMs).toISOString(),
    sla_minutes: SLA_MINUTES,
    breached: entries.length,
    completed: entries.filter((entry) => entry.completed).length,
    still_open: entries.filter((entry) => !entry.completed).length,
    over_sla_calls: entries.filter((entry) => entry.over_sla).length,
    burst: largestBurst
      ? {
          start_at: largestBurst.start_at,
          end_at: largestBurst.end_at,
          calls: largestBurst.calls,
          span_seconds: largestBurst.span_seconds,
        }
      : null,
    bursts_with_breaches: breachedBursts.length,
    by_stage: byStage,
    by_cause: byCause,
    calls: entries,
    evidence: {
      landing_events_read: events ? events.length : null,
      matched_calls: entries.length - unmatched.length,
      unmatched_otids: unmatched,
    },
  };
}

function span(min, max) {
  if (min == null && max == null) return '?';
  if (min == null || max == null || min === max) return String(min ?? max);
  return `${min} to ${max}`;
}

function dominantStage(rows) {
  const counts = new Map();
  for (const entry of rows) {
    if (!entry.first_missed_stage) continue;
    counts.set(entry.first_missed_stage, (counts.get(entry.first_missed_stage) || 0) + 1);
  }
  return (
    [...counts.entries()].sort(
      (a, b) => b[1] - a[1] || STAGE_ORDER.indexOf(a[0]) - STAGE_ORDER.indexOf(b[0]),
    )[0]?.[0] || null
  );
}

function stageMissText(rows, stage) {
  if (!stage) return '';
  const stageRows = rows
    .map((entry) => entry.stage_breaches.find((row) => row.stage === stage))
    .filter(Boolean);
  const late = stageRows.map((row) => row.late_minutes);
  const deadline = median(stageRows.map((row) => row.deadline_minutes_after_landing));
  return `${stage} missed its ${deadline == null ? '?' : `${deadline}m`} deadline by ${span(
    minOf(late),
    maxOf(late),
  )}m`;
}

function formatSlaBreachAuditText(audit) {
  if (!audit || !Array.isArray(audit.calls) || !audit.calls.length) {
    return { detail_suffix: '', lines: [] };
  }
  const rowsFor = (cause) => audit.calls.filter((entry) => entry.cause === cause);
  const lines = [];

  const burstRows = rowsFor('burst_backlog');
  if (burstRows.length) {
    const stats = audit.by_cause.burst_backlog;
    const burst = audit.burst;
    const burstText = burst
      ? `${audit.bursts_with_breaches > 1 ? `${audit.bursts_with_breaches} bursts, largest ` : ''}${
          burst.calls
        } landed within ${Math.max(1, Math.ceil(burst.span_seconds / 60))} min; `
      : '';
    const miss = stageMissText(burstRows, dominantStage(burstRows));
    lines.push(
      `${burstRows.length} burst backlog call(s) (${burstText}waited a median ${stats.median_wait_minutes}m before Fargate started (${stats.median_pre_queue_minutes}m pre-queue, ${stats.median_queue_minutes}m queued), ran ${stats.median_processing_minutes}m, then ${stats.median_tail_minutes}m in post-envelope naming, People and closure; ${stats.median_total_minutes}m median vs the ${audit.sla_minutes}m SLA${
        miss ? `; ${miss}` : ''
      }).`,
    );
  }

  const stuckRows = rowsFor('stuck_stage');
  if (stuckRows.length) {
    const sum = (field) => stuckRows.reduce((acc, entry) => acc + Number(entry.timeline?.[field] || 0), 0);
    const parts = [];
    if (sum('task_stops')) parts.push(`${sum('task_stops')} Fargate task stop(s) without an envelope`);
    if (sum('retry_exhausted')) parts.push('retries exhausted');
    if (sum('repair_enqueued')) parts.push(`${sum('repair_enqueued')} repair requeue(s)`);
    parts.push(`${sum('launches')} launch(es)`);
    const closedRows = stuckRows.filter((entry) => entry.completed);
    const openCount = stuckRows.length - closedRows.length;
    const totals = closedRows.map((entry) => entry.total_minutes);
    const timing = [
      closedRows.length ? `${span(minOf(totals), maxOf(totals))}m to close` : '',
      openCount ? `${openCount} still open` : '',
    ]
      .filter(Boolean)
      .join(', ');
    lines.push(`${stuckRows.length} stuck stage call(s) (${parts.join(', ')}; ${timing}).`);
  }

  const providerRows = rowsFor('provider_limit');
  if (providerRows.length) {
    const reasons = [
      ...new Set(
        providerRows.flatMap((entry) => [
          ...(entry.timeline?.provider_limit_reasons || []),
          ...entry.stage_breaches
            .filter((row) => row.host_admission_deferred_ms > 0)
            .map(() => 'host admission hold'),
        ]),
      ),
    ];
    lines.push(`${providerRows.length} provider limit call(s) (${reasons.join(', ') || 'limit'}).`);
  } else {
    // Zero is evidence: state it so a reader never assumes a provider cap.
    lines.push('0 provider limit call(s).');
  }

  const slowRows = rowsFor('slow_tail_stage');
  if (slowRows.length) {
    const stage = dominantStage(slowRows);
    const miss = stageMissText(slowRows, stage);
    const proc = slowRows.map((entry) => entry.timeline?.processing_minutes);
    const tail = slowRows.map((entry) => entry.timeline?.tail_minutes);
    const slowest = [...new Set(slowRows.map((entry) => entry.slowest_tail_stage).filter(Boolean))];
    lines.push(
      `${slowRows.length} slow stage call(s) (${miss ? `${miss} after ` : ''}${span(
        minOf(proc),
        maxOf(proc),
      )}m of Fargate and ${span(minOf(tail), maxOf(tail))}m in the tail${
        slowest.length ? `; slowest step ${slowest.join(' or ')}` : ''
      }).`,
    );
  }

  const unclassifiedRows = rowsFor('unclassified');
  if (unclassifiedRows.length) {
    const counts = new Map();
    for (const entry of unclassifiedRows) {
      counts.set(entry.cause_basis, (counts.get(entry.cause_basis) || 0) + 1);
    }
    const basis = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
    lines.push(`${unclassifiedRows.length} unclassified call(s) (${basis}).`);
  }

  const ranked = [...audit.calls].sort(
    (a, b) =>
      (b.total_minutes ?? -Infinity) - (a.total_minutes ?? -Infinity) || a.otid.localeCompare(b.otid),
  );
  const worstText = (count) =>
    count <= 0
      ? ''
      : `Worst: ${ranked
          .slice(0, count)
          .map(
            (entry) =>
              `${entry.otid}${
                entry.worst_stage && entry.worst_late_minutes != null
                  ? ` ${entry.worst_stage} +${entry.worst_late_minutes}m`
                  : ''
              } (${entry.total_minutes == null ? '?' : entry.total_minutes}m total, ${
                entry.completed ? 'closed' : 'still open'
              })`,
          )
          .join('; ')}.`;
  const completion = audit.still_open
    ? `${audit.still_open} still open.`
    : audit.breached === 1
      ? 'It is now complete.'
      : `All ${audit.breached} are now complete.`;
  const build = (count) =>
    ['Why:', ...lines, worstText(count), completion].filter(Boolean).join(' ');
  let count = Math.min(WORST_CALLS, ranked.length);
  let suffix = build(count);
  while (suffix.length > MAX_SUFFIX_CHARS && count > 1) {
    count -= 1;
    suffix = build(count);
  }
  return { detail_suffix: suffix, lines };
}

module.exports = {
  BURST_MIN_CALLS,
  BURST_WINDOW_MINUTES,
  PROVIDER_LIMIT_REASON_RE,
  SLA_MINUTES,
  STUCK_LAUNCH_FAILURES,
  buildSlaBreachAudit,
  formatSlaBreachAuditText,
};
