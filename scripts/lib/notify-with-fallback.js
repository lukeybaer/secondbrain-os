// notify-with-fallback.js
//
// 2026-05-25 ExampleCo flagged on the Otter feature-backlog feedback session:
// "Something's broken about Telegram right now. It always sends me these
// messages that it's down. I want it to fall back to Codex if it's down.
// Telegram is really flaky."
//
// This is the centralized notify path: try Telegram first, fall back to
// (a) a Codex dispatch entry the codex-companion runtime will surface, and
// (b) a persistent fallback queue (data/agent/telegram-failed-deliveries.jsonl)
// the daily briefing surfaces so a failed Telegram never silently drops.
//
// Use this wherever Amy needs to message ExampleCo. Existing scripts with their
// own sendTelegram() can be migrated to import this lib; new code should
// import directly.

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { containsRawOperationalLeak } = require('./executive-surface-policy');
const { shouldSuppressDuplicate, recordNotification } = require('./notification-dedup');

const REPO = process.env.SECONDBRAIN_ROOT || path.resolve(__dirname, '..', '..');
const FAILED_PATH = path.join(REPO, 'data', 'agent', 'telegram-failed-deliveries.jsonl');
const CODEX_DISPATCH_PATH = path.join(REPO, 'data', 'agent', 'codex-fallback-dispatches.jsonl');
const SUPPRESSED_PATH = path.join(REPO, 'data', 'agent', 'telegram-suppressed.jsonl');
const DELIVERED_PATH = path.join(REPO, 'data', 'agent', 'telegram-deliveries.jsonl');

function loadDotEnvIfPresent(filePath = path.join(REPO, '.env'), env = process.env) {
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!env[key]) env[key] = value;
    }
  } catch {
    /* .env is optional */
  }
}

loadDotEnvIfPresent();

// 2026-06-09 ExampleCo: "self-heal telegram, it keeps spamming me with HTTP 404
// messages and morning briefing summaries. Links are ok but briefing summaries
// and 404s no." Two mechanical guards live here so NO sender can leak again:
//   1. isCliFailureOutput scrub (below) kills any raw upstream error (HTTP 4xx,
//      not_found_error model leaks, auth/rate-limit strings) regardless of kind.
//   2. This kind allowlist enforces the Telegram channel policy
//      (memory/feedback_telegram_policy.md): Telegram is reactive replies
//      only when explicitly marked reactive, plus PII/security/reputation risk,
//      video-ready, voice follow-up, and the once-daily briefing LINK
//      (2026-07-03: ExampleCo never received the 5:30 link because 'briefing-link'
//      was missing here; his 2026-06-09 rule is "Links are ok but briefing
//      summaries and 404s no"). Approval prompts, auth reminders, service
//      status, health summaries, scan-complete, briefing SUMMARIES, and
//      activity logs are suppressed and logged internally only.
// Every Telegram sender in scripts/ must route through notifyWithFallback so
// both guards apply. A regression test greps for direct api.telegram.org calls.
const REACTIVE_KINDS = new Set([
  'reply', // reactive answer to a ExampleCo-initiated Telegram message
]);

const ALLOWED_KINDS = new Set([
  'security', // PII / security / reputation alert (push, not pull)
  'pii',
  'reputation-risk',
  'video-ready', // upload confirmed complete, link available
  'voice-followup', // post-call Amy follow-up, one message
  'principal-dispatch', // authenticated PRIVATE_NAME #Amy intake, one message per dispatch task
  // The once-daily briefing dashboard LINK (never a summary). The sender
  // (scripts/lib/briefing-notify.js) dedupes one message per publish state per
  // day via a marker file, so this cannot become morning spam.
  'briefing-link',
  // Briefing genuinely blocked after the post-publish repair window. The
  // initial 5:30 state uses briefing-link and says work is ongoing; only the
  // terminal notifier after the healer may use this kind.
  'briefing-blocked',
  // A ExampleCo "Done" button starts one scoped refresh. The human-action token is
  // also its dedup key, so only one terminal completion message is allowed.
  'briefing-card-refresh',
  // Laptop-hosted channel offline for more than the CT-daytime threshold
  // (scripts/lib/channel-health-monitor.js, 2026-07-12 flap fix). Ordinary
  // laptop sleep flaps never send; only a genuine multi-daytime-hour outage
  // does, and the monitor rate-limits it. The matching all-clear
  // ('laptop-offline-recovered') is only ever sent after a breach note, so it
  // cannot become flap noise.
  'laptop-offline-breach',
  'laptop-offline-recovered',
  // Overnight pipeline system alert from the deterministic EC2 night
  // supervisor (scripts/night-supervisor.js; ExampleCo approval 2026-08-02,
  // overnight watcher automation). Short plain-English alert when the 11 PM
  // briefing build never launched, stalled, the overnight watcher heartbeat
  // died, or the 5:31 AM delivery record is missing. The sender dedupes ONE
  // alert per class per night via its per-night state file plus a per-class
  // dedupKey here, so this cannot become overnight spam.
  'overnight-supervisor-alert',
]);

