// command-queue.ts
// Polls EC2 every 5 seconds for pending commands (claude tasks, search queries).
// Executes them locally and reports results back to EC2.
//
// Routing types (set by EC2 dispatcher):
//   new_task   → fresh claude -p session
//   continue   → claude --continue -p (resumes most recent session)
//   query      → search local conversation DB, no claude needed
//   status     → answered on EC2 side, shouldn't reach here

import { app } from 'electron';
import * as path from 'path';
import { getConfig } from './config';
import { runClaudeCodeBackground, summarizeTaskOutput, getSecondBrainRoot } from './claude-runner';
import { runCodex, isCliFailureOutput } from './codex-runner';
import { runFallbackChain, makeFileWriter } from './tool-fallback-chain';
import { runTask } from './task-service';
import { searchConversations } from './database';
import { claimSucceeded } from './command-queue-claim';

const POLL_INTERVAL_MS = 5_000;
const FALLBACK_EC2_URL = ''; // Set ec2BaseUrl in Settings

// Provider ladder (2026-06-11): bounded codex fallback so a dead claude run
// cannot stall result delivery for the full background-task horizon.
const CODEX_FALLBACK_TIMEOUT_MS =
  parseInt(process.env.SECONDBRAIN_CODEX_FALLBACK_TIMEOUT_MS || '', 10) || 180_000;

/** Shared Electron-side rung ledger, same shape as ask-ai-rungs.jsonl. */
function ladderWriter(): ReturnType<typeof makeFileWriter> {
  return makeFileWriter(
    path.join(getSecondBrainRoot(), 'data', 'agent', 'electron-ladder-attempts.jsonl'),
  );
}

function looksLikeCodingCommand(prompt: string): boolean {
  return /\b(fix|bug|implement|build|code|refactor|test|deploy|css|ui|dashboard|briefing card|component|script|endpoint|api|schema|database|migration|regression)\b/i.test(
    prompt,
  );
}

export interface CommandStatusEvent {
  commandId: string;
  status: 'processing' | 'complete' | 'error';
  success?: boolean;
  summary?: string;
}

let statusEventHandler: ((event: CommandStatusEvent) => void) | null = null;

export function setCommandStatusHandler(fn: (event: CommandStatusEvent) => void): void {
  statusEventHandler = fn;
}

function emitCommandEvent(event: CommandStatusEvent): void {
  try {
    statusEventHandler?.(event);
  } catch {
    /* non-critical */
  }
}

interface CommandRouting {
  type: 'new_task' | 'continue' | 'query' | 'status';
  sessionId?: string;
  sessionTopic?: string;
}

interface PendingCommand {
  id: string;
  type: 'claude' | 'search';
  prompt?: string;
  query?: string;
  routing?: CommandRouting;
}

let workerRunning = false;
let stopRequested = false;
let pollTimer: ReturnType<typeof setTimeout> | null = null;

// Active session ID tracked locally — set when we start a claude task, used for continue routing
let activeSessionId: string | null = null;

// Active background claude tasks keyed by command id. Populated when
// handleCommand spawns one, cleared when the subprocess closes. Future
// status-check tools can read this to answer "is task X still running."
import type { BackgroundRunHandle } from './claude-runner';
const activeClaudeTasks = new Map<string, BackgroundRunHandle>();
export function getActiveClaudeTaskCount(): number {
  return activeClaudeTasks.size;
}
export function getActiveClaudeTaskIds(): string[] {
  return Array.from(activeClaudeTasks.keys());
}

function getBaseUrl(): string {
  try {
    return getConfig().ec2BaseUrl || FALLBACK_EC2_URL;
  } catch {
    return FALLBACK_EC2_URL;
  }
}

// The /commands surface on EC2 is bearer-gated (2026-06-02). The desktop worker
// hits EC2 over the public IP (not localhost), so it must send the token or it
// gets 401. Read it from config, fall back to env for headless runs.
function commandHeaders(extra: Record<string, string> = {}): Record<string, string> {
  let token = '';
  try {
    token = getConfig().commandToken || '';
  } catch {
    /* ignore */
  }
  if (!token) token = process.env.SB_COMMAND_TOKEN || '';
  return token ? { ...extra, Authorization: `Bearer ${token}` } : { ...extra };
}

// ── Session registry helpers ──────────────────────────────────────────────────

