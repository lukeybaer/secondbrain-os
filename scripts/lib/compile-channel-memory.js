#!/usr/bin/env node
/**
 * compile-channel-memory.js
 *
 * 2026-05-26 ExampleCo: the raw rejection-reflection JSONL grows unbounded
 * forever (audit log). The planner cannot consume that directly without
 * prompt drift and token blowup. compileChannelMemory(channel, opts)
 * produces a bounded view:
 *
 *   {
 *     canonical: [...]   // sticky rules, never dropped
 *     active:    [...]   // dedup'd live rules, newest first
 *     superseded:[...]   // older rules superseded by a newer one
 *     dropped:   [...]   // budget-trimmed non-canonical rules
 *     token_estimate: N
 *     warnings: [...]    // e.g. MEMORY_OVERFLOW
 *   }
 *
 * Determinism: same JSONL input + same asOf returns byte-identical output.
 * Cacheable by JSONL file hash.
 *
 * Plan ref: ~/.claude/plans/distributed-questing-wilkinson.md (module #3)
 * Contract pinned by scripts/__tests__/compile-channel-memory.test.js.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { loadReflections } = require(path.join(__dirname, 'rejection-reflections.js'));

const DEFAULT_TOKEN_BUDGET = 5000;
// Rough token estimate: 4 chars per token. Good enough for budgeting;
// the planner step pays for itself in honesty, not in token-count fudge.
const CHARS_PER_TOKEN = 4;

function normalizeLessonForDedup(lesson) {
  return String(lesson || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function estimateTokens(text) {
  return Math.ceil(String(text || '').length / CHARS_PER_TOKEN);
}

// Detect supersession markers in a lesson. We look for the literal word
// "supersedes" or "replaces" appearing in the newer rule's text. The
// matched older rules are not auto-inferred; supersession is a verbal
// signal in the lesson itself.
function findSupersededIds(newRule, allRules) {
  const body = String(newRule.lesson || '').toLowerCase();
  if (!/\b(supersedes|replaces)\b/.test(body)) return [];
  const ids = [];
  // Probe: words from the part of the lesson before the supersession marker.
  const probe = body.split(/\b(supersedes|replaces)\b/)[0]
    .replace(/[^a-z0-9 ]/g, '')
    .split(/\s+/).filter(w => w.length >= 4);
  if (!probe.length) return [];
  // Merged rules carry last_seen, not ts. Compare timestamps to keep the
  // older entries only; equal/newer skip.
  const newTs = String(newRule.last_seen || newRule.ts || '');
  for (const r of allRules) {
    if (r.id === newRule.id) continue;
    const rTs = String(r.last_seen || r.ts || '');
    if (rTs >= newTs) continue;
    const txt = normalizeLessonForDedup(r.lesson).replace(/[^a-z0-9 ]/g, '');
    const hits = probe.filter(w => txt.includes(w)).length;
    if (hits / probe.length >= 0.5) ids.push(r.id);
  }
  return ids;
}

function compileChannelMemory(channel, opts = {}) {
  const tokenBudget = Number(opts.tokenBudget || DEFAULT_TOKEN_BUDGET);
  const rows = loadReflections(channel, opts);

  // Dedup by normalized lesson. Preserve canonical flag (sticky once true).
  const byKey = new Map();
  for (const r of rows) {
    const key = normalizeLessonForDedup(r.lesson);
    if (!key) continue;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        id: r.id,
        channel: r.channel,
        lesson: r.lesson,
        canonical: r.canonical === true,
        first_seen: r.ts,
        last_seen: r.ts,
        count: 1,
        contributing_ids: [r.id],
      });
    } else {
      existing.count += 1;
      existing.contributing_ids.push(r.id);
      if (String(r.ts) > String(existing.last_seen)) existing.last_seen = r.ts;
      if (String(r.ts) < String(existing.first_seen)) existing.first_seen = r.ts;
      // Canonical is sticky: if any source row is canonical, the merged rule is.
      if (r.canonical === true) existing.canonical = true;
    }
  }

  let merged = Array.from(byKey.values());

  // Supersession pass: rules that look like "newer X supersedes/replaces"
  // mark older similar rules as superseded.
  const supersededIds = new Set();
  // Sort newest first to iterate the supersedes-checks correctly.
  merged.sort((a, b) => String(b.last_seen).localeCompare(String(a.last_seen)));
  for (const r of merged) {
    const ids = findSupersededIds(r, merged);
    for (const id of ids) {
      supersededIds.add(id);
      // Mark the superseded entry with a back-reference.
      const target = merged.find(x => x.id === id);
      if (target) target.superseded_by = r.id;
    }
  }

  const supersededOut = merged.filter(r => supersededIds.has(r.id));
  const eligibleActive = merged.filter(r => !supersededIds.has(r.id));

  // Split canonical vs non-canonical.
  const canonical = eligibleActive.filter(r => r.canonical === true);
  let active = eligibleActive.filter(r => r.canonical !== true);

  // Sort: newest first for both lists. Stable so ties keep insertion order.
  canonical.sort((a, b) => String(b.last_seen).localeCompare(String(a.last_seen)));
  active.sort((a, b) => String(b.last_seen).localeCompare(String(a.last_seen)));

  // Token-budget pass.
  const dropped = [];
  const warnings = [];

  // Canonical always counts toward the budget but is never dropped.
  let used = 0;
  for (const r of canonical) used += estimateTokens(r.lesson);

  const kept = [];
  // Walk active newest-first; keep while budget allows.
  for (const r of active) {
    const cost = estimateTokens(r.lesson);
    if (used + cost <= tokenBudget) {
      kept.push(r);
      used += cost;
    } else {
      dropped.push(r);
    }
  }
  active = kept;
  // Oldest dropped first ordering for the dropped bucket (keeps it useful).
  dropped.sort((a, b) => String(a.last_seen).localeCompare(String(b.last_seen)));

  if (dropped.length > 0) {
    warnings.push(`MEMORY_OVERFLOW: ${dropped.length} non-canonical rule(s) dropped for token budget ${tokenBudget}`);
  }

  return {
    canonical,
    active,
    superseded: supersededOut,
    dropped,
    token_estimate: used,
    warnings,
  };
}

module.exports = {
  compileChannelMemory,
  normalizeLessonForDedup,
  estimateTokens,
  DEFAULT_TOKEN_BUDGET,
};
