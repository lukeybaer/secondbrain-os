#!/usr/bin/env node
'use strict';
/**
 * youtube-video-stats.js -- collect view, like and comment counts for the most
 * recent videos posted to ExampleCo's YouTube channel, and save them as a dated
 * receipt the YOUTUBE VIDEO PERFORMANCE briefing card renders from.
 *
 * ExampleCo's ask (Q7, approved 2026-08-16): "views, likes and comments for the last
 * 5 videos posted to YouTube."
 *
 * ExampleCo's follow-up (2026-08-16): three headline view numbers on the face of the
 * card, not one -- best post in the past week, the last three posts together,
 * and lifetime on the channel. That changes what this collector has to read:
 *   - the last three and best-of-week numbers come from per-video statistics, so
 *     the collector now reads stats for up to --scan (50, YouTube's id cap per
 *     request) recent posted videos rather than only the 5 the card lists. The
 *     extra rows never reach the card body; they exist so a week window built
 *     from real per-video dates is honest rather than truncated at 5.
 *   - lifetime is a CHANNEL number, not a sum of the videos read here. Summing
 *     per-video views would silently exclude every video older than the scan and
 *     every video deleted from the channel, and would drift further from the
 *     truth every month. It comes from channels.list statistics.viewCount.
 * When the week window could not be read to its full depth the receipt records
 * that, so the card says so instead of implying a complete week.
 *
 * WHY A RECEIPT AND NOT A LIVE CALL AT RENDER TIME: briefing generation must not
 * depend on a third-party API being up at 11 PM. This collector runs once, writes
 * data/agent/youtube-video-stats/<date>.json, and the card reads that file. If
 * this collector fails it writes NOTHING, so the card blocks loudly instead of
 * rendering yesterday's numbers as today's, or zeros as facts.
 *
 * WHERE THE IDS COME FROM: content-review/pending/manifest.json, the posting
 * record every published video is written back into. Only rows with
 * status "posted" AND a youtube_video_id are eligible, newest first. If fewer
 * than the requested count exist, the receipt records both numbers so the card
 * can say "3 of 5" out loud rather than silently showing 3.
 *
 * SIGN-IN: reuses the token refresh already in
 * scripts/reconcile-manifest-with-youtube.js -- one YouTube sign-in path, not two.
 *
 * USAGE:
 *   node scripts/youtube-video-stats.js [--date YYYY-MM-DD] [--data-dir DIR]
 *                                       [--channel ExampleChannel] [--count 5]
 * Requires YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET in the environment
 * (on the cloud host: set -a; . /opt/secondbrain/.env; set +a).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { readChannelToken, refreshAccess, ytGet } = require('./reconcile-manifest-with-youtube.js');
const broker = require('./lib/credential-broker.js');

// 2 adds the headline block (best post past week / last three posts / lifetime).
// The card refuses a version-1 receipt by name rather than rendering a face that
// is missing two of the three numbers ExampleCo asked for.
const SCHEMA_VERSION = 2;
const DEFAULT_CHANNEL = 'ExampleChannel';
const DEFAULT_REQUESTED = 5;
// YouTube's videos.list accepts at most 50 ids in one request. Reading the 50
// most recent posted videos keeps the whole headline block a single API call.
const DEFAULT_SCAN = 50;
const HEADLINE_RECENT_POSTS = 3;
const HEADLINE_WINDOW_DAYS = 7;
const SOURCE_KIND = 'youtube-data-api-video-statistics';
const CHANNEL_SOURCE_KIND = 'youtube-data-api-channel-statistics';
const MANIFEST_REL = 'content-review/pending/manifest.json';

function argValue(argv, name) {
  const index = argv.indexOf(name);
  if (index >= 0 && argv[index + 1]) return argv[index + 1];
  const prefix = `${name}=`;
  const hit = argv.find((value) => String(value).startsWith(prefix));
  return hit ? String(hit).slice(prefix.length) : '';
}

function defaultDataDir() {
  return (
    process.env.SECONDBRAIN_DATA_DIR ||
    (process.platform === 'linux'
      ? '/opt/secondbrain/data'
      : path.join(
          process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
          'secondbrain',
          'data',
        ))
  );
}

function defaultRepoRoot() {
  return process.env.SECONDBRAIN_ROOT || path.resolve(__dirname, '..');
}

function defaultManifestPath(repoRoot = defaultRepoRoot()) {
  return process.env.MANIFEST_PATH || path.join(repoRoot, ...MANIFEST_REL.split('/'));
}

function readManifestFile(manifestPath) {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

// Posted rows that actually carry a YouTube id, newest first.
//   `selected` is what the card LISTS (the requested count).
//   `scanned`  is what stats are READ for (up to the scan depth), so the
//              past-week headline is built from real dates instead of being
//              cut off at the display count.
//   `postedTotal` is every eligible row, so the caller can say how many exist
//              versus how many were asked for.
//   `scanCapReached` is true when eligible rows were left unread, which is the
//              only condition under which the week window can be incomplete.
function selectPostedVideos(manifest, requested = DEFAULT_REQUESTED, scan = DEFAULT_SCAN) {
  const rows = Array.isArray(manifest && manifest.videos) ? manifest.videos : [];
  const eligible = rows
    .filter((row) => row && row.status === 'posted' && row.youtube_video_id)
    .map((row) => ({
      video_id: String(row.youtube_video_id),
      title: String(row.title || ''),
      posted_at: String(row.posted_at || ''),
      postedMs: Date.parse(String(row.posted_at || '')),
    }))
    .filter((row) => Number.isFinite(row.postedMs))
    .sort((a, b) => b.postedMs - a.postedMs);
  const cap = Number.isInteger(requested) && requested > 0 ? requested : DEFAULT_REQUESTED;
  const depth = Math.max(cap, Number.isInteger(scan) && scan > 0 ? scan : DEFAULT_SCAN);
  const strip = ({ postedMs: _drop, ...keep }) => keep;
  return {
    selected: eligible.slice(0, cap).map(strip),
    scanned: eligible.slice(0, depth).map(strip),
    postedTotal: eligible.length,
    scanCapReached: eligible.length > depth,
  };
}

function buildStatsUrl(ids) {
  const list = (Array.isArray(ids) ? ids : []).map((id) => encodeURIComponent(String(id)));
  return `https://youtube.googleapis.com/youtube/v3/videos?part=statistics,snippet&id=${list.join(',')}`;
}

function buildChannelStatsUrl(providerChannelId = '') {
  return providerChannelId
    ? `https://youtube.googleapis.com/youtube/v3/channels?part=statistics&id=${encodeURIComponent(providerChannelId)}`
    : 'https://youtube.googleapis.com/youtube/v3/channels?part=statistics&mine=true';
}

// A count YouTube did not publish (creators can hide likes) is NOT zero. Missing
// stays null all the way to the card so it renders "unavailable", never "0".
function normalizeCount(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

function watchUrl(videoId) {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(String(videoId))}`;
}

// The YouTube sign-in, resolved through the credential broker so this works
// wherever it runs. The nightly card controller (scripts/ec2-card-controller-run.sh)
// does NOT source /opt/secondbrain/.env, so a raw process.env read would leave
// the card permanently blocked on the cloud host. The broker checks env, then
// the .env file, then SSM (secondbrain.YOUTUBE_CLIENT_ID and friends), then the
// saved per-channel token on disk.
function resolveYoutubeSignIn(channel, repoRoot) {
  const clientId = broker.resolveCredential('youtube', 'clientId').value || '';
  const clientSecret = broker.resolveCredential('youtube', 'clientSecret').value || '';
  const refreshToken =
    broker.resolveCredential('youtube', 'refreshToken', { account: channel }).value ||
    (readChannelToken(channel, repoRoot) || {}).refresh_token ||
    '';
  const missing = [
    clientId ? '' : 'client id',
    clientSecret ? '' : 'client secret',
    refreshToken ? '' : `saved sign-in for the ${channel} channel`,
  ].filter(Boolean);
  if (missing.length) {
    throw new Error(
      `The YouTube sign-in on this host is missing its ${missing.join(' and ')}, so view counts cannot be read.`,
    );
  }
  return { clientId, clientSecret, refreshToken };
}

// Real network path. Injectable so tests never touch YouTube.
function fetchVideoStatisticsLive(ids, { channel = DEFAULT_CHANNEL, repoRoot } = {}) {
  const { clientId, clientSecret, refreshToken } = resolveYoutubeSignIn(
    channel,
    repoRoot || defaultRepoRoot(),
  );
  const access = refreshAccess(refreshToken, { clientId, clientSecret });
  const payload = ytGet(access, buildStatsUrl(ids));
  if (payload && payload.error) {
    const message = String((payload.error && payload.error.message) || 'unknown reason').slice(
      0,
      200,
    );
    throw new Error(`YouTube refused the statistics request: ${message}`);
  }
  return Array.isArray(payload && payload.items) ? payload.items : [];
}

// Lifetime views for the whole channel. Real network path, injectable so tests
// never touch YouTube.
function fetchChannelStatisticsLive({ channel = DEFAULT_CHANNEL, repoRoot, providerChannelId = '' } = {}) {
  const { clientId, clientSecret, refreshToken } = resolveYoutubeSignIn(
    channel,
    repoRoot || defaultRepoRoot(),
  );
  const access = refreshAccess(refreshToken, { clientId, clientSecret });
  const payload = ytGet(access, buildChannelStatsUrl(providerChannelId));
  if (payload && payload.error) {
    const message = String((payload.error && payload.error.message) || 'unknown reason').slice(
      0,
      200,
    );
    throw new Error(`YouTube refused the channel statistics request: ${message}`);
  }
  const item = Array.isArray(payload && payload.items) ? payload.items[0] : null;
  return { ...((item && item.statistics) || {}), _channel_id: String((item && item.id) || '') };
}

// What is actually on the channel. The posting manifest only records uploads
// made through the content pipeline, so a video ExampleCo uploads himself never
// reached this card (Sep 22 2026: the card said nothing posted since Sep 6).
// Private uploads are excluded; public, unlisted, and scheduled ones count.
function buildUploadsPlaylistUrl(providerChannelId = '') {
  return providerChannelId
    ? `https://youtube.googleapis.com/youtube/v3/channels?part=contentDetails&id=${encodeURIComponent(providerChannelId)}`
    : 'https://youtube.googleapis.com/youtube/v3/channels?part=contentDetails&mine=true';
}

function buildPlaylistItemsUrl(playlistId, max = DEFAULT_SCAN) {
  return `https://youtube.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails,status&maxResults=${Math.min(50, Math.max(1, max))}&playlistId=${encodeURIComponent(playlistId)}`;
}

function normalizeChannelUploads(items) {
  return (Array.isArray(items) ? items : [])
    .map((item) => ({
      video_id: String((item && item.contentDetails && item.contentDetails.videoId) || ''),
      title: String((item && item.snippet && item.snippet.title) || ''),
      posted_at: String(
        (item && item.contentDetails && item.contentDetails.videoPublishedAt) ||
          (item && item.snippet && item.snippet.publishedAt) ||
          '',
      ),
      privacy: String((item && item.status && item.status.privacyStatus) || ''),
    }))
    .filter((row) => row.video_id && row.privacy !== 'private' && Number.isFinite(Date.parse(row.posted_at)));
}

function fetchChannelUploadsLive({ channel = DEFAULT_CHANNEL, repoRoot, max = DEFAULT_SCAN, providerChannelId = '' } = {}) {
  const { clientId, clientSecret, refreshToken } = resolveYoutubeSignIn(
    channel,
    repoRoot || defaultRepoRoot(),
  );
  const access = refreshAccess(refreshToken, { clientId, clientSecret });
  const channelPayload = ytGet(access, buildUploadsPlaylistUrl(providerChannelId));
  if (channelPayload && channelPayload.error) {
    throw new Error(
      `YouTube refused the channel uploads request: ${String(channelPayload.error.message || 'unknown reason').slice(0, 200)}`,
    );
  }
  const item = Array.isArray(channelPayload && channelPayload.items) ? channelPayload.items[0] : null;
  const playlistId = item && item.contentDetails && item.contentDetails.relatedPlaylists
    ? item.contentDetails.relatedPlaylists.uploads
    : '';
  if (!playlistId) throw new Error('YouTube returned no uploads list for this channel.');
  const payload = ytGet(access, buildPlaylistItemsUrl(playlistId, max));
  if (payload && payload.error) {
    throw new Error(
      `YouTube refused the uploads list request: ${String(payload.error.message || 'unknown reason').slice(0, 200)}`,
    );
  }
  return normalizeChannelUploads(payload && payload.items);
}

// Union the channel's own uploads into the manifest's posted rows so the card
// covers everything that is live, however it got there.
function mergeChannelUploads(manifest, uploads) {
  const videos = Array.isArray(manifest && manifest.videos) ? [...manifest.videos] : [];
  const known = new Set(
    videos
      .filter((row) => row && row.status === 'posted' && row.youtube_video_id)
      .map((row) => String(row.youtube_video_id)),
  );
  for (const upload of Array.isArray(uploads) ? uploads : []) {
    if (!upload || !upload.video_id || known.has(upload.video_id)) continue;
    known.add(upload.video_id);
    videos.push({
      status: 'posted',
      youtube_video_id: upload.video_id,
      title: upload.title,
      posted_at: upload.posted_at,
      source: 'youtube-channel-uploads',
    });
  }
  return { ...(manifest || {}), videos };
}

// Lifetime is a headline number ExampleCo reads every morning, so an unreadable one
// fails the whole collect rather than quietly rendering "unavailable" forever.
// A missing viewCount here means the sign-in, the quota, or the channel's
// privacy setting is wrong, and all three need saying out loud.
function normalizeChannelStatistics(statistics) {
  const views = normalizeCount(statistics && statistics.viewCount);
  if (views === null) {
    throw new Error(
      'YouTube returned no lifetime view count for the channel, so the lifetime headline cannot be stated.',
    );
  }
  return { views, video_count: normalizeCount(statistics && statistics.videoCount) };
}

// Sums that refuse to under-count: one withheld value makes the sum unknown,
// never a smaller number presented as fact.
function sumCounts(rows, key) {
  let total = 0;
  for (const row of rows) {
    if (row[key] === null || row[key] === undefined) return null;
    total += row[key];
  }
  return total;
}

/**
 * The three headline view numbers, computed from the scanned rows and the
 * channel totals. Nothing here invents a number: a window with no posts is
 * null, a withheld count keeps the sum null, and a week that could not be read
 * to its full depth is marked incomplete so the card can say so.
 */
