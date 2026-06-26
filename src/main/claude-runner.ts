// claude-runner.ts
// Spawns `claude -p "prompt"` as a subprocess in the project working directory
// and returns the output. Used by the command queue worker.
//
// Supports five execution modes:
//   runClaudeCode()          new session (claude -p), full Tier 1 context load,
//                            blocks until done with a timeout watchdog
//   runClaudeCodeContinue()  continue most recent session (claude --continue -p)
//   runClaudeCodeIngest()    new session marked as ingest mode, routes
//                            SessionStart to the ~400-token stub hook
//   runClaudeCodeBackground() detached spawn, returns a handle immediately,
//                            no timeout. For the queue worker so it can
//                            keep polling other commands while a deep task
//                            runs in the background.
//   runClaudeCodeAndSummarize() runs either mode + summarizes for Telegram

import { spawn } from 'child_process';
import { app } from 'electron';
import Anthropic from '@anthropic-ai/sdk';

// 5 minutes was too short for the kinds of tasks Amy escalates from a Vapi
// call (deep search across many transcripts, multi-file refactors,
// cross-source analysis). ExampleCo 2026-05-05 incident: a "did I talk to PRIVATE_NAME
// between Feb and March" task hit the 5 min wall and returned exit -1.
// 15 min is the soft default for the blocking wrapper; the queue worker
// uses runClaudeCodeBackground which has no timeout at all.
// Override via SECONDBRAIN_CLAUDE_TIMEOUT_MS for ad-hoc long-running scripts.
const DEFAULT_TIMEOUT_MS = parseInt(process.env.SECONDBRAIN_CLAUDE_TIMEOUT_MS || '', 10) || 900_000; // 15 minutes

export interface RunOptions {
  cwd?: string;
  /** Soft timeout in ms for the blocking wrapper. Pass 0 to disable. */
  timeoutMs?: number;
  /** Extra environment variables merged into the child process env. Used by
   *  runClaudeCodeIngest to set SECONDBRAIN_SESSION_MODE=ingest, which routes
   *  SessionStart to the ~400-token stub hook instead of the full Tier 1 load. */
  extraEnv?: Record<string, string>;
}

export interface RunResult {
  output: string;
  success: boolean;
  exitCode: number;
  /** Raw subprocess stderr, kept for diagnostics only. NEVER merged into
   *  `output`. That path leaked Claude Code plumbing into Telegram replies. */
  stderr?: string;
}

/**
 * Resolve the secondbrain repo root. The command-queue worker runs Telegram
 * replies as `claude -p` sessions; they MUST start in the repo so the project
 * CLAUDE.md, memory, and hashtag-command hooks (#learn etc.) all load. Running
 * from the Electron install dir (app.getAppPath()) produced a stripped-down
 * "not the same Amy" that ignored the #learn workflow and response structure.
 */
export function getSecondBrainRoot(): string {
  if (process.env.SECONDBRAIN_ROOT) return process.env.SECONDBRAIN_ROOT;
  const username = process.env.USERNAME || process.env.USER || process.env.LOGNAME || 'user';
  return `C:/Users/${username}/secondbrain`;
}

/**
 * Assemble a RunResult from a finished subprocess. stdout is the ONLY
 * user-facing channel. stderr is kept separate for diagnostics and never
 * concatenated into `output`. A prior version stapled `\n\nSTDERR:\n<stderr>`
 * onto every reply, which leaked benign Claude Code plumbing ("SessionEnd
 * hook failed: Hook cancelled") into ExampleCo's Telegram messages.
 */
export function assembleRunResult(stdout: string, stderr: string, exitCode: number): RunResult {
  const cleanStderr = stderr.trim();
  return {
    output: stdout.trim(),
    success: exitCode === 0,
    exitCode,
    ...(cleanStderr ? { stderr: cleanStderr } : {}),
  };
}

