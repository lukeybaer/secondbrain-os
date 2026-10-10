'use strict';

const { loadOperatorIdentity } = require('./operator-identity');

// Operator-specific tokens (employer name, spouse first name) are PII and load
// from memory/ at runtime, never hardcoded in source. The public shell resolves
// neutral placeholders; the private tree resolves the real employer name so the
// card id/matcher/condition reproduce the live dashboard exactly.
const OPERATOR = loadOperatorIdentity();
const EMPLOYER = OPERATOR.owner.employer;
const EMPLOYER_UPPER = EMPLOYER.toUpperCase();
const EMPLOYER_SLUG = EMPLOYER.toLowerCase()
  .replace(/[^a-z0-9]+/g, '_')
  .replace(/^_+|_+$/g, '');

/**
 * briefing-card-manifest.js
 *
 * Canonical manifest of every card the RENDERED briefing dashboard
 * (http://<host>:3001/briefing) is expected to surface. This is the source of
 * truth for the live render-level QC (scripts/verify-dashboard-cards-live.js).
 *
 * WHY THIS EXISTS (the gap it closes):
 *   The briefing markdown could carry a section while the rendered dashboard
 *   silently dropped the corresponding tile (FULL-LIFE DATA BACKUP, the EMPLOYER
 *   GROUP NEWS card, VOICE/OTTER earlier). A markdown-only QC (cloud-morning-briefing.js
 *   FULL_BRIEFING_CONTRACT, validate-briefing-quality.js) passed through all of
 *   them because it never asserts what ExampleCo actually SEES. The existing live
 *   checker (verify-briefing-cards-live.js) only flags defects on cards that ARE
 *   present (red status, blocker banner, short news count); it never asserts a
 *   card EXISTS, so a fully-dropped card is invisible to it. This manifest +
 *   verifier add the missing CARD COMPLETENESS assertion against the render.
 *
 * HOW THE SET WAS DERIVED:
 *   - From the render code: ec2-server.js parseBriefingMarkdown + the per-card
 *     parseSectionData/render branches + sectionBucket(), and the render-time
 *     merges (FULL-LIFE DATA BACKUP -> SYSTEM HEALTH at ~ec2-server.js:11785;
 *     CONTENT PIPELINE -> VIDEO APPROVAL QUEUE at ~ec2-server.js:12103).
 *   - From a real authenticated fetch of the live dashboard (the rendered
 *     `data-section="..."` tiles).
 *
 * CARD SHAPE:
 *   {
 *     id:        stable short id (snake-ish, lowercase)
 *     match:     RegExp tested against the rendered, HTML-decoded data-section
 *                title (titles often carry a "(N)" or "($X total)" suffix, so
 *                these are prefix/loose matchers, never exact-equality).
 *     always:    true  => MUST render as its own tile, every run. A miss is a
 *                         HARD failure.
 *                false => CONDITIONAL. Either it renders, or one of `mergedInto`
 *                         is present (the render intentionally absorbed it).
 *     mergedInto: [ids] the cards whose presence satisfies this conditional one
 *                 (because the render merges this card into them). Only used when
 *                 always === false.
 *     condition: human-readable note on when/why it is conditional.
 *     valueSanity: optional [{ when, forbidMetric, reason }] rules: if `when`
 *                 (RegExp on body text) matches, the tile metric must NOT match
 *                 `forbidMetric`. Catches sentinel-vs-body contradictions
 *                 (e.g. metric "$0"/"unavailable" while the body shows a real
 *                 dollar figure).
 *     heal:      OPTIONAL { command, prerequisites, timeoutMs, artifactPath,
 *                 freshnessWindowMs }. Names the mechanical generator that
 *                 refreshes THIS card's data, so scripts/self-heal/mechanical-
 *                 runbook.js can re-run it BEFORE spawning an LLM heal worker
 *                 (ITEM W2a). command is [bin, ...args] (spawnSync argv, no
 *                 shell). prerequisites is an array of dot-paths into the
 *                 runbook's injected context that must be present or the
 *                 action reports a named wall instead of running. artifactPath
 *                 is the data/-relative path (resolved through
 *                 scripts/lib/data-root.js resolveDataArtifact -- the SAME
 *                 reader a live card uses) the runbook re-checks after running
 *                 the command: the action only counts as cleared when that
 *                 artifact's sha changed or its freshness is within
 *                 freshnessWindowMs (ms, default 6h). Absent `heal` is normal
 *                 -- the runbook falls back to a dev-plans/_domains.json
 *                 healLadder entry, then a generic class action.
 *   }
 *
 * The ALWAYS set below is intentionally conservative: a card is `always` only
 * when the render is expected to produce a standalone tile on every healthy run.
 * Cards that the render legitimately merges (FULL-LIFE, CONTENT PIPELINE) are
 * CONDITIONAL with an explicit mergedInto target, so the verifier does not
 * false-positive on ExampleCo's intended consolidations -- but it DOES fail when the
 * card neither renders nor lands in its merge target (which is exactly the
 * FULL-LIFE defect on 2026-06-20).
 */

