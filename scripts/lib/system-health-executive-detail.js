'use strict';

function cleanLine(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function comparable(value) {
  return cleanLine(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function scheduledTaskRecovery(item, evidence) {
  if (!/^scheduled tasks?$/i.test(cleanLine(item && item.name))) return null;

  const completion = evidence.match(/\b(\d+)\s*\/\s*(\d+)\s+scheduled tasks? fired\b/i);
  if (!completion) return null;
  const fired = Number(completion[1]);
  const expected = Number(completion[2]);
  if (!Number.isFinite(fired) || fired !== expected || expected < 1) return null;
  if (!/\b(?:post-release rescue|current-release(?: rescue)?) canary passed\b/i.test(evidence)) {
    return null;
  }

  const fallback = evidence.match(/\b(\d+)\s+used the fallback executor\b/i);
  const fallbackCount = fallback ? Number(fallback[1]) : 0;
  const problem = `All ${expected} scheduled tasks completed successfully.`;
  const solution = fallbackCount
      ? `${fallbackCount} task${fallbackCount === 1 ? '' : 's'} used the configured fallback executor; the current-release Claude-to-Codex rescue canary also passed.`
      : 'No task needed the fallback executor; the current-release Claude-to-Codex rescue canary passed.';
  const impact = 'No action. This is recovery telemetry, not a defect.';
  return {
    problem,
    solution,
    impact,
    // Compatibility aliases for older consumers. The briefing renderer uses
    // the practical Problem / Solution / Impact vocabulary below.
    conclusion: problem,
    recovery: solution,
    action: impact,
  };
}

function isSystemHealthExampleCoFacingAsk(value) {
  const text = cleanLine(value).toLowerCase();
  if (!text) return false;
  return !/amy owns|amy must|no ExampleCo decision|no decision is requested|otherwise amy|only if|^if amy cannot|no ExampleCo action|^repair\s*:/.test(
    text,
  );
}

function buildSystemHealthExecutiveDetail({
  item = {},
  readableDetail = '',
  wrongText = '',
  recoveryText = '',
  actionText = '',
  askText = '',
  ExampleCoFacingAsk = false,
} = {}) {
  const evidence = cleanLine(
    [readableDetail, wrongText, recoveryText, item.detail].filter(Boolean).join(' '),
  );
  const recoveredScheduledTasks = scheduledTaskRecovery(item, evidence);
  if (recoveredScheduledTasks) return recoveredScheduledTasks;

  const conclusion =
    cleanLine(wrongText || readableDetail || item.detail) ||
    `${cleanLine(item.name) || 'This health check'} is not green.`;
  const recoveryCandidate = cleanLine(recoveryText);
  const recovery =
    recoveryCandidate && comparable(recoveryCandidate) !== comparable(conclusion)
      ? recoveryCandidate
      : 'No successful automated recovery is recorded for this check.';
  const action =
    cleanLine(ExampleCoFacingAsk ? askText : actionText) ||
    'The specific correction is not yet determined. Diagnose the failed practical step first, then name and verify the exact correction.';

  const problem = conclusion;
  const solution = recovery === 'No successful automated recovery is recorded for this check.'
    ? action
    : `${recovery} Next: ${action}`;
  const impact = ExampleCoFacingAsk
    ? `ExampleCo action is required: ${cleanLine(askText || action)}`
    : `Until this passes, ${cleanLine(item.name) || 'this subsystem'} cannot be trusted in the briefing.`;

  return {
    problem,
    solution,
    impact,
    conclusion,
    recovery,
    action,
  };
}

module.exports = {
  buildSystemHealthExecutiveDetail,
  isSystemHealthExampleCoFacingAsk,
};
