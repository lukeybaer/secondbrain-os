'use strict';

/**
 * Orphaned voice name-judge proposals.
 *
 * A whole-call name judgment is stored keyed by `input_fingerprint`, a sha256
 * over the cluster id plus the FULL normalized member list. Any recluster that
 * changes membership, even by merging in OLDER calls rather than new speech,
 * moves that fingerprint. The queue builder looks the judgment up by EXACT
 * fingerprint, so the completed proposal stops resolving and the row falls back
 * to `name_judge_status: pending` forever. The proposal is still on disk and is
 * never shown to ExampleCo.
 *
 * ExampleCo 2026-08-24: "does this happen for many others? where the name suggestion
 * is known but forgotten? make sure that can't happen again."
 *
 * This module answers three questions from the artifacts themselves, never from
 * an estimate:
 *   1. which completed proposals no longer resolve to their cluster;
 *   2. which of those are still trustworthy enough to surface WITHOUT paying a
 *      model to re-derive evidence that already exists;
 *   3. how many are stranded, so a health signal can turn red on a recluster
 *      that strands work instead of deferring in silence.
 *
 * Admissibility is deliberately a MIRROR of the gate in
 * scripts/voice-confirmation-queue-build.js. Recovery must never surface a name
 * that could not have been surfaced before the recluster, so the bar here is
 * the same bar, never a looser one. The mirror is pinned by a category test
 * (scripts/__tests__/voice-name-judge-orphans.test.js) that fails if the two
 * gates ever disagree.
 */

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { fingerprintCluster } = require('./voice-name-judge-coverage.js');

const JUDGE_FILE_RE = /^name-judge-.*\.json$/i;
const UNKNOWN_CLUSTER_RE = /^unknown_voice_ecapa_/;
const RECOVERED_SCHEMA = 'whole_call_marked_target_name_judge_recovered.v1';

/**
 * Prove, rather than infer, that a judgment still describes this exact cluster.
 *
 * Nothing softer is allowed to authorize a re-key, because a re-key stamps
 * `coverage_complete: true` and hands the name to ExampleCo as savable. Two weaker
 * ideas were tried and both are wrong:
 *   - equal member COUNTS: a cluster can swap Speaker 1 for Speaker 4 inside a
 *     call it already had, and the count never moves;
 *   - equal `source_revision`: that hashes the raw Otter payload, not the
 *     diarization, so a re-diarization of unchanged audio leaves it identical
 *     while the speaker tracks move underneath it.
 *
 * The fingerprint itself is the only honest witness. It is a sha256 over the
 * cluster id plus every member's otid, speaker label, cluster id and merge
 * provenance, so reproducing the RECORDED fingerprint from today's members
 * proves the judged member list and today's member list are the same list. Only
 * the merge-provenance field is varied, since that is the field a recluster
 * rewrites without touching what was heard. A preimage match is certainty; no
 * match is a refusal.
 */
function membershipProvenIdentical(cluster, judgedFingerprint, summary = {}) {
  // Immutable track identity is REQUIRED, and no artifact written before
  // 2026-08-24 has it.
  //
  // The fingerprint hashes cluster id, otid, speaker label and merge provenance.
  // It does not hash diarization boundaries or any track content, so a
  // re-diarization can hand the label `Speaker 1` to different speech and still
  // reproduce the old digest. Reproducing it therefore proves the METADATA is
  // unchanged, never that the same voice was judged. Re-keying on that would
  // stamp `coverage_complete: true` over speech nobody examined, which is how a
  // name gets attached to the wrong person, the one outcome worth more than
  // every proposal in this report.
  //
  // So re-key is gated on `member_track_keys`, a recorded, immutable list of the
  // exact tracks the judge consumed. Legacy artifacts have none and are routed
  // to a re-judge instead. This is deliberately unreachable today; it becomes
  // reachable the moment the judge records that field, and not one moment
  // earlier.
  const recordedTrackKeys = (summary?.member_track_keys || [])
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  if (!recordedTrackKeys.length) {
    return {
      proven: false,
      reason:
        'the judgment did not record which speaker tracks it consumed, so an identical fingerprint cannot prove the same voice was judged',
    };
  }
  const currentTrackKeys = new Set(
    (cluster?.members || [])
      .map((member) => `${String(member?.otid || '')}|${String(member?.speaker_model_label || '')}`)
      .filter((value) => value !== '|'),
  );
  if (
    recordedTrackKeys.length !== currentTrackKeys.size ||
    recordedTrackKeys.some((key) => !currentTrackKeys.has(key))
  ) {
    return { proven: false, reason: 'the speaker tracks in this cluster are not the tracks that were judged' };
  }
  return membershipMetadataReproduces(cluster, judgedFingerprint);
}

function membershipMetadataReproduces(cluster, judgedFingerprint) {
  const target = String(judgedFingerprint || '');
  if (!target || !cluster) return { proven: false, reason: 'no recorded fingerprint to reproduce' };
  const members = cluster.members || [];
  if (!members.length) return { proven: false, reason: 'the cluster has no members' };
  const clusterId = String(cluster.cluster_id || '');
  // Provenance rewrites a recluster is known to perform, applied to TODAY's
  // members. Everything that describes what was actually heard, the call and the
  // speaker label, is held fixed and never guessed.
  const provenanceVariants = [
    (member) => member?.source_voice_cluster_ids || [],
    () => [],
    (member) => [String(member?.voice_cluster_id || '')].filter(Boolean),
    () => [clusterId],
  ];
  const clusterIdVariants = [
    (member) => String(member?.voice_cluster_id || ''),
    () => clusterId,
    () => '',
  ];
  for (const provenance of provenanceVariants) {
    for (const memberClusterId of clusterIdVariants) {
      const candidate = {
        cluster_id: clusterId,
        members: members.map((member) => ({
          otid: member?.otid,
          speaker_model_label: member?.speaker_model_label,
          voice_cluster_id: memberClusterId(member),
          source_voice_cluster_ids: provenance(member),
        })),
      };
      if (fingerprintCluster(candidate) === target) {
        return { proven: true, reason: '' };
      }
    }
  }
  return {
    proven: false,
    reason: 'the recorded fingerprint cannot be reproduced from the current members',
  };
}

// Membership relations between what a judgment covered and what the cluster
// carries now.
const RELATION = {
  // Same calls AND the same number of speaker tracks. The fingerprint moved on
  // provenance only (a merge rewrote source_voice_cluster_ids), so the judged
  // acoustic content is byte-for-byte the same content.
  SAME_MEMBERSHIP: 'same_membership',
  // Same calls, different track count: the cluster gained or lost a diarized
  // speaker track inside a call it already had. The call list looks unchanged
  // but the voice being judged is not provably the same one.
  TRACKS_CHANGED: 'tracks_changed',
  CALLS_ADDED: 'calls_added', // judged set is a SUBSET of current (the PRIVATE_NAME case)
  CALLS_REMOVED: 'calls_removed', // judged set is a SUPERSET of current
  DIVERGED: 'diverged', // calls both added and removed
  UNKNOWN: 'unknown', // judged call set not recorded, cannot be compared
};

// What to do with an orphan.
const ACTION = {
  // Re-key: the judgment still covers exactly this cluster, so it can be
  // rewritten under the current fingerprint and becomes a normal, savable
  // proposal again. No model spend.
  REKEY: 'rekey',
  // Surface with the coverage gap stated: the evidence still clears the gate
  // but no longer covers every call, so the name is shown as a proposal and
  // withheld from save until a re-judge covers the current membership.
  SURFACE: 'surface',
  // Re-judge: the calls carrying the name evidence are gone, or the covered set
  // cannot be proven, so the old answer is not trustworthy.
  REJUDGE: 'rejudge',
  // Never was a proposal. A judgment that found no admissible name is not
  // withheld work and must never be resurrected as one.
  NOT_A_PROPOSAL: 'not_a_proposal',
};

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return fallback;
  }
}

