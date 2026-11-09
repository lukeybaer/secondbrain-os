'use strict';

// Alarm-only classifier diversity for the attended watcher. This module is
// intentionally pure and dependency-free: it reads a bounded projection of
// raw receipts, may contradict a false green, never declares completion, and
// never mutates production evidence.

const REPORT_STATUS_SCHEMA = 'overnight-watch-report-status@1';
const AUDIT_SCHEMA = 'briefing-pre-transport-audit@1';
const REPAIR_FREEZE_SCHEMAS = new Set([
  'briefing-repair-freeze@1',
  'briefing-repair-freeze@2',
]);
const DELIVERY_SLO_SCHEMA = 'briefing-delivery-slo@1';
const DELIVERY_STAGES_SCHEMA = 'briefing-delivery-required-stages@1';
const SHA256 = /^[a-f0-9]{64}$/i;
const EXACT_PROGRESS_KINDS = new Set([
  'exact-card-cleared',
  'substantive-source-output',
  'error-fix-retry',
]);
const POST_TERMINAL_PROGRESS_FRESH_MS = 30 * 60 * 1000;

function chicagoClock(nowMs) {
  if (!Number.isFinite(nowMs)) return null;
  try {
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
        .formatToParts(new Date(nowMs))
        .filter((part) => part.type !== 'literal')
        .map((part) => [part.type, part.value]),
    );
    return {
      date: `${parts.year}-${parts.month}-${parts.day}`,
      hour: Number(parts.hour),
      minute: Number(parts.minute),
      second: Number(parts.second),
    };
  } catch {
    return null;
  }
}

function briefingRelativeClockMinutes(clock, briefingDate) {
  const minutes = Number(clock?.hour) * 60 + Number(clock?.minute);
  return String(clock?.date || '') < String(briefingDate || '')
    ? minutes - 24 * 60
    : minutes;
}

function attendedIdentity(snapshot) {
  const nowMs = Number(snapshot?.nowMs);
  const window = snapshot?.window || {};
  const date = String(window.date || '');
  const inputStartMs = Number(window.inputStartMs);
  const deliveryDeadlineMs = Number(window.deliveryDeadlineMs);
  const attendedEndMs = Number(window.attendedEndMs);
  const suppliedClock = snapshot?.ct || {};
  const actualClock = chicagoClock(nowMs);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(inputStartMs) ||
    !Number.isFinite(deliveryDeadlineMs) ||
    !Number.isFinite(attendedEndMs) ||
    !(inputStartMs < deliveryDeadlineMs && deliveryDeadlineMs < attendedEndMs) ||
    !actualClock ||
    actualClock.date !== String(suppliedClock.date || '') ||
    actualClock.hour !== Number(suppliedClock.hour) ||
    actualClock.minute !== Number(suppliedClock.minute) ||
    nowMs < inputStartMs ||
    nowMs >= attendedEndMs
  ) {
    return null;
  }
  return {
    nowMs,
    date,
    clock: briefingRelativeClockMinutes(actualClock, date),
    inputStartMs,
    deliveryDeadlineMs,
  };
}

function parsedAt(value, { earliestMs, latestMs }) {
  const at = Date.parse(String(value || ''));
  return Number.isFinite(at) && at >= earliestMs && at <= latestMs ? at : null;
}

function reportArtifact(evidence, identity) {
  const status = evidence?.reportStatus;
  const report = status?.report;
  if (
    status?.schema !== REPORT_STATUS_SCHEMA ||
    status?.date !== identity.date ||
    report?.exists !== true ||
    !(Number(report?.sizeBytes) > 0) ||
    !SHA256.test(String(report?.sha256 || ''))
  ) {
    return null;
  }
  return { status, report };
}

function finalizerAccepted(evidence, identity) {
  const status = evidence?.reportStatus;
  const finalizer = status?.finalizer;
  const startedAt = parsedAt(finalizer?.startedAt, {
    earliestMs: identity.inputStartMs,
    latestMs: identity.nowMs,
  });
  const expiresAt = Date.parse(String(finalizer?.expiresAt || ''));
  return Boolean(
    status?.schema === REPORT_STATUS_SCHEMA &&
      status?.date === identity.date &&
      finalizer?.present === true &&
      finalizer?.active === true &&
      startedAt != null &&
      Number.isFinite(expiresAt) &&
      expiresAt > identity.nowMs &&
      String(finalizer?.ownerKind || '').trim() &&
      Number(finalizer?.pid) > 0,
  );
}

