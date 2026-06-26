#!/usr/bin/env node
// skill-metrics-rollup.js
//
// Rolls up per-skill quality metrics from existing SecondBrain artifacts
// and writes them to data/agent/latest-skill-metrics.json in the shape
// check-harness-regressions.js expects:
//
//   { "video-aurora": { "quality": 87, ... }, "captions-aurora": {...}, ... }
//
// Each skill defines what "quality" means for its own artifact type:
//
//   video-aurora       publishedCount24h, rejectionsCount24h, approvalRate
//                      quality = 100 * approvalRate adjusted for volume
//   captions-aurora    rides video-aurora artifacts, captionsRejections24h
//   thumbnail-aurora   thumbCount24h, thumbRejections24h
//   daily-briefing     briefingExists, blockersCount, redChecksCount
//   daily-linkedin-scan scanSuccess, contactsScraped
//
// Run as a script or import as a library.

const fs = require('fs');
const path = require('path');

const REPO = process.env.SECONDBRAIN_ROOT || path.join(__dirname, '..');

const PRIORITY_SKILLS = [
  'video-aurora',
  'captions-aurora',
  'thumbnail-aurora',
  'daily-briefing',
  'daily-linkedin-scan',
];

function todayStr() { return new Date().toISOString().slice(0, 10); }

