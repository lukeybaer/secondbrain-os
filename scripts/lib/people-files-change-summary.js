'use strict';

const fs = require('node:fs');
const path = require('node:path');

// One producer-to-renderer contract for the People Files Changes card. It
// separates sourced factual changes from tracking-only churn and never exposes
// internal event/process identifiers or raw filesystem paths.
function redactPathToken(match) {
  const unquoted = String(match).replace(/`$/, '');
  const terminalPunctuation = (unquoted.match(/[.,;:]+$/) || [''])[0];
  return `[path]${terminalPunctuation}`;
}

function cleanPeopleChangeText(value) {
  return String(value || '')
    .replace(/(?:^|[•|]\s*)(?:Last interaction|Direction of latest|Recorded messages in this block|Latest event ID|Processed event IDs?|Event IDs?|Process IDs?|Raw paths?)\s*:[^•|]*/gi, ' ')
    .replace(/`?[A-Za-z]:\\[^\s)`]+`?/g, redactPathToken)
    .replace(/`?\/(?:opt|home|mnt|Users|data)\/[^\s)`]+`?/gi, redactPathToken)
    .replace(/\b(?:from|at|in|under|via)\s+\[path\](?=\s|[.,;:]|$)/gi, ' ')
    .replace(/\[path\]/gi, ' ')
    .replace(/\b(?:spine-session-[\w-]+|dispatch-\d+|[0-9a-f]{32,64}|[0-9a-f]{8}-[0-9a-f-]{27,})\b/gi, '')
    .replace(/\b(?:from|at|in|under|via)\s+(?=[.,;:]|$)/gi, ' ')
    .replace(/\s+([.,;:])/g, '$1')
    .replace(/\s+\.(?=\s|$)/g, '.')
    .replace(/\s+/g, ' ')
    .replace(/(?:^|\s)[•|](?:\s|$)/g, ' ')
    .trim();
}

function explicitPeopleDates(text, nowMs = Date.now()) {
  const raw = String(text || '');
  const dates = [...raw.matchAll(/\b(20\d{2}-\d{2}-\d{2})\b/g)].map((match) =>
    Date.parse(`${match[1]}T12:00:00Z`),
  );
  const year = new Date(nowMs).getUTCFullYear();
  const monthByName = {
    jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
    may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8,
    sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11,
    december: 11,
  };
  for (const match of raw.matchAll(
    /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})(?:\s*(?:-|to)\s*(\d{1,2}))?\b/gi,
  )) {
    const month = monthByName[match[1].toLowerCase()];
    for (const day of [Number(match[2]), Number(match[3] || match[2])]) {
      const ms = Date.UTC(year, month, day, 12, 0, 0);
      if (Number.isFinite(ms)) dates.push(ms);
    }
  }
  return dates;
}

function peopleHistoryPartIsFresh(text, hours = 24, nowMs = Date.now()) {
  const dates = explicitPeopleDates(text, nowMs);
  if (!dates.length) return true;
  const cutoff = nowMs - Number(hours || 24) * 60 * 60 * 1000;
  return dates.every((ms) => Number.isFinite(ms) && ms >= cutoff);
}

function hasVoiceOrSourceProof(text) {
  return /\b(?:voice(?:print)?|speaker|source|transcript)\b/i.test(text) &&
    /\b(?:verified|confirmed|matched|identified|proof|evidence|explicitly)\b/i.test(text);
}

// Contact-specific holds live in a private config file that the public mirror
// strips (scripts/simulate-public-sync.js STRIP), never in code. Fail safe:
// a missing, unreadable, or malformed file means no holds, never a crash.
const PEOPLE_SAMPLE_HOLDS_PATH = path.resolve(__dirname, '..', '..', 'config', 'people-sample-holds.json');

function compilePeopleSampleHold(hold) {
  if (!hold || typeof hold !== 'object') return null;
  try {
    const file = String(hold.file || '').toLowerCase();
    const nameRe = hold.namePattern ? new RegExp(String(hold.namePattern), 'i') : null;
    const topicRe = hold.topicPattern ? new RegExp(String(hold.topicPattern), 'i') : null;
    if (!file && !nameRe) return null;
    return { file, nameRe, topicRe };
  } catch {
    return null;
  }
}

function loadPeopleSampleHolds(configPath = PEOPLE_SAMPLE_HOLDS_PATH) {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return (Array.isArray(parsed && parsed.holds) ? parsed.holds : []).map(compilePeopleSampleHold).filter(Boolean);
  } catch {
    return [];
  }
}

let cachedPeopleSampleHolds = null;
function defaultPeopleSampleHolds() {
  if (!cachedPeopleSampleHolds) cachedPeopleSampleHolds = loadPeopleSampleHolds();
  return cachedPeopleSampleHolds;
}

// `holds` is injectable for tests; production reads the private config once.
function isUnsafePeopleSample(text, file = '', holds = defaultPeopleSampleHolds()) {
  const raw = String(text || '');
  const fileName = path.basename(String(file || ''), '.md').toLowerCase();
  for (const hold of holds) {
    const applies = (hold.file && fileName === hold.file) || (hold.nameRe && hold.nameRe.test(raw));
    if (!applies) continue;
    const topical = hold.topicRe ? hold.topicRe.test(raw) : true;
    if (topical && !hasVoiceOrSourceProof(raw)) return true;
  }
  return false;
}

function isPlaceholderPeopleSamplePart(text) {
  const cleaned = String(text || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return /^(?:What was new:\s*)?(?:\[\s*\.\s*\.\s*\.\s*\]|\.\.\.|placeholder)$/i.test(cleaned);
}

function freshPeopleSampleText(text, hours = 24, file = '', nowMs = Date.now()) {
  return String(text || '')
    .split(/\s*(?:\u00e2\u20ac\u00a2|\u2022|;)\s*/)
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => !isPlaceholderPeopleSamplePart(part))
    .filter((part) => peopleHistoryPartIsFresh(part, hours, nowMs))
    .filter((part) => !isUnsafePeopleSample(part, file))
    .join('; ');
}

function freshPeopleSubjectText(text, hours = 24, fallback = 'contact file changed', nowMs = Date.now()) {
  const subject = String(text || '').trim();
  if (subject && peopleHistoryPartIsFresh(subject, hours, nowMs) && !isUnsafePeopleSample(subject)) return subject;
  return fallback;
}


// ---------------------------------------------------------------------------
// What the new information IS (owner decision): "I don't care what mechanism
// did the update. I care what the update is, and I want to see that it's worth
// the number of new lines that were changed." Each contact row leads with one
// crisp sentence built from the actual added lines, next to a worth-it
// judgment. Added lines that carry no new fact about the person (regenerated
// machine-managed blocks, timestamps, counters, reordering) read "No new
// information" with the line count so the churn stays visible.
// ---------------------------------------------------------------------------

const BOOKKEEPING_KEY_RE = /^(?:last interaction|direction of latest|recorded messages in this block|latest event id|processed event ids?|event ids?|process ids?|raw paths?|last[_ ](?:update|updated|contacted|seen|scan|scanned|checked|sync|synced)|updated|message count|total (?:messages|interactions|events)|voice identity|origin ?session ?id|session ?id|sources?|tags?)\s*:/i;

// True when an added line records tracking state about the file, not a fact
// about the person: timestamps, counters, ids, machine-block markers, dividers.
function isBookkeepingLine(text) {
  const s = String(text || '').trim().replace(/^[-*]\s+/, '').trim();
  if (!s) return true;
  if (BOOKKEEPING_KEY_RE.test(s)) return true;
  if (/^<!--[\s\S]*-->$/.test(s)) return true;
  if (/^(?:[-=*_]{3,}|#{1,6}\s.*)$/.test(s)) return true;
  if (/^\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+Z?)?$/.test(s)) return true;
  if (/^`[^`]*`$/.test(s)) return true;
  return false;
}

