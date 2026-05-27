#!/usr/bin/env node
// skill-crystallizer.js
//
// Auto-skill crystallization. Watches the outcome log for repeating successful
// task patterns and proposes new SKILL.md drafts. The agent stops doing the
// same multi-step thing N times and starts running a named skill.
//
// Pattern sources (deep-dived 2026-05-23 nightly research):
//   - CAMEL inception task decomposition (camel-ai/camel 2026-04 0.2.x):
//     successful subtask sequences become reusable patterns the agent can
//     re-invoke under a single name.
//   - Mastra eval framework (mastra-ai/mastra 2026-04 0.5.x): per-step
//     evaluation feeds a skill-promotion pipeline.
//   - Anthropic Skills SDK (2026-03 release notes): SKILL.md as the unit of
//     promotable agent capability; auto-generated drafts go through a human
//     approval gate before becoming first-class.
//   - Letta passive skill mining (letta-ai/letta 0.5 2026-04): clusters of
//     successful tool-use traces with identical intent fingerprint promote
//     to a "frequent-task" skill candidate.
//
// Storage:
//   Input  : data/agent/outcome-log.jsonl (or any path supplied to sweep())
//   Output : data/agent/skill-proposals/<slug>.md   (one draft per candidate)
//            data/agent/skill-proposals.jsonl       (audit ledger)
//
// Pure module. All paths come from env or function args; tests use tmp dirs.

const fs = require('fs');
const path = require('path');

const REPO = process.env.SECONDBRAIN_ROOT || path.join(__dirname, '..');

// Defaults

const DEFAULTS = {
  // Minimum number of matching outcomes to crystallize.
  minRepetitions: 3,
  // Required success rate across the matching outcomes.
  minSuccessRate: 0.8,
  // How long ago the earliest match must be, in days. Prevents one-day spikes.
  minSpanDays: 1,
  // Don't crystallize if a SKILL.md already exists for this slug.
  refuseExistingSkill: true,
};

// Pure helpers

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function readJsonl(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8');
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { out.push(JSON.parse(trimmed)); } catch { /* skip malformed */ }
  }
  return out;
}

function appendJsonl(filePath, record) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(record) + '\n');
}

// An intent signature collapses semantically-similar outcomes to one bucket.
// Default: `${kind}:${slugify(goal)}` so "send invoice to BAI" and
// "Send Invoice To BAI" group together.
function defaultIntentSignature(outcome) {
  const kind = String(outcome.kind || outcome.type || 'task').toLowerCase();
  const goal = outcome.goal || outcome.intent || outcome.subject || '';
  return `${kind}:${slugify(goal)}`;
}

function isSuccessful(outcome) {
  const s = String(outcome.status || '').toLowerCase();
  return s === 'success' || s === 'ok' || s === 'completed' || s === 'green' || s === 'approved';
}

// Core grouping and candidate detection

function groupByIntent(outcomes, signatureFn = defaultIntentSignature) {
  const groups = new Map();
  for (const o of outcomes) {
    const sig = signatureFn(o);
    if (!sig) continue;
    let bucket = groups.get(sig);
    if (!bucket) {
      bucket = { signature: sig, outcomes: [], successes: 0 };
      groups.set(sig, bucket);
    }
    bucket.outcomes.push(o);
    if (isSuccessful(o)) bucket.successes++;
  }
  return Array.from(groups.values());
}

function spanDays(outcomes) {
  if (!outcomes.length) return 0;
  const ts = outcomes
    .map((o) => Date.parse(o.timestamp || o.ended_at || o.started_at || ''))
    .filter((t) => !Number.isNaN(t))
    .sort((a, b) => a - b);
  if (ts.length < 2) return 0;
  return (ts[ts.length - 1] - ts[0]) / 86400000;
}

function detectCrystallizationCandidates(outcomes, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const signatureFn = opts.signatureFn || defaultIntentSignature;
  const groups = groupByIntent(outcomes, signatureFn);

  const candidates = [];
  for (const g of groups) {
    const n = g.outcomes.length;
    if (n < cfg.minRepetitions) continue;
    const rate = n === 0 ? 0 : g.successes / n;
    if (rate < cfg.minSuccessRate) continue;
    const span = spanDays(g.outcomes);
    if (span < cfg.minSpanDays) continue;

    candidates.push({
      signature: g.signature,
      slug: slugify(g.signature),
      repetitions: n,
      successes: g.successes,
      success_rate: Number(rate.toFixed(3)),
      span_days: Number(span.toFixed(2)),
      sample_outcomes: g.outcomes.slice(0, 5),
    });
  }
  // Highest-evidence candidates first.
  candidates.sort((a, b) => b.repetitions - a.repetitions || b.success_rate - a.success_rate);
  return candidates;
}

