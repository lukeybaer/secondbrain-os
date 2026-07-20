'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  advisorPaths,
  isMaterialAdjustment,
  readRecentLearnings,
  runtimeDataDir,
} = require('./graphiti-brain-advisor');

const DEFAULT_SURFACES = [
  'claude-code',
  'codex',
  'electron-chat',
  'telegram',
  'vapi',
  'scheduled-skill',
  'dispatch',
  'agent-loop',
  'action',
];

function readJsonl(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function percentile(values, p) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

function completeFactDisposition(fact) {
  return (
    fact &&
    ['used', 'ignored'].includes(fact.disposition) &&
    Boolean(fact.reason) &&
    Boolean(fact.resulting_adjustment) &&
    Boolean(fact.answer_action_id) &&
    typeof fact.private_detail_redacted === 'boolean'
  );
}

function computeGraphitiAdvisorHealth({
  consults = [],
  dispositions = [],
  expectedSurfaces = DEFAULT_SURFACES,
  wiredSurfaces = {},
  now = Date.now(),
  windowMs = 24 * 60 * 60 * 1000,
  learningCount,
  trendWindow = 25,
} = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const cutoff = nowMs - windowMs;
  const recentConsults = consults.filter(
    (row) => Date.parse(row.ts || row.completed_at || 0) >= cutoff,
  );
  const latestById = new Map();
  for (const row of recentConsults) latestById.set(row.advisor_id, row);
  const uniqueConsults = [...latestById.values()];
  const dispositionById = new Map(
    dispositions
      .filter((row) => Date.parse(row.ts || 0) >= cutoff)
      .map((row) => [row.advisor_id, row]),
  );
  const expectedFacts = uniqueConsults.reduce((sum, row) => sum + Number(row.fact_count || 0), 0);
  const dispositionFacts = uniqueConsults.reduce((sum, row) => {
    const receipt = dispositionById.get(row.advisor_id);
    return (
      sum +
      (receipt && Array.isArray(receipt.facts)
        ? receipt.facts.filter(completeFactDisposition).length
        : 0)
    );
  }, 0);
  const reportedInfluenced = uniqueConsults.filter((row) => {
    const receipt = dispositionById.get(row.advisor_id);
    return receipt && receipt.facts && receipt.facts.some((fact) => fact.disposition === 'used');
  }).length;
  const materiallyInfluenced = (row) => {
    const receipt = dispositionById.get(row.advisor_id);
    return Boolean(
      receipt &&
      receipt.facts &&
      receipt.facts.some(
        (fact) => fact.disposition === 'used' && isMaterialAdjustment(fact.resulting_adjustment),
      ),
    );
  };
  const influenced = uniqueConsults.filter(materiallyInfluenced).length;
  const falseImpactClaims = uniqueConsults.filter((row) => {
    const receipt = dispositionById.get(row.advisor_id);
    const used = (receipt && receipt.facts ? receipt.facts : []).filter(
      (fact) => fact.disposition === 'used',
    );
    return used.length > 0 && !used.some((fact) => isMaterialAdjustment(fact.resulting_adjustment));
  }).length;
  const statuses = uniqueConsults.reduce((acc, row) => {
    acc[row.status || 'ExampleCo'] = (acc[row.status || 'ExampleCo'] || 0) + 1;
    return acc;
  }, {});
  const surfaces = {};
  for (const surface of expectedSurfaces) {
    const rows = uniqueConsults.filter((row) => row.surface === surface);
    const wired = wiredSurfaces[surface] === true;
    surfaces[surface] = {
      status: rows.length ? 'observed' : wired ? 'idle-wired' : 'missing',
      consults: rows.length,
      last_at: rows.length
        ? rows
            .map((row) => row.ts)
            .sort()
            .at(-1)
        : null,
    };
  }
  const total = uniqueConsults.length;
  const timeoutCount = (statuses.timeout || 0) + (statuses.unavailable || 0);
  const pendingCount = statuses.pending || 0;
  const failures = [];
  if (expectedFacts > 0 && dispositionFacts !== expectedFacts) {
    failures.push(`Disposition coverage is ${dispositionFacts}/${expectedFacts} retrieved facts.`);
  }
  // The current answer exposes the first retrieval failure in Graphiti impact.
  // System Health is the second escalation point, so turn red on recurrence.
  if (timeoutCount >= 2)
    failures.push(`${timeoutCount} Graphiti advisor consultations timed out or were unavailable.`);
  if (pendingCount > 0)
    failures.push(`${pendingCount} Graphiti advisor consultation(s) remain pending.`);
  const missing = Object.entries(surfaces)
    .filter(([, row]) => row.status === 'missing')
    .map(([name]) => name);
  if (missing.length) failures.push(`Surface wiring/observation missing: ${missing.join(', ')}.`);
  const lessons = learningCount == null ? readRecentLearnings({ limit: 10 }).length : learningCount;
  if (lessons <= 0)
    failures.push('The Graphiti consult skill has no learning entries to adapt future queries.');
  const latencies = uniqueConsults.map((row) => Number(row.latency_ms)).filter(Number.isFinite);
  const chronological = [...uniqueConsults].sort(
    (a, b) => Date.parse(a.ts || a.completed_at || 0) - Date.parse(b.ts || b.completed_at || 0),
  );
  const boundedTrendWindow = Math.max(1, Number(trendWindow) || 25);
  const recentTrendRows = chronological.slice(-boundedTrendWindow);
  const previousTrendRows = chronological.slice(-2 * boundedTrendWindow, -boundedTrendWindow);
  const impactRate = (rows) =>
    rows.length ? rows.filter(materiallyInfluenced).length / rows.length : null;
  const recentImpactRate = impactRate(recentTrendRows);
  const previousImpactRate = impactRate(previousTrendRows);
  const impactDelta =
    recentImpactRate == null || previousImpactRate == null
      ? null
      : recentImpactRate - previousImpactRate;
  const impactTrend =
    previousTrendRows.length < boundedTrendWindow || impactDelta == null
      ? 'insufficient-data'
      : impactDelta > 0.02
        ? 'improving'
        : impactDelta < -0.02
          ? 'declining'
          : 'flat';
  const completeTrendWindowCount = Math.min(
    4,
    Math.floor(chronological.length / boundedTrendWindow),
  );
  const completeTrendRows = chronological.slice(-completeTrendWindowCount * boundedTrendWindow);
  const impactWindowRates = Array.from({ length: completeTrendWindowCount }, (_, index) =>
    impactRate(
      completeTrendRows.slice(index * boundedTrendWindow, (index + 1) * boundedTrendWindow),
    ),
  );
  const impactSteadyImprovement =
    impactWindowRates.length >= 3 &&
    impactWindowRates.slice(1).every((rate, index) => rate - impactWindowRates[index] > 0.02);
  const queryVariants = {};
  for (const row of uniqueConsults.filter(
    (consult) => consult.status !== 'reused' && consult.experiment_eligible !== false,
  )) {
    const name = row.query_variant || 'legacy';
    if (!queryVariants[name]) {
      queryVariants[name] = {
        consults: 0,
        impacted: 0,
        timeouts: 0,
        false_impact_claims: 0,
      };
    }
    const bucket = queryVariants[name];
    bucket.consults += 1;
    if (materiallyInfluenced(row)) bucket.impacted += 1;
    if (['timeout', 'unavailable'].includes(row.status)) bucket.timeouts += 1;
    const receipt = dispositionById.get(row.advisor_id);
    const used = (receipt && receipt.facts ? receipt.facts : []).filter(
      (fact) => fact.disposition === 'used',
    );
    if (used.length && !used.some((fact) => isMaterialAdjustment(fact.resulting_adjustment))) {
      bucket.false_impact_claims += 1;
    }
  }
  for (const bucket of Object.values(queryVariants)) {
    bucket.impact_rate = bucket.consults ? bucket.impacted / bucket.consults : 0;
    bucket.timeout_rate = bucket.consults ? bucket.timeouts / bucket.consults : 0;
  }
  const metrics = {
    consults: total,
    substantive_yield_rate: total
      ? uniqueConsults.filter((row) => Number(row.fact_count || 0) > 0).length / total
      : 0,
    impact_rate: total ? influenced / total : 0,
    influence_rate: total ? influenced / total : 0,
    reported_influence_rate: total ? reportedInfluenced / total : 0,
    false_impact_claims: falseImpactClaims,
    impact_rate_previous_window: previousImpactRate,
    impact_rate_recent_window: recentImpactRate,
    impact_rate_delta: impactDelta,
    impact_trend: impactTrend,
    impact_window_rates: impactWindowRates,
    impact_steady_improvement: impactSteadyImprovement,
    impact_trend_window: boundedTrendWindow,
    disposition_completeness: expectedFacts ? dispositionFacts / expectedFacts : 1,
    reuse_rate: total ? (statuses.reused || 0) / total : 0,
    timeout_rate: total ? timeoutCount / total : 0,
    pending_rate: total ? pendingCount / total : 0,
    latency_p50_ms: percentile(latencies, 0.5),
    latency_p95_ms: percentile(latencies, 0.95),
    learning_count_loaded: lessons,
  };
  return {
    schema: 'amy.graphiti_advisor_health.v1',
    generated_at: new Date(nowMs).toISOString(),
    window_ms: windowMs,
    status: failures.length ? 'red' : 'green',
    detail: failures.length
      ? failures.join(' ')
      : `${total} consultations; ${(metrics.influence_rate * 100).toFixed(0)}% influenced; all ${expectedFacts} retrieved facts dispositioned.`,
    metrics,
    statuses,
    surfaces,
    query_variants: queryVariants,
    failures,
  };
}

function writeGraphitiAdvisorHealth({ dataDir, expectedSurfaces, wiredSurfaces, now } = {}) {
  const root = runtimeDataDir(dataDir);
  const paths = advisorPaths(root);
  const health = computeGraphitiAdvisorHealth({
    consults: readJsonl(paths.consults),
    dispositions: readJsonl(paths.dispositions),
    expectedSurfaces: expectedSurfaces || DEFAULT_SURFACES,
    wiredSurfaces:
      wiredSurfaces || Object.fromEntries(DEFAULT_SURFACES.map((surface) => [surface, true])),
    now: now || Date.now(),
  });
  const out = path.join(root, 'agent', 'graphiti-advisor-health-latest.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(health, null, 2));
  fs.appendFileSync(
    path.join(root, 'agent', 'graphiti-advisor-health.jsonl'),
    JSON.stringify(health) + '\n',
  );
  return health;
}

module.exports = {
  DEFAULT_SURFACES,
  completeFactDisposition,
  computeGraphitiAdvisorHealth,
  readJsonl,
  writeGraphitiAdvisorHealth,
};
