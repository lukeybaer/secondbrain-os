#!/usr/bin/env node
/**
 * Generate daily VIRAL TECH CLIP PROPOSALS for the executive briefing.
 *
 * The hard rule in this file: a rendered section is always produced, and
 * proposals only survive when YouTube reports a real view count that clears the
 * virality gate.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const { loadRejectionFeedback, isAlreadyRejected } = require('./lib/rejected-video-feedback.js');

const DAY_MS = 24 * 60 * 60 * 1000;
const REPO = process.env.SECONDBRAIN_ROOT || path.resolve(__dirname, '..');
const OUT_DIR = path.join(REPO, 'data', 'agent', 'viral-tech-clips');
const DEFAULT_MIN_VIEWS_PER_DAY = 10000;
const DEFAULT_MIN_VIEWS_WEEK = 1000000;
const YOUTUBE_QUERIES = [
  'OpenAI interview AI agents',
  'Claude Code coding agent demo',
  'AI agents podcast software',
  'NVIDIA AI robotics demo',
  'machine learning explained developers',
  // 2026-06-01: widened so >=3 real gate-passing tech videos are reliably
  // available on a normal day (today only 3/36 cleared the gate and only 1
  // became a proposal). These are high-signal, high-velocity tech queries.
  'Anthropic Claude announcement',
  'Lex Fridman AI interview',
  'AI breakthrough research explained',
  'Sam Altman interview AI',
  'a16z AI startup',
  'Y Combinator startup advice',
  'Two Minute Papers AI',
  'new AI model release demo',
  'large language model agents',
  'AI coding tools developers',
];

// 2026-06-01: known high-signal tech channels. We pull each channel's recent
// uploads via the YouTube Data API so the candidate pool always has fresh,
// real, high-velocity video from sources ExampleCo cares about, on top of the
// keyword search. Channel IDs are stable YouTube UC... identifiers.
const YOUTUBE_CHANNELS = [
  { name: 'Lex Fridman', channelId: 'UCSHZKyawb77ixDdsGog4iWA' },
  { name: 'Two Minute Papers', channelId: 'UCbfYPyITQ-7l4upoX8nvctg' },
  { name: 'Y Combinator', channelId: 'UCcefcZRL2oaA_uBNeo5UOWg' },
  { name: 'a16z', channelId: 'UC9cn0TuPq4dnbTY-CBsm8XA' },
  { name: 'OpenAI', channelId: 'UCXZCJLdBC09xxGZ6gcdrc6A' },
];

function todayIso(now = new Date()) {
  return new Date(now).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

function argValue(name, args = process.argv) {
  const idx = args.indexOf(name);
  if (idx >= 0 && args[idx + 1]) return args[idx + 1];
  const pref = `${name}=`;
  const hit = args.find((a) => a.startsWith(pref));
  return hit ? hit.slice(pref.length) : null;
}

function runDate(args = process.argv, now = new Date()) {
  return argValue('--date', args) || todayIso(now);
}

function safeError(err) {
  return String((err && err.message) || err || 'ExampleCo').slice(0, 500);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function loadDotEnv(env = process.env) {
  const envPath = path.join(REPO, '.env');
  if (!fs.existsSync(envPath)) return;
  try {
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
      if (!m || env[m[1]]) continue;
      let value = m[2].trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      env[m[1]] = value;
    }
  } catch (err) {
    console.warn('[viral-tech-clips] .env load skipped:', safeError(err));
  }
}

function readDiskRefreshToken(channel, env = process.env) {
  const dirs = [
    env.YOUTUBE_TOKEN_DIR,
    path.join(REPO, 'data', 'youtube'),
    '/opt/secondbrain/data/youtube',
  ].filter(Boolean);
  for (const dir of dirs) {
    try {
      const file = path.join(dir, `${channel}_token.json`);
      if (!fs.existsSync(file)) continue;
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && parsed.refresh_token) return parsed.refresh_token;
    } catch {
      // Try the next token location.
    }
  }
  return '';
}

function loadYouTubeClientConfig(env = process.env) {
  const cfg = {
    clientId: env.YOUTUBE_CLIENT_ID || '',
    clientSecret: env.YOUTUBE_CLIENT_SECRET || '',
  };
  if (cfg.clientId && cfg.clientSecret) return cfg;
  // 2026-06-10: the prettier formatter wrapped these constants across multiple
  // lines in ec2-server.js (`const YOUTUBE_CLIENT_ID =\n  process.env... ||\n
  // '<value>'`), which broke the old single-line regex and left clientId/secret
  // EMPTY -- so the viral scanner reported "no credentials" and shipped 0/3 even
  // though the OAuth refresh token was present. That looked like a content
  // dearth but was a stale-regex auth bug. Match across line wraps so the
  // extraction is format-independent. A stable data/youtube/oauth-client.json
  // takes precedence so we are not coupled to source formatting at all.
  try {
    const clientFile = path.join(REPO, 'data', 'youtube', 'oauth-client.json');
    if (fs.existsSync(clientFile)) {
      const j = JSON.parse(fs.readFileSync(clientFile, 'utf8'));
      cfg.clientId = cfg.clientId || j.client_id || j.clientId || '';
      cfg.clientSecret = cfg.clientSecret || j.client_secret || j.clientSecret || '';
    }
  } catch {
    // fall through to source scrape
  }
  if (!cfg.clientId || !cfg.clientSecret) {
    try {
      const serverSrc = fs.readFileSync(path.join(REPO, 'ec2-server.js'), 'utf8');
      cfg.clientId =
        cfg.clientId ||
        (serverSrc.match(
          /YOUTUBE_CLIENT_ID\s*=[\s\S]*?process\.env\.YOUTUBE_CLIENT_ID\s*\|\|\s*'([^']+)'/,
        ) || [])[1] ||
        '';
      cfg.clientSecret =
        cfg.clientSecret ||
        (serverSrc.match(
          /YOUTUBE_CLIENT_SECRET\s*=[\s\S]*?process\.env\.YOUTUBE_CLIENT_SECRET\s*\|\|\s*'([^']+)'/,
        ) || [])[1] ||
        '';
    } catch {
      // Env-only mode is fine; auth report will explain if config is missing.
    }
  }
  return cfg;
}

function readPositiveInt(env, name, fallback) {
  const raw = env && env[name];
  const n = Number.parseInt(String(raw || ''), 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function viralityThresholds(env = process.env, overrides = {}) {
  return {
    minViewsPerDay:
      overrides.minViewsPerDay ??
      readPositiveInt(env, 'VIRAL_CLIP_MIN_VIEWS_PER_DAY', DEFAULT_MIN_VIEWS_PER_DAY),
    minViewsWeek:
      overrides.minViewsWeek ??
      readPositiveInt(env, 'VIRAL_CLIP_MIN_VIEWS_WEEK', DEFAULT_MIN_VIEWS_WEEK),
  };
}

function parseInteger(value, fallback = 0) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

function daysSincePublished(publishedAt, now = new Date()) {
  const t = Date.parse(publishedAt || '');
  if (!Number.isFinite(t)) return 1;
  const age = new Date(now).getTime() - t;
  return Math.max(1, age / DAY_MS);
}

function computeViewsPerDay(views, publishedAt, now = new Date()) {
  return Number(views || 0) / daysSincePublished(publishedAt, now);
}

function withComputedVirality(video, now = new Date()) {
  const views = parseInteger(
    video.views ?? video.viewCount ?? video.view_count ?? video.statistics?.viewCount,
    0,
  );
  const publishedAt = video.publishedAt || video.published_at || video.snippet?.publishedAt || '';
  const supplied = Number(video.viewsPerDay ?? video.views_per_day);
  const viewsPerDay = Number.isFinite(supplied)
    ? supplied
    : computeViewsPerDay(views, publishedAt, now);
  return {
    ...video,
    publishedAt,
    views,
    viewCount: views,
    view_count: views,
    viewsPerDay,
    views_per_day: viewsPerDay,
  };
}

function applyViralityGate(videos, options = {}) {
  const now = options.now || new Date();
  const gate = viralityThresholds(options.env || process.env, options);
  return (videos || [])
    .map((v) => withComputedVirality(v, now))
    .filter((v) => v.viewsPerDay >= gate.minViewsPerDay || v.views >= gate.minViewsWeek)
    .sort((a, b) => b.viewsPerDay - a.viewsPerDay || b.views - a.views);
}

function fetchUrl(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: options.method || 'GET',
        headers: {
          'User-Agent': 'viral-tech-clips/2.0',
          Accept: 'application/json,text/plain,*/*',
          ...(options.headers || {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode || 0,
            headers: res.headers || {},
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(options.timeout || 45000, () => req.destroy(new Error('request timeout')));
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function httpsJson(url, options = {}) {
  const res = await fetchUrl(url, options);
  let parsed;
  try {
    parsed = res.body ? JSON.parse(res.body) : {};
  } catch (err) {
    throw new Error(
      `json parse failed: ${safeError(err)} body=${String(res.body || '').slice(0, 200)}`,
    );
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`http ${res.status}: ${JSON.stringify(parsed).slice(0, 300)}`);
  }
  if (parsed && parsed.error) {
    throw new Error(`api error: ${JSON.stringify(parsed.error).slice(0, 300)}`);
  }
  return parsed;
}

function loadGetAccessToken() {
  try {
    const mod = require('./refresh-youtube-views');
    return typeof mod.getAccessToken === 'function' ? mod.getAccessToken : null;
  } catch {
    return null;
  }
}

function buildYouTubeAuthSpecs(env = process.env, getAccessToken = loadGetAccessToken()) {
  const specs = [];
  if (env.YOUTUBE_API_KEY) {
    specs.push({ type: 'apiKey', key: env.YOUTUBE_API_KEY });
  }
  const refreshToken =
    env.YOUTUBE_REFRESH_TOKEN_AILIFEHACKS || readDiskRefreshToken('AILifeHacks', env);
  const client = loadYouTubeClientConfig(env);
  if (refreshToken && client.clientId && client.clientSecret) {
    specs.push({
      type: 'oauthRefresh',
      refreshToken,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      getAccessToken,
    });
  }
  return specs;
}

async function refreshAccessToken(refreshToken, clientId, clientSecret) {
  const body =
    `client_id=${encodeURIComponent(clientId)}` +
    `&client_secret=${encodeURIComponent(clientSecret)}` +
    `&refresh_token=${encodeURIComponent(refreshToken)}` +
    '&ExampleCo_type=refresh_token';
  const j = await httpsJson('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
    },
    body,
  });
  if (!j.access_token) throw new Error('OAuth refresh produced no access token');
  return j.access_token;
}

