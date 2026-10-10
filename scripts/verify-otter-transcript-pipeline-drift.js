#!/usr/bin/env node
/**
 * Drift-lint for the Otter Transcript Pipeline core component.
 *
 * Keeps dev-plans/core/otter-transcript-pipeline.md equal to the code: every
 * load-bearing entry point the doc names must still exist, and the design
 * invariants the doc asserts (the gates and remote raw archive before processing) must still
 * hold. If the code moves and the doc does not, this fails loud so the doc gets
 * fixed instead of rotting into fiction.
 *
 * Scoped per review: stage entrypoints, env gates, and exact-revision proof
 * invariants -- NOT every generated voiceprint artifact.
 *
 * Zero deps (fs/path only) so it works in a fresh worktree.
 *   node scripts/verify-otter-transcript-pipeline-drift.js
 * Exit 0 = in sync, 1 = drift. Importable as { checkDrift } for tests.
 */

const fs = require('fs');
const path = require('path');

const DOC = 'dev-plans/core/otter-transcript-pipeline.md';
const LESSONS = 'dev-plans/core/otter-transcript-pipeline.LESSONS.md';

// Stage entry points the doc names. Each must exist (these are git-tracked).
const STAGE_FILES = [
  'scripts/otter-ingest-watch.js',
  'scripts/lib/voice-fargate-trigger.js',
  'scripts/otter-full-audio-backfill.js',
  'scripts/otter-post-ingest-voice-intelligence.js',
  'scripts/otter-call-processing-ledger.js',
  'scripts/lib/otter-call-processing-ledger.js',
  'scripts/lib/otter-call-closure-settlement.js',
  'scripts/otter-call-processing-stage-budgets.js',
  'scripts/lib/otter-stage-budgets.js',
  'scripts/otter-call-processing-healer.js',
  'scripts/otter-call-agentic-healer.js',
  'scripts/otter-call-processing-healer-dispatch.js',
  'scripts/activate-otter-exact-call-cutover.js',
  'scripts/voice-efs-reconcile.js',
  'scripts/otter-call-stage-receipts.js',
  'scripts/lib/otter-call-closure-verifier.js',
  'scripts/lib/otter-call-stage-receipt-store.js',
  'scripts/lib/otter-call-processing-graph.js',
  'scripts/lib/otter-call-processing-cycles.js',
  'scripts/reopen-otter-exact-closure-generation.js',
  'scripts/lib/otter-call-event-queue.js',
  'scripts/lib/healer-attempt-history.js',
  'scripts/lib/otter-architecture-provenance.js',
  'scripts/lib/otter-exact-call-envelope.js',
  'scripts/lib/otter-exact-call-envelope-producer.js',
  'scripts/otter-exact-call-envelope-correction.js',
  'scripts/lib/voice-reference-provenance.js',
  'scripts/migrate-legacy-voice-reference-provenance.js',
  'scripts/lib/otter-exact-call-people-projection.js',
  'scripts/otter-exact-call-people-projection.js',
  'scripts/lib/otter-exact-call-aggregate-reconcile.js',
  'scripts/lib/otter-raw-archive-receipt.js',
  'scripts/lib/otter-call-healer-handoff.js',
  'scripts/otter-call-name-disposition.js',
  'scripts/voice-incremental-recluster.js',
  'scripts/lib/voice-incremental-recluster.js',
  'scripts/lib/voice-current-cluster-membership.js',
  'scripts/lib/otter-probe-index-merge.js',
  'scripts/voice-name-conflict-audit.js',
  'scripts/lib/voice-name-conflicts.js',
  'scripts/lib/voice-sandbox-candidate-merge.js',
  'scripts/voice-promote-sandbox-reference-matches.js',
  'scripts/ec2-otter-call-healer-run.sh',
  'scripts/ec2-otter-lane-scope-run.sh',
  'scripts/ec2-global-identity-cap-run.sh',
  'scripts/ec2-otter-healer-pause-recovery-run.sh',
  'scripts/install-ec2-otter-call-healer-cron.sh',
  'config/otter-release-compatibility.json',
  'scripts/lib/otter-release-compatibility.js',
  'scripts/otter-diarized-segment-backfill.js',
  'scripts/otter-track-probe-builder.js',
  'scripts/otter-wavlm-speaker-resolver.js',
  'scripts/otter-speaker-pareto-report.js',
  'scripts/voice-sample-sequence-review-html.js',
  'scripts/voice-confirmation-queue-build.js',
  'scripts/voice-confirmation-backprop.js',
  'scripts/lib/canonical-speaker-identity.js',
  'scripts/lib/voice-sequence-lineage.js',
  'scripts/voice-global-recluster.js',
  'scripts/apply-voice-cluster-resolutions.js',
  'scripts/speaker-identity-change-hook.js',
  'scripts/sync-voiceprints-to-people-files.js',
  'scripts/sync-otter-speaker-intelligence-to-people-files.js',
  'scripts/voice-people-file-projection-audit.js',
  'scripts/voice-people-file-target-repair.js',
  'scripts/lib/voice-people-projection-events.js',
  'scripts/install-ec2-voice-recluster-cron.sh',
  'scripts/otter-life-relevance-enricher.js',
  'deploy/voice-fargate/Dockerfile',
  'deploy/voice-fargate/otter-producer-contract.json',
  'deploy/voice-fargate/taskdef.json',
];

// Runtime artifacts: present on a live box, gitignored in the repo -> warn, never fail.
const RUNTIME_FILES = [
  ['data/life-archive/voice-identity-registry.json', '64 enrolled voiceprints'],
];

const FARGATE_VOICE_STANDARD_ENV = Object.freeze({
  VOICE_FARGATE_ACOUSTIC_ONLY: '1',
  OTTER_FARGATE_ACOUSTIC_VOICE_TIMEOUT_FLOOR_MS: '1800000',
  VOICE_SPEAKER_BACKEND: 'ecapa',
  SPEAKER_MATCH_SCORE: '0.56',
  SPEAKER_MATCH_MARGIN: '0.06',
});

