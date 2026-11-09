#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  MIGRATION_AUTHORITY,
  RECEIPTS_RELATIVE_ROOT,
  migrateLegacyTrustedReferences,
} = require('./lib/voice-reference-provenance.js');
const {
  acquireWorkerLock,
  releaseWorkerLock,
  workerLockPathForDataRoot,
} = require('./lib/voice-confirmation-jobs.js');

// A voice Save rewrites the whole registry from the copy it read when it
// started, so a stamp written mid-Save was lost on 2026-11-04 (PRIVATE_NAME)
// and the next deploy refused on a receipt conflict. Every write therefore
// holds the Save worker's lock. With --backup, the backup, write, recheck and
// any restore all happen inside that one hold, so neither a stamp nor a
// restore can land under a Save.
const LOCK_BUSY_EXIT = 4;
const RESTORE_FAILED_EXIT = 5;
const DEFAULT_LOCK_WAIT_SEC = 600;
// A killed write can leave receipts without stamps, and a retry with a new
// migrated_at would conflict with them (Codex 1d642350e498). Each write
// records its migrated_at here first; the next write reuses it, so the
// receipts match byte for byte and the stamp rolls forward on the current
// registry, keeping any Save that landed in between. Cleared on success.
const ATTEMPT_RELATIVE_PATH = path.join('life-archive', 'voiceprints', 'legacy-reference-migration-attempt.json');
const ATTEMPT_SCHEMA = 'legacy_voice_reference_stamp_attempt.v1';

