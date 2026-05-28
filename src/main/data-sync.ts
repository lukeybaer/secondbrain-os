// data-sync.ts
// Periodically pushes local data (projects, todos, calls) to EC2 so Amy's
// tools can answer queries during live calls without polling back to Electron.

import { getConfig } from "./config";
import { buildDataSnapshot } from "./amy-versions";

const SYNC_INTERVAL_MS = 15_000;  // Every 15 seconds

let syncRunning = false;
let stopRequested = false;
let syncTimer: ReturnType<typeof setTimeout> | null = null;

async function syncOnce(): Promise<void> {
  const config = getConfig();
  if (!config.ec2BaseUrl) return;

  try {
    const snapshot = await buildDataSnapshot();
    const res = await fetch(`${config.ec2BaseUrl}/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(snapshot),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      // Silent success
    } else {
      console.warn("[data-sync] sync failed: HTTP", res.status);
    }
  } catch {
    // Silently swallow — EC2 might be temporarily unreachable
  }
}

async function pollLoop(): Promise<void> {
  if (!syncRunning) return;

  await syncOnce();

  if (!stopRequested) {
    syncTimer = setTimeout(pollLoop, SYNC_INTERVAL_MS);
  } else {
    syncRunning = false;
    stopRequested = false;
  }
}

export function startDataSync(): void {
  if (syncRunning) return;
  syncRunning = true;
  stopRequested = false;
  console.log("[data-sync] started (every 15s → EC2)");
  // Initial sync immediately
  syncOnce().then(() => {
    syncTimer = setTimeout(pollLoop, SYNC_INTERVAL_MS);
  });
}

export function stopDataSync(): void {
  if (!syncRunning) return;
  stopRequested = true;
  if (syncTimer !== null) {
    clearTimeout(syncTimer);
    syncTimer = null;
    syncRunning = false;
    stopRequested = false;
  }
  console.log("[data-sync] stopped");
}
