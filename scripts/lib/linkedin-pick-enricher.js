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
const { checkReachout } = require('./linkedin-reachout-quality.js');

const REPO = path.resolve(__dirname, '..', '..');
const CONTACTS_DIR = path.join(REPO, 'memory', 'contacts');

// ExampleCo's priority anchors, kept short so generated bullets stay readable.
const ExampleCo_PRIORITY_ANCHORS = [
  'Your current work and ventures',
  'Career relevance',
  'AI/automation thought leadership',
];

// Em-dash and en-dash code points kept as char classes to avoid embedding the
// glyphs in source (the em-dash-guard hook blocks U+2014/U+2013 in source).
const DASH_RE = new RegExp(`[\\u2014\\u2013]`, 'g');

function removeUnmatchedPair(s, openChar, closeChar) {
  const chars = String(s || '').split('');
  const stack = [];
  const remove = new Set();
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === openChar) {
      stack.push(i);
    } else if (chars[i] === closeChar) {
      if (stack.length) {
        stack.pop();
      } else {
        remove.add(i);
      }
    }
  }
  for (const i of stack) remove.add(i);
  return chars.filter((_, i) => !remove.has(i)).join('');
}

function removeUnbalancedDelimiters(s) {
  return removeUnmatchedPair(removeUnmatchedPair(s, '(', ')'), '[', ']');
}

function isBulkScanMetadataLine(line) {
  return (
    /\b(?:sample\s+)?bulk-scan\b/i.test(line) ||
    /\brecent post\(s\) found\b/i.test(line) ||
    /\b\d+\s+recent post/i.test(line)
  );
}

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
  const normalized = String(raw || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
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
  const lines = String(block)
    .split('\n')
    .map((l) => cleanText(l.replace(/^[-*\s\u2022]+/, '').replace(/\*\*/g, '')))
    .filter((l) => l.length > 15)
    .filter((l) => !isBulkScanMetadataLine(l))
    .filter(
      (l) => !/^(History|Professional|What They|Trending|Predictions|Contact Info)\b/i.test(l),
    );
  if (!lines.length) return '';
  return truncateClean(lines[0], maxLen);
}

function parseContactFile(raw) {
  if (!raw) return null;
  const fm = parseFrontmatter(raw);
  // Try the more-specific heading first: "History (Recent)" captures rolling
  // interaction logs written by nightly enrichers; bare "History" is the legacy
  // fallback for older files that haven't been updated.
  const history = extractSection(raw, 'History (Recent)') || extractSection(raw, 'History');
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
  return (
    String(fullName || '')
      .trim()
      .split(/\s+/)[0] || ''
  );
}

