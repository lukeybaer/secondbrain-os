'use strict';

// Model-free, exit-event-driven execution. A checkpoint is evidence, never
// authorization. Callers own authorization and semantic/live acceptance proof.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const stable = (value) => JSON.stringify(value, (_, item) => item && !Array.isArray(item) && typeof item === 'object'
  ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
const text = (value) => typeof value === 'string' && value.trim() && !value.includes('\0');
const acceptance = (value) => text(value) || (Array.isArray(value) && value.length && value.every(text));
const runtimeRoot = () => path.join(process.env.APPDATA || os.homedir(), 'secondbrain', 'execution-operations');

function realDirectory(value, label) {
  if (!text(value) || !path.isAbsolute(value) || !fs.statSync(value).isDirectory()) throw new Error(`${label} requires an existing absolute directory`);
  return fs.realpathSync(value);
}

function realFile(value, cwd) {
  const file = fs.realpathSync(path.resolve(cwd, value));
  if (!fs.statSync(file).isFile()) throw new Error(`Required file is not a file: ${file}`);
  return file;
}

function executable(command, cwd, env, platform) {
  if (!text(command)) throw new Error('stage command requires text');
  const explicit = path.isAbsolute(command) || /[/\\]/.test(command);
  const candidates = explicit ? [path.resolve(cwd, command)]
    : (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean).flatMap((dir) => {
      const base = path.join(dir.replace(/^"|"$/g, ''), command);
      return platform === 'win32' && !path.extname(command) ? [base + '.exe', base + '.com', base] : [base];
    });
  for (const candidate of candidates) {
    try {
      const resolved = realFile(candidate, cwd);
      if (platform === 'win32' && !/\.(exe|com)$/i.test(resolved)) continue;
      fs.accessSync(resolved, platform === 'win32' ? fs.constants.R_OK : fs.constants.X_OK);
      return resolved;
    } catch (_) { /* Try the next PATH entry. */ }
  }
  throw new Error(`Executable unavailable for ${platform}: ${command}; use a native executable and explicit script argv (shell:false)`);
}

function fileIdentities(files) {
  return files.map((file) => ({ path: file, sha256: digest(fs.readFileSync(file)) }));
}

