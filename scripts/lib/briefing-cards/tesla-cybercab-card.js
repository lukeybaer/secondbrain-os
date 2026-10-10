'use strict';

// scripts/lib/briefing-cards/tesla-cybercab-card.js
//
// W6 generator merge, card 6 (last of the first six, per the Codex
// 2026-07-12 order: live-check-adjacent cards go last). The TESLA CYBER CAB
// RESERVATION WATCH render, its triangulation sources, and the pure
// projected-date triangulation moved VERBATIM out of
// scripts/cloud-morning-briefing.js; BOTH generators consume THIS module.
// The live official/X fetches stay in the leaf cybercab-evidence module
// (live fetches never live in shared card render modules); they feed in through
// options.officialEvidence/options.xEvidence, and the
// no-evidence branch renders the honest monitoring copy. The desktop
// generator retires its old RSS-headline scan for this card: the answer-first
// triangulated shape below is the ExampleCo-approved 2026-07-07 card.

const { legacySection } = require('./card-format.js');
const { CYBERCAB_X_CHECK_UNAVAILABLE } = require('../cybercab-contract.js');

const TITLE = 'TESLA CYBER CAB RESERVATION WATCH';

const CYBERCAB_RESERVE_URL = 'https://www.tesla.com/cybercab';
const CYBERCAB_OFFICIAL_ROBOTAXI_URL = 'https://www.tesla.com/support/robotaxi';
const CYBERCAB_OFFICIAL_PRODUCTION_URL =
  'https://ir.tesla.com/_flysystem/s3/sec/000162828026049213/tsla-20260722-gen.pdf';
const CYBERCAB_OFFICIAL_Q2_10Q_URL =
  'https://ir.tesla.com/_flysystem/s3/sec/000162828026049270/tsla-20260630-gen.pdf';
const CYBERCAB_TESLA_X_URL = 'https://x.com/Tesla/status/2071810353156194719';
const CYBERCAB_ELON_X_URL = 'https://x.com/elonmusk/status/2047574971774611553';
const CYBERCAB_TECHCRUNCH_URL =
  'https://techcrunch.com/2026/07/22/tesla-spending-skyrockets-as-cybercab-semi-megapack-production-timeline-slips/';

// Triangulation sources for the projected Cybercab consumer-reservation /
// release date (ExampleCo 2026-07-07: the card "must cite the actual sources it used
// ... each with a working link, and triangulate the projected date across
// them"). Each entry is a REAL, fetched source with the specific dated claim it
// supports. These are the evidence the date range below is triangulated from --
// not a fabricated estimate. Verified reachable 2026-07-07 (see
// tesla-cybercab-triangulation-node-test.js, which asserts every url is a
// well-formed https link and each entry carries a datedClaim). When a claim is
// superseded, update the entry here and the triangulation recomputes.
const CYBERCAB_DATE_SOURCES = [
  {
    label: 'Tesla Q2 2026 shareholder update -- Cybercab production began',
    url: CYBERCAB_OFFICIAL_PRODUCTION_URL,
    datedClaim:
      'Tesla reported on July 22, 2026 that Cybercab began production at Gigafactory Texas during Q2 2026.',
    signals: { productionStart: '2026-06' },
    publishedAt: '2026-07-22T00:00:00.000Z',
  },
  {
    label: 'Tesla Q2 2026 Form 10-Q -- production began in the first half',
    url: CYBERCAB_OFFICIAL_Q2_10Q_URL,
    datedClaim:
      'Tesla stated in its quarter ended June 30, 2026 filing that it began production of Cybercab in the first half of 2026.',
    signals: { productionStart: '2026-06' },
    publishedAt: '2026-07-22T00:00:00.000Z',
  },
  {
    label: 'Tesla Q1 2026 Form 10-Q -- pilot production milestone',
    url: 'https://ir.tesla.com/_flysystem/s3/sec/000162828026026673/tsla-20260331-gen.pdf',
    datedClaim:
      'Tesla stated in its quarter ended March 31, 2026 filing that pilot production of Cybercab began in Q1 2026.',
    signals: { pilotProductionStart: '2026-03' },
    publishedAt: '2026-04-23T00:00:00.000Z',
  },
  {
    label: 'Tesla on X -- first production Cybercab engineering tests',
    url: CYBERCAB_TESLA_X_URL,
    datedClaim:
      'Tesla said on June 30, 2026 that engineering tests of the first production Cybercab had begun in Austin.',
    signals: { engineeringTestStart: '2026-06' },
    publishedAt: '2026-06-30T00:00:00.000Z',
  },
  {
    label: 'Elon Musk on X -- Cybercab production started',
    url: CYBERCAB_ELON_X_URL,
    datedClaim:
      'Elon Musk said on April 24, 2026 that Cybercab production had started.',
    signals: { productionStart: '2026-04' },
    publishedAt: '2026-04-24T00:00:00.000Z',
  },
  {
    label: 'TechCrunch -- Tesla volume-production timeline slipped',
    url: CYBERCAB_TECHCRUNCH_URL,
    datedClaim:
      'TechCrunch reported from Tesla management commentary on July 22, 2026 that Tesla no longer expected Cybercab volume production during 2026.',
    signals: { volumeProductionNotExpectedBefore: '2027-01' },
    publishedAt: '2026-07-22T00:00:00.000Z',
  },
];

