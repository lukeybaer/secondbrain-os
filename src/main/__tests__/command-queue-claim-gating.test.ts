/**
 * Regression guard for the double-execution bug Codex flagged on 2026-06-01.
 *
 * Category: the desktop-app command worker must execute a command ONLY when it
 * actually won the claim. The prior code POSTed /claim but ignored the
 * response, so when the always-on EC2 dispatch-processor forwarded a stale
 * command (atomic pending->forwarded, returns 409 to a late claim), the PC
 * worker would still run it, executing the same command twice.
 */

import { describe, it, expect } from 'vitest';
import { claimSucceeded } from '../command-queue-claim';

describe('claimSucceeded (no execution unless the claim is won)', () => {
  it('executes only on a 200 claim', () => {
    expect(claimSucceeded(200)).toBe(true);
  });

  it('does NOT execute on 409 (command forwarded or already claimed)', () => {
    expect(claimSucceeded(409)).toBe(false);
  });

  it('does NOT execute on 404 (command vanished from the queue)', () => {
    expect(claimSucceeded(404)).toBe(false);
  });

  it('does NOT execute on a 5xx server error', () => {
    expect(claimSucceeded(500)).toBe(false);
  });
});
