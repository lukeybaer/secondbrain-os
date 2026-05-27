#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const REPO = process.env.SECONDBRAIN_ROOT || path.resolve(__dirname, '..');
const LOG_DIR = path.join(REPO, 'data', 'agent');
const LOG_PATH = path.join(LOG_DIR, 'overnight-briefing-orchestrator.jsonl');
const DEFAULT_DEADLINE = '05:20';

function todayCt() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

function argValue(name) {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  const pref = `${name}=`;
  const hit = process.argv.find((a) => a.startsWith(pref));
  return hit ? hit.slice(pref.length) : null;
}

function log(row) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.appendFileSync(LOG_PATH, JSON.stringify({ ts: new Date().toISOString(), ...row }) + '\n');
}

function freshFile(rel, maxAgeMinutes) {
  const p = path.join(REPO, rel);
  try {
    const st = fs.statSync(p);
    return (Date.now() - st.mtimeMs) <= maxAgeMinutes * 60 * 1000;
  } catch {
    return false;
  }
}

function runStep(name, cmd, args, options = {}) {
  const started = Date.now();
  log({ event: 'step-start', name, cmd, args });
  const result = spawnSync(cmd, args, {
    cwd: REPO,
    encoding: 'utf8',
    timeout: options.timeoutMs || 15 * 60 * 1000,
    env: { ...process.env, ...(options.env || {}) },
  });
  const durationMs = Date.now() - started;
  const ok = result.status === 0;
  log({
    event: 'step-finish',
    name,
    ok,
    status: result.status,
    durationMs,
    stdout: String(result.stdout || '').slice(-4000),
    stderr: String(result.stderr || '').slice(-4000),
  });
  return { name, ok, status: result.status, durationMs, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function runStepAsync(name, cmd, args, options = {}) {
  const started = Date.now();
  log({ event: 'step-start', name, cmd, args, parallel: true });
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: REPO,
      windowsHide: true,
      env: { ...process.env, ...(options.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const limit = 24000;
    const trim = (s) => (s.length > limit ? s.slice(-limit) : s);
    child.stdout.on('data', (chunk) => { stdout = trim(stdout + chunk.toString()); });
    child.stderr.on('data', (chunk) => { stderr = trim(stderr + chunk.toString()); });
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
    }, options.timeoutMs || 15 * 60 * 1000);
    child.on('close', (status) => {
      clearTimeout(timer);
      const durationMs = Date.now() - started;
      const ok = status === 0 && !killed;
      log({
        event: 'step-finish',
        name,
        ok,
        status,
        killed,
        durationMs,
        stdout: stdout.slice(-4000),
        stderr: stderr.slice(-4000),
      });
      resolve({ name, ok, status, killed, durationMs, stdout, stderr });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      const durationMs = Date.now() - started;
      log({ event: 'step-finish', name, ok: false, status: null, durationMs, stderr: error.message });
      resolve({ name, ok: false, status: null, durationMs, stdout, stderr: error.message });
    });
  });
}

function validate(date) {
  const result = runStep('qc-validate', process.execPath, ['scripts/validate-briefing-quality.js', '--date', date, '--json'], { timeoutMs: 8 * 60 * 1000 });
  let parsed = null;
  try { parsed = JSON.parse(result.stdout); } catch { parsed = null; }
  return { ...result, parsed, failures: parsed && Array.isArray(parsed.failures) ? parsed.failures : [] };
}

function refreshLive(date, mode, reason) {
  const result = refresh(date, mode);
  const validation = validate(date);
  log({ event: 'live-refresh', date, reason, refreshOk: result.ok, failureCount: validation.failures.length, failures: validation.failures });
  return { result, validation };
}

function classifyFailure(failure) {
  const s = String(failure || '').toLowerCase();
  if (s.includes('shorts')) return 'shorts';
  if (s.includes('viral')) return 'viral';
  if (s.includes('mortgage')) return 'mortgage-rates';
  if (s.includes('token')) return 'token-usage';
  if (s.includes('feature backlog')) return 'feature-backlog';
  if (s.includes('linkedin')) return 'linkedin';
  if (s.includes('action') || s.includes('gmail')) return 'action-items';
  if (s.includes('system health') || s.includes('tests')) return 'system-health';
  if (s.includes('video')) return 'video-approval';
  return 'generated-sections';
}

function uniqueOwners(failures) {
  return Array.from(new Set((failures || []).map(classifyFailure)));
}

