#!/usr/bin/env node
// heal-tests.js
//
// Runs the full vitest suite and writes every failing assertion to
// data/agent/tests-blocked.json so the briefing's Tests probe renders
// each one as a one-click "approve to skip" row instead of saying "ExampleCo
// must classify" forever.
//
// Closes ExampleCo 2026-04-26 Otter dispatch: "Heal disabled for the test
// suite, because flaky failures need ExampleCo to classify real bug versus
// noise. So what question are you asking me? You need to actually ask me
// a question and let it show up in the briefing, and I can answer you
// right there."
//
// Output (one JSON file the dashboard can read):
//   data/agent/tests-blocked.json -- { ranAt, total, failed, items:[{file, name, error, suggestSkip}] }
//
// Run modes:
//   node scripts/heal-tests.js              # full run, exit
//   node scripts/heal-tests.js --quick      # only run tests that failed last run
//   node scripts/heal-tests.js --loop       # re-run every 30 min until green or
//                                            max-attempts (default 8). Each run
//                                            appends to data/agent/heal-tests-runs.jsonl
//                                            so the briefing claim of "looping
//                                            on this until clean" is verifiable
//                                            instead of fabricated. ExampleCo
//                                            2026-04-28 #gap.

const fs = require('fs');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const repair = require('./heal-tests-repair.js');

const REPO = path.resolve(__dirname, '..');
const OUT_PATH = path.join(REPO, 'data', 'agent', 'tests-blocked.json');
const RUNS_LOG = path.join(REPO, 'data', 'agent', 'heal-tests-runs.jsonl');
const LOCK_PATH = path.join(REPO, 'data', 'agent', 'heal-tests.lock.json');

