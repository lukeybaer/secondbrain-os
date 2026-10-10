'use strict';

// Smart model routing, with a way to tell whether it is working.
//
// ExampleCo, 2026-08-16: "no delegation is not the answer. Implement the best rules
// you've got and sample 1 out of every 20 for the comparison, and the metric to
// show whether delegation is performing."
//
// The reason this never shipped is that we could not agree how to confirm
// delegation was safe, and the answer to that was to do nothing, which is
// strictly worse than routing on imperfect rules and measuring the result.
//
// Two halves. The routing rule decides the tier from BLAST RADIUS, not from how
// big the task looks. The sampler runs one in twenty tasks on both tiers so the
// rule is continuously checked against reality rather than trusted.

const crypto = require('node:crypto');

const TOP = 'top';
const CHEAP = 'cheap';

// One in twenty, per ExampleCo. Deterministic rather than random so a given task
// always makes the same choice, which keeps runs reproducible and means a
// sampled comparison can be re-derived after the fact.
const SAMPLE_EVERY = 20;
const DEFAULT_DELEGATION_INTENSITY = 30;
const MAX_DELEGATION_HELPERS = 3;
const DELEGATION_PACKET_FIELDS = Object.freeze([
  'objective',
  'scope',
  'evidence',
  'acceptance',
  'nonGoals',
  'stop',
]);
const RETAINED_OWNER_FLAGS = Object.freeze([
  'decomposition',
  'sharedStateMutation',
  'irreversible',
  'crossCuttingIntegration',
  'conflictResolution',
  'judgment',
  'finalProof',
]);

// The rules, in priority order. First match wins, and every one of them routes
// UP. Cheap is only what is left over, so a new unclassified task type fails
// safe to the expensive tier rather than silently getting downgraded.
const ESCALATION_RULES = Object.freeze([
  {
    id: 'owner-visible',
    when: (t) => t.ownerVisible === true,
    why: 'ExampleCo reads this output, and a wrong line costs his time, which is the expensive resource here',
  },
  {
    id: 'mutates-production',
    when: (t) => t.mutatesProduction === true,
    why: 'a bad edit reaches the running system, where the cost is an outage rather than a retry',
  },
  {
    id: 'irreversible',
    when: (t) => t.irreversible === true,
    why: 'a send, a post, a delete or a deploy cannot be taken back, so there is no cheap retry to fall back on',
  },
  {
    id: 'open-judgment',
    when: (t) => t.judgment === true,
    why: 'choosing an approach or naming a root cause has no verifiable answer to check against, so an error survives',
  },
]);

/**
 * Decide which tier a task should run on.
 *
 * @param {object} task
 *   ownerVisible       output reaches ExampleCo in any form
 *   mutatesProduction  changes the running system
 *   irreversible       cannot be undone (send, post, deploy, delete)
 *   judgment           open-ended decision with no checkable answer
 *   verifiable         has an objective pass/fail we can check afterwards
 * @returns {{tier:string, rule:string, why:string}}
 */
function routeTask(task = {}) {
  for (const rule of ESCALATION_RULES) {
    if (rule.when(task)) return { tier: TOP, rule: rule.id, why: rule.why };
  }
  return {
    tier: CHEAP,
    rule: 'mechanical-default',
    why: 'mechanical work with a checkable result: scans, counts, extraction, formatting. An error here surfaces immediately rather than reaching ExampleCo.',
  };
}

function clampDelegationIntensity(value = DEFAULT_DELEGATION_INTENSITY) {
  const parsed = Number(value);
  return Math.max(0, Math.min(100, Number.isFinite(parsed) ? Math.round(parsed) : DEFAULT_DELEGATION_INTENSITY));
}

function adjustDelegationIntensity(current, percentagePoints) {
  return clampDelegationIntensity(clampDelegationIntensity(current) + Number(percentagePoints || 0));
}

function helperModelFor(task = {}) {
  return task.mechanical === true || task.highVolume === true ? 'gpt-5.6-luna' : 'gpt-5.6-terra';
}

function delegationEligible(task = {}) {
  return !RETAINED_OWNER_FLAGS.some((flag) => task[flag] === true);
}

function packetIsComplete(packet = {}) {
  return DELEGATION_PACKET_FIELDS.every((field) => {
    const value = packet[field];
    return Array.isArray(value) ? value.length > 0 : Boolean(String(value || '').trim());
  });
}

function planDelegation(tasks = [], { intensity = DEFAULT_DELEGATION_INTENSITY } = {}) {
  const level = clampDelegationIntensity(intensity);
  const eligible = (Array.isArray(tasks) ? tasks : [])
    .map((task, index) => ({
      ...task,
      index,
      weight: Math.max(0, Number(task?.weight) || 0),
    }))
    .filter((task) => delegationEligible(task) && task.weight > 0 && packetIsComplete(task.packet));
  const totalEligibleWeight = eligible.reduce((sum, task) => sum + task.weight, 0);
  const targetWeight = (totalEligibleWeight * level) / 100;
  let best = [];
  let bestDistance = Math.abs(targetWeight);
  const consider = (rows) => {
    const weight = rows.reduce((sum, row) => sum + row.weight, 0);
    const distance = Math.abs(weight - targetWeight);
    if (
      distance < bestDistance ||
      (distance === bestDistance && weight <= targetWeight && rows.length < best.length)
    ) {
      best = rows;
      bestDistance = distance;
    }
  };
  for (let a = 0; a < eligible.length; a += 1) {
    consider([eligible[a]]);
    for (let b = a + 1; b < eligible.length; b += 1) {
      consider([eligible[a], eligible[b]]);
      for (let c = b + 1; c < eligible.length; c += 1) {
        consider([eligible[a], eligible[b], eligible[c]]);
      }
    }
  }
  const selected = best.map((task) => ({
    id: task.id || `task-${task.index + 1}`,
    weight: task.weight,
    model: helperModelFor(task),
    packet: task.packet,
  }));
  const delegatedWeight = selected.reduce((sum, task) => sum + task.weight, 0);
  return {
    intensity: level,
    ownerModel: 'gpt-5.6-sol',
    ownerReasoningEffort: 'xhigh',
    maxHelpers: MAX_DELEGATION_HELPERS,
    eligibleWeight: totalEligibleWeight,
    targetWeight,
    delegatedWeight,
    actualEligiblePercentage:
      totalEligibleWeight > 0 ? (delegatedWeight / totalEligibleWeight) * 100 : 0,
    selected,
  };
}

