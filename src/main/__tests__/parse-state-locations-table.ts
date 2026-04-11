/**
 * parse-state-locations-table.ts
 *
 * Helper that parses the "State locations" markdown table out of
 * memory/MEMORY.md into structured rows. Used by tier1-discipline.test.ts
 * to enforce that the table matches git + disk reality.
 *
 * The table format is:
 *   ## State locations (where Amy state actually lives)
 *
 *   | What | Where | Tracked |
 *   | ---- | ----- | ------- |
 *   | Row name | `path1` | git |
 *   | Other | `path2` plus `path3` | git via hardlink |
 *
 * Where may contain multiple backtick-wrapped paths (e.g. the "hardlinked
 * to" rows). The parser extracts ALL of them so the test can verify each
 * one exists on disk.
 */

export interface StateRow {
  what: string;
  whereRaw: string;
  paths: string[];
  tracked: string;
}

export function parseStateLocationsTable(src: string): StateRow[] {
  const startIdx = src.indexOf('## State locations');
  if (startIdx === -1) {
    throw new Error('parseStateLocationsTable: "## State locations" section not found in input');
  }
  const rest = src.slice(startIdx);
  const endIdx = rest.indexOf('\n## ', 1);
  const section = endIdx === -1 ? rest : rest.slice(0, endIdx);

  const rows: StateRow[] = [];
  for (const rawLine of section.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('|')) continue;

    // Split into cells, drop leading/trailing empty from the edge pipes
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());

    if (cells.length < 3) continue;

    const [what, whereRaw, tracked] = cells;

    // Skip header ("| What | Where | Tracked |") and separator ("| ---- | ---- | ---- |")
    if (/^-+$/.test(what) || /^What$/i.test(what)) continue;

    // Extract every `...` span from the Where column
    const paths: string[] = [];
    const pathRegex = /`([^`]+)`/g;
    let match: RegExpExecArray | null;
    while ((match = pathRegex.exec(whereRaw)) !== null) {
      paths.push(match[1]);
    }

    rows.push({ what, whereRaw, paths, tracked });
  }

  return rows;
}

/**
 * Classify the "Tracked" column value into one of a few buckets the test
 * cares about. Anything with "needs migration" is a hard fail.
 */
export type TrackedKind =
  | 'git-direct' // plain "git" — path must be in git ls-files
  | 'git-linked' // "git via hardlink/symlink" — resolves to a tracked path via a link
  | 'local-ephemeral' // local (ephemeral, acceptable) — don't validate content
  | 'remote' // ec2 or ec2 docker — can't validate from local disk
  | 'pending-migration' // hard fail, table is lying
  | 'unknown';

export function classifyTracked(tracked: string): TrackedKind {
  const t = tracked.toLowerCase().replace(/\*/g, '').trim();
  if (/needs migration/.test(t)) return 'pending-migration';
  if (/ephemeral|acceptable|historical/.test(t)) return 'local-ephemeral';
  if (/ec2/.test(t)) return 'remote';
  if (/git via (hardlink|symlink|junction)/.test(t)) return 'git-linked';
  if (/^git$/.test(t)) return 'git-direct';
  return 'unknown';
}
