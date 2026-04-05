/**
 * sermons.ts
 *
 * Peter's sermon collection system. Detects sermons from Peter (Luke's dad)
 * in ingested Otter.ai conversations and stores them in a dedicated collection
 * for the "Book of Sermons" project.
 *
 * Detection heuristics:
 *   1. Peter is in speakers or peopleMentioned
 *   2. Religious/biblical content (topics, keywords, transcript)
 *   3. Teaching/sermon format (single primary speaker, religious themes)
 *
 * Storage: %APPDATA%/secondbrain/data/sermons/{id}/
 *   - meta.json  (sermon metadata)
 *   - transcript.txt (full transcript)
 */

import * as fs from 'fs';
import * as path from 'path';
import { getConfig } from './config';
import { ConversationMeta, loadConversation } from './storage';

// ── Types ────────────────────────────────────────────────────────────────────

export interface SermonMeta {
  id: string;
  sourceConversationId: string;
  title: string;
  date: string;
  durationMinutes: number;
  speaker: string;
  summary: string;
  topics: string[];
  keywords: string[];
  otherParticipants: string[];
  detectedAt: string;
}

// ── Storage ──────────────────────────────────────────────────────────────────

function getSermonsDir(): string {
  return path.join(getConfig().dataDir, 'sermons');
}

