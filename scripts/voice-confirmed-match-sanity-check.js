#!/usr/bin/env node
/**
 * Find unresolved acoustic groups that already contain strong matches to
 * confirmed voiceprints. This catches cases like ExampleCo's own voice being shown
 * as an ExampleCo/context guess because the enriched surface was not refreshed
 * after a reference was banked.
 */

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const ENRICHED_DIR = path.join(REPO, 'data', 'otter', 'enriched');
const REGISTRY_PATH = path.join(REPO, 'data', 'life-archive', 'voice-identity-registry.json');
const OUT_PATH = path.join(REPO, 'data', 'life-archive', 'voiceprints', 'confirmed-match-sanity-latest.json');

function hasArg(name) {
  return process.argv.includes(name);
}

function arg(name, fallback = '') {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
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

function confirmedPeople(registry) {
  const out = new Set();
  for (const [personId, person] of Object.entries(registry.people || {})) {
    const confirmed = String(person.identity_confirmation_status || '').startsWith('confirmed')
      && person.voiceprint_status === 'enrolled';
    if (confirmed) out.add(personId);
  }
  return out;
}

function dateFrom(doc) {
  const raw = doc.start_time || doc.created_at || doc.date;
  const n = Number(raw || 0);
  if (n > 1000000000) return new Date(n > 10000000000 ? n : n * 1000).toISOString().slice(0, 10);
  return String(raw || '').slice(0, 10) || '';
}

function main() {
  const minScore = Number(arg('--min-score', '0.56'));
  const minMargin = Number(arg('--min-margin', '0.06'));
  const write = hasArg('--write');
  const registry = readJson(REGISTRY_PATH, {});
  const confirmed = confirmedPeople(registry);
  const groups = new Map();
  let tracksSeen = 0;
  let unresolvedTracksSeen = 0;
  let strongConfirmedMatches = 0;

  for (const name of fs.existsSync(ENRICHED_DIR) ? fs.readdirSync(ENRICHED_DIR) : []) {
    if (!name.endsWith('.json')) continue;
    const doc = readJson(path.join(ENRICHED_DIR, name), {});
    const date = dateFrom(doc);
    const otid = doc.otid || path.basename(name, '.json');
    for (const [label, track] of Object.entries(doc.speaker_identity_tracks || {})) {
      tracksSeen += 1;
      if (track.person_id) continue;
      unresolvedTracksSeen += 1;
      const acousticId = track.acoustic_ExampleCo_id || '';
      if (!acousticId) continue;
      const baseRow = groups.get(acousticId) || {
        acoustic_ExampleCo_id: acousticId,
        suggested_person_id: '',
        suggested_display_name: '',
        match_count: 0,
        total_tracks: 0,
        max_score: 0,
        min_score: null,
        max_margin: 0,
        min_margin: null,
        person_counts: {},
        calls: new Set(),
        examples: [],
      };
      baseRow.total_tracks += 1;
      groups.set(acousticId, baseRow);
      const match = track.ecapa || track.voice_embedding_match || {};
      const personId = match.person_id || '';
      const score = Number(match.score || 0);
      const margin = Number(match.margin || 0);
      if (!confirmed.has(personId) || score < minScore || margin < minMargin) continue;
      strongConfirmedMatches += 1;
      const row = groups.get(acousticId);
      row.person_counts[personId] = (row.person_counts[personId] || 0) + 1;
      const topPerson = Object.entries(row.person_counts).sort((a, b) => b[1] - a[1])[0]?.[0] || personId;
      if (!row.suggested_person_id || topPerson === personId) {
        row.suggested_person_id = personId;
        row.suggested_display_name = match.display_name || personId;
      }
      row.match_count += 1;
      row.max_score = Math.max(row.max_score, score);
      row.min_score = row.min_score == null ? score : Math.min(row.min_score, score);
      row.max_margin = Math.max(row.max_margin, margin);
      row.min_margin = row.min_margin == null ? margin : Math.min(row.min_margin, margin);
      row.calls.add(otid);
      if (row.examples.length < 8) {
        row.examples.push({
          date,
          title: doc.title || otid,
          otid,
          speaker_model_label: label,
          voice_cluster_id: track.voice_cluster_id || '',
          score,
          margin,
          probe_audio_path: track.probe_audio_path || '',
        });
      }
      groups.set(acousticId, row);
    }
  }

  const suspected_splits = [...groups.values()]
    .filter((row) => row.match_count > 0)
    .map((row) => ({
      ...row,
      calls: row.calls.size,
      purity: row.total_tracks ? row.match_count / row.total_tracks : 0,
    }))
    .sort((a, b) => b.match_count - a.match_count || b.calls - a.calls || b.max_score - a.max_score);

  const report = {
    schema: 'life_archive_voice_confirmed_match_sanity.v1',
    generated_at: new Date().toISOString(),
    thresholds: { min_score: minScore, min_margin: minMargin },
    tracks_seen: tracksSeen,
    unresolved_tracks_seen: unresolvedTracksSeen,
    strong_confirmed_matches: strongConfirmedMatches,
    suspected_split_groups: suspected_splits,
  };
  if (write) saveJson(OUT_PATH, report);
  process.stdout.write(`${JSON.stringify({
    schema: report.schema,
    generated_at: report.generated_at,
    tracks_seen: tracksSeen,
    unresolved_tracks_seen: unresolvedTracksSeen,
    strong_confirmed_matches: strongConfirmedMatches,
    suspected_split_groups: suspected_splits.length,
    top: suspected_splits.slice(0, 10).map((row) => ({
      acoustic_ExampleCo_id: row.acoustic_ExampleCo_id,
      suggested_display_name: row.suggested_display_name,
      match_count: row.match_count,
      calls: row.calls,
      max_score: row.max_score,
      max_margin: row.max_margin,
    })),
  }, null, 2)}\n`);
}

main();
