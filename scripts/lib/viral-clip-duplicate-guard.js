'use strict';
// Duplicate guard for viral-clip proposals (owner decision: "Already approved
// the put Sam Altman in jail one, the Edward Snowden one yesterday. So you
// teed it up again.").
//
// Root cause it closes: the proposer only compared exact titles against
// posted videos and skipped yesterday's source for metadata, so the same
// source with an overlapping range and a reworded title slipped through.
// This guard compares every video already in the approval manifest, in ANY
// status (posted, approved, scheduled, pending, deleted: a deletion is
// terminal by video identity), by source video AND either a time range that
// overlaps or sits within NEAR_SECONDS, OR the same claim words.
//
// Release time (2026-10-24, the Hinton clip was posted three times): the
// proposer and auto-build compare all statuses through findDuplicateClip.
// decideUploadDuplicate is the release-time decision used by approve, enqueue
// and the upload slot; it compares only posted rows, channel uploads and
// earlier queued items, so pending siblings never deadlock each other. A
// cross-source claim (same speaker and claim, different source) blocks only
// when the matched row is posted, a channel upload, queued or approved, and
// dated within CROSS_SOURCE_RECENT_DAYS; otherwise it warns. A Short and a
// long-form film are never duplicates of each other. Release time uses no
// near window (RELEASE_NEAR_SECONDS = 0): only a touching or overlapping range
// blocks, so two cuts from different parts of one long video stay
// approvable, and a real match is released only by the recorded owner
// override (allow_duplicate).
//
// Channel uploads (Codex 494e7d92920d, 2026-10-24): a stats snapshot row
// carried only the uploaded id, title and date, so youtube-video-stats.js now
// records source_url (and a range when the description names one) parsed
// from the YouTube description, where every pipeline upload writes
// "Full episode: <source url>", plus a compact channel_uploads list of every
// scanned upload. Uploads the manifest knows are joined by youtube_video_id
// (the manifest row, with its source and range, stands in for them). A
// channel upload with the same source and no range on record blocks too;
// the owner override clears a genuinely different cut. A queue file that
// exists but cannot be read fails closed like the manifest; a missing file
// is an empty queue. This module requires only fs, path and os, because the
// public mirror strips the viral-clip thesis and themes modules
// (simulate-public-sync.js).

const fs = require('fs');
const path = require('path');
const os = require('os');

const NEAR_SECONDS = 60;
const RELEASE_NEAR_SECONDS = 0;
const CLAIM_OVERLAP = 0.7;
const CLAIM_MIN_SHARED = 3;
const DEFAULT_CLIP_SECONDS = 15;
const CROSS_SOURCE_RECENT_DAYS = 30;
const DEFAULT_QUEUE_PATH = '/opt/secondbrain/data/youtube/queue.json';
const STATS_LOOKBACK_FILES = 45;
const LEAD_SPEAKER_RE = /^\s*([A-Z][\p{L}'.-]*(?:\s+[A-Z][\p{L}'.-]*){0,3}?)\s*(?::|\s+(?:Just\s+)?(?:Says|Said)\b)/u;
const STOP = new Set(
  ('a an the and or but of to in on at for from with by as is are was were be been it its this that these those ' +
    'just said says say saying should would could will go goes going get gets got has have had not no ' +
    'about into over out up he she they we you i his her their our your what who how why when new now').split(' '),
);

function youtubeId(value) {
  const text = String(value || '').trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(text)) return text;
  const m = text.match(/(?:[?&]v=|youtu\.be\/|\/embed\/|\/shorts\/|\/live\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : '';
}

// Source identity from a YouTube description. Pipeline uploads write
// "Source: <attribution>\nFull episode: <source url>" (build-viral-clip.js);
// the first YouTube URL that is not the upload itself wins, a "Full episode"
// or "Source" line first. A clip range on that line (7:33-8:18) is kept.
const RANGE_IN_TEXT_RE = /(\d{1,2}:\d{2}(?::\d{2})?)\s*(?:-|\u2013|to)\s*(\d{1,2}:\d{2}(?::\d{2})?)/;
const SOURCE_LINE_RE = /^\s*(?:full\s+(?:episode|video|interview|talk|podcast)|source|original)\b/i;
function sourceFromDescription(description, ownVideoId) {
  const own = youtubeId(ownVideoId);
  const lines = String(description || '').split(/\r?\n/);
  const ranked = [...lines.filter((line) => SOURCE_LINE_RE.test(line)), ...lines];
  for (const line of ranked) {
    const urls = line.match(/https?:\/\/[^\s)]+/g) || [];
    for (const url of urls) {
      const id = youtubeId(url);
      if (!id || id === own) continue;
      const range = line.match(RANGE_IN_TEXT_RE);
      return {
        source_url: 'https://www.youtube.com/watch?v=' + id,
        source_timestamp_range: range ? range[1] + '-' + range[2] : null,
      };
    }
  }
  return { source_url: null, source_timestamp_range: null };
}

