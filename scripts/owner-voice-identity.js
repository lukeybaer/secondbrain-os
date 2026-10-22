#!/usr/bin/env node
'use strict';

/**
 * Owner-directed voice naming. The owner names a voice in chat instead of clicking
 * the briefing voice card. Writes the SAME action record the
 * POST /briefing/voice-confirm endpoint writes (source 'owner-directed-chat'),
 * links an existing unique People File when one exists, otherwise stages a new
 * one, and queues the git people-sync request, the voice-confirmation job row
 * and the Task Spine owner item.
 *
 * The only guards bypassed are below_recurrence_floor and voice_not_reviewable
 * (a below-floor voice is not in the review queue). recluster_repair and
 * review_audio_unavailable still refuse. The voice id must appear in the named
 * call's processed speaker data so a typo cannot name the wrong voice.
 *
 *   node scripts/owner-voice-identity.js --voice-id speaker_123 \
 *     --otid <otid> --name "Full Name" --owner-quote "<the owner's words>" \
 *     --owner-directed [--apply] [--dry-run]
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { guardVoiceReviewAction, rowsFromQueue, rowMatchesId } = require('./lib/voice-review-action-guard');
const { uniquePeopleFileForTypedName } = require('./lib/voice-people-file-match');
const {
  buildVoiceConfirmationRecord,
  gitPeopleSyncRequestIdFor,
  gitPeopleSyncRequestRow,
} = require('./lib/voice-confirmation-record');
const { ensurePeopleFileStub } = require('./lib/voice-people-stub');
const { stagePeopleLearning } = require('./lib/people-learning-stage');
const { startVoiceConfirmationOwnerTask } = require('./lib/voice-confirmation-owner-loop');
const { appendVoiceConfirmationJobEvent } = require('./lib/voice-confirmation-jobs');

const VOICE_ID_PATTERN = /^(speaker_\d+|unknown_voice_ecapa_[a-f0-9]+|unknown_voice_track_\d+)$/i;
const VOICE_ID_KEYS =
  /(^|_)(voice_cluster_id|acoustic_unknown_id|unknown_speaker_id|acoustic_group_id|speaker_id|canonical_speaker_id)$/;

class OwnerVoiceError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Every voice id the call's processed speaker data carries. */
function voiceIdsInEnriched(enriched) {
  const found = new Set();
  const walk = (node, key) => {
    if (Array.isArray(node)) {
      node.forEach((item) => walk(item, key));
    } else if (node && typeof node === 'object') {
      Object.entries(node).forEach(([k, v]) => walk(v, k));
    } else if (typeof node === 'string' && VOICE_ID_KEYS.test(key || '') && VOICE_ID_PATTERN.test(node)) {
      found.add(node.toLowerCase());
    }
  };
  walk(enriched?.speaker_identity_tracks, '');
  walk(enriched?.speaker_tracks, '');
  for (const segment of Array.isArray(enriched?.segments) ? enriched.segments : []) {
    walk(segment?.resolved_speaker, '');
  }
  return found;
}

