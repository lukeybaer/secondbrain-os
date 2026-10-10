#!/usr/bin/env node
// memory-consolidation-scan.js
//
// Mechanical candidate pre-filter for the weekly memory consolidation pass
// (dev-plans/memory-hygiene-tooling-audit-2026-07-18.html, plan step 5).
//
// The 2026-07-18 tooling audit proved slug-equality contradiction detection
// can never fire on this corpus, and empirical calibration during the build
// proved phrase-level shingles cannot either: known real duplicate pairs
// (the two task-chips rules, the two TDD rules) share ZERO 3-token shingles.
// Paraphrased rules share vocabulary, not word sequences. So the scanner
// works at the vocabulary level: tf-idf cosine over stemmed unigrams, with
// filename-stem agreement and mutual-nearest-neighbor rank as second
// signals. Calibrated on the live corpus 2026-07-18: known-duplicate pairs
// score 0.25 and 0.12 cosine while the all-pairs p99 is 0.14, so absolute
// cosine alone is not enough; the name and rank rules recover the low band.
//
// Edges (any rule):
//   E1 cosine >= cosineStrong                      (unambiguous vocab match)
//   E2 cosine >= cosineWithName AND nameOverlap >= nameEdge
//   E3 mutual top-K nearest neighbors AND cosine >= cosineMutual
//
// This stage only nominates candidates for LLM adjudication. It proposes
// nothing and changes nothing. Clusters larger than broadClusterSize are
// flagged 'broad' (theme overlap, adjudicate member-by-member).
//
// Duplicate nomination stays scoped to top-level memory/*.md because that
// calibration is intentionally narrow. A separate review manifest inventories
// the whole memory surface so the semantic pass must also account for
// contradictions, supersession, staleness, retrieval utility, contacts,
// skills, archive material, indexes, and provenance.
//
// Paths are anchored to this script's own repo root (worktree-safe by
// construction; a stray SECONDBRAIN_ROOT pointing at the shared checkout
// must never redirect writes there).

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO = path.resolve(__dirname, '..');

const DEFAULTS = {
  cosineStrong: 0.3,
  cosineWithName: 0.1,
  nameEdge: 0.5,
  cosineMutual: 0.18,
  topK: 3,
  minBodyChars: 80,
  broadClusterSize: 6,
  excludeFiles: new Set(['MEMORY.md', 'RULES_INDEX.md']),
};

const STOPWORDS = new Set(
  (
    'a an and are as at be but by for from has have if in into is it its of on or ' +
    'that the this to was were will with not no never always when what which who ' +
    'you your i we they them their our us do does did done doing can could should ' +
    'would must may might than then there here so such very just also more most ' +
    'why how all any every each per one two use used using'
  ).split(' '),
);

const REVIEW_DIMENSIONS = Object.freeze([
  'duplicate_overlap',
  'contradiction',
  'supersession',
  'staleness',
  'retrieval_utility',
  'contacts',
  'skills',
  'archive',
  'provenance',
]);

function listMarkdownRecursive(root) {
  if (!root || !fs.existsSync(root)) return [];
  const out = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) out.push(full);
    }
  };
  visit(root);
  return out.sort();
}

function reviewScopeForFile(file, memoryDir, repoRoot) {
  const memoryRelative = path.relative(memoryDir, file).replace(/\\/g, '/');
  if (!memoryRelative.startsWith('../')) {
    if (!memoryRelative.includes('/') && ['MEMORY.md', 'RULES_INDEX.md'].includes(memoryRelative)) {
      return 'indexes';
    }
    if (!memoryRelative.includes('/')) return 'top_level_memory';
    if (memoryRelative.startsWith('contacts/')) return 'contacts';
    if (memoryRelative.startsWith('archive/')) return 'archive';
    if (memoryRelative.startsWith('skills/')) return 'skills';
    return 'other_memory';
  }
  const repoRelative = path.relative(repoRoot, file).replace(/\\/g, '/');
  if (repoRelative.startsWith('skills/')) return 'skills';
  if (repoRelative.startsWith('dev-plans/core/')) return 'core_docs';
  return 'other_memory';
}

// Time-based staleness candidacy (additive, adjudication only, never
// auto-archive): an active file not touched in STALE_DAYS+ and never
// referenced by name from any other active file (memory, MEMORY.md,
// skills/) is a plausible orphan the self-declared frontmatter markers can
// never catch, because it depends on nobody having declared it stale.
const STALE_DAYS = 120;

