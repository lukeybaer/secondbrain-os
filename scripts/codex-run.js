#!/usr/bin/env node
/**
 * codex-run.js, supervised fresh phases and model-free operations.
 *
 * Why this exists: the `codex:codex-rescue` subagent runs the companion's `task`
 * command FOREGROUND inside a backgrounded Bash call. When the ephemeral
 * subagent returns its stub, the Codex worker (a child of that Bash process) is
 * torn down mid-run, so the job is orphaned as status:"running" forever and the
 * review/result is never delivered. Observed 2026-06-02: three reviews all
 * stuck "running", their worker pids dead, logs cut off mid-tool-call.
 *
 * Ordinary positional/prompt-file callers now enter the same phase supervisor
 * as explicit plans. The historical companion helpers remain exported for
 * compatibility; the active main path does not dispatch or poll the companion.
 *
 * Usage:
 *   node scripts/codex-run.js [--read-only] [--timeout-min N] [--effort E] "<prompt>"
 *   node scripts/codex-run.js --prompt-file path/to/prompt.txt
 *   node scripts/codex-run.js --read-only --context-file work/unit.json --complexity routine
 *   Scoped packets require objective, scope, requirements, currentEvidence and
 *   acceptance (text or text arrays); optional unitId, priorCheckpoint, nonGoals.
 *   --receipt-dir chooses durable output storage; defaults beside companion jobs.
 *
 * Notes:
 *  - Do NOT pass --effort minimal: it is incompatible with the web_search and
 *    image_gen tools the task enables (Codex returns a 400).
 *  - Default is write-capable (matches the rescue contract). Pass --read-only
 *    for review/diagnosis with no edits.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { withCodexAmyPrelude } = require('./lib/codex-amy-prelude.js');
const {
  BRIEFING_CODEX_CEILING,
  decideSpawnModel,
  codexExecPins,
} = require('./lib/model-router.js');
const { buildScopedExecutionContext, persistBriefingModelContextReceipt, executionPhaseMetadata } = require('./lib/briefing-model-context.js');
const { buildCodexCliEnv, isCliFailureOutput } = require('./lib/cli-output-guard.js');
const { ensureCodexWorktree } = require('./lib/codex-worktree.js');
const { resolveDirectCodex } = require('./lib/codex-executable.js');

const PLUGIN_ROOT =
  process.env.CODEX_PLUGIN_ROOT ||
  path.join(os.homedir(), '.claude', 'plugins', 'cache', 'openai-codex', 'codex', '1.0.4');
const COMPANION = path.join(PLUGIN_ROOT, 'scripts', 'codex-companion.mjs');
const STATE_LIB = path.join(PLUGIN_ROOT, 'scripts', 'lib', 'state.mjs');

const TERMINAL = new Set(['succeeded', 'completed', 'done', 'failed', 'error', 'cancelled', 'canceled']);

// Pure: pull the task job id out of the companion's "started in the background
// as <id>" launch line. Exported for tests.
function parseJobId(launchOutput) {
  const m = String(launchOutput || '').match(/\btask-[a-z0-9]+-[a-z0-9]+\b/i);
  return m ? m[0] : null;
}

// Pure: is a job status terminal (stop polling)? Exported for tests.
function isTerminalStatus(status) {
  return TERMINAL.has(String(status || '').toLowerCase());
}

function companion(args, timeoutMs = 120000, outputFiles = null) {
  const descriptors = outputFiles ? outputFiles.map((file) => fs.openSync(file, 'w')) : [];
  try {
    return spawnSync(process.execPath, [COMPANION, ...args], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: outputFiles ? ['ignore', ...descriptors] : ['ignore', 'pipe', 'pipe'],
    });
  } finally {
    descriptors.forEach((fd) => fs.closeSync(fd));
  }
}

function companionSupportsPromptFile(companionPath = COMPANION) {
  try {
    return /\bprompt-file\b/.test(fs.readFileSync(companionPath, 'utf8'));
  } catch {
    return false;
  }
}

function normalizeCliPath(p) {
  return String(p || '').replace(/\\/g, '/');
}

function registerPromptFileCleanup(promptFile, proc = process) {
  let cleaned = false;
  const cleanupPromptFile = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      fs.unlinkSync(promptFile);
    } catch {
      /* already gone */
    }
  };
  proc.once('exit', cleanupPromptFile);
  proc.once('SIGINT', () => {
    cleanupPromptFile();
    proc.exit(130);
  });
  proc.once('SIGTERM', () => {
    cleanupPromptFile();
    proc.exit(143);
  });
  return cleanupPromptFile;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM'; // exists but not signalable
  }
}

