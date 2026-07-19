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
const { classifyRunOutput, nextRung } = require('./lib/skill-runner-ladder.js');
const {
  ensureCodexWorktree,
  isSharedCheckout,
  probeWorkTree,
  proveWorktreeIsolation,
  resolveCodexSourceRoot,
} = require('./lib/codex-worktree.js');
const { landScanOutputs } = require('./lib/scan-output-lander.js');
const {
  buildRescueCanaryReceipt,
  writeRescueCanaryReceipt,
} = require('./lib/scheduled-skill-rescue-canary.js');

// Git-worthy output areas a scheduled skill legitimately produces: its own
// LESSONS.md / skill files and Tier-2 memory (contact scans, notes). Tracked
// data ledgers (big-decisions) ride along when a skill touched them. Code
// changes are NOT auto-landed here; a skill that edits code must land through
// its own land.js run so the scoped test gate sees intent, not side effects.
const SKILL_OUTPUT_PATHSPECS = ['scheduled-tasks', 'memory', 'data'];

const skillName = process.argv[2];
if (!skillName) {
  console.error('Usage: node run-scheduled-skill.js <skill-name>');
  process.exit(1);
}

const CANARY_MODE = process.env.RUN_SCHEDULED_SKILL_CANARY === '1';
const CANARY_SENTINEL = String(
  process.env.RUN_SCHEDULED_SKILL_CANARY_SENTINEL ||
    'SECOND_BRAIN_SCHEDULED_SKILL_RESCUE_OK:ExampleCo',
);

const SECONDBRAIN_ROOT = process.env.SECONDBRAIN_ROOT || path.resolve(__dirname, '..');
const DATA_DIR = process.env.SECONDBRAIN_DATA_DIR || path.join(SECONDBRAIN_ROOT, 'data');
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

if (!fs.existsSync(skillFile)) {
  console.error(`SKILL.md not found: ${skillFile}`);
  process.exit(1);
}

