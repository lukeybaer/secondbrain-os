'use strict';
//
// rule-search.js -- dependency-free BM25 full-text index over Amy's own rules
// and lessons, delivered beside the keyword router (core-component-router.mjs).
//
// Corpus (never contacts, archive or the always-loaded MEMORY.md):
//   memory/*.md, memory/topics/*.md, memory/requirements/*.md
//   dev-plans/core/*.md            (LESSONS files split per dated entry)
//   skills/**/{LEARNINGS,LESSONS}.md and scheduled-tasks/**/ same (per entry)
// Large files are split per "## " section so a hit names the section.
//
// Cache: one JSON file in the OS temp dir keyed by repo root. Each file's
// mtime+size is stat-ed per prompt (about 700 stats); any change rebuilds.
// Warm cost is stat + JSON parse; the router budget is well under 150 ms.
//
// Pure CommonJS, zero deps, so it loads from the hook and from tests.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const INDEX_VERSION = 5;
// The "Where to find what, by topic" lookup table. It is not indexed as a doc:
// each bullet's topic label becomes alias text boosting the files it names.
const TABLE_REL = 'memory/topics/where-to-find.md';
const CHUNK_SPLIT_BYTES = 8192;
const BOOST = { name: +(process.env.RS_NAME || 6), head: +(process.env.RS_HEAD || 3), desc: +(process.env.RS_DESC || 2), alias: +(process.env.RS_ALIAS || 6) };
const K1 = 1.2;
const B = +(process.env.RS_B || 0.5);
const TOP_N = 5;
const CANDIDATES = 9; // extra candidates so paths the router already injected can be skipped
const MAX_PER_FILE = 2;
const MIN_SCORE = 8; // smalltalk tops out near 7.6; real matches in the eval start near 10
const REBUILD_LOCK_MS = 60000;
const OUTPUT_CAP_BYTES = 380;

const STOP = new Set(
  (
    'a an and are as at be but by can could did do does for from get got had has have how i if in into is it its just ' +
    'like make me my need no not now of on one or our out over please she should so some than that the their them then ' +
    'there these they this to too up us use want was we were what when where which who why will with would you your ' +
    'amy ExampleCo also about again all any been before being both come each few go going her here him his let more most ' +
    'much must new off only other own same see still such take tell thing things think try very way well work ' +
    'file files check run set add put say said look find'
  ).split(/\s+/),
);

