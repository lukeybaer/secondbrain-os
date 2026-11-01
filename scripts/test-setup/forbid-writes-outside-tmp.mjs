// Test guard: a test may write only under the OS temp dir.
//
// Why (Oct 23 audit M3): a full-suite run in the shared checkout left 1,644 real
// transcript copies and speaker-key-index.json untracked in data/otter, because a
// test with a temp dataDir still hit a module default pointing at the repo's own
// data/. Tests that touch real runtime state also make results depend on the box.
//
// How: this setup file wraps the in-process fs write APIs (sync, callback and
// promises) before any test module loads. A write whose target resolves outside
// the temp dirs and outside ALLOWED_OUTSIDE_TMP is recorded, and in the default
// "enforce" mode it is also BLOCKED (EACCES), so the shared tree is never polluted
// and a catch-and-ignore around the write cannot hide the leak. The test file then
// fails in afterAll with the list of offending paths.
//
// TEST_WRITE_GUARD_LOG=<file> logs every offender as a JSON line (in either mode),
// and TEST_WRITE_GUARD=record also lets the write through, for surveying a suite.
// Limits: child processes a test spawns are not covered; reads are never checked.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
import { afterAll, expect } from 'vitest';

const STATE_KEY = Symbol.for('amy.testWriteGuard');
const MODE = process.env.TEST_WRITE_GUARD === 'record' ? 'record' : 'enforce';
const NULL_DEVICES = new Set(['nul', '/dev/null', '\\\\.\\nul']);
const state = globalThis[STATE_KEY] || (globalThis[STATE_KEY] = { patched: false, violations: [] });
// The unpatched functions the guard itself uses. appendFileSync is built on the
// patched writeFileSync, so logging through the patched export would re-enter the
// guard and recurse whenever the log path is outside the allowed roots (the first
// recording run produced 450k self-inflicted rows this way).
if (!state.real) state.real = { appendFileSync: fs.appendFileSync, existsSync: fs.existsSync, statSync: fs.statSync };

// Captured once: a test that stubs process.platform to 'linux' (several do, to
// exercise the EC2 branch) must not change how the guard folds case, or its own
// temp dir stops matching the lower-cased roots below.
const IS_WINDOWS = state.isWindows ?? (state.isWindows = process.platform === 'win32');

