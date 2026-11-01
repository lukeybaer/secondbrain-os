// Test isolation: every test file gets its own throwaway runtime-state directory.
//
// Why (Oct 23 audit M3): production modules keep ledgers, locks and indexes under
// the repo's data/agent (or %APPDATA%\secondbrain), and `SECONDBRAIN_ROOT` on the
// owner's box points at the SHARED checkout. A test that did not pass its own dir
// wrote into the real tree. forbid-writes-outside-tmp.mjs now blocks that; this file
// gives those default paths somewhere safe to land instead of failing the test.
//
// What it sets, per test file, under one mkdtemp dir in the OS temp dir:
//   AMY_TEST_STATE_DIR  the stand-in for <repo>/data. A few modules with hard-coded
//                       `<repo>/data/agent/...` defaults consult it inline, and only
//                       when no explicit dir or SECONDBRAIN_DATA_DIR was given.
//                       Production never sets it.
//   APPDATA             <dir>/appdata, so %APPDATA%\secondbrain\... defaults land in
//                       the sandbox (only when the platform defines APPDATA at all).
//   AMY_EC2_WORKER_TMP_ROOT  the spine worker's per-task TMPDIR root, which otherwise
//                       defaults to ~/.cache/secondbrain-spine-worker-tmp (kept as a
//                       path suffix because a test pins that name).
//   AMY_TEST_REAL_APPDATA  the APPDATA the run started with, for the few tests that
//                       compare against a process the OS launched outside the sandbox.
//   PYTHONUSERBASE      pinned to the real <APPDATA>\Python when APPDATA moves: Python
//                       finds its user site-packages (Pillow, for the thumbnail gates)
//                       through APPDATA, so a redirected APPDATA made `py` lose them.
// Deliberately NOT redirected: SECONDBRAIN_ROOT, SECONDBRAIN_DATA_DIR, HOME and
// USERPROFILE. Tests assert on those, and the write guard covers the rest.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'amy-test-state-'));
fs.mkdirSync(path.join(sandbox, 'agent'), { recursive: true });
process.env.AMY_TEST_STATE_DIR = sandbox;
if (!process.env.AMY_EC2_WORKER_TMP_ROOT) {
  process.env.AMY_EC2_WORKER_TMP_ROOT = path.join(sandbox, '.cache', 'secondbrain-spine-worker-tmp');
}
if (process.env.APPDATA) {
  process.env.AMY_TEST_REAL_APPDATA = process.env.APPDATA;
  if (!process.env.PYTHONUSERBASE) process.env.PYTHONUSERBASE = path.join(process.env.APPDATA, 'Python');
  process.env.APPDATA = path.join(sandbox, 'appdata');
  fs.mkdirSync(process.env.APPDATA, { recursive: true });
}

afterAll(() => {
  try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* best effort; it is under temp */ }
});
