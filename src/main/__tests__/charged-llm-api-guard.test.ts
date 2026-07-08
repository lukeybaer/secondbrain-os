import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  canUseChargedLlmApi,
  hasChargedLlmApiApproval,
  hasCodexDownProof,
} from '../charged-llm-api-guard';

const OLD_CODEX_DOWN = process.env.AMY_CODEX_DOWN_PROVEN;
const OLD_APPROVED_UNTIL = process.env.AMY_CHARGED_LLM_API_APPROVED_UNTIL;

afterEach(() => {
  if (OLD_CODEX_DOWN == null) delete process.env.AMY_CODEX_DOWN_PROVEN;
  else process.env.AMY_CODEX_DOWN_PROVEN = OLD_CODEX_DOWN;
  if (OLD_APPROVED_UNTIL == null) delete process.env.AMY_CHARGED_LLM_API_APPROVED_UNTIL;
  else process.env.AMY_CHARGED_LLM_API_APPROVED_UNTIL = OLD_APPROVED_UNTIL;
  vi.restoreAllMocks();
});

describe('charged LLM API guard', () => {
  it('requires both Codex-down proof and ExampleCo approval', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(canUseChargedLlmApi({ surface: 'test' })).toBe(false);
    expect(warn.mock.calls.at(-1)?.[0]).toContain('Codex is not proven down');

    process.env.AMY_CODEX_DOWN_PROVEN = '1';
    expect(canUseChargedLlmApi({ surface: 'test' })).toBe(false);
    expect(warn.mock.calls.at(-1)?.[0]).toContain('pending ExampleCo explicit approval');

    process.env.AMY_CHARGED_LLM_API_APPROVED_UNTIL = new Date(Date.now() + 60_000).toISOString();
    expect(canUseChargedLlmApi({ surface: 'test' })).toBe(true);
  });

  it('accepts explicit approval and explicit Codex-down proof', () => {
    expect(
      canUseChargedLlmApi({
        codexDown: true,
        explicitApproval: true,
        surface: 'test-explicit',
      }),
    ).toBe(true);
  });

  it('treats expired approval as absent', () => {
    process.env.AMY_CODEX_DOWN_PROVEN = 'true';
    process.env.AMY_CHARGED_LLM_API_APPROVED_UNTIL = new Date(Date.now() - 60_000).toISOString();
    expect(hasCodexDownProof()).toBe(true);
    expect(hasChargedLlmApiApproval()).toBe(false);
    expect(canUseChargedLlmApi({ surface: 'test-expired' })).toBe(false);
  });
});
