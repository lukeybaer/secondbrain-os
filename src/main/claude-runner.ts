// claude-runner.ts
// Spawns `claude -p "prompt"` as a subprocess in the project working directory
// and returns the output. Used by the command queue worker and the Task Spine.
//
// Execution modes:
//   runClaudeCode()           new session (claude -p), blocking with a timeout
//   runClaudeCodeContinue()   continue most recent session (claude --continue -p)
//   runClaudeCodeIngest()     new session marked ingest mode (stub SessionStart)
//   runClaudeCodeBackground() detached spawn, returns a handle immediately, no
//                             timeout. Used by the Task Spine act worker.
//   runClaudeCodeAndSummarize() runs a mode + summarizes the result for Telegram

import { spawn, type ChildProcess } from 'child_process';
import { app } from 'electron';
import Anthropic from '@anthropic-ai/sdk';

const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  /** Extra environment variables merged into the child process env. Used by
   *  runClaudeCodeIngest to set SECONDBRAIN_SESSION_MODE=ingest, which routes
   *  SessionStart to the ~400-token stub hook instead of the full Tier 1 load. */
  extraEnv?: Record<string, string>;
  /** Space-separated tool names to block via `--disallowedTools`. Used to
   *  contain autonomously-dispatched act-worker runs (e.g. blocking Bash). */
  disallowedTools?: string;
}

export interface RunResult {
  output: string;
  success: boolean;
  exitCode: number;
}

/** Handle for a detached background run. completion never rejects. */
export interface BackgroundRunHandle {
  pid: number | undefined;
  completion: Promise<RunResult>;
}

const CLAUDE_MODEL = 'claude-sonnet-4-6';

/**
 * Build and spawn the claude child process with the SecondBrain environment
 * and Windows path handling. Returns the live ChildProcess. No timeout, no
 * output wiring, callers attach those.
 */