// A dollar figure like "$608.46" or "$1,234" appearing in a body.
const DOLLAR_IN_BODY = /\$\s?\d[\d,]*(?:\.\d{2})?/;

const CARD_DEFINITIONS = [
  // ---- Top-of-dashboard execution + commitments (always) ----
  {
    id: 'action_items',
    match: /^ACTION ITEMS\b/i,
    always: true,
    condition: 'Always: merged Action Items + Open Commitments tile.',
  },
  {
    id: 'blockers',
    match: /^BLOCKERS\b/i,
    always: true,
    condition: 'Always: briefing quality-gate blockers tile (may be 0/green).',
  },
  {
    id: 'token_usage',
    match: /^TOKEN USAGE\b|^LLM SUBSCRIPTION\b/i,
    always: true,
    condition: 'Always: LLM subscription/token usage tile.',
  },
  {
    id: 'jev_spend',
    match: /^JEV SPEND\b/i,
    always: true,
    condition: 'Always: rolling Jev paid-decision spend for the last 24 hours, 72 hours, and 30 days.',
  },
  {
    id: 'meetings',
    match: /^MEETINGS\b/i,
    always: true,
    condition: 'Always: today + next 7 days schedule tile.',
  },
  {
    id: 'tesla_cybercab',
    match: /^TESLA CYBER ?CAB RESERVATION WATCH\b/i,
    always: true,
    condition:
      'Always: Tesla Cyber Cab reservation watch (ExampleCo phone-call requirement 2026-06-01).',
  },
  {
    id: 'client_app_invoice',
    match: /^CLIENT APP INVOICE ACTIVITY\b/i,
    always: true,
    condition: 'Always: Client App invoice activity tile.',
  },
  {
    id: 'venture_app_campaign',
    match: /^VENTURE APP CAMPAIGN\b/i,
    always: true,
    condition:
      'Always: receipt-backed outbound campaign tile. Renders immediately before VENTURE APP USERS so the send answer is read before the signup answer.',
  },
  {
    id: 'venture_app_users',
    match: /^VENTURE APP USERS\b/i,
    always: true,
    condition:
      'Always: fresh production application-user counts for the rolling past 7 days, past 30 days, and all time.',
  },
  // FEATURE BACKLOG was removed on 2026-09-24 (ExampleCo: "kill the nightly
  // research for how to improve amy ... and that card too"). It is neither
  // required nor produced; do not re-add it.

  // ---- Pipeline health bucket ----
  // CONTENT PIPELINE is CONDITIONAL: ec2-server.js (~12103) removes the
  // contentPipeline tile when a VIDEO APPROVAL QUEUE tile renders, because the
  // video queue is the actionable surface of the same pipeline. So the pipeline
  // is "represented" by EITHER tile -- but at least one must be present.
  {
    id: 'content_pipeline',
    match: /^CONTENT PIPELINE\b/i,
    always: false,
    mergedInto: ['video_approval_queue'],
    condition:
      'Conditional: renders as its own tile OR is absorbed by VIDEO APPROVAL QUEUE when a video queue exists (ec2-server.js ~12103). One of the two must render.',
  },
  {
    id: 'video_approval_queue',
    match: /^VIDEO APPROVAL QUEUE\b/i,
    always: false,
    mergedInto: ['content_pipeline'],
    condition:
      'Conditional: renders when the pending-video manifest has surface-able items; otherwise CONTENT PIPELINE renders instead. One of the two must render.',
  },
  {
    id: 'viral_tech_clips',
    match: /^VIRAL TECH CLIP PROPOSALS\b/i,
    always: true,
    condition: 'Always: viral tech clip proposals tile (pipeline-health bucket).',
  },
  {
    id: 'youtube_video_performance',
    match: /^YOUTUBE VIDEO PERFORMANCE\b/i,
    always: true,
    condition:
      'Always: combined views, likes, reshares and comments for both YouTube channels and both X accounts, plus detailed Examplechannel YouTube performance ' +
      '(ExampleCo asks Q7, 2026-08-16 and 2026-09-26). Reads the dated receipts scripts/social-channel-stats.js and scripts/youtube-video-stats.js write to ' +
      'data/agent/youtube-video-stats/<date>.json. Fewer posted videos than the requested 5 renders ' +
      'honestly as "N of 5" with the reason; a missing or stale read renders blocked, never zeros.',
    heal: {
      command: ['node', 'scripts/refresh-card.js', 'youtube_video_performance', '--publish'],
      timeoutMs: 120000,
    },
  },
  {
    id: 'ExampleCo_weather',
    match: /^ExampleCo 48-HOUR WEATHER\b/i,
    always: true,
    condition:
      'Always: next two days of ExampleCo hourly temperatures as a graph, exact min/max times, and explicit rain/snow/hail markers from the National Weather Service.',
    heal: {
      command: ['node', 'scripts/refresh-card.js', 'ExampleCo_weather', '--publish', '--verify'],
      timeoutMs: 120000,
      artifactPath: 'agent/ExampleCo-weather/latest.json',
      freshnessWindowMs: 12 * 60 * 60 * 1000,
    },
  },
  // TODAY'S 10 SHORTS PROPOSALS was removed on 2026-09-25 (ExampleCo: "you can kill
  // the example niche channel and proposed clips"). It is neither required
  // nor produced; do not re-add it. VIRAL TECH CLIP PROPOSALS is unaffected.

  // ---- Values + AWS + system ----
  {
    id: 'values_equipping',
    match: /^VALUES EQUIPPING IDEAS\b/i,
    always: true,
    // ExampleCo's explicit 2026-08-05 acceptance rule: once this date's Values
    // artifact is live-proven green, a later non-clean candidate is rejected.
    // Other cards retain the general verified-deterioration policy.
    sameDayGreenLock: true,
    condition: 'Always: values equipping ideas tile (3 ideas).',
  },
  {
    id: 'psychology',
    match: /^PSYCHOLOGY FOR YOUR DAY\b/i,
    always: true,
    condition: 'Always: two source-backed concepts retained until opened, then replaced on a later local day.',
  },
  {
    id: 'communication_coaching',
    match: /^COMMUNICATION COACHING\b/i,
    always: true,
    condition:
      'Always: communication coaching tile. It must be grounded in ExampleCo quotes and vetted sources, or render as a defect.',
  },
  {
    id: 'memory_hygiene',
    match: /^MEMORY HYGIENE\b/i,
    always: true,
    condition:
      'Always: weekly memory consolidation receipt tile (last run, 48h boolean, report link, open questions). Red when the receipt is missing or the weekly pass is overdue; never silently absent.',
  },
  {
    id: 'big_decisions',
    match: /^BIG DECISIONS\b/i,
    always: true,
    condition:
      'Always: big decisions tile (ExampleCo voice dispatch 2026-07-11, answer 19). Reads data/agent/big-decisions.jsonl ' +
      '(scripts/lib/big-decisions.js) and shows the last 7 days of rule supersessions/policy/architecture calls, ' +
      'newest first. Renders an explicit "no big decisions in the last 7 days" placeholder rather than vanishing when the window is empty.',
  },
  {
    id: 'aws_costs',
    match: /^AWS COSTS\b/i,
    always: true,
    condition: 'Always: AWS costs tile.',
    valueSanity: [
      {
        when: DOLLAR_IN_BODY,
        forbidMetric: /^(\$0|\$0\.00|unavailable|n\/a)$/i,
        reason:
          'AWS metric shows $0/unavailable while the body carries a verified dollar figure (the historical AWS-$0 defect)',
      },
    ],
  },
  {
    id: 'system_health',
    match: /^SYSTEM HEALTH\b/i,
    always: true,
    condition:
      'Always: system health tile. FULL-LIFE DATA BACKUP "Life:" chips are merged INTO this tile (ec2-server.js ~11785).',
  },
  {
    id: 'self_heal_health',
    match: /^SELF[- ]HEAL HEALTH\b/i,
    always: true,
    condition:
      'Always: daily self-heal health tile (Phase 4b). Reads the per-defect repair ledger + executor health; shows attempted/cleared/escalated, executor status, and ledger freshness so ExampleCo never opens the logs.',
    // BLOCKED-TILE fix (live-render-qc-blocked-tile-on-self-heal-health 2026-07-07):
    // The _domains.json rung only called generateSelfHealHealthCard({write:true}) which
    // updates the JSON artifact but NOT the briefing markdown, leaving Severity: red in
    // the briefing even after the ledger became fresh. refresh-card patches the briefing.
    heal: {
      command: ['node', 'scripts/refresh-card.js', 'self_heal_health', '--publish'],
      timeoutMs: 120000,
    },
  },

  // FULL-LIFE DATA BACKUP is CONDITIONAL: the render merges it into SYSTEM
  // HEALTH as "Life:" chips (ExampleCo ask 2026-05-24). So it is "represented" by
  // EITHER a standalone tile OR Life: chips inside SYSTEM HEALTH. The verifier
  // treats a present-and-nonempty merge target as satisfying it, BUT a
  // degraded/empty backup body (the 2026-06-20 defect) produces neither a tile
  // nor Life: chips -- the verifier flags that via requiresMergeEvidence.
  {
    id: 'full_life_backup',
    match: /^FULL[- ]LIFE DATA BACKUP\b/i,
    always: false,
    mergedInto: ['system_health'],
    requiresMergeEvidence: /Life:\s*[A-Za-z]/,
    condition:
      'Conditional: renders as its own tile OR appears as "Life:" chips inside SYSTEM HEALTH (ec2-server.js ~11785). The merge target must show real Life: chip evidence, never silently vanish.',
  },

  // ---- Reputation + projects + uncommitted ----
  {
    id: 'reputation_risk',
    match: /^REPUTATION RISK SCAN\b/i,
    always: true,
    condition: 'Always: reputation risk scan tile.',
    // BLOCKED-TILE fix (live-render-qc-blocked-tile-on-reputation-risk 2026-07-10):
    // When the morning EC2 Google News scan fails (all queries timeout), no artifact
    // is written and the card stays red. Without a heal entry the mechanical runbook
    // has nothing to run -- "No repair attempt was recorded". refresh-card.js re-runs
    // the scan (runningOnEc2 true for /opt/secondbrain/data) and splices the result.
    heal: {
      command: ['node', 'scripts/refresh-card.js', 'reputation_risk', '--publish'],
      timeoutMs: 120000,
    },
  },
  {
    id: 'amy_projects',
    match: /^AMY PROJECTS (?:RECEIVED|ASSIGNED)\b/i,
    always: true,
    condition: 'Always: Amy email, phone call, Otter, or detached Telegram projects received tile.',
  },
  {
    id: 'uncommitted_parked',
    match: /^UNCOMMITTED & PARKED WORK\b/i,
    always: true,
    condition: 'Always: uncommitted & parked work tile (branch cleanliness must never vanish).',
  },

  // ---- News bucket (each a standalone tile, every run) ----
  // `newsTarget` is the SINGLE source of truth for each news card's requested
  // item count (the design doc requires one target source, never hardcoded copies
  // in the verifier). The render-QC's builder-vs-render count check reads this so a
  // card that renders fewer than its target (the "(10) title but 9 rendered" /
  // "10 dropped as unreadable" class) is a hard defect. The EMPLOYER GROUP NEWS
  // card is mention-or-zero, NOT a fixed-count card: it passes at its real
  // mention count OR a scanned-zero placeholder, so it carries `mentionOrZero`
  // instead of newsTarget.
  {
    id: 'news_source_pareto',
    match: /^NEWS SOURCE PARETO\b/i,
    always: true,
    condition: 'Always: numeric outlet-family distribution across every rendered news card.',
  },
  {
    id: 'ai_tech_news',
    match: /^AI & TECH NEWS\b/i,
    always: true,
    newsTarget: 10,
    condition: 'Always: AI & tech news tile.',
  },
  {
    id: 'us_news',
    match: /^US NEWS\b/i,
    always: true,
    newsTarget: 10,
    condition: 'Always: US news tile.',
  },
  {
    id: 'world_news',
    match: /^WORLD NEWS\b/i,
    always: true,
    newsTarget: 10,
    condition: 'Always: world news tile.',
  },
  {
    id: 'us_policy_news',
    match: /^US POLICY NEWS\b/i,
    always: true,
    newsTarget: 5,
    condition: 'Always: US policy news tile.',
  },
  {
    id: 'finance_industry_news',
    match: /^FINANCE INDUSTRY NEWS\b/i,
    always: true,
    newsTarget: 10,
    condition: 'Always: finance industry news tile.',
  },
  {
    id: 'science_news',
    match: /^SCIENCE TREATMENTS & NEWS\b/i,
    always: true,
    newsTarget: 5,
    // SCIENCE is aspirational at 5 but a section with >= 1 source-backed article
    // is CLEAN (ExampleCo 2026-06-28): 1..4 is not a shortfall, only 0 is. The render
    // QC + markdown gate read getNewsMinimum for the shortfall check while still
    // shooting for newsTarget. Other news cards leave newsMinimum unset, so it
    // falls back to their target (exact-count contract preserved).
    newsMinimum: 1,
    condition: 'Always: SCIENCE treatments & news tile (target 5, clean at 1+).',
  },
  {
    id: 'ExampleCo_news',
    match: /^ExampleCo NEWS\b/i,
    always: true,
    newsTarget: 5,
    newsMinimum: 0,
    condition: 'Always: ExampleCo and coordinated crowd-phone display news. Maximum 5; clean at 0 with a scanned-zero placeholder.',
  },
  {
    id: 'other_news',
    match: /^OTHER NEWS\b/i,
    always: true,
    newsTarget: 10,
    condition: 'Always: globally ranked substantive news outside the named topical cards.',
  },
  {
    id: 'finance_rate_indexes',
    match: /^FINANCE RATE INDEXES\b/i,
    always: true,
    condition: 'Always: finance rate indexes tile.',
  },
  // The EMPLOYER GROUP NEWS card is ALWAYS expected and must render EVEN AT 0
  // ITEMS. ExampleCo works at his employer; a dropped employer card is a high-severity
  // miss. The cloud builder dropping it entirely (2026-06-20) is the defect this
  // manifest is built to catch. A "0 matches, noise-free" placeholder body is a
  // valid, present card -- vanishing is not. The employer name is operator PII,
  // so the id / matcher / copy are built from the runtime config, never hardcoded.
  {
    id: `${EMPLOYER_SLUG}_group_news`,
    match: new RegExp(
      '^' + EMPLOYER_UPPER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' GROUP NEWS\\b',
      'i',
    ),
    always: true,
    newsCard: true,
    mentionOrZero: true,
    condition: `Always: ${EMPLOYER} Group news tile. MUST render even with 0 items (renders a scanned-zero placeholder). ExampleCo works at ${EMPLOYER}; this card must never silently disappear.`,
  },

  // ---- Relationship + memory monitoring ----
  {
    id: 'linkedin_content_pipe',
    match: /^LINKEDIN CONTENT PIPE\b/i,
    always: true,
    condition:
      'Always: seven source-grounded LinkedIn topics in ExampleCo\'s niche, each above the observed vitality floor with a hook, fresh spins, and a source link.',
    heal: {
      command: ['node', 'scripts/refresh-card.js', 'linkedin_content_pipe', '--publish'],
      timeoutMs: 12 * 60 * 1000,
    },
  },
  {
    id: 'linkedin',
    match: /^LINKEDIN NETWORK NEWS\b/i,
    always: true,
    condition: 'Always: LinkedIn network news tile (top 10 network activity events ranked by relevance to ExampleCo).',
  },
  {
    id: 'voice_confirmation',
    match: /^VOICE CONFIRMATION ?\/ ?SPEAKER LEARNING\b/i,
    always: true,
    condition: 'Always: voice confirmation / speaker learning tile.',
  },
  {
    id: 'otter_speaker_pareto',
    match: /^OTTER SPEAKER PARETO\b/i,
    always: true,
    condition:
      'Always: Otter speaker pareto / people tagged tile; renders the one-card call-history surface with Past 24 Hours, Day Before, and lifetime voice stats.',
  },
  {
    id: 'memory_md_changes',
    match: /^MEMORY\.MD CHANGES\b/i,
    always: true,
    condition: 'Always: MEMORY.md changes (24h) tile.',
  },
  {
    id: 'people_files_changes',
    match: /^PEOPLE FILES CHANGES\b/i,
    always: true,
    condition: 'Always: people files changes (24h) tile.',
  },
];

