#!/usr/bin/env node
'use strict';

// comm-coaching-card.js
//
// Generates the daily COMMUNICATION COACHING briefing card: ExampleCo's top two
// communication strengths and top two recommendations, each backed by a real
// quote of something he actually said, a vetted authoritative citation, and
// grounded only in ExampleCo's own foundational truths.
//
// Writes data/agent/comm-coaching/YYYY-MM-DD.json. The briefing dashboard's live
// injector (ec2-server.js) reads that snapshot and renders the card. If we cannot
// produce an honest, grounded, fully-sourced card, we write a BLOCKED snapshot
// with the reason -- never a fabricated card, never a silent zero state.
//
// Usage: node scripts/comm-coaching-card.js [--date YYYY-MM-DD]

const fs = require('fs');
const path = require('path');
const { loadExampleCoQuotePool } = require('./lib/ExampleCo-quote-pool');
const {
  parseLiteratureKeys,
  buildPrompt,
  validateCard,
  blockedSnapshot,
  stripFences,
  pickCrispQuoteFor,
} = require('./lib/comm-coaching');

const REPO_ROOT = path.resolve(__dirname, '..');

const QUALITIES = [
  'confident',
  'strategic',
  'empathetic',
  'loving',
  'motivating',
  'inspiring',
  'effective at making things happen',
  'wise in his dealings with all',
];

function ctDateKey(d) {
  // America/Chicago calendar date as YYYY-MM-DD.
  const base = d || new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(base);
  return parts; // en-CA yields YYYY-MM-DD
}

function evidenceDatesForDay(day) {
  const current = /^\d{4}-\d{2}-\d{2}$/.test(String(day || ''))
    ? new Date(`${day}T12:00:00Z`)
    : new Date();
  const previous = new Date(current.getTime());
  previous.setUTCDate(previous.getUTCDate() - 1);
  return [current.toISOString().slice(0, 10), previous.toISOString().slice(0, 10)];
}

// Output directory for the daily snapshot. On EC2 the producer runs from the
// build CHECKOUT (/home/ec2-user/secondbrain-current) but the live dashboard
// injector (ec2-server.js) reads the snapshot from the canonical live data store
// (SECONDBRAIN_DATA_DIR, /opt/secondbrain/data). Writing to the checkout's
// data/ left the card missing from the briefing (ExampleCo 2026-06-22). Honor
// SECONDBRAIN_DATA_DIR when set so the snapshot lands where the injector reads;
// fall back to the repo-relative data/ dir for desktop/test runs.
function outDir(root) {
  const dataDir = process.env.SECONDBRAIN_DATA_DIR;
  if (dataDir) return path.join(dataDir, 'agent', 'comm-coaching');
  return path.join(root, 'data', 'agent', 'comm-coaching');
}

// Titles from the last few snapshots so the model varies its picks.
function recentTitles(root, days = 5) {
  const dir = outDir(root);
  const files = (() => {
    try {
      return fs
        .readdirSync(dir)
        .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
        .sort()
        .reverse()
        .slice(0, days);
    } catch {
      return [];
    }
  })();
  const titles = [];
  for (const f of files) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      for (const it of [...(j.strengths || []), ...(j.recommendations || [])]) {
        if (it && it.title) titles.push(it.title);
      }
    } catch {
      /* skip unreadable */
    }
  }
  return titles;
}

