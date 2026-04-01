// scheduler.ts
// Lightweight scheduler — checks time every minute, fires jobs at their designated times.
// Uses SQLite process locks (acquireLock) for idempotency — one job per day, guaranteed.

import { sendDailyBriefing, sendEveningUpdate } from "./briefing";
import { runVideoPipeline } from "./video-pipeline";
import { acquireLock, lockExists } from "./database-sqlite";
import { runNightlyDecay } from "./memory-index";

// ── CT time helper ────────────────────────────────────────────────────────────

function nowInCT(): { hour: number; minute: number } {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(now);

  let hour = 0;
  let minute = 0;
  for (const part of parts) {
    if (part.type === "hour") hour = parseInt(part.value, 10);
    if (part.type === "minute") minute = parseInt(part.value, 10);
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
    sendDailyBriefing().catch((err) =>
      console.error("[scheduler] sendDailyBriefing error:", err),
    );

    // Video pipeline — build 5 videos if not already done today
    const pipelineDoneKey = `video-pipeline-${todayKey()}-done`;
    if (!lockExists(pipelineDoneKey)) {
      console.log("[scheduler] Triggering video pipeline at 5:30 AM CT");
      runVideoPipeline().catch((err) =>
        console.error("[scheduler] runVideoPipeline error:", err),
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
        console.error("[scheduler] runNightlyDecay error:", err);
      }
    }
  }

  // 21:00–21:02 CT — evening update
  if (inWindow(time, 21, 0)) {
    sendEveningUpdate().catch((err) =>
      console.error("[scheduler] sendEveningUpdate error:", err),
    );
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

let _timer: ReturnType<typeof setInterval> | null = null;

export function startScheduler(): void {
  if (_timer !== null) {
    console.warn("[scheduler] already running — ignoring startScheduler()");
    return;
  }
  console.log("[scheduler] started — checking every 60 s");
  tick(); // Run immediately on start (catches a launch inside a window)
  _timer = setInterval(() => {
    tick();
  }, 60_000);
}

export function stopScheduler(): void {
  if (_timer === null) return;
  clearInterval(_timer);
  _timer = null;
  console.log("[scheduler] stopped");
}