// Filesystem mtime is the checkout time on EC2 and in every worktree, so age
// comes from each file's last git commit. One git log pass maps every path to
// its newest commit time; files git does not know fall back to mtime.
function gitLastCommitTimes(repoRoot) {
  const times = new Map();
  try {
    const out = require('child_process').execFileSync(
      'git',
      ['-C', repoRoot, 'log', '--format=@%ct', '--name-only', '--', 'memory', 'skills', 'dev-plans/core'],
      { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let current = null;
    for (const line of out.split(/\r?\n/)) {
      if (line.startsWith('@')) current = Number(line.slice(1)) * 1000;
      else if (line && current && !times.has(line)) times.set(line, current);
    }
  } catch {
    // Not a git checkout: mtime stays the only signal.
  }
  return times;
}

function buildReviewManifest({ repoRoot, memoryDir, candidateFiles, now, lastCommitTimes = null }) {
  const commitTimes = lastCommitTimes || gitLastCommitTimes(repoRoot);
  const files = [
    ...listMarkdownRecursive(memoryDir),
    ...listMarkdownRecursive(path.join(repoRoot, 'skills')),
    ...listMarkdownRecursive(path.join(repoRoot, 'dev-plans', 'core')),
  ];
  const candidateSet = new Set(candidateFiles.map((file) => path.resolve(file)));
  const nowMs = Number.isFinite(now) ? now : Date.now();
  const entries = files.map((file) => {
    const raw = fs.readFileSync(file, 'utf8');
    const { meta } = parseFrontmatter(raw);
    const stat = fs.statSync(file);
    const scope = reviewScopeForFile(file, memoryDir, repoRoot);
    return {
      raw,
      row: {
        path: path.relative(repoRoot, file).replace(/\\/g, '/'),
        scope,
        duplicate_candidate_scope: candidateSet.has(path.resolve(file)),
        status: meta.status || 'active',
        superseded_by: meta.superseded_by || null,
        modified_at: new Date(
          commitTimes.get(path.relative(repoRoot, file).replace(/\\/g, '/')) || stat.mtime.getTime(),
        ).toISOString(),
        bytes: stat.size,
        content_sha256: crypto.createHash('sha256').update(raw).digest('hex'),
      },
    };
  });

  // Reference corpus: active, non-archive files only. Archive material is
  // retired by definition and must not count as "still referenced" cover for
  // a stale active file, nor be treated as itself a fresh reference source.
  const referenceEntries = entries.filter(
    (e) => e.row.scope !== 'archive' && e.row.status === 'active',
  );
  for (const entry of entries) {
    const { row } = entry;
    const ageDays = (nowMs - Date.parse(row.modified_at)) / 86400000;
    let referenced = false;
    if (row.scope !== 'archive' && row.status === 'active' && ageDays >= STALE_DAYS) {
      const stem = path.basename(row.path, '.md');
      for (const other of referenceEntries) {
        if (other === entry) continue;
        if (other.raw.includes(stem)) {
          referenced = true;
          break;
        }
      }
    }
    row.staleness_candidate =
      row.scope !== 'archive' && row.status === 'active' && ageDays >= STALE_DAYS && !referenced;
  }

  const rows = entries.map((e) => e.row);
  const scopes = {};
  for (const row of rows) {
    if (!scopes[row.scope]) scopes[row.scope] = { files: 0 };
    scopes[row.scope].files += 1;
  }
  for (const required of [
    'top_level_memory',
    'indexes',
    'contacts',
    'archive',
    'skills',
    'core_docs',
  ]) {
    if (!scopes[required]) scopes[required] = { files: 0 };
  }
  return { dimensions: [...REVIEW_DIMENSIONS], scopes, files: rows };
}

function parseFrontmatter(raw) {
  const m = String(raw || '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: raw || '' };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { meta, body: m[2] };
}

// Light stemmer: plural/verbal 's' only. Enough to align tests/test,
// repos/repo, chips/chip without a stemming library.
function stem(t) {
  if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) return t.slice(0, -1);
  return t;
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/\[\[|\]\]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map(stem);
}

function stemTokens(fileName) {
  return new Set(
    path
      .basename(fileName, '.md')
      .replace(/^(feedback|reference|project|user)_/, '')
      .split('_')
      .filter((t) => t.length > 2 && !STOPWORDS.has(t))
      .map(stem),
  );
}

// Returns { overlap, shared }. The shared COUNT matters as much as the ratio:
// on the real corpus 110 of 145 name-rule edges shared only ONE stem token
// (the briefing_/amy_ prefix families), gluing 196 files into one useless
// blob. Two shared stems is the observed floor for genuinely-related titles.
function nameSimilarity(fileA, fileB) {
  const a = stemTokens(fileA);
  const b = stemTokens(fileB);
  if (a.size === 0 || b.size === 0) return { overlap: 0, shared: 0 };
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return { overlap: inter / Math.min(a.size, b.size), shared: inter };
}

function listTopLevelTopicFiles(memoryDir, excludeFiles) {
  let entries = [];
  try {
    entries = fs.readdirSync(memoryDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.md') && !excludeFiles.has(e.name))
    .map((e) => path.join(memoryDir, e.name))
    .sort();
}

function buildVectors(docs) {
  const df = new Map();
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  const N = docs.length;
  for (const d of docs) {
    d.vec = new Map();
    let norm = 0;
    for (const [t, c] of d.tf) {
      // Smoothed idf: log((N+1)/df) so a term present in every doc keeps an
      // epsilon weight instead of hard zero (matters for small corpora).
      const w = (1 + Math.log(c)) * Math.log((N + 1) / df.get(t));
      d.vec.set(t, w);
      norm += w * w;
    }
    d.norm = Math.sqrt(norm) || 1;
  }
}

function cosine(a, b) {
  let s = 0;
  const [small, large] = a.vec.size <= b.vec.size ? [a, b] : [b, a];
  for (const [t, w] of small.vec) {
    const w2 = large.vec.get(t);
    if (w2) s += w * w2;
  }
  return s / (a.norm * b.norm);
}

function sharedTopTerms(a, b, limit) {
  const scored = [];
  const [small, large] = a.vec.size <= b.vec.size ? [a, b] : [b, a];
  for (const [t, w] of small.vec) {
    const w2 = large.vec.get(t);
    if (w2) scored.push([t, w * w2]);
  }
  scored.sort((x, y) => y[1] - x[1]);
  return scored.slice(0, limit).map(([t]) => t);
}

function findRoot(parent, i) {
  while (parent[i] !== i) {
    parent[i] = parent[parent[i]];
    i = parent[i];
  }
  return i;
}

function scan(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const memoryDir = cfg.memoryDir || path.join(REPO, 'memory');
  const repoRoot = cfg.repoRoot || path.dirname(memoryDir);
  const files = listTopLevelTopicFiles(memoryDir, cfg.excludeFiles);

  const docs = [];
  for (const f of files) {
    let raw = '';
    try {
      raw = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    const { meta, body } = parseFrontmatter(raw);
    if (body.trim().length < cfg.minBodyChars) continue;
    const tokens = tokenize(body);
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    docs.push({ file: f, meta, bodyChars: body.length, tf });
  }
  buildVectors(docs);

  // Pairwise cosines + per-doc top-K neighbor ranks.
  const n = docs.length;
  const cos = new Map(); // 'i:j' -> cosine
  const neighbors = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const c = cosine(docs[i], docs[j]);
      if (c <= 0) continue;
      cos.set(i + ':' + j, c);
      neighbors[i].push([j, c]);
      neighbors[j].push([i, c]);
    }
  }
  const topSets = neighbors.map((list) => {
    list.sort((a, b) => b[1] - a[1]);
    return new Set(list.slice(0, cfg.topK).map(([idx]) => idx));
  });

  const parent = docs.map((_, i) => i);
  const edges = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const c = cos.get(i + ':' + j) || 0;
      if (c <= 0) continue;
      const nameSim = nameSimilarity(docs[i].file, docs[j].file);
      const mutual = topSets[i].has(j) && topSets[j].has(i);
      let rule = null;
      if (c >= cfg.cosineStrong) rule = 'cosine_strong';
      else if (c >= cfg.cosineWithName && nameSim.overlap >= cfg.nameEdge && nameSim.shared >= 2)
        rule = 'cosine_plus_name';
      else if (mutual && c >= cfg.cosineMutual) rule = 'mutual_nearest';
      if (!rule) continue;
      edges.push({
        a: docs[i].file,
        b: docs[j].file,
        cosine: Number(c.toFixed(4)),
        name_overlap: Number(nameSim.overlap.toFixed(2)),
        rule,
        shared_terms: sharedTopTerms(docs[i], docs[j], 6),
      });
      const ra = findRoot(parent, i);
      const rb = findRoot(parent, j);
      if (ra !== rb) parent[rb] = ra;
    }
  }

  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const root = findRoot(parent, i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(docs[i]);
  }

  let seq = 0;
  const clusters = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    seq += 1;
    const memberFiles = new Set(members.map((m) => m.file));
    clusters.push({
      id: `cluster-${String(seq).padStart(3, '0')}`,
      broad: members.length > cfg.broadClusterSize,
      files: members.map((m) => m.file),
      members: members.map((m) => ({
        file: path.relative(memoryDir, m.file).replace(/\\/g, '/'),
        name: m.meta.name || '',
        description: m.meta.description || '',
        type: m.meta.type || '',
        body_chars: m.bodyChars,
      })),
      edges: edges
        .filter((e) => memberFiles.has(e.a) && memberFiles.has(e.b))
        .map((e) => ({
          ...e,
          a: path.relative(memoryDir, e.a).replace(/\\/g, '/'),
          b: path.relative(memoryDir, e.b).replace(/\\/g, '/'),
        })),
    });
  }
  // A broad cluster (theme overlap beyond broadClusterSize) is where real
  // near-duplicates hide: its members get skimmed by top edges only, never
  // compared file by file. Re-cluster each broad cluster's own members
  // against EACH OTHER using only the strong-cosine rule (no name/mutual
  // assist), so a tight near-duplicate pair or small group inside the hub
  // surfaces as its own normal, adjudicable cluster instead of being buried
  // in the "reviewed edges only" bucket. The parent broad cluster is kept
  // as-is so full-corpus membership accounting is unaffected.
  const docByFile = new Map(docs.map((d) => [d.file, d]));
  const subClusters = [];
  for (const cluster of clusters) {
    if (!cluster.broad) continue;
    const memberFiles = new Set(cluster.files);
    const strongEdges = edges.filter(
      (e) => e.rule === 'cosine_strong' && memberFiles.has(e.a) && memberFiles.has(e.b),
    );
    if (!strongEdges.length) continue;

    const subParent = new Map(cluster.files.map((f) => [f, f]));
    const subFind = (f) => {
      while (subParent.get(f) !== f) {
        subParent.set(f, subParent.get(subParent.get(f)));
        f = subParent.get(f);
      }
      return f;
    };
    for (const e of strongEdges) {
      const ra = subFind(e.a);
      const rb = subFind(e.b);
      if (ra !== rb) subParent.set(rb, ra);
    }

    const subGroups = new Map();
    for (const f of cluster.files) {
      const root = subFind(f);
      if (!subGroups.has(root)) subGroups.set(root, []);
      subGroups.get(root).push(f);
    }

    let subSeq = 0;
    for (const subFiles of subGroups.values()) {
      if (subFiles.length < 2) continue;
      subSeq += 1;
      const subFileSet = new Set(subFiles);
      subClusters.push({
        id: `${cluster.id}-sub-${String(subSeq).padStart(2, '0')}`,
        // A strong-cosine-only sub-cluster can itself still exceed
        // broadClusterSize on a large real hub; keep the broad flag honest
        // (size-based) rather than always clearing it, so an oversized
        // sub-cluster is not mistaken for a fully member-by-member-reviewed
        // normal cluster.
        broad: subFiles.length > cfg.broadClusterSize,
        source_broad_cluster: cluster.id,
        files: subFiles,
        members: subFiles.map((f) => {
          const d = docByFile.get(f);
          return {
            file: path.relative(memoryDir, f).replace(/\\/g, '/'),
            name: d?.meta.name || '',
            description: d?.meta.description || '',
            type: d?.meta.type || '',
            body_chars: d?.bodyChars || 0,
          };
        }),
        edges: strongEdges
          .filter((e) => subFileSet.has(e.a) && subFileSet.has(e.b))
          .map((e) => ({
            ...e,
            a: path.relative(memoryDir, e.a).replace(/\\/g, '/'),
            b: path.relative(memoryDir, e.b).replace(/\\/g, '/'),
          })),
      });
    }
  }
  clusters.push(...subClusters);
  clusters.sort((a, b) => b.files.length - a.files.length);

  return {
    scanned: docs.length,
    clusters,
    memoryDir,
    review_manifest: buildReviewManifest({
      repoRoot,
      memoryDir,
      candidateFiles: files,
      now: cfg.now,
    }),
  };
}

function writeClusters(result, outPath, opts = {}) {
  const now = opts.now ? opts.now() : new Date();
  const payload = {
    generated_at: now.toISOString(),
    scanned: result.scanned,
    cluster_count: result.clusters.length,
    review_manifest: result.review_manifest,
    clusters: result.clusters.map((c) => ({
      ...c,
      files: c.files.map((f) => path.relative(result.memoryDir, f).replace(/\\/g, '/')),
    })),
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2) + '\n');
  return payload;
}

module.exports = {
  DEFAULTS,
  parseFrontmatter,
  tokenize,
  stem,
  nameSimilarity,
  REVIEW_DIMENSIONS,
  buildReviewManifest,
  scan,
  writeClusters,
};

if (require.main === module) {
  const outPath =
    process.argv[2] || path.join(REPO, 'data', 'agent', 'memory-consolidation-clusters.json');
  const result = scan();
  const payload = writeClusters(result, outPath);
  process.stdout.write(
    `memory-consolidation-scan: ${payload.scanned} files, ${payload.cluster_count} clusters -> ${outPath}\n`,
  );
}
