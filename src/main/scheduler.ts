// scheduler.ts
// Lightweight scheduler — checks time every minute, fires jobs at their designated times.
// Uses SQLite process locks (acquireLock) for idempotency — one job per day, guaranteed.

import { sendDailyBriefing } from './briefing';
import { runVideoPipeline } from './video-pipeline';
import { acquireLock, lockExists } from './database-sqlite';
import { runNightlyDecay } from './memory-index';
import { runDailyBackup } from './backups';
import { runLinkedInNightlyCrawl } from './linkedin-intel';
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

// ── CT time helper ────────────────────────────────────────────────────────────

function nowInCT(): { hour: number; minute: number } {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(now);

  let hour = 0;
  let minute = 0;
  for (const part of parts) {
    if (part.type === 'hour') hour = parseInt(part.value, 10);
    if (part.type === 'minute') minute = parseInt(part.value, 10);
  }
  if (hour === 24) hour = 0;
  return { hour, minute };
}

function inWindow(
  time: { hour: number; minute: number },
  targetHour: number,
  targetMinute: number,
  windowMinutes = 2,
): boolean {
  const nowTotal = time.hour * 60 + time.minute;
  const targetTotal = targetHour * 60 + targetMinute;
  return nowTotal >= targetTotal && nowTotal < targetTotal + windowMinutes;
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

// ── Scheduler tick ────────────────────────────────────────────────────────────

async function tick(): Promise<void> {
  const time = nowInCT();

  // 5:29–5:31 AM CT — morning briefing + video pipeline
  if (inWindow(time, 5, 29)) {
    // Morning briefing — idempotent via its own SQLite lock
    sendDailyBriefing().catch((err) => console.error('[scheduler] sendDailyBriefing error:', err));

    // Video pipeline — build 5 videos if not already done today
    const pipelineDoneKey = `video-pipeline-${todayKey()}-done`;
    if (!lockExists(pipelineDoneKey)) {
      console.log('[scheduler] Triggering video pipeline at 5:30 AM CT');
      runVideoPipeline().catch((err) => console.error('[scheduler] runVideoPipeline error:', err));
    }
  }

  // 0:00–0:02 AM CT — LinkedIn contact intelligence crawl
  if (inWindow(time, 0, 0)) {
    const crawlKey = `linkedin-crawl-${todayKey()}`;
    if (acquireLock(crawlKey)) {
      runLinkedInNightlyCrawl().catch((err) =>
        console.error('[scheduler] runLinkedInNightlyCrawl error:', err),
      );
    }
  }

  // 2:00–2:02 AM CT — nightly Hebbian memory decay
  if (inWindow(time, 2, 0)) {
    const decayKey = `memory-decay-${todayKey()}`;
    if (acquireLock(decayKey)) {
      try {
        const result = runNightlyDecay();
        console.log(
          `[scheduler] memory decay complete — decayed:${result.decayed} archived:${result.archived} pruned:${result.pruned}`,
        );
      } catch (err) {
        console.error('[scheduler] runNightlyDecay error:', err);
      }
    }
  }

  // 3:00–3:02 AM CT — Time Machine data pruning + RSL automation priority refresh
  if (inWindow(time, 3, 0)) {
    const pruneKey = `tm-prune-${todayKey()}`;
    if (acquireLock(pruneKey)) {
      try {
        const { pruneTimeMachineData } = await import('./timemachine-pruner');
        const result = await pruneTimeMachineData();
        console.log(
          `[scheduler] tm prune complete — screenshots:${result.deletedScreenshots} audio:${result.deletedAudio}`,
        );
      } catch (err) {
        console.error('[scheduler] pruneTimeMachineData error:', err);
      }

      // RSL priority refresh — recompute automation_priority by miss_count
      // so the video pipeline knows which QC checks to automate first
      try {
        const { refreshAutomationPriority } = await import('./rejection-skill-learning');
        const { priority, topMissed } = refreshAutomationPriority();
        if (topMissed.length > 0) {
          console.log(
            `[scheduler] RSL priority refresh — ${priority.length} criteria tracked. Top missed: ${topMissed.map((c) => `${c.id}(${c.miss_count})`).join(', ')}`,
          );
        } else {
          console.log(`[scheduler] RSL priority refresh — no misses recorded yet`);
        }
      } catch (err) {
        console.error('[scheduler] RSL refreshAutomationPriority error:', err);
      }
    }
  }

  // 3:30–3:32 AM CT — daily backup (full snapshot + retention pruning)
  if (inWindow(time, 3, 30)) {
    const backupKey = `daily-backup-${todayKey()}`;
    if (acquireLock(backupKey)) {
      try {
        const result = await runDailyBackup();
        console.log(
          `[scheduler] daily backup complete — snapshot:${result.snapshot.id} (${result.snapshot.fileCount} files, ${(result.snapshot.dataBytes / 1048576).toFixed(1)}MB) pruned:${result.pruned.length}`,
        );
      } catch (err) {
        console.error('[scheduler] runDailyBackup error:', err);
      }
    }
  }

  // 4:00–4:02 AM CT — incremental memory sync to Graphiti
  if (inWindow(time, 4, 0)) {
    const syncKey = `memory-graphiti-sync-${todayKey()}`;
    if (acquireLock(syncKey)) {
      try {
        const { incrementalGraphitiSync } = await import('./memory-sync');
        const result = await incrementalGraphitiSync();
        console.log(
          `[scheduler] memory-graphiti sync — checked:${result.checked} ingested:${result.ingested} failed:${result.failed}`,
        );
      } catch (err) {
        console.error('[scheduler] incrementalGraphitiSync error:', err);
      }
    }
  }

  // Evening update + sermon briefing disabled — Telegram is daily-briefing-only.
  // Luke can still request these on-demand via Telegram commands.

  // ── Social post scheduled publishing (every tick — checks for due posts) ───
  publishScheduledSocialPosts().catch((err) =>
    console.error('[scheduler] publishScheduledSocialPosts error:', err),
  );
}

async function publishScheduledSocialPosts(): Promise<void> {
  const contentRoot =
    process.env.SECONDBRAIN_ROOT ??
    (app.isPackaged ? 'C:/Users/luked/secondbrain' : path.resolve(app.getAppPath()));
  const queuePath = path.join(contentRoot, 'content-review', 'social-posts', 'queue.json');

  if (!fs.existsSync(queuePath)) return;

  let queue: any[];
  try {
    queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
  } catch {
    return;
  }

  const now = new Date();
  let changed = false;

  for (const post of queue) {
    if (post.status !== 'approved' || !post.scheduled_for) continue;
    const scheduledTime = new Date(post.scheduled_for);
    if (scheduledTime > now) continue;

    // Time to publish
    try {
      const { publishTweet } = await import('./x-publisher');
      if (post.platform === 'x') {
        const result = await publishTweet(post.content);
        if (result.success) {
          post.status = 'posted';
          post.posted_at = new Date().toISOString();
          post.post_url = result.postUrl;
          post.tweet_id = result.tweetId;
          changed = true;
          console.log(`[scheduler] Published scheduled social post ${post.id} to X`);
        } else {
          console.error(`[scheduler] Failed to publish ${post.id}:`, result.error);
        }
      }
    } catch (err) {
      console.error(`[scheduler] Error publishing ${post.id}:`, err);
    }
  }

  if (changed) {
    fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2));
  }
}

function isSaturdayCT(): boolean {
  const now = new Date();
  const dayStr = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'short',
  }).format(now);
  return dayStr === 'Sat';
}

// ── Public API ────────────────────────────────────────────────────────────────

let _timer: ReturnType<typeof setInterval> | null = null;

export function startScheduler(): void {
  if (_timer !== null) {
    console.warn('[scheduler] already running — ignoring startScheduler()');
    return;
  }
  console.log('[scheduler] started — checking every 60 s');
  tick(); // Run immediately on start (catches a launch inside a window)
  _timer = setInterval(() => {
    tick();
  }, 60_000);
}

export function stopScheduler(): void {
  if (_timer === null) return;
  clearInterval(_timer);
  _timer = null;
  console.log('[scheduler] stopped');
}
