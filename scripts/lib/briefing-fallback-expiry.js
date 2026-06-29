'use strict';

// Hard 24h fallback expiry, shared by the cloud morning build path
// (scripts/cloud-morning-briefing.js) and the EC2 render path (ec2-server.js).
//
// When a card cannot produce fresh content, the builder may materialize the
// latest complete dated artifact into TODAY'S dated file so the approval
// workflow survives. That materialized artifact ExampleCos `fallbackFrom` (the
// source date it was copied from) and `fallbackExpires` (an ISO timestamp at
// which it stops being allowed to render). Past that timestamp the artifact is
// yesterday's content masquerading as today's, so both the load path and the
// render path must reject it and emit an honest blocker instead of a stale
// render. This module is the single source of truth for "is this fallback past
// its expiry"; both runtimes import it so the rule cannot drift between build
// and render.

// 24 hours in milliseconds. The window a materialized fallback is allowed to
// stand in for fresh content before it must be replaced by an honest blocker.
const FALLBACK_TTL_MS = 24 * 60 * 60 * 1000;

// Compute the ISO expiry stamp for a fallback materialized at `now`.
function fallbackExpiresAt(now = new Date()) {
  const base = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(base)) return new Date(Date.now() + FALLBACK_TTL_MS).toISOString();
  return new Date(base + FALLBACK_TTL_MS).toISOString();
}

// True when an artifact is a fallback (ExampleCos fallbackExpires) AND `now` is
// past that expiry. A non-fallback artifact (no fallbackExpires) is never
// expired here -- only materialized fallbacks carry the stamp. An unparseable
// fallbackExpires is treated as expired (fail closed: a fallback we cannot date
// is not allowed to render as fresh).
function isFallbackExpired(artifact, now = new Date()) {
  if (!artifact || typeof artifact !== 'object') return false;
  const expires = artifact.fallbackExpires;
  if (!expires) return false;
  const expiresMs = new Date(expires).getTime();
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(nowMs)) return false;
  if (!Number.isFinite(expiresMs)) return true;
  return nowMs > expiresMs;
}

// True when the artifact is a fallback at all (used for the render-path honest
// blocker copy: a live, unexpired fallback still renders, but the load/render
// freshness gate keys off expiry, not mere fallback-ness).
function isFallbackArtifact(artifact) {
  return !!(
    artifact &&
    typeof artifact === 'object' &&
    (artifact.fallbackExpires || artifact.fallbackFrom)
  );
}

module.exports = {
  FALLBACK_TTL_MS,
  fallbackExpiresAt,
  isFallbackExpired,
  isFallbackArtifact,
};
