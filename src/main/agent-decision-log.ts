// agent-decision-log.ts
//
// Structured decision recording for Amy's autonomous heal and routing logic.
//
// Pattern: CrewAI Flows @router() decorator (v1.14.0) — conditional branching
// with logical operators (or_, and_) records which conditions were evaluated
// and which route was selected. SecondBrain's health-self-heal.js makes many
// if/else decisions (heal vs skip vs escalate vs defer) but doesn't record
// the rationale as structured data. This module provides that audit trail.
//
// Decisions are append-only JSONL so the nightly briefing can surface:
//   "Amy tried to heal s3Parity (skip: already failed 3x), escalated at 3:12 AM"
//
// Output: data/agent/agent-decisions.jsonl
//
// Usage:
//   const log = new DecisionLog('/path/to/agent-decisions.jsonl');
//   const record = log.decide('health-self-heal', 's3Parity', [
//     { condition: 'canAutoHeal', result: true },
//     { condition: 'retryCount < 3', result: false },
//   ], 'escalate', 'retry count exhausted');
//   // later: log.resolveOutcome(record.decision_id, 'failure', 'sync still failing');

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { redactDeep } from './redact-secrets';

// ── Types ─────────────────────────────────────────────────────────────────────

export type DecisionType =
  | 'heal' // attempt automated remediation
  | 'skip' // skip this probe for now (not critical / already tried)
  | 'escalate' // send alert or create draft
  | 'retry' // retry the same heal action (with backoff)
  | 'defer' // defer to next diagnostic cycle
  | 'no_action'; // probe is green, nothing to do

export interface DecisionCondition {
  condition: string; // human-readable condition text ("retryCount < 3")
  result: boolean; // whether the condition was true
}

export interface DecisionRecord {
  decision_id: string; // unique ID for correlating outcome
  timestamp: string; // ISO 8601
  task: string; // 'health-self-heal' | 'video-pipeline' | 'nightly-enhancement'
  probe: string; // which health probe or step triggered this decision
  conditions_evaluated: DecisionCondition[];
  decision: DecisionType;
  reason: string; // why this route was selected
  outcome?: 'success' | 'failure' | 'pending';
  outcome_at?: string;
  outcome_detail?: string;
}

// ── Log class ─────────────────────────────────────────────────────────────────

export class DecisionLog {
  constructor(private readonly logPath: string) {}

  /**
   * Record a routing decision. Returns the written record so callers can
   * later call resolveOutcome() with the decision_id.
   */
  decide(
    task: string,
    probe: string,
    conditions: DecisionCondition[],
    decision: DecisionType,
    reason: string,
  ): DecisionRecord {
    const record: DecisionRecord = {
      decision_id: crypto.randomBytes(6).toString('hex'),
      timestamp: new Date().toISOString(),
      task,
      probe,
      conditions_evaluated: conditions,
      decision,
      reason,
      outcome: 'pending',
    };
    this._append(record);
    return record;
  }

  /**
   * Update an existing record with its outcome. Appends a new line with the
   * resolved state so the log stays append-only. Callers match via decision_id.
   */
  resolveOutcome(decisionId: string, outcome: 'success' | 'failure', detail?: string): void {
    const records = this.readAll();
    const existing = records.find((r) => r.decision_id === decisionId);
    if (!existing) return;

    const resolved: DecisionRecord = {
      ...existing,
      outcome,
      outcome_at: new Date().toISOString(),
      outcome_detail: detail,
    };
    this._append(resolved);
  }

  /** Read all records from the log. */
  readAll(limit = 200): DecisionRecord[] {
    if (!fs.existsSync(this.logPath)) return [];
    const lines = fs
      .readFileSync(this.logPath, 'utf8')
      .split('\n')
      .filter((l) => l.trim());
    const records: DecisionRecord[] = [];
    for (const line of lines.slice(-limit)) {
      try {
        records.push(JSON.parse(line) as DecisionRecord);
      } catch {
        /* skip malformed */
      }
    }
    return records;
  }

  /**
   * Get the most recent decision for a specific (task, probe) pair.
   * Useful for health-self-heal.js to check "did I just escalate this?"
   * before creating duplicate drafts.
   */
  lastDecisionFor(task: string, probe: string): DecisionRecord | null {
    const all = this.readAll();
    const matching = all.filter((r) => r.task === task && r.probe === probe);
    return matching.length > 0 ? matching[matching.length - 1] : null;
  }

  /**
   * Count recent decisions of a given type for a probe within a time window.
   * Used for "already tried to heal this 3x" checks before escalating.
   */
  countRecentDecisions(
    task: string,
    probe: string,
    decision: DecisionType,
    withinHours: number,
  ): number {
    const cutoff = Date.now() - withinHours * 3_600_000;
    return this.readAll().filter(
      (r) =>
        r.task === task &&
        r.probe === probe &&
        r.decision === decision &&
        new Date(r.timestamp).getTime() >= cutoff,
    ).length;
  }

  /**
   * Summarize decision activity since a cutoff timestamp.
   * Used by the nightly briefing to show "what Amy decided last night."
   */
  summarizeSince(sinceHours: number): {
    total: number;
    byDecision: Partial<Record<DecisionType, number>>;
    escalations: DecisionRecord[];
    failures: DecisionRecord[];
  } {
    const cutoff = Date.now() - sinceHours * 3_600_000;
    const recent = this.readAll().filter((r) => new Date(r.timestamp).getTime() >= cutoff);

    const byDecision: Partial<Record<DecisionType, number>> = {};
    for (const r of recent) {
      byDecision[r.decision] = (byDecision[r.decision] ?? 0) + 1;
    }

    return {
      total: recent.length,
      byDecision,
      escalations: recent.filter((r) => r.decision === 'escalate'),
      failures: recent.filter((r) => r.outcome === 'failure'),
    };
  }

  private _append(record: DecisionRecord): void {
    try {
      fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
      // Scrub credential shapes from the decision record's string fields
      // (rationale / detail can echo a token or an API URL) before persisting:
      // agent-decisions.jsonl is surfaced in the briefing and archived to S3.
      fs.appendFileSync(this.logPath, JSON.stringify(redactDeep(record)) + '\n', 'utf8');
    } catch {
      /* decision log failures must never break the caller */
    }
  }
}

// ── Singleton helper ──────────────────────────────────────────────────────────
// Callers that don't want to manage the DecisionLog instance can use these.

let _defaultLog: DecisionLog | null = null;

export function getDecisionLog(logPath: string): DecisionLog {
  if (!_defaultLog) {
    _defaultLog = new DecisionLog(logPath);
  }
  return _defaultLog;
}

/** Convenience: record a no_action decision for green probes. */
export function recordNoAction(logPath: string, task: string, probe: string): void {
  getDecisionLog(logPath).decide(task, probe, [], 'no_action', 'probe is green');
}
