'use strict';

const fs = require('node:fs');
const path = require('node:path');

const NIGHTLY_SKILL = 'secondbrain-nightly-enhancement';
const VIDEO_RESEARCH_SKILL = 'video-quality-research';
const NIGHTLY_FILES = Object.freeze([
  'agent/feature-backlog.json',
  'agent/feature-backlog-archive.jsonl',
  'agent/backlog-research-receipt.json',
  'agent/nightly-enhancements.jsonl',
]);
const VIDEO_RESEARCH_FILES = Object.freeze([
  'agent/video-quality-research/<date>.json',
]);
const RUNTIME_FILES_BY_SKILL = Object.freeze({
  [NIGHTLY_SKILL]: NIGHTLY_FILES,
  'amy-research-skill': Object.freeze(['agent/amy-research-runs.jsonl']),
  [VIDEO_RESEARCH_SKILL]: VIDEO_RESEARCH_FILES,
});

const STAGING_RELATIVE_ROOT = path.join('staging', 'scheduled-skills');
const STAGE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const STAGE_MAX_RETAINED = 20;

function runtimeArtifactSkill(skillName) {
  return Boolean(RUNTIME_FILES_BY_SKILL[String(skillName || '')]);
}

function runtimeFilesForSkill(skillName, scheduleDate) {
  const files = RUNTIME_FILES_BY_SKILL[String(skillName || '')] || [];
  const date = String(scheduleDate || '').slice(0, 10);
  return files.map((relative) =>
    relative.includes('<date>') && /^\d{4}-\d{2}-\d{2}$/.test(date)
      ? relative.replaceAll('<date>', date)
      : relative,
  );
}

function requireResolvedRuntimeFiles(skillName, scheduleDate) {
  const files = runtimeFilesForSkill(skillName, scheduleDate);
  if (files.some((relative) => relative.includes('<date>'))) {
    throw new Error(`runtime artifact schedule date is required for ${skillName}`);
  }
  return files;
}

function copyIfPresent(source, target, { forbiddenRoot } = {}) {
  if (!fs.existsSync(source)) return false;
  if (forbiddenRoot) {
    const liveRoot = realPathIfPresent(forbiddenRoot);
    const sourceReal = realPathIfPresent(source);
    if (liveRoot && sourceReal && isWithinPath(liveRoot, sourceReal)) return false;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  return true;
}

function realPathIfPresent(value) {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return null;
  }
}

function isWithinPath(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function pruneRuntimeArtifactStages({
  runtimeDataDir,
  nowMs = Date.now(),
  maxAgeMs = STAGE_MAX_AGE_MS,
  maxRetained = STAGE_MAX_RETAINED,
} = {}) {
  const root = path.resolve(runtimeDataDir || '', STAGING_RELATIVE_ROOT);
  if (!runtimeDataDir || !fs.existsSync(root)) return { ok: true, removed: [] };
  const directories = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const full = path.join(root, entry.name);
      return { full, mtimeMs: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  const removed = [];
  directories.forEach((entry, index) => {
    if (index < maxRetained && nowMs - entry.mtimeMs <= maxAgeMs) return;
    fs.rmSync(entry.full, { recursive: true, force: true });
    removed.push(entry.full);
  });
  return { ok: true, removed };
}

function prepareRuntimeArtifacts({ skillName, runtimeDataDir, runId, scheduleDate } = {}) {
  if (!runtimeArtifactSkill(skillName)) {
    return { dataDir: runtimeDataDir, files: [] };
  }
  pruneRuntimeArtifactStages({ runtimeDataDir });
  const safeSkill = String(skillName || 'unknown').replace(/[^A-Za-z0-9._-]+/g, '-');
  const safeRun = String(runId || `${Date.now()}-${process.pid}`).replace(
    /[^A-Za-z0-9._-]+/g,
    '-',
  );
  const dataDir = path.join(runtimeDataDir, STAGING_RELATIVE_ROOT, `${safeSkill}-${safeRun}`);
  const ownedFiles = requireResolvedRuntimeFiles(skillName, scheduleDate);
  const files = [];
  for (const relative of ownedFiles) {
    if (copyIfPresent(path.join(runtimeDataDir, relative), path.join(dataDir, relative))) {
      files.push(relative);
    }
  }
  for (const relative of ownedFiles.filter((file) => file.endsWith('.jsonl'))) {
    const target = path.join(dataDir, relative);
    if (!fs.existsSync(target)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, '');
    }
  }
  fs.mkdirSync(path.join(dataDir, 'agent'), { recursive: true });
  return { dataDir, files };
}

function cleanupRuntimeArtifactsStage({ stagingDataDir, runtimeDataDir } = {}) {
  const stage = path.resolve(stagingDataDir || '');
  const root = path.resolve(runtimeDataDir || '', STAGING_RELATIVE_ROOT);
  const relative = path.relative(root, stage);
  if (!stagingDataDir || !runtimeDataDir || !relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`refusing unsafe runtime stage cleanup: ${stage}`);
  }
  fs.rmSync(stage, { recursive: true, force: true });
  return { ok: true, removed: stage };
}

