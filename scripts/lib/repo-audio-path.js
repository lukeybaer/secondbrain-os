/**
 * repo-audio-path.js -- resolve a stored audio path to a usable absolute path
 * under the current repo root, tolerating non-portable legacy values.
 *
 * Why: voice-identity-registry enrollments store reference_audio_path, and some
 * legacy rows hold a Windows-absolute path like
 * "C:\\example\\secondbrain\\data\\otter\\audio\\<otid>\\clip.wav". On the
 * Linux Fargate container path.isAbsolute() is false for that string, so a naive
 * REPO-join produces "/opt/secondbrain/C:\foreign\..." which never exists, and the
 * enrollment is silently skipped -> reference_people:0 (the 2026-06-02 defect).
 *
 * resolveRepoAudioPath() normalizes any value to REPO/<repo-relative-tail>,
 * extracting the "data/otter/audio/..." (or "data/...") tail from a foreign
 * absolute path, so the same registry resolves on both Windows and Linux.
 */

const path = require('path');

// Pull the repo-relative tail out of an arbitrary path string. Handles both
// slash styles. Anchors on the LAST "data/" segment (Codex review: a foreign
// path with multiple "data/" segments must re-root to the deepest one, not the
// first) and only accepts known data roots so a stray "data/" inside some other
// directory cannot produce a bogus tail.
const ALLOWED_TAIL_ROOTS = ['data/otter/', 'data/life-archive/'];
function repoRelativeTail(value) {
  const s = String(value || '').replace(/\\/g, '/');
  // Find the last occurrence of a known data root and take from there.
  let best = null;
  for (const root of ALLOWED_TAIL_ROOTS) {
    const idx = s.lastIndexOf(root);
    if (idx >= 0 && (best === null || idx > best.idx)) best = { idx, tail: s.slice(idx) };
  }
  if (best) return best.tail;
  // Fallback: last generic "data/" segment (kept for non-otter/life-archive
  // data paths), still anchored on a path boundary.
  const m = s.match(/(?:^|\/)(data\/[^]*)$/);
  // If multiple data/ exist, prefer the last by scanning from the right.
  const last = s.lastIndexOf('/data/');
  if (last >= 0) return s.slice(last + 1);
  if (s.startsWith('data/')) return s;
  return m ? m[1] : null;
}

// Is this an absolute path that does NOT belong to the current repo root? That
// covers a Windows path seen on POSIX, a POSIX path seen on Windows, or any
// absolute path pointing outside REPO.
function isForeignAbsolute(value, repoRoot) {
  const s = String(value || '');
  const winAbs = /^[A-Za-z]:[\\/]/.test(s) || s.startsWith('\\\\');
  const posixAbs = s.startsWith('/');
  if (!winAbs && !posixAbs) return false; // relative -> not foreign
  // Native-absolute under the current repo is fine, not foreign.
  const norm = s.replace(/\\/g, '/');
  const repoNorm = String(repoRoot || '').replace(/\\/g, '/');
  if (repoNorm && norm.startsWith(repoNorm)) return false;
  // Windows-abs on a POSIX host (or vice-versa) is always foreign.
  if (winAbs && path.sep === '/') return true;
  if (posixAbs && path.sep === '\\') return true;
  // Absolute on the same OS but outside repo root -> foreign.
  return true;
}

function resolveRepoAudioPath(value, repoRoot) {
  const repo = repoRoot || path.resolve(__dirname, '..', '..');
  const s = String(value || '');
  if (!s) return s;
  // Plain relative path: join to repo (the normal, portable case).
  const winAbs = /^[A-Za-z]:[\\/]/.test(s) || s.startsWith('\\\\');
  const posixAbs = s.startsWith('/');
  if (!winAbs && !posixAbs) return path.join(repo, s);
  // Native-absolute under this repo: use as-is.
  if (!isForeignAbsolute(s, repo)) return s;
  // Foreign-absolute: recover the data/... tail and re-root to this repo.
  const tail = repoRelativeTail(s);
  if (tail) return path.join(repo, tail);
  // No recoverable tail: return the original (caller's existsSync will fail
  // loudly rather than us inventing a path).
  return s;
}

module.exports = { resolveRepoAudioPath, repoRelativeTail, isForeignAbsolute };