function buildHeadline({
  rows,
  channelStats,
  now,
  scanCapReached = false,
  recentPosts = HEADLINE_RECENT_POSTS,
  windowDays = HEADLINE_WINDOW_DAYS,
}) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  const windowStartMs = nowMs - windowDays * 24 * 60 * 60 * 1000;
  const recent = rows.slice(0, recentPosts);
  const inWindow = rows.filter((row) => {
    const ms = Date.parse(String(row.posted_at || ''));
    return Number.isFinite(ms) && ms >= windowStartMs && ms <= nowMs;
  });
  const rankable = inWindow.filter((row) => Number.isInteger(row.views));
  // Newest wins a tie: rows are already newest first, so a strict > keeps the
  // first (newest) row when two videos have the same count.
  let best = null;
  for (const row of rankable) {
    if (!best || row.views > best.views) best = row;
  }
  const oldestScannedMs = rows.length
    ? Date.parse(String(rows[rows.length - 1].posted_at || ''))
    : NaN;
  // The week is fully read when every eligible video was scanned, or when the
  // oldest video read is already older than the window.
  const complete =
    !scanCapReached || (Number.isFinite(oldestScannedMs) && oldestScannedMs < windowStartMs);
  return {
    window_days: windowDays,
    last_posts: {
      requested: recentPosts,
      videos: recent.length,
      views: sumCounts(recent, 'views'),
      likes: sumCounts(recent, 'likes'),
      comments: sumCounts(recent, 'comments'),
    },
    past_week: {
      videos: inWindow.length,
      complete,
      unreadable: inWindow.length - rankable.length,
    },
    best_past_week: best
      ? {
          video_id: best.video_id,
          title: best.title,
          posted_at: best.posted_at,
          url: best.url,
          views: best.views,
        }
      : null,
    lifetime: {
      views: channelStats.views,
      video_count: channelStats.video_count,
      source: CHANNEL_SOURCE_KIND,
    },
  };
}

