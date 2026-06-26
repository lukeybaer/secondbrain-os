#!/usr/bin/env node
// flow-router.js
//
// Event-driven flow orchestration between scheduled tasks. Today many
// scheduled-task transitions are hardcoded ("when video-aurora rejects,
// auto-regen calls this script"). That hardcoded chain breaks the moment a
// new consumer wants the same event, and it forces every upstream task to
// know about every downstream consumer.
//
// flow-router decouples that: upstream tasks emit flow events to a single
// jsonl, and downstream tasks declare `subscribes:` in their SKILL.md
// frontmatter. The router matches events to subscribers and dispatches.
//
// Pattern sources (deep-dived 2026-05-23 nightly research):
//   - LangGraph Send fan-out (langchain-ai/langgraph 1.0 2026-04): one
//     producer sends typed events; the graph dispatches to any number of
//     interested consumers without explicit edges. We adapt to scheduled
//     tasks: each subscriber receives a dispatch entry instead of a graph
//     edge invocation.
//   - Mastra workflow event triggers (mastra-ai/mastra 2026-04 0.5.x):
//     trigger.after('captions-aurora') style subscriptions declared on
//     the workflow itself, not by the publisher.
//   - n8n trigger node pattern: subscribers self-register with the
//     orchestrator at startup; the orchestrator owns the routing table.
//
// Storage:
//   Input    : data/agent/flow-events.jsonl
//              (each line: { id, event, status, payload?, timestamp })
//   Output   : data/agent/flow-dispatch.jsonl
//              (each line: { id, event_id, subscriber, dispatched_at })
//   Cursor   : data/agent/flow-router-cursor.json
//              (last_event_id, so re-runs are idempotent)
//
// Subscriptions live in scheduled-tasks/<name>/SKILL.md frontmatter:
//
//     ---
//     subscribes:
//       - captions-aurora.completed:rejected
//       - video-aurora.*:rejected
//     ---
//
// Matching: literal segments must match; `*` matches a single segment.
// Pattern `video-aurora.*:rejected` matches `video-aurora.completed:rejected`
// but not `video-aurora.completed.foo:rejected`.
//
// Pure module. All paths come from env or function args.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO = process.env.SECONDBRAIN_ROOT || path.join(__dirname, '..');

// Helpers

function readJsonl(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8');
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { out.push(JSON.parse(trimmed)); } catch { /* skip malformed */ }
  }
  return out;
}

function appendJsonl(filePath, record) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(record) + '\n');
}

