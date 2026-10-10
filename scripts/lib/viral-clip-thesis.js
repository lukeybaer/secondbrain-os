'use strict';
/**
 * Thesis-first packaging for daily viral clip proposals.
 *
 * ExampleCo 2026-10-01: every daily clip must arrive with its message already
 * decided (a thesis), belong to the channel's standing foundation, and use the
 * field research in
 * dev-plans/examplechannel-shorts-winners-and-pipeline-proposals-2026-10-01.html
 * (78 channels, 5,256 verified Shorts). This module is that knowledge in code:
 * the channel foundation and pillars, the hit-potential score, the title lint,
 * and the description/tags the upload path uses. Every weight cites the
 * measured evidence it comes from; nothing here is speculation.
 */

// The standing editorial line every clip argues a piece of.
const CHANNEL_FOUNDATION = Object.freeze({
  thesis:
    'AI has left the lab. The people building it are saying out loud what it will do to work, money and the physical world, and Examplechannel shows the exact moment they said it, in their own words.',
  pillars: Object.freeze([
    Object.freeze({
      id: 'named_claim',
      label: 'A famous builder says it out loud',
      rule: 'A recognized person states one concrete claim about AI in their own words; the name is inside the claim, not a guest suffix.',
      evidence:
        'Your credited famous-person clips since Aug 15 median 1,147 views vs 114 for the March listicles; Dwarkesh Patel Shorts with the name inside the claim run 3.11x his channel median; a famous name in the title lifts 1.32x within channel (7 of 9 channels).',
    }),
    Object.freeze({
      id: 'physical_world',
      label: 'AI you can see',
      rule: 'A visible physical-world development (robot, chip, data center, rocket, device) a viewer can picture from the title alone, with footage that exists.',
      evidence:
        "9 of The Rundown AI's top 10 Shorts are physical or business stories (0.7M to 5.8M views) while model-news Shorts cap near a 27k median (Matthew Berman).",
    }),
    Object.freeze({
      id: 'debate',
      label: 'Two named sides',
      rule: 'A claim a named person or camp publicly disputes; the short states one side cleanly and the stakes, so viewers argue in the comments.',
      evidence:
        'Contrarian and verdict frames recur among the top tool channels (Tina Huang 4 of top 10, PRIVATE_NAME 3 of top 10); argued stories surface as comments per view, which this pipeline now measures.',
    }),
    Object.freeze({
      id: 'breaking',
      label: 'It happened this week',
      rule: 'A company or model did something this week with a concrete consequence; the title is "<Company> Just <did X>" and the clip is posted inside the week.',
      evidence:
        'Company or model + "Just" + consequence lifts 1.61x within channel (11 of 14 channels, n=109); YouTube says the Shorts feed tunes up on recency; the AI Advantage GPT-6 Astra Short did 102k on day one vs 1.7k to 38k on days two to six.',
    }),
  ]),
});

const PILLAR_IDS = new Set(CHANNEL_FOUNDATION.pillars.map((p) => p.id));

// Phrases ExampleCo already rejected on built Shorts (content-review rejections,
// research section 7). They may never appear in a title, hook or closing.
const BANNED_PHRASES = Object.freeze(['human taste', 'values over noise', 'the details', 'advice for new']);

