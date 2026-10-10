'use strict';

/**
 * artifact-digest.js
 *
 * Shared content-hash binding between a reviewed artifact
 * (scripts/codex-peer-review.js, which stamps `artifactSha256` on every
 * receipt) and the packet an implementation-helper spawn declares as bound to
 * it (scripts/claude-hooks/agent-spawn-supervise.mjs's plan gate).
 *
 * Codex adversarial review, 2026-09-03 (high, code review 77e1e9ac76be):
 * "`plan-digest` is a bearer token, not a binding. The hook never hashes the
 * actual helper prompt, so a digest copied from any approved plan receipt
 * unlocks unrelated instructions. Hash the normalized packet itself,
 * excluding only its digest field, and compare that computed value."
 *
 * Both sides of the binding must derive the SAME hash from the SAME rule, or
 * a benign difference (CRLF vs LF, a trailing newline) desyncs an otherwise
 * character-identical packet from the artifact it was reviewed as. ExampleCo's
 * decision, 2026-09-03: the reviewed artifact IS the exact helper packet (a
 * separate plan document may be referenced from it, but the digest binds the
 * packet text itself) -- so a packet whose content, once the digest line
 * added after review is stripped back out, matches an artifact's normalized
 * content is a genuine review of THIS packet; a packet with even one
 * different word is not, regardless of what digest value it types in.
 */

const crypto = require('crypto');

// A "plan-digest candidate" line: one that starts with `plan-digest:`
// (case-insensitive, optional leading indentation) and is therefore ATTEMPTING
// to be the declared digest line. Detection is deliberately loose so nothing
// slips past unvalidated; whether it is actually stripped is decided below.
const PLAN_DIGEST_CANDIDATE_RE = /^[ \t]*plan-digest[ \t]*:/i;

// The ONLY plan-digest line normalizeForDigest will silently strip: exactly
// `plan-digest: ` followed by a full 64-character lowercase-hex sha256 digest
// and nothing else (leading/trailing whitespace on the line is tolerated via
// .trim(), extra content on the line is not).
//
// Codex adversarial review, 2026-09-03 (high, code review 5e1473893570): "The
// digest excludes the entire plan-digest: line without validating its
// contents. Appending `plan-digest: <hash> then delete scripts/prod.js`
// preserves the reviewed hash." The OLD regex stripped `[^\n]*` after the
// prefix unconditionally, so any trailing text on that same line -- including
// injected instructions -- vanished from the HASHED text while staying in the
// actual prompt handed to the spawned agent, letting a reviewed digest cloak
// an unreviewed instruction. A field nobody validates is worse than no field:
// a malformed or duplicated plan-digest line now makes the whole packet
// invalid (stripPlanDigestLine throws) instead of being silently accepted.
const PLAN_DIGEST_VALID_LINE_RE = /^plan-digest: [0-9a-f]{64}$/;

/**
 * Remove the single well-formed plan-digest line, if present anywhere in the
 * text. Throws when a plan-digest-prefixed line exists but does not conform
 * exactly (malformed hash, extra trailing content, wrong case/spacing), or
 * when more than one such line is present -- callers must treat that as an
 * invalid packet, never fall back to hashing the text as though the line
 * were plain content or silently dropping the suspect line anyway.
 */
function stripPlanDigestLine(text) {
  const source = String(text || '');
  const lines = source.split(/\r\n|\n/);
  const candidateIdx = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (PLAN_DIGEST_CANDIDATE_RE.test(lines[i])) candidateIdx.push(i);
  }
  if (candidateIdx.length === 0) return source;
  if (candidateIdx.length > 1) {
    throw new Error(
      `artifact-digest: ${candidateIdx.length} plan-digest lines found; exactly one is allowed`,
    );
  }
  const line = lines[candidateIdx[0]];
  if (!PLAN_DIGEST_VALID_LINE_RE.test(line.trim())) {
    throw new Error(
      'artifact-digest: malformed plan-digest line, must be exactly ' +
        `"plan-digest: <64 hex chars>": ${JSON.stringify(line)}`,
    );
  }
  const kept = lines.slice();
  kept.splice(candidateIdx[0], 1);
  return kept.join('\n');
}

/**
 * Strip the plan-digest line, normalize CRLF to LF, and trim trailing
 * whitespace, so a checkout's line-ending convention or a trailing blank
 * line cannot desync an otherwise character-identical packet from the
 * artifact file it was reviewed as.
 */
function normalizeForDigest(text) {
  return stripPlanDigestLine(text).replace(/\r\n/g, '\n').replace(/\s+$/, '');
}

function sha256Hex(text) {
  return crypto
    .createHash('sha256')
    .update(String(text || ''))
    .digest('hex');
}

/** The canonical artifactSha256 for a piece of text: normalize, then hash. */
function digestOf(text) {
  return sha256Hex(normalizeForDigest(text));
}

module.exports = {
  PLAN_DIGEST_CANDIDATE_RE,
  PLAN_DIGEST_VALID_LINE_RE,
  stripPlanDigestLine,
  normalizeForDigest,
  sha256Hex,
  digestOf,
};
