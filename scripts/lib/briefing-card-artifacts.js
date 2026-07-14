'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { CARDS, getCardById } = require('./briefing-card-manifest.js');
const { splitMarkdownCards } = require('./briefing-card-qc.js');
const { askAI } = require('./ask-ai.js');
const { writeDataArtifact } = require('./data-root.js');

const SCHEMA_VERSION = 1;
const CARD_ARTIFACT_REL_DIR = path.join('agent', 'briefing-cards');
const BOARD_ARTIFACT_REL = path.join('agent', 'dashboard-qc-result.json');

const LLM_CARD_IDS = Object.freeze([
  'ai_tech_news',
  'us_news',
  'world_news',
  'us_immigration_news',
  'mortgage_industry_news',
  'covid_news',
  'communication_coaching',
  'kingdom_equipping',
  'reputation_risk',
  'viral_tech_clips',
  'shorts_proposals',
]);

function defaultDataDir() {
  return (
    process.env.SECONDBRAIN_DATA_DIR ||
    (process.platform === 'linux'
      ? '/opt/secondbrain/data'
      : path.join(
          process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
          'secondbrain',
          'data',
        ))
  );
}

function normalizeStatus(status) {
  const s = String(status || '').trim().toLowerCase();
  return ['clean', 'defect', 'blocked', 'stale'].includes(s) ? s : 'blocked';
}

function cardTitle(cardOrId) {
  const card = typeof cardOrId === 'string' ? getCardById(cardOrId) : cardOrId;
  if (!card) return String(cardOrId || '').replace(/_/g, ' ').toUpperCase();
  return String(card.title || card.id || '').replace(/_/g, ' ').toUpperCase();
}

function isLlmCard(id) {
  return LLM_CARD_IDS.includes(String(id || ''));
}

function cardArtifactDir(dataDir, date) {
  return path.join(dataDir || defaultDataDir(), CARD_ARTIFACT_REL_DIR, String(date || 'ExampleCo'));
}

function artifactPathFor({ dataDir, date, id }) {
  return path.join(cardArtifactDir(dataDir, date), `${String(id)}.json`);
}

function createCardArtifact({
  id,
  title,
  date,
  kind,
  status,
  markdown,
  generatedAt = new Date().toISOString(),
  source = {},
  qc = null,
  blockedReason = '',
  stale = false,
} = {}) {
  const card = getCardById(id);
  const normalizedStatus = normalizeStatus(status);
  const normalizedKind = kind || (isLlmCard(id) ? 'llm' : 'data');
  const body = String(markdown || '').trim();
  return {
    schemaVersion: SCHEMA_VERSION,
    id: String(id || (card && card.id) || ''),
    title: title || cardTitle(card || id),
    date: String(date || ''),
    kind: normalizedKind,
    status: normalizedStatus,
    generatedAt,
    markdown:
      body ||
      `${title || cardTitle(card || id)}:\n${
        normalizedStatus === 'clean'
          ? `Produced successfully as of ${String(date || '').trim() || generatedAt}.`
          : blockedReason || 'This card is not publishable yet.'
      }`,
    source,
    qc: qc || {
      ok: normalizedStatus === 'clean',
      failures: normalizedStatus === 'clean' ? [] : [blockedReason || normalizedStatus],
    },
    blockedReason: normalizedStatus === 'blocked' ? blockedReason || 'Card blocked.' : '',
    stale: stale || normalizedStatus === 'stale',
  };
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

function writeCardArtifact({ dataDir, date, artifact }) {
  if (!artifact || !artifact.id) throw new Error('card artifact requires id');
  return writeJsonAtomic(artifactPathFor({ dataDir, date: date || artifact.date, id: artifact.id }), artifact);
}

function readCardArtifact({ dataDir, date, id }) {
  const json = readJson(artifactPathFor({ dataDir, date, id }));
  if (!json || json.schemaVersion !== SCHEMA_VERSION || !json.id) return null;
  return json;
}

function cardForMarkdownTitle(title) {
  const text = String(title || '');
  return CARDS.find((card) => {
    const re = new RegExp(card.match.source, card.match.flags.includes('i') ? 'i' : '');
    return re.test(text);
  }) || null;
}

function inferMarkdownSectionStatus(body) {
  const lines = String(body || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const first = lines[0] || '';
  const firstFew = lines.slice(0, 4).join('\n');
  if (/^(HARD-BLOCKED|BLOCKED\b|Blocked:|This card is held\b)/i.test(first)) return 'blocked';
  if (/^Status:\s*(blocked|red|stale|unavailable)\b/i.test(firstFew)) return 'blocked';
  if (/^Severity:\s*(red|blocked)\b/i.test(firstFew)) return 'blocked';
  if (/^(Source unavailable|Source expired|Unavailable)\b:?/i.test(first)) return 'blocked';
  if (/^\u2717\s/.test(first)) return 'blocked';
  if (/held back rather than shown as today|more than 24 hours old/i.test(first)) return 'blocked';
  return 'clean';
}

function markdownSectionToArtifact(section, { date, generatedAt = new Date().toISOString() } = {}) {
  const card = cardForMarkdownTitle(section && section.title);
  if (!card) return null;
  const body = String(section.body || '').trim();
  const status = inferMarkdownSectionStatus(body);
  return createCardArtifact({
    id: card.id,
    title: section.title,
    date,
    kind: isLlmCard(card.id) ? 'llm' : 'data',
    status,
    generatedAt,
    markdown: `${section.title}:\n${body}`,
    source: { mode: 'markdown-fallback', path: `briefings/briefing-${date}.md` },
    blockedReason: status === 'blocked' ? body.split(/\r?\n/)[0].slice(0, 200) : '',
    qc: {
      ok: status === 'clean',
      failures: status === 'clean' ? [] : [body.split(/\r?\n/)[0].slice(0, 200) || 'blocked'],
    },
  });
}

function markdownPathFor(dataDir, date) {
  return path.join(dataDir || defaultDataDir(), 'briefings', `briefing-${date}.md`);
}

function readMarkdownFallbackArtifacts({ dataDir, date } = {}) {
  const file = markdownPathFor(dataDir, date);
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, 'utf8');
  return splitMarkdownCards(raw)
    .map((section) => markdownSectionToArtifact(section, { date }))
    .filter(Boolean);
}

function readExplicitArtifacts({ dataDir, date } = {}) {
  const dir = cardArtifactDir(dataDir, date);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => readJson(path.join(dir, name)))
    .filter((json) => json && json.schemaVersion === SCHEMA_VERSION && json.id);
}

