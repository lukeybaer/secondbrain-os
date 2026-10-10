'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 1;
const REL_DIR = path.join('agent', 'briefing-cards');
const FILE_NAME = 'day-manifest.json';

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value == null ? '' : value)).digest('hex');
}

function dayManifestPath({ dataDir, date }) {
  return path.join(dataDir, REL_DIR, String(date), FILE_NAME);
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
}

function readDayManifest({ dataDir, date }) {
  try {
    const parsed = JSON.parse(fs.readFileSync(dayManifestPath({ dataDir, date }), 'utf8'));
    if (
      !parsed ||
      parsed.schemaVersion !== SCHEMA_VERSION ||
      parsed.date !== String(date) ||
      !Number.isInteger(parsed.version) ||
      !parsed.cards ||
      typeof parsed.cards !== 'object'
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function normalizedInputHash(source, sourceHash) {
  const explicit =
    source &&
    (source.inputHash ||
      source.input_hash ||
      source.tacticInputHash ||
      source.tactic_input_hash ||
      source.digest);
  return String(explicit || sourceHash);
}

function measurementLineage(workUnits) {
  const out = {};
  for (const unit of Array.isArray(workUnits) ? workUnits : []) {
    const id = String((unit && unit.id) || '').trim();
    if (!id) continue;
    const evidence = {
      status: String(unit.status || ''),
      evidenceHash: String(unit.evidenceHash || unit.evidence_hash || ''),
      asOf: String(unit.asOf || unit.checkedAt || unit.ts || ''),
      producer: String(unit.producer || unit.source || ''),
    };
    out[id] = {
      status: evidence.status,
      evidenceHash: sha256(stableJson(evidence)),
    };
  }
  return out;
}

function lineageForArtifact(artifact) {
  const source = (artifact && artifact.source) || {};
  const sourceHash = sha256(stableJson(source));
  const entry = {
    status: String((artifact && artifact.status) || ''),
    generatedAt: String((artifact && artifact.generatedAt) || ''),
    sourceHash,
    inputHash: normalizedInputHash(source, sourceHash),
    contentHash: sha256(String((artifact && artifact.markdown) || '')),
    artifactHash: sha256(stableJson(artifact || {})),
  };
  const measurements = measurementLineage(artifact && artifact.workUnits);
  if (Object.keys(measurements).length) entry.measurements = measurements;
  return entry;
}

function manifestBody({ date, version, cards, now, reason, priorToken = '' }) {
  return {
    schemaVersion: SCHEMA_VERSION,
    date: String(date),
    version,
    generatedAt: (now instanceof Date ? now : new Date(now || Date.now())).toISOString(),
    reason: String(reason || ''),
    priorToken: String(priorToken || ''),
    cards: Object.fromEntries(
      Object.entries(cards || {}).sort(([a], [b]) => String(a).localeCompare(String(b))),
    ),
  };
}

function dayManifestToken(manifest) {
  if (!manifest) return '';
  return sha256(stableJson(manifest));
}

function artifactsToCards(artifacts, { generationByCard = {} } = {}) {
  const cards = {};
  for (const artifact of artifacts || []) {
    const id = String((artifact && artifact.id) || '').trim();
    if (!id) continue;
    const generation = generationByCard[id];
    cards[id] = {
      ...lineageForArtifact(artifact),
      ...(generation
        ? {
            generationId: String(generation.generationId || generation),
            generationHash: String(
              generation.generationHash || generation.generationId || generation,
            ),
          }
        : {}),
    };
  }
  return cards;
}

function lineageHash(lineage) {
  return lineage ? sha256(stableJson(lineage)) : '';
}

function captureExpectedLineage(manifest, cardIds = []) {
  const cards = (manifest && manifest.cards) || {};
  return Object.fromEntries(
    [...new Set((cardIds || []).map(String).filter(Boolean))]
      .sort()
      .map((id) => [id, lineageHash(cards[id])]),
  );
}

function currentGenerationId(manifest, cardId) {
  const lineage = manifest && manifest.cards && manifest.cards[String(cardId)];
  if (!lineage) return '';
  // Legacy manifests predate immutable generation ids. Their accepted artifact
  // hash is a stable synthetic generation until the first Gate A promotion.
  return String(lineage.generationId || lineage.artifactHash || '');
}

function assertExpectedLineage(current, expectedLineage = {}) {
  for (const [id, expectedHash] of Object.entries(expectedLineage || {})) {
    const actualHash = lineageHash(current && current.cards && current.cards[id]);
    if (String(expectedHash || '') !== actualHash) {
      const error = new Error(
        `briefing day manifest touched lineage changed before Gate A; compare-and-swap refused stale card output: ${id}`,
      );
      error.code = 'BRIEFING_DAY_MANIFEST_LINEAGE_CONFLICT';
      error.cardId = id;
      error.expectedLineageHash = String(expectedHash || '');
      error.actualLineageHash = actualHash;
      throw error;
    }
  }
}

function assertExpectedGenerations(current, expectedGenerations = {}) {
  for (const [id, expectedGenerationId] of Object.entries(expectedGenerations || {})) {
    const actualGenerationId = currentGenerationId(current, id);
    if (String(expectedGenerationId || '') !== actualGenerationId) {
      const error = new Error(
        `briefing card generation changed before Gate B; compare-and-swap retained late QC without applying it: ${id}`,
      );
      error.code = 'BRIEFING_CARD_GENERATION_CONFLICT';
      error.cardId = id;
      error.expectedGenerationId = String(expectedGenerationId || '');
      error.actualGenerationId = actualGenerationId;
      throw error;
    }
  }
}

function writeDayManifestFromArtifacts({
  dataDir,
  date,
  artifacts,
  now = new Date(),
  reason = 'full-card-build',
  generationByCard = {},
} = {}) {
  const previous = readDayManifest({ dataDir, date });
  const manifest = manifestBody({
    date,
    version: previous ? previous.version + 1 : 1,
    cards: artifactsToCards(artifacts, { generationByCard }),
    now,
    reason,
    priorToken: dayManifestToken(previous),
  });
  writeJsonAtomic(dayManifestPath({ dataDir, date }), manifest);
  return manifest;
}

function updateDayManifestCards({
  dataDir,
  date,
  artifacts,
  expectedToken,
  expectedLineage = null,
  expectedGenerations = null,
  generationByCard = {},
  now = new Date(),
  reason = 'scoped-card-promotion',
} = {}) {
  const current = readDayManifest({ dataDir, date });
  if (!current) throw new Error(`briefing day manifest missing for ${date}`);
  const currentToken = dayManifestToken(current);
  if (expectedLineage) assertExpectedLineage(current, expectedLineage);
  if (expectedGenerations) assertExpectedGenerations(current, expectedGenerations);
  if (!expectedLineage && !expectedGenerations && (!expectedToken || expectedToken !== currentToken)) {
    const error = new Error(
      `briefing day manifest changed before promotion; compare-and-swap refused stale card output`,
    );
    error.code = 'BRIEFING_DAY_MANIFEST_CONFLICT';
    error.expectedToken = String(expectedToken || '');
    error.actualToken = currentToken;
    throw error;
  }
  const cards = {
    ...current.cards,
    ...artifactsToCards(artifacts, { generationByCard }),
  };
  const next = manifestBody({
    date,
    version: current.version + 1,
    cards,
    now,
    reason,
    priorToken: currentToken,
  });
  writeJsonAtomic(dayManifestPath({ dataDir, date }), next);
  return next;
}

function readRawCardArtifacts({ dataDir, date }) {
  const dir = path.join(dataDir, REL_DIR, String(date));
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.json') && name !== FILE_NAME)
      .map((name) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        } catch {
          return null;
        }
      })
      .filter((artifact) => artifact && artifact.id);
  } catch {
    return [];
  }
}

