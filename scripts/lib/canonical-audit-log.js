'use strict';

/**
 * canonical-audit-log.js
 *
 * A single durable-write primitive for audit rows that must NEVER be
 * satisfied by a disposable worktree copy: a plan-review override
 * (scripts/claude-hooks/agent-spawn-supervise.mjs) and a no-highs deploy's
 * open-findings log (scripts/claude-hooks/two-bot-gate.mjs).
 *
 * Codex adversarial review, 2026-09-03 (high, plan-review receipt
 * 7321a4a75add): "the proposed receipt and override persistence needs a
 * canonical-root guarantee... a worktree-only write can therefore satisfy the
 * audit check if the shared write fails. Use `resolveSharedCheckout`, require
 * one successful canonical write before allowing the action, and make
 * open-finding writes fail closed."
 *
 * Deliberately narrower than scripts/lib/shared-checkout-root.js's
 * `sharedCheckoutRoots()` (which returns EVERY reachable root, including the
 * current, possibly-disposable worktree, for a READER that wants every copy).
 * This writes to exactly ONE place: `resolveSharedCheckout` (`git
 * rev-parse --git-common-dir`'s parent), which is correct for both nested
 * `.claude/worktrees/<id>` and sibling `sb-sessions/<name>` layouts. A
 * `sb-sessions` worktree write on its own is never treated as durable
 * settlement -- the same distinction scripts/codex-peer-review.js's own
 * `resolveDurableRoots` already draws for gated peer-review receipts.
 *
 * Returns null (never throws) when the canonical root cannot be resolved or
 * the write itself fails. Every caller must fail CLOSED on null.
 */

const fs = require('fs');
const path = require('path');
const { resolveSharedCheckout } = require('./shared-checkout-root.js');

function readJsonl(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      /* a torn line must never take a reader down */
    }
  }
  return rows;
}

/**
 * @param {object} opts
 * @param {string} [opts.cwd]
 * @param {string} opts.relativePath e.g. 'data/agent/two-bot-gate-overrides.jsonl'
 * @param {object} opts.row the JSON row to append
 * @param {(row:object)=>string} [opts.dedupeKey] when given, a row whose key
 *   already exists in the file is skipped instead of appended again (used for
 *   idempotent logging across repeated attempts against the same evidence).
 * @param {(cwd:string)=>string|null} [opts.resolveSharedCheckout] test seam
 * @returns {{file:string, written:boolean, deduped:boolean}|null} null means
 *   the canonical root could not be resolved, or the write itself failed --
 *   the caller must treat this as a failure, never as a soft no-op.
 */
function appendCanonicalJsonl({
  cwd = process.cwd(),
  relativePath,
  row,
  dedupeKey,
  resolveSharedCheckout: resolve = resolveSharedCheckout,
} = {}) {
  if (!relativePath || !row) return null;
  const root = resolve(cwd);
  if (!root) return null;
  const file = path.join(root, relativePath);

  if (dedupeKey) {
    let existing;
    try {
      existing = new Set(readJsonl(file).map((r) => dedupeKey(r)));
    } catch {
      existing = new Set();
    }
    if (existing.has(dedupeKey(row))) {
      return { file, written: false, deduped: true };
    }
  }

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(row) + '\n', 'utf8');
  } catch {
    return null;
  }
  return { file, written: true, deduped: false };
}

module.exports = { appendCanonicalJsonl, readJsonl };