// People whose name alone carries a Short. Recognition also passes when the
// name appears in the source title, the rule the research skeptics accepted.
const RECOGNIZED_PEOPLE = Object.freeze([
  'Elon Musk', 'Sam Altman', 'Jensen Huang', 'Demis Hassabis', 'Dario Amodei', 'Daniela Amodei',
  'Geoffrey Hinton', 'Yann LeCun', 'Yoshua Bengio', 'Andrej Karpathy', 'Ilya Sutskever',
  'Mark Zuckerberg', 'Satya Nadella', 'Sundar Pichai', 'Mustafa Suleyman', 'PRIVATE_NAME',
  'Jeff Bezos', 'Tim Cook', 'Lisa Su', 'PRIVATE_NAME', 'Marc Andreessen', 'Reid Hoffman',
  'PRIVATE_NAME', 'Fei-Fei Li', 'Andrew Ng', 'Greg Brockman', 'Mira Murati', 'Noam Brown',
  'PRIVATE_NAME', 'PRIVATE_NAME', 'Brett Adcock', 'Palmer Luckey', 'PRIVATE_NAME', 'Chamath Palihapitiya',
  'PRIVATE_NAME', 'PRIVATE_NAME', 'Naval Ravikant', 'PRIVATE_NAME', 'PRIVATE_NAME',
  'Mo Gawdat', 'PRIVATE_NAME', 'Stuart Russell', 'Max Tegmark', 'PRIVATE_NAME PRIVATE_NAME', 'PRIVATE_NAME-Fu Lee',
  'Masayoshi Son', 'Garry Tan', 'PRIVATE_NAME', 'Nat Friedman', 'Leopold Aschenbrenner',
  'Michio Kaku', 'Neil deGrasse Tyson', 'Lex Fridman', 'Dwarkesh Patel', 'PRIVATE_NAME',
  'Tyler Cowen', 'PRIVATE_NAME', 'Vinod Khosla', 'PRIVATE_NAME PRIVATE_NAME', 'Boris Cherny',
  'PRIVATE_NAME', 'Arthur Mensch', 'Emmett Shear', 'Sebastian Thrun', 'PRIVATE_NAME',
]);

// Hosts are recognized people but they are rarely the one making the claim.
const HOSTS = new Set(['Lex Fridman', 'Dwarkesh Patel', 'PRIVATE_NAME', 'PRIVATE_NAME', 'PRIVATE_NAME']);

const PHYSICAL_RE =
  /\b(robots?|robotics|humanoids?|optimus|figure 0?\d|unitree|boston dynamics|atlas|chips?|gpus?|semiconductors?|fab|tsmc|data ?cent(?:er|re)s?|power plants?|nuclear|fusion|rockets?|starship|spacex|satellites?|neuralink|brain implant|self-driving|robotaxi|waymo|tesla|drones?|factor(?:y|ies)|hardware|devices?|glasses|wearables?|lab|surgery|batter(?:y|ies)|quantum computers?|supercomputers?)\b/i;

const DEBATE_TITLE_RE =
  /\b(vs\.?|versus|disagree[sd]?|wrong|debate[sd]?|fires back|slams?|warns?|clash(?:es)?|feud|responds?|rebuttal|is dead|overhyped|bubble|lying|myth)\b/i;

// Long dashes, built from code points so this file stays dash-free.
const LONG_DASH_RE = new RegExp(`[${String.fromCharCode(0x2014)}${String.fromCharCode(0x2013)}]`);

const DAY_MS = 24 * 60 * 60 * 1000;

