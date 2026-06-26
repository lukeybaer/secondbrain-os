import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DecisionLog } from '../agent-decision-log';

// Regression: a self-heal decision reason can echo an API URL or token (e.g.
// "401 from https://api.telegram.org/bot<token>/..."). agent-decisions.jsonl is
// surfaced in the briefing and archived to S3, so the credential must be
// scrubbed before persistence while the record stays valid JSON.

describe('agent-decision-log redaction', () => {
  let dir: string;
  let logPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'declog-'));
    logPath = path.join(dir, 'agent-decisions.jsonl');
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('scrubs a credential ExampleCod in a decision reason', () => {
    const log = new DecisionLog(logPath);
    const botToken = '7123456789:AAH8a-bCdEfGhIjKlMnOpQrStUvWxYz012345';
    const rec = log.decide(
      'health-self-heal',
      'telegramAlert',
      [{ condition: 'apiReachable', result: false }],
      'escalate',
      `401 from https://api.telegram.org/bot${botToken}/sendMessage`,
    );

    const raw = fs.readFileSync(logPath, 'utf8');
    expect(raw).not.toContain(botToken);

    const parsed = JSON.parse(raw.trim().split('\n')[0]);
    expect(parsed.decision_id).toBe(rec.decision_id);
    expect(parsed.task).toBe('health-self-heal');
    expect(parsed.decision).toBe('escalate');
  });
});
