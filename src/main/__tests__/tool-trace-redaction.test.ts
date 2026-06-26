import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { makeFileWriter, traceTool, readRecentTraces } from '../tool-trace';

// Regression: secrets passed to a traced tool must never be persisted verbatim
// to tool-trace.jsonl (read by the briefing, shipped to S3 in session meta).
// The category is "credential in tool input/output/error", not one literal key.

describe('tool-trace file writer redaction', () => {
  let dir: string;
  let tracePath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tooltrace-'));
    tracePath = path.join(dir, 'tool-trace.jsonl');
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('scrubs a secret ExampleCod in the tool input snippet', async () => {
    const writer = makeFileWriter(tracePath);
    const secret = 'sk-proj-AbCdEf0123456789AbCdEf0123456789';
    await traceTool(
      'callVapi',
      { apiKey: secret, to: '+15555550100' },
      async () => ({ ok: true }),
      writer,
    );

    const raw = fs.readFileSync(tracePath, 'utf8');
    expect(raw).not.toContain(secret);
    expect(raw).toContain('[REDACTED');
    // The record still parses and keeps non-secret fields.
    const [rec] = readRecentTraces(tracePath, 1);
    expect(rec.tool).toBe('callVapi');
    expect(rec.success).toBe(true);
  });

  it('scrubs a secret echoed in an error message', async () => {
    const writer = makeFileWriter(tracePath);
    const botToken = '7123456789:AAH8a-bCdEfGhIjKlMnOpQrStUvWxYz012345';
    await expect(
      traceTool(
        'telegramSend',
        { chat: 1 },
        async () => {
          throw new Error(`401 from https://api.telegram.org/bot${botToken}/sendMessage`);
        },
        writer,
      ),
    ).rejects.toThrow();

    const raw = fs.readFileSync(tracePath, 'utf8');
    expect(raw).not.toContain(botToken);
  });
});
