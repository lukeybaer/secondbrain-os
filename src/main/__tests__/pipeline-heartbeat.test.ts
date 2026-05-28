import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  appendHeartbeat,
  getLastHeartbeat,
  checkStale,
  checkStuck,
  checkPipelineHealth,
} from '../pipeline-heartbeat';

function tempLog() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heartbeat-'));
  return path.join(dir, 'pipeline-heartbeat.jsonl');
}

describe('pipeline-heartbeat', () => {
  it('appendHeartbeat writes a line and getLastHeartbeat reads it back', () => {
    const logPath = tempLog();
    appendHeartbeat(logPath, { timestamp: '', task: 'video-pipeline', status: 'started' });
    const last = getLastHeartbeat(logPath, 'video-pipeline');
    expect(last?.task).toBe('video-pipeline');
    expect(last?.status).toBe('started');
    expect(last?.timestamp).toBeTruthy();
  });

  it('getLastHeartbeat returns null for empty log', () => {
    const logPath = tempLog();
    expect(getLastHeartbeat(logPath, 'video-pipeline')).toBeNull();
  });

  it('getLastHeartbeat filters by task', () => {
    const logPath = tempLog();
    appendHeartbeat(logPath, { timestamp: '', task: 'nightly-enhancement', status: 'started' });
    appendHeartbeat(logPath, { timestamp: '', task: 'video-pipeline', status: 'completed' });
    const last = getLastHeartbeat(logPath, 'nightly-enhancement');
    expect(last?.status).toBe('started');
  });

  it('checkStale returns stale=true for missing log', () => {
    const result = checkStale('/nonexistent/path.jsonl', 'video-pipeline', 48);
    expect(result.is_stale).toBe(true);
  });

  it('checkStale returns stale=false for recent heartbeat', () => {
    const logPath = tempLog();
    appendHeartbeat(logPath, { timestamp: new Date().toISOString(), task: 'video-pipeline', status: 'completed' });
    const result = checkStale(logPath, 'video-pipeline', 48);
    expect(result.is_stale).toBe(false);
    expect(result.hours_since_last).toBeLessThan(1);
  });

  it('checkStale returns stale=true for old heartbeat', () => {
    const logPath = tempLog();
    const oldTs = new Date(Date.now() - 72 * 3600 * 1000).toISOString();
    appendHeartbeat(logPath, { timestamp: oldTs, task: 'video-pipeline', status: 'completed' });
    const result = checkStale(logPath, 'video-pipeline', 48);
    expect(result.is_stale).toBe(true);
    expect(result.hours_since_last).toBeGreaterThan(70);
  });

  it('checkStuck returns is_stuck=false for fewer than threshold failures', () => {
    const logPath = tempLog();
    appendHeartbeat(logPath, { timestamp: '', task: 'video-pipeline', status: 'qc_failed', video_id: 'v1', error_type: 'qc_failed' });
    appendHeartbeat(logPath, { timestamp: '', task: 'video-pipeline', status: 'qc_failed', video_id: 'v1', error_type: 'qc_failed' });
    const result = checkStuck(logPath, 'video-pipeline', 3);
    expect(result.is_stuck).toBe(false);
  });

  it('checkStuck detects repeated_video_error pattern', () => {
    const logPath = tempLog();
    for (let i = 0; i < 3; i++) {
      appendHeartbeat(logPath, {
        timestamp: '',
        task: 'video-pipeline',
        status: 'qc_failed',
        video_id: 'stuck-video-123',
        error_type: 'qc_failed',
      });
    }
    const result = checkStuck(logPath, 'video-pipeline', 3);
    expect(result.is_stuck).toBe(true);
    expect(result.pattern).toBe('repeated_video_error');
    expect(result.video_id).toBe('stuck-video-123');
  });

  it('checkPipelineHealth returns green for recent fresh heartbeat', () => {
    const logPath = tempLog();
    appendHeartbeat(logPath, { timestamp: new Date().toISOString(), task: 'video-pipeline', status: 'completed' });
    const health = checkPipelineHealth(logPath, 'video-pipeline', 48);
    expect(health.status).toBe('green');
  });

  it('checkPipelineHealth returns red for stuck pipeline', () => {
    const logPath = tempLog();
    for (let i = 0; i < 3; i++) {
      appendHeartbeat(logPath, {
        timestamp: new Date().toISOString(),
        task: 'video-pipeline',
        status: 'error',
        video_id: 'bad-video',
        error_type: 'build_failed',
      });
    }
    const health = checkPipelineHealth(logPath, 'video-pipeline', 48);
    expect(health.status).toBe('red');
    expect(health.detail).toMatch(/stuck/);
  });
});
