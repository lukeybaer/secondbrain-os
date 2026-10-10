#!/usr/bin/env node
/**
 * run-scheduled-skill.js
 *
 * Generic runner for scheduled-tasks SKILL.md prompts, used by every Windows
 * Task Scheduler overnight job (the midnight fan-out).
 *
 * 2026-06-11 LADDER (approved plan, dev-plans/llm-fallback-ladder-2026-06-11.html):
 *   rung 1: Claude CLI (Claude subscription, preferred for agentic skills)
 *   rung 2: Codex CLI (OpenAI subscription) so a Claude outage no longer kills
 *           the entire midnight fleet
 *   both fail -> honest FAILED exit (nonzero) + durable outcome row.
 *
 * THE SUCCESS LIE FIX: claude prints auth errors ("Not logged in") with exit 0.
 * The old runner trusted exit codes and recorded SUCCESS, so the fleet died
 * invisibly for the whole outage. Output is now classified via
 * scripts/lib/skill-runner-ladder.js (cli-output-guard sentinels); sentinel
 * output descends the ladder and, if all rungs fail, exits nonzero.
 *
 * Every run appends to data/agent/scheduled-skill-outcomes.jsonl which
 * probeScheduledSkillOutcomes (health-self-heal.js) reads at the 2:45am
 * diagnostic -- a dead runner is visible in the briefing next morning.
 *
 * Usage: node scripts/run-scheduled-skill.js <skill-name>
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { buildClaudeCliEnv, buildCodexCliEnv } = require('./lib/cli-output-guard.js');
const { resolveClaudeLaunch } = require('./lib/claude-cli-launch.js');
const {
  classifyRunOutput,
  nextRung,
  rungOrder,
  shouldRecordProviderFailure,
} = require('./lib/skill-runner-ladder.js');
const { recordBrainFailure, recordBrainSuccess } = require('./lib/brain-switch.js');
const {
  ensureCodexWorktree,
  isSharedCheckout,
  probeWorkTree,
  proveWorktreeIsolation,
  resolveCodexSourceRoot,
} = require('./lib/codex-worktree.js');
const { landScanOutputs } = require('./lib/scan-output-lander.js');
const { promoteLandedReceipt } = require('./reconcile-memory-consolidation-receipt.js');
const {
  buildRescueCanaryReceipt,
  writeRescueCanaryReceipt,
} = require('./lib/scheduled-skill-rescue-canary.js');
const {
  buildScheduledJobPacket,
  retiredScheduledJobReason,
  scheduledJobExecutionMode,
} = require('./lib/scheduled-job-packet.js');
const {
  childRuntimeDataDir,
  cleanupRuntimeArtifactsStage,
  prepareRuntimeArtifacts,
  publishRuntimeArtifacts,
  runtimeArtifactSkill,
  verifyPublishedRuntimeArtifacts,
} = require('./lib/scheduled-skill-runtime-artifacts.js');
const {
  assertRuntimeDataRoot,
  assertScheduledExecutor,
  gitOutputRootsForJob,
  loadAttendedRunReceipt,
  loadStateOwnership,
  resolveScheduledRuntimeDataDir,
  scheduledHost,
  scheduledRunCompletionOk,
} = require('./lib/scheduled-write-ownership.js');
const { archiveRuntimeArtifactsForExecutor } = require('./lib/scheduled-runtime-archive.js');
const {
  admitBriefingModelLaunch,
  settleBriefingModelLaunch,
} = require('./lib/briefing-night-circuit.js');
const {
  discoverGitPromotionFiles,
  enqueueScheduledSkillPromotion,
} = require('./lib/scheduled-skill-promotion-queue.js');
const { parseClaudeJsonUsage, parseCodexJsonlUsage } = require('./lib/subscription-cli-usage.js');
const { claudeCliPins, codexExecPins, decideSpawnModel } = require('./lib/model-router.js');

// Git-worthy output areas a scheduled skill legitimately produces: its own
// LESSONS.md / skill files and Tier-2 memory (contact scans, notes). Runtime
// data never rides the Git lander. Code
// changes are NOT auto-landed here; a skill that edits code must land through
// its own land.js run so the scoped test gate sees intent, not side effects.
const LEGACY_SKILL_OUTPUT_PATHSPECS = [
  'scheduled-tasks',
  'memory',
  'data/agent/amy-research-tracker.json',
];

const skillName = process.argv[2];
if (!skillName) {
  console.error('Usage: node run-scheduled-skill.js <skill-name>');
  process.exit(1);
}

// A retired job exits before ownership checks, worktree isolation, runtime
// hydration, ledger writes, or any model launch, so a stale scheduler entry or
// a manual invocation spends nothing.
const RETIRED_REASON = retiredScheduledJobReason(skillName);
if (RETIRED_REASON) {
  console.log(`RETIRED: ${skillName} is not run (${RETIRED_REASON}).`);
  process.exit(0);
}

const CANARY_MODE = process.env.RUN_SCHEDULED_SKILL_CANARY === '1';
const CANARY_SENTINEL = String(
  process.env.RUN_SCHEDULED_SKILL_CANARY_SENTINEL ||
    'SECOND_BRAIN_SCHEDULED_SKILL_RESCUE_OK:unknown',
);

const SECONDBRAIN_ROOT = process.env.SECONDBRAIN_ROOT || path.resolve(__dirname, '..');
const DATA_DIR = resolveScheduledRuntimeDataDir();
// Policy is code-owned and travels with this runner. SECONDBRAIN_ROOT may
// intentionally point at a temporary or release content tree.
const STATE_OWNERSHIP = loadStateOwnership({ repoRoot: path.resolve(__dirname, '..') });
const SKILL_OUTPUT_PATHSPECS = gitOutputRootsForJob({
  skillName,
  registry: STATE_OWNERSHIP,
  fallback: LEGACY_SKILL_OUTPUT_PATHSPECS,
});
let EXECUTOR_OWNERSHIP;
try {
  assertRuntimeDataRoot(DATA_DIR);
  EXECUTOR_OWNERSHIP = assertScheduledExecutor({
    skillName,
    host: scheduledHost(),
    registry: STATE_OWNERSHIP,
    attendedReceipt: loadAttendedRunReceipt({ skillName }),
  });
} catch (error) {
  try {
    const safeEnv = { ...process.env };
    delete safeEnv.SECONDBRAIN_DATA_DIR;
    const refusalDataDir = process.env.SECONDBRAIN_REFUSAL_DATA_DIR
      ? path.resolve(process.env.SECONDBRAIN_REFUSAL_DATA_DIR)
      : resolveScheduledRuntimeDataDir({ env: safeEnv });
    assertRuntimeDataRoot(refusalDataDir);
    const refusalLedger = path.join(refusalDataDir, 'agent', 'scheduled-skill-outcomes.jsonl');
    fs.mkdirSync(path.dirname(refusalLedger), { recursive: true });
    fs.appendFileSync(
      refusalLedger,
      JSON.stringify({
        ts: new Date().toISOString(),
        skill: skillName,
        rung: 'scheduled-write-ownership',
        ok: false,
        exitCode: 1,
        verdict: 'refused-wrong-owner-or-home',
        reason: error.message,
      }) + '\n',
    );
  } catch {
    // stderr and Task Scheduler exit code remain the fail-closed evidence.
  }
  console.error(`[scheduled-write-ownership] REFUSED before first write: ${error.message}`);
  process.exit(1);
}
const CODEX_SOURCE_ROOT = resolveCodexSourceRoot(SECONDBRAIN_ROOT);
const CODEX_REPO_ROOT = CODEX_SOURCE_ROOT.repoRoot;
const skillFile = path.join(SECONDBRAIN_ROOT, 'scheduled-tasks', skillName, 'SKILL.md');
const directConfigFile = path.join(SECONDBRAIN_ROOT, 'scheduled-tasks', skillName, 'direct.json');
const HAS_DIRECT_CONFIG = fs.existsSync(directConfigFile);
const OUTCOMES_LEDGER = path.join(DATA_DIR, 'agent', 'scheduled-skill-outcomes.jsonl');

function recordRescueCanary({
  rung = 'none',
  observedOutput = '',
  worktreeRoot = '',
  failureReason = '',
} = {}) {
  const releaseRoot = process.env.RUN_SCHEDULED_SKILL_CANARY_RELEASE_ROOT || SECONDBRAIN_ROOT;
  const sourceRoot = process.env.RUN_SCHEDULED_SKILL_CANARY_SOURCE_ROOT || CODEX_REPO_ROOT;
  const expectedDataDir = process.env.RUN_SCHEDULED_SKILL_CANARY_EXPECTED_DATA_DIR || DATA_DIR;
  let worktreeProof = { proven: false, state: 'unproven', reason: 'no worktree was produced' };
  if (worktreeRoot) {
    try {
      worktreeProof = proveWorktreeIsolation(worktreeRoot);
    } catch (error) {
      worktreeProof = { proven: false, state: 'unproven', reason: error.message };
    }
  }
  const receipt = buildRescueCanaryReceipt({
    releaseSha: process.env.RUN_SCHEDULED_SKILL_CANARY_RELEASE_SHA || '',
    releaseRoot,
    releaseRootState: probeWorkTree(releaseRoot),
    sourceRoot,
    sourceRootState: probeWorkTree(sourceRoot),
    worktreeRoot,
    worktreeProof,
    runtimeDataDir: DATA_DIR,
    expectedDataDir,
    forcedClaudeFailure: CANARY_MODE,
    rung,
    expectedSentinel: CANARY_SENTINEL,
    observedOutput,
    failureReason,
  });
  return writeRescueCanaryReceipt(DATA_DIR, receipt).receipt;
}

// Log file: per-skill, in the same backups dir other scripts use
const logDir = path.join(os.homedir(), 'AppData', 'Roaming', 'secondbrain', 'backups');
fs.mkdirSync(logDir, { recursive: true });
const logFile = path.join(logDir, `${skillName}.log`);

const timestamp = new Date().toISOString();
const separator = `\n============================\n${timestamp}  ${skillName}\n============================\n`;
fs.appendFileSync(logFile, separator);
console.log(separator.trim());

const CLAUDE_CLI_JS_WIN = path.join(
  os.homedir(),
  'AppData',
  'Roaming',
  'npm',
  'node_modules',
  '@anthropic-ai',
  'claude-code',
  'cli.js',
);

function appendOutcome(row) {
  // The post-release canary is synthetic proof, not a due scheduled task. Its
  // dedicated receipt feeds System Health without turning forced fallback into
  // a yellow row in the real scheduled-task outcomes ledger.
  if (CANARY_MODE) return;
  try {
    fs.mkdirSync(path.dirname(OUTCOMES_LEDGER), { recursive: true });
    fs.appendFileSync(
      OUTCOMES_LEDGER,
      JSON.stringify({
        ts: new Date().toISOString(),
        scheduleDate: process.env.AMY_SCHEDULE_DATE || undefined,
        trigger: process.env.AMY_SCHEDULE_TRIGGER || undefined,
        skill: skillName,
        ...row,
      }) + '\n',
    );
  } catch (e) {
    fs.appendFileSync(logFile, `outcomes ledger append failed: ${e.message}\n`);
  }
}

function remainingWorktreeDirt(worktreeRoot) {
  const result = spawnSync(
    'git',
    ['-C', worktreeRoot, 'status', '--porcelain', '--untracked-files=all'],
    { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (result.status !== 0) {
    return {
      ok: false,
      files: [],
      reason: String(result.stderr || `exit ${result.status}`).trim(),
    };
  }
  const files = String(result.stdout || '')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.slice(3).trim());
  return { ok: true, files };
}

if (!fs.existsSync(skillFile)) {
  console.error(`SKILL.md not found: ${skillFile}`);
  process.exit(1);
}

const ROOT_IS_SHARED_CHECKOUT = isSharedCheckout(SECONDBRAIN_ROOT);
const CODEX_REPO_IS_SHARED_CHECKOUT = isSharedCheckout(CODEX_REPO_ROOT);
const ROOT_IS_DETACHED_RUNTIME = (() => {
  const result = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: SECONDBRAIN_ROOT,
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  });
  return result.status === 0 && String(result.stdout || '').trim() === 'HEAD';
})();
const NEEDS_ISOLATED_RERUN =
  process.env.SECONDBRAIN_ISOLATE_SCHEDULED_SKILLS === '1' &&
  (ROOT_IS_SHARED_CHECKOUT ||
    ROOT_IS_DETACHED_RUNTIME ||
    (!HAS_DIRECT_CONFIG &&
      (CODEX_REPO_IS_SHARED_CHECKOUT ||
        path.resolve(CODEX_REPO_ROOT) !== path.resolve(SECONDBRAIN_ROOT) ||
        CODEX_SOURCE_ROOT.originalState === 'not-worktree')));

if (process.env.RUN_SCHEDULED_SKILL_ISOLATED !== '1' && NEEDS_ISOLATED_RERUN) {
  try {
    if (CODEX_SOURCE_ROOT.source === 'fallback') {
      fs.appendFileSync(
        logFile,
        `[isolation] using source checkout ${CODEX_REPO_ROOT} for release root ${SECONDBRAIN_ROOT}\n`,
      );
    }
    const isolated = ensureCodexWorktree({
      repoRoot: CODEX_REPO_ROOT,
      purpose: `scheduled-skill-${skillName}`,
      branchPrefix: 'codex/scheduled-skill',
      linkNodeModules: false,
      forceNew: ROOT_IS_DETACHED_RUNTIME,
    });
    const runtimeStage = prepareRuntimeArtifacts({
      skillName,
      runtimeDataDir: DATA_DIR,
      runId: `${process.pid}-${Date.now()}`,
      scheduleDate: process.env.AMY_SCHEDULE_DATE,
    });
    const childDataDir = childRuntimeDataDir({
      dataDir: runtimeStage.dataDir,
      isSharedCheckout,
    });
    const childEnv = {
      ...process.env,
      SECONDBRAIN_ROOT: isolated.cwd,
      SECONDBRAIN_DATA_DIR: childDataDir,
      SECONDBRAIN_BACKLOG_DATA_DIR: childDataDir,
      RUN_SCHEDULED_SKILL_ISOLATED: '1',
      // Keep the scheduled worktree junction-free, but let child Node
      // processes resolve read-only runtime dependencies such as Playwright.
      NODE_PATH: [
        path.join(CODEX_REPO_ROOT, 'node_modules'),
        path.join(SECONDBRAIN_ROOT, 'node_modules'),
        process.env.NODE_PATH,
      ]
        .filter((candidate, index, values) => candidate && values.indexOf(candidate) === index)
        .join(path.delimiter),
      ...(CANARY_MODE
        ? {
            RUN_SCHEDULED_SKILL_CANARY_RELEASE_ROOT:
              process.env.RUN_SCHEDULED_SKILL_CANARY_RELEASE_ROOT || SECONDBRAIN_ROOT,
            RUN_SCHEDULED_SKILL_CANARY_SOURCE_ROOT: CODEX_REPO_ROOT,
            RUN_SCHEDULED_SKILL_CANARY_WORKTREE_ROOT: isolated.cwd,
          }
        : {}),
    };
    fs.appendFileSync(logFile, `[isolation] re-running in ${isolated.cwd}\n`);
    const childOpts = {
      cwd: isolated.cwd,
      env: childEnv,
      stdio: 'inherit',
    };
    const totalTimeout = Number(process.env.RUN_SCHEDULED_SKILL_TOTAL_TIMEOUT_MS || 0);
    if (totalTimeout > 0) childOpts.timeout = totalTimeout;
    const child = spawnSync(
      process.execPath,
      [path.join(isolated.cwd, 'scripts', 'run-scheduled-skill.js'), skillName],
      childOpts,
    );
    if (child.error) {
      throw child.error;
    }
    if (CANARY_MODE) {
      const remove = spawnSync(
        'git',
        ['-C', CODEX_REPO_ROOT, 'worktree', 'remove', '--force', isolated.cwd],
        { encoding: 'utf8', timeout: 60000 },
      );
      if (remove.status === 0 && isolated.branch) {
        spawnSync('git', ['-C', CODEX_REPO_ROOT, 'branch', '-D', isolated.branch], {
          encoding: 'utf8',
          timeout: 60000,
        });
      }
      process.exit(Number.isFinite(child.status) ? child.status : 1);
    }
    let runtimePublished = !runtimeArtifactSkill(skillName);
    let runtimeArchived = !runtimeArtifactSkill(skillName);
    let runtimeLiveRead = !runtimeArtifactSkill(skillName);
    if (child.status === 0 && runtimeArtifactSkill(skillName)) {
      try {
        const published = publishRuntimeArtifacts({
          skillName,
          stagingDataDir: runtimeStage.dataDir,
          runtimeDataDir: DATA_DIR,
          scheduleDate: process.env.AMY_SCHEDULE_DATE,
          fallbackDataDir: path.join(isolated.cwd, 'data'),
        });
        runtimePublished = published.ok;
        appendOutcome({
          rung: 'publish-runtime-outputs',
          ok: published.ok,
          exitCode: published.ok ? 0 : 1,
          verdict: published.ok ? 'published' : 'runtime-postcondition-failed',
          files: published.files,
          failures: published.failures,
        });
      } catch (error) {
        runtimePublished = false;
        appendOutcome({
          rung: 'publish-runtime-outputs',
          ok: false,
          exitCode: 1,
          verdict: 'runtime-publish-threw',
          tail: String(error.message || error).slice(-300),
        });
      }
      if (runtimePublished) {
        try {
          const archived = archiveRuntimeArtifactsForExecutor({
            executorOwnership: EXECUTOR_OWNERSHIP,
            skillName,
            scheduleDate: process.env.AMY_SCHEDULE_DATE,
            // Archive the exact isolated run set, never the mutable live
            // aggregate that may still be receiving JSONL appends.
            runtimeDataDir: runtimeStage.dataDir,
            registry: STATE_OWNERSHIP,
          });
          runtimeArchived = archived.ok;
          appendOutcome({
            rung: 'archive-runtime-outputs',
            ok: archived.ok,
            exitCode: archived.ok ? 0 : 1,
            verdict: archived.skipped
              ? 'attended-local-cache-only'
              : archived.ok
                ? 'archived-current'
                : 'runtime-archive-failed',
            files: archived.files,
            reason: archived.reason,
          });
        } catch (error) {
          runtimeArchived = false;
          appendOutcome({
            rung: 'archive-runtime-outputs',
            ok: false,
            exitCode: 1,
            verdict: 'runtime-archive-threw',
            tail: String(error.message || error).slice(-300),
          });
        }
      }
    }
    // A scheduled skill may add or update a dev-plan artifact. The plan index
    // is a generated invariant checked by land.js, so refresh it inside the
    // same isolated worktree before output discovery and guarded landing.
    // Otherwise a valid scheduled result is guaranteed to fail its land gate
    // and every queued retry repeats the same stale-index failure.
    if (child.status === 0 && SKILL_OUTPUT_PATHSPECS.some((entry) => entry === 'dev-plans')) {
      const devPlanStatus = spawnSync(
        'git',
        ['status', '--porcelain', '--untracked-files=all', '--', 'dev-plans'],
        { cwd: isolated.cwd, encoding: 'utf8', timeout: 30_000 },
      );
      if (devPlanStatus.status === 0 && String(devPlanStatus.stdout || '').trim()) {
        const recordsBuilder = path.join(isolated.cwd, 'scripts', 'build-dev-plans-records.js');
        if (fs.existsSync(recordsBuilder)) {
          const recordsResult = spawnSync(process.execPath, [recordsBuilder], {
            cwd: isolated.cwd,
            env: childEnv,
            encoding: 'utf8',
            timeout: 60_000,
          });
          appendOutcome({
            rung: 'refresh-dev-plan-records',
            ok: recordsResult.status === 0,
            exitCode: Number.isFinite(recordsResult.status) ? recordsResult.status : 1,
            verdict: recordsResult.status === 0 ? 'records-current' : 'records-refresh-failed',
            tail: [recordsResult.stdout, recordsResult.stderr]
              .filter(Boolean)
              .join('\n')
              .slice(-300),
          });
        }
      }
    }
    // LAND STEP (2026-07-12 shared-checkout writer fix): the child ran in an
    // isolated worktree, so its git-worthy outputs (LESSONS.md append, contact
    // scan updates, memory notes) live only in that worktree. Without landing
    // they rot there and the NEXT run reads stale lessons; historically this
    // is also how the shared checkout accumulated dirt (runs that skipped
    // isolation). Land the scoped outputs through the normal gate, then reap
    // the worktree so scheduled runs never leak orphans. A landing failure is
    // ledgered loudly and makes the whole run fail until the dirt is owned.
    let reapPostconditionClean = false;
    let landResult = { ok: false, landed: false, reason: 'land-not-run', files: [] };
    try {
      const landed = SKILL_OUTPUT_PATHSPECS.length
        ? landScanOutputs({
            repoRoot: isolated.cwd,
            pathspecs: SKILL_OUTPUT_PATHSPECS,
            message: `chore(scheduled): ${skillName} run outputs`,
            purpose: `skill-outputs-${skillName}`,
            log: (line) => fs.appendFileSync(logFile, String(line) + '\n'),
          })
        : { ok: true, landed: false, reason: 'no-git-outputs', files: [] };
      landResult = landed;
      appendOutcome({
        rung: 'land-outputs',
        ok: landed.ok,
        exitCode: landed.ok ? 0 : 1,
        verdict: landed.landed ? 'landed' : landed.reason || 'clean',
        files: landed.files,
      });
      if (landed.ok && child.status === 0 && skillName === 'memory-consolidation') {
        try {
          const promoted = promoteLandedReceipt({ skillName, worktreeRoot: isolated.cwd, dataDir: DATA_DIR });
          appendOutcome({ rung: 'promote-runtime-receipt', ok: true, exitCode: 0, verdict: promoted });
        } catch (error) {
          appendOutcome({
            rung: 'promote-runtime-receipt',
            ok: false,
            exitCode: 1,
            verdict: 'runtime-receipt-promotion-failed',
            tail: String(error.message || error).slice(-300),
          });
        }
      }
      const residual = remainingWorktreeDirt(isolated.cwd);
      reapPostconditionClean = residual.ok && residual.files.length === 0;
      if (!residual.ok || residual.files.length) {
        appendOutcome({
          rung: 'reap-postcondition',
          ok: false,
          exitCode: 1,
          verdict: residual.ok ? 'retained-unowned-dirt' : 'retained-status-unproven',
          files: residual.files,
          reason: residual.reason,
        });
      }
      if (
        landed.ok &&
        runtimePublished &&
        runtimeArchived &&
        child.status === 0 &&
        reapPostconditionClean
      ) {
        const liveRead = verifyPublishedRuntimeArtifacts({
          skillName,
          stagingDataDir: runtimeStage.dataDir,
          runtimeDataDir: DATA_DIR,
          scheduleDate: process.env.AMY_SCHEDULE_DATE,
        });
        runtimeLiveRead = liveRead.ok;
        appendOutcome({
          rung: 'live-read-runtime-outputs',
          ok: liveRead.ok,
          exitCode: liveRead.ok ? 0 : 1,
          verdict: liveRead.ok ? liveRead.proof : 'runtime-live-read-failed',
          failures: liveRead.failures,
        });
      }
      if (
        landed.ok &&
        runtimePublished &&
        runtimeArchived &&
        runtimeLiveRead &&
        child.status === 0 &&
        reapPostconditionClean
      ) {
        if (runtimeArtifactSkill(skillName)) {
          cleanupRuntimeArtifactsStage({
            stagingDataDir: runtimeStage.dataDir,
            runtimeDataDir: DATA_DIR,
          });
        }
        // Worktree is fully landed (or had nothing to land): reap it so the
        // sb-sessions dir does not fill with orphans.
        const st = spawnSync(
          'git',
          ['-C', CODEX_REPO_ROOT, 'worktree', 'remove', '--force', isolated.cwd],
          {
            encoding: 'utf8',
            timeout: 60000,
          },
        );
        if (st.status === 0 && isolated.branch) {
          spawnSync('git', ['-C', CODEX_REPO_ROOT, 'branch', '-D', isolated.branch], {
            encoding: 'utf8',
            timeout: 60000,
          });
        }
      }
    } catch (e) {
      landResult = {
        ok: false,
        landed: false,
        reason: `land-threw: ${String(e.message || e)}`,
        files: [],
      };
      appendOutcome({
        rung: 'land-outputs',
        ok: false,
        exitCode: 1,
        verdict: 'land-threw',
        tail: String(e.message || e).slice(-300),
      });
      fs.appendFileSync(logFile, `land-outputs failed: ${e.message}\n`);
    }
    let gitPromotionFiles = Array.isArray(landResult.files) ? landResult.files : [];
    if (child.status === 0 && SKILL_OUTPUT_PATHSPECS.length > 0 && !landResult.ok) {
      try {
        gitPromotionFiles = [
          ...new Set([
            ...gitPromotionFiles,
            ...discoverGitPromotionFiles(isolated.cwd, SKILL_OUTPUT_PATHSPECS),
          ]),
        ].sort();
        appendOutcome({
          rung: 'discover-promotion-outputs',
          ok: gitPromotionFiles.length > 0,
          exitCode: gitPromotionFiles.length > 0 ? 0 : 1,
          verdict:
            gitPromotionFiles.length > 0
              ? 'recovered-after-land-exception'
              : 'no-promotable-output-found',
          files: gitPromotionFiles,
        });
      } catch (error) {
        appendOutcome({
          rung: 'discover-promotion-outputs',
          ok: false,
          exitCode: 1,
          verdict: 'promotion-output-discovery-failed',
          tail: String(error.message || error).slice(-300),
        });
      }
    }
    const needsRuntimeArchivePromotion =
      child.status === 0 && runtimeArtifactSkill(skillName) && !runtimeArchived;
    const needsRuntimePublishPromotion =
      child.status === 0 && runtimeArtifactSkill(skillName) && !runtimePublished;
    const needsRuntimeLiveReadPromotion =
      child.status === 0 && runtimeArtifactSkill(skillName) && !runtimeLiveRead;
    const needsGitLandPromotion =
      child.status === 0 &&
      SKILL_OUTPUT_PATHSPECS.length > 0 &&
      !landResult.ok &&
      gitPromotionFiles.length > 0;
    if (
      needsRuntimePublishPromotion ||
      needsRuntimeArchivePromotion ||
      needsRuntimeLiveReadPromotion ||
      needsGitLandPromotion
    ) {
      try {
        const scheduleDate =
          process.env.AMY_SCHEDULE_DATE ||
          new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
        const queued = enqueueScheduledSkillPromotion({
          skillName,
          scheduleDate,
          dataDir: DATA_DIR,
          sourceRepoRoot: CODEX_REPO_ROOT,
          worktreeRoot: isolated.cwd,
          branch: isolated.branch,
          pathspecs: SKILL_OUTPUT_PATHSPECS,
          files: gitPromotionFiles,
          requireGitLand: needsGitLandPromotion,
          runtimeStagingDataDir: runtimeStage.dataDir,
          requireRuntimePublish: needsRuntimePublishPromotion,
          requireRuntimeArchive: needsRuntimeArchivePromotion,
          requireLiveRead: needsRuntimeLiveReadPromotion,
          reason: [
            needsRuntimePublishPromotion ? 'runtime-publish-failed' : '',
            needsRuntimeArchivePromotion ? 'runtime-archive-incomplete' : '',
            needsRuntimeLiveReadPromotion ? 'runtime-live-read-incomplete' : '',
            needsGitLandPromotion ? landResult.reason || 'git-land-failed' : '',
          ]
            .filter(Boolean)
            .join('; '),
        });
        appendOutcome({
          rung: 'queue-promotion',
          ok: true,
          exitCode: 0,
          verdict: queued.duplicate ? 'already-queued' : 'queued-stage-only-retry',
          promotionJobId: queued.job.id,
          retryStages: [
            ...(needsRuntimePublishPromotion ? ['publish-runtime-outputs'] : []),
            ...(needsRuntimeArchivePromotion ? ['archive-runtime-outputs'] : []),
            ...(needsGitLandPromotion ? ['land-outputs'] : []),
            ...(needsRuntimeLiveReadPromotion ? ['live-read-runtime-outputs'] : []),
          ],
        });
      } catch (error) {
        appendOutcome({
          rung: 'queue-promotion',
          ok: false,
          exitCode: 1,
          verdict: 'promotion-enqueue-failed',
          tail: String(error.message || error).slice(-300),
        });
      }
    }
    process.exit(
      scheduledRunCompletionOk({
        childStatus: child.status,
        runtimePublished,
        runtimeArchived,
        runtimeLiveRead,
        reapPostconditionClean,
      })
        ? 0
        : 1,
    );
  } catch (e) {
    const output = `Codex isolation failed before scheduled skill could run: ${e.message}`;
    if (CANARY_MODE) {
      recordRescueCanary({ failureReason: output });
    }
    appendOutcome({
      rung: 'isolation',
      ok: false,
      exitCode: -1,
      verdict: 'isolation-failed',
      tail: output.slice(-300),
    });
    fs.appendFileSync(logFile, `${output}\n`);
    console.error(output);
    process.exit(1);
  }
}


const hooks = require('./skill-runner-hooks');
const rawContent = fs.readFileSync(skillFile, 'utf8');

// Strip YAML frontmatter (--- ... ---)
const basePrompt = rawContent.replace(/^---[\s\S]*?---\s*\n/, '').trim();

// Phase 5 harness-evolution wiring: inject prior LESSONS.md entries into the
// prompt so the skill biases toward what worked and away from what failed.
const baseSkillPrompt = hooks.buildPromptWithLessons(skillName, basePrompt);
const lessonInputDescriptor = `scheduled run ${new Date().toISOString()}`;

if (skillName === 'amy-research-skill' && process.env.AMY_ENABLE_AUTONOMOUS_RESEARCH !== '1') {
  appendOutcome({
    rung: 'policy',
    ok: true,
    exitCode: 0,
    verdict: 'skipped-explicit-request-required',
    reason:
      'amy-research-skill is disabled unless ExampleCo explicitly enables autonomous research with AMY_ENABLE_AUTONOMOUS_RESEARCH=1',
  });
  const msg =
    'SKIPPED: amy-research-skill requires explicit enablement (AMY_ENABLE_AUTONOMOUS_RESEARCH=1).';
  fs.appendFileSync(logFile, msg + '\n');
  console.log(msg);
  process.exit(0);
}

// Scheduled work has a compact, declared packet. Graphiti is off and no
// prompt-admission token or per-tool consultation is created for mechanics.
const scheduledPacket = buildScheduledJobPacket({
  skillName,
  scheduleDate:
    process.env.AMY_SCHEDULE_DATE ||
    new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }),
  outcome: 'Complete the scheduled skill and persist its durable receipt.',
  constraints: 'Keep paid model APIs disabled. Preserve existing output and authorization guards.',
  skillPrompt: baseSkillPrompt,
});
const scheduledExecutionMode = scheduledJobExecutionMode(scheduledPacket.jobClass, {
  canaryMode: CANARY_MODE,
  hasDirectConfig: HAS_DIRECT_CONFIG,
});
if (scheduledExecutionMode === 'refuse-canary-harness-required') {
  const msg = `REFUSED: ${skillName} is a machine-only release rescue canary and requires RUN_SCHEDULED_SKILL_CANARY=1.`;
  appendOutcome({
    rung: 'canary-harness',
    ok: false,
    exitCode: 1,
    verdict: 'refused-canary-harness-required',
    tail: msg,
  });
  console.error(msg);
  process.exit(1);
}
if (scheduledExecutionMode === 'skip-no-model') {
  const msg = `SKIPPED: ${skillName} is declared monitoring and makes no model call.`;
  appendOutcome({ rung: 'monitoring', ok: true, exitCode: 0, verdict: 'observed-no-model', tail: msg });
  console.log(msg);
  process.exit(0);
}
const prompt = scheduledPacket.packet;
const scheduledClaudeDecision = scheduledPacket.taskType
  ? decideSpawnModel(
      'run-scheduled-skill',
      'claude',
      { taskType: scheduledPacket.taskType },
      { ledgerPath: path.join(DATA_DIR, 'agent', 'model-router-shadow.jsonl') },
    )
  : null;
const scheduledCodexDecision = scheduledPacket.taskType
  ? decideSpawnModel(
      'run-scheduled-skill',
      'codex',
      { taskType: scheduledPacket.taskType },
      { ledgerPath: path.join(DATA_DIR, 'agent', 'model-router-shadow.jsonl') },
    )
  : null;

// Subscription-only model environment. Direct child scripts inherit the same
// credential-free boundary, and each CLI rung applies its provider-specific
// helper again at spawn time.
const env = buildClaudeCliEnv(process.env);

const RUN_OPTS = {
  env,
  cwd: SECONDBRAIN_ROOT,
  maxBuffer: 50 * 1024 * 1024,
  timeout: Number(process.env.RUN_SCHEDULED_SKILL_RUNG_TIMEOUT_MS || 30 * 60 * 1000),
  encoding: 'utf8',
};

function expandDirectArg(arg) {
  return String(arg)
    .replace(/\$DATE/g, process.env.AMY_SCHEDULE_DATE || new Date().toISOString().slice(0, 10))
    .replace(/\$DATA_DIR/g, DATA_DIR)
    .replace(/\$ROOT/g, SECONDBRAIN_ROOT);
}

function runDirectConfigIfPresent() {
  if (!fs.existsSync(directConfigFile)) return false;
  let config;
  try {
    config = JSON.parse(fs.readFileSync(directConfigFile, 'utf8'));
  } catch (e) {
    appendOutcome({ rung: 'direct', ok: false, exitCode: 1, verdict: 'invalid-direct-config' });
    console.error(`FAILED: invalid direct config for ${skillName}: ${e.message}`);
    process.exit(1);
  }
  const script = config.script ? path.resolve(SECONDBRAIN_ROOT, config.script) : '';
  if (!script || !fs.existsSync(script)) {
    appendOutcome({ rung: 'direct', ok: false, exitCode: 1, verdict: 'missing-direct-script' });
    console.error(`FAILED: direct script missing for ${skillName}`);
    process.exit(1);
  }
  const args = (config.args || []).map(expandDirectArg);
  const directTimeoutMs = Number(config.timeoutMs || RUN_OPTS.timeout);
  const result = spawnSync(process.execPath, [script, ...args], {
    ...RUN_OPTS,
    timeout:
      Number.isFinite(directTimeoutMs) && directTimeoutMs > 0 ? directTimeoutMs : RUN_OPTS.timeout,
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
  fs.appendFileSync(logFile, `[direct] ${script} ${args.join(' ')}\n${output}\n`);
  process.stdout.write(output.slice(0, 4000) + '\n');
  const ok = result.status === 0;
  appendOutcome({
    rung: 'direct',
    ok,
    exitCode: Number.isFinite(result.status) ? result.status : ok ? 0 : 1,
    verdict: ok ? 'ok' : 'failed',
  });
  // Direct-config skills bypass the LLM ladder (this function exits before the
  // ladder's recordSkillOutcome), so log the lesson here too. Without this a
  // daily direct.json skill like values-equipping-ideas never accumulates
  // learning. Same hook the ladder uses; failure to append is non-fatal.
  try {
    hooks.recordSkillOutcome(skillName, {
      input: `scheduled run (direct): ${config.script || skillName}`,
      exitCode: Number.isFinite(result.status) ? result.status : ok ? 0 : 1,
      output,
    });
  } catch (e) {
    fs.appendFileSync(logFile, `LESSONS append failed: ${e.message}\n`);
  }
  if (ok) {
    const done = `SUCCESS (via direct): ${skillName} completed at ${new Date().toISOString()}\n`;
    fs.appendFileSync(logFile, done);
    console.log(done);
    process.exit(0);
  }
  const msg = `FAILED: direct scheduled task failed for ${skillName}`;
  fs.appendFileSync(logFile, msg + '\n');
  console.error(msg);
  process.exit(result.status || 1);
}

runDirectConfigIfPresent();

// 2026-09-25: the weekly backup check still failed "Claude CLI not found"
// under Task Scheduler at 4:17 AM and 10:09 AM CT, while the same child
// command in the same worktree found bin/claude.exe from a shell. Record what
// the scheduled process actually sees so the next failure names its cause.
function claudeLaunchDiagnostic(cliJsPath) {
  const probe = (file) => {
    try {
      return `${fs.statSync(file).size}B`;
    } catch (error) {
      return (error && error.code) || String((error && error.message) || error).slice(0, 60);
    }
  };
  const native = path.join(path.dirname(cliJsPath), 'bin', 'claude.exe');
  return [
    `cli.js=${probe(cliJsPath)}`,
    `claude.exe=${probe(native)}`,
    `homedir=${os.homedir()}`,
    `USERPROFILE=${process.env.USERPROFILE || ''}`,
    `node=${process.execPath}`,
  ].join(' ');
}

// 2026-09-25 root cause of the diagnostic above: Claude Code was installed
// with npm from a shell inside the packaged Claude desktop app, so Windows
// wrote it to the app's private AppData overlay
// (%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\npm). Shells inside
// the app see it at AppData\Roaming\npm; Task Scheduler sees ENOENT. The
// native install folder ~/.local/bin is outside AppData, so every process
// sees the same file there.
const CLAUDE_NATIVE_WIN = path.join(os.homedir(), '.local', 'bin', 'claude.exe');

function nativeClaudeInstallLaunch() {
  try {
    return fs.existsSync(CLAUDE_NATIVE_WIN)
      ? { exec: CLAUDE_NATIVE_WIN, baseArgs: [], layout: 'native', path: CLAUDE_NATIVE_WIN }
      : null;
  } catch {
    return null;
  }
}

function runClaudeRung() {
  if (CANARY_MODE) {
    const output = 'Not logged in. Forced Claude failure for post-release rescue canary.';
    return { verdict: classifyRunOutput(0, output), output, exitCode: 0 };
  }
  let claudePins;
  try {
    claudePins = claudeCliPins(scheduledClaudeDecision);
  } catch (error) {
    return {
      verdict: 'failed',
      output: `Claude routing denied: ${error.message || error}`,
      exitCode: -1,
      policyDenied: true,
    };
  }
  if (process.platform === 'win32') {
    // Claude Code 2.1.2xx+ ships only bin/claude.exe next to cli.js (no more
    // cli.js file at all on some installs); a bare existsSync(cli.js) check
    // then fails closed even though the CLI is installed and working. Reuse
    // the shared resolver (scripts/lib/claude-cli-launch.js) so this rung
    // falls back to the native binary of the same install instead of
    // reporting "Claude CLI not found" while claude.exe sits right there.
    const launch = resolveClaudeLaunch([CLAUDE_CLI_JS_WIN]) || nativeClaudeInstallLaunch();
    if (!launch) {
      return {
        verdict: 'failed',
        output: `Claude CLI not found: ${CLAUDE_CLI_JS_WIN} (${claudeLaunchDiagnostic(CLAUDE_CLI_JS_WIN)})`,
        exitCode: -1,
      };
    }
    const result = spawnSync(
      launch.exec,
      [...launch.baseArgs, '--print', '--output-format', 'json', ...claudePins],
      { ...RUN_OPTS, input: prompt },
    );
    if (result.error) {
      return { verdict: 'failed', output: `Spawn error: ${result.error.message}`, exitCode: -1 };
    }
    const parsed = parseClaudeJsonUsage(result.stdout);
    const output = [parsed.output, result.stderr].filter(Boolean).join('');
    return {
      verdict: classifyRunOutput(result.status, output),
      output,
      usage: parsed.usage,
      exitCode: result.status,
    };
  }
  const result = spawnSync(
    process.env.CLAUDE_CLI || 'claude',
    ['--print', '--output-format', 'json', ...claudePins],
    { ...RUN_OPTS, input: prompt },
  );
  if (result.error) {
    return { verdict: 'failed', output: `Spawn error: ${result.error.message}`, exitCode: -1 };
  }
  const parsed = parseClaudeJsonUsage(result.stdout);
  const output = [parsed.output, result.stderr].filter(Boolean).join('');
  return {
    verdict: classifyRunOutput(result.status, output),
    output,
    usage: parsed.usage,
    exitCode: result.status,
  };
}

let lastCodexCwd = '';

function runCodexRung() {
  // OpenAI-subscription rescue rung (approved plan P1). workspace-write
  // sandbox: the skill needs to edit repo files, but codex stays inside the
  // workspace (no secret paths, no system writes). Final answer comes from
  // --output-last-message; stdout is narration.
  const outFile = path.join(os.tmpdir(), `skill-codex-${process.pid}-${Date.now()}.txt`);
  let codexPins;
  try {
    codexPins = codexExecPins(scheduledCodexDecision);
  } catch (error) {
    return {
      verdict: 'failed',
      output: `Codex routing denied: ${error.message || error}`,
      exitCode: -1,
      policyDenied: true,
    };
  }
  let codexCwd;
  if (process.env.RUN_SCHEDULED_SKILL_ISOLATED === '1') {
    codexCwd = SECONDBRAIN_ROOT;
    lastCodexCwd = codexCwd;
  } else
    try {
      codexCwd = ensureCodexWorktree({
        repoRoot: CODEX_REPO_ROOT,
        purpose: `scheduled-skill-${skillName}`,
        branchPrefix: 'codex/scheduled-skill',
      }).cwd;
      lastCodexCwd = codexCwd;
    } catch (e) {
      return {
        verdict: 'failed',
        output: `Codex isolation failed: ${e.message}`,
        exitCode: -1,
      };
    }
  if (CANARY_MODE) {
    return {
      verdict: classifyRunOutput(0, CANARY_SENTINEL),
      output: CANARY_SENTINEL,
      exitCode: 0,
    };
  }
  const codexPrompt = [
    `Branch cleanliness: the scheduled runner already created the required isolated worktree at ${codexCwd} and set it as your current working directory.`,
    'Any skill instruction to create a worktree is already satisfied. Do not run new-session.sh, git worktree add, or create a nested worktree.',
    'Execute the remaining skill steps directly in the current isolated worktree.',
    'Leave scheduled output landing to this runner wrapper; do not run land.js, commit, push, or deploy for routine scheduled-task output files.',
    `Write the registered runtime outputs to ${childRuntimeDataDir({ dataDir: DATA_DIR })}. This exact runtime directory is granted writable access; /tmp is not a durable output handoff.`,
    'If the skill intentionally changes source code, run its focused tests and report the diff for the normal coordinator land path.',
    `Do not edit the shared checkout at ${CODEX_REPO_ROOT}.`,
    '',
    prompt,
  ].join('\n');
  // Prompt rides STDIN: shell:true on Windows splits multiword argv on spaces.
  const result = spawnSync(
    'codex',
    [
      'exec',
      '--skip-git-repo-check',
      ...codexPins,
      '-s',
      'workspace-write',
      '--add-dir',
      childRuntimeDataDir({ dataDir: DATA_DIR }),
      '--json',
      '--output-last-message',
      outFile,
    ],
    {
      ...RUN_OPTS,
      env: buildCodexCliEnv(env),
      cwd: codexCwd,
      input: codexPrompt,
      shell: process.platform === 'win32',
    },
  );
  let output = '';
  try {
    output = fs.readFileSync(outFile, 'utf8').trim();
  } catch {
    output = [result.stdout, result.stderr].filter(Boolean).join('');
  }
  try {
    fs.unlinkSync(outFile);
  } catch {
    /* already gone */
  }
  if (result.error) {
    return { verdict: 'failed', output: `Spawn error: ${result.error.message}`, exitCode: -1 };
  }
  return {
    verdict: classifyRunOutput(result.status, output),
    output,
    usage: parseCodexJsonlUsage(result.stdout),
    exitCode: result.status,
  };
}

