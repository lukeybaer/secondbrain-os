/**
 * parse-full-life-backup.js
 *
 * Parses the FULL-LIFE DATA BACKUP body emitted by refresh-briefing-
 * generated-sections.js into structured items the dashboard can render as
 * System Health chips. Each source line looks like:
 *
 *   Gmail: 79.1% complete; count 12944 today vs 12944 yesterday (+0); raw 0;
 *     indexed 12944 (100.0%); S3 7815; blockers: Gmail backfill 62450/78987.
 *
 * 2026-05-24 ExampleCo ask: "Full life data backup card looks like crap, use the
 * nicer format like health checks. actually consolidate with health checks
 * so it's just one of them." So the parser shapes items the same way
 * parseSystemHealthBody does (name, status, detail) so they can be merged.
 */
'use strict';

const COMPLETE_PCT_FLOOR_GREEN = 95;
const COMPLETE_PCT_FLOOR_YELLOW = 60;

function classifyStatus(completePct, blockersText, sourceStatus) {
  if (String(sourceStatus || '').toUpperCase() === 'MISSING') return 'red';
  const pct = Number(completePct);
  const hasBlocker = !!blockersText && blockersText !== 'none';
  if (!Number.isFinite(pct)) return hasBlocker ? 'red' : 'yellow';
  if (pct < COMPLETE_PCT_FLOOR_YELLOW) return 'red';
  if (pct < COMPLETE_PCT_FLOOR_GREEN) return 'yellow';
  if (hasBlocker) return 'yellow';
  return 'green';
}

// Source line examples (from briefing-2026-05-24.md):
//   "  Gmail: 79.1% complete; count 12944 today vs 12944 yesterday (+0); raw 0; indexed 12944 (100.0%); S3 7815; blockers: Gmail backfill 62450/78987."
//   "  Otter: 100.0% complete; count 231 today vs 56 yesterday (+175); raw 231; indexed 231 (100.0%); S3 231; blockers: none."
function parseSourceLine(line) {
  const m = line.match(/^\s*([A-Za-z][^:]*?):\s*([\d.]+)%\s*complete;\s*(.+)$/);
  if (!m) return null;
  const rawName = m[1].trim();
  const completePct = parseFloat(m[2]);
  const rest = m[3].trim();
  const blockersM = rest.match(/blockers:\s*(.*?)\.?$/i);
  const blockersText = blockersM ? blockersM[1].trim() : '';
  const status = classifyStatus(completePct, blockersText);
  // Friendly display name -- the briefing already uses short labels, but
  // keep a "Life: " prefix so chips in the System Health tile are visually
  // distinguishable from the original system probes.
  return {
    name: `Life: ${rawName}`,
    rawSourceName: rawName,
    status,
    detail: rest.replace(/\.$/, ''),
    completePct,
    blockers: blockersText && blockersText !== 'none' ? blockersText : '',
    source: 'fullLifeBackup',
  };
}

function parseFullLifeBackupBody(body) {
  const items = [];
  const lines = String(body || '').split('\n');
  for (const line of lines) {
    if (/^\s*(?:Data refreshed|Overall|Status)/i.test(line)) continue;
    const item = parseSourceLine(line);
    if (item) items.push(item);
  }
  // Overall summary line: "Overall: 10/11 source types at ~100% durable completion; 7/11 flowed in the last 24h; 0 missing."
  const overallMatch = body.match(/^\s*Overall:\s*(.+)$/m);
  const overall = overallMatch ? overallMatch[1].trim() : '';
  const reds = items.filter((i) => i.status === 'red');
  const yellows = items.filter((i) => i.status === 'yellow');
  return { kind: 'fullLifeBackup', items, overall, reds, yellows };
}

// Merge fullLifeBackup items into the systemHealth section's items list,
// dedupe by name (systemHealth wins on conflict), and return the modified
// sections array with the standalone fullLifeBackup section removed.
//
// 2026-06-20 defect + fix: the merge previously dropped the standalone
// FULL-LIFE DATA BACKUP tile whenever BOTH sections were present, EVEN when the
// life body parsed to ZERO items (a degraded cloud body like "Status: no backup
// gap surfaced ...") -- so the card produced no System Health "Life:" chips AND
// no standalone tile, vanishing entirely. A markdown-only QC still passed. The
// guard now keeps the standalone tile when there is nothing to merge, so the
// card never silently disappears: it merges only when it has real Life: chips to
// contribute; otherwise it stays visible with its honest status text.
function mergeFullLifeBackupIntoSystemHealth(sections) {
  if (!Array.isArray(sections)) return sections;
  const out = [];
  const sysIdx = sections.findIndex((s) => s && s.data && s.data.kind === 'systemHealth');
  const lifeIdx = sections.findIndex((s) => s && s.data && s.data.kind === 'fullLifeBackup');
  if (sysIdx < 0 || lifeIdx < 0) return sections;
  const life = sections[lifeIdx].data || { items: [] };
  const sys = sections[sysIdx].data || { items: [] };
  const seen = new Set((sys.items || []).map((it) => String(it.name).toLowerCase()));
  const newItems = (life.items || []).filter((it) => !seen.has(String(it.name).toLowerCase()));
  // Nothing to merge -> do NOT drop the standalone tile. Returning the sections
  // unchanged keeps FULL-LIFE DATA BACKUP rendering as its own (honest-status)
  // tile instead of evaporating into a System Health that gained no chips.
  if (newItems.length === 0) return sections;
  const merged = { ...sys, items: [...(sys.items || []), ...newItems] };
  // Recompute reds/yellows from the union.
  merged.reds = (merged.items || []).filter((it) => it.status === 'red');
  merged.yellows = (merged.items || []).filter((it) => it.status === 'yellow');
  for (let i = 0; i < sections.length; i += 1) {
    if (i === lifeIdx) continue; // drop standalone life-backup tile
    if (i === sysIdx) {
      out.push({ ...sections[i], data: merged });
    } else {
      out.push(sections[i]);
    }
  }
  return out;
}

module.exports = {
  parseFullLifeBackupBody,
  mergeFullLifeBackupIntoSystemHealth,
  classifyStatus,
  parseSourceLine,
};
