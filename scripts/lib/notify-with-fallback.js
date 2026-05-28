// notify-with-fallback.js
//
// 2026-05-25 Luke flagged on the Otter feature-backlog feedback session:
// "Something's broken about Telegram right now. It always sends me these
// messages that it's down. I want it to fall back to Codex if it's down.
// Telegram is really flaky."
//
// This is the centralized notify path: try Telegram first, fall back to
// (a) a Codex dispatch entry the codex-companion runtime will surface, and
// (b) a persistent fallback queue (data/agent/telegram-failed-deliveries.jsonl)
// the daily briefing surfaces so a failed Telegram never silently drops.
//
// Use this wherever Amy needs to message Luke. Existing scripts with their
// own sendTelegram() can be migrated to import this lib; new code should
// import directly.

const fs = require('fs');
const path = require('path');
const https = require('https');

const REPO = process.env.SECONDBRAIN_ROOT || path.resolve(__dirname, '..', '..');
const FAILED_PATH = path.join(REPO, 'data', 'agent', 'telegram-failed-deliveries.jsonl');
const CODEX_DISPATCH_PATH = path.join(REPO, 'data', 'agent', 'codex-fallback-dispatches.jsonl');

function appendJsonl(filePath, obj) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, JSON.stringify(obj) + '\n');
  } catch (e) {
    console.warn(`[notify] could not append to ${filePath}: ${e.message}`);
  }
}

function sendTelegramOnce({ token, chatId, text, timeoutMs = 10000 }) {
  return new Promise((resolve) => {
    if (!token || !chatId) return resolve({ ok: false, reason: 'missing_token_or_chat' });
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const body = JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' });
    const req = https.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          return resolve({ ok: true, statusCode: res.statusCode });
        }
        return resolve({ ok: false, statusCode: res.statusCode, body: data.slice(0, 240), reason: `http_${res.statusCode}` });
      });
    });
    req.on('error', (err) => resolve({ ok: false, reason: 'request_error', error: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, reason: 'timeout' }); });
    req.write(body);
    req.end();
  });
}

// Public: notify with fallback. Tries Telegram (up to 2 attempts with
// short backoff). If both fail, writes to the Codex fallback dispatch
// log AND the failed-deliveries log so the daily briefing surfaces it.
async function notifyWithFallback({ text, source = 'unknown', priority = 'normal' } = {}) {
  if (!text || typeof text !== 'string') {
    throw new Error('notifyWithFallback: text is required');
  }
  const token = process.env.TELEGRAM_BOT_TOKEN || '';
  const chatId = process.env.TELEGRAM_CHAT_ID || '';
  const attempts = [];
  for (let i = 0; i < 2; i++) {
    const result = await sendTelegramOnce({ token, chatId, text });
    attempts.push({ attempt: i + 1, ...result });
    if (result.ok) return { ok: true, channel: 'telegram', attempts };
    if (i === 0) await new Promise((r) => setTimeout(r, 1500));
  }
  // Telegram failed. Drop to fallback channels.
  const ts = new Date().toISOString();
  const failureRecord = { ts, source, priority, text, telegramAttempts: attempts };
  appendJsonl(FAILED_PATH, failureRecord);
  appendJsonl(CODEX_DISPATCH_PATH, {
    ts,
    source,
    priority,
    title: `Telegram fallback from ${source}`,
    text,
    needs_codex_surfacing: true,
    telegram_last_error: attempts[attempts.length - 1] && (attempts[attempts.length - 1].reason || `http_${attempts[attempts.length - 1].statusCode}`),
  });
  console.warn(`[notify] Telegram failed after ${attempts.length} attempts (reason: ${attempts[attempts.length - 1].reason}); routed to Codex fallback + failed-deliveries log`);
  return { ok: true, channel: 'fallback', attempts, fallbackPaths: [FAILED_PATH, CODEX_DISPATCH_PATH] };
}

module.exports = { notifyWithFallback, sendTelegramOnce };
