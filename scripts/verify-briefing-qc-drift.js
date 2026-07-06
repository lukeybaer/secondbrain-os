#!/usr/bin/env node
/**
 * verify-briefing-qc-drift.js
 *
 * DRIFT-LINT for the Briefing QC core component. This is the mechanical
 * prevention that keeps design-equals-code from drifting (per
 * dev-plans/core/briefing-qc.md). It FAILS (exit 1) if any of the load-bearing
 * invariants in that design doc are violated:
 *
 *   1. ONE render-QC. Exactly one tool may scan the LIVE dashboard and assert
 *      per-card render status. The authoritative one is
 *      scripts/verify-dashboard-cards-live.js. A second render-QC (the historical
 *      scripts/verify-briefing-cards-live.js) is drift and fails the lint. We
 *      detect render-QC tools structurally: a scripts/*.js that BOTH fetches the
 *      live dashboard (a /briefing fetch) AND asserts per-card render status
 *      (parses data-section tiles + a tile color/status). The single allowed file
 *      is verify-dashboard-cards-live.js; any other matching file is a second QC.
 *
 *   2. WIRED into the publish path. The render-QC must be referenced (require or
 *      spawn) by BOTH publish paths: cloud-morning-briefing.js AND
 *      overnight-briefing-orchestrator.js. An unwired render-QC is a QC that never
 *      runs against the published product (the exact 2026-06-21 failure).
 *
 *   3. DESIGN DOC present + authoritative. dev-plans/core/briefing-qc.md must
 *      exist and must name verify-dashboard-cards-live.js as THE one QC.
 *
 * USAGE:
 *   node scripts/verify-briefing-qc-drift.js
 *   npm run verify:briefing-qc-drift
 *
 * EXIT CODES:
 *   0  no drift.
 *   1  drift detected (each violation printed).
 *
 * The check functions are exported pure (they take a repoRoot) so the regression
 * test can run the lint against the hardened tree (passes) and against a temp
 * tree with a second render-QC or an unwired build (fails), with no network.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const RENDER_QC = 'verify-dashboard-cards-live.js';
const DESIGN_DOC = path.join('dev-plans', 'core', 'briefing-qc.md');
const PUBLISH_PATHS = ['cloud-morning-briefing.js', 'overnight-briefing-orchestrator.js'];

function readFileSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

// Strip JS comments (block + line) so a COMMENT that merely mentions the render-QC
// filename can NEVER satisfy the wiring check. A bare `src.includes(RENDER_QC)` is
// trivially bypassed by a doc-comment naming the file; the wiring must be real
// code. We do a string-aware scan so we do not strip `//` or `/* */` that live
// inside a string/template literal (those are legitimate code referencing the QC).
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let quote = null; // ', ", or ` when inside a string/template literal
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') {
        // Keep the escaped char verbatim.
        if (i + 1 < n) out += src[i + 1];
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      out += c;
      i += 1;
      continue;
    }
    if (c === '/' && next === '/') {
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

// A real wiring reference to the render-QC: a require/import of it, a spawn of it
// (spawnSync/execFile/runStep with the filename as an argument), or a call to a
// helper that runs it (runRenderQc/runDashboardRenderQc/dashboardRenderQc). A bare
// mention in prose does NOT match. The filename is escaped for the RegExp; the base
// name (without .js) also counts because require/spawn callers often drop the ext.
function hasRealRenderQcWiring(src) {
  const code = stripComments(src);
  const fileBase = RENDER_QC.replace(/\.js$/, '');
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const name = esc(RENDER_QC);
  const base = esc(fileBase);
  const wiringPatterns = [
    // require('./verify-dashboard-cards-live.js') / require('./verify-dashboard-cards-live')
    new RegExp(`require\\(\\s*['"\`][^'"\`]*${base}(?:\\.js)?['"\`]`),
    // import ... from '.../verify-dashboard-cards-live(.js)'
    new RegExp(`from\\s*['"\`][^'"\`]*${base}(?:\\.js)?['"\`]`),
    // spawnSync/execFile/runStep(..., ['scripts/verify-dashboard-cards-live.js', ...])
    new RegExp(`(?:spawnSync|execFile|execFileSync|spawn|runStep)\\b[\\s\\S]{0,200}?${name}`),
    // a string arg literally naming the script path passed to a runner
    new RegExp(`['"\`][^'"\`]*${name}['"\`]`),
  ];
  return wiringPatterns.some((re) => re.test(code));
}

// The drift-lint itself names the render-status fingerprint strings (in its own
// detection regexes), so it would self-match. Exclude it (and only it) from the
// render-QC scan; it is a lint, not a render-QC.
const SELF = path.basename(__filename);

function listScriptFiles(scriptsDir) {
  try {
    return fs
      .readdirSync(scriptsDir)
      .filter((f) => f.endsWith('.js') && f !== SELF)
      .sort();
  } catch {
    return [];
  }
}

// A render-QC tool is one that BOTH fetches the live dashboard AND asserts a
// per-card render status off the rendered tiles. We detect that structurally so a
// renamed copy of the same tool is still caught (category, not a literal filename):
//   - fetch signal: it references the /briefing dashboard endpoint, OR resolves
//     the dashboard token, OR curls the dashboard. (the live-fetch fingerprint)
//   - per-card-render signal: it parses `data-section` tiles AND reads a
//     `tile-<color>`/tile status class off them. (the render-status fingerprint)
// A file needs BOTH to count as a render-QC. The markdown validator
// (validate-briefing-quality.js) reads markdown, not rendered tiles, so it never
// matches the render-status fingerprint and is correctly NOT counted.
const FETCH_LIVE_RE =
  /\/briefing\?|\/briefing"|localhost:3001\/briefing|SB_BRIEFING_TOKEN|buildBriefingDashboardUrl/;
const PARSE_TILES_RE = /data-section=/;
// The render-status fingerprint: a render-QC pulls the tile's color/status class
// off the parsed section. Both render-QC tools extract it with a
// `tile-(red|green|...)` alternation against the `class="tile ..."` markup. We
// match that whether it is written as a literal class token (`tile-red`) or as the
// regex alternation the tools actually use (`tile-(red|green|...`), via an optional
// `(` and `?:` before the first color. A markdown validator never reads rendered
// tile colors, so it does not match.
const TILE_STATUS_RE = /tile-\(?(?:\?:)?(?:red|green|yellow|neutral|ExampleCo|warn)\b/;

function isRenderQcSource(src) {
  const fetchesLive = FETCH_LIVE_RE.test(src);
  const parsesTiles = PARSE_TILES_RE.test(src);
  const readsStatus = TILE_STATUS_RE.test(src);
  return fetchesLive && parsesTiles && readsStatus;
}

// 1. Exactly one render-QC, and it is the canonical file.
function checkSingleRenderQc(repoRoot) {
  const scriptsDir = path.join(repoRoot, 'scripts');
  const failures = [];
  const found = [];
  for (const file of listScriptFiles(scriptsDir)) {
    const src = readFileSafe(path.join(scriptsDir, file));
    if (isRenderQcSource(src)) found.push(file);
  }
  if (!found.includes(RENDER_QC)) {
    failures.push(
      `the authoritative render-QC ${RENDER_QC} was not found (or no longer fetches the live dashboard and asserts per-card render status). There must be exactly one render-QC and it must be ${RENDER_QC}.`,
    );
  }
  const extras = found.filter((f) => f !== RENDER_QC);
  if (extras.length) {
    failures.push(
      `more than one render-QC tool exists: ${found.join(', ')}. Only ${RENDER_QC} may scan the live dashboard and assert per-card render status; fold ${extras.join(', ')} into it.`,
    );
  }
  return { failures, found };
}

// 2. The render-QC is referenced (require or spawn) by every publish path.
function checkWiredIntoPublish(repoRoot) {
  const scriptsDir = path.join(repoRoot, 'scripts');
  const failures = [];
  for (const pub of PUBLISH_PATHS) {
    const src = readFileSafe(path.join(scriptsDir, pub));
    if (!src) {
      failures.push(
        `publish path ${pub} is missing or unreadable; the render-QC cannot be wired into it.`,
      );
      continue;
    }
    if (!hasRealRenderQcWiring(src)) {
      failures.push(
        `publish path ${pub} does not reference ${RENDER_QC} in real code (no require/import/spawn; a comment mentioning the filename does not count). The render-QC must run against the published product on every publish path.`,
      );
    }
  }
  return { failures };
}

// THE canonical defect-count library (ExampleCo 2026-07-06 shared-paradigm fix):
// scripts/lib/live-board-truth.js must exist and be required by BOTH the
// dashboard tile renderer (ec2-server.js) and the markdown builder
// (cloud-morning-briefing.js), so the tile badge/headline and the markdown
// reconciliation line can never drift onto two different derivations of the
// defect count.
const CANONICAL_COUNT_LIB = 'scripts/lib/live-board-truth.js';
const CANONICAL_COUNT_CONSUMERS = ['ec2-server.js', 'cloud-morning-briefing.js'];

// 3. The design doc exists and names the render-QC as THE one QC.
function checkDesignDoc(repoRoot) {
  const docPath = path.join(repoRoot, DESIGN_DOC);
  const failures = [];
  const src = readFileSafe(docPath);
  if (!src) {
    failures.push(
      `design doc ${DESIGN_DOC} is missing. It is the authoritative design-equals-code spec for briefing QC.`,
    );
    return { failures };
  }
  if (!src.includes(RENDER_QC)) {
    failures.push(
      `design doc ${DESIGN_DOC} does not name ${RENDER_QC} as the one render-QC. The doc and the code must agree on the single QC.`,
    );
  }
  if (!src.includes(CANONICAL_COUNT_LIB)) {
    failures.push(
      `design doc ${DESIGN_DOC} does not name ${CANONICAL_COUNT_LIB} as the canonical defect-count library (ExampleCo 2026-07-06 shared-paradigm fix).`,
    );
  }
  return { failures };
}

// 4. Every canonical-count consumer requires live-board-truth.js in real code.
// Uses the same comment-stripped, real-code wiring check as
// checkWiredIntoPublish (a doc-comment naming the file does not count).
function hasRealLiveBoardTruthWiring(src) {
  const code = stripComments(src);
  return /require\(\s*['"`][^'"`]*live-board-truth(?:\.js)?['"`]/.test(code);
}

function checkCanonicalCountLib(repoRoot) {
  const failures = [];
  const libPath = path.join(repoRoot, 'scripts', 'lib', 'live-board-truth.js');
  const libSrc = readFileSafe(libPath);
  if (!libSrc) {
    failures.push(
      `the canonical defect-count library ${CANONICAL_COUNT_LIB} is missing. It is the ONE schema + reader every count consumer (dashboard tile, markdown, chat, self-heal) must read through.`,
    );
    return { failures };
  }
  for (const required of [
    'defectiveCardCount',
    'buildLiveBoardArtifact',
    'readLiveBoardArtifact',
    'isStale',
  ]) {
    if (!libSrc.includes(required)) {
      failures.push(
        `${CANONICAL_COUNT_LIB} no longer exports ${required}; consumers depend on this exact function name.`,
      );
    }
  }
  for (const consumerRel of CANONICAL_COUNT_CONSUMERS) {
    const consumerPath =
      consumerRel === 'ec2-server.js'
        ? path.join(repoRoot, consumerRel)
        : path.join(repoRoot, 'scripts', consumerRel);
    const consumerSrc = readFileSafe(consumerPath);
    if (!consumerSrc) {
      failures.push(`canonical-count consumer ${consumerRel} is missing or unreadable.`);
      continue;
    }
    if (!hasRealLiveBoardTruthWiring(consumerSrc)) {
      failures.push(
        `${consumerRel} does not require ${CANONICAL_COUNT_LIB} in real code (no require/import; a comment mentioning the filename does not count). Every consumer must read the SAME artifact through the SAME library, never recompute the defect count independently.`,
      );
    }
  }
  return { failures };
}

function runDrift(repoRoot = REPO_ROOT) {
  const failures = [];
  const single = checkSingleRenderQc(repoRoot);
  failures.push(...single.failures);
  failures.push(...checkWiredIntoPublish(repoRoot).failures);
  failures.push(...checkDesignDoc(repoRoot).failures);
  failures.push(...checkCanonicalCountLib(repoRoot).failures);
  return { ok: failures.length === 0, failures, renderQcFound: single.found };
}

function main() {
  const result = runDrift(REPO_ROOT);
  if (result.ok) {
    console.log(
      `briefing QC drift-lint PASS: exactly one render-QC (${RENDER_QC}), wired into ${PUBLISH_PATHS.join(' + ')}, and named in ${DESIGN_DOC}.`,
    );
    process.exit(0);
  }
  console.error(`briefing QC drift-lint FAILED: ${result.failures.length} drift issue(s):`);
  for (const f of result.failures) console.error('  - ' + f);
  process.exit(1);
}

module.exports = {
  runDrift,
  isRenderQcSource,
  checkSingleRenderQc,
  checkWiredIntoPublish,
  checkDesignDoc,
  checkCanonicalCountLib,
  hasRealLiveBoardTruthWiring,
  stripComments,
  hasRealRenderQcWiring,
  RENDER_QC,
  DESIGN_DOC,
  PUBLISH_PATHS,
  CANONICAL_COUNT_LIB,
  CANONICAL_COUNT_CONSUMERS,
};

if (require.main === module) main();
