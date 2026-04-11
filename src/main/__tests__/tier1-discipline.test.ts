/**
 * tier1-discipline.test.ts
 *
 * Regression guard for the Tier 1 memory entry point (MEMORY.md) and the
 * state locations reference. If MEMORY.md drifts from pointers to content,
 * or loses a required section, or stops linking at a canonical file, or
 * reference_amy_state_locations.md stops enumerating a known state dir,
 * CI fails.
 *
 * Root cause this test prevents: the 2026-04-10 regression where Tier 1
 * became 91 lines of flat topic index instead of a pointer file with a
 * state locations map, so every new session rediscovered the filesystem
 * from scratch and missed Documents/Claude/Scheduled/ entirely.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { parseStateLocationsTable, classifyTracked, StateRow } from './parse-state-locations-table';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const MEMORY_MD = path.resolve(REPO_ROOT, 'memory', 'MEMORY.md');
const STATE_LOCATIONS = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'memory',
  'reference_amy_state_locations.md',
);

describe('MEMORY.md Tier 1 discipline', () => {
  let src: string;
  let lineCount: number;

  beforeAll(() => {
    src = fs.readFileSync(MEMORY_MD, 'utf-8');
    lineCount = src.split('\n').length;
  });

  it('file exists', () => {
    expect(fs.existsSync(MEMORY_MD)).toBe(true);
  });

  it('stays under 200 lines (pointer discipline)', () => {
    // Target is ~150 but 200 gives headroom for active schedules + anti-patterns
    expect(lineCount).toBeLessThanOrEqual(200);
  });

  it('opens with "You are Amy" identity framing', () => {
    const firstThreeKB = src.slice(0, 3000);
    expect(firstThreeKB).toMatch(/You are Amy/i);
  });

  it('declares same brain as Claude Code', () => {
    expect(src).toMatch(/same brain as Claude Code/i);
  });

  it('lists the three non-negotiable simple needs', () => {
    expect(src).toMatch(/three non-negotiable needs/i);
    expect(src).toContain('One Amy');
    expect(src).toContain('Git-tracked');
    expect(src).toContain('Zero permission prompts');
  });

  it('contains the State locations table', () => {
    expect(src).toMatch(/## State locations/);
    expect(src).toContain('secondbrain/memory/');
    expect(src).toContain('secondbrain/memory/contacts/');
    expect(src).toContain('Graphiti');
  });

  it('contains the audit command', () => {
    expect(src).toMatch(/Audit command/i);
    expect(src).toMatch(/find C:\/Users\/luked/);
  });

  it('links at the 4 canonical Amy docs', () => {
    expect(src).toContain('AMY_REQUIREMENTS.md');
    expect(src).toContain('AMY_FOUNDATION_REFLECTION.md');
    expect(src).toContain('AMY_DEEP_RESEARCH.md');
    expect(src).toContain('AMY_REBUILD_PLAN.md');
  });

  it('links at project_briefing_spec.md and the locked architecture files', () => {
    expect(src).toContain('project_briefing_spec.md');
    expect(src).toContain('project_secondbrain_architecture.md');
    expect(src).toContain('project_secondbrain_requirements.md');
  });

  it('documents all 4 critical hashtag hooks', () => {
    expect(src).toContain('#learn');
    expect(src).toContain('#gap');
    expect(src).toContain('#ppl');
    expect(src).toMatch(/#inbox|#mail/);
  });

  it('documents the active schedules section', () => {
    expect(src).toMatch(/## Active schedules/);
    expect(src).toMatch(/5:30 AM CT.*[Bb]riefing/);
    expect(src).toMatch(/[Oo]tter.*2 min|2 min.*[Oo]tter/);
  });

  it('documents the subagents-preferred rule', () => {
    expect(src).toMatch(/[Ss]ubagents preferred/i);
    expect(src).toMatch(/[Qq]uarterback/);
  });

  it('documents the learning cascade', () => {
    expect(src).toMatch(/[Ll]earning [Cc]ascade/);
    expect(src).toContain('ruthless');
  });

  it('documents anti-patterns section', () => {
    expect(src).toMatch(/## Anti-patterns/);
    expect(src).toMatch(/[Nn]ever grep/);
  });

  it('ends with "If you read nothing else" load-order directive', () => {
    const lastTwoKB = src.slice(-2000);
    expect(lastTwoKB).toMatch(/If you read nothing else/i);
  });
});

describe('MEMORY.md State locations table is a contract, not a description', () => {
  let src: string;
  let rows: StateRow[];
  // Cache git ls-files output once at the describe level. Subprocess calls
  // inside every it() block cause the test to time out at 5s when vitest
  // runs this file in parallel with the other 25 suites on Windows. Cache
  // once, membership-test in-memory.
  let gitIndex: Set<string>;

  beforeAll(() => {
    src = fs.readFileSync(MEMORY_MD, 'utf-8');
    rows = parseStateLocationsTable(src);
    const lsOutput = execSync('git ls-files', { cwd: REPO_ROOT }).toString();
    gitIndex = new Set(lsOutput.split('\n').filter((l) => l.length > 0));
  });

  it('parses at least 15 rows out of the State locations table', () => {
    // If this falls below 15 the table has been gutted and someone should notice
    expect(rows.length).toBeGreaterThanOrEqual(15);
  });

  it('NO row is flagged pending migration (table must reflect reality)', () => {
    const pending = rows.filter((r) => classifyTracked(r.tracked) === 'pending-migration');
    if (pending.length > 0) {
      const lines = pending.map((r) => `  - "${r.what}" — tracked="${r.tracked}"`).join('\n');
      throw new Error(
        `State locations table has ${pending.length} row(s) flagged "needs migration":\n${lines}\n\n` +
          `Either finish the migration, or update the Tracked column to reflect reality.\n` +
          `This test is the guard from plans/dazzling-rolling-moler.md #gap response: commit messages must match the State table.`,
      );
    }
  });

  it('every tracked row references at least one resolvable path', () => {
    const trackedRows = rows.filter((r) => {
      const kind = classifyTracked(r.tracked);
      return kind === 'git-direct' || kind === 'git-linked';
    });

    const failures: string[] = [];
    for (const row of trackedRows) {
      if (row.paths.length === 0) {
        failures.push(`"${row.what}": Where column has no backtick-wrapped path`);
        continue;
      }

      // For each path in the row, try to resolve it. At least ONE must exist.
      let anyExists = false;
      const attempts: string[] = [];
      for (const raw of row.paths) {
        const resolved = resolveStateTablePath(raw);
        if (resolved === null) {
          attempts.push(`${raw} (skipped — not a local path)`);
          continue;
        }
        if (pathOrGlobExists(resolved)) {
          anyExists = true;
          break;
        }
        attempts.push(`${raw} -> ${resolved} (missing)`);
      }
      if (!anyExists) {
        failures.push(
          `"${row.what}": no path in Where column exists on disk — tried:\n      ${attempts.join('\n      ')}`,
        );
      }
    }

    if (failures.length > 0) {
      throw new Error(
        `State locations table has ${failures.length} tracked row(s) whose paths do not exist on disk:\n  - ${failures.join('\n  - ')}\n\n` +
          `Either correct the path, delete the row, or restore the file.`,
      );
    }
  });

  it('every "git-direct" row has a path that git knows about', () => {
    const trackedRows = rows.filter((r) => classifyTracked(r.tracked) === 'git-direct');

    const failures: string[] = [];
    for (const row of trackedRows) {
      // Find the first path that looks like a repo-relative path (starts with secondbrain/)
      // and check that git has something at that path.
      let verified = false;
      for (const raw of row.paths) {
        if (!raw.startsWith('secondbrain/')) continue;
        // Strip any brace-expansion or glob tail so the cached git index can
        // match a concrete directory prefix (e.g. data/{otter,gmail}/raw/ -> data)
        const stripped = stripGlobTail(raw.slice('secondbrain/'.length)).replace(/\/$/, '');
        if (stripped.length > 0 && isPathInGitIndex(stripped, gitIndex)) {
          verified = true;
          break;
        }
      }
      if (!verified) {
        failures.push(`"${row.what}": no path in Where column is known to git ls-files`);
      }
    }

    if (failures.length > 0) {
      throw new Error(
        `State locations table claims "git" tracking for ${failures.length} row(s) that git does not know about:\n  - ${failures.join('\n  - ')}\n\n` +
          `Either git add the file, change tracking to "git via hardlink/symlink" if appropriate, or fix the path.`,
      );
    }
  });
});

/**
 * Resolve a raw path from the State locations table into an absolute
 * filesystem path, or null if it's clearly not a local-disk path (URL,
 * EC2 path, etc.).
 */
