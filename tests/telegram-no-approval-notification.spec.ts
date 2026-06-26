/**
 * Regression guard: clicking Approve or Reject on the briefing dashboard
 * MUST NOT send a Telegram message. Per ExampleCo 2026-04-28 + the canonical
 * feedback_telegram_policy.md "Don't send notifications of activity on
 * telegram like something is approved or declined."
 *
 * The /briefing/approve and /briefing/reject POST handlers in ec2-server.js
 * must NOT call sendMessage in their success paths. Audit trail stays in
 * briefing-actions.jsonl + the dashboard re-render.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SERVER = path.join(__dirname, '..', 'ec2-server.js');

describe('Telegram silence on approve/reject', () => {
  const src = fs.readFileSync(SERVER, 'utf8');

  it('/briefing/approve POST does not call sendMessage', () => {
    const start = src.indexOf("if (urlPath === '/briefing/approve' && req.method === 'POST')");
    expect(start).toBeGreaterThan(0);
    const end = src.indexOf("if (urlPath === '/briefing/reject'", start);
    expect(end).toBeGreaterThan(start);
    const block = src.slice(start, end);
    expect(block).not.toMatch(/sendMessage\(/);
    // Audit trail still required.
    expect(block).toMatch(/logBriefingAction/);
  });

  it('/briefing/reject POST does not call sendMessage', () => {
    const start = src.indexOf("if (urlPath === '/briefing/reject' && req.method === 'POST')");
    expect(start).toBeGreaterThan(0);
    const end = src.indexOf("if (urlPath === '/briefing/test-action'", start);
    expect(end).toBeGreaterThan(start);
    const block = src.slice(start, end);
    expect(block).not.toMatch(/sendMessage\(/);
    expect(block).toMatch(/logBriefingAction/);
  });
});
