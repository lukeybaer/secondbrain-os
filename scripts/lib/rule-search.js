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
// Cache: one JSON file in the OS temp dir keyed by repo root, holding each
// file's mtime+size. The hook serves it as is and starts, at most once a
// minute, a detached process that stats every file (about 860) and rebuilds
// the cache when one changed. A warm prompt costs read + JSON parse + search
// plus that spawn, about 30 ms; the per-file check alone took about 300 ms
// inline while 16 test and review processes ran (2026-11-15).
//
// Pure CommonJS, zero deps, so it loads from the hook and from tests.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const INDEX_VERSION = 7;
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
const REFRESH_EVERY_MS = 60000;
const OUTPUT_CAP_BYTES = 380;

const STOP = new Set(
  (
    'a an and are as at be but by can could did do does for from get got had has have how i if in into is it its just ' +
    'like make me my need no not now of on one or our out over please she should so some than that the their them then ' +
    'there these they this to too up us use want was we were what when where which who why will with would you your ' +
    'amy owner also about again all any been before being both come each few go going her here him his let more most ' +
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

/**
 * A pointer target that is not Markdown (script, tool, folder) must be a plain
 * repo-relative path to something that exists. Returns the cleaned path, or
 * null for anything absolute, escaping the repo, glob-like or missing.
 * Never throws: a bad row is just dropped.
 */
function safeRepoTarget(root, pat) {
  try {
    const rel = String(pat).trim().replace(/\/+$/, '');
    if (!rel || /[\x00-\x1f\\*?<>"|]/.test(rel) || rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) return null;
    if (rel.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) return null;
    const abs = path.join(root, rel);
    fs.statSync(abs); // must exist (file or folder)
    const rp = path.relative(fs.realpathSync(root), fs.realpathSync(abs));
    if (!rp || rp.startsWith('..') || path.isAbsolute(rp)) return null; // a link must not leave the repo
    return rel;
  } catch {
    return null;
  }
}

/**
 * Parse the lookup table into Map<file, alias tokens>. Globs resolve against `files`.
 * With `root`, a backticked target of any other type that exists in the repo is
 * also kept (key = its repo-relative path); only the row's words are tokens.
 * `checked` (a Map), when given, records each such target and whether it
 * resolved, so the cache can tell when one appears or disappears.
 */
function parseAliases(tableText, files, root, checked) {
  const aliases = new Map();
  const set = new Set(files);
  for (const line of String(tableText).replace(/\r\n/g, '\n').split('\n')) {
    if (!/^- \*\*/.test(line)) continue;
    const parts = line.slice(2).split('**'); // ['', label, rest, label, rest...]
    for (let i = 1; i < parts.length; i += 2) {
      const toks = tokenize(parts[i] + ' ' + (parts[i + 1] || '').replace(/`[^`]*`/g, ' '));
      for (const m of (parts[i + 1] || '').matchAll(/`([^`]+)`/g)) {
        for (const pat of expandBraces(m[1])) {
          if (!/\.md$/.test(pat)) {
            const target = root ? safeRepoTarget(root, pat) : null;
            if (root && checked) checked.set(pat, Boolean(target));
            if (target) aliases.set(target, (aliases.get(target) || []).concat(toks));
            continue;
          }
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
  const pointers = new Map();
  if (files.includes(TABLE_REL)) {
    try {
      aliases = parseAliases(fs.readFileSync(path.join(root, TABLE_REL), 'utf8'), files, root, pointers);
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
  // Pointer-only targets (scripts, tools, folders) are never opened. Each is a
  // doc made of the pointer row's words plus the target's own name, so a search
  // for the row leads to the path.
  const fileSet = new Set(files);
  for (const [rel, aliasToks] of aliases) {
    if (fileSet.has(rel)) continue;
    const toks = [];
    const nameToks = tokenize(path.basename(rel).replace(/\.[^.]*$/, '').replace(/[_.-]/g, ' '));
    for (let r = 0; r < BOOST.name; r++) toks.push(...nameToks);
    for (let r = 0; r < BOOST.alias; r++) toks.push(...aliasToks);
    if (toks.length === 0) continue;
    const id = docs.length;
    docs.push([rel, '', toks.length]);
    const tf = Object.create(null);
    for (const t of toks) tf[t] = (tf[t] || 0) + 1;
    for (const t of Object.keys(tf)) (postings[t] || (postings[t] = [])).push(id, tf[t]);
  }
  // Postings are stored as one flat "id,tf,id,tf" string per term: JSON.parse
  // of strings is far cheaper than of millions of tiny arrays, and only the
  // query terms are ever decoded.
  for (const k of Object.keys(postings)) postings[k] = postings[k].join(',');
  return { v: INDEX_VERSION, root, stats, docs, postings, pointers: Object.fromEntries(pointers) };
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
  // A script or folder the table points at can appear or disappear without
  // any Markdown changing (review R12).
  for (const [pat, existed] of Object.entries(idx.pointers || {})) {
    if (Boolean(safeRepoTarget(root, pat)) !== existed) return false;
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

/**
 * Check every file in a detached process, and rebuild the cache there when one
 * changed, so the prompt is not delayed by either. At most one start a minute.
 */
function spawnRefresh(root, cp) {
  try {
    const lock = `${cp}.lock`;
    try {
      if (Date.now() - fs.statSync(lock).mtimeMs < REFRESH_EVERY_MS) return;
    } catch {
      /* no lock */
    }
    fs.writeFileSync(lock, String(process.pid));
    const { spawn } = require('node:child_process');
    spawn(process.execPath, [__filename, '--refresh', root, cp], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch {
    /* best-effort */
  }
}

/**
 * Load the cached index, or rebuild it when any file changed.
 * opts.allowStale (the hook): the cache is served without checking any file;
 * a detached process, which a prompt starts at most once a minute, checks and
 * rebuilds it. An edit shows from the first prompt after the next check and
 * never costs a prompt the check or a rebuild.
 * Only a missing cache builds synchronously (once).
 */
function loadIndex(root, opts = {}) {
  const cp = opts.cachePath || cachePath(root);
  if (!opts.noCache) {
    try {
      const idx = JSON.parse(fs.readFileSync(cp, 'utf8'));
      if (idx && idx.v === INDEX_VERSION) {
        if (opts.allowStale) {
          spawnRefresh(root, cp);
          return idx;
        }
        if (isFresh(root, idx)) return idx;
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

// The detached refresh: check every file, rebuild only when one changed.
if (require.main === module && process.argv[2] === '--refresh' && process.argv[3]) {
  loadIndex(process.argv[3], { cachePath: process.argv[4] });
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
