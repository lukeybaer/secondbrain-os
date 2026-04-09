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
    owner_phones: ['+19038410578'],
    keyword: 'Gunther',
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

describe('loadContactsStore', () => {
  beforeEach(() => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
  });

  it('returns default store when file does not exist', () => {
    const store = loadContactsStore();
    expect(store.owner_phones).toContain('+19038410578');
    expect(store.keyword).toBe('Gunther');
    expect(Array.isArray(store.contacts)).toBe(true);
  });

  it('returns parsed store when file exists', () => {
    const customStore = makeStore({ keyword: 'Excalibur', contacts: [] });
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(customStore));
    const store = loadContactsStore();
    expect(store.keyword).toBe('Excalibur');
  });

  it('falls back to default on parse error', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('{ bad json ]');
    const store = loadContactsStore();
    expect(store.keyword).toBe('Gunther'); // default
  });
});

describe('identifyCaller', () => {
  beforeEach(() => {
    vi.mocked(fs.existsSync).mockReturnValue(false); // use default store
  });

  it("returns owner mode for Luke's main number (exact match)", () => {
    const ctx = identifyCaller('+19038410578');
    expect(ctx.mode).toBe('owner');
    expect(ctx.systemPromptSection).toContain('OWNER');
  });

  it("returns owner mode for Luke's number with formatting", () => {
    const ctx = identifyCaller('(903) 841-0578');
    expect(ctx.mode).toBe('owner');
  });

  it('returns owner mode for 10-digit number without country code', () => {
    const ctx = identifyCaller('9038410578');
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
    const contact = makeContact({ name: 'Ed Evans', phones: ['+19492440350'] });
    const store = makeStore({ contacts: [contact] });
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(store));

    const ctx = identifyCaller('+19492440350');
    expect(ctx.mode).toBe('known_contact');
    expect(ctx.contact?.name).toBe('Ed Evans');
    expect(ctx.systemPromptSection).toContain('KNOWN CONTACT');
    expect(ctx.systemPromptSection).toContain('Ed Evans');
  });

  it('matches contact phone with formatting differences', () => {
    const contact = makeContact({ name: 'Bryant', phones: ['+12563664479'] });
    const store = makeStore({ contacts: [contact] });
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(store));

    const ctx = identifyCaller('256-366-4479'); // without country code
    expect(ctx.mode).toBe('known_contact');
    expect(ctx.contact?.name).toBe('Bryant');
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
  it('unknown context includes keyword in prompt', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const ctx = identifyCaller('+15559998888');
    expect(ctx.systemPromptSection).toContain('Gunther');
    expect(ctx.systemPromptSection).toContain('message');
  });

  it('owner context includes full access message', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const ctx = identifyCaller('+19038410578');
    expect(ctx.systemPromptSection).toContain('full access');
  });

  it('known_contact context includes active goals', () => {
    const contact = makeContact({
      name: 'Alice',
      phones: ['+15550001111'],
      active_goals: ['PixSeat launch'],
    });
    const store = makeStore({ contacts: [contact] });
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(store));

    const ctx = identifyCaller('+15550001111');
    expect(ctx.systemPromptSection).toContain('PixSeat launch');
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
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const result = injectCallerContext('Base prompt here.', '+19038410578');
    expect(result).toContain('OWNER');
    expect(result).toContain('Base prompt here.');
    // Owner context should come first
    expect(result.indexOf('OWNER')).toBeLessThan(result.indexOf('Base prompt here.'));
  });

  it('handles unknown caller in injection', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const result = injectCallerContext('Base.', '+15559999999');
    expect(result).toContain('UNKNOWN');
    expect(result).toContain('Base.');
  });
});