const CARD_PRIORITY_IDS = [
  'blockers',
  'system_health',
  'self_heal_health',
  'action_items',
  'token_usage',
  'jev_spend',
  'meetings',
  'values_equipping',
  'communication_coaching',
  'psychology',
  'memory_hygiene',
  'big_decisions',
  'otter_speaker_pareto',
  'people_files_changes',
  'tesla_cybercab',
  'client_app_invoice',
  'venture_app_campaign',
  'venture_app_users',
  'content_pipeline',
  'video_approval_queue',
  'viral_tech_clips',
  'youtube_video_performance',
  'ExampleCo_weather',
  'aws_costs',
  'full_life_backup',
  'reputation_risk',
  'amy_projects',
  'uncommitted_parked',
  'finance_rate_indexes',
  'linkedin_content_pipe',
  'linkedin',
  'voice_confirmation',
  'memory_md_changes',
  'news_source_pareto',
  'ai_tech_news',
  'us_news',
  'world_news',
  'us_policy_news',
  'finance_industry_news',
  'science_news',
  `${EMPLOYER_SLUG}_group_news`,
];
const CARD_PRIORITY = new Map(CARD_PRIORITY_IDS.map((id, idx) => [id, idx]));
const CARDS = [...CARD_DEFINITIONS].sort((a, b) => {
  const ai = CARD_PRIORITY.has(a.id) ? CARD_PRIORITY.get(a.id) : 500;
  const bi = CARD_PRIORITY.has(b.id) ? CARD_PRIORITY.get(b.id) : 500;
  return ai - bi || CARD_DEFINITIONS.indexOf(a) - CARD_DEFINITIONS.indexOf(b);
});

