#!/usr/bin/env node
/**
 * verify-dashboard-cards-live.js
 *
 * Render-level QC for the briefing dashboard -- it verifies the thing ExampleCo
 * actually SEES, not the markdown. It fetches the authenticated rendered
 * dashboard, extracts every rendered `data-section` tile + its metric value +
 * body text, and asserts against the canonical card manifest
 * (scripts/lib/briefing-card-manifest.js):
 *
 *   1. CARD COMPLETENESS -- every ALWAYS-expected card is present as a rendered
 *      tile. A missing card is a HARD failure naming the card. Conditional cards
 *      (FULL-LIFE DATA BACKUP, CONTENT PIPELINE) are satisfied either by their
 *      own tile OR by their render-merge target (SYSTEM HEALTH with Life: chips;
 *      VIDEO APPROVAL QUEUE). If neither is present, that is a HARD failure --
 *      this is exactly the FULL-LIFE DATA BACKUP silent-drop on 2026-06-20.
 *   2. NON-EMPTY -- each present card has real body content, not an empty shell.
 *   3. VALUE SANITY -- no tile shows a known-broken sentinel that contradicts
 *      its body (metric "$0"/"unavailable" while the body has a real dollar
 *      amount; a count metric smaller than the count of rows in the body;
 *      vertical-text breakage; self-narration "Amy must/should" in a
 *      current-state field).
 *
 * WHY: a markdown-only QC (cloud-morning-briefing FULL_BRIEFING_CONTRACT,
 * validate-briefing-quality) passes while the render drops a card. The existing
 * live checker (verify-briefing-cards-live.js) only flags defects on cards that
 * ARE present; it never asserts a card EXISTS. This is the missing completeness
 * gate.
 *
 * USAGE:
 *   node scripts/verify-dashboard-cards-live.js [--date YYYY-MM-DD] [--html FILE] [--url URL]
 *   npm run verify:dashboard-cards
 *
 * FETCH: by default fetches the authenticated live dashboard. Auth is via
 *   ?k=<SB_BRIEFING_TOKEN>. Token resolution order:
 *     1. env SB_BRIEFING_TOKEN
 *     2. local env file (SB_BRIEFING_ENV_FILE, cwd .env, repo .env, /opt/secondbrain/.env)
 *     3. ssh to EC2 and read /opt/secondbrain/.env (EC2_SSH_KEY / EC2_HOST)
 *   Pass --html FILE to verify a saved/fixture HTML file with no network.
 *
 * EXIT CODES:
 *   0  all assertions pass.
 *   1  one or more card defects (missing / empty / value-sanity). Printed.
 *   2  dashboard unreachable / token unavailable / parsed 0 tiles. This is a
 *      RETRY condition for the caller, NOT a card-missing failure -- the wire-in
 *      treats it as "try again", never as a build-breaking missing-card result.
 */
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const manifest = require('./lib/briefing-card-manifest.js');
const {
  HEADLINE_ONLY_NOTE_RE,
  isThreeExampleCoraphArticleSummary,
  newsPublisherChromeSource,
} = require('./lib/news-summarize.js');
const { loadOperatorIdentity } = require('./lib/operator-identity.js');
const { ARTIFACT_REL_PATH, buildLiveBoardArtifact } = require('./lib/live-board-truth.js');
const { resolveDataArtifact, writeDataArtifact } = require('./lib/data-root.js');
const { ctDayKeyForInstant } = require('./lib/ct-day.js');

// Operator-specific tokens (employer name + username) are PII and load from
// memory/ at runtime, never hardcoded in source. The private tree resolves the
// real employer / username so the QC matches the live dashboard exactly; the
// public shell resolves neutral placeholders and ExampleCos no PII.
const OPERATOR = loadOperatorIdentity();
const EMPLOYER_SLUG = OPERATOR.owner.employer
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '_')
  .replace(/^_+|_+$/g, '');
const EMPLOYER_RX = OPERATOR.owner.employer.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const OWNER_USERNAME_RX = OPERATOR.owner.username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const EMPLOYER_NEWS_ID = `${EMPLOYER_SLUG}_group_news`;

const EXIT_OK = 0;
const EXIT_DEFECT = 1;
const EXIT_UNREACHABLE = 2;

function parseArgs(argv) {
  // Default to the America/Chicago calendar date, never the UTC one: between
  // 7 PM and midnight CT the UTC date is already "tomorrow", so a UTC default
  // would verify a briefing file that does not exist yet. Explicit --date wins.
  const opts = { date: ctDayKeyForInstant() };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--date') opts.date = argv[++i];
    else if (a === '--html') opts.htmlFile = argv[++i];
    else if (a === '--url') opts.url = argv[++i];
    else if (a === '--host') opts.host = argv[++i];
    // Write the canonical dashboard-qc-result.json artifact after this run,
    // the SAME schema/path writeDashboardQcArtifact (cloud-morning-briefing.js)
    // writes at publish time. See writeCanonicalArtifactFromResult below for
    // why a standalone run needs this (2026-07-06 stale-Blockers-count gap).
    else if (a === '--write-artifact') opts.writeArtifact = true;
    else if (a === '--cards') opts.cardIds = parseCardScope(argv[++i]);
    // Test-only override for the artifact write location; production always
    // writes through writeDataArtifact's normal SECONDBRAIN_DATA_DIR/repo
    // resolution.
    else if (a === '--data-dir') opts.dataDir = argv[++i];
    else if (!a.startsWith('--') && /^\d{4}-\d{2}-\d{2}$/.test(a)) opts.date = a;
  }
  return opts;
}

function parseCardScope(raw) {
  return [
    ...new Set(
      String(raw || '')
        .split(',')
        .map((part) => part.trim().toLowerCase())
        .filter((part) => /^[a-z][a-z0-9_]*$/.test(part)),
    ),
  ];
}

function scopeDashboardResult(result, cardIds = []) {
  const scope = [...new Set((cardIds || []).map(String).filter(Boolean))];
  if (!scope.length || !result || result.status === 'parse-failed') return result;
  const selected = new Set(scope);
  const cardStatuses = (result.cardStatuses || []).filter((card) => selected.has(card.id));
  const blockersOnly = selected.size === 1 && selected.has('blockers');
  const titleNeedles = new Set(
    cardStatuses
      .filter((card) => blockersOnly || card.id !== 'blockers')
      .flatMap((card) => [card.id, card.title])
      .map((value) => String(value || '').toLowerCase())
      .filter(Boolean),
  );
  const scoped = new Set();
  for (const card of cardStatuses) {
    for (const defect of card.defects || []) scoped.add(defect);
  }
  for (const defect of result.defects || []) {
    const text = String(defect || '');
    const lower = text.toLowerCase();
    if (blockersOnly && /^BLOCKERS-/i.test(text)) {
      scoped.add(text);
      continue;
    }
    for (const needle of titleNeedles) {
      if (needle && lower.includes(needle)) {
        scoped.add(text);
        break;
      }
    }
  }
  const defects = [...scoped];
  return {
    ...result,
    scoped: true,
    scopeCardIds: scope,
    cardStatuses,
    defects,
    status: defects.length ? 'defect' : 'ok',
  };
}

// Build the canonical dashboard-qc-result.json artifact from a verifyDashboard
// result and write it to the ONE path every consumer reads (the dashboard
// tile, the markdown At-a-glance line, chat reports, self-heal --
// scripts/lib/live-board-truth.js). Mirrors writeDashboardQcArtifact in
// cloud-morning-briefing.js exactly (same buildLiveBoardArtifact call, same
// legacy defectCount/defects fields kept alongside for archaeology) so a
// standalone `--write-artifact` run and a publish-time run are indistinguishable
// to any reader.
//
// WHY THIS EXISTS (ExampleCo 2026-07-06 #gap): only the publish-time build path
// (cloud-morning-briefing.js's own writeDashboardQcArtifact call) ever wrote
// this artifact. A standalone `node scripts/verify-dashboard-cards-live.js`
// run -- e.g. run by hand mid-day, or by a babysitter loop between publish
// cycles -- computed a fresh, correct result and printed it to stdout, but
// never persisted it. So the artifact could sit stale for hours (poisoned by
// an earlier outage-window run) while a fresh manual verify proved the truth
// had moved, with no way for that fresh truth to reach the dashboard tile
// short of waiting for the next publish. This function is that missing write.
function writeCanonicalArtifactFromResult(result, opts) {
  const writeOpts = {};
  if (opts.dataDir) writeOpts.dataDir = opts.dataDir;
  const dashQc = {
    ran: true,
    ok: result.status === 'ok',
    retry: false,
    defects: result.defects || [],
    cardStatuses: result.cardStatuses || [],
  };
  const canonical = buildLiveBoardArtifact({ dashQc, date: opts.date });
  let artifact = {
    ...canonical,
    // Legacy fields, retained for backward compatibility only -- see
    // writeDashboardQcArtifact's comment in cloud-morning-briefing.js.
    defectCount: dashQc.ok === false ? dashQc.defects.length : 0,
    defects: dashQc.defects.slice(0, 200),
  };
  if (result.scoped) {
    const existing = resolveDataArtifact(ARTIFACT_REL_PATH, writeOpts).json;
    artifact = mergeScopedArtifact(existing, artifact, result.scopeCardIds || []);
  }
  const absPath = writeDataArtifact(ARTIFACT_REL_PATH, artifact, writeOpts);
  return { artifact, absPath };
}

function mergeScopedArtifact(existing, scopedArtifact, scopeCardIds) {
  const scopedIds = new Set((scopeCardIds || []).map(String).filter(Boolean));
  const base =
    existing && Array.isArray(existing.cards)
      ? { ...existing, cards: existing.cards.slice() }
      : {
          ts: scopedArtifact.ts,
          date: scopedArtifact.date || null,
          ran: true,
          ok: null,
          retry: false,
          defectiveCardCount: 0,
          cards: [],
          defectCount: 0,
          defects: [],
        };
  const byId = new Map();
  for (const card of base.cards || []) {
    if (card && card.id) byId.set(String(card.id), card);
  }
  for (const card of scopedArtifact.cards || []) {
    if (!card || !card.id) continue;
    byId.set(String(card.id), card);
    scopedIds.add(String(card.id));
  }

  const cards = [...byId.values()];
  // Never use the generic "blockers" card id as a substring needle: every
  // BLOCKERS-NAMED-CARD defect starts with that word, so a scoped refresh that
  // includes the derived Blockers card would erase unrelated card defects.
  const scopedNeedles = [...scopedIds]
    .filter((id) => id !== 'blockers')
    .map((id) => id.toLowerCase());
  const replaceBlockersAccounting = scopedIds.has('blockers');
  const replaceBlockersOnly = scopedIds.size === 1 && scopedIds.has('blockers');
  const keptDefects = Array.isArray(base.defects)
    ? base.defects.filter((defect) => {
        const lower = String(defect || '').toLowerCase();
        if (
          replaceBlockersAccounting &&
          /^BLOCKERS-(?:COUNT|FLOOR):/i.test(String(defect || ''))
        ) {
          return false;
        }
        if (replaceBlockersOnly && /^BLOCKERS-/i.test(String(defect || ''))) return false;
        return !scopedNeedles.some((id) => lower.includes(id));
      })
    : [];
  const defects = [...keptDefects, ...((scopedArtifact.defects || []).slice(0, 200))].slice(
    0,
    200,
  );
  const defectiveCardCount = cards.filter((card) => card && card.status !== 'clean').length;
  return {
    ...base,
    ts: scopedArtifact.ts,
    date: scopedArtifact.date || base.date || null,
    ran: true,
    ok: defectiveCardCount === 0,
    retry: false,
    defectiveCardCount,
    cards,
    defectCount: defects.length,
    defects,
  };
}

const strip = (s) =>
  (s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&[a-z#0-9]+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// Count headline-only stub ROWS in a tile's raw inner HTML, at most ONE per
// distinct news item. Production renders the canonical "too thin to summarize"
// note TWICE for a single stub item: once in the face row
// `<li data-item="N" class="item-row news-row">` and again in the SEPARATE
// drilldown `<article class="news-detail" data-item="N">` under `.tile-full`
// (ec2-server.js ~14075 + ~16147). Both carry the SAME data-item, so a naive
// text-occurrence (or per-li) count double-counts and a lone allowed stub would
// trip the tolerance (Codex review rounds 5 + 6). We therefore DEDUPE by
// data-item: count the number of DISTINCT data-item values among the
// note-carrying element blocks.
function countNewsStubRows(inner) {
  const html = String(inner || '');
  const noteRe = new RegExp(HEADLINE_ONLY_NOTE_RE.source, 'i');
  // Path 1: real rendered item blocks (face <li> + drilldown <article>), each
  // carrying data-item. Walk every element that opens with a data-item, capture
  // its block up to the start of the next data-item element (or end), and record
  // the data-item when the block ExampleCos the note. Counting DISTINCT ids dedupes
  // the face + drilldown copies of the same stub item.
  const tagRe = /<(?:li|article)[^>]*\bdata-item="([^"]*)"[^>]*>/gi;
  const starts = [];
  let m;
  while ((m = tagRe.exec(html))) starts.push({ id: m[1], at: m.index });
  if (starts.length) {
    const stubIds = new Set();
    for (let i = 0; i < starts.length; i++) {
      const seg = html.slice(starts[i].at, i + 1 < starts.length ? starts[i + 1].at : html.length);
      if (noteRe.test(strip(seg))) stubIds.add(starts[i].id);
    }
    return stubIds.size;
  }
  // Path 2: markdown-shaped text body (no element markup). Split the stripped
  // text on numbered "N." row heads and count distinct rows carrying the note.
  const text = strip(html);
  const parts = text.split(/(?=\b\d+\.\s)/);
  if (parts.length > 1) {
    return parts.filter((seg) => noteRe.test(seg)).length;
  }
  // No row structure at all: fall back to a single presence check (0 or 1).
  return noteRe.test(text) ? 1 : 0;
}

/**
 * Parse the rendered dashboard HTML into tiles. Mirrors the markup contract:
 *   <section class="tile tile-<status> ..." ... data-section="<title>"> ... </section>
 * up to the next tile / </main> / </body>.
 */
