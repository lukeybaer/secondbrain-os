'use strict';

/**
 * model-router.js
 *
 * ONE decision point for "which model and which effort does this spawn get".
 * Before this module, model choice was an accident: the highest volume lanes
 * (heal-executor's Claude and Codex adapters) passed NO --model and NO effort
 * at all, so they silently inherited the most expensive default available to
 * the account, and on the desktop the Codex lane additionally inherited
 * `model = "gpt-5.6-sol"` plus `model_reasoning_effort = "xhigh"` from
 * ~/.codex/config.toml.
 *
 * COMPLEXITY DECIDES, NOT ORIGIN. The first cut of this router treated
 * `attended` as an exemption and returned unrouted, which left the single
 * highest volume surface (the agents an interactive Amy session spawns while
 * serving ExampleCo) on the expensive default. ExampleCo corrected that on 2026-08-24:
 * "not sure what you mean by attended work. If the prompt comes from me, you
 * can still delegate down to lower models by complexity."
 *
 * The second cut kept one attended-only carve-out: an attended retry could
 * escalate a tier without the unattended precondition that the evidence did not
 * move. That was the authoring agent's own judgment, not ExampleCo's instruction, and
 * it reintroduced exactly the origin-based special case he had just corrected.
 * It is gone. ORIGIN NOW CHANGES NOTHING: the base tier, the escalation rule and
 * its preconditions, the wall block, the Claude tight-budget cap, and the emitted
 * model/effort/reason are all byte-identical for the same signals on either
 * origin. `attended` is still accepted and still receipted so the ledger records
 * where a spawn came from, but no branch in routeModel() reads it.
 *
 * SCOPE. This router picks model and effort WITHIN a rung. It never reorders
 * rungs, never adds a rung, never touches the Bedrock switch, and only ever
 * names subscription models. The PAID API BLOOD GATE in
 * dev-plans/core/llm-fallback-ladder.md is untouched by construction: there is
 * no paid model id in this file and no code path here that can authorize one.
 *
 * CURRENT CODEX ROUTING (ExampleCo, corrected 2026-09-20): Luna/low for routine
 * work, Terra/low for bounded work, and Sol/high or xhigh for complex and
 * critical work. Astra and Fable are owner-denied unless ExampleCo explicitly
 * authorizes that named model in the current prompt. A generic review label,
 * retry, or old durable authorization is not explicit current authorization. This changes
 * no subscription rung order, admission, availability wall, or paid policy.
 *
 * HISTORICAL EFFORT LADDER, owner-set. ExampleCo, 2026-08-24, approving the smart-model-routing
 * proposal: "I approve the model routing proposal, but keep the effort tiers
 * higher so 0 is medium, 1 is high, 2 xhigh, 3 ultra." That instruction is the
 * authority for the ladder below and it deliberately raises effort above the
 * automation ceiling in scripts/lib/model-effort-policy.js. See the
 * RECONCILIATION note below for exactly what that opens and what bounds it.
 *
 * HONEST SUBSTITUTION, verified 2026-08-24 against the installed CLIs, not
 * assumed:
 *   - Codex CLI (v0.144.5): `ultra` is REAL. An end-to-end `codex exec -c
 *     model_reasoning_effort="ultra"` completed and returned a normal answer.
 *     A deliberately invalid control value ("zzz") was rejected, so the probe
 *     was not vacuous.
 *   - Claude CLI 2.1.92 documents `--effort <level>` as (low, medium, high,
 *     max). `xhigh` and `ultra` are both rejected before the prompt reaches the
 *     subscription model. Therefore tiers 2 and 3 on the CLAUDE lane use
 *     `max`, the highest real value on that lane. These are NAMED
 *     SUBSTITUTIONS, not silent ones: passing either unsupported owner-level
 *     name would take the whole heal session down before work began.
 *
 * RECONCILIATION with ladder invariant 13 ("Xhigh and ultra never become
 * unattended defaults"). ExampleCo's current explicit instruction controls, so
 * complex and critical CLI work may use the current owner effort ladder
 * unattended as well as attended.
 * What is NOT changed, and what bounds the exposure:
 *   - scripts/lib/model-effort-policy.js is untouched. The askAI ladder and the
 *     proxy's resolveAutomatedEffortRequest still refuse xhigh and ultra for
 *     automated phases. This router governs CLI spawn flags only; it is a
 *     different surface from the phase contract.
 *   - Subscription-only. Every model id here is a subscription model on an
 *     existing rung. No paid API path opens.
 *   - Per-card ceiling: MAX_PROCESS_CYCLES = 8 unattended
 *     (scripts/self-heal/briefing-repair-ledger.js), 24 only when supervised.
 *   - Per-session ceilings: heal-executor's own DEFAULT_BUDGET_MS (30 min),
 *     DEFAULT_HANG_MS, DEFAULT_IDLE_MS and the pre-integration output cap.
 *   - Tier 3 is not a default anywhere. It is reachable only by an explicit
 *     hard-decision task type, evidenced Codex critical complexity, or on
 *     Claude by ONE escalation step on unchanged evidence. Codex retries
 *     alone cannot reach critical effort, and a GENUINE-WALL never escalates. That
 *     is true on both origins: there is no attended shortcut to the top tier.
 *   - Every decision is receipted to the router ledger on a best-effort basis,
 *     so what each lane actually spent is auditable after the fact rather than
 *     inferred. recordRouterDecision() is deliberately non-throwing: a ledger
 *     write failure degrades the audit trail and does NOT block the decision,
 *     because losing a receipt must never kill the heal session it records.
 */

const fs = require('fs');
const path = require('path');
const {
  EFFORT_RANK,
  MODEL_RANK,
  OVERNIGHT_CEILING,
  OVERNIGHT_EFFORTS,
  OVERNIGHT_NEVER,
  explicitOnlyPattern,
  loadModelRoutingPolicy,
  modelRank,
  resolvedProfileTier,
  resolvedTier,
  runtimePolicyPath,
  withinOvernightCeiling,
} = require('./model-routing-config.js');
const { CLAUDE_PLAN_METER_FILE, claudePlanMeterStale } = require('./claude-plan-meter.js');

const SOURCE_ROUTING_POLICY = loadModelRoutingPolicy({ env: {} });

// OVERNIGHT PROFILE. ExampleCo, 2026-09-24: "default overnight model level is
// Claude Opus 5.5 medium and Codex GPT-5.6 Sol medium"; overnight work may
// delegate down for easy work, never up, and the final strategic report is
// locked to exactly that level. The profile rides the night marker the owner
// launchers already export (briefingModelCeilingApplies below), never a clock
// window: attended reruns, nights that run past 05:30 and daytime heal-the-
// healer all make the time of day an unreliable signal. Its tiers live in
// config profiles.overnight; its ceiling (OVERNIGHT_CEILING) lives in code.
const OVERNIGHT_PROFILE = 'overnight';
// Quota guard, down only. When either Claude plan window (weekly, or the
// five-hour window that cuts rungs off mid-night) reaches this percent, profile
// tier 2 steps down to Sonnet 4.6 at medium, and so does a retry escalated into
// tier 3 from a guarded tier, so escalation cannot climb back past the guard.
// Work classified tier 3 on its own (review, hard-decision) and the owner report
// lock never step down. The meter is trusted only when it is fresh under the
// shared six-hour rule (scripts/lib/claude-plan-meter.js); a stale or missing
// meter steps nothing down, and the router receipt says why.
const OVERNIGHT_QUOTA_STEP_DOWN_PERCENT = 85;
const OVERNIGHT_QUOTA_STEP_DOWN_ROUTE = Object.freeze({ model: 'claude-sonnet-4-6', effort: 'medium' });

