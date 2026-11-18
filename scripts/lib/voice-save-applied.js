'use strict';

// scripts/lib/voice-save-applied.js
//
// S-13 (owner decision): the one answer to "was this voice Save applied".
// A Save counts as applied only when BOTH hold:
//   1. the identity registry holds an entry carrying that Save's exact
//      review_action_key AND recording the same decision the Save made (a
//      "not them" needs a denial, a confirmation needs a confirmed resolution);
//   2. the Save's job recorded that its People File step finished (a completed
//      row, an explicit people_file_step_completed_at, or a landed People File
//      relay receipt for that exact request).
// No "any entry for this voice" logic: an older or unrelated registry entry is
// never proof (peer review F1), and a registry write alone never proves the
// People File step (F2).
//
// The owner's close (2026-11-15): one abandoned Save that can never apply may be
// closed by the owner's explicit decision, recorded in
// life-archive/people/voice-save-owner-closures.jsonl and bound to that Save's
// exact request id and review_action_key. A closed Save is never applied: it
// is reported apart, as closed by the owner's rule.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function sha20(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 20);
}

// Same formula as apply-voice-confirmation-actions.js applyActions; a parity
// test keeps the two equal.
function reviewActionKeyForAction(row = {}) {
  return sha20(
    `${row.ts}|${row.voiceClusterId}|${row.assignmentClusterId || ''}|${row.action}|${row.guessedName || ''}|${row.correctedName || ''}|${row.personFilePath || ''}|${row.selectedPersonId || ''}|${row.notes || ''}|${row.clusterFingerprint || ''}`,
  );
}

const IDENTITY_ACTIONS = new Set(['confirm', 'correct', 'link_person_file', 'create_people_file']);

// The registry evidence each Save decision leaves, by action.
function decisionKindForAction(action) {
  const name = String(action || '');
  if (name === 'not_them') return 'denial';
  if (IDENTITY_ACTIONS.has(name)) return 'identity';
  if (name === 'dont_know') return 'left_unknown';
  if (name === 'non_speech') return 'non_speech';
  if (name === 'two_people') return 'two_people';
  if (name === 'undo_two_people') return 'two_people_undone';
  if (name === 'add_notes') return 'notes';
  if (name === 'keep_voiceprint') return 'keep_voiceprint';
  return '';
}

function entryDecisionKind(entry = {}) {
  const type = String(entry.type || '');
  const status = String(entry.status || '');
  if (type === 'voice_identity_denial' || (!type && !status && entry.denied_person_id)) return 'denial';
  if (type === 'voice_identity_confirmation' || status === 'confirmed_by_owner') return 'identity';
  if (type === 'voice_identity_left_unknown' || status === 'left_unknown_by_owner') return 'left_unknown';
  if (type === 'voice_identity_non_speech' || status === 'non_speech_by_owner') return 'non_speech';
  if (type === 'voice_identity_two_people' || status === 'two_people_by_owner') return 'two_people';
  if (type === 'voice_identity_two_people_undone') return 'two_people_undone';
  if (type === 'voice_people_file_context_note') return 'notes';
  if (entry.disposition === 'keep_voiceprint') return 'keep_voiceprint';
  return '';
}

// Every live registry entry carrying this exact key. Retired and superseded
// sections are history, not a standing decision, so they never count.
function registryEntriesForKey(registry = {}, key = '') {
  if (!key) return [];
  const out = [];
  const take = (entry) => {
    if (entry && entry.review_action_key === key) out.push(entry);
  };
  for (const rows of Object.values(registry.voice_cluster_denials || {})) {
    for (const row of Array.isArray(rows) ? rows : []) take(row);
  }
  for (const field of ['voice_cluster_resolutions', 'acoustic_group_resolutions', 'voiceprint_assignment_overrides']) {
    for (const row of Object.values(registry[field] || {})) take(row);
  }
  for (const row of registry.manual_corrections || []) take(row);
  return out;
}

function registryHoldsDecision(registry, { key, action }) {
  const kind = decisionKindForAction(action);
  if (!kind || !key) return false;
  return registryEntriesForKey(registry, key).some((entry) => entryDecisionKind(entry) === kind);
}

function peopleFileStepFinished(history = [], landedReceipt = null) {
  if (landedReceipt && landedReceipt.status === 'landed') return true;
  return history.some(
    (row) =>
      String(row?.job_status || '') === 'completed' ||
      Boolean(row?.people_file_step_completed_at),
  );
}

function isSaveApplied({ registry, key, action, history = [], landedReceipt = null }) {
  return registryHoldsDecision(registry, { key, action }) && peopleFileStepFinished(history, landedReceipt);
}

