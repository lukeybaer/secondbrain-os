'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function runtimeDataDir(explicit) {
  if (explicit) return path.resolve(explicit);
  if (process.env.SECONDBRAIN_DATA_DIR) return path.resolve(process.env.SECONDBRAIN_DATA_DIR);
  if (process.platform === 'win32' && process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'secondbrain', 'data');
  }
  if (fs.existsSync('/opt/secondbrain')) return '/opt/secondbrain/data';
  return path.join(os.homedir(), '.secondbrain', 'data');
}

function sessionEventOutboxPaths(dataDir) {
  const root = path.join(runtimeDataDir(dataDir), 'agent', 'session-cloud-outbox');
  return {
    root,
    pending: path.join(root, 'pending'),
    delivered: path.join(root, 'delivered'),
    receipts: path.join(root, 'receipts'),
  };
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  return file;
}

function safeEventId(value) {
  const id = String(value || '').trim();
  if (!/^[a-zA-Z0-9._:-]{1,160}$/.test(id)) throw new Error('session event_id is missing or unsafe');
  return id;
}

function cloudSessionEvent(event) {
  if (!event || typeof event !== 'object') throw new Error('session outbox event is required');
  // Attempts and errors are local delivery state. They must never enter the
  // event fingerprint, so retries retain the exact durable cloud identity.
  const { outbox, ...canonical } = event;
  return canonical;
}