function repairOwner(owner, date) {
  switch (owner) {
    case 'shorts':
      return runStep('repair-shorts', process.execPath, ['scripts/morning-shorts-proposals.js', '--date', date, '--force'], { timeoutMs: 20 * 60 * 1000 });
    case 'viral':
      return runStep('repair-viral-clips', process.execPath, ['scripts/viral-tech-clip-proposals.js', '--date', date, '--force'], { timeoutMs: 12 * 60 * 1000 });
    case 'mortgage-rates':
      return runStep('repair-mortgage-rates', process.execPath, ['scripts/mortgage-rate-indexes.js', '--date', date], { timeoutMs: 8 * 60 * 1000 });
    case 'token-usage':
      runStep('repair-token-collector', process.execPath, ['scripts/collect-daily-token-usage.js'], { timeoutMs: 10 * 60 * 1000 });
      return runStep('repair-token-suggestion', process.execPath, ['scripts/suggest-token-reduction.js'], { timeoutMs: 8 * 60 * 1000 });
    case 'feature-backlog':
      return runStep('repair-generated-sections-feature-backlog', process.execPath, ['scripts/refresh-briefing-generated-sections.js', '--date', date, '--mode', 'overnight'], { timeoutMs: 15 * 60 * 1000 });
    case 'linkedin':
      return runStep('repair-linkedin-qc', process.execPath, ['scripts/linkedin-outreach-qc.js'], { timeoutMs: 8 * 60 * 1000 });
    case 'system-health':
      return runStep('repair-health-self-heal', 'cmd.exe', ['/c', 'scripts\\health-self-heal.bat'], { timeoutMs: 15 * 60 * 1000 });
    case 'action-items':
      return runStep('repair-action-items', process.execPath, ['scripts/regenerate-action-items.js', '--date', date], { timeoutMs: 12 * 60 * 1000 });
    case 'video-approval':
      return runStep('repair-video-rejection-artifacts', process.execPath, ['scripts/verify-rejection-tokens-in-artifact.js'], { timeoutMs: 8 * 60 * 1000 });
    default:
      return runStep('repair-generated-sections', process.execPath, ['scripts/refresh-briefing-generated-sections.js', '--date', date, '--mode', 'overnight'], { timeoutMs: 15 * 60 * 1000 });
  }
}

async function repairOwnerAsync(owner, date, mode) {
  switch (owner) {
    case 'shorts':
      return runStepAsync('repair-shorts', process.execPath, ['scripts/morning-shorts-proposals.js', '--date', date, '--force'], { timeoutMs: 20 * 60 * 1000 });
    case 'viral':
      return runStepAsync('repair-viral-clips', process.execPath, ['scripts/viral-tech-clip-proposals.js', '--date', date, '--force'], { timeoutMs: 12 * 60 * 1000 });
    case 'mortgage-rates':
      return runStepAsync('repair-mortgage-rates', process.execPath, ['scripts/mortgage-rate-indexes.js', '--date', date], { timeoutMs: 8 * 60 * 1000 });
    case 'token-usage':
      await runStepAsync('repair-token-collector', process.execPath, ['scripts/collect-daily-token-usage.js'], { timeoutMs: 10 * 60 * 1000 });
      return runStepAsync('repair-token-suggestion', process.execPath, ['scripts/suggest-token-reduction.js'], { timeoutMs: 8 * 60 * 1000 });
    case 'feature-backlog':
      return runStepAsync('repair-generated-sections-feature-backlog', process.execPath, ['scripts/refresh-briefing-generated-sections.js', '--date', date, '--mode', mode || 'overnight'], { timeoutMs: 15 * 60 * 1000 });
    case 'linkedin':
      return runStepAsync('repair-linkedin-qc', process.execPath, ['scripts/linkedin-outreach-qc.js'], { timeoutMs: 8 * 60 * 1000 });
    case 'system-health':
      return runStepAsync('repair-health-self-heal', 'cmd.exe', ['/c', 'scripts\\health-self-heal.bat'], { timeoutMs: 15 * 60 * 1000 });
    case 'action-items':
      return runStepAsync('repair-action-items', process.execPath, ['scripts/regenerate-action-items.js', '--date', date], { timeoutMs: 12 * 60 * 1000 });
    case 'video-approval':
      return runStepAsync('repair-video-rejection-artifacts', process.execPath, ['scripts/verify-rejection-tokens-in-artifact.js'], { timeoutMs: 8 * 60 * 1000 });
    default:
      return runStepAsync('repair-generated-sections', process.execPath, ['scripts/refresh-briefing-generated-sections.js', '--date', date, '--mode', mode || 'overnight'], { timeoutMs: 15 * 60 * 1000 });
  }
}

function render(date, mode) {
  return runStep('render-briefing', process.execPath, ['scripts/manual-briefing-v3.js'], {
    timeoutMs: 90 * 60 * 1000,
    env: { BRIEFING_MODE: mode || 'overnight', BRIEFING_DATE: date },
  });
}

function refresh(date, mode) {
  return runStep('refresh-generated-sections', process.execPath, ['scripts/refresh-briefing-generated-sections.js', '--date', date, '--mode', mode || 'overnight'], {
    timeoutMs: 20 * 60 * 1000,
  });
}

