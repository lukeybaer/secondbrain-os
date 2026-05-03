// claude-runner.ts
// Spawns `claude -p "prompt"` as a subprocess in the project working directory
// and returns the output. Used by the command queue worker.
//
// Supports four execution modes:
//   runClaudeCode()          → new session (claude -p), full Tier 1 context load
//   runClaudeCodeContinue()  → continue most recent session (claude --continue -p)
//   runClaudeCodeIngest()    → new session marked as ingest mode, routes SessionStart
//                              to the ~400-token stub hook instead of ~10K Tier 1 load
//   runClaudeCodeAndSummarize() → runs either mode + summarizes result for Telegram

import { spawn } from 'child_process';
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
}

export interface RunResult {
  output: string;
  success: boolean;
  exitCode: number;
}

function spawnClaude(args: string[], options: RunOptions): Promise<RunResult> {
  const cwd = options.cwd ?? app.getAppPath();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

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
      `C:\\Users\\${username}\\Program Files\\Git\\usr\\bin\\bash.exe`,
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
    return 'claude.cmd'; // fallback , rely on PATH
  }
  const claudeAbsPath = findClaudeCmd();

  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;

    if (hasPromptArg) {
      const promptContent = args[pIdx + 1];
      // Strip "-p <prompt>" and use "--print" so claude reads from stdin
      const claudeArgs = [...args.slice(0, pIdx), '--print', ...args.slice(pIdx + 2)];
      // Use full path to cmd.exe , Electron's PATH may not include System32 when launched from Git Bash
      const cmdExe = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
      // Quote the absolute path in case it contains spaces
      const quotedPath = claudeAbsPath.includes(' ') ? `"${claudeAbsPath}"` : claudeAbsPath;
      child = spawn(cmdExe, ['/d', '/s', '/c', `${quotedPath} ${claudeArgs.join(' ')}`], {
        cwd,
        env: childEnv,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.stdin!.write(promptContent, 'utf-8');
      child.stdin!.end();
    } else {
      child = spawn(claudeAbsPath, args, {
        cwd,
        env: childEnv,
        shell: isWindows,
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

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      const minutes = timeoutMs / 60_000;
      resolve({
        output: `Timed out after ${minutes} minute${minutes !== 1 ? 's' : ''}`,
        success: false,
        exitCode: -1,
      });
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      const exitCode = code ?? -1;
      const output = (stdout + (stderr ? `\n\nSTDERR:\n${stderr}` : '')).trim();
      resolve({ output, success: exitCode === 0, exitCode });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ output: `Process error: ${err.message}`, success: false, exitCode: -1 });
    });
  });
}

const CLAUDE_MODEL = 'claude-sonnet-4-6';

/** Spawn a fresh claude -p session */
export function runClaudeCode(prompt: string, options?: RunOptions): Promise<RunResult> {
  return spawnClaude(['--model', CLAUDE_MODEL, '-p', prompt], options ?? {});
}

/** Continue the most recent Claude Code session (claude --continue -p "prompt") */
export function runClaudeCodeContinue(prompt: string, options?: RunOptions): Promise<RunResult> {
  return spawnClaude(['--continue', '--model', CLAUDE_MODEL, '-p', prompt], options ?? {});
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
 *  user will see the output of verbatim , the stub instructs the session to
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

  return { fullOutput, summary, success, exitCode };
}
