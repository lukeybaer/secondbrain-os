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
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const ENRICHED_DIR = path.join(REPO, 'data', 'otter', 'enriched');
const STATE_PATH = path.join(REPO, 'data', 'life-archive', 'voiceprints', 'speaker-identity-edge-state.json');
const STATUS_PATH = path.join(REPO, 'data', 'life-archive', 'voiceprints', 'speaker-identity-change-hook-latest.json');
const EVENTS_PATH = path.join(REPO, 'data', 'life-archive', 'people', 'speaker-identity-change-events.jsonl');
const REGISTRY_PATH = path.join(REPO, 'data', 'life-archive', 'voice-identity-registry.json');

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
  if (edge.person_id) return `person:${edge.person_id}`;
  if (edge.acoustic_ExampleCo_id) return `acoustic:${edge.acoustic_ExampleCo_id}`;
  if (edge.ExampleCo_speaker_id) return `ExampleCo:${edge.ExampleCo_speaker_id}`;
  if (edge.voice_cluster_id) return `voice:${edge.voice_cluster_id}`;
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
    acoustic_ExampleCo_id: edge.acoustic_ExampleCo_id || null,
    ExampleCo_speaker_id: edge.ExampleCo_speaker_id || null,
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
    'acoustic_ExampleCo_id',
    'ExampleCo_speaker_id',
  ].some((field) => String(before[field] || '') !== String(after[field] || ''));
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
    for (const [label, track] of Object.entries(tracks)) {
      const segments = (doc.segments || []).filter((segment) => String(segment.speaker_model_label || '') === String(label));
      const edge = {
        key: `${otid}|${label}`,
        otid,
        title: doc.title || otid,
        date: dateFrom(doc),
        source_file: repoRel(file),
        speaker_model_label: String(label),
        person_id: track?.person_id || null,
        resolved_person: track?.resolved_person || null,
        identity_tier: track?.identity_tier || null,
        voice_cluster_id: track?.voice_cluster_id || null,
        acoustic_ExampleCo_id: track?.acoustic_ExampleCo_id || null,
        ExampleCo_speaker_id: track?.ExampleCo_speaker_id || null,
        segment_count: segments.length,
        word_count: segments.reduce((sum, segment) => sum + String(segment.text || '').split(/\s+/).filter(Boolean).length, 0),
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
  fs.appendFileSync(EVENTS_PATH, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8');
}

function runStep(label, args) {
  const result = spawnSync(process.execPath, args, {
    cwd: REPO,
    encoding: 'utf8',
    stdio: 'pipe',
    env: {
      ...process.env,
      SPEAKER_IDENTITY_CHANGE_HOOK: '0',
      SKIP_EC2_PUBLISH: '1',
    },
    timeout: 180000,
  });
  return {
    label,
    args,
    status: result.status,
    ok: result.status === 0,
    stdout_tail: String(result.stdout || '').slice(-1200),
    stderr_tail: String(result.stderr || '').slice(-1200),
  };
}

function syncPeopleFiles() {
  const steps = [
    ['speaker_intelligence_report', ['scripts/otter-speaker-intelligence-report.js', '--write']],
    ['speaker_people_sync', ['scripts/sync-otter-speaker-intelligence-to-people-files.js', '--write']],
    ['voiceprint_people_sync', ['scripts/sync-voiceprints-to-people-files.js', '--write', '--all-contacts', '--json']],
  ];
  const results = [];
  for (const [label, args] of steps) {
    const result = runStep(label, args);
    results.push(result);
    if (!result.ok) break;
  }
  return results;
}

function main() {
  const write = hasArg('--write');
  const sync = hasArg('--sync-people');
  const reason = arg('--reason', process.env.SPEAKER_IDENTITY_CHANGE_REASON || 'unspecified');
  const previous = readJson(STATE_PATH, null);
  const currentEdges = collectEdges();
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
    events_path: repoRel(EVENTS_PATH),
    state_path: repoRel(STATE_PATH),
    sync_results: [],
    sample_events: [],
  };

  if (!previous?.edges) {
    report.initialized = true;
    if (write) {
      saveJson(STATE_PATH, {
        schema: 'life_archive_speaker_identity_edge_state.v1',
        generated_at: generatedAt,
        reason,
        edges: currentEdges,
      });
      saveJson(STATUS_PATH, report);
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  const affected = new Map();
  const events = [];
  const previousEdges = previous.edges || {};
  for (const [key, after] of Object.entries(currentEdges)) {
    const before = previousEdges[key];
    if (!before) {
      report.added_tracks += 1;
      continue;
    }
    if (!edgeChanged(before, after)) continue;
    report.changed_tracks += 1;
    for (const personId of [before.person_id, after.person_id].filter(Boolean)) {
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
    if (before.person_id) affected.set(before.person_id, personMeta(before.person_id));
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
  report.sample_events = events.slice(0, 20);

  if (write) {
    appendEvents(events);
    saveJson(STATE_PATH, {
      schema: 'life_archive_speaker_identity_edge_state.v1',
      generated_at: generatedAt,
      reason,
      edges: currentEdges,
    });
    if (events.length && sync) report.sync_results = syncPeopleFiles();
    saveJson(STATUS_PATH, report);
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main();
