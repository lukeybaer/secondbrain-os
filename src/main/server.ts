// server.ts — Always-on HTTP server exposing backend functionality over REST.
// Uses Node's built-in http module (no Express dependency).
// Listens on port 3002 (local Electron process; EC2 uses 3001).

import * as http from "http";
import { getConfig } from "./config";
import { initiateCall, listCallRecords } from "./calls";
import {
  PendingApproval,
  sendApprovalRequest,
  sendMessage,
} from "./telegram";
import {
  createApproval,
  resolveApproval,
  getApproval,
  getLatestPendingApproval,
  createReputationEvent,
  type DbApproval,
} from "./database-sqlite";

// ── Types ─────────────────────────────────────────────────────────────────────

const PORT = 3002;

// In-memory resolver callbacks — the approval records live in SQLite,
// only the Promise resolvers stay in memory (they can't be serialized).
const resolveCallbacks = new Map<string, (result: { approved: boolean; data?: string }) => void>();

// ── Approval helpers ──────────────────────────────────────────────────────────

/**
 * Creates an approval record in SQLite, sends Telegram notification, and
 * returns a Promise that resolves when Luke replies YES/NO (or times out).
 */
function waitForApproval(
  approvalId: string,
  timeoutMs = 55_000,
): Promise<{ approved: boolean; data?: string }> {
  return new Promise((resolve, reject) => {
    const approval = getApproval(approvalId);
    if (!approval) {
      reject(new Error(`Unknown approval ID: ${approvalId}`));
      return;
    }

    // Register the in-memory resolver so telegram.ts can trigger it
    resolveCallbacks.set(approvalId, (result) => {
      clearTimeout(timer);
      resolve(result);
    });

    const timer = setTimeout(() => {
      resolveApproval(approvalId, "timed_out");
      resolveCallbacks.delete(approvalId);
      reject(new Error("Approval timed out"));
    }, timeoutMs);
  });
}

// ── Minimal HTTP router ───────────────────────────────────────────────────────

type Handler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: unknown,
) => Promise<void>;

interface Route {
  method: string;
  path: string;
  handler: Handler;
}

const routes: Route[] = [];

function route(method: string, path: string, handler: Handler): void {
  routes.push({ method: method.toUpperCase(), path, handler });
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (!raw) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); } catch { resolve({}); }
    });
    req.on("error", reject);
  });
}

function jsonResponse(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

// ── Route: GET /health ────────────────────────────────────────────────────────

route("GET", "/health", async (_req, res, _body) => {
  jsonResponse(res, 200, { status: "ok", uptime: process.uptime() });
});

// ── Route: POST /vapi/webhook ─────────────────────────────────────────────────

/**
 * Receives real-time events from Vapi.
 *
 * Supported message types:
 *   function-call  — EA is requesting Luke's approval for an action
 *   status-update  — tracks call lifecycle; on "ended" ingests transcript
 *   transcript     — incremental transcript (logged, not acted on here)
 */
route("POST", "/vapi/webhook", async (_req, res, body) => {
  const event = body as Record<string, unknown>;
  const type = event?.message
    ? (event.message as Record<string, unknown>)?.type
    : event?.type;

  if (type === "function-call") {
    const msg = (event.message ?? event) as Record<string, unknown>;
    const fnCall = msg?.functionCall as Record<string, unknown> | undefined;
    const fnName = fnCall?.name as string | undefined;

    if (fnName === "request_approval") {
      const params = (fnCall?.parameters ?? {}) as Record<string, unknown>;
      const approvalId = `appr_${Date.now()}`;
      const now = new Date().toISOString();

      // Persist approval to SQLite
      createApproval({
        id: approvalId,
        call_id: (msg?.call as Record<string, unknown>)?.id as string | undefined,
        request_type: (params.request_type as PendingApproval["request_type"]) ?? "commit_to_action",
        description: (params.description as string) ?? "EA is requesting approval",
        data_category: params.data_category as string | undefined,
        created_at: now,
      });

      const approval: PendingApproval = {
        id: approvalId,
        call_id: (msg?.call as Record<string, unknown>)?.id as string | undefined,
        request_type: (params.request_type as PendingApproval["request_type"]) ?? "commit_to_action",
        description: (params.description as string) ?? "EA is requesting approval",
        data_category: params.data_category as string | undefined,
        created_at: now,
        status: "pending",
      };

      const config = getConfig();
      if (config.telegramChatId) {
        sendApprovalRequest(config.telegramChatId, approval).catch((err) =>
          console.error("[server] sendApprovalRequest error:", err),
        );
      }

      jsonResponse(res, 200, {
        result: `Approval request ${approvalId} sent to Luke. Waiting for response.`,
      });
      return;
    }

    // Reputation risk — flag any transcript content that could embarrass Luke
    if (fnName === "flag_reputation_risk") {
      const params = (fnCall?.parameters ?? {}) as Record<string, unknown>;
      const eventId = `rep_${Date.now()}`;
      createReputationEvent({
        id: eventId,
        call_id: (msg?.call as Record<string, unknown>)?.id as string | undefined,
        flagged_at: new Date().toISOString(),
        category: (params.category as string) ?? "unknown",
        description: (params.description as string) ?? "Reputation risk flagged",
        severity: (params.severity as "low" | "medium" | "high" | "critical") ?? "medium",
        transcript_excerpt: params.excerpt as string | undefined,
      });

      const config = getConfig();
      if (config.telegramChatId) {
        sendMessage(
          config.telegramChatId,
          `⚠️ REPUTATION RISK on call ${eventId}\nCategory: ${params.category}\n${params.description}`,
        ).catch(() => undefined);
      }

      jsonResponse(res, 200, { result: "Reputation event logged." });
      return;
    }
  }

  if (type === "status-update") {
    const msg = (event.message ?? event) as Record<string, unknown>;
    const status = msg?.status as string | undefined;
    if (status === "ended") {
      const callId = (msg?.call as Record<string, unknown>)?.id as string | undefined;
      console.log(`[server] call ended: ${callId ?? "unknown"}`);
      // Transcript ingest can be wired here when the transcript pipeline is ready.
    }
  }

  jsonResponse(res, 200, { ok: true });
});

// ── Route: POST /telegram/webhook ────────────────────────────────────────────

/**
 * Receives webhook updates from Telegram.
 *
 * This route is an alternative entry-point to the webhook server in telegram.ts
 * for deployments that prefer a single HTTP server on port 3001. Forward the
 * Telegram webhook URL to https://<host>:3001/telegram/webhook.
 *
 * Behaviour:
 *   - "YES [approvalId]" or "NO [approvalId]" — resolves a pending approval
 *   - Anything else — forwarded to the registered onMessage callback (LukeyBot)
 */

interface TelegramWebhookUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number };
    text?: string;
  };
}

