'use strict';
//
// test-fixture-guard.js -- Phase 3 of the session-isolation plan.
//
// The suite must be reproducible in a CLEAN checkout. Today a fresh worktree
// shows ~32 false failures because many tests read un-versioned runtime data
// dirs (data/agent/*, data/briefings/*, etc.) that only exist in the lived-in
// main checkout. A data-dependent test should SKIP WITH A REASON in a clean
// checkout, not false-fail, so the gate (and CI) can be trusted.
//
// Usage in a data-dependent test:
//   import { describe, it } from 'vitest';
//   const { skipUnlessData } = require('../lib/test-fixture-guard.js');
//   const SKIP = skipUnlessData('data/agent');
//   it.skipIf(SKIP)('reads the live ledger', () => { ... });
//
// This is the MECHANISM. Per-test adoption is incremental (the 32 are mostly
// foreign tests); each owner wraps their data read with skipUnlessData or
// provides a fixture. The meta-test below locks the helper's behavior.

const fs = require('fs');
const path = require('path');

// A data dir "counts" only if it exists and is non-empty.
function dataDirAvailable(dir, root) {
  const full = root ? path.join(root, dir) : dir;
  try {
    return fs.existsSync(full) && fs.readdirSync(full).length > 0;
  } catch {
    return false;
  }
}

// vitest skip predicate: true => skip this test (no data present).
function skipUnlessData(dir, root) {
  return !dataDirAvailable(dir, root);
}

module.exports = { dataDirAvailable, skipUnlessData };