function resolveStateTablePath(raw: string): string | null {
  // Strip any trailing /*.jsonl or /*/SKILL.md glob — we check the parent dir
  const cleaned = raw.replace(/\s*\(\d+ files\).*$/, '');

  if (/^https?:\/\//.test(cleaned)) return null;
  if (cleaned.startsWith('/opt/')) return null;

  // Secondbrain project-relative path (including brace expansion etc)
  if (cleaned.startsWith('secondbrain/')) {
    const relative = cleaned.slice('secondbrain/'.length);
    return path.join(REPO_ROOT, stripGlobTail(relative));
  }

  // Home-relative
  if (cleaned.startsWith('~/')) {
    const home = process.env.USERPROFILE || process.env.HOME || '';
    return path.join(home, stripGlobTail(cleaned.slice(2)));
  }

  // AppData, Documents, etc — relative to %USERPROFILE%
  if (/^(AppData|Documents)\//.test(cleaned)) {
    const home = process.env.USERPROFILE || process.env.HOME || '';
    return path.join(home, stripGlobTail(cleaned));
  }

  // Absolute Windows path
  if (/^[A-Za-z]:[\\/]/.test(cleaned)) {
    return stripGlobTail(cleaned);
  }

  // Anything else (remote URIs, SSH tunnels, etc.) — not validatable locally
  return null;
}

/**
 * Trim glob stars and brace expansions down to the longest static prefix.
 * `secondbrain/data/{otter,gmail}/raw/` -> `secondbrain/data`
 * `~/.claude/scheduled-tasks/*\/SKILL.md` -> `~/.claude/scheduled-tasks`
 */
function stripGlobTail(p: string): string {
  const firstGlob = p.search(/[*{]/);
  if (firstGlob === -1) return p;
  const prefix = p.slice(0, firstGlob);
  // Drop to the last full directory separator before the glob
  const lastSep = Math.max(prefix.lastIndexOf('/'), prefix.lastIndexOf('\\'));
  return lastSep === -1 ? prefix : prefix.slice(0, lastSep);
}

function pathOrGlobExists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/**
 * Check whether a repo-relative path is present in the cached git index.
 * Matches either as a direct file or as a directory prefix so that
 * `data/briefings` matches `data/briefings/briefing-2026-04-11.md`.
 */
function isPathInGitIndex(repoRelative: string, gitIndex: Set<string>): boolean {
  if (gitIndex.has(repoRelative)) return true;
  const prefix = repoRelative.endsWith('/') ? repoRelative : repoRelative + '/';
  for (const entry of gitIndex) {
    if (entry.startsWith(prefix)) return true;
  }
  return false;
}

describe('reference_amy_state_locations.md discipline', () => {
  let src: string;

  beforeAll(() => {
    src = fs.existsSync(STATE_LOCATIONS) ? fs.readFileSync(STATE_LOCATIONS, 'utf-8') : '';
  });

  it('file exists', () => {
    expect(fs.existsSync(STATE_LOCATIONS)).toBe(true);
  });

  it('enumerates all 7 scheduling mechanisms', () => {
    // The 7 mechanisms from AMY_FOUNDATION_REFLECTION.md root-cause analysis
    expect(src).toMatch(/Claude Code MCP/);
    expect(src).toMatch(/Claude Desktop local-agent-mode/);
    expect(src).toMatch(/Claude Code session-local/);
    expect(src).toMatch(/Windows Task Scheduler/);
    expect(src).toMatch(/EC2.*scheduler/i);
    expect(src).toMatch(/Linux crontab/);
    expect(src).toMatch(/Claude remote triggers/);
  });

  it('points at Documents/Claude/Scheduled — the path I missed on 2026-04-10', () => {
    expect(src).toContain('Documents/Claude/Scheduled');
  });

  it('points at the 4 active scheduled skills', () => {
    expect(src).toContain('secondbrain-nightly-enhancement');
    expect(src).toContain('video-quality-research');
    expect(src).toContain('video-quality-tools');
  });

  it('enumerates the 3 EC2 state files', () => {
    expect(src).toContain('/opt/secondbrain/data/briefing-bodies.jsonl');
    expect(src).toMatch(/ec2-server\.js/);
  });

  it('points at Graphiti endpoint + SSH tunnel incantation', () => {
    expect(src).toContain('127.0.0.1:8000');
    expect(src).toMatch(/-fNL 8000:localhost:8000/);
  });

  it('lists the audit command', () => {
    expect(src).toMatch(/find C:\/Users\/luked/);
    expect(src).toMatch(/SKILL\.md/);
    expect(src).toMatch(/scheduled-tasks\.json/);
  });

  it('documents subsystem ownership section', () => {
    expect(src).toMatch(/## Subsystem ownership/i);
    expect(src).toMatch(/[Bb]riefing generation/);
    expect(src).toMatch(/[Oo]tter.*ingest|[Oo]tter.*scan|[Oo]tter.*sweep/);
  });

  it('flags still-on-local-PC items', () => {
    expect(src).toMatch(/still on local PC|needs migration/i);
  });
});
