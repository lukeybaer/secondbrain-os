/**
 * Tests for notify-policy.ts, the Telegram notification allowlist.
 *
 * Only ExampleCo-initiated answers, PII/security, video-ready, and voice follow-up
 * may reach ExampleCo. Everything else
 * (briefings, task completions, service-down alerts, status chatter) is
 * dropped.
 */

import { describe, it, expect } from 'vitest';
import { isNotifyCategoryAllowed, ALLOWED_CATEGORIES } from '../notify-policy';

describe('isNotifyCategoryAllowed', () => {
  it('allows only the selective Telegram interruption categories', () => {
    expect(isNotifyCategoryAllowed('question_answer')).toBe(true);
    expect(isNotifyCategoryAllowed('security')).toBe(true);
    expect(isNotifyCategoryAllowed('pii')).toBe(true);
    expect(isNotifyCategoryAllowed('video_ready')).toBe(true);
    expect(isNotifyCategoryAllowed('voice_followup')).toBe(true);
  });

  it('drops anything uncategorized or off-allowlist', () => {
    expect(isNotifyCategoryAllowed(undefined)).toBe(false);
    expect(isNotifyCategoryAllowed('')).toBe(false);
    expect(isNotifyCategoryAllowed('approval')).toBe(false);
    expect(isNotifyCategoryAllowed('dispatch_complete')).toBe(false);
    expect(isNotifyCategoryAllowed('video_regen')).toBe(false);
    expect(isNotifyCategoryAllowed('briefing_ready')).toBe(false);
    expect(isNotifyCategoryAllowed('error')).toBe(false);
    expect(isNotifyCategoryAllowed('service_down')).toBe(false);
    expect(isNotifyCategoryAllowed('reputation_risk')).toBe(false);
    expect(isNotifyCategoryAllowed('status_update')).toBe(false);
  });

  it('the allowlist is exactly five entries', () => {
    expect(ALLOWED_CATEGORIES.size).toBe(5);
  });
});
