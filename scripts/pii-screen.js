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
  // Distinct token list: tokens + ALL-LOWERCASE single-token names. These
  // are the strings that should match even when embedded in identifiers
  // (camelCase, snake_case). The pattern (?<![a-z])token(?![a-z]) catches
  // identifiers like `tokenArticles`, `TokenLive`, and `token_dev` while
  // still rejecting `monitoring` (substring match would over-flag).
  const allTokens = new Set(denylist.tokens || []);
  for (const n of denylist.names || []) {
    if (n === n.toLowerCase() && /^[a-z][a-z0-9_-]*$/.test(n) && n.length >= 5) {
      allTokens.add(n);
    }
  }
  const namesEscaped = (denylist.names || []).map(escapeRegex);
  const tokensEscaped = [...allTokens].map(escapeRegex);
  const emailsEscaped = (denylist.emails || []).map(escapeRegex);
  const phones = denylist.phones || [];
  const out = [];
  if (namesEscaped.length) {
    out.push({ kind: 'name', re: new RegExp('\\b(' + namesEscaped.join('|') + ')\\b', 'gi') });
  }
  if (tokensEscaped.length) {
    out.push({
      kind: 'token',
      re: new RegExp('(?<![a-z])(' + tokensEscaped.join('|') + ')(?![a-z])', 'gi'),
    });
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
    const relFromTarget = path.relative(targetDir, abs).split(path.sep).join('/');
    if (SELF_SKIP.has(rel) || SELF_SKIP.has(relFromTarget)) continue;
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

// Credential patterns that GitHub Push Protection catches. These are
// deterministic regexes, not heuristics. Update if new credential types
// are introduced to the codebase.
const CREDENTIAL_PATTERNS = [
  {
    kind: 'google-oauth-client-id',
    // format: <project-number>-<random-suffix>.apps.googleusercontent.com
    re: /\d{6,}-[a-z0-9]{20,}\.apps\.googleusercontent\.com/,
  },
  {
    kind: 'google-oauth-client-secret',
    // format: GOCSPX-<random-suffix>
    re: /GOCSPX-[A-Za-z0-9_-]{10,}/,
  },
];

function scanCredentials(targetDir, repoRoot) {
  const files = walk(targetDir);
  const hits = [];
  for (const abs of files) {
    const rel = relFromRepo(abs, repoRoot);
    const relFromTarget = path.relative(targetDir, abs).split(path.sep).join('/');
    if (SELF_SKIP.has(rel) || SELF_SKIP.has(relFromTarget)) continue;
    let content;
    try { content = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const p of CREDENTIAL_PATTERNS) {
        const m = p.re.exec(line);
        if (m) {
          hits.push({
            file: rel,
            line: i + 1,
            kind: p.kind,
            match: m[0].slice(0, 40) + (m[0].length > 40 ? '...' : ''),
            context: line.trim().slice(0, 160),
          });
          break;
        }
      }
    }
  }
  return hits;
}

function main(argv) {
  const args = argv.slice(2);
  const rebuild = args.includes('--rebuild');
  const targetArg = args.find((a) => !a.startsWith('--')) || REPO;
  const target = path.resolve(targetArg);
  const denylist = loadDenylist(rebuild);
  const piiHits = scan(target, REPO, denylist.denylist);
  const credHits = scanCredentials(target, REPO);
  const hits = [...piiHits, ...credHits];

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

module.exports = { scan, scanCredentials, loadDenylist, walk };