function readJson(file, label, failures) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    failures.push(label + ' is missing or invalid JSON: ' + error.message);
    return null;
  }
}

function jsonlRows(file, label, failures) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    failures.push(label + ' is missing or invalid JSONL: ' + error.message);
    return [];
  }
}

function validateNightlyArtifacts(stagingDataDir, { scheduleDate } = {}) {
  const failures = [];
  const agentDir = path.join(stagingDataDir, 'agent');
  const backlog = readJson(
    path.join(agentDir, 'feature-backlog.json'),
    'feature backlog',
    failures,
  );
  const receipt = readJson(
    path.join(agentDir, 'backlog-research-receipt.json'),
    'backlog research receipt',
    failures,
  );
  const nightlyRows = jsonlRows(
    path.join(agentDir, 'nightly-enhancements.jsonl'),
    'nightly enhancement log',
    failures,
  );
  const features = Array.isArray(backlog?.features) ? backlog.features : [];
  const researchCount = features.reduce(
    (sum, feature) =>
      sum +
      (Array.isArray(feature?.research_confirmations)
        ? feature.research_confirmations.length
        : 0),
    0,
  );
  if (!features.length) failures.push('feature backlog has no ranked features');
  if (!researchCount) failures.push('feature backlog has no overnight research confirmations');
  if (Array.isArray(backlog?.items) && backlog.items.length && !features.length) {
    failures.push('feature backlog is raw-dispatch-only');
  }
  if (receipt?.schema !== 'backlog-research-receipt@1') {
    failures.push('backlog research receipt schema is not backlog-research-receipt@1');
  }
  if (Number(receipt?.scoredAskCount || 0) < 1) {
    failures.push('backlog research receipt has no scored asks');
  }
  const expectedDate = String(scheduleDate || '').slice(0, 10);
  if (expectedDate) {
    if (String(receipt?.date || '').slice(0, 10) !== expectedDate) {
      failures.push('backlog research receipt is not for ' + expectedDate);
    }
    const hasCurrentLog = nightlyRows.some((row) => {
      const stamp = row?.timestamp || row?.ts || row?.date || '';
      return String(stamp).slice(0, 10) === expectedDate;
    });
    if (!hasCurrentLog) {
      failures.push('nightly enhancement log has no ' + expectedDate + ' result');
    }
  }
  return { ok: failures.length === 0, failures, researchCount, featureCount: features.length };
}

