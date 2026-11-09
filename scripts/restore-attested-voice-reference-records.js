#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  RECEIPT_SCHEMA,
  enrollmentRecordHash,
  stableJson,
} = require('./lib/voice-reference-provenance');
const {
  canonicalPersonId,
} = require('./lib/voice-people-file-target');

const ORDINARY_MUTABLE_METADATA = new Set(['display_name', 'contact_file']);
const CANONICAL_ALIAS_FIELDS = new Set([
  ...ORDINARY_MUTABLE_METADATA,
  'person_id',
  'voice_cluster_id',
  'canonical_speaker_id',
]);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function parseArgs(argv) {
  const out = { write: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--write') out.write = true;
    else if (arg === '--data-dir') out.dataDir = argv[++index];
    else if (arg === '--registry') out.registryPath = argv[++index];
    else if (arg === '--expected-registry-sha') out.expectedRegistrySha = argv[++index];
    else if (arg === '--expected-repair-count') out.expectedRepairCount = Number(argv[++index]);
    else if (arg === '--help') out.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

function changedKeys(current, attested) {
  return [...new Set([...Object.keys(current), ...Object.keys(attested)])]
    .filter((key) => stableJson(current[key]) !== stableJson(attested[key]))
    .sort();
}

function receiptFile(dataDir, relativePath) {
  const root = path.resolve(dataDir);
  const resolved = path.resolve(root, String(relativePath || ''));
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error('receipt path escaped the configured data directory');
  }
  return resolved;
}

function aliasOnlyRetarget(current, attested, keys) {
  const canonical = canonicalPersonId(attested.person_id);
  return (
    canonical &&
    canonical !== attested.person_id &&
    current.person_id === canonical &&
    current.voice_cluster_id === `person:${canonical}` &&
    current.canonical_speaker_id === `person:${canonical}` &&
    keys.every((key) => CANONICAL_ALIAS_FIELDS.has(key))
  );
}

function restoreAttestedVoiceReferenceRecords({
  registryPath,
  dataDir,
  expectedRegistrySha,
  expectedRepairCount,
  write = false,
  fsApi = fs,
}) {
  const originalBytes = fsApi.readFileSync(registryPath);
  const registrySha = sha256(originalBytes);
  if (write && !/^[a-f0-9]{64}$/.test(String(expectedRegistrySha || ''))) {
    throw new Error('--write requires --expected-registry-sha');
  }
  if (write && registrySha !== expectedRegistrySha) {
    throw new Error(
      `registry changed after preview: expected ${expectedRegistrySha}, found ${registrySha}`,
    );
  }
  if (write && !Number.isInteger(expectedRepairCount)) {
    throw new Error('--write requires --expected-repair-count');
  }

  const registry = JSON.parse(originalBytes.toString('utf8').replace(/^\uFEFF/, ''));
  const enrollments = Array.isArray(registry.enrollments) ? registry.enrollments : [];
  const repairs = [];
  const blocked = [];

  for (let index = 0; index < enrollments.length; index += 1) {
    const enrollment = enrollments[index];
    const provenance = enrollment?.reference_provenance;
    if (provenance?.eligibility_basis !== 'legacy_trusted') continue;
    if (enrollmentRecordHash(enrollment) === provenance.enrollment_record_sha256) continue;

    try {
      const file = receiptFile(dataDir, provenance.receipt_path);
      const receiptBytes = fsApi.readFileSync(file);
      if (sha256(receiptBytes) !== provenance.receipt_sha256) {
        throw new Error('receipt byte hash mismatch');
      }
      const receipt = JSON.parse(receiptBytes.toString('utf8').replace(/^\uFEFF/, ''));
      const attested = receipt?.attested_record;
      if (
        receipt?.schema !== RECEIPT_SCHEMA ||
        receipt?.enrollment_id !== enrollment.enrollment_id ||
        !attested ||
        enrollmentRecordHash(attested) !== provenance.enrollment_record_sha256 ||
        receipt.attested_record_sha256 !== provenance.enrollment_record_sha256
      ) {
        throw new Error('receipt contract mismatch');
      }
      const current = { ...enrollment };
      delete current.reference_provenance;
      const keys = changedKeys(current, attested);
      const ordinary = keys.every((key) => ORDINARY_MUTABLE_METADATA.has(key));
      const aliasRetarget = aliasOnlyRetarget(current, attested, keys);
      if (!ordinary && !aliasRetarget) {
        throw new Error(`unapproved changed fields: ${keys.join(',')}`);
      }
      repairs.push({
        index,
        enrollment_id: enrollment.enrollment_id,
        stored_person_id: attested.person_id,
        current_person_id: current.person_id,
        changed_fields: keys,
        alias_retarget: aliasRetarget,
        attested,
        provenance,
      });
    } catch (error) {
      blocked.push({
        enrollment_id: enrollment?.enrollment_id || '',
        reason: error?.message || String(error),
      });
    }
  }

  const ok =
    blocked.length === 0 &&
    (!write || repairs.length === expectedRepairCount);
  if (write && repairs.length !== expectedRepairCount) {
    blocked.push({
      enrollment_id: '',
      reason: `repair count changed: expected ${expectedRepairCount}, found ${repairs.length}`,
    });
  }

  if (write && ok) {
    registry.person_id_aliases ||= {};
    for (const repair of repairs) {
      enrollments[repair.index] = {
        ...repair.attested,
        reference_provenance: repair.provenance,
      };
      if (repair.alias_retarget) {
        registry.person_id_aliases[repair.stored_person_id] = repair.current_person_id;
      }
    }
    const temp = `${registryPath}.restore-${process.pid}.tmp`;
    fsApi.writeFileSync(temp, `${JSON.stringify(registry, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o644,
    });
    fsApi.renameSync(temp, registryPath);
  }

  return {
    ok: ok && blocked.length === 0,
    write_requested: write,
    registry_sha256: registrySha,
    repair_count: repairs.length,
    alias_retarget_count: repairs.filter((row) => row.alias_retarget).length,
    changed_field_counts: repairs.reduce((counts, row) => {
      for (const key of row.changed_fields) counts[key] = (counts[key] || 0) + 1;
      return counts;
    }, {}),
    blocked,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(
      'Usage: node scripts/restore-attested-voice-reference-records.js [--write --expected-registry-sha HASH --expected-repair-count N] [--data-dir DIR] [--registry FILE]\n',
    );
    return;
  }
  const repo = path.resolve(__dirname, '..');
  const dataDir = path.resolve(args.dataDir || process.env.SECONDBRAIN_DATA_DIR || path.join(repo, 'data'));
  const registryPath = path.resolve(args.registryPath || path.join(dataDir, 'life-archive', 'voice-identity-registry.json'));
  const report = restoreAttestedVoiceReferenceRecords({
    ...args,
    dataDir,
    registryPath,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 2;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`voice reference restore failed: ${error?.message || error}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  aliasOnlyRetarget,
  changedKeys,
  restoreAttestedVoiceReferenceRecords,
};