function readJsonl(file) {
  try {
    return String(fs.readFileSync(file, 'utf8'))
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

function readJson(file, fallback = null) {
  try {
    return JSON.parse(String(fs.readFileSync(file, 'utf8')).replace(/^﻿/, ''));
  } catch {
    return fallback;
  }
}

function saveInputPaths(dataDir) {
  const people = path.join(String(dataDir || ''), 'life-archive', 'people');
  return {
    registry: path.join(String(dataDir || ''), 'life-archive', 'voice-identity-registry.json'),
    actions: path.join(people, 'voice-confirmation-actions.jsonl'),
    requests: path.join(people, 'voice-git-people-sync-requests.jsonl'),
    receipts: path.join(people, 'voice-git-people-sync-receipts.jsonl'),
    closures: path.join(people, 'voice-save-owner-closures.jsonl'),
  };
}

// Save action rows by their sync request id, each with its review_action_key.
function actionsByRequestId(actions = []) {
  const out = new Map();
  for (const row of actions) {
    const id = String(row?.gitPeopleSyncRequestId || '');
    if (!id) continue;
    out.set(id, { ...row, review_action_key: reviewActionKeyForAction(row) });
  }
  return out;
}

function latestReceiptByRequestId(receipts = []) {
  const out = new Map();
  for (const row of receipts) if (row?.request_id) out.set(row.request_id, row);
  return out;
}

// A closure counts only with every field the owner's decision needs: the exact Save
// (request id plus its 20-hex review_action_key), who approved it, and why.
const OWNER_CLOSURE_SCHEMA = 'voice_save_owner_closure.v1';
const MIN_CLOSURE_REASON = 12;

function validOwnerClosure(row) {
  return Boolean(
    row &&
      row.schema === OWNER_CLOSURE_SCHEMA &&
      String(row.request_id || '').trim() &&
      /^[a-f0-9]{20}$/.test(String(row.review_action_key || '')) &&
      String(row.approved_by || '').trim() &&
      String(row.reason || '').trim().length >= MIN_CLOSURE_REASON,
  );
}

// Valid closures by "request id|review_action_key", so a closure of one Save
// never closes a later Save that reuses its request id with another key.
function ownerClosuresByKey(rows = []) {
  const out = new Map();
  for (const row of rows) if (validOwnerClosure(row)) out.set(`${row.request_id}|${row.review_action_key}`, row);
  return out;
}

// An explicit superseded relay can be a request-to-request edge or, in older
// rows, the owner's written correction. A People File is shared by many voices.
function sourceSupersession(action, actions, requestsById, receiptsById, registry) {
  const id = action.gitPeopleSyncRequestId;
  const relay = requestsById.get(id);
  if (!IDENTITY_ACTIONS.has(action.action) || relay?.status !== 'superseded' || !action.voiceClusterId) return null;
  const calls = new Set(action.otidsAtDecision || []);
  const overlap = (row) => (row.otidsAtDecision || []).some((call) => call && calls.has(call));
  const identities = actions.filter((row) =>
    row.gitPeopleSyncRequestId && row.gitPeopleSyncRequestId !== id &&
    row.voiceClusterId === action.voiceClusterId && IDENTITY_ACTIONS.has(row.action) &&
    !['rejected', 'cancelled', 'invalid'].includes(row.status) && Date.parse(row.ts) > Date.parse(action.ts));
  const seen = new Set([id]);
  let link = relay;
  let replacement = null;
  while (link?.status === 'superseded' && seen.size <= 32) {
    const next = link.superseded_by;
    if (!next || seen.has(next)) return null;
    seen.add(next);
    const exact = identities.find((row) => row.gitPeopleSyncRequestId === next);
    if (exact && (!calls.size || !exact.otidsAtDecision?.length || overlap(exact) ||
        action.clusterFingerprint && action.clusterFingerprint === exact.clusterFingerprint)) replacement = exact;
    link = requestsById.get(next);
  }
  if (link && seen.size > 32) return null;
  if (!replacement && /^owner correction\b/i.test(String(relay.superseded_by || ''))) {
    // Older relays name the owner's correction in prose. Bind to the first
    // later change of person on this voice and its reviewed call set. An
    // unrelated later decision cannot erase an already-proved replacement.
    const corrections = identities.filter((row) => row.action === 'correct' && action.selectedPersonId &&
      row.selectedPersonId && row.selectedPersonId !== action.selectedPersonId && overlap(row))
      .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    replacement = corrections[0];
    if (replacement && corrections.some((row) => row.ts === replacement.ts &&
        row.gitPeopleSyncRequestId !== replacement.gitPeopleSyncRequestId)) return null;
  }
  if (!replacement) return null;
  const newId = replacement.gitPeopleSyncRequestId;
  const key = reviewActionKeyForAction(replacement);
  const landed = receiptsById.get(newId)?.status === 'landed';
  return {
    request_id: id, review_action_key: reviewActionKeyForAction(action), superseded_by: newId,
    replacement_review_action_key: key,
    replacement_applied: Boolean(landed && registryHoldsDecision(registry, { key, action: replacement.action })),
  };
}

function loadSaveDecisions(dataDir) {
  const paths = saveInputPaths(dataDir);
  const registry = readJson(paths.registry, {}) || {};
  const actions = readJsonl(paths.actions);
  const receipts = readJsonl(paths.receipts);
  const closures = readJsonl(paths.closures);
  const requests = readJsonl(paths.requests);
  return { registry, actions, receipts, closures, requests };
}

function loadReplayBlocks(dataDir, ids) {
  const paths = saveInputPaths(dataDir);
  const selected = new Set(ids);
  const requests = readJsonl(paths.requests);
  const closures = readJsonl(paths.closures);
  if (!requests.some((row) => selected.has(row.request_id) && row.status === 'superseded') &&
      !closures.some((row) => selected.has(row.request_id) && validOwnerClosure(row))) return new Map();
  return saveReplayBlocks({ requests, closures, actions: readJsonl(paths.actions), receipts: readJsonl(paths.receipts),
    registry: readJson(paths.registry, {}) || {} }, selected);
}

function saveReplayBlocks({ registry = {}, actions = [], receipts = [], requests = [], closures = [] }, ids) {
  const blocked = new Map();
  const byId = actionsByRequestId(actions);
  // A later stale ready/failed relay entry cannot withdraw an accepted owner correction.
  const relayById = latestReceiptByRequestId(requests.filter((row) => row?.status === 'superseded'));
  const receiptById = latestReceiptByRequestId(receipts);
  const closed = ownerClosuresByKey(closures);
  for (const id of ids) {
    const action = byId.get(id);
    if (!action) continue;
    const closure = closed.get(`${id}|${action.review_action_key}`);
    if (closure) blocked.set(id, { request_id: id, review_action_key: action.review_action_key, closure_kind: 'owner', approved_by: closure.approved_by, closure_reason: closure.reason, closed_at: closure.closed_at || '' });
    else {
      const replaced = sourceSupersession(action, actions, relayById, receiptById, registry);
      if (replaced) blocked.set(id, { ...replaced, closure_kind: 'superseded' });
    }
  }
  return blocked;
}


// Judges each job id against the exact rule above. `historyById` maps a
// request id to its job rows. Returns { applied: [...ids], unapplied: [...],
// closed: [...] } where each unapplied entry says which half is missing and
// each closed entry is an unapplied Save the owner closed by his rule.
function judgeSaves({ requestIds = [], historyById = new Map(), registry = {}, actions = [], receipts = [], closures = [], requests = [] }) {
  const byRequest = actionsByRequestId(actions);
  const receiptsById = latestReceiptByRequestId(receipts);
  const blocks = saveReplayBlocks({registry, actions, receipts, requests, closures}, requestIds);
  const applied = [];
  const unapplied = [];
  const closed = [];
  for (const id of requestIds) {
    const action = byRequest.get(id);
    const history = historyById.get(id) || [];
    const key = action?.review_action_key || '';
    const registryOk = Boolean(action) && registryHoldsDecision(registry, { key, action: action.action });
    const peopleOk = peopleFileStepFinished(history, receiptsById.get(id) || null);
    if (registryOk && peopleOk) applied.push(id);
    else {
      const entry = {
        request_id: id,
        review_action_key: key,
        action: action?.action || '',
        registry_decision_recorded: registryOk,
        people_file_step_finished: peopleOk,
        reason: !action
          ? 'save_action_row_missing'
          : !registryOk
            ? 'registry_missing_exact_decision'
            : 'people_file_step_not_finished',
      };
      const block = blocks.get(id);
      if (block?.closure_kind === 'owner' || block?.replacement_applied) {
        closed.push({ ...entry, ...block });
      } else if (block) {
        unapplied.push({ ...entry, ...block, reason: 'replacement_not_yet_proven' });
      } else unapplied.push(entry);
    }
  }
  return { applied, unapplied, closed };
}

function judgeSavesFromDataDir(dataDir, { requestIds = [], historyById = new Map() } = {}) {
  return judgeSaves({ ...loadSaveDecisions(dataDir), requestIds, historyById });
}

module.exports = {
  IDENTITY_ACTIONS,
  OWNER_CLOSURE_SCHEMA,
  MIN_CLOSURE_REASON,
  validOwnerClosure,
  ownerClosuresByKey,
  reviewActionKeyForAction,
  decisionKindForAction,
  entryDecisionKind,
  registryEntriesForKey,
  registryHoldsDecision,
  peopleFileStepFinished,
  isSaveApplied,
  actionsByRequestId,
  loadSaveDecisions,
  loadReplayBlocks,
  saveReplayBlocks,
  judgeSaves,
  judgeSavesFromDataDir,
  saveInputPaths,
};
