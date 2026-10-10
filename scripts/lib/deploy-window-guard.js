#!/usr/bin/env node
/**
 * deploy-window-guard.js -- refuse an atomic /opt swap under a STARTING runner.
 *
 * WHY (2026-07-19, revised 2026-08-24): a deploy's atomic symlink swap landed
 * 84 seconds after the 5:30:00 morning-briefing cron started, orphaning the
 * just-started runner's view of the release mid-flight. The first guard
 * answered with a blanket +/- 2 minute cron-proximity window plus an
 * unconditional mid-flight refusal. That blanket distrust of immutable
 * releases caused its own production incident (2026-08-23/24): two atomic
 * swaps were refused purely because a cron fire sat about 2 minutes in the
 * past, even though every runner executes from a pinned immutable release
 * directory under /opt/secondbrain-releases/<sha>, and a symlink swap cannot
 * affect a process already running from a pinned path. The only genuine
 * hazard is a process resolving the /opt/secondbrain symlink during its
 * startup instant. This guard therefore REFUSES only when:
 *
 *   1. CRON STARTUP GRACE: any EC2 crontab entry belonging to the
 *      scheduled-runner FAMILY (ec2-<anything>-run.sh -- morning briefing,
 *      self-heal, card-controller, otter-resolver, and any future sibling)
 *      has a fire time within STARTUP_GRACE_SECONDS (default 15,
 *      configurable) of NOW, before or after: a runner is starting, or about
 *      to start, and may be resolving the /opt/secondbrain symlink this
 *      instant. The check stays scoped to the runner family: the EC2 crontab
 *      also carries every-2-minute utility entries that would otherwise
 *      refuse deploys constantly.
 *   2. RUNNER INSIDE THE GRACE: a runner-family process is provably younger
 *      than the same startup grace (ps etimes), so it may still be inside
 *      its symlink-resolution instant.
 *   3. UNPROVEN PIN (fail closed): a runner-family process is mid-flight
 *      beyond the grace but its immutable-release pin cannot be PROVEN. The
 *      pin is proven when its cwd (readlink /proc/<pid>/cwd, kernel-resolved)
 *      or its argv script path sits under /opt/secondbrain-releases/. A
 *      runner whose start age is unknowable, or whose cwd sits under
 *      /opt/secondbrain (the live symlink) or anywhere else, refuses. A
 *      runner mid-flight beyond the grace WITH a proven pin is safe to swap
 *      under BECAUSE a pinned process never re-reads the symlink.
 *
 * The caller (scripts/deploy-ec2-server.sh) snapshots `crontab -l`,
 * `ps -eo pid,etimes,args`, per-pid `/proc/<pid>/cwd` readlinks, and
 * `date +%s` / `date +%z` over ssh, then runs this guard locally BEFORE
 * invoking the atomic-release primitive. Override with --swap-anyway on the
 * deploy script or SB_DEPLOY_SWAP_ANYWAY=1.
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
 *     --now 1784464987 [--cwd-file /tmp/cwd.txt] [--host-utc-offset +0000] \
 *     [--grace-seconds 15] [--releases-root /opt/secondbrain-releases]
 */
'use strict';

const fs = require('fs');

