#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { ensurePeopleFileStub } = require('./lib/voice-people-stub');
const {
  applyCanonicalSpeakerIdentity,
  canonicalizeVoiceIdentityRegistry,
} = require('./lib/canonical-speaker-identity');
const {
  SAFE_PERSON_ID_ALIASES,
  canonicalPersonId,
  loadPeopleFileCatalog,
  resolvePeopleFileTarget,
} = require('./lib/voice-people-file-target');

const ROOT = path.resolve(process.env.SECONDBRAIN_ROOT || path.join(__dirname, '..'));
const DATA_DIR = path.resolve(process.env.SECONDBRAIN_DATA_DIR || path.join(ROOT, 'data'));
const REGISTRY_PATH = path.join(DATA_DIR, 'life-archive', 'voice-identity-registry.json');
const ENRICHED_DIR = path.join(DATA_DIR, 'otter', 'enriched');
const STATUS_PATH = path.join(
  DATA_DIR,
  'life-archive',
  'voiceprints',
  'voice-people-file-target-repair-latest.json',
);
const ALIASES_PATH = path.join(DATA_DIR, 'agent', 'voiceprint-contact-aliases.json');

function readJson(file, fallback = {}) {
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

function attestedEnrollmentContactFile(enrollment, dataDir = DATA_DIR) {
  const provenance = enrollment?.reference_provenance;
  const receiptRel = String(provenance?.receipt_path || '').trim();
  const receiptSha = String(provenance?.receipt_sha256 || '').trim();
  if (!receiptRel || !/^[a-f0-9]{64}$/i.test(receiptSha)) {
    return { ok: false, reason: 'immutable_receipt_pointer_missing' };
  }
  const root = path.resolve(dataDir);
  const receiptPath = path.resolve(root, receiptRel);
  if (receiptPath !== root && !receiptPath.startsWith(`${root}${path.sep}`)) {
    return { ok: false, reason: 'immutable_receipt_path_out_of_scope' };
  }
  let bytes = '';
  try {
    bytes = fs.readFileSync(receiptPath, 'utf8');
  } catch {
    return { ok: false, reason: 'immutable_receipt_unreadable' };
  }
  const observedSha = crypto.createHash('sha256').update(bytes).digest('hex');
  if (observedSha !== receiptSha) {
    return { ok: false, reason: 'immutable_receipt_hash_mismatch' };
  }
  let receipt;
  try {
    receipt = JSON.parse(bytes.replace(/^\uFEFF/, ''));
  } catch {
    return { ok: false, reason: 'immutable_receipt_invalid_json' };
  }
  if (
    String(receipt?.enrollment_id || '') !== String(enrollment?.enrollment_id || '') ||
    !receipt?.attested_record
  ) {
    return { ok: false, reason: 'immutable_receipt_enrollment_mismatch' };
  }
  return {
    ok: true,
    contactFile: String(receipt.attested_record.contact_file || ''),
  };
}

function confirmedPerson(person) {
  return Boolean(
    person &&
      (person.identity_confirmation_status === 'confirmed_by_ExampleCo' ||
        person.voiceprint_status === 'enrolled'),
  );
}

function canonicalizeResolvedSpeaker(target, registry) {
  if (!target?.person_id) return false;
  const before = String(target.person_id);
  const after = canonicalPersonId(before);
  if (!after || before === after) return false;
  const displayName = registry.people?.[after]?.display_name || target.resolved_person || after;
  applyCanonicalSpeakerIdentity(target, after, {
    sourceVoiceClusterId: target.source_voice_cluster_id || target.voice_cluster_id,
    sourceAcousticGroupId: target.source_acoustic_group_id || target.acoustic_unknown_id,
  });
  target.resolved_person = displayName;
  return true;
}

function repair(options = {}) {
  const write = Boolean(options.write);
  const registry = options.registry || readJson(REGISTRY_PATH, {
    people: {},
    enrollments: [],
  });
  registry.people ||= {};
  registry.enrollments ||= [];
  const generatedAt = new Date().toISOString();
  const report = {
    schema: 'life_archive_voice_people_file_target_repair.v1',
    generated_at: generatedAt,
    wrote: write,
    safe_person_aliases: SAFE_PERSON_ID_ALIASES,
    person_id_migrations: [],
    contact_links_changed: 0,
    people_files_created: 0,
    enrollment_contact_links_changed: 0,
    enrollment_immutable_contact_links_preserved: 0,
    enrollment_immutable_contact_links_restored: 0,
    enrollment_immutable_contact_link_receipt_failures: 0,
    resolution_contact_links_changed: 0,
    enriched_files_changed: 0,
    enriched_assignments_changed: 0,
    changes: [],
  };

  report.person_id_migrations = canonicalizeVoiceIdentityRegistry(registry, {
    canonicalizePersonId: canonicalPersonId,
  });

  let catalog = options.catalog || loadPeopleFileCatalog(ROOT);
  for (const [personId, person] of Object.entries(registry.people)) {
    if (!confirmedPerson(person)) continue;
    let target = resolvePeopleFileTarget({
      repoRoot: ROOT,
      personId,
      displayName: person.display_name || personId,
      registryPerson: person,
      catalog,
    });
    if (target.ambiguous) {
      report.changes.push({
        person_id: personId,
        display_name: person.display_name || personId,
        from: String(person.contact_file || ''),
        to: '',
        reason: target.source,
        blocked: true,
        candidates: target.candidates || [],
      });
      continue;
    }
    if (!target.exists && write) {
      const stub = ensurePeopleFileStub({
        contactsRoot: path.join(ROOT, 'memory', 'contacts'),
        name: person.display_name || personId,
        personId: String(target.rel || '').startsWith('memory/contacts/')
          ? path.basename(target.rel, '.md')
          : personId,
        voiceClusterId: `person:${personId}`,
      });
      if (stub.created) report.people_files_created += 1;
      catalog = loadPeopleFileCatalog(ROOT);
      target = resolvePeopleFileTarget({
        repoRoot: ROOT,
        personId,
        displayName: person.display_name || personId,
        registryPerson: { ...person, contact_file: stub.rel },
        catalog,
      });
    }
    if (!target.rel || target.ambiguous) continue;
    const before = String(person.contact_file || '');
    if (before !== target.rel) {
      person.contact_file = target.rel;
      report.contact_links_changed += 1;
      report.changes.push({
        person_id: personId,
        display_name: person.display_name || personId,
        from: before,
        to: target.rel,
        reason: target.source,
      });
    }
    for (const enrollment of registry.enrollments) {
      if (canonicalPersonId(enrollment.person_id) !== personId) continue;
      if (enrollment.reference_provenance) {
        report.enrollment_immutable_contact_links_preserved += 1;
        const attested = attestedEnrollmentContactFile(enrollment, DATA_DIR);
        if (!attested.ok) {
          report.enrollment_immutable_contact_link_receipt_failures += 1;
          continue;
        }
        if (String(enrollment.contact_file || '') !== attested.contactFile) {
          enrollment.contact_file = attested.contactFile;
          report.enrollment_immutable_contact_links_restored += 1;
        }
        continue;
      }
      if (enrollment.contact_file === target.rel) continue;
      enrollment.contact_file = target.rel;
      report.enrollment_contact_links_changed += 1;
    }
    for (const resolution of [
      ...Object.values(registry.voice_cluster_resolutions || {}),
      ...Object.values(registry.acoustic_group_resolutions || {}),
    ]) {
      if (canonicalPersonId(resolution?.person_id) !== personId) continue;
      if (resolution.contact_file === target.rel) continue;
      resolution.contact_file = target.rel;
      report.resolution_contact_links_changed += 1;
    }
  }

  if (fs.existsSync(ENRICHED_DIR)) {
    for (const name of fs.readdirSync(ENRICHED_DIR).filter((file) => file.endsWith('.json'))) {
      const file = path.join(ENRICHED_DIR, name);
      const doc = readJson(file, null);
      if (!doc) continue;
      let changed = 0;
      for (const track of Object.values(doc.speaker_identity_tracks || {})) {
        if (canonicalizeResolvedSpeaker(track, registry)) changed += 1;
      }
      for (const segment of doc.segments || []) {
        if (canonicalizeResolvedSpeaker(segment.resolved_speaker, registry)) changed += 1;
      }
      if (!changed) continue;
      report.enriched_files_changed += 1;
      report.enriched_assignments_changed += changed;
      if (write) saveJson(file, doc);
    }
  }

  if (write) {
    const aliases = readJson(ALIASES_PATH, {});
    for (const [personId, person] of Object.entries(registry.people)) {
      if (person.contact_file) aliases[personId] = person.contact_file;
    }
    saveJson(REGISTRY_PATH, registry);
    saveJson(ALIASES_PATH, aliases);
    saveJson(STATUS_PATH, report);
  }
  return report;
}

function main() {
  const report = repair({ write: process.argv.includes('--write') });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (require.main === module) main();

module.exports = {
  attestedEnrollmentContactFile,
  confirmedPerson,
  canonicalizeResolvedSpeaker,
  repair,
};
