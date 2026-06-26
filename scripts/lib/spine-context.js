// spine-context.js
//
// E2 (Amy overhaul, 2026-06-12): Telegram prompts were spine-blind. Amy
// answered "what's the status" from memory-file vibes while the live task
// spine (the single durable Task store) sat unread. This module is the pure
// provider + formatter that puts ACTIVE WORK into every Telegram prompt and
// answers status questions deterministically (zero hallucination risk).
//
// Sources, in order of authority:
//  - tasksDir (SB_SPINE_DIR): post-Phase-3 the spine store lives where the
//    server runs; reads *.json task files directly.
//  - syncedData snapshot: the 15s POST /sync push from the Electron app
//    (projects / todos / tasks fields). Used until Phase 3 flips the env var.
//
// Pure-logic heavy: only createSpineProvider touches the filesystem, and only
// when tasksDir is provided. Everything else is string-in string-out.

const fs = require('node:fs');
const path = require('node:path');

const SPINE_BLOCK_MAX_CHARS = 1200;
const ACTIVE_TASK_STATUSES = ['queued', 'running', 'awaiting-review', 'requires-feedback'];

// Statuses that mean "this snapshot row is no longer active work".
const SNAPSHOT_DONE_RE = /\b(done|complete|completed|archived|cancelled|canceled|shipped)\b/i;

const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'but',
  'is',
  'are',
  'was',
  'were',
  'be',
  'to',
  'of',
  'in',
  'on',
  'at',
  'for',
  'with',
  'as',
  'by',
  'it',
  'this',
  'that',
  'i',
  'you',
  'we',
  'do',
  'did',
  'done',
  'can',
  'will',
  'so',
  'my',
  'me',
  'amy',
  'please',
  'thanks',
  'ok',
  'okay',
  'yes',
  'no',
  'how',
  'what',
  'when',
  'about',
  'your',
  'just',
  'now',
  'get',
  'got',
  'up',
  'out',
  'status',
]);

function tokens(text) {
  return (
    String(text || '')
      .toLowerCase()
      .match(/[a-z0-9]+/g) || []
  ).filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

// Fraction of needle tokens that appear (partial-word) in haystack text.
// Same matching idea as src/main/telegram-context.ts matchMessageContext.
function overlap(needleTokens, haystack) {
  if (!needleTokens.length) return 0;
  const hay = String(haystack || '').toLowerCase();
  let hits = 0;
  for (const t of needleTokens) {
    if (hay.includes(t)) hits++;
  }
  return hits / needleTokens.length;
}

function hoursSince(iso, now = Date.now()) {
  const ts = Date.parse(iso || '');
  if (!Number.isFinite(ts)) return null;
  return Math.max(0, Math.round((now - ts) / 36e5));
}

function normalizeItem({ title, status, ageHours, origin }) {
  return {
    title: String(title || '(untitled)')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 140),
    status: String(status || 'ExampleCo'),
    ageHours: Number.isFinite(ageHours) ? ageHours : null,
    origin: String(origin || 'spine'),
  };
}

// createSpineProvider({ syncedData, tasksDir })
//   syncedData: the snapshot object OR a () => snapshot getter (ec2-server.js
//   reassigns its snapshot on every /sync, so it passes a getter).
//   tasksDir: when set (SB_SPINE_DIR), read the task store directly.
function createSpineProvider({ syncedData, tasksDir } = {}) {
  function snapshot() {
    const s = typeof syncedData === 'function' ? syncedData() : syncedData;
    return s && typeof s === 'object' ? s : {};
  }

  function fromTasksDir(limit) {
    let files;
    try {
      files = fs.readdirSync(tasksDir).filter((f) => f.endsWith('.json'));
    } catch {
      return null; // dir unreadable: caller falls back to the snapshot
    }
    const items = [];
    for (const f of files) {
      let task;
      try {
        task = JSON.parse(fs.readFileSync(path.join(tasksDir, f), 'utf8'));
      } catch {
        continue;
      }
      if (!task || typeof task !== 'object') continue;
      const status = String(task.status || '').toLowerCase();
      if (!ACTIVE_TASK_STATUSES.includes(status)) continue;
      items.push({
        item: normalizeItem({
          title: task.title || task.prompt,
          status,
          ageHours: hoursSince(task.updatedAt || task.createdAt),
          origin: task.origin || task.source || 'spine',
        }),
        sortTs: Date.parse(task.updatedAt || task.createdAt || '') || 0,
      });
    }
    items.sort((a, b) => b.sortTs - a.sortTs);
    return items.slice(0, limit).map((x) => x.item);
  }

  function fromSnapshot(limit) {
    const s = snapshot();
    const items = [];
    for (const t of Array.isArray(s.tasks) ? s.tasks : []) {
      const status = String(t.status || '').toLowerCase();
      if (status && !ACTIVE_TASK_STATUSES.includes(status) && SNAPSHOT_DONE_RE.test(status))
        continue;
      if (status && SNAPSHOT_DONE_RE.test(status)) continue;
      items.push(
        normalizeItem({
          title: t.title || t.prompt,
          status: status || 'queued',
          ageHours: hoursSince(t.updatedAt || t.createdAt),
          origin: t.origin || 'task',
        }),
      );
    }
    for (const p of Array.isArray(s.projects) ? s.projects : []) {
      const status = String(p.status || 'active');
      if (SNAPSHOT_DONE_RE.test(status)) continue;
      items.push(
        normalizeItem({
          title: p.name || p.title,
          status,
          ageHours: hoursSince(p.updatedAt || p.createdAt),
          origin: 'project',
        }),
      );
    }
    for (const t of Array.isArray(s.todos) ? s.todos : []) {
      if (t.done === true || t.completed === true) continue;
      if (SNAPSHOT_DONE_RE.test(String(t.status || ''))) continue;
      items.push(
        normalizeItem({
          title: t.text || t.title || t.task,
          status: 'open',
          ageHours: hoursSince(t.updatedAt || t.createdAt),
          origin: 'todo',
        }),
      );
    }
    return items.slice(0, limit);
  }

  function getActiveTasks(limit = 10) {
    if (tasksDir) {
      const fromDir = fromTasksDir(limit);
      if (fromDir !== null) return fromDir;
    }
    return fromSnapshot(limit);
  }

  return { getActiveTasks };
}