function preflightCommit(stage, env) {
  if (!/^git(?:\.exe)?$/i.test(path.basename(stage.command)) || !stage.args.includes('commit')) return;
  const git = args => {
    const result = spawnSync(stage.command, args, { cwd: stage.cwd, env, shell: false, windowsHide: true, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
    if (result.error || result.status !== 0) throw new Error(`Commit preflight failed: ${result.error?.message || result.stderr}`);
    return result.stdout;
  };
  git(['diff', '--cached', '--check']);
  if (!fs.existsSync(path.join(stage.cwd, 'dev-plans', 'core'))) return;
  const files = git(['diff', '--cached', '--name-only', '--no-renames', '-z']).split('\0').filter(Boolean);
  const messageIndex = stage.args.findIndex(arg => ['-m', '--message'].includes(arg));
  const { evaluateCoreDocCoverage, formatMissing } = require('./core-doc-coverage');
  const result = evaluateCoreDocCoverage({ root: stage.cwd, changedFiles: files,
    commitMessages: messageIndex >= 0 ? [stage.args[messageIndex + 1]] : [] });
  if (!result.ok) throw new Error(`Commit preflight: ${formatMissing(result.missing)}. Update the matching core methods before committing.`);
}

function scriptFiles(command, args, cwd) {
  const name = path.basename(command).toLowerCase().replace(/\.exe$/, '');
  // All explicitly named script arguments must exist, including secondary
  // scripts passed to test runners. Inline code and module invocations remain
  // supported; their exact argv is bound into the packet hash.
  if (['node', 'nodejs', 'python', 'python3', 'bash', 'sh', 'pwsh', 'powershell'].includes(name)) {
    const inline = args.findIndex((arg) => ['-e', '--eval', '-c', '-Command', '-EncodedCommand'].includes(arg));
    const files = args.filter((arg, index) => index !== inline + 1 || inline < 0)
      .filter((arg) => !arg.startsWith('-') && /\.(?:[cm]?js|ts|py|sh|ps1)$/i.test(arg))
      .map((arg) => realFile(arg, cwd));
    // Interpreter entry points need not have a filename extension.
    if (args[0] && !args[0].startsWith('-')) files.push(realFile(args[0], cwd));
    const fileFlag = args.findIndex((arg) => arg.toLowerCase() === '-file');
    if (fileFlag >= 0) {
      if (!text(args[fileFlag + 1]) || args[fileFlag + 1].startsWith('-')) throw new Error('-File requires an explicit script path');
      files.push(realFile(args[fileFlag + 1], cwd));
    }
    return [...new Set(files)];
  }
  return [];
}

function prospectiveReal(value) {
  let current = path.resolve(value);
  const tail = [];
  while (!fs.existsSync(current)) { tail.unshift(path.basename(current)); current = path.dirname(current); }
  return path.join(fs.realpathSync(current), ...tail);
}

function assertRuntimeOutsideCheckout(target, cwds) {
  const resolved = prospectiveReal(target);
  for (const cwd of cwds) {
    let root = cwd;
    for (let dir = cwd; ; dir = path.dirname(dir)) {
      if (fs.existsSync(path.join(dir, '.git'))) { root = dir; break; }
      if (path.dirname(dir) === dir) break;
    }
    const relative = path.relative(root, resolved);
    if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) {
      throw new Error('Runtime receipts and locks must be outside the operation checkout');
    }
  }
  return resolved;
}

// Entirely static: malformed later stages cause zero child launches and zero
// filesystem mutations. Optional stage.platform/requiredFlags make exact local
// contracts explicit without trying to parse arbitrary application flags.
function preflightOperationSequence(packet, opts = {}, deps = {}) {
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)) throw new Error('operation must be an object');
  for (const field of ['unitId', 'objective']) if (!text(packet[field])) throw new Error(`operation ${field} requires text`);
  if (!acceptance(packet.acceptance)) throw new Error('operation acceptance requires nonempty text or text array');
  if (!Array.isArray(packet.stages) || !packet.stages.length) throw new Error('operation requires stages');
  const cwd = realDirectory(packet.cwd, 'operation cwd');
  const platform = deps.platform || process.platform;
  const env = deps.env || process.env;
  const ids = new Set();
  const stages = packet.stages.map((stage) => {
    if (!stage || !text(stage.id) || ids.has(stage.id)) throw new Error('stage id must be unique nonempty text');
    ids.add(stage.id);
    if (!Array.isArray(stage.args) || !stage.args.every((arg) => typeof arg === 'string' && !arg.includes('\0'))) throw new Error('stage args requires strings');
    if (stage.timeoutMs !== undefined && (!Number.isSafeInteger(stage.timeoutMs) || stage.timeoutMs <= 0 || stage.timeoutMs > 2147483647)) throw new Error('stage timeoutMs must be an explicit positive timer integer');
    if (stage.platform && stage.platform !== platform) throw new Error(`stage ${stage.id} requires platform ${stage.platform}`);
    if (stage.acceptance !== undefined && !acceptance(stage.acceptance)) throw new Error('invalid stage acceptance');
    const stageCwd = realDirectory(stage.cwd === undefined ? cwd : stage.cwd, 'stage cwd');
    const command = executable(stage.command, stageCwd, env, platform);
    const scripts = scriptFiles(command, stage.args, stageCwd);
    if (stage.inputs !== undefined && (!Array.isArray(stage.inputs) || !stage.inputs.every(text))) throw new Error('stage inputs requires file paths');
    if (stage.requiredFlags !== undefined && (!Array.isArray(stage.requiredFlags) || !stage.requiredFlags.every(text))) throw new Error('stage requiredFlags requires strings');
    const requiredFlags = [...(stage.requiredFlags || [])];
    if ([command, ...scripts].some((file) => path.basename(file).toLowerCase() === 'land.js')) requiredFlags.push('--apply');
    for (const flag of requiredFlags) if (!stage.args.includes(flag)) throw new Error(`stage ${stage.id} requires ${flag}`);
    const files = [...new Set([command, ...scripts, ...(stage.inputs || []).map((file) => realFile(file, stageCwd))])];
    const release = /(^|[-_:])(land|deploy|release)([-_:]|$)/i.test(stage.id) || [command, ...scripts].some((file) => /^(land|deploy|release)([.-]|$)/i.test(path.basename(file)));
    return { ...stage, cwd: stageCwd, command, files, inputs: fileIdentities(files), release };
  });
  const cwds = [cwd, ...stages.map((stage) => stage.cwd)];
  const receiptRoot = assertRuntimeOutsideCheckout(opts.receiptDir || runtimeRoot(), cwds);
  const lockRoot = assertRuntimeOutsideCheckout(deps.lockDir || path.join(runtimeRoot(), 'locks'), cwds);
  const unitKey = digest(stable({ unitId: packet.unitId, cwd }));
  const checkpointPath = opts.resumePath
    ? assertRuntimeOutsideCheckout(opts.resumePath, cwds)
    : path.join(receiptRoot, unitKey, 'checkpoint.json');
  const packetHash = digest(stable({ packet, resolved: stages.map(({ command, cwd }) => ({ command, cwd })) }));
  const git = stages.some((stage) => stage.release) ? executable('git', cwd, env, platform) : null;
  return { packetHash, cwd, stages, unitKey, lockRoot, checkpointPath, git, env };
}

