// scripts/lib/brain-switch.js
//
// ONE durable switch that decides which subscription brain leads every Amy
// lane: `claude` or `codex`. ExampleCo, 2026-09-03: "make it a switch to flip, then
// flip it - claude first now. That switch needs to flip automatically as soon
// as the default model runs out of tokens."
//
// Two layers, one file:
//   preferred  the owner's choice. Defaults to `claude` in source (that default
//              IS the flip ExampleCo asked for, so a deploy carries it to every host).
//              `node scripts/brain-switch.js set codex` changes it durably.
//   demoted    runtime health. When the leading brain reports a usage limit or
//              an auth failure, it is demoted for a cooldown and the OTHER brain
//              leads until the cooldown passes or the demoted brain answers
//              again. Transient blips need TRANSIENT_STRIKES in a row first, so
//              one timeout never flips the switch.
//
// Readers: scripts/lib/ask-ai.js (text ladder), scripts/lib/skill-runner-ladder.js
// (midnight skills), scripts/overnight-watcher-launcher.js and
// scripts/lib/heal-executor.js (overnight agentic sessions), and
// scripts/agentic-healer-driver.js (card repair tactics). Writers: the same
// lanes, through recordBrainFailure / recordBrainSuccess.
//
// The failure classifier is shared with the voice lane router so "out of
// tokens" means the same strings everywhere. The voice lane keeps its own
// per-lane health file and Codex-first order (latency-measured choice).
//
// State file: <dataDir>/agent/brain-switch.json (runtime artifact, never
// git-tracked). dataDir is the HOST-WIDE runtime data dir, the same rule the
// briefing switch uses: SECONDBRAIN_DATA_DIR, else %APPDATA%/secondbrain/data
// on Windows, else /opt/secondbrain/data. Never the module's own checkout, so
// every worktree, the packaged app, and the runtime clone on one host read
// ONE switch (Codex review 2026-09-03). SB_BRAIN_SWITCH_FILE overrides the
// whole path (tests, attended one-offs). Every transition is also appended to
// <same dir>/brain-switch-transitions.jsonl, an append-only receipt ledger
// that outlives the 50-entry history kept inside the state file.
//
// Host contract (Codex review 2026-09-03): runtime health is PER HOST. The
// desktop and EC2 each learn about exhaustion from their own first failed
// call and flip on their own; nothing propagates automatically between hosts.
// Only the owner's preferred brain is mirrored, and only when the operator
// passes --publish-ec2, which copies this host's whole state file over the
// remote one (remote demotions included). The source default needs no file.
//
// Writers take a directory lock (mkdir is atomic on every platform) so the
// scheduled fleet's concurrent tasks cannot lose each other's strikes,
// demotions, or recoveries in a read-modify-write race.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { classifyLaneFailure } = require('./voice-lane-router.js');

// One host, one switch: identical to briefing-api-fallback-switch's rule.
function defaultDataDir(env = process.env, platform = process.platform) {
  if (env.SECONDBRAIN_DATA_DIR) return path.resolve(env.SECONDBRAIN_DATA_DIR);
  if (platform === 'win32' && env.APPDATA) return path.join(env.APPDATA, 'secondbrain', 'data');
  if (platform !== 'win32') return '/opt/secondbrain/data';
  return path.join(os.homedir(), '.secondbrain', 'data');
}
const SCHEMA = 'amy.brain-switch.v1';
const BRAINS = Object.freeze(['claude', 'codex']);
// ExampleCo 2026-09-03: Claude leads, Codex is the fallback. Changing this line is
// an owner decision; the drift lint pins it.
const DEFAULT_PREFERRED = 'claude';
const TRANSIENT_STRIKES = 3;
const HISTORY_MAX = 50;
const LOCK_WAIT_MS = 3000;
const LOCK_STALE_MS = 5000;

function isBrain(value) {
  return BRAINS.includes(value);
}

function otherBrain(brain) {
  return brain === 'claude' ? 'codex' : 'claude';
}

// Rung and executor names used across the lanes map onto exactly one brain.
function brainOfRung(name) {
  const value = String(name || '').toLowerCase();
  if (!value) return null;
  if (value === 'codex' || value.startsWith('codex')) return 'codex';
  if (value === 'claude' || value.startsWith('claude')) return 'claude';
  return null;
}

