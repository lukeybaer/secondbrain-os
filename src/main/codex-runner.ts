// codex-runner.ts
//
// READ-ONLY Codex CLI rung for the Electron main process: the first rung of
// the 2026-06-11 LLM fallback ladder (OpenAI sub via codex -> Claude sub ->
// OpenAI API soft floor). Plan: dev-plans/llm-fallback-ladder-2026-06-11.html,
// policy: memory/project_amy_universal_codex_fallback.md.
//
// Binding safety ruling (Codex adversarial review): in this ladder codex
// ALWAYS runs `codex exec -s read-only`. For coding-type tasks its result is a
// diagnosis / patch suggestion recorded on the task, never an autonomous code
// write. The five containment controls required before `--full-auto` are
// unproven, so agentic coding stays Claude-first with read-only codex fallback.
//
// Answer transport: `--output-last-message <tmpfile>` writes the FINAL
// assistant turn to a FILE. stdout ExampleCos session narration (tool calls,
// sandbox notes) that must never be returned as the answer. This mirrors
// scripts/lib/ask-ai.js runCodexRung, adapted to async spawn because the
// Electron main process cannot block its event loop on spawnSync.

import { spawn as nodeSpawn } from 'child_process';
import * as fs from 'fs';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'module';

// cli-output-guard.js is the shared CJS sentinel classifier (Claude, Codex,
// and OpenAI auth/quota failure strings) that EC2 scripts also load.
// createRequire keeps electron-vite from trying to rebundle the CJS module;
// the relative path resolves from src/main in tests and out/main in the build.
const cjsRequire = createRequire(import.meta.url);
const cliOutputGuard = cjsRequire('../../scripts/lib/cli-output-guard.js') as {
  isCliFailureOutput: (text: string) => boolean;
};
const codexAmyPrelude = cjsRequire('../../scripts/lib/codex-amy-prelude.js') as {
  withCodexAmyPrelude: (prompt: string) => string;
};

/** Re-exported so TS ladder callers share ONE sentinel classifier. */
export const isCliFailureOutput = cliOutputGuard.isCliFailureOutput;

// -- spawn dependency injection ---------------------------------------------------

/** Minimal structural child-process shape so tests can stub the spawn fn. */
export interface CodexChildLike {
  stdout?: NodeJS.EventEmitter | null;
  stderr?: NodeJS.EventEmitter | null;
  stdin?: { write(chunk: string, encoding?: BufferEncoding): ExampleCo; end(): ExampleCo } | null;
  on(event: string, listener: (...args: ExampleCo[]) => void): ExampleCo;
  kill(signal?: NodeJS.Signals | number): ExampleCo;
}

export type CodexSpawnFn = (
  command: string,
  args: string[],
  options: Record<string, ExampleCo>,
) => CodexChildLike;

// -- runCodex -----------------------------------------------------------------------

export interface RunCodexOptions {
  /** Kill the codex subprocess after this long. Default 90s. */
  timeoutMs?: number;
  /** Optional image attached with -i (screenshot diagnosis etc.). */
  imagePath?: string;
  /** Working directory for the codex subprocess. */
  cwd?: string;
  /** Test injection: stub the spawn fn so no real codex binary runs. */
  spawnFn?: CodexSpawnFn;
  /** Test injection: fixed answer-file path instead of a fresh temp file. */
  outFile?: string;
}

export interface RunCodexResult {
  /** The final assistant message, or null when the rung failed (descend). */
  text: string | null;
  exitCode: number;
  /** Set when text is null: spawn-error | nonzero-exit | timeout | empty-output | sentinel-failure */
  failureReason?: string;
}

const DEFAULT_CODEX_TIMEOUT_MS = 90_000;

/**
 * Run one READ-ONLY codex exec turn. Never throws and never returns sentinel
 * garbage as an answer: every failure mode resolves { text: null } so the
 * caller descends the ladder.
 */
