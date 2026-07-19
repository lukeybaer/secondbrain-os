'use strict';
//
// gravity-registry.js -- the ONE parser for the machine-readable LAWS block
// in memory/AMY_GRAVITY.md (the Laws of Amy Gravity derived enforcement
// index).
//
// The laws are DATA and live only in AMY_GRAVITY.md; this module is the only
// code that understands the row format:
//
//   id | law | auth:<file> | kw:<k1,k2,...> | enf:<tok; tok; ...> | STATUS
//
// Consumers:
//   - scripts/claude-hooks/gravity-router.mjs (UserPromptSubmit, GLOBAL
//     settings): inject the never-list core on every prompt plus up to
//     MAX_MATCHES keyword-matched laws.
//   - scripts/verify-gravity-drift.js (lint, run by core.test.js on every
//     land): every enforcement token resolves to a real, WIRED mechanism, so
//     a law cannot silently decay to memory-only (law g0 mechanized).
//   - scripts/claude-hooks/gravity-lock.mjs (amendment protocol).
//
// Zero deps, same discipline as core-component-registry.js.

const LAWS_HEADING_RE = /^##\s+LAWS\b.*$/;
const NEVER_LIST_HEADING_RE = /^##\s+NEVER-LIST CORE\b.*$/;
const ROW_RE =
  /^(g\d+)\s*\|\s*([^|]+?)\s*\|\s*auth:([^|]+?)\s*\|\s*kw:([^|]+?)\s*\|\s*enf:([^|]+?)\s*\|\s*([A-Z]+)\s*$/;

const STATUSES = ['SOLID', 'PARTIAL', 'POLICY', 'PROPOSED'];
const TOKEN_TYPES = ['test', 'hook', 'npm', 'lib', 'script', 'policy', 'registry', 'ledger'];
const MAX_LAWS = 45;
const MAX_MATCHES = 2;

/**
 * Parse the LAWS block. Returns { rows, found } where each row is
 * { id, law, authority, keywords, enforcement, status, line }.
 * enforcement = [{ type, value, scope }] (scope only for hook tokens).
 */
function parseGravityBlock(text) {
  const lines = String(text || '')
    .replace(/\r\n/g, '\n')
    .split('\n');
  const start = lines.findIndex((l) => LAWS_HEADING_RE.test(l));
  if (start === -1) return { rows: [], found: false, strayLines: [] };

  const rows = [];
  // Codex review 75636d17f4b1: a mangled row (e.g. a formatter rewriting
  // __tests__ as bold) used to vanish silently from routing and linting.
  // Any nonblank, non-fence line inside the LAWS block that does not parse
  // as a row is now surfaced as a stray for the drift lint to reject.
  const strayLines = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s/.test(line)) break;
    const m = line.match(ROW_RE);
    if (!m) {
      if (line.trim() && !/^`{3,}\s*$/.test(line.trim())) {
        strayLines.push({ line: i + 1, text: line.slice(0, 120) });
      }
      continue;
    }
    const keywords = m[4]
      .split(',')
      .map((k) => k.trim().toLowerCase())
      .filter(Boolean);
    const enforcement = m[5]
      .split(';')
      .map((t) => t.trim())
      .filter(Boolean)
      .map(parseEnforcementToken);
    rows.push({
      id: m[1],
      law: m[2].trim(),
      authority: m[3].trim(),
      keywords,
      enforcement,
      status: m[6].trim(),
      line: i + 1,
    });
  }
  return { rows, found: true, strayLines };
}

/**
 * Parse the machine-read ratified row count from the laws file preamble
 * ("Ratified rows: N"). Returns null when absent. The drift lint compares it
 * against the parsed row count so a silently vanished or duplicated law can
 * never land green; amendments update the count and the rows together under
 * the same approval.
 */
function parseRatifiedCount(text) {
  const m = String(text || '').match(/^Ratified rows:\s*(\d+)\s*$/m);
  return m ? Number(m[1]) : null;
}

/** 'hook:outbound-send-guard.mjs@user' -> { type, value, scope } */
function parseEnforcementToken(token) {
  const idx = token.indexOf(':');
  if (idx === -1) return { type: 'invalid', value: token, scope: null };
  const type = token.slice(0, idx).trim();
  let value = token.slice(idx + 1).trim();
  let scope = null;
  if (type === 'hook') {
    const at = value.lastIndexOf('@');
    if (at !== -1) {
      scope = value.slice(at + 1).trim();
      value = value.slice(0, at).trim();
    }
  }
  return { type, value, scope };
}

/** Extract the never-list core ExampleCoraph (between its heading and the next ##). */
function extractNeverListCore(text) {
  const lines = String(text || '')
    .replace(/\r\n/g, '\n')
    .split('\n');
  const start = lines.findIndex((l) => NEVER_LIST_HEADING_RE.test(l));
  if (start === -1) return '';
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines
    .slice(start + 1, end)
    .join('\n')
    .trim();
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Same word-start stem matching as the core-component registry. */
function keywordHits(promptLower, keyword) {
  const re = new RegExp('(^|[^a-z0-9])' + escapeRegExp(keyword), 'i');
  return re.test(promptLower);
}

/** Top maxMatches law rows for a prompt, by distinct keyword hits then file order. */
function matchLaws(prompt, rows, maxMatches = MAX_MATCHES) {
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

module.exports = {
  parseGravityBlock,
  parseEnforcementToken,
  parseRatifiedCount,
  extractNeverListCore,
  matchLaws,
  STATUSES,
  TOKEN_TYPES,
  MAX_LAWS,
  MAX_MATCHES,
};