async function main() {
  const date = argValue('--date') || todayCt();
  const mode = String(argValue('--mode') || process.env.BRIEFING_MODE || 'overnight').toLowerCase();
  const maxLoops = Number(argValue('--max-loops') || process.env.BRIEFING_QC_MAX_LOOPS || 6);
  const fullRender = process.argv.includes('--full-render') || process.env.BRIEFING_FULL_RENDER === '1';
  const briefingMd = path.join(REPO, 'data', 'briefings', `briefing-${date}.md`);
  const started = Date.now();
  log({
    event: 'orchestrator-start',
    date,
    mode,
    deadlineCt: argValue('--deadline') || DEFAULT_DEADLINE,
    method: 'parallel card workers feed a QC-owned blockers loop; manual briefing is renderer/publisher, not the only repair loop',
  });

  if (freshFile(`data/agent/pre-briefing-diagnostic-${date}.json`, 8 * 60)) {
    log({ event: 'step-skip', name: 'preflight-diagnostic', reason: 'fresh diagnostic artifact already exists for date' });
  } else {
    runStep('preflight-diagnostic', process.execPath, ['scripts/pre-briefing-diagnostic.js'], { timeoutMs: 3 * 60 * 1000 });
  }
  const workers = [
    ['action-items', process.execPath, ['scripts/regenerate-action-items.js', '--date', date], 12 * 60 * 1000],
    ['shorts', process.execPath, ['scripts/morning-shorts-proposals.js', '--date', date, '--force'], 20 * 60 * 1000],
    ['viral-clips', process.execPath, ['scripts/viral-tech-clip-proposals.js', '--date', date, '--force'], 12 * 60 * 1000],
    ['mortgage-rates', process.execPath, ['scripts/mortgage-rate-indexes.js', '--date', date], 8 * 60 * 1000],
    ['token-collector', process.execPath, ['scripts/collect-daily-token-usage.js'], 10 * 60 * 1000],
    // 2026-05-25 Luke: Codex subscription burn must be on the token usage
    // card next to Claude Max. This collector reads ~/.codex/sessions/
    // rollouts and emits data/agent/codex-token-usage-week.json that
    // refresh-briefing-generated-sections.js's renderTokenUsageSection
    // reads to render the Codex (pro) row.
    ['codex-token-collector', process.execPath, ['scripts/collect-codex-token-usage.js'], 5 * 60 * 1000],
    // 2026-05-25 Luke: Claude Max subscription burn must match what
    // claude.ai/settings/usage shows (24% week, not my 46% derived
    // estimate). This collector hits /api/oauth/usage with the same
    // OAuth token the CLI uses and emits data/agent/claude-plan-usage.
    // json with authoritative percents.
    ['claude-plan-usage-collector', process.execPath, ['scripts/collect-claude-plan-usage.js'], 3 * 60 * 1000],
  ];
  await Promise.all(workers.map(async ([name, cmd, args, timeoutMs]) => {
    const result = await runStepAsync(`card-worker-${name}`, cmd, args, { timeoutMs });
    refreshLive(date, mode, `card-worker-${name}-${result.ok ? 'passed' : 'finished-blocked'}`);
    return result;
  }));
  runStep('token-suggestion', process.execPath, ['scripts/suggest-token-reduction.js'], { timeoutMs: 8 * 60 * 1000 });
  refreshLive(date, mode, 'token-suggestion-finished');

  if (fullRender || !fs.existsSync(briefingMd)) {
    render(date, mode);
    refreshLive(date, mode, 'post-render');
  } else {
    log({ event: 'step-skip', name: 'render-briefing', reason: 'live card refresh already published; pass --full-render to force a complete manual render' });
  }

  let lastValidation = validate(date);
  for (let loop = 1; loop <= maxLoops && lastValidation.failures.length > 0; loop += 1) {
    const owners = uniqueOwners(lastValidation.failures);
    log({ event: 'qc-loop', loop, failures: lastValidation.failures, owners });
    await Promise.all(owners.map((owner) => repairOwnerAsync(owner, date, mode)));
    refresh(date, mode);
    lastValidation = validate(date);
  }

  const durationMs = Date.now() - started;
  log({
    event: 'orchestrator-finish',
    date,
    ok: lastValidation.failures.length === 0,
    failureCount: lastValidation.failures.length,
    failures: lastValidation.failures,
    durationMs,
  });
  if (lastValidation.failures.length > 0) {
    console.error(`[overnight-briefing-orchestrator] BLOCKED ${date}: ${lastValidation.failures.length} validator failure(s) after ${Math.round(durationMs / 1000)}s`);
    for (const failure of lastValidation.failures) console.error('- ' + failure);
    process.exit(1);
  }
  console.log(`[overnight-briefing-orchestrator] CLEAN ${date} in ${Math.round(durationMs / 1000)}s`);
}

if (require.main === module) {
  main().catch((error) => {
    log({ event: 'orchestrator-crash', error: error && error.stack ? error.stack : String(error) });
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
  });
}

module.exports = {
  classifyFailure,
  runStepAsync,
  uniqueOwners,
};
