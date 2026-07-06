#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
// ONE shared source of truth for the one-Amy / no-self-narration contract so
// the validator can never drift from the renderers (Codex review #3). Do not
// define a second copy of these patterns here.
const { findSelfNarration, isRealExampleCoAction } = require('./lib/briefing-clean-contract.js');
const { resolveDataPath } = require('./lib/resolve-data-path.js');
const { isHeadlineOnlyExampleCoraphs } = require('./lib/news-summarize.js');
// ONE shared parser for the non-green SYSTEM HEALTH roster so the cloud briefing
// generator (which emits a named blocker per non-green row) and this validator
// (which enforces the health<->blockers set-diff) can never count a different set.
const { nonGreenSubsystems, presentSubsystems } = require('./lib/system-health-nongreen.js');

const REPO = path.resolve(__dirname, '..');
// Runtime artifacts (shorts/mortgage/action-items/...) live in the data dir the
// BUILD wrote to, which on the cloud host is SECONDBRAIN_DATA_DIR=/opt/secondbrain/data,
// NOT REPO/data. Resolving `data/` reads under REPO made the validator read an
// empty repo data dir and falsely report artifacts "missing" while the builder
// and render-QC saw them fresh. Honor the same data dir the build used.
const DATA_DIR_ARG = (function () {
  const idx = process.argv.indexOf('--data-dir');
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  const hit = process.argv.find((a) => a.startsWith('--data-dir='));
  return hit ? hit.slice('--data-dir='.length) : null;
})();
const DATA_DIR = DATA_DIR_ARG || process.env.SECONDBRAIN_DATA_DIR || null;

function todayCt() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

function argValue(name) {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  const pref = `${name}=`;
  const hit = process.argv.find((a) => a.startsWith(pref));
  return hit ? hit.slice(pref.length) : null;
}

const date = argValue('--date') || todayCt();
// The build that produced the markdown owns its location. By default the file
// lives at REPO/data/briefings, but the live box builds into /opt/secondbrain/data
// (which is not always === REPO/data after a path normalization). Accept an
// explicit --briefing-path so the validator ALWAYS validates the real file the
// build wrote, never a stale or absent REPO-relative copy. This is what closes
// the 2026-06-21 "validator skipped in production" hole: the caller points us at
// the actual dataDir markdown instead of relying on REPO/data matching.
const briefingPath =
  argValue('--briefing-path') || path.join(REPO, 'data', 'briefings', `briefing-${date}.md`);
const failures = [];

function fail(msg) {
  failures.push(msg);
}

function readJson(rel) {
  try {
    return JSON.parse(
      fs.readFileSync(resolveDataPath(rel, { repo: REPO, dataDir: DATA_DIR }), 'utf8'),
    );
  } catch {
    return null;
  }
}

function readJsonAbs(absPath) {
  try {
    return JSON.parse(fs.readFileSync(absPath, 'utf8'));
  } catch {
    return null;
  }
}

if (!fs.existsSync(briefingPath)) {
  fail(`briefing markdown missing for ${date}`);
}

const md = fs.existsSync(briefingPath) ? fs.readFileSync(briefingPath, 'utf8') : '';

function briefingModeFromMarkdown(markdown) {
  const m = String(markdown || '').match(/^Briefing mode:\s*(overnight|off-cycle)\b/im);
  return m ? m[1].toLowerCase() : '';
}

const briefingMode = briefingModeFromMarkdown(md);
const isOffCycle = briefingMode === 'off-cycle';
const isOvernight = briefingMode === 'overnight';
if (!briefingMode)
  fail('Briefing mode missing: expected "Briefing mode: overnight" or "Briefing mode: off-cycle"');

