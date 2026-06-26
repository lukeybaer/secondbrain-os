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
} = require('./lib/news-summarize.js');
const { loadOperatorIdentity } = require('./lib/operator-identity.js');

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
  const opts = { date: new Date().toISOString().slice(0, 10) };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--date') opts.date = argv[++i];
    else if (a === '--html') opts.htmlFile = argv[++i];
    else if (a === '--url') opts.url = argv[++i];
    else if (a === '--host') opts.host = argv[++i];
    else if (!a.startsWith('--') && /^\d{4}-\d{2}-\d{2}$/.test(a)) opts.date = a;
  }
  return opts;
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
    const inner = m[3];
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
      (row.match(/<div[^>]*\bclass="[^"]*\bitem-name\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i) ||
        [])[1] || '',
    );
    const why = strip(
      (row.match(/<div[^>]*\bclass="[^"]*\bitem-why\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i) ||
        [])[1] || '',
    );
    const url = strip(
      (row.match(/<a[^>]*\bclass="[^"]*\bitem-src\b[^"]*"[^>]*\bhref="([^"]+)"/i) || [])[1] ||
        '',
    );
    rows.push({ title, why, url });
  }
  return rows;
}

const NEWS_PUBLISHER_CHROME =
  /\b(?:Image source|Image caption|Courtesy photo|Business reporter|BBC Verify|Published \d+|Updated \d+|Latest Big pharma|Help ensure someone|MAKING AMERICA SAFE AGAIN|Share Twitter|Read more Overview)\b/i;
