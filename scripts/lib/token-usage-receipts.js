'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isHealerExcluded, sidecarPathFor } = require('./collector-degrade.js');

const PROVIDERS = new Set(['claude', 'codex', 'bedrock']);
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const LEGACY_FILES = Object.freeze({
  claude: 'claude-plan-usage.json',
  codex: 'codex-token-usage-week.json',
  bedrock: 'bedrock-budget-usage.json',
});

function assertProvider(provider) {
  const normalized = String(provider || '')
    .trim()
    .toLowerCase();
  if (!PROVIDERS.has(normalized)) {
    throw new Error(`PRIVATE_NAME token usage provider: ${provider || '<missing>'}`);
  }
  return normalized;
}

function ctDateKey(value = Date.now()) {
  const date = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function providerReceiptPath(dataDir, date, provider) {
  const id = assertProvider(provider);
  const day = String(date || ctDateKey()).slice(0, 10);
  return path.join(dataDir, 'agent', 'token-usage-receipts', day, `${id}.json`);
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function writeProviderReceipt({
  dataDir,
  date,
  provider,
  observedAt = new Date().toISOString(),
  status,
  source,
  payload = null,
  defect = null,
} = {}) {
  if (!dataDir) throw new Error('dataDir is required for a token provider receipt');
  const id = assertProvider(provider);
  const day = String(date || ctDateKey(observedAt)).slice(0, 10);
  const normalizedStatus =
    status === 'clean' ? 'clean' : status === 'inconclusive' ? 'inconclusive' : 'blocked';
  const receipt = {
    schemaVersion: 1,
    provider: id,
    date: day,
    observedAt,
    status: normalizedStatus,
    source: String(source || ''),
    payload: payload && typeof payload === 'object' ? payload : null,
    defect:
      normalizedStatus === 'clean'
        ? null
        : {
            code: String(defect?.code || normalizedStatus),
            detail: String(defect?.detail || `${id} usage collection ${normalizedStatus}`),
          },
  };
  const file = providerReceiptPath(dataDir, day, id);
  writeJsonAtomic(file, receipt);
  return { file, receipt };
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function receiptState(receipt, { now = new Date(), maxAgeMs = DEFAULT_MAX_AGE_MS } = {}) {
  if (!receipt || typeof receipt !== 'object') return null;
  if (receipt.status !== 'clean') {
    return {
      state: receipt.status === 'inconclusive' ? 'inconclusive' : 'blocked',
      defect: receipt.defect || {
        code: receipt.status || 'blocked',
        detail: 'Provider receipt is not clean.',
      },
    };
  }
  const observedMs = Date.parse(receipt.observedAt || '');
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(observedMs)) {
    return {
      state: 'blocked',
      defect: {
        code: 'parse_error',
        detail: 'Provider receipt has no valid observedAt timestamp.',
      },
    };
  }
  const ageMs = Math.max(0, nowMs - observedMs);
  if (ageMs > maxAgeMs) {
    return {
      state: 'stale',
      defect: {
        code: 'stale',
        detail: `Provider receipt is ${Math.round(ageMs / 1000)} seconds old.`,
        staleBySeconds: Math.round((ageMs - maxAgeMs) / 1000),
      },
    };
  }
  return { state: 'fresh', defect: null };
}

function legacyState({ dataDir, provider, now, maxAgeMs }) {
  const file = path.join(dataDir, 'agent', LEGACY_FILES[provider]);
  const payload = readJson(file);
  if (!payload) return null;
  let observedAt = payload.generated_at || payload.generatedAt || '';
  if (!observedAt) {
    try {
      observedAt = fs.statSync(file).mtime.toISOString();
    } catch {
      observedAt = '';
    }
  }
  const verdict = receiptState({ status: 'clean', observedAt }, { now, maxAgeMs });
  return { ...verdict, payload, observedAt, file, sourceMode: 'legacy-fallback', receipt: null };
}

function readProviderUsage({
  dataDir,
  date,
  provider,
  now = new Date(),
  maxAgeMs = DEFAULT_MAX_AGE_MS,
} = {}) {
  if (!dataDir) throw new Error('dataDir is required to read token provider usage');
  const id = assertProvider(provider);
  const day = String(date || ctDateKey(now)).slice(0, 10);
  const file = providerReceiptPath(dataDir, day, id);
  const receipt = readJson(file);
  if (receipt) {
    const verdict = receiptState(receipt, { now, maxAgeMs });
    // When the receipt is blocked AND the degrade sidecar for the legacy file
    // marks this as a structural/healer-excluded fault (e.g. Cloudflare 403 on
    // EC2 datacenter IPs), fall back to the last-good legacy snapshot rather
    // than surfacing a blocked card. The PC credential authority keeps
    // claude-plan-usage.json fresh via hourly sync, so the legacy file is the
    // authoritative source when EC2 direct collection is provisioning-blocked.
    if (verdict.state === 'blocked') {
      const legacyFile = path.join(dataDir, 'agent', LEGACY_FILES[id]);
      let healerExcluded = false;
      try {
        const sidecar = readJson(sidecarPathFor(legacyFile));
        healerExcluded = isHealerExcluded(sidecar);
      } catch {
        // sidecar unreadable -> not healer-excluded, keep blocked verdict
      }
      if (healerExcluded) {
        const legacy = legacyState({ dataDir, provider: id, now, maxAgeMs });
        if (legacy && legacy.state === 'fresh') {
          return { provider: id, date: day, ...legacy };
        }
      }
    }
    return {
      ...verdict,
      provider: id,
      date: day,
      payload: receipt.payload,
      observedAt: receipt.observedAt || null,
      file,
      sourceMode: 'receipt',
      receipt,
    };
  }
  const legacy = legacyState({ dataDir, provider: id, now, maxAgeMs });
  if (legacy) return { provider: id, date: day, ...legacy };
  return {
    provider: id,
    date: day,
    state: 'missing',
    payload: null,
    observedAt: null,
    file,
    sourceMode: 'missing',
    receipt: null,
    defect: { code: 'missing', detail: `No ${id} token usage receipt exists for ${day}.` },
  };
}

module.exports = {
  DEFAULT_MAX_AGE_MS,
  ctDateKey,
  providerReceiptPath,
  readProviderUsage,
  receiptState,
  writeProviderReceipt,
};
