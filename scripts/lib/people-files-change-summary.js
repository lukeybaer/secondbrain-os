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

// Nov 4 #otter (owner decision): the card showed lookup stamps and line counts
// instead of what changed. Any snake_case frontmatter key that stamps tracking
// state (lookup results, last-checked and last-scan dates, sync markers, ids) is
// bookkeeping, not a fact about the person. Keys that carry person data
// (birthday, email_work, phone_office, kids_birthdays) stay facts.
const SNAKE_KEY_LINE_RE = /^([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\s*:/;
const STAMP_KEY_NAME_RE = /^(?:linkedin_search_[a-z0-9_]+|linkedin_source|last_(?!name$)[a-z0-9_]+|[a-z0-9_]+_(?:checked|synced|scan|scanned|stamp|stamped|ts)|(?:created|updated|enriched|refreshed|verified|seen|processed|imported|modified|archived)_at|[a-z0-9_]+_ids?|window_(?:start|end))$/;

function isPeopleStampKeyLine(text) {
  const s = String(text || '').trim().replace(/^[-*]\s+/, '').trim();
  const match = SNAKE_KEY_LINE_RE.exec(s);
  return Boolean(match && STAMP_KEY_NAME_RE.test(match[1]));
}

// True when an added line records tracking state about the file, not a fact
// about the person: timestamps, counters, ids, machine-block markers, dividers.
function isBookkeepingLine(text) {
  const s = String(text || '').trim().replace(/^[-*]\s+/, '').trim();
  if (!s) return true;
  if (BOOKKEEPING_KEY_RE.test(s)) return true;
  if (isPeopleStampKeyLine(s)) return true;
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

// ---------------------------------------------------------------------------
// Lookup stamps (Nov 4 #otter, Owner decision). The LinkedIn priority resolver
// writes `linkedin_search_checked: DATE` and `linkedin_search_result: RESULT`
// (or `linkedin:` plus `linkedin_source:` when it finds a profile). Those lines
// are bookkeeping, but the lookup itself is worth one plain sentence: which day
// it ran and what it found. The parsed lookup rides on the entry as `lookups` so
// it survives the 24h freshness filter, which drops stale-dated stamp lines.
// ---------------------------------------------------------------------------

const LOOKUP_CHECKED_RE = /^linkedin_search_checked\s*:\s*['"]?(\d{4}-\d{2}-\d{2})/i;
const LOOKUP_RESULT_RE = /^linkedin_search_result\s*:\s*['"]?([a-z_-]+)/i;
const LOOKUP_SOURCE_RE = /^linkedin_source\s*:.*?(\d{4}-\d{2}-\d{2})/i;
const LINKEDIN_PROFILE_RE = /^linkedin\s*:\s*['"]?https?:\/\/(?:[\w-]+\.)?linkedin\.com\/(in\/[A-Za-z0-9%_.-]+)/i;
const LOOKUP_RESULT_RANK = { '': 0, other: 1, none: 2, ambiguous: 3, found: 4 };
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function normalizeLookupResult(value) {
  const v = String(value || '').toLowerCase().replace(/[-\s]+/g, '_');
  if (!v) return '';
  if (/^(?:none|no_match|not_found|no_profile|no_results?)$/.test(v)) return 'none';
  if (/^(?:ambiguous|multiple|multiple_matches)$/.test(v)) return 'ambiguous';
  if (/^(?:match|matched|found)$/.test(v)) return 'found';
  return 'other';
}

function parsePeopleLookupLines(lines) {
  let date = '';
  let result = '';
  let profile = '';
  let seen = false;
  for (const raw of lines) {
    const s = String(raw || '').trim().replace(/^[-*]\s+/, '').trim();
    let match = LOOKUP_CHECKED_RE.exec(s) || LOOKUP_SOURCE_RE.exec(s);
    if (match) {
      seen = true;
      if (match[1] > date) date = match[1];
    } else if ((match = LOOKUP_RESULT_RE.exec(s))) {
      seen = true;
      const next = normalizeLookupResult(match[1]);
      if (LOOKUP_RESULT_RANK[next] > LOOKUP_RESULT_RANK[result]) result = next;
    } else if ((match = LINKEDIN_PROFILE_RE.exec(s))) {
      profile = match[1];
    }
  }
  if (!seen) return null;
  if (profile) result = 'found';
  return { date, result, profile: result === 'found' ? profile : '' };
}

function normalizeStoredLookup(value) {
  if (!value || typeof value !== 'object') return null;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(value.date || '')) ? String(value.date) : '';
  const result = Object.prototype.hasOwnProperty.call(LOOKUP_RESULT_RANK, value.result) ? value.result : normalizeLookupResult(value.result);
  const profile = /^in\/[A-Za-z0-9%_.-]+$/.test(String(value.profile || '')) ? String(value.profile) : '';
  return { date, result, profile: result === 'found' ? profile : '' };
}

// One merged lookup for an entry. The sentence names the date, so between two
// dated lookups the newer one's result is stated; an undated stamp is a piece
// of the same lookup and merges by strength. Reads the stamp lines still
// present in the text fields, then the stored `lookups`.
function collectPeopleLookup(entry = {}) {
  const lines = [];
  if (Array.isArray(entry.addedFacts)) lines.push(...entry.addedFacts.map(String));
  for (const field of ['semanticSummary', 'newContent', 'addedSample']) {
    lines.push(...String(entry[field] || '').split(/\s*(?:\n|•|;)\s*/));
  }
  const found = [];
  const parsed = parsePeopleLookupLines(lines);
  if (parsed) found.push(parsed);
  for (const stored of Array.isArray(entry.lookups) ? entry.lookups : []) {
    const normalized = normalizeStoredLookup(stored);
    if (normalized) found.push(normalized);
  }
  if (!found.length) return null;
  return found.reduce((best, next) => {
    if (best.date && next.date && best.date !== next.date) return next.date > best.date ? next : best;
    const result = LOOKUP_RESULT_RANK[next.result] > LOOKUP_RESULT_RANK[best.result] ? next.result : best.result;
    return {
      date: next.date > best.date ? next.date : best.date,
      result,
      profile: result === 'found' ? best.profile || next.profile : '',
    };
  });
}

function lookupDateLabel(iso) {
  const match = /^\d{4}-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  const month = match ? Number(match[1]) : 0;
  return month >= 1 && month <= 12 ? MONTH_ABBR[month - 1] + ' ' + Number(match[2]) : '';
}

function peopleFirstName(entry = {}) {
  const raw = String(entry.name || path.basename(String(entry.file || ''), '.md'));
  const token = raw.split(/[_\s-]+/).find((part) => /[a-z]/i.test(part));
  return token ? token.charAt(0).toUpperCase() + token.slice(1).toLowerCase() : '';
}

function peopleLookupSentence(lookup, first = '') {
  const when = lookupDateLabel(lookup.date);
  const the = when ? 'The ' + when + ' LinkedIn lookup' : 'The LinkedIn lookup';
  switch (lookup.result) {
    case 'found':
      return the + ' found ' + (first ? first + "'s" : 'a') + ' profile' + (lookup.profile ? ' (linkedin.com/' + lookup.profile + ')' : '') + ' and saved the link.';
    case 'ambiguous':
      return the + ' found more than one possible profile, so none was attached.';
    case 'none':
      return the + ' found no profile.';
    case '':
      return the + ' was re-run and added nothing.';
    default:
      return the + ' did not find a usable profile.';
  }
}

const STUB_FACT_RES = [
  /^created from\b.*\bvoice identity flow\b/i,
  /\bhas not added (?:any )?(?:extra )?context\b/i,
  /\bno (?:extra )?context (?:yet|recorded|added)\b/i,
];

function crispPeopleFact(raw) {
  // A bare `linkedin: <profile url>` line: a link was added. When a lookup stamp
  // came with it, the lookup sentence already says so and this one is dropped.
  const profile = LINKEDIN_PROFILE_RE.exec(String(raw || '').trim().replace(/^[-*]\s+/, ''));
  if (profile) return { sentence: 'Added a LinkedIn profile link (linkedin.com/' + profile[1] + ').', kind: 'profile' };
  let s = cleanPeopleChangeText(raw)
    .replace(/^[-*]\s+/, '')
    .replace(/^\(?\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?\)?\s*(?:\([^)]*\))?\s*[-:–—]*\s*/, '')
    .replace(/^(?:fact|relationship context|what was new|new facts?|new content|note|summary|context)\s*:\s*/i, '')
    .replace(/^([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\s*:/, (_match, key) => key.replace(/_/g, ' ') + ':')
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

function nothingNewText(first) {
  return first ? 'Nothing new about ' + first + '.' : 'Nothing new here.';
}

// What the new information IS. `kind` says which shape it took: a real fact,
// an activity-log capture, a brand-new empty contact, a lookup that only left a
// stamp (read as one plain sentence), or stamps with nothing to say.
function summarizePeopleNewInformation(entry = {}) {
  const seen = new Set();
  const facts = [];
  let activity = null;
  let profileFact = '';
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
    if (crisp.kind === 'profile') {
      profileFact = profileFact || crisp.sentence;
      continue;
    }
    if (crisp.kind !== 'fact') continue;
    const key = crisp.sentence.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    facts.push(crisp.sentence);
  }
  const first = peopleFirstName(entry);
  const lookup = collectPeopleLookup(entry);
  // A lookup that found a profile IS new information; say what it found.
  if (lookup && lookup.result === 'found') facts.unshift(peopleLookupSentence(lookup, first));
  else if (profileFact) facts.push(profileFact);
  const created = Boolean(entry.createdInWindow) || stubCreated;
  if (facts.length) {
    let sentence = facts[0];
    if (facts.length > 1 && (sentence + facts[1]).length <= 240) {
      sentence = sentence.replace(/\.$/, '') + '; ' + facts[1];
    }
    return { kind: 'fact', newInformation: sentence, factCount: facts.length, lookup };
  }
  if (activity) return { kind: 'activity', newInformation: activity, factCount: 0, lookup };
  if (created || stubs > 0) {
    return { kind: 'created', newInformation: 'New contact file with no background recorded yet.', factCount: 0, lookup };
  }
  if (lookup) {
    return { kind: 'lookup', newInformation: nothingNewText(first) + ' ' + peopleLookupSentence(lookup, first), factCount: 0, lookup };
  }
  return { kind: 'stamps', newInformation: nothingNewText(first), factCount: 0, lookup: null };
}

function filterPeopleChangeEntry(entry = {}, { hours = 24, nowMs = Date.now() } = {}) {
  const file = entry.file || '';
  // Read the lookup before the freshness filter drops a stale-dated stamp line.
  const lookup = collectPeopleLookup(entry);
  const filtered = {
    ...entry,
    semanticSummary: freshPeopleSampleText(entry.semanticSummary, hours, file, nowMs),
    newContent: freshPeopleSampleText(entry.newContent, hours, file, nowMs),
    addedSample: freshPeopleSampleText(entry.addedSample, hours, file, nowMs),
  };
  if (lookup) filtered.lookups = [lookup];
  if (Array.isArray(entry.addedFacts)) {
    filtered.addedFacts = entry.addedFacts
      .map(String)
      .filter((part) => part.trim() && !isPlaceholderPeopleSamplePart(part))
      .filter((part) => peopleHistoryPartIsFresh(part, hours, nowMs))
      .filter((part) => !isUnsafePeopleSample(part, file));
  }
  return filtered;
}

// Nov 4 #otter (owner decision): the card states what changed in plain
// English, never line counts, "worth it" judgments or "(plus N more)". `added`,
// `deleted` and `lineCounts` stay on the result for callers; no renderer prints them.
function peopleChangeSummary(entry = {}, options = {}) {
  entry = filterPeopleChangeEntry(entry, options);
  const added = Number(entry.added || 0);
  const deleted = Number(entry.deleted || 0);
  const info = summarizePeopleNewInformation({ ...entry, added, deleted });
  const bookkeepingOnly = info.kind === 'lookup' || info.kind === 'stamps';
  return {
    added,
    deleted,
    lineCounts: '+' + added + '/-' + deleted + ' lines',
    kind: info.kind,
    lookup: info.lookup,
    // The new information itself; empty when the added lines carry none.
    factualChange: bookkeepingOnly ? '' : info.newInformation,
    bookkeepingOnly,
    whatChanged: info.newInformation,
    newInformation: info.newInformation,
    factCount: info.factCount,
  };
}

// Nov 4 #otter (owner decision): rows with a real fact are always named. A
// file whose only change is a lookup stamp is named too, up to a few, so the owner
// sees which contacts were checked; the rest, and files with only sync stamps,
// collapse into one line instead of one row each.
const MAX_NAMED_LOOKUP_ROWS = 3;

function peopleStampOnlyLine(count, lookupCount, hasNamedRows) {
  if (!count) return '';
  const kinds = lookupCount === 0 ? 'tracking stamps' : lookupCount === count ? 'lookup stamps' : 'lookup and tracking stamps';
  return count + (hasNamedRows ? ' other' : '') + ' people file' + (count === 1 ? ' got ' : 's got ') + kinds + ' only; nothing new.';
}

function groupPeopleChanges(entries = [], options = {}) {
  const factRows = [];
  const lookupRows = [];
  let stampOnly = 0;
  let stampOnlyLookups = 0;
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry) continue;
    const row = { entry, summary: peopleChangeSummary(entry, options) };
    if (!row.summary.bookkeepingOnly) factRows.push(row);
    else if (row.summary.kind === 'lookup' && lookupRows.length < MAX_NAMED_LOOKUP_ROWS) lookupRows.push(row);
    else {
      stampOnly += 1;
      if (row.summary.kind === 'lookup') stampOnlyLookups += 1;
    }
  }
  const named = [...factRows, ...lookupRows];
  return {
    named,
    withInfo: factRows.length,
    total: named.length + stampOnly,
    stampOnlyCount: stampOnly,
    stampOnlyLine: peopleStampOnlyLine(stampOnly, stampOnlyLookups, named.length > 0),
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
  isPeopleStampKeyLine,
  collectPeopleLookup,
  crispPeopleFact,
  summarizePeopleNewInformation,
  freshPeopleSampleText,
  freshPeopleSubjectText,
  filterPeopleChangeEntry,
  peopleChangeSummary,
  groupPeopleChanges,
};
