import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const guardModulePath = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'scripts',
  'lib',
  'redial-guard.js',
);

type Guard = {
  assertNoRecentCall: (phone: string) => {
    allowed: boolean;
    priorCallIds: string[];
    damageControlCleared: boolean;
  };
  normalizePhone: (p: string | undefined | null) => string;
};

function loadGuard(): Guard {
  delete require.cache[require.resolve(guardModulePath)];
  return require(guardModulePath) as Guard;
}

let tmpRoot: string;
let originalAppdata: string | undefined;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'redial-guard-'));
  fs.mkdirSync(path.join(tmpRoot, 'secondbrain', 'data', 'calls'), { recursive: true });
  originalAppdata = process.env.APPDATA;
  process.env.APPDATA = tmpRoot;
});

afterEach(() => {
  process.env.APPDATA = originalAppdata;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeCall(
  id: string,
  phone: string,
  createdAt: string,
  opts: { endedReason?: string; ExampleCo_handled_damage_control?: boolean } = {},
) {
  const dir = path.join(tmpRoot, 'secondbrain', 'data', 'calls');
  fs.writeFileSync(
    path.join(dir, `${id}.json`),
    JSON.stringify({
      id,
      phoneNumber: phone,
      createdAt,
      endedReason: opts.endedReason ?? 'customer-ended-call',
      ...(opts.ExampleCo_handled_damage_control !== undefined
        ? { ExampleCo_handled_damage_control: opts.ExampleCo_handled_damage_control }
        : {}),
    }),
  );
}

describe('redial-guard (absolute ban)', () => {
  it('allows the first call to a number with no prior record', () => {
    const { assertNoRecentCall } = loadGuard();
    const r = assertNoRecentCall('+14696768024');
    expect(r.allowed).toBe(true);
    expect(r.priorCallIds).toEqual([]);
    expect(r.damageControlCleared).toBe(false);
  });

  it('blocks a redial when any prior call exists for the same number', () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    writeCall('prior-id', '+14696768024', oneHourAgo);
    const { assertNoRecentCall } = loadGuard();
    expect(() => assertNoRecentCall('+14696768024')).toThrowError(/BLOCKED/);
  });

  it('blocks even when the prior call is years old', () => {
    const yearsAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000 * 3).toISOString();
    writeCall('ancient', '+14696768024', yearsAgo);
    const { assertNoRecentCall } = loadGuard();
    expect(() => assertNoRecentCall('+14696768024')).toThrowError(/BLOCKED/);
  });

  it('ignores prior calls to different numbers', () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    writeCall('other-number-call', '+19725550000', oneHourAgo);
    const { assertNoRecentCall } = loadGuard();
    const r = assertNoRecentCall('+14696768024');
    expect(r.allowed).toBe(true);
  });

  it('clears the block ONLY when the prior call has ExampleCo_handled_damage_control=true', () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    writeCall('repaired', '+14696768024', oneHourAgo, { ExampleCo_handled_damage_control: true });
    const { assertNoRecentCall } = loadGuard();
    const r = assertNoRecentCall('+14696768024');
    expect(r.allowed).toBe(true);
    expect(r.damageControlCleared).toBe(true);
    expect(r.priorCallIds).toContain('repaired');
  });

  it('still blocks if at least one prior call has not been damage-controlled', () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    writeCall('repaired', '+14696768024', twoHoursAgo, { ExampleCo_handled_damage_control: true });
    writeCall('unresolved', '+14696768024', oneHourAgo);
    const { assertNoRecentCall } = loadGuard();
    expect(() => assertNoRecentCall('+14696768024')).toThrowError(/BLOCKED/);
  });

  it('normalizes phone formatting differences when matching', () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    writeCall('prior', '+1 (469) 676-8024', oneHourAgo);
    const { assertNoRecentCall } = loadGuard();
    expect(() => assertNoRecentCall('+14696768024')).toThrowError(/BLOCKED/);
  });

  it('rejects calls with no phone provided', () => {
    const { assertNoRecentCall } = loadGuard();
    expect(() => assertNoRecentCall('')).toThrowError(/phone is required/);
  });

  it('does NOT honor any environment-variable bypass', () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    writeCall('prior', '+14696768024', oneHourAgo);
    process.env.REDIAL_OVERRIDE_REASON = 'I want to redial';
    process.env.REDIAL_OVERRIDE = '1';
    process.env.FORCE_REDIAL = 'true';
    try {
      const { assertNoRecentCall } = loadGuard();
      expect(() => assertNoRecentCall('+14696768024')).toThrowError(/BLOCKED/);
    } finally {
      delete process.env.REDIAL_OVERRIDE_REASON;
      delete process.env.REDIAL_OVERRIDE;
      delete process.env.FORCE_REDIAL;
    }
  });
});

describe('redial-guard wiring in outbound call scripts', () => {
  const scriptsDir = path.resolve(__dirname, '..', '..', '..', 'scripts');

  // Scripts that place a phone-level Vapi call but are exempt from the
  // redial guard, each with a named reason. The guard is an ABSOLUTE,
  // never-expiring ban on redialing a number once any call record exists
  // for it (scripts/lib/redial-guard.js) -- correct for real outbound
  // scripts calling contacts/customers, but incompatible with a repeatable
  // regression harness that is designed to redial the SAME fixed number
  // (Amy's own inbound test line, ultimately reaching ExampleCo) after every
  // voice deploy. Wiring the guard in would permanently block the second
  // and every subsequent run.
  const REDIAL_GUARD_EXEMPT: Record<string, string> = {
    'vapi-self-call-status-test.js':
      "internal voice-regression harness added 2026-07-0x; it dials Amy's own " +
      'inbound test line (config.vapiInboundPhoneNumberId), not a contact or ' +
      'customer, and is meant to be re-run after every voice deploy. The ' +
      "redial guard's ban never expires, so wiring it in would make this " +
      'test un-runnable a second time. Re-enable this guard requirement if ' +
      'the script is ever repointed at a real contact number.',
  };

  it('every outbound Vapi call script imports the guard and calls assertNoRecentCall', () => {
    const entries = fs.readdirSync(scriptsDir).filter((f) => f.endsWith('.js'));
    const missing: string[] = [];
    for (const name of entries) {
      if (REDIAL_GUARD_EXEMPT[name]) continue;
      const p = path.join(scriptsDir, name);
      const src = fs.readFileSync(p, 'utf8');
      const placesCall = src.includes('api.vapi.ai/call/phone');
      if (!placesCall) continue;
      const importsGuard =
        src.includes("require('./lib/redial-guard')") ||
        src.includes('require("./lib/redial-guard")');
      const usesGuard = src.includes('assertNoRecentCall(');
      if (!importsGuard || !usesGuard) {
        missing.push(name);
      }
    }
    if (missing.length > 0) {
      throw new Error(
        `Outbound Vapi scripts must require('./lib/redial-guard') and call assertNoRecentCall(phone) before placing the call. Missing in: ${missing.join(', ')}`,
      );
    }
  });

  it("every REDIAL_GUARD_EXEMPT entry still exists and still calls Vapi (allowlist doesn't rot)", () => {
    for (const name of Object.keys(REDIAL_GUARD_EXEMPT)) {
      const p = path.join(scriptsDir, name);
      expect(fs.existsSync(p), `${name} no longer exists; remove its exemption`).toBe(true);
      const src = fs.readFileSync(p, 'utf8');
      expect(
        src.includes('api.vapi.ai/call/phone'),
        `${name} no longer places a Vapi call; remove its exemption`,
      ).toBe(true);
    }
  });
});