export interface BackgroundRunHandle {
  /** Process id of the spawned claude subprocess. May be undefined if spawn failed. */
  pid: number | undefined;
  /** Resolves when the subprocess closes. Never rejects; failures land in result.success=false. */
  completion: Promise<RunResult>;
}

/**
 * Core spawn primitive. Returns immediately with a handle whose completion
 * promise resolves on subprocess close. spawnClaude (blocking, with
 * timeout) wraps it for backwards compat. spawnClaudeBackground exposes
 * the handle so callers can fire-and-forget.
 *
 * Per ExampleCo 2026-05-05: the queue worker should not block on the await. The
 * await + timeout pattern killed legitimate long-running deep tasks.
 */
function spawnClaudeCore(args: string[], options: RunOptions): BackgroundRunHandle {
  const cwd = options.cwd ?? app.getAppPath();

  // On Windows, shell:true causes cmd.exe to interpret | and newlines inside
  // the prompt argument as shell operators (e.g. "Page: X | Screenshot: Y"
  // splits at | and tries to run "Screenshot:" as a command).
  // Fix: spawn cmd.exe directly (shell:false) and pass the prompt via stdin
  // so the shell never parses the prompt text at all.
  const isWindows = process.platform === 'win32';
  const pIdx = args.indexOf('-p');
  const hasPromptArg = isWindows && pIdx !== -1 && pIdx + 1 < args.length;

  // Strip CLAUDECODE so nested claude launches don't refuse to start.
  // Claude Code sets this env var in every session it spawns; if we inherit
  // it, `claude -p` sees itself as nested and exits with an error.
  const childEnv = { ...process.env };
  delete childEnv['CLAUDECODE'];

  // Merge any caller-supplied env vars. Used by runClaudeCodeIngest to set
  // SECONDBRAIN_SESSION_MODE=ingest so the SessionStart hook routes to the
  // stub variant.
  if (options.extraEnv) {
    for (const [k, v] of Object.entries(options.extraEnv)) {
      childEnv[k] = v;
    }
  }

  // Ensure SECONDBRAIN_ROOT is always set for child sessions so the
  // SessionStart hook can find canonical memory files. When Electron is
  // launched from Start Menu or a desktop shortcut, user-level env vars may
  // not be inherited by the process tree.
  if (!childEnv['SECONDBRAIN_ROOT']) {
    const username = process.env.USERNAME || process.env.USER || process.env.LOGNAME || 'user';
    childEnv['SECONDBRAIN_ROOT'] = `C:/Users/${username}/secondbrain`;
  }

  // Ensure Claude Code can find git-bash on Windows (custom Git install path)
  if (isWindows && !childEnv['CLAUDE_CODE_GIT_BASH_PATH']) {
    const username = process.env.USERNAME || process.env.USER || process.env.LOGNAME || 'user';
    const candidates = [
      `C:\\Users\\${username}\\Desktop\\ExampleCo\\Dev\\Git\\usr\\bin\\bash.exe`,
      `C:\\Program Files\\Git\\usr\\bin\\bash.exe`,
      `C:\\Users\\${username}\\scoop\\apps\\git\\current\\usr\\bin\\bash.exe`,
    ];
    for (const p of candidates) {
      try {
        require('fs').accessSync(p);
        childEnv['CLAUDE_CODE_GIT_BASH_PATH'] = p;
        break;
      } catch {
        /* try next */
      }
    }
  }

  // On Windows, resolve the absolute path to claude.cmd so cmd.exe can find it
  // even when Electron is launched from Git Bash (which puts Unix-style paths in
  // process.env.PATH that cmd.exe can't interpret).
  function findClaudeCmd(): string {
    if (!isWindows) return 'claude';
    const candidates = [
      // npm global bin (most common install location)
      process.env.APPDATA ? `${process.env.APPDATA}\\npm\\claude.cmd` : null,
      // npm prefix via env var (set by some installers)
      process.env.npm_config_prefix ? `${process.env.npm_config_prefix}\\claude.cmd` : null,
      // Scoop
      process.env.USERPROFILE ? `${process.env.USERPROFILE}\\scoop\\shims\\claude.cmd` : null,
    ].filter(Boolean) as string[];
    for (const c of candidates) {
      try {
        require('fs').accessSync(c);
        return c;
      } catch {
        /* try next */
      }
    }
    return 'claude.cmd'; // fallback, rely on PATH
  }
  const claudeAbsPath = findClaudeCmd();

  let child: ReturnType<typeof spawn>;

  if (hasPromptArg) {
    const promptContent = args[pIdx + 1];
    // Strip "-p <prompt>" and use "--print" so claude reads from stdin
    const claudeArgs = [...args.slice(0, pIdx), '--print', ...args.slice(pIdx + 2)];
    // Use full path to cmd.exe; Electron's PATH may not include System32 when launched from Git Bash
    const cmdExe = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
    // Quote the absolute path in case it contains spaces
    const quotedPath = claudeAbsPath.includes(' ') ? `"${claudeAbsPath}"` : claudeAbsPath;
    child = spawn(cmdExe, ['/d', '/s', '/c', `${quotedPath} ${claudeArgs.join(' ')}`], {
      cwd,
      env: childEnv,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdin!.write(promptContent, 'utf-8');
    child.stdin!.end();
  } else {
    child = spawn(claudeAbsPath, args, {
      cwd,
      env: childEnv,
      shell: isWindows,
      windowsHide: true,
    });
  }

  let stdout = '';
  let stderr = '';

  (child.stdout as NodeJS.ReadableStream).on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });

  (child.stderr as NodeJS.ReadableStream).on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const completion = new Promise<RunResult>((resolve) => {
    child.on('close', (code) => {
      const exitCode = code ?? -1;
      const result = assembleRunResult(stdout, stderr, exitCode);
      if (result.stderr) {
        console.error('[claude-runner] subprocess stderr (not sent to user):', result.stderr.slice(0, 500));
      }
      resolve(result);
    });

    child.on('error', (err) => {
      // Translate raw Node errors into a ExampleCo-safe message. The previous
      // format ("Process error: spawn claude ENOENT") was forwarded to Amy
      // and TTS'd onto ExampleCo's voicemail after a run_claude_code dispatch
      // in call 019db811 (2026-04-22). Never ship raw errors to the owner.
      const raw = err.message || String(err);
      const isENOENT = /ENOENT/i.test(raw);
      const cleanMsg = isENOENT
        ? `Claude CLI not found at ${claudeAbsPath}. Dispatch could not run. Restart the Electron app on ExampleCo's PC to re-resolve claude.cmd, or reinstall the CLI with "npm i -g @anthropic-ai/claude-code".`
        : `Claude CLI could not start: ${raw.slice(0, 120)}`;
      resolve({ output: cleanMsg, success: false, exitCode: -1 });
    });
  });

  return { pid: child.pid, completion };
}

