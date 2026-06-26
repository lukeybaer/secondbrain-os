#!/usr/bin/env node
/**
 * Promote unresolved acoustic groups that already match one confirmed
 * reference voiceprint with repeated, consistent acoustic evidence.
 *
 * This is intentionally stricter than the review queue. A group needs a clean
 * confirmed-person match, high purity, and no competing confirmed-person match
 * before it is auto-attached and synced into that person's people file.
 * Text-only/name-only hypotheses do not use this path.
 */

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const SANITY_PATH = path.join(REPO, 'data', 'life-archive', 'voiceprints', 'confirmed-match-sanity-latest.json');
const REGISTRY_PATH = path.join(REPO, 'data', 'life-archive', 'voice-identity-registry.json');
const STATUS_PATH = path.join(REPO, 'data', 'life-archive', 'voiceprints', 'confirmed-acoustic-promotion-latest.json');

function hasArg(name) {
  return process.argv.includes(name);
}

function argNum(name, fallback) {
  const i = process.argv.indexOf(name);
  const n = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(n) ? n : fallback;
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

function dominantPerson(row) {
  const counts = Object.entries(row.person_counts || {}).sort((a, b) => Number(b[1]) - Number(a[1]));
  if (!counts.length) return null;
  const [personId, count] = counts[0];
  const second = counts[1] ? Number(counts[1][1]) : 0;
  return {
    person_id: personId,
    count: Number(count || 0),
    second_count: second,
    consistency: Number(row.match_count || 0) ? Number(count || 0) / Number(row.match_count || 1) : 0,
  };
}

function existingConflict(registry, row, personId) {
  const conflicts = [];
  const acoustic = registry.acoustic_group_resolutions?.[row.acoustic_ExampleCo_id];
  if (acoustic?.person_id && acoustic.person_id !== personId && acoustic.status !== 'left_ExampleCo_by_ExampleCo') {
    conflicts.push({ type: 'acoustic_group', id: row.acoustic_ExampleCo_id, existing: acoustic.person_id });
  }
  for (const ex of row.examples || []) {
    const id = ex.voice_cluster_id;
    const existing = registry.voice_cluster_resolutions?.[id];
    if (existing?.person_id && existing.person_id !== personId && existing.status !== 'left_ExampleCo_by_ExampleCo') {
      conflicts.push({ type: 'voice_cluster', id, existing: existing.person_id });
    }
  }
  return conflicts;
}

function promotionDecision(row, dominant, thresholds) {
  const matchCount = Number(row.match_count || 0);
  const totalTracks = Number(row.total_tracks || 0);
  const purity = Number(row.purity || 0);
  const minScore = Number(row.min_score || 0);
  const minMargin = Number(row.min_margin || 0);

  if (purity < thresholds.minPurity) return { skip: 'below_purity' };
  if (!dominant || dominant.consistency < thresholds.minConsistency || dominant.second_count > 0) {
    return { skip: 'mixed_confirmed_people' };
  }

  if (matchCount >= thresholds.minMatches && minMargin >= thresholds.minMargin) {
    return { rule: 'three_clip_high_purity_confirmed_voiceprint_auto_attach' };
  }

  if (
    matchCount >= thresholds.twoClipMinMatches
    && minScore >= thresholds.twoClipMinScore
    && minMargin >= thresholds.twoClipMinMargin
  ) {
    return { rule: 'two_clip_high_margin_confirmed_voiceprint_auto_attach' };
  }

  if (
    matchCount === 1
    && totalTracks === 1
    && minScore >= thresholds.singleClipMinScore
    && minMargin >= thresholds.singleClipMinMargin
  ) {
    return { rule: 'single_clip_very_high_confidence_confirmed_voiceprint_auto_attach' };
  }

  if (matchCount < thresholds.twoClipMinMatches) return { skip: 'below_matches' };
  return { skip: 'below_strength' };
}

function main() {
  const write = hasArg('--write');
  const minMatches = argNum('--min-matches', 3);
  const minPurity = argNum('--min-purity', 0.8);
  const minConsistency = argNum('--min-confirmed-person-consistency', argNum('--min-name-consistency', 1));
  const minMargin = argNum('--min-margin', 0.1);
  const twoClipMinMatches = argNum('--two-clip-min-matches', 2);
  const twoClipMinScore = argNum('--two-clip-min-score', 0.56);
  const twoClipMinMargin = argNum('--two-clip-min-margin', 0.15);
  const singleClipMinScore = argNum('--single-clip-min-score', 0.70);
  const singleClipMinMargin = argNum('--single-clip-min-margin', 0.20);
  const thresholds = {
    minMatches,
    minPurity,
    minConsistency,
    minMargin,
    twoClipMinMatches,
    twoClipMinScore,
    twoClipMinMargin,
    singleClipMinScore,
    singleClipMinMargin,
  };
  const sanity = readJson(SANITY_PATH, {});
  const registry = readJson(REGISTRY_PATH, {});
  registry.voice_cluster_resolutions ||= {};
  registry.acoustic_group_resolutions ||= {};

  const now = new Date().toISOString();
  const report = {
    schema: 'life_archive.confirmed_acoustic_promotion.v1',
    generated_at: now,
    write,
    thresholds: {
      min_matches: minMatches,
      min_purity: minPurity,
      min_confirmed_person_consistency: minConsistency,
      min_margin: minMargin,
      two_clip_min_matches: twoClipMinMatches,
      two_clip_min_score: twoClipMinScore,
      two_clip_min_margin: twoClipMinMargin,
      single_clip_min_score: singleClipMinScore,
      single_clip_min_margin: singleClipMinMargin,
    },
    candidates_seen: (sanity.suspected_split_groups || []).length,
    promoted_groups: 0,
    promoted_voice_clusters: 0,
    skipped: {
      below_matches: 0,
      below_purity: 0,
      mixed_confirmed_people: 0,
      below_margin: 0,
      below_strength: 0,
      existing_conflict: 0,
    },
    promotions: [],
  };

  for (const row of sanity.suspected_split_groups || []) {
    const dominant = dominantPerson(row);
    const decision = promotionDecision(row, dominant, thresholds);
    if (!decision.rule) {
      report.skipped[decision.skip] = (report.skipped[decision.skip] || 0) + 1;
      continue;
    }
    const conflicts = existingConflict(registry, row, dominant.person_id);
    if (conflicts.length) {
      report.skipped.existing_conflict += 1;
      report.promotions.push({ acoustic_ExampleCo_id: row.acoustic_ExampleCo_id, skipped: 'existing_conflict', conflicts });
      continue;
    }

    const clusterIds = [...new Set((row.examples || []).map((ex) => ex.voice_cluster_id).filter((id) => /^speaker_\d+$/.test(id)))];
    const resolution = {
      status: 'confirmed_reference_voiceprint_match',
      person_id: dominant.person_id,
      display_name: row.suggested_display_name || dominant.person_id,
      acoustic_ExampleCo_id: row.acoustic_ExampleCo_id,
      match_count: row.match_count,
      total_tracks: row.total_tracks,
      purity: row.purity,
      confirmed_person_consistency: dominant.consistency,
      min_score: row.min_score,
      max_score: row.max_score,
      min_margin: row.min_margin,
      max_margin: row.max_margin,
      review_rule: decision.rule,
      promotion_rule: decision.rule,
      auto_people_file_update: true,
      people_file_update_basis: 'known_confirmed_reference_voiceprint_match',
      updated_at: now,
    };
    registry.acoustic_group_resolutions[row.acoustic_ExampleCo_id] = resolution;
    for (const voiceClusterId of clusterIds) {
      registry.voice_cluster_resolutions[voiceClusterId] = {
        ...resolution,
        voice_cluster_id: voiceClusterId,
      };
    }
    report.promoted_groups += 1;
    report.promoted_voice_clusters += clusterIds.length;
    report.promotions.push({
      acoustic_ExampleCo_id: row.acoustic_ExampleCo_id,
      person_id: dominant.person_id,
      display_name: resolution.display_name,
      match_count: row.match_count,
      total_tracks: row.total_tracks,
      purity: row.purity,
      confirmed_person_consistency: dominant.consistency,
      promotion_rule: decision.rule,
      voice_clusters: clusterIds.length,
    });
  }

  if (write) saveJson(REGISTRY_PATH, registry);
  saveJson(STATUS_PATH, report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (require.main === module) main();

module.exports = {
  dominantPerson,
  promotionDecision,
};
