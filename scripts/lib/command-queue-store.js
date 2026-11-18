'use strict';

// Durable store for the EC2 command queue (Codex review, 2026-11-03).
//
// The backend keeps the queue in a Map loaded at startup and used to persist it
// best-effort: a failed write was logged and the route still answered 200, and
// the spine worker rewrote the same file without the lock, so the backend's next
// save overwrote the worker's 'adopted' rows and the command ran twice.
//
// Now the file is the authority. withLock(fn) takes the queue file lock, re-reads
// the file into the Map's records in place, runs fn (synchronous: decide and
// call persist()), and if fn or the write throws, puts every record back as it
// was, so nothing is acknowledged that is not on disk. persist() writes
// atomically (temp file + rename) and throws on failure.
//
// Records change in place. Map entries are added only by ec2-server.js
// addCommand and by mergeHandoff (the phone process's commands). addCommand's
// own write is best-effort, so a create route acknowledges only after
// ensureDurable(id): the row is on disk, or written atomically now, or (the one
// removal here) it leaves the Map and the route answers an error, so a create
// reported as failed is never claimed, persisted or run later.
//
// A route reads its record before it waits for the lock, so withLock(fn,
// { record }) checks under the lock that the record is still the queue's entry
// for its id (not withdrawn meanwhile) and is on disk (not a create or merge
// whose save is still open). Otherwise it throws COMMAND_GONE or
// COMMAND_UNSAVED and fn never runs, so no route answers success for a change
// no durable write carries (Codex review 2b6a75dd8ff4).

const fs = require('fs');
const path = require('path');
const { withFileLock, withFileLockAsync } = require('./ledger-state-machine');
const commandState = require('./command-queue-state');

// Same object, new contents: a route or delivery holding the record sees the
// fresh state.
function replaceInPlace(held, next) {
  if (!held) return;
  for (const key of Object.keys(held)) if (!(key in next)) delete held[key];
  Object.assign(held, next);
}

/**
 * @param {{ file: string, commands: Map<string, object>, lockOptions?: object }} opts
 */
function createCommandQueueStore({ file, commands, lockOptions } = {}) {
  // A row only on disk (written by an older worker build) is carried through
  // every durable write, never dropped. A row only in memory (a create whose
  // plain persist failed) is written by the next durable persist.
  let diskOnly = [];

  // A corrupt file throws: no transition is decided on a guess. Returns the
  // ids the file holds.
  function refresh() {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      diskOnly = [];
      return new Set();
    }
    const rows = JSON.parse(text);
    if (!Array.isArray(rows)) throw new Error('command queue file is not an array');
    const unknown = [];
    const ids = new Set();
    for (const row of rows) {
      if (!row || !row.id) continue;
      ids.add(row.id);
      commandState.canonicalizeLoaded(row);
      const held = commands.get(row.id);
      if (held) replaceInPlace(held, row);
      else unknown.push(row);
    }
    diskOnly = unknown;
    return ids;
  }

  function persist() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify([...commands.values(), ...diskOnly], null, 2));
      fs.renameSync(tmp, file);
    } catch (e) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* nothing to clean */
      }
      throw e;
    }
  }

  function assertSaved(record, onDisk) {
    if (commands.get(record.id) !== record) {
      throw Object.assign(new Error('command ' + record.id + ' is not in the queue'), { code: 'COMMAND_GONE' });
    }
    if (!onDisk.has(record.id)) {
      throw Object.assign(new Error('command ' + record.id + ' is not saved yet'), { code: 'COMMAND_UNSAVED' });
    }
  }

  function withLock(fn, { record } = {}) {
    return withFileLockAsync(
      file,
      () => {
        const onDisk = refresh();
        if (record) assertSaved(record, onDisk);
        const before = [...commands.values()].map((held) => [held, JSON.stringify(held)]);
        try {
          return fn();
        } catch (e) {
          for (const [held, json] of before) replaceInPlace(held, JSON.parse(json));
          throw e;
        }
      },
      lockOptions,
    );
  }

  function fileHas(id) {
    try {
      const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(rows) && rows.some((row) => row && row.id === id);
    } catch {
      return false;
    }
  }

  async function ensureDurable(id) {
    try {
      await withFileLockAsync(
        file,
        () => {
          refresh();
          if (fileHas(id)) return;
          if (!commands.has(id)) throw new Error('command ' + id + ' is not in the queue');
          persist();
        },
        lockOptions,
      );
    } catch (e) {
      // Synchronous from here: no write can carry the record out in between.
      if (fileHas(id)) return;
      commands.delete(id);
      throw e;
    }
  }

  // addCommand's plain write only logs a failure, so a command can sit in
  // memory but not on disk (Codex review 7c11e451c062 F2). The main process
  // calls this every few seconds: under the lock, any row in memory but not on
  // disk is written atomically. Returns the ids it wrote; a failed write throws
  // and the next run retries.
  async function flushUnsaved() {
    return withFileLockAsync(
      file,
      () => {
        const onDisk = refresh();
        const missing = [...commands.keys()].filter((id) => !onDisk.has(id));
        if (missing.length) persist();
        return missing;
      },
      lockOptions,
    );
  }

  // The phone handoff merge (ec2-server.js, hashed voice slice) used to add the
  // phone process's commands, save with the plain write and delete the handoff
  // even when the save failed (Codex review 2b6a75dd8ff4). It runs
  // synchronously (a 1 s timer and the top of every /commands request), so this
  // takes the lock without waiting. A busy lock or a failed write throws, the
  // rows it added leave the Map, and the caller keeps the claimed handoff for
  // the next tick. A row already in memory but not on disk is written too, not
  // skipped. A row already on disk that this process does not hold keeps the
  // saved record. Returns how many commands it added.
  function mergeHandoff(rows) {
    return withFileLock(
      file,
      () => {
        const onDisk = refresh();
        const added = [];
        let unsaved = false;
        for (const row of rows) {
          if (commands.has(row.id)) {
            if (!onDisk.has(row.id)) unsaved = true;
            continue;
          }
          const saved = diskOnly.findIndex((held) => held.id === row.id);
          if (saved >= 0) {
            commands.set(row.id, diskOnly.splice(saved, 1)[0]);
            continue;
          }
          commands.set(row.id, row);
          added.push(row.id);
        }
        if (added.length || unsaved) {
          try {
            persist();
          } catch (e) {
            for (const id of added) commands.delete(id);
            throw e;
          }
        }
        return added.length;
      },
      { ...lockOptions, waitMs: 0 },
    );
  }

  return { withLock, persist, refresh, ensureDurable, flushUnsaved, mergeHandoff };
}

module.exports = { createCommandQueueStore, replaceInPlace };