const banned = [
  /Read the full article/i,
  /RSS-derived summary/i,
  /operator must/i,
  /must scrub/i,
  /verify speaker/i,
  /manifest has no timestamped videos/i,
  /will draft/i,
  /next pass/i,
  /Nothing from you/i,
  /Nothing required/i,
  /Nothing immediate/i,
  /Nothing if/i,
  /What I need from you:\s*Nothing\b/i,
  /nothing unless/i,
  /looping until/i,
  /until it clears/i,
  /red-blocking/i,
  /watch only/i,
  /Generator returned no output/i,
  /Generation failed/i,
  /No proposals generated/i,
  /no articles in window/i,
  /Drafts loaded from/i,
  /today's scan was empty/i,
  /Corrected ExampleCoraph/i,
  /EM DASH SENTENCE/i,
  /sentence\s*(?:for ExampleCoraph|\([^)]*em dash|:\*\*)/i,
  /\bTLDR:/i,
  /<!\[CDATA\[/i,
  /Text settings/i,
  /Story text Size/i,
  /SKIP ADVERTISEMENT/i,
  /hide caption toggle caption/i,
  /Minimize to nav/i,
  /Download the NEW APP/i,
  /Toggle navigation/i,
  /Current Mortgage Rates/i,
  /Mortgage Rates and MBS/i,
  /Rate Volatility Index/i,
  /This website requires Javascrip/i,
  /\batdigit\b/i,
  /Subscribers only/i,
  /Standard\s+Wide\s+Links/i,
  /Today's Videos/i,
  /Sponsor Message/i,
  /Toggle more options/i,
  /Download Embed/i,
  /Heard on [A-Z]/i,
  /\b(?:News|Analysis|Politics|Elections|Media|Obituaries|Europe)\s+[A-Z][^.!?]{0,180}\s+May\s+\d{1,2},\s+2026\s+\d{1,2}:\d{2}\s+(?:AM|PM)\s+ET\s+By\b/i,
  /This item did not pass the executive-detail bar/i,
  /not ready for approval/i,
  /Related contacts/i,
  /Related insights/i,
  /Related offices/i,
  /Share Twitter Facebook LinkedIn/i,
  /Explore more at Fragomen/i,
  /Email \[emailprotected\]/i,
  /(?<!\bthree\s)Quick Hits/i,
  /Read more Overview/i,
  /Alerts driven thinking/i,
  /Overview The Department/i,
  /Each month, the USCIS/i,
  /^\d+\s+(?:minutes?|hours?|days?)\s+ago\b/im,
  /\b(?:Correspondent|Reporter|Editor),\s+[A-Z][A-Za-z ,.-]+/,
  /not a law firm/i,
  /does not provide legal advice/i,
  /Reach out today/i,
  /support your company.?s immigration needs/i,
  /Set Yourself Apart from your Competition/i,
  /Become the market expert/i,
];

for (const re of banned) {
  if (re.test(md)) fail(`placeholder text leaked into briefing: ${re}`);
}

function findSectionStart(lines, label) {
  return lines.findIndex((line) =>
    new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(line),
  );
}

function sectionBody(label, options = {}) {
  const lines = md.split(/\r?\n/);
  const start = findSectionStart(lines, label);
  if (start < 0) {
    if (!options.optional) fail(`${label} section missing`);
    return '';
  }
  let end = lines.length;
  const nextHeaderRe = /^[A-Z][A-Z0-9 &/().,'+-]+(?:\s+\([^)]*\))*:\s*$/;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^---\s*$/.test(lines[i]) || nextHeaderRe.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines
    .slice(start + 1, end)
    .join('\n')
    .trim();
}

function sectionBodyAny(labels, displayLabel) {
  for (const label of labels) {
    const body = sectionBody(label, { optional: true });
    if (body) return body;
  }
  fail(`${displayLabel || labels[0]} section missing`);
  return '';
}

function parseNumberedItems(body) {
  const lines = body.split(/\r?\n/);
  const items = [];
  let cur = null;
  for (const line of lines) {
    const head = line.match(/^\s*(\d+)\.\s+(.+)$/);
    if (head) {
      if (cur) items.push(cur);
      cur = { n: Number(head[1]), title: head[2].trim(), lines: [] };
      continue;
    }
    if (cur) cur.lines.push(line);
  }
  if (cur) items.push(cur);
  return items;
}

function readJsonl(rel) {
  try {
    return fs
      .readFileSync(resolveDataPath(rel, { repo: REPO, dataDir: DATA_DIR }), 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function hoursOld(ts) {
  const t = ts ? new Date(ts).getTime() : NaN;
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((Date.now() - t) / 3600000));
}

function escapeRe(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Pure, individually-testable consistency checks ────────────────────────
// These take a raw briefing markdown string (plus, where relevant, the parsed
// source-of-truth JSON) and return an array of failure strings. They make the
// "clean" verdict impossible to fake by editing only the BLOCKERS copy while a
// card still shows broken/stale state. Each function is exported so a
// regression test can exercise the category directly without a full briefing.

// Extract a labeled section's body from raw markdown. Mirrors sectionBody()
// but is self-contained so the checks below do not depend on module-level
// `md`. A section runs from its header line up to the next ALL-CAPS header or
// a horizontal rule.
function extractSection(markdown, label) {
  const lines = String(markdown || '').split(/\r?\n/);
  const headerRe = new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  const start = lines.findIndex((line) => headerRe.test(line));
  if (start < 0) return '';
  let end = lines.length;
  const nextHeaderRe = /^[A-Z][A-Z0-9 &/().,'+-]+(?:\s+\([^)]*\))*:\s*$/;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^---\s*$/.test(lines[i]) || nextHeaderRe.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines
    .slice(start + 1, end)
    .join('\n')
    .trim();
}

// The BLOCKERS card is in its "nothing to do" empty form when it ExampleCos the
// canonical "No hard blockers" copy and no enumerated blocker rows.
function blockersIsEmpty(blockersBody) {
  const body = String(blockersBody || '');
  if (/No hard blockers/i.test(body)) return true;
  // Also treat a body with zero numbered/bulleted entries as empty.
  const hasRows = /^\s*(?:\d+\.|[-*])\s+\S/m.test(body);
  return !hasRows && body.trim().length === 0;
}

function isNonBlockingFileChurnLine(line) {
  const text = String(line || '');
  return /\bFileChurn\b/i.test(text) && /watch alert,\s*not a failure/i.test(text);
}

function isInformationalNotEvaluatedRow(line) {
  return (
    /\bTests\b/i.test(line) &&
    /(not evaluated on the cloud build|run on the desktop and in ci|not (?:run|evaluated|measured) (?:live |on )|informational, not a failure)/i.test(
      line,
    )
  );
}

// nonGreenSubsystems is the shared parser (./lib/system-health-nongreen.js),
// required at the top of this file. The cloud generator names a blocker for the
// SAME set, so the two cannot drift.

// The full non-green subsystem set is the UNION of (1) probe rows in SYSTEM
// HEALTH and (2) the Life:* full-life-backup rows (every backup source whose
// status is not green). yellow/question count, not just red -- a 79% backfill
// in progress is still a non-green subsystem that BLOCKERS must mention.
function allNonGreenSubsystems(markdown) {
  const names = new Set(nonGreenSubsystems(extractSection(markdown, 'SYSTEM HEALTH')));
  const lifeBody =
    extractSection(markdown, 'FULL-LIFE DATA BACKUP') ||
    extractSection(markdown, 'FULL LIFE DATA BACKUP');
  if (lifeBody) {
    try {
      // eslint-disable-next-line global-require
      const { parseFullLifeBackupBody } = require('./lib/parse-full-life-backup.js');
      const parsed = parseFullLifeBackupBody(lifeBody);
      for (const item of parsed.items || []) {
        if (item.status && item.status !== 'green') names.add(item.name); // "Life: <name>"
      }
    } catch {
      // Parser unavailable: fall back to probe rows only.
    }
  }
  return Array.from(names);
}

// (a) SYSTEM-HEALTH <-> BLOCKERS coverage SET-DIFF. Every non-green subsystem
// (probe rows AND Life:* backup rows, including yellow/question, not just red)
// must be named in the BLOCKERS body. FAIL listing every non-green subsystem
// missing from BLOCKERS even when OTHER blockers already exist -- the old
// "non-green AND blockers-empty" gate let a real defect hide behind unrelated
// blockers (2026-06-01 incident category: any non-green subsystem absent from
// BLOCKERS, not the literal Gmail/Tests trigger).
function checkHealthBlockersConsistency(markdown) {
  const fails = [];
  const blockersBody =
    extractSection(markdown, 'BLOCKERS - briefing quality gates') ||
    extractSection(markdown, 'BLOCKERS / NEEDS FROM ExampleCo') ||
    extractSection(markdown, 'BLOCKERS');
  const nonGreen = allNonGreenSubsystems(markdown);
  if (!nonGreen.length) return fails;
  // The empty "No hard blockers" form can never satisfy any non-green name.
  const emptyBlockers = blockersIsEmpty(blockersBody);
  const haystack = String(blockersBody || '').toLowerCase();
  const missing = nonGreen.filter((name) => {
    // Normalize: strip the "Life: " prefix, case-insensitive word-boundary
    // contains on the bare name.
    const bare = String(name)
      .replace(/^life:\s*/i, '')
      .trim()
      .toLowerCase();
    if (!bare) return false;
    if (emptyBlockers) return true;
    const re = new RegExp(`\\b${escapeRe(bare)}\\b`, 'i');
    return !re.test(haystack);
  });
  if (missing.length) {
    fails.push(
      `non-green subsystem(s) [${missing.join(', ')}] are not named in BLOCKERS; every non-green subsystem (System Health probes AND Life:* backup rows, including yellow) must appear in BLOCKERS even when other blockers exist`,
    );
  }
  return fails;
}

// (a2) REVERSE SYSTEM-HEALTH <-> BLOCKERS consistency. The forward check above
// enforces non-green-SH -> named-in-BLOCKERS. This enforces the OTHER direction:
// a BLOCKERS entry that names a SYSTEM HEALTH subsystem as non-green must find
// that subsystem PRESENT AND non-green in the SYSTEM HEALTH card. A blocker that
// names a subsystem the SYSTEM HEALTH card shows GREEN, or OMITS entirely, is a
// contradiction (ExampleCo 2026-07-01: BLOCKERS said "Scheduled tasks health system
// health is non-green" while the SYSTEM HEALTH roster had collapsed to a single
// green Graphiti row, so every other subsystem row had vanished). Together with
// the forward check the two force the non-green sets EQUAL.
//
// Category, not literal trigger: we key ONLY on blockers that explicitly assert a
// SYSTEM HEALTH state ("system health ... non-green", "SYSTEM HEALTH reports
// <name>", or a subsystem-named blocker whose line references system health), so
// a card-level blocker with no SYSTEM HEALTH claim (e.g. a stale git-hygiene
// snapshot) is never false-flagged. The subsystem name is matched against the
// PRESENT roster (any glyph) to tell "shows green" (present but not in the
// non-green set) apart from "omitted" (absent from the roster).
function checkHealthBlockersReverseConsistency(markdown) {
  const fails = [];
  const healthBody = extractSection(markdown, 'SYSTEM HEALTH');
  const blockersBody =
    extractSection(markdown, 'BLOCKERS - briefing quality gates') ||
    extractSection(markdown, 'BLOCKERS / NEEDS FROM ExampleCo') ||
    extractSection(markdown, 'BLOCKERS');
  if (!healthBody || !blockersBody) return fails;
  const present = presentSubsystems(healthBody).map((n) => n.toLowerCase());
  const nonGreen = nonGreenSubsystems(healthBody).map((n) => n.toLowerCase());
  const presentSet = new Set(present);
  const nonGreenSet = new Set(nonGreen);

  // Consider only blocker lines that make an explicit SYSTEM HEALTH claim, so a
  // card-level blocker with no health assertion is not matched.
  const claimRe =
    /(system health\b|SYSTEM HEALTH reports|is non-green|health (?:system health )?is non-green)/i;
  const lines = String(blockersBody).split(/\r?\n/);
  const flagged = new Set();
  for (const line of lines) {
    if (!claimRe.test(line)) continue;
    // Match the named subsystem against the present roster; report the ones that
    // are green (present, not non-green) or omitted (absent from the roster).
    for (const name of present) {
      if (nonGreenSet.has(name)) continue; // named + non-green in SH: consistent
      const re = new RegExp(`\\b${escapeRe(name)}\\b`, 'i');
      if (re.test(line)) flagged.add(`${name} (SYSTEM HEALTH shows this subsystem green)`);
    }
    // Also catch a blocker that names a subsystem SYSTEM HEALTH omits entirely:
    // the blocker asserts a SH state for a subsystem that has no roster row at
    // all. Detect by a "SYSTEM HEALTH reports <name>" / "<name> ... system
    // health is non-green" shape whose <name> is not in the present roster.
    const named = line.match(
      /(?:SYSTEM HEALTH reports\s+)?([A-Za-z][\w ]{2,60}?)\s+(?:system health\s+)?is non-green/i,
    );
    if (named) {
      const bare = named[1].trim().toLowerCase();
      if (bare && !presentSet.has(bare)) {
        flagged.add(`${named[1].trim()} (SYSTEM HEALTH omits this subsystem)`);
      }
    }
  }
  if (flagged.size) {
    fails.push(
      `BLOCKERS names non-green subsystem(s) [${Array.from(flagged).join(
        ', ',
      )}] that SYSTEM HEALTH shows green or omits; a blocked subsystem must render as a present, non-green SYSTEM HEALTH row (the non-green sets must match in both directions)`,
    );
  }
  return fails;
}

// The ordered list of dashboard sections scanned for self-narration. The whole
// briefing body is scanned (including System Health Attention, BLOCKERS, and
// every card) so a banned phrase can leak nowhere. Each entry is the label
// passed to extractSection; the first non-empty match wins per logical card.
const SELF_NARRATION_SECTIONS = [
  ['SYSTEM HEALTH', ['SYSTEM HEALTH']],
  ['BLOCKERS', ['BLOCKERS - briefing quality gates', 'BLOCKERS / NEEDS FROM ExampleCo', 'BLOCKERS']],
  ['ACTION ITEMS', ['ACTION ITEMS & OPEN COMMITMENTS', 'ACTION ITEMS']],
  ['FEATURE BACKLOG', ['FEATURE BACKLOG']],
  ['LINKEDIN', ['LINKEDIN -- TOP STRATEGIC REACH-OUTS', 'LINKEDIN']],
  ['CONTENT PIPELINE', ['CONTENT PIPELINE']],
  ['FULL-LIFE DATA BACKUP', ['FULL-LIFE DATA BACKUP', 'FULL LIFE DATA BACKUP']],
  ['TOKEN USAGE', ['TOKEN USAGE YESTERDAY', 'TOKEN USAGE']],
  ['AWS COSTS', ['AWS COSTS']],
  ['REPUTATION RISK SCAN', ['REPUTATION RISK SCAN']],
  ['AMY PROJECTS', ['AMY PROJECTS ASSIGNED']],
  ['VIRAL TECH CLIP PROPOSALS', ['VIRAL TECH CLIP PROPOSALS']],
  ['MORTGAGE RATE INDEXES', ['MORTGAGE RATE INDEXES']],
];

// (b) GLOBAL ONE-AMY SELF-NARRATION BAN. Scan the ENTIRE briefing body, not just
// BLOCKERS, using the shared findSelfNarration patterns. Every published card
// states facts and real ExampleCo-asks, never Amy narrating her own internal
// workflow ("Amy owns", "what I tried", "why I couldn't fix it", "plan + ETA").
// This subsumes the old BLOCKERS-only check and is NOT gated on briefing mode,
// so the ban applies off-cycle too. Each hit is reported with the section it
// leaked into so the publisher knows which card to hold back.
function checkNoSelfNarration(markdown) {
  const fails = [];
  for (const [section, labels] of SELF_NARRATION_SECTIONS) {
    let body = '';
    for (const label of labels) {
      body = extractSection(markdown, label);
      if (body) break;
    }
    if (!body) continue;
    const hits = findSelfNarration(body);
    for (const phrase of hits) {
      fails.push(
        `${section} contains one-Amy self-narration "${phrase}"; the card must state facts and real ExampleCo-asks, never Amy talking to herself`,
      );
    }
  }
  return fails;
}

// (f) PER-CARD HONEST-STATE assertion (Codex #4). A card whose own section is
// failing must NOT print a fake-clean line. Concretely: if SYSTEM HEALTH has a
// non-green subsystem, BLOCKERS must show its real state (not the empty
// "No hard blockers" form), and no card may emit a fake-clean green marker
// while its own section ExampleCos a failure. This prevents a broken card from
// rendering as clean while clean cards publish.
function checkHonestState(markdown, cardStatus) {
  const fails = [];
  const nonGreen = allNonGreenSubsystems(markdown);
  const blockersBody =
    extractSection(markdown, 'BLOCKERS - briefing quality gates') ||
    extractSection(markdown, 'BLOCKERS / NEEDS FROM ExampleCo') ||
    extractSection(markdown, 'BLOCKERS');
  if (nonGreen.length && blockersIsEmpty(blockersBody)) {
    fails.push(
      `SYSTEM HEALTH has non-green subsystem(s) [${nonGreen.join(', ')}] but BLOCKERS renders the fake-clean "No hard blockers" line; a failing card may never display as clean`,
    );
  }
  // No card may print a green/clean marker while its own section is failing.
  if (cardStatus && cardStatus.cards) {
    const FAKE_CLEAN_RE = /No hard blockers|All green\b|✓ Clean\b|Clean card = clean life/i;
    for (const [section, status] of Object.entries(cardStatus.cards)) {
      if (status.ok) continue;
      let body = '';
      const labels = (SELF_NARRATION_SECTIONS.find(([name]) => name === section) || [
        null,
        [section],
      ])[1];
      for (const label of labels) {
        body = extractSection(markdown, label);
        if (body) break;
      }
      if (body && FAKE_CLEAN_RE.test(body)) {
        fails.push(
          `${section} is failing but prints a fake-clean marker; a card with its own failure must show its real state`,
        );
      }
    }
  }
  return fails;
}

// Attribute a single failure string to a dashboard section header so the
// publisher can decide per-card whether to render or hold a card. A failure
// that matches no section is a global/structural failure under STRUCTURE.
// The order matters: the first matching rule wins, so more-specific section
// keywords precede generic ones.
const FAILURE_SECTION_RULES = [
  [
    'SYSTEM HEALTH',
    /\bsystem ?health\b|non-green subsystem|Attention block|\bTests\b row|tests-blocked\.json/i,
  ],
  [
    'BLOCKERS',
    /\bBLOCKERS\b|hard blocker|blocker not surfaced|not named in BLOCKERS|surfaced in top blockers|not surfaced in top blockers|ExampleCos no Tests entry/i,
  ],
  ['LINKEDIN', /\bLinkedIn\b/i],
  ['ACTION ITEMS', /action[- ]?items?\b|ACTION ITEMS|Gmail-auth-blocked action|Gmail scan\/reply/i],
  ['FEATURE BACKLOG', /FEATURE BACKLOG|feature[- ]?backlog/i],
  ['CONTENT PIPELINE', /CONTENT PIPELINE|content work queue|TEED UP/i],
  ['TOKEN USAGE', /TOKEN USAGE|claude-plan-usage|token-data|token blocker/i],
  ['AMY PROJECTS', /AMY PROJECTS/i],
  ['VIRAL TECH CLIP PROPOSALS', /viral (?:tech )?clip|VIRAL TECH CLIP/i],
  ["TODAY'S 10 SHORTS PROPOSALS", /shorts (?:proposal|markdown)|10 shorts/i],
  ['AWS COSTS', /AWS costs?\b|Cost Explorer/i],
  // News sections precede the generic mortgage-rate rule so a "MORTGAGE
  // INDUSTRY NEWS item 3" failure is not swallowed by the bare /mortgage/ rule.
  ['AI & TECH NEWS', /^AI & TECH NEWS/i],
  ['US IMMIGRATION NEWS', /^US IMMIGRATION NEWS/i],
  ['US NEWS', /^US NEWS/i],
  ['WORLD NEWS', /^WORLD NEWS/i],
  ['MORTGAGE INDUSTRY NEWS', /^MORTGAGE INDUSTRY NEWS|mortgage (?:industry )?news/i],
  ['MORTGAGE RATE INDEXES', /\bmortgage\b/i],
];

function sectionForFailure(failure) {
  const f = String(failure || '');
  for (const [section, re] of FAILURE_SECTION_RULES) {
    if (re.test(f)) return section;
  }
  return 'STRUCTURE';
}

// (TASK 2) Build a per-card status map from the flat failures list. Every
// failure is attributed to a dashboard section header; a failure mapping to no
// section is bucketed under STRUCTURE. A card with zero attributed failures is
// ok:true. This lets a card-level publisher render clean cards while holding a
// broken card, so a broken card can never render as fake-clean.
function buildCardStatusMap(failures) {
  const cards = {};
  for (const f of failures || []) {
    const section = sectionForFailure(f);
    if (!cards[section]) cards[section] = { ok: false, failures: [] };
    cards[section].failures.push(f);
  }
  // Mark explicitly-present sections ok:true only when they have no failures.
  // We do not enumerate every possible card here; the publisher treats an
  // absent key as "no failures attributed" (ok). Sections that DID fail are
  // present with ok:false. Normalize the shape.
  for (const section of Object.keys(cards)) {
    cards[section].ok = cards[section].failures.length === 0;
  }
  return cards;
}

// (b) Tests-truth. If data/agent/tests-blocked.json shows failures or is stale,
// the SYSTEM HEALTH Tests row must be non-green AND BLOCKERS must carry a Tests
// entry. A briefing must never show tests clean while the recorded run failed.
function checkTestsTruth(markdown, testsBlocked, opts = {}) {
  const fails = [];
  const freshnessHours = opts.freshnessHours == null ? 14 : opts.freshnessHours;
  const now = opts.now == null ? Date.now() : opts.now;
  if (!testsBlocked || typeof testsBlocked !== 'object') return fails;
  const failedCount = Number(testsBlocked.failed || 0);
  const ranAtMs = testsBlocked.ranAt ? new Date(testsBlocked.ranAt).getTime() : NaN;
  const stale = !Number.isFinite(ranAtMs) || now - ranAtMs > freshnessHours * 3600000;
  const problem = failedCount > 0 || stale;
  if (!problem) return fails;

  const healthBody = extractSection(markdown, 'SYSTEM HEALTH');
  // Cloud build exemption: the desktop test suite does not run on the cloud node,
  // so a stale tests-blocked.json with NO recorded failures is expected, not a
  // defect, when the Tests row is rendered as informational/not-evaluated. Real
  // test FAILURES (failedCount > 0) are still enforced below.
  const testsInformational =
    /Tests[^\n]*(not evaluated|run on the desktop|desktop, not|informational)/i.test(healthBody);
  if (failedCount === 0 && stale && testsInformational) return fails;
  const blockersBody =
    extractSection(markdown, 'BLOCKERS - briefing quality gates') ||
    extractSection(markdown, 'BLOCKERS / NEEDS FROM ExampleCo') ||
    extractSection(markdown, 'BLOCKERS');
  const testsNonGreen = nonGreenSubsystems(healthBody).some((name) => /^Tests\b/i.test(name));
  const blockersHasTests = !blockersIsEmpty(blockersBody) && /\btests?\b/i.test(blockersBody);

  const reason =
    failedCount > 0
      ? `tests-blocked.json records ${failedCount} failing assertion(s)`
      : `tests-blocked.json is stale (ranAt older than ${freshnessHours}h)`;
  if (!testsNonGreen) {
    fails.push(`${reason} but SYSTEM HEALTH Tests row is not marked non-green`);
  }
  if (!blockersHasTests) {
    fails.push(`${reason} but BLOCKERS ExampleCos no Tests entry`);
  }
  return fails;
}

// (c) Token-freshness. The TOKEN USAGE section must not present stale source
// data as current. If claude-plan-usage.json generated_at is older than the
// freshness window, the token section must show an explicit staleness warning
// OR BLOCKERS must carry a token-data entry; otherwise a bare percentage is a
// lie about how current the numbers are.
// Reputation card guard (ExampleCo 2026-06-03 "0/? sources, no queries shown").
// Markdown-side complement to the ec2-server parser test: ensure the published
// section actually ExampleCos the source count and the queries so the dashboard
// has real data to render. Fails when the scan scope claims N sources but the
// section renders fewer provenance rows (the false-zero / "0/?" class), or when
// the keywords/queries are missing.
function checkReputationScan(markdown) {
  const fails = [];
  const body =
    extractSection(markdown, 'REPUTATION RISK SCAN') ||
    sectionBodyAny(['REPUTATION RISK SCAN'], 'REPUTATION RISK SCAN');
  if (!body) return fails; // a different check owns a wholly-missing card
  const scopeMatch =
    body.match(/Scan scope:\s*(\d+)\s*sources?/i) ||
    body.match(/(\d+)\s*sources?,\s*\d+\s*items?\s*scanned/i);
  const claimed = scopeMatch ? parseInt(scopeMatch[1], 10) : 0;
  if (claimed > 0) {
    // Count rendered provenance rows: lines with an outcome glyph or a count/
    // method/query provenance label under a source.
    const provenanceRows = (body.match(/^\s*[✓✗⚠]\s*\S/gm) || []).length;
    const countRows = (body.match(/^\s*count:/gim) || []).length;
    const sourcesShown = Math.max(provenanceRows, countRows);
    if (sourcesShown < claimed) {
      fails.push(
        `REPUTATION card scan scope claims ${claimed} sources but only ${sourcesShown} provenance row(s) render; the dashboard would show a false "0/?" over a real scan`,
      );
    }
    // Queries/keywords must be visible so clicking the detail shows what was searched.
    const hasKeywords = /keywords?:|lawsuit|sued|scam|fraud|complaint|scandal/i.test(body);
    if (!hasKeywords) {
      fails.push('REPUTATION card does not name the keywords/queries that were searched');
    }
  }
  return fails;
}

function checkTokenFreshness(markdown, planUsage, opts = {}) {
  const fails = [];
  const freshnessHours = opts.freshnessHours == null ? 24 : opts.freshnessHours;
  const now = opts.now == null ? Date.now() : opts.now;
  const tokenBody =
    extractSection(markdown, 'TOKEN USAGE YESTERDAY') || extractSection(markdown, 'TOKEN USAGE');
  // No token section rendered means a different check owns the gap.
  if (!tokenBody) return fails;
  const genMs =
    planUsage && planUsage.generated_at ? new Date(planUsage.generated_at).getTime() : NaN;
  const stale = !Number.isFinite(genMs) || now - genMs > freshnessHours * 3600000;
  if (!stale) return fails;

  const showsPercent = /\d+%/.test(tokenBody);
  const acknowledgesStaleness =
    /\bstale\b|out of date|outdated|data is old|could not refresh|collector errored|still missing|last known/i.test(
      tokenBody,
    );
  const blockersBody =
    extractSection(markdown, 'BLOCKERS - briefing quality gates') ||
    extractSection(markdown, 'BLOCKERS / NEEDS FROM ExampleCo') ||
    extractSection(markdown, 'BLOCKERS');
  const blockersHasToken = !blockersIsEmpty(blockersBody) && /token/i.test(blockersBody);

  if (showsPercent && !acknowledgesStaleness && !blockersHasToken) {
    fails.push(
      'TOKEN USAGE shows a current-looking percentage but claude-plan-usage.json is stale and neither the section nor BLOCKERS acknowledges the staleness',
    );
  }
  return fails;
}

// (c3) OTTER SPEAKER staleness must be a SURFACED DEFECT, not a silent note
// (ExampleCo 2026-06-22: "that should be a defect to report, not a silent note").
// When the OTTER SPEAKER PARETO card trails (>= 2 days behind) or hard-blocks,
// the staleness must appear as a non-green SYSTEM HEALTH "Otter speaker
// enrichment" row AND be named on the BLOCKERS card, so the render-QC counts it.
// Category, not the literal "3 days behind" trigger: any trailing/blocked speaker
// roster that renders without the matching health row + blocker is a hidden
// defect. The health<->blockers set-diff (checkHealthBlockersConsistency) then
// enforces the row/blocker pairing once the row exists; this check guarantees the
// row exists in the first place.
const SPEAKER_DEFECT_MIN_LAG_DAYS = 2;
function checkOtterSpeakerStaleness(markdown) {
  const fails = [];
  const otterBody =
    extractSection(markdown, 'OTTER SPEAKER PARETO / PEOPLE TAGGED') ||
    extractSection(markdown, 'OTTER SPEAKER PARETO');
  // No speaker card rendered means a different check owns the gap.
  if (!otterBody) return fails;

  const behindMatch = otterBody.match(/(\d+)\s+days?\s+behind/i);
  const lag = behindMatch ? parseInt(behindMatch[1], 10) : null;
  const hardBlocked = /Freshness:\s*BLOCKER:/i.test(otterBody) || /BLOCKER:/i.test(otterBody);
  const isDefect = hardBlocked || (Number.isFinite(lag) && lag >= SPEAKER_DEFECT_MIN_LAG_DAYS);
  if (!isDefect) return fails;

  const healthRows = nonGreenSubsystems(extractSection(markdown, 'SYSTEM HEALTH'));
  const healthHasSpeaker = healthRows.some((name) => /otter speaker enrichment/i.test(name));
  const blockersBody =
    extractSection(markdown, 'BLOCKERS - briefing quality gates') ||
    extractSection(markdown, 'BLOCKERS / NEEDS FROM ExampleCo') ||
    extractSection(markdown, 'BLOCKERS');
  const blockersHasSpeaker =
    !blockersIsEmpty(blockersBody) && /otter speaker enrichment/i.test(blockersBody || '');

  const trailingWord = hardBlocked
    ? 'is blocked (roster empty or too far behind to trust)'
    : `is ${lag} days behind`;
  if (!healthHasSpeaker) {
    fails.push(
      `OTTER SPEAKER PARETO ${trailingWord} but SYSTEM HEALTH ExampleCos no non-green "Otter speaker enrichment" row; a trailing/blocked speaker roster must be a surfaced defect, not a silent note`,
    );
  }
  if (!blockersHasSpeaker) {
    fails.push(
      `OTTER SPEAKER PARETO ${trailingWord} but BLOCKERS does not name "Otter speaker enrichment"; the staleness defect must be surfaced on the top BLOCKERS card`,
    );
  }
  return fails;
}

// (d) CONTENT-EVIDENCE verification. content-heal writes
// data/agent/content-heal-<date>.json with shape:
//   { date, cards: {
//       viral:    { count, target: 3,  items: [{sourceId,url,approxTimestamp,transcriptOrExcerpt,uniqueKey}], wall: null|"<reason>" },
//       mortgage: { count, target: 10, items: [{sourceId,url,domain,publishedAtIso,excerpt,uniqueKey}], wall: null|"<reason>" } } }
// For each card: EITHER count >= target with evidence items that have unique
// sourceId/uniqueKey (duplicates = padding, rejected), non-empty
// transcriptOrExcerpt/excerpt, and (mortgage) publishedAtIso inside the
// freshness window; OR a non-null wall reason. Neither => FAIL. This replaces
// trusting raw counts and stops fabricated filler. If the content-heal file is
// absent, fall back to the existing count check (do not crash).
// True when content-heal recorded a NAMED, recognized exhaustion wall for this
// card -- i.e. it genuinely ran and exhausted its source pool (sources-exhausted)
// or hit its time cap (budget-exhausted). An honest wall means a thin card is a
// real shortfall Amy owns, not a publish-blocking defect: ship the briefing with
// the honest in-card shortfall instead of withholding the WHOLE briefing over one
// thin content card (ExampleCo 2026-06-08: a thin day is a real shortfall, Amy owns it;
// do not fabricate filler and do not withhold everything). A missing or vague wall
// does NOT count -- there is no silent path to shipping a thin card without trying.
function hasRecognizedHealWall(heal, name) {
  const card = heal && heal.cards && heal.cards[name];
  const wall = card && card.wall;
  return wall != null && /sources-exhausted|budget-exhausted/i.test(String(wall));
}

function checkContentHealEvidence(heal, opts = {}) {
  const fails = [];
  if (!heal || typeof heal !== 'object' || !heal.cards) return fails; // absent -> count check owns it
  const now = opts.now == null ? Date.now() : opts.now;
  const freshnessDays = opts.freshnessDays == null ? 30 : opts.freshnessDays;

  function checkCard(name, card, opt = {}) {
    const needsFreshDate = !!opt.needsFreshDate;
    // News cards (covid/us/world/aitech/immigration) carry per-item tiers:
    // a summary-grade item must trace to retrieved source material, a degraded
    // headline-rescue item is allowed but must be marked tier:"headline".
    const isNews = !!opt.isNews;
    if (!card || typeof card !== 'object') {
      fails.push(`content-heal ${name} card missing from content-heal artifact`);
      return;
    }
    const target = Number(card.target || 0);
    const count = Number(card.count || 0);
    const items = Array.isArray(card.items) ? card.items : [];
    const wall = card.wall;
    const hasWall = wall != null && String(wall).trim().length > 0;

    // A wall must be a NAMED, recognized exhaustion reason. For news/mortgage a
    // wall has to declare sources-exhausted or budget-exhausted -- a vague
    // string is not an honest wall (Codex C#1/C#5: stop only on a real wall).
    if (hasWall) {
      // A wall must be a NAMED, recognized exhaustion reason for EVERY card (not
      // just news). A vague string or a "heal-error" wall (the generator threw on
      // all rounds, so the pool was never observed) is NOT an honest exhaustion
      // and must not satisfy the gate -- otherwise a broken heal silently ships a
      // thin card (Codex B/C, 2026-06-08). isNews is retained for any future
      // per-tier news rules.
      void isNews;
      if (!/sources-exhausted|budget-exhausted/i.test(String(wall))) {
        fails.push(
          `content-heal ${name} wall is not a recognized exhaustion reason (must name sources-exhausted or budget-exhausted): ${String(wall).slice(0, 120)}`,
        );
      }
      return; // an honest, recognized exhaustion wall satisfies the gate
    }

    if (count < target) {
      fails.push(
        `content-heal ${name} count ${count} < target ${target} and no wall reason given (count >= target with evidence OR a named wall required)`,
      );
      return;
    }
    // count >= target: require real evidence, reject padding/duplicates.
    if (items.length < target) {
      fails.push(
        `content-heal ${name} claims count ${count}/${target} but only ${items.length} evidence item(s) provided`,
      );
      return;
    }
    const keys = new Set();
    items.forEach((it, i) => {
      const key = it && (it.uniqueKey || it.sourceId);
      if (!key) {
        fails.push(
          `content-heal ${name} item ${i + 1} has no sourceId/uniqueKey to prove it is a distinct source`,
        );
      } else if (keys.has(String(key))) {
        fails.push(
          `content-heal ${name} item ${i + 1} duplicates source key ${key} (padding the count is fabrication, not coverage)`,
        );
      } else {
        keys.add(String(key));
      }
      // Codex C#1: a news item that cannot trace to retrieved source material
      // FAILS. Every counted item needs a real URL.
      if (isNews) {
        const url = it && (it.url || it.sourceId);
        if (!url || !/^https?:\/\//.test(String(url))) {
          fails.push(
            `content-heal ${name} item ${i + 1} has no real source URL (cannot trace to retrieved source material)`,
          );
        }
      }
      const excerpt = it && (it.transcriptOrExcerpt || it.excerpt);
      if (!excerpt || !String(excerpt).trim()) {
        fails.push(
          `content-heal ${name} item ${i + 1} has an empty transcript/excerpt; raw counts without evidence are not trusted`,
        );
      }
      // Codex C#2: a degraded headline-rescue item must be tier:"headline";
      // anything else counts as a full clean article and needs a real date.
      const tier = it && it.tier;
      if (isNews && tier && !['summary', 'headline'].includes(String(tier))) {
        fails.push(
          `content-heal ${name} item ${i + 1} has an ExampleCo tier "${tier}" (must be summary or headline)`,
        );
      }
      if (needsFreshDate || isNews) {
        // A headline-rescue (degraded) item may be undated; everything else must
        // carry a parseable in-window publishedAtIso (Codex C#3).
        const isDegradedHeadline = isNews && String(tier) === 'headline';
        const pub = it && it.publishedAtIso ? new Date(it.publishedAtIso).getTime() : NaN;
        if (!Number.isFinite(pub)) {
          if (!isDegradedHeadline) {
            fails.push(
              `content-heal ${name} item ${i + 1} has no valid publishedAtIso (freshness cannot be proven)`,
            );
          }
        } else if (now - pub > freshnessDays * 86400000) {
          fails.push(
            `content-heal ${name} item ${i + 1} publishedAtIso is outside the ${freshnessDays}-day freshness window`,
          );
        }
      }
    });
  }

  checkCard('viral', heal.cards.viral, { needsFreshDate: false });
  checkCard('mortgage', heal.cards.mortgage, { needsFreshDate: true, isNews: true });
  // News cards. Each must reach threshold with source-bound evidence (unique
  // URL, parseable in-window date, non-empty real excerpt) OR carry a named
  // sources-exhausted / budget-exhausted wall. Only check cards present in the
  // artifact so an older artifact without the news cards does not hard-fail.
  for (const newsCard of ['covid', 'us', 'world', 'aitech', 'immigration']) {
    if (heal.cards[newsCard])
      checkCard(newsCard, heal.cards[newsCard], { needsFreshDate: true, isNews: true });
  }
  return fails;
}

const systemHealthBody = sectionBody('SYSTEM HEALTH');
const healthLines = systemHealthBody.split(/\r?\n/);
const fileChurnWatchOnly =
  /\bFileChurn\b/i.test(systemHealthBody) && /watch alert,\s*not a failure/i.test(systemHealthBody);
const nonGreenHealth = [];
for (const line of healthLines) {
  if (isInformationalNotEvaluatedRow(line)) continue;
  if (fileChurnWatchOnly && /^\s*[âœ—?]\s+FileChurn(?: probe)?\b/i.test(line)) continue;
  const m = line.match(/^\s*([✗?])\s+([A-Za-z][\w:\s-]*?):\s+(.+)$/);
  if (m) nonGreenHealth.push({ mark: m[1], name: m[2].trim() });
}
if (nonGreenHealth.length) {
  if (!/Attention on \d+ subsystem/i.test(systemHealthBody))
    fail('system health has non-green rows without an Attention block');
  for (const item of nonGreenHealth) {
    const blockMatch = systemHealthBody.match(
      new RegExp(
        `\\n\\s*[✗?]\\s+${escapeRe(item.name)}\\s*\\n([\\s\\S]*?)(?=\\n\\s*[✗?]\\s+[A-Za-z]|\\n\\s*Overall:|$)`,
        'i',
      ),
    );
    const block = blockMatch ? blockMatch[1] : '';
    // NEW contract (Codex #2 inversion): a non-green System Health row is NOT
    // required to narrate "what I tried" / "why I couldn't fix it" / "plan +
    // ETA" / "requirement". Those are exactly the self-narration ExampleCo banned.
    // It must instead state a factual "Status:" line, and a "Need from ExampleCo:"
    // line ONLY when a genuine ExampleCo action is named. Self-narration is caught
    // globally by checkNoSelfNarration.
    if (!/\bStatus:/i.test(block)) {
      fail(`system health ${item.name} missing a factual "Status:" line`);
    }
    const needMatch = block.match(/Need from ExampleCo:\s*(.+)/i);
    if (needMatch && !isRealExampleCoAction(needMatch[1])) {
      fail(
        `system health ${item.name} has a "Need from ExampleCo:" line that does not name a real ExampleCo action (auth/credential/decision/approval); Amy-fixable rows must not invent a ExampleCo ask`,
      );
    }
  }
}

const blockersBody = sectionBodyAny(
  ['BLOCKERS - briefing quality gates', 'BLOCKERS / NEEDS FROM ExampleCo'],
  'BLOCKERS',
);
const linkedinBody = sectionBody('LINKEDIN');
const linkedinStatus = readJsonAbs(
  path.join(process.env.APPDATA || '', 'secondbrain', 'data', 'agent', 'linkedin-scan-status.json'),
);
const linkedinStatusAt =
  linkedinStatus && linkedinStatus.checkedAt ? new Date(linkedinStatus.checkedAt).getTime() : NaN;
const linkedInFreshRed =
  Number.isFinite(linkedinStatusAt) &&
  Date.now() - linkedinStatusAt <= 24 * 3600000 &&
  linkedinStatus.status === 'red';
const currentLinkedInExpired =
  linkedInFreshRed || /SESSION EXPIRED|login\/CAPTCHA|authwall/i.test(linkedinBody);
if (currentLinkedInExpired && !/LinkedIn scanner auth/i.test(blockersBody)) {
  fail('LinkedIn session blocker not surfaced in top blockers');
}
if (/Action items source freshness/i.test(blockersBody)) {
  fail(
    'action-items freshness is Amy-owned unless a Gmail auth wall is named; do not surface it as a ExampleCo blocker',
  );
}

const actionSource = readJson('data/briefing-action-items.json');
const actionStamps = actionSource
  ? // Only a base artifact rebuild clears Action Items freshness. A reply
    // verification timestamp proves old candidates were checked, but it can
    // never make the source current by itself.
    [actionSource.lastFullReviewAt, actionSource.generatedAt]
      .map((ts) => (ts && ts !== 'never' ? new Date(ts).getTime() : NaN))
      .filter(Number.isFinite)
  : [];
const actionEffectiveAt = actionStamps.length
  ? new Date(Math.max(...actionStamps)).toISOString()
  : null;
const actionAge = actionEffectiveAt ? hoursOld(actionEffectiveAt) : null;
const gmailHeartbeats = readJsonl('data/agent/gmail-scan-heartbeat.jsonl');
const gmailHeartbeat = gmailHeartbeats[gmailHeartbeats.length - 1] || null;
const gmailHeartbeatAge = gmailHeartbeat && gmailHeartbeat.ts ? hoursOld(gmailHeartbeat.ts) : null;
if (
  isOvernight &&
  (!actionSource ||
    actionAge == null ||
    actionAge > 24 ||
    gmailHeartbeatAge == null ||
    gmailHeartbeatAge > 1)
) {
  if (/Gmail authorization|Gmail permission|re-authorize/i.test(blockersBody)) {
    const actionBody = sectionBody('ACTION ITEMS');
    // Standing reminders are durable, ExampleCo-dispatched, NOT email-derived, so they
    // are EXEMPT from the Gmail-verification requirement and must surface even on
    // the blocked path (ExampleCo 2026-06-20: do not drop standing reminders). When the
    // only listed content is the explicitly-labeled standing-reminders floor, the
    // card is honest, not "old email asks rendered as verified". Strip that block
    // before checking for stale email asks. CATEGORY = the standing-reminder floor,
    // not one literal reminder.
    const standingFloorRe =
      /\n\s*OPEN COMMITMENTS \(standing reminders, always shown\):[\s\S]*?(?=\n\s*[A-Z][A-Z ]+:|\n*$)/i;
    const actionBodyWithoutFloor = actionBody.replace(standingFloorRe, '\n');
    if (
      /^\s*\d+\.\s+/m.test(actionBodyWithoutFloor) ||
      /OPEN COMMITMENTS\b/i.test(actionBodyWithoutFloor)
    ) {
      fail('Gmail-auth-blocked action items rendered old asks/commitments as if verified');
    }
  } else {
    fail(
      'action-items source is stale; Amy must rerun Gmail scan/reply verification before publishing',
    );
  }
}

function ExampleCoraphsForArticle(item) {
  const linkIdx = item.lines.findIndex((line) => /https?:\/\//.test(line));
  const contentLines = linkIdx >= 0 ? item.lines.slice(linkIdx + 1) : item.lines;
  return contentLines
    .join('\n')
    .trim()
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function newsArtifactRe() {
  return /&(?:apos|amp|quot|nbsp|middot|ndash|mdash|#\d+|#x[0-9a-f]+);|\u00e2\u20ac|<!\[CDATA\[|Text settings|Story text Size|SKIP ADVERTISEMENT|hide caption toggle caption|Minimize to nav|Download the NEW APP|Toggle navigation|Current Mortgage Rates|Mortgage Rates and MBS|Rate Volatility Index|This website requires Javascrip|\batdigit\b|Subscribers only|Standard\s+Wide\s+Links|Today's Videos|Sponsor Message|Related contacts|Related insights|Related offices|Share Twitter Facebook LinkedIn|Explore more at Fragomen|Media mentions|Email \[emailprotected\]|Quick Hits|Read more Overview|Alerts driven thinking|Overview The Department|Each month, the USCIS|Toggle more options|Download Embed|Heard on [A-Z]|Transcript\b|Back transcript|This is a locator map|(?:^|[.!?]\s)By The Associated Press\b|\b(?:AP|Reuters|Getty Images|AFP)\s+(?:AP|Reuters|Getty Images|AFP)\b|^\d+\s+(?:minutes?|hours?|days?)\s+ago\b|(?:^|[.!?]\s)(?:Correspondent|Reporter|Editor),\s+[A-Z][A-Za-z ,.-]+|Country \/ Territory|Don't Miss an Update|Attorney Insights|not a law firm|does not provide legal advice|friendly legal teams|Reach out today|support your company.?s immigration needs|Set Yourself Apart from your Competition|Become the market expert|\b(?:News|Analysis|Politics|Elections|Media|Obituaries|Europe)\s+[A-Z][^.!?]{0,180}\s+May\s+\d{1,2},\s+2026\s+\d{1,2}:\d{2}\s+(?:AM|PM)\s+ET\s+By\b/i;
}

function ExampleCoraphWordCount(p) {
  return String(p || '')
    .split(/\s+/)
    .filter(Boolean).length;
}

const newsExpectations = new Map([
  ['AI & TECH NEWS', 10],
  ['US NEWS', 10],
  ['WORLD NEWS', 10],
  ['US IMMIGRATION NEWS', 5],
  ['MORTGAGE INDUSTRY NEWS', 10],
  // COVID was absent here (2026-06-03 ExampleCo: "why no COVID news, why's it a
  // blocker"), so a collapsed COVID card sailed past clean. content-heal now
  // owns healing it toward 5; the section is CLEAN at 1+ articles (ExampleCo
  // 2026-06-28) -- 5 is aspirational, only 0 is a shortfall. The relaxed minimum
  // lives in newsMinimums below; every other card keeps its exact count here.
  ['COVID-19 TREATMENTS & NEWS', 5],
]);

// The CLEAN minimum article count per news card. A card whose label is present
// here is checked as "at least minimum" instead of "exactly target": covid is
// clean at 1+ while still shooting for 5. Cards absent from this map keep the
// strict exact-count contract from newsExpectations.
const newsMinimums = new Map([['COVID-19 TREATMENTS & NEWS', 1]]);

// Map a briefing news-section label to the content-heal card key so the
// section check can read the wall/tier evidence and relax the prose gate for a
// headline-rescue row (Codex C#2 -- presentation only, never provenance).
const NEWS_LABEL_TO_HEAL_CARD = new Map([
  ['AI & TECH NEWS', 'aitech'],
  ['US NEWS', 'us'],
  ['WORLD NEWS', 'world'],
  ['US IMMIGRATION NEWS', 'immigration'],
  ['MORTGAGE INDUSTRY NEWS', 'mortgage'],
  ['COVID-19 TREATMENTS & NEWS', 'covid'],
]);

// Load the content-heal artifact once so the news section check can apply the
// tier-aware exception (Codex C#2): when a card recorded a named wall, a row
// that is an explicitly-labeled headline-rescue block is relaxed from the
// 3-ExampleCoraph prose gate. The relaxation is PRESENTATION ONLY -- the row still
// needs a real source link, and the underlying provenance/freshness gate is
// enforced separately by checkContentHealEvidence below.
const healArtifact = readJson(`data/agent/content-heal-${date}.json`);
function healCardForLabel(label) {
  const key = NEWS_LABEL_TO_HEAL_CARD.get(label);
  if (!key || !healArtifact || !healArtifact.cards) return null;
  return healArtifact.cards[key] || null;
}
function isHeadlineRescueRow(article) {
  // The canonical "Full summary unavailable: the article body was too thin to
  // summarize ..." note is the ONLY degraded news-row shape exempted from the
  // 3-ExampleCoraph prose gate. Older source-rescued one-ExampleCoraph rows are
  // intentionally not accepted because live render QC rejects that in-between
  // shape.
  //
  // The headline-only recognition is ANCHORED to the row's summary content
  // (isHeadlineOnlyExampleCoraphs): the note must be the SOLE summary ExampleCoraph. An
  // unanchored substring match would let an in-between row (a thin / truncated /
  // sub-3-ExampleCoraph body that merely CONTAINS the note phrase) skip the
  // 3-ExampleCoraph gate (Codex review 2026-06-22). Uses the shared recognizer in
  // scripts/lib/news-summarize.js so all layers stay in sync.
  return isHeadlineOnlyExampleCoraphs(ExampleCoraphsForArticle(article));
}

// Pure news-section validator: returns the array of failure strings for ONE
// news card. Exported so a regression test can drive the exact category logic
// (full 3-ExampleCoraph rows pass; a recognized honest headline-only row is exempt
// from the 3-ExampleCoraph rule but still needs a source link; an "in-between"
// thin/truncated/sub-3-ExampleCoraph row that is NOT a headline-only note still
// fails) without standing up a whole briefing. The module-level loop below pipes
// these into fail(), so the CLI behavior is unchanged.
function checkNewsSection(label, body, card, expectedCount) {
  const failures = [];
  const articles = parseNumberedItems(body);
  const cardHasWall = !!(card && card.wall && String(card.wall).trim());
  // A source-rescued / headline-only row is allowed when content-heal owns this
  // card with real evidence: either it recorded an honest wall, OR it healed to
  // threshold with source-bound items (each carrying a real URL + excerpt,
  // verified by checkContentHealEvidence). Without an owning card, a degraded row
  // is a defect (something dropped to a degraded shape with no provenance).
  const cardHasEvidence = !!(card && Array.isArray(card.items) && card.items.length);
  const cardOwnsRescue = cardHasWall || cardHasEvidence;
  // A card with a relaxed minimum (covid: 1) is clean at >= minimum even when it
  // is under target; every other card must hit its exact target. Either way a
  // named content-heal wall suppresses the count failure (ExampleCo 2026-06-28).
  const minimumCount = newsMinimums.has(label) ? newsMinimums.get(label) : expectedCount;
  const countShort =
    minimumCount !== expectedCount
      ? articles.length < minimumCount
      : articles.length !== expectedCount;
  if (expectedCount != null && countShort && !cardHasWall) {
    failures.push(`${label} has ${articles.length}/${expectedCount} articles`);
  }
  for (const article of articles) {
    const text = article.lines.join('\n');
    if (/\btranscript\b/i.test(article.title)) {
      failures.push(`${label} item ${article.n} is a transcript, not a news article`);
    }
    // Every row -- full article OR rescued/headline-only -- must carry a real
    // source link. This is provenance, never relaxed by the tier exception.
    if (!/https?:\/\//.test(text)) failures.push(`${label} item ${article.n} has no source link`);
    // Tier exception (Codex C#2): a labeled source-rescued / honest headline-only
    // row is allowed only when an owning content-heal card has real evidence (a
    // wall or source-bound healed items), and even then ONLY the prose-shape
    // checks are relaxed. A degraded row can never render as a full clean
    // article, so it must wear its label AND trace to a real card.
    const rescued = isHeadlineRescueRow(article);
    if (rescued && !cardOwnsRescue) {
      failures.push(
        `${label} item ${article.n} is a source-rescued row but no content-heal card owns it with a wall or source-bound evidence; a degraded row may render only with honest provenance`,
      );
      continue;
    }
    if (rescued) continue; // presentation-only relaxation; provenance already checked
    const paras = ExampleCoraphsForArticle(article);
    if (paras.length !== 3)
      failures.push(`${label} item ${article.n} has ${paras.length}/3 ExampleCoraphs`);
    if (paras.some((p) => /^(What happened|Why it matters|What to watch):/i.test(p))) {
      failures.push(
        `${label} item ${article.n} uses labeled bullets instead of a three-ExampleCoraph narrative summary`,
      );
    }
    if (paras.some((p) => p.length < 110 || ExampleCoraphWordCount(p) < 18)) {
      failures.push(`${label} item ${article.n} has a too-thin ExampleCoraph`);
    }
    // A ExampleCoraph ends "as prose" when its last sentence closes with terminal
    // punctuation, optionally followed by a closing quote. News summaries quote
    // sources verbatim in NPR/AP style, so a sentence often ends on a quotation
    // like `...a great injustice.”` -- the closing mark is a CURLY quote
    // (U+201D / U+2019), not the ASCII `"`/`'`. Accept both, or well-formed
    // quoted prose (16+ ExampleCoraphs on 2026-07-06) is falsely rejected and the
    // internal healer burns its attempts on phantom failures.
    if (paras.some((p) => !/[.!?]["'”’]?$/.test(p))) {
      failures.push(`${label} item ${article.n} has a ExampleCoraph that does not end as prose`);
    }
    if (paras.some((p) => newsArtifactRe().test(p))) {
      failures.push(
        `${label} item ${article.n} contains publisher chrome instead of briefing prose`,
      );
    }
  }
  return failures;
}

for (const [label, expectedCount] of newsExpectations) {
  const body = sectionBody(label);
  const card = healCardForLabel(label);
  for (const f of checkNewsSection(label, body, card, expectedCount)) fail(f);
}

const amyBody = sectionBody('AMY PROJECTS ASSIGNED');
const recentAmyQueue = readJsonl('data/agent/dispatch-queue.jsonl').filter((obj) => {
  const source = String(obj.source || '');
  if (!/(gmail_amy_email|vapi_call|otter)/i.test(source)) return false;
  const ts = new Date(obj.ts || obj.call_started_at || obj.date || '').getTime();
  return Number.isFinite(ts) && Date.now() - ts <= 24 * 3600 * 1000;
});
const recentAgentSessions = [
  readJson('data/agent-collab/current-session.json'),
  readJson('data/agent-collab/amy-outbox.json'),
  readJson('data/agent-collab/codex-outbox.json'),
].filter((obj) => {
  if (!obj) return false;
  const raw = obj.timestamp || obj.last_update || obj.started;
  const ts =
    typeof raw === 'number'
      ? raw * 1000
      : typeof raw === 'string' && /^\d{10}$/.test(raw)
        ? Number(raw) * 1000
        : new Date(raw || '').getTime();
  return Number.isFinite(ts) && Date.now() - ts <= 24 * 3600 * 1000;
});
const recentAmyWorkCount = recentAmyQueue.length + recentAgentSessions.length;
if (
  recentAmyWorkCount &&
  !/^\s*[^\n]*\[(#Amy email|phone call|voice note|session)\]/m.test(amyBody)
) {
  fail(
    `AMY PROJECTS has ${recentAmyWorkCount} recent user-originated task/session item(s) but no rendered rows`,
  );
}
if (
  /No dashboard prompts, #Amy emails, voice notes, phone-call tasks, or agent sessions/i.test(
    amyBody,
  ) &&
  recentAmyWorkCount
) {
  fail('AMY PROJECTS says zero despite recent #Amy/call/voice/session activity');
}

const featureBody = sectionBody('FEATURE BACKLOG');
if (
  /No approval asks today|failed the quality bar|weak suggestion\(s\) hidden/i.test(featureBody)
) {
  if (
    !/Feature backlog has \d+ weak suggestion\(s\)|weak suggestion\(s\) hidden by its own quality gate/i.test(
      blockersBody,
    )
  ) {
    fail('FEATURE BACKLOG weak-suggestions quality gate is not surfaced in top blockers');
  }
}
if (!/^\s+\d+\.\s+\[\d+\]\s+/m.test(featureBody)) {
  fail('FEATURE BACKLOG has no current scored approval asks');
}

const contentPipelineBody = sectionBody('CONTENT PIPELINE');
if (!/CONTENT WORK QUEUES/i.test(contentPipelineBody)) {
  fail('CONTENT PIPELINE must explain active work in business lanes, not a vague TEED UP list');
}
if (/^\s+TEED UP\b/im.test(contentPipelineBody)) {
  fail('CONTENT PIPELINE still uses vague TEED UP wording');
}
if (/#FEATURE_BACKLOG/i.test(contentPipelineBody)) {
  fail(
    'CONTENT PIPELINE must not duplicate feature-backlog decisions; those belong in Feature Backlog',
  );
}
if (/Decide \(approve \/ reject\).+backlog/i.test(contentPipelineBody)) {
  fail('CONTENT PIPELINE is mixing backlog approvals into the content work queue');
}

const shorts = readJson(`data/agent/shorts-proposals/${date}.json`);
// ExampleCo 2026-06-09: an honest thin-X day ships fewer than 10 with a recognized
// exhaustion wall (NEVER padded with weak entries like a 938-view/22-reply post).
// A walled shortfall publishes; only a missing artifact or a thin card with NO
// honest wall fails. Mirrors the viral content-shortfall contract.
const shortsWall =
  shorts && shorts.wall && /sources-exhausted|budget-exhausted/i.test(String(shorts.wall));
if (!shorts || !Array.isArray(shorts.proposals)) {
  fail('shorts proposal JSON missing');
} else {
  if (shorts.proposals.length !== 10 && !shortsWall)
    fail(`shorts proposals has ${shorts.proposals.length}/10 items`);
  if (!shorts.signals_count || Number(shorts.signals_count.x || 0) <= 0) {
    fail('shorts proposals are not grounded in X trend research');
  }
  shorts.proposals.forEach((p, i) => {
    const missing = ['title', 'trend_hook', 'why', 'script', 'source_url'].filter((k) => !p[k]);
    if (missing.length) fail(`shorts proposal ${i + 1} missing ${missing.join(', ')}`);
    const proposalText = JSON.stringify(p);
    if (
      /open the source, pull one repeatable task|turns the thread into a practical workflow|not a model-release recap|The viewer gets one concrete AI workflow/i.test(
        proposalText,
      )
    ) {
      fail(`shorts proposal ${i + 1} contains generic fallback copy`);
    }
    if (/x\.com\/[^ ]+\/status/i.test(String(p.title || ''))) {
      fail(`shorts proposal ${i + 1} title is a raw source URL`);
    }
    if (!/^https:\/\/x\.com\//i.test(String(p.source_url || ''))) {
      fail(`shorts proposal ${i + 1} source is not an X post`);
    }
    if (!/\b(X|views|likes|replies|thread|viral|trending)\b/i.test(String(p.trend_hook || ''))) {
      fail(`shorts proposal ${i + 1} does not explain why it is viral/trending on X`);
    }
  });
}
const shortsMdItems = parseNumberedItems(sectionBody("TODAY'S 10 SHORTS PROPOSALS"));
if (shortsMdItems.length !== 10 && !shortsWall)
  fail(`shorts markdown has ${shortsMdItems.length}/10 items`);

const timestampRe = /\b\d{1,2}:\d{2}(?::\d{2})?\s*[-–]\s*\d{1,2}:\d{2}(?::\d{2})?\b/;
const viral = readJson(`data/agent/viral-tech-clips/${date}.json`);
if (!viral || !Array.isArray(viral.proposals)) {
  fail('viral tech clip JSON missing');
} else {
  // A thin viral day publishes WITH an honest shortfall when content-heal
  // genuinely exhausted its source pool (recognized wall); it only fails (and
  // withholds publish) when the card is thin with no honest wall -- i.e. the
  // heal never ran or never tried. This stops a thin viral card from withholding
  // an otherwise-clean briefing all day (ExampleCo 2026-06-08).
  if (viral.proposals.length < 3 && !hasRecognizedHealWall(healArtifact, 'viral')) {
    fail(`viral tech clips has ${viral.proposals.length}/3 timestamped items`);
  }
  const viralIds = new Set();
  viral.proposals.forEach((p, i) => {
    const missing = [
      'source_url',
      'clip_url',
      'embed_url',
      'source_title',
      'speaker',
      'insight',
      'approx_timestamp',
      'short_description',
      'virality_signal',
    ].filter((k) => !p[k]);
    if (missing.length) fail(`viral clip ${i + 1} missing ${missing.join(', ')}`);
    if (p.id && viralIds.has(p.id)) fail(`viral clip ${i + 1} duplicates id ${p.id}`);
    if (p.id) viralIds.add(p.id);
    if (
      !/youtu\.?be|youtube\.com|vimeo\.com|x\.com|twitter\.com/i.test(
        String(p.clip_url || p.source_url || ''),
      )
    ) {
      fail(`viral clip ${i + 1} does not link to a source video`);
    }
    if (!timestampRe.test(String(p.approx_timestamp || '')))
      fail(`viral clip ${i + 1} has no timestamp window`);
    if (
      /ExampleCo|operator must|must scrub|verify speaker|verify timestamp|no description/i.test(
        JSON.stringify(p),
      )
    ) {
      fail(`viral clip ${i + 1} contains placeholder language`);
    }
  });
}
const viralMdBody = sectionBody('VIRAL TECH CLIP PROPOSALS');
const viralPreviewLines = (viralMdBody.match(/Preview clip:/g) || []).length;
if (
  viral &&
  Array.isArray(viral.proposals) &&
  viralPreviewLines < Math.min(viral.proposals.length, 3)
) {
  fail(
    `viral clip markdown has ${viralPreviewLines}/${Math.min(viral.proposals.length, 3)} preview links`,
  );
}

const mortgage = readJson(`data/agent/mortgage-rates/${date}.json`);
if (!mortgage || !Array.isArray(mortgage.indexes)) {
  fail('mortgage-rate JSON missing');
} else {
  const populated = mortgage.indexes.filter((ix) => ix.today != null);
  if (populated.length < 2) fail(`mortgage rates has only ${populated.length} populated sources`);
  for (const id of ['blend_of_indexes', 'fhlmc_pmms', 'mortgage_news_daily']) {
    const ix = mortgage.indexes.find((row) => row.id === id);
    if (!ix || ix.today == null) {
      fail(`mortgage ${id} missing today's rate`);
      continue;
    }
    if (ix.dod == null) fail(`mortgage ${id} missing day-over-day delta`);
    if (ix.wow == null) fail(`mortgage ${id} missing week-over-week delta`);
    if (ix.mom == null) fail(`mortgage ${id} missing month-over-month delta`);
  }
}

const mortgageBody = sectionBody('MORTGAGE RATE INDEXES');
if (!/\|\s*Index\s*\|\s*Today\s*\|\s*DoD\s*\|\s*WoW\s*\|\s*MoM\s*\|/i.test(mortgageBody)) {
  fail('mortgage rate markdown missing week-over-week column');
}
if (/\bn\/a\b/i.test(mortgageBody)) {
  fail('mortgage rate markdown uses n/a instead of a real delta or named blocker');
}

const aws = readJson(`data/agent/aws-costs-${date}.json`);
if (aws && aws.profiles) {
  const verifiedTotal = Object.values(aws.profiles).reduce((sum, profile) => {
    if (!profile || profile.ok === false) return sum;
    return sum + Object.values(profile.services || {}).reduce((a, b) => a + Number(b || 0), 0);
  }, 0);
  const awsBody = sectionBody('AWS COSTS');
  const titleTotal = (md.match(/^AWS COSTS \([^$]*\$([\d.]+)\s+total/im) || [])[1];
  if (!titleTotal) {
    fail('AWS costs title missing verified total');
  } else if (Math.abs(Number(titleTotal) - verifiedTotal) > 0.75) {
    fail(
      `AWS costs title total $${titleTotal} does not match verified accessible total $${verifiedTotal.toFixed(2)}`,
    );
  }
  if (
    Object.values(aws.profiles).some((profile) => profile && profile.ok === false) &&
    !/verified accessible AWS spend/i.test(awsBody)
  ) {
    fail(
      'AWS costs with inaccessible account must say the total is verified accessible spend only',
    );
  }
  if (!/Snapshot:/i.test(awsBody) || !/older or partial snapshot/i.test(awsBody)) {
    fail('AWS costs must name the snapshot time so totals do not appear to flip between runs');
  }
  // Snack Dude account has Cost Explorer disabled at the account level (a
  // one-time AWS-console toggle without a programmatic enable API). The aws
  // cost section surfaces an estimate inline ($1-3/mo serverless), so this
  // is not a daily-briefing blocker. Removed the requirement that it appear
  // in top blockers 2026-05-11 per ExampleCo feedback.
}

// Mirror the live dashboard's per-card blocker derivation so a local "clean"
// cannot pass while the dashboard shows incomplete cards. Checks the same DATA
// the dashboard reads (token rollup, AWS artifact, the md sections).
function checkDashboardCardCompleteness(markdown, dateStr) {
  const fails = [];
  const readArtifact = (rel) => {
    try {
      return JSON.parse(
        require('fs')
          .readFileSync(require('path').join(process.cwd(), rel), 'utf8')
          .replace(/^﻿/, ''),
      );
    } catch {
      return null;
    }
  };
  // 1) Token usage: the prior-CT-day rollup must carry real data (input/output,
  // cache, per-app), else the dashboard renders "Token Usage card is incomplete".
  let prev = null;
  try {
    const d = new Date(`${dateStr}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    prev = d.toISOString().slice(0, 10);
  } catch {
    prev = null;
  }
  if (prev) {
    const tok = readArtifact(`data/agent/token-usage-${prev}.json`);
    if (tok) {
      const input = (tok.total && tok.total.input) || 0;
      const output = (tok.total && tok.total.output) || 0;
      const apps = Array.isArray(tok.topProjects)
        ? tok.topProjects.length
        : tok.byProject
          ? Object.keys(tok.byProject).length
          : 0;
      if (input + output <= 0 || apps <= 0 || (tok.sessionsWithData || 0) <= 0) {
        fails.push(
          `TOKEN USAGE prior-day rollup is empty (input ${input}, output ${output}, sessionsWithData ${tok.sessionsWithData || 0}, apps ${apps}); collect-daily-token-usage.js must produce a real rollup -- the dashboard renders this card incomplete and raises a hard blocker`,
        );
      }
    }
  }
  // 2) AWS Costs: the headline dollar figure must equal the real spend, never $0
  // when the artifact ExampleCos cost (ExampleCo 2026-06-07: "$0 even when the detail
  // shows more").
  const aws = readArtifact(`data/agent/aws-costs-${dateStr}.json`);
  const awsTotal = aws ? aws.total || aws.grandTotal || 0 : 0;
  if (awsTotal > 0) {
    const sec = extractSection(markdown, 'AWS COSTS') || '';
    const nums = (sec.match(/\$\s?([0-9][0-9,]*\.?[0-9]*)/g) || []).map((s) =>
      Number(s.replace(/[^0-9.]/g, '')),
    );
    const maxShown = nums.length ? Math.max(...nums) : 0;
    if (maxShown <= 0)
      fails.push(
        `AWS COSTS artifact has $${awsTotal.toFixed(2)} but the card renders no positive dollar figure ($0); the headline must equal the detail total`,
      );
  }
  // 3) No duplicated ALL-CAPS section header (a card rendered twice is a defect).
  const headers = (markdown.match(/^[A-Z][A-Z0-9 &/().,'+-]{3,}:\s*$/gm) || []).map((h) =>
    h.trim(),
  );
  const counts = {};
  for (const h of headers) {
    counts[h] = (counts[h] || 0) + 1;
    if (counts[h] === 2)
      fails.push(
        `duplicate section header "${h.replace(/:$/, '')}" -- a card is rendered twice; section assembly must be idempotent`,
      );
  }
  // 4) Fake-blocker ban (ExampleCo 2026-06-07, repeated): a "blocker" that is explicitly
  // NOT a ExampleCo decision is a contradiction -- it is an Amy-fixable defect that must
  // be healed and looped on until gone, never displayed. A real blocker names a
  // specific credential, permission, or product decision ExampleCo must make. Any of
  // these phrases means Amy did not finish its job:
  const fakeBlockerPhrases = [
    /owning card must repair the source system/i,
    /\bnot a ExampleCo decision\b/i,
    /overnight heal window closed/i,
    /this is a self-heal Amy owns/i,
    /the collector must produce/i,
    /must rebuild the .* artifact/i,
  ];
  const blockersBody =
    extractSection(markdown, 'BLOCKERS - briefing quality gates') ||
    extractSection(markdown, 'BLOCKERS') ||
    '';
  for (const re of fakeBlockerPhrases) {
    if (re.test(blockersBody) || re.test(markdown)) {
      fails.push(
        `a blocker uses the Amy-fixable phrase ${re} -- that is not a ExampleCo blocker; heal the card/subsystem and loop until it clears, do not display it`,
      );
    }
  }
  return fails;
}

// ── New consistency assertions (clean cannot contradict the cards) ────────
// (a) System-Health <-> Blockers coverage set-diff: every non-green subsystem
// (probes AND Life:* rows, yellow included) must be named in BLOCKERS.
for (const f of checkHealthBlockersConsistency(md)) fail(f);
// (a-reverse) The other direction: a BLOCKERS entry that names a SYSTEM HEALTH
// subsystem as non-green must find that subsystem present + non-green in SYSTEM
// HEALTH. A blocker naming a subsystem SYSTEM HEALTH shows green or omits is a
// contradiction (ExampleCo 2026-07-01 collapsed-roster incident). Together with (a)
// the two force the non-green sets equal.
for (const f of checkHealthBlockersReverseConsistency(md)) fail(f);
// (a2) Dashboard parity: the live dashboard (server.js ~7940) derives a hard
// blocker for any card whose DATA is incomplete -- empty token rollup, AWS $0
// while the detail has spend, a stale source, a duplicated card. The local
// "clean" must mirror those checks or it passes while the dashboard shows
// blockers (2026-06-07: validator green, dashboard showed 4). A blocker that
// says "the owning card must repair the source system" is an Amy-fixable defect,
// never a ExampleCo blocker. -> feedback_clean_means_dashboard_card_data_complete_not_validator_pass
for (const f of checkDashboardCardCompleteness(md, date)) fail(f);
// (b) Tests-truth: recorded test failures/staleness must surface as RED + a
// Tests blocker, never as a clean briefing.
for (const f of checkTestsTruth(md, readJson('data/agent/tests-blocked.json'))) fail(f);
// (c) Token-freshness: stale source data cannot render as a current percentage
// without an explicit staleness acknowledgment or a token blocker.
for (const f of checkTokenFreshness(md, readJson('data/agent/claude-plan-usage.json'))) fail(f);
// (c2) Reputation scan: the card must carry a real source count and the actual
// queries, so the dashboard can never render a false "0/?" over a real scan
// (ExampleCo 2026-06-03). When the scan scope claims N sources, the section must
// render at least N source provenance rows and name the keywords/queries.
for (const f of checkReputationScan(md)) fail(f);
// (c3) Otter speaker staleness: a trailing/blocked speaker roster must surface as
// a non-green SYSTEM HEALTH "Otter speaker enrichment" row AND a named BLOCKERS
// entry, never a silent in-card note (ExampleCo 2026-06-22).
for (const f of checkOtterSpeakerStaleness(md)) fail(f);
// (d) GLOBAL one-Amy self-narration ban over the ENTIRE briefing body (System
// Health Attention + BLOCKERS + every card). Subsumes the old BLOCKERS-only
// check and is not gated on briefing mode.
for (const f of checkNoSelfNarration(md)) fail(f);
// (e) Content-evidence: viral/mortgage coverage must be backed by unique,
// non-empty, in-window evidence items OR a named wall, not a raw count.
for (const f of checkContentHealEvidence(readJson(`data/agent/content-heal-${date}.json`))) fail(f);
// (f) Per-card honest-state: a failing card must not render a fake-clean line.
// Built from the failures accumulated so far plus the structural set-diff.
for (const f of checkHonestState(md, { cards: buildCardStatusMap(failures) })) fail(f);

const jsonMode = process.argv.includes('--json');

// Expose the pure consistency checks so regression tests can exercise the
// category directly. When this file is required (not run as the CLI) we export
// and stop before any process.exit so the test runner is not torn down.
module.exports = {
  extractSection,
  blockersIsEmpty,
  isNonBlockingFileChurnLine,
  nonGreenSubsystems,
  presentSubsystems,
  allNonGreenSubsystems,
  checkHealthBlockersConsistency,
  checkHealthBlockersReverseConsistency,
  checkNoSelfNarration,
  checkReputationScan,
  checkHonestState,
  buildCardStatusMap,
  sectionForFailure,
  checkContentHealEvidence,
  hasRecognizedHealWall,
  checkTestsTruth,
  checkTokenFreshness,
  checkOtterSpeakerStaleness,
  isHeadlineRescueRow,
  checkNewsSection,
  NEWS_LABEL_TO_HEAL_CARD,
  newsExpectations,
  // Exported so the refresh pipeline can PRUNE the exact items this validator
  // would later reject (transcript title / publisher chrome), then backfill from
  // the healed pool -- single source of truth for "what is a bad news item".
  newsArtifactRe,
  checkDashboardCardCompleteness,
};

if (require.main === module) {
  if (failures.length) {
    if (jsonMode) {
      const cards = buildCardStatusMap(failures);
      console.log(
        JSON.stringify(
          {
            ok: false,
            date,
            failures,
            cards,
          },
          null,
          2,
        ),
      );
      process.exit(1);
    }
    console.error(`[briefing-quality] ${failures.length} failure(s) for ${date}`);
    for (const f of failures) console.error(`- ${f}`);
    process.exit(1);
  }

  if (jsonMode) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          date,
          failures: [],
          cards: {},
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }

  console.log(`[briefing-quality] PASS ${date}`);
}
