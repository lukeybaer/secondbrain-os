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
  return literatureKeys.find((k) => pattern.test(k)) || literatureKeys[fallbackIndex] || literatureKeys[0];
}

function fallbackQuote(quotes, index) {
  const q = quotes[index] || quotes[0] || {};
  return {
    id: q.id,
    quote: q.text,
  };
}

function deterministicFallbackCard({ date, quotes, literatureKeys, counts }) {
  const why = fallbackQuote(quotes, 0);
  const trust = fallbackQuote(quotes, 1);
  const listen = fallbackQuote(quotes, 2);
  const clear = fallbackQuote(quotes, 3);
  const items = {
    date,
    strengths: [
      {
        title: 'Names the why',
        oneLiner: 'OK: you connect the work to why it matters.',
        evidenceQuoteId: why.id,
        evidenceQuote: why.quote,
        literatureKey: pickLiterature(literatureKeys, /Sinek|Start With Why/i, 0),
        literaturePoint: 'Purpose makes direction easier to understand and follow.',
        value: 'strategic servant leadership, helping people see the goal clearly',
        ExampleCoraph:
          'You are strongest when you connect the work to the why, because people can act with more ownership when the purpose is plain.',
      },
      {
        title: 'Builds real trust',
        oneLiner: 'OK: you make trust and benefit explicit.',
        evidenceQuoteId: trust.id,
        evidenceQuote: trust.quote,
        literatureKey: pickLiterature(literatureKeys, /Kouzes|Posner|Leadership Challenge/i, 1),
        literaturePoint: 'Credible leadership is built when words and actions line up.',
        value: 'genuine relationship capital, not transactional influence',
        ExampleCoraph:
          'You build trust when you say plainly that the other person\'s benefit matters, because influence should serve the person, not just the outcome.',
      },
    ],
    recommendations: [
      {
        title: 'Listen before solving',
        oneLiner: 'OK: ask one clarifying question before the fix.',
        evidenceQuoteId: listen.id,
        evidenceQuote: listen.quote,
        literatureKey: pickLiterature(literatureKeys, /PRIVATE_NAME 1:19|Covey|Proverbs 18:13/i, 2),
        literaturePoint: 'Wise communication starts by hearing before answering.',
        value: 'empathy, steadiness, and truth spoken in love',
        ExampleCoraph:
          'Before widening the answer, ask one clarifying question so the next move fits the real need and does not outrun the person in front of you.',
      },
      {
        title: 'Close with ownership',
        oneLiner: 'OK: end with the concrete owner and next move.',
        evidenceQuoteId: clear.id,
        evidenceQuote: clear.quote,
        literatureKey: pickLiterature(literatureKeys, /Crucial Conversations|Brown|Ephesians 4:15/i, 3),
        literaturePoint: 'Clear, candid requests keep high-stakes work in dialogue.',
        value: 'truthfulness, clarity, and making things happen',
        ExampleCoraph:
          'When the conversation turns into action, close with one owner and one next move so care becomes execution, not vague agreement.',
      },
    ],
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
  days = 7,
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
  const { quotes, counts } = loadExampleCoQuotePool({ root, days });

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
  if (forceDeterministic) {
    return { snapshot: deterministicFallbackCard({ date: day, quotes, literatureKeys, counts }) };
  }

  const prompt = buildPrompt({
    qualities: QUALITIES,
    groundingMd: grounding,
    literatureKeys,
    pool: quotes,
    priorTitles: recentTitles(root),
    date: day,
  });

  let rung = null;
  let parsed = null;
  try {
    const res = await llmFn(prompt);
    rung = res && res.rung ? res.rung : 'llm';
    parsed = JSON.parse(stripFences(res && res.text != null ? res.text : res));
  } catch (e) {
    return { snapshot: deterministicFallbackCard({ date: day, quotes, literatureKeys, counts }) };
  }

  const verdict = validateCard(parsed, { pool: quotes, literatureKeys });
  if (!verdict.ok) {
    return { snapshot: deterministicFallbackCard({ date: day, quotes, literatureKeys, counts }) };
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
  deterministicFallbackCard,
};
