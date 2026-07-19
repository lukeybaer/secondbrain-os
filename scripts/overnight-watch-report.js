#!/usr/bin/env node
'use strict';

// scripts/overnight-watch-report.js
//
// The standing 5:30 watch-report pipeline (ExampleCo, 2026-07-19): "a smooth
// delivery of the watcher html report (here's what we learned overnight,
// here's how to improve the briefing with engineering pipeline, and with
// agentic healing) - that should drop pretty quick at 5:30 too... the
// learnings are getting prepared through the night as we go."
//
// The learnings ARE prepared through the night, by the machinery itself,
// into durable ledgers: overnight-self-heal-runs.jsonl (every pass, verdict,
// judgment, and three-outcome summary), the per-defect briefing repair
// ledger (every tactic and reflection), self-heal-escalations.jsonl (the
// triage gate's needs-from-ExampleCo output), nightly-enhancements.jsonl, the
// deploy and land-gate receipts, and the canonical live board artifact.
// Nothing about the morning watch report requires a session awake at 4am
// except the RENDERING, so this renderer is pure and deterministic: NO LLM
// call anywhere, so it can never block on auth or budget. It assembles the
// same three-part shape the hand-written reports use (what happened
// overnight, engineering pipeline recommendations, agentic healing
// recommendations) and labels itself honestly as ledger-assembled; a live
// watcher session adds judgment on top when present, but the 5:30 drop
// never depends on one.
//
// Output is a RUNTIME ARTIFACT (never git-tracked): the dated
// <dataDir>/briefings/watch-report-<date>.html plus the stable alias
// watch-report-latest.html beside it. Served key-gated at
// /briefing/watch-report (ec2-server.js; the /briefing* auth gate covers
// it), and linked from the morning Telegram status line
// (scripts/lib/briefing-notify.js) when the file exists for the day.
//
// Every timestamp on the face renders in CT via scripts/lib/ct-face-time.js
// (memory/feedback_times_in_ct_never_utc.md): no raw ISO-Z ever reaches ExampleCo.

const fs = require('node:fs');
const path = require('node:path');
const { ctTimeLabel, ctFaceTime } = require('./lib/ct-face-time.js');
const { defectiveCardCount, readLiveBoardArtifact } = require('./lib/live-board-truth.js');
const repairLedger = require('./self-heal/briefing-repair-ledger.js');

const CT_ZONE = 'America/Chicago';
const NIGHT_START_HOUR_CT = 21;

// ---------------------------------------------------------------------------
// CT date/window math
// ---------------------------------------------------------------------------

function ctDateKey(value = Date.now()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: CT_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(value));
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function previousDateKey(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) - 24 * 3600 * 1000).toISOString().slice(0, 10);
}

// Epoch ms of a CT wall-clock hour on a CT date. Chicago is UTC-5 (CDT) or
// UTC-6 (CST); try both candidate offsets and keep the one that formats back
// to the requested wall time. On a DST transition night neither may round-trip
// for the skipped hour; fall back to CST so the window stays deterministic.
function ctWallTimeToEpochMs(dateStr, hour) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  for (const offsetHours of [5, 6]) {
    const guess = Date.UTC(y, m - 1, d, hour + offsetHours, 0, 0, 0);
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: CT_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(guess));
    const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const sameDate = `${byType.year}-${byType.month}-${byType.day}` === dateStr;
    if (sameDate && Number(byType.hour) === hour) return guess;
  }
  return Date.UTC(y, m - 1, d, hour + 6, 0, 0, 0);
}

// The CT night window for briefing date D: D-1 21:00 CT through invocation
// time, capped at D 21:00 CT so re-rendering a past date never swallows the
// following night's receipts.
function nightWindow({ date, nowMs = Date.now() } = {}) {
  const day = String(date || ctDateKey(nowMs)).slice(0, 10);
  const startMs = ctWallTimeToEpochMs(previousDateKey(day), NIGHT_START_HOUR_CT);
  const capMs = ctWallTimeToEpochMs(day, NIGHT_START_HOUR_CT);
  const endMs = Math.max(startMs, Math.min(nowMs, capMs));
  return { date: day, startMs, endMs };
}

