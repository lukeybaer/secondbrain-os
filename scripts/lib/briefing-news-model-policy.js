'use strict';

// NEWS WRITE-UPS FOLLOW THE BRAIN SWITCH (ExampleCo, 2026-09-14).
//
// The 2026-09-13 briefing ceiling pinned every briefing model call, news
// included, to subscription Codex. Overnight into 2026-09-14 Codex hit its
// weekly usage limit, more than 1,600 news summary attempts came back
// summary_unavailable, and six of the nine red cards at delivery were news,
// while the Claude subscription lane was healthy and never asked. ExampleCo dropped
// the Codex-only rule for news: a news write-up uses the same durable brain
// switch as every other subscription lane (Claude first by default, Codex the
// moment Claude is out of tokens).
//
// Everything else stays as it was. The Codex rung keeps the Sol/medium briefing
// ceiling, the Claude rung keeps the automation ceiling, paid model APIs stay
// forbidden, and healers, watchers, synthesis and every other briefing surface
// stay Codex-only.
//
// News callers pass toolLess: a bounded article packet needs no tools, hooks,
// settings or MCP servers, and loading them multiplies the per-story cost of a
// night that issues hundreds of write-ups.

const BRIEFING_NEWS_MODEL_SURFACES = Object.freeze([
  'news-summarize',
  'briefing-news-refresh',
  'briefing-manual-news',
]);

function briefingNewsFollowsBrainSwitch(opts = {}) {
  return Boolean(
    opts &&
      opts.briefingContext === true &&
      BRIEFING_NEWS_MODEL_SURFACES.includes(String(opts.surface || '')),
  );
}

module.exports = {
  BRIEFING_NEWS_MODEL_SURFACES,
  briefingNewsFollowsBrainSwitch,
};
