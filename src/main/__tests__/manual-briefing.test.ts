/**
 * manual-briefing.test.ts
 *
 * Regression guards for scripts/manual-briefing-v3.js. Today (2026-04-10) the
 * briefing script shipped three separate failures in sequence:
 *
 *   1. v2 called the paid OpenAI API directly despite the owner having a Claude Max
 *      subscription. The rule "everything flows through claude max" was violated.
 *   2. v2 hardcoded action item strings as literal msg4Parts.push(...) calls,
 *      which fabricated facts (attributing Ed's 7-day deadline to partner, inventing
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
import { spawnSync } from 'child_process';

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

  // Regression: 2026-05-03. The 5:30 AM CT scheduled briefing crashed mid-run
  // with TypeError [ERR_INVALID_ARG_VALUE] "must be a string without null
  // bytes" inside spawnSync because an article body fetched over RSS ExampleCod a
  // stray U+0000 byte (likely from a gzip mis-decode). Node child_process
  // rejects argv with embedded NULs. Briefing did not ship for the day until
  // the prompt sanitizer was added. Guard: claudeSummarize must strip C0
  // control bytes (NUL through 0x1F except \t \n \r) before passing prompt to
  // spawnSync.
  it('strips null bytes and other C0 control characters from the prompt before spawn', () => {
    const claudeBlock = src.match(/function claudeSummarize[\s\S]{0,1500}/);
    expect(claudeBlock).toBeTruthy();
    if (claudeBlock) {
      // The sanitizer must reference the prompt arg AND the spawnSync call must
      // pass the sanitized version. Looking for the regex range that covers C0
      // controls minus \t (0x09) \n (0x0A) \r (0x0D).
      expect(claudeBlock[0]).toMatch(
        /\.replace\(\s*\/\[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F\]\/g\s*,\s*['"]['"]\s*\)/,
      );
      // The sanitized variable (not the raw `prompt`) must be what spawnSync
      // sends to claude CLI, otherwise the strip is dead code.
      const stripIdx = claudeBlock[0].search(
        /\.replace\(\s*\/\[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F\]\/g/,
      );
      const spawnIdx = claudeBlock[0].indexOf('spawnSync');
      expect(stripIdx).toBeGreaterThan(-1);
      expect(spawnIdx).toBeGreaterThan(stripIdx);
      const argvBlock = claudeBlock[0].slice(spawnIdx, spawnIdx + 400);
      expect(argvBlock).not.toMatch(/'-p',\s*prompt\b/);
    }
  });

  it('source file contains no literal U+0000 bytes', () => {
    // Editing the regex with a literal NUL inside source code (e.g.
    // /\x00/g rendered with an actual NUL) makes git treat the file as
    // binary, breaks diff review, and risks the source surviving but the
    // sanitizer logic being wrong on the next save. Source must use
    // backslash-x escape sequences only.
    const raw = fs.existsSync(SCRIPT_PATH) ? fs.readFileSync(SCRIPT_PATH) : Buffer.alloc(0);
    const nulCount = raw.filter((b) => b === 0).length;
    expect(nulCount).toBe(0);
  });
});

// Regression: 2026-04-12 #gap — script had bash-style ${VARNAME:-default} syntax
// embedded in JS template literals, causing SyntaxError at startup. Node.js cannot
// run a file that fails to parse. This suite catches any future syntax breakage
// before it reaches the scheduled task runner.
describe('manual-briefing-v3.js — JavaScript syntax validity', () => {
  it('parses without syntax errors (node --check)', () => {
    const result = spawnSync(process.execPath, ['--check', SCRIPT_PATH], {
      encoding: 'utf8',
      timeout: 10000,
    });
    expect(result.status, `node --check failed:\n${result.stderr}`).toBe(0);
  });

  it('contains no bash-style ${VAR:-default} expansion syntax', () => {
    const src = fs.existsSync(SCRIPT_PATH) ? fs.readFileSync(SCRIPT_PATH, 'utf-8') : '';
    // ${VARNAME:-anything} is bash default-value syntax. In JS template literals it
    // causes SyntaxError; in quoted strings it silently produces wrong paths.
    const bashExpansion = /\$\{[A-Z_]+:-/;
    expect(
      bashExpansion.test(src),
      'Found bash-style ${VAR:-default} syntax in a JS file. Use process.env.VAR || fallback instead.',
    ).toBe(false);
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
    // v2 had lines like: msg4Parts.push('1. Contact B — ITM Operating Agreement ...')
    // with literal names, dates, and fabricated content. Any push call whose
    // literal argument mentions a proper-name pattern + "—" is a regression.
    const badPattern =
      /msg4Parts\.push\([`'"][^`'"]*\b(Contact B|partner|Contact D|Contact E|PRIVATE_NAME|ContactC)\b[^`'"]*—/;
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
    const fn = src.match(/async function summarizeArticle[\s\S]{0,9000}/);
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

  // Regression: 2026-05-07. TechCrunch and similar sites return HTTP 200 with
  // promotional/nav text (8000+ chars) instead of article content. The old code
  // treated that as a valid body (>= 200 chars) so Claude received garbage and
  // refused. Guard: fetchArticleBody must have a junk-detection gate that returns
  // '' when the stripped text is navigation/promo content, forcing fallback to RSS.
  it('fetchArticleBody has a junk-content quality gate that returns empty for promo/nav text', () => {
    const fn = src.match(/async function fetchArticleBody[\s\S]{0,4000}/);
    expect(fn).toBeTruthy();
    if (fn) {
      // Must define a junkKeywords array
      expect(fn[0]).toContain('junkKeywords');
      // Must check junkHits against a threshold
      expect(fn[0]).toMatch(/junkHits\s*>=\s*\d/);
      // Must return '' (not empty content) when junk detected
      expect(fn[0]).toMatch(/if\s*\(junkHits.*\)\s*return\s*''/);
      // Must have the title-bar heuristic (pipe separator check)
      expect(fn[0]).toContain('pipeIdx');
      expect(fn[0]).toContain('hasProse');
    }
  });

  it('summarizeArticle threshold is <=50 chars so 403-blocked articles with RSS descriptions survive', () => {
    // 2026-05-07: threshold was 200 chars. TechCrunch/BBC return 403 so body
    // is empty; RSS descriptions are typically 80-150 chars. Everything was
    // being dropped, producing 0/12 news sections. Threshold must be <= 50.
    const fn = src.match(/async function summarizeArticle[\s\S]{0,2000}/);
    expect(fn).toBeTruthy();
    if (fn) {
      // Must have a fallback path for description-only content (no full body)
      expect(fn[0]).toContain('isDescOnly');
      // Threshold must be low enough to pass 80-char RSS descriptions
      const thresholdMatch = fn[0].match(/contextText\.length\s*<\s*(\d+)/);
      expect(thresholdMatch).toBeTruthy();
      if (thresholdMatch) {
        expect(parseInt(thresholdMatch[1], 10)).toBeLessThanOrEqual(50);
      }
    }
  });
});

describe('manual-briefing-v3.js — Desktop + home + data dir outputs', () => {
  let src: string;
  beforeAll(() => {
    src = fs.existsSync(SCRIPT_PATH) ? fs.readFileSync(SCRIPT_PATH, 'utf-8') : '';
  });

  it('writes to Desktop', () => {
    expect(src).toMatch(/Desktop[\\/]+briefing-/);
  });

  it('writes to data/briefings/', () => {
    expect(src).toMatch(/data[\\/]+briefings[\\/]+/);
  });

  it('writes to home directory', () => {
    expect(src).toMatch(/USERPROFILE|\$HOME|~[\\/].*briefing-/);
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
    // The briefing generator filters out system-issue rows (CI failures,
    // deploy failures, broken pipelines) before rendering -- they belong in
    // SYSTEM HEALTH, not in ExampleCo's action-item to-do list. Apply the same
    // filter here so the test reflects the actually-displayed contract.
    // Locked 2026-04-26 per feedback_system_issues_are_health_probes_not_action_items.md.
    let items;
    try {
      const ranker = require('../../../scripts/briefing-ranker.js');
      items = ranker.filterSystemIssues
        ? ranker.filterSystemIssues(data.unansweredEmails)
        : data.unansweredEmails;
    } catch {
      items = data.unansweredEmails;
    }
    for (const item of items) {
      expect(item.threadId).toBeDefined();
      // Accept either a Gmail hex thread id (16-20 hex chars) or a slug
      // identifier (subject-derived, used when the action item didn't
      // originate from a Gmail thread). Both produce a working
      // gmailUrl via gmailThreadUrl() in ec2-server.js -- hex routes to
      // #inbox/<id>, slug routes to a #search/subject query.
      expect(
        item.threadId,
        `${item.person}: threadId "${item.threadId}" must be hex (Gmail) or slug (subject)`,
      ).toMatch(/^([a-f0-9]+|[a-z][a-z0-9-]+)$/);
      // Action items can come from Gmail OR LinkedIn DMs (the linkedin-dm-scan
      // pipeline). Both produce a clickable URL via the same channel-aware
      // routing. Locked 2026-04-26.
      expect(
        item.gmailUrl,
        `${item.person}: gmailUrl must point to Gmail or LinkedIn messaging`,
      ).toMatch(/^https:\/\/(mail\.google\.com|www\.linkedin\.com)/);
    }
  });

  // Regression: 2026-04-11 #gap — Contact E commitment shipped in the 5:30
  // briefing even though Ed replied Apr 9 "I'll jump into ADP" which paused
  // the owner's promise. The openCommitments schema had no supersession check.
  // These tests enforce that every openCommitment ExampleCos enough metadata
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
    // Extended from 3000 chars to 8000 to cover the full function body --
    // the dismissal-pass + supersession-pass + ranker logic now spans more
    // than the original window. Locked 2026-04-26.
    const fn = src.match(/function loadActionItems[\s\S]{0,8000}/);
    expect(fn).toBeTruthy();
    if (fn) {
      expect(fn[0]).toContain('lastThreadMessageAt');
      expect(fn[0]).toContain('committedAt');
      expect(fn[0]).toMatch(/lastMsg\s*>\s*committed/);
    }
  });

  it('loadActionItems respects stillOpen:true as an operator override', () => {
    const fn = src.match(/function loadActionItems[\s\S]{0,8000}/);
    expect(fn).toBeTruthy();
    if (fn) expect(fn[0]).toContain('stillOpen');
  });
});