// Mirrors isVideoPostedOnRow (scripts/lib/video-delete-state.js); inlined so
// this module keeps core requires only. A parity test pins the two.
function isPostedRow(row) {
  if (!row) return false;
  if (String(row.status || '') === 'posted') return true;
  return String(row.upload_status || '').trim() === 'posted' && String(row.youtube_video_id || '').trim() !== '';
}

// A manifest row whose video is on YouTube but held private (AI-presenter
// label or publish unproved) reserves its source like a posted row (Codex
// 6627b57dbccb F5).
function isHeldRow(row) {
  return Boolean(row && row.youtube_hold && String(row.youtube_video_id || '').trim());
}

// Mirrors isLongformProposal (scripts/lib/longform-video.js).
function isLongformRow(row) {
  return String((row && (row.format || row.youtube_format)) || '').trim().toLowerCase() === 'longform';
}

// The SOURCE video identity. Never the row's youtube_video_id: on a posted
// row that is the UPLOADED id, on a proposal the source id.
function sourceKey(row) {
  if (!row) return '';
  const explicit = youtubeId(row.source_video_id || row.source_youtube_video_id);
  if (explicit) return explicit;
  const fromSource = youtubeId(row.source_url || row.source_page_url);
  if (fromSource) return fromSource;
  const fromUrl = youtubeId(row.url);
  if (fromUrl && !(isPostedRow(row) && fromUrl === youtubeId(row.youtube_video_id))) return fromUrl;
  return String(row.source_url || row.source_page_url || '').trim().toLowerCase();
}

function toSeconds(text) {
  const parts = String(text).split(':').map((p) => Number.parseInt(p, 10));
  if (parts.length < 2 || parts.length > 3 || parts.some((n) => !Number.isFinite(n))) return null;
  return parts.length === 2 ? parts[0] * 60 + parts[1] : parts[0] * 3600 + parts[1] * 60 + parts[2];
}

// Every [start, end] second range mentioned in a timestamp string. A lone
// start becomes start .. start + fallbackSeconds. A string that is only a
// bare seconds range ('45-80') counts too.
function rangesFromText(text, fallbackSeconds = DEFAULT_CLIP_SECONDS) {
  const out = [];
  const src = String(text || '');
  const rangeRe = /(\d{1,2}:\d{2}(?::\d{2})?)\s*(?:-|\u2013|to)\s*(\d{1,2}:\d{2}(?::\d{2})?)/gi;
  let m;
  let rest = src;
  while ((m = rangeRe.exec(src))) {
    const a = toSeconds(m[1]);
    const b = toSeconds(m[2]);
    if (a != null && b != null && b > a) out.push([a, b]);
    rest = rest.replace(m[0], ' ');
  }
  const startRe = /\d{1,2}:\d{2}(?::\d{2})?/g;
  while ((m = startRe.exec(rest))) {
    const a = toSeconds(m[0]);
    if (a != null) out.push([a, a + fallbackSeconds]);
  }
  if (!/\d:\d/.test(src)) {
    const bare = src.trim().match(/^(\d{1,5})\s*s?\s*(?:-|\u2013|to)\s*(\d{1,5})\s*s?$/i);
    if (bare) {
      const a = Number(bare[1]);
      const b = Number(bare[2]);
      if (b > a) out.push([a, b]);
    }
  }
  return out;
}

