// memory-temperature.ts
//
// Adaptive memory promotion inspired by mem0's multi-tier architecture and
// the ARMS (Adaptive Retrieval Memory System) research paper.
//
// Problem: agent-memory.ts reads and writes memories but treats all facts as
// equally important. Hot memories (frequently accessed, recently relevant) get
// buried alongside cold ones from months ago. This wastes context tokens and
// buries the most actionable facts.
//
// Solution: track access frequency + recency per memory key, compute a
// "temperature" score, and surface the top-N hottest memories at prompt-build
// time so they land in the primary agent context before semantic search.
//
// Temperature formula (decay-weighted):
//   temp = sum_i( weight_i * e^(-lambda * age_days_i) )
//   where weight_i is the access weight (recent accesses weighted higher)
//   and lambda is the decay constant (default 0.1 → ~7-day half-life)
//
// Storage: JSONL append log + derived hot-list JSON, both in userData/data/agent/
// The log is the ground truth; the hot-list is rebuilt during sleep-time consolidation.

import * as fs from 'fs';
import * as path from 'path';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MemoryAccessEvent {
  timestamp: string;
  memoryKey: string;         // e.g. "user_profile" or "contact:john-smith"
  context: string;           // what task triggered this access (for debugging)
  weight: number;            // 1.0 for read, 2.0 for explicit recall, 0.5 for background
}

export interface MemoryTemperature {
  memoryKey: string;
  temperature: number;       // 0..100 normalized score
  accessCount: number;
  lastAccessedAt: string;
  tier: 'hot' | 'warm' | 'cold';
}

// ── Constants ─────────────────────────────────────────────────────────────────

const LAMBDA = 0.1;           // decay constant → ~7-day half-life
const HOT_THRESHOLD = 15.0;   // temperature above which a memory is "hot"
const COLD_THRESHOLD = 2.0;   // temperature below which a memory is "cold"
const HOT_TIER_MAX = 12;      // max hot memories in prompt (context budget)
const MS_PER_DAY = 86_400_000;

// ── Path helpers ──────────────────────────────────────────────────────────────

function accessLogPath(dataDir: string): string {
  return path.join(dataDir, 'memory-access-log.jsonl');
}

function hotListPath(dataDir: string): string {
  return path.join(dataDir, 'memory-hot-list.json');
}

// ── Write an access event ─────────────────────────────────────────────────────

export function recordAccess(
  dataDir: string,
  memoryKey: string,
  context: string,
  weight: number = 1.0,
): void {
  const event: MemoryAccessEvent = {
    timestamp: new Date().toISOString(),
    memoryKey,
    context,
    weight,
  };
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.appendFileSync(accessLogPath(dataDir), JSON.stringify(event) + '\n');
  } catch {
    /* best-effort */
  }
}

// ── Compute temperature from the access log ───────────────────────────────────

export function computeTemperatures(dataDir: string): MemoryTemperature[] {
  const logPath = accessLogPath(dataDir);
  if (!fs.existsSync(logPath)) return [];

  const now = Date.now();
  const events: MemoryAccessEvent[] = [];

  try {
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    for (const line of lines) {
      try {
        events.push(JSON.parse(line) as MemoryAccessEvent);
      } catch {
        /* skip malformed */
      }
    }
  } catch {
    return [];
  }

  // Group events by memoryKey
  const grouped = new Map<string, MemoryAccessEvent[]>();
  for (const ev of events) {
    const list = grouped.get(ev.memoryKey) ?? [];
    list.push(ev);
    grouped.set(ev.memoryKey, list);
  }

  const temps: MemoryTemperature[] = [];

  for (const [key, evs] of grouped) {
    let temperature = 0;
    let lastMs = 0;

    for (const ev of evs) {
      const evMs = new Date(ev.timestamp).getTime();
      const ageDays = (now - evMs) / MS_PER_DAY;
      temperature += ev.weight * Math.exp(-LAMBDA * ageDays);
      if (evMs > lastMs) lastMs = evMs;
    }

    const tier: MemoryTemperature['tier'] =
      temperature >= HOT_THRESHOLD ? 'hot' :
      temperature >= COLD_THRESHOLD ? 'warm' :
      'cold';

    temps.push({
      memoryKey: key,
      temperature: Math.round(temperature * 100) / 100,
      accessCount: evs.length,
      lastAccessedAt: new Date(lastMs).toISOString(),
      tier,
    });
  }

  // Sort hottest first
  temps.sort((a, b) => b.temperature - a.temperature);
  return temps;
}

