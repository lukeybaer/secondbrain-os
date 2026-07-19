#!/usr/bin/env node
'use strict';
//
// refresh-card.js -- rebuild ONE briefing card by manifest id, splice it into
// the PUBLISHED briefing, run scoped card QC, republish.
//
// WHY: verifying a single-card fix today means a full cloud-morning-briefing.js
// rebuild (10-40 minutes: every news card re-summarizes, every generator
// re-runs). Most fixes touch exactly one card. This tool narrows the rebuild to
// the target card and reuses the SAME assembly/QC/lock/write machinery the
// full build uses, so a
// single-card verification takes about 2 minutes instead.
//
// DESIGN (published-file-as-source-of-truth):
//   1. Read the existing briefing-<date>.md. Split it into sections at heading
//      LINES using the SAME dual-heading detection the canonical QC parser
//      uses (splitMarkdownCards in scripts/lib/briefing-card-qc.js): a
//      markdown `## TITLE` line or a legacy `TITLE:` line
//      (/^([A-Z]{2,}[^\n]{0,200}):\s*$/). The REAL published file is NOT
//      joined with the builder's exact `\n\n---\n\n` delimiter (live evidence
//      2026-07-06: sections separated by `\n\n---\n<HEADING>`, and the
//      preamble runs straight into BLOCKERS with no separator at all), so
//      delimiter-based splitting finds zero sections against production.
//      Heading-based splitting is what QC itself uses on this same file, and
//      this tool tracks exact line spans so untouched sections stay
//      byte-identical through the splice.
//   2. Run buildCloudMorningBriefing with selfHealRefresh + refreshTargets
//      narrowed to the target card id (the SAME narrowing mechanism the
//      self-heal refresh path already uses -- see refreshTargetAllows /
//      SELF_HEAL_REFRESH_CARDS in cloud-morning-briefing.js). This produces a
//      full assembled markdown where only the target card has fresh content;
//      every other card falls through to its own honest fallback inside that
//      throwaway build. The refresh path extracts only the requested target
//      from it. It must never splice those fallback-derived sections into the
//      live briefing.
//   3. Extract the target card's section from the targeted build's output by
//      matching the manifest's own `match` regex against each section's
//      title text AND its raw heading line (never a loose all-caps heading
//      regex -- Codex amendment A1). Require EXACTLY ONE match in both the
//      existing file and the targeted build's output; abort loudly on zero,
//      on duplicates in the existing file (the covid double is live evidence
//      this happens), or on a builder output that produced more than one
//      TITLE-headed section for the id. When the target id has ZERO sections
//      of its own but is half of a MUTUAL manifest merge pair
//      (video_approval_queue <-> content_pipeline: the briefing renders
//      exactly one of the two, and the cloud builder OMITs the other), the
//      partner's single section resolves as the target's live surface --
//      2026-07-06 live evidence: `refresh-card video_approval_queue` ZERO-
//      aborted on both sides because the published file (and the fresh
//      build) legitimately ExampleCod CONTENT PIPELINE instead. One-way merges
//      (full_life_backup -> system_health) never swap.
//   4. Do not import the throwaway build's derived BLOCKERS or SYSTEM HEALTH
//      sections. They describe the throwaway fallback board, not the live
//      board. The only derived write after target proof is the Blockers
//      reconciliation line from the canonical scoped artifact.
//   5. Splice: keep every OTHER existing section byte-for-byte; replace the
//      target section's CONTENT with the freshly built one while
//      preserving each replaced section's own trailing separator chrome
//      (blank lines + `---` lines), so the published file's real separator
//      shape survives the splice byte-for-byte outside the new content.
//   6. Scoped card QC gate (ExampleCo 2026-07-08): this is a card-by-card repair
//      loop, not a whole-document recertification. After the splice, pre-write
//      QC runs only on the target card this tool writes. Unrelated card failures remain
//      visible in the dashboard artifact and the broader live QC result, but
//      they do not veto this card's independent publish. The companion
//      health/blockers checks use the current dedupe contract: System Health
//      owns health-check details and remediation; Blockers may count health
//      failures but must not repeat those rows. If the scoped slice fails,
//      print the scoped failures, exit nonzero, NEVER write.
//   7. On QC pass: acquire the SAME shared briefing lock the full build uses
//      (/tmp/secondbrain-morning-briefing-run.lock via flock -- Codex
//      amendment A2), atomic-write via the existing writeTextAtomic, refresh
//      the publish receipt fields the full build derives (publishState,
//      degradedNotice, renderQcDefectCards), release the lock.
//   8. --verify: after publish, fetch the live rendered dashboard, merge a
//      scoped target result into the canonical dashboard artifact, patch
//      Blockers' reconciliation line from that fresh artifact, and fail
//      the command only when the target card itself is still not clean.
//
// CODEX AMENDMENTS applied (binding, from the 2026-07 design review):
//   A1. Section boundaries by manifest id/matcher, never a loose heading
//       regex; abort loudly on zero/duplicate/multi-header.
//   A2. ONE shared lock (the full build's own lock file), acquired with a
//       short wait; fail honestly if held. Never invent a second lock.
//   A3. Data roots via cloud-morning-briefing's DEFAULT_DATA_DIR resolution
//       (SECONDBRAIN_DATA_DIR / /opt/secondbrain/data / APPDATA fallback).
//       NEVER a REPO_ROOT/data hardcode (the refresh-news-only.js anti-
//       pattern).
//   A4. Publish gate is scoped card QC (qcBriefingMarkdown plus applicable
//       health/blockers dedupe checks) against the target card only, not a
//       whole-document recertification. This
//       keeps the repair loop surgical: unrelated defects stay visible, but
//       cannot block an independent card refresh.
//   A5. Never call notifyBriefingPublished from this tool; never touch the
//       notify dedupe marker.
//
// USAGE:
//   node scripts/refresh-card.js <cardId> [--date YYYY-MM-DD] [--publish]
//        [--data-dir D] [--verify]
//
// EXIT CODES: 0 success. 1 abort (bad card id, section-boundary violation,
// lock contention, scoped card QC failure). 2 usage error.

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