function rowRanges(row) {
  if (!row) return [];
  const clip = Number(row.clip_seconds) > 0 ? Number(row.clip_seconds) : DEFAULT_CLIP_SECONDS;
  const seg = [];
  for (const s of Array.isArray(row.segments) ? row.segments : []) seg.push(...rangesFromText(s && s.approx_timestamp, clip));
  for (const s of Array.isArray(row.source_segments) ? row.source_segments : []) {
    seg.push(...rangesFromText(typeof s === 'string' ? s : s && s.approx_timestamp, clip));
  }
  if (seg.length) return seg;
  return rangesFromText(row.source_timestamp_range || row.approx_timestamp, clip);
}

function rangesNear(a, b, near = NEAR_SECONDS) {
  return a.some(([s1, e1]) => b.some(([s2, e2]) => s1 <= e2 + near && s2 <= e1 + near));
}

function titleOf(row) {
  return String((row && (row.youtube_title || row.title)) || '');
}

// Every numeral in the title, single digits included, leading zeros stripped.
function numeralSet(row) {
  return new Set((titleOf(row).match(/\d+/g) || []).map((n) => n.replace(/^0+(?=\d)/, '')));
}

function claimTokens(row, drop) {
  return new Set(
    titleOf(row)
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, ' ')
      .split(/\s+/)
      .filter((t) => t && !STOP.has(t) && (!/^\d+$/.test(t) || /^\d{2,}$/.test(t)) && !(drop && drop.has(t))),
  );
}