function ensureDir(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

// 2026-05-08 silent-fake-green fix: vitest --outputFile= strips backslashes
// on Windows, so an absolute path like C:\\Users\\... lands at the mangled
// C:UsersExampleCodsecondbraindataagentvitest-heal-output.json (path.join then
// treats it as relative). Pass forward slashes so vitest writes to the
// expected file. Pinned by scripts/__tests__/heal-tests-output-path.test.js.
function vitestSafeOutputFile(p) {
  return String(p).replace(/\\/g, '/');
}
module.exports.vitestSafeOutputFile = vitestSafeOutputFile;

// 2026-05-08 npx-cmd Windows fix: spawnSync('npx.cmd', ...) without shell:true
// drops --reporter=json output silently on Windows (foreground npx.cmd vitest
// works in 30s, spawnSync of the same args produces an empty stdout and never
// writes the output file, so heal-tests sees parseError every loop attempt).
// Bypass the shim by invoking node node_modules/vitest/vitest.mjs directly.
// Pinned by scripts/__tests__/heal-tests-output-path.test.js.
function buildVitestSpawnArgs(outputFileArg, presentDirs, maxWorkers = '2') {
  const args = [
    'node_modules/vitest/vitest.mjs',
    'run',
    '--reporter=json',
    `--outputFile=${outputFileArg}`,
  ];
  if (maxWorkers) args.push(`--maxWorkers=${maxWorkers}`);
  args.push(...presentDirs.map((d) => d + '/'));
  return args;
}
module.exports.buildVitestSpawnArgs = buildVitestSpawnArgs;

const args = process.argv.slice(2);
const QUICK = args.includes('--quick');
const LOOP = args.includes('--loop');
const LOOP_MAX_ATTEMPTS = parseInt(args.find((a) => a.startsWith('--max='))?.slice(6) || '8', 10);
const LOOP_INTERVAL_MS = parseInt(
  args.find((a) => a.startsWith('--interval='))?.slice(11) || '1800000',
  10,
); // default 30 min
// 2026-05-17 #gap: 600000 (10 min) was too tight. The 22:00 nightly loop
// timed out on attempt 1 two nights running (05/16 + 05/17), and
// shouldRetryLoopRun refuses to retry a runner failure, so the whole loop
// aborted and the briefing's "looping on this" claim was fabricated.
// 20 min gives the full 2419-test suite headroom even under nighttime load.
const DEFAULT_VITEST_TIMEOUT_MS = 1200000;
// powershell.exe Win32_Process CommandLine enumeration is slow under load;
// the old 30s timeout ETIMEDOUT'd every cleanup pass on 05/16 + 05/17.
const CLEANUP_TIMEOUT_MS = 120000;
const VITEST_TIMEOUT_MS = parseInt(
  process.env.HEAL_TESTS_TIMEOUT_MS || String(DEFAULT_VITEST_TIMEOUT_MS),
  10,
);
const VITEST_MAX_WORKERS = process.env.HEAL_TESTS_MAX_WORKERS || '2';
module.exports.DEFAULT_VITEST_TIMEOUT_MS = DEFAULT_VITEST_TIMEOUT_MS;
module.exports.CLEANUP_TIMEOUT_MS = CLEANUP_TIMEOUT_MS;

// 2026-05-08 escape hatch: HEAL_TESTS_DIRS=dir1,dir2 lets the scheduled
// task skip a directory that's hanging vitest (the 22:00 nightly hit a
// worker leak in tests/ that pinned 36 node processes with no progress).
// Defaults remain unchanged. Pinned by scripts/__tests__/heal-tests-output-path.test.js.
const DEFAULT_TEST_DIRS = ['src/main/__tests__', 'tests'];
function resolveTestDirs(envVal, defaults = DEFAULT_TEST_DIRS) {
  if (!envVal) return defaults.slice();
  return envVal
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
module.exports.resolveTestDirs = resolveTestDirs;
const TEST_DIRS = resolveTestDirs(process.env.HEAL_TESTS_DIRS);
const presentDirs = TEST_DIRS.filter((d) => {
  try {
    return fs.statSync(path.join(REPO, d)).isDirectory();
  } catch {
    return false;
  }
});
if (presentDirs.length === 0) {
  console.error('no test dirs found');
  process.exit(1);
}

function appendRunLog(entry) {
  ensureDir(RUNS_LOG);
  fs.appendFileSync(
    RUNS_LOG,
    JSON.stringify({
      ts: new Date().toISOString(),
      ...entry,
    }) + '\n',
  );
}

function psSingleQuote(s) {
  return String(s).replace(/'/g, "''");
}

function cleanupVitestProcesses(reason) {
  if (process.platform !== 'win32') return 0;
  const repoWin = psSingleQuote(REPO);
  const repoSlash = psSingleQuote(vitestSafeOutputFile(REPO));
  const script = `
$repoWin = '${repoWin}'
$repoSlash = '${repoSlash}'
$all = @(Get-CimInstance Win32_Process -Filter "name = 'node.exe'")
$healParents = @($all | Where-Object {
  $cmd = [string]$_.CommandLine
  (($cmd -like "*$repoWin*") -or ($cmd -like "*$repoSlash*")) -and
  ($cmd -like '*vitest*') -and
  ($cmd -like '*vitest-heal-output.json*')
} | Select-Object -ExpandProperty ProcessId)
$matches = @($all | Where-Object {
  $cmd = [string]$_.CommandLine
  $isHealParent = $healParents -contains $_.ProcessId
  $isHealWorker = ($healParents -contains $_.ParentProcessId) -and
    (($cmd -like '*workers\\\\forks.js*') -or ($cmd -like '*workers/forks.js*'))
  $isHealParent -or $isHealWorker
})
foreach ($p in $matches) {
  try { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
}
($matches | Select-Object -ExpandProperty ProcessId) -join ','
`;
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      {
        encoding: 'utf8',
        timeout: CLEANUP_TIMEOUT_MS,
        windowsHide: true,
      },
    ).trim();
    if (!out) return 0;
    const count = out.split(',').filter(Boolean).length;
    console.warn(`[heal-tests] cleaned ${count} stale vitest process(es) after ${reason}: ${out}`);
    return count;
  } catch (e) {
    console.warn(
      `[heal-tests] stale vitest cleanup failed after ${reason}: ${String(e.message || e).slice(0, 160)}`,
    );
    return 0;
  }
}

function killProcessTree(pid, reason) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    cleanupVitestProcesses(reason);
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {}
}

