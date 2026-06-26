#!/usr/bin/env node
/**
 * parallel-card-refresh.js
 *
 * Fan out every independent briefing-card data refresher CONCURRENTLY (no
 * superfluous sequential dependencies), and stream one progress line per card
 * as it finishes with a QC verdict. This is the parallel orchestration the
 * overnight briefing should use: an easy card (AWS spend) returns in a minute
 * and reports immediately instead of waiting on a slow card (tests, viral).
 *
 * Each refresher: { card, cmd, args, timeoutMs, qc(date) -> {ok, detail} }.
 * Progress is appended (one JSON line per event) to
 * data/agent/parallel-refresh-progress.jsonl AND echoed to stdout so a watcher
 * can stream it. The process stays alive until every refresher settles, then
 * writes a final summary line.
 *
 * Usage: node scripts/parallel-card-refresh.js [--date YYYY-MM-DD] [--only a,b,c]
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const REPO = process.env.SECONDBRAIN_ROOT || path.resolve(__dirname, '..');
const PROGRESS = path.join(REPO, 'data', 'agent', 'parallel-refresh-progress.jsonl');

function todayCt() { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }); }
function argv(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; }
const DATE = argv('--date') || todayCt();
const ONLY = (argv('--only') || '').split(',').map((s) => s.trim()).filter(Boolean);

const NODE = process.execPath;
const PY = process.platform === 'win32' ? 'py' : 'python3';

function readJson(rel) {
  try { return JSON.parse(fs.readFileSync(path.join(REPO, rel), 'utf8').replace(/^﻿/, '')); } catch { return null; }
}
function artifactFresh(rel, maxAgeMin = 90) {
  try { const st = fs.statSync(path.join(REPO, rel)); return (Date.now() - st.mtimeMs) < maxAgeMin * 60000; } catch { return false; }
}

// Each card refresher. qc() runs AFTER the process exits and returns the QC
// verdict the briefing validator will apply to that card.
const REFRESHERS = [
  { card: 'AWS Costs', cmd: NODE, args: ['scripts/aws-cost-section.js', '--date', DATE], timeoutMs: 5 * 60000,
    qc: () => { const a = readJson(`data/agent/aws-costs-${DATE}.json`); return a ? { ok: true, detail: `$${(a.total || a.grandTotal || 0)} total` } : { ok: false, detail: 'aws-costs artifact missing' }; } },
  { card: 'Token Usage', cmd: NODE, args: ['scripts/collect-daily-token-usage.js', '--date', DATE], timeoutMs: 4 * 60000,
    qc: () => { const prev = new Date(new Date(DATE + 'T12:00:00Z').getTime() - 86400000).toISOString().slice(0, 10); const a = readJson(`data/agent/token-usage-${prev}.json`); return a ? { ok: true, detail: 'rollup present' } : { ok: false, detail: `token-usage-${prev}.json missing` }; } },
  { card: 'Mortgage Rates', cmd: NODE, args: ['scripts/mortgage-rate-indexes.js', '--date', DATE], timeoutMs: 6 * 60000,
    qc: () => (artifactFresh(`data/agent/mortgage-rates/${DATE}.json`) ? { ok: true, detail: 'rate indexes refreshed' } : { ok: false, detail: 'mortgage-rates artifact stale/missing' }) },
  { card: 'Shorts Proposals', cmd: NODE, args: ['scripts/morning-shorts-proposals.js', '--date', DATE], timeoutMs: 18 * 60000,
    qc: () => { const a = readJson(`data/agent/shorts-proposals/${DATE}.json`); const n = a && Array.isArray(a.proposals) ? a.proposals.length : 0; return { ok: n >= 10, detail: `${n}/10 proposals` }; } },
  { card: 'Viral Tech Clips', cmd: NODE, args: ['scripts/viral-tech-clip-proposals.js', '--date', DATE, '--force'], timeoutMs: 12 * 60000,
    qc: () => { const a = readJson(`data/agent/viral-tech-clips/${DATE}.json`); const n = Array.isArray(a) ? a.length : (a && (a.proposals || a.clips) || []).length; return { ok: n >= 3, detail: `${n}/3 clips` }; } },
  { card: 'News (covid/us/world/aitech/immigration)', cmd: NODE, args: ['-e', `require('./scripts/content-heal.js').runContentHeal({date:'${DATE}',perPassMs:420000}).then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1)})`], timeoutMs: 16 * 60000,
    qc: () => { const a = readJson(`data/agent/content-heal-${DATE}.json`); if (!a || !a.cards) return { ok: false, detail: 'content-heal artifact missing' }; const short = Object.entries(a.cards).filter(([k, v]) => !v.wall && (v.count || 0) < (v.target || 0)).map(([k]) => k); return { ok: short.length === 0, detail: short.length ? `short: ${short.join(',')}` : 'all news cards at threshold' }; } },
  { card: 'Tests', cmd: NODE, args: ['scripts/heal-tests.js'], timeoutMs: 12 * 60000,
    qc: () => { const a = readJson('data/agent/tests-blocked.json'); const f = a ? (a.failed || 0) : -1; return { ok: f === 0, detail: f === 0 ? `0 failing of ${a.total}` : `${f} failing` }; } },
  { card: 'Gmail scan / action items', cmd: NODE, args: ['scripts/gmail-amy-scan.js'], timeoutMs: 6 * 60000,
    qc: () => (artifactFresh('data/agent/gmail-scan-heartbeat.jsonl', 30) ? { ok: true, detail: 'watcher checked in' } : { ok: false, detail: 'gmail heartbeat stale' }) },
];

const selected = ONLY.length ? REFRESHERS.filter((r) => ONLY.some((o) => r.card.toLowerCase().includes(o.toLowerCase()))) : REFRESHERS;

function emit(row) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...row });
  try { fs.mkdirSync(path.dirname(PROGRESS), { recursive: true }); fs.appendFileSync(PROGRESS, line + '\n'); } catch {}
  process.stdout.write(line + '\n');
}

function runOne(r) {
  return new Promise((resolve) => {
    const started = Date.now();
    emit({ event: 'card-start', card: r.card });
    let child;
    try { child = spawn(r.cmd, r.args, { cwd: REPO, windowsHide: true, env: process.env, stdio: ['ignore', 'ignore', 'pipe'] }); }
    catch (e) { emit({ event: 'card-done', card: r.card, ok: false, qc: 'spawn-failed: ' + String(e.message), durationS: 0 }); return resolve(); }
    let stderrTail = '';
    child.stderr.on('data', (c) => { stderrTail = (stderrTail + c.toString()).slice(-800); });
    let settled = false;
    const finish = (exitNote) => {
      if (settled) return; settled = true;
      try { clearTimeout(timer); } catch {}
      const durationS = Math.round((Date.now() - started) / 1000);
      let qc;
      try { qc = r.qc(); } catch (e) { qc = { ok: false, detail: 'qc threw: ' + String(e.message) }; }
      emit({ event: 'card-done', card: r.card, ok: qc.ok, qc: qc.detail, durationS, exitNote: exitNote || '', stderrTail: qc.ok ? '' : stderrTail });
      resolve();
    };
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} finish('TIMEOUT'); }, r.timeoutMs);
    child.on('close', (code) => finish(code === 0 ? '' : `exit ${code}`));
    child.on('error', (e) => finish('error ' + String(e.message)));
  });
}

(async () => {
  emit({ event: 'run-start', date: DATE, cards: selected.map((r) => r.card) });
  await Promise.all(selected.map(runOne));
  const all = fs.readFileSync(PROGRESS, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const dones = all.filter((r) => r.event === 'card-done' && new Date(r.ts).getTime() >= Date.now() - 60 * 60000);
  const pass = dones.filter((r) => r.ok).length;
  emit({ event: 'run-done', date: DATE, pass, total: selected.length, failing: dones.filter((r) => !r.ok).map((r) => r.card) });
})();
