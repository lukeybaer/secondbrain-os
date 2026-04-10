/**
 * People Data Health Check
 *
 * Scans all contact .md files and produces structured metadata:
 * - File size (bytes, lines)
 * - Richness score (0-100) based on presence of key fields
 * - Field presence flags: phone, email, company, address, family, goals, birthday, notes, last_interaction
 * - Word count, section count
 *
 * Outputs: contacts/_health-snapshot.json
 */

const fs = require('fs');
const path = require('path');

const CONTACTS_DIR = path.join(
  process.env.USERPROFILE || process.env.HOME,
  '.claude',
  'projects',
  'C--Users-luked-secondbrain',
  'memory',
  'contacts',
);

const SNAPSHOT_PATH = path.join(CONTACTS_DIR, '_health-snapshot.json');

function analyzeFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const words = content.split(/\s+/).filter(Boolean).length;
  const lowerContent = content.toLowerCase();

  // Field detection patterns
  const hasPhone = /(\+?\d[\d\s\-().]{7,}|\bphone\b|\btel\b|\bcell\b)/i.test(content);
  const hasEmail = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/i.test(content);
  const hasCompany =
    /\b(company|org|employer|work|amazon|onity|vapi|saasinct|bai|itm|abbyy|yelp|salesforce|microsoft|google|meta|epam|dailypay|tebra|mindbody|intuit|doordash|ziprecruiter|five9|smartsheet)\b/i.test(
      content,
    );
  const hasAddress = /\b(address|street|avenue|blvd|road|city|state|zip|apt|suite|\d{5})\b/i.test(
    content,
  );
  const hasFamily =
    /\b(wife|husband|spouse|daughter|son|kids|children|baby|married|fiancee?|family|mom|dad|father|mother|brother|sister)\b/i.test(
      content,
    );
  const hasGoals =
    /\b(goal|wants?|plan|aspir|dream|target|objective|looking for|interested in|exploring|seeking)\b/i.test(
      content,
    );
  const hasBirthday = /\b(birthday|born|bday|dob|b-day|birth date|anniversary)\b/i.test(content);
  const hasNotes = /\b(note|context|background|history|met at|known from|relationship)\b/i.test(
    content,
  );
  const hasLastInteraction =
    /\b(last (contact|interaction|call|chat|email|meeting|spoke|talked)|as of|updated|recent)\b/i.test(
      content,
    );
  const hasPersonality =
    /\b(personality|values|character|faith|christian|humble|direct|smart|nice|honest|loyal|ambitious|introvert|extrovert)\b/i.test(
      content,
    );
  const hasLocation =
    /\b(lives? in|based in|located|moved to|from |city|state|country|mckinney|dallas|seattle|sf|nyc|toronto|austin)\b/i.test(
      content,
    );
  const hasLinkedIn = /\blinkedin\b/i.test(content);

  // Count markdown sections (## headers)
  const sectionCount = (content.match(/^#{1,3}\s/gm) || []).length;

  // Richness score (weighted)
  const weights = {
    phone: 10,
    email: 8,
    company: 8,
    address: 5,
    family: 12,
    goals: 10,
    birthday: 5,
    personality: 10,
    location: 7,
    lastInteraction: 8,
    linkedin: 3,
    notes: 5,
    // Bonus for depth
    wordCount50: 3, // 50+ words
    wordCount150: 5, // 150+ words
    wordCount300: 6, // 300+ words
    sections3: 5, // 3+ sections
  };

  let score = 0;
  if (hasPhone) score += weights.phone;
  if (hasEmail) score += weights.email;
  if (hasCompany) score += weights.company;
  if (hasAddress) score += weights.address;
  if (hasFamily) score += weights.family;
  if (hasGoals) score += weights.goals;
  if (hasBirthday) score += weights.birthday;
  if (hasPersonality) score += weights.personality;
  if (hasLocation) score += weights.location;
  if (hasLastInteraction) score += weights.lastInteraction;
  if (hasLinkedIn) score += weights.linkedin;
  if (hasNotes) score += weights.notes;
  if (words >= 50) score += weights.wordCount50;
  if (words >= 150) score += weights.wordCount150;
  if (words >= 300) score += weights.wordCount300;
  if (sectionCount >= 3) score += weights.sections3;

  // Normalize to 0-100
  const maxScore = Object.values(weights).reduce((a, b) => a + b, 0);
  const normalizedScore = Math.round((score / maxScore) * 100);

  return {
    file: path.basename(filePath),
    bytes: Buffer.byteLength(content, 'utf-8'),
    lines: lines.length,
    words,
    sections: sectionCount,
    richness: normalizedScore,
    fields: {
      phone: hasPhone,
      email: hasEmail,
      company: hasCompany,
      address: hasAddress,
      family: hasFamily,
      goals: hasGoals,
      birthday: hasBirthday,
      personality: hasPersonality,
      location: hasLocation,
      lastInteraction: hasLastInteraction,
      linkedin: hasLinkedIn,
      notes: hasNotes,
    },
  };
}

function run() {
  const files = fs
    .readdirSync(CONTACTS_DIR)
    .filter(
      (f) => f.endsWith('.md') && !f.startsWith('_') && f !== 'INDEX.md' && !f.startsWith('PHASE'),
    );

  const profiles = files.map((f) => analyzeFile(path.join(CONTACTS_DIR, f)));

  // Aggregate stats
  const totalFiles = profiles.length;
  const avgRichness = Math.round(profiles.reduce((s, p) => s + p.richness, 0) / totalFiles);
  const avgWords = Math.round(profiles.reduce((s, p) => s + p.words, 0) / totalFiles);
  const avgLines = Math.round(profiles.reduce((s, p) => s + p.lines, 0) / totalFiles);

  // Field coverage
  const fieldNames = Object.keys(profiles[0].fields);
  const fieldCoverage = {};
  for (const f of fieldNames) {
    const count = profiles.filter((p) => p.fields[f]).length;
    fieldCoverage[f] = { count, pct: Math.round((count / totalFiles) * 100) + '%' };
  }

  // Tiers
  const rich = profiles.filter((p) => p.richness >= 60).length;
  const moderate = profiles.filter((p) => p.richness >= 30 && p.richness < 60).length;
  const thin = profiles.filter((p) => p.richness < 30).length;

  // Top 10 richest
  const top10 = [...profiles]
    .sort((a, b) => b.richness - a.richness)
    .slice(0, 10)
    .map((p) => ({ file: p.file, richness: p.richness, words: p.words }));

  // Bottom 10 thinnest
  const bottom10 = [...profiles]
    .sort((a, b) => a.richness - b.richness)
    .slice(0, 10)
    .map((p) => ({ file: p.file, richness: p.richness, words: p.words }));

  const snapshot = {
    timestamp: new Date().toISOString(),
    summary: {
      totalFiles,
      avgRichness,
      avgWords,
      avgLines,
      tiers: { rich, moderate, thin },
      fieldCoverage,
    },
    top10,
    bottom10,
    profiles: profiles.sort((a, b) => a.file.localeCompare(b.file)),
  };

  // Load previous snapshot for diff if exists
  let diff = null;
  if (fs.existsSync(SNAPSHOT_PATH)) {
    try {
      const prev = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf-8'));
      diff = computeDiff(prev, snapshot);
    } catch (e) {
      // no diff available
    }
  }

  if (diff) {
    snapshot.diff_from_previous = diff;
  }

  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2));
  console.log(
    JSON.stringify(
      {
        summary: snapshot.summary,
        top10: snapshot.top10,
        bottom10: snapshot.bottom10,
        diff: diff || 'No previous snapshot to diff against',
      },
      null,
      2,
    ),
  );
}

