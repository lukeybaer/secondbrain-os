// skill-registry.ts
//
// Runtime capability catalog for SecondBrain. Walks the scheduled-tasks/
// directory, parses each SKILL.md frontmatter, and joins last-run state from
// the agent event-log jsonl files so Amy can answer "what can I do?" and
// "which capability hasn't run / is failing?" at runtime instead of grepping
// the filesystem.
//
// Inspired by the 2026 agent-skills registry trend (Vercel Skills,
// mattpocock/skills, Skilldex, github/awesome-copilot) which standardised
// SKILL.md as the unit of agent capability. SecondBrain already had ~17
// scheduled-tasks/<name>/SKILL.md packages but no TS module that introspected
// them, so the agent could not list, search, or report health on its own
// capabilities.
//
// Pure module. Callers pass the scheduled-tasks dir and the event-log dir;
// tests use tmp dirs and never touch the real Electron userData path.

import * as fs from 'fs';
import * as path from 'path';

export interface Capability {
  name: string;
  description: string;
  path: string;
  body_chars: number;
  triggers: string[];
  last_run_ts: string | null;
  last_run_status: 'success' | 'failure' | 'partial' | 'unknown' | null;
  staleness_hours: number | null;
}

export interface CapabilityFilter {
  query?: string;
  status?: Capability['last_run_status'];
  stale_after_hours?: number;
}

export interface CapabilityHealthEvent {
  task: string;
  status: 'success' | 'failure' | 'partial';
  timestamp: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;
const SAFE_NAME = /^[a-z0-9_-]+$/i;

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const m = raw.match(FRONTMATTER);
  if (!m) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (key) meta[key] = val;
  }
  return { meta, body: m[2] };
}

function extractTriggers(meta: Record<string, string>, body: string): string[] {
  const out = new Set<string>();
  if (meta.cadence) out.add(meta.cadence.toLowerCase());
  const headline = body.split(/\r?\n/, 1)[0] ?? '';
  for (const word of headline.match(/\b(daily|nightly|weekly|hourly|monthly)\b/gi) ?? []) {
    out.add(word.toLowerCase());
  }
  const desc = (meta.description ?? '').toLowerCase();
  for (const word of desc.match(/\b(daily|nightly|weekly|hourly|monthly)\b/g) ?? []) {
    out.add(word);
  }
  return Array.from(out).sort();
}

export function readCapability(skillsDir: string, name: string): Capability | null {
  if (!SAFE_NAME.test(name)) return null;
  const skillPath = path.join(skillsDir, name, 'SKILL.md');
  if (!fs.existsSync(skillPath)) return null;
  const raw = fs.readFileSync(skillPath, 'utf8');
  const { meta, body } = parseFrontmatter(raw);
  return {
    name: meta.name || name,
    description: meta.description || '',
    path: skillPath,
    body_chars: body.length,
    triggers: extractTriggers(meta, body),
    last_run_ts: null,
    last_run_status: null,
    staleness_hours: null,
  };
}