// NOTE: assembleManifestSections/renderBlockersSection/blockedCardEntries/
// deriveNonGreenSubsystemBlockers are intentionally NOT imported here. They
// operate over a full board and a narrow target build marks every other card
// as a fallback. Only MANIFEST_CARD_RENDER is needed directly, to assert a
// card id has a real render mapping before attempting a refresh.
const {
  buildCloudMorningBriefing,
  MANIFEST_CARD_RENDER,
  summarizeCloudNews,
  writeTextAtomic,
  DEFAULT_DATA_DIR,
} = require('./cloud-morning-briefing.js');
const { qcBriefingMarkdown } = require('./lib/briefing-card-qc.js');
const { CARDS, getCardById } = require('./lib/briefing-card-manifest.js');
const { ctDayKeyForInstant } = require('./lib/ct-day.js');
// The health/blockers checks run only on the scoped refresh slice. System
// Health owns health-check rows and remediation; Blockers may count health
// failures but must not repeat those rows.
const {
  checkHealthBlockersConsistency,
  checkHealthBlockersReverseConsistency,
} = require('./validate-briefing-quality.js');
const { numericFaceNeedsDateStamp } = require('./lib/briefing-date-stamp.js');
// Section-preservation invariant at the shared write boundary (2026-07-18
// ACTION ITEMS drop incident): every published-briefing markdown write proves
// it preserves the manifest-required sections the file already ExampleCos, or it
// aborts loudly and leaves the original byte-identical. Shared with
// refresh-briefing-generated-sections.js so the two writers cannot drift.
const { guardedWriteBriefingMarkdown } = require('./lib/briefing-write-guard.js');
// Per-card INDEPENDENT producer hook. For the two cards whose snapshots are
// generated on the desktop shared checkout and shipped to EC2 (uncommitted_parked
// / git-hygiene, system_health / devops-health), refresh THAT card's producer
// snapshot when it is stale BEFORE the card is re-rendered -- never gating or
// touching any sibling card. No-op (skips) for every other card.
const { refreshProducerForCard } = require('./lib/briefing-card-producers.js');
const {
  produceAllCardArtifacts,
  produceCardArtifact,
  writeCardArtifact,
  readCardArtifactUnion,
  writeLiveBoardArtifactFromCardArtifacts,
} = require('./lib/briefing-card-artifacts.js');

// The delimiter buildCloudMorningBriefing joins its own fresh output with
// (`qcSections.join('\n\n---\n\n')`). Still exported for fixture-building,
// but NOT used for splitting: the REAL published file does not carry this
// exact join (see the DESIGN note above), so section boundaries are found by
// heading lines instead -- the same dual detection splitMarkdownCards
// (scripts/lib/briefing-card-qc.js) uses, which demonstrably parses the real
// production file because the QC gate itself runs on it.
const SECTION_DELIMITER = '\n\n---\n\n';

// Dual heading detection, mirrored VERBATIM from splitMarkdownCards in
// scripts/lib/briefing-card-qc.js (the canonical parser for this file
// format): a markdown `## TITLE` line or a legacy `TITLE:` line. Kept as two
// named regexes so a future change to the QC parser has one obvious place to
// mirror into; the refresh-card test suite pins both shapes against a
// real-format fixture.
const MARKDOWN_HEADING_RE = /^##\s+(.+?)\s*$/;
const LEGACY_HEADING_RE = /^([A-Z]{2,}[^\n]{0,200}):\s*$/;

// Extract the normalized title text from a heading line ('' when the line is
// not a heading). This is the SAME string shape the manifest matchers were
// designed against (the manifest doc comment: "match: RegExp tested against
// the rendered, HTML-decoded data-section" -- i.e. the bare title, no `## `
// prefix, no trailing colon).
function headingTitleText(line) {
  const md = String(line || '').match(MARKDOWN_HEADING_RE);
  if (md) return md[1].trim();
  const legacy = String(line || '').match(LEGACY_HEADING_RE);
  if (legacy) return legacy[1].trim();
  return '';
}

// The shared briefing lock. SAME file the full build's cron wrapper
// (ec2-morning-briefing-run.sh) flocks -- Codex amendment A2: one lock, never
// a second one invented for this tool.
const SHARED_LOCK_PATH = '/tmp/secondbrain-morning-briefing-run.lock';
const LOCK_WAIT_SECONDS = 30;

function usageError(msg) {
  console.error(`[refresh-card] ${msg}`);
  console.error(
    'Usage: node scripts/refresh-card.js (--all | <cardId>) [--date YYYY-MM-DD] [--publish] [--data-dir D] [--verify]',
  );
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { all: false, publish: false, verify: false };
  const positionals = [];
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--date') opts.date = argv[++i];
    else if (arg === '--data-dir') opts.dataDir = argv[++i];
    else if (arg === '--publish') opts.publish = true;
    else if (arg === '--verify') opts.verify = true;
    else if (arg === '--all') opts.all = true;
    else if (arg.startsWith('--')) usageError(`ExampleCo flag: ${arg}`);
    else positionals.push(arg);
  }
  if (opts.all && positionals.length) usageError('--all does not accept a <cardId> positional');
  if (!opts.all && positionals.length !== 1)
    usageError('exactly one <cardId> positional argument is required');
  opts.cardId = positionals[0] || null;
  return opts;
}

// Summary/projection cards are not independent all-card controller targets.
// They remain ledger dependencies, but a refresh of another card must not
// splice their fallback content from the narrow throwaway build.
const DERIVED_CARD_IDS = Object.freeze(['blockers', 'system_health']);
const NEWS_SUMMARY_CARD_BY_TARGET = {
  ai_tech_news: 'aitech',
  us_news: 'us',
  world_news: 'world',
  us_immigration_news: 'immigration',
  mortgage_industry_news: 'mortgage',
  covid_news: 'covid',
};
const NEWS_SUMMARY_REFRESH_DEADLINE_MS = 120000;
const NEWS_SUMMARY_REFRESH_MAX_ITEMS = 80;

