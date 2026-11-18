#!/usr/bin/env node
'use strict';
// Legacy entry point retained as reset-only. Historical decisions are audit,
// never inputs, even when exact membership and every content byte survive.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { reviewManifestSha256 } = require('./memory-consolidation-evidence.js');
const SCHEMA = 'amy.memory_consolidation_adjudications.v2';
function membershipKey(files) { return [...new Set(files || [])].sort().join('\n'); }
function rebindAdjudicationsByMembership({ adjudications = [] } = {}) {
  return { adjudications: [], reused: 0, unmatched: [], dropped: adjudications };
}
function resetFile({ clusters, adjudicationsPath, now = new Date() }) {
  if (!clusters.review_session_id) throw Error('Scan has no fresh review_session_id; rescan first');
  // Preserve raw bytes outside the active input. No prior payload is parsed.
  if (fs.existsSync(adjudicationsPath)) {
    const dir = path.join(path.dirname(adjudicationsPath), 'memory-consolidation-audit');
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(adjudicationsPath, path.join(dir, 'adjudications-' + crypto.randomUUID() + '.json'));
  }
  const payload = { schema: SCHEMA, generated_at: now.toISOString(),
    review_session_id: clusters.review_session_id,
    review_manifest_sha256: reviewManifestSha256(clusters.review_manifest || {}),
    coverage: [], adjudications: [] };
  fs.writeFileSync(adjudicationsPath, JSON.stringify(payload, null, 2) + '\n');
  return { adjudications: [], reused: 0, unmatched: clusters.clusters || [], dropped: [] };
}
function rebindFile({ clustersPath, adjudicationsPath, now = new Date() }) {
  return resetFile({ clusters: JSON.parse(fs.readFileSync(clustersPath, 'utf8')), adjudicationsPath, now });
}
module.exports = { SCHEMA, membershipKey, rebindAdjudicationsByMembership, rebindFile, resetFile };
if (require.main === module) {
  const repo = path.resolve(__dirname, '..', '..');
  const result = rebindFile({ clustersPath: process.argv[2] || path.join(repo, 'data/agent/memory-consolidation-clusters.json'),
    adjudicationsPath: process.argv[3] || path.join(repo, 'data/agent/memory-consolidation-adjudications.json') });
  process.stdout.write('memory-consolidation reset: zero reuse; ' + result.unmatched.length + ' clusters require fresh review\n');
}