function parseArgs(argv) {
  const opts = { readOnly: false, timeoutMin: 20, effort: null, prompt: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const valued = ['--timeout-min', '--effort', '--complexity', '--complexity-reason', '--phase', '--context-file', '--operation-file', '--plan-file', '--cwd', '--resume', '--retry-stage', '--retry-reason', '--receipt-dir', '--prompt-file'];
    if (valued.includes(a) && (!argv[i + 1] || argv[i + 1].startsWith('--'))) throw new Error(`${a} requires a value`);
    if (a === '--read-only') opts.readOnly = true;
    else if (a === '--timeout-min') {
      opts.timeoutMin = Number(argv[++i]);
      if (!Number.isFinite(opts.timeoutMin) || opts.timeoutMin <= 0) throw new Error('--timeout-min requires a positive number');
    }
    else if (a === '--effort') opts.effort = argv[++i];
    else if (a === '--complexity') opts.complexity = argv[++i];
    else if (a === '--complexity-reason') opts.complexityReason = argv[++i];
    else if (a === '--context-file') opts.contextFile = argv[++i];
    else if (a === '--operation-file') opts.operationFile = argv[++i];
    else if (a === '--plan-file') opts.planFile = argv[++i];
    else if (a === '--cwd') opts.cwd = argv[++i];
    else if (a === '--resume') opts.resumePath = argv[++i];
    else if (a === '--retry-stage') opts.retryStageId = argv[++i];
    else if (a === '--retry-reason') opts.retryReason = argv[++i];
    else if (a === '--phase') opts.phase = argv[++i];
    else if (a === '--receipt-dir') opts.receiptDir = argv[++i];
    else if (a === '--prompt-file') opts.prompt = fs.readFileSync(argv[++i], 'utf8');
    else if (a.startsWith('--')) throw new Error(`Unknown option ${a}`);
    else rest.push(a);
  }
  if (opts.prompt && rest.length) throw new Error('Use either --prompt-file or a positional prompt');
  if (!opts.prompt) opts.prompt = rest.join(' ');
  if (opts.contextFile && !opts.complexity) opts.complexity = 'routine';
  if (opts.contextFile && opts.prompt) throw new Error('Use either --context-file or a prompt; place the full scoped objective in the packet.');
  if (opts.complexity && !['routine', 'complex', 'critical'].includes(opts.complexity)) {
    throw new Error('--complexity must be routine, complex, or critical');
  }
  if (opts.complexity && opts.complexity !== 'routine' && !String(opts.complexityReason || '').trim()) {
    throw new Error('--complexity-reason is required for complex or critical work');
  }
  if (opts.phase) executionPhaseMetadata({ phase: opts.phase });
  if (opts.effort && !['low', 'medium', 'high', 'xhigh'].includes(opts.effort)) throw new Error('--effort must be low, medium, high, or xhigh');
  // Night-marker gates. Since 2026-09-24 the overnight cloud-cron scheduled
  // fleet also carries the marker (scripts/lib/cloud-scheduled-fleet.js), so a
  // fleet skill that passed --effort high/xhigh or --operation-file would fail
  // here. None does; overnight-model-profile.test.js keeps it that way.
  if (
    opts.effort &&
    String(process.env.SECONDBRAIN_BRIEFING_CODEX_CEILING || '').trim().toLowerCase() === BRIEFING_CODEX_CEILING &&
    !['low', 'medium'].includes(opts.effort)
  ) {
    throw new Error(`--effort ${opts.effort} exceeds the active briefing ceiling (${BRIEFING_CODEX_CEILING})`);
  }
  if (
    opts.operationFile &&
    String(process.env.SECONDBRAIN_BRIEFING_CODEX_CEILING || '').trim().toLowerCase() === BRIEFING_CODEX_CEILING
  ) {
    throw new Error('--operation-file is disabled under the active briefing ceiling because worker-authored operation stages are not a model-safe execution boundary');
  }
  if (opts.contextFile && opts.effort) throw new Error('Scoped execution derives effort from complexity; remove --effort');
  if (opts.operationFile && (opts.contextFile || opts.prompt || opts.complexity || opts.effort || opts.phase || opts.readOnly)) {
    throw new Error('--operation-file cannot be combined with model or prompt options');
  }
  if (opts.planFile && (opts.operationFile || opts.contextFile || opts.prompt || opts.complexity || opts.effort || opts.phase)) throw new Error('--plan-file owns its phases and cannot combine with other model input');
  if (opts.resumePath && !opts.planFile && !opts.operationFile) throw new Error('--resume requires the exact --plan-file or --operation-file');
  if (opts.retryStageId || opts.retryReason) {
    if (!opts.operationFile || !opts.resumePath || !opts.retryStageId || !opts.retryReason) throw new Error('Retry requires --operation-file, --resume, --retry-stage and --retry-reason');
    opts.retryStage = { id: opts.retryStageId, reason: opts.retryReason };
  }
  if (opts.cwd && (!path.isAbsolute(opts.cwd) || !fs.statSync(opts.cwd).isDirectory())) throw new Error('--cwd requires an existing absolute directory');
  if (opts.operationFile && opts.cwd) throw new Error('An operation packet owns its cwd; do not also pass --cwd');
  return opts;
}