// [file, token, why] -- the token must be present (an invariant the doc relies on).
const MUST_CONTAIN = [
  [
    'scripts/lib/otter-exact-call-envelope.js',
    'producerTimebaseCorrectionProof',
    'same-revision producer corrections require mechanical raw-alignment proof',
  ],
  [
    'scripts/otter-exact-call-envelope-correction.js',
    'PRODUCER_TIMEBASE_DEFECT',
    'the dedicated producer-defect correction path cannot impersonate owner correction',
  ],
  [
    'scripts/lib/otter-exact-call-envelope-producer.js',
    'correctionReasonCode',
    'the exact producer retains a separate immutable correction candidate path',
  ],
  [
    'scripts/otter-ingest-watch.js',
    'archiveOtterRawRevision',
    'ingest durably archives the exact raw revision before queueing downstream work',
  ],
  [
    'scripts/lib/otter-raw-archive-receipt.js',
    'uploadFn(localPath',
    'raw archival uploads and verifies the exact local revision before issuing its immutable receipt',
  ],
  [
    'scripts/lib/cloud-archive.js',
    'ChecksumSHA256',
    'exact raw archival can require S3-returned SHA-256 checksum proof',
  ],
  [
    'scripts/lib/otter-architecture-provenance.js',
    'core_document_sha256: sha256CoreDocument(coreFile, fsApi)',
    'architecture provenance is wired through canonical cross-checkout core-document hashing',
  ],
  [
    'scripts/lib/voice-fargate-trigger.js',
    'VOICE_FARGATE_ENABLED',
    'fargate path is gated default-off',
  ],
  [
    'scripts/lib/voice-fargate-trigger.js',
    'materializeOtterRawRevision',
    'Fargate stages the exact archived revision rather than whichever mutable raw file is newest',
  ],
  ['scripts/otter-full-audio-backfill.js', "'--write'", 'audio download is gated behind --write'],
  [
    'scripts/otter-full-audio-backfill.js',
    'process.env.SECONDBRAIN_DATA_DIR',
    'backfill resolves audio/raw/enriched from SECONDBRAIN_DATA_DIR (the same dir the coverage report counts), not a bare REPO join -- the 2026-07-01 path split',
  ],
  [
    'scripts/otter-post-ingest-voice-intelligence.js',
    'full_audio',
    'orchestrator runs the full_audio step',
  ],
  [
    'scripts/otter-post-ingest-voice-intelligence.js',
    'diarized',
    'orchestrator runs the diarized step',
  ],
  [
    'scripts/otter-post-ingest-voice-intelligence.js',
    'mergeProbeIndexes',
    'scoped probe output is atomically merged into the durable global index',
  ],
  [
    'scripts/otter-post-ingest-voice-intelligence.js',
    'otter-call-name-disposition.js',
    'selected calls receive complete-call marked-target name disposition',
  ],
  [
    'scripts/otter-post-ingest-voice-intelligence.js',
    'voice-incremental-recluster.js',
    'new call embeddings join durable clusters through the selected-call path',
  ],
  [
    'scripts/voice-incremental-recluster.js',
    '--otids is required; incremental recluster never runs globally',
    'incremental identity assignment cannot degrade into an untargeted corpus run',
  ],
  [
    'scripts/voice-incremental-recluster.js',
    'tryAcquireReclusterPublishLock',
    'incremental publication serializes on the shared recluster artifact lock',
  ],
  [
    'scripts/voice-global-recluster.js',
    'withReclusterPublishLock',
    'the full recluster publishes through the same artifact lock as incrementals',
  ],
  [
    'scripts/voice-incremental-recluster.js',
    'artifactClusterIds.has(currentTarget)',
    'prior unknown membership is pruned only on affirmative contradiction, never on projection lag',
  ],
  [
    'scripts/lib/voice-incremental-recluster.js',
    'sameCallGate',
    'incremental identity assignment preserves the strict same-call different-label gate',
  ],
  [
    'scripts/voice-confirmation-queue-build.js',
    'cluster_membership_contaminated',
    'a stale or mixed acoustic cluster cannot surface one contextual name',
  ],
  [
    'scripts/voice-confirmation-queue-build.js',
    'reviewable_voice_queue',
    'the human review surface is fed only by an explicit playable and exact-membership queue',
  ],
  [
    'scripts/lib/voice-name-judge-coverage.js',
    'exact_call_marked_target_membership.v1',
    'call-local name evidence is fingerprinted to exact revision and track coordinates',
  ],
  [
    'scripts/otter-call-processing-healer.js',
    "if (call?.otid) args.push('--otid'",
    'exact-call name healing cannot fall back to a contaminated archive-wide target',
  ],
  [
    'scripts/otter-call-stage-receipts.js',
    'fingerprintExactCallTarget',
    'closure accepts a current exact-call naming fingerprint for orphan aggregate identities',
  ],
  [
    'scripts/otter-call-processing-healer-dispatch.js',
    'PARALLEL_SAFE_EXACT_STAGES',
    'only isolated exact-call tails bypass the host-global heavy-worker fence',
  ],
  [
    'scripts/otter-call-processing-healer-dispatch.js',
    '--attended-exact requires an explicit --exact-otids scope',
    'attended critical host priority cannot escape an exact call scope',
  ],
  [
    'scripts/otter-call-processing-healer-dispatch.js',
    'attended_wait_ms',
    'an exact attended run waits for the bounded critical slot instead of draining as deferred',
  ],
  [
    'scripts/otter-call-processing-healer-dispatch.js',
    'targetResourceFencePaths',
    'only heavy stages take a kernel fence; People projection children overlap freely',
  ],
  [
    'scripts/lib/people-learning-stage.js',
    'withPersonStageLock',
    'the People staging write serializes per person for milliseconds, not per projection child',
  ],
  [
    'scripts/lib/host-work-admission.js',
    'minimumWeight',
    'half-weight exact-call tails preserve one-slot hosts and the critical reserve',
  ],
  [
    'scripts/otter-call-processing-healer.js',
    'withSharedRefreshLock',
    'parallel exact-call tails serialize shared conflict and ledger publication',
  ],
  [
    'scripts/lib/voice-fargate-trigger.js',
    "VOICE_FARGATE_MAX_ACTIVE_TASKS || '10'",
    'the independent acoustic lane admits ten exact calls by default',
  ],
  [
    'scripts/lib/voice-incremental-recluster.js',
    'confirmed_person_id',
    'incremental membership carries confirmed person metadata into writeback',
  ],
  [
    'scripts/voice-incremental-recluster.js',
    'assignmentPersonId',
    'incremental writeback recognizes canonical person-prefixed cluster membership',
  ],
  [
    'scripts/voice-incremental-recluster.js',
    'incremental_confirmed_cluster_membership',
    'incremental person-cluster membership remains a confirmed identity',
  ],
  [
    'scripts/voice-incremental-recluster.js',
    'applyCanonicalSpeakerIdentity(identity, personId',
    'incremental confirmed membership uses the canonical person identity writer',
  ],
  [
    'scripts/speaker-identity-change-hook.js',
    'prepareCurrentEdges',
    'identity change writes normalize the archive before measuring projection edges',
  ],
  [
    'scripts/speaker-identity-change-hook.js',
    'scripts/otter-speaker-identity-completeness.js',
    'identity change writes repair orphan and person-prefixed speaker identities first',
  ],
  [
    'scripts/speaker-identity-change-hook.js',
    'normalizationResult && !normalizationResult.ok',
    'failed identity normalization prevents projection edge collection and state advancement',
  ],
  [
    'scripts/speaker-identity-change-hook.js',
    'normalized-upstream',
    'the completeness producer cannot repeat its archive-wide normalization inside the edge hook',
  ],
  [
    'scripts/otter-post-ingest-voice-intelligence.js',
    "SPEAKER_RESOLVER_SANDBOX: '1'",
    'strict reference matches remain sandbox candidates until the marked-call conflict gate clears them',
  ],
  [
    'scripts/lib/voice-sandbox-candidate-merge.js',
    'candidateKey',
    'sandbox reference candidates persist across exact-call runs',
  ],
  [
    'scripts/voice-promote-sandbox-reference-matches.js',
    'blocked_observation_keys',
    'sandbox reference promotion fails closed on marked-call name conflicts',
  ],
  [
    'scripts/voice-promote-sandbox-reference-matches.js',
    'recordDurableResolution',
    'cleared reference matches promote the whole durable acoustic cluster to one canonical person',
  ],
  [
    'scripts/otter-post-ingest-voice-intelligence.js',
    'identity_change_projection',
    'the exact-call graph closes membership changes through one terminal People File impact hook',
  ],
  [
    'scripts/otter-post-ingest-voice-intelligence.js',
    'identityProjectionArgs',
    'one exact call routes People projection by OTID and pinned SHA instead of invoking the archive-wide hook',
  ],
  [
    'scripts/otter-post-ingest-voice-intelligence.js',
    'maxWaitMs',
    'stage contention waits without spending a healer tactic',
  ],
  [
    'scripts/lib/otter-call-processing-ledger.js',
    'verifyStoredOtterCallClosure',
    'per-call orchestration verifies the terminal exact-revision receipt graph',
  ],
  [
    'scripts/lib/otter-call-processing-ledger.js',
    'exactNameDispositionKey',
    'exact-call naming proof is indexed by target, call, and raw revision before mutable cluster state',
  ],
  [
    'scripts/lib/otter-call-processing-ledger.js',
    'projectedPersonConfirmed',
    'the ledger cannot promote an unconfirmed contextual person over an exact durable unknown',
  ],
  [
    'scripts/otter-call-stage-receipts.js',
    'projectedPersonConfirmed',
    'exact receipts apply the same confirmed-person gate as the ledger',
  ],
  [
    'scripts/lib/otter-stage-budgets.js',
    'mean + 3 * stddev',
    'per-call stage clocks are calculated from historical successful durations',
  ],
  [
    'scripts/lib/otter-stage-budgets.js',
    'execution_timing_sample_count',
    'new exact-call runs retain measured execution timing receipts as non-calibrating evidence',
  ],
  [
    'scripts/lib/otter-stage-budgets.js',
    'bootstrap_independent_sla_ceiling',
    'fresh honest zero-sample calibration can collect its first timing receipt without becoming green',
  ],
  [
    'scripts/otter-post-ingest-voice-intelligence.js',
    'refresh_call_processing_ledger_after_timing',
    'the exact producer recalculates measured clocks and ledger truth immediately after timing publication',
  ],
  [
    'scripts/lib/otter-call-processing-ledger.js',
    'deadline_breaches_last_24h',
    'per-call health separates recent 24-hour deadline failures',
  ],
  [
    'scripts/lib/otter-call-processing-ledger.js',
    'historical_incomplete_calls',
    'historical calls without terminal receipts keep the measurement red',
  ],
  [
    'scripts/otter-call-processing-healer.js',
    'targetFingerprint',
    'exact-call healer no-repeat identity includes the failed stage input fingerprint',
  ],
  [
    'scripts/otter-call-processing-healer.js',
    'unchanged_input_exhausted',
    'three unchanged-input attempts exhaust visibly instead of spinning',
  ],
  [
    'scripts/otter-call-processing-healer.js',
    'stale_job_reclaimed',
    'crashed durable healer jobs can be reclaimed',
  ],
  [
    'scripts/otter-post-ingest-voice-intelligence.js',
    'exact_revision_receipts',
    'the exact producer builds same-revision stage receipts before ledger QC',
  ],
  [
    'scripts/lib/otter-call-healer-handoff.js',
    'exact_call_post_publish_live_qc_red',
    'red post-publication exact-call QC emits a durable healer handoff',
  ],
  [
    'scripts/otter-call-processing-healer-dispatch.js',
    'loadHandoffTargets',
    'the dispatcher consumes current-revision post-QC repair handoffs',
  ],
  [
    'scripts/otter-call-processing-healer-dispatch.js',
    'terminalCycleStateForTarget',
    'terminal handoffs settle instead of redispatching forever',
  ],
  [
    'scripts/otter-call-processing-healer-dispatch.js',
    'cycleStateFn(target, call)',
    'terminal filtering also covers ordinary ledger targets',
  ],
  [
    'scripts/otter-call-processing-healer.js',
    'publishHealerHandoff',
    'stage handoff continues immediately after a healer advances the exact call',
  ],
  [
    'scripts/otter-call-processing-healer.js',
    'build_exact_revision_receipts',
    'same-revision closure is a first-class exact-stage repair tactic',
  ],
  [
    'scripts/otter-call-stage-receipts.js',
    'verifyStoredOtterCallClosure',
    'the stage receipt producer verifies the immutable stored manifest before closure',
  ],
  [
    'scripts/otter-call-stage-receipts.js',
    'lacks exact source revision proof',
    'downstream identity evidence must name the exact source revision; mtimes are not closure proof',
  ],
  [
    'scripts/otter-call-stage-receipts.js',
    'exactEvidenceRevisions',
    'global revision sets cannot satisfy an unrelated exact-call closure',
  ],
  [
    'scripts/otter-call-stage-receipts.js',
    'closureEligibleTracks',
    'identity-grade probes cannot be hidden by the archive-substantive threshold',
  ],
  [
    'scripts/lib/otter-call-stage-receipt-store.js',
    'expectedIdentityGradeTrackIds',
    'stored closure reopens when a current identity-grade track is absent',
  ],
  [
    'scripts/lib/otter-call-processing-graph.js',
    'Live exact-call receipt graph',
    'the operator can inspect one current call from landing through all seven exact-revision receipts',
  ],
  [
    'scripts/lib/otter-call-processing-graph.js',
    'Historical backfill is PAUSED',
    'the visual proof states whether historical replay is fenced during live-call validation',
  ],
  [
    'scripts/lib/otter-call-processing-cycles.js',
    'const MAX_CYCLES = 8',
    'each exact call-stage repair generation has one eight-cycle budget',
  ],
  [
    'scripts/lib/otter-call-processing-cycles.js',
    'repair_generation_started',
    'a proof-gated exact-closure generation appends to immutable process history',
  ],
  [
    'scripts/lib/otter-call-processing-cycles.js',
    'priorImplementationFingerprints',
    'a closure generation requires a materially new implementation fingerprint',
  ],
  [
    'scripts/reopen-otter-exact-closure-generation.js',
    'only a currently selected exact_revision_closure target can be reopened',
    'operator reopen is restricted to selected exact-closure work',
  ],
  [
    'scripts/reopen-otter-exact-closure-generation.js',
    '--expected-generation-fingerprint',
    'operator write pins the previewed receipt-chain and implementation generation',
  ],
  [
    'scripts/reopen-otter-exact-closure-generation.js',
    'closed or closure-complete exact-call work cannot be reopened',
    'reopen can never clear or revive completed exact-call work',
  ],
  [
    'scripts/otter-call-processing-healer.js',
    'stageHandedBack',
    'a coarse voice stage cannot clear while that repair stage remains current',
  ],
  [
    'scripts/reopen-otter-voice-completion-generation.js',
    'only a currently open voice_completion target can be reopened',
    'operator reopen is restricted to an exact current voice target',
  ],
  [
    'scripts/reopen-otter-voice-completion-generation.js',
    'exactOpenStageProof',
    'a false coarse-stage clear requires exact current-ledger proof',
  ],
  [
    'scripts/reopen-otter-voice-completion-generation.js',
    '--expected-generation-fingerprint',
    'voice-generation write pins the previewed receipt chain and implementation',
  ],
  [
    'scripts/lib/otter-call-processing-cycles.js',
    'DEFERRED_CAPACITY',
    'ordinary shared-stage capacity waits do not consume or blacklist a healing attempt',
  ],
  [
    'scripts/otter-call-processing-healer-dispatch.js',
    'runBounded',
    'unrelated exact call-stage healers dispatch concurrently within a bound',
  ],
  [
    'scripts/otter-call-processing-healer-dispatch.js',
    'settleClaimedHandoff',
    'a claimed exact-call child settles durably before its host admission lease releases',
  ],
  [
    'scripts/otter-call-processing-healer-dispatch.js',
    'child_completed_nonterminal',
    'a nonterminal child cannot leave its durable handoff falsely claimed',
  ],
  [
    'scripts/lib/otter-call-healer-handoff.js',
    'expectedClaimOwner',
    'handoff settlement rechecks the exact claim owner inside the serialized transition',
  ],
  [
    'scripts/lib/otter-call-healer-handoff.js',
    'transition-lock',
    'handoff state transitions serialize through a per-handoff exclusive lock',
  ],
  [
    'scripts/ec2-otter-call-healer-run.sh',
    'otter-call-processing-healer-dispatch.js',
    'the scheduled runner uses the bounded exact-process dispatcher',
  ],
  [
    'scripts/ec2-otter-call-healer-run.sh',
    'readlink -f "$ROOT_LINK"',
    'an active worker remains pinned to one immutable release across a symlink swap',
  ],
  [
    'scripts/lib/otter-release-compatibility.js',
    'buildOtterReleaseCompatibility',
    'deploy compatibility is derived from selected shared-state semantics',
  ],
  [
    'scripts/deploy-ec2-server.sh',
    'OTTER_RELEASE_COMPATIBLE',
    'matching release semantics permit publish-route-drain while mismatch keeps quiescence',
  ],
  [
    'scripts/ec2-otter-lane-scope-run.sh',
    '--property=KillMode=control-group',
    'current and retention lane owners control every descendant process',
  ],
  [
    'scripts/ec2-otter-call-healer-run.sh',
    'otter-historical-backfill.pause',
    'the historical lane obeys a durable pause marker without stopping new-call processing',
  ],
  [
    'scripts/install-ec2-otter-call-healer-cron.sh',
    'OTTER_CALL_HEALER_INCLUDE_HISTORICAL=1',
    'historical archive repair is an explicit throttled lane',
  ],
  [
    'scripts/ec2-otter-healer-pause-recovery-run.sh',
    'otter-exact-worker.lock.flock',
    'stale malformed pause recovery fences both lanes and the host-global exact worker',
  ],
  [
    'scripts/lib/otter-healer-pause.js',
    'life_archive_otter_healer_pause.v2',
    'new healer pauses use the bounded schema-v2 lease writer',
  ],
  [
    'scripts/voice-promote-confirmed-acoustic-matches.js',
    'voice-name-conflicts-latest.json',
    'automatic acoustic promotion fails closed on confirmed voice/text name conflicts',
  ],
  [
    'scripts/otter-post-ingest-voice-intelligence.js',
    "SPEAKER_MATCH_SCORE: process.env.SPEAKER_MATCH_SCORE || '0.56'",
    'live post-ingest voice matching defaults to the calibrated 0.56 acoustic threshold',
  ],
  [
    'scripts/lib/voice-fargate-trigger.js',
    'VOICE_TASK_STANDARD_ENV',
    'Fargate voice launches use one pinned acoustic standard object instead of inheriting a stale image default',
  ],
  [
    'scripts/lib/voice-fargate-trigger.js',
    'legacy-reference-migration-receipts',
    'Fargate registry staging carries the exact legacy-trusted receipt closure',
  ],
  [
    'scripts/voice-sample-sequence-review-html.js',
    'This page is voice-only',
    'voice review clip membership is acoustic, not text/context alias expansion',
  ],
  [
    'scripts/otter-speaker-pareto-report.js',
    'speaker-pareto-latest.json',
    'Pareto report writes the recurring acoustic voice rows consumed by the review surface',
  ],
  [
    'scripts/otter-speaker-pareto-report.js',
    'voice_cluster_ids: row.voice_cluster_ids || []',
    'Pareto rows carry their member acoustic speaker clusters for review expansion',
  ],
  [
    'scripts/voice-sample-sequence-review-html.js',
    'speaker-pareto-latest.json',
    'voice review can resolve a Pareto acoustic arc to its member acoustic ids',
  ],
  [
    'scripts/voice-sample-sequence-review-html.js',
    'row?.voice_cluster_ids',
    'voice review expands Pareto arcs only through acoustic member ids',
  ],
  [
    'scripts/voice-sample-sequence-review-html.js',
    'briefing-voice-queue-latest.json',
    'voice review can rebuild links emitted by the current briefing unknown-voice queue',
  ],
  [
    'scripts/voice-sample-sequence-review-html.js',
    'recluster-latest.json',
    'voice review resolves recluster-backed unknown_voice_ecapa ids to member probe clips',
  ],
  [
    'scripts/voice-sample-sequence-review-html.js',
    'targetIsAcousticUnknown',
    'unknown_voice_ecapa review expansion matches direct recluster ids instead of leaking sibling clusters through shared member aliases',
  ],
  [
    'scripts/voice-sample-sequence-review-html.js',
    "membershipSource = 'recluster_exact'",
    'unknown_voice_ecapa review resolves exact current recluster membership before archive-wide enriched fallback',
  ],
  [
    'scripts/voice-sample-sequence-review-html.js',
    'distinct_calls_found',
    'recurring unknown review can prove consistency across multiple calls',
  ],
  [
    'ec2-server.js',
    'const matchedPeople = actionPerson;',
    'Pareto fallback must not fuzzy-select people files from heard-name/context artifacts',
  ],
  [
    'ec2-server.js',
    'function concretePeopleFileSuggestionFromHypothesis',
    'recluster modal suggestions pass through the concrete people-file gate',
  ],
  [
    'ec2-server.js',
    'ambiguous|no_people_file_match|low_margin|needs_ExampleCo|person_guess|unconfirmed|strictly_rejected',
    'concrete people-file suggestion gate rejects ambiguous or low-margin identity guesses',
  ],
  [
    'ec2-server.js',
    '(?:people_file_match|confirmed|strict)',
    'concrete people-file suggestion gate uses bounded non-transcript positive evidence tokens',
  ],
  [
    'ec2-server.js',
    'hypothesis.is_provisional',
    'provisional people-file suggestions remain separate from banked identity',
  ],
  [
    'ec2-server.js',
    'WHOLE_CALL_PEOPLE_FILE_SUGGESTION_MIN_CONFIDENCE',
    'only a strong whole-call marked-target judgment may preselect its exact queue-resolved People File suggestion',
  ],
  [
    'ec2-server.js',
    'data-voice-save-status',
    'voice confirmation renders a persistent inline save lifecycle',
  ],
  [
    'ec2-server.js',
    "setVoiceSaveUiState(\n    card,\n    btn,\n    'saving'",
    'voice confirmation acknowledges a click before the People File closure runs',
  ],
  [
    'ec2-server.js',
    "await handleVoiceConfirmButton(cloneBtn, tile.dataset.section || '')",
    'fullscreen voice review awaits the guarded confirmation handler',
  ],
  [
    'scripts/voice-confirmation-queue-build.js',
    'otter-speaker-intelligence-latest.json',
    'voice confirmation queue sources recurring unknown acoustic voices from fresh speaker intelligence',
  ],
  [
    'scripts/voice-confirmation-queue-build.js',
    'recurring_unresolved_acoustic_voice',
    'recurring acoustic unknowns are surfaced as their own review lane by default',
  ],
  [
    'scripts/voice-confirmation-queue-build.js',
    'confident_unique_exact_first_name_people_file_match',
    'strong whole-call judgments resolve one unique exact first-name People File without admitting fuzzy neighbors',
  ],
  [
    'scripts/voice-confirmation-queue-build.js',
    'name_people_file_resolution_audit',
    'voice confirmation queue publishes red proof when an eligible exact-name People File suggestion is missing',
  ],
  [
    'scripts/cloud-morning-briefing.js',
    'voice-name People File resolution',
    'Otter System Health surfaces a lost eligible exact-name People File link as red, while the owner and rule-6 acoustic withholdings are reported separately and never counted as gaps',
  ],
  [
    'scripts/voice-confirmation-queue-build.js',
    'non_speech_audio_artifact',
    'non-speech acoustic artifacts are suppressed from ExampleCo review queue',
  ],
  [
    'scripts/voice-confirmation-queue-build.js',
    'speakerIntelligenceReclusterCoverage',
    'speaker-intelligence residue is deduplicated against all recluster ids, including frozen known clusters',
  ],
  [
    'scripts/voice-confirmation-queue-build.js',
    'confirmedCanonicalSpeakerIds',
    'only canonical ids for confirmed enrolled voiceprints are suppressed from repeat review',
  ],
  [
    'scripts/lib/canonical-speaker-identity.js',
    'applyCanonicalSpeakerIdentity',
    'confirmed voice identities use one person-scoped canonical speaker id and retain generated ids as provenance',
  ],
  [
    'scripts/lib/canonical-speaker-identity.js',
    'canonicalizeVoiceIdentityRegistry',
    'legacy registry enrollments migrate to the same person-scoped canonical speaker id',
  ],
  [
    'scripts/otter-wavlm-speaker-resolver.js',
    'applyCanonicalSpeakerIdentity',
    'strict acoustic matches emit the canonical person-scoped speaker id',
  ],
  [
    'scripts/otter-track-probe-builder.js',
    'writeMergedProbeIndex',
    'the durable probe ledger publishes a merged whole-corpus probe index instead of letting scoped runs erase archive coverage',
  ],
  [
    'scripts/voice-global-recluster.js',
    'matchClustersToConfirmedReferences',
    'unresolved acoustic clusters are checked against confirmed voiceprint centroids under strict score and margin gates',
  ],
  [
    'scripts/voice-global-recluster.js',
    'source_revisions',
    'cluster membership retains exact source-revision lineage',
  ],
  [
    'scripts/voice-identity-llm-name-judge.js',
    'source_revisions',
    'name evidence retains exact source-revision lineage',
  ],
  [
    'scripts/voice-identity-llm-name-judge.js',
    'source_revision_by_otid',
    'multi-call name evidence binds each revision to its exact Otter call',
  ],
  [
    'scripts/voice-identity-llm-name-judge.js',
    'exactEnvelopePinnedSources',
    'an exact-call name judgment remains bound to immutable envelope tracks after reclustering moves them',
  ],
  [
    'scripts/lib/voice-name-conflicts.js',
    'source_revision_by_otid',
    'multi-call conflict evidence binds each revision to its exact Otter call',
  ],
  [
    'scripts/voice-global-recluster.js',
    'canonicalSpeakerId',
    'global recluster freezes known voices under their canonical person-scoped id',
  ],
  [
    'scripts/apply-voice-cluster-resolutions.js',
    'deriveReclusterMemberResolutions',
    'frozen confirmed recluster membership back-propagates onto current speaker ids',
  ],
  [
    'scripts/apply-voice-cluster-resolutions.js',
    'sequence_lineage_identity_removed',
    'legacy call-label-derived identities are demoted before acoustic re-resolution',
  ],
  [
    'scripts/apply-voice-cluster-resolutions.js',
    'runSpeakerIdentityChangeHook',
    'cluster membership apply invokes the edge-triggered People File reconciliation hook',
  ],
  [
    'scripts/otter-wavlm-speaker-resolver.js',
    'runSpeakerIdentityChangeHook',
    'automatic acoustic assignment invokes the edge-triggered People File reconciliation hook',
  ],
  [
    'scripts/otter-context-speaker-resolver.js',
    'runSpeakerIdentityChangeHook',
    'context-resolution writes invoke the edge-triggered People File reconciliation hook',
  ],
  [
    'scripts/otter-speaker-identity-completeness.js',
    'runSpeakerIdentityChangeHook',
    'identity-completeness repairs invoke the edge-triggered People File reconciliation hook',
  ],
  [
    'scripts/speaker-identity-change-hook.js',
    'syncPeopleFiles',
    'identity edge changes invoke both People File projections',
  ],
  [
    'scripts/speaker-identity-change-hook.js',
    'scripts/sync-voiceprints-to-people-files.js',
    'identity changes invoke voiceprint People File reconciliation',
  ],
  [
    'scripts/speaker-identity-change-hook.js',
    'scripts/sync-otter-speaker-intelligence-to-people-files.js',
    'identity changes invoke speaker-intelligence People File reconciliation',
  ],
  [
    'scripts/speaker-identity-change-hook.js',
    'scripts/voice-people-file-projection-audit.js',
    'identity changes fail closed unless the final People File projection audit runs',
  ],
  [
    'scripts/speaker-identity-change-hook.js',
    'return (results || []).every((result) => result?.ok);',
    'a red projection audit cannot consume the identity edge diff',
  ],
  [
    'scripts/voice-git-people-sync.js',
    'people_projection_audit_ok: c.status === 0 || c.status === 2,',
    'the git-authoritative relay accepts only a clean (0) or completed-incomplete (2) projection audit, never a red one',
  ],
  [
    'scripts/sync-otter-speaker-intelligence-to-people-files.js',
    'known_people_written',
    'speaker-content sync distinguishes actual file writes from evaluated identities',
  ],
  [
    'scripts/lib/voice-people-projection-audit.js',
    'people_file_writes_observed',
    'the closure audit exposes observed write telemetry separately from current state',
  ],
  [
    'scripts/health-self-heal.js',
    'voice-people-file-projection-audit-latest.json',
    'voice health fails closed on a missing or stale confirmed-identity People File projection audit',
  ],
  [
    'scripts/speaker-identity-change-hook.js',
    'Never consume the edge diff when People File reconciliation failed.',
    'a failed People File reconciliation preserves the edge diff for retry',
  ],
  [
    'scripts/sync-voiceprints-to-people-files.js',
    'planContactReconciliation',
    'voiceprint sync plans both current-owner writes and former-owner stale-block removal',
  ],
  [
    'scripts/sync-voiceprints-to-people-files.js',
    'removeGeneratedBlock',
    'voiceprint sync can remove stale generated evidence from a former owner',
  ],
  [
    'scripts/sync-otter-speaker-intelligence-to-people-files.js',
    'planStaleKnownBlockRemovals',
    'speaker-intelligence sync removes generated evidence after membership moves or clears',
  ],
  [
    'scripts/apply-voice-confirmation-actions.js',
    'canonical_speaker_id',
    'ExampleCo confirmation persists the canonical person-scoped speaker id at the source',
  ],
  [
    'scripts/otter-recluster-rebuild-once.js',
    'otter-track-probe-builder.js',
    'nightly recluster publishes the full durable probe corpus before acoustic clustering',
  ],
  [
    'scripts/otter-recluster-rebuild-once.js',
    'otter-wavlm-speaker-resolver.js',
    'nightly recluster creates every missing usable embedding before acoustic clustering',
  ],
  [
    'scripts/install-ec2-voice-recluster-cron.sh',
    'ec2-otter-recluster-rebuild-run.sh --write',
    'the nightly recluster write tail runs through the one verified, receipted rebuild wrapper',
  ],
  [
    'scripts/otter-recluster-rebuild-once.js',
    'voice-identity-overnight-name-resolver.js',
    'nightly review names recurring voices through the whole-call marked-target LLM judge',
  ],
  [
    DOC,
    'singleton name-resolver status is canonical System Health evidence',
    'the core method reserves shared resolver health for a complete declared scope',
  ],
  [
    'scripts/voice-identity-overnight-name-resolver.js',
    '--canonical-health-status',
    'the resolver requires explicit authority before writing canonical health',
  ],
  [
    'scripts/voice-identity-overnight-name-resolver.js',
    'voice-name-resolver-failure-patterns.json',
    'target failure patterns remain shared across canonical and scoped repair receipts',
  ],
  [
    'scripts/otter-recluster-rebuild-once.js',
    'apply-voice-cluster-resolutions.js',
    'nightly recluster applies current member resolutions before ExampleCo sees the queue',
  ],
  [
    'scripts/otter-recluster-rebuild-once.js',
    'scripts/voice-confirmation-queue-build.js',
    'nightly recluster rebuilds the review queue after resolution back-propagation',
  ],
  [
    'scripts/otter-post-ingest-voice-intelligence.js',
    'produceExactCallCompletionEnvelope',
    'the acoustic producer publishes one exact-call completion envelope after its selected revision finishes',
  ],
  [
    'scripts/lib/otter-exact-call-envelope.js',
    'life_archive_otter_exact_call_completion_envelope.v1',
    'the cross-runtime completion bundle has one versioned schema',
  ],
  [
    'scripts/lib/otter-exact-call-envelope.js',
    'promoteCompletionEnvelope',
    'EC2 atomically promotes a verified exact bundle instead of copying partial global rollups',
  ],
  [
    'scripts/lib/otter-exact-call-envelope.js',
    'architecture_provenance',
    'the exact envelope binds producer release and core-contract provenance',
  ],
  [
    'scripts/lib/otter-exact-call-envelope.js',
    'authorizedCutoverRelease',
    'historical envelopes remain authorized by immutable release or historical-authorization receipts',
  ],
  [
    'scripts/lib/otter-exact-call-envelope.js',
    'activeCutoverMarkerValid',
    'the active release lane requires a producer-contract hash while legacy receipts remain readable',
  ],
  [
    'scripts/lib/otter-exact-call-envelope.js',
    'writeHistoricalCutoverAuthorization',
    'historical producer authorization is stored outside the active release chain',
  ],
  [
    'scripts/activate-otter-exact-call-cutover.js',
    'strictProducerContract',
    'active cutover advances only to a contract-pinned producer compatible with the live consumer',
  ],
  [
    'scripts/activate-otter-exact-call-cutover.js',
    'authorizeHistoricalProducer',
    'the release controller exposes historical authorization without advancing the active tip',
  ],
  [
    'scripts/lib/otter-call-processing-ledger.js',
    'row.exact_completion_envelope.envelope_schema',
    'incremental ledger rebuilds refresh cached exact-envelope release status against the current cutover state',
  ],
  [
    'scripts/lib/otter-exact-call-envelope-producer.js',
    'produceExactCallCompletionEnvelope',
    'the producer collects selected-revision audio, diarization, probes, embeddings, and assignments into the bundle',
  ],
  [
    'scripts/lib/otter-exact-call-envelope-producer.js',
    'ranked_identity_candidates',
    'the immutable producer bundle preserves ranked identity candidates and their evidence',
  ],
  [
    'scripts/lib/otter-exact-call-envelope-producer.js',
    'producerAttemptKey',
    'failed exact producer attempts remain additive immutable evidence',
  ],
  [
    'scripts/lib/otter-exact-call-envelope-producer.js',
    'unresolved_below_identity_grade',
    'below-grade short turns remain explicit evidence without minting cross-call identity',
  ],
  [
    'scripts/lib/otter-exact-call-envelope-producer.js',
    'rejected_candidates',
    'the immutable producer artifact preserves rejected candidate diagnostics',
  ],
  [
    'scripts/lib/otter-exact-call-envelope-producer.js',
    'applyExactRankedCandidateIdentities',
    'the exact producer applies accepted ranked evidence to the canonical envelope identity',
  ],
  [
    'scripts/lib/otter-exact-call-envelope-producer.js',
    'candidate_reference_provenance_mismatch',
    'the exact producer rejects ranked evidence whose enrollment provenance is not exact',
  ],
  [
    'scripts/lib/otter-exact-call-envelope-producer.js',
    'const EXACT_MATCH_SCORE = 0.56',
    'the exact producer score gate remains pinned to the deployed resolver threshold',
  ],
  [
    'scripts/lib/otter-exact-call-envelope-producer.js',
    'const EXACT_MATCH_MARGIN = 0.06',
    'the exact producer margin gate remains pinned to the deployed resolver threshold',
  ],
  [
    'scripts/otter-wavlm-speaker-resolver.js',
    'sandboxRejectedCandidates',
    'the Fargate acoustic path preserves rejected person, score, margin, and reason evidence',
  ],
  [
    'scripts/lib/voice-reference-provenance.js',
    'legacy_trusted_record_hash_mismatch',
    'trusted legacy references fail closed when their attested enrollment record changes',
  ],
  [
    'scripts/lib/voice-reference-provenance.js',
    'legacy_trusted_audio_trace_ambiguous',
    'trusted legacy identity remains eligible while unresolved audio provenance is excluded from acoustic comparison without inferring loss',
  ],
  [
    'scripts/migrate-legacy-voice-reference-provenance.js',
    'MIGRATION_AUTHORITY',
    'the legacy baseline migration uses the fixed ExampleCo-authorized authority',
  ],
  [
    'scripts/deploy-ec2-server.sh',
    '--require-current',
    'deployment refuses to activate provenance-gated matching before the trusted baseline is stamped',
  ],
  [
    'scripts/otter-wavlm-speaker-resolver.js',
    'referenceEligibility(identity, enrollment',
    'known-reference matching admits only versioned or trusted-baseline evidence',
  ],
  [
    'dev-plans/core/otter-transcript-pipeline.md',
    'legacy_trusted',
    'the core method documents trusted legacy reference eligibility and its limits',
  ],
  [
    'scripts/lib/otter-exact-call-envelope.js',
    'candidate?.evidence_hash',
    'the exact envelope validates candidate evidence hashes instead of accepting unbound rankings',
  ],
  [
    'scripts/lib/otter-exact-call-envelope.js',
    'accepted ranked identity candidate is not the canonical envelope identity',
    'the consumer rejects an accepted candidate that is not the envelope identity',
  ],
  [
    'scripts/lib/canonical-speaker-identity.js',
    'isConfirmedRegistryPerson',
    'all downstream identity decisions share one canonical confirmed-person predicate',
  ],
  [
    'scripts/voice-efs-reconcile.js',
    'reconcileExactCompletionEnvelopes',
    'EFS reconciliation verifies and promotes exact completion envelopes',
  ],
  [
    'scripts/voice-efs-reconcile.js',
    'writeDispatchEvent',
    'exact bundle promotion emits a durable per-call dispatch event',
  ],
  [
    'scripts/otter-ingest-watch.js',
    'queueExactCallDispatcher',
    'the live dispatcher starts immediately after an exact bundle promotion',
  ],
  [
    'scripts/lib/otter-exact-call-aggregate-reconcile.js',
    'reconcileExactCallAggregate',
    'derived aggregates project only the promoted exact call and raw revision',
  ],
  [
    'scripts/lib/otter-call-processing-ledger.js',
    'STATE_DIVERGENCE',
    'a same-raw-SHA contradiction between the exact bundle and a derived aggregate fails closed',
  ],
  [
    'scripts/lib/otter-call-processing-ledger.js',
    'exact_envelope_cutover_invalid',
    'an invalid cutover marker remains a release-trust defect',
  ],
  [
    'scripts/otter-call-stage-receipts.js',
    'scoped_projection_receipt',
    'People projection completion is scoped to the exact call and raw revision',
  ],
  [
    'scripts/lib/otter-call-closure-verifier.js',
    'scoped_projection_receipt',
    'closure rejects archive-wide People projection evidence',
  ],
  [
    'scripts/lib/otter-exact-call-people-projection.js',
    'before_hash',
    'the scoped People projection receipt binds the prior file bytes',
  ],
  [
    'scripts/lib/otter-exact-call-people-projection.js',
    'after_hash',
    'the scoped People projection receipt binds the resulting file bytes',
  ],
  [
    'scripts/lib/otter-exact-call-people-projection.js',
    'landed_commit_sha',
    'the scoped People projection receipt binds the git-authoritative landing',
  ],
  [
    'scripts/otter-exact-call-people-projection.js',
    'staged_for_daily_git_relay',
    'exact-call closure waits for the git-authoritative People projection relay',
  ],
  [
    'scripts/otter-exact-call-people-projection.js',
    '/opt/secondbrain-releases/',
    'People proof paths are normalized away from prunable release directories',
  ],
  [
    'scripts/otter-exact-call-people-projection.js',
    'if (!exactEnvelope)',
    'verified exact envelopes switch projection from enriched union to per-track merge',
  ],
  [
    'scripts/otter-exact-call-people-projection.js',
    'mergeMonotonicIdentity(exactIdentity, projectedIdentity',
    'exact People projection applies the same per-track monotonic merge as receipt derivation',
  ],
  [
    'scripts/otter-call-stage-receipts.js',
    "'life-archive',\n    'voice-identity-registry.json'",
    'exact receipts read the canonical identity registry rather than the stale voiceprints snapshot',
  ],
  [
    'scripts/otter-call-stage-receipts.js',
    'canonical_registry_confirmed_identity_upgrade',
    'stale-registry receipt supersession is a narrow unknown-to-confirmed canonical upgrade',
  ],
  [
    'scripts/lib/voice-people-projection-health.js',
    'relay_requests_stale_open',
    'stalled git-authoritative People projection relays stay visible in System Health',
  ],
  [
    'scripts/otter-call-stage-receipts.js',
    'fingerprintTarget(recluster, target)',
    'stage evidence fingerprints the complete current cluster membership for the target',
  ],
  [
    'scripts/lib/otter-call-healer-handoff.js',
    'life_archive_otter_call_healer_handoff.v2',
    'exact-call handoff state is versioned and bound to the exact bundle',
  ],
  [
    'scripts/lib/otter-call-healer-handoff.js',
    "new Set(['queued', 'claimed', 'deferred', 'advanced'])",
    'durable handoff ownership exposes every active transition',
  ],
  [
    'scripts/lib/otter-call-healer-handoff.js',
    "new Set(['closed', 'superseded_with_proof'])",
    'a handoff becomes terminal only through proof-backed closure or supersession',
  ],
  [
    'scripts/lib/otter-call-healer-handoff.js',
    'terminal_process_preserved',
    'unchanged live-QC publication cannot requeue a terminal exact process',
  ],
  [
    'scripts/otter-call-processing-healer-dispatch.js',
    'consumeExactDispatchEvents',
    'the dispatcher consumes exact promotion events before deadline polling',
  ],
  [
    'scripts/otter-call-processing-healer-dispatch.js',
    'runFairCandidates',
    'the dispatcher scans beyond denied candidates until the live worker slot is filled',
  ],
  [
    'scripts/otter-call-processing-healer-dispatch.js',
    'duplicate_of_terminal_v2',
    'legacy handoff duplicates cannot reopen a terminal exact process',
  ],
  [
    'scripts/otter-call-processing-healer-dispatch.js',
    'handoff_scan_errors',
    'one malformed legacy handoff stays red without blocking unrelated live admission',
  ],
  [
    'scripts/otter-call-processing-healer-dispatch.js',
    'orphaned_no_ledger_call',
    'readable handoffs absent from the current ledger drain with an orphan receipt',
  ],
  [
    DOC,
    'Legacy handoff migration is per-record',
    'the core method states the per-record migration and live-admission invariant',
  ],
  [
    'scripts/lib/healer-attempt-history.js',
    'ATTEMPT_FIELDS',
    'card and exact-call agents share one prompt-safe attempt schema',
  ],
  [
    'scripts/agentic-healer-driver.js',
    './lib/healer-attempt-history.js',
    'overnight card agents consume the shared attempt/history contract',
  ],
  [
    'scripts/agentic-healer-driver.js',
    '--attempt-context',
    'the common agent driver accepts an exact external process-history envelope',
  ],
  [
    'scripts/otter-call-agentic-healer.js',
    './lib/healer-attempt-history.js',
    'exact-call agent escalation consumes the same shared attempt/history contract',
  ],
  [
    'scripts/lib/otter-call-processing-cycles.js',
    'BLOCKED_AGENT_FAILED',
    'legacy and explicit hard-wall blocked receipts remain readable',
  ],
  [
    'scripts/lib/otter-call-processing-cycles.js',
    'BLOCKED_NO_NEW_APPROACH',
    'the exact process stops when no unused tactic remains',
  ],
  [
    'scripts/lib/otter-call-processing-cycles.js',
    'const NO_PROGRESS_LIMIT = 8',
    'eight genuine no-progress outcomes stop the exact process',
  ],
  [
    'scripts/otter-call-agentic-healer.js',
    "skipped: 'mechanical_tactics_remain'",
    'agent escalation is rejected until usable mechanical tactics are exhausted',
  ],
  [
    'scripts/otter-call-agentic-healer.js',
    'exactCallAgentBoardEnvelope',
    'the exact-call healer derives its repair input from the call graph without waiting on briefing health',
  ],
  [
    'scripts/lib/otter-call-closure-settlement.js',
    'publishLedgerWithHandoffSettlement',
    'closure and durable handoff settlement publish through one recoverable journaled transition',
  ],
  [
    'scripts/otter-call-processing-ledger.js',
    'publishLedgerWithHandoffSettlement',
    'the ledger writer cannot bypass atomic closure settlement',
  ],
  [
    'scripts/lib/otter-call-processing-graph.js',
    'control_path',
    'the live graph renders the exact envelope, promotion, projection, dispatch, handoff, bounded repair, and closure path',
  ],
  [
    'scripts/lib/otter-call-processing-graph.js',
    'event_clocks',
    'the live graph exposes separate queue, cold-start, execution, handoff, and closure clocks',
  ],
  [
    'scripts/lib/otter-call-processing-graph.js',
    'speaker_attribution',
    'the live graph explains per-speaker and per-segment attribution, including uncertainty',
  ],
  [
    'scripts/lib/otter-call-processing-graph.js',
    'attempt_history',
    'the live graph exposes the bounded process history given to the agent',
  ],
  [
    'scripts/lib/otter-call-processing-health.js',
    'exact_envelope_cutover_invalid',
    'System Health fails closed on an invalid exact-envelope release marker',
  ],
  [
    'scripts/lib/otter-call-processing-health.js',
    'callGraphHealthOverlay',
    'System Health consumes the same event-fed exact-call graph',
  ],
  [
    'scripts/cloud-morning-briefing.js',
    'formatOtterCallGraphBriefingHeader',
    'the briefing surfaces the same exact-call graph state and event clocks',
  ],
  [
    'deploy/voice-fargate/Dockerfile',
    'SECONDBRAIN_TASK_IMAGE_SOURCE_SHA',
    'the task image identifies its exact producer source release',
  ],
  [
    'deploy/voice-fargate/Dockerfile',
    'dev-plans/core/otter-transcript-pipeline.md',
    'the producer image carries the governed architecture document for provenance',
  ],
  [
    'deploy/voice-fargate/Dockerfile',
    'otter-producer-contract.json',
    'the producer image carries the dedicated wire-semantics contract',
  ],
  [
    'scripts/lib/otter-architecture-provenance.js',
    'producer_contract_sha256',
    'producer compatibility is separate from consumer policy documentation',
  ],
  [
    'scripts/deploy-ec2-server.sh',
    'scripts/activate-otter-exact-call-cutover.js',
    'the EC2 release contains the explicit shadow-to-cutover activation gate',
  ],
  [
    'scripts/deploy-ec2-server.sh',
    'otter-call-processing-attempt-contexts',
    'deployment creates writable durable runtime roots for exact graph and attempt proof',
  ],
];

