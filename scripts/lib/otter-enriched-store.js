'use strict';

/**
 * Bounded-memory access to the enriched Otter transcript corpus.
 *
 * Why this exists (root cause of the 2026-08-15 voice-name-resolution stall):
 * the acoustic resolver used to call an `enrichedFilesByOtid()` helper that
 * readdir'd `data/otter/enriched`, `JSON.parse`d EVERY file, and kept every
 * parsed body in one resident Map, all before the first track was scored. That
 * was survivable while the corpus was small. By 2026-08-15 it reached 1,321
 * files holding 1.8 GB of JSON text, which needs several GB of V8 heap once
 * parsed. The host has 3,836 MB of RAM, Node's default old-space ceiling there
 * is 1,967 MB, and the job runs under `systemd-run` with MemoryMax=2048M, so
 * the run died inside `v8::internal::Builtin_JsonParse` three nights running
 * and nothing put a name on a voice after 15 August.
 *
 * Raising the ceiling is not available on a 3.8 GB host, and it would only
 * move the same cliff a few months out. Peak memory here is set by the batch
 * size instead of the corpus size: the index holds otid -> file path only, and
 * at most `cacheMax` parsed transcripts are resident at any moment.
 *
 * Behavior parity with the old eager Map is deliberate and load bearing:
 * - the key is `enriched.otid` when the file carries one, else its basename;
 * - when two files claim the same otid, the last one in readdir order wins;
 * - `get(otid)` returns the same `{ file, enriched }` shape, so a caller can
 *   mutate `entry.enriched` and write it back to `entry.file`.
 *
 * The otid is read from a bounded head slice rather than a full parse. Every
 * enriched transcript writes `otid` as its second top-level key, so the first
 * `"otid"` in the file is the top-level one. If the head slice does not settle
 * the question (no match, or the match sits after `"segments"` where nested
 * transcript content begins) the file falls back to a full parse, which is
 * exactly what the old helper did for every file.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_CACHE_MAX = 4;
const DEFAULT_HEAD_BYTES = 8192;

function readHead(file, headBytes) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(headBytes);
    const read = fs.readSync(fd, buffer, 0, headBytes, 0);
    return buffer.subarray(0, read).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* best effort */
      }
    }
  }
}

// Returns the top-level otid from the head slice, or '' when the slice cannot
// answer it confidently and the caller must fall back to a full parse.
function otidFromHead(head) {
  const match = /"otid"\s*:\s*"([^"\\]*)"/.exec(head);
  if (!match) return '';
  const segmentsAt = head.indexOf('"segments"');
  // A match that sits inside the segment array is transcript content, not the
  // top-level identifier. Refuse it and let the full parse decide.
  if (segmentsAt >= 0 && segmentsAt < match.index) return '';
  return match[1];
}

function parseFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * @param {object} options
 * @param {string} options.dir enriched transcript directory
 * @param {number} [options.cacheMax] max parsed transcripts resident at once
 * @param {number} [options.headBytes] bytes read per file when indexing
 */
function createEnrichedStore({ dir, cacheMax, headBytes } = {}) {
  const max = Math.max(1, Number(cacheMax) || DEFAULT_CACHE_MAX);
  const head = Math.max(512, Number(headBytes) || DEFAULT_HEAD_BYTES);
  const index = new Map();
  let indexedFromFullParse = 0;

  if (dir && fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(dir, name);
      const basename = path.basename(name, '.json');
      let otid = otidFromHead(readHead(file, head));
      if (!otid) {
        indexedFromFullParse += 1;
        otid = parseFile(file).otid || basename;
      }
      if (otid) index.set(otid, file);
    }
  }

  // Insertion-ordered Map used as an LRU: the first key is the least recently
  // used. Eviction happens BEFORE insertion so residency never exceeds `max`,
  // not even transiently.
  const cache = new Map();
  let parsedFiles = 0;
  let peakResident = 0;
  let evictions = 0;
  let hits = 0;

  function evictTo(size) {
    while (cache.size > size) {
      const oldest = cache.keys().next().value;
      cache.delete(oldest);
      evictions += 1;
    }
  }

  return {
    has(otid) {
      return index.has(otid);
    },

    otids() {
      return [...index.keys()];
    },

    get(otid) {
      const file = index.get(otid);
      if (!file) return undefined;
      const cached = cache.get(otid);
      if (cached) {
        // Refresh recency: delete + set moves the key to the newest position.
        cache.delete(otid);
        cache.set(otid, cached);
        hits += 1;
        return cached;
      }
      evictTo(max - 1);
      const entry = { file, enriched: parseFile(file) };
      parsedFiles += 1;
      cache.set(otid, entry);
      if (cache.size > peakResident) peakResident = cache.size;
      return entry;
    },

    // Drop one body once the caller is finished with it. Mutations are written
    // back by the caller before this point, so releasing never loses work.
    release(otid) {
      cache.delete(otid);
    },

    stats() {
      return {
        indexed_files: index.size,
        indexed_via_full_parse: indexedFromFullParse,
        parsed_files: parsedFiles,
        cache_hits: hits,
        evictions,
        peak_resident_files: peakResident,
        cache_max: max,
      };
    },
  };
}

module.exports = { createEnrichedStore, otidFromHead };
