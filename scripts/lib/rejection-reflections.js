#!/usr/bin/env node
/**
 * rejection-reflections.js
 *
 * 2026-05-26 ExampleCo: every rejection in the briefing dashboard generates
 * a channel-level verbal lesson and appends it to
 * data/agent/rejection-reflections/<channel>.jsonl. The planner consumes
 * the COMPILED bounded view (see compile-channel-memory.js) on every
 * plan call; the raw JSONL is the auditable source of truth.
 *
 * Append-only, channel-scoped, chronological. Annual rotation when the
 * active file exceeds 500 entries: the old file is moved to
 * <channel>-<year>.jsonl and a fresh active file is started.
 *
 * Public API:
 *
 *   appendReflection(channel, rejection, opts?) -> Promise<reflection|null>
 *     - rejection: { video_id, note, ts, canonical?: boolean }
 *     - opts.llmFn(prompt): async function returning the verbal lesson.
 *       Defaults to the askAI ladder (codex -> claude-proxy -> claude-cli
 *       -> openai floor).
 *     - returns null (queue-and-skip) when the LLM call fails: the miss is
 *       logged, no row is written, and the caller keeps going. The raw
 *       rejection stays durable upstream so a later pass can re-reflect.
 *     - opts.reflectionsDir: where to write (default: <repo>/data/agent/rejection-reflections)
 *     - opts.nowYear: int (test override; defaults to new Date().getFullYear())
 *
 *   loadReflections(channel, opts?) -> reflection[]
 *     - returns rows in chronological order (oldest first)
 *     - silently skips malformed JSONL lines
 *     - returns [] for ExampleCo channels
 *
 * Reflection row shape:
 *   {
 *     id: <unique>,
 *     channel: <str>,
 *     video_id: <str>,
 *     note: <raw rejection note>,
 *     lesson: <1-2 sentence channel-level verbal lesson>,
 *     ts: <ISO timestamp>,
 *     canonical: <bool, default false>
 *   }
 *
 * Contract pinned by scripts/__tests__/rejection-reflections.test.js.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// 2026-06-11 universal LLM ladder: the default LLM call descends
// codex -> claude-proxy -> claude-cli -> openai floor via ask-ai.js. The
// claude-cli oauth env lesson (buildClaudeCliEnv) lives inside the ladder.
const { askAI } = require(path.join(__dirname, 'ask-ai.js'));

const DEFAULT_DIR = path.resolve(__dirname, '..', '..', 'data', 'agent', 'rejection-reflections');
const ROTATE_AT = 500;

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function channelFilePath(reflectionsDir, channel) {
  return path.join(reflectionsDir, `${channel}.jsonl`);
}

function archiveFilePath(reflectionsDir, channel, year) {
  return path.join(reflectionsDir, `${channel}-${year}.jsonl`);
}

// Prompt instructs the LLM to produce a 1-2 sentence channel-scoped
// lesson, no preamble, no JSON wrapper, just the lesson text.
function buildPrompt(channel, rejection) {
  return [
    `You are reading a rejection note ExampleCo just left on a short-form video on the "${channel}" channel.`,
    'Your job is to produce ONE channel-level VERBAL LESSON in 1 to 2 sentences (240 chars max) that captures the generalizable craft rule, NOT the specific incident.',
    `The lesson must mention the channel name "${channel}" so future planning calls can match by channel.`,
    'Output only the lesson text, no preamble, no JSON, no quotes around it.',
    '',
    `CHANNEL: ${channel}`,
    `VIDEO_ID: ${rejection.video_id || 'ExampleCo'}`,
    `REJECTION NOTE: ${rejection.note || ''}`,
    '',
    'LESSON (one to two sentences, 240 chars max, must include the channel name):',
  ].join('\n');
}

// Default LLM call via the universal ladder. silent:true returns null when
// every rung fails; throw so appendReflection's queue-and-skip path handles
// the miss uniformly with injected llmFn throws.
async function defaultLlmFn(prompt) {
  const out = await askAI(prompt, { surface: 'rejection-reflections', silent: true });
  if (!out || !out.text) throw new Error('all LLM rungs failed (codex + claude + paid floor)');
  return out.text.trim();
}

// Trim the lesson to 240 chars max. If the LLM emits a long response,
// take the first 1-2 sentences and slice.
function clampLesson(text) {
  const s = String(text || '')
    .trim()
    .replace(/^["']|["']$/g, '');
  // Take up to 2 sentences first.
  const matches = s.match(/[^.!?]+[.!?]/g) || [s];
  const upToTwo = matches.slice(0, 2).join(' ').trim();
  return upToTwo.slice(0, 240);
}

// Atomically count lines without loading the whole file.
function countLines(filePath) {
  if (!fs.existsSync(filePath)) return 0;
  const raw = fs.readFileSync(filePath, 'utf8');
  return raw.split('\n').filter(Boolean).length;
}

// Rotate the active file to <channel>-<year>.jsonl. If a same-name
// archive exists, append "-N" to avoid clobbering.
function rotateIfFull(reflectionsDir, channel, nowYear) {
  const active = channelFilePath(reflectionsDir, channel);
  const count = countLines(active);
  if (count < ROTATE_AT) return;
  let archive = archiveFilePath(reflectionsDir, channel, nowYear);
  let suffix = 1;
  while (fs.existsSync(archive)) {
    archive = path.join(reflectionsDir, `${channel}-${nowYear}-${suffix}.jsonl`);
    suffix += 1;
  }
  fs.renameSync(active, archive);
}

async function appendReflection(channel, rejection, opts = {}) {
  if (!channel || typeof channel !== 'string') {
    throw new Error('appendReflection: channel is required');
  }
  if (!rejection || typeof rejection !== 'object') {
    throw new Error('appendReflection: rejection is required');
  }
  const reflectionsDir = opts.reflectionsDir || DEFAULT_DIR;
  const llmFn = opts.llmFn || defaultLlmFn;
  const nowYear = opts.nowYear || new Date().getFullYear();

  ensureDir(reflectionsDir);
  rotateIfFull(reflectionsDir, channel, nowYear);

  const prompt = buildPrompt(channel, rejection);
  let lessonRaw;
  try {
    lessonRaw = await llmFn(prompt);
  } catch (e) {
    // 2026-06-11 ladder: a dead LLM must not crash the rejection pipeline.
    // Queue-and-skip: log the miss and return null. The rejection itself
    // stays durable upstream (manifest / rejections.jsonl), so a later
    // pass can re-reflect when a rung recovers.
    console.warn(
      `[rejection-reflections] llm miss for channel ${channel} (${rejection.video_id || 'ExampleCo'}): ${e.message}; skipping reflection, no row written`,
    );
    return null;
  }
  const lesson = clampLesson(lessonRaw);

  const row = {
    id: crypto.randomBytes(6).toString('hex'),
    channel,
    video_id: rejection.video_id || '',
    note: rejection.note || '',
    lesson,
    ts: rejection.ts || new Date().toISOString(),
    canonical: rejection.canonical === true,
  };

  const active = channelFilePath(reflectionsDir, channel);
  fs.appendFileSync(active, JSON.stringify(row) + '\n');
  return row;
}

function loadReflections(channel, opts = {}) {
  const reflectionsDir = opts.reflectionsDir || DEFAULT_DIR;
  const active = channelFilePath(reflectionsDir, channel);
  if (!fs.existsSync(active)) return [];
  const raw = fs.readFileSync(active, 'utf8');
  const rows = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r && r.canonical === undefined) r.canonical = false;
      rows.push(r);
    } catch {
      // Malformed line: skip and keep going (audit log resilience).
    }
  }
  // Chronological order by ts (oldest first).
  rows.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  return rows;
}

module.exports = {
  appendReflection,
  loadReflections,
  buildPrompt,
  clampLesson,
  ROTATE_AT,
};
