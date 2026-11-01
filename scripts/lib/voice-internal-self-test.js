'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { currentVoiceSurface, DIRECTIVE_SCHEMA, NEWS_SCHEMA, SCHEMA, validateDirectiveEvidence, validateEvidence, validateNewsEvidence } = require('./voice-release-proof.js');
const AUTHORITY = 'auth-internal-voice-self-tests';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function phone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length === 10 ? `+1${digits}` : digits ? `+${digits}` : '';
}

function intentDirectory(dataDir) {
  return path.join(dataDir, 'agent', 'internal-voice-test-intents');
}

function intentPath(dataDir, invocationKey) {
  if (!UUID.test(String(invocationKey || ''))) throw new Error('Invalid internal test invocation.');
  return path.join(intentDirectory(dataDir), `${invocationKey.toLowerCase()}.json`);
}

function assertInternalTestingNotRevoked(operatorState) {
  const knownSources = new Set(['default', 'owner-resume', 'owner-resume-after-principal-test',
    'failed-human-interaction', 'safety-circuit-breaker', 'owner-message', 'owner-stop', 'authenticated-owner-command',
    // Production releases to enabled: clearPendingCallClassification (clean or
    // terminal-unresolved Jev result) and liftPauseAfterCleanPrincipalCall.
    // Unknown, they blocked every voice release proof after such a call
    // (2026-10-21 deploy, HTTP 409; Codex e76e2a867e94).
    'jev-call-classification-clean', 'jev-call-classification-terminal-unresolved',
    'principal-live-call-clean']);
  // A PAUSE with an explicit scope is self-describing, whatever wrote it
  // (e.g. awaiting-jev-call-classification, a call-specific pause). Enabled
  // and scope-less records still need a source whose meaning is known.
  const namedSource = typeof operatorState?.source === 'string' && operatorState.source.trim() !== '';
  const scopedPause = operatorState?.mode === 'paused' && ['human-only', 'all'].includes(operatorState.scope);
  const sourceOk = knownSources.has(operatorState?.source) || (scopedPause && namedSource);
  if (!operatorState || !['enabled', 'paused'].includes(operatorState.mode) || !sourceOk) {
    throw new Error('Internal testing cannot read valid operator control.');
  }
  // The old failed-human record predates structured scope and is specifically
  // human-only. New owner stops default to all; text is evidence, not a parser.
  const scope = operatorState.scope || (['failed-human-interaction', 'safety-circuit-breaker'].includes(operatorState.source) ? 'human-only' : 'all');
  if (operatorState.mode === 'paused' && scope !== 'human-only') {
    throw new Error('Owner explicitly stopped internal voice testing.');
  }
}

