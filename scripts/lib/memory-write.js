'use strict';

/**
 * Phase 5 of the session-isolation plan: memory-write coherence.
 *
 * Why this exists: `~/.claude/memory` is junctioned at the USER level to the
 * canonical `secondbrain/memory` files. A naive memory write is therefore
 * immediate and GLOBAL across every concurrent session. Git worktree isolation
 * does NOT isolate memory writes. Two sessions editing the same memory file at
 * once silently clobber each other.
 *
 * The model implemented here:
 *   1. A session never writes the canonical file live. Instead it STAGES each
 *      intended change as a per-session intent/patch file inside its own
 *      worktree stage dir (stageMemoryWrite).
 *   2. A SERIALIZED merge step (applyStagedMemoryWrites) later applies those
 *      intents to the canonical files under targetRoot, one writer at a time,
 *      holding a per-target-file rename lock so two concurrent applies cannot
 *      corrupt the same file. Intents are applied oldest-ts-first; 'append'
 *      appends, 'replace' is last-writer-by-ts wins. Crucially, a replace to one
 *      file NEVER silently drops a pending write to a DIFFERENT file.
 *
 * Everything is clock-injectable (nowMs) so tests are deterministic.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const DEFAULT_LOCK_TTL_MS = 30 * 1000; // stale-reclaim backstop for a crashed holder

function nowOrInjected(nowMs) {
  return typeof nowMs === 'number' ? nowMs : Date.now();
}

// A memory file name can contain slashes (subdir). Sanitize to a single flat,
// filesystem-safe token so each intent lives at one path under stageDir.
function sanitizeFile(file) {
  return (
    String(file)
      .replace(/[\\/:*?"<>|]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'memory'
  );
}

function atomicWriteFileSync(targetPath, data) {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.tmp-${path.basename(targetPath)}-${process.pid}-${Math.random().toString(36).slice(2, 10)}`,
  );
  fs.writeFileSync(tmp, data, 'utf8');
  fs.renameSync(tmp, targetPath); // rename is atomic on the same volume
}

// ---------------------------------------------------------------------------
// Rename-based file lock: clock-injectable, TTL stale-reclaim.
// ---------------------------------------------------------------------------

/**
 * Acquire a rename-based lock at `lockPath`.
 *
 * A lock is a directory created via mkdir (atomic: fails if it already exists),
 * containing an `owner.json` with { ownerId, ts }. If an existing lock is older
 * than ttlMs it is treated as stale and reclaimed (a crashed holder never blocks
 * forever). Returns { ok, ownerId } on success, { ok:false, holder } on a live
 * conflict.
 */
