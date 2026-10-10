#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const http = require('http');
const https = require('https');

const {
  buildCallbackMessage,
  claimCallback,
  recordCallbackAttempt,
  releaseCallbackFileLock,
  scanCallbackDueTasks,
} = require('./lib/voice-cloud-runtime');
const { readOutboundCallAdmission, defaultDataDir } = require('./lib/outbound-call-control');

function postJson(url, body, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      resolve({ ok: false, status: 0, error: e.message });
      return;
    }
    const payload = Buffer.from(JSON.stringify(body));
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      u,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
        timeout: timeoutMs,
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = raw ? JSON.parse(raw) : null;
          } catch {
            parsed = null;
          }
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: parsed, raw });
        });
      },
    );
    req.on('error', (e) => resolve({ ok: false, status: 0, error: e.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, status: 0, error: 'timeout' });
    });
    req.write(payload);
    req.end();
  });
}

async function defaultDeliverCallback({ task, reason, message }, opts = {}) {
  const url = opts.outboundUrl || process.env.SB_VAPI_OUTBOUND_URL || 'http://127.0.0.1:3001/vapi/outbound';
  return postJson(url, { message, reason, taskId: task.id }, opts.timeoutMs || 15000);
}

async function notifyCallbackDeadLetter(task, error, opts = {}) {
  const notify =
    opts.notifyWithFallback ||
    ((payload) => {
      const { notifyWithFallback } = require('./lib/notify-with-fallback');
      return notifyWithFallback(payload);
    });
  const title = String(task.title || task.prompt || task.id || 'callback task').replace(/\s+/g, ' ').slice(0, 160);
  const detail = String(error || 'callback delivery failed').replace(/\s+/g, ' ').slice(0, 240);
  return notify({
    text: `Owner callback needs attention: ${title}. Callback attempts are exhausted. Last error: ${detail}`,
    source: 'callback-watchdog',
    priority: 'urgent',
    kind: 'voice-followup',
    dedupKey: `callback-dead-letter:${task.id}`,
  });
}

// Outbound calling is paused (owner stop, or the call surface changed since its
// last Amy-to-Amy proof). The result ExampleCo asked to hear must still reach him:
// send it once on Telegram and settle the callback, instead of skipping every
// minute in silence. Self-test work never notifies a person; it stays due
// until calling is admitted again. A stall notice is not a result and waits.
async function deliverPausedFallback(item, control, opts = {}) {
  const { task, reason } = item;
  if (task.meta?.selfTest === true) return 'skipped_outbound_paused';
  if (String(reason).startsWith('stalled:')) return 'skipped_outbound_paused';
  const claimed = claimCallback(task.id, reason, opts);
  if (!claimed) return 'skipped_claimed';
  const notify =
    opts.notifyWithFallback ||
    ((payload) => {
      const { notifyWithFallback } = require('./lib/notify-with-fallback');
      return notifyWithFallback(payload);
    });
  const message = buildCallbackMessage(claimed.task, claimed.reason).replace(
    'Amy here with the callback you asked for.',
    'you asked me to call with this, but outbound calling is paused, so here it is in writing.',
  );
  let sent = null;
  try {
    sent = await notify({
      text: message,
      source: 'callback-watchdog',
      priority: 'normal',
      kind: 'voice-followup',
      // Keyed to this exact result text, so a later different result for the
      // same Task (reopened, then finished or blocked again) is a new message.
      dedupKey: `callback-paused:${task.id}:${crypto.createHash('sha256').update(message).digest('hex').slice(0, 16)}`,
    });
  } catch (e) {
    sent = { ok: false, error: e.message || String(e) };
  }
  // Only a real Telegram delivery settles the callback. The notifier also
  // answers ok when it merely wrote its internal fallback files or suppressed
  // the text; neither reached ExampleCo, so the callback stays owed.
  // A duplicate-window suppression of this exact task-and-status key means the
  // message already went out (a prior tick sent it and stopped before
  // recording), so it settles too.
  const alreadySent = Boolean(sent && sent.suppressed && sent.reason === 'duplicate-within-window');
  const ok =
    alreadySent || Boolean(sent && sent.ok === true && sent.channel === 'telegram' && !sent.suppressed);
  if (ok) {
    recordCallbackAttempt(
      claimed.task.id,
      { status: 'delivered', channel: 'telegram_fallback', message, leaseId: claimed.leaseId },
      opts,
    );
    return 'delivered_telegram_fallback';
  }
  // Not delivered. Record no attempt: failed attempts dead-letter after three
  // and the callback would stop being owed with nothing sent. Releasing only
  // the lock leaves the claim to lapse, so it is retried after the lease and
  // still dials once calling is admitted again.
  releaseCallbackFileLock(claimed.task.id, claimed.leaseId, opts);
  return 'failed_telegram_fallback';
}

