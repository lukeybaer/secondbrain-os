#!/usr/bin/env node
'use strict';

// owner-activity.js -- the owner-activity ledger: telemetry only.
//
// WHY: Amy keeps a mechanical answer to "when did the owner himself last touch any
// surface?" for the health row. It was built as the data source of a dead-man
// switch (The owner decision 2026-07-11, D5). The owner DROPPED that switch on 2026-09-24
// and it was retired from the repo on 2026-10-23 (Oct 23 audit M2): nothing may
// stop or gate the morning briefing on owner silence, and the 7-day threshold
// constant is gone. See memory/reference_owner_activity_ledger.md for the record.
//
// STATE OWNERSHIP: desktop and EC2 each append LOCALLY to their own copy of
// data/agent/owner-activity.jsonl (desktop: repo data/ or SECONDBRAIN_DATA_DIR
// when set; EC2: /opt/secondbrain/data). Nobody appends across the wire. The
// health row reads BOTH roots via dataRootCandidates (the same two-root
// contract every other artifact reader uses, scripts/lib/data-root.js):
// desktop reads its own ledger; the EC2 wiring for telegram/vapi inbound is a
// follow-up noted in the memory file. Until the ledgers are unified,
// daysSinceOwnerActivity is computed per available ledger and the MINIMUM
// wins -- activity on ANY surface counts as owner activity, so the newest
// entry across all readable ledgers is the truth. A missing ledger on one
// root is simply skipped, never an error.
//
// FORMAT: append-only JSONL, one entry per line:
//   {"surface":"claude-code","at":"2026-07-11T12:00:00.000Z","proof":"<session id>"}
// Append-only means torn lines are possible (process killed mid-write, two
// writers racing); readers skip any line that does not parse into a valid
// entry rather than failing the whole read (raw archival principle: never let
// one bad line poison the ledger).

const fs = require('fs');
const path = require('path');
const { dataRootCandidates } = require('./data-root.js');
const { ctDayKeyForInstant } = require('./ct-day.js');

const LEDGER_REL_PATH = 'agent/owner-activity.jsonl';

// The surfaces the owner himself acts through. A scheduled job, a self-heal worker,
// or an Amy-initiated action is NOT owner activity and must never be recorded
// here -- that would make Amy's own work look like the owner being present.
const OWNER_SURFACES = ['claude-code', 'codex', 'telegram', 'vapi', 'app'];

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MAX_PROOF_LENGTH = 200;

function repoRoot() {
  return path.resolve(process.env.SECONDBRAIN_ROOT || path.join(__dirname, '..', '..'));
}

// The single absolute path a WRITER should append to: SECONDBRAIN_DATA_DIR
// when set (the live cloud/desktop store), else the repo-relative data/ dir.
// Mirrors writeDataArtifact's writer-side resolution in data-root.js; this
// module keeps its own copy because appends need appendFileSync, not the
// whole-file rewrite writeDataArtifact does.
function ledgerWritePath(opts = {}) {
  if (opts.ledgerPath) return opts.ledgerPath;
  const dataDir = opts.dataDir || process.env.SECONDBRAIN_DATA_DIR || path.join(repoRoot(), 'data');
  return path.join(dataDir, ...LEDGER_REL_PATH.split('/'));
}

// Every candidate ledger a READER must consult (repo data/ copy plus the
// SECONDBRAIN_DATA_DIR copy). opts.ledgerPath narrows to one explicit file
// (tests); opts.repo / opts.dataDir override the roots (tests).
function ledgerCandidatePaths(opts = {}) {
  if (opts.ledgerPath) return [opts.ledgerPath];
  return dataRootCandidates(LEDGER_REL_PATH, opts);
}