function reserveIntent(dataDir, receipt) {
  const directory = intentDirectory(dataDir);
  fs.mkdirSync(directory, { recursive: true });
  // Serialize the history check and reservation. A crashed holder is reconciled
  // explicitly; a stale lock never becomes permission to dial again.
  const lock = path.join(directory, 'admission.lock');
  const lockFd = fs.openSync(lock, 'wx', 0o600);
  try {
    const file = intentPath(dataDir, receipt.invocationKey);
    if (fs.existsSync(file)) { const error = new Error('EEXIST: internal test invocation already reserved.'); error.code = 'EEXIST'; throw error; }
    for (const name of fs.readdirSync(directory).filter(name => name.endsWith('.json'))) {
      let previous;
      try { previous = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')); }
      catch { throw new Error(`Reconcile unreadable internal test intent ${name}; original evidence preserved.`); }
      if (!['passed', 'failed', 'not-dialed'].includes(previous.outcome?.status)) {
        throw new Error(`Reconcile unresolved internal test ${previous.invocationKey} before another dial.`);
      }
      if (previous.outcome.status === 'failed' && previous.surfaceHash === receipt.surfaceHash) {
        throw new Error(`Repair the failed voice surface before retrying internal test ${previous.invocationKey}.`);
      }
    }
    const fd = fs.openSync(file, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(receipt, null, 2) + '\n'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
  } finally { fs.closeSync(lockFd); fs.unlinkSync(lock); }
}

// An authenticated caller supplies provider IDs, never a trusted success flag.
// Provider-ended legs plus this exact release proof determine the terminal state.
// The provider's terminal statuses. A leg the provider marked "failed" is over
// and settles as a failed outcome; only a live leg keeps the intent unresolved
// (Codex review 9266289e968d, aligning this rule with the harness).
const TERMINAL_CALL_STATUSES = new Set(['ended', 'failed']);

async function settleInternalVoiceSelfTest({ dataDir, invocationKey, callIds, fetchCall, fetchCalls, reconcile = false, dialerStopped = false, now = () => new Date().toISOString() }) {
  const file = intentPath(dataDir, invocationKey);
  const receipt = readIntent(file);
  if (['passed', 'failed', 'not-dialed'].includes(receipt.outcome?.status)) return receipt;
  let ids = [...new Set((callIds || []).map(String))];
  if (reconcile) {
    if (!dialerStopped || Date.parse(now()) < Date.parse(receipt.admittedAt) + 5 * 60_000) {
      throw new Error('Recovery requires the dialer stopped and five minutes of provider settlement.');
    }
    const since = new Date(Date.parse(receipt.admittedAt) - 5000).toISOString();
    const until = now();
    if (!receipt.callerPhoneNumber) throw new Error('Legacy intent lacks caller identity; reconcile with both exact provider call IDs.');
    const rows = await fetchCalls(since, until);
    if (!Array.isArray(rows) || rows.length >= 100 || rows.some(row => !Number.isFinite(Date.parse(row.createdAt)) || Date.parse(row.createdAt) < Date.parse(since) || Date.parse(row.createdAt) > Date.parse(until))) {
      throw new Error('Provider history is incomplete; internal test stays unresolved.');
    }
    const outbound = rows.filter(call => call.metadata?.amyCallCorrelationId === receipt.invocationKey &&
      call.phoneNumberId === receipt.phoneNumberId && phone(call.customer?.number) === receipt.phoneNumber);
    const outboundAt = outbound.length === 1 ? Date.parse(outbound[0].createdAt) : NaN;
    const related = rows.filter(call => call.metadata?.amyCallCorrelationId === receipt.invocationKey ||
      (call.phoneNumberId === receipt.phoneNumberId && phone(call.customer?.number) === receipt.phoneNumber) ||
      (call.phoneNumberId === receipt.inboundPhoneNumberId && phone(call.customer?.number) === receipt.callerPhoneNumber &&
       (!Number.isFinite(outboundAt) || Math.abs(Date.parse(call.createdAt) - outboundAt) <= 2000)));
    if (!related.length) return writeOutcome(file, receipt, { status: 'not-dialed', settledAt: now(), callIds: [], providerHistorySince: since });
    if (related.length > 2 || related.some(call => !TERMINAL_CALL_STATUSES.has(call.status))) throw new Error('Provider history has active or ambiguous related calls.');
    ids = related.map(call => call.id);
    if (ids.length === 1) {
      const call = related[0];
      if (call.metadata?.amyCallCorrelationId !== receipt.invocationKey || call.phoneNumberId !== receipt.phoneNumberId || phone(call.customer?.number) !== receipt.phoneNumber) {
        throw new Error('Provider history does not prove the one-leg failure.');
      }
      return writeOutcome(file, receipt, { status: 'failed', settledAt: now(), callIds: ids, providerHistorySince: since, endedReason: call.endedReason || null });
    }
  }
  if (ids.length !== 2 || ids.some(id => !UUID.test(id))) throw new Error('Reconciliation requires both actual provider call IDs; a missing leg remains unresolved.');
  const calls = await Promise.all(ids.map(id => fetchCall(id)));
  if (calls.some((call, i) => call?.id !== ids[i] ||
      ![receipt.phoneNumberId, receipt.inboundPhoneNumberId].includes(call.phoneNumberId) ||
      !Number.isFinite(Date.parse(call.createdAt)) || Date.parse(call.createdAt) < Date.parse(receipt.admittedAt) - 5000) ||
      !calls.some(call => call.metadata?.amyCallCorrelationId === receipt.invocationKey &&
        call.phoneNumberId === receipt.phoneNumberId && phone(call.customer?.number) === receipt.phoneNumber)) {
    throw new Error('Provider calls do not reconcile this exact internal test.');
  }
  if (calls.some(call => !TERMINAL_CALL_STATUSES.has(call.status))) throw new Error('Internal test is still active; do not redial.');
  const providerEndReasons = calls.map(call => ({ id: call.id, status: call.status, endedReason: call.endedReason || null }));
  // A leg the provider marked failed is a failed test whatever the proof file
  // says; the proof is consulted only when both legs ended normally.
  if (calls.some(call => call.status === 'failed')) {
    return writeOutcome(file, receipt, { status: 'failed', settledAt: now(), callIds: ids, providerEndReasons });
  }
  // An internal test is one of three scripted calls, each with its own proof
  // file: the talkback (voice-release-proof.json), the news scenario
  // (voice-news-scenario-proof.json) or the directive canary
  // (voice-directive-canary-proof.json). The proof that names these exact two
  // legs decides; the other names a different call (one news self-call
  // passed every measure and settled failed against the talkback proof).
  // Each file is read under its own schema and the canonical validator, as the
  // admission reader does; a file that fails validation proves nothing (Codex
  // review 429687418596).
  const PROOFS = [
    ['voice-release-proof.json', SCHEMA, validateEvidence],
    ['voice-news-scenario-proof.json', NEWS_SCHEMA, validateNewsEvidence],
    // The directive canary settles its own call only; admission never reads it.
    ['voice-directive-canary-proof.json', DIRECTIVE_SCHEMA, validateDirectiveEvidence],
  ];
  const passed = ids.length === 2 && PROOFS.some(([name, schema, validate]) => {
    let proof;
    try { proof = JSON.parse(fs.readFileSync(path.join(dataDir, 'agent', name), 'utf8').replace(/^\uFEFF/, '')); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    if (proof?.schema !== schema || proof?.passed !== true || proof.surfaceHash !== receipt.surfaceHash) return false;
    if (!(Date.parse(proof.provedAt) >= Date.parse(receipt.admittedAt))) return false;
    let evidence;
    try { evidence = validate(proof.evidence, { expectedSurfaceHash: receipt.surfaceHash }); }
    catch { return false; }
    return evidence.callIds.length === 2 && ids.every(id => evidence.callIds.includes(id));
  });
  return writeOutcome(file, receipt, { status: passed ? 'passed' : 'failed', settledAt: now(), callIds: ids, providerEndReasons });
}

function readIntent(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`Cannot read internal test intent ${file}; preserve and reconcile the evidence: ${error.message}`); }
}

function writeOutcome(file, receipt, outcome) {
  const lock = path.join(path.dirname(file), 'admission.lock');
  const lockFd = fs.openSync(lock, 'wx', 0o600);
  try {
  const current = readIntent(file);
  if (['passed', 'failed', 'not-dialed'].includes(current.outcome?.status)) return current;
  const updated = { ...current, outcome };
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(updated, null, 2) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
  return updated;
  } finally { fs.closeSync(lockFd); fs.unlinkSync(lock); }
}

// Only the authenticated server calls this with its own configuration and
// provider-fetched resources. Client labels, phone claims and approval flags
// are not evidence that the receiving endpoint is Amy.
async function admitInternalVoiceSelfTest({
  dataDir, rootDir, invocationKey, phoneNumber, phoneNumberId, inboundPhoneNumberId,
  requestedSurfaceHash,
  configuredPhoneNumberIds, configuredInboundPhoneNumberId, expectedWebhookUrl, selfTestPhones, principalPhones, operatorState,
  fetchPhoneNumber, now = () => new Date().toISOString(),
}) {
  const policy = JSON.parse(fs.readFileSync(path.join(rootDir, 'config/voice-runtime-policy.json'), 'utf8'));
  if (policy.internalSelfTests?.enabled !== true || policy.internalSelfTests?.authority !== AUTHORITY) {
    throw new Error('Standing internal voice-test authority is disabled or missing.');
  }
  assertInternalTestingNotRevoked(operatorState);
  const surfaceHash = currentVoiceSurface({ rootDir }).hash;
  if (requestedSurfaceHash !== surfaceHash) throw new Error('Internal voice test host surfaces differ; no intent reserved.');
  if (!Array.isArray(principalPhones) || !principalPhones.map(phone).filter(Boolean).length) {
    throw new Error('Canonical principal phone registry is unavailable.');
  }
  const ids = new Set((configuredPhoneNumberIds || []).map(String).filter(Boolean));
  if (!UUID.test(String(invocationKey || '')) || !ids.has(phoneNumberId) || !ids.has(inboundPhoneNumberId) ||
      inboundPhoneNumberId !== configuredInboundPhoneNumberId) {
    throw new Error('Internal voice test requires a unique invocation and two configured Amy phone resources.');
  }
  const [caller, receiver] = await Promise.all([
    fetchPhoneNumber(phoneNumberId), fetchPhoneNumber(inboundPhoneNumberId),
  ]);
  const destination = phone(phoneNumber);
  const principals = new Set((principalPhones || []).map(phone));
  const synthetic = new Set((selfTestPhones || []).map(phone).filter(Boolean));
  if (caller?.id !== phoneNumberId || receiver?.id !== inboundPhoneNumberId ||
      !destination || phone(receiver?.number) !== destination ||
      !synthetic.has(phone(caller?.number)) || principals.has(destination) ||
      principals.has(phone(caller?.number)) || receiver.assistantId != null || receiver.squadId != null ||
      receiver.fallbackDestination != null || !expectedWebhookUrl ||
      (receiver.server?.url || receiver.serverUrl) !== expectedWebhookUrl) {
    throw new Error('Provider resources do not prove an Amy-to-Amy test; no person may be called.');
  }
  const receipt = {
    schema: 'amy.outbound-call-control.v1', mode: 'enabled',
    source: AUTHORITY, globalMode: operatorState.mode,
    reason: 'Standing owner permission for this verified Amy-to-Amy release test only.',
    invocationKey, phoneNumber: destination, callerPhoneNumber: phone(caller.number), phoneNumberId, inboundPhoneNumberId,
    admittedAt: now(), surfaceHash,
    operatorPause: { source: operatorState.source, updatedAt: operatorState.updatedAt },
  };
  reserveIntent(dataDir, receipt);
  return receipt;
}

module.exports = { AUTHORITY, admitInternalVoiceSelfTest, settleInternalVoiceSelfTest };
