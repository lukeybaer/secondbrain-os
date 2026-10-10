/**
 * vapi-end-of-call.js - process a Vapi end-of-call-report payload.
 *
 * Pulled out of ec2-server.js so the logic is unit-testable without
 * spinning up the HTTP server. ec2-server.js wires this in inside its
 * Vapi webhook handler.
 *
 * Pipeline (mirrors how Otter and Gmail #Amy directives flow):
 *  1. Save the full payload to data/vapi/raw/{callId}.json (raw archival
 *     before any processing, per feedback_raw_archival_principle.md).
 *  2. Extract directives from the transcript using assistant restatement
 *     lines ("Got it. <restatement>" / "Understood. <restatement>") since
 *     those are the cleanest paraphrase of the owner's ask.
 *  3. Create one spine action task per directive, then append a matching
 *     legacy queue receipt for dashboard/backfill compatibility.
 *  4. Send one deduped Telegram outcome brief after every inbound call,
 *     including owner calls and calls without conversation evidence.
 *
 * Triggered by the 2026-05-01 incident: ExampleCo asked for an policy news
 * section on a Vapi call; Amy verbally said "Got it" but invoked no tool,
 * the webhook had no end-of-call-report handler, and the directive
 * evaporated at hangup. Fix: capture transcripts mechanically every call,
 * never rely on Amy remembering to call a tool mid-call.
 */

const fs = require('fs');
const path = require('path');
const { classifyFinishedCall } = require('./lib/jev-control-plane.js');
const { clearPendingCallClassification, pauseOutboundCalls, readOutboundCallControl } = require('./lib/outbound-call-control.js');
const { listPrincipalPhones, normalizePhone } = require('./lib/redial-guard.js');
const { recordDispatchInput } = require('./lib/spine-ingress');
const {
  auditCompletedSideEffectClaims,
  readEffectReceipts,
} = require('./lib/vapi-side-effect-ledger');
const { appendRecentOwnerCallContext } = require('./lib/voice-recent-context');
const jevClassificationsInFlight = new Set();

function getDispatchQueuePath(opts = {}) {
  if (opts.queuePath) return opts.queuePath;
  if (process.env.DISPATCH_QUEUE) return process.env.DISPATCH_QUEUE;
  if (fs.existsSync('/opt/secondbrain/data/agent')) {
    return '/opt/secondbrain/data/agent/dispatch-queue.jsonl';
  }
  const repoRoot = path.resolve(__dirname, '..');
  return path.join(repoRoot, 'data', 'agent', 'dispatch-queue.jsonl');
}

function getVapiRawDir(opts = {}) {
  if (opts.rawDir) return opts.rawDir;
  if (fs.existsSync('/opt/secondbrain/data')) {
    return path.join('/opt/secondbrain/data', 'vapi', 'raw');
  }
  const repoRoot = path.resolve(__dirname, '..');
  return path.join(repoRoot, 'data', 'vapi', 'raw');
}

function getSpineTasksDir(opts = {}) {
  if (opts.tasksDir) return opts.tasksDir;
  if (opts.queuePath) return path.join(path.dirname(path.dirname(opts.queuePath)), 'tasks');
  return undefined;
}

/**
 * Pull the assistant's restatement of each owner directive out of a Vapi
 * transcript. The transcript is plain text with role-prefixed lines
 * ("AI: ..." / "User: ...").
 *
 * We scan AI lines that begin with an acknowledgement ("Got it",
 * "Understood", "Sure", "Okay", "Of course"), strip the acknowledgement,
 * and keep the restatement when it contains an imperative verb (add,
 * include, schedule, remember, ...). This avoids capturing pleasantries
 * while still picking up real instructions.
 */
function extractDirectivesFromTranscript(transcript) {
  if (!transcript || typeof transcript !== 'string') return [];
  const ackRe =
    /^AI:\s*(?:got it[.,!]?\s*|understood[.,!]?\s*|sure[.,!]?\s*|okay[.,!]?\s*|of course[.,!]?\s*|alright[.,!]?\s*|yes[.,!]?\s*|absolutely[.,!]?\s*|will do[.,!]?\s*)+(.+)$/i;
  const imperativeRe =
    /\b(include|add|adding|make|set|schedule|remember|save|create|update|find|track|monitor|build|enable|disable|start|stop|always|never|change|put|drop|move|switch|focus|prioritize|deprioritize|stop sending|send|email|text|call|skip|ignore|allow|disallow|require|prefer)\b/i;
  // Amy's own conversational filler ("I'll make sure...", "I'll prioritize...",
  // "Let me know if...") is NOT a directive. It used to flood the dispatch
  // queue because it follows an ack word and contains an imperative verb.
  // A genuine restated directive is in imperative mood ("Schedule...",
  // "Include...", "Always send..."), never first-person-future Amy speech.
  // Reject bodies that open with that filler shape (ExampleCo 2026-05-18).
  const fillerRe = /^(?:i'?ll\b|i will\b|i'?m\b|i can\b|i'?d\b|i have\b|i'?ve\b|let me\b|if (?:you|there|that)\b|that (?:sounds|works)\b|sounds\b|thanks\b|no problem\b|happy to\b)/i;
  const directives = [];
  const seen = new Set();
  for (const rawLine of transcript.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = line.match(ackRe);
    if (!m) continue;
    const body = (m[1] || '').trim();
    if (body.length < 20) continue;
    if (fillerRe.test(body)) continue;
    if (!imperativeRe.test(body)) continue;
    const norm = body.toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(norm)) continue;
    seen.add(norm);
    directives.push(body);
  }
  return directives;
}

