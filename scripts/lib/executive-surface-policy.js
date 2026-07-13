#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const { isCliFailureOutput } = require('./cli-output-guard.js');

const RAW_OPERATIONAL_PATTERNS = [
  /HTTP\s+[45]\d\d/i,
  /\b404\s+Not\s+Found\b/i,
  /\bnot_found_error\b/i,
  /\binvalid_request_error\b/i,
  /\boverloaded_error\b/i,
  /\bbackend\s*:?\s*3001\b/i,
  /\bpm2\b/i,
  /\bclaude\s+exit\s+\d+\b/i,
  /\bstack\s+trace\b/i,
  /\btraceback\b/i,
  /\bapi\.telegram\.org\b/i,
  /\btelegram_error\b/i,
  /\bBad Request:\s*message is too long\b/i,
  /\bprovider\b/i,
  /\bAnthropic\b/i,
  /\bClaude\b/i,
  /\bOpenAI\b/i,
  /\bCodex CLI\b/i,
  /\bVapi\b/i,
];

const SELF_TALK_PATTERNS = [
  /\bI will now\b/i,
  /\blet me\b/i,
  /\bwhat I tried\b/i,
  /\braw logs?\b/i,
  /\bPlan \+ ETA\b/i,
  /\bOwner:\s*Amy\b/i,
  /\bAmy owns\b/i,
  /\bAmy must\b/i,
  /\bAmy will\b/i,
];

function firstMatch(patterns, text) {
  const s = String(text || '');
  for (const re of patterns) {
    const m = s.match(re);
    if (m) return m[0];
  }
  return '';
}

function containsRawOperationalLeak(text) {
  const s = String(text || '');
  if (!s.trim()) return false;
  return isCliFailureOutput(s) || RAW_OPERATIONAL_PATTERNS.some((re) => re.test(s));
}

