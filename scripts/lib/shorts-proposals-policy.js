// scripts/lib/shorts-proposals-policy.js
//
// One tracked switch for the Examplechannel shorts research producer
// (scripts/morning-shorts-proposals.js) and its cloud fleet entry.
// ExampleCo 2026-09-07 (#otter): "Pause the shorts research, but I like the
// clipping one." The viral-clip proposal producer is untouched by this file.
//
// Read by BOTH callers of the producer: the cloud scheduled fleet (which
// marks the entry disabled so a missing run is not graded red) and the
// producer itself (because the briefing card controller also invokes it
// directly through the shorts source contract). A paused producer writes an
// honest dated wall artifact and makes zero network or model calls.
//
// Missing or unreadable policy means ACTIVE: a lost config file must not
// silently switch off a producer ExampleCo scheduled; only an explicit
// state:"paused" pauses it. SHORTS_PROPOSALS_POLICY_FILE overrides the path
// (tests, attended one-offs).
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_POLICY_FILE = path.join(__dirname, '..', '..', 'config', 'shorts-proposals-policy.json');

function policyFile(env = process.env) {
  return env.SHORTS_PROPOSALS_POLICY_FILE
    ? path.resolve(env.SHORTS_PROPOSALS_POLICY_FILE)
    : DEFAULT_POLICY_FILE;
}

function readShortsProposalsPolicy({ file, env = process.env } = {}) {
  const target = file ? path.resolve(file) : policyFile(env);
  // A MISSING file means active: older releases never shipped one, and a lost
  // config must not silently switch off a producer ExampleCo scheduled. A file that
  // EXISTS but cannot be read or parsed fails closed to paused (Codex review
  // 0e31d06d3516, 2026-09-07): a damaged deployment must not resume research
  // the owner paused; it stays paused, loudly, until a valid file lands.
  if (!fs.existsSync(target)) {
    return { state: 'active', paused: false, reason: '', pausedBy: '', pausedAt: '', file: target, source: 'missing' };
  }
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (error) {
    const reason = `policy file ${target} exists but is unreadable or malformed (${String((error && error.message) || error)}); failing closed to paused`;
    console.warn(`[shorts-proposals-policy] ${reason}`);
    return { state: 'paused', paused: true, reason, pausedBy: 'fail-closed', pausedAt: '', file: target, source: 'invalid' };
  }
  const state = String((raw && raw.state) || 'active').trim().toLowerCase();
  const paused = state === 'paused';
  return {
    state: paused ? 'paused' : 'active',
    paused,
    reason: String((raw && raw.reason) || '').trim(),
    pausedBy: String((raw && raw.paused_by) || '').trim(),
    pausedAt: String((raw && raw.paused_at) || '').trim(),
    file: target,
    source: 'policy-file',
  };
}

// The wall text the producer writes while paused. Starts with a stable
// prefix so the card, the validator, and a reader can all recognize an
// owner pause as distinct from a source outage or an LLM outage.
function pausedWall(policy) {
  const who = policy.pausedBy || 'the owner';
  const when = policy.pausedAt ? ` on ${policy.pausedAt}` : '';
  const why = policy.reason ? ` (${policy.reason})` : '';
  return `paused-by-owner: shorts research paused by ${who}${when}${why}; no proposals were researched today and no model was called`;
}

module.exports = { DEFAULT_POLICY_FILE, policyFile, readShortsProposalsPolicy, pausedWall };