function isPidAlive(pid) {
  if (!pid || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Maximum legitimate wall time for a loop, derived from the lock's own argv.
// A crashed run can leave a lock no other run will clear, because on Windows
// process.kill(pid, 0) returns success for dead/recycled pids (2026-06-09
// #gap: pid 25184 reported alive with zero node.exe running). pid-liveness
// therefore cannot be the only staleness signal -- a lock must also expire by
// age so a crash can never disable the loop for longer than one full run.
function maxLockWallMs(argv) {
  const joined = (Array.isArray(argv) ? argv : []).map(String).join(' ');
  const num = (re, fallback) => {
    const m = joined.match(re);
    return m ? Number(m[1]) : fallback;
  };
  const max = num(/--max=(\d+)/, 8);
  const interval = num(/--interval=(\d+)/, 1800000);
  // every attempt can burn an interval of sleep + a full vitest timeout,
  // plus a 30-min buffer for cleanup/load. Fallback ~6h when argv is absent.
  return max * interval + max * DEFAULT_VITEST_TIMEOUT_MS + 30 * 60 * 1000;
}
module.exports.maxLockWallMs = maxLockWallMs;

function isLockStale(lock, now = Date.now(), pidAlive = isPidAlive) {
  if (!lock || typeof lock !== 'object') return true;
  if (!pidAlive(lock.pid)) return true;
  const started = Date.parse(lock.startedAt);
  if (!Number.isFinite(started)) return true;
  return now - started > maxLockWallMs(lock.argv);
}
module.exports.isLockStale = isLockStale;

function acquireLock() {
  ensureDir(LOCK_PATH);
  if (fs.existsSync(LOCK_PATH)) {
    try {
      const lock = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf-8'));
      if (!isLockStale(lock)) {
        console.warn(
          `[heal-tests] another heal-tests run is active (pid ${lock.pid}, started ${lock.startedAt}); skipping`,
        );
        appendRunLog({
          attempt: 0,
          loopMode: LOOP,
          total: 0,
          failed: 0,
          fileCount: 0,
          skipped: true,
          reason: 'lock-held',
          pid: lock.pid,
          startedAt: lock.startedAt,
        });
        return false;
      }
      console.warn(
        `[heal-tests] taking over stale lock (pid ${lock.pid}, started ${lock.startedAt})`,
      );
    } catch {
      /* stale or corrupt lock */
    }
  }
  fs.writeFileSync(
    LOCK_PATH,
    JSON.stringify(
      {
        pid: process.pid,
        startedAt: new Date().toISOString(),
        argv: process.argv.slice(2),
      },
      null,
      2,
    ),
  );
  return true;
}

function releaseLock() {
  try {
    const lock = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf-8'));
    if (lock.pid === process.pid) fs.unlinkSync(LOCK_PATH);
  } catch {
    /* ignore */
  }
}

function shouldRetryLoopRun(result, attempt, maxAttempts) {
  if (result.runnerFailed) return false;
  return !result.ok && attempt < maxAttempts;
}
module.exports.shouldRetryLoopRun = shouldRetryLoopRun;

function runOnce(attempt) {
  // 2026-05-02 ExampleCo #gap: same vitest-truncation bug fixed in manual-briefing-v3.js.
  // execSync timeout SIGTERM-s vitest mid-run, and buffered stdout has no
  // closing brace. --outputFile makes vitest write the JSON to disk so the
  // result survives a SIGTERM.
  const outputFile = path.join(REPO, 'data', 'agent', 'vitest-heal-output.json');
  try {
    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  } catch {}
  try {
    fs.unlinkSync(outputFile);
  } catch {}
  const outputFileArg = vitestSafeOutputFile(outputFile);
  // 2026-06-10: reap leaked codex/claude worker orphans BEFORE running vitest.
  // The morning the briefing shipped 4h late, those orphans thrashed the box so
  // badly the test runner timed out and reported ~15 FLAKY failures; the heal
  // loop kept re-running on the still-thrashed box and never converged. Reaping
  // first means each attempt runs on a clean box, so a flake self-resolves on
  // the next pass instead of masquerading as a real regression.
  // (feedback_codex_orphan_leak_thrashes_briefing.md)
  try {
    const reaper = path.join(__dirname, 'reap-orphan-codex-claude.mjs');
    if (fs.existsSync(reaper)) {
      spawnSync(process.execPath, [reaper], {
        encoding: 'utf8',
        timeout: 60000,
        windowsHide: true,
      });
    }
  } catch {
    // fail-soft: never block the test run on the reaper
  }
  cleanupVitestProcesses('pre-run');
  const spawnArgs = buildVitestSpawnArgs(outputFileArg, presentDirs, VITEST_MAX_WORKERS);
  const cmd = `node ${spawnArgs.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)).join(' ')}`;
  console.log(`[heal-tests${LOOP ? ' loop attempt ' + attempt : ''}] ${cmd}`);
  let raw = '';
  let timedOut = false;
  // 2026-05-07: use spawnSync without a shell so Windows does not open a
  // visible cmd.exe for the scheduled health probe. 2026-05-08: run node
  // directly on vitest.mjs so we don't depend on the npx.cmd shim that
  // silently swallowed stdio under spawnSync.
  const result = spawnSync(process.execPath, spawnArgs, {
    encoding: 'utf8',
    timeout: VITEST_TIMEOUT_MS,
    cwd: REPO,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  timedOut = !!(result.error && /ETIMEDOUT|killed|SIGTERM/i.test(result.error.message || ''));
  if (timedOut) killProcessTree(result.pid, 'vitest timeout');
  cleanupVitestProcesses('post-run');
  raw = result.stdout || '';

  let j;
  if (fs.existsSync(outputFile)) {
    try {
      j = JSON.parse(fs.readFileSync(outputFile, 'utf-8'));
    } catch {
      /* fall through to stdout regex */
    }
  }
  if (!j) {
    const match = raw.match(/\{[\s\S]*\}\s*$/);
    if (!match) {
      const reason = timedOut
        ? `vitest timed out (>${Math.round(VITEST_TIMEOUT_MS / 1000)}s)`
        : 'no JSON parsed';
      console.error(reason);
      appendRunLog({
        attempt: LOOP ? attempt : 0,
        loopMode: LOOP,
        total: 0,
        failed: 0,
        fileCount: 0,
        parseError: reason,
        runnerFailed: true,
        command: cmd,
      });
      return { ok: false, total: 0, failed: 0, items: [], parseError: reason, runnerFailed: true };
    }
    try {
      j = JSON.parse(match[0]);
    } catch (e) {
      const reason = 'json parse: ' + e.message.slice(0, 120);
      appendRunLog({
        attempt: LOOP ? attempt : 0,
        loopMode: LOOP,
        total: 0,
        failed: 0,
        fileCount: 0,
        parseError: reason,
        runnerFailed: true,
        command: cmd,
      });
      return { ok: false, total: 0, failed: 0, items: [], parseError: reason, runnerFailed: true };
    }
  }
  const results = j.testResults || j.testFiles || [];

  let total = 0;
  let failed = 0;
  const items = [];
  for (const r of results) {
    const fileBase = (r.name || r.filepath || r.testFilePath || 'ExampleCo').replace(/^.*[\\/]/, '');
    const tests = r.assertionResults || r.tasks || [];
    total += tests.length;
    for (const t of tests) {
      const state = t.status || (t.result && t.result.state);
      if (state !== 'failed') continue;
      failed++;
      const errs =
        t.failureMessages ||
        (t.result && t.result.errors && t.result.errors.map((e) => e.message)) ||
        [];
      const fullErr = String(errs[0] || '');
      items.push({
        file: fileBase,
        name: t.title || t.fullName || t.name || 'ExampleCo',
        // Keep the short error for the dashboard tile (first line, <= 220 chars).
        error: fullErr.split('\n')[0].slice(0, 220),
        // 2026-05-27: also keep the full failure message (up to 4000 chars)
        // so the repair module's extractOffendingPathsFromTail can find
        // the array-form diff body. Previously the diff was truncated and
        // the completeness-guard auto-untrack never had the path to fix.
        errorDetail: fullErr.slice(0, 4000),
        suggestSkip:
          /to contain|to match|to be|toEqual|toBe/i.test(fullErr) &&
          !/TypeError|ReferenceError|undefined/i.test(fullErr),
      });
    }
  }

  const out = {
    ranAt: new Date().toISOString(),
    total,
    passed: total - failed,
    failed,
    files: results.length,
    items: items.slice(0, 200),
    command: cmd,
    attempt: LOOP ? attempt : null,
    loopMode: LOOP,
    next:
      failed === 0
        ? 'All green. Nothing to classify.'
        : 'Each item below is a click-through approval in the briefing -- "skip with reason" or "open file to fix".',
  };

  ensureDir(OUT_PATH);
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
  console.log(`wrote ${OUT_PATH} (${failed} failing of ${total} total)`);

  // Append to runs log so the briefing's "looping on this" claim is verifiable.
  // Without this log entry, the next briefing claim is fabrication. ExampleCo 2026-04-28 #gap.
  appendRunLog({
    attempt: LOOP ? attempt : 0,
    loopMode: LOOP,
    total,
    failed,
    fileCount: results.length,
    command: cmd,
  });

  return { ok: failed === 0, total, failed, items };
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Guard the IIFE so `require('./heal-tests.js')` from the regression test
// does not kick off a vitest run.
if (require.main === module)
  (async () => {
    if (!acquireLock()) process.exit(0);
    process.on('exit', releaseLock);
    process.on('SIGINT', () => {
      releaseLock();
      process.exit(130);
    });
    process.on('SIGTERM', () => {
      releaseLock();
      process.exit(143);
    });

    if (!LOOP) {
      const r = runOnce(1);
      if (QUICK && r.ok) console.log('quick exit: 0 failures');
      process.exit(r.ok ? 0 : 0); // exit 0 either way -- failures are recorded in tests-blocked.json
    }

    // Loop mode: keep re-running until green, no-progress, or max-attempts.
    //
    // 2026-05-23 root-cause fix: the prior loop ran all 8 attempts even when
    // every attempt produced identical failures, wasting ~4 hours of wall time
    // and CPU while making the briefing claim "no self-heal attempt completed
    // inside the overnight window." The truth was 8 attempts DID complete; they
    // just had no repair capability. Two new exit conditions make the loop
    // honest and fast:
    //
    //   (a) No-progress early exit: if two consecutive attempts have identical
    //       failing-test signatures, stop. Re-running vitest does not magically
    //       repair a real regression; emit an honest exit so the briefing can
    //       say "loop exited at attempt N because failures did not change."
    //
    //   (b) Deadline awareness: HEAL_TESTS_DEADLINE_CT=HH:MM (e.g. 05:15) stops
    //       the loop if the next sleep would push the attempt past the briefing
    //       window. Default 05:15 CT, before the 05:30/05:46 briefing build.
    function failingSignature(r) {
      if (!r || !Array.isArray(r.items)) return '';
      return r.items
        .map((it) => `${it.file}::${it.name}`)
        .sort()
        .join('|');
    }
    function parseDeadlineToTodayCt(spec) {
      const m = String(spec || '').match(/^([0-2]?\d):([0-5]\d)$/);
      if (!m) return null;
      const hh = parseInt(m[1], 10);
      const mm = parseInt(m[2], 10);
      // Convert local time to a wall-clock check using America/Chicago. We
      // compute the deadline as a Date in the runner's local TZ; CT==local on
      // ExampleCo's Windows box, so a naive Date is correct here. Document the
      // assumption and trip loudly if it ever runs somewhere else.
      const now = new Date();
      const dl = new Date(now);
      dl.setHours(hh, mm, 0, 0);
      // If we already passed the deadline today, the deadline is for the next
      // day (the loop spans midnight).
      if (dl.getTime() < now.getTime()) dl.setDate(dl.getDate() + 1);
      return dl;
    }
    const deadline = parseDeadlineToTodayCt(process.env.HEAL_TESTS_DEADLINE_CT || '05:15');

    let prevSignature = null;
    let lastRepairResult = null;
    for (let attempt = 1; attempt <= LOOP_MAX_ATTEMPTS; attempt++) {
      const r = runOnce(attempt);
      if (r.ok) {
        console.log(`[heal-tests loop] GREEN at attempt ${attempt} -- exiting`);
        if (lastRepairResult && lastRepairResult.repaired > 0) {
          console.log(
            `[heal-tests loop] repair pass closed ${lastRepairResult.repaired} item(s) before this green attempt: ${lastRepairResult.actions
              .filter((a) => a.ok)
              .map((a) => a.action)
              .join(' | ')}`,
          );
        }
        process.exit(0);
      }
      if (attempt === LOOP_MAX_ATTEMPTS) {
        console.warn(
          `[heal-tests loop] reached max attempts (${LOOP_MAX_ATTEMPTS}) with ${r.failed} still failing -- exiting non-green`,
        );
        process.exit(0);
      }
      if (!shouldRetryLoopRun(r, attempt, LOOP_MAX_ATTEMPTS)) {
        console.warn(
          `[heal-tests loop] runner failed (${r.parseError || 'ExampleCo'}); not retrying tonight to avoid orphaned vitest workers`,
        );
        process.exit(0);
      }
      // Repair pass: between attempts, try to actually fix what failed.
      // Closes the 2026-05-23 ExampleCo gap: the loop was re-running vitest
      // with no repair capability, so 8 attempts produced identical
      // failures. The repair module handles three safe categories
      // (completeness-guard tracked-runtime-file, pii-screen public-sync
      // hits with known-private surfaces, stale-assert queue-for-human)
      // and leaves anything else escalated.
      const blocked = (() => {
        try {
          return JSON.parse(fs.readFileSync(OUT_PATH, 'utf8'));
        } catch {
          return null;
        }
      })();
      if (blocked) {
        try {
          const rep = repair.runRepairPass(blocked, { dryRun: false });
          lastRepairResult = rep;
          console.log(
            `[heal-tests loop] repair pass: repaired=${rep.repaired}, queued=${rep.queued}, escalated=${rep.escalated}, skipRecommendations=${rep.skipRecommendations || 0}`,
          );
          for (const a of rep.actions) {
            console.log(`  - ${a.ok ? 'OK' : 'SKIP'}: ${a.item}: ${a.action || a.reason}`);
          }
          appendRunLog({
            attempt,
            loopMode: true,
            total: r.total,
            failed: r.failed,
            fileCount: 0,
            repairPass: {
              repaired: rep.repaired,
              queued: rep.queued,
              escalated: rep.escalated,
              skipRecommendations: rep.skipRecommendations || 0,
            },
          });
          if (rep.repaired > 0) {
            // Skip the 30-min sleep and retry immediately so the green
            // run lands on the next attempt.
            console.log(
              `[heal-tests loop] ${rep.repaired} item(s) auto-repaired -- retrying immediately without the ${LOOP_INTERVAL_MS / 60000}m sleep`,
            );
            continue;
          }
        } catch (e) {
          console.warn(
            `[heal-tests loop] repair pass threw, continuing: ${String(e.message || e).slice(0, 160)}`,
          );
        }
      }
      // (a) No-progress early exit (only if repair did nothing).
      const signature = failingSignature(r);
      if (prevSignature !== null && signature === prevSignature) {
        const skipCount = (lastRepairResult && lastRepairResult.skipRecommendations) || 0;
        const skipNote =
          skipCount > 0
            ? ` ${skipCount} skip-with-reason recommendation(s) were written to data/agent/auto-heal-skip-recommendations.jsonl; the briefing will surface each as a one-click triage entry.`
            : '';
        console.warn(
          `[heal-tests loop] no-progress early exit at attempt ${attempt} -- failing set unchanged from prior attempt (${r.failed} failing) and the repair pass had no automatable handler. Items have been queued for human triage in data/agent/auto-heal-needs-human.jsonl; the briefing will surface them.${skipNote}`,
        );
        appendRunLog({
          attempt,
          loopMode: true,
          total: r.total,
          failed: r.failed,
          fileCount: 0,
          earlyExit: 'no-progress',
          signature,
          skipRecommendations: skipCount,
        });
        process.exit(0);
      }
      prevSignature = signature;
      // (b) Deadline awareness.
      if (deadline) {
        const nextAttemptAt = Date.now() + LOOP_INTERVAL_MS;
        if (nextAttemptAt >= deadline.getTime()) {
          console.warn(
            `[heal-tests loop] deadline early exit at attempt ${attempt} -- next attempt at ${new Date(nextAttemptAt).toISOString()} would land past the heal-window deadline ${deadline.toISOString()}.`,
          );
          appendRunLog({
            attempt,
            loopMode: true,
            total: r.total,
            failed: r.failed,
            fileCount: 0,
            earlyExit: 'deadline',
            deadline: deadline.toISOString(),
          });
          process.exit(0);
        }
      }
      console.log(
        `[heal-tests loop] still ${r.failed} failing -- sleeping ${LOOP_INTERVAL_MS / 60000}m before next attempt`,
      );
      await sleep(LOOP_INTERVAL_MS);
    }
  })();
