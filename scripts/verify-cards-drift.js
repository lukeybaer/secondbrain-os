#!/usr/bin/env node
'use strict';
/**
 * verify-cards-drift.js
 *
 * DRIFT-LINT for the per-card skill system (skills/cards/). ONE table-driven
 * script iterating every card page, modeled on scripts/verify-briefing-qc-drift.js:
 * it mechanically pins ONLY what breaks the system when wrong, never prose or
 * learnings history.
 *
 * WHAT IT PINS (exit 1 on any violation):
 *   1. COVERAGE both ways: every manifest card (scripts/lib/briefing-card-manifest.js)
 *      has a page dir with SKILL.md + LEARNINGS.md, and every page dir maps back
 *      to a manifest card (the cross-cutting `briefing_shell` page is exempt
 *      from the manifest match, by design -- Codex amendment 2).
 *   2. FRONTMATTER TRUTH: `card` equals the page dir; `matcher` equals the
 *      manifest's own String(card.match). The employer-news page ExampleCos the
 *      sentinel `runtime-operator` instead (its id/matcher are built from
 *      operator identity at RUNTIME; the literal token must never live in git).
 *   3. OWNERSHIP RESOLVES: every ownership.exclusive path exists; every
 *      ownership.shared_regions {file, anchor} names an existing file whose
 *      content resolves the anchor (literal string, or /regex/ when written
 *      slash-delimited); every ownership.shared_contracts artifact path has a
 *      stable token that appears in the code corpus (ec2-server.js + scripts/
 *      + scripts/lib/ + scripts/self-heal/), so a page can never claim a data
 *      root the code does not touch.
 *   4. COMMANDS PARSE: heal + verify are commands whose script path token
 *      (scripts/....js|.mjs|.sh) exists. Leading VAR=value env assignments and
 *      <placeholder> argument tokens are allowed.
 *   5. LEARNINGS PARSEABLE: LEARNINGS.md has at least one dated `## YYYY-MM-DD`
 *      entry; SKILL.md body ExampleCos the four required headings, including
 *      `## Pinned lessons`.
 *
 * USAGE:  node scripts/verify-cards-drift.js   |   npm run verify:cards-drift
 * EXIT:   0 no drift; 1 drift (each violation printed).
 *
 * Check functions are exported pure (injectable repoRoot/skillsDir/cards) so
 * the regression test runs the lint against the real tree (passes) and against
 * temp fixture pages with a bad matcher / missing exclusive file / unresolvable
 * anchor (each fails), with no network.
 */

const fs = require('node:fs');
const path = require('node:path');

const {
  SHELL_PAGE_ID,
  EMPLOYER_PAGE_DIR,
  RUNTIME_MATCHER_SENTINEL,
  pageDirForCardId,
  parseSkillMd,
  parseLearnings,
  listPageDirs,
} = require('./lib/card-skills.js');

const REPO_ROOT = path.resolve(__dirname, '..');

const REQUIRED_BODY_HEADINGS = [
  'Clean contract',
  'Data flow',
  'Known failure modes',
  'Pinned lessons',
];

function readFileSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

// --- code corpus (for shared_contracts token checks) -------------------------

const CORPUS_DIRS = ['scripts', path.join('scripts', 'lib'), path.join('scripts', 'self-heal')];
const CORPUS_FILES = ['ec2-server.js'];

function buildCodeCorpus(repoRoot) {
  const chunks = [];
  for (const rel of CORPUS_FILES) {
    const text = readFileSafe(path.join(repoRoot, rel));
    if (text) chunks.push(text);
  }
  for (const dirRel of CORPUS_DIRS) {
    const dir = path.join(repoRoot, dirRel);
    let names = [];
    try {
      names = fs.readdirSync(dir).filter((f) => /\.(js|mjs|cjs|sh)$/.test(f));
    } catch {
      continue;
    }
    for (const name of names) {
      const text = readFileSafe(path.join(dir, name));
      if (text) chunks.push(text);
    }
  }
  return chunks.join('\n');
}

