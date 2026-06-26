#!/usr/bin/env node
/**
 * Gate the Otter heard-name resolver before its output can be trusted.
 *
 * Known/enrolled people are calibration targets. If a known enrollment is
 * target-marked and the LLM hears a different name, that enrollment is polluted
 * or too weak to serve as automatic voice evidence. This script writes the gate
 * report and, with --write-quarantine, marks those enrollments unusable for
 * future confirmed-reference matching.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const STATUS_PATH = path.join(ROOT, 'data', 'life-archive', 'voiceprints', 'voice-identity-overnight-name-resolver-status.json');
const REGISTRY_PATH = path.join(ROOT, 'data', 'life-archive', 'voice-identity-registry.json');
const ENROLLMENTS_DIR = path.join(ROOT, 'data', 'life-archive', 'voiceprints', 'enrollments');
const OUT_PATH = path.join(ROOT, 'data', 'life-archive', 'voiceprints', 'voice-name-calibration-gate-latest.json');

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

function repoAbs(file) {
  return path.isAbsolute(file) ? file : path.join(ROOT, file);
}

function normalizeKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function enrollmentRecords(personId) {
  const dir = path.join(ENROLLMENTS_DIR, personId);
  const registry = readJson(REGISTRY_PATH, {});
  const byId = new Map();
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir).filter((item) => item.endsWith('.json'))) {
      const file = path.join(dir, name);
      const row = readJson(file, null);
      if (row?.enrollment_id) byId.set(row.enrollment_id, { ...row, file });
    }
  }
  for (const row of registry.enrollments || []) {
    if (row?.person_id === personId && row?.enrollment_id && !byId.has(row.enrollment_id)) {
      byId.set(row.enrollment_id, { ...row, file: null });
    }
  }
  return [...byId.values()]
    .filter((row, index, rows) => {
      const key = row.acoustic_ExampleCo_id
        || row.source_id
        || row.voice_cluster_id
        || row.reference_audio_rel
        || row.reference_audio_path
        || row.enrollment_id;
      return rows.findIndex((other) => (
        (other.acoustic_ExampleCo_id
          || other.source_id
          || other.voice_cluster_id
          || other.reference_audio_rel
          || other.reference_audio_path
          || other.enrollment_id) === key
      )) === index;
    })
    .sort((a, b) => (
      String(a.created_at || '').localeCompare(String(b.created_at || ''))
      || String(a.enrollment_id || '').localeCompare(String(b.enrollment_id || ''))
      || String(a.file || '').localeCompare(String(b.file || ''))
    ));
}

function enrollmentForCalibrationTarget(target) {
  const match = String(target || '').match(/^(.+)#enrollment_(\d+)$/);
  if (!match) return null;
  const personId = match[1];
  const index = Number(match[2]) - 1;
  if (!Number.isInteger(index) || index < 0) return null;
  return enrollmentRecords(personId)[index] || null;
}

function loadJudgeResult(statusResult) {
  const logPath = statusResult?.stdout_log ? repoAbs(statusResult.stdout_log) : '';
  if (!logPath || !fs.existsSync(logPath)) return null;
  return readJson(logPath, null);
}

function analyzeKnownResult(statusResult) {
  const judge = loadJudgeResult(statusResult);
  const rows = [];
  const blockers = [];
  const warnings = [];
  if (!judge) {
    blockers.push({
      type: 'missing_judge_output',
      target: statusResult.target,
      stdout_log: statusResult.stdout_log || null,
      reason: 'Known calibration target has no readable judge output.',
    });
    return { rows, blockers, warnings };
  }

  const calibration = Array.isArray(judge.calibration) ? judge.calibration : [];
  const targetSummaries = Array.isArray(judge.target_summaries) ? judge.target_summaries : [];
  const judgedTargets = Array.isArray(judge?.judged?.targets) ? judge.judged.targets : [];
  if (!calibration.length) {
    blockers.push({
      type: 'zero_calibration_rows',
      target: statusResult.target,
      display_name: statusResult.display_name || null,
      stdout_log: statusResult.stdout_log || null,
      target_summary_count: targetSummaries.length,
      judged_target_count: judgedTargets.length,
      reason: 'Known calibration target was counted ok but produced no explicit calibration rows.',
    });
  }

  for (const row of calibration) {
    const enrollment = enrollmentForCalibrationTarget(row.target);
    const payload = {
      type: row.pass ? 'calibration_pass' : 'calibration_fail',
      target: row.target,
      expected: row.expected || null,
      actual: row.actual || null,
      confidence: row.confidence || null,
      outcome: row.outcome || null,
      pass: Boolean(row.pass),
      heard_name_pass: Boolean(row.heard_name_pass),
      direct_name_evidence_count: Number(row.direct_name_evidence_count || 0),
      self_intro_evidence_count: Number(row.self_intro_evidence_count || 0),
      independent_evidence_windows: Number(row.independent_evidence_windows || 0),
      counterevidence_count: Number(row.counterevidence_count || 0),
      why: row.why || '',
      stdout_log: statusResult.stdout_log || null,
      enrollment_id: enrollment?.enrollment_id || null,
      enrollment_file: enrollment?.file ? path.relative(ROOT, enrollment.file).replace(/\\/g, '/') : null,
      person_id: enrollment?.person_id || null,
      voice_cluster_id: enrollment?.voice_cluster_id || null,
      source_id: enrollment?.source_id || null,
      reference_audio_rel: enrollment?.reference_audio_rel || null,
    };
    rows.push(payload);
    if (!row.pass && row.actual) {
      blockers.push({ ...payload, reason: 'Known calibration heard a different name than expected.' });
    } else if (!row.pass) {
      warnings.push({ ...payload, type: 'calibration_miss_no_clear_name', reason: 'Known calibration did not find a clear heard-name scene.' });
    } else if (/conflict|weak|provisional/i.test(String(row.outcome || row.confidence || ''))) {
      warnings.push(payload);
    }
  }

  return { rows, blockers, warnings };
}

function buildReport() {
  const status = readJson(STATUS_PATH, {});
  const results = Array.isArray(status.results) ? status.results : [];
  const known = results.filter((row) => row.kind === 'known');
  const rows = [];
  const blockers = [];
  const warnings = [];
  for (const result of known) {
    const analyzed = analyzeKnownResult(result);
    rows.push(...analyzed.rows);
    blockers.push(...analyzed.blockers);
    warnings.push(...analyzed.warnings);
  }
  return {
    schema: 'life_archive.voice_name_calibration_gate.v1',
    generated_at: new Date().toISOString(),
    source_status: path.relative(ROOT, STATUS_PATH).replace(/\\/g, '/'),
    source_status_phase: status.phase || null,
    known_targets: known.length,
    calibration_rows: rows.length,
    blocker_count: blockers.length,
    warning_count: warnings.length,
    automatic_identity_acceptance: blockers.length ? 'blocked' : 'allowed',
    blockers,
    warnings,
    rows,
  };
}

function currentQuarantinedEnrollmentIds() {
  const registry = readJson(REGISTRY_PATH, {});
  return [...new Set((registry.enrollments || [])
    .filter((row) => String(row?.calibration_quarantine_status || '') === 'quarantined')
    .map((row) => row.enrollment_id)
    .filter(Boolean))].sort();
}

function upsertRegistryQuarantines(report) {
  const registry = readJson(REGISTRY_PATH, {});
  registry.enrollments ||= [];
  registry.manual_corrections ||= [];
  const now = report.generated_at;
  const bad = report.blockers.filter((row) => (
    row.type === 'calibration_fail'
    && row.enrollment_id
    && row.actual
    && String(row.actual).trim()
  ));
  const badIds = new Set(bad.map((row) => row.enrollment_id));
  const good = report.rows.filter((row) => (
    row.type === 'calibration_pass'
    && row.enrollment_id
    && row.actual
    && String(row.actual).trim()
    && !badIds.has(row.enrollment_id)
  ));
  const quarantined = [];
  const released = [];
  function patchEnrollment(row, patch) {
    let changed = false;
    for (const enrollment of registry.enrollments) {
      if (enrollment.enrollment_id !== row.enrollment_id) continue;
      Object.assign(enrollment, patch);
      changed = true;
    }
    const file = row.enrollment_file ? path.join(ROOT, ...row.enrollment_file.split('/')) : '';
    if (file && fs.existsSync(file)) {
      const enrollment = readJson(file, {});
      Object.assign(enrollment, patch);
      saveJson(file, enrollment);
      changed = true;
    }
    return changed;
  }
  for (const row of bad) {
    const patch = {
      calibration_quarantine_status: 'quarantined',
      calibration_quarantined_at: now,
      calibration_quarantine_reason: `${row.target} expected ${row.expected || 'known'} but heard ${row.actual || 'ExampleCo'} (${row.outcome || 'failed_calibration'})`,
      calibration_expected_name: row.expected || null,
      calibration_actual_name: row.actual || null,
      calibration_gate_report: path.relative(ROOT, OUT_PATH).replace(/\\/g, '/'),
      negative_calibration_count: Number(row.negative_calibration_count || 0) + 1,
    };
    const changed = patchEnrollment(row, patch);
    registry.manual_corrections.push({
      type: 'voiceprint_enrollment_quarantined_by_calibration_gate',
      created_at: now,
      person_id: row.person_id || normalizeKey(String(row.target).split('#')[0]),
      enrollment_id: row.enrollment_id,
      voice_cluster_id: row.voice_cluster_id || null,
      expected: row.expected || null,
      actual: row.actual || null,
      source: 'voice-name-calibration-gate',
      reason: patch.calibration_quarantine_reason,
    });
    if (changed) quarantined.push(row.enrollment_id);
  }
  for (const row of good) {
    const existing = (registry.enrollments || []).find((enrollment) => enrollment.enrollment_id === row.enrollment_id);
    if (String(existing?.calibration_quarantine_status || '') !== 'quarantined') continue;
    const patch = {
      calibration_quarantine_status: 'released',
      calibration_released_at: now,
      calibration_release_reason: `${row.target} now calibrates as ${row.actual} (${row.outcome || 'pass'}); old quarantine no longer blocks automatic matching.`,
      calibration_expected_name: row.expected || null,
      calibration_actual_name: row.actual || null,
      calibration_gate_report: path.relative(ROOT, OUT_PATH).replace(/\\/g, '/'),
    };
    const changed = patchEnrollment(row, patch);
    registry.manual_corrections.push({
      type: 'voiceprint_enrollment_released_by_calibration_gate',
      created_at: now,
      person_id: row.person_id || normalizeKey(String(row.target).split('#')[0]),
      enrollment_id: row.enrollment_id,
      voice_cluster_id: row.voice_cluster_id || null,
      expected: row.expected || null,
      actual: row.actual || null,
      source: 'voice-name-calibration-gate',
      reason: patch.calibration_release_reason,
    });
    if (changed) released.push(row.enrollment_id);
  }
  registry.updated_at = now;
  saveJson(REGISTRY_PATH, registry);
  return {
    quarantined: [...new Set(quarantined)],
    released: [...new Set(released)],
  };
}

function main() {
  const report = buildReport();
  let changes = { quarantined: [], released: [] };
  if (hasArg('--write-quarantine')) {
    changes = upsertRegistryQuarantines(report);
  }
  report.newly_quarantined_enrollment_ids = changes.quarantined || [];
  report.released_enrollment_ids = changes.released || [];
  report.quarantined_enrollment_ids = currentQuarantinedEnrollmentIds();
  report.quarantined_enrollment_count = report.quarantined_enrollment_ids.length;
  saveJson(OUT_PATH, report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.blocker_count && hasArg('--fail-on-blockers')) process.exit(2);
}

main();
