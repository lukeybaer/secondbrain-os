#!/usr/bin/env node
/**
 * heal-executor.js
 *
 * Unified self-heal executor. Self-heal needs to be able to run a coding
 * session via EITHER the Claude Code CLI OR the Codex CLI, with automatic
 * fallback between them, so a hang or failure in one does not stall the
 * overnight clean-briefing goal. Both are first-class.
 *
 * Why both, and why fallback:
 *   - 2026-06-01 root cause: the `claude` CLI spawned from a node
 *     child_process on this Windows box hung silently (zero output,
 *     SIGKILL) because the user-scope codex Claude Code plugin registers
 *     hooks that do a blocking fs.readFileSync(0); the spawned child's
 *     hook stdin never EOFs, so it deadlocks. THE FIX: spawn claude with
 *     `--setting-sources ''` so the plugin never loads in the child.
 *     Confirmed clean across many runs (code 0, ~7s, full output).
 *   - Codex works from node spawn via `cmd.exe /c codex exec`.
 *   - Either can fail transiently. runWithFallback tries the primary, and
 *     on an EXECUTOR-FAULT escalation (timeout / hang / nonzero exit /
 *     empty / parse failure) falls back to the secondary. On a
 *     GENUINE-WALL escalation (needs a ExampleCo decision, cannot determine
 *     intent) it does NOT fall back, because the other model hits the
 *     same wall and it would only waste budget.
 *
 * Each executor adapter owns BOTH its CLI shape and its result parser.
 * The previous orchestrator bug was spawning codex while parsing claude
 * stream-json; binding the parser to the executor prevents that class of
 * error structurally.
 *
 * The model's self-reported {status:"cleared"} is ADVISORY only. The
 * caller (healBlockerUntilGreen) must verify by re-running the actual
 * failing test. This module just runs a session and normalizes the
 * result; it does not decide truth.
 */

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const { buildClaudeCliEnv } = require('./cli-output-guard.js');

const IS_WIN = process.platform === 'win32';

// 2026-06-10 incident (feedback_codex_orphan_leak_thrashes_briefing.md): on
// Windows the adapters spawn `cmd.exe /c codex ...` / `cmd.exe /c claude ...`,
// so child.kill() kills ONLY cmd.exe -- the codex/claude grandchildren survive,
// orphan, and deadlock on stdin. Thousands of these accumulated and thrashed
// the box so Bedrock timed out and the briefing shipped 4h late. Kill the whole
// PROCESS TREE (taskkill /T) so no grandchild is left behind. On POSIX the
// adapter child is the real process, so a SIGKILL is sufficient.
function treeKill(child) {
  if (!child || !child.pid) return;
  if (IS_WIN) {
    try {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        timeout: 8000,
      });
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {}
    }
  } else {
    try {
      child.kill('SIGKILL');
    } catch {}
  }
}
const CLAUDE_BIN_WIN = process.env.APPDATA
  ? path.join(process.env.APPDATA, 'npm', 'claude.cmd')
  : 'claude.cmd';
const REPO = path.resolve(__dirname, '..', '..');

// Generous default: real fixes take time. Bounded by the caller's global
// deadline, not by a tight per-attempt cap. 30 minutes.
const DEFAULT_BUDGET_MS = 30 * 60 * 1000;
// If a child produces ZERO bytes for this long, treat it as a hang and
// escalate (executor-fault) so the caller can fall back. The claude-plugin
// deadlock manifested as zero bytes for the whole budget; 90s with no
// first byte is decisively a hang, not slow thinking (both CLIs emit
// startup/stream chatter within seconds when healthy).
const DEFAULT_HANG_MS = 90 * 1000;
// Once a worker has emitted output, it still has to keep making progress. A
// long-running test or fetch can be quiet for a bit, but an 8-minute silent
// tail is a wedged worker, not useful thinking. The outer budget remains
// generous; this watchdog catches forgotten grandchildren and stalled tools.
const DEFAULT_IDLE_MS = 8 * 60 * 1000;
const DEFAULT_CODEX_FINAL_SETTLE_MS = 750;

// Escalation reason categories. EXECUTOR_FAULT => worth trying the other
// executor. GENUINE_WALL => both will hit it; do not fall back.
const FAULT = 'executor-fault';
const WALL = 'genuine-wall';