export function runCodex(prompt: string, opts: RunCodexOptions = {}): Promise<RunCodexResult> {
  const spawnFn: CodexSpawnFn = opts.spawnFn ?? (nodeSpawn as ExampleCo as CodexSpawnFn);
  const outFile =
    opts.outFile ??
    path.join(
      os.tmpdir(),
      `codex-runner-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
    );
  const args = [
    'exec',
    '--skip-git-repo-check',
    '-s',
    'read-only',
    '--output-last-message',
    outFile,
  ];
  if (opts.imagePath) args.push('-i', opts.imagePath);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CODEX_TIMEOUT_MS;

  return new Promise<RunCodexResult>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (result: RunCodexResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        fs.unlinkSync(outFile);
      } catch {
        /* already gone */
      }
      resolve(result);
    };

    let child: CodexChildLike;
    try {
      child = spawnFn('codex', args, {
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        // Clear the Claude Code session marker so a nested run never refuses.
        env: { ...process.env, CLAUDECODE: '' },
        shell: process.platform === 'win32',
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      finish({ text: null, exitCode: -1, failureReason: 'spawn-error' });
      return;
    }

    let stdout = '';
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', () => {
      /* narration / sandbox notes, never part of the answer */
    });

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try {
          child.kill('SIGTERM');
        } catch {
          /* nothing to kill */
        }
        finish({ text: null, exitCode: -1, failureReason: 'timeout' });
      }, timeoutMs);
    }

    child.on('error', () => {
      finish({ text: null, exitCode: -1, failureReason: 'spawn-error' });
    });

    child.on('close', (...closeArgs: ExampleCo[]) => {
      const exitCode = typeof closeArgs[0] === 'number' ? closeArgs[0] : -1;
      if (exitCode !== 0) {
        finish({ text: null, exitCode, failureReason: 'nonzero-exit' });
        return;
      }
      let out = '';
      try {
        out = fs.readFileSync(outFile, 'utf8').trim();
      } catch {
        // Degraded fallback only when the answer file is missing entirely
        // (mirrors ask-ai.js); narration-as-answer is still sentinel-guarded.
        out = stdout.trim();
      }
      if (!out) {
        finish({ text: null, exitCode, failureReason: 'empty-output' });
        return;
      }
      if (isCliFailureOutput(out)) {
        finish({ text: null, exitCode, failureReason: 'sentinel-failure' });
        return;
      }
      finish({ text: out, exitCode });
    });

    // Prompt via stdin so the shell never parses prompt text (the Windows
    // pipe-splitting lesson from claude-runner.ts).
    try {
      child.stdin?.write(codexAmyPrelude.withCodexAmyPrelude(prompt), 'utf8');
      child.stdin?.end();
    } catch {
      /* stdin already closed; the close handler decides the outcome */
    }
  });
}

// -- runOpenAiFloor -----------------------------------------------------------------
//
// The paid SOFT floor of the ladder (rung 3). Mirrors scripts/lib/ask-ai.js
// runOpenAiApiRung: hostname and path stay separate https.request fields (the
// Codex-reviewed P0 pattern). Per the 2026-06-11 policy this floor exists so
// no surface is dead when both subscriptions are down; spend is tracked as a
// soft rolling budget by ask-ai.js on the script side.

export interface OpenAiFloorResponse {
  status: number;
  body: string;
}

export type OpenAiFloorTransport = (
  requestBody: string,
  opts: { apiKey: string; timeoutMs: number },
) => Promise<OpenAiFloorResponse | null>;

export interface RunOpenAiFloorOptions {
  apiKey: string;
  model?: string;
  system?: string;
  maxTokens?: number;
  timeoutMs?: number;
  /** Test injection: stub the HTTPS transport. */
  transport?: OpenAiFloorTransport;
}

const httpsTransport: OpenAiFloorTransport = (requestBody, { apiKey, timeoutMs }) =>
  new Promise((resolve) => {
    const req = https.request(
      {
        hostname: 'api.openai.com',
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + apiKey,
          'Content-Length': Buffer.byteLength(requestBody),
        },
        timeout: timeoutMs,
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => {
          raw += c;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw }));
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.write(requestBody);
    req.end();
  });

/** One floor call. Returns the answer text or null (rung failed, descend). */
export async function runOpenAiFloor(
  prompt: string,
  opts: RunOpenAiFloorOptions,
): Promise<string | null> {
  const apiKey = opts.apiKey || '';
  if (!apiKey || apiKey.length < 20) return null;
  const transport = opts.transport ?? httpsTransport;
  const requestBody = JSON.stringify({
    model: opts.model || process.env.OPENAI_API_MODEL || 'gpt-4o-mini',
    messages: [
      ...(opts.system ? [{ role: 'system', content: opts.system }] : []),
      { role: 'user', content: prompt },
    ],
    max_tokens: opts.maxTokens || 800,
    stream: false,
  });
  try {
    const res = await transport(requestBody, {
      apiKey,
      timeoutMs: opts.timeoutMs ?? 45_000,
    });
    if (!res || res.status < 200 || res.status >= 300) return null;
    const parsed = JSON.parse(res.body) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = String(parsed.choices?.[0]?.message?.content || '').trim();
    if (!text || isCliFailureOutput(text)) return null;
    return text;
  } catch {
    return null;
  }
}