function orderArtifacts(artifacts) {
  const order = new Map(CARDS.map((card, index) => [card.id, index]));
  return [...(artifacts || [])].sort((a, b) => {
    const ai = order.has(a.id) ? order.get(a.id) : 999;
    const bi = order.has(b.id) ? order.get(b.id) : 999;
    return ai - bi || String(a.id).localeCompare(String(b.id));
  });
}

function readCardArtifactUnion({ dataDir, date, allowMarkdownFallback = true } = {}) {
  const explicit = readExplicitArtifacts({ dataDir, date });
  const byId = new Map();
  let usedFallback = false;
  for (const artifact of explicit) byId.set(artifact.id, artifact);
  if (allowMarkdownFallback) {
    for (const artifact of readMarkdownFallbackArtifacts({ dataDir, date })) {
      if (!byId.has(artifact.id)) {
        byId.set(artifact.id, artifact);
        usedFallback = true;
      }
    }
  }
  const artifacts = orderArtifacts([...byId.values()]);
  const sourceMode =
    explicit.length && usedFallback
      ? 'json-plus-markdown-fallback'
      : explicit.length
        ? 'json'
        : usedFallback
          ? 'markdown-fallback'
          : 'empty';
  return { date, artifacts, sourceMode };
}

function artifactMarkdown(artifact) {
  const text = String(artifact && artifact.markdown ? artifact.markdown : '').trim();
  if (text) return text;
  const title = (artifact && artifact.title) || cardTitle(artifact && artifact.id);
  if (artifact && artifact.status === 'blocked') {
    return `${title}:\nBlocked: ${artifact.blockedReason || 'source unavailable'}`;
  }
  return `${title}:\nCard artifact had no markdown body.`;
}

function artifactsToBriefingMarkdown(artifacts, { date, generatedAt = new Date().toISOString() } = {}) {
  const lines = [`# Daily Briefing - ${date || generatedAt.slice(0, 10)}`, '', `Generated: ${generatedAt}`, ''];
  for (const artifact of orderArtifacts(artifacts)) {
    lines.push(artifactMarkdown(artifact), '', '---', '');
  }
  return `${lines.join('\n').replace(/\n---\n\s*$/, '\n')}`;
}

