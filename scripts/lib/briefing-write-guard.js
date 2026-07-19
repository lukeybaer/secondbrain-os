'use strict';

/**
 * briefing-write-guard.js
 *
 * ONE shared write boundary for the published briefing markdown
 * (data/briefings/briefing-<date>.md), plus the full-rebuild lease check.
 *
 * WHY (2026-07-18 incident, Codex peer review receipt b01aa2ef704f in
 * data/agent/codex-peer-review-results.jsonl): an agent repairing 2 defective
 * cards ran refresh-briefing-generated-sections.js --voice-only, which
 * rewrote the ENTIRE published briefing via fs.writeFileSync and silently
 * dropped the ACTION ITEMS section (live board went 32 tiles / 2 defects to
 * 30 / 4, exit code 0). Nothing at the write boundary compared what was on
 * disk with what was about to replace it.
 *
 * TWO GUARDS LIVE HERE, ON PURPOSE IN ONE FILE so the writers cannot drift:
 *
 * 1. SECTION-PRESERVATION INVARIANT (assertRequiredSectionsPreserved /
 *    guardedWriteBriefingMarkdown): before the published briefing markdown is
 *    replaced, the set of manifest-required section headings present BEFORE
 *    (roster: scripts/lib/briefing-card-manifest.js) is compared with the set
 *    present AFTER. If a previously-present required section would disappear,
 *    the write is ABORTED (the original file is left untouched) and a loud
 *    error names the vanished section. Mutual/one-way merge partners
 *    (manifest `mergedInto`) satisfy a card's presence, so the legitimate
 *    CONTENT PIPELINE <-> VIDEO APPROVAL QUEUE swap never false-aborts.
 *    Used by BOTH markdown writers outside the full 5:30 build:
 *      - scripts/refresh-briefing-generated-sections.js (every write site)
 *      - scripts/refresh-card.js (the splice write + the blockers
 *        reconciliation-line write)
 *
 * 2. FULL-REBUILD LEASE (fullRebuildLease): whole-document briefing writers
 *    (cloud-morning-briefing.js --publish from the CLI, and every
 *    refresh-briefing-generated-sections.js run) require EITHER the
 *    scheduler lease env BRIEFING_SCHEDULED_RUN=1 (ExampleCoed by
 *    scripts/ec2-morning-briefing-run.sh, which also owns the date-level
 *    generation-attempt lease under data/agent/briefing-generation-attempts/,
 *    and passed through by the sanctioned automated spawners) OR the explicit
 *    owner override env BRIEFING_FULL_REBUILD_OK=1. Without either, the
 *    whole-document path refuses and points at the per-card door
 *    (scripts/card-controller.js / scripts/refresh-card.js), which is never
 *    gated.
 */

const fs = require('fs');
const { CARDS, getCardById } = require('./briefing-card-manifest.js');

// Dual heading detection, mirrored VERBATIM from splitMarkdownCards in
// scripts/lib/briefing-card-qc.js (the canonical parser for the published
// briefing format, which demonstrably parses the real production file because
// the QC gate itself runs on it): a markdown `## TITLE` line or a legacy
// `TITLE:` line.
const MARKDOWN_HEADING_RE = /^##\s+(.+?)\s*$/;
const LEGACY_HEADING_RE = /^([A-Z]{2,}[^\n]{0,200}):\s*$/;

function headingTitleText(line) {
  const md = String(line || '').match(MARKDOWN_HEADING_RE);
  if (md) return md[1].trim();
  const legacy = String(line || '').match(LEGACY_HEADING_RE);
  if (legacy) return legacy[1].trim();
  return '';
}

// Manifest matchers are ^-anchored prefix regexes designed against the bare
// title text; the raw heading line is tested too (same widening as
// refresh-card.js findMatchingSectionIndices: it can only ADD matches for a
// heading shape whose normalization diverges, never lose one).
function cardMatches(card, titleText, rawLine) {
  const re = new RegExp(card.match.source, card.match.flags.includes('i') ? 'i' : '');
  return re.test(titleText) || re.test(String(rawLine || ''));
}

