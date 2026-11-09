#!/usr/bin/env node
'use strict';

// One-shot, idempotent repair for duplicate cluster ids in the derived
// recluster artifact (life-archive/voiceprints/recluster-latest.json).
//
// Before the minting fix, a newly minted unknown cluster could receive the same
// hash id as a cluster that inherited it, so two clusters shared one id. This
// script keeps the durable owner of each duplicated id and re-keys every other
// cluster in the group with the same deterministic minting rule the recluster
// uses (voice-global-recluster.js mintUniqueClusterId).
//
// Keeper order: confirmed or frozen identity, then inherited id, then larger
// size, then earlier position. Confirmed or frozen clusters are never re-keyed;
// a group with two of them is refused for human review.
//
// Dry run by default. --apply writes recluster-latest.json atomically under the
// recluster publish lock and writes a receipt. Touches no raw archive, no
// enriched call, no registry, and no historical recluster-runs file.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  assertUniqueClusterIds,
  findDuplicateClusterIds,
  mintUniqueClusterId,
  resolvePaths,
} = require('./voice-global-recluster.js');
const {
  acquireReclusterPublishLock,
  saveJsonAtomic,
} = require('./lib/recluster-publish-lock.js');

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function isProtected(cluster) {
  return Boolean(
    cluster?.frozen ||
      cluster?.confirmed_person_id ||
      String(cluster?.cluster_id || '').startsWith('person:'),
  );
}

function keeperRank(cluster, index) {
  return [isProtected(cluster) ? 0 : 1, cluster?.inherited_id ? 0 : 1, -Number(cluster?.size || cluster?.members?.length || 0), index];
}

function compareRank(left, right) {
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

function planDedupe(report) {
  const clusters = report?.clusters || [];
  const duplicates = findDuplicateClusterIds(clusters);
  const usedIds = new Set(clusters.map((cluster) => cluster.cluster_id));
  const changes = [];
  const refused = [];
  for (const group of duplicates) {
    const ranked = group.indexes
      .map((index) => ({ index, rank: keeperRank(clusters[index], index) }))
      .sort((a, b) => compareRank(a.rank, b.rank));
    const protectedCount = group.indexes.filter((index) => isProtected(clusters[index])).length;
    if (protectedCount > 1) {
      refused.push({
        cluster_id: group.cluster_id,
        indexes: group.indexes,
        reason: 'multiple_confirmed_or_frozen_clusters_share_id',
      });
      continue;
    }
    const keeper = ranked[0].index;
    for (const { index } of ranked.slice(1)) {
      const cluster = clusters[index];
      const members = (cluster.members || []).map((member) => ({ key: member.track_key }));
      const seedMembers = members.length
        ? members
        : (cluster.member_track_keys || []).map((key) => ({ key }));
      const newId = mintUniqueClusterId(seedMembers, usedIds);
      usedIds.add(newId);
      changes.push({
        old_cluster_id: group.cluster_id,
        new_cluster_id: newId,
        index,
        kept_index: keeper,
        kept_size: Number(clusters[keeper].size || clusters[keeper].members?.length || 0),
        kept_inherited_id: Boolean(clusters[keeper].inherited_id),
        rekeyed_size: Number(cluster.size || cluster.members?.length || 0),
        rekeyed_inherited_id: Boolean(cluster.inherited_id),
        rekeyed_observations: (cluster.members || []).map(
          (member) => `${member.otid}|${member.speaker_model_label}`,
        ),
      });
    }
  }
  return { duplicates, changes, refused };
}

function applyPlan(report, plan, receiptPath) {
  const next = { ...report, clusters: (report.clusters || []).map((cluster) => ({ ...cluster })) };
  for (const change of plan.changes) {
    const cluster = next.clusters[change.index];
    if (cluster.cluster_id !== change.old_cluster_id) {
      throw new Error(`plan drift at index ${change.index}: expected ${change.old_cluster_id}`);
    }
    cluster.cluster_id = change.new_cluster_id;
  }
  next.id_dedupe_repairs = [
    ...(report.id_dedupe_repairs || []),
    {
      repaired_at: new Date().toISOString(),
      receipt: receiptPath,
      changes: plan.changes.map(({ old_cluster_id, new_cluster_id, index }) => ({
        old_cluster_id,
        new_cluster_id,
        index,
      })),
    },
  ];
  assertUniqueClusterIds(next.clusters, 'voice-recluster-dedupe-ids');
  return next;
}

function parseArgs(argv) {
  const value = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    apply: argv.includes('--apply'),
    dataDir: value('--data-dir'),
    latest: value('--latest'),
  };
}

function run(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const paths = resolvePaths(options.dataDir);
  const latestPath = path.resolve(options.latest || paths.latest);
  const receiptsDir = path.join(path.dirname(latestPath), 'recluster-id-dedupe-receipts');
  const readLatest = () => {
    const text = fs.readFileSync(latestPath, 'utf8');
    return { text, report: JSON.parse(text) };
  };

  let { text, report } = readLatest();
  let plan = planDedupe(report);
  const summary = {
    mode: options.apply ? 'apply' : 'dry-run',
    latest: latestPath,
    run_id: report.run_id || null,
    clusters: (report.clusters || []).length,
    duplicate_ids: plan.duplicates.map((row) => ({
      cluster_id: row.cluster_id,
      indexes: row.indexes,
    })),
    changes: plan.changes,
    refused: plan.refused,
    wrote: false,
  };
  if (!plan.changes.length || !options.apply) {
    if (plan.changes.length) {
      summary.note =
        'dry run: pass --apply to write; affected enriched call projections refresh on the next targeted incremental recluster of these otids';
    }
    return { summary, exitCode: plan.refused.length ? 2 : 0 };
  }

  const lock = acquireReclusterPublishLock(latestPath);
  try {
    // Re-read inside the lock so a concurrent publish cannot be overwritten.
    ({ text, report } = readLatest());
    plan = planDedupe(report);
    summary.changes = plan.changes;
    summary.refused = plan.refused;
    if (!plan.changes.length) return { summary, exitCode: plan.refused.length ? 2 : 0 };
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const receiptPath = path.join(receiptsDir, `${stamp}-${report.run_id || 'unknown'}.json`);
    const next = applyPlan(report, plan, receiptPath);
    // Durable audit first: a prepared receipt with the full before/after plan
    // exists before the artifact changes, so a failed final receipt write can
    // never leave a repair without evidence (Codex deploy review 2026-09-28).
    const receipt = {
      kind: 'recluster_id_dedupe_repair',
      status: 'prepared',
      generated_at: new Date().toISOString(),
      latest: latestPath,
      run_id: report.run_id || null,
      before_sha256: sha256(text),
      after_sha256: null,
      changes: plan.changes,
      refused: plan.refused,
      touched: [latestPath],
    };
    saveJsonAtomic(receiptPath, receipt);
    saveJsonAtomic(latestPath, next);
    const afterText = fs.readFileSync(latestPath, 'utf8');
    saveJsonAtomic(receiptPath, {
      ...receipt,
      status: 'applied',
      applied_at: new Date().toISOString(),
      after_sha256: sha256(afterText),
    });
    summary.wrote = true;
    summary.receipt = receiptPath;
    return { summary, exitCode: plan.refused.length ? 2 : 0 };
  } finally {
    lock.release();
  }
}

if (require.main === module) {
  try {
    const { summary, exitCode } = run();
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    process.exitCode = exitCode;
  } catch (error) {
    console.error(error?.stack || error);
    process.exitCode = 1;
  }
}

module.exports = { planDedupe, applyPlan, run };