const LANES = Object.freeze(['claude', 'codex']);
const BRIEFING_CODEX_CEILING = 'gpt-5.6-sol:medium';
// These named spawns carry the night marker at any hour, so they run the
// overnight profile (overnightProfileActive) by day as well: daytime
// heal-the-healer runs of heal-executor and agentic-healer-driver, and any
// daytime briefingContext Codex ask (briefing-ask-ai-codex). That is in scope:
// authorization row auth-briefing-sol-medium-ceiling (AMY_AUTHORIZATIONS.md,
// 2026-09-12) covers daytime heal-the-healer work and the overnight briefing
// work, and the profile only ever lowers a route to the owner overnight
// ceiling. A process that inherits SECONDBRAIN_BRIEFING_CODEX_CEILING from a
// night launcher (for example the EC2 spine worker's briefing env) is under the
// same profile for the same reason.
const BRIEFING_CEILING_SPAWNS = new Set([
  'agentic-healer-driver',
  'briefing-ask-ai-codex',
  'heal-executor',
  'overnight-watcher-launcher',
]);
// ExampleCo 2026-09-15 moved healers onto the brain switch; ExampleCo 2026-09-22
// extended that to every briefing ceiling call site; applyBriefingCodexCeiling clamps them.
// This set remains as the named healer lane for callers that report it.
const HEALER_BRAIN_SWITCH_SPAWNS = new Set(['agentic-healer-driver', 'heal-executor']);
const BRIEFING_CODEX_TIER_MODEL = Object.freeze({
  0: 'gpt-5.6-luna',
  1: 'gpt-5.6-terra',
  2: 'gpt-5.6-sol',
  3: 'gpt-5.6-sol',
});

// Both subscription lanes use real complexity ladders. Routine extraction and
// observation belong on Luna; bounded synthesis belongs on Terra; complex
// implementation and critical review stay on Sol. Astra and Fable are not
// automatic tiers. Changing only reasoning effort while pinning every task to
// a top model defeated delegation's cost purpose.
const TIER_MODEL = Object.freeze({
  0: Object.freeze({ claude: SOURCE_ROUTING_POLICY.tiers.claude[0].model, codex: SOURCE_ROUTING_POLICY.tiers.codex[0].model }),
  1: Object.freeze({ claude: SOURCE_ROUTING_POLICY.tiers.claude[1].model, codex: SOURCE_ROUTING_POLICY.tiers.codex[1].model }),
  2: Object.freeze({ claude: SOURCE_ROUTING_POLICY.tiers.claude[2].model, codex: SOURCE_ROUTING_POLICY.tiers.codex[2].model }),
  3: Object.freeze({ claude: SOURCE_ROUTING_POLICY.tiers.claude[3].model, codex: SOURCE_ROUTING_POLICY.tiers.codex[3].model }),
});

function assertOwnerExplicitModelAuthorization(decision, lane) {
  const pattern = explicitOnlyPattern(loadModelRoutingPolicy());
  if (!decision || !pattern.test(String(decision.model || ''))) return;
  if (decision.ownerExplicitModelAuthorization === true) return;
  throw new Error(
    `${lane} spawn refused: ${decision.model} requires ExampleCo's explicit authorization for that named model in the current prompt`,
  );
}

function assertModelEnabled(decision, lane) {
  const settings = loadModelRoutingPolicy().models?.[String(decision?.model || '')];
  if (!settings || settings.enabled !== false) return;
  if (settings.explicitCurrentPromptOnly && decision.ownerExplicitModelAuthorization === true) return;
  throw new Error(`${lane} spawn refused: ${decision.model} is disabled by the active model-routing policy`);
}

// Codex: routine low, complex high, evidenced critical xhigh.
// Claude retains its older owner ladder;
// its tiers 2 and 3 are named max substitutions for xhigh and ultra.
const TIER_EFFORT = Object.freeze({
  0: Object.freeze({ claude: SOURCE_ROUTING_POLICY.tiers.claude[0].effort, codex: SOURCE_ROUTING_POLICY.tiers.codex[0].effort }),
  1: Object.freeze({ claude: SOURCE_ROUTING_POLICY.tiers.claude[1].effort, codex: SOURCE_ROUTING_POLICY.tiers.codex[1].effort }),
  2: Object.freeze({ claude: SOURCE_ROUTING_POLICY.tiers.claude[2].effort, codex: SOURCE_ROUTING_POLICY.tiers.codex[2].effort }),
  3: Object.freeze({ claude: SOURCE_ROUTING_POLICY.tiers.claude[3].effort, codex: SOURCE_ROUTING_POLICY.tiers.codex[3].effort }),
});

// The effort values each installed CLI actually accepts. Claude was re-probed
// on 2026-08-26 after a live healer fallback rejected --effort xhigh.
const LANE_REAL_EFFORTS = Object.freeze({
  claude: Object.freeze(['low', 'medium', 'high', 'max']),
  codex: Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']),
});

const TIER_REQUESTED_EFFORT = Object.freeze({
  0: SOURCE_ROUTING_POLICY.tiers.claude[0].requestedEffort,
  1: SOURCE_ROUTING_POLICY.tiers.claude[1].requestedEffort,
  2: SOURCE_ROUTING_POLICY.tiers.claude[2].requestedEffort,
  3: SOURCE_ROUTING_POLICY.tiers.claude[3].requestedEffort,
});

// The requested owner name for tier 3, retained as a public compatibility
// constant for callers and tests.
const TIER3_REQUESTED_EFFORT = 'ultra';

const TASK_TIER = Object.freeze({
  observe: 0,
  extract: 0,
  'extract-summarize': 1,
  synthesize: 1,
  'repair-code': 2,
  review: 3,
  'hard-decision': 3,
});

// A launch site (the overnight watcher, a card-repair session) often knows
// only WHAT KIND of work a spawn is doing, not this module's TASK_TIER
// vocabulary. LAUNCH_CLASS_TASK_TYPE is the one translation table from the
// owner's own words (2026-09-03: "bounded observation, unchanged-evidence
// assessment, targeted refresh, source refresh, single-card retry with an
// unchanged hypothesis" are routine; "new hypothesis after a failed attempt,
// cross-card integration, ambiguous diagnosis, final report synthesis" are
// hard) onto the EXISTING TASK_TIER classes above. It adds no tier, no model,
// and no effort of its own; classifyLaunchTaskType() only picks which
// existing class applies, and routeModel()/TASK_TIER still make every model
// and effort decision.
const LAUNCH_CLASS_TASK_TYPE = Object.freeze({
  'bounded-observation': 'observe',
  'unchanged-evidence-assessment': 'observe',
  'targeted-refresh': 'extract',
  'source-refresh': 'extract',
  'single-card-retry-unchanged-hypothesis': 'extract-summarize',
  'new-hypothesis-after-failed-attempt': 'repair-code',
  'cross-card-integration': 'hard-decision',
  'ambiguous-diagnosis': 'hard-decision',
  'final-report-synthesis': 'review',
});

// A routine launch class must never resolve to a hard tier by falling
// through to normalizeTaskType('')'s own 'repair-code' default. A missing or
// unrecognized launchClass fails closed to 'observe', the cheapest class,
// never upward by inheritance.
function classifyLaunchTaskType(signals = {}) {
  const key = String((signals && signals.launchClass) || '').trim();
  return Object.hasOwn(LAUNCH_CLASS_TASK_TYPE, key) ? LAUNCH_CLASS_TASK_TYPE[key] : 'observe';
}

// Reporting-only label: task tiers 0-1 are routine, tiers 2-3 are hard.
// The decision reason additionally records any explicit Codex complexity.
function launchClassLabel(taskType) {
  return TASK_TIER[normalizeTaskType(taskType)] <= 1 ? 'routine' : 'hard';
}