function buildSnapshot({
  date,
  now = new Date(),
  selected,
  scanned,
  postedTotal,
  scanCapReached = false,
  apiItems,
  channelStatistics,
  requested = DEFAULT_REQUESTED,
  channel = DEFAULT_CHANNEL,
}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) {
    throw new Error('A YYYY-MM-DD briefing date is required.');
  }
  const generatedAt =
    now instanceof Date ? now.toISOString() : new Date(Date.parse(String(now))).toISOString();
  const byId = new Map((Array.isArray(apiItems) ? apiItems : []).map((item) => [item.id, item]));
  const withStats = (row) => {
    const item = byId.get(row.video_id);
    const stats = (item && item.statistics) || {};
    const snippet = (item && item.snippet) || {};
    return {
      video_id: row.video_id,
      // Prefer YouTube's current title: the posting record can hold the
      // pre-publish working title, which is not what ExampleCo sees on the channel.
      title: String(snippet.title || row.title || '').trim(),
      posted_at: String(snippet.publishedAt || row.posted_at || ''),
      views: item ? normalizeCount(stats.viewCount) : null,
      likes: item ? normalizeCount(stats.likeCount) : null,
      comments: item ? normalizeCount(stats.commentCount) : null,
      url: watchUrl(row.video_id),
    };
  };
  // Every scanned row carries stats; only the first `requested` are listed on
  // the card. The rest exist solely so the week window is honest.
  const scannedRows = (Array.isArray(scanned) && scanned.length ? scanned : selected).map(
    withStats,
  );
  const videos = scannedRows.slice(0, selected.length);
  return {
    schema_version: SCHEMA_VERSION,
    date,
    generated_at: generatedAt,
    requested,
    posted_available: videos.length,
    posted_total: postedTotal,
    scanned_available: scannedRows.length,
    channel,
    videos,
    headline: buildHeadline({
      rows: scannedRows,
      channelStats: normalizeChannelStatistics(channelStatistics),
      now,
      scanCapReached,
    }),
    source: {
      kind: SOURCE_KIND,
      channel,
      manifest: MANIFEST_REL,
      channel_statistics: CHANNEL_SOURCE_KIND,
    },
  };
}