function parseTiles(html) {
  const re =
    /<section class="tile ([^"]*)"[^>]*data-section="([^"]*)"[^>]*>([\s\S]*?)(?=<section class="tile |<\/main>|<\/body>)/g;
  const tiles = [];
  let m;
  while ((m = re.exec(html))) {
    const status = (m[1].match(/tile-(red|green|yellow|neutral|ExampleCo|warn)/) || [])[1] || 'neutral';
    const rawTitle = m[2];
    const name = strip(rawTitle);
    const rawInner = m[3];
    const defectBadgeText = extractLiveBoardBadgeText(rawInner);
    const inner = stripLiveBoardBadges(rawInner);
    const metric = strip((inner.match(/class="tile-metric[^"]*"[^>]*>([\s\S]*?)<\/div>/) || [])[1]);
    const body = strip(inner);
    // The visible tile FACE is `tile-content` up to the expandable `tile-full`
    // drilldown. Breakage/self-talk checks scope to the face: the drilldown
    // legitimately quotes task titles, article bodies, and dispatch text that
    // may contain words like "Amy must ..." which are NOT render defects.
    const face = strip(extractFace(inner));
    // Count the ACTUAL rendered news rows from the raw inner HTML (not the
    // text-stripped body). News cards render each item as
    // `<li ... class="item-row news-row">` (ec2-server.js ~14033). This is the
    // direct count of what ExampleCo sees, independent of the title-declared "(N)" or
    // the metric. Comparing this against the title claim catches the
    // "(10) title but 9 rows rendered" silent drop LIVE, with no builder arg.
    const newsRowsRendered = (inner.match(/class="[^"]*\bnews-row\b[^"]*"/g) || []).length;
    // Per-row count of headline-only stubs: count at most ONE stub per rendered
    // news row, so the SAME row's preview blurb + drilldown note (the note is
    // emitted twice for one row) are not double-counted (Codex review round 5).
    const newsStubRows = countNewsStubRows(inner);
    tiles.push({
      status,
      name,
      inner,
      rawInner,
      defectBadgeText,
      metric,
      body,
      face,
      bodyLen: body.length,
      newsRowsRendered,
      newsStubRows,
    });
  }
  return tiles;
}

function extractLiveBoardBadgeText(html) {
  return [...String(html || '').matchAll(/<div\s+class="tile-defect-badge"[^>]*>([\s\S]*?)<\/div>/gi)]
    .map((match) => strip(match[1]))
    .filter(Boolean)
    .join(' ');
}

function stripLiveBoardBadges(html) {
  return String(html || '').replace(
    /<div\s+class="tile-defect-badge"[^>]*>[\s\S]*?<\/div>/gi,
    ' ',
  );
}

function extractFace(inner) {
  const cIdx = inner.indexOf('class="tile-content"');
  if (cIdx < 0) return inner;
  const fIdx = inner.indexOf('class="tile-full"', cIdx);
  return fIdx > cIdx ? inner.slice(cIdx, fIdx) : inner.slice(cIdx);
}

function findTile(tiles, card) {
  return tiles.find((t) => card.match.test(t.name)) || null;
}

function findTiles(tiles, card) {
  return tiles.filter((t) => card.match.test(t.name));
}

// A tile is an "empty shell" if its body has essentially no real content beyond
// the title/metric chrome. Historically this floor was 15 chars, which was too
// low: an ugly-but-tiny face like "concerns detected" (17 chars) slipped under
// the EMPTY gate and then escaped the exec-crispness lint too, because a face
// that short is precisely the kind of vague, verdict-free copy the lint must
// catch. We raise the floor so the completeness/EMPTY check stops being a way to
// pass low-quality faces, and so anything above it is forced through the
// answer-first + token checks below. News/placeholder cards still carry honest
// short bodies, but those bodies clear this floor once they include a verdict
// token (e.g. "0 matches, scan ran clean" comfortably exceeds it). The real
// dropped-card case is still caught by the completeness check, not this floor.
const EMPTY_BODY_FLOOR = 40;

// Self-narration leak ("Amy must/should ...") in what should be a current-state
// field. The render has a guard for this; the QC double-checks the output. We
// scope this to the visible tile FACE -- the drilldown legitimately quotes
// dispatch/task titles that may contain "Amy must ...".
const SELF_NARRATION = /\bAmy\s+(?:must|should|needs to|will need to|has to)\b/i;

// Vertical-text breakage: a run of single chars separated by spaces, a known
// render defect ("u n a v a i l a b l e"). Scoped to the face.
const VERTICAL_TEXT = /(?:\b[A-Za-z]\s){6,}[A-Za-z]\b/;

// News-style cards declare their delivered count in the title, e.g.
// "US NEWS (10)" or "EMPLOYER GROUP NEWS (0)". For these the title count IS the
// headline metric, so a metric number SMALLER than the title-declared count is
// a real contradiction. This is the precise, high-signal form of the
// count-vs-body rule (it does not guess from arbitrary numbered lines, which
// over-fire on drilldown detail rows).
function titleDeclaredCount(name) {
  const m = String(name || '').match(/\((\d+)\)\s*$/);
  return m ? parseInt(m[1], 10) : null;
}

// ---------------------------------------------------------------------------
// Exec-crispness lint (deterministic, no model/vision dependency).
//
// These run over the rendered card FACE text (what ExampleCo actually reads at a
// glance), with two checks (SOURCE+DATE, STALENESS) allowed to look at the whole
// card body because a date stamp legitimately lives below the fold. Everything
// here is a pure regex assertion: a match (or required-absence) is a hard defect.
// Anything subjective ("is this insight meaningful") is demoted to a logged
// advisory in advisoryNotes(), never a hard gate, so the lint can never block on
// taste.
// ---------------------------------------------------------------------------

// Leading-chrome strip set. Built via fromCharCode so the source ExampleCos no
// literal en/em dash glyphs (global no-dash rule): space-class, colon, period,
// hyphen, pipe, gt, and U+2013 / U+2014.
const EN_DASH = String.fromCharCode(0x2013);
const EM_DASH = String.fromCharCode(0x2014);
const LEADING_CHROME = new RegExp('^[\\s:.\\-' + EN_DASH + EM_DASH + '|>]+');

// 1. TOKEN DENYLIST -- copy that should never reach the visible face. Each entry
// is { re, label } so a hit names the offending token in the defect, not just
// "denylist". Grouped by category for readability.
const FACE_DENYLIST = [
  // Self-reference / future-Amy narration. SELF_NARRATION already covers
  // "Amy must/should ..."; this widens to "needs to / has to / will" forms and
  // is kept here so the denylist is the single catalog of banned face tokens.
  {
    re: /\bAmy\s+(?:must|should|will|needs to|has to|is going to|plans to)\b/i,
    label: 'self-reference (future-Amy narration)',
  },
  // Log-speak / pipeline internals that leak the builder's scratch state.
  { re: /Basis:\s*\d+\s*headlines?/i, label: 'log-speak ("Basis: N headlines")' },
  { re: /\brung\s*[:=]/i, label: 'log-speak ("rung:")' },
  { re: /\bpublishRequested\b/i, label: 'log-speak ("publishRequested")' },
  { re: /\b=\s*(?:true|false)\b/i, label: 'log-speak ("= true/false")' },
  { re: /\bfetchStatus\b/i, label: 'log-speak ("fetchStatus")' },
  { re: /\bmethod:\s/i, label: 'log-speak ("method: ")' },
  { re: /\b(?:powershell|pwsh)(?:\.exe)?\b/i, label: 'operational launcher leak (PowerShell)' },
  // Raw filesystem paths -- POSIX life-archive/opt/Users/data roots and any
  // bare Windows drive-letter path. The owner's home-dir username is operator
  // PII, so the Users/<username> segment is built from the runtime config.
  {
    re: new RegExp(
      '\\/(?:life-archive|opt\\/secondbrain|Users\\/' + OWNER_USERNAME_RX + '|data\\/agent)\\/',
      'i',
    ),
    label: 'raw path (POSIX)',
  },
  { re: /\b[A-Za-z]:\\(?:[^\s\\]+\\?)+/, label: 'raw path (drive-letter)' },
  // Internal IDs -- bare UUID prefix, spine session ids, dispatch ids. The UUID
  // matcher keeps the "8-4-" bare-prefix shape the task specified, but a leading
  // lookahead requires at least one a-f hex letter in the 8-4-4 window so an
  // all-decimal date-time stamp like "20260521-1529-..." can never be misread as
  // a UUID (the historical false positive). A real briefing never shows a true
  // UUID on a card face, and true UUIDs almost always contain a hex letter.
  {
    re: /\b(?=[0-9a-f]{0,17}[a-f])[0-9a-f]{8}-[0-9a-f]{4}-/i,
    label: 'internal id (UUID)',
  },
  { re: /\bspine-session-/i, label: 'internal id ("spine-session-")' },
  { re: /\bdispatch-\d+\b/i, label: 'internal id ("dispatch-N")' },
];

// Scan a string against FACE_DENYLIST, returning [{ label, match }] for each
// category hit. Pulled out so the denylist scan is a single, named, testable
// unit (and exported for any future stage that wants the same catalog).
// Deterministic; no model dependency.
function denylistHits(text) {
  const s = String(text || '');
  const hits = [];
  for (const entry of FACE_DENYLIST) {
    const m = s.match(entry.re);
    if (m) hits.push({ label: entry.label, match: m[0] });
  }
  return hits;
}

// The path-leak denylist entries (POSIX + drive-letter). Their MATCH is a raw
// filesystem path, so quoting it verbatim in a defect message turns that very
// message into a path leak. The Blockers card is built from these messages, so
// on the next QC pass the path-leak detector re-reads its own prior evidence and
// re-flags it -- a self-reinforcing false positive that never clears. We redact
// the matched path to a token before it ever lands in a defect string. Sourced
// from FACE_DENYLIST by label so the redactor and the detector can never drift.
const PATH_LEAK_LABELS = new Set(['raw path (POSIX)', 'raw path (drive-letter)']);
const PATH_LEAK_RES = FACE_DENYLIST.filter((e) => PATH_LEAK_LABELS.has(e.label)).map(
  (e) => new RegExp(e.re.source, e.re.flags.includes('g') ? e.re.flags : e.re.flags + 'g'),
);

// Replace every raw filesystem path in an evidence snippet with a redacted
// "<path>" token so the snippet cannot itself trip the path-leak detector on a
// later scan. Idempotent and deterministic; non-path text is untouched.
function redactPathsInEvidence(snippet) {
  let out = String(snippet || '');
  for (const re of PATH_LEAK_RES) out = out.replace(re, '<path>');
  return out;
}

// 2. ANSWER-FIRST -- the first non-chrome sentence of the face must lead with a
// verdict. "Chrome" = the metric chip and leading punctuation/whitespace; the
// metric is extracted separately, so we strip a duplicate leading copy of it
// before reading the opening clause. A verdict token is YES/NO, a digit, a
// dollar/percent, a check/warn glyph, an explicit empty verdict (None / No X /
// 0 ...), a monitor verdict (NOT YET / UNVERIFIED / NOT CONNECTED), OR a leading
// status word (OK / Green / Healthy / Clean / All clear / Up / Done / Stale /
// Red / Blocked). The status words are included so health, system, and monitor
// cards that legitimately answer with a state word ("OK, everything green") are
// not mislabeled as buried-verdict prose. "NOT YET" / "UNVERIFIED" /
// "NOT CONNECTED" are real answer-first verdicts on the monitor cards (e.g. the
// cybercab card now leads with "NOT YET"); without them an honest negative
// answer was falsely flagged as buried-verdict prose. ExampleCo 2026-06-20 #gap.
// Required within the first ~40 chars of that clause.
const VERDICT_TOKEN =
  /(?:\bYES\b|\bNO\b|\bNOT YET\b|\bUNVERIFIED\b|\bNOT CONNECTED\b|\d|\$|%|✓|✔|⚠|\bNone\b|\bNo\s|\b0\s|\b(?:OK|green|healthy|clean|all clear|up|done|stale|red|block(?:ed|er)|nominal|fail(?:ed|ing)?|pass(?:ed|ing)?)\b)/i;
const AVAILABILITY_VERDICT = /\b(?:unavailable|unreachable)\b/i;
const ANSWER_FIRST_WINDOW = 40;

// 3. SOURCE+DATE -- if a face asserts a number/dollar/percent, the card must
// carry a date token somewhere (full card body, since the stamp may be below the
// fold). Softer defect: a numeric claim with no "as of" date is undated copy.
const FACE_HAS_NUMBER = /(?:\$\s?\d|\d+\s?%|\b\d+\b)/;
const DATE_TOKEN =
  /(?:\b\d{4}-\d{2}-\d{2}\b|\bas of\b|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}\b)/i;

// 4. STALENESS ALARM -- monitor cards (cybercab, news) that declare a
// last-checked / as-of stamp must be fresh. If the most recent declared date is
// older than 48h relative to the run date, the monitor is stale.
const STALE_HOURS = 48;
const LAST_CHECKED_HINT = /(?:last checked|as of|checked|updated|scanned)/i;
const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;

// 5. PROVENANCE -- a card that reports a 0-count / "no X" empty state must also
// carry a fetch-succeeded signal so a confirmed-empty is distinguishable from a
// failed-fetch silently rendered as empty. Keyed only on meetings / reputation /
// news cards. Lenient: any one provenance phrase clears it, so genuinely-fine
// empties that say "scan ran" / "checked" / "0 matches" are not false-flagged.
const ZERO_OR_NO = /(?:\bno\s+(?:new\s+)?[a-z]|\bnone\b|\b0\b|\bzero\b|\bnothing\b)/i;
const PROVENANCE_SIGNAL =
  /(?:read ok|scan ran|scanned|checked|fetch(?:ed)? ok|fetch succeeded|pulled|polled|queried|monitored|reviewed|swept|no (?:new )?(?:matches|results|hits|items|flags|risks)\b|clean\b|all clear)/i;

// Card-class predicates keyed on stable manifest ids (never on fuzzy titles).
const NEWS_IDS = new Set([
  'ai_tech_news',
  'us_news',
  'world_news',
  'us_immigration_news',
  'mortgage_industry_news',
  'covid_news',
  EMPLOYER_NEWS_ID,
]);
const isNewsCard = (card) => NEWS_IDS.has(card.id);
const isMonitorCard = (card) => card.id === 'tesla_cybercab' || isNewsCard(card);
const isProvenanceCard = (card) =>
  card.id === 'meetings' || card.id === 'reputation_risk' || isNewsCard(card);

function newsArticleBlocks(tile) {
  const html = String(tile.inner || '');
  const out = [];
  const re = /<article[^>]*\bclass="[^"]*\bnews-detail\b[^"]*"[^>]*>([\s\S]*?)<\/article>/gi;
  let m;
  while ((m = re.exec(html))) {
    const block = m[1];
    const title = strip(
      (block.match(/<header[^>]*class="[^"]*\bdetail-h\b[^"]*"[^>]*>([\s\S]*?)<\/header>/i) ||
        [])[1] || '',
    );
    const paras = [...block.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
      .map((p) => strip(p[1]))
      .filter(Boolean);
    out.push({ title, paras });
  }
  return out;
}

function articleBlockLooksSummarized(block) {
  const paras = Array.isArray(block.paras) ? block.paras : [];
  if (paras.length === 1 && HEADLINE_ONLY_NOTE_RE.test(paras[0])) return true;
  return isThreeExampleCoraphArticleSummary(paras, { title: block.title });
}

function newsSummaryShapeDefects(card, tile) {
  if (!isNewsCard(card)) return [];
  const blocks = newsArticleBlocks(tile);
  if (!blocks.length) return [];
  const bad = blocks.filter((block) => !articleBlockLooksSummarized(block));
  if (!bad.length) return [];
  const sample = bad
    .slice(0, 3)
    .map((block) => block.title || 'untitled')
    .join('; ');
  return [
    `NEWS-PROSE: ${card.id} (${tile.name}) ${bad.length} rendered article row(s) are not three-ExampleCoraph summaries of their article: ${sample}`,
  ];
}

function newsFaceRows(tile) {
  const html = String(tile.inner || '');
  const rows = [];
  const re = /<li\b[^>]*\bclass="[^"]*\bnews-row\b[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = re.exec(html))) {
    const row = m[1];
    const title = strip(
      (row.match(/<div[^>]*\bclass="[^"]*\bitem-name\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i) || [])[1] ||
        '',
    );
    const why = strip(
      (row.match(/<div[^>]*\bclass="[^"]*\bitem-why\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i) || [])[1] ||
        '',
    );
    const url = strip(
      (row.match(/<a[^>]*\bclass="[^"]*\bitem-src\b[^"]*"[^>]*\bhref="([^"]+)"/i) || [])[1] || '',
    );
    rows.push({ title, why, url });
  }
  return rows;
}