// UI contract: these strings are the executable classifier written as source,
// not an English compression of it. Token Explorer renders them byte-for-byte
// so ExampleCo can audit the exact condition that selected a tier, model, and effort.
const VERBATIM_ROUTING_RULES = Object.freeze([
  Object.freeze({ id: 'task.default', source: "if (!value) return 'repair-code';" }),
  Object.freeze({
    id: 'task.unknown',
    source:
      'if (!Object.hasOwn(TASK_TIER, value))\n    throw new Error(`unknown model-router task type: ${taskType}`);',
  }),
  Object.freeze({ id: 'task.observe', source: 'observe: 0,' }),
  Object.freeze({ id: 'task.extract', source: 'extract: 0,' }),
  Object.freeze({ id: 'task.extract-summarize', source: "'extract-summarize': 1," }),
  Object.freeze({ id: 'task.synthesize', source: 'synthesize: 1,' }),
  Object.freeze({ id: 'task.repair-code', source: "'repair-code': 2," }),
  Object.freeze({ id: 'task.review', source: 'review: 3,' }),
  Object.freeze({ id: 'task.hard-decision', source: "'hard-decision': 3," }),
  Object.freeze({
    id: 'task.codex-review',
    source: "let tier = lane === 'codex' && taskType === 'review' ? 2 : TASK_TIER[taskType];",
  }),
  Object.freeze({
    id: 'task.codex-default',
    source: "lane === 'codex' && !signals.taskType ? 'observe' : signals.taskType,",
  }),
  Object.freeze({
    id: 'complexity.evidence',
    source: "complexity === 'routine' ||\n      (['bounded', 'complex', 'critical'].includes(complexity) && evidence)",
  }),
  Object.freeze({
    id: 'complexity.tier',
    source:
      "tier =\n        complexity === 'routine'\n          ? 0\n          : complexity === 'bounded'\n            ? 1\n            : complexity === 'complex'\n              ? 2\n              : 3;",
  }),
  Object.freeze({
    id: 'model.tier-0',
    source: '0: Object.freeze({ claude: SOURCE_ROUTING_POLICY.tiers.claude[0].model, codex: SOURCE_ROUTING_POLICY.tiers.codex[0].model }),',
  }),
  Object.freeze({
    id: 'model.tier-1',
    source: '1: Object.freeze({ claude: SOURCE_ROUTING_POLICY.tiers.claude[1].model, codex: SOURCE_ROUTING_POLICY.tiers.codex[1].model }),',
  }),
  Object.freeze({
    id: 'model.tier-2',
    source: '2: Object.freeze({ claude: SOURCE_ROUTING_POLICY.tiers.claude[2].model, codex: SOURCE_ROUTING_POLICY.tiers.codex[2].model }),',
  }),
  Object.freeze({
    id: 'model.tier-3',
    source: '3: Object.freeze({ claude: SOURCE_ROUTING_POLICY.tiers.claude[3].model, codex: SOURCE_ROUTING_POLICY.tiers.codex[3].model }),',
  }),
  Object.freeze({
    id: 'effort.tier-0',
    source: '0: Object.freeze({ claude: SOURCE_ROUTING_POLICY.tiers.claude[0].effort, codex: SOURCE_ROUTING_POLICY.tiers.codex[0].effort }),',
  }),
  Object.freeze({
    id: 'effort.tier-1',
    source: '1: Object.freeze({ claude: SOURCE_ROUTING_POLICY.tiers.claude[1].effort, codex: SOURCE_ROUTING_POLICY.tiers.codex[1].effort }),',
  }),
  Object.freeze({
    id: 'effort.tier-2',
    source: '2: Object.freeze({ claude: SOURCE_ROUTING_POLICY.tiers.claude[2].effort, codex: SOURCE_ROUTING_POLICY.tiers.codex[2].effort }),',
  }),
  Object.freeze({
    id: 'effort.tier-3',
    source: '3: Object.freeze({ claude: SOURCE_ROUTING_POLICY.tiers.claude[3].effort, codex: SOURCE_ROUTING_POLICY.tiers.codex[3].effort }),',
  }),
  Object.freeze({
    id: 'escalation',
    source:
      "const escalates = retryCount > 0 && wall !== 'GENUINE-WALL' && signals.evidenceUnchanged === true;",
  }),
  Object.freeze({
    id: 'escalation.step',
    source: "const escalated = Math.min(lane === 'codex' && tier < 3 ? 2 : MAX_TIER, tier + 1);",
  }),
  Object.freeze({
    id: 'genuine-wall',
    source: "} else if (retryCount > 0 && wall === 'GENUINE-WALL') {",
  }),
  Object.freeze({
    id: 'tight-budget',
    source:
      "if (lane === 'claude' && Number.isFinite(budgetMs) && budgetMs > 0 && budgetMs < TIGHT_BUDGET_MS && tier > 1) {",
  }),
  Object.freeze({ id: 'tight-budget-cap', source: 'tier = 1;' }),
  Object.freeze({ id: 'selection.model', source: 'const model = tierRoute.model;' }),
  Object.freeze({ id: 'selection.effort', source: 'const effort = tierRoute.effort;' }),
  Object.freeze({
    id: 'selection.requested-effort',
    source: "const requestedEffort = lane === 'codex' ? effort : (tierRoute.requestedEffort || effort);",
  }),
  Object.freeze({
    id: 'selection.substitution',
    source: 'const effortSubstituted = requestedEffort !== effort;',
  }),
  Object.freeze({
    id: 'selection.validity',
    source: 'if (!LANE_REAL_EFFORTS[lane].includes(effort)) {',
  }),
  Object.freeze({
    id: 'owner.video-route',
    source: "const OWNER_VIDEO_CLAUDE_ROUTE = Object.freeze({ model: 'claude-opus-5-5', effort: 'medium' });",
  }),
  Object.freeze({
    id: 'owner.video-codex-route',
    source: "const OWNER_VIDEO_CODEX_ROUTE = Object.freeze({ model: 'gpt-5.6-sol', effort: 'medium' });",
  }),
  Object.freeze({
    id: 'owner.video-spawns',
    source: "if (!['claude', 'codex'].includes(lane) || !isOwnerVideoSpawn(spawn, signals)) return decision;",
  }),
  Object.freeze({
    id: 'owner.report-route',
    source: "const OWNER_REPORT_CLAUDE_ROUTE = Object.freeze({ model: 'claude-opus-5-5', effort: 'medium' });",
  }),
  Object.freeze({
    id: 'owner.report-codex-lock',
    source: 'const OWNER_REPORT_CODEX_ROUTE = OVERNIGHT_CEILING.codex;',
  }),
  Object.freeze({
    id: 'overnight.ceiling-claude',
    source: "claude: Object.freeze({ model: 'claude-opus-5-5', effort: 'medium' }),",
  }),
  Object.freeze({
    id: 'overnight.ceiling-codex',
    source: "codex: Object.freeze({ model: 'gpt-5.6-sol', effort: 'medium' }),",
  }),
  Object.freeze({
    id: 'overnight.switch',
    source: 'return briefingModelCeilingApplies(spawn, env);',
  }),
  Object.freeze({
    id: 'overnight.tier-table',
    source: 'const tierTable = profile ? livePolicy.profiles?.[profile]?.tiers : livePolicy.tiers;',
  }),
  Object.freeze({
    id: 'overnight.quota-step-down',
    source: 'const OVERNIGHT_QUOTA_STEP_DOWN_PERCENT = 85;',
  }),
  Object.freeze({
    id: 'overnight.quota-step-down-route',
    source: "const OVERNIGHT_QUOTA_STEP_DOWN_ROUTE = Object.freeze({ model: 'claude-sonnet-4-6', effort: 'medium' });",
  }),
  Object.freeze({
    id: 'overnight.quota-guard-tiers',
    source: 'const guardedTier = tier === 2 || (tier === MAX_TIER && classifiedTier < MAX_TIER);',
  }),
  Object.freeze({
    id: 'overnight.quota-meter-fresh',
    source: 'return !Number.isFinite(generatedAtMs) || nowMs - generatedAtMs > CLAUDE_PLAN_METER_MAX_AGE_MS;',
  }),
  Object.freeze({
    id: 'overnight.phase-tier',
    source: "'strategic-synthesis': 2,",
  }),
  Object.freeze({
    id: 'overnight.phase-tier-tight-budget',
    source: 'const tightBudget = Number.isFinite(budget) && budget > 0 && budget < TIGHT_BUDGET_MS && phaseTier > 1;',
  }),
]);

const MAX_TIER = 3;
// Claude's existing tight-budget cap. Codex effort follows complexity;
// caller admission and time watchdogs own its remaining execution window.
const TIGHT_BUDGET_MS = 5 * 60 * 1000;

const SHADOW_LEDGER = path.resolve(
  __dirname,
  '..',
  '..',
  'data',
  'agent',
  'model-router-shadow.jsonl',
);

function normalizeLane(lane) {
  const value = String(lane || '')
    .trim()
    .toLowerCase();
  if (!LANES.includes(value)) throw new Error(`unknown model-router lane: ${lane}`);
  return value;
}