function hasExplicitAmyTrigger(text) {
  return /(?:^|[^\w])#amy\b|hashtag\s+amy\b/i.test(String(text || ''));
}

function hasExplicitUserAmyTrigger(transcript) {
  const lines = String(transcript || '').split(/\r?\n/);
  const hasRoleLines = lines.some((line) => /^(User|AI|Assistant):\s*/i.test(line.trim()));
  const userLines = lines
    .map((line) => line.trim())
    .filter((line) => /^User:\s*/i.test(line))
    .map((line) => line.replace(/^User:\s*/i, ''));
  if (userLines.length > 0) return userLines.some(hasExplicitAmyTrigger);
  if (hasRoleLines) return false;
  return hasExplicitAmyTrigger(transcript);
}

function isOwnerCall(customer, ownerPhones) {
  if (!customer || !ownerPhones || !ownerPhones.length) return false;
  const customerDigits = String(customer).replace(/\D/g, '');
  if (!customerDigits) return false;
  return ownerPhones.some((p) => {
    if (!p) return false;
    const pd = String(p).replace(/\D/g, '');
    if (!pd) return false;
    return customerDigits.includes(pd) || pd.includes(customerDigits);
  });
}

// isOwnerCall above matches loosely on purpose: it decides authorization, and
// a partial or reformatted owner CLI must not lock ExampleCo out of his own tools.
// Suppression is the opposite risk. A loose match here silently DELETES a third
// party's call report, so identity must be exact (2026-08-16, Codex finding):
// both sides normalize to a full-length national number and compare equal.
// `+10578` therefore no longer counts as ExampleCo.
function isDeclaredExampleCoPhone(customer, ExampleCoPhones) {
  if (!customer || !Array.isArray(ExampleCoPhones) || !ExampleCoPhones.length) return false;
  const national = (value) => {
    const digits = String(value || '').replace(/\D/g, '');
    if (digits.length < 10) return '';
    return digits.slice(-10);
  };
  const callerNational = national(customer);
  if (!callerNational) return false;
  return ExampleCoPhones.some((p) => national(p) === callerNational);
}

function callTranscript(msg, callObj) {
  return String(
    (msg && msg.transcript) ||
      (msg && msg.artifact && msg.artifact.transcript) ||
      (callObj && callObj.transcript) ||
      '',
  ).trim();
}

function callSummary(msg, callObj) {
  return String(
    (msg && msg.analysis && msg.analysis.summary) ||
      (msg && msg.summary) ||
      (callObj && callObj.summary) ||
      '',
  ).replace(/\s+/g, ' ').trim();
}

