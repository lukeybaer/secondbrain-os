#!/usr/bin/env node
/**
 * Overnight heard-name resolver for Otter acoustic speaker arcs.
 *
 * Runs the whole-call marked-target LLM judge over:
 * 1. confirmed/enrolled known people, as QA calibration;
 * 2. remaining unresolved acoustic speaker arcs, as unlinked heard-name hypotheses.
 *
 * This intentionally does not link text-only names to people files. It only
 * produces durable name-judge artifacts that downstream Pareto/briefing code
 * can surface with confidence and evidence.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const VP_DIR = path.join(ROOT, 'data', 'life-archive', 'voiceprints');
const REGISTRY_PATH = path.join(ROOT, 'data', 'life-archive', 'voice-identity-registry.json');
const PARETO_PATH = path.join(VP_DIR, 'speaker-pareto-latest.json');
const INTEL_PATH = path.join(VP_DIR, 'otter-speaker-intelligence-latest.json');
const STATUS_PATH = path.join(VP_DIR, 'voice-identity-overnight-name-resolver-status.json');
const LOG_DIR = path.join(ROOT, 'logs', 'voice-name-resolver');
const LLM_NAME_JUDGE_DIR = path.join(VP_DIR, 'llm-name-judges');

function arg(name, fallback = '') {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

function hasArg(name) {
  return process.argv.includes(name);
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

function saveJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function slug(value) {
  return String(value || 'target')
    .replace(/^ExampleCo:/, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

function normalizeKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function confirmedPeopleTargets() {
  const registry = readJson(REGISTRY_PATH, {});
  const out = [];
  for (const [personId, person] of Object.entries(registry.people || {})) {
    const confirmed =
      String(person?.identity_confirmation_status || '').startsWith('confirmed') &&
      person?.voiceprint_status === 'enrolled';
    if (!confirmed) continue;
    const enrollmentCount = Number(person?.voiceprint_enrollments || 0);
    if (enrollmentCount <= 0) continue;
    out.push({
      kind: 'known',
      target: personId,
      display_name: person.display_name || personId,
      priority: 100000 + enrollmentCount,
    });
  }
  out.sort((a, b) => b.priority - a.priority || a.target.localeCompare(b.target));
  return out;
}

function ExampleCoTargets() {
  const pareto = readJson(PARETO_PATH, {});
  const intel = readJson(INTEL_PATH, {});
  const rows = [
    ...(intel.ExampleCo_speakers || []),
    ...(pareto.all_unresolved_relationships || []),
    ...(pareto.recurring_unnamed_relationships || []),
    ...(pareto.acoustic_ExampleCo || []),
  ];
  const byTarget = new Map();
  for (const row of rows) {
    const raw = String(row.speaker_key || row.label || '').replace(/^ExampleCo:/, '');
    if (!/^ExampleCo_voice_ecapa_/.test(raw)) continue;
    if (row.identity_tier && row.identity_tier !== 'durable_ExampleCo_voice') continue;
    const calls = Number(row.calls || row.conversation_count || 0);
    const words = Number(row.words || row.word_count || 0);
    const segments = Number(row.segments || row.segment_count || 0);
    const existing = byTarget.get(raw);
    const payload = {
      kind: 'ExampleCo',
      target: raw,
      display_name: row.display_name || raw,
      calls,
      words,
      segments,
      priority: calls * 1_000_000 + words,
    };
    if (!existing || payload.priority > existing.priority) byTarget.set(raw, payload);
  }
  return [...byTarget.values()].sort(
    (a, b) => b.priority - a.priority || a.target.localeCompare(b.target),
  );
}

function existingJudgeTargetKeys() {
  const keys = new Set();
  if (!fs.existsSync(LLM_NAME_JUDGE_DIR)) return keys;
  for (const name of fs.readdirSync(LLM_NAME_JUDGE_DIR)) {
    if (!/^name-judge-.*\.json$/i.test(name) || name === 'name-judge-latest.json') continue;
    const data = readJson(path.join(LLM_NAME_JUDGE_DIR, name), {});
    for (const row of data.target_summaries || []) {
      if (row?.target) keys.add(`ExampleCo:${row.target}`);
    }
    for (const row of data.judged?.targets || []) {
      if (row?.target) keys.add(`ExampleCo:${row.target}`);
    }
    for (const row of data.calibration || []) {
      if (row?.target) keys.add(`known:${row.target}`);
    }
  }
  return keys;
}

function taskList() {
  const includeKnown = !hasArg('--ExampleCo-only');
  const includeExampleCo = !hasArg('--known-only');
  const minCalls = Number(arg('--min-calls', '0')) || 0;
  const limit = Number(arg('--limit', '0')) || 0;
  const targetsArg = arg('--targets', '');
  let tasks = [
    ...(includeKnown ? confirmedPeopleTargets() : []),
    ...(includeExampleCo ? ExampleCoTargets().filter((row) => row.calls >= minCalls) : []),
  ];
  if (targetsArg) {
    const wanted = new Set(
      targetsArg
        .split(/[,;]/)
        .map((part) => part.trim())
        .filter(Boolean),
    );
    tasks = tasks.filter(
      (task) => wanted.has(task.target) || wanted.has(`${task.kind}:${task.target}`),
    );
  }
  if (limit > 0) tasks = tasks.slice(0, limit);
  return tasks;
}

function childArgs(task) {
  const maxWindows =
    task.kind === 'known'
      ? Number(arg('--known-max-windows', '16')) || 16
      : Number(arg('--ExampleCo-max-windows', arg('--max-windows', '28'))) || 28;
  const batchSize = Number(arg('--batch-size', '3')) || 3;
  const targets =
    Array.isArray(task.targets) && task.targets.length
      ? task.targets.map((row) => row.target).join(',')
      : '';
  const args = [
    'scripts/voice-identity-llm-name-judge.js',
    task.kind === 'known' ? '--calibrate' : targets ? '--targets' : '--target',
    targets || task.target,
    '--max-windows',
    String(maxWindows),
    '--batch-size',
    String(batchSize),
    '--min-clear-evidence',
    arg('--min-clear-evidence', '2') || '2',
    '--compact-call-context',
    '--context-turn-words',
    arg('--context-turn-words', '36') || '36',
    '--target-turn-words',
    arg('--target-turn-words', '180') || '180',
    '--write',
    '--llm-timeout-ms',
    arg('--llm-timeout-ms', '300000') || '300000',
    '--max-call-chars',
    arg('--max-call-chars', '30000') || '30000',
  ];
  if (!targets) args.push('--adaptive');
  if (hasArg('--stop-early')) args.push('--stop-early');
  return args;
}

function loadExistingStatus() {
  return readJson(STATUS_PATH, {});
}

// 2026-06-11 ladder preflight: ONE tiny probe through the askAI ladder
// before the overnight fan-out. If every rung (codex, claude proxy/cli,
// paid floor) is down, the judge children would all fail one by one and
// burn the night; abort up front and stamp failed_preflight so the
// briefing can surface the outage honestly. deps is a test seam: { askAIFn }.
async function runLadderPreflight(deps = {}) {
  const ladder = deps.askAIFn || require('./lib/ask-ai.js').askAI;
  let ok = false;
  try {
    const out = await ladder('Reply with the single word: ok', {
      surface: 'voice-name-resolver-preflight',
      silent: true,
      maxTokens: 8,
    });
    ok = Boolean(out && String(out.text || '').trim());
  } catch {
    ok = false;
  }
  if (ok) return { ok: true };
  return {
    ok: false,
    status: {
      phase: 'aborted_failed_preflight',
      failed_preflight: true,
      reason:
        'LLM ladder preflight failed on all rungs (codex + claude + paid floor); aborting name-judge fan-out before burning the night',
    },
  };
}

function summarizeResult(file) {
  const data = readJson(file, {});
  const targets = data?.judged?.targets || [];
  const calibration = data?.calibration || [];
  return {
    generated_at: data.generated_at || '',
    judged_targets: targets.map((row) => ({
      target: row.target,
      best_name: row.best_name || null,
      confidence: row.confidence || null,
      clear_evidence_count: row.clear_evidence_count || 0,
      counterevidence_count: row.counterevidence_count || 0,
    })),
    calibration: calibration.map((row) => ({
      target: row.target,
      expected: row.expected,
      actual: row.actual,
      pass: row.pass,
      outcome: row.outcome,
    })),
  };
}

function writeStatus(state) {
  saveJson(STATUS_PATH, {
    schema: 'life_archive.voice_identity_overnight_name_resolver.v1',
    updated_at: new Date().toISOString(),
    pid: process.pid,
    ...state,
  });
}

function runOne(task, index, total) {
  return new Promise((resolve) => {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const outFile = path.join(
      LOG_DIR,
      `${String(index + 1).padStart(3, '0')}-${task.kind}-${slug(task.target)}.out.log`,
    );
    const errFile = path.join(
      LOG_DIR,
      `${String(index + 1).padStart(3, '0')}-${task.kind}-${slug(task.target)}.err.log`,
    );
    const out = fs.createWriteStream(outFile, { flags: 'w' });
    const err = fs.createWriteStream(errFile, { flags: 'w' });
    const started = new Date().toISOString();
    const child = spawn(process.execPath, childArgs(task), {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        SKIP_EC2_PUBLISH: '1',
      },
    });
    child.stdout.pipe(out);
    child.stderr.pipe(err);
    child.on('close', (code) => {
      out.end();
      err.end();
      resolve({
        ...task,
        target_count: Array.isArray(task.targets) ? task.targets.length : 1,
        index,
        total,
        started_at: started,
        finished_at: new Date().toISOString(),
        exit_code: code,
        ok: code === 0,
        stdout_log: path.relative(ROOT, outFile).replace(/\\/g, '/'),
        stderr_log: path.relative(ROOT, errFile).replace(/\\/g, '/'),
      });
    });
  });
}

async function runRefreshSteps(state) {
  const steps = [
    ['speaker_pareto', ['scripts/otter-speaker-pareto-report.js']],
    ['voice_queue', ['scripts/voice-confirmation-queue-build.js', '--write']],
    [
      'speaker_people_sync',
      ['scripts/sync-otter-speaker-intelligence-to-people-files.js', '--write'],
    ],
    [
      'voiceprint_people_sync',
      ['scripts/sync-voiceprints-to-people-files.js', '--write', '--all-contacts', '--json'],
    ],
    ['briefing_refresh', ['scripts/refresh-briefing-generated-sections.js', '--skip-gate']],
  ];
  const results = [];
  for (const [label, args] of steps) {
    writeStatus({ ...state, phase: `refresh_${label}`, refresh_results: results });
    const result = await new Promise((resolve) => {
      const outFile = path.join(LOG_DIR, `refresh-${label}.out.log`);
      const errFile = path.join(LOG_DIR, `refresh-${label}.err.log`);
      const out = fs.createWriteStream(outFile, { flags: 'w' });
      const err = fs.createWriteStream(errFile, { flags: 'w' });
      const child = spawn(process.execPath, args, {
        cwd: ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          SKIP_EC2_PUBLISH: hasArg('--no-publish') ? '1' : process.env.SKIP_EC2_PUBLISH || '0',
        },
      });
      child.stdout.pipe(out);
      child.stderr.pipe(err);
      child.on('close', (code) => {
        out.end();
        err.end();
        resolve({
          label,
          ok: code === 0,
          exit_code: code,
          stdout_log: path.relative(ROOT, outFile).replace(/\\/g, '/'),
          stderr_log: path.relative(ROOT, errFile).replace(/\\/g, '/'),
        });
      });
    });
    results.push(result);
    if (!result.ok) break;
  }
  return results;
}

function runCalibrationGate(state) {
  writeStatus({ ...state, phase: 'calibration_gate' });
  const outFile = path.join(LOG_DIR, 'calibration-gate.out.log');
  const errFile = path.join(LOG_DIR, 'calibration-gate.err.log');
  const out = fs.openSync(outFile, 'w');
  const err = fs.openSync(errFile, 'w');
  const child = spawn(
    process.execPath,
    ['scripts/voice-name-calibration-gate.js', '--write-quarantine'],
    {
      cwd: ROOT,
      stdio: ['ignore', out, err],
      env: { ...process.env },
    },
  );
  return new Promise((resolve) => {
    child.on('close', (code) => {
      fs.closeSync(out);
      fs.closeSync(err);
      const gate = readJson(path.join(VP_DIR, 'voice-name-calibration-gate-latest.json'), {});
      resolve({
        ok: code === 0 && !Number(gate.blocker_count || 0),
        exit_code: code,
        blocker_count: Number(gate.blocker_count || 0),
        warning_count: Number(gate.warning_count || 0),
        automatic_identity_acceptance: gate.automatic_identity_acceptance || 'ExampleCo',
        quarantined_enrollment_ids: gate.quarantined_enrollment_ids || [],
        stdout_log: path.relative(ROOT, outFile).replace(/\\/g, '/'),
        stderr_log: path.relative(ROOT, errFile).replace(/\\/g, '/'),
      });
    });
  });
}

async function main() {
  // Abort the whole fan-out when no LLM rung is reachable; every judge
  // child would fail anyway. failed_preflight:true lands in the status JSON.
  const preflight = await runLadderPreflight();
  if (!preflight.ok) {
    writeStatus(preflight.status);
    console.error('[name-resolver] LLM ladder preflight failed on all rungs; aborting fan-out');
    process.exit(1);
  }
  const all = taskList();
  const previous = loadExistingStatus();
  const completedKeys = new Set(
    hasArg('--resume')
      ? (previous.results || []).filter((row) => row.ok).map((row) => `${row.kind}:${row.target}`)
      : [],
  );
  if (hasArg('--resume-existing')) {
    for (const key of existingJudgeTargetKeys()) completedKeys.add(key);
  }
  const rawTasks = all.filter((task) => !completedKeys.has(`${task.kind}:${task.target}`));
  const precompletedTargets = all.length - rawTasks.length;
  const groupSize = Math.max(1, Number(arg('--group-size', '1')) || 1);
  const tasks = [];
  for (let i = 0; i < rawTasks.length; ) {
    const task = rawTasks[i];
    if (groupSize > 1 && task.kind === 'ExampleCo') {
      const group = rawTasks.slice(i, i + groupSize).filter((row) => row.kind === 'ExampleCo');
      tasks.push({
        kind: 'ExampleCo',
        target: group.map((row) => row.target).join(','),
        display_name: `${group.length} ExampleCo acoustic identities`,
        calls: group.reduce((sum, row) => sum + Number(row.calls || 0), 0),
        words: group.reduce((sum, row) => sum + Number(row.words || 0), 0),
        segments: group.reduce((sum, row) => sum + Number(row.segments || 0), 0),
        priority: group[0]?.priority || 0,
        targets: group,
      });
      i += group.length;
      continue;
    }
    tasks.push(task);
    i += 1;
  }
  const concurrency = Math.max(1, Number(arg('--concurrency', '2')) || 2);
  const results =
    previous.results && hasArg('--resume') ? previous.results.filter((row) => row.ok) : [];
  const stateBase = {
    phase: 'running_name_judges',
    started_at: previous.started_at || new Date().toISOString(),
    total_targets: all.length,
    pending_targets: rawTasks.length,
    pending_task_groups: tasks.length,
    precompleted_targets: precompletedTargets,
    completed_targets:
      precompletedTargets + results.reduce((sum, row) => sum + Number(row.target_count || 1), 0),
    concurrency,
    policy: {
      grouping: 'acoustic target identity only; whole calls are context, not named entities',
      naming:
        'heard-name family from marked target scenes; people-file linking is downstream/manual unless strict confirmed voiceprint proves identity',
    },
  };
  writeStatus({ ...stateBase, results });
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (cursor < tasks.length) {
      const taskIndex = cursor;
      const task = tasks[cursor++];
      writeStatus({
        ...stateBase,
        phase: 'running_name_judges',
        active_target: task,
        completed_targets:
          precompletedTargets +
          results.reduce((sum, row) => sum + Number(row.target_count || 1), 0),
        results,
      });
      const result = await runOne(task, taskIndex, tasks.length);
      results.push(result);
      writeStatus({
        ...stateBase,
        phase: 'running_name_judges',
        completed_targets:
          precompletedTargets +
          results.reduce((sum, row) => sum + Number(row.target_count || 1), 0),
        last_result: result,
        results,
      });
    }
  });
  await Promise.all(workers);
  const finalState = {
    ...stateBase,
    phase: 'name_judges_completed',
    completed_targets:
      precompletedTargets + results.reduce((sum, row) => sum + Number(row.target_count || 1), 0),
    failed_targets: results.filter((row) => !row.ok).length,
    results,
  };
  writeStatus(finalState);
  const calibrationGate = await runCalibrationGate(finalState);
  const refreshResults = hasArg('--no-refresh') ? [] : await runRefreshSteps(finalState);
  writeStatus({
    ...finalState,
    calibration_gate: calibrationGate,
    phase:
      refreshResults.length && refreshResults.every((row) => row.ok)
        ? 'completed'
        : 'completed_with_refresh_warning',
    refresh_results: refreshResults,
  });
  process.stdout.write(`${JSON.stringify(readJson(STATUS_PATH, {}), null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    writeStatus({
      phase: 'failed',
      error: error && error.stack ? error.stack : String(error),
    });
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
  });
}

module.exports = { runLadderPreflight };