function sameSet(a, b) {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

// Two titles that differ in any figure are different claims.
function claimsMatch(a, b, drop) {
  const na = numeralSet(a);
  const nb = numeralSet(b);
  if ((na.size || nb.size) && !sameSet(na, nb)) return false;
  const ta = claimTokens(a, drop);
  const tb = claimTokens(b, drop);
  if (!ta.size || !tb.size) return false;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  return shared >= CLAIM_MIN_SHARED && shared / Math.min(ta.size, tb.size) >= CLAIM_OVERLAP;
}

// The named speaker: speaker_name (2+ words), else a leading '<Name> Says',
// '<Name> Just Said' or '<Name>:'. Null when there is none.
function speakerOf(row) {
  if (!row) return null;
  let name = String(row.speaker_name || '').trim();
  if (name.split(/\s+/).filter(Boolean).length < 2) {
    const m = titleOf(row).match(LEAD_SPEAKER_RE);
    name = m ? m[1] : '';
  }
  const tokens = name.toLowerCase().replace(/[^\p{L}\s]+/gu, ' ').split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;
  return { key: tokens[tokens.length - 1], tokens: new Set(tokens) };
}

function rowTimeMs(row) {
  for (const field of ['posted_at', 'queued_at', 'approved_at', 'synced_at', 'generated_date', 'created_at']) {
    const value = row && row[field];
    if (value) return Date.parse(String(value));
  }
  return NaN;
}

function crossSourceBlocks(row, now = Date.now(), days = CROSS_SOURCE_RECENT_DAYS) {
  const released =
    row.ref_kind === 'channel_upload' || row.ref_kind === 'queued' || isPostedRow(row) || String(row.status) === 'approved';
  const t = rowTimeMs(row);
  return released && Number.isFinite(t) && now - t <= days * 86400000;
}

function matchedUrlOf(row) {
  if (row.youtube_url) return row.youtube_url;
  if (row.ref_kind === 'channel_upload' && row.youtube_video_id) return `https://www.youtube.com/watch?v=${row.youtube_video_id}`;
  return null;
}

// Every match of proposal against existing (manifest rows, earlier
// proposals, channel uploads or queued refs). Each match is
// { kind, blocking, reason, matchedId, matchedStatus, matchedTitle,
//   matchedRange, matchedRefKind, matchedPostedAt, matchedUrl }.
function findDuplicateClips(proposal, existing, { near = NEAR_SECONDS, now = Date.now(), recentDays = CROSS_SOURCE_RECENT_DAYS } = {}) {
  const out = [];
  if (!proposal) return out;
  const key = sourceKey(proposal);
  const mine = rowRanges(proposal);
  const myLongform = isLongformRow(proposal);
  const mySpeaker = speakerOf(proposal);
  for (const row of existing || []) {
    if (!row || (row.id && proposal.id && row.id === proposal.id)) continue;
    if (isLongformRow(row) !== myLongform) continue;
    const status = row.status || 'proposed';
    const title = row.title || row.youtube_title || '';
    const label = `${row.id || 'unknown'} (${status}) "${title}"`;
    const base = {
      matchedId: row.id || null,
      matchedStatus: status,
      matchedTitle: title,
      matchedRange: row.source_timestamp_range || row.approx_timestamp || '',
      matchedRefKind: row.ref_kind || 'manifest',
      matchedPostedAt: row.posted_at || null,
      matchedUrl: matchedUrlOf(row),
    };
    const theirKey = sourceKey(row);
    if (key && theirKey === key) {
      const theirs = rowRanges(row);
      if (mine.length && theirs.length && rangesNear(mine, theirs, near)) {
        out.push({ kind: 'range', blocking: true, reason: `same source video and a range overlapping or within ${near}s of ${label}`, ...base });
      } else if (claimsMatch(proposal, row)) {
        out.push({ kind: 'claim', blocking: true, reason: `same source video and the same claim as ${label}`, ...base });
      } else if (row.ref_kind === 'channel_upload' && !theirs.length) {
        // The channel already carries a clip from this source and nothing
        // records which part. Block; the owner override clears a different cut.
        out.push({ kind: 'source', blocking: true, reason: `same source video as channel upload ${label}, whose clip range is not on record (approve anyway only for a different part)`, ...base });
      }
      continue;
    }
    const theirSpeaker = speakerOf(row);
    if (!mySpeaker || !theirSpeaker || mySpeaker.key !== theirSpeaker.key) continue;
    const drop = new Set([...mySpeaker.tokens, ...theirSpeaker.tokens]);
    if (!claimsMatch(proposal, row, drop)) continue;
    out.push({
      kind: 'cross_source_claim',
      blocking: crossSourceBlocks(row, now, recentDays),
      reason: `another source with the same speaker (${mySpeaker.key}) and the same claim as ${label}`,
      ...base,
    });
  }
  return out;
}

// The first blocking match, or null. Signature kept for the proposer and
// auto-build.
function findDuplicateClip(proposal, existing, opts = {}) {
  return findDuplicateClips(proposal, existing, opts).find((m) => m.blocking) || null;
}

function loadManifestRows(manifestPath) {
  const candidates = manifestPath
    ? [manifestPath]
    : [
        '/opt/secondbrain/content-review/pending/manifest.json',
        path.resolve(__dirname, '..', '..', 'content-review', 'pending', 'manifest.json'),
      ];
  for (const file of candidates) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
      return Array.isArray(data) ? data : data.videos || [];
    } catch {
      /* try next */
    }
  }
  return [];
}

// Fail-closed variant for builders: null when no manifest could be read, so a
// transient read failure never passes for "nothing posted yet".
function loadManifestRowsStrict(manifestPath) {
  const candidates = manifestPath
    ? [manifestPath]
    : [
        '/opt/secondbrain/content-review/pending/manifest.json',
        path.resolve(__dirname, '..', '..', 'content-review', 'pending', 'manifest.json'),
      ];
  for (const file of candidates) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
      if (Array.isArray(data)) return data;
      if (data && Array.isArray(data.videos)) return data.videos;
    } catch {
      /* try next */
    }
  }
  return null;
}

// Same directory youtube-video-stats.js writeSnapshotAtomic writes to.
function defaultStatsDir() {
  const dataDir =
    process.env.SECONDBRAIN_DATA_DIR ||
    (process.platform === 'linux'
      ? '/opt/secondbrain/data'
      : path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'secondbrain', 'data'));
  return path.join(dataDir, 'agent', 'youtube-video-stats');
}