// The authoritative live-QC definition of news "chrome" is COMPILED from the
// single source of truth in news-summarize.js (newsPublisherChromeSource), so it
// can never drift from what stripPublisherChrome removes. Earlier this regex was
// a hand-maintained flat alternation that had accrued incident-pinned literal
// fragments -- place names ("Gulf of Oman", "Strait of Hormuz", "Tankers and
// cargo vessels") and ordinary article sentences ("The move was highly unusual",
// "faking his own death", "AI agents are becoming more sophisticated", "Coast
// Guard is smashing records", "Even areas above 1,000 metres", "Hat-Trick",
// "Balon de Oro", "EN VIVO", "Know Before You Go", "Office Closings") plus
// fragments not proven to be page chrome ("Latest Big pharma", "Help ensure
// someone", "MAKING AMERICA SAFE AGAIN") and bare names/phrases that over-flag
// real prose ("Getty Images", "AP Photo", "more coverage"). Those flagged
// legitimate world-news prose as chrome (world news routinely names those
// straits) and are removed. The detector now ExampleCos only generalizable
// categorical chrome shapes, shared with the stripper (Codex review 2026-06-30).
const NEWS_PUBLISHER_CHROME = new RegExp(newsPublisherChromeSource(), 'i');
const NEWS_JUMBLE_TOKENS = [
  /visualizing the quakes/i,
  /what'?s a doublet/i,
  /latin america'?s deadliest/i,
  /world reacts/i,
  /drive through/i,
  /article centers? on/i,
  /article focuses? on/i,
  /^(?:The|This)\s+(?:article|story|report|author|reporter|piece|column|op-?ed|analysis)\b/i,
  /\b(?:line|quote)\s+was\b/i,
  /image source/i,
  /image caption/i,
  /read more/i,
  /overview/i,
];
const NEWS_LOWERCASE_FRAGMENT_TITLE_RE =
  /^(?:[a-z]|f people\b|ut with\b|nd\b|he\b|she\b|they\b|it\b)/;
const NEWS_BROADCAST_PROMO_TITLE_RE =
  /\b(?:CBS News Sunday Morning|broadcast on (?:the )?CBS|streams on (?:the )?CBS|watch CBS News)\b/i;
const NEWS_ARTICLE_META_PROSE_RE =
  /\b(?:the|this|housingwires?)\s+(?:article|story|report|author|reporter|piece|column|op-?ed|analysis)\s+(?:centers?|centres?|focus(?:es|ed)?|reports?|says|said|argues?|notes?|points?)\b/i;
const COVID_NEWS_TOPIC_RE =
  /\b(?:covid(?:-19)?|sars[-\s]?cov[-\s]?2|coronavirus|long covid|paxlovid|remdesivir|molnupiravir|booster|variant|vaccine|vaccination|antiviral)\b/i;

function normalizedNewsText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/&[a-z#0-9]+;/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .slice(0, 180);
}

