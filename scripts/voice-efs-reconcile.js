#!/usr/bin/env node
/**
 * voice-efs-reconcile.js -- copy Fargate-resolved voice artifacts off the EFS
 * mount into the local data dirs the EC2 dashboard reads.
 *
 * Phase 2 read-side. The Fargate task writes enriched transcripts, the voice
 * identity registry, and the *-latest.json intelligence artifacts to shared EFS
 * (mounted on EC2 at $VOICE_EFS_MOUNT, default /mnt/sbvoice). EC2 itself is a
 * deploy target (not a git checkout) serving the public dashboard from
 * /opt/secondbrain/data. This script reconciles the two: newer-on-EFS files are
 * copied into the local dashboard dirs. Per-call artifacts are one-directional
 * (EFS -> local). The identity registry never comes back from Fargate: it is a
 * read-only job input staged from EC2 before launch. Global top-level voiceprint
 * reports also stay local-authoritative. The EFS corpus is only a processing
 * subset, so its aggregate counts can never replace full-corpus EC2 reports even
 * when the EFS file has a newer mtime.
 *
 * It does NOT touch people files (those are git-authoritative and synced on the
 * PC/git machine, not here).
 */

const fs = require('fs');
const path = require('path');

const EFS = process.env.VOICE_EFS_MOUNT || '/mnt/sbvoice';
const LOCAL =
  process.env.SECONDBRAIN_DATA_DIR || process.env.SECONDBRAIN_DATA || '/opt/secondbrain/data';

// Subtrees the dashboard reads that the Fargate task produces. People files are
// intentionally excluded (git-authoritative).
const SUBTREES = [
  'otter/enriched',
  'otter/raw',
  'life-archive/voiceprints',
];

function walk(dir, base = dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, base, out);
    else out.push(path.relative(base, full));
  }
  return out;
}

function copyIfNewer(src, dst) {
  let ss;
  try { ss = fs.statSync(src); } catch { return 'src_missing'; }
  let ds = null;
  try { ds = fs.statSync(dst); } catch { /* missing locally */ }
  // Keep local when it is newer than the EFS copy (a fresher dashboard write
  // must never be clobbered). When mtimes are equal, a size difference means a
  // truncated/partial local copy, so recover from EFS.
  if (ds && ds.mtimeMs > ss.mtimeMs) return 'skip_uptodate';
  if (ds && ds.mtimeMs === ss.mtimeMs && ds.size === ss.size) return 'skip_uptodate';
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  // Stage beside the destination, then rename. Some historical EC2 voice
  // runs left root-owned cache files behind. Opening those files for an
  // in-place copy fails for the scheduled ec2-user reconciler even though it
  // owns the parent directory. A same-directory rename is atomic and replaces
  // the stale inode without requiring write permission on that inode.
  const staged = `${dst}.reconcile-${process.pid}-${Date.now().toString(36)}.tmp`;
  try {
    fs.copyFileSync(src, staged);
    fs.renameSync(staged, dst);
  } finally {
    try { fs.rmSync(staged, { force: true }); } catch { /* best effort */ }
  }
  return ds ? 'updated' : 'created';
}

// The EC2 store has the full Otter corpus. Fargate's EFS has only the subset
// staged for container processing. Every top-level voiceprints file is therefore
// a global/report artifact and must be rebuilt locally rather than copied from a
// partial denominator. Nested probes, references, caches, and per-run evidence
// remain valid Fargate outputs and continue to reconcile.
function isLocalCanonicalVoiceprintArtifact(subtree, relativePath) {
  if (subtree !== 'life-archive/voiceprints') return false;
  return path.dirname(relativePath) === '.';
}

function reconcile() {
  const report = { schema: 'life_archive_voice_efs_reconcile.v2', generated_at: new Date().toISOString(), efs: EFS, local: LOCAL, created: 0, updated: 0, skipped: 0, excluded_local_rollups: 0, errors: [] };
  if (!fs.existsSync(EFS)) {
    report.errors.push(`EFS mount not present at ${EFS}`);
    return report;
  }
  for (const sub of SUBTREES) {
    const efsDir = path.join(EFS, sub);
    if (!fs.existsSync(efsDir)) continue;
    for (const rel of walk(efsDir)) {
      if (isLocalCanonicalVoiceprintArtifact(sub, rel)) {
        report.excluded_local_rollups += 1;
        continue;
      }
      try {
        const r = copyIfNewer(path.join(efsDir, rel), path.join(LOCAL, sub, rel));
        if (r === 'created') report.created += 1;
        else if (r === 'updated') report.updated += 1;
        else report.skipped += 1;
      } catch (e) {
        report.errors.push(`${sub}/${rel}: ${e.message}`);
      }
    }
  }
  return report;
}

if (require.main === module) {
  const report = reconcile();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.errors.length ? 1 : 0;
}

module.exports = {
  reconcile,
  copyIfNewer,
  isLocalCanonicalVoiceprintArtifact,
};
