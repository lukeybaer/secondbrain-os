#!/usr/bin/env node
'use strict';

// Installs the cron SHELL wrapper that records how every raw crontab job ended
// (owner decision S-4). See scripts/cron-job-shell.sh for the wrapper.
//
//   node scripts/install-cron-job-shell.js            dry run, prints the plan
//   node scripts/install-cron-job-shell.js --apply    install wrapper + SHELL line
//   node scripts/install-cron-job-shell.js --remove   delete only the SHELL line
//
// The wrapper is copied outside the release tree so a release swap or prune can
// never leave cron pointing at a missing shell. The crontab change is a single
// first line, SHELL=<wrapper>; every other byte (comments, % characters, other
// environment lines) is preserved exactly. The smoke test runs before the
// crontab is touched, so a broken wrapper can never become the shell for 30
// jobs. The kill switch needs no deploy: create
// <data>/agent/scheduled-job-ends/DISABLED and the wrapper records nothing.

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const WRAPPER_SOURCE = path.join(__dirname, 'cron-job-shell.sh');
const WRAPPER_DEST = '/opt/secondbrain-shared/bin/cron-job-shell';
const SHELL_LINE = `SHELL=${WRAPPER_DEST}`;
const SHELL_ASSIGNMENT_RE = /^[ \t]*SHELL[ \t]*=/;

// Pure. Returns { text, changed } or { refused }. Install puts SHELL_LINE first
// (removing a stale copy elsewhere); remove deletes only that exact line.
function planCrontab(original, { remove = false } = {}) {
  const text = String(original || '');
  const lines = text.split('\n');
  const foreign = lines.filter((line) => SHELL_ASSIGNMENT_RE.test(line) && line.trim() !== SHELL_LINE);
  if (foreign.length) {
    return {
      refused: `the crontab already sets SHELL to something else (${foreign[0].trim().slice(0, 120)}); it would override or be overridden`,
    };
  }
  const without = [];
  let removedAny = false;
  for (const line of lines) {
    if (line.trim() === SHELL_LINE && !removedAny) {
      removedAny = true;
      continue;
    }
    if (line.trim() === SHELL_LINE) continue;
    without.push(line);
  }
  const rest = without.join('\n');
  if (remove) return { text: rest, changed: rest !== text };
  const next = text === '' ? `${SHELL_LINE}\n` : `${SHELL_LINE}\n${rest}`;
  return { text: next, changed: next !== text };
}

function defaultReadCrontab() {
  const result = childProcess.spawnSync('crontab', ['-l'], { encoding: 'utf8' });
  if (result.status === 0) return String(result.stdout || '');
  // Only the explicit "no crontab" answer is an empty crontab. Any other failure
  // must never read as empty, or installing would erase every job.
  if (/no crontab/i.test(String(result.stderr || ''))) return '';
  throw new Error(`crontab -l failed: ${String(result.stderr || result.error || '').slice(0, 200)}`);
}

function defaultWriteCrontab(text) {
  const result = childProcess.spawnSync('crontab', ['-'], { input: text, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`crontab write failed: ${String(result.stderr || result.error || '').slice(0, 200)}`);
  }
}