function cleanEnv() {
  const e = { ...process.env };
  // Strip the markers that make a spawned claude think it is nested inside
  // a parent CC session and refuse / mis-route.
  delete e.CLAUDECODE;
  delete e.CLAUDE_CODE_ENTRYPOINT;
  delete e.CLAUDE_CODE_SSE_PORT;
  return e;
}

function workerEnv(opts = {}) {
  // Compose: cleanEnv() strips the nested-CC session markers; buildClaudeCliEnv()
  // then injects CLAUDE_CODE_OAUTH_TOKEN from the pushed token file and strips any
  // stray ANTHROPIC_API_KEY, so the spawned worker authenticates exactly like an
  // attended session instead of hitting "API Error: 401" before its prompt.
  // Without this the overnight fan-out spawned 12 dead sessions every night.
  const e = buildClaudeCliEnv(cleanEnv(), opts.tokenPath);
  if (opts.cwd) e.SB_SELF_HEAL_WORKER_ROOT = opts.cwd;
  if (opts.coordinatorRoot) e.SB_SELF_HEAL_COORDINATOR_ROOT = opts.coordinatorRoot;
  const protectedRoots = [
    ...new Set([opts.coordinatorRoot].concat(opts.protectedRoots || []).filter(Boolean)),
  ];
  if (protectedRoots.length) e.SB_SELF_HEAL_PROTECTED_ROOTS = protectedRoots.join(';');
  return e;
}

function quoteSettingCommandPath(p) {
  return String(p || '')
    .replace(/\\/g, '/')
    .replace(/"/g, '\\"');
}

function buildSelfHealWorkerSettings(opts = {}) {
  const cwd = opts.cwd || REPO;
  const hookPath = path.join(cwd, 'scripts', 'claude-hooks', 'self-heal-worker-guard.mjs');
  const hook = {
    type: 'command',
    command: `node "${quoteSettingCommandPath(hookPath)}"`,
    timeout: 5000,
  };
  return JSON.stringify({
    permissions: { defaultMode: 'bypassPermissions' },
    hooks: {
      // Task/Agent are matched so the worker guard's inline-only block actually
      // fires in production. The worker escalates 0-cleared when it spawns a
      // background Task (the fix detaches). The guard rejects Task/Agent by name,
      // but a PreToolUse hook only runs for tools named in its matcher, so Task
      // and Agent MUST be listed here or the block is dead in prod (Codex HOLD
      // 2026-06-30).
      PreToolUse: ['Bash', 'Task', 'Agent', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'].map(
        (matcher) => ({
          matcher,
          hooks: [hook],
        }),
      ),
    },
  });
}

// ── Parsers ───────────────────────────────────────────────────────────────

// Claude --print --output-format=stream-json: newline-delimited JSON; the
// final assistant text is the last {type:"result"}.result. The session is
// prompted to end with a single {...} contract object.
function parseClaudeResult(stdout) {
  if (!stdout || !stdout.trim()) {
    return { status: 'escalated', escalationReason: 'empty CLI output', category: FAULT };
  }
  const lines = stdout.split(/\r?\n/).filter(Boolean);
  let resultText = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry && entry.type === 'result' && typeof entry.result === 'string') {
        resultText = entry.result;
        break;
      }
    } catch {
      /* keep walking */
    }
  }
  if (!resultText) {
    return {
      status: 'escalated',
      escalationReason: 'no result block in stream-json',
      category: FAULT,
    };
  }
  return parseContractObject(resultText);
}

function parseClaudeStreamResultLine(line) {
  try {
    const entry = JSON.parse(line);
    if (entry && entry.type === 'result' && typeof entry.result === 'string') {
      return parseContractObject(entry.result);
    }
  } catch {
    /* not a complete stream-json row */
  }
  return null;
}

function findNestedBackgroundTaskId(value, depth = 0) {
  if (!value || depth > 6) return '';
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNestedBackgroundTaskId(item, depth + 1);
      if (found) return found;
    }
    return '';
  }
  if (typeof value !== 'object') return '';
  if (typeof value.backgroundTaskId === 'string' && value.backgroundTaskId) {
    return value.backgroundTaskId;
  }
  for (const child of Object.values(value)) {
    const found = findNestedBackgroundTaskId(child, depth + 1);
    if (found) return found;
  }
  return '';
}

