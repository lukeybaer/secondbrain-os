'use strict';

const ARCHIVE_TERMS = new Set(['gmail', 'email', 'mail', 'otter', 'transcript', 'linkedin', 'whatsapp']);

const PROJECT_STATUS_TERMS = new Set([
  'amy',
  'startup',
  'briefing',
  'claude',
  'codex',
  'dashboard',
  'graphiti',
  'venture',
  'ExampleCo',
  'ExampleCo',
  'resilience',
  'secondbrain',
  'client',
  'spine',
  'vapi',
  'voice',
]);

const STATUS_HINT_TERMS = new Set([
  'active',
  'current',
  'deploy',
  'deployment',
  'fix',
  'latest',
  'progress',
  'readiness',
  'recent',
  'repair',
  'scale',
  'scaleup',
  'scaling',
  'session',
  'status',
  'test',
  'thread',
  'work',
]);

function normalizeSearchText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeSpokenProjectAliases(value) {
  let text = ` ${normalizeSearchText(value)} `;
  text = text.replace(/\bcode\s+x\b/g, ' codex ');
  text = text.replace(/\b(?:coda|codec|codecs|kodak)\b/g, ' codex ');
  text = text.replace(/\bwashing\b/g, ' watch ');
  text = text.replace(/\bwatch(?:er|ing|ed|es)?\b/g, ' watch ');
  text = text.replace(/\bmonitor(?:ing|ed|s)?\b/g, ' monitor ');
  text = text.replace(/\bfix(?:ing|ed|es)?\b/g, ' fix ');
  text = text.replace(/\bself\s+heal(?:er|ing)?\b/g, ' self heal ');
  text = text.replace(/\bpixie\s+pixie\b/g, ' ExampleCo ');
  text = text.replace(/\bpixie\s+(deployment|deploy|scale|scaling|session|status|app|test)\b/g, ' ExampleCo $1 ');
  text = text.replace(
    /\b(?:pix\s*seat|ExampleCo|pix\s*seed|pixseed|pick\s*seat|big\s*speed|pix\s*speed|pig\s*seed|pig\s*speed|pigs?\s*yet|pigs?y\s*et|pigs?y\s*at|pigs?\s*at|pigsyet|picc\s*c|picc|pic\s*c)\b/g,
    ' ExampleCo ',
  );
  text = text.replace(/\bscale\s+up\b/g, ' scaleup ');
  return text.replace(/\s+/g, ' ').trim();
}

function normalizeSpineQueryForVoice(value) {
  return normalizeSpokenProjectAliases(value);
}

function spineQueryTerms(value) {
  return normalizeSpineQueryForVoice(value).split(/\s+/).filter(Boolean);
}

function isArchiveQueryTerms(terms = []) {
  return terms.some((term) => ARCHIVE_TERMS.has(term));
}

function isProjectStatusQueryTerms(terms = []) {
  if (!terms.length || isArchiveQueryTerms(terms)) return false;
  const hasProject = terms.some((term) => PROJECT_STATUS_TERMS.has(term));
  if (!hasProject) return false;
  return terms.length <= 3 || terms.some((term) => STATUS_HINT_TERMS.has(term));
}

function displaySpineQueryForVoice(rawQuery) {
  const normalized = normalizeSpineQueryForVoice(rawQuery);
  const raw = normalizeSearchText(rawQuery);
  return normalized && normalized !== raw ? normalized : String(rawQuery || '').trim();
}

// Spoken time phrases ("last night", "this morning") say WHEN a session ran,
// not what it was about. On the 2026-10-28 owner call "branch cleanliness
// session from last night" scored "last" and "night" as topic words, matched
// nothing on them, and a 33-day-old Codex record outranked the session that
// had run that evening. They are parsed into a window and kept out of scoring.
const CHICAGO_TZ = 'America/Chicago';

