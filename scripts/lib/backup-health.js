const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { lifeArchiveSnapshotFreshness } = require('./life-archive-freshness.js');

const BACKUP_HEALTH_SCHEMA = 'secondbrain.backup_health.v1';
const RESTORE_PROOF_SCHEMA = 'secondbrain.backup_restore_proof.v1';
const DEFAULT_BUCKET = 'ExampleCo-secondbrain-backups';
const HEALTH_LOG_RELATIVE = path.join('agent', 'health-heal.jsonl');
const RESTORE_PROOF_RELATIVE = path.join('agent', 'backup-restore-proof-latest.json');
const COVERAGE_RELATIVE = path.join('life-archive', 'health-latest.json');
const OUTPUT_RELATIVE = path.join('agent', 'backup-health-latest.json');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function parseJsonFile(file, fsApi = fs) {
  try {
    const bytes = fsApi.readFileSync(file);
    return { value: JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')), sha256: sha256(bytes) };
  } catch {
    return null;
  }
}

function latestBackupHealthLine(file, fsApi = fs) {
  let lines;
  try {
    lines = fsApi.readFileSync(file, 'utf8').split(/\r?\n/);
  } catch {
    return null;
  }
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const raw = String(lines[index] || '').trim();
    if (!raw) continue;
    try {
      const value = JSON.parse(raw);
      if (value?.final?.backups && value?.final?.s3Parity) {
        return { value, sha256: sha256(Buffer.from(raw, 'utf8')) };
      }
    } catch {
      // Ignore incomplete trailing writes and keep looking for the latest valid receipt.
    }
  }
  return null;
}

function ageHours(timestamp, now) {
  const then = Date.parse(String(timestamp || ''));
  const current = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(then) || !Number.isFinite(current) || then > current + 5 * 60_000) return null;
  return (current - then) / 3_600_000;
}