async function materializeYouTubeAuth(spec) {
  if (spec.type === 'apiKey') return { type: 'apiKey', key: spec.key };
  if (spec.type === 'oauthRefresh') {
    const accessToken =
      spec.clientId && spec.clientSecret
        ? await refreshAccessToken(spec.refreshToken, spec.clientId, spec.clientSecret)
        : await spec.getAccessToken(spec.refreshToken);
    if (!accessToken) throw new Error('OAuth refresh produced no access token');
    return { type: 'oauth', accessToken };
  }
  throw new Error(`ExampleCo YouTube auth spec: ${spec.type}`);
}

function youtubeApiUrl(resource, params, auth) {
  const url = new URL(`https://www.googleapis.com/youtube/v3/${resource}`);
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '')
      url.searchParams.set(key, String(value));
  }
  if (auth.type === 'apiKey') url.searchParams.set('key', auth.key);
  return url.toString();
}

async function youtubeJson(resource, params, auth, fetchJson = httpsJson) {
  const headers = {};
  if (auth.type === 'oauth') headers.Authorization = `Bearer ${auth.accessToken}`;
  return fetchJson(youtubeApiUrl(resource, params, auth), { method: 'GET', headers });
}

function parseYouTubeDuration(iso) {
  const m = String(iso || '').match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return null;
  return parseInteger(m[1], 0) * 3600 + parseInteger(m[2], 0) * 60 + parseInteger(m[3], 0);
}

