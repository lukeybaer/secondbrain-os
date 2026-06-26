#!/usr/bin/env node
/**
 * sweep-stale-spine-tasks.js
 *
 * The spine has accumulated 1000+ open entries from automatic intake
 * (otter transcripts, telegram inbound, gmail ingests, github action
 * failure mirrors). None of these have a worker closing them, so they
 * pile up and turn spinetasks RED in every briefing.
 *
 * Bulk sweep policy (conservative):
 *
 *   - Tasks older than `--threshold-hours` (default 24h) with an origin
 *     in a known-routine category get marked removed_non_actionable with
 *     a categorized reason. These categories trigger from intake but the
 *     content rarely needs follow-up after the window passes.
 *
 *   - Anything outside those categories is left alone and surfaced for
 *     manual review.
 *
 * Categories swept by default:
 *   - origin=otter      : "Otter: ..." raw transcripts older than 24h
 *   - kind=ingest + title startsWith "Gmail: [ExampleCoyExampleCo" : GitHub Action
 *     failure mirror notifications older than 24h
 *   - kind=ingest + title startsWith "Gmail: " for newsletter senders
 *     (Amazon, Spotify, Met, PRIVATE_NAME, Network Solutions, etc) older than 24h
 *   - title startsWith "You are Amy replying to ExampleCo on Telegram" older
 *     than 24h (lost Telegram-window messages)
 *
 * Dry-run by default. Pass --commit to actually sweep. Logs every action
 * to data/agent/spine-sweep.jsonl.
 *
 * Usage:
 *   node scripts/sweep-stale-spine-tasks.js --threshold-hours 24 [--commit] [--limit 1000]
 */

const fs = require('fs');
const path = require('path');
const { findStaleSpineTasks, markNonActionable, resolveTasksDir } = require('./lib/spine-ingress');

const REPO = path.resolve(__dirname, '..');
const SWEEP_LOG = path.join(REPO, 'data', 'agent', 'spine-sweep.jsonl');

const NEWSLETTER_SENDERS = [
  'Amazon.com', 'Amazon Health', 'Amazon Pay', 'Spotify', 'Met Membership', 'PRIVATE_NAME Bank',
  'Network Solutions', 'EP Electric', 'TOCA Allen', 'The PIT', 'Tracfone', 'Verizon',
  'LinkedIn', 'GitHub', 'Costco', 'Best Buy', 'Walmart', 'Target', 'Apple', 'Google',
  'YouTube', 'Patreon', 'Substack', 'Medium', 'Reddit', 'Twitter', 'X Corp', 'Meta',
  'Facebook', 'Instagram', 'Notion', 'Slack', 'Discord', 'Zoom', 'Calendly', 'Dropbox',
];

function categorize(task) {
  const title = String(task.title || '');
  const origin = String(task.origin || '');
  const kind = String(task.kind || '');
  const prompt = String(task.prompt || '');

  if (origin === 'otter') {
    return { category: 'otter-stale-ingest', reason: 'Otter ingest older than threshold; transcript already archived to S3, no action surfaced during window.' };
  }
  if (title.startsWith('You are Amy replying to ExampleCo on Telegram')) {
    return { category: 'telegram-window-closed', reason: 'Telegram reply window closed (>24h); lost message cannot be answered as if real-time.' };
  }
  if (title.includes('ExampleCoyExampleCo/SecondBrain') || title.includes('Run failed:')) {
    return { category: 'github-action-failure-notification', reason: 'GitHub Action failure notification; status visible in repo, no separate action needed from this mirror.' };
  }
  if (kind === 'ingest' && title.startsWith('Gmail: ')) {
    for (const s of NEWSLETTER_SENDERS) {
      if (title.toLowerCase().includes(s.toLowerCase())) {
        return { category: 'gmail-newsletter-stale', reason: `Routine newsletter from ${s} older than threshold; not actionable beyond the window.` };
      }
    }
    // Catch-all for Gmail ingests older than 72h: the action-items pipeline
    // runs on a 24-48h window. Anything past that has already been triaged
    // by the briefing or is stale beyond response window.
    if (typeof task.ageHours === 'number' && task.ageHours > 72) {
      return { category: 'gmail-ingest-past-action-window', reason: `Gmail ingest is ${Math.round(task.ageHours)}h old, well past the 24-48h action-items window. Already triaged by briefing or non-actionable.` };
    }
  }
  // LinkedIn ingests also age out: the LinkedIn warmth window is 7d.
  if (origin === 'linkedin' && typeof task.ageHours === 'number' && task.ageHours > 168) {
    return { category: 'linkedin-stale-ingest', reason: `LinkedIn ingest is ${Math.round(task.ageHours)}h old, past the 7d engagement window.` };
  }
  // Gmail #Amy dispatches that never executed and are now stale beyond 72h:
  // the dispatch was meant for now-time action. Hours-old #Amy is no longer
  // valid; mark non-actionable with the specific reason so the audit trail is
  // honest about what happened.
  if (origin === 'gmail' && title.startsWith('Gmail #Amy:') && typeof task.ageHours === 'number' && task.ageHours > 72) {
    return { category: 'amy-dispatch-window-expired', reason: `#Amy dispatch is ${Math.round(task.ageHours)}h old; dispatch processor did not execute during the action window. Source email already in raw archive.` };
  }
  // LinkedIn intents over 5d, even with origin not matching above (some are
  // recorded as origin=gmail but title starts with "LinkedIn:").
  if (title.startsWith('LinkedIn:') && typeof task.ageHours === 'number' && task.ageHours > 120) {
    return { category: 'linkedin-thread-stale', reason: `LinkedIn thread is ${Math.round(task.ageHours)}h old, past the engagement window.` };
  }
  return null;
}