function numericJudgeConfidence(value) {
  if (typeof value === 'number') return value;
  const raw = String(value || '').toLowerCase();
  if (/confirmed|high|strong/.test(raw)) return 0.9;
  if (/medium|moderate/.test(raw)) return 0.65;
  if (/weak|low/.test(raw)) return 0.3;
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? numeric : 0;
}

/**
 * The admissibility gate, mirrored from loadWholeCallNameJudges. Counts are
 * passed in rather than read off the row so the same gate can be re-applied to
 * the SUBSET of evidence that survives a cluster shrink.
 */
function evidenceClearsGate({ clear, independent, selfIntro, counter, confidence, evidence }) {
  const admissible =
    selfIntro >= 1 ||
    independent >= 2 ||
    clear >= 2 ||
    (clear >= 1 &&
      (evidence || []).some(
        (row) =>
          /strong|clear|explicit/i.test(String(row?.strength || '')) &&
          /direct|address|handoff|intro|ident/i.test(String(row?.type || '')),
      )) ||
    (clear >= 1 && numericJudgeConfidence(confidence) >= 0.7);
  const counterDominates = counter >= 2 && counter >= clear && independent < 2 && selfIntro < 1;
  return admissible && !counterDominates;
}

function rowClearsGate(row = {}) {
  return evidenceClearsGate({
    clear: Number(row.direct_name_evidence_count || row.clear_evidence_count || 0),
    independent: Number(row.independent_evidence_windows || 0),
    selfIntro: Number(row.self_intro_evidence_count || 0),
    counter: Number(row.counterevidence_count || 0),
    confidence: row.confidence,
    evidence: row.evidence,
  });
}

function otidFromWindowId(windowId) {
  return String(windowId || '').split(':')[0] || '';
}

/**
 * The calls a judgment actually covered. `source_revision_by_otid` is the
 * producer-authored record of what went into the judge, so it is the primary
 * source. Older artifacts that predate it fall back to the otids named by the
 * evidence windows, which is a floor rather than the true set, so those are
 * marked `derived` and never used to claim a call was REMOVED.
 */
function judgedCallOtids(summary = {}, row = {}) {
  const recorded = Object.keys(summary?.source_revision_by_otid || {})
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  if (recorded.length) return { otids: new Set(recorded), source: 'recorded' };
  const scoped = (summary?.scoped_otids || [])
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  if (scoped.length) return { otids: new Set(scoped), source: 'recorded' };
  const derived = new Set(
    (row?.evidence || []).map((entry) => otidFromWindowId(entry?.window_id)).filter(Boolean),
  );
  return { otids: derived, source: derived.size ? 'derived' : 'missing' };
}

function clusterCallOtids(cluster = {}) {
  const fromOtids = (cluster.otids || [])
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  if (fromOtids.length) return new Set(fromOtids);
  return new Set(
    (cluster.members || []).map((member) => String(member?.otid || '').trim()).filter(Boolean),
  );
}

/**
 * Compare what was judged against what the cluster is now.
 *
 * `judgedMemberCount` is the summary's `actual_member_count`, the number of
 * speaker tracks the judge actually consumed. Comparing it to the cluster's
 * current member count is what separates a harmless provenance-only fingerprint
 * move from a real change of the voice being judged. 2026-08-24 audit: 33 of 34
 * unchanged-call-set orphans had identical member counts, and one (cluster
 * 05a810d0, "PRIVATE_NAME") had lost a track inside a call it kept. Without this check
 * that one would have been re-keyed as if nothing changed.
 */
function membershipRelation({
  judged,
  current,
  judgedSource = 'recorded',
  judgedMemberCount = 0,
  currentMemberCount = 0,
}) {
  if (!judged || !judged.size || !current || !current.size) return RELATION.UNKNOWN;
  let added = 0;
  let removed = 0;
  for (const otid of current) if (!judged.has(otid)) added += 1;
  for (const otid of judged) if (!current.has(otid)) removed += 1;
  // A derived judged set is a floor, not the true membership, so a call it does
  // not name is not provably absent. Never claim REMOVED from it.
  if (judgedSource === 'derived' && removed > 0) return RELATION.UNKNOWN;
  if (!added && !removed) {
    const bothKnown = Number(judgedMemberCount) > 0 && Number(currentMemberCount) > 0;
    if (!bothKnown) return RELATION.TRACKS_CHANGED;
    return Number(judgedMemberCount) === Number(currentMemberCount)
      ? RELATION.SAME_MEMBERSHIP
      : RELATION.TRACKS_CHANGED;
  }
  if (added && !removed) return RELATION.CALLS_ADDED;
  if (!added && removed) return RELATION.CALLS_REMOVED;
  return RELATION.DIVERGED;
}

/**
 * Re-apply the ORIGINAL gate to only the evidence whose call is still in the
 * cluster. Used when the cluster shrank: the name evidence may have left with
 * the calls that were split out, and surfacing a proposal whose support is gone
 * would be inventing a name.
 */
function survivingEvidenceClearsGate(row = {}, currentOtids = new Set()) {
  const bestName = String(row?.best_name || '')
    .trim()
    .toLowerCase();
  const surviving = (row?.evidence || []).filter((entry) =>
    currentOtids.has(otidFromWindowId(entry?.window_id)),
  );
  const supporting = surviving.filter(
    (entry) =>
      String(entry?.name || '')
        .trim()
        .toLowerCase() === bestName,
  );
  const counter = surviving.length - supporting.length;
  const independent = new Set(supporting.map((entry) => String(entry?.window_id || ''))).size;
  // Every signal is recomputed from the evidence that SURVIVED. The aggregate
  // confidence and self-introduction counts on the row describe calls that may
  // have left the cluster, so borrowing them would let evidence that is gone
  // keep vouching for a name. Confidence is deliberately passed as 0: the only
  // thing allowed to carry a surviving proposal is surviving evidence.
  const survivingSelfIntro = supporting.filter((entry) =>
    /intro|self/i.test(String(entry?.type || '')),
  ).length;
  return {
    surviving_evidence_clears_gate: evidenceClearsGate({
      clear: supporting.length,
      independent,
      selfIntro: survivingSelfIntro,
      counter,
      confidence: 0,
      evidence: supporting,
    }),
    surviving_self_intro_evidence: survivingSelfIntro,
    surviving_supporting_evidence: supporting.length,
    surviving_counterevidence: counter,
    surviving_evidence_windows: independent,
  };
}

/**
 * Decide what to do with one orphaned judgment.
 *
 * Recovery never lowers the bar. A judgment is re-keyed only when it still
 * covers exactly this cluster; it is surfaced with a stated coverage gap when
 * the evidence survives but no longer covers everything; and it is sent back to
 * the judge when the evidence that carried the name is gone.
 */