function closeMemoryConsolidationTokenReceipt(result) {
  if (skillName !== 'memory-consolidation' || !result || !result.usage) return null;
  const usagePath = path.join(
    SECONDBRAIN_ROOT,
    'data',
    'agent',
    'memory-consolidation-token-usage.json',
  );
  const receipt = {
    ...result.usage,
    measured_at: new Date().toISOString(),
    source: 'subscription-cli-final-turn',
  };
  fs.mkdirSync(path.dirname(usagePath), { recursive: true });
  fs.writeFileSync(usagePath, JSON.stringify(receipt, null, 2) + '\n');

  const reportScript = path.join(SECONDBRAIN_ROOT, 'scripts', 'memory-consolidation-report.js');
  const clustersPath = path.join(
    SECONDBRAIN_ROOT,
    'data',
    'agent',
    'memory-consolidation-clusters.json',
  );
  const adjudicationsPath = path.join(
    SECONDBRAIN_ROOT,
    'data',
    'agent',
    'memory-consolidation-adjudications.json',
  );
  if (!fs.existsSync(clustersPath) || !fs.existsSync(adjudicationsPath)) {
    throw new Error('memory consolidation completed without exact scan/adjudication inputs');
  }
  let report = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    report = spawnSync(process.execPath, [reportScript], {
      ...RUN_OPTS,
      cwd: SECONDBRAIN_ROOT,
      timeout: 120_000,
    });
    if (report && report.status === 0) break;
  }
  const reportRegenerated = Boolean(report && report.status === 0);
  if (!reportRegenerated) {
    const warning = `measured token receipt persisted, but report regeneration remained degraded after 2 bounded attempts: ${[
      report && report.stdout,
      report && report.stderr,
      report && report.error && report.error.message,
    ]
      .filter(Boolean)
      .join(' ')}`;
    fs.appendFileSync(logFile, `[memory-consolidation-report] ${warning}\n`);
  }
  return { usagePath, receipt, reportRegenerated };
}