function newsTitleLooksJumbled(title) {
  const s = String(title || '');
  if (NEWS_PUBLISHER_CHROME.test(s)) return true;
  const trimmed = s.trim();
  if (NEWS_LOWERCASE_FRAGMENT_TITLE_RE.test(trimmed)) return true;
  if (
    /^(?:The|This)\s+(?:article|story|report|author|reporter|piece|column|op-?ed|analysis)\b/i.test(
      trimmed,
    )
  )
    return true;
  if (/^(?:You|We|I|They|It)\s+\w+/i.test(trimmed) && trimmed.length > 75) return true;
  if (NEWS_ARTICLE_META_PROSE_RE.test(trimmed)) return true;
  if (/\b(?:line|quote)\s+was\b/i.test(trimmed)) return true;
  if (NEWS_BROADCAST_PROMO_TITLE_RE.test(trimmed)) return true;
  const weird = (trimmed.match(/[^A-Za-z0-9\s.,'"():;$%&/-]/g) || []).length;
  if (trimmed.length > 40 && weird / trimmed.length > 0.08) return true;
  const hits = NEWS_JUMBLE_TOKENS.filter((rx) => rx.test(s)).length;
  if (hits >= 2) return true;
  // A long headline-like field with no sentence punctuation and many title-case
  // fragments is usually a navigation/sidebar scrape, not an executive title.
  const words = s.split(/\s+/).filter(Boolean);
  const capWords = words.filter((w) => /^[A-Z][a-z]{2,}/.test(w)).length;
  return s.length > 115 && !/[.!?:;]/.test(s) && capWords >= 8;
}

function newsRowQualityDefects(card, tile) {
  if (!isNewsCard(card)) return [];
  const rows = newsFaceRows(tile);
  if (!rows.length) return [];
  const defects = [];
  const chrome = rows.filter((row) => NEWS_PUBLISHER_CHROME.test(`${row.title} ${row.why}`));
  if (chrome.length) {
    defects.push(
      `NEWS-CHROME: ${card.id} (${tile.name}) ${chrome.length} row(s) surface publisher/page chrome instead of article summary prose`,
    );
  }
  const keys = rows.map((row) => normalizedNewsText(row.title || row.why)).filter(Boolean);
  const duplicateKeys = keys.filter((key, idx) => keys.indexOf(key) !== idx);
  if (duplicateKeys.length) {
    defects.push(
      `NEWS-DUPLICATE: ${card.id} (${tile.name}) repeats the same story/title ${duplicateKeys.length} time(s); news cards must dedupe within the card`,
    );
  }
  const jumbled = rows.filter((row) => newsTitleLooksJumbled(row.title));
  if (jumbled.length) {
    defects.push(
      `NEWS-TITLE-JUMBLE: ${card.id} (${tile.name}) ${jumbled.length} headline(s) look like scraped navigation/title fragments instead of crisp executive titles`,
    );
  }
  const metaProse = rows.filter((row) =>
    NEWS_ARTICLE_META_PROSE_RE.test(`${row.title} ${row.why}`),
  );
  if (metaProse.length) {
    defects.push(
      `NEWS-ARTICLE-META: ${card.id} (${tile.name}) ${metaProse.length} row(s) summarize the article as an article instead of giving the executive substance`,
    );
  }
  if (card.id === 'covid_news') {
    const offTopic = rows.filter((row) => !COVID_NEWS_TOPIC_RE.test(`${row.title} ${row.why}`));
    if (offTopic.length) {
      defects.push(
        `COVID-TOPIC: ${card.id} (${tile.name}) ${offTopic.length} row(s) are not visibly about COVID treatment/news`,
      );
    }
  }
  return [...new Set(defects)];
}

// Strip a leading duplicate of the metric chip off the face so ANSWER-FIRST
// reads the actual opening sentence, not the metric we already extracted.
function faceOpening(tile) {
  let s = String(tile.face || '');
  const metric = String(tile.metric || '').trim();
  if (metric) {
    const idx = s.indexOf(metric);
    if (idx >= 0 && idx < metric.length + 4) s = s.slice(idx + metric.length);
  }
  return s.replace(LEADING_CHROME, '').trim();
}

// Parse every ISO date in a string and return the most recent as a UTC ms epoch,
// or null. Used by the staleness alarm; deterministic, no locale dependency.
function latestIsoDate(text) {
  const s = String(text || '');
  let m;
  let best = null;
  ISO_DATE.lastIndex = 0;
  while ((m = ISO_DATE.exec(s))) {
    const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
    if (!Number.isNaN(t) && (best === null || t > best)) best = t;
  }
  return best;
}

function isoDatesInText(text) {
  const out = [];
  const s = String(text || '');
  let m;
  ISO_DATE.lastIndex = 0;
  while ((m = ISO_DATE.exec(s))) {
    const iso = `${m[1]}-${m[2]}-${m[3]}`;
    const t = Date.parse(`${iso}T00:00:00Z`);
    if (!Number.isNaN(t)) out.push({ iso, ms: t });
  }
  return out;
}

/**
 * Exec-crispness lint over one rendered tile. Pure. `runDate` (YYYY-MM-DD) is the
 * dashboard date, used as the staleness reference; defaults to today.
 */
function execCrispnessDefects(card, tile, runDate) {
  const defects = [];
  const face = String(tile.face || '');
  const body = String(tile.body || '');

  // 1. TOKEN DENYLIST on the face. The quoted snippet is redacted of any raw
  // filesystem path first, so a path-leak defect message can never itself trip
  // the path-leak detector when the Blockers card built from these messages is
  // re-scanned on the next QC pass (the self-reinforcing false positive).
  for (const hit of denylistHits(face)) {
    const snippet = redactPathsInEvidence(strip(hit.match)).slice(0, 60);
    defects.push(`EXEC-CRISPNESS: ${card.id} (${tile.name}) face leaks ${hit.label}: "${snippet}"`);
  }

  // 2. ANSWER-FIRST: the verdict must be up front. The metric chip is itself the
  // headline verdict on most cards (a count, "$X", "No", a glyph), so a metric
  // that ExampleCos a verdict token satisfies this outright. Otherwise the opening
  // clause (metric-stripped, so we do not double-count it) must lead with a
  // verdict within the first ANSWER_FIRST_WINDOW chars. Only flag when there is
  // some visible copy to judge -- a face with neither a metric nor an opening is
  // an EMPTY-shell concern, caught by the body-floor check, not here.
  const metric = String(tile.metric || '').trim();
  const opening = faceOpening(tile);
  const metricIsVerdict =
    metric !== '' && (VERDICT_TOKEN.test(metric) || AVAILABILITY_VERDICT.test(metric));
  if (!metricIsVerdict && opening) {
    const head = opening.slice(0, ANSWER_FIRST_WINDOW);
    if (!VERDICT_TOKEN.test(head) && !AVAILABILITY_VERDICT.test(head)) {
      defects.push(
        `EXEC-CRISPNESS: ${card.id} (${tile.name}) face is not answer-first (no verdict in the metric or the first ${ANSWER_FIRST_WINDOW} chars of copy): "${head}"`,
      );
    }
  }

  // 3. SOURCE+DATE on numbers (softer defect, still hard-gated but distinct id).
  if (FACE_HAS_NUMBER.test(face) && !DATE_TOKEN.test(body)) {
    defects.push(
      `EXEC-CRISPNESS(soft): ${card.id} (${tile.name}) face asserts a number/$/% but the card ExampleCos no date/"as of" stamp`,
    );
  }

  // 4. STALENESS ALARM for monitor cards (cybercab + news).
  if (isMonitorCard(card) && LAST_CHECKED_HINT.test(body)) {
    const latest = latestIsoDate(body);
    if (latest !== null) {
      const ref = Date.parse(`${runDate || new Date().toISOString().slice(0, 10)}T00:00:00Z`);
      const ageH = (ref - latest) / 3.6e6;
      if (ageH > STALE_HOURS) {
        defects.push(
          `EXEC-CRISPNESS: ${card.id} (${tile.name}) monitor stale -- last checked ${new Date(latest).toISOString().slice(0, 10)} is >${STALE_HOURS}h old (${Math.round(ageH)}h)`,
        );
      }
    }
  }

  // 5. PROVENANCE on empty meetings/reputation/news cards.
  // Empty-state is detected from the METRIC (the count/verdict chip), NOT a regex
  // over the whole face. News item headlines legitimately contain "no X" / "0" /
  // "No Longer" (us_news + immigration, 2026-06-21), which falsely tripped
  // ZERO_OR_NO on fully populated 10-item cards. A numeric metric > 0 is never
  // empty; a 0 metric, or a non-numeric metric that itself reads "no X"/none, is.
  const metricCount = /^-?\d+$/.test(metric) ? parseInt(metric, 10) : null;
  const looksEmpty = metricCount === 0 || (metricCount === null && ZERO_OR_NO.test(metric));
  if (isProvenanceCard(card) && looksEmpty && !PROVENANCE_SIGNAL.test(body)) {
    defects.push(
      `EXEC-CRISPNESS: ${card.id} (${tile.name}) reports an empty state with no fetch-succeeded provenance (cannot tell confirmed-empty from failed-fetch)`,
    );
  }

  // 6. NEWS PROSE: each rendered detail row must be either the canonical
  // headline-only note or a real three-ExampleCoraph article summary.
  defects.push(...newsSummaryShapeDefects(card, tile));
  defects.push(...newsRowQualityDefects(card, tile));

  return defects;
}

// Subjective "is this insight meaningful" checks are DEMOTED to advisories: they
// are logged, never gate. A short face that already cleared the answer-first +
// token checks is still worth a soft nudge, but it must never break the build on
// taste alone.
function advisoryNotes(card, tile) {
  const notes = [];
  const face = strip(tile.face || '');
  if (face && face.length < 24) {
    notes.push(
      `ADVISORY: ${card.id} (${tile.name}) face is very short ("${face}") -- consider a fuller verdict.`,
    );
  }
  return notes;
}

// BUILDER-vs-RENDER / target count check for news-style cards. This is the
// class the 2026-06-21 failure belonged to ("(10) title but 9 rendered", or
// "10 dropped as unreadable" where the builder produced 10 but the render shows
// 0). It is a HARD binary gate on the rendered face. Three sub-checks, all keyed
// off ONE target source (the manifest's getNewsTarget), never a hardcoded copy:
//
//   a. TARGET: the card's rendered/declared item count must equal its manifest
//      target (news = 10, covid = 5). A title that claims fewer than the target
//      (e.g. "US NEWS (9)" when target is 10) is a hard short-delivery defect.
//   b. BUILDER-vs-RENDER: when the caller supplies the source/builder item count
//      for this card (builderCount), the rendered count must EQUAL it -- a
//      smaller render is the "dropped as unreadable" silent drop.
//   c. EMPLOYER mention-or-zero: the employer card is exempt from a fixed
//      target; it passes at its real mention count OR a scanned-zero placeholder
//      body, and is only flagged when it claims 0 with no placeholder evidence.
//
// `renderedCount` is read from the title-declared "(N)" suffix, falling back to a
// numeric metric. `builderCounts` maps a manifest card id to the source artifact
// item count for this run (optional; absent for a card means the builder count is
// ExampleCo and only the target/declared check applies).
//
// The placeholder regex names the operator's employer (PII), so it is built from
// the runtime config rather than hardcoded.
const EMPLOYER_ZERO_PLACEHOLDER = new RegExp(
  '(?:no\\s+' +
    EMPLOYER_RX +
    '\\s+mentions|0\\s+matches|noise-free|scanned\\s+\\d+|no\\s+summarizable\\s+' +
    EMPLOYER_RX +
    ')',
  'i',
);

function renderedItemCount(tile) {
  const declared = titleDeclaredCount(tile.name);
  if (declared !== null) return declared;
  const metricNum = /^\d+$/.test(String(tile.metric || '').trim())
    ? parseInt(tile.metric, 10)
    : null;
  return metricNum;
}

function newsCountDefects(card, tile, builderCounts = {}) {
  const defects = [];
  const rendered = renderedItemCount(tile);

  // (c) EMPLOYER mention-or-zero card: exempt from a fixed target.
  if (card.mentionOrZero) {
    if ((rendered === 0 || rendered === null) && !EMPLOYER_ZERO_PLACEHOLDER.test(tile.body)) {
      defects.push(
        `BUILDER-COUNT: ${card.id} (${tile.name}) shows 0 mentions with no scanned-zero placeholder (cannot tell confirmed-empty from a dropped scan)`,
      );
    }
    return defects;
  }

  const target = manifest.getNewsTarget(card);
  // The CLEAN minimum may be below the aspirational target (covid: target 5,
  // minimum 1). A card at >= minimum is not a shortfall even when it is under
  // target (ExampleCo 2026-06-28). For every other news card minimum === target, so
  // the exact-count contract is unchanged.
  const minimum = manifest.getNewsMinimum(card);

  // (a) MINIMUM: a news card must render at least its manifest clean minimum.
  if (minimum !== null && rendered !== null && rendered < minimum) {
    const benchmarkWord = minimum === target ? 'target' : 'minimum';
    defects.push(
      `BUILDER-COUNT: ${card.id} (${tile.name}) rendered ${rendered} item(s), below its ${benchmarkWord} of ${minimum}`,
    );
  }

  // (b) DECLARED-vs-RENDERED rows: the title/metric claims N, but the body must
  // actually render N news rows. This is the LIVE builder-vs-render check that
  // needs NO external builder arg: it counts the rendered `news-row` <li> items
  // and flags a claim larger than what actually rendered. This is the ai_tech
  // "(10) title but 9 rows rendered" class -- previously only caught when a
  // builderCounts arg was supplied (which production never did), so it never ran
  // live. We only assert when the card actually rendered a news-row list (target
  // cards with >0 rendered rows); a placeholder/empty body has 0 rows and is
  // governed by the EMPTY/target checks, not this one.
  const declared = rendered;
  if (
    target !== null &&
    declared !== null &&
    Number.isFinite(tile.newsRowsRendered) &&
    tile.newsRowsRendered > 0 &&
    tile.newsRowsRendered < declared
  ) {
    defects.push(
      `BUILDER-COUNT: ${card.id} (${tile.name}) claims ${declared} item(s) but only ${tile.newsRowsRendered} news row(s) actually rendered (silent drop)`,
    );
  }

  // (c) BUILDER-vs-RENDER: when the source builder count is supplied (the
  // authoritative count from the healed-news artifact / "Coverage: N/N" lines),
  // the render must show at least that many. Wired live by both publish callers.
  const builderCount = builderCounts[card.id];
  if (Number.isFinite(builderCount) && rendered !== null && rendered < builderCount) {
    defects.push(
      `BUILDER-COUNT: ${card.id} (${tile.name}) builder produced ${builderCount} item(s) but the render shows ${rendered} (silent drop)`,
    );
  }

  return defects;
}

// NEWS-READINESS accepts exactly two row shapes: a sourced three-ExampleCoraph
// article summary or the canonical headline-only note. NEWS-PROSE still rejects
// malformed in-between prose; this legacy NEWS-STUB hook stays non-blocking so
// the canonical note itself cannot force a target shortfall.
const BROKEN_CARD_COPY =
  /did not produce content on the cloud build|Broken for a known reason self-heal could not fix|No repair attempt was recorded/i;

// Count headline-only stub ROWS for a tile. Prefer the per-row count computed
// from the raw HTML (parseTiles -> newsStubRows), which counts at most one stub
// per rendered news row and so never double-counts the SAME row's preview +
// drilldown note (Codex review round 5). Fall back to a per-row segmentation of
// the stripped body for tile fixtures that do not carry newsStubRows.
function countHeadlineOnlyStubRows(tile) {
  if (Number.isFinite(tile.newsStubRows)) return tile.newsStubRows;
  const noteRe = new RegExp(HEADLINE_ONLY_NOTE_RE.source, 'i');
  const text = String(tile.body || '');
  const parts = text.split(/(?=\b\d+\.\s)/);
  if (parts.length > 1) return parts.filter((seg) => noteRe.test(seg)).length;
  return noteRe.test(text) ? 1 : 0;
}

function newsStubDefects(card, tile) {
  if (!isNewsCard(card)) return [];
  return [];
}

function valueSanityDefects(card, tile, builderCounts = {}) {
  const defects = [];

  // Manifest-declared sentinel-vs-body rules (e.g. AWS/Snack Dude metric "$0"
  // or "unavailable" while the body ExampleCos a real dollar figure). Tested
  // against the full body because the contradicting figure lives there.
  for (const rule of card.valueSanity || []) {
    if (rule.when.test(tile.body) && rule.forbidMetric.test(tile.metric)) {
      defects.push(
        `VALUE-SANITY: ${card.id} (${tile.name}) metric "${tile.metric}" ${rule.reason}`,
      );
    }
  }

  // Title-declared count vs headline metric (news-style cards only).
  const declared = titleDeclaredCount(tile.name);
  const metricNum = /^\d+$/.test(tile.metric) ? parseInt(tile.metric, 10) : null;
  if (declared !== null && metricNum !== null && metricNum < declared) {
    defects.push(
      `VALUE-SANITY: ${card.id} (${tile.name}) headline metric ${metricNum} is smaller than the ${declared} the title claims`,
    );
  }

  // Builder-vs-render / news-target count (the "10 dropped as unreadable" class).
  defects.push(...newsCountDefects(card, tile, builderCounts));

  // Stub-quality: a news card full of headline-only stubs is a defect (real
  // articles must summarize in full). Count-consistency above is independent.
  defects.push(...newsStubDefects(card, tile));

  // Vertical-text breakage on the visible face.
  if (VERTICAL_TEXT.test(tile.face)) {
    defects.push(`VALUE-SANITY: ${card.id} (${tile.name}) face shows vertical-text breakage`);
  }

  // Self-narration leak on the visible face.
  if (SELF_NARRATION.test(tile.face)) {
    defects.push(
      `VALUE-SANITY: ${card.id} (${tile.name}) leaks self-narration ("Amy must/should ...") on the visible tile face`,
    );
  }

  return defects;
}

// The renderer paints a card's tile RED when the briefing itself considers that
// card blocked/defective (action items "Action card held", a build-marked
// blocker). tile.status was parsed (line ~96) and then IGNORED, so a red card
// passed as clean and the QC disagreed with the briefing's own Blockers card.
// The QC must HONOR the render's verdict: a red tile is a hard defect, full stop.
// The Blockers card is the meta-card that LISTS blockers, so it is exempt (it is
// supposed to be red when blockers exist). ExampleCo 2026-06-21: this hole is why a
// blocked Action Items card and the briefing's "6 hard blockers" both read as
// "clean" in the QC.
function statusDefects(card, tile) {
  if (!tile || card.id === 'blockers') return [];
  if (tile.status === 'red') {
    if (awsCostsIsCleanThresholdAlert(card, tile)) return [];
    const detail =
      card.id === 'system_health'
        ? systemHealthBlockedTileDetail(tile.body || tile.face || '')
        : '';
    return [
      `BLOCKED-TILE: ${card.id} (${tile.name}) renders RED (the briefing itself flags this card blocked); it is not clean${detail ? `; ${detail}` : ''}`,
    ];
  }
  // A card can also narrate a hard block in its BODY without rendering red
  // (OTTER/VOICE "BLOCKER: roster empty" / "Hard blocker: ..."). That is still a
  // blocked, not-clean card and MUST count as a defect -- otherwise it appears on
  // the Blockers card with no matching defect and trips BLOCKERS-FLOOR. Same
  // marker the builder uses to surface it and the under-report check uses to flag.
  if (HARD_BLOCKER_MARKER.test(tile.body || '')) {
    return [
      `BLOCKED-CARD: ${card.id} (${tile.name}) is blocked (its body ExampleCos a hard-blocker marker); it is not clean`,
    ];
  }
  if (BROKEN_CARD_COPY.test(tile.body || '')) {
    return [
      `BLOCKED-CARD: ${card.id} (${tile.name}) renders broken-card fallback copy; an honest fallback is still a blocker, not a clean card`,
    ];
  }
  return [];
}

function systemHealthBlockedTileDetail(text) {
  const body = strip(text);
  if (!body) return '';
  const known = body.match(/System Health has \d+ known subsystem defects?:\s*([^.;]+)/i);
  if (known && known[1]) return `failing subsystem clue: ${known[1].trim()}`;
  const sentence = body
    .split(/(?<=[.!?])\s+/)
    .find((part) => /\b(?:red|blocked|defect|failed|cannot|stale)\b/i.test(part));
  if (!sentence) return '';
  return `system health evidence: ${sentence.trim().slice(0, 180)}`;
}

function peopleFilesFreshnessDefects(card, tile, runDate) {
  if (!tile || card.id !== 'people_files_changes') return [];
  const ref = Date.parse(`${runDate || new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(ref)) return [];
  const stale = isoDatesInText(tile.body).filter((d) => ref - d.ms > STALE_HOURS * 3.6e6);
  if (!stale.length) return [];
  return [
    `STALE-PEOPLE-FILE: ${card.id} (${tile.name}) is a 24h card but surfaces older event date(s): ${[
      ...new Set(stale.map((d) => d.iso)),
    ].join(', ')}`,
  ];
}

function peopleFilesDetailDefects(card, tile) {
  if (!tile || card.id !== 'people_files_changes') return [];
  const text = `${tile.body || ''} ${tile.inner || ''}`;
  const defects = [];
  if (/\[\.\.\.\]|What was new:\s*(?:\[\.\.\.\])?\s*(?:<|$)/i.test(text)) {
    defects.push(
      `PEOPLE-FILE-DETAIL: ${card.id} (${tile.name}) renders blank or placeholder "What was new" detail; 24h people changes need a concrete title/detail`,
    );
  }
  if (
    /\b(?:Why:\s*)?Contact file changed\b|\bcontact file changed by \+\d+\/-\d+ lines\b/i.test(text)
  ) {
    defects.push(
      `PEOPLE-FILE-DETAIL: ${card.id} (${tile.name}) renders generic "contact file changed" copy instead of the concrete 24h people-file detail`,
    );
  }
  const articleBlocks = String(tile.inner || '').match(/<article\b[\s\S]*?<\/article>/gi) || [];
  const blankArticles = articleBlocks.filter((block) => {
    const plain = strip(block);
    return /<header\b/i.test(block) && !/\bWhat was new:\s*\S/i.test(plain);
  });
  if (blankArticles.length) {
    defects.push(
      `PEOPLE-FILE-DETAIL: ${card.id} (${tile.name}) ${blankArticles.length} people-file drilldown item(s) lack a concrete "What was new" detail`,
    );
  }
  if (/\b(?:Jun|June)\s+14\s*(?:-|to)\s*15\b/i.test(text)) {
    defects.push(
      `PEOPLE-FILE-STALE-REASON: ${card.id} (${tile.name}) is a 24h card but explains changes from Jun 14-15 transcript enrichment`,
    );
  }
  if (/\bExampleCo Millar\b[\s\S]{0,240}\bGod defended His own reputation\b/i.test(text)) {
    defects.push(
      `PEOPLE-FILE-VOICE-ATTRIBUTION: ${card.id} (${tile.name}) attributes ExampleCo material to ExampleCo Millar without voice-matched proof`,
    );
  }
  return defects;
}

function otterSpeakerParetoAudioDefects(card, tile) {
  if (!tile || card.id !== 'otter_speaker_pareto') return [];
  if (!/PRIVATE_NAME speaker/i.test(tile.body || '')) return [];
  if (/<audio\b/i.test(tile.inner || '') || /voice-audio/i.test(tile.inner || '')) return [];
  return [
    `OTTER-AUDIO: ${card.id} (${tile.name}) shows ExampleCo speakers without playable representative audio; ExampleCo speaker rows must be clickable and play a sample`,
  ];
}

function awsCostsDetailDefects(card, tile) {
  if (!tile || card.id !== 'aws_costs') return [];
  const headings = ['Per account', 'Per app', 'Top services'];
  const empty = headings.filter((heading) => {
    const section = detailSectionAfterHeading(tile.inner || '', heading);
    return section !== null && strip(section).length < 20;
  });
  const defects = [];
  if (empty.length) {
    defects.push(
      `AWS-DETAIL-EMPTY: ${card.id} (${tile.name}) drilldown has empty required section(s): ${empty.join(', ')}`,
    );
  }
  if (/per-account breakdown not synced/i.test(tile.body || '')) {
    defects.push(
      `AWS-DETAIL-EMPTY: ${card.id} (${tile.name}) says the per-account breakdown is not synced while rendering green`,
    );
  }
  return defects;
}

// Must track ec2-server.js AWS_COST_RED_THRESHOLD. Duplicated as a read-only
// verification floor (this script never sets card status, only checks it), so
// a drift here can only make the QC exemption MORE conservative, never less --
// if the real threshold ever moves, the worst case is this guard temporarily
// requires a slightly-wrong total before exempting, which still fails safe
// (a real red card with no exemption still just reports BLOCKED-TILE, it is
// never silently swallowed).
const AWS_COST_RED_THRESHOLD_FLOOR = 1000;

// AWS COSTS renders RED once verified live spend crosses AWS_COST_RED_THRESHOLD
// (ec2-server.js). That is a real, correctly-surfaced business fact (ExampleCo's own
// $800/$1000 watch/act band), not a rendering bug -- there is no "repair tactic"
// that fixes real AWS spend, and looping self-heal on it forever
// (feedback_briefing_clean_or_blocked_contract.md: "blocked" means ExampleCo owns the
// next action, not "Amy should retry") just wastes cycles. The builder
// (scripts/cloud-morning-briefing.js buildAwsCostsSection) only emits the
// "Threshold band:" line on the REAL, live, fully-populated path -- the
// stale/denied/blocked path returns a different `detail` with no threshold band
// and no Per account/Per app/Top services sections. So "Threshold band:" present
// AND all three required sections ACTUALLY PRESENT WITH REAL CONTENT AND a
// verified total that genuinely crosses the red floor means this red tile is a
// genuine, honestly self-documented cost alert, not a broken or stale card. It
// still counts as blocked for Blockers-card accounting via BLOCKERS-NAMED-CARD
// (it is legitimately named on the Blockers card as an owner decision); it just
// is not a false "render QC defect" that tells the self-healer to keep
// retrying.
//
// Codex review 2026-07-06: the original version only checked
// awsCostsDetailDefects (which treats a MISSING heading as clean -- it only
// flags a heading that exists but is short), so a malformed card missing a
// required section entirely, or a red tile below the real dollar threshold
// with stray "Threshold band:" text, could have slipped through. Both gaps are
// closed below: every required heading must be PRESENT (not just non-empty
// when present), and the parsed total must actually exceed the red floor.
function awsCostsIsCleanThresholdAlert(card, tile) {
  if (card.id !== 'aws_costs') return false;
  const body = tile.body || '';
  const inner = tile.inner || '';
  if (!/\bThreshold band:/i.test(body)) return false;
  if (awsCostsDetailDefects(card, tile).length) return false;
  const requiredHeadings = ['Per account', 'Per app', 'Top services'];
  const allHeadingsPresent = requiredHeadings.every(
    (heading) => detailSectionAfterHeading(inner, heading) !== null,
  );
  if (!allHeadingsPresent) return false;
  // The builder always titles the tile "AWS COSTS ($X total)" on the real, live
  // path (scripts/cloud-morning-briefing.js), so tile.name ExampleCos the total
  // reliably; the drilldown body restates the dollar figure in prose but does
  // not always pair it with the literal word "total" next to the digits.
  const totalMatch = String(tile.name || '').match(/\$([\d,]+(?:\.\d+)?)\s+total/i);
  const total = totalMatch ? parseFloat(totalMatch[1].replace(/,/g, '')) : NaN;
  // ALARM BASIS (ExampleCo 2026-07-07): the render colors RED off the run-rate, not
  // the 30-day sum. Prefer "current $X/mo" / "Current monthly run-rate" when a
  // post-fix outlier day is named; otherwise use the legacy 72h projection.
  // Fall back to the 30d total only when no run-rate rendered.
  const currentTitle = String(tile.name || '').match(/current\s*\$([\d,]+(?:\.\d+)?)\/mo/i);
  const currentBody = body.match(/Current monthly run-rate:\s*\$([\d,]+(?:\.\d+)?)/i);
  const current =
    currentTitle || currentBody
      ? parseFloat((currentTitle || currentBody)[1].replace(/,/g, ''))
      : NaN;
  const projTitle = String(tile.name || '').match(/projected\s*\$([\d,]+(?:\.\d+)?)\/mo/i);
  const projBody = body.match(/Projected monthly \(from 72h avg\):\s*\$([\d,]+(?:\.\d+)?)/i);
  const projected =
    projTitle || projBody ? parseFloat((projTitle || projBody)[1].replace(/,/g, '')) : NaN;
  const alarmBasis = Number.isFinite(current) ? current : Number.isFinite(projected) ? projected : total;
  if (!Number.isFinite(alarmBasis) || alarmBasis <= AWS_COST_RED_THRESHOLD_FLOOR) return false;
  return true;
}

function detailSectionAfterHeading(html, heading) {
  const s = String(html || '');
  const re = /<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi;
  let m;
  const heads = [];
  while ((m = re.exec(s))) {
    heads.push({ title: strip(m[1]), start: m.index, end: re.lastIndex });
  }
  const idx = heads.findIndex((h) => h.title.toLowerCase().includes(String(heading).toLowerCase()));
  if (idx < 0) return null;
  const end = idx + 1 < heads.length ? heads[idx + 1].start : s.length;
  return s.slice(heads[idx].end, end);
}

function kingdomResearchDefects(card, tile) {
  if (!tile || card.id !== 'kingdom_equipping') return [];
  const raw = `${tile.body || ''} ${tile.inner || ''}`;
  const urlCount = (raw.match(/https?:\/\//g) || []).length;
  const sourceCount = (raw.match(/\bCurrent public signal\b|\bSource:/gi) || []).length;
  if (urlCount >= 3 && sourceCount >= 3) return [];
  return [
    `KINGDOM-RESEARCH: ${card.id} (${tile.name}) does not show a current researched source for each of the three ideas (${urlCount} URL(s), ${sourceCount} source signal(s)); this card must research on ExampleCo's behalf, not recycle memory-only ideas`,
  ];
}

function communicationCoachingDefects(card, tile) {
  if (!tile || card.id !== 'communication_coaching') return [];
  const text = `${tile.metric || ''} ${tile.body || ''} ${tile.inner || ''}`;
  const defects = [];
  if (/\bheld\b|grounding file missing|no vetted literature|Nothing for you to do/i.test(text)) {
    defects.push(
      `COMM-COACHING-HELD: ${card.id} (${tile.name}) is held or missing grounding; communication coaching is a blocker when it cannot meet its quote/source contract`,
    );
  }
  if (!/Evidence quote:|"[^"]{8,}"/.test(text) || !/\bSource:\s*\S/i.test(text)) {
    defects.push(
      `COMM-COACHING-SOURCE: ${card.id} (${tile.name}) lacks a visible ExampleCo quote and vetted source citation`,
    );
  }
  const longQuote = [
    ...String(tile.body || '').matchAll(/Evidence quote:\s*["“][^"”]{181,}["”]/gi),
  ];
  if (longQuote.length) {
    defects.push(
      `COMM-COACHING-VISUAL: ${card.id} (${tile.name}) renders oversized evidence quotes on the card face; quote snippets must be short enough to scan`,
    );
  }
  if (String(tile.face || '').length > 900 && /Evidence quote:/i.test(tile.face || '')) {
    defects.push(
      `COMM-COACHING-VISUAL: ${card.id} (${tile.name}) packs too much quote/source text onto the visible card face; coaching needs compact rows with detail on click`,
    );
  }
  return defects;
}

function ownerlessRepairLanguageDefects(card, tile) {
  if (!tile) return [];
  const text = `${tile.body || ''} ${tile.inner || ''}`;
  if (
    !/(?:\bSee the card\b|\bNo ExampleCo action\b|\bNothing for you to do\b|\bNothing\.|\bno action needed\b|\brequired unless\b)/i.test(
      text,
    )
  ) {
    return [];
  }
  return [
    `OWNERLESS-REPAIR-COPY: ${card.id} (${tile.name}) uses passive no-action/see-card language; blockers and non-green health rows must name the failed evidence and repair path`,
  ];
}

function actionItemsAgeDefects(card, tile) {
  if (!tile || card.id !== 'action_items') return [];
  const maxAge = 120;
  const ages = [...String(tile.body || '').matchAll(/\((\d{2,})d old\)/gi)]
    .map((m) => Number(m[1]))
    .filter(Number.isFinite)
    .filter((days) => days > maxAge);
  if (!ages.length) return [];
  return [
    `STALE-ACTION-ITEM: ${card.id} (${tile.name}) surfaces email ask age(s) older than ${maxAge} days: ${[
      ...new Set(ages),
    ]
      .slice(0, 6)
      .join(', ')}d`,
  ];
}

function actionItemsEvidenceDefects(card, tile) {
  if (!tile || card.id !== 'action_items') return [];
  const html = String(tile.inner || '');
  const blocks = html.match(/<article\b[^>]*\baction-detail\b[\s\S]*?<\/article>/gi) || [];
  const emptyEvidence = blocks.filter((block) => {
    const thread = (block.match(/\bdata-thread-id="([^"]*)"/i) || [])[1] || '';
    const summary = (block.match(/\bdata-summary="([^"]*)"/i) || [])[1] || '';
    const pTexts = [...block.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
      .map((p) => strip(p[1]))
      .filter(Boolean)
      .join(' ');
    return !thread.trim() && !summary.trim() && pTexts.length < 30;
  });
  const defects = [];
  if (emptyEvidence.length) {
    defects.push(
      `ACTION-ITEM-EVIDENCE: ${card.id} (${tile.name}) ${emptyEvidence.length} action item(s) have no thread id, summary, or concrete evidence detail`,
    );
  }
  if (/Hi\s+(?:Review|Reply),\s*Got it,\s*thanks\.\s*I will review and follow up\./i.test(html)) {
    defects.push(
      `ACTION-ITEM-GENERIC-DRAFT: ${card.id} (${tile.name}) renders a generic fake reply draft instead of a source-grounded action`,
    );
  }
  return defects;
}

function meetingsHorizonDefects(card, tile) {
  if (!tile || card.id !== 'meetings') return [];
  const metric = String(tile.metric || '').trim();
  const metricCount = /^\d+$/.test(metric) ? parseInt(metric, 10) : null;
  const text = `${tile.face || ''} ${tile.body || ''}`;
  if (
    metricCount &&
    /\bmeeting today\b/i.test(text) &&
    /\b0\s+meetings;\s+next\s+7\s+days\b/i.test(text)
  ) {
    return [
      `MEETINGS-TODAY-CONTRADICTION: ${card.id} (${tile.name}) says ${metricCount} meeting(s) today while the calendar proof says 0 meetings today`,
    ];
  }
  if (!/next\s+7\s+days/i.test(tile.name || tile.body || '')) return [];
  const body = String(tile.body || '');
  if (!/next\s+7\s+days/i.test(body)) {
    return [
      `MEETINGS-HORIZON: ${card.id} (${tile.name}) promises today + next 7 days but the rendered body only reports today`,
    ];
  }
  return [];
}

function amyProjectsDefects(card, tile) {
  if (!tile || card.id !== 'amy_projects') return [];
  const metric = String(tile.metric || '').trim();
  const text = `${tile.body || ''} ${tile.inner || ''}`;
  if (
    metric === '0' &&
    /No new Amy-assigned work in the last 24h/i.test(text) &&
    /\b(?:dispatch-active|active \/ incomplete)\b/i.test(text)
  ) {
    return [
      `AMY-PROJECTS-ZERO-ACTIVE: ${card.id} (${tile.name}) claims zero current projects while the drilldown contains active/incomplete Amy work`,
    ];
  }
  return [];
}

function otterCallHistoryContentDefects(card, tile) {
  if (!tile || card.id !== 'otter_speaker_pareto') return [];
  const text = `${tile.face || ''} ${tile.body || ''}`;
  const defects = [];
  if (/\b(?:ExampleCo_voice_(?:ecapa|track)_[a-z0-9]+|ExampleCo:[a-z0-9_]+)\b/i.test(text)) {
    defects.push(
      `OTTER-RAW-ID: ${card.id} (${tile.name}) renders durable ExampleCo speaker ids instead of PRIVATE_NAME speaker 1/2 style labels`,
    );
  }
  if (/existing relevance scan ties it to/i.test(text)) {
    defects.push(
      `OTTER-CALL-SUMMARY: ${card.id} (${tile.name}) renders boilerplate relevance-label prose instead of a source-grounded executive summary of the call`,
    );
  }
  if (
    /\bThis call focused on\b[\s\S]{0,220}\bsourced transcript segment/i.test(text) ||
    /\bno reliable decision or ExampleCo-owned next action was extracted\b/i.test(text)
  ) {
    defects.push(
      `OTTER-CALL-SUMMARY: ${card.id} (${tile.name}) renders generic fallback prose instead of what happened, decisions made, and ExampleCo next actions`,
    );
  }
  if (
    /\b(?:clearest source-backed read is|Touches [^.;]{0,120}; Contains|family wealth\s*\/\s*mission|relationship capital)\b/i.test(
      text,
    )
  ) {
    defects.push(
      `OTTER-CALL-SUMMARY: ${card.id} (${tile.name}) renders boilerplate relevance labels instead of what happened, decisions made, and ExampleCo next actions`,
    );
  }
  if (
    /\bDecisions\/actions:\s*(?:Yes|Yeah|Okay|Ok|Again|Always|A feedback|I think|Like|You know|For\b)/i.test(
      text,
    ) ||
    /\b[A-Z][A-Za-z0-9 '&/-]{4,80}:\s*(?:Yes|Yeah|Okay|Ok|Again|Always|A feedback|I think|Like|You know|For\b)/.test(
      text,
    )
  ) {
    defects.push(
      `OTTER-CALL-SUMMARY: ${card.id} (${tile.name}) renders transcript quotes instead of an executive summary of what happened, decisions, and ExampleCo next actions`,
    );
  }
  if (/\bcall covered again\b|\bI just want\b|\breally good start\b/i.test(text)) {
    defects.push(
      `OTTER-CALL-SUMMARY: ${card.id} (${tile.name}) still reads like transcript fragments instead of an executive summary`,
    );
  }
  if (/\b\d+\.\s+\d\w?\b/i.test(text)) {
    defects.push(
      `OTTER-CALL-SUMMARY: ${card.id} (${tile.name}) splits a numeric value while trimming the call summary`,
    );
  }
  if (
    /\b(?:Briefing summary|Detail:)\b/i.test(text) ||
    /\b(?:and|or|with|to|for|from|between|around|whether)\.\s*(?:-|Day Before|Lifetime stats|$)/i.test(
      text,
    )
  ) {
    defects.push(
      `OTTER-CALL-SUMMARY: ${card.id} (${tile.name}) renders labeled or clipped prose instead of complete executive-summary sentences`,
    );
  }
  if (
    /call-history-detail-table/i.test(tile.inner || '') &&
    !/Executive summary/i.test(tile.inner || '')
  ) {
    defects.push(
      `OTTER-CALL-HEADERS: ${card.id} (${tile.name}) call-history drilldown is missing column headers including Executive summary`,
    );
  }
  defects.push(...otterFutureTimestampDefects(card, tile));
  defects.push(...otterSpeakerMismatchDefects(card, tile));
  defects.push(...otterRollingWindowDefects(card, tile));
  return defects;
}

function otterFutureTimestampDefects(card, tile) {
  if (!tile || card.id !== 'otter_speaker_pareto') return [];
  const text = strip(`${tile.face || ''} ${tile.inner || ''}`);
  const updateMinutes = parseUpdatedMinutes(tile.inner || '');
  if (updateMinutes === null) return [];
  const todayMatch = text.match(
    /Past 24 Hours\s+(\d{4}-\d{2}-\d{2})([\s\S]*?)(?:Day Before\s+\d{4}-\d{2}-\d{2}|Lifetime stats|$)/i,
  );
  if (!todayMatch) return [];
  const times = [...todayMatch[2].matchAll(/\b(\d{1,2}):(\d{2})\s*([AP]M)\b/gi)]
    .map((m) => ({
      label: m[0],
      minutes: timeToMinutes(m[1], m[2], m[3]),
      hasExplicitPriorDate:
        /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s*$/i.test(
          todayMatch[2].slice(Math.max(0, m.index - 14), m.index),
        ),
    }))
    .filter((m) => m.minutes >= 0);
  const future = times.filter((m) => !m.hasExplicitPriorDate && m.minutes > updateMinutes + 5);
  if (!future.length) return [];
  return [
    `OTTER-FUTURE-TIME: ${card.id} (${tile.name}) shows past-call timestamp(s) after the card update time (${future
      .slice(0, 4)
      .map((m) => m.label)
      .join(
        ', ',
      )}); Otter call times must be Central Time and not future relative to the rendered card`,
  ];
}

function callHistoryRows(tile) {
  const html = String(tile.inner || '');
  const rows = [];
  const re = /<li\b[^>]*\bclass="[^"]*\bcall-history-row\b[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = re.exec(html))) {
    const block = m[1];
    const title = strip(
      (block.match(/class="call-title"[^>]*>([\s\S]*?)<\/span>/i) || [])[1] || '',
    );
    const speakers = strip(
      (block.match(/class="call-speakers"[^>]*>([\s\S]*?)<\/div>/i) || [])[1] || '',
    );
    const summary = strip(
      (block.match(/class="call-summary"[^>]*>([\s\S]*?)<\/div>/i) || [])[1] || '',
    );
    rows.push({ title, speakers, summary });
  }
  return rows;
}

function otterSpeakerMismatchDefects(card, tile) {
  if (!tile || card.id !== 'otter_speaker_pareto') return [];
  const rows = callHistoryRows(tile);
  if (!rows.length) return [];
  const ExampleCoMissing = rows.filter(
    (row) => /\bExampleCo\b/i.test(row.summary) && !/\bExampleCo\b/i.test(row.speakers),
  );
  const expectedPeople = [
    ['Ed', /\bEd(?:\s+Evans)?\b/i],
    ['PRIVATE_NAME', /\bPRIVATE_NAME(?:\s+Bluth)?\b/i],
    ['Zach', /\bZach(?:ary)?\b/i],
    ['PRIVATE_NAME', /\bPRIVATE_NAME\b/i],
    ['PRIVATE_NAME', /\bExampleCo\s+Walker\b/i],
  ];
  const knownMissing = [];
  for (const row of rows) {
    for (const [display, rx] of expectedPeople) {
      if (!rx.test(row.summary)) continue;
      if (rx.test(row.speakers)) continue;
      knownMissing.push(`${row.title || 'call'}:${display}`);
    }
  }
  const defects = [];
  if (ExampleCoMissing.length) {
    defects.push(
      `OTTER-SPEAKER-MISMATCH: ${card.id} (${tile.name}) ${ExampleCoMissing.length} call(s) mention ExampleCo in the executive summary but do not list ExampleCo as a detected speaker`,
    );
  }
  if (knownMissing.length) {
    defects.push(
      `OTTER-SPEAKER-MISMATCH: ${card.id} (${tile.name}) call summaries mention known people that are absent from the speaker roster: ${knownMissing.slice(0, 6).join(', ')}`,
    );
  }
  return [...new Set(defects)];
}

function otterRollingWindowDefects(card, tile) {
  if (!tile || card.id !== 'otter_speaker_pareto') return [];
  const text = strip(`${tile.body || ''} ${tile.inner || ''}`);
  if (!/Past 24 Hours/i.test(text) || !/No calls in this group/i.test(text)) return [];
  const updateMinutes = parseUpdatedMinutes(tile.inner || '') ?? 5 * 60 + 30;
  const dayBefore = previousIsoDateFromRunText(text);
  if (!dayBefore) return [];
  // Scan ONLY the "Day Before" bucket's own call rows for times. The old code did
  // text.slice(dayBeforeIdx) -- everything from the first "Day Before" header to
  // the END of the tile -- so the card's OWN chrome that renders AFTER the bucket
  // (the "Updated <mon> <d>, h:mm AM" freshness stamp, the "As of <date>" line,
  // "Lifetime stats", the voice-stat grid, and the drilldown's repeated headers)
  // leaked a non-call clock string into the scan. Live PEOPLE TAGGED defect
  // 2026-06-30: both buckets were empty ("No calls") yet "Updated Jun 30, 6:53 AM"
  // sat downstream of "Day Before" and was misread as a 6:53 AM Day-Before call
  // >= the 6:53 AM update time, flagging OTTER-TIME-WINDOW on a card that was
  // actually consistent. Bound the section at the next boundary so only real
  // Day-Before call timestamps are considered. Category: a non-call chrome time
  // appearing anywhere after the bucket must never be treated as a bucket entry.
  const dayBeforeRe = new RegExp(
    `Day Before\\s+${dayBefore.replace(/-/g, '\\-')}([\\s\\S]*?)(?:Lifetime stats|Past 24 Hours|Updated\\s+[A-Z]|As of\\s|Speaker enrichment|\\d[\\d,]*\\s+calls\\b|$)`,
    'i',
  );
  const dayBeforeMatch = text.match(dayBeforeRe);
  if (!dayBeforeMatch) return [];
  const dayBeforeText = dayBeforeMatch[1] || '';
  // An empty bucket ("No calls in this group") has no real call times; a chrome
  // time that slips through the boundary is not a call entry, so an empty bucket
  // can never be a mis-bucket.
  if (/No calls in this group/i.test(dayBeforeText)) return [];
  const times = [...dayBeforeText.matchAll(/\b(\d{1,2}):(\d{2})\s*([AP]M)\b/gi)].map((m) =>
    timeToMinutes(m[1], m[2], m[3]),
  );
  if (times.some((minutes) => minutes >= updateMinutes)) {
    return [
      `OTTER-TIME-WINDOW: ${card.id} (${tile.name}) puts prior-day calls after the briefing update time under "Day Before" while "Past 24 Hours" says no calls`,
    ];
  }
  return [];
}

function parseUpdatedMinutes(html) {
  const m = String(html || '').match(
    /Updated\s+[A-Z][a-z]{2}\s+\d{1,2},\s+(\d{1,2}):(\d{2})\s*([AP]M)/i,
  );
  if (!m) return null;
  return timeToMinutes(m[1], m[2], m[3]);
}

function timeToMinutes(h, min, ampm) {
  let hour = Number(h);
  const minute = Number(min);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return -1;
  const upper = String(ampm || '').toUpperCase();
  if (upper === 'PM' && hour !== 12) hour += 12;
  if (upper === 'AM' && hour === 12) hour = 0;
  return hour * 60 + minute;
}

function previousIsoDateFromRunText(text) {
  const m = String(text || '').match(/Day Before\s+(\d{4}-\d{2}-\d{2})/i);
  return m ? m[1] : null;
}

function videoManifestDriftDefects(card, tile) {
  if (!tile || card.id !== 'video_approval_queue') return [];
  if (!/Manifest drift/i.test(tile.body || tile.face || '')) return [];
  return [
    `VIDEO-MANIFEST-DRIFT: ${card.id} (${tile.name}) reports pending video files are missing from the approval manifest`,
  ];
}

function systemHealthProofContractDefects(card, tile) {
  const inner = String((tile && tile.inner) || '');
  const articles = [
    ...inner.matchAll(
      /<article class="[^"]*\bdetail-item\b[^"]*"[^>]*data-item="([^"]*)"[^>]*>([\s\S]*?)<\/article>/gi,
    ),
  ];
  if (!articles.length) {
    return [
      `SYSTEM-HEALTH-PROOF: ${card.id} (${tile.name}) drilldown has no itemized health-check articles; each metric needs definition, status, timestamp, source, and proof rows`,
    ];
  }
  const defects = [];
  for (const m of articles) {
    const name = strip(m[1] || '').trim() || 'unnamed metric';
    const html = m[2] || '';
    const text = strip(html);
    const missing = [];
    if (!/\bMetric\b/i.test(text)) missing.push('metric');
    if (!/\bDefinition\b/i.test(text)) missing.push('definition');
    if (!/\bStatus\b/i.test(text)) missing.push('status');
    if (!/\bTimestamp\b/i.test(text)) missing.push('timestamp');
    if (!/\bSource\b/i.test(text)) missing.push('source');
    const proofTexts = [
      ...html.matchAll(/<li class="[^"]*\bhealth-proof-item\b[^"]*"[^>]*>([\s\S]*?)<\/li>/gi),
    ].map((li) => strip(li[1] || ''));
    const proofItemCount = proofTexts.length;
    if (!/\bProof\s+\d+\b/i.test(text) || proofItemCount < 1) missing.push('itemized proof');
    if (/No itemized proof was available|Proof missing/i.test(text)) missing.push('real proof');
    const weakProof = proofTexts.find((proof) => {
      const core = proof
        .replace(/\bProof\s+\d+\b/gi, ' ')
        .replace(/\b(summary row|probe data|probe note|raw proof)\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      return /^(ok|green|healthy|current|all good|all clear|passing|passed)$/i.test(core);
    });
    if (weakProof) missing.push('concrete proof');
    if (missing.length) {
      defects.push(
        `SYSTEM-HEALTH-PROOF: ${card.id} (${tile.name}) metric "${name}" drilldown is missing ${[...new Set(missing)].join(', ')}`,
      );
    }
  }
  return defects;
}

function systemHealthDetailDefects(card, tile) {
  if (!tile || card.id !== 'system_health') return [];
  const text = `${tile.body || ''} ${tile.inner || ''}`;
  const defects = [];
  defects.push(...systemHealthProofContractDefects(card, tile));
  const otterRequired = [
    ['transcript', /\btranscripts?\b/i],
    ['full audio', /\bfull audio\b|\baudio downloaded\b|\bdownloaded audio\b/i],
    ['enriched transcript', /\benriched transcripts?\b|\benrichment\b/i],
    ['probe clips', /\bprobe clips?\b|\bspeaker tracks probed\b|\brepresentative .*clips?\b/i],
    ['call summaries', /\bcall summaries?\b|\bsummary happened\b|\bexec summaries?\b/i],
    ['identity', /\bidentity\b|\bvoiceprints?\b|\bspeaker rosters?\b/i],
    ['lock freshness', /\block\b|\bstale lock\b|\bfreshness window\b/i],
  ];
  const missing = otterRequired.filter(([, rx]) => !rx.test(text)).map(([label]) => label);
  if (/Otter speaker enrichment/i.test(text) && missing.length) {
    defects.push(
      `OTTER-HEALTH-SUBMETRICS: ${card.id} (${tile.name}) Otter health is missing required submetric proof: ${missing.join(', ')}`,
    );
  }
  if (/Graphiti/i.test(text)) {
    if (
      /Direct Graphiti proof JSON\s+Field\s+Value/i.test(text) ||
      !/\bDescription\b/i.test(text) ||
      !/\bMetric\b/i.test(text)
    ) {
      defects.push(
        `GRAPHITI-HEALTH-TEST-LIST: ${card.id} (${tile.name}) Graphiti health renders field/value JSON instead of named tests with descriptions and metric confirmations`,
      );
    }
  }
  return defects;
}

function tokenUsageFreshnessDefects(card, tile, runDate) {
  if (!tile || card.id !== 'token_usage') return [];
  const text = `${tile.face || ''} ${tile.body || ''}`;
  const defects = [];
  const resetDates = [...text.matchAll(/\bresets?\s+(\d{4}-\d{2}-\d{2})/gi)].map((m) => m[1]);
  const refDate = String(runDate || new Date().toISOString().slice(0, 10));
  const staleClaudeReset = resetDates.find((iso) => iso < refDate);
  if (staleClaudeReset && /Claude/i.test(text)) {
    defects.push(
      `TOKEN-USAGE-STALE-RESET: ${card.id} (${tile.name}) presents Claude usage as current while its reset date is already past (${staleClaudeReset})`,
    );
  }
  if (
    /\bClaude\b[\s\S]{0,120}\b(?:\d{1,2})%/i.test(text) &&
    !/\b(?:stale|unreachable|not current|max(?:ed)?|usage limit|100%)\b/i.test(text)
  ) {
    defects.push(
      `TOKEN-USAGE-HONESTY: ${card.id} (${tile.name}) shows a sub-100 Claude percent without stale/unreachable/maxed-state disclosure`,
    );
  }
  return defects;
}

function kingdomCurriculumDefects(card, tile) {
  if (!tile || card.id !== 'kingdom_equipping') return [];
  const text = `${tile.face || ''} ${tile.body || ''} ${tile.inner || ''}`;
  const defects = [];
  if (/\bPeople move when they feel specifically seen\b/i.test(text)) {
    defects.push(
      `KINGDOM-REPEAT: ${card.id} (${tile.name}) repeats a previously rejected idea phrase instead of advancing a durable curriculum`,
    );
  }
  if (/\bpublic research refresh target\b|\bno matching fresh public item returned\b/i.test(text)) {
    defects.push(
      `KINGDOM-RESEARCH: ${card.id} (${tile.name}) renders research-target boilerplate instead of an actual current researched signal`,
    );
  }
  const urls = [
    ...new Set(
      [...text.matchAll(/https?:\/\/[^\s)]+/gi)].map((m) => String(m[0]).replace(/[.,;]+$/g, '')),
    ),
  ];
  if (urls.length > 0 && urls.length < 3) {
    defects.push(
      `KINGDOM-RESEARCH: ${card.id} (${tile.name}) reuses research sources across ideas (${urls.length} distinct URL(s)); each idea needs its own current signal`,
    );
  }
  const mismatches = [
    {
      idea: /\b(?:house|home|hospitality|estate|kitchen|garden)\b/i,
      sourceBad: /\b(?:ai agents?|agentic|artificial intelligence|machine learning|llm|model)\b/i,
      sourceGood: /\b(?:house|home|hospitality|estate|kitchen|garden|architecture|design)\b/i,
      label: 'household/hospitality idea paired with AI source',
    },
    {
      idea: /\b(?:sabbath|rest|mission from becoming an idol)\b/i,
      sourceBad: /\b(?:medication|drug|agentic|artificial intelligence|ai)\b/i,
      sourceGood: /\b(?:sabbath|rest|sleep|burnout|rhythm|fatigue|recovery|spiritual)\b/i,
      label: 'Sabbath/rest idea paired with unrelated source',
    },
  ];
  const sourceRows = String(text)
    .split(/\b\d+\.\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  for (const row of sourceRows) {
    const source = (row.match(/\bSource:\s*([^]+?)(?=\s+\d+\.|$)/i) || [])[1] || row;
    for (const rule of mismatches) {
      if (rule.idea.test(row) && rule.sourceBad.test(source) && !rule.sourceGood.test(source)) {
        defects.push(`KINGDOM-SOURCE-MISMATCH: ${card.id} (${tile.name}) ${rule.label}`);
      }
    }
  }
  return [...new Set(defects)];
}

function contentPipelineDefects(card, tile) {
  if (!tile || card.id !== 'content_pipeline') return [];
  const text = `${tile.face || ''} ${tile.body || ''}`;
  if (/\?\s*published/i.test(text)) {
    return [
      `CONTENT-PIPELINE-ExampleCo: ${card.id} (${tile.name}) renders ExampleCo published count; pipeline counts must be real numbers or explicitly blocked`,
    ];
  }
  return [];
}

function voiceConfirmationDefects(card, tile) {
  if (!tile || card.id !== 'voice_confirmation') return [];
  const text = `${tile.face || ''} ${tile.body || ''} ${tile.inner || ''}`;
  const defects = [];
  if (/\bPast-7-day Otter archive health:\s*RED\b/i.test(text)) {
    defects.push(
      `VOICE-HEALTH-HIDDEN-RED: ${card.id} (${tile.name}) renders green while the detail says past-7-day Otter archive health is RED`,
    );
  }
  if (/\b0\s+proposed names\b/i.test(text) && /\bpeople-file suggestion:/i.test(text)) {
    defects.push(
      `VOICE-PROPOSED-NAMES: ${card.id} (${tile.name}) says 0 proposed names while unresolved voice rows contain people-file suggestions`,
    );
  }
  if (
    /\bKnown speakers by voiceprint\b[\s\S]{0,3000}\b(?:reference clips|\(\d+\s+refs?\b)/i.test(
      text,
    )
  ) {
    defects.push(
      `VOICE-KNOWN-SPEAKERS-CALLS: ${card.id} (${tile.name}) known voices are organized by reference clips; they must show and sort by number of calls with each person`,
    );
  }
  if (
    /\b0\s+known-speaker matches internal\b/i.test(text) &&
    /\bKnown speakers by voiceprint\b/i.test(text)
  ) {
    defects.push(
      `VOICE-KNOWN-MATCHES: ${card.id} (${tile.name}) reports 0 known-speaker matches while known voices are banked, so identity matching is not proving itself`,
    );
  }
  return defects;
}

function cardSpecificDefects(card, tile, runDate) {
  return [
    ...systemHealthDetailDefects(card, tile),
    ...tokenUsageFreshnessDefects(card, tile, runDate),
    ...peopleFilesFreshnessDefects(card, tile, runDate),
    ...peopleFilesDetailDefects(card, tile),
    ...otterSpeakerParetoAudioDefects(card, tile),
    ...awsCostsDetailDefects(card, tile),
    ...kingdomResearchDefects(card, tile),
    ...kingdomCurriculumDefects(card, tile),
    ...communicationCoachingDefects(card, tile),
    ...ownerlessRepairLanguageDefects(card, tile),
    ...actionItemsAgeDefects(card, tile),
    ...actionItemsEvidenceDefects(card, tile),
    ...meetingsHorizonDefects(card, tile),
    ...amyProjectsDefects(card, tile),
    ...otterCallHistoryContentDefects(card, tile),
    ...videoManifestDriftDefects(card, tile),
    ...contentPipelineDefects(card, tile),
    ...voiceConfirmationDefects(card, tile),
  ];
}

const DASHBOARD_PRIORITY_ORDER = [
  'blockers',
  'system_health',
  'action_items',
  'token_usage',
  'meetings',
  'kingdom_equipping',
  'communication_coaching',
  'otter_speaker_pareto',
  'people_files_changes',
];

function cardIdForTile(tile) {
  const card = manifest.CARDS.find((c) => c.match.test(tile.name));
  return card ? card.id : '';
}

function dashboardCardOrderDefects(tiles) {
  const indexes = new Map();
  tiles.forEach((tile, idx) => {
    const id = cardIdForTile(tile);
    if (id && !indexes.has(id)) indexes.set(id, idx);
  });
  const defects = [];
  let lastIdx = -1;
  let lastId = '';
  for (const id of DASHBOARD_PRIORITY_ORDER) {
    if (!indexes.has(id)) continue;
    const idx = indexes.get(id);
    if (idx < lastIdx) {
      defects.push(
        `CARD-ORDER: ${id} renders before ${lastId}; briefing priority order must start Blockers, System Health, Action Items, Token Usage, Meetings, Kingdom, Communication, Otter, People Files`,
      );
      break;
    }
    lastIdx = idx;
    lastId = id;
  }
  const firstNewsIdx = tiles.findIndex((tile) => NEWS_IDS.has(cardIdForTile(tile)));
  if (firstNewsIdx >= 0) {
    const lateNonNews = tiles
      .slice(firstNewsIdx + 1)
      .map(cardIdForTile)
      .filter((id) => id && !NEWS_IDS.has(id));
    if (lateNonNews.length) {
      defects.push(
        `NEWS-LAST: ${lateNonNews[0]} renders after a news card; news cards must be the final briefing section`,
      );
    }
  }
  return defects;
}

function milestoneOrderDefects(html) {
  const defects = [];
  const articles =
    String(html || '').match(
      /<article\b(?=[^>]*\bclass="[^"]*\bmilestone-card\b)[^>]*>[\s\S]*?<\/article>/gi,
    ) || [];
  if (articles.length) {
    const northIdx = articles.findIndex((article) => /\bNorth Star\b/i.test(strip(article)));
    if (northIdx !== 0) {
      defects.push(
        northIdx < 0
          ? 'MILESTONE-NORTH-STAR: life milestones render without North Star as the first milestone'
          : `MILESTONE-NORTH-STAR: North Star milestone renders at position ${northIdx + 1}; it must be first`,
      );
    }
  }
  const tags = articles.map((article) => article.match(/<article\b[^>]*>/i)?.[0] || '');
  const dates = [];
  let sawUndated = false;
  for (let idx = 0; idx < tags.length; idx += 1) {
    const tag = tags[idx];
    const isNorthStar = idx === 0 && /\bNorth Star\b/i.test(strip(articles[idx] || ''));
    const m = tag.match(/\bdata-target-date="([^"]*)"/i);
    const date = m ? String(m[1] || '').trim() : '';
    if (!date) {
      dates.push('');
      if (!isNorthStar) sawUndated = true;
      continue;
    }
    dates.push(date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      defects.push(`MILESTONE-ORDER: life milestone target date is not ISO formatted: ${date}`);
      continue;
    }
    if (sawUndated) {
      defects.push(
        `MILESTONE-ORDER: dated life milestone ${date} rendered after an undated milestone; undated milestones must be last`,
      );
    }
  }
  const dated = dates.filter(Boolean);
  for (let i = 1; i < dated.length; i += 1) {
    if (dated[i] < dated[i - 1]) {
      defects.push(
        `MILESTONE-ORDER: life milestones render out of chronological order (${dated.join(' -> ')}); target dates must ascend`,
      );
      break;
    }
  }
  return defects;
}

// A card body ExampleCos a HARD-BLOCKER marker when it spells out an explicit
// blocker verdict in its prose, independent of the tile's red/green status. The
// render paints the LinkedIn card red and emits "hard blocker: ..." (cloud
// builder ~3623), but a card can also narrate "BLOCKER: speaker roster is
// empty ..." in its body while the tile color is not red -- the OTTER SPEAKER
// PARETO case ExampleCo caught on 2026-06-22. Either form means the card is blocked
// and MUST be listed on the top Blockers card. Matched case-insensitively on the
// word boundary so it does not fire on substrings like "unblocker".
const HARD_BLOCKER_MARKER = /(?:\bhard[\s-]?blocker\b|\bblocker\s*:)/i;

// The Blockers card renders "Clear: no owner decision is needed for this
// briefing." when it has zero blockers (cloud builder renderBlockersSection
// ~887), and otherwise lists each blocker as "N. <title>" / "Evidence: ...".
// The card reads "empty" for under-report purposes when its body is that Clear
// sentinel or ExampleCos no blocker rows at all (a 0 metric with no listed item).
const BLOCKERS_CLEAR =
  /\bno owner decision is needed\b|\bno hard blockers\b|\bclear\b.{0,80}\b(?:no owner decision|no hard blockers)\b/i;

// Distinctive tokens of a card NAME, used to decide whether a blocked card is
// actually NAMED in the Blockers card body (so its presence there is NOT a
// defect). We drop the "(N)"/"($X)" suffix and the subtitle after the first
// dash/pipe, uppercase, take alphanumeric words >= 4 chars, and remove generic
// fillers that several cards share (NEWS, DATA, ...). A blocked card counts as
// "named" when the Blockers body contains at least one of its distinctive
// tokens -- e.g. "OTTER" / "SPEAKER" / "PARETO" for the otter card. Deriving the
// tokens from the card NAME (not a hardcoded list) keeps this keyed to the
// category, not one incident. Multi-token names need at least two hits; one-word
// generic names like "Action" and "Mortgage" are too broad unless the row names
// the normalized card id.
const NAME_FILLER = new Set([
  'NEWS',
  'DATA',
  'GROUP',
  'WORK',
  'WATCH',
  'SCAN',
  'IDEAS',
  'ITEMS',
  'QUEUE',
  'CHANGES',
  'ACTIVITY',
  'PROPOSALS',
  'INDEXES',
  'OPEN',
  'LAST',
  'TODAY',
  'PEOPLE',
]);

const GENERIC_SINGLE_BLOCKER_TOKENS = new Set([
  'ACTION',
  'CONTENT',
  'MORTGAGE',
  'NEWS',
  'PEOPLE',
  'VOICE',
]);

function tokensFromText(text) {
  return (
    String(text || '')
      .toUpperCase()
      .match(/[A-Z0-9]{4,}/g) || []
  ).filter((t) => !NAME_FILLER.has(t));
}

function cardNameTokenParts(name) {
  const withoutSuffix = String(name || '').replace(/\((?:[^)]*)\)\s*$/g, ' ');
  const [leadAndMaybeSlash, ...tailParts] = withoutSuffix.split(/[-|]/);
  const slashParts = String(leadAndMaybeSlash || '').split('/');
  const lead = tokensFromText(slashParts.shift() || '');
  const subtitle = [...slashParts.flatMap(tokensFromText), ...tailParts.flatMap(tokensFromText)];
  return { lead, subtitle };
}

