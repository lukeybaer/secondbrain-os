'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { assertNoForbiddenPeople } = require('./forbidden-people');

const SCHEMA = 'life_archive_people_learning_stage.v1';

function sha256(value) {
  return crypto
    .createHash('sha256')
    .update(String(value || ''), 'utf8')
    .digest('hex');
}

function readJson(file, fallback = null, fsApi = fs) {
  try {
    return JSON.parse(fsApi.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, ms));
}

// The staging write is a read-rank-write of one person's pending file and
// meta. Concurrent exact-call projections (every call that includes ExampleCo)
// may stage the same person at once, so that transaction holds a per-person
// exclusive lock file for its few milliseconds. A lock older than the stale
// window is debris from a crashed holder.
const PERSON_STAGE_LOCK_STALE_MS = 60 * 1000;
function withPersonStageLock(lockFile, fsApi, fn, { waitMs = 30 * 1000, pollMs = 10 } = {}) {
  fsApi.mkdirSync(path.dirname(lockFile), { recursive: true });
  const deadline = Date.now() + waitMs;
  let fd = null;
  while (fd === null) {
    try {
      fd = fsApi.openSync(lockFile, 'wx');
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - fsApi.statSync(lockFile).mtimeMs > PERSON_STAGE_LOCK_STALE_MS) {
          fsApi.unlinkSync(lockFile);
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() > deadline) throw new Error(`people learning stage lock is busy: ${lockFile}`);
      sleepSync(pollMs);
    }
  }
  try {
    return fn();
  } finally {
    try {
      fsApi.closeSync(fd);
    } catch {
      /* already closed */
    }
    try {
      fsApi.unlinkSync(lockFile);
    } catch {
      /* already removed */
    }
  }
}

function strength(row) {
  return [
    row.owner_confirmed === true ? 1 : 0,
    Number(row.confidence || 0),
    Date.parse(row.occurred_at || '') || 0,
  ];
}

function outranks(left, right) {
  const a = strength(left);
  const b = strength(right || {});
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index];
  }
  return String(left.event_id || '') > String(right?.event_id || '');
}

function stagePeopleLearning({
  dataDir,
  personId,
  personFilePath,
  desiredText,
  source,
  provenance = '',
  occurredAt = new Date().toISOString(),
  confidence = 0.5,
  ownerConfirmed = false,
  requestId = '',
  appendRequest = true,
  fsApi = fs,
} = {}) {
  const rel = String(personFilePath || '').replace(/\\/g, '/');
  if (
    !personId ||
    (rel !== 'memory/user_profile.md' && !/^memory\/contacts\/[A-Za-z0-9_.-]+\.md$/.test(rel))
  ) {
    throw new Error('people learning staging requires one person and canonical People file');
  }
  if (!String(desiredText || '').trim())
    throw new Error('people learning staging requires desired text');
  assertNoForbiddenPeople(String(desiredText), `staged People learning for ${personId}`);
  const root = path.join(path.resolve(dataDir), 'life-archive', 'people');
  const event = {
    schema: SCHEMA,
    event_id: sha256(
      JSON.stringify({ personId, rel, desiredText, source, provenance, occurredAt }),
    ),
    request_id: requestId || `people-learning-${crypto.randomUUID()}`,
    person_id: String(personId),
    person_file_path: rel,
    source: String(source || 'unknown'),
    provenance: String(provenance || ''),
    occurred_at: occurredAt,
    confidence: Math.max(0, Math.min(1, Number(confidence || 0))),
    owner_confirmed: ownerConfirmed === true,
    desired_sha256: sha256(desiredText),
    status: 'staged',
  };
  const metaDir = path.join(root, 'pending-contact-meta');
  const pendingDir = path.join(root, 'pending-contacts');
  const metaFile = path.join(metaDir, `${path.basename(rel)}.json`);
  fsApi.mkdirSync(metaDir, { recursive: true });
  return withPersonStageLock(`${metaFile}.lock`, fsApi, () => {
    const prior = readJson(metaFile, null, fsApi);
    if (prior?.event_id === event.event_id) {
      return { event: prior, selected: false, idempotent: true, superseded_event_id: '' };
    }
    const selected = !prior || outranks(event, prior);
    fsApi.mkdirSync(root, { recursive: true });
    fsApi.appendFileSync(
      path.join(root, 'people-learning-stage-events.jsonl'),
      `${JSON.stringify(event)}\n`,
    );
    if (selected) {
      fsApi.mkdirSync(pendingDir, { recursive: true });
      fsApi.mkdirSync(metaDir, { recursive: true });
      fsApi.writeFileSync(path.join(pendingDir, path.basename(rel)), String(desiredText), 'utf8');
      fsApi.writeFileSync(metaFile, `${JSON.stringify(event, null, 2)}\n`, 'utf8');
      if (appendRequest) {
        if (prior?.request_id && prior.request_id !== event.request_id) {
          fsApi.appendFileSync(
            path.join(root, 'voice-git-people-sync-requests.jsonl'),
            `${JSON.stringify({
              request_id: prior.request_id,
              status: 'superseded',
              superseded_at: occurredAt,
              superseded_by: event.request_id,
              person_file_path: rel,
            })}\n`,
          );
        }
        fsApi.appendFileSync(
          path.join(root, 'voice-git-people-sync-requests.jsonl'),
          `${JSON.stringify({
            schema: 'life_archive_voice_git_people_sync_request.v1',
            request_id: event.request_id,
            status: 'ready',
            ready_at: occurredAt,
            identities: [String(personId)],
            archive_wide_mutation: false,
            reason: 'people_learning_daily_projection',
            person_file_path: rel,
            source: event.source,
            staging_event_id: event.event_id,
          })}\n`,
        );
      }
    }
    return {
      event,
      selected,
      superseded_event_id: selected ? prior?.event_id || '' : event.event_id,
    };
  });
}

module.exports = { SCHEMA, outranks, sha256, stagePeopleLearning, strength, withPersonStageLock };