function normalizeTaskType(taskType) {
  const value = String(taskType || '')
    .trim()
    .toLowerCase();
  if (!value) return 'repair-code';
  if (!Object.hasOwn(TASK_TIER, value))
    throw new Error(`unknown model-router task type: ${taskType}`);
  return value;
}

function quotaPercent(value) {
  return value === null || value === undefined || value === '' ? NaN : Number(value);
}

// The down-only overnight quota guard. Pure: the caller reads the meter
// (overnightProfileSignals) and passes its percentages and any staleness note.
// It applies to Claude profile tier 2 and to a tier 3 reached only by
// escalating from a lower tier; work classified tier 3 keeps the ceiling.
function overnightQuotaGuard({ lane, tier, classifiedTier = tier, route, signals = {}, policy }) {
  const guardedTier = tier === 2 || (tier === MAX_TIER && classifiedTier < MAX_TIER);
  if (lane !== 'claude' || !guardedTier) return { route, stepDown: false, reasons: [] };
  const reasons = signals.claudeMeterNote ? [String(signals.claudeMeterNote)] : [];
  const weekly = quotaPercent(signals.claudeWeeklyPercent);
  const fiveHour = quotaPercent(signals.claudeFiveHourPercent);
  const trip = Number.isFinite(weekly) && weekly >= OVERNIGHT_QUOTA_STEP_DOWN_PERCENT
    ? `claude weekly plan ${weekly}%`
    : Number.isFinite(fiveHour) && fiveHour >= OVERNIGHT_QUOTA_STEP_DOWN_PERCENT
      ? `claude five-hour window ${fiveHour}%`
      : null;
  const stepDown =
    Boolean(trip) &&
    policy.models[OVERNIGHT_QUOTA_STEP_DOWN_ROUTE.model]?.enabled !== false &&
    modelRank('claude', OVERNIGHT_QUOTA_STEP_DOWN_ROUTE.model) < modelRank('claude', route.model);
  if (!stepDown) return { route, stepDown: false, reasons };
  reasons.push(
    `${trip} at or above ${OVERNIGHT_QUOTA_STEP_DOWN_PERCENT}%: ` +
    `tier ${tier}${tier !== classifiedTier ? ` (escalated from tier ${classifiedTier})` : ''} steps down from ` +
    `${route.model}/${route.effort} to ` +
    `${OVERNIGHT_QUOTA_STEP_DOWN_ROUTE.model}/${OVERNIGHT_QUOTA_STEP_DOWN_ROUTE.effort}`,
  );
  return { route: OVERNIGHT_QUOTA_STEP_DOWN_ROUTE, stepDown: true, reasons };
}

/**
 * Pure. No I/O, no env reads, no clock. Same signals in, same decision out.
 *
 * @param {object} signals
 * @param {string} signals.lane            'claude' | 'codex'
 * @param {boolean} signals.attended       true = ExampleCo is driving. ACCEPTED AND
 *                                         RECEIPTED ONLY. It does not reach any
 *                                         branch below: the decision is
 *                                         identical on either origin.
 * @param {string} signals.taskType        observe | extract | extract-summarize |
 *                                         synthesize | repair-code | review |
 *                                         hard-decision
 * @param {string} signals.complexity      Codex per-work-unit routine | complex | critical
 * @param {string} signals.complexityReason Evidence required for complex/critical override
 * @param {number} signals.retryCount      attempts already spent on this work unit
 * @param {boolean} signals.evidenceUnchanged  stable+dynamic hashes unchanged
 * @param {string} signals.wall            'GENUINE-WALL' blocks escalation
 * @param {number} signals.budgetMs        wall clock this spawn actually has
 * @param {string} signals.profile         'overnight' reads profiles.overnight tiers;
 *                                         decideSpawnModel() sets it from the night marker
 * @param {number} signals.claudeWeeklyPercent  Claude weekly plan meter; drives the
 *                                         down-only overnight quota guard
 * @param {number} signals.claudeFiveHourPercent Claude five-hour window meter; same guard
 * @param {string} signals.claudeMeterNote  why the meter was not trusted (stale,
 *                                         missing); receipted, never a step-down
 * @returns {{routed:boolean, lane:string, tier:(number|null), model:(string|null),
 *            effort:(string|null), requestedEffort:(string|null),
 *            effortSubstituted:boolean, reason:string}}
 */
function routeModel(signals = {}) {
  const lane = normalizeLane(signals.lane);

  // `signals.attended` is DELIBERATELY NOT READ HERE. ExampleCo's rule is that
  // complexity decides the model and origin does not, so an attended prompt gets
  // the same tier, the same escalation preconditions, the same wall block, the
  // same lane-specific budget behavior, and the same reason string as an unattended one. The field
  // stays in the signals object because the caller receipts it, which is how the
  // shadow ledger can still answer "where did this spawn come from" without
  // origin ever reaching a branch.

  const taskType = normalizeTaskType(
    lane === 'codex' && !signals.taskType ? 'observe' : signals.taskType,
  );
  let tier = lane === 'codex' && taskType === 'review' ? 2 : TASK_TIER[taskType];
  const reasons = [`task=${taskType} base tier ${tier}`];

  // Only current work-unit evidence can override the task classification.
  // Neither a session's previous effort nor its origin is a complexity signal.
  if (lane === 'codex' && signals.complexity) {
    const complexity = String(signals.complexity).trim().toLowerCase();
    const evidence =
      typeof signals.complexityReason === 'string' ? signals.complexityReason.trim() : '';
    if (
      complexity === 'routine' ||
      (['bounded', 'complex', 'critical'].includes(complexity) && evidence)
    ) {
      tier =
        complexity === 'routine'
          ? 0
          : complexity === 'bounded'
            ? 1
            : complexity === 'complex'
              ? 2
              : 3;
      reasons.push(`complexity=${complexity}${evidence ? `: ${evidence}` : ''}`);
    } else {
      reasons.push(
        'complexity override ignored: expected routine or bounded/complex/critical with complexityReason evidence',
      );
    }
  }

  // Escalation: exactly one tier, only on a retry whose evidence did not move.
  // Changed evidence means the next attempt is a different problem, so it is
  // not an escalation, it is a fresh first attempt. This precondition is
  // unconditional. An earlier cut waived it for attended work on the theory that
  // a waiting human makes patience the scarce resource; that was an origin-based
  // special case invented by the authoring agent, and it is removed.
  const classifiedTier = tier;
  const retryCount = Math.max(0, Number(signals.retryCount) || 0);
  const wall = String(signals.wall || '')
    .trim()
    .toUpperCase();
  const escalates = retryCount > 0 && wall !== 'GENUINE-WALL' && signals.evidenceUnchanged === true;
  if (escalates) {
    const escalated = Math.min(lane === 'codex' && tier < 3 ? 2 : MAX_TIER, tier + 1);
    const trigger = `retry ${retryCount} on unchanged evidence`;
    if (escalated !== tier) {
      reasons.push(`${trigger}: escalate to tier ${escalated}`);
      tier = escalated;
    } else {
      reasons.push(
        `${trigger}: ${lane === 'codex' && tier === 2 ? 'critical evidence required for tier 3' : 'already at max tier'}`,
      );
    }
  } else if (retryCount > 0 && wall === 'GENUINE-WALL') {
    reasons.push('genuine wall: no model escalation, a stronger model hits the same wall');
  }

  // Preserve Claude's budget cap. A short window does not change Codex complexity.
  const budgetMs = Number(signals.budgetMs);
  if (lane === 'claude' && Number.isFinite(budgetMs) && budgetMs > 0 && budgetMs < TIGHT_BUDGET_MS && tier > 1) {
    reasons.push(`budget ${budgetMs}ms under ${TIGHT_BUDGET_MS}ms: cap at tier 1`);
    tier = 1;
  }

  const livePolicy = loadModelRoutingPolicy();
  // The overnight profile swaps only the tier table. Classification,
  // escalation, the wall block and the budget cap above are unchanged.
  const profile = signals.profile === OVERNIGHT_PROFILE ? OVERNIGHT_PROFILE : null;
  const tierTable = profile ? livePolicy.profiles?.[profile]?.tiers : livePolicy.tiers;
  if (!tierTable) throw new Error(`model routing policy has no ${profile} profile`);
  if (profile) reasons.push(`${profile} profile tier ${tier}`);
  const requestedTierRoute = tierTable[lane][tier];
  let tierRoute = profile ? resolvedProfileTier(livePolicy, lane, tier, profile) : resolvedTier(livePolicy, lane, tier);
  if (tierRoute.model !== requestedTierRoute.model || tierRoute.effort !== requestedTierRoute.effort) {
    reasons.push(
      `configured ${lane} tier ${tier} route ${requestedTierRoute.model}/${requestedTierRoute.effort} is disabled; ` +
      `fell to enabled route ${tierRoute.model}/${tierRoute.effort}`,
    );
  }
  let quotaStepDown = false;
  if (profile) {
    const guarded = overnightQuotaGuard({ lane, tier, classifiedTier, route: tierRoute, signals, policy: livePolicy });
    reasons.push(...guarded.reasons);
    tierRoute = guarded.route;
    quotaStepDown = guarded.stepDown;
  }
  const model = tierRoute.model;
  const effort = tierRoute.effort;
  const requestedEffort = lane === 'codex' ? effort : (tierRoute.requestedEffort || effort);
  const effortSubstituted = requestedEffort !== effort;
  if (effortSubstituted) {
    reasons.push(
      `${requestedEffort} is not a real effort value on the ${lane} CLI; substituting ${effort}, the highest real value on that lane`,
    );
  }

  // Belt and braces: never emit an effort the CLI would reject at runtime.
  if (!LANE_REAL_EFFORTS[lane].includes(effort)) {
    throw new Error(`model-router produced an unreal effort for ${lane}: ${effort}`);
  }

  return {
    routed: true,
    lane,
    tier,
    model,
    effort,
    requestedEffort,
    effortSubstituted,
    ...(profile ? { profile } : {}),
    ...(quotaStepDown ? { quotaStepDown: true } : {}),
    reason: reasons.join('; '),
  };
}

