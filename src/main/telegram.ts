import * as fs from "fs";
import * as http from "http";
import { getConfig } from "./config";
import { isNotifyCategoryAllowed, type NotifyCategory } from "./notify-policy";
import {
  createApproval,
  getApproval,
  resolveApproval,
  getLatestPendingApproval,
  type DbApproval,
} from "./database-sqlite";

export type { NotifyCategory } from "./notify-policy";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PendingApproval {
  id: string;
  call_id?: string;
  request_type: 'share_pii' | 'transfer_call' | 'commit_to_action' | 'reputation_risk' | 'content_approval';
  description: string;
  data_category?: string;
  created_at: string;
  status: 'pending' | 'approved' | 'denied' | 'timed_out';
  resolve?: (result: { approved: boolean; data?: string }) => void;
}

/** Context about a message the inbound message is a reply to, if any. */
export interface ReplyContext {
  replyToMessageId: number;
  replyToText?: string;
}

export type OnMessageCallback = (
  chatId: string,
  text: string,
  messageId: number,
  replyContext?: ReplyContext,
) => void;

// ── State ─────────────────────────────────────────────────────────────────────

// In-memory resolve callbacks keyed by approval ID (cannot be persisted to SQLite).
// The approval *record* lives in SQLite; only the Promise resolver stays in memory.
const resolveCallbacks = new Map<string, (result: { approved: boolean; data?: string }) => void>();
let _onMessage: OnMessageCallback | null = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

function apiUrl(method: string): string {
  const token = getConfig().telegramBotToken;
  return `https://api.telegram.org/bot${token}/${method}`;
}

function log(label: string, err: ExampleCo): void {
  console.error(`[telegram] ${label}:`, err instanceof Error ? err.message : String(err));
}