// Triangulate the projected consumer reservation / release window from the
// dated claims above. Returns { rangeStart, rangeEnd, mostLikely, reasoning }.
// Deterministic (no network): the range spans the earliest volume-production
// signal to the latest confirmed consumer-sale signal; most-likely is the point
// where volume production and consumer availability overlap. Kept as data + a
// pure function so the test can assert the shape and the reasoning traces to the
// sources, never a hardcoded guess.
function triangulateCyberCabDate(sources = CYBERCAB_DATE_SOURCES) {
  const list = Array.isArray(sources) ? sources : [];
  const pilotStarts = list
    .map((s) => s.signals && s.signals.pilotProductionStart)
    .filter(Boolean)
    .sort();
  const productionStarts = list
    .map((s) => s.signals && s.signals.productionStart)
    .filter(Boolean)
    .sort();
  const rangeStart = productionStarts[0] || pilotStarts[0] || '2026-06';
  const rangeEnd = 'UNANNOUNCED';
  const mostLikely = 'not yet supportable from official evidence';
  const consumerTimingSources = list.filter(
    (source) =>
      source?.legitimate === true &&
      ['orders_open_now', 'future_consumer_date', 'consumer_timing_unknown'].includes(
        String(source?.timingClassification || ''),
      ),
  );
  const reasoning = consumerTimingSources.length
    ? `Jev identified ${consumerTimingSources.length} current X post${consumerTimingSources.length === 1 ? '' : 's'} that directly address public consumer timing; the cited evidence carries their classifications, confidence, and direct links. ` +
      'They can inform the timing watch, but production or social evidence alone cannot prove that ordering is open; only a live official Tesla order surface can do that.'
    : 'Tesla filings and public X posts show pilot units, production work, and engineering tests, ' +
      'while July management commentary says volume production is no longer expected during 2026. ' +
      'None of those sources announces consumer reservations or sales. Production progress is a launch-readiness signal, not proof that consumer ordering is open, so the card must not invent a release window.';
  return { rangeStart, rangeEnd, mostLikely, reasoning };
}

function cyberCabTriangulationLines(
  sources = CYBERCAB_DATE_SOURCES,
  decisionSources = sources,
) {
  const tri = triangulateCyberCabDate(decisionSources);
  const sourceUrls = new Set(sources.map((source) => String(source?.url || '')));
  const decisionUrls = new Set(decisionSources.map((source) => String(source?.url || '')));
  const sameSourceSet =
    sourceUrls.size === decisionUrls.size && [...sourceUrls].every((url) => decisionUrls.has(url));
  const lines = [
    `Production status: began in Q2 2026. Consumer reservation/release: ${tri.rangeEnd}; official evidence does not support a projected consumer date.`,
    `Why: ${tri.reasoning}`,
    `Sources triangulated (${sources.length}):`,
  ];
  if (!sameSourceSet) {
    lines.push(`Evidence set: ${sources.length} citations shown; ${decisionSources.length} sources evaluated.`);
  }
  for (const s of sources) {
    lines.push(`  - ${s.label}: ${s.url}`);
    lines.push(`    ${s.datedClaim}`);
  }
  return lines;
}

function isXPostSource(source) {
  return /^https:\/\/(?:www\.)?x\.com\//i.test(String(source?.url || ''));
}

