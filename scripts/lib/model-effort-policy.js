'use strict';

const {
  EFFORT_RANK,
  OVERNIGHT_CEILING,
  decideSpawnModel,
  overnightProfileActive,
  ownerReportLockApplies,
  recordRouterDecision,
  resolveOwnerReportLock,
} = require('./model-router.js');
const { loadModelRoutingPolicy } = require('./model-routing-config.js');

const ROUTING_POLICY = loadModelRoutingPolicy({ env: {} });

const PHASE_EFFORT = Object.freeze({
  'routine-observation': 'low',
  'strategic-synthesis': 'medium',
  'hard-decision': 'high',
});
// Only the keys are read: resolveCodexDecision refuses a phase that is not
// listed. The values are not the model a phase runs. The Codex model comes from
// decideSpawnModel (by day strategic-synthesis routes extract-summarize to
// gpt-5.6-terra at low), and the overnight strategic report runs gpt-5.6-sol at
// medium through the owner report lock (ownerReportCodexDecision), not through
// config phaseCodexModels["strategic-synthesis"].
const PHASE_CODEX_MODEL = Object.freeze({
  ...ROUTING_POLICY.phaseCodexModels,
});
const AUTOMATION_EFFORTS = new Set(['low', 'medium', 'high']);
// ExampleCo 2026-09-24: overnight effort is capped at medium on every model.
const OVERNIGHT_EFFORT_CAP = OVERNIGHT_CEILING.claude.effort;

function requiredText(value, field) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`${field} is required`);
  return text;
}

function aboveOvernightCap(effort) {
  return Object.hasOwn(EFFORT_RANK, effort) && EFFORT_RANK[effort] > EFFORT_RANK[OVERNIGHT_EFFORT_CAP];
}

// Under the night marker an effort above medium is clamped down to medium and
// receipted, never refused (ExampleCo 2026-09-22: briefing work never refuses a
// model). By day the phase contract below still throws.
function clampOvernightEffort(requested, phase, ledgerPath) {
  recordRouterDecision({
    spawn: 'model-effort-policy',
    mode: 'overnight-clamp',
    signals: { phase: phase || null, requestedEffort: requested },
    decision: {
      effort: OVERNIGHT_EFFORT_CAP,
      reason: `owner overnight ceiling effort ${OVERNIGHT_EFFORT_CAP}: ${requested} clamped to ${OVERNIGHT_EFFORT_CAP}`,
    },
    applied: true,
  }, ledgerPath ? { ledgerPath } : {});
  return OVERNIGHT_EFFORT_CAP;
}

// ledgerPath only redirects the clamp receipt (tests keep the checkout ledger clean).
function resolveModelEffort(opts = {}, env = process.env, { ledgerPath } = {}) {
  const overnight = overnightProfileActive('', env);
  const phase = String(opts.phase || '').trim();
  if (!phase) {
    const effort = opts.effort ? String(opts.effort).trim().toLowerCase() : '';
    return overnight && aboveOvernightCap(effort) ? clampOvernightEffort(effort, '', ledgerPath) : effort;
  }
  if (!Object.hasOwn(PHASE_EFFORT, phase)) throw new Error(`unknown model phase: ${phase}`);
  if (phase === 'hard-decision') {
    requiredText(opts.hardQuestion, 'hardQuestion');
    requiredText(opts.returnCondition, 'returnCondition');
  }
  const requested = String(opts.effort || PHASE_EFFORT[phase]).trim().toLowerCase();
  if (overnight && aboveOvernightCap(requested)) return clampOvernightEffort(requested, phase, ledgerPath);
  if (!AUTOMATION_EFFORTS.has(requested)) {
    throw new Error(`${requested || 'empty'} effort is not allowed for automated phase ${phase}`);
  }
  const ceiling = PHASE_EFFORT[phase];
  const order = ['low', 'medium', 'high'];
  if (order.indexOf(requested) > order.indexOf(ceiling)) {
    throw new Error(`${requested} effort is not allowed for automated phase ${phase}`);
  }
  return requested;
}

function resolveAutomatedEffortRequest(body = {}) {
  const requested = String(body.reasoning_effort || '').trim().toLowerCase();
  if (!requested) return '';
  const phase = requiredText(body.work_phase, 'work_phase');
  return resolveModelEffort({
    phase,
    effort: requested,
    hardQuestion: body.hard_question,
    returnCondition: body.return_condition,
  });
}

// The report's Codex fallback rung. Exactly the owner report lock, never a
// routed tier: before this the rung routed strategic-synthesis as
// extract-summarize and ran gpt-5.6-terra at low.
function ownerReportCodexDecision() {
  const route = resolveOwnerReportLock('codex');
  const decision = {
    routed: true,
    lane: 'codex',
    tier: null,
    model: route.model,
    effort: route.effort,
    requestedEffort: route.effort,
    effortSubstituted: false,
    ownerReportLock: true,
    reason: `owner report lock ${route.model}/${route.effort} (ExampleCo 2026-09-24)`,
  };
  recordRouterDecision({
    spawn: 'briefing-ask-ai-codex',
    lane: 'codex',
    mode: 'owner-report-lock',
    signals: { surface: 'overnight-strategic-briefing', ownerReportLock: 'overnight-strategic-briefing' },
    decision,
    applied: true,
  });
  return decision;
}

function resolveCodexDecision(opts = {}) {
  if (ownerReportLockApplies(opts)) return ownerReportCodexDecision();
  const phase = String(opts.phase || '').trim();
  if (phase && !Object.hasOwn(PHASE_CODEX_MODEL, phase)) {
    throw new Error(`model phase has no explicit Codex model: ${phase}`);
  }
  const critical = phase === 'hard-decision';
  const criticalReason = critical
    ? `${requiredText(opts.hardQuestion, 'hardQuestion')}; return condition: ${requiredText(opts.returnCondition, 'returnCondition')}`
    : '';
  const decision = decideSpawnModel(
    opts.briefingContext === true ? 'briefing-ask-ai-codex' : 'ask-ai-codex',
    'codex',
    {
      taskType:
        phase === 'routine-observation'
          ? 'observe'
          : critical
            ? 'hard-decision'
            : 'extract-summarize',
      complexity: opts.complexity || (critical ? 'critical' : phase === 'routine-observation' ? 'routine' : 'bounded'),
      complexityReason:
        opts.complexityReason ||
        criticalReason ||
        (phase === 'routine-observation'
          ? 'The phase observes or extracts current evidence without synthesis.'
          : 'The phase performs bounded extraction and synthesis under a fixed output contract.'),
    },
  );
  if (!decision) throw new Error('Codex phase requires a live model routing decision; work remains unfinished.');
  return decision;
}

function resolveCodexModel(opts = {}) {
  return resolveCodexDecision(opts).model;
}

module.exports = {
  AUTOMATION_EFFORTS,
  PHASE_CODEX_MODEL,
  PHASE_EFFORT,
  resolveAutomatedEffortRequest,
  resolveCodexModel,
  resolveCodexDecision,
  resolveModelEffort,
};