function normalizedPhrase(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\((?:[^)]*)\)\s*$/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cardNamePhrases(name, part) {
  const withoutSuffix = String(name || '').replace(/\((?:[^)]*)\)\s*$/g, ' ');
  const [leadAndMaybeSlash, ...tailParts] = withoutSuffix.split(/[-|]/);
  const slashParts = String(leadAndMaybeSlash || '').split('/');
  if (part === 'lead') return [slashParts.shift() || ''].map(normalizedPhrase).filter(Boolean);
  slashParts.shift();
  return [...slashParts, ...tailParts].map(normalizedPhrase).filter(Boolean);
}

function phraseNamedInBlockers(phrase, blockersBody) {
  const normalized = normalizedPhrase(blockersBody);
  if (!phrase || phrase.split(/\s+/).length < 2) return false;
  return new RegExp(`(?:^|\\s)${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`).test(
    normalized,
  );
}

function nameTokens(name) {
  const tokens = [...cardNameTokenParts(name).lead];
  // Fall back to the longest single token if filtering left us nothing (so a
  // card whose every word is a filler still gets a name check, never auto-pass).
  if (!tokens.length) {
    const all =
      String(name || '')
        .toUpperCase()
        .match(/[A-Z0-9]{4,}/g) || [];
    if (all.length) tokens.push(all.sort((a, b) => b.length - a.length)[0]);
  }
  return tokens;
}