const NEWS_JUMBLE_TOKENS = [
  /visualizing the quakes/i,
  /what'?s a doublet/i,
  /latin america'?s deadliest/i,
  /world reacts/i,
  /drive through/i,
  /image source/i,
  /image caption/i,
  /read more/i,
  /overview/i,
];

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
  return defects;
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

  // 1. TOKEN DENYLIST on the face.
  for (const hit of denylistHits(face)) {
    defects.push(
      `EXEC-CRISPNESS: ${card.id} (${tile.name}) face leaks ${hit.label}: "${strip(hit.match).slice(0, 60)}"`,
    );
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
  const metricIsVerdict = metric !== '' && VERDICT_TOKEN.test(metric);
  if (!metricIsVerdict && opening) {
    const head = opening.slice(0, ANSWER_FIRST_WINDOW);
    if (!VERDICT_TOKEN.test(head)) {
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

  // (a) TARGET: a news card must render its manifest target count.
  if (target !== null && rendered !== null && rendered < target) {
    defects.push(
      `BUILDER-COUNT: ${card.id} (${tile.name}) rendered ${rendered} item(s), below its target of ${target}`,
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
    const detail =
      card.id === 'system_health' ? systemHealthBlockedTileDetail(tile.body || tile.face || '') : '';
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
  return defects;
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
  if (/\b(?:clearest source-backed read is|Touches [^.;]{0,120}; Contains|family wealth\s*\/\s*mission|relationship capital)\b/i.test(text)) {
    defects.push(
      `OTTER-CALL-SUMMARY: ${card.id} (${tile.name}) renders boilerplate relevance labels instead of what happened, decisions made, and ExampleCo next actions`,
    );
  }
  if (/call-history-detail-table/i.test(tile.inner || '') && !/Executive summary/i.test(tile.inner || '')) {
    defects.push(
      `OTTER-CALL-HEADERS: ${card.id} (${tile.name}) call-history drilldown is missing column headers including Executive summary`,
    );
  }
  defects.push(...otterRollingWindowDefects(card, tile));
  return defects;
}

function otterRollingWindowDefects(card, tile) {
  if (!tile || card.id !== 'otter_speaker_pareto') return [];
  const text = strip(`${tile.body || ''} ${tile.inner || ''}`);
  if (!/Past 24 Hours/i.test(text) || !/No calls in this group/i.test(text)) return [];
  const updateMinutes = parseUpdatedMinutes(tile.inner || '') ?? 5 * 60 + 30;
  const dayBefore = previousIsoDateFromRunText(text);
  if (!dayBefore) return [];
  const dayBeforeIdx = text.search(new RegExp(`Day Before\\s+${dayBefore.replace(/-/g, '\\-')}`, 'i'));
  if (dayBeforeIdx < 0) return [];
  const dayBeforeText = text.slice(dayBeforeIdx);
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
  const m = String(html || '').match(/Updated\s+[A-Z][a-z]{2}\s+\d{1,2},\s+(\d{1,2}):(\d{2})\s*([AP]M)/i);
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

function cardSpecificDefects(card, tile, runDate) {
  return [
    ...peopleFilesFreshnessDefects(card, tile, runDate),
    ...peopleFilesDetailDefects(card, tile),
    ...otterSpeakerParetoAudioDefects(card, tile),
    ...awsCostsDetailDefects(card, tile),
    ...kingdomResearchDefects(card, tile),
    ...communicationCoachingDefects(card, tile),
    ...actionItemsAgeDefects(card, tile),
    ...actionItemsEvidenceDefects(card, tile),
    ...meetingsHorizonDefects(card, tile),
    ...amyProjectsDefects(card, tile),
    ...otterCallHistoryContentDefects(card, tile),
    ...videoManifestDriftDefects(card, tile),
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
// category, not one incident.
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

function tokensFromText(text) {
  return (String(text || '').toUpperCase().match(/[A-Z0-9]{4,}/g) || []).filter(
    (t) => !NAME_FILLER.has(t),
  );
}

function cardNameTokenParts(name) {
  const withoutSuffix = String(name || '').replace(/\((?:[^)]*)\)\s*$/g, ' ');
  const [leadAndMaybeSlash, ...tailParts] = withoutSuffix.split(/[-|]/);
  const slashParts = String(leadAndMaybeSlash || '').split('/');
  const lead = tokensFromText(slashParts.shift() || '');
  const subtitle = [
    ...slashParts.flatMap(tokensFromText),
    ...tailParts.flatMap(tokensFromText),
  ];
  return { lead, subtitle };
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

function tokenListNamedInBlockers(tokens, blockersBody) {
  const body = String(blockersBody || '');
  return tokens.some((t) => new RegExp(`\\b${t}\\b`, 'i').test(body));
}

function isNamedInBlockersPart(tile, blockersBody, part) {
  const tokens = part === 'subtitle' ? cardNameTokenParts(tile.name).subtitle : nameTokens(tile.name);
  return tokenListNamedInBlockers(tokens, blockersBody);
}

function isNamedInBlockers(tile, blockersBody) {
  return (
    isNamedInBlockersPart(tile, blockersBody, 'lead') ||
    isNamedInBlockersPart(tile, blockersBody, 'subtitle')
  );
}

function blockerRows(blockersBody) {
  const body = String(blockersBody || '').replace(/\s+/g, ' ').trim();
  const rows = [];
  const re = /(?:^|\s)(\d+)\.\s+([\s\S]*?)(?=\s+\d+\.\s+|$)/g;
  let m;
  while ((m = re.exec(body))) {
    rows.push({ n: parseInt(m[1], 10), text: m[2].trim() });
  }
  return rows;
}

function blockersNamedCardDefects(tiles, defectsByCard) {
  const blockersTile = tiles.find((t) => /^BLOCKERS\b/i.test(t.name));
  if (!blockersTile) return [];
  const rows = blockerRows(blockersTile.body || '');
  if (!rows.length) return [];
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    for (const part of ['lead', 'subtitle']) {
      let matched = false;
      for (const card of manifest.CARDS) {
        if (card.id === 'blockers') continue;
        const tile = findTile(tiles, card);
        if (!tile) continue;
        const existing = defectsByCard.get(card.id) || [];
        if (existing.length) continue;
        if (!isNamedInBlockersPart(tile, row.text, part)) continue;
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
    if (!blockersLooksEmpty && isNamedInBlockers(t, body)) continue;
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
  const distinctDefectiveCards = [...defectsByCard.values()].filter((b) => b.length).length;
  const rawDefectsBeforeBlockerCountCheck = defects.length;
  if (reportedBlockers > 0 && distinctDefectiveCards === 0) {
    defects.push(
      `BLOCKERS-FLOOR: the briefing's Blockers card reports ${reportedBlockers} hard blocker(s) but the QC found no defective cards; the QC must not call the dashboard clean while Blockers says it is blocked`,
    );
  }
  if (blockersTile && rawDefectsBeforeBlockerCountCheck > 0 && reportedBlockers < rawDefectsBeforeBlockerCountCheck) {
    defects.push(
      `BLOCKERS-COUNT: the Blockers card reports ${reportedBlockers} hard blocker(s), but live render QC found ${rawDefectsBeforeBlockerCountCheck} defect(s); every prose/content/render defect that survived self-heal must count as a blocker`,
    );
  }

  // BLOCKERS UNDER-REPORT: complementary to BLOCKERS-FLOOR. A specific card that
  // is blocked (red tile or "BLOCKER:"/"hard blocker" in its body) but is not
  // NAMED on the top Blockers card -- the contradiction ExampleCo caught 2026-06-22
  // (OTTER SPEAKER PARETO body says "BLOCKER:" while the Blockers card says
  // "Clear"). Not bucketed per-card: it is a cross-card consistency defect.
  defects.push(...blockersUnderReportDefects(tiles));

  // One status per manifest card: 'clean' when it has zero defects, else 'defect'.
  const cardStatuses = manifest.CARDS.map((c) => {
    const cardDefects = defectsByCard.get(c.id) || [];
    return {
      id: c.id,
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

  const result = verifyDashboard(html, opts.date);

  if (result.status === 'parse-failed') {
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

  console.log(`Dashboard render QC. date=${opts.date} source=${source}`);
  console.log(
    `Tiles rendered: ${result.tiles.length}. Manifest cards represented: ${result.present.length}/${manifest.CARDS.length}.`,
  );

  // Advisories are logged regardless of pass/fail; they never gate.
  if (result.advisories && result.advisories.length) {
    console.log(`Advisories (non-gating): ${result.advisories.length}`);
    for (const a of result.advisories) console.log('  . ' + a);
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
  valueSanityDefects,
  newsCountDefects,
  newsStubDefects,
  execCrispnessDefects,
  statusDefects,
  advisoryNotes,
  blockersUnderReportDefects,
  isNamedInBlockers,
  nameTokens,
  htmlBodyLooksReal,
  readTokenFromEnvFile,
  resolveToken,
  denylistHits,
  fetchLiveHtml,
  findTiles,
  FACE_DENYLIST,
  EMPTY_BODY_FLOOR,
  STALE_HOURS,
  EXIT_OK,
  EXIT_DEFECT,
  EXIT_UNREACHABLE,
};

if (require.main === module) main();
