'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DESKTOP_CAPABILITIES = new Set([
  'desktop_browser_task',
  'desktop_app_task',
  'check_desktop_dev_sessions',
]);
const FOREGROUND_DESKTOP_CAPABILITIES = new Set(['check_desktop_dev_sessions']);

// A cross-host request with no expiry is durably pending forever. With the PC
// off it sat in the queue until someone happened to look, which is how a caller
// could be told a desktop task was handled when nothing had run and nothing
// ever would (g26 hole (e)). Every request now carries a signed deadline: past
// it the request is terminal, it is never handed to a desktop that wakes up
// later, and the reaper surfaces it.
const DEFAULT_DESKTOP_REQUEST_TTL_MS = 30 * 60 * 1000;

function relaySecret() {
  const secret = String(process.env.AMY_DESKTOP_RELAY_SECRET || '').trim();
  if (secret.length < 32)
    throw new Error('desktop relay signing secret is unavailable or too short');
  return secret;
}

function signedFields(request) {
  return {
    schema: request.schema,
    request_id: request.request_id,
    created_at: request.created_at,
    turn_id: request.turn_id,
    session_id: request.session_id,
    capability: request.capability,
    arguments: request.arguments,
    invocation_key: request.invocation_key,
    // Inside the signed envelope on purpose: anyone who can write to the queue
    // directory must not be able to extend a request's life. Omitted from the
    // digest when absent, so a request written before expiries existed still
    // verifies and simply falls back to created_at + the default TTL.
    expires_at: request.expires_at,
    // Same reasoning for the origin channel, which decides where the terminal
    // notice may be delivered. Inferring it later from the session id would let
    // a caller pick its own delivery route.
    origin_channel: request.origin_channel,
  };
}

function signDesktopCapabilityRequest(request, secret = relaySecret()) {
  return crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(signedFields(request)))
    .digest('hex');
}

function verifyDesktopCapabilityRequest(request, secret = relaySecret()) {
  if (!request || request.schema !== 'amy.desktop-capability-request.v1') return false;
  if (!DESKTOP_CAPABILITIES.has(request.capability)) return false;
  const expected = signDesktopCapabilityRequest(request, secret);
  const actual = String(request.signature || '');
  return (
    actual.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
  );
}

function signedReceiptFields(receipt) {
  return {
    schema: receipt.schema,
    receipt_id: receipt.receipt_id,
    request_id: receipt.request_id,
    turn_id: receipt.turn_id,
    capability: receipt.capability,
    status: receipt.status,
    completed_at: receipt.completed_at,
    result: receipt.result,
  };
}

function signDesktopCapabilityReceipt(receipt, secret = relaySecret()) {
  return crypto
    .createHmac('sha256', secret)
    .update(JSON.stringify(signedReceiptFields(receipt)))
    .digest('hex');
}