function writeSnapshotAtomic(dataDir, date, snapshot) {
  const destination = path.join(dataDir, 'agent', 'youtube-video-stats', `${date}.json`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temp = `${destination}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, destination);
  return destination;
}

function collectYoutubeVideoStats({
  date,
  dataDir = defaultDataDir(),
  repoRoot = defaultRepoRoot(),
  now = new Date(),
  channel = DEFAULT_CHANNEL,
  credentialChannel = channel,
  providerChannelId = '',
  requested = DEFAULT_REQUESTED,
  scan = DEFAULT_SCAN,
  manifestPath,
  readManifest,
  fetchVideoStatistics,
  fetchChannelStatistics,
  fetchChannelUploads,
  channelUploadsOnly = false,
  write = true,
} = {}) {
  const resolvedManifestPath = manifestPath || defaultManifestPath(repoRoot);
  const pipelineManifest = readManifest
    ? readManifest(resolvedManifestPath)
    : readManifestFile(resolvedManifestPath);
  // An unreadable uploads list fails the collect like the lifetime read does,
  // so the card blocks instead of claiming nothing was posted.
  const uploads = (fetchChannelUploads || fetchChannelUploadsLive)({ channel: credentialChannel, repoRoot, max: scan, providerChannelId });
  const uploadsManifest = {
    videos: uploads.map((upload) => ({
      status: 'posted',
      youtube_video_id: upload.video_id,
      title: upload.title,
      posted_at: upload.posted_at,
      source: 'youtube-channel-uploads',
    })),
  };
  const manifest = channelUploadsOnly ? uploadsManifest : mergeChannelUploads(pipelineManifest, uploads);
  const { selected, scanned, postedTotal, scanCapReached } = selectPostedVideos(
    manifest,
    requested,
    scan,
  );
  // No posted videos is a real, source-backed answer, not a failure. The
  // receipt still gets written so the card can state the honest zero.
  const apiItems = scanned.length
    ? (fetchVideoStatistics || fetchVideoStatisticsLive)(
        scanned.map((row) => row.video_id),
        { channel: credentialChannel, repoRoot },
      )
    : [];
  // Lifetime is a channel fact, so it is read even when nothing has been posted
  // and written back to the posting record yet.
  const channelStatistics = (fetchChannelStatistics || fetchChannelStatisticsLive)({
    channel,
    repoRoot,
    providerChannelId,
  });
  const snapshot = buildSnapshot({
    date,
    now,
    selected,
    scanned,
    postedTotal,
    scanCapReached,
    apiItems,
    channelStatistics,
    requested,
    channel,
  });
  snapshot.provider_channel_id = String(channelStatistics && channelStatistics._channel_id || '');
  if (channelUploadsOnly) {
    snapshot.source.manifest = null;
    snapshot.source.selection = 'authenticated-channel-uploads';
  }
  const file = write ? writeSnapshotAtomic(dataDir, date, snapshot) : null;
  return { file, snapshot };
}

function main(argv = process.argv.slice(2)) {
  const nowRaw = argValue(argv, '--now');
  const now = nowRaw ? new Date(nowRaw) : new Date();
  const date =
    argValue(argv, '--date') || now.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  const countRaw = Number.parseInt(argValue(argv, '--count') || '', 10);
  const scanRaw = Number.parseInt(argValue(argv, '--scan') || '', 10);
  const outcome = collectYoutubeVideoStats({
    date,
    dataDir: argValue(argv, '--data-dir') || defaultDataDir(),
    now,
    channel: argValue(argv, '--channel') || process.env.YOUTUBE_CHANNEL || DEFAULT_CHANNEL,
    requested: Number.isInteger(countRaw) && countRaw > 0 ? countRaw : DEFAULT_REQUESTED,
    scan: Number.isInteger(scanRaw) && scanRaw > 0 ? scanRaw : DEFAULT_SCAN,
  });
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      file: outcome.file,
      date,
      requested: outcome.snapshot.requested,
      posted_available: outcome.snapshot.posted_available,
      scanned_available: outcome.snapshot.scanned_available,
      lifetime_views: outcome.snapshot.headline.lifetime.views,
      generated_at: outcome.snapshot.generated_at,
    })}\n`,
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[youtube-video-stats] ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  SCHEMA_VERSION,
  SOURCE_KIND,
  CHANNEL_SOURCE_KIND,
  DEFAULT_CHANNEL,
  DEFAULT_REQUESTED,
  DEFAULT_SCAN,
  HEADLINE_RECENT_POSTS,
  HEADLINE_WINDOW_DAYS,
  MANIFEST_REL,
  defaultDataDir,
  defaultRepoRoot,
  defaultManifestPath,
  selectPostedVideos,
  buildStatsUrl,
  buildChannelStatsUrl,
  buildUploadsPlaylistUrl,
  normalizeCount,
  normalizeChannelStatistics,
  buildHeadline,
  buildSnapshot,
  writeSnapshotAtomic,
  resolveYoutubeSignIn,
  fetchVideoStatisticsLive,
  fetchChannelStatisticsLive,
  fetchChannelUploadsLive,
  normalizeChannelUploads,
  mergeChannelUploads,
  buildPlaylistItemsUrl,
  collectYoutubeVideoStats,
  main,
};
