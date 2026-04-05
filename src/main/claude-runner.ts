// claude-runner.ts
// Spawns `claude -p "prompt"` as a subprocess in the project working directory
// and returns the output. Used by the command queue worker.
//
// Supports three execution modes:
//   runClaudeCode()          → new session (claude -p)
//   runClaudeCodeContinue()  → continue most recent session (claude --continue -p)
//   runClaudeCodeAndSummarize() → runs either mode + summarizes result for Telegram

import { spawn } from 'child_process';
import { app } from 'electron';
import Anthropic from '@anthropic-ai/sdk';

const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
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

  // Ensure Claude Code can find git-bash on Windows (custom Git install path)
  if (isWindows && !childEnv['CLAUDE_CODE_GIT_BASH_PATH']) {
    childEnv['CLAUDE_CODE_GIT_BASH_PATH'] =
      'C:\\Users\\luked\\Desktop\\Luke\\Dev\\Git\\usr\\bin\\bash.exe';
  }

  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;

    if (hasPromptArg) {
      const promptContent = args[pIdx + 1];
      // Strip "-p <prompt>" and use "--print" so claude reads from stdin
      const claudeArgs = [...args.slice(0, pIdx), '--print', ...args.slice(pIdx + 2)];
      // Use full path to cmd.exe — Electron's PATH may not include System32 when launched from Git Bash
      const cmdExe = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
      child = spawn(cmdExe, ['/d', '/s', '/c', `claude.cmd ${claudeArgs.join(' ')}`], {
        cwd,
        env: childEnv,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.stdin!.write(promptContent, 'utf-8');
      child.stdin!.end();
    } else {
      child = spawn(isWindows ? 'claude.cmd' : 'claude', args, {
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

const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';

/** Spawn a fresh claude -p session */
export function runClaudeCode(prompt: string, options?: RunOptions): Promise<RunResult> {
  return spawnClaude(['--model', CLAUDE_MODEL, '-p', prompt], options ?? {});
}

/** Continue the most recent Claude Code session (claude --continue -p "prompt") */
export function runClaudeCodeContinue(prompt: string, options?: RunOptions): Promise<RunResult> {
  return spawnClaude(['--continue', '--model', CLAUDE_MODEL, '-p', prompt], options ?? {});
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
