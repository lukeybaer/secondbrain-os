#!/usr/bin/env node
// Stale-RED escalation — the #gap prevention locked in on 2026-04-20.
//
// Reads the last N days of pre-briefing-diagnostic-YYYY-MM-DD.json and finds
// any probe that has been RED for 3+ consecutive days. For each one, writes
// a record to data/agent/escalations.jsonl and (unless --dry-run) drafts a
// Gmail escalation to luke.d.baer@gmail.com with the subject
// `[Amy cannot heal] <probeName> red <N> days` so the item surfaces LOUDER
// than a routine briefing line.
//
// The premise: if a probe's canAutoHeal is false and the briefing's daily
// "heads up" line isn't getting Luke to fix it either, the architecture has
// failed — the item needs a louder channel. Detection without escalation is
// a status board, not an EA.
//
// Memory: secondbrain/memory/feedback_canautoheal_false_is_not_a_heal.md

const fs = require('fs');
const path = require('path');

const STALE_DAYS = 3; // 3+ consecutive RED days triggers escalation

function daysAgoStr(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function loadDiagnostic(diagDir, date) {
  const p = path.join(diagDir, `pre-briefing-diagnostic-${date}.json`);
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

// Walks the last STALE_DAYS+1 days of diagnostics and finds probes that were
// RED on all of them (unbroken RED streak including today). Returns either
// { stale: [...] } or { error: 'message' }.
function computeStaleRedProbes(diagDir, opts = {}) {
  const streakDays = opts.streakDays || STALE_DAYS;
  const today = loadDiagnostic(diagDir, daysAgoStr(0));
  if (!today) return { error: `today's diagnostic missing: ${daysAgoStr(0)}` };

  const history = [];
  for (let i = 0; i <= streakDays; i++) {
    const d = loadDiagnostic(diagDir, daysAgoStr(i));
    if (!d) return { error: `missing diagnostic for ${daysAgoStr(i)} — cannot prove stale streak` };
    history.push({ date: daysAgoStr(i), checks: d.checks || {} });
  }

  const probeNames = Object.keys(today.checks || {});
  const stale = [];
  for (const probe of probeNames) {
    const allRed = history.every(
      (h) => h.checks[probe] && h.checks[probe].status === 'red',
    );
    if (!allRed) continue;
    const todaysDetail = today.checks[probe].detail || '';
    const canAutoHeal = today.checks[probe].canAutoHeal;
    stale.push({
      probe,
      streakDays: streakDays + 1,
      detail: todaysDetail,
      canAutoHeal: canAutoHeal === true,
      firstRedDate: history[history.length - 1].date,
    });
  }
  return { stale };
}

function hasExistingEscalation(logPath, probe, windowMs = 24 * 3600 * 1000) {
  if (!fs.existsSync(logPath)) return false;
  const now = Date.now();
  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
  for (const line of lines) {
    if (!line) continue;
    try {
      const row = JSON.parse(line);
      if (row.probe === probe && now - Date.parse(row.ts) < windowMs) return true;
    } catch {}
  }
  return false;
}

function logEscalation(logPath, entry) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
}

function draftGmailEscalation(entry, opts) {
  const { dryRun, repo } = opts;
  const subject = `[Amy cannot heal] ${entry.probe} red ${entry.streakDays} days`;
  const body = [
    `Amy detected ${entry.probe} has been RED for ${entry.streakDays} consecutive days.`,
    ``,
    `Detail: ${entry.detail}`,
    `First RED: ${entry.firstRedDate}`,
    `canAutoHeal: ${entry.canAutoHeal}`,
    ``,
    entry.canAutoHeal
      ? `Auto-heal is coded but something is blocking it. Investigate scripts/health-self-heal.js heal path for this probe.`
      : `No auto-heal path exists. Either implement one, or accept this as a manual task — but the daily briefing line is not moving the needle.`,
    ``,
    `Dispatched from scripts/stale-red-escalation.js.`,
  ].join('\n');

  if (dryRun) {
    console.log(`[dry-run] would draft Gmail to luke.d.baer@gmail.com`);
    console.log(`  subject: ${subject}`);
    return { drafted: false, dryRun: true };
  }

  try {
    const { execSync } = require('child_process');
    const sendScript = path.join(repo, 'scripts', 'send-gmail.py');
    if (!fs.existsSync(sendScript)) {
      return { drafted: false, error: 'send-gmail.py not found' };
    }
    execSync(
      `python "${sendScript}" --to luke.d.baer@gmail.com --subject "${subject.replace(/"/g, '\\"')}" --body-file -`,
      { input: body, encoding: 'utf8', timeout: 30000 },
    );
    return { drafted: true };
  } catch (e) {
    return { drafted: false, error: e.message.slice(0, 200) };
  }
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const REPO = process.env.SECONDBRAIN_ROOT || path.resolve(__dirname, '..');
  const DIAG_DIR = path.join(REPO, 'data', 'agent');
  const ESCALATION_LOG = path.join(DIAG_DIR, 'escalations.jsonl');

  const result = computeStaleRedProbes(DIAG_DIR);
  if (result.error) {
    console.log('[skip]', result.error);
    process.exit(0);
  }

  console.log(`[stale-red] found ${result.stale.length} stale RED probe(s)`);
  for (const s of result.stale) {
    if (hasExistingEscalation(ESCALATION_LOG, s.probe)) {
      console.log(`[skip] ${s.probe} — already escalated in last 24h`);
      continue;
    }
    const ts = new Date().toISOString();
    const drafted = draftGmailEscalation(s, { dryRun, repo: REPO });
    const entry = { ts, ...s, drafted };
    if (!dryRun) logEscalation(ESCALATION_LOG, entry);
    console.log(`[escalate] ${s.probe} — ${s.streakDays}d red — drafted=${JSON.stringify(drafted)}`);
  }
  process.exit(0);
}

if (require.main === module) main();

module.exports = {
  computeStaleRedProbes,
  hasExistingEscalation,
  logEscalation,
  draftGmailEscalation,
  loadDiagnostic,
  daysAgoStr,
  STALE_DAYS,
};