function computeDiff(prev, curr) {
  const prevMap = {};
  for (const p of prev.profiles || []) {
    prevMap[p.file] = p;
  }
  const currMap = {};
  for (const p of curr.profiles || []) {
    currMap[p.file] = p;
  }

  const added = curr.profiles.filter((p) => !prevMap[p.file]).map((p) => p.file);
  const removed = (prev.profiles || []).filter((p) => !currMap[p.file]).map((p) => p.file);

  const changed = [];
  for (const p of curr.profiles) {
    const old = prevMap[p.file];
    if (!old) continue;
    const wordDelta = p.words - old.words;
    const richnessDelta = p.richness - old.richness;
    const linesDelta = p.lines - old.lines;
    if (wordDelta !== 0 || richnessDelta !== 0) {
      changed.push({
        file: p.file,
        wordDelta,
        richnessDelta,
        linesDelta,
        oldRichness: old.richness,
        newRichness: p.richness,
      });
    }
  }

  // Structural change percentage
  const totalPrev = prev.profiles ? prev.profiles.length : 0;
  const structuralChanges = added.length + removed.length + changed.length;
  const structuralChangePct = totalPrev > 0 ? Math.round((structuralChanges / totalPrev) * 100) : 0;

  return {
    previousTimestamp: prev.timestamp,
    filesAdded: added,
    filesRemoved: removed,
    filesChanged: changed.sort((a, b) => Math.abs(b.richnessDelta) - Math.abs(a.richnessDelta)),
    structuralChangePct,
    summaryDelta: {
      avgRichness: curr.summary.avgRichness - prev.summary.avgRichness,
      avgWords: curr.summary.avgWords - prev.summary.avgWords,
      totalFiles: curr.summary.totalFiles - prev.summary.totalFiles,
    },
  };
}

run();