// A shared_contracts artifact path's stable search token: strip placeholder
// segments (<...>, YYYY-MM-DD, *), then take the longest remaining run of
// [A-Za-z0-9_.-] of length >= 4 from the FINAL path segment (falling back to
// any segment). "data/agent/dashboard-qc-result.json" -> "dashboard-qc-result.json";
// "data/briefings/briefing-<date>.md" -> "briefing-". Mechanical on purpose:
// code builds these paths with path.join(...) so a verbatim full-path search
// would false-fail.
function contractSearchToken(contractPath) {
  const cleaned = String(contractPath || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/YYYY-MM-DD/g, ' ')
    .replace(/\*/g, ' ');
  const segments = cleaned.split('/').filter(Boolean).reverse();
  for (const segment of segments) {
    const runs = segment.match(/[A-Za-z0-9_.-]{4,}/g) || [];
    if (runs.length) return runs.sort((a, b) => b.length - a.length)[0];
  }
  return '';
}

// --- command parsing (heal / verify) -----------------------------------------

// Parse a heal/verify command: split on whitespace, skip leading VAR=value env
// assignments, and return { runner, scriptPath, ok, reason }. The script path
// is the first token matching scripts/... with a known extension. <placeholder>
// tokens are legal arguments (the employer card's runtime id).
function parseCardCommand(command) {
  const tokens = String(command || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!tokens.length) return { ok: false, reason: 'empty command' };
  let i = 0;
  while (i < tokens.length && /^[A-Z_][A-Z0-9_]*=/.test(tokens[i])) i += 1;
  const runner = tokens[i];
  if (!runner) return { ok: false, reason: 'no runner after env assignments' };
  if (!['node', 'bash', 'sh'].includes(runner)) {
    return { ok: false, reason: `runner '${runner}' is not one of node/bash/sh` };
  }
  const scriptPath = tokens.slice(i + 1).find((t) => /^scripts\/.+\.(js|mjs|cjs|sh)$/.test(t));
  if (!scriptPath) {
    return { ok: false, reason: 'no scripts/...(js|mjs|sh) path token found' };
  }
  return { ok: true, runner, scriptPath };
}

// --- anchor resolution --------------------------------------------------------

// An anchor resolves when it appears in the file: literal substring by default,
// or as a regex when written slash-delimited (/pattern/flags).
function anchorResolves(fileText, anchor) {
  const a = String(anchor || '');
  if (!a) return false;
  const slashForm = a.match(/^\/(.+)\/([a-z]*)$/s);
  if (slashForm) {
    try {
      return new RegExp(slashForm[1], slashForm[2]).test(fileText);
    } catch {
      return false;
    }
  }
  return fileText.includes(a);
}

// --- the per-page check table -------------------------------------------------

