'use strict';

/**
 * manifest-cards-wiring.js
 *
 * C5 completeness lint: static analysis over scripts/cloud-morning-briefing.js
 * source text that proves every canonical manifest card id (briefing-card-
 * manifest.js) is actually assigned in the cloud builder's `realById`
 * construction -- the object whose keys assembleManifestSections() walks to
 * resolve each card to real content or an honest blocker.
 *
 * WHY STATIC (not a runtime require+execute): a card can be syntactically
 * present in the manifest but never given a realById entry, so no `always:
 * true` header the manifest declares actually gets a live-generator wiring.
 * That gap renders as a PERMANENT honest blocker -- structurally identical to
 * a genuinely blocked card, so no test that runs the builder end-to-end and
 * checks "a header exists" (manifest-coverage / cloud-briefing-real-cards)
 * catches it: the never-drop chokepoint ALWAYS emits a header, blocked or
 * not. Only source-level proof that the id appears on the left side of a
 * realById assignment (or is spread in from buildRequiredCloudCards) proves a
 * live builder is wired to it. This is exactly the class that let
 * comm_coaching and memory/people cards fail silently for days (ExampleCo
 * 2026-07-01).
 *
 * Codex amendment (avoid false positives from dynamic registration): ids that
 * are computed at runtime (not string literals in source) are NOT pattern-
 * matched against arbitrary source text. Each dynamic-id site is registered
 * explicitly below (DYNAMIC_WIRING_SITES), with the same resolution logic the
 * source itself uses, so a rename in the source cannot silently desync from
 * the lint without also breaking the explicit registration.
 */

const fs = require('fs');
const path = require('path');

const BRIEFING_SOURCE_PATH = path.join(__dirname, '..', 'cloud-morning-briefing.js');

