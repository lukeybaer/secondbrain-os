#!/usr/bin/env node
'use strict';

/**
 * Build the formal voiceprint health proof consumed by briefing System Health.
 */

const fs = require('node:fs');
const path = require('node:path');
const { computeSpeakerFreshness } = require('./lib/speaker-freshness');

const ROOT = path.resolve(process.env.SECONDBRAIN_ROOT || path.join(__dirname, '..'));
const DATA_DIR = path.resolve(process.env.SECONDBRAIN_DATA_DIR || path.join(ROOT, 'data'));
const VP_DIR = path.join(DATA_DIR, 'life-archive', 'voiceprints');
const PEOPLE_DIR = path.join(DATA_DIR, 'life-archive', 'people');
const REGISTRY_PATH = path.join(DATA_DIR, 'life-archive', 'voice-identity-registry.json');
const OUT = path.join(VP_DIR, 'voiceprint-health-latest.json');
const HISTORY = path.join(VP_DIR, 'voiceprint-health-history.jsonl');

function hasArg(name) {
  return process.argv.includes(name);
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

function readJsonl(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function saveJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function saveHealthReport(report, options = {}) {
  const outPath = options.outPath || OUT;
  const historyPath = options.historyPath || HISTORY;
  const warn = options.warn !== false;
  saveJson(outPath, report);

  let historyWarning = null;
  try {
    fs.mkdirSync(path.dirname(historyPath), { recursive: true });
    fs.appendFileSync(historyPath, `${JSON.stringify(report)}\n`, 'utf8');
  } catch (error) {
    historyWarning = String((error && error.message) || error).slice(0, 240);
    if (warn) {
      process.stderr.write(
        `[voiceprint-health-report] latest proof written; history append failed: ${historyWarning}\n`,
      );
    }
  }

  return { outPath, historyPath, historyWarning };
}

function reviewableAction(row) {
  return (
    (/^speaker_\d+$/.test(String(row.voiceClusterId || '')) ||
      /^unknown_voice_ecapa_[a-f0-9]+$/i.test(String(row.voiceClusterId || '')) ||
      /^unknown_voice_track_\d+$/i.test(String(row.voiceClusterId || ''))) &&
    /^(confirm|not_them|dont_know|non_speech|correct|link_person_file|create_people_file|add_notes)$/.test(
      String(row.action || ''),
    )
  );
}

function timeMs(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function confirmationApplyChanged(apply) {
  return [
    'applied_confirmations',
    'applied_corrections',
    'applied_denials',
    'applied_people_links',
    'applied_people_notes',
    'people_files_created',
    'marked_unknown',
    'marked_non_speech',
    'enrollments_created',
    'corrected_enrollments_retargeted',
    'corrected_people_retired',
  ].some((field) => Number(apply?.[field] || 0) > 0);
}

function buildHealth(options = {}) {
  const generatedAt = options.generatedAt || new Date().toISOString();
  const registry = readJson(REGISTRY_PATH, { people: {}, enrollments: [] });
  const identity = readJson(
    path.join(VP_DIR, 'otter-speaker-identity-completeness-latest.json'),
    {},
  );
  const roster = readJson(path.join(VP_DIR, 'voice-discovery-roster-latest.json'), {});
  const queue = readJson(path.join(PEOPLE_DIR, 'briefing-voice-queue-latest.json'), {});
  const pareto = readJson(path.join(VP_DIR, 'speaker-pareto-latest.json'), {});
  const resolver = readJson(path.join(VP_DIR, 'ecapa-speaker-resolver-latest.json'), {});
  const peopleProjection = Object.prototype.hasOwnProperty.call(options, 'peopleProjection')
    ? options.peopleProjection
    : readJson(path.join(VP_DIR, 'voice-people-file-projection-audit-latest.json'), null);
  const actions = readJsonl(path.join(PEOPLE_DIR, 'voice-confirmation-actions.jsonl')).filter(
    reviewableAction,
  );
  const apply = readJson(path.join(PEOPLE_DIR, 'voice-confirmation-apply-latest.json'), {});
  const relayRequests = readJsonl(
    path.join(PEOPLE_DIR, 'voice-git-people-sync-requests.jsonl'),
  );
  const relayReceipts = readJsonl(
    path.join(PEOPLE_DIR, 'voice-git-people-sync-receipts.jsonl'),
  );
  const identityChangeHook = Object.prototype.hasOwnProperty.call(options, 'identityChangeHook')
    ? options.identityChangeHook
    : readJson(path.join(VP_DIR, 'speaker-identity-change-hook-latest.json'), {});
  const confirmationBackprop = Object.prototype.hasOwnProperty.call(options, 'confirmationBackprop')
    ? options.confirmationBackprop
    : readJson(path.join(VP_DIR, 'voice-confirmation-backprop-latest.json'), {});

  const segmentsSeen = Number(identity.segments_seen || identity.total_segments || 0);
  const segmentsWithIdentity = Number(
    identity.segments_with_identity ||
      identity.segments_with_identity_after ||
      identity.segments_with_identity_before ||
      0,
  );
  const completePercent = segmentsSeen
    ? Math.round((segmentsWithIdentity / segmentsSeen) * 1000) / 10
    : 0;
  const rosterRows = Array.isArray(roster.roster) ? roster.roster.length : 0;
  const actionsSeen = Number(apply.actions_seen || 0);
  const unapplied = Math.max(0, actions.length - actionsSeen);
  const problems = [];
  if (!segmentsSeen || segmentsWithIdentity < segmentsSeen || completePercent < 99.9) {
    problems.push(
      `identity completeness ${segmentsWithIdentity}/${segmentsSeen} (${completePercent}%)`,
    );
  }
  if (rosterRows === 0) problems.push('voice discovery roster empty');
  if (unapplied > 0)
    problems.push(`${unapplied} reviewable confirmation action(s) not covered by apply proof`);
  if (!peopleProjection) {
    problems.push('confirmed voice identity to People File projection audit missing');
  } else if (!/^green$/i.test(String(peopleProjection.status || ''))) {
    problems.push(
      `${Number(peopleProjection.missing_or_stale_people_file_projections || 0)} confirmed voice identity People File projection(s) missing or stale`,
    );
  }
  const generatedAtMs = timeMs(generatedAt);
  const projectionAuditAtMs = timeMs(peopleProjection?.generated_at);
  if (
    peopleProjection &&
    (!projectionAuditAtMs ||
      (generatedAtMs && generatedAtMs - projectionAuditAtMs > 36 * 60 * 60 * 1000))
  ) {
    problems.push('confirmed voice identity to People File projection audit is stale');
  }
  const mutationProofs = [];
  if (confirmationApplyChanged(apply) && timeMs(apply.generated_at)) {
    mutationProofs.push({
      source: 'voice confirmation apply',
      generated_at: apply.generated_at,
    });
  }
  if (
    identityChangeHook?.people_projection_required &&
    timeMs(identityChangeHook.generated_at)
  ) {
    mutationProofs.push({
      source: 'speaker identity change hook',
      generated_at: identityChangeHook.generated_at,
    });
  }
  if (
    (confirmationBackprop?.ok === false ||
      confirmationBackprop?.ok == null ||
      /^(?:running|failed)(?:_|$)/.test(String(confirmationBackprop?.phase || ''))) &&
    timeMs(confirmationBackprop.generated_at)
  ) {
    mutationProofs.push({
      source: 'voice confirmation backprop',
      generated_at: confirmationBackprop.generated_at,
    });
  }
  const latestRelayStateAt = [...relayRequests, ...relayReceipts]
    .map((row) => row.updated_at || row.ready_at || row.requested_at || row.ts || '')
    .filter((value) => timeMs(value))
    .sort((left, right) => timeMs(right) - timeMs(left))[0] || '';
  if (latestRelayStateAt) {
    mutationProofs.push({
      source: 'People File git relay',
      generated_at: latestRelayStateAt,
    });
  }
  const latestMutation = mutationProofs.sort(
    (left, right) => timeMs(right.generated_at) - timeMs(left.generated_at),
  )[0];
  if (
    latestMutation &&
    (!projectionAuditAtMs || projectionAuditAtMs < timeMs(latestMutation.generated_at))
  ) {
    problems.push(
      `People File projection audit predates the latest voice identity mutation (${latestMutation.source})`,
    );
  }
  if (
    identityChangeHook?.ok === false &&
    timeMs(identityChangeHook.generated_at) >= projectionAuditAtMs
  ) {
    problems.push('speaker identity change People File reconciliation failed');
  }
  if (
    confirmationBackprop?.ok === false &&
    timeMs(confirmationBackprop.generated_at) >= projectionAuditAtMs
  ) {
    problems.push('voice confirmation backprop failed after the latest People File audit');
  }
  // Speaker enrichment freshness (ExampleCo 2026-06-20): the same shared rule the
  // briefing speaker card uses. A roster frozen > 4 days behind (or empty) means
  // speaker data cannot be trusted, so system health must go RED too -- a frozen
  // card must never read clean while health stays green.
  const speakerFreshness = computeSpeakerFreshness({ pareto, today: options.today });
  if (speakerFreshness.status === 'blocker') {
    problems.push(
      speakerFreshness.reason === 'empty_or_missing'
        ? 'speaker roster empty/missing; cloud enrichment has not produced a processed archive day'
        : `speaker enrichment ${speakerFreshness.lagDays} days behind (latest processed day ${speakerFreshness.lastArchiveDay}); cloud enrichment/backfill has not advanced it`,
    );
  }
  if (Number(queue.total_candidate_voiceprints || queue.candidate_voiceprints || 0) > 0) {
    problems.push(
      `${Number(queue.total_candidate_voiceprints || queue.candidate_voiceprints)} candidate voiceprint(s) awaiting briefing review`,
    );
  }

  const report = {
    schema: 'life_archive_voiceprint_health.v2',
    generated_at: generatedAt,
    status: problems.length ? 'RED' : 'GREEN',
    problems,
    enrolled_voiceprints: Array.isArray(registry.enrollments) ? registry.enrollments.length : 0,
    confirmed_voiceprints: Array.isArray(registry.enrollments)
      ? registry.enrollments.filter((row) => !row.quarantined_at).length
      : 0,
    confirmed_people: Object.keys(registry.people || {}).length,
    enriched_transcripts: identity.files_seen || resolver.enriched_files_updated || 0,
    total_otter_targets: segmentsSeen,
    processed_targets: segmentsWithIdentity,
    error_targets: Number(resolver.errors?.length || 0),
    complete_percent: completePercent,
    segments_seen: segmentsSeen,
    segments_with_identity: segmentsWithIdentity,
    roster_rows: rosterRows,
    roster_generated_at: roster.generated_at || '',
    confirmation_actions_seen: actions.length,
    confirmation_actions_covered_by_apply: actionsSeen,
    confirmed_named_voice_identities: Number(
      peopleProjection?.confirmed_named_voice_identities || 0,
    ),
    active_named_voiceprint_observations: Number(
      peopleProjection?.active_named_voiceprint_observations || 0,
    ),
    people_file_projections_expected: Number(peopleProjection?.expected_people_files || 0),
    people_file_projections_current: Number(
      peopleProjection?.current_people_file_projections || 0,
    ),
    people_file_projection_events: Number(peopleProjection?.projection_run_events || 0),
    people_file_writes_observed: Number(peopleProjection?.people_file_writes_observed || 0),
    distinct_people_files_written_observed: Number(
      peopleProjection?.distinct_people_files_written_observed || 0,
    ),
    people_file_projection_audit_status: peopleProjection?.status || 'MISSING',
    people_file_projection_audit_generated_at: peopleProjection?.generated_at || '',
    latest_voice_identity_mutation_source: latestMutation?.source || '',
    latest_voice_identity_mutation_at: latestMutation?.generated_at || '',
    speaker_identity_change_hook_status:
      identityChangeHook?.ok === true ? 'GREEN' : identityChangeHook?.ok === false ? 'RED' : 'UNKNOWN',
    speaker_identity_change_hook_generated_at: identityChangeHook?.generated_at || '',
    voice_confirmation_backprop_status:
      confirmationBackprop?.ok === true
        ? 'GREEN'
        : confirmationBackprop?.ok === false
          ? 'RED'
          : 'UNKNOWN',
    voice_confirmation_backprop_generated_at: confirmationBackprop?.generated_at || '',
    latest_people_file_relay_state_at: latestRelayStateAt,
    briefing_voice_queue_generated_at: queue.generated_at || '',
    briefing_voice_queue_candidates: Number(
      queue.total_candidate_voiceprints || queue.candidate_voiceprints || 0,
    ),
    pareto_generated_at: pareto.generated_at || '',
    speaker_last_archive_day: speakerFreshness.lastArchiveDay,
    speaker_enrichment_lag_days: speakerFreshness.lagDays,
    speaker_freshness_status: speakerFreshness.status,
    recurring_unnamed_relationship_count: Array.isArray(pareto.recurring_unnamed_relationships)
      ? pareto.recurring_unnamed_relationships.length
      : Number(pareto.recurring_unnamed_relationship_count || 0),
  };
  return report;
}

if (require.main === module) {
  const report = buildHealth();
  if (hasArg('--write')) {
    saveHealthReport(report);
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

module.exports = { buildHealth, saveHealthReport };