// ---------------------------------------------------------------------------
// Tolerant ledger readers (any file may be absent; corrupt lines are skipped)
// ---------------------------------------------------------------------------

function readJsonlRows(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null; // absent file: honestly distinguishable from zero rows
  }
  const rows = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') rows.push(parsed);
    } catch {
      // a torn or corrupt line never wedges the morning report
    }
  }
  return rows;
}

function rowTsMs(row) {
  const ts = row && (row.ts || row.ranAt || row.generatedAt);
  const ms = Date.parse(String(ts || ''));
  return Number.isFinite(ms) ? ms : NaN;
}

function inWindow(row, window) {
  const ms = rowTsMs(row);
  return Number.isFinite(ms) && ms >= window.startMs && ms <= window.endMs;
}

function readWindowedJsonl(file, window) {
  const rows = readJsonlRows(file);
  if (rows === null) return { present: false, rows: [] };
  return { present: true, rows: rows.filter((row) => inWindow(row, window)) };
}

// ---------------------------------------------------------------------------
// Collectors: one per receipt family, all I/O in collectNightInputs
// ---------------------------------------------------------------------------

function collectNightInputs({ date, dataDir, repo, nowMs = Date.now() } = {}) {
  const window = nightWindow({ date, nowMs });
  const agentDir = path.join(dataDir, 'agent');
  const selfHeal = readWindowedJsonl(path.join(agentDir, 'overnight-self-heal-runs.jsonl'), window);
  const escalations = readWindowedJsonl(path.join(agentDir, 'self-heal-escalations.jsonl'), window);
  const enhancements = readWindowedJsonl(path.join(agentDir, 'nightly-enhancements.jsonl'), window);
  const deploys = readWindowedJsonl(path.join(agentDir, 'ec2-deploy-receipts.jsonl'), window);

  let landGate = null;
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(agentDir, 'land-gate-receipt.json'), 'utf8'),
    );
    if (parsed && typeof parsed === 'object' && inWindow(parsed, window)) landGate = parsed;
  } catch {
    landGate = null;
  }

  // Per-defect repair ledger: the night spans two briefing dates (the 11pm
  // bootstrap already writes tomorrow's date), so read both files and let the
  // window filter decide.
  const ledgerOpts = { dataDir };
  const repairAttempts = [];
  let repairLedgerPresent = false;
  for (const day of [previousDateKey(window.date), window.date]) {
    if (fs.existsSync(repairLedger.ledgerPath(day, ledgerOpts))) repairLedgerPresent = true;
    for (const row of repairLedger.attemptRows(day, ledgerOpts)) {
      if (inWindow(row, window)) repairAttempts.push(row);
    }
  }

  // `repo` is injectable so tests can isolate the two-root resolver onto a
  // fixture directory; production leaves it undefined (real repo root).
  const board = readLiveBoardArtifact({ dataDir, repo, nowMs });

  return {
    window,
    selfHeal,
    escalations,
    enhancements,
    deploys,
    landGate,
    repairAttempts,
    repairLedgerPresent,
    board: { artifact: board.artifact, stale: !!board.stale },
  };
}

// ---------------------------------------------------------------------------
// Model: pure assembly over collected inputs (unit-testable with fixtures)
// ---------------------------------------------------------------------------

function greenCountLine(board) {
  const artifact = board && board.artifact;
  const cards = artifact && Array.isArray(artifact.cards) ? artifact.cards : null;
  if (!cards || !cards.length) {
    return { line: 'No live board artifact was readable; green count unavailable.', nonGreen: [] };
  }
  const defective = defectiveCardCount(artifact);
  const total = cards.length;
  const green = total - defective;
  const nonGreen = cards
    .filter((card) => card && card.status !== 'clean')
    .map((card) => `${card.id || card.title || 'ExampleCo'} (${card.status})`);
  let line = `${green}/${total} green`;
  line += nonGreen.length ? `; non-green: ${nonGreen.join(', ')}.` : '; every card green.';
  if (board.stale) {
    line += ` Live board artifact is STALE (as of ${ctTimeLabel(artifact.ts) || 'ExampleCo'}); this is the last verified state, not the current one.`;
  }
  return { line, nonGreen };
}

