'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  loadStageReceipts,
} = require('./otter-call-stage-receipt-store.js');
const {
  REQUIRED_STAGES,
} = require('./otter-call-closure-verifier.js');
const {
  artifactFile,
  authorizedCutoverRelease,
  loadCompletionEnvelope,
  readCutoverMarker,
} = require('./otter-exact-call-envelope.js');
const {
  isConfirmedIdentity,
} = require('./canonical-speaker-identity.js');
const {
  attemptRowsFromCycleReceipts,
} = require('./healer-attempt-history.js');
const {
  architectureProvenanceOrFailure,
  compatibleProducerContract,
  provenanceProblems,
} = require('./otter-architecture-provenance.js');
const {
  fingerprintCluster,
} = require('./voice-name-judge-coverage.js');
const {
  readCallSummaryArtifact,
} = require('./otter-exec-summary-artifacts.js');

// The ledger's own title already prefers a clean exec summary title (see
// otter-call-processing-ledger.js). A row whose title still equals its raw
// otid means either the ledger predates that fix or the summary is not yet
// clean; check the summary artifact directly rather than showing the id.
function displayTitleForLedgerRow(dataDir, row) {
  const otid = String(row?.otid || '');
  const title = String(row?.title || '') || otid;
  if (!otid || title !== otid) return title;
  const artifact = readCallSummaryArtifact({ dataDir, callId: otid });
  const summaryTitle = String(
    artifact?.status === 'clean'
      ? artifact.result?.displayTitle || artifact.result?.title || ''
      : '',
  ).trim();
  return summaryTitle || title;
}
const { EXACT_DISPATCH_DIRNAME } = require('./otter-exact-dispatch-events.js');

const LEDGER_BASENAME = 'otter-call-processing-ledger-latest.json';
const JOBS_BASENAME = 'otter-call-processing-healer-jobs-latest.json';
const EVENTS_BASENAME = 'otter-call-processing-healer-events.jsonl';
const LANDING_EVENTS_RELATIVE = path.join('agent', 'otter-call-landing-events.jsonl');
const HISTORICAL_PAUSE_BASENAME = 'otter-historical-backfill.pause';
const HANDOFF_DIRNAME = 'otter-call-healer-handoffs';
const CYCLE_DIRNAME = 'otter-call-processing-cycles';
const RECLUSTER_BASENAME = 'recluster-latest.json';
const BRIEFING_VOICE_QUEUE_BASENAME = 'briefing-voice-queue-latest.json';
const OVERALL_RED_MS = 60 * 60 * 1000;
const OVERALL_CRITICAL_MS = 120 * 60 * 1000;

const STAGE_VIEW = Object.freeze([
  {
    id: 'raw_archive',
    title: 'Raw archive',
    caption: 'Exact transcript bytes saved locally and in S3',
    ledgerStages: ['raw_transcript'],
  },
  {
    id: 'full_audio',
    title: 'Full audio',
    caption: 'Playable source audio collected and decoded',
    ledgerStages: ['full_audio'],
  },
  {
    id: 'diarization',
    title: 'Voice tracks',
    caption: 'Speaker turns and identity-grade probes built',
    ledgerStages: ['enriched_diarization', 'probe_coverage'],
  },
  {
    id: 'embeddings',
    title: 'Embeddings',
    caption: 'Voiceprint vectors created from the exact probes',
    ledgerStages: ['embeddings'],
  },
  {
    id: 'membership',
    title: 'Identity membership',
    caption: 'Each track joined to one durable person or unknown voiceprint',
    ledgerStages: ['acoustic_identity'],
  },
  {
    id: 'naming',
    title: 'Name disposition',
    caption: 'Whole-call marked-speaker name review completed',
    ledgerStages: ['name_disposition'],
  },
  {
    id: 'people_file_projection',
    title: 'People File',
    caption: 'Confirmed identities projected, or proved not applicable',
    ledgerStages: ['people_file_projection'],
  },
]);

