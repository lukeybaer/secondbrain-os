'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_CLAIM_TTL_MS = 2 * 60 * 1000;

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function resolveNativeClaudeExecutable(candidate, {
  platform = process.platform,
  existsSync = fs.existsSync,
} = {}) {
  const requested = String(candidate || '').trim();
  if (platform !== 'win32' || !/\.(?:cmd|ps1)$/i.test(requested)) return requested;
  const nativePath = path.join(
    path.dirname(requested),
    'node_modules',
    '@anthropic-ai',
    'claude-code',
    'bin',
    'claude.exe',
  );
  if (!existsSync(nativePath)) {
    const error = new Error(
      `unsupported Claude launcher; native executable is required for isolated arguments: ${nativePath}`,
    );
    error.code = 'unsupported_launcher';
    throw error;
  }
  return nativePath;
}

function resolveClaudeExecutableCandidates(candidates, {
  platform = process.platform,
  existsSync = fs.existsSync,
  fallback = 'claude',
} = {}) {
  for (const candidate of candidates || []) {
    const requested = String(candidate || '').trim();
    if (!requested || !existsSync(requested)) continue;
    try {
      return resolveNativeClaudeExecutable(requested, { platform, existsSync });
    } catch (error) {
      if (error?.code !== 'unsupported_launcher') throw error;
      // Keep scanning. A stale npm shim must not hide a later valid native
      // installation or prevent the voice proxy from serving other lanes.
    }
  }
  return fallback;
}

function buildClaudeHealthCanary({ nonce }) {
  const expected = String(nonce || '').trim();
  if (!expected) throw new Error('Claude health canary nonce is required');
  return {
    prompt: expected,
    args: [
      '--print',
      '--model',
      'claude-sonnet-4-6',
      '--effort',
      'low',
      '--setting-sources',
      '',
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--tools',
      '',
      '--permission-mode',
      'dontAsk',
      '--no-session-persistence',
      '--system-prompt',
      'Return the user message exactly. Add no punctuation, explanation, or formatting.',
    ],
  };
}

function classifyClaudeHealthCanaryOutput(stdout, nonce) {
  return String(stdout || '').trim() === String(nonce || '').trim();
}

function acquireClaudeHealthCanaryClaim({ statePath, nowMs = Date.now(), ttlMs = DEFAULT_CLAIM_TTL_MS }) {
  if (!statePath) throw new Error('Claude health state path is required');
  const claimFile = `${statePath}.canary-claim`;
  const token = `${process.pid}:${crypto.randomUUID()}`;
  fs.mkdirSync(path.dirname(claimFile), { recursive: true });
  const attempt = () => {
    try {
      const fd = fs.openSync(claimFile, 'wx', 0o600);
      fs.writeFileSync(fd, `${token}\n${new Date(nowMs).toISOString()}\n${os.hostname()}\n`);
      fs.closeSync(fd);
      return true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      return false;
    }
  };
  if (!attempt()) {
    try {
      if (nowMs - fs.statSync(claimFile).mtimeMs > ttlMs) {
        const [priorToken, , priorHost] = fs.readFileSync(claimFile, 'utf8').split(/\r?\n/);
        const priorPid = Number(String(priorToken || '').split(':')[0]);
        if ((!priorHost || priorHost === os.hostname()) && isPidAlive(priorPid)) {
          return { acquired: false, claimFile, token };
        }
        fs.unlinkSync(claimFile);
        if (!attempt()) return { acquired: false, claimFile, token };
      } else {
        return { acquired: false, claimFile, token };
      }
    } catch {
      if (!attempt()) return { acquired: false, claimFile, token };
    }
  }
  return { acquired: true, claimFile, token };
}

function releaseClaudeHealthCanaryClaim(claim) {
  if (!claim?.acquired || !claim.claimFile || !claim.token) return false;
  try {
    const current = fs.readFileSync(claim.claimFile, 'utf8').split(/\r?\n/)[0];
    if (current !== claim.token) return false;
    fs.unlinkSync(claim.claimFile);
    return true;
  } catch {
    return false;
  }
}

function newestClaudeHealthState(memoryState, diskState) {
  if (!memoryState) return diskState || null;
  if (!diskState) return memoryState;
  const memoryMs = Date.parse(String(memoryState.updatedAt || ''));
  const diskMs = Date.parse(String(diskState.updatedAt || ''));
  if (!Number.isFinite(diskMs)) return memoryState;
  if (!Number.isFinite(memoryMs) || diskMs > memoryMs) return diskState;
  return memoryState;
}

module.exports = {
  DEFAULT_CLAIM_TTL_MS,
  acquireClaudeHealthCanaryClaim,
  buildClaudeHealthCanary,
  classifyClaudeHealthCanaryOutput,
  newestClaudeHealthState,
  releaseClaudeHealthCanaryClaim,
  resolveClaudeExecutableCandidates,
  resolveNativeClaudeExecutable,
};