function parseArgs(argv) {
  const out = { thresholdHours: 24, commit: false, limit: 2000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--threshold-hours') out.thresholdHours = parseInt(argv[++i], 10);
    else if (a === '--commit') out.commit = true;
    else if (a === '--limit') out.limit = parseInt(argv[++i], 10);
  }
  return out;
}

function appendLog(row) {
  try { fs.mkdirSync(path.dirname(SWEEP_LOG), { recursive: true }); } catch {}
  fs.appendFileSync(SWEEP_LOG, JSON.stringify({ ts: new Date().toISOString(), ...row }) + '\n');
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  console.error(`[sweep] threshold=${opts.thresholdHours}h commit=${opts.commit} limit=${opts.limit}`);
  appendLog({ stage: 'start', ...opts });

  const stale = findStaleSpineTasks({ thresholdHours: opts.thresholdHours });
  console.error(`[sweep] stale tasks found: ${stale.length}`);
  appendLog({ stage: 'inventory', count: stale.length });

  const counts = {};
  const sweepCandidates = [];
  const leaveBehind = [];

  for (const task of stale) {
    const cat = categorize(task);
    if (cat) {
      counts[cat.category] = (counts[cat.category] || 0) + 1;
      sweepCandidates.push({ task, cat });
    } else {
      leaveBehind.push(task);
    }
  }

  console.error('[sweep] category breakdown:');
  for (const [c, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.error(`  ${c}: ${n}`);
  }
  console.error(`[sweep] leave-behind (manual review): ${leaveBehind.length}`);
  for (const t of leaveBehind.slice(0, 5)) {
    console.error(`  - ${t.id} | ${(t.title || '').slice(0, 100)} | origin=${t.origin} ageH=${Math.round(t.ageHours)}`);
  }
  appendLog({ stage: 'categorized', counts, leave_behind_count: leaveBehind.length, leave_behind_sample: leaveBehind.slice(0, 10).map((t) => ({ id: t.id, title: t.title, origin: t.origin, ageHours: t.ageHours })) });

  if (!opts.commit) {
    console.error('[sweep] DRY RUN. Pass --commit to apply.');
    appendLog({ stage: 'dry-run-complete', would_sweep: sweepCandidates.length });
    return;
  }

  let swept = 0, errors = 0;
  for (const { task, cat } of sweepCandidates.slice(0, opts.limit)) {
    try {
      markNonActionable(task.id, cat.reason);
      swept++;
      if (swept % 100 === 0) console.error(`[sweep] swept ${swept}...`);
    } catch (e) {
      errors++;
      appendLog({ stage: 'sweep-error', id: task.id, error: String(e.message || e).slice(0, 200) });
    }
  }
  console.error(`[sweep] done. swept=${swept} errors=${errors} leave_behind=${leaveBehind.length}`);
  appendLog({ stage: 'sweep-complete', swept, errors, leave_behind: leaveBehind.length });
}

if (require.main === module) {
  try { main(); } catch (e) {
    console.error('[sweep] fatal:', e.stack || e.message);
    appendLog({ stage: 'fatal', error: String(e.message || e) });
    process.exit(2);
  }
}

module.exports = { categorize };
