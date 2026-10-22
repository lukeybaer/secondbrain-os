'use strict';

// Decides which sshd logins on the cloud host are leaked tunnels.
//
// On 2026-10-03 the host held 4,870 open logins from one address. Each was a
// command-less `ssh -N -L` tunnel that only exchanged a 60 second keepalive,
// and they arrive in waves of 1,300 to 1,600 a night, five to seven a minute.
// sshd never closes those on its own (a live client answers keepalives), and
// together they filled swap. The same address also holds legitimate
// long-lived tunnels and makes short command logins all day, so a login is
// closed only when it matches the leak's whole fingerprint, and every doubt
// keeps it open.
//
// A login is MATCHING only when all of these hold:
// - Tunnel-shaped: its monitor "<name>: <user> [priv]" has the listener as
//   its parent and exactly one descendant, the user process titled exactly
//   "<name>: <user>" with the monitor's own process name and user. An "@"
//   title (a command or subsystem was requested, even after its process left
//   the tree), a "[net]" child, another user's name or any further process
//   is not tunnel-shaped.
// - No remote forward (an sshd-owned listening TCP or unix socket), no open
//   forwarded TCP channel, and readable socket and byte counters.
// - At least 15 minutes old.
// - Observed showing the leak's keepalive and nothing else, never inferred
//   from lifetime totals: at least three consecutive comparable intervals
//   spanning at least 14 minutes, each inside the band of both directions.
//   Client to server (bytes received): at most 70 bytes a minute plus 60 and
//   at least 35 bytes a minute less 40, so 135 to 410 bytes over five
//   minutes. Server to client (bytes acked): at most 40 bytes a minute plus
//   40 and at least 18 bytes a minute less 30, so 60 to 240 bytes over five
//   minutes. Measured on the production host on 2026-10-05: exactly 260
//   bytes in and 140 bytes out per five minutes for every leaked tunnel (five
//   52 byte keepalive requests and five 28 byte replies), and a window of
//   about five minutes holds four to six of them (208 to 312 in, 112 to 168
//   out), all inside both bands with margin on each side. A silent tunnel
//   never lands inside them, so it never matches. An interval of 100 seconds
//   or less, where the server to client lower bound is not positive, is not
//   comparable. Elapsed time is the login's own etimes delta, which a
//   wall-clock step cannot move.
// - A burst member: at least 20 tunnel-shaped logins from its source started
//   within 30 minutes before or after its own start, itself included. The
//   burst history holds the start of every tunnel-shaped login this program
//   has seen in the last 48 hours, including logins already closed, and every
//   run adds the live ones it has not recorded yet, so a backlog that
//   predates the state file still counts.
// A source's matching logins are all targets, oldest first, but only while
// the source holds more than 8 of them. No matching login is kept back to fill
// a quota, and a login outside a burst is never a target however many others
// exist. The runner discards the stored observations and burst history when
// its boot clock reference (wall time less pid 1's age) moved by more than 10
// seconds since the last run, so a clock step never mixes two clocks.
//
// Accepted limits. A command-less tunnel that starts within 30 minutes either
// side of a burst from the same address and, for 15 minutes, shows only a 60
// second keepalive rate, inside both bands, is closed. So is one with no
// keepalive whose only traffic lands inside both bands at once, for example
// one request every five minutes that moves 135 to 410 bytes in and 60 to 240
// bytes out. A silent tunnel never matches. A tunnel that matches but is held under the floor of
// 8 can be closed when a later wave within 48 hours pushes the source over 8.
// Up to 8 leaked tunnels can remain after a wave; the next wave within 48
// hours closes them, unless a clock step discarded the history first. The
// installer removes the cron row when its proof run fails; its exit 75
// (crontab unreadable or unwritable) can leave an earlier row active. The
// System Health row (red above 300 open logins) is the detector for
// everything this program does not close: leaks slower than 20 tunnel-shaped
// starts per hour-wide window, sessions orphaned by an sshd restart, and
// leftovers no later wave reaches.

const crypto = require('node:crypto');

