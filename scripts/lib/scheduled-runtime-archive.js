'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { uploadFile } = require('./cloud-archive.js');
const {
  loadStateOwnership,
  shouldArchiveCurrentRuntime,
} = require('./scheduled-write-ownership.js');
const {
  NIGHTLY_SKILL,
  VIDEO_RESEARCH_SKILL,
  validateNightlyArtifacts,
  validateGenericRuntimeArtifacts,
} = require('./scheduled-skill-runtime-artifacts.js');

const RUNTIME_SET_SCHEMA = 'amy.runtime_artifact_set.v1';

function repoArtifactToRuntimeRelative(rel) {
  const normalized = String(rel || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized.startsWith('data/') || normalized.split('/').includes('..')) {
    throw new Error(`invalid registered runtime artifact path: ${rel}`);
  }
  return normalized.slice('data/'.length);
}

function resolveRuntimeDateTemplate(rel, scheduleDate) {
  const normalized = String(rel || '').replace(/\\/g, '/');
  if (!normalized.includes('<date>')) return normalized;
  const date = String(scheduleDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`runtime artifact schedule date is required for ${rel}`);
  }
  return normalized.replaceAll('<date>', date);
}

function archiveSettings(registry) {
  const row = registry.runtime_archive || {};
  if (!row.bucket || !row.region || !row.current_prefix) {
    throw new Error('state ownership registry lacks runtime_archive bucket, region, or prefix');
  }
  return row;
}

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function runtimeSetManifestKey(skillName, settings) {
  const safeSkill = String(skillName || '').replace(/[^A-Za-z0-9._-]+/g, '-');
  if (!safeSkill) throw new Error('runtime set manifest requires a skill name');
  return `${String(settings.current_prefix).replace(/\/+$/, '')}/manifests/${safeSkill}.json`;
}

function archiveRuntimeArtifactsForExecutor({
  executorOwnership,
  archive = archiveRuntimeArtifacts,
  ...options
} = {}) {
  if (!shouldArchiveCurrentRuntime({ executorOwnership })) {
    return {
      ok: true,
      skipped: true,
      files: [],
      reason: 'the registered automatic owner alone may update the S3 current prefix',
    };
  }
  return archive(options);
}

function nightlyScheduleDate(runtimeDataDir) {
  const receiptPath = path.join(runtimeDataDir, 'agent', 'backlog-research-receipt.json');
  try {
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    const date = String(receipt.date || '').slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  } catch {
    // The full validator below provides the actionable failure.
  }
  return '';
}

function jobRuntimePaths(skillName, registry, { scheduleDate, allowUnresolved = false } = {}) {
  const job = registry.scheduled_jobs[String(skillName || '')];
  if (!job) throw new Error(`scheduled job is not registered: ${skillName}`);
  const paths = Array.isArray(job.runtime_outputs) ? job.runtime_outputs : [];
  if (!paths.length) throw new Error(`scheduled job has no registered runtime outputs: ${skillName}`);
  return paths.map((repoRel) => {
    const resolved =
      allowUnresolved && String(repoRel).includes('<date>') && !scheduleDate
        ? String(repoRel)
        : resolveRuntimeDateTemplate(repoRel, scheduleDate);
    return { repoRel: resolved, runtimeRel: repoArtifactToRuntimeRelative(resolved) };
  });
}

