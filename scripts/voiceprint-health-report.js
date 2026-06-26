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
      /^ExampleCo_voice_ecapa_[a-f0-9]+$/i.test(String(row.voiceClusterId || '')) ||
      /^ExampleCo_voice_track_\d+$/i.test(String(row.voiceClusterId || ''))) &&
    /^(confirm|not_them|dont_know|non_speech|correct|link_person_file|create_people_file|add_notes)$/.test(
      String(row.action || ''),
    )
  );
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
  const actions = readJsonl(path.join(PEOPLE_DIR, 'voice-confirmation-actions.jsonl')).filter(
    reviewableAction,
  );
  const apply = readJson(path.join(PEOPLE_DIR, 'voice-confirmation-apply-latest.json'), {});

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
