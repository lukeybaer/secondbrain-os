'use strict';

// ONE content-freshness validator for AWS cost data. Three consumers:
//   1. scripts/lib/briefing-card-artifacts.js   (per-card producer + reuse gate)
//   2. scripts/lib/briefing-source-contracts.js (evidence facts)
//   3. scripts/cloud-morning-briefing.js        (5:30 full build)
//
// 2026-07-20 (ExampleCo, live briefing): AWS COSTS shipped a "Card refresh pending"
// shell stamped CLEAN, and the dated artifact behind it was a lie. Freshness
// was decided in three places by three different rules, all of them keyed on a
// FILENAME. agent/aws-costs-2026-07-20.md ExampleCod the window 2026-04-10 to
// 2026-05-10, byte-identical to aws-costs-2026-05-10.md, and every check
// passed it because the name said today.
//
// A filename is not freshness. Only the window declared INSIDE the artifact
// decides whether a number is current.

const fs = require('fs');
const path = require('path');

// Dialect B, written by materializeEc2AwsCostsArtifact
// (cloud-morning-briefing.js:7714): "Window: <start> through <end> (live ...)".
// The optional "Cost " prefix is the card-body line the builder now emits, so
// the raw artifact and the rendered card parse through one regex.
const WINDOW_THROUGH_RE =
  /^(?:Cost\s+)?Window:\s*(\d{4}-\d{2}-\d{2})\s+through\s+(\d{4}-\d{2}-\d{2})\b/im;

// Dialect A, written by aws-cost-section.js renderDetailMarkdown:
// "# AWS COST DETAIL <U+2014> <start> to <end>". The separator is a real em
// dash, which this repo forbids in source, so match a short non-digit run
// instead of the character.
const DETAIL_HEADER_RE =
  /^#?\s*AWS COST DETAIL\D{0,6}(\d{4}-\d{2}-\d{2})\s+to\s+(\d{4}-\d{2}-\d{2})\s*$/im;

// Single source for the bootstrap-shell literal. Previously duplicated verbatim
// in two places, so one wording change defeated both gates at once.
// Deliberately loose: match the stable phrase, not the full sentence, so a
// reworded shell cannot launder itself through.
const AWS_PENDING_SHELL_RE = /card refresh pending/i;

// 0 = window ends today. 1 = window ends yesterday, the freshest Cost Explorer
// can be for a settled day. Do not widen.
const AWS_COST_MAX_STALE_DAYS = 1;

// Derived from the VERBATIM body of /opt/secondbrain/data/agent/aws-costs-2026-07-19.md
// and from buildAwsCostsCard's own push order, NOT from a description of them.
// Two traps this encodes:
//   - the real breakdown headings are "Per AWS account (the receipts):" and
//     "Per app / cost center (service-name attribution):", both INDENTED, so
//     the patterns must tolerate leading whitespace and a trailing suffix.
//   - there is no "Top services" line anywhere in a real artifact or card. The
//     builder emits "Top cost drivers:". Requiring "Top services" would have
//     marked every genuinely healthy card defective. "Top services" stays as an
//     accepted alternate only so a future rename does not silently fail closed.
const AWS_COST_REQUIRED_SECTIONS = [
  ['Per AWS account', /^\s*Per AWS account/im],
  ['Per app', /^\s*Per app/im],
  ['Top cost drivers', /^\s*Top (?:cost drivers|services)/im],
  ['Threshold band', /^Threshold band:/im],
];

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

// ISO SHAPE IS NOT A VALID DATE. Codex review 9eddbc4f3d2b caught this module
// failing OPEN on "2026-13-40": it matched ISO_DAY, Date.parse returned NaN,
// staleDays became NaN, and `NaN > AWS_COST_MAX_STALE_DAYS` is false, so the
// artifact was reported CURRENT. A validator whose whole purpose is to fail
// closed must never let an unparseable value read as fresh. Round-tripping
// through toISOString also rejects rollovers like 2026-02-31, which Date.parse
// silently accepts as March 3.
function isValidIsoDay(value) {
  const s = String(value || '');
  if (!ISO_DAY.test(s)) return false;
  const ms = Date.parse(`${s}T00:00:00Z`);
  if (!Number.isFinite(ms)) return false;
  return new Date(ms).toISOString().slice(0, 10) === s;
}

function parseAwsCostWindow(text) {
  const body = String(text || '');
  const claim = (() => {
    const live = body.match(WINDOW_THROUGH_RE);
    if (live) return { start: live[1], end: live[2], dialect: 'ec2-live' };
    const pc = body.match(DETAIL_HEADER_RE);
    if (pc) return { start: pc[1], end: pc[2], dialect: 'pc-detail' };
    return null;
  })();
  if (!claim) return null;
  // A window that does not parse, or runs backwards, is a corrupt artifact.
  // Returning null routes it to the "declares no cost window" block, which is
  // the honest outcome: we cannot prove its age.
  if (!isValidIsoDay(claim.start) || !isValidIsoDay(claim.end)) return null;
  if (claim.start > claim.end) return null;
  return claim;
}

function daysBetween(laterIso, earlierIso) {
  return Math.round(
    (Date.parse(`${laterIso}T00:00:00Z`) - Date.parse(`${earlierIso}T00:00:00Z`)) / 86400000,
  );
}

