'use strict';

// Static require-resolution scanner (2026-07-06 deploy-outage fix).
//
// Root cause of the incident this exists to prevent: scripts/deploy-ec2-server.sh
// ships ec2-server.js plus a hand-curated LIVE_DEPS file list. `node -c` (the
// deploy script's only pre-restart check) syntax-checks a file but never
// resolves its requires, so a new `require('./scripts/lib/whatever')` added to
// ec2-server.js (or to anything it transitively requires) that is NOT in
// LIVE_DEPS is invisible until PM2 actually loads the module and crash-loops
// with MODULE_NOT_FOUND in production.
//
// This module walks the relative-require closure of one or more entry files
// UNDER A GIVEN ROOT and reports every relative require that does not resolve
// to a file on disk. It intentionally only follows `require('./x')` /
// `require('../x')` specs (never node_modules / bare specifiers), because
// node_modules resolution is a completely different failure mode (already
// covered by npm install, not by a curated file-copy list) and walking it
// would drag the scanner into scanning third-party packages it has no business
// asserting about.
//
// Used two ways:
//   1. scripts/require-scan-check.js -- a thin CLI the deploy script runs
//      against the LIVE EC2 checkout after copying files but before pm2 restart.
//   2. scripts/verify-unattended-morning.sh -- the nightly canary runs the same
//      CLI against the deployed server.js so an incomplete deploy is caught by
//      the canary, not by a live crash the next morning.

const fs = require('node:fs');
const path = require('node:path');

// Matches require('./x'), require("../x"), require(`./x`) -- deliberately NOT
// bare specifiers (require('lodash')) or dynamic requires with a variable.
const RELATIVE_REQUIRE_RE = /require\(\s*['"`](\.[^'"`]+)['"`]\s*\)/g;

/**
 * Resolve a relative require spec the same way Node's CommonJS resolver
 * would for a plain .js file: exact path, then .js/.cjs/.json, then
 * <dir>/index.js. Returns null if nothing on disk matches.
 * @param {string} fromFile absolute path of the file containing the require
 * @param {string} spec the relative spec, e.g. "./lib/foo"
 * @returns {string|null} absolute resolved path, or null if unresolved
 */
function resolveRelativeRequire(fromFile, spec) {
  const raw = path.resolve(path.dirname(fromFile), spec);
  const candidates = [
    raw,
    `${raw}.js`,
    `${raw}.cjs`,
    `${raw}.json`,
    path.join(raw, 'index.js'),
    path.join(raw, 'index.cjs'),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/**
 * Extract every relative require spec literal from a file's source text.
 * @param {string} src
 * @returns {string[]}
 */
function extractRelativeRequireSpecs(src) {
  const specs = [];
  RELATIVE_REQUIRE_RE.lastIndex = 0;
  let m;
  while ((m = RELATIVE_REQUIRE_RE.exec(String(src || '')))) {
    specs.push(m[1]);
  }
  return specs;
}

/**
 * Walk the relative-require closure starting from one or more entry files and
 * report every spec that fails to resolve to a file on disk.
 *
 * @param {object} args
 * @param {string[]} args.entryFiles absolute paths of entry files to start from
 * @returns {{
 *   ok: boolean,
 *   scanned: string[],
 *   missing: Array<{from:string, spec:string}>,
 * }}
 */
function scanRequireClosure({ entryFiles }) {
  const seen = new Set();
  const queue = [...entryFiles];
  const missing = [];
  const scanned = [];

  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);

    let src;
    try {
      src = fs.readFileSync(file, 'utf8');
    } catch {
      // The entry file itself (or a file we already resolved to) is unreadable.
      // Treat as missing so a broken entry point cannot silently no-op the scan.
      missing.push({ from: '(entry)', spec: file });
      continue;
    }
    scanned.push(file);

    for (const spec of extractRelativeRequireSpecs(src)) {
      const resolved = resolveRelativeRequire(file, spec);
      if (!resolved) {
        missing.push({ from: file, spec });
        continue;
      }
      if (/\.(js|cjs)$/.test(resolved) && !seen.has(resolved)) {
        queue.push(resolved);
      }
    }
  }

  return { ok: missing.length === 0, scanned, missing };
}

module.exports = { scanRequireClosure, resolveRelativeRequire, extractRelativeRequireSpecs };
