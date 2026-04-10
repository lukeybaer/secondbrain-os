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

const MEMORY_MD = path.resolve(__dirname, '..', '..', '..', 'memory', 'MEMORY.md');
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
