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

const fs = require('fs');
const path = require('path');

const NEAR_SECONDS = 60;
const CLAIM_OVERLAP = 0.7;
const CLAIM_MIN_SHARED = 3;
const DEFAULT_CLIP_SECONDS = 15;
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

function sourceKey(row) {
  const fromUrl = youtubeId(row && (row.source_url || row.source_page_url || row.url));
  if (fromUrl) return fromUrl;
  const id = youtubeId(row && row.youtube_video_id);
  if (id) return id;
  return String((row && (row.source_url || row.url)) || '').trim().toLowerCase();
}

function toSeconds(text) {
  const parts = String(text).split(':').map((p) => Number.parseInt(p, 10));
  if (parts.length < 2 || parts.length > 3 || parts.some((n) => !Number.isFinite(n))) return null;
  return parts.length === 2 ? parts[0] * 60 + parts[1] : parts[0] * 3600 + parts[1] * 60 + parts[2];
}

// Every [start, end] second range mentioned in a timestamp string. A lone
// start becomes start .. start + fallbackSeconds.
function rangesFromText(text, fallbackSeconds = DEFAULT_CLIP_SECONDS) {
  const out = [];
  const src = String(text || '');
  const rangeRe = /(\d{1,2}:\d{2}(?::\d{2})?)\s*(?:-|–|to)\s*(\d{1,2}:\d{2}(?::\d{2})?)/gi;
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
  return out;
}

function rowRanges(row) {
  if (!row) return [];
  const clip = Number(row.clip_seconds) > 0 ? Number(row.clip_seconds) : DEFAULT_CLIP_SECONDS;
  if (Array.isArray(row.segments) && row.segments.length > 1) {
    const segs = row.segments.flatMap((s) => rangesFromText(s && s.approx_timestamp, clip));
    if (segs.length) return segs;
  }
  return rangesFromText(row.source_timestamp_range || row.approx_timestamp, clip);
}

function rangesNear(a, b, near = NEAR_SECONDS) {
  return a.some(([s1, e1]) => b.some(([s2, e2]) => s1 <= e2 + near && s2 <= e1 + near));
}

function claimTokens(row) {
  const title = String((row && (row.youtube_title || row.title)) || '');
  return new Set(
    title
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, ' ')
      .split(/\s+/)
      .filter((t) => t && !STOP.has(t) && !/^\d+$/.test(t)),
  );
}

function claimsMatch(a, b) {
  const ta = claimTokens(a);
  const tb = claimTokens(b);
  if (!ta.size || !tb.size) return false;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  return shared >= CLAIM_MIN_SHARED && shared / Math.min(ta.size, tb.size) >= CLAIM_OVERLAP;
}

// existing: manifest rows and/or earlier proposals. Returns null, or
// { kind, reason, matchedId, matchedStatus, matchedTitle, matchedRange }.
function findDuplicateClip(proposal, existing, { near = NEAR_SECONDS } = {}) {
  const key = sourceKey(proposal);
  if (!key) return null;
  const mine = rowRanges(proposal);
  for (const row of existing || []) {
    if (!row || (row.id && proposal.id && row.id === proposal.id)) continue;
    if (sourceKey(row) !== key) continue;
    const theirs = rowRanges(row);
    const status = row.status || 'proposed';
    const title = row.title || row.youtube_title || '';
    const label = `${row.id || 'unknown'} (${status}) "${title}"`;
    const base = {
      matchedId: row.id || null,
      matchedStatus: status,
      matchedTitle: title,
      matchedRange: row.source_timestamp_range || row.approx_timestamp || '',
    };
    if (mine.length && theirs.length && rangesNear(mine, theirs, near)) {
      return { kind: 'range', reason: `same source video and a range overlapping or within ${near}s of ${label}`, ...base };
    }
    if (claimsMatch(proposal, row)) {
      return { kind: 'claim', reason: `same source video and the same claim as ${label}`, ...base };
    }
  }
  return null;
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

module.exports = { findDuplicateClip, loadManifestRows, loadManifestRowsStrict, rowRanges, rangesNear, claimsMatch, sourceKey, NEAR_SECONDS };