const ALWAYS_IDS = CARDS.filter((c) => c.always).map((c) => c.id);
const CONDITIONAL_IDS = CARDS.filter((c) => !c.always).map((c) => c.id);

// ALWAYS_HONEST_BLOCKER: manifest card ids that are INTENTIONALLY never wired
// to a cloud builder (scripts/cloud-morning-briefing.js realById). These cards
// legitimately have no cloud-side generator (e.g. desktop-only surfaces) and
// are expected to render as a permanent honest blocker on the cloud build. The
// C5 completeness lint (scripts/__tests__/manifest-cards-all-wired.test.js)
// treats every manifest card id as required-wired UNLESS it is listed here, so
// a card silently falling off cloud-morning-briefing.js (the comm-coaching /
// memory-people-files defect class) fails CI instead of surfacing as a
// days-long silent honest-blocker. Add an entry ONLY when the gap is a real,
// permanent design decision -- never to silence a lint failure for a card that
// should be wired. Each entry needs a comment naming why.
const ALWAYS_HONEST_BLOCKER = [
  // (none today -- every manifest card as of 2026-07-02 has a live cloud
  // builder assignment in cloud-morning-briefing.js realById.)
];

function getCardById(id) {
  return CARDS.find((c) => c.id === id) || null;
}

// The single target source for news-card item counts. A consumer (the render-QC
// builder-vs-render check) reads this instead of hardcoding 10/5 in its own file,
// so there is exactly one place the requested counts live.
function getNewsTarget(card) {
  if (!card) return null;
  return Number.isFinite(card.newsTarget) ? card.newsTarget : null;
}