async function registerSession(topic: string): Promise<string | null> {
  try {
    const base = getBaseUrl();
    const res = await fetch(`${base}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { id: string };
    return data.id;
  } catch {
    return null;
  }
}

async function completeSession(sessionId: string): Promise<void> {
  try {
    const base = getBaseUrl();
    await fetch(`${base}/sessions/${sessionId}`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // non-critical
  }
}

// ── EC2 command queue helpers ─────────────────────────────────────────────────

async function fetchPendingCommand(): Promise<PendingCommand | null> {
  const base = getBaseUrl();
  const res = await fetch(`${base}/commands/pending`, {
    headers: commandHeaders(),
    signal: AbortSignal.timeout(8_000),
  });
  if (res.status === 204 || res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!data || !data.id) return null;
  return data as PendingCommand;
}

async function claimCommand(id: string): Promise<boolean> {
  const base = getBaseUrl();
  try {
    const res = await fetch(`${base}/commands/${id}/claim`, {
      method: 'POST',
      headers: commandHeaders(),
      signal: AbortSignal.timeout(8_000),
    });
    return claimSucceeded(res.status);
  } catch {
    return false;
  }
}

async function completeCommand(id: string, result: string, success: boolean): Promise<void> {
  const base = getBaseUrl();
  await fetch(`${base}/commands/${id}/complete`, {
    method: 'POST',
    headers: commandHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ result, success }),
    signal: AbortSignal.timeout(8_000),
  });
}

// ── Command handler ───────────────────────────────────────────────────────────

// Exported for unit tests (the poll loop is the only runtime caller).
export async function handleCommand(cmd: PendingCommand): Promise<void> {
  let result = '';
  let success = false;

  const routingType = cmd.routing?.type ?? 'new_task';

  try {
    if (cmd.type === 'search' || routingType === 'query') {
      // Fast path: search local conversation DB
      const query = cmd.query ?? cmd.prompt ?? '';
      const hits = searchConversations(query, 3);
      if (hits.length === 0) {
        result = `No conversations found for: "${query}"`;
      } else {
        result = hits
          .map(
            (h, i) =>
              `${i + 1}. ${h.title ?? '(untitled)'} — ${h.date ?? ''} (${h.durationMinutes ?? 0} min)`,
          )
          .join('\n');
      }
      success = true;
    } else if (cmd.type === 'claude') {
      // Fire-and-forget: spawn detached, return from handleCommand
      // immediately, let the worker resume polling. The .then handler
      // below delivers the result via completeCommand when the
      // subprocess actually exits, however long that takes. No timeout.
      // Per ExampleCo 2026-05-05: "you should not even be waiting for the
      // message, you should just get it."
      const prompt = cmd.prompt ?? '';
      const continueSession = routingType === 'continue';

      let registrationPromise: Promise<void> = Promise.resolve();
      if (!continueSession) {
        const topic = prompt.slice(0, 80) + (prompt.length > 80 ? '...' : '');
        registrationPromise = registerSession(topic)
          .then((sid) => {
            if (sid) activeSessionId = sid;
          })
          .catch(() => {
            /* non-critical */
          });
      }

      // Shared completion path: report the result back to EC2, emit the
      // status event, clean up the session. Non-blocking for both routes.
      const finishCmd = async (summary: string, ok: boolean): Promise<void> => {
        try {
          await completeCommand(cmd.id, summary, ok);
          emitCommandEvent({
            commandId: cmd.id,
            status: ok ? 'complete' : 'error',
            success: ok,
            summary: summary.slice(0, 300),
          });
        } catch (err) {
          console.error('[command-queue] background completion err:', err);
        } finally {
          activeClaudeTasks.delete(cmd.id);
          await registrationPromise;
          if (!continueSession && activeSessionId) {
            completeSession(activeSessionId).catch(() => {
              /* non-critical */
            });
            activeSessionId = null;
          }
        }
      };

      if (continueSession) {
        // continue: resume the prior session in the background. No standalone
        // Task identity, it is a follow-up on prior work.
        const handle = runClaudeCodeBackground(prompt, {
          cwd: app.getAppPath(),
          continueSession: true,
        });
        activeClaudeTasks.set(cmd.id, handle);
        console.log(`[command-queue] claude continue ${cmd.id} spawned pid=${handle.pid}`);
        handle.completion.then(async (r) => {
          // Provider ladder (2026-06-11): a continue run that exits nonzero
          // OR prints an exit-0 auth/quota sentinel descends the ladder. There
          // is no codex equivalent of `claude --continue`, so the fallback is
          // a FRESH codex READ-ONLY session carrying the stored task context,
          // and the delivered result is provenance-tagged.
          if (r.success && !isCliFailureOutput(r.output)) {
            const summary = await summarizeTaskOutput(r.output, r.success, r.exitCode);
            await finishCmd(summary, true);
            return;
          }
          const codexPrompt = [
            'You are answering a follow-up command on an ongoing task. The prior',
            'Claude session is unavailable, so this is a fresh session; the stored',
            'task context is below.',
            ...(cmd.routing?.sessionTopic
              ? ['', `Stored task context (topic): ${cmd.routing.sessionTopic}`]
              : []),
            '',
            'Follow-up command:',
            prompt,
          ].join('\n');
          const chain = await runFallbackChain<string>(
            [
              {
                name: 'codex-readonly-fresh',
                fn: async () => {
                  const c = await runCodex(codexPrompt, { timeoutMs: CODEX_FALLBACK_TIMEOUT_MS });
                  if (!c.text)
                    throw new Error(`codex rung failed: ${c.failureReason ?? 'no output'}`);
                  return c.text;
                },
                // A rung failure always means "descend", never "abort".
                isTransientError: () => true,
              },
            ],
            { chain: 'command-continue', writer: ladderWriter() },
          );
          if (chain.ok) {
            await finishCmd(
              `via codex (read-only, fresh session): ${chain.value.slice(0, 1000)}`,
              true,
            );
            return;
          }
          // Ladder exhausted: deliver the claude failure honestly.
          const summary = await summarizeTaskOutput(r.output, false, r.exitCode);
          await finishCmd(summary, false);
        });
      } else {
        // new_task: route through the Task Spine so every remote dispatch is
        // a durable, queryable Task. runTask is non-blocking; its TaskResult
        // already ExampleCos a summary. The claude -> codex read-only provider
        // ladder for new tasks lives in task-service executeTask, so every
        // spine task gets it, not just command-queue dispatches.
        const { task, completion } = runTask({
          kind: looksLikeCodingCommand(prompt) ? 'coding' : 'action',
          origin: 'command-queue',
          prompt,
        });
        console.log(`[command-queue] claude task ${cmd.id} -> spine task ${task.id}`);
        completion.then((r) => finishCmd(r.summary, r.success));
      }

      // Return early: completion is handled asynchronously above.
      return;
    } else {
      result = `PRIVATE_NAME command routing: ${routingType}`;
      success = false;
    }
  } catch (err) {
    result = `Error executing command: ${err instanceof Error ? err.message : String(err)}`;
    success = false;
    console.error('[command-queue] handleCommand error:', err);
  }

  await completeCommand(cmd.id, result, success);
  emitCommandEvent({
    commandId: cmd.id,
    status: success ? 'complete' : 'error',
    success,
    summary: result.slice(0, 300),
  });
}

// ── Poll loop ─────────────────────────────────────────────────────────────────

async function pollOnce(): Promise<void> {
  if (!workerRunning) return;

  try {
    const cmd = await fetchPendingCommand();
    if (cmd) {
      const won = await claimCommand(cmd.id);
      if (won) {
        console.log(
          `[command-queue] executing ${cmd.id} routing=${cmd.routing?.type ?? 'new_task'}`,
        );
        emitCommandEvent({ commandId: cmd.id, status: 'processing' });
        await handleCommand(cmd);
      } else {
        // Lost the claim (409): forwarded to the EC2 dispatch pipeline or taken
        // by another consumer. Do not execute, or it would run twice.
        console.log(`[command-queue] skip ${cmd.id}: claim not won (already taken/forwarded)`);
      }
    }
  } catch (err) {
    console.error('[command-queue] poll error:', err);
  }

  if (!stopRequested) {
    pollTimer = setTimeout(pollOnce, POLL_INTERVAL_MS);
  } else {
    workerRunning = false;
    stopRequested = false;
  }
}

export function startCommandQueueWorker(): void {
  if (workerRunning) return;
  workerRunning = true;
  stopRequested = false;
  console.log('[command-queue] worker started (routing-aware v1.4)');
  pollTimer = setTimeout(pollOnce, POLL_INTERVAL_MS);
}

export function stopCommandQueueWorker(): void {
  if (!workerRunning) return;
  stopRequested = true;
  if (pollTimer !== null) {
    clearTimeout(pollTimer);
    pollTimer = null;
    workerRunning = false;
    stopRequested = false;
  }
  console.log('[command-queue] worker stopped');
}