// Explicit registrations for card ids that are NOT literal object keys in the
// realById construction. Each entry documents exactly where the id comes from
// so a future source change that breaks the mapping is a visible diff here,
// not a silent regex miss.
//
//   - voice_confirmation / otter_speaker_pareto: assigned inside a
//     `for (const [injectorName, id, title] of [...])` loop using
//     `realById[id] = ...`. The ids are literal strings inside that loop's
//     source array, so they ARE statically extractable, but via the loop
//     array shape rather than an object-literal key.
//   - the employer-news card: EMPLOYER_NEWS_MANIFEST_ID resolves at runtime
//     from the manifest's `mentionOrZero` card (briefing-card-manifest.js),
//     never a hardcoded employer string (PII gate). The lint resolves it
//     the SAME way the source does -- via the manifest, not a literal.
const DYNAMIC_WIRING_SITES = [
  {
    // Codex review (2026-07-02): the earlier version only proved the tuple
    // array ExampleCod the id literals, not that the loop body actually
    // ASSIGNS them to realById -- a refactor that dropped `realById[id] = `
    // while leaving the tuple array untouched would have kept passing. Now
    // both the tuple-array ids AND the `realById[id] = ` assignment inside
    // the SAME loop body must be present, or the site reports not-found.
    name: 'voice/otter injector loop (realById[id] = ... inside the tuple loop)',
    resolve(src) {
      const headRe =
        /for\s*\(\s*const\s*\[injectorName,\s*id,\s*title\]\s*of\s*\[([\s\S]*?)\]\s*\)\s*\{/;
      const headMatch = headRe.exec(src);
      if (!headMatch) return { ids: [], found: false };
      const tupleBlock = headMatch[1];
      // Brace-depth scan for the loop BODY (from right after the opening `{`
      // to its matching `}`), so a nested `if {}` / helper block before the
      // realById[id] assignment cannot truncate the search early (Codex
      // review: the earlier non-greedy `\n\s*}` regex stop could false-
      // negative on a loop body with an intermediate closing brace).
      const bodyStart = headMatch.index + headMatch[0].length;
      let depth = 1;
      let bodyEnd = -1;
      for (let i = bodyStart; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') {
          depth--;
          if (depth === 0) {
            bodyEnd = i;
            break;
          }
        }
      }
      if (bodyEnd === -1) return { ids: [], found: false };
      const loopBody = src.slice(bodyStart, bodyEnd);
      const assigns = /realById\[id\]\s*=/.test(loopBody);
      if (!assigns) return { ids: [], found: false };
      const idRe = /\[\s*'[^']*'\s*,\s*'([^']+)'\s*,/g;
      const ids = [];
      let tm;
      while ((tm = idRe.exec(tupleBlock))) ids.push(tm[1]);
      return { ids, found: true };
    },
  },
  {
    name: 'employer-news card (EMPLOYER_NEWS_MANIFEST_ID resolved from the manifest mentionOrZero card)',
    resolve(src, manifestCards) {
      // Only credit this site if the source actually still keys a realById
      // entry by EMPLOYER_NEWS_MANIFEST_ID with a real generator call. The
      // general requiredCloudCards spread-into-realById check (which this id
      // ALSO depends on, since EMPLOYER_NEWS_MANIFEST_ID flows through
      // requiredCards.byManifestId) is enforced separately by
      // extractRequiredCloudCardIds, so this site does not duplicate it.
      const employerEntryPresent = /\[EMPLOYER_NEWS_MANIFEST_ID,\s*format\w+\(/.test(src);
      if (!employerEntryPresent) return { ids: [], found: false };
      const card = manifestCards.find((c) => c && c.mentionOrZero);
      return { ids: card ? [card.id] : [], found: true };
    },
  },
];

// Locate the body of the `const realById = { ... }` object literal via
// brace-depth-aware scanning (regex alone cannot safely bound a
// multi-hundred-line object literal containing nested braces/strings), and
// compute a per-offset cumulative {[( depth so callers can restrict matches
// to TOP-LEVEL (depth 0) content -- i.e. direct properties/spreads of
// realById, not nested object literals passed as generator arguments (e.g.
// formatSystemHealthSection({...})). Shared by extractRealByIdLiteralKeys
// (property keys) and extractRealByIdLiteralSpread (the byManifestId spread
// element, which has no `identifier:` shape so the key regex cannot see it).
function locateRealByIdLiteralBody(src) {
  const startMarker = 'const realById = {';
  const startIdx = src.indexOf(startMarker);
  if (startIdx === -1) return null;
  const braceStart = startIdx + startMarker.length - 1; // index of the '{'
  let depth = 0;
  let endIdx = -1;
  for (let i = braceStart; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        endIdx = i;
        break;
      }
    }
  }
  if (endIdx === -1) return null;
  const body = src.slice(braceStart + 1, endIdx);
  const depthAtOffset = new Array(body.length);
  let depthCounter = 0;
  for (let i = 0; i < body.length; i++) {
    depthAtOffset[i] = depthCounter;
    const ch = body[i];
    if (ch === '{' || ch === '(' || ch === '[') depthCounter++;
    else if (ch === '}' || ch === ')' || ch === ']') depthCounter--;
  }
  return { body, depthAtOffset };
}

// Extract the top-level keys of the realById object literal.
function extractRealByIdLiteralKeys(src) {
  const located = locateRealByIdLiteralBody(src);
  if (!located) return { keys: [], found: false };
  const { body, depthAtOffset } = located;
  const keys = [];
  const keyRe = /(^|[\n{,])\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/g;
  let match;
  while ((match = keyRe.exec(body))) {
    const offset = match.index + match[1].length;
    if (depthAtOffset[offset] === 0) keys.push(match[2]);
  }
  return { keys, found: true };
}

// Extract ids from the `entries` array inside buildRequiredCloudCards(), i.e.
// the ids that land in requiredCards.byManifestId. Handles both plain
// string-literal ids (['ai_tech_news', ...]) and the employer-news
// identifier constant ([EMPLOYER_NEWS_MANIFEST_ID, ...]), which is credited
// by the DYNAMIC_WIRING_SITES employer entry instead so it is not double
// counted here.
//
// Codex review (2026-07-02): listing ids in this array only proves
// buildRequiredCloudCards() PRODUCES them -- it does NOT prove realById ever
// receives them. The actual wiring is the `...requiredCards.byManifestId`
// spread inside the realById object literal (cloud-morning-briefing.js
// ~7817). If a refactor removed that spread while leaving this entries array
// untouched, every one of these ids would silently stop being real-wired.
// So this function now ALSO requires that spread to be present as a
// TOP-LEVEL key of the realById literal (via extractRealByIdLiteralKeys'
// depth-0 scan, reused here so both checks share one source of truth for
// "top level of realById"), and reports not-found otherwise -- crediting
// zero ids rather than a false "still wired" pass.
function extractRequiredCloudCardIds(src) {
  const fnMarker = 'function buildRequiredCloudCards(';
  const fnStart = src.indexOf(fnMarker);
  if (fnStart === -1) return { ids: [], found: false };
  const arrMarker = 'const entries = [';
  const arrStart = src.indexOf(arrMarker, fnStart);
  if (arrStart === -1) return { ids: [], found: false };
  const bracketStart = arrStart + arrMarker.length - 1;
  let depth = 0;
  let endIdx = -1;
  for (let i = bracketStart; i < src.length; i++) {
    const ch = src[i];
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) {
        endIdx = i;
        break;
      }
    }
  }
  if (endIdx === -1) return { ids: [], found: false };

  // Prove the spread actually lands inside the realById object literal, not
  // just anywhere in the file (e.g. a stale comment or a different object).
  const { spreadIsTopLevelRealByIdKey } = extractRealByIdLiteralSpread(src);
  if (!spreadIsTopLevelRealByIdKey) return { ids: [], found: false };

  const body = src.slice(bracketStart + 1, endIdx);
  const idRe = /\[\s*'([^']+)'\s*,/g;
  const ids = [];
  let m;
  while ((m = idRe.exec(body))) ids.push(m[1]);
  return { ids, found: true };
}

