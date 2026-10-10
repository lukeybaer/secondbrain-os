import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ingest = require('../scripts/lib/signal-ingest.js');
const completeness = require('../scripts/lib/signal-message-completeness.js');
const people = require('../scripts/lib/signal-people-project.js');
const sender = require('../scripts/signal-send-amy.js');

const tempRoots: string[] = [];
const graphitiEnabled = () => ({ allowed: true, deferred: false, reason: 'test-enabled' });
function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-ingest-test-'));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function inbound(overrides: any = {}) {
  return {
    jsonrpc: '2.0',
    method: 'receive',
    params: {
      account: '+15550100000',
      envelope: {
        sourceNumber: '+15550100101',
        sourceDevice: 1,
        timestamp: 1786798800000,
        dataMessage: {
          timestamp: 1786798800000,
          message: 'Dinner at seven',
          attachments: [],
          ...overrides,
        },
      },
    },
  };
}

describe('Signal normalization', () => {
  it('normalizes incoming messages with a stable id', () => {
    const first = ingest.normalizeNotification(inbound());
    const second = ingest.normalizeNotification(inbound());
    expect(first.direction).toBe('inbound');
    expect(first.counterparty).toBe('+15550100101');
    expect(first.text).toBe('Dinner at seven');
    expect(first.id).toBe(second.id);
    expect(first.referenceTime).toBe('2026-08-15T13:00:00.000Z');
  });

  it('normalizes phone-origin sent sync messages as outbound', () => {
    const notification = {
      jsonrpc: '2.0',
      method: 'receive',
      params: {
        account: '+15550100000',
        envelope: {
          timestamp: 1786798801000,
          syncMessage: {
            sentMessage: {
              timestamp: 1786798801000,
              destinationNumber: '+15550100102',
              message: 'Sent from iPhone',
              attachments: [],
            },
          },
        },
      },
    };
    const normalized = ingest.normalizeNotification(notification);
    expect(normalized.direction).toBe('outbound');
    expect(normalized.counterparty).toBe('+15550100102');
    expect(normalized.text).toBe('Sent from iPhone');
  });

  it('preserves the account from subscription-wrapped sent sync notifications', () => {
    const notification = {
      jsonrpc: '2.0',
      method: 'receive',
      params: {
        subscription: 0,
        result: {
          account: '+15550100000',
          envelope: {
            syncMessage: {
              sentMessage: {
                timestamp: 1786798801000,
                destinationNumber: '+15550100102',
                message: 'Wrapped',
              },
            },
          },
        },
      },
    };
    expect(ingest.normalizeNotification(notification).account).toBe('+15550100000');
  });

  it('normalizes the bare envelope shape emitted by the native SSE endpoint', () => {
    const notification = {
      account: '+15550100000',
      envelope: {
        timestamp: 1786798801000,
        syncMessage: {
          sentMessage: {
            timestamp: 1786798801000,
            destinationNumber: '+15550100102',
            message: 'Bare SSE envelope',
            previews: [{ image: { storedFilename: '/tmp/link-preview.jpg' } }],
          },
        },
      },
    };
    const normalized = ingest.normalizeNotification(notification);
    expect(normalized.direction).toBe('outbound');
    expect(normalized.account).toBe('+15550100000');
    expect(normalized.counterparty).toBe('+15550100102');
    expect(normalized.text).toBe('Bare SSE envelope');
    expect(normalized.attachments).toEqual([{ storedFilename: '/tmp/link-preview.jpg' }]);
  });

  it('normalizes an envelope emitted directly as an SSE data object', () => {
    const normalized = ingest.normalizeNotification({
      sourceNumber: '+15550100101',
      sourceDevice: 1,
      timestamp: 1786798800000,
      dataMessage: { timestamp: 1786798800000, message: 'Direct SSE envelope' },
    });
    expect(normalized.direction).toBe('inbound');
    expect(normalized.counterparty).toBe('+15550100101');
    expect(normalized.text).toBe('Direct SSE envelope');
  });

  it('ignores receipts and typing notifications', () => {
    expect(ingest.normalizeNotification({ params: { envelope: { receiptMessage: {} } } })).toBeNull();
  });

  it('redacts hard-excluded people before Graphiti while preserving the raw event path', () => {
    const normalized = ingest.normalizeNotification(inbound({ message: 'Update from Quimby' }));
    const body = ingest.graphitiBody(normalized, []);
    expect(body).toContain('privacy_redacted_person');
    expect(body).not.toContain('Quimby');
    expect(body).toContain(normalized.id);
  });
});

