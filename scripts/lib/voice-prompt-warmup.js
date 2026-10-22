'use strict';

// Paid voice prompt warm-up (Owner decision: "do warm up").
//
// A call's first model turn sends about 6,200 tokens with nothing cached,
// because every prompt opens with that call's own AMY_CALL_ID line. Measured
// over 1,005 paid turns, that cold first turn ran 1.6 s typical (3.9 s on the
// Oct 21 provider slowdown) against 0.9 s for a cached one. At call setup EC2
// already holds the exact system prompt, so one tiny request carrying the
// same tools and system message lets OpenAI cache the prefix while the phone
// is still ringing and the greeting plays.
//
// The contract travels as the developer message with nothing after it. In
// implicit mode OpenAI writes the cache at the latest eligible message and a
// later request looks up the end of its leading developer block, so a warm-up
// that ended in a dummy user message would cache a prefix the caller's first
// turn never repeats (Codex review eefc168c523c, OpenAI prompt-caching guide).
//
// OpenAI caches only an exact prefix, and tools are rendered first. Voice provider
// rewrites tool definitions before it forwards them, so the warm-up replays
// the tool array exactly as voice provider last sent it for the same call contract
// (audience plus tool allowlist), remembered from real turns. With nothing
// remembered there is no warm-up; a stale tool set only misses the cache.

const fs = require('node:fs');
const path = require('node:path');
const {
  callAudienceFromSystemMessages,
  callToolAllowlist,
  trustedSystemContext,
} = require('./vapi-call-correlation');

const WARMUP_TOOLS_FILE = path.join('agent', 'voice-warmup-tools.json');
const MAX_REMEMBERED_TOOL_SETS = 8;

// The same key on both sides: computed from the trusted system message a
// real turn sends and from the one a warm-up will send.
function contractKey(trusted) {
  const messages = { messages: [{ role: 'system', content: String(trusted || '') }] };
  const allowlist = callToolAllowlist(trusted);
  return `${callAudienceFromSystemMessages(messages)}|${allowlist ? [...allowlist].sort().join(',') : '*'}`;
}

function readToolSets(dataDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dataDir, WARMUP_TOOLS_FILE), 'utf8'));
    return parsed && typeof parsed.sets === 'object' && parsed.sets ? parsed.sets : {};
  } catch {
    return {};
  }
}

// Called with the trusted system message and exact tool array a real paid
// turn sent upstream.
function rememberUpstreamTools(trusted, tools, { dataDir, nowMs = Date.now() } = {}) {
  if (!dataDir || !String(trusted || '').trim() || !Array.isArray(tools)) return false;
  const key = contractKey(trusted);
  const sets = readToolSets(dataDir);
  const serialized = JSON.stringify(tools);
  if (sets[key] && JSON.stringify(sets[key].tools) === serialized) return false;
  sets[key] = { tools, seenAt: new Date(nowMs).toISOString() };
  const kept = Object.entries(sets)
    .sort((a, b) => String(b[1].seenAt).localeCompare(String(a[1].seenAt)))
    .slice(0, MAX_REMEMBERED_TOOL_SETS);
  const file = path.join(dataDir, WARMUP_TOOLS_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ sets: Object.fromEntries(kept) }), { mode: 0o600 });
  fs.renameSync(temp, file);
  return true;
}

// The upstream body a warm-up sends, or null with the reason it cannot.
// systemPrompt is the system message EC2 hands voice provider; the transforms below are
// the ones a real turn goes through, so the cached prefix is byte-identical.
function buildWarmupRequest({ systemPrompt, callId, model, dataDir }) {
  const trusted = trustedSystemContext(
    { messages: [{ role: 'system', content: String(systemPrompt || '') }] },
    callId,
  ).trim();
  if (!trusted) return { body: null, reason: 'no call-marked system prompt' };
  const remembered = readToolSets(dataDir)[contractKey(trusted)];
  if (!remembered) return { body: null, reason: 'no remembered upstream tools for this call contract' };
  const tools = Array.isArray(remembered.tools) ? remembered.tools : [];
  return {
    body: {
      model,
      messages: [{ role: 'developer', content: trusted }],
      ...(tools.length ? { tools } : {}),
      stream: false,
      store: false,
      // No reasoning setting: policy keeps ask-ai the only HTTP sender of one
      // (model-effort-policy.test.js), and the cache key is the prefix, not
      // the effort. The 16-token cap still bounds the spend.
      max_completion_tokens: 16,
    },
    reason: '',
  };
}

module.exports = {
  WARMUP_TOOLS_FILE,
  buildWarmupRequest,
  contractKey,
  rememberUpstreamTools,
};