// Runs the copied wrapper against a throwaway data dir so the smoke test never
// writes a row into production. Returns '' on success, otherwise the reason.
function defaultSmoke(wrapper) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cron-job-shell-smoke-'));
  const env = { ...process.env, SECONDBRAIN_DATA_DIR: dataDir };
  try {
    const exit7 = childProcess.spawnSync(wrapper, ['-c', 'exit 7'], { encoding: 'utf8', env });
    if (exit7.status !== 7) return `"-c 'exit 7'" returned ${exit7.status}, not 7`;
    const echo = childProcess.spawnSync(wrapper, ['-c', 'echo ok'], { encoding: 'utf8', env });
    if (echo.status !== 0 || String(echo.stdout).trim() !== 'ok') {
      return `"-c 'echo ok'" returned status ${echo.status} and output ${JSON.stringify(String(echo.stdout).slice(0, 60))}`;
    }
    return '';
  } catch (error) {
    return String(error && error.message ? error.message : error);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

function defaultCopyWrapper(source, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(source, dest);
  fs.chmodSync(dest, 0o755);
}

function defaultDiscard(file) {
  fs.rmSync(file, { force: true });
}

function run({
  argv = process.argv.slice(2),
  platform = process.platform,
  readCrontab = defaultReadCrontab,
  writeCrontab = defaultWriteCrontab,
  copyWrapper = defaultCopyWrapper,
  smoke = defaultSmoke,
  promote = fs.renameSync,
  discard = defaultDiscard,
  backup = () => {},
  log = (line) => process.stdout.write(`${line}\n`),
  err = (line) => process.stderr.write(`${line}\n`),
} = {}) {
  const apply = argv.includes('--apply');
  const remove = argv.includes('--remove');
  const refuse = (message) => {
    err(`[cron-job-shell] REFUSED: ${message}`);
    return 2;
  };
  if (platform !== 'linux') return refuse(`this installer only runs on linux, not ${platform}`);
  if (apply && remove) return refuse('--apply and --remove cannot be combined');

  let original;
  try {
    original = readCrontab();
  } catch (error) {
    return refuse(`${error.message}; the crontab is unchanged`);
  }
  const plan = planCrontab(original, { remove });
  if (plan.refused) return refuse(`${plan.refused}; the crontab is unchanged`);

  if (!apply && !remove) {
    log(`[cron-job-shell] dry run: would copy the wrapper to ${WRAPPER_DEST}, smoke test it, and ${plan.changed ? `put "${SHELL_LINE}" as the first crontab line` : 'leave the crontab as is (already installed)'}. Re-run with --apply.`);
    return 0;
  }

  if (remove) {
    if (!plan.changed) {
      log('[cron-job-shell] nothing to remove: the SHELL line is not in the crontab');
      return 0;
    }
    backup(original);
    writeCrontab(plan.text);
    log(`[cron-job-shell] removed "${SHELL_LINE}" from the crontab; every other line is unchanged`);
    return 0;
  }

  // Every cron job runs through the live path, so a new copy proves itself under
  // another name first. A failed upgrade leaves the old wrapper running.
  const staged = `${WRAPPER_DEST}.staged-${process.pid}`;
  try {
    copyWrapper(WRAPPER_SOURCE, staged);
  } catch (error) {
    try {
      discard(staged);
    } catch {
      /* nothing to clean up */
    }
    return refuse(`could not stage the wrapper at ${staged}: ${error.message}; the live wrapper and the crontab are unchanged`);
  }
  const smokeFailure = smoke(staged);
  if (smokeFailure) {
    try {
      discard(staged);
    } catch {
      /* the staged copy is never on any path cron reads */
    }
    return refuse(`wrapper smoke test failed, ${smokeFailure}; the live wrapper and the crontab are unchanged`);
  }
  try {
    promote(staged, WRAPPER_DEST);
  } catch (error) {
    return refuse(`could not move the wrapper into place at ${WRAPPER_DEST}: ${error.message}; the crontab is unchanged`);
  }
  if (!plan.changed) {
    log('[cron-job-shell] PASS: wrapper installed and smoke tested; the SHELL line was already the first crontab line');
    return 0;
  }
  backup(original);
  writeCrontab(plan.text);
  let after = null;
  try {
    after = readCrontab();
  } catch {
    after = null;
  }
  if (after === null || String(after).split('\n')[0] !== SHELL_LINE) {
    err('[cron-job-shell] FAIL: the SHELL line is not the first crontab line after the write (another editor raced this one); re-run');
    return 1;
  }
  log(`[cron-job-shell] PASS: wrapper smoke tested; "${SHELL_LINE}" is the first crontab line`);
  return 0;
}

if (require.main === module) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  const code = run({
    backup: (text) => {
      const file = path.join(path.dirname(path.dirname(WRAPPER_DEST)), `crontab.before-${stamp}`);
      try {
        fs.writeFileSync(file, text, 'utf8');
      } catch {
        /* the backup is a convenience; the change itself is reversible with --remove */
      }
    },
  });
  process.exit(code);
}

module.exports = { SHELL_LINE, WRAPPER_DEST, planCrontab, run };
