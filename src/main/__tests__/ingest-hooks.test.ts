/**
 * Tests for ingest-hooks.ts , centralized post-ingest hooks.
 * Verifies that every data source correctly builds events and fires hooks.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock Electron ────────────────────────────────────────────────────────────

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/test',
    isPackaged: false,
    getAppPath: () => '/tmp/test',
  },
}));

vi.mock('../config', () => ({
  getConfig: () => ({ ec2BaseUrl: 'http://127.0.0.1:3001' }),
  loadConfig: () => ({}),
}));

// Mock Graphiti , track calls
const mockAddEpisode = vi.fn().mockResolvedValue(true);
vi.mock('../graphiti-client', () => ({
  addEpisode: (...args: unknown[]) => mockAddEpisode(...args),
}));

// Mock memory-index , track calls
const mockAppendWorkingMemory = vi.fn();
vi.mock('../memory-index', () => ({
  appendWorkingMemory: (...args: unknown[]) => mockAppendWorkingMemory(...args),
}));

import {
  onDataIngested,
  otterEvent,
  whatsappEvent,
  smsEvent,
  callEvent,
  briefingEvent,
  chatSessionEvent,
  gmailEvent,
  linkedinEvent,
  stripHtmlToText,
} from '../ingest-hooks';

beforeEach(() => {
  mockAddEpisode.mockClear();
  mockAppendWorkingMemory.mockClear();
});

// ── Event builder tests ──────────────────────────────────────────────────────

describe('event builders', () => {
  it('otterEvent builds correct structure', () => {
    const e = otterEvent({
      id: 'otter-123',
      title: 'Weekly standup',
      transcript: 'user: Hey team...',
      date: '2026-04-04T10:00:00Z',
    });
    expect(e.name).toBe('Otter: Weekly standup');
    expect(e.source).toBe('otter-transcript');
    expect(e.sourceId).toBe('otter-123');
    expect(e.body).toContain('user: Hey team');
    expect(e.timestamp).toBe('2026-04-04T10:00:00Z');
  });

  it('whatsappEvent handles inbound', () => {
    const e = whatsappEvent({
      id: 'wa-1',
      from: '+15551234567',
      body: 'Hey there',
      contactName: 'ContactA',
      source: 'inbound',
      timestamp: '2026-04-04T12:00:00Z',
    });
    expect(e.name).toBe('WhatsApp inbound: ContactA');
    expect(e.source).toBe('whatsapp-inbound');
    expect(e.phone).toBe('+15551234567');
    expect(e.contactName).toBe('ContactA');
  });

  it('whatsappEvent handles outbound', () => {
    const e = whatsappEvent({
      id: 'wa-2',
      from: '+15555550101',
      body: 'On my way',
      source: 'outbound',
      timestamp: '2026-04-04T12:05:00Z',
    });
    expect(e.source).toBe('whatsapp-outbound');
  });

  it('smsEvent builds correct structure', () => {
    const e = smsEvent({
      id: 'sms-1',
      from: '+15559876543',
      to: '+15555550101',
      body: 'Call me back',
      source: 'inbound',
      timestamp: '2026-04-04T13:00:00Z',
    });
    expect(e.name).toBe('SMS inbound: +15559876543');
    expect(e.source).toBe('sms-inbound');
    expect(e.phone).toBe('+15559876543');
  });

  it('callEvent includes instructions and outcome', () => {
    const e = callEvent({
      callId: 'call-001',
      phoneNumber: '+15551112222',
      contactName: 'Dr. Smith',
      transcript: 'Amy: Hi, I am calling about a dental cleaning...',
      outcome: 'agreed',
      instructions: 'Schedule a cleaning without x-rays',
    });
    expect(e.name).toBe('Call: Dr. Smith');
    expect(e.source).toBe('call-transcript');
    expect(e.body).toContain('Goal: Schedule a cleaning');
    expect(e.body).toContain('Outcome: agreed');
    expect(e.body).toContain('Amy: Hi');
  });

  it('briefingEvent builds daily', () => {
    const e = briefingEvent('daily', 'Good morning...');
    expect(e.name).toBe('Morning Briefing');
    expect(e.source).toBe('briefing-daily');
  });

  it('briefingEvent builds evening', () => {
    const e = briefingEvent('evening', 'Evening update...');
    expect(e.name).toBe('Evening Briefing');
    expect(e.source).toBe('briefing-evening');
  });

  it('chatSessionEvent builds correct structure', () => {
    const e = chatSessionEvent({
      sessionId: 'chat-abc',
      summary: 'Discussed memory architecture',
      transcript: 'User: How does memory work?\nSecondBrain: ...',
    });
    expect(e.name).toBe('Chat session: Discussed memory architecture');
    expect(e.source).toBe('chat-session');
    expect(e.sourceId).toBe('chat-abc');
  });

  it('gmailEvent inbound carries headers and strips HTML', () => {
    const e = gmailEvent({
      messageId: 'm-1',
      threadId: 't-1',
      from: 'amy@example.com',
      to: 'owner@example.com',
      subject: 'graphiti smoke test',
      body: '<p>Hello <b>Owner</b></p><script>alert(1)</script>',
      bodyIsHtml: true,
      direction: 'inbound',
      timestamp: '2026-04-30T12:00:00Z',
    });
    expect(e.source).toBe('gmail-inbound');
    expect(e.sourceId).toBe('m-1');
    expect(e.name).toContain('graphiti smoke test');
    expect(e.body).toContain('From: amy@example.com');
    expect(e.body).toContain('Subject: graphiti smoke test');
    expect(e.body).toContain('Hello Owner');
    expect(e.body).not.toContain('<b>');
    expect(e.body).not.toContain('alert(1)');
  });

  it('gmailEvent outbound flips direction tag', () => {
    const e = gmailEvent({
      messageId: 'm-2',
      from: 'owner@example.com',
      subject: 'reply',
      body: 'plain body',
      direction: 'outbound',
    });
    expect(e.source).toBe('gmail-outbound');
    expect(e.body).toContain('plain body');
  });

  it('linkedinEvent message carries contact url', () => {
    const e = linkedinEvent({
      id: 'li-1',
      type: 'message',
      contactName: 'Test Contact',
      contactUrl: 'https://linkedin.com/in/test',
      body: 'Hey, congrats on the role',
      timestamp: '2026-04-30T08:00:00Z',
    });
    expect(e.source).toBe('linkedin-message');
    expect(e.name).toBe('LinkedIn message: Test Contact');
    expect(e.body).toContain('linkedin.com/in/test');
    expect(e.contactName).toBe('Test Contact');
  });

  it('linkedinEvent profile uses profile source tag', () => {
    const e = linkedinEvent({
      id: 'li-prof-1',
      type: 'profile',
      contactName: 'Test Contact',
      body: 'Posted: shipping new feature',
    });
    expect(e.source).toBe('linkedin-profile');
    expect(e.name).toBe('LinkedIn profile: Test Contact');
  });

  it('stripHtmlToText drops script style and tags', () => {
    const out = stripHtmlToText(
      '<style>.x{}</style><script>x()</script><p>One</p><p>Two<br>Three</p>',
    );
    expect(out).not.toContain('<');
    expect(out).not.toContain('x()');
    expect(out).toContain('One');
    expect(out).toContain('Two');
    expect(out).toContain('Three');
  });

  it('stripHtmlToText decodes common entities', () => {
    expect(stripHtmlToText('a&nbsp;b')).toContain('a b');
    expect(stripHtmlToText('&amp;')).toBe('&');
    expect(stripHtmlToText('&quot;hi&quot;')).toBe('"hi"');
  });
});

// ── Hook execution tests ─────────────────────────────────────────────────────

describe('onDataIngested', () => {
  it('calls addEpisode with correct Graphiti payload', async () => {
    onDataIngested({
      name: 'Test event',
      body: 'This is a test body with enough characters to pass the minimum threshold.',
      source: 'otter-transcript',
      sourceId: 'test-123',
      timestamp: '2026-04-04T10:00:00Z',
    });

    // Give the async fire-and-forget time to execute
    await new Promise((r) => setTimeout(r, 100));

    expect(mockAddEpisode).toHaveBeenCalledOnce();
    const call = mockAddEpisode.mock.calls[0][0];
    expect(call.name).toBe('Test event');
    expect(call.group_id).toBe('owner-ea');
    expect(call.source_description).toBe('otter-transcript:test-123');
    expect(call.reference_time).toBe('2026-04-04T10:00:00Z');
  });

  it('calls appendWorkingMemory with one-liner', () => {
    onDataIngested({
      name: 'Test',
      body: 'Short message from someone important',
      source: 'whatsapp-inbound',
      contactName: 'ContactA',
    });

    expect(mockAppendWorkingMemory).toHaveBeenCalledOnce();
    const line = mockAppendWorkingMemory.mock.calls[0][0];
    expect(line).toContain('[whatsapp-inbound]');
    expect(line).toContain('ContactA');
  });

  it('skips Graphiti for trivially short content', async () => {
    onDataIngested({
      name: 'Tiny',
      body: 'hi',
      source: 'sms-inbound',
    });

    await new Promise((r) => setTimeout(r, 100));
    expect(mockAddEpisode).not.toHaveBeenCalled();
  });

  it('still writes to working memory even if body is short', () => {
    onDataIngested({
      name: 'Tiny',
      body: 'hi',
      source: 'sms-inbound',
      phone: '+15551234567',
    });

    expect(mockAppendWorkingMemory).toHaveBeenCalledOnce();
  });

  it('truncates body to 3000 chars for Graphiti', async () => {
    const longBody = 'x'.repeat(5000);
    onDataIngested({
      name: 'Long content',
      body: longBody,
      source: 'otter-transcript',
    });

    await new Promise((r) => setTimeout(r, 100));
    const sent = mockAddEpisode.mock.calls[0][0].episode_body;
    expect(sent.length).toBeLessThanOrEqual(3000);
  });

  it('does not throw when Graphiti is unavailable', async () => {
    mockAddEpisode.mockRejectedValueOnce(new Error('connection refused'));

    // Should not throw
    onDataIngested({
      name: 'Test',
      body: 'Some content that should not crash the system even if Graphiti is down',
      source: 'call-transcript',
    });

    await new Promise((r) => setTimeout(r, 100));
    // No assertion needed , test passes if it doesn't throw
  });

  it('uses phone as fallback when contactName is missing', () => {
    onDataIngested({
      name: 'Anonymous',
      body: 'Message from unknown number with enough content to process',
      source: 'sms-inbound',
      phone: '+15559999999',
    });

    const line = mockAppendWorkingMemory.mock.calls[0][0];
    expect(line).toContain('+15559999999');
  });
});