function normalizedCardIdMentioned(cardId, blockersBody) {
  const id = String(cardId || '').toLowerCase();
  if (!id) return false;
  const body = String(blockersBody || '').toLowerCase();
  const compact = body.replace(/[^a-z0-9]+/g, '_');
  return new RegExp(`(?:^|_)${id}(?:_|$)`).test(compact);
}

function tokenListNamedInBlockers(tokens, blockersBody) {
  const body = String(blockersBody || '');
  const hits = tokens.filter((t) => new RegExp(`\\b${t}\\b`, 'i').test(body));
  if (tokens.length >= 2) return hits.length >= 2;
  if (!hits.length) return false;
  return !GENERIC_SINGLE_BLOCKER_TOKENS.has(hits[0]);
}

function isNamedInBlockersPart(tile, blockersBody, part, cardId = '') {
  if (normalizedCardIdMentioned(cardId, blockersBody)) return true;
  if (
    cardNamePhrases(tile.name, part).some((phrase) => phraseNamedInBlockers(phrase, blockersBody))
  ) {
    return true;
  }
  const tokens =
    part === 'subtitle' ? cardNameTokenParts(tile.name).subtitle : nameTokens(tile.name);
  return tokenListNamedInBlockers(tokens, blockersBody);
}

function isNamedInBlockers(tile, blockersBody, cardId = '') {
  return (
    isNamedInBlockersPart(tile, blockersBody, 'lead', cardId) ||
    isNamedInBlockersPart(tile, blockersBody, 'subtitle', cardId)
  );
}

