'use strict';

/**
 * Tolerant token-scan helper for "does call A happen before call B in this
 * function body" regression tests, WITHOUT a full JS parser dependency.
 *
 * WHY: a plain `src.indexOf('someCall(')` ordering assertion (as used by
 * system-health-otter-enrichment-label.test.js before this module existed) is
 * fragile: adding/editing a COMMENT that happens to mention the call name
 * before the real call site can flip the measured order without the actual
 * code changing, and a comment can just as easily hide a real reordering bug
 * by keeping the OLD call name string present nearby. Stripping comments
 * removes that failure mode.
 *
 * String/template literal CONTENTS are preserved verbatim by stripComments
 * (never treated as comments), but their spans are also RECORDED so
 * findCallSiteInStripped can reject any match that falls inside one -- a
 * plain indexOf over the stripped text would otherwise still be fooled by a
 * string that happens to contain the literal call-name text (e.g. an error
 * message mentioning "updateSystemHealth("). Recording + excluding spans is
 * what actually prevents that false match; merely preserving the text does
 * not (Codex adversarial review finding 3, 2026-07-05).
 *
 * This is NOT a general-purpose JS tokenizer -- it only needs to be correct
 * enough to (a) drop `//line` and `/* block *\/` comments and (b) exclude
 * string/template literal contents from call-site matches, so a
 * call-expression search on the remaining source finds only REAL call sites.
 */

// Strip comments while preserving string/template literal contents verbatim
// (so a string that happens to contain "//" or "/*" is never mistaken for a
// comment start) and preserving all other source unchanged so slice/indexOf
// offsets still map onto meaningful code. Also records each literal's
// [start, end) span (in the OUTPUT/stripped coordinate space) in
// `literalSpans` when an array is passed, so callers can reject a match that
// falls inside a string/template literal's CONTENTS rather than treating a
// literal as just "preserved" -- a plain indexOf over the stripped text would
// otherwise be fooled by a string that happens to contain the exact call-name
// text (Codex adversarial review finding 3 on the ordering test: this
// function preserves literal contents verbatim, which earlier misleadingly
// read as "ignores" them; only recording + excluding their spans actually
// prevents a false match).
function stripComments(src, literalSpans) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === '/' && c2 === '/') {
      // Line comment: skip to end of line (keep the newline itself so line
      // numbers / rough offsets stay stable).
      const nl = src.indexOf('\n', i);
      i = nl === -1 ? n : nl;
      continue;
    }
    if (c === '/' && c2 === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      const spanStart = out.length;
      let j = i + 1;
      out += c;
      while (j < n) {
        if (src[j] === '\\') {
          out += src[j] + (src[j + 1] || '');
          j += 2;
          continue;
        }
        out += src[j];
        if (src[j] === quote) {
          j += 1;
          break;
        }
        j += 1;
      }
      if (literalSpans) literalSpans.push([spanStart, out.length]);
      i = j;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

// True when [idx, idx + len) overlaps any recorded literal span -- i.e. the
// match sits inside a string/template literal's contents rather than being
// real code.
function overlapsLiteral(literalSpans, idx, len) {
  const end = idx + len;
  for (const [start, spanEnd] of literalSpans) {
    if (idx < spanEnd && end > start) return true;
  }
  return false;
}

// Find the character offset of the first REAL (non-string-literal) call site
// of `callName(` in ALREADY-STRIPPED text, searched from `fromIndex` (an
// offset that must itself be in stripped-text coordinates -- see
// resolveMarker below). Skips any indexOf hit that falls inside a recorded
// literal span (a string/template literal that happens to contain the exact
// text), continuing the search past it. Returns -1 if no real call site is
// found.
function findCallSiteInStripped(strippedSrc, callName, fromIndex = 0, literalSpans = []) {
  const needle = `${callName}(`;
  let idx = strippedSrc.indexOf(needle, fromIndex);
  while (idx !== -1 && overlapsLiteral(literalSpans, idx, needle.length)) {
    idx = strippedSrc.indexOf(needle, idx + 1);
  }
  return idx;
}

// Resolve a plain substring marker (e.g. "includes('--voice-only')") to its
// offset WITHIN THE STRIPPED TEXT. Callers must locate branch boundaries by
// marker text, never by a raw offset computed against the unstripped source
// -- stripping comments changes string length/offsets, so an offset from the
// original source does not line up with the stripped text it is meant to
// bound (the bug this module exists to avoid: silently searching the wrong
// slice and reporting a call as "not found").
function resolveMarker(strippedSrc, marker, fromIndex = 0) {
  return strippedSrc.indexOf(marker, fromIndex);
}

// Resolve a CHAIN of markers in order, each searched strictly after the
// previous one resolved to, all in stripped-text coordinates. Lets a caller
// express "inside the --voice-only branch, after its own return statement"
// as `afterMarkers: ["includes('--voice-only')", 'return;']` without ever
// hand-computing an offset against the unstripped source (each step's start
// point is itself a resolved stripped-text offset, so nothing can drift).
// Returns -1 if any marker in the chain is not found.
function resolveMarkerChain(strippedSrc, markers = []) {
  let pos = 0;
  for (const marker of markers) {
    const idx = resolveMarker(strippedSrc, marker, pos);
    if (idx === -1) return -1;
    pos = idx + marker.length;
  }
  return pos;
}

// Assert that `first` appears as a real call site strictly before `then` in
// `src`, both bounded to start searching at the stripped-text offset reached
// by resolving `afterMarkers` in order (a plain substring chain, resolved via
// resolveMarkerChain so callers never hand-compute an offset against the
// unstripped source -- stripping comments changes string length/offsets, so
// a raw offset from the original source would not line up with the stripped
// text it is meant to bound). Returns { orderedCorrectly, firstIdx, thenIdx,
// firstFound, thenFound, markerFound } so tests can produce a descriptive
// failure message without re-deriving offsets.
function assertCallOrder(src, { first, then, afterMarkers = [] } = {}) {
  const literalSpans = [];
  const stripped = stripComments(src, literalSpans);
  const start = resolveMarkerChain(stripped, afterMarkers);
  const firstIdx = start === -1 ? -1 : findCallSiteInStripped(stripped, first, start, literalSpans);
  const thenIdx = start === -1 ? -1 : findCallSiteInStripped(stripped, then, start, literalSpans);
  return {
    markerFound: start !== -1,
    firstIdx,
    thenIdx,
    firstFound: firstIdx !== -1,
    thenFound: thenIdx !== -1,
    orderedCorrectly: firstIdx !== -1 && thenIdx !== -1 && firstIdx < thenIdx,
  };
}

module.exports = {
  stripComments,
  overlapsLiteral,
  findCallSiteInStripped,
  resolveMarker,
  resolveMarkerChain,
  assertCallOrder,
};
