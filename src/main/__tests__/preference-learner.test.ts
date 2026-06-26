import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

vi.mock('../config', () => ({
  getConfig: () => ({ anthropicApiKey: undefined }),
}));

import {
  readPreferences,
  writePreference,
  getPreferenceSummary,
  type UserPreference,
} from '../preference-learner';

let tmpDir: string;
let queuePath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-test-'));
  queuePath = path.join(tmpDir, 'user-preferences.jsonl');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makePref(overrides: Partial<UserPreference> = {}): UserPreference {
  return {
    semantic_id: 'abc123',
    category: 'communication_style',
    subject: 'prefers terse responses',
    detail: 'no filler words or hedging',
    confidence: 0.9,
    source: 'reflection',
    source_ref: 'ea-reflection-log.jsonl',
    first_seen: '2026-04-01T00:00:00Z',
    last_updated: '2026-04-01T00:00:00Z',
    observation_count: 1,
    ...overrides,
  };
}

describe('readPreferences', () => {
  it('returns empty array for missing file', () => {
    expect(readPreferences('/nonexistent/prefs.jsonl')).toEqual([]);
  });

  it('reads a single preference', () => {
    writePreference(queuePath, makePref());
    const prefs = readPreferences(queuePath);
    expect(prefs).toHaveLength(1);
    expect(prefs[0].subject).toBe('prefers terse responses');
  });

  it('deduplicates by semantic_id (last entry wins)', () => {
    const p1 = makePref({ semantic_id: 'dup-id', detail: 'first version', observation_count: 1 });
    const p2 = makePref({ semantic_id: 'dup-id', detail: 'second version', observation_count: 2 });
    writePreference(queuePath, p1);
    writePreference(queuePath, p2);
    const prefs = readPreferences(queuePath);
    expect(prefs).toHaveLength(1);
    expect(prefs[0].detail).toBe('second version');
    expect(prefs[0].observation_count).toBe(2);
  });

  it('keeps multiple distinct semantic_ids', () => {
    writePreference(queuePath, makePref({ semantic_id: 'id-1', category: 'time_pattern' }));
    writePreference(queuePath, makePref({ semantic_id: 'id-2', category: 'workflow_preference' }));
    const prefs = readPreferences(queuePath);
    expect(prefs).toHaveLength(2);
  });

  it('skips malformed lines', () => {
    fs.writeFileSync(queuePath, 'not json\n' + JSON.stringify(makePref()) + '\n', 'utf8');
    const prefs = readPreferences(queuePath);
    expect(prefs).toHaveLength(1);
  });
});

describe('writePreference', () => {
  it('creates the directory if needed', () => {
    const nestedPath = path.join(tmpDir, 'nested', 'deep', 'prefs.jsonl');
    writePreference(nestedPath, makePref());
    expect(fs.existsSync(nestedPath)).toBe(true);
  });

  it('appends without overwriting', () => {
    writePreference(queuePath, makePref({ semantic_id: 'id-1' }));
    writePreference(queuePath, makePref({ semantic_id: 'id-2' }));
    const lines = fs.readFileSync(queuePath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
  });
});

describe('getPreferenceSummary', () => {
  it('returns empty string for missing file', () => {
    expect(getPreferenceSummary('/nonexistent/prefs.jsonl')).toBe('');
  });

  it('returns empty string for empty file', () => {
    fs.writeFileSync(queuePath, '', 'utf8');
    expect(getPreferenceSummary(queuePath)).toBe('');
  });

  it('includes all category headers with preferences', () => {
    writePreference(queuePath, makePref({ semantic_id: 'c1', category: 'communication_style', subject: 'no em dashes' }));
    writePreference(queuePath, makePref({ semantic_id: 'c2', category: 'time_pattern', subject: 'works early morning' }));
    writePreference(queuePath, makePref({ semantic_id: 'c3', category: 'trust_signal', subject: 'approves briefing format' }));

    const summary = getPreferenceSummary(queuePath);
    expect(summary).toContain('[LEARNED USER PREFERENCES]');
    expect(summary).toContain('Communication Style');
    expect(summary).toContain('Time Patterns');
    expect(summary).toContain('Trust Signals');
    expect(summary).toContain('[END PREFERENCES]');
    expect(summary).toContain('no em dashes');
    expect(summary).toContain('works early morning');
  });

  it('sorts by confidence descending within category', () => {
    writePreference(queuePath, makePref({ semantic_id: 'p-low', category: 'workflow_preference', subject: 'low confidence pref', confidence: 0.6, observation_count: 1 }));
    writePreference(queuePath, makePref({ semantic_id: 'p-high', category: 'workflow_preference', subject: 'high confidence pref', confidence: 0.95, observation_count: 3 }));

    const summary = getPreferenceSummary(queuePath);
    const highIdx = summary.indexOf('high confidence pref');
    const lowIdx = summary.indexOf('low confidence pref');
    expect(highIdx).toBeLessThan(lowIdx);
  });

  it('caps each category at 5 preferences', () => {
    for (let i = 0; i < 8; i++) {
      writePreference(queuePath, makePref({ semantic_id: `tp-${i}`, category: 'topic_weight', subject: `topic ${i}` }));
    }
    const summary = getPreferenceSummary(queuePath);
    // Count occurrences of "topic" in the summary -- should be at most 5
    const matches = (summary.match(/topic \d/g) || []).length;
    expect(matches).toBeLessThanOrEqual(5);
  });

  it('includes observation count in output', () => {
    writePreference(queuePath, makePref({ semantic_id: 'obs-test', observation_count: 7, subject: 'example preference' }));
    const summary = getPreferenceSummary(queuePath);
    expect(summary).toContain('7x');
  });
});