// The set of manifest card ids whose section heading is present in the
// markdown. This is the roster the section-preservation invariant compares.
function manifestSectionIdsPresent(markdown) {
  const present = new Set();
  for (const line of String(markdown || '').split('\n')) {
    const titleText = headingTitleText(line);
    if (!titleText) continue;
    for (const card of CARDS) {
      if (present.has(card.id)) continue;
      if (cardMatches(card, titleText, line)) present.add(card.id);
    }
  }
  return present;
}

// Manifest-required sections present BEFORE that would be gone AFTER. A card
// still counts as present when any of its manifest `mergedInto` partners is
// present after the write (the render's own merge semantics: full_life_backup
// surfaces inside system_health; content_pipeline and video_approval_queue
// are an exclusive-or pair).
function vanishedRequiredSections(beforeMarkdown, afterMarkdown) {
  const before = manifestSectionIdsPresent(beforeMarkdown);
  const after = manifestSectionIdsPresent(afterMarkdown);
  const vanished = [];
  for (const id of before) {
    if (after.has(id)) continue;
    const card = getCardById(id);
    const partners = card && Array.isArray(card.mergedInto) ? card.mergedInto : [];
    if (partners.some((partnerId) => after.has(partnerId))) continue;
    vanished.push(id);
  }
  return vanished;
}

// Throws loudly (never warns-and-continues) when the replacement markdown
// drops a manifest-required section that the current file ExampleCos. The caller
// MUST NOT have written anything yet; aborting here leaves the original file
// byte-identical.
function assertRequiredSectionsPreserved(
  beforeMarkdown,
  afterMarkdown,
  { where = 'briefing markdown write' } = {},
) {
  const vanished = vanishedRequiredSections(beforeMarkdown, afterMarkdown);
  if (!vanished.length) return { ok: true, vanished: [] };
  const err = new Error(
    `[briefing-write-guard] ABORT (${where}): this write would DROP ${vanished.length} ` +
      `manifest-required briefing section(s) that the published file currently ExampleCos: ` +
      `${vanished.join(', ')}. The original file was left untouched. ` +
      `This is the 2026-07-18 ACTION ITEMS drop class: a scoped refresh must never ` +
      `vanish an unrelated required card. Refresh one card at a time instead: ` +
      `node scripts/refresh-card.js <cardId> --publish (or node scripts/card-controller.js ` +
      `--mode midday --cards <ids>).`,
  );
  err.code = 'BRIEFING_SECTION_VANISHED';
  err.vanishedSections = vanished;
  throw err;
}

// The single guarded write boundary: read what is on disk, prove the
// replacement preserves every manifest-required section that file ExampleCos,
// and only then hand off to the writer (default: plain utf8 writeFileSync;
// callers with an atomic writer inject it). A missing/unreadable target file
// means there is nothing to preserve, so the write proceeds ungated (first
// publish of the day / bootstrap shells).
function guardedWriteBriefingMarkdown(filePath, nextMarkdown, { where, writer } = {}) {
  let before = null;
  try {
    before = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
  }
  if (before !== null) {
    assertRequiredSectionsPreserved(before, nextMarkdown, { where: where || filePath });
  }
  if (typeof writer === 'function') writer(filePath, nextMarkdown);
  else fs.writeFileSync(filePath, nextMarkdown, 'utf8');
  return { wrote: true, guarded: before !== null };
}

// Whole-document rebuild lease. Scheduler lease (BRIEFING_SCHEDULED_RUN=1) is
// ExampleCoed by ec2-morning-briefing-run.sh -- the same runner that owns the
// date-level generation-attempt lease under
// data/agent/briefing-generation-attempts/ -- and passed through by the
// sanctioned automated spawners. BRIEFING_FULL_REBUILD_OK=1 is the explicit
// owner override for a supervised manual rebuild.
function fullRebuildLease(env = process.env) {
  if (String((env || {}).BRIEFING_SCHEDULED_RUN || '') === '1') {
    return { ok: true, source: 'scheduler-lease' };
  }
  if (String((env || {}).BRIEFING_FULL_REBUILD_OK || '') === '1') {
    return { ok: true, source: 'owner-override' };
  }
  return { ok: false, source: null };
}

module.exports = {
  MARKDOWN_HEADING_RE,
  LEGACY_HEADING_RE,
  headingTitleText,
  manifestSectionIdsPresent,
  vanishedRequiredSections,
  assertRequiredSectionsPreserved,
  guardedWriteBriefingMarkdown,
  fullRebuildLease,
};
