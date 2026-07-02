#!/usr/bin/env node
'use strict';

/**
 * C4 deploy-parity probe (Codex amendment 3, item W3a, ExampleCo 2026-07-02).
 *
 * Code executes from TWO EC2 roots: the build-path git checkout
 * (/home/ec2-user/secondbrain-current, used by cron for self-heal/briefing)
 * and the file-copy live root (/opt/secondbrain, served by PM2). Manual
 * partial deploys mean stale code can run silently. This probe compares:
 *
 *   (a) git HEAD parity   -- origin/master HEAD vs build-path checkout HEAD.
 *   (b) file-content parity -- CRLF-normalized sha256 of repo ec2-server.js vs
 *       /opt/secondbrain/server.js, and every LIVE_DEPS file (parsed straight
 *       out of scripts/deploy-ec2-server.sh so the lists can never drift) vs
 *       its /opt copy.
 *   (c) ACTIVE-PROCESS parity -- the PM2 process start time vs the live
 *       server.js mtime. Codex: file hashes alone are NOT enough, because PM2
 *       can still be running old in-memory code even after the on-disk file
 *       is updated. A server file newer than the process start means
 *       deployed-but-not-restarted.
 *
 * False-red mitigations (Codex amendment 3):
 *   - double-read: any drifted file is re-checked once after a short delay in
 *     the SAME run; only drift that survives BOTH reads is reported, so a
 *     probe that races an in-flight `scp` never reports a false red.
 *   - deploy-lock suppression: while /tmp/secondbrain-deploy.lock exists (the
 *     lock deploy-ec2-server.sh now creates/removes around its own run) all
 *     drift is suppressed into a non-blocking ok report, because a real
 *     deploy is expected to leave files momentarily out of sync.
 *
 * Output: JSON {ok, drift:[{file, kind}]} written to
 * data/agent/deploy-parity-latest.json. Zero external deps (git + fs only).
 * Best-effort: any probe stage that cannot run reports itself as drift with
 * an honest reason rather than throwing, EXCEPT top-level unexpected errors,
 * which still degrade to a written {ok:false} artifact so a missing/failed
 * run is never silently indistinguishable from a clean run.
 *
 * Usage: node scripts/verify-deploy-parity.js [--json]
 * Exit 0 = ok (or suppressed by an in-progress deploy), 1 = real drift found.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  checkGitHeadParity,
  checkFileParity,
  checkActiveProcessParity,
  buildParityReport,
} = require('./lib/deploy-parity-check.js');
const { readLiveDeps } = require('./lib/live-deps-parser.js');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEPLOY_LOCK_PATH = process.env.SECONDBRAIN_DEPLOY_LOCK || '/tmp/secondbrain-deploy.lock';
const DOUBLE_READ_DELAY_MS = Number(process.env.DEPLOY_PARITY_DOUBLE_READ_MS || 2000);

function resolveDataDir(opts = {}) {
  return opts.dataDir || process.env.SECONDBRAIN_DATA_DIR || path.join(REPO_ROOT, 'data');
}

function safeReadFile(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function safeMtimeMs(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

function gitHead(cwd) {
  try {
    return execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      timeout: 10000,
    }).trim();
  } catch {
    return null;
  }
}

function gitRemoteHead(cwd) {
  // origin/master as tracked by the build-path checkout's own remote refs
  // (fetched by cron/deploy elsewhere; this probe does not fetch, it only reads).
  try {
    return execFileSync('git', ['-C', cwd, 'rev-parse', 'origin/master'], {
      encoding: 'utf8',
      timeout: 10000,
    }).trim();
  } catch {
    return null;
  }
}

function pm2ProcessStartMs(processName) {
  try {
    const out = execFileSync('pm2', ['jlist'], {
      encoding: 'utf8',
      timeout: 15000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const procs = JSON.parse(out);
    const proc = Array.isArray(procs) ? procs.find((p) => p.name === processName) : null;
    const uptime = proc && proc.pm2_env && proc.pm2_env.pm_uptime;
    return Number.isFinite(uptime) ? uptime : null;
  } catch {
    return null;
  }
}

/**
 * Run every parity check ONCE and return the raw check results (before
 * double-read confirmation or lock suppression). Pulled out as its own
 * function so main() can call it twice for the double-read pass.
 */