function loadBriefingFromCardArtifacts({ dataDir, date, allowMarkdownFallback = true } = {}) {
  const union = readCardArtifactUnion({ dataDir, date, allowMarkdownFallback });
  if (!union.artifacts.length) return null;
  const generatedAt =
    union.artifacts
      .map((artifact) => artifact.generatedAt)
      .filter(Boolean)
      .sort()
      .slice(-1)[0] || new Date().toISOString();
  return {
    date,
    filename: `briefing-${date}.md`,
    greeting: [`# Daily Briefing - ${date}`, '', `Generated: ${generatedAt}`].join('\n'),
    sourceMode: union.sourceMode,
    sections: union.artifacts.map((artifact, index) => {
      const cards = splitMarkdownCards(artifactMarkdown(artifact));
      const parsed = cards[0] || { title: artifact.title, body: artifactMarkdown(artifact) };
      return {
        title: parsed.title || artifact.title,
        body: parsed.body || '',
        idx: index,
        artifact,
      };
    }),
  };
}

function statusToLiveStatus(status) {
  if (status === 'clean') return 'clean';
  if (status === 'blocked') return 'blocked';
  return 'defect';
}

function liveBoardArtifactFromCardArtifacts(artifacts, { date, now = new Date() } = {}) {
  const ts = now.toISOString();
  const cards = orderArtifacts(artifacts).map((artifact) => {
    const liveStatus = statusToLiveStatus(artifact.status);
    return {
      id: artifact.id,
      title: artifact.title || cardTitle(artifact.id),
      status: liveStatus,
      defectKinds:
        liveStatus === 'clean'
          ? []
          : [artifact.blockedReason || artifact.status || 'card artifact not clean'],
      asOf: artifact.generatedAt || ts,
    };
  });
  return {
    ts,
    date,
    ran: true,
    ok: cards.every((card) => card.status === 'clean'),
    retry: false,
    defectiveCardCount: cards.filter((card) => card.status !== 'clean').length,
    cards,
    defectCount: cards.filter((card) => card.status !== 'clean').length,
    defects: cards
      .filter((card) => card.status !== 'clean')
      .map((card) => `${card.status.toUpperCase()}: ${card.id} ${card.defectKinds.join(', ')}`),
    source: 'per-card-artifacts',
  };
}

function writeLiveBoardArtifactFromCardArtifacts({ dataDir, date, artifacts, now = new Date() }) {
  const artifact = liveBoardArtifactFromCardArtifacts(artifacts, { date, now });
  const absPath = writeDataArtifact(BOARD_ARTIFACT_REL, artifact, { dataDir });
  return { artifact, absPath };
}

function writeCompatibilityMarkdown({ dataDir, date, artifacts, now = new Date() }) {
  const markdown = artifactsToBriefingMarkdown(artifacts, {
    date,
    generatedAt: now.toISOString(),
  });
  const file = markdownPathFor(dataDir, date);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, markdown, 'utf8');
  return file;
}

function existingSourceArtifact({ dataDir, date, id }) {
  const current = readCardArtifact({ dataDir, date, id });
  if (current) return { ...current, source: { ...(current.source || {}), ExampleCodForward: true } };
  const fallback = readMarkdownFallbackArtifacts({ dataDir, date }).find((artifact) => artifact.id === id);
  return fallback || null;
}

async function produceLlmCardArtifact({ card, date, dataDir, now = new Date() }) {
  const prompt = [
    `Produce the ${card.id} Daily Briefing card for ${date}.`,
    'Return concise markdown only.',
    'If the model is unavailable, the caller will block only this card.',
  ].join('\n');
  const response = await askAI(prompt, {
    surface: `briefing-card:${card.id}`,
    rungOrder: ['claude-cli', 'codex'],
    rungTimeoutMs: Number(process.env.ASK_AI_FAIL_FAST_MS || 15000),
    rungRetries: 0,
    silent: true,
    maxTokens: 500,
  });
  if (response && response.text) {
    return createCardArtifact({
      id: card.id,
      title: cardTitle(card),
      date,
      kind: 'llm',
      status: 'clean',
      generatedAt: now.toISOString(),
      markdown: `${cardTitle(card)}:\n${response.text}`,
      source: { mode: 'llm', rung: response.rung, attempts: response.attempts },
      qc: { ok: true, failures: [] },
    });
  }
  return createCardArtifact({
    id: card.id,
    title: cardTitle(card),
    date,
    kind: 'llm',
    status: 'blocked',
    generatedAt: now.toISOString(),
    markdown: `${cardTitle(card)}:\nBlocked: LLM unavailable. This card is held without blocking sibling cards.`,
    blockedReason: 'LLM unavailable after bounded Codex and Claude attempts.',
    source: { mode: 'llm', attempts: response ? response.attempts : [] },
  });
}