function readJson(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function safeName(n) {
  return /^[a-z0-9_-]+$/i.test(n);
}

// Build an event name from event + status, e.g. "captions-aurora.completed:rejected"
function buildEventName(event) {
  if (!event) return '';
  if (typeof event === 'string') return event;
  const base = event.event || event.name || '';
  const status = event.status ? `:${event.status}` : '';
  return `${base}${status}`;
}

// Subscription parsing

// Returns an array of subscription patterns from a SKILL.md frontmatter
// block. Supports YAML-list syntax:
//
//     subscribes:
//       - foo.bar:rejected
//       - quux.*:done
function parseSubscriptions(skillMdContent) {
  if (!skillMdContent) return [];
  const m = skillMdContent.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return [];
  const frontmatter = m[1];
  const lines = frontmatter.split(/\r?\n/);
  let inSubscribes = false;
  const patterns = [];
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (/^subscribes\s*:\s*$/.test(line)) {
      inSubscribes = true;
      continue;
    }
    if (inSubscribes) {
      // dash item under the subscribes block
      const dash = line.match(/^\s+-\s+(.+)\s*$/);
      if (dash) {
        const val = dash[1].replace(/^['"]|['"]$/g, '').trim();
        if (val) patterns.push(val);
        continue;
      }
      // exit subscribes block on first non-indented key or empty
      if (/^[A-Za-z_]/.test(line)) inSubscribes = false;
    }
  }
  return patterns;
}

// Pattern matching: literal segments separated by `.` and `:`. `*` matches
// one segment, `**` matches the remainder.
function compilePattern(pattern) {
  // Split by both `.` and `:` while keeping the delimiters as part of the
  // regex literal between groups.
  const escaped = pattern
    .split('')
    .map((ch) => {
      if (ch === '*') return ch; // handle below
      if (ch === '.') return '\\.';
      if (ch === ':') return ':';
      return ch.replace(/[\\^$+?()|[\]{}]/g, '\\$&');
    })
    .join('');
  // Replace `**` first (multi-segment), then `*` (single-segment).
  const regex = escaped
    .replace(/\*\*/g, '.+')
    .replace(/\*/g, '[^.:]+');
  return new RegExp(`^${regex}$`);
}

function matchPattern(pattern, eventName) {
  return compilePattern(pattern).test(eventName);
}

// Load subscribers

function loadSubscribers(scheduledTasksDir) {
  if (!fs.existsSync(scheduledTasksDir)) return [];
  const out = [];
  for (const dirent of fs.readdirSync(scheduledTasksDir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    if (!safeName(dirent.name)) continue;
    const skillPath = path.join(scheduledTasksDir, dirent.name, 'SKILL.md');
    if (!fs.existsSync(skillPath)) continue;
    const content = fs.readFileSync(skillPath, 'utf8');
    const patterns = parseSubscriptions(content);
    if (!patterns.length) continue;
    out.push({ name: dirent.name, patterns });
  }
  return out;
}

// Match each event to its subscribers

function matchEvent(event, subscribers) {
  const name = buildEventName(event);
  const matched = [];
  for (const sub of subscribers) {
    for (const pat of sub.patterns) {
      if (matchPattern(pat, name)) {
        matched.push({ subscriber: sub.name, pattern: pat });
        break; // one match per subscriber is enough
      }
    }
  }
  return matched;
}

function eventId(event) {
  if (event && event.id) return String(event.id);
  const seed = JSON.stringify({
    e: buildEventName(event),
    p: event && event.payload,
    t: event && event.timestamp,
  });
  return crypto.createHash('sha256').update(seed).digest('hex').slice(0, 16);
}

// Top-level route

function route(opts = {}) {
  const root = opts.root || REPO;
  const eventsPath = opts.eventsPath || path.join(root, 'data', 'agent', 'flow-events.jsonl');
  const dispatchPath = opts.dispatchPath || path.join(root, 'data', 'agent', 'flow-dispatch.jsonl');
  const cursorPath = opts.cursorPath || path.join(root, 'data', 'agent', 'flow-router-cursor.json');
  const scheduledTasksDir = opts.scheduledTasksDir || path.join(root, 'scheduled-tasks');

  const subscribers = opts.subscribers || loadSubscribers(scheduledTasksDir);
  const events = opts.events || readJsonl(eventsPath);

  const cursor = readJson(cursorPath, { last_event_id: null }) || { last_event_id: null };
  const seenIds = new Set(); // also dedupes inside a single run
  let startIdx = 0;
  if (cursor.last_event_id) {
    const idx = events.findIndex((e) => eventId(e) === cursor.last_event_id);
    if (idx >= 0) startIdx = idx + 1;
  }

  const dispatched = [];
  let lastId = cursor.last_event_id;
  for (let i = startIdx; i < events.length; i++) {
    const ev = events[i];
    const id = eventId(ev);
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    const matches = matchEvent(ev, subscribers);
    const dispatchedAt = (opts.now ? opts.now() : new Date()).toISOString();
    for (const m of matches) {
      const entry = {
        id: crypto.createHash('sha256').update(`${id}:${m.subscriber}`).digest('hex').slice(0, 16),
        event_id: id,
        event: buildEventName(ev),
        subscriber: m.subscriber,
        pattern: m.pattern,
        dispatched_at: dispatchedAt,
      };
      appendJsonl(dispatchPath, entry);
      dispatched.push(entry);
    }
    lastId = id;
  }

  writeJson(cursorPath, { last_event_id: lastId, updated_at: (opts.now ? opts.now() : new Date()).toISOString() });
  return { dispatched, subscribers, cursor: { last_event_id: lastId } };
}

// Convenience for upstream tasks that want to emit an event.
function emit(eventData, opts = {}) {
  const root = opts.root || REPO;
  const eventsPath = opts.eventsPath || path.join(root, 'data', 'agent', 'flow-events.jsonl');
  const enriched = {
    timestamp: (opts.now ? opts.now() : new Date()).toISOString(),
    ...eventData,
  };
  appendJsonl(eventsPath, enriched);
  return enriched;
}

module.exports = {
  parseSubscriptions,
  compilePattern,
  matchPattern,
  buildEventName,
  eventId,
  loadSubscribers,
  matchEvent,
  route,
  emit,
};

// CLI
if (require.main === module) {
  const result = route();
  process.stdout.write(
    JSON.stringify(
      {
        dispatched: result.dispatched.length,
        subscribers: result.subscribers.length,
        cursor: result.cursor,
      },
      null,
      2
    ) + '\n'
  );
}
