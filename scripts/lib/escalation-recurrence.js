// scripts/lib/escalation-recurrence.js
//
// Recurrence digest over data/agent/escalations.jsonl. devops-health.js,
// pre-briefing-diagnostic.js and stale-red-escalation.js APPEND one escalation
// record each time a health probe is red past threshold, but nothing rolls the
// ledger up. So a probe that goes red, escalates, "heals", and goes red again
// the next day looks like an isolated incident every time -- the exact pattern
// Amy's learning cascade says must auto-escalate ("when a rule is violated
// twice, it auto-escalates from a memory file to a hook or test").
//
// This digest groups escalations by probe over a window and singles out the
// dangerous class: probes that CANNOT self-heal (canAutoHeal:false) and keep
// recurring. Those are the ones a human or a new mechanical guard must own --
// re-drafting the same "Amy cannot heal" email every morning is not progress.
//
// Pure over records (summarizeEscalations never touches fs); only
// reportFromFile() reads disk.
//
// Escalation record shape (devops-health.js / stale-red-escalation.js):
//   { ts, probe, streakDays, detail, canAutoHeal, firstRedDate, drafted:{..} }

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO = process.env.SECONDBRAIN_ROOT || path.resolve(__dirname, '..', '..');
const ESCALATIONS_PATH = path.join(REPO, 'data', 'agent', 'escalations.jsonl');

const DEFAULT_WINDOW_DAYS = 30;
const CHRONIC_STREAK_DAYS = 3; // red this many days running = chronic
const RECUR_OCCURRENCES = 2; // escalated this many times in window = recurring

function parseEscalations(text) {
  if (!text) return [];
  const out = [];
  for (const line of String(text).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // a torn final line must not break the rollup
    }
  }
  return out;
}

// summarizeEscalations(records, opts) -> recurrence rollup. Pure.
//   opts.now            window anchor (default: newest record ts)
//   opts.windowDays     lookback window (default 30)
//   opts.chronicStreak  streakDays at/above which a probe is chronic (default 3)
//   opts.recurOccur     occurrences at/above which a probe is recurring (default 2)
function summarizeEscalations(records, opts = {}) {
  const windowDays = Number.isFinite(opts.windowDays) ? opts.windowDays : DEFAULT_WINDOW_DAYS;
  const chronicStreak = Number.isFinite(opts.chronicStreak)
    ? opts.chronicStreak
    : CHRONIC_STREAK_DAYS;
  const recurOccur = Number.isFinite(opts.recurOccur) ? opts.recurOccur : RECUR_OCCURRENCES;

  const all = Array.isArray(records) ? records : [];
  const timestamps = all
    .map((r) => r && r.ts && Date.parse(r.ts))
    .filter((t) => Number.isFinite(t));
  const anchor =
    opts.now != null ? Date.parse(new Date(opts.now).toISOString()) : Math.max(...timestamps, 0);
  const cutoff =
    Number.isFinite(anchor) && anchor > 0 && windowDays > 0
      ? anchor - windowDays * 24 * 3600 * 1000
      : -Infinity;

  const inWindow = all.filter((r) => {
    if (!r || typeof r !== 'object' || !r.probe) return false;
    const t = r.ts ? Date.parse(r.ts) : NaN;
    if (!Number.isFinite(t)) return windowDays <= 0;
    return t >= cutoff;
  });

  const byProbe = {};
  for (const r of inWindow) {
    const probe = r.probe;
    if (!byProbe[probe]) {
      byProbe[probe] = {
        probe,
        occurrences: 0,
        maxStreakDays: 0,
        firstRedDate: r.firstRedDate || null,
        lastTs: null,
        lastDetail: null,
        canAutoHeal: null, // value from the most recent escalation
      };
    }
    const b = byProbe[probe];
    b.occurrences += 1;
    if (Number.isFinite(r.streakDays)) b.maxStreakDays = Math.max(b.maxStreakDays, r.streakDays);
    if (r.firstRedDate && (!b.firstRedDate || r.firstRedDate < b.firstRedDate)) {
      b.firstRedDate = r.firstRedDate;
    }
    const t = r.ts ? Date.parse(r.ts) : NaN;
    if (Number.isFinite(t) && (b.lastTs == null || t >= Date.parse(b.lastTs))) {
      b.lastTs = r.ts;
      b.lastDetail = r.detail || null;
      if (typeof r.canAutoHeal === 'boolean') b.canAutoHeal = r.canAutoHeal;
    }
  }

  const probes = Object.values(byProbe);
  const isChronic = (b) => b.maxStreakDays >= chronicStreak || b.occurrences >= recurOccur;
  const chronic = probes
    .filter(isChronic)
    .sort((a, c) => c.maxStreakDays - a.maxStreakDays || c.occurrences - a.occurrences);
  // The dangerous class: cannot self-heal AND keeps coming back.
  const unhealableRecurring = chronic.filter((b) => b.canAutoHeal === false);

  let verdict = 'clean';
  const reasons = [];
  if (unhealableRecurring.length > 0) {
    verdict = 'escalate';
    for (const b of unhealableRecurring) {
      reasons.push(
        `${b.probe}: red ${b.maxStreakDays}d, ${b.occurrences}x, cannot self-heal - needs a human or a new guard`,
      );
    }
  } else if (chronic.length > 0) {
    verdict = 'attention';
    for (const b of chronic) {
      reasons.push(
        `${b.probe}: red ${b.maxStreakDays}d over ${b.occurrences} escalation(s) (auto-healable)`,
      );
    }
  } else {
    reasons.push('no chronic or recurring escalations in window');
  }

  return {
    windowDays,
    anchor: Number.isFinite(anchor) && anchor > 0 ? new Date(anchor).toISOString() : null,
    totalEscalations: inWindow.length,
    probeCount: probes.length,
    chronic,
    unhealableRecurring,
    verdict,
    reasons,
  };
}

function reportFromFile(filePath = ESCALATIONS_PATH, opts = {}) {
  let text = '';
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return summarizeEscalations([], opts);
  }
  return summarizeEscalations(parseEscalations(text), opts);
}

function oneLine(summary) {
  if (summary.verdict === 'clean') {
    return `escalation recurrence [clean] ${summary.totalEscalations} escalation(s), no chronic probes`;
  }
  if (summary.verdict === 'attention') {
    return `escalation recurrence [attention] ${summary.chronic.length} chronic probe(s), all auto-healable`;
  }
  return `escalation recurrence [escalate] ${summary.unhealableRecurring.length} unhealable recurring probe(s) - ${summary.reasons[0] || ''}`;
}

module.exports = {
  ESCALATIONS_PATH,
  CHRONIC_STREAK_DAYS,
  RECUR_OCCURRENCES,
  parseEscalations,
  summarizeEscalations,
  reportFromFile,
  oneLine,
};

if (require.main === module) {
  const summary = reportFromFile();
  // eslint-disable-next-line no-console
  console.log(oneLine(summary));
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.verdict === 'escalate' ? 1 : 0);
}
