'use strict';
/**
 * card-skills.js -- shared reader for the per-card skill pages under
 * skills/cards/ (ExampleCo 2026-07-06: "every card gets a 1-pager that is always
 * curated with learnings ... any edit to that card references the last 10
 * learnings, lint-drift-secured at all times").
 *
 * ONE reader, four consumers:
 *   - scripts/card-skill.js            (the CLI printer)
 *   - scripts/refresh-card.js          (prints the card's context at run start)
 *   - scripts/overnight-self-heal-orchestrator.js (injects into worker prompts)
 *   - scripts/verify-cards-drift.js    (the drift lint)
 * plus scripts/claude-hooks/card-learnings-guard.mjs via createRequire.
 *
 * PAGE SHAPE (skills/cards/<pageDir>/):
 *   SKILL.md      YAML frontmatter (card, matcher, ownership, heal, verify)
 *                 + one-page body with the four required headings:
 *                 ## Clean contract / ## Data flow / ## Known failure modes /
 *                 ## Pinned lessons
 *   LEARNINGS.md  append-only dated entries: `## YYYY-MM-DD <title>` then
 *                 incident / root cause / fix / prevention. Tooling surfaces
 *                 the LAST 10 plus the pinned section; git stores everything
 *                 (never truncate the file).
 *
 * PII gate: the employer-news manifest card id embeds the employer slug at
 * RUNTIME (scripts/lib/briefing-card-manifest.js builds it from
 * memory/reference_operator_identity.json). The git-tracked page directory
 * must never carry that token -- scripts/ is in the public-sync allowlist's
 * blast radius even though skills/ is not, and this lib is public -- so any
 * manifest id ending in `_group_news` maps to the ONE neutral page dir
 * `employer_group_news`. That page's frontmatter ExampleCos the sentinel
 * matcher `runtime-operator` instead of the literal regex.
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_SKILLS_DIR = path.join(REPO_ROOT, 'skills', 'cards');
const SHELL_PAGE_ID = 'briefing_shell';
const EMPLOYER_PAGE_DIR = 'employer_group_news';
const RUNTIME_MATCHER_SENTINEL = 'runtime-operator';
const LAST_N_LEARNINGS = 10;

// Manifest card id -> git-tracked page directory name. Identity for every
// card except the employer-news card (see the PII gate note above).
function pageDirForCardId(cardId) {
  const id = String(cardId || '').trim();
  if (!id) return '';
  if (id.endsWith('_group_news')) return EMPLOYER_PAGE_DIR;
  return id;
}

// --- SKILL.md parsing -------------------------------------------------------

// Split a SKILL.md into { frontmatter, body }. Frontmatter is the leading
// `---` ... `---` YAML block, parsed with js-yaml (already a repo dependency).
// Returns frontmatter: null when the block is absent or unparseable (the drift
// lint reports that as a failure; the printer degrades to body-only).
function parseSkillMd(text) {
  const src = String(text || '');
  const match = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { frontmatter: null, body: src.trim() };
  let frontmatter = null;
  try {
    frontmatter = require('js-yaml').load(match[1]);
  } catch {
    frontmatter = null;
  }
  return { frontmatter, body: src.slice(match[0].length).trim() };
}

// Extract one `## Heading` section's text from a SKILL.md body ('' if absent).
function sectionFromBody(body, heading) {
  const lines = String(body || '').split('\n');
  const out = [];
  let inSection = false;
  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      if (inSection) break;
      inSection = new RegExp(`^##\\s+${heading}\\s*$`, 'i').test(line.trim());
      continue;
    }
    if (inSection) out.push(line);
  }
  return out.join('\n').trim();
}

// --- LEARNINGS.md parsing ---------------------------------------------------

const LEARNING_HEADING_RE = /^##\s+(\d{4}-\d{2}-\d{2})\s+(.+?)\s*$/;

// Parse LEARNINGS.md into ordered entries [{ date, title, body }]. The file is
// append-only, so file order IS chronological order; entries keep it.
function parseLearnings(text) {
  const lines = String(text || '').split('\n');
  const entries = [];
  let current = null;
  for (const line of lines) {
    const m = line.match(LEARNING_HEADING_RE);
    if (m) {
      current = { date: m[1], title: m[2], bodyLines: [] };
      entries.push(current);
      continue;
    }
    if (current) current.bodyLines.push(line);
  }
  return entries.map((e) => ({
    date: e.date,
    title: e.title,
    body: e.bodyLines.join('\n').trim(),
  }));
}

// The last N entries, NEWEST FIRST. Append-only file order is chronological,
// so "last N" is the tail of the file, reversed for newest-first display.
function lastLearnings(entries, n = LAST_N_LEARNINGS) {
  return (entries || []).slice(-n).reverse();
}

// --- page reading -----------------------------------------------------------

function readFileSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

// Read one card page. Returns null when the page directory or SKILL.md is
// missing (callers treat that as "no page" -- always non-fatal).
function readCardPage(cardId, { skillsDir = DEFAULT_SKILLS_DIR } = {}) {
  const pageDir = pageDirForCardId(cardId);
  if (!pageDir) return null;
  const dir = path.join(skillsDir, pageDir);
  const skillPath = path.join(dir, 'SKILL.md');
  const learningsPath = path.join(dir, 'LEARNINGS.md');
  const skillText = readFileSafe(skillPath);
  if (skillText === null) return null;
  const { frontmatter, body } = parseSkillMd(skillText);
  const learningsText = readFileSafe(learningsPath);
  return {
    cardId: String(cardId),
    pageDir,
    dir,
    skillPath,
    learningsPath,
    frontmatter,
    body,
    pinned: sectionFromBody(body, 'Pinned lessons'),
    learnings: parseLearnings(learningsText || ''),
    hasLearningsFile: learningsText !== null,
  };
}

// List every page directory that exists under skills/cards/.
function listPageDirs({ skillsDir = DEFAULT_SKILLS_DIR } = {}) {
  try {
    return fs
      .readdirSync(skillsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

// --- formatted context (the injection payload) ------------------------------

// The clearly delimited card-skill context block printed by refresh-card.js
// and injected into self-heal worker prompts. Returns '' when the card has no
// page (never throws): consumption is by-default but always non-fatal.
function formatCardSkillContext(
  cardId,
  { skillsDir = DEFAULT_SKILLS_DIR, lastN = LAST_N_LEARNINGS } = {},
) {
  let page;
  try {
    page = readCardPage(cardId, { skillsDir });
  } catch {
    return '';
  }
  if (!page) return '';
  const recent = lastLearnings(page.learnings, lastN);
  const lines = [
    `===== CARD SKILL: ${page.cardId} (${path.relative(REPO_ROOT, page.skillPath).replace(/\\/g, '/')}) =====`,
    page.body,
    '',
    `----- LAST ${lastN} LEARNINGS (newest first; full history in LEARNINGS.md) -----`,
  ];
  if (recent.length === 0) {
    lines.push('(no dated learnings recorded yet)');
  } else {
    for (const entry of recent) {
      lines.push(`## ${entry.date} ${entry.title}`);
      if (entry.body) lines.push(entry.body);
    }
  }
  lines.push(`===== END CARD SKILL: ${page.cardId} =====`);
  return lines.join('\n');
}

// --- blocker -> card id mapping (self-heal prompt injection) ----------------

// Best-effort card id extraction from a self-heal blocker object. Blockers
// built by renderQcDefectsToBlockers carry the card id in their title
// ("Live render QC NEWS-SHORTFALL on covid_news"); other blockers may carry
// card_id/cardId fields or name a card id token in title/evidence. A token
// counts only when a page actually exists for it, so free text can never
// misroute the injection. Returns '' when no card page maps.
function cardIdFromBlocker(blocker, { skillsDir = DEFAULT_SKILLS_DIR } = {}) {
  if (!blocker || typeof blocker !== 'object') return '';
  const direct = String(blocker.card_id || blocker.cardId || '').trim();
  if (direct && readCardPage(direct, { skillsDir })) return direct;
  const haystack = `${blocker.title || ''} ${blocker.evidence || ''}`;
  const tokens = haystack.match(/[a-z][a-z0-9_]{2,}/g) || [];
  for (const token of tokens) {
    if (!token.includes('_')) continue; // every manifest card id is snake_case
    if (readCardPage(token, { skillsDir })) return token;
  }
  return '';
}

module.exports = {
  REPO_ROOT,
  DEFAULT_SKILLS_DIR,
  SHELL_PAGE_ID,
  EMPLOYER_PAGE_DIR,
  RUNTIME_MATCHER_SENTINEL,
  LAST_N_LEARNINGS,
  pageDirForCardId,
  parseSkillMd,
  sectionFromBody,
  parseLearnings,
  lastLearnings,
  readCardPage,
  listPageDirs,
  formatCardSkillContext,
  cardIdFromBlocker,
};