describe('Signal durable processing', () => {
  it('archives before Graphiti and becomes idempotent', async () => {
    const stateRoot = tempRoot();
    const calls: string[] = [];
    const uploadFile = vi.fn((file: string, options: any) => {
      calls.push(`s3:${path.basename(file)}`);
      return { s3Uri: `s3://test/${options.key}`, sha256: 'abc', bytes: fs.statSync(file).size };
    });
    const addEpisode = vi.fn(async () => {
      calls.push('graphiti');
      return { ok: true };
    });
    const first = await ingest.processNotification(inbound(), {
      stateRoot,
      uploadFile,
      addEpisode,
      graphitiIngestionAdmission: graphitiEnabled,
      env: { SECONDBRAIN_DATA_BUCKET: 'test' },
    });
    const second = await ingest.processNotification(inbound(), {
      stateRoot,
      uploadFile,
      addEpisode,
      graphitiIngestionAdmission: graphitiEnabled,
      env: { SECONDBRAIN_DATA_BUCKET: 'test' },
    });
    expect(first.status.captureComplete).toBe(true);
    expect(first.status.complete).toBe(false);
    expect(calls).toEqual(['s3:raw.json', 's3:normalized.json', 's3:context.json', 'graphiti']);
    expect(fs.existsSync(path.join(first.eventDir, 'raw.json'))).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(uploadFile).toHaveBeenCalledTimes(3);
    expect(addEpisode).toHaveBeenCalledTimes(1);
  });

  it('logs privacy-safe lifecycle stages for backend streaming', async () => {
    const stateRoot = tempRoot();
    const logs: string[] = [];
    await ingest.processNotification(inbound(), {
      stateRoot,
      log: (line: string) => logs.push(line),
      uploadFile: (file: string, options: any) => ({
        s3Uri: `s3://test/${options.key}`,
        sha256: 'abc',
        bytes: fs.statSync(file).size,
      }),
      addEpisode: async () => ({ ok: true }),
      graphitiIngestionAdmission: graphitiEnabled,
    });
    expect(logs.map((line) => line.match(/stage=([a-z0-9_]+)/)?.[1])).toEqual([
      'captured',
      'archive_complete',
      's3_verified',
      'linked_context_complete',
      'graphiti_complete',
      'graphiti_accepted',
      'capture_complete',
    ]);
    expect(logs.join('\n')).not.toContain('Dinner at seven');
    expect(logs.join('\n')).not.toContain('+15550100101');
  });

  it('does not call Graphiti when verified S3 archival fails', async () => {
    const stateRoot = tempRoot();
    const addEpisode = vi.fn();
    await expect(
      ingest.processNotification(inbound(), {
        stateRoot,
        uploadFile: () => {
          throw new Error('S3 checksum failed');
        },
        addEpisode,
      }),
    ).rejects.toThrow('S3 checksum failed');
    expect(addEpisode).not.toHaveBeenCalled();
    expect(ingest.pendingRawFiles(stateRoot)).toHaveLength(1);
    const recovered = await ingest.processNotification(inbound(), {
      stateRoot,
      uploadFile: (file: string, options: any) => ({
        s3Uri: `s3://test/${options.key}`,
        sha256: 'abc',
        bytes: fs.statSync(file).size,
      }),
      addEpisode: async () => ({ ok: true }),
    });
    expect(recovered.status.captureComplete).toBe(true);
    expect(recovered.status.complete).toBe(false);
    expect(recovered.status.lastError).toBeUndefined();
  });

  it('copies only attachment files inside the Signal durable root', () => {
    const root = tempRoot();
    const signalRoot = path.join(root, 'signal-cli');
    const eventDir = path.join(root, 'event');
    fs.mkdirSync(signalRoot, { recursive: true });
    const attachment = path.join(signalRoot, 'photo.jpg');
    const outside = path.join(root, 'outside.txt');
    fs.writeFileSync(attachment, 'image bytes');
    fs.writeFileSync(outside, 'outside');
    const copied = ingest.copyAttachments(
      { attachments: [{ filename: attachment }, { filename: outside }] },
      eventDir,
      signalRoot,
    );
    expect(copied).toHaveLength(1);
    expect(fs.readFileSync(copied[0].localPath, 'utf8')).toBe('image bytes');
  });

  it('archives a link-preview image delivered outside the ordinary attachments array', async () => {
    const stateRoot = tempRoot();
    const signalRoot = path.join(stateRoot, 'signal-cli');
    fs.mkdirSync(signalRoot, { recursive: true });
    const preview = path.join(signalRoot, 'preview.jpg');
    fs.writeFileSync(preview, 'preview bytes');
    const uploads: string[] = [];
    const notification = {
      account: '+15550100000',
      envelope: {
        sourceDevice: 2,
        syncMessage: {
          sentMessage: {
            timestamp: 1786798801000,
            destinationNumber: '+15550100102',
            message: 'Link preview',
            previews: [{ image: { storedFilename: preview } }],
          },
        },
      },
    };
    const result = await ingest.processNotification(notification, {
      stateRoot,
      signalRoot,
      log: () => {},
      uploadFile: (file: string, options: any) => {
        uploads.push(options.key);
        return { s3Uri: `s3://test/${options.key}`, sha256: 'abc', bytes: fs.statSync(file).size };
      },
      addEpisode: async () => ({ ok: true }),
    });
    expect(uploads).toHaveLength(4);
    expect(uploads[2]).toContain('/attachments/');
    expect(result.status.s3.attachments).toHaveLength(1);
    expect(fs.existsSync(preview)).toBe(false);
  });

  it('serializes concurrent delivery of the same Signal event', async () => {
    const stateRoot = tempRoot();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const addEpisode = vi.fn(async () => { await gate; return { ok: true }; });
    const uploadFile = vi.fn((file: string, options: any) => ({
      s3Uri: `s3://test/${options.key}`,
      sha256: 'abc',
      bytes: fs.statSync(file).size,
    }));
    const first = ingest.processNotification(inbound(), { stateRoot, uploadFile, addEpisode, graphitiIngestionAdmission: graphitiEnabled });
    const second = ingest.processNotification(inbound(), { stateRoot, uploadFile, addEpisode, graphitiIngestionAdmission: graphitiEnabled });
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a.normalized.id).toBe(b.normalized.id);
    expect(addEpisode).toHaveBeenCalledTimes(1);
    expect(uploadFile).toHaveBeenCalledTimes(3);
  });
});