const CYBERCAB_DISPLAY_FOUNDATION_URLS = Object.freeze([
  CYBERCAB_OFFICIAL_PRODUCTION_URL,
  CYBERCAB_TECHCRUNCH_URL,
]);

function cyberCabSourcesForRun(xEvidence = null) {
  const staticX = CYBERCAB_DATE_SOURCES.filter(isXPostSource);
  const foundation = CYBERCAB_DISPLAY_FOUNDATION_URLS.map((url) =>
    CYBERCAB_DATE_SOURCES.find((source) => source.url === url),
  );
  const missingFoundationUrl = CYBERCAB_DISPLAY_FOUNDATION_URLS.find(
    (_url, index) => !foundation[index],
  );
  if (missingFoundationUrl) {
    throw new Error(`Cybercab display foundation source is missing: ${missingFoundationUrl}`);
  }
  const discovered = Array.isArray(xEvidence?.sources)
    ? xEvidence.sources.filter(isXPostSource)
    : [];
  const discoveredUrls = new Set(discovered.map((source) => source.url));
  const xSources = [];
  const seen = new Set();
  // A successful current search is never padded with stale pinned X posts.
  // Static posts remain useful fallback context only when discovery produced
  // no current candidates at all.
  for (const source of discovered.length ? discovered : staticX) {
    const url = String(source?.url || '').trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    xSources.push(source);
    if (xSources.length >= 5) break;
  }
  const searchedAtMs = Date.parse(String(xEvidence?.searchedAt || ''));
  const hasNewAuthoritativeTiming = discovered.some(
    (source) =>
      source?.authoritativeDatedTiming === true &&
      Number(source?.authorityConfidence || 0) >= 60,
  );
  const visibleFoundation = hasNewAuthoritativeTiming && Number.isFinite(searchedAtMs)
    ? foundation.filter((source) => {
        const publishedAtMs = Date.parse(String(source?.publishedAt || ''));
        return Number.isFinite(publishedAtMs) && searchedAtMs - publishedAtMs <= 60 * 24 * 60 * 60 * 1000;
      })
    : foundation;
  const sources = [...visibleFoundation, ...xSources];
  const decisionSources = [];
  const decisionSeen = new Set();
  for (const source of [...CYBERCAB_DATE_SOURCES, ...discovered]) {
    const url = String(source?.url || '').trim();
    if (!url || decisionSeen.has(url)) continue;
    decisionSeen.add(url);
    decisionSources.push(source);
  }
  const xCount = sources.filter(isXPostSource).length;
  const currentXCount = sources.filter((source) => discoveredUrls.has(source.url)).length;
  const attempted = xEvidence?.attempted === true || xEvidence?.checked === true;
  const checked = xEvidence?.checked === true;
  const reportedCandidateCount = Number(xEvidence?.candidateCount);
  const candidateCount = Number.isFinite(reportedCandidateCount) && reportedCandidateCount >= 0
    ? reportedCandidateCount
    : Array.isArray(xEvidence?.candidates)
      ? xEvidence.candidates.length
      : null;
  // Finding nothing relevant after a complete search is a healthy monitoring
  // result. Red is reserved for a pipeline failure: incomplete discovery, or
  // candidates that were collected but never successfully classified by Jev.
  const jevComplete =
    candidateCount === 0 ||
    (xEvidence?.jevAttempted === true && xEvidence?.jevChecked === true);
  const pipelineOk = checked && jevComplete;
  const mixReason = !attempted
    ? xEvidence?.reason || 'Current X discovery did not run in this render path.'
    : !checked
      ? xEvidence?.reason || 'The current public-X search did not return a verifiable result.'
      : candidateCount === null
        ? "The current X search receipt omitted its candidate count, so Jev coverage cannot be verified."
      : candidateCount > 0 && xEvidence?.jevAttempted !== true
        ? `The current X search collected ${candidateCount} candidates, but Jev did not run.`
      : candidateCount > 0 && xEvidence?.jevChecked !== true
        ? `The current X search collected ${candidateCount} candidates, but Jev ranking failed.`
      : currentXCount === 0
        ? candidateCount === 0
          ? 'The current X search completed and found no recent Cybercab candidates.'
          : `The current X search and Jev review completed; none of ${candidateCount} candidates qualified as authoritative timing evidence.`
        : `The current X search and Jev review completed; Jev approved ${currentXCount} source${currentXCount === 1 ? '' : 's'} for citation.`;
  return {
    sources,
    decisionSources,
    xCount,
    currentXCount,
    attempted,
    checked,
    ok: pipelineOk,
    reason: mixReason,
  };
}

