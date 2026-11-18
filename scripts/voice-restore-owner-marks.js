#!/usr/bin/env node
/**
 * One-time restore of "The owner said so" on voice rows a machine match overwrote
 * (owner decision). The name held; only the
 * record that he gave it was lost.
 *
 *   node --max-old-space-size=4096 scripts/voice-restore-owner-marks.js
 *     [--expect-rows <n>] [--write --backup-dir <dir>]
 *
 * Dry run by default. --expect-rows stops the run, exit 2, nothing written, on
 * any other count. Run it before voice-naming-rule-apply, so the holds and the
 * frozen baseline see the restored rows.
 *
 * The answers come from older copies of the registry. One is restored only when
 * nothing since says otherwise: the row now must be the machine's and name the
 * same person, every copy must agree on who he named, no later denial, click,
 * correction or owner answer may disagree on that voice id, no speaker carrying
 * that voice may hold his own answer for anyone else, and any sample the row names
 * must still stand. Anything else is left alone and counted. Only the registry is
 * written.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const R = require('./voice-global-recluster');
const { saveJsonAtomic, withReclusterPublishLock } = require('./lib/recluster-publish-lock');
const {
  assertUnchanged,
  backupFiles,
  readJsonHashed,
  saveIfUnchanged,
  sha256File,
} = require('./lib/voice-one-time-repair');
const { isOwnerConfirmedTier } = require('./lib/canonical-speaker-identity');
const { canonicalPersonId: tablePersonId } = require('./lib/voice-people-file-target');
const { sameCanonicalPerson } = require('./lib/voice-track-name-check');

const MACHINE_STATUS = 'confirmed_reference_voiceprint_match';
const REASON = 'owner_mark_overwritten_by_machine_match';
const MIN_COPY_BYTES = 500000;
const TRACK_VOICE_FIELDS = ['source_voice_cluster_id', 'voice_cluster_id', 'unknown_speaker_id', 'acoustic_unknown_id', 'speaker_id'];

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const isOwner = (row) => /confirmed_by_owner/.test(String(row?.status || ''));

function samePerson(a, b, aliases) {
  if (!a || !b) return false;
  return sameCanonicalPerson(a, b, aliases) || tablePersonId(a) === tablePersonId(b);
}

/** Every older registry on disk. The live file is never one of its own copies. */
function listCopies(paths) {
  const lifeArchive = path.dirname(paths.registry);
  const files = [];
  for (const dir of [lifeArchive, path.join(lifeArchive, 'voiceprints')]) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !/identity-registry/i.test(entry.name)) continue;
      if (/receipts|\.lock|\.tmp/.test(entry.name)) continue;
      const file = path.join(dir, entry.name);
      if (fs.statSync(file).size > MIN_COPY_BYTES) files.push(file);
    }
  }
  const snapshots = path.join(lifeArchive, 'voiceprints', 'identity-registry-snapshots');
  if (fs.existsSync(snapshots)) {
    for (const entry of fs.readdirSync(snapshots, { withFileTypes: true })) {
      if (entry.isFile()) files.push(path.join(snapshots, entry.name));
    }
  }
  return files.filter((file) => path.resolve(file) !== path.resolve(paths.registry));
}

function newestRowAt(resolutions) {
  let newest = '';
  for (const row of Object.values(resolutions)) {
    const at = String(row?.updated_at || '');
    if (at > newest) newest = at;
  }
  return newest;
}

/**
 * One pass over every copy, keeping only what the sort needs, so 400-odd large
 * files never sit in memory together. A row seen in many copies is held once.
 */
function scanCopies(files, paths) {
  const lifeArchive = path.dirname(paths.registry);
  const markedRows = new Map();
  const ownerRows = new Map();
  const out = { copies_read: 0, copies_unreadable: 0, copies_not_a_registry: 0 };
  for (const file of files) {
    let resolutions;
    try {
      resolutions = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')).voice_cluster_resolutions;
    } catch {
      out.copies_unreadable += 1;
      continue;
    }
    if (!resolutions || typeof resolutions !== 'object') {
      out.copies_not_a_registry += 1;
      continue;
    }
    out.copies_read += 1;
    const copy = path.relative(lifeArchive, file).replace(/\\/g, '/');
    const copyNewest = newestRowAt(resolutions);
    for (const [id, row] of Object.entries(resolutions)) {
      if (id.startsWith('person:') || !row) continue;
      if (String(row.status || '') === MACHINE_STATUS) continue;
      const table = isOwner(row) ? markedRows : ownerRows;
      if (!table.has(id)) table.set(id, new Map());
      const key = JSON.stringify(row);
      const seen = table.get(id).get(key);
      if (!seen || copyNewest > seen.copyNewest) table.get(id).set(key, { row, copy, copyNewest });
    }
  }
  return { markedRows, ownerRows, ...out };
}