/**
 * ROUTING IS LIVE BY DEFAULT. Gate 0 was a shadow default: absent the env var,
 * the router receipted a decision and changed nothing. That gate was completed
 * and it is now closed, because a default-off switch turned out to be a silent
 * leak rather than a safety net.
 *
 * WHY THIS FLIPPED, measured 2026-08-24 rather than assumed. ExampleCo ordered smart
 * model routing live with no shadow mode, and the switch was set in the two
 * places someone remembered: the ec2-user crontab and the amy-briefing-control
 * systemd drop-in. Those cover exactly one of the three ways these six call
 * sites are actually launched. The other two were still shadow:
 *   - PM2. `scripts/ec2-spine-worker.js` runs under PM2, whose daemon was
 *     started from a login shell that predates the switch. Read straight off
 *     the running process: /proc/<pid>/environ carried 166 variables and
 *     SECONDBRAIN_MODEL_ROUTER was not one of them. A crontab assignment is
 *     read by cron, not by an already-resident PM2 daemon.
 *   - The desktop. `desktop-capability-worker.js`, `codex-run.js`,
 *     `dispatch-feedback-to-claude.js` (spawned by the Electron IPC handler)
 *     and `claude-peer-review.js` all run on ExampleCo's PC, where the variable was
 *     absent at Process, User and Machine scope alike.
 * So the highest volume surfaces were still inheriting the unpinned account
 * default and, on the Codex lane, ~/.codex/config.toml's sol/xhigh, which is
 * the exact leak this module exists to close.
 *
 * An env var that must be remembered in every launcher is the weakest rung of
 * the prevention hierarchy. Making live the default fixes every launcher at
 * once, including ones added later by someone who never reads this file.
 * `SECONDBRAIN_MODEL_ROUTER=shadow` is still honored as an explicit opt-out so
 * the decision stays reversible and testable, and the existing crontab and
 * systemd `=live` assignments remain correct and harmless.
 *
 * SAFE BY CONSTRUCTION, not by trust: every model id reachable here is a
 * subscription model, every effort is verified real for its lane, and
 * scripts/__tests__/spawn-model-routing.test.js walks the full cross product to
 * prove no reachable decision can name a paid model. The PAID API BLOOD GATE is
 * untouched.
 */
function routerMode(env = process.env) {
  const raw = String((env && env.SECONDBRAIN_MODEL_ROUTER) || '')
    .trim()
    .toLowerCase();
  return raw === 'shadow' ? 'shadow' : 'live';
}

function isRouterLive(env = process.env) {
  return routerMode(env) === 'live';
}

function briefingModelCeilingApplies(spawn, env = process.env) {
  const inherited = String((env && env.SECONDBRAIN_BRIEFING_CODEX_CEILING) || '')
    .trim()
    .toLowerCase();
  return BRIEFING_CEILING_SPAWNS.has(String(spawn || '')) || inherited === BRIEFING_CODEX_CEILING;
}

function briefingCodexCeilingApplies(spawn, lane, env = process.env) {
  return lane === 'codex' && briefingModelCeilingApplies(spawn, env);
}

// The one switch for the overnight profile: the night marker. A named ceiling
// spawn, or any process that inherited SECONDBRAIN_BRIEFING_CODEX_CEILING from a
// night launcher, runs under the profile.
function overnightProfileActive(spawn, env = process.env) {
  return briefingModelCeilingApplies(spawn, env);
}

// Down only for a tierless literal: the strongest enabled model ranked at or
// below both the literal and the ceiling, at the literal's effort when that is
// an overnight effort, else the ceiling effort. A disabled claude-sonnet-5 pin
// becomes claude-sonnet-4-6, never the more expensive ceiling. Null when the
// literal has no rank (Fable, Astra, an unknown id) or nothing qualifies; the
// caller then uses the ceiling, which is still below any such model.
function nearestEnabledAtOrBelow(lane, model, effort, policy) {
  const rank = modelRank(lane, model);
  if (rank === null || OVERNIGHT_NEVER.test(String(model || ''))) return null;
  const limit = Math.min(rank, modelRank(lane, OVERNIGHT_CEILING[lane].model));
  const candidate = Object.entries(MODEL_RANK[lane] || {})
    .filter(([id, idRank]) => idRank <= limit && policy.models?.[id] && policy.models[id].enabled !== false && !OVERNIGHT_NEVER.test(id))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  if (!candidate) return null;
  const keepEffort = OVERNIGHT_EFFORTS[lane].includes(String(effort || ''));
  return { model: candidate[0], effort: keepEffort ? effort : OVERNIGHT_CEILING[lane].effort };
}

// Clamp a decision DOWN to the owner overnight ceiling, never refuse it (ExampleCo
// 2026-09-22: briefing work never refuses a model). A decision already at or
// under the ceiling passes with the ceiling receipted. A model under the
// ceiling keeps its model and has only its effort capped at medium. A model
// above the ceiling, unranked, disabled, Astra or Fable, or missing, takes the
// profile's own route for its tier, or the ceiling itself when no tier is
// known. Every clamp names what it replaced in the reason and in clampedFrom.
function clampToOvernightCeiling(lane, decision, policy = loadModelRoutingPolicy()) {
  const ceiling = OVERNIGHT_CEILING[lane];
  const ceilingLabel = `${ceiling.model}/${ceiling.effort}`;
  if (!decision) {
    return {
      lane,
      tier: null,
      routed: true,
      model: ceiling.model,
      effort: ceiling.effort,
      requestedEffort: ceiling.effort,
      effortSubstituted: false,
      profile: OVERNIGHT_PROFILE,
      overnightClamped: true,
      ownerCeiling: ceilingLabel,
      reason: `router unavailable; owner overnight ceiling ${ceilingLabel} (ExampleCo 2026-09-24)`,
    };
  }
  if (decision.denied) return decision;
  const { model, effort } = decision;
  if (withinOvernightCeiling(lane, model, effort, policy)) {
    return {
      ...decision,
      routed: true,
      ownerCeiling: ceilingLabel,
      reason: `${decision.reason || 'decision'}; owner overnight ceiling ${ceilingLabel}`,
    };
  }
  const tier = Number.isInteger(decision.tier) && decision.tier >= 0 && decision.tier <= MAX_TIER ? decision.tier : null;
  const target = withinOvernightCeiling(lane, model, ceiling.effort, policy)
    ? { model, effort: ceiling.effort }
    : tier === null
      ? nearestEnabledAtOrBelow(lane, model, effort, policy) || ceiling
      : resolvedProfileTier(policy, lane, tier);
  const clampedFrom = `${model || '(missing model)'}/${effort || '(missing effort)'}`;
  const clamped = {
    ...decision,
    lane,
    routed: true,
    model: target.model,
    effort: target.effort,
    requestedEffort: decision.requestedEffort || effort || target.effort,
    effortSubstituted: Boolean(decision.effortSubstituted) || target.effort !== effort,
    overnightClamped: true,
    clampedFrom,
    ownerCeiling: ceilingLabel,
    reason:
      `${decision.reason || 'decision'}; owner overnight ceiling ${ceilingLabel}: ` +
      `${clampedFrom} clamped to ${target.model}/${target.effort}`,
  };
  if (target.model !== model) delete clamped.ownerExplicitModelAuthorization;
  return clamped;
}

