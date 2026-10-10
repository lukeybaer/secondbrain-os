'use strict';

// Deterministic, model-free input fingerprint for the two scheduled video
// quality jobs (ExampleCo 2026-09-24: "goal is to get to 30 mins total runtime").
// Both jobs started a full model session every run and, on most nights,
// recorded that the same open gaps were still open. The cloud scheduled
// fleet (runDueScheduledTasks in cloud-scheduled-fleet.js) compares this
// fingerprint with the one stored on the job's last successful model run and,
// when nothing changed, records an honest no-change outcome instead of
// starting a model session.
//
// A required source that is missing, or any input that cannot be read,
// throws. The fleet then runs the job exactly as before.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// The scorer contract, the selected scorer and the pipeline sources whose
// receipts it grades. These are the files the jobs' own dated receipts cite
// as their evidence (September 10 to 24).
const SOURCE_PATHS = Object.freeze([
  'config/video-score-contract.json',
  'scripts/video-score-contract.py',
  'src/main/empire/video-quality-tools',
  'scripts/build-viral-clip.js',
  'scripts/lib/directive-fidelity-receipt.js',
  'scripts/auto-regen-rejected-videos.js',
  'scripts/lib/authentic-video-revision.js',
]);

// Sync bookkeeping that changes without any owner decision. Every other
// manifest field (status, rejection notes, scores, approvals) is feedback.
const MANIFEST_BOOKKEEPING_KEYS = Object.freeze(['synced_at', 'updated_at', 'audit_updated_at']);

const RESEARCH_RESULT = /^\d{4}-\d{2}-\d{2}\.json$/;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function byName(a, b) {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function readOrNull(file) {
  try {
    return fs.readFileSync(file);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

// Files under root in a stable order, or null when root does not exist.
// Caches and dot entries are not inputs.
function listFiles(root) {
  let stat;
  try {
    stat = fs.statSync(root);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
  if (stat.isFile()) return [root];
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort(byName)) {
      if (entry.name.startsWith('.') || entry.name === '__pycache__' || entry.name.endsWith('.pyc')) {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(full);
    }
  };
  walk(root);
  return files;
}

function label(base, prefix, file) {
  return `${prefix}${path.relative(base, file).split(path.sep).join('/')}`;
}

// Hash the review manifest without its sync stamps, so a routine sync is not
// mistaken for new feedback. An unparseable manifest is hashed as raw bytes.
function manifestBytes(bytes) {
  let doc;
  try {
    doc = JSON.parse(bytes.toString('utf8'));
  } catch {
    return bytes;
  }
  const strip = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const copy = { ...value };
    for (const key of MANIFEST_BOOKKEEPING_KEYS) delete copy[key];
    return copy;
  };
  const normalized = strip(doc);
  if (normalized && Array.isArray(normalized.videos)) normalized.videos = normalized.videos.map(strip);
  return Buffer.from(JSON.stringify(normalized));
}

function hashGroup(group, entries) {
  const hash = crypto.createHash('sha256');
  let present = 0;
  let missing = 0;
  for (const entry of entries) {
    hash.update(`${entry.label}\0`);
    if (entry.bytes === null) {
      missing += 1;
      hash.update('[missing]\n');
    } else {
      present += 1;
      hash.update(`${sha256(entry.bytes)}\n`);
    }
  }
  return { group, files: present, missing, sha256: hash.digest('hex') };
}

function videoQualityInputFingerprint(skill, { repo, dataDir } = {}) {
  if (!repo || !dataDir) throw new Error('video quality input fingerprint needs repo and dataDir');
  const agentDir = path.join(dataDir, 'agent');
  const dataEntries = (relative) => {
    const root = path.join(agentDir, relative);
    const files = listFiles(root);
    if (files === null) return [{ label: `data/agent/${relative}`, bytes: null }];
    return files.map((file) => ({ label: label(agentDir, 'data/agent/', file), bytes: readOrNull(file) }));
  };
  const required = (relative) => {
    const files = listFiles(path.join(repo, relative));
    if (!files || files.length === 0) throw new Error(`required input missing: ${relative}`);
    return files.map((file) => ({ label: label(repo, '', file), bytes: fs.readFileSync(file) }));
  };

  const job = hashGroup('job', required(`scheduled-tasks/${skill}/SKILL.md`));
  const source = hashGroup('scorer-and-pipeline-source', SOURCE_PATHS.flatMap(required));

  const reviewDir = path.join(repo, 'content-review');
  const manifest = readOrNull(path.join(reviewDir, 'pending', 'manifest.json'));
  const feedback = hashGroup('owner-feedback', [
    { label: 'content-review/rejections.jsonl', bytes: readOrNull(path.join(reviewDir, 'rejections.jsonl')) },
    { label: 'content-review/pending/manifest.json', bytes: manifest === null ? null : manifestBytes(manifest) },
    ...dataEntries('rejection-reflections'),
    ...dataEntries('rubric-feedback-loop.jsonl'),
  ]);

  // Preserved score and receipt sidecars beside the pending videos. Manifest
  // backups are not score reports.
  let sidecars = [];
  try {
    sidecars = fs
      .readdirSync(path.join(reviewDir, 'pending'), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json') && !entry.name.startsWith('manifest'))
      .sort(byName)
      .map((entry) => {
        const file = path.join(reviewDir, 'pending', entry.name);
        return { label: `content-review/pending/${entry.name}`, bytes: readOrNull(file) };
      });
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
  const scores = hashGroup('score-reports', [...sidecars, ...dataEntries('video-quality-thresholds.json')]);

  const groups = [job, source, feedback, scores];
  let latestResearch = null;
  if (skill === 'video-quality-tools') {
    // The tools job consumes completed research. Only the newest dated
    // result is new evidence; a skipped research day writes none.
    const researchDir = path.join(agentDir, 'video-quality-research');
    let names = [];
    try {
      names = fs.readdirSync(researchDir).filter((name) => RESEARCH_RESULT.test(name)).sort();
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
    latestResearch = names.at(-1) || null;
    groups.push({
      ...hashGroup(
        'research',
        latestResearch
          ? [{ label: `data/agent/video-quality-research/${latestResearch}`, bytes: readOrNull(path.join(researchDir, latestResearch)) }]
          : [{ label: 'data/agent/video-quality-research', bytes: null }],
      ),
      latest: latestResearch,
    });
  }

  const fingerprint = sha256(groups.map((group) => `${group.group}:${group.sha256}`).join('\n'));
  return {
    fingerprint,
    evidence: groups.map((group) => ({ ...group, sha256: group.sha256.slice(0, 16) })),
  };
}

module.exports = {
  MANIFEST_BOOKKEEPING_KEYS,
  SOURCE_PATHS,
  videoQualityInputFingerprint,
};
