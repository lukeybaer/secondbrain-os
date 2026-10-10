'use strict';

const crypto = require('node:crypto');
const {
  dateKeyInCt,
  nextDateKey,
  previousDateKey,
  ctWallTimeToEpochMs,
} = require('./briefing-run-window.js');

const WATCHER_AUTOMATION_ID = 'overnight-briefing-watcher';
const WATCHER_AUTOMATION_NAME = 'Overnight briefing watcher';
const WATCHER_DESKTOP_RUNTIME_ROOT = 'C:\\Users\\ExampleCo\\sb-runtime\\amy-code';
const WATCHER_CHECKPOINT_COMMAND =
  `node ${WATCHER_DESKTOP_RUNTIME_ROOT}\\scripts\\watcher-checkpoint.js --scheduled-fire`;
const WATCHER_RESCUE_COMMAND =
  `node ${WATCHER_DESKTOP_RUNTIME_ROOT}\\scripts\\watcher-checkpoint.js --rescue-if-needed`;
const WATCHER_EXPIRE_COMMAND =
  `node ${WATCHER_DESKTOP_RUNTIME_ROOT}\\scripts\\watcher-arm.js expire`;
const WATCHER_VERIFY_PAUSED_COMMAND =
  `node ${WATCHER_DESKTOP_RUNTIME_ROOT}\\scripts\\watcher-arm.js verify --expect-paused`;
const WATCHER_SCHEDULER_JITTER_MAX_MS = 120_000;
const WATCHER_CHECKPOINTS_CT = Object.freeze([
  '23:15',
  '00:00',
  '00:30',
  '01:00',
  '01:30',
  '02:00',
  '02:30',
  '03:00',
  '03:30',
  '04:00',
  '04:30',
  '05:00',
  '05:15',
  '05:20',
  '05:31',
]);

const WATCHER_REPORT_MILESTONES_CT = Object.freeze({
  reportStart: '02:00',
  accepted: '02:05',
  evidenceReady: '02:15',
  validDraft: '03:00',
  // 2026-09-07: the evidence freezes at the 4:30 repair cutoff; the finalized
  // report is due at the 5:15 finalBytes milestone, not here.
  evidenceFreeze: '04:35',
  repairFreeze: '05:03',
  finalizationAdvancing: '05:05',
  finalBytes: '05:15',
  sendsStarted: '05:20',
  deliveryWatchdog: '05:26',
  delivered: '05:30:59',
  truthAudit: '05:31',
});

const WATCHER_STATES = Object.freeze([
  'COMPLETE',
  'MISSED',
  'DEADLINE_AT_RISK',
  'STALLED',
  'PROGRESSING',
]);

const WATCHER_INTERVENTION_RESULTS = Object.freeze({
  PENDING: 'started-awaiting-proof',
  VERIFIED: 'verified-exact-outcome',
  TIMED_OUT: 'timed-out-without-exact-outcome',
});

function watcherInterventionState(receipt = {}) {
  const outcomeRow = receipt?.interventionOutcome?.row || null;
  const actionRow = receipt?.intervention?.row || null;
  const pendingOutcome =
    receipt?.interventionOutcome?.pending === true ||
    outcomeRow?.result === WATCHER_INTERVENTION_RESULTS.PENDING;
  const pendingAction = actionRow?.result === WATCHER_INTERVENTION_RESULTS.PENDING;
  const pendingRow = pendingAction ? actionRow : pendingOutcome ? outcomeRow : null;
  const pending = pendingAction || pendingOutcome;
  const terminalRow = [actionRow, outcomeRow].find((row) =>
    [
      WATCHER_INTERVENTION_RESULTS.VERIFIED,
      WATCHER_INTERVENTION_RESULTS.TIMED_OUT,
    ].includes(row?.result),
  ) || null;
  return {
    pending,
    pendingRow,
    terminal: !pending && Boolean(terminalRow),
    terminalRow: pending ? null : terminalRow,
    result: pending
      ? WATCHER_INTERVENTION_RESULTS.PENDING
      : String(terminalRow?.result || ''),
  };
}

function ctParts(value = Date.now()) {
  const instant = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(instant.getTime())) return null;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Chicago',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(instant)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function currentBriefingDate(value = Date.now()) {
  const parts = ctParts(value);
  if (!parts) return '';
  return parts.hour >= 12 ? nextDateKey(parts.date) : parts.date;
}

function minuteOfDay(parts) {
  return Number(parts?.hour) * 60 + Number(parts?.minute);
}

function nightRelativeMinute(parts) {
  const minute = minuteOfDay(parts);
  return Number(parts?.hour) >= 12 ? minute - 24 * 60 : minute;
}