function validateGenericRuntimeArtifacts(
  stagingDataDir,
  ownedFiles,
  { skillName, scheduleDate } = {},
) {
  const failures = [];
  for (const relative of ownedFiles) {
    const file = path.join(stagingDataDir, relative);
    if (!fs.existsSync(file)) {
      failures.push(`runtime output is missing: ${relative}`);
      continue;
    }
    const resolvedStage = realPathIfPresent(stagingDataDir);
    const resolvedFile = realPathIfPresent(file);
    if (!resolvedStage || !resolvedFile || !isWithinPath(resolvedStage, resolvedFile)) {
      failures.push(`runtime output escapes staging root: ${relative}`);
      continue;
    }
    if (relative.endsWith('.jsonl')) {
      const rows = jsonlRows(file, relative, failures);
      if (!rows.length) failures.push(`runtime output has no rows: ${relative}`);
    } else if (skillName === VIDEO_RESEARCH_SKILL) {
      const report = readJson(file, relative, failures);
      if (report) {
        const expectedDate = String(scheduleDate || '').slice(0, 10);
        if (String(report.date || '').slice(0, 10) !== expectedDate) {
          failures.push(`${relative} does not carry schedule date ${expectedDate}`);
        }
        if (!String(report.sourceSha || '').trim()) {
          failures.push(`${relative} has no sourceSha`);
        }
        if (!String(report.status || '').trim()) {
          failures.push(`${relative} has no status`);
        }
        if (!Array.isArray(report.findings)) failures.push(`${relative} has no findings array`);
        if (!Array.isArray(report.evidencePaths)) {
          failures.push(`${relative} has no evidencePaths array`);
        }
      }
    }
  }
  return { ok: failures.length === 0, failures };
}

// A model given SECONDBRAIN_DATA_DIR=<stage> can still read the skill's
// repo-relative `data/agent/...` path literally and write <stage>/data/agent/...
// (2026-09-26 video-quality-research). Recover only the exact owned files from
// that nested root or the proven isolated worktree; semantic validation reruns.
function recoveryDataDirs(stagingDataDir, fallbackDataDir, runtimeDataDir) {
  const dirs = [];
  if (fallbackDataDir) dirs.push(fallbackDataDir);
  if (stagingDataDir) dirs.push(path.join(stagingDataDir, 'data'));
  const liveRoot = runtimeDataDir ? path.resolve(runtimeDataDir) : '';
  let liveIdentity = null;
  try {
    liveIdentity = liveRoot ? fs.realpathSync.native(liveRoot) : null;
  } catch {
    liveIdentity = null;
  }
  return dirs.filter((dir) => {
    if (!liveRoot) return true;
    if (path.resolve(dir) === liveRoot) return false;
    if (!liveIdentity) return true;
    try {
      return fs.realpathSync.native(dir) !== liveIdentity;
    } catch {
      return true;
    }
  });
}

function recoverOwnedFiles(stagingDataDir, fallbackDataDir, ownedFiles, runtimeDataDir) {
  for (const relative of ownedFiles) {
    const target = path.join(stagingDataDir, relative);
    for (const dir of recoveryDataDirs(stagingDataDir, fallbackDataDir, runtimeDataDir)) {
      if (copyIfPresent(path.join(dir, relative), target, { forbiddenRoot: runtimeDataDir })) break;
    }
  }
}

function writeAtomic(target, content) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = target + '.' + process.pid + '.' + Date.now() + '.tmp';
  fs.writeFileSync(temp, content);
  fs.renameSync(temp, target);
}

function mergeJsonl(source, target) {
  const sourceLines = fs.existsSync(source)
    ? fs.readFileSync(source, 'utf8').split(/\r?\n/).filter(Boolean)
    : [];
  const targetLines = fs.existsSync(target)
    ? fs.readFileSync(target, 'utf8').split(/\r?\n/).filter(Boolean)
    : [];
  const merged = [...new Set([...targetLines, ...sourceLines])];
  writeAtomic(target, merged.length ? merged.join('\n') + '\n' : '');
}