function recoveryDecision(row, summary, cluster, options = {}) {
  if (!rowClearsGate(row) || !String(row?.best_name || '').trim()) {
    return {
      action: ACTION.NOT_A_PROPOSAL,
      relation: RELATION.UNKNOWN,
      reason: 'the judgment produced no admissible name, so there is nothing withheld',
    };
  }
  const judged = judgedCallOtids(summary, row);
  const current = clusterCallOtids(cluster);
  const currentMemberCount = (cluster?.members || []).length || Number(cluster?.member_count || 0);
  const relation = membershipRelation({
    judged: judged.otids,
    current,
    judgedSource: judged.source,
    judgedMemberCount: Number(summary?.actual_member_count || 0),
    currentMemberCount,
  });
  const base = {
    relation,
    judged_call_count: judged.otids.size,
    current_call_count: current.size,
    judged_member_count: Number(summary?.actual_member_count || 0),
    current_member_count: currentMemberCount,
    judged_call_source: judged.source,
  };
  if (relation === RELATION.SAME_MEMBERSHIP) {
    const proof = membershipProvenIdentical(
      cluster,
      String(row?.input_fingerprint || '') || String(summary?.input_fingerprint || ''),
      summary,
    );
    if (proof.proven) {
      return {
        ...base,
        action: ACTION.REKEY,
        membership_proven_identical: true,
        reason:
          'the recorded fingerprint is reproducible from the current members, which proves the judged member list and the current member list are the same list',
      };
    }
    return {
      ...base,
      action: ACTION.SURFACE,
      membership_proven_identical: false,
      reason: `the call list is unchanged but coverage cannot be proven: ${proof.reason}`,
    };
  }
  if (relation === RELATION.CALLS_ADDED || relation === RELATION.TRACKS_CHANGED) {
    return {
      ...base,
      action: ACTION.SURFACE,
      reason:
        relation === RELATION.CALLS_ADDED
          ? 'the cluster gained calls, every judged call is still a member, so the proposal is under-covered rather than wrong'
          : 'the call list is unchanged but the speaker tracks moved, so coverage can no longer be claimed complete',
    };
  }
  if (relation === RELATION.CALLS_REMOVED || relation === RELATION.DIVERGED) {
    const surviving = survivingEvidenceClearsGate(row, current);
    if (surviving.surviving_evidence_clears_gate) {
      return {
        ...base,
        ...surviving,
        action: ACTION.SURFACE,
        reason:
          'the cluster lost calls but the evidence that survives still clears the original admissibility gate',
      };
    }
    return {
      ...base,
      ...surviving,
      action: ACTION.REJUDGE,
      reason: 'the calls carrying the name evidence are no longer in this cluster',
    };
  }
  return {
    ...base,
    action: ACTION.REJUDGE,
    reason: 'the judged call set is not recorded, so the membership change cannot be proven safe',
  };
}

/**
 * Every judgment on disk for an unknown-voice target, newest first per target.
 */
function loadJudgmentsByTarget(judgeDir, coverage = { files: 0, unreadable: 0, readable: false }) {
  const byTarget = new Map();
  if (!judgeDir || !fs.existsSync(judgeDir)) return byTarget;
  let files = [];
  try {
    files = fs.readdirSync(judgeDir);
  } catch {
    return byTarget;
  }
  coverage.readable = true;
  for (const name of files) {
    if (!JUDGE_FILE_RE.test(name) || name === 'name-judge-latest.json') continue;
    coverage.files += 1;
    const report = readJson(path.join(judgeDir, name), null);
    // An artifact that will not parse is not an absence of stranded work, it is
    // an unknown. Counting it as zero is how a broken read renders as a clean
    // board, which is the exact silence this metric exists to break.
    if (!report) {
      coverage.unreadable += 1;
      continue;
    }
    const summaryByTarget = new Map(
      (report.target_summaries || []).map((entry) => [String(entry?.target || ''), entry || {}]),
    );
    for (const row of report.judged?.targets || []) {
      const target = String(row?.target || '');
      if (!target || target.startsWith('known_speaker_calibration_')) continue;
      if (!UNKNOWN_CLUSTER_RE.test(target)) continue;
      const summary = summaryByTarget.get(target) || {};
      if (row?.coverage_complete !== true && summary.coverage_complete !== true) continue;
      const fingerprint =
        String(row?.input_fingerprint || '') || String(summary.input_fingerprint || '');
      if (!fingerprint) continue;
      if (!byTarget.has(target)) byTarget.set(target, []);
      byTarget.get(target).push({
        target,
        row,
        summary,
        fingerprint,
        artifact: name,
        recovered: String(report.schema || '') === RECOVERED_SCHEMA,
        generated_at: String(report.generated_at || ''),
      });
    }
  }
  for (const entries of byTarget.values()) {
    entries.sort((a, b) => String(b.generated_at).localeCompare(String(a.generated_at)));
  }
  return byTarget;
}

/**
 * Has `candidate` been judged in a way that genuinely SUPERSEDES `proposal`?
 *
 * Three things must all hold, and each of them is a way this went wrong before:
 *   - a judgment exists under the fingerprint the candidate carries right now,
 *     otherwise nothing current describes that voice at all;
 *   - it POSTDATES the retired proposal, because an older artifact cannot have
 *     taken the retired evidence into account and supersedes nothing;
 *   - it produced an admissible name, because a candidate that was judged and
 *     yielded nothing leaves the retired proposal as the only name anyone has,
 *     which is precisely a withheld name rather than a resolved one.
 */
function candidateSupersedes({ candidate, clusterById, judgments, proposal }) {
  const cluster = clusterById.get(candidate);
  const fingerprint = cluster ? fingerprintCluster(cluster) : '';
  if (!fingerprint) return false;
  return (judgments.get(candidate) || []).some(
    (entry) =>
      entry.fingerprint === fingerprint &&
      String(entry.generated_at || '') > String(proposal.generated_at || '') &&
      rowClearsGate(entry.row) &&
      Boolean(String(entry.row?.best_name || '').trim()),
  );
}

/**
 * The whole picture: every unknown cluster in the current recluster, matched
 * against every judgment on disk for it.
 *
 * `recentTargetIds` is the set the re-judge scheduler would consider under its
 * recency window. Orphans outside it are the permanent ones: nothing can ever
 * revisit them, so they stay invisible forever until this is fixed.
 */
