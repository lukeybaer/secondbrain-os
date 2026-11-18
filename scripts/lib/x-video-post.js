'use strict';

// Native video posts to the Examplechannel X account only (Owner decision:
// "yes" to posting to one X account instead of both; @Examplechannel7 kept
// because it matches the YouTube brand channel). The 2026-09-25 rule posted
// the same video from both accounts within seconds; with zero followers every
// post drew zero impressions, and identical media from two accounts risks
// X's duplicate-content spam signal. The owner's personal X account no longer auto-posts.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { defineStateMachine, withFileLock } = require('./ledger-state-machine');

const X_API = 'https://api.x.com';
const CHUNK_BYTES = 4 * 1024 * 1024;
const DAILY_CAP_PER_ACCOUNT = 2;
// A posting claim older than this belongs to a dead run. It matches the age at
// which the per-video lock file is treated as stale.
const POSTING_TTL_MS = 30 * 60 * 1000;
const MAX_FAILED_ATTEMPTS = 3;

// Ledger states for one video on one account (state machine audit, the owner,
// 2026-11-03). The audit found a tweet whose answer timed out was written as
// `failed`, which the next run treated as retryable, so the video tweeted twice.
//   held_daily_cap  waiting for the daily cap to open
//   posting         claimed under the ledger lock; upload and the create call run
//   posted          confirmed tweet id (final)
//   failed          provably NO tweet exists (media upload failed, or X refused the
//                   create call with a 4xx); retried up to MAX_FAILED_ATTEMPTS
//   outcome_unknown the create call may have reached X (timeout, network reset,
//                   5xx, no tweet id) or a posting claim died; never retried
//                   automatically. A reviewer checks x.com/Examplechannel7 and appends
//                   a `posted` row (tweet is live) or a `failed` row (it is not).
const LEDGER_STATES = defineStateMachine({
  name: 'x-video-post-ledger',
  transitions: {
    '': ['held_daily_cap', 'posting'],
    held_daily_cap: ['posting'],
    posting: ['posting', 'posted', 'failed', 'outcome_unknown'],
    failed: ['posting', 'held_daily_cap'],
    outcome_unknown: ['outcome_unknown', 'posted', 'failed'],
  },
  terminal: ['posted'],
  // `failed` carries the retry budget; only `posting` is a live in-flight state.
  inFlight: { posting: { ttlMs: POSTING_TTL_MS }, failed: { maxAttempts: MAX_FAILED_ATTEMPTS } },
});
const DEFAULT_LEDGER_FILE = path.join(
  process.env.SECONDBRAIN_DATA_DIR || (process.platform === 'linux' ? '/opt/secondbrain/data' : path.join(__dirname, '..', '..', 'data')),
  'x',
  'approved-video-posts.jsonl',
);

const ACCOUNTS = Object.freeze([
  {
    handle: 'Examplechannel7',
    tokenKey: 'examplechannelAccessToken',
    secretKey: 'examplechannelAccessTokenSecret',
  },
]);

