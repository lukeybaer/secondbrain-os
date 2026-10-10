#!/usr/bin/env node
/**
 * Add independent, playable references to already-confirmed people.
 *
 * Identity authority is deliberately narrow: an exact registry binding made
 * by ExampleCo, or a strict confirmed-reference voiceprint match. Display names and
 * transcript guesses are never consulted. The operation is bounded, dry-run
 * by default, and dedupes both source call and audio path.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { canonicalSpeakerId } = require('./lib/canonical-speaker-identity');

const REPO = path.resolve(__dirname, '..');
const DATA_DIR = process.env.SECONDBRAIN_DATA_DIR || path.join(REPO, 'data');
const REGISTRY_PATH = path.join(DATA_DIR, 'life-archive', 'voice-identity-registry.json');
const ENRICHED_DIR = path.join(DATA_DIR, 'otter', 'enriched');
const PROBE_INDEX_PATH = path.join(DATA_DIR, 'life-archive', 'voiceprints', 'track-probe-index-latest.json');
const STATUS_PATH = path.join(
  DATA_DIR,
  'life-archive',
  'voiceprints',
  'voice-enrollment-strengthen-latest.json',
);
const STRICT_TIER = 'confirmed_reference_voiceprint_match';

function arg(name, fallback = '') {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
function hasArg(name) { return process.argv.includes(name); }
function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch { return fallback; }
}
function saveJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
}
function sha20(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 20);
}
function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}
function canonicalPersonId(value) {
  return String(value || '').trim().replace(/^person:/, '');
}
function audioAbs(raw, { repoRoot = REPO, dataDir = DATA_DIR } = {}) {
  if (!raw) return '';
  if (path.isAbsolute(raw)) return raw;
  const rel = String(raw).replace(/\\/g, '/').replace(/^\/+/, '');
  if (rel.startsWith('data/')) return path.join(dataDir, ...rel.slice(5).split('/'));
  return path.join(repoRoot, rel);
}
function audioRel(raw, options = {}) {
  const abs = audioAbs(raw, options);
  const dataDir = options.dataDir || DATA_DIR;
  const withinData = path.relative(dataDir, abs);
  if (withinData && !withinData.startsWith('..') && !path.isAbsolute(withinData)) {
    return `data/${withinData.replace(/\\/g, '/')}`;
  }
  return path.relative(options.repoRoot || REPO, abs).replace(/\\/g, '/');
}
function sourceCall(row) {
  if (row?.otid) return String(row.otid);
  const raw = String(row?.reference_audio_rel || row?.reference_audio_path || '');
  const m = raw.replace(/\\/g, '/').match(/data\/otter\/audio\/([^/]+)\//);
  return m ? m[1] : '';
}
function usableExistingEnrollment(row, options = {}) {
  const abs = audioAbs(row?.reference_audio_rel || row?.reference_audio_path || '', options);
  return Boolean(abs && fs.existsSync(abs));
}
function sourceDay(value) {
  if (value == null || value === '') return '';
  const numeric = Number(value);
  const date = Number.isFinite(numeric)
    ? new Date(numeric > 1e12 ? numeric : numeric * 1000)
    : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : '';
}

function confirmedBindingKind(resolved, registry, personId) {
  const exactPerson = canonicalPersonId(personId);
  if (!resolved || canonicalPersonId(resolved.person_id) !== exactPerson) return '';
  const strict =
    // speaker_identity_tracks use identity_tier as the terminal strict-gate
    // receipt and historically omit the duplicate identity_status field.
    resolved.identity_tier === STRICT_TIER &&
    (!resolved.identity_status || resolved.identity_status === STRICT_TIER) &&
    Array.isArray(resolved.evidence) &&
    resolved.evidence.includes('confirmed_reference_voiceprint') &&
    resolved.evidence.includes('margin_gate') &&
    (!resolved.voice_embedding_match?.person_id ||
      canonicalPersonId(resolved.voice_embedding_match.person_id) === exactPerson);
  if (strict) return STRICT_TIER;

  const clusterId = String(resolved.source_voice_cluster_id || '');
  const cluster = registry?.voice_cluster_resolutions?.[clusterId];
  // apply-voice-confirmation-actions.js writes this exact terminal status on
  // every confirmed member resolution (the registry is authority, not name).
  if (
    clusterId &&
    canonicalPersonId(cluster?.person_id) === exactPerson &&
    /^confirmed_by_ExampleCo$/.test(String(cluster?.status || ''))
  ) return 'confirmed_by_ExampleCo_cluster_binding';

  const groupId = String(resolved.source_acoustic_group_id || '');
  const group = registry?.acoustic_group_resolutions?.[groupId];
  if (
    groupId &&
    canonicalPersonId(group?.person_id) === exactPerson &&
    /^confirmed_by_ExampleCo$/.test(String(group?.status || ''))
  ) return 'confirmed_by_ExampleCo_acoustic_binding';
  return '';
}

function candidatesFromArtifacts({ registry, personId = '', personIds = [], enrichedDir = ENRICHED_DIR, probeIndex = null, repoRoot = REPO, dataDir = DATA_DIR }) {
  const targets = new Set([personId, ...personIds].map(canonicalPersonId).filter(Boolean));
  const byPersonCall = new Map();
  if (!fs.existsSync(enrichedDir)) return [];
  const probeByTrack = new Map(
    (probeIndex?.probes || []).map((row) => [
      `${row.otid}|${row.speaker_model_label}`,
      row,
    ]),
  );
  for (const name of fs.readdirSync(enrichedDir).filter((x) => x.endsWith('.json'))) {
    const artifact = readJson(path.join(enrichedDir, name), null);
    if (!artifact) continue;
    const otid = String(artifact.otid || artifact.id || path.basename(name, '.json'));
    const day = sourceDay(artifact.start_time || artifact.created_at || artifact.date);
    const rawSourcePath = audioAbs(artifact.source_raw_path || '', { repoRoot, dataDir });
    const recoveredRawRevision = rawSourcePath && fs.existsSync(rawSourcePath)
      ? sha256(fs.readFileSync(rawSourcePath))
      : '';
    const sourceRevision = String(
      artifact.source_revision || artifact.source_revision_hash || recoveredRawRevision,
    );
    const identityTracks = Object.entries(artifact.speaker_identity_tracks || {}).map(
      ([label, resolved]) => ({ label, resolved, segment: null }),
    );
    const segmentTracks = (artifact.segments || []).map((segment) => ({
      label: segment.speaker_model_label || segment.resolved_speaker?.otter_speaker || '',
      resolved: segment.resolved_speaker,
      segment,
    }));
    for (const { label, resolved, segment } of [...identityTracks, ...segmentTracks]) {
      const resolvedPersonId = canonicalPersonId(resolved?.person_id);
      if (!targets.has(resolvedPersonId)) continue;
      const binding = confirmedBindingKind(resolved, registry, resolvedPersonId);
      const probe = probeByTrack.get(`${otid}|${label}`) || null;
      const rawAudio = resolved?.probe_audio_path || segment?.probe_audio_path || probe?.probe_audio_path || '';
      const absAudio = audioAbs(rawAudio, { repoRoot, dataDir });
      const netSpeech = Number(
        resolved?.net_speech_seconds ||
        probe?.net_speech_seconds_estimate ||
        probe?.primary_net_speech_seconds ||
        0,
      );
      const cleanSingleSpeakerProbe =
        Boolean(probe) &&
        probe.identity_grade === true &&
        probe.probe_quality?.rejects_overlap === true;
      if (
        !binding ||
        !day ||
        !/^[a-f0-9]{64}$/i.test(sourceRevision) ||
        netSpeech < 6 ||
        !cleanSingleSpeakerProbe ||
        !absAudio ||
        !fs.existsSync(absAudio)
      ) continue;
      const candidate = {
        person_id: resolvedPersonId,
        otid,
        source_day: day,
        source_revision_hash: sourceRevision,
        audio_abs: absAudio,
        audio_rel: audioRel(absAudio, { repoRoot, dataDir }),
        source_voice_cluster_id: resolved.source_voice_cluster_id || '',
        source_acoustic_group_id: resolved.source_acoustic_group_id || '',
        speaker_model_label: resolved.otter_speaker || label || '',
        start_seconds: Number(probe?.start_seconds ?? segment?.start_seconds ?? 0),
        duration_seconds: netSpeech,
        identity_evidence: binding,
        score: Number(resolved.voice_embedding_match?.score || 0),
        margin: Number(resolved.voice_embedding_match?.margin || 0),
      };
      const key = `${resolvedPersonId}|${otid}`;
      const current = byPersonCall.get(key);
      if (
        !current ||
        candidate.score > current.score ||
        (candidate.score === current.score && candidate.duration_seconds > current.duration_seconds)
      ) {
        byPersonCall.set(key, candidate);
      }
    }
  }
  return [...byPersonCall.values()].sort(
    (a, b) => Number(b.margin) - Number(a.margin) || Number(b.score) - Number(a.score) || a.otid.localeCompare(b.otid),
  );
}

function strengthenPerson({
  registry,
  personId,
  candidates,
  maxNew = 3,
  maxTotal = 10,
  now = new Date().toISOString(),
}) {
  const id = canonicalPersonId(personId);
  const person = registry?.people?.[id];
  if (!person || !String(person.identity_confirmation_status || '').startsWith('confirmed')) {
    return { person_id: id, error: 'person_not_confirmed', created: 0, enrollments: [] };
  }
  registry.enrollments ||= [];
  const existingRows = registry.enrollments.filter((row) => canonicalPersonId(row.person_id) === id);
  const existing = existingRows.filter((row) => usableExistingEnrollment(row));
  const seenAudio = new Set(existingRows.map((row) => String(row.reference_audio_rel || row.reference_audio_path || '').replace(/\\/g, '/').toLowerCase()).filter(Boolean));
  const seenCalls = new Set(existingRows.map(sourceCall).filter(Boolean));
  const dayByCall = new Map(candidates.map((row) => [row.otid, row.source_day]).filter(([, day]) => day));
  const seenDays = new Set(
    existingRows
      .map((row) => row.source_day || dayByCall.get(sourceCall(row)) || '')
      .filter(Boolean),
  );
  const created = [];
  const remaining = Math.max(0, Math.min(Number(maxNew) || 0, (Number(maxTotal) || 0) - existing.length));
  for (const candidate of candidates) {
    if (created.length >= remaining) break;
    const audioKey = String(candidate.audio_rel || candidate.audio_abs || '').replace(/\\/g, '/').toLowerCase();
    if (
      !audioKey ||
      !candidate.source_day ||
      seenAudio.has(audioKey) ||
      seenDays.has(candidate.source_day) ||
      (candidate.otid && seenCalls.has(candidate.otid))
    ) continue;
    const enrollmentId = sha20(`${id}|${audioKey}`);
    const enrollment = {
      enrollment_id: enrollmentId,
      person_id: id,
      canonical_speaker_id: canonicalSpeakerId(id),
      display_name: person.display_name || id,
      model: 'ecapa.track_reference.v1',
      model_version: 'speechbrain/spkrec-ecapa-voxceleb',
      embedding_path: null,
      reference_audio_path: candidate.audio_abs,
      reference_audio_rel: candidate.audio_rel,
      source_id: `otter:${candidate.otid}:speaker_model_label_${candidate.speaker_model_label || 'unknown'}:${enrollmentId}`,
      source_label: `Enrollment strengthened from ${candidate.identity_evidence} evidence on Otter call ${candidate.otid}.`,
      voice_cluster_id: canonicalSpeakerId(id),
      source_voice_cluster_id: candidate.source_voice_cluster_id || null,
      source_acoustic_group_id: candidate.source_acoustic_group_id || null,
      otid: candidate.otid,
      source_day: candidate.source_day,
      speaker_model_label: candidate.speaker_model_label || '',
      start_seconds: candidate.start_seconds,
      duration_seconds: candidate.duration_seconds,
      created_at: now,
      consent_status: person.consent_status || (id === 'ExampleCo' ? 'owner_allowed' : 'not_requested'),
      effective_consent_basis: id === 'ExampleCo' ? 'owner_allowed' : 'operator_implied_consent',
      identity_evidence: candidate.identity_evidence,
      automatic_strengthening: true,
      negative_calibration_count: 0,
    };
    const audioSha = sha256(fs.readFileSync(candidate.audio_abs));
    enrollment.source_revision_hash = candidate.source_revision_hash;
    enrollment.reference_audio_sha256 = audioSha;
    enrollment.probe_sha256 = audioSha;
    enrollment.segment_evidence_sha256 = sha256(JSON.stringify({
      otid: candidate.otid,
      source_revision_hash: candidate.source_revision_hash,
      source_voice_cluster_id: candidate.source_voice_cluster_id || null,
      source_acoustic_group_id: candidate.source_acoustic_group_id || null,
      speaker_model_label: candidate.speaker_model_label || '',
      identity_evidence: candidate.identity_evidence,
    }));
    enrollment.evidence_hash = sha256([
      enrollment.source_revision_hash,
      enrollment.reference_audio_sha256,
      enrollment.segment_evidence_sha256,
      enrollment.probe_sha256,
      enrollment.model,
      enrollment.model_version,
    ].join('|'));
    registry.enrollments.push(enrollment);
    created.push(enrollment);
    seenAudio.add(audioKey);
    if (candidate.otid) seenCalls.add(candidate.otid);
    seenDays.add(candidate.source_day);
  }
  person.voiceprint_enrollments = existing.length + created.length;
  if (person.voiceprint_enrollments) person.voiceprint_status = 'enrolled';
  return {
    person_id: id,
    candidates: candidates.length,
    existing: existing.length,
    existing_total: existingRows.length,
    created: created.length,
    capped: existing.length + created.length >= maxTotal,
    enrollments: created,
  };
}

function run({ write = false, personId = '', maxNew = 1, maxTotal = 10, registryPath = REGISTRY_PATH, enrichedDir = ENRICHED_DIR, probeIndexPath = PROBE_INDEX_PATH, repoRoot = REPO, dataDir = DATA_DIR } = {}) {
  const sourceRegistry = readJson(registryPath, null);
  if (!sourceRegistry) throw new Error(`voice identity registry unavailable: ${registryPath}`);
  // Dry runs operate on a clone so repeated previews cannot accumulate counts.
  const registry = write ? sourceRegistry : JSON.parse(JSON.stringify(sourceRegistry));
  const probeIndex = readJson(probeIndexPath, { probes: [] });
  const ids = personId
    ? [canonicalPersonId(personId)]
    : Object.entries(registry.people || {})
        .filter(([, person]) => String(person?.identity_confirmation_status || '').startsWith('confirmed'))
        .map(([id]) => id);
  const idsBelowCap = ids.filter((id) =>
    (registry.enrollments || []).filter(
      (row) =>
        canonicalPersonId(row.person_id) === id &&
        usableExistingEnrollment(row, { repoRoot, dataDir }),
    ).length < maxTotal,
  );
  const candidateRows = idsBelowCap.length
    ? candidatesFromArtifacts({
        registry,
        personIds: idsBelowCap,
        enrichedDir,
        probeIndex,
        repoRoot,
        dataDir,
      })
    : [];
  const candidatesByPerson = new Map();
  for (const row of candidateRows) {
    if (!candidatesByPerson.has(row.person_id)) candidatesByPerson.set(row.person_id, []);
    candidatesByPerson.get(row.person_id).push(row);
  }
  const results = ids.map((id) => {
    const existing = (registry.enrollments || []).filter(
      (row) =>
        canonicalPersonId(row.person_id) === id &&
        usableExistingEnrollment(row, { repoRoot, dataDir }),
    ).length;
    return strengthenPerson({
      registry,
      personId: id,
      candidates: existing >= maxTotal ? [] : candidatesByPerson.get(id) || [],
      maxNew,
      maxTotal,
    });
  });
  const report = {
    schema: 'life_archive_voice_enrollment_strengthen.v1',
    generated_at: new Date().toISOString(),
    wrote: Boolean(write),
    person_filter: personId || null,
    max_new_per_person: maxNew,
    max_total_per_person: maxTotal,
    people_considered: results.length,
    enrollments_created: results.reduce((sum, row) => sum + Number(row.created || 0), 0),
    results,
  };
  if (write) {
    registry.updated_at = report.generated_at;
    saveJson(registryPath, registry);
    saveJson(STATUS_PATH, report);
  }
  return report;
}

if (require.main === module) {
  try {
    const report = run({
      write: hasArg('--write'),
      personId: arg('--person-id', ''),
      maxNew: Number(arg('--max-new', '1')),
      maxTotal: Number(arg('--max-total', '10')),
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    console.error(error?.stack || error);
    process.exit(1);
  }
}

module.exports = { run, _test: { confirmedBindingKind, candidatesFromArtifacts, strengthenPerson, sourceCall, sourceDay, usableExistingEnrollment } };