function buildClaudeChild(argsIn: string[], options: RunOptions): ChildProcess {
  const cwd = options.cwd ?? app.getAppPath();

  // Block tools (e.g. Bash) for contained autonomous runs.
  const args = options.disallowedTools
    ? ['--disallowedTools', options.disallowedTools, ...argsIn]
    : argsIn;

  // On Windows, shell:true causes cmd.exe to interpret | and newlines inside
  // the prompt argument as shell operators. Fix: spawn cmd.exe directly
  // (shell:false) and pass the prompt via stdin so the shell never parses it.
  const isWindows = process.platform === 'win32';
  const pIdx = args.indexOf('-p');
  const hasPromptArg = isWindows && pIdx !== -1 && pIdx + 1 < args.length;

  // Strip CLAUDECODE so nested claude launches don't refuse to start.
  const childEnv = { ...process.env };
  delete childEnv['CLAUDECODE'];

  if (options.extraEnv) {
    for (const [k, v] of Object.entries(options.extraEnv)) {
      childEnv[k] = v;
    }
  }

  // Ensure SECONDBRAIN_ROOT is set for child sessions so the SessionStart hook
  // can find canonical memory files.
  if (!childEnv['SECONDBRAIN_ROOT']) {
    const username = process.env.USERNAME || process.env.USER || process.env.LOGNAME || 'user';
    childEnv['SECONDBRAIN_ROOT'] = `C:/Users/${username}/secondbrain`;
  }

  // Ensure Claude Code can find git-bash on Windows (custom Git install path).
  if (isWindows && !childEnv['CLAUDE_CODE_GIT_BASH_PATH']) {
    const username = process.env.USERNAME || process.env.USER || process.env.LOGNAME || 'user';
    const candidates = [
      `C:\\Users\\${username}\\Desktop\\Luke\\Dev\\Git\\usr\\bin\\bash.exe`,
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

  // Resolve the absolute path to claude.cmd so cmd.exe can find it even when
  // Electron is launched from Git Bash.
  function findClaudeCmd(): string {
    if (!isWindows) return 'claude';
    const candidates = [
      process.env.APPDATA ? `${process.env.APPDATA}\\npm\\claude.cmd` : null,
      process.env.npm_config_prefix ? `${process.env.npm_config_prefix}\\claude.cmd` : null,
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

  if (hasPromptArg) {
    const promptContent = args[pIdx + 1];
    const claudeArgs = [...args.slice(0, pIdx), '--print', ...args.slice(pIdx + 2)];
    const cmdExe = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
    const quotedPath = claudeAbsPath.includes(' ') ? `"${claudeAbsPath}"` : claudeAbsPath;
    const child = spawn(cmdExe, ['/d', '/s', '/c', `${quotedPath} ${claudeArgs.join(' ')}`], {
      cwd,
      env: childEnv,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdin!.write(promptContent, 'utf-8');
    child.stdin!.end();
    return child;
  }
  return spawn(claudeAbsPath, args, { cwd, env: childEnv, shell: isWindows, windowsHide: true });
}

/** Wire stdout/stderr/close/error on a child into a RunResult promise. Never rejects. */
function attachCompletion(child: ChildProcess, claudeAbsPathHint = 'claude'): Promise<RunResult> {
  let stdout = '';
  let stderr = '';
  (child.stdout as NodeJS.ReadableStream).on('data', (c: Buffer) => {
    stdout += c.toString();
  });
  (child.stderr as NodeJS.ReadableStream).on('data', (c: Buffer) => {
    stderr += c.toString();
  });
  return new Promise<RunResult>((resolve) => {
    child.on('close', (code) => {
      const exitCode = code ?? -1;
      const output = (stdout + (stderr ? `\n\nSTDERR:\n${stderr}` : '')).trim();
      resolve({ output, success: exitCode === 0, exitCode });
    });
    child.on('error', (err) => {
      // Translate raw Node errors into a Luke-safe message; never ship raw
      // "spawn claude ENOENT" to the owner.
      const raw = err.message || String(err);
      const cleanMsg = /ENOENT/i.test(raw)
        ? `Claude CLI not found (${claudeAbsPathHint}). Restart the Electron app or reinstall the CLI.`
        : `Claude CLI could not start: ${raw.slice(0, 120)}`;
      resolve({ output: cleanMsg, success: false, exitCode: -1 });
    });
  });
}

/** Core spawn primitive: returns a handle immediately, no timeout. */
function spawnClaudeCore(args: string[], options: RunOptions): BackgroundRunHandle {
  const child = buildClaudeChild(args, options);
  return { pid: child.pid, completion: attachCompletion(child) };
}

/** Blocking wrapper: spawnClaudeCore plus a timeout watchdog. */
function spawnClaude(args: string[], options: RunOptions): Promise<RunResult> {
  const handle = spawnClaudeCore(args, options);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!timeoutMs || timeoutMs < 0) return handle.completion;
  return new Promise<RunResult>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        if (handle.pid) process.kill(handle.pid, 'SIGTERM');
      } catch {
        /* nothing to kill */
      }
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

/** Spawn a fresh claude -p session, blocking until done (with timeout). */
export function runClaudeCode(prompt: string, options?: RunOptions): Promise<RunResult> {
  return spawnClaude(['--model', CLAUDE_MODEL, '-p', prompt], options ?? {});
}

/** Continue the most recent Claude Code session, blocking. */
export function runClaudeCodeContinue(prompt: string, options?: RunOptions): Promise<RunResult> {
  return spawnClaude(['--continue', '--model', CLAUDE_MODEL, '-p', prompt], options ?? {});
}

/**
 * Detached background spawn. Returns a handle immediately; completion resolves
 * when the subprocess closes. No timeout. Used by the Task Spine act worker.
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

/** Spawn a claude -p session in INGEST mode (stub SessionStart hook). */
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
 * Summarize a task's stdout into a 1-3 sentence Telegram-friendly result.
 * On API failure, falls back to truncated raw output. Never throws.
 */
export async function summarizeTaskOutput(
  fullOutput: string,
  success: boolean,
  exitCode: number,
): Promise<string> {
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
            'Summarize the following Claude Code task output in 1-3 sentences suitable for a ' +
            'Telegram message or phone callback. Be concise and focus on the key result.\n\n' +
            `Output:\n${fullOutput.slice(0, 4000)}`,
        },
      ],
    });
    const block = msg.content[0];
    if (block.type === 'text') summary = block.text.trim();
  } catch (err) {
    console.error('[claude-runner] summarize error:', err);
  }
  return summary;
}

export async function runClaudeCodeAndSummarize(
  prompt: string,
  options?: RunOptions & { continueSession?: boolean },
): Promise<{ fullOutput: string; summary: string; success: boolean; exitCode: number }> {
  const runFn = options?.continueSession ? runClaudeCodeContinue : runClaudeCode;
  const { output: fullOutput, success, exitCode } = await runFn(prompt, options);
  const summary = await summarizeTaskOutput(fullOutput, success, exitCode);
  return { fullOutput, summary, success, exitCode };
}