function parseClaudeBackgroundTaskLine(line) {
  try {
    const entry = JSON.parse(line);
    if (!entry || typeof entry !== 'object') return null;
    if (entry.subtype === 'task_started') {
      return { taskId: String(entry.task_id || entry.taskId || '') };
    }
    const taskId = findNestedBackgroundTaskId(entry);
    if (taskId) return { taskId };
  } catch {
    /* not a complete stream-json row */
  }
  return null;
}

// Codex exec writes its final message to stderr (run log) in plain text; the
// session is prompted to emit a single {...} contract object. Scan the whole
// blob from the bottom for the last parseable {...} with a "status" field.
function parseCodexResult(stderr, stdout) {
  const blob = (stderr || '') + '\n' + (stdout || '');
  if (!blob.trim()) {
    return { status: 'escalated', escalationReason: 'empty CLI output', category: FAULT };
  }
  return parseContractObject(blob);
}

function contractObjectCandidates(text) {
  const s = String(text || '');
  const candidates = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (ch !== '}' || depth <= 0) continue;
    depth -= 1;
    if (depth === 0 && start >= 0) {
      const candidate = s.slice(start, i + 1);
      if (candidate.includes('"status"')) candidates.push(candidate);
      start = -1;
    }
  }
  return candidates;
}

function lineContractObjectCandidates(text) {
  const candidates = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const stripped = stripAnsi(line);
    candidates.push(...contractObjectCandidates(stripped));
  }
  return candidates;
}

function stripAnsi(text) {
  return String(text || '').replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

// Shared: find the last balanced JSON object containing "status" and validate
// the contract. Strings may mention object literals like "{}"; regex parsing
// cannot safely distinguish those from real JSON braces.
function parseContractObject(text) {
  const candidates = [
    ...contractObjectCandidates(text),
    // Codex transcripts commonly include arbitrary diffs before the final
    // contract. A lone "{" in a diff can swallow the real JSON when scanning
    // the whole blob, so also scan each line independently.
    ...lineContractObjectCandidates(text),
  ];
  let parsed = null;
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const p = JSON.parse(candidates[i]);
      if (p && typeof p === 'object' && p.status) {
        parsed = p;
        break;
      }
    } catch {
      /* keep walking */
    }
  }
  if (!parsed) {
    return {
      status: 'escalated',
      escalationReason: 'no JSON status block in output',
      category: FAULT,
    };
  }
  const status = String(parsed.status || '').toLowerCase();
  const commit_sha = String(parsed.commit_sha || '');
  const pushed = parsed.pushed === true;
  if (status === 'cleared' || status === 'repaired') {
    return {
      status: status === 'cleared' ? 'cleared' : 'repaired',
      commit_sha,
      pushed,
      summary: parsed.summary || parsed.verification || '',
      tests: parsed.tests || '',
      reflection: parsed.reflection || '',
      defects: Array.isArray(parsed.defects) ? parsed.defects : [],
    };
  }
  // The session itself reported escalated. Categorize by the reason text so
  // the caller knows whether a different executor could help.
  const reason = String(parsed.escalation_reason || parsed.summary || 'session reported escalated');
  const category =
    /\b(ExampleCo|credential|password|api[\s-]?key|approve|approval|decision|decide|cannot determine|can.t determine|interview|in[\s-]?person|sign|consent)\b|external\s+(?:approval|decision|access|account|credential|permission|consent)\b/i.test(
      reason,
    )
      ? WALL
      : FAULT;
  return {
    status: 'escalated',
    escalationReason: reason,
    category,
    commit_sha,
    pushed,
    summary: parsed.summary || '',
    reflection: parsed.reflection || '',
    tests: parsed.tests || '',
    defects: Array.isArray(parsed.defects) ? parsed.defects : [],
  };
}

function parseStandaloneContractLine(line) {
  const stripped = stripAnsi(line).trim();
  if (!stripped.startsWith('{') || !stripped.endsWith('}')) return null;
  try {
    const parsed = JSON.parse(stripped);
    return parsed && typeof parsed === 'object' && parsed.status ? parsed : null;
  } catch {
    return null;
  }
}

// ── Spawn adapters ──────────────────────────────────────────────────────────