function save(file, value) {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, 'wx');
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
}

function runChild(stage, stdoutPath, stderrPath, deps, env) {
  const descriptors = [stdoutPath, stderrPath].map((file) => fs.openSync(file, 'wx'));
  return new Promise((resolve) => {
    let child, timer, error = null, timedOut = false;
    const finish = (exitCode, signal) => {
      clearTimeout(timer);
      descriptors.forEach((fd) => fs.closeSync(fd));
      resolve({ exitCode, signal, error, timedOut });
    };
    try {
      child = (deps.spawnFn || spawn)(stage.command, stage.args, {
        cwd: stage.cwd, shell: false, windowsHide: true, env,
        stdio: ['ignore', ...descriptors],
      });
    } catch (failure) { error = failure.message; finish(null, null); return; }
    child.once('error', (failure) => { error = failure.message; });
    child.once('close', finish);
    if (stage.timeoutMs) timer = setTimeout(() => { timedOut = true; child.kill(); }, stage.timeoutMs);
  });
}

/**
 * Await one terminal receipt. No timer unless a stage explicitly provides one.
 * Resume failed stages only with retryStage: { id, reason } AND changed file
 * inputs; successful or running/unknown stages are never automatically replayed.
 * An ambiguous effect requires external reconciliation and a new unit packet;
 * the original raw logs/checkpoint remain the evidence for that decision.
 */
