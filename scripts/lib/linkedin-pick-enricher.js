#!/usr/bin/env node
/**
 * linkedin-pick-enricher.js
 *
 * Deterministic enricher for LinkedIn reach-out picks emitted by
 * refresh-briefing-generated-sections.js.
 *
 * Background (2026-05-23): refresh-briefing-generated-sections.js used to emit
 * only "when:" and "post:" lines per pick, which meant the dashboard rendered
 * "Context:" empty and fell back to a generic "Hi <name>, It has been too long
 * since we connected. You came to mind this week." draft for every pick.
 *
 * Fix: this module pulls per-contact data from secondbrain/memory/contacts/
 * and builds the four enrichment fields the dashboard parser
 * (ec2-server.js parseLinkedInBody) walks: context, draft, profile, and the
 * "Why this note" block. No claude calls; deterministic from the contact
 * file frontmatter + sections + the event headline.
 *
 * Manual-briefing-v3.js retains the heavier claude-driven path for the full
 * morning briefing; this module is the lightweight enrichment path for the
 * refresh script that runs without claude available.
 */

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const CONTACTS_DIR = path.join(REPO, 'memory', 'contacts');

// Luke's priority anchors, kept short so generated bullets stay readable.
const LUKE_PRIORITY_ANCHORS = [
  'PixSeat (stadium + security + AI ventures)',
  'C-suite path (CTO/CPO/CSO)',
  'AI/automation thought leadership',
  'BAI/ITM recovery app build',
  'SecondBrain autonomous EA',
];

// Em-dash and en-dash code points kept as char classes to avoid embedding the
// glyphs in source (the em-dash-guard hook blocks U+2014/U+2013 in source).
const DASH_RE = new RegExp(`[\\u2014\\u2013]`, 'g');

function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function candidatePaths(name) {
  const slug = slugify(name);
  if (!slug) return [];
  const parts = slug.split('_');
  const candidates = [slug];
  // Common variants: first_last, last_first, first (first-name-only fallback)
  if (parts.length === 2) {
    candidates.push(`${parts[1]}_${parts[0]}`);
  }
  if (parts.length >= 2) {
    candidates.push(parts[0]);
  }
  return Array.from(new Set(candidates)).map((c) => path.join(CONTACTS_DIR, `${c}.md`));
}

function loadContactFileByName(name) {
  for (const p of candidatePaths(name)) {
    try {
      if (fs.existsSync(p)) {
        return { path: p, raw: fs.readFileSync(p, 'utf8') };
      }
    } catch {
      // best effort
    }
  }
  return null;
}

