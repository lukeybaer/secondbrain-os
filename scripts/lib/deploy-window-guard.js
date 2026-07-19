#!/usr/bin/env node
/**
 * deploy-window-guard.js -- refuse an atomic /opt swap under a scheduled runner.
 *
 * WHY (2026-07-19): a deploy's atomic symlink swap landed 84 seconds after the
 * 5:30:00 morning-briefing cron started, orphaning the just-started runner's
 * view of the release mid-flight. The specific log defect was fixed separately
 * (durable logs), but the RACE CLASS remains: swapping the live release while a
 * scheduled runner is about to start, or is already mid-flight, hands that
 * runner a moving target. This guard makes the deploy REFUSE by default when:
 *
 *   1. CRON PROXIMITY: any EC2 crontab entry belonging to the scheduled-runner
 *      FAMILY (ec2-<anything>-run.sh -- morning briefing, self-heal,
 *      card-controller, otter-resolver, and any future sibling) has a fire time
 *      within a +/- WINDOW_MINUTES (default 2) window of NOW. The check is
 *      deliberately scoped to the runner family: the EC2 crontab also ExampleCos
 *      every-2-minute and every-15-minute utility entries (pm2-storm-guard,
 *      auto-regen) that would make an all-entries proximity check refuse EVERY
 *      deploy forever.
 *   2. MID-FLIGHT RUNNER: a process whose args match the same runner-family
 *      pattern is currently running on the host.
 *
 * The caller (scripts/deploy-ec2-server.sh) snapshots `crontab -l`,
 * `ps -eo args`, and `date +%s` / `date +%z` over ssh, then runs this guard
 * locally BEFORE invoking the atomic-release primitive. Override with
 * --swap-anyway on the deploy script or SB_DEPLOY_SWAP_ANYWAY=1.
 *
 * Category, not literal: the runner family is a PATTERN (ec2-*-run.sh), never a
 * hardcoded list of today's four runner names, so a fifth runner added next
 * month is covered without touching this file.
 *
 * Dependency-free (node builtins only). Pure functions exported for the
 * regression test; the CLI wrapper reads snapshot files and exits 0 (clear to
 * swap) or 1 (refuse, with a named reason and the minutes to wait).
 *
 * USAGE:
 *   node scripts/lib/deploy-window-guard.js \
 *     --cron-file /tmp/crontab.txt --ps-file /tmp/ps.txt \
 *     --now 1784464987 [--host-utc-offset +0000] [--window-minutes 2]
 */
'use strict';

const fs = require('fs');

// The scheduled-runner FAMILY, by pattern. Matches ec2-morning-briefing-run.sh,
// ec2-self-heal-run.sh, ec2-card-controller-run.sh, ec2-otter-resolver-run.sh,
// and any future ec2-<name>-run.sh sibling. Deliberately does NOT match utility
// crons like ec2-otter-audio-backfill.sh or ec2-sync-build-path.sh.
const RUNNER_FAMILY_RE = /(?:^|[\s/'"=])(ec2-[a-z0-9][a-z0-9-]*-run\.sh)\b/;

const DEFAULT_WINDOW_MINUTES = 2;

// ---------------------------------------------------------------------------
// crontab parsing
// ---------------------------------------------------------------------------

const CRON_ALIASES = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
};

const MONTH_NAMES = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};
const DOW_NAMES = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