function normalize(target) {
  // `\\?\C:\...` and `\\.\C:\...` are the same file as `C:\...` (long-path prefix).
  const resolved = path.resolve(String(target)).replace(/\\/g, '/').replace(/^\/\/[?.]\//, '');
  return IS_WINDOWS ? resolved.toLowerCase() : resolved;
}

function realOrSelf(dir) {
  try { return fs.realpathSync.native(dir); } catch { return dir; }
}

// Roots come from the pristine process (vitest.config.ts passes os.tmpdir() in
// TEST_WRITE_GUARD_TMP_ROOTS) plus stable platform defaults, so a test that
// repoints TEMP or spies os.tmpdir() cannot move the boundary under the guard.
function pristineRoots() {
  try { return JSON.parse(process.env.TEST_WRITE_GUARD_TMP_ROOTS || '[]'); } catch { return []; }
}
const TMP_ROOTS = state.tmpRoots || (state.tmpRoots = [...new Set([
  os.tmpdir(), realOrSelf(os.tmpdir()), ...pristineRoots(), ...pristineRoots().map(realOrSelf),
  process.env.TEMP, process.env.TMP, process.env.TMPDIR, '/tmp', '/var/tmp',
  process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}/Temp` : null,
  process.platform === 'win32' ? 'C:/Windows/Temp' : null,
].filter(Boolean).map(normalize))]);

function repoTmpPattern() {
  const root = normalize(path.join(process.cwd(), '.tmp')).replace(/[.*+?^${}()|[\]\\]/g, '$&');
  // The dir itself too: tests mkdir it, which the repo exclusion below would
  // otherwise block wherever it does not exist yet (a fresh EC2 source copy).
  return new RegExp(`^${root}(/|$)`);
}

// Writes a test may make outside temp. Keep this empty or tiny: every entry needs a
// reason and a regex over the lower-cased, forward-slash absolute path.
export const ALLOWED_OUTSIDE_TMP = [
  { pattern: /\/node_modules\/\.vite(st)?\//, reason: 'vite/vitest transform and result caches' },
  // <repo>/.tmp is the project's gitignored scratch dir (.gitignore:66); a few
  // tests build their fake APPDATA there on purpose.
  { pattern: repoTmpPattern(), reason: 'gitignored repo-local scratch dir' },
];

// The repo this guard ships in. The EC2 test-category runner copies the source
// tree under /tmp, which made every repo path pass as a temp path (#b
// 2026-10-25: the guard's own tests failed there), so the repo is excluded
// before the temp roots are consulted.
const REPO_ROOT = state.repoRoot || (state.repoRoot = normalize(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')));

function underRoot(candidate, root) {
  return candidate === root || candidate.startsWith(root.endsWith('/') ? root : `${root}/`);
}

export function isAllowedWrite(target) {
  if (target instanceof URL) target = fileURLToPath(target);
  if (Buffer.isBuffer(target)) target = target.toString('utf8');
  if (typeof target !== 'string') return true; // file descriptors: the open() was already checked
  if (NULL_DEVICES.has(target.toLowerCase())) return true;
  // A path with an embedded NUL can never reach the disk (fs throws
  // ERR_INVALID_ARG_VALUE); tests pass one on purpose to exercise error handling.
  if (target.includes('\0')) return true;
  // A pinned directory descriptor is a capability for its physical target.
  // Resolve only this process's descriptor and retain the same temp/repo rules.
  if (!IS_WINDOWS) {
    const fdPath = target.match(/^\/proc\/self\/fd\/(\d+)(?:\/(.*))?$/);
    if (fdPath) {
      try { target = path.resolve(fs.realpathSync.native('/proc/self/fd/' + fdPath[1]), fdPath[2] || ''); }
      catch { return false; }
    }
  }
  const normalized = normalize(target);
  if (ALLOWED_OUTSIDE_TMP.some((entry) => entry.pattern.test(normalized))) return true;
  if (underRoot(normalized, REPO_ROOT)) return false;
  return TMP_ROOTS.some((root) => underRoot(normalized, root));
}

state.mode = MODE;
state.isAllowedWrite = isAllowedWrite;
state.violations.length = 0;
state.clear = () => { state.violations.length = 0; };

function currentTestFile() {
  try { return expect.getState().testPath || globalThis.__vitest_worker__?.filepath || ''; } catch { return ''; }
}

function blocked(op, target) {
  const shown = target instanceof URL ? fileURLToPath(target) : String(target);
  state.violations.push({ op, target: path.resolve(shown) });
  if (process.env.TEST_WRITE_GUARD_LOG) {
    state.inGuard = true; // appendFileSync re-enters the patched writeFileSync
    try {
      state.real.appendFileSync(process.env.TEST_WRITE_GUARD_LOG, `${JSON.stringify({ file: currentTestFile(), op, target: path.resolve(shown) })}\n`);
    } catch { /* logging must never break a test */ } finally { state.inGuard = false; }
  }
  if (MODE === 'enforce') {
    const error = new Error(`EACCES: test write outside the temp dir blocked by forbid-writes-outside-tmp: ${op} ${path.resolve(shown)}`);
    error.code = 'EACCES';
    throw error;
  }
}

function pathExists(target) {
  try { return fs.existsSync(target); } catch { return false; }
}

function isDirectory(target) {
  try { return fs.statSync(target).isDirectory(); } catch { return false; }
}

function opensForWrite(flags) {
  if (flags === undefined || flags === null) return false;
  if (typeof flags === 'number') {
    const { O_WRONLY, O_RDWR, O_CREAT, O_APPEND, O_TRUNC } = fs.constants;
    return (flags & (O_WRONLY | O_RDWR | O_CREAT | O_APPEND | O_TRUNC)) !== 0;
  }
  return /[wa+]/.test(String(flags));
}

// [function name, indexes of path arguments, extra rule]
const GUARDED = [
  ['writeFile', [0]], ['appendFile', [0]], ['truncate', [0]], ['copyFile', [1]], ['cp', [1]],
  ['rename', [0, 1]], ['symlink', [1]], ['link', [1]], ['mkdtemp', [0]], ['utimes', [0]],
  ['mkdir', [0], (args) => args[0] instanceof URL || typeof args[0] !== 'string' || !isDirectory(args[0])],
  ['rm', [0], (args) => pathExists(args[0])], ['unlink', [0], (args) => pathExists(args[0])],
  ['rmdir', [0], (args) => pathExists(args[0])],
  ['open', [0], (args) => opensForWrite(args[1])],
];

function check(name, indexes, applies, args) {
  if (state.inGuard) return;
  if (applies && !applies(args)) return;
  for (const index of indexes) {
    const target = args[index];
    if (target === undefined || isAllowedWrite(target)) continue;
    blocked(name, target);
  }
}

if (!state.patched) {
  state.patched = true;
  for (const [name, indexes, applies] of GUARDED) {
    for (const holder of [{ target: fs, key: `${name}Sync` }, { target: fs, key: name }, { target: fs.promises, key: name }]) {
      const original = holder.target[holder.key];
      if (typeof original !== 'function') continue;
      const isPromise = holder.target === fs.promises;
      holder.target[holder.key] = function guardedFsWrite(...args) {
        if (isPromise) {
          try { check(name, indexes, applies, args); } catch (error) { return Promise.reject(error); }
        } else {
          check(name, indexes, applies, args);
        }
        return original.apply(this, args);
      };
    }
  }
  const createWriteStream = fs.createWriteStream;
  fs.createWriteStream = function guardedCreateWriteStream(...args) {
    check('createWriteStream', [0], null, args);
    return createWriteStream.apply(this, args);
  };
  syncBuiltinESMExports();
}

afterAll(() => {
  if (MODE !== 'enforce' || state.violations.length === 0) return;
  const lines = [...new Set(state.violations.map((v) => `${v.op} ${v.target}`))].slice(0, 12);
  state.clear();
  throw new Error(`Tests may write only under the OS temp dir. Blocked writes:\n  ${lines.join('\n  ')}`);
});