function verifyDesktopCapabilityReceipt(receipt, secret = relaySecret()) {
  if (!receipt || receipt.schema !== 'amy.desktop-capability-receipt.v1') return false;
  const expected = signDesktopCapabilityReceipt(receipt, secret);
  const actual = String(receipt.signature || '');
  return (
    actual.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
  );
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

function queueDir(dataDir) {
  return path.join(dataDir, 'agent', 'desktop-capability-queue');
}

// Terminal work leaves the hot queue. Everything that scans this directory does
// so synchronously on the backend event loop and on the claim route, so a
// directory that only ever grows turns into latency that only ever grows
// (deploy-gate review 5982f14e5658). Nothing is deleted: the pair moves to
// `archive/`, where the evidence survives and no scanner walks it.
function archiveDir(dataDir) {
  return path.join(queueDir(dataDir), 'archive');
}

// All or nothing. A half-moved pair is worse than an unmoved one: the request
// leaves the hot queue while its receipt does not, or the reverse, and the
// lifecycle can no longer see either half consistently. A failure is REPORTED,
// because "the next sweep retries" stopped being true the moment
// notice_delivered flipped and the record stopped being selected (deploy-gate
// review 93b4b1a1a608).
// ORDER IS THE DURABILITY MECHANISM. Two renames cannot be one atomic act, so
// the order is chosen for what a crash between them leaves behind: the RECEIPT
// moves first and the REQUEST last, which means an interrupted archive always
// leaves the request in the hot queue, where it can still be marked
// archive_pending and still be selected for retry. Reversing that order strands
// the pair with nothing left to mark (deploy-gate review 7f7ccdb77f10).
//
// A split pair is not a correctness problem for READERS, because
// resolveDesktopRecord looks up each half independently, hot then archive. It is
// only a tidiness problem, and this finishes the job on the next sweep.
const ARCHIVE_ORDER = ['.receipt.json', '.json'];

// A REGULAR FILE, not merely a path that exists. `existsSync` is true for a
// directory, so an archive path occupied by a directory counted as a
// successfully archived half and the pair reported complete with nothing
// readable in it (deploy-gate review 71492a45413c).
function archivedCounterpartPresent(dataDir, requestId, suffix) {
  try {
    return fs.statSync(path.join(archiveDir(dataDir), `${requestId}${suffix}`)).isFile();
  } catch {
    return false;
  }
}

function hotHalfIsFile(dir, requestId, suffix) {
  try {
    return fs.statSync(path.join(dir, `${requestId}${suffix}`)).isFile();
  } catch {
    return false;
  }
}

function archiveTerminalPair({ dataDir, requestId, reason = 'delivered' } = {}) {
  const dir = queueDir(dataDir);
  const target = archiveDir(dataDir);
  fs.mkdirSync(target, { recursive: true });
  const moved = [];
  for (const suffix of ARCHIVE_ORDER) {
    const from = path.join(dir, `${requestId}${suffix}`);
    if (!hotHalfIsFile(dir, requestId, suffix)) {
      // Already archived by an earlier interrupted pass, or genuinely absent.
      if (archivedCounterpartPresent(dataDir, requestId, suffix)) continue;
      // A terminal record always has both halves. One missing entirely is an
      // anomaly, so say so rather than reporting a clean archive.
      return { ok: false, moved, reason, error: `missing ${suffix} for ${requestId}` };
    }
    try {
      fs.renameSync(from, path.join(target, `${requestId}${suffix}`));
      moved.push(path.join(target, `${requestId}${suffix}`));
    } catch (error) {
      return { ok: false, moved, reason, error: error.message };
    }
  }
  // Only ok when BOTH halves actually ended up in the archive.
  const complete = ARCHIVE_ORDER.every((suffix) =>
    archivedCounterpartPresent(dataDir, requestId, suffix),
  );
  return complete
    ? { ok: true, moved, reason }
    : { ok: false, moved, reason, error: `incomplete archive pair for ${requestId}` };
}

function tamperError(message) {
  const error = new Error(message);
  error.code = 'DESKTOP_CAPABILITY_TAMPER';
  return error;
}

// Terminal states never come back to life, so they are never re-expired and
// never re-surfaced.
const TERMINAL_REQUEST_STATUSES = new Set(['completed', 'expired']);

function desktopRequestExpiryMs(request) {
  const explicit = Date.parse(request?.expires_at || '');
  if (Number.isFinite(explicit)) return explicit;
  const created = Date.parse(request?.created_at || '');
  return Number.isFinite(created) ? created + DEFAULT_DESKTOP_REQUEST_TTL_MS : NaN;
}

function isExpiredDesktopRequest(request, nowMs = Date.now()) {
  if (!request || TERMINAL_REQUEST_STATUSES.has(String(request.status || ''))) return false;
  // Work the desktop is actively holding is in flight, not abandoned. The
  // overall deadline applies again only once its lease lapses.
  if (request.status === 'claimed' && Date.parse(request.lease_expires_at || '') > nowMs)
    return false;
  const expiry = desktopRequestExpiryMs(request);
  return Number.isFinite(expiry) && expiry <= nowMs;
}

function expiredRequestResult(request) {
  return {
    ok: false,
    status: 'desktop_request_expired',
    completed: false,
    reason: 'The desktop never claimed this request before its deadline.',
    summary:
      'Your PC never picked this up before the request expired, so it was not done and it will not run now.',
    capability: request.capability,
  };
}

function expireDesktopRequest(dir, file, request, nowMs) {
  const receiptFile = path.join(dir, `${request.request_id}.receipt.json`);
  const receipt = {
    schema: 'amy.desktop-capability-receipt.v1',
    receipt_id: `desktop_receipt_${crypto.randomUUID()}`,
    request_id: request.request_id,
    turn_id: request.turn_id,
    capability: request.capability,
    status: 'failed',
    completed_at: new Date(nowMs).toISOString(),
    result: expiredRequestResult(request),
  };
  receipt.signature = signDesktopCapabilityReceipt(receipt);
  // The receipt is written first so a caller still waiting on this request
  // resolves with the real outcome instead of its own opaque timeout.
  writeJsonAtomic(receiptFile, receipt);
  writeJsonAtomic(file, {
    ...request,
    status: 'expired',
    expired_at: receipt.completed_at,
    receipt_id: receipt.receipt_id,
    // Marks this terminal state as owing the owner a notice. Requests that
    // terminalized before this existed carry no marker and are never
    // retroactively announced.
    notice_owed: true,
  });
  return receipt;
}

function queuedRequestFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.json') && !name.endsWith('.receipt.json'))
    .sort();
}

