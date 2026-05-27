/**
 * Regression test for the overnight self-heal orchestrator.
 *
 * Background (2026-05-23): Luke called out that the heal-tests loop only
 * re-ran vitest with no repair, then we added mechanical-fix handlers, and
 * Luke called out again that mechanical fixes are NOT the goal. The goal
 * is REAL development work overnight: spawn Claude Code sessions per
 * blocker that investigate, write/update tests, fix code, consult Codex
 * on meaningful changes, commit, push, and verify the blocker is cleared.
 * By morning, the briefing reflects work that actually happened.
 *
 * This test pins the orchestrator's PURE helpers (no live CLI spawns):
 *   - parseBlockersFromMarkdown: reads briefing markdown blockers section
 *   - buildSessionPrompt: composes the per-blocker prompt with context
 *   - classifySessionResult: parses stream-json output to decide cleared
 *     vs escalated
 *   - shouldRespectDeadline: deadline-aware gating before each spawn
 *
 * The actual `claude --print` spawn is exercised separately, gated by an
 * env flag (OVERNIGHT_ORCHESTRATOR_LIVE_TEST=1) since each live run costs
 * real Anthropic tokens.
 */

import { describe, it, expect } from 'vitest';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const orch = require(path.resolve(__dirname, '../../../scripts/overnight-self-heal-orchestrator.js'));

const SAMPLE_BRIEFING_BLOCKERS = `Good morning Luke - Saturday, May 23, 2026
Daily Executive Briefing
---

BLOCKERS - briefing quality gates:

1. Tests (system health red)
     Requirement: The full product and briefing test suite must be green.
     Evidence: 1 real failure(s) need Amy to fix the underlying behavior; 0 stale-assert(s).
     Repair now: Route this defect to the owning card worker and refresh.
     Owner: Amy
     Need from Luke: Nothing.

2. Video approval queue has unresolved rejected work
     Requirement: Rejected or failed-gate videos must not be surfaced as approval-ready.
     Evidence: short009_hggs is blocked: ec2 mp4 pull failed after 3 attempts.
     Repair now: Run the video regen/thumbnail repair loop, preserve rejection history.
     Owner: Amy
     Need from Luke: None.

---

MEETINGS - today + next 7 days:
`;

describe('overnight-self-heal-orchestrator: parseBlockersFromMarkdown', () => {
  it('extracts each blocker as a structured task with title, evidence, owner, need', () => {
    const blockers = orch.parseBlockersFromMarkdown(SAMPLE_BRIEFING_BLOCKERS);
    expect(blockers.length).toBe(2);
    expect(blockers[0].title).toBe('Tests (system health red)');
    expect(blockers[0].evidence).toMatch(/1 real failure/);
    expect(blockers[0].owner).toBe('Amy');
    expect(blockers[1].title).toMatch(/Video approval queue/);
    expect(blockers[1].evidence).toMatch(/short009_hggs/);
  });

  it('returns empty array when briefing has no blockers section', () => {
    expect(orch.parseBlockersFromMarkdown('No blockers section here.')).toEqual([]);
  });

  it('returns empty array when blockers section is empty', () => {
    const md = `BLOCKERS - briefing quality gates:\n\n  No hard blockers need Luke.\n\nMEETINGS:\n`;
    expect(orch.parseBlockersFromMarkdown(md)).toEqual([]);
  });
});

describe('overnight-self-heal-orchestrator: classifyOwnership', () => {
  it('marks owner=Amy blockers as auto-attemptable', () => {
    const b = { title: 'Tests red', owner: 'Amy', need: 'Nothing' };
    expect(orch.classifyOwnership(b).canAutoAttempt).toBe(true);
  });

  it('refuses to auto-attempt when Need from Luke names a credential or decision', () => {
    const b = { title: 'X', owner: 'Amy', need: 'Luke must provide AWS credential rotation' };
    expect(orch.classifyOwnership(b).canAutoAttempt).toBe(false);
  });

  it('refuses to auto-attempt when owner is explicitly Luke', () => {
    const b = { title: 'X', owner: 'Luke', need: 'Decide whether to abandon clip' };
    expect(orch.classifyOwnership(b).canAutoAttempt).toBe(false);
  });

  // 2026-05-24 regression: today's briefing emitted a "Hard blocker, not a Luke
  // decision" need-line; the prior peer-need regex matched the bare word
  // "decision" and refused to attempt the blocker, leaving it for the morning
  // when Amy clearly owned the work. Negation phrases must NOT trip the skip.
  it('auto-attempts when need explicitly denies Luke ownership ("not a Luke decision")', () => {
    const b = {
      title: 'Gmail scan',
      owner: 'Amy',
      need: 'Hard blocker, not a Luke decision: the overnight heal window closed before this cleared.',
    };
    expect(orch.classifyOwnership(b).canAutoAttempt).toBe(true);
  });

  it('auto-attempts when need begins with Nothing or None', () => {
    expect(orch.classifyOwnership({ title: 'X', owner: 'Amy', need: 'Nothing.' }).canAutoAttempt).toBe(true);
    expect(orch.classifyOwnership({ title: 'X', owner: 'Amy', need: 'None unless the scanner proves a named auth wall.' }).canAutoAttempt).toBe(true);
  });
});

