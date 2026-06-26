'use strict';

// Egress-owned notification dedup.
//
// Root cause of the recurring "http404 / video-ready" Telegram spam (reported
// by ExampleCo ~50 times): the dedup state was stored as `telegram_notified_at`
// INSIDE the video approval manifest (ec2-server.js notifyNewlyPendingVideos).
// The overnight regen pipeline and boot scans rewrite that manifest, wiping the
// flag, so every reboot / scan re-notified the SAME artifact. Reboots were
// themselves triggered by a false health alarm (the /health proxy probe), so
// the same "video ready" message with a 404-ing briefing link went out 6+ times.
//
// The category bug: dedup state that lives in a mutable artifact owned by a
// DIFFERENT subsystem is not dedup at all. Whoever rewrites the artifact resets
// the memory. The fix is to make "have we already told ExampleCo about this?" a
// property of the EGRESS, recorded in an append-only ledger that no upstream
// writer touches, keyed by (kind, key) with a re-alert window.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000; // re-alert at most once per 24h

function defaultLedgerPath(env = process.env) {
  if (env.NOTIFICATION_DEDUP_LEDGER) return env.NOTIFICATION_DEDUP_LEDGER;
  if (env.SECONDBRAIN_DATA_DIR) {
    return path.join(env.SECONDBRAIN_DATA_DIR, 'agent', 'notification-dedup.jsonl');
  }
  if (process.platform === 'linux' && fs.existsSync('/opt/secondbrain')) {
    return '/opt/secondbrain/data/agent/notification-dedup.jsonl';
  }
  const appData = env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'secondbrain', 'data', 'agent', 'notification-dedup.jsonl');
}

// Stable key for a notification. Prefer an explicit artifact key (e.g. a video
// id); fall back to a hash of the message text so identical proactive messages
// collapse even without an id.
function dedupKey({ kind, key, text } = {}) {
  const k = String(kind || 'reply').trim() || 'reply';
  const explicit = key != null && String(key).trim();
  const id = explicit
    ? String(key).trim()
    : 'sha:' +
      crypto
        .createHash('sha256')
        .update(String(text || ''))
        .digest('hex')
        .slice(0, 16);
  return k + '|' + id;
}

function readLedger(ledgerPath) {
  if (!fs.existsSync(ledgerPath)) return [];
  return fs
    .readFileSync(ledgerPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function lastSentAt(rows, key) {
  let last = 0;
  for (const row of rows || []) {
    if (row.key !== key) continue;
    const t = Date.parse(row.ts);
    if (Number.isFinite(t) && t > last) last = t;
  }
  return last;
}

// True if this (kind,key) was already notified within the window. The ledger is
// the ONLY source of truth, so resetting any upstream artifact cannot revive a
// suppressed notification.
function shouldSuppressDuplicate(input = {}, opts = {}) {
  const windowMs = Number.isFinite(opts.windowMs) ? opts.windowMs : DEFAULT_WINDOW_MS;
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const rows =
    opts.rows || readLedger(opts.ledgerPath || defaultLedgerPath(opts.env || process.env));
  const last = lastSentAt(rows, dedupKey(input));
  return last > 0 && now - last < windowMs;
}

// Past this many lines, recordNotification compacts the ledger (drops entries
// older than retention, atomic rewrite) instead of appending. Bounds the file
// so readLedger on the hot Telegram path can never grow into an event-loop
// stall over months of operation (Codex review B-MAJOR).
const COMPACT_THRESHOLD = 500;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function recordNotification(input = {}, opts = {}) {
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const retentionMs = Number.isFinite(opts.retentionMs) ? opts.retentionMs : RETENTION_MS;
  const threshold = Number.isFinite(opts.compactThreshold)
    ? opts.compactThreshold
    : COMPACT_THRESHOLD;
  const ledgerPath = opts.ledgerPath || defaultLedgerPath(opts.env || process.env);
  const row = {
    ts: new Date(now).toISOString(),
    key: dedupKey(input),
    kind: String(input.kind || 'reply'),
  };
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  const existing = readLedger(ledgerPath);
  if (existing.length >= threshold) {
    const kept = existing.filter((r) => {
      const t = Date.parse(r.ts);
      return Number.isFinite(t) && now - t < retentionMs;
    });
    kept.push(row);
    const tmp = ledgerPath + '.tmp';
    fs.writeFileSync(tmp, kept.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    fs.renameSync(tmp, ledgerPath);
  } else {
    fs.appendFileSync(ledgerPath, JSON.stringify(row) + '\n', 'utf8');
  }
  return row;
}

module.exports = {
  DEFAULT_WINDOW_MS,
  defaultLedgerPath,
  dedupKey,
  shouldSuppressDuplicate,
  recordNotification,
};