function verifyDayManifest({ dataDir, date, artifacts = null } = {}) {
  const manifest = readDayManifest({ dataDir, date });
  if (!manifest) {
    return {
      ok: false,
      date,
      token: '',
      defects: [`DAY-MANIFEST-MISSING: no daily lineage manifest for ${date}`],
    };
  }
  const currentArtifacts = artifacts || readRawCardArtifacts({ dataDir, date });
  const current = artifactsToCards(currentArtifacts);
  const defects = [];
  for (const [id, expected] of Object.entries(manifest.cards)) {
    const actual = current[id];
    if (!actual) {
      defects.push(`DAY-MANIFEST-CARD-MISSING: ${id} accepted artifact is missing`);
      continue;
    }
    for (const key of ['sourceHash', 'inputHash', 'contentHash', 'artifactHash']) {
      if (actual[key] !== expected[key]) {
        defects.push(`DAY-MANIFEST-${key.toUpperCase()}-MISMATCH: ${id} ${key} diverged`);
      }
    }
    if (stableJson(actual.measurements || {}) !== stableJson(expected.measurements || {})) {
      defects.push(`DAY-MANIFEST-MEASUREMENT-MISMATCH: ${id} measurement lineage diverged`);
    }
  }
  for (const id of Object.keys(current)) {
    if (!manifest.cards[id]) defects.push(`DAY-MANIFEST-UNTRACKED-CARD: ${id} is not in the day manifest`);
  }
  return {
    ok: defects.length === 0,
    date,
    version: manifest.version,
    token: dayManifestToken(manifest),
    checkedAt: new Date().toISOString(),
    defects,
  };
}

module.exports = {
  SCHEMA_VERSION,
  FILE_NAME,
  stableJson,
  sha256,
  dayManifestPath,
  readDayManifest,
  lineageForArtifact,
  lineageHash,
  captureExpectedLineage,
  currentGenerationId,
  assertExpectedLineage,
  assertExpectedGenerations,
  dayManifestToken,
  writeDayManifestFromArtifacts,
  updateDayManifestCards,
  verifyDayManifest,
};
