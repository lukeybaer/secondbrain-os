'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const {
  CYBERCAB_RESERVE_URL,
  CYBERCAB_OFFICIAL_ROBOTAXI_URL,
} = require('./briefing-cards/tesla-cybercab-card.js');

// The displayed citation remains Tesla's investor-relations PDF. The live
// monitor uses Tesla's company-filed SEC HTML exhibit for the same Q2 update
// so a multi-page PDF download cannot exhaust fetchTextSync's bounded buffer
// and falsely reduce official coverage to 2/3.
const CYBERCAB_OFFICIAL_PRODUCTION_EVIDENCE_URL =
  'https://www.sec.gov/Archives/edgar/data/1318605/000162828026049213/exhibit991.htm';
const CYBERCAB_X_CANDIDATE_LIMIT = 100;
const CYBERCAB_X_QUERIES = Object.freeze([
  'site:x.com/Tesla/status Cybercab',
  'site:x.com/elonmusk/status Cybercab',
  'site:x.com/Tesla_AI/status Cybercab',
  'site:x.com/aelluswamy/status Cybercab',
  'site:x.com/LarsMoravy/status Cybercab',
  'site:x.com/CybercabSpotter/status Cybercab',
  'site:x.com/SawyerMerritt/status Cybercab',
  'site:x.com Cybercab',
]);

function cyberCabOfficialOrderSignal(text) {
  const t = String(text || '').replace(/\s+/g, ' ');
  return (
    /\b(?:reserve|order|pre-?order)\s+(?:your\s+)?(?:Tesla\s+)?Cybercab\b/i.test(t) ||
    /\bCybercab\s+(?:reservations?|orders?|pre-?orders?)\s+(?:are\s+)?(?:now\s+)?(?:open|live|available)\b/i.test(
      t,
    )
  );
}

function fetchTextSync(url, timeoutSeconds = 12) {
  const result = spawnSync(
    'curl',
    ['-L', '--max-time', String(timeoutSeconds), '-A', 'SecondBrain/1.0', url],
    {
      encoding: 'utf8',
      timeout: (timeoutSeconds + 3) * 1000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `curl exit ${result.status}`).slice(-300));
  }
  return result.stdout || '';
}

function fetchCyberCabOfficialEvidenceSync(options = {}) {
  const fetcher = options.fetcher || fetchTextSync;
  const urls = [
    CYBERCAB_RESERVE_URL,
    CYBERCAB_OFFICIAL_ROBOTAXI_URL,
    CYBERCAB_OFFICIAL_PRODUCTION_EVIDENCE_URL,
  ];
  const pages = [];
  const errors = [];
  for (const url of urls) {
    try {
      const html = String(fetcher(url, 12) || '');
      // A successful transport with an empty body is not durable source
      // evidence. Counting it as reached can turn missing official content
      // into a false complete negative verdict.
      if (!html.trim()) {
        errors.push(`${url}: empty response body`);
        continue;
      }
      pages.push({ url, html });
    } catch (error) {
      errors.push(`${url}: ${String((error && error.message) || error).slice(0, 180)}`);
    }
  }
  if (!pages.length) {
    return {
      checked: false,
      open: 'UNVERIFIED',
      sourceUrl: CYBERCAB_OFFICIAL_ROBOTAXI_URL,
      monitored: urls.length,
      reached: 0,
      latest: 'Official Tesla pages could not be reached in this run.',
      basis: `Official Tesla check failed: ${errors.join('; ') || 'no response'}.`,
    };
  }
  const combined = pages.map((page) => page.html).join('\n');
  const orderSignalFound = cyberCabOfficialOrderSignal(combined);
  const complete = pages.length === urls.length;
  const checked = orderSignalFound || complete;
  const open = orderSignalFound ? 'YES' : complete ? 'NO' : 'UNVERIFIED';
  return {
    checked,
    open,
    sourceUrl: CYBERCAB_OFFICIAL_ROBOTAXI_URL,
    monitored: urls.length,
    reached: pages.length,
    latest:
      open === 'YES'
        ? 'Official Tesla page appears to expose a Cybercab reservation/order signal.'
        : open === 'UNVERIFIED'
          ? `Only ${pages.length}/${urls.length} official Tesla sources were reached, so consumer-order status is unverified.`
          : 'Tesla says Cybercab production began in Q2 2026, but no official Cybercab consumer reservation/order signal was found.',
    basis:
      `Official Tesla product, Robotaxi, and Q2 production sources checked (${pages.length}/${urls.length}); news feed is secondary context.` +
      (errors.length ? ` Unreached source evidence: ${errors.join('; ')}.` : ''),
  };
}