function parseFrontmatter(raw) {
  // Normalize CRLF so the regex works on both Windows-and Unix-written files.
  const normalized = String(raw || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const m = normalized.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^\s*([a-z_]+)\s*:\s*(.+?)\s*$/i);
    if (kv) out[kv[1].toLowerCase()] = kv[2].replace(/^['"]|['"]$/g, '');
  }
  return out;
}

function extractSection(raw, heading) {
  // Walk line-by-line so we capture from the matching "## Heading" up to the
  // next "## " heading or end of file. JS regex has no \Z anchor so a single
  // expression is awkward.
  const target = String(heading).trim().toLowerCase();
  const lines = String(raw || '').split('\n');
  let inSection = false;
  const buf = [];
  for (const line of lines) {
    const hm = line.match(/^##\s+(.+?)\s*$/);
    if (hm) {
      if (inSection) break;
      if (hm[1].trim().toLowerCase() === target) {
        inSection = true;
        continue;
      }
    } else if (inSection) {
      buf.push(line);
    }
  }
  return buf.join('\n').trim();
}

function firstMeaningfulLine(block, maxLen = 220) {
  if (!block) return '';
  const lines = String(block).split('\n')
    .map((l) => l.replace(/^[-*\s•]+/, '').replace(/\*\*/g, '').trim())
    .filter((l) => l.length > 15)
    .filter((l) => !/^(History|Professional|What They|Trending|Predictions|Contact Info)\b/i.test(l));
  if (!lines.length) return '';
  const out = lines[0];
  return out.length > maxLen ? out.slice(0, maxLen - 1) + '...' : out;
}

function parseContactFile(raw) {
  if (!raw) return null;
  const fm = parseFrontmatter(raw);
  // Try the more-specific heading first: "History (Recent)" captures rolling
  // interaction logs written by nightly enrichers; bare "History" is the legacy
  // fallback for older files that haven't been updated.
  const history =
    extractSection(raw, 'History (Recent)') ||
    extractSection(raw, 'History');
  return {
    name: fm.name || '',
    description: fm.description || '',
    category: fm.category || '',
    warmth: fm.warmth || fm.category || '',
    linkedin: fm.linkedin || '',
    lastInteraction: (fm.last_interaction || '').replace(/['"]/g, '').trim(),
    professional: extractSection(raw, 'Professional'),
    postsAbout: extractSection(raw, 'What They Post About'),
    beliefs: extractSection(raw, 'What They Believe In'),
    relationship: extractSection(raw, 'Relationship'),
    history,
    trending: extractSection(raw, 'Trending Toward'),
    predictions: extractSection(raw, 'Predictions'),
  };
}

function firstName(fullName) {
  return String(fullName || '').trim().split(/\s+/)[0] || '';
}

function cleanText(s) {
  return String(s || '')
    .replace(/\r/g, '')
    .replace(DASH_RE, ', ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compressHeadline(headline) {
  if (!headline) return '';
  let h = cleanText(headline);
  // The bulk-scan headlines start with "<Name>, Feed post number N <Name>
  // reposted this <Other Name> ..." Strip the leading reposted boilerplate so
  // the meaningful content shows up first.
  h = h.replace(/^[A-Z][^,]+,?\s+Feed post number \d+\s+[A-Z][^,]+,?\s+(reposted this)?\s*/i, '');
  h = h.replace(/^\d+\s*(?:d|w|mo|h|yr)\s*•\s*(?:ago)?\s*/i, '');
  return h.slice(0, 200).trim();
}

function buildContext(ev, cf) {
  const headline = compressHeadline((ev && ev.headline) || '');
  const desc = cf ? cleanText(cf.description) : '';
  if (desc && headline) {
    return cleanText(`${desc}. Recent activity: ${headline}`).slice(0, 280);
  }
  if (desc) return desc.slice(0, 280);
  if (headline) return headline;
  return 'No contact file context available, contact not yet enriched.';
}

function buildDraft(ev, cf) {
  const first = firstName((ev && ev.contactName) || (cf && cf.name) || '');
  const headline = compressHeadline((ev && ev.headline) || '');
  const postTopic = cf ? firstMeaningfulLine(cf.postsAbout, 140) : '';

  // Active relationships (hot/inner-circle) get a comment-style engagement draft,
  // not a cold-outreach message. The framing is "I saw your post, good angle" not
  // "can we connect?"
  if (cf && isActiveRelationship(cf)) {
    const lines = [];
    if (first) lines.push(`${first},`);
    if (headline) {
      lines.push(`solid post.${postTopic ? ' The angle on ' + postTopic.replace(/[.,]$/, '') + ' is the right frame.' : ''} Aligns with what we have been building.`);
    } else if (postTopic) {
      lines.push(`the ${postTopic.replace(/[.,]$/, '')} thread you are developing is exactly the right frame for what we are doing.`);
    } else {
      lines.push('strong perspective. The systems angle you take is the clearest framing I have seen on this.');
    }
    lines.push('Worth amplifying from the PixSeat side too. Luke');
    return cleanText(lines.join(' '));
  }

  const overlap = cf ? firstMeaningfulLine(cf.trending || cf.professional, 140) : '';
  const lines = [];
  if (first) lines.push(`${first},`);
  if (headline) {
    lines.push(`saw your recent post${postTopic ? ' on ' + postTopic.replace(/[.,]$/, '') : ''}. It connects to work I am doing on autonomous AI systems for ops and decision-making.`);
  } else if (postTopic) {
    lines.push(`been thinking about your work on ${postTopic.replace(/[.,]$/, '')}. It overlaps with what I am building on the autonomous AI side.`);
  } else {
    lines.push('been thinking about your recent work. The questions you are pushing on overlap with where I am spending my time on AI systems for operations.');
  }
  if (overlap) {
    lines.push(`Given ${overlap.replace(/[.,]$/, '').slice(0, 140)}, I would value your read on where human judgment should sit before software acts.`);
  } else {
    lines.push('I would value your read on where human judgment should stay in the loop before software acts.');
  }
  lines.push('Open to a quick exchange?');
  lines.push('Luke');
  return cleanText(lines.join(' '));
}

// Returns true when the contact file signals an ACTIVE relationship (not cold outreach).
// Used to select the right draft and relationship-history copy.
function isActiveRelationship(cf) {
  if (!cf) return false;
  const warmth = (cf.warmth || '').toLowerCase();
  const category = (cf.category || '').toLowerCase();
  return (
    warmth === 'hot' ||
    warmth === 'inner-circle' ||
    category === 'inner-circle' ||
    category === 'active-partner'
  );
}

function buildWhyThisNote(ev, cf) {
  if (!cf) {
    const headline = compressHeadline((ev && ev.headline) || '');
    return {
      theirPost: headline || 'Recent LinkedIn activity captured by the scanner, post text not parsed.',
      target: 'Contact file missing, enrich secondbrain/memory/contacts/ to populate role and focus.',
      mutualGoals: 'Cannot compute overlap without a contact file.',
      relationshipHistory: 'No contact file on record, treat as first-outreach.',
    };
  }
  const headline = compressHeadline((ev && ev.headline) || '');
  const postsAbout = firstMeaningfulLine(cf.postsAbout, 180);
  const theirPost = headline
    ? (postsAbout ? `${headline} Consistent with their ongoing posting about ${postsAbout.replace(/[.,]$/, '')}.` : headline)
    : (postsAbout || 'Recent LinkedIn activity, no specific post text captured.');
  const professionalLine = firstMeaningfulLine(cf.professional, 220);
  const target = professionalLine || cleanText(cf.description) || 'Role and focus pending enrichment.';
  const overlapSource = firstMeaningfulLine(cf.trending || cf.beliefs || cf.postsAbout, 180);
  const mutualGoals = overlapSource
    ? `${overlapSource.replace(/[.,]$/, '')} maps to Luke priorities: ${LUKE_PRIORITY_ANCHORS.slice(0, 3).join(', ')}.`
    : `Strategic overlap on ${LUKE_PRIORITY_ANCHORS.slice(0, 2).join(' and ')}.`;

  let relationshipHistory;
  if (isActiveRelationship(cf)) {
    // Hot/inner-circle contacts have real relationship history; never fall back to
    // "No interaction logged" or "first-outreach" language for them.
    const parts = [];
    const relationshipLine = firstMeaningfulLine(cf.relationship, 120);
    if (relationshipLine) parts.push(cleanText(relationshipLine));
    if (cf.lastInteraction) parts.push(`Last contact: ${cf.lastInteraction}.`);
    parts.push('Active relationship, not cold outreach.');
    relationshipHistory = parts.join(' ');
  } else {
    const lastHistoryLine = firstMeaningfulLine(cf.history, 220) || 'No interaction logged yet, treat as warm re-introduction.';
    relationshipHistory = cleanText(lastHistoryLine);
  }

  return {
    theirPost: cleanText(theirPost).slice(0, 260),
    target: cleanText(target).slice(0, 240),
    mutualGoals: cleanText(mutualGoals).slice(0, 240),
    relationshipHistory: relationshipHistory.slice(0, 240),
  };
}

function renderPickBlock(index, ev, cf) {
  const lines = [];
  const name = (ev && ev.contactName) || (cf && cf.name) || 'Unknown';
  const when = ev && ev.detectedAt ? ev.detectedAt.slice(0, 16).replace('T', ' ') + 'Z' : 'recent';
  const headline = compressHeadline((ev && ev.headline) || '');
  const context = buildContext(ev, cf);
  const draft = buildDraft(ev, cf);
  const profile = cf && cf.linkedin ? cf.linkedin : '';
  const w = buildWhyThisNote(ev, cf);
  lines.push(`  ${index}. ${name}`);
  lines.push(`     when: ${when} | ${(ev && ev.eventType) || 'activity'}`);
  if (headline) lines.push(`     post: ${headline}`);
  // Always emit context + draft so EC2 never falls back to the generic
  // "too long since we connected" template. If the contact file is missing
  // we emit a CONTACT_FILE_MISSING marker so the dashboard can surface
  // enrichment as a task instead of pretending it has context.
  if (cf) {
    lines.push(`     context: ${context}`);
  } else {
    lines.push(`     context: CONTACT_FILE_MISSING, enrich secondbrain/memory/contacts/${slugify(name)}.md to populate context.`);
  }
  lines.push(`     draft: ${draft}`);
  if (profile) lines.push(`     profile: ${profile}`);
  lines.push('     Why this note:');
  lines.push(`       • Their post: ${w.theirPost}`);
  lines.push(`       • Target: ${w.target}`);
  lines.push(`       • Mutual goals: ${w.mutualGoals}`);
  lines.push(`       • Relationship history: ${w.relationshipHistory}`);
  return lines.join('\n');
}

function enrichPick(ev) {
  const lookup = loadContactFileByName((ev && ev.contactName) || '');
  const cf = lookup ? parseContactFile(lookup.raw) : null;
  return { contactFile: cf, contactFilePath: lookup ? lookup.path : null };
}

module.exports = {
  slugify,
  candidatePaths,
  loadContactFileByName,
  parseContactFile,
  isActiveRelationship,
  buildContext,
  buildDraft,
  buildWhyThisNote,
  renderPickBlock,
  enrichPick,
  CONTACTS_DIR,
};
