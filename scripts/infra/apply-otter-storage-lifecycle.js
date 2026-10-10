#!/usr/bin/env node
'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const OWNED_RULE_IDS = [
  'secondbrain-otter-raw-cold-tier',
  'secondbrain-otter-derived-audio-cold-tier',
  'secondbrain-otter-full-audio-cold-tier',
];

function transitionRule({ id, prefix }) {
  return {
    ID: id,
    Status: 'Enabled',
    Filter: { Prefix: prefix },
    Transitions: [
      { Days: 30, StorageClass: 'STANDARD_IA' },
      { Days: 90, StorageClass: 'GLACIER_IR' },
    ],
    NoncurrentVersionTransitions: [
      { NoncurrentDays: 30, StorageClass: 'STANDARD_IA' },
      { NoncurrentDays: 90, StorageClass: 'GLACIER_IR' },
    ],
    AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
  };
}

function buildOwnedRules({
  rawPrefix = 'data-lake/secondbrain/otter/raw/',
  derivedPrefix = 'data-lake/secondbrain/otter/derived-audio/',
  fullAudioPrefix = 'data-lake/secondbrain/otter/full-audio/',
} = {}) {
  return [
    transitionRule({
      id: OWNED_RULE_IDS[0],
      prefix: rawPrefix,
    }),
    transitionRule({
      id: OWNED_RULE_IDS[1],
      prefix: derivedPrefix,
    }),
    transitionRule({
      id: OWNED_RULE_IDS[2],
      prefix: fullAudioPrefix,
    }),
  ];
}

function mergeLifecycleRules(current = {}, ownedRules = buildOwnedRules()) {
  const ownedIds = new Set(ownedRules.map((rule) => rule.ID));
  return {
    Rules: [
      ...(Array.isArray(current.Rules)
        ? current.Rules.filter((rule) => !ownedIds.has(rule.ID))
        : []),
      ...ownedRules,
    ],
  };
}

async function runAws(args) {
  const result = await execFileAsync('aws', args, {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  return String(result.stdout || '');
}

async function accountId({ region, runAwsFn = runAws }) {
  const value = (
    process.env.SECONDBRAIN_AWS_ACCOUNT_ID ||
    (
      await runAwsFn([
        'sts',
        'get-caller-identity',
        '--region',
        region,
        '--query',
        'Account',
        '--output',
        'text',
      ])
    ).trim()
  );
  if (!/^\d{12}$/.test(value)) {
    throw new Error(`Cannot resolve a valid AWS account ID: ${value || 'empty'}`);
  }
  return value;
}

async function readCurrentLifecycle({ bucket, region, runAwsFn = runAws }) {
  try {
    return JSON.parse(
      await runAwsFn([
        's3api',
        'get-bucket-lifecycle-configuration',
        '--region',
        region,
        '--bucket',
        bucket,
        '--output',
        'json',
      ]),
    );
  } catch (error) {
    const detail = String(error?.stderr || error?.message || error);
    if (/NoSuchLifecycleConfiguration/i.test(detail)) return { Rules: [] };
    throw error;
  }
}

async function readBucketVersioning({ bucket, region, runAwsFn = runAws }) {
  const value = JSON.parse(
    await runAwsFn([
      's3api',
      'get-bucket-versioning',
      '--region',
      region,
      '--bucket',
      bucket,
      '--output',
      'json',
    ]),
  );
  return String(value.Status || 'Disabled');
}

async function main({
  argv = process.argv.slice(2),
  env = process.env,
  runAwsFn = runAws,
} = {}) {
  const mode = argv.includes('--apply') ? 'apply' : 'dry_run';
  const region = env.AWS_REGION || 'us-east-1';
  const account = await accountId({ region, runAwsFn });
  const bucket = env.SECONDBRAIN_BACKUP_BUCKET || `${account}-secondbrain-backups`;
  const ownedRules = buildOwnedRules({
    rawPrefix:
      env.OTTER_RAW_ARCHIVE_PREFIX || 'data-lake/secondbrain/otter/raw/',
    derivedPrefix:
      env.OTTER_DERIVED_AUDIO_ARCHIVE_PREFIX ||
      'data-lake/secondbrain/otter/derived-audio/',
    fullAudioPrefix:
      env.OTTER_FULL_AUDIO_ARCHIVE_PREFIX ||
      'data-lake/secondbrain/otter/full-audio/',
  });
  const current = await readCurrentLifecycle({ bucket, region, runAwsFn });
  const versioningStatus = await readBucketVersioning({
    bucket,
    region,
    runAwsFn,
  });
  const merged = mergeLifecycleRules(current, ownedRules);
  const ownedIds = new Set(OWNED_RULE_IDS);
  const report = {
    mode,
    bucket,
    versioning_status: versioningStatus,
    warnings:
      versioningStatus === 'Enabled'
        ? []
        : ['Noncurrent-version transitions require bucket versioning to be Enabled.'],
    preserved_unrelated_rules: merged.Rules.filter(
      (rule) => !ownedIds.has(rule.ID),
    ).map((rule) => rule.ID),
    proposed_rules: merged.Rules.filter((rule) => ownedIds.has(rule.ID)),
  };

  if (mode === 'apply') {
    if (versioningStatus !== 'Enabled') {
      throw new Error(
        `Refusing lifecycle apply: bucket versioning is ${versioningStatus}`,
      );
    }
    await runAwsFn([
      's3api',
      'put-bucket-lifecycle-configuration',
      '--region',
      region,
      '--bucket',
      bucket,
      '--lifecycle-configuration',
      JSON.stringify(merged),
    ]);
    report.applied = true;
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${String(error?.stack || error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  OWNED_RULE_IDS,
  accountId,
  runAws,
  buildOwnedRules,
  mergeLifecycleRules,
  readBucketVersioning,
  readCurrentLifecycle,
  main,
};