// Fuzzy "did the message name one of these tasks" matcher. Ports the idea of
// matchMessageContext (src/main/telegram-context.ts): partial-word title token
// overlap with a confidence floor of 0.34. Returns { ordered, matched } where
// ordered puts the best match first when one clears the floor.
function rankTasksForMessage(message, activeTasks) {
  const list = Array.isArray(activeTasks) ? activeTasks.slice() : [];
  const msg = String(message || '');
  let best = null;
  let bestScore = 0;
  for (const t of list) {
    const titleTokens = tokens(t.title);
    const score = overlap(titleTokens, msg) * 0.9;
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }
  if (!best || bestScore < 0.34) return { ordered: list, matched: null, confidence: 0 };
  const ordered = [best, ...list.filter((t) => t !== best)];
  return { ordered, matched: best, confidence: Math.min(1, bestScore) };
}

function formatItemLine(t, prefix = '- ') {
  const age = t.ageHours === null ? '' : ', ' + t.ageHours + 'h old';
  return prefix + t.title + ' [' + t.status + age + ', via ' + t.origin + ']';
}

// Compact context block for the Telegram prompt. When the message names a
// task (fuzzy title overlap), that task is promoted to the top with a marker.
// Hard-capped at SPINE_BLOCK_MAX_CHARS so the prompt budget stays bounded.
function buildSpineContextBlock(activeTasks, message = '') {
  const { ordered, matched } = rankTasksForMessage(message, activeTasks);
  if (!ordered.length) return '';
  const lines = ['ACTIVE WORK (spine):'];
  for (const t of ordered) {
    const prefix = matched && t === matched ? '- [REFERENCED BY THIS MESSAGE] ' : '- ';
    lines.push(formatItemLine(t, prefix));
  }
  return lines.join('\n').slice(0, SPINE_BLOCK_MAX_CHARS);
}

// Status-question detector. Category coverage, not literal triggers: asking
// where things stand in any phrasing should ground the answer in the spine.
const STATUS_INTENT_PATTERNS = [
  /\bstatus\b/i,
  /\bwhere (are we|do we stand|does .{1,40} stand|is that at)\b/i,
  /\bany (update|updates|progress|news|movement|luck)\b/i,
  /\bhow('s| is| are|s)? (it|that|this|things|the .{1,40}) (going|coming|looking|progressing)\b/i,
  /\bhow('s| is)? progress\b/i,
  /\bwhat('s| is)? (left|remaining|outstanding|still open|pending|in flight|the holdup)\b/i,
  /\b(are we|is it|is that|is this) (done|finished|complete|ready|live|deployed)\b/i,
  /\bwhat (are you|r u|are we) (working on|doing)\b/i,
  /\bdid (it|that|the .{1,40}) (work|finish|complete|ship|deploy|go through)\b/i,
  /\bprogress report\b/i,
];

function isStatusIntent(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  return STATUS_INTENT_PATTERNS.some((re) => re.test(t));
}

// Deterministic plain-English status answer built straight from the spine.
// No LLM in the loop: titles + states + age come verbatim from the store, so
// a status question can never be answered with invented work. askAmy threads
// this in as authoritative grounding when it wants richer phrasing.
function answerStatusFromSpine(activeTasks) {
  const list = Array.isArray(activeTasks) ? activeTasks : [];
  if (!list.length) {
    return 'Nothing is active on the task spine right now: no queued, running, or review-waiting work.';
  }
  const top = list.slice(0, 5);
  const parts = top.map((t) => {
    const age = t.ageHours === null ? '' : ' (' + t.ageHours + 'h old)';
    return '"' + t.title + '" is ' + t.status + age;
  });
  const more =
    list.length > top.length ? ' Plus ' + (list.length - top.length) + ' more active item(s).' : '';
  return (
    'Active work right now (' +
    list.length +
    ' item' +
    (list.length === 1 ? '' : 's') +
    '): ' +
    parts.join('; ') +
    '.' +
    more
  );
}

// Prompt-budget allocator for the context sections each LLM rung assembles.
// Contract (E2-R3): the combined memory + spine sections never exceed the
// existing per-rung budget (memory used to get the full 4000), and when they
// would, MEMORY is trimmed first; the spine block survives whole (it ExampleCos
// live ground truth, memory is background).
function fitPromptSections({ memory = '', spineBlock = '', baseBudget = 4000 } = {}) {
  const spineText = String(spineBlock || '').slice(0, SPINE_BLOCK_MAX_CHARS);
  const memoryBudget = Math.max(0, baseBudget - spineText.length);
  const memoryText = String(memory || '').slice(0, memoryBudget);
  return { memoryText, spineText };
}

module.exports = {
  createSpineProvider,
  buildSpineContextBlock,
  rankTasksForMessage,
  isStatusIntent,
  answerStatusFromSpine,
  fitPromptSections,
  SPINE_BLOCK_MAX_CHARS,
  ACTIVE_TASK_STATUSES,
};
