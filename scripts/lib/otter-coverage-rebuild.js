'use strict';

/**
 * Shared staleness-aware rebuild for the three Otter coverage artifacts
 * (call-completeness, text-audio-coverage, call-speaker-rosters) that back
 * the System Health "Otter speaker enrichment" row.
 *
 * WHY: the audio backfill cron (ec2-otter-audio-backfill.sh) and the Otter
 * ingest watcher advance disk truth (new audio files, new enriched calls)
 * every 30 minutes / 2 minutes, but NOTHING re-ran these three report
 * builders on that cadence. Only two callers ever rebuilt them at all:
 * refresh-briefing-generated-sections.js's --voice-only branch and its
 * default (full) branch -- both invoked from ExampleCo's PC, once at most per
 * scheduled pass. The REAL 5:30 AM cloud path (ec2-morning-briefing-run.sh ->
 * cloud-morning-briefing.js --publish) never called any of the three
 * builders; it only ever READ whatever the three JSON files already held on
 * disk. Result: the System Health row could show "audio 0% last 7d" and a
 * multi-day speaker-freshness lag for hours even though the underlying audio
 * and enrichment were already caught up, because nothing had told the
 * coverage/roster artifacts to catch up too. ExampleCo 2026-07-05
 * otter-metric-mismatch #gap (Codex adversarial review of 1f1ea1fc).
 *
 * This module gives every caller ONE staleness check + ONE rebuild path so
 * the cloud renderer (which has no other rebuild wiring) can self-heal
 * inline before it reads the artifacts, without duplicating the logic that
 * refresh-briefing-generated-sections.js already runs on its own passes.
 */

const fs = require('fs');
const path = require('path');

// Backfill/ingest cadence is 30 min / 2 min; a 20-minute freshness floor
// guarantees the coverage numbers are never more than one backfill cycle
// stale by the time System Health renders, while still cheap enough (each
// builder runs in single-digit seconds on the full EC2 corpus) to run inline
// on every briefing build without materially slowing it down.
const FRESHNESS_FLOOR_MINUTES = 20;

function minutesSinceIso(value) {
  const t = value ? Date.parse(value) : NaN;
  if (!Number.isFinite(t)) return Infinity;
  return Math.max(0, (Date.now() - t) / 60000);
}

function readJsonMaybe(absPath) {
  try {
    return JSON.parse(fs.readFileSync(absPath, 'utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

// Are the three coverage artifacts fresh enough to skip a rebuild? Any one
// of them missing, or older than the floor, counts as stale -- the artifacts
// are meant to be rebuilt together (they all key off the same enriched/
// audio-full directories) so a partial rebuild would leave them mutually
// inconsistent (e.g. rosters current but coverage stale).
function otterCoverageArtifactsAreStale(dataDir, opts = {}) {
  const floorMinutes = Number.isFinite(opts.floorMinutes)
    ? opts.floorMinutes
    : FRESHNESS_FLOOR_MINUTES;
  const vpDir = path.join(dataDir, 'life-archive', 'voiceprints');
  const files = [
    'otter-call-completeness-latest.json',
    'otter-text-audio-coverage-latest.json',
    'otter-call-speaker-rosters-latest.json',
  ];
  for (const file of files) {
    const json = readJsonMaybe(path.join(vpDir, file));
    if (!json) return true;
    const stamp = json.generated_at || json.roster_generated_at;
    if (minutesSinceIso(stamp) > floorMinutes) return true;
  }
  return false;
}

const BUILDER_MODULES = [
  '../otter-call-speaker-rosters.js',
  '../otter-call-completeness-report.js',
  '../otter-text-audio-coverage-report.js',
];

// Each builder resolves its own DATA_DIR ONCE, at module-load time
// (`const DATA_DIR = path.resolve(process.env.SECONDBRAIN_DATA_DIR || ...)`),
// not per call. If a builder module is already require()-cached (e.g. a
// future caller adds a top-level require of one of these files, or a test
// runner shares a process across cases with different data dirs), toggling
// process.env.SECONDBRAIN_DATA_DIR here would silently have NO EFFECT on the
// already-cached module -- it would keep rebuilding over whatever dataDir was
// live the FIRST time it was required in this process. Deleting these three
// modules' require-cache entries before each require forces a fresh module
// evaluation that captures the CURRENT env var, so this function is correct
// regardless of what else in the process has already required them.
function evictBuilderModuleCache() {
  for (const rel of BUILDER_MODULES) {
    try {
      delete require.cache[require.resolve(rel)];
    } catch {
      /* module not yet resolved/cached: nothing to evict */
    }
  }
}

// Rebuild the three artifacts in-process (each builder is a pure function
// over the enriched/audio-full/raw directories, no network calls -- safe and
// fast, ~5-15s each on the full EC2 corpus). Returns { rebuilt, error } so
// callers can surface a NAMED failure instead of silently keeping stale
// reads (Codex finding 3: silent swallow).
function rebuildOtterCoverageArtifacts(dataDir) {
  const prevDataDir = process.env.SECONDBRAIN_DATA_DIR;
  process.env.SECONDBRAIN_DATA_DIR = dataDir;
  try {
    evictBuilderModuleCache();
    // Rosters first: the coverage/completeness reports do not depend on the
    // roster file, but keeping a stable, explicit order makes a partial
    // failure easy to reason about (log names exactly which builder broke).
    const { buildCallRosters } = require('../otter-call-speaker-rosters.js');
    const { buildCallCompletenessReport } = require('../otter-call-completeness-report.js');
    const { buildTextAudioCoverageReport } = require('../otter-text-audio-coverage-report.js');
    buildCallRosters({ write: true });
    buildCallCompletenessReport({ write: true });
    buildTextAudioCoverageReport({ write: true });
    return { rebuilt: true, error: null };
  } catch (e) {
    return { rebuilt: false, error: String((e && e.message) || e).slice(0, 300) };
  } finally {
    // Evict again so the NEXT caller in this process (this function or
    // anyone else) re-resolves DATA_DIR fresh rather than inheriting this
    // call's dataDir after SECONDBRAIN_DATA_DIR is restored below.
    evictBuilderModuleCache();
    if (prevDataDir == null) delete process.env.SECONDBRAIN_DATA_DIR;
    else process.env.SECONDBRAIN_DATA_DIR = prevDataDir;
  }
}

// Rebuild only if stale. Returns null when the artifacts were already fresh
// (no-op), or { rebuilt, error } when a rebuild was attempted. Callers use a
// non-null return with error set to surface "stale, rebuild failed: <why>"
// instead of silently rendering old numbers.
function rebuildOtterCoverageArtifactsIfStale(dataDir, opts = {}) {
  if (!otterCoverageArtifactsAreStale(dataDir, opts)) return null;
  return rebuildOtterCoverageArtifacts(dataDir);
}

module.exports = {
  FRESHNESS_FLOOR_MINUTES,
  minutesSinceIso,
  otterCoverageArtifactsAreStale,
  rebuildOtterCoverageArtifacts,
  rebuildOtterCoverageArtifactsIfStale,
};
