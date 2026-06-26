'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const GENERIC_WORDS = new Set([
  'a',
  'about',
  'active',
  'an',
  'and',
  'any',
  'can',
  'check',
  'checking',
  'current',
  'did',
  'do',
  'does',
  'for',
  'going',
  'how',
  'is',
  'it',
  'latest',
  'me',
  'on',
  'one',
  'please',
  'progress',
  'recent',
  'session',
  'sessions',
  'status',
  'task',
  'tasks',
  'that',
  'the',
  'thing',
  'this',
  'what',
  'you',
]);

function defaultRecentOwnerContextPath() {
  if (process.env.VAPI_RECENT_OWNER_CONTEXT_PATH) return process.env.VAPI_RECENT_OWNER_CONTEXT_PATH;
  if (fs.existsSync('/opt/secondbrain/data/agent')) {
    return '/opt/secondbrain/data/agent/vapi-recent-owner-context.jsonl';
  }
  return path.join(path.resolve(__dirname, '..', '..'), 'data', 'agent', 'vapi-recent-owner-context.jsonl');
}

function normalizeText(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function userTranscriptLines(transcript) {
  return String(transcript || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^User:\s*/i.test(line))
    .map((line) => line.replace(/^User:\s*/i, '').trim())
    .filter(Boolean);
}

function cleanupTopic(value) {
  const words = normalizeText(value)
    .split(/\s+/)
    .filter((word) => word && !GENERIC_WORDS.has(word));
  return words.join(' ').trim();
}

function usefulTopic(value) {
  const cleaned = cleanupTopic(value);
  if (!cleaned) return '';
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length < 2) return '';
  return words.slice(0, 8).join(' ');
}

function extractTopicHintsFromTranscript(transcript, summary = '') {
  const candidates = [];
  const sources = [...userTranscriptLines(transcript), String(summary || '')].filter(Boolean);
  const patterns = [
    /\bhow(?:'s| is)\s+(?:the\s+)?(.+?)\s+(?:session|task)\b/i,
    /\b(?:status|progress)\s+(?:of|on|for)\s+(?:the\s+)?(.+?)\s+(?:session|task)\b/i,
    /\b(?:check|checking)\s+(?:on|into|for)?\s*(?:the\s+)?(.+?)\s+(?:session|task)\b/i,
    /\b(?:session|task)\s+(?:for|about|called|named)\s+(.+?)(?:[?.!,]|$)/i,
  ];

  for (const source of sources) {
    for (const pattern of patterns) {
      const match = String(source).match(pattern);
      if (match) candidates.push(match[1]);
    }
  }

  const seen = new Set();
  const hints = [];
  for (const candidate of candidates) {
    const topic = usefulTopic(candidate);
    if (!topic || seen.has(topic)) continue;
    seen.add(topic);
    hints.push(topic);
  }
  return hints.slice(0, 5);
}

function appendRecentOwnerCallContext(call = {}, opts = {}) {
  const contextPath = opts.contextPath || defaultRecentOwnerContextPath();
  const hints = extractTopicHintsFromTranscript(call.transcript, call.summary);
  if (!hints.length) return { written: false, hints: [] };
  const row = {
    ts: typeof opts.nowIso === 'function' ? opts.nowIso() : new Date().toISOString(),
    callId: call.callId || call.id || '',
    customer: call.customer || '',
    startedAt: call.startedAt || '',
    hints,
    summary: String(call.summary || '').replace(/\s+/g, ' ').trim().slice(0, 240),
    source: 'vapi-end-of-call',
  };
  fs.mkdirSync(path.dirname(contextPath), { recursive: true });
  fs.appendFileSync(contextPath, JSON.stringify(row) + '\n', 'utf8');
  return { written: true, row, hints, contextPath };
}

function readRecentOwnerCallContext(opts = {}) {
  const contextPath = opts.contextPath || defaultRecentOwnerContextPath();
  const nowMs = Number(opts.nowMs) || Date.now();
  const maxAgeMs = Number(opts.maxAgeMs) || DEFAULT_MAX_AGE_MS;
  if (!fs.existsSync(contextPath)) return [];
  const rows = [];
  const raw = fs.readFileSync(contextPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed);
      const ts = Date.parse(row.startedAt || row.ts || '');
      if (!Number.isFinite(ts) || nowMs - ts > maxAgeMs) continue;
      if (!Array.isArray(row.hints) || row.hints.length === 0) continue;
      rows.push(row);
    } catch {
      /* skip bad rows */
    }
  }
  return rows.sort(
    (a, b) => (Date.parse(b.startedAt || b.ts || '') || 0) - (Date.parse(a.startedAt || a.ts || '') || 0),
  );
}

function isVagueOwnerFollowupQuery(query) {
  const terms = normalizeText(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return false;
  const allowed = new Set([
    ...GENERIC_WORDS,
    'look',
    'lookup',
    'up',
    'see',
    'tell',
    'update',
    'where',
    'with',
  ]);
  return terms.every((term) => allowed.has(term));
}

function resolveVagueSpineQuery(query, opts = {}) {
  if (!isVagueOwnerFollowupQuery(query)) return { query: String(query || '').trim(), resolved: false };
  const recent = opts.recentRows || readRecentOwnerCallContext(opts);
  for (const row of recent) {
    const hint = Array.isArray(row.hints) && row.hints.find((x) => usefulTopic(x));
    if (!hint) continue;
    return {
      query: hint,
      resolved: true,
      sourceCallId: row.callId || '',
      sourceStartedAt: row.startedAt || row.ts || '',
    };
  }
  return { query: String(query || '').trim(), resolved: false };
}

function formatRecentOwnerContext(rows = [], maxItems = 3) {
  const lines = [];
  for (const row of rows.slice(0, maxItems)) {
    const hint = Array.isArray(row.hints) && row.hints[0] ? row.hints[0] : '';
    if (!hint) continue;
    lines.push(`- Recent owner call topic: ${hint}${row.startedAt ? ` (${row.startedAt})` : ''}`);
  }
  return lines.length ? ['## Recent Owner Call Context', ...lines].join('\n') : '';
}

module.exports = {
  appendRecentOwnerCallContext,
  cleanupTopic,
  defaultRecentOwnerContextPath,
  extractTopicHintsFromTranscript,
  formatRecentOwnerContext,
  isVagueOwnerFollowupQuery,
  readRecentOwnerCallContext,
  resolveVagueSpineQuery,
};