// Include complete small outputs only. A large result/error is never silently
// chopped mid-diagnostic; its full durable path is the next retrieval target.
function completeOutputExcerpt(file, maxBytes = 4096) {
  const bytes = fs.statSync(file).size;
  return { path: file, bytes, text: bytes <= maxBytes ? fs.readFileSync(file, 'utf8') : null,
    nextAction: bytes > maxBytes ? `Read the relevant complete result or error from ${file}` : null };
}

function persistOutcomeReceipt({ runDir, jobId = null, status, jobFile = null, contextReceipt, launchArgs, result = null, cwd = process.cwd(), transport = 'companion', deliveredPromptBytes = null, executable = null }) {
  const receipt = {
    schemaVersion: 1, recordedAt: new Date().toISOString(), jobId, status,
    // Companion completion proves process termination, not the user's acceptance.
    acceptanceStatus: 'unverified',
    nextAction: status === 'succeeded' || status === 'completed' || status === 'done'
      ? 'Verify the result against every packet acceptance check; resume any remaining work.'
      : 'Inspect the job and complete error output, reconcile current state, then resume this unit.',
    jobFile, cwd, transport, executable, deliveredPromptBytes, contextReceipt: contextReceipt && contextReceipt.path,
    launchArgs, retrievalExitCode: result ? result.status : null,
    execution: contextReceipt && contextReceipt.execution || null,
    checkpointPath: fs.existsSync(path.join(runDir, 'checkpoint.json')) ? path.join(runDir, 'checkpoint.json') : null,
    retrievalError: result && result.error ? result.error.message : null,
    outputs: ['launch.stdout.txt', 'launch.stderr.txt', 'result.stdout.txt', 'result.stderr.txt', 'answer.txt', 'events.jsonl']
      .map((name) => path.join(runDir, name)).filter((file) => fs.existsSync(file))
      .map((file) => completeOutputExcerpt(file, path.basename(file) === 'events.jsonl' ? 0 : 4096)),
  };
  const receiptPath = path.join(runDir, 'outcome.json');
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  return { ...receipt, receiptPath };
}

