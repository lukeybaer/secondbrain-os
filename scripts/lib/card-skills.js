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
 * `employer_group_news`. That page's frontmatter carries the sentinel
 * matcher `runtime-operator` instead of the literal regex.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  SYSTEM_HEALTH_MEASUREMENT_IDS,
} = require('./system-health-nongreen.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_SKILLS_DIR = path.join(REPO_ROOT, 'skills', 'cards');
const SHELL_PAGE_ID = 'briefing_shell';
const EMPLOYER_PAGE_DIR = 'employer_group_news';
const RUNTIME_MATCHER_SENTINEL = 'runtime-operator';
const LAST_N_LEARNINGS = 10;
const SYSTEM_HEALTH_CARD_ID = 'system_health';
const SYSTEM_HEALTH_METRICS_DIR = path.join(SYSTEM_HEALTH_CARD_ID, 'metrics');
const SYSTEM_HEALTH_METRIC_TEMPLATE = path.join(
  SYSTEM_HEALTH_CARD_ID,
  'METRIC_SKILL_TEMPLATE.md',
);
const SYSTEM_HEALTH_METRIC_LEARNINGS_REL = path.join(
  'agent',
  'system-health-metric-skills',
);
const REGISTERED_SYSTEM_HEALTH_METRIC_IDS = Object.freeze(
  Array.from(new Set(Object.values(SYSTEM_HEALTH_MEASUREMENT_IDS))).sort(),
);
const REGISTERED_SYSTEM_HEALTH_METRIC_ID_SET = new Set(
  REGISTERED_SYSTEM_HEALTH_METRIC_IDS,
);

function isRegisteredSystemHealthMetricId(cardId) {
  return REGISTERED_SYSTEM_HEALTH_METRIC_ID_SET.has(String(cardId || '').trim());
}

function systemHealthMetricSlug(cardId) {
  const id = String(cardId || '').trim();
  return isRegisteredSystemHealthMetricId(id) ? id.slice(`${SYSTEM_HEALTH_CARD_ID}:`.length) : '';
}

// Manifest card id -> git-tracked page directory name. Identity for every
// card except the employer-news card (see the PII gate note above).
function pageDirForCardId(cardId) {
  const id = String(cardId || '').trim();
  if (!id) return '';
  if (isRegisteredSystemHealthMetricId(id)) {
    return path.join(SYSTEM_HEALTH_METRICS_DIR, `${systemHealthMetricSlug(id)}.md`);
  }
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

// An empty machine attempt row: written by appendMetricSkillLearning (it
// carries the metric-attempt marker) with no stated hypothesis, action, or
// result. On 2026-09-24, 121 of 199 rows in the otter-call-processing-sla
// history were this shape and 7 of its final ten; they state nothing a
// healer can use and only repeat the same-night attempt history the prompt
// already carries. A row missing any of the three fields is kept, and only
// executor-fault rows are dropped: a cleared, implementation-changed,
// integration-pending or failed row with the same placeholders still carries
// a real outcome (for example a deployed fix that left the metric red).
const MACHINE_ATTEMPT_MARKER = /<!-- metric-attempt:[0-9a-f]+ -->/;
const UNSTATED_FIELD = /^(?:per-defect (?:hypothesis|action|result) not stated|\[not recorded\])$/i;

function learningField(body, label) {
  const match = String(body || '').match(new RegExp(`^${label}:[ \\t]*(.*)$`, 'm'));
  return match ? match[1].trim() : null;
}

function isEmptyMachineLearning(entry) {
  const body = entry && entry.body;
  if (!MACHINE_ATTEMPT_MARKER.test(String(body || ''))) return false;
  if (String(learningField(body, 'Outcome') || '').toLowerCase() !== 'executor-fault') return false;
  return ['Hypothesis', 'Action', 'Result'].every((label) => {
    const value = learningField(body, label);
    return value !== null && UNSTATED_FIELD.test(value);
  });
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
function defaultDataDir() {
  return path.resolve(process.env.SECONDBRAIN_DATA_DIR || path.join(REPO_ROOT, 'data'));
}

function metricSkillLearningPath(
  workUnitId,
  { dataDir = defaultDataDir() } = {},
) {
  const slug = systemHealthMetricSlug(workUnitId);
  if (!slug) return '';
  return path.join(
    path.resolve(dataDir),
    SYSTEM_HEALTH_METRIC_LEARNINGS_REL,
    slug,
    'LEARNINGS.md',
  );
}

function readCardPage(
  cardId,
  { skillsDir = DEFAULT_SKILLS_DIR, dataDir = defaultDataDir() } = {},
) {
  const pageDir = pageDirForCardId(cardId);
  if (!pageDir) return null;
  if (isRegisteredSystemHealthMetricId(cardId)) {
    const skillPath = path.join(skillsDir, pageDir);
    const templatePath = path.join(skillsDir, SYSTEM_HEALTH_METRIC_TEMPLATE);
    const skillText = readFileSafe(skillPath);
    const templateText = readFileSafe(templatePath);
    if (skillText === null || templateText === null) return null;
    const parsed = parseSkillMd(skillText);
    const runtimeLearningsPath = metricSkillLearningPath(cardId, { dataDir });
    const runtimeLearningsText = readFileSafe(runtimeLearningsPath);
    const body = [templateText.trim(), parsed.body].filter(Boolean).join('\n\n');
    return {
      cardId: String(cardId),
      pageDir,
      dir: path.dirname(skillPath),
      skillPath,
      learningsPath: runtimeLearningsPath,
      frontmatter: parsed.frontmatter,
      body,
      pinned: sectionFromBody(body, 'Pinned lessons'),
      learnings: parseLearnings(runtimeLearningsText || ''),
      hasLearningsFile: runtimeLearningsText !== null,
      kind: 'system-health-metric',
      templatePath,
    };
  }
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
    kind: 'card',
  };
}

function cleanLearningText(value, max = 500) {
  return String(value == null ? '' : value)
    .replace(/\r?\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\u2014/g, '-')
    .trim()
    .slice(0, max);
}

function appendMetricSkillLearning({
  workUnitId,
  attempt,
  dataDir = defaultDataDir(),
}) {
  const id = String(workUnitId || '').trim();
  if (!isRegisteredSystemHealthMetricId(id)) {
    return { written: false, reason: 'not-a-registered-system-health-metric' };
  }
  const row = attempt && typeof attempt === 'object' ? attempt : {};
  const markerPayload = {
    workUnitId: id,
    runId: cleanLearningText(row.runId, 160),
    tactic: cleanLearningText(row.tactic, 160),
    inputHash: cleanLearningText(row.inputHash, 160),
    outcome: cleanLearningText(row.outcome, 80),
  };
  const marker = crypto
    .createHash('sha256')
    .update(JSON.stringify(markerPayload))
    .digest('hex')
    .slice(0, 20);
  const learningsPath = metricSkillLearningPath(id, { dataDir });
  fs.mkdirSync(path.dirname(learningsPath), { recursive: true });
  const existing = readFileSafe(learningsPath) || '';
  if (existing.includes(`metric-attempt:${marker}`)) {
    return { written: false, duplicate: true, marker, learningsPath };
  }
  const ts = new Date(row.ts || Date.now());
  const date = Number.isFinite(ts.getTime())
    ? ts.toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10);
  const outcome = cleanLearningText(row.outcome || 'unknown', 80);
  const title = `${outcome || 'unknown'} attempt ${cleanLearningText(row.tactic || 'unknown tactic', 120)}`;
  const lines = [
    existing && !existing.endsWith('\n') ? '' : null,
    `## ${date} ${title}`,
    '',
    `<!-- metric-attempt:${marker} -->`,
    `Run: ${cleanLearningText(row.runId || 'unknown', 160)}`,
    `Outcome: ${outcome || 'unknown'}`,
    `Hypothesis: ${cleanLearningText(row.hypothesis || '[not recorded]', 500)}`,
    `Action: ${cleanLearningText(row.action || '[not recorded]', 500)}`,
    `Result: ${cleanLearningText(row.result || row.liveOutcome || '[not recorded]', 500)}`,
    `Why not closed: ${cleanLearningText(row.whyNotClosed || row.reason || (outcome === 'cleared' ? 'cleared by live proof' : '[not recorded]'), 500)}`,
    '',
  ].filter((line) => line !== null);
  fs.appendFileSync(learningsPath, lines.join('\n'), 'utf8');
  return { written: true, marker, learningsPath };
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
  {
    skillsDir = DEFAULT_SKILLS_DIR,
    dataDir = defaultDataDir(),
    lastN = LAST_N_LEARNINGS,
  } = {},
) {
  let page;
  try {
    page = readCardPage(cardId, { skillsDir, dataDir });
  } catch {
    return '';
  }
  if (!page) return '';
  // Skill learning loop: the final ten entries only, minus empty machine
  // attempt rows, plus one pointer line so the worker can open the full file
  // for a specific question. The pointer stays inside the LEARNINGS block,
  // which healer-evidence-fingerprint.js strips from the stable fingerprint.
  const recent = lastLearnings(page.learnings, lastN);
  const shown = recent.filter((entry) => !isEmptyMachineLearning(entry));
  const olderCount = Math.max(0, page.learnings.length - recent.length);
  const droppedCount = recent.length - shown.length;
  const lines = [
    `===== ${page.kind === 'system-health-metric' ? 'SYSTEM HEALTH METRIC' : 'CARD'} SKILL: ${page.cardId} (${path.relative(REPO_ROOT, page.skillPath).replace(/\\/g, '/')}) =====`,
    page.body,
    '',
    `----- LAST ${lastN} LEARNINGS (newest first; empty machine attempt rows dropped) -----`,
    `(${olderCount} older ${olderCount === 1 ? 'entry' : 'entries'} not shown` +
      `${droppedCount ? `; ${droppedCount} empty machine attempt ${droppedCount === 1 ? 'row' : 'rows'} dropped from the last ${lastN}` : ''}` +
      `; full history: ${page.learningsPath}; open it only for a specific question)`,
  ];
  if (recent.length === 0) {
    lines.push('(no dated learnings recorded yet)');
  } else if (shown.length === 0) {
    lines.push(`(no stated learnings in the last ${lastN} entries)`);
  } else {
    for (const entry of shown) {
      lines.push(`## ${entry.date} ${entry.title}`);
      if (entry.body) lines.push(entry.body);
    }
  }
  lines.push(
    `===== END ${page.kind === 'system-health-metric' ? 'SYSTEM HEALTH METRIC' : 'CARD'} SKILL: ${page.cardId} =====`,
  );
  return lines.join('\n');
}

// --- blocker -> card id mapping (self-heal prompt injection) ----------------

// Best-effort card id extraction from a self-heal blocker object. Blockers
// built by renderQcDefectsToBlockers carry the card id in their title
// ("Live render QC NEWS-SHORTFALL on science_news"); other blockers may carry
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
  SYSTEM_HEALTH_CARD_ID,
  SYSTEM_HEALTH_METRICS_DIR,
  SYSTEM_HEALTH_METRIC_TEMPLATE,
  SYSTEM_HEALTH_METRIC_LEARNINGS_REL,
  REGISTERED_SYSTEM_HEALTH_METRIC_IDS,
  isRegisteredSystemHealthMetricId,
  systemHealthMetricSlug,
  metricSkillLearningPath,
  appendMetricSkillLearning,
  pageDirForCardId,
  parseSkillMd,
  sectionFromBody,
  parseLearnings,
  lastLearnings,
  isEmptyMachineLearning,
  readCardPage,
  listPageDirs,
  formatCardSkillContext,
  cardIdFromBlocker,
};