function acquireFileLock(lockPath, opts = {}) {
  const ttlMs = typeof opts.ttlMs === 'number' ? opts.ttlMs : DEFAULT_LOCK_TTL_MS;
  const ownerId = opts.ownerId || `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  const now = nowOrInjected(opts.nowMs);
  const ownerFile = path.join(lockPath, 'owner.json');

  // The lock dir itself is created non-recursively (mkdir is the atomic
  // create-or-fail primitive), but its PARENT must exist first or mkdir throws
  // ENOENT. Ensure the parent without racing on the lock dir.
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  } catch {
    /* best effort; tryCreate surfaces any real problem */
  }

  const tryCreate = () => {
    try {
      fs.mkdirSync(lockPath); // atomic create-or-fail; no recursive
      atomicWriteFileSync(ownerFile, JSON.stringify({ ownerId, ts: now }));
      return { ok: true, ownerId };
    } catch (e) {
      if (e && e.code === 'EEXIST') return null;
      return { ok: false, error: String((e && e.message) || e).slice(0, 200) };
    }
  };

  let res = tryCreate();
  if (res) return res;

  // Lock dir already exists. Decide if it is stale.
  let holder = null;
  try {
    holder = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
  } catch {
    holder = null; // partially written or missing owner -> treat as reclaimable
  }

  const holderTs = holder && typeof holder.ts === 'number' ? holder.ts : 0;
  const ageMs = now - holderTs;
  if (holder && ageMs < ttlMs) {
    return { ok: false, holder, ageMs };
  }

  // Stale (or unreadable) holder: reclaim by removing the lock dir and retrying.
  try {
    fs.rmSync(lockPath, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  res = tryCreate();
  if (res) return res;
  return { ok: false, holder, ageMs, reclaimFailed: true };
}

/**
 * Release a lock previously acquired with acquireFileLock. Only the owner may
 * release it (ownerId match), unless force is set. Best-effort.
 */
function releaseFileLock(lockPath, opts = {}) {
  const ownerFile = path.join(lockPath, 'owner.json');
  if (!opts.force) {
    let holder = null;
    try {
      holder = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
    } catch {
      holder = null;
    }
    if (holder && opts.ownerId && holder.ownerId !== opts.ownerId) {
      return false; // not ours; do not steal another owner's lock
    }
  }
  try {
    fs.rmSync(lockPath, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Stage a per-session memory write (intent file). Never touches canonical.
// ---------------------------------------------------------------------------

/**
 * Capture an intended memory change as a per-session intent file under stageDir.
 * Does NOT write the canonical target. Returns the intent path.
 *
 * @param {object} a
 * @param {string} a.stageDir   per-session staging dir (inside the worktree)
 * @param {string} a.file       canonical memory file path relative to targetRoot
 * @param {string} a.content    the content to apply
 * @param {('replace'|'append')} a.mode
 * @param {string} a.sessionId  unique per session
 * @param {number} [a.nowMs]    injectable clock
 */
function stageMemoryWrite({ stageDir, file, content, mode, sessionId, nowMs }) {
  if (!stageDir) throw new Error('stageMemoryWrite: stageDir required');
  if (!file) throw new Error('stageMemoryWrite: file required');
  if (!sessionId) throw new Error('stageMemoryWrite: sessionId required');
  const writeMode = mode === 'append' ? 'append' : 'replace';
  const ts = nowOrInjected(nowMs);

  const intent = {
    file: String(file),
    content: content == null ? '' : String(content),
    mode: writeMode,
    sessionId: String(sessionId),
    ts,
  };

  const intentPath = path.join(
    stageDir,
    `${sanitizeFile(file)}.${sanitizeFile(sessionId)}.patch.json`,
  );
  atomicWriteFileSync(intentPath, JSON.stringify(intent, null, 2));
  return intentPath;
}

// ---------------------------------------------------------------------------
// Apply all staged intents to the canonical files. Serialized, per-file locked.
// ---------------------------------------------------------------------------

function readIntents(stageDir) {
  let names = [];
  try {
    names = fs.readdirSync(stageDir);
  } catch {
    return [];
  }
  const intents = [];
  for (const name of names) {
    if (!name.endsWith('.patch.json')) continue;
    const p = path.join(stageDir, name);
    try {
      const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (obj && obj.file) intents.push({ intentPath: p, ...obj });
    } catch {
      /* skip malformed intent; never let one bad file abort the merge */
    }
  }
  return intents;
}

/**
 * The serialized memory-merge step. Applies every pending intent under stageDir
 * to the canonical files under targetRoot, one target-file at a time under a
 * rename lock, oldest-ts first. On success the applied intent is removed.
 *
 * - 'append' mode appends content to the canonical file.
 * - 'replace' mode is last-writer-by-ts wins for THAT file.
 * - Writes to DIFFERENT files are independent and all land; a replace never
 *   drops a pending write to another file.
 *
 * @returns {{applied: Array, skipped: Array}}
 */
function applyStagedMemoryWrites({ stageDir, targetRoot, nowMs, lockTtlMs }) {
  if (!stageDir) throw new Error('applyStagedMemoryWrites: stageDir required');
  if (!targetRoot) throw new Error('applyStagedMemoryWrites: targetRoot required');

  const applied = [];
  const skipped = [];

  const intents = readIntents(stageDir);
  // Deterministic order: oldest ts first, then sessionId, then intentPath as a
  // final tiebreak so the merge is fully reproducible.
  intents.sort((a, b) => {
    if (a.ts !== b.ts) return a.ts - b.ts;
    if (a.sessionId !== b.sessionId) return String(a.sessionId) < String(b.sessionId) ? -1 : 1;
    return a.intentPath < b.intentPath ? -1 : 1;
  });

  // Group by canonical file so each file is locked once and intents for it are
  // applied as a unit. Different files are fully independent.
  const byFile = new Map();
  for (const it of intents) {
    const key = it.file;
    if (!byFile.has(key)) byFile.set(key, []);
    byFile.get(key).push(it);
  }

  const locksRoot = path.join(stageDir, '.locks');

  for (const [file, fileIntents] of byFile) {
    const targetPath = path.resolve(targetRoot, file);
    const lockPath = path.join(locksRoot, `${sanitizeFile(file)}.lock`);

    const lock = acquireFileLock(lockPath, { nowMs, ttlMs: lockTtlMs });
    if (!lock.ok) {
      // Could not get the per-file lock right now: skip this file's intents,
      // leave them staged for a later apply. Never corrupt under contention.
      for (const it of fileIntents) {
        skipped.push({
          intentPath: it.intentPath,
          file,
          sessionId: it.sessionId,
          reason: 'locked',
        });
      }
      continue;
    }

    try {
      let current = '';
      try {
        current = fs.readFileSync(targetPath, 'utf8');
      } catch {
        current = '';
      }

      // Apply this file's intents in ts order. append accumulates; replace
      // resets the running content (last replace by ts wins) but any append
      // after it still lands on top.
      let next = current;
      for (const it of fileIntents) {
        if (it.mode === 'append') {
          next = next + it.content;
        } else {
          next = it.content; // replace
        }
      }

      atomicWriteFileSync(targetPath, next);

      for (const it of fileIntents) {
        try {
          fs.unlinkSync(it.intentPath);
        } catch {
          /* best effort: a failed unlink would re-apply idempotently next run */
        }
        applied.push({
          intentPath: it.intentPath,
          file,
          sessionId: it.sessionId,
          mode: it.mode,
          ts: it.ts,
        });
      }
    } finally {
      releaseFileLock(lockPath, { ownerId: lock.ownerId, force: true });
    }
  }

  return { applied, skipped };
}

module.exports = {
  stageMemoryWrite,
  applyStagedMemoryWrites,
  acquireFileLock,
  releaseFileLock,
  sanitizeFile,
  DEFAULT_LOCK_TTL_MS,
};
