// rejection-skill-learning.ts
// RSL — Rejection-Skill-Learning hook.
// Called every time a video is rejected with feedback. Uses Claude Haiku to classify
// the rejection against video-quality-rubric.json, updates weights/miss counts,
// appends an enriched entry to skills/content/LEARNINGS.md, and keeps automation_priority current.

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import Anthropic from '@anthropic-ai/sdk';
import { getConfig } from './config';

// ── Paths ─────────────────────────────────────────────────────────────────────

function contentRoot(): string {
  return (
    process.env.SECONDBRAIN_ROOT ??
    (app.isPackaged ? 'C:/Users/luked/secondbrain' : path.resolve(app.getAppPath()))
  );
}

function rubricPath(): string {
  return path.join(contentRoot(), 'content-review', 'video-quality-rubric.json');
}

function learningsPath(): string {
  return path.join(contentRoot(), 'skills', 'content', 'LEARNINGS.md');
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface RubricCriterion {
  id: string;
  description: string;
  weight: number;
  miss_count: number;
  total_rejections: number;
  detection_accuracy: number;
  keywords: string[];
}

interface RubricCategory {
  criteria: RubricCriterion[];
}

interface Rubric {
  version: number;
  description: string;
  categories: Record<string, RubricCategory>;
  automation_priority: string[];
  last_updated: string;
  notes?: string;
}

interface ClassificationResult {
  matched_criteria: Array<{
    criterion_id: string;
    category: string;
    was_miss: boolean;
    reasoning: string;
  }>;
  new_criteria: Array<{
    category: string;
    description: string;
    keywords: string[];
  }>;
  summary: string;
}

// ── Rubric I/O ────────────────────────────────────────────────────────────────

function loadRubric(): Rubric {
  const p = rubricPath();
  if (!fs.existsSync(p)) {
    throw new Error(`video-quality-rubric.json not found at ${p}`);
  }
  return JSON.parse(fs.readFileSync(p, 'utf8')) as Rubric;
}

function saveRubric(rubric: Rubric): void {
  rubric.last_updated = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(rubricPath(), JSON.stringify(rubric, null, 2), 'utf8');
}

// ── Haiku classification ──────────────────────────────────────────────────────

function buildCriteriaList(rubric: Rubric): string {
  const lines: string[] = [];
  for (const [cat, { criteria }] of Object.entries(rubric.categories)) {
    for (const c of criteria) {
      lines.push(`- ${c.id} [${cat}]: ${c.description}`);
    }
  }
  return lines.join('\n');
}

async function classifyRejection(
  rejectionNote: string,
  target: string,
  videoTitle: string,
  rubric: Rubric,
  apiKey: string,
): Promise<ClassificationResult> {
  const criteriaList = buildCriteriaList(rubric);

  const prompt = `You are a video quality analyst for a short-form content channel (AILifeHacks on YouTube/TikTok).

A video was rejected during human review. Your job is to:
1. Map the rejection reason to the existing rubric criteria (one or more matches)
2. Identify if this is a "miss" — i.e., the QC system SHOULD have caught this automatically but apparently didn't (detection_accuracy problem)
3. Identify any NEW quality issues that don't fit any existing criterion

VIDEO TITLE: ${videoTitle}
REJECTION TARGET: ${target} (video | thumbnail | both)
REJECTION FEEDBACK: "${rejectionNote}"

EXISTING RUBRIC CRITERIA:
${criteriaList}

Respond with ONLY valid JSON in this exact shape:
{
  "matched_criteria": [
    {
      "criterion_id": "<id from above>",
      "category": "<category name>",
      "was_miss": <true if the QC should have auto-detected this, false if it's a subjective/human judgment>,
      "reasoning": "<1 sentence>"
    }
  ],
  "new_criteria": [
    {
      "category": "<Visual|Audio|Content|Technical|Platform>",
      "description": "<short description of the new quality issue>",
      "keywords": ["keyword1", "keyword2"]
    }
  ],
  "summary": "<1-2 sentence plain English summary of what this rejection teaches the system>"
}

Rules:
- matched_criteria can be empty if nothing fits
- new_criteria should only contain genuinely NEW issues not covered by existing criteria
- was_miss = true only when the issue is objective and detectable by automated analysis (e.g., missing file, silent gap, black frame) — NOT for subjective taste issues`;

  const anthropic = new Anthropic({ apiKey });
  const msg = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });

  const block = msg.content[0];
  if (block.type !== 'text') throw new Error('Unexpected response type from Haiku');

  // Strip markdown code fences if present
  const raw = block.text
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/\s*```$/, '');
  return JSON.parse(raw) as ClassificationResult;
}

// ── Rubric update ─────────────────────────────────────────────────────────────

function applyClassificationToRubric(rubric: Rubric, result: ClassificationResult): void {
  const WEIGHT_BUMP = 0.1;
  const MAX_WEIGHT = 5.0;

  // Update matched criteria
  for (const match of result.matched_criteria) {
    for (const { criteria } of Object.values(rubric.categories)) {
      const criterion = criteria.find((c) => c.id === match.criterion_id);
      if (!criterion) continue;

      criterion.total_rejections += 1;
      criterion.weight = Math.min(MAX_WEIGHT, criterion.weight + WEIGHT_BUMP);

      if (match.was_miss) {
        criterion.miss_count += 1;
        // Recalculate detection accuracy: successful detections / total times it should have caught it
        const shouldHaveCaught = criterion.total_rejections;
        const missed = criterion.miss_count;
        criterion.detection_accuracy = Math.max(0, (shouldHaveCaught - missed) / shouldHaveCaught);
      }
    }
  }

  // Add new criteria
  for (const nc of result.new_criteria) {
    const catKey = nc.category as string;
    if (!rubric.categories[catKey]) {
      rubric.categories[catKey] = { criteria: [] };
    }

    // Derive a safe ID from description
    const newId = `${catKey.toLowerCase()}_${nc.description
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '')
      .slice(0, 40)}`;

    // Only add if not already present (defensive)
    const exists = rubric.categories[catKey].criteria.some((c) => c.id === newId);
    if (!exists) {
      rubric.categories[catKey].criteria.push({
        id: newId,
        description: nc.description,
        weight: 1.2, // New criteria start slightly weighted up since they were missed
        miss_count: 1, // First instance was necessarily a miss (it wasn't in the rubric)
        total_rejections: 1,
        detection_accuracy: 0.0,
        keywords: nc.keywords,
      });
    }
  }

  // Recompute automation_priority: sort all criteria by miss_count desc, then weight desc
  const all: Array<{ id: string; miss_count: number; weight: number }> = [];
  for (const { criteria } of Object.values(rubric.categories)) {
    for (const c of criteria) {
      if (c.miss_count > 0) {
        all.push({ id: c.id, miss_count: c.miss_count, weight: c.weight });
      }
    }
  }
  all.sort((a, b) => b.miss_count - a.miss_count || b.weight - a.weight);
  rubric.automation_priority = all.map((c) => c.id);
}

// ── LEARNINGS.md append ───────────────────────────────────────────────────────

function appendToLearnings(
  videoTitle: string,
  target: string,
  note: string,
  result: ClassificationResult,
): void {
  const p = learningsPath();
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  if (!fs.existsSync(p)) {
    fs.writeFileSync(
      p,
      `# Content Production Learnings (RSL)\n\nAuto-generated by the Rejection-Skill-Learning hook. Each entry records what a rejection taught the system and which rubric criteria were affected.\n\n---\n\n`,
      'utf8',
    );
  }

  const date = new Date().toISOString().slice(0, 10);
  const affectedCriteria =
    result.matched_criteria.length > 0
      ? result.matched_criteria.map((m) => `\`${m.criterion_id}\``).join(', ')
      : '_none matched — may have added new criterion_';

  const missNote =
    result.matched_criteria.filter((m) => m.was_miss).length > 0
      ? `\n> **Missed by QC:** ${result.matched_criteria
          .filter((m) => m.was_miss)
          .map((m) => `\`${m.criterion_id}\``)
          .join(', ')}`
      : '';

  const newCriteriaNote =
    result.new_criteria.length > 0
      ? `\n> **New criteria added:** ${result.new_criteria.map((n) => n.description).join('; ')}`
      : '';

  const entry = `## [${date}] ${videoTitle} (${target} rejected)\n\n**Feedback:** ${note}\n\n**Rubric criteria affected:** ${affectedCriteria}${missNote}${newCriteriaNote}\n\n**What the system should do differently:** ${result.summary}\n\n---\n\n`;

  fs.appendFileSync(p, entry, 'utf8');
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface RejectionLearningInput {
  videoId: string;
  videoTitle: string;
  channel: string;
  target: string;
  note: string;
}