// Each check: { name, applies(ctx), run(ctx) -> [failure strings] }. ctx is
// { pageDir, page, card, repoRoot, corpus }. `card` is null for the shell page.
const PAGE_CHECKS = [
  {
    name: 'frontmatter-present',
    applies: () => true,
    run: ({ pageDir, page }) =>
      page.frontmatter && typeof page.frontmatter === 'object'
        ? []
        : [`${pageDir}: SKILL.md frontmatter is missing or unparseable YAML.`],
  },
  {
    name: 'card-field-matches-dir',
    applies: ({ page }) => page.frontmatter,
    run: ({ pageDir, page }) =>
      String(page.frontmatter.card || '') === pageDir
        ? []
        : [
            `${pageDir}: frontmatter card '${page.frontmatter.card}' does not equal the page directory name '${pageDir}'.`,
          ],
  },
  {
    name: 'matcher-equals-manifest',
    applies: ({ page, pageDir }) => page.frontmatter && pageDir !== SHELL_PAGE_ID,
    run: ({ pageDir, page, card }) => {
      const fm = String(page.frontmatter.matcher || '');
      if (pageDir === EMPLOYER_PAGE_DIR) {
        return fm === RUNTIME_MATCHER_SENTINEL
          ? []
          : [
              `${pageDir}: matcher must be the sentinel '${RUNTIME_MATCHER_SENTINEL}' (the real matcher is built from operator identity at runtime and must never live in git).`,
            ];
      }
      if (!card) return []; // unmapped page already reported by coverage check
      const manifestMatcher = String(card.match);
      return fm === manifestMatcher
        ? []
        : [
            `${pageDir}: frontmatter matcher '${fm}' does not equal the manifest's matcher '${manifestMatcher}' for card '${card.id}'.`,
          ];
    },
  },
  {
    name: 'exclusive-files-exist',
    applies: ({ page }) => page.frontmatter,
    run: ({ pageDir, page, repoRoot }) => {
      const ownership = page.frontmatter.ownership || {};
      const exclusive = Array.isArray(ownership.exclusive) ? ownership.exclusive : [];
      return exclusive
        .filter((p) => !fs.existsSync(path.join(repoRoot, String(p))))
        .map((p) => `${pageDir}: ownership.exclusive path '${p}' does not exist.`);
    },
  },
  {
    name: 'shared-region-anchors-resolve',
    applies: ({ page }) => page.frontmatter,
    run: ({ pageDir, page, repoRoot }) => {
      const ownership = page.frontmatter.ownership || {};
      const regions = Array.isArray(ownership.shared_regions) ? ownership.shared_regions : [];
      const failures = [];
      for (const region of regions) {
        const file = String((region && region.file) || '');
        const anchor = String((region && region.anchor) || '');
        if (!file || !anchor) {
          failures.push(
            `${pageDir}: shared_regions entry must carry both file and anchor (got file='${file}', anchor='${anchor}').`,
          );
          continue;
        }
        const text = readFileSafe(path.join(repoRoot, file));
        if (text === null) {
          failures.push(`${pageDir}: shared_regions file '${file}' does not exist.`);
          continue;
        }
        if (!anchorResolves(text, anchor)) {
          failures.push(
            `${pageDir}: shared_regions anchor '${anchor}' does not resolve in '${file}' (the named function/marker moved or was renamed -- update the page).`,
          );
        }
      }
      return failures;
    },
  },
  {
    name: 'shared-contracts-in-code',
    applies: ({ page }) => page.frontmatter,
    run: ({ pageDir, page, corpus }) => {
      const ownership = page.frontmatter.ownership || {};
      const contracts = Array.isArray(ownership.shared_contracts) ? ownership.shared_contracts : [];
      const failures = [];
      for (const contract of contracts) {
        const token = contractSearchToken(contract);
        if (!token) {
          failures.push(
            `${pageDir}: shared_contracts entry '${contract}' has no searchable token (>=4 chars).`,
          );
          continue;
        }
        if (!corpus.includes(token)) {
          failures.push(
            `${pageDir}: shared_contracts entry '${contract}' (token '${token}') does not appear anywhere in the code corpus -- the claimed data root looks unreal.`,
          );
        }
      }
      return failures;
    },
  },
  {
    name: 'heal-verify-commands-parse',
    applies: ({ page }) => page.frontmatter,
    run: ({ pageDir, page, repoRoot }) => {
      const failures = [];
      for (const field of ['heal', 'verify']) {
        const command = page.frontmatter[field];
        if (!command) {
          failures.push(`${pageDir}: frontmatter '${field}' command is missing.`);
          continue;
        }
        const parsed = parseCardCommand(command);
        if (!parsed.ok) {
          failures.push(`${pageDir}: '${field}' command does not parse: ${parsed.reason}.`);
          continue;
        }
        if (!fs.existsSync(path.join(repoRoot, parsed.scriptPath))) {
          failures.push(
            `${pageDir}: '${field}' command names '${parsed.scriptPath}', which does not exist.`,
          );
        }
      }
      return failures;
    },
  },
  {
    name: 'body-headings-present',
    applies: () => true,
    run: ({ pageDir, page }) =>
      REQUIRED_BODY_HEADINGS.filter(
        (h) => !new RegExp(`^##\\s+${h}\\s*$`, 'im').test(page.body || ''),
      ).map((h) => `${pageDir}: SKILL.md body is missing the required '## ${h}' section.`),
  },
  {
    name: 'learnings-parseable',
    applies: () => true,
    run: ({ pageDir, page }) => {
      if (!page.hasLearningsFile) return [`${pageDir}: LEARNINGS.md is missing.`];
      return page.learnings.length > 0
        ? []
        : [
            `${pageDir}: LEARNINGS.md has no dated '## YYYY-MM-DD <title>' entries -- seed at least one.`,
          ];
    },
  },
];

