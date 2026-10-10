'use strict';

// Proof belongs in evidence. It cannot substitute for the owner-visible miss
// and the causal mechanism in the answer to "What went wrong".
const PROOF_AS_ROOT_RE =
  /\b(?:root cause|what went wrong|failed because|was caused by|problem (?:is|was))\b[^.!?]{0,180}\b(?:successful terminal proof|green proof|valid [^.?!]{0,80}receipt|(?:missing|absent|no) [^.?!]{0,80}receipt|(?:missing|stale) heartbeat|agent (?:assertion|status)|agent (?:did not|didn't|failed to) prove)\b/i;

function ownerRootCauseUsesProofJargon(value) {
  return PROOF_AS_ROOT_RE.test(String(value || '').replace(/\s+/g, ' ').trim());
}

module.exports = { ownerRootCauseUsesProofJargon, PROOF_AS_ROOT_RE };
