'use strict';

/**
 * session-backup-grade.js (S-10, owner decision)
 *
 * The Codex and Claude Code session backup rows used to be graded from the PC
 * job's own freshness, so a slow, asleep or capped PC read red even when every
 * file was safe in S3. Now the PC publishes a manifest of the files it intends
 * to back up (scripts/life-archive-session-s3-sync.js) and EC2 grades the row
 * by comparing that manifest with what S3 actually holds:
 *
 *   green  every manifest file is in S3 at least as large as the PC saw it
 *   red    N files missing or short in S3 (names the oldest), the PC marked
 *          its scan or sync incomplete, or the manifest is older than 48h
 *          (the PC stopped reporting)
 *
 * A PC that is off for one night leaves a manifest under 48h old and S3
 * complete, so it stays green; a real gap turns red.
 *
 * gradeSessionBackup is pure. s3ListObjects and readManifest are the thin
 * aws-CLI adapters.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveRuntimeDataDir } = require('./scheduled-write-ownership.js');

const BUCKET = 'ExampleCo-secondbrain-backups';
const LIFE_ROOT = 'data-lake/secondbrain/life-archive';
const MANIFEST_KEY = `${LIFE_ROOT}/data/sessions/manifest/session-backup-manifest.json`;
const MANIFEST_MAX_AGE_MS = 48 * 60 * 60 * 1000;
// A grade older than this is not evidence; readers fall back to the PC-reported row.
const GRADE_MAX_AGE_MS = 36 * 60 * 60 * 1000;
const GRADE_REL = path.join('life-archive', 'session-backup-grade.json');

// Manifest source name -> life-archive health source id.
const HEALTH_ID = Object.freeze({ codex: 'codex_sessions', 'claude-code': 'claude_code_sessions' });

function dateOf(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : 'unknown date';
}

function stoppedReporting(ageMs, maxAgeMs) {
  const hours = Math.round((ageMs / 3600000) * 10) / 10;
  return `PC has stopped reporting: backup manifest is ${hours}h old (limit ${Math.round(maxAgeMs / 3600000)}h)`;
}

/**
 * @param manifest one manifest source: { generated_at, files: [[relativeKey, sizeBytes, mtimeMs]], incomplete? }.
 * @param s3Objects Map of key (relative to the source prefix) -> S3 object size, or null when the
 *   listing failed. An S3 object at least as large as the manifest size is backed up (a session that
 *   grew after the manifest was cut is not a gap); a smaller one means the latest upload failed.
 */
function gradeSessionBackup({ manifest, s3Objects, now = Date.now(), maxAgeMs = MANIFEST_MAX_AGE_MS } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const generatedMs = Date.parse(String((manifest && manifest.generated_at) || ''));
  if (!manifest || !Array.isArray(manifest.files) || !Number.isFinite(generatedMs)) {
    return { status: 'red', reason: 'no readable PC backup manifest', missing: null, manifestAgeHours: null };
  }
  const ageMs = nowMs - generatedMs;
  const manifestAgeHours = Math.round((ageMs / 3600000) * 10) / 10;
  const manifestGeneratedAt = new Date(generatedMs).toISOString();
  if (ageMs > maxAgeMs) {
    return { status: 'red', reason: stoppedReporting(ageMs, maxAgeMs), missing: null, manifestAgeHours, manifestGeneratedAt };
  }
  if (manifest.incomplete) {
    return {
      status: 'red',
      reason: `PC backup run incomplete, so its manifest cannot prove the backup: ${String(manifest.incomplete).slice(0, 300)}`,
      missing: null,
      manifestAgeHours,
      manifestGeneratedAt,
    };
  }
  if (!(s3Objects instanceof Map)) {
    return { status: 'red', reason: 'S3 listing failed, so the backup could not be verified', missing: null, manifestAgeHours, manifestGeneratedAt };
  }
  const backedUp = (f) => {
    const size = s3Objects.get(f[0]);
    return Number.isFinite(size) && size >= Number(f[1] || 0);
  };
  const missing = manifest.files.filter((f) => !backedUp(f));
  if (!missing.length) {
    return { status: 'green', reason: '', missing: 0, checked: manifest.files.length, manifestAgeHours, manifestGeneratedAt };
  }
  const short = missing.filter((f) => s3Objects.has(f[0])).length;
  const mt = (f) => (Number.isFinite(Number(f[2])) ? Number(f[2]) : Infinity);
  const oldest = missing.reduce((a, b) => (mt(b) < mt(a) ? b : a));
  return {
    status: 'red',
    reason: `${missing.length} of ${manifest.files.length} file(s) missing from S3${short ? ` (${short} present but smaller than on the PC)` : ''}; oldest missing: ${oldest[0]} (${dateOf(Number(oldest[2]))})`,
    missing: missing.length,
    checked: manifest.files.length,
    oldestMissing: oldest[0],
    manifestAgeHours,
    manifestGeneratedAt,
  };
}