// ── Rebuild the hot list ──────────────────────────────────────────────────────
// Called during sleep-time consolidation. Reads access log, computes temps,
// writes a trimmed hot-list JSON for fast reads at prompt-build time.

export function rebuildHotList(dataDir: string): MemoryTemperature[] {
  const temps = computeTemperatures(dataDir);
  const hotList = temps.filter((t) => t.tier === 'hot').slice(0, HOT_TIER_MAX);

  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(
      hotListPath(dataDir),
      JSON.stringify({ updatedAt: new Date().toISOString(), items: hotList }, null, 2),
    );
  } catch {
    /* best-effort */
  }

  return hotList;
}

// ── Read the hot list (fast path, no computation) ─────────────────────────────

export function readHotList(dataDir: string): MemoryTemperature[] {
  const p = hotListPath(dataDir);
  if (!fs.existsSync(p)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8')) as {
      updatedAt: string;
      items: MemoryTemperature[];
    };
    return data.items ?? [];
  } catch {
    return [];
  }
}

// ── Build hot-memory context block ────────────────────────────────────────────
// Returns a formatted string suitable for prepending to an agent system prompt.
// Caller should load the actual memory content for each key; this provides
// the ranked list so the agent can fetch them in priority order.

export function buildHotMemoryBlock(dataDir: string): string {
  const hot = readHotList(dataDir);
  if (hot.length === 0) return '';

  const lines = hot.map(
    (m) => `  - ${m.memoryKey} (temp=${m.temperature}, accesses=${m.accessCount})`,
  );

  return [
    '## Frequently Accessed Memory (hot tier — load these first)',
    ...lines,
    '',
  ].join('\n');
}

// ── Trim old access log ───────────────────────────────────────────────────────
// Keep only events from the last N days to bound log growth.
// Call this during sleep-time consolidation after rebuildHotList().

export function trimAccessLog(dataDir: string, keepDays: number = 30): void {
  const logPath = accessLogPath(dataDir);
  if (!fs.existsSync(logPath)) return;

  const cutoff = Date.now() - keepDays * MS_PER_DAY;

  try {
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    const kept = lines.filter((line) => {
      try {
        const ev = JSON.parse(line) as MemoryAccessEvent;
        return new Date(ev.timestamp).getTime() >= cutoff;
      } catch {
        return false;
      }
    });
    fs.writeFileSync(logPath, kept.join('\n') + (kept.length > 0 ? '\n' : ''));
  } catch {
    /* best-effort */
  }
}

// ── Stats ─────────────────────────────────────────────────────────────────────

export interface TemperatureStats {
  totalKeys: number;
  hotCount: number;
  warmCount: number;
  coldCount: number;
  topMemory: string | null;
  topTemperature: number;
}

export function getTemperatureStats(dataDir: string): TemperatureStats {
  const temps = computeTemperatures(dataDir);
  const hot  = temps.filter((t) => t.tier === 'hot');
  const warm = temps.filter((t) => t.tier === 'warm');
  const cold = temps.filter((t) => t.tier === 'cold');
  const top  = temps[0] ?? null;

  return {
    totalKeys:      temps.length,
    hotCount:       hot.length,
    warmCount:      warm.length,
    coldCount:      cold.length,
    topMemory:      top?.memoryKey ?? null,
    topTemperature: top?.temperature ?? 0,
  };
}
