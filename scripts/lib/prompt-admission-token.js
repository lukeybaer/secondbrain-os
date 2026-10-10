'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildAdvisorPromptBlock } = require('./graphiti-brain-advisor.js');
const { recordOperationEvent } = require('./operation-provenance.js');

const SCHEMA = 'amy.prompt_admission.v1';
const SIDE_EFFECT_WAIT_MS = 2500;
const DUPLICATE_WINDOW_MS = 10_000;
const INHERIT_WINDOW_MS = 60 * 60_000;

function runtimeDataDir(explicit) {
  if (explicit) return path.resolve(explicit);
  if (process.env.SECONDBRAIN_DATA_DIR) return path.resolve(process.env.SECONDBRAIN_DATA_DIR);
  if (process.platform === 'win32' && process.env.APPDATA) {
    return path.join(process.env.APPDATA, 'secondbrain', 'data');
  }
  if (fs.existsSync('/opt/secondbrain')) return '/opt/secondbrain/data';
  return path.join(os.homedir(), '.secondbrain', 'data');
}

function admissionPaths(dataDir) {
  const agent = path.join(runtimeDataDir(dataDir), 'agent');
  return {
    agent,
    tokens: path.join(agent, 'prompt-admission', 'tokens'),
    delivered: path.join(agent, 'prompt-admission', 'delivered'),
    sessions: path.join(agent, 'prompt-admission-sessions.json'),
    advisorResults: path.join(agent, 'graphiti-advisor', 'results'),
  };
}

function safeReadJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function promptHash(prompt) {
  return sha256(String(prompt || '').trim()).slice(0, 24);
}

function actorKey(input = {}) {
  const sessionId = String(input.sessionId || input.session_id || 'claude-unknown');
  const agentId = String(input.agentId || input.agent_id || '').trim();
  return agentId ? `${sessionId}:agent:${agentId}` : `${sessionId}:root`;
}