// Read a page directly by page dir (the lint iterates dirs, not card ids).
function readPageByDir(skillsDir, pageDir) {
  const dir = path.join(skillsDir, pageDir);
  const skillText = readFileSafe(path.join(dir, 'SKILL.md'));
  const learningsText = readFileSafe(path.join(dir, 'LEARNINGS.md'));
  if (skillText === null) return null;
  const { frontmatter, body } = parseSkillMd(skillText);
  return {
    frontmatter,
    body,
    learnings: parseLearnings(learningsText || ''),
    hasLearningsFile: learningsText !== null,
  };
}

function runDrift({ repoRoot = REPO_ROOT, skillsDir, cards } = {}) {
  const resolvedSkillsDir = skillsDir || path.join(repoRoot, 'skills', 'cards');
  const manifestCards = cards || require('./lib/briefing-card-manifest.js').CARDS;
  const failures = [];

  const pageDirs = listPageDirs({ skillsDir: resolvedSkillsDir });
  const expectedDirs = new Map(); // pageDir -> manifest card
  for (const card of manifestCards) expectedDirs.set(pageDirForCardId(card.id), card);

  // 1a. every manifest card has a page.
  for (const [dir, card] of expectedDirs) {
    if (!pageDirs.includes(dir)) {
      failures.push(
        `manifest card '${card.id}' has no page at skills/cards/${dir}/ (SKILL.md + LEARNINGS.md required).`,
      );
    }
  }
  // 1b. the shell page itself must exist.
  if (!pageDirs.includes(SHELL_PAGE_ID)) {
    failures.push(
      `the cross-cutting page skills/cards/${SHELL_PAGE_ID}/ is missing (it owns the shared chokepoints; Codex amendment 2).`,
    );
  }
  // 1c. every page dir maps back to a manifest card or is the shell page.
  for (const dir of pageDirs) {
    if (dir !== SHELL_PAGE_ID && !expectedDirs.has(dir)) {
      failures.push(
        `page skills/cards/${dir}/ maps to no manifest card (stale page or typo'd id -- the manifest is the runtime truth).`,
      );
    }
  }

  // 2. per-page table-driven checks.
  const corpus = buildCodeCorpus(repoRoot);
  for (const pageDir of pageDirs) {
    const page = readPageByDir(resolvedSkillsDir, pageDir);
    if (!page) {
      failures.push(`page skills/cards/${pageDir}/ has no readable SKILL.md.`);
      continue;
    }
    const ctx = { pageDir, page, card: expectedDirs.get(pageDir) || null, repoRoot, corpus };
    for (const check of PAGE_CHECKS) {
      if (!check.applies(ctx)) continue;
      failures.push(...check.run(ctx));
    }
  }

  return { ok: failures.length === 0, failures, pageDirs };
}

function main() {
  const result = runDrift();
  if (result.ok) {
    console.log(
      `cards drift-lint PASS: ${result.pageDirs.length} pages under skills/cards/ (every manifest card + ${SHELL_PAGE_ID}), frontmatter matchers equal the manifest, ownership anchors resolve, heal/verify commands parse, learnings parseable.`,
    );
    process.exit(0);
  }
  console.error(`cards drift-lint FAILED: ${result.failures.length} drift issue(s):`);
  for (const f of result.failures) console.error('  - ' + f);
  process.exit(1);
}

module.exports = {
  runDrift,
  readPageByDir,
  parseCardCommand,
  anchorResolves,
  contractSearchToken,
  buildCodeCorpus,
  PAGE_CHECKS,
  REQUIRED_BODY_HEADINGS,
};

if (require.main === module) main();