function normalizeName(value) {
  return String(value || '')
    .replace(/[^\p{L}\p{N}\s'.-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function textIncludesName(text, name) {
  if (!text || !name) return false;
  const lower = String(text).toLowerCase();
  const full = String(name).toLowerCase();
  if (lower.includes(full)) return true;
  // A surname alone counts only for unambiguous, long surnames (Karpathy, not Li).
  const parts = full.split(/\s+/);
  const surname = parts[parts.length - 1];
  return parts.length > 1 && surname.length >= 6 && new RegExp(`\\b${surname}\\b`, 'i').test(lower);
}

/**
 * Is this speaker a name that carries a Short on its own?
 * Recognized when on the curated list, or when named in the source title.
 */
function recognizeSpeaker(speakerName, sourceTitle = '') {
  const name = normalizeName(speakerName);
  if (!name || name.split(/\s+/).length < 2) return { recognized: false, name, reason: 'no full name', host: false };
  const listed = RECOGNIZED_PEOPLE.find(
    (person) => person.toLowerCase() === name.toLowerCase() || textIncludesName(name, person),
  );
  if (listed) return { recognized: true, name: listed, reason: 'recognized public figure', host: HOSTS.has(listed) };
  if (textIncludesName(sourceTitle, name)) return { recognized: true, name, reason: 'named in the source title', host: false };
  return { recognized: false, name, reason: 'not a recognized name', host: false };
}

/** People from the curated list named in free text (titles, chapters). */
function namedPeopleIn(text) {
  return RECOGNIZED_PEOPLE.filter((person) => textIncludesName(text, person));
}

function recencyClass(publishedAt, now = new Date()) {
  const t = Date.parse(publishedAt || '');
  if (!Number.isFinite(t)) return 'undated';
  const ageDays = (new Date(now).getTime() - t) / DAY_MS;
  if (ageDays <= 7) return 'this_week';
  if (ageDays <= 30) return 'this_month';
  return 'older';
}

function commentsPerThousand(candidate = {}) {
  const views = Number(candidate.views ?? candidate.view_count ?? 0);
  const raw = candidate.commentCount ?? candidate.comment_count;
  const comments = raw === null || raw === undefined || raw === '' ? NaN : Number(raw);
  if (!Number.isFinite(comments) || !(views > 0)) return null;
  return (comments / views) * 1000;
}

/**
 * Source-level hit potential, scored before any model writes a clip. Used to
 * rank the reviewed pool so the best topics get proposals first.
 */
function scoreSource(candidate = {}, options = {}) {
  const now = options.now || new Date();
  const title = String(candidate.title || candidate.source_title || '');
  const chapterText = (candidate.chapters || []).map((c) => c && c.title).join(' ');
  const reasons = [];
  let score = 0;

  const recency = recencyClass(candidate.publishedAt, now);
  if (recency === 'this_week') {
    score += 3;
    reasons.push('published this week (the Shorts feed favors recency)');
  } else if (recency === 'this_month') {
    score += 1;
    reasons.push('published this month');
  } else if (recency === 'older') {
    score -= 2;
    reasons.push('older than 30 days (evergreen, weaker in the feed)');
  } else {
    score -= 3;
    reasons.push('no publish date (cannot prove it is current)');
  }

  const people = namedPeopleIn(`${title} ${chapterText}`).filter((p) => !HOSTS.has(p));
  if (people.length) {
    score += 3;
    reasons.push(`famous name on the source: ${people.slice(0, 2).join(', ')}`);
  }
  if (PHYSICAL_RE.test(`${title} ${chapterText}`)) {
    score += 2;
    reasons.push('physical, visible subject');
  }
  const cpk = commentsPerThousand(candidate);
  const debateFloor = Number(options.debateCommentsPerThousand || 4);
  if ((cpk !== null && cpk >= debateFloor) || DEBATE_TITLE_RE.test(title)) {
    score += 2;
    reasons.push(cpk !== null && cpk >= debateFloor ? `argued (${cpk.toFixed(1)} comments per 1k views)` : 'argued (dispute in the title)');
  }
  return { score, reasons, recency, commentsPerThousand: cpk, people };
}

/**
 * Deterministic title lint. Fails closed on the defects the research found
 * live (the "AGI" chapter-label title), plus ExampleCo's banned phrases.
 */
function lintShortTitle(title, { speakerName = '', recognized = false, postedTitles = [], chapterTitles = [], recency = '' } = {}) {
  const errors = [];
  const t = String(title || '').trim();
  const words = t.split(/\s+/).filter(Boolean);
  if (!t) errors.push('empty title');
  if (t && (words.length < 5 || words.length > 12)) errors.push(`title has ${words.length} words; needs 5 to 12`);
  if (LONG_DASH_RE.test(t)) errors.push('long dash in title');
  if (/#shorts/i.test(t)) errors.push('#shorts in title');
  // "Just" claims news; the 1.61x lift is for this week's events only.
  if (recency && recency !== 'this_week' && /\bjust\b/i.test(t)) errors.push('"Just" needs a source from this week');
  if (recognized && speakerName && !textIncludesName(t, speakerName)) {
    errors.push(`recognized speaker ${speakerName} is not named in the title`);
  }
  const lower = t.toLowerCase();
  for (const phrase of BANNED_PHRASES) if (lower.includes(phrase)) errors.push(`banned phrase "${phrase}"`);
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (chapterTitles.some((c) => norm(c) && norm(c) === norm(t))) errors.push('title is a chapter label');
  if (postedTitles.some((p) => norm(p) && norm(p) === norm(t))) errors.push('duplicates a posted title');
  return { ok: errors.length === 0, errors };
}

function hashtagFor(name) {
  return `#${String(name || '').replace(/[^A-Za-z0-9]/g, '')}`;
}

/** Description written at proposal time; the upload path reads it verbatim. */
function buildShortDescription(p = {}) {
  const show = p.youtube_channel || p.source || 'the original episode';
  const speaker = p.speaker_name || p.speaker || '';
  const start = String(p.approx_timestamp || '').split('-')[0];
  const lines = [p.thesis || p.insight || ''];
  lines.push('');
  lines.push(`Source: ${speaker && speaker !== show ? `${speaker} on ` : ''}${show}`);
  if (p.source_url) lines.push(`Full episode: ${p.source_url}${start ? ` (at ${start})` : ''}`);
  const tags = ['#AI'];
  if (p.speaker_recognized && speaker) tags.push(hashtagFor(speaker));
  tags.push('#Examplechannel');
  lines.push('');
  lines.push(tags.slice(0, 3).join(' '));
  return lines.join('\n').trim();
}

function buildShortTags(p = {}) {
  const tags = [p.speaker_name, p.youtube_channel, ...(p.named_entities || [])]
    .map((v) => String(v || '').trim())
    .filter(Boolean);
  return [...new Set([...tags, 'AI', 'Examplechannel'])].slice(0, 12);
}

/**
 * Package-level hit score: source score plus what the model wrote. This is
 * the ranking key for the daily card.
 */
function scoreProposal(p = {}, sourceScore = { score: 0, reasons: [] }) {
  let score = sourceScore.score || 0;
  const reasons = [...(sourceScore.reasons || [])];
  if (p.speaker_recognized && !p.speaker_is_host) {
    score += 3;
    reasons.push(`${p.speaker_name} is the one making the claim`);
  }
  if (p.pillar === 'physical_world') score += 1;
  if (p.pillar === 'breaking' && /\bjust\b/i.test(p.youtube_title || '')) {
    score += 1;
    reasons.push('"Just" title grammar (1.61x)');
  }
  if (p.title_lint && !p.title_lint.ok) {
    score -= 4;
    reasons.push(`title blocked: ${p.title_lint.errors.join('; ')}`);
  }
  return { score, reasons };
}

function pillarById(id) {
  return CHANNEL_FOUNDATION.pillars.find((p) => p.id === id) || null;
}

/**
 * The commentary ExampleCo reads on the card: why this specific clip should be a
 * hit, grounded in the measured evidence, plus the model's own argument.
 */
function whyItWillHit(p = {}, sourceScore = {}) {
  const parts = [];
  if (p.why_hit) parts.push(String(p.why_hit).trim());
  const pillar = pillarById(p.pillar);
  if (pillar) parts.push(`Pillar "${pillar.label}": ${pillar.evidence}`);
  const signals = (sourceScore.reasons || []).filter(Boolean);
  if (signals.length) parts.push(`Signals: ${signals.join('; ')}.`);
  return parts.join(' ');
}

function foundationPromptBlock() {
  const pillars = CHANNEL_FOUNDATION.pillars
    .map((p) => `- ${p.id}: ${p.label}. ${p.rule} Evidence: ${p.evidence}`)
    .join('\n');
  return (
    `CHANNEL FOUNDATION (every clip argues one piece of this):\n${CHANNEL_FOUNDATION.thesis}\n\n` +
    `PILLARS (pick exactly one):\n${pillars}\n\n` +
    `WHAT THE DATA SAYS MAKES A HIT (78 channels, 5,256 verified Shorts):\n` +
    `- Decide the message FIRST: one thesis sentence the short proves, in plain words. Then pick only the segments that prove it.\n` +
    `- The person making the claim is named in the title ("Jensen Huang: ...", "Karpathy Says ..."). Name the actual speaker, never the host or channel.\n` +
    `- Proof in the first second: segment 1 opens on the claim itself, not setup. Write hook_line as the exact first spoken words.\n` +
    `- One claim per short. End abruptly on the payoff sentence: no outro, no "follow", no summary card.\n` +
    `- Title grammar with measured lift: "<Company or model> Just <consequence>" 1.61x; famous name in title 1.32x; "This <specific noun> <surprising predicate>" 1.20x. No lift from questions, negation, "you", hashtags or emoji. 5 to 12 words, no long dashes.\n` +
    `- Banned phrases (ExampleCo rejected them): ${BANNED_PHRASES.map((b) => `"${b}"`).join(', ')}.\n` +
    `- Length does not predict reach; never pad.\n`
  );
}

/**
 * The mechanically checkable part of "this clip belongs to that pillar".
 * named_claim needs a recognized, non-host speaker; physical_world needs a
 * visible subject in the thesis, title or source; breaking needs a source
 * published this week. debate is judged by the model and the dispute signal.
 */
function pillarFitErrors(p = {}, { sourceTitle = '', recency = '' } = {}) {
  const errors = [];
  if (!isValidPillar(p.pillar)) errors.push(`unknown pillar "${p.pillar}"`);
  if (p.pillar === 'named_claim' && !(p.speaker_recognized && !p.speaker_is_host)) {
    errors.push('named_claim needs a recognized speaker who is not the host');
  }
  if (p.pillar === 'physical_world' && !PHYSICAL_RE.test(`${p.thesis || ''} ${p.youtube_title || ''} ${sourceTitle}`)) {
    errors.push('physical_world needs a visible physical subject');
  }
  if (p.pillar === 'debate' && !p.speaker_recognized) {
    errors.push('debate needs a recognized, named person on one side');
  }
  if (p.pillar === 'breaking' && recency !== 'this_week') {
    errors.push('breaking needs a source published this week');
  }
  return errors;
}

const QUOTE_STOPWORDS = new Set(['the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'is', 'it', 'that', 'this', 'we', 'i', 'you', 'be', 'on', 'for', 'are', 'so']);

function quoteTokens(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9' ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !QUOTE_STOPWORDS.has(w));
}

/**
 * Share of a quote's content words spoken in the transcript near its time.
 * Auto-captions drop and mishear words, so this measures overlap, not
 * equality; an invented quotation scores near zero.
 */
function quoteSupport(quote, cues = [], startSec = null, windowSec = 45) {
  const words = quoteTokens(quote);
  if (!words.length) return 0;
  const near = (cues || []).filter((cue) => {
    if (startSec === null || !Number.isFinite(Number(startSec))) return true;
    const t = Number(cue && cue.start);
    return t >= Number(startSec) - windowSec && t <= Number(startSec) + windowSec;
  });
  const spoken = new Set(quoteTokens(near.map((cue) => cue && cue.text).join(' ')));
  return words.filter((w) => spoken.has(w)).length / words.length;
}

// ExampleCo's rule: no long dashes in any output. Model prose is scrubbed before it
// reaches the card, the description or the build.
function scrubDashes(text) {
  return String(text || '')
    .replace(new RegExp(`\\s*[${String.fromCharCode(0x2014)}${String.fromCharCode(0x2013)}]\\s*`, 'g'), ', ')
    .replace(/,\s*,/g, ',')
    .trim();
}

// Proposals under this score are not surfaced (dry run 2026-10-01: a fictional
// scenario with no named person scored 0 and read as news).
const MIN_HIT_SCORE = 3;

function isValidPillar(id) {
  return PILLAR_IDS.has(String(id || ''));
}

module.exports = {
  CHANNEL_FOUNDATION,
  BANNED_PHRASES,
  RECOGNIZED_PEOPLE,
  recognizeSpeaker,
  namedPeopleIn,
  recencyClass,
  commentsPerThousand,
  scoreSource,
  scoreProposal,
  lintShortTitle,
  buildShortDescription,
  buildShortTags,
  whyItWillHit,
  foundationPromptBlock,
  isValidPillar,
  pillarById,
  pillarFitErrors,
  quoteSupport,
  scrubDashes,
  MIN_HIT_SCORE,
};