async function runOperationSequence(packet, opts = {}, deps = {}) {
  const plan = preflightOperationSequence(packet, opts, deps);
  const runDir = path.dirname(plan.checkpointPath);
  fs.mkdirSync(plan.lockRoot, { recursive: true });
  const lockPath = path.join(plan.lockRoot, `${plan.unitKey}.lock`);
  let lock;
  try { lock = fs.openSync(lockPath, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return { status: 'needs-reconciliation', reason: 'Unit has an existing owner lock; prove prior owner and child termination before removing it', lockPath, checkpointPath: plan.checkpointPath, modelCalls: 0 };
  }
  const ownerToken = crypto.randomUUID();
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, hostname: os.hostname(), ownerToken, checkpointPath: plan.checkpointPath }));
  fs.closeSync(lock);
  let state;
  const eventPath = path.join(runDir, 'events.jsonl');
  const event = async (type, detail = {}) => {
    const record = { type, unitId: packet.unitId, recordedAt: new Date().toISOString(), modelCalls: 0, ...detail };
    fs.appendFileSync(eventPath, JSON.stringify(record) + '\n');
    if (opts.onEvent) {
      // A broken observer must never turn a completed side effect into a retry.
      try { await opts.onEvent(record); } catch (error) {
        fs.appendFileSync(eventPath, JSON.stringify({ type: 'observer-error', message: error.message }) + '\n');
      }
    }
  };
  const terminal = async (status, reason) => {
    const receipt = { status, reason: reason || null, unitId: packet.unitId, packetHash: plan.packetHash,
      checkpointPath: plan.checkpointPath, eventPath, stages: state ? state.stages : [],
      acceptance: packet.acceptance, acceptanceVerified: false, modelCalls: 0, completedAt: new Date().toISOString() };
    const receiptPath = path.join(runDir, `receipt-${crypto.randomUUID()}.json`);
    receipt.receiptPath = receiptPath;
    save(receiptPath, receipt);
    await event('operation-completed', { status, reason: receipt.reason, receiptPath });
    return receipt;
  };
  try {
    fs.mkdirSync(runDir, { recursive: true });
    // Persist the unit's checkpoint location after releasing its live lock too.
    // A different receipt directory must not silently create a second history.
    const identityPath = path.join(plan.lockRoot, `${plan.unitKey}.json`);
    if (fs.existsSync(identityPath)) {
      const identity = JSON.parse(fs.readFileSync(identityPath, 'utf8'));
      if (identity.checkpointPath !== plan.checkpointPath) return await terminal('needs-reconciliation', `Unit already has a checkpoint: ${identity.checkpointPath}`);
    } else {
      save(identityPath, { unitId: packet.unitId, checkpointPath: plan.checkpointPath });
    }
    if (fs.existsSync(plan.checkpointPath)) {
      state = JSON.parse(fs.readFileSync(plan.checkpointPath, 'utf8'));
      if (state.version !== 1 || state.packetHash !== plan.packetHash || state.unitId !== packet.unitId) return await terminal('needs-reconciliation', 'Packet identity differs from durable checkpoint');
      if (!Array.isArray(state.stages) || state.stages.length !== plan.stages.length || state.stages.some((stage, index) => !stage || stage.id !== plan.stages[index].id || !Array.isArray(stage.attempts))) return await terminal('needs-reconciliation', 'Malformed checkpoint stages');
    } else {
      if (opts.resumePath) return await terminal('needs-reconciliation', 'Requested checkpoint does not exist');
      state = { version: 1, unitId: packet.unitId, packetHash: plan.packetHash, stages: plan.stages.map((stage) => ({ id: stage.id, status: 'pending', attempts: [] })) };
      save(plan.checkpointPath, state);
    }
    // Check every previous effect before any new stage or cheap-gate launch.
    for (let index = 0; index < state.stages.length; index++) {
      const prior = state.stages[index];
      const current = plan.stages[index];
      const changed = stable(prior.inputs) !== stable(current.inputs);
      const last = prior.attempts.at(-1);
      if (prior.status === 'succeeded' && (!last || last.exitCode !== 0 || last.error || last.timedOut || last.signal || !last.completedAt || !fs.existsSync(last.stdoutPath || '') || !fs.existsSync(last.stderrPath || ''))) return await terminal('needs-reconciliation', `Successful stage lacks completion evidence: ${prior.id}`);
      if (prior.status === 'succeeded' && changed) return await terminal('needs-reconciliation', `Successful stage inputs changed: ${prior.id}`);
      if (!['pending', 'succeeded', 'failed'].includes(prior.status)) return await terminal('needs-reconciliation', `Ambiguous prior stage: ${prior.id}`);
      if (prior.status === 'failed' && !(opts.retryStage && opts.retryStage.id === prior.id && text(opts.retryStage.reason) && changed)) return await terminal('needs-reconciliation', `Failed stage requires explicit changed-input retry: ${prior.id}`);
    }
    await event('operation-started', { packetHash: plan.packetHash, checkpointPath: plan.checkpointPath });
    // All static validation precedes this read-only release gate and all effects.
    for (const cwd of [...new Set(plan.stages.filter((stage, index) => stage.release && state.stages[index].status !== 'succeeded').map((stage) => stage.cwd))]) {
      const prefix = path.join(runDir, `preflight-${crypto.randomUUID()}`);
      const result = await runChild({ command: plan.git, args: ['diff', '--check'], cwd }, `${prefix}.stdout.txt`, `${prefix}.stderr.txt`, deps, plan.env);
      if (result.exitCode !== 0 || result.error) return await terminal('preflight-failed', `git diff --check failed; logs: ${prefix}`);
    }
    for (let index = 0; index < plan.stages.length; index++) {
      const stage = plan.stages[index];
      const record = state.stages[index];
      if (record.status === 'succeeded') continue;
      if (stable(fileIdentities(stage.files)) !== stable(stage.inputs)) return await terminal('needs-reconciliation', `Stage inputs changed after preflight: ${stage.id}`);
      try { preflightCommit(stage, plan.env); }
      catch (error) { return await terminal('preflight-failed', error.message); }
      const attemptId = crypto.randomUUID();
      const prefix = path.join(runDir, `stage-${index}-${attemptId}`);
      const attempt = { attemptId, startedAt: new Date().toISOString(), stdoutPath: `${prefix}.stdout.txt`, stderrPath: `${prefix}.stderr.txt`, inputs: stage.inputs, retryReason: opts.retryStage && opts.retryStage.id === stage.id ? opts.retryStage.reason : null };
      record.status = 'running'; record.inputs = stage.inputs; record.attempts.push(attempt);
      save(plan.checkpointPath, state); // Write-ahead: a crash now is ambiguous.
      await event('stage-started', { stageId: stage.id, attemptId });
      const result = await runChild(stage, attempt.stdoutPath, attempt.stderrPath, deps, plan.env);
      Object.assign(attempt, result, { completedAt: new Date().toISOString() });
      record.status = result.timedOut || result.signal ? 'needs-reconciliation' : result.exitCode === 0 && !result.error ? 'succeeded' : 'failed';
      save(plan.checkpointPath, state);
      await event('stage-completed', { stageId: stage.id, status: record.status, ...result });
      if (record.status !== 'succeeded') return await terminal(record.status === 'failed' ? 'failed-unfinished' : 'needs-reconciliation', `Stage ${stage.id} did not succeed`);
    }
    return await terminal('succeeded');
  } finally {
    // Never steal/reap a stale lock automatically: its child may still exist.
    const owner = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (owner.ownerToken === ownerToken) fs.unlinkSync(lockPath);
  }
}

module.exports = { preflightOperationSequence, preflightCommit, runOperationSequence };
