// agent-reflection.ts
//
// CrewAI/AutoGen inspired reflection records. After a multi-step task Amy
// appends a structured reflection entry: goal, steps, outcome, learnings.
// This is intentionally minimal — one function, one record type, one file.
//
// The reflection log already exists at data/agent/ea-reflection-log.jsonl.
// This module adds a typed append so the nightly briefing can aggregate
// "what Amy learned last night" as a first-class section without scraping
// free-form markdown.

import * as fs from 'fs';
import * as path from 'path';

export type ReflectionOutcome = 'success' | 'partial' | 'failure' | 'dry-run';

export interface ReflectionRecord {
  timestamp: string;
  task: string;
  goal: string;
  steps: string[];
  outcome: ReflectionOutcome;
  learnings: string[];
  related_files?: string[];
}

export function buildReflection(
  task: string,
  goal: string,
  steps: string[],
  outcome: ReflectionOutcome,
  learnings: string[],
  related_files?: string[],
): ReflectionRecord {
  return {
    timestamp: new Date().toISOString(),
    task,
    goal,
    steps,
    outcome,
    learnings,
    ...(related_files && related_files.length > 0 ? { related_files } : {}),
  };
}

export function appendReflection(logPath: string, record: ReflectionRecord): void {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, JSON.stringify(record) + '\n');
}

export function readReflections(logPath: string, limit = 50): ReflectionRecord[] {
  if (!fs.existsSync(logPath)) return [];
  const lines = fs
    .readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0);
  const slice = lines.slice(-limit);
  const records: ReflectionRecord[] = [];
  for (const line of slice) {
    try {
      records.push(JSON.parse(line) as ReflectionRecord);
    } catch {
      /* skip malformed lines */
    }
  }
  return records;
}
