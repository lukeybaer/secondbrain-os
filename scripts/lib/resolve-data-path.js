'use strict';
const path = require('node:path');

/**
 * Resolve a briefing-relative path to an absolute path, honoring the data dir
 * the BUILD actually wrote to.
 *
 * Why: the cloud build runs with SECONDBRAIN_DATA_DIR=/opt/secondbrain/data and
 * reads its runtime artifacts (shorts/mortgage/action-items/...) from there, but
 * validate-briefing-quality.js joined every `data/...` path to the REPO root, so
 * on the cloud host it read an empty repo `data/` and FALSELY reported
 * "shorts proposal JSON missing" / "mortgage-rate JSON missing" (2026-06-22),
 * disagreeing with the builder and the render-QC. A `data/` path must resolve
 * under the same data dir the build used; everything else stays REPO-relative
 * (source, fixtures). When no dataDir is given, falls back to REPO/data so
 * local/test behavior is unchanged.
 *
 * @param {string} rel  briefing-relative path, e.g. 'data/agent/shorts-proposals/2026-06-22.json'
 * @param {{repo: string, dataDir?: string|null}} opts
 * @returns {string} absolute path
 */
function resolveDataPath(rel, { repo, dataDir } = {}) {
  const norm = String(rel == null ? '' : rel).replace(/\\/g, '/');
  const base = dataDir ? path.resolve(dataDir) : path.join(repo, 'data');
  if (norm === 'data') return base;
  if (norm.startsWith('data/')) {
    return path.join(base, norm.slice('data/'.length));
  }
  // Non-data path: REPO-relative (source files, fixtures, etc.).
  return path.join(repo, norm);
}

module.exports = { resolveDataPath };
