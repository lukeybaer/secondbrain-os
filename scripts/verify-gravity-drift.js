#!/usr/bin/env node
'use strict';
//
// verify-gravity-drift.js -- the mechanical heart of the Laws of Amy Gravity.
//
// Law g0 says a rule that is not mechanically enforced does not exist. This
// lint applies g0 to the laws themselves: every row in memory/AMY_GRAVITY.md
// must point at enforcement that EXISTS and is WIRED, so a law physically
// cannot decay to memory-only without this going red. Checks per token type:
//
//   test:<path>       file exists on disk
//   hook:<name>@user     name appears in a command in claude-config/settings.json
//   hook:<name>@project  name appears in a command in .claude/settings.json
//   npm:<script>      script exists in package.json
//   lib:/script:<path> file exists on disk
//   policy:<path>     file exists on disk
//   registry:<id>     row id exists in the CORE COMPONENTS block of memory/MEMORY.md
//   ledger:<path>     file exists on disk
//
// Plus structural rules: unique ids, >=1 keyword, >=1 enforcement token,
// closed status vocabulary, row cap (MAX_LAWS), never-list core present, and
// the g0 teeth: a row whose only tokens are policy: cannot claim SOLID or
// PARTIAL.
//
// Run: npm run verify:gravity-drift. Runs on every land via
// scripts/__tests__/core.test.js. Companion test:
// scripts/__tests__/verify-gravity-drift.test.js
//
// Exit 0 clean; exit 1 drift (lists every violation).

const fs = require('fs');
const path = require('path');
const {
  parseGravityBlock,
  parseRatifiedCount,
  extractNeverListCore,
  STATUSES,
  TOKEN_TYPES,
  MAX_LAWS,
} = require('./lib/gravity-registry.js');
const { parseRegistryBlock } = require('./lib/core-component-registry.js');

const REPO = path.resolve(__dirname, '..');

function fileExists(repoRel) {
  return fs.existsSync(path.join(REPO, repoRel));
}