const RUNGS = { claude: runClaudeRung, codex: runCodexRung };

const scheduledCircuitAdmission = scheduledExecutionMode === 'machine-canary'
  ? { allowed: true, enforced: false, reservationId: null }
  : admitBriefingModelLaunch({
      date: process.env.BRIEFING_DATE || '',
      dataDir: DATA_DIR,
      lane: `scheduled-skill:${skillName}`,
      priority: 'nonessential',
      estimatedTokens: 500_000,
    });
if (!scheduledCircuitAdmission.allowed) {
  const msg = `SKIPPED: briefing night circuit denied ${skillName}: ${scheduledCircuitAdmission.reason}`;
  fs.appendFileSync(logFile, msg + '\n');
  appendOutcome({
    rung: 'none',
    ok: false,
    exitCode: 75,
    verdict: 'briefing-night-circuit-denied',
    tail: msg,
  });
  console.error(msg);
  process.exit(75);
}

// Snapshot the rung order ONCE for this run. The machine-only rescue canary
// always forces the Claude-to-Codex sequence and must not mutate the live
// brain-switch ledger with its synthetic failure.
//
// recordBrainFailure below can
// flip the durable brain switch mid-run (e.g. claude just went out of
// tokens); walking a re-read order would then see claude at the END of the
// new (codex-first) order and stop, skipping the fallback rung entirely in
// this same run. Descent must walk the snapshot, not the live switch.
const rungRunOrder = CANARY_MODE ? ['claude', 'codex'] : rungOrder();
let rung = rungRunOrder[0];
let lastResult = null;
while (rung) {
  fs.appendFileSync(logFile, `[ladder] attempting rung: ${rung}\n`);
  lastResult = RUNGS[rung]();
  fs.appendFileSync(logFile, lastResult.output + '\n');
  process.stdout.write(lastResult.output.slice(0, 4000) + '\n');
  // Feed the durable brain switch (ExampleCo 2026-09-03). Bookkeeping only: it
  // must never fail a skill run, so any throw here is swallowed.
  //
  // Every non-ok verdict reports the raw combined stderr+stdout, not just
  // 'sentinel-failure'. classifyRunOutput collapses ANY nonzero exit to the
  // generic 'failed' verdict BEFORE it ever inspects the output text for a
  // quota/auth sentinel (scripts/lib/skill-runner-ladder.js), so a CLI that
  // exits nonzero while printing "usage limit reached" used to look
  // identical to an ordinary crash and never reached the switch. The switch's
  // own classifier (classifyLaneFailure) is what actually tells quota/auth
  // text (demotes at once) apart from everything else (one transient
  // strike), so handing it every non-ok verdict's text is safe: it will not
  // over-demote on a plain crash.
  //
  // A 'self-reported-failure' is the model answering coherently that the TASK
  // is blocked: that is provider availability, not exhaustion, so it counts
  // as success. Only transport, sentinel, timeout, empty, or parse failures
  // ('sentinel-failure' and 'failed') are reported as provider failures
  // (Codex deploy gate 2026-09-03).
  if (!CANARY_MODE) {
    try {
      if (lastResult.verdict === 'ok' || lastResult.verdict === 'self-reported-failure') {
        recordBrainSuccess(rung, { source: 'run-scheduled-skill' });
      } else if (shouldRecordProviderFailure(lastResult)) {
        recordBrainFailure(rung, lastResult.output, { source: 'run-scheduled-skill' });
      }
    } catch {}
  }
  if (lastResult.verdict === 'ok') break;
  fs.appendFileSync(
    logFile,
    `[ladder] rung ${rung} ${lastResult.verdict} (exit ${lastResult.exitCode})\n`,
  );
  rung = nextRung(rung, { order: rungRunOrder });
}

