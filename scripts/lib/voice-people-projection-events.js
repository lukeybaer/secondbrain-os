'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function readJsonl(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function openProjectionRequestIds(dataDir) {
  const peopleDir = path.join(dataDir, 'life-archive', 'people');
  const requests = readJsonl(path.join(peopleDir, 'voice-git-people-sync-requests.jsonl'));
  const receipts = readJsonl(path.join(peopleDir, 'voice-git-people-sync-receipts.jsonl'));
  const latestRequest = new Map();
  const latestReceipt = new Map();
  for (const row of requests) if (row?.request_id) latestRequest.set(row.request_id, row);
  for (const row of receipts) if (row?.request_id) latestReceipt.set(row.request_id, row);
  return [...latestRequest.values()]
    .filter((row) => latestReceipt.get(row.request_id)?.status !== 'landed')
    .map((row) => row.request_id);
}

function appendProjectionEvent({
  dataDir,
  producer,
  generatedAt = new Date().toISOString(),
  identitiesEvaluated = 0,
  identitiesCurrent = 0,
  filesPlanned = [],
  filesWritten = [],
  failures = [],
  requestIds,
} = {}) {
  const ids = Array.isArray(requestIds) ? requestIds : openProjectionRequestIds(dataDir);
  const event = {
    schema: 'life_archive_voice_people_projection_event.v1',
    event_id: `voice-people-projection-${crypto
      .createHash('sha1')
      .update(
        JSON.stringify([
          producer,
          generatedAt,
          identitiesEvaluated,
          filesPlanned,
          filesWritten,
          ids,
        ]),
      )
      .digest('hex')
      .slice(0, 16)}`,
    generated_at: generatedAt,
    producer,
    confirmed_identities_evaluated: Number(identitiesEvaluated || 0),
    confirmed_identities_current: Number(identitiesCurrent || 0),
    files_planned: [...new Set(filesPlanned || [])],
    files_written: [...new Set(filesWritten || [])],
    failures: failures || [],
    request_ids: [...new Set(ids || [])],
  };
  const out = path.join(
    dataDir,
    'life-archive',
    'people',
    'voice-people-file-projection-events.jsonl',
  );
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.appendFileSync(out, `${JSON.stringify(event)}\n`, 'utf8');
  return event;
}

module.exports = {
  readJsonl,
  openProjectionRequestIds,
  appendProjectionEvent,
};