// Deterministic operations use the existing runner/receipt boundary, with no
// model dispatch and no model status turns. This command's exit is evidence of
// process completion only; the owner still checks the unit's acceptance.
function runOperation(packet, opts = {}, { spawnSyncFn = spawnSync } = {}) {
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)) throw new Error('operation must be a JSON object');
  for (const field of ['unitId', 'objective', 'command', 'cwd']) {
    if (typeof packet[field] !== 'string' || !packet[field].trim()) throw new Error(`operation ${field} requires text`);
  }
  if (!Array.isArray(packet.args) || !packet.args.every((arg) => typeof arg === 'string')) throw new Error('operation args requires an array of strings');
  if (!(typeof packet.acceptance === 'string' && packet.acceptance.trim()) &&
      !(Array.isArray(packet.acceptance) && packet.acceptance.length && packet.acceptance.every((item) => typeof item === 'string' && item.trim()))) throw new Error('operation acceptance requires nonempty text or text array');
  if (!path.isAbsolute(packet.cwd) || !fs.statSync(packet.cwd).isDirectory()) throw new Error('operation cwd requires an existing absolute directory');
  const execution = { ...executionPhaseMetadata({ ...packet, phase: 'operations', complexity: 'routine' }), model: null, effort: null, modelCalls: 0 };
  const receiptRoot = opts.receiptDir ? path.resolve(opts.receiptDir) : path.join(os.homedir(), '.codex', 'codex-run-receipts');
  fs.mkdirSync(receiptRoot, { recursive: true });
  const runDir = fs.mkdtempSync(path.join(receiptRoot, 'operation-'));
  const eventFile = path.join(runDir, 'events.jsonl');
  const event = (type, detail = {}) => fs.appendFileSync(eventFile, JSON.stringify({ type, recordedAt: new Date().toISOString(), unitId: packet.unitId, ...detail }) + '\n');
  const continuation = { unitId: packet.unitId, objective: packet.objective, acceptance: packet.acceptance,
    priorCheckpoint: packet.priorCheckpoint || null, nextAction: 'Inspect complete output and verify this unit acceptance; preserve any remaining work.' };
  fs.writeFileSync(path.join(runDir, 'checkpoint.json'), JSON.stringify(continuation, null, 2) + '\n');
  event('operation-started', { command: packet.command, args: packet.args, cwd: packet.cwd, modelCalls: 0 });
  const descriptors = ['result.stdout.txt', 'result.stderr.txt'].map((name) => fs.openSync(path.join(runDir, name), 'w'));
  let result;
  try {
    // Deliberately no token/context timeout: wait for actual process completion.
    result = spawnSyncFn(packet.command, packet.args, { cwd: packet.cwd, shell: false,
      windowsHide: true, encoding: 'utf8', stdio: ['ignore', ...descriptors] });
  } catch (error) { result = { status: null, error }; }
  finally { descriptors.forEach((fd) => fs.closeSync(fd)); }
  const status = result.error || result.status !== 0 ? 'failed-unfinished' : 'succeeded';
  event('operation-completed', { status, exitCode: result.status, error: result.error && result.error.message || null, modelCalls: 0 });
  const receipt = persistOutcomeReceipt({ runDir, status, result, cwd: packet.cwd,
    contextReceipt: { execution }, launchArgs: packet.args, executable: { command: packet.command }, transport: 'model-free-operation' });
  receipt.checkpointPath = path.join(runDir, 'checkpoint.json');
  fs.writeFileSync(receipt.receiptPath, JSON.stringify(receipt, null, 2) + '\n');
  return receipt;
}

function buildDirectLaunchArgs(opts, answerFile, routed, platform = process.platform) {
  if (!routed) throw new Error('Scoped CLI launch requires a live model routing decision; resolve shadow routing before retrying.');
  const requestedEffort = opts.effort || routed.effort;
  const ceilingActive = String(process.env.SECONDBRAIN_BRIEFING_CODEX_CEILING || '')
    .trim().toLowerCase() === BRIEFING_CODEX_CEILING;
  const effort = ceilingActive && !['minimal', 'low', 'medium'].includes(requestedEffort)
    ? 'medium'
    : requestedEffort;
  return ['exec', '--skip-git-repo-check', '-s', opts.readOnly ? 'read-only' : 'workspace-write',
    ...codexExecPins({ ...routed, effort }),
    // --ignore-user-config also removes the host's Windows implementation.
    // Preserve the stronger supported sandbox; never downgrade or bypass it.
    ...(platform === 'win32' ? ['-c', 'windows.sandbox="elevated"'] : []),
    '--json', '--output-last-message', answerFile, '-'];
}

