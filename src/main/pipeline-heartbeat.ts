// pipeline-heartbeat.ts
//
// Absence-of-event heartbeat for video pipeline and other long-running tasks.
//
// Pattern: Prefect Posture.Proactive EventTrigger — configured with expect (event
// name) and within (timedelta). If expected heartbeat does NOT arrive within window,
// the trigger fires. SecondBrain translation: each pipeline stage appends a line
// to pipeline-heartbeat.jsonl; pre-briefing-diagnostic.js checks age of last entry.
//
// Also implements OpenHands StuckDetector pattern 4 (repeated_cycles): if the same
// (video_id, error_type) pair appears N times consecutively, the pipeline is
// actively stuck (vs silently dead). These require different heal strategies:
//   - Dead (age > threshold): restart pipeline process
//   - Stuck (repeated same error): skip video, escalate to rejections.jsonl
//
// Composio ipc-trace-middleware pattern: heartbeat writes can be placed in the
// afterExecute position of any pipeline step without modifying tool implementations.
//
// Output: data/agent/pipeline-heartbeat.jsonl

import * as fs from 'fs';
import * as path from 'path';

// ── Types ─────────────────────────────────────────────────────────────────────

export type HeartbeatStatus =
  | 'started'
  | 'video_built'
  | 'qc_passed'
  | 'qc_failed'
  | 'regen_queued'
  | 'regen_attempted'
  | 'completed'
  | 'error';

export interface HeartbeatEntry {
  timestamp: string;     // ISO 8601
  task: string;          // 'video-pipeline' | 'health-self-heal' | 'nightly-enhancement'
  status: HeartbeatStatus;
  video_id?: string;
  error_type?: string;   // short error category for stuck detection
  error?: string;        // full error message
  latency_ms?: number;
  details?: string;
}

export interface StaleCheck {
  is_stale: boolean;
  hours_since_last: number;
  threshold_hours: number;
  last_entry?: HeartbeatEntry;
}

export interface StuckCheck {
  is_stuck: boolean;
  pattern?: string;      // 'repeated_video_error' | 'repeated_qc_failure'
  video_id?: string;
  error_type?: string;
  consecutive_count?: number;
}

export interface HeartbeatHealth {
  stale: StaleCheck;
  stuck: StuckCheck;
  status: 'green' | 'yellow' | 'red';
  detail: string;
}

// ── Write ─────────────────────────────────────────────────────────────────────

/** Append a heartbeat entry. Best-effort — failures are silently swallowed. */
export function appendHeartbeat(logPath: string, entry: HeartbeatEntry): void {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const line: HeartbeatEntry = { ...entry, timestamp: entry.timestamp || new Date().toISOString() };
    fs.appendFileSync(logPath, JSON.stringify(line) + '\n', 'utf8');
  } catch {
    /* heartbeat writes must never break the caller */
  }
}

// ── Read ──────────────────────────────────────────────────────────────────────

function readEntries(logPath: string, limit = 50): HeartbeatEntry[] {
  if (!fs.existsSync(logPath)) return [];
  try {
    const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter((l) => l.trim());
    const slice = lines.slice(-limit);
    const entries: HeartbeatEntry[] = [];
    for (const line of slice) {
      try {
        entries.push(JSON.parse(line) as HeartbeatEntry);
      } catch {
        /* skip malformed */
      }
    }
    return entries;
  } catch {
    return [];
  }
}

export function getLastHeartbeat(logPath: string, task?: string): HeartbeatEntry | null {
  const entries = readEntries(logPath, 200);
  const filtered = task ? entries.filter((e) => e.task === task) : entries;
  return filtered.length > 0 ? filtered[filtered.length - 1] : null;
}

// ── Stale detection ───────────────────────────────────────────────────────────

/**
 * Check if the last heartbeat for a task is older than thresholdHours.
 * A missing heartbeat log is treated as stale (age = Infinity).
 */
