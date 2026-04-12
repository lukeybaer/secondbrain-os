/**
 * Tests for src/main/caller-id.ts
 *
 * Strategy:
 *  - Mock `electron` (app.getPath) and `fs` so no real disk I/O occurs
 *  - Test phone normalization, caller identification, and context building
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import os from 'os';

// ---------------------------------------------------------------------------
// vi.hoisted — values needed before vi.mock factories run
// ---------------------------------------------------------------------------

const { TEST_USER_DATA } = vi.hoisted(() => {
  const _os = require('os') as typeof import('os');
  const _path = require('path') as typeof import('path');
  return { TEST_USER_DATA: _path.join(_os.tmpdir(), 'sb-caller-id-test') };
});

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return TEST_USER_DATA;
      return os.tmpdir();
    },
  },
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => false), // default: no contacts file on disk
    readFileSync: vi.fn(() => '{}'),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Module under test
// ---------------------------------------------------------------------------

import {
  identifyCaller,
  loadContactsStore,
  injectCallerContext,
  type Contact,
  type ContactsStore,
} from '../src/main/caller-id';
import * as fs from 'fs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStore(overrides: Partial<ContactsStore> = {}): ContactsStore {
  return {
    owner_phones: ['+15555550101'],
    keyword: 'KEYWORD',
    contacts: [],
    last_updated: new Date().toISOString(),
    ...overrides,
  };
}

function makeContact(overrides: Partial<Contact> = {}): Contact {
  return {
    name: 'Test Contact',
    phones: ['+15551234567'],
    emails: [],
    relationship: 'Test',
    style: 'casual',
    active_goals: ['goal one'],
    ok_topics: ['topic one'],
    restricted_topics: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/** Install the test fixture store as the simulated contacts.json on disk. */
function installFixtureStore(store: ContactsStore = makeStore()): void {
  vi.mocked(fs.existsSync).mockReturnValue(true);
  vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(store));
}

describe('loadContactsStore', () => {
  it('returns empty default store when no file exists', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const store = loadContactsStore();
    // Post-2026-04-11 sanitization: hardcoded seed removed. Fresh installs
    // return empty defaults and the user populates contacts themselves.
    expect(store.owner_phones).toEqual([]);
    expect(store.keyword).toBe('');
    expect(store.contacts).toEqual([]);
  });

  it('returns parsed store when file exists', () => {
    const customStore = makeStore({ keyword: 'Excalibur', contacts: [] });
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(customStore));
    const store = loadContactsStore();
    expect(store.keyword).toBe('Excalibur');
  });

  it('falls back to empty default on parse error', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('{ bad json ]');
    const store = loadContactsStore();
    expect(store.keyword).toBe(''); // empty default after seed removal
  });
});

describe('identifyCaller', () => {
  beforeEach(() => {
    installFixtureStore(); // default fixture with owner phone +15555550101 and KEYWORD
  });

  it("returns owner mode for the owner's main number (exact match)", () => {
    const ctx = identifyCaller('+15555550101');
    expect(ctx.mode).toBe('owner');
    expect(ctx.systemPromptSection).toContain('OWNER');
  });

  it("returns owner mode for the owner's number with formatting", () => {
    const ctx = identifyCaller('(555) 555-0101');
    expect(ctx.mode).toBe('owner');
  });

  it('returns owner mode for 10-digit number without country code', () => {
    const ctx = identifyCaller('5555550101');
    expect(ctx.mode).toBe('owner');
  });

  it('returns unknown mode for empty phone', () => {
    const ctx = identifyCaller('');
    expect(ctx.mode).toBe('unknown');
  });

  it('returns unknown mode for unrecognized number', () => {
    const ctx = identifyCaller('+15559999999');
    expect(ctx.mode).toBe('unknown');
    expect(ctx.systemPromptSection).toContain('UNKNOWN');
  });

  it('returns known_contact mode for a contact phone', () => {
    const contact = makeContact({ name: 'Contact B', phones: ['+15555550102'] });
    const store = makeStore({ contacts: [contact] });
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(store));

    const ctx = identifyCaller('+15555550102');
    expect(ctx.mode).toBe('known_contact');
    expect(ctx.contact?.name).toBe('Contact B');
    expect(ctx.systemPromptSection).toContain('KNOWN CONTACT');
    expect(ctx.systemPromptSection).toContain('Contact B');
  });

  it('matches contact phone with formatting differences', () => {
    const contact = makeContact({ name: 'ContactA', phones: ['+15555550103'] });
    const store = makeStore({ contacts: [contact] });
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(store));

    const ctx = identifyCaller('(555) 555-0103'); // same number, different formatting
    expect(ctx.mode).toBe('known_contact');
    expect(ctx.contact?.name).toBe('ContactA');
  });

  it('contact with no phones returns unknown', () => {
    const contact = makeContact({ name: 'No Phone', phones: [] });
    const store = makeStore({ contacts: [contact] });
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(store));

    const ctx = identifyCaller('+15550000001');
    expect(ctx.mode).toBe('unknown');
  });
});

describe('identifyCaller — context content', () => {
  it('unknown context includes keyword in prompt when keyword is configured', () => {
    installFixtureStore();
    const ctx = identifyCaller('+15559998888');
    expect(ctx.systemPromptSection).toContain('KEYWORD');
    expect(ctx.systemPromptSection).toContain('message');
  });

  it('owner context includes full access message', () => {
    installFixtureStore();
    const ctx = identifyCaller('+15555550101');
    expect(ctx.systemPromptSection).toContain('full access');
  });

  it('known_contact context includes active goals', () => {
    const contact = makeContact({
      name: 'Alice',
      phones: ['+15550001111'],
      active_goals: ['ProjectA launch'],
    });
    const store = makeStore({ contacts: [contact] });
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(store));

    const ctx = identifyCaller('+15550001111');
    expect(ctx.systemPromptSection).toContain('ProjectA launch');
  });

  it('known_contact context includes compartmentalization rules', () => {
    const contact = makeContact({ phones: ['+15550002222'] });
    const store = makeStore({ contacts: [contact] });
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(store));

    const ctx = identifyCaller('+15550002222');
    expect(ctx.systemPromptSection).toContain('NEVER share');
  });
});

describe('injectCallerContext', () => {
  it('prepends caller context to base prompt', () => {
    installFixtureStore();
    const result = injectCallerContext('Base prompt here.', '+15555550101');
    expect(result).toContain('OWNER');
    expect(result).toContain('Base prompt here.');
    // Owner context should come first
    expect(result.indexOf('OWNER')).toBeLessThan(result.indexOf('Base prompt here.'));
  });

  it('handles unknown caller in injection', () => {
    installFixtureStore();
    const result = injectCallerContext('Base.', '+15559999999');
    expect(result).toContain('UNKNOWN');
    expect(result).toContain('Base.');
  });
});
