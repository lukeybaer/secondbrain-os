/**
 * Tests for the sermon detection and storage system.
 *
 * Validates that Peter's sermons are correctly detected from conversation
 * metadata and transcripts using the heuristic scoring system.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ── Mock Electron + config ──────────────────────────────────────────────────

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
  }),
}));

import {
  detectPeterSermon,
  processConversationForSermon,
  listSermons,
  saveSermon,
} from '../sermons';
import { generateSermonBriefingSection } from '../sermons';
import type { ConversationMeta } from '../storage';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeMeta(overrides: Partial<ConversationMeta> = {}): ConversationMeta {
  return {
    id: 'otter_test123',
    otterId: 'test123',
    title: 'Test Conversation',
    date: '2026-01-15',
    durationMinutes: 30,
    speakers: [],
    myRole: 'participant',
    meetingType: 'other',
    summary: '',
    topics: [],
    keywords: [],
    peopleMentioned: [],
    companiesMentioned: [],
    decisions: [],
    sentiment: 'routine',
    transcriptFile: 'transcript.txt',
    taggedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── Setup / teardown ────────────────────────────────────────────────────────

beforeEach(() => {
  testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sermons-test-'));
  fs.mkdirSync(path.join(testRoot, 'data', 'sermons'), { recursive: true });
});

afterAll(() => {
  // Clean up temp dirs
  if (testRoot && fs.existsSync(testRoot)) {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
});

// ── Detection tests ─────────────────────────────────────────────────────────

describe('detectPeterSermon', () => {
  it('detects a sermon with Peter in speakers and religious content', () => {
    const meta = makeMeta({
      speakers: ['Peter', 'Luke'],
      topics: ['spiritual growth', 'faith', 'scripture'],
      keywords: ['Jesus', 'Holy Spirit', 'baptism', 'salvation'],
      summary: 'Discussion about spiritual growth and trust in God.',
    });
    const transcript = 'Why would we run the risk? The scripture says... Jesus said...';

    const result = detectPeterSermon(meta, transcript);
    expect(result.isSermon).toBe(true);
    expect(result.confidence).toBeGreaterThanOrEqual(0.5);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it('detects a sermon with explicit Peter marker in transcript', () => {
    const meta = makeMeta({
      speakers: ['Unknown Speaker'],
      topics: ['Ethiopian Bible', 'Book of Enoch'],
      keywords: ['scripture', 'canon', 'church'],
      summary: 'Discussion about canonical scriptures.',
      meetingType: 'other',
    });
    const transcript =
      'side note for Amy, this conversation is with Peter, about the Ethiopian Bible and the Book of Enoch...';

    const result = detectPeterSermon(meta, transcript);
    expect(result.isSermon).toBe(true);
    expect(result.confidence).toBeGreaterThanOrEqual(0.5);
    expect(result.reasons).toContain('explicit Peter marker in transcript');
  });

  it('does NOT detect a work meeting as a sermon', () => {
    const meta = makeMeta({
      speakers: ['Peter', 'Alex', 'Zach', 'Luke'],
      topics: ['Data Bridge workflow', 'exception routing', 'deployment'],
      keywords: ['Salesforce', 'SharePoint', 'version one', 'SOP'],
      summary: 'Planning the Data Bridge project workflow.',
      meetingType: 'internal_planning',
    });
    const transcript = "Let's discuss the data bridge workflow and exception routing...";

    const result = detectPeterSermon(meta, transcript);
    expect(result.isSermon).toBe(false);
  });

  it('does NOT detect a conversation without Peter', () => {
    const meta = makeMeta({
      speakers: ['Luke', 'Shivani'],
      topics: ['job interview', 'salary expectations'],
      keywords: ['Amazon', 'SQL'],
      summary: 'Job interview with Shivani.',
      meetingType: 'interview',
    });
    const transcript = 'Tell me about your experience at Amazon...';

    const result = detectPeterSermon(meta, transcript);
    expect(result.isSermon).toBe(false);
  });

  it("detects 'dad' in transcript with religious context", () => {
    const meta = makeMeta({
      speakers: ['Unnamed Speaker', 'Jeff', 'Luke'],
      topics: ['emotional reflection', 'spiritual growth', 'loving God'],
      keywords: ['Jesus', 'surrender', 'faith', 'spirit'],
      summary: 'Reflective discussion about loving God with all heart, soul, mind.',
      meetingType: 'other',
    });
    const transcript =
      'I helped you a little more, dad, a couple more pieces of that. One, the scripture says... Jesus felt passion...';

    const result = detectPeterSermon(meta, transcript);
    expect(result.isSermon).toBe(true);
  });
});

// ── Storage tests ───────────────────────────────────────────────────────────

describe('processConversationForSermon', () => {
  it('saves a detected sermon to the sermons directory', () => {
    const meta = makeMeta({
      speakers: ['Peter', 'Luke'],
      topics: ['spiritual growth', 'trust in God', 'judgment'],
      keywords: ['Holy Spirit', 'faith', 'leprosy', 'sin', 'baptism'],
      summary: 'Teaching about spiritual growth and trust.',
      meetingType: 'other',
      durationMinutes: 20,
    });
    const transcript =
      'The scripture tells us about leprosy and redemption through Jesus Christ...';

    const result = processConversationForSermon(meta, transcript);
    expect(result).toBe(true);

    const sermons = listSermons();
    expect(sermons.length).toBe(1);
    expect(sermons[0].speaker).toBe('Peter Millar');
    expect(sermons[0].sourceConversationId).toBe('otter_test123');
  });

  it('does not duplicate sermons for the same conversation', () => {
    const meta = makeMeta({
      speakers: ['Peter', 'Luke'],
      topics: ['faith', 'scripture', 'salvation'],
      keywords: ['Jesus', 'God', 'Holy Spirit', 'baptism'],
      summary: 'Peter teaches about salvation.',
      meetingType: 'other',
    });
    const transcript = 'The gospel tells us about Jesus and salvation...';

    processConversationForSermon(meta, transcript);
    const secondResult = processConversationForSermon(meta, transcript);
    expect(secondResult).toBe(false);

    expect(listSermons().length).toBe(1);
  });
});

// ── Briefing tests ──────────────────────────────────────────────────────────

describe('generateSermonBriefingSection', () => {
  it('reports empty collection when no sermons exist', () => {
    const section = generateSermonBriefingSection();
    expect(section).toContain("PETER'S SERMONS:");
    expect(section).toContain('No sermons captured yet.');
  });

  it('reports collection stats when sermons exist', () => {
    saveSermon(
      {
        id: 'sermon-2026-01-15-abc',
        sourceConversationId: 'otter_abc',
        title: 'Test Sermon',
        date: '2026-01-15',
        durationMinutes: 30,
        speaker: 'Peter Millar',
        summary: 'A test sermon about faith.',
        topics: ['faith'],
        keywords: ['Jesus'],
        otherParticipants: ['Luke'],
        detectedAt: new Date().toISOString(),
      },
      'Test transcript content',
    );

    const section = generateSermonBriefingSection();
    expect(section).toContain("PETER'S SERMONS:");
    expect(section).toContain('1 total');
  });
});
