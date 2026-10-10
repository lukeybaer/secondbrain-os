'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { writeJsonAtomic } = require('./briefing-cards/card-format.js');

const SCHEMA = 'secondbrain.news-topic-preferences.v1';
const MAX_TOPICS = 40;
const MAX_TITLE_CHARS = 100;
const MAX_PROMPT_CHARS = 500;
const JEV_TOPIC_PACKET_MAX_BYTES = 24000;
const CATEGORY_KEYS = new Set(['ExampleCo']);

const DEFAULT_ROWS = [
  [100, 'Frontier AI and LLMs', 'Prioritize material advances in frontier language models and agents.'],
  [90, 'Technology breakthroughs', 'Prioritize genuine technical breakthroughs with demonstrated capability.'],
  [80, 'Science', 'Prioritize major discoveries and validated findings.'],
  [55, 'Important outside interests', 'Prioritize an unusually important, substantial, or original story. Describe your own topics here.'],
];

function defaultTopics(now = Date.now()) {
  const updatedAt = new Date(now).toISOString();
  return {
    schema: SCHEMA,
    updatedAt,
    source: 'defaults',
    fileMtime: null,
    topics: DEFAULT_ROWS.map(([rank, title, prompt], index) => ({
      id: `topic-${String(index + 1).padStart(2, '0')}`,
      title,
      prompt,
      rank,
      enabled: true,
      ...(/^ExampleCo\b/i.test(title) ? { categoryKey: 'ExampleCo' } : {}),
    })),
  };
}

function text(value, max) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeTopics(input, now = Date.now(), { source = 'registry', fileMtime = null, requireSchema = false } = {}) {
  if (requireSchema && input?.schema !== SCHEMA) throw new Error(`Unsupported news topic schema: ${input?.schema || 'missing'}.`);
  if (!input || !Array.isArray(input.topics)) throw new Error('News topics must be an array.');
  if (input.topics.length > MAX_TOPICS) throw new Error(`News topics are limited to ${MAX_TOPICS}.`);
  const seen = new Set();
  const topics = [];
  for (const [index, raw] of input.topics.entries()) {
    const rawTitle = String(raw && raw.title || '').replace(/\s+/g, ' ').trim();
    const rawPrompt = String(raw && raw.prompt || '').replace(/\s+/g, ' ').trim();
    if (rawTitle.length > MAX_TITLE_CHARS) throw new Error(`Topic ${index + 1} display title is longer than ${MAX_TITLE_CHARS} characters.`);
    if (rawPrompt.length > MAX_PROMPT_CHARS) throw new Error(`Topic ${index + 1} Jev prompt is longer than ${MAX_PROMPT_CHARS} characters.`);
    const title = text(rawTitle, MAX_TITLE_CHARS);
    const prompt = text(rawPrompt, MAX_PROMPT_CHARS);
    if (!title) throw new Error(`Topic ${index + 1} needs a display title.`);
    if (!prompt) throw new Error(`Topic ${index + 1} needs a Jev prompt.`);
    const numericRank = Number(raw.rank);
    if (!Number.isInteger(numericRank) || numericRank < 1 || numericRank > 100) {
      throw new Error(`Topic ${index + 1} priority must be a whole number from 1 to 100.`);
    }
    let id = text(raw && raw.id, 64).replace(/[^a-zA-Z0-9_-]/g, '');
    if (!/^topic-[0-9a-z]{2,10}$/.test(id) || seen.has(id)) id = `topic-${crypto.randomUUID().slice(0, 8)}`;
    seen.add(id);
    topics.push({
      id,
      title,
      prompt,
      rank: numericRank,
      enabled: raw.enabled !== false,
      ...((CATEGORY_KEYS.has(raw.categoryKey) || /^(?:ExampleCo|ExampleCo and crowd phone displays)$/i.test(title))
        ? { categoryKey: CATEGORY_KEYS.has(raw.categoryKey) ? raw.categoryKey : 'ExampleCo' }
        : {}),
    });
  }
  if (!topics.length) throw new Error('At least one complete news topic is required.');
  if (!topics.some((row) => row.enabled)) throw new Error('At least one news topic must remain active for Jev.');
  topics.sort((a, b) => b.rank - a.rank);
  return {
    schema: SCHEMA,
    updatedAt: typeof input.updatedAt === 'string' && input.updatedAt ? input.updatedAt : new Date(now).toISOString(),
    source,
    fileMtime,
    topics,
  };
}