function runScopedDirect(opts, context, { spawnSyncFn = spawnSync, resolveExecutable = resolveDirectCodex, ensureWorktree = ensureCodexWorktree, route = decideSpawnModel } = {}) {
  const execution = executionPhaseMetadata(context.execution, opts);
  if (opts.effort || ['phase', 'complexity', 'complexityReason'].some((field) => execution[field] !== context.execution[field])) {
    throw new Error('Rebuild the scoped packet with the requested phase/complexity before launch; its metadata and delivered context must agree');
  }
  const cwd = opts.readOnly ? process.cwd() : ensureWorktree({ repoRoot: process.cwd(), purpose: 'scoped-execution' }).cwd;
  const runDir = path.join(opts.receiptDir ? path.resolve(opts.receiptDir) : path.join(os.homedir(), '.codex', 'codex-run-receipts'), `codex-run-${process.pid}-${Date.now()}`);
  const contextReceipt = persistBriefingModelContextReceipt(context, { dataDir: runDir });
  const contextPath = path.join(runDir, 'phase-context.txt');
  fs.writeFileSync(contextPath, context.prompt, 'utf8');
  fs.writeFileSync(path.join(runDir, 'checkpoint.json'), JSON.stringify({
    unitId: context.execution.unitId, phase: context.execution.phase, contextPath,
    acceptanceStatus: 'unverified',
    nextAction: 'Read this exact phase context and complete result. Verify every acceptance check, then build a fresh same-unit packet with remaining work and changed evidence; do not replay the transcript.',
  }, null, 2) + '\n');
  const routed = route('codex-run', 'codex', {
    taskType: opts.readOnly ? 'review' : 'repair-code', complexity: opts.complexity || context.execution.complexity,
    complexityReason: opts.complexityReason || context.execution.complexityReason,
  });
  const launchArgs = buildDirectLaunchArgs(opts, path.join(runDir, 'answer.txt'), routed);
  const executable = resolveExecutable();
  const deliveredPrompt = withCodexAmyPrelude(context.prompt, { force: true });
  const descriptors = ['events.jsonl', 'result.stderr.txt'].map((name) => fs.openSync(path.join(runDir, name), 'w'));
  let result;
  try {
    result = spawnSyncFn(executable.command, [...executable.prefix, ...launchArgs], {
      cwd, input: deliveredPrompt, encoding: 'utf8',
      timeout: opts.timeoutMin * 60 * 1000, windowsHide: true,
      env: buildCodexCliEnv(process.env), stdio: ['pipe', ...descriptors],
    });
  } finally {
    descriptors.forEach((fd) => fs.closeSync(fd));
  }
  let answer = '';
  try { answer = fs.readFileSync(path.join(runDir, 'answer.txt'), 'utf8').trim(); } catch { /* Missing final answer is failure. */ }
  const status = result.error || result.status !== 0 || !answer || isCliFailureOutput(answer) ? 'failed-unfinished' : 'succeeded';
  return persistOutcomeReceipt({ runDir, status, contextReceipt, launchArgs, result, cwd, transport: 'codex-cli', executable, deliveredPromptBytes: Buffer.byteLength(deliveredPrompt, 'utf8') });
}

// MODEL ROUTING. This wrapper passed no model, so every rescue job inherited
// the account or ~/.codex/config.toml default.
// Classification, honest: this call site DOES carry a complexity signal, so
// nothing is invented. --read-only is the review/diagnosis contract documented
// at the top of this file, which is TASK_TIER 'review'; the write-capable
// default is the "try fixes, second implementation pass" contract, which is
// 'repair-code'. An explicit --effort from the caller is an operator request,
// but the briefing ceiling is applied after that override.
//
// --ignore-user-config is NOT emitted here, and that is deliberate rather than
// an omission: this launches the codex COMPANION, not `codex exec`, and
// --ignore-user-config is a `codex exec` flag whose companion pass-through is
// not verified. An explicit --model plus --effort already overrides the
// config.toml values that leak, which is the actual defect. --model and
// --effort are documented companion flags (memory/reference_codex_plugin_cc.md
// records /codex:rescue [--model <m>] [--effort <e>]); if a future companion
// drops one it will reject the unknown flag loudly at launch rather than
// silently running unpinned.
function buildLaunchArgs(opts, promptFile) {
  const launchArgs = ['task', '--background', '--fresh'];
  if (!opts.readOnly) launchArgs.push('--write');
  const routed = decideSpawnModel('codex-run', 'codex', {
    taskType: opts.readOnly ? 'review' : 'repair-code',
    complexity: opts.complexity,
    complexityReason: opts.complexityReason,
  });
  if (routed) launchArgs.push('--model', routed.model);
  const requestedEffort = opts.effort || (routed ? routed.effort : null);
  const ceilingActive = String(process.env.SECONDBRAIN_BRIEFING_CODEX_CEILING || '')
    .trim().toLowerCase() === BRIEFING_CODEX_CEILING;
  const effort = ceilingActive && !['minimal', 'low', 'medium'].includes(requestedEffort)
    ? 'medium'
    : requestedEffort;
  if (effort) launchArgs.push('--effort', effort);
  launchArgs.push('--prompt-file', normalizeCliPath(promptFile));
  return launchArgs;
}

