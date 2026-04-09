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
});
