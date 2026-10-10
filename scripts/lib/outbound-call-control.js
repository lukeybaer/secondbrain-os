'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { desktopHttpHeaders } = require('./desktop-capability-http-auth.js');
const { readVoiceReleaseAdmission, writeVoiceReleaseProof, currentVoiceSurface } = require('./voice-release-proof.js');

const SCHEMA = 'amy.outbound-call-control.v1';
const TEST_AUTH_SCHEMA = 'amy.outbound-call-test-authorization.v1';
const MACHINE_SELF_TEST_CORRECTION_SCHEMA = 'amy.machine-self-test-correction-lease.v1';
const MACHINE_SELF_TEST_CORRECTION_AUTHORIZATION_SCHEMA =
  'amy.machine-self-test-correction-authorization.v1';
const MACHINE_SELF_TEST_CORRECTION_SCOPE_ARTIFACT = 'dev-plans/amy-overhaul-scope-2026-09-07.html';
const MACHINE_SELF_TEST_CORRECTION_SCOPE_SHA256 =
  '2abac52ebe46e7adebb1ce352d7539d8042adaaa98a18fc7369f4ba14687f72f';
const MACHINE_SELF_TEST_CORRECTION_OWNER_TASK_QUOTE =
  "I had both you and claude do end-to-end amy audit reviews. Here's the final synthesis of both of those recommendations from claude: file:///C:/Users/ExampleCo/Documents/GitHub/SecondBrain/dev-plans/amy-overhaul-scope-2026-09-07.html now see #otter for the approval to do the work. And go ahead. Do the work (subject to the conditions in the otter voicenote). PRIVATE_NAME't stop for the 11pm overnight process. Get this done end-to-end as a priority.";
const MACHINE_SELF_TEST_CORRECTION_OWNER_TASK_QUOTE_SHA256 =
  'eed4cc1afc2591399529574e0a007a42f3fa455ee4fe92a792f74a53a4ba68d3';
// This is a correction for one recorded false human-classification, rather
// than a reusable approval for any pair of Amy-to-Amy calls. Keep all provider
// identifiers bound to the receipt which triggered the existing pause.
const MACHINE_SELF_TEST_CORRECTION_SOURCE_CALL_ID =
  '01a07f17-8cee-7001-9346-3529b29d26dc';
const MACHINE_SELF_TEST_CORRECTION_PAIRED_CALL_ID =
  '01a07f17-9309-7bbe-985b-92d863dc1e83';
const MACHINE_SELF_TEST_CORRECTION_CORRELATION_ID =
  'cea9d922-fd66-48fa-80e8-cb8cf2fae565';
const MACHINE_SELF_TEST_CORRECTION_PHONE_NUMBER_ID =
  'a9802a75-6e41-4217-b027-5247465d988d';
const MACHINE_SELF_TEST_CORRECTION_TARGET_PHONE = '+15550000000';
const DEFAULT_REMOTE_URL =
  'https://your-api-id.execute-api.us-east-1.amazonaws.com/prod/amy/desktop-capabilities/outbound-call-control';

function defaultDataDir() {
  if (process.env.SECONDBRAIN_DATA_DIR) return process.env.SECONDBRAIN_DATA_DIR;
  if (process.env.SB_DATA_DIR) return process.env.SB_DATA_DIR;
  if (process.platform !== 'win32' && fs.existsSync('/opt/secondbrain/data')) {
    return '/opt/secondbrain/data';
  }
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'secondbrain', 'data');
}

function isCanonicalMachineSelfTestCorrectionHost(opts = {}) {
  if (process.platform === 'win32' || opts.forceRemote === true) return false;
  const configuredCanonicalDataDir = process.env.SECONDBRAIN_DATA_DIR || '/opt/secondbrain/data';
  return path.resolve(opts.dataDir || defaultDataDir()) === path.resolve(configuredCanonicalDataDir);
}

function controlPath(opts = {}) {
  return (
    opts.controlPath ||
    path.join(opts.dataDir || defaultDataDir(), 'agent', 'outbound-call-control.json')
  );
}

function outboundTestAuthorizationPath(opts = {}) {
  return (
    opts.testAuthorizationPath ||
    path.join(opts.dataDir || defaultDataDir(), 'agent', 'outbound-call-test-authorization.json')
  );
}

function machineSelfTestCorrectionLeasePath(opts = {}) {
  return (
    opts.machineSelfTestCorrectionLeasePath ||
    path.join(opts.dataDir || defaultDataDir(), 'agent', 'machine-self-test-correction-lease.json')
  );
}

function machineSelfTestCorrectionReceiptPath(opts = {}) {
  return (
    opts.machineSelfTestCorrectionReceiptPath ||
    path.join(opts.dataDir || defaultDataDir(), 'agent', 'machine-self-test-correction-receipts.jsonl')
  );
}

function machineSelfTestCorrectionLockPath(opts = {}) {
  return `${machineSelfTestCorrectionLeasePath(opts)}.lock`;
}

function normalizePhone(value) {
  const raw = String(value || '').trim();
  const digits = raw.replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return raw.startsWith('+') ? `+${digits}` : digits;
}

function principalPhones(opts = {}) {
  if (Array.isArray(opts.principalPhones)) {
    return [...new Set(opts.principalPhones.map(normalizePhone).filter(Boolean))];
  }
  const file = path.join(opts.dataDir || defaultDataDir(), 'agent', 'contacts.json');
  try {
    const store = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return [...new Set((store.owner_phones || []).map(normalizePhone).filter(Boolean))];
  } catch {
    return [];
  }
}