export function ensureSermonsDir(): void {
  const dir = getSermonsDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function saveSermon(meta: SermonMeta, transcript: string): void {
  ensureSermonsDir();
  const sermonDir = path.join(getSermonsDir(), meta.id);
  if (!fs.existsSync(sermonDir)) {
    fs.mkdirSync(sermonDir, { recursive: true });
  }
  fs.writeFileSync(path.join(sermonDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf-8');
  fs.writeFileSync(path.join(sermonDir, 'transcript.txt'), transcript, 'utf-8');
}

export function listSermons(): SermonMeta[] {
  ensureSermonsDir();
  const dir = getSermonsDir();
  const results: SermonMeta[] = [];
  try {
    const dirs = fs.readdirSync(dir);
    for (const d of dirs) {
      const metaFile = path.join(dir, d, 'meta.json');
      if (fs.existsSync(metaFile)) {
        try {
          results.push(JSON.parse(fs.readFileSync(metaFile, 'utf-8')) as SermonMeta);
        } catch {
          // skip malformed
        }
      }
    }
  } catch {
    // dir doesn't exist yet
  }
  return results.sort((a, b) => b.date.localeCompare(a.date));
}

export function sermonExistsForConversation(conversationId: string): boolean {
  return listSermons().some((s) => s.sourceConversationId === conversationId);
}

// ── Detection ────────────────────────────────────────────────────────────────

const RELIGIOUS_KEYWORDS = new Set([
  'jesus',
  'christ',
  'god',
  'holy spirit',
  'scripture',
  'bible',
  'gospel',
  'sermon',
  'church',
  'faith',
  'prayer',
  'worship',
  'salvation',
  'sin',
  'baptism',
  'revelation',
  'prophecy',
  'apostle',
  'apostles',
  'disciple',
  'leprosy',
  'anointing',
  'denomination',
  'pentecostal',
  'baptist',
  'catholic',
  'protestant',
  'testament',
  'psalm',
  'proverbs',
  'genesis',
  'exodus',
  'leviticus',
  'deuteronomy',
  'acts',
  'corinthians',
  'ephesians',
  'hebrews',
  'romans',
  'matthew',
  'mark',
  'luke',
  'john',
  'book of enoch',
  'council of nicaea',
  'scofield',
  'ethiopian bible',
  'apostasy',
  'atonement',
  'crucifixion',
  'resurrection',
  'grace',
  'mercy',
  'repentance',
  'forgiveness',
  'heaven',
  'hell',
  'spiritual',
  'righteousness',
  'sanctification',
  'redemption',
  'covenant',
]);

const PETER_NAMES = ['peter', 'peter millar', 'dad'];

/**
 * Detect whether a conversation is a sermon/teaching from Peter.
 * Returns a confidence score 0–1.
 */
export function detectPeterSermon(
  meta: ConversationMeta,
  transcript: string,
): {
  isSermon: boolean;
  confidence: number;
  reasons: string[];
} {
  const reasons: string[] = [];
  let score = 0;

  // Check 1: Is Peter mentioned as speaker or participant?
  const allNames = [
    ...meta.speakers.map((s) => s.toLowerCase()),
    ...meta.peopleMentioned.map((p) => p.toLowerCase()),
  ];

  const peterPresent = allNames.some((name) => PETER_NAMES.some((pn) => name.includes(pn)));

  // Also check transcript for "dad" references (Luke calling Peter "dad")
  const transcriptLower = transcript.toLowerCase();
  const dadInTranscript =
    /\bdad\b/.test(transcriptLower) &&
    (transcriptLower.includes('scripture') ||
      transcriptLower.includes('jesus') ||
      transcriptLower.includes('god'));

  // Check for Luke's explicit markers like "this conversation is with Peter"
  const explicitPeterMarker =
    /conversation.*(?:is |with )peter|peter.*(?:my|luke's).*(?:dad|father)/i.test(transcript);

  if (explicitPeterMarker) {
    score += 0.5;
    reasons.push('explicit Peter marker in transcript');
  } else if (peterPresent) {
    score += 0.3;
    reasons.push('Peter in speakers/peopleMentioned');
  } else if (dadInTranscript) {
    score += 0.2;
    reasons.push("'dad' reference with religious context in transcript");
  }

  // Check 2: Religious content density
  const allText = [...meta.topics, ...meta.keywords, meta.summary].join(' ').toLowerCase();

  let religiousHits = 0;
  for (const kw of RELIGIOUS_KEYWORDS) {
    if (allText.includes(kw) || transcriptLower.includes(kw)) {
      religiousHits++;
    }
  }

  if (religiousHits >= 8) {
    score += 0.4;
    reasons.push(`strong religious content (${religiousHits} keyword hits)`);
  } else if (religiousHits >= 4) {
    score += 0.25;
    reasons.push(`moderate religious content (${religiousHits} keyword hits)`);
  } else if (religiousHits >= 2) {
    score += 0.1;
    reasons.push(`some religious content (${religiousHits} keyword hits)`);
  }

  // Check 3: Duration — sermons are typically 10+ minutes
  if (meta.durationMinutes >= 15) {
    score += 0.1;
    reasons.push(`sermon-length duration (${meta.durationMinutes} min)`);
  }

  // Check 4: Meeting type — "other" is common for sermons (not a work meeting)
  if (meta.meetingType === 'other' || meta.meetingType === 'workshop') {
    score += 0.05;
    reasons.push(`non-work meeting type (${meta.meetingType})`);
  }

  // Threshold: Peter must be involved AND content must be religious
  const isSermon = score >= 0.5 && (peterPresent || dadInTranscript || explicitPeterMarker);

  return { isSermon, confidence: Math.min(score, 1), reasons };
}

// ── Post-ingest hook ─────────────────────────────────────────────────────────

/**
 * Called after a conversation is tagged and saved during otter-ingest.
 * If it's a Peter sermon, copies it to the sermons collection.
 */
export function processConversationForSermon(meta: ConversationMeta, transcript: string): boolean {
  if (sermonExistsForConversation(meta.id)) return false;

  const result = detectPeterSermon(meta, transcript);
  if (!result.isSermon) return false;

  const sermonMeta: SermonMeta = {
    id: `sermon-${meta.date}-${meta.otterId.slice(0, 8)}`,
    sourceConversationId: meta.id,
    title: meta.title || `Peter's Teaching — ${meta.date}`,
    date: meta.date,
    durationMinutes: meta.durationMinutes,
    speaker: 'Peter Millar',
    summary: meta.summary,
    topics: meta.topics,
    keywords: meta.keywords.filter(
      (k) => RELIGIOUS_KEYWORDS.has(k.toLowerCase()) || k.toLowerCase().includes('peter'),
    ),
    otherParticipants: meta.speakers.filter(
      (s) => !PETER_NAMES.some((pn) => s.toLowerCase().includes(pn)),
    ),
    detectedAt: new Date().toISOString(),
  };

  saveSermon(sermonMeta, transcript);
  console.log(
    `[sermons] Detected and saved Peter sermon: ${sermonMeta.title} (${meta.date}), confidence: ${result.confidence.toFixed(2)}, reasons: ${result.reasons.join('; ')}`,
  );
  return true;
}

// ── Weekly briefing section ──────────────────────────────────────────────────

/**
 * Generate the sermon section for the Saturday weekly briefing.
 */
export function generateSermonBriefingSection(): string {
  const allSermons = listSermons();
  const totalCount = allSermons.length;

  if (totalCount === 0) {
    return ["PETER'S SERMONS:", '  No sermons captured yet.', ''].join('\n');
  }

  // Find sermons from the past 7 days
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  const weekAgoStr = weekAgo.toISOString().slice(0, 10);
  const newSermons = allSermons.filter((s) => s.date >= weekAgoStr);

  // Date range of all sermons
  const earliest = allSermons[allSermons.length - 1].date;
  const latest = allSermons[0].date;

  const lines: string[] = [];
  lines.push("PETER'S SERMONS:");

  if (newSermons.length > 0) {
    lines.push(`  New this week: ${newSermons.length}`);
    for (const s of newSermons) {
      // One-line topic summary from the first few topics
      const topicLine = s.topics.length > 0 ? s.topics.slice(0, 3).join(', ') : s.title;
      lines.push(`    • ${s.date} — ${topicLine}`);
    }
  } else {
    lines.push('  No new sermons this week.');
  }

  lines.push(`  Collection: ${totalCount} total (${earliest} to ${latest})`);

  lines.push('');
  return lines.join('\n');
}
