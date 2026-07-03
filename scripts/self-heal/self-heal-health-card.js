'use strict';

// scripts/self-heal/self-heal-health-card.js
//
// PHASE 4b, item 1: the DAILY SELF-HEAL HEALTH CARD.
//
// A standalone briefing card so ExampleCo sees self-heal status WITHOUT opening logs.
// It reads two Phase 4a sources and nothing else:
//   1. the per-defect REPAIR LEDGER (scripts/self-heal/briefing-repair-ledger.js:
//      openDefects / attemptsForDefect / attemptRows) for attempted / cleared /
//      escalated counts and how fresh the ledger itself is, and
//   2. the EXECUTOR-HEALTH row (scripts/lib/executor-health-row.js) for the single
//      "can the self-heal executor run?" signal, sourced from the overnight
//      orchestrator's run-log (data/agent/overnight-self-heal-runs.jsonl) where the
//      pre-spawn auth preflight already persists exactly ONE executor row.
//
// Output is executive-crisp: a one-line FACE ("3 attempted, 2 cleared, 1
// escalated; executor healthy; ledger fresh") plus a DRILLDOWN detail (one line per
// open/escalated defect with its tried tactics, the executor runbook only when the
// executor is red). NO log-speak: no jsonl paths, no stage names, no PM2/session ids
// in the face copy.
//
// This module is the card's OWNING GENERATOR (one owner per card, Phase 3): it is
// declared as self_heal_health.owner in dev-plans/_domains.json and resolves to
// generateSelfHealHealthCard. It is pure + injectable (opts.dataDir, opts.date,
// opts.preflight, opts.executorRow, opts.nowMs) so tests never touch real run logs.

const fs = require('node:fs');
const path = require('node:path');

const ledger = require('./briefing-repair-ledger.js');
const { executorHealthRow } = require('../lib/executor-health-row.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FRESHNESS_MAX_AGE_HOURS = 24;

// The run log the overnight orchestrator appends to (appendRunLog -> RUNS_LOG_PATH).
// EC2-first so the card reads the always-on heal loop's log; falls back to desktop
// then repo, mirroring briefing-repair-ledger.defaultDataDir.
function runLogPath(opts = {}) {
  return path.join(
    opts.dataDir || ledger.defaultDataDir(),
    'agent',
    'overnight-self-heal-runs.jsonl',
  );
}

function readRunLogRows(opts = {}) {
  const p = opts.runLogPath || runLogPath(opts);
  if (!fs.existsSync(p)) return [];
  const out = [];
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // a corrupt line is skipped, never fatal: a health CARD must never crash the build
    }
  }
  return out;
}

// The stage name the orchestrator writes at the START and END of every pass
// (scripts/overnight-self-heal-orchestrator.js: CHECKPOINT_STAGE), regardless of
// whether the pass found any blockers. Its presence is the proof the executor process
// actually launched and ran this window; its absence is the ONLY honest reason to say
// "ExampleCo".
const CHECKPOINT_STAGE = 'self-heal-checkpoint';