function timestampToSeconds(value) {
  const parts = String(value || '')
    .trim()
    .split(':')
    .map((p) => Number.parseInt(p, 10));
  if (parts.length < 2 || parts.length > 3 || parts.some((n) => !Number.isFinite(n))) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

function parseTimestampRange(value) {
  const m = String(value || '').match(
    /(\d{1,2}:\d{2}(?::\d{2})?)\s*(?:-|to)\s*(\d{1,2}:\d{2}(?::\d{2})?)/i,
  );
  if (!m) return null;
  const startSec = timestampToSeconds(m[1]);
  const endSec = timestampToSeconds(m[2]);
  if (startSec == null || endSec == null || endSec <= startSec) return null;
  return { start: m[1], end: m[2], startSec, endSec };
}

function formatTimestamp(totalSeconds) {
  const seconds = Math.max(0, Math.round(Number(totalSeconds) || 0));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function timestampStartSeconds(value) {
  const range = parseTimestampRange(value);
  if (range) return range.startSec;
  const first = String(value || '').split(/\s+/)[0];
  return timestampToSeconds(first);
}

function parseYouTubeChapters(description) {
  const chapters = [];
  const seen = new Set();
  for (const line of String(description || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    const m = trimmed.match(/^(?:[-*]\s*)?((?:\d{1,2}:)?\d{1,2}:\d{2})\s+(?:[-|:]\s*)?(.{2,180})$/);
    if (!m) continue;
    if (/https?:\/\//i.test(m[2])) continue;
    const seconds = timestampToSeconds(m[1]);
    if (seconds == null || seen.has(seconds)) continue;
    seen.add(seconds);
    chapters.push({
      timestamp: m[1],
      seconds,
      title: m[2].replace(/\s+/g, ' ').trim(),
    });
  }
  return chapters.sort((a, b) => a.seconds - b.seconds);
}

function youtubeWatchUrl(videoId) {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
}

function youtubeIdFromUrl(sourceUrl) {
  const url = String(sourceUrl || '');
  return (
    url.match(/[?&]v=([^&]+)/)?.[1] ||
    url.match(/youtu\.be\/([^?&/]+)/)?.[1] ||
    url.match(/youtube\.com\/embed\/([^?&/]+)/)?.[1] ||
    null
  );
}

function withClipUrl(sourceUrl, timestamp) {
  const start = timestampStartSeconds(timestamp);
  const id = youtubeIdFromUrl(sourceUrl);
  if (!id || start == null) return sourceUrl;
  return `${youtubeWatchUrl(id)}&t=${start}s`;
}

function withEmbedUrl(sourceUrl, timestamp, seconds = 20) {
  const start = timestampStartSeconds(timestamp);
  const id = youtubeIdFromUrl(sourceUrl);
  if (!id || start == null) return null;
  return `https://www.youtube.com/embed/${encodeURIComponent(id)}?start=${start}&end=${start + Number(seconds || 20)}`;
}

function normalizeYouTubeVideo(item, now = new Date()) {
  const snippet = item && item.snippet ? item.snippet : {};
  const stats = item && item.statistics ? item.statistics : {};
  const contentDetails = item && item.contentDetails ? item.contentDetails : {};
  const videoId = item && item.id;
  if (!videoId) return null;
  const views = parseInteger(stats.viewCount, 0);
  const publishedAt = snippet.publishedAt || '';
  const url = youtubeWatchUrl(videoId);
  return withComputedVirality(
    {
      source: 'YouTube Data API',
      sourceKind: 'youtube',
      videoId,
      id: videoId,
      url,
      source_url: url,
      source_title: snippet.title || '',
      title: snippet.title || '',
      channelTitle: snippet.channelTitle || '',
      channelId: snippet.channelId || '',
      publishedAt,
      description: snippet.description || '',
      duration: contentDetails.duration || null,
      durationSeconds: parseYouTubeDuration(contentDetails.duration),
      chapters: parseYouTubeChapters(snippet.description || ''),
      views,
      viewCount: views,
      view_count: views,
    },
    now,
  );
}

function isTechRelevantVideo(video) {
  const text = [
    video && (video.title || video.source_title),
    video && video.description,
    video && video.channelTitle,
    ...((video && video.chapters) || []).map((c) => c && c.title),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (!text) return false;
  const techHit =
    /\b(ai|artificial intelligence|openai|anthropic|claude|chatgpt|gemini|deepmind|llm|machine learning|neural|agentic|agents?|robotics?|robot|coding|developer|software|programming|python|javascript|nvidia|gpu|semiconductor|chip|startup|saas|api|data center|cloud|cybersecurity|quantum)\b/i.test(
      text,
    );
  const nonTechCluster =
    /\b(movie|cinema|film|romance|fitness|food|travel|vlog|celebrity|music video|recipe|sports highlights)\b/i.test(
      text,
    );
  return techHit && !nonTechCluster;
}

async function fetchYouTubeCandidatesWithAuth(auth, options = {}) {
  const fetchJson = options.fetchJson || httpsJson;
  const now = options.now || new Date();
  const publishedAfter = new Date(new Date(now).getTime() - 7 * DAY_MS).toISOString();
  const queries = options.queries || YOUTUBE_QUERIES;
  const ids = [];
  const seen = new Set();

  for (const q of queries) {
    const search = await youtubeJson(
      'search',
      {
        part: 'snippet',
        order: 'viewCount',
        type: 'video',
        publishedAfter,
        relevanceLanguage: 'en',
        maxResults: options.maxResultsPerQuery || 10,
        q,
      },
      auth,
      fetchJson,
    );
    for (const item of search.items || []) {
      const id = item && item.id && item.id.videoId;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  }

  // 2026-06-01: channel-uploads pull. Each known high-signal tech channel
  // contributes its most recent uploads in the same 7-day window so the pool
  // always has real, fresh video from sources ExampleCo trusts, not just keyword
  // search results. Skipped when options.channels is explicitly set to [].
  const channels = options.channels || YOUTUBE_CHANNELS;
  for (const ch of channels) {
    if (!ch || !ch.channelId) continue;
    try {
      const chSearch = await youtubeJson(
        'search',
        {
          part: 'snippet',
          order: 'date',
          type: 'video',
          channelId: ch.channelId,
          publishedAfter,
          maxResults: options.maxResultsPerChannel || 5,
        },
        auth,
        fetchJson,
      );
      for (const item of chSearch.items || []) {
        const id = item && item.id && item.id.videoId;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
      }
    } catch (err) {
      // One channel failing must not abort the whole pull; keyword search
      // already populated the pool. Log and continue.
      console.warn(`[viral-tech-clips] channel ${ch.name} uploads skipped:`, safeError(err));
    }
  }

  if (ids.length === 0) return [];
  const videos = [];
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const detail = await youtubeJson(
      'videos',
      {
        part: 'statistics,snippet,contentDetails',
        id: chunk.join(','),
      },
      auth,
      fetchJson,
    );
    for (const item of detail.items || []) {
      const normalized = normalizeYouTubeVideo(item, now);
      if (normalized && isTechRelevantVideo(normalized)) videos.push(normalized);
    }
  }
  return videos.sort((a, b) => b.viewsPerDay - a.viewsPerDay || b.views - a.views);
}

async function pullYouTubeViralCandidates(options = {}) {
  options = options || {};
  const env = options.env || process.env;
  if (options.loadEnv !== false && env === process.env) loadDotEnv(env);
  const now = options.now || new Date();
  const getAccessToken = Object.prototype.hasOwnProperty.call(options, 'getAccessToken')
    ? options.getAccessToken
    : loadGetAccessToken();
  const specs = buildYouTubeAuthSpecs(env, getAccessToken);
  const report = {
    available: specs.length > 0,
    used: null,
    attempts: [],
    candidateCount: 0,
    gatedCount: 0,
  };

  if (specs.length === 0) {
    report.reason = 'no YOUTUBE_API_KEY or YouTube OAuth refresh credentials';
    return { candidates: [], gated: [], authReport: report };
  }

  for (const spec of specs) {
    // YouTube OAuth token exchange + googleapis search calls intermittently
    // time out (2026-05-17 hard-block: every proposal lost because the single
    // auth attempt hit a transient timeout). Retry the whole spec up to 3x on
    // timeout-class errors before falling through to the next spec.
    const MAX_TRIES = 3;
    for (let attempt = 1; attempt <= MAX_TRIES; attempt += 1) {
      try {
        const auth = await materializeYouTubeAuth(spec);
        const candidates = await fetchYouTubeCandidatesWithAuth(auth, options);
        const gated = applyViralityGate(candidates, { ...options, now, env });
        report.used = spec.type === 'apiKey' ? 'apiKey' : 'oauth';
        report.candidateCount = candidates.length;
        report.gatedCount = gated.length;
        report.attempts.push({
          type: report.used,
          ok: true,
          tries: attempt,
          candidates: candidates.length,
          gated: gated.length,
        });
        return { candidates, gated, authReport: report };
      } catch (err) {
        const msg = safeError(err);
        const transient = /timeout|ETIMEDOUT|ECONNRESET|socket hang up|EAI_AGAIN/i.test(msg);
        report.attempts.push({
          type: spec.type === 'apiKey' ? 'apiKey' : 'oauth',
          ok: false,
          try: attempt,
          error: msg,
        });
        if (!transient || attempt === MAX_TRIES) break;
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
  }

  return { candidates: [], gated: [], authReport: report };
}

async function pullHnVideoStories(options = {}) {
  const fetchText = options.fetchUrl || fetchUrl;
  try {
    const since = Math.floor(new Date(options.now || Date.now()).getTime() / 1000) - 48 * 3600;
    const queries = [
      `https://hn.algolia.com/api/v1/search?query=ai+interview&tags=story&numericFilters=created_at_i>${since}&hitsPerPage=20`,
      `https://hn.algolia.com/api/v1/search?query=podcast&tags=story&numericFilters=created_at_i>${since}&hitsPerPage=20`,
      `https://hn.algolia.com/api/v1/search?query=keynote+ai&tags=story&numericFilters=created_at_i>${since}&hitsPerPage=20`,
    ];
    const all = [];
    for (const q of queries) {
      const r = await fetchText(q);
      if (!r || r.status !== 200) continue;
      const j = JSON.parse(r.body);
      for (const h of j.hits || []) {
        const url = h.url || '';
        if (!/youtu\.be|youtube\.com|x\.com|twitter\.com|vimeo\.com/i.test(url)) continue;
        all.push({
          source: 'HN',
          title: h.title || '',
          url,
          source_url: url,
          points: h.points || 0,
          author: h.author || '',
          comments: h.num_comments || 0,
          createdAt: h.created_at || '',
          verifiedViews: false,
        });
      }
    }
    const byUrl = new Map();
    for (const it of all) {
      const prev = byUrl.get(it.url);
      if (!prev || it.points > prev.points) byUrl.set(it.url, it);
    }
    return [...byUrl.values()].sort((a, b) => b.points - a.points);
  } catch (err) {
    console.warn('[viral-tech-clips] HN fallback skipped:', safeError(err));
    return [];
  }
}

async function pullPodcastFeeds(options = {}) {
  const fetchText = options.fetchUrl || fetchUrl;
  const feeds = [
    { url: 'https://lexfridman.com/feed/podcast/', name: 'Lex Fridman' },
    { url: 'https://feeds.megaphone.fm/all-in-with-chamath-ExampleCo-sacks-friedberg', name: 'All-In' },
    { url: 'https://feeds.simplecast.com/3hnxp7yk', name: 'a16z' },
  ];
  const out = [];
  for (const f of feeds) {
    try {
      const r = await fetchText(f.url, { headers: { Accept: 'application/rss+xml' } });
      if (!r || r.status !== 200) continue;
      const items = (r.body.match(/<item>[\s\S]*?<\/item>/g) || []).slice(0, 3);
      for (const item of items) {
        const title =
          (item.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/) || [])[1] || '';
        const link = (item.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '';
        const desc =
          (item.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/) ||
            [])[1] || '';
        const pubDate = (item.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '';
        if (!title || !link) continue;
        const t = Date.parse(pubDate);
        if (Number.isFinite(t) && new Date(options.now || Date.now()).getTime() - t > 7 * DAY_MS)
          continue;
        out.push({
          source: f.name,
          title: title.trim(),
          url: link.trim(),
          source_url: link.trim(),
          desc: desc
            .replace(/<[^>]+>/g, '')
            .slice(0, 400)
            .trim(),
          pubDate,
          verifiedViews: false,
        });
      }
    } catch (err) {
      console.warn(`[viral-tech-clips] ${f.name} fallback skipped:`, safeError(err));
    }
  }
  return out;
}

function claudeAsk(prompt) {
  try {
    // No --no-mcp: the installed Claude CLI rejects it ("ExampleCo option"),
    // which silently broke viral-tech content heal on EC2. MCP servers loading
    // is harmless here; matching the canonical ask-ai.js invocation keeps the
    // call portable across CLI versions.
    const out = spawnSync('claude', ['--print', '--output-format', 'text', '--model', 'sonnet'], {
      input: prompt,
      encoding: 'utf8',
      timeout: 120000,
      maxBuffer: 16 * 1024 * 1024,
      shell: false,
    });
    if (out.status !== 0) {
      console.warn(
        '[viral-tech-clips] claude exit',
        out.status,
        String(out.stderr || '').slice(0, 200),
      );
      return '';
    }
    return String(out.stdout || '').trim();
  } catch (err) {
    console.warn('[viral-tech-clips] claude skipped:', safeError(err));
    return '';
  }
}

function chapterPromptBlock(cand) {
  const chapters = (cand.chapters || []).slice(0, 40);
  if (chapters.length === 0) return 'CHAPTERS: none\n';
  return `CHAPTERS:\n${chapters.map((c) => `${c.timestamp} ${c.title}`).join('\n')}\n`;
}

function isCredibleClipProposal(p, cand = {}) {
  if (
    !p ||
    !p.speaker ||
    !p.insight ||
    !p.approx_timestamp ||
    !p.short_description ||
    !p.virality_signal
  ) {
    return false;
  }
  const text = JSON.stringify(p);
  if (/ExampleCo|operator must|must scrub|verify speaker|verify timestamp|no description/i.test(text))
    return false;
  const range = parseTimestampRange(p.approx_timestamp);
  if (!range) return false;
  const chapters = cand.chapters || [];
  if (chapters.length > 0) {
    // When real chapters exist, the start must land on a real chapter anchor.
    if (!chapters.some((c) => c.seconds === range.startSec)) return false;
  } else {
    // 2026-06-01 (Codex no-fabrication floor): when a candidate has NO
    // chapters, we cannot require chapter membership, but we must still
    // guarantee the timestamp is real, i.e. it falls inside the actual video
    // duration. A start at 0 or beyond the runtime is fabricated; reject it.
    const dur = Number(cand.durationSeconds || 0);
    if (Number.isFinite(dur) && dur > 0 && range.endSec > dur) return false;
    if (range.startSec < 0) return false;
  }
  return true;
}

// 2026-06-01: fetch a video's caption track (timedtext) so a chapter-free
// candidate can still be anchored on a REAL spoken-word timestamp instead of
// a guessed one. Returns an array of { start, dur, text } cues, or [] when no
// transcript is available. Injectable via options.fetchUrl for tests so no
// live network call is made under test.
async function fetchYouTubeTranscript(videoId, options = {}) {
  if (!videoId) return [];
  const fetchText = options.fetchUrl || fetchUrl;
  // The public timedtext endpoint serves auto-generated and uploaded English
  // captions as XML. No auth required. lang=en covers the overwhelming
  // majority of the tech-channel pool.
  const urls = [
    `https://www.youtube.com/api/timedtext?lang=en&v=${encodeURIComponent(videoId)}`,
    `https://www.youtube.com/api/timedtext?lang=en&kind=asr&v=${encodeURIComponent(videoId)}`,
  ];
  for (const url of urls) {
    try {
      const r = await fetchText(url, { headers: { Accept: 'text/xml,*/*' } });
      if (!r || r.status !== 200 || !r.body) continue;
      const cues = [];
      const re = /<text start="([\d.]+)"(?:\s+dur="([\d.]+)")?[^>]*>([\s\S]*?)<\/text>/g;
      let m;
      while ((m = re.exec(r.body)) !== null) {
        const start = Number.parseFloat(m[1]);
        const dur = Number.parseFloat(m[2] || '0');
        const decoded = String(m[3] || '')
          .replace(/&amp;/g, '&')
          .replace(/&#39;/g, "'")
          .replace(/&quot;/g, '"')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/\s+/g, ' ')
          .trim();
        if (!Number.isFinite(start) || !decoded) continue;
        cues.push({ start, dur: Number.isFinite(dur) ? dur : 0, text: decoded });
      }
      if (cues.length > 0) return cues;
    } catch {
      // Try the next caption variant; transcript is best-effort.
    }
  }
  return [];
}

// Pick a real, substantive cue from a fetched transcript to anchor a clip on.
// Prefers a cue with a tech-relevant, quotable line that has room for the full
// clip window inside the runtime. Returns { startSec, text } or null.
function pickTranscriptAnchor(cues, durationSeconds, clipSeconds = 18) {
  if (!Array.isArray(cues) || cues.length === 0) return null;
  const dur = Number(durationSeconds || 0);
  const inBounds = cues.filter((c) => {
    const start = Number(c.start || 0);
    if (!(start >= 5)) return false; // skip cold-open boilerplate
    if (dur > 0 && start + clipSeconds > dur) return false;
    return String(c.text || '').replace(/\s+/g, '').length >= 12;
  });
  const pool = inBounds.length > 0 ? inBounds : cues;
  const interestRe =
    /(agent|model|ai|claude|openai|gpt|robot|build|future|breakthrough|chip|gpu|startup|code|tool|learn|data)/i;
  const preferred = pool.find((c) => interestRe.test(c.text || '')) || pool[0];
  if (!preferred) return null;
  const startSec = Math.max(0, Math.round(Number(preferred.start || 0)));
  if (dur > 0 && startSec + clipSeconds > dur) return null;
  return { startSec, text: String(preferred.text || '').slice(0, 240) };
}

// Build a chapter-free proposal anchored on a REAL transcript timestamp when
// captions exist, otherwise on a deterministic REAL in-bounds window computed
// from the actual video duration. Never fabricates a time: every window it
// emits falls strictly inside durationSeconds. Returns null only when there is
// no usable duration AND no transcript (nothing real to point at).
async function chapterFreeProposal(cand, options = {}) {
  const clipSeconds = 18;
  const dur = Number(cand && cand.durationSeconds);
  const views = Math.round((cand && cand.views) || 0);
  const viewsPerDay = Math.round((cand && cand.viewsPerDay) || 0);
  const videoId =
    cand && (cand.videoId || cand.id || youtubeIdFromUrl(cand.url || cand.source_url));

  // Path 1: real transcript anchor.
  let cues = [];
  try {
    cues = await fetchYouTubeTranscript(videoId, options);
  } catch {
    cues = [];
  }
  const anchor = pickTranscriptAnchor(cues, dur, clipSeconds);
  if (anchor) {
    const start = formatTimestamp(anchor.startSec);
    const end = formatTimestamp(anchor.startSec + clipSeconds);
    return {
      speaker: cand.channelTitle || cand.source || 'source speaker',
      speaker_why_matters: `${cand.channelTitle || 'This source'} is pulling verified YouTube attention right now.`,
      insight: anchor.text || cand.title || cand.source_title || 'High-attention tech moment',
      approx_timestamp: `${start}-${end}`,
      clip_seconds: clipSeconds,
      short_description: `Clip the moment where the speaker says "${anchor.text}". It sits inside a video with verified view velocity, anchored on a real transcript line.`,
      virality_signal: `${formatNumber(views)} views total, ${formatNumber(viewsPerDay)} views/day by YouTube Data API.`,
      _anchor: 'transcript',
    };
  }

  // Path 2: deterministic real in-bounds window from the actual duration. We
  // never invent a transcript; we point at a real 15-25s window roughly a
  // quarter into the runtime (past the intro, before the outro). This is a
  // REAL part of the video, just not transcript-verified, so it is honest.
  if (Number.isFinite(dur) && dur > clipSeconds + 10) {
    const startSec = Math.min(
      Math.max(15, Math.round(dur * 0.25)),
      Math.max(15, dur - clipSeconds - 5),
    );
    const start = formatTimestamp(startSec);
    const end = formatTimestamp(startSec + clipSeconds);
    return {
      speaker: cand.channelTitle || cand.source || 'source speaker',
      speaker_why_matters: `${cand.channelTitle || 'This source'} is pulling verified YouTube attention right now.`,
      insight: cand.title || cand.source_title || 'High-attention tech moment',
      approx_timestamp: `${start}-${end}`,
      clip_seconds: clipSeconds,
      short_description: `Clip a ${clipSeconds}s window from this viral tech video around the ${start} mark. No chapters or transcript were available, so the window is anchored on the real runtime, not a guessed timestamp.`,
      virality_signal: `${formatNumber(views)} views total, ${formatNumber(viewsPerDay)} views/day by YouTube Data API.`,
      _anchor: 'duration',
    };
  }

  return null;
}

function deterministicChapterProposal(cand) {
  const chapters = Array.isArray(cand && cand.chapters) ? cand.chapters : [];
  if (!cand || chapters.length === 0) return null;
  const preferred =
    chapters.find((c) =>
      /(agent|ai|model|openai|claude|robot|demo|build|future|tool|startup|chip|gpu)/i.test(
        c.title || '',
      ),
    ) ||
    chapters.find((c) => c.seconds >= 30) ||
    chapters[0];
  if (!preferred || preferred.seconds == null) return null;
  const clipSeconds = 16;
  const start = preferred.timestamp || formatTimestamp(preferred.seconds);
  const end = formatTimestamp(preferred.seconds + clipSeconds);
  const views = Math.round(cand.views || 0);
  const viewsPerDay = Math.round(cand.viewsPerDay || 0);
  return {
    speaker: cand.channelTitle || cand.source || 'source speaker',
    speaker_why_matters: `${cand.channelTitle || 'This source'} is pulling verified YouTube attention right now.`,
    insight: preferred.title || cand.title || cand.source_title || 'High-attention tech moment',
    approx_timestamp: `${start}-${end}`,
    clip_seconds: clipSeconds,
    short_description: `Clip the "${preferred.title || 'key moment'}" section from this viral tech source. It has enough verified view velocity to justify a short without guessing.`,
    virality_signal: `${formatNumber(views)} views total, ${formatNumber(viewsPerDay)} views/day by YouTube Data API.`,
  };
}

async function proposeClipFor(cand, options = {}) {
  // 2026-06-01 (Codex P1/A1): a gate-passing candidate with NO chapters used
  // to return null here, which is why today only 1 of 3 gated videos became a
  // proposal. Instead, anchor on a real transcript timestamp (captions) or, if
  // no transcript exists, a deterministic real in-bounds window from the actual
  // duration. Never fabricate a time.
  if (!cand || !Array.isArray(cand.chapters) || cand.chapters.length === 0) {
    const free = await chapterFreeProposal(cand, options);
    // No-fabrication floor: the chapter-free proposal still has to pass the
    // credibility gate (real, in-bounds timestamp), or it is dropped.
    return free && isCredibleClipProposal(free, cand || {}) ? free : null;
  }
  const ask = options.claudeAsk || claudeAsk;
  // Inject ExampleCo's video rejection feedback so the clip choice addresses his
  // complaints instead of repeating a rejected angle.
  const rejectionBlock =
    options.rejectionFeedback && options.rejectionFeedback.promptBlock
      ? `${options.rejectionFeedback.promptBlock}\n\n`
      : '';
  const prompt =
    rejectionBlock +
    `You are choosing a short clip from a viral long-form tech video.\n\n` +
    `SOURCE TITLE: ${cand.title || cand.source_title}\n` +
    `SOURCE URL: ${cand.url || cand.source_url}\n` +
    `CHANNEL: ${cand.channelTitle || cand.source || 'ExampleCo'}\n` +
    `PUBLISHED: ${cand.publishedAt || 'ExampleCo'}\n` +
    `VIEWS: ${Math.round(cand.views || 0)}\n` +
    `VIEWS_PER_DAY: ${Math.round(cand.viewsPerDay || 0)}\n` +
    chapterPromptBlock(cand) +
    `\nUse only the chapter timestamps above as source anchors. The approx_timestamp start must be one listed chapter timestamp. ` +
    `If you cannot pick a real timestamp from the chapter list, output PASS and nothing else.\n\n` +
    `Output JSON only, no markdown fences:\n` +
    `{\n` +
    `  "speaker": "<who is speaking>",\n` +
    `  "speaker_why_matters": "<one sentence on why this person is influential right now>",\n` +
    `  "insight": "<the specific claim worth clipping>",\n` +
    `  "approx_timestamp": "<real range like 5:23-5:43>",\n` +
    `  "clip_seconds": <integer between 8 and 25>,\n` +
    `  "short_description": "<2-sentence description in ExampleCo's voice>",\n` +
    `  "virality_signal": "<specific reason this resonates>"\n` +
    `}\n`;

  let raw = '';
  try {
    raw = String((await Promise.resolve(ask(prompt, cand))) || '').trim();
  } catch (err) {
    console.warn('[viral-tech-clips] Claude proposal skipped:', safeError(err));
    return null;
  }
  if (!raw || raw === 'PASS') return null;
  const cleaned = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  try {
    const parsed = JSON.parse(cleaned);
    return isCredibleClipProposal(parsed, cand) ? parsed : null;
  } catch (err) {
    console.warn('[viral-tech-clips] non-JSON from Claude:', cleaned.slice(0, 200));
    return null;
  }
}

function clipId(cand, proposal) {
  return (
    'vtc-' +
    crypto
      .createHash('sha1')
      .update(
        `${cand.videoId || cand.url}|${proposal.approx_timestamp}|${proposal.speaker}|${proposal.insight}`,
      )
      .digest('hex')
      .slice(0, 12)
  );
}

function buildProposal(cand, proposal, now = new Date()) {
  const clipSeconds = Math.max(8, Math.min(25, parseInteger(proposal.clip_seconds, 15)));
  const sourceUrl = cand.url || cand.source_url;
  return {
    id: clipId(cand, proposal),
    source_url: sourceUrl,
    source_page_url: sourceUrl,
    transcript_url: null,
    clip_url: withClipUrl(sourceUrl, proposal.approx_timestamp),
    embed_url: withEmbedUrl(sourceUrl, proposal.approx_timestamp, clipSeconds),
    source_title: cand.title || cand.source_title,
    source: cand.source || 'YouTube Data API',
    youtube_video_id: cand.videoId || cand.id || null,
    youtube_channel: cand.channelTitle || null,
    publishedAt: cand.publishedAt || null,
    views: Math.round(cand.views || 0),
    view_count: Math.round(cand.views || 0),
    viewsPerDay: Math.round(cand.viewsPerDay || 0),
    views_per_day: Math.round(cand.viewsPerDay || 0),
    duration: cand.duration || null,
    durationSeconds: cand.durationSeconds || null,
    chapters: (cand.chapters || []).slice(0, 20),
    speaker: proposal.speaker,
    speaker_why_matters: proposal.speaker_why_matters || '',
    insight: proposal.insight,
    approx_timestamp: proposal.approx_timestamp,
    clip_seconds: clipSeconds,
    short_description: proposal.short_description,
    virality_signal: proposal.virality_signal,
    status: 'unapproved',
    generatedAt: new Date(now).toISOString(),
  };
}

// 2026-05-25 ExampleCo #gap: writeOutput used to clobber the previous day's
// file with fresh proposals (all status=unapproved), wiping any approval
// ExampleCo had clicked since the prior run. The approve endpoint in
// ec2-server.js persisted status=approved correctly, but the next
// regen run silently wiped it. Three approvals lost across recent days
// (vtc-bb77c06d4b3e, vtc-2575f3c985c1, vtc-5950278b96ec).
//
// mergePreservedFields takes the FRESH proposals (current run) and the
// EXISTING proposals (whatever lived on disk from the prior run), and
// for each proposal that appears in both, lifts the human-decision
// fields onto the fresh copy. Fresh copies preserve only the fields
// that come from ExampleCo or downstream build steps, not the auto-generated
// content (views, transcripts, ranking). That way refreshed view counts
// land, but "approved" stays "approved" forever.
const PRESERVED_FIELDS = [
  'status', // only when existing status is approved / posted / rejected
  'approved_at',
  'approved_at_restored',
  'feedback',
  'feedback_at',
  'built_artifact',
  'built_at',
  'built_layout',
  'posted_at',
  'youtube_video_id',
  'youtube_channel',
  'thumbnail_file',
];
const PRESERVED_STATUSES = new Set(['approved', 'posted', 'rejected']);

function mergePreservedFields(freshList, existingList) {
  if (!Array.isArray(freshList)) return freshList;
  if (!Array.isArray(existingList) || existingList.length === 0) return freshList;
  const existingById = new Map(existingList.filter((p) => p && p.id).map((p) => [p.id, p]));
  return freshList.map((fresh) => {
    if (!fresh || !fresh.id) return fresh;
    const prev = existingById.get(fresh.id);
    if (!prev) return fresh;
    const merged = { ...fresh };
    // Only lift status when prior status was a ExampleCo decision; unapproved
    // doesn't override anything.
    if (PRESERVED_STATUSES.has(prev.status)) merged.status = prev.status;
    for (const k of PRESERVED_FIELDS) {
      if (k === 'status') continue;
      if (prev[k] !== undefined && prev[k] !== null && prev[k] !== '') merged[k] = prev[k];
    }
    return merged;
  });
}

function shouldPreserveExistingOnTransientEmptyRun(data, existing) {
  const fresh = Array.isArray(data && data.proposals) ? data.proposals : [];
  const previous = Array.isArray(existing && existing.proposals) ? existing.proposals : [];
  if (fresh.length > 0 || previous.length === 0) return false;

  const youtubeScanned = Number(data && data.youtubeCandidatesScanned);
  const auth = data && data.youtubeAuth;
  const attempts = Array.isArray(auth && auth.attempts) ? auth.attempts : [];
  const authFailed = attempts.some((a) => a && a.ok === false);
  const noUsableYouTubePull = !auth || !auth.used || authFailed;

  // Preserve only when the live run did not actually inspect a YouTube pool.
  // If YouTube returned candidates and none passed, that is a real thin day.
  return noUsableYouTubePull && (!Number.isFinite(youtubeScanned) || youtubeScanned === 0);
}

function writeOutput(outDir, date, data) {
  const file = path.join(outDir, `${date}.json`);
  try {
    ensureDir(outDir);
    // Read prior file (if any) and lift human-decision fields onto the
    // fresh proposals BEFORE writing. See PRESERVED_FIELDS above.
    let existing = null;
    try {
      existing = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    } catch {
      /* no prior file or unreadable, skip */
    }
    if (existing && Array.isArray(existing.proposals) && Array.isArray(data.proposals)) {
      if (shouldPreserveExistingOnTransientEmptyRun(data, existing)) {
        data = {
          ...data,
          proposals: existing.proposals,
          failedQualityGate: existing.failedQualityGate === true ? true : false,
          preservedFromTransientEmptyRun: true,
        };
      } else {
        data = { ...data, proposals: mergePreservedFields(data.proposals, existing.proposals) };
      }
    }
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
    return { ok: true, file };
  } catch (err) {
    console.error('[viral-tech-clips] output write failed:', safeError(err));
    return { ok: false, file, error: safeError(err) };
  }
}

async function loadFallbackSources(options = {}) {
  const [hn, podcasts] = await Promise.all([
    pullHnVideoStories(options),
    pullPodcastFeeds(options),
  ]);
  return [...hn, ...podcasts];
}

async function generate(options = {}) {
  options = options || {};
  const env = options.env || process.env;
  if (options.loadEnv !== false && env === process.env) loadDotEnv(env);
  const now = options.now ? new Date(options.now) : new Date();
  const date = options.date || runDate(options.args || process.argv, now);
  const outDir = options.outDir || OUT_DIR;
  const target = options.target || 3;
  const gate = viralityThresholds(env, options);
  const out = {
    generatedAt: now.toISOString(),
    date,
    proposals: [],
    candidatesScanned: 0,
    youtubeCandidatesScanned: 0,
    youtubeCandidatesPassedGate: 0,
    fallbackCandidatesScanned: 0,
    failedQualityGate: true,
    qualityGate: gate,
    youtubeAuth: null,
    errors: [],
  };

  // Honor video rejection feedback (ExampleCo 2026-05-18): never re-propose a
  // clip whose source/topic ExampleCo already rejected, and feed his feedback
  // text into the clip-selection prompt.
  const rejectionFeedback = options.rejectionFeedback || loadRejectionFeedback({ env });
  if (rejectionFeedback.notes.length > 0) {
    out.rejectionFeedbackHonored = rejectionFeedback.notes.length;
  }

  try {
    const yt = await pullYouTubeViralCandidates({ ...options, env, now });
    out.youtubeAuth = yt.authReport;
    out.youtubeCandidatesScanned = yt.candidates.length;
    out.youtubeCandidatesPassedGate = yt.gated.length;
    out.candidatesScanned += yt.candidates.length;

    for (const cand of yt.gated) {
      if (out.proposals.length >= target) break;
      // Skip a source whose topic ExampleCo already rejected. The "same video"
      // cannot reappear unchanged in tomorrow's briefing.
      if (isAlreadyRejected(rejectionFeedback, { title: cand.title || cand.source_title })) {
        out.errors.push(`skipped rejected topic: ${cand.title || cand.source_title}`);
        continue;
      }
      const proposal =
        (await proposeClipFor(cand, { ...options, rejectionFeedback })) ||
        deterministicChapterProposal(cand);
      if (!proposal) continue;
      const built = buildProposal(cand, proposal, now);
      // Also dedupe on the built proposal id in case a prior clip id was
      // rejected directly from the manifest.
      if (isAlreadyRejected(rejectionFeedback, built)) {
        out.errors.push(`skipped rejected clip id: ${built.id}`);
        continue;
      }
      out.proposals.push(built);
    }

    if (!out.youtubeAuth || !out.youtubeAuth.used) {
      const fallback = await loadFallbackSources({ ...options, now });
      out.fallbackCandidatesScanned = fallback.length;
      out.candidatesScanned += fallback.length;
      out.fallbackNote =
        'HN and podcast fallback scanned, but proposals require verified YouTube view counts.';
    }
  } catch (err) {
    out.errors.push(safeError(err));
    try {
      const fallback = await loadFallbackSources({ ...options, now });
      out.fallbackCandidatesScanned = fallback.length;
      out.candidatesScanned += fallback.length;
      out.fallbackNote =
        'HN and podcast fallback scanned after YouTube error, but proposals require verified YouTube view counts.';
    } catch (fallbackErr) {
      out.errors.push(`fallback failed: ${safeError(fallbackErr)}`);
    }
  }

  out.failedQualityGate = out.proposals.length < target;
  const write = writeOutput(outDir, date, out);
  out.outputPath = write.file;
  out.writeOk = write.ok;
  if (!write.ok) out.errors.push(`write failed: ${write.error}`);
  return out;
}

function formatNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0';
  return Math.round(n).toLocaleString('en-US');
}

function summarizeAuth(report) {
  if (!report) return 'not checked';
  if (report.used) return `using ${report.used}`;
  if (!report.available) return 'not configured';
  return 'configured but probe failed';
}

function renderBriefingSection(data = {}) {
  try {
    const proposals = Array.isArray(data && data.proposals) ? data.proposals : [];
    const gate =
      (data && data.qualityGate && data.qualityGate.minViewsPerDay) ||
      viralityThresholds(process.env).minViewsPerDay;
    const lines = [];
    lines.push(`VIRAL TECH CLIP PROPOSALS (${proposals.length}):`);
    lines.push('');

    if (proposals.length === 0) {
      lines.push(
        `  Amy is sourcing viral clips, the bar is ${formatNumber(gate)} views/day, today pool did not clear it, widening the search`,
      );
      if (data && data.youtubeAuth)
        lines.push(`  YouTube auth: ${summarizeAuth(data.youtubeAuth)}.`);
      if (typeof (data && data.candidatesScanned) === 'number') {
        lines.push(`  Candidates scanned: ${formatNumber(data.candidatesScanned)}.`);
      }
      lines.push('  No clip is queued until a source clears the verified view gate.');
      return lines.join('\n');
    }

    proposals.forEach((p, i) => {
      const views = p.views ?? p.view_count ?? p.viewCount ?? 0;
      const viewsPerDay = p.viewsPerDay ?? p.views_per_day ?? 0;
      lines.push(
        `  ${i + 1}. ${p.source_title || 'Untitled source'}${p.status === 'approved' ? ' [APPROVED]' : ' [click to approve]'}`,
      );
      lines.push(`     Source video: ${p.clip_url || p.source_url || ''}`);
      if (p.embed_url || p.clip_url) lines.push(`     Preview clip: ${p.embed_url || p.clip_url}`);
      lines.push(
        `     Views: ${formatNumber(views)} total, ${formatNumber(viewsPerDay)} views/day`,
      );
      if (p.publishedAt || p.youtube_channel) {
        lines.push(
          `     Published: ${p.publishedAt || 'ExampleCo'}${p.youtube_channel ? ` by ${p.youtube_channel}` : ''}`,
        );
      }
      lines.push(
        `     Speaker: ${p.speaker || 'PRIVATE_NAME'} (${p.speaker_why_matters || 'context pending'})`,
      );
      lines.push(`     Insight: ${p.insight || ''}`);
      lines.push(
        `     Clip: ${p.approx_timestamp || 'timestamp pending'}, ${p.clip_seconds || 15} seconds`,
      );
      lines.push(`     Short: ${p.short_description || ''}`);
      lines.push(`     Virality: ${p.virality_signal || 'Verified YouTube view velocity'}`);
      lines.push('');
    });
    lines.push('  Approval queues the clip for extraction. Skip = no clip today.');
    return lines.join('\n');
  } catch (err) {
    const gate = viralityThresholds(process.env).minViewsPerDay;
    return [
      'VIRAL TECH CLIP PROPOSALS (0):',
      '',
      `  Amy is sourcing viral clips, the bar is ${formatNumber(gate)} views/day, today pool did not clear it, widening the search`,
      `  Renderer recovered from: ${safeError(err)}`,
    ].join('\n');
  }
}

module.exports = {
  generate,
  writeOutput,
  mergePreservedFields,
  renderBriefingSection,
  applyViralityGate,
  parseYouTubeChapters,
  pullYouTubeViralCandidates,
  fetchYouTubeCandidatesWithAuth,
  buildYouTubeAuthSpecs,
  loadYouTubeClientConfig,
  deterministicChapterProposal,
  chapterFreeProposal,
  fetchYouTubeTranscript,
  pickTranscriptAnchor,
  proposeClipFor,
  isCredibleClipProposal,
  isTechRelevantVideo,
  viralityThresholds,
  computeViewsPerDay,
  parseTimestampRange,
};

if (require.main === module) {
  generate({ force: process.argv.includes('--force'), date: runDate() })
    .then((data) => {
      console.log(renderBriefingSection(data));
    })
    .catch((err) => {
      console.error('[viral-tech-clips] fatal:', safeError(err));
      process.exitCode = 1;
    });
}
