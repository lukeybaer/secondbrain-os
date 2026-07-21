'use strict';

const { spawnSync: defaultSpawnSync } = require('node:child_process');

/**
 * Owns the Graphiti consultation lifecycle for one scheduled skill run.
 *
 * The runner has many process.exit() branches. Keeping the consultation state
 * here gives every branch one idempotent receipt path, while synthetic release
 * canaries can skip consultation entirely instead of polluting production
 * disposition coverage with facts no real answer could use.
 */
function createScheduledSkillGraphiti({
  spawnSync = defaultSpawnSync,
  nodePath = process.execPath,
  cliPath,
  root,
  dataDir,
  skillName,
  scheduleDate,
  canaryMode = false,
} = {}) {
  let advisorId = '';
  let receiptRecorded = false;
  let pendingReceipt = null;

  const commandOptions = (extra = {}) => ({
    cwd: root,
    env: { ...process.env, SECONDBRAIN_DATA_DIR: dataDir },
    encoding: 'utf8',
    ...extra,
  });

  function start() {
    if (canaryMode) return { skipped: true, reason: 'synthetic release-rescue canary' };
    const request = {
      prompt: `Run the scheduled Amy skill ${skillName}`,
      action: `Execute scheduled-tasks/${skillName}/SKILL.md and persist its authorized outputs`,
      surface: 'scheduled-skill',
      conversationId: `scheduled-${skillName}-${scheduleDate}`,
      project: skillName,
      visibility: 'owner_private',
    };
    const result = spawnSync(nodePath, [cliPath, 'start'], {
      ...commandOptions(),
      input: JSON.stringify(request),
      timeout: 5000,
    });
    try {
      advisorId = JSON.parse(result.stdout || '{}').advisor_id || '';
    } catch {
      advisorId = '';
    }
    return { skipped: false, started: Boolean(advisorId), advisorId };
  }

  function context() {
    if (canaryMode) {
      return 'Graphiti Brain Advisor skipped: this is a synthetic release-rescue canary, not an Amy answer or action.';
    }
    if (!advisorId) {
      return 'Graphiti Brain Advisor was unavailable at start. Expose this first failure in Graphiti impact and do not invent recall.';
    }
    const result = spawnSync(
      nodePath,
      [cliPath, 'context', '--advisor-id', advisorId, '--wait-ms', '30000'],
      commandOptions({ timeout: 35000 }),
    );
    try {
      return (
        JSON.parse(result.stdout || '{}').prompt_block ||
        'Graphiti Brain Advisor context was unavailable.'
      );
    } catch {
      return 'Graphiti Brain Advisor context was unavailable. Expose the failure in Graphiti impact.';
    }
  }

  function writeReceipt(receipt) {
    if (canaryMode || !advisorId || receiptRecorded || !receipt) return false;
    const args = [
      cliPath,
      'receipt',
      '--advisor-id',
      advisorId,
      '--answer-action-id',
      receipt.answerActionId,
    ];
    if (receipt.ignoredReason) args.push('--ignored-reason', receipt.ignoredReason);
    const result = spawnSync(nodePath, args, {
      ...commandOptions(),
      input: String(receipt.output || ''),
      timeout: 5000,
    });
    if (result.status === 0) {
      receiptRecorded = true;
      pendingReceipt = null;
      return true;
    }
    return false;
  }

  function recordOutput(output, answerActionId) {
    if (canaryMode || !advisorId || receiptRecorded) return false;
    pendingReceipt = { output: String(output || ''), answerActionId: String(answerActionId) };
    return writeReceipt(pendingReceipt);
  }

  function flushAbandonment(reason, answerActionId) {
    if (canaryMode || !advisorId || receiptRecorded) return false;
    // If the normal receipt write failed, retry the same evidence rather than
    // replacing an actually influenced answer with an "ignored" receipt.
    if (pendingReceipt) return writeReceipt(pendingReceipt);
    pendingReceipt = {
      output: '',
      answerActionId: String(answerActionId || `scheduled-abandoned-${skillName}-${Date.now()}`),
      ignoredReason: String(
        reason || 'Ignored because the scheduled action ended before an answer boundary.',
      ),
    };
    return writeReceipt(pendingReceipt);
  }

  return {
    start,
    context,
    recordOutput,
    flushAbandonment,
    hasOpenConsult: () => Boolean(advisorId) && !receiptRecorded,
    state: () => ({ advisorId, receiptRecorded, pendingReceipt }),
  };
}

module.exports = { createScheduledSkillGraphiti };