function scrubExecutiveText(text) {
  let s = String(text || '');
  for (const re of RAW_OPERATIONAL_PATTERNS) {
    s = s.replace(re, 'internal service detail');
  }
  for (const re of SELF_TALK_PATTERNS) {
    s = s.replace(re, '');
  }
  s = s
    .replace(/\binternal service detail(?:[,;:]?\s*){2,}/gi, 'internal service detail ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
  if (containsRawOperationalLeak(s)) {
    return 'Amy service status changed. Impact: the request was saved, but delivery may be delayed. Next action: No action needed from ExampleCo right now.';
  }
  return s;
}

function assertExecutiveText(text, { surface = 'user-facing' } = {}) {
  const failures = [];
  const s = String(text || '');
  if (!s.trim()) failures.push(`${surface}: empty text`);
  const raw = firstMatch(RAW_OPERATIONAL_PATTERNS, s);
  if (raw || isCliFailureOutput(s)) failures.push(`${surface}: raw operational detail leaked`);
  const selfTalk = firstMatch(SELF_TALK_PATTERNS, s);
  if (selfTalk) failures.push(`${surface}: self-talk leaked`);
  return { ok: failures.length === 0, failures };
}

function cleanFragment(value, fallback) {
  const s = scrubExecutiveText(value || '').replace(/[. \t]+$/g, '');
  return s || fallback;
}

function toExecutiveServiceStatus({
  service = 'Amy service',
  state = 'degraded',
  impact = 'Some requests may be delayed.',
  nextAction = 'No action needed from ExampleCo right now.',
} = {}) {
  const serviceText = cleanFragment(service, 'Amy service');
  const stateText = cleanFragment(state, 'degraded').toLowerCase();
  const impactText = cleanFragment(impact, 'Some requests may be delayed');
  const nextActionText = cleanFragment(nextAction, 'No action needed from ExampleCo right now');
  return `${serviceText} is ${stateText}.\nImpact: ${impactText}.\nNext action: ${nextActionText}.`;
}

function internalFailureToExecutiveStatus(raw, fallback = {}) {
  return toExecutiveServiceStatus({
    service: fallback.service || 'Amy execution',
    state: fallback.state || 'temporarily delayed',
    impact:
      fallback.impact ||
      'Telegram and phone requests are saved, but some replies may wait for the cloud retry loop',
    nextAction: fallback.nextAction || 'No action needed from ExampleCo right now',
  });
}

// ---------------------------------------------------------------------------
// Internal-id face leak filter (ExampleCo wave 3a, 2026-07-12, D1+D7).
//
// The live render QC (scripts/verify-dashboard-cards-live.js FACE_DENYLIST)
// hard-fails any card face that ExampleCos an internal id: a spine-session task
// id, a dispatch-N ledger id, or a bare UUID prefix. On 2026-07-12 both the
// BLOCKERS and MEMORY.MD CHANGES faces leaked "spine-session-..." because the
// filter only existed at the QC layer, not at card CREATION. This block is the
// ONE shared filter every face builder routes copy through when the card is
// created: spine-session ids are mapped to their human task titles from the
// spine store, everything else internal is removed. The QC then merely
// verifies creation did its job (and a failed check triggers ONE regeneration
// attempt before flagging -- see enforceFaceCopyGate).
//
// The patterns MUST stay category-equivalent with the render QC's internal-id
// denylist entries; scripts/__tests__/face-internal-id-leak-gate.test.js locks
// the two sets together.
// ---------------------------------------------------------------------------

const INTERNAL_ID_FACE_PATTERNS = [
  // Bare UUID prefix (8-4-) with at least one hex letter in the window, so an
  // all-decimal datetime stamp can never be misread as a UUID.
  { re: /\b(?=[0-9a-f]{0,17}[a-f])[0-9a-f]{8}-[0-9a-f]{4}-/i, label: 'uuid' },
  // Bare prefix on purpose: the render QC flags "spine-session-" even with no
  // id after it (a quoted prefix in defect evidence is exactly how the leak
  // self-perpetuated on 2026-07-12), so creation-time QC must match the same.
  { re: /\bspine-session-/i, label: 'spine-session' },
  { re: /\bdispatch-\d+\b/i, label: 'dispatch-id' },
];

// Candidate spine task store directories, most authoritative first. Mirrors
// the documented spine topology: SB_SPINE_DIR override, the build's data dir,
// the EC2 runtime store, the desktop Electron store, then the repo-relative
// store used only when env points there.
function spineTaskDirCandidates(opts = {}) {
  const dirs = [];
  const add = (d) => {
    if (d && !dirs.includes(path.resolve(d))) dirs.push(path.resolve(d));
  };
  for (const d of opts.taskDirs || []) add(d);
  add(process.env.SB_SPINE_DIR);
  if (process.env.SECONDBRAIN_DATA_DIR) add(path.join(process.env.SECONDBRAIN_DATA_DIR, 'tasks'));
  if (process.platform === 'linux') add('/opt/secondbrain/data/tasks');
  if (process.env.APPDATA) add(path.join(process.env.APPDATA, 'secondbrain', 'data', 'tasks'));
  add(path.join(__dirname, '..', '..', 'data', 'tasks'));
  return dirs;
}

// Resolve a spine-session id (the part after "spine-session-") to the human
// task title recorded in the spine store. Returns '' when no title is found;
// the caller then removes the id instead of leaving it on the face.
function resolveSpineSessionTitle(sessionId, opts = {}) {
  const id = String(sessionId || '').trim();
  if (!id) return '';
  for (const dir of spineTaskDirCandidates(opts)) {
    const file = path.join(dir, `spine-session-${id}.json`);
    try {
      if (!fs.existsSync(file)) continue;
      const task = JSON.parse(fs.readFileSync(file, 'utf8'));
      const title = String((task && (task.title || task.name)) || '').trim();
      if (title) return title;
    } catch {
      /* unreadable task file: try the next candidate dir */
    }
  }
  return '';
}

// Scrub every internal id out of face copy AT CARD CREATION. spine-session ids
// resolve to their human task titles ("<title>" session work) when the spine
// store knows them; unresolvable ids, UUIDs, and dispatch ids are removed. A
// leading label such as "originSessionId:" is dropped with its id so no
// dangling key survives. Deterministic and idempotent.
function scrubInternalIdsFromFace(text, opts = {}) {
  let s = String(text || '');
  if (!s) return s;
  // Drop a leading frontmatter-style key directly in front of an internal id.
  // PERF (2026-07-12 outage): the previous pattern nested quantifiers
  // ([A-Za-z0-9]*(?:[_-]?[A-Za-z0-9]+)*), which backtracks exponentially on
  // long alphanumeric tokens (memory-index slugs), pinning the render at 100%
  // CPU for minutes. This bounded character-class form matches the same keys
  // in linear time.
  s = s.replace(
    /\b[A-Za-z][A-Za-z0-9_-]{0,63}\s*:\s*(?=(?:[0-9a-f]{8}-[0-9a-f]{4}-)|spine-session-|dispatch-\d)/gi,
    '',
  );
  // spine-session ids: map to the human task title when the store knows it.
  // The trailing id group is optional so a quoted bare prefix ("spine-session-")
  // in defect evidence is removed too, never left to re-trip the render QC.
  s = s.replace(/\bspine-session-([0-9a-z][0-9a-z-]*)?/gi, (full, id) => {
    if (!id) return '';
    const title = opts.resolveTitle ? opts.resolveTitle(id) : resolveSpineSessionTitle(id, opts);
    return title ? `"${title}" session work` : '';
  });
  // Full UUIDs, then bare UUID prefixes with the hex-letter guard.
  s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '');
  s = s.replace(/\b(?=[0-9a-f]{0,17}[a-f])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f-]*/gi, '');
  s = s.replace(/\bdispatch-\d+\b/gi, '');
  return s
    .replace(/\s{2,}/g, ' ')
    .replace(/\(\s*\)/g, '')
    .replace(/"\s*"/g, '')
    .replace(/\s+([.,;)])/g, '$1')
    .trim();
}