// The scheduled-runner FAMILY, by pattern. Matches ec2-morning-briefing-run.sh,
// ec2-self-heal-run.sh, ec2-card-controller-run.sh, ec2-otter-resolver-run.sh,
// and any future ec2-<name>-run.sh sibling. Deliberately does NOT match utility
// crons like ec2-otter-audio-backfill.sh or ec2-sync-build-path.sh.
const RUNNER_FAMILY_RE = /(?:^|[\s/'"=])(ec2-[a-z0-9][a-z0-9-]*-run\.sh)\b/;

const DEFAULT_STARTUP_GRACE_SECONDS = 15;
// The immutable release directories the atomic primitive publishes. A process
// whose cwd or script path sits under here is pinned: the /opt/secondbrain
// symlink swap cannot change what it is executing.
const DEFAULT_RELEASES_ROOT = '/opt/secondbrain-releases';

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
// each entry carries the IANA timezone active at its line (null = host default).
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

function stripTokenQuotes(token) {
  return String(token || '').replace(/^(['"])(.*)\1$/, '$2');
}

function runnerScriptOfToken(token) {
  const value = stripTokenQuotes(token);
  const basename = value.slice(value.lastIndexOf('/') + 1);
  return /^ec2-[a-z0-9][a-z0-9-]*-run\.sh$/.test(basename)
    ? { runner: basename, scriptPath: value }
    : null;
}

// The args column is intentionally inspected by argv position, not by
// substring. A runner is live only when it is argv[0], or when bash/sh has
// selected it as its script operand. In particular, `bash -c "...
// ec2-foo-run.sh ..."` is a diagnostic command string, not a runner process.
function executedRunnerOf(line) {
  const tokens = String(line || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!tokens.length) return null;

  const directRunner = runnerScriptOfToken(tokens[0]);
  if (directRunner) return directRunner;

  const command = stripTokenQuotes(tokens[0]);
  const commandBasename = command.slice(command.lastIndexOf('/') + 1);
  if (commandBasename !== 'bash' && commandBasename !== 'sh') return null;

  for (let i = 1; i < tokens.length; i += 1) {
    const token = stripTokenQuotes(tokens[i]);
    if (token === '--') {
      return runnerScriptOfToken(tokens[i + 1]);
    }
    if (token === '--command' || token.startsWith('--command=')) return null;
    if (/^-[^-]*c/.test(token)) return null;
    if (token === '-O' || token === '-o' || token === '--rcfile' || token === '--init-file') {
      i += 1;
      continue;
    }
    if (token.startsWith('-') && token !== '-') continue;
    return runnerScriptOfToken(tokens[i]);
  }
  return null;
}

// Runner-family cron entries with a fire time inside the startup grace:
// [now - graceSeconds, now + graceSeconds]. Cron fires on minute boundaries,
// so every minute boundary in that span is tested against each schedule. A
// fire outside the grace is NOT a hazard by itself: the runner it started is
// judged by the mid-flight pin check instead.
function findRunnerCronProximity(cronText, nowEpochSeconds, opts = {}) {
  const graceSeconds = opts.graceSeconds || DEFAULT_STARTUP_GRACE_SECONDS;
  const hostUtcOffset = opts.hostUtcOffset || '+0000';
  const firstMinute = Math.ceil((nowEpochSeconds - graceSeconds) / 60) * 60;
  const lastMinute = Math.floor((nowEpochSeconds + graceSeconds) / 60) * 60;
  const hits = [];
  for (const entry of parseCrontabEntries(cronText)) {
    const runner = runnerNameOf(entry.command);
    if (!runner) continue;
    for (let m = firstMinute; m <= lastMinute; m += 60) {
      if (entryFiresAtMinute(entry, m, hostUtcOffset)) {
        hits.push({ runner, offsetSeconds: m - nowEpochSeconds, line: entry.line });
        break;
      }
    }
  }
  return hits;
}

// Runner-family scripts currently being executed on the host. The snapshot is
// `ps -eo pid,etimes,args`; a line whose pid/etimes prefix is missing (legacy
// args-only snapshot) still detects the runner but carries ageSeconds null,
// which the verdict treats as unprovable and refuses (fail closed). A runner
// filename mentioned by a diagnostic process is ignored.
function findMidflightRunners(psText) {
  const hits = [];
  for (const rawLine of String(psText || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let pid = null;
    let ageSeconds = null;
    let args = line;
    const m = line.match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (m) {
      pid = m[1];
      ageSeconds = parseInt(m[2], 10);
      args = m[3];
    }
    const found = executedRunnerOf(args);
    if (found) {
      hits.push({ runner: found.runner, scriptPath: found.scriptPath, pid, ageSeconds, line });
    }
  }
  return hits;
}

// `<pid> <resolved cwd>` lines (readlink /proc/<pid>/cwd on the host). The
// kernel reports a fully resolved physical path, so a cwd under the immutable
// releases root PROVES the process already pinned its release.
function parseCwdSnapshot(cwdText) {
  const byPid = new Map();
  for (const rawLine of String(cwdText || '').split(/\r?\n/)) {
    const m = rawLine.trim().match(/^(\d+)\s+(\/.*)$/);
    if (m) byPid.set(m[1], m[2].trim());
  }
  return byPid;
}

// Strictly INSIDE the releases root: /opt/secondbrain-releases/<sha>[/...]
// qualifies; the root itself, /opt/secondbrain (the live symlink), and any
// sibling path do not.
function isPinnedReleasePath(candidate, releasesRoot) {
  if (!candidate) return false;
  const root = String(releasesRoot || DEFAULT_RELEASES_ROOT).replace(/\/+$/, '');
  return candidate.startsWith(`${root}/`) && candidate.length > root.length + 1;
}

// The verdict. ok=true means clear to swap; ok=false carries named reasons and
// an honest minutes-to-wait estimate for the startup-grace cases. A runner
// mid-flight beyond the grace with a PROVEN immutable-release pin never
// refuses: the symlink swap cannot reach a pinned process. Every unprovable
// case (unknown start age, unprovable pin) refuses, fail closed.
function evaluateDeployWindow({
  cronText,
  psText,
  cwdText,
  nowEpochSeconds,
  hostUtcOffset,
  graceSeconds,
  releasesRoot,
  allowedActiveRunner = '',
}) {
  const grace =
    Number.isFinite(graceSeconds) && graceSeconds > 0
      ? graceSeconds
      : DEFAULT_STARTUP_GRACE_SECONDS;
  const reasons = [];
  let secondsToWait = 0;
  const allowedActiveRunners = new Set(
    String(allowedActiveRunner || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );

  const cronHits = findRunnerCronProximity(cronText, nowEpochSeconds, {
    graceSeconds: grace,
    hostUtcOffset,
  });
  for (const hit of cronHits) {
    if (allowedActiveRunners.has(hit.runner)) continue;
    const when =
      hit.offsetSeconds === 0
        ? 'this second'
        : hit.offsetSeconds > 0
          ? `in ${hit.offsetSeconds}s`
          : `${-hit.offsetSeconds}s ago`;
    reasons.push(
      `scheduled runner ${hit.runner} has a cron fire ${when} (inside the ${grace}s startup grace, its symlink-resolution instant)`,
    );
    secondsToWait = Math.max(secondsToWait, hit.offsetSeconds + grace + 1);
  }

  const cwdByPid = parseCwdSnapshot(cwdText);
  for (const hit of findMidflightRunners(psText)) {
    if (allowedActiveRunners.has(hit.runner)) continue;
    if (hit.ageSeconds !== null && hit.ageSeconds <= grace) {
      reasons.push(
        `scheduled runner ${hit.runner} started ${hit.ageSeconds}s ago (inside the ${grace}s startup grace): ${hit.line}`,
      );
      secondsToWait = Math.max(secondsToWait, grace - hit.ageSeconds + 1);
      continue;
    }
    if (hit.ageSeconds === null) {
      reasons.push(
        `scheduled runner ${hit.runner} has no provable start age (snapshot lacks pid/etimes; fail closed): ${hit.line}`,
      );
      continue;
    }
    const cwd = hit.pid === null ? null : cwdByPid.get(hit.pid) || null;
    const pinned =
      isPinnedReleasePath(cwd, releasesRoot) || isPinnedReleasePath(hit.scriptPath, releasesRoot);
    if (pinned) continue; // pinned immutable release: the swap cannot reach it
    reasons.push(
      `scheduled runner ${hit.runner} is mid-flight but its immutable-release pin cannot be proven (cwd ${cwd || 'unknown'}; fail closed): ${hit.line}`,
    );
  }

  return {
    ok: reasons.length === 0,
    reasons,
    minutesToWait: reasons.length ? Math.max(Math.ceil(secondsToWait / 60), 1) : 0,
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
  const cwdFile = args['--cwd-file'];
  const now = parseInt(args['--now'] || '', 10);
  if (!cronFile || !psFile || !Number.isFinite(now)) {
    console.error(
      '[deploy-window-guard] usage: --cron-file F --ps-file F --now EPOCH [--cwd-file F] [--host-utc-offset +0000] [--grace-seconds 15] [--releases-root /opt/secondbrain-releases]',
    );
    return 2;
  }
  let cronText;
  let psText;
  let cwdText = '';
  try {
    cronText = fs.readFileSync(cronFile, 'utf8');
    psText = fs.readFileSync(psFile, 'utf8');
    if (cwdFile) cwdText = fs.readFileSync(cwdFile, 'utf8');
  } catch (err) {
    // Fail CLOSED: an unreadable snapshot means the window cannot be proven clear.
    console.error(`[deploy-window-guard] REFUSE: cannot read snapshot: ${err.message}`);
    return 1;
  }
  const verdict = evaluateDeployWindow({
    cronText,
    psText,
    cwdText,
    nowEpochSeconds: now,
    hostUtcOffset: args['--host-utc-offset'] || '+0000',
    graceSeconds: parseInt(args['--grace-seconds'] || '', 10) || DEFAULT_STARTUP_GRACE_SECONDS,
    releasesRoot: args['--releases-root'] || DEFAULT_RELEASES_ROOT,
    allowedActiveRunner: args['--allow-active-runner'] || '',
  });
  if (verdict.ok) {
    console.log(
      '[deploy-window-guard] clear: no runner-family cron fire inside the startup grace, no runner inside its startup instant, and every mid-flight runner is pinned to an immutable release.',
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
  DEFAULT_STARTUP_GRACE_SECONDS,
  DEFAULT_RELEASES_ROOT,
  parseCronField,
  parseCrontabEntries,
  wallClockParts,
  entryFiresAtMinute,
  findRunnerCronProximity,
  findMidflightRunners,
  parseCwdSnapshot,
  isPinnedReleasePath,
  evaluateDeployWindow,
};

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