const ROOT_IS_SHARED_CHECKOUT = isSharedCheckout(SECONDBRAIN_ROOT);
const CODEX_REPO_IS_SHARED_CHECKOUT = isSharedCheckout(CODEX_REPO_ROOT);
const NEEDS_ISOLATED_RERUN =
  ROOT_IS_SHARED_CHECKOUT ||
  (!HAS_DIRECT_CONFIG &&
    (CODEX_REPO_IS_SHARED_CHECKOUT ||
      path.resolve(CODEX_REPO_ROOT) !== path.resolve(SECONDBRAIN_ROOT) ||
      CODEX_SOURCE_ROOT.originalState === 'not-worktree'));

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
    });
    const childEnv = {
      ...process.env,
      SECONDBRAIN_ROOT: isolated.cwd,
      SECONDBRAIN_DATA_DIR: DATA_DIR,
      RUN_SCHEDULED_SKILL_ISOLATED: '1',
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
    // LAND STEP (2026-07-12 shared-checkout writer fix): the child ran in an
    // isolated worktree, so its git-worthy outputs (LESSONS.md append, contact
    // scan updates, memory notes) live only in that worktree. Without landing
    // they rot there and the NEXT run reads stale lessons; historically this
    // is also how the shared checkout accumulated dirt (runs that skipped
    // isolation). Land the scoped outputs through the normal gate, then reap
    // the worktree so scheduled runs never leak orphans. A landing failure is
    // ledgered loudly but never converts the skill's own exit status.
    try {
      const landed = landScanOutputs({
        repoRoot: isolated.cwd,
        pathspecs: SKILL_OUTPUT_PATHSPECS,
        message: `chore(scheduled): ${skillName} run outputs`,
        purpose: `skill-outputs-${skillName}`,
        log: (line) => fs.appendFileSync(logFile, String(line) + '\n'),
      });
      appendOutcome({
        rung: 'land-outputs',
        ok: landed.ok,
        exitCode: landed.ok ? 0 : 1,
        verdict: landed.landed ? 'landed' : landed.reason || 'clean',
        files: landed.files,
      });
      if (landed.ok) {
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
      appendOutcome({
        rung: 'land-outputs',
        ok: false,
        exitCode: 1,
        verdict: 'land-threw',
        tail: String(e.message || e).slice(-300),
      });
      fs.appendFileSync(logFile, `land-outputs failed: ${e.message}\n`);
    }
    process.exit(Number.isFinite(child.status) ? child.status : 1);
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

const GRAPHITI_ADVISOR_CLI = path.join(SECONDBRAIN_ROOT, 'scripts', 'graphiti-brain-advisor.js');
let graphitiAdvisorId = '';
function startGraphitiAdvisor() {
  const request = {
    prompt: `Run the scheduled Amy skill ${skillName}`,
    action: `Execute scheduled-tasks/${skillName}/SKILL.md and persist its authorized outputs`,
    surface: 'scheduled-skill',
    conversationId: `scheduled-${skillName}-${process.env.AMY_SCHEDULE_DATE || new Date().toISOString().slice(0, 10)}`,
    project: skillName,
    visibility: 'owner_private',
  };
  const result = spawnSync(process.execPath, [GRAPHITI_ADVISOR_CLI, 'start'], {
    cwd: SECONDBRAIN_ROOT,
    env: { ...process.env, SECONDBRAIN_DATA_DIR: DATA_DIR },
    input: JSON.stringify(request),
    encoding: 'utf8',
    timeout: 5000,
  });
  try {
    graphitiAdvisorId = JSON.parse(result.stdout || '{}').advisor_id || '';
  } catch {
    graphitiAdvisorId = '';
  }
}

function graphitiAdvisorContext() {
  if (!graphitiAdvisorId) {
    return 'Graphiti Brain Advisor was unavailable at start. Expose this first failure in Graphiti impact and do not invent recall.';
  }
  const result = spawnSync(
    process.execPath,
    [GRAPHITI_ADVISOR_CLI, 'context', '--advisor-id', graphitiAdvisorId, '--wait-ms', '30000'],
    {
      cwd: SECONDBRAIN_ROOT,
      env: { ...process.env, SECONDBRAIN_DATA_DIR: DATA_DIR },
      encoding: 'utf8',
      timeout: 35000,
    },
  );
  try {
    return (
      JSON.parse(result.stdout || '{}').prompt_block ||
      'Graphiti Brain Advisor context was unavailable.'
    );
  } catch {
    return 'Graphiti Brain Advisor context was unavailable. Expose the failure in Graphiti impact.';
  }
}

function recordGraphitiAdvisorOutput(output, answerActionId) {
  if (!graphitiAdvisorId) return;
  spawnSync(
    process.execPath,
    [
      GRAPHITI_ADVISOR_CLI,
      'receipt',
      '--advisor-id',
      graphitiAdvisorId,
      '--answer-action-id',
      answerActionId,
    ],
    {
      cwd: SECONDBRAIN_ROOT,
      env: { ...process.env, SECONDBRAIN_DATA_DIR: DATA_DIR },
      input: String(output || ''),
      encoding: 'utf8',
      timeout: 5000,
    },
  );
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

// This runs after worktree isolation and policy gates are proven, but before
// provider and direct-run preparation, so Graphiti overlaps ordinary work.
startGraphitiAdvisor();
const prompt = [baseSkillPrompt, '', graphitiAdvisorContext()].join('\n');

// Unset CLAUDECODE so the nested-session guard doesn't fire
const env = { ...process.env };
delete env.CLAUDECODE;

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
  const result = spawnSync(process.execPath, [script, ...args], RUN_OPTS);
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
  recordGraphitiAdvisorOutput(output, `scheduled-direct-${skillName}-${Date.now()}`);
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
  // daily direct.json skill like kingdom-equipping-ideas never accumulates
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

function runClaudeRung() {
  if (CANARY_MODE) {
    const output = 'Not logged in. Forced Claude failure for post-release rescue canary.';
    return { verdict: classifyRunOutput(0, output), output, exitCode: 0 };
  }
  if (process.platform === 'win32') {
    if (!fs.existsSync(CLAUDE_CLI_JS_WIN)) {
      return {
        verdict: 'failed',
        output: `Claude CLI not found: ${CLAUDE_CLI_JS_WIN}`,
        exitCode: -1,
      };
    }
    const result = spawnSync(process.execPath, [CLAUDE_CLI_JS_WIN, '-p', prompt], RUN_OPTS);
    if (result.error) {
      return { verdict: 'failed', output: `Spawn error: ${result.error.message}`, exitCode: -1 };
    }
    const output = [result.stdout, result.stderr].filter(Boolean).join('');
    return { verdict: classifyRunOutput(result.status, output), output, exitCode: result.status };
  }
  const result = spawnSync(process.env.CLAUDE_CLI || 'claude', ['-p', prompt], RUN_OPTS);
  if (result.error) {
    return { verdict: 'failed', output: `Spawn error: ${result.error.message}`, exitCode: -1 };
  }
  const output = [result.stdout, result.stderr].filter(Boolean).join('');
  return { verdict: classifyRunOutput(result.status, output), output, exitCode: result.status };
}

let lastCodexCwd = '';

function runCodexRung() {
  // OpenAI-subscription rescue rung (approved plan P1). workspace-write
  // sandbox: the skill needs to edit repo files, but codex stays inside the
  // workspace (no secret paths, no system writes). Final answer comes from
  // --output-last-message; stdout is narration.
  const outFile = path.join(os.tmpdir(), `skill-codex-${process.pid}-${Date.now()}.txt`);
  let codexCwd;
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
    'Branch cleanliness: this Codex rescue rung must work only in the current isolated worktree.',
    `Do not edit the shared checkout at ${SECONDBRAIN_ROOT}.`,
    '',
    prompt,
  ].join('\n');
  // Prompt rides STDIN: shell:true on Windows splits multiword argv on spaces.
  const result = spawnSync(
    'codex',
    ['exec', '--skip-git-repo-check', '-s', 'workspace-write', '--output-last-message', outFile],
    { ...RUN_OPTS, cwd: codexCwd, input: codexPrompt, shell: process.platform === 'win32' },
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
  return { verdict: classifyRunOutput(result.status, output), output, exitCode: result.status };
}

const RUNGS = { claude: runClaudeRung, codex: runCodexRung };

let rung = 'claude';
let lastResult = null;
while (rung) {
  fs.appendFileSync(logFile, `[ladder] attempting rung: ${rung}\n`);
  lastResult = RUNGS[rung]();
  fs.appendFileSync(logFile, lastResult.output + '\n');
  process.stdout.write(lastResult.output.slice(0, 4000) + '\n');
  if (lastResult.verdict === 'ok') break;
  fs.appendFileSync(
    logFile,
    `[ladder] rung ${rung} ${lastResult.verdict} (exit ${lastResult.exitCode})\n`,
  );
  rung = nextRung(rung);
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
  recordGraphitiAdvisorOutput(lastResult.output, `scheduled-${skillName}-${Date.now()}`);
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
  recordGraphitiAdvisorOutput(lastResult.output, `scheduled-${skillName}-${Date.now()}`);
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