function cleanText(s) {
  let out = String(s || '')
    .replace(/\r/g, '')
    .replace(DASH_RE, ', ')
    .replace(/\.{3,}/g, ', ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .trim();
  out = removeUnbalancedDelimiters(out)
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .trim();
  return out;
}

function truncateClean(s, maxLen) {
  const out = cleanText(s);
  if (!maxLen || out.length <= maxLen) return out;
  const clipped = out
    .slice(0, maxLen)
    .replace(/\s+\S*$/, '')
    .replace(/[\s,;:(\[]+$/g, '')
    .trim();
  return cleanText(clipped || out.slice(0, maxLen));
}

function sentenceFragment(s) {
  return cleanText(s)
    .replace(/[.,;:!?]+$/g, '')
    .trim();
}

function givenClauseFragment(s) {
  return sentenceFragment(s)
    .replace(/^given\s+/i, '')
    .replace(/^becoming\s+/i, '')
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

// LNK-1 (ExampleCo, 2026-08-17): the scanner DOES capture the post body. It lands in
// the event's `detail` field, behind a boilerplate prefix that repeats the age
// stamp, "Feed post number N", the person's name, their connection degree, and
// their whole profile tagline:
//
//   1d [bullet] ago. Feed post number 1 PRIVATE_NAME [bullet] 1st AI &
//   Agentic Engineering @ Workday | ... | Life Long Learner 1d [bullet] I am
//   thrilled to be taking the stage at Workday Rising this year. ...
//
// The enricher used to read `ev.headline`, which is only that tagline, so every
// draft said "saw your recent post" and named nothing. The reliable anchor is
// the LAST age stamp, optionally followed by an "Edited" marker; everything
// after it is the post. Returns '' when no substantive body survives, and the
// callers then BLOCK the proposal rather than soften it.
const POST_BODY_ANCHOR_RE = new RegExp(
  `\\b\\d+\\s*(?:s|m|h|d|w|mo|yr)\\s*${String.fromCharCode(0x2022)}\\s*(?:Edited\\s*${String.fromCharCode(0x2022)}\\s*)?`,
  'gi',
);
const POST_BOILERPLATE_RE = /feed post number|\breposted this\b|^\d+(?:st|nd|rd|th)\b/i;
const MIN_POST_BODY_CHARS = 40;

function extractPostText(ev) {
  const detail = cleanText((ev && ev.detail) || '');
  if (!detail) return '';
  let lastEnd = -1;
  POST_BODY_ANCHOR_RE.lastIndex = 0;
  for (let m = POST_BODY_ANCHOR_RE.exec(detail); m; m = POST_BODY_ANCHOR_RE.exec(detail)) {
    lastEnd = m.index + m[0].length;
  }
  if (lastEnd < 0) return '';
  const body = cleanText(detail.slice(lastEnd));
  if (body.length < MIN_POST_BODY_CHARS) return '';
  if (POST_BOILERPLATE_RE.test(body)) return '';
  return body;
}

// The one thing the reader wants first: what did they actually say. Kept short
// enough for a card line but long enough to be recognizable.
function postSubject(post) {
  const firstSentence = String(post || '').split(/(?<=[.!?])\s+/)[0] || String(post || '');
  return truncateClean(sentenceFragment(firstSentence), 150);
}

function buildContext(ev, cf) {
  const headline = compressHeadline((ev && ev.headline) || '');
  const desc = cf ? cleanText(cf.description) : '';
  if (desc && headline) {
    return truncateClean(`${desc}. Recent activity: ${headline}`, 280);
  }
  if (desc) return truncateClean(desc, 280);
  if (headline) return truncateClean(headline, 280);
  return 'No contact file context available, contact not yet enriched.';
}

// LNK-1: the draft quotes what the person actually said, and the ask is built
// from that person's own context. There is no generic fallback ask, because a
// generic fallback is exactly how "where human judgment should sit before
// software acts" ended up in front of ExampleCo roughly fifty times. When the inputs
// for a personal note are missing, the draft is a BLOCKED line naming what is
// missing, which the dashboard surfaces as work rather than sending as outreach.
function draftBlocker(ev, cf) {
  if (!cf) {
    const name = (ev && ev.contactName) || 'this contact';
    return `BLOCKED: no contact file for ${name}, so there is no relationship context to write from. Enrich memory/contacts/${slugify(name)}.md, then this proposal regenerates.`;
  }
  if (!extractPostText(ev)) {
    return 'BLOCKED: the scanner captured activity for this contact but no post text, so a note cannot name the trigger. Re-run the LinkedIn scan for this profile before proposing outreach.';
  }
  return '';
}

// The ask is anchored in this person's own file, so two contacts cannot receive
// the same sentence. Order is most-specific first.
function personalAsk(cf, subject) {
  const hook =
    firstMeaningfulLine(cf.trending, 120) ||
    firstMeaningfulLine(cf.postsAbout, 120) ||
    firstMeaningfulLine(cf.professional, 120) ||
    firstMeaningfulLine(cf.beliefs, 120);
  const hookFragment = givenClauseFragment(hook).slice(0, 120).trim();
  if (hookFragment) {
    return `You are closer to ${hookFragment} than anyone I talk to, so what would you want to see proven before you would trust it in production?`;
  }
  const subjectFragment = sentenceFragment(subject).slice(0, 120).trim();
  if (subjectFragment) {
    return `On ${subjectFragment}, what changed your mind most recently?`;
  }
  return '';
}

function buildDraft(ev, cf) {
  const blocker = draftBlocker(ev, cf);
  if (blocker) return blocker;
  const first = firstName((ev && ev.contactName) || (cf && cf.name) || '');
  const post = extractPostText(ev);
  const subject = postSubject(post);
  const ask = personalAsk(cf, subject);
  if (!ask) {
    return `BLOCKED: ${cf.name || 'this contact'} has a captured post but the contact file carries no focus, belief, or professional line to build a personal ask from. Enrich the file, then this proposal regenerates.`;
  }

  // Active relationships (hot/inner-circle) get a comment-style engagement draft,
  // not a cold-outreach message. The framing is "I saw your post, good angle" not
  // "can we connect?"
  if (isActiveRelationship(cf)) {
    const lines = [];
    if (first) lines.push(`${first},`);
    lines.push(`on "${subject}", that is the right frame.`);
    // Shared-work context is the relationship context for an active partner, so
    // it stays. It is placed before the ask, never instead of it.
    const sharedWork = firstMeaningfulLine(cf.relationship, 120);
    lines.push(
      sharedWork
        ? `Same ground as ${sentenceFragment(sharedWork)} and the ExampleCo side of what we are building.`
        : 'Same ground as the ExampleCo side of what we are building.',
    );
    lines.push(ask);
    lines.push('ExampleCo');
    return cleanText(lines.join(' '));
  }

  const lines = [];
  if (first) lines.push(`${first},`);
  lines.push(`your post on "${subject}" landed for me.`);
  lines.push(ask);
  lines.push('ExampleCo');
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
  // LNK-1: "Their post" is the post, quoted from the scanner detail, never the
  // profile tagline and never a stand-in sentence about what they usually post.
  // With no post text it says BLOCKED and names the missing input.
  const post = extractPostText(ev);
  const blockedPost =
    'BLOCKED: activity was captured for this contact but no post text, so the trigger cannot be named. Re-run the LinkedIn scan for this profile.';
  if (!cf) {
    return {
      theirPost: post ? truncateClean(post, 260) : blockedPost,
      whyReachOut:
        'Cannot state why yet: no contact file, so Amy has no relationship context or goal overlap to justify an approach.',
      target:
        'Contact file missing, enrich secondbrain/memory/contacts/ to populate role and focus.',
      mutualGoals: 'Cannot compute overlap without a contact file.',
      relationshipHistory: 'No contact file on record, treat as first-outreach.',
    };
  }
  const theirPost = post ? post : blockedPost;
  const professionalLine = firstMeaningfulLine(cf.professional, 220);
  const target =
    professionalLine || cleanText(cf.description) || 'Role and focus pending enrichment.';
  const overlapSource = firstMeaningfulLine(cf.trending || cf.beliefs || cf.postsAbout, 180);
  const mutualGoals = overlapSource
    ? `${sentenceFragment(overlapSource)} maps to ExampleCo priorities: ${ExampleCo_PRIORITY_ANCHORS.slice(0, 3).join(', ')}.`
    : `Strategic overlap on ${ExampleCo_PRIORITY_ANCHORS.slice(0, 2).join(' and ')}.`;

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
    const lastHistoryLine =
      firstMeaningfulLine(cf.history, 220) ||
      'No interaction logged yet, treat as warm re-introduction.';
    relationshipHistory = cleanText(lastHistoryLine);
  }

  // Why Amy is proposing this specific person now, in one line, tied to the post
  // and to ExampleCo's own priorities. Directive 35 asks for the reason, not just the
  // trigger.
  const whyReachOut = post
    ? truncateClean(
        `They just went public on ${postSubject(post)}, which is live ground for ${firstMeaningfulLine(cf.trending || cf.postsAbout || cf.professional, 90) || ExampleCo_PRIORITY_ANCHORS[0]}, so a reply now reads as timely rather than transactional.`,
        320,
      )
    : 'Cannot state why yet: no post text, so there is no timely trigger to justify an approach.';

  return {
    theirPost: truncateClean(theirPost, 260),
    whyReachOut,
    target: truncateClean(target, 240),
    mutualGoals: truncateClean(mutualGoals, 240),
    relationshipHistory: truncateClean(relationshipHistory, 240),
  };
}

function renderPickBlock(index, ev, cf) {
  const lines = [];
  const name = (ev && ev.contactName) || (cf && cf.name) || 'Unknown';
  const when = ev && ev.detectedAt ? ev.detectedAt.slice(0, 16).replace('T', ' ') + 'Z' : 'recent';
  const context = buildContext(ev, cf);
  const draft = buildDraft(ev, cf);
  const profile = cf && cf.linkedin ? cf.linkedin : '';
  const w = buildWhyThisNote(ev, cf);
  const post = extractPostText(ev);
  lines.push(`  ${index}. ${name}`);
  lines.push(`     when: ${when} | ${(ev && ev.eventType) || 'activity'}`);
  // LNK-1: the "post:" line carries the post, not the profile tagline that used
  // to be lifted from ev.headline. The line is always emitted so the canonical
  // block shape the dashboard parses never changes; with no post it says BLOCKED
  // instead of pretending a tagline was a post.
  lines.push(
    `     post: ${
      post
        ? truncateClean(post, 280)
        : 'BLOCKED: no post text captured for this activity, so the trigger cannot be named. Re-run the LinkedIn scan for this profile.'
    }`,
  );
  // Always emit context + draft so EC2 never falls back to the generic
  // "too long since we connected" template. If the contact file is missing
  // we emit a CONTACT_FILE_MISSING marker so the dashboard can surface
  // enrichment as a task instead of pretending it has context.
  if (cf) {
    lines.push(`     context: ${context}`);
  } else {
    lines.push(
      `     context: CONTACT_FILE_MISSING, enrich secondbrain/memory/contacts/${slugify(name)}.md to populate context.`,
    );
  }
  lines.push(`     draft: ${draft}`);
  // 2026-08-17 (ExampleCo, LNK-1): advisory quality check. It cannot change or
  // suppress the draft, so a wrong verdict costs a noisy line rather than a
  // missing reachout. Flip it to suppressing once there is evidence on how
  // often it is wrong.
  //
  // The trigger is `post`, the extracted post text, NOT a headline. A first
  // attempt passed an undefined `headline` here and the catch below swallowed
  // the ReferenceError, so the check silently did nothing and still looked
  // wired. Hence the marker: a swallowed failure must remain visible.
  let qualityVerdict = null;
  try {
    qualityVerdict = checkReachout({ trigger: post, draft, peopleFileRead: !!cf });
  } catch (error) {
    lines.push(`     quality: CHECK_FAILED, ${String((error && error.message) || error).slice(0, 120)}`);
  }
  if (qualityVerdict && !qualityVerdict.ok) {
    lines.push(`     quality: WEAK, ${qualityVerdict.problems.join('; ')}`);
  }
  if (profile) lines.push(`     profile: ${profile}`);
  lines.push('     Why this note:');
  lines.push(`       • Their post: ${w.theirPost}`);
  lines.push(`       • Why reach out: ${w.whyReachOut}`);
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
  extractPostText,
  postSubject,
  personalAsk,
  buildContext,
  buildDraft,
  buildWhyThisNote,
  renderPickBlock,
  enrichPick,
  CONTACTS_DIR,
};
