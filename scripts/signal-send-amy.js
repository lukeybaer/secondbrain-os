#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { atomicWriteJson, processNotification, readJson } = require('./lib/signal-ingest.js');
const { recordReceiverJournal } = require('./lib/signal-message-completeness.js');

function rpc(method, params, options = {}) {
  const endpoint = new URL(options.url || process.env.SIGNAL_RPC_URL || 'http://127.0.0.1:7584/api/v1/rpc');
  const body = JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params });
  return new Promise((resolve, reject) => {
    const request = http.request(
      endpoint,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (response) => {
        let raw = '';
        response.on('data', (chunk) => (raw += chunk));
        response.on('end', () => {
          try {
            const parsed = JSON.parse(raw || '{}');
            if (response.statusCode < 200 || response.statusCode >= 300 || parsed.error) {
              reject(new Error(parsed.error?.message || `Signal RPC HTTP ${response.statusCode}`));
              return;
            }
            resolve(parsed.result);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.setTimeout(options.timeoutMs || 120000, () => request.destroy(new Error('Signal RPC timeout')));
    request.on('error', reject);
    request.end(body);
  });
}

function stageAttachments(files, stateRoot) {
  const staged = [];
  for (const file of files) {
    const source = path.resolve(file);
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error(`Attachment is not a file: ${file}`);
    const digest = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');
    const targetDir = path.join(stateRoot, 'outbound-attachments');
    fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
    const name = path.basename(source).replace(/[^A-Za-z0-9._-]+/g, '-');
    const target = path.join(targetDir, `${digest.slice(0, 12)}-${name || 'attachment'}`);
    if (!fs.existsSync(target)) fs.copyFileSync(source, target);
    staged.push(target);
  }
  return staged;
}

function parseArgs(argv) {
  const out = { recipient: '', message: '', attachments: [], account: process.env.SIGNAL_ACCOUNT || '', actionId: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--recipient') out.recipient = argv[++i] || '';
    else if (arg === '--message') out.message = argv[++i] || '';
    else if (arg === '--attachment') out.attachments.push(argv[++i] || '');
    else if (arg === '--account') out.account = argv[++i] || '';
    else if (arg === '--action-id') out.actionId = argv[++i] || '';
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!out.recipient) throw new Error('--recipient is required');
  if (!out.message && out.attachments.length === 0) throw new Error('--message or --attachment is required');
  return out;
}

async function sendAndArchive(args, options = {}) {
  const stateRoot = options.stateRoot || process.env.SIGNAL_INGEST_ROOT || '/opt/secondbrain-durable/signal-ingest';
  const actionId = String(args.actionId || options.actionId || crypto.randomUUID()).replace(/[^A-Za-z0-9._-]+/g, '-');
  const outboxFile = path.join(stateRoot, 'outbox', `${actionId}.json`);
  let job = readJson(outboxFile);
  if (job && job.status === 'complete') return { result: job.signalResult, archive: job.archive, duplicate: true };
  if (job && job.status === 'dispatching') {
    throw new Error(`Signal action ${actionId} has an uncertain dispatch outcome; refusing an automatic duplicate`);
  }
  const staged = job ? job.attachments : stageAttachments(args.attachments || [], stateRoot);
  if (!job) {
    job = {
      schema: 'amy.signal.outbox.v1',
      actionId,
      status: 'queued',
      createdAt: new Date().toISOString(),
      account: args.account || '',
      recipient: args.recipient,
      message: args.message || '',
      attachments: staged,
    };
    atomicWriteJson(outboxFile, job);
  }
  if (!job.account) {
    const accounts = await (options.rpc || rpc)('listAccounts', {}, options);
    const first = Array.isArray(accounts) ? accounts[0] : null;
    job.account = typeof first === 'string' ? first : String(first && (first.number || first.account) || '');
    if (!job.account) throw new Error('No linked Signal account is available');
    atomicWriteJson(outboxFile, job);
  }
  const params = {
    recipient: [job.recipient],
    ...(job.message ? { message: job.message } : {}),
    ...(staged.length ? { attachments: staged } : {}),
    ...(job.account ? { account: job.account } : {}),
  };
  if (job.status === 'queued') {
    job.status = 'dispatching';
    job.dispatchStartedAt = new Date().toISOString();
    atomicWriteJson(outboxFile, job);
    try {
      job.signalResult = await (options.rpc || rpc)('send', params, options);
      job.status = 'accepted';
      job.acceptedAt = new Date().toISOString();
      atomicWriteJson(outboxFile, job);
    } catch (error) {
      job.lastError = { at: new Date().toISOString(), message: error.message };
      atomicWriteJson(outboxFile, job);
      throw error;
    }
  }
  const timestamp = Number(job.signalResult && job.signalResult.timestamp) || Date.now();
  const notification = job.notification || {
    jsonrpc: '2.0',
    method: 'receive',
    params: {
      account: job.account || '',
      envelope: {
        timestamp,
        syncMessage: {
          sentMessage: {
            destination: job.recipient,
            destinationNumber: job.recipient,
            timestamp,
            message: job.message || '',
            attachments: staged.map((filename) => ({ filename })),
          },
        },
      },
    },
  };
  job.notification = notification;
  atomicWriteJson(outboxFile, job);
  const journal = recordReceiverJournal(notification, { stateRoot });
  job.receiverJournal = {
    journalId: journal.record?.journalId || null,
    file: journal.file,
    duplicate: journal.duplicate === true,
  };
  atomicWriteJson(outboxFile, job);
  job.archive = await (options.processNotification || processNotification)(notification, {
    stateRoot,
    signalRoot: stateRoot,
  });
  job.status = 'complete';
  job.completedAt = new Date().toISOString();
  atomicWriteJson(outboxFile, job);
  return { result: job.signalResult, archive: job.archive };
}

function summarizeSendResult(result) {
  const rows = Array.isArray(result && result.result && result.result.results)
    ? result.result.results
    : [];
  return {
    ok: true,
    eventId: result && result.archive && result.archive.normalized && result.archive.normalized.id,
    duplicate: result && result.duplicate === true,
    acceptedRecipients: rows.filter((row) => String(row && row.type || '').toUpperCase() === 'SUCCESS').length,
    failures: rows.filter((row) => String(row && row.type || '').toUpperCase() !== 'SUCCESS').length,
    timestamp: result && result.result && result.result.timestamp,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await sendAndArchive(args);
  console.log(JSON.stringify(summarizeSendResult(result)));
}

if (require.main === module) main().catch((error) => {
  console.error(`[signal-send] ${error.message}`);
  process.exit(1);
});

module.exports = { main, parseArgs, rpc, sendAndArchive, stageAttachments, summarizeSendResult };