function explicitOutboundTestRequested(text) {
  const value = String(text || '');
  if (
    /\b(?:do\s+not|don['\u2019]?t|never|stop|pause|not)\b.{0,60}\btest\b.{0,40}\b(?:on|with)\s+me\b/i.test(
      value,
    ) ||
    /\b(?:do\s+not|don['\u2019]?t|never|stop|pause)\b.{0,60}\bcall\s+me\b/i.test(value)
  ) {
    return false;
  }
  return (
    /\btest\b.{0,40}\b(?:on|with)\s+me\b/i.test(value) ||
    /\bcall\s+me\b.{0,80}\btest\b/i.test(value) ||
    /\btest\b.{0,80}\bcall\s+me\b/i.test(value)
  );
}

function machineSelfTestCorrectionAuthorizationMetadata() {
  return {
    schema: MACHINE_SELF_TEST_CORRECTION_AUTHORIZATION_SCHEMA,
    authority: 'owner-approved-amy-overhaul-machine-qa',
    scopeArtifact: MACHINE_SELF_TEST_CORRECTION_SCOPE_ARTIFACT,
    scopeSha256: MACHINE_SELF_TEST_CORRECTION_SCOPE_SHA256,
    ownerTaskQuote: MACHINE_SELF_TEST_CORRECTION_OWNER_TASK_QUOTE,
    ownerTaskQuoteSha256: MACHINE_SELF_TEST_CORRECTION_OWNER_TASK_QUOTE_SHA256,
  };
}

function isMachineSelfTestCorrectionAuthorized(metadata) {
  const required = machineSelfTestCorrectionAuthorizationMetadata();
  if (
    !metadata ||
    metadata.schema !== required.schema ||
    metadata.authority !== required.authority ||
    metadata.scopeArtifact !== required.scopeArtifact ||
    String(metadata.scopeSha256 || '').toLowerCase() !== required.scopeSha256 ||
    metadata.ownerTaskQuote !== required.ownerTaskQuote ||
    String(metadata.ownerTaskQuoteSha256 || '').toLowerCase() !== required.ownerTaskQuoteSha256
  ) {
    return false;
  }
  return (
    crypto.createHash('sha256').update(required.ownerTaskQuote).digest('hex') ===
    required.ownerTaskQuoteSha256
  );
}

function conditionalResumeAfterTestRequested(text) {
  const value = String(text || '');
  return (
    /\b(?:outbound\s+)?(?:dialing|calls?|calling)\b/i.test(value) &&
    /\bif\s+i\s+say\s+(?:it(?:['\u2019]?s|\s+is)\s+)?ok(?:ay)?\b[\s\S]{0,100}\b(?:permit|allow|enable|resume)\b[\s\S]{0,40}\bagain\b/i.test(
      value,
    )
  );
}

function explicitOutboundTestApproval(text) {
  return /^(?:(?:it(?:['\u2019]?s|\s+is)\s+)?ok(?:ay)?|i\s+(?:explicitly\s+)?approve)[.!]?$/i.test(
    String(text || '').trim(),
  );
}

function readOutboundTestAuthorization(opts = {}) {
  const file = outboundTestAuthorizationPath(opts);
  let row;
  try {
    row = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    return {
      schema: TEST_AUTH_SCHEMA,
      active: false,
      reason:
        error?.code === 'ENOENT'
          ? 'No scoped outbound test is authorized.'
          : `Scoped outbound test authorization could not be read: ${error.message}`,
      path: file,
    };
  }
  const now = typeof opts.nowMs === 'function' ? Number(opts.nowMs()) : Date.now();
  const expiresAt = Date.parse(row.expiresAt || '');
  const recordValid =
    row?.schema === TEST_AUTH_SCHEMA &&
    typeof row.active === 'boolean' &&
    Boolean(row.targetPhone) &&
    Boolean(row.invocationKey) &&
    Number.isFinite(expiresAt);
  if (
    !recordValid ||
    row.active !== true ||
    row.consumedAt ||
    now >= expiresAt
  ) {
    return {
      ...row,
      schema: TEST_AUTH_SCHEMA,
      recordValid,
      active: false,
      reason: row?.consumedAt
        ? 'The scoped outbound test authorization was already consumed.'
        : 'The scoped outbound test authorization is invalid or expired.',
      path: file,
    };
  }
  return { ...row, recordValid: true, path: file };
}

function appendJsonlAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'a', 0o600);
  try {
    fs.writeSync(fd, `${JSON.stringify(value)}\n`, null, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function callCorrelationIds(call) {
  const values = [
    call?.metadata?.amyCallCorrelationId,
    call?.assistantOverrides?.metadata?.amyCallCorrelationId,
    call?.assistant?.metadata?.amyCallCorrelationId,
    call?.artifact?.metadata?.amyCallCorrelationId,
  ];
  return new Set(values.map((value) => String(value || '').trim()).filter(Boolean));
}

function isHistoricalMachineSelfTestProviderFailure(call) {
  return /\bproviderfault[-_ ]custom[-_ ]llm(?:[-_ ]failed)?\b/i.test(
    String(call?.endedReason || ''),
  );
}

function validMachineSelfTestId(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || ''),
  );
}

function isHistoricalMachineSelfTestCorrectionPair({
  sourceCallId,
  pairedCallId,
  correlationId,
  phoneNumberId,
  targetPhone,
} = {}) {
  return (
    String(sourceCallId || '') === MACHINE_SELF_TEST_CORRECTION_SOURCE_CALL_ID &&
    String(pairedCallId || '') === MACHINE_SELF_TEST_CORRECTION_PAIRED_CALL_ID &&
    String(correlationId || '') === MACHINE_SELF_TEST_CORRECTION_CORRELATION_ID &&
    String(phoneNumberId || '') === MACHINE_SELF_TEST_CORRECTION_PHONE_NUMBER_ID &&
    normalizePhone(targetPhone) === MACHINE_SELF_TEST_CORRECTION_TARGET_PHONE
  );
}

function validateMachineSelfTestCorrectionEvidence({
  sourceCallId,
  pairedCallId,
  correlationId,
  sourceCall,
  pairedCall,
  ownedPhoneNumber,
  selfTestPhones,
  ownedPhoneNumberIds,
} = {}) {
  const sourceId = String(sourceCallId || '').trim();
  const pairedId = String(pairedCallId || '').trim();
  const root = String(correlationId || '').trim();
  const fail = (message, code) => {
    const error = new Error(`[outbound-call-control] Machine self-test correction rejected: ${message}`);
    error.code = code;
    throw error;
  };
  if (!validMachineSelfTestId(sourceId) || !validMachineSelfTestId(pairedId) || sourceId === pairedId) {
    fail('both distinct Vapi call IDs must be canonical UUIDs.', 'MACHINE_SELF_TEST_CORRECTION_INVALID_CALL_IDS');
  }
  if (!validMachineSelfTestId(root)) {
    fail('the Vapi causal correlation must be a canonical UUID.', 'MACHINE_SELF_TEST_CORRECTION_INVALID_CORRELATION');
  }
  if (
    sourceId !== MACHINE_SELF_TEST_CORRECTION_SOURCE_CALL_ID ||
    pairedId !== MACHINE_SELF_TEST_CORRECTION_PAIRED_CALL_ID ||
    root !== MACHINE_SELF_TEST_CORRECTION_CORRELATION_ID
  ) {
    fail(
      'only the recorded stale synthetic outbound/inbound pair may receive this correction.',
      'MACHINE_SELF_TEST_CORRECTION_UNEXPECTED_PAIR',
    );
  }
  if (!sourceCall || !pairedCall || String(sourceCall.id || '') !== sourceId || String(pairedCall.id || '') !== pairedId) {
    fail('the server-fetched Vapi call records do not match the requested IDs.', 'MACHINE_SELF_TEST_CORRECTION_CALL_LOOKUP_MISMATCH');
  }
  if (
    String(sourceCall.type || '') !== 'outboundPhoneCall' ||
    String(pairedCall.type || '') !== 'inboundPhoneCall'
  ) {
    fail('the receipt must contain one outbound and one inbound Vapi leg.', 'MACHINE_SELF_TEST_CORRECTION_NOT_PAIRED');
  }
  const terminalStatuses = new Set(['ended', 'failed']);
  if (
    !terminalStatuses.has(String(sourceCall.status || '').toLowerCase()) ||
    !terminalStatuses.has(String(pairedCall.status || '').toLowerCase())
  ) {
    fail('both synthetic Vapi legs must be terminal before a correction can be considered.', 'MACHINE_SELF_TEST_CORRECTION_NONTERMINAL');
  }
  const sourcePhoneNumberId = String(sourceCall.phoneNumberId || '').trim();
  const pairedPhoneNumberId = String(pairedCall.phoneNumberId || '').trim();
  const configuredPhoneNumberIds = new Set(
    (ownedPhoneNumberIds || []).map((value) => String(value || '').trim()).filter(Boolean),
  );
  if (
    !sourcePhoneNumberId ||
    sourcePhoneNumberId !== pairedPhoneNumberId ||
    !configuredPhoneNumberIds.has(sourcePhoneNumberId)
  ) {
    fail('both legs must use the same configured owned Vapi phone number.', 'MACHINE_SELF_TEST_CORRECTION_UNOWNED_PHONE');
  }
  const sourceNumber = normalizePhone(sourceCall.customer?.number);
  const pairedNumber = normalizePhone(pairedCall.customer?.number);
  const fetchedPhoneNumberId = String(ownedPhoneNumber?.id || '').trim();
  const fetchedPhoneNumber = normalizePhone(ownedPhoneNumber?.number);
  const configuredSelfTestPhones = new Set((selfTestPhones || []).map(normalizePhone).filter(Boolean));
  if (
    fetchedPhoneNumberId !== sourcePhoneNumberId ||
    !fetchedPhoneNumber ||
    !sourceNumber ||
    sourceNumber !== pairedNumber ||
    sourceNumber !== fetchedPhoneNumber ||
    !configuredSelfTestPhones.has(sourceNumber) ||
    !isHistoricalMachineSelfTestCorrectionPair({
      sourceCallId: sourceId,
      pairedCallId: pairedId,
      correlationId: root,
      phoneNumberId: sourcePhoneNumberId,
      targetPhone: sourceNumber,
    })
  ) {
    fail(
      'both legs must target the configured owned Vapi number returned by /phone-number/{id}.',
      'MACHINE_SELF_TEST_CORRECTION_NOT_SELF_TEST',
    );
  }
  const sourceCorrelations = callCorrelationIds(sourceCall);
  const pairedCorrelations = callCorrelationIds(pairedCall);
  if (
    sourceCorrelations.size !== 1 ||
    !sourceCorrelations.has(root) ||
    [...pairedCorrelations].some((value) => value !== root)
  ) {
    fail(
      'the outbound leg must carry the exact causal correlation and neither leg may carry a conflicting correlation.',
      'MACHINE_SELF_TEST_CORRECTION_CORRELATION_MISMATCH',
    );
  }
  const sourceStartedAt = Date.parse(String(sourceCall.startedAt || ''));
  const sourceEndedAt = Date.parse(String(sourceCall.endedAt || ''));
  const pairedStartedAt = Date.parse(String(pairedCall.startedAt || ''));
  const pairedEndedAt = Date.parse(String(pairedCall.endedAt || ''));
  if (
    ![sourceStartedAt, sourceEndedAt, pairedStartedAt, pairedEndedAt].every(Number.isFinite) ||
    sourceEndedAt < sourceStartedAt ||
    pairedEndedAt < pairedStartedAt ||
    Math.min(sourceEndedAt, pairedEndedAt) < Math.max(sourceStartedAt, pairedStartedAt) ||
    Math.abs(sourceStartedAt - pairedStartedAt) >= 2_000
  ) {
    fail(
      'the Vapi legs must overlap and start less than two seconds apart.',
      'MACHINE_SELF_TEST_CORRECTION_TIME_MISMATCH',
    );
  }
  return {
    verified: true,
    provider: 'vapi-api',
    sourceCallId: sourceId,
    pairedCallId: pairedId,
    correlationId: root,
    phoneNumberId: sourcePhoneNumberId,
    targetPhone: sourceNumber,
    providerFailureObserved:
      isHistoricalMachineSelfTestProviderFailure(sourceCall) &&
      isHistoricalMachineSelfTestProviderFailure(pairedCall),
  };
}

function readMachineSelfTestCorrectionReceipts(opts = {}) {
  const file = machineSelfTestCorrectionReceiptPath(opts);
  let lines;
  try {
    lines = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  } catch (error) {
    if (error?.code === 'ENOENT') return { readable: true, rows: [], path: file };
    return { readable: false, rows: [], path: file, error };
  }
  const rows = [];
  try {
    for (const line of lines) rows.push(JSON.parse(line));
  } catch (error) {
    return { readable: false, rows: [], path: file, error };
  }
  return { readable: true, rows, path: file };
}

function assertMachineSelfTestCorrectionNotPreviouslyAuthorized(verified, opts = {}) {
  const receipts = readMachineSelfTestCorrectionReceipts(opts);
  if (!receipts.readable) {
    const error = new Error(
      '[outbound-call-control] Machine self-test correction receipts are unreadable; refusing to re-authorize the one-shot correction.',
    );
    error.code = 'MACHINE_SELF_TEST_CORRECTION_RECEIPTS_UNREADABLE';
    throw error;
  }
  if (
    receipts.rows.some(
      (row) =>
        row?.schema === MACHINE_SELF_TEST_CORRECTION_SCHEMA &&
        row?.event === 'authorized' &&
        String(row?.sourceCallId || '') === String(verified.sourceCallId || '') &&
        String(row?.pairedCallId || '') === String(verified.pairedCallId || '') &&
        String(row?.correlationId || '') === String(verified.correlationId || ''),
    )
  ) {
    const error = new Error(
      '[outbound-call-control] Machine self-test correction was already authorized for this historical pair.',
    );
    error.code = 'MACHINE_SELF_TEST_CORRECTION_ALREADY_AUTHORIZED';
    throw error;
  }
}

function withMachineSelfTestCorrectionLock(opts, operation) {
  const file = machineSelfTestCorrectionLockPath(opts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let fd;
  try {
    fd = fs.openSync(file, 'wx', 0o600);
    fs.writeFileSync(fd, `${process.pid}\n`);
    fs.fsyncSync(fd);
  } catch (cause) {
    if (fd !== undefined) fs.closeSync(fd);
    const error = new Error(
      '[outbound-call-control] Machine self-test correction is already being authorized or consumed; refusing concurrent use.',
    );
    error.code = 'MACHINE_SELF_TEST_CORRECTION_LOCKED';
    error.cause = cause;
    throw error;
  }
  try {
    return operation();
  } finally {
    fs.closeSync(fd);
    try {
      fs.unlinkSync(file);
    } catch {
      // A stale lock must fail closed rather than being overwritten.
    }
  }
}

function readMachineSelfTestCorrectionLease(opts = {}) {
  const file = machineSelfTestCorrectionLeasePath(opts);
  let row;
  try {
    row = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    return {
      schema: MACHINE_SELF_TEST_CORRECTION_SCHEMA,
      active: false,
      reason:
        error?.code === 'ENOENT'
          ? 'No machine self-test correction lease is authorized.'
          : `Machine self-test correction lease could not be read: ${error.message}`,
      path: file,
    };
  }
  const now = typeof opts.nowMs === 'function' ? Number(opts.nowMs()) : Date.now();
  const expiresAt = Date.parse(row.expiresAt || '');
  const recordValid =
    row?.schema === MACHINE_SELF_TEST_CORRECTION_SCHEMA &&
    row?.verifiedBy === 'vapi-api' &&
    row?.providerFailureObserved === true &&
    validMachineSelfTestId(row?.sourceCallId) &&
    validMachineSelfTestId(row?.pairedCallId) &&
    validMachineSelfTestId(row?.correlationId) &&
    Boolean(row?.phoneNumberId) &&
    Boolean(normalizePhone(row?.targetPhone)) &&
    Boolean(row?.invocationKey) &&
    Boolean(row?.operatorControlUpdatedAt) &&
    isMachineSelfTestCorrectionAuthorized(row?.machineInternalAuthorization, opts) &&
    isHistoricalMachineSelfTestCorrectionPair(row) &&
    Number.isFinite(expiresAt);
  if (!recordValid || row.active !== true || row.consumedAt || now >= expiresAt) {
    return {
      ...row,
      schema: MACHINE_SELF_TEST_CORRECTION_SCHEMA,
      recordValid,
      active: false,
      reason: row?.consumedAt
        ? 'The machine self-test correction lease was already consumed.'
        : 'The machine self-test correction lease is invalid or expired.',
      path: file,
    };
  }
  return { ...row, recordValid: true, path: file };
}

function machineSelfTestCorrectionMatchesPause(lease, opts = {}) {
  const control = readOutboundCallControl(opts);
  return (
    lease?.active === true &&
    control.mode === 'paused' &&
    control.source === 'failed-human-interaction' &&
    control.updatedAt === lease.operatorControlUpdatedAt &&
    control.reason === lease.operatorPauseReason &&
    String(control.reason || '').includes(String(lease.sourceCallId || ''))
  );
}

function authorizeMachineSelfTestCorrection({
  invocationKey,
  ownerAuthorized,
  machineInternalAuthorization,
  providerVerification,
  ttlMs,
  nowIso,
  ...opts
} = {}) {
  return withMachineSelfTestCorrectionLock(opts, () => {
  if (
    ownerAuthorized !== true ||
    !isMachineSelfTestCorrectionAuthorized(machineInternalAuthorization, opts)
  ) {
    const error = new Error(
      '[outbound-call-control] Machine-only correction requires the exact owner-approved overhaul authorization artifact.',
    );
    error.code = 'MACHINE_SELF_TEST_CORRECTION_NOT_AUTHORIZED';
    throw error;
  }
  const key = String(invocationKey || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(key)) {
    const error = new Error('[outbound-call-control] Machine self-test correction requires a safe invocation key.');
    error.code = 'MACHINE_SELF_TEST_CORRECTION_INVALID_INVOCATION_KEY';
    throw error;
  }
  const verified = providerVerification || {};
  if (
    verified.verified !== true ||
    verified.provider !== 'vapi-api' ||
    !validMachineSelfTestId(verified.sourceCallId) ||
    !validMachineSelfTestId(verified.pairedCallId) ||
    !validMachineSelfTestId(verified.correlationId) ||
    !String(verified.phoneNumberId || '').trim() ||
    !normalizePhone(verified.targetPhone) ||
    verified.providerFailureObserved !== true ||
    !isHistoricalMachineSelfTestCorrectionPair(verified)
  ) {
    const error = new Error('[outbound-call-control] Machine self-test correction requires a server-verified Vapi pair.');
    error.code = 'MACHINE_SELF_TEST_CORRECTION_UNVERIFIED';
    throw error;
  }
  const operatorState = readOutboundCallControl(opts);
  if (
    operatorState.mode !== 'paused' ||
    operatorState.source !== 'failed-human-interaction' ||
    !operatorState.updatedAt ||
    !String(operatorState.reason || '').includes(verified.sourceCallId)
  ) {
    const error = new Error(
      '[outbound-call-control] Machine self-test correction is bound only to its current failed-human-interaction pause.',
    );
    error.code = 'MACHINE_SELF_TEST_CORRECTION_PAUSE_MISMATCH';
    throw error;
  }
  assertMachineSelfTestCorrectionNotPreviouslyAuthorized(verified, opts);
  const issuedAt = typeof nowIso === 'function' ? nowIso() : new Date().toISOString();
  const lifetime = Math.max(60_000, Math.min(30 * 60 * 1000, Number(ttlMs || 10 * 60 * 1000)));
  const lease = {
    schema: MACHINE_SELF_TEST_CORRECTION_SCHEMA,
    active: true,
    purpose: 'machine-self-test-correction',
    invocationKey: key,
    sourceCallId: verified.sourceCallId,
    pairedCallId: verified.pairedCallId,
    correlationId: verified.correlationId,
    phoneNumberId: verified.phoneNumberId,
    targetPhone: normalizePhone(verified.targetPhone),
    providerFailureObserved: verified.providerFailureObserved === true,
    verified: true,
    verifiedBy: verified.provider,
    operatorControlUpdatedAt: operatorState.updatedAt,
    operatorPauseReason: operatorState.reason,
    machineInternalAuthorization: machineSelfTestCorrectionAuthorizationMetadata(),
    issuedAt,
    expiresAt: new Date(Date.parse(issuedAt) + lifetime).toISOString(),
    consumedAt: null,
  };
  writeJsonAtomic(machineSelfTestCorrectionLeasePath(opts), lease);
  appendJsonlAtomic(machineSelfTestCorrectionReceiptPath(opts), {
    schema: MACHINE_SELF_TEST_CORRECTION_SCHEMA,
    event: 'authorized',
    issuedAt,
    invocationKey: key,
    sourceCallId: lease.sourceCallId,
    pairedCallId: lease.pairedCallId,
    correlationId: lease.correlationId,
    phoneNumberId: lease.phoneNumberId,
    targetPhone: lease.targetPhone,
    providerFailureObserved: lease.providerFailureObserved,
    machineInternalAuthorization: lease.machineInternalAuthorization,
    operatorControlUpdatedAt: lease.operatorControlUpdatedAt,
    operatorPauseReason: lease.operatorPauseReason,
  });
  return lease;
  });
}

function matchingMachineSelfTestCorrectionLease(opts = {}) {
  if (opts.purpose !== 'machine-self-test-correction') return null;
  const lease = readMachineSelfTestCorrectionLease(opts);
  if (
    lease.active !== true ||
    String(opts.invocationKey || '') !== String(lease.invocationKey || '') ||
    normalizePhone(opts.phoneNumber) !== normalizePhone(lease.targetPhone) ||
    String(opts.phoneNumberId || '').trim() !== String(lease.phoneNumberId || '').trim() ||
    !machineSelfTestCorrectionMatchesPause(lease, opts)
  ) {
    return null;
  }
  return lease;
}

function consumeMachineSelfTestCorrectionLease({ invocationKey, phoneNumber, phoneNumberId, nowIso, ...opts } = {}) {
  return withMachineSelfTestCorrectionLock(opts, () => {
  const lease = matchingMachineSelfTestCorrectionLease({
    ...opts,
    purpose: 'machine-self-test-correction',
    invocationKey,
    phoneNumber,
    phoneNumberId,
  });
  if (!lease) {
    const error = new Error('[outbound-call-control] Machine self-test correction lease does not match this call.');
    error.code = 'MACHINE_SELF_TEST_CORRECTION_LEASE_MISMATCH';
    throw error;
  }
  const consumedAt = typeof nowIso === 'function' ? nowIso() : new Date().toISOString();
  const consumed = writeJsonAtomic(machineSelfTestCorrectionLeasePath(opts), {
    ...lease,
    path: undefined,
    active: false,
    consumedAt,
  });
  appendJsonlAtomic(machineSelfTestCorrectionReceiptPath(opts), {
    schema: MACHINE_SELF_TEST_CORRECTION_SCHEMA,
    event: 'consumed-before-dial',
    consumedAt,
    invocationKey: consumed.invocationKey,
    sourceCallId: consumed.sourceCallId,
    pairedCallId: consumed.pairedCallId,
    phoneNumberId: consumed.phoneNumberId,
    targetPhone: consumed.targetPhone,
    correlationId: consumed.correlationId,
    operatorControlUpdatedAt: consumed.operatorControlUpdatedAt,
  });
  return consumed;
  });
}

function validateOutboundTestRequest({
  phoneNumber,
  invocationKey,
  ownerAuthorized,
  ownerRequestText,
  ...opts
} = {}) {
  if (ownerAuthorized !== true || !explicitOutboundTestRequested(ownerRequestText)) {
    const error = new Error(
      '[outbound-call-control] Scoped test requires a new explicit owner instruction to test on the owner.',
    );
    error.code = 'OUTBOUND_CALL_TEST_NOT_AUTHORIZED';
    throw error;
  }
  const targetPhone = normalizePhone(phoneNumber);
  if (!targetPhone || !principalPhones(opts).includes(targetPhone)) {
    const error = new Error(
      '[outbound-call-control] Scoped test target must exactly match a verified principal phone.',
    );
    error.code = 'OUTBOUND_CALL_TEST_TARGET_NOT_PRINCIPAL';
    throw error;
  }
  const key = String(invocationKey || '').trim();
  if (!key) throw new Error('[outbound-call-control] Scoped test requires an invocation key.');
  return { targetPhone, invocationKey: key };
}

function authorizeOutboundTest({
  phoneNumber,
  invocationKey,
  ownerAuthorized,
  ownerRequestText,
  ttlMs,
  nowIso,
  ...opts
} = {}) {
  const validated = validateOutboundTestRequest({
    phoneNumber,
    invocationKey,
    ownerAuthorized,
    ownerRequestText,
    ...opts,
  });
  const issuedAt = typeof nowIso === 'function' ? nowIso() : new Date().toISOString();
  const lifetime = Math.max(60_000, Math.min(2 * 60 * 60 * 1000, Number(ttlMs || 30 * 60 * 1000)));
  return writeJsonAtomic(outboundTestAuthorizationPath(opts), {
    schema: TEST_AUTH_SCHEMA,
    active: true,
    targetPhone: validated.targetPhone,
    invocationKey: validated.invocationKey,
    allowSelfTest: true,
    resumeAfterApproval: conditionalResumeAfterTestRequested(ownerRequestText),
    operatorControlUpdatedAt: readOutboundCallControl(opts).updatedAt || null,
    authorizationText: String(ownerRequestText).slice(0, 500),
    issuedAt,
    expiresAt: new Date(Date.parse(issuedAt) + lifetime).toISOString(),
    consumedAt: null,
  });
}

function matchingOutboundTestAuthorization(opts = {}) {
  const authorization = readOutboundTestAuthorization(opts);
  if (authorization.active !== true) return null;
  const operatorState = readOutboundCallControl(opts);
  if (
    !authorization.operatorControlUpdatedAt ||
    operatorState.mode !== 'paused' ||
    operatorState.updatedAt !== authorization.operatorControlUpdatedAt
  ) {
    return null;
  }
  if (opts.purpose === 'voice-self-test' && authorization.allowSelfTest === true) {
    return authorization;
  }
  if (
    opts.purpose === 'principal-test' &&
    normalizePhone(opts.phoneNumber) === authorization.targetPhone &&
    String(opts.invocationKey || '') === authorization.invocationKey
  ) {
    return authorization;
  }
  return null;
}

function consumeOutboundTestAuthorization({ phoneNumber, invocationKey, nowIso, ...opts } = {}) {
  const authorization = readOutboundTestAuthorization(opts);
  if (
    authorization.active !== true ||
    normalizePhone(phoneNumber) !== authorization.targetPhone ||
    String(invocationKey || '') !== authorization.invocationKey
  ) {
    const error = new Error('[outbound-call-control] Scoped test authorization does not match this call.');
    error.code = 'OUTBOUND_CALL_TEST_AUTHORIZATION_MISMATCH';
    throw error;
  }
  return writeJsonAtomic(outboundTestAuthorizationPath(opts), {
    ...authorization,
    path: undefined,
    active: false,
    consumedAt: typeof nowIso === 'function' ? nowIso() : new Date().toISOString(),
  });
}

function validateOutboundTestApprovalRequest({
  ownerAuthorized,
  ownerApprovalText,
  ...opts
} = {}) {
  const authorization = readOutboundTestAuthorization(opts);
  const operatorState = readOutboundCallControl(opts);
  const now = typeof opts.nowMs === 'function' ? Number(opts.nowMs()) : Date.now();
  const expiresAt = Date.parse(authorization.expiresAt || '');
  const valid =
    ownerAuthorized === true &&
    explicitOutboundTestApproval(ownerApprovalText) &&
    authorization.recordValid === true &&
    authorization.resumeAfterApproval === true &&
    authorization.active === false &&
    Boolean(authorization.consumedAt) &&
    !authorization.resumeApprovedAt &&
    Number.isFinite(expiresAt) &&
    now < expiresAt &&
    operatorState.mode === 'paused' &&
    Boolean(authorization.operatorControlUpdatedAt) &&
    operatorState.updatedAt === authorization.operatorControlUpdatedAt &&
    principalPhones(opts).includes(normalizePhone(authorization.targetPhone));
  if (!valid) {
    const error = new Error(
      '[outbound-call-control] Test approval does not match a fresh consumed principal-test lease bound to the current pause.',
    );
    error.code = 'OUTBOUND_CALL_TEST_APPROVAL_NOT_AUTHORIZED';
    throw error;
  }
  return { authorization, operatorState };
}

function resumeOutboundCallsAfterTestApproval({
  ownerAuthorized,
  ownerApprovalText,
  reason,
  nowIso,
  ...opts
} = {}) {
  const { authorization } = validateOutboundTestApprovalRequest({
    ownerAuthorized,
    ownerApprovalText,
    ...opts,
  });
  const ts = typeof nowIso === 'function' ? nowIso() : new Date().toISOString();
  const resumed = writeJsonAtomic(controlPath(opts), {
    schema: SCHEMA,
    mode: 'enabled',
    reason: String(reason || 'Owner approved the completed principal dialing test.').slice(0, 1000),
    source: 'owner-resume-after-principal-test',
    authorizationText: String(ownerApprovalText).slice(0, 100),
    testInvocationKey: authorization.invocationKey,
    updatedAt: ts,
  });
  writeJsonAtomic(outboundTestAuthorizationPath(opts), {
    ...authorization,
    path: undefined,
    reason: undefined,
    resumeApprovedAt: ts,
  });
  return resumed;
}

function readDesktopRelayEnv(opts = {}) {
  if (opts.desktopRelayEnv && typeof opts.desktopRelayEnv === 'object') return opts.desktopRelayEnv;
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  try {
    const values = {};
    for (const line of fs
      .readFileSync(path.join(appData, 'secondbrain', 'desktop-capability-worker.env'), 'utf8')
      .split(/\r?\n/)) {
      const match = line.match(/^\s*([^#=]+)\s*=\s*(.*?)\s*$/);
      if (match) values[match[1]] = match[2];
    }
    return values;
  } catch {
    return {};
  }
}

function remoteControlConfig(opts = {}) {
  const relayEnv = readDesktopRelayEnv(opts);
  const route = '/amy/desktop-capabilities/outbound-call-control';
  const configuredUrl =
    opts.remoteUrl ||
    process.env.OUTBOUND_CALL_CONTROL_URL ||
    process.env.AMY_DESKTOP_RELAY_URL ||
    relayEnv.AMY_DESKTOP_RELAY_URL ||
    DEFAULT_REMOTE_URL;
  return {
    url: configuredUrl.endsWith(route)
      ? configuredUrl
      : `${configuredUrl.replace(/\/$/, '')}${route}`,
    secret:
      opts.relaySecret ||
      process.env.AMY_DESKTOP_RELAY_SECRET ||
      relayEnv.AMY_DESKTOP_RELAY_SECRET ||
      '',
  };
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
  return value;
}

function readOutboundCallControl(opts = {}) {
  const file = controlPath(opts);
  try {
    const row = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (row?.schema === SCHEMA && ['enabled', 'paused'].includes(row.mode)) return row;
    return {
      schema: SCHEMA,
      mode: 'paused',
      reason: 'Outbound-call control state is invalid. Calls fail closed.',
      source: 'invalid-control-state',
      updatedAt: null,
      path: file,
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        schema: SCHEMA,
        mode: 'enabled',
        reason: 'No stop instruction is recorded.',
        source: 'default',
        updatedAt: null,
        path: file,
      };
    }
    return {
      schema: SCHEMA,
      mode: 'paused',
      reason: `Outbound-call control could not be read: ${error.message}. Calls fail closed.`,
      source: 'control-read-failure',
      updatedAt: null,
      path: file,
    };
  }
}

function pauseOutboundCalls({ reason, source = 'safety-circuit-breaker', scope, nowIso, ...opts } = {}) {
  const pauseScope = scope || (['failed-human-interaction', 'safety-circuit-breaker'].includes(source) ? 'human-only' : 'all');
  if (!['all', 'human-only'].includes(pauseScope)) throw new Error('Pause scope must be all or human-only.');
  const ts = typeof nowIso === 'function' ? nowIso() : new Date().toISOString();
  return writeJsonAtomic(controlPath(opts), {
    schema: SCHEMA,
    mode: 'paused',
    scope: pauseScope,
    reason: String(reason || 'Outbound calls paused for safety.').slice(0, 1000),
    source: String(source || 'safety-circuit-breaker').slice(0, 120),
    updatedAt: ts,
    resume_requires:
      'A new explicit owner instruction to resume outbound calls after the cause is reviewed.',
  });
}

// This is not a general resume path. It can clear only the temporary interlock
// written for this exact completed call while Jev classifies it. Any other stop
// source, a different call id, or a later safety pause remains untouched.
function clearPendingCallClassification({ callId, resolution = 'clean', nowIso, ...opts } = {}) {
  const state = readOutboundCallControl(opts);
  const marker = `call:${String(callId || '')}`;
  if (state.mode !== 'paused' || state.source !== 'awaiting-jev-call-classification' || !String(state.reason || '').includes(marker)) {
    return { cleared: false, state };
  }
  const ts = typeof nowIso === 'function' ? nowIso() : new Date().toISOString();
  const clean = resolution === 'clean';
  const unresolved = resolution === 'terminal_unresolved';
  const next = writeJsonAtomic(controlPath(opts), {
    schema: SCHEMA,
    mode: 'enabled',
    reason: clean
      ? `Jev classified ${marker} as clean at the required confidence.`
      : unresolved
        ? `Jev could not resolve ${marker} after the bounded retry limit; the temporary interlock was released and the call remains marked needs review.`
        : `Jev classified ${marker} as a failed principal interaction; no external-human safety pause applies.`,
    source: clean
      ? 'jev-call-classification-clean'
      : unresolved
        ? 'jev-call-classification-terminal-unresolved'
        : 'jev-principal-call-classification-recorded',
    updatedAt: ts,
  });
  return { cleared: true, state: next };
}

function explicitResumeRequested(text) {
  let value = String(text || '');
  if (
    /\b(?:do\s+not|don['\u2019]?t|never|stop|pause|hold(?:\s+on)?|wait|will\s+not|won['\u2019]?t|cannot|can['\u2019]?t|should\s+not|shouldn['\u2019]?t)\b.{0,80}\b(?:call|calls|calling|dialing)\b/i.test(
      value,
    ) ||
    /\bnot\s+(?:to\s+)?(?:call|calling)\b/i.test(value) ||
    /\byou(?:['\u2019]?re|\s+are)\s+not\s+calling\b/i.test(value) ||
    /\b(?:do\s+not|don['\u2019]?t|never|stop|pause|hold(?:\s+on)?|wait)\b.{0,80}\bkeep\s+(?:pushing|hammering)\b/i.test(
      value,
    ) ||
    /\b(?:do\s+not|don['\u2019]?t|never)\b.{0,80}\buse\b.{0,80}\bas\s+(?:a\s+)?test\b/i.test(value)
  ) {
    return false;
  }
  // A machine-test grant cannot satisfy the ordinary-call resume gate.
  // Scope can be supplied in a later sentence. Only a subsequent independent,
  // explicitly ordinary-call instruction may broaden that machine-only scope.
  const clauses = value.split(/[.!?\n]+/);
  let lastInternalClause = -1;
  clauses.forEach((clause, index) => {
    if (/\b(?:internal(?:ly)?|machine[- ](?:only|internal)|amy[- ]to[- ]amy|self[- ]tests?|yourself|your\s+own\s+number)\b/i.test(clause)) lastInternalClause = index;
  });
  if (lastInternalClause >= 0) {
    value = clauses.slice(lastInternalClause + 1).filter(clause =>
      /\b(?:outbound|ordinary|general|human)\b/i.test(clause)).join('. ');
  }
  const sequenceResume =
    /\b(?:resume|restart|start|continue|do|make|place|finish|complete)\b.{0,40}\b(?:calls?|calling)\b|\b(?:calls?|calling)\b.{0,40}\b(?:resume|restart|start|continue|do|make|place|finish|complete)\b/i;
  const directCallInstruction =
    /(?:^|[.!?]\s*|\b(?:please|then|now|and|to|you\s+can|can\s+you|would\s+you|will\s+you|go\s+ahead(?:\s+and)?)\s+)call\s+(?:me|him|her|them|[\p{L}'\u2019-]+)\b/iu;
  const activeCallConfirmation =
    /\byou(?:['\u2019]?re|\s+are)\s+calling\s+(?:me|him|her|them|[\p{L}'\u2019-]+)\b.{0,24}\b(?:right|correct|yes)\b/iu;
  const namedTestAuthorization =
    /\byou\s+can\s+use\s+(?:the\s+)?[\p{L}'\u2019-]+\s+as\s+(?:a\s+)?test\b/iu;
  const scopedPersistenceAuthorization =
    /\bkeep\s+pushing\b[\s\S]{0,240}\b(?:reservation|menu)\b|\b(?:reservation|menu)\b[\s\S]{0,240}\bkeep\s+pushing\b/i;
  const boundedPersistenceAuthorization =
    /\bkeep\s+hammering\b.{0,80}\buntil\s+(?:success|\d{1,2}(?::\d{2})?\s*(?:am|pm)?(?:\s+[A-Z]{2})?)\b/i;
  const explicitDialingEnablement =
    /\b(?:turn\s+(?:back\s+)?on|re-?enable|enable)\b.{0,40}\b(?:outbound\s+)?(?:dialing|calls?|calling)\b|\b(?:outbound\s+)?(?:dialing|calls?|calling)\b.{0,40}\b(?:turn\s+(?:back\s+)?on|re-?enable|enable)\b/i;
  return (
    sequenceResume.test(value) ||
    directCallInstruction.test(value) ||
    activeCallConfirmation.test(value) ||
    namedTestAuthorization.test(value) ||
    scopedPersistenceAuthorization.test(value) ||
    boundedPersistenceAuthorization.test(value) ||
    explicitDialingEnablement.test(value)
  );
}

function resumeOutboundCalls({ reason, ownerAuthorized, ownerRequestText, nowIso, ...opts } = {}) {
  if (ownerAuthorized !== true || !explicitResumeRequested(ownerRequestText)) {
    const error = new Error(
      '[outbound-call-control] Resume requires a new explicit owner instruction.',
    );
    error.code = 'OUTBOUND_CALL_RESUME_NOT_AUTHORIZED';
    throw error;
  }
  const ts = typeof nowIso === 'function' ? nowIso() : new Date().toISOString();
  return writeJsonAtomic(controlPath(opts), {
    schema: SCHEMA,
    mode: 'enabled',
    reason: String(reason || 'Owner explicitly resumed outbound calls.').slice(0, 1000),
    source: 'owner-resume',
    authorizationText: String(ownerRequestText).slice(0, 500),
    updatedAt: ts,
  });
}

function readOutboundCallAdmission(opts = {}) {
  const operatorState = readOutboundCallControl(opts);
  if (operatorState.mode !== 'enabled') {
    const machineSelfTestCorrection = matchingMachineSelfTestCorrectionLease(opts);
    if (machineSelfTestCorrection) {
      return {
        schema: SCHEMA,
        mode: 'enabled',
        source: 'machine-self-test-correction-lease',
        reason: 'One server-verified machine-only Amy-to-Amy correction proof may run while every ordinary call remains paused.',
        globalMode: 'paused',
        invocationKey: machineSelfTestCorrection.invocationKey,
        correctionLeaseExpiresAt: machineSelfTestCorrection.expiresAt,
      };
    }
    const testAuthorization = matchingOutboundTestAuthorization(opts);
    if (!testAuthorization) return operatorState;
    if (opts.purpose === 'voice-self-test') {
      return {
        schema: SCHEMA,
        mode: 'enabled',
        source: 'outbound-test-authorization',
        reason: 'A scoped owner-authorized release self-test may run while ordinary calls remain paused.',
        globalMode: 'paused',
        testAuthorizationExpiresAt: testAuthorization.expiresAt,
      };
    }
    const release = readVoiceReleaseAdmission(opts);
    if (release.mode !== 'enabled') {
      return { ...release, schema: SCHEMA, releaseProofSchema: release.schema };
    }
    return {
      ...release,
      schema: SCHEMA,
      mode: 'enabled',
      source: 'outbound-test-authorization',
      reason: 'Exactly one principal test call is authorized while ordinary calls remain paused.',
      globalMode: 'paused',
      releaseProofSchema: release.schema,
      testAuthorizationExpiresAt: testAuthorization.expiresAt,
    };
  }
  if (opts.purpose === 'voice-self-test') return operatorState;
  const release = readVoiceReleaseAdmission(opts);
  return { ...release, schema: SCHEMA, releaseProofSchema: release.schema };
}

function recordVoiceReleaseProof({ evidence, ...opts } = {}) {
  const proof = writeVoiceReleaseProof({ ...opts, evidence });
  return {
    ...readOutboundCallAdmission(opts),
    recordedProof: true,
    surfaceHash: proof.surfaceHash,
    provedAt: proof.provedAt,
    releaseProofSchema: proof.schema,
  };
}

function assertOperatorOutboundCallsAllowed(opts = {}) {
  const state = readOutboundCallControl(opts);
  if (state.mode === 'enabled') return state;
  const error = new Error(`[outbound-call-control] PAUSED: ${state.reason}`);
  error.code = 'OUTBOUND_CALLS_PAUSED';
  error.control = state;
  throw error;
}

function assertOutboundCallsAllowed(opts = {}) {
  const state = readOutboundCallAdmission(opts);
  if (state.mode === 'enabled') return state;
  const error = new Error(`[outbound-call-control] PAUSED: ${state.reason}`);
  error.code = 'OUTBOUND_CALLS_PAUSED';
  error.control = state;
  throw error;
}

async function requestRemoteControl(body, opts = {}) {
  const { url, secret } = remoteControlConfig(opts);
  if (!url || !secret) {
    const error = new Error(
      'Canonical outbound-call control URL or signed relay credential is unavailable.',
    );
    error.code = 'OUTBOUND_CALL_REMOTE_CONTROL_UNAVAILABLE';
    throw error;
  }
  const timeoutMs = Math.max(500, Math.min(5000, Number(opts.timeoutMs || 3000)));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const payload = body || { action: 'status' };
    const bodyText = JSON.stringify(payload);
    const route = '/amy/desktop-capabilities/outbound-call-control';
    const response = await (opts.fetchImpl || fetch)(url, {
      method: 'POST',
      headers: desktopHttpHeaders({ method: 'POST', path: route, bodyText }, secret),
      body: bodyText,
      signal: controller.signal,
    });
    if (!response.ok)
      throw new Error(`Canonical outbound-call control returned HTTP ${response.status}.`);
    const result = await response.json();
    const testAction = ['authorize-test', 'consume-test'].includes(payload.action);
    const correctionAction = [
      'authorize-machine-self-test-correction',
      'consume-machine-self-test-correction',
    ].includes(payload.action);
    if (
      correctionAction
        ? result?.schema !== MACHINE_SELF_TEST_CORRECTION_SCHEMA || typeof result?.active !== 'boolean'
        : testAction
        ? result?.schema !== TEST_AUTH_SCHEMA || typeof result?.active !== 'boolean'
        : result?.schema !== SCHEMA || !['enabled', 'paused'].includes(result?.mode)
    ) {
      throw new Error('Canonical outbound-call control returned an invalid state.');
    }
    return result;
  } finally {
    clearTimeout(timer);
  }
}

async function assertCanonicalOutboundCallsAllowed(opts = {}) {
  const localOperator = readOutboundCallControl(opts);
  const localAdmission =
    opts.allowReleaseProofRun === true && localOperator.mode === 'enabled'
      ? localOperator
      : readOutboundCallAdmission(opts);
  if (localAdmission.mode !== 'enabled') {
    const error = new Error(`[outbound-call-control] PAUSED: ${localAdmission.reason}`);
    error.code = 'OUTBOUND_CALLS_PAUSED';
    error.control = localAdmission;
    throw error;
  }
  if (opts.skipRemote === true || (process.platform !== 'win32' && opts.forceRemote !== true)) {
    return localAdmission;
  }
  let remote;
  try {
    remote = await requestRemoteControl(
      {
        action: 'status',
        purpose: opts.purpose || 'outbound-call',
        ...(opts.phoneNumber ? { phone_number: normalizePhone(opts.phoneNumber) } : {}),
        ...(opts.phoneNumberId ? { phone_number_id: String(opts.phoneNumberId).trim() } : {}),
        ...(opts.invocationKey ? { invocation_key: String(opts.invocationKey) } : {}),
      },
      opts,
    );
  } catch (error) {
    const wrapped = new Error(
      `[outbound-call-control] PAUSED: canonical EC2 stop state could not be verified: ${error.message}`,
    );
    wrapped.code = 'OUTBOUND_CALLS_PAUSED';
    throw wrapped;
  }
  if (remote.mode === 'paused') {
    // The release-proof pause is satisfied by exactly one thing: a passing
    // Amy-to-Amy talkback call. Blocking that call on the proof it exists to
    // produce is a deadlock, and it bit us on 2026-08-16 after a voice deploy
    // changed the surface hash: voice was fixed and verified, but the only
    // test that could clear the gate was refused by the gate.
    //
    // A run that IS the proof may proceed past a release-proof pause, and past
    // nothing else. An owner stop, or any other pause source, still refuses.
    // The owner's word is not something a test gets to vote past.
    const releaseProofPause = remote.source === 'voice-release-proof';
    if (!(opts.allowReleaseProofRun === true && releaseProofPause)) {
      const error = new Error(
        `[outbound-call-control] PAUSED: ${remote.reason || 'Canonical EC2 stop state is paused.'}`,
      );
      error.code = 'OUTBOUND_CALLS_PAUSED';
      error.control = remote;
      throw error;
    }
    console.warn(
      '[outbound-call-control] proceeding as the release-proof run: ' +
        (remote.reason || 'call surface awaiting talkback proof'),
    );
    return { ...localAdmission, canonicalRemote: remote, releaseProofRun: true };
  }
  return { ...localAdmission, canonicalRemote: remote };
}

async function pauseOutboundCallsEverywhere({ reason, source, scope, nowIso, ...opts } = {}) {
  const local = pauseOutboundCalls({ reason, source, scope, nowIso, ...opts });
  try {
    const remote = await requestRemoteControl(
      { action: 'pause', reason: local.reason, source: local.source, scope: local.scope },
      opts,
    );
    return { ok: true, local, remote };
  } catch (error) {
    return { ok: false, local, remoteError: String(error.message || error) };
  }
}

async function publishVoiceReleaseProof(evidence, opts = {}) {
  return requestRemoteControl({ action: 'record-voice-release-proof', evidence }, opts);
}

async function admitInternalVoiceSelfTestEverywhere(opts = {}) {
  // Always ask authenticated EC2, including from an EC2 shell. It alone
  // verifies current provider resources. This never changes either stop file.
  const remote = await requestRemoteControl({
    action: 'admit-internal-voice-self-test',
    invocation_key: opts.invocationKey,
    phone_number: opts.phoneNumber,
    phone_number_id: opts.phoneNumberId,
    inbound_phone_number_id: opts.inboundPhoneNumberId,
    surface_hash: currentVoiceSurface({ rootDir: opts.rootDir }).hash,
  }, opts);
  if (remote.mode !== 'enabled' || remote.source !== 'auth-internal-voice-self-tests' ||
      remote.invocationKey !== opts.invocationKey ||
      normalizePhone(remote.phoneNumber) !== normalizePhone(opts.phoneNumber) ||
      remote.phoneNumberId !== opts.phoneNumberId || remote.inboundPhoneNumberId !== opts.inboundPhoneNumberId ||
      remote.surfaceHash !== currentVoiceSurface({ rootDir: opts.rootDir }).hash) {
    throw new Error('Canonical internal voice-test admission did not match this exact route.');
  }
  return remote;
}

async function settleInternalVoiceSelfTestEverywhere({ invocationKey, callIds, reconcile, dialerStopped, ...opts } = {}) {
  return requestRemoteControl({ action: 'settle-internal-voice-self-test', invocation_key: invocationKey,
    call_ids: callIds, reconcile: reconcile === true, dialer_stopped: dialerStopped === true }, opts);
}

async function authorizeOutboundTestEverywhere({
  phoneNumber,
  invocationKey,
  ownerAuthorized,
  ownerRequestText,
  ttlMs,
  nowIso,
  ...opts
} = {}) {
  const validated = validateOutboundTestRequest({
    phoneNumber,
    invocationKey,
    ownerAuthorized,
    ownerRequestText,
    ...opts,
  });
  const remote = await requestRemoteControl(
    {
      action: 'authorize-test',
      phone_number: validated.targetPhone,
      invocation_key: validated.invocationKey,
      owner_authorized: true,
      owner_request_text: String(ownerRequestText || ''),
      ttl_ms: ttlMs,
    },
    opts,
  );
  const local = authorizeOutboundTest({
    phoneNumber,
    invocationKey,
    ownerAuthorized,
    ownerRequestText,
    ttlMs,
    nowIso,
    ...opts,
  });
  return { ok: true, local, remote };
}

async function authorizeMachineSelfTestCorrectionEverywhere({
  invocationKey,
  sourceCallId,
  pairedCallId,
  correlationId,
  ownerAuthorized,
  machineInternalAuthorization,
  ttlMs,
  nowIso,
  ...opts
} = {}) {
  if (
    ownerAuthorized !== true ||
    !isMachineSelfTestCorrectionAuthorized(machineInternalAuthorization, opts)
  ) {
    return authorizeMachineSelfTestCorrection({
      invocationKey,
      ownerAuthorized,
      machineInternalAuthorization,
      providerVerification: null,
      ttlMs,
      nowIso,
      ...opts,
    });
  }
  const remote = await requestRemoteControl(
    {
      action: 'authorize-machine-self-test-correction',
      invocation_key: String(invocationKey || ''),
      source_call_id: String(sourceCallId || ''),
      paired_call_id: String(pairedCallId || ''),
      correlation_id: String(correlationId || ''),
      owner_authorized: true,
      machine_internal_authorization: machineInternalAuthorization,
      ttl_ms: ttlMs,
    },
    opts,
  );
  if (
    remote?.schema !== MACHINE_SELF_TEST_CORRECTION_SCHEMA ||
    remote?.active !== true ||
    remote?.verified !== true ||
    remote?.verifiedBy !== 'vapi-api' ||
    remote?.providerFailureObserved !== true ||
    String(remote?.sourceCallId || '') !== String(sourceCallId || '') ||
    String(remote?.pairedCallId || '') !== String(pairedCallId || '') ||
    String(remote?.correlationId || '') !== String(correlationId || '') ||
    !isHistoricalMachineSelfTestCorrectionPair(remote)
  ) {
    const error = new Error(
      '[outbound-call-control] Canonical EC2 did not return the exact verified machine self-test correction lease.',
    );
    error.code = 'MACHINE_SELF_TEST_CORRECTION_REMOTE_MISMATCH';
    throw error;
  }
  // The EC2 route above has already written the canonical lease after
  // server-fetching Vapi evidence. Rewriting the same canonical data dir here
  // would look like a second authorization and must fail after the receipt
  // hardening below. Windows keeps its local mirror; the canonical Linux host
  // returns the lease it just wrote.
  if (isCanonicalMachineSelfTestCorrectionHost(opts)) {
    return { ok: true, local: remote, remote };
  }
  const local = authorizeMachineSelfTestCorrection({
    invocationKey,
    ownerAuthorized,
    machineInternalAuthorization,
    providerVerification: {
      verified: remote?.verified === true,
      provider: remote?.verifiedBy,
      sourceCallId: remote?.sourceCallId,
      pairedCallId: remote?.pairedCallId,
      correlationId: remote?.correlationId,
      phoneNumberId: remote?.phoneNumberId,
      targetPhone: remote?.targetPhone,
      providerFailureObserved: remote?.providerFailureObserved === true,
    },
    ttlMs,
    nowIso,
    ...opts,
  });
  return { ok: true, local, remote };
}

async function consumeMachineSelfTestCorrectionLeaseEverywhere({
  invocationKey,
  phoneNumber,
  phoneNumberId,
  nowIso,
  ...opts
} = {}) {
  // Canonical EC2 is consumed first. If the desktop write then fails, the
  // provider is still never contacted and the canonical one-shot authority is
  // already closed. The canonical Linux host owns the same durable state, so
  // it consumes once locally instead of routing to itself and consuming twice.
  if (opts.skipRemote === true || isCanonicalMachineSelfTestCorrectionHost(opts)) {
    return {
      ok: true,
      local: consumeMachineSelfTestCorrectionLease({
        invocationKey,
        phoneNumber,
        phoneNumberId,
        nowIso,
        ...opts,
      }),
      remote: null,
    };
  }
  const remote = await requestRemoteControl(
    {
      action: 'consume-machine-self-test-correction',
      invocation_key: String(invocationKey || ''),
      phone_number: normalizePhone(phoneNumber),
      phone_number_id: String(phoneNumberId || '').trim(),
    },
    opts,
  );
  if (remote?.schema !== MACHINE_SELF_TEST_CORRECTION_SCHEMA || remote?.active !== false) {
    const error = new Error(
      '[outbound-call-control] Canonical EC2 did not confirm machine self-test correction consumption.',
    );
    error.code = 'MACHINE_SELF_TEST_CORRECTION_REMOTE_CONSUME_MISMATCH';
    throw error;
  }
  const local = consumeMachineSelfTestCorrectionLease({
    invocationKey,
    phoneNumber,
    phoneNumberId,
    nowIso,
    ...opts,
  });
  return { ok: true, local, remote };
}

async function consumeOutboundTestAuthorizationEverywhere({
  phoneNumber,
  invocationKey,
  nowIso,
  ...opts
} = {}) {
  let remote = null;
  let remoteError = null;
  try {
    remote = await requestRemoteControl(
      {
        action: 'consume-test',
        phone_number: normalizePhone(phoneNumber),
        invocation_key: String(invocationKey || ''),
      },
      opts,
    );
  } catch (error) {
    remoteError = String(error.message || error);
  }
  // Fail closed on the laptop even when EC2 cannot acknowledge consumption.
  // The canonical side may still hold a matching lease, but the local broker
  // cannot pass its first gate again and the persisted intent prevents redial.
  const local = consumeOutboundTestAuthorization({
    phoneNumber,
    invocationKey,
    nowIso,
    ...opts,
  });
  return remoteError
    ? { ok: false, local, remoteError }
    : { ok: true, local, remote };
}

async function resumeOutboundCallsEverywhere({
  reason,
  ownerAuthorized,
  ownerRequestText,
  nowIso,
  ...opts
} = {}) {
  if (ownerAuthorized !== true || !explicitResumeRequested(ownerRequestText)) {
    return resumeOutboundCalls({ reason, ownerAuthorized, ownerRequestText, nowIso, ...opts });
  }
  const remote = await requestRemoteControl(
    {
      action: 'resume',
      reason,
      owner_authorized: true,
      owner_request_text: ownerRequestText,
    },
    opts,
  );
  const local = resumeOutboundCalls({ reason, ownerAuthorized, ownerRequestText, nowIso, ...opts });
  return { ok: true, local, remote };
}

async function resumeOutboundCallsAfterTestApprovalEverywhere({
  ownerAuthorized,
  ownerApprovalText,
  reason,
  nowIso,
  ...opts
} = {}) {
  // Validate locally before changing canonical state, then preserve the normal
  // resume ordering: EC2 first, laptop second.
  validateOutboundTestApprovalRequest({ ownerAuthorized, ownerApprovalText, ...opts });
  const remote = await requestRemoteControl(
    {
      action: 'resume-after-test',
      owner_authorized: true,
      owner_approval_text: String(ownerApprovalText || ''),
      reason,
    },
    opts,
  );
  const local = resumeOutboundCallsAfterTestApproval({
    ownerAuthorized,
    ownerApprovalText,
    reason,
    nowIso,
    ...opts,
  });
  return { ok: true, local, remote };
}

module.exports = {
  admitInternalVoiceSelfTestEverywhere,
  settleInternalVoiceSelfTestEverywhere,
  SCHEMA,
  TEST_AUTH_SCHEMA,
  MACHINE_SELF_TEST_CORRECTION_SCHEMA,
  MACHINE_SELF_TEST_CORRECTION_AUTHORIZATION_SCHEMA,
  MACHINE_SELF_TEST_CORRECTION_SCOPE_ARTIFACT,
  MACHINE_SELF_TEST_CORRECTION_SCOPE_SHA256,
  MACHINE_SELF_TEST_CORRECTION_OWNER_TASK_QUOTE_SHA256,
  DEFAULT_REMOTE_URL,
  assertCanonicalOutboundCallsAllowed,
  assertOperatorOutboundCallsAllowed,
  assertOutboundCallsAllowed,
  authorizeOutboundTest,
  authorizeOutboundTestEverywhere,
  authorizeMachineSelfTestCorrection,
  authorizeMachineSelfTestCorrectionEverywhere,
  consumeOutboundTestAuthorization,
  consumeOutboundTestAuthorizationEverywhere,
  consumeMachineSelfTestCorrectionLease,
  consumeMachineSelfTestCorrectionLeaseEverywhere,
  controlPath,
  defaultDataDir,
  explicitOutboundTestRequested,
  machineSelfTestCorrectionAuthorizationMetadata,
  isMachineSelfTestCorrectionAuthorized,
  explicitOutboundTestApproval,
  explicitResumeRequested,
  outboundTestAuthorizationPath,
  machineSelfTestCorrectionLeasePath,
  machineSelfTestCorrectionReceiptPath,
  pauseOutboundCalls,
  clearPendingCallClassification,
  pauseOutboundCallsEverywhere,
  publishVoiceReleaseProof,
  readOutboundCallAdmission,
  readOutboundCallControl,
  readOutboundTestAuthorization,
  readMachineSelfTestCorrectionLease,
  recordVoiceReleaseProof,
  remoteControlConfig,
  requestRemoteControl,
  resumeOutboundCalls,
  resumeOutboundCallsAfterTestApproval,
  resumeOutboundCallsAfterTestApprovalEverywhere,
  resumeOutboundCallsEverywhere,
  conditionalResumeAfterTestRequested,
  validateOutboundTestRequest,
  validateOutboundTestApprovalRequest,
  validateMachineSelfTestCorrectionEvidence,
  writeJsonAtomic,
};
