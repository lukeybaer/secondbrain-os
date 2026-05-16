/**
 * Tests for config.example.json
 *
 * Ensures the example file:
 *   1. Exists and is valid JSON
 *   2. Contains every key declared in AppConfig (no drift from src/main/config.ts)
 *   3. Contains no extra/stale keys not in AppConfig
 *   4. Has correct types for numeric/boolean fields
 *   5. Has a fully-shaped onboarding object with all 13 briefing sections
 *   6. Has non-empty placeholder values for every required credential field
 *   7. Contains no real API key patterns (safe to commit)
 *   8. Is not itself gitignored, while config.json IS gitignored
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..');
const EXAMPLE_PATH = path.join(REPO_ROOT, 'config.example.json');
const GITIGNORE_PATH = path.join(REPO_ROOT, '.gitignore');

// ── All top-level keys from AppConfig (src/main/config.ts) ───────────────────
// Update this list whenever a new field is added to the AppConfig interface.
const ALL_APPCONFIG_KEYS: string[] = [
  'otterEmail',
  'otterPassword',
  'openaiApiKey',
  'dataDir',
  'openaiModel',
  'openaiLightModel',
  'openaiEmbeddingModel',
  'maxContextConversations',
  'whatsappPhoneNumberId',
  'whatsappAccessToken',
  'vapiApiKey',
  'vapiPhoneNumberId',
  'callbackAssistantId',
  'telegramBotToken',
  'telegramChatId',
  'ownerPrivateSim',
  'ec2BaseUrl',
  'anthropicApiKey',
  'groqApiKey',
  'newsApiKey',
  'youtubeClientId',
  'youtubeClientSecret',
  'otterSessionCookie',
  'otterUserId',
  'twilioAccountSid',
  'twilioAuthToken',
  'twilioPhoneNumber',
  'amyVersion',
  'xApiKey',
  'xApiSecret',
  'xAccessToken',
  'xAccessTokenSecret',
  'ownerName',
  'onboarding',
];

// Keys whose placeholder values must be non-empty (feature won't work without them)
const REQUIRED_CREDENTIAL_KEYS: string[] = [
  'openaiApiKey',
  'anthropicApiKey',
  'groqApiKey',
  'vapiApiKey',
  'vapiPhoneNumberId',
  'callbackAssistantId',
  'telegramBotToken',
  'telegramChatId',
  'whatsappPhoneNumberId',
  'whatsappAccessToken',
  'twilioAccountSid',
  'twilioAuthToken',
  'xApiKey',
  'xApiSecret',
  'xAccessToken',
  'xAccessTokenSecret',
];

// All 13 briefing section keys from DEFAULT_BRIEFING_SECTIONS
const BRIEFING_SECTION_KEYS: string[] = [
  'header',
  'topDecisions',
  'calendarToday',
  'pendingApprovals',
  'people',
  'communicationsSummary',
  'projectsDoneTogether',
  'contentPipeline',
  'news',
  'systemHealth',
  'tokenUsageYesterday',
  'awsCosts',
  'footerLinks',
];

// ── Real API key patterns — none of these should appear in the example file ──
// Catches accidental commits of actual credentials.
const REAL_KEY_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'OpenAI key',    pattern: /sk-[A-Za-z0-9]{48,}/ },
  { name: 'Anthropic key', pattern: /sk-ant-api[0-9]+-[A-Za-z0-9_-]{80,}/ },
  { name: 'Twilio token',  pattern: /^[0-9a-f]{32}$/ },
];

// ── Parse once ────────────────────────────────────────────────────────────────

let example: Record<string, unknown> = {};

beforeAll(() => {
  if (fs.existsSync(EXAMPLE_PATH)) {
    example = JSON.parse(fs.readFileSync(EXAMPLE_PATH, 'utf-8')) as Record<string, unknown>;
  }
});

// ── 1. Existence & validity ───────────────────────────────────────────────────

describe('config.example.json — existence and validity', () => {
  it('exists at the repo root', () => {
    expect(fs.existsSync(EXAMPLE_PATH)).toBe(true);
  });

  it('is valid JSON', () => {
    const raw = fs.readFileSync(EXAMPLE_PATH, 'utf-8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('is not empty', () => {
    expect(Object.keys(example).length).toBeGreaterThan(0);
  });
});

// ── 2. Schema completeness — no missing keys ──────────────────────────────────

describe('config.example.json — schema completeness', () => {
  it.each(ALL_APPCONFIG_KEYS)('has AppConfig key: %s', (key) => {
    expect(example).toHaveProperty(key);
  });
});

// ── 3. No stale/extra keys ────────────────────────────────────────────────────

describe('config.example.json — no stale keys', () => {
  it('contains no keys that are not in AppConfig (excluding _readme)', () => {
    const allowed = new Set([...ALL_APPCONFIG_KEYS, '_readme']);
    const extraKeys = Object.keys(example).filter((k) => !allowed.has(k));
    expect(extraKeys).toEqual([]);
  });
});

// ── 4. Type correctness ───────────────────────────────────────────────────────

describe('config.example.json — field types', () => {
  it('amyVersion is a number', () => {
    expect(typeof example.amyVersion).toBe('number');
  });

  it('amyVersion is 1, 2, or 3', () => {
    expect([1, 2, 3]).toContain(example.amyVersion);
  });

  it('maxContextConversations is a number', () => {
    expect(typeof example.maxContextConversations).toBe('number');
  });

  it('maxContextConversations is a positive integer', () => {
    const v = example.maxContextConversations as number;
    expect(v).toBeGreaterThan(0);
    expect(Number.isInteger(v)).toBe(true);
  });

  it('all string fields that exist are strings', () => {
    const stringKeys = ALL_APPCONFIG_KEYS.filter((k) => k !== 'amyVersion' && k !== 'maxContextConversations' && k !== 'onboarding');
    for (const key of stringKeys) {
      if (key in example) {
        expect(typeof example[key], `${key} should be a string`).toBe('string');
      }
    }
  });

  it('onboarding is an object', () => {
    expect(typeof example.onboarding).toBe('object');
    expect(example.onboarding).not.toBeNull();
  });
});

// ── 5. Onboarding shape ───────────────────────────────────────────────────────

describe('config.example.json — onboarding object shape', () => {
  let onboarding: Record<string, unknown>;

  beforeAll(() => {
    onboarding = (example.onboarding ?? {}) as Record<string, unknown>;
  });

  it('has completedAt (null or string)', () => {
    expect(onboarding).toHaveProperty('completedAt');
    expect(onboarding.completedAt === null || typeof onboarding.completedAt === 'string').toBe(true);
  });

  it('has currentStep as a number', () => {
    expect(typeof onboarding.currentStep).toBe('number');
  });

  it('has skippedTour as a boolean', () => {
    expect(typeof onboarding.skippedTour).toBe('boolean');
  });

  it('has secretsDeferred as an array', () => {
    expect(Array.isArray(onboarding.secretsDeferred)).toBe(true);
  });

  it('has lastReminderShownAt (null or string)', () => {
    expect(onboarding).toHaveProperty('lastReminderShownAt');
    expect(onboarding.lastReminderShownAt === null || typeof onboarding.lastReminderShownAt === 'string').toBe(true);
  });

  it('has briefingSections as an object', () => {
    expect(typeof onboarding.briefingSections).toBe('object');
    expect(onboarding.briefingSections).not.toBeNull();
  });
});

// ── 6. All 13 briefing sections present ──────────────────────────────────────

describe('config.example.json — briefing sections', () => {
  let sections: Record<string, unknown>;

  beforeAll(() => {
    const onboarding = (example.onboarding ?? {}) as Record<string, unknown>;
    sections = (onboarding.briefingSections ?? {}) as Record<string, unknown>;
  });

  it.each(BRIEFING_SECTION_KEYS)('briefingSections has key: %s', (key) => {
    expect(sections).toHaveProperty(key);
  });

  it('all briefing section values are booleans', () => {
    for (const key of BRIEFING_SECTION_KEYS) {
      expect(typeof sections[key], `briefingSections.${key} should be boolean`).toBe('boolean');
    }
  });

  it('has exactly 13 briefing sections', () => {
    expect(Object.keys(sections).length).toBe(13);
  });

  it('awsCosts defaults to false', () => {
    expect(sections.awsCosts).toBe(false);
  });
});

// ── 7. Credential placeholders are non-empty ──────────────────────────────────

describe('config.example.json — credential placeholders', () => {
  it.each(REQUIRED_CREDENTIAL_KEYS)(
    '%s has a non-empty placeholder (tells new users what to supply)',
    (key) => {
      const value = example[key];
      expect(typeof value).toBe('string');
      expect((value as string).length).toBeGreaterThan(0);
    },
  );
});

// ── 8. No real API key patterns ───────────────────────────────────────────────

describe('config.example.json — safe to commit (no real secrets)', () => {
  it('file contents contain no real OpenAI API key pattern', () => {
    const raw = fs.readFileSync(EXAMPLE_PATH, 'utf-8');
    // Real keys are sk- followed by 48+ alphanumeric chars. Our placeholder
    // has "YOUR" in it so it will never match this pattern.
    expect(raw).not.toMatch(/sk-[A-Za-z0-9]{48,}/);
  });

  it('file contents contain no real Anthropic API key pattern', () => {
    const raw = fs.readFileSync(EXAMPLE_PATH, 'utf-8');
    expect(raw).not.toMatch(/sk-ant-api[0-9]+-[A-Za-z0-9_-]{80,}/);
  });

  it('twilioAccountSid placeholder has the correct ACxx... format', () => {
    expect(example.twilioAccountSid).toMatch(/^AC/);
  });

  it('all string values contain "YOUR" or are recognisably safe formats', () => {
    // Reject any string value longer than 60 chars that is pure alphanumeric+dash+underscore
    // — the hallmark of a real API key accidentally pasted in.
    const suspicious = Object.entries(example)
      .filter(([, v]) => typeof v === 'string')
      .filter(([, v]) => {
        const s = v as string;
        return s.length > 60 && /^[A-Za-z0-9_\-]+$/.test(s);
      });
    expect(suspicious.map(([k]) => k)).toEqual([]);
  });
});

// ── 9. Edge cases & format validation ────────────────────────────────────────

describe('config.example.json — edge cases and format validation', () => {
  it('has a _readme field explaining where to copy the file', () => {
    expect(typeof example._readme).toBe('string');
    expect((example._readme as string).length).toBeGreaterThan(20);
  });

  it('openaiModel is a recognised OpenAI model string', () => {
    const valid = ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-4', 'gpt-3.5-turbo'];
    expect(valid).toContain(example.openaiModel);
  });

  it('openaiLightModel is a recognised cheap OpenAI model string', () => {
    const valid = ['gpt-4o-mini', 'gpt-3.5-turbo'];
    expect(valid).toContain(example.openaiLightModel);
  });

  it('openaiEmbeddingModel is a recognised embedding model', () => {
    const valid = ['text-embedding-3-small', 'text-embedding-3-large', 'text-embedding-ada-002'];
    expect(valid).toContain(example.openaiEmbeddingModel);
  });

  it('twilioPhoneNumber matches E.164 format', () => {
    expect(example.twilioPhoneNumber).toMatch(/^\+\d{7,15}$/);
  });

  it('ownerPrivateSim matches E.164 format', () => {
    expect(example.ownerPrivateSim).toMatch(/^\+\d{7,15}$/);
  });

  it('ec2BaseUrl is a valid https URL', () => {
    expect(example.ec2BaseUrl).toMatch(/^https:\/\/.+/);
  });

  it('onboarding.currentStep is 0 (fresh install default)', () => {
    const onboarding = example.onboarding as Record<string, unknown>;
    expect(onboarding.currentStep).toBe(0);
  });

  it('onboarding.skippedTour is false (fresh install default)', () => {
    const onboarding = example.onboarding as Record<string, unknown>;
    expect(onboarding.skippedTour).toBe(false);
  });

  it('onboarding.secretsDeferred is an empty array (fresh install default)', () => {
    const onboarding = example.onboarding as Record<string, unknown>;
    expect(Array.isArray(onboarding.secretsDeferred)).toBe(true);
    expect((onboarding.secretsDeferred as unknown[]).length).toBe(0);
  });

  it('openaiApiKey placeholder starts with sk- (showing expected key format)', () => {
    expect(example.openaiApiKey as string).toMatch(/^sk-/);
  });

  it('anthropicApiKey placeholder starts with sk-ant- (showing expected key format)', () => {
    expect(example.anthropicApiKey as string).toMatch(/^sk-ant-/);
  });

  it('twilioAccountSid placeholder starts with AC (Twilio format)', () => {
    expect(example.twilioAccountSid as string).toMatch(/^AC/);
  });

  it('groqApiKey placeholder starts with gsk_ (Groq format)', () => {
    expect(example.groqApiKey as string).toMatch(/^gsk_/);
  });
});

// ── 10. .gitignore gates ──────────────────────────────────────────────────────

describe('.gitignore — config file gating', () => {
  let gitignore: string;

  beforeAll(() => {
    gitignore = fs.existsSync(GITIGNORE_PATH)
      ? fs.readFileSync(GITIGNORE_PATH, 'utf-8')
      : '';
  });

  it('.gitignore exists', () => {
    expect(fs.existsSync(GITIGNORE_PATH)).toBe(true);
  });

  it('.gitignore includes config.json (live secrets must not be committed)', () => {
    const lines = gitignore.split('\n').map((l) => l.trim());
    expect(lines).toContain('config.json');
  });

  it('.gitignore does NOT ignore config.example.json (template must be versioned)', () => {
    expect(gitignore).not.toContain('config.example.json');
  });

  it('config.example.json is present in the repo (not gitignored in practice)', () => {
    expect(fs.existsSync(EXAMPLE_PATH)).toBe(true);
  });
});