function writeSnapshot(root, date, snapshot) {
  const dir = outDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${date}.json`);
  fs.writeFileSync(file, JSON.stringify(snapshot, null, 2));
  return file;
}

function pickLiterature(literatureKeys, pattern, fallbackIndex) {
  return (
    literatureKeys.find((k) => pattern.test(k)) ||
    literatureKeys[fallbackIndex] ||
    literatureKeys[0]
  );
}

// Deterministic coaching templates. The fallback path runs whenever the LLM
// ladder is down (which, on the EC2 build, has been every day), so it must NOT
// emit the same four points forever. There are more templates than we render, so
// we rotate by date and skip any title used in recent days' snapshots. Each
// template ExampleCos topic keywords used to pair it with a REAL, on-topic quote
// (the old fallback grabbed quotes[0..3] blindly, so the quote rarely fit the
// point). literaturePattern selects a vetted citation; the fallback index keeps
// it valid even if the grounding list changes.
const STRENGTH_TEMPLATES = [
  {
    title: 'Names the why',
    oneLiner: 'You connect the work to why it matters.',
    keywords: ['why', 'vision', 'purpose', 'goal', 'want', 'because'],
    literaturePattern: /Sinek|Start With Why/i,
    literatureFallback: 0,
    literaturePoint: 'Purpose makes direction easier to understand and follow.',
    value: 'strategic servant leadership, helping people see the goal clearly',
    ExampleCoraph:
      'You are strongest when you connect the work to the why, because people can act with more ownership when the purpose is plain.',
  },
  {
    title: 'Builds real trust',
    oneLiner: 'You make trust and the other person benefit explicit.',
    keywords: ['trust', 'relationship', 'benefit', 'you and i', 'appreciate', 'means a lot'],
    literaturePattern: /Kouzes|Posner|Leadership Challenge/i,
    literatureFallback: 1,
    literaturePoint: 'Credible leadership is built when words and actions line up.',
    value: 'genuine relationship capital, not transactional influence',
    ExampleCoraph:
      "You build trust when you say plainly that the other person's benefit matters, because influence should serve the person, not just the outcome.",
  },
  {
    title: 'Coaches, does not command',
    oneLiner: 'You grow people instead of just handing out orders.',
    keywords: ['team', 'help', 'learn', 'coach', 'grow', 'you can', 'options'],
    literaturePattern: /Mark 10:43|Kouzes|Encourage the Heart/i,
    literatureFallback: 0,
    literaturePoint: 'Servant leaders develop people rather than manage tasks alone.',
    value: 'servant leadership that leaves people more capable than it found them',
    ExampleCoraph:
      'You lead by developing people, not by dictating, which is what turns a team into owners instead of order-takers.',
  },
  {
    title: 'Frames the strategy',
    oneLiner: 'You tie each conversation to the long game.',
    keywords: ['strategy', 'portfolio', 'model', 'plan', 'timeline', 'future', 'headed'],
    literaturePattern: /Sinek|Fisher|Getting to Yes/i,
    literatureFallback: 0,
    literaturePoint: 'Leading with interests and direction keeps talk aimed at the goal.',
    value: 'strategic clarity that keeps the team pointed at what matters',
    ExampleCoraph:
      'You keep the conversation anchored to the strategy and the long game, which helps people act now without losing the direction.',
  },
  {
    title: 'Speaks with candor',
    oneLiner: 'You name what is off track plainly and early.',
    keywords: ['clear', 'honest', 'off track', 'call it', 'priorities', 'straight'],
    literaturePattern: /Brown|Dare to Lead|Ephesians 4:15/i,
    literatureFallback: 0,
    literaturePoint: 'Clear is kind: candor spares people the cost of guessing.',
    value: 'truthful, direct speech that respects people enough to be clear',
    ExampleCoraph:
      'You say what is off track plainly instead of softening it into vagueness, which is candor that respects people rather than leaving them guessing.',
  },
  {
    title: 'Invites the room in',
    oneLiner: 'You ask for input before you decide.',
    keywords: ['what do you', 'your version', 'input', 'ask this group', 'we learned', 'thoughts'],
    literaturePattern: /Edmondson|Fearless|Rosenberg/i,
    literatureFallback: 0,
    literaturePoint: 'Psychological safety makes people willing to speak up.',
    value: 'a safe room where the best idea, not the loudest voice, wins',
    ExampleCoraph:
      'You pull people into the decision by asking for their read first, which is how a team feels safe enough to bring you the truth.',
  },
];

const REC_TEMPLATES = [
  {
    title: 'Listen before solving',
    oneLiner: 'Ask one clarifying question before the fix.',
    keywords: ['ask', 'question', 'curious', 'reach out', 'they want', 'trying to'],
    literaturePattern: /PRIVATE_NAME 1:19|Covey|Proverbs 18:13/i,
    literatureFallback: 2,
    literaturePoint: 'Wise communication starts by hearing before answering.',
    value: 'empathy, steadiness, and truth spoken in love',
    ExampleCoraph:
      'Before widening the answer, ask one clarifying question so the next move fits the real need and does not outrun the person in front of you.',
  },
  {
    title: 'Close with ownership',
    oneLiner: 'End with the concrete owner and next move.',
    keywords: ['action', 'to do', 'owner', 'next', 'we have to', 'capture', 'follow up'],
    literaturePattern: /Crucial Conversations|Brown|Ephesians 4:15/i,
    literatureFallback: 3,
    literaturePoint: 'Clear, candid requests keep high-stakes work in dialogue.',
    value: 'truthfulness, clarity, and making things happen',
    ExampleCoraph:
      'When the conversation turns into action, close with one owner and one next move so care becomes execution, not vague agreement.',
  },
  {
    title: 'Finish the thought',
    oneLiner: 'Land one clean sentence instead of trailing off.',
    keywords: ['i think', 'i feel like', 'i dont think', 'kind of', 'like i', 'sort of'],
    literaturePattern: /Matthew 5:37|Colossians 4:6|Brown/i,
    literatureFallback: 2,
    literaturePoint: 'Plain, complete speech ExampleCos more weight than hedged talk.',
    value: 'plain yes-means-yes speech that people can act on',
    ExampleCoraph:
      'When you catch yourself circling, stop and land one complete sentence, because a finished thought is easier to trust and to act on than a trailing one.',
  },
  {
    title: 'Slow the pace under heat',
    oneLiner: 'Take one beat before you respond when stakes rise.',
    keywords: ['stress', 'chaos', 'pressure', 'wrath', 'react', 'frustrat', 'heat'],
    literaturePattern: /Proverbs 15:1|PRIVATE_NAME 1:19|Goleman/i,
    literatureFallback: 2,
    literaturePoint: 'A soft answer and a slow temper de-escalate under pressure.',
    value: 'emotional steadiness, a non-anxious presence',
    ExampleCoraph:
      'When the stakes climb, take one beat before you answer, because a steady, unhurried reply ExampleCos the room better than a fast, reactive one.',
  },
  {
    title: 'State the ask plainly',
    oneLiner: 'Say the specific request, not just the context.',
    keywords: ['want', 'need', 'propose', 'ask', 'request', 'help from'],
    literaturePattern: /Rosenberg|Nonviolent|Fisher|Getting to Yes/i,
    literatureFallback: 2,
    literaturePoint: 'Name the concrete request, not only the backstory around it.',
    value: 'clarity that turns talk into committed, owned action',
    ExampleCoraph:
      'After you give the context, name the one concrete thing you want, because people act on a clear request far faster than on an implied one.',
  },
  {
    title: 'Make it safe to push back',
    oneLiner: 'Invite the disagreement you actually need to hear.',
    keywords: ['disagree', 'push back', 'your view', 'tell me', 'honest', 'what am i missing'],
    literaturePattern: /Edmondson|Fearless|Voss|Never Split/i,
    literatureFallback: 2,
    literaturePoint: 'People bring the truth when it is safe to disagree.',
    value: 'a safe room where the truth reaches you before a decision is final',
    ExampleCoraph:
      'Ask directly for what you might be missing, because you only get the correction you need when people believe it is safe to disagree with you.',
  },
];

// Rotate a template list so recent-day repeats are skipped. `usedTitles` are the
// titles from recent snapshots; we prefer templates whose title is NOT recent,
// then rotate the whole list by `offset` (a date-derived index) so even the
// unused set varies day to day. Always returns `count` templates.
function rotateTemplates(templates, usedTitles, offset, count) {
  const used = new Set((usedTitles || []).map((t) => String(t).toLowerCase()));
  const n = templates.length;
  const rotated = [];
  for (let i = 0; i < n; i += 1) rotated.push(templates[(offset + i) % n]);
  const fresh = rotated.filter((t) => !used.has(t.title.toLowerCase()));
  const ordered = [...fresh, ...rotated.filter((t) => used.has(t.title.toLowerCase()))];
  return ordered.slice(0, count);
}

// Stable day-derived rotation offset from the CT date so the pick advances each
// day without any persisted counter.
function dayOffset(date) {
  const digits = String(date || '').replace(/\D/g, '');
  let n = 0;
  for (const ch of digits) n = (n + Number(ch)) % 997;
  return n;
}

function buildFallbackItem(tpl, quotes, literatureKeys, usedIds) {
  const picked = pickCrispQuoteFor({ quotes, keywords: tpl.keywords, usedIds });
  if (picked && picked.id) usedIds.add(String(picked.id));
  return {
    title: tpl.title,
    oneLiner: tpl.oneLiner,
    evidenceQuoteId: picked ? picked.id : undefined,
    evidenceQuote: picked ? picked.quote : undefined,
    literatureKey: pickLiterature(literatureKeys, tpl.literaturePattern, tpl.literatureFallback),
    literaturePoint: tpl.literaturePoint,
    value: tpl.value,
    ExampleCoraph: tpl.ExampleCoraph,
  };
}

function deterministicFallbackCard({
  date,
  quotes,
  literatureKeys,
  counts,
  recentTitles: recent = [],
}) {
  const offset = dayOffset(date);
  const usedIds = new Set();
  const strengthTpls = rotateTemplates(STRENGTH_TEMPLATES, recent, offset, 2);
  const recTpls = rotateTemplates(REC_TEMPLATES, recent, offset, 2);
  const items = {
    date,
    strengths: strengthTpls.map((t) => buildFallbackItem(t, quotes, literatureKeys, usedIds)),
    recommendations: recTpls.map((t) => buildFallbackItem(t, quotes, literatureKeys, usedIds)),
  };
  const verdict = validateCard(items, { pool: quotes, literatureKeys });
  if (!verdict.ok) {
    return blockedSnapshot(date, `deterministic coaching rejected: ${verdict.reason}`, counts);
  }
  return {
    ...verdict.card,
    date,
    status: 'ok',
    generatedAt: new Date().toISOString(),
    llm: 'deterministic-fallback',
    counts,
  };
}

// Default LLM via the universal subscription ladder (Claude preferred). Injectable
// so the integration test can run without a live model.
async function defaultLlmFn(prompt) {
  const { askAI } = require('./lib/ask-ai');
  const out = await askAI(prompt, { surface: 'comm-coaching-card', silent: true });
  if (!out || !out.text) throw new Error('all LLM rungs failed (codex + claude + paid floor)');
  return { text: out.text, rung: out.rung };
}

/**
 * Generate (and return) the card snapshot. Does not write to disk.
 * @returns {{snapshot: object, file: null}}
 */
async function generateCommCoachingCard({
  root = REPO_ROOT,
  date,
  llmFn = defaultLlmFn,
  days = 2,
  forceDeterministic = process.env.COMM_COACHING_DETERMINISTIC === '1',
} = {}) {
  const day = date || ctDateKey();
  const grounding = (() => {
    try {
      return fs.readFileSync(
        path.join(root, 'memory', 'reference_communication_coaching.md'),
        'utf8',
      );
    } catch {
      return '';
    }
  })();
  const literatureKeys = parseLiteratureKeys(grounding);
  const { quotes, counts } = loadExampleCoQuotePool({
    root,
    days,
    today: new Date(`${day}T12:00:00Z`),
    // The card contract is calendar-scoped: briefing day plus the immediately
    // prior day. A rolling 48-hour cutoff can admit two-days-old evening text,
    // which the live reader then correctly rejects. Filter at collection so
    // the generator and reader cannot disagree.
    allowedDates: evidenceDatesForDay(day),
  });

  if (!grounding || literatureKeys.length === 0) {
    return {
      snapshot: blockedSnapshot(day, 'grounding file missing or has no vetted literature', counts),
    };
  }
  if (quotes.length < 1) {
    return {
      snapshot: blockedSnapshot(day, 'no real ExampleCo quotes available to cite as evidence', counts),
    };
  }
  // Titles from recent snapshots, used both as an anti-repetition hint to the LLM
  // and to rotate the deterministic fallback so it never ships the same four
  // points day after day (the "fortune cookie" defect ExampleCo flagged).
  const recent = recentTitles(root, days);
  const fallback = () =>
    deterministicFallbackCard({ date: day, quotes, literatureKeys, counts, recentTitles: recent });

  if (forceDeterministic) {
    return { snapshot: fallback() };
  }

  const prompt = buildPrompt({
    qualities: QUALITIES,
    groundingMd: grounding,
    literatureKeys,
    pool: quotes,
    priorTitles: recent,
    date: day,
  });

  let rung = null;
  let parsed = null;
  try {
    const res = await llmFn(prompt);
    rung = res && res.rung ? res.rung : 'llm';
    parsed = JSON.parse(stripFences(res && res.text != null ? res.text : res));
  } catch (e) {
    return { snapshot: fallback() };
  }

  const verdict = validateCard(parsed, { pool: quotes, literatureKeys });
  if (!verdict.ok) {
    return { snapshot: fallback() };
  }
  // Anti-repetition: if the model just re-served every point from recent days,
  // fall back to the rotated deterministic card so the card actually changes.
  const chosenTitles = [...verdict.card.strengths, ...verdict.card.recommendations].map((it) =>
    String(it.title || '').toLowerCase(),
  );
  const recentLower = new Set(recent.map((t) => String(t).toLowerCase()));
  if (chosenTitles.length && chosenTitles.every((t) => recentLower.has(t))) {
    return { snapshot: fallback() };
  }

  return {
    snapshot: {
      ...verdict.card,
      date: day,
      status: 'ok',
      generatedAt: new Date().toISOString(),
      llm: rung,
      counts,
    },
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const dateArg = (() => {
    const i = argv.indexOf('--date');
    return i >= 0 ? argv[i + 1] : null;
  })();
  const { snapshot } = await generateCommCoachingCard({ date: dateArg });
  const file = writeSnapshot(REPO_ROOT, snapshot.date, snapshot);
  if (snapshot.status === 'ok') {
    console.log(
      `[comm-coaching] wrote ${file} (${snapshot.strengths.length} strengths + ${snapshot.recommendations.length} recommendations, llm=${snapshot.llm})`,
    );
  } else {
    console.warn(`[comm-coaching] BLOCKED snapshot written to ${file}: ${snapshot.reason}`);
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[comm-coaching] fatal:', e.message);
    process.exit(1);
  });
}

module.exports = {
  generateCommCoachingCard,
  ctDateKey,
  recentTitles,
  QUALITIES,
  outDir,
  evidenceDatesForDay,
  deterministicFallbackCard,
};