// The single executor-health row. Preference order:
//   1. an explicitly injected built row (opts.executorRow) -- tests + a live caller
//      that already built it from the live preflight,
//   2. an injected preflight result (opts.preflight) -> executorHealthRow(),
//   3. the newest executor row persisted in the run log (the orchestrator logs a
//      stage:'system-health-row' source:'executor-health' row on auth failure and a
//      stage:'self-heal-health' row that ExampleCos executorHealthRow on red),
//   4. the newest COMPLETED self-heal-checkpoint row (written at the end of every
//      pass, success or failure, ROOT FIX self-heal-why-report 2026-07-02): green ->
//      healthy, red -> cannot run with the checkpoint's own plain-English crash reason.
//   5. when nothing at all is recorded, "ExampleCo" is now honest: the process itself
//      never wrote a start-of-pass checkpoint, so it genuinely never ran.
function resolveExecutorRow(rows, opts = {}) {
  if (opts.executorRow && opts.executorRow.label && opts.executorRow.status) {
    return opts.executorRow;
  }
  if (opts.preflight) return executorHealthRow(opts.preflight, opts.executorHealthSignals || {});
  // newest persisted executor row, newest-first
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const r = rows[i];
    if (!r) continue;
    if (r.executorHealthRow && r.executorHealthRow.label && r.executorHealthRow.status) {
      return r.executorHealthRow;
    }
    if (r.stage === 'system-health-row' && r.source === 'executor-health' && r.label) {
      return { label: r.label, status: r.status, detail: r.detail || '', runbook: r.runbook || '' };
    }
  }
  // newest COMPLETED checkpoint the orchestrator wrote for a pass (any outcome).
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const r = rows[i];
    if (r && r.stage === CHECKPOINT_STAGE && r.phase === 'completed') {
      if (String(r.status || '').toLowerCase() === 'red') {
        return {
          label: 'Self-Heal Executor',
          status: 'red',
          detail: clamp(r.crash || 'the last pass ended in a crash with no reason recorded.', 240),
          runbook:
            'Runbook: read the crash reason above, fix it, then re-run the overnight self-heal orchestrator.',
        };
      }
      return executorHealthRow({}); // a green/completed checkpoint proves the pass ran -> healthy
    }
  }
  // legacy fallback: an older self-heal-health row with no checkpoint (pre-fix log data).
  let checkpoint = null;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i] && rows[i].stage === 'self-heal-health') {
      checkpoint = rows[i];
      break;
    }
  }
  if (checkpoint && String(checkpoint.status || '').toLowerCase() === 'green') {
    return executorHealthRow({}); // a green checkpoint means a successful run -> healthy
  }
  return {
    label: 'Self-Heal Executor',
    status: 'ExampleCo',
    detail: 'the self-heal process has not recorded a run this window.',
    runbook:
      'Runbook: run the overnight self-heal orchestrator so it records a start-of-pass checkpoint.',
  };
}

// Newest timestamp across ledger attempt rows + run-log rows = how fresh the
// self-heal signal is. Returns { ageHours, newestTs } or { ageHours:null } when
// nothing has ever been recorded.
function signalFreshness(attempts, rows, nowMs) {
  let newest = null;
  const consider = (ts) => {
    const t = ts ? Date.parse(ts) : NaN;
    if (Number.isFinite(t)) newest = newest == null ? t : Math.max(newest, t);
  };
  for (const a of attempts) consider(a && a.ts);
  for (const r of rows) consider(r && r.ts);
  if (newest == null) return { ageHours: null, newestTs: null };
  return { ageHours: (nowMs - newest) / 3.6e6, newestTs: new Date(newest).toISOString() };
}

// Distinct-defect counts from the per-defect ledger:
//   attempted = distinct defects with >= 1 attempt row today
//   cleared   = distinct defects whose LATEST attempt cleared
//   escalated = distinct defects still OPEN (latest attempt did not clear) ==
//               openDefects(date).length, so the card matches the Blockers card.
function defectCounts(date, opts = {}) {
  const attempts = ledger.attemptRows(date, opts);
  const byDefect = new Map();
  for (const row of attempts) {
    const key = ledger.normDefectKey(row.defect);
    const list = byDefect.get(key) || [];
    list.push(row);
    byDefect.set(key, list);
  }
  let cleared = 0;
  for (const list of byDefect.values()) {
    if (ledger.isClearedRow(list[list.length - 1])) cleared += 1;
  }
  const open = ledger.openDefects(date, opts);
  return {
    attempted: byDefect.size,
    cleared,
    escalated: open.length,
    open,
    totalAttempts: attempts.length,
    attempts,
  };
}

// THRASH DETECTION (genuinely stuck). A defect is THRASHING when the SAME tactic +
// SAME input hash FAILED two or more times with NO clearing attempt in between, i.e.
// the healer kept replaying an identical move with no changed input. This is the
// "no repeat without changed input" violation surfaced as a health signal: a healer
// that re-runs the exact failed move is stuck, not merely degraded. We walk each
// defect's attempts in append order, resetting the per-(tactic,input) failure memory
// on any clear, and count a defect as thrashing the moment one move fails twice.
// Returns the list of thrashing defect keys (canonical, deduped).
function thrashingDefects(date, opts = {}) {
  const attempts = ledger.attemptRows(date, opts);
  const byDefect = new Map();
  for (const row of attempts) {
    const key = ledger.normDefectKey(row.defect);
    const list = byDefect.get(key) || [];
    list.push(row);
    byDefect.set(key, list);
  }
  const thrashing = [];
  for (const [key, rows] of byDefect.entries()) {
    const failsByMove = new Map(); // "tacticKey inputHash" -> fail count since last clear
    let isThrash = false;
    for (const row of rows) {
      if (ledger.isClearedRow(row)) {
        failsByMove.clear(); // a clear resets the no-repeat memory
        continue;
      }
      const moveKey = `${row.tacticKey || ''} ${row.tacticInputHash || ''}`;
      const n = (failsByMove.get(moveKey) || 0) + 1;
      failsByMove.set(moveKey, n);
      if (n >= 2) {
        isThrash = true;
        break;
      }
    }
    if (isThrash) thrashing.push(key);
  }
  return thrashing;
}

