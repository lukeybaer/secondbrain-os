// briefing-diff.ts
//
// Longitudinal briefing diff — detect persistent patterns across multiple days.
//
// Problem: Each briefing is generated fresh each day. Amy has no longitudinal
// awareness: if the same health probe fails for 5 consecutive days, the
// briefing treats it as a new failure each time. Same for stale action items.
//
// Solution: Parse the last N briefings, extract action items + health probes,
// cross-reference to find persistent patterns, and return a structured report
// the briefing generator can inject as a "Persistent Issues" section.
//
// Pattern: Inspired by LangGraph's durable checkpoint awareness — the idea
// that state machines should track *how long* something has been in a given
// state, not just what state it's in right now. Applied to briefings: each
// daily briefing is a checkpoint; consecutive identical failures signal
// that automatic healing isn't working and Luke's attention is needed.
//
// Usage:
//   import { loadRecentBriefings, buildPersistentIssuesSummary } from './briefing-diff';
//   const briefings = loadRecentBriefings(briefingsDir, 7);
//   const summary = buildPersistentIssuesSummary(briefings);
//   if (summary) console.log(summary); // inject into briefing before send

import * as fs from 'fs';
import * as path from 'path';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ParsedBriefing {
  date: string;                         // YYYY-MM-DD
  actionItems: ActionItem[];
  failingProbes: string[];              // probe names that are ✗ or RED
  openCommitments: OpenCommitment[];
}

export interface ActionItem {
  index: number;
  subject: string;                      // normalized subject line (lowercased, trimmed)
  rawLine: string;                      // first line of the action item
  ageInDays: number;                    // extracted from "(Nd old)" suffix
}

export interface OpenCommitment {
  text: string;                         // full bullet text
  sinceDays: number | null;            // null if parse fails
}

export interface PersistentIssue {
  type: 'health_probe' | 'action_item' | 'open_commitment';
  label: string;                        // probe name or action item subject
  consecutiveDays: number;             // how many briefings it appears in
  firstSeen: string;                    // YYYY-MM-DD
  latestSeen: string;                  // YYYY-MM-DD
  ageInDays: number;                   // from action item if available
}

export interface BriefingDiffResult {
  analyzedDays: number;
  persistentProbes: PersistentIssue[];     // failing for >= threshold days
  staleActionItems: PersistentIssue[];     // same item for >= threshold days
  overdueCommitments: PersistentIssue[];   // commitments > threshold days old
}

// ── Parsing ───────────────────────────────────────────────────────────────────

const DATE_RE = /^briefing-(\d{4}-\d{2}-\d{2})\.md$/;

/** Load and parse the most recent `days` briefings from a directory. */
export function loadRecentBriefings(briefingsDir: string, days: number = 7): ParsedBriefing[] {
  if (!fs.existsSync(briefingsDir)) return [];

  const files = fs
    .readdirSync(briefingsDir)
    .filter((f) => DATE_RE.test(f))
    .sort()
    .slice(-days);

  return files.map((f) => {
    const dateMatch = f.match(DATE_RE);
    const date = dateMatch ? dateMatch[1] : f;
    const content = fs.readFileSync(path.join(briefingsDir, f), 'utf8');
    return parseBriefing(date, content);
  });
}

/** Extract structured data from one briefing's markdown content. */
export function parseBriefing(date: string, content: string): ParsedBriefing {
  return {
    date,
    actionItems: parseActionItems(content),
    failingProbes: parseFailingProbes(content),
    openCommitments: parseOpenCommitments(content),
  };
}

function parseActionItems(content: string): ActionItem[] {
  const items: ActionItem[] = [];
  // Find lines like: "N. Contact (Category) — Subject — detail (Nd old)"
  const re = /^(\d+)\.\s+(.+?)\s*\((\d+)d old\)/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    const idx = Number(match[1]);
    const rawLine = match[0].trim();
    const age = Number(match[3]);
    // Normalize the subject: strip the leading "N. ", lowercase, trim
    const subject = normalizeSubject(match[2]);
    items.push({ index: idx, subject, rawLine, ageInDays: age });
  }
  return items;
}

