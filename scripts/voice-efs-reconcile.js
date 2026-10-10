#!/usr/bin/env node
/**
 * voice-efs-reconcile.js -- copy Fargate-resolved voice artifacts off the EFS
 * mount into the local data dirs the EC2 dashboard reads.
 *
 * Phase 2 read-side. The Fargate task writes enriched transcripts, the voice
 * identity registry, and the *-latest.json intelligence artifacts to shared EFS
 * (mounted on EC2 at $VOICE_EFS_MOUNT, default /mnt/sbvoice). EC2 itself is a
 * deploy target (not a git checkout) serving the public dashboard from
 * /opt/secondbrain/data. This script reconciles generated outputs: newer-on-EFS
 * files are copied into the local dashboard dirs. The raw transcript and identity
 * registry never come back from Fargate because both are immutable/read-only job
 * inputs staged from EC2 before launch. Global top-level voiceprint
 * reports also stay local-authoritative. The EFS corpus is only a processing
 * subset, so its aggregate counts can never replace full-corpus EC2 reports even
 * when the EFS file has a newer mtime.
 *
 * It does NOT touch people files (those are git-authoritative and synced on the
 * PC/git machine, not here).
 */

const fs = require('fs');
const path = require('path');
const {
  ROOT_RELATIVE: EXACT_ENVELOPE_ROOT_RELATIVE,
  artifactFile,
  callKey,
  envelopeInboxDir,
  envelopeSupersededDir,
  envelopeProblems,
  flattenArtifacts,
  promoteCompletionEnvelope,
} = require('./lib/otter-exact-call-envelope.js');
const { exactDispatchEventPaths } = require('./lib/otter-exact-dispatch-events.js');
const {
  reconcileExactCallAggregate,
} = require('./lib/otter-exact-call-aggregate-reconcile.js');

const EFS = process.env.VOICE_EFS_MOUNT || '/mnt/sbvoice';
const LOCAL =
  process.env.SECONDBRAIN_DATA_DIR || process.env.SECONDBRAIN_DATA || '/opt/secondbrain/data';

