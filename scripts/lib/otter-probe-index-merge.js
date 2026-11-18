'use strict';

const fs = require('node:fs');
const path = require('node:path');

function readJson(file, fallback = null, fsApi = fs) {
  try {
    return JSON.parse(fsApi.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

function probeKey(row) {
  return `${String(row?.otid || '')}|${String(row?.speaker_model_label || '')}`;
}

function mergeProbeIndexes({ source, destination, generatedAt = new Date().toISOString(), fsApi = fs }) {
  const incoming = readJson(source, null, fsApi);
  const current = readJson(destination, { probes: [] }, fsApi);
  if (!incoming || !Array.isArray(incoming.probes)) {
    return { ok: false, reason: 'source_probe_index_missing_or_invalid', merged: 0 };
  }
  const rows = new Map((current.probes || []).map((row) => [probeKey(row), row]));
  let merged = 0;
  for (const row of incoming.probes) {
    const key = probeKey(row);
    if (!key || key === '|') continue;
    rows.set(key, row);
    merged += 1;
  }
  const report = {
    ...current,
    schema: incoming.schema || current.schema || 'life_archive_otter_track_probe_index.v1',
    generated_at: generatedAt,
    probes: [...rows.values()].sort(
      (a, b) =>
        String(a.otid || '').localeCompare(String(b.otid || '')) ||
        String(a.speaker_model_label || '').localeCompare(String(b.speaker_model_label || '')),
    ),
  };
  fsApi.mkdirSync(path.dirname(destination), { recursive: true });
  const temp = `${destination}.${process.pid}.${Date.now()}.tmp`;
  fsApi.writeFileSync(temp, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fsApi.renameSync(temp, destination);
  return { ok: true, merged, total: report.probes.length, destination };
}

module.exports = { readJson, probeKey, mergeProbeIndexes };