// The one freshness verdict. Pure function of (text, date). Never reads a
// filename, never stats a file, never consults mtime.
function awsCostFreshness({ text, date }) {
  const body = String(text || '');
  const asOf = isValidIsoDay(date) ? String(date) : null;
  const base = {
    window: null,
    windowStart: null,
    windowEnd: null,
    dialect: null,
    staleDays: null,
    current: false,
    priorDay: false,
    reason: '',
  };
  if (!asOf) return { ...base, reason: 'briefing date is missing or not ISO YYYY-MM-DD' };
  if (!body.trim()) return { ...base, reason: 'artifact is empty' };
  if (AWS_PENDING_SHELL_RE.test(body)) {
    return { ...base, reason: 'artifact is the pending refresh shell, not cost data' };
  }
  const window = parseAwsCostWindow(body);
  if (!window) {
    return {
      ...base,
      reason:
        'artifact declares no cost window (neither a "Window: <start> through <end>" line nor an ' +
        '"AWS COST DETAIL <start> to <end>" header), so its age cannot be proven',
    };
  }
  const staleDays = daysBetween(asOf, window.end);
  const out = {
    ...base,
    window,
    windowStart: window.start,
    windowEnd: window.end,
    dialect: window.dialect,
    staleDays,
  };
  // Belt and braces after the fail-open above: never let a non-finite value
  // reach the comparison, because `NaN > n` is false and would read as fresh.
  if (!Number.isFinite(staleDays)) {
    return { ...out, staleDays: null, reason: 'artifact window dates could not be compared' };
  }
  // Bounded in BOTH directions. A future-dated window is a corrupt or
  // fabricated artifact, not a fresh one.
  if (staleDays < 0) {
    return {
      ...out,
      reason: `artifact window ends ${window.end}, in the future relative to ${asOf}`,
    };
  }
  if (staleDays > AWS_COST_MAX_STALE_DAYS) {
    return {
      ...out,
      reason: `artifact window ends ${window.end}, ${staleDays} days behind ${asOf}`,
    };
  }
  return { ...out, current: true, priorDay: staleDays === AWS_COST_MAX_STALE_DAYS, reason: '' };
}

// Full publish contract: freshness plus the structure the dashboard drilldown
// and verify-dashboard-cards-live both assume. Returns [] when publishable.
// `requireSections` is false for raw producer artifacts (which carry a window
// and services but no breakdown block) and true for anything about to be
// stamped clean onto the board.
function awsCostContractFailures({ text, date, requireSections = true, snapshotDate = null }) {
  const body = String(text || '');
  const failures = [];
  const fresh = awsCostFreshness({ text: body, date });
  if (!fresh.current) failures.push(`AWS cost snapshot is not current: ${fresh.reason}.`);
  if (
    !/^Total:\s*\$[\d,.]+/im.test(body) &&
    !/^Verified accessible AWS spend:\s*\$[\d,.]+/im.test(body)
  ) {
    // Anchored. A loose /\$\s?\d/ passed "GROCERIES: milk $4.19".
    failures.push('AWS cost artifact ExampleCos no anchored total line.');
  }
  const snapshot =
    snapshotDate || (body.match(/^Snapshot:\s*(\d{4}-\d{2}-\d{2})/im) || [])[1] || null;
  if (snapshot && snapshot !== date) {
    failures.push(`AWS cost snapshot line says ${snapshot}, not ${date}.`);
  }
  if (requireSections) {
    for (const [label, re] of AWS_COST_REQUIRED_SECTIONS) {
      if (!re.test(body)) failures.push(`AWS detail missing section: ${label}.`);
    }
  }
  return { failures, freshness: fresh };
}

// Positive contract for the reuse gate. Defaults to "not self sufficient" on
// every ExampleCo, so the failure mode is a rebuild, never a laundered publish.
// The predicate this replaced was negative ("needs rebuild?") and defaulted to
// reuse, which is why a reworded shell carrying an unrelated "$15.05" reached
// the board clean.
function awsCostArtifactIsSelfSufficient(artifact, date) {
  const markdown = String((artifact && artifact.markdown) || '');
  return (
    awsCostContractFailures({ text: markdown, date, requireSections: true }).failures.length === 0
  );
}

// File-level entry point for the source contract, which has no card object.
function readAwsCostArtifactFreshness({ dataDir, date, file }) {
  const target = file || path.join(dataDir, 'agent', `aws-costs-${date}.md`);
  let text = '';
  let exists = false;
  let bytes = 0;
  try {
    text = fs.readFileSync(target, 'utf8');
    exists = true;
    bytes = Buffer.byteLength(text);
  } catch {
    // Missing is an honest source condition.
  }
  const fresh = awsCostFreshness({ text, date });
  return {
    file: target,
    exists,
    bytes,
    dialect: fresh.dialect,
    windowStart: fresh.windowStart,
    windowEnd: fresh.windowEnd,
    staleDays: fresh.staleDays,
    current: fresh.current,
    priorDay: fresh.priorDay,
    reason: fresh.reason,
  };
}

module.exports = {
  AWS_COST_MAX_STALE_DAYS,
  AWS_COST_REQUIRED_SECTIONS,
  AWS_PENDING_SHELL_RE,
  awsCostArtifactIsSelfSufficient,
  awsCostContractFailures,
  awsCostFreshness,
  parseAwsCostWindow,
  readAwsCostArtifactFreshness,
};
