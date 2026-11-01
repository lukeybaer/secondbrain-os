'use strict';

// Canonical Tier-1 MEMORY.md byte cap, shared by every call site so the
// numbers can never drift apart again (2026-08-02: the guard said 22500,
// the push-time test said 23000, Gravity g7 said 24576):
//   - scripts/claude-hooks/memory-md-size-guard.mjs (PreToolUse block)
//   - scripts/__tests__/memory-md-size.test.js (push-time enforcement)
//   - scripts/lib/gravity-health.js (Gravity g7 verdict)
//
// Measuring convention: LF-normalized UTF-8 bytes (CRLF collapsed to LF
// before sizing), so the cap means the same thing on LF and CRLF checkouts.
// The SessionStart loader truncates around 24400 bytes on disk; 22500 LF
// bytes leaves ~1900 bytes of headroom even after CRLF expansion (~1 byte
// per line on a ~200-line file).

const MEMORY_MD_CAP_BYTES = 22500;

function lfByteLength(str) {
  return Buffer.byteLength((str || '').replace(/\r\n/g, '\n'), 'utf8');
}

module.exports = { MEMORY_MD_CAP_BYTES, lfByteLength };