function runChecksOnce({ buildPathRoot, liveRoot, pm2ProcessName }) {
  const checks = [];

  checks.push(
    checkGitHeadParity({
      originMasterHead: gitRemoteHead(buildPathRoot),
      buildPathHead: gitHead(buildPathRoot),
    }),
  );

  const liveDeps = readLiveDeps(REPO_ROOT);
  const fileList = ['ec2-server.js', ...liveDeps];
  for (const rel of fileList) {
    const repoPath = path.join(REPO_ROOT, rel);
    // ec2-server.js deploys to server.js on the live host (PM2 entrypoint);
    // every other LIVE_DEPS entry keeps its own repo-relative path under /opt.
    const livePath =
      rel === 'ec2-server.js'
        ? path.join(liveRoot, 'server.js')
        : path.join(liveRoot, rel);
    checks.push(
      checkFileParity({
        file: rel,
        repoContent: safeReadFile(repoPath),
        liveContent: safeReadFile(livePath),
      }),
    );
  }

  checks.push(
    checkActiveProcessParity({
      serverMtimeMs: safeMtimeMs(path.join(liveRoot, 'server.js')),
      pm2StartMs: pm2ProcessStartMs(pm2ProcessName),
    }),
  );

  return checks;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Full probe run with the double-read false-red mitigation: any file that
 * drifted on the first pass is re-checked once after a short delay, and only
 * drift confirmed on BOTH passes survives into the report. git-head and
 * active-process checks are cheap and stable (no in-flight-scp race), so they
 * are taken from the first pass directly.
 */
async function runParityProbe(opts = {}) {
  const buildPathRoot =
    opts.buildPathRoot || process.env.SECONDBRAIN_BUILD_PATH_ROOT || '/home/ec2-user/secondbrain-current';
  const liveRoot = opts.liveRoot || process.env.SECONDBRAIN_LIVE_ROOT || '/opt/secondbrain';
  const pm2ProcessName = opts.pm2ProcessName || 'secondbrain-backend';
  const lockPath = opts.lockPath || DEPLOY_LOCK_PATH;
  const doubleReadDelayMs = opts.doubleReadDelayMs != null ? opts.doubleReadDelayMs : DOUBLE_READ_DELAY_MS;

  const firstPass = runChecksOnce({ buildPathRoot, liveRoot, pm2ProcessName });
  const drifted = firstPass.filter((c) => !c.ok);

  let confirmedChecks = firstPass;
  if (drifted.length && doubleReadDelayMs > 0) {
    await sleep(doubleReadDelayMs);
    const secondPass = runChecksOnce({ buildPathRoot, liveRoot, pm2ProcessName });
    const secondByFile = new Map(
      secondPass.filter((c) => !c.ok).map((c) => [c.drift.file + ':' + c.drift.kind, c]),
    );
    // A check only stays "failed" if it also failed on the second read.
    confirmedChecks = firstPass.map((c) => {
      if (c.ok) return c;
      const key = c.drift.file + ':' + c.drift.kind;
      return secondByFile.has(key) ? c : { ok: true, kind: c.kind };
    });
  }

  const lockExists = fs.existsSync(lockPath);
  const report = buildParityReport(confirmedChecks, { lockExists });
  return {
    ...report,
    checkedAt: new Date().toISOString(),
    buildPathRoot,
    liveRoot,
    pm2ProcessName,
  };
}

async function main() {
  const dataDir = resolveDataDir();
  const outPath = path.join(dataDir, 'agent', 'deploy-parity-latest.json');
  let report;
  try {
    report = await runParityProbe();
  } catch (e) {
    report = {
      ok: false,
      drift: [
        {
          file: 'verify-deploy-parity.js',
          kind: 'probe-error',
          detail: String((e && e.message) || e).slice(0, 300),
        },
      ],
      suppressed: false,
      checkedAt: new Date().toISOString(),
    };
  }

  try {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  } catch {
    /* read-only fs is fine; the printed report is still useful */
  }

  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    console.log(`Deploy parity: ${report.ok ? 'OK' : 'DRIFT'}${report.suppressed ? ' (suppressed: deploy in progress)' : ''}`);
    for (const d of report.drift || []) {
      console.log(`  DRIFT [${d.kind}] ${d.file}: ${d.detail}`);
    }
  }

  process.exit(report.ok ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = { runParityProbe, runChecksOnce, resolveDataDir };
