'use strict';
//
// core-component-registry.js -- the ONE parser for the machine-readable
// CORE COMPONENTS registry block in memory/MEMORY.md.
//
// The registry itself is DATA and lives only in MEMORY.md (single source of
// truth; no keyword list is duplicated in code). This module is the only code
// that understands the row format:
//
//   <component-id> | <keyword, keyword, ...> | dev-plans/core/<file>.md
//
// Consumers:
//   - scripts/claude-hooks/core-component-router.mjs (UserPromptSubmit): match
//     the prompt against keywords, inject doc path + LESSONS + Rules of the
//     road for up to MAX_MATCHES components.
//   - scripts/verify-core-registry-drift.js (lint): every dev-plans/core doc
//     has a registry row and vice versa, and every row path exists.
//
// Zero deps (pure functions) so it loads in any worktree and in the hook's
// 5s budget.

const REGISTRY_HEADING_RE = /^##\s+CORE COMPONENTS\b.*$/;
const ROW_RE =
  /^([a-z0-9][a-z0-9-]*)\s*\|\s*([^|]+?)\s*\|\s*(dev-plans\/core\/[A-Za-z0-9._-]+\.md)\s*$/;

// How many components a single prompt may route to. Two keeps the injection
// bounded (never a wall of every doc) while covering cross-component work
// like "the briefing card for otter speakers".
const MAX_MATCHES = 2;

// Verbatim-injection budget for a doc's "## Rules of the road" section. The
// docs are large (briefing.md is 68KB); the router must NEVER inject a whole
// doc, so the safety section is hard-capped.
const RULES_CAP_BYTES = 2048;
const HEAD_FALLBACK_LINES = 15;

/**
 * Parse the registry block out of the full MEMORY.md text.
 * Returns { rows, found } where rows = [{ id, keywords, docPath }].
 * Rows are returned in file order (which is also match tie-break order).
 */
function parseRegistryBlock(memoryText) {
  const lines = String(memoryText || '')
    .replace(/\r\n/g, '\n')
    .split('\n');
  const start = lines.findIndex((l) => REGISTRY_HEADING_RE.test(l));
  if (start === -1) return { rows: [], found: false };

  const rows = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s/.test(line)) break; // next section ends the block
    const m = line.match(ROW_RE);
    if (!m) continue;
    const keywords = m[2]
      .split(',')
      .map((k) => k.trim().toLowerCase())
      .filter(Boolean);
    if (keywords.length === 0) continue;
    rows.push({ id: m[1], keywords, docPath: m[3] });
  }
  return { rows, found: true };
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Does the prompt contain this keyword at a word START? The left boundary is
 * strict ("card" never matches "discard"); the right side allows trailing
 * word characters so a keyword is a stem: "blocker" matches "blockers",
 * "deploy" matches "deployment", "diariz" matches "diarization".
 */
function keywordHits(promptLower, keyword) {
  const re = new RegExp('(^|[^a-z0-9])' + escapeRegExp(keyword), 'i');
  return re.test(promptLower);
}

/**
 * Match a prompt against registry rows. Returns up to maxMatches rows,
 * ordered by number of distinct keyword hits (desc), registry order on ties.
 */
function matchComponents(prompt, rows, maxMatches = MAX_MATCHES) {
  const promptLower = String(prompt || '').toLowerCase();
  if (!promptLower.trim()) return [];
  const scored = [];
  for (let i = 0; i < (rows || []).length; i++) {
    const row = rows[i];
    const hits = row.keywords.filter((k) => keywordHits(promptLower, k)).length;
    if (hits > 0) scored.push({ row, hits, order: i });
  }
  scored.sort((a, b) => b.hits - a.hits || a.order - b.order);
  return scored.slice(0, maxMatches).map((s) => s.row);
}

/**
 * Extract the doc's "## Rules of the road" section verbatim (capped at
 * capBytes). Falls back to the first HEAD_FALLBACK_LINES lines when the doc
 * has no such section. Never returns the whole doc.
 * Returns { text, source: 'rules-of-the-road' | 'head', truncated }.
 */
function extractRulesOfTheRoad(docText, capBytes = RULES_CAP_BYTES) {
  const norm = String(docText || '').replace(/\r\n/g, '\n');
  const lines = norm.split('\n');
  const start = lines.findIndex((l) => /^##\s+Rules of the road\s*$/i.test(l));
  let text;
  let source;
  if (start !== -1) {
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (/^##\s/.test(lines[i])) {
        end = i;
        break;
      }
    }
    text = lines.slice(start, end).join('\n').trim();
    source = 'rules-of-the-road';
  } else {
    text = lines.slice(0, HEAD_FALLBACK_LINES).join('\n').trim();
    source = 'head';
  }
  let truncated = false;
  if (Buffer.byteLength(text, 'utf8') > capBytes) {
    text = Buffer.from(text, 'utf8').subarray(0, capBytes).toString('utf8');
    // Drop a possibly split trailing multi-byte char artifact.
    text = text.replace(/�+$/, '');
    truncated = true;
  }
  return { text, source, truncated };
}

module.exports = {
  parseRegistryBlock,
  matchComponents,
  extractRulesOfTheRoad,
  MAX_MATCHES,
  RULES_CAP_BYTES,
  HEAD_FALLBACK_LINES,
};