function archiveRuntimeArtifacts({
  skillName,
  runtimeDataDir,
  registry = loadStateOwnership(),
  upload = uploadFile,
  scheduleDate,
} = {}) {
  const settings = archiveSettings(registry);
  const rows = jobRuntimePaths(skillName, registry, { scheduleDate });
  // Freeze the complete set before hashing or uploading any member. The old
  // path uploaded directly from the live runtime directory, so a 55 MB JSONL
  // append between the local SHA pass and S3 verification produced a torn set.
  // Worse, the late archive failure made the scheduled skill replay research
  // that had already published and landed. Every upload below now reads the
  // same private snapshot, and a failed archive can be retried from the
  // runner-owned staging directory without recomputing the skill.
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'secondbrain-runtime-set-'));
  try {
    for (const row of rows) {
      const source = path.join(runtimeDataDir, row.runtimeRel);
      if (!fs.existsSync(source)) throw new Error(`runtime archive source is missing: ${source}`);
      const frozen = path.join(stage, row.runtimeRel);
      fs.mkdirSync(path.dirname(frozen), { recursive: true });
      fs.copyFileSync(source, frozen);
    }

    const archiveScheduleDate =
      skillName === NIGHTLY_SKILL
        ? nightlyScheduleDate(stage)
        : skillName === VIDEO_RESEARCH_SKILL
          ? String(scheduleDate || '').slice(0, 10)
          : '';
    const validation =
      skillName === NIGHTLY_SKILL
        ? validateNightlyArtifacts(stage, { scheduleDate: archiveScheduleDate })
        : skillName === VIDEO_RESEARCH_SKILL
          ? validateGenericRuntimeArtifacts(
              stage,
              rows.map((row) => row.runtimeRel),
              { skillName, scheduleDate: archiveScheduleDate },
            )
          : { ok: true, failures: [] };
    if (
      (skillName === NIGHTLY_SKILL || skillName === VIDEO_RESEARCH_SKILL) &&
      (!archiveScheduleDate || !validation.ok)
    ) {
      throw new Error(
        `refusing to archive an incoherent ${skillName} runtime set: ${validation.failures.join('; ') || 'missing schedule date'}`,
      );
    }

    const receipts = [];
    for (const row of rows) {
      const source = path.join(stage, row.runtimeRel);
      const receipt = upload(source, {
        bucket: settings.bucket,
        region: settings.region,
        key: `${String(settings.current_prefix).replace(/\/+$/, '')}/${row.repoRel}`,
        requireChecksumSha256: true,
      });
      if (!receipt.versionId || !receipt.sha256) {
        throw new Error(`runtime archive lacks version/hash proof for ${row.repoRel}`);
      }
      receipts.push({ ...receipt, repoRel: row.repoRel });
    }

    const manifest = {
      schema: RUNTIME_SET_SCHEMA,
      skill: skillName,
      created_at: new Date().toISOString(),
      schedule_date:
        (skillName === NIGHTLY_SKILL || skillName === VIDEO_RESEARCH_SKILL
          ? archiveScheduleDate
          : String(scheduleDate || '').slice(0, 10)) || null,
      files: receipts.map((row) => ({
        repo_rel: row.repoRel,
        key: row.key,
        version_id: row.versionId,
        sha256: row.sha256,
        bytes: row.bytes,
      })),
    };
    const manifestPath = path.join(stage, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    const manifestReceipt = upload(manifestPath, {
      bucket: settings.bucket,
      region: settings.region,
      key: runtimeSetManifestKey(skillName, settings),
      requireChecksumSha256: true,
    });
    if (!manifestReceipt.versionId || !manifestReceipt.sha256) {
      throw new Error('runtime set manifest lacks version/hash proof');
    }
    return {
      ok: true,
      files: receipts.map((row) => row.key),
      receipts,
      manifest,
      manifestReceipt,
    };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

function atomicReplace(target, source) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.copyFileSync(source, temp);
  fs.renameSync(temp, target);
}

function runAwsDefault(args) {
  const result = spawnSync('aws', args, {
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
  };
}

function readSetManifest(file, { skillName, rows } = {}) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`runtime set manifest is missing or invalid: ${error.message}`);
  }
  if (manifest.schema !== RUNTIME_SET_SCHEMA || manifest.skill !== skillName) {
    throw new Error('runtime set manifest schema or skill does not match the requested job');
  }
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  const expected = rows
    .map((row) => resolveRuntimeDateTemplate(row.repoRel, manifest.schedule_date))
    .sort();
  const actual = files.map((row) => String(row.repo_rel || '')).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('runtime set manifest does not name the complete registered output set');
  }
  for (const row of files) {
    if (!row.key || !row.version_id || !/^[a-f0-9]{64}$/i.test(String(row.sha256 || ''))) {
      throw new Error(`runtime set manifest lacks key, version, or SHA-256 for ${row.repo_rel}`);
    }
  }
  return manifest;
}

function refreshRuntimeArtifactsFromArchive({
  skillName,
  runtimeDataDir,
  registry = loadStateOwnership(),
  runAws = runAwsDefault,
} = {}) {
  const settings = archiveSettings(registry);
  const rows = jobRuntimePaths(skillName, registry, { allowUnresolved: true });
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'secondbrain-runtime-refresh-'));
  try {
    const manifestPath = path.join(stage, 'set-manifest.json');
    const manifestKey = runtimeSetManifestKey(skillName, settings);
    const manifestDownload = runAws([
      's3',
      'cp',
      `s3://${settings.bucket}/${manifestKey}`,
      manifestPath,
      '--region',
      settings.region,
      '--only-show-errors',
      '--no-progress',
    ]);
    if (!manifestDownload.ok) {
      return {
        ok: false,
        reason: `runtime set manifest download failed: ${manifestDownload.stderr || manifestDownload.status}`,
        files: [],
      };
    }
    let manifest;
    try {
      manifest = readSetManifest(manifestPath, { skillName, rows });
    } catch (error) {
      return { ok: false, reason: error.message, files: [] };
    }

    const resolvedRows = jobRuntimePaths(skillName, registry, {
      scheduleDate: manifest.schedule_date,
    });
    for (const row of resolvedRows) {
      const pinned = manifest.files.find((item) => item.repo_rel === row.repoRel);
      const target = path.join(stage, row.runtimeRel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const result = runAws([
        's3api',
        'get-object',
        '--bucket',
        settings.bucket,
        '--key',
        pinned.key,
        '--version-id',
        pinned.version_id,
        '--region',
        settings.region,
        target,
      ]);
      if (!result.ok) {
        return {
          ok: false,
          reason: `archive download failed for ${row.repoRel}: ${result.stderr || result.status}`,
          files: [],
        };
      }
      const observed = sha256File(target);
      if (observed !== pinned.sha256) {
        return {
          ok: false,
          reason: `archive SHA-256 mismatch for ${row.repoRel}`,
          files: [],
        };
      }
    }
    const validation =
      skillName === NIGHTLY_SKILL
        ? validateNightlyArtifacts(stage, { scheduleDate: manifest.schedule_date })
        : skillName === VIDEO_RESEARCH_SKILL
          ? validateGenericRuntimeArtifacts(
              stage,
              resolvedRows.map((row) => row.runtimeRel),
              { skillName, scheduleDate: manifest.schedule_date },
            )
          : { ok: true, failures: [] };
    if (!validation.ok) {
      return {
        ok: false,
        reason: `downloaded ${skillName} runtime set failed validation: ${validation.failures.join('; ')}`,
        files: [],
      };
    }
    for (const row of resolvedRows) {
      atomicReplace(path.join(runtimeDataDir, row.runtimeRel), path.join(stage, row.runtimeRel));
    }
    return { ok: true, files: resolvedRows.map((row) => row.runtimeRel) };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

module.exports = {
  RUNTIME_SET_SCHEMA,
  archiveRuntimeArtifacts,
  archiveRuntimeArtifactsForExecutor,
  readSetManifest,
  refreshRuntimeArtifactsFromArchive,
  repoArtifactToRuntimeRelative,
  runtimeSetManifestKey,
};
