'use strict';

// scripts/self-heal/mechanical-recurrence.js
//
// ITEM W2a, ESCALATION POLICY (masking guard): a mechanical action clearing a
// defect every night is a SUCCESS for that night, but if the SAME defect
// keeps recurring and getting mechanically papered over, that is a masked
// root cause -- the generator/renderer keeps producing bad output and the
// mechanical tactic keeps re-running to patch it, when a human should look
// at why the underlying producer keeps failing. A defect that recurs on 3
// CONSECUTIVE days escalates to the interactive session in the SELF-HEAL
// card even when the mechanical tier keeps clearing it.
//
// Pure, DI-free: given a defect key and its per-day history rows
// ({ date, defect, clearedByMechanicalTactic }), decide whether today's
// clear should also raise the masking-guard escalation.

const fs = require('node:fs');
const path = require('node:path');

function defaultDataDir() {
  if (process.env.SECONDBRAIN_DATA_DIR) return process.env.SECONDBRAIN_DATA_DIR;
  if (process.platform === 'linux' && fs.existsSync('/opt/secondbrain/data'))
    return '/opt/secondbrain/data';
  if (process.env.APPDATA) return path.join(process.env.APPDATA, 'secondbrain', 'data');
  return path.resolve(__dirname, '..', '..', 'data');
}

function recurrenceLogPath(opts = {}) {
  return path.join(opts.dataDir || defaultDataDir(), 'agent', 'mechanical-heal-recurrence.jsonl');
}

// Record one day's mechanical-tier outcome for a defect. Append-only, one row
// per (date, defect). Safe to call multiple times for the same day (the
// reader below de-dupes by keeping the LAST row per (date, defect)).
function recordDailyOutcome(row, opts = {}) {
  const p = recurrenceLogPath(opts);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(
    p,
    JSON.stringify({
      date: row.date,
      defect: row.defect,
      clearedByMechanicalTactic: !!row.clearedByMechanicalTactic,
      ts: row.ts || new Date().toISOString(),
    }) + '\n',
  );
}

function readHistory(opts = {}) {
  const p = recurrenceLogPath(opts);
  if (!fs.existsSync(p)) return [];
  const out = [];
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      /* skip corrupt line, never wedge the reader */
    }
  }
  return out;
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function dayBefore(dateStr) {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return isoDate(d);
}

// Decide whether `defectKey` should escalate to the interactive session's
// SELF-HEAL card, given its per-day history and the date being evaluated
// (defaults to the latest date present in history for that defect).
// Walks backward day-by-day from asOfDate: each day must have a row for this
// defect with clearedByMechanicalTactic===true to extend the streak; a
// missing day (gap) or a day where the mechanical tactic did NOT clear it
// (escalated to LLM/human that day) breaks the streak. escalate=true once
// the streak reaches 3 consecutive days.
function recurrenceEscalation(defectKey, history, opts = {}) {
  const rows = (history || []).filter((r) => r && r.defect === defectKey);
  const byDate = new Map();
  for (const r of rows) byDate.set(r.date, r); // last-write-wins per date
  const asOfDate = opts.asOfDate || [...byDate.keys()].sort().pop();
  if (!asOfDate) return { escalate: false, consecutiveDays: 0, reason: 'no history' };

  let consecutiveDays = 0;
  let cursor = asOfDate;
  while (true) {
    const row = byDate.get(cursor);
    if (!row || !row.clearedByMechanicalTactic) break;
    consecutiveDays += 1;
    cursor = dayBefore(cursor);
    if (consecutiveDays >= 3) break; // no need to walk further than the threshold
  }

  const escalate = consecutiveDays >= 3;
  return {
    escalate,
    consecutiveDays,
    reason: escalate
      ? `defect '${defectKey}' mechanically cleared ${consecutiveDays} consecutive day(s) through ${asOfDate}; masking guard escalates to the interactive session even though the mechanical tier keeps clearing it`
      : `defect '${defectKey}' has ${consecutiveDays} consecutive mechanically-cleared day(s) through ${asOfDate}; below the 3-day masking threshold`,
  };
}

module.exports = {
  defaultDataDir,
  recurrenceLogPath,
  recordDailyOutcome,
  readHistory,
  recurrenceEscalation,
};
