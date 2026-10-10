'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// A healer pause is a bounded bench, never a permanent off-switch. A pause
// file may declare its own `expires_at`; a file without one expires
// DEFAULT_TTL_HOURS after its mtime. The lane runner consults this module on
// every pass and clears an expired pause itself, so an expired bench can
// never outlive its reason even when no other scheduler is watching
// (2026-07-31: the direct-exact38 bench had no TTL and its cron lines were
// removed, so zero calls closed overnight with no signal).
const DEFAULT_TTL_HOURS = 12;
const PAUSE_SCHEMA = 'life_archive_otter_healer_pause.v2';
const RECOVERY_SCHEMA = 'life_archive_otter_healer_pause_recovery.v1';
const TERMINAL_TASK_STATES = new Set([
  'archived',
  'cancelled',
  'closed',
  'complete',
  'completed',
  'done',
  'failed',
]);

function writeFileAtomic(file, content, { fsApi = fs, mode = 0o600 } = {}) {
  fsApi.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let fd;
  let renamed = false;
  try {
    fd = fsApi.openSync(temp, 'wx', mode);
    fsApi.writeFileSync(fd, content, 'utf8');
    fsApi.fsyncSync(fd);
    const completedFd = fd;
    fd = undefined;
    fsApi.closeSync(completedFd);
    fsApi.renameSync(temp, file);
    renamed = true;
  } finally {
    if (fd != null) fsApi.closeSync(fd);
    if (!renamed) {
      try {
        fsApi.rmSync(temp, { force: true });
      } catch {}
    }
  }
}