function switchPath(opts = {}) {
  if (opts.switchPath) return opts.switchPath;
  const env = opts.env || process.env;
  if (env.SB_BRAIN_SWITCH_FILE) return env.SB_BRAIN_SWITCH_FILE;
  const dataDir = opts.dataDir || defaultDataDir(env, opts.platform);
  return path.join(dataDir, 'agent', 'brain-switch.json');
}

function transitionsPath(opts = {}) {
  const file = switchPath(opts);
  return path.join(path.dirname(file), path.basename(file).replace(/\.json$/, '') + '-transitions.jsonl');
}

// Returns { ok, file, error }. The ledger is a receipt, never a gate: a
// failed append must not block a flip, but the caller can see and surface it.
function appendTransition(entry, opts = {}) {
  const file = transitionsPath(opts);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
    return { ok: true, file, error: null };
  } catch (err) {
    return { ok: false, file, error: String(err && err.message).slice(0, 200) };
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Serialize read-modify-write across processes. A stale lock (a writer that
// died mid-update) is reclaimed after LOCK_STALE_MS so nothing wedges.
function withStateLock(opts, fn) {
  const file = switchPath(opts);
  const lockDir = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      break;
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;
      let stale = false;
      try {
        stale = Date.now() - fs.statSync(lockDir).mtimeMs > LOCK_STALE_MS;
      } catch {
        continue;
      }
      if (stale) {
        try {
          fs.rmdirSync(lockDir);
        } catch {}
        continue;
      }
      if (Date.now() > deadline) throw new Error(`brain-switch lock busy: ${lockDir}`);
      sleepSync(15);
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.rmdirSync(lockDir);
    } catch {}
  }
}

function emptyState() {
  return {
    schema: SCHEMA,
    preferred: DEFAULT_PREFERRED,
    preferredSetBy: 'source-default',
    preferredSetAt: null,
    demoted: {},
    strikes: {},
    history: [],
  };
}

function readState(opts = {}) {
  const file = switchPath(opts);
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    parsed = null;
  }
  const state = emptyState();
  if (!parsed || typeof parsed !== 'object') return state;
  if (isBrain(parsed.preferred)) {
    state.preferred = parsed.preferred;
    state.preferredSetBy = String(parsed.preferredSetBy || 'unknown');
    state.preferredSetAt = parsed.preferredSetAt || null;
  }
  if (parsed.demoted && typeof parsed.demoted === 'object') {
    for (const brain of BRAINS) {
      const d = parsed.demoted[brain];
      if (d && typeof d === 'object' && Number.isFinite(Date.parse(d.until))) {
        state.demoted[brain] = {
          kind: String(d.kind || 'transient'),
          since: d.since || null,
          until: new Date(Date.parse(d.until)).toISOString(),
          source: d.source || null,
          sample: typeof d.sample === 'string' ? d.sample : '',
        };
      }
    }
  }
  if (parsed.strikes && typeof parsed.strikes === 'object') {
    for (const brain of BRAINS) {
      const n = Number(parsed.strikes[brain]);
      if (Number.isInteger(n) && n > 0) state.strikes[brain] = n;
    }
  }
  if (Array.isArray(parsed.history)) state.history = parsed.history.slice(-HISTORY_MAX);
  if (parsed.lastReceiptError && typeof parsed.lastReceiptError === 'object') {
    state.lastReceiptError = parsed.lastReceiptError;
  }
  return state;
}

