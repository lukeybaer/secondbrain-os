'use strict';
/**
 * Views gained in the last 24 hours for daily clip sources.
 *
 * ExampleCo 2026-10-03: the daily clip sources are the niche videos getting the
 * most views in the last 24 hours. YouTube publishes lifetime view counts only
 * (videos.list statistics carries no recent-views field), so the gain is
 * measured here: every run stores each candidate's count, and a later run
 * subtracts the count stored about a day earlier.
 */

const fs = require('fs');
const path = require('path');

const HOUR_MS = 60 * 60 * 1000;
const STORE_VERSION = 1;
// A baseline under half a day old mostly measures the time of day.
const MIN_BASELINE_HOURS = 12;
const MAX_BASELINE_HOURS = 60;
// Only a gap this close to one day is called measured (night run to night
// run). Any other usable gap is scaled to 24 hours and labeled an estimate,
// because a viral spike is not linear (Codex review 0b36afa4a0e5).
const MEASURED_MIN_HOURS = 22;
const MEASURED_MAX_HOURS = 26;
// The newer count of a measured pair must come from this run or one just
// before it, so a stale pair never passes as "the last 24 hours".
const MAX_CURRENT_AGE_HOURS = 6;
// One stored count per video per three hours; a repair rerun adds nothing.
const MIN_OBSERVATION_GAP_HOURS = 3;
// YouTube's developer policy allows stored API data for 30 days; the measure
// needs two and a half.
const KEEP_OBSERVATION_DAYS = 8;
// A video is re-read this long after a search or channel pull last surfaced
// it, so a source that drops out of search still has a measured gain.
const TRACK_DAYS = 7;
const MAX_TRACKED = 300;
// Without a baseline, the lifetime average stands in only while a video is young.
const ESTIMATE_MAX_AGE_DAYS = 7;

function emptyStore() {
  return { version: STORE_VERSION, videos: {} };
}

function loadStore(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    const store = emptyStore();
    // A missing file is the first run; anything else is reported by the caller.
    if (err && err.code !== 'ENOENT') store.loadError = String(err.code || err.message || err).slice(0, 120);
    return store;
  }
  try {
    const parsed = JSON.parse(raw.replace(/^﻿/, ''));
    if (parsed && parsed.videos && typeof parsed.videos === 'object' && !Array.isArray(parsed.videos)) {
      return { version: STORE_VERSION, videos: parsed.videos };
    }
    return { ...emptyStore(), loadError: 'unexpected shape' };
  } catch {
    return { ...emptyStore(), loadError: 'unreadable JSON' };
  }
}

function saveStore(file, store) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: STORE_VERSION, videos: (store && store.videos) || {} }));
  fs.renameSync(tmp, file);
}

function videoKey(video) {
  return String((video && (video.videoId || video.id || video.youtube_video_id)) || '').trim();
}

