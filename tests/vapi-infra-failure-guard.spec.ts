/**
 * Regression guard: ec2-server.js deliverCommandResult must NOT dial the owner over
 * Voice provider when a dispatched command failed for infrastructure reasons (ENOENT,
 * ECONNREFUSED, claude CLI missing, ...). Those errors were TTS'd as garbled
 * voicemail ("Problem. Process error. SpawnClaud in noent.").
 * Trigger: 2026-04-22 separate calls.
 *
 * deliverCommandResult is extracted from ec2-server.js and run with fake
 * Telegram/Vapi/fs collaborators; the test observes what was dialed, texted
 * and logged.
 */
import { describe, it, expect } from 'vitest';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { loadWithAutoStubs } = require('./helpers/extract-source-function.cjs');

function run(cmd: any, { channel = 'voice_callback' } = {}) {
  const dialed: any[] = [];
  const texted: string[] = [];
  const appended: { file: string; line: any }[] = [];
  const fakeFs = {
    mkdirSync: () => {},
    appendFileSync: (file: string, data: string) => appended.push({ file, line: JSON.parse(data) }),
  };
  const { deliverCommandResult } = loadWithAutoStubs(path.join(__dirname, '..', 'ec2-server.js'), ['deliverCommandResult'], {
    fs: fakeFs,
    console: { log() {}, warn() {}, error() {} },
    formatResultForChannel: (r: any, ch: string) => `${ch}:${r.oneLiner}`,
    sendMessage: async (text: string) => (texted.push(text), { ok: true }),
    chooseDeliveryChannel: () => channel,
    isCallActive: () => false,
    sayIntoCall: async () => true,
    OWNER_PHONE: '+10000000000',
    initiateVapiOutbound: async (...args: any[]) => (dialed.push(args), { id: 'call-1' }),
    voiceCloudRuntime: { readTask: () => null, recordCallbackAttempt: () => {} },
  });
  return deliverCommandResult(cmd).then(() => ({ dialed, texted, appended, cmd }));
}

const infraResults = [
  'Process error: spawn claude ENOENT',
  'connect ECONNREFUSED 127.0.0.1:8080',
  'Claude CLI not found on this host',
  'claude cli could not start',
];

describe('deliverCommandResult infrastructure-failure guard', () => {
  for (const result of infraResults) {
    it(`does not dial the owner for infra failure: ${result}`, async () => {
      const r = await run({ id: 'c1', replyTo: 'vapi', success: false, result, prompt: 'do it' });
      expect(r.dialed).toEqual([]);
      // Surfaced as text instead.
      expect(r.texted).toHaveLength(1);
    });
  }

  it('logs the infrastructure failure to briefing-actions.jsonl for the next briefing', async () => {
    const r = await run({ id: 'c2', replyTo: 'vapi', success: false, result: 'spawn claude ENOENT', prompt: 'p' });
    expect(r.appended).toHaveLength(1);
    expect(r.appended[0].file).toMatch(/briefing-actions\.jsonl$/);
    expect(r.appended[0].line).toMatchObject({ kind: 'dispatch_infra_failure', cmdId: 'c2' });
  });

  it('still dials for an ordinary failure when the channel is an explicit callback (control)', async () => {
    const r = await run({ id: 'c3', replyTo: 'vapi', success: false, result: 'tests failed: 3 red', prompt: 'p' });
    expect(r.dialed).toHaveLength(1);
    expect(r.appended).toEqual([]);
  });

  it('a successful command whose text mentions ENOENT is not treated as an infra failure', async () => {
    const r = await run({ id: 'c4', replyTo: 'vapi', success: true, result: 'fixed the ENOENT bug', prompt: 'p' });
    expect(r.appended).toEqual([]);
    expect(r.dialed).toHaveLength(1);
  });
});