const DEFAULTS = Object.freeze({
  minAgeSeconds: 15 * 60,
  // Each direction has its own band. Measured on the production host on
  // 2026-10-05: exactly 260 bytes in and 140 bytes out per five minutes for
  // every leaked tunnel, five 52 byte keepalive requests and five 28 byte
  // replies; a window of about five minutes holds four to six of them. A 30
  // second keepalive moves 104 bytes a minute in and 56 out.
  //
  // Client to server (bytes received), at most 70 bytes a minute plus 60:
  // 410 over five minutes. Six keepalives fit (312); a 30 second keepalive
  // (520) does not, and neither do five keepalives plus a request of more
  // than 150 bytes in. 600 seconds allow 760 (ten keepalives: 520) and 1,200
  // seconds 1,460 (twenty: 1,040).
  receivedBytesPerMinute: 70,
  receivedSlackBytes: 60,
  // At least 35 bytes a minute less 40: 135 over five minutes, so four
  // keepalives (208) clear it and a tunnel that moves less, including one
  // with no keepalive, never matches. 310 at 600 seconds, 660 at 1,200.
  receivedFloorBytesPerMinute: 35,
  receivedFloorSlackBytes: 40,
  // Server to client (bytes acked), at most 40 bytes a minute plus 40: 240
  // over five minutes. Six replies fit (168); a 30 second keepalive (280)
  // does not, and neither do five replies plus more than 100 bytes out. 440
  // at 600 seconds (ten replies: 280), 840 at 1,200 (twenty: 560).
  ackedBytesPerMinute: 40,
  ackedSlackBytes: 40,
  // At least 18 bytes a minute less 30: 60 over five minutes, so four replies
  // (112) clear it. 150 at 600 seconds, 330 at 1,200. It is positive only
  // for intervals over 100 seconds.
  ackedFloorBytesPerMinute: 18,
  ackedFloorSlackBytes: 30,
  quietIntervalsToClose: 3,
  // Three intervals of the five-minute cron span 15 minutes. A little under
  // that absorbs run-start jitter; extra runs close together cannot shortcut it.
  minQuietSeconds: 14 * 60,
  // Runs closer than this are not comparable, so a stored streak is never
  // longer than its span allows at one interval a minute.
  minIntervalSeconds: 60,
  // Runs further apart than this are not comparable.
  maxIntervalSeconds: 20 * 60,
  // An interval whose etimes delta and wall-clock delta differ by more than
  // this saw a clock step or a reused pid, and says nothing about idleness.
  clockToleranceSeconds: 10,
  // A leak wave starts five to seven tunnels a minute, so a member has
  // hundreds of neighbours inside the window; a trickle of ten an hour has
  // about eleven.
  minBurstStarts: 20,
  burstWindowSeconds: 30 * 60,
  burstHistorySeconds: 48 * 60 * 60,
  // A source is acted on only while it holds more than this many matching logins.
  sourceFloor: 8,
  // Closing thousands of swapped-out sessions at once drove the load average
  // past 2,000 on 2026-10-03, so each run closes a bounded number.
  maxReapPerRun: 300,
});

// Why a login is not a target, in the order the checks run.
const KEEP_REASONS = Object.freeze([
  'orphaned',
  'command',
  'remoteForward',
  'activeChannel',
  'unknownSocket',
  'traffic',
  'silent',
  'notQuietYet',
  'young',
  'notBurst',
  'underFloor',
]);

// OpenSSH before 9.8 titles each login "sshd: user [priv]" (the root monitor)
// and "sshd: user" or "sshd: user@notty" (the user process). 9.8 and later run
// both as sshd-session. The listener keeps "sshd: ... [listener]" in both, and
// ss names a socket owner "sshd" or "sshd-session".
const SESSION_NAME = '(?:sshd|sshd-session)';
const MONITOR_ARGS = new RegExp(`^${SESSION_NAME}: \\S+ \\[priv\\]\\s*$`);
// The monitor's process name and user, for the exact title its child must have.
const MONITOR_PARTS = /^(sshd|sshd-session): (\S+) \[priv\]\s*$/;
const USER_ARGS = new RegExp(`^${SESSION_NAME}: \\S+`);
const LISTENER_ARGS = /^sshd: .*\[listener\]|^\/usr\/sbin\/sshd\b/;
const SSHD_OWNER = new RegExp(`\\("${SESSION_NAME}",pid=(\\d+)`, 'g');
// Sessions in these states are not recorded in the observation state.
const NOT_RECORDED = new Set(['orphaned', 'command', 'unknownSocket']);

function parsePsRows(text) {
  const rows = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), etimes: Number(match[3]), args: match[4] });
  }
  return rows;
}