if (scheduledCircuitAdmission.enforced && scheduledCircuitAdmission.reservationId) {
  try {
    settleBriefingModelLaunch({
      date: scheduledCircuitAdmission.date,
      dataDir: DATA_DIR,
      reservationId: scheduledCircuitAdmission.reservationId,
      outcome: lastResult && lastResult.verdict === 'ok' ? `answered:${rung}` : 'all-rungs-failed',
    });
  } catch (error) {
    fs.appendFileSync(logFile, `[night-circuit] settlement failed closed: ${error.message}\n`);
  }
}

if (CANARY_MODE) {
  const receipt = recordRescueCanary({
    rung: lastResult && lastResult.verdict === 'ok' ? rung : 'none',
    observedOutput: lastResult ? lastResult.output : '',
    worktreeRoot:
      lastCodexCwd || process.env.RUN_SCHEDULED_SKILL_CANARY_WORKTREE_ROOT || SECONDBRAIN_ROOT,
    failureReason:
      lastResult && lastResult.verdict !== 'ok'
        ? `all canary ladder rungs failed; last verdict ${lastResult.verdict}`
        : '',
  });
  console.log(
    `[scheduled-skill-canary] ${receipt.ok ? 'PASS' : 'FAIL'} ${receipt.releaseSha} ${receipt.failures.join(', ')}`,
  );
  process.exit(receipt.ok ? 0 : 1);
}