function normalizeRefreshTargetId(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

function newsSummaryCardKeyForTarget(cardId) {
  return NEWS_SUMMARY_CARD_BY_TARGET[normalizeRefreshTargetId(cardId)] || null;
}

async function prepareTargetedRebuild({
  dataDir,
  date,
  now,
  cardId,
  summarizeNews = summarizeCloudNews,
} = {}) {
  const cardKey = newsSummaryCardKeyForTarget(cardId);
  if (!cardKey || typeof summarizeNews !== 'function') return { skipped: true };
  return summarizeNews({
    dataDir,
    date,
    now,
    cardKeys: [cardKey],
    selfHealRefresh: true,
    maxItemsPerCard: NEWS_SUMMARY_REFRESH_MAX_ITEMS,
    maxTotalItems: NEWS_SUMMARY_REFRESH_MAX_ITEMS,
    deadlineMs: NEWS_SUMMARY_REFRESH_DEADLINE_MS,
  });
}

// Split a full briefing markdown into { preambleLines, sections } where each
// section is { lines, titleText }. Boundaries are heading LINES (dual
// detection above), and every original line lands in exactly one span, so
// [...preambleLines, ...sections.flatMap((s) => s.lines)].join('\n')
// reproduces the input byte-for-byte -- the property the splice relies on to
// keep untouched sections byte-identical. `preambleLines` is everything
// before the first heading (the "# Daily Briefing - ..." block; a `# ` line
// is NOT a section heading), which this tool never touches. Separator chrome
// between sections (`---` lines, blank lines) belongs to the PRECEDING
// section's span.
function splitDocument(markdown) {
  const lines = String(markdown || '').split('\n');
  const preambleLines = [];
  const sections = [];
  let current = null;
  for (const line of lines) {
    const titleText = headingTitleText(line);
    if (titleText) {
      current = { lines: [line], titleText };
      sections.push(current);
      continue;
    }
    if (current) current.lines.push(line);
    else preambleLines.push(line);
  }
  return { preambleLines, sections };
}

// Reassemble what splitDocument produced. Inverse by construction: same
// lines, same order, same '\n' join.
function joinDocument({ preambleLines, sections }) {
  const allLines = [...preambleLines];
  for (const section of sections) allLines.push(...section.lines);
  return allLines.join('\n');
}

// A section's trailing separator chrome: the run of blank and `---`-only
// lines at the END of its span (the inter-section separator bytes that
// heading-based splitting attaches to the preceding section). Preserved
// verbatim when a section's content is replaced, so the published file's
// real separator shape survives the splice regardless of which join the
// fresh builder output used.
function splitTrailingChrome(lines) {
  let end = lines.length;
  while (end > 0) {
    const line = lines[end - 1].trim();
    if (line === '' || /^-{3,}$/.test(line)) end -= 1;
    else break;
  }
  return { contentLines: lines.slice(0, end), chromeLines: lines.slice(end) };
}

function firstVisibleBodyLine(contentLines) {
  return (contentLines || [])
    .slice(1)
    .map((line) => String(line || '').trim())
    .find((line) => line && !/^-{3,}$/.test(line));
}

function withNumericCardAsOfStamp(contentLines, asOfDate) {
  const normalizedDate = /^\d{4}-\d{2}-\d{2}$/.test(String(asOfDate || '')) ? String(asOfDate) : '';
  if (!normalizedDate) return contentLines;
  const body = (contentLines || [])
    .slice(1)
    .map((line) => String(line || '').trim())
    .filter((line) => line && !/^-{3,}$/.test(line))
    .join('\n');
  if (!body) return contentLines;
  if (!numericFaceNeedsDateStamp({ face: body, body })) return contentLines;
  return [...contentLines, '', `As of: ${normalizedDate}.`];
}

function sectionTitleLine(section) {
  return (section && section.lines && section.lines[0]) || '';
}

// Find the sections whose heading matches the manifest card's own `match`
// regex (A1: manifest matcher, never a loose heading regex). The regex is
// tested against BOTH the extracted title text AND the RAW heading line
// (colon and count/amount suffix included, e.g. "VIDEO APPROVAL QUEUE (43):"),
// per the 2026-07-06 production hardening pass: every manifest matcher is a
// ^-anchored prefix with no $ anchor (verified mechanically across all 33
// cards), so raw-line testing can only ADD matches a stripped-title test
// would miss (a header shape whose normalization diverges from what the
// matchers were designed against), never lose one. The stripped title is
// still tested first because markdown "## TITLE" headings carry a "## "
// prefix the ^-anchored matchers would reject on the raw line.
// Returns the matching indices.
function findMatchingSectionIndices(sections, card) {
  const re = new RegExp(card.match.source, card.match.flags.includes('i') ? 'i' : '');
  const indices = [];
  sections.forEach((section, idx) => {
    if (re.test(section.titleText) || re.test(sectionTitleLine(section))) indices.push(idx);
  });
  return indices;
}

// The card's MUTUAL merge partners: manifest cards P where card.mergedInto
// names P AND P.mergedInto names card back. A mutual pair (content_pipeline
// <-> video_approval_queue) is an exclusive-or: the briefing renders exactly
// ONE of the two sections depending on live data (the cloud builder emits
// OMIT_MANIFEST_SECTION for video_approval_queue whenever the pending-video
// manifest has items, and the published file then ExampleCos CONTENT PIPELINE
// -- live evidence 2026-07-06). A ONE-WAY merge (full_life_backup ->
// system_health) is an ABSORB, not an alternative: SYSTEM HEALTH always
// renders as itself and merely inlines the other card's data, so swapping
// would corrupt the document -- one-way merges are deliberately excluded.
function mutualMergePartners(card) {
  if (!card || !Array.isArray(card.mergedInto)) return [];
  return card.mergedInto
    .map((id) => getCardById(id))
    .filter(
      (partner) =>
        partner && Array.isArray(partner.mergedInto) && partner.mergedInto.includes(card.id),
    );
}

// Abort loudly (never silently pick one) on zero or duplicate matches. On
// ZERO matches for the card's own matcher, fall back to its MUTUAL merge
// partners (see mutualMergePartners): the pair renders as one section or the
// other, so the partner's section IS the target card's live surface. Returns
// the single matching index on success.
function requireExactlyOneSection(sections, card, { where }) {
  const indices = findMatchingSectionIndices(sections, card);
  if (indices.length > 1) {
    const titles = indices.map((i) => sectionTitleLine(sections[i])).join(' | ');
    throw new Error(
      `ABORT: ${where} ExampleCos ${indices.length} DUPLICATE sections matching card '${card.id}' (${titles}). Refusing to splice against an ambiguous document -- collapse the duplicate before retrying.`,
    );
  }
  if (indices.length === 1) return indices[0];

  // Zero own-matches: resolve through the mutual merge pair (exclusive-or
  // alternatives). The union across all partners must land on EXACTLY ONE
  // section -- the same A1 discipline, widened to the pair.
  const partners = mutualMergePartners(card);
  const partnerHits = [];
  for (const partner of partners) {
    for (const idx of findMatchingSectionIndices(sections, partner)) {
      partnerHits.push({ idx, partnerId: partner.id });
    }
  }
  if (partnerHits.length === 1) {
    console.log(
      `[refresh-card] card '${card.id}' has no section of its own in ${where}; using its mutual merge partner '${partnerHits[0].partnerId}' (${sectionTitleLine(sections[partnerHits[0].idx]).trim()}) -- the pair renders as one or the other.`,
    );
    return partnerHits[0].idx;
  }
  if (partnerHits.length > 1) {
    const titles = partnerHits.map((h) => sectionTitleLine(sections[h.idx])).join(' | ');
    throw new Error(
      `ABORT: ${where} ExampleCos ZERO sections matching card '${card.id}' and ${partnerHits.length} sections matching its merge partners (${titles}). Refusing to splice against an ambiguous document.`,
    );
  }
  const partnerNote = partners.length
    ? ` (also tried mutual merge partner(s): ${partners.map((p) => p.id).join(', ')})`
    : '';
  throw new Error(
    `ABORT: ${where} ExampleCos ZERO sections matching card '${card.id}' (expected header matching ${card.match})${partnerNote}. Refusing to guess -- the section is missing or the manifest matcher is stale.`,
  );
}

// Extract the section for `cardId` from a builder's fresh assembled markdown
// (built by calling assembleManifestSections directly with a realById scoped
// to just this run). Requires the builder produced EXACTLY ONE TITLE-headed
// section for the id (A1: abort loudly on a multi-header builder output too).
function extractFreshSection(freshSections, card) {
  return sectionsAt(
    freshSections,
    requireExactlyOneSection(freshSections, card, { where: 'the targeted rebuild output' }),
  );
}

function sectionsAt(sections, idx) {
  return sections[idx];
}

// ---------------------------------------------------------------------------
// Lock (Codex amendment A2): the SAME lock file the cron wrapper flocks. On
// Linux, shell out to the real `flock` binary with a short try-wait so this
// tool contends on the identical lock a live cron run would hold -- never a
// second, invented lock. flock is unavailable outside Linux (this tool is
// also exercised in CI/dev on Windows), so off-Linux we fall back to a plain
// in-process no-op lock (single-process test runs have no real contention to
// guard against); the honest failure-on-contention behavior is asserted by a
// regression test that fakes a held lock via a stub flock binary on PATH.
// ---------------------------------------------------------------------------

// The exact line the holder's held command prints to stdout the INSTANT it
// starts running (i.e. the instant flock has actually acquired the lock --
// flock never execs the held command until it acquires). Waiting for this
// line, rather than a fixed settle timeout, is what makes acquisition
// detection correct regardless of how long the real wait takes: a fixed
// timeout cannot distinguish "still trying to acquire" (child alive, still
// inside flock's own wait) from "acquired, now running the held command"
// (child also alive) -- both look identical from process-liveness alone.
const LOCK_ACQUIRED_MARKER = 'REFRESH_CARD_LOCK_ACQUIRED';

// CORRECTNESS FIX (2026-07-06 Codex adversarial review, A2 NO-GO): an earlier
// version of this function only PROBED flock (`flock -w N lockPath -c true`),
// which acquires-and-immediately-releases before fn() ever runs, then relied
// on a SEPARATE sibling marker file for the actual critical section. That
// left a real window where the live cron build's own flock on the SAME
// lockPath could acquire it and start writing WHILE this tool's fn() (read ->
// build -> splice -> write -> receipt -> QC) was still in flight -- exactly
// the race Codex amendment A2 exists to close. A second attempt (settle for a
// fixed delay, then trust "child still alive" as proof of acquisition) was
// ALSO wrong: a child still busy-waiting inside flock's own acquisition loop
// is indistinguishable, by liveness alone, from a child that already
// acquired and is now running the held command -- a regression test proving
// two overlapping refreshes actually serialize caught this (the second
// call's fn() started before the first's had returned). Fixed here with a
// readiness SIGNAL instead of a timing guess: `flock -w waitSeconds lockPath
// sh -c 'echo <marker>; exec cat'` -- flock only execs the sh command after
// it has acquired, so the marker line on stdout is proof of real acquisition,
// not a race-prone inference. We wait (bounded by waitSeconds plus a small
// margin for process-spawn overhead) for either the marker or the holder
// exiting first; then run fn() while the child holds the lock; then close
// the child's stdin (cat sees EOF, exits, and the kernel releases the flock)
// as the primary release path, with SIGTERM/SIGKILL as a bounded fallback if
// it does not exit promptly.
async function withSharedBriefingLock(
  fn,
  {
    lockPath = SHARED_LOCK_PATH,
    waitSeconds = LOCK_WAIT_SECONDS,
    platform = process.platform,
    // Injectable ONLY for tests: the real CLI path always uses ['flock'] as
    // the spawned command and ['sh', '-c', `echo ${marker}; exec cat`] as the
    // held command it execs. Node's child_process.spawn on Windows cannot
    // resolve a bare executable name to a same-directory .cmd shim without
    // shell:true (a Windows-spawn quirk, unrelated to production, which only
    // ever runs this branch on real Linux), so tests that want to exercise
    // the ACTUAL holder-process serialization logic on a Windows dev box
    // point flockCommand at ['node', '<stub-script>.js', ...] instead of
    // fighting that platform quirk with shell:true (which would also change
    // argument-quoting semantics versus production). heldCommand tests still
    // MUST print LOCK_ACQUIRED_MARKER to stdout the instant they start and
    // then block until stdin closes, to preserve the real readiness-signal
    // contract this function depends on.
    flockCommand = ['flock'],
    heldCommand = ['sh', '-c', `echo ${LOCK_ACQUIRED_MARKER}; exec cat`],
  } = {},
) {
  if (platform !== 'linux') {
    // No flock on this platform: run inline. Documented, not silent -- callers
    // (and the --publish path) print this so a Windows dev run is never
    // mistaken for having proven lock safety.
    console.warn(
      `[refresh-card] platform=${platform}: flock is unavailable, running WITHOUT the shared briefing lock. This is expected in local/dev use; production (Linux/EC2) always takes the real lock.`,
    );
    return fn();
  }
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  const [flockBin, ...flockLeadingArgs] = flockCommand;
  const holder = spawn(
    flockBin,
    [...flockLeadingArgs, '-w', String(waitSeconds), lockPath, ...heldCommand],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );

  let holderExited = false;
  let holderExitInfo = null;
  holder.once('exit', (code, signal) => {
    holderExited = true;
    holderExitInfo = { code, signal };
  });
  let holderSpawnError = null;
  holder.once('error', (e) => {
    holderSpawnError = e;
  });

  // Race: the marker line appears on stdout (real acquisition) vs. the
  // holder exiting first (flock's wait expired, or the held command could
  // not start) vs. a spawn error (e.g. the flock binary itself is missing --
  // resolved IMMEDIATELY, not left to the hard timeout below, since a Node
  // spawn failure fires ONLY an 'error' event with no matching 'exit') vs. a
  // hard timeout bound (waitSeconds plus generous spawn-overhead margin) as a
  // last-resort safety net so this can never hang forever even if flock's own
  // -w contract were somehow violated.
  const acquired = await new Promise((resolve) => {
    let stdoutBuf = '';
    const onStdout = (chunk) => {
      stdoutBuf += chunk.toString('utf8');
      if (stdoutBuf.includes(LOCK_ACQUIRED_MARKER)) {
        holder.stdout.removeListener('data', onStdout);
        resolve(true);
      }
    };
    holder.stdout.on('data', onStdout);
    holder.once('exit', () => resolve(false));
    holder.once('error', () => resolve(false));
    setTimeout(() => resolve(false), waitSeconds * 1000 + 5000).unref();
  });

  if (holderSpawnError) {
    throw new Error(
      `ABORT: could not invoke flock to acquire the shared briefing lock (${lockPath}): ${holderSpawnError.message}`,
    );
  }
  if (!acquired) {
    // Either the holder exited before signaling acquisition (flock's own
    // wait expired without acquiring -- another run, cron or another
    // refresh-card.js, holds the lock), or the hard timeout fired without
    // ever seeing the marker. Either way, we never proved acquisition --
    // abort loudly, never proceed as if we had it. Clean up a still-alive
    // but unconfirmed holder rather than leaking it.
    if (!holderExited) {
      try {
        holder.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
    const detail = holderExitInfo
      ? `exit code=${holderExitInfo.code} signal=${holderExitInfo.signal}`
      : 'never confirmed (hard timeout)';
    throw new Error(
      `ABORT: the shared briefing lock (${lockPath}) is held by another run (flock holder did not signal acquisition, ${detail}, after waiting up to ${waitSeconds}s). Refusing to proceed -- retry once the other run finishes.`,
    );
  }

  const releaseHolder = () =>
    new Promise((resolve) => {
      if (holderExited) {
        resolve();
        return;
      }
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      holder.once('exit', done);
      try {
        holder.stdin.end(); // cat sees EOF and exits, releasing the flock.
      } catch {
        /* holder may already be gone */
      }
      // Bounded fallback: if closing stdin does not end the holder promptly
      // (e.g. it is wedged), escalate to SIGTERM then SIGKILL rather than
      // leaking a lock-holding process indefinitely.
      setTimeout(() => {
        if (settled) return;
        try {
          holder.kill('SIGTERM');
        } catch {
          /* already gone */
        }
      }, 2000).unref();
      setTimeout(() => {
        if (settled) return;
        try {
          holder.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        done();
      }, 5000).unref();
    });

  try {
    return await fn();
  } finally {
    await releaseHolder();
  }
}

// ---------------------------------------------------------------------------
// Core refresh
// ---------------------------------------------------------------------------

function markdownPathFor(dataDir, date) {
  return path.join(dataDir, 'briefings', `briefing-${date}.md`);
}

function receiptPathFor(dataDir, date) {
  return path.join(dataDir, 'agent', `briefing-publish-receipt-${date}.json`);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function liveCardBadgeLineFromArtifact(artifact) {
  const rawCount = Number(artifact && artifact.defectiveCardCount);
  const count = Number.isFinite(rawCount) && rawCount >= 0 ? rawCount : 0;
  const ts = (artifact && artifact.ts) || new Date().toISOString();
  return `Live card badge count: ${count} defective card(s) as of ${ts} (source: dashboard-qc-result.json); Blockers issue count is blocker rows plus individual System Health failures.`;
}

function blockersCleanVerdictLineFromArtifact(artifact) {
  const rawCount = Number(artifact && artifact.defectiveCardCount);
  const count = Number.isFinite(rawCount) && rawCount >= 0 ? rawCount : 0;
  if (count > 0) {
    return `Clean? no. Live dashboard QC reports ${count} defective card(s) for this briefing. See live card badges and System Health for detail.`;
  }
  return 'Clean? yes. Live dashboard QC reports 0 survived defects for this briefing.';
}

function refreshBlockersReconciliationLine(markdown, artifact) {
  const nextLine = liveCardBadgeLineFromArtifact(artifact);
  const lineRe = /^Live card badge count: .*$/m;
  const cleanLineRe = /^Clean\? (?:yes|no)\. Live dashboard QC reports .*$/m;
  let next = markdown;
  if (cleanLineRe.test(next)) {
    next = next.replace(cleanLineRe, blockersCleanVerdictLineFromArtifact(artifact));
  }
  if (lineRe.test(next)) next = next.replace(lineRe, nextLine);
  return next;
}

function refreshPublishedBlockersReconciliationLine({ markdownPath, artifact }) {
  if (!markdownPath || !artifact) return false;
  if (!fs.existsSync(markdownPath)) return false;
  const current = fs.readFileSync(markdownPath, 'utf8');
  const next = refreshBlockersReconciliationLine(current, artifact);
  if (next === current) return false;
  guardedWriteBriefingMarkdown(markdownPath, next, {
    where: 'refresh-card blockers reconciliation line',
    writer: writeTextAtomic,
  });
  return true;
}

// ---------------------------------------------------------------------------
// Scoped QC gate helpers (pure; exported for tests).
//
// WHY SCOPED (2026-07-08): a targeted card refresh is not a full briefing
// recertification. The gate is exactly the target this tool writes. Blockers
// receives its canonical reconciliation line only after scoped live proof;
// System Health is its own target when it needs a repair. Unrelated cards can
// remain red in the canonical live artifact, but they cannot veto a clean
// independent publish. This is the repair unit the self-heal loop reasons
// about: one card, one refresh, one card-level live QC result.
// ---------------------------------------------------------------------------

// Normalize a failure message into a comparison key: digit runs collapse to
// 'N' (counts, dates, times, dollar amounts all vary run-to-run without the
// failure being NEW -- "has 2/5 articles" -> "has N/N articles") and
// whitespace collapses, so the before/after comparison is on the failure
// CATEGORY, never on a raw string that embeds a count or timestamp.
function normalizeFailureKey(failure) {
  return String(failure || '')
    .replace(/\d+/g, 'N')
    .replace(/\s+/g, ' ')
    .trim();
}

// The failures in `afterFailures` whose normalized key does not appear in
// `beforeFailures` -- i.e. the failures the splice INTRODUCED. Empty array
// means the splice is publishable (it reduced or merely ExampleCod the
// pre-existing set).
function newFailuresAfterSplice(beforeFailures, afterFailures) {
  const beforeKeys = new Set((beforeFailures || []).map(normalizeFailureKey));
  return (afterFailures || []).filter((f) => !beforeKeys.has(normalizeFailureKey(f)));
}

function scopedCardIdsForRefresh(cardId) {
  const card = getCardById(cardId);
  const targetId = card ? card.id : String(cardId || '');
  return targetId ? [targetId] : [];
}

function scopedMarkdownForCardIds(markdown, cardIds) {
  const doc = splitDocument(markdown);
  if (doc.sections.length === 0) {
    throw new Error('ABORT: the briefing markdown has no recognizable sections for scoped QC.');
  }
  const sections = [];
  const seenSectionIdx = new Set();
  for (const id of cardIds || []) {
    const card = getCardById(id);
    if (!card) continue;
    const idx = requireExactlyOneSection(doc.sections, card, {
      where: 'the scoped QC slice',
    });
    if (seenSectionIdx.has(idx)) continue;
    seenSectionIdx.add(idx);
    sections.push(doc.sections[idx]);
  }
  if (sections.length === 0) {
    throw new Error('ABORT: scoped QC found zero matching card sections.');
  }
  return joinDocument({ preambleLines: doc.preambleLines, sections });
}

function scopedRefreshFailures(markdown, cardIds) {
  const scopedMarkdown = scopedMarkdownForCardIds(markdown, cardIds);
  const presentation = qcBriefingMarkdown(scopedMarkdown);
  return [
    ...((presentation && presentation.failures) || []),
    ...checkHealthBlockersConsistency(scopedMarkdown),
    ...checkHealthBlockersReverseConsistency(scopedMarkdown),
  ];
}

// Pure core: given the EXISTING markdown and a targeted rebuild's fresh
// markdown, splice exactly the requested card into the existing document.
// The narrow builder's other sections are fallback projections, not current
// live state, and must not leak into the board. Returns { markdown,
// replacedIds } or throws on any A1 boundary violation. Exported (as
// spliceCard) so tests exercise this without touching the filesystem.
function spliceCard(existingMarkdown, freshMarkdown, cardId, opts = {}) {
  const card = getCardById(cardId);
  if (!card) {
    throw new Error(
      `ABORT: '${cardId}' is not a known manifest card id. See scripts/lib/briefing-card-manifest.js for the valid id list.`,
    );
  }
  if (!MANIFEST_CARD_RENDER[card.id]) {
    throw new Error(
      `ABORT: manifest card '${cardId}' has no render mapping in cloud-morning-briefing.js (MANIFEST_CARD_RENDER) -- this is a drift bug, not something this tool can refresh.`,
    );
  }

  const existing = splitDocument(existingMarkdown);
  if (existing.sections.length === 0) {
    throw new Error(
      'ABORT: the existing briefing markdown has no recognizable sections to splice into.',
    );
  }
  const fresh = splitDocument(freshMarkdown);
  if (fresh.sections.length === 0) {
    throw new Error('ABORT: the targeted rebuild produced no recognizable sections.');
  }

  const idsToSplice = [card.id];

  const sections = [...existing.sections];
  const replacedIds = [];
  for (const id of idsToSplice) {
    const targetCard = getCardById(id);
    if (!targetCard) continue; // defensive only; card.id was validated above.
    const existingIdx = requireExactlyOneSection(sections, targetCard, {
      where: 'the existing published briefing',
    });
    const freshSection = extractFreshSection(fresh.sections, targetCard);
    // Replace the section's CONTENT but preserve ITS OWN trailing separator
    // chrome: the published file's real inter-section bytes (blank + `---`
    // lines) stay exactly as they were, and the fresh builder output's own
    // chrome (a possibly different join) is discarded with its throwaway
    // document.
    const { chromeLines } = splitTrailingChrome(sections[existingIdx].lines);
    const { contentLines } = splitTrailingChrome(freshSection.lines);
    sections[existingIdx] = {
      lines: [...withNumericCardAsOfStamp(contentLines, opts.asOfDate), ...chromeLines],
      titleText: freshSection.titleText,
    };
    replacedIds.push(id);
  }

  const splicedMarkdown = joinDocument({ preambleLines: existing.preambleLines, sections });
  return { markdown: splicedMarkdown, replacedIds };
}

// Build the targeted (narrowed) rebuild: the SAME buildCloudMorningBriefing
// the full build calls, with selfHealRefresh + refreshTargets narrowed to the
// one card id via the EXISTING self-heal-refresh gating mechanism
// (refreshTargetAllows / SELF_HEAL_REFRESH_CARDS), so only the target card's
// real generator runs; every other card falls to its own honest fallback
// inside this throwaway build. The splice reads only the requested target.
function buildTargetedRebuild({ dataDir, date, now, cardId }) {
  return buildCloudMorningBriefing({
    dataDir,
    date,
    now,
    selfHealRefresh: true,
    refreshTargets: [cardId],
  });
}

async function refreshCard({
  cardId,
  date,
  dataDir,
  publish,
  verify,
  // Injectable ONLY for tests: the real CLI path always uses the default
  // (the actual targeted rebuild against buildCloudMorningBriefing, which is
  // genuinely slow -- it shells out to aws/pm2/df/python for health probing
  // regardless of data-dir content). Tests substitute a fast synthetic
  // builder here to exercise refreshCard's OWN orchestration (lock scope,
  // scoped QC gate, receipt fields, QC-failure-blocks-write)
  // without paying for a real multi-minute build.
  buildFn = buildTargetedRebuild,
  prepareFn = prepareTargetedRebuild,
  // Injectable ONLY for tests: the real CLI path always uses the actual
  // producer hook. For the two desktop-generated-snapshot cards it regenerates
  // + ships that card's snapshot when stale; for every other card it is a cheap
  // no-op (no matching producer). Tests inject a spy/stub so no git/scp runs.
  refreshProducerFn = refreshProducerForCard,
} = {}) {
  const card = getCardById(cardId);
  if (!card) {
    console.error(`[refresh-card] '${cardId}' is not a known manifest card id.`);
    console.error(`Known ids: ${CARDS.map((c) => c.id).join(', ')}`);
    process.exitCode = 1;
    return null;
  }

  // Card-skill context (per-card skill system, 2026-07-06): print the card's
  // curated 1-pager + last-10 learnings at run start so any human or agent
  // driving a refresh sees the accumulated per-card knowledge BY DEFAULT
  // (injection, not discipline). Additive and non-fatal: a missing page or
  // reader error never blocks the refresh, and no heal/refresh logic changes.
  try {
    const { formatCardSkillContext } = require('./lib/card-skills.js');
    const cardSkillContext = formatCardSkillContext(cardId);
    if (cardSkillContext) console.log(cardSkillContext);
  } catch (e) {
    console.warn(`[refresh-card] card-skill context unavailable: ${(e && e.message) || e}`);
  }

  const now = new Date();
  const markdownPath = markdownPathFor(dataDir, date);

  // Codex amendment A2: ONE shared briefing lock around the WHOLE critical
  // section -- read -> build -> splice -> write -> receipt -> QC -- not just
  // the final write. Reading existingMarkdown before acquiring the lock would
  // let a concurrent real cron build publish a fresher briefing in the
  // window between our read and our write; spliceCard would then be computed
  // against a stale base and our locked write would clobber the newer
  // content. Taking the lock before the read closes that race.
  const doRefresh = async () => {
    await prepareFn({ dataDir, date, now, cardId });

    // Independent per-card producer refresh (breakpoint 3). If THIS card has a
    // desktop-generated snapshot producer (git-hygiene / devops-health) and that
    // snapshot is stale, regenerate + ship JUST this card's snapshot before the
    // re-render below reads it. Non-fatal by contract: a producer error (or the
    // EC2 file-deploy where it cannot run) never blocks the refresh -- the card's
    // own honest freshness labelling still governs what renders. Sibling cards
    // are never touched.
    try {
      const producerResult = await refreshProducerFn({
        cardId,
        dataDir,
        now: now.getTime(),
        logger: console,
      });
      if (producerResult && producerResult.error) {
        console.warn(
          `[refresh-card] producer refresh for '${cardId}' reported: ${producerResult.error} (non-fatal; card labels its own freshness)`,
        );
      }
    } catch (e) {
      console.warn(
        `[refresh-card] producer refresh for '${cardId}' threw (non-fatal): ${(e && e.message) || e}`,
      );
    }

    const existingMarkdown = fs.readFileSync(markdownPath, 'utf8');

    console.log(`[refresh-card] rebuilding card='${cardId}' date=${date} dataDir=${dataDir}`);
    const fresh = buildFn({ dataDir, date, now, cardId });

    let spliced;
    try {
      spliced = spliceCard(existingMarkdown, fresh.markdown, cardId, { asOfDate: date });
    } catch (e) {
      console.error((e && e.message) || String(e));
      process.exitCode = 1;
      return null;
    }
    console.log(`[refresh-card] spliced sections: ${spliced.replacedIds.join(', ')}`);

    const scopedCardIds = scopedCardIdsForRefresh(cardId);
    let scopedFailures;
    try {
      scopedFailures = scopedRefreshFailures(spliced.markdown, scopedCardIds);
    } catch (e) {
      console.error((e && e.message) || String(e));
      process.exitCode = 1;
      return null;
    }
    if (scopedFailures.length) {
      console.error(
        `[refresh-card] scoped card QC gate FAILED for ${scopedCardIds.join(', ')}: ${scopedFailures.length} failure(s). Not writing:`,
      );
      for (const f of scopedFailures) console.error(`  - ${f}`);
      process.exitCode = 1;
      return null;
    }
    console.log(`[refresh-card] scoped card QC gate PASS (${scopedCardIds.join(', ')})`);

    guardedWriteBriefingMarkdown(markdownPath, spliced.markdown, {
      where: `refresh-card splice card='${cardId}'`,
      writer: writeTextAtomic,
    });
    console.log(`[refresh-card] wrote ${markdownPath}`);

    if (publish) {
      // Refresh the publish receipt fields the full build derives, so the
      // receipt reflects the new content (Codex design item 2). We do NOT
      // call notifyBriefingPublished (Codex amendment A5) and we do NOT touch
      // the notify dedupe marker.
      const receiptPath = receiptPathFor(dataDir, date);
      const previousReceipt = readJson(receiptPath, {});
      const receipt = {
        ...previousReceipt,
        date,
        generatedAt: now.toISOString(),
        generator: 'refresh-card',
        markdownPath,
        // The scoped gate passed (we only reach the receipt after the write),
        // so this targeted publish is ready. Other cards may still be red in
        // the canonical live artifact; they stay visible there, not here.
        publishState: 'ready',
        qc: {
          ok: true,
          gate: 'scoped-card',
          scopedCardIds,
          scopedFailures: [],
        },
        canonicalValidation: {
          ok: true,
          skipped:
            'refresh-card uses scoped card QC; full canonical validation is owned by full publish/live QC.',
          status: 0,
          failureCount: 0,
          failures: [],
        },
        renderQcDefectCards: previousReceipt.renderQcDefectCards || [],
        degradedNotice: null,
        refreshedCard: cardId,
        refreshedSections: spliced.replacedIds,
      };
      writeJsonAtomic(receiptPath, receipt);
      console.log(
        `[refresh-card] updated receipt ${receiptPath} (publishState=${receipt.publishState})`,
      );
    }
    return spliced;
  };

  const spliced = await withSharedBriefingLock(doRefresh);
  if (!spliced) return null;

  if (verify) {
    await runVerify({ cardId, date, dataDir });
  }
  return spliced;
}

// --verify: after publish, run the single-card slice of the live render QC.
// verify-dashboard-cards-live.js already computes per-card cardStatuses for
// every manifest card in one pass; rather than adding a --card CLI filter to
// that file (Codex's stated escape hatch: "add it if trivial, else run whole
// and report just the target card's status"), we require it in-process and
// filter its OWN result to the one card we care about, since verifyDashboard
// and fetchLiveHtml are already exported for exactly this kind of reuse
// (runDashboardRenderQc in cloud-morning-briefing.js does the same thing).
async function runVerify({ cardId, date, dataDir }) {
  let liveQc;
  try {
    liveQc = require('./verify-dashboard-cards-live.js');
  } catch (e) {
    console.error(
      `[refresh-card] --verify: live render QC module unavailable: ${(e && e.message) || e}`,
    );
    process.exitCode = 1;
    return;
  }
  let fetched;
  try {
    fetched = liveQc.fetchLiveHtml({ date });
  } catch (e) {
    console.error(`[refresh-card] --verify: fetch threw: ${(e && e.message) || e}`);
    process.exitCode = 1;
    return;
  }
  if (!fetched || fetched.unreachable || !fetched.html) {
    console.error(
      `[refresh-card] --verify: dashboard unreachable (source=${(fetched && fetched.source) || 'ExampleCo'}). This is a retry condition, not a card defect.`,
    );
    process.exitCode = 1;
    return;
  }
  const result = liveQc.verifyDashboard(fetched.html, date);
  if (result.status === 'parse-failed') {
    console.error('[refresh-card] --verify: dashboard render QC could not parse any tiles.');
    process.exitCode = 1;
    return;
  }
  const cardStatus = (result.cardStatuses || []).find((c) => c.id === cardId);
  if (!cardStatus) {
    console.error(`[refresh-card] --verify: card '${cardId}' not found in live render QC output.`);
    process.exitCode = 1;
    return;
  }
  const scopedCardIds = scopedCardIdsForRefresh(cardId);
  const scopedResult =
    typeof liveQc.scopeDashboardResult === 'function'
      ? liveQc.scopeDashboardResult(result, scopedCardIds)
      : result;
  if (typeof liveQc.writeCanonicalArtifactFromResult === 'function') {
    const { artifact, absPath } = liveQc.writeCanonicalArtifactFromResult(scopedResult, {
      date,
      dataDir,
    });
    console.log(
      `[refresh-card] --verify: wrote canonical dashboard artifact ${absPath} (defectiveCardCount=${artifact.defectiveCardCount}, scoped=${scopedCardIds.join(',')})`,
    );
    try {
      const markdownPath = markdownPathFor(dataDir, date);
      const changed = await withSharedBriefingLock(() =>
        refreshPublishedBlockersReconciliationLine({ markdownPath, artifact }),
      );
      if (changed) {
        console.log(
          '[refresh-card] --verify: refreshed Blockers live badge line from canonical artifact',
        );
      }
    } catch (e) {
      console.error(
        `[refresh-card] --verify: failed to refresh Blockers live badge line: ${(e && e.message) || e}`,
      );
      process.exitCode = 1;
      return;
    }
  } else {
    console.warn(
      '[refresh-card] --verify: live QC module cannot write the canonical artifact; dashboard badges may remain stale.',
    );
  }
  console.log(`[refresh-card] --verify: card='${cardId}' status=${cardStatus.status}`);
  if (cardStatus.status !== 'clean') {
    for (const d of cardStatus.defects) console.error(`  - ${d}`);
    process.exitCode = 1;
  }
}

function summarizeArtifactPublish(artifacts) {
  const counts = { clean: 0, blocked: 0, defect: 0, stale: 0 };
  for (const artifact of artifacts || []) {
    const key = counts[artifact.status] === undefined ? 'defect' : artifact.status;
    counts[key] += 1;
  }
  return `clean=${counts.clean} blocked=${counts.blocked} defect=${counts.defect} stale=${counts.stale}`;
}

async function publishArtifactUnion({ dataDir, date, refreshedCardId = '', now = new Date() }) {
  const union = readCardArtifactUnion({ dataDir, date, allowMarkdownFallback: true });
  const board = writeLiveBoardArtifactFromCardArtifacts({
    dataDir,
    date,
    artifacts: union.artifacts,
    refreshedCardId,
    now,
  });
  return { union, board };
}

async function refreshOneCardArtifact({ cardId, date, dataDir, publish, verify } = {}) {
  const artifact = await produceCardArtifact({ cardId, date, dataDir });
  const artifactPath = writeCardArtifact({ dataDir, date, artifact });
  console.log(
    `[refresh-card] produced artifact card='${cardId}' status=${artifact.status} path=${artifactPath}`,
  );
  if (publish) {
    const { union, board } = await publishArtifactUnion({ dataDir, date, refreshedCardId: cardId });
    console.log(
      `[refresh-card] published artifact union cards=${union.artifacts.length} ${summarizeArtifactPublish(
        union.artifacts,
      )} board=${board.absPath}`,
    );
  }
  if (verify && artifact.status !== 'clean') {
    console.error(
      `[refresh-card] --verify: card='${cardId}' status=${artifact.status}; artifact is honest but not clean.`,
    );
    process.exitCode = 1;
  }
  return artifact;
}

async function refreshAllCardArtifacts({ date, dataDir, publish, verify } = {}) {
  const result = await produceAllCardArtifacts({ dataDir, date });
  console.log(
    `[refresh-card] produced all card artifacts cards=${result.artifacts.length} ${summarizeArtifactPublish(
      result.artifacts,
    )}`,
  );
  if (publish) {
    console.log(`[refresh-card] published artifact union board=${result.board.absPath}`);
  }
  if (verify) {
    const union = readCardArtifactUnion({ dataDir, date, allowMarkdownFallback: false });
    if (union.artifacts.length !== CARDS.length) {
      console.error(
        `[refresh-card] --verify: expected ${CARDS.length} card artifacts, found ${union.artifacts.length}`,
      );
      process.exitCode = 1;
    } else {
      console.log('[refresh-card] --verify: every manifest card has an artifact');
    }
  }
  return result;
}

function main() {
  const opts = parseArgs(process.argv);
  // Default to the America/Chicago calendar date, never the UTC one: between
  // 7 PM and midnight CT the UTC date is already "tomorrow", so a UTC default
  // would target a briefing file that does not exist yet. Explicit --date wins.
  const date = opts.date || ctDayKeyForInstant();
  const dataDir = opts.dataDir || DEFAULT_DATA_DIR;
  const task = opts.all
    ? refreshAllCardArtifacts({ date, dataDir, publish: opts.publish, verify: opts.verify })
    : refreshOneCardArtifact({
        cardId: opts.cardId,
        date,
        dataDir,
        publish: opts.publish,
        verify: opts.verify,
      });
  task.catch((err) => {
    console.error(`[refresh-card] failed: ${(err && err.message) || err}`);
    process.exitCode = 1;
  });
}

if (require.main === module) main();

module.exports = {
  parseArgs,
  splitDocument,
  joinDocument,
  splitTrailingChrome,
  firstVisibleBodyLine,
  withNumericCardAsOfStamp,
  headingTitleText,
  sectionTitleLine,
  findMatchingSectionIndices,
  mutualMergePartners,
  requireExactlyOneSection,
  normalizeFailureKey,
  newFailuresAfterSplice,
  scopedCardIdsForRefresh,
  scopedMarkdownForCardIds,
  scopedRefreshFailures,
  liveCardBadgeLineFromArtifact,
  refreshBlockersReconciliationLine,
  refreshPublishedBlockersReconciliationLine,
  spliceCard,
  buildTargetedRebuild,
  prepareTargetedRebuild,
  newsSummaryCardKeyForTarget,
  withSharedBriefingLock,
  refreshCard,
  refreshOneCardArtifact,
  refreshAllCardArtifacts,
  runVerify,
  markdownPathFor,
  receiptPathFor,
  MANIFEST_CARD_RENDER,
  SECTION_DELIMITER,
  SHARED_LOCK_PATH,
  DERIVED_CARD_IDS,
  LOCK_ACQUIRED_MARKER,
};