function isNewsCard(card) {
  return Boolean(card && (card.newsCard === true || Number.isFinite(card.newsTarget)));
}

// The CLEAN minimum item count: a card rendering at least this many source-backed
// items is not a shortfall. Defaults to the aspirational target (so every other
// news card keeps its exact-count contract); science overrides it to 1 because a
// 1..4-article SCIENCE section is clean while 5 stays the goal (ExampleCo 2026-06-28).
function getNewsMinimum(card) {
  if (!card) return null;
  if (Number.isFinite(card.newsMinimum)) return card.newsMinimum;
  return getNewsTarget(card);
}

// Summary cards report other cards' repair state and are never a repair target
// (ExampleCo, 2026-10-07). One definition for the controller and the mechanical tier.
const SUMMARY_CARD_IDS = new Set(['self_heal_health']);
function isSummaryCardId(cardId) {
  return SUMMARY_CARD_IDS.has(String(cardId || '').toLowerCase());
}

module.exports = {
  SUMMARY_CARD_IDS,
  isSummaryCardId,
  CARDS,
  ALWAYS_IDS,
  CONDITIONAL_IDS,
  ALWAYS_HONEST_BLOCKER,
  getCardById,
  getNewsTarget,
  isNewsCard,
  getNewsMinimum,
};
