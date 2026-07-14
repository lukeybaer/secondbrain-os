'use strict';

// scripts/lib/collector-degrade.js
//
// The three-state degrade contract for external environmental collectors
// (report breakpoint 7, Perspective A). Every collector that reaches out to an
// external system (AWS Budgets, claude.ai behind Cloudflare, etc.) classifies a
// failure into exactly ONE of three terminal states, so a STRUCTURAL
// provisioning fault is never mistaken for a transient blip the code-writing
// self-healer can retry:
//
//   OK           the fetch succeeded.
//   TRANSIENT    a retryable blip (network timeout, 5xx, connection reset, 429).
//                Safe to retry now and safe to hand to the reactive healer.
//   PROVISIONING a STRUCTURAL fault (IAM AccessDenied, auth-shape 401/403 bot
//                challenge, missing config/credentials). No amount of code retry
//                clears it; it needs a NAMED HUMAN OWNER to provision a
//                capability. It fails loud and is EXCLUDED from the healer.
//
// This is the durable fix for the two wrong terminal states the report found:
//   - the Cloudflare 403 "Just a moment" bot-challenge was a repairable "blocked"
//     card the healer grabbed daily and could never clear. Now it is
//     PROVISIONING with healer_excluded=true.
//   - the Bedrock IAM AccessDenied was silently filtered and tolerated forever.
//     Now it is PROVISIONING and fails loud with an owner + remediation.

const fs = require('fs');
const path = require('path');

const OK = 'ok';
const TRANSIENT = 'transient';
const PROVISIONING = 'provisioning';

// Signatures that are STRUCTURAL: no code retry ever clears them. Checked FIRST,
// so a 403 that is also a bot-challenge grades structural rather than a blip.
const PROVISIONING_SIGNATURES = [
  { re: /AccessDenied|not authorized to perform|UnauthorizedOperation/i, kind: 'iam-access-denied' },
  { re: /Just a moment|cf-mitigated|attention required|__cf_chl|cloudflare/i, kind: 'cloudflare-bot-challenge' },
  { re: /invalid authentication|authentication_error|credentials not found|run claude \/login|token .{0,20}missing/i, kind: 'missing-credentials' },
  { re: /HTTP 40[13]\b|\b40[13] Forbidden|Unauthorized\b/i, kind: 'auth-shape-40x' },
  { re: /could not resolve AWS account|missing config|not configured|no such budget/i, kind: 'missing-config' },
];

// Signatures that are TRANSIENT: retrying later may clear them.
const TRANSIENT_SIGNATURES = [
  { re: /ETIMEDOUT|ESOCKETTIMEDOUT|timed out|\btimeout\b/i, kind: 'timeout' },
  { re: /ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|socket hang up|network/i, kind: 'network' },
  { re: /HTTP 5\d\d\b|\b50[234]\b|Bad Gateway|Service Unavailable|Gateway Timeout/i, kind: 'server-5xx' },
  { re: /rate.?limit|too many requests|HTTP 429\b/i, kind: 'rate-limit' },
];

// Classify a failure's error text into { state, kind }. Empty/absent text is OK.
function classify(errorText) {
  const text = String(errorText == null ? '' : errorText);
  if (!text.trim()) return { state: OK, kind: null };
  for (const sig of PROVISIONING_SIGNATURES) {
    if (sig.re.test(text)) return { state: PROVISIONING, kind: sig.kind };
  }
  for (const sig of TRANSIENT_SIGNATURES) {
    if (sig.re.test(text)) return { state: TRANSIENT, kind: sig.kind };
  }
  // PRIVATE_NAME failure defaults to TRANSIENT (retryable) so an unclassified blip is
  // not permanently parked as a human-owner provisioning fault. A genuinely
  // structural fault ExampleCos one of the signatures above.
  return { state: TRANSIENT, kind: 'unclassified' };
}

// Build the durable degrade block a collector writes into its artifact so every
// downstream consumer (the card, the healer, the status check) reads ONE
// contract. owner = the named human who can provision the capability;
// remediation = the exact checked-in fix to run; healer_excluded = true for
// PROVISIONING so the code-writing reactive healer never grabs a fault it cannot
// clear. observedAt is injectable so tests are deterministic.
function degradeBlock(opts = {}) {
  const c = classify(opts.errorText);
  const provisioning = c.state === PROVISIONING;
  return {
    degrade_state: c.state,
    degrade_kind: c.kind || null,
    healer_excluded: provisioning,
    owner: provisioning ? (opts.owner || 'ExampleCo') : null,
    remediation: provisioning ? (opts.remediation || null) : null,
    source: opts.source || null,
    reason: String(opts.errorText == null ? '' : opts.errorText).slice(0, 240),
    observed_at: opts.observedAt || new Date().toISOString(),
  };
}

// True when a degrade block (or raw state string) must be kept away from the
// code-writing reactive healer. The healer can only edit code; a provisioning
// fault needs a human to ExampleCo a capability, so handing it over just thrashes.
function isHealerExcluded(degradeOrState) {
  if (!degradeOrState) return false;
  if (typeof degradeOrState === 'string') return degradeOrState === PROVISIONING;
  if (typeof degradeOrState.healer_excluded === 'boolean') return degradeOrState.healer_excluded;
  return degradeOrState.degrade_state === PROVISIONING;
}

// Map a main artifact path to its degrade sidecar path (foo.json -> foo.degrade.json).
// If the path does not end in .json, APPEND the suffix rather than no-op, so the
// sidecar path can never collide with (and overwrite) the main artifact.
function sidecarPathFor(mainArtifactPath) {
  const p = String(mainArtifactPath);
  return /\.json$/i.test(p) ? p.replace(/\.json$/i, '.degrade.json') : `${p}.degrade.json`;
}

// Write an ADDITIVE degrade sidecar next to a collector's main artifact. The main
// artifact is NEVER touched, so any last-good value the card renders is preserved.
// Returns { block, sidecar } (sidecar=null if the write failed, never throws).
function writeSidecar(mainArtifactPath, opts = {}) {
  const block = degradeBlock(opts);
  try {
    const sidecar = sidecarPathFor(mainArtifactPath);
    fs.mkdirSync(path.dirname(sidecar), { recursive: true });
    fs.writeFileSync(sidecar, JSON.stringify(block, null, 2));
    return { block, sidecar };
  } catch (w) {
    return { block, sidecar: null, error: w && w.message };
  }
}

// Remove a stale degrade sidecar on a clean read so a resolved fault does not
// linger. Best-effort: never throws.
function clearSidecar(mainArtifactPath) {
  try {
    fs.rmSync(sidecarPathFor(mainArtifactPath), { force: true });
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  classify,
  degradeBlock,
  isHealerExcluded,
  sidecarPathFor,
  writeSidecar,
  clearSidecar,
  OK,
  TRANSIENT,
  PROVISIONING,
};