function milestoneMinute(name) {
  const value = WATCHER_REPORT_MILESTONES_CT[name];
  const [hour, minute] = String(value || '').split(':').map(Number);
  return Number.isInteger(hour) && Number.isInteger(minute) ? hour * 60 + minute : Number.NaN;
}

function watcherCheckpointInstants(date) {
  const day = String(date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return [];
  return WATCHER_CHECKPOINTS_CT.map((checkpointCt) => {
    const [hour, minute] = checkpointCt.split(':').map(Number);
    const checkpointDate = hour >= 12 ? previousDateKey(day) : day;
    const epochMs = ctWallTimeToEpochMs(checkpointDate, hour, minute);
    return {
      checkpointCt,
      checkpointDate,
      epochMs,
      expectedAt: new Date(epochMs).toISOString(),
    };
  });
}

// Codex Desktop currently interprets heartbeat RRULE clocks in UTC. Build the
// one-night rule from exact CT instants instead of assuming the host timezone.
// BYSETPOS selects only the eight desired pairs from RFC 5545's Cartesian set.
function watcherSchedulerRrule(date) {
  const clocks = watcherCheckpointInstants(date).map(({ epochMs }) => {
    const value = new Date(epochMs);
    return { hour: value.getUTCHours(), minute: value.getUTCMinutes() };
  });
  if (clocks.length !== WATCHER_CHECKPOINTS_CT.length) return '';
  const hours = [...new Set(clocks.map(({ hour }) => hour))].sort((a, b) => a - b);
  const minutes = [...new Set(clocks.map(({ minute }) => minute))].sort((a, b) => a - b);
  const expanded = [];
  for (const hour of hours) {
    for (const minute of minutes) expanded.push({ hour, minute });
  }
  const positions = clocks.map(({ hour, minute }) =>
    expanded.findIndex((candidate) => candidate.hour === hour && candidate.minute === minute) + 1,
  );
  if (positions.some((position) => position <= 0)) return '';
  return (
    `RRULE:FREQ=DAILY;BYHOUR=${hours.join(',')};BYMINUTE=${minutes.join(',')};` +
    `BYSETPOS=${positions.join(',')}`
  );
}

function expandWatcherRrule(rrule) {
  const fields = Object.fromEntries(
    String(rrule || '')
      .replace(/^RRULE:/i, '')
      .split(';')
      .map((part) => {
        const index = part.indexOf('=');
        return index < 0 ? [part, ''] : [part.slice(0, index).toUpperCase(), part.slice(index + 1)];
      }),
  );
  if (fields.FREQ !== 'DAILY') return [];
  const numbers = (value) =>
    String(value || '')
      .split(',')
      .map(Number)
      .filter(Number.isInteger)
      .sort((a, b) => a - b);
  const hours = numbers(fields.BYHOUR);
  const minutes = numbers(fields.BYMINUTE);
  const positions = numbers(fields.BYSETPOS);
  const expanded = [];
  for (const hour of hours) {
    for (const minute of minutes) expanded.push({ hour, minute });
  }
  return positions
    .map((position) => expanded[position > 0 ? position - 1 : expanded.length + position])
    .filter(Boolean)
    .sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute))
    .map(({ hour, minute }) => `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`);
}