function publishRuntimeArtifacts({
  skillName,
  stagingDataDir,
  runtimeDataDir,
  scheduleDate,
  fallbackDataDir,
} = {}) {
  if (!runtimeArtifactSkill(skillName)) {
    return { ok: true, files: [], failures: [] };
  }
  const ownedFiles = requireResolvedRuntimeFiles(skillName, scheduleDate);
  let validation =
    skillName === NIGHTLY_SKILL
      ? validateNightlyArtifacts(stagingDataDir, { scheduleDate })
      : validateGenericRuntimeArtifacts(stagingDataDir, ownedFiles, { skillName, scheduleDate });
  // Codex workers can be sandboxed away from the runtime-owned staging root.
  // Their proven isolated worktree is writable, so skills mirror owned runtime
  // outputs into data/agent there. Recover that exact set before declaring the
  // producer incomplete, then run the same semantic validation again.
  if (!validation.ok) {
    recoverOwnedFiles(stagingDataDir, fallbackDataDir, ownedFiles, runtimeDataDir);
    validation =
      skillName === NIGHTLY_SKILL
        ? validateNightlyArtifacts(stagingDataDir, { scheduleDate })
        : validateGenericRuntimeArtifacts(stagingDataDir, ownedFiles, { skillName, scheduleDate });
  }
  if (!validation.ok) return { ...validation, files: [] };

  const liveReceipt = skillName === NIGHTLY_SKILL
    ? readJson(path.join(runtimeDataDir, 'agent/backlog-research-receipt.json'), 'live receipt', []) : null;
  const stagedReceipt = skillName === NIGHTLY_SKILL
    ? readJson(path.join(stagingDataDir, 'agent/backlog-research-receipt.json'), 'staged receipt', []) : null;
  const newerLive = Date.parse(liveReceipt?.ranAt) > Date.parse(stagedReceipt?.ranAt) ||
    (/^\d{4}-\d{2}-\d{2}$/.test(liveReceipt?.date) && liveReceipt.date > String(stagedReceipt?.date || ''));
  const preserveNewer = newerLive && (historicalNightlySuccess({ stagingDataDir, runtimeDataDir, scheduleDate }) ||
    nightlyLiveReceiptSupersedesStage({ stagingDataDir, runtimeDataDir, scheduleDate }));
  if (newerLive && !preserveNewer) return { ok: false, files: [], failures: ['newer live backlog receipt cannot be overwritten'] };

  const files = [];
  for (const relative of ownedFiles) {
    const source = path.join(stagingDataDir, relative);
    const target = path.join(runtimeDataDir, relative);
    if (relative.endsWith('.jsonl')) mergeJsonl(source, target);
    else if (!preserveNewer) writeAtomic(target, fs.readFileSync(source));
    files.push(relative);
  }
  return { ...validation, files };
}

function recoverRuntimeArtifactsStage({
  skillName,
  stagingDataDir,
  fallbackDataDir,
  runtimeDataDir,
  scheduleDate,
} = {}) {
  if (!runtimeArtifactSkill(skillName) || !stagingDataDir) {
    return { ok: true, recovered: false, failures: [] };
  }
  const ownedFiles = requireResolvedRuntimeFiles(skillName, scheduleDate);
  const validate = () =>
    skillName === NIGHTLY_SKILL
      ? validateNightlyArtifacts(stagingDataDir, { scheduleDate })
      : validateGenericRuntimeArtifacts(stagingDataDir, ownedFiles, { skillName, scheduleDate });
  const before = validate();
  if (before.ok) return { ...before, recovered: false };
  recoverOwnedFiles(stagingDataDir, fallbackDataDir, ownedFiles, runtimeDataDir);
  return { ...validate(), recovered: true };
}

