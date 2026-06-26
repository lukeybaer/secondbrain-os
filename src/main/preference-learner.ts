// preference-learner.ts
//
// Agno LearningMachine pattern: extract revealed user preferences from
// interaction data without explicit instruction.
//
// Agno's LearningMachine (AGENTIC mode): agent autonomously extracts and updates
// user preferences from interactions. Preferences are stored as typed UserMemory
// objects with semantic IDs, evolve per session, and are retrieved on subsequent
// runs for personalization.
//
// Amy adaptation: reads from reflection log + intent queue + call outcomes and uses
// Haiku to extract revealed preferences. Categories mirror Agno's preference types
// but are tuned for an EA use case: time_pattern, communication_style, topic_weight,
// workflow_preference, trust_signal.
//
// Output: data/agent/user-preferences.jsonl
// Each entry is a UserPreference with stable semantic_id (SHA-1 of category+subject).
// Duplicate semantic_ids are merged (latest wins for content, max for confidence).
//
// getPreferenceSummary() -> formatted string for Vapi/briefing injection.
// learnFromInteraction() -> incremental extraction from a single payload.
//
// Run 22 of the nightly enhancement cycle.
// Reference: https://github.com/agno-agi/agno (LearningMachine, UserProfileConfig)

import Anthropic from '@anthropic-ai/sdk';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { getConfig } from './config';

// ── Types ─────────────────────────────────────────────────────────────────────

export type PreferenceCategory =
  | 'time_pattern'         // when ExampleCo works, prefers to be interrupted, quiet hours
  | 'communication_style'  // terse vs detailed, voice vs text, response latency
  | 'topic_weight'         // which subjects ExampleCo cares about most
  | 'workflow_preference'  // how Amy should handle specific types of tasks
  | 'trust_signal';        // explicit approvals, rejections, corrections of Amy's work

export interface UserPreference {
  semantic_id: string;        // SHA-1 of (category + subject) -- stable across updates
  category: PreferenceCategory;
  subject: string;            // 1-sentence label: "prefers voice notes over typing"
  detail: string;             // evidence-backed description
  confidence: number;         // 0.0-1.0
  source: string;             // 'reflection' | 'intent' | 'call_outcome' | 'manual'
  source_ref: string;         // e.g. task name, file, call id
  first_seen: string;         // ISO timestamp
  last_updated: string;       // ISO timestamp
  observation_count: number;  // how many times this preference has been reinforced
}

export interface LearnResult {
  learned: UserPreference[];
  reinforced: UserPreference[]; // preferences updated with higher observation_count
  skippedLow: number;           // below confidence threshold
  totalInQueue: number;         // preferences currently in the JSONL
}

// ── Constants ─────────────────────────────────────────────────────────────────

const CONFIDENCE_THRESHOLD = 0.55;

// ── Helpers ───────────────────────────────────────────────────────────────────

function semanticId(category: string, subject: string): string {
  return crypto
    .createHash('sha1')
    .update(`${category}|${subject.toLowerCase().trim()}`)
    .digest('hex')
    .slice(0, 16);
}

// ── I/O ───────────────────────────────────────────────────────────────────────

export function readPreferences(queuePath: string): UserPreference[] {
  if (!fs.existsSync(queuePath)) return [];
  const lines = fs.readFileSync(queuePath, 'utf8').split('\n').filter((l) => l.trim());
  const map = new Map<string, UserPreference>();
  for (const line of lines) {
    try {
      const p = JSON.parse(line) as UserPreference;
      if (p.semantic_id) map.set(p.semantic_id, p); // last entry wins for each id
    } catch {
      // skip malformed
    }
  }
  return Array.from(map.values());
}

/** Append a new preference entry. Dedup is done at read time (last-wins). */
export function writePreference(queuePath: string, pref: UserPreference): void {
  fs.mkdirSync(path.dirname(queuePath), { recursive: true });
  fs.appendFileSync(queuePath, JSON.stringify(pref) + '\n', 'utf8');
}

// ── Extraction ────────────────────────────────────────────────────────────────

interface RawPreference {
  category: string;
  subject: string;
  detail: string;
  confidence: number;
}

async function extractPreferences(
  sourceText: string,
  source: string,
  client: Anthropic,
): Promise<RawPreference[]> {
  const systemPrompt = `You extract revealed user preferences from interaction data for an AI executive assistant named Amy.

Extract preferences the user REVEALS THROUGH BEHAVIOR or EXPLICIT CORRECTION, not what they say they prefer in the abstract.

Categories:
- time_pattern: when the user works, schedules things, responds, quiet hours
- communication_style: how the user wants Amy to communicate (terse, no em dashes, etc.)
- topic_weight: subjects the user returns to, cares about, or escalates
- workflow_preference: how the user wants specific types of tasks handled
- trust_signal: explicit approvals, corrections, or rejections of Amy's actions

Return JSON array. Each item: { "category": string, "subject": string (max 10 words), "detail": string (max 30 words), "confidence": 0.0-1.0 }
Return [] if no preferences are revealed.`;

  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 600,
    system: systemPrompt,
    messages: [{ role: 'user', content: `Interaction data:\n\n${sourceText.slice(0, 3000)}` }],
  });

  const textBlock = msg.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') return [];

  // Parse JSON, tolerating markdown fences
  const raw = textBlock.text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (p): p is RawPreference =>
        typeof p.category === 'string' &&
        typeof p.subject === 'string' &&
        typeof p.detail === 'string' &&
        typeof p.confidence === 'number',
    );
  } catch {
    return [];
  }
}