function readPeopleIndex(contactsDir) {
  let names = [];
  try {
    names = fs.readdirSync(contactsDir);
  } catch {
    return [];
  }
  const rows = [];
  for (const file of names) {
    if (!file.endsWith('.md') || file.startsWith('_') || /^(README|INDEX)\.md$/i.test(file)) continue;
    const slug = file.replace(/\.md$/i, '');
    let text = '';
    try {
      text = fs.readFileSync(path.join(contactsDir, file), 'utf8');
    } catch {
      continue;
    }
    const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const nameLine = fm && fm[1].split(/\r?\n/).find((row) => /^name:\s*/i.test(row));
    const h1 = text.match(/^#\s+(.+)$/m);
    const name = nameLine
      ? nameLine.replace(/^name:\s*/i, '').replace(/^['"]|['"]$/g, '').trim()
      : h1
        ? h1[1].trim()
        : slug.replace(/_/g, ' ');
    rows.push({ name, personId: slug, path: `memory/contacts/${file}` });
  }
  return rows;
}

function appendJsonl(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(obj)}\n`);
}

function nameVoice(opts) {
  const voiceClusterId = String(opts.voiceId || '').trim();
  const otid = String(opts.otid || '').trim();
  const correctedName = String(opts.name || '').trim();
  const ownerQuote = String(opts.ownerQuote || '').trim();
  if (!VOICE_ID_PATTERN.test(voiceClusterId)) {
    throw new OwnerVoiceError('bad_voice_id', 'need --voice-id like speaker_123 or unknown_voice_ecapa_abc123');
  }
  if (!/^[A-Za-z0-9_-]+$/.test(otid)) throw new OwnerVoiceError('otid_required', '--otid is required');
  if (!correctedName) throw new OwnerVoiceError('name_required', '--name is required');
  if (!ownerQuote) throw new OwnerVoiceError('owner_quote_required', '--owner-quote is required for audit');

  const repoRoot = opts.repoRoot || path.resolve(__dirname, '..');
  const dataRoot = opts.dataRoot || process.env.SECONDBRAIN_DATA_DIR || path.join(repoRoot, 'data');
  const enrichedRoot = opts.enrichedRoot || path.join(repoRoot, 'data', 'otter', 'enriched');
  const peopleDir = path.join(dataRoot, 'life-archive', 'people');
  const queuePath = opts.queuePath || path.join(peopleDir, 'briefing-voice-queue-latest.json');
  const contactsDir = opts.contactsDir || path.join(repoRoot, 'memory', 'contacts');

  // The voice must be one of this call's processed speakers.
  let enrichedPath = path.join(enrichedRoot, `${otid}.json`);
  if (!fs.existsSync(enrichedPath) && !opts.enrichedRoot) {
    const alt = path.join(dataRoot, 'otter', 'enriched', `${otid}.json`);
    if (fs.existsSync(alt)) enrichedPath = alt;
  }
  const enriched = readJson(enrichedPath);
  if (!enriched) throw new OwnerVoiceError('call_not_found', `no processed call data for otid ${otid}`);
  if (!voiceIdsInEnriched(enriched).has(voiceClusterId.toLowerCase())) {
    throw new OwnerVoiceError(
      'voice_not_in_call',
      `${voiceClusterId} does not appear in the processed speaker data of call ${otid}`,
    );
  }

  const queue = readJson(queuePath);
  if (!queue) {
    throw new OwnerVoiceError('voice_review_queue_unavailable', 'cannot verify review eligibility: queue artifact unavailable');
  }
  const people = opts.people || readPeopleIndex(contactsDir);
  const existing = uniquePeopleFileForTypedName(correctedName, people);
  const action = existing ? 'link_person_file' : 'create_people_file';

  const guard = guardVoiceReviewAction({
    queue,
    voiceClusterId,
    action,
    ownerDirected: Boolean(opts.ownerDirected),
  });
  if (!guard.allowed) throw new OwnerVoiceError(guard.code, guard.error);

  const row = rowsFromQueue(queue).find((candidate) => rowMatchesId(candidate, voiceClusterId));
  const callCount = row ? Number(row.conversation_count ?? row.calls) : NaN;
  const record = buildVoiceConfirmationRecord({
    voiceClusterId,
    action,
    correctedName,
    personFilePath: existing ? existing.path : '',
    selectedPersonId: existing ? existing.personId || '' : '',
    linkedExistingPeopleFileForTypedName: existing ? existing.path : '',
    correctedNameWasTyped: true,
    callCountAtDecision: Number.isFinite(callCount) ? callCount : null,
    source: 'owner-directed-chat',
    ts: opts.now,
    extra: {
      ownerQuote,
      otid,
      ownerDirectedBypass: guard.ownerDirectedBypass || null,
    },
  });

  if (opts.dryRun) return { dryRun: true, record };

  const savedTo = path.join(peopleDir, 'voice-confirmation-actions.jsonl');
  let createdPeopleFile = '';
  if (action === 'create_people_file') {
    const { rel, created } = ensurePeopleFileStub({
      contactsRoot: path.join(peopleDir, 'pending-contacts'),
      name: correctedName,
      voiceClusterId,
      notes: '',
    });
    record.personFilePath = record.personFilePath || rel;
    if (created) createdPeopleFile = rel;
  }
  record.createdPeopleFile = createdPeopleFile;
  record.gitPeopleSyncRequestId = gitPeopleSyncRequestIdFor(record);
  if (createdPeopleFile) {
    const pending = path.join(peopleDir, 'pending-contacts', path.basename(createdPeopleFile));
    stagePeopleLearning({
      dataDir: dataRoot,
      personId: path.basename(createdPeopleFile, '.md'),
      personFilePath: createdPeopleFile,
      desiredText: fs.readFileSync(pending, 'utf8'),
      source: 'briefing_voice_confirmation',
      provenance: record.gitPeopleSyncRequestId,
      occurredAt: record.ts,
      confidence: 1,
      ownerConfirmed: true,
      requestId: record.gitPeopleSyncRequestId,
      appendRequest: true,
    });
  }
  const ownerTask = startVoiceConfirmationOwnerTask(record, record.gitPeopleSyncRequestId, {
    tasksDir: path.join(dataRoot, 'tasks'),
  });
  appendJsonl(savedTo, record);
  if (!createdPeopleFile) {
    appendJsonl(path.join(peopleDir, 'voice-git-people-sync-requests.jsonl'), gitPeopleSyncRequestRow(record, savedTo));
  }
  appendVoiceConfirmationJobEvent(path.join(peopleDir, 'voice-confirmation-jobs.jsonl'), {
    request_id: record.gitPeopleSyncRequestId,
    voice_cluster_id: voiceClusterId,
    person_file_path: record.personFilePath,
    selected_person_id: record.selectedPersonId,
    guessed_name: record.guessedName,
    action,
    job_status: 'accepted',
    accepted_at: new Date().toISOString(),
    source: 'owner-directed-chat',
  });
  return { record, savedTo, createdPeopleFile, ownerTaskId: ownerTask && ownerTask.id };
}

function applyRecord(result, opts = {}) {
  const repoRoot = opts.repoRoot || path.resolve(__dirname, '..');
  return execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'scripts', 'apply-voice-confirmation-actions.js'),
      '--write',
      '--voice-cluster-id',
      result.record.voiceClusterId,
      '--request-id',
      result.record.gitPeopleSyncRequestId,
    ],
    { cwd: repoRoot, env: process.env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
}

function parseArgs(argv) {
  const opts = {};
  const flags = { '--owner-directed': 'ownerDirected', '--apply': 'apply', '--dry-run': 'dryRun' };
  const values = {
    '--voice-id': 'voiceId',
    '--otid': 'otid',
    '--name': 'name',
    '--owner-quote': 'ownerQuote',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (flags[arg]) opts[flags[arg]] = true;
    else if (values[arg]) opts[values[arg]] = argv[++i];
    else throw new OwnerVoiceError('bad_arg', `unknown argument ${arg}`);
  }
  return opts;
}

if (require.main === module) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const result = nameVoice(opts);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (opts.apply && !result.dryRun) process.stdout.write(applyRecord(result, opts));
  } catch (error) {
    console.error(`${error.code || 'error'}: ${error.message}`);
    process.exit(error instanceof OwnerVoiceError ? 2 : 1);
  }
}

module.exports = { OwnerVoiceError, nameVoice, applyRecord, parseArgs, voiceIdsInEnriched, readPeopleIndex };