function applyBriefingCodexCeiling(spawn, lane, decision, env = process.env) {
  const ceilingApplies = briefingModelCeilingApplies(spawn, env);
  // ExampleCo 2026-09-22: briefing work never refuses a model. ExampleCo 2026-09-24:
  // overnight Claude runs at most Opus 5.5 at medium. Every Claude lane under
  // the night marker is clamped down to that ceiling with a receipt; an
  // out-of-ceiling or missing decision is clamped, never denied and never
  // honored above the ceiling.
  if (ceilingApplies && lane === 'claude') {
    return clampToOvernightCeiling('claude', decision, loadModelRoutingPolicy({ env }));
  }
  if (ceilingApplies && lane !== 'codex') {
    return {
      lane,
      denied: true,
      routed: true,
      reason: `owner briefing ceiling=${BRIEFING_CODEX_CEILING}; Claude and paid API lanes are forbidden`,
      ownerCeiling: BRIEFING_CODEX_CEILING,
    };
  }
  if (!briefingCodexCeilingApplies(spawn, lane, env)) return decision;
  const source = decision || {
    lane: 'codex',
    tier: 2,
    requestedTier: 2,
    routed: true,
    reason: 'router unavailable; fail closed to owner briefing ceiling',
  };
  const livePolicy = loadModelRoutingPolicy({ env });
  const permittedModels = new Set(['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol']
    .filter((model) => livePolicy.models[model]?.enabled !== false));
  const permittedEfforts = new Set(['minimal', 'low', 'medium']);
  const routedTierModel = resolvedTier(livePolicy, 'codex', source.tier).model;
  const staticTierModel = BRIEFING_CODEX_TIER_MODEL[source.tier] || 'gpt-5.6-sol';
  const ceilingOrder = ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol'];
  const staticIndex = Math.max(0, ceilingOrder.indexOf(staticTierModel));
  const safeFallback = ceilingOrder.slice(0, staticIndex + 1).reverse().find((modelId) => permittedModels.has(modelId));
  const tierModel = permittedModels.has(routedTierModel) ? routedTierModel : safeFallback;
  if (!tierModel) {
    return {
      ...source,
      denied: true,
      routed: true,
      reason: `${source.reason}; owner briefing ceiling has no enabled Codex model`,
      ownerCeiling: BRIEFING_CODEX_CEILING,
    };
  }
  const model = permittedModels.has(source.model) ? source.model : tierModel;
  const effort = permittedEfforts.has(source.effort) ? source.effort : 'medium';
  const requestedEffort = source.requestedEffort || source.effort || effort;
  return {
    ...source,
    model,
    effort,
    requestedEffort,
    effortSubstituted: source.effortSubstituted || effort !== source.effort,
    routed: true,
    reason: `${source.reason}; owner briefing ceiling=${BRIEFING_CODEX_CEILING}`,
    ownerCeiling: BRIEFING_CODEX_CEILING,
  };
}

// OWNER VIDEO ROUTE. ExampleCo, 2026-09-23: "upgrade default model to Opus 5.5
// medium for the video processing. I.e. if I trigger those videos through the
// UI use that model to do it." Every Claude-lane spawn that revises or
// produces a video ExampleCo triggered runs this exact model and effort, whatever
// tier the task type would otherwise pick. Codex owner-video work is likewise
// pinned to gpt-5.6-sol/medium. By
// day no other spawn reaches this model: the base policy tiers never name it
// and only the spawns below, or a caller that marks its signals ownerVideoWork
// (the desktop dispatcher for a video rejection), take this branch. Overnight
// it is also the profile ceiling (OVERNIGHT_CEILING.claude), so this route
// sits exactly at the ceiling and the clamp leaves it there.
const OWNER_VIDEO_CLAUDE_ROUTE = Object.freeze({ model: 'claude-opus-5-5', effort: 'medium' });
const OWNER_VIDEO_CODEX_ROUTE = Object.freeze({ model: 'gpt-5.6-sol', effort: 'medium' });
const OWNER_VIDEO_CLAUDE_SPAWNS = new Set(['video-regen-task-runner']);

// OWNER REPORT ROUTE. ExampleCo, 2026-09-24, on the overnight strategic report:
// "can that report always use opus 5.5 medium?" Before this the report's
// Claude rung was unpinned, so claudeCeilingPins picked the configurable
// automatic ceiling (Sonnet 4.6) and the caller passed effort low; the
// 2026-09-24 report was written by claude-sonnet-4-6/low. The report writer
// pins its askAI Claude rung to this route and asks askAI to lead with Claude
// (OWNER_LEAD_SURFACES in ask-ai.js); Codex stays the fallback rung. By day
// no base policy tier names this model; overnight the profile's top tiers do,
// because it is the owner overnight ceiling.
const OWNER_REPORT_CLAUDE_ROUTE = Object.freeze({ model: 'claude-opus-5-5', effort: 'medium' });

// OWNER REPORT LOCK. ExampleCo, 2026-09-24: the final strategic report is locked to
// exactly the overnight ceiling on both brains. Before this the Codex fallback
// rung routed strategic-synthesis as extract-summarize and ran gpt-5.6-terra
// at low. A caller that names this lock gets the exact pair below: no tier
// lookup, no enabled-state fallthrough, no quota step-down, never a lower
// substitute. If both locked rungs fail, the report's deterministic path owns
// the outcome.
const OWNER_REPORT_LOCK_SURFACE = 'overnight-strategic-briefing';
const OWNER_REPORT_CODEX_ROUTE = OVERNIGHT_CEILING.codex;

function resolveOwnerReportLock(lane) {
  if (lane === 'claude') return OWNER_REPORT_CLAUDE_ROUTE;
  if (lane === 'codex') return OWNER_REPORT_CODEX_ROUTE;
  throw new Error(`owner report lock has no ${lane} route`);
}

function ownerReportLockApplies(opts = {}) {
  return Boolean(opts) && opts.ownerReportLock === OWNER_REPORT_LOCK_SURFACE && opts.surface === OWNER_REPORT_LOCK_SURFACE;
}

function isOwnerVideoSpawn(spawn, signals = {}) {
  return OWNER_VIDEO_CLAUDE_SPAWNS.has(String(spawn || '')) || Boolean(signals && signals.ownerVideoWork === true);
}

function applyOwnerVideoRoute(spawn, lane, signals, decision) {
  if (!['claude', 'codex'].includes(lane) || !isOwnerVideoSpawn(spawn, signals)) return decision;
  if (decision && decision.denied) return decision;
  const route = lane === 'claude' ? OWNER_VIDEO_CLAUDE_ROUTE : OWNER_VIDEO_CODEX_ROUTE;
  const base = decision || { lane, tier: null, routed: true, reason: 'router unavailable' };
  return {
    ...base,
    lane,
    routed: true,
    model: route.model,
    effort: route.effort,
    requestedEffort: route.effort,
    effortSubstituted: false,
    ownerVideoRoute: true,
    reason: `${base.reason}; owner video route ${route.model}/${route.effort} (ExampleCo 2026-09-26)`,
  };
}