function telegramKindAllowed(
  kind,
  { reactive = false, reactiveOrigin = '', reactiveSessionId = '' } = {},
) {
  const k = String(kind || '');
  if (
    reactive === true &&
    String(reactiveOrigin || '').toLowerCase() === 'telegram' &&
    String(reactiveSessionId || '').startsWith('telegram:') &&
    REACTIVE_KINDS.has(k)
  ) {
    return true;
  }
  return ALLOWED_KINDS.has(k);
}

function appendJsonl(filePath, obj) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, JSON.stringify(obj) + '\n');
  } catch (e) {
    console.warn(`[notify] could not append to ${filePath}: ${e.message}`);
  }
}

function sha256Text(text) {
  return crypto
    .createHash('sha256')
    .update(String(text || ''))
    .digest('hex');
}

// Capability URLs are useful in the live Telegram message but must never be
// copied into durable fallback/suppression ledgers. Keep enough safe context
// for Codex to explain the failed delivery and bind it to the original text by
// hash, while removing the `k` query capability itself.
function persistentTelegramText(text) {
  const original = String(text || '');
  const redacted = original.replace(
    /([?&](?:k|access_token|token|auth|secret|key|sig|signature)=)[^&\s]+/gi,
    '$1[redacted]',
  );
  return {
    text: redacted,
    textHash: sha256Text(original),
    textRedacted: redacted !== original,
  };
}

function recordSuccessfulDelivery({
  source = 'unknown',
  priority = 'normal',
  kind,
  dedupKey,
  reactive = false,
  reactiveOrigin = '',
  reactiveSessionId = '',
  result = {},
  text = '',
} = {}) {
  const persisted = persistentTelegramText(text);
  const row = {
    ts: new Date().toISOString(),
    source,
    priority,
    kind,
    dedupKey: dedupKey || null,
    reactive: reactive === true,
    reactiveOrigin: reactive === true ? String(reactiveOrigin || '') || null : null,
    reactiveSessionId: reactive === true ? String(reactiveSessionId || '') || null : null,
    messageId: Number(result.messageId) || null,
    statusCode: Number(result.statusCode) || null,
    requestTextHash: result.requestTextHash || sha256Text(text),
    responseTextHash: result.responseTextHash || null,
    textMatchesRequest: result.textMatchesRequest === true,
    linkEntityCount: Number(result.linkEntityCount) || 0,
    linkEntityTypes: Array.isArray(result.linkEntityTypes) ? result.linkEntityTypes : [],
    head: persisted.text.slice(0, 200),
    ...(persisted.textRedacted ? { textHash: persisted.textHash, textRedacted: true } : {}),
  };
  appendJsonl(DELIVERED_PATH, row);
  return row;
}

function buildTelegramMessageBody({ chatId, text, parseMode = 'Markdown' }) {
  const payload = { chat_id: chatId, text };
  if (parseMode) payload.parse_mode = parseMode;
  return JSON.stringify(payload);
}