// [file, token, why] -- the token must be ABSENT (a design boundary).
const MUST_NOT_CONTAIN = [
  ['scripts/otter-ingest-watch.js', 'audio-full', 'ingest is transcript-only by design'],
  [
    'scripts/otter-call-stage-receipts.js',
    'writeExactProjectionReceiptFromAudit',
    'mutable archive-wide People audit may not mint an exact-call closure receipt',
  ],
  [
    'scripts/otter-call-agentic-healer.js',
    'metric_refresh_unavailable',
    'exact-call healing must not wait for the derived System Health metric',
  ],
  [
    'scripts/otter-call-agentic-healer.js',
    'metric_not_red_after_refresh',
    'exact-call healing is driven by exact graph defects, not briefing refresh state',
  ],
  [
    'scripts/otter-wavlm-speaker-resolver.js',
    'saveJson(rawRow.file',
    'the acoustic resolver may never mutate canonical raw transcript bytes',
  ],
  [
    'scripts/voice-incremental-recluster.js',
    'saveJsonAtomic(rawPath',
    'incremental identity assignment may never mutate canonical raw transcript bytes',
  ],
  [
    'scripts/voice-confirmation-queue-build.js',
    'buildConfirmedSequenceLineage',
    'call-label lineage may not suppress or identify confirmation-queue rows',
  ],
  [
    'scripts/voice-global-recluster.js',
    'sequenceTrackKey',
    'call and diarization label may not identify a person during reclustering',
  ],
  [
    'scripts/apply-voice-cluster-resolutions.js',
    'buildConfirmedSequenceLineage',
    'call-label lineage may not back-propagate person identity',
  ],
  [
    'scripts/refresh-briefing-generated-sections.js',
    'contextNameHintsForCall',
    'hard-coded nearby-name regexes may not publish speaker identities',
  ],
  [
    'scripts/otter-post-ingest-voice-intelligence.js',
    "'promote_confirmed_acoustic'",
    'the selected-call graph may not invoke the legacy archive-wide acoustic promoter',
  ],
  [
    'scripts/otter-post-ingest-voice-intelligence.js',
    "'apply_known_resolutions'",
    'the selected-call graph may not invoke the legacy archive-wide resolution apply tail',
  ],
];

