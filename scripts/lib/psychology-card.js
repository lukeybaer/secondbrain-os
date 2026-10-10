'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { assertNoForbiddenPeople } = require('./forbidden-people.js');

const TITLE = 'PSYCHOLOGY FOR YOUR DAY';
const dayKey = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
const directory = (dataDir) => path.join(dataDir, 'agent', 'psychology');
const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
}
function withState(dataDir, operation) {
  const dir = directory(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, 'state.lock');
  // Critical sections do filesystem work only. A dead owner's lock fails loud.
  const fd = fs.openSync(lock, 'wx', 0o600);
  try {
    const file = path.join(dir, 'state.json');
    const stored = readJson(file);
    if (stored && (stored.schemaVersion !== 1 || !Array.isArray(stored.history) || !stored.current?.pairId)) throw new Error('Psychology history is invalid; refusing to reset it.');
    const state = stored || { schemaVersion: 1, current: null, history: [] };
    return operation(state, (next) => atomicJson(file, next));
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
function validateDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date))) throw new Error('Invalid psychology date.');
}
function sentenceCount(text) {
  return [...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(String(text || '').trim())].filter((part) => part.segment.trim()).length;
}
function usableExplanation(text) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value || /[<>]/.test(value) || value.length > 700) return '';
  const count = sentenceCount(value);
  return count >= 2 && count <= 3 ? value : '';
}
function validateItems(items) {
  if (!Array.isArray(items) || items.length !== 2 || new Set(items.map((x) => x.id)).size !== 2) throw new Error('Psychology requires two distinct concepts.');
  assertNoForbiddenPeople(JSON.stringify(items), 'psychology content');
  for (const item of items) {
    if (!item.id || !item.name || !item.definition || sentenceCount(item.definition) > 3 || item.definition.length > 900) throw new Error('Psychology definition must contain one to three short sentences.');
    // The prompt asks for 30 words; 40 is the hard cap so a slightly long
    // sentence never discards an opened pair (2026-09-26 RED: 33 and 31 words).
    if (!item.application || sentenceCount(item.application) !== 1 || item.application.trim().split(/\s+/).length > 40) throw new Error('Psychology application must be one brief sentence (40 words maximum).');
    if (!Array.isArray(item.sources) || !item.sources.length || item.sources.some((s) => !/^https:\/\//.test(s.url) || !s.title)) throw new Error('Psychology definitions require source links.');
    for (const value of [item.id, item.name, item.definition, item.application, ...item.sources.flatMap((s) => [s.title, s.url])]) {
      if (/[\r\n<>]/.test(value)) throw new Error('Psychology fields must be plain single-line text.');
    }
  }
  return items;
}
function selectConcepts(state, catalog, date) {
  validateDate(date);
  if (!Array.isArray(catalog?.concepts) || catalog.concepts.length < 2 || new Set(catalog.concepts.map((x) => x.id)).size !== catalog.concepts.length) throw new Error('Psychology source catalog is missing or duplicated.');
  const current = state.current;
  if (current && (!current.openedDate || date <= current.openedDate || date <= current.presentedDate)) return null;
  const lastSeen = new Map();
  state.history.forEach((row, index) => row.conceptIds.forEach((id, offset) => lastSeen.set(id, index * 2 + offset)));
  const prior = new Set(current?.items.map((x) => x.id) || []);
  return catalog.concepts.map((item, index) => ({ item, index, seen: lastSeen.get(item.id) ?? -1 }))
    .sort((a, b) => a.seen - b.seen || Number(prior.has(a.item.id)) - Number(prior.has(b.item.id)) || a.index - b.index)
    .slice(0, 2).map((x) => x.item);
}
function snapshotFor(state, date) {
  if (!state.current || date < state.current.presentedDate) throw new Error('Psychology cannot write a historical date from the current pair.');
  return { schemaVersion: 1, date, ...state.current };
}
async function refreshPsychology({ dataDir, date, catalog, generate, now = new Date() }) {
  const plan = withState(dataDir, (state) => {
    const selected = selectConcepts(state, catalog, date);
    if (!selected) {
      const snapshot = snapshotFor(state, date);
      atomicJson(path.join(directory(dataDir), `${date}.json`), snapshot);
      return { retained: snapshot };
    }
    if (state.current) atomicJson(path.join(directory(dataDir), `${date}.json`), snapshotFor(state, date));
    return { selected, previousPairId: state.current?.pairId || null };
  });
  if (plan.retained) return plan.retained;
  // No model runs for an unread or same-day pair, or inside the state lock.
  let applications;
  try {
    applications = await generate(plan.selected);
  } catch (genError) {
    // Per LEARNINGS pinned lesson: failed generation preserves the previous pair
    // and curriculum position. The fallback snapshot was already written above
    // before generate was called (when state.current existed). Return it so the
    // source does not fail the card entirely on a transient quota or timeout.
    if (plan.previousPairId !== null) {
      const fallback = readJson(path.join(directory(dataDir), `${date}.json`));
      if (fallback?.date === date && fallback?.pairId) return fallback;
    }
    throw genError;
  }
  // ExampleCo, 2026-09-25: "You're explaining it in one sentence, maybe explain it
  // in three, usually with an example." A generated explanation of two or three
  // plain sentences with an example replaces the one-line catalog definition on
  // the card; the catalog definition stays as the fallback when none validates.
  const items = validateItems(plan.selected.map((concept) => {
    const generated = applications.find((x) => x.id === concept.id) || {};
    return { ...concept, definition: usableExplanation(generated.explanation) || concept.definition, application: generated.application };
  }));
  return withState(dataDir, (state, save) => {
    if ((state.current?.pairId || null) !== plan.previousPairId || !selectConcepts(state, catalog, date)) {
      const retained = snapshotFor(state, date);
      atomicJson(path.join(directory(dataDir), `${date}.json`), retained);
      return retained;
    }
    state.current = { pairId: crypto.randomUUID(), presentedDate: date, generatedAt: new Date(now).toISOString(), openedDate: null, items, source: catalog.source };
    state.history.push({ pairId: state.current.pairId, date, conceptIds: items.map((x) => x.id) });
    save(state);
    const snapshot = snapshotFor(state, date);
    atomicJson(path.join(directory(dataDir), `${date}.json`), snapshot);
    return snapshot;
  });
}
function markPsychologyOpened({ dataDir, pairId, now = new Date() }) {
  return withState(dataDir, (state, save) => {
    if (!pairId || state.current?.pairId !== pairId) return { ok: false, reason: 'This is an older pair; the current pair is unchanged.' };
    if (!state.current.openedDate) {
      state.current.openedDate = dayKey(now);
      state.current.openedAt = new Date(now).toISOString();
      save(state);
    }
    return { ok: true, openedDate: state.current.openedDate };
  });
}
function readSnapshot(dataDir, date) {
  validateDate(date);
  const snapshot = readJson(path.join(directory(dataDir), `${date}.json`));
  if (!snapshot || snapshot.date !== date || !snapshot.pairId) throw new Error('Psychology concepts are not ready for this briefing date.');
  validateItems(snapshot.items);
  return snapshot;
}
function buildPsychologyCard(dataDir, date) {
  try {
    const snapshot = readSnapshot(dataDir, date);
    const body = [`Prepared for: ${date}`, '2 psychological concepts with a practical use for you.', `<!-- psychology-pair:${snapshot.pairId} -->`, 'Keep this pair until opened; a new pair can appear the following day.'];
    snapshot.items.forEach((item, index) => body.push('', `${index + 1}. ${item.name}`, `Definition: ${item.definition}`, `For you: ${item.application}`, ...item.sources.map((s) => `Source: [${s.title}](${s.url})`)));
    return { markdown: `${TITLE}:\n${body.join('\n')}`, state: { ok: true, count: 2, pairId: snapshot.pairId, presentedDate: snapshot.presentedDate } };
  } catch (error) { return { markdown: `${TITLE}:\nBlocked: ${error.message}`, state: { ok: false, blocked: true, defectReason: error.message } }; }
}
function parsePsychologyBody(body) {
  const pairId = String(body).match(/<!-- psychology-pair:([a-f0-9-]+) -->/)?.[1] || '';
  const items = [];
  let current;
  for (const line of String(body).split('\n')) {
    const heading = line.match(/^\d+\. (.+)$/);
    if (heading) { current = { id: `concept-${items.length + 1}`, name: heading[1], definition: '', application: '', sources: [] }; items.push(current); }
    else if (current && line.startsWith('Definition: ')) current.definition = line.slice(12);
    else if (current && line.startsWith('For you: ')) current.application = line.slice(9);
    else if (current) { const source = line.match(/^Source: \[(.+)\]\((https:\/\/[^\s]+)\)$/); if (source) current.sources.push({ title: source[1], url: source[2] }); }
  }
  try { validateItems(items); if (!pairId) throw new Error('Missing pair identity.'); return { kind: 'psychology', pairId, items, date: String(body).match(/^Prepared for: (\d{4}-\d{2}-\d{2})$/m)?.[1] || '', status: 'ready' }; }
  catch { return { kind: 'psychology', pairId: '', items: [], status: 'blocked', reason: 'The psychology pair is unavailable.' }; }
}
module.exports = { TITLE, dayKey, sentenceCount, usableExplanation, validateItems, selectConcepts, refreshPsychology, markPsychologyOpened, readSnapshot, buildPsychologyCard, parsePsychologyBody };