// 2026-05-24 regression: orchestrator hard-coded `new Date().toISOString().slice(0,10)`
// for the briefing filename. The scheduled task runs at 22:30 CT; at that wall
// clock, the UTC date is already the next calendar day, so the file briefing-
// {tomorrow}.md does not exist yet and the orchestrator bailed at startup with
// "briefing not readable", clearing zero blockers and leaving the morning
// briefing red. resolveLatestBriefingPath must walk the briefings/ dir and
// pick the most recent file within a 36h window.
describe('overnight-self-heal-orchestrator: resolveLatestBriefingPath', () => {
  const fs = require('fs');
  const os = require('os');
  const tmpRoot = path.join(os.tmpdir(), 'orch-resolveLatestBriefingPath-' + process.pid);
  const briefingsDir = path.join(tmpRoot, 'briefings');

  function setupTmp(files) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.mkdirSync(briefingsDir, { recursive: true });
    for (const [name, mtimeMs] of files) {
      const p = path.join(briefingsDir, name);
      fs.writeFileSync(p, 'BLOCKERS - briefing quality gates:\n\n', 'utf8');
      fs.utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
    }
  }

  it('returns the exact-date file when today\'s briefing exists', () => {
    const today = '2026-05-24';
    const todayMs = Date.parse(`${today}T10:00:00Z`);
    setupTmp([[`briefing-${today}.md`, todayMs]]);
    const got = orch.resolveLatestBriefingPath({ date: today, briefingsDir, nowMs: todayMs + 60_000 });
    expect(got).toBe(path.join(briefingsDir, `briefing-${today}.md`));
  });

  it('falls back to the most recent briefing within 36h when today\'s file is missing', () => {
    const today = '2026-05-24';
    const yesterday = '2026-05-23';
    const yesterdayMs = Date.parse(`${yesterday}T10:00:00Z`);
    const nowMs = Date.parse(`${today}T03:30:00Z`);
    setupTmp([[`briefing-${yesterday}.md`, yesterdayMs]]);
    const got = orch.resolveLatestBriefingPath({ date: today, briefingsDir, nowMs });
    expect(got).toBe(path.join(briefingsDir, `briefing-${yesterday}.md`));
  });

  it('returns null when no briefing exists within the 36h window', () => {
    const today = '2026-05-24';
    const stale = '2026-05-01';
    const staleMs = Date.parse(`${stale}T10:00:00Z`);
    const nowMs = Date.parse(`${today}T03:30:00Z`);
    setupTmp([[`briefing-${stale}.md`, staleMs]]);
    const got = orch.resolveLatestBriefingPath({ date: today, briefingsDir, nowMs });
    expect(got).toBeNull();
  });

  it('returns null when briefings dir is missing', () => {
    const got = orch.resolveLatestBriefingPath({
      date: '2026-05-24',
      briefingsDir: path.join(tmpRoot, 'does-not-exist'),
      nowMs: Date.now(),
    });
    expect(got).toBeNull();
  });
});

describe('overnight-self-heal-orchestrator: buildSessionPrompt', () => {
  it('includes the blocker title, evidence, repo root, deadline, and acceptance criteria', () => {
    const blocker = {
      title: 'Tests (system health red)',
      evidence: '1 real failure(s) need Amy to fix the underlying behavior.',
      requirement: 'The full product and briefing test suite must be green.',
      owner: 'Amy',
      need: 'Nothing',
    };
    const prompt = orch.buildSessionPrompt(blocker, {
      repoRoot: '/test/repo/path',
      deadlineIso: '2026-05-24T10:15:00Z',
      branchSummary: 'master, clean working tree',
    });
    expect(prompt).toContain('Tests (system health red)');
    expect(prompt).toContain('1 real failure');
    expect(prompt).toContain('/test/repo/path');
    expect(prompt).toContain('2026-05-24T10:15:00Z');
    expect(prompt).toMatch(/consult Codex/i);
    expect(prompt).toMatch(/commit/i);
    expect(prompt).toMatch(/push/i);
    expect(prompt).toMatch(/JSON/i);
    expect(prompt).toMatch(/"status"/);
    expect(prompt).toMatch(/"commit_sha"/);
  });
});

describe('overnight-self-heal-orchestrator: classifySessionResult', () => {
  it('classifies a clean cleared result with commit_sha and pushed=true', () => {
    const streamJson = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Working on it.' }] } }),
      JSON.stringify({ type: 'result', result: '{"status":"cleared","commit_sha":"abc1234","pushed":true,"verification":"vitest passed","tests":"30/30"}', subtype: 'success' }),
    ].join('\n');
    const r = orch.classifySessionResult(streamJson, 0);
    expect(r.status).toBe('cleared');
    expect(r.commit_sha).toBe('abc1234');
    expect(r.pushed).toBe(true);
  });

  it('classifies as escalated when the session exits non-zero', () => {
    const r = orch.classifySessionResult('', 1);
    expect(r.status).toBe('escalated');
    expect(r.escalationReason).toMatch(/exit/i);
  });

  it('classifies as escalated when JSON result is malformed', () => {
    const streamJson = JSON.stringify({ type: 'result', result: 'I could not complete this.', subtype: 'success' });
    const r = orch.classifySessionResult(streamJson, 0);
    expect(r.status).toBe('escalated');
  });

  it('classifies as escalated when status is "escalated" or commit_sha is empty', () => {
    const streamJson = JSON.stringify({ type: 'result', result: '{"status":"escalated","commit_sha":"","pushed":false,"escalation_reason":"missing test fixture"}', subtype: 'success' });
    const r = orch.classifySessionResult(streamJson, 0);
    expect(r.status).toBe('escalated');
    expect(r.escalationReason).toMatch(/missing test fixture/i);
  });
});

describe('overnight-self-heal-orchestrator: shouldRespectDeadline', () => {
  it('returns true when remaining time is less than the per-session budget', () => {
    const now = 1000000;
    expect(orch.shouldRespectDeadline(now, now + 60000, 600000)).toBe(true);
  });

  it('returns false when there is enough remaining time for a full session', () => {
    const now = 1000000;
    expect(orch.shouldRespectDeadline(now, now + 7200000, 1800000)).toBe(false);
  });
});