/**
 * Backwards-compatible wrapper around spawnClaudeCore that adds a timeout
 * watchdog and awaits completion. Used by callers that have a known time
 * budget (briefing summarization, ingest passes). Pass timeoutMs: 0 to
 * disable the timer.
 */
function spawnClaude(args: string[], options: RunOptions): Promise<RunResult> {
  const handle = spawnClaudeCore(args, options);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!timeoutMs || timeoutMs < 0) return handle.completion;
  return new Promise<RunResult>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { if (handle.pid) process.kill(handle.pid, 'SIGTERM'); } catch { /* nothing to kill */ }
      const minutes = timeoutMs / 60_000;
      resolve({
        output: `Timed out after ${minutes} minute${minutes !== 1 ? 's' : ''}`,
        success: false,
        exitCode: -1,
      });
    }, timeoutMs);
    handle.completion.then((r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    });
  });
}

const CLAUDE_MODEL = 'claude-sonnet-4-6';

/** Spawn a fresh claude -p session, blocking until done (with timeout). */
export function runClaudeCode(prompt: string, options?: RunOptions): Promise<RunResult> {
  return spawnClaude(['--model', CLAUDE_MODEL, '-p', prompt], options ?? {});
}

/** Continue the most recent Claude Code session (claude --continue -p "prompt"), blocking. */
export function runClaudeCodeContinue(prompt: string, options?: RunOptions): Promise<RunResult> {
  return spawnClaude(['--continue', '--model', CLAUDE_MODEL, '-p', prompt], options ?? {});
}