// Proves `...requiredCards.byManifestId` appears as a TOP-LEVEL (depth-0)
// entry inside the realById object literal. A spread element has no
// `identifier:` shape, so extractRealByIdLiteralKeys' key regex cannot see
// it -- this is a dedicated check for that one spread-element wiring site.
function extractRealByIdLiteralSpread(src) {
  const located = locateRealByIdLiteralBody(src);
  if (!located) return { spreadIsTopLevelRealByIdKey: false };
  const { body, depthAtOffset } = located;
  const spreadRe = /\.\.\.requiredCards\.byManifestId/g;
  let match;
  while ((match = spreadRe.exec(body))) {
    if (depthAtOffset[match.index] === 0) return { spreadIsTopLevelRealByIdKey: true };
  }
  return { spreadIsTopLevelRealByIdKey: false };
}

/**
 * Compute the full set of manifest card ids that are wired to a live cloud
 * builder, plus diagnostics about which extraction sites fired.
 */
function computeWiredCardIds({
  src = fs.readFileSync(BRIEFING_SOURCE_PATH, 'utf8'),
  manifestCards,
} = {}) {
  const wired = new Set();
  const sites = [];

  const literalKeys = extractRealByIdLiteralKeys(src);
  sites.push({ name: 'realById object literal keys', ...literalKeys, ids: literalKeys.keys });
  for (const k of literalKeys.keys) wired.add(k);

  const requiredCardIds = extractRequiredCloudCardIds(src);
  sites.push({ name: 'buildRequiredCloudCards entries (byManifestId spread)', ...requiredCardIds });
  for (const id of requiredCardIds.ids) wired.add(id);

  for (const site of DYNAMIC_WIRING_SITES) {
    const result = site.resolve(src, manifestCards);
    sites.push({ name: site.name, ...result });
    for (const id of result.ids) wired.add(id);
  }

  return { wired, sites };
}

/**
 * Audit the canonical manifest against the wired-id set. Returns:
 *   - unwired: manifest card ids with no realById wiring and not in the
 *     ALWAYS_HONEST_BLOCKER allowlist (the CI failure condition)
 *   - staleAllowlist: ALWAYS_HONEST_BLOCKER entries that are actually wired
 *     (so the allowlist can be trimmed -- not a failure, just a signal)
 */
function auditManifestWiring({ manifestCards, alwaysHonestBlocker = [], src } = {}) {
  const { wired, sites } = computeWiredCardIds({ src, manifestCards });
  const allowlist = new Set(alwaysHonestBlocker);
  const unwired = manifestCards
    .map((c) => c.id)
    .filter((id) => !wired.has(id) && !allowlist.has(id));
  const staleAllowlist = [...allowlist].filter((id) => wired.has(id));
  return { wired, sites, unwired, staleAllowlist };
}

module.exports = {
  BRIEFING_SOURCE_PATH,
  extractRealByIdLiteralKeys,
  extractRealByIdLiteralSpread,
  extractRequiredCloudCardIds,
  computeWiredCardIds,
  auditManifestWiring,
};
