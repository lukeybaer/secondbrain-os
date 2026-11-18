'use strict';

// S-15: the checked-in list of test files that fail on origin/master
// (config/known-master-failures.json). land.js and ship.js treat a failure of a
// listed file as known, not new, and report a listed file that now passes so
// the entry can be removed. A malformed list throws: guessing would either
// hide real failures or freeze every lander.

const fs = require('node:fs');
const path = require('node:path');

const REL_PATH = 'config/known-master-failures.json';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function norm(file) {
  return String(file || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function parseKnownFailures(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw new Error(`${REL_PATH} is not valid JSON: ${err.message}`);
  }
  const list = doc && Array.isArray(doc.failures) ? doc.failures : null;
  if (!list) throw new Error(`${REL_PATH} must be an object with a "failures" array.`);
  const entries = list.map((e, i) => {
    const file = norm(e && e.file);
    const reason = String((e && e.reason) || '').trim();
    const date = String((e && e.date) || '').trim();
    if (!file || !reason || !DATE_RE.test(date)) {
      throw new Error(`${REL_PATH} entry ${i} needs file, reason and a YYYY-MM-DD date.`);
    }
    return { file, reason, date };
  });
  return { entries, files: new Set(entries.map((e) => e.file)) };
}

function loadKnownFailures(root) {
  let text;
  try {
    text = fs.readFileSync(path.join(root, REL_PATH), 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { entries: [], files: new Set() };
    throw err;
  }
  return parseKnownFailures(text);
}

/**
 * Split failed files into known and unknown, and name the listed files that ran
 * and passed (candidates for removal from the list).
 * @param {{failed: string[], ran: string[], known: {files: Set<string>}}} args
 */
function classifyFailures({ failed = [], ran = [], known }) {
  const failedSet = new Set(failed.map(norm));
  const knownFailing = [...failedSet].filter((f) => known.files.has(f)).sort();
  const unknown = [...failedSet].filter((f) => !known.files.has(f)).sort();
  const nowPassing = [...new Set(ran.map(norm))].filter((f) => known.files.has(f) && !failedSet.has(f)).sort();
  return { knownFailing, unknown, nowPassing };
}

function reportKnownFailures(log, known, result) {
  for (const f of result.knownFailing) {
    const e = known.entries.find((x) => x.file === f);
    log(`  known master failure (not blocking, listed ${e.date}): ${f} - ${e.reason}`);
  }
  for (const f of result.nowPassing) {
    log(`  known master failure now PASSES, remove it from ${REL_PATH}: ${f}`);
  }
}

module.exports = { REL_PATH, parseKnownFailures, loadKnownFailures, classifyFailures, reportKnownFailures };
