'use strict';

const fs = require('fs');
const path = require('path');

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function plural(count, one, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

function clean(value, max = 140) {
  return String(value || '')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\bclaude\b/gi, 'session')
    .replace(/\banthropic\b/gi, 'model service')
    .replace(/\bopenai\b/gi, 'model service')
    .replace(/\bcodex cli\b/gi, 'code agent')
    .replace(/\bvapi\b/gi, 'phone service')
    .replace(/\bprovider\b/gi, 'service')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    const msg = clean((e && e.message) || e, 180) || 'ExampleCo error';
    throw new Error(`git hygiene snapshot unavailable at ${file}: ${msg}`);
  }
}

function unwrapSnapshotPayload(payload) {
  if (payload && payload.snapshot && payload.snapshot.buckets) return payload.snapshot;
  return payload;
}

function assertFreshSnapshot(payload, snapshotMaxAgeMs, nowMs) {
  if (!snapshotMaxAgeMs) return;
  const generatedAt =
    (payload && (payload.generatedAt || payload.generated_at || payload.createdAt)) ||
    (payload && payload.snapshot && (payload.snapshot.generatedAt || payload.snapshot.generated_at));
  if (!generatedAt) throw new Error('git hygiene snapshot missing generatedAt');
  const generatedMs = Date.parse(generatedAt);
  if (!Number.isFinite(generatedMs)) {
    throw new Error(`git hygiene snapshot has invalid generatedAt: ${generatedAt}`);
  }
  const ageMs = nowMs - generatedMs;
  if (!Number.isFinite(ageMs) || ageMs > snapshotMaxAgeMs) {
    const hours = Math.round(ageMs / 360000) / 10;
    throw new Error(`git hygiene snapshot is stale (${hours}h old)`);
  }
}

function readGitHygieneSnapshot(snapshotPath, opts = {}) {
  const payload = readJsonFile(snapshotPath);
  assertFreshSnapshot(
    payload,
    opts.snapshotMaxAgeMs == null ? 30 * 60 * 60 * 1000 : opts.snapshotMaxAgeMs,
    opts.nowMs || Date.now(),
  );
  const snapshot = unwrapSnapshotPayload(payload);
  if (!snapshot || !snapshot.buckets) {
    throw new Error(`git hygiene snapshot malformed at ${snapshotPath}`);
  }
  return snapshot;
}

function branchLabel(branch) {
  const name = clean(branch && branch.name, 100) || 'unnamed branch';
  const subject = clean(branch && branch.subject, 110);
  const date = clean(branch && branch.date, 20);
  const bits = [];
  if (subject) bits.push(subject);
  if (date) bits.push(date);
  return `branch ${name}${bits.length ? ` (${bits.join('; ')})` : ''}`;
}

function stashLabel(stash) {
  const slot = clean((stash && (stash.slot || stash.sha)) || 'stash', 80);
  const message = clean(stash && stash.message, 120);
  return `${slot}${message ? ` (${message})` : ''}`;
}

function parkedLabel(record) {
  const project = clean(record && record.project, 90);
  const ref = clean(record && record.ref, 110);
  const artifact = clean(record && record.artifact, 40);
  const reason = clean(record && record.reason, 160);
  const reviewBy = clean(record && record.reviewBy, 20);
  const review = reviewBy
    ? record.expired
      ? `review overdue ${reviewBy}`
      : `review by ${reviewBy}`
    : 'no review date';
  const label = project || ref || clean(record && record.id, 90) || 'parked work';
  const bits = [];
  if (artifact || ref) bits.push([artifact, ref].filter(Boolean).join(' '));
  if (reason) bits.push(reason);
  bits.push(review);
  return `${label} - ${bits.join('; ')}`;
}

function formatRows(title, rows, emptyLine) {
  const lines = [`${title}:`];
  if (!rows.length) {
    lines.push(`  ${emptyLine}`);
    return lines;
  }
  rows.forEach((row, idx) => lines.push(`  ${idx + 1}. ${row}`));
  return lines;
}

