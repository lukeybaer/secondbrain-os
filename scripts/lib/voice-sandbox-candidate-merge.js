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

function candidateKey(row) {
  return `${String(row?.otid || '')}|${String(row?.speaker_model_label || '')}`;
}

function mergeSandboxCandidates({
  source,
  destination,
  generatedAt = new Date().toISOString(),
  fsApi = fs,
}) {
  const incoming = readJson(source, null, fsApi);
  const current = readJson(destination, { candidates: [] }, fsApi);
  if (!incoming || !Array.isArray(incoming.candidates)) {
    return { ok: false, reason: 'source_sandbox_candidates_missing_or_invalid', merged: 0 };
  }
  const rows = new Map(
    (current.candidates || []).map((row) => [candidateKey(row), row]),
  );
  let merged = 0;
  for (const row of incoming.candidates) {
    const key = candidateKey(row);
    if (!key || key === '|') continue;
    rows.set(key, row);
    merged += 1;
  }
  const report = {
    schema: incoming.schema || 'life_archive_sandbox_candidate_assignments.v1',
    generated_at: generatedAt,
    candidate_count: rows.size,
    candidates: [...rows.values()].sort((left, right) =>
      candidateKey(left).localeCompare(candidateKey(right)),
    ),
  };
  fsApi.mkdirSync(path.dirname(destination), { recursive: true });
  const temp = `${destination}.${process.pid}.${Date.now()}.tmp`;
  fsApi.writeFileSync(temp, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fsApi.renameSync(temp, destination);
  return { ok: true, merged, total: report.candidate_count, destination };
}

module.exports = { readJson, candidateKey, mergeSandboxCandidates };
