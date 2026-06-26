/**
 * multi-part-requirements-guard.test.ts
 *
 * Locks the 2026-04-29 #gap: "you should know better than to just stop
 * mid-requirements." ExampleCo gave a multi-part ask (better thumbnail
 * generator + video that's not all black + rejected videos regen
 * immediately + proper SKILL file + remember the autonomous YouTube
 * goal). The first session shipped the thumbnail half cleanly and
 * deferred the video half as "future work" without his agreement.
 * That is cherry-picking the easy work; the multi-part ask is the
 * unit, not the parts of it.
 *
 * The fix is the TodoWrite list itself: at the start of any multi-part
 * request, every ask becomes a todo, and at end-of-turn nothing should
 * remain pending unless the user explicitly deferred it. This test
 * checks the memory file that anchors that rule so future sessions
 * inherit the pattern -- if anyone deletes the rule or weakens it,
 * the test fails.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const FEEDBACK_FILE = path.join(REPO_ROOT, 'memory', 'feedback_no_stopping_to_ask.md');
const COMMUNICATION_FILE = path.join(REPO_ROOT, 'memory', 'feedback_communication.md');

describe('multi-part requirements guard -- the rule that survived 2026-04-29', () => {
  it('feedback_no_stopping_to_ask.md exists', () => {
    expect(fs.existsSync(FEEDBACK_FILE)).toBe(true);
  });

  it('feedback_no_stopping_to_ask.md anchors Rule 2 (mid-requirements)', () => {
    const src = fs.readFileSync(FEEDBACK_FILE, 'utf8');
    // The rule must be explicit so a future session reading the
    // memory file knows it is a hard constraint, not a suggestion.
    expect(src).toMatch(/Rule 2/);
    expect(src).toMatch(/mid-requirements/);
    expect(src).toMatch(/2026-04-29/);
    // The dated #gap that motivated the rule -- losing this date
    // erases the lesson's source incident.
    expect(src).toMatch(/#gap/);
  });

  it('feedback_no_stopping_to_ask.md prescribes the TodoWrite mechanism', () => {
    const src = fs.readFileSync(FEEDBACK_FILE, 'utf8');
    // The prevention mechanism MUST be the TodoWrite list. The rule
    // hierarchy is `test > hook > npm script > CLAUDE.md > memory file`,
    // and the TodoWrite list at the start of every multi-part request
    // is the test-equivalent: it is mechanical, visible, and
    // observable in every session transcript.
    expect(src).toMatch(/TodoWrite/);
  });

  it('feedback_communication.md cross-references the multi-part rule', () => {
    expect(fs.existsSync(COMMUNICATION_FILE)).toBe(true);
    const src = fs.readFileSync(COMMUNICATION_FILE, 'utf8');
    // The communication memory points at the no-stopping rule so a
    // session reading "how to talk to ExampleCo" also surfaces "how to
    // execute on multi-part asks." Cross-referencing prevents the
    // file-shopping pattern where one file gets read and the other
    // gets missed.
    expect(src).toMatch(/multi-part|mid-requirements/i);
  });

  it('the rule explicitly forbids documenting "future work" without explicit deferral', () => {
    const src = fs.readFileSync(FEEDBACK_FILE, 'utf8');
    // The exact failure pattern from 2026-04-29: shipping the easy
    // half, documenting the hard half as "open structural gap,"
    // marking the turn complete. The memory file must call this out.
    expect(src.toLowerCase()).toMatch(/cherry.?pick|easy work|future work|defer/);
  });

  it('Rule 3 (2026-05-28) locks "stale cache is a fetch, not a fork"', () => {
    const src = fs.readFileSync(FEEDBACK_FILE, 'utf8');
    // The 2026-05-28 incident: ExampleCo asked to summarize "today's call
    // with PRIVATE_NAME," local Otter cache had no 2026-05-28 conversation,
    // and I fired AskUserQuestion offering stale candidates instead
    // of pulling fresh. The memory file must anchor:
    //   (a) the dated incident,
    //   (b) the rule that AskUserQuestion is a stall in disguise
    //       when the request was unambiguous,
    //   (c) the fix pattern: write the missing fetch tool if it
    //       doesn't exist, run it, ship.
    expect(src).toMatch(/Rule 3/);
    expect(src).toMatch(/2026-05-28/);
    expect(src).toMatch(/AskUserQuestion/);
    expect(src.toLowerCase()).toMatch(/fetch.*not.*fork|stale|cache/);
  });
});
