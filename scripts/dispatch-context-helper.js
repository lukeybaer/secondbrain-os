/**
 * dispatch-context-helper.js
 *
 * Builds a unified retrieval context block for any caller that wants
 * to inject "what does Amy already know about this topic?" into a prompt.
 * Pulls from two sources:
 *   1. Graphiti knowledge graph (semantic, temporal, primary)
 *   2. ~/.secondbrain/sessions.db FTS5 (keyword fallback / fidelity)
 *
 * Used by scripts/process-dispatches.js (when spawning Claude CLI on a
 * dispatch comment) and any other surface that wants the same unified
 * memory view. The intent is one query, all sources, every surface.
 *
 * Standalone module so it can be required cross-branch:
 * process-dispatches.js currently lives only on
 * claude/amy-dashboard-and-video-pipeline; once that branch merges, the
 * require below resolves automatically and dispatch starts seeing the
 * unified retrieval block on every dispatched comment.
 *
 * Usage:
 *   const { fetchSessionArchiveContext } = require('./dispatch-context-helper');
 *   const block = fetchSessionArchiveContext(commentText);
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { resolvePythonExe } = require('./lib/python-resolver');

const GRAPHITI_CLI = path.join(__dirname, 'graphiti-cli.mjs');
const SESSION_CLI = path.join(__dirname, 'sb-session-search.py');

function queryGraphiti(text, limit, timeoutMs) {
  if (!fs.existsSync(GRAPHITI_CLI)) return [];
  try {
    const r = spawnSync('node', [GRAPHITI_CLI, 'search', text, '--limit', String(limit), '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });
    if (r.status !== 0 || !r.stdout) return [];
    const facts = JSON.parse(r.stdout);
    return Array.isArray(facts) ? facts.filter((f) => !f.invalid_at) : [];
  } catch {
    return [];
  }
}

function querySessionsFts(text, limit, timeoutMs) {
  if (!fs.existsSync(SESSION_CLI)) return [];
  try {
    const r = spawnSync(resolvePythonExe(), [SESSION_CLI, 'search', text, '--limit', String(limit), '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });
    if (r.status !== 0 || !r.stdout) return [];
    const hits = JSON.parse(r.stdout);
    return Array.isArray(hits) ? hits : [];
  } catch {
    return [];
  }
}

function fetchSessionArchiveContext(commentText, opts = {}) {
  const limit = opts.limit || 5;
  const timeoutMs = opts.timeoutMs || 12_000;
  const text = String(commentText || '').slice(0, 500).trim();
  if (!text) return '';

  const facts = queryGraphiti(text, 8, timeoutMs);
  const hits = querySessionsFts(text, limit, timeoutMs);
  if (facts.length === 0 && hits.length === 0) return '';

  const blocks = [];
  if (facts.length > 0) {
    const lines = ['### Graphiti (semantic + temporal, primary)'];
    for (const f of facts.slice(0, 8)) {
      const date = (f.valid_at || '').slice(0, 10) || '(undated)';
      const fact = String(f.fact || '').trim().slice(0, 240).replace(/\s+/g, ' ');
      lines.push(`- [${date}] ${fact}`);
    }
    blocks.push(lines.join('\n'));
  }
  if (hits.length > 0) {
    const lines = ['### Session archive FTS5 (keyword, fallback)'];
    for (const h of hits) {
      const date = (h.started_at || '').slice(0, 10);
      const sid = (h.session_id || '').slice(0, 8);
      lines.push(`- [${date}] ${h.repo} ${sid} (msgs=${h.message_count})`);
      if (h.topic_guess) {
        lines.push(`  topic : ${String(h.topic_guess).trim().slice(0, 140).replace(/\s+/g, ' ')}`);
      }
      if (h.last_response) {
        lines.push(`  amy   : ${String(h.last_response).trim().slice(0, 160).replace(/\s+/g, ' ')}`);
      }
    }
    lines.push('(For full session: python scripts/sb-session-search.py show <id>)');
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n');
}

module.exports = { fetchSessionArchiveContext };
