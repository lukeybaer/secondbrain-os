#!/usr/bin/env node
'use strict';

// Cluster IDs are presentation sequence numbers, not identities. Rebind prior
// judgments only when the exact sorted file membership survives a new scan.
// Changed clusters are emitted as unreviewed so the report gate stays closed
// until a human or LLM reads and adjudicates the new membership.

const fs = require('node:fs');
const path = require('node:path');
const { reviewManifestSha256 } = require('./memory-consolidation-evidence.js');

function membershipKey(files) {
  return [...new Set((files || []).map((file) => String(file || '')))].sort().join('\n');
}

function rebindAdjudicationsByMembership({ clusters = [], adjudications = [] } = {}) {
  const priorClusters = adjudications.filter((row) => /^cluster-/.test(String(row.cluster_id || '')));
  const actionRows = adjudications.filter((row) => !/^cluster-/.test(String(row.cluster_id || '')));
  const byMembership = new Map();
  for (const row of priorClusters) {
    const key = membershipKey(row.files);
    if (!key || byMembership.has(key)) {
      throw new Error(`duplicate or empty prior cluster membership: ${row.cluster_id || '(missing id)'}`);
    }
    byMembership.set(key, row);
  }

  let reused = 0;
  const rebound = clusters.map((cluster) => {
    const exact = byMembership.get(membershipKey(cluster.files));
    if (exact) {
      reused += 1;
      return { ...exact, cluster_id: cluster.id, files: [...cluster.files] };
    }
    return {
      cluster_id: cluster.id,
      verdict: 'ambiguous',
      reviewed: 'unreviewed',
      files: [...(cluster.files || [])],
      rationale: 'Cluster membership changed after the prior adjudication and requires a fresh read.',
      question: 'Fresh adjudication required before this memory-consolidation result can publish.',
      applied: false,
    };
  });
  const matchedKeys = new Set(clusters.map((cluster) => membershipKey(cluster.files)));
  const dropped = priorClusters.filter((row) => !matchedKeys.has(membershipKey(row.files)));
  return {
    adjudications: [...rebound, ...actionRows],
    reused,
    unmatched: rebound.filter((row) => row.reviewed === 'unreviewed'),
    dropped,
  };
}

function rebindFile({ clustersPath, adjudicationsPath, now = new Date() }) {
  const clusters = JSON.parse(fs.readFileSync(clustersPath, 'utf8'));
  const prior = JSON.parse(fs.readFileSync(adjudicationsPath, 'utf8'));
  const rebound = rebindAdjudicationsByMembership({
    clusters: clusters.clusters || [],
    adjudications: prior.adjudications || [],
  });
  const payload = {
    ...prior,
    generated_at: now.toISOString(),
    review_manifest_sha256: reviewManifestSha256(clusters.review_manifest || {}),
    adjudications: rebound.adjudications,
  };
  fs.writeFileSync(adjudicationsPath, `${JSON.stringify(payload, null, 2)}\n`);
  return rebound;
}

module.exports = { membershipKey, rebindAdjudicationsByMembership, rebindFile };

if (require.main === module) {
  const repo = path.resolve(__dirname, '..', '..');
  const clustersPath = process.argv[2] || path.join(repo, 'data', 'agent', 'memory-consolidation-clusters.json');
  const adjudicationsPath = process.argv[3] || path.join(repo, 'data', 'agent', 'memory-consolidation-adjudications.json');
  const result = rebindFile({ clustersPath, adjudicationsPath });
  process.stdout.write(
    `memory-consolidation-adjudication-rebind: ${result.reused} exact reuse, ${result.unmatched.length} fresh review, ${result.dropped.length} prior membership set(s) retired\n`,
  );
}