function repairFreezeProven(evidence, identity) {
  const receipt = evidence?.repairFreeze;
  return Boolean(
    REPAIR_FREEZE_SCHEMAS.has(receipt?.schema) &&
      receipt?.date === identity.date &&
      receipt?.ok === true &&
      [
        'no-new-repair-after-05:00-ct',
        'no-new-repair-after-terminal-settling-or-05:25-ct',
        'no-new-repair-after-terminal-settling-or-04:30-ct',
      ].includes(
        receipt?.admissionRule,
      ) &&
      parsedAt(receipt?.cutoffAt, {
        earliestMs: identity.inputStartMs,
        latestMs: identity.nowMs,
      }) != null &&
      parsedAt(receipt?.frozenAt, {
        earliestMs: identity.inputStartMs,
        latestMs: identity.nowMs,
      }) != null &&
      SHA256.test(String(receipt?.board?.sha256 || '')) &&
      Number.isFinite(Number(receipt?.board?.redUnitCount)) &&
      Number.isFinite(Number(receipt?.board?.greenUnitCount)) &&
      Number.isFinite(Number(receipt?.board?.totalUnitCount)),
  );
}

function reportAuditProven(evidence, identity) {
  const artifact = reportArtifact(evidence, identity);
  const receipt = evidence?.reportAudit;
  return Boolean(
    artifact &&
      receipt?.schema === AUDIT_SCHEMA &&
      receipt?.date === identity.date &&
      receipt?.ok === true &&
      Array.isArray(receipt?.failures) &&
      receipt.failures.length === 0 &&
      receipt?.report?.finalized === true &&
      SHA256.test(String(receipt?.report?.stagedSha256 || '')) &&
      receipt.report.stagedSha256 === artifact.report.sha256 &&
      parsedAt(receipt?.checkedAt, {
        earliestMs: identity.inputStartMs,
        latestMs: identity.nowMs,
      }) != null,
  );
}

function deliveryStarted(evidence, identity) {
  const receipt = evidence?.deliverySlo;
  const proof = receipt?.proof;
  if (
    receipt?.schema !== DELIVERY_SLO_SCHEMA ||
    receipt?.date !== identity.date ||
    proof?.markerPresent !== true
  ) {
    return false;
  }
  return proof.telegram === 'sent' || proof.gmail === 'sent';
}

function deliveryCompletedAt(evidence, identity) {
  const receipt = evidence?.deliverySlo;
  const proof = receipt?.proof;
  const stages = proof?.requiredStages;
  const required = stages?.stages || {};
  const exactStagesComplete = [
    'report-finalization',
    'telegram-delivery',
    'gmail-delivery',
  ].every((name) => (
    required[name]?.required === true &&
    required[name]?.status === 'complete' &&
    parsedAt(required[name]?.completedAt, {
      earliestMs: identity.inputStartMs,
      latestMs: identity.nowMs,
    }) != null
  ));
  if (
    receipt?.schema !== DELIVERY_SLO_SCHEMA ||
    receipt?.date !== identity.date ||
    proof?.markerPresent !== true ||
    proof?.markerStatus !== 'sent' ||
    proof?.telegram !== 'sent' ||
    proof?.gmail !== 'sent' ||
    stages?.schema !== DELIVERY_STAGES_SCHEMA ||
    stages?.status !== 'closed' ||
    !Array.isArray(stages?.missing) ||
    stages.missing.length !== 0 ||
    !exactStagesComplete
  ) {
    return null;
  }
  return parsedAt(proof?.fullyDeliveredAt, {
    earliestMs: identity.inputStartMs,
    latestMs: identity.nowMs,
  });
}

function postTerminalExactProgress(snapshot, identity, finishedAt) {
  const proofs = snapshot?.production?.cardProgress?.exactProofs;
  if (!Array.isArray(proofs)) return false;
  return proofs.some((proof) => {
    const at = parsedAt(proof?.at, {
      earliestMs: identity.inputStartMs,
      latestMs: identity.nowMs,
    });
    return (
      EXACT_PROGRESS_KINDS.has(String(proof?.kind || '')) &&
      at != null &&
      at > finishedAt &&
      identity.nowMs - at <= POST_TERMINAL_PROGRESS_FRESH_MS &&
      Array.isArray(proof?.unitIds) &&
      proof.unitIds.some((unitId) => String(unitId || '').trim())
    );
  });
}