/** His newest answer on this id, by the row's own time, then by the copy's. */
function newestAnswer(history) {
  return [...history.values()].sort((a, b) => {
    const at = String(b.row.updated_at || '').localeCompare(String(a.row.updated_at || ''));
    return at || b.copyNewest.localeCompare(a.copyNewest);
  })[0];
}

/**
 * Who he named on each speaker he answered himself, by every voice id that speaker
 * carries (null when he named no one). A call that cannot be read could hide one
 * of his answers, so it stops the run.
 */
function readSpeakerAnswers(enrichedDir) {
  const byVoice = new Map();
  if (!fs.existsSync(enrichedDir)) return byVoice;
  for (const name of fs.readdirSync(enrichedDir)) {
    if (!name.endsWith('.json')) continue;
    let call;
    try {
      call = JSON.parse(fs.readFileSync(path.join(enrichedDir, name), 'utf8').replace(/^﻿/, ''));
    } catch (error) {
      throw Object.assign(new Error(`cannot read call ${name}: ${error.message}`), { code: 'CALL_UNREADABLE' });
    }
    for (const track of Object.values(call?.speaker_identity_tracks || {})) {
      if (!track || !(isOwnerConfirmedTier(track.identity_tier) || track.owner_track_decision)) continue;
      for (const id of new Set(TRACK_VOICE_FIELDS.map((field) => track[field]).filter(Boolean))) {
        if (!byVoice.has(id)) byVoice.set(id, []);
        byVoice.get(id).push(track.person_id || null);
      }
    }
  }
  return byVoice;
}

function rowsOn(table, id) {
  const value = table?.[id];
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}

/** Sorts one lost answer: 'restore', or the reason it stays as it is. */
function sortLostAnswer({ id, answer, history, later, registry, actions, speakerAnswers }) {
  const aliases = registry.person_id_aliases;
  const current = registry.voice_cluster_resolutions?.[id];
  const old = answer.row;
  const answeredAt = String(old.updated_at || '');
  if (!answeredAt) return 'no_answer_time';
  if (!current) return 'no_current_row';
  if (String(current.status || '') !== MACHINE_STATUS) return 'not_a_machine_row';
  if (!samePerson(current.person_id, old.person_id, aliases)) return 'different_person_now';
  for (const { row } of history.values()) {
    if (!samePerson(row.person_id, old.person_id, aliases)) return 'copies_disagree';
  }
  const deniedSince = rowsOn(registry.voice_cluster_denials, id).some(
    (row) => samePerson(row?.denied_person_id, old.person_id, aliases) && String(row?.created_at || '') > answeredAt,
  );
  if (deniedSince) return 'denied_since';
  const ownKey = String(old.review_action_key || '');
  const correctedSince = (registry.manual_corrections || []).some((row) => {
    if (row?.voice_cluster_id !== id && !(row?.affected_voice_cluster_ids || []).includes(id)) return false;
    if (ownKey && String(row.review_action_key || '').startsWith(ownKey)) return false;
    // "Not them, it is this same person" repeats his answer; it does not change it.
    if (
      samePerson(row.corrected_person_id, old.person_id, aliases)
      && !samePerson(row.denied_person_id, old.person_id, aliases)
    ) {
      return false;
    }
    return String(row.created_at || '') > answeredAt;
  });
  if (correctedSince) return 'corrected_since';
  const clickedSince = actions.some(
    (row) => (row?.voiceClusterId === id || row?.assignmentClusterId === id) && String(row?.ts || '') > answeredAt,
  );
  if (clickedSince) return 'clicked_since';
  const answeredSince = [...(later?.values() || [])].some(({ row }) => String(row.updated_at || '') > answeredAt);
  if (answeredSince) return 'owner_answer_since';
  // His own answer on a speaker carrying this voice, for anyone else or for no one,
  // disagrees with the old row. Two answers of his that disagree leave it alone.
  const spoken = speakerAnswers?.get(id) || [];
  if (spoken.some((person) => !samePerson(person, old.person_id, aliases))) return 'speaker_answer_differs';
  // A row naming a quarantined sample makes the next apply strip the track, so a
  // restore must never bring one back. The other two cannot be vouched for.
  if (old.enrollment_id) {
    const sample = (registry.enrollments || []).find((row) => row?.enrollment_id === old.enrollment_id);
    if (!sample) return 'sample_gone';
    if (String(sample.calibration_quarantine_status || '') === 'quarantined') return 'sample_quarantined';
    if (!samePerson(sample.person_id, old.person_id, aliases)) return 'sample_on_other_person';
  }
  return 'restore';
}

/**
 * His row as it was. Its group fields stay, so an answer given on a group is still
 * a suggestion to each member. Identity spelling comes from the current row, so a
 * later rename of the person stands.
 */