function normalizeSubject(raw: string): string {
  // Extract the "Subject" portion from "Contact (Tag) — Subject — details"
  // Pattern: "X — Y — Z" or "X — Y" where Y is the subject
  const parts = raw.split(/\s+—\s+/);
  if (parts.length >= 2) {
    // parts[0] = "Contact (Tag)", parts[1] = "Subject"
    return parts[1].toLowerCase().trim();
  }
  return raw.toLowerCase().trim();
}

function parseFailingProbes(content: string): string[] {
  // Match lines like: "  ✗ ProbeName: ..."
  const failing: string[] = [];
  const re = /^\s+[✗?]\s+([A-Za-z][A-Za-z0-9]+):/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    failing.push(match[1]);
  }
  // Also check for "Overall: ⚠ RED" style lines
  if (/Overall:\s+[⚠✗]\s+RED/m.test(content)) {
    if (!failing.includes('Overall')) failing.push('Overall');
  }
  return [...new Set(failing)];
}

function parseOpenCommitments(content: string): OpenCommitment[] {
  const commitments: OpenCommitment[] = [];
  // Find the OPEN COMMITMENTS section by locating it and then reading lines until
  // we hit the next all-caps section header (e.g. SYSTEM HEALTH, FEATURE BACKLOG)
  const headerIdx = content.indexOf('OPEN COMMITMENTS');
  if (headerIdx === -1) return commitments;

  const afterHeader = content.slice(headerIdx);
  // Split into lines and collect bullet lines until we see the next section header
  const lines = afterHeader.split('\n');
  let past = false;
  for (const line of lines) {
    if (!past) {
      // Skip the header line itself
      if (line.startsWith('OPEN COMMITMENTS')) { past = true; continue; }
    }
    if (past) {
      // Stop at next section header (all-caps word followed by colon or all-caps line)
      if (/^[A-Z][A-Z\s]{3,}(?:\s|:)/.test(line) && !line.startsWith('•')) break;
      if (!line.trim().startsWith('•')) continue;

      const sinceMatch = line.match(/\(since ([A-Za-z]+ \d+)\)/);
      let sinceDays: number | null = null;
      if (sinceMatch) {
        const parsed = new Date(`${sinceMatch[1]}, ${new Date().getFullYear()}`);
        if (!isNaN(parsed.getTime())) {
          sinceDays = Math.floor((Date.now() - parsed.getTime()) / 86400000);
        }
      }
      commitments.push({ text: line.replace(/^•\s*/, '').trim(), sinceDays });
    }
  }
  return commitments;
}

// ── Analysis ──────────────────────────────────────────────────────────────────

/** Detect persistent issues across a series of parsed briefings. */
export function analyzeBriefingDiff(
  briefings: ParsedBriefing[],
  opts: {
    probeThreshold?: number;        // consecutive days for a probe to be "persistent" (default: 3)
    actionItemThreshold?: number;   // consecutive appearances for action item (default: 4)
    commitmentThreshold?: number;   // days old to flag as overdue (default: 7)
  } = {},
): BriefingDiffResult {
  const {
    probeThreshold = 3,
    actionItemThreshold = 4,
    commitmentThreshold = 7,
  } = opts;

  const sorted = [...briefings].sort((a, b) => a.date.localeCompare(b.date));

  return {
    analyzedDays: sorted.length,
    persistentProbes: findPersistentProbes(sorted, probeThreshold),
    staleActionItems: findStaleActionItems(sorted, actionItemThreshold),
    overdueCommitments: findOverdueCommitments(sorted, commitmentThreshold),
  };
}

function findPersistentProbes(sorted: ParsedBriefing[], threshold: number): PersistentIssue[] {
  // Track per-probe how many consecutive days it's been failing
  const probeRuns: Map<string, { count: number; firstSeen: string; latestSeen: string }> = new Map();
  const persistent: PersistentIssue[] = [];

  for (const b of sorted) {
    const failing = new Set(b.failingProbes);
    for (const [probe, run] of probeRuns) {
      if (!failing.has(probe)) {
        // Probe recovered — reset streak
        probeRuns.delete(probe);
      }
    }
    for (const probe of failing) {
      const existing = probeRuns.get(probe);
      if (existing) {
        existing.count++;
        existing.latestSeen = b.date;
      } else {
        probeRuns.set(probe, { count: 1, firstSeen: b.date, latestSeen: b.date });
      }
    }
  }

  for (const [probe, run] of probeRuns) {
    if (run.count >= threshold) {
      const days = daysBetween(run.firstSeen, run.latestSeen) + 1;
      persistent.push({
        type: 'health_probe',
        label: probe,
        consecutiveDays: run.count,
        firstSeen: run.firstSeen,
        latestSeen: run.latestSeen,
        ageInDays: days,
      });
    }
  }

  return persistent.sort((a, b) => b.consecutiveDays - a.consecutiveDays);
}

