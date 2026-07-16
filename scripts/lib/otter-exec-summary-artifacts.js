'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 1;
const RELATIVE_DIR = path.join('agent', 'otter-call-exec-summaries');

function callSummaryKeys(call = {}) {
  return [...new Set([call.otid, call.id, call.file, call.title]
    .map((value) => String(value || '').trim())
    .filter(Boolean))];
}

function stableCallId(call = {}) {
  return callSummaryKeys(call)[0] || '';
}

function artifactFileName(callId) {
  const id = String(callId || '').trim();
  if (!id) throw new Error('callId is required for an Otter summary artifact');
  if (/^[A-Za-z0-9._-]{1,120}$/.test(id) && id !== '.' && id !== '..') return `${id}.json`;
  const prefix = id
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72) || 'call';
  const digest = crypto.createHash('sha256').update(id).digest('hex').slice(0, 12);
  return `${prefix}-${digest}.json`;
}

function callSummaryArtifactPath(dataDir, callId) {
  if (!dataDir) throw new Error('dataDir is required for an Otter summary artifact');
  return path.join(dataDir, RELATIVE_DIR, artifactFileName(callId));
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function writeCallSummaryArtifact({ dataDir, artifact } = {}) {
  if (!artifact || typeof artifact !== 'object') throw new Error('artifact is required');
  const callId = String(artifact.callId || '').trim();
  const file = callSummaryArtifactPath(dataDir, callId);
  const status = artifact.status === 'clean' ? 'clean' : 'blocked';
  const normalized = {
    schemaVersion: SCHEMA_VERSION,
    callId,
    date: String(artifact.date || '').slice(0, 10),
    status,
    generatedAt: String(artifact.generatedAt || new Date().toISOString()),
    source: artifact.source && typeof artifact.source === 'object' ? artifact.source : {},
    result:
      status === 'clean' && artifact.result && typeof artifact.result === 'object'
        ? artifact.result
        : null,
    blockedReason: status === 'clean' ? '' : String(artifact.blockedReason || 'summary-unavailable'),
    qc: {
      ok: status === 'clean' && artifact.qc?.ok !== false,
      failures:
        status === 'clean'
          ? []
          : (Array.isArray(artifact.qc?.failures) ? artifact.qc.failures : [artifact.blockedReason])
              .map((failure) => String(failure || '').trim())
              .filter(Boolean),
    },
    attempts: Number.isFinite(Number(artifact.attempts)) ? Number(artifact.attempts) : 1,
  };
  writeJsonAtomic(file, normalized);
  return { file, artifact: normalized };
}

function readCallSummaryArtifact({ dataDir, callId } = {}) {
  const id = String(callId || '').trim();
  if (!id) return null;
  const row = readJson(callSummaryArtifactPath(dataDir, id));
  if (!row || row.schemaVersion !== SCHEMA_VERSION || String(row.callId || '') !== id) return null;
  return row;
}

function readExecSummaryRecord({ dataDir, call, aggregateSummaries = {} } = {}) {
  const keys = callSummaryKeys(call);
  for (const key of keys) {
    const artifact = readCallSummaryArtifact({ dataDir, callId: key });
    if (!artifact) continue;
    if (artifact.status !== 'clean') {
      return {
        status: 'blocked',
        sourceMode: 'artifact',
        summary: '',
        displayTitle: '',
        blockedReason: artifact.blockedReason || 'summary-unavailable',
        artifact,
      };
    }
    return {
      ...(artifact.result || {}),
      status: 'clean',
      sourceMode: 'artifact',
      artifact,
    };
  }
  for (const key of keys) {
    const legacy = aggregateSummaries && aggregateSummaries[key];
    if (!legacy) continue;
    const row = typeof legacy === 'string' ? { summary: legacy } : legacy;
    return { ...row, status: 'clean', sourceMode: 'aggregate-fallback' };
  }
  return null;
}

function listCallSummaryArtifacts(dataDir) {
  const dir = path.join(dataDir, RELATIVE_DIR);
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((file) => file.endsWith('.json')).sort();
  } catch {
    return [];
  }
  return files
    .map((file) => readJson(path.join(dir, file)))
    .filter((row) => row && row.schemaVersion === SCHEMA_VERSION && row.callId);
}

function migrateAggregateSummaries({ dataDir, aggregate, summaryIsClean = () => true } = {}) {
  const summaries = aggregate && typeof aggregate.summaries === 'object' ? aggregate.summaries : {};
  let migrated = 0;
  for (const callId of Object.keys(summaries).sort()) {
    if (readCallSummaryArtifact({ dataDir, callId })) continue;
    const legacy = typeof summaries[callId] === 'string'
      ? { summary: summaries[callId] }
      : summaries[callId];
    const summary = String(legacy?.summary || '').trim();
    if (!summary || !summaryIsClean(summary)) continue;
    writeCallSummaryArtifact({
      dataDir,
      artifact: {
        callId,
        date: legacy.date || '',
        status: 'clean',
        generatedAt: legacy.generatedAt || aggregate.generatedAt || new Date().toISOString(),
        source: {
          title: legacy.title || '',
          sourceFile: legacy.sourceFile || '',
          migratedFrom: 'otter-call-exec-summaries.json',
        },
        result: {
          title: legacy.title || '',
          date: legacy.date || '',
          displayTitle: legacy.displayTitle || legacy.display_title || '',
          summary,
          generatedAt: legacy.generatedAt || aggregate.generatedAt || '',
          source: legacy.source || 'legacy-aggregate',
          sourceFile: legacy.sourceFile || '',
        },
        qc: { ok: true, failures: [] },
        attempts: 0,
      },
    });
    migrated += 1;
  }
  return migrated;
}

function writeDerivedAggregate({ dataDir, generatedAt, lastRun } = {}) {
  const summaries = {};
  const blocked = {};
  for (const artifact of listCallSummaryArtifacts(dataDir)) {
    if (artifact.status === 'clean' && artifact.result) {
      summaries[artifact.callId] = artifact.result;
    } else {
      blocked[artifact.callId] = {
        status: 'blocked',
        date: artifact.date || '',
        generatedAt: artifact.generatedAt,
        blockedReason: artifact.blockedReason || 'summary-unavailable',
        qc: artifact.qc,
      };
    }
  }
  const aggregate = {
    schemaVersion: 2,
    generatedAt: String(generatedAt || new Date().toISOString()),
    source: 'per-call-artifacts',
    summaries,
    blocked,
    lastRun: lastRun || null,
  };
  const file = path.join(dataDir, 'agent', 'otter-call-exec-summaries.json');
  writeJsonAtomic(file, aggregate);
  return { file, aggregate };
}

module.exports = {
  SCHEMA_VERSION,
  callSummaryArtifactPath,
  callSummaryKeys,
  listCallSummaryArtifacts,
  migrateAggregateSummaries,
  readCallSummaryArtifact,
  readExecSummaryRecord,
  stableCallId,
  writeCallSummaryArtifact,
  writeDerivedAggregate,
};