function restoredRow({ answer, current, at }) {
  const old = answer.row;
  return {
    ...old,
    person_id: current.person_id,
    display_name: current.display_name,
    canonical_speaker_id: current.canonical_speaker_id,
    ...(old.acoustic_unknown_id || !current.acoustic_unknown_id
      ? {}
      : { acoustic_unknown_id: current.acoustic_unknown_id }),
    restored_owner_mark: {
      at,
      reason: REASON,
      from_copy: answer.copy,
      overwritten_status: current.status,
      overwritten_updated_at: current.updated_at || null,
      overwritten_promotion_rule: current.promotion_rule || null,
    },
  };
}

function readActions(file) {
  if (!fs.existsSync(file)) return [];
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    // A torn ledger line could be a later answer this run cannot see, so it stops.
    rows.push(JSON.parse(line));
  }
  return rows;
}

function bump(counts, key) {
  counts[key] = (counts[key] || 0) + 1;
}

function run({ write = false, backupDir = null, expectRows = null, now = new Date() } = {}) {
  if (write && !backupDir) throw new Error('--write needs --backup-dir');
  const paths = R.resolvePaths();
  const actionsFile = path.join(paths.dataDir, 'life-archive', 'people', 'voice-confirmation-actions.jsonl');
  const at = now.toISOString();
  const hashes = new Map();
  const registry = readJsonHashed(paths.registry, hashes);
  // Hashed before the read: a click landing at any moment after this stops the run.
  if (fs.existsSync(actionsFile)) hashes.set(actionsFile, sha256File(actionsFile));
  const actions = readActions(actionsFile);
  const speakerAnswers = readSpeakerAnswers(path.join(paths.dataDir, 'otter', 'enriched'));

  const files = listCopies(paths);
  const { markedRows, ownerRows, ...copyCounts } = scanCopies(files, paths);
  const report = {
    copies_found: files.length,
    ...copyCounts,
    ever_owner_ids: markedRows.size,
    already_owner_now: 0,
    lost_ids: 0,
    restore: 0,
    left: {},
    restored_shape: { one_speaker_click: 0, group_answer: 0, with_action_key: 0, with_enrollment: 0, by_month: {} },
    left_ids: {},
    restore_ids: [],
    write: false,
    stops: [],
  };
  const restores = [];
  for (const [id, history] of markedRows) {
    if (isOwner(registry.voice_cluster_resolutions?.[id]) || isOwner(registry.acoustic_group_resolutions?.[id])) {
      report.already_owner_now += 1;
      continue;
    }
    report.lost_ids += 1;
    const answer = newestAnswer(history);
    const kind = sortLostAnswer({ id, answer, history, later: ownerRows.get(id), registry, actions, speakerAnswers });
    if (kind !== 'restore') {
      bump(report.left, kind);
      (report.left_ids[kind] ||= []).push(id);
      continue;
    }
    restores.push({ id, answer });
    report.restore_ids.push(id);
    const old = answer.row;
    const group = Boolean(old.acoustic_group_id || old.derived_from_acoustic_group);
    report.restored_shape[group ? 'group_answer' : 'one_speaker_click'] += 1;
    if (old.review_action_key) report.restored_shape.with_action_key += 1;
    if (old.enrollment_id) report.restored_shape.with_enrollment += 1;
    bump(report.restored_shape.by_month, String(old.updated_at).slice(0, 7));
  }
  report.restore = restores.length;

  if (expectRows !== null && Number(expectRows) !== report.restore) {
    report.stops.push(`expected ${expectRows} rows to restore, found ${report.restore}`);
    return { report, exitCode: 2 };
  }
  if (!write || !restores.length) return { report, exitCode: 0 };

  assertUnchanged(hashes);
  report.backup_files = backupFiles(backupDir, [...hashes.keys()], paths.dataDir);
  assertUnchanged(hashes);
  for (const { id, answer } of restores) {
    registry.voice_cluster_resolutions[id] = restoredRow({
      answer,
      current: registry.voice_cluster_resolutions[id],
      at,
    });
  }
  registry.updated_at = at;
  saveIfUnchanged(paths.registry, registry, hashes, saveJsonAtomic);
  report.write = true;
  return { report, exitCode: 0 };
}

if (require.main === module) {
  try {
    const options = {
      write: process.argv.includes('--write'),
      backupDir: argValue('--backup-dir'),
      expectRows: argValue('--expect-rows'),
    };
    const { report, exitCode } = options.write
      ? withReclusterPublishLock(R.resolvePaths().latest, () => run(options))
      : run(options);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = exitCode;
  } catch (error) {
    process.stderr.write(`${error.code || 'FAILED'}: ${error.message}\n`);
    process.exitCode = 3;
  }
}

module.exports = { listCopies, newestAnswer, readSpeakerAnswers, restoredRow, run, scanCopies, sortLostAnswer };