function blockerRows(blockersBody) {
  const body = String(blockersBody || '')
    .replace(/\s+/g, ' ')
    .trim();
  const rows = [];
  const re = /(?:^|\s)(\d+)\.\s+([\s\S]*?)(?=\s+\d+\.\s+|$)/g;
  let m;
  while ((m = re.exec(body))) {
    rows.push({ n: parseInt(m[1], 10), text: m[2].trim() });
  }
  return rows;
}

// A blocker row reads "<SUBJECT> <detail marker>: <evidence/remediation prose>".
// A card is "named as an unresolved blocker" only when it is the SUBJECT of a
// row (its name leads the row, before the first detail marker), never when its
// name appears incidentally inside another row's evidence or remediation prose
// (e.g. a failing-test name that says "video approval queue" or a remediation
// step that says "refresh ... and System Health"). Strip everything from the
// first detail marker onward so the match only sees the row subject.
//
// Fail-safe direction: only slice when the marker is NOT the first token (cut >
// 0). If a row LEADS with a detail marker (cut === 0, no subject before it) the
// lead would be empty and a card named in the body would be silently missed -- a
// false-negative that lets a broken briefing publish. For a publish gate that is
// the dangerous direction, so a subjectless row falls back to the whole row text
// (over-flag, never under-flag). cut === -1 (no marker) already returns the whole
// row.
const BLOCKER_ROW_DETAIL_MARKER =
  /\b(?:What.?s failing|What you need to do|Tried|Need(?: from [A-Za-z]+)?|Failure|Evidence)\s*:/i;
function blockerRowLead(rowText) {
  const text = String(rowText || '');
  const cut = text.search(BLOCKER_ROW_DETAIL_MARKER);
  return (cut > 0 ? text.slice(0, cut) : text).trim();
}

function blockersNamedCardDefects(tiles, defectsByCard) {
  const blockersTile = tiles.find((t) => /^BLOCKERS\b/i.test(t.name));
  if (!blockersTile) return [];
  const rows = blockerRows(blockersTile.body || '');
  if (!rows.length) return [];
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const rowSubject = blockerRowLead(row.text);
    for (const part of ['lead', 'subtitle']) {
      let matched = false;
      for (const card of manifest.CARDS) {
        if (card.id === 'blockers') continue;
        const tile = findTile(tiles, card);
        if (!tile) continue;
        const existing = defectsByCard.get(card.id) || [];
        if (existing.length) continue;
        if (!isNamedInBlockersPart(tile, rowSubject, part, card.id)) continue;
        if (seen.has(card.id)) continue;
        seen.add(card.id);
        out.push({
          id: card.id,
          defect: `BLOCKERS-NAMED-CARD: ${card.id} (${tile.name}) is named on the Blockers card as unresolved; render QC must count it as a defective card before applying the blockers floor check`,
        });
        matched = true;
        break;
      }
      if (matched) break;
    }
  }
  return out;
}

// BLOCKERS UNDER-REPORT (complementary direction to BLOCKERS-FLOOR). A card is
// blocked when its tile renders RED or its body ExampleCos a hard-blocker marker
// ("BLOCKER:" / "hard blocker"). If ANY non-blockers card is blocked but the top
// Blockers card renders empty/"Clear: no owner decision" with no entry NAMING
// that card, the Blockers card under-reports -- the exact contradiction ExampleCo
// caught 2026-06-22 (OTTER SPEAKER PARETO body says "BLOCKER: speaker roster is
// empty" while the Blockers card says "Clear"). BLOCKERS-FLOOR catches the COUNT
// being too low; this catches a SPECIFIC blocked card missing by name, even when
// the Blockers count happens to equal the defective-card count for unrelated
// reasons. The LinkedIn red tile is NOT a false positive: if it is listed by name
// in the Blockers body it does not flag here.
function blockersUnderReportDefects(tiles) {
  const blockersTile = tiles.find((t) => /^BLOCKERS\b/i.test(t.name));
  if (!blockersTile) return [];

  const body = String(blockersTile.body || '');
  // The Blockers card "names" blockers when it lists rows; treat it as empty for
  // under-report purposes when it shows the Clear sentinel OR a 0 metric.
  const metricCount = /^-?\d+$/.test(String(blockersTile.metric || '').trim())
    ? parseInt(blockersTile.metric, 10)
    : null;
  const blockersLooksEmpty = metricCount === 0 || BLOCKERS_CLEAR.test(body);

  const defects = [];
  for (const t of tiles) {
    if (t === blockersTile || /^BLOCKERS\b/i.test(t.name)) continue;
    const isBlocked = t.status === 'red' || HARD_BLOCKER_MARKER.test(t.body || '');
    if (!isBlocked) continue;
    // Blocked card is fine as long as the Blockers card actually names it.
    const card = cardIdForTile(t);
    if (!blockersLooksEmpty && isNamedInBlockers(t, body, card)) continue;
    const reason = blockersLooksEmpty
      ? 'the Blockers card renders empty/"Clear: no owner decision"'
      : 'the Blockers card does not name it';
    defects.push(
      `BLOCKERS-UNDER-REPORT: "${t.name}" is blocked (${t.status === 'red' ? 'red tile' : 'body ExampleCos a hard-blocker marker'}) but ${reason}; every blocked card must appear by name on the top Blockers card`,
    );
  }
  return defects;
}

/**
 * Core verifier. Pure: takes HTML, returns a structured result. Exported so the
 * regression test and the wire-in can call it without a network fetch.
 */