function classifyOrphanedNameJudgments({ recluster, judgeDir, recentTargetIds = null } = {}) {
  const coverage = { files: 0, unreadable: 0, readable: false };
  const judgments = loadJudgmentsByTarget(judgeDir, coverage);
  const clusters = (recluster?.clusters || []).filter(
    (cluster) =>
      !cluster?.frozen &&
      !cluster?.confirmed_person_id &&
      UNKNOWN_CLUSTER_RE.test(String(cluster?.cluster_id || '')),
  );
  const recent = recentTargetIds ? new Set(recentTargetIds) : null;
  const orphans = [];
  const counts = {
    clusters_scanned: clusters.length,
    targets_with_any_judgment: 0,
    resolves_under_current_fingerprint: 0,
    orphaned_targets: 0,
    // A judgment whose cluster id no longer exists at all. A global recluster
    // can retire a merged id or mint a new one, and such a judgment is invisible
    // to a scan that starts from current clusters. It is counted separately and
    // never silently dropped, because "we cannot find its cluster" is exactly
    // the kind of silence that hid this whole class in the first place.
    judgments_for_missing_clusters: 0,
    // Retired ids whose calls are now inside a confirmed identity. Finished
    // work, never a red, never a re-judge.
    retired_targets_already_resolved: 0,
    // Retired ids whose judged calls do not map onto exactly one unknown
    // cluster. Counted, named, never guessed at, never silently dropped.
    retired_targets_unresolvable: 0,
    // Split of the above: one half clears itself, the other cannot.
    retired_targets_auto_draining: 0,
    retired_targets_lineage_blocked: 0,
    // Retired ids whose current holder already carries its own complete
    // judgment. The old record is superseded, not withheld.
    retired_targets_superseded: 0,
    orphaned_with_admissible_proposal: 0,
    orphaned_without_admissible_proposal: 0,
    rekeyable: 0,
    surfaceable: 0,
    needs_rejudge: 0,
    outside_recency_window: 0,
    // A stale judgment with no showable name whose cluster now holds calls the
    // judge never heard. That is new evidence, so it is re-judged.
    grown_without_proposal: 0,
  };
  const grownWithoutProposal = [];
  for (const cluster of clusters) {
    const target = String(cluster.cluster_id || '');
    const entries = judgments.get(target);
    if (!entries || !entries.length) continue;
    counts.targets_with_any_judgment += 1;
    const currentFingerprint = fingerprintCluster(cluster);
    if (!currentFingerprint) continue;
    if (entries.some((entry) => entry.fingerprint === currentFingerprint)) {
      counts.resolves_under_current_fingerprint += 1;
      continue;
    }
    counts.orphaned_targets += 1;
    // The NEWEST judgment decides, then we ask whether it proposes a name. This
    // mirrors staleJudgmentForTarget in voice-confirmation-queue-build.js
    // (Codex review 2026-08-24): an older admissible proposal must not outlive a
    // newer judgment that found no admissible name. Filtering to admissible rows
    // first counted a proposal the review surface is designed never to show, so
    // the orphan could never clear (unknown_voice_ecapa_fdb3e08cdea7a3c3,
    // 2026-09-28: a newer non-admissible PRIVATE_NAME judgment superseded an August
    // admissible one).
    const newest = entries[0];
    const proposal =
      newest && rowClearsGate(newest.row) && String(newest.row?.best_name || '').trim()
        ? newest
        : null;
    if (!proposal) {
      counts.orphaned_without_admissible_proposal += 1;
      // ExampleCo 2026-09-29 on unknown_voice_ecapa_ad4e7d82af120f69: "how could you
      // not have a name guess for this guy, 9 calls". Its only judgment heard
      // 2 calls on 2026-09-20; seven later calls were never judged because
      // only stale judgments WITH a showable name were re-dispatched.
      const judged = judgedCallOtids(newest.summary, newest.row);
      const current = clusterCallOtids(cluster);
      const newCalls = [...current].filter((otid) => !judged.otids.has(otid));
      // Only a recorded call list proves growth; evidence-derived ids are a
      // floor, so a missing id there is not an unheard call.
      if (newest && judged.source === 'recorded' && newCalls.length > 0) {
        counts.grown_without_proposal += 1;
        grownWithoutProposal.push({
          target,
          judged_at: newest.generated_at,
          judged_call_count: judged.otids.size,
          current_call_count: current.size,
          new_call_count: newCalls.length,
        });
      }
      continue;
    }
    counts.orphaned_with_admissible_proposal += 1;
    const decision = recoveryDecision(proposal.row, proposal.summary, cluster);
    if (decision.action === ACTION.REKEY) counts.rekeyable += 1;
    else if (decision.action === ACTION.SURFACE) counts.surfaceable += 1;
    else counts.needs_rejudge += 1;
    const outsideRecency = recent ? !recent.has(target) : null;
    if (outsideRecency === true) counts.outside_recency_window += 1;
    orphans.push({
      target,
      best_name: String(proposal.row.best_name || '').trim(),
      confidence: proposal.row.confidence,
      confidence_numeric: numericJudgeConfidence(proposal.row.confidence),
      clear_evidence_count: Number(
        proposal.row.direct_name_evidence_count || proposal.row.clear_evidence_count || 0,
      ),
      independent_evidence_windows: Number(proposal.row.independent_evidence_windows || 0),
      counterevidence_count: Number(proposal.row.counterevidence_count || 0),
      judged_at: proposal.generated_at,
      artifact: proposal.artifact,
      judged_input_fingerprint: proposal.fingerprint,
      current_input_fingerprint: currentFingerprint,
      outside_recency_window: outsideRecency,
      ...decision,
    });
  }
  // Judgments whose target cluster id is gone from the unknown set.
  //
  // Two very different things look identical here and must not be conflated. A
  // retired id whose calls now sit in a CONFIRMED person cluster is finished
  // work, not stranded work: the voice has an identity and re-judging it would
  // manufacture a permanent false red. A retired id whose calls now sit in a
  // different UNKNOWN cluster is genuinely stranded, and the target that has to
  // be re-judged is the CURRENT id, because the resolver only accepts ids that
  // exist today.
  const liveTargets = new Set(clusters.map((entry) => String(entry?.cluster_id || '')));
  const allClusters = recluster?.clusters || [];
  // EVERY cluster holding each call, not the first one seen. A single Otter call
  // carries several speaker tracks, and those tracks can sit in different
  // clusters, so first-cluster-wins can look uniquely mapped while pointing at
  // somebody else's voice. Keeping the full set is what lets an ambiguous
  // mapping be refused instead of silently resolved.
  const clustersForOtid = new Map();
  for (const entry of allClusters) {
    for (const otid of clusterCallOtids(entry)) {
      if (!clustersForOtid.has(otid)) clustersForOtid.set(otid, []);
      clustersForOtid.get(otid).push(entry);
    }
  }
  const missingClusterTargets = [];
  const unresolvableTargets = [];
  const autoDrainingTargets = [];
  const lineageBlockedTargets = [];
  const clusterById = new Map(
    allClusters.map((entry) => [String(entry?.cluster_id || ''), entry]),
  );
  for (const [target, entries] of judgments) {
    if (liveTargets.has(target)) continue;
    const proposal = entries.find((entry) => rowClearsGate(entry.row) && entry.row?.best_name);
    if (!proposal) continue;
    const judgedOtids = judgedCallOtids(proposal.summary, proposal.row).otids;
    // One call can carry several speaker tracks sitting in DIFFERENT clusters,
    // so "the cluster that has this call" is not the same question as "the
    // cluster that has this voice". A call that maps to more than one candidate,
    // or to none, is not resolvable by call id alone, and guessing would
    // dispatch a name at the wrong speaker. Only a judged call set that maps
    // cleanly onto exactly ONE unknown cluster is dispatched; anything else is
    // counted as unresolvable and left for a human or a lineage-aware pass.
    const holdersByOtid = new Map();
    for (const otid of judgedOtids) holdersByOtid.set(otid, clustersForOtid.get(otid) || []);
    const allHolders = [...holdersByOtid.values()].flat();
    const unmapped = [...holdersByOtid.values()].filter((entries) => !entries.length).length;
    // A call that sits in MORE than one cluster cannot say which of them is this
    // voice, so it makes the whole mapping ambiguous no matter what the others
    // say.
    const ambiguousCalls = [...holdersByOtid.values()].filter(
      (entries) => entries.length > 1,
    ).length;
    const everyCallConfirmed =
      allHolders.length > 0 &&
      [...holdersByOtid.values()].every(
        (entries) =>
          entries.length > 0 &&
          entries.every((entry) => entry?.confirmed_person_id || entry?.frozen),
      );
    const currentUnknownTargets = [
      ...new Set(
        allHolders
          .filter((entry) => entry && liveTargets.has(String(entry?.cluster_id || '')))
          .map((entry) => String(entry.cluster_id)),
      ),
    ];
    if (everyCallConfirmed) {
      // Every judged call now sits inside a confirmed identity. Finished work.
      counts.retired_targets_already_resolved += 1;
      continue;
    }
    if (currentUnknownTargets.length !== 1 || unmapped || ambiguousCalls) {
      // Two very different populations were being counted as one, and calling the
      // whole thing "draining" was false for half of it.
      //
      // AUTO-DRAINING: at least one candidate cluster has not been judged yet.
      // The ordinary nightly judge will reach it, and when it does the resulting
      // judgment supersedes this record with nobody lifting a finger. 84 of these
      // resolved themselves in a single morning.
      //
      // LINEAGE-BLOCKED: every candidate has already been judged and none of them
      // supersedes, so no amount of ordinary judging will ever clear it. It needs
      // the recluster ledger followed from the retired id to the clusters that
      // inherited its calls. No such worker exists yet, so this stays a visible
      // defect. It is Amy's to build, not ExampleCo's to adjudicate.
      const anyCandidateUnjudged = currentUnknownTargets.some((candidate) => {
        const candidateCluster = clusterById.get(candidate);
        const candidateFingerprint = candidateCluster ? fingerprintCluster(candidateCluster) : '';
        if (!candidateFingerprint) return true;
        return !(judgments.get(candidate) || []).some(
          (entry) => entry.fingerprint === candidateFingerprint,
        );
      });
      // Ambiguous does not automatically mean withheld. If EVERY unknown cluster
      // that could be this voice already carries its own complete judgment under
      // its present fingerprint, then whatever this record was describing has
      // since been judged on its own terms. Nothing is hidden from ExampleCo and
      // nobody needs to adjudicate it, so reporting it would manufacture work.
      // Only an ambiguity where some candidate is still unjudged is a real
      // withheld proposal.
      const everyCandidateJudged =
        currentUnknownTargets.length > 0 &&
        !unmapped &&
        currentUnknownTargets.every((candidate) =>
          candidateSupersedes({ candidate, clusterById, judgments, proposal }),
        );
      if (everyCandidateJudged) {
        counts.retired_targets_superseded += 1;
        continue;
      }
      counts.retired_targets_unresolvable += 1;
      if (anyCandidateUnjudged) counts.retired_targets_auto_draining += 1;
      else counts.retired_targets_lineage_blocked += 1;
      (anyCandidateUnjudged ? autoDrainingTargets : lineageBlockedTargets).push({
        target,
        disposition: anyCandidateUnjudged ? 'auto_draining' : 'lineage_blocked',
      });
      unresolvableTargets.push({
        target,
        disposition: anyCandidateUnjudged ? 'auto_draining' : 'lineage_blocked',
        best_name: String(proposal.row.best_name || '').trim(),
        judged_at: proposal.generated_at,
        artifact: proposal.artifact,
        reason: ambiguousCalls
          ? 'a judged call is held by more than one cluster, so which voice this is cannot be decided from call ids'
          : unmapped
            ? 'a judged call is not in any current cluster'
            : `judged calls map onto ${currentUnknownTargets.length} unknown clusters, not one`,
      });
      continue;
    }
    // If the current holder ALREADY has a complete judgment under its own
    // present fingerprint, the retired judgment has been superseded and is not
    // withheld work. Without this check a re-judge could succeed and this row
    // would keep reporting the retired id on every later scan, forever.
    if (
      candidateSupersedes({
        candidate: currentUnknownTargets[0],
        clusterById,
        judgments,
        proposal,
      })
    ) {
      counts.retired_targets_superseded += 1;
      continue;
    }
    counts.judgments_for_missing_clusters += 1;
    missingClusterTargets.push({
      target,
      rejudge_targets: currentUnknownTargets,
      best_name: String(proposal.row.best_name || '').trim(),
      confidence: proposal.row.confidence,
      judged_at: proposal.generated_at,
      artifact: proposal.artifact,
      action: ACTION.REJUDGE,
      reason:
        'the cluster this judgment describes no longer exists under this id, so it is re-derived against the unknown cluster that now holds its calls',
    });
  }
  orphans.sort(
    (a, b) =>
      b.clear_evidence_count - a.clear_evidence_count || String(a.target).localeCompare(b.target),
  );
  counts.judge_artifacts_read = coverage.files;
  counts.judge_artifacts_unreadable = coverage.unreadable;
  counts.judge_directory_readable = coverage.readable;
  return {
    counts,
    orphans,
    grownWithoutProposal,
    judgments,
    missingClusterTargets,
    unresolvableTargets,
    autoDrainingTargets,
    lineageBlockedTargets,
    coverage,
  };
}