function xApiConfigured(env = process.env, credentialResolver = null) {
  const direct = Boolean(
    env.X_API_BEARER_TOKEN ||
      env.X_BEARER_TOKEN ||
      (env.X_API_KEY && env.X_API_SECRET) ||
      (env.TWITTER_API_KEY && env.TWITTER_API_SECRET),
  );
  if (direct) return true;
  const liveCloud =
    process.platform === 'linux' &&
    String(env.SECONDBRAIN_DATA_DIR || '').startsWith('/opt/secondbrain');
  if (!credentialResolver && !liveCloud) return false;
  try {
    const resolve =
      credentialResolver || require('../credential-broker.js').resolveCredential;
    return Boolean(resolve('x', 'bearerToken')?.present);
  } catch {
    return false;
  }
}

function chicagoTimestampParts(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const values = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    })
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  const monthNumber = {
    January: '01',
    February: '02',
    March: '03',
    April: '04',
    May: '05',
    June: '06',
    July: '07',
    August: '08',
    September: '09',
    October: '10',
    November: '11',
    December: '12',
  }[values.month];
  if (!monthNumber) return null;
  if (!['AM', 'PM'].includes(values.dayPeriod)) return null;
  const hour12 = Number(values.hour);
  if (!Number.isFinite(hour12) || !values.minute) return null;
  const hour24 =
    values.dayPeriod === 'AM'
      ? hour12 === 12
        ? 0
        : hour12
      : hour12 === 12
        ? 12
        : hour12 + 12;
  return {
    date: `${values.year}-${monthNumber}-${String(values.day).padStart(2, '0')}`,
    hour24,
    label: `${values.month} ${values.day}, ${values.year} at ${values.hour}:${values.minute} ${values.dayPeriod} CT`,
  };
}

