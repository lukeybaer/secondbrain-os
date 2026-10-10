import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const importer = require('../scripts/lib/signal-history-import.js');
const linkContext = require('../scripts/lib/signal-link-context.js');
const people = require('../scripts/signal-history-people.js');

describe('Signal history import', () => {
  it('repairs literal newlines inside exported JSON strings', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-history-jsonl-'));
    const file = path.join(root, 'main.jsonl');
    fs.writeFileSync(
      file,
      '{"chatItem":{"chatItem":{"standardMessage":{"text":{"body":"one\ntwo"}}}}}\n{"version":1}\n',
    );
    const parsed = importer.parseSignalExportJsonl(file);
    expect(parsed.records).toHaveLength(2);
    expect(parsed.records[0].chatItem.chatItem.standardMessage.text.body).toBe('one\ntwo');
    expect(parsed.repairedNewlines).toBe(1);
  });

  it('matches exported attachment filenames to Signal plaintext hashes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-history-media-'));
    const payload = Buffer.from('attachment bytes');
    const digest = crypto.createHash('sha256').update(payload).digest();
    const localKey = crypto.randomBytes(64);
    const hex = crypto
      .createHash('sha256')
      .update(Buffer.concat([digest, localKey]))
      .digest('hex');
    fs.mkdirSync(path.join(root, 'files', hex.slice(0, 2)), { recursive: true });
    fs.writeFileSync(path.join(root, 'files', hex.slice(0, 2), `${hex}.jpg`), payload);
    const row = {
      chatItem: {
        chatId: 'chat-1',
        authorId: 'person-1',
        dateSent: '1000',
        standardMessage: {
          attachments: [
            {
              pointer: {
                locatorInfo: {
                  plaintextHash: digest.toString('base64'),
                  key: localKey.toString('base64'),
                },
              },
            },
          ],
        },
      },
    };
    fs.writeFileSync(path.join(root, 'main.jsonl'), `${JSON.stringify(row)}\n`);
    const result = importer.inspectSignalExport(root);
    expect(result.attachmentCoverage.matchedReferences).toBe(1);
    expect(result.attachmentCoverage.uniqueMissingHashes).toBe(0);
    expect(result.attachmentCoverage.unreferencedPhysicalFiles).toBe(0);
  });

  it('recovers a missing payload from the Signal Desktop cache by plaintext hash', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-history-recovery-'));
    const exportRoot = path.join(root, 'export');
    const cacheRoot = path.join(root, 'cache');
    const runRoot = path.join(root, 'run');
    fs.mkdirSync(path.join(exportRoot, 'files'), { recursive: true });
    fs.mkdirSync(cacheRoot, { recursive: true });
    const payload = Buffer.from('cache-only attachment');
    const digest = crypto.createHash('sha256').update(payload).digest();
    const row = {
      chatItem: {
        chatId: 'chat-1',
        authorId: 'person-1',
        dateSent: '1000',
        standardMessage: {
          attachments: [
            {
              pointer: {
                contentType: 'application/json',
                fileName: 'context.json',
                locatorInfo: {
                  plaintextHash: digest.toString('base64'),
                  key: crypto.randomBytes(64).toString('base64'),
                },
              },
            },
          ],
        },
      },
    };
    fs.writeFileSync(path.join(exportRoot, 'main.jsonl'), `${JSON.stringify(row)}\n`);
    fs.writeFileSync(path.join(cacheRoot, 'payload'), payload);
    const inspection = importer.inspectSignalExport(exportRoot);
    const recovery = importer.applySignalCacheRecovery(inspection, cacheRoot, runRoot);
    expect(recovery.recoveredPayloads).toBe(1);
    expect(recovery.remainingMissingReferences).toBe(0);
    expect(inspection._private.matched[0].file.sha256).toBe(digest.toString('hex'));
    expect(fs.existsSync(inspection._private.matched[0].file.file)).toBe(true);
  });

  it('collapses byte-identical duplicate chat records but preserves their raw record indices', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-history-dedupe-'));
    fs.mkdirSync(path.join(root, 'files'), { recursive: true });
    const row = {
      chatItem: {
        chatId: 'chat-1',
        authorId: 'person-1',
        dateSent: '1000',
        outgoing: { dateReceived: '1000' },
        standardMessage: { text: { body: 'same message' } },
      },
    };
    fs.writeFileSync(
      path.join(root, 'main.jsonl'),
      `${JSON.stringify(row)}\n${JSON.stringify(row)}\n`,
    );
    const runRoot = path.join(root, 'run');
    const receipt = await importer.prepareSignalHistory(root, runRoot);
    const messages = importer.readJsonl(path.join(runRoot, 'messages.jsonl'));
    expect(receipt.sourceChatItemRecords).toBe(2);
    expect(receipt.logicalMessages).toBe(1);
    expect(messages[0].recordIndices).toEqual([0, 1]);
  });

  it('resumes exact raw archive objects from checksum-bound receipts', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-history-archive-'));
    fs.writeFileSync(path.join(root, 'main.jsonl'), '{"version":1}\n');
    fs.writeFileSync(path.join(root, 'metadata.json'), '{}');
    const runRoot = path.join(root, 'run');
    const uploads: string[] = [];
    const uploadFile = (file: string, options: any) => {
      uploads.push(options.key);
      return {
        s3Uri: `s3://test/${options.key}`,
        sha256: importer.sha256File(file),
        bytes: fs.statSync(file).size,
      };
    };
    const first = importer.archiveSignalExport(root, runRoot, { bucket: 'test', uploadFile });
    const second = importer.archiveSignalExport(root, runRoot, { bucket: 'test', uploadFile });
    expect(first.status).toBe('verified');
    expect(second.reusedThisRun).toBe(2);
    expect(uploads).toHaveLength(2);
  });

  it('archives derivatives with bounded concurrency and reuses verified receipts', async () => {
    const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-history-derived-archive-'));
    fs.mkdirSync(path.join(runRoot, 'attachments-derived'), { recursive: true });
    fs.mkdirSync(path.join(runRoot, 'links'), { recursive: true });
    for (let index = 0; index < 4; index += 1) {
      fs.writeFileSync(
        path.join(runRoot, index % 2 ? 'links' : 'attachments-derived', `file-${index}.txt`),
        `payload-${index}`,
      );
    }
    let active = 0;
    let maximumActive = 0;
    let uploads = 0;
    const uploadFile = async (file: string, options: any) => {
      uploads += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      return {
        bucket: options.bucket,
        key: options.key,
        bytes: fs.statSync(file).size,
        sha256: importer.sha256File(file),
      };
    };
    const first = await importer.archiveSignalDerivatives(runRoot, {
      bucket: 'test',
      concurrency: 2,
      uploadFile,
    });
    const second = await importer.archiveSignalDerivatives(runRoot, {
      bucket: 'test',
      concurrency: 2,
      uploadFile,
    });
    expect(first.status).toBe('verified');
    expect(first.verified).toBe(4);
    expect(maximumActive).toBe(2);
    expect(second.reusedThisRun).toBe(4);
    expect(uploads).toBe(4);
  });

  it('executes the real derivative child-upload adapter with Node -e argument semantics', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-history-child-upload-'));
    const file = path.join(root, 'payload.txt');
    fs.writeFileSync(file, 'child upload payload');
    const receipt = await importer.uploadFileInChild(file, {
      bucket: 'test',
      region: 'us-east-1',
      key: 'signal-history/test/payload.txt',
      requireChecksumSha256: true,
      allowSensitive: true,
      dryRun: true,
    });
    expect(receipt.bucket).toBe('test');
    expect(receipt.key).toBe('signal-history/test/payload.txt');
    expect(receipt.bytes).toBe(fs.statSync(file).size);
    expect(receipt.sha256).toBe(importer.sha256File(file));
  });

  it('records derivative upload failures and retries them on the next run', async () => {
    const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-history-derived-retry-'));
    fs.mkdirSync(path.join(runRoot, 'attachments-derived'), { recursive: true });
    const file = path.join(runRoot, 'attachments-derived', 'retry.txt');
    fs.writeFileSync(file, 'retry payload');
    let attempts = 0;
    const uploadFile = async (_file: string, options: any) => {
      attempts += 1;
      if (attempts === 1) throw new Error('transient upload failure');
      return {
        bucket: options.bucket,
        key: options.key,
        bytes: fs.statSync(file).size,
        sha256: importer.sha256File(file),
      };
    };
    await expect(
      importer.archiveSignalDerivatives(runRoot, { bucket: 'test', uploadFile }),
    ).rejects.toThrow('failed object');
    expect(importer.readJson(path.join(runRoot, 'derived-archive-index.json')).status).toBe(
      'incomplete',
    );
    const retry = await importer.archiveSignalDerivatives(runRoot, { bucket: 'test', uploadFile });
    expect(retry.status).toBe('verified');
    expect(retry.failedThisRun).toBe(0);
    expect(attempts).toBe(2);
  });

  it('writes the normalized Graphiti plan and privacy receipt before a matching run queue', async () => {
    const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-history-graphiti-'));
    const message = {
      eventId: 'signal-history-event-1',
      direction: 'outbound',
      timestamp: 1000,
      referenceTime: '1970-01-01T00:00:01.000Z',
      conversation: { type: 'contact', label: 'Example contact', e164: '+15555550123' },
      author: { label: 'ExampleCo' },
      text: 'A durable message body.',
      fallbackSummary: '',
      quote: null,
      revisions: [],
      linkPreviews: [],
      attachments: [],
      attachmentCoverageComplete: true,
    };
    await importer.writeJsonl(path.join(runRoot, 'messages.jsonl'), [message]);
    importer.atomicWriteJson(path.join(runRoot, 'raw-archive-index.json'), {
      status: 'verified',
      objects: { 'main.jsonl': { s3Uri: 's3://test/main.jsonl' } },
    });
    importer.atomicWriteJson(path.join(runRoot, 'attachment-coverage.json'), {
      schema: 'amy.signal.history-attachment-coverage.v1',
      status: 'green',
      uniquePayloads: 0,
      coveredPayloads: 0,
      failedPayloads: 0,
    });
    importer.atomicWriteJson(path.join(runRoot, 'derived-archive-index.json'), {
      status: 'verified',
    });
    const result = await importer.prepareGraphitiHistory(runRoot);
    const plan = importer.readJsonl(path.join(runRoot, 'graphiti-plan.jsonl'));
    const privacy = importer.readJsonl(path.join(runRoot, 'privacy-screen.jsonl'));
    const eventFiles = fs
      .readdirSync(path.join(result.graphitiRoot, 'data', 'graphiti-event-log'))
      .filter((name: string) => name.startsWith('events-'));
    const queued = importer.readJsonl(
      path.join(result.graphitiRoot, 'data', 'graphiti-event-log', eventFiles[0]),
    );
    expect(plan).toHaveLength(1);
    expect(privacy).toHaveLength(1);
    expect(queued[0]).toEqual(plan[0]);
    expect(result.executionMode).toBe('finite-direct-history-import');
  });

  it('changes People projection input when searchable attachment context improves', () => {
    const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-history-people-fingerprint-'));
    const source = path.join(runRoot, 'attachment.bin');
    fs.writeFileSync(source, 'raw');
    const digest = importer.sha256File(source);
    const derived = path.join(runRoot, 'attachments-derived', digest);
    fs.mkdirSync(derived, { recursive: true });
    const searchable = path.join(derived, 'searchable.txt');
    fs.writeFileSync(searchable, 'first extraction');
    importer.atomicWriteJson(path.join(derived, 'receipt.json'), {
      status: 'searchable',
      searchableTextPath: searchable,
      searchableTextSha256: importer.sha256File(searchable),
    });
    const message = {
      eventId: 'message-1',
      direction: 'inbound',
      referenceTime: '2026-01-01T00:00:00.000Z',
      text: 'message',
      linkPreviews: [],
      attachments: [
        {
          available: true,
          filename: 'attachment.bin',
          contentType: 'application/octet-stream',
          file: { path: source, sha256: digest },
        },
      ],
    };
    const before = JSON.stringify(people.compactMessage(message, runRoot));
    fs.writeFileSync(searchable, 'improved extraction');
    importer.atomicWriteJson(path.join(derived, 'receipt.json'), {
      status: 'searchable',
      searchableTextPath: searchable,
      searchableTextSha256: importer.sha256File(searchable),
    });
    const after = JSON.stringify(people.compactMessage(message, runRoot));
    expect(after).not.toBe(before);
  });

  it('bounds concurrent People projection work while preserving result order', async () => {
    let active = 0;
    let maximumActive = 0;
    const results = await people.runBounded([1, 2, 3, 4, 5], 2, async (value: number) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return value * 10;
    });
    expect(maximumActive).toBe(2);
    expect(results).toEqual([10, 20, 30, 40, 50]);
  });

  it('passes historical People rung and timeout settings to the model adapter', async () => {
    let requestOptions: any = null;
    const value = await people.projectChunk('', [{ text: 'context' }], {
      rungOrder: ['claude-cli'],
      timeoutMs: 123456,
      askAI: async (_prompt: string, options: any) => {
        requestOptions = options;
        return { text: '{"durable_facts":[],"relationship_summary":""}' };
      },
    });
    expect(value.durableFacts).toEqual([]);
    expect(requestOptions.rungOrder).toEqual(['claude-cli']);
    expect(requestOptions.timeoutMs).toBe(123456);
    expect(requestOptions.toolLess).toBe(true);
  });

  it('reports source-unavailable attachments as omitted without making coverage red', () => {
    const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-history-overall-'));
    importer.atomicWriteJson(path.join(runRoot, 'inspection.json'), {
      logicalMessages: 10,
      sourceChatItemRecords: 10,
      attachmentCoverage: {
        references: 5,
        uniqueMatchedHashes: 1,
        missingReferences: 4,
        uniqueMissingHashes: 4,
      },
    });
    for (const [file, body] of [
      ['raw-archive-index.json', { status: 'verified' }],
      ['attachment-coverage.json', { status: 'green' }],
      ['link-coverage.json', { status: 'green', urls: 1, fetched: 0, omitted: 1, failed: 0 }],
      ['derived-archive-index.json', { status: 'verified' }],
      ['life-archive-coverage.json', { status: 'green' }],
      ['graphiti-coverage.json', { status: 'green' }],
      ['people-coverage.json', { status: 'green' }],
    ] as [string, Record<string, unknown>][]) {
      importer.atomicWriteJson(path.join(runRoot, file), body);
    }
    fs.writeFileSync(
      path.join(runRoot, 'missing-attachments.jsonl'),
      Array.from({ length: 4 }, (_, index) =>
        JSON.stringify({
          schema: 'amy.signal.history-missing-attachment.v1',
          plaintextHash: String(index).padStart(64, '0'),
          reason: 'not-present-in-signal-plaintext-export',
        }),
      ).join('\n') + '\n',
    );

    const result = importer.signalHistoryOverallCoverage(runRoot);

    expect(result.status).toBe('green');
    expect(result.failedChecks).toEqual([]);
    expect(result.checks).not.toHaveProperty('sourceAttachmentParity');
    expect(result.omitted.sourceAttachments).toEqual({
      attachmentReferences: 4,
      uniquePayloads: 4,
      reason: 'not-present-in-signal-plaintext-export',
    });
    expect(result.omitted.linkContext).toEqual({
      urls: 1,
      reason: 'historical-url-unavailable',
    });
    expect(result.stages.graphiti.status).toBe('green');
    expect(result.stages.people.status).toBe('green');
  });

  it('keeps real processor failures red even when source omissions also exist', () => {
    const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-history-real-failure-'));
    importer.atomicWriteJson(path.join(runRoot, 'inspection.json'), {
      logicalMessages: 1,
      sourceChatItemRecords: 1,
      attachmentCoverage: {
        references: 1,
        uniqueMatchedHashes: 0,
        missingReferences: 1,
        uniqueMissingHashes: 1,
      },
    });
    for (const [file, body] of [
      ['raw-archive-index.json', { status: 'verified' }],
      ['attachment-coverage.json', { status: 'green' }],
      ['link-coverage.json', { status: 'green', urls: 0, fetched: 0, omitted: 0, failed: 0 }],
      ['derived-archive-index.json', { status: 'verified' }],
      ['life-archive-coverage.json', { status: 'green' }],
      ['graphiti-coverage.json', { status: 'red' }],
      ['people-coverage.json', { status: 'green' }],
    ] as [string, Record<string, unknown>][]) {
      importer.atomicWriteJson(path.join(runRoot, file), body);
    }
    fs.writeFileSync(
      path.join(runRoot, 'missing-attachments.jsonl'),
      `${JSON.stringify({
        schema: 'amy.signal.history-missing-attachment.v1',
        plaintextHash: '0'.repeat(64),
        reason: 'not-present-in-signal-plaintext-export',
      })}\n`,
    );

    const result = importer.signalHistoryOverallCoverage(runRoot);
    expect(result.status).toBe('red');
    expect(result.failedChecks).toEqual(['graphiti']);
    expect(result.omitted.sourceAttachments.uniquePayloads).toBe(1);
  });

  it('keeps coverage red when a source omission lacks its required receipt', () => {
    const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-history-missing-receipt-'));
    importer.atomicWriteJson(path.join(runRoot, 'inspection.json'), {
      logicalMessages: 1,
      sourceChatItemRecords: 1,
      attachmentCoverage: { missingReferences: 1, uniqueMissingHashes: 1 },
    });
    for (const [file, body] of [
      ['raw-archive-index.json', { status: 'verified' }],
      ['attachment-coverage.json', { status: 'green' }],
      ['link-coverage.json', { status: 'green', urls: 0, fetched: 0, omitted: 0, failed: 0 }],
      ['derived-archive-index.json', { status: 'verified' }],
      ['life-archive-coverage.json', { status: 'green' }],
      ['graphiti-coverage.json', { status: 'green' }],
      ['people-coverage.json', { status: 'green' }],
    ] as [string, Record<string, unknown>][]) {
      importer.atomicWriteJson(path.join(runRoot, file), body);
    }

    const result = importer.signalHistoryOverallCoverage(runRoot);

    expect(result.status).toBe('red');
    expect(result.failedChecks).toEqual(['sourceAttachmentOmissionsReceipted']);
  });

  it('classifies an unavailable historical URL as omitted, not failed', async () => {
    const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-history-link-omitted-'));
    await importer.writeJsonl(path.join(runRoot, 'messages.jsonl'), [
      { text: 'Historical source: https://gone.example/path', linkPreviews: [] },
    ]);

    const result = await importer.enrichSignalHistoryLinks(runRoot, {
      fetchSharedUrl: async () => {
        throw new Error('Shared link HTTP 404');
      },
    });

    expect(result.status).toBe('green');
    expect(result.fetched).toBe(0);
    expect(result.omitted).toBe(1);
    expect(result.failed).toBe(0);
    const context = importer.readJson(
      path.join(importer.linkDirectory(runRoot, 'https://gone.example/path'), 'context.json'),
    );
    expect(context.status).toBe('omitted');
    expect(context.omissionReason).toBe('historical-url-unavailable');
  });

  it('uses the fetch-boundary source-limitation tag instead of error wording', async () => {
    const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-history-link-tagged-'));
    await importer.writeJsonl(path.join(runRoot, 'messages.jsonl'), [
      { text: 'Historical source: https://unreachable.example/path', linkPreviews: [] },
    ]);

    const result = await importer.enrichSignalHistoryLinks(runRoot, {
      fetchSharedUrl: async () => {
        throw new linkContext.SignalLinkSourceLimitationError('opaque transport condition');
      },
    });

    expect(result).toMatchObject({ status: 'green', fetched: 0, omitted: 1, failed: 0 });
  });

  it('migrates a cached source-unavailable link failure to omitted without refetching', async () => {
    const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-history-link-migrate-'));
    const url = 'https://gone.example/cached';
    await importer.writeJsonl(path.join(runRoot, 'messages.jsonl'), [
      { text: `Historical source: ${url}`, linkPreviews: [] },
    ]);
    const contextFile = path.join(importer.linkDirectory(runRoot, url), 'context.json');
    importer.atomicWriteJson(contextFile, {
      schema: 'amy.signal.history-link-context.v1',
      status: 'failed',
      url,
      urlHash: crypto.createHash('sha256').update(url).digest('hex'),
      error: 'Shared link HTTP 403',
      fetchedAt: '2026-08-15T00:00:00.000Z',
    });
    let fetchCalls = 0;

    const result = await importer.enrichSignalHistoryLinks(runRoot, {
      fetchSharedUrl: async () => {
        fetchCalls += 1;
        throw new Error('should not refetch cached source limitations');
      },
    });

    expect(fetchCalls).toBe(0);
    expect(result).toMatchObject({ status: 'green', fetched: 0, omitted: 1, failed: 0 });
    const context = importer.readJson(contextFile);
    expect(context).toMatchObject({
      status: 'omitted',
      omissionReason: 'historical-url-unavailable',
      sourceError: 'Shared link HTTP 403',
      migratedFrom: { status: 'failed', recordedAt: '2026-08-15T00:00:00.000Z' },
    });
    expect(context).not.toHaveProperty('error');
    expect(context).not.toHaveProperty('fetchedAt');
    expect(context).not.toHaveProperty('failedAt');
  });

  it('keeps an internal link processor exception red even when its message says network', async () => {
    const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'signal-history-link-failed-'));
    await importer.writeJsonl(path.join(runRoot, 'messages.jsonl'), [
      { text: 'Historical source: https://example.test/path', linkPreviews: [] },
    ]);

    const result = await importer.enrichSignalHistoryLinks(runRoot, {
      fetchSharedUrl: async () => {
        throw new Error('network response parser invariant violated');
      },
    });

    expect(result.status).toBe('red');
    expect(result.omitted).toBe(0);
    expect(result.failed).toBe(1);
  });
});