function writeState(state, opts = {}) {
  const file = switchPath(opts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const payload = { ...state, updatedAt: new Date(nowMs(opts)).toISOString() };
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

function nowMs(opts = {}) {
  const n = opts.now instanceof Date ? opts.now.getTime() : Number(opts.now);
  return Number.isFinite(n) ? n : Date.now();
}

function activeDemotion(state, brain, now) {
  const d = state.demoted[brain];
  if (!d) return null;
  return Date.parse(d.until) > now ? d : null;
}

// FIX 4 (2026-09-23, token-tracking-fixes): a provider's own rollout corpus
// can go dark (no weekly rate-limit percentage emitted in any scanned file)
// while this switch still holds proof the provider is out of weekly quota --
// the usage-limit failure that produced the demotion IS that proof. Token
// reporting (scripts/cloud-morning-briefing.js's token_usage card,
// scripts/lib/token-spend-weekly.js's weekly meter) reads this instead of
// rendering an honest but uninformative blocked/blank state when a `kind:
// 'quota'` demotion is still active.
function activeQuotaDemotion(provider, opts = {}) {
  if (!isBrain(provider)) return null;
  const now = nowMs(opts);
  const state = readState(opts);
  const demotion = activeDemotion(state, provider, now);
  return demotion && demotion.kind === 'quota' ? demotion : null;
}

function pushHistory(state, entry) {
  state.history.push(entry);
  if (state.history.length > HISTORY_MAX) state.history = state.history.slice(-HISTORY_MAX);
  return entry;
}

// Commit semantics (Codex review 2026-09-03): the state file is the source
// of truth and persists FIRST; the transition receipt is appended only after
// the state is durable, and its result is returned so a caller can see a
// flip that happened without its receipt instead of assuming one.
function commit(state, entry, opts = {}) {
  persist(state, opts);
  const receipt = appendTransition(entry, opts);
  if (!receipt.ok) {
    // Durable, visible channel for a lost receipt: the state file itself
    // carries the last receipt error so `status` and System Health can show
    // it even though the ledger append failed (Codex deploy gate 2026-09-03).
    state.lastReceiptError = {
      ts: new Date(nowMs(opts)).toISOString(),
      event: entry.event,
      error: receipt.error,
      file: receipt.file,
    };
    try {
      persist(state, opts);
    } catch {
      /* the first persist already succeeded; nothing more to do */
    }
  }
  return receipt;
}

// The one decision every lane asks: who leads right now?
function resolveLeadingBrain(opts = {}) {
  const now = nowMs(opts);
  const state = opts.state || readState(opts);
  const preferred = state.preferred;
  const alt = otherBrain(preferred);
  const preferredDemotion = activeDemotion(state, preferred, now);
  const altDemotion = activeDemotion(state, alt, now);
  if (preferredDemotion && !altDemotion) {
    return {
      leading: alt,
      preferred,
      flipped: true,
      reason: `${preferred} demoted (${preferredDemotion.kind}) until ${preferredDemotion.until}`,
      demotion: preferredDemotion,
    };
  }
  return {
    leading: preferred,
    preferred,
    flipped: false,
    reason: preferredDemotion
      ? 'both brains demoted; preferred leads and the ladder fails honestly'
      : 'preferred',
    demotion: null,
  };
}

// [leading, other], the order every two-brain lane iterates.
function brainOrder(opts = {}) {
  const { leading } = resolveLeadingBrain(opts);
  return [leading, otherBrain(leading)];
}

function combinedFailureText(failure) {
  if (failure && typeof failure === 'object') {
    return [failure.message, failure.stderr, failure.text, failure.stdout]
      .filter((v) => typeof v === 'string' && v.trim())
      .join(' | ');
  }
  return String(failure || '');
}

function sampleText(failure) {
  const text =
    failure && typeof failure === 'object'
      ? [failure.message, failure.stderr, failure.text, failure.stdout]
          .filter((v) => typeof v === 'string' && v.trim())
          .join(' | ')
      : String(failure || '');
  return text.replace(/\s+/g, ' ').trim().slice(0, 240);
}

// Automatic writers are silent under vitest unless a test points the switch
// at its own file. Every lane's existing tests exercise real failure paths;
// without this, a test run would demote a brain in the dev box's live switch.
function automaticWritesAllowed(opts = {}) {
  const env = opts.env || process.env;
  if (!process.env.VITEST) return true;
  return Boolean(opts.switchPath || env.SB_BRAIN_SWITCH_FILE || process.env.SB_BRAIN_SWITCH_FILE);
}

// A lane reports that `brain` failed. Quota and auth demote at once; transient
// failures demote only after TRANSIENT_STRIKES in a row. Returns what changed.
function recordBrainFailure(brain, failure, opts = {}) {
  if (!isBrain(brain)) return { brain, kind: null, demoted: false, flipped: false, leading: null };
  if (!automaticWritesAllowed(opts)) {
    return { brain, kind: null, demoted: false, flipped: false, leading: null, skipped: 'test-isolation' };
  }
  // Bookkeeping never breaks an answer path: a busy lock or an unwritable
  // state file is returned as `error` (and receipted where possible), never
  // thrown into the lane that called us (Codex deploy gate 2026-09-03).
  try {
    return withStateLock(opts, () => recordBrainFailureLocked(brain, failure, opts));
  } catch (err) {
    return failSoft(brain, err, opts, { kind: null, demoted: false, flipped: false });
  }
}

function failSoft(brain, err, opts, shape) {
  const error = String((err && err.message) || err).slice(0, 200);
  appendTransition(
    { ts: new Date(nowMs(opts)).toISOString(), event: 'bookkeeping-error', brain, error },
    opts,
  );
  let leading = null;
  try {
    leading = resolveLeadingBrain(opts).leading;
  } catch {
    leading = DEFAULT_PREFERRED;
  }
  return { brain, ...shape, leading, error };
}

function recordBrainFailureLocked(brain, failure, opts) {
  const now = nowMs(opts);
  const state = readState(opts);
  const before = resolveLeadingBrain({ ...opts, state, now }).leading;
  // Classify the combined text of every field (message, stderr, stdout,
  // text). A quota string that only appears in stdout, next to a generic
  // parser reason in message, must still demote at once (Codex review).
  const sample = sampleText(failure);
  const verdict = classifyLaneFailure(combinedFailureText(failure));
  let demoted = false;
  if (verdict.kind === 'transient') {
    state.strikes[brain] = (state.strikes[brain] || 0) + 1;
    if (state.strikes[brain] >= TRANSIENT_STRIKES) demoted = true;
  } else {
    demoted = true;
  }
  let until = null;
  if (demoted) {
    until = new Date(now + verdict.retryAfterMs).toISOString();
    const providerReset = Date.parse(opts.unavailableUntil || '');
    if (verdict.kind === 'quota' && Number.isFinite(providerReset) && providerReset > now) {
      until = new Date(providerReset).toISOString();
    }
    const existing = activeDemotion(state, brain, now);
    // Never shorten a demotion already in force; extend it if the new
    // evidence says the outage lasts longer.
    if (existing && Date.parse(existing.until) > Date.parse(until)) until = existing.until;
    state.demoted[brain] = {
      kind: verdict.kind,
      since: existing ? existing.since : new Date(now).toISOString(),
      until,
      source: opts.source || null,
      sample,
    };
    state.strikes[brain] = 0;
  }
  const after = resolveLeadingBrain({ ...opts, state, now }).leading;
  const flipped = before !== after;
  const entry = pushHistory(state, {
    ts: new Date(now).toISOString(),
    event: demoted ? 'demoted' : 'strike',
    brain,
    kind: verdict.kind,
    strikes: demoted ? 0 : state.strikes[brain],
    until,
    leading: after,
    flipped,
    source: opts.source || null,
    sample,
  });
  const receipt = commit(state, entry, { ...opts, now });
  return { brain, kind: verdict.kind, demoted, until, flipped, leading: after, receipt };
}

// A lane reports that `brain` answered. Clears its demotion and strikes, so a
// recovered brain leads again immediately instead of waiting out the cooldown.
function recordBrainSuccess(brain, opts = {}) {
  if (!isBrain(brain)) return { brain, changed: false, flipped: false, leading: null };
  if (!automaticWritesAllowed(opts)) {
    return { brain, changed: false, flipped: false, leading: null, skipped: 'test-isolation' };
  }
  try {
    return withStateLock(opts, () => recordBrainSuccessLocked(brain, opts));
  } catch (err) {
    return failSoft(brain, err, opts, { changed: false, flipped: false });
  }
}

function recordBrainSuccessLocked(brain, opts) {
  const now = nowMs(opts);
  const state = readState(opts);
  const hadDemotion = Boolean(state.demoted[brain]);
  const hadStrikes = Boolean(state.strikes[brain]);
  if (!hadDemotion && !hadStrikes) {
    return {
      brain,
      changed: false,
      flipped: false,
      leading: resolveLeadingBrain({ ...opts, state, now }).leading,
    };
  }
  const before = resolveLeadingBrain({ ...opts, state, now }).leading;
  delete state.demoted[brain];
  delete state.strikes[brain];
  const after = resolveLeadingBrain({ ...opts, state, now }).leading;
  const flipped = before !== after;
  const entry = pushHistory(state, {
    ts: new Date(now).toISOString(),
    event: 'recovered',
    brain,
    leading: after,
    flipped,
    source: opts.source || null,
  });
  const receipt = commit(state, entry, { ...opts, now });
  return { brain, changed: true, flipped, leading: after, receipt };
}

// Owner flip. `by` names who asked (ExampleCo, PRIVATE_NAME, or the session that ran it).
function setPreferredBrain(brain, opts = {}) {
  if (!isBrain(brain))
    throw new Error(`unknown brain "${brain}"; expected one of ${BRAINS.join(', ')}`);
  return withStateLock(opts, () => setPreferredBrainLocked(brain, opts));
}

function setPreferredBrainLocked(brain, opts) {
  const now = nowMs(opts);
  const state = readState(opts);
  const previous = state.preferred;
  state.preferred = brain;
  state.preferredSetBy = String(opts.by || 'operator');
  state.preferredSetAt = new Date(now).toISOString();
  // "Flip it" means lead now. An owner flip clears the chosen brain's own
  // demotion and strikes atomically; the next real exhaustion re-demotes it.
  const clearedDemotion = state.demoted[brain] ? { ...state.demoted[brain] } : null;
  delete state.demoted[brain];
  delete state.strikes[brain];
  const entry = pushHistory(state, {
    ts: state.preferredSetAt,
    event: 'preferred',
    brain,
    previous,
    by: state.preferredSetBy,
    clearedDemotion,
    leading: resolveLeadingBrain({ ...opts, state, now }).leading,
  });
  const receipt = commit(state, entry, { ...opts, now });
  const file = switchPath(opts);
  return {
    file,
    preferred: brain,
    previous,
    leading: resolveLeadingBrain({ ...opts, state, now }).leading,
    receipt,
  };
}

// Owner reset of runtime health only; the preferred brain is untouched.
function clearDemotions(opts = {}) {
  return withStateLock(opts, () => {
    const now = nowMs(opts);
    const state = readState(opts);
    const cleared = Object.keys(state.demoted);
    state.demoted = {};
    state.strikes = {};
    const entry = pushHistory(state, {
      ts: new Date(now).toISOString(),
      event: 'cleared',
      cleared,
      by: String(opts.by || 'operator'),
      leading: state.preferred,
    });
    const receipt = commit(state, entry, { ...opts, now });
    return { cleared, leading: state.preferred, receipt };
  });
}

// The operator CLI records every remote publication attempt here so a failed
// or skipped mirror is visible next to the flips it was meant to carry.
function recordPublication(entry, opts = {}) {
  return appendTransition(
    { ts: new Date(nowMs(opts)).toISOString(), event: 'published', ...entry },
    opts,
  );
}

// writeState with a receipt on failure, so a lane that swallows the throw
// still leaves evidence in the transitions ledger.
function persist(state, opts = {}) {
  try {
    return writeState(state, opts);
  } catch (err) {
    appendTransition(
      {
        ts: new Date(nowMs(opts)).toISOString(),
        event: 'persist-error',
        error: String(err && err.message).slice(0, 200),
        file: switchPath(opts),
      },
      opts,
    );
    throw err;
  }
}

function statusReport(opts = {}) {
  const now = nowMs(opts);
  const state = readState(opts);
  const decision = resolveLeadingBrain({ ...opts, state, now });
  return {
    file: switchPath(opts),
    preferred: state.preferred,
    preferredSetBy: state.preferredSetBy,
    preferredSetAt: state.preferredSetAt,
    leading: decision.leading,
    flipped: decision.flipped,
    reason: decision.reason,
    order: [decision.leading, otherBrain(decision.leading)],
    demoted: Object.fromEntries(
      BRAINS.filter((b) => activeDemotion(state, b, now)).map((b) => [b, state.demoted[b]]),
    ),
    strikes: state.strikes,
    lastReceiptError: state.lastReceiptError || null,
    history: state.history.slice(-10),
  };
}

module.exports = {
  BRAINS,
  DEFAULT_PREFERRED,
  TRANSIENT_STRIKES,
  SCHEMA,
  activeQuotaDemotion,
  brainOfRung,
  brainOrder,
  clearDemotions,
  defaultDataDir,
  transitionsPath,
  withStateLock,
  isBrain,
  otherBrain,
  readState,
  recordPublication,
  recordBrainFailure,
  recordBrainSuccess,
  resolveLeadingBrain,
  setPreferredBrain,
  statusReport,
  switchPath,
};