function telegramResponseReceipt({ statusCode, body, text } = {}) {
  const code = Number(statusCode);
  const requestTextHash = sha256Text(text);
  let payload = null;
  try {
    payload = JSON.parse(String(body || ''));
  } catch {
    return { ok: false, statusCode: code, reason: 'invalid_json_response', requestTextHash };
  }
  if (code < 200 || code >= 300 || payload?.ok !== true) {
    return {
      ok: false,
      statusCode: code,
      reason: payload?.description ? 'telegram_rejected' : `http_${code}`,
      requestTextHash,
    };
  }
  const messageId = Number(payload?.result?.message_id);
  const responseText = typeof payload?.result?.text === 'string' ? payload.result.text : null;
  const responseTextHash = responseText === null ? null : sha256Text(responseText);
  const textMatchesRequest = responseText !== null && responseText === String(text || '');
  const linkEntities = (Array.isArray(payload?.result?.entities) ? payload.result.entities : [])
    .filter((entity) => entity && (entity.type === 'url' || entity.type === 'text_link'))
    .map((entity) => String(entity.type));
  if (!Number.isInteger(messageId) || messageId <= 0) {
    return {
      ok: false,
      statusCode: code,
      reason: 'telegram_response_unverified',
      messageId: null,
      requestTextHash,
      responseTextHash,
      textMatchesRequest,
      linkEntityCount: linkEntities.length,
      linkEntityTypes: linkEntities,
    };
  }
  // Telegram may return parsed text for Markdown callers (for example,
  // request `*Ready*`, response `Ready`). API acceptance plus message_id is a
  // successful generic send, so do not retry it. The raw briefing caller binds
  // exact response text and URL entities in its stricter transport validator.
  return {
    ok: true,
    statusCode: code,
    messageId,
    requestTextHash,
    responseTextHash,
    textMatchesRequest,
    linkEntityCount: linkEntities.length,
    linkEntityTypes: linkEntities,
  };
}

function sendTelegramOnce({ token, chatId, text, timeoutMs = 10000, parseMode = 'Markdown' }) {
  return new Promise((resolve) => {
    if (!token || !chatId) return resolve({ ok: false, reason: 'missing_token_or_chat' });
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const body = buildTelegramMessageBody({ chatId, text, parseMode });
    const req = https.request(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: timeoutMs,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          const receipt = telegramResponseReceipt({
            statusCode: res.statusCode,
            body: data,
            text,
          });
          if (!receipt.ok) {
            const safeBody = persistentTelegramText(data.slice(0, 240)).text;
            return resolve({ ...receipt, body: safeBody });
          }
          return resolve(receipt);
        });
      },
    );
    req.on('error', (err) => resolve({ ok: false, reason: 'request_error', error: err.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, reason: 'timeout' });
    });
    req.write(body);
    req.end();
  });
}

