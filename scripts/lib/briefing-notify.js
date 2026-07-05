// briefing-notify.js
//
// 2026-07-03 ExampleCo: "I never receive the Telegram link when the 5:30 AM CT
// briefing publishes." Root cause was two-layered: the EC2 cron wrapper
// (scripts/ec2-morning-briefing-run.sh) never passed --notify, and even with
// it, kind 'briefing-link' was missing from the notify-with-fallback policy
// allowlist so the send was silently suppressed. The notify branch was also
// gated on a clean publish, so a published-blocked briefing never delivered
// the link at all.
//
// This lib owns the briefing-link delivery contract:
//  - ONE Telegram message per published briefing per day PER PUBLISH STATE
//    (clean | blocked). A same-day regen in the same state never re-sends.
//  - The blocked -> clean transition DOES re-send ("Briefing now clean").
//  - Message shape per the link-only policy (memory/feedback_telegram_policy.md,
//    ExampleCo 2026-06-09 "Links are ok but briefing summaries and 404s no"): one
//    status line plus the tokenized dashboard link, nothing chatty.
//  - Failure honesty: a failed send NEVER fails the publish. The failure is
//    logged and recorded in the marker so the publish receipt shows notify
//    status, and a failed send does not dedupe (the next publish retries).
//  - Cron-safe env: the 5:30 cron runs with a minimal environment; the
//    Telegram creds and SB_BRIEFING_TOKEN live in the .env NEXT TO the data
//    dir (/opt/secondbrain/.env next to /opt/secondbrain/data on EC2). Missing
//    keys are backfilled from that file; already-set keys are never clobbered.
//
// Dedup state lives in its own marker file in <dataDir>/agent, keyed by date,
// following the egress-owned dedup principle (scripts/lib/notification-dedup.js):
// no upstream artifact rewrite can wipe it and cause a re-send.

const fs = require('fs');
const path = require('path');
const { loadDotEnvIfPresent } = require('./notify-with-fallback.js');

// Backfill missing env keys from the .env that sits next to the data dir.
// /opt/secondbrain/data -> /opt/secondbrain/.env. Never overrides set keys.
function loadBriefingNotifyEnv(dataDir, env = process.env) {
  if (!dataDir) return;
  loadDotEnvIfPresent(path.resolve(dataDir, '..', '.env'), env);
}

function briefingNotifyMarkerPath(dataDir, date) {
  return path.join(dataDir, 'agent', `briefing-notify-${date}.json`);
}

function readMarker(dataDir, date) {
  try {
    return JSON.parse(fs.readFileSync(briefingNotifyMarkerPath(dataDir, date), 'utf8'));
  } catch {
    return null;
  }
}

function writeMarker(dataDir, date, marker) {
  const file = briefingNotifyMarkerPath(dataDir, date);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(marker, null, 2));
  } catch (e) {
    console.warn(`[briefing-notify] could not write marker ${file}: ${e.message}`);
  }
  return file;
}

// One status line plus the link. Nothing chatty (link-only policy).
function buildBriefingNotifyText({ clean, blockerCount = 0, url = '', transition = false } = {}) {
  let statusLine;
  if (clean) {
    statusLine = transition ? 'Briefing now clean' : 'Briefing ready: clean';
  } else if (blockerCount > 0) {
    statusLine = `Briefing ready: ${blockerCount} blocker${blockerCount === 1 ? '' : 's'}`;
  } else {
    statusLine = 'Briefing ready: blocked';
  }
  return [statusLine, url].filter(Boolean).join('\n');
}

// Send the briefing link for a publish event, marker-deduped by date + state.
// Returns { status: 'sent' | 'skipped-duplicate' | 'failed' | 'suppressed',
//           state, sentAt?, reason?, transition, marker }.
// Never throws: any transport error becomes status 'failed'.
async function notifyBriefingPublished({
  dataDir,
  date,
  clean,
  blockerCount = 0,
  url = '',
  send,
  now = () => new Date(),
} = {}) {
  const state = clean ? 'clean' : 'blocked';
  const markerFile = briefingNotifyMarkerPath(dataDir, date);
  const prior = readMarker(dataDir, date);

  // Dedupe on delivered sends only: a failed or suppressed attempt must not
  // swallow the next publish's retry.
  if (prior && prior.state === state && prior.status === 'sent') {
    return {
      status: 'skipped-duplicate',
      state,
      sentAt: prior.sentAt || null,
      transition: false,
      marker: markerFile,
    };
  }

  const transition = Boolean(clean && prior && prior.state === 'blocked' && prior.status === 'sent');
  loadBriefingNotifyEnv(dataDir);
  const text = buildBriefingNotifyText({ clean, blockerCount, url, transition });
  const ts = now().toISOString();

  let outcome;
  try {
    const result = await send({
      text,
      kind: 'briefing-link',
      source: 'cloud-morning-briefing',
      priority: 'normal',
      // The per-day per-state marker above owns briefing-link dedupe. The
      // generic 24h text-hash ledger would wrongly suppress tomorrow's
      // identical clean message when the crons run less than 24h apart.
      dedup: false,
    });
    if (result && result.ok && !result.suppressed && result.channel === 'telegram') {
      outcome = { status: 'sent', sentAt: ts, channel: 'telegram' };
    } else if (result && result.suppressed) {
      outcome = { status: 'suppressed', reason: String(result.reason || 'suppressed') };
    } else {
      outcome = {
        status: 'failed',
        reason:
          result && result.channel === 'fallback'
            ? 'telegram-send-failed-queued-to-fallback'
            : 'send-not-delivered',
      };
    }
  } catch (e) {
    outcome = { status: 'failed', reason: String((e && e.message) || e).slice(0, 200) };
  }
  if (outcome.status !== 'sent') {
    console.warn(
      `[briefing-notify] link NOT delivered for ${date} (${state}): ${outcome.status} ${outcome.reason || ''}`,
    );
  }

  writeMarker(dataDir, date, {
    date,
    state,
    blockerCount,
    transition,
    updatedAt: ts,
    ...outcome,
    previous: prior
      ? { state: prior.state, status: prior.status, sentAt: prior.sentAt || null }
      : null,
  });

  return { ...outcome, state, transition, marker: markerFile };
}

module.exports = {
  notifyBriefingPublished,
  buildBriefingNotifyText,
  loadBriefingNotifyEnv,
  briefingNotifyMarkerPath,
};