function settingsCommands(settingsPath) {
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const out = [];
    for (const groups of Object.values(settings.hooks || {})) {
      if (!Array.isArray(groups)) continue;
      for (const group of groups) {
        for (const h of group?.hooks || []) {
          if (typeof h?.command === 'string') out.push(h.command);
        }
      }
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Lint a repo tree. Returns an array of failure strings (empty = clean).
 * repoRoot is overridable for fixture tests.
 */
function checkGravity(repoRoot = REPO) {
  const failures = [];
  const gravityPath = path.join(repoRoot, 'memory', 'AMY_GRAVITY.md');
  if (!fs.existsSync(gravityPath)) return [`memory/AMY_GRAVITY.md missing`];
  const text = fs.readFileSync(gravityPath, 'utf8');

  if (!extractNeverListCore(text)) {
    failures.push('NEVER-LIST CORE section missing or empty');
  }

  const { rows, found, strayLines } = parseGravityBlock(text);
  if (!found) return [...failures, 'LAWS section missing'];
  if (rows.length === 0) return [...failures, 'LAWS section has zero parseable rows'];
  if (rows.length > MAX_LAWS) {
    failures.push(`row cap exceeded: ${rows.length} laws > ${MAX_LAWS}; retire one to add one`);
  }

  // Codex review 75636d17f4b1: a mangled or vanished row must never land
  // green. Every nonblank line inside the LAWS block parses as a row, and the
  // parsed count matches the machine-read ratified count in the preamble.
  for (const s of strayLines || []) {
    failures.push(
      `LAWS block line ${s.line}: unparseable content (mangled or malformed row): "${s.text}"`,
    );
  }
  const ratified = parseRatifiedCount(text);
  if (ratified === null) {
    failures.push('missing "Ratified rows: N" line in the laws file preamble');
  } else if (rows.length !== ratified) {
    failures.push(
      `parsed ${rows.length} law rows but the preamble ratifies ${ratified}; a law vanished or appeared without an amendment`,
    );
  }

  const seen = new Set();
  const userCommands = settingsCommands(path.join(repoRoot, 'claude-config', 'settings.json'));
  const projectCommands = settingsCommands(path.join(repoRoot, '.claude', 'settings.json'));

  const exists = (rel) => fs.existsSync(path.join(repoRoot, rel));

  for (const row of rows) {
    const where = `${row.id} (line ${row.line})`;
    if (seen.has(row.id)) failures.push(`${where}: duplicate id`);
    seen.add(row.id);
    if (!STATUSES.includes(row.status)) {
      failures.push(`${where}: status "${row.status}" not in ${STATUSES.join('|')}`);
    }
    if (row.keywords.length === 0) failures.push(`${where}: no keywords`);
    if (row.enforcement.length === 0) failures.push(`${where}: no enforcement tokens`);
    if (!exists(row.authority)) failures.push(`${where}: authority file missing: ${row.authority}`);

    const mechanical = row.enforcement.filter((t) => t.type !== 'policy');
    if (mechanical.length === 0 && (row.status === 'SOLID' || row.status === 'PARTIAL')) {
      failures.push(
        `${where}: only policy: tokens but claims ${row.status}; law g0 forbids that (POLICY or PROPOSED only)`,
      );
    }

    for (const tok of row.enforcement) {
      const label = `${where} token ${tok.type}:${tok.value}`;
      if (!TOKEN_TYPES.includes(tok.type)) {
        failures.push(`${label}: ExampleCo token type`);
        continue;
      }
      if (tok.type === 'npm') {
        let scripts = {};
        try {
          scripts =
            JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).scripts || {};
        } catch {
          /* package.json unreadable -> counted below */
        }
        if (!scripts[tok.value]) failures.push(`${label}: npm script not in package.json`);
      } else if (tok.type === 'hook') {
        const commands = tok.scope === 'project' ? projectCommands : userCommands;
        const file =
          tok.scope === 'project' ? '.claude/settings.json' : 'claude-config/settings.json';
        if (!tok.scope || (tok.scope !== 'user' && tok.scope !== 'project')) {
          failures.push(`${label}: hook token needs @user or @project scope`);
        } else if (!commands) {
          failures.push(`${label}: ${file} missing or unparseable`);
        } else if (!commands.some((c) => c.includes(tok.value))) {
          failures.push(`${label}: not registered in any command in ${file}`);
        }
        const hookPath = `scripts/claude-hooks/${tok.value}`;
        if (!exists(hookPath)) failures.push(`${label}: hook script missing on disk: ${hookPath}`);
      } else if (tok.type === 'registry') {
        let memText = '';
        try {
          memText = fs.readFileSync(path.join(repoRoot, 'memory', 'MEMORY.md'), 'utf8');
        } catch {
          /* handled below */
        }
        const registry = parseRegistryBlock(memText);
        if (!registry.rows.some((r) => r.id === tok.value)) {
          failures.push(`${label}: no CORE COMPONENTS registry row with id "${tok.value}"`);
        }
      } else {
        // test / lib / script / policy / ledger: a repo-relative file
        if (!exists(tok.value)) failures.push(`${label}: file missing on disk: ${tok.value}`);
      }
    }
  }
  return failures;
}

function main() {
  const failures = checkGravity();
  if (failures.length === 0) {
    console.log(`[verify-gravity-drift] CLEAN: every law's enforcement exists and is wired.`);
    process.exit(0);
  }
  console.error(`[verify-gravity-drift] DRIFT: ${failures.length} violation(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  console.error(
    'A law whose enforcement is missing or unwired has decayed to memory-only (law g0). Fix the wiring or amend the laws file via the gravity-lock protocol.',
  );
  process.exit(1);
}

if (require.main === module) main();
module.exports = { checkGravity };
