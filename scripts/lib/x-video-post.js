'use strict';

// Native video posts to the Examplechannel X account only (ExampleCo, 2026-09-29:
// "yes" to posting to one X account instead of both; @Examplechannel7 kept
// because it matches the YouTube brand channel). The 2026-09-25 rule posted
// the same video from both accounts within seconds; with zero followers every
// post drew zero impressions, and identical media from two accounts risks
// X's duplicate-content spam signal. @ExampleCo no longer auto-posts.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const X_API = 'https://api.x.com';
const CHUNK_BYTES = 4 * 1024 * 1024;
const DAILY_CAP_PER_ACCOUNT = 2;

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
  const text = account.handle === 'Examplechannel7' ? `${title}\n\n#AI #Examplechannel` : title;
  return text.slice(0, 280);
}

function ctDay(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(date);
}

function readLedger(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
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
  } catch {
    return [];
  }
}

// A 'posting' intent row with no later terminal row means a run died after
// it may have tweeted; treat it as done so a rerun can never double-post.
function alreadyPosted(ledger, videoId, handle) {
  const rows = ledger.filter((row) => row.videoId === videoId && row.account === handle);
  if (rows.some((row) => row.status === 'posted')) return true;
  const last = rows[rows.length - 1];
  return Boolean(last && last.status === 'posting');
}

// Only holds for accounts that still post count: rows for a retired account
// (@ExampleCo after 2026-09-29) would otherwise be retried forever.
function heldVideoIds(ledger, accounts = ACCOUNTS) {
  const active = new Set(accounts.map((account) => account.handle));
  const held = new Set();
  for (const row of ledger) {
    if (!active.has(row.account)) continue;
    const key = `${row.videoId}|${row.account}`;
    if (row.status === 'held_daily_cap') held.add(key);
    if (row.status === 'posted' || row.status === 'posting') held.delete(key);
  }
  return [...new Set([...held].map((key) => key.split('|')[0]))];
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

async function postApprovedVideoToX({
  video,
  videoPath,
  creds,
  ledgerFile,
  now = new Date(),
  fetchFn = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  accounts = ACCOUNTS,
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
    const ledger = readLedger(ledgerFile);
    const record = (row) => {
      const entry = { at: new Date().toISOString(), videoId: video.id, account: account.handle, ...row };
      fs.appendFileSync(ledgerFile, `${JSON.stringify(entry)}\n`);
      results.push(entry);
    };
    if (alreadyPosted(ledger, video.id, account.handle)) {
      results.push({ videoId: video.id, account: account.handle, status: 'already_posted' });
      continue;
    }
    if (postsToday(ledger, account.handle, now) >= DAILY_CAP_PER_ACCOUNT) {
      const prior = ledger.filter((row) => row.videoId === video.id && row.account === account.handle);
      if (prior.length && prior[prior.length - 1].status === 'held_daily_cap') {
        results.push({ videoId: video.id, account: account.handle, status: 'held_daily_cap' });
      } else {
        record({ status: 'held_daily_cap', cap: DAILY_CAP_PER_ACCOUNT });
      }
      continue;
    }
    try {
      const mediaId = await uploadVideo(fetchFn, { creds, account, videoPath, sleep });
      fs.appendFileSync(
        ledgerFile,
        `${JSON.stringify({ at: new Date().toISOString(), videoId: video.id, account: account.handle, status: 'posting', mediaId })}\n`,
      );
      const tweet = await xFetch(fetchFn, {
        method: 'POST',
        url: `${X_API}/2/tweets`,
        creds,
        account,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: captionFor(video, account), media: { media_ids: [mediaId] } }),
      });
      const tweetId = String(tweet?.data?.id || '');
      if (!tweetId) throw new Error('X returned no tweet id');
      record({ status: 'posted', tweetId, url: `https://x.com/${account.handle}/status/${tweetId}` });
    } catch (error) {
      record({ status: 'failed', error: String(error.message || error).slice(0, 400) });
    }
  }
  } finally {
    release();
  }
  return results;
}

module.exports = {
  ACCOUNTS,
  DAILY_CAP_PER_ACCOUNT,
  oauthHeader,
  captionFor,
  postsToday,
  alreadyPosted,
  heldVideoIds,
  readLedger,
  postApprovedVideoToX,
};
