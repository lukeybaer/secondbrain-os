#!/usr/bin/env node
/**
 * codex-run.js, a reliable one-shot Codex runner.
 *
 * Why this exists: the `codex:codex-rescue` subagent runs the companion's `task`
 * command FOREGROUND inside a backgrounded Bash call. When the ephemeral
 * subagent returns its stub, the Codex worker (a child of that Bash process) is
 * torn down mid-run, so the job is orphaned as status:"running" forever and the
 * review/result is never delivered. Observed 2026-06-02: three reviews all
 * stuck "running", their worker pids dead, logs cut off mid-tool-call.
 *
 * The companion already has a DETACHED background worker (task --background,
 * spawnDetachedTaskWorker) that survives the parent. This wrapper launches that,
 * then polls the job state to a terminal status and prints the result. Run it
 * from a long-lived session (the main loop), not from the rescue subagent.
 *
 * Usage:
 *   node scripts/codex-run.js [--read-only] [--timeout-min N] [--effort E] "<prompt>"
 *   node scripts/codex-run.js --prompt-file path/to/prompt.txt
 *
 * Notes:
 *  - Do NOT pass --effort minimal: it is incompatible with the web_search and
 *    image_gen tools the task enables (Codex returns a 400).
 *  - Default is write-capable (matches the rescue contract). Pass --read-only
 *    for review/diagnosis with no edits.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { withCodexAmyPrelude } = require('./lib/codex-amy-prelude.js');

const PLUGIN_ROOT =
  process.env.CODEX_PLUGIN_ROOT ||
  path.join(os.homedir(), '.claude', 'plugins', 'cache', 'openai-codex', 'codex', '1.0.4');
const COMPANION = path.join(PLUGIN_ROOT, 'scripts', 'codex-companion.mjs');
const STATE_LIB = path.join(PLUGIN_ROOT, 'scripts', 'lib', 'state.mjs');

const TERMINAL = new Set(['succeeded', 'completed', 'done', 'failed', 'error', 'cancelled', 'canceled']);

// Pure: pull the task job id out of the companion's "started in the background
// as <id>" launch line. Exported for tests.
function parseJobId(launchOutput) {
  const m = String(launchOutput || '').match(/\btask-[a-z0-9]+-[a-z0-9]+\b/i);
  return m ? m[0] : null;
}

// Pure: is a job status terminal (stop polling)? Exported for tests.
function isTerminalStatus(status) {
  return TERMINAL.has(String(status || '').toLowerCase());
}

function companion(args, timeoutMs = 120000) {
  return spawnSync(process.execPath, [COMPANION, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function companionSupportsPromptFile(companionPath = COMPANION) {
  try {
    return /\bprompt-file\b/.test(fs.readFileSync(companionPath, 'utf8'));
  } catch {
    return false;
  }
}

function normalizeCliPath(p) {
  return String(p || '').replace(/\\/g, '/');
}

function registerPromptFileCleanup(promptFile, proc = process) {
  let cleaned = false;
  const cleanupPromptFile = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      fs.unlinkSync(promptFile);
    } catch {
      /* already gone */
    }
  };
  proc.once('exit', cleanupPromptFile);
  proc.once('SIGINT', () => {
    cleanupPromptFile();
    proc.exit(130);
  });
  proc.once('SIGTERM', () => {
    cleanupPromptFile();
    proc.exit(143);
  });
  return cleanupPromptFile;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM'; // exists but not signalable
  }
}

function parseArgs(argv) {
  const opts = { readOnly: false, timeoutMin: 20, effort: null, prompt: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--read-only') opts.readOnly = true;
    else if (a === '--timeout-min') opts.timeoutMin = parseInt(argv[++i], 10) || 20;
    else if (a === '--effort') opts.effort = argv[++i];
    else if (a === '--prompt-file') opts.prompt = fs.readFileSync(argv[++i], 'utf8');
    else rest.push(a);
  }
  if (!opts.prompt) opts.prompt = rest.join(' ');
  return opts;
}