/**
 * Rewrite one still-covering judgment under the cluster's CURRENT fingerprint.
 *
 * This is the recovery that costs nothing: the evidence is copied verbatim, the
 * gate is not re-run at a lower bar, and the provenance of the rewrite is
 * stamped on the artifact so nobody later mistakes it for a fresh judge run.
 * Only ACTION.REKEY qualifies, which means the judged calls AND speaker tracks
 * are unchanged, so `coverage_complete: true` is the truth and not a claim.
 */
function buildRecoveredJudgeReport({ entry, cluster, currentFingerprint, generatedAt }) {
  const summary = { ...(entry.summary || {}) };
  const row = { ...(entry.row || {}) };
  const stamp = {
    recovered_from_artifact: entry.artifact,
    recovered_from_fingerprint: entry.fingerprint,
    recovered_at: generatedAt,
    recovered_reason:
      'recluster moved the membership fingerprint without changing the judged calls or speaker tracks',
    original_generated_at: entry.generated_at,
  };
  summary.input_fingerprint = currentFingerprint;
  summary.expected_call_count = clusterCallOtids(cluster).size;
  summary.actual_call_count = clusterCallOtids(cluster).size;
  summary.expected_member_count = (cluster?.members || []).length;
  summary.actual_member_count = (cluster?.members || []).length;
  summary.coverage_complete = true;
  summary.missing_call_otids = [];
  summary.missing_member_track_keys = [];
  Object.assign(summary, stamp);
  row.input_fingerprint = currentFingerprint;
  row.coverage_complete = true;
  Object.assign(row, stamp);
  return {
    schema: RECOVERED_SCHEMA,
    generated_at: generatedAt,
    model: entry.row?.model || 'recovered_no_model_call',
    judge_provider: 'name_judge_orphan_recovery',
    ...stamp,
    target_summaries: [summary],
    judged: { targets: [row], batches: [] },
  };
}

/**
 * Split stranded targets into the cohort this fix already knows about and
 * anything stranded SINCE.
 *
 * The distinction is the whole point of the row. On the day this shipped there
 * were 64 known stranded proposals, already queued for repair. Firing red for
 * those would put a fresh unexplained defect on ExampleCo's 5:30 board for a
 * condition that was being actively fixed, which is the opposite of what the
 * signal is for. A proposal stranded by a LATER recluster is the thing that must
 * never go unnoticed, and it is red the moment it appears.
 *
 * The backlog is never suppressed. It reports its own size and remaining count,
 * and it escalates to red if it stops shrinking, so a stuck repair cannot hide
 * behind "known".
 */
function splitStrandedByCohort(report = {}, baselineCohort = null) {
  const baseline = new Set(
    (baselineCohort || report.baseline_cohort || []).map(String),
  );
  const current = [
    ...(report.orphans || []).map((row) => String(row.target)),
    ...(report.judgments_for_missing_clusters || []).map((row) => String(row.target)),
    // Finding: unresolvable retired targets used to exist only as a count, so
    // they could never be attributed to a cohort and could ride along under a
    // yellow. They are named rows now and are attributed like everything else.
    ...(report.retired_targets_unresolvable_rows || []).map((row) => String(row.target)),
  ];
  const newlyStranded = current.filter((target) => !baseline.has(target));
  const knownRemaining = current.filter((target) => baseline.has(target));
  return { newlyStranded, knownRemaining, baselineSize: baseline.size };
}

const BACKLOG_STALL_DAYS = 3;

/**
 * The baseline lives in its OWN file, not inside the scan report.
 *
 * Keeping it in the report meant that deleting, truncating, or half-writing that
 * report re-seeded the baseline from whatever was stranded at that moment, which
 * would silently relabel a fresh regression as known backlog. That is the exact
 * failure this row exists to prevent, so the baseline is a separate durable
 * receipt, written once and never rewritten by a later scan.
 *
 * A MISSING baseline is red, not a fresh start. The only thing allowed to create
 * one is an explicit first initialization that stamps its own receipt.
 */
function readOrphanBaseline({ dataDir, baselinePath } = {}) {
  const file =
    baselinePath || path.join(dataDir || '', 'agent', 'voice-name-judge-orphan-baseline.json');
  const data = readJson(file, null);
  // A cohort with no release SHA and no recluster run id cannot support a
  // "stranded since" claim, so it is not a usable baseline.
  if (
    !data ||
    !Array.isArray(data.cohort) ||
    !data.initialized_at ||
    !data.release_sha ||
    !data.recluster_run_id
  ) {
    return {
      file,
      present: false,
      cohort: [],
      initialized_at: '',
      release_sha: '',
      recluster_run_id: '',
      last_progress_at: '',
      last_remaining: null,
      last_unresolvable: null,
    };
  }
  return {
    file,
    present: true,
    cohort: data.cohort.map(String),
    initialized_at: String(data.initialized_at || ''),
    // The world-state this cohort was taken against. "Stranded since" is only a
    // provable claim when the baseline names the release and the recluster run
    // it describes; without them it is an assertion.
    release_sha: String(data.release_sha || ''),
    recluster_run_id: String(data.recluster_run_id || ''),
    last_progress_at: String(data.last_progress_at || data.initialized_at || ''),
    last_remaining: data.last_remaining == null ? null : Number(data.last_remaining),
    // The attribution backlog size when the baseline was taken, so growth in it
    // can be detected rather than only its absolute size reported.
    last_unresolvable:
      data.last_unresolvable == null ? null : Number(data.last_unresolvable),
  };
}