// MASKING GUARD (ITEM W2a, 2026-07-03): a defect the MECHANICAL tier keeps
// clearing every single day is not the same as a healthy subsystem -- it can
// mean the same root cause keeps recurring and getting silently papered over.
// scripts/self-heal/mechanical-recurrence.js records one row per (date,
// defect) with clearedByMechanicalTactic; recurrenceEscalation flags a defect
// mechanically cleared 3+ CONSECUTIVE days through `date`. This card is the
// SELF-HEAL card the ITEM W2a spec names as where that escalation must
// surface, so a human sees the recurring pattern even though the mechanical
// tier "worked" again today. Pure + injectable (opts.mechanicalRecurrence,
// opts.mechanicalRecurrenceOpts) so tests never touch the real recurrence log.
function maskingGuardDefects(date, opts = {}) {
  const recurrence = opts.mechanicalRecurrence || require('./mechanical-recurrence.js');
  let history;
  try {
    history = recurrence.readHistory(opts.mechanicalRecurrenceOpts || {});
  } catch {
    return []; // a missing/corrupt recurrence log must never break the health card
  }
  const defectKeys = [...new Set(history.map((r) => r && r.defect).filter(Boolean))];
  const out = [];
  for (const key of defectKeys) {
    const result = recurrence.recurrenceEscalation(key, history, { asOfDate: date });
    if (result.escalate)
      out.push({ defect: key, consecutiveDays: result.consecutiveDays, reason: result.reason });
  }
  return out;
}

// AUTHORITATIVE RED / YELLOW / GREEN VERDICT (ExampleCo, 2026-06-30).
//
// Red is reserved for GENUINELY broken/blocked/stuck. A self-heal that actually ran,
// attempted every defect, and escalated them with honest reasons is WORKING (degraded)
// -> YELLOW, not RED. This card's OWN renderer is the authoritative place this verdict
// lives (exempt from "workers must not demote red cards": this is the renderer ExampleCo
// ordered, not a worker gaming QC).
//
//   GREEN  : no defects, or every defect cleared (escalated === 0), executor not red,
//            ledger fresh. Nothing to surface.
//   RED    : genuinely stuck/broken. ANY of:
//              - the run did not happen / nothing was attempted while defects exist
//                (no signal = stale ledger with 0 attempts),
//              - the ledger is stale beyond its freshness floor,
//              - the executor is RED (crashed / cannot run -- NOT merely "ExampleCo"),
//              - the healer is thrashing the SAME tactic with no changed input.
//   YELLOW : the run executed and attempted defects but some escalated honestly
//            (attempted > 0, escalated > 0) AND the run is otherwise healthy (ledger
//            fresh, executor not red, no thrash). "executor status ExampleCo" alone,
//            when attempts were recorded and the ledger is fresh, is YELLOW: it ran.
//            A masking-guard hit (a defect mechanically cleared 3+ consecutive days)
//            is ALSO yellow when nothing else is red: the mechanical fix genuinely
//            worked again today, but the recurrence is worth a human look, not a
//            "broken" verdict.
//
// Inputs are already-computed primitives so the verdict is pure and unit-testable.
function severityVerdict({
  attempted,
  escalated,
  ledgerStale,
  executorRed,
  thrashing,
  maskingGuard,
}) {
  // RED first: any genuinely-stuck condition wins regardless of escalated count.
  if (ledgerStale) return 'red'; // no run recorded, or signal older than the floor
  if (executorRed) return 'red'; // executor crashed / cannot run
  if (thrashing) return 'red'; // same move, no changed input -> stuck loop
  // GREEN: nothing still escalated, no masking-guard hit, and no stuck condition above.
  if (escalated <= 0) return maskingGuard ? 'yellow' : 'green';
  // From here escalated > 0 and the run is otherwise healthy (fresh ledger, executor
  // not red, no thrash). If attempts were recorded, the run executed and honestly
  // escalated -> degraded, not broken.
  if (attempted > 0) return 'yellow';
  // escalated > 0 but NOTHING was attempted: the defects exist yet no repair ran this
  // window. That is "the run did not happen for these" -> genuinely stuck, RED.
  return 'red';
}

