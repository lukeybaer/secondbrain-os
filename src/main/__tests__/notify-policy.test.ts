/**
 * Tests for notify-policy.ts, the Telegram notification allowlist.
 *
 * Only four categories plus interactive approvals may reach Luke. Everything
 * else (errors, service-down alerts, status chatter) is dropped.
 */

import { describe, it, expect } from 'vitest';
import { isNotifyCategoryAllowed, ALLOWED_CATEGORIES } from '../notify-policy';

describe('isNotifyCategoryAllowed', () => {
  it('allows the four notification categories plus approval', () => {
    expect(isNotifyCategoryAllowed('dispatch_complete')).toBe(true);
    expect(isNotifyCategoryAllowed('video_regen')).toBe(true);
    expect(isNotifyCategoryAllowed('briefing_ready')).toBe(true);
    expect(isNotifyCategoryAllowed('question_answer')).toBe(true);
    expect(isNotifyCategoryAllowed('approval')).toBe(true);
  });

  it('drops anything uncategorized or off-allowlist', () => {
    expect(isNotifyCategoryAllowed(undefined)).toBe(false);
    expect(isNotifyCategoryAllowed('')).toBe(false);
    expect(isNotifyCategoryAllowed('error')).toBe(false);
    expect(isNotifyCategoryAllowed('service_down')).toBe(false);
    expect(isNotifyCategoryAllowed('reputation_risk')).toBe(false);
    expect(isNotifyCategoryAllowed('status_update')).toBe(false);
  });

  it('the allowlist is exactly five entries', () => {
    expect(ALLOWED_CATEGORIES.size).toBe(5);
  });
});