function summarizeUncommitted(edits, maxFiles) {
  if (!edits.length) return null;
  const files = edits
    .slice(0, maxFiles)
    .map((edit) => clean((edit && edit.file) || edit, 90))
    .filter(Boolean);
  const suffix = edits.length > files.length ? `, +${edits.length - files.length} more` : '';
  return `working tree - ${plural(edits.length, 'uncommitted edit')}: ${files.join(', ')}${suffix}; Advice: decide before the next handoff so this does not blur into unrelated work. Actions: Land | Park | Drop.`;
}

function decisionAdvice(kind, label) {
  if (kind === 'parked')
    return `Advice: keep parked until the stated review date unless it is clearly obsolete. Summary: ${label}.`;
  if (kind === 'landed')
    return `Advice: let the janitor clear this unless you need the branch for audit. Summary: ${label}.`;
  if (kind === 'protected')
    return `Advice: preserve this rescue snapshot; use it only as evidence or recovery material. Summary: ${label}.`;
  return `Advice: choose Land if this belongs in the product now, Park if it is still valuable but blocked, or Drop if it no longer fits ExampleCo's priorities. Summary: ${label}.`;
}

function renderGitHygieneSnapshot(snapshot, opts = {}) {
  const maxRows = opts.maxRows || 8;
  const buckets = (snapshot && snapshot.buckets) || {};
  const parked = buckets.parked || {};
  const needsDecision = buckets.needsDecision || {};
  const safeToClear = buckets.safeToClear || {};
  const protectedBucket = buckets.protected || {};

  const parkedRecords = asArray(parked.records || (snapshot && snapshot.parkedRecords));
  const strayBranches = asArray(needsDecision.branches);
  const strayStashes = asArray(needsDecision.stashes);
  const uncommittedEdits = asArray(needsDecision.uncommittedEdits);
  const safeBranches = asArray(safeToClear.branches);
  const protectedBranches = asArray(protectedBucket.branches);
  const strayItems =
    strayBranches.length + strayStashes.length + (uncommittedEdits.length > 0 ? 1 : 0);

  // Answer-first lead: the verdict/count goes first, never "Status:". A clean
  // tree says so outright; otherwise the parked-item count leads (the number ExampleCo
  // cares about), then the rest of the counts. ExampleCo 2026-06-20 #gap: the face led
  // with "Status: git hygiene ..." which is log-speak, not an answer.
  const anyWork =
    parkedRecords.length + strayItems + safeBranches.length + protectedBranches.length > 0;
  const verdictLead = anyWork
    ? `${plural(parkedRecords.length, 'parked item')}: ${plural(strayItems, 'stray item')} needing a decision, ${plural(safeBranches.length, 'landed leftover')} safe to clear, ${plural(protectedBranches.length, 'protected rescue snapshot')}.`
    : 'Clean: no parked work, no stray branches, nothing to decide.';
  const lines = [
    verdictLead,
    'Actions: [Land] merge/push the work now; [Park] protect it with a reason and review date; [Drop] discard it only when it is clearly obsolete.',
    'Legend: STRAY needs a decision; PARKED is protected; LANDED already reached origin/master; PROTECTED is a rescue snapshot and never auto-cleans.',
    'Janitor timing: Claude Code Stop hook runs `git-janitor --apply --cap=5`; health self-heal also dry-runs/applies it. If a LANDED branch survives the next stop or 03:00 CT heal block, that is a health-check defect.',
    '',
  ];

  lines.push(
    ...formatRows(
      'Parked projects',
      parkedRecords
        .slice(0, maxRows)
        .map((record) => decisionAdvice('parked', parkedLabel(record))),
      'none registered',
    ),
  );
  if (parkedRecords.length > maxRows) lines.push(`  ... +${parkedRecords.length - maxRows} more`);
  lines.push('');

  const branchRows = strayBranches
    .slice(0, maxRows)
    .map((branch) => decisionAdvice('stray', branchLabel(branch)));
  const remainingRows = Math.max(0, maxRows - branchRows.length);
  const stashRows = strayStashes
    .slice(0, remainingRows)
    .map((stash) => decisionAdvice('stray', stashLabel(stash)));
  const strayRows = [...branchRows, ...stashRows];
  const workingTreeRow = summarizeUncommitted(uncommittedEdits, Math.min(6, maxRows));
  if (workingTreeRow) strayRows.push(workingTreeRow);
  lines.push(...formatRows('Stray work needing a decision', strayRows, 'none'));
  const hiddenStray =
    Math.max(0, strayBranches.length - maxRows) + Math.max(0, strayStashes.length - remainingRows);
  if (hiddenStray > 0) lines.push(`  ... +${hiddenStray} more`);
  lines.push('');

  lines.push(
    ...formatRows(
      'Safe to clear',
      safeBranches
        .slice(0, maxRows)
        .map((branch) =>
          decisionAdvice('landed', `${branchLabel(branch)} - already landed in origin/master`),
        ),
      'none',
    ),
  );
  if (safeBranches.length > maxRows) lines.push(`  ... +${safeBranches.length - maxRows} more`);
  lines.push('');

  lines.push(
    ...formatRows(
      'Protected',
      protectedBranches
        .slice(0, maxRows)
        .map((branch) =>
          decisionAdvice('protected', `${branchLabel(branch)} - rescue snapshot; never auto-clean`),
        ),
      'none',
    ),
  );
  if (protectedBranches.length > maxRows) {
    lines.push(`  ... +${protectedBranches.length - maxRows} more`);
  }

  return lines.join('\n');
}