describe('Signal People projection', () => {
  it('resolves contacts by normalized phone number', () => {
    const root = tempRoot();
    const contacts = path.join(root, 'memory', 'contacts');
    fs.mkdirSync(contacts, { recursive: true });
    fs.writeFileSync(path.join(contacts, 'PRIVATE_NAME.md'), '# PRIVATE_NAME\n\n- **Phone**: +1 (555) 010-0101\n');
    const match = people.resolveContact({ counterparty: '+15550100101' }, contacts);
    expect(match.name).toBe('PRIVATE_NAME.md');
  });

  it('maintains a bounded generated block and updates last_interaction', () => {
    const original = ['---', 'name: PRIVATE_NAME', 'last_interaction: 2026-01-01', '---', '', '# PRIVATE_NAME', ''].join('\n');
    const event = {
      normalized: {
        id: 'evt1',
        direction: 'inbound',
        referenceTime: '2026-08-15T15:40:00.000Z',
      },
    };
    const once = people.updateContactBody(original, [event], {
      durableFacts: ['Prefers dinner at seven.'],
      relationshipSummary: 'Family',
    });
    const twice = people.updateContactBody(once, [event], {
      durableFacts: ['Prefers dinner at seven.'],
      relationshipSummary: 'Family',
    });
    expect(twice.match(/amy-signal-activity:start/g)).toHaveLength(1);
    expect(twice.match(/Fact: Prefers dinner at seven\./g)).toHaveLength(1);
    expect(twice).toContain('Recorded messages in this block: 1');
    expect(twice).toContain('last_interaction: 2026-08-15');
  });

  it('requires strict JSON projections', () => {
    expect(people.parseProjection('{"durable_facts":[],"relationship_summary":""}')).toEqual({
      durableFacts: [],
      relationshipSummary: '',
    });
    expect(() => people.parseProjection('not json')).toThrow();
  });

  it('uses independent People receipts and identifies note-to-self events', () => {
    const root = tempRoot();
    const receipt = people.peopleReceiptFile(root, 'evt1');
    expect(receipt).toBe(path.join(root, 'people', 'evt1.json'));
    expect(people.isNoteToSelf({ account: '+1 (555) 010-0101', counterparty: '+15550100101' })).toBe(true);
    expect(people.isNoteToSelf({ account: '+15550100000', counterparty: '+15550100101' })).toBe(false);
  });
});

