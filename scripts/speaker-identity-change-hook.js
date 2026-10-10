#!/usr/bin/env node
/**
 * Central hook for Otter speaker/person relabels.
 *
 * This is intentionally a post-write diff, not a pile of callbacks inside
 * every relabeling cause. Any writer that changes `speaker_identity_tracks`
 * or segment `resolved_speaker` can call this once after saving. The hook then
 * detects which per-call speaker tracks moved identities and, only when that
 * happened, triggers people-file correction/sync.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { COMPLETENESS_REASON } = require('./lib/run-speaker-identity-change-hook');

const REPO = path.resolve(__dirname, '..');
const DATA_ROOT = path.resolve(process.env.SECONDBRAIN_DATA_DIR || path.join(REPO, 'data'));
const ENRICHED_DIR = path.join(DATA_ROOT, 'otter', 'enriched');
const STATE_PATH = path.join(
  DATA_ROOT,
  'life-archive',
  'voiceprints',
  'speaker-identity-edge-state.json',
);
const STATUS_PATH = path.join(
  DATA_ROOT,
  'life-archive',
  'voiceprints',
  'speaker-identity-change-hook-latest.json',
);
const EVENTS_PATH = path.join(
  DATA_ROOT,
  'life-archive',
  'people',
  'speaker-identity-change-events.jsonl',
);
const REGISTRY_PATH = path.join(DATA_ROOT, 'life-archive', 'voice-identity-registry.json');

function arg(name, fallback = '') {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

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

function saveJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function repoRel(file) {
  return path.relative(REPO, file).replace(/\\/g, '/');
}

function dateFrom(doc) {
  const v = doc.start_time || doc.created_at || doc.date || '';
  const n = Number(v);
  if (n > 1000000000) return new Date(n * 1000).toISOString().slice(0, 10);
  const parsed = new Date(String(v));
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

function identityKey(edge) {
  if (Array.isArray(edge.segment_identity_keys) && edge.segment_identity_keys.length) {
    return `segments:${edge.segment_identity_keys.join('|')}`;
  }
  if (edge.person_id) return `person:${edge.person_id}`;
  if (edge.acoustic_unknown_id) return `acoustic:${edge.acoustic_unknown_id}`;
  if (edge.unknown_speaker_id) return `unknown:${edge.unknown_speaker_id}`;
  if (edge.voice_cluster_id) return `voice:${edge.voice_cluster_id}`;
  return 'missing';
}

function resolvedIdentityKey(resolved = {}) {
  if (resolved.person_id) return `person:${resolved.person_id}`;
  if (resolved.acoustic_unknown_id) return `acoustic:${resolved.acoustic_unknown_id}`;
  if (resolved.unknown_speaker_id) return `unknown:${resolved.unknown_speaker_id}`;
  if (resolved.voice_cluster_id) return `voice:${resolved.voice_cluster_id}`;
  return 'missing';
}

function compactEdge(edge) {
  if (!edge) return null;
  return {
    key: edge.key,
    otid: edge.otid,
    title: edge.title,
    date: edge.date,
    speaker_model_label: edge.speaker_model_label,
    identity_key: edge.identity_key,
    person_id: edge.person_id || null,
    resolved_person: edge.resolved_person || null,
    identity_tier: edge.identity_tier || null,
    voice_cluster_id: edge.voice_cluster_id || null,
    acoustic_unknown_id: edge.acoustic_unknown_id || null,
    unknown_speaker_id: edge.unknown_speaker_id || null,
    segment_person_ids: edge.segment_person_ids || [],
    segment_identity_keys: edge.segment_identity_keys || [],
    content_fingerprint: edge.content_fingerprint || '',
    segment_count: edge.segment_count || 0,
    word_count: edge.word_count || 0,
  };
}

function edgeChanged(before, after) {
  if (!before || !after) return true;
  return [
    'identity_key',
    'person_id',
    'resolved_person',
    'identity_tier',
    'voice_cluster_id',
    'acoustic_unknown_id',
    'unknown_speaker_id',
    'segment_person_ids',
    'segment_identity_keys',
    'content_fingerprint',
    'segment_count',
    'word_count',
  ].some((field) => JSON.stringify(before[field] || '') !== JSON.stringify(after[field] || ''));
}

function personIdsForEdge(edge) {
  return [
    ...new Set(
      [
        edge?.person_id,
        ...(Array.isArray(edge?.segment_person_ids) ? edge.segment_person_ids : []),
      ].filter(Boolean),
    ),
  ];
}

function collectEdges() {
  const edges = {};
  if (!fs.existsSync(ENRICHED_DIR)) return edges;
  for (const name of fs.readdirSync(ENRICHED_DIR).filter((n) => n.endsWith('.json'))) {
    const file = path.join(ENRICHED_DIR, name);
    const doc = readJson(file, null);
    if (!doc) continue;
    const otid = String(doc.otid || path.basename(name, '.json'));
    const tracks = doc.speaker_identity_tracks || {};
    const labels = new Set([
      ...Object.keys(tracks),
      ...(doc.segments || [])
        .map((segment) => String(segment.speaker_model_label || ''))
        .filter(Boolean),
    ]);
    for (const label of labels) {
      const track = tracks[label] || {};
      const segments = (doc.segments || []).filter(
        (segment) => String(segment.speaker_model_label || '') === String(label),
      );
      const segmentPersonIds = [
        ...new Set(
          segments
            .map((segment) => segment.resolved_speaker?.person_id)
            .filter(Boolean)
            .map(String),
        ),
      ].sort();
      const segmentIdentityKeys = [
        ...new Set(segments.map((segment) => resolvedIdentityKey(segment.resolved_speaker || {}))),
      ].sort();
      const contentFingerprint = crypto
        .createHash('sha256')
        .update(
          JSON.stringify(
            segments.map((segment) => [
              segment.start ?? segment.start_time ?? null,
              segment.end ?? segment.end_time ?? null,
              String(segment.text || ''),
              resolvedIdentityKey(segment.resolved_speaker || {}),
            ]),
          ),
        )
        .digest('hex');
      const edge = {
        key: `${otid}|${label}`,
        otid,
        title: doc.title || otid,
        date: dateFrom(doc),
        source_file: repoRel(file),
        speaker_model_label: String(label),
        person_id: track.person_id || (segmentPersonIds.length === 1 ? segmentPersonIds[0] : null),
        resolved_person:
          track.resolved_person ||
          segments.find((segment) => segment.resolved_speaker?.resolved_person)?.resolved_speaker
            ?.resolved_person ||
          null,
        identity_tier: track.identity_tier || null,
        voice_cluster_id: track.voice_cluster_id || null,
        acoustic_unknown_id: track.acoustic_unknown_id || null,
        unknown_speaker_id: track.unknown_speaker_id || null,
        segment_person_ids: segmentPersonIds,
        segment_identity_keys: segmentIdentityKeys,
        content_fingerprint: contentFingerprint,
        segment_count: segments.length,
        word_count: segments.reduce(
          (sum, segment) =>
            sum +
            String(segment.text || '')
              .split(/\s+/)
              .filter(Boolean).length,
          0,
        ),
      };
      edge.identity_key = identityKey(edge);
      edges[edge.key] = edge;
    }
  }
  return edges;
}

function personMeta(personId) {
  if (!personId) return null;
  const registry = readJson(REGISTRY_PATH, {});
  const person = registry.people?.[personId] || {};
  return {
    person_id: personId,
    display_name: person.display_name || personId,
    contact_file: person.contact_file || null,
  };
}

function appendEvents(events) {
  if (!events.length) return;
  fs.mkdirSync(path.dirname(EVENTS_PATH), { recursive: true });
  fs.appendFileSync(
    EVENTS_PATH,
    `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
    'utf8',
  );
}

function projectionStepTimeoutMs(env = process.env) {
  const configured = Number(env.OTTER_PEOPLE_FILE_PROJECTION_STEP_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0
    ? Math.max(60_000, configured)
    : 15 * 60 * 1000;
}

// The speaker-intelligence report walks the whole enriched archive and ran out of memory at
// Node's default heap on EC2 (2026-09-23): the resolver refresh only passed when a human reran it
// with an 8 GB heap. It also inherits a caller's small NODE_OPTIONS heap (the Otter healer runs
// projection at 384 MB), so give that child an explicit bounded heap that REPLACES any inherited
// limit. Sized for the 16 GB host; OTTER_SPEAKER_INTELLIGENCE_HEAP_MB overrides it.
const HEAP_BOUNDED_STEPS = new Set(['speaker_intelligence_report']);
const DEFAULT_SPEAKER_INTELLIGENCE_HEAP_MB = 6144;

function speakerIntelligenceHeapMb(env = process.env) {
  const configured = Number(env.OTTER_SPEAKER_INTELLIGENCE_HEAP_MB);
  return Number.isFinite(configured) && configured > 0
    ? Math.max(512, Math.round(configured))
    : DEFAULT_SPEAKER_INTELLIGENCE_HEAP_MB;
}

function nodeOptionsWithHeap(existing, heapMb) {
  const kept = String(existing || '')
    .split(/\s+/)
    .filter((token) => token && !/^--max-old-space-size(?:=|$)/.test(token));
  return [...kept, `--max-old-space-size=${heapMb}`].join(' ');
}

function stepEnv(label, env = process.env) {
  return {
    ...env,
    SPEAKER_IDENTITY_CHANGE_HOOK: '0',
    SKIP_EC2_PUBLISH: '1',
    ...(HEAP_BOUNDED_STEPS.has(label)
      ? { NODE_OPTIONS: nodeOptionsWithHeap(env.NODE_OPTIONS, speakerIntelligenceHeapMb(env)) }
      : {}),
  };
}

function runStep(label, args, { spawnSyncFn = spawnSync, env = process.env } = {}) {
  const timeoutMs = projectionStepTimeoutMs(env);
  const result = spawnSyncFn(process.execPath, args, {
    cwd: REPO,
    encoding: 'utf8',
    stdio: 'pipe',
    env: stepEnv(label, env),
    timeout: timeoutMs,
  });
  return {
    label,
    args,
    status: result.status,
    ok: result.status === 0,
    timeout_ms: timeoutMs,
    stdout_tail: String(result.stdout || '').slice(-1200),
    stderr_tail: String(result.stderr || '').slice(-1200),
  };
}

function syncPeopleFiles(options = {}) {
  const steps = [
    ['speaker_intelligence_report', ['scripts/otter-speaker-intelligence-report.js', '--write']],
    [
      'speaker_people_sync',
      ['scripts/sync-otter-speaker-intelligence-to-people-files.js', '--write'],
    ],
    [
      'voiceprint_people_sync',
      ['scripts/sync-voiceprints-to-people-files.js', '--write', '--all-contacts', '--json'],
    ],
    // Gate on projection reconciliation only: a Git relay backlog is reported by the audit
    // itself and must not stop the resolver chain that invoked this hook (2026-09-30).
    [
      'people_projection_audit',
      ['scripts/voice-people-file-projection-audit.js', '--write', '--projection-gate'],
    ],
  ];
  const results = [];
  for (const [label, args] of steps) {
    const result = runStep(label, args, options);
    results.push(result);
    if (!result.ok) break;
  }
  return results;
}

function syncStepsOk(results) {
  return (results || []).every((result) => result?.ok);
}

function normalizeSpeakerIdentities() {
  return runStep('speaker_identity_completeness', [
    'scripts/otter-speaker-identity-completeness.js',
    '--write',
  ]);
}

function normalizedUpstreamForHook(reason, env = process.env) {
  return (
    reason === COMPLETENESS_REASON && env.SPEAKER_IDENTITY_NORMALIZED_UPSTREAM === '1'
  );
}

function prepareCurrentEdges({
  write,
  normalizedUpstream = false,
  normalizeFn = normalizeSpeakerIdentities,
  collectFn = collectEdges,
} = {}) {
  const normalizationResult = !write
    ? null
    : normalizedUpstream
      ? { ok: true, skipped: true, reason: 'normalized-upstream' }
      : normalizeFn();
  return {
    normalizationResult,
    currentEdges:
      normalizationResult && !normalizationResult.ok
        ? null
        : collectFn(),
  };
}

function main() {
  const write = hasArg('--write');
  const sync = hasArg('--sync-people');
  const reason = arg('--reason', process.env.SPEAKER_IDENTITY_CHANGE_REASON || 'unspecified');
  const previous = readJson(STATE_PATH, null);
  const prepared = prepareCurrentEdges({
    write,
    normalizedUpstream: normalizedUpstreamForHook(reason),
  });
  const normalizationResult = prepared.normalizationResult;
  const currentEdges = prepared.currentEdges || {};
  const generatedAt = new Date().toISOString();
  const report = {
    schema: 'life_archive_speaker_identity_change_hook.v1',
    generated_at: generatedAt,
    reason,
    wrote: write,
    sync_people_requested: sync,
    initialized: false,
    previous_edges: previous?.edges ? Object.keys(previous.edges).length : 0,
    current_edges: Object.keys(currentEdges).length,
    changed_tracks: 0,
    added_tracks: 0,
    removed_tracks: 0,
    affected_people: [],
    people_projection_required: false,
    normalization_result: normalizationResult,
    events_path: repoRel(EVENTS_PATH),
    state_path: repoRel(STATE_PATH),
    sync_results: [],
    state_advanced: false,
    ok: true,
    sample_events: [],
  };

  if (normalizationResult && !normalizationResult.ok) {
    report.ok = false;
    if (write) saveJson(STATUS_PATH, report);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report;
  }

  if (!previous?.edges) {
    report.initialized = true;
    report.people_projection_required = Object.values(currentEdges).some(
      (edge) => personIdsForEdge(edge).length > 0,
    );
    if (write) {
      if (sync && report.people_projection_required) report.sync_results = syncPeopleFiles();
      report.ok = !report.people_projection_required || (sync && syncStepsOk(report.sync_results));
      if (report.ok) {
        saveJson(STATE_PATH, {
          schema: 'life_archive_speaker_identity_edge_state.v1',
          generated_at: generatedAt,
          reason,
          edges: currentEdges,
        });
        report.state_advanced = true;
      }
      saveJson(STATUS_PATH, report);
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report;
  }

  const affected = new Map();
  const events = [];
  const previousEdges = previous.edges || {};
  for (const [key, after] of Object.entries(currentEdges)) {
    const before = previousEdges[key];
    if (!before) {
      report.added_tracks += 1;
      for (const personId of personIdsForEdge(after)) {
        affected.set(personId, personMeta(personId));
      }
      events.push({
        schema: 'life_archive_speaker_identity_change_event.v1',
        ts: generatedAt,
        reason,
        event_type: 'speaker_track_added',
        track_key: key,
        before: null,
        after: compactEdge(after),
      });
      continue;
    }
    if (!edgeChanged(before, after)) continue;
    report.changed_tracks += 1;
    for (const personId of [...personIdsForEdge(before), ...personIdsForEdge(after)]) {
      affected.set(personId, personMeta(personId));
    }
    events.push({
      schema: 'life_archive_speaker_identity_change_event.v1',
      ts: generatedAt,
      reason,
      event_type: 'speaker_track_identity_changed',
      track_key: key,
      before: compactEdge(before),
      after: compactEdge(after),
    });
  }
  for (const [key, before] of Object.entries(previousEdges)) {
    if (currentEdges[key]) continue;
    report.removed_tracks += 1;
    for (const personId of personIdsForEdge(before)) {
      affected.set(personId, personMeta(personId));
    }
    events.push({
      schema: 'life_archive_speaker_identity_change_event.v1',
      ts: generatedAt,
      reason,
      event_type: 'speaker_track_removed',
      track_key: key,
      before: compactEdge(before),
      after: null,
    });
  }

  report.affected_people = [...affected.values()].filter(Boolean);
  report.people_projection_required = affected.size > 0;
  report.sample_events = events.slice(0, 20);

  if (write) {
    if (events.length && sync && report.people_projection_required) {
      report.sync_results = syncPeopleFiles();
    }
    report.ok =
      !events.length ||
      !report.people_projection_required ||
      (sync && syncStepsOk(report.sync_results));
    // Never consume the edge diff when People File reconciliation failed.
    // The unchanged state makes the next invocation retry the same move or
    // unassignment instead of silently declaring the chain complete.
    if (report.ok) {
      appendEvents(events);
      saveJson(STATE_PATH, {
        schema: 'life_archive_speaker_identity_edge_state.v1',
        generated_at: generatedAt,
        reason,
        edges: currentEdges,
      });
      report.state_advanced = true;
    }
    saveJson(STATUS_PATH, report);
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (require.main === module) {
  const report = main();
  process.exitCode = report.ok ? 0 : 1;
}

module.exports = {
  collectEdges,
  edgeChanged,
  personIdsForEdge,
  syncPeopleFiles,
  syncStepsOk,
  normalizeSpeakerIdentities,
  prepareCurrentEdges,
  normalizedUpstreamForHook,
  projectionStepTimeoutMs,
  speakerIntelligenceHeapMb,
  nodeOptionsWithHeap,
  main,
};