function nextIsoDate(value) {
  const date = new Date(`${value}T12:00:00.000Z`);
  if (!Number.isFinite(date.getTime())) return '';
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function cyberCabXCoverage(xEvidence = null, cardDate = '') {
  const empty = {
    included: false,
    usable: false,
    complete: null,
    healerExcluded: false,
    line: '',
    searchedAt: null,
    queryCount: null,
    reached: null,
    rawXLinksSeen: null,
    decodeFailures: null,
  };
  if (xEvidence?.attempted !== true && xEvidence?.checked !== true) return empty;
  const finiteNonnegative = (value) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  const queryCount = finiteNonnegative(xEvidence?.queryCount);
  const reached = finiteNonnegative(xEvidence?.reached);
  const rawXLinksSeen = finiteNonnegative(xEvidence?.rawXLinksSeen);
  const decodeFailures = finiteNonnegative(xEvidence?.decodeFailures);
  const searchedAt =
    typeof xEvidence?.searchedAt === 'string' && xEvidence.searchedAt.trim()
      ? xEvidence.searchedAt.trim()
      : null;
  const sourcesPresent = Array.isArray(xEvidence?.sources);
  const candidateCount =
    finiteNonnegative(xEvidence?.candidateCount) ??
    (Array.isArray(xEvidence?.candidates) ? xEvidence.candidates.length : null);
  const transportCause = Array.isArray(xEvidence?.transportErrors)
    ? String(xEvidence.transportErrors.find(Boolean) || '').trim()
    : '';
  const transportCauseSuffix = transportCause ? ` Cause: ${transportCause}` : '';
  const missing = [
    !searchedAt ? 'search time' : '',
    queryCount === null ? 'query count' : '',
    reached === null ? 'reached count' : '',
    rawXLinksSeen === null ? 'raw-link count' : '',
    decodeFailures === null ? 'redirect-decode failure count' : '',
    !sourcesPresent ? 'sources list' : '',
  ].filter(Boolean);
  if (missing.length || queryCount < 1) {
    return {
      ...empty,
      included: true,
      // Missing receipt fields are our producer-contract defect, not proof of
      // an upstream transport refusal. Keep this healer-eligible and describe
      // it as internal repair on the face.
      healerExcluded: false,
      line: missing.length
        ? "X search coverage unavailable: Amy's search receipt was incomplete, so coverage cannot be verified."
        : 'X search coverage unavailable: the check was configured with zero queries.',
    };
  }
  if (reached > queryCount) {
    return {
      ...empty,
      included: true,
      line: `X search coverage unavailable: the check recorded ${reached} reached queries out of ${queryCount}, which is inconsistent.${transportCauseSuffix}`,
    };
  }
  const timestamp = chicagoTimestampParts(searchedAt);
  if (!timestamp) {
    return {
      ...empty,
      included: true,
      line: 'X search coverage unavailable: the search time was not a parseable timestamp.',
    };
  }
  if (cardDate && timestamp.date !== cardDate) {
    const validNextDayWindow =
      timestamp.hour24 >= 23 && nextIsoDate(timestamp.date) === cardDate;
    if (!validNextDayWindow) {
      return {
        ...empty,
        included: true,
        line: `X search coverage unavailable: the search receipt is for ${timestamp.date}, not the card date ${cardDate}.`,
      };
    }
    // The briefing's next-day work window opens at 11 PM CT. A receipt from
    // 11:00-11:59 PM on D-1 legitimately belongs to the D card.
  }
  if (decodeFailures > 0) {
    return {
      included: true,
      usable: false,
      complete: false,
      healerExcluded: reached < queryCount,
      searchedAt,
      queryCount,
      reached,
      rawXLinksSeen,
      decodeFailures,
      line:
        `X search coverage unavailable: ${decodeFailures} result redirect URL${decodeFailures === 1 ? '' : 's'} could not be decoded; ${reached}/${queryCount} queries reached a verifiable result page.` +
        (reached < queryCount ? transportCauseSuffix : ''),
    };
  }
  if (xEvidence?.checked !== true) {
    if (reached === queryCount) {
      return {
        ...empty,
        included: true,
        line: `X search coverage unavailable: all ${queryCount} queries were reached but the producer marked the check incomplete, which is inconsistent.`,
      };
    }
    return {
      included: true,
      usable: false,
      complete: false,
      healerExcluded: true,
      searchedAt,
      queryCount,
      reached,
      rawXLinksSeen,
      decodeFailures,
      line:
        `X search coverage unavailable: the current check did not complete; ${reached}/${queryCount} queries reached a verifiable result page.` +
        transportCauseSuffix,
    };
  }
  if (reached < 1) {
    return {
      ...empty,
      included: true,
      line: `X search coverage unavailable: the check was marked complete but reached 0 of ${queryCount} result pages, which is inconsistent.${transportCauseSuffix}`,
    };
  }
  if (reached !== queryCount) {
    return {
      included: true,
      usable: false,
      complete: false,
      healerExcluded: true,
      searchedAt,
      queryCount,
      reached,
      rawXLinksSeen,
      decodeFailures,
      line: `X search coverage unavailable: only ${reached}/${queryCount} configured queries reached a verifiable result page, so no all-search absence claim is valid.${transportCauseSuffix}`,
    };
  }
  if (candidateCount === null) {
    return {
      ...empty,
      included: true,
      healerExcluded: false,
      line: "X search coverage unavailable: Amy's search receipt omitted its candidate count, so Jev coverage cannot be verified.",
    };
  }
  const qualifying = xEvidence.sources.length;
  const rankedCount = Array.isArray(xEvidence.rankedSources) ? xEvidence.rankedSources.length : 0;
  const jevSuffix = xEvidence.jevAttempted
    ? xEvidence.jevChecked
      ? ` Jev evaluated ${candidateCount} candidates, retained the top ${rankedCount}, and approved ${qualifying} as legitimate qualifying timing evidence.`
      : ` Jev ranking failed, so no unclassified candidate was promoted.${xEvidence.jevError ? ` ${String(xEvidence.jevError).slice(0, 180)}` : ''}`
    : candidateCount > 0
      ? ' Jev did not run, so no unclassified candidate was promoted.'
      : '';
  return {
    included: true,
    usable: true,
    complete: true,
    healerExcluded: false,
    searchedAt,
    queryCount,
    reached,
    rawXLinksSeen,
    decodeFailures,
    line:
      `X search coverage: ${reached}/${queryCount} queries returned verifiable result pages as of ${timestamp.label}; ` +
      `${rawXLinksSeen} direct X link matches seen; ${candidateCount} unique recent candidates collected; ${qualifying} qualifying posts retained for citation.${jevSuffix}`,
  };
}

function officialEvidenceSupportsVerdict(officialEvidence = null) {
  if (!officialEvidence || officialEvidence.checked !== true) return false;
  if (officialEvidence.open === 'YES') return true;
  const monitored = Number(officialEvidence.monitored);
  const reached = Number(officialEvidence.reached);
  return officialEvidence.open === 'NO' && monitored > 0 && reached === monitored;
}

// ExampleCo, 2026-09-25: "The evidence for the Tesla Cyber Cab, all of it is really
// old. Aren't you getting stuff from X? I want you to be citing evidence about
// people talking about it ... credible people." The daily X search already
// finds recent posts and Jev scores each author's credibility; only posts that
// announce consumer timing were ever shown. This lists the newest credible
// posts from the last 7 days as commentary, never as order evidence.
const RECENT_X_VOICE_MAX_AGE_DAYS = 7;
const RECENT_X_VOICE_MIN_AUTHORITY = 60;
const RECENT_X_VOICE_LIMIT = 5;
// Jev's authority score measures authority to announce consumer timing, so
// only @Tesla and @elonmusk clear it (live 2026-09-25: Sawyer Merritt scored
// 11). Credible commentators are named here instead; handles match exactly.
const CREDIBLE_X_HANDLES = new Set(
  [
    'Tesla',
    'elonmusk',
    'Tesla_AI',
    'TeslaAI',
    'robotaxi',
    'aelluswamy',
    'LarsMoravy',
    'CybercabSpotter',
    'SawyerMerritt',
    'TroyTeslike',
    'FredLambert',
    'ElectrekCo',
    'Teslarati',
    'TechCrunch',
    'Reuters',
    'business',
    'WSJ',
    'CNBC',
    'verge',
  ].map((handle) => handle.toLowerCase()),
);

function recentCredibleXVoiceLines(xEvidence, date, excludeUrls = []) {
  const ranked = Array.isArray(xEvidence?.rankedSources) ? xEvidence.rankedSources : [];
  const excluded = new Set(excludeUrls.map((url) => String(url || '')));
  const asOf = Date.parse(`${String(date || '').slice(0, 10)}T23:59:59Z`);
  const rows = ranked
    .filter((row) => /^https:\/\/x\.com\//.test(String(row?.url || '')))
    // A post Jev already promoted is cited in the evidence list; list it once.
    .filter((row) => !excluded.has(String(row?.url || '')))
    .filter(
      (row) =>
        CREDIBLE_X_HANDLES.has(String(row?.handle || '').toLowerCase()) ||
        Number(row?.authorityConfidence || 0) >= RECENT_X_VOICE_MIN_AUTHORITY,
    )
    .filter((row) => {
      const published = Date.parse(String(row?.publishedAt || ''));
      if (!Number.isFinite(published)) return false;
      if (!Number.isFinite(asOf)) return true;
      const age = asOf - published;
      return age >= -86400000 && age <= RECENT_X_VOICE_MAX_AGE_DAYS * 86400000;
    })
    .sort((a, b) => String(b.publishedAt || '').localeCompare(String(a.publishedAt || '')))
    // Newest post per author, so a daily tracker account cannot fill every
    // slot (live 2026-09-28: CybercabSpotter posted 6 of 15 candidates).
    .filter(
      (row, index, all) =>
        all.findIndex(
          (other) =>
            String(other.handle || '').toLowerCase() === String(row.handle || '').toLowerCase(),
        ) === index,
    )
    .slice(0, RECENT_X_VOICE_LIMIT);
  if (!rows.length) return [];
  return [
    `Recent on X from credible accounts (last ${RECENT_X_VOICE_MAX_AGE_DAYS} days, commentary, not order evidence):`,
    ...rows.map((row) => {
      const when = String(row.publishedAt || '').slice(0, 10);
      const said = String(row.evidenceText || row.excerpt || '')
        .replace(/\]\(https?:[^)\s]*\)?/g, ' ')
        .replace(/[#*[\]]+/g, ' ')
        .replace(/^.*?\bon X:\s*/i, '')
        .replace(/\s+/g, ' ')
        .trim();
      const excerpt = said.length > 180 ? `${said.slice(0, 177).replace(/\s+\S*$/, '')}...` : said;
      // "- publisher -- title: url" is the shape the dashboard's cyberCab
      // parser renders as a source; any other shape never reaches the popup.
      const title = (excerpt || 'open the post for its wording').replace(/\s+--\s+/g, ', ');
      return `  - @${row.handle} on X, ${when} (commentary, search snippet) -- ${title}: ${row.url}`;
    }),
  ];
}

function formatTeslaWatchSection(date, options = {}) {
  const officialEvidence = options.officialEvidence || null;
  const sourceMix = cyberCabSourcesForRun(options.xEvidence || null);
  const recentVoices = recentCredibleXVoiceLines(
    options.xEvidence || null,
    date,
    (sourceMix.sources || []).map((source) => source?.url),
  );
  const xCoverage = options.xCoverage || cyberCabXCoverage(options.xEvidence || null, date);
  const xCheckUnavailable = !sourceMix.checked || (xCoverage.included && !xCoverage.usable);
  const coverageNeedsOwnerAction =
    xCoverage.healerExcluded || (!xCoverage.included && !sourceMix.checked);
  const triLines = cyberCabTriangulationLines(sourceMix.sources, sourceMix.decisionSources);
  const hasXApi =
    typeof options.xApiConfigured === 'boolean'
      ? options.xApiConfigured
      : xApiConfigured(options.env || process.env, options.resolveCredential || null);
  const xStatus = [
    xCoverage.included && !xCoverage.usable
      ? 'X source check: Current X-search coverage is incomplete, so this card makes no all-search absence claim.'
      : `X source check: ${sourceMix.reason}`,
    xCoverage.line,
    hasXApi
      ? 'Direct X API credentials are present, but this card currently uses the public-web search path.'
      : 'Direct X API: not configured. The current fallback is a daily public-web search for X post links.',
    coverageNeedsOwnerAction
      ? hasXApi
        ? 'Owner action: restore a supported public-search transport or explicitly authorize switching this card to the configured X API; this card stays red and retries the public check on the next daily build until one path works.'
        : 'Owner action: approve and configure an X Recent Search bearer token and its spend, or restore a supported public-search transport; this card stays red and retries the public check on the next daily build until one path works.'
      : xCheckUnavailable
        ? 'Internal repair: the X coverage receipt is stale or internally inconsistent; Amy must rebuild and verify it before this card can clear.'
        : '',
  ]
    // A never-run check intentionally contributes no coverage sentence.
    .filter(Boolean)
    .join(' ');
  if (officialEvidenceSupportsVerdict(officialEvidence)) {
    const open = officialEvidence.open === 'YES';
    const monitored = Number(officialEvidence.monitored) || 2;
    const reached = Number(officialEvidence.reached) || 0;
    const answer = open
      ? `Consumer orders open? YES (as of ${date}). An official Tesla reservation/order signal was found.`
      : `Consumer orders open? NOT YET (as of ${date}).`;
    return [
      answer,
      ...triLines,
      ...recentVoices,
      `Action: register at ${CYBERCAB_OFFICIAL_ROBOTAXI_URL}.`,
      `Reserve: ${CYBERCAB_RESERVE_URL}`,
      `Last checked: ${date}.`,
      xStatus,
      `Monitoring ${monitored} official Tesla source${monitored === 1 ? '' : 's'} for a live reservation signal (${reached}/${monitored} reached this run): ${officialEvidence.latest}`,
      `Basis: monitoring ${monitored} official source${monitored === 1 ? '' : 's'}, reported open only on official/order evidence. ${officialEvidence.basis}`,
    ].join('\n');
  }
  if (officialEvidence) {
    const monitored = Number(officialEvidence.monitored) || 3;
    const reached = Number(officialEvidence.reached) || 0;
    return [
      `Consumer orders open? UNVERIFIED (as of ${date}).`,
      ...triLines,
      ...recentVoices,
      `Action: register at ${CYBERCAB_OFFICIAL_ROBOTAXI_URL}.`,
      `Reserve: ${CYBERCAB_RESERVE_URL}`,
      `Last checked: ${date}.`,
      xStatus,
      `Monitoring ${monitored} official Tesla source${monitored === 1 ? '' : 's'} for a live reservation signal (${reached}/${monitored} reached this run): ${officialEvidence.latest}`,
      `Basis: consumer-order status remains unverified until all official sources are reached or one returns positive order evidence. ${officialEvidence.basis}`,
    ].join('\n');
  }
  return [
    `Consumer orders open? NOT YET (as of ${date}).`,
    ...triLines,
    ...recentVoices,
    `Action: register at ${CYBERCAB_OFFICIAL_ROBOTAXI_URL}.`,
    `Reserve: ${CYBERCAB_RESERVE_URL}`,
    `Last checked: ${date}.`,
    xStatus,
    'Monitoring the official Tesla reservation and robotaxi sources for a live reservation signal, no new signal in this cloud snapshot.',
    'Basis: monitoring 2 official sources, no new signal; an empty feed is not evidence that reservations are closed.',
  ].join('\n');
}


function buildTeslaCybercabCard(date, options = {}) {
  const sourceMix = cyberCabSourcesForRun(options.xEvidence || null);
  const xCoverage = cyberCabXCoverage(options.xEvidence || null, date);
  const xCheckUnavailable = !sourceMix.checked || (xCoverage.included && !xCoverage.usable);
  const officialCheckIncomplete = Boolean(
    options.officialEvidence && !officialEvidenceSupportsVerdict(options.officialEvidence),
  );
  const officialCheckReason = officialCheckIncomplete
    ? `Official Tesla source coverage is incomplete (${Number(options.officialEvidence.reached) || 0}/${Number(options.officialEvidence.monitored) || 3}); consumer-order status is unverified.`
    : '';
  const blockedReason = xCheckUnavailable
    ? xCoverage.healerExcluded || (!xCoverage.included && !sourceMix.checked)
      ? `${CYBERCAB_X_CHECK_UNAVAILABLE}: ${xCoverage.line || sourceMix.reason}`
      : xCoverage.line
    : officialCheckReason;
  const effectiveMixReason =
    xCoverage.included && !xCoverage.usable ? xCoverage.line : sourceMix.reason;
  const effectiveOk =
    sourceMix.ok && (!xCoverage.included || xCoverage.usable) && !officialCheckIncomplete;
  return {
    markdown: legacySection(TITLE, formatTeslaWatchSection(date, { ...options, xCoverage })),
    state: {
      id: 'tesla-cybercab',
      ok: effectiveOk,
      blocked: xCheckUnavailable || officialCheckIncomplete,
      blockedReason,
      defectReason: effectiveOk ? '' : officialCheckReason || effectiveMixReason,
      source:
        officialEvidenceSupportsVerdict(options.officialEvidence)
          ? sourceMix.checked
            ? 'official-and-x-check'
            : 'official-check-without-current-x'
          : sourceMix.checked
            ? 'x-check-with-static-official-evidence'
            : 'static-evidence-only',
      xSourceCount: sourceMix.xCount,
      sourceCount: sourceMix.sources.length,
      recentXSourceCount: sourceMix.currentXCount,
      currentXSourceCount: sourceMix.currentXCount,
      xSourceMixOk: xCoverage.included && !xCoverage.usable ? false : sourceMix.ok,
      xSourceMixReason: effectiveMixReason,
      xSearchCoverageUsable: xCoverage.usable,
      xSearchComplete: xCoverage.complete,
      xSearchSearchedAt: xCoverage.searchedAt,
      xSearchQueryCount: xCoverage.queryCount,
      xSearchReached: xCoverage.reached,
      xSearchRawXLinksSeen: xCoverage.rawXLinksSeen,
      xSearchDecodeFailures: xCoverage.decodeFailures,
      xCandidateCount: Number(options.xEvidence?.candidateCount || 0),
      jevRankingAttempted: options.xEvidence?.jevAttempted === true,
      jevRankingChecked: options.xEvidence?.jevChecked === true,
      jevTop20: Array.isArray(options.xEvidence?.rankedSources)
        ? options.xEvidence.rankedSources.slice(0, 20)
        : [],
    },
  };
}

module.exports = {
  recentCredibleXVoiceLines,
  TITLE,
  CYBERCAB_RESERVE_URL,
  CYBERCAB_OFFICIAL_ROBOTAXI_URL,
  CYBERCAB_OFFICIAL_PRODUCTION_URL,
  CYBERCAB_OFFICIAL_Q2_10Q_URL,
  CYBERCAB_TESLA_X_URL,
  CYBERCAB_ELON_X_URL,
  CYBERCAB_TECHCRUNCH_URL,
  CYBERCAB_DATE_SOURCES,
  triangulateCyberCabDate,
  cyberCabTriangulationLines,
  isXPostSource,
  cyberCabSourcesForRun,
  formatTeslaWatchSection,
  buildTeslaCybercabCard,
  xApiConfigured,
};