// Re-use telegram.ts's onMessage routing by registering a callback that
// handles free-form messages from Luke (e.g. routed to LukeyBot).
// Callers that want to handle free-form messages should call setOnMessage()
// before startServer().

route("POST", "/telegram/webhook", async (_req, res, body) => {
  const update = body as TelegramWebhookUpdate;
  const msg = update?.message;

  if (!msg?.text) {
    jsonResponse(res, 200, { ok: true });
    return;
  }

  const chatId = String(msg.chat.id);
  const text = msg.text.trim();
  const upper = text.toUpperCase();

  // Try to resolve a pending approval: "YES [id]" or "NO [id]"
  const yesNoMatch = upper.match(/^(YES|NO)\s*([A-Za-z0-9_-]*)$/);
  if (yesNoMatch) {
    const approved = yesNoMatch[1] === "YES";
    const explicitId = yesNoMatch[2] || null;

    const dbApproval: DbApproval | null = explicitId
      ? getApproval(explicitId)
      : getLatestPendingApproval();

    if (dbApproval && dbApproval.status === "pending") {
      const newStatus = approved ? "approved" : "denied";
      resolveApproval(dbApproval.id, newStatus, text);
      resolveCallbacks.get(dbApproval.id)?.({ approved, data: text });
      resolveCallbacks.delete(dbApproval.id);

      sendMessage(chatId, approved ? "Approved." : "Denied.").catch(() => undefined);

      jsonResponse(res, 200, { ok: true });
      return;
    }
  }

  jsonResponse(res, 200, { ok: true });
});

// ── Route: POST /calls/initiate ───────────────────────────────────────────────

route("POST", "/calls/initiate", async (_req, res, body) => {
  const { phoneNumber, instructions, personalContext, personaId, leaveVoicemail } =
    body as {
      phoneNumber?: string;
      instructions?: string;
      personalContext?: string;
      personaId?: string;
      leaveVoicemail?: boolean;
    };

  if (!phoneNumber || !instructions) {
    jsonResponse(res, 400, { error: "phoneNumber and instructions are required" });
    return;
  }

  const result = await initiateCall(
    phoneNumber,
    instructions,
    personalContext ?? "",
    personaId,
    leaveVoicemail,
  );

  jsonResponse(res, result.success ? 200 : 500, result);
});

// ── Route: GET /calls/list ────────────────────────────────────────────────────

route("GET", "/calls/list", async (_req, res, _body) => {
  const records = listCallRecords();
  jsonResponse(res, 200, records);
});

// ── Server bootstrap ──────────────────────────────────────────────────────────

export function startServer(): void {
  const server = http.createServer(async (req, res) => {
    const url = req.url?.split("?")[0] ?? "/";
    const method = (req.method ?? "GET").toUpperCase();

    const matched = routes.find((r) => r.method === method && r.path === url);
    if (!matched) {
      jsonResponse(res, 404, { error: "Not found" });
      return;
    }

    try {
      const body = await readBody(req);
      await matched.handler(req, res, body);
    } catch (err) {
      console.error("[server] unhandled error:", err);
      jsonResponse(res, 500, { error: "Internal server error" });
    }
  });

  server.listen(PORT, () => {
    console.log(`[server] HTTP server listening on port ${PORT}`);
  });

  server.on("error", (err) => {
    console.error("[server] server error:", err);
  });
}

// ── Exports for external use ──────────────────────────────────────────────────

export { waitForApproval, resolveCallbacks };