function nightlyLiveReceiptSupersedesStage({ stagingDataDir, runtimeDataDir, scheduleDate } = {}) {
  const staged = readJson(
    path.join(stagingDataDir, 'agent', 'backlog-research-receipt.json'),
    'staged backlog research receipt',
    [],
  );
  const live = readJson(
    path.join(runtimeDataDir, 'agent', 'backlog-research-receipt.json'),
    'live backlog research receipt',
    [],
  );
  const expectedDate = String(scheduleDate || '').slice(0, 10);
  const stagedAt = Date.parse(staged?.ranAt || '');
  const liveAt = Date.parse(live?.ranAt || '');
  return Boolean(
    staged?.schema === 'backlog-research-receipt@1' &&
      live?.schema === 'backlog-research-receipt@1' &&
      staged?.producerStatus === 'success' &&
      live?.producerStatus === 'success' &&
      expectedDate &&
      String(staged?.date || '').slice(0, 10) === expectedDate &&
      String(live?.date || '').slice(0, 10) === expectedDate &&
      staged?.featureSnapshotSha256 &&
      staged.featureSnapshotSha256 === live.featureSnapshotSha256 &&
      Number.isFinite(stagedAt) &&
      Number.isFinite(liveAt) &&
      liveAt >= stagedAt
  );
}

function historicalNightlySuccess({ stagingDataDir, runtimeDataDir, scheduleDate } = {}) {
  const staged = readJson(path.join(stagingDataDir, 'agent/backlog-research-receipt.json'), 'staged receipt', []);
  const live = readJson(path.join(runtimeDataDir, 'agent/backlog-research-receipt.json'), 'live receipt', []);
  const date = String(scheduleDate || '').slice(0, 10);
  return Boolean(/^\d{4}-\d{2}-\d{2}$/.test(date) &&
    staged?.schema === 'backlog-research-receipt@1' && live?.schema === staged.schema &&
    staged.producerStatus === 'success' && live.producerStatus === 'success' &&
    staged.date === date && /^\d{4}-\d{2}-\d{2}$/.test(live.date) && live.date > date &&
    Number.isFinite(Date.parse(staged.ranAt)) && Date.parse(live.ranAt) > Date.parse(staged.ranAt) &&
    validateNightlyArtifacts(stagingDataDir, { scheduleDate: date }).ok &&
    validateNightlyArtifacts(runtimeDataDir).ok);
}

