/**
 * TDD — completeness guard test (rewritten 2026-04-21).
 *
 * The guard is STRUCTURAL, not phrase-matching. It verifies:
 *
 *   1. The canonical "implement to completion" rule lives in MEMORY.md
 *   2. The canonical "no permission stalling" + "own CI/CD" live in
 *      CLAUDE.global.md
 *   3. The Stop hook exists and is structural (not a trail-off-phrase grep)
 *   4. The memory operational-doc lists the acceptable-blocker categories
 *      (credential / binary-decision / CI-repeat-reject / rule-violation)
 *   5. The memory operational-doc enumerates NOT-acceptable excuses
 *      ("lot of work" / "context full" / "late")
 *
 * If any of these canonical signals drift out, vitest fails before the
 * next push. This is the drift-guard — not a phrase-police.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(__dirname, '..');
const MEMORY_TIER1 = join(REPO, 'memory', 'MEMORY.md');
const CLAUDE_GLOBAL = join(REPO, 'claude-config', 'CLAUDE.global.md');
const HOOK = join(REPO, 'scripts', 'claude-hooks', 'completeness-check.sh');
const FEEDBACK = join(REPO, 'memory', 'feedback_never_chunk_with_wrap_up.md');

describe('completeness guard — canonical rule drift protection', () => {
  it('MEMORY.md contains the canonical "implement to completion" rule', () => {
    const text = readFileSync(MEMORY_TIER1, 'utf8');
    expect(text).toMatch(/implement\s+(it\s+)?to\s+completion.*without\s+stopping/i);
  });

  it('MEMORY.md contains the "own the CI/CD pipeline" rule', () => {
    const text = readFileSync(MEMORY_TIER1, 'utf8');
    expect(text).toMatch(/own the ci\/?cd|monitor\s+(the\s+)?(ci|pipeline)\s+until\s+green/i);
  });

  it('CLAUDE.global.md contains the "no permission stalling" rule', () => {
    const text = readFileSync(CLAUDE_GLOBAL, 'utf8');
    expect(text).toMatch(/no permission stalling|don'?t\s+ask\s+for\s+access/i);
  });

  it('CLAUDE.global.md contains the "own the CI/CD pipeline" rule', () => {
    const text = readFileSync(CLAUDE_GLOBAL, 'utf8');
    expect(text).toMatch(/own the ci\/?cd|keep iterating until green/i);
  });

  it('Stop hook exists (bash wrapper + node module)', () => {
    expect(existsSync(HOOK), 'completeness-check.sh must exist').toBe(true);
    const hookMjs = join(REPO, 'scripts', 'claude-hooks', 'completeness-check.mjs');
    expect(existsSync(hookMjs), 'completeness-check.mjs must exist').toBe(true);
    const mjs = readFileSync(hookMjs, 'utf8');
    // The hook must parse requirements and check keyword coverage
    expect(mjs).toMatch(/parseRequirements|reqs/);
    expect(mjs).toMatch(/keyword|overlap|coverage|hits|addressed/);
    expect(mjs).toMatch(/transcript|messages/);
    expect(mjs).toMatch(/process\.exit\(2\)/);
    // Sanity: should NOT be a thin grep-for-phrases wrapper
    expect(mjs).not.toMatch(/^\s*grep\s+-qiE\s+"\(still on my list.*\)"\s*$/m);
  });

  it('feedback file lists acceptable blockers', () => {
    const text = readFileSync(FEEDBACK, 'utf8');
    expect(text).toMatch(/credential(\s+wall)?/i);
    expect(text).toMatch(/binary\s+(luke\s+)?decision/i);
    expect(text).toMatch(/ci\s+(repeat-?reject|repeated\s+rejection)/i);
    expect(text).toMatch(/explicit\s+(luke\s+)?rule\s+violation|canonical\s+rule/i);
  });

  it('feedback file lists NOT-acceptable excuses', () => {
    const text = readFileSync(FEEDBACK, 'utf8');
    expect(text).toMatch(/(lot\s+of\s+work|this\s+is\s+a\s+lot)/i);
    expect(text).toMatch(/context\s+(is\s+)?(getting\s+)?full/i);
    expect(text).toMatch(/it'?s\s+late/i);
  });

  it('feedback file references the canonical MEMORY.md rule (not a new invented rule)', () => {
    const text = readFileSync(FEEDBACK, 'utf8');
    expect(text).toMatch(/memory\/memory\.md|MEMORY\.md/i);
    expect(text).toMatch(/already[-\s]canonical|existing\s+canonical|operationaliz/i);
  });
});

// Functional tests against the real hook module — these are the tests that
// prove the structural check actually works on realistic inputs.
describe('completeness hook — functional behavior', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  let mod: any;
  it('loads the hook module', async () => {
    mod = await import('../scripts/claude-hooks/completeness-check.mjs');
    expect(mod.parseRequirements).toBeTypeOf('function');
    expect(mod.unfinishedItems).toBeTypeOf('function');
  });

  it('parses inline numbered lists ("1. a 2. b 3. c")', async () => {
    const reqs = mod.parseRequirements(
      'Please do three things: 1. add a dashboard tile. 2. fix the scraper. 3. deploy to ec2',
    );
    expect(reqs.length).toBeGreaterThanOrEqual(3);
    expect(reqs.join(' ').toLowerCase()).toContain('dashboard tile');
    expect(reqs.join(' ').toLowerCase()).toContain('scraper');
    expect(reqs.join(' ').toLowerCase()).toContain('deploy');
  });

  it('parses newline-separated numbered lists', async () => {
    const reqs = mod.parseRequirements('Do these:\n1. First thing\n2. Second thing\n3. Third thing');
    expect(reqs.length).toBeGreaterThanOrEqual(3);
  });

  it('parses bulleted lists', async () => {
    const reqs = mod.parseRequirements('Do these:\n- first\n- second\n* third\n• fourth');
    expect(reqs.length).toBeGreaterThanOrEqual(4);
  });

  it('does not parse conversational turns as requirements', async () => {
    const reqs = mod.parseRequirements('what time is it?');
    expect(reqs).toEqual([]);
  });

  it('unfinishedItems flags items whose keywords are missing from response', async () => {
    const reqs = [
      'add a dashboard tile',
      'fix the scraper',
      'deploy to ec2 instance',
    ];
    const assistantText = 'I added the dashboard tile with proper styling.';
    const unfinished = mod.unfinishedItems(reqs, assistantText);
    expect(unfinished.length).toBe(2);
    expect(unfinished.map((u: any) => u.text.toLowerCase()).join(' ')).toMatch(/scraper/);
    expect(unfinished.map((u: any) => u.text.toLowerCase()).join(' ')).toMatch(/deploy/);
  });

  it('unfinishedItems returns empty when all keywords are in response', async () => {
    const reqs = ['add a dashboard tile', 'fix the scraper', 'deploy to ec2'];
    const assistantText = 'Added dashboard tile, fixed scraper parser, deployed to ec2.';
    const unfinished = mod.unfinishedItems(reqs, assistantText);
    expect(unfinished).toEqual([]);
  });

  // 2026-04-26 Luke #gap: keyword overlap is not enough. The chunking
  // pattern cheats it -- the "Still queued for next session" list mentions
  // every item by name so keyword overlap passes, but the items are
  // explicitly being deferred. The phrase guard catches this.
  it('hasDeferralLanguage flags "DEFERRED next session" wording', async () => {
    expect(mod.hasDeferralLanguage('DEFERRED next session: rewrite the dispatcher').length).toBeGreaterThanOrEqual(1);
    expect(mod.hasDeferralLanguage('I will tackle that next session').length).toBeGreaterThanOrEqual(1);
    expect(mod.hasDeferralLanguage('still queued for next round').length).toBeGreaterThanOrEqual(1);
    expect(mod.hasDeferralLanguage("I'll get to those tomorrow").length).toBeGreaterThanOrEqual(1);
  });

  it('hasDeferralLanguage returns empty when response just describes work done', async () => {
    expect(mod.hasDeferralLanguage('Added the tile, fixed the scraper, deployed to ec2.')).toEqual([]);
    expect(mod.hasDeferralLanguage('All 17 items shipped. PR pushed.')).toEqual([]);
  });

  it('hasDeferralLanguage exposes the matching phrase for the hook message', async () => {
    const matches = mod.hasDeferralLanguage('Locked in this session... DEFERRED next session: dispatch processor rewrite');
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(matches.join(' ').toLowerCase()).toMatch(/deferred|next session/);
  });
});

// 2026-04-26 meta-#gap: the gap-guard.sh UserPromptSubmit hook injects the
// 8-step workflow as a systemMessage but doesn't enforce that the assistant
// USED it. gap-workflow-enforcer is a Stop hook that requires at least 6 of
// the 8 markers when the user's most recent message starts with #gap.
describe('gap-workflow-enforcer Stop hook — 8-step workflow enforcement', () => {
  let gap: any;
  beforeAll(async () => { /* loaded eagerly below */ });

  beforeEach(async () => {
    gap = await import('../scripts/claude-hooks/gap-workflow-enforcer.mjs');
  });

  it('userMentionsGap detects #gap anywhere in the message (start, mid, end)', () => {
    expect(gap.userMentionsGap('#gap the briefing broke again')).toBe(true);
    expect(gap.userMentionsGap('#GAP why did this regress?')).toBe(true);
    expect(gap.userMentionsGap('# gap with a space')).toBe(true);
    // 2026-04-26 Luke correction: match anywhere, not just at start.
    expect(gap.userMentionsGap('Today I went to the store. Yesterday I exercised. The third paragraph mentions #gap somewhere far away from the start.')).toBe(true);
    expect(gap.userMentionsGap('that is a #gap right there at the end')).toBe(true);
  });

  it('userMentionsGap detects "hashtag gap" voice-transcript form', () => {
    expect(gap.userMentionsGap('hashtag gap the otter probe is wrong')).toBe(true);
    expect(gap.userMentionsGap('Hashtag Gap, this regressed')).toBe(true);
    expect(gap.userMentionsGap('what is happening here, hashtag gap')).toBe(true);
  });

  it('userMentionsGap returns false on conversational turns', () => {
    expect(gap.userMentionsGap('what is the weather?')).toBe(false);
    expect(gap.userMentionsGap('')).toBe(false);
    // "gap" in regular prose without # or hashtag prefix should NOT trigger.
    expect(gap.userMentionsGap('there is a small gap between the boards')).toBe(false);
    expect(gap.userMentionsGap('hashtag amy fix this')).toBe(false);
  });

  it('countMarkersHit returns 8 on a fully-formatted #gap response', () => {
    const fullGapResponse = `
      ACKNOWLEDGE the prior feedback: feedback file says X.
      CONFIRM it was supposed to be fixed by hook Y.
      EXPLAIN architecturally what went wrong: the hook used keyword matching.
      WHY it happened again: keywords beat the structural check.
      SELF-REFLECTION on my behavior: I treated checklist work as professional chunking.
      THE FIX uses the prevention hierarchy: hook + test.
      CANNOT RECUR because the guard fires on deferral language.
      EXEC SUMMARY: files changed are mjs and spec.
    `;
    expect(gap.countMarkersHit(fullGapResponse)).toBeGreaterThanOrEqual(gap.MIN_MARKERS);
  });

  it('countMarkersHit fails a 1-sentence "I acknowledge" reply', () => {
    expect(gap.countMarkersHit("You're right. Acknowledging and grinding through.")).toBeLessThan(gap.MIN_MARKERS);
  });
});
