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
  createNewsStorySeen,
  STANDARD_CONTENT_NEWS_PRIORITY,
  orderedBriefingNewsCardIds,
};
