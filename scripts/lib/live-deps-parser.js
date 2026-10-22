'use strict';

// Single source-of-truth parser for the LIVE_DEPS bash array in
// scripts/deploy-ec2-server.sh. Both the deploy-parity probe
// (scripts/verify-deploy-parity.js) and the regression test that checks the
// self-heal require-closure against LIVE_DEPS must read the SAME list, or the
// two can silently drift (one gets edited, the other does not, and neither
// notices). Extracted 2026-07-02 (Codex amendment 3, item W3a) so the parser
// itself is a single tested unit instead of being duplicated inline.
//
// Captures the whole array body up to the closing paren on its own line, so a
// stray ")" inside a comment does not truncate the parse.

const fs = require('node:fs');
const path = require('node:path');

/**
 * Parse the LIVE_DEPS=(...) bash array out of deploy-ec2-server.sh source text.
 * @param {string} scriptText raw text of scripts/deploy-ec2-server.sh
 * @returns {string[]} repo-relative paths, in source order, de-duplicated
 */
function parseLiveDeps(scriptText) {
  const m = String(scriptText || '').match(/LIVE_DEPS=\(([\s\S]*?)\n\)/);
  const block = m ? m[1] : '';
  const seen = new Set();
  const out = [];
  for (const mm of block.matchAll(/"(scripts\/[^"]+)"/g)) {
    if (!seen.has(mm[1])) {
      seen.add(mm[1]);
      out.push(mm[1]);
    }
  }
  return out;
}

/**
 * Convenience: read + parse LIVE_DEPS from the real deploy script on disk.
 * @param {string} [repoRoot] defaults to the repo root two levels up from this file
 * @returns {string[]}
 */
function readLiveDeps(repoRoot) {
  const root = repoRoot || path.resolve(__dirname, '..', '..');
  const scriptPath = path.join(root, 'scripts', 'deploy-ec2-server.sh');
  const text = fs.readFileSync(scriptPath, 'utf8');
  return parseLiveDeps(text);
}

module.exports = { parseLiveDeps, readLiveDeps };
