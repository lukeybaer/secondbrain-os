// gmail-scan-watermark.js
//
// Incremental rebuild support for data/briefing-action-items.json.
//
// Background: the Gmail action-item artifact (data/briefing-action-items.json)
// used to be rebuilt daily by scanning the last 200 Gmail threads in full.
// That is wasteful: most of those 200 threads are unchanged day-over-day.
//
// Luke approved rebuilding the artifact from Gmail threads, but it MUST be
// incremental. This module persists a seen-thread watermark and decides which
// threads actually need a (re)fetch on each run:
//
//   * NEW threads (never seen before)            -> fetch
//   * SEEN threads whose reply count grew         -> fetch (new reply landed)
//   * SEEN threads whose last message is newer    -> fetch (new activity)
//   * SEEN threads unchanged since last scan      -> SKIP (no fetch)
//
// The watermark sidecar lives at data/agent/gmail-scan-watermark.json and is
// tiny: a per-thread record of {messageCount, lastMessageAt} plus the scan
// timestamp. It does NOT change the schema of briefing-action-items.json.
//
// The Gmail scan workflow uses this module like so:
//   1. const wm = loadWatermark(repoRoot)
//   2. List candidate threads cheaply (gmail_search_messages returns thread
//      ids + message counts without reading full bodies).
//   3. const { toFetch } = selectThreadsToFetch(wm, candidates)
//   4. Only call gmail_read_thread on `toFetch`.
//   5. recordScanned(wm, fetchedThreads) for every thread actually fetched.
//   6. saveWatermark(repoRoot, wm)
//
// This module is pure (no Gmail API calls, no Electron deps) so it is cheap
// to unit test.

const fs = require('node:fs');
const path = require('node:path');

const WATERMARK_REL = path.join('data', 'agent', 'gmail-scan-watermark.json');
const WATERMARK_VERSION = 1;

/**
 * @typedef {Object} ThreadCandidate
 * @property {string} threadId        Gmail thread id (stable).
 * @property {number} [messageCount]  Number of messages in the thread.
 * @property {string} [lastMessageAt] ISO timestamp of the newest message.
 */

/**
 * @typedef {Object} Watermark
 * @property {number} version
 * @property {string|null} lastScanAt   ISO timestamp of the previous scan.
 * @property {Object.<string, {messageCount:number,lastMessageAt:string|null,seenAt:string}>} threads
 */

function watermarkPath(repoRoot) {
  return path.join(repoRoot, WATERMARK_REL);
}

/** A fresh, empty watermark. */
function blankWatermark() {
  return { version: WATERMARK_VERSION, lastScanAt: null, threads: {} };
}

/**
 * Load the watermark sidecar. Returns a blank watermark if the file is
 * missing or unreadable so the first run scans everything.
 * @param {string} repoRoot
 * @returns {Watermark}
 */
function loadWatermark(repoRoot) {
  const p = watermarkPath(repoRoot);
  if (!fs.existsSync(p)) return blankWatermark();
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!raw || typeof raw !== 'object' || !raw.threads || typeof raw.threads !== 'object') {
      return blankWatermark();
    }
    return {
      version: typeof raw.version === 'number' ? raw.version : WATERMARK_VERSION,
      lastScanAt: typeof raw.lastScanAt === 'string' ? raw.lastScanAt : null,
      threads: raw.threads,
    };
  } catch {
    // Corrupt sidecar must never wedge the scan: fall back to a full scan.
    return blankWatermark();
  }
}

/**
 * Persist the watermark sidecar.
 * @param {string} repoRoot
 * @param {Watermark} watermark
 */
function saveWatermark(repoRoot, watermark) {
  const p = watermarkPath(repoRoot);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const out = {
    version: WATERMARK_VERSION,
    lastScanAt: watermark.lastScanAt || new Date().toISOString(),
    threads: watermark.threads || {},
  };
  fs.writeFileSync(p, JSON.stringify(out, null, 2), 'utf8');
}

/**
 * Decide whether a single candidate thread needs to be (re)fetched given
 * what the watermark already knows about it.
 * @param {Watermark} watermark
 * @param {ThreadCandidate} candidate
 * @returns {{ fetch: boolean, reason: string }}
 */
function threadNeedsFetch(watermark, candidate) {
  if (!candidate || !candidate.threadId) {
    return { fetch: false, reason: 'no-thread-id' };
  }
  const prev = watermark.threads[candidate.threadId];
  if (!prev) {
    return { fetch: true, reason: 'new-thread' };
  }
  // A grown message count means a new reply landed on a thread we have seen.
  if (
    typeof candidate.messageCount === 'number' &&
    typeof prev.messageCount === 'number' &&
    candidate.messageCount > prev.messageCount
  ) {
    return { fetch: true, reason: 'new-reply' };
  }
  // A newer last-message timestamp also signals new activity even if the
  // message count is not available from the cheap listing call.
  if (
    candidate.lastMessageAt &&
    prev.lastMessageAt &&
    Date.parse(candidate.lastMessageAt) > Date.parse(prev.lastMessageAt)
  ) {
    return { fetch: true, reason: 'newer-message' };
  }
  return { fetch: false, reason: 'unchanged' };
}

/**
 * Split a list of candidate threads into the ones that need fetching and the
 * ones that can be skipped, based on the watermark.
 * @param {Watermark} watermark
 * @param {ThreadCandidate[]} candidates
 * @returns {{ toFetch: ThreadCandidate[], skipped: ThreadCandidate[], reasons: Object.<string,string> }}
 */
function selectThreadsToFetch(watermark, candidates) {
  const toFetch = [];
  const skipped = [];
  const reasons = {};
  for (const candidate of candidates || []) {
    const { fetch, reason } = threadNeedsFetch(watermark, candidate);
    reasons[candidate.threadId] = reason;
    if (fetch) toFetch.push(candidate);
    else skipped.push(candidate);
  }
  return { toFetch, skipped, reasons };
}

/**
 * Record that a thread was fetched this run, updating its watermark entry.
 * Call this for every thread actually read with gmail_read_thread.
 * @param {Watermark} watermark
 * @param {ThreadCandidate} fetched
 */
function recordScanned(watermark, fetched) {
  if (!fetched || !fetched.threadId) return;
  const prev = watermark.threads[fetched.threadId] || {};
  watermark.threads[fetched.threadId] = {
    messageCount:
      typeof fetched.messageCount === 'number'
        ? fetched.messageCount
        : typeof prev.messageCount === 'number'
          ? prev.messageCount
          : 0,
    lastMessageAt: fetched.lastMessageAt || prev.lastMessageAt || null,
    seenAt: new Date().toISOString(),
  };
}

/**
 * Stamp the scan-completion time onto the watermark. Call once at the end of
 * a scan after all recordScanned() calls.
 * @param {Watermark} watermark
 * @param {string} [at] ISO timestamp; defaults to now.
 */
function markScanComplete(watermark, at) {
  watermark.lastScanAt = at || new Date().toISOString();
}

module.exports = {
  WATERMARK_REL,
  WATERMARK_VERSION,
  watermarkPath,
  blankWatermark,
  loadWatermark,
  saveWatermark,
  threadNeedsFetch,
  selectThreadsToFetch,
  recordScanned,
  markScanComplete,
};
