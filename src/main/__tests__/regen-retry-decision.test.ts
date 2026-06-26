/**
 * Tests for scripts/regen-retry-decision.js -- structured retry state +
 * dead-letter escalation for video regeneration.
 *
 * Frugal regression tests: tiny inputs, tmp dirs, no real videos touched.
 * Locks the contract auto-regen-rejected-videos.js will read against.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function loadModuleFresh() {
  const modPath = require.resolve('../../../scripts/regen-retry-decision.js');
  delete require.cache[modPath];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('../../../scripts/regen-retry-decision.js');
}

function tmpFiles() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regen-retry-'));
  return {
    queueFile: path.join(dir, 'regen-queue.jsonl'),
    deadLetterFile: path.join(dir, 'regen-failures.jsonl'),
    dir,
  };
}

describe('regen-retry-decision', () => {
  let queueFile: string;
  let deadLetterFile: string;
  let dir: string;
  let mod: any;

  beforeEach(() => {
    const t = tmpFiles();
    queueFile = t.queueFile;
    deadLetterFile = t.deadLetterFile;
    dir = t.dir;
    mod = loadModuleFresh();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('first attempt builds an attempt-1 decision with the default replay safety for the step', () => {
    const d = mod.nextDecision({
      videoId: 'vid-1',
      step: 'thumbnail',
      priorAttempts: [],
      lastError: 'Bedrock returned 5xx',
      errorCode: 'bedrock_5xx',
    });
    expect(d.attempt).toBe(1);
    expect(d.maxRetries).toBe(mod.DEFAULT_MAX_RETRIES);
    expect(d.replaySafety).toBe('unsafe');
    expect(d.reason).toMatch(/attempt 1\/3 failed/);
    expect(d.lastError).toBe('Bedrock returned 5xx');
    expect(d.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('ffmpeg-only steps default to safe replay', () => {
    const d = mod.nextDecision({
      videoId: 'vid-1',
      step: 'captions',
      priorAttempts: [],
      lastError: 'syntax in ass',
      errorCode: 'ass_parse',
    });
    expect(d.replaySafety).toBe('safe');
  });

  it('attempt counter increments based on prior attempts', () => {
    const first = mod.nextDecision({
      videoId: 'vid-2', step: 'video', priorAttempts: [],
      lastError: 'blank stream', errorCode: 'blank_video',
    });
    const second = mod.nextDecision({
      videoId: 'vid-2', step: 'video', priorAttempts: [first],
      lastError: 'audio drift', errorCode: 'av_drift',
    });
    expect(second.attempt).toBe(2);
  });

  it('recordAttempt persists to queue and returns exhausted=false before max', () => {
    const r1 = mod.recordAttempt({
      videoId: 'vid-3', step: 'video',
      lastError: 'blank stream', errorCode: 'blank_video',
      queueFile, deadLetterFile,
    });
    expect(r1.exhausted).toBe(false);
    expect(r1.deadLetter).toBeUndefined();
    const loaded = mod.loadAttemptsForVideo('vid-3', 'video', queueFile);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].attempt).toBe(1);
  });

  it('recordAttempt escalates to dead-letter on the 3rd attempt', () => {
    const args = {
      videoId: 'vid-4', step: 'video',
      lastError: 'blank stream', errorCode: 'blank_video',
      queueFile, deadLetterFile,
    };
    mod.recordAttempt(args);
    mod.recordAttempt(args);
    const r3 = mod.recordAttempt(args);
    expect(r3.exhausted).toBe(true);
    expect(r3.deadLetter).toBeDefined();
    expect(r3.deadLetter.attempts).toHaveLength(3);
    const dlq = mod.loadDeadLetter(deadLetterFile);
    expect(dlq).toHaveLength(1);
    expect(dlq[0].videoId).toBe('vid-4');
  });

  it('shouldRetry returns retry when no prior attempts exist', () => {
    const s = mod.shouldRetry('fresh', 'video', { queueFile });
    expect(s.action).toBe('retry');
    expect(s.attemptsSoFar).toBe(0);
    expect(s.nextAttempt).toBe(1);
  });

  it('shouldRetry returns dead-letter once attempts reach max', () => {
    const args = {
      videoId: 'vid-5', step: 'video',
      lastError: 'blank stream', errorCode: 'blank_video',
      queueFile, deadLetterFile,
    };
    mod.recordAttempt(args);
    mod.recordAttempt(args);
    mod.recordAttempt(args);
    const s = mod.shouldRetry('vid-5', 'video', { queueFile });
    expect(s.action).toBe('dead-letter');
    expect(s.attemptsSoFar).toBe(3);
  });

  it('recordReset clears prior exhausted attempts for a fresh retry budget', () => {
    const args = {
      videoId: 'vid-reset', step: 'video',
      lastError: 'auth failed before key was refreshed', errorCode: 'auth',
      queueFile, deadLetterFile,
    };
    mod.recordAttempt(args);
    mod.recordAttempt(args);
    mod.recordAttempt(args);
    expect(mod.shouldRetry('vid-reset', 'video', { queueFile }).action).toBe('dead-letter');

    mod.recordReset({
      videoId: 'vid-reset',
      step: 'video',
      reason: 'credential state changed',
      queueFile,
    });

    const s = mod.shouldRetry('vid-reset', 'video', { queueFile });
    expect(s.action).toBe('retry');
    expect(s.attemptsSoFar).toBe(0);
    expect(mod.loadAttemptsForVideo('vid-reset', 'video', queueFile)).toHaveLength(0);
  });

  it('shouldRetry returns wait when an unsafe step set retry_after in the future', () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    mod.recordAttempt({
      videoId: 'vid-6', step: 'thumbnail',
      lastError: '429', errorCode: 'bedrock_rate_limit',
      retryAfter: future,
      queueFile, deadLetterFile,
    });
    const s = mod.shouldRetry('vid-6', 'thumbnail', { queueFile });
    expect(s.action).toBe('wait');
    expect(s.waitUntil).toBe(future);
  });

  it('shouldRetry returns retry when an unsafe step retry_after is in the past', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    mod.recordAttempt({
      videoId: 'vid-7', step: 'thumbnail',
      lastError: '429', errorCode: 'bedrock_rate_limit',
      retryAfter: past,
      queueFile, deadLetterFile,
    });
    const s = mod.shouldRetry('vid-7', 'thumbnail', { queueFile });
    expect(s.action).toBe('retry');
  });

  it('buildErrorContext returns a prompt fragment that names the prior errors', () => {
    mod.recordAttempt({
      videoId: 'vid-8', step: 'video',
      lastError: 'scene 3 was 100% black frames after 2.3s',
      errorCode: 'blank_after_thumb',
      queueFile, deadLetterFile,
    });
    mod.recordAttempt({
      videoId: 'vid-8', step: 'video',
      lastError: 'audio drifted 0.4s ahead of captions',
      errorCode: 'av_drift',
      queueFile, deadLetterFile,
    });
    const ctx = mod.buildErrorContext('vid-8', 'video', { queueFile });
    expect(ctx).toContain('Prior video attempts for vid-8 have failed');
    expect(ctx).toContain('blank_after_thumb');
    expect(ctx).toContain('av_drift');
    expect(ctx).toContain('Address each error above explicitly');
  });

  it('buildErrorContext returns empty string when no attempts logged', () => {
    expect(mod.buildErrorContext('fresh', 'video', { queueFile })).toBe('');
  });

  it('summarizeDeadLetter rolls up per-video with the latest escalation', () => {
    const args = {
      videoId: 'vid-9', step: 'video',
      lastError: 'blank',
      errorCode: 'blank_video',
      queueFile, deadLetterFile,
    };
    mod.recordAttempt(args);
    mod.recordAttempt(args);
    mod.recordAttempt(args);
    const summary = mod.summarizeDeadLetter(deadLetterFile);
    expect(summary).toHaveLength(1);
    expect(summary[0].videoId).toBe('vid-9');
    expect(summary[0].step).toBe('video');
    expect(summary[0].attempts).toBe(3);
    expect(summary[0].errorCode).toBe('blank_video');
  });

  it('long lastError is truncated to 1000 chars so the queue stays scannable', () => {
    const huge = 'x'.repeat(5000);
    const r = mod.recordAttempt({
      videoId: 'vid-10', step: 'video',
      lastError: huge, errorCode: 'huge',
      queueFile, deadLetterFile,
    });
    expect(r.decision.lastError.length).toBe(1000);
  });
});