function readJson(file, fallback = null, fsApi = fs) {
  try {
    return JSON.parse(fsApi.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

function readJsonLines(file, fsApi = fs) {
  try {
    return fsApi
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function readJsonFiles(directory, fsApi = fs) {
  const rows = [];
  const visit = (current) => {
    let entries = [];
    try {
      entries = fsApi.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && entry.name.endsWith('.json')) {
        const value = readJson(file, null, fsApi);
        if (value) rows.push({ ...value, _file: file });
      }
    }
  };
  visit(directory);
  return rows;
}

function readCycleRows(vpDir, call, fsApi = fs) {
  const receiptsDir = path.join(vpDir, CYCLE_DIRNAME, 'receipts');
  let names = [];
  try {
    names = fsApi.readdirSync(receiptsDir).filter((name) => name.endsWith('.jsonl'));
  } catch {
    return [];
  }
  return names
    .flatMap((name) => readJsonLines(path.join(receiptsDir, name), fsApi))
    .filter(
      (row) =>
        String(row?.otid || '') === String(call?.otid || '') &&
        String(row?.source_revision_hash || '').toLowerCase() ===
          String(call?.source_revision_hash || '').toLowerCase(),
    )
    .sort(
      (left, right) =>
        timeMs(left.timestamp || left.at) - timeMs(right.timestamp || right.at),
    );
}

function latestHandoff(vpDir, call, fsApi = fs) {
  return (
    readJsonFiles(path.join(vpDir, HANDOFF_DIRNAME), fsApi)
      .filter(
        (row) =>
          String(row?.otid || '') === String(call?.otid || '') &&
          String(row?.source_revision_hash || '').toLowerCase() ===
            String(call?.source_revision_hash || '').toLowerCase(),
      )
      .sort(
        (left, right) =>
          timeMs(right.updated_at || right.emitted_at) -
          timeMs(left.updated_at || left.emitted_at),
      )[0] || null
  );
}

function dispatchEvents(vpDir, call, bundleHash, fsApi = fs) {
  return readJsonFiles(path.join(vpDir, EXACT_DISPATCH_DIRNAME), fsApi)
    .filter(
      (row) =>
        row?.schema === 'life_archive_otter_exact_call_dispatch_event.v1' &&
        String(row?.otid || '') === String(call?.otid || '') &&
        String(row?.source_revision_hash || '').toLowerCase() ===
          String(call?.source_revision_hash || '').toLowerCase() &&
        (!bundleHash || String(row?.bundle_hash || '') === String(bundleHash)),
    )
    .filter(
      (row, index, all) =>
        all.findIndex(
          (candidate) =>
            String(candidate.bundle_hash || '') === String(row.bundle_hash || '') &&
            String(candidate.emitted_at || '') === String(row.emitted_at || ''),
        ) === index,
    )
    .sort((left, right) => timeMs(left.emitted_at) - timeMs(right.emitted_at));
}

function cycleProcessSummary(cycleRows) {
  const allocations = cycleRows.filter((row) => row.event === 'cycle_allocated');
  const completions = cycleRows.filter((row) =>
    ['cycle_completed', 'lease_expired'].includes(String(row.event || '')),
  );
  const processBlock =
    cycleRows
      .filter((row) => row.event === 'process_blocked')
      .at(-1) || null;
  const deferredLeaseIds = new Set(
    completions
      .filter((row) =>
        ['DEFERRED_CAPACITY', 'WAITING_CAPACITY'].includes(
          String(row.outcome || '').toUpperCase(),
        ),
      )
      .map((row) => row.lease_id)
      .filter(Boolean),
  );
  const consumed = allocations.filter((row) => !deferredLeaseIds.has(row.lease_id));
  const agentic = consumed.filter(
    (row) => row?.tactic_descriptor?.kind === 'otter-call-agentic-repair',
  );
  let consecutiveNoProgress = 0;
  for (let index = completions.length - 1; index >= 0; index -= 1) {
    const outcome = String(completions[index]?.outcome || '').toUpperCase();
    if (!['NO_PROGRESS', 'UNCHANGED', 'CRASHED_LEASE_EXPIRED'].includes(outcome)) break;
    consecutiveNoProgress += 1;
  }
  return {
    cycles_consumed: consumed.length,
    allocations: allocations.length,
    agentic_attempts: agentic.length,
    consecutive_no_progress: consecutiveNoProgress,
    blocked: Boolean(processBlock),
    blocked_status: processBlock?.status || '',
    blocked_detail: processBlock?.detail || '',
    last_outcome: completions.at(-1)?.outcome || '',
    current_process_key:
      processBlock?.process_key ||
      completions.at(-1)?.process_key ||
      allocations.at(-1)?.process_key ||
      '',
  };
}

function architectureStatus({
  envelope,
  cutover,
  consumer,
} = {}) {
  if (!envelope) {
    const problems = cutover?.found
      ? [
          ...(cutover?.ok
            ? cutover?.active_ok
              ? []
              : ['active cutover producer-contract hash is missing']
            : cutover.problems || ['cutover marker is invalid']),
        ]
      : [];
    return {
      status: problems.length ? 'mismatch' : 'not_available',
      problems: [...new Set(problems)],
      producer: null,
      consumer,
      cutover,
    };
  }
  const producer = envelope?.architecture_provenance || null;
  const problems = provenanceProblems(producer).map(
    (problem) => `producer ${problem}`,
  );
  problems.push(
    ...provenanceProblems(consumer).map((problem) => `consumer ${problem}`),
  );
  if (
    envelope &&
    String(envelope.producer_sha || '') !==
      String(producer?.task_image_source_sha || '')
  ) {
    problems.push('envelope producer SHA differs from task image source SHA');
  }
  if (cutover?.found && !cutover?.ok) {
    problems.push(...(cutover.problems || ['cutover marker is invalid']));
  }
  if (cutover?.ok && !cutover?.active_ok) {
    problems.push('active cutover producer-contract hash is missing');
  }
  let authorizedRelease = null;
  if (cutover?.ok) {
    authorizedRelease = authorizedCutoverRelease(cutover, {
      producerSha: producer?.task_image_source_sha,
      coreDocumentSha256: producer?.core_document_sha256,
      producerContractSha256: producer?.producer_contract_sha256,
      envelopeSchema: envelope?.schema,
      bundleHash: envelope?.bundle_hash,
    });
    if (!authorizedRelease) {
      problems.push(
        'no verified cutover release receipt authorizes the exact envelope producer SHA and core hash',
      );
    }
    if (cutover.marker.consumer_sha !== consumer?.source_sha) {
      problems.push('cutover consumer SHA differs from the live consumer release SHA');
    }
    const cutoverContract = String(cutover.marker.producer_contract_sha256 || '');
    if (
      !cutoverContract ||
      cutoverContract !== String(consumer?.producer_contract_sha256 || '')
    ) {
      problems.push('cutover producer contract differs from the live consumer');
    }
  } else if (
    !cutover?.found &&
    !compatibleProducerContract(producer, consumer)
  ) {
    problems.push('shadow producer and consumer Otter producer contracts differ');
  }
  return {
    status: problems.length
      ? 'mismatch'
      : cutover?.active_ok
        ? 'cutover_verified'
        : 'shadow_verified',
    problems: [...new Set(problems)],
    producer,
    consumer,
    authorized_release: authorizedRelease,
    cutover,
  };
}

function timeMs(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function latestIso(values) {
  return (values || [])
    .filter((value) => timeMs(value))
    .sort((left, right) => timeMs(right) - timeMs(left))[0] || '';
}

function spanClock(startAt, endAt) {
  const startMs = timeMs(startAt);
  const endMs = timeMs(endAt);
  return {
    start_at: startMs ? new Date(startMs).toISOString() : '',
    end_at: endMs ? new Date(endMs).toISOString() : '',
    duration_ms: startMs && endMs && endMs >= startMs ? endMs - startMs : null,
  };
}

function buildEventClocks({
  landingEvents = [],
  exactEnvelope = null,
  exactDispatchEvents = [],
  handoff = null,
  closureAt = '',
}) {
  const enqueuedAt = latestIso(
    landingEvents.filter((row) => row.type === 'enqueued').map((row) => row.at),
  );
  const launchedAt = latestIso(
    landingEvents.filter((row) => row.type === 'launched').map((row) => row.at),
  );
  const stageTimings = exactEnvelope?.envelope?.stage_timings || [];
  const executionStartedAt = [...stageTimings]
    .map((row) => row.started_at)
    .filter(timeMs)
    .sort((a, b) => timeMs(a) - timeMs(b))[0] || '';
  const executionCompletedAt =
    latestIso(stageTimings.map((row) => row.completed_at)) ||
    exactEnvelope?.envelope?.produced_at ||
    '';
  const dispatchAt = latestIso(exactDispatchEvents.map((row) => row.emitted_at));
  const handoffAt =
    handoff?.emitted_at ||
    [...(handoff?.history || [])]
      .map((row) => row.at)
      .filter(timeMs)
      .sort((a, b) => timeMs(a) - timeMs(b))[0] ||
    '';
  return {
    queue: spanClock(enqueuedAt, launchedAt),
    cold_start: spanClock(launchedAt, executionStartedAt),
    execution: spanClock(executionStartedAt, executionCompletedAt),
    handoff: spanClock(dispatchAt, handoffAt),
    closure: spanClock(handoffAt, closureAt),
  };
}

function currentSpeakerProjection({
  callId,
  speakerModelLabel,
  unknownSpeakerId = '',
  confirmedPersonId = '',
  projectionSource = {},
} = {}) {
  const recluster = projectionSource.recluster || null;
  const clusters = Array.isArray(recluster?.clusters) ? recluster.clusters : [];
  const label = String(speakerModelLabel || '');
  const otid = String(callId || '');
  const exactMemberCluster = clusters.find((cluster) =>
    (cluster?.members || []).some(
      (member) =>
        String(member?.otid || '') === otid &&
        String(member?.speaker_model_label || '') === label,
    ),
  );
  const identityCluster = unknownSpeakerId
    ? clusters.find(
        (cluster) =>
          String(cluster?.cluster_id || '') === String(unknownSpeakerId) ||
          (cluster?.members || []).some(
            (member) =>
              String(member?.voice_cluster_id || '') === String(unknownSpeakerId),
          ),
      )
    : null;
  const personId = String(confirmedPersonId || '').trim();
  const personClusters = personId
    ? clusters.filter(
        (candidate) =>
          String(candidate?.confirmed_person_id || '') === personId ||
          String(candidate?.cluster_id || '') === `person:${personId}`,
      )
    : [];
  const cluster =
    exactMemberCluster || identityCluster || personClusters[0] || null;
  const speakerIntelligence = projectionSource.speakerIntelligence || null;
  const personIntelligence = personId
    ? (speakerIntelligence?.known_speakers || []).find(
        (row) =>
          String(row?.person_id || '') === personId ||
          String(row?.speaker_key || '') === `person:${personId}` ||
          (row?.voice_cluster_ids || []).some(
            (value) => String(value || '') === `person:${personId}`,
          ),
      )
    : null;
  if (!cluster && !personIntelligence) return null;

  const clusterIds = new Set(
    [
      cluster?.cluster_id,
      ...(cluster?.members || []).map((member) => member?.voice_cluster_id),
    ]
      .map((value) => String(value || ''))
      .filter(Boolean),
  );
  const acousticCallIds = new Set(
    [
      ...(cluster?.otids || []),
      ...(cluster?.members || []).map((member) => member?.otid),
    ]
      .map((value) => String(value || ''))
      .filter(Boolean),
  );
  const personCallIds = new Set(
    (personId ? personClusters : [cluster])
      .flatMap((candidate) => [
        ...(candidate?.otids || []),
        ...(candidate?.members || []).map((member) => member?.otid),
      ])
      .map((value) => String(value || ''))
      .filter(Boolean),
  );
  const intelligenceCallCount = Number(personIntelligence?.conversation_count);
  const personCallCount =
    personId
      ? Math.max(
          personCallIds.size,
          Number.isFinite(intelligenceCallCount) && intelligenceCallCount >= 0
            ? intelligenceCallCount
            : 0,
        )
      : null;
  const queue = projectionSource.reviewQueue || null;
  const queueItem = [
    ...(queue?.unknown_voice_queue || []),
    ...(queue?.confirmation_queue || []),
  ].find((item) =>
    [
      item?.voice_cluster_id,
      item?.acoustic_unknown_id,
      item?.unknown_speaker_id,
      ...(item?.voice_cluster_ids || []),
    ]
      .map((value) => String(value || ''))
      .filter(Boolean)
      .some((id) => clusterIds.has(id)),
  );
  const currentFingerprint = cluster ? fingerprintCluster(cluster) : '';
  const queueFingerprint = String(
    queueItem?.name_judge_input_fingerprint ||
      queueItem?.input_fingerprint ||
      '',
  );
  const hypothesisSource =
    queueItem?.current_identity_hypothesis || queueItem?.guess || null;
  const hypothesisIsCurrent =
    queueItem?.name_judge_status === 'admissible_name' &&
    queueFingerprint &&
    queueFingerprint === currentFingerprint &&
    hypothesisSource?.display_name;
  const fullScript = queueItem?.full_script_name_hypothesis || {};

  return {
    schema: 'life_archive_otter_current_speaker_projection.v1',
    official_identity_status: personId ? 'confirmed' : 'unknown',
    confirmed_person_id: personId,
    current_acoustic_cluster_id: String(cluster?.cluster_id || ''),
    acoustic_call_count: acousticCallIds.size,
    acoustic_call_otids: [...acousticCallIds].sort(),
    person_call_count: personCallCount,
    person_call_otids: personId ? [...personCallIds].sort() : [],
    person_call_count_source:
      personId &&
      Number.isFinite(intelligenceCallCount) &&
      intelligenceCallCount >= personCallIds.size
        ? 'otter_speaker_intelligence'
        : personId
          ? 'recluster_person_union'
          : '',
    recluster_generated_at: recluster?.generated_at || '',
    speaker_intelligence_generated_at:
      speakerIntelligence?.generated_at || '',
    review_queue_generated_at: queue?.generated_at || '',
    input_fingerprint: currentFingerprint,
    provisional_name_hypothesis: hypothesisIsCurrent
      ? {
          display_name: String(hypothesisSource.display_name),
          heard_name: String(
            queueItem?.guess?.heard_name || fullScript.heard_name || '',
          ),
          confidence: String(hypothesisSource.confidence || ''),
          judge_confidence: Number.isFinite(
            Number(
              hypothesisSource.judge_confidence ??
                queueItem?.guess?.judge_confidence,
            ),
          )
            ? Number(
                hypothesisSource.judge_confidence ??
                  queueItem?.guess?.judge_confidence,
              )
            : null,
          evidence_count: Number(
            hypothesisSource.evidence_count ||
              fullScript.evidence_count ||
              0,
          ),
          distinct_name_evidence_calls: Number(
            fullScript.distinct_calls || 0,
          ),
          people_file_preselected:
            queueItem?.identity_guard?.people_file_preselected === true,
          source: 'current_voice_review_queue',
          is_provisional: true,
        }
      : null,
  };
}

function loadCurrentSpeakerProjectionSource(dataDir, fsApi = fs) {
  return {
    recluster: readJson(
      path.join(
        dataDir,
        'life-archive',
        'voiceprints',
        RECLUSTER_BASENAME,
      ),
      null,
      fsApi,
    ),
    reviewQueue: readJson(
      path.join(
        dataDir,
        'life-archive',
        'people',
        BRIEFING_VOICE_QUEUE_BASENAME,
      ),
      null,
      fsApi,
    ),
    speakerIntelligence: readJson(
      path.join(
        dataDir,
        'life-archive',
        'voiceprints',
        'otter-speaker-intelligence-latest.json',
      ),
      null,
      fsApi,
    ),
  };
}

function buildSpeakerAttribution({
  dataDir,
  callId,
  exactEnvelope,
  fsApi = fs,
} = {}) {
  if (!exactEnvelope?.ok) {
    return {
      available: false,
      reason: 'A verified immutable exact-call envelope is not available.',
      tracks: [],
      segments: [],
    };
  }
  const descriptor = exactEnvelope.envelope?.artifacts?.enriched_diarization;
  if (!descriptor) {
    return {
      available: false,
      reason: 'The exact envelope has no enriched diarization artifact.',
      tracks: [],
      segments: [],
    };
  }
  let enriched = null;
  try {
    enriched = readJson(
      artifactFile({
        dataDir,
        bundleDir: exactEnvelope.bundleDir || '',
        descriptor,
      }),
      null,
      fsApi,
    );
  } catch {
    enriched = null;
  }
  if (!enriched) {
    return {
      available: false,
      reason: 'The verified enriched diarization artifact is unreadable.',
      tracks: [],
      segments: [],
    };
  }

  const exactTracks = new Map(
    (exactEnvelope.envelope.identity_tracks || []).map((row) => [
      String(row?.speaker_model_label || ''),
      row,
    ]),
  );
  const enrichedTracks = enriched.speaker_identity_tracks || {};
  const candidatesByLabel = new Map();
  for (const candidate of exactEnvelope.envelope.ranked_identity_candidates || []) {
    const label = String(candidate?.speaker_model_label || '');
    if (!candidatesByLabel.has(label)) candidatesByLabel.set(label, []);
    candidatesByLabel.get(label).push(candidate);
  }
  for (const rows of candidatesByLabel.values()) {
    rows.sort((left, right) => Number(left.rank) - Number(right.rank));
  }
  const labels = new Set([
    ...exactTracks.keys(),
    ...Object.keys(enrichedTracks),
    ...(enriched.segments || []).map((row) => String(row?.speaker_model_label || '')),
    ...candidatesByLabel.keys(),
  ]);
  labels.delete('');
  const currentProjectionSource = loadCurrentSpeakerProjectionSource(
    dataDir,
    fsApi,
  );

  const tracks = [...labels]
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
    .map((label) => {
      const exactTrack = exactTracks.get(label) || {};
      const identity = exactTrack.identity || enrichedTracks[label] || {};
      const confirmed = isConfirmedIdentity(identity);
      const rankedCandidates = candidatesByLabel.get(label) || [];
      const unknownSpeakerId =
        identity.acoustic_unknown_id ||
        identity.unknown_speaker_id ||
        identity.voice_cluster_id ||
        '';
      return {
        speaker_model_label: label,
        status: confirmed ? 'confirmed' : 'unresolved',
        display_name: confirmed
          ? identity.resolved_person || identity.display_name || identity.person_id
          : 'Unknown speaker',
        person_id: confirmed ? identity.person_id || identity.confirmed_person_id || '' : '',
        canonical_speaker_id: confirmed ? identity.canonical_speaker_id || '' : '',
        unknown_speaker_id: unknownSpeakerId,
        current_projection: currentSpeakerProjection({
          callId,
          speakerModelLabel: label,
          unknownSpeakerId,
          confirmedPersonId: confirmed
            ? identity.person_id || identity.confirmed_person_id || ''
            : '',
          projectionSource: currentProjectionSource,
        }),
        identity_tier: identity.identity_tier || identity.status || '',
        confidence: Number.isFinite(Number(identity.confidence))
          ? Number(identity.confidence)
          : null,
        evidence: Array.isArray(identity.evidence) ? identity.evidence : [],
        substantive: exactTrack.substantive === true,
        identity_grade: exactTrack.identity_grade === true,
        ranked_candidates: rankedCandidates,
        uncertainty_reason: confirmed
          ? ''
          : exactTrack.uncertainty_reason ||
            (rankedCandidates.length
              ? 'Candidate evidence remains below the confirmation gate.'
              : 'No confirmed acoustic identity or exact ranked candidate evidence exists for this diarization track.'),
      };
    });
  const tracksByLabel = new Map(
    tracks.map((row) => [row.speaker_model_label, row]),
  );
  const segments = (enriched.segments || []).map((segment, index) => {
    const label = String(segment?.speaker_model_label || '');
    const track = tracksByLabel.get(label);
    const direct = segment?.resolved_speaker || {};
    const directConfirmed = isConfirmedIdentity(direct);
    const inherited = !directConfirmed && track?.status === 'confirmed';
    const displayName = directConfirmed
      ? direct.resolved_person || direct.display_name || direct.person_id
      : inherited
        ? track.display_name
        : 'Unknown speaker';
    const attributionSource = directConfirmed
      ? 'segment_exact_resolution'
      : inherited
        ? 'diarization_track_inheritance'
        : 'unresolved';
    const durationSeconds =
      Number.isFinite(Number(segment?.start_seconds)) &&
      Number.isFinite(Number(segment?.end_seconds))
        ? Math.max(0, Number(segment.end_seconds) - Number(segment.start_seconds))
        : null;
    const wordCount = Number.isFinite(Number(segment?.word_count))
      ? Number(segment.word_count)
      : String(segment?.text || '').trim().split(/\s+/).filter(Boolean).length;
    const uncertaintyReason =
      attributionSource === 'unresolved'
        ? track?.uncertainty_reason ||
          'This diarization segment is not linked to a confirmed acoustic identity.'
        : '';
    return {
      segment_id: segment?.segment_id || `segment-${index + 1}`,
      speaker_model_label: label,
      start_seconds: Number.isFinite(Number(segment?.start_seconds))
        ? Number(segment.start_seconds)
        : null,
      end_seconds: Number.isFinite(Number(segment?.end_seconds))
        ? Number(segment.end_seconds)
        : null,
      duration_seconds: durationSeconds,
      word_count: wordCount,
      // Identity-grade audio begins at six seconds. Shorter segments can only
      // inherit a confirmed identity through their Otter diarization track.
      short_segment: durationSeconds !== null && durationSeconds < 6,
      text: String(segment?.text || ''),
      display_name: displayName,
      person_id: directConfirmed
        ? direct.person_id || direct.confirmed_person_id || ''
        : inherited
          ? track.person_id
          : '',
      attribution_source: attributionSource,
      uncertainty_reason: uncertaintyReason,
      words: (segment?.words || []).map((word) => ({
        word: String(word?.word || ''),
        start_seconds: Number.isFinite(Number(word?.start_seconds))
          ? Number(word.start_seconds)
          : null,
        end_seconds: Number.isFinite(Number(word?.end_seconds))
          ? Number(word.end_seconds)
          : null,
        display_name: displayName,
        attribution_source: attributionSource,
        uncertainty_reason: uncertaintyReason,
      })),
    };
  });

  return {
    available: true,
    source: {
      kind: descriptor.kind,
      path: descriptor.path,
      sha256: descriptor.sha256,
      bundle_hash: exactEnvelope.envelope.bundle_hash,
    },
    tracks,
    segments,
    short_segments: segments.filter((row) => row.short_segment).length,
    unresolved_segments: segments.filter(
      (row) => row.attribution_source === 'unresolved',
    ).length,
  };
}

function terminalLedgerStage(row) {
  return ['complete', 'not_required', 'terminal_disposition'].includes(
    String(row?.status || ''),
  );
}

function receiptSummary(receipt) {
  const payload = receipt?.payload || {};
  switch (receipt?.stage) {
    case 'raw_archive': {
      const localHash = String(payload?.local_archive?.content_hash || '');
      const remoteHash = String(payload?.raw_archive?.content_hash || '');
      const match = localHash && remoteHash && localHash === remoteHash;
      return match
        ? `${Number(payload?.local_archive?.bytes || 0).toLocaleString()} bytes, local and S3 hashes match`
        : 'Raw transcript archive receipt is present';
    }
    case 'full_audio':
      return `${Number(payload.duration_seconds || 0).toFixed(2)} seconds, ${payload.codec || 'audio'}, ${payload.decodable ? 'decodable' : 'decode not proved'}`;
    case 'diarization': {
      const tracks = Array.isArray(payload.tracks) ? payload.tracks : [];
      const identityGrade = tracks.filter((track) => track?.identity_grade === true).length;
      return `${tracks.length} voice track${tracks.length === 1 ? '' : 's'}, ${identityGrade} identity-grade`;
    }
    case 'embeddings': {
      const items = Array.isArray(payload.items) ? payload.items : [];
      const models = [...new Set(items.map((item) => item?.model).filter(Boolean))];
      return `${items.length} embedding${items.length === 1 ? '' : 's'}${models.length ? ` using ${models.join(', ')}` : ''}`;
    }
    case 'membership': {
      const rows = Array.isArray(payload.dispositions) ? payload.dispositions : [];
      const statuses = [...new Set(rows.map((row) => row?.status).filter(Boolean))];
      return `${rows.length} track disposition${rows.length === 1 ? '' : 's'}${statuses.length ? `: ${statuses.join(', ')}` : ''}`;
    }
    case 'naming': {
      const rows = Array.isArray(payload.dispositions) ? payload.dispositions : [];
      const statuses = [...new Set(rows.map((row) => row?.status).filter(Boolean))];
      return `${rows.length} naming disposition${rows.length === 1 ? '' : 's'}${statuses.length ? `: ${statuses.join(', ')}` : ''}`;
    }
    case 'people_file_projection':
      return payload.disposition === 'not_applicable'
        ? `Not applicable: ${payload.reason || 'no confirmed person identity'}`
        : payload.reason || payload.disposition || 'People File projection receipt is present';
    default:
      return 'Current exact-revision receipt is present';
  }
}

function receiptEvidence(receipt) {
  const payload = receipt?.payload || {};
  switch (receipt?.stage) {
    case 'raw_archive':
      return {
        local_content_hash: payload?.local_archive?.content_hash || '',
        s3_content_hash: payload?.raw_archive?.content_hash || '',
        s3_uri: payload?.raw_archive?.uri || '',
        s3_version_id: payload?.raw_archive?.version_id || '',
      };
    case 'full_audio':
      return {
        audio_hash: payload.audio_hash || '',
        bytes: payload.bytes || 0,
        duration_seconds: payload.duration_seconds || 0,
        codec: payload.codec || '',
        decodable: payload.decodable === true,
      };
    case 'diarization':
      return { tracks: payload.tracks || [] };
    case 'embeddings':
      return {
        items: (payload.items || []).map((item) => ({
          track_id: item.track_id || '',
          model: item.model || '',
          model_version: item.model_version || '',
          probe_audio_hash: item.probe_audio_hash || '',
          embedding_hash: item.embedding_hash || '',
        })),
      };
    case 'membership':
    case 'naming':
      return { dispositions: payload.dispositions || [] };
    case 'people_file_projection':
      return payload;
    default:
      return payload;
  }
}

function buildStageNode(definition, receipt, call, landedMs) {
  const ledgerRows = definition.ledgerStages.map((name) => ({
    name,
    ...(call?.stages?.[name] || {}),
  }));
  const allTerminal =
    ledgerRows.length > 0 && ledgerRows.every((row) => terminalLedgerStage(row));
  const anyFailed = ledgerRows.some((row) => row.status === 'failed');
  const producedMs = timeMs(receipt?.produced_at);
  let status = 'pending';
  if (anyFailed) status = receipt ? 'state_divergence' : 'failed';
  else if (receipt) status = 'complete';
  else if (allTerminal) status = 'awaiting_receipt';
  return {
    ...definition,
    status,
    receipt_id: receipt?.receipt_id || '',
    receipt_hash: receipt?.receipt_hash || '',
    produced_at: receipt?.produced_at || '',
    elapsed_ms: producedMs && landedMs ? Math.max(0, producedMs - landedMs) : null,
    summary: receipt
      ? receiptSummary(receipt)
      : ledgerRows.map((row) => row.detail).filter(Boolean).join('; ') || 'Waiting for evidence',
    evidence: receipt ? receiptEvidence(receipt) : { ledger_stages: ledgerRows },
  };
}

function buildControlPath({
  call,
  exactEnvelope,
  exactDispatchEvents,
  handoff,
  cycleSummary,
  closedWithProof,
} = {}) {
  const envelopeStatus = exactEnvelope?.ok
    ? 'complete'
    : call?.exact_completion_envelope?.required
      ? 'failed'
      : 'not_required';
  const stateStatus = call?.state_divergence
    ? 'failed'
    : call?.stages?.state_consistency?.status === 'complete'
      ? 'complete'
      : call?.stages?.state_consistency?.status || 'pending';
  const dispatchEvent = exactDispatchEvents.at(-1) || null;
  const handoffTerminal = ['closed', 'superseded_with_proof'].includes(
    String(handoff?.state || ''),
  );
  const noRepairRequired = closedWithProof && !handoff && !cycleSummary.allocations;
  const repairStatus = cycleSummary.blocked
    ? 'failed'
    : handoffTerminal || closedWithProof
      ? 'complete'
      : cycleSummary.allocations || handoff
        ? 'active'
        : 'pending';
  return [
    {
      id: 'exact_envelope',
      title: 'Exact completion envelope',
      caption: 'One immutable bundle for this Otter ID and raw transcript SHA',
      status: envelopeStatus,
      at: exactEnvelope?.envelope?.produced_at || '',
      summary: exactEnvelope?.ok
        ? `Verified bundle ${String(exactEnvelope.envelope.bundle_hash || '').slice(0, 16)}`
        : (exactEnvelope?.problems || []).join('; ') ||
          call?.stages?.exact_completion_envelope?.detail ||
          'Waiting for the exact bundle',
      evidence: {
        file: exactEnvelope?.file || call?.exact_completion_envelope?.file || '',
        bundle_hash:
          exactEnvelope?.envelope?.bundle_hash ||
          call?.exact_completion_envelope?.bundle_hash ||
          '',
        producer_sha:
          exactEnvelope?.envelope?.producer_sha ||
          call?.exact_completion_envelope?.producer_sha ||
          '',
      },
    },
    {
      id: 'atomic_promotion',
      title: 'Atomic promotion',
      caption: 'Verified bundle copied into the self-contained canonical inbox',
      status: exactEnvelope?.ok ? 'complete' : envelopeStatus,
      at: exactEnvelope?.envelope?.produced_at || '',
      summary: exactEnvelope?.ok
        ? 'Canonical inbox verifies every artifact hash and byte count'
        : 'No verified canonical inbox bundle yet',
      evidence: {
        bundle_dir: exactEnvelope?.bundleDir || '',
        verified: exactEnvelope?.ok === true,
        problems: exactEnvelope?.problems || [],
      },
    },
    {
      id: 'state_consistency',
      title: 'State projection',
      caption: 'Exact bundle stays authoritative; aggregate state must agree or remain derived',
      status: stateStatus,
      at: call?.stages?.state_consistency?.completed_at || '',
      summary:
        call?.stages?.state_consistency?.detail || 'Waiting for exact state comparison',
      evidence: call?.stages?.state_consistency?.evidence || {},
    },
    {
      id: 'dispatch_event',
      title: 'Dispatch event',
      caption: 'Durable exact-call event emitted after canonical promotion',
      status: dispatchEvent ? 'complete' : exactEnvelope?.ok ? 'pending' : envelopeStatus,
      at: dispatchEvent?.emitted_at || '',
      summary: dispatchEvent
        ? `Canonical event for bundle ${String(dispatchEvent.bundle_hash || '').slice(0, 16)}`
        : 'Waiting for the post-promotion dispatch event',
      evidence: dispatchEvent || {},
    },
    {
      id: 'durable_handoff',
      title: 'Durable handoff',
      caption: 'One persisted owner state for this exact call revision',
      status: noRepairRequired
        ? 'not_required'
        : handoff?.terminal_blocked
          ? 'failed'
          : handoffTerminal
            ? 'complete'
            : handoff
              ? 'active'
              : dispatchEvent
                ? 'pending'
                : 'pending',
      at: handoff?.updated_at || handoff?.emitted_at || '',
      summary: noRepairRequired
        ? 'Call closed from exact evidence before repair was needed'
        : handoff
          ? `${String(handoff.state || 'unknown').replace(/_/g, ' ')} at ${handoff.failed_stage || 'unknown stage'}`
          : 'Waiting for a durable handoff or exact closure proof',
      evidence: handoff || {},
    },
    {
      id: 'bounded_repair',
      title: 'Bounded repair',
      caption: 'Mechanical tactics, then one shared-history card agent, capped at 8 cycles',
      status: noRepairRequired ? 'not_required' : repairStatus,
      at: handoff?.updated_at || '',
      summary: cycleSummary.blocked
        ? `${String(cycleSummary.blocked_status || 'BLOCKED').replace(/_/g, ' ')}: ${cycleSummary.blocked_detail || 'terminal defect remains red'}`
        : `${cycleSummary.cycles_consumed}/8 cycle(s) consumed; ${cycleSummary.consecutive_no_progress}/3 consecutive no-progress; ${cycleSummary.agentic_attempts} agent attempt(s)`,
      evidence: cycleSummary,
    },
    {
      id: 'closure_proof',
      title: 'Closure proof',
      caption: 'Seven current exact-revision receipts and manifest verified',
      status: closedWithProof ? 'complete' : cycleSummary.blocked ? 'failed' : 'pending',
      at: call?.orchestration?.exact_revision_closure?.completed_at || '',
      summary: closedWithProof
        ? 'Exact revision is terminal with current receipt proof'
        : cycleSummary.blocked
          ? 'Call remains a briefing defect after bounded repair stopped'
          : 'Waiting for all exact-revision proof',
      evidence: {
        status: call?.receipt_closure?.status || 'open',
        manifest_hash:
          call?.receipt_closure?.manifest_hash ||
          call?.receipt_closure?.manifest?.manifest_hash ||
          '',
      },
    },
  ];
}

function eventLabel(row) {
  const event = String(row?.event || row?.status || '');
  const cycle = Number(row?.cycle || row?.replacement_cycle || 0);
  const tactic = String(
    row?.tactic_plan ||
      row?.tactic_descriptor?.plan ||
      row?.tactic_descriptor?.kind ||
      row?.failed_stage ||
      '',
  ).replace(/_/g, ' ');
  if (event === 'started') return `Healer cycle ${cycle || '?'} started: ${tactic || 'targeted repair'}`;
  if (event === 'cycle_allocated') {
    return `Bounded cycle ${cycle || '?'} allocated: ${tactic || 'targeted repair'}`;
  }
  if (event === 'cycle_completed') {
    return `Bounded cycle ${cycle || '?'} ended ${String(row.outcome || 'unknown').replace(/_/g, ' ')}: ${tactic || 'targeted repair'}`;
  }
  if (event === 'process_blocked') {
    return `${String(row.status || 'BLOCKED').replace(/_/g, ' ')}: ${row.detail || 'bounded repair stopped and remains a briefing defect'}`;
  }
  if (event === 'stale_job_reclaimed') {
    return `Dead healer cycle ${row.reclaimed_cycle || '?'} reclaimed; cycle ${row.replacement_cycle || '?'} took over`;
  }
  if (event === 'superseded_input_changed') {
    return `Cycle ${cycle || '?'} superseded after its exact input fingerprint changed`;
  }
  if (event === 'handed_back') {
    return `Cycle ${cycle || '?'} handed back ${String(row.handback_stage || row.failed_stage || 'stage').replace(/_/g, ' ')}: ${row.call_closed ? 'call closed' : 'more work remained'}`;
  }
  return `${event.replace(/_/g, ' ') || 'Healer event'}${tactic ? `: ${tactic}` : ''}`;
}

function buildTimeline(
  call,
  receipts,
  events,
  {
    exactEnvelope = null,
    exactDispatchEvents = [],
    handoff = null,
    cycleRows = [],
    landingEvents = [],
    closedWithProof = false,
    closureAt = '',
  } = {},
) {
  const rows = [];
  if (call?.landed_at) {
    rows.push({
      at: call.landed_at,
      kind: 'landing',
      label: 'Finalized transcript revision landed',
    });
  }
  for (const event of landingEvents) {
    rows.push({
      at: event.at || '',
      kind: 'landing',
      stage: event.type === 'launched' ? 'fargate_launch' : 'landing_queue',
      label:
        event.type === 'launched'
          ? 'Exact call launched into the Fargate producer'
          : event.type === 'enqueued'
            ? 'Exact call entered the durable landing queue'
            : `Landing queue ${String(event.type || 'event').replace(/_/g, ' ')}`,
    });
  }
  for (const receipt of receipts) {
    rows.push({
      at: receipt.produced_at || '',
      kind: 'receipt',
      stage: receipt.stage,
      label: `${STAGE_VIEW.find((stage) => stage.id === receipt.stage)?.title || receipt.stage} receipt became current`,
    });
  }
  if (exactEnvelope?.ok) {
    rows.push({
      at: exactEnvelope.envelope.produced_at || '',
      kind: 'envelope',
      stage: 'exact_completion_envelope',
      label: 'Exact completion envelope verified in the canonical inbox',
    });
  }
  for (const event of exactDispatchEvents) {
    rows.push({
      at: event.emitted_at || '',
      kind: 'dispatch',
      stage: 'dispatch_event',
      label: 'Atomic promotion emitted the exact-call dispatch event',
    });
  }
  for (const transition of handoff?.history || []) {
    rows.push({
      at: transition.at || '',
      kind: 'handoff',
      stage: transition.failed_stage || handoff.failed_stage || '',
      label: `Durable handoff ${String(transition.from || 'new').replace(/_/g, ' ')} to ${String(transition.to || handoff.state || '').replace(/_/g, ' ')}${transition.reason ? `: ${String(transition.reason).replace(/_/g, ' ')}` : ''}`,
    });
  }
  for (const cycle of cycleRows) {
    if (!['cycle_allocated', 'cycle_completed', 'process_blocked'].includes(cycle.event)) {
      continue;
    }
    rows.push({
      at: cycle.timestamp || cycle.at || '',
      kind: cycle.event === 'process_blocked' ? 'blocked' : 'healer',
      stage: cycle.stage || '',
      label: eventLabel(cycle),
    });
  }
  for (const event of events) {
    rows.push({
      at: event.completed_at || event.updated_at || event.started_at || event.reclaimed_at || '',
      kind: 'healer',
      stage: event.failed_stage || '',
      label: eventLabel(event),
    });
  }
  if (closedWithProof) {
    rows.push({
      at: closureAt || call?.orchestration?.exact_revision_closure?.completed_at || '',
      kind: 'closure',
      stage: 'exact_revision_closure',
      label: 'Seven-receipt exact-revision closure manifest verified',
    });
  }
  return rows
    .filter((row) => timeMs(row.at))
    .sort((left, right) => timeMs(left.at) - timeMs(right.at));
}

function buildOtterCallGraph({
  dataDir,
  otid = '',
  nowMs = Date.now(),
  fsApi = fs,
} = {}) {
  const resolvedDataDir = path.resolve(String(dataDir || ''));
  const vpDir = path.join(resolvedDataDir, 'life-archive', 'voiceprints');
  const ledger = readJson(path.join(vpDir, LEDGER_BASENAME), null, fsApi);
  if (!ledger || !Array.isArray(ledger.calls)) {
    return {
      ok: false,
      status: 'unavailable',
      error: 'The exact-call processing ledger is missing or unreadable.',
    };
  }
  const recentCalls = [...ledger.calls]
    .sort((left, right) => timeMs(right.landed_at) - timeMs(left.landed_at))
    .slice(0, 20)
    .map((row) => ({
      otid: row.otid,
      title: displayTitleForLedgerRow(resolvedDataDir, row),
      landed_at: row.landed_at || '',
      status: row.closed ? 'closed' : 'open',
    }));
  const requested = String(otid || '').trim();
  const call = requested
    ? ledger.calls.find((row) => String(row.otid) === requested)
    : recentCalls.length
      ? ledger.calls.find((row) => row.otid === recentCalls[0].otid)
      : null;
  if (!call) {
    return {
      ok: false,
      status: 'not_found',
      error: requested
        ? `No exact-call ledger row exists for ${requested}.`
        : 'The exact-call ledger has no calls.',
      recent_calls: recentCalls,
    };
  }

  let store = { receipts: [], missing_stages: [...REQUIRED_STAGES], problems: [] };
  try {
    store = loadStageReceipts({
      rootDir: path.join(vpDir, 'otter-call-stage-receipts'),
      callId: call.otid,
      sourceRevision: call.source_revision_hash,
      fsApi,
    });
  } catch (error) {
    store.problems.push(error.message);
  }
  const receiptsByStage = new Map(
    (store.receipts || []).map((receipt) => [receipt.stage, receipt]),
  );
  const landedMs = timeMs(call.landed_at);
  const stages = STAGE_VIEW.map((definition) =>
    buildStageNode(definition, receiptsByStage.get(definition.id), call, landedMs),
  );
  const exactEnvelope = loadCompletionEnvelope({
    dataDir: resolvedDataDir,
    otid: call.otid,
    sourceRevisionHash: call.source_revision_hash,
    fsApi,
  });
  const cutover = readCutoverMarker(resolvedDataDir, fsApi);
  const consumerArchitecture = architectureProvenanceOrFailure({
    rootDir: path.resolve(__dirname, '..', '..'),
    dataDir: resolvedDataDir,
    fsApi,
  });
  const architecture = architectureStatus({
    envelope: exactEnvelope?.ok ? exactEnvelope.envelope : null,
    cutover,
    consumer: consumerArchitecture,
  });
  const exactDispatch = dispatchEvents(
    vpDir,
    call,
    exactEnvelope?.envelope?.bundle_hash ||
      call?.exact_completion_envelope?.bundle_hash ||
      '',
    fsApi,
  );
  const landingEvents = readJsonLines(
    path.join(resolvedDataDir, LANDING_EVENTS_RELATIVE),
    fsApi,
  ).filter(
    (row) =>
      row?.schema === 'otter_call_landing_queue.v1' &&
      String(row?.otid || '') === String(call.otid) &&
      String(row?.source_revision || '').toLowerCase() ===
        String(call.source_revision_hash || '').toLowerCase(),
  );
  const handoff = latestHandoff(vpDir, call, fsApi);
  const cycleRows = readCycleRows(vpDir, call, fsApi);
  const cycleSummary = cycleProcessSummary(cycleRows);
  const revisionEvents = readJsonLines(path.join(vpDir, EVENTS_BASENAME), fsApi).filter(
    (row) =>
      String(row?.otid || row?.call_id || '') === String(call.otid) &&
      (!row?.source_revision_hash ||
        String(row.source_revision_hash).toLowerCase() ===
          String(call.source_revision_hash || '').toLowerCase()),
  );
  const jobs = (
    readJson(path.join(vpDir, JOBS_BASENAME), { jobs: [] }, fsApi)?.jobs || []
  ).filter(
    (row) =>
      String(row?.otid || row?.call_id || '') === String(call.otid) &&
      (!row?.source_revision_hash ||
        String(row.source_revision_hash).toLowerCase() ===
          String(call.source_revision_hash || '').toLowerCase()),
  );
  const latestReceiptAt = latestIso(store.receipts.map((receipt) => receipt.produced_at));
  const closedWithProof =
    store.receipts.length === REQUIRED_STAGES.length &&
    !store.missing_stages.length &&
    !store.problems.length;
  const closureCompletedMs = timeMs(
    call?.orchestration?.exact_revision_closure?.completed_at,
  );
  const endMs = closedWithProof
    ? Math.max(timeMs(latestReceiptAt), closureCompletedMs)
    : nowMs;
  const wallMs = landedMs && endMs ? Math.max(0, endMs - landedMs) : null;
  let slaStatus = 'processing';
  if (closedWithProof) slaStatus = wallMs <= OVERALL_RED_MS ? 'on_time' : 'closed_late';
  else if (wallMs > OVERALL_CRITICAL_MS) slaStatus = 'critical';
  else if (wallMs > OVERALL_RED_MS) slaStatus = 'red';
  let overallStatus = closedWithProof
    ? slaStatus === 'on_time'
      ? 'closed_proven'
      : 'closed_proven_late'
    : slaStatus === 'critical'
      ? 'open_critical'
      : slaStatus === 'red'
        ? 'open_red'
        : 'open_processing';
  // State divergence only applies when the ledger is newer than all stage receipts.
  // If the ledger predates any receipt, the ledger has not yet projected receipt-driven
  // closure (normal aggregate lag). The ledger builder applies receipt closure on rebuild.
  const latestReceiptMs = store.receipts.reduce(
    (max, r) => Math.max(max, timeMs(r.produced_at)),
    0,
  );
  const ledgerMs = timeMs(ledger.generated_at);
  const ledgerPredatesReceipts =
    ledgerMs > 0 && latestReceiptMs > 0 && ledgerMs < latestReceiptMs;
  const closureStateDivergence =
    closedWithProof &&
    !ledgerPredatesReceipts &&
    (
      call?.closed !== true ||
      call?.receipt_closure?.closed !== true ||
      call?.receipt_closure?.status !== 'closed'
    );
  if (closureStateDivergence) {
    overallStatus = 'state_divergence';
  }
  if (architecture.status === 'mismatch') {
    overallStatus = 'architecture_release_blocked';
  }
  const controlPath = buildControlPath({
    call,
    exactEnvelope,
    exactDispatchEvents: exactDispatch,
    handoff,
    cycleSummary,
    closedWithProof,
  });
  const attemptHistory = attemptRowsFromCycleReceipts(cycleRows, {
    processKey: cycleSummary.current_process_key,
  });
  const closureAt =
    latestReceiptAt ||
    call?.orchestration?.exact_revision_closure?.completed_at ||
    '';
  const eventClocks = buildEventClocks({
    landingEvents,
    exactEnvelope,
    exactDispatchEvents: exactDispatch,
    handoff,
    closureAt,
  });
  const speakerAttribution = buildSpeakerAttribution({
    dataDir: resolvedDataDir,
    callId: call.otid,
    exactEnvelope,
    fsApi,
  });

  return {
    ok: true,
    schema: 'life_archive_otter_call_processing_graph.v2',
    generated_at: new Date(nowMs).toISOString(),
    ledger_generated_at: ledger.generated_at || '',
    status: overallStatus,
    closed_with_proof: closedWithProof,
    state_divergence: closureStateDivergence
      ? {
          code: 'RECEIPTS_CLOSED_LEDGER_OPEN',
          detail: 'Exact receipts prove closure but the settlement-backed ledger is still open.',
        }
      : null,
    exact_current_revision:
      store.receipts.length > 0 &&
      store.receipts.every(
        (receipt) =>
          String(receipt.call_id) === String(call.otid) &&
          String(receipt.source_revision).toLowerCase() ===
          String(call.source_revision_hash).toLowerCase(),
      ),
    exact_completion_envelope: {
      found: exactEnvelope.found === true,
      verified: exactEnvelope.ok === true,
      required: call?.exact_completion_envelope?.required === true,
      file: exactEnvelope.file || call?.exact_completion_envelope?.file || '',
      bundle_dir: exactEnvelope.bundleDir || '',
      bundle_hash:
        exactEnvelope?.envelope?.bundle_hash ||
        call?.exact_completion_envelope?.bundle_hash ||
        '',
      producer_sha:
        exactEnvelope?.envelope?.producer_sha ||
        call?.exact_completion_envelope?.producer_sha ||
        '',
      produced_at: exactEnvelope?.envelope?.produced_at || '',
      problems: exactEnvelope.problems || [],
      cutover,
    },
    architecture_provenance: architecture,
    event_clocks: eventClocks,
    event_freshness: {
      latest_event_at: latestIso([
        ...landingEvents.map((row) => row.at),
        exactEnvelope?.envelope?.produced_at,
        ...exactDispatch.map((row) => row.emitted_at),
        handoff?.updated_at,
        latestReceiptAt,
      ]),
      ledger_generated_at: ledger.generated_at || '',
    },
    speaker_attribution: speakerAttribution,
    sla: {
      status: slaStatus,
      wall_ms: wallMs,
      red_after_minutes: 60,
      critical_after_minutes: 120,
      exact_closure_deadline_minutes: 45,
    },
    historical_backfill: {
      paused: fsApi.existsSync(path.join(vpDir, HISTORICAL_PAUSE_BASENAME)),
      marker: HISTORICAL_PAUSE_BASENAME,
    },
    call: {
      otid: call.otid,
      title: displayTitleForLedgerRow(resolvedDataDir, call),
      landed_at: call.landed_at || '',
      source_revision_hash: call.source_revision_hash || '',
      supersedes_source_revision_hash: call.supersedes_source_revision_hash || '',
      status: call.status || '',
      failed_stages: call.failed_stages || [],
      identity_relevant_tracks: Number(call.identity_relevant_tracks || 0),
      identity_grade_track_ids: call.identity_grade_track_ids || [],
      stages: call.stages || {},
      orchestration: call.orchestration || {},
    },
    receipt_closure: {
      status: closedWithProof ? 'closed' : call.receipt_closure?.status || 'open',
      receipt_count: store.receipts.length,
      expected_receipt_count: REQUIRED_STAGES.length,
      missing_stages: store.missing_stages || [],
      problems: [
        ...new Set([
          ...(store.problems || []),
          ...(call.receipt_closure?.problems || []),
        ]),
      ],
      manifest_hash: call.receipt_closure?.manifest?.manifest_hash || '',
    },
    budgets: ledger.stage_budget_calibration || {},
    stages,
    control_path: controlPath,
    healer: {
      jobs: jobs.map((row) => ({
        job_id: row.job_id || '',
        failed_stage: row.failed_stage || '',
        status: row.status || '',
        cycle: row.cycle || 0,
        tactic_plan: row.tactic_plan || '',
        started_at: row.started_at || '',
        completed_at: row.completed_at || '',
        handback_stage: row.handback_stage || '',
        call_closed: row.call_closed === true,
        remaining_failed_stages: row.remaining_failed_stages || [],
      })),
      events: revisionEvents.slice(-100),
      handoff,
      cycles: cycleRows,
      cycle_summary: cycleSummary,
      attempt_history: attemptHistory,
    },
    timeline: buildTimeline(call, store.receipts || [], revisionEvents.slice(-100), {
      exactEnvelope,
      exactDispatchEvents: exactDispatch,
      handoff,
      cycleRows,
      landingEvents,
      closedWithProof,
      closureAt,
    }),
    recent_calls: recentCalls,
  };
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function faceTime(value) {
  if (!timeMs(value)) return 'not recorded';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(value));
}

function durationFace(ms) {
  if (!Number.isFinite(Number(ms))) return 'not measured';
  const seconds = Math.max(0, Number(ms) / 1000);
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} sec`;
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.round(seconds % 60);
  if (minutes < 60) return `${minutes}m ${remaining}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function budgetFace(minutes) {
  const value = Number(minutes);
  return Number.isFinite(value) ? durationFace(value * 60 * 1000) : 'not calibrated';
}

function statusFace(status) {
  return String(status || '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function renderOtterCallGraphHtml(graph) {
  if (!graph?.ok) {
    return `<!doctype html><html><head><meta charset="utf-8"><title>Otter per-call processor</title></head><body><h1>Otter per-call processor</h1><p>${escapeHtml(graph?.error || 'Unavailable')}</p></body></html>`;
  }
  const call = graph.call;
  const statusClass =
    graph.status === 'closed_proven'
      ? 'good'
      : graph.status === 'closed_proven_late' || graph.status === 'open_processing'
        ? 'warn'
        : 'bad';
  const statusText =
    graph.status === 'architecture_release_blocked'
      ? 'BLOCKED, ARCHITECTURE PROVENANCE MISMATCH'
      : graph.status === 'state_divergence'
        ? 'BLOCKED, RECEIPTS AND LEDGER DISAGREE'
      : graph.status === 'closed_proven'
      ? 'PROVEN CLOSED, ON TIME'
      : graph.status === 'closed_proven_late'
        ? 'PROVEN CLOSED, BUT LATE'
        : graph.status === 'open_processing'
          ? 'PROCESSING'
          : graph.status === 'open_critical'
            ? 'CRITICAL, OVER 2 HOURS'
            : 'RED, OVER 1 HOUR';
  const budgetRows = [
    ['Full audio', graph.budgets?.budgets?.full_audio],
    ['Voice completion', graph.budgets?.budgets?.voice_completion],
    ['Name disposition', graph.budgets?.budgets?.name_disposition],
    ['People File projection', graph.budgets?.budgets?.people_file_projection],
  ];
  const stages = graph.stages
    .map((stage, index) => {
      const nodeClass =
        stage.status === 'complete'
          ? 'complete'
          : stage.status === 'awaiting_receipt'
            ? 'waiting'
            : stage.status === 'failed'
              ? 'failed'
              : 'pending';
      const evidence = escapeHtml(JSON.stringify(stage.evidence, null, 2));
      return `${index ? '<div class="arrow" aria-hidden="true">›</div>' : ''}
        <article class="stage ${nodeClass}">
          <div class="stage-top"><span class="stage-number">${index + 1}</span><span class="stage-status">${escapeHtml(statusFace(stage.status))}</span></div>
          <h2>${escapeHtml(stage.title)}</h2>
          <p class="caption">${escapeHtml(stage.caption)}</p>
          <p class="summary">${escapeHtml(stage.summary)}</p>
          <dl>
            <div><dt>Receipt time</dt><dd>${escapeHtml(faceTime(stage.produced_at))}</dd></div>
            <div><dt>From landing</dt><dd>${escapeHtml(durationFace(stage.elapsed_ms))}</dd></div>
          </dl>
          <details>
            <summary>Exact receipt proof</summary>
            <p><strong>Receipt:</strong> <code>${escapeHtml(stage.receipt_id || 'not written yet')}</code></p>
            <p><strong>Hash:</strong> <code>${escapeHtml(stage.receipt_hash || 'not written yet')}</code></p>
            <pre>${evidence}</pre>
          </details>
        </article>`;
    })
    .join('');
  const controlPath = graph.control_path
    .map((node, index) => {
      const nodeClass =
        node.status === 'complete' || node.status === 'not_required'
          ? 'complete'
          : node.status === 'failed'
            ? 'failed'
            : node.status === 'active'
              ? 'active'
              : 'pending';
      return `${index ? '<div class="control-arrow" aria-hidden="true">›</div>' : ''}
        <article class="control-node ${nodeClass}">
          <div class="stage-top"><span class="stage-number">${index + 1}</span><span class="stage-status">${escapeHtml(statusFace(node.status))}</span></div>
          <h3>${escapeHtml(node.title)}</h3>
          <p class="caption">${escapeHtml(node.caption)}</p>
          <p class="summary">${escapeHtml(node.summary)}</p>
          <p class="control-time">${escapeHtml(faceTime(node.at))}</p>
          <details>
            <summary>Control proof</summary>
            <pre>${escapeHtml(JSON.stringify(node.evidence, null, 2))}</pre>
          </details>
        </article>`;
    })
    .join('');
  const timeline = graph.timeline
    .map(
      (row) => `<li>
        <time>${escapeHtml(faceTime(row.at))}</time>
        <span class="timeline-dot ${escapeHtml(row.kind)}"></span>
        <span>${escapeHtml(row.label)}</span>
      </li>`,
    )
    .join('');
  const attempts = (graph.healer?.attempt_history || [])
    .map(
      (row, index) => `<tr>
        <td>${index + 1}</td>
        <td>${escapeHtml(row.tactic)}</td>
        <td>${escapeHtml(row.hypothesis)}</td>
        <td>${escapeHtml(row.action)}</td>
        <td>${escapeHtml(row.result)}</td>
        <td>${escapeHtml(row.liveOutcome)}</td>
        <td>${escapeHtml(row.whyNotClosed || 'closed')}</td>
      </tr>`,
    )
    .join('');
  const speakerCards = (graph.speaker_attribution?.tracks || [])
    .map((track) => {
      const currentProjection = track.current_projection || null;
      const nameHypothesis =
        currentProjection?.provisional_name_hypothesis || null;
      const acousticCallCount = Number(
        currentProjection?.person_call_count ??
          currentProjection?.acoustic_call_count ??
          0,
      );
      const projectionConfirmed =
        currentProjection?.official_identity_status === 'confirmed';
      const currentProjectionFace = currentProjection
        ? `<div class="current-projection">
            ${
              nameHypothesis
                ? `<p><strong>Maybe ${escapeHtml(nameHypothesis.display_name)}</strong></p>`
                : ''
            }
            <p>${
              projectionConfirmed
                ? `Confirmed person history: ${acousticCallCount} ${acousticCallCount === 1 ? 'call' : 'calls'}.`
                : `Same voice in ${acousticCallCount} ${acousticCallCount === 1 ? 'call' : 'calls'}.`
            }</p>
            ${
              projectionConfirmed
                ? ''
                : '<p class="official-unknown">Official identity remains Unknown until confirmation.</p>'
            }
          </div>`
        : '';
      const candidates = (track.ranked_candidates || [])
        .map(
          (candidate) => `<li>
            #${Number(candidate.rank)} ${escapeHtml(candidate.display_name || candidate.candidate_person_id)}
            · score ${escapeHtml(candidate.score)}
            · margin ${escapeHtml(candidate.margin)}
            · evidence <code>${escapeHtml(String(candidate.evidence_hash || '').slice(0, 16))}…</code>
          </li>`,
        )
        .join('');
      return `<article class="speaker-card ${track.status === 'confirmed' ? 'confirmed' : 'unresolved'}">
        <div class="stage-top"><strong>Track ${escapeHtml(track.speaker_model_label)}</strong><span class="stage-status">${escapeHtml(statusFace(track.status))}</span></div>
        <h3>${escapeHtml(track.display_name)}</h3>
        <p>${escapeHtml(track.identity_tier || 'no confirmed identity tier')}</p>
        <p>${track.confidence === null ? 'Confidence not measured' : `Confidence ${escapeHtml(track.confidence)}`}</p>
        ${currentProjectionFace}
        ${track.uncertainty_reason ? `<p class="uncertainty">${escapeHtml(track.uncertainty_reason)}</p>` : ''}
        <details>
          <summary>Exact identity and candidate evidence</summary>
          ${candidates ? `<ol>${candidates}</ol>` : '<p>No ranked candidate evidence.</p>'}
          <pre>${escapeHtml(JSON.stringify({
            canonical_speaker_id: track.canonical_speaker_id,
            unknown_speaker_id: track.unknown_speaker_id,
            current_projection: track.current_projection,
            evidence: track.evidence,
          }, null, 2))}</pre>
        </details>
      </article>`;
    })
    .join('');
  const attributedSegments = (graph.speaker_attribution?.segments || [])
    .map(
      (segment) => `<tr>
        <td>${escapeHtml(
          segment.start_seconds === null || segment.end_seconds === null
            ? 'not timed'
            : `${segment.start_seconds.toFixed(2)}s to ${segment.end_seconds.toFixed(2)}s`,
        )}</td>
        <td>Track ${escapeHtml(segment.speaker_model_label || '?')}</td>
        <td><strong>${escapeHtml(segment.display_name)}</strong><br><small>${escapeHtml(statusFace(segment.attribution_source))}</small></td>
        <td>${segment.short_segment ? '<strong>SHORT</strong>' : 'standard'}<br><small>${Number(segment.word_count || 0)} words</small></td>
        <td>${escapeHtml(segment.text)}</td>
        <td>${escapeHtml(segment.uncertainty_reason || 'Confirmed or inherited from the exact diarization track.')}</td>
      </tr>`,
    )
    .join('');
  const recent = graph.recent_calls
    .map(
      (row) => `<a class="call-link ${row.otid === call.otid ? 'active' : ''}" href="/life-archive/otter-call-graph?otid=${encodeURIComponent(row.otid)}">
        <span>${escapeHtml(row.title || row.otid)}</span>
        <small>${escapeHtml(faceTime(row.landed_at))} · ${escapeHtml(statusFace(row.status))}</small>
      </a>`,
    )
    .join('');
  const budgets = budgetRows
    .map(
      ([name, row]) => `<div class="budget">
        <strong>${escapeHtml(name)}</strong>
        <span>${escapeHtml(budgetFace(row?.budget_minutes))}</span>
        <small>3σ from ${Number(row?.sample_count || 0)} successful sample${Number(row?.sample_count || 0) === 1 ? '' : 's'}</small>
      </div>`,
    )
    .join('');
  const eventClocks = [
    ['Queue', graph.event_clocks?.queue],
    ['Cold start', graph.event_clocks?.cold_start],
    ['Execution', graph.event_clocks?.execution],
    ['Handoff', graph.event_clocks?.handoff],
    ['Closure', graph.event_clocks?.closure],
  ]
    .map(
      ([name, row]) => `<div class="budget">
        <strong>${escapeHtml(name)}</strong>
        <span>${escapeHtml(durationFace(row?.duration_ms))}</span>
        <small>${escapeHtml(faceTime(row?.start_at))} to ${escapeHtml(faceTime(row?.end_at))}</small>
      </div>`,
    )
    .join('');
  const missing = graph.receipt_closure.missing_stages.length
    ? graph.receipt_closure.missing_stages.join(', ')
    : 'none';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="refresh" content="15">
  <title>Otter per-call processor · ${escapeHtml(call.title)}</title>
  <style>
    :root{--ink:#24221f;--muted:#706b64;--paper:#f7f2e9;--card:#fffdf8;--line:#d9d0c2;--green:#2f7850;--green-bg:#e7f3e8;--red:#a53f31;--red-bg:#f9e8e3;--amber:#8b641d;--amber-bg:#fff2cf;--blue:#386a80;--shadow:0 16px 40px rgba(57,45,28,.1)}
    *{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}main{max-width:1500px;margin:auto;padding:24px}header{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:24px;align-items:start;margin-bottom:18px}.eyebrow{font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}h1{margin:5px 0 7px;font-size:clamp(25px,3vw,42px);line-height:1.06}h2{font-size:18px;margin:12px 0 4px}h3{font-size:16px;margin:11px 0 4px}.mono,code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere}.status{padding:11px 15px;border-radius:999px;font-weight:850;letter-spacing:.04em;font-size:13px}.status.good{background:var(--green-bg);color:var(--green)}.status.warn{background:var(--amber-bg);color:var(--amber)}.status.bad{background:var(--red-bg);color:var(--red)}.meta{display:flex;flex-wrap:wrap;gap:8px;margin-top:13px}.pill{border:1px solid var(--line);background:var(--card);border-radius:999px;padding:6px 10px;color:var(--muted)}.pause{border:1px solid ${graph.historical_backfill.paused ? '#cf9d3e' : '#d57c70'};background:${graph.historical_backfill.paused ? 'var(--amber-bg)' : 'var(--red-bg)'};padding:10px 14px;border-radius:10px;margin:14px 0 20px;font-weight:700}.grid-wrap{overflow-x:auto;padding:10px 2px 18px}.graph,.control-graph{display:flex;align-items:stretch;min-width:1320px}.arrow,.control-arrow{display:flex;align-items:center;justify-content:center;font-size:32px;color:#9b8e7b;width:25px}.stage,.control-node{width:165px;min-width:165px;border:1px solid var(--line);border-top:5px solid #a49c91;background:var(--card);border-radius:12px;padding:12px;box-shadow:0 5px 16px rgba(57,45,28,.05)}.stage.complete,.control-node.complete{border-top-color:var(--green)}.stage.waiting,.stage.pending,.control-node.pending,.control-node.active{border-top-color:#d19a34}.stage.failed,.control-node.failed{border-top-color:var(--red)}.control-node.active{background:var(--amber-bg)}.stage-top{display:flex;align-items:center;justify-content:space-between;gap:6px}.stage-number{width:25px;height:25px;border-radius:50%;display:grid;place-items:center;background:#ece5da;font-weight:800}.stage-status{font-size:10px;text-transform:uppercase;letter-spacing:.05em;font-weight:800;color:var(--muted)}.caption{min-height:58px;color:var(--muted);font-size:12px}.summary{min-height:68px;font-size:13px;font-weight:650}.control-time{color:var(--muted);font-size:11px}.stage dl{margin:10px 0}.stage dl div{display:flex;justify-content:space-between;gap:7px;border-top:1px solid #ece5da;padding:5px 0}.stage dt{font-size:11px;color:var(--muted)}.stage dd{font-size:11px;text-align:right;margin:0;font-weight:700}.stage details,.control-node details{border-top:1px solid #ece5da;padding-top:8px}.stage details summary,.control-node details summary{cursor:pointer;font-size:12px;font-weight:750}.stage pre,.control-node pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:10px;background:#f3eee5;padding:8px;border-radius:6px;max-height:250px;overflow:auto}.budget-row{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:10px;margin:6px 0 22px}.budget{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:11px}.budget strong,.budget span,.budget small{display:block}.budget span{font-size:20px;font-weight:850;margin:4px 0}.budget small{color:var(--muted)}.budget.slo{border-color:#d7a55b}.two-col{display:grid;grid-template-columns:minmax(0,2fr) minmax(280px,1fr);gap:18px}.panel{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:17px;box-shadow:var(--shadow)}.panel h2{margin-top:0}.timeline{list-style:none;padding:0;margin:0}.timeline li{display:grid;grid-template-columns:160px 12px 1fr;align-items:center;gap:9px;padding:8px 0;border-bottom:1px solid #eee7dd}.timeline time{font-size:12px;color:var(--muted)}.timeline-dot{width:9px;height:9px;border-radius:50%;background:var(--green)}.timeline-dot.healer,.timeline-dot.dispatch,.timeline-dot.handoff{background:var(--blue)}.timeline-dot.landing,.timeline-dot.envelope{background:var(--amber)}.timeline-dot.blocked{background:var(--red)}.call-list{display:grid;gap:7px}.call-link{display:flex;flex-direction:column;text-decoration:none;color:var(--ink);border:1px solid var(--line);border-radius:9px;padding:9px;background:#fff}.call-link.active{border-color:var(--green);background:var(--green-bg)}.call-link small{color:var(--muted)}.proof{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-bottom:18px}.proof div{background:var(--card);border:1px solid var(--line);padding:11px;border-radius:10px}.proof strong,.proof span{display:block}.proof span{font-size:18px;font-weight:850;margin-top:4px}.speaker-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px}.speaker-card{background:var(--card);border:1px solid var(--line);border-top:5px solid var(--amber);border-radius:12px;padding:12px}.speaker-card.confirmed{border-top-color:var(--green)}.speaker-card .current-projection{margin:10px 0;padding:9px;border-radius:8px;background:var(--amber-bg);border:1px solid #cf9d3e}.speaker-card .current-projection p{margin:2px 0}.speaker-card .current-projection strong{font-size:17px}.speaker-card .official-unknown{color:var(--muted);font-size:12px}.speaker-card .uncertainty{color:var(--red);font-weight:700}.attempts{width:100%;border-collapse:collapse;font-size:12px}.attempts th,.attempts td{text-align:left;vertical-align:top;padding:8px;border-bottom:1px solid #eee7dd}.attempts th{position:sticky;top:0;background:var(--card)}.table-wrap{overflow:auto;max-height:420px}.actions{display:flex;gap:8px;margin-top:12px}.actions a{display:inline-block;border:1px solid var(--line);border-radius:8px;padding:7px 10px;text-decoration:none;color:var(--ink);background:var(--card);font-weight:700}@media(max-width:900px){main{padding:14px}header{grid-template-columns:1fr}.budget-row{grid-template-columns:repeat(2,1fr)}.two-col{grid-template-columns:1fr}.proof{grid-template-columns:repeat(2,1fr)}}
  </style>
</head>
<body>
<main>
  <header>
    <div>
      <div class="eyebrow">Live exact-call receipt graph · refreshes every 15 seconds</div>
      <h1>${escapeHtml(call.title)}</h1>
      <div class="mono">${escapeHtml(call.otid)}</div>
      <div class="meta">
        <span class="pill">Landed ${escapeHtml(faceTime(call.landed_at))}</span>
        <span class="pill">Exact SHA ${escapeHtml(call.source_revision_hash.slice(0, 16))}…</span>
        <span class="pill">${graph.receipt_closure.receipt_count}/${graph.receipt_closure.expected_receipt_count} current receipts</span>
        <span class="pill">${call.identity_relevant_tracks} identity-relevant track${call.identity_relevant_tracks === 1 ? '' : 's'}</span>
      </div>
      <div class="actions"><a href="">Refresh now</a><a href="/life-archive/otter-call-graph?otid=${encodeURIComponent(call.otid)}&format=json">Raw graph JSON</a></div>
    </div>
    <div class="status ${statusClass}">${escapeHtml(statusText)}</div>
  </header>
  <div class="pause">${graph.historical_backfill.paused ? 'Historical backfill is PAUSED. Only new-call processing may run while ExampleCo inspects this graph.' : 'Historical backfill is NOT paused.'}</div>
  <section class="proof">
    <div><strong>Exact revision</strong><span>${graph.exact_current_revision ? 'PROVED' : 'NOT PROVED'}</span></div>
    <div><strong>Exact envelope</strong><span>${graph.exact_completion_envelope.verified ? 'VERIFIED' : graph.exact_completion_envelope.required ? 'MISSING' : 'PRE-CUTOVER'}</span></div>
    <div><strong>Closure manifest</strong><span>${graph.closed_with_proof ? 'CLOSED' : 'OPEN'}</span></div>
    <div><strong>Wall time</strong><span>${escapeHtml(durationFace(graph.sla.wall_ms))}</span></div>
    <div><strong>Missing receipts</strong><span>${escapeHtml(missing)}</span></div>
    <div><strong>Repair cycles</strong><span>${Number(graph.healer?.cycle_summary?.cycles_consumed || 0)}/8</span></div>
    <div><strong>No-progress streak</strong><span>${Number(graph.healer?.cycle_summary?.consecutive_no_progress || 0)}/3</span></div>
    <div><strong>Agent attempts</strong><span>${Number(graph.healer?.cycle_summary?.agentic_attempts || 0)}</span></div>
    <div><strong>Architecture</strong><span>${escapeHtml(statusFace(graph.architecture_provenance?.status))}</span></div>
  </section>
  <details class="panel" style="margin-bottom:18px">
    <summary><strong>Producer, consumer, schema, and Otter core provenance</strong></summary>
    <pre>${escapeHtml(JSON.stringify(graph.architecture_provenance, null, 2))}</pre>
  </details>
  <h2>Separate event clocks</h2>
  <section class="budget-row">${eventClocks}</section>
  <h2>Exact-call control path</h2>
  <div class="grid-wrap"><section class="control-graph" aria-label="Otter exact-call control path">${controlPath}</section></div>
  <h2>Artifact receipt path</h2>
  <div class="grid-wrap"><section class="graph" aria-label="Otter exact-call processing stages">${stages}</section></div>
  <h2>Current learned 3σ budgets</h2>
  <section class="budget-row">
    ${budgets}
    <div class="budget slo"><strong>Exact receipt closure</strong><span>45m</span><small>Failure deadline, not a delay</small></div>
    <div class="budget slo"><strong>Overall live SLO</strong><span>60m / 120m</span><small>Red after 1 hour, critical after 2</small></div>
  </section>
  <section class="two-col">
    <div class="panel">
      <h2>Play by play</h2>
      <ol class="timeline">${timeline || '<li>No timestamped events yet.</li>'}</ol>
    </div>
    <aside class="panel">
      <h2>Recent calls</h2>
      <div class="call-list">${recent}</div>
    </aside>
  </section>
  <section class="panel" style="margin-top:18px">
    <h2>Per-speaker attribution</h2>
    <p>Identity is read only from the verified immutable exact-call bundle. Short turns inherit a person only when their diarization label belongs to a confirmed acoustic track. Unconfirmed candidates stay uncertain.</p>
    <div class="speaker-grid">${speakerCards || '<p>No exact speaker tracks are available.</p>'}</div>
    <h3>Every diarized segment, including short turns</h3>
    <div class="table-wrap">
      <table class="attempts">
        <thead><tr><th>Time</th><th>Track</th><th>Attribution</th><th>Length</th><th>Words</th><th>Why certain or uncertain</th></tr></thead>
        <tbody>${attributedSegments || '<tr><td colspan="6">No diarized segments are available.</td></tr>'}</tbody>
      </table>
    </div>
  </section>
  <section class="panel" style="margin-top:18px">
    <h2>Bounded repair history passed to the agent</h2>
    <p>${attempts ? 'These are the same six prompt-safe fields used by overnight card agents. Capacity deferrals are visible but do not consume a cycle.' : 'No repair attempt has been required for this exact revision.'}</p>
    <div class="table-wrap">
      <table class="attempts">
        <thead><tr><th>#</th><th>Tactic</th><th>Hypothesis</th><th>Action</th><th>Result</th><th>Live outcome</th><th>Why not closed</th></tr></thead>
        <tbody>${attempts || '<tr><td colspan="7">No attempts recorded.</td></tr>'}</tbody>
      </table>
    </div>
  </section>
</main>
</body>
</html>`;
}

module.exports = {
  HISTORICAL_PAUSE_BASENAME,
  STAGE_VIEW,
  architectureStatus,
  buildEventClocks,
  buildOtterCallGraph,
  buildSpeakerAttribution,
  currentSpeakerProjection,
  renderOtterCallGraphHtml,
  receiptSummary,
};