export function listCapabilities(skillsDir: string): Capability[] {
  if (!fs.existsSync(skillsDir)) return [];
  const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  const out: Capability[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (!SAFE_NAME.test(e.name)) continue;
    const cap = readCapability(skillsDir, e.name);
    if (cap) out.push(cap);
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export function loadHealthEvents(jsonlPath: string): CapabilityHealthEvent[] {
  if (!fs.existsSync(jsonlPath)) return [];
  const raw = fs.readFileSync(jsonlPath, 'utf8');
  const out: CapabilityHealthEvent[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      const task = typeof obj.task === 'string' ? obj.task : null;
      const ts = typeof obj.timestamp === 'string' ? obj.timestamp : null;
      const status = obj.status;
      if (!task || !ts) continue;
      const normalised: CapabilityHealthEvent['status'] =
        status === 'success' || status === 'ok' || status === 'green'
          ? 'success'
          : status === 'partial' || status === 'amber'
          ? 'partial'
          : status === 'failure' || status === 'fail' || status === 'red'
          ? 'failure'
          : 'success';
      out.push({ task, status: normalised, timestamp: ts });
    } catch {
      // skip malformed line, keep walking
    }
  }
  return out;
}

export function attachHealth(
  capabilities: Capability[],
  events: CapabilityHealthEvent[],
  now: Date = new Date(),
): Capability[] {
  const latest = new Map<string, CapabilityHealthEvent>();
  for (const ev of events) {
    const prior = latest.get(ev.task);
    if (!prior || ev.timestamp > prior.timestamp) {
      latest.set(ev.task, ev);
    }
  }
  return capabilities.map((cap) => {
    const ev = latest.get(cap.name);
    if (!ev) return { ...cap, last_run_status: 'unknown' };
    const runDate = new Date(ev.timestamp);
    const ageMs = now.getTime() - runDate.getTime();
    return {
      ...cap,
      last_run_ts: ev.timestamp,
      last_run_status: ev.status,
      staleness_hours: ageMs >= 0 ? Math.round(ageMs / 3600_000) : 0,
    };
  });
}

export function findCapability(
  capabilities: Capability[],
  filter: CapabilityFilter,
): Capability[] {
  const q = filter.query?.toLowerCase().trim();
  return capabilities.filter((cap) => {
    if (q) {
      const hay = `${cap.name} ${cap.description} ${cap.triggers.join(' ')}`.toLowerCase();
      const tokens = q.split(/\s+/).filter(Boolean);
      const allMatch = tokens.every((t) => hay.includes(t));
      if (!allMatch) return false;
    }
    if (filter.status && cap.last_run_status !== filter.status) return false;
    if (
      typeof filter.stale_after_hours === 'number' &&
      (cap.staleness_hours === null || cap.staleness_hours < filter.stale_after_hours)
    ) {
      return false;
    }
    return true;
  });
}

export interface CapabilitySummary {
  total: number;
  green: number;
  amber: number;
  red: number;
  unknown: number;
  stalest: Capability | null;
}

// ── Cadence-aware overdue detection ───────────────────────────────────────────
//
// Today the registry tells callers "capability X last ran N hours ago" but
// not "capability X was supposed to run every day and it has been 36h, so
// it is overdue." The briefing's health card was scraping that from scheduled
// task logs and missed obvious skips. This pair of helpers folds the cadence
// hint (already in each SKILL.md frontmatter / headline) into the staleness
// signal so the briefing can render a single ordered "overdue" list.
//
// Source of cadence tokens: extractTriggers() above already extracts the
// daily/nightly/weekly/hourly/monthly words from cadence + headline + desc.
// parseCadenceHours() canonicalises that to a numeric upper bound in hours.
// overdueCapabilities() filters and orders by how late each one is.

const CADENCE_HOURS: Record<string, number> = {
  hourly: 1,
  daily: 24,
  nightly: 24,
  weekly: 24 * 7,
  monthly: 24 * 30,
};

/**
 * Resolve a capability's cadence triggers to the tightest known interval
 * in hours. Returns null when no token matches. The tightest wins because
 * "hourly daily" should still mean "run every hour".
 */
export function parseCadenceHours(triggers: string[]): number | null {
  let tightest: number | null = null;
  for (const trig of triggers) {
    const hours = CADENCE_HOURS[trig.toLowerCase()];
    if (hours === undefined) continue;
    if (tightest === null || hours < tightest) tightest = hours;
  }
  return tightest;
}

export interface OverdueCapability {
  /** The capability that is overdue. */
  cap: Capability;
  /** Expected run interval in hours, derived from cadence. */
  cadence_hours: number;
  /** Hours since the capability last ran (or Infinity when never seen). */
  staleness_hours: number;
  /** staleness_hours / cadence_hours, capped at 1e6 for never-run rows. */
  overdue_ratio: number;
  /** Human-readable reason suitable for a briefing line. */
  reason: string;
}

export interface OverdueOpts {
  /**
   * Multiplier applied to the cadence before a capability is flagged. 1.0
   * means "missed the next expected run by any amount." Defaults to 1.25
   * to absorb small scheduling jitter without crying wolf.
   */
  slack_factor?: number;
  /**
   * Whether to include capabilities whose last_run_status is 'unknown'
   * (no events ever logged). Defaults to true: a never-run skill that
   * has a cadence is overdue by definition.
   */
  include_unknown?: boolean;
  /**
   * Maximum rows to return, sorted by overdue_ratio descending. Defaults
   * to 25 to keep the briefing card bounded.
   */
  max_results?: number;
}

/**
 * Filter a capability list down to the ones whose last run was longer ago
 * than their declared cadence (times slack_factor). Capabilities without a
 * declared cadence are skipped, since the registry has no way to tell
 * whether a one-shot skill is "overdue."
 */
export function overdueCapabilities(
  capabilities: Capability[],
  opts: OverdueOpts = {},
): OverdueCapability[] {
  const slack = Math.max(1, opts.slack_factor ?? 1.25);
  const includeUnknown = opts.include_unknown ?? true;
  const maxResults = opts.max_results ?? 25;

  const out: OverdueCapability[] = [];
  for (const cap of capabilities) {
    const cadence = parseCadenceHours(cap.triggers);
    if (cadence === null) continue;
    const threshold = cadence * slack;
    const seen = cap.staleness_hours !== null;
    if (!seen && !includeUnknown) continue;

    const staleness = seen ? cap.staleness_hours! : Number.POSITIVE_INFINITY;
    if (seen && staleness <= threshold) continue;

    const ratio = seen ? Math.min(staleness / cadence, 1e6) : 1e6;
    const reason = seen
      ? `last ran ${staleness}h ago, cadence ${cadence}h (slack ${slack}x)`
      : `no run on record yet, cadence ${cadence}h`;
    out.push({
      cap,
      cadence_hours: cadence,
      staleness_hours: staleness,
      overdue_ratio: ratio,
      reason,
    });
  }
  out.sort((a, b) => b.overdue_ratio - a.overdue_ratio || a.cap.name.localeCompare(b.cap.name));
  return out.slice(0, maxResults);
}

/**
 * Format overdue rows as briefing-ready lines. Higher overdue first.
 */
export function formatOverdueForBriefing(
  rows: ReadonlyArray<OverdueCapability>,
  limit = 5,
): string[] {
  return rows.slice(0, limit).map((r) => `${r.cap.name}: ${r.reason}`);
}

export function summariseCapabilities(capabilities: Capability[]): CapabilitySummary {
  let green = 0,
    amber = 0,
    red = 0,
    unknown = 0;
  let stalest: Capability | null = null;
  for (const cap of capabilities) {
    if (cap.last_run_status === 'success') green++;
    else if (cap.last_run_status === 'partial') amber++;
    else if (cap.last_run_status === 'failure') red++;
    else unknown++;
    if (
      cap.staleness_hours !== null &&
      (!stalest || (stalest.staleness_hours ?? -1) < cap.staleness_hours)
    ) {
      stalest = cap;
    }
  }
  return { total: capabilities.length, green, amber, red, unknown, stalest };
}
