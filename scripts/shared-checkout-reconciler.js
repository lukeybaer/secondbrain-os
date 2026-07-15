#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fastForwardShared, runGitDefault } = require('./lib/shared-checkout-sync.js');

const DEFAULT_LOCK_MAX_AGE_MS = 10 * 60 * 1000;

function parseArgs(argv) {
  const out = {
    mainRoot: process.env.SB_MAIN_CHECKOUT || path.join(os.homedir(), 'secondbrain'),
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--main-root') out.mainRoot = argv[++i] || out.mainRoot;
    else if (arg === '--json') out.json = true;
    else if (arg === '--outcome-file') out.outcomeFile = argv[++i] || out.outcomeFile;
    else if (arg === '--help' || arg === '-h') out.help = true;
  }
  return out;
}

function usage() {
  return [
    'Usage:',
    '  node scripts/shared-checkout-reconciler.js [--main-root C:/Users/ExampleCod/secondbrain] [--json] [--outcome-file data/agent/shared-checkout-reconciler.jsonl]',
  ].join('\n');
}

function defaultOutcomeFile() {
  const dataDir =
    process.env.SECONDBRAIN_DATA_DIR ||
    path.join(
      process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
      'secondbrain',
      'data',
    );
  return path.join(dataDir, 'agent', 'shared-checkout-reconciler.jsonl');
}

function gitCommonDir(mainRoot, runGit = runGitDefault) {
  const result = runGit(['rev-parse', '--git-common-dir'], mainRoot);
  if (!result.ok) return path.join(mainRoot, '.git');
  const raw = result.stdout.trim();
  return path.isAbsolute(raw) ? raw : path.resolve(mainRoot, raw);
}

function readLockOwner(lockDir, deps = {}) {
  const readFileSync = deps.readFileSync || fs.readFileSync;
  try {
    return JSON.parse(readFileSync(path.join(lockDir, 'owner.json'), 'utf8'));
  } catch {
    return null;
  }
}

function isPidAlive(pid, deps = {}) {
  const parsed = Number(pid);
  if (!Number.isInteger(parsed) || parsed <= 0) return false;
  const checkPid =
    deps.checkPid ||
    ((value) => {
      try {
        process.kill(value, 0);
        return true;
      } catch {
        return false;
      }
    });
  return Boolean(checkPid(parsed));
}

function staleLockReason(lockDir, deps = {}) {
  const owner = readLockOwner(lockDir, deps);
  if (!owner) return 'unreadable-lock-owner';
  const maxAgeMs = deps.lockMaxAgeMs ?? DEFAULT_LOCK_MAX_AGE_MS;
  const nowMs = deps.nowMs || (() => Date.now());
  const tsMs = Date.parse(owner.ts || '');
  if (Number.isFinite(tsMs) && nowMs() - tsMs > maxAgeMs) return 'stale-lock-age';
  if (!isPidAlive(owner.pid, deps)) return 'dead-lock-owner';
  return null;
}

function writeLockOwner(lockDir, mainRoot, deps = {}) {
  const writeFileSync = deps.writeFileSync || fs.writeFileSync;
  const nowIso = deps.nowIso || (() => new Date().toISOString());
  writeFileSync(
    path.join(lockDir, 'owner.json'),
    JSON.stringify({ pid: process.pid, ts: nowIso(), mainRoot }) + '\n',
    'utf8',
  );
}

function acquireLock(mainRoot, deps = {}) {
  const runGit = deps.runGit || runGitDefault;
  const mkdirSync = deps.mkdirSync || fs.mkdirSync;
  const rmSync = deps.rmSync || fs.rmSync;
  const commonDir = gitCommonDir(mainRoot, runGit);
  const lockDir = path.join(commonDir, 'shared-checkout-reconciler.lock');
  try {
    mkdirSync(lockDir);
    writeLockOwner(lockDir, mainRoot, deps);
    return { acquired: true, lockDir };
  } catch {
    const staleReason = staleLockReason(lockDir, deps);
    if (staleReason) {
      try {
        rmSync(lockDir, { recursive: true, force: true });
        mkdirSync(lockDir);
        writeLockOwner(lockDir, mainRoot, deps);
        return { acquired: true, lockDir, recovered: staleReason };
      } catch {
        return { acquired: false, lockDir, reason: 'lock-recovery-failed', staleReason };
      }
    }
    return { acquired: false, lockDir, reason: 'lock-owner-alive' };
  }
}

function releaseLock(lock, deps = {}) {
  if (!lock || !lock.acquired || !lock.lockDir) return;
  const rmSync = deps.rmSync || fs.rmSync;
  try {
    rmSync(lock.lockDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup. A later run will refuse the visible lock.
  }
}

function appendOutcome(file, row, deps = {}) {
  const mkdirSync = deps.mkdirSync || fs.mkdirSync;
  const appendFileSync = deps.appendFileSync || fs.appendFileSync;
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(row) + '\n', 'utf8');
}

function installSignalHandlers(lock, deps = {}) {
  if (!lock || !lock.acquired) return () => {};
  if (deps.skipSignalHandlers) return () => {};
  const processOn = deps.processOn || process.on.bind(process);
  const processOff = deps.processOff || process.off.bind(process);
  const exit = deps.exit || process.exit.bind(process);
  const release = deps.releaseLock || releaseLock;
  const handlers = [];
  for (const [signal, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ]) {
    const handler = () => {
      release(lock, deps);
      exit(code);
    };
    handlers.push([signal, handler]);
    processOn(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) processOff(signal, handler);
  };
}

function runReconciler(options = {}, deps = {}) {
  const mainRoot = path.resolve(
    options.mainRoot || process.env.SB_MAIN_CHECKOUT || path.join(os.homedir(), 'secondbrain'),
  );
  const outcomeFile = path.resolve(options.outcomeFile || defaultOutcomeFile());
  const nowIso = deps.nowIso || (() => new Date().toISOString());
  const runGit = deps.runGit || runGitDefault;
  const fastForward = deps.fastForward || fastForwardShared;
  const log = deps.log || (() => {});
  const lock = (deps.acquireLock || acquireLock)(mainRoot, { ...deps, runGit });
  if (!lock.acquired) {
    const result = { ok: false, reason: 'lock-held', lockReason: lock.reason, mainRoot };
    appendOutcome(outcomeFile, { ts: nowIso(), ...result }, deps);
    return result;
  }

  const cleanupSignals = (deps.installSignalHandlers || installSignalHandlers)(lock, deps);
  try {
    const sync = fastForward({
      sharedRoot: mainRoot,
      runGit,
      log: (line) => log(line),
    });
    const result = { ...sync, mainRoot };
    appendOutcome(outcomeFile, { ts: nowIso(), ...result }, deps);
    return result;
  } finally {
    cleanupSignals();
    (deps.releaseLock || releaseLock)(lock, deps);
  }
}

function main(argv = process.argv.slice(2), deps = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return 0;
  }
  const result = runReconciler(args, deps);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else {
    const label = result.ok ? 'GREEN' : 'RED';
    console.log(`Shared checkout reconciler: ${label} - ${result.reason || 'ok'}`);
  }
  if (result.ok) return 0;
  if (result.reason === 'lock-held') return 2;
  return 1;
}

if (require.main === module) process.exit(main());

module.exports = {
  acquireLock,
  appendOutcome,
  installSignalHandlers,
  isPidAlive,
  main,
  parseArgs,
  readLockOwner,
  releaseLock,
  runReconciler,
  staleLockReason,
  usage,
};