// SKILL.md draft generation

function renderSkillDraft(candidate, opts = {}) {
  const author = opts.author || 'skill-crystallizer';
  const now = (opts.now ? opts.now() : new Date()).toISOString();
  const description =
    opts.description ||
    `Repeating successful pattern observed ${candidate.repetitions} times ` +
      `at ${Math.round(candidate.success_rate * 100)}% success across ` +
      `${candidate.span_days} days.`;
  const sampleSteps =
    (candidate.sample_outcomes[0] && candidate.sample_outcomes[0].steps) || [];

  const stepList = Array.isArray(sampleSteps) && sampleSteps.length
    ? sampleSteps.map((s, i) => `${i + 1}. ${typeof s === 'string' ? s : (s.label || s.action || JSON.stringify(s))}`).join('\n')
    : '_no canonical step sequence captured, fill in before approval_';

  return `---
name: ${candidate.slug}
status: proposed
proposed_by: ${author}
proposed_at: ${now}
evidence:
  repetitions: ${candidate.repetitions}
  success_rate: ${candidate.success_rate}
  span_days: ${candidate.span_days}
  signature: ${candidate.signature}
---

# ${candidate.slug}

${description}

## Trigger

When Luke (or another surface) requests an action matching intent signature
\`${candidate.signature}\`.

## Steps (proposed)

${stepList}

## Why this is a skill

This pattern has fired ${candidate.repetitions} times with
${candidate.successes} successes over ${candidate.span_days} days. Promoting
it from ad-hoc to a named skill lets the agent skip planning overhead and
gives the harness a stable surface to baseline and evaluate.
`;
}

// Top-level sweep

function sweep(opts = {}) {
  const root = opts.root || REPO;
  const outcomeLog = opts.outcomeLog || path.join(root, 'data', 'agent', 'outcome-log.jsonl');
  const proposalsDir = opts.proposalsDir || path.join(root, 'data', 'agent', 'skill-proposals');
  const ledgerPath = opts.ledgerPath || path.join(root, 'data', 'agent', 'skill-proposals.jsonl');
  const scheduledTasksDir = opts.scheduledTasksDir || path.join(root, 'scheduled-tasks');
  const cfg = { ...DEFAULTS, ...opts };

  const outcomes = opts.outcomes || readJsonl(outcomeLog);
  const candidates = detectCrystallizationCandidates(outcomes, cfg);

  fs.mkdirSync(proposalsDir, { recursive: true });
  const written = [];
  const skipped = [];
  for (const c of candidates) {
    if (cfg.refuseExistingSkill) {
      const existing = path.join(scheduledTasksDir, c.slug, 'SKILL.md');
      if (fs.existsSync(existing)) {
        skipped.push({ slug: c.slug, reason: 'skill_already_exists' });
        continue;
      }
    }
    const target = path.join(proposalsDir, `${c.slug}.md`);
    if (fs.existsSync(target) && !cfg.overwriteProposals) {
      skipped.push({ slug: c.slug, reason: 'proposal_already_exists' });
      continue;
    }
    const body = renderSkillDraft(c, opts);
    fs.writeFileSync(target, body);
    const entry = {
      timestamp: (opts.now ? opts.now() : new Date()).toISOString(),
      slug: c.slug,
      signature: c.signature,
      repetitions: c.repetitions,
      success_rate: c.success_rate,
      proposal_path: path.relative(root, target),
    };
    appendJsonl(ledgerPath, entry);
    written.push(entry);
  }
  return { candidates, written, skipped };
}

module.exports = {
  DEFAULTS,
  slugify,
  defaultIntentSignature,
  isSuccessful,
  groupByIntent,
  spanDays,
  detectCrystallizationCandidates,
  renderSkillDraft,
  sweep,
};

// CLI
if (require.main === module) {
  const result = sweep();
  process.stdout.write(
    JSON.stringify(
      {
        candidates: result.candidates.length,
        written: result.written.length,
        skipped: result.skipped.length,
        details: { written: result.written, skipped: result.skipped },
      },
      null,
      2
    ) + '\n'
  );
}