// The Claude plan meter the quota guard reads, from the same data dir the
// runtime routing policy lives in. A reading is used only when it is fresh
// under the shared six-hour rule, and each window only until its own reset
// time passes. Anything else returns null percentages with a note, so a stale
// or missing meter never steps work down and the router receipt says so.
function readClaudePlanMeter(env = process.env, nowMs = Date.now()) {
  const file = path.join(path.dirname(runtimePolicyPath(env)), CLAUDE_PLAN_METER_FILE);
  let meter;
  try {
    meter = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { weeklyPercent: null, fiveHourPercent: null, note: `claude plan meter missing or unreadable at ${file} (quota guard inactive)` };
  }
  const generatedAtMs = Date.parse(String(meter?.generated_at || ''));
  if (claudePlanMeterStale(generatedAtMs, nowMs)) {
    return {
      weeklyPercent: null,
      fiveHourPercent: null,
      note: `claude plan meter stale, generated_at ${meter?.generated_at || 'missing'} is over six hours old (quota guard inactive)`,
    };
  }
  const windowPercent = (value, resetsAt) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    const resetMs = Date.parse(String(resetsAt || ''));
    return Number.isFinite(resetMs) && resetMs <= nowMs ? null : value;
  };
  return {
    weeklyPercent: windowPercent(meter.weekly_all_models_percent, meter.weekly_all_models_resets_at),
    fiveHourPercent: windowPercent(meter.five_hour_percent, meter.five_hour_resets_at),
    note: null,
  };
}

function readClaudeWeeklyPercent(env = process.env, nowMs = Date.now()) {
  return readClaudePlanMeter(env, nowMs).weeklyPercent;
}

// The signals a spawn under the night marker routes with: the profile, and for
// the Claude lane the plan meter the quota guard reads. A caller that already
// measured the meter keeps its own values.
function overnightProfileSignals(lane, signals = {}, env = process.env) {
  const out = { profile: OVERNIGHT_PROFILE };
  if (lane === 'claude' && signals.claudeWeeklyPercent === undefined && signals.claudeFiveHourPercent === undefined) {
    const meter = readClaudePlanMeter(env);
    out.claudeWeeklyPercent = meter.weeklyPercent;
    out.claudeFiveHourPercent = meter.fiveHourPercent;
    if (meter.note) out.claudeMeterNote = meter.note;
  }
  return out;
}

/** Append-only receipt. Never throws into the caller: a ledger write must not
 *  be able to kill a heal session. */