function callerTurns(transcript) {
  return String(transcript || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line) => line.match(/^(?:User|Caller|Customer):\s*(.+)$/i))
    .filter(Boolean)
    .map((match) => match[1].replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function transcriptSummaryFallback(transcript) {
  const turns = callerTurns(transcript);
  if (!turns.length) return '';
  let text = turns.slice(0, 3).join(' ');
  const introduction = text.match(/^this is\s+([^.!?]+)[.!?]\s*(.+)$/i);
  if (introduction) text = `${introduction[1].trim()}: ${introduction[2].trim()}`;
  if (text.length > 700) text = text.slice(0, 697).replace(/\s+\S*$/, '') + '...';
  return text;
}

function callDurationSeconds(callObj) {
  const explicit = Number(callObj && callObj.durationSeconds);
  if (Number.isFinite(explicit) && explicit >= 0) return Math.round(explicit);
  const start = Date.parse((callObj && callObj.startedAt) || '');
  const end = Date.parse((callObj && callObj.endedAt) || '');
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return Math.round((end - start) / 1000);
}

function formatCallDuration(seconds) {
  if (!Number.isFinite(seconds)) return '';
  const whole = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(whole / 60);
  const remainder = whole % 60;
  if (!minutes) return `${remainder}s`;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function endedWithoutConversation(callObj, transcript) {
  if (callerTurns(transcript).length) return false;
  const reason = String((callObj && callObj.endedReason) || '').toLowerCase();
  return /(?:did-not-answer|customer-busy|call-rejected|invalid-number|number-unavailable|failed-to-connect|no-route)/.test(
    reason,
  );
}

function isInboundCall(callObj) {
  return /inbound/i.test(String((callObj && callObj.type) || ''));
}

const VOICEMAIL_PROMPT = /(?:voicemail|leave (?:a|your) message|after the (?:beep|tone)|record your message)/i;
// Carrier voicemail systems keep talking after the recording ends ("Your
// message has been sent", delivery options, time-limit notices). Those are
// system prompts, not a person, so they must not turn a voicemail into a
// human-reached call (vendor voicemail, 2026-10-05). They are discounted only
// after a voicemail prompt and Amy's recorded message: a real person saying
// "your message has been sent to our estimator" on a live call stays human.
const POST_RECORDING_PROMPT = /(?:message (?:has been|was|is being) (?:sent|saved|delivered|received|recorded)|maximum (?:time|length)|(?:normal|urgent) delivery|re-?record)/i;

function nonIvrHumanTurns(transcript) {
  const ivr = /(?:press|dial|menu|extension|your call|recorded|business hours|listen carefully|main menu|voicemail|leave a message|tone|representative|operator)/i;
  const humans = [];
  let voicemailPromptSeen = false;
  let recordingLeft = false;
  for (const raw of String(transcript || '').split(/\r?\n/)) {
    const line = raw.trim();
    const caller = line.match(/^(?:User|Caller|Customer):\s*(.+)$/i);
    if (caller) {
      const turn = caller[1].replace(/\s+/g, ' ').trim();
      if (!turn) continue;
      if (VOICEMAIL_PROMPT.test(turn)) voicemailPromptSeen = true;
      if (ivr.test(turn)) continue;
      if (recordingLeft && POST_RECORDING_PROMPT.test(turn)) continue;
      humans.push(turn);
      continue;
    }
    const assistant = line.match(/^AI:\s*(.*)$/i);
    if (voicemailPromptSeen && assistant && String(assistant[1] || '').trim().length >= 12) {
      recordingLeft = true;
    }
  }
  return humans;
}

function voicemailWasLeft(transcript) {
  let voicemailPromptSeen = false;
  for (const line of String(transcript || '').split(/\r?\n/)) {
    const user = line.trim().match(/^(?:User|Caller|Customer):\s*(.*)$/i);
    if (user && VOICEMAIL_PROMPT.test(user[1])) {
      voicemailPromptSeen = true;
      continue;
    }
    const assistant = line.trim().match(/^AI:\s*(.*)$/i);
    if (voicemailPromptSeen && assistant && String(assistant[1] || '').trim().length >= 12) {
      return true;
    }
  }
  return false;
}

function classifyOutboundCallOutcome(msg, callObj, deps = {}) {
  const customer = callObj?.customer?.number || '';
  const syntheticSelfTest = isDeclaredExampleCoPhone(customer, deps.selfTestPhones || []);
  // A configured Amy-to-Amy route is a machine probe, not a human
  // interaction. Its release harness remains responsible for passing or
  // failing the conversation. Provider/model failures still trip the global
  // circuit breaker below, but ordinary synthetic dialogue must never be
  // mislabeled as relationship damage merely because Vapi renders the other
  // assistant's speech as `User:` turns.
  if (syntheticSelfTest) return 'no_human_reached';
  const transcript = callTranscript(msg, callObj);
  const humans = nonIvrHumanTurns(transcript);
  if (!humans.length && voicemailWasLeft(transcript)) return 'voicemail_left';
  if (!humans.length) return 'no_human_reached';
  const evaluation = msg?.analysis?.successEvaluation ?? callObj?.analysis?.successEvaluation;
  if (
    evaluation === true ||
    /^(?:true|pass|passed|success|successful|objective met)$/i.test(String(evaluation || '').trim())
  ) {
    return 'clean_success';
  }
  return 'failed_human_interaction';
}

function outboundCallsDir(deps = {}) {
  if (deps.callsDir) return deps.callsDir;
  if (process.platform !== 'win32' && fs.existsSync('/opt/secondbrain/data')) {
    return '/opt/secondbrain/data/calls';
  }
  return path.join(path.resolve(__dirname, '..'), 'data', 'calls');
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, file);
}

function appendJsonlSync(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'a', 0o600);
  try {
    fs.writeSync(fd, `${JSON.stringify(value)}\n`, null, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function appendDamageControlOnce(file, value) {
  try {
    const prior = fs.readFileSync(file, 'utf8');
    if (prior.split(/\r?\n/).some((line) => {
      try { return JSON.parse(line).callId === value.callId; } catch { return false; }
    })) return false;
  } catch {
    // The ledger does not exist yet.
  }
  appendJsonlSync(file, value);
  return true;
}

function finalizePreJevOutcome(record, callId, deps = {}) {
  record.outcome_classification = record.pre_jev_outcome_classification || 'needs_review';
  let damageControl = null;
  let outboundPause = null;
  const dataDir = path.dirname(outboundCallsDir(deps));
  if (record.outcome_classification === 'clean_success') {
    clearPendingCallClassification({ callId, dataDir, nowIso: deps.nowIso });
  } else if (record.outcome_classification === 'failed_human_interaction' && !record.principal_contact) {
    damageControl = {
      ts: new Date().toISOString(), callId, phone: record.phoneNumber,
      callee_name: record.recipient || null, business: record.business || null,
      what_went_wrong: record.summary || 'A human was reached, but the objective was not proven successful.',
      ExampleCo_repair_message: `Acknowledge the awkward or failed AI call, apologize briefly, and handle the ${record.objective || record.instructions || 'original objective'} personally.`,
      recommended_channel: 'ExampleCo chooses email, direct call, or in-person repair', objective_status: 'not_proven',
    };
    appendDamageControlOnce(deps.damageControlPath || path.join(dataDir, 'agent', 'damage-control-needed.jsonl'), damageControl);
    outboundPause = pauseOutboundCalls({
      dataDir,
      reason: `Call ${callId} reached a human but did not complete cleanly. Further calls require owner review.`,
      source: 'failed-human-interaction', nowIso: deps.nowIso,
    });
  } else if (record.outcome_classification === 'failed_human_interaction') {
    clearPendingCallClassification({ callId, resolution: 'principal_failed', dataDir, nowIso: deps.nowIso });
  } else {
    clearPendingCallClassification({ callId, resolution: 'terminal_unresolved', dataDir, nowIso: deps.nowIso });
  }
  return { damageControl, outboundPause };
}

function settleOutboundCallRecord(msg, callObj, deps = {}) {
  const callId = callObj?.id || msg?.callId;
  if (!callId) return null;
  const callsDir = outboundCallsDir(deps);
  const file = path.join(callsDir, `${callId}.json`);
  const prior = (() => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  })();
  const outbound = /outbound/i.test(String(callObj?.type || '')) || prior;
  if (!outbound) return null;
  const syntheticSelfTest = isDeclaredExampleCoPhone(
    callObj?.customer?.number || '',
    deps.selfTestPhones || [],
  );
  const preliminaryClassification = classifyOutboundCallOutcome(msg, callObj, deps);
  const deterministicFailureEvidence = preliminaryClassification === 'failed_human_interaction' &&
    /\b(?:do not call|don't call|stop calling|wrong number|remove me|complaint|angry|upset|threat|harass|never call)\b/i
      .test(`${callTranscript(msg, callObj)} ${callSummary(msg, callObj)} ${callObj?.endedReason || ''}`);
  const settleDamageControl = deps.deferHumanOutcome === true
    ? deterministicFailureEvidence
    : preliminaryClassification === 'failed_human_interaction';
  const outcomeClassification = deps.deferHumanOutcome === true &&
    !['no_human_reached', 'voicemail_left'].includes(preliminaryClassification)
    ? 'needs_review'
    : preliminaryClassification;
  const principalContact = listPrincipalPhones({ callsDir }).includes(
    normalizePhone(prior?.phoneNumber || callObj?.customer?.number || ''),
  );
  const record = {
    ...(prior || {}),
    id: callId,
    phoneNumber: prior?.phoneNumber || callObj?.customer?.number || '',
    recipient: prior?.recipient || callObj?.customer?.name || '',
    status: 'ended',
    endedReason: callObj?.endedReason || '',
    endedAt: callObj?.endedAt || new Date().toISOString(),
    durationSeconds: callDurationSeconds(callObj),
    transcript: callTranscript(msg, callObj),
    summary: callSummary(msg, callObj),
    prep_manifest: prior?.prep_manifest || [],
    outcome_classification: outcomeClassification,
    pre_jev_outcome_classification: preliminaryClassification,
    principal_contact: principalContact,
    synthetic_self_test: syntheticSelfTest,
  };
  writeJsonAtomic(file, record);
  let damageControl = null;
  if (settleDamageControl && !principalContact) {
    damageControl = {
      ts: new Date().toISOString(),
      callId,
      phone: record.phoneNumber,
      callee_name: record.recipient || null,
      business: prior?.business || null,
      what_went_wrong: record.summary || 'A human was reached, but the objective was not proven successful.',
      ExampleCo_repair_message: `Acknowledge the awkward or failed AI call, apologize briefly, and handle the ${prior?.objective || prior?.instructions || 'original objective'} personally.`,
      recommended_channel: 'ExampleCo chooses email, direct call, or in-person repair',
      objective_status: 'not_proven',
    };
    const damagePath =
      deps.damageControlPath || path.join(path.dirname(callsDir), 'agent', 'damage-control-needed.jsonl');
    appendDamageControlOnce(damagePath, damageControl);
  }
  const providerPathFailure = /(?:custom[-_ ]?llm|providerfault|server[-_ ]?error|model[-_ ]?no[-_ ]?response|llm[-_ ]?failed)/i.test(
    String(callObj?.endedReason || ''),
  );
  let outboundPause = null;
  if (providerPathFailure) {
    const dataDir = path.dirname(callsDir);
    const current = readOutboundCallControl({ dataDir });
    outboundPause = current.mode === 'paused' && current.source !== 'awaiting-jev-call-classification'
      ? current
      : pauseOutboundCalls({
        dataDir,
        reason: `Call ${callId} failed on the live voice model/provider path. Further calls require owner review.`,
        source: 'voice-provider-failure',
        nowIso: deps.nowIso,
      });
  } else if (deterministicFailureEvidence) {
    const dataDir = path.dirname(callsDir);
    const current = readOutboundCallControl({ dataDir });
    outboundPause = current.mode === 'paused' && current.source !== 'awaiting-jev-call-classification'
      ? current
      : pauseOutboundCalls({
        dataDir,
        reason: `Call ${callId} reached a human but did not complete cleanly. Further calls require owner review.`,
        source: 'failed-human-interaction',
        nowIso: deps.nowIso,
      });
  } else if (outcomeClassification === 'needs_review') {
    const dataDir = path.dirname(callsDir);
    const current = readOutboundCallControl({ dataDir });
    if (current.mode === 'enabled' || current.source === 'awaiting-jev-call-classification') {
      outboundPause = pauseOutboundCalls({
        dataDir,
        reason: `call:${callId} reached a human and is awaiting Jev outcome classification.`,
        source: 'awaiting-jev-call-classification',
        scope: 'human-only',
        nowIso: deps.nowIso,
      });
    } else {
      outboundPause = current;
    }
  } else if (outcomeClassification === 'failed_human_interaction' || providerPathFailure) {
    outboundPause = pauseOutboundCalls({
      dataDir: path.dirname(callsDir),
      reason:
        outcomeClassification === 'failed_human_interaction'
          ? `Call ${callId} reached a human but did not complete cleanly. Further calls require owner review.`
          : `Call ${callId} failed on the live voice model/provider path. Further calls require owner review.`,
      source:
        outcomeClassification === 'failed_human_interaction'
          ? 'failed-human-interaction'
          : 'voice-provider-failure',
      nowIso: deps.nowIso,
    });
  }
  return {
    outcomeClassification,
    recordPath: file,
    damageControl,
    outboundPause,
    brokeredIntent: Boolean(prior),
    principalContact,
    syntheticSelfTest,
  };
}

async function enrichOutboundCallWithJev(msg, callObj, deps = {}) {
  const callId = callObj?.id || msg?.callId;
  if (!callId) return { skipped: 'missing_call_id' };
  const file = path.join(outboundCallsDir(deps), `${callId}.json`);
  let record;
  try { record = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { skipped: 'missing_call_record' }; }
  if (['no_human_reached', 'voicemail_left'].includes(record.outcome_classification)) {
    return { skipped: 'deterministic_nonhuman_outcome' };
  }
  if (record.synthetic_self_test) return { skipped: 'synthetic_self_test' };
  if (record.jev_outcome?.accepted && ['clean_success', 'failed_human_interaction'].includes(record.outcome_classification)) {
    return { skipped: 'already_classified', ...record.jev_outcome };
  }
  if (jevClassificationsInFlight.has(callId)) return { skipped: 'classification_in_flight' };
  jevClassificationsInFlight.add(callId);
  try {
    const decision = await classifyFinishedCall({
      transcript: record.transcript,
      goal: record.goal || record.objective || callObj?.assistantOverrides?.variableValues?.goal || '',
      recipient: record.recipient,
      deps: deps.jevDeps || {},
    });
    const accepted = decision.accepted && ['clean_success', 'failed_human_interaction'].includes(decision.choice);
    const attempts = accepted ? Number(record.jev_outcome?.attempts || 0) : Number(record.jev_outcome?.attempts || 0) + 1;
    const terminal = !accepted && attempts >= 3;
    record.outcome_classification = accepted
      ? decision.choice
      : record.pre_jev_outcome_classification === 'failed_human_interaction'
        ? 'failed_human_interaction'
        : terminal
          ? record.pre_jev_outcome_classification || 'needs_review'
          : 'needs_review';
    record.jev_outcome = {
      accepted,
      choice: decision.choice,
      confidence: decision.minProbability,
      threshold: 0.9,
      attempts,
      terminal,
      nextRetryAt: !accepted && !terminal
        ? new Date(Date.now() + Math.min(6 * 60 * 60_000, 5 * 60_000 * (2 ** (attempts - 1)))).toISOString()
        : null,
      assessedAt: new Date().toISOString(),
    };
    writeJsonAtomic(file, record);
    let damageControl = null;
    let outboundPause = null;
    if (terminal) {
      ({ damageControl, outboundPause } = finalizePreJevOutcome(record, callId, deps));
      writeJsonAtomic(file, record);
    } else if (record.outcome_classification === 'clean_success') {
      clearPendingCallClassification({ callId, dataDir: path.dirname(outboundCallsDir(deps)), nowIso: deps.nowIso });
    } else if (record.outcome_classification === 'failed_human_interaction' && !record.principal_contact) {
      damageControl = {
          ts: new Date().toISOString(), callId, phone: record.phoneNumber,
          callee_name: record.recipient || null, business: record.business || null,
          what_went_wrong: record.summary || 'A human was reached, but the objective was not proven successful.',
          ExampleCo_repair_message: `Acknowledge the awkward or failed AI call, apologize briefly, and handle the ${record.objective || record.instructions || 'original objective'} personally.`,
          recommended_channel: 'ExampleCo chooses email, direct call, or in-person repair', objective_status: 'not_proven',
        };
      appendDamageControlOnce(deps.damageControlPath || path.join(path.dirname(outboundCallsDir(deps)), 'agent', 'damage-control-needed.jsonl'), damageControl);
      outboundPause = pauseOutboundCalls({
        dataDir: path.dirname(outboundCallsDir(deps)),
        reason: `Call ${callId} reached a human but did not complete cleanly. Further calls require owner review.`,
        source: 'failed-human-interaction', nowIso: deps.nowIso,
      });
    } else if (record.outcome_classification === 'failed_human_interaction') {
      clearPendingCallClassification({ callId, resolution: 'principal_failed', dataDir: path.dirname(outboundCallsDir(deps)), nowIso: deps.nowIso });
    }
    return { ...record.jev_outcome, damageControl, outboundPause };
  } catch (error) {
    const attempts = Number(record.jev_outcome?.attempts || 0) + 1;
    const permanent = ['privacy_excluded', 'backend_off'].includes(String(error.code || ''));
    const terminal = permanent || attempts >= 3;
    record.outcome_classification = terminal
      ? record.pre_jev_outcome_classification || 'needs_review'
      : record.pre_jev_outcome_classification === 'failed_human_interaction'
        ? 'failed_human_interaction'
        : 'needs_review';
    record.jev_outcome = {
      accepted: false,
      error: String(error.code || error.message || error),
      attempts,
      terminal,
      nextRetryAt: terminal ? null : new Date(Date.now() + Math.min(6 * 60 * 60_000, 5 * 60_000 * (2 ** (attempts - 1)))).toISOString(),
      threshold: 0.9,
      assessedAt: new Date().toISOString(),
    };
    writeJsonAtomic(file, record);
    let damageControl = null;
    let outboundPause = null;
    if (terminal || record.outcome_classification === 'failed_human_interaction') {
      ({ damageControl, outboundPause } = finalizePreJevOutcome(record, callId, deps));
      writeJsonAtomic(file, record);
    }
    return { ...record.jev_outcome, damageControl, outboundPause };
  } finally {
    jevClassificationsInFlight.delete(callId);
  }
}

async function reconcilePendingCallClassifications(deps = {}) {
  const callsDir = outboundCallsDir(deps);
  let files = [];
  try {
    files = fs.readdirSync(callsDir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => ({ name, mtimeMs: fs.statSync(path.join(callsDir, name)).mtimeMs }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .map((row) => row.name);
  } catch {
    return { scanned: 0, reconciled: 0 };
  }
  let reconciled = 0;
  for (const name of files) {
    let record;
    try { record = JSON.parse(fs.readFileSync(path.join(callsDir, name), 'utf8')); } catch { continue; }
    if (record.outcome_classification !== 'needs_review' || record.synthetic_self_test || !Object.hasOwn(record, 'pre_jev_outcome_classification')) continue;
    if (deps.controlPlaneEnabled === false) {
      record.jev_outcome = { ...(record.jev_outcome || {}), accepted: false, terminal: true, error: 'control_plane_off', assessedAt: new Date().toISOString() };
      finalizePreJevOutcome(record, record.id || path.basename(name, '.json'), deps);
      writeJsonAtomic(path.join(callsDir, name), record);
      reconciled += 1;
      continue;
    }
    if (record.jev_outcome?.terminal) continue;
    if (Date.parse(record.jev_outcome?.nextRetryAt || '') > Date.now()) continue;
    const result = await enrichOutboundCallWithJev({}, { id: record.id || path.basename(name, '.json') }, deps);
    if (result.accepted) reconciled += 1;
  }
  return { scanned: files.length, reconciled };
}

function buildInboundCallBrief(msg, callObj) {
  if (!isInboundCall(callObj)) return null;
  const transcript = callTranscript(msg, callObj);
  const generatedSummary = callSummary(msg, callObj);
  const transcriptSummary = transcriptSummaryFallback(transcript);
  const endedReason = String((callObj && callObj.endedReason) || '').replace(/[-_]+/g, ' ').trim();
  let groundedSummary = generatedSummary || transcriptSummary;
  if (endedWithoutConversation(callObj, transcript)) {
    groundedSummary = `No conversation. ${groundedSummary || endedReason || 'The call ended before anyone spoke.'}`;
  } else if (!groundedSummary) {
    groundedSummary = endedReason
      ? `No transcript or provider summary was captured. The call ended: ${endedReason}.`
      : 'No transcript, provider summary, or end reason was captured.';
  }

  const customer = (callObj && callObj.customer) || (msg && msg.call && msg.call.customer) || {};
  const name = String(customer.name || '').replace(/\s+/g, ' ').trim();
  const phone = String(customer.number || '').trim();
  const party = name && phone ? `${name} (${phone})` : name || phone || 'unknown caller';
  const duration = formatCallDuration(callDurationSeconds(callObj));
  const facts = ['Inbound', duration, endedReason].filter(Boolean);
  const lines = [`Phone call with ${party}`];
  if (facts.length) lines.push(facts.join(' | '));
  lines.push('', `Summary: ${groundedSummary}`);
  return lines.join('\n');
}

function sendVoiceFollowup(deps, sendMessage, payload) {
  const notify =
    typeof deps.notify === 'function'
      ? deps.notify
      : ({ text, kind, source, dedupKey }) =>
          sendMessage(text, {
            raw: true,
            kind,
            extras: { source, dedup_key: dedupKey },
          });
  Promise.resolve(notify(payload)).catch(() => {});
}

/**
 * Process an end-of-call-report event. Pure function in spirit: all I/O
 * and external sends go through injected dependencies so tests can
 * substitute fakes.
 *
 * deps = {
 *   ownerPhones: string[],     // OWNER_PHONES from ec2-server.js env
 *   ExampleCoPhones?: string[],     // ExampleCo_PHONES: ExampleCo's own identities; his calls send no report
 *   selfTestPhones?: string[], // VAPI_SELF_TEST_CALLER_PHONES: synthetic probes send no report
 *   sendMessage: (text) => Promise<void>,
 *   notify?: (payload) => Promise<object>, // notify-with-fallback in production
 *   queuePath?: string,         // override for tests
 *   rawDir?: string,            // override for tests
 *   nowIso?: () => string,      // override for tests (deterministic ts)
 * }
 */
function handleEndOfCallReport(msg, callObj, deps = {}) {
  const ownerPhones = Array.isArray(deps.ownerPhones) ? deps.ownerPhones : [];
  // ExampleCo identities only, never the wider owner list: an authorized principal
  // who is not ExampleCo must still be summarized to him. Defaults to empty so a
  // caller that does not know ExampleCo's numbers suppresses nothing.
  const ExampleCoPhones = Array.isArray(deps.ExampleCoPhones) ? deps.ExampleCoPhones : [];
  const selfTestPhones = Array.isArray(deps.selfTestPhones) ? deps.selfTestPhones : [];
  // Named so the public-mirror scrub cannot collapse it into the same
  // identifier as `ExampleCoPhones` (Codex review 1eef3df7d94b, 2026-09-07).
  const ExampleCoOwnerPhones = Array.isArray(deps.ExampleCoPhones) ? deps.ExampleCoPhones : [];
  const sendMessage = typeof deps.sendMessage === 'function' ? deps.sendMessage : () => Promise.resolve();
  const nowIso = typeof deps.nowIso === 'function' ? deps.nowIso : () => new Date().toISOString();

  const callId = (callObj && callObj.id) || (msg && msg.callId) || 'unknown';
  const transcript = callTranscript(msg, callObj);
  const summary = callSummary(msg, callObj);
  const customer =
    (callObj && callObj.customer && callObj.customer.number) ||
    (msg && msg.call && msg.call.customer && msg.call.customer.number) ||
    '';
  const startedAt =
    (callObj && callObj.startedAt) ||
    (msg && msg.startedAt) ||
    nowIso();
  const spineOpts = { nowIso };
  const tasksDir = getSpineTasksDir(deps);
  if (tasksDir) spineOpts.tasksDir = tasksDir;
  if (deps.notify) spineOpts.notify = deps.notify;
  const effectReceipts = Array.isArray(deps.effectReceipts)
    ? deps.effectReceipts
    : readEffectReceipts({ callId, ledgerPath: deps.effectLedgerPath });
  const sideEffectAudit = auditCompletedSideEffectClaims({ transcript, receipts: effectReceipts });
  const outboundOutcome = settleOutboundCallRecord(msg, callObj, deps);
  const outcomeFields = outboundOutcome
    ? {
        outcomeClassification: outboundOutcome.outcomeClassification,
        callRecordPath: outboundOutcome.recordPath,
        damageControl: outboundOutcome.damageControl,
        outboundPause: outboundOutcome.outboundPause,
        principalContact: outboundOutcome.principalContact,
      }
    : {};

  // 1) Raw archival before any processing.
  let rawPath = '';
  try {
    const rawDir = getVapiRawDir({ rawDir: deps.rawDir });
    fs.mkdirSync(rawDir, { recursive: true });
    rawPath = path.join(rawDir, callId + '.json');
    fs.writeFileSync(
      rawPath,
      JSON.stringify({ savedAt: nowIso(), callObj, msg }, null, 2),
    );
  } catch (e) {
    // Raw archive failure is non-fatal: the dispatch path still runs.
    rawPath = '';
  }

  let spineTaskId = null;
  try {
    const task = recordDispatchInput(
      {
        kind: 'ingest',
        origin: 'voice',
        sourceType: 'amy-call',
        sourceRef: callId,
        title: `Amy call: ${callId}`,
        text: transcript || summary || '(No transcript text captured.)',
        ts: startedAt,
        approved: false,
        meta: {
          explicitRequest: false,
          callId,
          rawPath: rawPath || null,
          customerPhone: customer || null,
        },
      },
      spineOpts,
    );
    spineTaskId = task.id;
  } catch (e) {
    // Spine write failure is non-fatal for the archival path, but it is
    // surfaced in the return payload for probes/tests.
    spineTaskId = null;
  }

  // Every inbound call from someone other than ExampleCo gets one grounded outcome
  // brief, independent of directive authority, transcript quality, or answer
  // status. Direction plus caller identity are the eligibility gates; the Vapi
  // call ID is the dedup key.
  //
  // ExampleCo's own inbound calls report nothing: he was on the call, so a summary
  // of it back to him is pure noise (ExampleCo, 2026-08-16). This gate is narrower
  // than the owner gate below: PRIVATE_NAME, or any other authorized principal, is
  // still "not ExampleCo" and must be summarized to him.
  //
  // Amy's self-test dials her own inbound number, so the loop-back leg arrives
  // as an ordinary inbound call from the Twilio caller ID. It is a synthetic
  // probe, not a person, and it was the bulk of the reports ExampleCo was getting.
  // Self-test identity is kept as its own list, never folded into ExampleCo_PHONES:
  // a shared route number is not proof of ExampleCo.
  const noHumanToReport =
    isInboundCall(callObj) &&
    (isDeclaredExampleCoPhone(customer, ExampleCoPhones) || isDeclaredExampleCoPhone(customer, selfTestPhones));
  const inboundBrief = noHumanToReport ? null : buildInboundCallBrief(msg, callObj);
  if (inboundBrief) {
    sendVoiceFollowup(deps, sendMessage, {
      text: inboundBrief,
      source: 'vapi-end-of-call',
      kind: 'voice-followup',
      dedupKey: `inbound-call:${callId}`,
      raw: true,
    });
  }
  // Routine outbound calls are not inbound-call notifications, but a failed
  // human interaction still needs one visible repair alert. Otherwise the
  // global stop can trip while the owner never learns how to protect the
  // relationship.
  if (!isInboundCall(callObj) && outboundOutcome?.brokeredIntent && outboundOutcome?.damageControl) {
    sendVoiceFollowup(deps, sendMessage, {
      text: `Damage control needed for call ${callId}: ${outboundOutcome.damageControl.ExampleCo_repair_message}`,
      source: 'vapi-end-of-call',
      kind: 'voice-followup',
      dedupKey: `damage-control:${callId}`,
      raw: true,
    });
  }

  // 2) Only mine directives from owner calls. Random inbounds get archived
  //    but never auto-dispatched.
  if (!isOwnerCall(customer, ownerPhones)) {
    return {
      archived: !!rawPath,
      rawPath,
      directives: [],
      skipped: 'non-owner',
      spineTaskId,
      sideEffectAudit,
      inboundBrief: !!inboundBrief,
      ...outcomeFields,
    };
  }

  const recentContext = appendRecentOwnerCallContext(
    {
      callId,
      customer,
      startedAt,
      transcript,
      summary,
    },
    {
      contextPath: deps.recentContextPath,
      nowIso,
    },
  );

  if (!sideEffectAudit.ok) {
    const lines = [
      'Amy side-effect claim failed audit on call ' + callId + ':',
    ];
    for (const claim of sideEffectAudit.unsupported.slice(0, 5)) {
      lines.push('- Unsupported ' + claim.effect_kind + ' completion claim: "' + claim.text.slice(0, 240) + '"');
    }
    lines.push('');
    lines.push('No matching successful side-effect receipt was recorded, so treat the claim as false until repaired.');
    Promise.resolve(sendMessage(lines.join('\n'))).catch(() => {});
  }

  // 3) Extract directives, write one spine task per directive, and append
  //    matching legacy queue receipts for dashboard/backfill compatibility.
  const directives = extractDirectivesFromTranscript(transcript);
  if (directives.length === 0) {
    return { archived: !!rawPath, rawPath, directives: [], skipped: 'no-directives', spineTaskId, sideEffectAudit, recentContext, ...outcomeFields };
  }

  if (!hasExplicitUserAmyTrigger(transcript)) {
    return {
      archived: !!rawPath,
      rawPath,
      directives: [],
      skipped: 'no-explicit-amy-trigger',
      spineTaskId,
      sideEffectAudit,
      recentContext,
      ...outcomeFields,
    };
  }

  const queuePath = getDispatchQueuePath({ queuePath: deps.queuePath });
  const writtenEntries = [];
  const directiveTaskIds = [];
  const authenticatedExampleCoDispatch =
    !isInboundCall(callObj) && isOwnerCall(customer, ExampleCoOwnerPhones);
  try {
    fs.mkdirSync(path.dirname(queuePath), { recursive: true });
    for (const [index, d] of directives.entries()) {
      const directiveTask = recordDispatchInput(
        {
          origin: 'voice',
          sourceType: 'vapi_call',
          sourceRef: `${callId}:directive:${index + 1}`,
          title: `Voice directive: ${d}`.slice(0, 100),
          text: [
            `Directive captured from Vapi call ${callId}.`,
            `Call started: ${startedAt}`,
            summary ? `Call summary: ${summary}` : '',
            '',
            d,
          ].filter(Boolean).join('\n'),
          parentId: spineTaskId || undefined,
          approved: true,
          meta: {
            explicitRequest: true,
            callId,
            directiveIndex: index + 1,
            rawPath: rawPath || null,
            customerPhone: customer || null,
            ...(authenticatedExampleCoDispatch
              ? {
                  hasAmy: true,
                  principal: 'ExampleCo',
                  principalAuthenticated: true,
                  principalDispatchSummary: d,
                }
              : {}),
          },
        },
        spineOpts,
      );
      directiveTaskIds.push(directiveTask.id);
      const entry = {
        ts: nowIso(),
        source: 'vapi_call',
        vapi_call_id: callId,
        customer_phone: customer,
        call_started_at: startedAt,
        section: 'voice_directive',
        itemRef: callId,
        comment: d,
        call_summary: summary,
        raw_path: rawPath,
        spine_task_id: directiveTask.id,
        explicitRequest: true,
        explicitAmyTrigger: true,
        status: 'queued',
      };
      fs.appendFileSync(queuePath, JSON.stringify(entry) + '\n');
      writtenEntries.push(entry);
    }
  } catch (e) {
    return { archived: !!rawPath, rawPath, directives, directiveWriteError: e.message, spineTaskId, directiveTaskIds, sideEffectAudit, recentContext, ...outcomeFields };
  }

  return {
    archived: !!rawPath,
    rawPath,
    directives,
    queuePath,
    written: writtenEntries.length,
    spineTaskId,
    directiveTaskIds,
    sideEffectAudit,
    recentContext,
    ...outcomeFields,
  };
}

module.exports = {
  extractDirectivesFromTranscript,
  hasExplicitAmyTrigger,
  hasExplicitUserAmyTrigger,
  isOwnerCall,
  callTranscript,
  callSummary,
  transcriptSummaryFallback,
  isDeclaredExampleCoPhone,
  buildInboundCallBrief,
  classifyOutboundCallOutcome,
  enrichOutboundCallWithJev,
  reconcilePendingCallClassifications,
  voicemailWasLeft,
  nonIvrHumanTurns,
  settleOutboundCallRecord,
  handleEndOfCallReport,
  getDispatchQueuePath,
  getVapiRawDir,
  getSpineTasksDir,
};
