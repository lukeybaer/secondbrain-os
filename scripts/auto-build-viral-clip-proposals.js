#!/usr/bin/env node
'use strict';
// Build the day's clipping proposals without waiting for approval (The owner
// 2026-10-12: "let those completed videos show up in tomorrow's normal
// briefing card and let your new pipeline work like that too - these are the
// types of videos I want every day 7 of them"; cut to two on 2026-10-16 for
// source-proxy cost: "Reduce to two videos/day so it costs less"; raised to
// three on 2026-10-19: "make it three per day actually, not 2"). For each
// undecided proposal in tonight's and today's day file, up to 3 builds per CT
// calendar day across both files (counted by request time, so the two day
// files never add up to more than three in one day), this posts the same
// local approve request the dashboard's Approve button sends, so the build
// runs on the existing model-session standard and lands in the Video Approval
// Queue as pending_approval. Building is unattended; publishing is not: every
// upload still waits for the owner's approval in that queue.
//
// The day file is never written here (the dashboard route stays its only
// writer). A ledger beside the day files, on the durable data volume, records
// each request so the daily cap and the retry bound hold across cron runs and
// releases. A request only queues a model session, so each run also reads
// the spine task it created: a task that ended in failure is requested again,
// at most twice per proposal, when the day still has a free slot (every
// triggered build counts toward the cap). Nothing starts inside the
// 22:30 to 05:30 CT briefing night hold.
//
// Usage: node scripts/auto-build-viral-clip-proposals.js [--date YYYY-MM-DD]

const fs = require('fs');
const path = require('path');
const http = require('http');
const duplicateGuard = require('./lib/viral-clip-duplicate-guard.js');

const REPO = process.env.SECONDBRAIN_ROOT || path.resolve(__dirname, '..');
// The approve route reads day files from the data directory, which each
// release links to durable shared storage; SECONDBRAIN_DATA_DIR wins
// when set.
const DATA_DIR = process.env.SECONDBRAIN_DATA_DIR || path.join(REPO, 'data');
const OUT_DIR = path.join(DATA_DIR, 'agent', 'viral-tech-clips');
const TASKS_DIR = process.env.SECONDBRAIN_SPINE_TASKS_DIR || path.join(DATA_DIR, 'tasks');
const { SADIE_FORMATS, SADIE_SPLIT_OPEN, SADIE_TAKE_OPEN, SOURCE_CUT } = require('./lib/viral-clip-formats.js');
const DAILY_AUTO_BUILDS = 3;
const MAX_ATTEMPTS = 2;
// owner decision: "Sadie for two video proposals, the usual pipeline for
// one". owner decision: "we do two Sadie per day - one of them make it more
// of an original take ... So three formats now". The first two builds of a
// CT day open on Sadie, one of each Sadie format in this order (the split
// open, then the take open); the third is the usual source cut. A Moonshots
// long-form reservation takes a source-cut slot, never a Sadie slot, so a
// Moonshots day builds two Sadie Shorts and the highlights film.
const SADIE_DAILY_FORMATS = Object.freeze([SADIE_SPLIT_OPEN, SADIE_TAKE_OPEN]);
const SADIE_BUILDS_PER_DAY = SADIE_DAILY_FORMATS.length;
// The first daily Sadie format today has not spent, else the source cut.
function formatForSlot(sadieFormatsToday) {
  const spent = Array.isArray(sadieFormatsToday) ? sadieFormatsToday : [];
  // At most two Sadie builds a day whatever their formats (a day that spent
  // both slots on split opens before the take open landed gets its source cut).
  if (spent.length >= SADIE_BUILDS_PER_DAY) return SOURCE_CUT;
  return SADIE_DAILY_FORMATS.find((f) => !spent.includes(f)) || SOURCE_CUT;
}
const FAILED_TASK = new Set(['failed', 'error', 'timeout', 'dead-letter', 'dead_letter']);
const NIGHT_HOLD_START_MINUTE_CT = 22 * 60 + 30;
const NIGHT_HOLD_END_MINUTE_CT = 5 * 60 + 30;
// The standard starts with the 2026-10-12 night run's proposals; older
// undecided proposals stay for the owner to decide.
const FIRST_AUTO_BUILD_DATE = '2026-10-13';
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function ctDate(ms = Date.now()) {
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

function nextCalendarDate(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

function previousCalendarDate(ymd) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// owner decision: undecided proposals from yesterday's day file stay
// buildable. Before this, the window was today and tomorrow only, so a day
// file whose proposals were still unapproved at midnight CT (its cap spent
// on earlier builds, or the night hold) fell out of the window and the
// pipeline sat empty while three cut proposals waited. Yesterday's file
// matches the precut window, so every cut proposal has a build chance.
function candidateDays(nowMs = Date.now()) {
  const today = ctDate(nowMs);
  return [previousCalendarDate(today), today, nextCalendarDate(today)].filter((d) => d >= FIRST_AUTO_BUILD_DATE);
}

function inNightHold(nowMs = Date.now()) {
  const [h, m] = new Date(nowMs)
    .toLocaleTimeString('en-GB', { timeZone: 'America/Chicago', hour12: false })
    .split(':')
    .map(Number);
  const minute = (h % 24) * 60 + m;
  return minute >= NIGHT_HOLD_START_MINUTE_CT || minute < NIGHT_HOLD_END_MINUTE_CT;
}

function defaultReadTask(taskId, tasksDir = TASKS_DIR) {
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(String(taskId || ''))) return null;
  return readJson(path.join(tasksDir, `${taskId}.json`), null);
}

// A requested build counts toward the cap unless its spine task ended in
// failure. An unreadable task still counts: the cap fails closed.
function rowOutcome(row, readTask) {
  if (!row.ok) return 'failed';
  const task = row.taskId ? readTask(row.taskId) : null;
  return task && FAILED_TASK.has(String(task.status || '').toLowerCase()) ? 'failed' : 'built';
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// The CT day a ledger row was requested on (its `at` stamp, else its proposal date).
function requestDay(r) {
  return Number.isFinite(Date.parse(r && r.at)) ? ctDate(Date.parse(r.at)) : r && r.date;
}

// Codex 19ded1278880 (F9): a row whose approve response never arrived may
// still have queued the build, so it spends the day's slot like a built row.
function spentSlot(r) {
  return Boolean(r && (r.ok || r.lost));
}

function usedAutoBuildSlots({ outDir, nowMs = Date.now() } = {}) {
  const today = ctDate(nowMs);
  return readLedger(path.join(outDir, 'auto-build-ledger.jsonl')).filter((r) => spentSlot(r) && requestDay(r) === today).length;
}

function readLedger(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function postApprove({ id, date, format }, { url = 'http://127.0.0.1:3001/briefing/approve-viral-clip', timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ id, date, ...(format ? { format } : {}) });
    const req = http.request(
      url,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* keep null */
          }
          resolve({ status: res.statusCode, json, text: text.slice(0, 300) });
        });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('approve request timed out')));
    req.on('error', (err) => resolve({ status: 0, json: null, text: String(err.message || err) }));
    req.end(body);
  });
}