function listFiles(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

function statSafe(p) {
  try { return fs.statSync(p); } catch { return null; }
}

function withinHours(mtimeMs, hours) {
  return Date.now() - mtimeMs <= hours * 3600 * 1000;
}

function countMatchingFiles(dir, predicate, hours) {
  const files = listFiles(dir);
  let n = 0;
  for (const name of files) {
    if (!predicate(name)) continue;
    const st = statSafe(path.join(dir, name));
    if (!st) continue;
    if (hours == null || withinHours(st.mtimeMs, hours)) n++;
  }
  return n;
}

function readJsonlLines(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function countRecentJsonlEntries(filePath, hours, predicate) {
  const entries = readJsonlLines(filePath);
  let n = 0;
  for (const e of entries) {
    if (predicate && !predicate(e)) continue;
    const t = e.timestamp || e.date || e.time;
    if (!t) {
      if (hours == null) n++;
      continue;
    }
    const ms = new Date(t).getTime();
    if (isNaN(ms)) continue;
    if (hours == null || Date.now() - ms <= hours * 3600 * 1000) n++;
  }
  return n;
}

function clamp01(x) { return Math.max(0, Math.min(1, x)); }
function pct(x) { return Math.round(clamp01(x) * 100); }

function rollupVideoAurora() {
  const publishedDir = path.join(REPO, 'content-review', 'published');
  const rejFile = path.join(REPO, 'content-review', 'rejections.jsonl');
  const publishedCount24h = countMatchingFiles(publishedDir, n => n.endsWith('.mp4'), 24);
  const rejectionsCount24h = countRecentJsonlEntries(rejFile, 24);
  const totalSignal = publishedCount24h + rejectionsCount24h;
  const approvalRate = totalSignal > 0 ? publishedCount24h / totalSignal : 1.0;
  const volumeFactor = totalSignal === 0 ? 0.6 : clamp01(totalSignal / 4); // need >=4 signals to fully express
  const quality = pct(approvalRate * (0.5 + 0.5 * volumeFactor));
  // No published and no rejected content in the window means we have nothing to
  // judge -- the quality number is a synthesized floor, not a measurement.
  const insufficientData = totalSignal === 0;
  return { publishedCount24h, rejectionsCount24h, approvalRate, quality, insufficientData };
}

function rollupCaptionsAurora() {
  // Captions ride video artifacts. Quality is video approval rate plus a
  // caption-specific penalty for rejections that mention captions.
  const video = rollupVideoAurora();
  const rejFile = path.join(REPO, 'content-review', 'rejections.jsonl');
  const captionsRejections24h = countRecentJsonlEntries(rejFile, 24, e => {
    const r = (e.reason || e.detail || '').toLowerCase();
    return r.includes('caption') || r.includes('subtitle');
  });
  const penalty = captionsRejections24h * 8;
  const quality = Math.max(0, video.quality - penalty);
  // Captions ride the same artifacts as video; if video had no signal, neither do we.
  return { publishedCount24h: video.publishedCount24h, captionsRejections24h, quality, insufficientData: video.insufficientData };
}

function rollupThumbnailAurora() {
  const publishedDir = path.join(REPO, 'content-review', 'published');
  const rejFile = path.join(REPO, 'content-review', 'rejections.jsonl');
  const thumbCount24h = countMatchingFiles(publishedDir, n => n.endsWith('_thumb.jpg'), 24);
  const thumbRejections24h = countRecentJsonlEntries(rejFile, 24, e => {
    const r = (e.reason || e.detail || '').toLowerCase();
    return r.includes('thumb');
  });
  // Thumbnails ride video output. If videos published but produced no thumbnails,
  // that is the broken state we must catch -- not absence of data.
  const videoCount24h = countMatchingFiles(publishedDir, n => n.endsWith('.mp4'), 24);
  const volume = clamp01(thumbCount24h / 4);
  const penalty = thumbRejections24h * 10;
  const quality = Math.max(0, Math.round(60 + 40 * volume - penalty));
  const insufficientData = thumbCount24h === 0 && thumbRejections24h === 0 && videoCount24h === 0;
  return { thumbCount24h, thumbRejections24h, videoCount24h, quality, insufficientData };
}

function rollupDailyBriefing() {
  const today = todayStr();
  const briefingFile = path.join(REPO, 'data', 'briefings', `briefing-${today}.md`);
  const briefingExists = fs.existsSync(briefingFile) ? 1 : 0;
  if (!briefingExists) {
    // No briefing generated yet (e.g. checker runs at night before the 05:30
    // send). Absence of a briefing is not a quality regression.
    return { briefingExists: 0, blockersCount: 0, redChecksCount: 0, quality: 0, insufficientData: true };
  }
  const body = fs.readFileSync(briefingFile, 'utf8');
  const blockersMatch = body.match(/BLOCKERS\s*\/\s*NEEDS\s*FROM\s*ExampleCo:?([\s\S]*?)(?:\n\s*---|\n\s*\n\s*[A-Z][A-Z]+)/i);
  let blockersCount = 0;
  if (blockersMatch) {
    const section = blockersMatch[1];
    const items = section.split('\n').filter(line => /^\s*\d+\.\s+\S/.test(line));
    blockersCount = items.length;
  }
  const diagnosticFile = path.join(REPO, 'data', 'agent', `pre-briefing-diagnostic-${today}.json`);
  let redChecksCount = 0;
  if (fs.existsSync(diagnosticFile)) {
    try {
      const diag = JSON.parse(fs.readFileSync(diagnosticFile, 'utf8'));
      const checks = (diag && diag.checks) || {};
      for (const v of Object.values(checks)) {
        if (v && v.status === 'red') redChecksCount++;
      }
    } catch {}
  }
  // Quality: starts at 100, -10 per blocker, -8 per red check
  const quality = Math.max(0, Math.min(100, 100 - blockersCount * 10 - redChecksCount * 8));
  return { briefingExists, blockersCount, redChecksCount, quality, insufficientData: false };
}

function rollupDailyLinkedinScan() {
  const summaryFile = path.join(REPO, 'data', 'agent', 'linkedin-scan-summary.json');
  if (!fs.existsSync(summaryFile)) {
    // No summary file at all -- the scan has not produced data we can judge.
    return { scanSuccess: 0, contactsScraped: 0, quality: 20, insufficientData: true };
  }
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
  } catch {
    // Corrupt summary written recently means a run happened and broke -- that is
    // a failure signal, not absence of data. Only a stale corrupt file is insufficient.
    const st = statSafe(summaryFile);
    const recentWrite = !!st && withinHours(st.mtimeMs, 48);
    return { scanSuccess: 0, contactsScraped: 0, quality: 20, insufficientData: !recentWrite };
  }
  const lastRunAt = data.lastRunAt ? new Date(data.lastRunAt).getTime() : 0;
  const recent = lastRunAt > 0 && Date.now() - lastRunAt <= 48 * 3600 * 1000;
  const scanSuccess = recent && data.success ? 1 : 0;
  const contactsScraped = Number(data.contactsScraped || 0);
  const volumeFactor = clamp01(contactsScraped / 100);
  const quality = scanSuccess ? Math.round(50 + 50 * volumeFactor) : 20;
  // A scan that ran within 48h is real signal even if it failed; only a stale or
  // absent run counts as insufficient data.
  const insufficientData = !recent;
  return { scanSuccess, contactsScraped, quality, insufficientData };
}

const ROLLUPS = {
  'video-aurora': rollupVideoAurora,
  'captions-aurora': rollupCaptionsAurora,
  'thumbnail-aurora': rollupThumbnailAurora,
  'daily-briefing': rollupDailyBriefing,
  'daily-linkedin-scan': rollupDailyLinkedinScan,
};

function rollupAll() {
  const out = {};
  for (const skill of PRIORITY_SKILLS) {
    try {
      out[skill] = ROLLUPS[skill]();
    } catch (err) {
      out[skill] = { quality: 0, error: err.message };
    }
  }
  return out;
}

function metricsFilePath() {
  return path.join(REPO, 'data', 'agent', 'latest-skill-metrics.json');
}

function writeMetricsFile() {
  const data = rollupAll();
  data._generatedAt = new Date().toISOString();
  const file = metricsFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

module.exports = {
  rollupAll,
  writeMetricsFile,
  metricsFilePath,
  PRIORITY_SKILLS,
  rollupVideoAurora,
  rollupCaptionsAurora,
  rollupThumbnailAurora,
  rollupDailyBriefing,
  rollupDailyLinkedinScan,
};

if (require.main === module) {
  const file = writeMetricsFile();
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log(JSON.stringify(data, null, 2));
}
