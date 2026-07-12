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
const { ensureCodexWorktree, isSharedCheckout } = require('./lib/codex-worktree.js');
const { landScanOutputs } = require('./lib/scan-output-lander.js');

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

const SECONDBRAIN_ROOT = process.env.SECONDBRAIN_ROOT || path.resolve(__dirname, '..');
const DATA_DIR = process.env.SECONDBRAIN_DATA_DIR || path.join(SECONDBRAIN_ROOT, 'data');
const skillFile = path.join(SECONDBRAIN_ROOT, 'scheduled-tasks', skillName, 'SKILL.md');
const directConfigFile = path.join(SECONDBRAIN_ROOT, 'scheduled-tasks', skillName, 'direct.json');
const OUTCOMES_LEDGER = path.join(DATA_DIR, 'agent', 'scheduled-skill-outcomes.jsonl');

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

if (process.env.RUN_SCHEDULED_SKILL_ISOLATED !== '1' && isSharedCheckout(SECONDBRAIN_ROOT)) {
  try {
    const isolated = ensureCodexWorktree({
      repoRoot: SECONDBRAIN_ROOT,
      purpose: `scheduled-skill-${skillName}`,
      branchPrefix: 'codex/scheduled-skill',
      linkNodeModules: false,
    });
    const childEnv = {
      ...process.env,
      SECONDBRAIN_ROOT: isolated.cwd,
      SECONDBRAIN_DATA_DIR: DATA_DIR,
      RUN_SCHEDULED_SKILL_ISOLATED: '1',
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
          ['-C', SECONDBRAIN_ROOT, 'worktree', 'remove', '--force', isolated.cwd],
          {
            encoding: 'utf8',
            timeout: 60000,
          },
        );
        if (st.status === 0 && isolated.branch) {
          spawnSync('git', ['-C', SECONDBRAIN_ROOT, 'branch', '-D', isolated.branch], {
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
const prompt = hooks.buildPromptWithLessons(skillName, basePrompt);
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

function runCodexRung() {
  // OpenAI-subscription rescue rung (approved plan P1). workspace-write
  // sandbox: the skill needs to edit repo files, but codex stays inside the
  // workspace (no secret paths, no system writes). Final answer comes from
  // --output-last-message; stdout is narration.
  const outFile = path.join(os.tmpdir(), `skill-codex-${process.pid}-${Date.now()}.txt`);
  let codexCwd;
  try {
    codexCwd = ensureCodexWorktree({
      repoRoot: SECONDBRAIN_ROOT,
      purpose: `scheduled-skill-${skillName}`,
      branchPrefix: 'codex/scheduled-skill',
    }).cwd;
  } catch (e) {
    return {
      verdict: 'failed',
      output: `Codex isolation failed: ${e.message}`,
      exitCode: -1,
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