function jsObjectValue(src, name) {
  const re = new RegExp(`${name}\\s*:\\s*['"]([^'"]+)['"]`);
  return src.match(re)?.[1] || null;
}

function taskdefEnvironment(src) {
  try {
    const parsed = JSON.parse(src);
    const containers = parsed.containerDefinitions || [parsed];
    const voice = containers.find((container) => container.name === 'voice') || containers[0] || {};
    return {
      ...Object.fromEntries(
        (voice.environment || parsed.environment || []).map((item) => [item.name, item.value]),
      ),
      __user: String(voice.user || ''),
    };
  } catch (err) {
    return { __parse_error: err.message };
  }
}

function checkDrift(repoRoot) {
  const failures = [];
  const warnings = [];
  const read = (rel) => {
    try {
      return fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    } catch {
      return null;
    }
  };

  if (read(DOC) === null) failures.push(`missing core doc: ${DOC}`);
  if (read(LESSONS) === null) failures.push(`missing LESSONS: ${LESSONS}`);

  for (const rel of STAGE_FILES) {
    if (read(rel) === null) failures.push(`missing load-bearing file: ${rel}`);
  }
  for (const [rel, note] of RUNTIME_FILES) {
    if (read(rel) === null)
      warnings.push(`runtime artifact absent (ok in git, must exist live): ${rel} -- ${note}`);
  }
  for (const [rel, token, why] of MUST_CONTAIN) {
    const src = read(rel);
    if (src === null) failures.push(`cannot check invariant, file missing: ${rel}`);
    else if (!src.includes(token))
      failures.push(`invariant lost in ${rel}: expected "${token}" (${why})`);
  }
  for (const [rel, token, why] of MUST_NOT_CONTAIN) {
    const src = read(rel);
    if (src === null) failures.push(`cannot check invariant, file missing: ${rel}`);
    else if (src.includes(token))
      failures.push(
        `invariant broken in ${rel}: found "${token}" (${why}) -- update the doc if intentional`,
      );
  }

  const resolverSources = read('scripts/lib/briefing-source-contracts.js') || '';
  // A producer call is a resolver reference followed by CLI flags; the other
  // references are implementationFiles metadata. Every producer call must
  // carry --canonical-health-status receipt authority.
  const resolverProducerCalls =
    resolverSources.match(
      /['"]scripts\/voice-identity-overnight-name-resolver\.js['"]\s*,\s*['"]--[a-z-]+['"]/g,
    ) || [];
  const canonicalResolverCalls = resolverProducerCalls.filter((call) =>
    /--canonical-health-status/.test(call),
  );
  if (!canonicalResolverCalls.length || canonicalResolverCalls.length !== resolverProducerCalls.length) {
    failures.push(
      `canonical resolver receipt authority is bound at ${canonicalResolverCalls.length} of ${resolverProducerCalls.length} producer call site(s); every producer call must carry --canonical-health-status`,
    );
  }
  const orphanRejudge = read('scripts/voice-name-judge-orphan-rejudge.js') || '';
  if (
    !/voice-identity-overnight-name-resolver\.js['"]\)[\s\S]{0,400}['"]--status-scope['"]\s*,\s*['"]orphan-rejudge['"]/.test(
      orphanRejudge,
    )
  ) {
    failures.push('orphan re-judge no longer writes a scoped resolver receipt');
  }
  const reclusterRebuild = read('scripts/otter-recluster-rebuild-once.js') || '';
  if (
    !/['"]scripts\/voice-identity-overnight-name-resolver\.js['"][\s\S]{0,400}['"]--limit['"]\s*,\s*['"]60['"][\s\S]{0,120}['"]--status-scope['"]\s*,\s*['"]recluster-rebuild['"]/.test(
      reclusterRebuild,
    )
  ) {
    failures.push('limited recluster catch-up no longer writes a scoped resolver receipt');
  }

  // Keep the fast attended healer and its grader on the same bounded source
  // population. Lifetime archive/identity repair belongs to the separately
  // named lifetime metric and must not silently re-enter this lane.
  const sourceContracts = read('scripts/lib/briefing-source-contracts.js') || '';
  const pastWeekRefreshStart = sourceContracts.indexOf('async function refreshOtter({');
  const pastWeekRefreshEnd = sourceContracts.indexOf(
    'async function refreshOtterLegacy',
    pastWeekRefreshStart,
  );
  const pastWeekRefresh =
    pastWeekRefreshStart >= 0 && pastWeekRefreshEnd > pastWeekRefreshStart
      ? sourceContracts.slice(pastWeekRefreshStart, pastWeekRefreshEnd)
      : '';
  const forbiddenLifetimeProducers = [
    'scripts/otter-call-processing-stage-budgets.js',
    'scripts/voice-identity-overnight-name-resolver.js',
    'scripts/otter-speaker-pareto-report.js',
    'scripts/otter-voice-discovery-roster.js',
    'scripts/voice-people-file-projection-audit.js',
    'scripts/voiceprint-health-report.js',
    'scripts/otter-processing-coverage-probe.js',
  ];
  if (
    !pastWeekRefresh ||
    !/otterPastWeekScope/.test(pastWeekRefresh) ||
    !/--otids/.test(pastWeekRefresh) ||
    !/SPEAKER_IDENTITY_CHANGE_HOOK:\s*'0'/.test(pastWeekRefresh) ||
    forbiddenLifetimeProducers.some((producer) => pastWeekRefresh.includes(producer))
  ) {
    failures.push(
      'Past week Otter speaker enrichment healer is no longer fail-closed and OTID-bounded away from lifetime producers and the lifetime identity hook',
    );
  }
  const cloudBriefing = read('scripts/cloud-morning-briefing.js') || '';
  const pipelineDoc = read(DOC) || '';
  if (
    !cloudBriefing.includes("const LABEL = 'Past week Otter speaker enrichment'") ||
    !cloudBriefing.includes('resolveOtterPastWeekWindow(last7)') ||
    !pipelineDoc.includes('Past week Otter speaker enrichment') ||
    !pipelineDoc.includes('Lifetime call processing completion')
  ) {
    failures.push(
      'Past-week versus lifetime Otter metric naming/scope invariant is missing from code or canonical documentation',
    );
  }
  const pastWeekScopeModule = read('scripts/lib/otter-past-week-scope.js') || '';
  if (
    !pastWeekScopeModule.includes('otter-ingest-seen.json') ||
    !pastWeekScopeModule.includes('expectedCount') ||
    /readdirSync\(rawDir\)/.test(pastWeekScopeModule)
  ) {
    failures.push(
      'Past week Otter scope discovery no longer uses bounded indexes or has regressed to a lifetime raw-transcript scan',
    );
  }

  const stripComments = (source) =>
    String(source || '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
  const compactCode = (source) => stripComments(source).replace(/\s+/g, '');
  const identityHook = read('scripts/speaker-identity-change-hook.js') || '';
  const prepareStart = identityHook.indexOf('function prepareCurrentEdges');
  const prepareEnd = identityHook.indexOf('\nfunction main', prepareStart);
  const prepareBody =
    prepareStart >= 0 && prepareEnd > prepareStart
      ? identityHook.slice(prepareStart, prepareEnd)
      : '';
  const expectedPrepareBody =
    "functionprepareCurrentEdges({write,normalizedUpstream=false,normalizeFn=normalizeSpeakerIdentities,collectFn=collectEdges,}={}){constnormalizationResult=!write?null:normalizedUpstream?{ok:true,skipped:true,reason:'normalized-upstream'}:normalizeFn();return{normalizationResult,currentEdges:normalizationResult&&!normalizationResult.ok?null:collectFn(),};}";
  if (compactCode(prepareBody) !== expectedPrepareBody) {
    failures.push(
      'identity edge collection no longer runs strictly after fail-closed speaker normalization',
    );
  }

  const incremental = read('scripts/voice-incremental-recluster.js') || '';
  const personIdStart = incremental.indexOf('function assignmentPersonId');
  const personIdEnd = incremental.indexOf('\nfunction displayNameForPerson', personIdStart);
  const personIdBody =
    personIdStart >= 0 && personIdEnd > personIdStart
      ? incremental.slice(personIdStart, personIdEnd)
      : '';
  const executablePersonIdBody = compactCode(personIdBody);
  const assignmentIdentityStart = incremental.indexOf('function assignmentIdentity');
  const assignmentIdentityEnd = incremental.indexOf(
    '\nfunction applyAssignmentToCall',
    assignmentIdentityStart,
  );
  const assignmentIdentityBody =
    assignmentIdentityStart >= 0 && assignmentIdentityEnd > assignmentIdentityStart
      ? incremental.slice(assignmentIdentityStart, assignmentIdentityEnd)
      : '';
  const expectedPersonIdBody =
    "functionassignmentPersonId(assignment){return(String(assignment?.confirmed_person_id||'').trim()||String(assignment?.cluster_id||'').match(/^person:(.+)$/)?.[1]||'');}";
  const personIdFallback = executablePersonIdBody === expectedPersonIdBody;
  const executableAssignmentIdentityBody = compactCode(assignmentIdentityBody);
  const personIdentityRelationship =
    executableAssignmentIdentityBody.includes(
      'constpersonId=assignmentPersonId(assignment);if(personId){',
    ) &&
    executableAssignmentIdentityBody.includes('applyCanonicalSpeakerIdentity(identity,personId,{');
  const clearsUnknownIdentity = executableAssignmentIdentityBody.includes(
    'unknown_speaker_id:null,acoustic_unknown_id:null,',
  );
  if (!personIdFallback || !personIdentityRelationship || !clearsUnknownIdentity) {
    failures.push(
      'incremental person-cluster writeback no longer binds person-prefixed membership to one canonical confirmed identity',
    );
  }

  if (read('package.json') !== null) {
    try {
      const incrementalModule = require(
        path.join(repoRoot, 'scripts', 'voice-incremental-recluster.js'),
      );
      const recovered = incrementalModule.assignmentIdentity({
        prior: {
          identity_tier: 'durable_unknown_voice',
          unknown_speaker_id: 'person:PRIVATE_NAME',
          acoustic_unknown_id: 'person:PRIVATE_NAME',
        },
        assignment: {
          cluster_id: 'person:PRIVATE_NAME',
          source_voice_cluster_id: 'speaker_9791515838',
        },
        registry: {
          people: {
            PRIVATE_NAME: { display_name: 'PRIVATE_NAME' },
          },
        },
      });
      if (
        recovered?.person_id !== 'PRIVATE_NAME' ||
        recovered?.voice_cluster_id !== 'person:PRIVATE_NAME' ||
        recovered?.unknown_speaker_id !== null ||
        recovered?.acoustic_unknown_id !== null
      ) {
        failures.push(
          'incremental person-cluster writeback behavioral probe did not preserve canonical confirmed identity',
        );
      }
      const hookModule = require(path.join(repoRoot, 'scripts', 'speaker-identity-change-hook.js'));
      const order = [];
      const prepared = hookModule.prepareCurrentEdges({
        write: true,
        normalizeFn: () => {
          order.push('normalize');
          return { ok: false };
        },
        collectFn: () => {
          order.push('collect');
          return {};
        },
      });
      if (order.join(',') !== 'normalize' || prepared?.currentEdges !== null) {
        failures.push(
          'identity edge collection behavioral probe did not fail closed after normalization failure',
        );
      }
      const upstreamOrder = [];
      const upstreamPrepared = hookModule.prepareCurrentEdges({
        write: true,
        normalizedUpstream: true,
        normalizeFn: () => {
          upstreamOrder.push('normalize');
          return { ok: true };
        },
        collectFn: () => {
          upstreamOrder.push('collect');
          return { edge: true };
        },
      });
      if (
        upstreamOrder.join(',') !== 'collect' ||
        upstreamPrepared?.normalizationResult?.reason !== 'normalized-upstream' ||
        upstreamPrepared?.currentEdges?.edge !== true
      ) {
        failures.push(
          'upstream-normalized projection handoff repeated archive normalization or skipped edge collection',
        );
      }
    } catch (error) {
      failures.push(`identity projection behavioral drift probe failed: ${error.message}`);
    }
  }

  const triggerSrc = read('scripts/lib/voice-fargate-trigger.js');
  const taskdefSrc = read('deploy/voice-fargate/taskdef.json');
  if (triggerSrc && taskdefSrc) {
    const taskEnv = taskdefEnvironment(taskdefSrc);
    if (taskEnv.__parse_error) {
      failures.push(`invalid deploy/voice-fargate/taskdef.json: ${taskEnv.__parse_error}`);
    }
    if (taskEnv.__user !== '1000:1000') {
      failures.push(
        'Fargate voice task must run as UID/GID 1000:1000 so EC2 can reconcile its EFS artifacts',
      );
    }
    for (const [name, expected] of Object.entries(FARGATE_VOICE_STANDARD_ENV)) {
      const triggerValue = jsObjectValue(triggerSrc, name);
      const taskValue = taskEnv[name] || null;
      if (triggerValue !== expected) {
        failures.push(
          `Fargate launch standard drifted: scripts/lib/voice-fargate-trigger.js ${name}=${triggerValue || '<missing>'}, expected ${expected}`,
        );
      }
      if (taskValue !== expected) {
        failures.push(
          `Fargate task definition standard drifted: deploy/voice-fargate/taskdef.json ${name}=${taskValue || '<missing>'}, expected ${expected}`,
        );
      }
      if (triggerValue && taskValue && triggerValue !== taskValue) {
        failures.push(
          `Fargate launch/taskdef mismatch: ${name} launch=${triggerValue}, taskdef=${taskValue}`,
        );
      }
    }
  }

  // The doc must not silently drop the correction that action items are Gmail, not Otter.
  // The core doc is capped at 2,500 words and verify-core-doc-shape.js sends
  // overflow detail to LESSONS, so the method contracts below are satisfied by
  // either file. Checking the doc alone made the two guards contradict.
  const doc = read(DOC) === null ? '' : `${read(DOC)}\n${read(LESSONS) || ''}`;
  if (doc && !/NOT from Otter|Gmail-derived|not a wired output/i.test(doc)) {
    failures.push('doc no longer states that action items are Gmail-derived, not an Otter stage');
  }
  if (
    doc &&
    !/SPEAKER_MATCH_SCORE=0\.56|voice-only review page|distinct calls|voice_cluster_ids|briefing-voice-queue-latest\.json|recluster-latest\.json|before any archive-wide enriched fallback/i.test(
      doc,
    )
  ) {
    failures.push(
      'doc no longer states the voice-only review, Pareto/recluster acoustic expansion, and 0.56 acoustic matching standard',
    );
  }
  if (
    doc &&
    !/voice-confirmation-queue-build\.js|otter-speaker-intelligence-latest\.json|non_speech_audio_artifact/i.test(
      doc,
    )
  ) {
    failures.push(
      'doc no longer states the fresh speaker-intelligence queue source and non-speech suppression standard',
    );
  }
  if (
    doc &&
    (!/People Files reconcile in both directions/i.test(doc) ||
      !/speaker-identity-change-hook\.js/i.test(doc) ||
      !/sync-voiceprints-to-people-files\.js/i.test(doc) ||
      !/sync-otter-speaker-intelligence-to-people-files\.js/i.test(doc))
  ) {
    failures.push(
      'doc no longer makes bidirectional People File reconciliation part of cluster membership changes',
    );
  }
  if (
    doc &&
    !/One-OTID projection uses `otter-exact-call-people-projection\.js` with pinned SHA/i.test(doc)
  ) {
    failures.push('doc no longer prohibits archive-wide People projection from a one-call tail');
  }
  if (
    doc &&
    (!/frozen `?person:<id>`? membership (?:as|is|remains) (?:a )?confirmed/i.test(doc) ||
      !/normalizes person-prefixed legacy unknowns/i.test(doc) ||
      !/fills every orphan speaker segment/i.test(doc))
  ) {
    failures.push(
      'doc no longer prevents confirmed person-cluster demotion before identity projection',
    );
  }
  if (doc && !/mean plus three|mean \+ 3|three population standard deviations/i.test(doc)) {
    failures.push(
      'doc no longer states the measured mean-plus-three-standard-deviations stage clocks',
    );
  }
  if (doc && !/exact-call healer|input fingerprint|Historical archive repair/i.test(doc)) {
    failures.push(
      'doc no longer states the durable exact-stage healer and separate historical lane',
    );
  }
  if (
    doc &&
    (!/immutable exact-call completion envelope/i.test(doc) ||
      !/atomically promotes/i.test(doc) ||
      !/STATE_DIVERGENCE/i.test(doc))
  ) {
    failures.push(
      'doc no longer requires immutable exact-envelope publication, atomic promotion, and fail-closed state divergence',
    );
  }
  if (
    doc &&
    (!/unresolved_below_identity_grade/i.test(doc) ||
      !/speaker_\*.*call-local.*cross-call identity/i.test(doc) ||
      !/8-word, 6-second, score, and margin gates do not move/i.test(doc))
  ) {
    failures.push(
      'doc no longer preserves below-grade short turns without weakening identity gates or minting call-local identity',
    );
  }
  if (
    doc &&
    (!/`queued`[\s\S]*`claimed`[\s\S]*`deferred`[\s\S]*`advanced`/i.test(doc) ||
      !/superseded_with_proof/i.test(doc) ||
      !/(?:proof-backed `closed`|closed` with closure proof)/i.test(doc) ||
      !/settles from the exact refreshed ledger before host admission lease release/i.test(doc) ||
      !/transition serializes through its own exclusive lock/i.test(doc) ||
      !/rechecks the exact claim owner inside that lock/i.test(doc))
  ) {
    failures.push(
      'doc no longer requires the durable proof-backed exact-call handoff state machine, settlement-before-release, and locked owner recheck',
    );
  }
  if (
    doc &&
    (!/tactic, hypothesis, action, result, live outcome, and why not closed/i.test(doc) ||
      !/BLOCKED_AGENT_FAILED/i.test(doc) ||
      !/BLOCKED_NO_NEW_APPROACH/i.test(doc) ||
      !/single agent failure is not terminal/i.test(doc) ||
      !/eight genuine attempts is terminal/i.test(doc) ||
      !/only reopen paths are explicit preview\/write through `scripts\/reopen-otter-exact-closure-generation\.js` or `scripts\/reopen-otter-voice-completion-generation\.js`/i.test(
        doc,
      ) ||
      !/Voice completion remains active while the current `repair_stage` is still `voice_completion`/i.test(
        doc,
      ) ||
      !/exact current-ledger SHA proof that the same revision and stage remain open/i.test(doc) ||
      !/append-only `repair_generation_started` receipt preserves every old attempt and block/i.test(
        doc,
      ) ||
      !/never claims that unclosed work cleared/i.test(doc))
  ) {
    failures.push(
      'doc no longer pins shared attempt history, bounded stops, and proof-gated exact-closure/voice repair generations',
    );
  }
  if (
    doc &&
    (!/producer image SHA/i.test(doc) ||
      !/consumer release SHA/i.test(doc) ||
      !/core[- ]document hash/i.test(doc) ||
      !/Historical replay stays paused/i.test(doc))
  ) {
    failures.push(
      'doc no longer pins architecture provenance and the fresh-call-before-backfill rollout gate',
    );
  }
  if (
    doc &&
    (!/legacy_trusted_matchable/i.test(doc) ||
      !/legacy_trusted_audio_trace_ambiguous/i.test(doc) ||
      !/resolved-relocation, genuinely-missing, and ambiguous/i.test(doc) ||
      !/not that audio was lost/i.test(doc))
  ) {
    failures.push(
      'doc no longer separates trusted legacy identity from current acoustic capability',
    );
  }
  if (
    doc &&
    (!/current tip must carry the producer-contract hash and match the live consumer/i.test(doc) ||
      !/historical envelope[\s\S]*immutable producer authorization/i.test(doc) ||
      !/can never advance or replace the active release tip/i.test(doc) ||
      !/Legacy active artifacts without that hash remain readable for migration, but are not active-valid/i.test(
        doc,
      ) ||
      !/Forked, orphaned, malformed, or non-monotonic active receipts fail closed/i.test(doc))
  ) {
    failures.push(
      'doc no longer separates contract-pinned active release state from immutable historical authorization',
    );
  }
  if (
    doc &&
    !/(?:No global reclustering, legacy acoustic promoter, regex name fallback, or briefing-wide pre-brief resolver substitutes for this graph|Global reclustering, legacy promotion, regex names, and pre-brief resolution cannot substitute)/i.test(
      doc,
    )
  ) {
    failures.push(
      'doc no longer rejects obsolete briefing-wide, global, and regex name-resolution fallbacks',
    );
  }
  if (
    doc &&
    !/uploads? (?:and verifies )?the exact SHA|S3.*before (?:queueing|processing)|remote archive receipt/i.test(
      doc,
    )
  ) {
    failures.push(
      'doc no longer requires a verified remote raw archive before exact-call processing',
    );
  }
  if (doc && !/idle -> saving -> accepted\/error|persistent inline retryable error/i.test(doc)) {
    failures.push('doc no longer requires visible durable-acceptance voice Save lifecycle');
  }
  const server = read('ec2-server.js') || '';
  const saveHandlerStart = server.indexOf(
    "if (urlPath === '/briefing/voice-confirm' && req.method === 'POST')",
  );
  const saveHandlerEnd = server.indexOf(
    '// 2026-05-14: video approval queue endpoints.',
    saveHandlerStart,
  );
  const saveHandler =
    saveHandlerStart >= 0 && saveHandlerEnd > saveHandlerStart
      ? server.slice(saveHandlerStart, saveHandlerEnd)
      : '';
  if (
    !saveHandler ||
    !/voice-confirmation-jobs\.jsonl/.test(saveHandler) ||
    !/accepted_for_background_consolidation/.test(saveHandler) ||
    !/runVoiceConfirmationBackprop/.test(saveHandler) ||
    /runVoiceConfirmationSaveClosure|spawnSync/.test(saveHandler)
  ) {
    failures.push(
      'voice Save no longer separates durable acceptance from background People File projection',
    );
  }
  const backprop = read('scripts/voice-confirmation-backprop.js') || '';
  const confirmationApply = read('scripts/apply-voice-confirmation-actions.js') || '';
  // The file also has a smaller no-open-job reconciliation step list. Anchor
  // the check inside the exact-job backprop graph instead of relying on source order.
  const durableBackpropStart = backprop.indexOf('const exactVoiceId =');
  const backpropStepsStart = backprop.indexOf('const steps = [', durableBackpropStart);
  const backpropStepsEnd = backprop.indexOf('const results = [];', backpropStepsStart);
  const backpropSteps =
    backpropStepsStart >= 0 && backpropStepsEnd > backpropStepsStart
      ? backprop.slice(backpropStepsStart, backpropStepsEnd)
      : '';
  if (
    !backpropSteps ||
    backpropSteps.indexOf("'speaker_identity_completeness_before_cluster'") <=
      backpropSteps.indexOf("'apply',") ||
    backpropSteps.indexOf("'apply_cluster_resolutions'") <=
      backpropSteps.indexOf("'speaker_identity_completeness_before_cluster'") ||
    !/speaker_identity_completeness_before_cluster[\s\S]*SPEAKER_IDENTITY_CHANGE_HOOK:\s*'0'[\s\S]*apply_cluster_resolutions/.test(
      backpropSteps,
    )
  ) {
    failures.push(
      'durable voice backprop retry no longer repairs orphan identities before cluster/People File projection',
    );
  }
  if (
    !/argValue\('--job-request-id'\)/.test(backprop) ||
    !/openJobStates\(undefined,\s*requestedJobId,/.test(backprop) ||
    !/--force-exact-replay/.test(backprop) ||
    !/--voice-cluster-id/.test(backprop) ||
    !/--request-id/.test(backprop) ||
    !/requested_request_id:\s*requestedRequestId/.test(confirmationApply) ||
    !/row\.gitPeopleSyncRequestId\s*===\s*requestedRequestId/.test(confirmationApply) ||
    !/\['apply',\s*'queue'\]\.includes\(label\)/.test(backprop) ||
    !/'sync_people_exact'/.test(backprop) ||
    !/--person-id/.test(backprop)
  ) {
    failures.push(
      'voice confirmation backprop no longer binds one exact request, voice, and People File projection',
    );
  }
  if (
    !/people_projection_audit/.test(backpropSteps) ||
    backpropSteps.lastIndexOf('people_projection_audit') <= backpropSteps.lastIndexOf("'audio'") ||
    /refresh-briefing-generated-sections|BRIEFING_SCHEDULED_RUN/.test(backprop)
  ) {
    failures.push(
      'durable voice backprop must end in data/audit proof and leave card publication to the exact controller',
    );
  }
  if (
    !/voice-confirmation-jobs\.jsonl/.test(backprop) ||
    !/acquireWorkerLock/.test(backprop) ||
    !/voiceConfirmationJobRequiresGitRelay/.test(backprop) ||
    !/job_status:\s*relayRequired\s*\?\s*'awaiting_git_relay'\s*:\s*'completed'/.test(backprop) ||
    !/(?:job_status:\s*'failed'|appendJobState\([^)]*'failed')/.test(backprop)
  ) {
    failures.push('durable voice backprop no longer records relay-gated or direct job closure');
  }
  const gitPeopleSync = read('scripts/voice-git-people-sync.js') || '';
  if (
    !/voice-confirmation-jobs\.jsonl/.test(gitPeopleSync) ||
    !/job_status:\s*'completed'/.test(gitPeopleSync) ||
    !/status === 'landed'/.test(gitPeopleSync)
  ) {
    failures.push(
      'voice Save job completion no longer waits for the git-authoritative landed receipt',
    );
  }

  return { failures, warnings };
}

function main() {
  const repoRoot = path.resolve(__dirname, '..');
  const { failures, warnings } = checkDrift(repoRoot);
  warnings.forEach((w) => console.warn(`WARN  ${w}`));
  if (failures.length) {
    console.error(
      `\nDRIFT: otter-transcript-pipeline doc is out of sync with code (${failures.length}):`,
    );
    failures.forEach((f) => console.error(`  - ${f}`));
    console.error(
      '\nFix the code or update dev-plans/core/otter-transcript-pipeline.md, then re-run.',
    );
    process.exit(1);
  }
  console.log('OK: otter-transcript-pipeline doc is in sync with the code.');
}

if (require.main === module) main();

module.exports = { checkDrift, STAGE_FILES, MUST_CONTAIN, MUST_NOT_CONTAIN };