async function runOnce(opts = {}) {
  // readOutboundCallAdmission() falls through to readVoiceReleaseAdmission(),
  // whose proofPath() throws 'voice release proof requires dataDir or
  // proofPath' with no dataDir. That throw is unguarded here, so once
  // outbound calls left paused state this crashed every tick (817 restarts,
  // pm2 stopped). scanCallbackDueTasks/claimCallback/recordCallbackAttempt
  // already default internally when dataDir is missing; proofPath does not,
  // so every downstream call gets the same resolved dataDir explicitly.
  const runOpts = { ...opts, dataDir: opts.dataDir || defaultDataDir() };
  const due = scanCallbackDueTasks(runOpts);
  const results = [];
  const control = readOutboundCallAdmission(runOpts);
  if (control.mode === 'paused') {
    const pausedResults = [];
    for (const item of due) {
      pausedResults.push({
        taskId: item.task.id,
        reason: item.reason,
        status: runOpts.dryRun ? 'skipped_outbound_paused' : await deliverPausedFallback(item, control, runOpts),
      });
    }
    return { ok: true, checked: due.length, paused: true, reason: control.reason, results: pausedResults };
  }
  for (const item of due) {
    if (runOpts.dryRun) {
      const message = buildCallbackMessage(item.task, item.reason);
      results.push({ taskId: item.task.id, reason: item.reason, dryRun: true, message });
      continue;
    }
    const claimed = claimCallback(item.task.id, item.reason, runOpts);
    if (!claimed) {
      results.push({ taskId: item.task.id, reason: item.reason, status: 'skipped_claimed' });
      continue;
    }
    const message = buildCallbackMessage(claimed.task, claimed.reason);
    const deliver = runOpts.deliverCallback || defaultDeliverCallback;
    let delivered;
    try {
      delivered = await deliver({ task: claimed.task, reason: claimed.reason, message }, runOpts);
    } catch (e) {
      delivered = { ok: false, status: 0, error: e.message || String(e) };
    }
    // Delivered means the provider accepted the dial and returned a call id.
    const providerCallId =
      delivered && delivered.body && delivered.body.ok !== false && delivered.body.result
        ? delivered.body.result.id
        : null;
    if (delivered && delivered.ok && providerCallId) {
      recordCallbackAttempt(
        claimed.task.id,
        { status: 'delivered', providerCallId, message, leaseId: claimed.leaseId },
        runOpts,
      );
      results.push({ taskId: claimed.task.id, reason: claimed.reason, status: 'delivered' });
    } else {
      const error =
        delivered && (delivered.error || delivered.raw || (delivered.ok ? 'provider returned no call id' : `HTTP ${delivered.status}`));
      const updated = recordCallbackAttempt(
        claimed.task.id,
        { status: 'failed', error: error || 'callback delivery failed', message, leaseId: claimed.leaseId },
        runOpts,
      );
      if (updated && updated.callback && updated.callback.deadLetterAt) {
        await notifyCallbackDeadLetter(updated, error, runOpts);
      }
      results.push({ taskId: claimed.task.id, reason: claimed.reason, status: 'failed', error });
    }
  }
  return { ok: true, checked: due.length, results };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const once = process.argv.includes('--once') || dryRun;
  const intervalMs = Number(process.env.SB_CALLBACK_WATCHDOG_INTERVAL_MS || 60000);
  const tick = async () => {
    const result = await runOnce({ dryRun });
    console.log(JSON.stringify({ ts: new Date().toISOString(), ...result }));
  };
  await tick();
  if (!once) setInterval(tick, intervalMs);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e.stack || e.message);
    process.exit(1);
  });
}

module.exports = {
  defaultDeliverCallback,
  deliverPausedFallback,
  notifyCallbackDeadLetter,
  postJson,
  runOnce,
};
