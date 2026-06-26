// security-events.js
//
// Append-only security event ledger (E0 workstream A, 2026-06-11). Every
// rejected request on a hardened surface (briefing auth failure, dropped
// non-owner Telegram update, Vapi signature failure, denied voice tool)
// lands here as one JSONL row so the briefing security tile can summarize
// "who knocked on the door" instead of the rejections vanishing into stdout.
//
// Default path resolves relative to this file so it works both on the PC
// checkout (secondbrain/data/agent/...) and on EC2 (/opt/secondbrain/data/
// agent/...) without configuration.

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_PATH = path.resolve(__dirname, '..', '..', 'data', 'agent', 'security-events.jsonl');

// entry: { kind, ip?, chatId?, route?, reason?, ... }. Never throws: a broken
// audit trail must not take down the serving path it is auditing.
function appendSecurityEvent(entry, filePath = DEFAULT_PATH) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const row = { ts: new Date().toISOString(), ...(entry || {}) };
    fs.appendFileSync(filePath, JSON.stringify(row) + '\n');
    return true;
  } catch (e) {
    try {
      console.warn('[security-events] append failed:', e.message);
    } catch {
      /* nothing left to do */
    }
    return false;
  }
}

// Summary for the briefing security tile. sinceMs: only count events whose
// ts is at or after this epoch-ms cutoff (default: last 24h).
// Returns { total, byKind, topOffenders } where topOffenders is a sorted
// [{ key, count }] over ip/chatId (top 10).
function summarizeSecurityEvents(
  filePath = DEFAULT_PATH,
  sinceMs = Date.now() - 24 * 60 * 60 * 1000,
) {
  const summary = { total: 0, byKind: {}, topOffenders: [] };
  let raw = '';
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return summary; // no events yet
  }
  const offenders = new Map();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = Date.parse(ev.ts || '');
    if (Number.isFinite(sinceMs) && Number.isFinite(ts) && ts < sinceMs) continue;
    summary.total += 1;
    const kind = String(ev.kind || 'ExampleCo');
    summary.byKind[kind] = (summary.byKind[kind] || 0) + 1;
    const who = ev.ip || ev.chatId;
    if (who) {
      const key = String(who);
      offenders.set(key, (offenders.get(key) || 0) + 1);
    }
  }
  summary.topOffenders = [...offenders.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
  return summary;
}

module.exports = { appendSecurityEvent, summarizeSecurityEvents, DEFAULT_PATH };
