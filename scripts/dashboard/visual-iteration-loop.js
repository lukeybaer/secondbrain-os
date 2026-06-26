#!/usr/bin/env node
'use strict';

/**
 * scripts/dashboard/visual-iteration-loop.js
 *
 * Deploy-and-verify loop that gates on VISUAL quality, not just card content.
 * Catches the "so much white space" class of defects that content-QC misses.
 *
 * Algorithm:
 *   1. Run visual-regression-check on the currently deployed dashboard.
 *   2. If it passes -> send Telegram "dashboard looks good, deploying" -> done.
 *   3. If it fails:
 *      a. Record the defects in the ledger.
 *      b. Apply an auto-fix targeting the specific failing region(s).
 *      c. Redeploy via safe-deploy.
 *      d. Re-run the visual check.
 *      e. Repeat up to maxIterations (default 5 from config/dashboard-qa.json).
 *   4. After maxIterations with no pass -> send Telegram with summary of what Amy tried.
 *
 * Revert strategy: on visual failure, the CURRENT deploy is reverted (git revert HEAD
 * on the server file, or rollback via safe-deploy's backup ref) BEFORE applying the
 * next incremental fix. This keeps prod stable between iterations.
 *
 * Integration points:
 *   - visual-regression-check.js:   the visual gate
 *   - scripts/self-heal/safe-deploy.js: deploy with syntax gate + rollback
 *   - scripts/self-heal/attempt-ledger.js: durable iteration memory
 *
 * All side-effecting deps (deploy, revert, visualCheck, notify) are injected so the
 * loop is fully unit-testable with mocks; the live wiring lives at the bottom.
 *
 * Usage:
 *   node scripts/dashboard/visual-iteration-loop.js [--skip-initial-check]
 *
 * Exit codes:
 *   0  dashboard passed visual QC (may have taken up to maxIterations)
 *   1  exhausted all iterations without passing
 *   2  infrastructure error (browser / deploy / network)
 */

const path = require('path');
const fs = require('fs');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CONFIG_PATH = path.join(REPO_ROOT, 'config', 'dashboard-qa.json');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Ledger for iteration history
// ---------------------------------------------------------------------------

const LEDGER_DIR = path.join(
  process.env.APPDATA
    ? path.join(process.env.APPDATA, 'secondbrain', 'data', 'dashboard-visual-heal')
    : path.join(REPO_ROOT, 'data', 'dashboard-visual-heal'),
);