function readStatsUploads(statsDir, knownUploadIds) {
  let names = [];
  try {
    names = fs.readdirSync(statsDir).filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort().reverse().slice(0, STATS_LOOKBACK_FILES);
  } catch {
    names = [];
  }
  const byId = new Map();
  let statsFiles = 0;
  let newestStatsDate = null;
  for (const name of names) {
    let snapshot;
    try {
      snapshot = JSON.parse(fs.readFileSync(path.join(statsDir, name), 'utf8'));
    } catch {
      continue;
    }
    if (!snapshot || typeof snapshot !== 'object') continue;
    statsFiles += 1;
    if (!newestStatsDate) newestStatsDate = name.slice(0, 10);
    const list = Array.isArray(snapshot.channel_uploads) ? snapshot.channel_uploads : Array.isArray(snapshot.videos) ? snapshot.videos : [];
    const best = snapshot.headline && snapshot.headline.best_past_week;
    for (const v of best ? [...list, best] : list) {
      const id = v && String(v.video_id || '').trim();
      if (!id || knownUploadIds.has(id) || byId.has(id)) continue;
      // Source identity written by youtube-video-stats.js, or parsed here
      // from a description when a snapshot carries one. Never v.url: that is
      // the upload itself.
      const parsed = v.source_url || !v.description ? null : sourceFromDescription(v.description, id);
      byId.set(id, {
        id: 'channel-upload:' + id,
        ref_kind: 'channel_upload',
        status: 'posted',
        title: String(v.title || ''),
        youtube_video_id: id,
        posted_at: v.posted_at || null,
        source_url: String(v.source_url || (parsed && parsed.source_url) || '').trim() || null,
        source_timestamp_range: String(v.source_timestamp_range || (parsed && parsed.source_timestamp_range) || '').trim() || null,
      });
    }
  }
  return { channelUploads: [...byId.values()], statsFiles, newestStatsDate };
}

// The rows a release is compared against: strict manifest rows UNION channel
// uploads from youtube-video-stats snapshots UNION queued upload items joined
// to their manifest rows. rows is null when the manifest is unreadable.
function loadUploadReferenceRows({ manifestPath, statsDir, queuePath = DEFAULT_QUEUE_PATH, queue } = {}) {
  const manifestRows = loadManifestRowsStrict(manifestPath);
  if (!Array.isArray(manifestRows)) return { rows: null, manifestRows: null, coverage: 'none', reason: 'manifest_unreadable' };
  // A manifest row governs its upload whatever its status, so a deleted
  // upload never returns as a posted blocker from a stats snapshot.
  const knownUploadIds = new Set();
  for (const row of manifestRows) {
    if (!row) continue;
    const id = String(row.youtube_video_id || '').trim();
    if (id) knownUploadIds.add(id);
    const fromUrl = youtubeId(row.youtube_url);
    if (fromUrl) knownUploadIds.add(fromUrl);
  }
  const { channelUploads, statsFiles, newestStatsDate } = readStatsUploads(statsDir || defaultStatsDir(), knownUploadIds);
  const coverage = statsFiles ? 'manifest_plus_channel_uploads' : 'manifest_only';
  // The server passes its in-memory queue (the authority; a source test pins
  // every call site). A caller without one reads the file: missing means an
  // empty queue, present but unreadable fails closed like the manifest.
  let items = [];
  if (Array.isArray(queue)) items = queue;
  else if (fs.existsSync(queuePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
      if (!Array.isArray(data)) throw new Error('queue file is not an array');
      items = data;
    } catch {
      return { rows: null, manifestRows, coverage: 'none', reason: 'queue_unreadable' };
    }
  }
  const byId = new Map(manifestRows.filter((r) => r && r.id).map((r) => [r.id, r]));
  const queued = [];
  // A held-private item (video on YouTube, label or publish unproved) is a
  // reservation like a posted row (Codex 6627b57dbccb F5).
  items.forEach((item, i) => {
    if (!item || (item.status !== 'queued' && item.status !== 'held-private')) return;
    const row = byId.get(item.id) || { id: item.id, title: item.title };
    queued.push({
      ...row,
      ...(item.videoId && !row.youtube_video_id ? { youtube_video_id: item.videoId } : {}),
      youtube_format: item.youtube_format || row.youtube_format,
      ref_kind: 'queued',
      queue_status: item.status,
      queue_index: i,
      queued_at: item.queued_at,
    });
  });
  const rows = [...manifestRows.filter(Boolean).map((r) => ({ ...r, ref_kind: 'manifest' })), ...channelUploads, ...queued];
  return { rows, manifestRows, coverage, reason: null, channelUploads, statsFiles, newestStatsDate, queued };
}

