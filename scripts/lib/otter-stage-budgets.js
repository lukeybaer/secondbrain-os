'use strict';

const fs = require('node:fs');
const path = require('node:path');

const STAGE_NAMES = Object.freeze([
  'full_audio',
  'voice_completion',
  'name_disposition',
  'people_file_projection',
]);
const ARTIFACT_BASENAME = 'otter-call-processing-stage-budgets-latest.json';
const MAX_ARTIFACT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_CALIBRATION_SAMPLE_COUNT = 2;
// Measured receipts describe stage work, not cold Node startup, module loading,
// or the exact-call inventory scan performed before that work. Keep those
// control-plane costs outside the stored mean+3σ clock while giving every
// subprocess a bounded envelope in which it can reach the measured stage.
const STAGE_PROCESS_OVERHEAD_MS = 30_000;

function timeMs(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function durationMinutes(startedAt, completedAt) {
  const start = timeMs(startedAt);
  const end = timeMs(completedAt);
  if (!start || !end || end < start) return null;
  return (end - start) / 60000;
}

function populationStats(values) {
  const samples = (values || [])
    .map(Number)
    .filter((value) => Number.isFinite(value) && value >= 0);
  if (!samples.length) {
    return {
      sample_count: 0,
      mean_minutes: null,
      stddev_minutes: null,
      budget_minutes: null,
    };
  }
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  const variance =
    samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / samples.length;
  const stddev = Math.sqrt(variance);
  return {
    sample_count: samples.length,
    mean_minutes: mean,
    stddev_minutes: stddev,
    budget_minutes: mean + 3 * stddev,
  };
}

function successfulLedgerSamples(ledger) {
  const samples = Object.fromEntries(STAGE_NAMES.map((name) => [name, []]));
  for (const row of ledger?.calls || []) {
    const landed = timeMs(row?.landed_at);
    const closedAt = Math.max(
      ...Object.values(row?.orchestration || {}).map((stage) => timeMs(stage?.completed_at)),
      0,
    );
    // The independent product SLO is 60 minutes. Calibration learns from calls
    // that actually met it, so a historical failure cannot normalize a slower
    // deadline and silently redefine "healthy."
    if (!row?.closed || !landed || !closedAt || closedAt - landed > 60 * 60 * 1000) continue;
    for (const name of STAGE_NAMES) {
      const stage = row?.orchestration?.[name];
      if (stage?.status !== 'complete') continue;
      const value = durationMinutes(stage.ready_at, stage.completed_at);
      if (value != null) samples[name].push(value);
    }
  }
  return samples;
}

function parseJsonLines(file, fsApi = fs) {
  try {
    return fsApi
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function successfulTimingSamples(file, fsApi = fs) {
  const samples = Object.fromEntries(STAGE_NAMES.map((name) => [name, []]));
  const voiceLabels = new Set([
    'diarized_segments',
    'track_probes',
    'voice_resolver',
    'publish_probe_index',
    'publish_sandbox_reference_candidates',
    'incremental_recluster',
  ]);
  for (const run of parseJsonLines(file, fsApi)) {
    const steps = Array.isArray(run?.steps) ? run.steps : [];
    const byLabel = new Map(steps.map((step) => [String(step?.label || ''), step]));
    const addStep = (stageName, label) => {
      const step = byLabel.get(label);
      if (!step?.ok || step?.completion_blocking) return;
      const value =
        Number.isFinite(Number(step.duration_ms)) && Number(step.duration_ms) >= 0
          ? Number(step.duration_ms) / 60000
          : durationMinutes(step.started_at, step.completed_at);
      if (value != null) samples[stageName].push(value);
    };
    addStep('full_audio', 'full_audio');
    addStep('name_disposition', 'name_disposition');
    addStep('people_file_projection', 'identity_change_projection');
    const voiceSteps = steps.filter(
      (step) =>
        voiceLabels.has(String(step?.label || '')) &&
        step?.ok &&
        !step?.completion_blocking &&
        timeMs(step.started_at) &&
        timeMs(step.completed_at),
    );
    if (voiceSteps.length) {
      const start = Math.min(...voiceSteps.map((step) => timeMs(step.started_at)));
      const end = Math.max(...voiceSteps.map((step) => timeMs(step.completed_at)));
      if (end >= start) samples.voice_completion.push((end - start) / 60000);
    }
  }
  return samples;
}

function buildStageBudgetArtifact({
  ledger,
  timingHistoryPath = '',
  generatedAt = new Date().toISOString(),
  fsApi = fs,
} = {}) {
  const ledgerSamples = successfulLedgerSamples(ledger);
  const timingSamples = timingHistoryPath
    ? successfulTimingSamples(timingHistoryPath, fsApi)
    : Object.fromEntries(STAGE_NAMES.map((name) => [name, []]));
  const budgets = {};
  const missing = [];
  for (const name of STAGE_NAMES) {
    const exact = timingSamples[name] || [];
    const bootstrap = ledgerSamples[name] || [];
    // Only per-call intervals measure the SLA population. Exact-stage timing
    // receipts measure producer command execution and may merely observe an
    // artifact that arrived minutes earlier. Treating a large receipt set as
    // SLA calibration can therefore create a sub-minute deadline that every
    // healthy incoming call breaches before the stage is runnable.
    const stats = populationStats(bootstrap);
    const executionStats = populationStats(exact);
    const source = bootstrap.length
      ? 'successful_terminal_call_ledger_intervals'
      : 'successful_terminal_call_intervals_unavailable';
    budgets[name] = {
      ...stats,
      source,
      execution_timing_sample_count: executionStats.sample_count,
      execution_timing_mean_minutes: executionStats.mean_minutes,
      execution_timing_stddev_minutes: executionStats.stddev_minutes,
      formula: 'mean_minutes + (3 * population_stddev_minutes)',
      selection_rule:
        source === 'successful_terminal_call_intervals_unavailable'
          ? 'No successful per-call SLA interval is available; execution timings are retained as non-calibrating evidence.'
          : 'Closed calls whose terminal receipt landed within the independent 60-minute SLO.',
    };
    if (stats.sample_count < MIN_CALIBRATION_SAMPLE_COUNT) missing.push(name);
  }
  return {
    schema: 'life_archive_otter_call_processing_stage_budgets.v1',
    generated_at: generatedAt,
    status: missing.length ? 'RED' : 'GREEN',
    formula: 'historical successful duration mean plus three population standard deviations',
    minimum_calibration_samples: MIN_CALIBRATION_SAMPLE_COUNT,
    independent_sla_minutes: 60,
    critical_sla_minutes: 120,
    missing_stages: missing,
    budgets,
  };
}

function validateStageBudgetArtifact(
  artifact,
  { nowMs = Date.now(), maxAgeMs = MAX_ARTIFACT_AGE_MS } = {},
) {
  const problems = [];
  if (!artifact || typeof artifact !== 'object') {
    return { ok: false, problems: ['stage-budget calibration artifact is missing'], budgets: {} };
  }
  const generated = timeMs(artifact.generated_at);
  if (!generated || nowMs - generated > maxAgeMs) {
    problems.push('stage-budget calibration artifact is stale or undated');
  }
  for (const name of STAGE_NAMES) {
    const row = artifact?.budgets?.[name];
    const mean = Number(row?.mean_minutes);
    const stddev = Number(row?.stddev_minutes);
    const budget = Number(row?.budget_minutes);
    const sampleCount = Number(row?.sample_count);
    if (
      !Number.isFinite(mean) ||
      mean < 0 ||
      !Number.isFinite(stddev) ||
      stddev < 0 ||
      !Number.isFinite(budget) ||
      budget < 0 ||
      !Number.isFinite(sampleCount) ||
      sampleCount < MIN_CALIBRATION_SAMPLE_COUNT
    ) {
      problems.push(
        `${name} lacks ${MIN_CALIBRATION_SAMPLE_COUNT} valid historical calibration samples`,
      );
      continue;
    }
    const expected = mean + 3 * stddev;
    if (Math.abs(expected - budget) > 1e-9) {
      problems.push(`${name} budget does not equal mean plus three standard deviations`);
    }
  }
  return { ok: problems.length === 0, problems, budgets: artifact.budgets || {} };
}

// A brand-new exact-stage timing ledger has too little variance evidence by
// definition. It must be allowed to collect two successful samples without
// ever pretending the calibration is green. Only fresh, structurally honest
// rows below the minimum may borrow the independent SLA as a temporary
// execution ceiling. Stale rows and bad arithmetic still fail closed.
function runtimeStageBudgetValidation(
  artifact,
  { nowMs = Date.now(), maxAgeMs = MAX_ARTIFACT_AGE_MS } = {},
) {
  const measured = validateStageBudgetArtifact(artifact, { nowMs, maxAgeMs });
  if (measured.ok) return { ...measured, mode: 'measured', calibration_ok: true };

  const problems = [];
  const generated = timeMs(artifact?.generated_at);
  const independentSlaMinutes = Number(artifact?.independent_sla_minutes);
  if (!artifact || typeof artifact !== 'object') {
    problems.push('stage-budget calibration artifact is missing');
  }
  if (artifact?.schema !== 'life_archive_otter_call_processing_stage_budgets.v1') {
    problems.push('stage-budget calibration artifact has the wrong schema');
  }
  if (!generated || nowMs - generated > maxAgeMs) {
    problems.push('stage-budget calibration artifact is stale or undated');
  }
  if (
    !/historical successful duration mean plus three population standard deviations/i.test(
      String(artifact?.formula || ''),
    )
  ) {
    problems.push('stage-budget calibration artifact has the wrong formula');
  }
  if (
    !Number.isFinite(independentSlaMinutes) ||
    independentSlaMinutes <= 0 ||
    independentSlaMinutes > 120
  ) {
    problems.push('stage-budget bootstrap ceiling is invalid');
  }

  const missing = [];
  const budgets = {};
  for (const name of STAGE_NAMES) {
    const row = artifact?.budgets?.[name];
    const sampleCount = Number(row?.sample_count);
    if (
      Number.isInteger(sampleCount) &&
      sampleCount >= MIN_CALIBRATION_SAMPLE_COUNT
    ) {
      const mean = Number(row?.mean_minutes);
      const stddev = Number(row?.stddev_minutes);
      const budget = Number(row?.budget_minutes);
      if (
        !Number.isFinite(mean) ||
        mean < 0 ||
        !Number.isFinite(stddev) ||
        stddev < 0 ||
        !Number.isFinite(budget) ||
        budget < 0 ||
        Math.abs(mean + 3 * stddev - budget) > 1e-9
      ) {
        problems.push(`${name} has samples but invalid measured arithmetic`);
      } else {
        budgets[name] = row;
      }
      continue;
    }
    const honestZeroSample =
      row &&
      sampleCount === 0 &&
      row.mean_minutes == null &&
      row.stddev_minutes == null &&
      row.budget_minutes == null;
    const honestSingleSample =
      row &&
      sampleCount === 1 &&
      Number.isFinite(Number(row.mean_minutes)) &&
      Number(row.mean_minutes) >= 0 &&
      Number(row.stddev_minutes) === 0 &&
      Number(row.budget_minutes) === Number(row.mean_minutes);
    if (!honestZeroSample && !honestSingleSample) {
      problems.push(
        `${name} is neither measured nor an honest under-calibrated bootstrap row`,
      );
      continue;
    }
    missing.push(name);
    budgets[name] = {
      ...row,
      budget_minutes: independentSlaMinutes,
      source: 'bootstrap_independent_sla_ceiling',
      measured_sample_count: sampleCount,
      measured_budget_minutes: honestSingleSample ? Number(row.budget_minutes) : null,
    };
  }

  const declaredMissing = [...new Set(artifact?.missing_stages || [])].sort();
  if (JSON.stringify(declaredMissing) !== JSON.stringify([...missing].sort())) {
    problems.push(
      'stage-budget missing-stage declaration does not match its under-calibrated rows',
    );
  }
  if (String(artifact?.status || '').toUpperCase() !== 'RED' || !missing.length) {
    problems.push(
      'stage-budget bootstrap is allowed only for an explicit red under-calibrated artifact',
    );
  }
  return {
    ok: problems.length === 0,
    calibration_ok: false,
    mode: problems.length ? 'invalid' : 'bootstrap',
    problems: problems.length ? problems : measured.problems,
    budgets,
    bootstrap_stages: missing,
    bootstrap_ceiling_minutes: independentSlaMinutes,
  };
}

function readStageBudgetArtifact(dataDir, fsApi = fs) {
  const file = path.join(dataDir, 'life-archive', 'voiceprints', ARTIFACT_BASENAME);
  try {
    return JSON.parse(fsApi.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function budgetMinutes(validation, stageName) {
  const value = Number(validation?.budgets?.[stageName]?.budget_minutes);
  return validation?.ok && Number.isFinite(value) && value >= 0 ? value : null;
}

function budgetMs(validation, stageName) {
  const minutes = budgetMinutes(validation, stageName);
  return minutes == null
    ? null
    : Math.ceil(minutes * 60000) + STAGE_PROCESS_OVERHEAD_MS;
}

function remainingStageProcessMs(deadlineMs, nowMs = Date.now()) {
  return Math.max(STAGE_PROCESS_OVERHEAD_MS, Number(deadlineMs) - Number(nowMs));
}

module.exports = {
  STAGE_NAMES,
  ARTIFACT_BASENAME,
  MAX_ARTIFACT_AGE_MS,
  MIN_CALIBRATION_SAMPLE_COUNT,
  STAGE_PROCESS_OVERHEAD_MS,
  timeMs,
  durationMinutes,
  populationStats,
  successfulLedgerSamples,
  successfulTimingSamples,
  buildStageBudgetArtifact,
  validateStageBudgetArtifact,
  runtimeStageBudgetValidation,
  readStageBudgetArtifact,
  budgetMinutes,
  budgetMs,
  remainingStageProcessMs,
};
