// voiceprint.js
//
// E2 (Amy overhaul, 2026-06-12): voiceprint template store + verifier.
// Phone-number caller ID is spoofable; the privileged-action gate in
// ec2-server.js only unlocks frictionless privileged execution for a caller
// whose AUDIO matches an enrolled template (an enrolled household member).
//
// Security properties:
//  - Templates are ENCRYPTED AT REST (AES-256-GCM). The store file on disk is
//    an opaque blob: no names, no readable float vectors.
//  - Key comes from env SB_VOICEPRINT_KEY (64-char hex used directly, any
//    other string is SHA-256-derived to 32 bytes). FAIL LOUD: if templates
//    exist and the key is unset/wrong, every call throws; no silent
//    "no match" downgrade that would quietly disable the feature.
//  - Matching is cosine similarity on speaker embeddings (the same
//    ECAPA/WavLM vectors scripts/otter-wavlm-speaker-resolver.js uses), with
//    a conservative default threshold of 0.78.
//
// Enrollment CLI: scripts/voiceprint-enroll.mjs (audio file -> embedding ->
// enrollTemplate).

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = 'amy_voiceprint_store.v1';
const ALGORITHM = 'aes-256-gcm';
const DEFAULT_THRESHOLD = 0.78;
// Resolves relative to this file so it works on the PC checkout AND on EC2
// (/opt/secondbrain/...) without configuration, mirroring security-events.js.
const DEFAULT_STORE_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  'data',
  'agent',
  'voiceprint-templates.enc.json',
);

function deriveKey(rawKey) {
  const raw = String(rawKey || '').trim();
  if (!raw) return null;
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
  return crypto.createHash('sha256').update(raw).digest();
}

function keyFromEnv(env) {
  return deriveKey((env || process.env).SB_VOICEPRINT_KEY);
}

function encryptTemplates(templates, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const plaintext = Buffer.from(JSON.stringify(templates), 'utf8');
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    data: data.toString('base64'),
  };
}

function decryptTemplates(blob, key) {
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(blob.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(blob.tag, 'hex'));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(blob.data, 'base64')),
    decipher.final(),
  ]);
  return JSON.parse(plain.toString('utf8'));
}

function validateVector(vec) {
  if (!Array.isArray(vec) || vec.length < 8) {
    throw new Error('voiceprint: embedding vector must be an array of at least 8 numbers');
  }
  for (const v of vec) {
    if (!Number.isFinite(v)) throw new Error('voiceprint: embedding vector has non-finite values');
  }
}

function cosineSimilarity(a, b) {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Read + decrypt the template store. Fail loud when templates exist on disk
// but no key is configured: a missing key must never silently mean "nobody
// is enrolled".
function readTemplates(storePath = DEFAULT_STORE_PATH, { env = process.env } = {}) {
  if (!fs.existsSync(storePath)) return [];
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  } catch (e) {
    throw new Error('voiceprint: store at ' + storePath + ' is unreadable: ' + e.message);
  }
  if (!raw || !raw.blob) return [];
  const key = keyFromEnv(env);
  if (!key) {
    throw new Error(
      'voiceprint: templates exist at ' +
        storePath +
        ' but SB_VOICEPRINT_KEY is not set. Refusing to operate without the key (fail loud).',
    );
  }
  try {
    return decryptTemplates(raw.blob, key);
  } catch (e) {
    throw new Error(
      'voiceprint: could not decrypt the template store (wrong SB_VOICEPRINT_KEY?): ' + e.message,
    );
  }
}

// Enroll (or replace) a named template. Requires the key: templates are never
// written in plaintext.
function enrollTemplate(
  name,
  embeddingVector,
  storePath = DEFAULT_STORE_PATH,
  { env = process.env } = {},
) {
  const who = String(name || '').trim();
  if (!who) throw new Error('voiceprint: a non-empty name is required to enroll');
  validateVector(embeddingVector);
  const key = keyFromEnv(env);
  if (!key) {
    throw new Error(
      'voiceprint: SB_VOICEPRINT_KEY must be set to enroll templates (encrypted at rest, no plaintext fallback).',
    );
  }
  const templates = readTemplates(storePath, { env }).filter((t) => t.name !== who);
  templates.push({
    name: who,
    vector: embeddingVector.map(Number),
    enrolledAt: new Date().toISOString(),
  });
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(
    storePath,
    JSON.stringify(
      {
        schema: SCHEMA,
        updatedAt: new Date().toISOString(),
        count: templates.length,
        blob: encryptTemplates(templates, key),
      },
      null,
      2,
    ),
  );
  return { name: who, count: templates.length, storePath };
}

// Verify an embedding against the enrolled templates.
// Returns { match, name, score }: name/score describe the BEST candidate
// (useful as a context signal); match is the only field the privileged gate
// may trust, and only when score clears the threshold.
function verifyEmbedding(embeddingVector, storePath = DEFAULT_STORE_PATH, opts = {}) {
  const { threshold = DEFAULT_THRESHOLD, env = process.env } = opts;
  validateVector(embeddingVector);
  const templates = readTemplates(storePath, { env });
  if (!templates.length) return { match: false, name: null, score: 0, reason: 'no-templates' };
  let bestName = null;
  let bestScore = -1;
  for (const t of templates) {
    if (!Array.isArray(t.vector)) continue;
    const score = cosineSimilarity(embeddingVector, t.vector);
    if (score > bestScore) {
      bestScore = score;
      bestName = t.name;
    }
  }
  const score = Math.max(0, bestScore);
  return { match: score >= threshold, name: bestName, score };
}

module.exports = {
  enrollTemplate,
  verifyEmbedding,
  readTemplates,
  cosineSimilarity,
  DEFAULT_THRESHOLD,
  DEFAULT_STORE_PATH,
  SCHEMA,
};