// Public: notify with fallback. Tries Telegram (up to 2 attempts with
// short backoff). If both fail, writes to the Codex fallback dispatch
// log AND the failed-deliveries log so the daily briefing can summarize it.
async function notifyWithFallback({
  text,
  source = 'unknown',
  priority = 'normal',
  kind,
  token: tokenOverride,
  chatId: chatIdOverride,
  dedup = true,
  dedupKey,
  reactive = false,
  reactiveOrigin = '',
  reactiveSessionId = '',
  raw = false,
} = {}) {
  if (!text || typeof text !== 'string') {
    throw new Error('notifyWithFallback: text is required');
  }
  // Guard 1 (universal): scrub raw upstream error strings so they can never
  // reach Telegram regardless of kind. Suppress and log to internal receipts
  // only; dashboard and briefing surfaces get executive summaries.
  if (containsRawOperationalLeak(text)) {
    const persisted = persistentTelegramText(text);
    console.warn(
      '[notify] suppressed upstream-error leak (raw-error-leak):',
      persisted.text.slice(0, 160),
    );
    appendJsonl(SUPPRESSED_PATH, {
      ts: new Date().toISOString(),
      source,
      kind,
      reason: 'raw-error-leak',
      head: persisted.text.slice(0, 200),
      ...(persisted.textRedacted ? { textHash: persisted.textHash, textRedacted: true } : {}),
    });
    return { ok: true, suppressed: true, reason: 'raw-error-leak' };
  }
  // Guard 2 (policy): only the approved kinds may proactively send. Health
  // summaries, scan-complete, briefing summaries, and activity logs are
  // suppressed and logged internally, never pushed to ExampleCo's pocket.
  if (!telegramKindAllowed(kind, { reactive, reactiveOrigin, reactiveSessionId })) {
    const persisted = persistentTelegramText(text);
    console.log(
      '[notify] suppressed by telegram policy (kind not allowed):',
      kind,
      '|',
      persisted.text.slice(0, 80),
    );
    appendJsonl(SUPPRESSED_PATH, {
      ts: new Date().toISOString(),
      source,
      kind,
      reason: 'policy-kind-not-allowed',
      reactive: reactive === true,
      reactiveOrigin: reactive === true ? String(reactiveOrigin || '') || null : null,
      reactiveSessionId: reactive === true ? String(reactiveSessionId || '') || null : null,
      head: persisted.text.slice(0, 200),
      ...(persisted.textRedacted ? { textHash: persisted.textHash, textRedacted: true } : {}),
    });
    return { ok: true, suppressed: true, reason: `policy-${kind}` };
  }
  // Guard 3 (anti-spam): the egress owns "did we already tell ExampleCo this?".
  // Dedup state lives in a ledger no upstream artifact can reset, so a reboot or
  // a manifest rewrite cannot re-send the same notification. This is the root
  // cause of the recurring http404 / video-ready spam: the dedup flag lived in
  // the video manifest, which the regen pipeline kept wiping. Opt out with
  // dedup:false for messages that are intentionally repeatable.
  if (dedup !== false && shouldSuppressDuplicate({ kind, key: dedupKey, text })) {
    const persisted = persistentTelegramText(text);
    console.log(
      '[notify] suppressed duplicate notification:',
      kind,
      '|',
      persisted.text.slice(0, 60),
    );
    appendJsonl(SUPPRESSED_PATH, {
      ts: new Date().toISOString(),
      source,
      kind,
      reason: 'duplicate-within-window',
      head: persisted.text.slice(0, 200),
      ...(persisted.textRedacted ? { textHash: persisted.textHash, textRedacted: true } : {}),
    });
    return { ok: true, suppressed: true, reason: 'duplicate-within-window' };
  }
  const token = tokenOverride || process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN || '';
  const chatId = chatIdOverride || process.env.TELEGRAM_CHAT_ID || process.env.ExampleCo_CHAT_ID || '';
  const attempts = [];
  for (let i = 0; i < 2; i++) {
    const result = await sendTelegramOnce({
      token,
      chatId,
      text,
      parseMode: raw ? null : 'Markdown',
    });
    attempts.push({ attempt: i + 1, ...result });
    if (result.ok) {
      recordSuccessfulDelivery({
        source,
        priority,
        kind,
        dedupKey,
        reactive,
        reactiveOrigin,
        reactiveSessionId,
        result,
        text,
      });
      if (dedup !== false) recordNotification({ kind, key: dedupKey, text });
      return { ok: true, channel: 'telegram', attempts };
    }
    if (i === 0) await new Promise((r) => setTimeout(r, 1500));
  }
  // Telegram failed. Drop to fallback channels.
  const ts = new Date().toISOString();
  const persisted = persistentTelegramText(text);
  const persistenceProof = persisted.textRedacted
    ? { textHash: persisted.textHash, textRedacted: true }
    : {};
  const failureRecord = {
    ts,
    source,
    priority,
    text: persisted.text,
    ...persistenceProof,
    telegramAttempts: attempts,
  };
  appendJsonl(FAILED_PATH, failureRecord);
  appendJsonl(CODEX_DISPATCH_PATH, {
    ts,
    source,
    priority,
    title: `Telegram fallback from ${source}`,
    text: persisted.text,
    ...persistenceProof,
    needs_codex_surfacing: true,
    telegram_last_error:
      attempts[attempts.length - 1] &&
      (attempts[attempts.length - 1].reason || `http_${attempts[attempts.length - 1].statusCode}`),
  });
  console.warn(
    `[notify] Telegram failed after ${attempts.length} attempts (reason: ${attempts[attempts.length - 1].reason}); routed to Codex fallback + failed-deliveries log`,
  );
  return {
    ok: true,
    channel: 'fallback',
    attempts,
    fallbackPaths: [FAILED_PATH, CODEX_DISPATCH_PATH],
  };
}

module.exports = {
  notifyWithFallback,
  sendTelegramOnce,
  buildTelegramMessageBody,
  telegramResponseReceipt,
  persistentTelegramText,
  recordSuccessfulDelivery,
  telegramKindAllowed,
  ALLOWED_KINDS,
  loadDotEnvIfPresent,
};
