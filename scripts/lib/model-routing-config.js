'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..');
const SOURCE_POLICY = path.join(REPO, 'config', 'model-routing.json');

// OVERNIGHT CEILING. ExampleCo, 2026-09-24: overnight work defaults to Claude Opus
// 5.5 at medium and Codex GPT-5.6 Sol at medium; it may delegate down in model
// or effort for easy work, never up. The ceiling lives in code, not config, so
// no policy file can raise it: validatePolicy() rejects any profile tier above
// it and the router clamps anything above it down with a receipt. It lives
// here, not in model-router.js, because model-router.js already requires this
// file and validatePolicy() needs the ceiling.
const OVERNIGHT_CEILING = Object.freeze({
  claude: Object.freeze({ model: 'claude-opus-5-5', effort: 'medium' }),
  codex: Object.freeze({ model: 'gpt-5.6-sol', effort: 'medium' }),
});

// Efforts at or below medium that each CLI accepts. Sonnet 4.6 at high counts
// as up, so effort is capped at medium on every model overnight.
const OVERNIGHT_EFFORTS = Object.freeze({
  claude: Object.freeze(['low', 'medium']),
  codex: Object.freeze(['minimal', 'low', 'medium']),
});

// Capability rank per lane, lowest first. A model missing from its lane's table
// cannot prove it sits under the ceiling, so it is treated as above it.
const MODEL_RANK = Object.freeze({
  claude: Object.freeze({
    'claude-haiku-4-5': 1,
    'claude-haiku-4-5-20251001': 1,
    'claude-sonnet-4-20250514': 2,
    'claude-sonnet-4-6': 2,
    'claude-sonnet-5': 3,
    'claude-opus-4-6': 3,
    'claude-opus-4-7': 3,
    'claude-opus-5': 4,
    'claude-opus-5-5': 5,
  }),
  codex: Object.freeze({
    'gpt-5.6-luna': 1,
    'gpt-5.6-terra': 2,
    'gpt-5.6-sol': 3,
  }),
});

const EFFORT_RANK = Object.freeze({ minimal: 0, low: 1, medium: 2, high: 3, xhigh: 4, max: 5, ultra: 6 });

// Astra and Fable are never used overnight, even with an owner authorization:
// unattended night work has no current prompt to carry one.
const OVERNIGHT_NEVER = /astra|fable/i;

function modelRank(lane, model) {
  const table = MODEL_RANK[lane];
  return table && Object.hasOwn(table, String(model || '')) ? table[model] : null;
}

// True only when the model and effort are both provably at or below the
// overnight ceiling for the lane. With a policy, a model the policy disables
// is outside it too.
function withinOvernightCeiling(lane, model, effort, policy = null) {
  const ceiling = OVERNIGHT_CEILING[lane];
  if (!ceiling) return false;
  const rank = modelRank(lane, model);
  if (rank === null || rank > modelRank(lane, ceiling.model)) return false;
  if (OVERNIGHT_NEVER.test(String(model || ''))) return false;
  if (!OVERNIGHT_EFFORTS[lane].includes(String(effort || ''))) return false;
  if (policy && policy.models?.[model]?.enabled === false) return false;
  return true;
}

function runtimePolicyPath(env = process.env) {
  const dataDir = String(env.SECONDBRAIN_DATA_DIR || '').trim() || path.join(REPO, 'data');
  return path.join(path.resolve(dataDir), 'agent', 'model-routing-policy.json');
}

function validatePolicy(policy) {
  if (!policy || policy.schema !== 'amy.model-routing-policy.v1') throw new Error('invalid model routing policy schema');
  for (const lane of ['codex', 'claude']) {
    for (let tier = 0; tier <= 3; tier += 1) {
      const row = policy.tiers?.[lane]?.[tier];
      if (!row?.model || !row?.effort) throw new Error(`model routing policy missing ${lane} tier ${tier}`);
      if (!Object.hasOwn(policy.models || {}, row.model)) throw new Error(`model routing policy tier references unknown model ${row.model}`);
    }
  }
  if (!policy.defaults?.codex?.model || !policy.defaults?.codex?.effort) throw new Error('model routing policy missing Codex default');
  validateProfiles(policy);
  const explicitPatterns = (policy.explicitCurrentPromptOnlyPatterns || []).map((value) => String(value).toLowerCase());
  for (const [model, settings] of Object.entries(policy.models || {})) {
    if (!settings.explicitCurrentPromptOnly) continue;
    if (settings.enabled !== false) throw new Error(`explicit-current-prompt-only model must stay disabled in automatic routing: ${model}`);
    if (!explicitPatterns.some((pattern) => model.toLowerCase().includes(pattern))) {
      throw new Error(`explicit-current-prompt-only model lacks an enforcement pattern: ${model}`);
    }
  }
  return policy;
}

