'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PROVENANCE_SCHEMA = 'life_archive_otter_architecture_provenance.v1';
const CORE_DOCUMENT_RELATIVE = path.join(
  'dev-plans',
  'core',
  'otter-transcript-pipeline.md',
);
const PRODUCER_CONTRACT_RELATIVE = path.join(
  'deploy',
  'voice-fargate',
  'otter-producer-contract.json',
);

function sha256File(file, fsApi = fs) {
  return crypto.createHash('sha256').update(fsApi.readFileSync(file)).digest('hex');
}

function canonicalCoreDocumentBytes(value) {
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
  return Buffer.from(text.replace(/\r\n|\r|\n/g, '\r\n'), 'utf8');
}

function sha256CoreDocument(file, fsApi = fs) {
  return crypto
    .createHash('sha256')
    .update(canonicalCoreDocumentBytes(fsApi.readFileSync(file)))
    .digest('hex');
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
}

function sha256ProducerContract(file, fsApi = fs) {
  const parsed = JSON.parse(fsApi.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  return crypto
    .createHash('sha256')
    .update(`${JSON.stringify(stableValue(parsed))}\n`)
    .digest('hex');
}

function compatibleProducerContract(left, right) {
  const leftContract = String(left?.producer_contract_sha256 || '').toLowerCase();
  const rightContract = String(right?.producer_contract_sha256 || '').toLowerCase();
  if (leftContract && rightContract) return leftContract === rightContract;
  return (
    String(left?.core_document_sha256 || '').toLowerCase() ===
    String(right?.core_document_sha256 || '').toLowerCase()
  );
}

function latestDeploySha(dataDir, fsApi = fs) {
  const file = path.join(dataDir, 'agent', 'ec2-deploy-receipts.jsonl');
  try {
    return (
      fsApi
        .readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line)];
          } catch {
            return [];
          }
        })
        .map((row) => String(row.repoHead || row.repo_head || row.sha || '').trim())
        .filter(Boolean)
        .at(-1) || ''
    );
  } catch {
    return '';
  }
}

function gitSourceSha(rootDir) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: rootDir,
    encoding: 'utf8',
    stdio: 'pipe',
    windowsHide: true,
    timeout: 10_000,
  });
  return result.status === 0 ? String(result.stdout || '').trim() : '';
}

function architectureProvenance({
  rootDir,
  dataDir,
  sourceSha = '',
  taskImageSourceSha = '',
  fsApi = fs,
} = {}) {
  const resolvedRoot = path.resolve(String(rootDir || path.join(__dirname, '..', '..')));
  const resolvedData = path.resolve(String(dataDir || path.join(resolvedRoot, 'data')));
  const coreFile = path.join(resolvedRoot, CORE_DOCUMENT_RELATIVE);
  const producerContractFile = path.join(resolvedRoot, PRODUCER_CONTRACT_RELATIVE);
  const deployedSourceSha =
    String(sourceSha || '').trim() ||
    String(process.env.SECONDBRAIN_SOURCE_SHA || '').trim() ||
    String(process.env.CODEBUILD_RESOLVED_SOURCE_VERSION || '').trim() ||
    latestDeploySha(resolvedData, fsApi) ||
    gitSourceSha(resolvedRoot);
  const imageSourceSha =
    String(taskImageSourceSha || '').trim() ||
    String(process.env.SECONDBRAIN_TASK_IMAGE_SOURCE_SHA || '').trim() ||
    String(process.env.SECONDBRAIN_SOURCE_SHA || '').trim() ||
    String(process.env.CODEBUILD_RESOLVED_SOURCE_VERSION || '').trim();
  if (!deployedSourceSha) {
    throw new Error('Otter architecture provenance lacks the deployed source SHA');
  }
  if (!fsApi.existsSync(coreFile) || !fsApi.statSync(coreFile).isFile()) {
    throw new Error(`Otter core contract is missing: ${coreFile}`);
  }
  const provenance = {
    schema: PROVENANCE_SCHEMA,
    source_sha: deployedSourceSha,
    task_image_source_sha: imageSourceSha || deployedSourceSha,
    core_document_path: CORE_DOCUMENT_RELATIVE.replace(/\\/g, '/'),
    core_document_sha256: sha256CoreDocument(coreFile, fsApi),
  };
  if (
    fsApi.existsSync(producerContractFile) &&
    fsApi.statSync(producerContractFile).isFile()
  ) {
    provenance.producer_contract_path = PRODUCER_CONTRACT_RELATIVE.replace(/\\/g, '/');
    provenance.producer_contract_sha256 = sha256ProducerContract(
      producerContractFile,
      fsApi,
    );
  }
  return provenance;
}

function architectureProvenanceOrFailure(options = {}) {
  try {
    return architectureProvenance(options);
  } catch (error) {
    return {
      schema: PROVENANCE_SCHEMA,
      source_sha: '',
      task_image_source_sha: '',
      core_document_path: CORE_DOCUMENT_RELATIVE.replace(/\\/g, '/'),
      core_document_sha256: '',
      producer_contract_path: PRODUCER_CONTRACT_RELATIVE.replace(/\\/g, '/'),
      producer_contract_sha256: '',
      load_error: String(error?.message || error),
    };
  }
}

function provenanceProblems(value) {
  const problems = [];
  if (String(value?.load_error || '').trim()) {
    problems.push(`architecture provenance could not be loaded: ${value.load_error}`);
  }
  if (value?.schema !== PROVENANCE_SCHEMA) problems.push('architecture provenance schema is invalid');
  if (!String(value?.source_sha || '').trim()) problems.push('deployed source SHA is missing');
  if (!String(value?.task_image_source_sha || '').trim()) {
    problems.push('task image source SHA is missing');
  }
  if (!String(value?.core_document_path || '').trim()) {
    problems.push('Otter core document path is missing');
  }
  if (!/^[a-f0-9]{64}$/.test(String(value?.core_document_sha256 || '').toLowerCase())) {
    problems.push('Otter core document hash is invalid');
  }
  const contractPath = String(value?.producer_contract_path || '').trim();
  const contractHash = String(value?.producer_contract_sha256 || '').toLowerCase();
  if (contractPath || contractHash) {
    if (!contractPath) problems.push('Otter producer contract path is missing');
    if (!/^[a-f0-9]{64}$/.test(contractHash)) {
      problems.push('Otter producer contract hash is invalid');
    }
  }
  return problems;
}

module.exports = {
  CORE_DOCUMENT_RELATIVE,
  PRODUCER_CONTRACT_RELATIVE,
  PROVENANCE_SCHEMA,
  architectureProvenance,
  architectureProvenanceOrFailure,
  canonicalCoreDocumentBytes,
  compatibleProducerContract,
  gitSourceSha,
  latestDeploySha,
  provenanceProblems,
  sha256CoreDocument,
  sha256ProducerContract,
  sha256File,
};