// A file that fails signature verification or will not parse is moved aside
// rather than left in place. claimDesktopCapability throws on the first bad
// file it meets, so leaving one there blocks every valid request sorted behind
// it: a tamper signal must not become a denial of service. The file is kept,
// renamed out of the claimable set, so the evidence survives for the security
// ledger.
// Unique destination, and a failure to isolate is reported rather than
// swallowed. A fixed `.quarantine` name collided with an earlier quarantine, so
// the rename failed silently and the bad `.json` stayed claimable, which is the
// blockage this exists to remove (Codex review 81d624d56856).
function quarantineQueueFile(dir, name) {
  const from = path.join(dir, name);
  const to = path.join(dir, `${name}.${Date.now()}.${process.pid}.quarantine`);
  try {
    fs.renameSync(from, to);
    return { ok: true, to };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

// Sweeps the queue for requests past their deadline, terminalizes them, and
// RETURNS them so the caller can surface them. An expired request nobody hears
// about is the same defect in a new place, so this never swallows its result. A
// tampered file is reported, not thrown: one bad file must not stop the sweep
// from expiring everything else.
function reapExpiredDesktopCapabilities({ dataDir, nowMs = Date.now(), force = false } = {}) {
  if (!dataDir) throw new Error('desktop relay reap requires dataDir');
  const dir = queueDir(dataDir);
  const expired = [];
  const tampered = [];
  const quarantineFailures = [];
  for (const name of queuedRequestFiles(dir)) {
    const file = path.join(dir, name);
    let request;
    try {
      request = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      const moved = quarantineQueueFile(dir, name);
      tampered.push(name.replace(/\.json$/, ''));
      if (!moved.ok) quarantineFailures.push({ name, reason: moved.reason });
      continue;
    }
    if (!verifyDesktopCapabilityRequest(request)) {
      const moved = quarantineQueueFile(dir, name);
      tampered.push(request?.request_id || name.replace(/\.json$/, ''));
      if (!moved.ok) quarantineFailures.push({ name, reason: moved.reason });
      continue;
    }
    // `force` means "expire everything still open", never "re-expire what is
    // already finished". Overwriting a completed request's valid receipt with an
    // expiry receipt destroys the only authenticated record of what happened
    // (deploy-gate review 93b4b1a1a608).
    if (TERMINAL_REQUEST_STATUSES.has(String(request.status || ''))) continue;
    if (!force && !isExpiredDesktopRequest(request, nowMs)) continue;
    // `force` still refuses to yank work the desktop is actively holding: a
    // drain must not orphan a task that is running right now.
    if (
      force &&
      request.status === 'claimed' &&
      Date.parse(request.lease_expires_at || '') > nowMs
    ) {
      continue;
    }
    const receipt = expireDesktopRequest(dir, file, request, nowMs);
    expired.push({
      request_id: request.request_id,
      capability: request.capability,
      turn_id: request.turn_id,
      session_id: request.session_id,
      created_at: request.created_at,
      expires_at: new Date(desktopRequestExpiryMs(request)).toISOString(),
      receipt_id: receipt.receipt_id,
      arguments: request.arguments,
    });
  }
  return { ok: true, expired, tampered, quarantineFailures };
}

// The lease MUST outlive the desktop worker's own execution timeout. At the old
// 10-minute default a long browser task was still running when its lease lapsed,
// so a second poll could reclaim and execute the same owner request a second
// time. Completion is lease-fenced, so the duplicate could not double-report, but
// it could double-ACT, which is worse. The ceiling lives here rather than in the
// worker so the two cannot drift, and the worker CLAMPS its own configurable
// timeout to it instead of merely defaulting to it.
// The desktop worker runs from its OWN installed runtime, updated by
// scripts/provision-desktop-capability-relay.js, not by an EC2 deploy. So a
// cloud release can be current while the PC still runs the version that turned
// an exit-zero blocker into a signed success. A completion must therefore prove
// which protocol produced it, and the cloud rejects anything that cannot
// (deploy-gate review 5982f14e5658).
//
// Scoped to capabilities that ACT. A foreground read returning a stale session
// list is not a false claim about work performed, so reads keep working while
// the desktop runtime catches up; only completions are withheld.
const DESKTOP_WORKER_PROTOCOL = 2;

const DESKTOP_WORKER_MAX_RUNTIME_MS = 20 * 60 * 1000;
const DEFAULT_DESKTOP_LEASE_TTL_MS = DESKTOP_WORKER_MAX_RUNTIME_MS + 5 * 60 * 1000;

// An expiry is only surfaced once someone was actually told. Delivery can be
// refused (Telegram's approved-reasons policy) or simply fail, so the outcome is
// recorded on the request itself and the sweep retries anything still
// undelivered. Without this the terminal notice is fire-and-forget, which is the
// original bug wearing a different hat.
// ONE outbox for both terminal outcomes. The completion notice had the same
// fire-and-forget bug the expiry notice had, so both now flow through the same
// owed-until-delivered state and the same sweep retry.
// Reads the authenticated terminal outcome for a request. Fails CLOSED: an
// unreadable or unverifiable receipt is reported as not-ok rather than assumed
// successful, because the whole point is that nobody hears "finished" without
// proof.
function terminalOutcome(dir, request) {
  if (request.status === 'expired') {
    return { ok: false, summary: expiredRequestResult(request).summary };
  }
  let receipt;
  try {
    receipt = JSON.parse(
      fs.readFileSync(path.join(dir, `${request.request_id}.receipt.json`), 'utf8'),
    );
  } catch {
    return { ok: false, summary: 'The desktop outcome could not be read, so it is not confirmed.' };
  }
  // A valid signature proves the receipt is GENUINE, not that it belongs to
  // THIS request. A genuine receipt copied from another request would otherwise
  // narrate the wrong outcome to a human, so every binding field is checked
  // (deploy-gate review 5982f14e5658).
  if (
    !verifyDesktopCapabilityReceipt(receipt) ||
    receipt.request_id !== request.request_id ||
    receipt.turn_id !== request.turn_id ||
    receipt.capability !== request.capability ||
    (request.receipt_id && receipt.receipt_id !== request.receipt_id)
  ) {
    return {
      ok: false,
      summary: 'The desktop receipt failed authentication, so the outcome is not confirmed.',
    };
  }
  const payload = receipt.result || {};
  const ok = receipt.status === 'succeeded' && payload.ok !== false;
  return {
    ok,
    summary: String(payload.summary || payload.reason || '').trim(),
  };
}

function pendingTerminalNotices({ dataDir, nowMs = Date.now() } = {}) {
  if (!dataDir) throw new Error('desktop relay notice scan requires dataDir');
  const dir = queueDir(dataDir);
  const pending = [];
  for (const name of queuedRequestFiles(dir)) {
    let request;
    try {
      request = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    } catch {
      continue;
    }
    if (request.notice_owed !== true || request.notice_delivered === true) continue;
    if (!TERMINAL_REQUEST_STATUSES.has(String(request.status || ''))) continue;
    // origin_channel, arguments, and session_id below all steer an OUTBOUND
    // message to a human, so the record they come from must prove its own
    // signature first. An unverifiable record is quarantined, never narrated.
    if (!verifyDesktopCapabilityRequest(request)) {
      quarantineQueueFile(dir, name);
      continue;
    }
    // `completed` is the request status for a FAILED worker result too, so the
    // notice text must come from the signed receipt. Rendering every non-expired
    // terminal as "finished" told the owner a failed task had succeeded on any
    // redrive (Codex review e4c1259ce531).
    const outcome = terminalOutcome(dir, request);
    pending.push({
      request_id: request.request_id,
      capability: request.capability,
      status: request.status,
      outcome_ok: outcome.ok,
      outcome_summary: outcome.summary,
      turn_id: request.turn_id,
      session_id: request.session_id,
      origin_channel: request.origin_channel || null,
      created_at: request.created_at,
      expired_at: request.expired_at || null,
      completed_at: request.completed_at || null,
      expires_at: new Date(desktopRequestExpiryMs(request)).toISOString(),
      arguments: request.arguments,
      notice_attempts: Number(request.notice_attempts || 0),
      age_ms:
        nowMs -
          Date.parse(request.expired_at || request.completed_at || request.created_at || '') || 0,
    });
  }
  return pending;
}

function recordTerminalNoticeOutcome({ dataDir, requestId, delivered, reason } = {}) {
  const file = path.join(queueDir(dataDir), `${requestId}.json`);
  let request;
  try {
    request = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { ok: false, reason: 'request_unreadable' };
  }
  if (!TERMINAL_REQUEST_STATUSES.has(String(request.status || ''))) {
    return { ok: false, reason: 'request_not_terminal' };
  }
  writeJsonAtomic(file, {
    ...request,
    notice_delivered: delivered === true,
    notice_attempts: Number(request.notice_attempts || 0) + 1,
    notice_last_reason: delivered === true ? '' : String(reason || 'delivery_failed'),
    notice_last_attempt_at: new Date().toISOString(),
  });
  // Once the owner has actually been told, this request owes nothing and can
  // leave the hot path. If the move fails it is recorded, not assumed: nothing
  // selects this record any more, so a silent failure would strand the pair in
  // the hot queue forever.
  if (delivered !== true) return { ok: true };
  const archived = archiveTerminalPair({ dataDir, requestId, reason: 'notice-delivered' });
  if (!archived.ok) {
    try {
      const current = JSON.parse(fs.readFileSync(file, 'utf8'));
      writeJsonAtomic(file, {
        ...current,
        archive_pending: true,
        archive_last_error: String(archived.error || 'archive_failed'),
      });
    } catch {
      /* the record is unreadable; the sweep's own verification will quarantine it */
    }
  }
  return { ok: true, archived: archived.ok };
}

// Retries every terminal pair whose archive move failed. Without this,
// `archive_pending` was a label with no reader and the record sat in the hot
// queue forever.
function retryPendingArchives({ dataDir } = {}) {
  const dir = queueDir(dataDir);
  const archived = [];
  const stillPending = [];
  for (const requestId of pendingArchives({ dataDir })) {
    const moved = archiveTerminalPair({ dataDir, requestId, reason: 'archive-retry' });
    if (moved.ok) {
      archived.push(requestId);
      continue;
    }
    stillPending.push({ request_id: requestId, reason: moved.error || 'archive_failed' });
    const file = path.join(dir, `${requestId}.json`);
    try {
      const current = JSON.parse(fs.readFileSync(file, 'utf8'));
      writeJsonAtomic(file, {
        ...current,
        archive_pending: true,
        archive_attempts: Number(current.archive_attempts || 0) + 1,
        archive_last_error: String(moved.error || 'archive_failed'),
      });
    } catch {
      /* unreadable; the sweep's own verification quarantines it */
    }
  }
  return { ok: true, archived, stillPending };
}

// Terminal pairs whose archive move failed. They owe nobody a notice, so nothing
// else would ever look at them again.
// ONE predicate, derived from disk: a terminal request still sitting in the hot
// queue whose owner has already been told is owed an archive. That is true after
// a caught rename failure, after a crash between the two renames, and after any
// partial move, because nothing here depends on a marker that something had to
// survive long enough to write.
//
// The earlier version selected on an `archive_pending` FLAG and needed a second
// inference rule bolted alongside it, because a crash cannot write the marker
// that proves it crashed (deploy-gate reviews 7f7ccdb77f10, 71492a45413c). Two
// rules that can disagree with each other are worse than one rule that reads the
// only thing that is actually authoritative. `archive_pending` remains as
// observability, never as the selector.
function pendingArchives({ dataDir } = {}) {
  if (!dataDir) throw new Error('desktop relay archive scan requires dataDir');
  const dir = queueDir(dataDir);
  const pending = [];
  for (const name of queuedRequestFiles(dir)) {
    let request;
    try {
      request = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    } catch {
      continue;
    }
    if (!TERMINAL_REQUEST_STATUSES.has(String(request.status || ''))) continue;
    if (request.notice_delivered !== true) continue;
    pending.push(request.request_id);
  }
  return pending;
}

// Empties the ACTIVE queue. Required before rolling back to a release whose
// signature does not cover `expires_at` or `origin_channel`: that older
// claimant verifies signatures before it checks status, so one new-format
// request makes it throw tamper and refuse every claim behind it. Draining is
// safe because a queued request is at most its TTL old and its owner is told.
function drainDesktopCapabilityQueue({ dataDir, nowMs = Date.now() } = {}) {
  if (!dataDir) throw new Error('desktop relay drain requires dataDir');
  const dir = queueDir(dataDir);
  // Expire anything still live first, so nothing is removed without the owner
  // being told it will not run.
  const reaped = reapExpiredDesktopCapabilities({ dataDir, nowMs, force: true });
  const drained = [];
  const held = [];
  const owed = [];
  for (const name of queuedRequestFiles(dir)) {
    const requestId = name.replace(/\.json$/, '');
    let request = null;
    try {
      request = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    } catch {
      request = null;
    }
    // Never yank work the desktop is running RIGHT NOW: archiving it would
    // orphan a task mid-flight and lose its receipt when it completes.
    if (
      request &&
      request.status === 'claimed' &&
      Date.parse(request.lease_expires_at || '') > nowMs
    ) {
      held.push(requestId);
      continue;
    }
    // And never archive an outcome its owner has not been told about. Draining
    // ahead of delivery silently loses the notice, which is the original defect
    // wearing rollback clothing.
    if (request && request.notice_owed === true && request.notice_delivered !== true) {
      owed.push(requestId);
      continue;
    }
    const moved = archiveTerminalPair({ dataDir, requestId, reason: 'rollback-drain' });
    if (moved.ok) drained.push(requestId);
  }
  const remaining = queuedRequestFiles(dir).length;
  // FAIL CLOSED. Reporting ok while incompatible new-format records remain is
  // how a rollback proceeds into the exact signature failure this drain exists
  // to prevent.
  return {
    ok: held.length === 0 && owed.length === 0 && remaining === 0,
    drained,
    held,
    owed,
    remaining,
    expired: reaped.expired.length,
    nowMs,
  };
}

function claimDesktopCapability({
  dataDir,
  workerId,
  leaseTtlMs = DEFAULT_DESKTOP_LEASE_TTL_MS,
  nowMs = Date.now(),
} = {}) {
  if (!dataDir || !workerId) throw new Error('desktop relay claim requires dataDir and workerId');
  const dir = queueDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const files = queuedRequestFiles(dir);
  for (const name of files) {
    const file = path.join(dir, name);
    const request = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!verifyDesktopCapabilityRequest(request)) {
      throw tamperError(
        `desktop capability signature verification failed for ${request.request_id || name}`,
      );
    }
    // A PC that comes back online hours later must never silently execute a
    // stale owner request. Expiry is enforced here too, so it does not depend on
    // the sweep having run first.
    if (isExpiredDesktopRequest(request, nowMs)) {
      expireDesktopRequest(dir, file, request, nowMs);
      continue;
    }
    const leaseExpired =
      request.status === 'claimed' && Date.parse(request.lease_expires_at || '') <= nowMs;
    if (request.status !== 'queued' && !leaseExpired) continue;
    const leaseToken = crypto.randomUUID();
    const claimed = {
      ...request,
      status: 'claimed',
      worker_id: workerId,
      lease_token: leaseToken,
      claimed_at: new Date(nowMs).toISOString(),
      lease_expires_at: new Date(nowMs + leaseTtlMs).toISOString(),
    };
    writeJsonAtomic(file, claimed);
    return { ok: true, request: signedFields(claimed), lease_token: leaseToken };
  }
  return { ok: true, request: null };
}

function completeDesktopCapability({ dataDir, requestId, leaseToken, result } = {}) {
  const file = path.join(queueDir(dataDir), `${requestId}.json`);
  const request = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!verifyDesktopCapabilityRequest(request))
    throw tamperError('desktop capability signature verification failed');
  const receiptFile = path.join(queueDir(dataDir), `${requestId}.receipt.json`);
  if (request.status === 'completed' && request.receipt_id && fs.existsSync(receiptFile)) {
    const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
    if (!verifyDesktopCapabilityReceipt(receipt)) {
      throw tamperError('desktop capability receipt signature verification failed');
    }
    return {
      ok: true,
      already_completed: true,
      session_id: request.session_id,
      origin_channel: request.origin_channel || null,
      receipt,
    };
  }
  if (request.status === 'expired') {
    throw new Error('desktop capability request expired before completion');
  }
  if (request.status !== 'claimed' || request.lease_token !== leaseToken) {
    throw new Error('desktop capability completion lease mismatch');
  }
  const attested =
    FOREGROUND_DESKTOP_CAPABILITIES.has(request.capability) ||
    Number(result?.worker_protocol) === DESKTOP_WORKER_PROTOCOL;
  const effectiveResult = attested
    ? result || { ok: false, reason: 'desktop worker returned no result' }
    : {
        ok: false,
        status: 'desktop_worker_protocol_stale',
        completed: false,
        reason: `The desktop worker reported protocol ${result?.worker_protocol ?? 'none'}, but this cloud release requires ${DESKTOP_WORKER_PROTOCOL}.`,
        summary:
          'Your PC answered, but it is running an out-of-date worker whose result I cannot trust, so I am not calling this done.',
        worker_summary: String(result?.summary || '').slice(0, 2000),
      };
  const receipt = {
    schema: 'amy.desktop-capability-receipt.v1',
    receipt_id: `desktop_receipt_${crypto.randomUUID()}`,
    request_id: requestId,
    turn_id: request.turn_id,
    capability: request.capability,
    status: effectiveResult.ok === false ? 'failed' : 'succeeded',
    completed_at: new Date().toISOString(),
    result: effectiveResult,
  };
  receipt.signature = signDesktopCapabilityReceipt(receipt);
  writeJsonAtomic(receiptFile, receipt);
  writeJsonAtomic(file, {
    ...request,
    worker_protocol_attested: attested,
    status: 'completed',
    completed_at: receipt.completed_at,
    receipt_id: receipt.receipt_id,
    notice_owed: true,
  });
  return {
    ok: true,
    session_id: request.session_id,
    origin_channel: request.origin_channel || null,
    receipt,
  };
}

module.exports = {
  DEFAULT_DESKTOP_REQUEST_TTL_MS,
  DESKTOP_CAPABILITIES,
  FOREGROUND_DESKTOP_CAPABILITIES,
  claimDesktopCapability,
  completeDesktopCapability,
  DEFAULT_DESKTOP_LEASE_TTL_MS,
  DESKTOP_WORKER_MAX_RUNTIME_MS,
  DESKTOP_WORKER_PROTOCOL,
  desktopRequestExpiryMs,
  isExpiredDesktopRequest,
  archiveDir,
  archiveTerminalPair,
  retryPendingArchives,
  drainDesktopCapabilityQueue,
  pendingArchives,
  pendingTerminalNotices,
  quarantineQueueFile,
  terminalOutcome,
  reapExpiredDesktopCapabilities,
  recordTerminalNoticeOutcome,
  relaySecret,
  signDesktopCapabilityReceipt,
  signDesktopCapabilityRequest,
  signedReceiptFields,
  signedFields,
  tamperError,
  verifyDesktopCapabilityRequest,
  verifyDesktopCapabilityReceipt,
  writeJsonAtomic,
};