if (lastResult.verdict === 'ok') {
  try {
    closeMemoryConsolidationTokenReceipt(lastResult);
  } catch (error) {
    lastResult = {
      ...lastResult,
      verdict: 'failed',
      exitCode: 1,
      output: `${lastResult.output}\nTOKEN RECEIPT CLOSURE FAILED: ${error.message}`,
    };
  }
}

if (lastResult.verdict === 'ok') {
  appendOutcome({ rung, ok: true, exitCode: 0 });
  try {
    hooks.recordSkillOutcome(skillName, {
      input: lessonInputDescriptor,
      exitCode: 0,
      output: `[via ${rung}] ` + lastResult.output,
    });
  } catch (e) {
    fs.appendFileSync(logFile, `LESSONS append failed: ${e.message}\n`);
  }
  const done = `SUCCESS (via ${rung}): ${skillName} completed at ${new Date().toISOString()}\n`;
  fs.appendFileSync(logFile, done);
  console.log(done);
} else {
  // Every rung failed: honest FAILED, nonzero exit, durable outcome row. The
  // 2:45am diagnostic (probeScheduledSkillOutcomes) surfaces this in the
  // briefing; no SUCCESS lie, no silent death.
  appendOutcome({
    rung: 'none',
    ok: false,
    exitCode: lastResult.exitCode,
    verdict: lastResult.verdict,
    tail: String(lastResult.output || '').slice(-300),
  });
  try {
    hooks.recordSkillOutcome(skillName, {
      input: lessonInputDescriptor,
      exitCode: lastResult.exitCode || 1,
      output: lastResult.output,
    });
  } catch (e) {
    fs.appendFileSync(logFile, `LESSONS append failed: ${e.message}\n`);
  }
  const msg = `FAILED: all ladder rungs failed for ${skillName} (last verdict ${lastResult.verdict})`;
  fs.appendFileSync(logFile, msg + '\n');
  console.error(msg);
  process.exit(lastResult.exitCode || 1);
}