/**
 * Detached background spawn for the queue worker. Returns immediately with
 * a handle. completion resolves when the subprocess closes. No timeout.
 * The worker can attach .then(...) to deliver the result later without
 * blocking the poll loop.
 *
 * Per ExampleCo 2026-05-05: "you should not even be waiting for the message,
 * you should just get it." This is that primitive.
 */
export function runClaudeCodeBackground(
  prompt: string,
  options?: RunOptions & { continueSession?: boolean },
): BackgroundRunHandle {
  const args = options?.continueSession
    ? ['--continue', '--model', CLAUDE_MODEL, '-p', prompt]
    : ['--model', CLAUDE_MODEL, '-p', prompt];
  return spawnClaudeCore(args, options ?? {});
}

/** Spawn a claude -p session in INGEST mode.
 *
 *  Sets SECONDBRAIN_SESSION_MODE=ingest in the child environment, which causes
 *  session-start-inject.sh to route SessionStart to the stub variant
 *  (session-start-inject-ingest.sh) and emit a ~400-token lightweight context
 *  instead of the ~10K Tier 1 load. Use for batched ingest drains,
 *  enrichment passes, and any automated work that does not need full identity
 *  context.
 *
 *  Do NOT use for interactive commands, briefing generation, or anything the
 *  user will see the output of verbatim. The stub instructs the session to
 *  drain-and-exit and does not load voice/tone rules.
 */
export function runClaudeCodeIngest(prompt: string, options?: RunOptions): Promise<RunResult> {
  const merged: RunOptions = {
    ...options,
    extraEnv: {
      ...(options?.extraEnv ?? {}),
      SECONDBRAIN_SESSION_MODE: 'ingest',
    },
  };
  return spawnClaude(['--model', CLAUDE_MODEL, '-p', prompt], merged);
}

/**
 * Best-effort summarization of a long task's stdout into a 1-3 sentence
 * Telegram-friendly result. Used by both the blocking and background
 * paths. On API failure, falls back to truncated raw output.
 */
export async function summarizeTaskOutput(fullOutput: string, success: boolean, exitCode: number): Promise<string> {
  let summary = success
    ? fullOutput.slice(0, 500)
    : `Task failed (exit ${exitCode}): ${fullOutput.slice(0, 300)}`;
  try {
    const anthropic = new Anthropic();
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 256,
      messages: [
        {
          role: 'user',
          content:
            `Summarize the following Claude Code task output in 1-3 sentences suitable for a ` +
            `Telegram message or phone callback. Be concise and focus on the key result.\n\n` +
            `Output:\n${fullOutput.slice(0, 4000)}`,
        },
      ],
    });
    const block = msg.content[0];
    if (block.type === 'text') {
      summary = block.text.trim();
    }
  } catch (err) {
    console.error('[claude-runner] summarize error:', err);
  }
  return summary;
}

export async function runClaudeCodeAndSummarize(
  prompt: string,
  options?: RunOptions & { continueSession?: boolean },
): Promise<{
  fullOutput: string;
  summary: string;
  success: boolean;
  exitCode: number;
}> {
  const runFn = options?.continueSession ? runClaudeCodeContinue : runClaudeCode;
  const { output: fullOutput, success, exitCode } = await runFn(prompt, options);
  const summary = await summarizeTaskOutput(fullOutput, success, exitCode);
  return { fullOutput, summary, success, exitCode };
}
