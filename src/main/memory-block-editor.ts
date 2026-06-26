// memory-block-editor.ts
//
// Verbatim, line-targeted edits for core memory blocks, with all-or-nothing
// batch application. Modeled on Letta's memory_replace / memory_insert /
// memory_finish_edits tools.
//
// THE GAP THIS FILLS
//   core-memory-blocks.ts exposes only writeBlock (whole-block overwrite,
//   hard-throws at content.length > limit) and appendBlock (blind append, no
//   targeting). memory-tool-use.ts surfaces memory_write_block whose own
//   description says "Overwrite a named core memory block with new content."
//   To change ONE fact in the 2000-char `human` block the model must regenerate
//   the entire block, and routinely drops or mangles unrelated facts doing so.
//   Every structured block (persona, human, scratchpad) ExampleCos this silent-
//   drop risk on every edit.
//
//   Letta engineered against exactly this: memory_replace requires old_string
//   to appear VERBATIM and UNIQUELY; zero matches and multiple matches both
//   raise (never a silent wrong edit). memory_insert places a line at an
//   addressed position. memory_finish_edits closes a batch so a sequence of
//   edits is treated as one transactional unit.
//
// SOURCES (research 2026-06-16)
//   - Letta base.py memory tools (memory_replace / memory_insert /
//     memory_finish_edits)  https://github.com/letta-ai/letta
//   - Letta memory blocks  https://www.letta.com/blog/memory-blocks
//
// DESIGN
//   Pure string transforms. No fs, no electron. The caller persists the
//   returned content exactly once via core-memory-blocks.writeBlock, so block
//   I/O, locking (memory-write-lease) and dedup (memory-write-deduplicator)
//   stay in their existing homes. Uniqueness is resolved with a two-index probe
//   (indexOf + indexOf-from-next) rather than a regex, so regex metacharacters
//   in the target never cause a false match.

// ── Errors ─────────────────────────────────────────────────────────────────

export type MemoryEditCode = 'NO_MATCH' | 'AMBIGUOUS' | 'OVER_LIMIT' | 'EMPTY_TARGET';

export class MemoryEditError extends Error {
  constructor(
    public code: MemoryEditCode,
    message: string,
  ) {
    super(message);
    this.name = 'MemoryEditError';
  }
}

// ── Results / batch ──────────────────────────────────────────────────────────

export interface BlockEditResult {
  content: string; // new full block content (caller persists)
  changed: boolean;
  matchedLine?: number; // 1-based line of the edit, for audit logging
}

export interface BlockEdit {
  kind: 'replace' | 'insert';
  oldString?: string; // required for replace
  newString: string;
  insertLine?: number; // for insert: 0 = top, -1 or omitted = end
}

// ── Display ────────────────────────────────────────────────────────────────

/**
 * Render a block with 1-based line-number prefixes for the LLM. The numbers are
 * DISPLAY ONLY; edit tools strip any such prefix from incoming text so the
 * model cannot accidentally write "12: foo" into the block.
 */
export function renderWithLineNumbers(content: string): string {
  return content
    .split('\n')
    .map((line, i) => `${i + 1}: ${line}`)
    .join('\n');
}

const stripLineNumberPrefixes = (s: string): string => s.replace(/^\s*\d+:\s?/gm, '');

// ── Single edits ─────────────────────────────────────────────────────────────

/**
 * Verbatim find-and-replace. `oldString` must appear exactly once.
 * Throws NO_MATCH on zero occurrences, AMBIGUOUS on more than one, OVER_LIMIT
 * if the result would exceed the block's byte limit. Never edits on ambiguity.
 */
export function memoryReplace(
  content: string,
  oldString: string,
  newString: string,
  limit: number,
): BlockEditResult {
  if (oldString === '') {
    throw new MemoryEditError('EMPTY_TARGET', 'old_string must not be empty');
  }
  const idx = content.indexOf(oldString);
  if (idx === -1) {
    throw new MemoryEditError('NO_MATCH', 'old_string did not appear verbatim in the block');
  }
  if (content.indexOf(oldString, idx + 1) !== -1) {
    throw new MemoryEditError(
      'AMBIGUOUS',
      'old_string appears multiple times; add surrounding context to make it unique',
    );
  }
  const next = content.slice(0, idx) + newString + content.slice(idx + oldString.length);
  if (next.length > limit) {
    throw new MemoryEditError('OVER_LIMIT', `result ${next.length} exceeds limit ${limit}`);
  }
  const matchedLine = content.slice(0, idx).split('\n').length;
  return { content: next, changed: next !== content, matchedLine };
}

/**
 * Insert a line after the given 1-based line. 0 = top of block, -1 or omitted =
 * append at end. Any line-number prefix in `newString` is stripped first.
 */
export function memoryInsert(
  content: string,
  newString: string,
  insertLine: number = -1,
  limit: number = Number.POSITIVE_INFINITY,
): BlockEditResult {
  const clean = stripLineNumberPrefixes(newString);
  const lines = content === '' ? [] : content.split('\n');
  const at = insertLine < 0 ? lines.length : Math.min(insertLine, lines.length);
  lines.splice(at, 0, clean);
  const next = lines.join('\n');
  if (next.length > limit) {
    throw new MemoryEditError('OVER_LIMIT', `result ${next.length} exceeds limit ${limit}`);
  }
  return { content: next, changed: true, matchedLine: at + 1 };
}

// ── Batch (memory_finish_edits semantics) ────────────────────────────────────

/**
 * Apply all edits against an in-memory copy and return the final content only
 * if EVERY edit succeeds. If any edit throws, nothing is returned and the
 * caller persists nothing, so the on-disk block is never left half-edited.
 * This is the transactional boundary Letta's memory_finish_edits provides.
 */
export function applyEditBatch(
  content: string,
  edits: BlockEdit[],
  limit: number,
): { content: string; applied: number } {
  let cur = content;
  for (const e of edits) {
    if (e.kind === 'replace') {
      if (e.oldString === undefined) {
        throw new MemoryEditError('EMPTY_TARGET', 'replace edit requires old_string');
      }
      cur = memoryReplace(cur, e.oldString, e.newString, limit).content;
    } else {
      cur = memoryInsert(cur, e.newString, e.insertLine ?? -1, limit).content;
    }
  }
  return { content: cur, applied: edits.length };
}
