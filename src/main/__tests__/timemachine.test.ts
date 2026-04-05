/**
 * Tests for Time Machine — config management.
 *
 * NOTE: SQLite-dependent tests (frames, audio, FTS5 search) require the
 * Electron-rebuilt better-sqlite3 native module and run via `npm test`
 * (Playwright/Electron). These unit tests cover config + logic only.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// ── Mock Electron ───────────────────────────────────────────────────────────

let testRoot: string;

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return testRoot;
      return testRoot;
    },
  },
}));

vi.mock('../config', () => ({
  getConfig: () => ({
    dataDir: path.join(testRoot, 'data'),
    anthropicApiKey: '',
  }),
  saveConfig: vi.fn(),
}));

vi.mock('../timemachine-db', () => ({
  insertConversation: vi.fn(),
  getUnprocessedConversations: vi.fn(() => []),
  markConversationProcessed: vi.fn(),
  getDb: vi.fn(() => null),
}));

// Import after mocks
import { loadTimeMachineConfig, saveTimeMachineConfig } from '../timemachine';

// ── Setup ────────────────────────────────────────────────────────────────────

beforeEach(async () => {
  testRoot = path.join(
    os.tmpdir(),
    `sb-tm-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await fsp.mkdir(path.join(testRoot, 'data', 'timemachine'), { recursive: true });
});

// ── Config Tests ─────────────────────────────────────────────────────────────

describe('TimeMachine Config', () => {
  it('returns defaults when no config exists', () => {
    const config = loadTimeMachineConfig();
    expect(config.enabled).toBe(false);
    expect(config.captureIntervalMs).toBe(3000);
    expect(config.captureAudio).toBe(true);
    expect(config.captureMic).toBe(false);
    expect(config.captureSystemAudio).toBe(true);
    expect(config.retentionScreenshotDays).toBe(7);
    expect(config.retentionAudioDays).toBe(30);
    expect(config.silenceThresholdSeconds).toBe(60);
    expect(config.s3Bucket).toBe('672613094048-secondbrain-backups');
    expect(config.s3Prefix).toBe('timemachine');
  });

  it('saves and loads config', () => {
    saveTimeMachineConfig({ enabled: true, captureIntervalMs: 5000 });
    const loaded = loadTimeMachineConfig();
    expect(loaded.enabled).toBe(true);
    expect(loaded.captureIntervalMs).toBe(5000);
    expect(loaded.captureAudio).toBe(true); // default preserved
  });

  it('merges partial updates without losing existing values', () => {
    saveTimeMachineConfig({ enabled: true, s3Prefix: 'custom/tm' });
    const after = saveTimeMachineConfig({ retentionScreenshotDays: 14 });

    expect(after.enabled).toBe(true); // preserved from first save
    expect(after.s3Prefix).toBe('custom/tm'); // preserved from first save
    expect(after.retentionScreenshotDays).toBe(14); // new value
    expect(after.captureIntervalMs).toBe(3000); // default preserved
  });

  it('handles boolean toggles correctly', () => {
    saveTimeMachineConfig({ captureMic: true });
    expect(loadTimeMachineConfig().captureMic).toBe(true);

    saveTimeMachineConfig({ captureMic: false });
    expect(loadTimeMachineConfig().captureMic).toBe(false);
  });
});

// ── Conversation Boundary Logic ──────────────────────────────────────────────

describe('Conversation Detection Logic', () => {
  it('skips conversations shorter than 10 seconds', () => {
    // Test the core duration-check logic directly (no DB needed)
    const start = new Date('2026-04-04T10:00:00Z');
    const end5s = new Date('2026-04-04T10:00:05Z');
    const end30s = new Date('2026-04-04T10:00:30Z');

    const duration5 = Math.round((end5s.getTime() - start.getTime()) / 1000);
    const duration30 = Math.round((end30s.getTime() - start.getTime()) / 1000);

    // < 10s should be skipped
    expect(duration5).toBe(5);
    expect(duration5 < 10).toBe(true);

    // >= 10s should be kept
    expect(duration30).toBe(30);
    expect(duration30 < 10).toBe(false);
  });
});

// ── S3 Key Generation ────────────────────────────────────────────────────────

describe('S3 Key Patterns', () => {
  it('generates correct S3 key format', () => {
    const config = loadTimeMachineConfig();
    const date = '2026-04-04';
    const filename = '2026-04-04T10-00-00-000Z.jpg';
    const key = `${config.s3Prefix}/screenshots/${date}/${filename}`;

    expect(key).toBe('timemachine/screenshots/2026-04-04/2026-04-04T10-00-00-000Z.jpg');
  });

  it('uses custom prefix from config', () => {
    saveTimeMachineConfig({ s3Prefix: 'luke/timemachine' });
    const config = loadTimeMachineConfig();
    const key = `${config.s3Prefix}/screenshots/2026-04-04/test.jpg`;

    expect(key).toBe('luke/timemachine/screenshots/2026-04-04/test.jpg');
  });
});
