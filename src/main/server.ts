// server.ts — Always-on HTTP server exposing backend functionality over REST.
// Uses Node's built-in http module (no Express dependency).
// Listens on port 3002 (local Electron process; EC2 uses 3001).

import * as http from 'http';
import { BrowserWindow } from 'electron';
import { getConfig } from './config';
import { initiateCall, listCallRecords } from './calls';
import { PendingApproval, sendApprovalRequest, sendMessage } from './telegram';
import {
  createApproval,
  resolveApproval,
  getApproval,
  getLatestPendingApproval,
  createReputationEvent,
  type DbApproval,
} from './database-sqlite';
import { ingestSmsWebhook } from './twilio-sms';
import { listBriefingFiles, loadBriefingByDate, pruneOldBriefings } from './briefing-parser';
import { approveTask, createTask } from './task-store';
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

// ── Types ─────────────────────────────────────────────────────────────────────

const PORT = 3002;

// In-memory resolver callbacks — the approval records live in SQLite,
// only the Promise resolvers stay in memory (they can't be serialized).
const resolveCallbacks = new Map<string, (result: { approved: boolean; data?: string }) => void>();

// ── Approval helpers ──────────────────────────────────────────────────────────

/**
 * Creates an approval record in SQLite, sends Telegram notification, and
 * returns a Promise that resolves when the owner replies YES/NO (or times out).
 */
function waitForApproval(
  approvalId: string,
  timeoutMs = 55_000,
): Promise<{ approved: boolean; data?: string }> {
  return new Promise((resolve, reject) => {
    const approval = getApproval(approvalId);
    if (!approval) {
      reject(new Error(`PRIVATE_NAME approval ID: ${approvalId}`));
      return;
    }

    // Register the in-memory resolver so telegram.ts can trigger it
    resolveCallbacks.set(approvalId, (result) => {
      clearTimeout(timer);
      resolve(result);
    });

    const timer = setTimeout(() => {
      resolveApproval(approvalId, 'timed_out');
      resolveCallbacks.delete(approvalId);
      reject(new Error('Approval timed out'));
    }, timeoutMs);
  });
}

// ── Minimal HTTP router ───────────────────────────────────────────────────────

type Handler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: ExampleCo,
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

function readBody(req: http.IncomingMessage): Promise<ExampleCo> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

function readRawBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function jsonResponse(res: http.ServerResponse, status: number, body: ExampleCo): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

// ── Route: GET /health ────────────────────────────────────────────────────────

route('GET', '/health', async (_req, res, _body) => {
  jsonResponse(res, 200, { status: 'ok', uptime: process.uptime() });
});

// ── Route: POST /vapi/webhook ─────────────────────────────────────────────────

/**
 * Receives real-time events from Vapi.
 *
 * Supported message types:
 *   function-call  — EA is requesting the owner's approval for an action
 *   status-update  — tracks call lifecycle; on "ended" ingests transcript
 *   transcript     — incremental transcript (logged, not acted on here)
 */