// Subtrees the dashboard reads that the Fargate task produces. People files are
// intentionally excluded (git-authoritative).
const SUBTREES = [
  'otter/audio-full',
  'otter/enriched',
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

function reconcileCallAudio(
  otid,
  {
    efs = EFS,
    local = LOCAL,
    fsApi = fs,
  } = {},
) {
  const exactOtid = String(otid || '').trim();
  if (!exactOtid) return { status: 'invalid_otid', path: '' };
  for (const extension of ['.mp3', '.m4a', '.wav', '.mp4']) {
    const source = path.join(efs, 'otter', 'audio-full', `${exactOtid}${extension}`);
    if (!fsApi.existsSync(source)) continue;
    const destination = path.join(
      local,
      'otter',
      'audio-full',
      `${exactOtid}${extension}`,
    );
    return {
      status: copyIfNewer(source, destination),
      source,
      path: destination,
    };
  }
  return { status: 'source_missing', path: '' };
}

// The EC2 store has the full Otter corpus. Fargate's EFS has only the subset
// staged for container processing. Every top-level voiceprints file is therefore
// a global/report artifact and must be rebuilt locally rather than copied from a
// partial denominator. Nested probes, references, caches, and per-run evidence
// remain valid Fargate outputs and continue to reconcile.
function isLocalCanonicalVoiceprintArtifact(subtree, relativePath) {
  if (subtree !== 'life-archive/voiceprints') return false;
  const parts = String(relativePath || '').split(/[\\/]/).filter(Boolean);
  const firstPart = parts[0] || '';
  // Task scratch and runtime coordination state are not durable pipeline
  // outputs. In particular, a Fargate process is PID 1 inside its container.
  // Copying its stage lock into EC2 makes host PID 1 appear to own the lock and
  // strands every exact-call healer until the stale timeout.
  if (
    firstPart === 'runs' ||
    firstPart === 'tmp' ||
    firstPart === 'otter-exact-call-envelopes'
  ) {
    return true;
  }
  if (
    parts.some(
      (part) =>
        part === 'locks' ||
        /(?:^|-)locks$/.test(part) ||
        /\.lock(?:\.|$)/.test(part),
    )
  ) {
    return true;
  }
  return path.dirname(relativePath) === '.';
}

function writeDispatchEvent({
  dataDir,
  envelope,
  finalDir,
  now = new Date(),
  fsApi = fs,
} = {}) {
  const paths = exactDispatchEventPaths(
    path.join(dataDir, 'life-archive', 'voiceprints'),
  );
  const file = path.join(paths.events, `${envelope.bundle_hash}.json`);
  const pendingFile = path.join(paths.pending, `${envelope.bundle_hash}.json`);
  const event = {
    schema: 'life_archive_otter_exact_call_dispatch_event.v1',
    type: 'exact_call_completion_bundle_promoted',
    emitted_at: now.toISOString(),
    otid: envelope.otid,
    source_revision_hash: envelope.source_revision_hash,
    bundle_hash: envelope.bundle_hash,
    producer_sha: envelope.producer_sha,
    envelope_path: path.join(finalDir, 'envelope.json'),
  };
  fsApi.mkdirSync(path.dirname(file), { recursive: true });
  fsApi.mkdirSync(path.dirname(pendingFile), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fsApi.writeFileSync(temp, `${JSON.stringify(event, null, 2)}\n`, 'utf8');
  const assertSameEvent = (candidate, candidateFile) => {
    if (
      candidate.bundle_hash !== event.bundle_hash ||
      candidate.otid !== event.otid ||
      candidate.source_revision_hash !== event.source_revision_hash
    ) {
      throw new Error(`exact-call dispatch event conflict: ${candidateFile}`);
    }
  };
  let created = false;
  try {
    try {
      fsApi.linkSync(temp, file);
      created = true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const existing = JSON.parse(fsApi.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
      assertSameEvent(existing, file);
    }
    try {
      fsApi.linkSync(file, pendingFile);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const pending = JSON.parse(fsApi.readFileSync(pendingFile, 'utf8').replace(/^\uFEFF/, ''));
      assertSameEvent(pending, pendingFile);
    }
    return {
      created,
      idempotent: !created,
      file,
      pendingFile,
      event,
    };
  } finally {
    fsApi.rmSync(temp, { force: true });
  }
}

// Promotion verifies every source artifact and stages a fully verified local
// inbox before its atomic rename. Once that inbox exists, re-running the
// always-on reconciler must not hash both copies of every artifact again.
// The poller runs every five minutes; doing the full idempotency verification
// for all historical outbox envelopes turned a no-op poll into nearly 1 GiB of
// EFS reads and kept the host above the call dispatcher's load ceiling.
//
// This is deliberately a reconcile-only fast path. The underlying promotion
// primitive remains fail-closed and fully verifies source and destination for
// first promotion and for any incomplete/conflicting inbox. Continuous
// corruption detection belongs to the exact-bundle audit lane, not the live
// ingestion poller.
function reuseVerifiedInbox({ destinationDataDir, envelopeFile, fsApi = fs } = {}) {
  let sourceEnvelope;
  try {
    sourceEnvelope = JSON.parse(fsApi.readFileSync(envelopeFile, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
  if (envelopeProblems(sourceEnvelope).length) return null;

  const finalDir = envelopeInboxDir({
    dataDir: destinationDataDir,
    otid: sourceEnvelope.otid,
    sourceRevisionHash: sourceEnvelope.source_revision_hash,
  });
  let localEnvelope;
  try {
    localEnvelope = JSON.parse(
      fsApi.readFileSync(path.join(finalDir, 'envelope.json'), 'utf8').replace(/^\uFEFF/, ''),
    );
  } catch {
    return null;
  }
  if (
    envelopeProblems(localEnvelope).length ||
    localEnvelope.bundle_hash !== sourceEnvelope.bundle_hash
  ) {
    return null;
  }

  // The inbox rename proves these bytes were hash-verified at promotion. Cheap
  // size checks keep missing/truncated files on the full verification path
  // without rereading every immutable artifact on every live poll.
  for (const descriptor of flattenArtifacts(localEnvelope.artifacts)) {
    try {
      const file = artifactFile({ bundleDir: finalDir, descriptor });
      const stat = fsApi.statSync(file);
      if (!stat.isFile() || Number(stat.size) !== Number(descriptor.bytes)) return null;
    } catch {
      return null;
    }
  }

  // Promotion and aggregate reconciliation are two separate durable steps. A
  // process can die after the atomic inbox rename but before the aggregate is
  // merged. Only the dispatch event, which is written after a successful
  // aggregate reconcile, proves the second step completed. Without it we may
  // still trust the verified inbox bytes, but must run the aggregate merge.
  const dispatchPaths = exactDispatchEventPaths(
    path.join(destinationDataDir, 'life-archive', 'voiceprints'),
  );
  const dispatchFile = path.join(dispatchPaths.events, `${localEnvelope.bundle_hash}.json`);
  let aggregateReceiptPresent = false;
  try {
    const event = JSON.parse(fsApi.readFileSync(dispatchFile, 'utf8').replace(/^\uFEFF/, ''));
    aggregateReceiptPresent =
      event?.bundle_hash === localEnvelope.bundle_hash &&
      event?.otid === localEnvelope.otid &&
      event?.source_revision_hash === localEnvelope.source_revision_hash;
  } catch {
    aggregateReceiptPresent = false;
  }

  return {
    promoted: false,
    idempotent: true,
    fastPath: aggregateReceiptPresent,
    verificationMode: aggregateReceiptPresent
      ? 'trusted_verified_inbox_and_dispatch'
      : 'trusted_verified_inbox_reconcile_required',
    envelope: localEnvelope,
    finalDir,
    copiedCanonicalArtifacts: 0,
  };
}

// A scoped run (the fast path) reads only the named calls' outbox folders and
// correction envelopes, so a finished Fargate job is promoted in seconds instead
// of waiting for the full archive walk.
function scopedOtidSet(otids) {
  if (!Array.isArray(otids)) return null;
  return new Set(otids.map((value) => String(value || '').trim()).filter(Boolean));
}

function scopedRelatives(dir, scope, fsApi = fs) {
  let names = [];
  try {
    names = fsApi.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (![...scope].some((otid) => name === otid || name.startsWith(`${otid}.`))) {
      continue;
    }
    const full = path.join(dir, name);
    let stat = null;
    try {
      stat = fsApi.statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) out.push(...walk(full, dir));
    else out.push(name);
  }
  return out.sort();
}

function reconcileExactCompletionEnvelopes({
  efs = EFS,
  local = LOCAL,
  fsApi = fs,
  now = new Date(),
  otids = null,
} = {}) {
  const scope = scopedOtidSet(otids);
  const outbox = path.join(efs, EXACT_ENVELOPE_ROOT_RELATIVE, 'outbox');
  const correctionOutbox = path.join(
    efs,
    EXACT_ENVELOPE_ROOT_RELATIVE,
    'correction-outbox',
  );
  const report = {
    scanned: 0,
    promoted: 0,
    idempotent: 0,
    fast_path_idempotent: 0,
    canonical_artifacts_copied: 0,
    dispatch_events_created: 0,
    dispatch_events_idempotent: 0,
    superseded_correction_attempts: 0,
    bundles: [],
    errors: [],
  };
  const correctionInputs = [];
  const newestCorrectionByRevision = new Map();
  for (const relative of walk(correctionOutbox)
    .filter((name) => name.endsWith('.json'))
    .sort()) {
    const file = path.join(correctionOutbox, relative);
    let envelope = null;
    try {
      envelope = JSON.parse(fsApi.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    } catch {
      correctionInputs.push({ root: correctionOutbox, relative, correction: true });
      continue;
    }
    const key = `${String(envelope?.otid || '')}|${String(envelope?.source_revision_hash || '')}`;
    if (scope && !scope.has(String(envelope?.otid || ''))) continue;
    const candidate = { root: correctionOutbox, relative, correction: true, envelope };
    const existing = newestCorrectionByRevision.get(key);
    const candidateTime = Date.parse(String(envelope?.produced_at || '')) || 0;
    const existingTime = Date.parse(String(existing?.envelope?.produced_at || '')) || 0;
    if (
      !existing ||
      candidateTime > existingTime ||
      (candidateTime === existingTime && relative.localeCompare(existing.relative) > 0)
    ) {
      if (existing) report.superseded_correction_attempts += 1;
      newestCorrectionByRevision.set(key, candidate);
    } else {
      report.superseded_correction_attempts += 1;
    }
  }
  correctionInputs.push(...newestCorrectionByRevision.values());
  const inputs = [
    ...correctionInputs.sort((left, right) => left.relative.localeCompare(right.relative)),
    ...(scope
      ? [...scope].sort().flatMap((otid) =>
          walk(path.join(outbox, 'calls', callKey(otid)), outbox),
        )
      : walk(outbox)
    )
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((relative) => ({ root: outbox, relative, correction: false })),
  ];
  if (!inputs.length) return report;
  for (const input of inputs) {
    const { relative } = input;
    const envelopeFile = path.join(input.root, relative);
    report.scanned += 1;
    try {
      const sourceEnvelope = input.envelope || JSON.parse(
        fsApi.readFileSync(envelopeFile, 'utf8').replace(/^\uFEFF/, ''),
      );
      // A corrected bundle archives the prior immutable inbox. The producer's
      // append-only normal outbox intentionally retains the prior envelope, so
      // later polls must recognize that durable supersession instead of trying
      // to promote the known-bad bundle again forever.
      if (!input.correction) {
        const supersededDir = envelopeSupersededDir({
          dataDir: local,
          otid: sourceEnvelope.otid,
          sourceRevisionHash: sourceEnvelope.source_revision_hash,
          bundleHash: sourceEnvelope.bundle_hash,
        });
        const supersessionFile = path.join(supersededDir, '_supersession.json');
        if (fsApi.existsSync(supersessionFile)) {
          const supersession = JSON.parse(
            fsApi.readFileSync(supersessionFile, 'utf8').replace(/^\uFEFF/, ''),
          );
          if (
            supersession.otid === sourceEnvelope.otid &&
            supersession.source_revision_hash === sourceEnvelope.source_revision_hash &&
            supersession.prior_bundle_hash === sourceEnvelope.bundle_hash
          ) {
            report.idempotent += 1;
            continue;
          }
        }
      }
      const promoted =
        reuseVerifiedInbox({
          destinationDataDir: local,
          envelopeFile,
          fsApi,
        }) ||
        promoteCompletionEnvelope({
          sourceDataDir: efs,
          destinationDataDir: local,
          envelopeFile,
          correctionReasonCode: input.correction
            ? sourceEnvelope.correction_reason_code
            : '',
          fsApi,
        });
      // A trusted inbox is immutable proof that this exact bundle was already
      // promoted and its aggregate reconciled. Re-merging the full aggregate
      // once for every historical inbox made a five-call live handoff spend
      // more than the cron's eight-minute ceiling revisiting 350+ old calls.
      // New or incomplete bundles still take the full verified reconcile path;
      // the exact-bundle audit owns later corruption detection.
      const aggregate = promoted.fastPath
        ? { ok: true, changed: false, skipped: 'trusted_verified_inbox' }
        : reconcileExactCallAggregate({
            dataDir: local,
            otid: promoted.envelope.otid,
            sourceRevisionHash: promoted.envelope.source_revision_hash,
            now: () => now.toISOString(),
            fsApi,
            verifiedEnvelope: promoted.envelope,
            verifiedBundleDir: promoted.finalDir,
          });
      if (aggregate.ok !== true) {
        throw new Error(
          `exact-call aggregate reconcile did not prove success for ${promoted.envelope.otid}`,
        );
      }
      const dispatchEvent = writeDispatchEvent({
        dataDir: local,
        envelope: promoted.envelope,
        finalDir: promoted.finalDir,
        now,
        fsApi,
      });
      report.promoted += promoted.promoted ? 1 : 0;
      report.idempotent += promoted.idempotent ? 1 : 0;
      report.fast_path_idempotent += promoted.fastPath ? 1 : 0;
      report.canonical_artifacts_copied += promoted.copiedCanonicalArtifacts;
      report.dispatch_events_created += dispatchEvent.created ? 1 : 0;
      report.dispatch_events_idempotent += dispatchEvent.idempotent ? 1 : 0;
      report.bundles.push({
        otid: promoted.envelope.otid,
        source_revision_hash: promoted.envelope.source_revision_hash,
        bundle_hash: promoted.envelope.bundle_hash,
        promoted: promoted.promoted,
        verification_mode:
          promoted.verificationMode || (promoted.fastPath ? 'trusted_verified_inbox' : 'full'),
        aggregate_reconciled: aggregate.ok === true,
        aggregate_changed: aggregate.changed === true,
        aggregate_mode: aggregate.skipped || 'verified_bundle_merge',
        dispatch_event: dispatchEvent.file,
      });
    } catch (error) {
      report.errors.push(`${relative}: ${error.message}`);
    }
  }
  return report;
}

function reconcile({
  efs = EFS,
  local = LOCAL,
  fsApi = fs,
  now = new Date(),
  otids = null,
} = {}) {
  const scope = scopedOtidSet(otids);
  const exact = reconcileExactCompletionEnvelopes({ efs, local, fsApi, now, otids });
  const report = {
    schema: 'life_archive_voice_efs_reconcile.v3',
    generated_at: now.toISOString(),
    efs,
    local,
    created: 0,
    updated: 0,
    skipped: 0,
    excluded_local_rollups: 0,
    exact_completion_envelopes: exact,
    errors: [...exact.errors],
  };
  if (!fsApi.existsSync(efs)) {
    report.errors.push(`EFS mount not present at ${efs}`);
    return report;
  }
  for (const sub of SUBTREES) {
    const efsDir = path.join(efs, sub);
    if (!fsApi.existsSync(efsDir)) continue;
    // Scoped runs copy only the named calls' top-level transcript and audio
    // entries. The voiceprint subtree is a corpus-wide walk; its per-call
    // artifacts arrive through the promoted envelope, and the ten-minute full
    // reconcile still copies the rest.
    const relatives = scope
      ? sub === 'life-archive/voiceprints'
        ? []
        : scopedRelatives(efsDir, scope, fsApi)
      : walk(efsDir);
    for (const rel of relatives) {
      if (isLocalCanonicalVoiceprintArtifact(sub, rel)) {
        report.excluded_local_rollups += 1;
        continue;
      }
      try {
        const r = copyIfNewer(path.join(efsDir, rel), path.join(local, sub, rel));
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

function summarizeReconcileReport(report = {}) {
  const exact = report.exact_completion_envelopes || {};
  return {
    schema: 'life_archive_voice_efs_reconcile_summary.v1',
    generated_at: report.generated_at || new Date().toISOString(),
    created: Number(report.created || 0),
    updated: Number(report.updated || 0),
    skipped: Number(report.skipped || 0),
    excluded_local_rollups: Number(report.excluded_local_rollups || 0),
    exact_completion_envelopes: {
      scanned: Number(exact.scanned || 0),
      promoted: Number(exact.promoted || 0),
      idempotent: Number(exact.idempotent || 0),
      canonical_artifacts_copied: Number(exact.canonical_artifacts_copied || 0),
      dispatch_events_created: Number(exact.dispatch_events_created || 0),
      error_count: (exact.errors || []).length,
      errors: (exact.errors || []).slice(0, 10),
    },
    error_count: (report.errors || []).length,
    errors: (report.errors || []).slice(0, 10),
  };
}

if (require.main === module) {
  const otidArg = process.argv.indexOf('--otids');
  const otids =
    otidArg >= 0 && process.argv[otidArg + 1]
      ? process.argv[otidArg + 1].split(',').map((value) => value.trim()).filter(Boolean)
      : null;
  const report = reconcile({ otids });
  const output = process.argv.includes('--summary') ? summarizeReconcileReport(report) : report;
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  process.exitCode = report.errors.length ? 1 : 0;
}

module.exports = {
  reconcile,
  reconcileCallAudio,
  copyIfNewer,
  isLocalCanonicalVoiceprintArtifact,
  reconcileExactCompletionEnvelopes,
  summarizeReconcileReport,
  reuseVerifiedInbox,
  writeDispatchEvent,
  SUBTREES,
};
