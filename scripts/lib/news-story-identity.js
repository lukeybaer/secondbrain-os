'use strict';

// Deterministic cross-publisher story identity for news headlines. URLs and
// literal titles cannot catch two publishers describing the same event with
// different wording. Keep this deliberately conservative: a match needs five
// shared, normalized event tokens and at least two-thirds coverage of the
// smaller headline.

const STORY_STOPWORDS = new Set(
  'about after again against ahead amid among and are asks been being before can did does for from has have how into its may more new not now off only our over says she than that the their them they this those through was were what when where which while who why will with would your'.split(
    /\s+/,
  ),
);

function normalizeStoryPhrases(text) {
  return String(text || '')
    // Preserve the distinction between the country abbreviation and the
    // ordinary pronoun "us" before lowercasing.
    .replace(/\bU\.?\s*S\.?\b/g, ' usgovernment ')
    .replace(/\bunited states(?: of america)?\b/gi, ' usgovernment ')
    .toLowerCase()
    .replace(/\b(?:donald\s+)?trump\b|\bwhite house\b/g, ' usgovernment ')
    .replace(/\btrade partners?\b|\bcommercial partners?\b/g, ' country ')
    .replace(/\bcountries\b|\bnations\b/g, ' country ')
    .replace(/\blevies\b|\blevy\b|\btariffs?\b/g, ' tariff ')
    .replace(/\brequests? for evidence\b/g, ' rfe ')
    .replace(/\bdenials?\b/g, ' deny ')
    .replace(/&[a-z#0-9]+;/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normalizeStoryToken(token) {
  let value = String(token || '').toLowerCase();
  if (value === 'science19') value = 'science';
  if (value === 'uscis') return value;
  if (/^impos(?:e|es|ed|ing)$/.test(value)) return 'impose';
  if (value.length > 5 && value.endsWith('ing')) value = value.slice(0, -3);
  if (value.length > 5 && value.endsWith('ed')) value = value.slice(0, -2);
  if (value.length > 5 && value.endsWith('es')) value = value.slice(0, -2);
  if (value.length > 4 && value.endsWith('s')) value = value.slice(0, -1);
  return value;
}

function normalizedStoryTitle(title) {
  return normalizeStoryPhrases(title).replace(/\s+/g, ' ').trim();
}

function canonicalNewsUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  try {
    const url = new URL(value);
    url.hash = '';
    url.search = '';
    return url.toString().replace(/\/$/, '').toLowerCase();
  } catch {
    return value
      .replace(/[?#].*$/, '')
      .replace(/\/$/, '')
      .toLowerCase();
  }
}

function newsStoryTitleTokens(title) {
  const tokens = normalizeStoryPhrases(title)
    .split(/\s+/)
    .map(normalizeStoryToken)
    .filter((token) => (token.length >= 4 || token === 'rfe') && !STORY_STOPWORDS.has(token));
  return new Set(tokens);
}

function significantStoryNumbers(title) {
  // Accept common magnitude suffixes without dropping the decimal. The old
  // trailing word boundary parsed "$15.5M" as "15" because 5 and M are both
  // word characters, weakening quantified-event identity.
  return new Set(
    (String(title || '').match(/\b\d+(?:\.\d+)?(?=[a-z]?\b)/gi) || []).map((number) =>
      number.toLowerCase(),
    ),
  );
}

function tokenOverlap(left, right) {
  let overlap = 0;
  for (const token of left || []) if (right && right.has(token)) overlap += 1;
  return overlap;
}

function newsStoriesSemanticallyDuplicate(leftTitle, rightTitle) {
  const leftNumbers = significantStoryNumbers(leftTitle);
  const rightNumbers = significantStoryNumbers(rightTitle);
  if (leftNumbers.size && rightNumbers.size) {
    const sameNumbers =
      leftNumbers.size === rightNumbers.size &&
      [...leftNumbers].every((number) => rightNumbers.has(number));
    const sharedDistinctiveDecimal = [...leftNumbers].some(
      (number) => number.includes('.') && rightNumbers.has(number),
    );
    if (!sameNumbers && !sharedDistinctiveDecimal) return false;
  }
  const left = newsStoryTitleTokens(leftTitle);
  const right = newsStoryTitleTokens(rightTitle);
  const smaller = Math.min(left.size, right.size);
  const overlap = tokenOverlap(left, right);
  // Local rewrites of a quantified event often add only a state or publisher
  // angle, leaving three shared subject/event tokens plus the same distinctive
  // amount. Requiring five shared words treated each syndicated report as a new
  // story and spent the bounded Finance summary budget on the same settlement.
  // A local headline may add a jurisdiction count such as "46 states" while
  // retaining the event's distinctive decimal settlement amount.
  const sameDistinctiveDecimal = [...leftNumbers].some(
    (number) => number.includes('.') && rightNumbers.has(number),
  );
  const sameQuantifiedEvent =
    sameDistinctiveDecimal &&
    overlap >= 3;
  if (sameQuantifiedEvent) return true;
  // Policy publishers described the same USCIS policy as either restored
  // authority to deny without first sending an RFE or immediate denial authority
  // without an RFE. The ordinary five-token floor misses that compact agency,
  // action, and instrument identity even though it is one material development.
  const sameUscisRfeDenial =
    left.has('uscis') &&
    right.has('uscis') &&
    left.has('rfe') &&
    right.has('rfe') &&
    left.has('deny') &&
    right.has('deny');
  if (sameUscisRfeDenial) return true;
  if (smaller < 5) return false;
  return overlap >= 5 && overlap / smaller >= 0.67;
}

function newsStoriesDuplicate(left = {}, right = {}) {
  const leftTitle = String(left.title || '');
  const rightTitle = String(right.title || '');
  const leftUrl = canonicalNewsUrl(left.url);
  const rightUrl = canonicalNewsUrl(right.url);
  return Boolean(
    (leftUrl && rightUrl && leftUrl === rightUrl) ||
      (normalizedStoryTitle(leftTitle) &&
        normalizedStoryTitle(leftTitle) === normalizedStoryTitle(rightTitle)) ||
      newsStoriesSemanticallyDuplicate(leftTitle, rightTitle),
  );
}

// ---------------------------------------------------------------------------
// Cross-day identity (2026-11-02, S-3). Yesterday's stories used to be blocked
// only when the canonical URL matched, so the same event from another outlet
// ran again. A candidate now repeats a prior-day story when it is the same
// story by newsStoriesDuplicate (URL, normalized title, or semantic title) or
// when the written lead sentences describe the same event.
//
// A repeat stays ALLOWED only when it cites a genuinely new development:
//   1. its title/lead names a calendar date (e.g. "Nov. 2", "2026-11-02") that
//      is strictly after the prior story's rendered date and not after the run
//      date, or
//   2. its title/lead carries a follow-on event word (appeal, overturn, block,
//      sue, indict, arrest, resign, veto, withdraw, recall, settle, sentence,
//      convict, ceasefire) that the prior story's title/lead does not.
// Anything else is the same news again and is rejected.

const MONTH_INDEX = Object.freeze({
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
});
const MONTH_DAY_RE =
  /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/g;
const ISO_DATE_RE = /\b(20\d{2})-(\d{2})-(\d{2})\b/g;
const FOLLOW_ON_EVENT_RE =
  /\b(?:appeal(?:s|ed|ing)?|overturn(?:s|ed|ing)?|struck down|strikes down|blocked|blocks|sues|sued|lawsuit|indict(?:s|ed|ment)?|arrest(?:s|ed)?|resign(?:s|ed)?|veto(?:es|ed)?|withdraws|withdrew|recalls?|recalled|settles|settled|sentenced|convicted|ceasefire)\b/gi;

function isoDay(year, monthIndex, day) {
  const value = new Date(Date.UTC(year, monthIndex, day));
  if (value.getUTCMonth() !== monthIndex || value.getUTCDate() !== day) return '';
  return value.toISOString().slice(0, 10);
}

function citedDates(text, asOfDate) {
  const source = String(text || '');
  const year = Number(String(asOfDate || '').slice(0, 4)) || new Date().getUTCFullYear();
  const dates = new Set();
  for (const match of source.matchAll(MONTH_DAY_RE)) {
    const month = MONTH_INDEX[match[1].slice(0, 3).toLowerCase()];
    const value = isoDay(year, month, Number(match[2]));
    if (value) dates.add(value);
  }
  for (const match of source.matchAll(ISO_DATE_RE)) {
    const value = isoDay(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    if (value) dates.add(value);
  }
  return dates;
}

function followOnEvents(text) {
  return new Set(
    (String(text || '').match(FOLLOW_ON_EVENT_RE) || []).map((word) =>
      normalizeStoryToken(word.toLowerCase()),
    ),
  );
}

function storyText(story = {}) {
  return `${story.title || ''} ${story.lead || story.summary || ''} ${story.evidence || ''}`;
}

// A period after one of these is an abbreviation ("On Nov. 2, ..."), not the
// end of the sentence.
const ABBREVIATION_BEFORE_PERIOD_RE =
  /(?:\b(?:Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|No|St|Mr|Mrs|Ms|Dr|Sen|Rep|Gov|Gen|Lt|Col|Inc|Corp|Co|Ltd|vs)|\b[A-Z])$/;

// First sentence of a summary or tile body, capped so history files stay small.
function storyLead(text, max = 280) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  const ends = /[.!?](?=\s|$)/g;
  let match;
  while ((match = ends.exec(flat))) {
    if (match[0] === '.' && ABBREVIATION_BEFORE_PERIOD_RE.test(flat.slice(0, match.index))) continue;
    return flat.slice(0, match.index + 1).slice(0, max);
  }
  return flat.slice(0, max);
}

function citesNewDevelopment(candidate, prior, asOfDate) {
  const priorDate = String(prior.date || '');
  const priorText = storyText(prior);
  const candidateText = storyText(candidate);
  if (priorDate) {
    for (const cited of citedDates(candidateText, asOfDate)) {
      if (cited > priorDate && (!asOfDate || cited <= asOfDate)) return true;
    }
  }
  const priorEvents = followOnEvents(priorText);
  for (const event of followOnEvents(candidateText)) if (!priorEvents.has(event)) return true;
  return false;
}

function sameStoryAcrossDays(candidate, prior) {
  if (newsStoriesDuplicate(candidate, prior)) return true;
  const candidateLead = String(candidate.lead || candidate.summary || '');
  const priorLead = String(prior.lead || prior.summary || '');
  if (candidateLead && priorLead && newsStoriesSemanticallyDuplicate(candidateLead, priorLead)) {
    return true;
  }
  return Boolean(
    (candidateLead && newsStoriesSemanticallyDuplicate(candidateLead, prior.title)) ||
      (priorLead && newsStoriesSemanticallyDuplicate(candidate.title, priorLead)),
  );
}

// Returns the prior-day story the candidate repeats, or null when it is new or
// is a repeat that cites a new dated development.
function findPriorStoryRepeat(candidate, priorStories = [], { asOfDate = '' } = {}) {
  const row = {
    title: String((candidate && candidate.title) || ''),
    url: candidate && (candidate.url || candidate.link),
    lead: (candidate && (candidate.lead || candidate.summary)) || '',
    // Production rows carry the new development in excerpt/sourceText rather
    // than a written lead; their opening sentences count as dated evidence.
    evidence: candidate
      ? [candidate.excerpt, candidate.sourceText].map((text) => storyLead(text)).filter(Boolean).join(' ')
      : '',
  };
  if (!row.title && !row.url) return null;
  for (const prior of priorStories || []) {
    if (!prior || (asOfDate && String(prior.date || '') >= asOfDate)) continue;
    if (!sameStoryAcrossDays(row, prior)) continue;
    if (citesNewDevelopment(row, prior, asOfDate)) continue;
    return prior;
  }
  return null;
}

// Evergreen rate tables, comparison pages and "best X" listicles are not news
// (2026-11-02: three Canadian rate-table pages became one Bank of Canada
// headline on the Finance card). Deterministic title and URL patterns only.
const EVERGREEN_TITLE_PATTERNS = Object.freeze([
  /\btoday'?s\s+(?:[\w-]+\s+){0,3}rates?\b/i,
  /^current\s+(?:[\w-]+\s+){0,3}rates?\b/i,
  /\bbest\s+(?:\w+\s+){0,4}(?:rates?|lenders|banks|accounts?|cards?|brokers|companies)\b/i,
  /^(?:the\s+)?\d+\s+best\b/i,
  /\brates?\s+(?:comparison|compared|table|chart|tracker)\b/i,
  /\bcompare\s+(?:\w+\s+){0,3}rates?\b/i,
  /\b[\w-]+\s+vs\.?\s+[\w-]+\s+(?:[\w-]+\s+)?rates?\b/i,
]);
// "rates today" also reads as an event headline ("Fed cuts interest rates today
// after emergency meeting"); it marks a rate table only without an event cue.
const RATES_TODAY_RE = /\brates?\s+today\b/i;
const RATE_EVENT_CUE_RE =
  /\b(?:cuts?|raises?|raised|hikes?|hiked|slash(?:es|ed)?|lowers?|lowered|announces?|announced|emergency|after|amid|following)\b/i;
const EVERGREEN_URL_PATTERNS = Object.freeze([
  /\/(?:compare|comparison|rate-table|rates-table|current-rates|todays-rates|best-[a-z-]*rates)(?:[/-]|$)/i,
  /\/(?:finance-|cd-|savings-|refinance-)?rates\/?$/i,
]);

function isEvergreenRatePage(row = {}) {
  const title = String(row.title || '');
  let pathname = '';
  try {
    pathname = new URL(String(row.url || row.link || '')).pathname;
  } catch {
    pathname = '';
  }
  return (
    EVERGREEN_TITLE_PATTERNS.some((pattern) => pattern.test(title)) ||
    (RATES_TODAY_RE.test(title) && !RATE_EVENT_CUE_RE.test(title)) ||
    Boolean(pathname && EVERGREEN_URL_PATTERNS.some((pattern) => pattern.test(pathname)))
  );
}

function createNewsStorySeen({ titleForRow = (row) => row && row.title } = {}) {
  const seenRows = [];
  const identity = (row) => ({
    title: String(titleForRow(row) || ''),
    url: canonicalNewsUrl(row && row.url),
  });
  return {
    collides(row) {
      const candidate = identity(row);
      return Boolean(
        candidate.title && seenRows.some((seen) => newsStoriesDuplicate(candidate, seen)),
      );
    },
    register(row) {
      const candidate = identity(row);
      if (!candidate.title || seenRows.some((seen) => newsStoriesDuplicate(candidate, seen))) return;
      seenRows.push(candidate);
    },
  };
}

const STANDARD_CONTENT_NEWS_PRIORITY = Object.freeze([
  'ai_tech_news',
  'us_news',
  'world_news',
  'us_policy_news',
  'finance_industry_news',
  'science_news',
  'ExampleCo_news',
  'other_news',
]);

function orderedBriefingNewsCardIds(allNewsCardIds = [], mentionOrZeroId = '') {
  const requested = new Set((allNewsCardIds || []).map(String).filter(Boolean));
  const order = STANDARD_CONTENT_NEWS_PRIORITY.filter((id) => requested.has(id));
  const employerId = String(mentionOrZeroId || '');
  if (employerId && requested.has(employerId)) {
    const scienceIndex = order.indexOf('science_news');
    order.splice(scienceIndex >= 0 ? scienceIndex : order.length, 0, employerId);
  }
  for (const id of requested) if (!order.includes(id)) order.push(id);
  return order;
}

module.exports = {
  normalizeStoryPhrases,
  normalizeStoryToken,
  normalizedStoryTitle,
  canonicalNewsUrl,
  newsStoryTitleTokens,
  significantStoryNumbers,
  tokenOverlap,
  newsStoriesSemanticallyDuplicate,
  newsStoriesDuplicate,
  storyLead,
  citedDates,
  findPriorStoryRepeat,
  isEvergreenRatePage,
  createNewsStorySeen,
  STANDARD_CONTENT_NEWS_PRIORITY,
  orderedBriefingNewsCardIds,
};