function enqueueSessionEvent(event, { dataDir, now = new Date() } = {}) {
  const id = safeEventId(event?.event_id);
  const paths = sessionEventOutboxPaths(dataDir);
  const file = path.join(paths.pending, `${id}.json`);
  const delivered = path.join(paths.delivered, `${id}.json`);
  if (fs.existsSync(file) || fs.existsSync(delivered)) return { queued: false, duplicate: true, file };
  atomicWriteJson(file, {
    ...event,
    outbox: {
      queued_at: now.toISOString(),
      attempts: 0,
      last_attempt_at: null,
      last_error: '',
    },
  });
  return { queued: true, duplicate: false, file };
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function listPendingSessionEvents({ dataDir, limit = 1000 } = {}) {
  const dir = sessionEventOutboxPaths(dataDir).pending;
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  return files
    .map((name) => {
      const file = path.join(dir, name);
      const event = readJson(file);
      return event ? { file, event } : null;
    })
    .filter(Boolean)
    .sort((a, b) => {
      const at = Date.parse(a.event.outbox?.queued_at || a.event.occurred_at || '') || 0;
      const bt = Date.parse(b.event.outbox?.queued_at || b.event.occurred_at || '') || 0;
      return at - bt;
    })
    .slice(0, Math.max(1, Math.min(5000, Number(limit) || 1000)));
}

function countPendingSessionEvents({ dataDir, readdir = fs.readdirSync } = {}) {
  try {
    return readdir(sessionEventOutboxPaths(dataDir).pending)
      .filter((name) => name.endsWith('.json')).length;
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
}

async function drainSessionEventOutbox({
  dataDir,
  send,
  sendBatch,
  onDelivered,
  onBatch,
  limit = 100,
  batchSize = 1,
  now = new Date(),
  admissionBudgetMs,
  // Compatibility for callers from the first batch cutover. This is not a
  // strict wall-clock cap: it gates admission before each remote operation.
  maxWallClockMs,
  clock = () => Date.now(),
} = {}) {
  if (typeof send !== 'function' && typeof sendBatch !== 'function') {
    throw new Error('session outbox drain requires a send or sendBatch function');
  }
  const paths = sessionEventOutboxPaths(dataDir);
  const pending = listPendingSessionEvents({ dataDir, limit });
  const startedAtMs = clock();
  const budgetMs = Math.max(1, Number(admissionBudgetMs ?? maxWallClockMs) || 60_000);
  const result = { attempted: 0, delivered: 0, failed: 0, isolated: 0, remaining: pending.length, budget_exhausted: false };
  const safeBatchSize = Math.max(1, Math.min(20, Math.floor(Number(batchSize)) || 1));
  const effectiveBatchSize = typeof sendBatch === 'function' ? safeBatchSize : 1;

  const failed = async (item, receipt) => {
    result.failed += 1;
    atomicWriteJson(item.file, {
      ...item.event,
      outbox: {
        ...(item.event.outbox || {}),
        attempts: Number(item.event.outbox?.attempts || 0) + 1,
        last_attempt_at: now.toISOString(),
        last_error: String(receipt?.reason || receipt?.error || 'cloud ingest failed').slice(0, 1000),
      },
    });
  };
  const delivered = async (item, receipt, { requireBinding = false } = {}) => {
    const expectedId = safeEventId(item.event.event_id);
    if (requireBinding && (receipt?.event_id !== item.event.event_id || receipt?.receipt_id !== `session-cloud:${expectedId}`)) {
      await failed(item, { reason: 'cloud batch response did not bind the expected event and receipt ids' });
      return;
    }
    const deliveredFile = path.join(paths.delivered, `${expectedId}.json`);
    atomicWriteJson(deliveredFile, {
      ...item.event,
      outbox: {
        ...(item.event.outbox || {}),
        attempts: Number(item.event.outbox?.attempts || 0) + 1,
        last_attempt_at: now.toISOString(),
        delivered_at: now.toISOString(),
        last_error: '',
      },
    });
    atomicWriteJson(path.join(paths.receipts, `${expectedId}.json`), {
      schema: 'amy.session_event_delivery_receipt.v1',
      event_id: item.event.event_id,
      delivered_at: now.toISOString(),
      receipt,
    });
    fs.unlinkSync(item.file);
    if (typeof onDelivered === 'function') await onDelivered(item.event, receipt);
    result.delivered += 1;
  };

  const completeBatch = (items, response) => {
    const rows = Array.isArray(response?.results) ? response.results : null;
    const byEventId = new Map();
    const complete = response?.ok === true && rows?.length === items.length && rows.every((row) => {
      if (!row || typeof row.event_id !== 'string' || byEventId.has(row.event_id)) return false;
      byEventId.set(row.event_id, row);
      return true;
    }) && items.every((item) => byEventId.has(item.event.event_id));
    return { complete, byEventId };
  };
  const sendOneBatch = async (items) => {
    try {
      return await sendBatch(items.map((item) => cloudSessionEvent(item.event)));
    } catch (error) {
      return { ok: false, reason: String(error?.message || error) };
    }
  };

  for (let offset = 0; offset < pending.length; offset += effectiveBatchSize) {
    if (clock() - startedAtMs >= budgetMs) {
      result.budget_exhausted = true;
      break;
    }
    const items = pending.slice(offset, offset + effectiveBatchSize);
    result.attempted += items.length;
    if (typeof sendBatch === 'function') {
      const response = await sendOneBatch(items);
      const { complete, byEventId } = completeBatch(items, response);
      if (!complete && response?.ok === false && response?.definitive === true && !Array.isArray(response?.results) && items.length > 1) {
        // A validation rejection names no successful row. Isolate it once so a
        // poisoned head record stays visible and retryable without blocking its
        // healthy FIFO neighbours. Timeouts and malformed replies never enter
        // this path because their outcome remains ambiguous.
        for (const item of items) {
          if (clock() - startedAtMs >= budgetMs) {
            result.budget_exhausted = true;
            break;
          }
          result.isolated += 1;
          const singleton = await sendOneBatch([item]);
          const one = completeBatch([item], singleton);
          if (!one.complete) await failed(item, singleton);
          else {
            const receipt = one.byEventId.get(item.event.event_id);
            if (receipt?.ok === true) await delivered(item, receipt, { requireBinding: true });
            else await failed(item, receipt);
          }
        }
      } else if (!complete) {
        for (const item of items) await failed(item, { reason: response?.reason || 'cloud batch response was partial or ambiguous' });
      } else for (const item of items) {
        const receipt = byEventId.get(item.event.event_id);
        if (receipt?.ok === true) await delivered(item, receipt, { requireBinding: true });
        else await failed(item, receipt);
      }
      if (typeof onBatch === 'function') await onBatch({ result, response, items });
      continue;
    }
    const item = items[0];
    let receipt;
    try {
      receipt = await send(cloudSessionEvent(item.event));
    } catch (error) {
      receipt = { ok: false, reason: String(error?.message || error) };
    }
    if (!receipt || receipt.ok !== true) {
      await failed(item, receipt);
      continue;
    }
    await delivered(item, receipt);
    if (typeof onBatch === 'function') await onBatch({ result, receipt, items });
  }
  result.remaining = countPendingSessionEvents({ dataDir });
  return result;
}

module.exports = {
  atomicWriteJson,
  cloudSessionEvent,
  countPendingSessionEvents,
  drainSessionEventOutbox,
  enqueueSessionEvent,
  listPendingSessionEvents,
  runtimeDataDir,
  sessionEventOutboxPaths,
};
