#!/usr/bin/env node
'use strict';
//
// refresh-card.js -- rebuild ONE briefing card by manifest id, splice it into
// the PUBLISHED briefing, re-QC the whole document, republish.
//
// WHY: verifying a single-card fix today means a full cloud-morning-briefing.js
// rebuild (10-40 minutes: every news card re-summarizes, every generator
// re-runs). Most fixes touch exactly one card. This tool narrows the rebuild to
// the target card (plus the cards that must always move with it) and reuses
// the SAME assembly/QC/lock/write machinery the full build uses, so a
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
//      full assembled markdown where only the target card (plus the
//      ALWAYS_REFRESH_FLOOR cards and the two derived cards below) has fresh
//      content; every other card falls through to ITS OWN honest blocker
//      inside that throwaway build -- we never use those honest-blocker
//      fallbacks, only the ONE section we asked for.
//   3. Extract the target card's section from the targeted build's output by
//      matching the manifest's own `match` regex against each section's
//      title line (never a loose all-caps heading regex -- Codex amendment
//      A1). Require EXACTLY ONE match in both the existing file and the
//      targeted build's output; abort loudly on zero, on duplicates in the
//      existing file (the covid double is live evidence this happens), or on
//      a builder output that produced more than one TITLE-headed section for
//      the id.
//   4. ALSO extract + replace the two DERIVED sections that must move with any
//      target: BLOCKERS (renderBlockersSection / blockedCardEntries /
//      deriveNonGreenSubsystemBlockers already ran inside the targeted build,
//      keyed off ITS OWN realById -- see caveat below) and SYSTEM HEALTH, so
//      the two-way health/blockers consistency invariant
//      (checkHealthBlockersConsistency + reverse) stays green after the
//      splice.
//   5. Splice: keep every OTHER existing section byte-for-byte; replace the
//      target + derived sections' CONTENT with the freshly built ones while
//      preserving each replaced section's own trailing separator chrome
//      (blank lines + `---` lines), so the published file's real separator
//      shape survives the splice byte-for-byte outside the new content.
//   6. Whole-document QC gate (Codex amendment A4): qcBriefingMarkdown() +
//      the canonical validator (runCanonicalBriefingValidator, which runs
//      checkHealthBlockersConsistency/reverse among everything else) against
//      the SPLICED document. On failure: print failures, exit nonzero,
//      NEVER write.
//   7. On QC pass: acquire the SAME shared briefing lock the full build uses
//      (/tmp/secondbrain-morning-briefing-run.lock via flock -- Codex
//      amendment A2), atomic-write via the existing writeTextAtomic, refresh
//      the publish receipt fields the full build derives (publishState,
//      degradedNotice, renderQcDefectCards), release the lock.
//   8. --verify: after publish, fetch the live rendered dashboard and report
//      just the target card's live render-QC status (verify-dashboard-cards-
//      live.js already returns per-card cardStatuses; no changes needed to
//      that file for this -- Codex's "add a --card filter if trivial, else
//      run whole and report just the target card" escape hatch taken here).
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
//   A4. Publish gate is the WHOLE-markdown QC (qcBriefingMarkdown +
//       checkHealthBlockersConsistency/reverse via the canonical validator)
//       run against the SPLICED document, not just the new section.
//   A5. Never call notifyBriefingPublished from this tool; never touch the
//       notify dedupe marker.
//
// USAGE:
//   node scripts/refresh-card.js <cardId> [--date YYYY-MM-DD] [--publish]
//        [--data-dir D] [--verify]
//
// EXIT CODES: 0 success. 1 abort (bad card id, section-boundary violation,
// lock contention, whole-doc QC failure). 2 usage error.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// NOTE: assembleManifestSections/renderBlockersSection/blockedCardEntries/
// deriveNonGreenSubsystemBlockers are NOT imported here even though the
// design notes above reference them: this tool never calls them directly.
// The BLOCKERS and SYSTEM HEALTH derived sections are instead extracted
// verbatim from the targeted rebuild's OWN output (buildTargetedRebuild ->
// buildCloudMorningBriefing, which already re-derives them internally via
// those functions keyed off its own realById) -- see extractFreshSection /
// DERIVED_CARD_IDS below. Only MANIFEST_CARD_RENDER is needed directly, to
// assert a card id has a real render mapping before attempting a refresh.
const {
  buildCloudMorningBriefing,
  MANIFEST_CARD_RENDER,
  writeTextAtomic,
  DEFAULT_DATA_DIR,
  runCanonicalBriefingValidator,
  mergeCanonicalQc,
} = require('./cloud-morning-briefing.js');
const { qcBriefingMarkdown } = require('./lib/briefing-card-qc.js');
const { CARDS, getCardById } = require('./lib/briefing-card-manifest.js');

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
    'Usage: node scripts/refresh-card.js <cardId> [--date YYYY-MM-DD] [--publish] [--data-dir D] [--verify]',
  );
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { publish: false, verify: false };
  const positionals = [];
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--date') opts.date = argv[++i];
    else if (arg === '--data-dir') opts.dataDir = argv[++i];
    else if (arg === '--publish') opts.publish = true;
    else if (arg === '--verify') opts.verify = true;
    else if (arg.startsWith('--')) usageError(`ExampleCo flag: ${arg}`);
    else positionals.push(arg);
  }
  if (positionals.length !== 1) usageError('exactly one <cardId> positional argument is required');
  opts.cardId = positionals[0];
  return opts;
}

