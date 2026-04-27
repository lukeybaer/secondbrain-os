#!/usr/bin/env node
/**
 * pii-screen.js
 *
 * Layer 1 runner — scans a directory tree against the auto-derived denylist
 * built by scripts/build-pii-denylist.js. Replaces the hardcoded grep block
 * in .github/workflows/sync-to-public.yml.
 *
 * Usage:
 *   node scripts/pii-screen.js [target_dir] [--rebuild]
 *
 * Exit codes:
 *   0 = clean
 *   1 = hits found (prints them)
 *   2 = denylist missing or build failed
 */

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const DENYLIST_PATH = path.join(REPO, 'data', 'agent', 'pii-denylist.json');

const TEXT_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.yml',
  '.yaml', '.sh', '.bat', '.cmd', '.ps1', '.py', '.html', '.css', '.txt',
  '.vbs',
]);
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'out', 'build', '.claude',
  '__pycache__', '.venv', 'venv', '.next', '.cache',
]);
const SELF_SKIP = new Set([
  'scripts/build-pii-denylist.js',
  'scripts/pii-screen.js',
  'data/agent/pii-denylist.json',
  'data/agent/pii-allowlist.json',
  '.github/workflows/sync-to-public.yml',
  'tests/pii-screen.spec.ts',
]);

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full, out);
    else {
      const ext = path.extname(name).toLowerCase();
      if (TEXT_EXTS.has(ext)) out.push(full);
    }
  }
  return out;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildPatterns(denylist) {
  const namesEscaped = denylist.names.map(escapeRegex);
  const tokensEscaped = denylist.tokens.map(escapeRegex);
  const emailsEscaped = denylist.emails.map(escapeRegex);
  const phones = denylist.phones;
  const out = [];
  if (namesEscaped.length) {
    out.push({ kind: 'name', re: new RegExp('\\b(' + namesEscaped.join('|') + ')\\b', 'gi') });
  }
  if (tokensEscaped.length) {
    out.push({ kind: 'token', re: new RegExp('\\b(' + tokensEscaped.join('|') + ')\\b', 'gi') });
  }
  if (emailsEscaped.length) {
    out.push({ kind: 'email', re: new RegExp('(' + emailsEscaped.join('|') + ')', 'gi') });
  }
  if (phones.length) {
    out.push({ kind: 'phone', re: new RegExp('\\b(' + phones.join('|') + ')\\b', 'g') });
  }
  return out;
}

function relFromRepo(abs, repoRoot) {
  return path.relative(repoRoot, abs).split(path.sep).join('/');
}

function scan(targetDir, repoRoot, denylist) {
  const patterns = buildPatterns(denylist);
  const files = walk(targetDir);
  const hits = [];
  for (const abs of files) {
    const rel = relFromRepo(abs, repoRoot);
    if (SELF_SKIP.has(rel)) continue;
    let content;
    try { content = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const p of patterns) {
        p.re.lastIndex = 0;
        const m = p.re.exec(line);
        if (m) {
          hits.push({
            file: rel,
            line: i + 1,
            kind: p.kind,
            match: m[1],
            context: line.trim().slice(0, 160),
          });
          break;
        }
      }
    }
  }
  return hits;
}

function loadDenylist(rebuild) {
  if (rebuild || !fs.existsSync(DENYLIST_PATH)) {
    require('./build-pii-denylist').build();
  }
  return JSON.parse(fs.readFileSync(DENYLIST_PATH, 'utf8'));
}

function main(argv) {
  const args = argv.slice(2);
  const rebuild = args.includes('--rebuild');
  const targetArg = args.find((a) => !a.startsWith('--')) || REPO;
  const target = path.resolve(targetArg);
  const denylist = loadDenylist(rebuild);
  const hits = scan(target, REPO, denylist.denylist);

  if (hits.length === 0) {
    console.log(`[pii-screen] CLEAN — 0 hits in ${target}`);
    process.exit(0);
  }

  console.log(`[pii-screen] ${hits.length} hits in ${target}:`);
  const byFile = {};
  for (const h of hits) {
    byFile[h.file] = byFile[h.file] || [];
    byFile[h.file].push(h);
  }
  for (const [file, fs_] of Object.entries(byFile)) {
    console.log(`  ${file} (${fs_.length}):`);
    for (const h of fs_.slice(0, 5)) {
      console.log(`    :${h.line} [${h.kind}=${h.match}] ${h.context}`);
    }
    if (fs_.length > 5) console.log(`    ... +${fs_.length - 5} more`);
  }
  process.exit(1);
}

if (require.main === module) {
  main(process.argv);
}

module.exports = { scan, loadDenylist, walk };