function recordRouterDecision(entry = {}, opts = {}) {
  const ledgerPath = opts.ledgerPath || SHADOW_LEDGER;
  try {
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    fs.appendFileSync(
      ledgerPath,
      `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`,
      'utf8',
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * THE SHARED SEAM. Every spawn that starts a Claude or Codex CLI goes through
 * this one function, so there is exactly one place that decides, one place that
 * receipts, and one cutover switch for the whole system.
 *
 * Returns the decision to APPLY, or null to leave the spawn exactly as it was.
 * Routing is live by default, so every lane pins a model and an effort no
 * matter which launcher started it. Under the explicit
 * SECONDBRAIN_MODEL_ROUTER=shadow opt-out it normally returns null after
 * receipting. The briefing Codex ceiling is the deliberate exception: it must
 * still return an explicit safe pin in shadow mode or after a router failure,
 * because an inherited desktop default can exceed the owner's hard ceiling.
 *
 * Under the night marker (overnightProfileActive) the signals carry
 * profile 'overnight', so routeModel() reads the overnight profile tiers, and
 * the Claude plan meter for the down-only quota guard; the result is then
 * clamped to OVERNIGHT_CEILING with a receipt, never refused.
 *
 * @param {string} spawn  call-site name, recorded in the ledger
 * @param {string} lane   'claude' | 'codex'
 * @param {object} signals see routeModel()
 */
function decideSpawnModel(spawn, lane, signals = {}, opts = {}) {
  const env = opts.env || process.env;
  let full = { lane };
  let decision = null;
  try {
    full = { ...signals, lane, ...(overnightProfileActive(spawn, env) ? overnightProfileSignals(lane, signals, env) : {}) };
    const route = typeof opts.routeModel === 'function' ? opts.routeModel : routeModel;
    decision = applyOwnerVideoRoute(spawn, lane, full, applyBriefingCodexCeiling(spawn, lane, route(full), env));
  } catch (err) {
    decision = applyOwnerVideoRoute(spawn, lane, full, applyBriefingCodexCeiling(spawn, lane, null, env));
    recordRouterDecision(
      {
        spawn,
        lane,
        signals: full,
        error: String((err && err.message) || err),
        decision,
        applied: Boolean(decision),
      },
      opts,
    );
    return decision;
  }
  const live = isRouterLive(env);
  const ceilingApplied = briefingModelCeilingApplies(spawn, env);
  const applied = Boolean(decision && decision.routed === true && (live || ceilingApplied));
  recordRouterDecision(
    {
      spawn,
      lane,
      mode: live ? 'live' : 'shadow',
      signals: full,
      decision,
      applied,
    },
    opts,
  );
  return applied ? decision : null;
}

/**
 * Argument pins for a DIRECT `codex exec` spawn.
 *
 * --ignore-user-config is the flag that actually stops the desktop
 * ~/.codex/config.toml (model = "gpt-5.6-sol", model_reasoning_effort = "xhigh")
 * from leaking into automation. Verified 2026-08-24: the same `codex exec`
 * reports `reasoning effort: xhigh` without it and none with it. It is emitted
 * ONLY alongside an explicit model and effort, because stripping the user config
 * without pinning a replacement would leave the spawn with no policy at all.
 */
function codexExecPins(decision, { env = process.env, ledgerPath } = {}) {
  if (!decision) return [];
  if (decision.denied) throw new Error(decision.reason || 'model lane denied by owner ceiling');
  const pinned = overnightPinnedDecision('codex', decision, env, ledgerPath);
  assertOwnerExplicitModelAuthorization(pinned, 'Codex');
  assertModelEnabled(pinned, 'Codex');
  return [
    '--ignore-user-config',
    '-m',
    pinned.model,
    '-c',
    `model_reasoning_effort="${pinned.effort}"`,
  ];
}

// Under the night marker a pin builder never emits anything above the owner
// overnight ceiling. A routed decision already sits under it; a literal pin
// above it (or Astra/Fable, even with an owner authorization) is clamped down
// and the clamp is receipted to the router ledger.
function overnightPinnedDecision(lane, decision, env = process.env, ledgerPath = undefined) {
  if (!overnightProfileActive('', env)) return decision;
  const policy = loadModelRoutingPolicy({ env });
  if (withinOvernightCeiling(lane, decision.model, decision.effort, policy)) return decision;
  const clamped = clampToOvernightCeiling(lane, decision, policy);
  recordRouterDecision({
    spawn: `${lane}-pin-builder`,
    lane,
    mode: 'overnight-clamp',
    signals: { literal: { model: decision.model || null, effort: decision.effort || null } },
    decision: clamped,
    applied: true,
  }, ledgerPath ? { ledgerPath } : {});
  return clamped;
}

// CLAUDE AUTOMATION CEILING. ExampleCo, 2026-09-14: "when we're on claude with any
// automation, use no more than Opus 5 max think." Every unattended Claude CLI
// spawn names a model at or below this ceiling. An unpinned spawn inherits the
// account default, which on the desktop is the newest interactive model and is
// therefore above the ceiling; on EC2 it was whatever ~/.claude.json happened
// to hold. Neither is a cap, so the cap lives here and in the pins below.
const CLAUDE_AUTOMATION_CEILING = Object.freeze({ model: 'claude-opus-5', effort: 'max' });

// Models allowed under the ceiling. Anything not listed (a newer family, an
// unaudited alias such as bare "opus") is above the ceiling by construction,
// so a future model cannot slip in by name. The dated Sonnet 4 id is the
// legacy ec2-server.js Telegram pin; the dated Haiku id is the summarizer pin.
const CLAUDE_MODELS_UNDER_CEILING = Object.freeze([
  'claude-haiku-4-5',
  'claude-haiku-4-5-20251001',
  'claude-sonnet-4-20250514',
  'claude-sonnet-4-6',
  'claude-sonnet-5',
  'claude-opus-4-6',
  'claude-opus-4-7',
  'claude-opus-5',
  // Owner routes: video (ExampleCo 2026-09-23, OWNER_VIDEO_CLAUDE_ROUTE), the
  // overnight strategic report (ExampleCo 2026-09-24, OWNER_REPORT_CLAUDE_ROUTE),
  // and the overnight profile ceiling (ExampleCo 2026-09-24, OVERNIGHT_CEILING).
  // No base policy tier names it, so daytime automation still tops out below it.
  'claude-opus-5-5',
]);

function withinClaudeCeiling(model, effort) {
  if (!CLAUDE_MODELS_UNDER_CEILING.includes(String(model || ''))) return false;
  if (effort === undefined || effort === null || effort === '') return true;
  return LANE_REAL_EFFORTS.claude.includes(String(effort));
}

/** Argument pins for a direct `claude` CLI spawn. Refuses any decision above the ceiling. */
function claudeCliPins(decision, { env = process.env, ledgerPath } = {}) {
  if (!decision) return [];
  if (decision.denied) throw new Error(decision.reason || 'Claude denied by owner ceiling');
  const pinned = overnightPinnedDecision('claude', decision, env, ledgerPath);
  assertOwnerExplicitModelAuthorization(pinned, 'Claude');
  assertModelEnabled(pinned, 'Claude');
  if (!withinClaudeCeiling(pinned.model, pinned.effort)) {
    throw new Error(
      `claude spawn refused: ${pinned.model}/${pinned.effort} is above the automation ceiling ${CLAUDE_AUTOMATION_CEILING.model}/${CLAUDE_AUTOMATION_CEILING.effort}`,
    );
  }
  return ['--model', pinned.model, '--effort', pinned.effort];
}

// Overnight askAI Claude rung tier by work phase; see claudeCeilingPins.
const OVERNIGHT_PHASE_TIER = Object.freeze({
  'routine-observation': 1,
  'strategic-synthesis': 2,
  'hard-decision': MAX_TIER,
});
const OVERNIGHT_UNPHASED_TIER = 2;

/**
 * Explicit pins for a Claude spawn that has no routed decision (the askAI
 * Claude rung keeps its own phase-bound effort policy). The model is the
 * ceiling itself, never the account default; effort is passed through only
 * when the caller resolved one.
 *
 * Under the night marker the model comes from the overnight profile instead,
 * by work phase (OVERNIGHT_PHASE_TIER): easy phases delegate down, strategic
 * synthesis and an unphased call take tier 2 (the router's default tier) so the
 * quota guard applies, and only hard-decision takes the tier 3 ceiling. Effort
 * is always emitted and capped at medium, so no night spawn inherits the CLI
 * default. A quota step-down is receipted to the router ledger.
 *
 * budgetMs is the rung timeout the spawn actually has. The router's Claude
 * tight-budget cap applies here as in routeModel: under TIGHT_BUDGET_MS a phase
 * tier above 1 drops to tier 1, receipted. Before this, psychology-card and
 * values-equipping-ideas (150 s) and comm-coaching-card (120 s) moved up to
 * Opus 5.5 by phase inside budgets that already time out on Sonnet 4.6.
 */
function claudeCeilingPins(effort, { env = process.env, phase = '', budgetMs, ledgerPath } = {}) {
  if (overnightProfileActive('', env)) {
    const policy = loadModelRoutingPolicy({ env });
    const phaseTier = Object.hasOwn(OVERNIGHT_PHASE_TIER, String(phase || ''))
      ? OVERNIGHT_PHASE_TIER[phase]
      : OVERNIGHT_UNPHASED_TIER;
    const budget = Number(budgetMs);
    const tightBudget = Number.isFinite(budget) && budget > 0 && budget < TIGHT_BUDGET_MS && phaseTier > 1;
    const tier = tightBudget ? 1 : phaseTier;
    const signals = overnightProfileSignals('claude', {}, env);
    const guarded = overnightQuotaGuard({
      lane: 'claude',
      tier,
      route: resolvedProfileTier(policy, 'claude', tier),
      signals,
      policy,
    });
    const route = guarded.route;
    if (guarded.stepDown) {
      recordRouterDecision({
        spawn: 'claude-ceiling-pins',
        lane: 'claude',
        mode: 'overnight-quota-step-down',
        signals: { phase: phase || null, ...signals },
        decision: { tier, model: route.model, effort: route.effort, quotaStepDown: true, reason: guarded.reasons.join('; ') },
        applied: true,
      }, ledgerPath ? { ledgerPath } : {});
    }
    const pinnedEffort = OVERNIGHT_EFFORTS.claude.includes(String(effort || '')) ? effort : route.effort;
    if (tightBudget) {
      recordRouterDecision({
        spawn: 'claude-ceiling-pins',
        lane: 'claude',
        mode: 'overnight-tight-budget-cap',
        signals: { phase: phase || null, budgetMs: budget, ...signals },
        decision: {
          tier,
          cappedFromTier: phaseTier,
          model: route.model,
          effort: pinnedEffort,
          reason: `budget ${budget}ms under ${TIGHT_BUDGET_MS}ms: cap at tier 1`,
        },
        applied: true,
      }, ledgerPath ? { ledgerPath } : {});
    }
    return ['--model', route.model, '--effort', pinnedEffort];
  }
  const route = resolvedTier(loadModelRoutingPolicy(), 'claude', MAX_TIER);
  if (!route) throw new Error('Claude spawn refused: no enabled automatic model route is configured');
  if (!withinClaudeCeiling(route.model, effort || route.effort)) {
    throw new Error(
      `claude spawn refused: ${route.model}/${effort || route.effort} is above the automation ceiling ${CLAUDE_AUTOMATION_CEILING.model}/${CLAUDE_AUTOMATION_CEILING.effort}`,
    );
  }
  return ['--model', route.model, ...(effort ? ['--effort', effort] : [])];
}

module.exports = {
  BRIEFING_CODEX_CEILING,
  CLAUDE_AUTOMATION_CEILING,
  CLAUDE_MODELS_UNDER_CEILING,
  EFFORT_RANK,
  HEALER_BRAIN_SWITCH_SPAWNS,
  LANES,
  LANE_REAL_EFFORTS,
  LAUNCH_CLASS_TASK_TYPE,
  MAX_TIER,
  MODEL_RANK,
  OVERNIGHT_CEILING,
  OVERNIGHT_EFFORTS,
  OVERNIGHT_PHASE_TIER,
  OVERNIGHT_PROFILE,
  OVERNIGHT_QUOTA_STEP_DOWN_PERCENT,
  OVERNIGHT_QUOTA_STEP_DOWN_ROUTE,
  OWNER_REPORT_CLAUDE_ROUTE,
  OWNER_REPORT_CODEX_ROUTE,
  OWNER_REPORT_LOCK_SURFACE,
  OWNER_VIDEO_CLAUDE_ROUTE,
  OWNER_VIDEO_CODEX_ROUTE,
  OWNER_VIDEO_CLAUDE_SPAWNS,
  SHADOW_LEDGER,
  TASK_TIER,
  TIER3_REQUESTED_EFFORT,
  TIER_EFFORT,
  TIER_MODEL,
  TIER_REQUESTED_EFFORT,
  TIGHT_BUDGET_MS,
  VERBATIM_ROUTING_RULES,
  assertOwnerExplicitModelAuthorization,
  assertModelEnabled,
  applyBriefingCodexCeiling,
  applyOwnerVideoRoute,
  briefingModelCeilingApplies,
  clampToOvernightCeiling,
  claudeCeilingPins,
  claudeCliPins,
  classifyLaunchTaskType,
  codexExecPins,
  decideSpawnModel,
  isOwnerVideoSpawn,
  isRouterLive,
  launchClassLabel,
  overnightProfileActive,
  overnightProfileSignals,
  overnightQuotaGuard,
  ownerReportLockApplies,
  readClaudePlanMeter,
  readClaudeWeeklyPercent,
  recordRouterDecision,
  resolveOwnerReportLock,
  routeModel,
  routerMode,
  withinClaudeCeiling,
  withinOvernightCeiling,
};