function clamp(text, n = 200) {
  return String(text == null ? '' : text).slice(0, n);
}

// EXEC LANGUAGE (ExampleCo, 2026-07-01): the drilldown must read like an executive
// briefing, not the healer's internals. A ledger defect key looks like
// "live render qc system-health on system_health" (a humanized defect type + " on "
// + the raw card_id). The only part ExampleCo cares about is WHICH card/subsystem, so we
// pull the card_id (after " on "), fall back to the whole string, and title-case it
// into a readable name. No "healer / generator / renderer / QC / live render qc /
// tactic" tokens ever reach the card face or drilldown.
function cardNameFromDefectKey(defectKey) {
  const raw = String(defectKey == null ? '' : defectKey).trim();
  // "<defect type> on <card_id>" -> card_id; else "<card_id>:<TYPE>" -> card_id; else raw.
  let id = '';
  const onMatch = raw.match(/\bon\s+([a-z0-9_]+)\s*$/i);
  if (onMatch) id = onMatch[1];
  else if (raw.includes(':')) id = raw.split(':')[0];
  else id = raw;
  id = id.trim();
  if (!id) return 'a dashboard card';
  return id
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

// WHY IT FAILED (self-heal-why-report, 2026-07-02): the ledger's `reflection` field is
// the healer's own internal shorthand (heal-executor.js's watchdog / contract-miss
// reasons), never ExampleCo-facing English on its own. This translates the known reflection
// shapes into a plain clause; an unrecognized reflection still degrades to a short,
// honest paraphrase instead of leaking the raw jargon string verbatim.
function reflectionToPlainEnglish(reflection) {
  const text = String(reflection == null ? '' : reflection).trim();
  if (!text) return 'no reason was recorded for the failure';
  // "<executor> exceeded budget <n>s" (heal-executor.js DEFAULT_BUDGET_MS timeout)
  let m = text.match(/exceeded budget\s+(\d+)s/i);
  if (m) {
    const minutes = Math.round(Number(m[1]) / 60);
    return `it ran out of its ${minutes}-minute time window before finishing`;
  }
  // "<executor> produced no output for <n>s (hang)" / "... (idle hang)"
  m = text.match(/no output for\s+(\d+)s.*hang/i);
  if (m) return 'the repair worker stopped responding and had to be stopped';
  // "<executor> CLI exited with code <n>"
  if (/CLI exited with code/i.test(text)) return 'the repair worker crashed before finishing';
  // "<executor> started a nested background task ..." (worker-guard block)
  if (/nested background task/i.test(text)) {
    return 'the repair worker tried a disallowed background step and was blocked';
  }
  // "no JSON status block in output" / "empty CLI output" / "no result block ..."
  if (/no JSON status block|empty CLI output|no result block/i.test(text)) {
    return 'the repair worker finished without reporting a clear result';
  }
  // "tactic exhausted: ... not repeating the same move."
  if (/tactic exhausted/i.test(text)) {
    return 'every approach it knew to try has already failed once, so it stopped repeating itself';
  }
  // session self-reported escalation reasons (needs ExampleCo, credential, approval, etc.)
  if (/\b(ExampleCo|credential|password|api[\s-]?key|approve|approval|decision|decide)\b/i.test(text)) {
    return `it needs a decision only ExampleCo can make (${clamp(text, 140)})`;
  }
  // spawn-level failure
  if (/spawn threw/i.test(text)) return 'the repair worker could not be started';
  // fallback: no known shape, but never leak raw jargon unexplained. Paraphrase honestly.
  return `it tried and failed, with this note from the run: ${clamp(text, 140)}`;
}

// One plain-English drilldown line per still-open defect: which card the auto-repair
// could not fix, WHAT it tried, WHY that failed, and what would unblock it. No jargon.
function execOpenDefectLine(index, defect) {
  const name = cardNameFromDefectKey(defect.defect);
  const tries = Number(defect.attempts) || 1;
  const timesWord = tries === 1 ? 'once' : `${tries} times`;
  const reflection = defect.lastReflection || '';
  const why = reflectionToPlainEnglish(reflection);
  // The ledger's own "tactic exhausted" reflection is a signal no untried move remains
  // for this defect (briefing-repair-ledger.tacticExhaustedReason); every other reason
  // (timeout, hang, crash, missing decision) leaves room to try again next pass.
  const exhausted = /tactic exhausted/i.test(reflection);
  const unblock = exhausted
    ? 'it has run out of approaches to try on its own and needs ExampleCo to look at it'
    : 'it will try a different approach on the next run';
  return `${index}. ${name} card: the auto-repair tried ${timesWord} this pass, but ${why}. It stays flagged; ${unblock}.`;
}

// EXPLAIN THE COLOR (ExampleCo, 2026-07-01): never show a color without a reason. This
// derives ONE plain exec sentence from the card's own state, the same way RED already
// justified itself, so a YELLOW tile always says WHY it is yellow. Plain English only:
// no healer / generator / renderer / QC / tactic tokens.
function severityReason({
  severity,
  attempted,
  cleared,
  escalated,
  ledgerStale,
  ledgerAgeHours,
  executorRed,
  thrashing,
  maskingGuard,
}) {
  if (severity === 'green') {
    return escalated > 0 || attempted > 0
      ? `Green: the auto-repair ran and fixed every issue it found (${cleared} fixed, none left open).`
      : 'Green: the auto-repair is clean, with no issues open and a fresh run on record.';
  }
  if (severity === 'yellow') {
    if (escalated <= 0 && maskingGuard && maskingGuard.length) {
      const n = maskingGuard.length;
      const issues = n === 1 ? 'issue' : 'issues';
      return `Yellow: the same-day mechanical fix cleared ${n} recurring ${issues} again today, but it has now recurred 3+ days in a row. Nothing is broken right now; the repeating pattern is worth ExampleCo looking at the root cause.`;
    }
    const issues = escalated === 1 ? 'issue' : 'issues';
    return `Yellow: the auto-repair ran and honestly escalated ${escalated} ${issues} it could not fix in its time budget this pass. It is working, not stuck; these carry to the next run.`;
  }
  // RED: name the single genuinely-stuck cause, most-severe first.
  if (executorRed) {
    return 'Red: the auto-repair cannot run at all right now, so nothing is being fixed until it is restored.';
  }
  if (ledgerStale) {
    return ledgerAgeHours == null
      ? 'Red: no self-heal run has completed, so nothing is being repaired. This is stuck, not degraded.'
      : `Red: the last self-heal run is ${Math.round(ledgerAgeHours)}h old, so nothing is being repaired right now. This is stuck, not degraded.`;
  }
  if (thrashing) {
    return 'Red: the auto-repair is repeating the same failed move with no change, so it is stuck and cannot make progress.';
  }
  if (escalated > 0 && attempted <= 0) {
    const issues = escalated === 1 ? 'issue' : 'issues';
    return `Red: ${escalated} ${issues} are open but the auto-repair did not run against them this window, so nothing was attempted.`;
  }
  return 'Red: the auto-repair is genuinely stuck and cannot make progress.';
}

// THE "Auto-repair engine:" LINE (self-heal-why-report, 2026-07-02, fix 3): plain
// English only, one of exactly three shapes, never the raw status token + jargon
// detail ExampleCo flagged ("ExampleCo: no executor health checkpoint recorded for this
// window"). Green states how many repairs it ran; red states it crashed with the
// plain-English reason already produced by resolveExecutorRow; ExampleCo honestly says
// the process never recorded a run, which after the checkpoint fix only happens when
// the healer genuinely did not launch this window.
function executorPlainEnglishLine(card) {
  const status = card.executor && card.executor.status;
  const attempted = Number(card.attempted || 0);
  if (status === 'green') {
    return attempted > 0
      ? `healthy, ran ${attempted} repair${attempted === 1 ? '' : 's'} this pass.`
      : 'healthy, checked for issues and found none this pass.';
  }
  if (status === 'red') {
    const detail = clamp(card.executor.detail, 200);
    return `crashed: ${detail || 'no reason was recorded.'}`;
  }
  return 'did not run this window: no start-of-pass record exists, so nothing was attempted.';
}

// Build the structured card record. Pure; no side effects.
function buildSelfHealHealthCard(opts = {}) {
  const date = ledger.safeDate
    ? ledger.safeDate(opts.date)
    : opts.date || new Date().toISOString().slice(0, 10);
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const counts = defectCounts(date, opts);
  const rows = readRunLogRows(opts);
  const executorRow = resolveExecutorRow(rows, opts);
  const fresh = signalFreshness(counts.attempts, rows, nowMs);
  const maxAgeHours = Number.isFinite(opts.maxAgeHours)
    ? opts.maxAgeHours
    : FRESHNESS_MAX_AGE_HOURS;
  // The ledger is STALE when no signal exists at all, or the newest signal is older
  // than the freshness floor. A stale ledger is itself a defect worth surfacing.
  const ledgerStale = fresh.ageHours == null || fresh.ageHours > maxAgeHours;
  const executorGreen = executorRow.status === 'green';
  const executorRed = executorRow.status === 'red';
  const thrashing = thrashingDefects(date, opts);
  const isThrashing = thrashing.length > 0;
  // ITEM W2a masking guard: a defect the mechanical tier keeps clearing 3+
  // consecutive days is worth a human look even though today's pass is clean.
  const maskingGuard = maskingGuardDefects(date, opts);

  // AUTHORITATIVE SEVERITY (ExampleCo, 2026-06-30): red = genuinely broken/blocked/stuck,
  // yellow = ran + honestly escalated (degraded but working), green = clean. See
  // severityVerdict for the full rule. The boolean `defect` is kept for backward
  // compatibility (the QC freshness gate, render glyph) and means "not green".
  const severity = severityVerdict({
    attempted: counts.attempted,
    escalated: counts.escalated,
    ledgerStale,
    executorRed,
    thrashing: isThrashing,
    maskingGuard: maskingGuard.length > 0,
  });
  const defect = severity !== 'green';

  const executorFace = executorGreen
    ? 'executor healthy'
    : executorRed
      ? 'executor cannot run'
      : 'executor status ExampleCo';
  const ledgerFace = ledgerStale
    ? fresh.ageHours == null
      ? 'no self-heal run recorded'
      : `ledger stale (${Math.round(fresh.ageHours)}h old)`
    : 'ledger fresh';
  const face = `${counts.attempted} attempted, ${counts.cleared} cleared, ${counts.escalated} escalated; ${executorFace}; ${ledgerFace}.`;

  // The one-sentence exec WHY for whatever color this is. Never a color without a
  // reason: yellow explains itself the same way red already did (ExampleCo, 2026-07-01).
  const reason = severityReason({
    severity,
    attempted: counts.attempted,
    cleared: counts.cleared,
    escalated: counts.escalated,
    ledgerStale,
    ledgerAgeHours: fresh.ageHours,
    executorRed,
    thrashing: isThrashing,
    maskingGuard,
  });

  // Drilldown rows: one per still-open/escalated defect, in PLAIN EXECUTIVE ENGLISH.
  // Which card the auto-repair could not fix, how many times it tried, what happens
  // next -- never a defect key, tactic string, jsonl path, or stage name.
  const openLines = counts.open.map((d, i) => ({
    index: i + 1,
    defect: d.defect,
    cardName: cardNameFromDefectKey(d.defect),
    attempts: d.attempts,
    lastResult: d.lastQcResult,
    triedTactics: (d.triedTactics || []).slice(0, 5),
    text: execOpenDefectLine(i + 1, d),
  }));

  return {
    cardId: 'self_heal_health',
    date,
    generatedAt: new Date(nowMs).toISOString(),
    attempted: counts.attempted,
    cleared: counts.cleared,
    escalated: counts.escalated,
    totalAttempts: counts.totalAttempts,
    executor: {
      label: executorRow.label,
      status: executorRow.status,
      detail: clamp(executorRow.detail, 240),
      runbook: executorRed ? clamp(executorRow.runbook, 400) : '',
    },
    freshness: {
      ageHours: fresh.ageHours == null ? null : Math.round(fresh.ageHours * 10) / 10,
      newestTs: fresh.newestTs,
      maxAgeHours,
      stale: ledgerStale,
    },
    thrashing,
    maskingGuard,
    severity,
    reason,
    defect,
    face,
    openDefects: openLines,
  };
}

// Render the card as a legacy "TITLE:\n\nbody" markdown section the briefing
// assembly + ec2-server.js render both consume. A leading status glyph keeps the
// row self-describing; the FACE is the one-line summary; the drilldown lists open
// defects and (only when red) the executor runbook. No log-speak.
const SELF_HEAL_HEALTH_TITLE = 'SELF-HEAL HEALTH';

function renderSelfHealHealthSection(opts = {}) {
  const card = opts.card || buildSelfHealHealthCard(opts);
  const severity = card.severity || (card.defect ? 'red' : 'green');
  // Glyph maps to the authoritative tri-state: check = green, bang = yellow
  // (ran + honestly escalated, degraded but working), cross = red (genuinely
  // stuck/broken). No em/en dashes anywhere. The explicit "Severity:" line below is
  // the machine-readable verdict the render seam reads (glyph is the human cue).
  const glyph = severity === 'green' ? '✓' : severity === 'yellow' ? '!' : '✗';
  const reason =
    card.reason ||
    severityReason({
      severity,
      attempted: card.attempted,
      cleared: card.cleared,
      escalated: card.escalated,
      ledgerStale: card.freshness && card.freshness.stale,
      ledgerAgeHours: card.freshness ? card.freshness.ageHours : null,
      executorRed: card.executor && card.executor.status === 'red',
      thrashing: !!(card.thrashing && card.thrashing.length),
      maskingGuard: card.maskingGuard,
    });
  const lines = [];
  lines.push(`${glyph} ${card.face}`);
  lines.push('');
  // WHY this color, in one plain exec sentence. Never a color without a reason.
  lines.push(`Why: ${reason}`);
  lines.push(`Severity: ${severity}`);
  lines.push(`Attempted: ${card.attempted}`);
  lines.push(`Cleared: ${card.cleared}`);
  lines.push(`Escalated: ${card.escalated}`);
  lines.push(`Executor: ${executorPlainEnglishLine(card)}`);
  if (card.executor.runbook) lines.push(`Executor next step: ${card.executor.runbook}`);
  lines.push(
    card.freshness.ageHours == null
      ? 'Ledger freshness: no self-heal run recorded yet.'
      : `Ledger freshness: newest signal ${card.freshness.ageHours}h old (floor ${card.freshness.maxAgeHours}h, ${
          card.freshness.stale ? 'STALE' : 'fresh'
        }).`,
  );
  if (card.thrashing && card.thrashing.length) {
    lines.push(
      `Stuck loop: ${card.thrashing.length} issue(s) had the same failed repair repeated with no change.`,
    );
  }
  if (card.maskingGuard && card.maskingGuard.length) {
    lines.push(
      `Recurring pattern: ${card.maskingGuard.length} issue(s) mechanically fixed again today but recurring 3+ days in a row. Worth ExampleCo looking at the root cause.`,
    );
  }
  if (card.openDefects.length) {
    lines.push('');
    lines.push('Open repair defects:');
    for (const d of card.openDefects) lines.push(`  ${d.text}`);
  }
  return `${SELF_HEAL_HEALTH_TITLE}:\n\n${lines.join('\n').trim()}`;
}

// The OWNING GENERATOR (Phase 3 one-owner-per-card seam). Resolvable + callable so
// verify-heal-ladder-refs.js / validateCardOwners pass. Writes a dated artifact so
// the freshness acceptance has a run-receipt, then returns the rendered section.
function generateSelfHealHealthCard(opts = {}) {
  const card = buildSelfHealHealthCard(opts);
  const section = renderSelfHealHealthSection({ card });
  if (opts.write !== false) {
    try {
      const outDir = path.join(
        opts.dataDir || ledger.defaultDataDir(),
        'agent',
        'self-heal-health',
      );
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(
        path.join(outDir, `${card.date}.json`),
        `${JSON.stringify(card, null, 2)}\n`,
      );
    } catch {
      // best-effort artifact: a read-only fs must not break the briefing build
    }
  }
  return { card, section };
}

module.exports = {
  SELF_HEAL_HEALTH_TITLE,
  FRESHNESS_MAX_AGE_HOURS,
  CHECKPOINT_STAGE,
  runLogPath,
  readRunLogRows,
  resolveExecutorRow,
  signalFreshness,
  defectCounts,
  thrashingDefects,
  maskingGuardDefects,
  severityVerdict,
  severityReason,
  cardNameFromDefectKey,
  reflectionToPlainEnglish,
  execOpenDefectLine,
  executorPlainEnglishLine,
  buildSelfHealHealthCard,
  renderSelfHealHealthSection,
  generateSelfHealHealthCard,
};

if (require.main === module) {
  const { section } = generateSelfHealHealthCard({});
  process.stdout.write(`${section}\n`);
}