route('POST', '/vapi/webhook', async (_req, res, body) => {
  const event = body as Record<string, ExampleCo>;
  const type = event?.message ? (event.message as Record<string, ExampleCo>)?.type : event?.type;

  if (type === 'function-call') {
    const msg = (event.message ?? event) as Record<string, ExampleCo>;
    const fnCall = msg?.functionCall as Record<string, ExampleCo> | undefined;
    const fnName = fnCall?.name as string | undefined;

    if (fnName === 'request_approval') {
      const params = (fnCall?.parameters ?? {}) as Record<string, ExampleCo>;
      const approvalId = `appr_${Date.now()}`;
      const now = new Date().toISOString();

      // Persist approval to SQLite
      createApproval({
        id: approvalId,
        call_id: (msg?.call as Record<string, ExampleCo>)?.id as string | undefined,
        request_type:
          (params.request_type as PendingApproval['request_type']) ?? 'commit_to_action',
        description: (params.description as string) ?? 'EA is requesting approval',
        data_category: params.data_category as string | undefined,
        created_at: now,
      });

      const approval: PendingApproval = {
        id: approvalId,
        call_id: (msg?.call as Record<string, ExampleCo>)?.id as string | undefined,
        request_type:
          (params.request_type as PendingApproval['request_type']) ?? 'commit_to_action',
        description: (params.description as string) ?? 'EA is requesting approval',
        data_category: params.data_category as string | undefined,
        created_at: now,
        status: 'pending',
      };

      const config = getConfig();
      if (config.telegramChatId) {
        sendApprovalRequest(config.telegramChatId, approval).catch((err) =>
          console.error('[server] sendApprovalRequest error:', err),
        );
      }

      jsonResponse(res, 200, {
        result: `Approval request ${approvalId} sent to the owner. Waiting for response.`,
      });
      return;
    }

    // Bridge-in — caller wants to speak directly to the owner
    if (fnName === 'bridge_in_owner') {
      const params = (fnCall?.parameters ?? {}) as Record<string, ExampleCo>;
      const callerName = (params.caller_name as string) || 'someone';
      const topic = (params.topic as string) || 'unspecified';
      const callObj = (msg?.call ?? event?.call) as Record<string, ExampleCo> | undefined;
      const callerPhone = (callObj?.customer as Record<string, ExampleCo>)?.number as
        | string
        | undefined;
      const liveCallId = callObj?.id as string | undefined;

      const config = getConfig();
      const ownerPhone = config.ownerPrivateSim;

      console.log(
        `[server] bridge_in_owner: ${callerName} re: ${topic} → ${ownerPhone || 'NOT SET'}`,
      );

      // Telegram is daily-briefing-only — bridge-in logged to console
      console.log(
        `[server] Bridge-in: ${callerName} re: ${topic} (caller: ${callerPhone || 'ExampleCo'})`,
      );

      if (!ownerPhone) {
        jsonResponse(res, 200, {
          result: 'I was not able to reach the owner right now. I will let him know you called.',
        });
        return;
      }

      // Initiate outbound call to the owner's private SIM via Vapi
      if (config.vapiApiKey && config.vapiPhoneNumberId) {
        const bridgePrompt = `You are bridging a live call for the owner. A caller named ${callerName} is on hold about: "${topic}". Tell the owner who is holding and ask: "Want me to connect you?" If yes, use the transferCall tool. If no, end this call.`;
        const bridgeBody = JSON.stringify({
          phoneNumberId: config.vapiPhoneNumberId,
          customer: { number: ownerPhone.startsWith('+') ? ownerPhone : `+1${ownerPhone}` },
          assistant: {
            model: {
              provider: 'openai',
              model: 'gpt-4o',
              messages: [{ role: 'system', content: bridgePrompt }],
              tools: callerPhone
                ? [
                    {
                      type: 'transferCall',
                      destinations: [
                        { type: 'number', number: callerPhone, message: 'Connecting you now.' },
                      ],
                    },
                  ]
                : [],
            },
            voice: { provider: '11labs', voiceId: 'paula' },
            firstMessage: `Hey — you have ${callerName} holding about "${topic}". Want me to connect you?`,
            endCallPhrases: ['no', 'no thanks', 'not now', 'goodbye'],
          },
          metadata: { bridge_caller: callerName, live_call_id: liveCallId || 'ExampleCo' },
        });

        fetch('https://api.vapi.ai/call/phone', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.vapiApiKey}`,
          },
          body: bridgeBody,
        })
          .then((r) => r.json())
          .then((d) => console.log(`[server] bridge dial initiated: ${d?.id}`))
          .catch((e) => console.error('[server] bridge dial error:', e.message));
      }

      jsonResponse(res, 200, {
        result: `Calling the owner now — ${callerName}, please hold while I connect you.`,
      });
      return;
    }

    // Reputation risk — flag any transcript content that could embarrass the owner
    if (fnName === 'flag_reputation_risk') {
      const params = (fnCall?.parameters ?? {}) as Record<string, ExampleCo>;
      const eventId = `rep_${Date.now()}`;
      createReputationEvent({
        id: eventId,
        call_id: (msg?.call as Record<string, ExampleCo>)?.id as string | undefined,
        flagged_at: new Date().toISOString(),
        category: (params.category as string) ?? 'ExampleCo',
        description: (params.description as string) ?? 'Reputation risk flagged',
        severity: (params.severity as 'low' | 'medium' | 'high' | 'critical') ?? 'medium',
        transcript_excerpt: params.excerpt as string | undefined,
      });

      // Security alert — reputation risk always goes to Telegram immediately
      const config = getConfig();
      if (config.telegramChatId) {
        sendMessage(
          config.telegramChatId,
          `⚠️ REPUTATION RISK on call ${eventId}\nCategory: ${params.category}\n${params.description}`,
        ).catch(() => undefined);
      }

      jsonResponse(res, 200, { result: 'Reputation event logged.' });
      return;
    }
  }

  if (type === 'status-update' || type === 'end-of-call-report') {
    const msg = (event.message ?? event) as Record<string, ExampleCo>;
    const status = msg?.status as string | undefined;
    const isEnded = type === 'end-of-call-report' || status === 'ended';
    if (isEnded) {
      const callObj = (msg?.call ?? {}) as Record<string, ExampleCo>;
      const callId = callObj.id as string | undefined;
      const callerPhone = (callObj.customer as Record<string, ExampleCo>)?.number as
        | string
        | undefined;
      const durationSeconds = (() => {
        const s = callObj.startedAt as string | undefined;
        const e = callObj.endedAt as string | undefined;
        if (s && e) return Math.round((new Date(e).getTime() - new Date(s).getTime()) / 1000);
        return 0;
      })();
      console.log(
        `[server] call ended: ${callId ?? 'ExampleCo'} (${durationSeconds}s) from ${callerPhone ?? 'ExampleCo'}`,
      );

      // Notify renderer so UI can refresh the call list
      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
        win.webContents.send('call:ended', {
          callId,
          callerPhone,
          durationSeconds,
          summary: (msg?.summary as string) ?? undefined,
        });
      }
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
 *   - Anything else — forwarded to the registered onMessage callback (OwnerBot)
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
// handles free-form messages from the owner (e.g. routed to OwnerBot).
// Callers that want to handle free-form messages should call setOnMessage()
// before startServer().

route('POST', '/telegram/webhook', async (_req, res, body) => {
  const update = body as TelegramWebhookUpdate;
  const msg = update?.message;

  if (!msg?.text) {
    jsonResponse(res, 200, { ok: true });
    return;
  }

  const chatId = String(msg.chat.id);
  const text = msg.text.trim();
  const upper = text.toUpperCase();
  try {
    const { recordDispatchInput } = require('../../scripts/lib/spine-ingress');
    recordDispatchInput({
      origin: 'telegram',
      sourceType: 'telegram-message',
      sourceRef: String(msg.message_id || update.update_id),
      title: 'Telegram dispatch',
      text,
      approved: true,
      meta: { explicitRequest: true },
    });
  } catch (err) {
    console.error('[server] telegram spine write failed:', err);
  }

  // Try to resolve a pending approval: "YES [id]" or "NO [id]"
  const yesNoMatch = upper.match(/^(YES|NO)\s*([A-Za-z0-9_-]*)$/);
  if (yesNoMatch) {
    const approved = yesNoMatch[1] === 'YES';
    const explicitId = yesNoMatch[2] || null;

    const dbApproval: DbApproval | null = explicitId
      ? getApproval(explicitId)
      : getLatestPendingApproval();

    if (dbApproval && dbApproval.status === 'pending') {
      const newStatus = approved ? 'approved' : 'denied';
      resolveApproval(dbApproval.id, newStatus, text);
      resolveCallbacks.get(dbApproval.id)?.({ approved, data: text });
      resolveCallbacks.delete(dbApproval.id);

      sendMessage(chatId, approved ? 'Approved.' : 'Denied.').catch(() => undefined);

      jsonResponse(res, 200, { ok: true });
      return;
    }
  }

  jsonResponse(res, 200, { ok: true });
});

// ── Route: POST /calls/initiate ───────────────────────────────────────────────

route('POST', '/calls/initiate', async (_req, res, body) => {
  const { phoneNumber, instructions, personalContext, personaId, leaveVoicemail } = body as {
    phoneNumber?: string;
    instructions?: string;
    personalContext?: string;
    personaId?: string;
    leaveVoicemail?: boolean;
  };

  if (!phoneNumber || !instructions) {
    jsonResponse(res, 400, { error: 'phoneNumber and instructions are required' });
    return;
  }

  const result = await initiateCall(
    phoneNumber,
    instructions,
    personalContext ?? '',
    personaId,
    leaveVoicemail,
  );

  jsonResponse(res, result.success ? 200 : 500, result);
});

// ── Route: GET /calls/list ────────────────────────────────────────────────────

route('GET', '/calls/list', async (_req, res, _body) => {
  const records = listCallRecords();
  jsonResponse(res, 200, records);
});

// ── Route: POST /twilio/webhook ──────────────────────────────────────────────

route('POST', '/twilio/webhook', async (req, res, _body) => {
  // Twilio sends form-urlencoded, not JSON — read raw and parse
  const raw = await readRawBody(req);
  const fields: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(raw)) fields[k] = v;

  const { count, message } = await ingestSmsWebhook(fields);

  // Push inbound message to renderer for toast notification
  if (message) {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) win.webContents.send('sms:inbound', message);
  }

  // Twilio expects TwiML response
  res.writeHead(200, { 'Content-Type': 'text/xml' });
  res.end('<Response></Response>');
});

// ── Briefing mobile routes ───────────────────────────────────────────────────
// Exposes the latest briefings as a mobile-friendly HTML page + JSON API.
// ExampleCo opens http://<pc-lan-ip>:3002/briefing on his phone (same wifi) or via a
// Cloudflare tunnel to see the daily briefing without opening the Electron app.
// Right-click / long-press "Dispatch" button sends a #Amy email back to himself
// which the Gmail scan processes on next pass.

function htmlResponse(res: http.ServerResponse, status: number, body: string): void {
  const buf = Buffer.from(body, 'utf-8');
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function linkify(s: string): string {
  return s.replace(
    /(https?:\/\/[^\s<>)]+)/g,
    (u) =>
      `<a href="${escapeHtml(u)}" target="_blank" rel="noopener" style="color:#c96442;word-break:break-all">${escapeHtml(u)}</a>`,
  );
}

function renderBriefingHtml(date: string | null, availableDates: string[]): string {
  const parsed = date ? loadBriefingByDate(date) : null;
  const tabs = availableDates
    .map(
      (d) =>
        `<a href="/briefing?date=${d}" class="tab${d === date ? ' tab-active' : ''}">${d}</a>`,
    )
    .join('');

  const sectionsHtml = parsed
    ? parsed.sections
        .map((s, i) => {
          const sid = 'sec-' + i;
          const body = linkify(escapeHtml(s.body));
          return `
          <section class="sec" id="${sid}">
            <header class="sec-h"><span class="sec-title">${escapeHtml(s.title)}</span>
              <button type="button" class="dispatch-btn" data-section="${escapeHtml(s.title)}">Dispatch</button>
            </header>
            <pre class="sec-body">${body}</pre>
          </section>
        `;
        })
        .join('')
    : '<p style="color:#aaa">No briefing found for ' + escapeHtml(date || 'today') + '.</p>';

  const greeting = parsed
    ? `<pre class="greeting">${linkify(escapeHtml(parsed.greeting))}</pre>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=5" />
  <title>Briefing${parsed ? ' · ' + parsed.date : ''}</title>
  <style>
    :root { --copper:#c96442; --cream:#f4f3ee; --cream-dim:#bdbab2; --ink:#191817; --bg:#0f0f0f; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: var(--bg); color: #d0cfc8;
      font-family: Georgia, 'Times New Roman', serif; font-size: 16px; line-height: 1.55; }
    header.top { position: sticky; top: 0; background: #0b0b0b; border-bottom: 1px solid #1e1e1e;
      padding: 12px 14px; display: flex; align-items: center; gap: 10px; z-index: 5; }
    header.top h1 { font-size: 15px; font-weight: 600; color: var(--cream); margin: 0; flex: 1;
      font-family: system-ui, sans-serif; letter-spacing: 0.3px; }
    .tabs { display: flex; gap: 6px; overflow-x: auto; padding: 8px 14px; background: #0b0b0b;
      border-bottom: 1px solid #1e1e1e; }
    .tab { color: #888; text-decoration: none; padding: 6px 12px; border-radius: 999px;
      border: 1px solid #222; font-size: 12px; font-family: system-ui, sans-serif; white-space: nowrap; }
    .tab-active { color: var(--cream); border-color: var(--copper); background: #1a0f0b; }
    main { padding: 16px 14px 80px; max-width: 820px; margin: 0 auto; }
    .greeting { white-space: pre-wrap; color: var(--cream); font-size: 16px;
      padding: 0 0 12px; margin: 0 0 18px; border-bottom: 1px solid #1e1e1e;
      font-family: Georgia, serif; }
    section.sec { margin-bottom: 16px; border: 1px solid #1e1e1e; border-radius: 6px; background: #141312; }
    .sec-h { display: flex; align-items: center; gap: 10px; padding: 10px 12px;
      border-bottom: 1px solid #1e1e1e; }
    .sec-title { color: #d9795a; font-family: system-ui, sans-serif; font-size: 12.5px;
      font-weight: 700; letter-spacing: 0.3px; text-transform: uppercase; flex: 1; }
    .dispatch-btn { background: var(--copper); color: var(--cream); border: none;
      border-radius: 4px; padding: 6px 12px; font-size: 12px; font-weight: 600; cursor: pointer;
      font-family: system-ui, sans-serif; }
    .sec-body { white-space: pre-wrap; margin: 0; padding: 12px 14px; color: #d0cfc8;
      font-family: Georgia, 'Times New Roman', serif; font-size: 14.5px; line-height: 1.6;
      overflow-wrap: break-word; }
    .modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,0.78); display: none;
      align-items: center; justify-content: center; padding: 16px; z-index: 99; }
    .modal { width: 100%; max-width: 480px; background: var(--ink); border: 1px solid var(--copper);
      border-radius: 8px; padding: 18px; }
    .modal h2 { margin: 0 0 4px; font-size: 12px; color: var(--cream-dim);
      font-family: system-ui, sans-serif; letter-spacing: 0.3px; }
    .modal .section-name { color: #d9795a; font-size: 14px; font-weight: 700;
      margin-bottom: 12px; font-family: system-ui, sans-serif; }
    .modal textarea { width: 100%; min-height: 110px; background: #0f0f0f; color: var(--cream);
      border: 1px solid #333; border-radius: 4px; padding: 9px; font-size: 14px;
      font-family: inherit; resize: vertical; }
    .modal .buttons { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
    .modal button { padding: 8px 14px; border-radius: 4px; font-size: 13px; font-weight: 600;
      cursor: pointer; font-family: system-ui, sans-serif; border: none; }
    .btn-cancel { background: transparent; color: var(--cream-dim); border: 1px solid #333 !important; }
    .btn-send { background: var(--copper); color: var(--cream); }
    .toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
      background: var(--ink); color: var(--cream); padding: 10px 18px; border: 1px solid var(--copper);
      border-radius: 6px; font-size: 13px; z-index: 100; display: none; }
    @media (max-width: 520px) {
      header.top h1 { font-size: 14px; }
      .sec-body { font-size: 14px; }
      main { padding: 12px 10px 80px; }
      .dispatch-btn { padding: 6px 10px; font-size: 11px; }
    }
  </style>
</head>
<body>
  <header class="top">
    <h1>Daily Briefing</h1>
    <a href="/briefing" style="color:#888;font-size:12px;text-decoration:none;font-family:system-ui,sans-serif">Refresh</a>
  </header>
  <div class="tabs">${tabs}</div>
  <main>
    ${greeting}
    ${sectionsHtml}
  </main>

  <div class="modal-bg" id="modal-bg">
    <div class="modal">
      <h2>Dispatch to Amy</h2>
      <div class="section-name" id="modal-section"></div>
      <textarea id="modal-text" placeholder="What should Amy do about this section?"></textarea>
      <div class="buttons">
        <button type="button" class="btn-cancel" id="btn-cancel">Cancel</button>
        <button type="button" class="btn-send" id="btn-send">Dispatch</button>
      </div>
    </div>
  </div>
  <div class="toast" id="toast"></div>

  <script>
    const bg = document.getElementById('modal-bg');
    const modalSection = document.getElementById('modal-section');
    const modalText = document.getElementById('modal-text');
    const toast = document.getElementById('toast');
    const briefingDate = ${JSON.stringify(parsed?.date || null)};
    let currentSection = '';

    function showToast(msg) {
      toast.textContent = msg;
      toast.style.display = 'block';
      setTimeout(() => (toast.style.display = 'none'), 3500);
    }

    document.querySelectorAll('.dispatch-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        currentSection = btn.dataset.section || '';
        modalSection.textContent = currentSection;
        modalText.value = '';
        bg.style.display = 'flex';
        setTimeout(() => modalText.focus(), 60);
      });
    });

    // Long-press on section body opens modal on mobile
    document.querySelectorAll('section.sec').forEach((sec) => {
      let timer = null;
      sec.addEventListener('touchstart', () => {
        timer = setTimeout(() => {
          const title = sec.querySelector('.sec-title')?.textContent || '';
          currentSection = title;
          modalSection.textContent = title;
          modalText.value = '';
          bg.style.display = 'flex';
          setTimeout(() => modalText.focus(), 60);
        }, 500);
      });
      sec.addEventListener('touchend', () => { if (timer) clearTimeout(timer); });
      sec.addEventListener('touchmove', () => { if (timer) clearTimeout(timer); });
    });

    document.getElementById('btn-cancel').addEventListener('click', () => {
      bg.style.display = 'none';
    });
    bg.addEventListener('click', (e) => { if (e.target === bg) bg.style.display = 'none'; });

    document.getElementById('btn-send').addEventListener('click', async () => {
      const comment = modalText.value.trim();
      if (!comment) { showToast('Add a comment first'); return; }
      try {
        const r = await fetch('/briefing/dispatch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ date: briefingDate, sectionTitle: currentSection, comment }),
        });
        const j = await r.json();
        if (j.ok) { bg.style.display = 'none'; showToast('Dispatched to Amy'); }
        else { showToast('Failed: ' + (j.error || 'ExampleCo')); }
      } catch (e) { showToast('Failed: ' + e.message); }
    });
  </script>
</body>
</html>`;
}

route('GET', '/briefing', async (req, res, _body) => {
  pruneOldBriefings(3);
  const urlObj = new URL(req.url ?? '/briefing', 'http://localhost');
  const requested = urlObj.searchParams.get('date');
  const days = listBriefingFiles();
  const dates = days.map((d) => d.date);
  const target = requested && dates.includes(requested) ? requested : dates[0] || null;
  htmlResponse(res, 200, renderBriefingHtml(target, dates));
});

route('GET', '/briefing.json', async (req, res, _body) => {
  const urlObj = new URL(req.url ?? '/briefing.json', 'http://localhost');
  const requested = urlObj.searchParams.get('date');
  const days = listBriefingFiles();
  const dates = days.map((d) => d.date);
  const target = requested && dates.includes(requested) ? requested : dates[0] || null;
  const parsed = target ? loadBriefingByDate(target) : null;
  jsonResponse(res, 200, { available: days, current: parsed });
});

route('POST', '/briefing/dispatch', async (_req, res, body) => {
  const { date, sectionTitle, comment } = (body || {}) as {
    date?: string;
    sectionTitle?: string;
    comment?: string;
  };
  if (!comment || !comment.trim()) {
    jsonResponse(res, 400, { ok: false, error: 'empty comment' });
    return;
  }
  try {
    const section = sectionTitle || 'ExampleCo';
    const task = createTask({
      kind: 'action',
      origin: 'briefing',
      title: `Mobile briefing feedback: ${section}`,
      prompt: [
        `ExampleCo gave feedback from the mobile briefing page on section "${section}".`,
        `Briefing date: ${date || 'ExampleCo'}.`,
        '',
        'Feedback:',
        comment,
        '',
        'Act on this feedback through the Task Spine.',
      ].join('\n'),
      source: { type: 'mobile-briefing-page', ref: `${date || 'today'}/${section}` },
    });
    approveTask(task.id, true);
    try {
      const logPath = path.join(
        process.env.SECONDBRAIN_ROOT || app.getAppPath(),
        'data',
        'agent',
        'amy-dispatch-log.jsonl',
      );
      fs.appendFileSync(
        logPath,
        JSON.stringify({
          thread_id: null,
          subject: `Mobile briefing feedback: ${section} (${date || 'today'})`,
          sent_at: new Date().toISOString(),
          source: 'mobile_briefing_long_press',
          briefing_date: date,
          section,
          comment,
          action: 'spine_task',
          action_summary: `Created spine Task ${task.id}`,
          spine_task_id: task.id,
          status: 'queued',
        }) + '\n',
      );
    } catch {
      // logging failure should not break the response
    }
    jsonResponse(res, 200, { ok: true, spineTaskId: task.id });
  } catch (e) {
    jsonResponse(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

// ── Server bootstrap ──────────────────────────────────────────────────────────

export function startServer(): void {
  const server = http.createServer(async (req, res) => {
    const url = req.url?.split('?')[0] ?? '/';
    const method = (req.method ?? 'GET').toUpperCase();

    const matched = routes.find((r) => r.method === method && r.path === url);
    if (!matched) {
      jsonResponse(res, 404, { error: 'Not found' });
      return;
    }

    try {
      const body = await readBody(req);
      await matched.handler(req, res, body);
    } catch (err) {
      console.error('[server] unhandled error:', err);
      jsonResponse(res, 500, { error: 'Internal server error' });
    }
  });

  // Bind on 0.0.0.0 so phones on the same LAN can reach /briefing at
  // http://<pc-local-ip>:3002/briefing. Loopback-only (127.0.0.1) would lock it
  // to the PC itself.
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[server] HTTP server listening on 0.0.0.0:${PORT}`);
  });

  server.on('error', (err) => {
    console.error('[server] server error:', err);
  });
}

// ── Exports for external use ──────────────────────────────────────────────────

export { waitForApproval, resolveCallbacks };