/** Grade every source in a manifest. listObjects(prefix) returns a Map of key (relative to prefix) -> size, or null. */
function gradeManifest({ manifest, listObjects, now = Date.now(), maxAgeMs = MANIFEST_MAX_AGE_MS }) {
  const sources = {};
  for (const [name, healthId] of Object.entries(HEALTH_ID)) {
    const entry = manifest && manifest.sources && manifest.sources[name];
    const merged = entry ? { ...entry, generated_at: entry.generated_at || manifest.generated_at } : null;
    const objects = merged && Array.isArray(merged.files) && merged.prefix && !merged.incomplete ? listObjects(merged.prefix) : null;
    sources[healthId] = gradeSessionBackup({ manifest: merged, s3Objects: objects, now, maxAgeMs });
  }
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  return {
    graded_at: new Date(nowMs).toISOString(),
    manifest_generated_at: (manifest && manifest.generated_at) || null,
    sources,
  };
}

/** aws-CLI adapter: Map of every key under `prefix/` (relative to it) -> size in bytes. Null on any failure. */
function s3ListObjects(prefix, { bucket = BUCKET, run = spawnSync } = {}) {
  const res = run('aws', [
    's3api', 'list-objects-v2', '--bucket', bucket, '--prefix', `${prefix}/`,
    '--query', 'Contents[].[Key,Size]', '--output', 'json',
  ], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, timeout: 15 * 60 * 1000, windowsHide: true });
  if (res.error || res.status !== 0) return null;
  let rows;
  try { rows = JSON.parse(String(res.stdout || 'null')); } catch { return null; }
  if (rows === null) return new Map();
  if (!Array.isArray(rows)) return null;
  const cut = prefix.length + 1;
  const out = new Map();
  for (const row of rows) {
    if (!Array.isArray(row) || typeof row[0] !== 'string' || !Number.isFinite(Number(row[1]))) return null;
    out.set(row[0].slice(cut), Number(row[1]));
  }
  return out;
}

/** aws-CLI adapter: the published manifest object, or null. */
function readManifest({ bucket = BUCKET, run = spawnSync } = {}) {
  const res = run('aws', ['s3', 'cp', `s3://${bucket}/${MANIFEST_KEY}`, '-', '--only-show-errors'],
    { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, windowsHide: true });
  if (res.error || res.status !== 0) return null;
  try { return JSON.parse(res.stdout); } catch { return null; }
}

/**
 * PC side: manifest of the sources sync uploads.
 * entries: [{name, prefix, files:[[rel,size,mtimeMs]], incomplete?}]; incomplete (a reason) means the
 * scan or sync failed, so the grader reads that source red instead of trusting a partial file list.
 */
function buildManifest(entries, generatedAt = new Date()) {
  const iso = generatedAt.toISOString();
  const sources = {};
  for (const e of entries) {
    sources[e.name] = {
      prefix: e.prefix,
      generated_at: iso,
      files: e.files,
      ...(e.incomplete ? { incomplete: String(e.incomplete) } : {}),
    };
  }
  return { version: 1, generated_at: iso, sources };
}

// One data-dir rule for the writer (EC2 grader) and every reader: an explicit
// dir wins, else the same runtime data dir the rest of the system resolves.
function gradeFilePath(dataDir) {
  return path.join(dataDir || resolveRuntimeDataDir(), GRADE_REL);
}

/** Write the grade atomically (tmp + rename) so a reader never sees half a file. */
function writeGradeFile(grade, dataDir, { write = fs.writeFileSync, rename = fs.renameSync, mkdir = fs.mkdirSync } = {}) {
  const out = gradeFilePath(dataDir);
  mkdir(path.dirname(out), { recursive: true });
  const tmp = `${out}.${process.pid}.tmp`;
  write(tmp, JSON.stringify(grade, null, 2));
  rename(tmp, out);
  return out;
}

/**
 * Grade for one health source id from the EC2-written grade file, or null if
 * absent, unknown or older than GRADE_MAX_AGE_MS (no evidence either way).
 * Green also expires once the manifest it graded passes its own 48h limit,
 * and then reads red exactly as the grader would have.
 */
function loadSessionGrade(sourceId, { dataDir, now = Date.now(), readFile = fs.readFileSync } = {}) {
  if (!Object.values(HEALTH_ID).includes(sourceId)) return null;
  try {
    const grade = JSON.parse(readFile(gradeFilePath(dataDir), 'utf8'));
    const gradedMs = Date.parse(grade.graded_at);
    const nowMs = now instanceof Date ? now.getTime() : Number(now);
    if (!Number.isFinite(gradedMs) || nowMs - gradedMs > GRADE_MAX_AGE_MS) return null;
    const entry = (grade.sources && grade.sources[sourceId]) || null;
    if (!entry || entry.status !== 'green') return entry;
    const manifestMs = Date.parse(String(entry.manifestGeneratedAt || ''));
    if (!Number.isFinite(manifestMs)) return null;
    if (nowMs - manifestMs > MANIFEST_MAX_AGE_MS) {
      return { ...entry, status: 'red', reason: stoppedReporting(nowMs - manifestMs, MANIFEST_MAX_AGE_MS) };
    }
    return entry;
  } catch {
    return null;
  }
}

module.exports = {
  BUCKET, LIFE_ROOT, MANIFEST_KEY, MANIFEST_MAX_AGE_MS, GRADE_MAX_AGE_MS, HEALTH_ID,
  gradeSessionBackup, gradeManifest, s3ListObjects, readManifest, buildManifest, gradeFilePath, writeGradeFile, loadSessionGrade,
};
