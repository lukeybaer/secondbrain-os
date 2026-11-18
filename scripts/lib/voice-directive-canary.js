'use strict';

// voice-directive-canary.js
//
// Self-test of the phone directive path (Owner decision: "u think it's too
// dangerous to let it test itself?"). A self-test phone call can never be
// owner-verified, so ask_amy refused it and the directive path had no live
// proof between the owner's own calls. Under a host-granted directive-canary lease
// (voice-selftest-dispatch-lease.js, scope CANARY_SCOPE) a self-test call's
// ask_amy runs this turn instead of the chat owner session:
//  - The request is fixed. What the caller or the model said is recorded as
//    heardRequest and never executed.
//  - The spine Task is written already closed and marked meta.selfTest, so no
//    runner claims it and it is never mistaken for the owner's work.
//  - Nothing is sent to chat or anyone else; a receipt row is the proof.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createSpineTask, defaultDataDir } = require('./spine-ingress');

const CANARY_SCOPE = 'directive-canary';
const CANARY_REQUEST = 'Voice directive canary: record this self-test and close it.';
const RECEIPT_SCHEMA = 'amy.voice-directive-canary.v1';

function receiptPath(opts = {}) {
  return opts.receiptFile || path.join(opts.dataDir || defaultDataDir(), 'agent', 'voice-directive-canary.jsonl');
}

// handleTurn for startVoiceOwnerTurn on a leased self-test call.
function runVoiceDirectiveCanaryTurn(update, { callId = '', heardRequest = '', nowMs = Date.now(), ...opts } = {}) {
  const updateId = String(update?.update_id || '');
  if (!updateId) throw new Error('directive canary needs the owner update id');
  const task = createSpineTask(
    {
      id: `spine-voice-canary-${crypto.createHash('sha256').update(updateId).digest('hex').slice(0, 16)}`,
      kind: 'voice_directive_canary',
      origin: 'vapi',
      prompt: String(update?.message?.text || CANARY_REQUEST),
      title: 'Voice directive canary',
      status: 'done',
      historyNote: 'Self-test of the phone directive path; written closed, nothing runs.',
      resultSummary: 'Voice directive canary recorded.',
      source: { type: 'vapi_directive_canary', ref: updateId },
      meta: { selfTest: true, canary: 'voice-directive', callId: String(callId || ''), heardRequest: String(heardRequest || '').slice(0, 300) },
    },
    opts,
  );
  const receipt = {
    schema: RECEIPT_SCHEMA,
    at: new Date(nowMs).toISOString(),
    callId: String(callId || ''),
    updateId,
    taskId: task.id,
    taskStatus: task.status,
    heardRequest: String(heardRequest || '').slice(0, 300),
  };
  const file = receiptPath(opts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(receipt) + '\n');
  return { turn: { turn_id: updateId }, projection: { state: task.status } };
}

// The canary rows a self-call proof reads back for its own call.
function canaryReceiptsForCall(callId, opts = {}) {
  let text = '';
  try {
    text = fs.readFileSync(receiptPath(opts), 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((row) => row && row.schema === RECEIPT_SCHEMA && row.callId === String(callId || ''));
}

module.exports = { CANARY_SCOPE, CANARY_REQUEST, runVoiceDirectiveCanaryTurn, canaryReceiptsForCall, receiptPath };