function authorityFileList(root) {
  const required = [
    'memory/MEMORY.md',
    'memory/AMY.md',
    'memory/AMY_AUTHORIZATIONS.md',
    'memory/AMY_GRAVITY.md',
    'memory/AMY_REQUIREMENTS.md',
    'memory/requirements/unit-independence.md',
    '.codex/instructions.md',
    'claude-config/CLAUDE.global.md',
  ];
  let core = [];
  try {
    core = fs
      .readdirSync(path.join(root, 'dev-plans', 'core'), { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.endsWith('.md') &&
          !entry.name.endsWith('.LESSONS.md'),
      )
      .map((entry) => `dev-plans/core/${entry.name}`);
  } catch {
    core = [];
  }
  return [...required, ...core].sort();
}

function authorityDigest({ root, readFile = fs.readFileSync, files } = {}) {
  const repoRoot = path.resolve(root || path.join(__dirname, '..', '..'));
  const rows = [];
  const missing = [];
  for (const rel of files || authorityFileList(repoRoot)) {
    try {
      const content = readFile(path.join(repoRoot, rel), 'utf8');
      rows.push({ path: rel.replace(/\\/g, '/'), sha256: sha256(content), bytes: Buffer.byteLength(content) });
    } catch {
      missing.push(rel.replace(/\\/g, '/'));
    }
  }
  const digest = sha256(
    rows.map((row) => `${row.path}\0${row.sha256}\0${row.bytes}`).join('\n'),
  );
  return {
    status: missing.length ? 'incomplete' : 'verified',
    sha256: digest,
    file_count: rows.length,
    files: rows,
    missing,
  };
}

function tokenPath(paths, tokenId) {
  return path.join(paths.tokens, `${tokenId}.json`);
}

function readToken(tokenId, { dataDir } = {}) {
  if (!tokenId) return null;
  return safeReadJson(tokenPath(admissionPaths(dataDir), tokenId));
}

function readSessionIndex(paths) {
  return safeReadJson(paths.sessions, {}) || {};
}

function readTokenForActor(input = {}, { dataDir } = {}) {
  const paths = admissionPaths(dataDir);
  const tokenId = readSessionIndex(paths)[actorKey(input)]?.token_id;
  return readToken(tokenId, { dataDir });
}

function parentTokenFor(input, paths) {
  const explicit = String(
    input.parentTokenId ||
      input.parent_token_id ||
      process.env.SB_PARENT_PROMPT_TOKEN_ID ||
      '',
  ).trim();
  if (explicit) return safeReadJson(tokenPath(paths, explicit));
  const agentId = String(input.agentId || input.agent_id || '').trim();
  if (!agentId) return null;
  const sessionId = String(input.sessionId || input.session_id || 'claude-unknown');
  const rootTokenId = readSessionIndex(paths)[`${sessionId}:root`]?.token_id;
  return rootTokenId ? safeReadJson(tokenPath(paths, rootTokenId)) : null;
}

function intentChanged(input = {}) {
  const raw =
    input.intentChanged ??
    input.intent_changed ??
    (process.env.SB_PROMPT_INTENT_CHANGED === '1' ? true : undefined);
  return raw === true || raw === 1 || String(raw || '').toLowerCase() === 'true';
}

function createPromptAdmission(input = {}, options = {}) {
  const nowMs = Number(options.nowMs ?? Date.now());
  const paths = admissionPaths(options.dataDir);
  const key = actorKey(input);
  const prompt = String(input.prompt || '').trim();
  const hash = promptHash(prompt);
  const sessions = readSessionIndex(paths);
  const previous = sessions[key]?.token_id
    ? safeReadJson(tokenPath(paths, sessions[key].token_id))
    : null;
  if (
    previous &&
    previous.prompt_hash === hash &&
    nowMs - Number(previous.created_ms || 0) <=
      Number(options.duplicateWindowMs ?? DUPLICATE_WINDOW_MS)
  ) {
    return { token: previous, queryRequired: false, deduplicated: true, inherited: false };
  }

  const parent = parentTokenFor(input, paths);
  const inherited = Boolean(parent && !intentChanged(input));
  const randomHex =
    options.randomHex ||
    (() => crypto.randomBytes(5).toString('hex'));
  const tokenId = `pa_${nowMs}_${randomHex()}`;
  const advisorId = inherited
    ? parent.advisor_id
    : `ga_${nowMs}_${randomHex()}`;
  const digest = inherited
    ? parent.authority_digest
    : authorityDigest({ root: options.root, readFile: options.readFile, files: options.files });
  const sessionId = String(input.sessionId || input.session_id || 'claude-unknown');
  const agentId = String(input.agentId || input.agent_id || '').trim() || null;
  const token = {
    schema: SCHEMA,
    token_id: tokenId,
    operation_id: inherited ? parent.operation_id : `op_${nowMs}_${randomHex()}`,
    surface: String(input.surface || 'claude-code'),
    session_id: sessionId,
    actor_key: key,
    agent_id: agentId,
    cwd: path.resolve(String(input.cwd || process.cwd())),
    prompt_hash: hash,
    created_at: new Date(nowMs).toISOString(),
    created_ms: nowMs,
    authority_digest: digest,
    advisor_id: advisorId,
    advisor_status: inherited ? 'inherited' : 'admitted',
    query_count: inherited ? 0 : 1,
    inherited_from: inherited ? parent.token_id : null,
    intent_changed: intentChanged(input),
  };
  atomicWriteJson(tokenPath(paths, tokenId), token);
  // Re-read immediately before writing and merge ONLY this actor's key. The
  // snapshot taken at the top of this function is stale by the time the
  // authority digest and advisor start have finished, and parallel subagent
  // siblings admit concurrently, so writing the stale snapshot back would drop
  // whichever sibling (or parent root) landed in between and recreate the
  // missing-token failures this path exists to prevent.
  const current = readSessionIndex(paths);
  current[key] = {
    token_id: tokenId,
    prompt_hash: hash,
    updated_at: token.created_at,
  };
  atomicWriteJson(paths.sessions, current);
  try {
    recordOperationEvent(
      {
        operationId: token.operation_id,
        eventType: 'prompt.admitted',
        surface: token.surface,
        sessionId,
        cwd: input.cwd || process.cwd(),
        status: digest.status === 'verified' ? 'green' : 'amber',
        details: {
          token_id: tokenId,
          advisor_id: advisorId,
          authority_digest: digest.sha256,
          inherited,
          intent_changed: token.intent_changed,
        },
      },
      { dataDir: options.dataDir, now: new Date(nowMs) },
    );
  } catch {
    // Admission remains available when the local append spool is unavailable.
    // Gravity health will report the missing provenance rather than blocking.
  }
  return { token, queryRequired: !inherited, deduplicated: false, inherited };
}

function cwdMatchKey(value) {
  const resolved = path.resolve(String(value || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

// Claude Code subagent sessions run hooks under their own session_id and no
// UserPromptSubmit ever fires for them, so no token exists for their actor
// key. Adopt the parent conversation's most recent root token in the same
// cwd within INHERIT_WINDOW_MS and mint an inherited child token through the
// normal createPromptAdmission parentTokenId path: no authority recompute,
// no new Graphiti query, inherited_from set. Returns null when no parent
// qualifies so callers keep their existing missing-token behavior.
function inheritTokenFromRecentParent(input = {}, options = {}) {
  const sessionId = String(input.sessionId || input.session_id || '').trim();
  const cwd = String(input.cwd || '').trim();
  if (!sessionId || !cwd) return null;
  const agentId = String(input.agentId || input.agent_id || '').trim();
  const paths = admissionPaths(options.dataDir);
  const nowMs = Number(options.nowMs ?? Date.now());
  const windowMs = Number(options.windowMs ?? INHERIT_WINDOW_MS);
  const wanted = cwdMatchKey(cwd);
  // A Claude Code subagent runs under the SAME session_id as its parent and is
  // separated only by agent_id, so its own conversation root IS the sanctioned
  // parent -- the rule parentTokenFor already encodes for the start hook. The
  // cross-session scan below deliberately skips `${sessionId}:root`, so without
  // this branch every same-session agent reported a missing token on every
  // side-effect tool call and lost recall for its whole prompt (invariant 7).
  if (agentId) {
    const ownRoot = readSessionIndex(paths)[`${sessionId}:root`];
    const ownParent = ownRoot?.token_id
      ? safeReadJson(tokenPath(paths, ownRoot.token_id))
      : null;
    const ownUpdatedMs = Date.parse(String(ownRoot?.updated_at || ''));
    if (
      ownParent &&
      Number.isFinite(ownUpdatedMs) &&
      nowMs - ownUpdatedMs <= windowMs &&
      ownParent.cwd &&
      cwdMatchKey(ownParent.cwd) === wanted
    ) {
      return createPromptAdmission(
        {
          sessionId,
          agentId,
          cwd,
          parentTokenId: ownParent.token_id,
          surface: ownParent.surface,
        },
        { dataDir: options.dataDir, nowMs },
      );
    }
  }
  const candidates = Object.entries(readSessionIndex(paths))
    .filter(
      ([key, entry]) =>
        key.endsWith(':root') && key !== `${sessionId}:root` && entry?.token_id,
    )
    .map(([, entry]) => ({ entry, updatedMs: Date.parse(String(entry.updated_at || '')) }))
    .filter(({ updatedMs }) => Number.isFinite(updatedMs) && nowMs - updatedMs <= windowMs)
    .sort((a, b) => b.updatedMs - a.updatedMs);
  for (const { entry } of candidates) {
    const parent = safeReadJson(tokenPath(paths, entry.token_id));
    if (!parent || !parent.cwd || cwdMatchKey(parent.cwd) !== wanted) continue;
    return createPromptAdmission(
      {
        sessionId,
        agentId: agentId || undefined,
        cwd,
        parentTokenId: parent.token_id,
        surface: parent.surface,
      },
      { dataDir: options.dataDir, nowMs },
    );
  }
  return null;
}

function updatePromptAdmission(tokenId, patch, { dataDir } = {}) {
  const paths = admissionPaths(dataDir);
  const file = tokenPath(paths, tokenId);
  const current = safeReadJson(file);
  if (!current) return null;
  const next = { ...current, ...patch };
  atomicWriteJson(file, next);
  return next;
}

function claimDelivery(paths, tokenId) {
  const marker = path.join(paths.delivered, `${tokenId}.delivered`);
  try {
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, new Date().toISOString(), { flag: 'wx', mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

function isDelivered(paths, tokenId) {
  return fs.existsSync(path.join(paths.delivered, `${tokenId}.delivered`));
}

function incompleteEnvelope(token, waitMs) {
  return {
    schema: 'amy.graphiti_advisor.v1',
    advisor_id: token?.advisor_id || null,
    surface: token?.surface || 'claude-code',
    conversation_id: token?.actor_key || '',
    status: 'pending',
    facts: [],
    error: `Graphiti consultation is still running after ${waitMs}ms`,
  };
}

function sleepSync(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function loadPromptAdmissionContext(
  input = {},
  { dataDir, waitMs = 0, now = Date.now, sleep = sleepSync } = {},
) {
  const paths = admissionPaths(dataDir);
  const token = readTokenForActor(input, { dataDir });
  if (!token) return { status: 'missing-token', token: null, envelope: null, promptBlock: '' };
  if (isDelivered(paths, token.token_id)) {
    return { status: 'already-delivered', token, envelope: null, promptBlock: '' };
  }
  const boundedWait = Math.min(SIDE_EFFECT_WAIT_MS, Math.max(0, Number(waitMs) || 0));
  const resultFile = path.join(paths.advisorResults, `${token.advisor_id}.json`);
  const deadline = now() + boundedWait;
  let envelope = safeReadJson(resultFile);
  while (!envelope && now() < deadline) {
    sleep(Math.min(50, Math.max(1, deadline - now())));
    envelope = safeReadJson(resultFile);
  }
  if (!envelope) envelope = incompleteEnvelope(token, boundedWait);
  const incomplete = ['pending', 'started', 'timeout', 'unavailable', ''].includes(
    String(envelope.status || '').toLowerCase(),
  );
  if (boundedWait === 0 && incomplete) {
    return { status: 'pending', token, envelope, promptBlock: '' };
  }
  if (!claimDelivery(paths, token.token_id)) {
    return { status: 'already-delivered', token, envelope, promptBlock: '' };
  }
  try {
    recordOperationEvent(
      {
        operationId: token.operation_id,
        eventType: 'prompt.context.delivered',
        surface: token.surface,
        sessionId: token.session_id,
        status: envelope.status || 'unavailable',
        details: {
          token_id: token.token_id,
          advisor_id: token.advisor_id,
          wait_ms: boundedWait,
        },
      },
      { dataDir },
    );
  } catch {
    // Missing telemetry becomes an explicit Gravity-health unknown.
  }
  return {
    status: envelope.status || 'unavailable',
    token,
    envelope,
    promptBlock: [
      `Prompt admission token: ${token.token_id}. Authority digest: ${token.authority_digest?.sha256 || 'unavailable'} (${token.authority_digest?.status || 'unknown'}).`,
      buildAdvisorPromptBlock(envelope),
    ].join('\n'),
  };
}

module.exports = {
  DUPLICATE_WINDOW_MS,
  INHERIT_WINDOW_MS,
  SCHEMA,
  SIDE_EFFECT_WAIT_MS,
  actorKey,
  admissionPaths,
  authorityDigest,
  authorityFileList,
  createPromptAdmission,
  inheritTokenFromRecentParent,
  loadPromptAdmissionContext,
  promptHash,
  readToken,
  readTokenForActor,
  runtimeDataDir,
  updatePromptAdmission,
};