function xPostDateFromStatusId(statusId) {
  try {
    const id = BigInt(String(statusId || ''));
    const epochMs = 1288834974657n;
    const timestampMs = Number((id >> 22n) + epochMs);
    const date = new Date(timestampMs);
    return Number.isFinite(date.getTime()) ? date : null;
  } catch {
    return null;
  }
}

function plausibleEncodedXStatus(rawValue) {
  let inspected = String(rawValue || '');
  // This is inspection only: unwrap percent-encoded percent signs so both
  // single- and double-encoded X status URLs can be recognized before decode.
  for (let i = 0; i < 2; i += 1) {
    const next = inspected.replace(/%25/gi, '%');
    if (next === inspected) break;
    inspected = next;
  }
  return (
    /https?:\/\/x\.com\/[A-Za-z0-9_]+\/status\/\d+/i.test(inspected) ||
    /(?:https?%3a%2f%2f)?x(?:%2e|\.)com%2f[A-Za-z0-9_]+%2fstatus%2f\d+/i.test(inspected)
  );
}

function isolatedEncodedXStatusValue(rawValue) {
  let inspected = String(rawValue || '');
  for (let i = 0; i < 2; i += 1) {
    const next = inspected.replace(/%25/gi, '%');
    if (next === inspected) break;
    inspected = next;
  }
  // A non-uddg parameter is decoded only when its entire value is an encoded
  // X status URL. This cannot consume encoded surrounding prose such as %20.
  return /^https?%3a%2f%2fx(?:%2e|\.)com%2f[A-Za-z0-9_]+%2fstatus%2f\d+$/i.test(inspected);
}

function decodePublicSearchText(raw, telemetry = null) {
  const text = String(raw || '').replace(/&amp;/g, '&');
  // Decode the redirect parameter that owns the result URL, never arbitrary
  // page or snippet text. Ordinary snippets routinely contain bare percentage
  // figures ("35%") and can even contain text such as "35%20"; neither may be
  // reinterpreted as an encoded space. The redirect value still gets two
  // passes so single- and double-encoded result URLs both work.
  return text.replace(/(\b[A-Za-z][A-Za-z0-9_-]*=)([^&\s)"'<>]+)/gi, (match, prefix, rawValue) => {
    const plausiblyXPost = plausibleEncodedXStatus(rawValue);
    // `uddg` is the producer-owned DuckDuckGo result URL. Also support a
    // differently named result parameter, but only when its value itself is
    // recognizably an encoded X status URL; unrelated query/snippet values
    // are never decoded.
    if (!/^uddg=$/i.test(prefix) && !isolatedEncodedXStatusValue(rawValue)) return match;
    let value = rawValue;
    for (let i = 0; i < 2; i += 1) {
      if (i === 1 && !/%(?:25|2f|3a|3f|3d|26|23)/i.test(value)) break;
      try {
        const decoded = decodeURIComponent(value);
        if (decoded === value) break;
        value = decoded;
      } catch {
        const alreadyExtractable = /https:\/\/x\.com\/[A-Za-z0-9_]+\/status\/\d+/i.test(value);
        if (!alreadyExtractable && plausiblyXPost && telemetry && typeof telemetry === 'object') {
          if (!(telemetry.failedRawValues instanceof Set)) {
            telemetry.failedRawValues = new Set();
          }
          if (!telemetry.failedRawValues.has(rawValue)) {
            telemetry.failedRawValues.add(rawValue);
            telemetry.decodeFailures = Number(telemetry.decodeFailures || 0) + 1;
          }
        }
        break;
      }
    }
    return prefix + value;
  });
}