// A profile may only tune tiers downward: every profile tier must sit at or
// under the overnight ceiling in code. Enabled state is not checked here; a
// disabled profile model falls to the nearest enabled tier at route time.
function validateProfiles(policy) {
  if (policy.profiles === undefined) return;
  if (!policy.profiles || typeof policy.profiles !== 'object') throw new Error('model routing profiles must be an object');
  for (const name of Object.keys(policy.profiles)) {
    if (name !== 'overnight') throw new Error(`unknown model routing profile: ${name}`);
  }
  // A profiles object without overnight would make every marked spawn throw
  // 'no overnight profile' in routeModel and fall back to unpinned CLI
  // defaults, so a present profiles object must carry it.
  const overnight = policy.profiles.overnight;
  if (!overnight || typeof overnight !== 'object') throw new Error('model routing profiles missing the overnight profile');
  for (const lane of ['codex', 'claude']) {
    const ceiling = OVERNIGHT_CEILING[lane];
    for (let tier = 0; tier <= 3; tier += 1) {
      const row = overnight.tiers?.[lane]?.[tier];
      if (!row?.model || !row?.effort) throw new Error(`model routing profile overnight missing ${lane} tier ${tier}`);
      if (!Object.hasOwn(policy.models || {}, row.model)) {
        throw new Error(`model routing profile overnight tier references unknown model ${row.model}`);
      }
      if (!withinOvernightCeiling(lane, row.model, row.effort)) {
        throw new Error(
          `model routing profile overnight ${lane} tier ${tier} ${row.model}/${row.effort} is above the owner overnight ceiling ${ceiling.model}/${ceiling.effort}`,
        );
      }
    }
  }
}

function readPolicyFile(file) {
  return validatePolicy(JSON.parse(fs.readFileSync(file, 'utf8')));
}

// A runtime policy written before profiles existed (EC2 keeps its own copy)
// would otherwise drop the overnight profile silently, because the runtime file
// replaces the source file wholesale. Carry the source profiles, and any model
// row they name that the runtime file lacks, into such a policy.
function withSourceProfiles(policy, source) {
  if (policy.profiles !== undefined || !source.profiles) return policy;
  const models = { ...policy.models };
  for (const profile of Object.values(source.profiles)) {
    for (const rows of Object.values(profile.tiers || {})) {
      for (const row of Object.values(rows || {})) {
        if (row?.model && !Object.hasOwn(models, row.model)) models[row.model] = source.models[row.model];
      }
    }
  }
  return validatePolicy({ ...policy, models, profiles: source.profiles });
}

function loadModelRoutingPolicy({ env = process.env, sourceFile = SOURCE_POLICY } = {}) {
  const runtime = runtimePolicyPath(env);
  if (runtime && fs.existsSync(runtime)) {
    try { return withSourceProfiles(readPolicyFile(runtime), readPolicyFile(sourceFile)); }
    catch (error) { process.emitWarning(`Ignoring invalid runtime model-routing policy ${runtime}: ${error.message}`); }
  }
  return readPolicyFile(sourceFile);
}

// The overnight profile's tier table, resolved with the same enabled-model
// fallback as the base tiers.
function resolvedProfileTier(policy, lane, tier, profile = 'overnight') {
  const tiers = policy.profiles?.[profile]?.tiers;
  if (!tiers) throw new Error(`model routing policy has no ${profile} profile`);
  return resolvedTier({ ...policy, tiers }, lane, tier);
}

function resolvedTier(policy, lane, tier) {
  const wanted = policy.tiers[lane][tier];
  if (policy.models[wanted.model]?.enabled !== false) return wanted;
  for (let candidateTier = tier - 1; candidateTier >= 0; candidateTier -= 1) {
    const row = policy.tiers[lane][candidateTier];
    if (row && policy.models[row.model]?.enabled !== false) return row;
  }
  for (let candidateTier = tier + 1; candidateTier <= 3; candidateTier += 1) {
    const row = policy.tiers[lane][candidateTier];
    if (row && policy.models[row.model]?.enabled !== false) return row;
  }
  throw new Error(`no enabled ${lane} model remains for tier ${tier}`);
}

function explicitOnlyPattern(policy) {
  const parts = policy.explicitCurrentPromptOnlyPatterns || [];
  if (!parts.length) return /$a/;
  return new RegExp(parts.map((part) => String(part).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');
}

module.exports = {
  EFFORT_RANK,
  MODEL_RANK,
  OVERNIGHT_CEILING,
  OVERNIGHT_EFFORTS,
  OVERNIGHT_NEVER,
  SOURCE_POLICY,
  explicitOnlyPattern,
  loadModelRoutingPolicy,
  modelRank,
  readPolicyFile,
  resolvedProfileTier,
  resolvedTier,
  runtimePolicyPath,
  validatePolicy,
  withinOvernightCeiling,
};