export async function processRejectionLearning(input: RejectionLearningInput): Promise<void> {
  const { videoTitle, target, note } = input;

  const config = getConfig();
  const apiKey = config.anthropicApiKey;
  if (!apiKey) {
    console.warn('[rsl] No Anthropic API key — skipping RSL classification');
    return;
  }

  let rubric: Rubric;
  try {
    rubric = loadRubric();
  } catch (err) {
    console.error('[rsl] Failed to load rubric:', err);
    return;
  }

  let result: ClassificationResult;
  try {
    result = await classifyRejection(note, target, videoTitle, rubric, apiKey);
  } catch (err) {
    console.error('[rsl] Haiku classification failed:', err);
    // Still append a basic LEARNINGS entry even if classification fails
    appendToLearnings(videoTitle, target, note, {
      matched_criteria: [],
      new_criteria: [],
      summary: '(classification unavailable)',
    });
    return;
  }

  try {
    applyClassificationToRubric(rubric, result);
    saveRubric(rubric);
  } catch (err) {
    console.error('[rsl] Failed to update rubric:', err);
  }

  try {
    appendToLearnings(videoTitle, target, note, result);
  } catch (err) {
    console.error('[rsl] Failed to append to LEARNINGS.md:', err);
  }

  console.log(
    `[rsl] Processed rejection for "${videoTitle}" — ` +
      `matched:${result.matched_criteria.length} new:${result.new_criteria.length} ` +
      `misses:${result.matched_criteria.filter((m) => m.was_miss).length}`,
  );
}

// ── Nightly priority refresh ──────────────────────────────────────────────────
// Called by scheduler at 3:00 AM. Re-reads the rubric and ensures automation_priority
// reflects current miss counts — handles any drift from manual edits to the rubric.

export function refreshAutomationPriority(): {
  priority: string[];
  topMissed: Array<{ id: string; miss_count: number; description: string }>;
} {
  let rubric: Rubric;
  try {
    rubric = loadRubric();
  } catch {
    return { priority: [], topMissed: [] };
  }

  const all: Array<{ id: string; miss_count: number; weight: number; description: string }> = [];
  for (const { criteria } of Object.values(rubric.categories)) {
    for (const c of criteria) {
      if (c.miss_count > 0) {
        all.push({
          id: c.id,
          miss_count: c.miss_count,
          weight: c.weight,
          description: c.description,
        });
      }
    }
  }
  all.sort((a, b) => b.miss_count - a.miss_count || b.weight - a.weight);

  rubric.automation_priority = all.map((c) => c.id);
  saveRubric(rubric);

  const topMissed = all.slice(0, 5).map(({ id, miss_count, description }) => ({
    id,
    miss_count,
    description,
  }));

  return { priority: rubric.automation_priority, topMissed };
}