function stem(w) {
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith('es')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

function tokenize(text) {
  const out = [];
  const words = String(text || '').toLowerCase().split(/[^a-z0-9]+/);
  for (const w of words) {
    if (w.length < 3 || STOP.has(w) || /^\d+$/.test(w)) continue;
    out.push(stem(w));
  }
  return out;
}

function listFiles(root) {
  const files = [];
  const add = (rel) => files.push(rel);
  const md = (dir) => {
    let names = [];
    try {
      names = fs.readdirSync(path.join(root, dir));
    } catch {
      return;
    }
    for (const n of names) if (n.endsWith('.md')) add(`${dir}/${n}`);
  };
  md('memory');
  md('memory/topics');
  md('memory/requirements');
  md('dev-plans/core');
  const walk = (dir, depth) => {
    let ents = [];
    try {
      ents = fs.readdirSync(path.join(root, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (e.isDirectory()) {
        if (depth < 4 && e.name !== 'node_modules' && !e.name.startsWith('.')) walk(`${dir}/${e.name}`, depth + 1);
      } else if (e.name === 'LEARNINGS.md' || e.name === 'LESSONS.md' || (dir.startsWith('skills') && e.name === 'SKILL.md')) add(`${dir}/${e.name}`);
    }
  };
  walk('skills', 0);
  walk('scheduled-tasks', 0);
  // MEMORY.md is always loaded; RULES_INDEX.md is a pointer index that echoes every topic word.
  return files.filter((f) => f !== 'memory/MEMORY.md' && f !== 'memory/RULES_INDEX.md');
}

function isLessons(rel) {
  return /(^|\/)(LEARNINGS|LESSONS)\.md$/.test(rel) || /\.LESSONS\.md$/.test(rel);
}

/** Split a file into [{heading, text}] chunks. */
function chunkFile(rel, text) {
  const body = String(text).replace(/\r\n/g, '\n');
  const lessons = isLessons(rel);
  if (!lessons && Buffer.byteLength(body) <= CHUNK_SPLIT_BYTES) return [{ heading: '', text: body }];
  const lines = body.split('\n');
  const chunks = [];
  let cur = { heading: '', lines: [] };
  const headRe = lessons ? /^#{2,3}\s+\S/ : /^##\s+\S/;
  for (const line of lines) {
    if (headRe.test(line) && cur.lines.length > 0) {
      chunks.push(cur);
      cur = { heading: '', lines: [] };
    }
    if (headRe.test(line)) cur.heading = line.replace(/^#+\s*/, '').trim();
    cur.lines.push(line);
  }
  chunks.push(cur);
  return chunks.map((c) => ({ heading: c.heading, text: c.lines.join('\n') }));
}

function expandBraces(s) {
  const m = /\{([^{}]*)\}/.exec(s);
  if (!m) return [s];
  return m[1].split(',').flatMap((alt) => expandBraces(s.slice(0, m.index) + alt + s.slice(m.index + m[0].length)));
}

function globToRegExp(pattern) {
  const esc = pattern.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp('^' + esc.join('.*') + '$');
}

/** Parse the lookup table into Map<file, alias tokens>. Globs resolve against `files`. */
function parseAliases(tableText, files) {
  const aliases = new Map();
  const set = new Set(files);
  for (const line of String(tableText).replace(/\r\n/g, '\n').split('\n')) {
    if (!/^- \*\*/.test(line)) continue;
    const parts = line.slice(2).split('**'); // ['', label, rest, label, rest...]
    for (let i = 1; i < parts.length; i += 2) {
      const toks = tokenize(parts[i] + ' ' + (parts[i + 1] || '').replace(/`[^`]*`/g, ' '));
      for (const m of (parts[i + 1] || '').matchAll(/`([^`]+)`/g)) {
        for (const pat of expandBraces(m[1])) {
          if (!/\.md$/.test(pat)) continue;
          const rel = /^(skills|dev-plans|scripts|memory)\//.test(pat) ? pat : `memory/${pat}`;
          const hit = rel.includes('*') ? files.filter((f) => globToRegExp(rel).test(f)) : set.has(rel) ? [rel] : [];
          for (const f of hit) aliases.set(f, (aliases.get(f) || []).concat(toks));
        }
      }
    }
  }
  return aliases;
}

function buildIndex(root) {
  const files = listFiles(root);
  let aliases = new Map();
  if (files.includes(TABLE_REL)) {
    try {
      aliases = parseAliases(fs.readFileSync(path.join(root, TABLE_REL), 'utf8'), files);
    } catch {
      /* no aliases */
    }
  }
  const docs = [];
  const postings = Object.create(null);
  const stats = {};
  for (const rel of files) {
    let st;
    let text;
    try {
      const abs = path.join(root, rel);
      st = fs.statSync(abs);
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    stats[rel] = `${Math.floor(st.mtimeMs)}:${st.size}`;
    if (rel === TABLE_REL) continue;
    const aliasToks = aliases.get(rel) || [];
    const nameToks = tokenize(path.basename(rel, '.md').replace(/[_.-]/g, ' '));
    const fm = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, '\n'));
    const descToks = fm ? tokenize(fm[1]) : [];
    for (const ch of chunkFile(rel, text)) {
      const toks = tokenize(ch.text);
      if (toks.length === 0) continue;
      // Boost: filename x3, heading x3, frontmatter description x2.
      for (let r = 0; r < BOOST.name; r++) toks.push(...nameToks);
      for (let r = 0; r < BOOST.head; r++) toks.push(...tokenize(ch.heading));
      for (let r = 0; r < BOOST.desc; r++) toks.push(...descToks);
      for (let r = 0; r < BOOST.alias; r++) toks.push(...aliasToks);
      const id = docs.length;
      docs.push([rel, ch.heading.slice(0, 80), toks.length]);
      const tf = Object.create(null);
      for (const t of toks) tf[t] = (tf[t] || 0) + 1;
      for (const t of Object.keys(tf)) (postings[t] || (postings[t] = [])).push(id, tf[t]);
    }
  }
  // Postings are stored as one flat "id,tf,id,tf" string per term: JSON.parse
  // of strings is far cheaper than of millions of tiny arrays, and only the
  // query terms are ever decoded.
  for (const k of Object.keys(postings)) postings[k] = postings[k].join(',');
  return { v: INDEX_VERSION, root, stats, docs, postings };
}

function cachePath(root) {
  const h = crypto.createHash('sha1').update(path.resolve(root).toLowerCase()).digest('hex').slice(0, 10);
  return path.join(os.tmpdir(), `sb-rule-search-${h}.json`);
}

function isFresh(root, idx) {
  if (!idx || idx.v !== INDEX_VERSION) return false;
  const files = listFiles(root);
  const known = Object.keys(idx.stats);
  if (files.length !== known.length) return false;
  for (const rel of files) {
    let st;
    try {
      st = fs.statSync(path.join(root, rel));
    } catch {
      return false;
    }
    if (idx.stats[rel] !== `${Math.floor(st.mtimeMs)}:${st.size}`) return false;
  }
  return true;
}

function writeCache(cp, idx) {
  try {
    const tmp = `${cp}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(idx));
    fs.renameSync(tmp, cp);
  } catch {
    /* cache is best-effort */
  }
}

/** Rebuild the index in a detached process so the prompt that found it stale is not delayed. */
function spawnRebuild(root, cp) {
  try {
    const lock = `${cp}.lock`;
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs < REBUILD_LOCK_MS) return;
    } catch {
      /* no lock */
    }
    fs.writeFileSync(lock, String(process.pid));
    const { spawn } = require('node:child_process');
    spawn(process.execPath, [__filename, '--rebuild', root], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch {
    /* best-effort */
  }
}

/**
 * Load the cached index, or rebuild it when any file changed.
 * opts.allowStale (the hook): a stale cache is served as is and a detached
 * process refreshes it, so an edited memory file never costs a prompt a rebuild.
 * Only a missing cache builds synchronously (once).
 */
function loadIndex(root, opts = {}) {
  const cp = opts.cachePath || cachePath(root);
  if (!opts.noCache) {
    try {
      const idx = JSON.parse(fs.readFileSync(cp, 'utf8'));
      if (idx && idx.v === INDEX_VERSION) {
        if (isFresh(root, idx)) return idx;
        if (opts.allowStale) {
          spawnRebuild(root, cp);
          return idx;
        }
      }
    } catch {
      /* rebuild */
    }
  }
  const idx = buildIndex(root);
  if (!opts.noCache) writeCache(cp, idx);
  return idx;
}

/** BM25 over the index. Returns [{path, heading, score}] best-first, at most 2 per file. */
function search(idx, query, topN = TOP_N) {
  const terms = [...new Set(tokenize(query))];
  const N = idx.docs.length;
  if (!N || terms.length === 0) return [];
  let total = 0;
  for (const d of idx.docs) total += d[2];
  const avg = total / N;
  const scores = new Map();
  const hits = new Map();
  for (const t of terms) {
    const raw = idx.postings[t];
    if (!raw) continue;
    const plist = raw.split(',').map(Number);
    const df = plist.length / 2;
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
    for (let i = 0; i < plist.length; i += 2) {
      const id = plist[i];
      const tf = plist[i + 1];
      const len = idx.docs[id][2];
      const s = idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * len) / avg)));
      scores.set(id, (scores.get(id) || 0) + s);
      hits.set(id, (hits.get(id) || 0) + 1);
    }
  }
  // One stray shared word is not a match: with 2+ query terms a doc must match
  // at least two distinct terms, so smalltalk stays silent (router self-filter).
  const need = Math.min(2, terms.length);
  const floor = MIN_SCORE * Math.min(1, Math.log(N) / Math.log(4000)); // idf scales with ln(corpus size)
  const ranked = [...scores.entries()].filter(([id, s]) => hits.get(id) >= need && s >= floor).sort((a, b) => b[1] - a[1]);
  const out = [];
  const perFile = new Map();
  for (const [id, score] of ranked) {
    const [p, heading] = idx.docs[id];
    // A file may fill at most 2 slots (lessons files hold many entries) so
    // one long LESSONS file cannot crowd out the other rule files.
    const n = perFile.get(p) || 0;
    if (n >= MAX_PER_FILE) continue;
    perFile.set(p, n + 1);
    out.push({ path: p, heading, score });
    if (out.length >= topN) break;
  }
  return out;
}

/**
 * Compact router line (about 300 bytes). `memory/` is dropped from the path
 * (stated in the header) to fit five matches. `skip` = paths already injected.
 * Returns { line, shown } where shown is the full repo-relative paths printed.
 */
function formatMatches(matches, skip = []) {
  const skipSet = new Set(skip);
  const items = [];
  const full = [];
  for (const m of matches) {
    if (skipSet.has(m.path)) continue;
    const h = isLessons(m.path) && m.heading ? `#${m.heading.slice(0, 40)}` : '';
    items.push(`${m.path.replace(/^memory\//, '')}${h}`);
    full.push(m.path);
  }
  const head = 'RULE SEARCH (memory/ unless full path): ';
  let line = head;
  const shown = [];
  for (let i = 0; i < items.length; i++) {
    const next = line + (shown.length ? '; ' : '') + items[i];
    if (Buffer.byteLength(next) > OUTPUT_CAP_BYTES && shown.length > 0) break;
    line = next;
    shown.push(full[i]);
    if (shown.length >= TOP_N) break;
  }
  return { line: shown.length ? line : '', shown };
}

if (require.main === module && process.argv[2] === '--rebuild' && process.argv[3]) {
  writeCache(cachePath(process.argv[3]), buildIndex(process.argv[3]));
}

module.exports = {
  tokenize,
  listFiles,
  chunkFile,
  buildIndex,
  parseAliases,
  loadIndex,
  search,
  formatMatches,
  cachePath,
  TOP_N,
  CANDIDATES,
  OUTPUT_CAP_BYTES,
};
