'use strict';

// memory-consolidation-template-guard.js
//
// Fails a cluster judgment whose per-member comparisons were stamped out by a
// template instead of written by a reviewer (method owner:
// dev-plans/core/memory-consolidation.md). On 2026-11-07 the unattended run
// kept 46 of 46 clusters with 207 comparisons of the form
// "<own rule>. Compared with cluster members: <rule> | <rule>": every rule was
// quoted, every length check passed, and not one comparison said how the rules
// differ. The form checks prove a rule was quoted; this proves something was
// compared. It is category-level, not tied to that one phrase:
//   1. own words: after every member rule and file name is removed, a
//      comparison must still carry MIN_OWN_WORDS words of its own explanation;
//   2. no stamp (keeps): the same leftover wording may not sit under several
//      members of one keep, or repeat across clusters;
//   3. no copy: a keep_distinct reason may not be a cut-off copy of the
//      rationale.

const MIN_OWN_WORDS = 8;
// Leftover wording seen in this many different clusters is a stamp.
const STAMP_REPEAT_LIMIT = 3;

function words(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9_.\/-]+/)
    .map((w) => w.replace(/^[.\/-]+|[.\/-]+$/g, ''))
    .filter(Boolean);
}

// The comparison with every member rule (verbatim) cut out.
function ownText(comparison, rules) {
  let out = String(comparison || '');
  const sorted = [...rules].map((r) => String(r || '').trim()).filter(Boolean).sort((a, b) => b.length - a.length);
  for (const rule of sorted) out = out.split(rule).join(' ');
  return out;
}

// File names are not explanation. A stamp that only swaps member names
// ("a.md governs its own duty" / "b.md governs its own duty") is still one
// stamp (Codex review 2026-11-07), so every file reference becomes one
// placeholder and never counts as a word of the reviewer's own.
const FILE_REF = '#file';
const FILE_TOKEN_RE = /[/\\]|\.(?:md|mdx|js|mjs|cjs|ts|tsx|json|jsonl|html|sh|txt|ya?ml)$/i;

function memberIds(members) {
  const ids = new Set();
  for (const m of members) {
    const file = String((m && m.file) || '').toLowerCase().replace(/\\/g, '/');
    if (!file) continue;
    const base = file.split('/').pop();
    for (const id of [file, base, base.replace(/\.[a-z0-9]+$/, '')]) if (id) ids.add(id);
  }
  return ids;
}

function explanationWords(text, ids) {
  return words(text).map((w) => (ids.has(w) || FILE_TOKEN_RE.test(w) ? FILE_REF : w));
}

function skeleton(wordList) {
  return wordList.join(' ');
}

/**
 * Returns [{ cluster_id, file, problem }] for every templated comparison or
 * copied reason across the run's adjudication rows. Empty means clean.
 */
function findTemplatedJudgments(rows) {
  const findings = [];
  const stamps = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const members = Array.isArray(row && row.reviewed_files) ? row.reviewed_files : [];
    const rules = members.map((m) => m && m.rule);
    const ids = memberIds(members);
    const keep = row && row.verdict === 'keep_distinct';
    const inRow = new Map();
    for (const member of members) {
      const leftover = explanationWords(ownText(member && member.comparison, rules), ids);
      const ownWords = leftover.filter((w) => w !== FILE_REF);
      if (ownWords.length < MIN_OWN_WORDS) {
        findings.push({
          cluster_id: row.cluster_id,
          file: member.file,
          problem: `comparison has ${ownWords.length} word(s) of its own beyond the quoted rules (needs ${MIN_OWN_WORDS}): it quotes rules but says nothing about how they differ or overlap`,
        });
        continue;
      }
      if (!keep) continue;
      const key = skeleton(leftover);
      inRow.set(key, [...(inRow.get(key) || []), member.file]);
      stamps.set(key, [...(stamps.get(key) || []), { cluster_id: row.cluster_id, file: member.file }]);
    }
    // A keep must say how EACH member differs. One cluster-wide sentence pasted
    // under every member compares nothing. (A merge may explain its combined
    // rule once, so this applies to keeps only.)
    for (const files of inRow.values()) {
      if (files.length < STAMP_REPEAT_LIMIT) continue;
      for (const file of files) {
        findings.push({
          cluster_id: row.cluster_id,
          file,
          problem: `the same comparison wording sits under ${files.length} members of this keep once the rules are removed; each member needs its own difference`,
        });
      }
    }
    const reason = String((row && row.rejection_assessment && row.rejection_assessment.reason) || '').trim();
    const rationale = String((row && row.rationale) || '').trim();
    if (keep && reason && rationale.length > reason.length && rationale.startsWith(reason)) {
      findings.push({
        cluster_id: row.cluster_id,
        file: null,
        problem: 'keep_distinct reason is a cut-off copy of the rationale, not its own reason',
      });
    }
  }
  // The same keep wording across different clusters is a stamp too.
  for (const seen of stamps.values()) {
    const clusters = new Set(seen.map((s) => s.cluster_id));
    if (clusters.size < STAMP_REPEAT_LIMIT) continue;
    for (const s of seen) {
      findings.push({
        cluster_id: s.cluster_id,
        file: s.file,
        problem: `the same keep comparison wording repeats across ${clusters.size} clusters once the rules are removed (a stamped template)`,
      });
    }
  }
  return findings;
}

function requireNoTemplatedJudgments(rows) {
  const findings = findTemplatedJudgments(rows);
  if (!findings.length) return true;
  const sample = findings
    .slice(0, 3)
    .map((f) => `${f.cluster_id}${f.file ? ' ' + f.file : ''}: ${f.problem}`)
    .join('; ');
  throw Error(`templated memory judgments (${findings.length}): ${sample}. Compare the rules in your own words and rerun the judgment.`);
}

module.exports = {
  MIN_OWN_WORDS,
  STAMP_REPEAT_LIMIT,
  findTemplatedJudgments,
  requireNoTemplatedJudgments,
};