function findStaleActionItems(sorted: ParsedBriefing[], threshold: number): PersistentIssue[] {
  // Track action items by normalized subject across briefings
  const subjectRuns: Map<string, { count: number; firstSeen: string; latestSeen: string; ageInDays: number }> =
    new Map();
  const stale: PersistentIssue[] = [];

  for (const b of sorted) {
    const subjects = new Set(b.actionItems.map((i) => i.subject));

    // Remove subjects that didn't appear this day (they may be resolved)
    for (const [subject, run] of subjectRuns) {
      if (!subjects.has(subject)) {
        subjectRuns.delete(subject);
      }
    }

    for (const item of b.actionItems) {
      const existing = subjectRuns.get(item.subject);
      if (existing) {
        existing.count++;
        existing.latestSeen = b.date;
        existing.ageInDays = item.ageInDays;
      } else {
        subjectRuns.set(item.subject, {
          count: 1,
          firstSeen: b.date,
          latestSeen: b.date,
          ageInDays: item.ageInDays,
        });
      }
    }
  }

  for (const [subject, run] of subjectRuns) {
    if (run.count >= threshold) {
      stale.push({
        type: 'action_item',
        label: subject,
        consecutiveDays: run.count,
        firstSeen: run.firstSeen,
        latestSeen: run.latestSeen,
        ageInDays: run.ageInDays,
      });
    }
  }

  return stale.sort((a, b) => b.ageInDays - a.ageInDays);
}

function findOverdueCommitments(sorted: ParsedBriefing[], threshold: number): PersistentIssue[] {
  if (sorted.length === 0) return [];
  // Use the most recent briefing's commitments
  const latest = sorted[sorted.length - 1];
  return latest.openCommitments
    .filter((c) => c.sinceDays !== null && c.sinceDays >= threshold)
    .map((c) => ({
      type: 'open_commitment' as const,
      label: c.text,
      consecutiveDays: c.sinceDays!,
      firstSeen: latest.date,
      latestSeen: latest.date,
      ageInDays: c.sinceDays!,
    }))
    .sort((a, b) => b.ageInDays - a.ageInDays);
}

// ── Formatting ────────────────────────────────────────────────────────────────

/** Format a diff result as a briefing section. Returns empty string if nothing to report. */
export function buildPersistentIssuesSummary(diff: BriefingDiffResult): string {
  const sections: string[] = [];

  if (diff.persistentProbes.length > 0) {
    const lines = diff.persistentProbes.map(
      (p) => `  ⚠ ${p.label}: failing ${p.consecutiveDays} consecutive days (since ${p.firstSeen})`,
    );
    sections.push(`Health probes stuck in failure:\n${lines.join('\n')}`);
  }

  if (diff.staleActionItems.length > 0) {
    const lines = diff.staleActionItems.map(
      (a) => `  • "${a.label}" — ${a.ageInDays}d old, seen in ${a.consecutiveDays} briefings`,
    );
    sections.push(`Action items not moving:\n${lines.join('\n')}`);
  }

  if (diff.overdueCommitments.length > 0) {
    const lines = diff.overdueCommitments.map(
      (c) => `  • ${c.label} (${c.ageInDays}d overdue)`,
    );
    sections.push(`Overdue commitments:\n${lines.join('\n')}`);
  }

  if (sections.length === 0) return '';

  const header = `PERSISTENT ISSUES (${diff.analyzedDays}-day lookback):`;
  return [header, ...sections].join('\n\n');
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function daysBetween(a: string, b: string): number {
  const da = new Date(a).getTime();
  const db = new Date(b).getTime();
  return Math.round(Math.abs(db - da) / 86400000);
}
