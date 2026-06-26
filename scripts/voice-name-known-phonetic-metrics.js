#!/usr/bin/env node
/*
 * Summarize whether the heard-name judge can recover confirmed speakers'
 * names phonetically without using those names inside the prompt.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const VP_DIR = path.join(ROOT, 'data', 'life-archive', 'voiceprints');
const REGISTRY_PATH = path.join(ROOT, 'data', 'life-archive', 'voice-identity-registry.json');
const JUDGE_DIR = path.join(VP_DIR, 'llm-name-judges');
const OUT_PATH = path.join(VP_DIR, 'known-name-phonetic-metrics-latest.json');

function arg(name, fallback = '') {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

function hasArg(name) {
  return process.argv.includes(name);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function knownPeople() {
  const registry = readJson(REGISTRY_PATH, {});
  return Object.entries(registry.people || {})
    .filter(([, person]) => (
      String(person?.identity_confirmation_status || '').startsWith('confirmed')
      && person?.voiceprint_status === 'enrolled'
      && Number(person?.voiceprint_enrollments || 0) > 0
    ))
    .map(([personId, person]) => ({
      person_id: personId,
      display_name: person.display_name || personId.replace(/_/g, ' '),
      voiceprint_enrollments: Number(person.voiceprint_enrollments || 0),
    }))
    .sort((a, b) => a.display_name.localeCompare(b.display_name));
}

function belongsToPerson(calibrationRow, personId) {
  const target = String(calibrationRow?.target || '');
  return target === personId
    || target.startsWith(`${personId}#`)
    || target.startsWith(`${personId}_enrollment`)
    || target.startsWith(`${personId}__`);
}

function effectiveOutcome(row) {
  if (!row) return 'missing';
  if (!row.pass) return row.outcome || 'failed';
  const direct = Number(row.direct_name_evidence_count || 0);
  const independent = Number(row.independent_evidence_windows || 0);
  const selfIntro = Number(row.self_intro_evidence_count || 0);
  const counter = Number(row.counterevidence_count || 0);
  if (counter > 0 && (selfIntro > 0 || independent >= 2)) return 'clean_success_with_split_warning';
  if (counter > 0) return 'correct_but_conflicted';
  if (selfIntro > 0 || independent >= 2) return 'clean_success';
  if (direct > 0) return 'correct_but_weak';
  return row.outcome || 'correct_but_weak';
}

function candidateScore(row) {
  if (!row) return -1;
  const outcome = effectiveOutcome(row);
  let score = 0;
  if (row.pass) score += 100000;
  if (outcome === 'clean_success') score += 500;
  if (outcome === 'clean_success_with_split_warning') score += 400;
  if (outcome === 'correct_but_weak') score += 100;
  score += Number(row.independent_evidence_windows || 0) * 1000;
  score += Number(row.direct_name_evidence_count || 0) * 20;
  score -= Number(row.counterevidence_count || 0) * 3;
  return score;
}

function loadCalibrationRows(personId) {
  if (!fs.existsSync(JUDGE_DIR)) return [];
  const rows = [];
  for (const name of fs.readdirSync(JUDGE_DIR)) {
    if (!name.startsWith('name-judge-') || !name.endsWith('.json')) continue;
    if (!name.includes(personId)) continue;
    const data = readJson(path.join(JUDGE_DIR, name), {});
    for (const row of data.calibration || []) {
      if (!belongsToPerson(row, personId)) continue;
      rows.push({
        ...row,
        file: path.relative(ROOT, path.join(JUDGE_DIR, name)).replace(/\\/g, '/'),
        generated_at: data.generated_at || '',
        effective_outcome: effectiveOutcome(row),
      });
    }
  }
  return rows.sort((a, b) => (
    candidateScore(b) - candidateScore(a)
    || String(b.generated_at).localeCompare(String(a.generated_at))
  ));
}

function main() {
  const targetFilter = new Set(
    arg('--targets', '')
      .split(/[,;]/)
      .map((value) => value.trim())
      .filter(Boolean)
  );
  const people = knownPeople().filter((person) => !targetFilter.size || targetFilter.has(person.person_id));
  const rows = people.map((person) => {
    const candidates = loadCalibrationRows(person.person_id);
    const best = candidates[0] || null;
    return {
      person_id: person.person_id,
      display_name: person.display_name,
      voiceprint_enrollments: person.voiceprint_enrollments,
      expected: best?.expected || person.display_name,
      heard_name: best?.actual || null,
      phonetic_pass: Boolean(best?.pass),
      effective_outcome: best ? effectiveOutcome(best) : 'missing',
      direct_name_evidence_count: Number(best?.direct_name_evidence_count || 0),
      independent_evidence_windows: Number(best?.independent_evidence_windows || 0),
      counterevidence_count: Number(best?.counterevidence_count || 0),
      source_file: best?.file || null,
      generated_at: best?.generated_at || null,
      candidate_rows_seen: candidates.length,
    };
  });
  const summary = {
    schema: 'life_archive.known_name_phonetic_metrics.v1',
    generated_at: new Date().toISOString(),
    known_people: rows.length,
    phonetic_pass: rows.filter((row) => row.phonetic_pass).length,
    fail: rows.filter((row) => !row.phonetic_pass).length,
    clean_success: rows.filter((row) => row.effective_outcome === 'clean_success').length,
    clean_success_with_split_warning: rows.filter((row) => row.effective_outcome === 'clean_success_with_split_warning').length,
    weak: rows.filter((row) => row.effective_outcome === 'correct_but_weak').length,
    conflicted: rows.filter((row) => row.effective_outcome === 'correct_but_conflicted').length,
    missing: rows.filter((row) => row.effective_outcome === 'missing').length,
    rows,
  };
  if (hasArg('--write')) {
    fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
    fs.writeFileSync(OUT_PATH, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  }
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main();