function summarizeOutcome(summary) {
  if (!summary || typeof summary !== 'object') return '';
  const cleared = Number(summary.cleared) || 0;
  const escalated = Number(summary.escalated_to_human) || 0;
  const failed = Number(summary.failed_to_fix) || 0;
  return `${cleared} cleared, ${escalated} escalated_to_human, ${failed} failed_to_fix`;
}

function compactText(value, max = 400) {
  const text = String(value == null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function buildTimeline(inputs) {
  const events = [];
  const push = (row, label) => {
    const ms = rowTsMs(row);
    if (Number.isFinite(ms) && label) events.push({ tsMs: ms, label: compactText(label, 300) });
  };

  for (const row of inputs.selfHeal.rows) {
    if (row.stage === 'orchestrator-complete') {
      const bits = [
        `self-heal pass ${row.pass != null ? row.pass : '?'} complete: cleared ${Number(row.cleared) || 0}, escalated ${Number(row.escalated) || 0}`,
      ];
      if (row.repairLoopOptionsExhausted) bits.push('repair loop exhausted');
      push(row, bits.join('; '));
    } else if (row.verdict) {
      const summary = summarizeOutcome(row.outcomeSummary);
      push(row, `agentic healer verdict: ${row.verdict}${summary ? ` (${summary})` : ''}`);
    }
  }
  for (const row of inputs.escalations.rows) {
    push(
      row,
      `escalated to ExampleCo (${row.kind || 'human-gated'}): ${row.cardId || row.defect || 'ExampleCo defect'}`,
    );
  }
  for (const row of inputs.enhancements.rows) {
    push(row, `nightly enhancement: ${row.title || row.summary || row.enhancement || 'cycle ran'}`);
  }
  for (const row of inputs.deploys.rows) {
    const drift =
      row.matchesOriginMaster === false ? '; deployed content does NOT match origin/master' : '';
    push(row, `EC2 deploy receipt: relation ${row.relation || 'ExampleCo'}${drift}`);
  }
  if (inputs.landGate) {
    push(
      inputs.landGate,
      `land gate ${inputs.landGate.status}: ${inputs.landGate.branch || 'ExampleCo branch'} @ ${String(inputs.landGate.commit || '').slice(0, 8)}${inputs.landGate.landed ? ' (landed)' : ''}`,
    );
  }
  events.sort((a, b) => a.tsMs - b.tsMs);
  return events;
}

// Repeated failed tactics: the SAME tactic tried 2+ times on one defect in
// the window with no clear is, mechanically, a missing pipeline guarantee.
function repeatedFailedTactics(repairAttempts) {
  const byDefect = new Map();
  for (const row of repairAttempts) {
    const key = repairLedger.normDefectKey(row.defect);
    const list = byDefect.get(key) || [];
    list.push(row);
    byDefect.set(key, list);
  }
  const items = [];
  for (const rows of byDefect.values()) {
    if (rows.some((row) => repairLedger.isClearedRow(row))) continue;
    const byTactic = new Map();
    for (const row of rows) {
      const tKey = row.tacticKey || repairLedger.tacticKey(row.tactic);
      if (!tKey) continue;
      const list = byTactic.get(tKey) || [];
      list.push(row);
      byTactic.set(tKey, list);
    }
    for (const tacticRows of byTactic.values()) {
      if (tacticRows.length < 2) continue;
      const last = tacticRows[tacticRows.length - 1];
      items.push({
        defect: repairLedger.defectKey(last.defect),
        tactic: last.tactic || '',
        attempts: tacticRows.length,
        lastQcResult: last.qcResult || 'failed',
        lastReflection: compactText(last.reflection, 240),
      });
    }
  }
  items.sort((a, b) => b.attempts - a.attempts || a.defect.localeCompare(b.defect));
  return items;
}

// Watchdog kills are headroom signals: the work unit outgrew its budget.
function watchdogKills(selfHealRows) {
  const items = [];
  for (const row of selfHealRows) {
    if (row.publishRefreshWatchdogKilled === true) {
      items.push({
        what: `publish-refresh watchdog killed during pass ${row.pass != null ? row.pass : '?'}`,
        at: rowTsMs(row),
      });
    }
    const sessions = Array.isArray(row.sessions) ? row.sessions : row.session ? [row.session] : [];
    for (const session of sessions) {
      if (session && session.watchdog) {
        items.push({
          what: `healer session watchdog fired (tactic ${session.tactic || 'ExampleCo'})`,
          at: rowTsMs(row),
        });
      }
    }
  }
  return items;
}

// Needs-from-ExampleCo: triage-gate escalation rows plus escalated_to_human
// per-defect outcomes inside healer receipts, deduped on defect+action.
function needsFromExampleCo(inputs) {
  const items = [];
  const seen = new Set();
  const add = (item) => {
    const key = `${item.defect}|${item.action}`.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    items.push(item);
  };
  for (const row of inputs.escalations.rows) {
    add({
      defect: String(row.defect || row.cardId || 'ExampleCo'),
      cardId: String(row.cardId || ''),
      kind: String(row.kind || 'human-gated'),
      action: compactText(row.action, 300) || 'no action command recorded',
      evidence: compactText(row.evidence, 240),
    });
  }
  for (const row of inputs.selfHeal.rows) {
    const perDefect = Array.isArray(row.perDefect) ? row.perDefect : [];
    for (const outcome of perDefect) {
      if (outcome && outcome.outcome === 'escalated_to_human') {
        add({
          defect: String(outcome.defect || outcome.cardId || 'ExampleCo'),
          cardId: String(outcome.cardId || ''),
          kind: 'escalated_to_human',
          action: compactText(outcome.action, 300) || 'no action command recorded',
          evidence: compactText(outcome.reason, 240),
        });
      }
    }
  }
  return items;
}

function healerJudgments(selfHealRows) {
  const out = [];
  const seen = new Set();
  for (const row of selfHealRows) {
    for (const text of [row.repairLoopJudgment, row.judgment, row.verdictReason]) {
      const clean = compactText(text, 400);
      if (!clean || seen.has(clean)) continue;
      seen.add(clean);
      out.push(clean);
    }
  }
  return out;
}

function buildWatchReportModel({ date, nowMs = Date.now(), inputs } = {}) {
  const window = inputs.window || nightWindow({ date, nowMs });
  const passes = inputs.selfHeal.rows.filter((row) => row.stage === 'orchestrator-complete');
  const verdicts = inputs.selfHeal.rows
    .filter((row) => row.verdict)
    .map((row) => ({
      verdict: String(row.verdict),
      reason: compactText(row.verdictReason, 300),
      summary: summarizeOutcome(row.outcomeSummary),
    }));
  const green = greenCountLine(inputs.board);
  const engineering = {
    candidateFixes: repeatedFailedTactics(inputs.repairAttempts),
    headroom: watchdogKills(inputs.selfHeal.rows),
    deployDrift: inputs.deploys.rows
      .filter(
        (row) => row.matchesOriginMaster === false || (row.relation && row.relation !== 'equal'),
      )
      .map((row) => ({
        at: rowTsMs(row),
        relation: String(row.relation || 'ExampleCo'),
        matchesOriginMaster: row.matchesOriginMaster !== false,
      })),
    landGateRed: inputs.landGate && inputs.landGate.status === 'red' ? inputs.landGate : null,
  };
  const healing = {
    needs: needsFromExampleCo(inputs),
    judgments: healerJudgments(inputs.selfHeal.rows),
    verdicts,
  };
  return {
    schemaVersion: 1,
    date: window.date,
    priorDate: previousDateKey(window.date),
    windowStartMs: window.startMs,
    windowEndMs: window.endMs,
    generatedAtMs: nowMs,
    sources: {
      selfHealRuns: { present: inputs.selfHeal.present, rows: inputs.selfHeal.rows.length },
      repairLedger: { present: inputs.repairLedgerPresent, rows: inputs.repairAttempts.length },
      escalations: { present: inputs.escalations.present, rows: inputs.escalations.rows.length },
      enhancements: { present: inputs.enhancements.present, rows: inputs.enhancements.rows.length },
      deployReceipts: { present: inputs.deploys.present, rows: inputs.deploys.rows.length },
      landGate: { present: !!inputs.landGate, rows: inputs.landGate ? 1 : 0 },
      liveBoard: {
        present: !!(inputs.board && inputs.board.artifact),
        stale: !!(inputs.board && inputs.board.stale),
      },
    },
    green,
    timeline: buildTimeline(inputs),
    passes: passes.map((row) => ({
      pass: row.pass != null ? row.pass : null,
      cleared: Number(row.cleared) || 0,
      escalated: Number(row.escalated) || 0,
      at: rowTsMs(row),
    })),
    engineering,
    healing,
  };
}

// ---------------------------------------------------------------------------
// Render: dev-plans-style dark/light HTML; every face string goes through
// ctFaceTime BEFORE escaping so no embedded raw ISO-Z survives to the face.
// ---------------------------------------------------------------------------

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function face(value) {
  return escapeHtml(ctFaceTime(value));
}

function faceTime(ms) {
  return escapeHtml(ctTimeLabel(ms) || 'ExampleCo time');
}

function noReceipts(text) {
  return `<p class="src">No receipts: ${escapeHtml(text)}</p>`;
}

function renderWatchReportHtml(model) {
  const timelineRows = model.timeline
    .map((event) => `<tr><td>${faceTime(event.tsMs)}</td><td>${face(event.label)}</td></tr>`)
    .join('\n');
  const timelineHtml = model.timeline.length
    ? `<div class="tablewrap"><table><tr><th>When (CT)</th><th>Event</th></tr>\n${timelineRows}\n</table></div>`
    : noReceipts(
        'no timestamped receipts landed in this night window, so there is no timeline to show.',
      );

  const passesHtml = model.passes.length
    ? `<p>${escapeHtml(
        `${model.passes.length} orchestrator pass(es) completed: ` +
          model.passes
            .map(
              (p) =>
                `pass ${p.pass != null ? p.pass : '?'} (cleared ${p.cleared}, escalated ${p.escalated})`,
            )
            .join(', ') +
          '.',
      )}</p>`
    : noReceipts('no completed self-heal orchestrator passes were recorded in the window.');

  const fixItems = model.engineering.candidateFixes
    .map(
      (item) =>
        `<li><strong>Candidate pipeline fix:</strong> ${face(item.defect)}: tactic &quot;${face(
          item.tactic,
        )}&quot; failed ${item.attempts} times with no clear (latest QC: ${face(
          item.lastQcResult,
        )}).${item.lastReflection ? ` Latest reflection: ${face(item.lastReflection)}` : ''} A repair the healer keeps re-running is a missing pipeline guarantee; engineer it out of the repair loop.</li>`,
    )
    .join('\n');
  const headroomItems = model.engineering.headroom
    .map(
      (item) =>
        `<li><strong>Headroom:</strong> ${face(item.what)} at ${faceTime(
          item.at,
        )}. A watchdog kill means the work unit outgrew its budget: raise the budget or shrink the unit.</li>`,
    )
    .join('\n');
  const deployItems = model.engineering.deployDrift
    .map(
      (item) =>
        `<li><strong>Deploy authority:</strong> deploy at ${faceTime(item.at)} recorded relation &quot;${face(
          item.relation,
        )}&quot;${item.matchesOriginMaster ? '' : ' and content that does not match origin/master'}. Only an equal, receipted deploy is a clean single-code-authority release.</li>`,
    )
    .join('\n');
  const landItem = model.engineering.landGateRed
    ? `<li><strong>Land gate red:</strong> the last land-gate run in the window was red on ${face(
        model.engineering.landGateRed.branch || 'ExampleCo branch',
      )}. The scoped suite is the land authority; fix it before the next land.</li>`
    : '';
  const engineeringList = [fixItems, headroomItems, deployItems, landItem]
    .filter(Boolean)
    .join('\n');
  const engineeringHtml = engineeringList
    ? `<ul>\n${engineeringList}\n</ul>`
    : noReceipts(
        'no repeated failed tactics, watchdog kills, deploy drift, or red land gates appeared in this night window.',
      );

  const needItems = model.healing.needs
    .map(
      (item) =>
        `<li><strong>Needs ExampleCo</strong> (${face(item.kind)}): ${face(item.defect)}. Action: <code>${face(
          item.action,
        )}</code>${item.evidence ? ` <span class="src">Evidence: ${face(item.evidence)}</span>` : ''}</li>`,
    )
    .join('\n');
  const verdictItems = model.healing.verdicts
    .map(
      (item) =>
        `<li><strong>Healer verdict:</strong> ${face(item.verdict)}${
          item.summary ? ` (${face(item.summary)})` : ''
        }${item.reason ? `: ${face(item.reason)}` : ''}</li>`,
    )
    .join('\n');
  const judgmentItems = model.healing.judgments
    .map((text) => `<li><strong>Recorded judgment:</strong> ${face(text)}</li>`)
    .join('\n');
  const healingList = [needItems, verdictItems, judgmentItems].filter(Boolean).join('\n');
  const healingHtml = healingList
    ? `<ul>\n${healingList}\n</ul>`
    : noReceipts(
        'no healer escalations, verdicts, or judgments were recorded in this night window.',
      );

  const sourceRows = Object.entries(model.sources)
    .map(
      ([name, info]) =>
        `<tr><td><code>${escapeHtml(name)}</code></td><td>${info.present ? 'present' : 'absent'}</td><td>${
          Number.isFinite(info.rows) ? info.rows : info.stale ? 'stale' : ''
        }</td></tr>`,
    )
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Overnight Watch Report: night of ${escapeHtml(model.priorDate)} to ${escapeHtml(model.date)}</title>
<style>
  :root { --bg:#0f1115; --panel:#171a21; --ink:#e8eaf0; --dim:#9aa3b2; --acc:#5eead4; --warn:#fbbf24; --bad:#f87171; --good:#4ade80; --line:#2a2f3a; }
  @media (prefers-color-scheme: light) { :root { --bg:#f7f8fa; --panel:#ffffff; --ink:#1a2029; --dim:#5b6472; --acc:#0f766e; --warn:#b45309; --bad:#b91c1c; --good:#15803d; --line:#dde2ea; } }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:15.5px/1.65 "Segoe UI",system-ui,sans-serif; }
  .wrap { max-width:940px; margin:0 auto; padding:32px 20px 80px; }
  h1 { font-size:25px; margin:0 0 4px; }
  h2 { font-size:19px; margin:40px 0 12px; color:var(--acc); border-bottom:1px solid var(--line); padding-bottom:6px; }
  .meta { color:var(--dim); font-size:13px; margin-bottom:24px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:16px 18px; margin:14px 0; }
  .tldr { border-left:4px solid var(--acc); }
  table { border-collapse:collapse; width:100%; margin:12px 0; font-size:13.5px; }
  th,td { border:1px solid var(--line); padding:7px 9px; text-align:left; vertical-align:top; }
  th { background:rgba(94,234,212,.07); }
  .tablewrap { overflow-x:auto; }
  code { background:rgba(94,234,212,.09); padding:1px 5px; border-radius:4px; font-size:12.5px; overflow-wrap:anywhere; }
  ul { margin:6px 0 6px 22px; padding:0; }
  li { margin:6px 0; }
  .src { font-size:12.5px; color:var(--dim); }
</style>
</head>
<body>
<div class="wrap">

<h1>Overnight Watch Report</h1>
<div class="meta">Night of ${escapeHtml(model.priorDate)} to ${escapeHtml(model.date)} &middot; Window ${faceTime(
    model.windowStartMs,
  )} to ${faceTime(model.windowEndMs)} &middot; Rendered ${faceTime(model.generatedAtMs)} &middot; All times CT</div>

<div class="card tldr">
<strong>Ledger-assembled report.</strong> This page was assembled mechanically from the night's durable receipts
(self-heal runs, the per-defect repair ledger, escalations, enhancements, deploy and land receipts, the canonical
live board). No LLM was involved in the assembly, so it cannot block on auth or budget. A live watcher session adds
judgment on top when present; this drop never depends on one.
<p><strong>Live board:</strong> ${face(model.green.line)}</p>
</div>

<h2>1. What happened overnight</h2>
${passesHtml}
${timelineHtml}

<h2>2. Engineering pipeline recommendations</h2>
${engineeringHtml}

<h2>3. Agentic healing recommendations</h2>
${healingHtml}

<h2>Sources</h2>
<div class="tablewrap"><table><tr><th>Receipt family</th><th>State</th><th>Rows in window</th></tr>
${sourceRows}
</table></div>

</div>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Write + CLI
// ---------------------------------------------------------------------------

function watchReportPath(dataDir, date) {
  return path.join(dataDir, 'briefings', `watch-report-${String(date).slice(0, 10)}.html`);
}

function watchReportLatestPath(dataDir) {
  return path.join(dataDir, 'briefings', 'watch-report-latest.html');
}

function writeHtmlAtomic(file, html) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, html, 'utf8');
  fs.renameSync(tmp, file);
}

function writeWatchReport({ date, dataDir, out, repo, nowMs = Date.now() } = {}) {
  if (!dataDir) throw new Error('dataDir is required');
  const day = String(date || ctDateKey(nowMs)).slice(0, 10);
  const inputs = collectNightInputs({ date: day, dataDir, repo, nowMs });
  const model = buildWatchReportModel({ date: day, nowMs, inputs });
  const html = renderWatchReportHtml(model);
  const file = out ? path.resolve(out) : watchReportPath(dataDir, day);
  writeHtmlAtomic(file, html);
  // Stable alias beside the dated file so consumers can always link "latest".
  const alias = path.join(path.dirname(file), 'watch-report-latest.html');
  writeHtmlAtomic(alias, html);
  return { path: file, aliasPath: alias, model };
}

function argValue(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  const hit = process.argv.find((arg) => arg.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : fallback;
}

function main() {
  const dataDir = argValue(
    '--data-dir',
    process.env.SECONDBRAIN_DATA_DIR || '/opt/secondbrain/data',
  );
  const date = argValue('--date', process.env.BRIEFING_DATE || ctDateKey());
  const out = argValue('--out', null);
  const result = writeWatchReport({ date, dataDir, out });
  console.log(
    `[overnight-watch-report] wrote ${result.path} (alias ${result.aliasPath}); ` +
      `${result.model.timeline.length} timeline event(s), ` +
      `${result.model.engineering.candidateFixes.length} candidate fix(es), ` +
      `${result.model.healing.needs.length} needs-ExampleCo item(s).`,
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[overnight-watch-report] failed: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  ctDateKey,
  previousDateKey,
  ctWallTimeToEpochMs,
  nightWindow,
  readJsonlRows,
  collectNightInputs,
  buildWatchReportModel,
  renderWatchReportHtml,
  watchReportPath,
  watchReportLatestPath,
  writeWatchReport,
};
