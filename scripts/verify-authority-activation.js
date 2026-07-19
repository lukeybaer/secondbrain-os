#!/usr/bin/env node
/**
 * verify-authority-activation.js
 *
 * DORMANT-AUTHORITY drift lint: built-but-dormant switches must fail loudly.
 *
 * WHY (2026-07-19): the card-controller authority marker
 * (data/agent/briefing-card-controller-authority, runtime file, 1 = controller,
 * 0/missing = legacy) sat at legacy-0 for WEEKS while dev-plans/core/briefing.md
 * described controller authority as the design. Nothing red-lined the gap, so
 * the designed operating mode silently never ran. This lint closes the class:
 * when a core design doc claims a runtime authority switch, the switch must
 * actually be active on the runtime that ExampleCos the marker, or the lint says
 * so out loud.
 *
 * BEHAVIOR (calibrated so it cannot fail every fresh clone):
 *   - The design-claim match is CATEGORY-SHAPED: the doc claims the switch
 *     whenever its invariants/body name the marker FILENAME anywhere, never one
 *     literal sentence.
 *   - The runtime marker is read from the resolved data dir
 *     (SECONDBRAIN_DATA_DIR, else repo data/). Marker == active value: GREEN.
 *   - Marker 0 or missing while the doc claims authority: WARN by default
 *     (dev machines lack runtime state). RED only when:
 *       * SB_AUTHORITY_LINT_STRICT=1 (set on EC2, where the data dir is the
 *         real runtime and dormancy is a live defect), OR
 *       * data/agent/authority-activation-grace.json declares an activation
 *         date older than its grace window (default 7 days) -- i.e. the switch
 *         was declared activated, the grace period passed, and the runtime
 *         still reads legacy.
 *   - No data dir at all (fresh clone): WARN, never fail.
 *
 * Wired as `npm run verify:authority-activation` and appended to the
 * `verify:core-drift` chain. Exit 0 = green/warn, 1 = red.
 *
 * Category-shaped registry: AUTHORITY_SWITCHES lists every doc-claimed runtime
 * authority switch; the next dormant switch is one entry here, not a new lint.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_GRACE_DAYS = 7;

const AUTHORITY_SWITCHES = [
  {
    id: 'briefing-card-controller',
    designDoc: path.join('dev-plans', 'core', 'briefing.md'),
    markerName: 'briefing-card-controller-authority',
    markerRelPath: path.join('agent', 'briefing-card-controller-authority'),
    graceRelPath: path.join('agent', 'authority-activation-grace.json'),
    activeValue: '1',
    activateHint: 'scripts/install-ec2-card-controller-cron.sh --activate',
  },
];

function readFileSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function resolveDataDir(repoRoot, env) {
  const e = env || process.env;
  const fromEnv = e.SECONDBRAIN_DATA_DIR;
  if (fromEnv && String(fromEnv).trim()) return path.resolve(String(fromEnv).trim());
  return path.join(repoRoot, 'data');
}

// Category-shaped design-claim detection: the doc claims the switch whenever it
// names the marker filename anywhere (invariants or body). Never pinned to one
// literal sentence, so a doc rewrite that still names the marker still claims.
function docClaimsAuthority(docText, markerName) {
  if (!docText) return false;
  const esc = markerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${esc}\\b`).test(docText);
}

// Grace file: { "activatedAt": "2026-07-10", "graceDays": 7, ... }. Accepts a
// few date field spellings; returns null when unreadable or dateless.
function readGrace(graceFile) {
  const raw = readFileSafe(graceFile);
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const dateRaw = parsed.activatedAt || parsed.activationDate || parsed.activatedOn || parsed.date;
  const activatedAtMs = dateRaw ? Date.parse(String(dateRaw)) : NaN;
  if (!Number.isFinite(activatedAtMs)) return null;
  const graceDays =
    Number.isFinite(parsed.graceDays) && parsed.graceDays > 0
      ? parsed.graceDays
      : DEFAULT_GRACE_DAYS;
  return { activatedAtMs, graceDays, dateRaw: String(dateRaw) };
}

// Evaluate ONE switch. Pure given { repoRoot, dataDir, env, nowMs }, so the
// regression test can drive fixtures without touching the real clock or env.
function evaluateSwitch(sw, opts = {}) {
  const repoRoot = opts.repoRoot || REPO_ROOT;
  const env = opts.env || process.env;
  const nowMs = typeof opts.nowMs === 'number' ? opts.nowMs : Date.now();
  const dataDir = opts.dataDir || resolveDataDir(repoRoot, env);

  const docText = readFileSafe(path.join(repoRoot, sw.designDoc));
  if (!docText) {
    return {
      id: sw.id,
      level: 'warn',
      reason: `design doc ${sw.designDoc} is missing/unreadable; cannot check the authority claim (core-registry lint owns doc presence)`,
    };
  }
  if (!docClaimsAuthority(docText, sw.markerName)) {
    return {
      id: sw.id,
      level: 'green',
      reason: `${sw.designDoc} makes no ${sw.markerName} authority claim; nothing to verify`,
    };
  }

  if (!fs.existsSync(dataDir)) {
    return {
      id: sw.id,
      level: 'warn',
      reason: `doc claims ${sw.markerName} authority but no runtime data dir exists at ${dataDir} (fresh clone / dev machine); cannot verify activation`,
    };
  }

  const markerPath = path.join(dataDir, sw.markerRelPath);
  const markerPresent = fs.existsSync(markerPath);
  const markerValue = markerPresent ? readFileSafe(markerPath).replace(/\s+/g, '') : null;
  if (markerPresent && markerValue === sw.activeValue) {
    return {
      id: sw.id,
      level: 'green',
      reason: `runtime marker ${sw.markerRelPath} reads ${sw.activeValue} (active); design and runtime agree`,
    };
  }

  const dormancy = markerPresent ? `reads ${markerValue || '<empty>'} (legacy)` : 'is MISSING';
  const strict = String(env.SB_AUTHORITY_LINT_STRICT || '') === '1';
  const grace = readGrace(path.join(dataDir, sw.graceRelPath));
  const staleGrace = grace ? nowMs - grace.activatedAtMs > grace.graceDays * 86400000 : false;

  if (strict) {
    return {
      id: sw.id,
      level: 'red',
      reason: `DORMANT AUTHORITY (strict): ${sw.designDoc} claims ${sw.markerName} authority but runtime marker ${sw.markerRelPath} ${dormancy}. Activate it (${sw.activateHint}) or fix the design doc.`,
    };
  }
  if (staleGrace) {
    return {
      id: sw.id,
      level: 'red',
      reason: `DORMANT AUTHORITY (stale grace): activation was declared ${grace.dateRaw} (grace ${grace.graceDays} days, now expired) but runtime marker ${sw.markerRelPath} still ${dormancy}. Activate it (${sw.activateHint}) or retract the grace declaration.`,
    };
  }
  const graceNote = grace
    ? ` (grace declared ${grace.dateRaw}, still inside its ${grace.graceDays}-day window)`
    : '';
  return {
    id: sw.id,
    level: 'warn',
    reason: `doc claims ${sw.markerName} authority but runtime marker ${sw.markerRelPath} ${dormancy}${graceNote}. On the runtime host set SB_AUTHORITY_LINT_STRICT=1 so this is RED, or activate: ${sw.activateHint}`,
  };
}

function runAuthorityActivationLint(opts = {}) {
  const results = AUTHORITY_SWITCHES.map((sw) => evaluateSwitch(sw, opts));
  return { ok: !results.some((r) => r.level === 'red'), results };
}

function main() {
  const { ok, results } = runAuthorityActivationLint();
  for (const r of results) {
    const tag = r.level === 'green' ? 'PASS' : r.level.toUpperCase();
    const stream = r.level === 'red' ? console.error : console.log;
    stream(`authority-activation ${tag} [${r.id}]: ${r.reason}`);
  }
  process.exit(ok ? 0 : 1);
}

module.exports = {
  AUTHORITY_SWITCHES,
  DEFAULT_GRACE_DAYS,
  resolveDataDir,
  docClaimsAuthority,
  readGrace,
  evaluateSwitch,
  runAuthorityActivationLint,
};

if (require.main === module) main();
