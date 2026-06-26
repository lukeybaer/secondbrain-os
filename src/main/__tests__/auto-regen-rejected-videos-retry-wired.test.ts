/**
 * Lock test: the auto-regen-rejected-videos script must require the structured
 * regen-retry-decision module and call its three load-bearing helpers
 * (shouldRetry, recordAttempt, buildErrorContext) inside the per-video loop.
 *
 * Without these calls, attempts are not persisted across runs, so a stuck
 * video can thrash forever and no dead-letter ever fires. Pure text-based
 * check: no real videos involved, no manifest mutation.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createRequire } from 'module';

const SCRIPT_PATH = path.resolve(__dirname, '..', '..', '..', 'scripts', 'auto-regen-rejected-videos.js');
const RETRY_PATH = path.resolve(__dirname, '..', '..', '..', 'scripts', 'regen-retry-decision.js');
const require = createRequire(import.meta.url);

describe('auto-regen-rejected-videos: retry-decision wiring', () => {
  const src = fs.readFileSync(SCRIPT_PATH, 'utf8');

  it('requires the regen-retry-decision module', () => {
    expect(src).toMatch(/require\(['"]\.\/regen-retry-decision/);
  });

  it('checks shouldRetry before doing regen work', () => {
    expect(src).toContain('regenRetry.shouldRetry');
  });

  it('records every failed attempt to the structured queue', () => {
    expect(src).toContain('regenRetry.recordAttempt');
  });

  it('records video content-gate failures to the structured retry queue', () => {
    const gateBlock = src.match(
      /if \(!videoQuality\.ok && !isPlannerBuild\) \{[\s\S]*?regenEvent\('regen_end'/,
    )?.[0];
    expect(gateBlock).toBeTruthy();
    expect(gateBlock).toContain('regenRetry.recordAttempt');
    expect(gateBlock).toContain('if (recorded.exhausted)');
    expect(gateBlock).toContain("classifyErrorCode('video'");
    expect(gateBlock).toContain("'video_gate_fail'");
  });

  it('records blank-frame promotion guard failures to the structured retry queue', () => {
    const blankFrameBlock = src.match(
      /if \(gateAfter && Number\(gateAfter\.samples_blank \|\| 0\) > 0 && !isPlannerBuild\) \{[\s\S]*?continue;/,
    )?.[0];
    expect(blankFrameBlock).toBeTruthy();
    expect(blankFrameBlock).toContain('regenRetry.recordAttempt');
    expect(blankFrameBlock).toContain('if (recorded.exhausted)');
    expect(blankFrameBlock).toContain("classifyErrorCode('video'");
  });

  it('can explicitly reset retry state after a credential or tooling fix', () => {
    expect(src).toContain("--reset-retry");
    expect(src).toContain('regenRetry.recordReset');
    expect(src).toContain('retry_budget_reset');
  });

  it('clears cached voice when the failed artifact is a broken short stream', () => {
    expect(src).toContain('broken video stream');
    expect(src).toContain('script missing');
    expect(src).toContain("filesToClear.push('voice.mp3', 'voice_human.mp3', 'voice_padded.mp3', 'voice_polished.mp3')");
  });

  it('injects prior-attempt context into the next regen prompt', () => {
    expect(src).toContain('regenRetry.buildErrorContext');
    expect(src).toContain('prior-attempt context');
  });

  it('handles the dead-letter and wait gates explicitly', () => {
    expect(src).toContain("'dead-letter'");
    expect(src).toContain("'wait'");
  });

  it('classifies error codes to a stable set for the queue', () => {
    expect(src).toContain('function classifyErrorCode');
    expect(src).toContain('blank_video');
    expect(src).toContain('python_shim');
    expect(src).toContain('rate_limit');
  });

  it('ignores superseded worker instrumentation failures when deciding retry state', () => {
    const regenRetry = require(RETRY_PATH);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regen-retry-'));
    const queueFile = path.join(dir, 'regen-queue.jsonl');
    const deadLetterFile = path.join(dir, 'regen-failures.jsonl');
    const attempts = [1, 2, 3].map((attempt) => ({
      videoId: 'short004_research',
      step: 'video',
      attempt,
      maxRetries: 3,
      lastError: 'local ec2 build claimed success but no output mp4',
      errorCode: 'ec2_io',
      recordedAt: `2026-05-16T21:0${attempt}:00.000Z`,
    }));
    fs.writeFileSync(queueFile, attempts.map((a) => JSON.stringify(a)).join('\n') + '\n');
    fs.writeFileSync(deadLetterFile, JSON.stringify({
      videoId: 'short004_research',
      step: 'video',
      attempts,
      escalatedAt: '2026-05-16T21:03:00.000Z',
      reason: 'exhausted after 3 attempts: ec2_io',
    }) + '\n');

    expect(regenRetry.shouldRetry('short004_research', 'video', { queueFile }).action).toBe('retry');
    expect(regenRetry.loadAttemptsForVideo('short004_research', 'video', queueFile)).toHaveLength(0);
    expect(regenRetry.loadDeadLetter(deadLetterFile)).toHaveLength(0);
  });

  it('ignores single-attempt ElevenLabs auth dead letters created by the superseded hard-block patch', () => {
    const regenRetry = require(RETRY_PATH);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'regen-retry-auth-'));
    const queueFile = path.join(dir, 'regen-queue.jsonl');
    const deadLetterFile = path.join(dir, 'regen-failures.jsonl');
    const attempt = {
      videoId: 'short009_hggs',
      step: 'video',
      attempt: 1,
      maxRetries: 1,
      lastError: 'ElevenLabs TTS auth failed (401 Unauthorized); build log showed no mp4',
      errorCode: 'auth',
      recordedAt: '2026-05-16T21:37:19.607Z',
    };
    fs.writeFileSync(queueFile, JSON.stringify(attempt) + '\n');
    fs.writeFileSync(deadLetterFile, JSON.stringify({
      videoId: 'short009_hggs',
      step: 'video',
      attempts: [attempt],
      escalatedAt: attempt.recordedAt,
      reason: 'exhausted after 1 attempts: auth',
    }) + '\n');

    expect(regenRetry.shouldRetry('short009_hggs', 'video', { queueFile }).action).toBe('retry');
    expect(regenRetry.loadDeadLetter(deadLetterFile)).toHaveLength(0);
  });
});