function buildLaunchArgs(opts, promptFile) {
  const launchArgs = ['task', '--background', '--fresh'];
  if (!opts.readOnly) launchArgs.push('--write');
  if (opts.effort) launchArgs.push('--effort', opts.effort);
  launchArgs.push('--prompt-file', normalizeCliPath(promptFile));
  return launchArgs;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.prompt || !opts.prompt.trim()) {
    console.error('codex-run: a prompt is required (positional or --prompt-file).');
    process.exit(2);
  }
  if (opts.effort && opts.effort.toLowerCase() === 'minimal') {
    console.error('codex-run: refusing --effort minimal (incompatible with web_search/image_gen; Codex returns 400).');
    process.exit(2);
  }
  if (!fs.existsSync(COMPANION)) {
    console.error(`codex-run: companion not found at ${COMPANION}. Set CODEX_PLUGIN_ROOT.`);
    process.exit(2);
  }
  // Required for the Amy preload: MEMORY.md + AMY.md are too large and too
  // important to pass as a Windows argv string.
  if (!companionSupportsPromptFile(COMPANION)) {
    console.error(
      `codex-run: companion at ${COMPANION} does not support --prompt-file; update openai-codex plugin before using the Amy memory preload.`,
    );
    process.exit(2);
  }

  const { resolveJobsDir } = await import(pathToFileURL(STATE_LIB).href);
  const jobsDir = resolveJobsDir(process.cwd());

  const promptFile = path.join(
    os.tmpdir(),
    `codex-run-prompt-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.md`,
  );
  fs.writeFileSync(promptFile, withCodexAmyPrelude(opts.prompt), 'utf8');
  const cleanupPromptFile = registerPromptFileCleanup(promptFile);
  const launch = companion(buildLaunchArgs(opts, promptFile), 60000);
  const jobId = parseJobId(launch.stdout) || parseJobId(launch.stderr);
  if (!jobId) {
    cleanupPromptFile();
  }
  if (!jobId) {
    console.error('codex-run: could not launch a background task. Output:');
    console.error((launch.stdout || '') + (launch.stderr || ''));
    process.exit(1);
  }
  console.error(`codex-run: launched ${jobId}, polling (timeout ${opts.timeoutMin}m)...`);

  const deadline = Date.now() + opts.timeoutMin * 60 * 1000;
  const jobFile = path.join(jobsDir, `${jobId}.json`);
  let status = 'running';
  while (Date.now() < deadline) {
    await sleep(8000);
    try {
      const rec = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
      status = rec.status || status;
      if (isTerminalStatus(status)) break;
      // Detect a dead worker: pid gone while still "running" means orphaned.
      if (rec.pid && !pidAlive(rec.pid)) {
        console.error(`codex-run: worker pid ${rec.pid} is gone but status is "${status}"; treating as failed (orphaned).`);
        status = 'failed';
        break;
      }
    } catch {
      /* job file not written yet; keep polling */
    }
  }

  if (!isTerminalStatus(status)) {
    console.error(`codex-run: timed out after ${opts.timeoutMin}m; job ${jobId} still ${status}.`);
    cleanupPromptFile();
    process.exit(1);
  }

  // The background worker has reached a terminal status, so result retrieval no
  // longer needs the original prompt file.
  cleanupPromptFile();
  const res = companion(['result', jobId], 60000);
  process.stdout.write(res.stdout || '');
  if (res.stderr) process.stderr.write(res.stderr);
  process.exit(status === 'failed' || status === 'error' ? 1 : 0);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('codex-run: fatal', e && e.message);
    process.exit(1);
  });
}

module.exports = {
  parseJobId,
  isTerminalStatus,
  buildLaunchArgs,
  companionSupportsPromptFile,
  normalizeCliPath,
  registerPromptFileCleanup,
};
