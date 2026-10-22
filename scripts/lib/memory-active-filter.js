// memory-active-filter.js
//
// Shared predicate: is a memory file ACTIVE (should flow into prompts,
// Graphiti seeding, and memory search) or retired (archived on disk, or
// marked superseded/stub in frontmatter)?
//
// This is the single contract for supersession. Consumers:
//   - src/main/memory-sync.ts        (prompt/context loading + Graphiti sync)
//   - scripts/seed-graphiti.ts       (one-shot Graphiti seeding)
//   - scripts/amy-memory-query.js    (substring/query search fallback)
//
// Pure CJS, no dependencies. Keep it that way, since it is required from
// both Node scripts and the Electron main process.

'use strict';

/**
 * Path-level check. False when the path points into an archive directory
 * under memory/. Accepts absolute paths, repo-relative paths
 * (memory/archive/x.md), and memory-dir-relative paths (archive/x.md),
 * with either slash style.
 *
 * Rules:
 *  - If the path has a "memory" segment: inactive when an "archive"
 *    segment appears after it.
 *  - If it has no "memory" segment (caller passed a path relative to the
 *    memory dir): inactive when any "archive" segment appears.
 * Segment matching is exact, so "life-archive" and "archived-notes" do
 * not match.
 */
function isActiveMemoryPath(relOrAbsPath) {
  if (typeof relOrAbsPath !== 'string' || !relOrAbsPath) return true;
  const segments = relOrAbsPath
    .replace(/\\/g, '/')
    .split('/')
    .map((s) => s.toLowerCase())
    .filter(Boolean);
  const memoryIdx = segments.indexOf('memory');
  const searchFrom = memoryIdx >= 0 ? memoryIdx + 1 : 0;
  return !segments.includes('archive', searchFrom);
}

/**
 * Content-level check. Parses the YAML frontmatter block when present.
 * False when frontmatter declares status: superseded, status: archived,
 * or stub: true. True otherwise. A file with no frontmatter is ACTIVE
 * (never silently drop unrelated files).
 */
function isActiveMemoryContent(content) {
  if (typeof content !== 'string') return true;
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!fmMatch) return true;
  const fm = fmMatch[1];
  if (/^status:\s*['"]?(superseded|archived)['"]?\s*$/im.test(fm)) return false;
  if (/^stub:\s*['"]?true['"]?\s*$/im.test(fm)) return false;
  return true;
}

/** Combined check: active path AND active content. */
function isActiveMemory(filePath, content) {
  return isActiveMemoryPath(filePath) && isActiveMemoryContent(content);
}

module.exports = { isActiveMemoryPath, isActiveMemoryContent, isActiveMemory };