function expandWatcherSchedulerRruleCt(rrule, date) {
  const [year, month, day] = String(date || '').split('-').map(Number);
  if (![year, month, day].every(Number.isInteger)) return [];
  return expandWatcherRrule(rrule).map((clock) => {
    const [hour, minute] = clock.split(':').map(Number);
    const parts = ctParts(Date.UTC(year, month - 1, day, hour, minute));
    return `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
  });
}

function watcherRruleIsExact(rrule, date) {
  const expected = watcherSchedulerRrule(date);
  return (
    Boolean(expected) &&
    String(rrule || '') === expected &&
    JSON.stringify(expandWatcherSchedulerRruleCt(rrule, date)) ===
      JSON.stringify(WATCHER_CHECKPOINTS_CT)
  );
}

function watcherAutomationPrompt(date = currentBriefingDate()) {
  const day = String(date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new Error('watcher automation prompt requires YYYY-MM-DD briefing date');
  }
  const checkpointCommand = `${WATCHER_CHECKPOINT_COMMAND} --date ${day}`;
  const rescueCommand = `${WATCHER_RESCUE_COMMAND} --date ${day}`;
  const terminalRescueCommand = `${rescueCommand} --await-outcome`;
  const expireCommand = `${WATCHER_EXPIRE_COMMAND} --date ${day}`;
  const verifyPausedCommand = `${WATCHER_VERIFY_PAUSED_COMMAND} --date ${day}`;
  return [
    'You are the installed attended watcher-of-watchers for tonight\'s Daily Briefing.',
    `This acquisition is pinned to briefing date ${day}; never infer or substitute another date.`,
    `Run \`${checkpointCommand}\` first and trust its bounded observation receipt.`,
    'Always leave one concise timestamped checkpoint in this task with the state, stage, reason, whether an intervention is needed, and the next checkpoint. This visible line is required even when evidence is healthy or unchanged.',
    'At 00:00, 00:30, 01:00, 01:30, 02:00, 02:30, 03:00, 03:30, 04:00, and 04:30 CT, require the CARD-PROGRESS receipt to prove a red-unit decrease, an exact verified-green conversion, substantial error-free source output, or a bounded error-fix-retry chain for every still-red exact unit. Heartbeats, timestamp churn, stage labels, skipped work, and repeated tactics are not progress.',
    'Report notes accumulate from the first overnight receipts. Drafting starts at 02:00 CT and must prove accepted work by 02:05, evidence by 02:15, and valid substantial bytes by 03:00. Freeze one same-date report evidence package between 04:00 and 04:30 CT, then finalize the strategic report from that package while card repair continues independently. The 04:00 and 04:30 passes are evidence-hash convergence checks, not the first draft. At both, evaluate card production and report drafting as independent required lanes; a healthy lane cannot conceal a stalled lane.',
    `At the 04:30 CT checkpoint, any STALLED, DEADLINE_AT_RISK, or MISSED result is the hard preventive takeover boundary. The scheduled-fire command mechanically switches itself to rescue-if-needed plus await-outcome inside the 04:30 fire window, so inspect its terminal attestation instead of launching another owner. If that scheduled command fails before a terminal receipt, post the proven problem and intended exact action, then run \`${terminalRescueCommand}\` once to join or reconcile the durable pending intervention. Keep that turn open until the exact report or production takeover is verified-exact-outcome or timed-out-without-exact-outcome; never wait for 05:31 to start protecting delivery.`,
    'If it returns PROGRESSING or COMPLETE, do no other work and spend no helper/model turns.',
    `At checkpoints other than 04:30, if it returns STALLED, DEADLINE_AT_RISK, or MISSED, post a commentary update naming the proven problem and intended exact action before running \`${rescueCommand}\`. Then post visible commentary whenever the action or named evidence changes and finish with the exact result and next checkpoint.`,
    'Verify the deterministic rescue or lease-protected takeover receipt. Never start a competing controller, report writer, or notifier.',
    'EC2 remains the sole autonomous production owner. This task may become the sole temporary owner of one exact stage only after cooperative handoff or proven-dead safe reclaim.',
    'A rescue launch is not an intervention result. Never close or pause while an intervention is started-awaiting-proof, and never pair "intervention remains needed" with "next checkpoint: none". The deterministic await command must reconcile the exact result to verified-exact-outcome or timed-out-without-exact-outcome and write that terminal result into dated report evidence.',
    `The 05:31 CT checkpoint is a delivery audit, not the first takeover boundary. Verify both same-date on-time delivery receipts. If either is still missing after the 04:30 preventive takeover, run \`${terminalRescueCommand}\` as last-resort late recovery and use its terminal receipt before calling \`${expireCommand}\`. If expiration returns EXPIRE_BLOCKED, keep this task as the named retry owner, do not pause, and rerun the exact retry command from that durable receipt until it records either delivery proof or an exact terminal intervention result. Only then update automation \`overnight-briefing-watcher\` to PAUSED and run \`${verifyPausedCommand}\`.`,
  ].join(' ');
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function parseAutomationToml(source) {
  const result = {};
  for (const raw of String(source || '').split(/\r?\n/)) {
    const match = raw.match(/^\s*([a-zA-Z0-9_]+)\s*=\s*(.+?)\s*$/);
    if (!match) continue;
    const key = match[1];
    const value = match[2];
    if (/^"(?:[^"\\]|\\.)*"$/.test(value)) {
      try {
        result[key] = JSON.parse(value);
      } catch {
        result[key] = value.slice(1, -1);
      }
    } else if (/^(?:true|false)$/i.test(value)) {
      result[key] = value.toLowerCase() === 'true';
    } else if (/^-?\d+$/.test(value)) {
      result[key] = Number(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function verifyAutomationConfig(config, { threadId, date, expectPaused = false } = {}) {
  const failures = [];
  const expectedPrompt = watcherAutomationPrompt(date);
  if (config?.id !== WATCHER_AUTOMATION_ID) failures.push('automation-id-mismatch');
  if (config?.kind !== 'heartbeat') failures.push('automation-kind-not-heartbeat');
  if (config?.name !== WATCHER_AUTOMATION_NAME) failures.push('automation-name-mismatch');
  if (config?.prompt !== expectedPrompt) failures.push('automation-prompt-mismatch');
  if (!watcherRruleIsExact(config?.rrule, date)) failures.push('automation-checkpoints-mismatch');
  const expectedStatus = expectPaused ? 'PAUSED' : 'ACTIVE';
  if (String(config?.status || '').toUpperCase() !== expectedStatus) {
    failures.push(`automation-status-not-${expectedStatus.toLowerCase()}`);
  }
  if (threadId && config?.target_thread_id !== threadId) failures.push('automation-target-thread-mismatch');
  return {
    ok: failures.length === 0,
    failures,
    checkpointsCt: expandWatcherSchedulerRruleCt(config?.rrule, date),
    promptSha256: sha256(config?.prompt),
  };
}

function classifyWatcherSnapshot(snapshot = {}) {
  const parts = snapshot.ct || ctParts(snapshot.nowMs || Date.now());
  const clock = nightRelativeMinute(parts);
  const nowMs = Number(snapshot.nowMs);
  const inputStartMs = Number(snapshot.window?.inputStartMs);
  const deliveryComplete = snapshot.delivery?.complete === true;
  const deliveryOnTime = snapshot.delivery?.onTime === true;
  const report = snapshot.report || {};
  const finalizer = snapshot.finalizer || {};
  const production = snapshot.production || {};
  const observer = snapshot.observer || {};
  const namedProgress = snapshot.namedProgress || {};
  const productionStalled =
    production.launchAbsent === true ||
    production.controllerStalled === true ||
    production.cardProgressUnsatisfied === true;
  const reportStageStalled =
    (clock >= milestoneMinute('accepted') && !report.exists && finalizer.active !== true) ||
    (clock >= milestoneMinute('reportStart') && finalizer.dead === true);

  // Wall-clock milestone comparison is meaningful only inside this briefing
  // date's own overnight window. Daytime on the launch date is numerically
  // later than 05:20 but still precedes the 23:00 input boundary.
  if (Number.isFinite(nowMs) && Number.isFinite(inputStartMs) && nowMs < inputStartMs) {
    return { state: 'PROGRESSING', stage: 'pre-window', reason: 'before-11pm-input-window' };
  }

  if (deliveryComplete && deliveryOnTime) {
    return { state: 'COMPLETE', stage: 'delivery', reason: 'both-channels-on-time' };
  }

  if (clock >= milestoneMinute('truthAudit')) {
    return {
      state: 'MISSED',
      stage: 'delivery',
      reason: deliveryComplete ? 'two-channel-delivery-completed-late' : 'two-channel-delivery-missed-05:30:59',
    };
  }

  // Crossing the latest safe boundary outranks a living heartbeat. This is the
  // deterministic state precedence COMPLETE > MISSED > DEADLINE_AT_RISK > STALLED > PROGRESSING.
  if (clock >= milestoneMinute('deliveryWatchdog') && deliveryComplete !== true) {
    return { state: 'DEADLINE_AT_RISK', stage: 'delivery', reason: 'two-channel-proof-missing-at-05:26' };
  }
  if (clock >= milestoneMinute('sendsStarted') && deliveryComplete !== true && snapshot.delivery?.started !== true) {
    return { state: 'DEADLINE_AT_RISK', stage: 'delivery', reason: 'send-attempts-not-proven-by-05:20' };
  }
  if (clock >= milestoneMinute('finalBytes') && (!report.finalized || report.auditReady !== true)) {
    return {
      state: 'DEADLINE_AT_RISK',
      stage: 'report-finalization',
      reason: !report.finalized
        ? 'final-report-not-proven-by-05:15'
        : 'hash-bound-report-audit-not-proven-by-05:15',
    };
  }
  if (clock >= milestoneMinute('repairFreeze') && report.repairFreezeReady !== true) {
    return {
      state: 'DEADLINE_AT_RISK',
      stage: 'repair-freeze',
      reason: 'same-date-repair-freeze-not-proven-by-05:03',
    };
  }
  if (
    clock >= milestoneMinute('finalizationAdvancing') &&
    !report.finalized &&
    !(finalizer.active === true && finalizer.deadlineSafe === true)
  ) {
    return { state: 'DEADLINE_AT_RISK', stage: 'report-finalization', reason: 'report-finalization-not-advancing-by-05:05' };
  }
  if (
    clock >= milestoneMinute('evidenceFreeze') &&
    report.evidenceFreezeReady !== true
  ) {
    return {
      state: 'DEADLINE_AT_RISK',
      stage: 'report-draft',
      reason: 'same-date-report-evidence-freeze-missing-by-04:35',
    };
  }
  if (productionStalled && reportStageStalled) {
    return {
      state: clock >= milestoneMinute('validDraft') ? 'DEADLINE_AT_RISK' : 'STALLED',
      stage: 'card-and-report',
      reason: `independent-lanes-failed:${
        production.cardProgress?.reason ||
        (production.launchAbsent ? 'canonical-controller-launch-absent' : 'canonical-controller-stalled')
      }:${finalizer.dead === true ? 'report-finalizer-owner-proven-dead' : 'report-stage-not-started-by-02:05'}`,
    };
  }
  if (
    clock >= milestoneMinute('validDraft') &&
    !report.deliveryReady &&
    !(finalizer.active === true && finalizer.deadlineSafe === true)
  ) {
    return { state: 'DEADLINE_AT_RISK', stage: 'report-draft', reason: 'report-rescue-latest-safe-start-crossed' };
  }

  if (reportStageStalled) {
    return {
      state: 'STALLED',
      stage: 'report-draft',
      reason: finalizer.dead === true
        ? 'report-finalizer-owner-proven-dead'
        : 'report-stage-not-started-by-02:05',
    };
  }
  if (productionStalled) {
    return {
      state: 'STALLED',
      stage: production.launchAbsent ? 'controller-launch' : 'card-production',
      reason: production.launchAbsent
        ? 'canonical-controller-launch-absent'
        : production.controllerStalled
          ? 'canonical-controller-stalled'
          : production.cardProgress?.reason || 'hourly-card-progress-unsatisfied',
    };
  }
  if (observer.down === true) {
    return { state: 'STALLED', stage: 'cloud-observer', reason: 'cloud-model-observer-down' };
  }
  if (
    clock < milestoneMinute('reportStart') &&
    namedProgress.evidence?.boardExactUnitsComplete === true
  ) {
    return { state: 'PROGRESSING', stage: 'card-production', reason: 'card-board-complete' };
  }
  if (namedProgress.changed === false && namedProgress.observationComparable === true) {
    return { state: 'STALLED', stage: namedProgress.stage || 'card-production', reason: 'no-named-deliverable-advanced' };
  }

  return {
    state: 'PROGRESSING',
    stage:
      clock >= milestoneMinute('reportStart')
        ? namedProgress.evidence?.boardExactUnitsComplete === true
          ? 'report'
          : 'card-and-report'
        : 'card-production',
    reason: namedProgress.reason || 'named-forward-progress',
  };
}

function watcherActionFor(classification = {}) {
  if (classification.state === 'COMPLETE' || classification.state === 'PROGRESSING') {
    return 'NO_OP';
  }
  if (classification.stage === 'cloud-observer') return 'RESTART_OBSERVER_ONLY';
  if (classification.stage === 'controller-launch' || classification.stage === 'card-production') {
    return 'RECOVER_EXACT_PRODUCTION_STAGE';
  }
  if (classification.stage === 'card-and-report') return 'RECOVER_PRODUCTION_AND_REPORT';
  if (classification.stage === 'delivery') return 'LEASE_PROTECTED_DELIVERY';
  return 'LEASE_PROTECTED_REPORT_TAKEOVER';
}

module.exports = {
  WATCHER_AUTOMATION_ID,
  WATCHER_AUTOMATION_NAME,
  WATCHER_DESKTOP_RUNTIME_ROOT,
  WATCHER_CHECKPOINT_COMMAND,
  WATCHER_RESCUE_COMMAND,
  WATCHER_EXPIRE_COMMAND,
  WATCHER_VERIFY_PAUSED_COMMAND,
  WATCHER_SCHEDULER_JITTER_MAX_MS,
  WATCHER_CHECKPOINTS_CT,
  WATCHER_REPORT_MILESTONES_CT,
  WATCHER_STATES,
  WATCHER_INTERVENTION_RESULTS,
  watcherInterventionState,
  ctParts,
  currentBriefingDate,
  nightRelativeMinute,
  watcherCheckpointInstants,
  watcherSchedulerRrule,
  expandWatcherRrule,
  expandWatcherSchedulerRruleCt,
  watcherRruleIsExact,
  milestoneMinute,
  watcherAutomationPrompt,
  sha256,
  parseAutomationToml,
  verifyAutomationConfig,
  classifyWatcherSnapshot,
  watcherActionFor,
};