// All ordinary callers now enter the supervisor. Positional and prompt-file
// callers retain their plain-result stdout contract; receipts/events use disk
// and stderr. No companion polling or optional opt-in is needed.
async function main(argv = process.argv.slice(2), deps = {}) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
    process.stdout.write('Usage: codex-run.js [--read-only] <prompt> | --prompt-file file | --context-file file | --plan-file file [--resume checkpoint] | --operation-file file [--resume checkpoint]\n' +
      'Optional --cwd ABSOLUTE_SOURCE_REPO, --receipt-dir PATH and --timeout-min N (model phase only). Default complexity is routine/low; complex/high and critical/xhigh require --complexity-reason.\n' +
      'Plan: ' + JSON.stringify({ unitId: 'one-task', objective: 'Full owner request', scope: ['owned paths'], requirements: ['applicable constraints'],
        currentEvidence: ['current facts and source paths'], acceptance: ['exact required proof'], phases: [{ id: 'implement', phase: 'implement', complexity: 'routine' }, { id: 'verify', phase: 'verify', complexity: 'routine' }] }) + '\n' +
      'Operation: ' + JSON.stringify({ unitId: 'one-release', objective: 'Authorized release', acceptance: ['exact live proof'], cwd: '/absolute/isolated/worktree',
        stages: [{ id: 'tests', command: 'node', args: ['node_modules/vitest/vitest.mjs', 'run', 'scripts/__tests__/selected.test.js'] },
          { id: 'land', command: 'node', args: ['scripts/land.js', '--apply'] }] }) + '\n' +
      'Declare deploy and live-proof stages explicitly for the requested target. Checkpoints never grant authorization. Receipts/logs remain outside the checkout.\n');
    return 0;
  }
  const opts = parseArgs(argv);
  const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  const onEvent = event => process.stderr.write(JSON.stringify(event) + '\n');
  if (opts.operationFile) {
    const packet = readJson(opts.operationFile);
    const sequence = packet.stages ? packet : { ...packet, stages: [{ id: 'operation', command: packet.command, args: packet.args, cwd: packet.cwd, acceptance: packet.acceptance }] };
    const receipt = await (deps.runOperations || require('./lib/execution-operations').runOperationSequence)(sequence, { ...opts, onEvent });
    process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
    return receipt.status === 'succeeded' ? 0 : 1;
  }
  const { planFromPrompt, runExecutionPlan } = require('./lib/execution-supervisor');
  let plan;
  if (opts.planFile) plan = readJson(opts.planFile);
  else if (opts.contextFile) {
    const packet = readJson(opts.contextFile);
    const execution = executionPhaseMetadata(packet, { phase: opts.phase,
      complexity: argv.includes('--complexity') ? opts.complexity : undefined, complexityReason: opts.complexityReason });
    plan = { ...packet, unitId: execution.unitId,
      phases: [{ id: 'scoped', phase: execution.phase, complexity: execution.complexity, complexityReason: execution.complexityReason }] };
  } else plan = planFromPrompt(opts.prompt, opts);
  const receipt = await (deps.runPlan || runExecutionPlan)(plan, { ...opts, cwd: opts.cwd || process.cwd(), onEvent });
  if (opts.planFile || opts.contextFile) process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
  else if (receipt.status === 'succeeded' && receipt.outputPath) process.stdout.write(fs.readFileSync(receipt.outputPath, 'utf8'));
  else process.stderr.write(JSON.stringify(receipt, null, 2) + '\n');
  return receipt.status === 'succeeded' && (opts.planFile || opts.contextFile || receipt.outputPath && fs.statSync(receipt.outputPath).size > 0) ? 0 : 1;
}

module.exports = {
  main,
  parseJobId,
  isTerminalStatus,
  buildLaunchArgs,
  companionSupportsPromptFile,
  normalizeCliPath,
  registerPromptFileCleanup,
  parseArgs,
  completeOutputExcerpt,
  persistOutcomeReceipt,
  buildDirectLaunchArgs,
  resolveDirectCodex,
  runScopedDirect,
  runOperation,
};

if (require.main === module) {
  main().then(code => { process.exitCode = code; }).catch((e) => {
    console.error('codex-run: fatal', e && e.message);
    process.exit(1);
  });
}
