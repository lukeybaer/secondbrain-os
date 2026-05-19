import { describe, expect, it } from 'vitest';
import {
  containsSensitiveText,
  evaluateApprovalPolicy,
} from '../security/approval-policy';

describe('approval policy', () => {
  it('treats renderer actions as already approved while still high risk', () => {
    const decision = evaluateApprovalPolicy({
      actor: 'renderer',
      source: 'renderer:sms:send',
      action: 'send_sms',
      summary: 'Send SMS',
    });

    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(false);
    expect(decision.riskLevel).toBe('high');
  });

  it('requires approval for AI/tool/external sends, calls, and task execution', () => {
    for (const action of ['send_sms', 'initiate_call', 'run_task']) {
      const decision = evaluateApprovalPolicy({
        actor: 'ai',
        source: 'vapi:test',
        action,
        summary: action,
      });

      expect(decision.allowed).toBe(false);
      expect(decision.requiresApproval).toBe(true);
    }
  });

  it('allows a high-risk external action after an owner approval is attached', () => {
    const decision = evaluateApprovalPolicy({
      actor: 'external',
      source: 'http:/calls/initiate',
      action: 'initiate_call',
      summary: 'Call someone',
      approved: true,
      approvalId: 'appr_test',
    });

    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(false);
  });

  it('detects common PII in text and upgrades low-risk AI reads to approval required', () => {
    expect(containsSensitiveText('Email me at person@example.com')).toBe(true);

    const decision = evaluateApprovalPolicy({
      actor: 'ai',
      source: 'vapi:query',
      action: 'query_knowledge',
      summary: 'Answer caller question',
      text: 'The answer includes person@example.com',
    });

    expect(decision.allowed).toBe(false);
    expect(decision.requiresApproval).toBe(true);
  });
});
