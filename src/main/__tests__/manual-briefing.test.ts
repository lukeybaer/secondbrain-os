/**
 * manual-briefing.test.ts
 *
 * Regression guards for scripts/manual-briefing-v3.js. Today (2026-04-10) the
 * briefing script shipped three separate failures in sequence:
 *
 *   1. v2 called the paid OpenAI API directly despite Luke having a Claude Max
 *      subscription. The rule "everything flows through claude max" was violated.
 *   2. v2 hardcoded action item strings as literal msg4Parts.push(...) calls,
 *      which fabricated facts (attributing Ed's 7-day deadline to Yanli, inventing
 *      an EB-1A/I-485 connection) and would have shipped the same fake items
 *      every future run regardless of Gmail state.
 *   3. v3 initially used spawnSync({shell:true}) on Windows which truncated
 *      multi-line prompts and made claude return "what do you want me to write?"
 *      for 30 articles in a row. This shipped to Telegram and the Desktop file.
 *
 * These tests fail if any of the three regressions come back.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const SCRIPT_PATH = path.resolve(__dirname, '..', '..', '..', 'scripts', 'manual-briefing-v3.js');

describe('manual-briefing-v3.js — no paid LLM calls', () => {
  let src: string;
  beforeAll(() => {
    src = fs.existsSync(SCRIPT_PATH) ? fs.readFileSync(SCRIPT_PATH, 'utf-8') : '';
  });

  it('script exists', () => {
    expect(fs.existsSync(SCRIPT_PATH)).toBe(true);
  });

  it('does not call api.openai.com', () => {
    expect(src).not.toContain('api.openai.com');
  });

  it('does not call api.groq.com', () => {
    expect(src).not.toContain('api.groq.com');
  });

  it('does not call api.anthropic.com', () => {
    expect(src).not.toContain('api.anthropic.com');
  });

  it('does not read openaiApiKey from config', () => {
    // Comments mentioning the exclusion are fine; actual assignment is not
    const assignmentPattern = /const\s+\w+\s*=\s*cfg\.openaiApiKey/;
    expect(assignmentPattern.test(src)).toBe(false);
  });

  it('does not define an openaiChat function', () => {
    expect(src).not.toMatch(/function\s+openaiChat/);
  });

  it('spawns claude CLI via process.execPath + cli.js (not shell:true)', () => {
    expect(src).toContain('process.execPath');
    expect(src).toContain('CLAUDE_CLI_JS');
    // shell:true on Windows mangles multi-line prompts; must be absent from the
    // claude invocation block
    const claudeBlock = src.match(/function claudeSummarize[\s\S]{0,1500}/);
    expect(claudeBlock).toBeTruthy();
    if (claudeBlock) {
      expect(claudeBlock[0]).not.toMatch(/shell:\s*true/);
    }
  });

  it('unsets CLAUDECODE env var before spawning claude CLI', () => {
    // The nested-session guard must be bypassed for the subprocess to succeed
    expect(src).toContain('delete env.CLAUDECODE');
  });
});

describe('manual-briefing-v3.js — no hardcoded action items', () => {
  let src: string;
  beforeAll(() => {
    src = fs.existsSync(SCRIPT_PATH) ? fs.readFileSync(SCRIPT_PATH, 'utf-8') : '';
  });

  it('loads action items from JSON file, not from source code', () => {
    expect(src).toContain('briefing-action-items.json');
    expect(src).toContain('loadActionItems');
  });

  it('does not contain hardcoded person names in msg4Parts.push calls', () => {
    // v2 had lines like: msg4Parts.push('1. Ed Evans — ITM Operating Agreement ...')
    // with literal names, dates, and fabricated content. Any push call whose
    // literal argument mentions a proper-name pattern + "—" is a regression.
    const badPattern =
      /msg4Parts\.push\([`'"][^`'"]*\b(Ed Evans|Yanli|Mary Regan|Angel Hyden|Zachary|Abdullah)\b[^`'"]*—/;
    expect(badPattern.test(src)).toBe(false);
  });

  it('does not contain hardcoded Gmail threadId strings in push calls', () => {
    // Thread IDs like 19d6ae778ac7e2f0 in push calls means hardcoding
    const hardcodedThreadIdInPush = /msg4Parts\.push\([`'"][^`'"]*19[a-f0-9]{15}/;
    expect(hardcodedThreadIdInPush.test(src)).toBe(false);
  });
});

describe('manual-briefing-v3.js — fetches full article bodies', () => {
  let src: string;
  beforeAll(() => {
    src = fs.existsSync(SCRIPT_PATH) ? fs.readFileSync(SCRIPT_PATH, 'utf-8') : '';
  });

  it('defines a fetchArticleBody function', () => {
    expect(src).toMatch(/function\s+fetchArticleBody/);
  });

  it('summarizeArticle calls fetchArticleBody before invoking claude', () => {
    const fn = src.match(/async function summarizeArticle[\s\S]{0,3000}/);
    expect(fn).toBeTruthy();
    if (fn) {
      expect(fn[0]).toContain('fetchArticleBody');
      // fetchArticleBody must be called BEFORE claudeSummarize
      const fbIdx = fn[0].indexOf('fetchArticleBody');
      const csIdx = fn[0].indexOf('claudeSummarize');
      expect(fbIdx).toBeGreaterThan(-1);
      expect(csIdx).toBeGreaterThan(-1);
      expect(fbIdx).toBeLessThan(csIdx);
    }
  });

  it('main loop awaits each summarizeArticle call', () => {
    // Regression: earlier version built arrays of promises without awaiting,
    // producing "[object Promise]" in the output file
    expect(src).toContain('await summarizeArticle(');
  });
});

describe('manual-briefing-v3.js — Desktop + home + data dir outputs', () => {
  let src: string;
  beforeAll(() => {
    src = fs.existsSync(SCRIPT_PATH) ? fs.readFileSync(SCRIPT_PATH, 'utf-8') : '';
  });

  it('writes to Desktop', () => {
    expect(src).toMatch(/C:\/Users\/luked\/Desktop\/briefing-/);
  });

  it('writes to secondbrain/data/briefings/', () => {
    expect(src).toContain('secondbrain/data/briefings/');
  });

  it('writes to home directory', () => {
    expect(src).toMatch(/C:\/Users\/luked\/briefing-/);
  });
});

describe('action items JSON — structure', () => {
  const jsonPath = path.resolve(__dirname, '..', '..', '..', 'data', 'briefing-action-items.json');
  let data: any;
  beforeAll(() => {
    if (fs.existsSync(jsonPath)) {
      data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    }
  });

  it('file exists', () => {
    expect(fs.existsSync(jsonPath)).toBe(true);
  });

  it('has generatedBy field explaining source', () => {
    if (!data) return;
    expect(data.generatedBy).toBeDefined();
    expect(typeof data.generatedBy).toBe('string');
  });

  it('every unanswered email has a verifiable threadId + gmailUrl', () => {
    if (!data || !data.unansweredEmails) return;
    for (const item of data.unansweredEmails) {
      expect(item.threadId).toBeDefined();
      expect(item.threadId).toMatch(/^[a-f0-9]+$/);
      expect(item.gmailUrl).toMatch(/^https:\/\/mail\.google\.com/);
    }
  });

  // Regression: 2026-04-11 #gap — Angel Hyden commitment shipped in the 5:30
  // briefing even though Ed replied Apr 9 "I'll jump into ADP" which paused
  // Luke's promise. The openCommitments schema had no supersession check.
  // These tests enforce that every openCommitment carries enough metadata
  // for the briefing script to verify it is still live.
  it('every openCommitment has committedAt + lastThreadMessageAt for supersession check', () => {
    if (!data || !data.openCommitments) return;
    for (const c of data.openCommitments) {
      expect(c.committedAt, `openCommitment for ${c.person} missing committedAt`).toBeDefined();
      // stillOpen:true is the operator override — otherwise lastThreadMessageAt
      // must be present so the script can decide whether the thread moved on.
      if (c.stillOpen !== true) {
        expect(
          c.lastThreadMessageAt,
          `openCommitment for ${c.person} missing lastThreadMessageAt (use stillOpen:true to override)`,
        ).toBeDefined();
      }
    }
  });

  it('no openCommitment has lastThreadMessageAt strictly greater than committedAt (without explicit override)', () => {
    if (!data || !data.openCommitments) return;
    for (const c of data.openCommitments) {
      if (c.stillOpen === true) continue;
      if (!c.committedAt || !c.lastThreadMessageAt) continue;
      const committed = new Date(c.committedAt).getTime();
      const lastMsg = new Date(c.lastThreadMessageAt).getTime();
      expect(
        lastMsg > committed,
        `openCommitment for ${c.person} is superseded: thread message at ${c.lastThreadMessageAt} > commitment at ${c.committedAt}. Move to supersededCommitments or set stillOpen:true.`,
      ).toBe(false);
    }
  });
});

describe('manual-briefing-v3.js — openCommitment supersession filter', () => {
  let src: string;
  beforeAll(() => {
    src = fs.existsSync(SCRIPT_PATH) ? fs.readFileSync(SCRIPT_PATH, 'utf-8') : '';
  });

  it('loadActionItems filters openCommitments by lastThreadMessageAt vs committedAt', () => {
    // The filter must live inside loadActionItems so every call site benefits.
    const fn = src.match(/function loadActionItems[\s\S]{0,3000}/);
    expect(fn).toBeTruthy();
    if (fn) {
      expect(fn[0]).toContain('lastThreadMessageAt');
      expect(fn[0]).toContain('committedAt');
      expect(fn[0]).toMatch(/lastMsg\s*>\s*committed/);
    }
  });

  it('loadActionItems respects stillOpen:true as an operator override', () => {
    const fn = src.match(/function loadActionItems[\s\S]{0,3000}/);
    expect(fn).toBeTruthy();
    if (fn) expect(fn[0]).toContain('stillOpen');
  });
});
