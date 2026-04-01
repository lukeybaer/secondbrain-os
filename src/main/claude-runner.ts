// claude-runner.ts
// Spawns `claude -p "prompt"` as a subprocess in the project working directory
// and returns the output. Used by the command queue worker.
//
// Supports three execution modes:
//   runClaudeCode()          → new session (claude -p)
//   runClaudeCodeContinue()  → continue most recent session (claude --continue -p)
//   runClaudeCodeAndSummarize() → runs either mode + summarizes result for Telegram

import { spawn } from "child_process";
import { app } from "electron";
import Anthropic from "@anthropic-ai/sdk";

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

  // On Windows, `claude` is an npm .cmd wrapper and requires shell execution.
  // Use shell:true on win32 so the OS can resolve claude.cmd via PATH.
  const isWindows = process.platform === "win32";

  return new Promise((resolve) => {
    const child = spawn(isWindows ? "claude.cmd" : "claude", args, {
      cwd,
      env: { ...process.env },
      shell: isWindows,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      const minutes = timeoutMs / 60_000;
      resolve({
        output: `Timed out after ${minutes} minute${minutes !== 1 ? "s" : ""}`,
        success: false,
        exitCode: -1,
      });
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      const exitCode = code ?? -1;
      const output = (stdout + (stderr ? `\n\nSTDERR:\n${stderr}` : "")).trim();
      resolve({ output, success: exitCode === 0, exitCode });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ output: `Process error: ${err.message}`, success: false, exitCode: -1 });
    });
  });
}

/** Spawn a fresh claude -p session */
export function runClaudeCode(prompt: string, options?: RunOptions): Promise<RunResult> {
  return spawnClaude(["-p", prompt], options ?? {});
}

/** Continue the most recent Claude Code session (claude --continue -p "prompt") */
export function runClaudeCodeContinue(prompt: string, options?: RunOptions): Promise<RunResult> {
  return spawnClaude(["--continue", "-p", prompt], options ?? {});
}

export async function runClaudeCodeAndSummarize(
  prompt: string,
  options?: RunOptions & { continueSession?: boolean }
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
      model: "claude-haiku-4-5-20251001",
      max_tokens: 256,
      messages: [
        {
          role: "user",
          content:
            `Summarize the following Claude Code task output in 1-3 sentences suitable for a ` +
            `Telegram message or phone callback. Be concise and focus on the key result.\n\n` +
            `Output:\n${fullOutput.slice(0, 4000)}`,
        },
      ],
    });
    const block = msg.content[0];
    if (block.type === "text") {
      summary = block.text.trim();
    }
  } catch (err) {
    console.error("[claude-runner] summarize error:", err);
  }

  return { fullOutput, summary, success, exitCode };
}