// ── Main API ──────────────────────────────────────────────────────────────────

export interface LearnerOptions {
  queuePath: string;
  apiKey?: string;
}

/**
 * Learn preferences from a single interaction payload.
 * Deduplicates: same semantic_id increments observation_count instead of adding duplicate.
 */
export async function learnFromInteraction(
  sourceText: string,
  source: string,
  sourceRef: string,
  opts: LearnerOptions,
): Promise<LearnResult> {
  const apiKey = opts.apiKey ?? getConfig().anthropicApiKey;
  if (!apiKey) {
    return { learned: [], reinforced: [], skippedLow: 0, totalInQueue: 0 };
  }

  const client = new Anthropic({ apiKey });
  const rawPrefs = await extractPreferences(sourceText, source, client);

  const existing = readPreferences(opts.queuePath);
  const existingMap = new Map(existing.map((p) => [p.semantic_id, p]));

  const learned: UserPreference[] = [];
  const reinforced: UserPreference[] = [];
  let skippedLow = 0;
  const now = new Date().toISOString();

  for (const raw of rawPrefs) {
    if (raw.confidence < CONFIDENCE_THRESHOLD) {
      skippedLow++;
      continue;
    }

    const category = raw.category as PreferenceCategory;
    const sid = semanticId(category, raw.subject);
    const prev = existingMap.get(sid);

    if (prev) {
      // Reinforce: bump observation count, update confidence (max), refresh timestamp
      const updated: UserPreference = {
        ...prev,
        confidence: Math.max(prev.confidence, raw.confidence),
        detail: raw.detail, // newer observation overwrites detail
        last_updated: now,
        observation_count: prev.observation_count + 1,
      };
      writePreference(opts.queuePath, updated);
      existingMap.set(sid, updated);
      reinforced.push(updated);
    } else {
      const pref: UserPreference = {
        semantic_id: sid,
        category,
        subject: raw.subject,
        detail: raw.detail,
        confidence: raw.confidence,
        source,
        source_ref: sourceRef,
        first_seen: now,
        last_updated: now,
        observation_count: 1,
      };
      writePreference(opts.queuePath, pref);
      existingMap.set(sid, pref);
      learned.push(pref);
    }
  }

  return {
    learned,
    reinforced,
    skippedLow,
    totalInQueue: existingMap.size,
  };
}

/**
 * Learn from a reflection log file: read last N entries and extract preferences.
 */
export async function learnFromReflectionLog(
  logPath: string,
  opts: LearnerOptions,
  limit = 20,
): Promise<LearnResult> {
  if (!fs.existsSync(logPath)) {
    return { learned: [], reinforced: [], skippedLow: 0, totalInQueue: 0 };
  }
  const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter((l) => l.trim());
  const recentLines = lines.slice(-limit);

  const combined = recentLines
    .map((l) => {
      try {
        const j = JSON.parse(l);
        return `[${j.task}] goal: ${j.goal}. outcome: ${j.outcome}. learnings: ${(j.learnings ?? []).join('; ')}`;
      } catch {
        return l;
      }
    })
    .join('\n');

  return learnFromInteraction(combined, 'reflection', path.basename(logPath), opts);
}

// ── Formatting ────────────────────────────────────────────────────────────────

const CATEGORY_LABELS: Record<PreferenceCategory, string> = {
  time_pattern: 'Time Patterns',
  communication_style: 'Communication Style',
  topic_weight: 'Topic Priorities',
  workflow_preference: 'Workflow Preferences',
  trust_signal: 'Trust Signals',
};

/**
 * Return a formatted summary of all known preferences for Vapi/briefing injection.
 * Sorted by category, then by confidence desc.
 */
export function getPreferenceSummary(queuePath: string): string {
  const prefs = readPreferences(queuePath);
  if (prefs.length === 0) return '';

  const byCategory = new Map<PreferenceCategory, UserPreference[]>();
  for (const p of prefs) {
    if (!byCategory.has(p.category)) byCategory.set(p.category, []);
    byCategory.get(p.category)!.push(p);
  }

  const sections: string[] = ['[LEARNED USER PREFERENCES]'];
  for (const [cat, catPrefs] of byCategory.entries()) {
    const sorted = catPrefs.sort((a, b) => b.confidence - a.confidence || b.observation_count - a.observation_count);
    sections.push(`${CATEGORY_LABELS[cat]}:`);
    for (const p of sorted.slice(0, 5)) {
      sections.push(`  - ${p.subject}: ${p.detail} (seen ${p.observation_count}x)`);
    }
  }
  sections.push('[END PREFERENCES]');
  return sections.join('\n');
}
