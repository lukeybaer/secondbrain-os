// Shared Google-News redirect resolver wrapper for news body fetchers.
//
// A news.google.com/rss/articles/<id> URL is a Google-News redirect stub, NOT
// the publisher article. Fetching it directly returns an empty or interstitial
// body, so any body-fetch pipeline that skips resolution silently drops those
// candidates (ctx below the summary-grade minimum) no matter how many raw
// candidates were discovered upstream.
//
// scripts/content-heal.js proved the fix first (makeNewsBodyFetcher, wrapping
// fetchArticleBody with a resolve-then-fetch step for Google News stubs).
// scripts/refresh-news-only.js -- the actual targeted-refresh driver the card
// controller invokes -- never had this wrapper, so its FINANCE_FEEDS (11/15
// of which are news.google.com/rss/search queries) silently starved. This
// module is the single shared implementation both callers use, so a future
// chronic producer on a Google-heavy feed list gets the fix automatically
// instead of needing a third copy.
//
// deps.resolveUrl / deps.fetchText are injectable so both callers (and their
// tests) can override just the resolve/fetch legs without touching the base
// body fetcher; deps.baseFetch is NOT part of this factory's own signature --
// callers pass their base fetcher as the first argument -- but is left
// documented here because the wrapper always falls back to that first
// argument on any failure or on a non-Google-News URL.
const {
  isGoogleNewsArticleUrl,
  resolveGoogleNewsUrl,
  fetchArticleText,
} = require('./news-summarize.js');

function makeNewsBodyFetcher(fetchArticleBody, deps = {}) {
  const baseFetch = typeof fetchArticleBody === 'function' ? fetchArticleBody : async () => '';
  const resolver = typeof deps.resolveUrl === 'function' ? deps.resolveUrl : resolveGoogleNewsUrl;
  const textFetch = typeof deps.fetchText === 'function' ? deps.fetchText : fetchArticleText;
  return async (url, sourceUrl) => {
    if (url && isGoogleNewsArticleUrl(url)) {
      try {
        const resolved = await resolver(url);
        if (resolved && /^https?:\/\//i.test(resolved) && !/news\.google\.com/i.test(resolved)) {
          const body = await textFetch(resolved, {});
          if (body && String(body).trim()) return body;
        }
      } catch {
        // Fall through to the legacy body fetch below.
      }
    }
    return baseFetch(url, sourceUrl || url);
  };
}

module.exports = {
  makeNewsBodyFetcher,
  isGoogleNewsArticleUrl,
  resolveGoogleNewsUrl,
};