// `ss -tinpoH` prints one header line per socket, then an indented detail line.
function parseSsRows(text) {
  const lines = String(text || '').split(/\r?\n/);
  const rows = [];
  for (let index = 0; index < lines.length; index += 1) {
    const head = lines[index];
    if (!/users:\(\(/.test(head)) continue;
    const next = lines[index + 1] || '';
    const detail = /users:\(\(/.test(next) ? '' : next;
    const peer = head.trim().split(/\s+/)[3] || '';
    const split = peer.lastIndexOf(':');
    if (split <= 0) continue;
    const number = (key) => {
      const match = detail.match(new RegExp(`\\b${key}:(\\d+)`));
      return match ? Number(match[1]) : null;
    };
    rows.push({
      peerAddress: peer.slice(0, split).replace(/^\[|\]$/g, ''),
      peerPort: peer.slice(split + 1),
      pids: [...head.matchAll(/pid=(\d+)/g)].map((match) => Number(match[1])),
      bytesReceived: number('bytes_received'),
      // Server to client. A missing value means unknown, never zero.
      bytesAcked: number('bytes_acked'),
      lastrcvMs: number('lastrcv'),
    });
  }
  return rows;
}

// `ss -tlnpH` and `ss -xlpH` list listening TCP and unix sockets. An sshd
// session that owns one is serving a remote forward (`ssh -R`, to a port or a
// socket path) or agent forwarding, which is quiet by design and must be left
// alone.
function parseListenerPids(text) {
  const pids = new Set();
  for (const line of String(text || '').split(/\r?\n/)) {
    for (const match of line.matchAll(SSHD_OWNER)) pids.add(Number(match[1]));
  }
  return pids;
}

// `ss -tnpH state established` across all ports. A session's user sshd that
// owns an established socket whose local port is not 22 is the server end of
// a forwarded channel (`ssh -L` or `-D`) carrying a connection right now. Every
// owner pid on such a row is collected; the planner only ever looks up a
// session's own sshd pids. A row whose local port cannot be read is counted,
// because keeping a session is the safe side.
function parseChannelPids(text) {
  const pids = new Set();
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!/users:\(\(/.test(line)) continue;
    const local = line.trim().split(/\s+/)[2] || '';
    const split = local.lastIndexOf(':');
    if (split > 0 && local.slice(split + 1) === '22') continue;
    for (const match of line.matchAll(/pid=(\d+)/g)) pids.add(Number(match[1]));
  }
  return pids;
}

// One row per login, with every fact the plan and the pre-signal check use.
// `exempt` names why a session can never be closed, or is null.
function classifySessions({ processes = [], sockets = [], listenerPids = [], channelPids = [] } = {}) {
  const forwardPids = new Set(listenerPids);
  const openChannelPids = new Set(channelPids);
  const childrenOf = new Map();
  for (const row of processes) {
    if (!childrenOf.has(row.ppid)) childrenOf.set(row.ppid, []);
    childrenOf.get(row.ppid).push(row);
  }
  const listeners = new Set(
    processes.filter((row) => LISTENER_ARGS.test(row.args) && !MONITOR_ARGS.test(row.args)).map((row) => row.pid),
  );
  const socketByPid = new Map();
  for (const socket of sockets) {
    for (const pid of socket.pids || []) socketByPid.set(pid, socket);
  }
  const sessions = [];
  for (const monitor of processes) {
    if (!MONITOR_ARGS.test(monitor.args)) continue;
    // A monitor whose listener went away (an sshd restart re-parents it to
    // pid 1) is counted and kept, never closed.
    const orphaned = monitor.ppid === 1;
    if (!orphaned && !listeners.has(monitor.ppid)) continue;
    const children = childrenOf.get(monitor.pid) || [];
    const userProcesses = children.filter((row) => USER_ARGS.test(row.args));
    const grandchildren = children.flatMap((row) => childrenOf.get(row.pid) || []);
    // Command-less means exactly one child, a user process titled exactly
    // "<name>: <user>" with the monitor's own process name and user, and
    // nothing under it. Anything else counts as running a command: an "@"
    // title ("@notty", "@pts/N", "@internal-sftp" stay after the command's
    // process left the tree), a "[net]" or other pre-authentication child,
    // another user's name, and a login still being set up.
    const [, name, user] = monitor.args.match(MONITOR_PARTS);
    const plainTitle = `${name}: ${user}`;
    const hasCommand = !(children.length === 1 && children[0].args === plainTitle && grandchildren.length === 0);
    const socket = socketByPid.get(monitor.pid) || userProcesses.map((row) => socketByPid.get(row.pid)).find(Boolean) || null;
    const bytesReceived = socket && Number.isFinite(socket.bytesReceived) ? socket.bytesReceived : null;
    const bytesAcked = socket && Number.isFinite(socket.bytesAcked) ? socket.bytesAcked : null;
    const source = socket ? String(socket.peerAddress || '') : '';
    const peerPort = socket ? String(socket.peerPort || '') : '';
    const readable = Boolean(source) && Boolean(peerPort) && bytesReceived !== null && bytesAcked !== null;
    const ownsListener = forwardPids.has(monitor.pid) || userProcesses.some((row) => forwardPids.has(row.pid));
    const openChannel = openChannelPids.has(monitor.pid) || userProcesses.some((row) => openChannelPids.has(row.pid));
    let exempt = null;
    if (orphaned) exempt = 'orphaned';
    else if (hasCommand) exempt = 'command';
    else if (ownsListener) exempt = 'remoteForward';
    else if (openChannel) exempt = 'activeChannel';
    else if (!readable) exempt = 'unknownSocket';
    sessions.push({
      monitorPid: monitor.pid,
      // The pre-signal check requires the same parent and title.
      listenerPid: monitor.ppid,
      title: monitor.args,
      ageSeconds: Math.max(0, Number(monitor.etimes) || 0),
      source,
      peerPort,
      bytesReceived,
      bytesAcked,
      commandless: !hasCommand,
      // The burst history counts these, whatever else holds.
      tunnelShaped: !orphaned && !hasCommand,
      readable,
      exempt,
    });
  }
  return sessions;
}

// The identity a session keeps across runs: monitor pid, client port and
// address. A reused pid comes with a new client port. The digest is unsalted
// and lives only in the local state file; the receipt never carries it.
function sessionKey(session) {
  return crypto
    .createHash('sha256')
    .update(`${session.monitorPid}|${session.peerPort}|${session.source}`)
    .digest('hex')
    .slice(0, 16);
}

// The burst history groups starts by this digest of the client address. Like
// the session key it lives only in the local state file.
function sourceKey(source) {
  return crypto.createHash('sha256').update(`ssh-burst-source|${source}`).digest('hex').slice(0, 16);
}

// The most each direction may move over the interval: the leak's keepalive
// and nothing else.
function keepaliveBudget(elapsedSeconds, config) {
  return {
    received: (config.receivedBytesPerMinute * elapsedSeconds) / 60 + config.receivedSlackBytes,
    acked: (config.ackedBytesPerMinute * elapsedSeconds) / 60 + config.ackedSlackBytes,
  };
}

// The least a 60 second keepalive moves in each direction over the interval.
// The server to client floor is not positive for 100 seconds or less.
function keepaliveFloor(elapsedSeconds, config) {
  return {
    received: (config.receivedFloorBytesPerMinute * elapsedSeconds) / 60 - config.receivedFloorSlackBytes,
    acked: (config.ackedFloorBytesPerMinute * elapsedSeconds) / 60 - config.ackedFloorSlackBytes,
  };
}

// A stored observation is used only when every field is well formed and a
// quiet streak fits inside the session's own life: it cannot start before the
// session did, or hold more intervals than its span allows at one a minute.
function readPrior(entry, config) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const count = (value) => Number.isFinite(value) && value >= 0;
  const { bytesReceived, bytesAcked, observedAt, ageSeconds, quietStreak, quietSince, quietSinceAge } = entry;
  if (!count(bytesReceived) || !count(bytesAcked) || !Number.isFinite(observedAt) || !count(ageSeconds)) return null;
  if (!Number.isInteger(quietStreak) || quietStreak < 0) return null;
  if (quietStreak === 0) return entry;
  if (!Number.isFinite(quietSince) || !count(quietSinceAge)) return null;
  const startedAt = observedAt - ageSeconds * 1000;
  if (quietSince > observedAt || quietSince < startedAt - config.clockToleranceSeconds * 1000) return null;
  if (quietSinceAge > ageSeconds) return null;
  if (quietStreak * config.minIntervalSeconds > ageSeconds - quietSinceAge) return null;
  return entry;
}

// Returns this run's state for one session and the record to keep for the
// next run (null for a session that is not recorded at all). "quiet" means
// every per-session check passed; burst membership is decided by the caller.
function observeSession(session, prior, nowMs, config) {
  if (NOT_RECORDED.has(session.exempt)) return { state: session.exempt, record: null };
  const record = {
    bytesReceived: session.bytesReceived,
    bytesAcked: session.bytesAcked,
    observedAt: nowMs,
    ageSeconds: session.ageSeconds,
    quietStreak: 0,
    // Wall time and the session's age when the current quiet streak began.
    quietSince: null,
    quietSinceAge: null,
  };
  if (session.exempt) return { state: session.exempt, record };
  const before = readPrior(prior, config);
  if (!before) return { state: 'notQuietYet', record };
  // The interval is measured by the session's own etimes delta. A wall-clock
  // delta that disagrees by more than the tolerance means a clock step or a
  // reused pid. A counter that went backwards is a different session behind
  // the same identity; a gap too short or too long says nothing about idleness,
  // and one too short for both keepalive floors to be positive cannot show it.
  const elapsedSeconds = session.ageSeconds - before.ageSeconds;
  const wallSeconds = (nowMs - before.observedAt) / 1000;
  const floor = keepaliveFloor(elapsedSeconds, config);
  const comparable =
    elapsedSeconds >= config.minIntervalSeconds &&
    elapsedSeconds <= config.maxIntervalSeconds &&
    floor.received > 0 &&
    floor.acked > 0 &&
    Math.abs(elapsedSeconds - wallSeconds) <= config.clockToleranceSeconds &&
    session.bytesReceived >= before.bytesReceived &&
    session.bytesAcked >= before.bytesAcked;
  if (!comparable) return { state: 'notQuietYet', record };
  const received = session.bytesReceived - before.bytesReceived;
  const acked = session.bytesAcked - before.bytesAcked;
  const budget = keepaliveBudget(elapsedSeconds, config);
  if (received > budget.received || acked > budget.acked) return { state: 'traffic', record };
  // Quiet means inside the band of each direction: the leak's keepalive and
  // nothing else. A tunnel that moved less either way is not the leak.
  if (received < floor.received || acked < floor.acked) return { state: 'silent', record };
  record.quietStreak = before.quietStreak + 1;
  const continuing = before.quietStreak > 0;
  record.quietSince = continuing ? before.quietSince : before.observedAt;
  record.quietSinceAge = continuing ? before.quietSinceAge : before.ageSeconds;
  const quietSeconds = session.ageSeconds - record.quietSinceAge;
  if (record.quietStreak < config.quietIntervalsToClose || quietSeconds < config.minQuietSeconds) {
    return { state: 'notQuietYet', record };
  }
  if (session.ageSeconds < config.minAgeSeconds) return { state: 'young', record };
  return { state: 'quiet', record };
}

// Reads the stored burst history into source digest -> (login key -> start
// time), keeping only well-formed starts that `accept` allows. A dropped
// start can only lower a burst count.
function readBurstHistory(stored, accept = () => true) {
  const history = new Map();
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return history;
  for (const [source, logins] of Object.entries(stored)) {
    if (!logins || typeof logins !== 'object' || Array.isArray(logins)) continue;
    const kept = new Map();
    for (const [key, startedAt] of Object.entries(logins)) {
      if (Number.isFinite(startedAt) && accept(startedAt)) kept.set(key, startedAt);
    }
    if (kept.size) history.set(source, kept);
  }
  return history;
}

// The planning view: starts older than the history window, or later than
// now, are dropped. A live login's own start is recorded again right after.
function currentBurstHistory(stored, nowMs, config) {
  const oldest = nowMs - config.burstHistorySeconds * 1000;
  const latest = nowMs + config.clockToleranceSeconds * 1000;
  return readBurstHistory(stored, (startedAt) => startedAt >= oldest && startedAt <= latest);
}

// Adds every live tunnel-shaped login the history does not hold yet, with the
// start this scan gives it. A login already recorded keeps its first start.
function recordStarts(history, sessions) {
  for (const session of sessions) {
    if (!session.tunnelShaped || !session.source || !session.peerPort) continue;
    const source = sourceKey(session.source);
    if (!history.has(source)) history.set(source, new Map());
    const logins = history.get(source);
    const key = sessionKey(session);
    if (!logins.has(key)) logins.set(key, session.startMs);
  }
  return history;
}

function serializeBurstHistory(history) {
  const out = {};
  for (const [source, logins] of history) out[source] = Object.fromEntries(logins);
  return out;
}

// Returns a function giving a session's burst count: recorded starts from its
// source within the window either side of its start, itself included once.
function burstCounter(history, config) {
  const window = config.burstWindowSeconds * 1000;
  const sorted = new Map();
  const firstAtLeast = (values, target) => {
    let low = 0;
    let high = values.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (values[middle] < target) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  return (session) => {
    const source = sourceKey(session.source);
    const logins = history.get(source);
    if (!logins) return 1;
    if (!sorted.has(source)) sorted.set(source, [...logins.values()].sort((left, right) => left - right));
    const starts = sorted.get(source);
    // Starts in [start - window, start + window].
    let count = firstAtLeast(starts, session.startMs + window + 1) - firstAtLeast(starts, session.startMs - window);
    const own = logins.get(sessionKey(session));
    if (own !== undefined && Math.abs(own - session.startMs) <= window) count -= 1;
    return count + 1;
  };
}

const oldestFirst = (left, right) => left.startMs - right.startMs || left.monitorPid - right.monitorPid;

// previous: the session observations the last run returned, or null.
// bursts: the burst history the last run returned, or null.
// now: this snapshot's time. Returns the targets for this run (reap), every
// matching session (the pre-signal recount needs them), the counts by reason,
// and the observations and burst history to store.
function planIdleSessionReap({ previous = null, bursts = null, now, options = {}, ...scans } = {}) {
  const config = { ...DEFAULTS, ...options };
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(nowMs)) throw new Error('planIdleSessionReap needs the snapshot time');
  const observed =
    previous && typeof previous === 'object' && !Array.isArray(previous) ? new Map(Object.entries(previous)) : new Map();
  const sessions = classifySessions(scans);
  for (const session of sessions) session.startMs = nowMs - session.ageSeconds * 1000;
  const history = recordStarts(currentBurstHistory(bursts, nowMs, config), sessions);
  const countBurst = burstCounter(history, config);
  const kept = Object.fromEntries(KEEP_REASONS.map((reason) => [reason, 0]));
  const observations = {};
  const matching = [];
  for (const session of sessions) {
    const key = session.readable ? sessionKey(session) : null;
    const { state, record } = observeSession(session, key ? observed.get(key) : null, nowMs, config);
    if (record && key) {
      observations[key] = record;
      session.quietStreak = record.quietStreak;
    }
    session.state = state;
    if (state === 'quiet') {
      session.burstCount = countBurst(session);
      session.state = session.burstCount >= config.minBurstStarts ? 'matching' : 'notBurst';
    }
    if (session.state === 'matching') matching.push(session);
    else kept[session.state] += 1;
  }
  const bySource = new Map();
  for (const session of matching) {
    if (!bySource.has(session.source)) bySource.set(session.source, []);
    bySource.get(session.source).push(session);
  }
  // A source at or under the floor has no targets; above it, every matching
  // login is a target.
  const targets = [];
  for (const group of bySource.values()) {
    if (group.length > config.sourceFloor) targets.push(...group);
    else kept.underFloor += group.length;
  }
  targets.sort(oldestFirst);
  const reap = targets.slice(0, Math.max(0, config.maxReapPerRun));
  return {
    reap,
    targets: targets.length,
    deferred: targets.length - reap.length,
    matching,
    kept,
    counts: summarizeFromSessions(sessions),
    observations,
    bursts: serializeBurstHistory(history),
  };
}

function summarizeFromSessions(sessions) {
  const perSource = new Map();
  for (const session of sessions) {
    if (!session.commandless || !session.source) continue;
    perSource.set(session.source, (perSource.get(session.source) || 0) + 1);
  }
  const commandless = sessions.filter((session) => session.commandless).length;
  return {
    sessions: sessions.length,
    commandless,
    withCommand: sessions.length - commandless,
    sources: new Set(sessions.map((session) => session.source).filter(Boolean)).size,
    maxCommandlessPerSource: Math.max(0, ...perSource.values()),
  };
}

function summarizeSshSessions(input = {}) {
  return summarizeFromSessions(classifySessions(input));
}

// Re-checks sessions the plan found matching against scans read right before
// the signal, by the same rules. A session stays only while it is still the
// same tunnel-shaped login (same pid, parent, title, client address and port)
// with no listener, no open channel and readable counters; its age grew by the
// wall-clock seconds since the planning snapshot (elapsedSeconds) within the
// clock tolerance and is at least the minimum; each byte counter grew by no
// more than its own direction's budget for that age delta and, once a minute
// or more has passed, by at least its own floor, so its quiet streak still holds;
// and it is still a burst member by the persisted burst history.
function revalidateTargets(targets = [], scans = {}, { elapsedSeconds, bursts = null, options = {} } = {}) {
  const config = { ...DEFAULTS, ...options };
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0) return [];
  // The plan already bounded this history to its window.
  const countBurst = burstCounter(readBurstHistory(bursts), config);
  const current = new Map(classifySessions(scans).map((session) => [session.monitorPid, session]));
  return targets.filter((target) => {
    const now = current.get(target.monitorPid);
    if (!now || now.exempt !== null || !now.tunnelShaped) return false;
    if (now.listenerPid !== target.listenerPid || now.title !== target.title) return false;
    if (now.source !== target.source || now.peerPort !== target.peerPort) return false;
    if (now.ageSeconds < config.minAgeSeconds || !Number.isFinite(target.startMs)) return false;
    const aged = now.ageSeconds - target.ageSeconds;
    if (aged < 0 || Math.abs(aged - elapsedSeconds) > config.clockToleranceSeconds) return false;
    const budget = keepaliveBudget(aged, config);
    // Under a minute a keepalive need not show, so only the budgets apply.
    const floors = keepaliveFloor(aged, config);
    const floor = (value) => (aged >= 60 ? Math.max(0, value) : 0);
    const received = now.bytesReceived - target.bytesReceived;
    const acked = now.bytesAcked - target.bytesAcked;
    const inBand =
      received >= floor(floors.received) &&
      acked >= floor(floors.acked) &&
      received <= budget.received &&
      acked <= budget.acked;
    if (!inBand) return false;
    // The start this fresh scan gives the login: the planning snapshot plus
    // the wall-clock seconds since, less its fresh age.
    const startMs = target.startMs + (elapsedSeconds - aged) * 1000;
    return countBurst({ ...now, startMs }) >= config.minBurstStarts;
  });
}

// Before each batch: re-checks every session the plan found matching against
// the fresh scan, and keeps a target only while it still matches and its
// source still has more than the floor, counting the sessions that still
// match plus those this same run already closed. Sessions that exited on
// their own or started moving traffic since the plan lower that count, so the
// floor can only protect more, never less.
function confirmTargets(batch = [], matching = [], scans = {}, { elapsedSeconds, bursts = null, closed = [], options = {} } = {}) {
  const config = { ...DEFAULTS, ...options };
  const still = revalidateTargets(matching, scans, { elapsedSeconds, bursts, options });
  const confirmed = new Set(still.map((session) => session.monitorPid));
  const perSource = new Map();
  for (const session of [...closed, ...still]) {
    if (!perSource.has(session.source)) perSource.set(session.source, new Set());
    perSource.get(session.source).add(session.monitorPid);
  }
  return batch.filter((target) => {
    const count = perSource.has(target.source) ? perSource.get(target.source).size : 0;
    return confirmed.has(target.monitorPid) && count > config.sourceFloor;
  });
}

// After a signal: the targets whose monitor is still the same process. A pid
// that exited, became a zombie, was reused, or was re-parented is gone.
function stillOpen(targets = [], processes = []) {
  const byPid = new Map(processes.map((row) => [row.pid, row]));
  return targets.filter((target) => {
    const row = byPid.get(target.monitorPid);
    return (
      Boolean(row) &&
      MONITOR_ARGS.test(row.args) &&
      row.ppid === target.listenerPid &&
      Number(row.etimes) >= Number(target.ageSeconds)
    );
  });
}

module.exports = {
  DEFAULTS,
  KEEP_REASONS,
  parsePsRows,
  parseSsRows,
  parseListenerPids,
  parseChannelPids,
  classifySessions,
  sessionKey,
  sourceKey,
  planIdleSessionReap,
  revalidateTargets,
  confirmTargets,
  stillOpen,
  summarizeSshSessions,
};