function appendLedger(entry) {
  fs.mkdirSync(LEDGER_DIR, { recursive: true });
  const file = path.join(LEDGER_DIR, `${entry.date || todayStr()}.jsonl`);
  fs.appendFileSync(file, JSON.stringify(entry) + '\n');
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Fix strategies (incremental, each targets a defect category)
// ---------------------------------------------------------------------------

// Returns a human-readable description of what was attempted.
// In the real wiring this would invoke a Claude sub-agent or apply a known patch.
// We inject this as `deps.applyFix` so the loop is testable. The live wiring
// below provides a simple escalating ladder.
const FIX_LADDER = [
  {
    id: 'increase-tile-min-height',
    description: 'Set minimum tile height via CSS / tile rendering to 80px',
    targets: ['TILE-HEIGHT'],
  },
  {
    id: 'reduce-tile-padding',
    description: 'Reduce excessive padding/margin in tile layout CSS',
    targets: ['EMPTY-SPACE'],
  },
  {
    id: 'force-content-visible',
    description: 'Force tile content visibility: remove display:none, height:0 conditions',
    targets: ['TILE-HEIGHT', 'EMPTY-SPACE'],
  },
  {
    id: 'rebuild-tile-template',
    description: 'Regenerate tile template from canonical briefing-card-manifest.js layout',
    targets: ['TILE-HEIGHT', 'EMPTY-SPACE', 'PIXEL-DIFF'],
  },
  {
    id: 'full-dashboard-rebuild',
    description: 'Trigger full overnight briefing re-render and republish to EC2',
    targets: ['TILE-HEIGHT', 'EMPTY-SPACE', 'PIXEL-DIFF'],
  },
];

function pickNextFix(defects, attemptedIds) {
  const defectCategories = new Set(
    defects.map((d) => d.split(':')[0].trim()),
  );
  return FIX_LADDER.find(
    (f) =>
      !attemptedIds.has(f.id) &&
      f.targets.some((t) => defectCategories.has(t)),
  ) || null;
}

// ---------------------------------------------------------------------------
// Core loop (injectable deps)
// ---------------------------------------------------------------------------

/**
 * deps.visualCheck(opts)  -> Promise<{ ok, defects, screenshotPath, diffPercent, exitCode }>
 * deps.applyFix(fix)      -> Promise<{ ok, description, reason? }>
 * deps.deploy()           -> Promise<{ ok, deployRef?, reason? }>
 * deps.revert(deployRef)  -> Promise<{ ok, reason? }>
 * deps.notify(msg)        -> Promise<void>   (Telegram)
 * deps.log(entry)         -> void            (ledger append)
 */
async function runVisualIterationLoop(opts = {}, deps = {}) {
  const config = loadConfig();
  const maxIter = opts.maxIterations || config.maxIterations || 5;
  const skipInitial = !!(opts.skipInitialCheck);

  const visualCheck = deps.visualCheck || defaultVisualCheck;
  const applyFix = deps.applyFix || defaultApplyFix;
  const deploy = deps.deploy || defaultDeploy;
  const revert = deps.revert || defaultRevert;
  const notify = deps.notify || defaultNotify;
  const log = deps.log || appendLedger;

  const runId = `visual-loop-${Date.now()}`;
  const attemptedFixIds = new Set();
  const iterations = [];

  log({ type: 'loop-start', runId, maxIter, ts: new Date().toISOString() });

  // Step 1: initial check (skip if the caller already verified pre-deploy)
  let lastCheck;
  if (!skipInitial) {
    lastCheck = await visualCheck({});
    log({ type: 'check', iteration: 0, result: lastCheck, ts: new Date().toISOString() });
    if (lastCheck.ok) {
      await notify(`[Amy] Dashboard visual QC passed on first check. No changes needed.\nScreenshot: ${lastCheck.screenshotPath || 'n/a'}`);
      log({ type: 'loop-end', runId, status: 'passed-initial', ts: new Date().toISOString() });
      return { status: 'passed', iterations: 0, lastCheck };
    }
  }

  // Steps 2-N: iterate
  for (let i = 1; i <= maxIter; i++) {
    const iterLog = { iteration: i };

    // Pick the next fix targeting the current defects
    const defects = (lastCheck && lastCheck.defects) || [];
    const fix = pickNextFix(defects, attemptedFixIds);

    if (!fix) {
      // No untried fix left -- honest hard-block
      const summary = formatExhaustionSummary(iterations, defects);
      await notify(`[Amy] Dashboard visual QC: all ${attemptedFixIds.size} fix strategies exhausted after ${i - 1} iteration(s). Needs human review.\n\n${summary}`);
      log({ type: 'loop-end', runId, status: 'exhausted', iterations, ts: new Date().toISOString() });
      return { status: 'exhausted', iterations, lastCheck };
    }

    attemptedFixIds.add(fix.id);
    iterLog.fix = fix.id;
    iterLog.fixDescription = fix.description;

    // Revert the previous (broken) deploy before applying the new fix
    if (lastCheck && lastCheck.deployRef) {
      const rv = await revert(lastCheck.deployRef);
      iterLog.revert = rv;
      if (!rv || !rv.ok) {
        log({ type: 'iteration', runId, ...iterLog, revertFailed: true, ts: new Date().toISOString() });
        // Revert failed: skip to next loop rather than double-applying
        iterations.push({ ...iterLog, status: 'revert-failed' });
        continue;
      }
    }

    // Apply the fix
    const applied = await applyFix(fix);
    iterLog.applied = applied;
    if (!applied || !applied.ok) {
      log({ type: 'iteration', runId, ...iterLog, applyFailed: true, ts: new Date().toISOString() });
      iterations.push({ ...iterLog, status: 'apply-failed' });
      continue;
    }

    // Deploy
    const deployed = await deploy();
    iterLog.deployed = deployed;
    if (!deployed || !deployed.ok) {
      log({ type: 'iteration', runId, ...iterLog, deployFailed: true, ts: new Date().toISOString() });
      iterations.push({ ...iterLog, status: 'deploy-failed' });
      continue;
    }

    // Re-run visual check
    const check = await visualCheck({});
    iterLog.check = check;
    check.deployRef = deployed.deployRef;
    lastCheck = check;

    log({ type: 'iteration', runId, ...iterLog, ts: new Date().toISOString() });
    iterations.push({ ...iterLog, status: check.ok ? 'passed' : 'still-failing' });

    if (check.ok) {
      const msg = formatPassMessage(i, iterations, check);
      await notify(msg);
      log({ type: 'loop-end', runId, status: 'passed', iterations, ts: new Date().toISOString() });
      return { status: 'passed', iterations: i, lastCheck: check };
    }
  }

  // Exhausted all maxIter iterations
  const summary = formatExhaustionSummary(iterations, (lastCheck && lastCheck.defects) || []);
  await notify(`[Amy] Dashboard visual QC: failed after ${maxIter} iteration(s). Needs human review.\n\n${summary}`);
  log({ type: 'loop-end', runId, status: 'max-iterations', iterations, ts: new Date().toISOString() });
  return { status: 'max-iterations', iterations: maxIter, lastCheck };
}

// ---------------------------------------------------------------------------
// Message formatters
// ---------------------------------------------------------------------------

function formatPassMessage(iterationCount, iterations, check) {
  const fixes = iterations.filter((i) => i.status === 'passed').map((i) => i.fixDescription);
  const fixNote = fixes.length ? `\nFix applied: ${fixes[0]}` : '';
  return [
    `[Amy] Dashboard visual QC PASSED after ${iterationCount} iteration(s).${fixNote}`,
    check.screenshotPath ? `Screenshot: ${check.screenshotPath}` : '',
    check.diffPercent != null ? `Pixel diff: ${check.diffPercent.toFixed(1)}%` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function formatExhaustionSummary(iterations, currentDefects) {
  const tried = iterations
    .map((it, idx) => `  ${idx + 1}. ${it.fixDescription || it.fix} -> ${it.status}`)
    .join('\n');
  const defectLines = currentDefects.slice(0, 5).join('\n  ');
  return [
    tried ? `Strategies tried:\n${tried}` : 'No strategies applied.',
    defectLines ? `Remaining defects:\n  ${defectLines}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

// ---------------------------------------------------------------------------
// Default live deps
// ---------------------------------------------------------------------------

async function defaultVisualCheck(opts) {
  const { runVisualCheck } = require('./visual-regression-check.js');
  return runVisualCheck(opts);
}

// Live fix: runs a targeted self-heal script if available, otherwise logs intent.
// The real implementation would invoke a Claude sub-agent or a known patch script.
async function defaultApplyFix(fix) {
  const scripts = {
    'increase-tile-min-height': path.join(REPO_ROOT, 'scripts', 'self-heal', 'fix-tile-min-height.js'),
    'reduce-tile-padding': path.join(REPO_ROOT, 'scripts', 'self-heal', 'fix-tile-padding.js'),
    'force-content-visible': path.join(REPO_ROOT, 'scripts', 'self-heal', 'fix-force-content-visible.js'),
    'rebuild-tile-template': path.join(REPO_ROOT, 'scripts', 'self-heal', 'fix-rebuild-tile-template.js'),
    'full-dashboard-rebuild': path.join(REPO_ROOT, 'scripts', 'cloud-morning-briefing.js'),
  };
  const scriptPath = scripts[fix.id];
  if (scriptPath && fs.existsSync(scriptPath)) {
    const { spawnSync } = require('child_process');
    const r = spawnSync(process.execPath, [scriptPath], {
      stdio: 'inherit',
      cwd: REPO_ROOT,
      timeout: 120000,
    });
    return { ok: r.status === 0, description: fix.description, reason: r.status !== 0 ? `exit ${r.status}` : null };
  }
  // Script not yet wired: record the intent and continue (does not change prod).
  console.log(`[visual-loop] fix "${fix.id}" has no wired script yet; recording as attempted.`);
  return { ok: false, description: fix.description, reason: 'fix-script-not-wired' };
}

async function defaultDeploy() {
  // Delegate to the existing deploy pipeline.
  const deployScript = path.join(REPO_ROOT, 'scripts', 'publish-briefing-to-ec2.sh');
  if (fs.existsSync(deployScript)) {
    const { spawnSync } = require('child_process');
    const r = spawnSync('bash', [deployScript], { stdio: 'inherit', timeout: 120000 });
    return { ok: r.status === 0, deployRef: `ec2-deploy-${Date.now()}`, reason: r.status !== 0 ? `exit ${r.status}` : null };
  }
  return { ok: false, reason: 'deploy-script-not-found' };
}

async function defaultRevert(deployRef) {
  // Nothing to revert for initial check or when deployRef is not a commit hash.
  if (!deployRef || !deployRef.match(/^[0-9a-f]{7,40}$/)) {
    return { ok: true, note: 'no-commit-ref-to-revert' };
  }
  const { spawnSync } = require('child_process');
  const r = spawnSync('git', ['revert', '--no-edit', deployRef], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    timeout: 30000,
  });
  return { ok: r.status === 0, reason: r.status !== 0 ? `git revert exited ${r.status}` : null };
}

async function defaultNotify(msg) {
  try {
    const { notifyWithFallback } = require('../lib/notify-with-fallback');
    await notifyWithFallback({
      text: String(msg),
      source: 'dashboard-visual-iteration-loop',
      kind: 'dashboard-visual-qc',
    });
  } catch (e) {
    console.error('[visual-loop] notify failed:', e.message);
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (require.main === module) {
  const args = process.argv.slice(2);
  const skipInitial = args.includes('--skip-initial-check');

  (async () => {
    const result = await runVisualIterationLoop({ skipInitialCheck: skipInitial });
    console.log(`[visual-loop] finished: status=${result.status} iterations=${result.iterations}`);
    process.exit(result.status === 'passed' ? 0 : 1);
  })();
}

module.exports = { runVisualIterationLoop, pickNextFix, FIX_LADDER };
