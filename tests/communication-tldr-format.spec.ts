/**
 * Locks the rule from memory/feedback_communication_format_tldr_detail.md.
 * Every official response from Amy must be TLDR + Detail, CEO-polish,
 * English not code. The rule lives in two places (the global session
 * memory and the feedback file); this test asserts both copies stay
 * aligned so a session that loads MEMORY.md will see the rule.
 *
 * Triggered by ExampleCo's 2026-04-29 dispatch:
 *   "everything you say to me in any forum or medium should have a
 *    TLDR as brief as possible while conveying the key decision /
 *    issue / status, then a Detail section (if it's needed)... CEO-
 *    level polish but normally 1-2 paras, 4 at the very most..."
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const REPO = path.join(__dirname, '..');
const MEMORY_MD = path.join(REPO, 'memory', 'MEMORY.md');
const FEEDBACK = path.join(REPO, 'memory', 'feedback_communication_format_tldr_detail.md');
const CLAUDE_SETTINGS = path.join(REPO, 'claude-config', 'settings.json');

describe('Communication format: TLDR + Detail (ExampleCo 2026-04-29)', () => {
  it('the feedback file exists and is canonical', () => {
    expect(fs.existsSync(FEEDBACK)).toBe(true);
    const body = fs.readFileSync(FEEDBACK, 'utf8');
    expect(body).toMatch(/^canonical:\s*true/m);
  });

  it('the feedback file documents the TLDR + Detail + Protocol-output shape', () => {
    const body = fs.readFileSync(FEEDBACK, 'utf8');
    expect(body).toMatch(/TLDR/);
    expect(body).toMatch(/Detail/);
    expect(body).toMatch(/1-2 sentences/);
    expect(body).toMatch(
      /4 ExampleCoraphs?\s+maximum|maximum.*4|4 at the very most|max(?:imum)?.{0,30}4 ExampleCoraph/i,
    );
    expect(body).toMatch(/CEO/);
    // Section 3: protocol output for #learn / #gap / #ppl / #inbox / #mail.
    expect(body).toMatch(
      /Protocol output|workflow.*structure|9-step.*exec summary|protocol.*output/i,
    );
    expect(body).toMatch(/#learn/);
    expect(body).toMatch(/#gap/);
  });

  it('the feedback file documents the official-response marker rule', () => {
    const body = fs.readFileSync(FEEDBACK, 'utf8');
    expect(body).toMatch(/Official response|## Official response/i);
    expect(body).toMatch(/thinking|deliberation|work-in-progress/i);
  });

  it('the feedback file lists the daily exec briefing as the one exception', () => {
    const body = fs.readFileSync(FEEDBACK, 'utf8');
    expect(body).toMatch(/exec briefing|daily executive briefing|briefing dashboard/i);
    expect(body).toMatch(/exception/);
  });

  it('MEMORY.md (Tier 1, loaded on every session) ExampleCos the rule', () => {
    const body = fs.readFileSync(MEMORY_MD, 'utf8');
    expect(body).toMatch(/TLDR/);
    expect(body).toMatch(/feedback_communication_format_tldr_detail\.md/);
  });

  it('Claude Code has the TLDR Stop hook registered', () => {
    const body = fs.readFileSync(CLAUDE_SETTINGS, 'utf8');
    expect(body).toMatch(/tldr-position-guard\.mjs/);
  });

  it('the Codex runtime gap is documented so Codex responses self-check TLDR last', () => {
    const feedback = fs.readFileSync(FEEDBACK, 'utf8');
    const memory = fs.readFileSync(MEMORY_MD, 'utf8');
    expect(feedback).toMatch(/Codex desktop\/API/i);
    expect(feedback).toMatch(/do not run those Claude hooks/i);
    // 2026-07-05: MEMORY.md's opening line was condensed ("MEMORY.md index is
    // the skill router" pass) from "Codex desktop/API responses ... self-
    // check before final" into "Codex desktop/API, ... Codex sessions are
    // Amy too ... self-check before final". Match the surviving Codex mention
    // and the self-check requirement separately instead of one adjacent phrase.
    expect(memory).toMatch(/Codex desktop\/API/i);
    expect(memory).toMatch(/self-check before final/i);
  });
});