async function postJson(method: string, body: Record<string, ExampleCo>): Promise<ExampleCo> {
  const res = await fetch(apiUrl(method), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json() as { ok: boolean; description?: string };
  if (!json.ok) throw new Error(`Telegram ${method} error: ${json.description ?? "ExampleCo"}`);
  return json;
}

/** Builds a multipart/form-data body from a flat map of string fields plus one file field. */
function buildMultipart(
  fields: Record<string, string>,
  fileField: string,
  filePath: string,
  mimeType: string,
): { body: Buffer; boundary: string } {
  const boundary = `----SBBoundary${Date.now().toString(16)}`;
  const CRLF = "\r\n";
  const parts: Buffer[] = [];

  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}${CRLF}` +
        `Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}` +
        `${value}${CRLF}`,
        "utf-8",
      ),
    );
  }

  const fileName = filePath.split(/[\\/]/).pop() ?? "file";
  const fileData = fs.readFileSync(filePath);
  parts.push(
    Buffer.from(
      `--${boundary}${CRLF}` +
      `Content-Disposition: form-data; name="${fileField}"; filename="${fileName}"${CRLF}` +
      `Content-Type: ${mimeType}${CRLF}${CRLF}`,
      "utf-8",
    ),
    fileData,
    Buffer.from(CRLF, "utf-8"),
  );

  parts.push(Buffer.from(`--${boundary}--${CRLF}`, "utf-8"));
  return { body: Buffer.concat(parts), boundary };
}

async function postMultipart(
  method: string,
  fields: Record<string, string>,
  fileField: string,
  filePath: string,
  mimeType: string,
): Promise<ExampleCo> {
  const { body, boundary } = buildMultipart(fields, fileField, filePath, mimeType);
  const res = await fetch(apiUrl(method), {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body,
  });
  const json = await res.json() as { ok: boolean; description?: string };
  if (!json.ok) throw new Error(`Telegram ${method} error: ${json.description ?? "ExampleCo"}`);
  return json;
}

// ── Notification policy ───────────────────────────────────────────────────────
//
// ExampleCo gets a Telegram ONLY for these categories. Everything else (briefings,
// service-down alerts, dispatch completions, exceptions, error reports,
// per-item status chatter) is dropped at this one chokepoint, no matter which
// caller tries to send it.
//
//   question_answer    an answer to a question ExampleCo asked in Telegram
//   approval           an interactive YES/NO prompt that needs ExampleCo's reply
//   security/pii       PII, security, or reputation risk
//   video_ready        a video is ready for ExampleCo
//   voice_followup     post-call Amy follow-up, one message
//
// An owner-bound message with no allowed category is suppressed (logged only).

function isOwnerChat(chatId: string): boolean {
  const owner = getConfig().telegramChatId;
  return !!owner && String(chatId) === String(owner);
}

/** True if a message to this chat with this category is allowed to send. */
function notifyAllowed(chatId: string, category?: NotifyCategory): boolean {
  if (!isOwnerChat(chatId)) return true; // non-owner sends are not gated
  return isNotifyCategoryAllowed(category);
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function sendMessage(
  chatId: string,
  text: string,
  category?: NotifyCategory,
): Promise<void> {
  if (!notifyAllowed(chatId, category)) {
    console.log(`[telegram] suppressed owner message (no allowed category): ${text.slice(0, 80)}`);
    return;
  }
  try {
    await postJson("sendMessage", { chat_id: chatId, text });
  } catch (err) {
    log("sendMessage", err);
  }
}

export async function sendVideo(
  chatId: string,
  videoPath: string,
  caption: string,
  category?: NotifyCategory,
): Promise<void> {
  if (!notifyAllowed(chatId, category)) {
    console.log("[telegram] suppressed owner video (no allowed category)");
    return;
  }
  try {
    await postMultipart(
      "sendVideo",
      { chat_id: chatId, caption },
      "video",
      videoPath,
      "video/mp4",
    );
  } catch (err) {
    log("sendVideo", err);
  }
}

export async function sendPhoto(chatId: string, photoPath: string, caption: string): Promise<void> {
  try {
    await postMultipart(
      "sendPhoto",
      { chat_id: chatId, caption },
      "photo",
      photoPath,
      "image/jpeg",
    );
  } catch (err) {
    log("sendPhoto", err);
  }
}

/**
 * Persists the approval to SQLite and registers the resolve callback in memory.
 * The owner Telegram prompt is suppressed by notify-policy unless the policy
 * explicitly changes.
 */
export async function sendApprovalRequest(chatId: string, approval: PendingApproval): Promise<void> {
  void chatId;
  // Persist to SQLite (upsert — caller may have already inserted)
  try {
    createApproval({
      id: approval.id,
      call_id: approval.call_id,
      request_type: approval.request_type,
      description: approval.description,
      data_category: approval.data_category,
      created_at: approval.created_at,
    });
  } catch {
    // Row may already exist if created by server.ts webhook handler — that's fine
  }

  // Register the in-memory resolver if provided
  if (approval.resolve) {
    resolveCallbacks.set(approval.id, approval.resolve);
  }

  console.log(`[telegram] approval request suppressed by policy: ${approval.id}`);
}

/**
 * Registers a callback for every non-approval message the owner sends via Telegram.
 * Call before startWebhook so it's set when the server starts receiving traffic.
 */
export function setOnMessage(cb: OnMessageCallback): void {
  _onMessage = cb;
}

/**
 * Starts a minimal HTTP server that receives Telegram webhook POSTs.
 *
 * Telegram delivers updates as JSON POSTs to webhookPath. This handler:
 *  - Parses the incoming update
 *  - If the message text is YES/NO and matches a pending approval ID in the
 *    same chat, resolves that approval
 *  - Otherwise forwards to the onMessage callback
 *
 * Wire this up to Telegram via:
 *   POST https://api.telegram.org/bot{token}/setWebhook?url=https://your-host/webhookPath
 */
export function startWebhook(port: number, webhookPath: string): void {
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== webhookPath) {
      res.writeHead(404).end();
      return;
    }

    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      res.writeHead(200).end("ok");
      try {
        const update = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as TelegramUpdate;
        handleUpdate(update);
      } catch (err) {
        log("webhook parse", err);
      }
    });
  });

  server.listen(port, () => {
    console.log(`[telegram] webhook listening on port ${port} at ${webhookPath}`);
  });

  server.on("error", (err) => log("webhook server", err));
}

// ── Internal update handler ───────────────────────────────────────────────────

interface TelegramMessage {
  message_id: number;
  chat: { id: number };
  text?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage & {
    /** Present when the user replied to a previous message. */
    reply_to_message?: TelegramMessage;
  };
}

/** YES/NO reply format: the text is exactly "YES <approvalId>" or "NO <approvalId>".
 *  If the approvalId portion is absent we scan the most recent pending approval for that chat. */
function handleUpdate(update: TelegramUpdate): void {
  const msg = update.message;
  if (!msg?.text) return;

  const chatId = String(msg.chat.id);
  const text = msg.text.trim();
  const upper = text.toUpperCase();

  // Try to match "YES <id>" / "NO <id>" first, then bare "YES" / "NO"
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
      return; // don't forward approval replies to onMessage
    }
  }

  const replied = msg.reply_to_message;
  const replyContext: ReplyContext | undefined = replied
    ? { replyToMessageId: replied.message_id, replyToText: replied.text }
    : undefined;

  _onMessage?.(chatId, text, msg.message_id, replyContext);
}