async function autoBuild({
  dates = candidateDays(),
  outDir = OUT_DIR,
  approve = postApprove,
  readTask = defaultReadTask,
  cap = DAILY_AUTO_BUILDS,
  nowMs = Date.now(),
  // owner decision: on the day a new Moonshots episode is queued, one of the
  // three approval-queue builds is its long-form highlights film.
  reservedSlots = () => require('./lib/moonshots-highlights.js').reservedSlotsFor(outDir, nowMs),
  // owner decision: the proposer's duplicate guard missed day files written
  // before it landed (Snowden came back). Building is the last stop before
  // the approval queue, so it re-checks every manifest video in any status.
  manifestRows = () => duplicateGuard.loadManifestRowsStrict(),
} = {}) {
  const ledgerPath = path.join(outDir, 'auto-build-ledger.jsonl');
  const ledger = readLedger(ledgerPath);
  const summary = {
    approved: [],
    skipped: [],
    failed: [],
    capped: [],
    duplicates: [],
    manifestUnavailable: [],
    held: false,
  };
  const appendHold = (row) => {
    fs.mkdirSync(outDir, { recursive: true });
    fs.appendFileSync(path.join(outDir, 'auto-build-holds.jsonl'), JSON.stringify(row) + '\n');
  };
  if (inNightHold(nowMs)) {
    summary.held = true;
    return summary;
  }
  // The cap is a hard ceiling on triggered builds per CT calendar day of the
  // request, across every day file: a build whose task later fails still
  // spent proxy bytes, so it keeps its slot and a retry waits for a free one.
  // A row without a readable time counts against its proposal date.
  const today = ctDate(nowMs);
  let built = ledger.filter((r) => spentSlot(r) && requestDay(r) === today).length;
  const sadieToday = ledger
    .filter((r) => spentSlot(r) && requestDay(r) === today && SADIE_FORMATS.includes(r.build_format))
    .map((r) => r.build_format);
  const held = Math.max(0, Number(reservedSlots()) || 0);
  if (held) summary.reserved = held;
  cap = Math.max(0, cap - held);
  const days = new Map();
  for (const date of dates) {
    if (!DATE_RE.test(date)) continue;
    const day = readJson(path.join(outDir, `${date}.json`), null);
    if (day && Array.isArray(day.proposals)) days.set(date, day);
  }
  // Proposals already decided (approved, built, rejected) in any loaded day
  // file; requests made in this run join it as they are sent.
  const decided = [...days.values()].flatMap((day) =>
    day.proposals.filter((p) => p && p.status && p.status !== 'unapproved'),
  );
  for (const [date, day] of days) {
    const rows = ledger.filter((r) => r.date === date);
    const outcomes = new Map(rows.map((r) => [r, rowOutcome(r, readTask)]));
    for (const proposal of day.proposals) {
      if (!proposal || !ID_RE.test(String(proposal.id || ''))) continue;
      const id = proposal.id;
      const mine = rows.filter((r) => r.id === id);
      const last = mine[mine.length - 1];
      // Untouched proposals only, plus a retry of our own build whose task
      // failed while nobody else touched the proposal (its build task is
      // still the one we created). Anything else is the owner's decision.
      const untouched = proposal.status === 'unapproved';
      const ourFailedBuild =
        proposal.status === 'approved' &&
        last &&
        last.ok &&
        last.taskId &&
        proposal.build_task_id === last.taskId &&
        outcomes.get(last) === 'failed';
      if (!untouched && !ourFailedBuild) continue;
      if (mine.some((r) => outcomes.get(r) === 'built')) {
        summary.skipped.push(id);
        continue;
      }
      if (mine.length >= MAX_ATTEMPTS) {
        summary.skipped.push(id);
        continue;
      }
      if (built >= cap) {
        summary.capped.push(id);
        continue;
      }
      // Re-read the manifest before every request (a builder can add a row
      // mid-run) and compare it plus every proposal already decided or
      // requested, so two duplicates in one run cannot both queue. Retries
      // are checked too. An unreadable manifest holds the build without
      // spending a slot or an attempt (Codex 3a24fe3ac6d1). The 60-second
      // near-range rule is the proposer's editorial rule (133fc7506); a
      // skipped proposal stays on the card for the owner to approve by hand.
      // Release-time checks use no near window, and a true overlap or the
      // same claim asks him to confirm the allow_duplicate override.
      const manifest = manifestRows();
      if (!Array.isArray(manifest)) {
        summary.manifestUnavailable.push({ id, date });
        appendHold({ at: new Date(nowMs).toISOString(), date, id, reason: 'approval manifest unreadable' });
        continue;
      }
      const duplicate = duplicateGuard.findDuplicateClip(
        proposal,
        [...manifest, ...decided].filter((row) => row && row.id !== id),
      );
      if (duplicate) {
        summary.duplicates.push({ id, date, reason: duplicate.reason, matchedId: duplicate.matchedId });
        continue;
      }
      // Reserve the identity before sending: a lost response may still have
      // queued the build (Codex 6c684659c16f).
      decided.push(proposal);
      const format = formatForSlot(sadieToday);
      const res = await approve({ id, date, format });
      const ok = Boolean(res && res.json && res.json.ok && res.json.buildTriggered);
      // No HTTP status and no body: the request left but its answer never
      // came back, so the endpoint may have queued the build (Codex 19ded1278880 F9).
      const lost = !ok && Boolean(res) && Number(res.status) === 0 && !res.json;
      const row = {
        at: new Date(nowMs).toISOString(),
        date,
        id,
        ok,
        ...(lost ? { lost: true } : {}),
        build_format: format,
        taskId: (res && res.json && res.json.buildTaskId) || null,
        ...(ok ? {} : { error: String((res && ((res.json && res.json.error) || res.text)) || 'no response').slice(0, 300) }),
      };
      fs.mkdirSync(outDir, { recursive: true });
      fs.appendFileSync(ledgerPath, JSON.stringify(row) + '\n');
      rows.push(row);
      outcomes.set(row, ok ? 'built' : 'failed');
      if (ok || lost) {
        built += 1;
        if (SADIE_FORMATS.includes(format)) sadieToday.push(format);
      }
      if (ok) {
        summary.approved.push({ id, date, taskId: row.taskId, build_format: format });
      } else {
        summary.failed.push({ id, date, error: row.error, ...(lost ? { lost: true } : {}) });
      }
    }
  }
  return summary;
}

if (require.main === module) {
  const i = process.argv.indexOf('--date');
  const dates = i > 0 ? [process.argv[i + 1]] : candidateDays();
  autoBuild({ dates })
    .then((summary) => {
      console.log(JSON.stringify({ at: new Date().toISOString(), ...summary }));
      process.exit(summary.failed.length && !summary.approved.length ? 1 : 0);
    })
    .catch((err) => {
      console.error('[auto-build-viral] fatal:', err && err.message);
      process.exit(1);
    });
}

module.exports = {
  autoBuild,
  candidateDays,
  inNightHold,
  postApprove,
  formatForSlot,
  usedAutoBuildSlots,
  DAILY_AUTO_BUILDS,
  SADIE_BUILDS_PER_DAY,
  SADIE_DAILY_FORMATS,
  FIRST_AUTO_BUILD_DATE,
};