function formatUncommittedParkedWorkSection({
  cwd = path.resolve(__dirname, '..', '..'),
  today = new Date().toISOString().slice(0, 10),
  state = null,
  classifier = null,
  maxRows = 8,
  snapshotPath = null,
  snapshotMaxAgeMs = 30 * 60 * 60 * 1000,
  nowMs = Date.now(),
} = {}) {
  try {
    const snapshot =
      state ||
      (snapshotPath
        ? readGitHygieneSnapshot(snapshotPath, { snapshotMaxAgeMs, nowMs })
        : null) ||
      (classifier
        ? classifier({ cwd, today })
        : require('./git-hygiene.js').classifyGitState({ cwd, today }));
    return renderGitHygieneSnapshot(snapshot, { maxRows });
  } catch (e) {
    const msg = clean((e && e.message) || e, 160) || 'ExampleCo error';
    const snapshotIssue = /git hygiene snapshot/i.test(msg);
    if (snapshotIssue) {
      return [
        `hard blocker: cannot read git hygiene snapshot -- ${msg}.`,
        'Repair: publish a fresh dev-checkout git-hygiene snapshot from an isolated working tree before claiming branch cleanliness.',
        'Decision: this card stays visible and non-green so shared-checkout dirt cannot disappear from the briefing.',
      ].join('\n');
    }
    // A host that cannot inspect a working tree cannot honestly claim branch
    // cleanliness. The old cloud copy rendered this as clean, which hid dirty
    // shared-checkout state from the briefing. Treat missing git evidence as a
    // blocker until a dev-checkout hygiene snapshot is published and read.
    // CATEGORY = any "no working git tree on this host" signal, not one literal
    // error string.
    const noWorkingTree =
      /not a git repository|--show-toplevel|\brev-parse\b|no working tree|fatal: not a git/i.test(
        msg,
      );
    if (noWorkingTree) {
      return [
        `hard blocker: cannot read git hygiene state on this host -- ${msg}.`,
        'Repair: publish a dev-checkout git-hygiene snapshot or run the classifier from an isolated working tree before claiming branch cleanliness.',
        'Decision: this card stays visible and non-green so shared-checkout dirt cannot disappear from the briefing.',
      ].join('\n');
    }
    // A genuine classifier failure on a host that DOES have a working tree is a
    // real blocker, not log-speak: a parked-work card that silently shows nothing
    // hides branch-hygiene failures. Answer-first "hard blocker:" lead so the
    // tile reads RED and names WHY. CATEGORY = any real snapshot-compute failure.
    return [
      `hard blocker: cannot read git hygiene state this run -- ${msg}.`,
      'Next step: rerun the git-hygiene classifier (it shells out to git in the repo); if git itself is failing, fix that first.',
      'Decision: the card stays visible so branch cleanliness failures do not disappear from the briefing.',
    ].join('\n');
  }
}

module.exports = {
  formatUncommittedParkedWorkSection,
  readGitHygieneSnapshot,
  renderGitHygieneSnapshot,
};