function snapshotKeyFromHealth(health) {
  const explicit = String(health?.final?.backups?.snapshotKey || '').trim();
  if (/^snapshots\/[0-9]{8}T[0-9]{6}_[0-9]+\.zip$/.test(explicit)) return explicit;
  const detail = String(health?.final?.backups?.detail || '');
  const match = detail.match(/(?:^|\s|\/)([0-9]{8}T[0-9]{6}_[0-9]+\.zip)(?:\s|\(|$)/);
  return match ? `snapshots/${match[1]}` : '';
}

function coverageSummary(coverage, now) {
  const proof = coverage?.value;
  const verification = proof?.s3_verification;
  const freshness = lifeArchiveSnapshotFreshness(proof, now);
  const checked = Number(verification?.checked_prefixes);
  const required = Number(verification?.required_prefixes);
  const verified =
    freshness.fresh &&
    proof?.proof_complete === true &&
    verification?.performed === true &&
    checked > 0 &&
    checked === required &&
    Array.isArray(verification?.errors) &&
    verification.errors.length === 0;
  return { verified, checked, required };
}

function assessBackupHealth({ health, restore, coverage, now = new Date(), bucket = DEFAULT_BUCKET }) {
  const coverageState = coverageSummary(coverage, now);
  const fail = (reason) => ({
    status: 'red',
    detail: `${reason}${coverageState.verified ? ` Separate life-archive coverage is ${coverageState.checked}/${coverageState.required}; it does not prove snapshot restore.` : ''}`,
  });

  if (!health) return fail('No durable backup completion receipt exists.');
  const healthAge = ageHours(health.value?.ts, now);
  if (healthAge == null || healthAge > 30) return fail('The backup completion receipt is missing a current timestamp or is older than 30 hours.');
  if (health.value?.final?.backups?.status !== 'green') return fail('The current backup completion receipt does not prove a successful S3 snapshot.');
  const snapshotAge = ageHours(health.value?.final?.backups?.lastModified, now);
  if (snapshotAge == null || snapshotAge > 30) return fail('The current backup completion receipt does not prove a snapshot created within 30 hours from its S3 LastModified timestamp.');
  if (health.value?.final?.s3Parity?.status !== 'green') return fail('The current backup completion receipt does not prove local-to-S3 parity.');
  if (!Array.isArray(health.value?.final?.s3Parity?.orphans) || health.value.final.s3Parity.orphans.length > 0) return fail('The current backup completion receipt has incomplete local-to-S3 parity evidence.');
  const snapshotKey = snapshotKeyFromHealth(health.value);
  if (!snapshotKey) return fail('The current backup completion receipt does not identify the S3 snapshot object.');

  if (!restore) return fail(`Snapshot ${snapshotKey} is current, but no durable restore verification receipt exists.`);
  const proof = restore.value;
  const restoreAge = ageHours(proof?.checkedAt, now);
  if (proof?.schema !== RESTORE_PROOF_SCHEMA) return fail('The restore verification receipt has an unknown schema.');
  if (restoreAge == null || restoreAge > 8 * 24) return fail('The restore verification receipt is missing a current timestamp or is older than eight days.');
  if (proof?.status !== 'green' || proof?.restoreVerified !== true) return fail('The restore verification receipt did not prove a successful restore.');
  if (proof?.source?.bucket !== bucket || proof?.source?.objectKey !== snapshotKey) return fail('The restore verification receipt is for a different bucket or snapshot object.');
  if (proof?.source?.healthReceiptSha256 !== health.sha256) return fail('The restore verification receipt is not bound to the current backup completion receipt.');
  if (!/^[a-f0-9]{64}$/.test(String(proof?.source?.archiveSha256 || ''))) return fail('The restore verification receipt lacks the restored archive hash.');
  if (!/^(?:"[a-fA-F0-9-]+"|[a-fA-F0-9-]+)$/.test(String(proof?.source?.objectEtag || ''))) return fail('The restore verification receipt lacks the S3 object identity.');
  if (!Number.isInteger(proof?.checkedFiles) || proof.checkedFiles <= 0) return fail('The restore verification receipt contains no checked files.');

  return {
    status: 'green',
    detail: `Current S3 snapshot ${snapshotKey.split('/').pop()} has local-to-S3 parity and a hash-bound restore proof (${proof.checkedFiles} files checked).`,
    snapshotKey,
    healthReceiptSha256: health.sha256,
    restoreReceiptSha256: restore.sha256,
  };
}

function sourceFiles(dataDir) {
  return {
    health: path.join(dataDir, HEALTH_LOG_RELATIVE),
    restore: path.join(dataDir, RESTORE_PROOF_RELATIVE),
    coverage: path.join(dataDir, COVERAGE_RELATIVE),
    output: path.join(dataDir, OUTPUT_RELATIVE),
  };
}

function buildBackupHealthReceipt({ dataDir, now = new Date(), bucket = DEFAULT_BUCKET, fsApi = fs }) {
  const files = sourceFiles(dataDir);
  const health = latestBackupHealthLine(files.health, fsApi);
  const restore = parseJsonFile(files.restore, fsApi);
  const coverage = parseJsonFile(files.coverage, fsApi);
  const result = assessBackupHealth({ health, restore, coverage, now, bucket });
  return {
    schema: BACKUP_HEALTH_SCHEMA,
    generatedAt: now.toISOString(),
    status: result.status,
    detail: result.detail,
    source: {
      bucket,
      healthReceipt: HEALTH_LOG_RELATIVE.replace(/\\/g, '/'),
      healthReceiptSha256: health?.sha256 || null,
      restoreReceipt: RESTORE_PROOF_RELATIVE.replace(/\\/g, '/'),
      restoreReceiptSha256: restore?.sha256 || null,
      coverageReceipt: COVERAGE_RELATIVE.replace(/\\/g, '/'),
      snapshotKey: result.snapshotKey || null,
    },
  };
}

function writeBackupHealthReceipt(options) {
  const fsApi = options.fsApi || fs;
  const receipt = buildBackupHealthReceipt(options);
  const output = sourceFiles(options.dataDir).output;
  fsApi.mkdirSync(path.dirname(output), { recursive: true });
  const temp = `${output}.${process.pid}.tmp`;
  fsApi.writeFileSync(temp, JSON.stringify(receipt, null, 2) + '\n', 'utf8');
  fsApi.renameSync(temp, output);
  return receipt;
}

function readBackupHealthReceipt({ dataDir, now = new Date(), maxAgeHours = 30, fsApi = fs }) {
  const files = sourceFiles(dataDir);
  const parsed = parseJsonFile(files.output, fsApi);
  if (!parsed || parsed.value?.schema !== BACKUP_HEALTH_SCHEMA) {
    return { status: 'red', detail: 'No valid backup health receipt exists.' };
  }
  const receipt = parsed.value;
  const age = ageHours(receipt.generatedAt, now);
  if (age == null || age > maxAgeHours) return { status: 'red', detail: 'The backup health receipt is stale or undated.' };
  const current = buildBackupHealthReceipt({ dataDir, now, bucket: receipt.source?.bucket || DEFAULT_BUCKET, fsApi });
  if (
    receipt.source?.healthReceiptSha256 !== current.source.healthReceiptSha256 ||
    receipt.source?.restoreReceiptSha256 !== current.source.restoreReceiptSha256
  ) {
    return { status: 'red', detail: 'Backup source receipts changed after the health receipt was written.' };
  }
  return { status: receipt.status === 'green' && current.status === 'green' ? 'green' : 'red', detail: current.detail };
}

module.exports = {
  BACKUP_HEALTH_SCHEMA,
  DEFAULT_BUCKET,
  RESTORE_PROOF_SCHEMA,
  assessBackupHealth,
  buildBackupHealthReceipt,
  latestBackupHealthLine,
  readBackupHealthReceipt,
  snapshotKeyFromHealth,
  writeBackupHealthReceipt,
};