function publicSearchTransportRefused(body) {
  const prefix = String(body || '')
    .trim()
    .slice(0, 1200);
  return (
    /AuthenticationRequiredError|blocked from performing anonymous queries/i.test(prefix) ||
    /^\{[\s\S]{0,1000}"code"\s*:\s*40\d\b/i.test(prefix)
  );
}

function publicSearchResponseLooksValid(body, engine = 'duckduckgo') {
  const text = String(body || '');
  const header = text.split(/\nMarkdown Content:\s*/i, 1)[0];
  if (
    /captcha|unusual traffic|verify (?:that )?you are human|access denied|temporarily unavailable|too many requests|rate limit|service unavailable/i.test(
      header,
    )
  ) {
    return false;
  }
  const duckDuckGoProof =
    /URL Source:\s*https?:\/\/(?:html\.|lite\.)?duckduckgo\.com\//i.test(text) ||
    /Title:\s*[^\n]*DuckDuckGo/i.test(text) ||
    /\bresult__(?:a|snippet)\b|\buddg=/i.test(text);
  const bingProof =
    /URL Source:\s*https?:\/\/(?:www\.)?bing\.com\/search/i.test(text) ||
    /Title:\s*[^\n]*Bing/i.test(text) ||
    /\bb_algo\b|https?:\/\/(?:www\.)?bing\.com\/ck\/a/i.test(text);
  const engineProof = engine === 'bing' ? bingProof : duckDuckGoProof;
  if (!engineProof) return false;
  // A page that demonstrably originates from DuckDuckGo and carries no
  // blocked/CAPTCHA signal is a valid search-result response even when
  // its empty-results copy uses phrasing not in the list below.
  // DuckDuckGo's no-results text varies by locale, time filter, and query
  // shape; trusting duckDuckGoProof avoids false transport-failure
  // classifications when one query legitimately returns zero results.
  // The earlier patterns are preserved as documentation of common shapes.
  return (
    /\[[^\]]+\]\(https?:\/\//i.test(text) ||
    /https?:\/\/x\.com\/[A-Za-z0-9_]+\/status\/\d+/i.test(text) ||
    /\b(?:No results found|Unfortunately, no results)\b/i.test(text) ||
    engineProof
  );
}

function publicSearchResultsBody(body) {
  const text = String(body || '');
  const marker = text.match(/(?:^|\n)Markdown Content:\s*(?:\r?\n)?/i);
  return marker ? text.slice((marker.index || 0) + marker[0].length) : text;
}

function resultBlockAround(body, index) {
  const text = String(body || '');
  const center = Math.max(0, Number(index || 0));
  const before = text.slice(0, center);
  const lineIndex = before.split(/\r?\n/).length - 1;
  const lines = text.split(/\r?\n/);
  // Inspect up to six neighboring lines inside the same blank-delimited
  // Markdown result (three back, URL line, three forward), stopping at blank
  // lines (result separators) or the next Markdown heading. A byte window
  // would accidentally inherit the query echo or a neighboring result's
  // Cybercab keyword. A DuckDuckGo result can place the display URL between
  // the linked title and the snippet, so the Cybercab evidence may be two
  // lines below the URL; the three-line neighborhood was too narrow.
  let start = lineIndex;
  for (let i = 1; i <= 3 && lineIndex - i >= 0; i += 1) {
    if (!String(lines[lineIndex - i] || '').trim()) break;
    start = lineIndex - i;
  }
  let end = lineIndex + 1;
  for (let i = lineIndex + 1; i < Math.min(lines.length, lineIndex + 4); i += 1) {
    const line = String(lines[i] || '');
    if (!line.trim() || /^#{1,6}\s/.test(line)) break;
    end = i + 1;
  }
  return lines.slice(start, end).join('\n');
}

function rankCyberCabSourcesWithJevSync(candidates, options = {}) {
  if (typeof options.ranker === 'function') return options.ranker(candidates);
  const worker = path.join(__dirname, '..', 'cybercab-jev-rank.js');
  const result = spawnSync(process.execPath, [worker], {
    input: JSON.stringify({ candidates }),
    encoding: 'utf8',
    timeout: Number(options.jevTimeoutMs || 180000),
    maxBuffer: 8 * 1024 * 1024,
    env: process.env,
  });
  if (result.status !== 0) {
    const exitDetail = result.error?.code === 'ETIMEDOUT'
      ? 'timed out'
      : result.signal
        ? `killed by signal ${result.signal}`
        : `exit ${result.status}`;
    throw new Error(
      String(result.stderr || result.stdout || `Jev ranker ${exitDetail}`).slice(-1000),
    );
  }
  return JSON.parse(String(result.stdout || '{}'));
}

function shouldRankCyberCabWithJev(options = {}) {
  if (typeof options.enableJev === 'boolean') return options.enableJev;
  return (
    process.platform === 'linux' &&
    String(process.env.SECONDBRAIN_DATA_DIR || '').startsWith('/opt/secondbrain')
  );
}

function presentJevSource(source) {
  const evidence = String(source.evidenceText || source.excerpt || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
  const classification = String(source.timingClassification || 'irrelevant').replace(/_/g, ' ');
  const orderEvidence = source.orderEvidence === true || [
    'orders_open_now',
    'future_consumer_date',
    'consumer_timing_unknown',
  ].includes(String(source.timingClassification || ''));
  return {
    ...source,
    label:
      `@${source.handle} on X -- ${classification} ` +
      `(${Number(source.authorityConfidence || 0)}% authority confidence)`,
    datedClaim:
      (orderEvidence
        ? `Jev found ${Number(source.consumerTimingConfidence || 0)}% confidence that this speaks to public consumer timing. `
        : 'This is authoritative dated operational timing evidence, not evidence that consumer orders are open. ') +
      `Jev classified it as ${classification} with ${Number(source.classificationConfidence || 0)}% confidence. ` +
      `Public-search evidence: ${evidence || 'No readable evidence excerpt was returned.'}`,
  };
}

const cyberCabXEvidenceCache = new Map();

// DuckDuckGo's HTML search has no "after:" query operator (that syntax
// belongs to X's own advanced search, not DuckDuckGo), so embedding
// `after:<date>` in the query text never actually restricted DuckDuckGo's
// result set to the last N days; DuckDuckGo returned its normal
// relevance/popularity ranking regardless, which is dominated by old,
// heavily-linked Cybercab posts. That is the more likely explanation for why
// every complete run kept finding zero-to-few genuinely recent posts even as
// the raw link count climbed into the hundreds. DuckDuckGo's HTML endpoint
// does support real server-side recency filtering through the `df` URL
// parameter (`d`=past day, `w`=past week, `m`=past month, `y`=past year).
// Use that real operator instead of the non-functional inline text so the
// search engine itself biases toward fresh results; the existing snowflake-ID
// age check remains the authoritative client-side cutoff.
function duckDuckGoRecencyToken(maxAgeDays) {
  const days = Number(maxAgeDays);
  if (!Number.isFinite(days) || days <= 1) return 'd';
  if (days <= 7) return 'w';
  if (days <= 31) return 'm';
  return 'y';
}

function fetchCyberCabXEvidenceSync(options = {}) {
  const fetcher = options.fetcher || fetchTextSync;
  const now = options.now instanceof Date ? options.now : new Date();
  const maxAgeDays = Number(options.maxAgeDays || 7);
  const recencyToken = duckDuckGoRecencyToken(maxAgeDays);
  const cutoffDate = new Date(now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const queries = options.queries || CYBERCAB_X_QUERIES;
  const candidates = [];
  const seen = new Set();
  const transportErrors = [];
  const transportAttempts = [];
  const emptyQueries = [];
  let rawXLinksSeen = 0;
  const decodeTelemetry = { decodeFailures: 0 };
  let reached = 0;
  const evidenceCache = options.cache instanceof Map ? options.cache : cyberCabXEvidenceCache;
  const cacheEligible = fetcher === fetchTextSync || options.cacheEligible === true;
  const cacheKey = `${now.toISOString().slice(0, 10)}|${maxAgeDays}|${queries.join('|')}`;
  if (cacheEligible && options.force !== true) {
    for (const [key, cached] of evidenceCache.entries()) {
      const ttlMs = Number(cached?.ttlMs || 5 * 60 * 1000);
      if (!cached || now.getTime() - cached.cachedAt >= ttlMs) {
        evidenceCache.delete(key);
      }
    }
    const cached = evidenceCache.get(cacheKey);
    if (cached && now.getTime() - cached.cachedAt < Number(cached.ttlMs || 5 * 60 * 1000)) {
      return cached.value;
    }
  }
  for (const query of queries) {
    const transports = [
      {
        id: 'duckduckgo-html',
        engine: 'duckduckgo',
        url:
          'https://r.jina.ai/http://duckduckgo.com/html/?q=' +
          encodeURIComponent(query) +
          '&df=' +
          recencyToken,
      },
      {
        id: 'bing-web',
        engine: 'bing',
        url:
          'https://r.jina.ai/http://www.bing.com/search?q=' +
          encodeURIComponent(query + ` after:${cutoffDate}`),
      },
      {
        // DuckDuckGo Lite is a separately rendered public endpoint. Keep it
        // behind the existing HTML and Bing paths so ordinary runs do not add
        // traffic, while one transiently blocked renderer cannot make an
        // otherwise complete multi-query receipt fail closed.
        id: 'duckduckgo-lite',
        engine: 'duckduckgo',
        url:
          'https://r.jina.ai/http://lite.duckduckgo.com/lite/?q=' +
          encodeURIComponent(query) +
          '&df=' +
          recencyToken,
      },
    ];
    let responseBody = '';
    let reachedTransport = null;
    const queryErrors = [];
    for (const transport of transports) {
      try {
        const candidate = decodePublicSearchText(fetcher(transport.url, 15), decodeTelemetry);
        if (publicSearchTransportRefused(candidate)) {
          queryErrors.push(`${transport.id}: refused anonymous access`);
          continue;
        }
        if (!publicSearchResponseLooksValid(candidate, transport.engine)) {
          queryErrors.push(`${transport.id}: unrecognizable or blocked result page`);
          continue;
        }
        responseBody = candidate;
        reachedTransport = transport;
        break;
      } catch (error) {
        queryErrors.push(
          `${transport.id}: ${String((error && error.message) || error).slice(0, 140)}`,
        );
      }
    }
    transportAttempts.push({
      query,
      reached: Boolean(reachedTransport),
      transport: reachedTransport ? reachedTransport.id : null,
      errors: queryErrors,
    });
    if (!reachedTransport) {
      transportErrors.push(
        queryErrors.join('; ') ||
          'Both public X search transports returned no verifiable response.',
      );
      continue;
    }
    try {
      const body = publicSearchResultsBody(responseBody);
      // A successful response is a completed check even when it contains zero
      // direct X links. Keep that distinct from transport failure.
      reached += 1;
      const matches = [...body.matchAll(/https:\/\/x\.com\/([A-Za-z0-9_]+)\/status\/(\d+)/g)];
      // This is deliberately a raw match count, not a unique-post count.
      // `seen` below deduplicates citations across result pages before the
      // five-source retention cap.
      rawXLinksSeen += matches.length;
      if (!matches.length) {
        emptyQueries.push(query);
        continue;
      }
      for (const match of matches) {
        if (candidates.length >= Number(options.maxSources || CYBERCAB_X_CANDIDATE_LIMIT)) continue;
        const handle = match[1];
        const statusId = match[2];
        const postDate = xPostDateFromStatusId(statusId);
        if (!postDate) continue;
        const ageDays = (now.getTime() - postDate.getTime()) / (24 * 60 * 60 * 1000);
        if (ageDays < -1 || ageDays > maxAgeDays) continue;
        // Limit relevance to the result block that actually contains the URL;
        // the query echoed elsewhere on the page cannot satisfy this check.
        if (!/cybercab/i.test(resultBlockAround(body, match.index))) continue;
        const postUrl = `https://x.com/${handle}/status/${statusId}`;
        if (seen.has(postUrl)) continue;
        seen.add(postUrl);
        const published = postDate.toISOString().slice(0, 10);
        const evidenceText = resultBlockAround(body, match.index);
        candidates.push({
          label: `@${handle} on X -- public search result (${published})`,
          url: postUrl,
          datedClaim: `The daily public search returned this X post from @${handle} in response to a Cybercab query, published ${published}. Open the linked post for the source's exact wording and context.`,
          signals: {},
          discoveredThisRun: true,
          publishedAt: postDate.toISOString(),
          handle,
          evidenceText,
          excerpt: evidenceText,
        });
      }
    } catch (error) {
      transportErrors.push(String((error && error.message) || error).slice(0, 180));
    }
    // Continue through every configured query even after the five-source
    // display cap is full. Query coverage is evidence in its own right; an
    // early display-cap exit must never masquerade as a transport miss.
  }
  // "Checked" means the configured search set completed, not merely that one
  // result page was reachable. A partial transport result is a bounded sample
  // and cannot support an all-search absence claim. Any undecodable redirect
  // also makes link coverage incomplete, even when the surrounding page is
  // otherwise recognizable.
  const checked =
    queries.length > 0 && reached === queries.length && decodeTelemetry.decodeFailures === 0;
  let jev = {
    attempted: false,
    checked: false,
    candidateCount: candidates.length,
    rankedSources: [],
    legitimateSources: [],
  };
  let jevError = '';
  if (checked && candidates.length && shouldRankCyberCabWithJev(options)) {
    try {
      jev = rankCyberCabSourcesWithJevSync(candidates, options);
    } catch (error) {
      jev = { attempted: true, checked: false, candidateCount: candidates.length, rankedSources: [], legitimateSources: [] };
      jevError = String((error && error.message) || error).slice(0, 1000);
    }
  }
  const sources = (jev.legitimateSources || []).slice(0, 5).map(presentJevSource);
  const result = {
    attempted: true,
    checked,
    mode: 'public-x-web-search',
    searchedAt: now.toISOString(),
    queryCount: queries.length,
    reached,
    rawXLinksSeen,
    decodeFailures: decodeTelemetry.decodeFailures,
    sources,
    candidateCount: candidates.length,
    candidates,
    jevAttempted: jev.attempted === true,
    jevChecked: jev.checked === true,
    jevError,
    rankedSources: Array.isArray(jev.rankedSources) ? jev.rankedSources.slice(0, 20) : [],
    transportAttempts,
    transportErrors,
    emptyQueries,
    errors: transportErrors,
    reason: checked
      ? jev.attempted && !jev.checked
        ? `Jev could not rank the ${candidates.length} current X candidates, so no unclassified source was promoted to the card.`
        : candidates.length && !jev.checked
          ? `Jev did not run on the ${candidates.length} current X candidates, so no unclassified source was promoted to the card.`
        : sources.length
        ? ''
        : 'The current public X search completed but found no qualifying recent Cybercab post.'
      : reached > 0
        ? decodeTelemetry.decodeFailures > 0
          ? `The current public X search found ${decodeTelemetry.decodeFailures} result redirect URL${decodeTelemetry.decodeFailures === 1 ? '' : 's'} that could not be decoded, so no complete absence claim is valid.`
          : `The current public X search reached ${reached}/${queries.length} queries; coverage is incomplete, so no all-search absence claim is valid.`
        : transportErrors[0] || 'The public search transport returned no verifiable response.',
  };
  // Cache completed checks for five minutes. Cache an incomplete receipt for
  // only one minute so repeated card builds cannot amplify a proxy outage into
  // a retry storm, while the next bounded probe still happens promptly.
  if (cacheEligible) {
    evidenceCache.set(cacheKey, {
      cachedAt: now.getTime(),
      ttlMs: checked ? 5 * 60 * 1000 : 60 * 1000,
      value: result,
    });
  }
  return result;
}

function shouldRunCyberCabOfficialCheck(
  dataDir,
  env = process.env,
  platform = process.platform,
  realpath = fs.realpathSync,
) {
  if (env.AMY_CYBERCAB_OFFICIAL_CHECK === '0') return false;
  return isLiveCyberCabDataDir(dataDir, platform, realpath);
}

function shouldRunCyberCabXCheck(
  dataDir,
  env = process.env,
  platform = process.platform,
  realpath = fs.realpathSync,
) {
  if (env.AMY_CYBERCAB_X_CHECK === '0') return false;
  return isLiveCyberCabDataDir(dataDir, platform, realpath);
}

function isCanonicalLiveCyberCabPath(value) {
  const resolved = String(value || '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');
  return (
    resolved === '/opt/secondbrain/data' ||
    resolved.startsWith('/opt/secondbrain/data/') ||
    resolved === '/opt/secondbrain-shared/data' ||
    resolved.startsWith('/opt/secondbrain-shared/data/')
  );
}

function isImmutableReleaseCyberCabPath(value) {
  const resolved = String(value || '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');
  return /^\/opt\/secondbrain-releases\/[0-9a-f]{40}\/data(?:\/|$)/i.test(resolved);
}

// Scheduled runners execute from the immutable release, so the data path can
// arrive as /opt/secondbrain-releases/<sha>/data, a symlink to the shared live
// data. Resolve symlinks before deciding; a temp fixture never resolves into
// the shared live directory, so tests stay offline.
function isLiveCyberCabDataDir(dataDir, platform = process.platform, realpath = fs.realpathSync) {
  if (platform !== 'linux' || !dataDir) return false;
  if (isCanonicalLiveCyberCabPath(dataDir)) return true;
  // The scheduled owner runs from an immutable release. Its data directory
  // is live by contract even when the shared-data symlink is unavailable to
  // the worker's filesystem view. Keep the acceptance narrow to a full
  // 40-hex release id under the release root; fixtures cannot opt in.
  if (isImmutableReleaseCyberCabPath(dataDir)) return true;
  try {
    return isCanonicalLiveCyberCabPath(realpath(String(dataDir)));
  } catch {
    return false;
  }
}

module.exports = {
  CYBERCAB_X_QUERIES,
  CYBERCAB_OFFICIAL_PRODUCTION_EVIDENCE_URL,
  cyberCabOfficialOrderSignal,
  fetchTextSync,
  fetchCyberCabOfficialEvidenceSync,
  xPostDateFromStatusId,
  decodePublicSearchText,
  publicSearchTransportRefused,
  publicSearchResponseLooksValid,
  publicSearchResultsBody,
  resultBlockAround,
  rankCyberCabSourcesWithJevSync,
  shouldRankCyberCabWithJev,
  presentJevSource,
  duckDuckGoRecencyToken,
  fetchCyberCabXEvidenceSync,
  shouldRunCyberCabOfficialCheck,
  shouldRunCyberCabXCheck,
  CYBERCAB_X_CANDIDATE_LIMIT,
};
