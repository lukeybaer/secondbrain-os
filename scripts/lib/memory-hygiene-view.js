'use strict';

const fs = require('node:fs');
const path = require('node:path');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function readJsonl(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function ctDateKey(now = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .formatToParts(new Date(Number(now)))
    .reduce((acc, part) => ({ ...acc, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function eventMs(row) {
  const value = Date.parse(String(row?.ts || row?.createdAt || ''));
  return Number.isFinite(value) ? value : -Infinity;
}

function currentPublishSignals(dataDir) {
  const outcomes = readJsonl(
    path.join(dataDir, 'agent', 'scheduled-skill-outcomes.jsonl'),
  )
    .filter(
      (row) =>
        row?.skill === 'memory-consolidation' &&
        row?.rung === 'land-outputs',
    )
    .map((row) => ({
      ts: row.ts || '',
      state: row.ok === true ? 'success' : 'failed',
      verdict: row.verdict || (row.ok === true ? 'landed' : 'land failed'),
      source: 'scheduled-skill-outcome',
      row,
    }));

  const promotionEvents = readJsonl(
    path.join(dataDir, 'agent', 'scheduled-skill-promotion-queue.jsonl'),
  )
    .filter(
      (row) =>
        row?.skillName === 'memory-consolidation',
    )
    .filter((row) => ['enqueue', 'attempt', 'complete', 'cancel'].includes(row.op))
    .map((row) => ({
      ts: row.ts || '',
      state:
        row.op === 'complete'
          ? 'success'
          : row.op === 'attempt' && row.ok === false
            ? 'failed'
            : row.op === 'cancel'
              ? row.cancelled_by === 'overnight-watcher' &&
                typeof row.reason === 'string' &&
                row.reason.includes('backfilled live')
                ? 'success'
                : 'failed'
              : 'pending',
      verdict:
        row.op === 'complete'
          ? 'promotion complete'
          : row.op === 'enqueue'
            ? 'promotion pending'
            : row.result?.reason || row.result?.stage || row.reason || row.op,
      source: 'scheduled-skill-promotion',
      row,
    }));

  return [...outcomes, ...promotionEvents].sort(
    (a, b) => eventMs(a) - eventMs(b) || String(a.source).localeCompare(String(b.source)),
  );
}

function memoryHygieneView(dataDir, now = Date.now()) {
  const nowMs = Number(now);
  const scheduleDate = ctDateKey(nowMs);
  const receipt = readJson(
    path.join(dataDir, 'agent', 'memory-consolidation-state.json'),
  );
  const lastRunMs = Date.parse(String(receipt?.last_run_iso || ''));
  const hasReceipt = Number.isFinite(lastRunMs);
  const ageHours = hasReceipt ? (nowMs - lastRunMs) / 3600000 : Infinity;
  const questions = Array.isArray(receipt?.questions) ? receipt.questions : [];
  const counts = receipt?.counts || {};
  const questionCount = Array.isArray(receipt?.questions)
    ? questions.length
    : Number(counts.questions_open) || 0;
  const openRedFindings = Number(receipt?.evidence_summary?.open_red) || 0;
  const openYellowFindings = Number(receipt?.evidence_summary?.open_yellow) || 0;
  // A receipt with edge_reviewed_only > 0 means one or more broad topic hubs
  // were only skimmed by their strongest edges, never compared member by
  // member. That is not proof the hub is clean; it is proof it was not
  // checked. A pass that never actually read most of a broad cluster's files
  // must not be allowed to report 'clean' (owner decision).
  const edgeReviewedOnlyClusters = Number(counts.edge_reviewed_only) || 0;
  const edgeReviewedOnlyFiles = Number(counts.edge_reviewed_only_files) || 0;
  // Honest-change contract (owner decision). counts.applied used to include
  // actions carried forward from earlier runs. Only receipt.run_changes proves
  // what THIS run did; a legacy receipt without it proves nothing.
  const runChanges = receipt && typeof receipt.run_changes === 'object' ? receipt.run_changes : null;
  const appliedCount = runChanges ? Number(runChanges.applied_verified) || 0 : 0;
  const growth = receipt && typeof receipt.growth === 'object' ? receipt.growth : null;
  const corpusGrew = Boolean(
    growth && (growth.files_rose || growth.memory_md_rose || growth.memory_md_over_cap),
  );
  const mergeBudget = receipt && typeof receipt.merge_budget === 'object' ? receipt.merge_budget : null;
  const repeatFindings = (Array.isArray(receipt?.repeat_findings) ? receipt.repeat_findings : []).filter(
    (r) => Number(r?.runs) >= 2,
  );
  const publishSignals = currentPublishSignals(dataDir);
  const latestPublish = publishSignals[publishSignals.length - 1] || null;
  const publishFailed = Boolean(latestPublish && latestPublish.state !== 'success');
  const state = publishFailed
    ? 'publish-failed'
    : !hasReceipt
      ? 'missing'
      : ageHours > 8 * 24
        ? 'stale'
        : openRedFindings > 0 || repeatFindings.length > 0
          ? 'defect'
        // A missed or absent merge budget outranks NO CHANGE (Codex closure dcdd896b0168).
        : !mergeBudget || mergeBudget.met !== true
          ? 'budget-missed'
        : appliedCount === 0
          ? 'no-change'
        : corpusGrew
          ? 'growing'
        : questionCount > 0
          ? 'needs-owner'
          : openYellowFindings > 0
            ? 'needs-review'
          : edgeReviewedOnlyClusters > 0
            ? 'needs-review'
          : 'clean';

  return {
    state,
    scheduleDate,
    receipt: hasReceipt ? receipt : null,
    lastRunMs: hasReceipt ? lastRunMs : null,
    ageHours: Number.isFinite(ageHours) ? ageHours : null,
    ranLast48h: hasReceipt && ageHours <= 48,
    weeklyFresh: hasReceipt && ageHours <= 8 * 24,
    latestPublish,
    publishSignals,
    edgeReviewedOnlyClusters,
    edgeReviewedOnlyFiles,
    appliedCount,
    runChanges,
    growth,
    corpusGrew,
    mergeBudget,
    repeatFindings,
  };
}

module.exports = {
  ctDateKey,
  currentPublishSignals,
  memoryHygieneView,
};