/**
 * Health derivation for the SYSTEM HEALTH board.
 *
 * Nonzero orphans is a RED, not a backlog. An orphan is work the system already
 * finished and then lost track of, which is exactly the failure that went
 * unnoticed until ExampleCo asked why a name he had never been shown was missing.
 * A cluster that has simply never been judged is NOT an orphan and never counts
 * here, so this row cannot turn red just because the backlog is large.
 */
function readVoiceNameJudgeOrphanHealth({ dataDir, artifactPath, reclusterPath, baselinePath } = {}) {
  const file =
    artifactPath || path.join(dataDir || '', 'agent', 'voice-name-judge-orphans-latest.json');
  const report = readJson(file, null);
  // NOT YET MEASURED is its own state, distinct from both green and red.
  //
  // This row shipped to a box that had never run its producer. Rendering that
  // as a red would put a fresh unexplained defect on ExampleCo's 5:30 board for a
  // condition nobody has measured yet, on the night he asked for fewer
  // unexplained reds. It is not green either: an unmeasured count is not a
  // zero. It reports as a warning that says exactly what it is and what to run.
  if (!report) {
    return {
      status: 'yellow',
      count: null,
      not_yet_measured: true,
      detail:
        'stranded name proposals have not been surveyed on this build yet. ' +
        'Run node scripts/voice-name-judge-orphan-report.js, then --init-baseline once.',
      artifact: file,
    };
  }
  // The scan is only meaningful against the recluster it scanned. Any recluster
  // that publishes new membership without running the recovery leaves this row
  // reporting a count for a cluster set that no longer exists, which is how a
  // stale green would hide a fresh batch of stranded proposals. Binding the row
  // to the recluster run id makes that impossible: the row goes red until the
  // recovery runs again.
  const reclusterFile =
    reclusterPath || path.join(dataDir || '', 'life-archive', 'voiceprints', 'recluster-latest.json');
  const currentRun = String(readJson(reclusterFile, {})?.run_id || '');
  const scannedRun = String(report.recluster_run_id || '');
  const counts = report.counts || {};
  const lineageBlocked = Number(counts.retired_targets_lineage_blocked || 0);
  const autoDraining = Number(counts.retired_targets_auto_draining || 0);
  // Fail closed. An unreadable recluster, a missing run id on either side, or a
  // report with no counts object all mean the count cannot be trusted, and an
  // untrustworthy count must never render as healthy.
  if (!currentRun || !scannedRun || !report.counts) {
    return {
      status: 'red',
      count: null,
      detail:
        'the orphan scan cannot be tied to a live recluster run, so the count is unverified. ' +
        'Run node scripts/voice-name-judge-orphan-report.js --apply',
      artifact: file,
      generated_at: report.generated_at || '',
    };
  }
  if (currentRun !== scannedRun) {
    return {
      status: 'red',
      count: null,
      detail:
        `the orphan scan describes recluster ${scannedRun} but the live recluster is ${currentRun}, ` +
        'so any proposals the newer recluster stranded are unmeasured. ' +
        'Run node scripts/voice-name-judge-orphan-report.js --apply',
      artifact: file,
      generated_at: report.generated_at || '',
    };
  }
  // Incomplete evidence is never green. If the judge directory could not be
  // read, or any artifact in it failed to parse, the count is a floor and not a
  // measurement, and a floor of zero is not proof of zero.
  if (counts.judge_directory_readable === false || Number(counts.judge_artifacts_unreadable || 0) > 0) {
    return {
      status: 'red',
      count: null,
      detail:
        `the orphan scan could not read ${Number(counts.judge_artifacts_unreadable || 0) || 'the'} judge artifact(s), ` +
        'so the count is a floor rather than a measurement. ' +
        'Run node scripts/voice-name-judge-orphan-report.js --apply',
      artifact: file,
      generated_at: report.generated_at || '',
    };
  }
  // Hidden proposals only. The retired-record attribution backlog is reported
  // separately: it is a different problem with a different owner, and folding it
  // in here made a 197-item engineering queue look like 197 names being kept
  // from ExampleCo.
  const stranded =
    Number(counts.orphaned_with_admissible_proposal || 0) +
    Number(counts.judgments_for_missing_clusters || 0);
  const baseline = readOrphanBaseline({ dataDir, baselinePath });
  // A scan that claims a baseline while the durable receipt is gone cannot be
  // trusted to tell known work from new work, so it is red rather than amber.
  // Retired-id attribution backlog.
  //
  // These are old judgments whose cluster id no longer exists and whose calls now
  // sit across SEVERAL current clusters, so which voice the record describes
  // cannot be decided from call ids alone. I first routed them to ExampleCo as a red
  // needing his decision. Measuring the live box proved that wrong twice over.
  //
  // First, the row claimed "nothing is working on these" and that is false: 84 of
  // them resolved themselves while this ran, purely because the ordinary nightly
  // judge got to a candidate cluster. The set drains on its own.
  //
  // Second, the remainder do not need a DECISION, they need lineage-aware
  // attribution: following the recluster ledger from the old id to the clusters
  // that inherited its calls. That is engineering work with an owner, not 197
  // adjudications for ExampleCo at 5:30 in the morning. Asking him to hand-resolve
  // them would be inventing work and burying the thing he actually asked for.
  //
  // So it is reported, sized, and named, and it is NOT the thing that makes this
  // row red. Red belongs to a name that is hidden from ExampleCo right now, which is
  // what he asked about. Growth is still caught: a backlog that GROWS past what
  // the baseline recorded is a regression and goes red below.
  if (!baseline.present) {
    // Surveyed but not yet triaged. Every number here describes stranding that
    // happened BEFORE this repair existed, so none of it is a new regression and
    // none of it is actionable at 5:30. It is reported in full, with its size,
    // and stays a warning until somebody establishes the baseline. It hides
    // nothing: once the baseline exists, anything stranded after it is red
    // immediately.
    const surveyed =
      Number(counts.orphaned_with_admissible_proposal || 0) +
      Number(counts.judgments_for_missing_clusters || 0);
    return {
      status: 'yellow',
      count: surveyed,
      not_yet_triaged: true,
      detail:
        `${surveyed} hidden name proposals found by the first survey of this build. ` +
        (surveyed === 0
          ? 'Zero means the scan found no stranded proposals; this is not a current orphan failure. '
          : '') +
        (autoDraining
          ? `${autoDraining} retired records are draining on their own as the judge reaches each candidate. `
          : '') +
        'The row is yellow only because this first survey has no durable baseline for comparing future scans. ' +
        (surveyed === 0
          ? 'Amy must initialize the zero baseline once; after that, zero is green and any newly stranded proposal is red.'
          : 'Whether any are new cannot be answered until a baseline exists. Amy must establish the reviewed first-survey cohort once; later new stranding is red.'),
      artifact: file,
      generated_at: report.generated_at || '',
    };
  }
  const { newlyStranded, knownRemaining, baselineSize } = splitStrandedByCohort(
    report,
    baseline.cohort,
  );
  const rekeyable = Number(counts.rekeyable || 0);
  const surfaceable = Number(counts.surfaceable || 0);
  const rejudge = Number(counts.needs_rejudge || 0);
  // Records that no amount of ordinary judging will ever clear. This is
  // lifetime backlog, so it stays yellow until the lineage worker exists.
  // needsExampleCo is
  // false on purpose: it is Amy's engineering to do, not his adjudication, and
  // marking it his would both misroute it and bury the names he asked about.
  if (lineageBlocked > 0) {
    const named = (report.retired_targets_lineage_blocked_rows || [])
      .map((row) => String(row.target))
      .slice(0, 3);
    return {
      status: 'yellow',
      count: lineageBlocked,
      lineage_blocked: lineageBlocked,
      auto_draining: autoDraining,
      needs_lineage_worker: true,
      detail:
        `${lineageBlocked} retired name records cannot be attributed to a current voice, and every candidate ` +
        'has already been judged, so ordinary re-judging will never clear them' +
        (named.length ? ` (${named.join(', ')})` : '') +
        `. They need the recluster ledger followed from the retired id to the clusters that inherited its calls. ` +
        (autoDraining ? `A further ${autoDraining} are draining on their own. ` : '') +
        'No such worker exists yet.',
      artifact: file,
      generated_at: report.generated_at || '',
    };
  }
  if (!stranded) {
    // No hidden names. If retired records are still awaiting attribution, say so
    // rather than reporting a clean board: the backlog is real work, it is just
    // not a name being kept from ExampleCo.
    if (autoDraining) {
      return {
        status: 'yellow',
        count: 0,
        attribution_backlog: autoDraining,
        detail:
          `0 name proposals are hidden. ${autoDraining} retired records are still waiting on the ordinary judge ` +
          'to reach a candidate cluster, at which point they clear themselves.',
        artifact: file,
        generated_at: report.generated_at || '',
      };
    }
    return {
      status: 'green',
      count: 0,
      detail: `0 stranded name proposals across ${Number(counts.clusters_scanned || 0)} unknown voice clusters`,
      artifact: file,
      generated_at: report.generated_at || '',
    };
  }
  // This metric owns lifetime orphan inventory. Even a newly observed member of
  // that lifetime set is yellow here. A separately defined seven-day metric may
  // grade any recent orphan red, but this all-history denominator cannot.
  if (newlyStranded.length) {
    return {
      status: 'yellow',
      count: newlyStranded.length,
      newly_stranded: newlyStranded.length,
      known_backlog_remaining: knownRemaining.length,
      detail:
        `${newlyStranded.length} name proposal(s) were stranded by a recent recluster ` +
        `(${surfaceable} surfaceable with a coverage gap / ${rejudge} need re-judging). ` +
        (knownRemaining.length ? `${knownRemaining.length} older ones are still being worked. ` : '') +
        'Run node scripts/voice-name-judge-orphan-rejudge.js',
      artifact: file,
      generated_at: report.generated_at || '',
    };
  }
  // A known lifetime backlog that is being worked. It stays yellow even when it
  // stalls; the detail still names the stalled repair without calling history a
  // current red.
  // Stall is measured from the last time the backlog actually SHRANK, not from
  // when it was first seen. Comparing against the original count meant a backlog
  // that dropped by one and then froze forever never tripped, because 63 >= 64
  // is false.
  const progressAt = Date.parse(baseline.last_progress_at || baseline.initialized_at || '') || 0;
  const daysSinceProgress = progressAt ? (Date.now() - progressAt) / 86400000 : 0;
  const stalled = knownRemaining.length > 0 && daysSinceProgress > BACKLOG_STALL_DAYS;
  if (stalled) {
    return {
      status: 'yellow',
      count: knownRemaining.length,
      known_backlog_remaining: knownRemaining.length,
      detail:
        `${knownRemaining.length} stranded name proposals have not shrunk in ${Math.floor(daysSinceProgress)} days, ` +
        'so the re-judge repair is not running. Run node scripts/voice-name-judge-orphan-rejudge.js',
      artifact: file,
      generated_at: report.generated_at || '',
    };
  }
  return {
    status: 'yellow',
    count: knownRemaining.length,
    known_backlog_remaining: knownRemaining.length,
    newly_stranded: 0,
    detail:
      `${knownRemaining.length} of ${baselineSize || knownRemaining.length} name proposals stranded before release ${baseline.release_sha.slice(0, 9)} (recluster ${baseline.recluster_run_id}) are queued for re-judging` +
      (autoDraining ? `, and ${autoDraining} retired records are draining on their own` : '') +
      `. ${surfaceable} keep their evidence, ${rejudge} need fresh evidence. No new stranding since the audit. ` +
      'Repair runs automatically after each recluster.',
    artifact: file,
    generated_at: report.generated_at || '',
  };
}

