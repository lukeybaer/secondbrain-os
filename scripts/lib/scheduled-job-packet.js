'use strict';

// The scheduled fleet declares work in one small vocabulary.  This is a
// routing hint, not an authority or a model call: model selection remains in
// model-router and paid API policy remains outside this module.
const JOB_CLASSES = Object.freeze({
  extract: Object.freeze([]),
  'draft-decide': Object.freeze([]),
  'build-judge': Object.freeze([]),
  monitoring: Object.freeze([]),
  'release-rescue-canary': Object.freeze(['release-rescue-canary']),
});

// Retired jobs keep their no-op SKILL.md (and so their class above) as
// history, but no scheduler may launch them and the runner refuses them before
// any worktree, data write, or model call.
const RETIRED_SCHEDULED_JOBS = Object.freeze({
  'secondbrain-nightly-enhancement':
    'retired 2026-09-24 by ExampleCo: the nightly Amy-improvement research and its Feature Backlog card are killed',
});

function retiredScheduledJobReason(skillName) {
  const name = String(skillName || '').trim();
  return Object.hasOwn(RETIRED_SCHEDULED_JOBS, name) ? RETIRED_SCHEDULED_JOBS[name] : '';
}

const MAX_PACKET_BYTES = 10 * 1024;

function declaredJobClass(skillName) {
  const name = String(skillName || '').trim();
  for (const [jobClass, skills] of Object.entries(JOB_CLASSES)) {
    if (skills.includes(name)) return jobClass;
  }
  return 'draft-decide';
}

function modelTaskType(jobClass) {
  if (jobClass === 'extract') return 'extract';
  if (jobClass === 'draft-decide') return 'synthesize';
  if (jobClass === 'build-judge') return 'repair-code';
  if (jobClass === 'release-rescue-canary') return null;
  return null;
}

function scheduledJobExecutionMode(jobClass, { canaryMode = false, hasDirectConfig = false } = {}) {
  if (jobClass === 'release-rescue-canary') {
    return canaryMode ? 'machine-canary' : 'refuse-canary-harness-required';
  }
  if (jobClass === 'monitoring' && !hasDirectConfig) return 'skip-no-model';
  return 'run';
}

function boundedText(value, maxBytes) {
  const input = String(value || '').trim();
  if (Buffer.byteLength(input, 'utf8') <= maxBytes) return input;
  let out = input;
  while (Buffer.byteLength(out, 'utf8') > maxBytes) out = out.slice(0, -128);
  return `${out.trim()}\n[excerpt truncated]`;
}

function buildScheduledJobPacket({ skillName, outcome = '', constraints = '', facts = '', skillPrompt = '', scheduleDate = '' } = {}) {
  const jobClass = declaredJobClass(skillName);
  const methodPage = `scheduled-tasks/${skillName}/SKILL.md`;
  const methodTruncated = Buffer.byteLength(String(skillPrompt).trim(), 'utf8') > 5000;
  const sections = [
    '=== AMY SCHEDULED JOB PACKET V1 ===',
    `Job: ${String(skillName || 'unknown')}`,
    `Class: ${jobClass}`,
    `Current job requirements and method: ${methodPage}`,
    ...(methodTruncated ? [`The excerpt below is incomplete. Read ${methodPage} and its referenced LEARNINGS.md before acting.`] : []),
    jobClass === 'monitoring'
      ? 'Monitoring is deterministic. Do not make a model call; record the observation and exit.'
      : jobClass === 'release-rescue-canary'
        ? 'This is a machine-only release rescue proof. Only the release harness may run it: re-exec in an isolated worktree, force the Claude failure, and accept only the exact Codex sentinel. Do not call a model provider.'
        : 'Use only the subscription rung selected by the runner. Paid model APIs remain unauthorized.',
    `Outcome: ${boundedText(outcome, 900)}`,
    `Constraints: ${boundedText(constraints, 1200)}`,
    `Relevant facts: ${boundedText(facts, 1800)}`,
    ...(String(skillName || '').trim() === 'video-quality-research'
      ? [
          `Runtime artifact contract: write the dated receipt only to \`\${SECONDBRAIN_DATA_DIR}/agent/video-quality-research/${String(scheduleDate || '<schedule-date>')}.json\`, where SECONDBRAIN_DATA_DIR is the runner-provided runtime root. Do not prepend \`data/\`, use the repository root, or write to any live/release data directory. The receipt must carry the scheduled date, sourceSha, status, findings array, and evidencePaths array.`,
        ]
      : []),
    'Skill instructions:',
    boundedText(skillPrompt, 5000),
    '=== END AMY SCHEDULED JOB PACKET ===',
  ];
  const packet = sections.join('\n');
  if (Buffer.byteLength(packet, 'utf8') > MAX_PACKET_BYTES) {
    throw new Error(`scheduled job packet exceeds ${MAX_PACKET_BYTES} bytes`);
  }
  return { packet, jobClass, methodPage, methodTruncated, taskType: modelTaskType(jobClass), bytes: Buffer.byteLength(packet, 'utf8') };
}

module.exports = {
  JOB_CLASSES,
  MAX_PACKET_BYTES,
  RETIRED_SCHEDULED_JOBS,
  buildScheduledJobPacket,
  declaredJobClass,
  modelTaskType,
  retiredScheduledJobReason,
  scheduledJobExecutionMode,
};
