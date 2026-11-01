#!/usr/bin/env node
/**
 * Judge every voice clip as one voice or two, and keep the verdicts in
 * life-archive/voiceprints/voice-clip-purity-index.json (scripts/lib/voice-clip-purity.js).
 *
 * Reference clips go first, then call track clips, newest first. A clip is
 * judged once and again only when its file changes. Progress is saved every
 * batch, so a run that hits its time bound keeps what it finished. Each save
 * also appends how many clips are left to voice-clip-purity-progress.jsonl,
 * which the System Health row reads for the rate, the finish date and stalls.
 *
 *   node scripts/voice-clip-purity-index.js [--max-minutes 20] [--max-clips N] [--redecide]
 *
 * --redecide re-applies the current rule to stored piece scores without
 * re-cutting any audio.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

const { resolveDefaultPython } = require('./voice-embedding-ecapa');
const { referenceAudioCapability } = require('./lib/voice-reference-provenance');
const { saveJsonAtomic } = require('./lib/recluster-publish-lock');
const P = require('./lib/voice-clip-purity');
const { pendingItems } = require('./lib/voice-name-conflict-queue');

const ROOT = path.resolve(process.env.SECONDBRAIN_ROOT || path.join(__dirname, '..'));
const DATA_DIR = path.resolve(process.env.SECONDBRAIN_DATA_DIR || path.join(ROOT, 'data'));
const PYTHON = process.env.VOICE_ECAPA_PYTHON || resolveDefaultPython();
const SCRIPT = path.join(__dirname, 'voice-clip-purity.py');
const BATCH = 25;
const RULE = `${P.CROSS_MAX}/${P.GAP_MIN}`;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function args(argv) {
  const out = { maxMinutes: 20, maxClips: Infinity, redecide: false, otids: new Set() };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--max-minutes') out.maxMinutes = Number(argv[++i]);
    else if (argv[i] === '--max-clips') out.maxClips = Number(argv[++i]);
    else if (argv[i] === '--redecide') out.redecide = true;
    else if (argv[i] === '--otids') out.otids = new Set(String(argv[++i] || '').split(',').filter(Boolean));
  }
  return out;
}

/** Every clip worth judging, reference clips first, then call clips newest first. */
function candidateClips(dataDir, { otids = new Set() } = {}) {
  const seen = new Set();
  const out = [];
  const add = (abs, reference) => {
    const key = P.clipKey(abs);
    if (!key || seen.has(key)) return;
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      return;
    }
    if (!stat.isFile() || !stat.size) return;
    seen.add(key);
    out.push({ key, abs, reference, size: stat.size, mtimeMs: Math.round(stat.mtimeMs) });
  };
  const registry = readJson(path.join(dataDir, 'life-archive', 'voice-identity-registry.json'), {});
  if (!otids.size) {
    for (const e of registry.enrollments || []) {
      const audio = referenceAudioCapability(e, { dataDir });
      if (audio.matchable) add(audio.audio_path, true);
    }
  }
  // Clips behind open name questions next: the owner is looking at those now, and
  // the call backlog runs to weeks of five minute slots.
  // Open as the page shows them: the decision ledger, net of Undo.
  for (const item of pendingItems(dataDir, { all: true }).items) {
    for (const rel of [item.track_audio, item.named_ref?.audio, item.voice_ref?.audio]) {
      const key = P.clipKey(rel);
      if (key) add(path.join(dataDir, key), false);
    }
  }
  const audioRoot = path.join(dataDir, 'otter', 'audio');
  const calls = [];
  for (const otid of fs.existsSync(audioRoot) ? fs.readdirSync(audioRoot) : []) {
    if (otids.size && !otids.has(otid)) continue;
    const dir = path.join(audioRoot, otid);
    let names = [];
    try {
      names = fs.readdirSync(dir).filter((n) => /^track-label-.*\.wav$/i.test(n));
    } catch {
      continue;
    }
    if (!names.length) continue;
    let mtime = 0;
    try {
      mtime = fs.statSync(dir).mtimeMs;
    } catch {}
    calls.push({ dir, names, mtime });
  }
  calls.sort((a, b) => b.mtime - a.mtime);
  for (const c of calls) for (const n of c.names) add(path.join(c.dir, n), false);
  return out;
}

const RETRY_ERROR_MS = 24 * 60 * 60 * 1000;

/** Clips with no verdict for their current bytes, plus failed ones a day on. */
function pendingClips(candidates, index, now = Date.now()) {
  return candidates.filter((c) => {
    const hit = index.clips[c.key];
    if (!hit || hit.size !== c.size || hit.mtime_ms !== c.mtimeMs) return true;
    return hit.verdict === 'error' && now - Date.parse(hit.judged_at || 0) >= RETRY_ERROR_MS;
  });
}

