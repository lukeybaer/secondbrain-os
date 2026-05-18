/**
 * Tests for task-extract.ts, smart #amy dispatch extraction.
 *
 * config is mocked (no electron); fetch is mocked (no network). Covers the
 * safe-fallback paths (empty input, no API key, HTTP error, garbage response)
 * and the confident happy path.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mockConfig: { openaiApiKey: string; openaiLightModel: string } = {
  openaiApiKey: '',
  openaiLightModel: 'gpt-4o-mini',
};

vi.mock('../config', () => ({
  getConfig: () => mockConfig,
}));

import { extractDispatch } from '../task-extract';

beforeEach(() => {
  mockConfig.openaiApiKey = '';
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(impl: () => Promise<unknown>): void {
  vi.stubGlobal('fetch', vi.fn(impl) as unknown as typeof fetch);
}

describe('extractDispatch fallbacks (never auto-run on uncertainty)', () => {
  it('empty input is not confident', async () => {
    const r = await extractDispatch('   ');
    expect(r.confident).toBe(false);
    expect(r.prompt).toBe('');
  });

  it('with no API key, returns the raw text NOT confident', async () => {
    const r = await extractDispatch('do the thing');
    expect(r.confident).toBe(false);
    expect(r.prompt).toBe('do the thing');
  });

  it('an HTTP error falls back to NOT confident', async () => {
    mockConfig.openaiApiKey = 'sk-test';
    stubFetch(async () => ({ ok: false, status: 500 }));
    const r = await extractDispatch('do the thing');
    expect(r.confident).toBe(false);
  });

  it('a garbage response body falls back to NOT confident', async () => {
    mockConfig.openaiApiKey = 'sk-test';
    stubFetch(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'not json' } }] }),
    }));
    const r = await extractDispatch('do the thing');
    expect(r.confident).toBe(false);
  });
});

describe('extractDispatch confident path', () => {
  it('returns the cleaned instruction and confident=true', async () => {
    mockConfig.openaiApiKey = 'sk-test';
    stubFetch(async () => ({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                instruction: 'Email Bryant the Q3 deck.',
                confident: true,
                reason: 'clear actionable request',
              }),
            },
          },
        ],
      }),
    }));
    const r = await extractDispatch('hashtag amy uh send bryant the the deck');
    expect(r.prompt).toBe('Email Bryant the Q3 deck.');
    expect(r.confident).toBe(true);
  });

  it('honors confident=false from the model even when an instruction is returned', async () => {
    mockConfig.openaiApiKey = 'sk-test';
    stubFetch(async () => ({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                instruction: 'Possibly approve something.',
                confident: false,
                reason: 'too garbled to be sure',
              }),
            },
          },
        ],
      }),
    }));
    const r = await extractDispatch('you Hashtag Amy and I approve the second one I I');
    expect(r.confident).toBe(false);
    expect(r.prompt).toBe('Possibly approve something.');
  });
});