export function checkStale(
  logPath: string,
  task: string,
  thresholdHours: number,
): StaleCheck {
  const last = getLastHeartbeat(logPath, task);
  if (!last) {
    return {
      is_stale: true,
      hours_since_last: Infinity,
      threshold_hours: thresholdHours,
    };
  }
  const ageMs = Date.now() - new Date(last.timestamp).getTime();
  const hours = ageMs / (1000 * 60 * 60);
  return {
    is_stale: hours > thresholdHours,
    hours_since_last: Math.round(hours * 10) / 10,
    threshold_hours: thresholdHours,
    last_entry: last,
  };
}

// ── Stuck detection ───────────────────────────────────────────────────────────

/**
 * OpenHands StuckDetector pattern 4: repeated (video_id, error_type) cycles.
 * Scans the tail of the log for consecutive identical failure pairs.
 * Threshold=3 means the same video failed the same way 3+ times in a row.
 */
export function checkStuck(
  logPath: string,
  task: string,
  consecutiveThreshold = 3,
): StuckCheck {
  const entries = readEntries(logPath, 100).filter(
    (e) => e.task === task && (e.status === 'qc_failed' || e.status === 'error'),
  );

  if (entries.length < consecutiveThreshold) return { is_stuck: false };

  const tail = entries.slice(-consecutiveThreshold);
  const first = tail[0];

  const allSameVideo = tail.every((e) => e.video_id && e.video_id === first.video_id);
  const allSameError = tail.every((e) => e.error_type && e.error_type === first.error_type);

  if (allSameVideo && allSameError) {
    return {
      is_stuck: true,
      pattern: 'repeated_video_error',
      video_id: first.video_id,
      error_type: first.error_type,
      consecutive_count: consecutiveThreshold,
    };
  }

  const allSameErrorOnly = tail.every((e) => e.error_type && e.error_type === first.error_type);
  if (!allSameVideo && allSameErrorOnly) {
    return {
      is_stuck: true,
      pattern: 'repeated_qc_failure',
      error_type: first.error_type,
      consecutive_count: consecutiveThreshold,
    };
  }

  return { is_stuck: false };
}

// ── Combined health check ─────────────────────────────────────────────────────

/**
 * Full pipeline health check: stale + stuck combined into a single status.
 * Designed to be called from pre-briefing-diagnostic.js probeVideoPipeline().
 *
 * Status logic:
 *   green  — recent heartbeat, no stuck pattern
 *   yellow — heartbeat stale > thresholdHours but < 2x (pipeline may be slow)
 *   red    — heartbeat stale > 2x threshold, OR actively stuck on same error
 */
export function checkPipelineHealth(
  logPath: string,
  task: string,
  staleThresholdHours = 48,
): HeartbeatHealth {
  const stale = checkStale(logPath, task, staleThresholdHours);
  const stuck = checkStuck(logPath, task);

  if (stuck.is_stuck) {
    return {
      stale,
      stuck,
      status: 'red',
      detail: `pipeline stuck: ${stuck.pattern}, video=${stuck.video_id ?? 'n/a'}, error=${stuck.error_type ?? 'ExampleCo'} (${stuck.consecutive_count}x)`,
    };
  }

  if (!stale.is_stale) {
    return {
      stale,
      stuck,
      status: 'green',
      detail: `last heartbeat ${stale.hours_since_last}h ago`,
    };
  }

  const severeFactor = 2;
  if (stale.hours_since_last > staleThresholdHours * severeFactor) {
    return {
      stale,
      stuck,
      status: 'red',
      detail: `pipeline dead: no heartbeat for ${stale.hours_since_last}h (threshold ${staleThresholdHours}h)`,
    };
  }

  return {
    stale,
    stuck,
    status: 'yellow',
    detail: `pipeline slow: last heartbeat ${stale.hours_since_last}h ago (threshold ${staleThresholdHours}h)`,
  };
}
