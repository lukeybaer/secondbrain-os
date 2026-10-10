'use strict';

/**
 * spine-scorecard.js -- the weekly "does Amy finish what she is given" number,
 * computed from the clean Task store. Deterministic accounting only: no model.
 *
 * Counted work = real work Amy was handed: kind action or coding, not a passive
 * intake record, not an operational session/outcome record, not a helper agent
 * Amy spawned for herself. Only rows that reached a terminal state inside the
 * window are scored; rows still open are reported, never hidden.
 *
 *   finishedWithoutExampleCo  done, and ExampleCo never had to answer a question or steer
 *   corrected            ExampleCo answered a feedback request or steered the task
 *   greenAtDelivery      done on the first pass: never failed, never blocked
 *   medianHoursToDone    median (completedAt - createdAt) of done rows
 *   tokens               sum of the existing weekly token telemetry, if present
 */

const fs = require('node:fs');
const path = require('node:path');
const { listSpineTasks } = require('./spine-ingress.js');
const { isOperationalRecord, OPEN_STATUSES } = require('./spine-reconcile.js');

const WINDOW_DAYS = 7;

function isCountedWork(task) {
  if (!task || (task.kind !== 'action' && task.kind !== 'coding')) return false;
  if (isOperationalRecord(task)) return false;
  if (task.meta && (task.meta.passiveIntake === true || task.meta.supervision)) return false;
  if (task.source && task.source.type === 'agent-spawn') return false;
  return true;
}

function wasCorrected(task) {
  const replies = task.feedbackRequest && task.feedbackRequest.replies;
  if (Array.isArray(replies) && replies.length > 0) return true;
  return (task.history || []).some(
    (h) => h && (h.status === 'steered' || /steer|amend|correct/i.test(String(h.note || ''))),
  );
}

function wasFirstPass(task) {
  return !(task.history || []).some(
    (h) => h && (h.status === 'failed' || h.status === 'requires-feedback' || h.status === 'blocked'),
  );
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Sum the existing weekly token telemetry files written per host. Omitted if none are fresh. */
function readWeeklyTokens(dataDir, nowMs, windowMs) {
  const dir = path.join(dataDir, 'agent');
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /^token-spend-weekly-.*\.json$/.test(f));
  } catch {
    return null;
  }
  let total = 0;
  const hosts = [];
  for (const file of files) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      const at = Date.parse(j.generatedAt || '');
      if (!Number.isFinite(at) || nowMs - at > windowMs) continue;
      let hostTotal = 0;
      for (const provider of Object.values(j.providers || {})) {
        for (const s of (provider && provider.sessions) || []) hostTotal += Number(s.tokens) || 0;
      }
      total += hostTotal;
      hosts.push(j.host || file);
    } catch {
      /* unreadable telemetry is omitted, not guessed */
    }
  }
  return hosts.length ? { total, hosts } : null;
}

function buildScorecard({ tasks, dataDir, nowMs = Date.now(), days = WINDOW_DAYS, tasksDir } = {}) {
  const windowMs = days * 86400000;
  const all = tasks || listSpineTasks({ tasksDir });
  const counted = all.filter(isCountedWork);
  const inWindow = counted.filter((t) => {
    const at = Date.parse(t.completedAt || '');
    return Number.isFinite(at) && nowMs - at <= windowMs && nowMs - at >= 0;
  });
  const done = inWindow.filter((t) => t.status === 'done');
  const failed = inWindow.filter((t) => t.status === 'failed');
  const hours = done
    .map((t) => (Date.parse(t.completedAt) - Date.parse(t.createdAt)) / 3600000)
    .filter((h) => Number.isFinite(h) && h >= 0);
  const corrected = done.filter(wasCorrected);
  const stillOpen = counted.filter((t) => OPEN_STATUSES.has(t.status));
  const tokens = dataDir ? readWeeklyTokens(dataDir, nowMs, windowMs) : null;
  return {
    schema: 'amy.spine-scorecard.v1',
    generatedAt: new Date(nowMs).toISOString(),
    windowDays: days,
    finishedWithoutExampleCo: done.length - corrected.length,
    corrected: corrected.length,
    done: done.length,
    failed: failed.length,
    stillOpen: stillOpen.length,
    medianHoursToDone: median(hours) === null ? null : Math.round(median(hours) * 10) / 10,
    greenAtDelivery: done.filter(wasFirstPass).length,
    tokens,
  };
}

function formatScorecard(card) {
  const lines = [
    `Amy weekly scorecard (last ${card.windowDays} days)`,
    `Finished without ExampleCo: ${card.finishedWithoutExampleCo} of ${card.done} done`,
    `Corrected by ExampleCo: ${card.corrected}`,
    `Median time to done: ${card.medianHoursToDone === null ? 'n/a' : `${card.medianHoursToDone} h`}`,
    `Green at delivery (first pass, no failure or block): ${card.greenAtDelivery} of ${card.done}`,
    `Failed: ${card.failed}. Still open: ${card.stillOpen}`,
  ];
  if (card.tokens) {
    lines.push(`Tokens used (${card.tokens.hosts.join(', ')}): ${card.tokens.total.toLocaleString('en-US')}`);
  }
  return lines.join('\n');
}

module.exports = { buildScorecard, formatScorecard, isCountedWork, wasCorrected, wasFirstPass, WINDOW_DAYS };