function newsTopicPreferencesPath(dataRoot = process.env.SECONDBRAIN_DATA_DIR || (process.platform === 'linux'
  ? '/opt/secondbrain/data'
  : path.join(process.env.APPDATA || path.join(require('node:os').homedir(), 'AppData', 'Roaming'), 'secondbrain', 'data'))) {
  return path.join(dataRoot, 'agent', 'news-topic-preferences.json');
}

function loadNewsTopicPreferences(filePath, now = Date.now()) {
  try {
    const stat = fs.statSync(filePath);
    return normalizeTopics(JSON.parse(fs.readFileSync(filePath, 'utf8')), now, {
      source: 'registry',
      fileMtime: stat.mtime.toISOString(),
      requireSchema: true,
    });
  } catch (error) {
    if (error && error.code === 'ENOENT') return defaultTopics(now);
    console.error(`[news-topics] registry load failed at ${filePath}: ${error.message || error}`);
    throw error;
  }
}

function saveNewsTopicPreferences(filePath, input, now = Date.now(), { expectedUpdatedAt = '', reset = false } = {}) {
  let existing = null;
  if (!reset) {
    try { existing = loadNewsTopicPreferences(filePath, now); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  if (existing && existing.source === 'registry' && expectedUpdatedAt !== existing.updatedAt) {
    const error = new Error('News topics changed in another tab. Reload before saving.');
    error.code = 'conflict';
    throw error;
  }
  const value = normalizeTopics({ ...input, updatedAt: new Date(now).toISOString() }, now);
  const persisted = { schema: value.schema, updatedAt: value.updatedAt, topics: value.topics };
  writeJsonAtomic(filePath, persisted);
  const expectedBytes = `${JSON.stringify(persisted, null, 2)}\n`;
  const actualBytes = fs.readFileSync(filePath, 'utf8');
  if (crypto.createHash('sha256').update(actualBytes).digest('hex') !== crypto.createHash('sha256').update(expectedBytes).digest('hex')) {
    throw new Error('News topics durable-storage digest did not match the atomic write.');
  }
  const verified = loadNewsTopicPreferences(filePath, now);
  if (verified.source !== 'registry' || JSON.stringify(verified.topics) !== JSON.stringify(persisted.topics) || verified.updatedAt !== persisted.updatedAt) {
    throw new Error('News topics were written but could not be verified from durable storage.');
  }
  return { ...verified, saveVerified: true };
}

function jevTopicPacket(value) {
  const packet = (value && value.topics || [])
    .filter((row) => row.enabled !== false)
    .map((row) => ({ id: row.id, priority: row.rank, instruction: row.prompt }));
  const bytes = Buffer.byteLength(JSON.stringify(packet));
  if (bytes > JEV_TOPIC_PACKET_MAX_BYTES) {
    throw new Error(`Enabled Jev topic packet is ${bytes} bytes; maximum is ${JEV_TOPIC_PACKET_MAX_BYTES}.`);
  }
  return packet;
}

module.exports = {
  SCHEMA,
  MAX_TOPICS,
  MAX_TITLE_CHARS,
  MAX_PROMPT_CHARS,
  JEV_TOPIC_PACKET_MAX_BYTES,
  CATEGORY_KEYS,
  DEFAULT_ROWS,
  defaultTopics,
  newsTopicPreferencesPath,
  normalizeTopics,
  loadNewsTopicPreferences,
  saveNewsTopicPreferences,
  jevTopicPacket,
};