/**
 * One in twenty, decided from the task key so it is stable and reproducible.
 * Never sampled for a task already routed to the top tier: running the top tier
 * twice measures nothing and costs double.
 */
function shouldSampleForComparison(taskKey, routed, { sampleEvery = SAMPLE_EVERY } = {}) {
  if (!routed || routed.tier !== CHEAP) return false;
  const key = String(taskKey || '').trim();
  if (!key) return false;
  const digest = crypto.createHash('sha256').update(key).digest();
  return digest.readUInt32BE(0) % sampleEvery === 0;
}

/**
 * Score one comparison.
 *
 * The honest part. A comparison only counts toward the performance number when
 * there is an OBJECTIVE outcome to compare: a test that passes, a schema that
 * validates, a count that matches. Prose has no such outcome, so it is recorded
 * as pending adjudication rather than scored by guesswork. Blending a real
 * pass/fail with a vibe judgement would produce a number that looks like
 * evidence and is not.
 */
function scoreComparison({ cheapOutcome, topOutcome, verifiable } = {}) {
  if (!verifiable) return { scorable: false, agreed: null, reason: 'no-objective-outcome' };
  if (cheapOutcome === undefined || topOutcome === undefined) {
    return { scorable: false, agreed: null, reason: 'missing-outcome' };
  }
  const agreed = JSON.stringify(cheapOutcome) === JSON.stringify(topOutcome);
  return { scorable: true, agreed, reason: agreed ? 'match' : 'divergence' };
}

/**
 * The metric ExampleCo asked for: is delegation performing?
 *
 * Reports the agreement rate over scorable samples only, and refuses to report
 * a rate at all below a minimum sample count. A percentage computed from four
 * samples reads as evidence and is noise, and that false confidence is exactly
 * how a quiet accuracy drop would get waved through.
 */
function delegationPerformance(rows = [], { minSamples = 20 } = {}) {
  const scorable = rows.filter((r) => r && r.scorable === true);
  const pending = rows.filter((r) => r && r.scorable === false).length;
  const divergences = scorable.filter((r) => r.agreed === false);

  if (scorable.length < minSamples) {
    return {
      verdict: 'insufficient-evidence',
      scorableSamples: scorable.length,
      minSamples,
      pendingAdjudication: pending,
      agreementRate: null,
      divergences: divergences.length,
      // Rule of three: with zero observed failures in n trials, the true rate
      // sits below roughly 3/n. It is the only honest thing to say early on.
      ceilingIfClean: divergences.length === 0 && scorable.length > 0 ? 3 / scorable.length : null,
      detail: `only ${scorable.length} of ${rows.length} samples had an objective outcome to compare; ${minSamples} needed before a rate means anything`,
    };
  }

  const agreementRate = (scorable.length - divergences.length) / scorable.length;
  return {
    verdict: agreementRate >= 0.95 ? 'delegation-holding' : 'delegation-degraded',
    scorableSamples: scorable.length,
    minSamples,
    pendingAdjudication: pending,
    agreementRate,
    divergences: divergences.length,
    ceilingIfClean: divergences.length === 0 ? 3 / scorable.length : null,
    detail:
      divergences.length === 0
        ? `${scorable.length} sampled comparisons, no divergence; true divergence rate is under ${(300 / scorable.length).toFixed(1)}%`
        : `${divergences.length} of ${scorable.length} sampled comparisons diverged`,
  };
}

/**
 * Record what the router decided, without acting on it.
 *
 * Shadow mode. The rules run and the decision is logged, but the caller still
 * uses whatever tier it used before. This exists because the first night these
 * rules are live is a night the overnight briefing has to land at 05:30, and
 * changing which model the healers run on while guarding that run is the single
 * riskiest thing available. One night of shadow rows says how often the rules
 * would have downgraded anything, and the flip to enforcing is then a decision
 * with evidence rather than a hope.
 *
 * Fail-open in every branch. A cost experiment must never break a healer.
 */
function recordRoutingDecision(entry, { ledgerFile, fsApi = require('node:fs'), now } = {}) {
  if (!ledgerFile) return false;
  try {
    const row = {
      schema: 'amy.delegation_routing_decision.v1',
      ts: now || new Date().toISOString(),
      mode: 'shadow',
      ...entry,
    };
    fsApi.mkdirSync(require('node:path').dirname(ledgerFile), { recursive: true });
    fsApi.appendFileSync(ledgerFile, `${JSON.stringify(row)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  routeTask,
  shouldSampleForComparison,
  scoreComparison,
  delegationPerformance,
  recordRoutingDecision,
  ESCALATION_RULES,
  SAMPLE_EVERY,
  TOP,
  CHEAP,
  DEFAULT_DELEGATION_INTENSITY,
  MAX_DELEGATION_HELPERS,
  DELEGATION_PACKET_FIELDS,
  RETAINED_OWNER_FLAGS,
  clampDelegationIntensity,
  adjustDelegationIntensity,
  helperModelFor,
  delegationEligible,
  packetIsComplete,
  planDelegation,
};
