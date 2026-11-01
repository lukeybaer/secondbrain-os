'use strict';

const fs = require('fs');
const path = require('path');

function portableBasename(file) {
  return path.posix.basename(path.win32.basename(String(file || '')));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

const RETIRE_GRACE_DAYS = 3;
const RETIRE_HARD_AGE_DAYS = 7;
// The 03:00 heal runs retire daily. A last run older than this means the
// automatic cleanup itself has stopped, which is the one thing that makes the
// rest of this card informational instead of a to-do list.
const RETIRE_STALE_HOURS = 36;
const DAY_MS = 24 * 60 * 60 * 1000;

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
    const base = portableBasename(file);
    // The raw fs error (ENOENT etc.) embeds the full absolute path; collapse any
    // path that ends in our basename down to just the basename so no drive/dir
    // path leaks to the card. Matches both Windows (C:\a\b\file) and posix
    // (/a/b/file) directory prefixes.
    const baseEsc = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rawMsg = String((e && e.message) || e).replace(
      new RegExp(`(?:[A-Za-z]:)?[\\\\/][^'"\\s]*${baseEsc}`, 'g'),
      base,
    );
    const msg = clean(rawMsg, 180) || 'unknown error';
    throw new Error(`git hygiene snapshot unavailable at ${base}: ${msg}`);
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
    (payload &&
      payload.snapshot &&
      (payload.snapshot.generatedAt || payload.snapshot.generated_at));
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
  let snapshot = unwrapSnapshotPayload(payload);
  if (!snapshot || !snapshot.buckets) {
    throw new Error(`git hygiene snapshot malformed at ${portableBasename(snapshotPath)}`);
  }
  // The publisher stamps generatedAt on the wrapper; carry it so the card can
  // show how old the data is.
  if (payload && payload.generatedAt && snapshot !== payload) {
    snapshot = { ...snapshot, generatedAt: payload.generatedAt };
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

function hoursAgo(iso, nowMs) {
  const ms = Date.parse(String(iso || ''));
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.round(((nowMs - ms) / 3600000) * 10) / 10);
}

function decisionAdvice(kind, label) {
  if (kind === 'auto')
    return `No action: the nightly retire archives this (git bundle on disk and S3, recoverable) and removes it. Summary: ${label}.`;
  if (kind === 'at-risk')
    return `Advice: edits in this worktree have no verified archive. The 03:00 heal archives and retires it once the branch is ${RETIRE_GRACE_DAYS} days old (${RETIRE_HARD_AGE_DAYS} days even if a soft gate holds); Land or Park it now to keep it. Summary: ${label}.`;
  if (kind === 'parked')
    return `Advice: keep parked until the stated review date unless it is clearly obsolete. Summary: ${label}.`;
  if (kind === 'landed')
    return `No action: the janitor clears this automatically. Summary: ${label}.`;
  if (kind === 'locked')
    return `No action: the nightly retire archives and removes a Git-locked worktree once its lock is 7 days old. Do not force-remove a Git-locked worktree before then. Summary: ${label}.`;
  if (kind === 'dirty-landed')
    return `Advice: this branch is landed, but its worktree has later edits with no verified archive. Do not auto-remove it. The nightly retire snapshot-archives the edits first; Land, Park, or Drop them to decide sooner. Summary: ${label}.`;
  if (kind === 'unverified-landed')
    return `Advice: this branch is landed, but its worktree could not be verified clean. Do not auto-remove it. Restore access or review it before cleanup. Summary: ${label}.`;
  if (kind === 'live-landed')
    return `Advice: this branch is landed but actively leased by a running session. Do not clear it until the session finishes or the lease expires. Summary: ${label}.`;
  if (kind === 'protected')
    return `Advice: preserve this rescue snapshot; use it only as evidence or recovery material. Summary: ${label}.`;
  return `Advice: choose Land if this belongs in the product now, Park if it is still valuable but blocked, or Drop if it no longer fits the owner's priorities. Summary: ${label}.`;
}

// Named, RED defect row for commits stranded on the shared checkout's local
// master (never reached origin). This is the drift alarm (W3d item 2): the
// count already existed in master.ahead, but nothing named the commits or
// flagged them as a defect, so 4 commits sat invisible since Jun 30. Returns
// '' when there is nothing stranded so the caller can omit the line cleanly.
function strandedCommitsLine(snapshot, maxSubjects = 5) {
  const stranded =
    (snapshot && snapshot.sharedMasterAheadOfOrigin) ||
    (snapshot && snapshot.master && { count: 0, commits: [] }) ||
    null;
  const count = Number(stranded && stranded.count) || 0;
  if (count <= 0) return '';
  const commits = asArray(stranded && stranded.commits);
  const subjects = commits
    .slice(0, maxSubjects)
    .map((c) => clean(c && c.subject, 90))
    .filter(Boolean);
  const suffix = count > subjects.length ? `, +${count - subjects.length} more` : '';
  return (
    `DEFECT (red): ${plural(count, 'commit')} stranded on the shared checkout, never landed: ` +
    `${subjects.join('; ')}${suffix}. ` +
    'Repair: create an isolated worktree, then run node scripts/land.js --apply from that branch.'
  );
}

function renderGitHygieneSnapshot(snapshot, opts = {}) {
  const maxRows = opts.maxRows || 8;
  const buckets = (snapshot && snapshot.buckets) || {};
  const parked = buckets.parked || {};
  const needsDecision = buckets.needsDecision || {};
  const safeToClear = buckets.safeToClear || {};
  const dirtyLanded = buckets.dirtyLanded || {};
  const unverifiedLanded = buckets.unverifiedLanded || {};
  const activeLanded = buckets.activeLanded || {};
  const locked = buckets.locked || {};
  const protectedBucket = buckets.protected || {};

  const parkedRecords = asArray(parked.records || (snapshot && snapshot.parkedRecords));
  // Stray work younger than the retire grace is in flight, not debt: the
  // nightly archive-then-retire (scripts/git-branch-retire.js) bundles anything
  // older to disk and S3 and removes it, so nobody triages branches by hand.
  const today = String(opts.today || (snapshot && snapshot.today) || new Date().toISOString()).slice(0, 10);
  const inFlightCutoff = new Date(Date.parse(today + 'T00:00:00Z') - RETIRE_GRACE_DAYS * DAY_MS)
    .toISOString()
    .slice(0, 10);
  // Exact commit time when the snapshot carries it (the retire step's own
  // 72-hour rule); the commit day otherwise.
  const asOfMs = opts.nowMs || Date.parse((snapshot && (snapshot.generatedAt || snapshot.capturedAt)) || '') || Date.now();
  const nowMs = opts.nowMs || Date.now();
  const isInFlight = (item) => {
    const exact = Date.parse(String((item && item.committedAt) || ''));
    if (Number.isFinite(exact)) return asOfMs - exact < RETIRE_GRACE_DAYS * DAY_MS;
    return Boolean(item && item.date && String(item.date).slice(0, 10) > inFlightCutoff);
  };
  const allStrayBranches = asArray(needsDecision.branches);
  const allStrayStashes = asArray(needsDecision.stashes);
  const pastGraceBranches = allStrayBranches.filter((item) => !isInFlight(item));
  const strayStashes = allStrayStashes.filter((item) => !isInFlight(item));
  const inFlightItems =
    allStrayBranches.length + allStrayStashes.length - pastGraceBranches.length - strayStashes.length;
  const uncommittedEdits = asArray(needsDecision.uncommittedEdits);
  const safeBranches = asArray(safeToClear.branches);
  const dirtyLandedAll = asArray(dirtyLanded.branches);
  const unverifiedLandedBranches = asArray(unverifiedLanded.branches);
  const activeLandedBranches = asArray(activeLanded.branches);
  const lockedBranches = asArray(locked.branches);
  const protectedBranches = asArray(protectedBucket.branches);

  // What is at risk: a dirty or conflicted worktree nobody owns (no live
  // lease), past the in-flight window, with no verified archive of its tip.
  // Everything else is the nightly retire's job and is informational.
  const hasEdits = (branch) => branch.worktreeState === 'dirty' || branch.worktreeState === 'conflicted';
  const strayAtRisk = pastGraceBranches.filter((br) => hasEdits(br) && !br.worktreeLive && !br.archive);
  const strayAutoBranches = pastGraceBranches.filter((br) => !strayAtRisk.includes(br));
  // Membership in the dirtyLanded bucket already means "has later edits".
  const dirtyLandedAtRisk = dirtyLandedAll.filter((br) => !br.archive && !isInFlight(br));
  const dirtyLandedArchived = dirtyLandedAll.filter((br) => br.archive);
  const dirtyLandedWaiting = dirtyLandedAll.filter((br) => !br.archive && isInFlight(br));
  const archivedStray = strayAutoBranches.filter((br) => br.archive);
  const awaitingStray = strayAutoBranches.filter((br) => !br.archive);
  const awaitingArchive = awaitingStray.length + strayStashes.length + dirtyLandedWaiting.length;
  const decisionItems = strayAtRisk.length + (uncommittedEdits.length > 0 ? 1 : 0);

  // Retire health and snapshot age.
  const retire = snapshot && snapshot.retire && typeof snapshot.retire === 'object' ? snapshot.retire : null;
  const retireAgeHours = retire ? hoursAgo(retire.lastRunAt, nowMs) : null;
  const retireStale = Boolean(retire) && (retireAgeHours == null || retireAgeHours > RETIRE_STALE_HOURS);
  const snapshotAgeHours = hoursAgo(snapshot && snapshot.generatedAt, nowMs);
  const retireRunLabel = !retire
    ? 'last retire run not recorded in this snapshot'
    : retireAgeHours == null
      ? 'retire has no recorded run'
      : `last retire run ${retireAgeHours}h ago`;
  const ageLine =
    `Freshness: snapshot ${snapshotAgeHours == null ? 'age unknown' : `generated ${snapshotAgeHours}h ago`}; ${retireRunLabel}` +
    (retire ? ` (red past ${RETIRE_STALE_HOURS}h).` : '.');

  const heldByGate = {};
  for (const br of awaitingStray) {
    if (br.heldBy) (heldByGate[br.heldBy] = heldByGate[br.heldBy] || []).push(br.name);
  }
  const heldLine = Object.keys(heldByGate).length
    ? `Held by a retire gate: ${Object.entries(heldByGate)
        .map(([gate, names]) => `${gate} (${plural(names.length, 'item')})`)
        .join(', ')}. These archive as soon as the gate clears, or at ${RETIRE_HARD_AGE_DAYS} days old unless the gate is a live session, a running process or a secret file.`
    : '';

  const archivedPresent = archivedStray.length + dirtyLandedArchived.length;
  const retiredRecent = retire ? Number(retire.retiredLast7Days) || 0 : 0;
  const retiredTotal = retire ? Number(retire.retiredTotal) || 0 : 0;
  const archiveWhere = retire && retire.location
    ? `${clean(retire.location.s3, 120)} (and ${clean(retire.location.disk, 100)})`
    : '';
  const archivedLine =
    retire && (archivedPresent || retiredTotal)
      ? `Archived (green): ${plural(retiredRecent, 'item')} archived and retired in the last 7 days, ${retiredTotal} in total; ${plural(archivedPresent, 'archived item')} still on disk awaiting removal. Restore from ${archiveWhere}.`
      : '';

  const strayItems = decisionItems;

  // Answer-first lead: the verdict/count goes first, never "Status:". A clean
  // tree says so outright; otherwise the parked-item count leads (the number the owner
  // cares about), then the rest of the counts. owner decision #gap: the face led
  // with "Status: git hygiene ..." which is log-speak, not an answer.
  const anyWork =
    parkedRecords.length +
      decisionItems +
      awaitingArchive +
      archivedPresent +
      awaitingStray.length +
      inFlightItems +
      safeBranches.length +
      dirtyLandedAll.length +
      unverifiedLandedBranches.length +
      lockedBranches.length >
    0;
  // Timed-out classifier calls mean the snapshot is INCOMPLETE: empty buckets
  // may be missing data, not cleanliness. Never render "Clean" from a degraded
  // snapshot (Codex review 2026-07-06); name the defect and keep trailing data.
  const degradedCalls = asArray(snapshot && snapshot.degraded);
  const degradedShown = degradedCalls.slice(0, 4).join('; ');
  const degradedSuffix = degradedCalls.length > 4 ? `, +${degradedCalls.length - 4} more` : '';
  const degradedLine = degradedCalls.length
    ? `DEFECT (red): git snapshot INCOMPLETE, ${plural(degradedCalls.length, 'classifier call')} timed out under shared-.git contention (${degradedShown}${degradedSuffix}). Counts below may be undercounts. Repair: retry once contention clears, or raise SB_GIT_TIMEOUT_MS.`
    : '';
  // Wording kept stable for the card parser: only work that is actually at
  // risk is phrased as "stray items needing a decision" or "landed worktrees
  // with uncommitted edits", so informational work can never turn the card red.
  const verdictParts = [
    plural(parkedRecords.length, 'parked item'),
    `${plural(strayItems, 'stray item')} needing a decision`,
    ...(awaitingArchive || awaitingStray.length
      ? [`${plural(awaitingArchive, 'item')} awaiting automatic archive`]
      : []),
    ...(inFlightItems
      ? [`${plural(inFlightItems, 'in-flight item')} under ${RETIRE_GRACE_DAYS} days old (auto-archived after that)`]
      : []),
    `${plural(dirtyLandedAtRisk.length, 'landed worktree')} with uncommitted edits`,
    ...(dirtyLandedArchived.length
      ? [`${plural(dirtyLandedArchived.length, 'edited landed worktree')} already archived`]
      : []),
    ...(unverifiedLandedBranches.length
      ? [`${plural(unverifiedLandedBranches.length, 'landed worktree')} unverified`]
      : []),
    ...(safeBranches.length
      ? [`${plural(safeBranches.length, 'landed leftover')} being cleared automatically`]
      : []),
    ...(lockedBranches.length
      ? [`${plural(lockedBranches.length, 'landed worktree')} git-locked, auto-handled after 7 days`]
      : []),
  ];
  const redReasons = [];
  if (retireStale) {
    redReasons.push(
      retireAgeHours == null
        ? 'the nightly retire has no recorded run, so nothing is cleaning up automatically'
        : `the nightly retire last ran ${retireAgeHours}h ago (limit ${RETIRE_STALE_HOURS}h), so nothing is cleaning up automatically`,
    );
  }
  const verdictLead = anyWork
    ? `${verdictParts.join(', ')}.`
    : degradedLine
      ? 'Unverified: cannot confirm clean, the git snapshot is incomplete (see defect below).'
      : 'Clean: no parked work, no stray branches, nothing to decide.';
  const blockerLead = redReasons.length ? `hard blocker: ${redReasons.join('; ')}. Repair: run node scripts/git-branch-retire.js --apply on the PC and check the 03:00 heal.` : '';
  const strandedLine = strandedCommitsLine(snapshot);
  const meaningParts = [];
  if (decisionItems)
    meaningParts.push(
      `${plural(decisionItems, 'worktree')} hold edits with no verified archive (shared-checkout edits included)`,
    );
  if (awaitingArchive)
    meaningParts.push(`${plural(awaitingArchive, 'item')} will be archived and removed automatically`);
  if (safeBranches.length)
    meaningParts.push(`${plural(safeBranches.length, 'landed leftover')} will be cleared automatically`);
  if (!decisionItems && !redReasons.length && anyWork)
    meaningParts.unshift('nothing needs your decision');
  const plainMeaningLine = meaningParts.length
    ? `In plain English: ${meaningParts.join('; ')}.`
    : '';
  const lines = [
    ...(blockerLead ? [blockerLead] : []),
    verdictLead,
    ...(plainMeaningLine ? [plainMeaningLine] : []),
    ageLine,
    ...(archivedLine ? [archivedLine] : []),
    ...(heldLine ? [heldLine] : []),
    ...(degradedLine ? [degradedLine] : []),
    ...(strandedLine ? [strandedLine] : []),
    'Actions: [Land] merge/push the work now; [Park] protect it with a reason and review date; [Drop] discard it only when it is clearly obsolete.',
    'Legend: STRAY needs a decision only when its worktree has unarchived edits; PARKED is protected; LANDED already reached origin/master (by ancestry or identical patch content); PROTECTED is a rescue snapshot and never auto-cleans.',
    'Janitor timing: Claude Code Stop hook runs `git-janitor --apply --cap=5`; health self-heal also dry-runs/applies it. If a LANDED branch survives the next stop or 03:00 CT heal block, that is a health-check defect.',
    `Retire timing: the 03:00 CT heal archives stray work older than ${RETIRE_GRACE_DAYS} days (git bundle on disk and S3, hash-checked both places, ledger with a restore command), then retires it, 25 per day. Work older than ${RETIRE_HARD_AGE_DAYS} days is archived regardless of soft gates (recent edits, young or recently locked worktree, unreadable process proof, unknown ignored file types); only a live session, a running process, a secret-looking file, a nested repo or an unreadable worktree still hold it, and the held gate is named above.`,
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

  const atRiskRows = strayAtRisk
    .slice(0, maxRows)
    .map((branch) =>
      decisionAdvice(
        'at-risk',
        `${branchLabel(branch)} - ${branch.worktreeState === 'conflicted' ? 'conflicted' : 'uncommitted'} edits, no archive`,
      ),
    );
  const workingTreeRow = summarizeUncommitted(uncommittedEdits, Math.min(6, maxRows));
  const strayRows = [...atRiskRows];
  if (workingTreeRow) strayRows.push(workingTreeRow);
  lines.push(...formatRows('Stray work needing a decision', strayRows, 'none'));
  const hiddenStray = Math.max(0, strayAtRisk.length - maxRows);
  if (hiddenStray > 0) lines.push(`  ... +${hiddenStray} more`);
  lines.push('');

  const autoBranchRows = awaitingStray.slice(0, maxRows).map((branch) =>
    decisionAdvice(
      'auto',
      `${branchLabel(branch)}${branch.heldBy ? ` - held by the ${clean(branch.heldBy, 40)} gate` : ''}`,
    ),
  );
  const autoStashRows = strayStashes
    .slice(0, Math.max(0, maxRows - autoBranchRows.length))
    .map((stash) => decisionAdvice('auto', stashLabel(stash)));
  lines.push(...formatRows('Awaiting automatic archive (informational)', [...autoBranchRows, ...autoStashRows], 'none'));
  const hiddenAuto =
    Math.max(0, awaitingStray.length - maxRows) +
    Math.max(0, strayStashes.length - autoStashRows.length);
  if (hiddenAuto > 0) lines.push(`  ... +${hiddenAuto} more`);
  lines.push('');

  const archivedRows = [...archivedStray, ...dirtyLandedArchived].slice(0, maxRows).map((branch) => {
    const arch = branch.archive || {};
    return `Archived (green): ${branchLabel(branch)} - archived ${clean(arch.at, 24) || 'earlier'}${arch.s3 ? ` at ${clean(arch.s3, 140)}` : ''}; removal pending.`;
  });
  lines.push(...formatRows('Archived, awaiting removal', archivedRows, 'none'));
  lines.push('');

  lines.push(
    ...formatRows(
      'Landed worktrees with uncommitted edits',
      [...dirtyLandedAtRisk, ...dirtyLandedWaiting]
        .slice(0, maxRows)
        .map((branch) => decisionAdvice('dirty-landed', branchLabel(branch))),
      'none',
    ),
  );
  if (dirtyLandedAtRisk.length + dirtyLandedWaiting.length > maxRows) {
    lines.push(`  ... +${dirtyLandedAtRisk.length + dirtyLandedWaiting.length - maxRows} more`);
  }
  lines.push('');

  lines.push(
    ...formatRows(
      'Landed worktrees not yet verified clean',
      unverifiedLandedBranches
        .slice(0, maxRows)
        .map((branch) => decisionAdvice('unverified-landed', branchLabel(branch))),
      'none',
    ),
  );
  if (unverifiedLandedBranches.length > maxRows) {
    lines.push(`  ... +${unverifiedLandedBranches.length - maxRows} more`);
  }
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
      'Active landed worktrees protected by a live session',
      activeLandedBranches
        .slice(0, maxRows)
        .map((branch) => decisionAdvice('live-landed', branchLabel(branch))),
      'none',
    ),
  );
  if (activeLandedBranches.length > maxRows) {
    lines.push(`  ... +${activeLandedBranches.length - maxRows} more`);
  }
  lines.push('');

  lines.push(
    ...formatRows(
      'Locked landed worktrees',
      lockedBranches
        .slice(0, maxRows)
        .map((branch) =>
          decisionAdvice(
            'locked',
            `${branchLabel(branch)} - ${clean(branch.worktreeLockReason || 'Git lock present', 120)}`,
          ),
        ),
      'none',
    ),
  );
  if (lockedBranches.length > maxRows) lines.push(`  ... +${lockedBranches.length - maxRows} more`);
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
  if (protectedBranches.length) {
    lines.push('');
    lines.push(
      `Preserved evidence: ${plural(protectedBranches.length, 'protected rescue snapshot')} retained. This is not an active-work or shared-checkout defect.`,
    );
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
      (snapshotPath ? readGitHygieneSnapshot(snapshotPath, { snapshotMaxAgeMs, nowMs }) : null) ||
      (classifier
        ? classifier({ cwd, today })
        : require('./git-hygiene.js').classifyGitState({ cwd, today }));
    return renderGitHygieneSnapshot(snapshot, { maxRows, nowMs });
  } catch (e) {
    const msg = clean((e && e.message) || e, 160) || 'unknown error';
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
  strandedCommitsLine,
};