// Release-time decision: { allowed, reason, match }.
function decideUploadDuplicate(
  row,
  referenceRows,
  { selfId, allowOverride = false, queueIndex = null, now = Date.now(), unavailableReason = 'manifest_unreadable' } = {},
) {
  if (!Array.isArray(referenceRows)) return { allowed: false, reason: unavailableReason, match: null, unavailable: true };
  const self = selfId || (row && row.id);
  const comparable = referenceRows.filter((ref) => {
    if (!ref || (self && ref.id === self)) return false;
    if (ref.ref_kind === 'channel_upload') return true;
    if (ref.ref_kind === 'queued') {
      if (ref.queue_status === 'held-private') return true;
      return ref.queue_status === 'queued' && (queueIndex == null || ref.queue_index < queueIndex);
    }
    return isPostedRow(ref) || isHeldRow(ref);
  });
  const matches = findDuplicateClips(row, comparable, { now, near: RELEASE_NEAR_SECONDS });
  const blocking = matches.find((m) => m.blocking) || null;
  if (allowOverride || (row && row.allow_duplicate === true)) return { allowed: true, reason: 'owner_override', match: blocking || matches[0] || null };
  if (blocking) return { allowed: false, reason: 'duplicate_' + blocking.kind, match: blocking };
  if (matches.length) return { allowed: true, reason: 'cross_source_claim_warning', match: matches[0] };
  return { allowed: true, reason: 'no_duplicate', match: null };
}

function describeDuplicate(decision) {
  if (!decision) return '';
  if (decision.reason === 'queue_unreadable') return 'duplicate guard could not read the upload queue, so nothing is released';
  if (decision.unavailable || decision.reason === 'manifest_unreadable') return 'duplicate guard could not read the approval manifest, so nothing is released';
  const m = decision.match;
  if (!m) return decision.reason || '';
  return (
    `duplicate of "${m.matchedTitle}" (${m.matchedId}, ${m.matchedStatus}` +
    (m.matchedPostedAt ? `, posted ${m.matchedPostedAt}` : '') +
    (m.matchedUrl ? `, ${m.matchedUrl}` : '') +
    `): ${m.reason}`
  );
}

// A queue item carries no source fields; join it to its manifest row by id.
function uploadCandidateFromQueueItem(queued, manifestRows) {
  const item = queued || {};
  const row = (Array.isArray(manifestRows) ? manifestRows : []).find((r) => r && r.id === item.id) || {};
  return {
    ...row,
    id: item.id,
    title: item.title || row.title || '',
    youtube_title: item.title || row.youtube_title || row.title || '',
    youtube_format: item.youtube_format || row.youtube_format,
    allow_duplicate: row.allow_duplicate === true || item.allow_duplicate === true,
  };
}

function checkUploadDuplicate(row, opts = {}) {
  const refs = loadUploadReferenceRows(opts);
  const decision = decideUploadDuplicate(row, refs.rows, {
    selfId: opts.selfId,
    allowOverride: opts.allowOverride === true,
    queueIndex: opts.queueIndex == null ? null : opts.queueIndex,
    now: opts.now == null ? Date.now() : opts.now,
    unavailableReason: refs.reason || 'manifest_unreadable',
  });
  return { ...decision, coverage: refs.coverage, text: describeDuplicate(decision) };
}

module.exports = {
  findDuplicateClip,
  findDuplicateClips,
  decideUploadDuplicate,
  loadUploadReferenceRows,
  checkUploadDuplicate,
  uploadCandidateFromQueueItem,
  describeDuplicate,
  sourceFromDescription,
  speakerOf,
  isPostedRow,
  isHeldRow,
  isLongformRow,
  loadManifestRows,
  loadManifestRowsStrict,
  rowRanges,
  rangesNear,
  claimsMatch,
  sourceKey,
  NEAR_SECONDS,
  RELEASE_NEAR_SECONDS,
  CROSS_SOURCE_RECENT_DAYS,
  DEFAULT_QUEUE_PATH,
};