// Text that describes the writer (a regenerated signal block, commit counts)
// rather than the person. Legacy snapshots carry it in semanticSummary.
function isMechanismText(text) {
  return /\b(?:Signal projections?|projection|file-touching commits?|cumulative Git|Amy-managed|durable block|matched the Signal)\b/i.test(String(text || ''));
}

const STUB_FACT_RES = [
  /^created from\b.*\bvoice identity flow\b/i,
  /\bhas not added (?:any )?(?:extra )?context\b/i,
  /\bno (?:extra )?context (?:yet|recorded|added)\b/i,
];

function crispPeopleFact(raw) {
  let s = cleanPeopleChangeText(raw)
    .replace(/^[-*]\s+/, '')
    .replace(/^\(?\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?\)?\s*(?:\([^)]*\))?\s*[-:–—]*\s*/, '')
    .replace(/^(?:fact|relationship context|what was new|new facts?|new content|note|summary|context)\s*:\s*/i, '')
    .replace(/`[^`]*`/g, ' ')
    .replace(/\s*Last interaction:[^.]*\.?\s*$/i, '')
    .replace(/\s*[–—]\s*/g, ', ')
    .replace(/\s+/g, ' ')
    .trim();
  const activity = /LinkedIn bulk-scan\)?:?\s*(\d+) recent post\(s\) found/i.exec(String(raw || ''));
  if (activity) return { sentence: 'Recorded ' + activity[1] + ' LinkedIn post(s) in activity history.', kind: 'activity' };
  if (STUB_FACT_RES.some((re) => re.test(String(raw || '')) || re.test(s))) return { sentence: '', kind: 'stub', created: /^created from\b/i.test(s) };
  if (s.length < 4 || !/[a-z]/i.test(s)) return { sentence: '', kind: 'none' };
  if (s.length > 220) {
    const cut = s.slice(0, 220);
    const space = cut.lastIndexOf(' ');
    s = (space > 120 ? cut.slice(0, space) : cut).replace(/[\s,;:]+$/, '') + '...';
  }
  s = s.charAt(0).toUpperCase() + s.slice(1);
  if (!/[.!?]$|\.\.\.$/.test(s)) s += '.';
  return { sentence: s, kind: 'fact' };
}

// The added lines of an entry, newest producer shape first (`addedFacts`), then
// the legacy joined sample. Mechanism text and bookkeeping never count.
function peopleEntryFacts(entry = {}) {
  const parts = [];
  const semantic = String(entry.semanticSummary || '').trim();
  if (semantic && !isMechanismText(semantic)) parts.push(...semantic.split(/\s*(?:•|;)\s*/));
  // Legacy snapshots buried the real fact inside the mechanism sentence as
  // "New fact: X | Y" before the commit-attribution tail; lift just that part.
  else if (semantic) {
    const lifted = /New facts?:\s*(.+?)(?:\s+(?:All \d+|\d+ of \d+) file-touching|\s+The \+\d+\/-\d+ figure|$)/i.exec(semantic);
    if (lifted) parts.push(...lifted[1].split(/\s*\|\s*/));
  }
  if (Array.isArray(entry.addedFacts)) parts.push(...entry.addedFacts.map(String));
  else parts.push(...String(entry.newContent || entry.addedSample || '').split(/\s*(?:•|;)\s*/));
  return parts.map((part) => part.trim()).filter(Boolean).filter((part) => !isBookkeepingLine(part));
}

function plural(n, word) {
  return n + ' ' + word + (n === 1 ? '' : 's');
}

function peopleLineCounts(added, deleted) {
  return plural(added, 'line') + ' added' + (deleted > 0 ? ', ' + deleted + ' removed' : '');
}

function summarizePeopleNewInformation(entry = {}) {
  const added = Number(entry.added || 0);
  const deleted = Number(entry.deleted || 0);
  const seen = new Set();
  const facts = [];
  let activity = null;
  let stubCreated = false;
  let stubs = 0;
  for (const part of peopleEntryFacts(entry)) {
    const crisp = crispPeopleFact(part);
    if (crisp.kind === 'stub') {
      stubs += 1;
      stubCreated = stubCreated || Boolean(crisp.created);
      continue;
    }
    if (crisp.kind === 'activity') {
      activity = activity || crisp.sentence;
      continue;
    }
    if (crisp.kind !== 'fact') continue;
    const key = crisp.sentence.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    facts.push(crisp.sentence);
  }
  const counts = peopleLineCounts(added, deleted);
  const created = Boolean(entry.createdInWindow) || stubCreated;
  const reportedFacts = Number(entry.newFactCount);
  const factCount = Number.isFinite(reportedFacts) && reportedFacts >= facts.length ? reportedFacts : facts.length;
  if (facts.length) {
    let sentence = facts[0];
    if (facts.length > 1 && (sentence + facts[1]).length <= 240) {
      sentence = sentence.replace(/\.$/, '') + '; ' + facts[1];
    }
    const shown = sentence === facts[0] ? 1 : 2;
    if (factCount > shown) sentence = sentence.replace(/\.$/, '') + ' (plus ' + (factCount - shown) + ' more new fact' + (factCount - shown === 1 ? '' : 's') + ').';
    const churny = added >= 12 && factCount / Math.max(added, 1) < 0.1;
    return {
      newInformation: sentence,
      verdict: churny ? 'thin' : 'worth',
      factCount,
      verdictNote: churny ? 'thin, ' + plural(factCount, 'new fact') + ' in ' + plural(added, 'line') : 'worth it',
      lineJudgment: counts + (churny ? ': thin, ' + plural(factCount, 'new fact') + ' in ' + plural(added, 'line') : ': worth it'),
    };
  }
  if (activity) {
    return { newInformation: activity, verdict: 'thin', factCount: 0, verdictNote: 'thin, activity log only', lineJudgment: counts + ': thin, activity log only' };
  }
  if (created || stubs > 0) {
    return {
      newInformation: 'New contact file with no background recorded yet.',
      verdict: 'thin',
      factCount: 0,
      verdictNote: 'thin, nothing about the person yet',
      lineJudgment: counts + ': thin, nothing about the person yet',
    };
  }
  return {
    newInformation: 'No new information',
    verdict: 'none',
    factCount: 0,
    verdictNote: 'all bookkeeping',
    lineJudgment: counts + ', all bookkeeping',
  };
}

function filterPeopleChangeEntry(entry = {}, { hours = 24, nowMs = Date.now() } = {}) {
  const file = entry.file || '';
  const filtered = {
    ...entry,
    semanticSummary: freshPeopleSampleText(entry.semanticSummary, hours, file, nowMs),
    newContent: freshPeopleSampleText(entry.newContent, hours, file, nowMs),
    addedSample: freshPeopleSampleText(entry.addedSample, hours, file, nowMs),
  };
  if (Array.isArray(entry.addedFacts)) {
    filtered.addedFacts = entry.addedFacts
      .map(String)
      .filter((part) => part.trim() && !isPlaceholderPeopleSamplePart(part))
      .filter((part) => peopleHistoryPartIsFresh(part, hours, nowMs))
      .filter((part) => !isUnsafePeopleSample(part, file));
  }
  return filtered;
}

function peopleChangeSummary(entry = {}, options = {}) {
  entry = filterPeopleChangeEntry(entry, options);
  const added = Number(entry.added || 0);
  const deleted = Number(entry.deleted || 0);
  const info = summarizePeopleNewInformation({ ...entry, added, deleted });
  const bookkeepingOnly = info.verdict === 'none';
  const lineCounts = '+' + added + '/-' + deleted + ' lines';
  const lineJudgment = info.lineJudgment;
  return {
    added,
    deleted,
    lineCounts,
    // The new information itself; empty when the added lines carry none.
    factualChange: bookkeepingOnly ? '' : info.newInformation,
    bookkeepingOnly,
    whatChanged: info.newInformation,
    newInformation: info.newInformation,
    verdict: info.verdict,
    factCount: info.factCount,
    lineJudgment,
    verdictNote: info.verdictNote,
    impact: lineJudgment.charAt(0).toUpperCase() + lineJudgment.slice(1) + '.',
  };
}

module.exports = {
  redactPathToken,
  cleanPeopleChangeText,
  explicitPeopleDates,
  peopleHistoryPartIsFresh,
  isUnsafePeopleSample,
  loadPeopleSampleHolds,
  PEOPLE_SAMPLE_HOLDS_PATH,
  isBookkeepingLine,
  crispPeopleFact,
  summarizePeopleNewInformation,
  freshPeopleSampleText,
  freshPeopleSubjectText,
  filterPeopleChangeEntry,
  peopleChangeSummary,
};