describe('Signal send wrapper', () => {
  it('uses JSON-RPC send and archives the accepted outbound message', async () => {
    const stateRoot = tempRoot();
    const rpc = vi.fn(async () => ({
      timestamp: 1786798800000,
      results: [{ type: 'SUCCESS', recipientAddress: { number: '+15550100101' } }],
    }));
    const processNotification = vi.fn(async (notification: any) => ({
      normalized: ingest.normalizeNotification(notification),
    }));
    const result = await sender.sendAndArchive(
      { actionId: 'test-send-1', account: '+15550100000', recipient: '+15550100101', message: 'Hello', attachments: [] },
      { stateRoot, rpc, processNotification },
    );
    expect(rpc).toHaveBeenCalledWith(
      'send',
      expect.objectContaining({ recipient: ['+15550100101'], message: 'Hello', account: '+15550100000' }),
      expect.any(Object),
    );
    expect(result.archive.normalized.direction).toBe('outbound');
    expect(result.archive.normalized.text).toBe('Hello');
    const journalRows = completeness.receiverJournalRows(stateRoot);
    expect(journalRows).toHaveLength(1);
    expect(journalRows[0].eventId).toBe(result.archive.normalized.id);
    const echo = structuredClone(journalRows[0].notification);
    echo.params.result = {
      account: echo.params.account,
      envelope: {
        ...echo.params.envelope,
        sourceDevice: 9,
        serverGuid: 'transport-only-guid',
        syncMessage: {
          sentMessage: {
            ...echo.params.envelope.syncMessage.sentMessage,
            attachments: [{ id: 'provider-attachment-id' }],
          },
        },
      },
    };
    delete echo.params.account;
    delete echo.params.envelope;
    expect(ingest.normalizeNotification(echo).id).toBe(result.archive.normalized.id);
    const duplicate = await sender.sendAndArchive(
      { actionId: 'test-send-1', account: '+15550100000', recipient: '+15550100101', message: 'Hello', attachments: [] },
      { stateRoot, rpc, processNotification },
    );
    expect(duplicate.duplicate).toBe(true);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(sender.summarizeSendResult(duplicate)).toMatchObject({
      ok: true,
      duplicate: true,
      acceptedRecipients: 1,
      failures: 0,
    });
    expect(JSON.stringify(sender.summarizeSendResult(duplicate))).not.toContain('+15550100101');
  });
});

describe('One Amy Signal parity', () => {
  it('keeps canonical behavior, requirements, capability, and boot wiring aligned', () => {
    const root = path.resolve(__dirname, '..');
    const amy = fs.readFileSync(path.join(root, 'memory', 'AMY.md'), 'utf8');
    const requirements = fs.readFileSync(path.join(root, 'memory', 'AMY_REQUIREMENTS.md'), 'utf8');
    const registry = fs.readFileSync(path.join(root, 'scripts', 'lib', 'capability-registry.js'), 'utf8');
    const installer = fs.readFileSync(path.join(root, 'scripts', 'install-signal-ingest-ec2.sh'), 'utf8');
    expect(amy).toContain('Exact raw objects archive before downstream work.');
    expect(requirements).toContain('Signal forward-stream contract');
    expect(registry).toContain("external('signal_send'");
    expect(installer).toContain('signal-ingest-amy.service');
    expect(installer).toContain('signal-flow-healer-amy.timer');
    expect(installer).toContain('signal-people-project-amy.timer >/dev/null 2>&1 || true');
    expect(fs.readFileSync(path.join(root, 'scripts', 'infra', 'apply-signal-raw-archive-iam.sh'), 'utf8')).toContain('secondbrain-signal-raw-archive');
  });
});
