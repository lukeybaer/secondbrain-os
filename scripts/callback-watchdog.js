#!/usr/bin/env node
'use strict';

const http = require('http');
const https = require('https');

const {
  buildCallbackMessage,
  claimCallback,
  recordCallbackAttempt,
  scanCallbackDueTasks,
} = require('./lib/voice-cloud-runtime');

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

async function runOnce(opts = {}) {
  const due = scanCallbackDueTasks(opts);
  const results = [];
  for (const item of due) {
    if (opts.dryRun) {
      const message = buildCallbackMessage(item.task, item.reason);
      results.push({ taskId: item.task.id, reason: item.reason, dryRun: true, message });
      continue;
    }
    const claimed = claimCallback(item.task.id, item.reason, opts);
    if (!claimed) {
      results.push({ taskId: item.task.id, reason: item.reason, status: 'skipped_claimed' });
      continue;
    }
    const message = buildCallbackMessage(claimed.task, claimed.reason);
    const deliver = opts.deliverCallback || defaultDeliverCallback;
    let delivered;
    try {
      delivered = await deliver({ task: claimed.task, reason: claimed.reason, message }, opts);
    } catch (e) {
      delivered = { ok: false, status: 0, error: e.message || String(e) };
    }
    if (delivered && delivered.ok) {
      const providerCallId = delivered.body && delivered.body.result && delivered.body.result.id;
      recordCallbackAttempt(
        claimed.task.id,
        { status: 'delivered', providerCallId, message, leaseId: claimed.leaseId },
        opts,
      );
      results.push({ taskId: claimed.task.id, reason: claimed.reason, status: 'delivered' });
    } else {
      const error = delivered && (delivered.error || delivered.raw || `HTTP ${delivered.status}`);
      const updated = recordCallbackAttempt(
        claimed.task.id,
        { status: 'failed', error: error || 'callback delivery failed', message, leaseId: claimed.leaseId },
        opts,
      );
      if (updated && updated.callback && updated.callback.deadLetterAt) {
        await notifyCallbackDeadLetter(updated, error, opts);
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
  notifyCallbackDeadLetter,
  postJson,
  runOnce,
};
