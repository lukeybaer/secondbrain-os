import { describe, it, expect, vi } from 'vitest';
import os from 'os';

// pii-scanner -> telegram -> config reads app.getPath at module load; in the
// node test env electron has no app, so stub it. scanForPii itself is pure.
vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
}));

import { scanForPii } from '../pii-scanner';

// pii-scanner is wired into production at ipc-handlers.ts (scanAndAlert on
// incoming text) yet had zero coverage. People-privacy is zero-tolerance for
// Amy, so this locks the detection CATEGORIES, the redaction guarantee (an
// alert must never echo the raw secret), the known-safe filters, and the
// overlapping-detection dedup fix. Tests encode the category, not one literal
// trigger, per feedback_frugal_regression_tests.

const types = (text: string) => scanForPii(text).map((d) => d.piiType);

describe('scanForPii detection categories', () => {
  it('detects a Social Security Number', () => {
    expect(types('his ssn is 123-45-6789 ok')).toContain('SSN');
  });

  it('detects a credit card number (Visa/Mastercard/Amex shapes)', () => {
    expect(types('card 4111111111111111 expires soon')).toContain('Credit Card');
    expect(types('amex 378282246310005 charged')).toContain('Credit Card');
  });

  it('detects an email address', () => {
    expect(types('reach me at jane.doe@example.com please')).toContain('Email');
  });

  it('detects a US phone number across separator styles', () => {
    expect(types('call (15550000000 today')).toContain('Phone (US)');
    expect(types('call 15550000000 today')).toContain('Phone (US)');
  });

  it('detects a public IP address', () => {
    expect(types('server at 203.0.113.45 responded')).toContain('IP Address');
  });

  it('detects a labeled bank account and routing number', () => {
    expect(types('account #: 1234567890 here')).toContain('Bank Account');
    expect(types('routing 021000021 set')).toContain('Routing Number');
  });
});

describe('redaction guarantee (the alert must not leak the secret)', () => {
  it('never includes the full raw value in the snippet', () => {
    const raw = '123-45-6789';
    const [det] = scanForPii(`ssn ${raw} end`);
    expect(det).toBeTruthy();
    expect(det.snippet).not.toContain(raw);
  });

  it('masks the interior of an email while keeping a context window', () => {
    const raw = 'jane.doe@example.com';
    const [det] = scanForPii(`mail ${raw} thanks`);
    expect(det.snippet).not.toContain(raw);
    // redaction keeps first+last char with a *** core
    expect(det.snippet).toContain('***');
  });
});

describe('known-safe filters suppress non-PII IPs', () => {
  it('does not flag localhost or private-network IPs', () => {
    expect(types('bound to 127.0.0.1 locally')).not.toContain('IP Address');
    expect(types('lan host 192.168.1.50 up')).not.toContain('IP Address');
    expect(types('vpc node 10.0.4.7 ready')).not.toContain('IP Address');
  });
});

describe('overlapping-detection dedup (single token, single alert)', () => {
  it('reports one alphanumeric ID token only once, not as both Passport and Driver License', () => {
    // "AB123456" matches Passport ([A-Z]{1,2}\d{6,9}) AND Driver License
    // ([A-Z]{1,2}\d{5,8}); the fix collapses the overlapping spans.
    const det = scanForPii('license AB123456 on file');
    const idHits = det.filter((d) => d.piiType === 'Passport' || d.piiType === 'Driver License');
    expect(idHits.length).toBe(1);
  });

  it('keeps distinct PII that occur at non-overlapping positions', () => {
    const t = types('ssn 123-45-6789 and email a@b.co both present');
    expect(t).toContain('SSN');
    expect(t).toContain('Email');
  });
});

describe('non-detection cases', () => {
  it('returns no detections for empty or whitespace input', () => {
    expect(scanForPii('')).toEqual([]);
    expect(scanForPii('   \n\t ')).toEqual([]);
  });

  it('returns no detections for benign prose with no PII', () => {
    expect(scanForPii('The quarterly briefing covered three projects.')).toEqual([]);
  });
});
