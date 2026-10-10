#!/usr/bin/env node
// scripts/audit-llm-callsites.js
//
// AUDIT MODE: report-only inventory of direct LLM call sites (always exits 0).
// Part of the 2026-06-11 LLM fallback ladder plan
// (dev-plans/llm-fallback-ladder-2026-06-11.html): every surface should reach
// LLMs through scripts/lib/ask-ai.js or the charged LLM API guard. This scanner
// finds the surfaces that still talk to an LLM directly so the migration backlog
// is visible, not guessed.
//
// Detected kinds:
//   cli-spawn      spawn/spawnSync/execSync/execFile of `claude` or `codex`
//                  (JS) or subprocess.run/Popen/... of the same (Python)
//   anthropic-api  reference to api.anthropic.com
//   anthropic-sdk  reference to the Anthropic SDK client
//   openai-api     reference to api.openai.com
//   groq-sdk       reference to the Groq SDK client
//   bedrock        reference to bedrock-runtime
//   openai-key     OPENAI_API_KEY read
//   anthropic-key  ANTHROPIC_API_KEY read
//
// Output: data/agent/llm-callsite-audit.json
//   {
//     generated:   ISO timestamp,
//     sites:       [{ file, line, kind }],
//     notInLadder: [ files with sites that neither require scripts/lib/ask-ai
//                    nor sit in ALLOWLIST ]
//   }
//
// Usage: node scripts/audit-llm-callsites.js [--root <dir>] [--out <file>]

'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Directory basenames never descended into. Dot-dirs (.git, .claude,
// .venv-*) are skipped wholesale in walk(). Vendored third-party checkouts
// (agno, site-packages, venv) are not Amy surfaces and would drown the
// notInLadder list in upstream example code.
const EXCLUDE_DIRS = new Set([
  'node_modules',
  'data',
  '__tests__',
  'dev-plans',
  'memory',
  'dist',
  'out',
  'coverage',
  'openclaw-archive',
  'agno',
  'site-packages',
  'venv',
  'archive',
  'tmp',
  'test-results',
]);

const CODE_EXT = /\.(js|mjs|cjs|ts|tsx|py)$/;
const TEST_FILE = /\.(test|spec)\./;

// Sanctioned files: ladder implementations and the infra that the ladder
// itself depends on. Direct LLM access here is by design.
const ALLOWLIST = new Set([
  'scripts/lib/ask-ai.js',
  'scripts/lib/cli-output-guard.js',
  'ec2-server.js',
  'claude-proxy.js',
  'scripts/codex-run.js',
  'scripts/claude-token-refresh.js',
  'scripts/run-scheduled-skill.js',
  'scripts/process-dispatches.js',
]);

const PATTERNS = [
  {
    kind: 'cli-spawn',
    re: /\b(?:spawn|spawnSync|execSync|execFileSync|execFile|exec)\s*\(\s*[`'"](?:claude|codex)\b/,
  },
  {
    kind: 'cli-spawn',
    re: /subprocess\.(?:run|Popen|check_output|check_call|call)\s*\(\s*\[?\s*[`'"](?:claude|codex)\b/,
  },
  { kind: 'anthropic-api', re: /api\.anthropic\.com/ },
  { kind: 'anthropic-sdk', re: /@anthropic-ai\/sdk|new\s+Anthropic\s*\(|\banthropic\.Anthropic\s*\(/ },
  { kind: 'openai-api', re: /api\.openai\.com/ },
  { kind: 'groq-sdk', re: /\bfrom\s+groq\s+import\s+Groq\b|new\s+Groq\s*\(|\bGroq\s*\(/ },
  { kind: 'bedrock', re: /bedrock-runtime/ },
  { kind: 'openai-key', re: /OPENAI_API_KEY/ },
  { kind: 'anthropic-key', re: /ANTHROPIC_API_KEY/ },
];

// A file already on the ladder/guard imports the universal askAI ladder or the
// charged API guard.
const LADDER_REQUIRE =
  /require\([^)]*ask-ai|from\s+['"][^'"]*ask-ai|charged-llm-api-guard|chargedLlmApiApprovedForDirectSurface|charged_llm_api_allowed/;

const SELF = 'scripts/audit-llm-callsites.js';

function isEnvKeyScrubLine(line, kind) {
  const trimmed = String(line || '').trim();
  if (kind === 'openai-key') return /^delete\s+env\.OPENAI_API_KEY\b/.test(trimmed);
  if (kind === 'anthropic-key') {
    return /^delete\s+env\.(?:ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN)\b/.test(trimmed);
  }
  return false;
}

function walk(dir, root, files) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) {
      if (EXCLUDE_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      walk(full, root, files);
    } else if (e.isFile() && CODE_EXT.test(e.name) && !TEST_FILE.test(e.name)) {
      files.push(full);
    }
  }
  return files;
}

function scan(root) {
  const sites = [];
  const fileHasLadder = new Map();
  for (const full of walk(root, root, [])) {
    const rel = path.relative(root, full).replace(/\\/g, '/');
    if (rel === SELF) continue; // the scanner names its own patterns
    let content;
    try {
      content = fs.readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    const lines = content.split('\n');
    let matched = false;
    for (let i = 0; i < lines.length; i++) {
      for (const p of PATTERNS) {
        if (p.re.test(lines[i]) && !isEnvKeyScrubLine(lines[i], p.kind)) {
          sites.push({ file: rel, line: i + 1, kind: p.kind });
          matched = true;
        }
      }
    }
    if (matched) fileHasLadder.set(rel, LADDER_REQUIRE.test(content));
  }
  const notInLadder = [...fileHasLadder.keys()]
    .filter((f) => !ALLOWLIST.has(f) && !fileHasLadder.get(f))
    .sort();
  return { generated: new Date().toISOString(), sites, notInLadder };
}

function main(argv) {
  const args = argv.slice(2);
  const rootIdx = args.indexOf('--root');
  const outIdx = args.indexOf('--out');
  const root = rootIdx >= 0 ? path.resolve(args[rootIdx + 1]) : path.resolve(__dirname, '..');
  const out =
    outIdx >= 0
      ? path.resolve(args[outIdx + 1])
      : path.join(root, 'data', 'agent', 'llm-callsite-audit.json');
  const report = scan(root);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  const fileCount = new Set(report.sites.map((s) => s.file)).size;
  console.log(
    `[audit-llm-callsites] ${report.sites.length} sites across ${fileCount} files; ` +
      `${report.notInLadder.length} files not in ladder`,
  );
  console.log(`[audit-llm-callsites] wrote ${out}`);
}

if (require.main === module) {
  try {
    main(process.argv);
  } catch (e) {
    console.error('[audit-llm-callsites] ' + (e && e.message));
  }
  process.exit(0); // REPORT-ONLY: an audit must never fail a pipeline
}

module.exports = { scan, ALLOWLIST, PATTERNS };