// Parse one cron field ("*", "*/5", "1-5", "1-5/2", "1,15,30", "mon-fri") into
// a Set of matching integers, or null when unparseable. A null (unparseable)
// field is treated as ALWAYS MATCHING by the caller: the guard fails CLOSED,
// preferring a spurious refusal (override available) over a missed runner.
function parseCronField(field, min, max, names) {
  const values = new Set();
  const resolve = (tok) => {
    const t = tok.toLowerCase();
    if (names && Object.prototype.hasOwnProperty.call(names, t)) return names[t];
    if (!/^\d+$/.test(tok)) return NaN;
    let n = parseInt(tok, 10);
    if (names === DOW_NAMES && n === 7) n = 0; // cron allows 7 = Sunday
    return n;
  };
  for (const part of String(field).split(',')) {
    const m = part.match(/^([^/]+)(?:\/(\d+))?$/);
    if (!m) return null;
    const step = m[2] ? parseInt(m[2], 10) : 1;
    if (!step || step < 1) return null;
    let lo;
    let hi;
    if (m[1] === '*') {
      lo = min;
      hi = max;
    } else if (m[1].includes('-')) {
      const [a, b] = m[1].split('-');
      lo = resolve(a);
      hi = resolve(b);
    } else {
      lo = resolve(m[1]);
      hi = step > 1 ? max : lo;
    }
    if (Number.isNaN(lo) || Number.isNaN(hi) || lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return values;
}

// Parse the crontab text into schedule entries. Tracks CRON_TZ= assignments so
// each entry ExampleCos the IANA timezone active at its line (null = host default).
function parseCrontabEntries(cronText) {
  const entries = [];
  let tz = null;
  for (const rawLine of String(cronText || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const assign = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (assign) {
      if (assign[1] === 'CRON_TZ') tz = assign[2].trim().replace(/^["']|["']$/g, '') || null;
      continue;
    }
    let spec = line;
    if (spec.startsWith('@')) {
      const alias = spec.split(/\s+/, 1)[0];
      if (!CRON_ALIASES[alias]) continue; // @reboot etc: no clock fire time
      spec = CRON_ALIASES[alias] + spec.slice(alias.length);
    }
    const m = spec.match(/^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.+)$/);
    if (!m) continue;
    entries.push({
      minute: parseCronField(m[1], 0, 59, null),
      hour: parseCronField(m[2], 0, 23, null),
      dom: parseCronField(m[3], 1, 31, null),
      month: parseCronField(m[4], 1, 12, MONTH_NAMES),
      dow: parseCronField(m[5], 0, 6, DOW_NAMES),
      domRaw: m[3],
      dowRaw: m[5],
      command: m[6].trim(),
      tz,
      line,
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// wall-clock evaluation
// ---------------------------------------------------------------------------

// Wall-clock parts for an epoch second, either in an IANA timezone (Intl) or at
// a fixed UTC offset string like "+0000" / "-0530" (the host `date +%z`).
function wallClockParts(epochSeconds, tz, hostUtcOffset) {
  if (tz) {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'short',
    });
    const parts = {};
    for (const p of dtf.formatToParts(new Date(epochSeconds * 1000))) parts[p.type] = p.value;
    return {
      minute: parseInt(parts.minute, 10),
      hour: parseInt(parts.hour, 10) % 24, // Intl can emit "24" for midnight
      dom: parseInt(parts.day, 10),
      month: parseInt(parts.month, 10),
      dow: DOW_NAMES[String(parts.weekday).slice(0, 3).toLowerCase()],
    };
  }
  const m = String(hostUtcOffset || '+0000').match(/^([+-])(\d{2}):?(\d{2})$/);
  const offsetSec = m
    ? (m[1] === '-' ? -1 : 1) * (parseInt(m[2], 10) * 3600 + parseInt(m[3], 10) * 60)
    : 0;
  const d = new Date((epochSeconds + offsetSec) * 1000);
  return {
    minute: d.getUTCMinutes(),
    hour: d.getUTCHours(),
    dom: d.getUTCDate(),
    month: d.getUTCMonth() + 1,
    dow: d.getUTCDay(),
  };
}

const fieldMatches = (set, value) => set === null || set.has(value);

// Standard cron day semantics: when BOTH dom and dow are restricted (neither is
// "*"), the entry fires when EITHER matches.
function entryFiresAtMinute(entry, epochSeconds, hostUtcOffset) {
  const t = wallClockParts(epochSeconds, entry.tz, hostUtcOffset);
  if (!fieldMatches(entry.minute, t.minute)) return false;
  if (!fieldMatches(entry.hour, t.hour)) return false;
  if (!fieldMatches(entry.month, t.month)) return false;
  const domRestricted = entry.domRaw !== '*';
  const dowRestricted = entry.dowRaw !== '*';
  const domOk = fieldMatches(entry.dom, t.dom);
  const dowOk = fieldMatches(entry.dow, t.dow);
  if (domRestricted && dowRestricted) return domOk || dowOk;
  return domOk && dowOk;
}

function runnerNameOf(text) {
  const m = String(text || '').match(RUNNER_FAMILY_RE);
  return m ? m[1] : null;
}

// Runner-family cron entries with a fire time inside [now - window, now + window].
function findRunnerCronProximity(cronText, nowEpochSeconds, opts = {}) {
  const windowMinutes = opts.windowMinutes || DEFAULT_WINDOW_MINUTES;
  const hostUtcOffset = opts.hostUtcOffset || '+0000';
  const baseMinute = Math.floor(nowEpochSeconds / 60) * 60;
  const hits = [];
  for (const entry of parseCrontabEntries(cronText)) {
    const runner = runnerNameOf(entry.command);
    if (!runner) continue;
    for (let k = -windowMinutes; k <= windowMinutes; k += 1) {
      if (entryFiresAtMinute(entry, baseMinute + k * 60, hostUtcOffset)) {
        hits.push({ runner, offsetMinutes: k, line: entry.line });
        break;
      }
    }
  }
  return hits;
}

// Runner-family processes currently on the host (ps -eo args snapshot).
function findMidflightRunners(psText) {
  const hits = [];
  for (const rawLine of String(psText || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const runner = runnerNameOf(line);
    if (runner) hits.push({ runner, line });
  }
  return hits;
}

// The verdict. ok=true means clear to swap; ok=false ExampleCos named reasons and
// an honest minutes-to-wait estimate for the cron-proximity case.
function evaluateDeployWindow({ cronText, psText, nowEpochSeconds, hostUtcOffset, windowMinutes }) {
  const window = windowMinutes || DEFAULT_WINDOW_MINUTES;
  const reasons = [];
  let minutesToWait = 0;

  const cronHits = findRunnerCronProximity(cronText, nowEpochSeconds, {
    windowMinutes: window,
    hostUtcOffset,
  });
  for (const hit of cronHits) {
    const when =
      hit.offsetMinutes === 0
        ? 'this minute'
        : hit.offsetMinutes > 0
          ? `in ${hit.offsetMinutes} min`
          : `${-hit.offsetMinutes} min ago`;
    reasons.push(
      `scheduled runner ${hit.runner} has a cron fire ${when} (inside the +/- ${window} min swap window)`,
    );
    minutesToWait = Math.max(minutesToWait, hit.offsetMinutes + window + 1);
  }

  for (const hit of findMidflightRunners(psText)) {
    reasons.push(`scheduled runner ${hit.runner} is mid-flight right now: ${hit.line}`);
  }

  return {
    ok: reasons.length === 0,
    reasons,
    minutesToWait: reasons.length ? Math.max(minutesToWait, 1) : 0,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    args[argv[i]] = argv[i + 1];
  }
  const cronFile = args['--cron-file'];
  const psFile = args['--ps-file'];
  const now = parseInt(args['--now'] || '', 10);
  if (!cronFile || !psFile || !Number.isFinite(now)) {
    console.error(
      '[deploy-window-guard] usage: --cron-file F --ps-file F --now EPOCH [--host-utc-offset +0000] [--window-minutes 2]',
    );
    return 2;
  }
  let cronText;
  let psText;
  try {
    cronText = fs.readFileSync(cronFile, 'utf8');
    psText = fs.readFileSync(psFile, 'utf8');
  } catch (err) {
    // Fail CLOSED: an unreadable snapshot means the window cannot be proven clear.
    console.error(`[deploy-window-guard] REFUSE: cannot read snapshot: ${err.message}`);
    return 1;
  }
  const verdict = evaluateDeployWindow({
    cronText,
    psText,
    nowEpochSeconds: now,
    hostUtcOffset: args['--host-utc-offset'] || '+0000',
    windowMinutes: parseInt(args['--window-minutes'] || '', 10) || DEFAULT_WINDOW_MINUTES,
  });
  if (verdict.ok) {
    console.log(
      '[deploy-window-guard] clear: no runner-family cron fire inside the swap window and no runner mid-flight.',
    );
    return 0;
  }
  console.error(
    '[deploy-window-guard] REFUSE: the atomic swap would land under a scheduled runner:',
  );
  for (const r of verdict.reasons) console.error(`[deploy-window-guard]   - ${r}`);
  console.error(
    `[deploy-window-guard] wait ~${verdict.minutesToWait} min and re-run, or override with --swap-anyway / SB_DEPLOY_SWAP_ANYWAY=1.`,
  );
  return 1;
}

module.exports = {
  RUNNER_FAMILY_RE,
  DEFAULT_WINDOW_MINUTES,
  parseCronField,
  parseCrontabEntries,
  wallClockParts,
  entryFiresAtMinute,
  findRunnerCronProximity,
  findMidflightRunners,
  evaluateDeployWindow,
};

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