function writeJsonAtomic(file, value, options = {}) {
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`, options);
}

function nonempty(value, name) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`Otter healer pause ${name} is required`);
  return text;
}

function createPause(
  file,
  {
    owner,
    reason,
    token = crypto.randomUUID(),
    ttlHours = DEFAULT_TTL_HOURS,
    now = new Date(),
    fsApi = fs,
  } = {},
) {
  const exactOwner = nonempty(owner, 'owner');
  const exactReason = nonempty(reason, 'reason');
  const exactToken = nonempty(token, 'ownership token');
  if (exactToken.length < 8) throw new Error('Otter healer pause ownership token is too short');
  const ttl = Number(ttlHours);
  if (!Number.isFinite(ttl) || ttl <= 0 || ttl > DEFAULT_TTL_HOURS) {
    throw new Error(`Otter healer pause TTL must be greater than zero and at most ${DEFAULT_TTL_HOURS} hours`);
  }
  const created = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(created.getTime())) throw new Error('Otter healer pause created_at is invalid');
  const pause = {
    schema: PAUSE_SCHEMA,
    owner: exactOwner,
    reason: exactReason,
    token: exactToken,
    created_at: created.toISOString(),
    expires_at: new Date(created.getTime() + ttl * 3_600_000).toISOString(),
  };
  writeJsonAtomic(file, pause, { fsApi });
  return pause;
}

function ownerHintFromInvalidContent(raw) {
  const match = String(raw || '').match(/"owner"\s*:\s*"([^"\\]{1,160})"/);
  return match ? match[1].trim() : '';
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function pathIsInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function activeOwnerProcesses(ownerHint, { fsApi = fs } = {}) {
  if (!ownerHint || process.platform === 'win32') return [];
  let names = [];
  try {
    names = fsApi.readdirSync('/proc').filter((name) => /^\d+$/.test(name));
  } catch {
    return [];
  }
  const matches = [];
  for (const name of names) {
    const pid = Number(name);
    if (pid === process.pid || pid === process.ppid) continue;
    try {
      const command = String(fsApi.readFileSync(`/proc/${name}/cmdline`, 'utf8')).replace(/\0/g, ' ');
      if (command.includes(ownerHint)) matches.push(`pid:${name}`);
    } catch {}
  }
  return matches;
}

function activeOwnerTasks(ownerHint, tasksDir, { fsApi = fs } = {}) {
  if (!ownerHint || !tasksDir) return [];
  let names = [];
  try {
    names = fsApi.readdirSync(tasksDir).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  const matches = [];
  for (const name of names) {
    try {
      const raw = String(fsApi.readFileSync(path.join(tasksDir, name), 'utf8'));
      if (!raw.includes(ownerHint)) continue;
      const task = JSON.parse(raw.replace(/^\uFEFF/, ''));
      const status = String(task?.status || task?.state || '').toLowerCase();
      if (!TERMINAL_TASK_STATES.has(status)) matches.push(name);
    } catch {}
  }
  return matches;
}

function recoveryResult(status, fields, { reportFile, fsApi = fs } = {}) {
  const result = {
    schema: RECOVERY_SCHEMA,
    generated_at: new Date(fields.now_ms || Date.now()).toISOString(),
    status,
    ...fields,
  };
  delete result.now_ms;
  if (reportFile) writeJsonAtomic(reportFile, result, { fsApi });
  return result;
}

function exists(file, fsApi = fs) {
  try {
    fsApi.statSync(file);
    return true;
  } catch {
    return false;
  }
}

function reconcilePreparedRecoveries(
  quarantineDir,
  { nowMs = Date.now(), fsApi = fs } = {},
) {
  const outcome = { committed: [], aborted: [], issues: [] };
  if (!quarantineDir) return outcome;
  let names;
  try {
    names = fsApi.readdirSync(quarantineDir).filter((name) => name.endsWith('.receipt.json'));
  } catch {
    return outcome;
  }
  for (const name of names) {
    const receiptFile = path.join(quarantineDir, name);
    let receipt;
    try {
      receipt = JSON.parse(String(fsApi.readFileSync(receiptFile, 'utf8')).replace(/^\uFEFF/, ''));
    } catch {
      outcome.issues.push({ receipt_file: receiptFile, reason: 'receipt_unreadable' });
      continue;
    }
    if (receipt?.schema !== RECOVERY_SCHEMA || receipt?.state !== 'prepared') continue;
    const sourceFile = String(receipt?.source_file || '');
    const quarantineFile = String(receipt?.quarantine_file || '');
    const sourceParent = path.dirname(sourceFile);
    const allowedSource =
      ['otter-live-healer.pause', 'otter-historical-backfill.pause'].includes(
        path.basename(sourceFile),
      ) &&
      path.basename(sourceParent) === 'voiceprints' &&
      path.basename(path.dirname(sourceParent)) === 'life-archive' &&
      !pathIsInside(quarantineDir, sourceFile);
    if (
      !sourceFile ||
      !quarantineFile ||
      !allowedSource ||
      !pathIsInside(quarantineDir, quarantineFile) ||
      path.resolve(receiptFile) !== path.resolve(`${quarantineFile}.receipt.json`)
    ) {
      outcome.issues.push({ receipt_file: receiptFile, reason: 'receipt_paths_invalid' });
      continue;
    }
    const sourceExists = exists(sourceFile, fsApi);
    const quarantineExists = exists(quarantineFile, fsApi);
    if (sourceExists && !quarantineExists) {
      try {
        writeJsonAtomic(
          receiptFile,
          {
            ...receipt,
            state: 'aborted',
            aborted_at: new Date(nowMs).toISOString(),
            abort_reason: 'source_remained_after_prepared_receipt',
          },
          { fsApi },
        );
        outcome.aborted.push(receiptFile);
      } catch (error) {
        outcome.issues.push({
          receipt_file: receiptFile,
          reason: `receipt_abort_failed:${error?.code || error?.message || error}`,
        });
      }
      continue;
    }
    if (!sourceExists && quarantineExists) {
      try {
        const raw = fsApi.readFileSync(quarantineFile);
        if (sha256(raw) !== receipt.source_sha256 || raw.length !== receipt.source_bytes) {
          outcome.issues.push({ receipt_file: receiptFile, reason: 'quarantine_evidence_mismatch' });
          continue;
        }
        writeJsonAtomic(
          receiptFile,
          {
            ...receipt,
            state: 'committed',
            committed_at: new Date(nowMs).toISOString(),
            reconciled_after_interruption: true,
          },
          { fsApi },
        );
        outcome.committed.push(receiptFile);
      } catch (error) {
        outcome.issues.push({
          receipt_file: receiptFile,
          reason: `receipt_reconcile_failed:${error?.code || error?.message || error}`,
        });
      }
      continue;
    }
    outcome.issues.push({
      receipt_file: receiptFile,
      reason: sourceExists ? 'source_and_quarantine_both_exist' : 'source_and_quarantine_both_missing',
    });
  }
  return outcome;
}

function quarantineStaleInvalidPause(
  file,
  {
    quarantineDir,
    reportFile = '',
    nowMs = Date.now(),
    hardTtlHours = DEFAULT_TTL_HOURS,
    locksHeld = false,
    blockedReason = '',
    deployLockActive = false,
    activeOwnerProcesses: processMatches,
    activeOwnerTasks: taskMatches,
    tasksDir = '',
    fsApi = fs,
  } = {},
) {
  // Receipt reconciliation writes evidence state, so it is allowed only
  // inside the same quiesced transaction as quarantine itself. Shell-level
  // lock-failure reporting calls this function without --locks-held and must
  // remain strictly read-only.
  const reconciliation =
    locksHeld && !deployLockActive
      ? reconcilePreparedRecoveries(quarantineDir, { nowMs, fsApi })
      : { committed: [], aborted: [], issues: [] };
  if (reconciliation.issues.length) {
    return recoveryResult(
      'blocked',
      {
        now_ms: nowMs,
        source_file: file,
        blocked_reason: 'prepared_receipt_reconciliation_failed',
        evidence_risk: true,
        reconciliation,
      },
      { reportFile, fsApi },
    );
  }
  const state = pauseState(file, { nowMs, fsApi });
  const baseFields = {
    now_ms: nowMs,
    source_file: file,
    pause_error: state.error || '',
    reconciliation,
  };
  if (!state.exists) return recoveryResult('not_needed', baseFields, { reportFile, fsApi });
  if (!state.error) {
    return recoveryResult('not_needed', { ...baseFields, reason: 'pause_is_parseable' }, { reportFile, fsApi });
  }
  let stat;
  let raw;
  try {
    stat = fsApi.statSync(file);
    raw = fsApi.readFileSync(file);
  } catch (error) {
    return recoveryResult(
      'blocked',
      { ...baseFields, blocked_reason: `pause_read_failed:${error?.code || error?.message || error}` },
      { reportFile, fsApi },
    );
  }
  const ageMs = Math.max(0, nowMs - stat.mtimeMs);
  const ownerHint = ownerHintFromInvalidContent(raw);
  const guardedFields = {
    ...baseFields,
    owner_hint: ownerHint,
    age_ms: ageMs,
    hard_ttl_hours: hardTtlHours,
  };
  const blocked = (blockedReason, extra = {}) =>
    recoveryResult(
      'blocked',
      { ...guardedFields, blocked_reason: blockedReason, ...extra },
      { reportFile, fsApi },
    );
  if (ageMs < Number(hardTtlHours) * 3_600_000) return blocked('hard_ttl_not_reached');
  if (!locksHeld) return blocked(blockedReason || 'locks_not_held');
  if (deployLockActive) return blocked('deploy_lock_active');
  if (!ownerHint) return blocked('owner_identity_unknown');
  const exactProcessMatches =
    processMatches == null ? activeOwnerProcesses(ownerHint, { fsApi }) : processMatches;
  if (exactProcessMatches.length) {
    return blocked('owner_process_active', { active_owner_processes: exactProcessMatches });
  }
  const exactTaskMatches =
    taskMatches == null ? activeOwnerTasks(ownerHint, tasksDir, { fsApi }) : taskMatches;
  if (exactTaskMatches.length) {
    return blocked('owner_task_active', { active_owner_tasks: exactTaskMatches });
  }
  if (!quarantineDir) return blocked('quarantine_dir_missing');
  if (pathIsInside(path.dirname(file), quarantineDir)) {
    return blocked('quarantine_dir_inside_pause_scan_tree');
  }

  const sourceHash = sha256(raw);
  const stamp = new Date(nowMs).toISOString().replace(/[:.]/g, '-');
  const quarantineFile = path.join(
    quarantineDir,
    `${path.basename(file)}.${stamp}.${sourceHash.slice(0, 12)}.invalid`,
  );
  const receiptFile = `${quarantineFile}.receipt.json`;
  const receipt = {
    schema: RECOVERY_SCHEMA,
    state: 'prepared',
    prepared_at: new Date(nowMs).toISOString(),
    source_file: file,
    source_sha256: sourceHash,
    source_bytes: raw.length,
    source_mtime: new Date(stat.mtimeMs).toISOString(),
    quarantine_file: quarantineFile,
    owner_hint: ownerHint,
    guards: {
      locks_held: true,
      deploy_lock_active: false,
      active_owner_processes: [],
      active_owner_tasks: [],
    },
  };
  writeJsonAtomic(receiptFile, receipt, { fsApi });
  try {
    fsApi.mkdirSync(quarantineDir, { recursive: true });
    fsApi.renameSync(file, quarantineFile);
  } catch (error) {
    return blocked(`quarantine_rename_failed:${error?.code || error?.message || error}`, {
      receipt_file: receiptFile,
      quarantine_file: quarantineFile,
    });
  }
  const committed = {
    ...receipt,
    state: 'committed',
    committed_at: new Date(nowMs).toISOString(),
  };
  try {
    writeJsonAtomic(receiptFile, committed, { fsApi });
  } catch (error) {
    return blocked(`receipt_commit_failed:${error?.code || error?.message || error}`, {
      evidence_risk: true,
      source_sha256: sourceHash,
      quarantine_file: quarantineFile,
      receipt_file: receiptFile,
    });
  }
  return recoveryResult(
    'quarantined',
    {
      ...guardedFields,
      source_sha256: sourceHash,
      source_bytes: raw.length,
      quarantine_file: quarantineFile,
      receipt_file: receiptFile,
    },
    { reportFile, fsApi },
  );
}

function pauseState(
  file,
  { nowMs = Date.now(), defaultTtlHours = DEFAULT_TTL_HOURS, fsApi = fs } = {},
) {
  let stat;
  try {
    stat = fsApi.statSync(file);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return {
        exists: false,
        active: false,
        expired: false,
        owner: '',
        reason: '',
        expires_at: null,
      };
    }
    // A pause is a SAFETY flag: an unreadable pause (EACCES, EIO, ...) must
    // fail CLOSED as active, never be mistaken for "no pause" (Codex review
    // f40fbcb97dc5). The error is surfaced so health can go red on it.
    return {
      exists: true,
      active: true,
      expired: false,
      owner: '',
      reason: '',
      expires_at: null,
      error: String(error?.code || error?.message || error),
    };
  }
  let owner = '';
  let reason = '';
  let expiresAtMs = null;
  let raw;
  try {
    raw = String(fsApi.readFileSync(file, 'utf8')).replace(/^﻿/, '');
  } catch (error) {
    // Stat succeeded but the CONTENT is unreadable: fail closed as an active
    // pause, exactly like a stat failure (Codex review 2c50aa81e33c).
    return {
      exists: true,
      active: true,
      expired: false,
      owner: '',
      reason: '',
      expires_at: null,
      error: String(error?.code || error?.message || error),
    };
  }
  if (raw.trim()) {
    try {
      const body = JSON.parse(raw);
      owner = String(body?.owner || '');
      reason = String(body?.reason || '');
      if (body?.schema === PAUSE_SCHEMA) {
        const token = String(body?.token || '').trim();
        const created = Date.parse(String(body?.created_at || ''));
        const declared = Date.parse(String(body?.expires_at || ''));
        const durationMs = declared - created;
        if (
          !owner.trim() ||
          !reason.trim() ||
          token.length < 8 ||
          !Number.isFinite(created) ||
          !Number.isFinite(declared) ||
          durationMs <= 0 ||
          durationMs > DEFAULT_TTL_HOURS * 3_600_000
        ) {
          return {
            exists: true,
            active: true,
            expired: false,
            owner,
            reason,
            expires_at: null,
            error: 'invalid_pause_lease',
          };
        }
      }
      const rawExpiry = String(body?.expires_at ?? '');
      if (rawExpiry) {
        const declared = Date.parse(rawExpiry);
        if (!Number.isFinite(declared)) {
          // A declared-but-unparseable expiry is corrupted intent, never an
          // invitation to fall back to mtime (Codex review 12103d9f3576).
          return {
            exists: true,
            active: true,
            expired: false,
            owner,
            reason,
            expires_at: null,
            error: 'invalid_declared_expiry',
          };
        }
        expiresAtMs = declared;
      }
    } catch {
      // Non-empty but unparseable content is NOT a legacy pause: someone
      // wrote metadata we cannot read, so fail closed as active. Legacy is
      // only a successfully read EMPTY file, which the mtime TTL governs.
      return {
        exists: true,
        active: true,
        expired: false,
        owner: '',
        reason: '',
        expires_at: null,
        error: 'unparseable_pause_content',
      };
    }
  }
  if (expiresAtMs == null) expiresAtMs = stat.mtimeMs + defaultTtlHours * 3_600_000;
  const expired = nowMs >= expiresAtMs;
  return {
    exists: true,
    active: !expired,
    expired,
    owner,
    reason,
    expires_at: new Date(expiresAtMs).toISOString(),
    stat_mtime_ms: stat.mtimeMs,
  };
}

function clearExpiredPause(file, options = {}) {
  const fsApi = options.fsApi || fs;
  const state = pauseState(file, options);
  if (state.exists && state.expired) {
    try {
      // Identity-checked deletion: a pause renewed (rewritten) between
      // evaluation and deletion has a newer mtime and must survive (Codex
      // review bcd58db8151d).
      const current = fsApi.statSync(file);
      if (current.mtimeMs !== state.stat_mtime_ms) {
        // A renewed pause is ACTIVE again, not expired: returning the stale
        // expired verdict made the CLI print `expired` and the runner proceed
        // straight through a live bench (Codex review 12103d9f3576).
        return {
          ...pauseState(file, options),
          cleared: false,
          renewed: true,
        };
      }
      fsApi.rmSync(file, { force: true });
      return { ...state, cleared: true };
    } catch {
      return { ...state, cleared: false };
    }
  }
  return { ...state, cleared: false };
}

function main(argv = process.argv.slice(2)) {
  const argValue = (name, fallback = '') => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : fallback;
  };
  const fileIndex = argv.indexOf('--file');
  const file = fileIndex >= 0 ? argv[fileIndex + 1] : '';
  if (!file) {
    process.stderr.write(
      'usage: otter-healer-pause.js --file <pause-file> [--create|--clear-expired|--quarantine-stale-invalid]\n',
    );
    process.exitCode = 1;
    return;
  }
  if (argv.includes('--create')) {
    const pause = createPause(file, {
      owner: argValue('--owner'),
      reason: argValue('--reason'),
      token: argValue('--token') || crypto.randomUUID(),
      ttlHours: Number(argValue('--ttl-hours', DEFAULT_TTL_HOURS)),
    });
    process.stdout.write(`${JSON.stringify(pause)}\n`);
    return;
  }
  if (argv.includes('--quarantine-stale-invalid')) {
    const deployLockFile = argValue('--deploy-lock-file', '/tmp/secondbrain-deploy.lock');
    const outcome = quarantineStaleInvalidPause(file, {
      quarantineDir: argValue('--quarantine-dir'),
      reportFile: argValue('--report-file'),
      tasksDir: argValue('--tasks-dir'),
      locksHeld: argv.includes('--locks-held'),
      blockedReason: argValue('--blocked-reason'),
      deployLockActive: fs.existsSync(deployLockFile),
    });
    process.stdout.write(`${JSON.stringify(outcome)}\n`);
    return;
  }
  const state = argv.includes('--clear-expired') ? clearExpiredPause(file) : pauseState(file);
  if (!state.exists) process.stdout.write('none\n');
  else if (state.active) process.stdout.write('active\n');
  else process.stdout.write(state.cleared ? 'expired-cleared\n' : 'expired\n');
  if (state.exists) {
    process.stderr.write(
      `[otter-healer-pause] ${file} owner=${state.owner || '?'} expires_at=${state.expires_at} active=${state.active}\n`,
    );
  }
}

if (require.main === module) main();

module.exports = {
  DEFAULT_TTL_HOURS,
  PAUSE_SCHEMA,
  RECOVERY_SCHEMA,
  activeOwnerProcesses,
  activeOwnerTasks,
  clearExpiredPause,
  createPause,
  ownerHintFromInvalidContent,
  pauseState,
  quarantineStaleInvalidPause,
  reconcilePreparedRecoveries,
  writeFileAtomic,
  writeJsonAtomic,
};
