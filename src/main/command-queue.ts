// command-queue.ts
// Polls EC2 every 5 seconds for pending commands (claude tasks, search queries).
// Executes them locally and reports results back to EC2.
//
// Routing types (set by EC2 dispatcher):
//   new_task   → fresh claude -p session
//   continue   → claude --continue -p (resumes most recent session)
//   query      → search local conversation DB, no claude needed
//   status     → answered on EC2 side, shouldn't reach here

import { app } from "electron";
import { getConfig } from "./config";
import { runClaudeCodeBackground, summarizeTaskOutput } from "./claude-runner";
import { runTask } from "./task-service";
import { searchConversations } from "./database";

const POLL_INTERVAL_MS = 5_000;
const FALLBACK_EC2_URL = ""; // Set ec2BaseUrl in Settings

export interface CommandStatusEvent {
  commandId: string;
  status: "processing" | "complete" | "error";
  success?: boolean;
  summary?: string;
}

let statusEventHandler: ((event: CommandStatusEvent) => void) | null = null;

export function setCommandStatusHandler(fn: (event: CommandStatusEvent) => void): void {
  statusEventHandler = fn;
}

function emitCommandEvent(event: CommandStatusEvent): void {
  try { statusEventHandler?.(event); } catch { /* non-critical */ }
}

interface CommandRouting {
  type: "new_task" | "continue" | "query" | "status";
  sessionId?: string;
  sessionTopic?: string;
}

interface PendingCommand {
  id: string;
  type: "claude" | "search";
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
import type { BackgroundRunHandle } from "./claude-runner";
const activeClaudeTasks = new Map<string, BackgroundRunHandle>();
export function getActiveClaudeTaskCount(): number { return activeClaudeTasks.size; }
export function getActiveClaudeTaskIds(): string[] { return Array.from(activeClaudeTasks.keys()); }

function getBaseUrl(): string {
  try {
    return getConfig().ec2BaseUrl || FALLBACK_EC2_URL;
  } catch {
    return FALLBACK_EC2_URL;
  }
}

// ── Session registry helpers ──────────────────────────────────────────────────

async function registerSession(topic: string): Promise<string | null> {
  try {
    const base = getBaseUrl();
    const res = await fetch(`${base}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { id: string };
    return data.id;
  } catch {
    return null;
  }
}

async function completeSession(sessionId: string): Promise<void> {
  try {
    const base = getBaseUrl();
    await fetch(`${base}/sessions/${sessionId}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // non-critical
  }
}

// ── EC2 command queue helpers ─────────────────────────────────────────────────

async function fetchPendingCommand(): Promise<PendingCommand | null> {
  const base = getBaseUrl();
  const res = await fetch(`${base}/commands/pending`, { signal: AbortSignal.timeout(8_000) });
  if (res.status === 204 || res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!data || !data.id) return null;
  return data as PendingCommand;
}

async function claimCommand(id: string): Promise<void> {
  const base = getBaseUrl();
  await fetch(`${base}/commands/${id}/claim`, {
    method: "POST",
    signal: AbortSignal.timeout(8_000),
  });
}

async function completeCommand(id: string, result: string, success: boolean): Promise<void> {
  const base = getBaseUrl();
  await fetch(`${base}/commands/${id}/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ result, success }),
    signal: AbortSignal.timeout(8_000),
  });
}

// ── Command handler ───────────────────────────────────────────────────────────

async function handleCommand(cmd: PendingCommand): Promise<void> {
  let result = "";
  let success = false;

  const routingType = cmd.routing?.type ?? "new_task";

  try {
    if (cmd.type === "search" || routingType === "query") {
      // Fast path: search local conversation DB
      const query = cmd.query ?? cmd.prompt ?? "";
      const hits = searchConversations(query, 3);
      if (hits.length === 0) {
        result = `No conversations found for: "${query}"`;
      } else {
        result = hits
          .map(
            (h, i) =>
              `${i + 1}. ${h.title ?? "(untitled)"} — ${h.date ?? ""} (${h.durationMinutes ?? 0} min)`
          )
          .join("\n");
      }
      success = true;

    } else if (cmd.type === "claude") {
      // Fire-and-forget: spawn detached, return from handleCommand
      // immediately, let the worker resume polling. The .then handler
      // below delivers the result via completeCommand when the
      // subprocess actually exits, however long that takes. No timeout.
      // Per Luke 2026-05-05: "you should not even be waiting for the
      // message, you should just get it."
      const prompt = cmd.prompt ?? "";
      const continueSession = routingType === "continue";

      let registrationPromise: Promise<void> = Promise.resolve();
      if (!continueSession) {
        const topic = prompt.slice(0, 80) + (prompt.length > 80 ? "..." : "");
        registrationPromise = registerSession(topic).then((sid) => {
          if (sid) activeSessionId = sid;
        }).catch(() => { /* non-critical */ });
      }

      // Shared completion path: report the result back to EC2, emit the
      // status event, clean up the session. Non-blocking for both routes.
      const finishCmd = async (summary: string, ok: boolean): Promise<void> => {
        try {
          await completeCommand(cmd.id, summary, ok);
          emitCommandEvent({
            commandId: cmd.id,
            status: ok ? "complete" : "error",
            success: ok,
            summary: summary.slice(0, 300),
          });
        } catch (err) {
          console.error("[command-queue] background completion err:", err);
        } finally {
          activeClaudeTasks.delete(cmd.id);
          await registrationPromise;
          if (!continueSession && activeSessionId) {
            completeSession(activeSessionId).catch(() => { /* non-critical */ });
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
          const summary = await summarizeTaskOutput(r.output, r.success, r.exitCode);
          await finishCmd(summary, r.success);
        });
      } else {
        // new_task: route through the Task Spine so every remote dispatch is
        // a durable, queryable Task. runTask is non-blocking; its TaskResult
        // already carries a summary.
        const { task, completion } = runTask({
          kind: "action",
          origin: "command-queue",
          prompt,
          cwd: app.getAppPath(),
        });
        console.log(`[command-queue] claude task ${cmd.id} -> spine task ${task.id}`);
        completion.then((r) => finishCmd(r.summary, r.success));
      }

      // Return early: completion is handled asynchronously above.
      return;

    } else {
      result = `Unknown command routing: ${routingType}`;
      success = false;
    }
  } catch (err) {
    result = `Error executing command: ${err instanceof Error ? err.message : String(err)}`;
    success = false;
    console.error("[command-queue] handleCommand error:", err);
  }

  await completeCommand(cmd.id, result, success);
  emitCommandEvent({ commandId: cmd.id, status: success ? "complete" : "error", success, summary: result.slice(0, 300) });
}

// ── Poll loop ─────────────────────────────────────────────────────────────────

async function pollOnce(): Promise<void> {
  if (!workerRunning) return;

  try {
    const cmd = await fetchPendingCommand();
    if (cmd) {
      console.log(`[command-queue] executing ${cmd.id} routing=${cmd.routing?.type ?? "new_task"}`);
      await claimCommand(cmd.id);
      emitCommandEvent({ commandId: cmd.id, status: "processing" });
      await handleCommand(cmd);
    }
  } catch (err) {
    console.error("[command-queue] poll error:", err);
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
  console.log("[command-queue] worker started (routing-aware v1.4)");
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
  console.log("[command-queue] worker stopped");
}