function parseArgs(argv) {
  const out = {
    write: false,
    requireCurrent: false,
    aliasDataRoots: [],
    lockWaitSec: DEFAULT_LOCK_WAIT_SEC,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--write') out.write = true;
    else if (arg === '--require-current') out.requireCurrent = true;
    else if (arg === '--data-dir') out.dataDir = argv[++index];
    else if (arg === '--registry') out.registryPath = argv[++index];
    else if (arg === '--alias-data-root') out.aliasDataRoots.push(argv[++index]);
    else if (arg === '--migrated-at') out.migratedAt = argv[++index];
    else if (arg === '--backup') out.backupPath = argv[++index];
    else if (arg === '--lock-wait-sec') out.lockWaitSec = Number(argv[++index]);
    else if (arg === '--help') out.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isFinite(out.lockWaitSec) || out.lockWaitSec < 0) {
    throw new Error('--lock-wait-sec must be a non-negative number');
  }
  if (out.backupPath && !out.write) throw new Error('--backup requires --write');
  return out;
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireSaveLock(
  lockPath,
  waitSec,
  { acquire = acquireWorkerLock, sleep = sleepMs, now = Date.now } = {},
) {
  const deadline = now() + waitSec * 1000;
  for (;;) {
    const lock = acquire(lockPath);
    if (lock) return lock;
    const remaining = deadline - now();
    if (remaining <= 0) return null;
    sleep(Math.min(2000, remaining));
  }
}

function readAttempt(file) {
  let attempt;
  try {
    attempt = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error(`unreadable stamp attempt record ${file}: ${error?.message || error}`);
  }
  if (attempt?.schema !== ATTEMPT_SCHEMA || Number.isNaN(Date.parse(attempt?.migrated_at))) {
    throw new Error(`invalid stamp attempt record ${file}`);
  }
  return attempt;
}

function writeAttempt(file, attempt) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(attempt, null, 2)}\n`, { flag: 'wx', mode: 0o644 });
  fs.renameSync(temp, file);
}

function listFiles(root) {
  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(root);
  return files;
}

// Restores the exact pre-stamp bytes and removes only the receipts this
// attempt created, so a retry never meets its own leftover receipt.
function restoreFromBackup({ registryPath, backupPath, receiptsRoot, receiptsBefore }) {
  const bytes = fs.readFileSync(backupPath);
  const temp = `${registryPath}.${process.pid}.${Date.now()}.restore.tmp`;
  fs.writeFileSync(temp, bytes, { flag: 'wx', mode: 0o644 });
  fs.renameSync(temp, registryPath);
  if (!fs.readFileSync(registryPath).equals(bytes)) {
    throw new Error('restored registry does not match the backup');
  }
  for (const file of listFiles(receiptsRoot)) {
    if (!receiptsBefore.has(file)) fs.unlinkSync(file);
  }
}

function stampWithRollback({ registryPath, backupPath, dataDir, migrate }) {
  fs.copyFileSync(registryPath, backupPath, fs.constants.COPYFILE_EXCL);
  if (!fs.readFileSync(backupPath).equals(fs.readFileSync(registryPath))) {
    throw new Error(`voice registry backup ${backupPath} does not match the registry; nothing was written`);
  }
  const receiptsRoot = path.resolve(dataDir, RECEIPTS_RELATIVE_ROOT);
  const receiptsBefore = new Set(listFiles(receiptsRoot));
  let result = null;
  let failure = null;
  try {
    result = migrate(true);
    if (!result.ok) failure = 'the migration audit is not clean';
    else {
      const recheck = migrate(false);
      if (!recheck.ok || recheck.audit.stamped > 0) {
        failure = `the recheck still finds ${recheck.audit.stamped} unstamped trusted enrollment(s)`;
      }
    }
  } catch (error) {
    failure = error?.message || String(error);
  }
  if (!failure) return { exitCode: 0, audit: result.audit };
  try {
    restoreFromBackup({ registryPath, backupPath, receiptsRoot, receiptsBefore });
  } catch (error) {
    return {
      exitCode: RESTORE_FAILED_EXIT,
      audit: result?.audit,
      message:
        `voice stamping failed (${failure}) AND the registry restore failed (${error?.message || error}). ` +
        `Restore manually: cp -p '${backupPath}' '${registryPath}'`,
    };
  }
  return {
    exitCode: 2,
    audit: result?.audit,
    message: `voice stamping failed (${failure}); registry restored from ${backupPath}`,
  };
}

function main(argv = process.argv.slice(2), { lockOptions } = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(
      'Usage: node scripts/migrate-legacy-voice-reference-provenance.js [--write [--backup FILE] [--lock-wait-sec N]] [--require-current] [--data-dir DIR] [--alias-data-root DIR] [--registry FILE]\n',
    );
    return 0;
  }
  const repo = path.resolve(__dirname, '..');
  const dataDir = path.resolve(
    args.dataDir ||
      process.env.SECONDBRAIN_DATA_DIR ||
      path.join(repo, 'data'),
  );
  const registryPath = path.resolve(
    args.registryPath ||
      path.join(dataDir, 'life-archive', 'voice-identity-registry.json'),
  );
  const migrate = (write, migratedAt = args.migratedAt) =>
    migrateLegacyTrustedReferences({
      registryPath,
      dataDir,
      authority: MIGRATION_AUTHORITY,
      migratedAt,
      aliasDataRoots: args.aliasDataRoots.map((root) => path.resolve(root)),
      write,
    });
  const finish = (result) => {
    process.stdout.write(`${JSON.stringify(result.audit, null, 2)}\n`);
    if (!result.ok) return 2;
    if (args.requireCurrent && result.audit.stamped > 0) {
      process.stderr.write(
        `legacy voice reference provenance preflight failed: ${result.audit.stamped} trusted enrollment(s) still require an immutable stamp\n`,
      );
      return 3;
    }
    return 0;
  };
  if (!args.write) {
    const code = finish(migrate(false));
    // A stamp killed after the registry rename but before its audit receipt
    // reads as current yet left its attempt record. Route it to the write
    // path, which resumes it under the lock, writes the audit and clears the
    // record (Codex d3972aaea38b F7).
    if (code === 0 && args.requireCurrent && fs.existsSync(path.resolve(dataDir, ATTEMPT_RELATIVE_PATH))) {
      process.stderr.write('an interrupted stamp attempt is still pending; the write path finishes it under the voice Save lock\n');
      return 3;
    }
    return code;
  }

  const lockPath = workerLockPathForDataRoot(dataDir);
  const lock = acquireSaveLock(lockPath, args.lockWaitSec, lockOptions);
  if (!lock) {
    process.stderr.write(
      `a voice Save still holds ${lockPath} after ${args.lockWaitSec}s; nothing was written\n`,
    );
    return LOCK_BUSY_EXIT;
  }
  try {
    const attemptPath = path.resolve(dataDir, ATTEMPT_RELATIVE_PATH);
    const pending = readAttempt(attemptPath);
    if (pending && args.migratedAt && args.migratedAt !== pending.migrated_at) {
      throw new Error(
        `an interrupted stamp attempt used migrated_at ${pending.migrated_at}; rerun without --migrated-at or with that value`,
      );
    }
    const migratedAt = pending?.migrated_at || args.migratedAt || new Date().toISOString();
    if (pending) {
      process.stderr.write(
        `resuming the interrupted stamp attempt from ${pending.started_at} (pid ${pending.pid}) with its migrated_at ${migratedAt}\n`,
      );
    }
    writeAttempt(attemptPath, {
      schema: ATTEMPT_SCHEMA,
      migrated_at: migratedAt,
      started_at: new Date().toISOString(),
      pid: process.pid,
      backup_path: args.backupPath ? path.resolve(args.backupPath) : null,
    });
    const migrateAt = (write) => migrate(write, migratedAt);
    if (!args.backupPath) {
      const result = migrateAt(true);
      if (result.ok) fs.rmSync(attemptPath, { force: true });
      return finish(result);
    }
    const outcome = stampWithRollback({
      registryPath,
      backupPath: path.resolve(args.backupPath),
      dataDir,
      migrate: migrateAt,
    });
    if (outcome.exitCode === 0) fs.rmSync(attemptPath, { force: true });
    if (outcome.audit) process.stdout.write(`${JSON.stringify(outcome.audit, null, 2)}\n`);
    if (outcome.message) process.stderr.write(`${outcome.message}\n`);
    return outcome.exitCode;
  } finally {
    releaseWorkerLock(lockPath, lock.token);
  }
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(
      `legacy voice reference migration failed: ${error?.message || error}\n`,
    );
    process.exitCode = 1;
  }
}

module.exports = {
  ATTEMPT_RELATIVE_PATH,
  DEFAULT_LOCK_WAIT_SEC,
  LOCK_BUSY_EXIT,
  RESTORE_FAILED_EXIT,
  acquireSaveLock,
  main,
  parseArgs,
  stampWithRollback,
};