function viewsOf(video) {
  const n = Number(video && (video.views ?? video.viewCount ?? video.view_count));
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Which counter a count came from. The Data API and the watch-page player can
// disagree by a few percent at the same instant, which on a large video is
// more than a day's gain, so a gain is only ever measured within one counter.
// A flat search-result row carries a rounded count and is never stored.
function countSource(video) {
  const evidence = String((video && video.viewEvidence) || '');
  if (/search result/i.test(evidence)) return null;
  if (/embedded-player/i.test(evidence)) return 'player';
  return 'api';
}

function observationsOf(store, id) {
  const row = store && store.videos && store.videos[id];
  return row && Array.isArray(row.observations) ? row.observations : [];
}

function prune(store, nowMs) {
  const keepAfter = nowMs - KEEP_OBSERVATION_DAYS * 24 * HOUR_MS;
  for (const [id, row] of Object.entries(store.videos)) {
    const kept = (Array.isArray(row && row.observations) ? row.observations : []).filter(
      (obs) => Date.parse(obs && obs.at) >= keepAfter,
    );
    if (!kept.length) delete store.videos[id];
    else row.observations = kept;
  }
}

// Store this run's count for every candidate. `trackedOnly` rows were re-read
// from the store, not surfaced by a search or channel pull, so they do not
// extend their own tracking window.
function recordObservations(store, videos, now = new Date()) {
  if (!store || !store.videos) return 0;
  const nowMs = new Date(now).getTime();
  const at = new Date(nowMs).toISOString();
  let recorded = 0;
  for (const video of videos || []) {
    const id = videoKey(video);
    const views = viewsOf(video);
    const src = countSource(video);
    if (!id || views === null || !src) continue;
    const row = (store.videos[id] = store.videos[id] || { observations: [] });
    if (!Array.isArray(row.observations)) row.observations = [];
    if (Number.isFinite(Date.parse(video.publishedAt || ''))) row.publishedAt = video.publishedAt;
    if (!video.trackedOnly || !row.lastSourcedAt) row.lastSourcedAt = at;
    const last = row.observations[row.observations.length - 1];
    if (last && nowMs - Date.parse(last.at) < MIN_OBSERVATION_GAP_HOURS * HOUR_MS) continue;
    row.observations.push({ at, views, src });
    recorded += 1;
  }
  prune(store, nowMs);
  return recorded;
}

// Ids a recent run surfaced, newest first, for the next run to re-read.
function trackedIds(store, now = new Date(), limit = MAX_TRACKED) {
  if (!store || !store.videos) return [];
  const nowMs = new Date(now).getTime();
  return Object.entries(store.videos)
    .map(([id, row]) => ({ id, sourced: Date.parse((row && row.lastSourcedAt) || '') }))
    .filter((row) => Number.isFinite(row.sourced) && nowMs - row.sourced <= TRACK_DAYS * 24 * HOUR_MS)
    .sort((a, b) => b.sourced - a.sourced || (a.id < b.id ? -1 : 1))
    .slice(0, limit)
    .map((row) => row.id);
}

// The stored pair a gain is measured from: the newest count (this run's) and
// the same counter's count nearest to a day before it.
function measuredPair(store, id, nowMs) {
  const observations = observationsOf(store, id)
    .map((obs) => ({ ms: Date.parse(obs && obs.at), views: Number(obs && obs.views), src: obs && obs.src }))
    .filter((obs) => Number.isFinite(obs.ms) && Number.isFinite(obs.views) && obs.ms <= nowMs);
  if (observations.length < 2) return null;
  const current = observations.reduce((a, b) => (b.ms > a.ms ? b : a));
  if (nowMs - current.ms > MAX_CURRENT_AGE_HOURS * HOUR_MS) return null;
  let baseline = null;
  for (const obs of observations) {
    if (obs === current || obs.src !== current.src) continue;
    const hours = (current.ms - obs.ms) / HOUR_MS;
    if (hours < MIN_BASELINE_HOURS || hours > MAX_BASELINE_HOURS) continue;
    if (!baseline || Math.abs(hours - 24) < Math.abs((current.ms - baseline.ms) / HOUR_MS - 24)) baseline = obs;
  }
  return baseline ? { current, baseline, hours: (current.ms - baseline.ms) / HOUR_MS } : null;
}

function roundHours(hours) {
  return Math.round(hours * 10) / 10;
}

/**
 * Views a video gained in the last 24 hours, with how the number was reached:
 *   new       published within 24 hours, so its whole count is the gain
 *   measured  this run's stored count minus the count from 22 to 26 hours earlier
 *   scaled    the same subtraction over a 12 to 60 hour gap, scaled to 24 hours;
 *             an estimate, and labeled as one
 *   estimated lifetime average, only for a video under a week old that has no
 *             earlier count yet (its first run)
 *   unmeasured  no way to tell; ranks last
 */
function viewsLast24h(video, store, now = new Date()) {
  const nowMs = new Date(now).getTime();
  const views = viewsOf(video);
  const published = Date.parse((video && video.publishedAt) || '');
  const ageHours = Number.isFinite(published) ? (nowMs - published) / HOUR_MS : null;
  if (views !== null && ageHours !== null && ageHours >= 0 && ageHours <= 24) {
    return { views24h: Math.round(views), basis: 'new', hours: roundHours(ageHours) };
  }
  const pair = measuredPair(store, videoKey(video), nowMs);
  if (pair) {
    // YouTube audits can lower a count; a drop is no gain, never a negative one.
    const gained = Math.max(0, pair.current.views - pair.baseline.views);
    const exact = pair.hours >= MEASURED_MIN_HOURS && pair.hours <= MEASURED_MAX_HOURS;
    return {
      views24h: Math.round((gained / pair.hours) * 24),
      basis: exact ? 'measured' : 'scaled',
      hours: roundHours(pair.hours),
    };
  }
  if (views !== null && ageHours !== null && ageHours > 24 && ageHours <= ESTIMATE_MAX_AGE_DAYS * 24) {
    return { views24h: Math.round(views / (ageHours / 24)), basis: 'estimated', hours: null };
  }
  return { views24h: 0, basis: 'unmeasured', hours: null };
}

// Most views in the last 24 hours first. Ties fall back to total views.
function rankByViews24h(videos, store, now = new Date()) {
  return (videos || [])
    .map((video) => {
      const measure = viewsLast24h(video, store, now);
      return {
        ...video,
        views24h: measure.views24h,
        views_24h: measure.views24h,
        views24hBasis: measure.basis,
        views24hHours: measure.hours,
      };
    })
    .sort((a, b) => b.views24h - a.views24h || Number(b.views || 0) - Number(a.views || 0));
}

function basisCounts(videos) {
  const counts = { new: 0, measured: 0, scaled: 0, estimated: 0, unmeasured: 0 };
  for (const video of videos || []) {
    const basis = video && video.views24hBasis;
    if (Object.prototype.hasOwnProperty.call(counts, basis)) counts[basis] += 1;
  }
  return counts;
}

function wholeNumber(value) {
  return Math.round(Number(value) || 0).toLocaleString('en-US');
}

// One short clause for the card (it leads a 140-character line), without a
// closing period. Empty when the gain is unmeasured, so no number is invented.
function describeViews24h(video) {
  const basis = video && video.views24hBasis;
  const n = wholeNumber(video && video.views24h);
  if (basis === 'measured') return `${n} views in the last 24 hours`;
  if (basis === 'new') {
    const hours = Math.max(1, Math.round(Number(video.views24hHours) || 0));
    return `${n} views in its first ${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  }
  if (basis === 'scaled') {
    return `About ${n} views a day over the last ${Math.round(Number(video.views24hHours) || 0)} hours (estimate)`;
  }
  if (basis === 'estimated') return `About ${n} views a day so far (estimate)`;
  return '';
}

module.exports = {
  MIN_BASELINE_HOURS,
  MAX_BASELINE_HOURS,
  MEASURED_MIN_HOURS,
  MEASURED_MAX_HOURS,
  MIN_OBSERVATION_GAP_HOURS,
  KEEP_OBSERVATION_DAYS,
  TRACK_DAYS,
  MAX_TRACKED,
  ESTIMATE_MAX_AGE_DAYS,
  emptyStore,
  loadStore,
  saveStore,
  countSource,
  recordObservations,
  trackedIds,
  viewsLast24h,
  rankByViews24h,
  basisCounts,
  describeViews24h,
};