// Per-card creation-time QC predicate: does this face copy still leak an
// internal id? Category-equivalent to the render QC denylist entries.
function faceCopyHasInternalIdLeak(text) {
  const s = String(text || '');
  if (!s.trim()) return false;
  return INTERNAL_ID_FACE_PATTERNS.some((entry) => entry.re.test(s));
}

// The creation-time gate ExampleCo specified: build the face, QC it, and on a
// failed QC make ONE regeneration attempt (the build rerun with sanitize
// forced) before flagging. Returns { text, attempts, flagged }.
//   build(sanitize: boolean) -> string
function enforceFaceCopyGate(build, opts = {}) {
  const verify = opts.verify || ((text) => !faceCopyHasInternalIdLeak(text));
  const first = build(false);
  if (verify(first)) return { text: first, attempts: 1, flagged: false };
  const second = build(true);
  if (verify(second)) return { text: second, attempts: 2, flagged: false };
  // Still leaking after the one regeneration attempt: hard-scrub what we have
  // and flag it so the caller can surface an honest defect instead of leaking.
  return { text: scrubInternalIdsFromFace(second, opts), attempts: 2, flagged: true };
}

module.exports = {
  RAW_OPERATIONAL_PATTERNS,
  SELF_TALK_PATTERNS,
  INTERNAL_ID_FACE_PATTERNS,
  containsRawOperationalLeak,
  scrubExecutiveText,
  assertExecutiveText,
  toExecutiveServiceStatus,
  internalFailureToExecutiveStatus,
  resolveSpineSessionTitle,
  scrubInternalIdsFromFace,
  faceCopyHasInternalIdLeak,
  enforceFaceCopyGate,
};