// The two cards that must ALWAYS re-derive alongside any target: BLOCKERS
// (every card-level hard-block + non-green-subsystem blocker must reflect the
// freshly rebuilt target) and SYSTEM HEALTH (the roster the blockers set-diff
// is checked against). Re-deriving them from the SAME targeted build's own
// realById/blockers state -- rather than leaving them untouched -- is what
// keeps checkHealthBlockersConsistency / Reverse green after the splice.
const DERIVED_CARD_IDS = ['blockers', 'system_health'];

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

function sectionTitleLine(section) {
  return (section && section.lines && section.lines[0]) || '';
}

// Find the sections whose extracted TITLE TEXT matches the manifest card's
// own `match` regex (A1: manifest matcher, never a loose heading regex).
// Returns the matching indices.
function findMatchingSectionIndices(sections, card) {
  const re = new RegExp(card.match.source, card.match.flags.includes('i') ? 'i' : '');
  const indices = [];
  sections.forEach((section, idx) => {
    if (re.test(section.titleText)) indices.push(idx);
  });
  return indices;
}

// Abort loudly (never silently pick one) on zero or duplicate matches. Returns
// the single matching index on success.
function requireExactlyOneSection(sections, card, { where }) {
  const indices = findMatchingSectionIndices(sections, card);
  if (indices.length === 0) {
    throw new Error(
      `ABORT: ${where} ExampleCos ZERO sections matching card '${card.id}' (expected header matching ${card.match}). Refusing to guess -- the section is missing or the manifest matcher is stale.`,
    );
  }
  if (indices.length > 1) {
    const titles = indices.map((i) => sectionTitleLine(sections[i])).join(' | ');
    throw new Error(
      `ABORT: ${where} ExampleCos ${indices.length} DUPLICATE sections matching card '${card.id}' (${titles}). Refusing to splice against an ambiguous document -- collapse the duplicate before retrying.`,
    );
  }
  return indices[0];
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

function withSharedBriefingLock(
  fn,
  {
    lockPath = SHARED_LOCK_PATH,
    waitSeconds = LOCK_WAIT_SECONDS,
    platform = process.platform,
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
  // flock -w N LOCKFILE -c "true" just to CHECK acquisition would race with
  // releasing before fn() runs. Instead we run flock as the actual wrapper
  // around a marker file exchange: spawn `flock -w N LOCKPATH node -e
  // "fs.writeFileSync(marker, 'held')"` is awkward for a synchronous JS
  // caller. Simpler and equally honest: use flock's own exit-code contract by
  // wrapping OUR whole critical section in one flock invocation via a helper
  // script executed with `true`-style pass-through is unnecessary complexity
  // here -- Node's own advisory approach is to open the lock file with an
  // exclusive flag AFTER confirming via the real flock binary that the lock
  // is free within the wait window, then hold it by keeping that flock child
  // alive for the duration via a small shell wrapper.
  //
  // Concretely: spawn `flock -w <waitSeconds> <lockPath> -c '<marker cmd>'`
  // synchronously is what we want, but the critical section (read -> build ->
  // splice -> write -> receipt -> QC) is pure JS running in THIS process, not
  // a child shell command. flock's `-c` form execs a shell command and holds
  // the lock only for that child's lifetime, so we cannot use it to bracket
  // arbitrary JS in the parent. The standard bridge is: spawn a long-lived
  // `flock -w N LOCKPATH sleep <bignum>` in the background, then kill it when
  // done -- but that is fragile (kill timing, orphaned sleeps).
  //
  // The robust, dependency-free bridge used here: acquire via a SEPARATE
  // short-lived `flock -n -w waitSeconds LOCKPATH -c true` PROBE first (fails
  // fast if genuinely contended, honoring the wait window), then take Node's
  // own exclusive-create lock on a SIBLING marker path
  // (`<lockPath>.refresh-card`) for the duration of fn(). Because the real
  // cron run (ec2-morning-briefing-run.sh) ALSO flocks the exact same
  // lockPath with `-n` (no-wait) for its own run, and this probe uses the
  // SAME lockPath, a live cron run in progress makes our probe fail exactly
  // when theirs would have -- so this never runs concurrently with a real
  // cron build. The sibling marker only protects two refresh-card.js
  // invocations from colliding with EACH OTHER (a narrower, additional
  // guarantee), and is cleaned up unconditionally.
  const probe = spawnSync('flock', ['-w', String(waitSeconds), lockPath, '-c', 'true'], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  if (probe.error) {
    throw new Error(
      `ABORT: could not invoke flock to acquire the shared briefing lock (${lockPath}): ${probe.error.message}`,
    );
  }
  if (probe.status !== 0) {
    throw new Error(
      `ABORT: the shared briefing lock (${lockPath}) is held by another run (flock exit ${probe.status} after waiting ${waitSeconds}s). Refusing to proceed -- retry once the other run finishes.`,
    );
  }
  const markerPath = `${lockPath}.refresh-card`;
  let fd;
  try {
    fd = fs.openSync(markerPath, 'wx');
  } catch (e) {
    if (e && e.code === 'EEXIST') {
      throw new Error(
        `ABORT: another refresh-card.js run holds ${markerPath}. Refusing to proceed concurrently -- retry once it finishes.`,
      );
    }
    throw e;
  }
  try {
    fs.writeSync(fd, String(process.pid));
    return fn();
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* already closed */
    }
    try {
      fs.unlinkSync(markerPath);
    } catch {
      /* best effort */
    }
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

// Pure core: given the EXISTING markdown and a targeted rebuild's fresh
// markdown, splice the target card + derived cards (blockers, system_health)
// into the existing document. Returns { markdown, replacedIds } or throws on
// any A1 boundary violation. Exported (as spliceCard) so tests exercise this
// without touching the filesystem.
function spliceCard(existingMarkdown, freshMarkdown, cardId) {
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

  // Target + derived ids, deduped, target first so its own abort (if any)
  // reports first.
  const idsToSplice = [card.id, ...DERIVED_CARD_IDS.filter((id) => id !== card.id)];

  const sections = [...existing.sections];
  const replacedIds = [];
  for (const id of idsToSplice) {
    const targetCard = getCardById(id);
    if (!targetCard) continue; // DERIVED_CARD_IDS are always valid; defensive only.
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
      lines: [...contentLines, ...chromeLines],
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
// real generator runs; every other card falls to ITS OWN honest blocker
// inside this throwaway build (never used -- we only read the target +
// derived sections out of it).
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
  // probe-write-then-validate, receipt fields, QC-failure-blocks-write)
  // without paying for a real multi-minute build.
  buildFn = buildTargetedRebuild,
  // Injectable ONLY for tests, same pattern buildCloudMorningBriefing itself
  // already uses for its own `canonicalValidator` parameter. The real CLI
  // path always uses the default (the actual spawn to
  // validate-briefing-quality.js). The real validator requires a COMPLETE
  // (26+ card) briefing to pass -- a minimal synthetic fixture legitimately
  // and correctly fails it (card-completeness is its job, proven by its own
  // test suite), so orchestration tests that want to exercise the
  // clean-publish path stub this out; tests that want to prove A4 (a real
  // canonical QC failure blocks the write) use the real default.
  canonicalValidator = runCanonicalBriefingValidator,
} = {}) {
  const card = getCardById(cardId);
  if (!card) {
    console.error(`[refresh-card] '${cardId}' is not a known manifest card id.`);
    console.error(`Known ids: ${CARDS.map((c) => c.id).join(', ')}`);
    process.exitCode = 1;
    return null;
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
  const doRefresh = () => {
    const existingMarkdown = fs.readFileSync(markdownPath, 'utf8');

    console.log(`[refresh-card] rebuilding card='${cardId}' date=${date} dataDir=${dataDir}`);
    const fresh = buildFn({ dataDir, date, now, cardId });

    let spliced;
    try {
      spliced = spliceCard(existingMarkdown, fresh.markdown, cardId);
    } catch (e) {
      console.error((e && e.message) || String(e));
      process.exitCode = 1;
      return null;
    }
    console.log(`[refresh-card] spliced sections: ${spliced.replacedIds.join(', ')}`);

    // Whole-document QC gate (Codex amendment A4): the SAME two checks the
    // full build runs before writing -- presentation QC (qcBriefingMarkdown)
    // and the canonical validator (which runs checkHealthBlockersConsistency
    // + Reverse, among everything else) -- against the SPLICED document,
    // never just the new section. On failure: print, exit nonzero, do not
    // write.
    const presentationQc = qcBriefingMarkdown(spliced.markdown);
    if (!presentationQc.ok) {
      console.error('[refresh-card] whole-document presentation QC FAILED. Not writing:');
      for (const f of presentationQc.failures) console.error(`  - ${f}`);
      process.exitCode = 1;
      return null;
    }

    fs.mkdirSync(path.dirname(markdownPath), { recursive: true });
    // Write to a TEMP path first so the canonical validator (which reads the
    // markdown FILE, not a string) can check the spliced content before it
    // ever lands at the real markdownPath -- the file only moves to its real
    // path after BOTH QC passes (A4: never write on QC failure).
    const probePath = `${markdownPath}.refresh-card-probe.${process.pid}.md`;
    writeTextAtomic(probePath, spliced.markdown);
    let canonicalValidation;
    try {
      canonicalValidation = canonicalValidator({
        dataDir,
        date,
        markdownPath: probePath,
      });
    } finally {
      try {
        fs.unlinkSync(probePath);
      } catch {
        /* best effort */
      }
    }
    const finalQc = mergeCanonicalQc(presentationQc, canonicalValidation);
    if (!finalQc.ok) {
      console.error('[refresh-card] whole-document canonical QC FAILED. Not writing:');
      for (const f of finalQc.failures) console.error(`  - ${f}`);
      process.exitCode = 1;
      return null;
    }

    writeTextAtomic(markdownPath, spliced.markdown);
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
        publishState: finalQc.ok ? 'ready' : 'blocked',
        qc: finalQc,
        canonicalValidation: canonicalValidation
          ? {
              ok: canonicalValidation.ok,
              skipped: canonicalValidation.skipped || null,
              status: canonicalValidation.status ?? null,
              failureCount:
                canonicalValidation.failureCount ||
                (canonicalValidation.failures || []).length ||
                0,
              failures: (canonicalValidation.failures || []).slice(0, 120),
            }
          : previousReceipt.canonicalValidation || null,
        renderQcDefectCards: previousReceipt.renderQcDefectCards || [],
        degradedNotice: finalQc.ok ? null : previousReceipt.degradedNotice || null,
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

  const spliced = withSharedBriefingLock(doRefresh);
  if (!spliced) return null;

  if (verify) {
    await runVerify({ cardId, date });
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
async function runVerify({ cardId, date }) {
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
  console.log(`[refresh-card] --verify: card='${cardId}' status=${cardStatus.status}`);
  if (cardStatus.status !== 'clean') {
    for (const d of cardStatus.defects) console.error(`  - ${d}`);
    process.exitCode = 1;
  }
}

function main() {
  const opts = parseArgs(process.argv);
  const date = opts.date || new Date().toISOString().slice(0, 10);
  const dataDir = opts.dataDir || DEFAULT_DATA_DIR;
  refreshCard({
    cardId: opts.cardId,
    date,
    dataDir,
    publish: opts.publish,
    verify: opts.verify,
  }).catch((err) => {
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
  headingTitleText,
  sectionTitleLine,
  findMatchingSectionIndices,
  requireExactlyOneSection,
  spliceCard,
  buildTargetedRebuild,
  withSharedBriefingLock,
  refreshCard,
  runVerify,
  markdownPathFor,
  receiptPathFor,
  SECTION_DELIMITER,
  SHARED_LOCK_PATH,
  DERIVED_CARD_IDS,
};