function normalizedName(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/**
 * Is this orphan's proposal actually in front of ExampleCo on the review surface?
 *
 * ACTION.SURFACE is designed to be performed by the queue builder
 * (scripts/voice-confirmation-queue-build.js staleJudgmentForTarget), which
 * attaches the prior judgment to the row as `stale_name_proposal` with the
 * coverage gap stated.
 *
 * Proof is positive and exact, never inferred:
 *   - the row is on a reviewable lane of the live queue for this exact target;
 *   - its `stale_name_proposal` carries the orphan's JUDGED fingerprint and the
 *     same heard name, and the row records that it was built on the orphan's
 *     CURRENT membership fingerprint. A same-name guess alone never counts.
 * A missing or unreadable queue proves nothing, so every orphan stays counted.
 */
function surfacedOrphanTargets(queue, orphans = []) {
  const surfaced = new Map();
  if (!queue || typeof queue !== 'object') return surfaced;
  const rows = [
    ...(Array.isArray(queue.reviewable_voice_queue) ? queue.reviewable_voice_queue : []),
    ...(Array.isArray(queue.unknown_voice_queue) ? queue.unknown_voice_queue : []),
  ].filter((row) => row && typeof row === 'object' && row.reviewable !== false);
  for (const orphan of orphans) {
    const target = String(orphan?.target || '').trim();
    const name = normalizedName(orphan?.best_name);
    if (!target || !name) continue;
    for (const row of rows) {
      const ids = [row.acoustic_unknown_id, row.voice_cluster_id, row.unknown_speaker_id].map(
        (value) => String(value || ''),
      );
      if (!ids.includes(target)) continue;
      const stale = row.stale_name_proposal || null;
      const builtOn = String(row.name_judge_input_fingerprint || '');
      if (
        stale &&
        String(stale.judged_input_fingerprint || '') ===
          String(orphan.judged_input_fingerprint || '') &&
        String(orphan.judged_input_fingerprint || '') &&
        normalizedName(stale.heard_name || stale.display_name) === name &&
        builtOn &&
        builtOn === String(orphan.current_input_fingerprint || '')
      ) {
        surfaced.set(target, 'stale_name_proposal');
        break;
      }
      // Current-revision proof: the row names this exact target from verified
      // exact naming receipts on the CURRENT cluster revision, with the same
      // heard name and no conflicting receipt names. That is newer lineage than
      // the orphaned judgment, not a guess (Sep 28 2026, 3df1 stayed counted
      // while its name was already in front of ExampleCo from current receipts).
      const hypothesis = row.current_identity_hypothesis || row.guess || {};
      const heard = [
        ...(Array.isArray(hypothesis.heard_names) ? hypothesis.heard_names : []),
        hypothesis.heard_name,
        hypothesis.display_name,
      ]
        .map(normalizedName)
        .filter(Boolean);
      if (
        row.membership_source === 'exact_current_revision_naming_receipts' &&
        hypothesis.source === 'exact_current_revision_naming_receipts' &&
        row.identity_evidence?.name_guess_source === 'exact_current_revision_naming_receipts' &&
        heard.length &&
        heard.every((value) => value === name)
      ) {
        surfaced.set(target, 'exact_current_revision_naming_receipts');
        break;
      }
      // A same-name guess is not proof: it lacks the judged and current
      // membership lineage and the stated coverage gap (Codex deploy review
      // 2026-09-28), so it never counts as surfaced.
    }
  }
  return surfaced;
}

/**
 * Exact current-window companion to the lifetime orphan inventory.
 *
 * One completed admissible proposal is RED when its current unknown voice
 * cluster contains at least one call from the past seven days and the proposal
 * is not on ExampleCo's review surface. A surfaceable orphan that the live queue
 * proves is shown (see surfacedOrphanTargets) is not lost and does not count.
 * Older inventory never counts here. Measurement-integrity failures fail closed
 * as red with an unverified count, because a missing or stale scan cannot prove
 * a current zero.
 */
function readPastWeekVoiceNameJudgeOrphanHealth({
  dataDir,
  artifactPath,
  reclusterPath,
  queuePath,
} = {}) {
  const file =
    artifactPath || path.join(dataDir || '', 'agent', 'voice-name-judge-orphans-latest.json');
  const report = readJson(file, null);
  if (!report) {
    return {
      status: 'red',
      count: null,
      detail:
        'the past-week orphan scan is missing, so the current seven-day count cannot be verified. ' +
        'Run node scripts/voice-name-judge-orphan-report.js --recent-days 7 --apply',
      artifact: file,
    };
  }
  const reclusterFile =
    reclusterPath || path.join(dataDir || '', 'life-archive', 'voiceprints', 'recluster-latest.json');
  let currentRecluster = {};
  let currentReclusterSha256 = '';
  try {
    const bytes = fs.readFileSync(reclusterFile);
    currentRecluster = JSON.parse(bytes.toString('utf8').replace(/^﻿/, ''));
    currentReclusterSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  } catch {
    // The current run check below owns the fail-closed response.
  }
  const currentRun = String(currentRecluster?.run_id || '');
  const scannedRun = String(report.recluster_run_id || '');
  const counts = report.counts;
  if (!currentRun || !scannedRun || currentRun !== scannedRun || !counts) {
    return {
      status: 'red',
      count: null,
      detail:
        'the past-week orphan scan cannot be verified against the current recluster run. ' +
        'Run node scripts/voice-name-judge-orphan-report.js --recent-days 7 --apply',
      artifact: file,
      generated_at: report.generated_at || '',
    };
  }
  const scannedReclusterSha256 = String(report.recluster_sha256 || '').trim().toLowerCase();
  if (
    scannedReclusterSha256 &&
    (!currentReclusterSha256 || scannedReclusterSha256 !== currentReclusterSha256)
  ) {
    return {
      status: 'red',
      count: null,
      detail:
        'the recluster bytes changed after the orphan scan even though its run id stayed the same, so the past-week count is stale. ' +
        'Run node scripts/voice-name-judge-orphan-report.js --recent-days 7 --apply',
      artifact: file,
      generated_at: report.generated_at || '',
    };
  }
  if (Number(report.recent_days) !== 7) {
    return {
      status: 'red',
      count: null,
      detail:
        `the orphan scan covers ${Number(report.recent_days) || 'an unknown number of'} days, not exactly 7 days, ` +
        'so the past-week count cannot be verified. Run node scripts/voice-name-judge-orphan-report.js --recent-days 7 --apply',
      artifact: file,
      generated_at: report.generated_at || '',
    };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(report.recent_cutoff_date || ''))) {
    return {
      status: 'red',
      count: null,
      detail:
        'the exact seven-day cutoff date is missing, so call-date membership cannot be verified. ' +
        'Run node scripts/voice-name-judge-orphan-report.js --recent-days 7 --apply',
      artifact: file,
      generated_at: report.generated_at || '',
    };
  }
  if (
    counts.judge_directory_readable !== true ||
    Number(counts.judge_artifacts_unreadable || 0) > 0 ||
    !Array.isArray(report.orphans)
  ) {
    return {
      status: 'red',
      count: null,
      detail:
        'the past-week orphan evidence is incomplete, so the current count cannot be verified. ' +
        'Run node scripts/voice-name-judge-orphan-report.js --recent-days 7 --apply',
      artifact: file,
      generated_at: report.generated_at || '',
    };
  }
  const recent = report.orphans.filter((row) => row?.outside_recency_window === false);
  const declared = Number(counts.past_week_orphaned_with_admissible_proposal);
  const everyRowClassified = report.orphans.every(
    (row) => row?.outside_recency_window === true || row?.outside_recency_window === false,
  );
  const everyRecentRowNamed = recent.every((row) => String(row?.target || '').trim());
  if (
    !Number.isInteger(declared) ||
    declared < 0 ||
    declared !== recent.length ||
    !everyRowClassified ||
    !everyRecentRowNamed
  ) {
    return {
      status: 'red',
      count: null,
      detail:
        'the declared past-week orphan count does not match complete, named seven-day rows, so it cannot be verified. ' +
        'Run node scripts/voice-name-judge-orphan-report.js --recent-days 7 --apply',
      artifact: file,
      generated_at: report.generated_at || '',
    };
  }
  if (!declared) {
    return {
      status: 'green',
      count: 0,
      recent_days: 7,
      recent_cutoff_date: String(report.recent_cutoff_date || ''),
      detail:
        `0 completed name proposals are orphaned on current voice clusters containing calls from the past 7 days` +
        (report.recent_cutoff_date ? ` (since ${report.recent_cutoff_date})` : ''),
      artifact: file,
      generated_at: report.generated_at || '',
    };
  }
  // Only a caller that names the data root or the queue gets a queue read; a
  // bare artifact path must never pick up an unrelated queue from the cwd.
  const queueFile =
    queuePath ||
    (dataDir ? path.join(dataDir, 'life-archive', 'people', 'briefing-voice-queue-latest.json') : '');
  const surfaced = queueFile
    ? surfacedOrphanTargets(readJson(queueFile, null), recent)
    : new Map();
  const lost = recent.filter((row) => !surfaced.has(String(row.target).trim()));
  const surfacedNote = surfaced.size
    ? `${surfaced.size} more ${surfaced.size === 1 ? 'is' : 'are'} already shown to ExampleCo on the voice review queue (${[...surfaced.keys()].slice(0, 3).join(', ')})`
    : '';
  if (!lost.length) {
    return {
      status: 'green',
      count: 0,
      recent_days: 7,
      recent_cutoff_date: String(report.recent_cutoff_date || ''),
      surfaced_count: surfaced.size,
      surfaced_targets: [...surfaced.keys()],
      detail:
        `0 completed name proposals from the past 7 days are lost` +
        (report.recent_cutoff_date ? ` (since ${report.recent_cutoff_date})` : '') +
        `; ${declared} orphaned by a recluster ${declared === 1 ? 'is' : 'are'} already shown to ExampleCo on the voice review queue ` +
        `(${[...surfaced.keys()].slice(0, 3).join(', ')})`,
      artifact: file,
      generated_at: report.generated_at || '',
    };
  }
  const named = lost.map((row) => String(row.target).trim()).slice(0, 3);
  return {
    status: 'red',
    count: lost.length,
    recent_days: 7,
    recent_cutoff_date: String(report.recent_cutoff_date || ''),
    targets: lost.map((row) => String(row.target).trim()),
    surfaced_count: surfaced.size,
    surfaced_targets: [...surfaced.keys()],
    detail:
      `${lost.length} completed name proposal${lost.length === 1 ? ' is' : 's are'} orphaned on current voice ` +
      `clusters containing calls from the past 7 days and not shown for review (${named.join(', ')})` +
      (surfacedNote ? `; ${surfacedNote}` : ''),
    artifact: file,
    generated_at: report.generated_at || '',
  };
}

module.exports = {
  ACTION,
  BACKLOG_STALL_DAYS,
  readOrphanBaseline,
  splitStrandedByCohort,
  membershipMetadataReproduces,
  membershipProvenIdentical,
  RELATION,
  RECOVERED_SCHEMA,
  buildRecoveredJudgeReport,
  classifyOrphanedNameJudgments,
  clusterCallOtids,
  evidenceClearsGate,
  judgedCallOtids,
  loadJudgmentsByTarget,
  membershipRelation,
  numericJudgeConfidence,
  readPastWeekVoiceNameJudgeOrphanHealth,
  readVoiceNameJudgeOrphanHealth,
  recoveryDecision,
  rowClearsGate,
  surfacedOrphanTargets,
  survivingEvidenceClearsGate,
};