function controllerAlarm(snapshot, identity) {
  const evidence = snapshot?.attendedEvidence || {};
  const status = evidence?.reportStatus;
  const board = status?.board;
  const redUnitCount = Number(board?.redUnitCount);
  if (
    status?.schema !== REPORT_STATUS_SCHEMA ||
    status?.date !== identity.date ||
    board?.date !== identity.date ||
    board?.ran !== true ||
    board?.stale === true ||
    board?.exactUnitsComplete !== true ||
    !Number.isFinite(redUnitCount) ||
    redUnitCount <= 0
  ) {
    return null;
  }
  const run = evidence?.controllerRun;
  if (!run) return null;
  const startedAt = parsedAt(run.startedAt, {
    earliestMs: identity.inputStartMs,
    latestMs: identity.nowMs,
  });
  if (
    run.date !== identity.date ||
    run.mode !== 'overnight' ||
    !(run.bootstrapRequested === true || run.bootstrap) ||
    startedAt == null
  ) {
    return {
      state: 'STALLED',
      stage: 'card-production',
      reason: 'tripwire-controller-terminal-evidence-unknown-with-open-red-units',
    };
  }
  if (run.finishedAt == null || run.finishedAt === '') return null;
  const finishedAt = parsedAt(run.finishedAt, {
    earliestMs: startedAt,
    latestMs: identity.nowMs,
  });
  if (finishedAt != null && postTerminalExactProgress(snapshot, identity, finishedAt)) {
    return null;
  }
  return {
    state: 'STALLED',
    stage: 'card-production',
    reason: finishedAt == null
      ? 'tripwire-controller-terminal-evidence-unknown-with-open-red-units'
      : 'tripwire-controller-terminal-with-open-red-units',
  };
}

function classifyAttendedTripwire(snapshot = {}) {
  const identity = attendedIdentity(snapshot);
  if (!identity) return null;
  const evidence = snapshot.attendedEvidence || {};
  const clock = identity.clock;

  if (clock >= 5 * 60 + 31) {
    const completedAt = deliveryCompletedAt(evidence, identity);
    if (completedAt == null || completedAt > identity.deliveryDeadlineMs + 59_999) {
      return {
        state: 'MISSED',
        stage: 'delivery',
        reason: completedAt == null
          ? 'tripwire-two-channel-terminal-proof-missing'
          : 'tripwire-two-channel-delivery-late',
      };
    }
  }
  if (clock >= 5 * 60 + 26 && deliveryCompletedAt(evidence, identity) == null) {
    return {
      state: 'DEADLINE_AT_RISK',
      stage: 'delivery',
      reason: 'tripwire-channel-proof-missing-at-05:26',
    };
  }
  if (clock >= 5 * 60 + 20 && !deliveryStarted(evidence, identity)) {
    return {
      state: 'DEADLINE_AT_RISK',
      stage: 'delivery',
      reason: 'tripwire-send-not-started-at-05:20',
    };
  }
  if (clock >= 5 * 60 + 15 && !reportAuditProven(evidence, identity)) {
    return {
      state: 'DEADLINE_AT_RISK',
      stage: 'report-finalization',
      reason: 'tripwire-finalized-hash-audited-bytes-missing-at-05:15',
    };
  }
  if (clock >= 5 * 60 + 3 && !repairFreezeProven(evidence, identity)) {
    return {
      state: 'DEADLINE_AT_RISK',
      stage: 'repair-freeze',
      reason: 'tripwire-repair-freeze-missing-at-05:03',
    };
  }
  if (clock >= 3 * 60 && !reportArtifact(evidence, identity)) {
    return {
      state: 'STALLED',
      stage: 'report-draft',
      reason: 'tripwire-valid-report-bytes-missing-at-03:00',
    };
  }
  if (clock >= 2 * 60 + 15 && !reportArtifact(evidence, identity)) {
    return {
      state: 'STALLED',
      stage: 'report-draft',
      reason: 'tripwire-report-evidence-missing-at-02:15',
    };
  }
  if (
    clock >= 2 * 60 + 5 &&
    !reportArtifact(evidence, identity) &&
    !finalizerAccepted(evidence, identity)
  ) {
    return {
      state: 'STALLED',
      stage: 'report-draft',
      reason: 'tripwire-report-job-not-accepted-at-02:05',
    };
  }
  if (clock < 5 * 60) return controllerAlarm(snapshot, identity);
  return null;
}

module.exports = { briefingRelativeClockMinutes, classifyAttendedTripwire };