/** Clips with no good verdict for their current bytes: failed ones stay unresolved
 * through their retry wait, so a check that only fails never reads as finished. */
function unresolvedClips(candidates, index) {
  return candidates.filter((c) => {
    const hit = index.clips[c.key];
    return !hit || hit.size !== c.size || hit.mtime_ms !== c.mtimeMs || hit.verdict === 'error';
  });
}

function entry(clip, row, at) {
  if (row.error) return { verdict: 'error', error: String(row.error).slice(0, 200), size: clip.size, mtime_ms: clip.mtimeMs, judged_at: at };
  return {
    ...P.decidePurity(row),
    rule: RULE,
    reference: clip.reference,
    starts: row.starts,
    similarity: row.similarity,
    size: clip.size,
    mtime_ms: clip.mtimeMs,
    judged_at: at,
  };
}

function summarize(index) {
  const counts = {};
  let referencesMixed = 0;
  for (const v of Object.values(index.clips)) {
    counts[v.verdict] = (counts[v.verdict] || 0) + 1;
    if (v.reference && v.verdict === 'mixed') referencesMixed += 1;
  }
  return { counts, references_mixed: referencesMixed };
}

function progressLine({ candidates, remaining, judged, summary }, at = new Date().toISOString()) {
  return {
    at,
    candidates,
    remaining: Math.max(0, remaining),
    judged_this_run: judged,
    errors: summary.counts.error || 0,
    mixed: summary.counts.mixed || 0,
    references_mixed: summary.references_mixed,
  };
}

async function judge(clips, onRow) {
  const child = spawn(PYTHON, [SCRIPT], { stdio: ['pipe', 'pipe', 'inherit'] });
  const byPath = new Map(clips.map((c) => [c.abs, c]));
  const lines = readline.createInterface({ input: child.stdout });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`purity helper exited ${code}`))));
  });
  lines.on('line', (line) => {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      return;
    }
    const clip = byPath.get(row.path);
    if (clip) onRow(clip, row);
  });
  for (const c of clips) child.stdin.write(`${c.abs}\n`);
  child.stdin.end();
  await done;
}

async function main() {
  const opts = args(process.argv.slice(2));
  const file = P.purityIndexPath(DATA_DIR);
  const index = readJson(file, null)?.schema === P.PURITY_SCHEMA ? readJson(file, null) : { schema: P.PURITY_SCHEMA, clips: {} };
  const at = new Date().toISOString();
  const save = () => {
    index.updated_at = new Date().toISOString();
    index.rule = RULE;
    index.summary = summarize(index);
    saveJsonAtomic(file, index);
  };

  if (opts.redecide) {
    for (const v of Object.values(index.clips)) {
      if (v.similarity) Object.assign(v, P.decidePurity(v), { rule: RULE });
    }
    save();
    console.log(JSON.stringify({ redecided: Object.keys(index.clips).length, ...index.summary }));
    return;
  }

  const candidates = candidateClips(DATA_DIR, { otids: opts.otids });
  const pending = pendingClips(candidates, index);
  const deadline = Date.now() + opts.maxMinutes * 60_000;
  let judged = 0;
  const record = () => {
    save();
    const line = progressLine({ candidates: candidates.length, remaining: unresolvedClips(candidates, index).length, judged, summary: index.summary });
    fs.appendFileSync(P.purityProgressPath(DATA_DIR), `${JSON.stringify(line)}\n`);
  };
  // A batch starts only when one more batch as long as the last still fits, so
  // the wrapper's kill never lands mid batch and throws its work away.
  let lastBatchMs = 0;
  for (let i = 0; i < pending.length && judged < opts.maxClips && Date.now() + lastBatchMs < deadline; i += BATCH) {
    const batch = pending.slice(i, Math.min(i + BATCH, i + opts.maxClips - judged));
    const started = Date.now();
    await judge(batch, (clip, row) => {
      index.clips[clip.key] = entry(clip, row, at);
    });
    lastBatchMs = Date.now() - started;
    judged += batch.length;
    record();
  }
  // Nothing to judge still leaves a line, so a finished backlog stays fresh.
  if (judged === 0) record();
  console.log(JSON.stringify({ judged, remaining: unresolvedClips(candidates, index).length, ...index.summary }));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[voice-clip-purity-index] ${error.message}`);
    process.exit(1);
  });
}

module.exports = { candidateClips, pendingClips, unresolvedClips, entry, summarize, progressLine };
