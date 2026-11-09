/**
 * Regression guard: sendGmailReply in ec2-server.js must REFUSE to send an
 * email with a blank body, at every path. Trigger: 2026-04-22 one call,
 * The owner clicked Send on an edited reply and the recipient got a blank email.
 *
 * ec2-server.js is a monolith with load-time side effects, so sendGmailReply
 * is extracted and run against a fake gmail client: a blank body must throw
 * and the fake must record zero sends; a real body must send once.
 */
import { describe, it, expect } from 'vitest';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { loadFunctions } = require('./helpers/extract-source-function.cjs');

function build() {
  const sent: any[] = [];
  const gmail = {
    users: {
      messages: {
        send: async (req: any) => {
          sent.push(req);
          return { data: { id: 'm1', threadId: 't1' } };
        },
      },
    },
  };
  const { sendGmailReply } = loadFunctions(path.join(__dirname, '..', 'ec2-server.js'), ['sendGmailReply'], {
    approveOutreach: async () => ({ accepted: true, choice: 'accept' }),
    recordCommsCycle: () => {},
    commsSha256: () => 'sha',
    Buffer,
    console,
  });
  return { sendGmailReply, gmail, sent };
}

const base = { threadId: 't1', to: 'owner@example.com', subject: 'Re: hi' };

describe('sendGmailReply blank-body guard', () => {
  for (const [label, body] of [
    ['null', null],
    ['undefined', undefined],
    ['empty string', ''],
    ['whitespace only', ' \n\t  '],
  ] as const) {
    it(`refuses a ${label} body and never calls the Gmail send API`, async () => {
      const { sendGmailReply, gmail, sent } = build();
      await expect(sendGmailReply(gmail, { ...base, body })).rejects.toThrow(/blank/i);
      expect(sent).toEqual([]);
    });
  }

  it('sends exactly once for a real body, with the body inside the MIME payload', async () => {
    const { sendGmailReply, gmail, sent } = build();
    await sendGmailReply(gmail, { ...base, body: 'Thanks, got it.' });
    expect(sent).toHaveLength(1);
    const raw = Buffer.from(sent[0].requestBody.raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString();
    expect(raw).toContain('Thanks, got it.');
    expect(sent[0].requestBody.threadId).toBe('t1');
  });
});
