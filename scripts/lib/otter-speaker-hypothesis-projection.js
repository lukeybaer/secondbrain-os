'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { addDaysToDayKey, ctDayKeyForInstant } = require('./ct-day.js');
const {
  inspectCurrentClusterMembership,
} = require('./voice-current-cluster-membership.js');

const BLOCKED_IDENTITY_RE =
  /(?:confirmed|voiceprint|person_linked|denied|rejected|quarantin|ambiguous|conflict)/i;
const NEGATED_IDENTITY_EVIDENCE_RE =
  /(?:^|[_\s-])(?:no|not|without|unconfirmed|unmatched|failed)(?:[_\s-]|$)/i;

function normalizeDurableId(value) {
  return String(value || '')
    .trim()
    .toLowerCase();
}

function uniqueDurableIds(...values) {
  return [...new Set(values.flat(Infinity).map(normalizeDurableId).filter(Boolean))];
}

function durableIdsForSpeaker(speaker) {
  return uniqueDurableIds(speaker?.voice_cluster_ids || [], speaker?.acoustic_unknown_ids || []);
}

function durableIdsForParetoRow(row) {
  return uniqueDurableIds(row?.voice_cluster_ids || [], row?.acoustic_unknown_ids || []);
}

function cleanHypothesisName(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizedHypothesisName(value) {
  return cleanHypothesisName(value).toLocaleLowerCase('en-US');
}

function hypothesisForParetoRow(row) {
  const hypothesis = row?.current_identity_hypothesis;
  if (!hypothesis || typeof hypothesis !== 'object') return null;
  const displayName = cleanHypothesisName(hypothesis.display_name);
  if (!displayName || row?.quality_read?.non_speech_or_mixed === true) return null;
  if (BLOCKED_IDENTITY_RE.test(String(row?.identity_tier || ''))) return null;
  return {
    displayName,
    normalizedName: normalizedHypothesisName(displayName),
    confidence: Number.isFinite(Number(hypothesis.confidence))
      ? Number(hypothesis.confidence)
      : null,
    evidenceCount: Number(
      hypothesis.evidence_count ??
        hypothesis.clear_evidence_count ??
        row?.name_consistency?.top?.evidence_count ??
        0,
    ),
    source: 'speaker-pareto-latest',
  };
}

function buildHypothesisIndex(pareto = {}) {
  const byId = new Map();
  const eligibleRows = [];
  for (const [rowIndex, row] of (pareto?.all_name_guesses || []).entries()) {
    const hypothesis = hypothesisForParetoRow(row);
    const durableIds = durableIdsForParetoRow(row);
    if (!hypothesis || !durableIds.length) continue;
    const candidate = { ...hypothesis, durableIds, rowIndex };
    eligibleRows.push(candidate);
    for (const id of durableIds) {
      if (!byId.has(id)) byId.set(id, []);
      byId.get(id).push(candidate);
    }
  }
  const ambiguousIds = new Set();
  for (const [id, candidates] of byId) {
    if (new Set(candidates.map((candidate) => candidate.normalizedName)).size > 1) {
      ambiguousIds.add(id);
    }
  }
  return { byId, eligibleRows, ambiguousIds };
}

function speakerBlocksHypothesis(speaker) {
  if (speaker?.person_id) return true;
  if (BLOCKED_IDENTITY_RE.test(String(speaker?.identity_tier || ''))) return true;
  const evidence = Array.isArray(speaker?.evidence) ? speaker.evidence : [];
  return evidence.some((value) => {
    const normalized = String(value || '').trim();
    return (
      normalized &&
      !NEGATED_IDENTITY_EVIDENCE_RE.test(normalized) &&
      BLOCKED_IDENTITY_RE.test(normalized)
    );
  });
}

function projectSpeakerHypothesis(speaker, index) {
  const copied = { ...(speaker || {}) };
  if (speakerBlocksHypothesis(copied)) return { speaker: copied, outcome: 'blocked' };
  const durableIds = durableIdsForSpeaker(copied);
  if (!durableIds.length) return { speaker: copied, outcome: 'unmatched' };
  if (durableIds.some((id) => index.ambiguousIds.has(id))) {
    return { speaker: copied, outcome: 'ambiguous' };
  }
  const candidates = durableIds.flatMap((id) => index.byId.get(id) || []);
  const names = new Map();
  for (const candidate of candidates) {
    if (!names.has(candidate.normalizedName)) names.set(candidate.normalizedName, candidate);
  }
  if (names.size > 1) return { speaker: copied, outcome: 'ambiguous' };
  if (names.size === 0) return { speaker: copied, outcome: 'unmatched' };
  const candidate = [...names.values()][0];
  copied.name_hypothesis = candidate.displayName;
  copied.hypothesis_confidence = candidate.confidence;
  copied.hypothesis_evidence_count = candidate.evidenceCount;
  copied.hypothesis_source = candidate.source;
  copied.hypothesis_matched_durable_ids = durableIds.filter((id) =>
    candidate.durableIds.includes(id),
  );
  return { speaker: copied, outcome: 'projected', candidate };
}

function projectCallsWithHypotheses(calls, indexOrPareto = {}) {
  const index =
    indexOrPareto?.byId instanceof Map ? indexOrPareto : buildHypothesisIndex(indexOrPareto);
  const stats = {
    eligibleHypothesisRows: index.eligibleRows.length,
    projectedSpeakerRows: 0,
    projectedNames: 0,
    ambiguousSpeakerRows: 0,
    blockedSpeakerRows: 0,
    unmatchedSpeakerRows: 0,
  };
  const projectedNames = new Set();
  const projectedCalls = (Array.isArray(calls) ? calls : []).map((call) => ({
    ...(call || {}),
    speakers: (Array.isArray(call?.speakers) ? call.speakers : []).map((speaker) => {
      const result = projectSpeakerHypothesis(speaker, index);
      if (result.outcome === 'projected') {
        stats.projectedSpeakerRows += 1;
        projectedNames.add(result.candidate.normalizedName);
      } else if (result.outcome === 'ambiguous') {
        stats.ambiguousSpeakerRows += 1;
      } else if (result.outcome === 'blocked') {
        stats.blockedSpeakerRows += 1;
      } else {
        stats.unmatchedSpeakerRows += 1;
      }
      return result.speaker;
    }),
  }));
  stats.projectedNames = projectedNames.size;
  return { calls: projectedCalls, stats, index };
}

function projectionWindowStats(calls, indexOrPareto = {}) {
  const projected = projectCallsWithHypotheses(calls, indexOrPareto);
  return {
    ...projected.stats,
    eligibleSpeakerRows:
      Number(projected.stats.projectedSpeakerRows || 0) +
      Number(projected.stats.ambiguousSpeakerRows || 0),
  };
}

function hypothesisCoverageGate({ provenance, health } = {}) {
  if (provenance?.status !== 'available') {
    return {
      status: 'unavailable',
      reason: provenance?.reason || 'Pareto and roster provenance is unavailable.',
    };
  }
  // ExampleCo 2026-09-23 (G27): only this card's own job failing or going stale
  // turns it red. Name-resolver health, recluster roster membership, calls
  // still in process and lifetime projection lag are other units' metrics
  // (System Health owns them), so they render here as information, never as
  // this card's blocker. Roster-byte provenance above IS this card's own job.
  if (!health || health.defect) {
    return {
      status: 'available',
      reason: '',
      resolverAdvisory: true,
      advisoryReason:
        health?.reason ||
        'Overnight name-resolver terminal proof is missing, so hypothesized-name counts may be incomplete.',
    };
  }
  return { status: 'available', reason: '' };
}

function sha256Bytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function evaluateProjectionProvenance({ rosterSha256, pareto } = {}) {
  const actual = String(rosterSha256 || '')
    .trim()
    .toLowerCase();
  const expected = String(pareto?.source_roster_sha256 || '')
    .trim()
    .toLowerCase();
  if (!expected) {
    return {
      status: 'unavailable',
      reason: 'Pareto artifact does not declare the roster bytes it consumed.',
      rosterSha256: actual || null,
      paretoRosterSha256: null,
    };
  }
  if (!actual || actual !== expected) {
    return {
      status: 'unavailable',
      reason: 'Pareto and roster provenance do not match.',
      rosterSha256: actual || null,
      paretoRosterSha256: expected,
    };
  }
  return {
    status: 'available',
    reason: '',
    rosterSha256: actual,
    paretoRosterSha256: expected,
  };
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function resolverClusterMembershipAssessment(
  cluster,
  { loadEnriched, currentClusterIds } = {},
) {
  if (
    cluster?.frozen ||
    cluster?.confirmed_person_id ||
    !/^unknown_voice_ecapa_/.test(String(cluster?.cluster_id || ''))
  ) {
    return {
      eligible: false,
      inspection: null,
      provenMovedMembers: [],
      unavailableMembers: [],
    };
  }
  const members = Array.isArray(cluster?.members) ? cluster.members : [];
  const inspection = inspectCurrentClusterMembership(cluster, {
    loadEnriched,
    currentClusterIds,
  });
  const staleMembers = Array.isArray(inspection?.stale_members)
    ? inspection.stale_members
    : [];
  const provenMovedMembers = staleMembers.filter(
    (member) =>
      member?.stale_reason === 'current_identity_target_changed' &&
      String(member?.current_target || '').trim(),
  );
  const unavailableMembers = staleMembers.filter(
    (member) => !provenMovedMembers.includes(member),
  );
  for (const member of Array.isArray(inspection?.lagged_members)
    ? inspection.lagged_members
    : []) {
    if (member?.lag_reason === 'source_revision_advanced') continue;
    unavailableMembers.push({
      ...member,
      stale_reason: member?.lag_reason || 'membership_projection_lag',
    });
  }
  if (!members.length) {
    if (
      (Array.isArray(cluster?.otids) && cluster.otids.length > 0) ||
      Number(cluster?.size || 0) > 0
    ) {
      unavailableMembers.push({ stale_reason: 'cluster_members_missing' });
    }
  } else {
    for (const member of members) {
      if (!member?.otid || !String(member?.speaker_model_label || '').trim()) {
        unavailableMembers.push({
          ...member,
          stale_reason: 'membership_row_uninspectable',
        });
      }
    }
    if (inspection?.status === 'not_checked' && unavailableMembers.length === 0) {
      unavailableMembers.push({ stale_reason: 'membership_not_checked' });
    }
  }
  return {
    eligible: provenMovedMembers.length === 0,
    inspection,
    provenMovedMembers,
    unavailableMembers,
  };
}

function resolverEligibleUnknownCluster(cluster, { loadEnriched, currentClusterIds } = {}) {
  return resolverClusterMembershipAssessment(cluster, {
    loadEnriched,
    currentClusterIds,
  }).eligible;
}

// `cutoffDate` pins the window to a day key that was decided elsewhere, which is what makes a
// frozen artifact comparable to a freshly computed set. Without it the caller silently asks a
// different question every time the day key advances underneath it.
function recentUnknownTargetIdsFromArtifacts({
  recluster,
  roster,
  loadEnriched,
  days = 7,
  nowMs = Date.now(),
  cutoffDate: pinnedCutoffDate = null,
} = {}) {
  const windowDays = Math.max(1, Number(days) || 7);
  // The business day is Central, never UTC (memory/feedback_times_in_ct_never_utc.md), and the
  // window is counted in calendar days. Stepping the CT day key by whole days is DST-safe;
  // subtracting a fixed 24h*N in milliseconds and then converting is not.
  const cutoffDate =
    String(pinnedCutoffDate || '').trim() ||
    addDaysToDayKey(ctDayKeyForInstant(nowMs), -(windowDays - 1));
  const recentOtids = new Set(
    (Array.isArray(roster?.calls) ? roster.calls : [])
      .filter((call) => String(call?.date || '').slice(0, 10) >= cutoffDate)
      .map((call) => String(call?.otid || ''))
      .filter(Boolean),
  );
  const currentClusterIds = new Set(
    (Array.isArray(recluster?.clusters) ? recluster.clusters : [])
      .map((cluster) => String(cluster?.cluster_id || ''))
      .filter(Boolean),
  );
  // A target is its id, and the resolver seals a set. The recluster can carry two clusters
  // under one cluster_id; listing that id twice would never equal the sealed set.
  const ids = [
    ...new Set(
      (Array.isArray(recluster?.clusters) ? recluster.clusters : [])
        .filter(
          (cluster) =>
            resolverEligibleUnknownCluster(cluster, { loadEnriched, currentClusterIds }) &&
            (cluster.otids || cluster.members?.map((row) => row?.otid) || []).some((otid) =>
              recentOtids.has(String(otid || '')),
            ),
        )
        .map((cluster) => String(cluster.cluster_id)),
    ),
  ].sort();
  return { ids, cutoffDate, windowDays, recentOtids: recentOtids.size };
}

function recentUnknownRosterMembership({
  roster,
  recluster,
  days = 7,
  nowMs = Date.now(),
  cutoffDate: pinnedCutoffDate = null,
} = {}) {
  const windowDays = Math.max(1, Number(days) || 7);
  const cutoffDate =
    String(pinnedCutoffDate || '').trim() ||
    addDaysToDayKey(ctDayKeyForInstant(nowMs), -(windowDays - 1));
  const recentCalls = (Array.isArray(roster?.calls) ? roster.calls : []).filter(
    (call) => String(call?.date || '').slice(0, 10) >= cutoffDate,
  );
  const clusterTrackKeys = new Set();
  const clusterOtidsById = new Map();
  for (const cluster of Array.isArray(recluster?.clusters) ? recluster.clusters : []) {
    const clusterId = normalizeDurableId(cluster?.cluster_id);
    if (!clusterOtidsById.has(clusterId)) clusterOtidsById.set(clusterId, new Set());
    for (const otid of cluster?.otids || []) {
      if (otid) clusterOtidsById.get(clusterId).add(String(otid));
    }
    for (const member of cluster?.members || []) {
      const otid = String(member?.otid || '').trim();
      const label = String(member?.speaker_model_label || '').trim();
      if (otid) clusterOtidsById.get(clusterId).add(otid);
      if (otid && label) clusterTrackKeys.add(`${otid}|${label}`);
    }
  }

  const eligibleSpeakerRows = [];
  const unclusteredSpeakerRows = [];
  const uncheckedKnownVoiceSpeakerRows = [];
  for (const call of recentCalls) {
    const otid = String(call?.otid || '').trim();
    for (const speaker of Array.isArray(call?.speakers) ? call.speakers : []) {
      if (
        speaker?.person_id ||
        speaker?.small_or_late_joiner === true ||
        Number(speaker?.word_count || 0) <= 0
      ) {
        continue;
      }
      const acousticIds = uniqueDurableIds(speaker?.acoustic_unknown_ids || []).filter((id) =>
        /^unknown_voice_ecapa_/.test(id),
      );
      if (!acousticIds.length) continue;
      const trackKeys = (speaker?.otter_tracks || [])
        .map((label) => String(label || '').trim())
        .filter(Boolean)
        .map((label) => `${otid}|${label}`);
      const clusteredByTrack = trackKeys.some((key) => clusterTrackKeys.has(key));
      const clusteredByLegacyId = acousticIds.some((id) =>
        clusterOtidsById.get(id)?.has(otid),
      );
      const evidence = Array.isArray(speaker?.evidence) ? speaker.evidence.map(String) : [];
      const knownVoiceCheckEvidence = evidence.find((value) =>
        new Set([
          'no_confirmed_reference_cleared_margin',
          'match_below_net_speech_minimum',
        ]).has(String(value).toLowerCase()),
      );
      const row = {
        otid,
        speakerId: String(speaker?.speaker_id || '').trim(),
        acousticIds,
        trackKeys,
        wordCount: Number(speaker?.word_count || 0),
        knownVoiceCheckEvidence: knownVoiceCheckEvidence || null,
      };
      eligibleSpeakerRows.push(row);
      if (!clusteredByTrack && !clusteredByLegacyId) unclusteredSpeakerRows.push(row);
      // A durable unknown is only a valid downstream name-guessing target after the
      // acoustic resolver actually compared its probe with the enrolled reference
      // voices. Incremental reclustering alone can assign an unknown id and otherwise
      // make this join look complete while skipping ExampleCo (live defect 2026-09-19).
      const requiresKnownVoiceCheck =
        !speaker?.person_id && !String(speaker?.speaker_id || '').startsWith('person:');
      if (requiresKnownVoiceCheck && !knownVoiceCheckEvidence) {
        uncheckedKnownVoiceSpeakerRows.push(row);
      }
    }
  }
  return {
    cutoffDate,
    windowDays,
    recentCalls: recentCalls.length,
    eligibleSpeakerRows,
    unclusteredSpeakerRows,
    uncheckedKnownVoiceSpeakerRows,
  };
}

// ExampleCo 2026-09-23: the name resolver is green when its last complete run is no older than four
// hours and it covered every unknown target that existed at run time. Calls that landed after the
// run (or are still processing) are informational until the next run; they never turn it red.
const RESOLVER_MAX_AGE_MS = 4 * 60 * 60 * 1000;

function callLandedMs(enriched) {
  const fetched = Date.parse(String(enriched?.fetched_at || ''));
  if (Number.isFinite(fetched)) return fetched;
  const end = Number(enriched?.end_time);
  return Number.isFinite(end) && end > 0 ? end * 1000 : NaN;
}

function readOtterHypothesisProjectionHealth({ dataDir } = {}) {
  const voiceprintsDir = path.join(dataDir || '', 'life-archive', 'voiceprints');
  const rosterPath = path.join(voiceprintsDir, 'otter-call-speaker-rosters-latest.json');
  const paretoPath = path.join(voiceprintsDir, 'speaker-pareto-latest.json');
  const resolverPath = path.join(
    voiceprintsDir,
    'voice-identity-overnight-name-resolver-status.json',
  );
  const reclusterPath = path.join(voiceprintsDir, 'recluster-latest.json');
  const quarantinedTrackConflicts = quarantinedTrackConflictsForHealth(
    readJsonFile(path.join(voiceprintsDir, 'otter-track-identity-conflict-review.json')),
  );
  const loadEnriched = (otid) =>
    readJsonFile(path.join(dataDir || '', 'otter', 'enriched', `${otid}.json`));
  let rosterBytes = null;
  try {
    rosterBytes = fs.readFileSync(rosterPath);
  } catch {
    rosterBytes = null;
  }
  const pareto = readJsonFile(paretoPath);
  let roster = null;
  try {
    roster = rosterBytes ? JSON.parse(rosterBytes.toString('utf8').replace(/^\uFEFF/, '')) : null;
  } catch {
    roster = null;
  }
  const provenance = evaluateProjectionProvenance({
    rosterSha256: rosterBytes ? sha256Bytes(rosterBytes) : null,
    pareto,
  });
  const projection =
    provenance.status === 'available' && roster && pareto
      ? projectCallsWithHypotheses(roster.calls || [], pareto)
      : null;
  const resolver = readJsonFile(resolverPath);
  const selected = Number(resolver?.selected_targets || 0);
  const failed = Number(resolver?.failed_targets || 0);
  const deferred = Number(resolver?.deferred_targets || 0);
  const patternGuarded = Number(resolver?.pattern_guarded_targets || 0);
  const precompleted = Number(resolver?.precompleted_targets || 0);
  const completed = Number(resolver?.completed_targets || 0);
  const total = Number(resolver?.total_targets || 0);
  const succeeded = Math.max(0, selected - failed);
  const phase = String(resolver?.phase || 'missing');
  const resolverUpdatedMs = Date.parse(String(resolver?.updated_at || ''));
  const resolverAgeMs = Date.now() - resolverUpdatedMs;
  const resolverFreshByAge =
    Number.isFinite(resolverUpdatedMs) &&
    resolverAgeMs >= -5 * 60 * 1000 &&
    resolverAgeMs <= RESOLVER_MAX_AGE_MS;
  let reclusterSha256 = '';
  let reclusterBytes = null;
  try {
    reclusterBytes = fs.readFileSync(reclusterPath);
    reclusterSha256 = sha256Bytes(reclusterBytes);
  } catch {}
  // completed_no_refresh_requested is a clean terminal phase: resolver finished all judges,
  // no downstream refresh step was requested (--no-refresh flag). Treat identically to completed.
  const selectedCompletionProven = completed >= precompleted + selected;
  const resolverTerminalClean = /^completed(?:_no_refresh_requested)?$/i.test(phase);
  // Legacy resolver format: old code (deployed before target_scope was added to stateBase) does
  // not include target_scope in the status file. When the resolver is otherwise clean (terminal
  // phase + zero failures/deferred/pattern-guarded + completion proven), scope is unverifiable
  // but not defective if the resolver ran AFTER the current recluster was generated.
  // The resolver runs with the recluster (not nightly), so the 30h age window is too tight
  // for a run-on-demand pipeline. Instead, accept a legacy-format resolver that ran after the
  // current recluster (proving it covered that recluster's scope) within a 7-day window.
  const hasLegacyResolverFormat =
    resolver != null && !Object.prototype.hasOwnProperty.call(resolver, 'target_scope');
  const reclusterJsonForLegacy = reclusterBytes
    ? (() => {
        try {
          return JSON.parse(reclusterBytes.toString('utf8').replace(/^\uFEFF/, ''));
        } catch {
          return null;
        }
      })()
    : null;
  const reclusterGeneratedMs = Date.parse(String(reclusterJsonForLegacy?.generated_at || ''));
  // The legacy resolver covered the current recluster if it ran after the recluster was generated
  // and is not older than 7 days (a generous upper bound for on-demand recluster cycles).
  const legacyResolverCoversRecluster =
    Number.isFinite(resolverUpdatedMs) &&
    Number.isFinite(reclusterGeneratedMs) &&
    resolverUpdatedMs >= reclusterGeneratedMs &&
    resolverAgeMs >= -5 * 60 * 1000 &&
    resolverAgeMs <= RESOLVER_MAX_AGE_MS;
  // When the recluster is an incremental run that introduced no new unknown targets
  // (incremental_missing_targets === 0), the resolver's prior coverage remains complete even if
  // the recluster was regenerated after the resolver ran. Incremental reclusters only append new
  // track observations to existing clusters; a zero missing-target count proves no new unknown
  // cluster was created, so the resolver's scope from before the incremental update is still valid.
  const isIncrementalRecluster =
    typeof reclusterJsonForLegacy?.run_id === 'string' &&
    reclusterJsonForLegacy.run_id.startsWith('incremental-');
  const incrementalMissingTargets = isIncrementalRecluster
    ? Number(reclusterJsonForLegacy?.summary?.incremental_missing_targets ?? NaN)
    : NaN;
  const legacyIncrementalCoversRecluster =
    Number.isFinite(resolverUpdatedMs) &&
    resolverAgeMs >= -5 * 60 * 1000 &&
    resolverAgeMs <= RESOLVER_MAX_AGE_MS &&
    isIncrementalRecluster &&
    Number.isFinite(incrementalMissingTargets) &&
    incrementalMissingTargets === 0;
  const legacyFormatClean =
    hasLegacyResolverFormat &&
    resolverTerminalClean &&
    failed === 0 &&
    deferred === 0 &&
    patternGuarded === 0 &&
    // A legacy seal has no target set, so a full recluster after it can never be proven covered.
    ((resolverFreshByAge &&
      !(Number.isFinite(reclusterGeneratedMs) && reclusterGeneratedMs > resolverUpdatedMs)) ||
      legacyResolverCoversRecluster ||
      legacyIncrementalCoversRecluster) &&
    selectedCompletionProven;
  // legacyIncrementalCoversRecluster is not actually legacy-specific: it proves the recluster
  // file changed only via a zero-missing-target incremental run, which by definition introduced
  // no unknown cluster the resolver had not already covered. A modern resolver (with target_scope)
  // needs the same exemption, or every exact-scope repair that runs voice-incremental-recluster.js
  // with zero missing targets permanently breaks freshForInputs until the next full non-exact
  // refresh, which exact-scope card repairs never trigger (live incident 2026-09-19).
  const resolverInputShaMatches =
    Boolean(reclusterSha256) &&
    String(resolver?.target_scope?.recluster_sha256 || '') === reclusterSha256;
  // Run anchor for "existed at run time": when the resolver computed its scope, else its seal.
  const scopeComputedAtRaw = Date.parse(String(resolver?.target_scope?.scope_computed_at || ''));
  const resolverRunAnchorMs =
    Number.isFinite(scopeComputedAtRaw) &&
    Number.isFinite(resolverUpdatedMs) &&
    scopeComputedAtRaw <= resolverUpdatedMs
      ? scopeComputedAtRaw
      : resolverUpdatedMs;
  // A recluster regenerated AFTER the run (a new call landed) is not a stale input: coverage of
  // the targets that existed at run time is then judged by the scope check below.
  const reclusterAdvancedAfterRun =
    !hasLegacyResolverFormat &&
    !resolverInputShaMatches &&
    Number.isFinite(reclusterGeneratedMs) &&
    Number.isFinite(resolverRunAnchorMs) &&
    reclusterGeneratedMs > resolverRunAnchorMs;
  const resolverFreshForInputs = legacyFormatClean
    ? true
    : legacyIncrementalCoversRecluster || resolverInputShaMatches || reclusterAdvancedAfterRun;
  const landedAfterRunCache = new Map();
  const callLandedAfterRun = (otid) => {
    const key = String(otid || '');
    if (!key || !reclusterAdvancedAfterRun) return false;
    if (!landedAfterRunCache.has(key)) {
      const landed = callLandedMs(loadEnriched(key));
      landedAfterRunCache.set(key, Number.isFinite(landed) && landed > resolverRunAnchorMs);
    }
    return landedAfterRunCache.get(key);
  };
  const recluster = readJsonFile(reclusterPath);
  const currentClusterIds = new Set(
    (Array.isArray(recluster?.clusters) ? recluster.clusters : [])
      .map((cluster) => String(cluster?.cluster_id || ''))
      .filter(Boolean),
  );
  const resolverMembershipEvidenceDefects = Array.isArray(recluster?.clusters)
    ? recluster.clusters.flatMap((cluster) => {
        const assessment = resolverClusterMembershipAssessment(cluster, {
          loadEnriched,
          currentClusterIds,
        });
        return assessment.unavailableMembers.map((member) => ({
          clusterId: String(cluster?.cluster_id || ''),
          otid: String(member?.otid || ''),
          speakerModelLabel: String(member?.speaker_model_label || ''),
          reason: String(member?.stale_reason || 'membership_unavailable'),
        }));
      })
    : [];
  const lifetimeUnknownTargetIds = Array.isArray(recluster?.clusters)
    ? [
        ...new Set(
          recluster.clusters
            .filter((cluster) =>
              resolverEligibleUnknownCluster(cluster, { loadEnriched, currentClusterIds }),
            )
            .map((cluster) => String(cluster.cluster_id)),
        ),
      ].sort()
    : null;
  const resolverScopeKind = String(resolver?.target_scope?.scope_kind || 'lifetime');
  const resolverRecentDays = Number(resolver?.target_scope?.recent_days || 0);
  const rosterForScope = readJsonFile(rosterPath);
  // The resolver seals the cutoff date it computed its target set under. Recomputing the
  // "current" set under a NEWER cutoff and demanding exact equality compares two different
  // questions, so the verdict would flip on wall-clock alone while the evidence is identical.
  // Pin the recomputation to the sealed cutoff so the comparison stays a fair one.
  const sealedCutoffDate = String(resolver?.target_scope?.recent_cutoff_date || '').trim();
  // Never trust a self-reported frame outright. A seal claiming a far-future cutoff would filter
  // every unresolved target out of the window and then pass exact equality against its own empty
  // list, which is a false green. Bind the sealed cutoff to the moment the scope was computed:
  // it must be exactly the Central cutoff that moment implies, or one day earlier, which allows
  // a run that began before midnight CT and sealed after it. Anything else is an unusable frame.
  // `scope_computed_at` is itself self-reported, so it cannot be the root of trust: forging it
  // alongside the cutoff would keep the two consistent and pass. Anchor instead on `updated_at`,
  // which is independently freshness-checked (within 30h, not more than 5 minutes ahead). The
  // computation must sit INSIDE the run that wrote the seal: at or before the seal write, and no
  // earlier than one freshness window before it. Anything outside that falls back to updated_at.
  const scopeComputedRaw = Date.parse(String(resolver?.target_scope?.scope_computed_at || ''));
  const scopeComputedInRun =
    Number.isFinite(scopeComputedRaw) &&
    Number.isFinite(resolverUpdatedMs) &&
    // Strictly at or before the seal write. No forward slack: the scope is necessarily computed
    // BEFORE the seal that records it, and even a few minutes of allowance can straddle midnight
    // CT, shifting the derived cutoff a whole day and letting a forged seal drop the oldest
    // in-window day while still passing exact equality.
    scopeComputedRaw <= resolverUpdatedMs &&
    scopeComputedRaw >= resolverUpdatedMs - 30 * 60 * 60 * 1000;
  const scopeComputedMs = scopeComputedInRun ? scopeComputedRaw : resolverUpdatedMs;
  const expectedCutoffDate =
    Number.isFinite(scopeComputedMs) && resolverRecentDays > 0
      ? addDaysToDayKey(ctDayKeyForInstant(scopeComputedMs), -(resolverRecentDays - 1))
      : null;
  const sealedCutoffConsistent =
    /^\d{4}-\d{2}-\d{2}$/.test(sealedCutoffDate) &&
    expectedCutoffDate !== null &&
    (sealedCutoffDate === expectedCutoffDate ||
      sealedCutoffDate === addDaysToDayKey(expectedCutoffDate, -1));
  const recentScopeIsSealed =
    resolverScopeKind === 'recent' && resolverRecentDays > 0 && sealedCutoffConsistent;
  const recentScope =
    resolverScopeKind === 'recent' && resolverRecentDays > 0
      ? recentUnknownTargetIdsFromArtifacts({
          recluster,
          roster: rosterForScope,
          loadEnriched,
          days: resolverRecentDays,
          cutoffDate: sealedCutoffDate || null,
        })
      : null;
  // Resolver scope is derived from recluster output. Prove separately that the
  // recent roster's substantive acoustic unknowns actually reached that input.
  // Without this join, a completely empty recluster delta made the resolver's
  // empty target set look complete and let the card publish a false green zero.
  const recentRosterMembership = recentUnknownRosterMembership({
    recluster,
    roster: rosterForScope,
    days: recentScope?.windowDays || 7,
    cutoffDate: recentScope?.cutoffDate || null,
  });
  // The card reports on the rolling recent window, so only membership evidence
  // for calls inside that window can turn it red (ExampleCo 2026-09-23, G27 unit
  // independence). Older members whose enriched call file still carries a
  // superseded id, or whose call file is gone, are a separate lifetime advisory
  // lane with its own count: the backlog is real, but it is not this week's
  // defect. A cluster-level gap with no member otid is recent when any of the
  // cluster's calls is recent.
  const membershipCutoffDate =
    recentScope?.cutoffDate || addDaysToDayKey(ctDayKeyForInstant(Date.now()), -6);
  const membershipRecentOtids = new Set(
    (Array.isArray(rosterForScope?.calls) ? rosterForScope.calls : [])
      .filter((call) => String(call?.date || '').slice(0, 10) >= membershipCutoffDate)
      .map((call) => String(call?.otid || ''))
      .filter(Boolean),
  );
  const clusterOtidsById = new Map(
    (Array.isArray(recluster?.clusters) ? recluster.clusters : []).map((cluster) => [
      String(cluster?.cluster_id || ''),
      (cluster?.otids || cluster?.members?.map((row) => row?.otid) || []).map(String),
    ]),
  );
  const defectIsRecent = (defect) =>
    defect.otid
      ? membershipRecentOtids.has(defect.otid)
      : (clusterOtidsById.get(defect.clusterId) || []).some((otid) =>
          membershipRecentOtids.has(otid),
        );
  const recentMembershipEvidenceDefectsAll =
    resolverMembershipEvidenceDefects.filter(defectIsRecent);
  // Membership evidence is read against the CURRENT recluster. When that recluster was rebuilt
  // after the run, its enriched projection lag belongs to the next run, not to this one.
  const recentMembershipEvidenceDefects = reclusterAdvancedAfterRun
    ? []
    : recentMembershipEvidenceDefectsAll;
  const unclusteredBeforeRun = recentRosterMembership.unclusteredSpeakerRows.filter(
    (row) => !callLandedAfterRun(row.otid),
  );
  const uncheckedBeforeRun = recentRosterMembership.uncheckedKnownVoiceSpeakerRows.filter(
    (row) => !callLandedAfterRun(row.otid),
  );
  const postRunRowCount =
    recentMembershipEvidenceDefectsAll.length -
    recentMembershipEvidenceDefects.length +
    recentRosterMembership.unclusteredSpeakerRows.length -
    unclusteredBeforeRun.length +
    recentRosterMembership.uncheckedKnownVoiceSpeakerRows.length -
    uncheckedBeforeRun.length;
  const lifetimeMembershipEvidenceAdvisories = resolverMembershipEvidenceDefects.filter(
    (defect) => !defectIsRecent(defect),
  );
  const lifetimeAdvisoryReasonCounts = lifetimeMembershipEvidenceAdvisories.reduce(
    (counts, defect) => ({ ...counts, [defect.reason]: (counts[defect.reason] || 0) + 1 }),
    {},
  );
  const recentUnknownMembershipComplete =
    unclusteredBeforeRun.length === 0 && uncheckedBeforeRun.length === 0;
  // Both the recent and lifetime sets already use resolverEligibleUnknownCluster.
  // Do not apply a second purity filter here: it can silently turn unavailable
  // evidence into exclusion after the shared predicate deliberately kept the
  // target in scope so health fails loud.
  const currentUnknownTargetIds = recentScope?.ids || lifetimeUnknownTargetIds;
  const resolverUnknownTargetIds = Array.isArray(resolver?.target_scope?.unknown_target_ids)
    ? resolver.target_scope.unknown_target_ids.map(String).filter(Boolean).sort()
    : null;
  const currentUnknownTargets = currentUnknownTargetIds?.length ?? null;
  // A rolling-window seal that never recorded its cutoff cannot be compared fairly against a
  // recomputed set, because the frame it was computed in is unknown. That is an unproven scope,
  // not a proven one: fail loud rather than assume the two frames happen to line up.
  const resolverScopeComparable = resolverScopeKind !== 'recent' || recentScopeIsSealed;
  // Exact equality when the recluster input is unchanged since the run. When it advanced after
  // the run, a current target missing from the seal is informational only if it was created
  // after the run; an inherited target built only from earlier calls existed at run time and
  // was skipped, which stays red.
  const resolverUnknownTargetSet = new Set(resolverUnknownTargetIds || []);
  const clustersForTarget = (targetId) =>
    (Array.isArray(recluster?.clusters) ? recluster.clusters : []).filter(
      (cluster) => String(cluster?.cluster_id || '') === targetId,
    );
  // A target did not exist at run time when the post-run recluster minted its id
  // (inherited_id false) or a call that landed after the run contributed to it.
  const targetCreatedAfterRun = (targetId) =>
    clustersForTarget(targetId).some(
      (cluster) =>
        cluster?.inherited_id === false ||
        (cluster?.otids || cluster?.members?.map((row) => row?.otid) || [])
          .map(String)
          .some(callLandedAfterRun),
    );
  const missingTargetIds = (currentUnknownTargetIds || []).filter(
    (targetId) => !resolverUnknownTargetSet.has(targetId),
  );
  const postRunTargetIds = reclusterAdvancedAfterRun
    ? missingTargetIds.filter(targetCreatedAfterRun)
    : [];
  const skippedTargetIds = missingTargetIds.filter(
    (targetId) => !postRunTargetIds.includes(targetId),
  );
  const exactScopeEqual =
    currentUnknownTargetIds !== null &&
    resolverUnknownTargetIds !== null &&
    currentUnknownTargetIds.length === resolverUnknownTargetIds.length &&
    currentUnknownTargetIds.every(
      (targetId, index) => targetId === resolverUnknownTargetIds[index],
    );
  const resolverScopeComplete = legacyFormatClean
    ? true
    : resolverScopeComparable &&
      currentUnknownTargetIds !== null &&
      resolverUnknownTargetIds !== null &&
      (exactScopeEqual || (reclusterAdvancedAfterRun && skippedTargetIds.length === 0));
  // Evaluate every recent-window call so the count names all calls that landed after the run.
  for (const otid of membershipRecentOtids) callLandedAfterRun(otid);
  const postRunCallIds = [...landedAfterRunCache.entries()]
    .filter(([, after]) => after)
    .map(([otid]) => otid)
    .sort();
  // Age is a defect only when the legacy recluster-coverage path does not apply.
  // legacyFormatClean already verifies age or recluster coverage; if it's true,
  // resolverFreshForInputs and resolverScopeComplete are also satisfied, so we
  // must not double-penalize for the raw age check.
  const resolverFreshByAgeOrLegacyCovered = resolverFreshByAge || legacyFormatClean;
  const resolverDefect =
    !resolver ||
    !resolverTerminalClean ||
    failed > 0 ||
    deferred > 0 ||
    patternGuarded > 0 ||
    !resolverFreshByAgeOrLegacyCovered ||
    !resolverFreshForInputs ||
    !resolverScopeComplete ||
    recentMembershipEvidenceDefects.length > 0 ||
    !recentUnknownMembershipComplete ||
    !selectedCompletionProven ||
    /(?:failed|warning|aborted)/i.test(phase);
  const projectionDefect = provenance.status !== 'available';
  const reasons = [
    ...(projectionDefect ? [provenance.reason] : []),
    ...(!resolver
      ? ['Overnight name-resolver status is missing.']
      : failed > 0
        ? [`${failed} selected name-resolver target(s) failed.`]
        : []),
    ...(patternGuarded > 0
      ? [`${patternGuarded} target(s) hit the three-identical-failure pattern guard.`]
      : []),
    ...(deferred > 0 ? [`${deferred} current name-resolver target(s) were deferred.`] : []),
    ...(!resolverFreshByAgeOrLegacyCovered
      ? [
          'Name-resolver last complete run is older than 4 hours (or more than five minutes in the future).',
        ]
      : []),
    ...(!resolverFreshForInputs
      ? ['Name-resolver terminal proof is not bound to the current recluster input SHA.']
      : []),
    ...(!resolverScopeComplete
      ? [
          resolverUnknownTargetIds === null
            ? 'Name-resolver terminal proof is missing its exact unknown-target set.'
            : !resolverScopeComparable
              ? `Name-resolver terminal proof does not record a rolling-window cutoff consistent with when its scope was computed (sealed ${sealedCutoffDate || 'none'}, expected ${expectedCutoffDate || 'unknown'}), so its exact unknown-target set cannot be compared in the same frame.`
              : reclusterAdvancedAfterRun
                ? `Name resolver skipped ${skippedTargetIds.length} unknown target(s) that existed at its run time.`
                : `Name-resolver unknown-target set does not equal the ${currentUnknownTargets == null ? 'unavailable' : currentUnknownTargets} current unknown acoustic target(s).`,
        ]
      : []),
    ...(recentMembershipEvidenceDefects.length
      ? [
          `${recentMembershipEvidenceDefects.length} current recluster member(s) in recent-window calls lack readable, current enriched identity evidence, so resolver target eligibility is unproven.`,
        ]
      : []),
    ...(unclusteredBeforeRun.length
      ? [
          `${unclusteredBeforeRun.length} recent substantive unknown speaker row(s) never reached recluster/name-resolver input, so a zero hypothesis count is unproven.`,
        ]
      : []),
    ...(uncheckedBeforeRun.length
      ? [
          `${uncheckedBeforeRun.length} recent substantive unknown speaker row(s) were never checked against enrolled voiceprints, so a zero hypothesis count is unproven.`,
        ]
      : []),
    ...(!selectedCompletionProven
      ? [
          `Name-resolver completed-target proof ${completed} is below ${precompleted + selected} selected plus precompleted target(s).`,
        ]
      : []),
    ...(/(?:failed|warning|aborted)/i.test(phase) ? [`Name resolver ended in ${phase}.`] : []),
    ...(resolver && !resolverTerminalClean && !/(?:failed|warning|aborted)/i.test(phase)
      ? [`Name resolver has not reached a clean terminal phase (${phase}).`]
      : []),
  ];
  return {
    status: projectionDefect || resolverDefect ? 'red' : 'green',
    defect: projectionDefect || resolverDefect,
    reason: reasons.join(' '),
    provenance,
    eligibleHypothesisRows: projection?.stats?.eligibleHypothesisRows ?? null,
    projectedSpeakerRows: projection?.stats?.projectedSpeakerRows ?? null,
    projectedNames: projection?.stats?.projectedNames ?? null,
    resolver: {
      phase,
      updatedAt: Number.isFinite(resolverUpdatedMs)
        ? new Date(resolverUpdatedMs).toISOString()
        : null,
      freshByAge: resolverFreshByAge,
      freshByAgeOrLegacyCovered: resolverFreshByAgeOrLegacyCovered,
      freshForInputs: resolverFreshForInputs,
      scopeComplete: resolverScopeComplete,
      recentUnknownMembershipComplete,
      membershipEvidenceDefects: recentMembershipEvidenceDefects,
      membershipEvidenceCutoffDate: membershipCutoffDate,
      // Advisory only, never red for this card: older calls awaiting projection
      // write-back of current cluster ids, or members whose call file is gone.
      lifetimeMembershipEvidenceAdvisories: {
        count: lifetimeMembershipEvidenceAdvisories.length,
        reasons: lifetimeAdvisoryReasonCounts,
        callFileMissing: lifetimeMembershipEvidenceAdvisories.filter(
          (defect) => defect.reason === 'current_enriched_missing',
        ),
      },
      recentEligibleUnknownSpeakerRows: recentRosterMembership.eligibleSpeakerRows.length,
      recentUnclusteredUnknownSpeakerRows: unclusteredBeforeRun,
      recentUncheckedKnownVoiceSpeakerRows: uncheckedBeforeRun,
      runAt: Number.isFinite(resolverRunAnchorMs)
        ? new Date(resolverRunAnchorMs).toISOString()
        : null,
      ageHours: Number.isFinite(resolverUpdatedMs)
        ? Math.round((resolverAgeMs / 3600000) * 10) / 10
        : null,
      maxAgeHours: RESOLVER_MAX_AGE_MS / 3600000,
      reclusterAdvancedAfterRun,
      skippedTargetIds,
      // Informational, never red: evidence from calls that landed after the run.
      postRunTargetIds,
      postRunCallIds,
      postRunRowCount,
      currentUnknownTargets,
      currentUnknownTargetIds,
      scopeKind: resolverScopeKind,
      recentDays: recentScope?.windowDays || null,
      recentCutoffDate: recentScope?.cutoffDate || null,
      lifetimeUnknownTargets: lifetimeUnknownTargetIds?.length ?? null,
      lifetimeDeferredTargets:
        resolverScopeKind !== 'recent' ||
        lifetimeUnknownTargetIds === null ||
        currentUnknownTargetIds === null
          ? null
          : Math.max(0, lifetimeUnknownTargetIds.length - currentUnknownTargetIds.length),
      resolverUnknownTargetIds,
      total,
      selected,
      succeeded,
      failed,
      deferred,
      patternGuarded,
      precompleted,
      completed,
      statusAvailable: Boolean(resolver),
      // Owner-review items, never a defect (ExampleCo 2026-09-23, G27): only a track conflict
      // involving an owner confirmation or correction is held; it cannot turn this row red or
      // stop the resolver for any other target. Machine-vs-machine conflicts never land here.
      quarantinedTrackConflicts,
    },
  };
}

function quarantinedTrackConflictsForHealth(review) {
  const byId = new Map();
  for (const item of Array.isArray(review?.items) ? review.items : []) {
    const id = String(item?.id || '');
    if (!id || byId.has(id)) continue;
    byId.set(id, {
      id,
      candidates: (Array.isArray(item?.candidates) ? item.candidates : []).map((candidate) => ({
        personId: String(candidate?.person_id || ''),
        displayName: String(candidate?.display_name || candidate?.person_id || ''),
        source: String(candidate?.source || ''),
        score:
          candidate?.voice_match_score != null && Number.isFinite(Number(candidate.voice_match_score))
            ? Number(candidate.voice_match_score)
            : null,
      })),
    });
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function quarantinedConflictDetail(conflicts) {
  const rows = Array.isArray(conflicts) ? conflicts : [];
  if (!rows.length)
    return ' 0 owner-involved track conflicts awaiting review; machine-vs-machine voiceprint conflicts are settled by the acoustic rule (score 0.56, margin 0.06) or kept as durable unknowns.';
  const described = rows
    .map((row) => {
      const [otid, label] = row.id.split('|');
      const names = row.candidates
        .map(
          (c) =>
            `${c.displayName || c.personId || 'unknown'}${c.score == null ? '' : ` ${c.score.toFixed(2)}`} (${c.source.replace(/_/g, ' ')})`,
        )
        .join(' vs ');
      return `call ${otid} track ${label}: ${names}`;
    })
    .join('; ');
  return ` ${rows.length} owner-involved track conflict(s) held for owner review, no identity assigned or changed: ${described}. Machine-vs-machine voiceprint conflicts are settled by the acoustic rule and never held.`;
}

function runTimeCoverage(resolver) {
  const current = resolver.currentUnknownTargets;
  if (current == null) return 'unknown';
  const postRun = Array.isArray(resolver.postRunTargetIds) ? resolver.postRunTargetIds.length : 0;
  const skipped = Array.isArray(resolver.skippedTargetIds) ? resolver.skippedTargetIds.length : 0;
  const runTime = Math.max(0, Number(current) - postRun);
  return `${Math.max(0, runTime - skipped)}/${runTime}`;
}

function postRunDetail(resolver) {
  const targets = Array.isArray(resolver.postRunTargetIds) ? resolver.postRunTargetIds.length : 0;
  const calls = Array.isArray(resolver.postRunCallIds) ? resolver.postRunCallIds.length : 0;
  if (!targets && !calls && !Number(resolver.postRunRowCount || 0)) return '';
  const rows = Number(resolver.postRunRowCount || 0);
  return `; informational, not red: ${targets} unknown target(s) created after the run and ${calls} call(s) landed after it${rows ? `, ${rows} evidence row(s) from post-run changes` : ''}, all waiting for the next run`;
}

function otterHypothesisHealthWorkUnits(health) {
  if (!health) return [];
  const projectionAvailable = health.provenance?.status === 'available';
  const resolver = health.resolver || {};
  const resolverClean =
    /^completed(?:_no_refresh_requested)?$/i.test(String(resolver.phase || '')) &&
    Number(resolver.failed || 0) === 0 &&
    Number(resolver.deferred || 0) === 0 &&
    Number(resolver.patternGuarded || 0) === 0 &&
    (resolver.freshByAge === true || resolver.freshByAgeOrLegacyCovered === true) &&
    resolver.freshForInputs === true &&
    resolver.scopeComplete === true &&
    resolver.recentUnknownMembershipComplete !== false &&
    Number(resolver.completed || 0) >=
      Number(resolver.precompleted || 0) + Number(resolver.selected || 0);
  return [
    {
      id: 'system_health:otter-hypothesis-projection',
      name: 'Otter hypothesis projection',
      status: projectionAvailable ? 'green' : 'red',
      actionable: !projectionAvailable,
      detail: projectionAvailable
        ? `${health.projectedNames ?? 0} distinct provisional name(s) projected onto ${health.projectedSpeakerRows ?? 0} exact roster speaker row(s) from ${health.eligibleHypothesisRows ?? 0} eligible Pareto hypothesis row(s); roster-byte provenance matches.`
        : `Unavailable: ${health.provenance?.reason || health.reason || 'roster-byte provenance is not proven.'}`,
    },
    {
      id: 'system_health:otter-name-resolver',
      name: 'Otter name resolver',
      status: resolverClean ? 'green' : 'red',
      actionable: !resolverClean,
      detail: `Last complete run ${resolver.runAt || 'unknown'} (${resolver.ageHours == null ? 'age unknown' : `${resolver.ageHours}h ago`}, limit ${Number(resolver.maxAgeHours || 4)}h); phase ${resolver.phase || 'missing'}; ${resolver.scopeKind === 'recent' ? `rolling ${Number(resolver.recentDays || 7)}-day scope; ` : ''}${Number(resolver.succeeded || 0)}/${Number(resolver.selected || 0)} selected target(s) succeeded, ${Number(resolver.failed || 0)} failed, ${Number(resolver.deferred || 0)} in-scope deferred, ${Number(resolver.patternGuarded || 0)} pattern-guarded; run-time unknown-target coverage ${resolver.scopeComplete ? 'proven' : 'unproven'} (${runTimeCoverage(resolver)}), recent roster-to-recluster membership ${resolver.recentUnknownMembershipComplete !== false ? 'proven' : 'unproven'} (${Number(resolver.recentEligibleUnknownSpeakerRows || 0) - Number(resolver.recentUnclusteredUnknownSpeakerRows?.length || 0)}/${Number(resolver.recentEligibleUnknownSpeakerRows || 0)}), freshness ${(resolver.freshByAge || resolver.freshByAgeOrLegacyCovered) && resolver.freshForInputs ? 'proven' : 'unproven'}${resolver.scopeKind === 'recent' ? `; lifetime catch-up ${resolver.lifetimeDeferredTargets ?? 'unknown'}/${resolver.lifetimeUnknownTargets ?? 'unknown'} unknown target(s) explicitly deferred outside current health` : ''}${resolver.lifetimeMembershipEvidenceAdvisories?.count ? `; lifetime advisory ${Number(resolver.lifetimeMembershipEvidenceAdvisories.count)} older-call cluster member(s) awaiting projection write-back or missing a call file, outside current health` : ''}${postRunDetail(resolver)}.${quarantinedConflictDetail(resolver.quarantinedTrackConflicts)}`,
      ownerReviewItems: Array.isArray(resolver.quarantinedTrackConflicts)
        ? resolver.quarantinedTrackConflicts.map((row) => row.id)
        : [],
    },
  ];
}

module.exports = {
  buildHypothesisIndex,
  durableIdsForParetoRow,
  durableIdsForSpeaker,
  evaluateProjectionProvenance,
  hypothesisForParetoRow,
  hypothesisCoverageGate,
  normalizeDurableId,
  otterHypothesisHealthWorkUnits,
  projectCallsWithHypotheses,
  projectionWindowStats,
  projectSpeakerHypothesis,
  quarantinedTrackConflictsForHealth,
  recentUnknownTargetIdsFromArtifacts,
  recentUnknownRosterMembership,
  resolverEligibleUnknownCluster,
  readOtterHypothesisProjectionHealth,
  sha256Bytes,
  speakerBlocksHypothesis,
};
