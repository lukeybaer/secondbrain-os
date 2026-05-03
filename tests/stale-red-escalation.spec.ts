/**
 * Regression guard: 2026-04-20 , stale-RED escalation must detect probes
 * that have been RED for 3+ consecutive days.
 *
 * On 2026-04-20 the owner woke up to a briefing that flagged staleUploads RED
 * (18 days since approval) and CI RED (5 days). Both had been in the briefing
 * every morning. Neither had a louder escalation path. The daily briefing
 * line was not moving the needle; detection without escalation is a status
 * board, not an EA. This test locks the escalation logic.
 *
 * Memory: secondbrain/memory/feedback_canautoheal_false_is_not_a_heal.md
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import {
  computeStaleRedProbes,
  hasExistingEscalation,
  logEscalation,
  daysAgoStr,
  STALE_DAYS,
} from '../scripts/stale-red-escalation.js';

describe('stale-red-escalation (2026-04-20)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-red-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeDiag(daysBack: number, checks: Record<string, any>) {
    const d = new Date();
    d.setDate(d.getDate() - daysBack);
    const date = d.toISOString().slice(0, 10);
    fs.writeFileSync(
      path.join(tmpDir, `pre-briefing-diagnostic-${date}.json`),
      JSON.stringify({ date, checks }),
    );
  }

  it('exports expected API', () => {
    expect(typeof computeStaleRedProbes).toBe('function');
    expect(typeof hasExistingEscalation).toBe('function');
    expect(typeof logEscalation).toBe('function');
    expect(STALE_DAYS).toBe(3);
  });

  it('detects a probe that was RED for 4 consecutive days (3 + today)', () => {
    const checks = {
      staleUploads: { status: 'red', detail: '3 stuck', canAutoHeal: false },
      backups: { status: 'green' },
    };
    for (let i = 0; i <= STALE_DAYS; i++) writeDiag(i, checks);
    const r = computeStaleRedProbes(tmpDir);
    expect(r.error).toBeUndefined();
    expect(r.stale).toBeDefined();
    expect(r.stale.length).toBe(1);
    expect(r.stale[0].probe).toBe('staleUploads');
    expect(r.stale[0].streakDays).toBe(STALE_DAYS + 1);
    expect(r.stale[0].canAutoHeal).toBe(false);
  });

  it('does NOT flag a probe that was GREEN on any day in the window', () => {
    const red = { status: 'red', detail: 'x' };
    const green = { status: 'green' };
    for (let i = 0; i <= STALE_DAYS; i++) {
      writeDiag(i, { staleUploads: i === 2 ? green : red });
    }
    const r = computeStaleRedProbes(tmpDir);
    expect(r.error).toBeUndefined();
    expect(r.stale).toEqual([]);
  });

  it('returns error when a diagnostic in the window is missing', () => {
    const checks = { staleUploads: { status: 'red' } };
    // Write only today and day-1, leave gap
    writeDiag(0, checks);
    writeDiag(1, checks);
    const r = computeStaleRedProbes(tmpDir);
    expect(r.error).toBeTruthy();
    expect(r.error).toMatch(/missing diagnostic/);
  });

  it('preserves canAutoHeal flag in the escalation record', () => {
    const checks = {
      ec2: { status: 'red', detail: 'unreachable', canAutoHeal: false },
      backups: { status: 'red', detail: 'stale', canAutoHeal: true },
    };
    for (let i = 0; i <= STALE_DAYS; i++) writeDiag(i, checks);
    const r = computeStaleRedProbes(tmpDir);
    const ec2 = r.stale.find((s: any) => s.probe === 'ec2');
    const backups = r.stale.find((s: any) => s.probe === 'backups');
    expect(ec2.canAutoHeal).toBe(false);
    expect(backups.canAutoHeal).toBe(true);
  });

  it('hasExistingEscalation de-dupes within 24h window', () => {
    const logPath = path.join(tmpDir, 'escalations.jsonl');
    logEscalation(logPath, {
      ts: new Date().toISOString(),
      probe: 'staleUploads',
      streakDays: 4,
      detail: 'x',
      canAutoHeal: false,
      firstRedDate: '2026-04-17',
      drafted: { drafted: true },
    });
    expect(hasExistingEscalation(logPath, 'staleUploads')).toBe(true);
    expect(hasExistingEscalation(logPath, 'ec2')).toBe(false);
  });

  it('hasExistingEscalation returns false for entries older than 24h', () => {
    const logPath = path.join(tmpDir, 'escalations.jsonl');
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString();
    logEscalation(logPath, {
      ts: twoDaysAgo,
      probe: 'staleUploads',
      streakDays: 4,
      detail: 'x',
      canAutoHeal: false,
      firstRedDate: '2026-04-15',
      drafted: { drafted: true },
    });
    expect(hasExistingEscalation(logPath, 'staleUploads')).toBe(false);
  });

  it('daysAgoStr returns YYYY-MM-DD format', () => {
    expect(daysAgoStr(0)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(daysAgoStr(3)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