function chicagoOffsetMs(ms) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: CHICAGO_TZ,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(new Date(ms))
      .map((x) => [x.type, x.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

// A Central wall-clock hour on a day relative to now's, as epoch ms. Built in
// civil time, so 5 PM is 5 PM on a daylight saving change day too.
function chicagoDayStartMs(nowMs, dayOffset = 0, hour = 0) {
  const off = chicagoOffsetMs(nowMs);
  const local = new Date(nowMs + off);
  const wallLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + dayOffset, hour);
  // The offset at that wall time can differ from now's across a DST change.
  return wallLocal - chicagoOffsetMs(wallLocal - off);
}

// Order matters: "last night" before a bare "night", "yesterday evening"
// before "yesterday".
const SPOKEN_TIME_WINDOWS = [
  {
    key: 'last_night',
    re: /\b(?:last|yesterday)\s+(?:night|evening)(?:\s+s)?\b/g,
    start: (now) => chicagoDayStartMs(now, -1, 17),
    end: (now) => chicagoDayStartMs(now, 0, 6),
  },
  {
    key: 'yesterday',
    re: /\byesterday(?:\s+s)?\b/g,
    start: (now) => chicagoDayStartMs(now, -1),
    end: (now) => chicagoDayStartMs(now, 0),
  },
  {
    key: 'tonight',
    re: /\b(?:tonight(?:\s+s)?|this\s+evening)\b/g,
    start: (now) => chicagoDayStartMs(now, 0, 17),
  },
  { key: 'this_morning', re: /\bthis\s+morning(?:\s+s)?\b/g, start: (now) => chicagoDayStartMs(now, 0) },
  {
    key: 'today',
    re: /\b(?:earlier\s+)?today(?:\s+s)?\b|\bthis\s+afternoon\b/g,
    start: (now) => chicagoDayStartMs(now, 0),
  },
  {
    // "Six minutes ago", "an hour ago": something happened then, so the
    // session was touched since a little before it.
    key: 'ago',
    re: /\b(?:about\s+|like\s+|maybe\s+|around\s+)?(a\s+few|a\s+couple(?:\s+of)?|\d{1,3}|(?:twenty|thirty|forty|fifty)(?:\s+(?:one|two|three|four|five|six|seven|eight|nine))?|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|one|two|three|four|five|six|seven|eight|nine|ten|an?)\s+(minutes?|mins?|hours?)\s+ago\b/g,
    start: (now, match) => {
      const amount = spokenAmount(match[1]);
      const spanMs = amount * (/^h/.test(match[2]) ? 60 : 1) * 60 * 1000;
      return now - Math.max(2 * spanMs, spanMs + 15 * 60 * 1000);
    },
  },
];

const SPOKEN_AMOUNTS = {
  'a few': 5, 'a couple': 2, 'a couple of': 2, a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30,
  forty: 40, fifty: 50,
};

// "Twenty six" is 26, not 6.
function spokenAmount(text) {
  const words = String(text).trim().split(/\s+/).join(' ');
  if (/^\d+$/.test(words)) return Number(words);
  if (SPOKEN_AMOUNTS[words] !== undefined) return SPOKEN_AMOUNTS[words];
  return words.split(' ').reduce((sum, word) => sum + (SPOKEN_AMOUNTS[word] || 0), 0);
}

/**
 * The time window a spoken lookup names, or null. startMs is the earliest a
 * matching session can have been touched; a session still running since then
 * qualifies, because its last update is at or after the start. endMs, when
 * set, is the latest it can have begun ("yesterday" leaves out today's).
 */
function spokenTimeWindow(query, nowMs = Date.now()) {
  const text = normalizeSearchText(query);
  for (const w of SPOKEN_TIME_WINDOWS) {
    w.re.lastIndex = 0;
    const match = w.re.exec(text);
    if (!match) continue;
    const window = { key: w.key, startMs: w.start(nowMs, match) };
    if (w.end) window.endMs = w.end(nowMs);
    return window;
  }
  return null;
}

// The query with its time phrases removed, normalized.
function stripSpokenTimeWindow(query) {
  let text = normalizeSearchText(query);
  for (const w of SPOKEN_TIME_WINDOWS) {
    w.re.lastIndex = 0;
    text = text.replace(w.re, ' ');
  }
  return text.replace(/\s+/g, ' ').trim();
}

module.exports = {
  spokenTimeWindow,
  stripSpokenTimeWindow,
  chicagoDayStartMs,
  normalizeSearchText,
  normalizeSpineQueryForVoice,
  spineQueryTerms,
  isArchiveQueryTerms,
  isProjectStatusQueryTerms,
  displaySpineQueryForVoice,
};