function buildClaudeArgs(prompt, opts = {}) {
  return [
    '--print',
    '--output-format=stream-json',
    '--include-partial-messages',
    '--verbose',
    // THE FIX: empty setting-sources disables user/project/local settings so
    // the codex CC plugin (whose blocking-stdin hook deadlocks the child)
    // never loads. Must go through cmd.exe /c with shell:false so the empty
    // arg survives Windows quoting; shell:true silently drops it.
    '--setting-sources',
    '',
    '--settings',
    buildSelfHealWorkerSettings(opts),
    '--dangerously-skip-permissions',
    '-p',
    prompt,
  ];
}

function buildCodexArgs(prompt, opts = {}) {
  const cwd = opts.cwd || REPO;
  return ['exec', '--skip-git-repo-check', '--sandbox', 'workspace-write', '--cd', cwd, prompt];
}

function spawnClaude(prompt, opts) {
  const args = buildClaudeArgs(prompt, opts);
  if (IS_WIN) {
    return spawn('cmd.exe', ['/c', CLAUDE_BIN_WIN, ...args], {
      cwd: opts.cwd || REPO,
      shell: false,
      windowsHide: true,
      env: workerEnv(opts),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
  return spawn('claude', args, {
    cwd: opts.cwd || REPO,
    shell: false,
    windowsHide: true,
    env: workerEnv(opts),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function spawnCodex(prompt, opts) {
  const cwd = opts.cwd || REPO;
  const codexArgs = buildCodexArgs(prompt, opts);
  if (IS_WIN) {
    return spawn('cmd.exe', ['/c', 'codex', ...codexArgs], {
      cwd,
      shell: false,
      windowsHide: true,
      env: workerEnv(opts),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
  return spawn('codex', codexArgs, {
    cwd,
    shell: false,
    windowsHide: true,
    env: workerEnv(opts),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const ADAPTERS = {
  claude: { spawn: spawnClaude, parse: (stderr, stdout) => parseClaudeResult(stdout) },
  codex: { spawn: spawnCodex, parse: (stderr, stdout) => parseCodexResult(stderr, stdout) },
};

// ── Core runner ─────────────────────────────────────────────────────────────

/**
 * Run one self-heal session via the chosen executor.
 * @param {string} prompt
 * @param {object} opts {executor:'claude'|'codex', budgetMs, hangMs, idleMs, cwd, onStream(chunk,stream)}
 * @returns {Promise<object>} {status, executor, category?, commit_sha, pushed, summary, tests,
 *                             escalationReason?, stdout, stderr, exitCode, durationMs}
 */
function runHealSession(prompt, opts = {}) {
  const executor = opts.executor || 'claude';
  const adapter = opts.adapter || ADAPTERS[executor];
  if (!adapter)
    return Promise.resolve({
      status: 'escalated',
      executor,
      escalationReason: `ExampleCo executor ${executor}`,
      category: FAULT,
    });
  const budgetMs = opts.budgetMs || DEFAULT_BUDGET_MS;
  const hangMs = opts.hangMs || DEFAULT_HANG_MS;
  const idleMs = opts.idleMs === 0 ? 0 : opts.idleMs || DEFAULT_IDLE_MS;
  const codexFinalSettleMs =
    opts.codexFinalSettleMs === 0
      ? 0
      : Number(opts.codexFinalSettleMs || DEFAULT_CODEX_FINAL_SETTLE_MS);
  const startMs = Date.now();

  return new Promise((resolve) => {
    let child;
    try {
      child = adapter.spawn(prompt, opts);
    } catch (e) {
      return resolve({
        status: 'escalated',
        executor,
        escalationReason: `spawn threw: ${String(e.message || e)}`,
        category: FAULT,
        stdout: '',
        stderr: '',
        exitCode: 127,
        durationMs: Date.now() - startMs,
      });
    }
    let stdout = '',
      stderr = '',
      done = false,
      gotByte = false,
      earlyFinalResult = false,
      earlyFinalParsed = null,
      codexFinalSettleTimer = null,
      claudeLineBuffer = '',
      codexStdoutLineBuffer = '',
      codexStderrLineBuffer = '';

    const finish = (exitCode, forcedReason, parsedOverride, extra = {}) => {
      if (done) return;
      done = true;
      try {
        clearTimeout(budgetTimer);
      } catch {}
      try {
        clearTimeout(hangTimer);
      } catch {}
      try {
        clearTimeout(idleTimer);
      } catch {}
      try {
        clearTimeout(codexFinalSettleTimer);
      } catch {}
      const base = {
        executor,
        stdout,
        stderr,
        exitCode,
        durationMs: Date.now() - startMs,
        earlyFinalResult,
        ...extra,
      };
      if (forcedReason)
        return resolve({
          status: 'escalated',
          escalationReason: forcedReason,
          category: FAULT,
          ...base,
        });
      if (exitCode !== 0)
        return resolve({
          status: 'escalated',
          escalationReason: `${executor} CLI exited with code ${exitCode}`,
          category: FAULT,
          ...base,
        });
      const parsed = parsedOverride || adapter.parse(stderr, stdout);
      resolve({ ...parsed, ...base });
    };

    const budgetTimer = setTimeout(() => {
      treeKill(child);
      finish(124, `${executor} exceeded budget ${Math.round(budgetMs / 1000)}s`, null, {
        watchdog: { kind: 'budget', killed: true, thresholdMs: budgetMs },
      });
    }, budgetMs);

    // Hang detection: if no first byte within hangMs, it is the deadlock
    // signature, not slow work. Kill early so fallback can run sooner.
    let hangTimer = setTimeout(() => {
      if (gotByte) return;
      treeKill(child);
      finish(124, `${executor} produced no output for ${Math.round(hangMs / 1000)}s (hang)`, null, {
        watchdog: { kind: 'first-byte-hang', killed: true, thresholdMs: hangMs },
      });
    }, hangMs);

    let idleTimer = null;
    const armIdleTimer = () => {
      if (!idleMs || done) return;
      try {
        clearTimeout(idleTimer);
      } catch {}
      idleTimer = setTimeout(() => {
        treeKill(child);
        finish(
          124,
          `${executor} produced no output for ${Math.round(idleMs / 1000)}s after prior output (idle hang)`,
          null,
          { watchdog: { kind: 'idle-hang', killed: true, thresholdMs: idleMs } },
        );
      }, idleMs);
    };

    const maybeFinishFromClaudeResult = (line) => {
      if (executor !== 'claude') return false;
      const parsed = parseClaudeStreamResultLine(line);
      if (!parsed) return false;
      earlyFinalResult = true;
      const contractMiss =
        parsed.status === 'escalated' &&
        /no JSON status block/i.test(parsed.escalationReason || '');
      treeKill(child);
      finish(0, null, parsed, {
        watchdog: contractMiss
          ? { kind: 'contract-miss', killed: true, thresholdMs: 0 }
          : undefined,
      });
      return true;
    };

    const maybeFinishFromClaudeBackgroundTask = (line) => {
      if (executor !== 'claude') return false;
      const backgroundTask = parseClaudeBackgroundTaskLine(line);
      if (!backgroundTask) return false;
      treeKill(child);
      finish(124, `${executor} started a nested background task inside a self-heal worker`, null, {
        watchdog: {
          kind: 'nested-background-task',
          killed: true,
          thresholdMs: 0,
          taskId: backgroundTask.taskId || '',
        },
      });
      return true;
    };

    const maybeFinishFromCodexContract = (line) => {
      if (executor !== 'codex') return false;
      const parsed = parseStandaloneContractLine(line);
      if (!parsed) return false;
      earlyFinalResult = true;
      earlyFinalParsed = parsed;
      codexFinalSettleTimer = setTimeout(() => {
        treeKill(child);
        finish(0, null, parsed);
      }, codexFinalSettleMs);
      return true;
    };

    const consumeClaudeStdout = (s) => {
      if (executor !== 'claude' || done) return;
      claudeLineBuffer += s;
      const lines = claudeLineBuffer.split(/\r?\n/);
      claudeLineBuffer = lines.pop() || '';
      for (const line of lines) {
        if (maybeFinishFromClaudeBackgroundTask(line)) break;
        if (maybeFinishFromClaudeResult(line)) break;
      }
    };

    const consumeCodexStream = (s, streamName) => {
      if (executor !== 'codex' || done) return;
      const maybeFinishFromBufferedContract = (buffer) => {
        const trimmed = String(buffer || '').trim();
        if (!trimmed) return false;
        return maybeFinishFromCodexContract(trimmed);
      };
      if (streamName === 'stdout') {
        codexStdoutLineBuffer += s;
        if (maybeFinishFromBufferedContract(codexStdoutLineBuffer)) return;
        const lines = codexStdoutLineBuffer.split(/\r?\n/);
        codexStdoutLineBuffer = lines.pop() || '';
        for (const line of lines) {
          if (maybeFinishFromCodexContract(line)) break;
        }
        return;
      }
      codexStderrLineBuffer += s;
      if (maybeFinishFromBufferedContract(codexStderrLineBuffer)) return;
      const lines = codexStderrLineBuffer.split(/\r?\n/);
      codexStderrLineBuffer = lines.pop() || '';
      for (const line of lines) {
        if (maybeFinishFromCodexContract(line)) break;
      }
    };

    child.stdout.on('data', (c) => {
      gotByte = true;
      const s = c.toString('utf8');
      stdout += s;
      if (opts.onStream) opts.onStream(s, 'stdout');
      armIdleTimer();
      consumeClaudeStdout(s);
      consumeCodexStream(s, 'stdout');
    });
    child.stderr.on('data', (c) => {
      gotByte = true;
      const s = c.toString('utf8');
      stderr += s;
      if (opts.onStream) opts.onStream(s, 'stderr');
      armIdleTimer();
      consumeCodexStream(s, 'stderr');
    });
    child.on('close', (code) =>
      finish(earlyFinalParsed ? 0 : code || 0, null, earlyFinalParsed || undefined),
    );
    child.on('error', (e) => {
      stderr += '\nspawn error: ' + String(e.message || e);
      finish(127);
    });
  });
}

/**
 * Run a session with automatic fallback. Try primary; if it CLEARS, done.
 * If it escalates with an EXECUTOR-FAULT reason, try the secondary. If it
 * escalates with a GENUINE-WALL reason, return it without wasting the
 * secondary (the other model hits the same wall).
 * @param {string} prompt
 * @param {object} opts {primary:'claude'|'codex', secondary, budgetMs, hangMs, cwd, onStream}
 * @returns {Promise<object>} the winning/last result, with .attempts[] of every try
 */
async function runWithFallback(prompt, opts = {}) {
  const primary = opts.primary || 'claude';
  const secondary = opts.secondary || (primary === 'claude' ? 'codex' : 'claude');
  const attempts = [];

  const first = await runHealSession(prompt, { ...opts, executor: primary });
  attempts.push({
    executor: primary,
    status: first.status,
    category: first.category,
    escalationReason: first.escalationReason,
    durationMs: first.durationMs,
    watchdog: first.watchdog || null,
    earlyFinalResult: !!first.earlyFinalResult,
    commit_sha: first.commit_sha || '',
    pushed: !!first.pushed,
  });
  if (first.status === 'cleared') return { ...first, attempts };
  if (first.category === WALL) return { ...first, attempts, fallbackSkipped: 'genuine-wall' };

  const second = await runHealSession(prompt, { ...opts, executor: secondary });
  attempts.push({
    executor: secondary,
    status: second.status,
    category: second.category,
    escalationReason: second.escalationReason,
    durationMs: second.durationMs,
    watchdog: second.watchdog || null,
    earlyFinalResult: !!second.earlyFinalResult,
    commit_sha: second.commit_sha || '',
    pushed: !!second.pushed,
  });
  if (second.status === 'cleared') return { ...second, attempts };

  // Both escalated. Return whichever is the more useful signal (a WALL from
  // the secondary is more informative than a FAULT).
  const best = second.category === WALL ? second : first;
  return { ...best, attempts };
}

module.exports = {
  buildClaudeArgs,
  buildCodexArgs,
  buildSelfHealWorkerSettings,
  runHealSession,
  runWithFallback,
  workerEnv,
  parseClaudeResult,
  parseClaudeStreamResultLine,
  parseClaudeBackgroundTaskLine,
  parseCodexResult,
  parseContractObject,
  FAULT,
  WALL,
  DEFAULT_BUDGET_MS,
  DEFAULT_HANG_MS,
  DEFAULT_IDLE_MS,
  DEFAULT_CODEX_FINAL_SETTLE_MS,
};
