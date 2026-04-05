/**
 * One-time script to seed the sermons collection from existing conversations.
 * Run: npx tsx scripts/seed-sermons.ts
 */

import * as fs from 'fs';
import * as path from 'path';

// We can't import from the Electron app modules directly (they use `app` from electron),
// so we replicate the minimal logic needed here.

const DATA_DIR = path.join(process.env.APPDATA || '', 'secondbrain', 'data');
const SERMONS_DIR = path.join(DATA_DIR, 'sermons');

interface ConversationMeta {
  id: string;
  otterId: string;
  title: string;
  date: string;
  durationMinutes: number;
  speakers: string[];
  myRole: string;
  meetingType: string;
  summary: string;
  topics: string[];
  keywords: string[];
  peopleMentioned: string[];
  companiesMentioned: string[];
  decisions: string[];
  sentiment: string;
  transcriptFile: string;
  taggedAt: string;
}

interface SermonMeta {
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

// Known Peter sermon conversation IDs (identified manually)
const SERMON_CONV_IDS = [
  'otter_D3lfvlx20EvmbPDHAlLrgHweKmY', // 2025-10-12 Spiritual Growth and Trust
  'otter_WrTBkXObLheSFNRTbWYC5m_lnL8', // 2025-10-18 Religious and Political Concerns
  'otter_ZAP1kdMSGAaBI83iTxYcwPPaWBQ', // 2025-12-31 Church Leadership Conflict
  'otter_b_93xPBj3aJmaoTT0sgJzeZAnDI', // 2026-01-01 Emotional and Spiritual Reflection
  'otter_xsbYU2nHMONoDuy9Vtzc8epuwV4', // 2026-04-04 Ethiopian Bible & Book of Enoch
];

fs.mkdirSync(SERMONS_DIR, { recursive: true });

let saved = 0;
for (const convId of SERMON_CONV_IDS) {
  const convDir = path.join(DATA_DIR, 'conversations', convId);
  const metaFile = path.join(convDir, 'meta.json');
  const transcriptFile = path.join(convDir, 'transcript.txt');

  if (!fs.existsSync(metaFile)) {
    console.log(`SKIP (not found): ${convId}`);
    continue;
  }

  const meta: ConversationMeta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
  const transcript = fs.existsSync(transcriptFile) ? fs.readFileSync(transcriptFile, 'utf-8') : '';

  const sermonId = `sermon-${meta.date}-${meta.otterId.slice(0, 8)}`;
  const sermonDir = path.join(SERMONS_DIR, sermonId);

  if (fs.existsSync(sermonDir)) {
    console.log(`SKIP (exists): ${sermonId} — ${meta.title}`);
    continue;
  }

  const sermonMeta: SermonMeta = {
    id: sermonId,
    sourceConversationId: meta.id,
    title: meta.title || `Peter's Teaching — ${meta.date}`,
    date: meta.date,
    durationMinutes: meta.durationMinutes,
    speaker: 'Peter Millar',
    summary: meta.summary,
    topics: meta.topics,
    keywords: meta.keywords,
    otherParticipants: meta.speakers.filter(
      (s) => !['peter', 'peter millar'].includes(s.toLowerCase()),
    ),
    detectedAt: new Date().toISOString(),
  };

  fs.mkdirSync(sermonDir, { recursive: true });
  fs.writeFileSync(path.join(sermonDir, 'meta.json'), JSON.stringify(sermonMeta, null, 2), 'utf-8');
  fs.writeFileSync(path.join(sermonDir, 'transcript.txt'), transcript, 'utf-8');

  console.log(`SAVED: ${sermonId} — ${meta.title} (${meta.date}, ${meta.durationMinutes} min)`);
  saved++;
}

console.log(`\nDone. Saved ${saved} sermons to ${SERMONS_DIR}`);

// List all sermons
const allDirs = fs
  .readdirSync(SERMONS_DIR)
  .filter((d) => fs.existsSync(path.join(SERMONS_DIR, d, 'meta.json')));
console.log(`\nSermon collection (${allDirs.length} total):`);
for (const d of allDirs.sort()) {
  const m: SermonMeta = JSON.parse(
    fs.readFileSync(path.join(SERMONS_DIR, d, 'meta.json'), 'utf-8'),
  );
  console.log(`  ${m.date} | ${m.title} | ${m.durationMinutes} min`);
}
