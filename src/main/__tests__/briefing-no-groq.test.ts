/**
 * briefing-no-groq.test.ts
 *
 * Regression: briefing.ts was using Groq (paid, llama-3.1-8b-instant) for
 * article summarization even though EC2 has claude CLI available for free via
 * Max plan. This test ensures Groq is never imported or called in briefing.ts.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const BRIEFING_SRC = path.resolve(__dirname, '..', 'briefing.ts');

describe('briefing.ts — no paid LLM calls', () => {
  let src: string;

  beforeAll(() => {
    src = fs.readFileSync(BRIEFING_SRC, 'utf-8');
  });

  it('does not call api.groq.com', () => {
    expect(src).not.toContain('api.groq.com');
  });

  it('does not import or use groqApiKey for summarization', () => {
    // groqApiKey may still exist in config interface — but it must not be used
    // in any https.request call for summarization
    const groqHttpCallPattern = /https\.request[\s\S]{0,200}api\.groq\.com/;
    expect(groqHttpCallPattern.test(src)).toBe(false);
  });

  it('uses runClaudeCode from claude-runner for summarization', () => {
    expect(src).toContain("import { runClaudeCode } from './claude-runner'");
    expect(src).toContain('runClaudeCode(prompt');
  });

  it('does not call api.openai.com directly for summarization', () => {
    // openai may be used for Whisper transcription elsewhere but not in briefing
    expect(src).not.toContain('api.openai.com');
  });
});

describe('ec2-server.js — briefing uses local claude CLI', () => {
  let src: string;

  beforeAll(() => {
    const serverPath = path.resolve(__dirname, '..', '..', '..', '..', 'ec2-server.js');
    src = fs.existsSync(serverPath) ? fs.readFileSync(serverPath, 'utf-8') : '';
  });

  it('summarizeWithGroq delegates to summarizeWithClaude', () => {
    if (!src) return; // skip if file not present in this env
    expect(src).toContain('return summarizeWithClaude(headlines, prompt)');
  });

  it('summarizeWithClaude uses spawn claude CLI not Groq API', () => {
    if (!src) return;
    expect(src).toContain("spawn('claude'");
    // Must NOT contain a direct Groq API call inside summarizeWithClaude
    const claudeFnMatch = src.match(/async function summarizeWithClaude[\s\S]{0,600}/);
    if (claudeFnMatch) {
      expect(claudeFnMatch[0]).not.toContain('api.groq.com');
    }
  });

  it('summarizeWithClaude detects auth failure and falls back to raw headlines', () => {
    // Regression: claude CLI on EC2 was unauthenticated and returning
    // "Not logged in · Please run /login" as stdout — which was then shipped
    // to Luke as the briefing content. The function must detect login failure
    // strings and fall back to raw numbered headlines.
    if (!src) return;
    const claudeFnMatch = src.match(/async function summarizeWithClaude[\s\S]{0,1200}/);
    expect(claudeFnMatch).toBeTruthy();
    if (claudeFnMatch) {
      expect(claudeFnMatch[0]).toMatch(/not logged in|please run/i);
      expect(claudeFnMatch[0]).toContain('falling back');
    }
  });
});

describe('ec2-server.js — briefing MUST include news sections', () => {
  // Regression 2026-04-10: sendDailyBriefing was refactored into a "6-section"
  // format on Apr 6 and the news fetching was silently dropped. The briefing
  // on 2026-04-10 shipped as 119 characters ("Good morning... Reply with questions")
  // because every section was conditional and all conditions were false.
  // This test guarantees sendDailyBriefing ALWAYS wires up world + AI news.
  let src: string;

  beforeAll(() => {
    const serverPath = path.resolve(__dirname, '..', '..', '..', '..', 'ec2-server.js');
    src = fs.existsSync(serverPath) ? fs.readFileSync(serverPath, 'utf-8') : '';
  });

  it('sendDailyBriefing calls fetchNewsHeadlines', () => {
    if (!src) return;
    const fn = src.match(/async function sendDailyBriefing[\s\S]*?\n\}\n/);
    expect(fn).toBeTruthy();
    if (fn) expect(fn[0]).toContain('fetchNewsHeadlines(');
  });

  it('sendDailyBriefing calls fetchAITechNews', () => {
    if (!src) return;
    const fn = src.match(/async function sendDailyBriefing[\s\S]*?\n\}\n/);
    if (fn) expect(fn[0]).toContain('fetchAITechNews(');
  });

  it('sendDailyBriefing pushes a WORLD NEWS section', () => {
    if (!src) return;
    const fn = src.match(/async function sendDailyBriefing[\s\S]*?\n\}\n/);
    if (fn) expect(fn[0]).toMatch(/sections\.push\(['"`]\s*\\n?WORLD NEWS/);
  });

  it('sendDailyBriefing pushes an AI & TECH section', () => {
    if (!src) return;
    const fn = src.match(/async function sendDailyBriefing[\s\S]*?\n\}\n/);
    if (fn) expect(fn[0]).toMatch(/sections\.push\(['"`]\s*\\n?AI & TECH/);
  });

  it('fetchNewsHeadlines is not dead code — it has a caller', () => {
    if (!src) return;
    // Count non-definition references to fetchNewsHeadlines
    const refs = (src.match(/fetchNewsHeadlines\(/g) || []).length;
    // Should be at least 2: the definition call-position + at least one caller
    expect(refs).toBeGreaterThanOrEqual(2);
  });

  it('fetchAITechNews is not dead code — it has a caller', () => {
    if (!src) return;
    const refs = (src.match(/fetchAITechNews\(/g) || []).length;
    expect(refs).toBeGreaterThanOrEqual(2);
  });
});