// Validate + normalize one activity entry. Throws on anything invalid so a
// caller can never silently append garbage the readers would then skip --
// fail loud at the write site, fail open only at the HOOK call site (the hook
// wraps this in try/catch so a ledger failure never breaks a session).
function normalizeEntry({ surface, at, proof } = {}) {
  if (!OWNER_SURFACES.includes(surface)) {
    throw new Error(
      `owner-activity: surface must be one of ${OWNER_SURFACES.join(', ')} (got ${JSON.stringify(surface)})`,
    );
  }
  const atIso = at === undefined || at === null ? new Date().toISOString() : String(at);
  const atMs = Date.parse(atIso);
  if (!Number.isFinite(atMs)) {
    throw new Error(`owner-activity: at must be a parseable timestamp (got ${JSON.stringify(at)})`);
  }
  const proofStr = String(proof === undefined || proof === null ? '' : proof).trim();
  if (!proofStr) {
    throw new Error(
      'owner-activity: proof is required (a short id: session id, message id, call id)',
    );
  }
  if (proofStr.length > MAX_PROOF_LENGTH) {
    throw new Error(
      `owner-activity: proof must be a short id (max ${MAX_PROOF_LENGTH} chars, got ${proofStr.length})`,
    );
  }
  return { surface, at: new Date(atMs).toISOString(), proof: proofStr };
}

// Append one owner-activity entry. Returns { absPath, entry } so callers can
// log a receipt. Throws on invalid fields or an unwritable ledger; the hook
// call sites guard with try/catch (fail open, log to stderr).
function recordOwnerActivity(fields, opts = {}) {
  const entry = normalizeEntry(fields);
  const absPath = ledgerWritePath(opts);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.appendFileSync(absPath, `${JSON.stringify(entry)}\n`, 'utf8');
  return { absPath, entry };
}

// Read one ledger file into validated entries. Torn lines (half-written JSON,
// interleaved writes, plain garbage) and structurally invalid entries are
// SKIPPED, never fatal. A missing file reads as an empty ledger.
function readLedgerEntries(absPath) {
  let raw;
  try {
    raw = fs.readFileSync(absPath, 'utf8');
  } catch {
    return [];
  }
  const entries = [];
  for (const line of String(raw).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // torn or corrupt line
    }
    if (!parsed || typeof parsed !== 'object') continue;
    if (!OWNER_SURFACES.includes(parsed.surface)) continue;
    const atMs = Date.parse(parsed.at);
    if (!Number.isFinite(atMs)) continue;
    const proof = String(
      parsed.proof === undefined || parsed.proof === null ? '' : parsed.proof,
    ).trim();
    if (!proof) continue;
    entries.push({ surface: parsed.surface, at: parsed.at, proof, atMs });
  }
  return entries;
}

// The single newest owner action across EVERY readable ledger (the "minimum
// daysSince wins" rule: any surface activity counts, so the freshest entry
// anywhere is authoritative). Returns
// { surface, at, proof, atMs, ledgerPath } or null when no ledger has a
// valid entry.
function lastOwnerActivity(opts = {}) {
  let best = null;
  for (const absPath of ledgerCandidatePaths(opts)) {
    for (const entry of readLedgerEntries(absPath)) {
      if (!best || entry.atMs > best.atMs) best = { ...entry, ledgerPath: absPath };
    }
  }
  return best;
}

// Fractional days since the newest owner action anywhere. null when no ledger
// has any valid entry (callers must render "no telemetry yet", never 0 --
// zero would read as "The owner was just here" when the truth is "we do not
// know"). Clock skew that puts the last entry in the future clamps to 0.
function daysSinceOwnerActivity(nowIso, opts = {}) {
  const nowMs = nowIso === undefined || nowIso === null ? Date.now() : Date.parse(String(nowIso));
  if (!Number.isFinite(nowMs)) {
    throw new Error(
      `owner-activity: nowIso must be a parseable timestamp (got ${JSON.stringify(nowIso)})`,
    );
  }
  const last = lastOwnerActivity(opts);
  if (!last) return null;
  return Math.max(0, (nowMs - last.atMs) / MS_PER_DAY);
}

// CT calendar day of an entry (or any timestamp) for display. The health row
// shows "last owner activity: 2026-07-11 (claude-code)" in the owner's timezone,
// never UTC (feedback_times_in_ct_never_utc.md).
function ctDayOfActivity(entryOrIso) {
  const iso = entryOrIso && typeof entryOrIso === 'object' ? entryOrIso.at : entryOrIso;
  const ms = Date.parse(String(iso || ''));
  if (!Number.isFinite(ms)) return null;
  return ctDayKeyForInstant(ms);
}

module.exports = {
  LEDGER_REL_PATH,
  OWNER_SURFACES,
  ledgerWritePath,
  ledgerCandidatePaths,
  recordOwnerActivity,
  readLedgerEntries,
  lastOwnerActivity,
  daysSinceOwnerActivity,
  ctDayOfActivity,
};
