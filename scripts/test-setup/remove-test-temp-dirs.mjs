// Test hygiene: every directory a test makes with mkdtemp under the OS temp dir is
// removed when that test file finishes.
//
// Why (2026-11-05): 303 test files call mkdtemp and never remove what it made, so
// every full or scoped run left its fixtures behind. The owner PC's Temp held 801
// vp-resolver-mem-* copies (35 GB, about 3.5 GB a day) plus tens of thousands of
// smaller dirs, and the 2 AM backup then failed for lack of disk. Fixing the files
// one by one would leave the next new test to leak again, so the category is closed
// here: this setup file records each mkdtemp result and its afterAll removes it.
//
// Scope: only paths this process created through fs.mkdtempSync, fs.mkdtemp or
// fs.promises.mkdtemp, and only under the OS temp dir and outside this repo.
// mkdtemp always creates a fresh, uniquely named directory, so nothing that existed
// before the test can be removed. Vitest's default "stack" hook order runs this
// afterAll after the test file's own. Child processes a test spawns are not
// covered. Removal is best effort: a dir still held open by a live child stays.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
import { afterAll } from 'vitest';

// fs is shared by every test file a worker runs, so the patch and its record live
// on globalThis and are installed once, like forbid-writes-outside-tmp.mjs.
const STATE_KEY = Symbol.for('amy.testTempDirSweeper');
const state = globalThis[STATE_KEY] || (globalThis[STATE_KEY] = { patched: false, created: [] });
const IS_WINDOWS = state.isWindows ?? (state.isWindows = process.platform === 'win32');

function normalize(target) {
  const resolved = path.resolve(String(target)).replace(/\\/g, '/').replace(/^\/\/[?.]\//, '');
  return IS_WINDOWS ? resolved.toLowerCase() : resolved;
}

function realOrSelf(dir) {
  try { return fs.realpathSync.native(dir); } catch { return dir; }
}

// The pristine temp dir from vitest.config.ts, so a test that repoints TEMP cannot
// widen what the sweep may remove.
function pristineRoots() {
  try { return JSON.parse(process.env.TEST_WRITE_GUARD_TMP_ROOTS || '[]'); } catch { return []; }
}
const TMP_ROOTS = state.tmpRoots || (state.tmpRoots = [...new Set([
  os.tmpdir(), realOrSelf(os.tmpdir()), ...pristineRoots(), ...pristineRoots().map(realOrSelf),
].filter(Boolean).map(normalize))]);

// The EC2 test-category runner copies the source tree under /tmp; never sweep it.
const REPO_ROOT = state.repoRoot || (state.repoRoot = normalize(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')));

function strictlyUnder(candidate, root) {
  return candidate.startsWith(root.endsWith('/') ? root : `${root}/`);
}

export function isSweepable(dir) {
  if (typeof dir !== 'string' || dir.length === 0) return false;
  const normalized = normalize(dir);
  if (normalized === REPO_ROOT || strictlyUnder(normalized, REPO_ROOT)) return false;
  return TMP_ROOTS.some((root) => strictlyUnder(normalized, root));
}

function record(dir) {
  if (isSweepable(dir)) state.created.push(dir);
  return dir;
}

/** Remove the dirs recorded since `since` (an index into recordedTempDirs()). */
export function sweepTestTempDirs({ since = 0 } = {}) {
  const dirs = state.created.splice(since);
  const left = [];
  for (const dir of dirs.reverse()) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
    } catch {
      left.push(dir);
    }
  }
  return { removed: dirs.length - left.length, left };
}

export function recordedTempDirs() {
  return [...state.created];
}

if (!state.patched) {
  state.patched = true;
  const { mkdtempSync, mkdtemp } = fs;
  const promisesMkdtemp = fs.promises.mkdtemp;
  fs.mkdtempSync = function recordedMkdtempSync(...args) {
    return record(mkdtempSync.apply(this, args));
  };
  fs.mkdtemp = function recordedMkdtemp(...args) {
    const callback = args[args.length - 1];
    if (typeof callback === 'function') {
      args[args.length - 1] = (error, dir) => {
        if (!error) record(dir);
        callback(error, dir);
      };
    }
    return mkdtemp.apply(this, args);
  };
  fs.promises.mkdtemp = async function recordedPromisesMkdtemp(...args) {
    return record(await promisesMkdtemp.apply(this, args));
  };
  syncBuiltinESMExports();
}

afterAll(() => {
  sweepTestTempDirs();
});