function percentEncode(value) {
  return encodeURIComponent(String(value)).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

// OAuth 1.0a header. JSON and multipart bodies are not signed; only the
// oauth_* parameters and URL query parameters are.
function oauthHeader({ method, url, consumerKey, consumerSecret, token, tokenSecret, nonce, timestamp }) {
  const parsed = new URL(url);
  const oauth = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: nonce || crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(timestamp || Math.floor(Date.now() / 1000)),
    oauth_token: token,
    oauth_version: '1.0',
  };
  const params = { ...oauth };
  for (const [key, value] of parsed.searchParams) params[key] = value;
  const paramString = Object.keys(params)
    .sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(params[key])}`)
    .join('&');
  const baseUrl = `${parsed.origin}${parsed.pathname}`;
  const base = [method.toUpperCase(), percentEncode(baseUrl), percentEncode(paramString)].join('&');
  const signingKey = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
  oauth.oauth_signature = crypto.createHmac('sha1', signingKey).update(base).digest('base64');
  return `OAuth ${Object.keys(oauth)
    .sort()
    .map((key) => `${percentEncode(key)}="${percentEncode(oauth[key])}"`)
    .join(', ')}`;
}

// The AI-presenter disclosure line on X (Codex reviews a6f6dabb8f34 and
// 754882545a62 F6): the row's label, one line, capped so the caption always
// keeps the title; an oversized or empty label falls back to the default.
const SYNTHETIC_LABEL_MAX = 80;
const DEFAULT_SYNTHETIC_LABEL = 'Presenter made with AI.';
function syntheticDisclosureLine(video) {
  if (!video || video.synthetic_media !== true) return '';
  const label = String(video.synthetic_media_label || '').replace(/\s+/g, ' ').trim();
  return label && label.length <= SYNTHETIC_LABEL_MAX ? label : DEFAULT_SYNTHETIC_LABEL;
}

function captionFor(video, account) {
  // Titles come from third-party sources: strip links and neutralize @ so a
  // title can never post as a mention or a link.
  const title =
    String(video.title || '')
      .replace(/https?:\/\/\S+/gi, '')
      .replace(/@(\w)/g, '@\u200b$1')
      .replace(/\s+/g, ' ')
      .trim() || 'New Examplechannel short';
  // Different copy per account so the two posts are not identical text.
  // An AI-presenter row (synthetic_media true) posts its disclosure line too:
  // Kling's terms name the generator and the Sadie rules label her as AI
  // (Codex review a6f6dabb8f34). The suffix is never cut; the title yields.
  const line = syntheticDisclosureLine(video);
  const disclosure = line ? `\n\n${line}` : '';
  const suffix = `${account.handle === 'Examplechannel7' ? '\n\n#AI #Examplechannel' : ''}${disclosure}`;
  return `${title.slice(0, 280 - suffix.length)}${suffix}`;
}

function ctDay(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(date);
}

// `strict` is for the locked decide-and-claim step: a ledger that exists but
// cannot be read must stop the post, never look empty and invite a repost.
function readLedger(file, { strict = false } = {}) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (strict && error.code !== 'ENOENT') throw error;
    return [];
  }
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function rowsFor(ledger, videoId, handle) {
  return ledger.filter((row) => row.videoId === videoId && row.account === handle);
}

function failedAttempts(rows) {
  return rows.filter((row) => row.status === 'failed').length;
}

// The state one video+account is really in, from its rows in ledger order.
// Two stored states mean "outcome unknown" without saying so:
//  - a `posting` claim past its TTL (the run died, maybe after tweeting);
//  - a `failed` row written by the old code right after a `posting` row, which
//    could be a timed-out create call that did post. Rows written now carry
//    tweetCreated:false when they are provably unposted.
function effectiveState(rows, nowMs = Date.now()) {
  if (rows.some((row) => row.status === 'posted')) return { state: 'posted' };
  const last = rows[rows.length - 1];
  if (!last) return { state: '' };
  const state = LEDGER_STATES.normalize(last.status);
  if (state === 'posting' && LEDGER_STATES.isExpired('posting', last.at, nowMs)) {
    return { state: 'outcome_unknown', implied: 'posting claim expired without a result' };
  }
  if (state === 'failed' && last.tweetCreated !== false && rows[rows.length - 2]?.status === 'posting') {
    return { state: 'outcome_unknown', implied: 'earlier failed row after a posting row, tweet not ruled out' };
  }
  return { state };
}

// True when a run must not post this video again by itself: it is posted, a
// run holds the claim, or the outcome is unknown. Failed rows are decided by
// the retry budget in claimPost.
function alreadyPosted(ledger, videoId, handle, nowMs = Date.now()) {
  const { state } = effectiveState(rowsFor(ledger, videoId, handle), nowMs);
  return state === 'posted' || state === 'posting' || state === 'outcome_unknown';
}

// Append one row under the ledger lock after checking the move is legal from
// the row's real current state. The lock makes check and write one step, so two
// processes cannot both move the same row (posting -> posted twice, a claim
// over a claim).
function recordTransition(ledgerFile, videoId, handle, to, fields = {}, nowMs = Date.now()) {
  return withFileLock(ledgerFile, () => {
    const from = effectiveState(rowsFor(readLedger(ledgerFile, { strict: true }), videoId, handle), nowMs).state;
    return appendRow(ledgerFile, from, to, { videoId, account: handle, status: to, ...fields });
  });
}

function appendRow(ledgerFile, from, to, row) {
  LEDGER_STATES.assertTransition(from, to);
  const entry = { at: new Date().toISOString(), ...row };
  fs.appendFileSync(ledgerFile, `${JSON.stringify(entry)}\n`);
  return entry;
}

// The YouTube settlement used to delete the staged video while X was still
// cap-held, so the held post could never run (2026-10-22). The file stays
// until every active account has a confirmed posted row: a posting intent can
// still end in a failed, retryable post (Codex 45a38a5a9c23).
function xStillNeedsVideo(ledger, videoId, accounts = ACCOUNTS) {
  return accounts.some(
    (account) => !ledger.some((row) => row.videoId === videoId && row.account === account.handle && row.status === 'posted'),
  );
}

// Only holds for accounts that still post count: rows for a retired account
// (The owner's personal account after 2026-09-29) would otherwise be retried forever.
// Drain candidates: still waiting on the cap, or cap-held once and since failed
// before any tweet existed with retries left. A posting claim, an unknown
// outcome and a posted row are never drained. A failed row on a video the cap
// never held is not drained either, so old failures cannot wake up later.
function heldVideoIds(ledger, accounts = ACCOUNTS, nowMs = Date.now()) {
  const active = new Set(accounts.map((account) => account.handle));
  const streams = new Map();
  for (const row of ledger) {
    if (!active.has(row.account) || !row.videoId) continue;
    const key = `${row.videoId}|${row.account}`;
    if (!streams.has(key)) streams.set(key, []);
    streams.get(key).push(row);
  }
  const held = new Set();
  for (const [key, rows] of streams) {
    const { state } = effectiveState(rows, nowMs);
    const retryable =
      state === 'failed' &&
      rows.some((row) => row.status === 'held_daily_cap') &&
      !LEDGER_STATES.attemptsExhausted('failed', failedAttempts(rows));
    if (state === 'held_daily_cap' || retryable) held.add(key.split('|')[0]);
  }
  return [...held];
}

// One poster per video at a time: a double-click launches two processes.
function acquireLock(ledgerFile, videoId) {
  const lockFile = `${ledgerFile}.${String(videoId).replace(/[^\w.-]+/g, '_')}.lock`;
  try {
    const fd = fs.openSync(lockFile, 'wx');
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const ageMs = Date.now() - fs.statSync(lockFile).mtimeMs;
    if (ageMs < 30 * 60 * 1000) return null;
    fs.rmSync(lockFile, { force: true });
    return acquireLock(ledgerFile, videoId);
  }
  return () => fs.rmSync(lockFile, { force: true });
}

function postsToday(ledger, handle, now) {
  const day = ctDay(now);
  return ledger.filter(
    (row) => row.account === handle && row.status === 'posted' && ctDay(new Date(row.at)) === day,
  ).length;
}

async function xFetch(fetchFn, { method, url, creds, account, body, headers = {} }) {
  const auth = oauthHeader({
    method,
    url,
    consumerKey: creds.apiKey,
    consumerSecret: creds.apiSecret,
    token: creds[account.tokenKey],
    tokenSecret: creds[account.secretKey],
  });
  const res = await fetchFn(url, { method, headers: { Authorization: auth, ...headers }, body });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const error = new Error(`X ${method} ${new URL(url).pathname} failed (${res.status}): ${text.slice(0, 300)}`);
    error.status = res.status;
    throw error;
  }
  return json;
}

async function uploadVideo(fetchFn, { creds, account, videoPath, sleep }) {
  const bytes = fs.readFileSync(videoPath);
  const init = await xFetch(fetchFn, {
    method: 'POST',
    url: `${X_API}/2/media/upload/initialize`,
    creds,
    account,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ media_type: 'video/mp4', total_bytes: bytes.length, media_category: 'tweet_video' }),
  });
  const mediaId = String(init?.data?.id || init?.data?.media_id_string || init?.media_id_string || '');
  if (!mediaId) throw new Error('X media initialize returned no media id');
  for (let offset = 0, index = 0; offset < bytes.length; offset += CHUNK_BYTES, index += 1) {
    const form = new FormData();
    form.append('segment_index', String(index));
    form.append('media', new Blob([bytes.subarray(offset, offset + CHUNK_BYTES)]), 'chunk.mp4');
    await xFetch(fetchFn, {
      method: 'POST',
      url: `${X_API}/2/media/upload/${mediaId}/append`,
      creds,
      account,
      body: form,
    });
  }
  let state = await xFetch(fetchFn, {
    method: 'POST',
    url: `${X_API}/2/media/upload/${mediaId}/finalize`,
    creds,
    account,
  });
  for (let poll = 0; poll < 60; poll += 1) {
    const info = state?.data?.processing_info || state?.processing_info;
    if (!info || info.state === 'succeeded') return mediaId;
    if (info.state === 'failed') throw new Error(`X media processing failed: ${JSON.stringify(info.error || info)}`);
    await sleep(Math.max(1, Number(info.check_after_secs || 5)) * 1000);
    state = await xFetch(fetchFn, {
      method: 'GET',
      url: `${X_API}/2/media/upload?command=STATUS&media_id=${mediaId}`,
      creds,
      account,
    });
  }
  throw new Error('X media processing did not finish in time');
}

// Decide and claim in one step under the ledger lock, so two drains can never
// both move the same video to posting. Returns { skip } (a result row, nothing
// to post) or { claimed } (the posting row; the caller now owns the upload).
function claimPost(ledgerFile, { video, account, now, ownerNow }) {
  const handle = account.handle;
  const skip = (status, extra = {}) => ({ skip: { videoId: video.id, account: handle, status, ...extra } });
  return withFileLock(ledgerFile, () => {
    const ledger = readLedger(ledgerFile, { strict: true });
    const rows = rowsFor(ledger, video.id, handle);
    const { state, implied } = effectiveState(rows, now.getTime());
    if (state === 'posted') return skip('already_posted');
    if (state === 'posting') return skip('in_progress_elsewhere', { reason: 'another run holds a live posting claim' });
    if (state === 'outcome_unknown') {
      // Write the implied state down once so the ledger, the video status and
      // the next reader all say what the code already knows.
      if (implied) {
        appendRow(ledgerFile, state, 'outcome_unknown', {
          videoId: video.id,
          account: handle,
          status: 'outcome_unknown',
          tweetCreated: 'unknown',
          reason: implied,
        });
      }
      return skip('outcome_unknown', { reason: implied || 'a tweet may already exist; review x.com before any retry' });
    }
    if (state && !LEDGER_STATES.isKnown(state)) {
      return skip('outcome_unknown', { reason: `unrecognized ledger status ${state}; not posting` });
    }
    if (state === 'failed' && LEDGER_STATES.attemptsExhausted('failed', failedAttempts(rows))) {
      return skip('failed', { reason: `retry budget exhausted after ${MAX_FAILED_ATTEMPTS} failed attempts` });
    }
    if (!ownerNow && postsToday(ledger, handle, now) >= DAILY_CAP_PER_ACCOUNT) {
      if (state === 'held_daily_cap') return skip('held_daily_cap');
      const held = appendRow(ledgerFile, state, 'held_daily_cap', {
        videoId: video.id,
        account: handle,
        status: 'held_daily_cap',
        cap: DAILY_CAP_PER_ACCOUNT,
      });
      return { skip: held };
    }
    const claimed = appendRow(ledgerFile, state, 'posting', {
      videoId: video.id,
      account: handle,
      status: 'posting',
      ...(ownerNow ? { cap_override: String(ownerNow).slice(0, 200) } : {}),
    });
    return { claimed };
  });
}

// Only a 4xx answer proves X refused the create call, so no tweet exists.
// Anything else after the request may have left (timeout, reset, 5xx, an answer
// with no tweet id) leaves the outcome unknown. 408 is a timeout, not a refusal.
function tweetProvablyNotCreated(error) {
  const status = Number(error && error.status);
  return Number.isInteger(status) && status >= 400 && status < 500 && status !== 408;
}

async function postApprovedVideoToX({
  video,
  videoPath,
  creds,
  ledgerFile,
  now = new Date(),
  fetchFn = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  accounts = ACCOUNTS,
  // The owner's explicit "post it now" for this one video (publish-now control):
  // the daily cap yields, and the posting row records why.
  ownerNow = '',
  // Re-reads approval right before the tweet is created (Codex b1 review):
  // a rejection that landed during the media upload leaves no tweet. Returns
  // true to post; false, or a throw, refuses.
  stillApproved = null,
} = {}) {
  if (!video || !video.id) throw new Error('approved video id is required');
  if (!videoPath || !fs.existsSync(videoPath)) throw new Error(`approved video file is missing for ${video.id}`);
  const missing = ['apiKey', 'apiSecret', ...accounts.flatMap((a) => [a.tokenKey, a.secretKey])].filter(
    (key) => !creds || !creds[key],
  );
  if (missing.length) throw new Error(`X credentials missing: ${missing.join(', ')}`);
  fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
  const release = acquireLock(ledgerFile, video.id);
  if (!release) return [{ videoId: video.id, status: 'in_progress_elsewhere' }];
  const results = [];
  try {
  for (const account of accounts) {
    const claim = claimPost(ledgerFile, { video, account, now, ownerNow });
    if (claim.skip) {
      results.push(claim.skip);
      continue;
    }
    const move = (to, fields) => recordTransition(ledgerFile, video.id, account.handle, to, fields, now.getTime());
    let mediaId = '';
    let tweetCallStarted = false;
    let tweetId = '';
    try {
      mediaId = await uploadVideo(fetchFn, { creds, account, videoPath, sleep });
      // Second posting row: the point of no return, with the media id for a
      // reviewer, and a fresh TTL clock after a long upload.
      move('posting', { mediaId });
      if (typeof stillApproved === 'function' && (await stillApproved(video.id)) !== true) {
        throw new Error(`${video.id} is no longer approved; no tweet was created`);
      }
      tweetCallStarted = true;
      const tweet = await xFetch(fetchFn, {
        method: 'POST',
        url: `${X_API}/2/tweets`,
        creds,
        account,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: captionFor(video, account), media: { media_ids: [mediaId] } }),
      });
      tweetId = String(tweet?.data?.id || '');
      if (!tweetId) throw new Error('X returned no tweet id');
    } catch (error) {
      const message = String(error.message || error).slice(0, 400);
      results.push(
        !tweetCallStarted || tweetProvablyNotCreated(error)
          ? move('failed', { error: message, tweetCreated: false })
          : move('outcome_unknown', { error: message, tweetCreated: 'unknown', mediaId }),
      );
      continue;
    }
    const url = `https://x.com/${account.handle}/status/${tweetId}`;
    try {
      results.push(move('posted', { tweetId, url }));
    } catch (ledgerError) {
      // The tweet is live. Report it as posted, never as failed; the posting
      // claim stays and expires into outcome_unknown, so nothing retries it.
      results.push({
        videoId: video.id,
        account: account.handle,
        status: 'posted',
        tweetId,
        url,
        ledgerWriteFailed: String(ledgerError.message || ledgerError).slice(0, 200),
      });
    }
  }
  } finally {
    release();
  }
  return results;
}

module.exports = {
  SYNTHETIC_LABEL_MAX,
  syntheticDisclosureLine,
  ACCOUNTS,
  DAILY_CAP_PER_ACCOUNT,
  POSTING_TTL_MS,
  MAX_FAILED_ATTEMPTS,
  LEDGER_STATES,
  DEFAULT_LEDGER_FILE,
  oauthHeader,
  captionFor,
  postsToday,
  alreadyPosted,
  effectiveState,
  recordTransition,
  heldVideoIds,
  xStillNeedsVideo,
  readLedger,
  postApprovedVideoToX,
};
