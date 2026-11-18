'use strict';

const path = require('node:path');

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
    'retired 2026-09-24 by the owner: the nightly Amy-improvement research and its Feature Backlog card are killed',
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

// Per-job routing hints that override the class default. Memory consolidation
// is a hard judgment over the whole corpus, not a routine synthesis: every
// unattended Saturday run on the class default (synthesize, tier 1, Sonnet 4.6)
// kept every cluster, and the only real pass (2026-10-31, 80 merge verdicts)
// ran on a top model (Owner decision: "we're doing the real one weekly").
// It asks for the hard-decision tier on the owner's overnight profile (Claude Opus
// 5.5, Codex Sol); the router stays the authority on the final route.
const JOB_ROUTE_HINTS = Object.freeze({
  'memory-consolidation': Object.freeze({ taskType: 'hard-decision', profile: 'overnight' }),
});

function jobRouteHint(skillName) {
  const name = String(skillName || '').trim();
  return Object.hasOwn(JOB_ROUTE_HINTS, name) ? JOB_ROUTE_HINTS[name] : null;
}

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// The core method docs that own this job, from their frontmatter paths.
// skill-management owns how every job launches, not what it does, so it is
// left out. The prompt router keys on words, and a job packet's words point
// at launch mechanics, so the owner is named here instead (Codex review
// 2026-11-07: the memory packet never routed to its new core doc).
function jobCoreMethodDocs(skillName, root = REPO_ROOT) {
  const file = `scheduled-tasks/${String(skillName || '').trim()}/SKILL.md`;
  try {
    // Lazy: the public mirror ships this file without the core-doc library or
    // core docs, and its packets simply name no owner.
    const { loadComponents } = require('./core-doc-coverage.js');
    return loadComponents(root, { strict: false })
      .filter((c) => c.name !== 'skill-management' && c.regexes.some((re) => re.test(file)))
      .map((c) => c.doc);
  } catch {
    return [];
  }
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
  const coreDocs = jobCoreMethodDocs(skillName);
  const sections = [
    '=== AMY SCHEDULED JOB PACKET V1 ===',
    `Job: ${String(skillName || 'unknown')}`,
    `Class: ${jobClass}`,
    `Current job requirements and method: ${methodPage}`,
    ...(coreDocs.length ? [`Core method owner, read before acting: ${coreDocs.join(', ')}`] : []),
    ...(methodTruncated ? [`The excerpt below is incomplete. Read ${methodPage}${skillName === 'memory-consolidation' ? '; do not read historical LESSONS or LEARNINGS case judgments' : ' and its referenced LEARNINGS.md'} before acting.`] : []),
    jobClass === 'monitoring'
      ? 'Monitoring is deterministic. Do not make a model call; record the observation and exit.'
      : jobClass === 'release-rescue-canary'
        ? 'This is a machine-only release rescue proof. Only the release harness may run it: re-exec in an isolated worktree, force the Claude failure, and accept only the exact Codex sentinel. Do not call a model provider.'
        : 'Use only the subscription rung selected by the runner. Paid model APIs remain unauthorized.',
    `Outcome: ${boundedText(outcome, 900)}`,
    `Constraints: ${boundedText(constraints, 1200)}`,
    `Relevant facts: ${boundedText(facts, 1800)}`,
    'Skill instructions:',
    boundedText(skillPrompt, 5000),
    '=== END AMY SCHEDULED JOB PACKET ===',
  ];
  const packet = sections.join('\n');
  if (Buffer.byteLength(packet, 'utf8') > MAX_PACKET_BYTES) {
    throw new Error(`scheduled job packet exceeds ${MAX_PACKET_BYTES} bytes`);
  }
  const hint = jobRouteHint(skillName);
  const classTaskType = modelTaskType(jobClass);
  return {
    packet,
    jobClass,
    methodPage,
    methodTruncated,
    coreDocs,
    taskType: classTaskType && hint ? hint.taskType : classTaskType,
    ...(classTaskType && hint && hint.profile ? { profile: hint.profile } : {}),
    bytes: Buffer.byteLength(packet, 'utf8'),
  };
}

module.exports = {
  JOB_CLASSES,
  MAX_PACKET_BYTES,
  RETIRED_SCHEDULED_JOBS,
  buildScheduledJobPacket,
  declaredJobClass,
  JOB_ROUTE_HINTS,
  jobRouteHint,
  jobCoreMethodDocs,
  modelTaskType,
  retiredScheduledJobReason,
  scheduledJobExecutionMode,
};