function verifyDashboard(html, runDate, options = {}) {
  const builderCounts = (options && options.builderCounts) || {};
  const tiles = parseTiles(html);
  if (tiles.length === 0) {
    // A 0-tile parse is ambiguous at THIS layer: it is a genuine retry condition
    // only when the body was trivial/empty. When the fetch returned a real page
    // body but the parser still extracted nothing, the markup changed and the
    // parser is broken -- that is a HARD defect, not a forever-retry. The
    // distinction is made in main() (it knows whether the HTTP fetch succeeded
    // with a non-trivial body); here we expose the raw fact and let the caller
    // classify. `bodyLooksReal` lets main() decide without re-fetching.
    return {
      status: 'parse-failed',
      tiles,
      defects: [],
      present: [],
      advisories: [],
      bodyLooksReal: htmlBodyLooksReal(html),
      isSignInPage: isBriefingSignInPage(html),
    };
  }

  const defects = [];
  const present = [];
  const advisories = [];
  defects.push(...milestoneOrderDefects(html));
  defects.push(...dashboardCardOrderDefects(tiles));
  // Per-card defect buckets so the publish-then-label wire-in can stamp each card
  // clean/defect on its tile and name the defective ones on the Blockers card.
  // Every manifest card gets an entry; a card with zero defects is clean.
  const defectsByCard = new Map();
  manifest.CARDS.forEach((c) => defectsByCard.set(c.id, []));
  // The real rendered tile title per card id, so the durable QC artifact
  // (scripts/lib/live-board-truth.js) can show ExampleCo the actual tile name
  // instead of the bare manifest id. Populated whenever a tile is matched;
  // a card that never rendered (MISSING) has no entry and the artifact
  // builder falls back to the id.
  const cardTitleById = new Map();
  const recordCard = (id, list) => {
    if (!list || !list.length) return;
    const bucket = defectsByCard.get(id) || [];
    bucket.push(...list);
    defectsByCard.set(id, bucket);
    defects.push(...list);
  };

  for (const card of manifest.CARDS) {
    const matches = findTiles(tiles, card);
    const tile = matches[0] || null;
    if (tile && tile.name) cardTitleById.set(card.id, tile.name);
    if (matches.length > 1) {
      const duplicateDefects = [
        `CARD-DUPLICATE: ${card.id} (${cardLabel(card)}) rendered ${matches.length} matching tiles; duplicate cards make the status ambiguous and must be collapsed before the briefing can be clean`,
      ];
      for (const dup of matches.slice(1)) {
        duplicateDefects.push(...statusDefects(card, dup));
      }
      recordCard(card.id, duplicateDefects);
    }

    if (card.always) {
      if (!tile) {
        recordCard(card.id, [
          `MISSING: required card not rendered -> ${card.id} (${cardLabel(card)})`,
        ]);
        continue;
      }
      present.push(card.id);
      if (tile.bodyLen < EMPTY_BODY_FLOOR) {
        recordCard(card.id, [
          `EMPTY: ${card.id} (${tile.name}) rendered an empty shell (bodyLen=${tile.bodyLen})`,
        ]);
      }
      recordCard(card.id, statusDefects(card, tile));
      recordCard(card.id, valueSanityDefects(card, tile, builderCounts));
      recordCard(card.id, execCrispnessDefects(card, tile, runDate));
      recordCard(card.id, cardSpecificDefects(card, tile, runDate));
      advisories.push(...advisoryNotes(card, tile));
      continue;
    }

    // Conditional card: satisfied by its own tile OR a merge target.
    if (tile) {
      present.push(card.id);
      if (tile.bodyLen >= EMPTY_BODY_FLOOR) {
        recordCard(card.id, statusDefects(card, tile));
        recordCard(card.id, valueSanityDefects(card, tile, builderCounts));
        recordCard(card.id, execCrispnessDefects(card, tile, runDate));
        recordCard(card.id, cardSpecificDefects(card, tile, runDate));
        advisories.push(...advisoryNotes(card, tile));
      }
      continue;
    }

    // No own tile -> require an acceptable merge target.
    const mergeTargets = (card.mergedInto || [])
      .map((id) => manifest.getCardById(id))
      .filter(Boolean);
    let satisfied = false;
    let evidenceFailure = '';
    for (const target of mergeTargets) {
      const tTile = findTile(tiles, target);
      if (!tTile) continue;
      // If the conditional card declares merge evidence (e.g. FULL-LIFE must
      // show "Life:" chips inside SYSTEM HEALTH), require that evidence in the
      // target body. A present-but-evidence-free target is NOT satisfaction --
      // that is the silent-drop hole.
      if (card.requiresMergeEvidence) {
        if (card.requiresMergeEvidence.test(tTile.body)) {
          satisfied = true;
          break;
        }
        evidenceFailure = `merge target ${target.id} (${tTile.name}) is present but shows no merge evidence (expected ${card.requiresMergeEvidence})`;
        continue;
      }
      satisfied = true;
      break;
    }

    if (!satisfied) {
      const detail = evidenceFailure
        ? evidenceFailure
        : `neither its own tile nor a merge target [${(card.mergedInto || []).join(', ')}] rendered`;
      recordCard(card.id, [
        `MISSING: conditional card not represented -> ${card.id} (${cardLabel(card)}): ${detail}`,
      ]);
    }
  }

  for (const named of blockersNamedCardDefects(tiles, defectsByCard)) {
    recordCard(named.id, [named.defect]);
  }

  // BLOCKERS-CARD FLOOR: the briefing renders its own "N hard blockers" count on
  // the Blockers card. The QC must never read fully clean while Blockers itself
  // says the briefing is blocked. Do not compare the blocker count one-to-one
  // against defective rendered cards: one red SYSTEM HEALTH card can legitimately
  // contain several subsystem blockers.
  const blockersTile = tiles.find((t) => /\bblockers\b/i.test(t.name));
  const reportedBlockers = blockersTile
    ? parseInt((String(blockersTile.metric).match(/\d+/) || ['0'])[0], 10)
    : 0;
  // distinctDefectiveCards is the canonical denominator for BOTH accounting
  // checks: one defective card counts once, whether it ExampleCos one defect string
  // or several (a red SYSTEM HEALTH with multiple subsystem strings is ONE card),
  // and a card NAMED on the Blockers card as unresolved is already recorded into
  // defectsByCard above (blockersNamedCardDefects), so it counts here as exactly
  // one defective card. Using this single basis keeps BLOCKERS-FLOOR and
  // BLOCKERS-COUNT reconciled instead of comparing the reported count against the
  // raw defect-string total (which double-counted multi-defect cards and produced
  // the "5 reported but 7 found" drift, live 2026-06-29 blockers-accounting defect).
  const distinctDefectiveCards = [...defectsByCard.values()].filter((b) => b.length).length;
  if (reportedBlockers > 0 && distinctDefectiveCards === 0) {
    defects.push(
      `BLOCKERS-FLOOR: the briefing's Blockers card reports ${reportedBlockers} hard blocker(s) but the QC found no defective cards; the QC must not call the dashboard clean while Blockers says it is blocked`,
    );
  }
  // STRICT, never papered over: every distinct defective card (including each card
  // named on the Blockers card as unresolved) must be reflected in the reported
  // hard-blocker count. When the reported count is lower than the distinct
  // defective-card count, the Blockers card under-reports and this fires.
  if (blockersTile && distinctDefectiveCards > 0 && reportedBlockers < distinctDefectiveCards) {
    defects.push(
      `BLOCKERS-COUNT: the Blockers card reports ${reportedBlockers} hard blocker(s), but live render QC found ${distinctDefectiveCards} defective card(s); every defective card (including each card named on the Blockers card as unresolved) must count as a blocker`,
    );
  }

  // BLOCKERS UNDER-REPORT: complementary to BLOCKERS-FLOOR. A specific card that
  // is blocked (red tile or "BLOCKER:"/"hard blocker" in its body) but is not
  // NAMED on the top Blockers card -- the contradiction ExampleCo caught 2026-06-22
  // (OTTER SPEAKER PARETO body says "BLOCKER:" while the Blockers card says
  // "Clear"). Not bucketed per-card: it is a cross-card consistency defect.
  defects.push(...blockersUnderReportDefects(tiles));

  // One status per manifest card: 'clean' when it has zero defects, else 'defect'.
  // `title` ExampleCos the real rendered tile name (when the card rendered a
  // tile at all) so downstream consumers (scripts/lib/live-board-truth.js)
  // can show ExampleCo the actual tile name, not the bare manifest id.
  const cardStatuses = manifest.CARDS.map((c) => {
    const cardDefects = defectsByCard.get(c.id) || [];
    return {
      id: c.id,
      title: cardTitleById.get(c.id) || c.id,
      status: cardDefects.length === 0 ? 'clean' : 'defect',
      defects: cardDefects,
    };
  });

  return {
    status: defects.length === 0 ? 'ok' : 'defect',
    tiles,
    present,
    defects,
    advisories,
    cardStatuses,
    cardTitleById: Object.fromEntries(cardTitleById),
  };
}

function cardLabel(card) {
  // First human-readable token of the matcher for the report.
  return card.condition ? card.condition.split('.')[0] : card.id;
}

// A fetched page "looks real" when it ExampleCos enough markup to be the briefing
// shell, not an error stub or an empty response. Used to tell a transient
// unreachable (retry) apart from a permanent parser break (HARD defect): if the
// body is real but parseTiles() found 0 tiles, the markup contract changed and
// retrying forever would mask it. Deliberately loose -- any of the known shell
// markers, or a substantial length, qualifies.
function htmlBodyLooksReal(html) {
  const s = String(html || '');
  if (s.length >= 2000) return true;
  return /<section|data-section=|class="tile|<main\b|id="briefing"|Daily Briefing/i.test(s);
}

// A fetched page is the auth SIGN-IN shell (scripts/lib/briefing-auth.js
// buildBriefingSignInNeeded / the /briefing route's login form), not the
// briefing dashboard. This is a REAL page body -- htmlBodyLooksReal() correctly
// returns true for it (it is well over 2000 bytes with plenty of markup) -- so
// without a distinct check a stale/expired token silently classified as
// "render markup changed: parsed 0 tiles", the exact HARD-defect message a
// genuinely broken tile parser produces. That collapses two different failures
// (auth broke vs. markup broke) into one message and sends whoever is
// triaging chasing the parser regex when the real problem is the token/EC2
// process. Named markers only (the login form's own title/class contract),
// so an actual dashboard tile that happens to mention "sign in" prose is
// never misclassified.
function isBriefingSignInPage(html) {
  const s = String(html || '');
  return /Amy Briefing Sign In|class="signin"|Sign in to view the briefing/i.test(s);
}

// ---------------------------------------------------------------------------
// Fetch layer (kept thin and side-effecting; the verifier above is pure).
// ---------------------------------------------------------------------------

function readTokenFromEnvFile(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const m = String(text).match(/(?:^|\n)\s*SB_BRIEFING_TOKEN\s*=\s*["']?([^"'\r\n]+)/);
    return m ? m[1].trim() : '';
  } catch {
    return '';
  }
}

function localTokenCandidates() {
  return [
    process.env.SB_BRIEFING_ENV_FILE,
    path.join(process.cwd(), '.env'),
    path.join(__dirname, '..', '.env'),
    '/opt/secondbrain/.env',
  ]
    .filter(Boolean)
    .map((value) => path.resolve(String(value)))
    .filter((value, idx, arr) => arr.indexOf(value) === idx);
}

function resolveToken() {
  if (process.env.SB_BRIEFING_TOKEN) return process.env.SB_BRIEFING_TOKEN.trim();
  for (const file of localTokenCandidates()) {
    const token = readTokenFromEnvFile(file);
    if (token) return token;
  }
  const key = process.env.EC2_SSH_KEY || path.join(os.homedir(), '.ssh', 'sb-key.pem');
  const host = process.env.EC2_HOST || 'ec2-user@ExampleCo';
  try {
    const out = execFileSync(
      'ssh',
      [
        '-i',
        key,
        '-o',
        'StrictHostKeyChecking=no',
        '-o',
        'ConnectTimeout=20',
        host,
        'grep SB_BRIEFING_TOKEN /opt/secondbrain/.env',
      ],
      { encoding: 'utf8' },
    );
    const m = String(out).match(/SB_BRIEFING_TOKEN\s*=\s*["']?([^"'\r\n]+)/);
    return m ? m[1].trim() : '';
  } catch {
    return '';
  }
}

function fetchLiveHtml(opts) {
  if (opts.htmlFile) {
    return { html: fs.readFileSync(opts.htmlFile, 'utf8'), source: opts.htmlFile };
  }
  const host = opts.host || process.env.EC2_HOST_HTTP || 'http://ExampleCo:3001';
  const token = resolveToken();
  if (!token) {
    return { html: '', source: 'no-token', unreachable: true };
  }
  const url =
    opts.url ||
    `${host.replace(/\/$/, '')}/briefing?date=${encodeURIComponent(opts.date)}&k=${encodeURIComponent(token)}`;
  try {
    const html = execFileSync('curl', ['-s', '-L', '-m', '30', url], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    if (!html || html.length < 500) return { html: '', source: url, unreachable: true };
    return { html, source: url };
  } catch (e) {
    return { html: '', source: url, unreachable: true, error: (e && e.message) || String(e) };
  }
}

function main() {
  const opts = parseArgs(process.argv);
  const { html, source, unreachable, error } = fetchLiveHtml(opts);

  if (unreachable || !html) {
    console.error(
      `CANNOT VERIFY (retry): dashboard unreachable or token unavailable [${source}]${error ? ' ' + error.slice(0, 160) : ''}`,
    );
    process.exit(EXIT_UNREACHABLE);
  }

  let result = verifyDashboard(html, opts.date);
  if (opts.cardIds && opts.cardIds.length) {
    result = scopeDashboardResult(result, opts.cardIds);
  }

  if (result.status === 'parse-failed') {
    // AUTH FAILED is checked FIRST and named distinctly. The briefing auth
    // sign-in shell (scripts/lib/briefing-auth.js) is a real, well-formed page
    // -- bodyLooksReal is also true for it -- so without this check a stale
    // token / expired trusted-device cookie / an unconfigured SB_BRIEFING_TOKEN
    // on the serving process collapsed into the SAME "render markup changed:
    // parsed 0 tiles" hard-defect message a genuinely broken tile parser
    // produces (2026-07-03: an orphaned node process squatting on :3001 with no
    // .env loaded served the sign-in shell to every fetch and was misdiagnosed
    // as a markup break). Auth failure is a RETRY condition for the caller
    // (self-heals once the token/process issue is fixed), but it must name
    // itself so it is never silently retried as a generic "dashboard
    // unreachable" or wrongly escalated as a parser HARD defect.
    if (result.isSignInPage) {
      console.error(
        `CANNOT VERIFY (retry, AUTH FAILED): fetched the briefing sign-in page from ${source} instead of the dashboard -- the token did not authenticate (stale SB_BRIEFING_TOKEN, unconfigured on the serving process, or expired trusted-device session). This is NOT a markup/parser break.`,
      );
      process.exit(EXIT_UNREACHABLE);
    }
    // Silent-failure fix: a 0-tile parse is only a retry when the page body was
    // trivial (truly unreachable/empty). If the HTTP fetch returned a REAL page
    // body but the parser still found nothing, the markup contract changed and
    // the parser is broken. Returning EXIT_UNREACHABLE there makes the wire-in
    // retry forever and never surface a permanent break. So: real body + 0 tiles
    // = HARD defect (exit 1), not a retry (exit 2).
    if (result.bodyLooksReal) {
      console.error(
        `dashboard QC FAILED: fetched a real page body (${html.length} bytes) from ${source} but parsed 0 tiles. The render markup changed and the tile parser is broken -- this is a HARD defect, not a transient retry.`,
      );
      process.exit(EXIT_DEFECT);
    }
    console.error(
      `CANNOT VERIFY (retry): parsed 0 tiles from ${source} and the body looks empty/trivial (${html.length} bytes) -- dashboard likely not up yet.`,
    );
    process.exit(EXIT_UNREACHABLE);
  }

  console.log(
    `Dashboard render QC. date=${opts.date} source=${source}${
      result.scoped ? ` scope=${result.scopeCardIds.join(',')}` : ''
    }`,
  );
  console.log(
    `Tiles rendered: ${result.tiles.length}. Manifest cards represented: ${result.present.length}/${manifest.CARDS.length}.`,
  );

  // Advisories are logged regardless of pass/fail; they never gate.
  if (result.advisories && result.advisories.length) {
    console.log(`Advisories (non-gating): ${result.advisories.length}`);
    for (const a of result.advisories) console.log('  . ' + a);
  }

  // --write-artifact: persist this run's result to the canonical
  // dashboard-qc-result.json so a standalone verify run is no longer
  // invisible to every consumer that reads through live-board-truth.js.
  // Runs regardless of pass/fail -- a defect run must overwrite a stale
  // "clean" artifact just as much as a clean run must overwrite a stale
  // defect count.
  if (opts.writeArtifact) {
    const { artifact, absPath } = writeCanonicalArtifactFromResult(result, opts);
    console.log(
      `Wrote canonical dashboard-qc artifact to ${absPath}: defectiveCardCount=${artifact.defectiveCardCount}, ts=${artifact.ts}${result.scoped ? `, scoped=${result.scopeCardIds.join(',')}` : ''}`,
    );
  }

  if (result.status === 'ok') {
    console.log(
      'PASS: every always-expected card is rendered, non-empty, value-sane, and exec-crisp.',
    );
    process.exit(EXIT_OK);
  }

  console.error(`dashboard QC FAILED: ${result.defects.length} defect(s):`);
  for (const d of result.defects) console.error('  - ' + d);
  process.exit(EXIT_DEFECT);
}

module.exports = {
  verifyDashboard,
  parseTiles,
  awsCostsIsCleanThresholdAlert,
  AWS_COST_RED_THRESHOLD_FLOOR,
  valueSanityDefects,
  newsCountDefects,
  newsStubDefects,
  execCrispnessDefects,
  statusDefects,
  videoManifestDriftDefects,
  advisoryNotes,
  blockersUnderReportDefects,
  isNamedInBlockers,
  nameTokens,
  htmlBodyLooksReal,
  isBriefingSignInPage,
  readTokenFromEnvFile,
  resolveToken,
  denylistHits,
  redactPathsInEvidence,
  fetchLiveHtml,
  findTiles,
  parseArgs,
  writeCanonicalArtifactFromResult,
  mergeScopedArtifact,
  parseCardScope,
  scopeDashboardResult,
  FACE_DENYLIST,
  EMPTY_BODY_FLOOR,
  STALE_HOURS,
  EXIT_OK,
  EXIT_DEFECT,
  EXIT_UNREACHABLE,
};

if (require.main === module) main();
