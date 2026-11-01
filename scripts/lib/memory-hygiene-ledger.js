// scripts/lib/memory-hygiene-ledger.js
//
// Pure helpers that make the weekly memory consolidation receipt honest
// (Owner decision: "the memory consolidation is impotent"). Evidence: the
// Oct 3/10/17 runs scanned ~620 files, kept 76 of 77 clusters distinct, and
// re-reported the SAME carried-forward supersede every week as "applied",
// while the corpus grew 616 -> 624 and the card went green on receipt
// freshness alone.
//
//   - carried-forward detection: an applied action only counts for THIS run
//     if it was not already reported by the previous receipt and its files
//     are now (newly) stubbed on disk.
//   - merge budget: only verified newly reduced files meet MERGE_BUDGET;
//     grounded refusals can complete review but never count as reductions.
//   - repeat escalation: a finding open on 2 consecutive runs is red, with
//     the exact resolution step.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MERGE_BUDGET = 15;
const MIN_REFUSAL_REASON_CHARS = 60;

function actionKey(entry) {
  const files = (Array.isArray(entry?.files) ? entry.files : []).map(String).sort();
  return `${String(entry?.verdict || '')}|${files.join(',')}`;
}

function baseName(file) {
  return String(file || '').replace(/\\/g, '/').split('/').pop();
}

function isStubFile(memoryDir, file) {
  try {
    const raw = fs.readFileSync(path.join(memoryDir, baseName(file)), 'utf8');
    const head = raw.split(/\r?\n---\s*\r?\n/)[0] || '';
    return /^\s*stub\s*:\s*true\s*$/m.test(head);
  } catch {
    return false;
  }
}

// Structural proof accompanies semantic review; filename prose alone is never proof.
function isSpecificRefusal(row) {
  if (!row || typeof row !== 'object' || row.reviewed !== 'full') return false;
  const assessment = row.rejection_assessment;
  const members = row.reviewed_files || [];
  if (!assessment || assessment.overlap !== 'none' || assessment.safe_merge_possible !== false ||
      assessment.disposition !== 'keep_distinct' || String(assessment.reason || '').trim().length < 40) return false;
  if (members.length < 2 || members.length !== (row.files || []).length) return false;
  const rules = members.map(member => String(member.rule || '').trim());
  if (new Set(rules.map(rule => rule.toLowerCase())).size !== rules.length) return false;
  return members.every((member, i) => {
    const comparison = String(member.comparison || '');
    return row.files.includes(member.file) && /^[a-f0-9]{64}$/.test(member.content_sha256 || '') &&
      rules[i].length >= 20 && String(member.source_quote || '').trim().length >= 20 &&
      comparison.includes(rules[i]) && rules.some((rule, j) => j !== i && comparison.includes(rule));
  });
}

// Splits bucketed applied adjudications into this-run actions (newly stubbed
// files, not in the previous receipt) and carried-forward ones.
function classifyApplied(applied, { previousActions = [], runDay, memoryDir, stubsBefore = [] }) {
  const prevKeys = new Set(previousActions.map(actionKey));
  const before = new Set(stubsBefore.map(baseName));
  const fresh = [];
  const carried = [];
  let reducedFiles = 0;
  const reducedList = [];
  for (const entry of applied) {
    const appliedOn = String(entry.applied_on || '').slice(0, 10);
    const reportedBefore = prevKeys.has(actionKey(entry));
    const staleDate = appliedOn && runDay && appliedOn !== runDay;
    if (reportedBefore || staleDate) {
      carried.push(entry);
      continue;
    }
    const newlyStubbed = (entry.files || []).filter(
      (f) => !before.has(baseName(f)) && !reducedList.includes(baseName(f)) && isStubFile(memoryDir, f),
    );
    if (!newlyStubbed.length) {
      // Claimed applied but no new stub exists on disk: not a real reduction.
      carried.push({ ...entry, unverified: true });
      continue;
    }
    reducedFiles += newlyStubbed.length;
    reducedList.push(...newlyStubbed.map(baseName));
    fresh.push(entry);
  }
  return { fresh, carried, reducedFiles, reducedList };
}

function computeMergeBudget({ adjudications, reducedFiles, required = MERGE_BUDGET }) {
  const rows = Array.isArray(adjudications) ? adjudications : [];
  const refused = rows.filter(
    (a) => a.verdict === 'keep_distinct' || a.reviewed === 'edges_only',
  );
  const missing = [];
  let recorded = 0;
  for (const a of refused) {
    const id = a.cluster_id || a.id || '';
    if (a.reviewed === 'edges_only') {
      // A skim is not a reason; the group still has to be compared file by file.
      missing.push({ cluster_id: id, why: 'edges_only: members were not compared file by file' });
    } else if (isSpecificRefusal(a)) {
      recorded += 1;
    } else {
      missing.push({
        cluster_id: id,
        why: 'keep_distinct without a grounded per-member rejection assessment',
      });
    }
  }
  required = Math.max(MERGE_BUDGET, required);
  const metByReduction = Number.isInteger(reducedFiles) && reducedFiles >= required;
  return {
    required,
    reduced_files: reducedFiles,
    refused_clusters: refused.length,
    refusal_reasons_recorded: recorded,
    refusal_reasons_missing: missing.length,
    missing: missing.slice(0, 25),
    review_complete: missing.length === 0,
    met: metByReduction,
    met_by: metByReduction ? 'reduction' : 'none',
  };
}

// Where a repeated finding gets its concrete resolution. Unknown ids fall
// back to a generic step that still names the files.
const RESOLUTION_STEPS = {
  'MEM-ARCHIVE-ACTIVE-COLLISION':
    'Pick the canonical copy, stub the other (frontmatter stub: true, superseded_by), keep the full body in memory/archive/, then rerun memory-consolidation-evidence.js.',
};

function escalateRepeats(openFindings, previousState) {
  const prevStreaks = (previousState && previousState.finding_streaks) || {};
  const prevOpenIds = new Set(
    ((previousState && previousState.open_findings) || []).map((f) => String(f.id)),
  );
  const streaks = {};
  const repeats = [];
  for (const f of openFindings || []) {
    const id = String(f.id);
    const runs = prevOpenIds.has(id) ? (Number(prevStreaks[id]) || 1) + 1 : 1;
    streaks[id] = runs;
    if (runs >= 2) {
      repeats.push({
        id,
        title: f.title || id,
        runs,
        files: f.files || [],
        resolution:
          RESOLUTION_STEPS[id] ||
          `Resolve the listed files by hand (stub, merge, or fix), then rerun node scripts/lib/memory-consolidation-evidence.js; repeated ${runs} consecutive runs.`,
      });
    }
  }
  return { streaks, repeats };
}

module.exports = {
  MERGE_BUDGET,
  MIN_REFUSAL_REASON_CHARS,
  actionKey,
  isStubFile,
  isSpecificRefusal,
  classifyApplied,
  computeMergeBudget,
  escalateRepeats,
};
