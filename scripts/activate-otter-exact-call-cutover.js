#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  ENVELOPE_SCHEMA,
  loadCompletionEnvelope,
  readCutoverMarker,
  writeCutoverMarker,
  writeHistoricalCutoverAuthorization,
} = require('./lib/otter-exact-call-envelope.js');
const {
  architectureProvenance,
} = require('./lib/otter-architecture-provenance.js');

const ROOT = path.resolve(process.env.SECONDBRAIN_ROOT || path.join(__dirname, '..'));
const DATA_DIR = path.resolve(
  process.env.SECONDBRAIN_DATA_DIR || path.join(ROOT, 'data'),
);

function arg(argv, name, fallback = '') {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}

function cutoverError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      const unreadable = cutoverError(
        `Otter cutover input is unreadable: ${file}: ${error.message}`,
        'OTTER_CUTOVER_INPUT_UNREADABLE',
      );
      unreadable.cause = error;
      throw unreadable;
    }
    return fallback;
  }
}

function landedAtMs(call) {
  const value = Date.parse(String(call?.landed_at || ''));
  return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

function newestCallFirst(left, right) {
  return (
    landedAtMs(right) - landedAtMs(left) ||
    String(right?.otid || '').localeCompare(String(left?.otid || ''))
  );
}

function ledgerProducerSha(call) {
  return String(call?.exact_completion_envelope?.producer_sha || '').trim();
}

function loadedProducerSha(loaded) {
  return String(
    loaded?.envelope?.architecture_provenance?.task_image_source_sha ||
      loaded?.envelope?.producer_sha ||
      '',
  ).trim();
}

function loadVerifiedCandidate({ dataDir, call, loadEnvelope }) {
  const loaded = loadEnvelope({
    dataDir,
    otid: call.otid,
    sourceRevisionHash: call.source_revision_hash,
  });
  return loaded?.ok ? { call, loaded } : null;
}

function verifiedEnvelopeCandidates({
  dataDir = DATA_DIR,
  producerSha = '',
  otid = '',
  sourceRevisionHash = '',
  loadEnvelope = loadCompletionEnvelope,
} = {}) {
  const ledgerFile = path.join(
    dataDir,
    'life-archive',
    'voiceprints',
    'otter-call-processing-ledger-latest.json',
  );
  const ledger = readJson(ledgerFile, null);
  const candidates = (ledger?.calls || [])
    .filter((call) => call?.exact_completion_envelope?.verified === true)
    .filter((call) => !otid || String(call?.otid || '') === String(otid))
    .filter(
      (call) =>
        !sourceRevisionHash ||
        String(call?.source_revision_hash || '').toLowerCase() ===
          String(sourceRevisionHash).toLowerCase(),
    )
    .sort(newestCallFirst);
  const requestedProducerSha = String(producerSha || '').trim();

  if (requestedProducerSha) {
    // Modern ledger rows already pin the producer that minted the envelope.
    // Use that cheap index before opening the envelope and hashing its full
    // transcript/audio/artifact set. Only legacy rows without the index need
    // the old verification path.
    const indexedMatches = candidates.filter(
      (call) => ledgerProducerSha(call) === requestedProducerSha,
    );
    const legacyRows = candidates.filter((call) => !ledgerProducerSha(call));
    for (const call of [...indexedMatches, ...legacyRows]) {
      const candidate = loadVerifiedCandidate({ dataDir, call, loadEnvelope });
      if (!candidate) continue;
      if (loadedProducerSha(candidate.loaded) !== requestedProducerSha) continue;
      // Every caller asking for one producer consumes only the newest valid
      // proof. Do not continue re-hashing older calls after proof is complete.
      return [candidate];
    }
    return [];
  }

  // Reconciliation may need to compare producer releases, but it does not
  // need every call ever produced by each release. Verify the newest valid
  // envelope per indexed producer. If that envelope is corrupt, fall back
  // within that producer group until one verifies. Legacy unindexed rows keep
  // the compatibility path and are collapsed by their loaded producer SHA.
  const groups = new Map();
  const legacyRows = [];
  for (const call of candidates) {
    const indexedProducer = ledgerProducerSha(call);
    if (!indexedProducer) {
      legacyRows.push(call);
      continue;
    }
    if (!groups.has(indexedProducer)) groups.set(indexedProducer, []);
    groups.get(indexedProducer).push(call);
  }

  const verified = [];
  for (const [indexedProducer, calls] of groups.entries()) {
    for (const call of calls) {
      const candidate = loadVerifiedCandidate({ dataDir, call, loadEnvelope });
      if (!candidate) continue;
      if (loadedProducerSha(candidate.loaded) !== indexedProducer) continue;
      verified.push(candidate);
      break;
    }
  }

  // Once the ledger has modern producer-indexed rows, they are the bounded
  // reconciliation authority. Do not descend into every legacy unindexed
  // archive after checking them: that recreated the multi-year transcript and
  // audio rehash during a rare producer fallback. If none of the indexed
  // proofs matches the current consumer contract, reconciliation fails closed
  // and requires an explicit repair instead of an unbounded historical scan.
  if (groups.size > 0) {
    return verified.sort((left, right) => newestCallFirst(left.call, right.call));
  }

  const legacyByProducer = new Map();
  for (const call of legacyRows) {
    const candidate = loadVerifiedCandidate({ dataDir, call, loadEnvelope });
    if (!candidate) continue;
    const actualProducer = loadedProducerSha(candidate.loaded);
    if (!actualProducer || legacyByProducer.has(actualProducer)) continue;
    legacyByProducer.set(actualProducer, candidate);
  }
  verified.push(...legacyByProducer.values());
  return verified.sort((left, right) => newestCallFirst(left.call, right.call));
}

function strictProducerContract(producer, consumer) {
  const producerContract = String(
    producer?.producer_contract_sha256 || '',
  ).toLowerCase();
  const consumerContract = String(
    consumer?.producer_contract_sha256 || '',
  ).toLowerCase();
  return (
    /^[a-f0-9]{64}$/.test(producerContract) &&
    /^[a-f0-9]{64}$/.test(consumerContract) &&
    producerContract === consumerContract
  );
}

function activateCutover({
  dataDir = DATA_DIR,
  rootDir = ROOT,
  producerSha,
  consumerSha,
  activatedAt = new Date().toISOString(),
} = {}) {
  if (!producerSha || !consumerSha) {
    throw new Error('cutover activation requires explicit producer and consumer SHAs');
  }
  const consumer = architectureProvenance({
    rootDir,
    dataDir,
  });
  if (consumer.source_sha !== consumerSha) {
    throw cutoverError(
      `live consumer source SHA ${consumer.source_sha} does not match requested cutover SHA ${consumerSha}`,
      'OTTER_CONSUMER_SHA_MISMATCH',
    );
  }
  const proof =
    verifiedEnvelopeCandidates({ dataDir, producerSha })[0] || null;
  if (!proof) {
    throw cutoverError(
      `no verified canonical exact-call envelope proves producer image SHA ${producerSha}`,
      'OTTER_PRODUCER_PROOF_UNAVAILABLE',
    );
  }
  const producerArchitecture =
    proof.loaded.envelope.architecture_provenance;
  if (
    !String(producerArchitecture?.producer_contract_sha256 || '').trim()
  ) {
    throw cutoverError(
      'active exact-call producer proof lacks a producer-contract hash',
      'OTTER_PRODUCER_CONTRACT_MISSING',
    );
  }
  if (!strictProducerContract(producerArchitecture, consumer)) {
    throw cutoverError(
      'producer and consumer Otter producer contracts differ',
      'OTTER_PRODUCER_CONTRACT_MISMATCH',
    );
  }
  const producerContractSha256 = consumer.producer_contract_sha256;
  const marker = writeCutoverMarker({
    dataDir,
    activatedAt,
    producerSha,
    consumerSha,
    coreDocumentSha256: consumer.core_document_sha256,
    producerContractSha256,
    envelopeSchema: ENVELOPE_SCHEMA,
    note: `Activated after verified shadow bundle ${proof.loaded.envelope.bundle_hash} from ${proof.call.otid}.`,
  });
  return {
    ok: true,
    marker: marker.value,
    marker_path: marker.path,
    shadow_proof: {
      otid: proof.call.otid,
      source_revision_hash: proof.call.source_revision_hash,
      bundle_hash: proof.loaded.envelope.bundle_hash,
      envelope_path: proof.loaded.file,
      core_document_sha256: consumer.core_document_sha256,
      producer_contract_sha256: producerContractSha256,
    },
  };
}

function newestCompatibleVerifiedProducer({
  dataDir = DATA_DIR,
  rootDir = ROOT,
} = {}) {
  const consumer = architectureProvenance({
    rootDir,
    dataDir,
  });
  for (const { call, loaded } of verifiedEnvelopeCandidates({ dataDir })) {
    const architecture = loaded.envelope?.architecture_provenance;
    if (
      String(architecture?.task_image_source_sha || '').trim() &&
      strictProducerContract(architecture, consumer)
    ) {
      return {
        producerSha: architecture.task_image_source_sha,
        consumer,
        call,
        loaded,
      };
    }
  }
  return null;
}

function authorizeHistoricalProducer({
  dataDir = DATA_DIR,
  producerSha,
  otid = '',
  sourceRevisionHash = '',
  authorizedAt = new Date().toISOString(),
} = {}) {
  if (!producerSha) {
    throw new Error('historical producer authorization requires an explicit producer SHA');
  }
  const proof =
    verifiedEnvelopeCandidates({
      dataDir,
      producerSha,
      otid,
      sourceRevisionHash,
    })[0] || null;
  if (!proof) {
    throw cutoverError(
      `no verified canonical exact-call envelope proves historical producer image SHA ${producerSha}`,
      'OTTER_HISTORICAL_PRODUCER_PROOF_UNAVAILABLE',
    );
  }
  const architecture = proof.loaded.envelope.architecture_provenance;
  const authorization = writeHistoricalCutoverAuthorization({
    dataDir,
    authorizedAt,
    producerSha,
    coreDocumentSha256: architecture.core_document_sha256,
    producerContractSha256: architecture.producer_contract_sha256 || '',
    envelopeSchema: proof.loaded.envelope.schema,
    proof: {
      otid: proof.call.otid,
      source_revision_hash: proof.call.source_revision_hash,
      bundle_hash: proof.loaded.envelope.bundle_hash,
      envelope_path: proof.loaded.file,
    },
    note: `Historical producer authorization from verified bundle ${proof.loaded.envelope.bundle_hash}.`,
  });
  return {
    ok: true,
    authorization: authorization.value,
    authorization_path: authorization.path,
    created: authorization.created,
    idempotent: authorization.idempotent,
  };
}

function advanceCurrentConsumerCutover({
  dataDir = DATA_DIR,
  rootDir = ROOT,
  consumerSha,
  activatedAt = new Date().toISOString(),
} = {}) {
  if (!consumerSha) {
    throw new Error('consumer cutover advance requires an explicit consumer SHA');
  }
  const current = readCutoverMarker(dataDir);
  if (!current.found) {
    return {
      ok: true,
      skipped: true,
      reason: 'exact-call cutover is not active',
    };
  }
  if (!current.ok || !current.marker?.producer_sha) {
    throw new Error(
      `invalid existing exact-call cutover chain blocks consumer advance: ${(current.problems || []).join('; ')}`,
    );
  }
  try {
    if (!current.active_ok) {
      throw cutoverError(
        'current active producer is legacy and lacks a producer-contract hash',
        'OTTER_PRODUCER_CONTRACT_MISSING',
      );
    }
    return activateCutover({
      dataDir,
      rootDir,
      producerSha: current.marker.producer_sha,
      consumerSha,
      activatedAt,
    });
  } catch (currentProducerError) {
    if (
      ![
        'OTTER_PRODUCER_PROOF_UNAVAILABLE',
        'OTTER_PRODUCER_CONTRACT_MISSING',
        'OTTER_PRODUCER_CONTRACT_MISMATCH',
      ].includes(currentProducerError?.code)
    ) {
      throw currentProducerError;
    }
    const compatible = newestCompatibleVerifiedProducer({
      dataDir,
      rootDir,
    });
    if (
      !compatible ||
      compatible.consumer.source_sha !== consumerSha
    ) {
      throw currentProducerError;
    }
    if (compatible.producerSha === current.marker.producer_sha) {
      if (currentProducerError.cause == null) {
        currentProducerError.cause = new Error(
          'producer reconciliation selected the same SHA that activation rejected',
        );
      }
      throw currentProducerError;
    }
    let result;
    try {
      // Re-read and re-verify through activateCutover so a ledger mutation
      // between candidate selection and marker write fails closed.
      result = activateCutover({
        dataDir,
        rootDir,
        producerSha: compatible.producerSha,
        consumerSha,
        activatedAt,
      });
    } catch (reconciliationError) {
      if (reconciliationError.cause == null) {
        reconciliationError.cause = currentProducerError;
      }
      throw reconciliationError;
    }
    return {
      ...result,
      producer_reconciled: {
        from: current.marker.producer_sha,
        to: compatible.producerSha,
        reason: 'newest verified exact-call producer with matching producer contract',
      },
    };
  }
}

function main(argv = process.argv.slice(2)) {
  const options = {
    dataDir: path.resolve(arg(argv, '--data-dir', DATA_DIR)),
    rootDir: path.resolve(arg(argv, '--root-dir', ROOT)),
    consumerSha: arg(argv, '--consumer-sha'),
    activatedAt: arg(argv, '--activated-at', new Date().toISOString()),
  };
  const result = argv.includes('--authorize-historical-producer')
    ? authorizeHistoricalProducer({
        ...options,
        producerSha: arg(argv, '--producer-sha'),
        otid: arg(argv, '--otid'),
        sourceRevisionHash: arg(argv, '--source-revision-hash'),
        authorizedAt: options.activatedAt,
      })
    : argv.includes('--advance-current-consumer')
    ? advanceCurrentConsumerCutover(options)
    : activateCutover({
        ...options,
        producerSha: arg(argv, '--producer-sha'),
      });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

module.exports = {
  activateCutover,
  advanceCurrentConsumerCutover,
  authorizeHistoricalProducer,
  newestCompatibleVerifiedProducer,
  strictProducerContract,
  verifiedEnvelopeCandidates,
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`[activate-otter-exact-call-cutover] ${error.message}\n`);
    process.exit(1);
  }
}