// Keep the captured JSON snapshots after queue staging cleanup. JSONL history
// is already append-only and must still contain every captured row at live-read.
function preserveHistoricalNightlySnapshot(options = {}) {
  if (!historicalNightlySuccess(options)) return null;
  const snapshots = NIGHTLY_FILES.filter((relative) => relative.endsWith('.json'));
  const hash = require('node:crypto').createHash('sha256');
  for (const relative of snapshots) hash.update(fs.readFileSync(path.join(options.stagingDataDir, relative)));
  const directory = path.join(options.runtimeDataDir, 'agent', 'scheduled-skill-history', NIGHTLY_SKILL, options.scheduleDate, hash.digest('hex'));
  for (const relative of snapshots) {
    const target = path.join(directory, relative);
    const bytes = fs.readFileSync(path.join(options.stagingDataDir, relative));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try { fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (!fs.readFileSync(target).equals(bytes)) throw new Error(`historical snapshot differs: ${relative}`);
  }
  return directory;
}

function verifyPublishedRuntimeArtifacts({
  skillName,
  stagingDataDir,
  runtimeDataDir,
  scheduleDate,
  historicalSnapshotDir,
} = {}) {
  if (!runtimeArtifactSkill(skillName)) {
    return { ok: true, skipped: true, proof: 'not-required', failures: [] };
  }
  const ownedFiles = requireResolvedRuntimeFiles(skillName, scheduleDate);
  const historical = skillName === NIGHTLY_SKILL && historicalSnapshotDir &&
    historicalNightlySuccess({ stagingDataDir, runtimeDataDir, scheduleDate }) &&
    NIGHTLY_FILES.filter((relative) => relative.endsWith('.json')).every((relative) =>
      fs.existsSync(path.join(historicalSnapshotDir, relative)) &&
      fs.readFileSync(path.join(historicalSnapshotDir, relative)).equals(fs.readFileSync(path.join(stagingDataDir, relative))));
  const validation =
    skillName === NIGHTLY_SKILL
      ? validateNightlyArtifacts(historical ? stagingDataDir : runtimeDataDir, { scheduleDate })
      : validateGenericRuntimeArtifacts(runtimeDataDir, ownedFiles, { skillName, scheduleDate });
  const failures = [...(validation.failures || [])];
  // A delayed archive retry can reach live-read after a newer same-date
  // producer has rewritten the two JSON snapshots. Never overwrite that newer
  // state merely to recover byte equality. Accept supersession only when both
  // successful receipts bind the exact same semantic feature snapshot and the
  // live receipt is chronologically newer. JSONL rows still require inclusion
  // below, so the captured run cannot disappear from append-only history.
  const nightlySuperseded =
    skillName === NIGHTLY_SKILL &&
    nightlyLiveReceiptSupersedesStage({ stagingDataDir, runtimeDataDir, scheduleDate });
  for (const relative of ownedFiles) {
    const staged = path.join(stagingDataDir, relative);
    const live = path.join(runtimeDataDir, relative);
    if (!fs.existsSync(staged)) continue;
    if (!fs.existsSync(live)) {
      failures.push(`published runtime output is missing: ${relative}`);
      continue;
    }
    if (relative.endsWith('.jsonl')) {
      const stagedLines = fs.readFileSync(staged, 'utf8').split(/\r?\n/).filter(Boolean);
      const liveLines = new Set(fs.readFileSync(live, 'utf8').split(/\r?\n/).filter(Boolean));
      const missing = stagedLines.filter((line) => !liveLines.has(line));
      if (missing.length) failures.push(`${relative} is missing ${missing.length} staged row(s)`);
      continue;
    }
    if (
      (nightlySuperseded || historical) &&
      (relative === 'agent/feature-backlog.json' ||
        relative === 'agent/backlog-research-receipt.json')
    ) {
      continue;
    }
    const stagedHash = require('node:crypto')
      .createHash('sha256')
      .update(fs.readFileSync(staged))
      .digest('hex');
    const liveHash = require('node:crypto')
      .createHash('sha256')
      .update(fs.readFileSync(live))
      .digest('hex');
    if (stagedHash !== liveHash) failures.push(`${relative} live bytes differ from the staged run`);
  }
  return {
    ...validation,
    ok: failures.length === 0,
    failures,
    proof: failures.length === 0 ? historical ? 'historical-snapshot-preserved-and-superseded' : 'newest-successful-producer-receipt' : null,
    supersededByNewerSameSnapshot: nightlySuperseded,
    historicalSnapshotDir: historical ? historicalSnapshotDir : null,
  };
}

// Fail closed if the parent hands the child a data root inside any Git
// worktree. The parent owns platform-specific resolution; the child only gets
// a proven runtime or runtime-staging directory.
function childRuntimeDataDir({ dataDir, env = process.env, isSharedCheckout } = {}) {
  void env;
  void isSharedCheckout;
  require('./scheduled-write-ownership.js').assertRuntimeDataRoot(dataDir);
  return path.resolve(dataDir);
}

module.exports = {
  NIGHTLY_SKILL,
  VIDEO_RESEARCH_SKILL,
  NIGHTLY_FILES,
  VIDEO_RESEARCH_FILES,
  RUNTIME_FILES_BY_SKILL,
  STAGE_MAX_AGE_MS,
  STAGE_MAX_RETAINED,
  STAGING_RELATIVE_ROOT,
  runtimeArtifactSkill,
  runtimeFilesForSkill,
  childRuntimeDataDir,
  cleanupRuntimeArtifactsStage,
  prepareRuntimeArtifacts,
  pruneRuntimeArtifactStages,
  validateNightlyArtifacts,
  nightlyLiveReceiptSupersedesStage,
  preserveHistoricalNightlySnapshot,
  publishRuntimeArtifacts,
  recoverRuntimeArtifactsStage,
  validateGenericRuntimeArtifacts,
  verifyPublishedRuntimeArtifacts,
};