function produceDataCardArtifact({ card, date, dataDir, now = new Date() }) {
  const existing = existingSourceArtifact({ dataDir, date, id: card.id });
  if (existing) {
    return {
      ...existing,
      kind: 'data',
      status: existing.status === 'clean' ? 'clean' : normalizeStatus(existing.status),
      generatedAt: now.toISOString(),
      source: { ...(existing.source || {}), producer: 'data-card-artifact' },
    };
  }
  return createCardArtifact({
    id: card.id,
    title: cardTitle(card),
    date,
    kind: 'data',
    status: 'blocked',
    generatedAt: now.toISOString(),
    markdown: `${cardTitle(card)}:\nBlocked: deterministic source artifact missing for ${date}.`,
    blockedReason: 'Deterministic source artifact missing.',
    source: { mode: 'data', missing: true },
  });
}

async function produceCardArtifact({ cardId, date, dataDir = defaultDataDir(), now = new Date() } = {}) {
  const card = getCardById(cardId);
  if (!card) throw new Error(`ExampleCo briefing card '${cardId}'`);
  return isLlmCard(card.id)
    ? produceLlmCardArtifact({ card, date, dataDir, now })
    : produceDataCardArtifact({ card, date, dataDir, now });
}

function producerConcurrency() {
  const n = Number(process.env.BRIEFING_CARD_PRODUCER_CONCURRENCY || 4);
  return Number.isInteger(n) && n > 0 ? n : 4;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index], index);
    }
  }
  const count = Math.min(Math.max(1, limit), items.length || 1);
  await Promise.all(Array.from({ length: count }, () => worker()));
  return results;
}

async function produceAllCardArtifacts({ dataDir = defaultDataDir(), date, now = new Date() } = {}) {
  const artifacts = await mapLimit(CARDS, producerConcurrency(), async (card) => {
    try {
      return await produceCardArtifact({ cardId: card.id, dataDir, date, now });
    } catch (error) {
      return createCardArtifact({
        id: card.id,
        title: cardTitle(card),
        date,
        kind: isLlmCard(card.id) ? 'llm' : 'data',
        status: 'blocked',
        generatedAt: now.toISOString(),
        markdown: `${cardTitle(card)}:\nBlocked: ${String((error && error.message) || error)}`,
        blockedReason: String((error && error.message) || error),
        source: { mode: 'producer-exception' },
      });
    }
  });
  for (const artifact of artifacts) writeCardArtifact({ dataDir, date, artifact });
  const board = writeLiveBoardArtifactFromCardArtifacts({ dataDir, date, artifacts, now });
  return { artifacts: orderArtifacts(artifacts), board };
}

function listCardArtifactDates({ dataDir = defaultDataDir() } = {}) {
  const root = path.join(dataDir, CARD_ARTIFACT_REL_DIR);
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a));
  } catch {
    return [];
  }
}

function briefingArtifactWatchdog({ dataDir = defaultDataDir(), date, now = new Date() } = {}) {
  const union = readCardArtifactUnion({ dataDir, date, allowMarkdownFallback: false });
  const total = CARDS.length;
  const present = union.artifacts.length;
  const missing = CARDS.map((card) => card.id).filter(
    (id) => !union.artifacts.some((artifact) => artifact.id === id),
  );
  const blocked = union.artifacts.filter((artifact) => artifact.status === 'blocked').map((a) => a.id);
  const stale = union.artifacts.filter((artifact) => artifact.status === 'stale').map((a) => a.id);
  return {
    ok: present === total && missing.length === 0,
    date,
    checkedAt: now.toISOString(),
    cardArtifacts: { present, total, missing, blocked, stale },
    hungDependencyIsolation:
      'Each card has its own artifact. Hung dependencies affect only cards listed as blocked or stale.',
  };
}

module.exports = {
  SCHEMA_VERSION,
  CARD_ARTIFACT_REL_DIR,
  BOARD_ARTIFACT_REL,
  LLM_CARD_IDS,
  defaultDataDir,
  normalizeStatus,
  cardTitle,
  isLlmCard,
  cardArtifactDir,
  artifactPathFor,
  createCardArtifact,
  writeCardArtifact,
  readCardArtifact,
  cardForMarkdownTitle,
  markdownSectionToArtifact,
  markdownPathFor,
  readMarkdownFallbackArtifacts,
  readExplicitArtifacts,
  orderArtifacts,
  readCardArtifactUnion,
  artifactMarkdown,
  artifactsToBriefingMarkdown,
  loadBriefingFromCardArtifacts,
  liveBoardArtifactFromCardArtifacts,
  writeLiveBoardArtifactFromCardArtifacts,
  writeCompatibilityMarkdown,
  produceCardArtifact,
  produceAllCardArtifacts,
  listCardArtifactDates,
  briefingArtifactWatchdog,
};
