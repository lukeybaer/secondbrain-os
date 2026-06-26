#!/usr/bin/env node
// suggest-token-reduction.js
//
// Reads yesterday's token-usage-YYYY-MM-DD.json plus the prior 7 days for
// trend context, and emits a STRUCTURED reduction suggestion. There is
// always a concrete proposed change -- never "no way to reduce."
//
// Output: data/agent/token-reduction-suggestion-YYYY-MM-DD.json
//   {
//     date,
//     generated_at,
//     suggestion: string (<80 words, the headline inline in the briefing),
//     suggested_changes: [
//       { where, what, estimated_savings, why }
//     ],
//     diagnostics: {
//       cache_hit_rate,
//       top_projects: [...],
//       model_mix: {...},
//       entries, sessions,
//       opus_share, sonnet_share, haiku_share,
//       cache_creation_ratio,
//       biggest_lever: string
//     },
//     source: "claude-proxy" | "heuristic" | "hybrid" | "insufficient-data",
//     summary: { ...the full payload handed to the LLM... }
//   }
//
// Design decisions (dispatch 2026-04-23):
//   * ALWAYS produce a specific, actionable suggestion. Never "no way to
//     reduce" -- that's a logic bug, not a signal. If data is truly missing
//     or undiagnosable, the fallback is "insufficient data -- <diagnostic
//     step>" with a probe ExampleCo can run.
//   * The heuristic layer is rule-based and covers every known angle:
//     model mix (Opus share), cache hit rate, cache-creation ratio, per-
//     project concentration, session count, tier-1 context injection cost,
//     trend direction. At least one rule always fires.
//   * The LLM layer (Claude Max proxy) builds on top of the heuristic --
//     it sees a pre-digested diagnostic payload, not just raw JSON. The
//     LLM can override the heuristic headline; the structured
//     suggested_changes array always reflects both.
//   * Every change entry has an explicit estimated_savings so ExampleCo can
//     compare proposed changes on impact.
//
// Idempotent: re-running overwrites the suggestion file.
// Runs at 5:20 AM CT via scheduled task, just after collect-daily-token-
// usage.js and before the 5:30 AM briefing. Also invoked by the
// health-self-heal flow when the daily token file is regenerated.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO = process.env.SECONDBRAIN_ROOT || path.join(__dirname, '..');
const OUT_DIR = path.join(REPO, 'data', 'agent');
const PROXY_URL = process.env.CLAUDE_PROXY_URL || 'http://127.0.0.1:3456';
// Read at call time, not module load time, so tests can toggle the env var
// after import (vitest does import hoisting before setting env vars).
function isProxyDisabled() {
  return process.env.SUGGEST_TOKEN_NO_PROXY === '1';
}

function ctDateKey(ms) {
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

function loadUsageFiles(targetDate) {
  const files = [];
  for (let i = 0; i < 8; i++) {
    const d = new Date(Date.parse(targetDate + 'T12:00:00Z') - i * 86400000);
    const key = d.toISOString().slice(0, 10);
    const f = path.join(OUT_DIR, `token-usage-${key}.json`);
    if (fs.existsSync(f)) {
      try { files.push({ date: key, data: JSON.parse(fs.readFileSync(f, 'utf8')) }); } catch { /* skip */ }
    }
  }
  return files.sort((a, b) => a.date.localeCompare(b.date));
}

function summarizeForPrompt(files, target) {
  const target_entry = files.find((f) => f.date === target);
  if (!target_entry) return null;
  const t = target_entry.data;
  const trend = files.map((f) => ({
    date: f.date,
    input: f.data.total.input,
    cacheRead: f.data.total.cacheRead,
    cacheCreation: f.data.total.cacheCreation,
    output: f.data.total.output,
    cacheHitRate: Number((f.data.cacheHitRate || 0).toFixed(3)),
  }));
  const topProjects = (t.topProjects || []).slice(0, 5).map((p) => ({
    label: p.label,
    totalInputLike: p.totalInputLike,
    cacheRead: p.cacheRead,
    cacheCreation: p.cacheCreation,
  }));
  return {
    target_date: target,
    yesterday: {
      input: t.total.input,
      cacheRead: t.total.cacheRead,
      cacheCreation: t.total.cacheCreation,
      output: t.total.output,
      cacheHitRate: Number((t.cacheHitRate || 0).toFixed(3)),
      entries: t.entries,
      sessions: t.sessionsWithData,
    },
    byModel: t.modelMix,
    byModelDetail: t.byModel || {},
    topProjects,
    trend,
  };
}

// ── Diagnostics builder ────────────────────────────────────────────────────
// Turns the raw summary into a compact decision surface. These numbers drive
// both the heuristic rules and the LLM prompt so they stay aligned.
function buildDiagnostics(summary) {
  const y = summary.yesterday || {};
  const totalInputLike = (y.input || 0) + (y.cacheCreation || 0) + (y.cacheRead || 0);
  const modelMix = summary.byModel || {};
  const mixTotal = Object.values(modelMix).reduce((a, b) => a + b, 0) || 1;
  const share = (k) => ((modelMix[k] || 0) / mixTotal);
  const opus_share = share('opus');
  const sonnet_share = share('sonnet');
  const haiku_share = share('haiku');
  const cache_creation_ratio = totalInputLike > 0 ? (y.cacheCreation || 0) / totalInputLike : 0;
  const top = summary.topProjects || [];
  const top_concentration = top.length && totalInputLike > 0
    ? (top[0].totalInputLike / totalInputLike)
    : 0;
  const entries_per_session = (y.sessions || 0) > 0 ? (y.entries || 0) / y.sessions : 0;
  const trend = summary.trend || [];
  const priorAvgInputLike = trend.length > 1
    ? trend.slice(0, -1).reduce((a, t) => a + (t.input + t.cacheCreation + t.cacheRead), 0) / (trend.length - 1)
    : totalInputLike;
  const trend_delta_pct = priorAvgInputLike > 0 ? ((totalInputLike - priorAvgInputLike) / priorAvgInputLike) : 0;

  // Which lever is biggest? (Rank the normalized reduction potential.)
  const levers = [];
  if (opus_share > 0.65) {
    const potential = Math.min(opus_share - 0.4, 0.4) * totalInputLike; // 40% Opus target
    levers.push({ key: 'model_mix_opus', potential, detail: `Opus at ${(opus_share * 100).toFixed(0)}% of mix — too high` });
  }
  if (y.cacheHitRate < 0.8) {
    const potential = (0.8 - y.cacheHitRate) * totalInputLike;
    levers.push({ key: 'cache_hit_rate', potential, detail: `Cache hit rate ${(y.cacheHitRate * 100).toFixed(0)}% below 80% target` });
  }
  if (cache_creation_ratio > 0.1) {
    const potential = (cache_creation_ratio - 0.05) * totalInputLike;
    levers.push({ key: 'cache_creation', potential, detail: `Cache creation ${(cache_creation_ratio * 100).toFixed(0)}% of input — context churning` });
  }
  if (top.length && top_concentration > 0.5 && top[0].label !== 'haiku') {
    const potential = (top_concentration - 0.35) * totalInputLike * 0.5;
    levers.push({ key: 'project_concentration', potential, detail: `${top[0].label} ate ${(top_concentration * 100).toFixed(0)}% of yesterday — likely over-using Opus for retrieval` });
  }
  if (entries_per_session > 25) {
    const potential = Math.min((entries_per_session - 20) / entries_per_session, 0.3) * totalInputLike;
    levers.push({ key: 'long_sessions', potential, detail: `${entries_per_session.toFixed(0)} entries/session avg — split long runs to stabilise cache` });
  }
  if (haiku_share < 0.05) {
    const potential = 0.15 * totalInputLike; // push 15% of traffic to Haiku
    levers.push({ key: 'haiku_underuse', potential, detail: `Haiku only ${(haiku_share * 100).toFixed(1)}% of mix — read-heavy traffic should route there` });
  }
  levers.sort((a, b) => b.potential - a.potential);
  const biggest_lever = levers.length ? levers[0].key : 'none';

  return {
    total_input_like: totalInputLike,
    opus_share,
    sonnet_share,
    haiku_share,
    cache_creation_ratio,
    top_concentration,
    top_project_label: top[0] && top[0].label,
    entries_per_session,
    trend_delta_pct,
    biggest_lever,
    ranked_levers: levers,
  };
}

// ── Heuristic change rules ─────────────────────────────────────────────────
// Each rule that fires adds a structured {where, what, estimated_savings, why}
// entry. The list is deterministic, ordered by lever potential so the
// first entry is always the biggest lever.
function heuristicChanges(summary, diag) {
  const changes = [];
  const y = summary.yesterday || {};
  const top = summary.topProjects || [];
  const totalMT = diag.total_input_like / 1e6;

  for (const lever of diag.ranked_levers) {
    const saveMT = (lever.potential / 1e6).toFixed(1);
    switch (lever.key) {
      case 'model_mix_opus':
        changes.push({
          where: top[0] && top[0].label ? `${top[0].label} (top project)` : 'all repos',
          what: `Route read-heavy exploration (memory scans, contact lookups, codebase greps) to Haiku subagents via Agent tool with subagent_type:"Explore" and model:"haiku". Keep Opus for planning, editing, and synthesis only.`,
          estimated_savings: `~${saveMT}M tokens/day (Opus ${(diag.opus_share * 100).toFixed(0)}% → ~40%)`,
          why: lever.detail,
        });
        break;
      case 'cache_hit_rate':
        changes.push({
          where: 'cross-session invariant context',
          what: `Lift the most-referenced files (Tier 1 MEMORY.md, project CLAUDE.md, top 3 contact INDEX entries) into a cached system-prompt prefix so they cross session cache breakpoints instead of being re-read on every new turn.`,
          estimated_savings: `~${saveMT}M tokens/day (hit rate ${(y.cacheHitRate * 100).toFixed(0)}% → 80%)`,
          why: lever.detail,
        });
        break;
      case 'cache_creation':
        changes.push({
          where: 'long-running sessions',
          what: `Split sessions that thrash context: set a hard turn-count budget (e.g. 40) before the quarterback main thread spawns a fresh Agent subagent. Prevents cache invalidation when a single session rebuilds context repeatedly.`,
          estimated_savings: `~${saveMT}M tokens/day (creation ${(diag.cache_creation_ratio * 100).toFixed(0)}% → 5%)`,
          why: lever.detail,
        });
        break;
      case 'project_concentration':
        changes.push({
          where: top[0] && top[0].label ? top[0].label : 'dominant project',
          what: `${top[0] && top[0].label || 'Dominant project'} swallowed ${(diag.top_concentration * 100).toFixed(0)}% of yesterday's input-like tokens. Add a project-level CLAUDE.md directive: "Read-only tasks (grep, file search, memory lookup) must use the Agent tool with model:\\"haiku\\". Opus only for edits, synthesis, or multi-step planning."`,
          estimated_savings: `~${saveMT}M tokens/day`,
          why: lever.detail,
        });
        break;
      case 'long_sessions':
        changes.push({
          where: 'session orchestration',
          what: `Shorter, scoped sessions. Current avg is ${diag.entries_per_session.toFixed(0)} tool calls per session — each long session rebuilds cached context many times. Encourage spawning Agent subagents for any side investigation >5 tool calls.`,
          estimated_savings: `~${saveMT}M tokens/day`,
          why: lever.detail,
        });
        break;
      case 'haiku_underuse':
        changes.push({
          where: 'subagent routing',
          what: `Haiku is only ${(diag.haiku_share * 100).toFixed(1)}% of mix. Add a SessionStart hook rule: when the user prompt matches /^(find|search|grep|list|show|read|check)/i, route the initial dispatch to Haiku before escalating to Opus only if the task requires editing.`,
          estimated_savings: `~${saveMT}M tokens/day (Haiku ${(diag.haiku_share * 100).toFixed(1)}% → 15%)`,
          why: lever.detail,
        });
        break;
    }
  }

  // Fallback when no lever fired — push for tighter SessionStart hygiene.
  if (changes.length === 0) {
    changes.push({
      where: 'SessionStart context injection',
      what: `Audit the SessionStart hook chain — 14 hook scripts inject content on every session. Identify the 3 largest injections that aren't used on quick tasks (grep, file search, memory lookup) and gate them behind a task-type check. Even a 30% reduction on injection saves meaningfully at ${totalMT.toFixed(1)}M/day.`,
      estimated_savings: `~${(diag.total_input_like * 0.05 / 1e6).toFixed(1)}M tokens/day (5% on total)`,
      why: `Usage is already efficient (cache hit ${(y.cacheHitRate * 100).toFixed(0)}%, Opus ${(diag.opus_share * 100).toFixed(0)}%) — remaining wins are in what gets injected before the first prompt.`,
    });
  }

  return changes;
}

function heuristicHeadline(summary, diag, changes) {
  const top = changes[0];
  if (!top) return 'Insufficient data — check if the usage collector is capturing cache hits.';
  const y = summary.yesterday || {};
  const totalMT = (diag.total_input_like / 1e6).toFixed(0);
  return `${totalMT}M tokens yesterday, ${(y.cacheHitRate * 100).toFixed(0)}% cache hit, Opus ${(diag.opus_share * 100).toFixed(0)}% of mix. ${top.what} Saves ${top.estimated_savings}. ${top.why}`.slice(0, 600);
}

// ── LLM layer (Claude Max proxy) ───────────────────────────────────────────
// Builds on the pre-digested diagnostic. The LLM returns a short headline;
// structured changes always come from the heuristic so they're deterministic.
function askClaudeForHeadline(summary, diag, heuristicChangesList) {
  const prompt = `You are optimising Claude token usage for a multi-repo agentic workload. Below is a pre-digested diagnostic. Your ONE job: write a concrete, specific reduction headline under 80 words. It must reference one of the identified levers and propose a specific action.

Diagnostic (already ranked by reduction potential):
${JSON.stringify({
  total_input_like_M: +(diag.total_input_like / 1e6).toFixed(1),
  cache_hit_rate: summary.yesterday.cacheHitRate,
  opus_share: +diag.opus_share.toFixed(2),
  sonnet_share: +diag.sonnet_share.toFixed(2),
  haiku_share: +diag.haiku_share.toFixed(3),
  cache_creation_ratio: +diag.cache_creation_ratio.toFixed(3),
  top_project_concentration: +diag.top_concentration.toFixed(2),
  top_project: diag.top_project_label,
  entries_per_session: +diag.entries_per_session.toFixed(1),
  trend_delta_pct: +diag.trend_delta_pct.toFixed(2),
  biggest_lever: diag.biggest_lever,
  ranked_levers: diag.ranked_levers.slice(0, 3).map(l => ({ key: l.key, detail: l.detail, potential_M: +(l.potential / 1e6).toFixed(1) })),
  sessions: summary.yesterday.sessions,
}, null, 2)}

Candidate concrete changes from the deterministic rule engine (pick one or synthesise across them):
${heuristicChangesList.slice(0, 3).map((c, i) => `${i + 1}. [${c.where}] ${c.what} (saves ${c.estimated_savings})`).join('\n')}

HARD REQUIREMENTS:
- Under 80 words.
- Name a specific project, model, or hook — no generic advice.
- Include an estimated token savings (M tokens/day).
- Never say "no way to reduce." Never hedge.
- Plain text, one ExampleCoraph, no markdown, no bullet lists.`;

  const reqBody = JSON.stringify({
    model: 'claude-sonnet-4-6',
    messages: [{ role: 'user', content: prompt }],
    stream: false,
  });

  const cmd = process.platform === 'win32'
    ? `curl -s -X POST ${PROXY_URL}/chat/completions -H "Content-Type: application/json" --data-binary @-`
    : `curl -s -X POST ${PROXY_URL}/chat/completions -H "Content-Type: application/json" -d @-`;

  let raw;
  try {
    raw = execSync(cmd, { input: reqBody, timeout: 120000, encoding: 'utf8' });
  } catch (e) {
    throw new Error(`claude proxy call failed: ${String(e.message || e).slice(0, 100)}`);
  }

  // SSE streaming format.
  let text = '';
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const body = line.slice(5).trim();
    if (!body || body === '[DONE]') continue;
    try {
      const j = JSON.parse(body);
      const delta = j.choices && j.choices[0] && j.choices[0].delta;
      if (delta && typeof delta.content === 'string') text += delta.content;
      const message = j.choices && j.choices[0] && j.choices[0].message;
      if (message && typeof message.content === 'string') text += message.content;
    } catch { /* skip malformed line */ }
  }
  if (!text) {
    try {
      const j = JSON.parse(raw);
      text = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
    } catch { /* ignore */ }
  }
  return text.trim();
}

// ── Assemble the output ────────────────────────────────────────────────────
function buildSuggestion(summary, collectorError) {
  if (!summary) {
    // ExampleCo 2026-05-16 #gap: this card must never tell ExampleCo to run a script.
    // main() already reruns collect-daily-token-usage.js when the daily file
    // is missing; reaching here means that self-heal also failed, so the
    // message is Amy-owned and names the actual collector failure instead of
    // handing ExampleCo a command.
    const detail = collectorError
      ? `the collector errored: ${String(collectorError).slice(0, 160)}`
      : 'the collector produced no readable session data';
    return {
      source: 'insufficient-data',
      suggestion: `Amy owns this pipeline. Token-usage rollup for the target day is unavailable: ${detail}.`,
      suggested_changes: [
        {
          where: 'collector pipeline',
          what: `collect-daily-token-usage.js did not produce a readable rollup: ${detail}.`,
          estimated_savings: 'N/A',
          why: 'No usage data means no reduction suggestion this cycle.',
        },
      ],
      diagnostics: null,
    };
  }
  const diag = buildDiagnostics(summary);
  const changes = heuristicChanges(summary, diag);
  const heuristicLead = heuristicHeadline(summary, diag, changes);

  let suggestion = heuristicLead;
  let source = 'heuristic';
  if (!isProxyDisabled()) {
    try {
      const llmText = askClaudeForHeadline(summary, diag, changes);
      if (llmText && llmText.length > 40) {
        suggestion = llmText;
        source = 'hybrid';
      }
    } catch (_e) {
      // Keep heuristic suggestion as-is. Never throw.
    }
  }

  // Final guard: never let "no way to reduce" / "nothing actionable" leak.
  if (/no way to reduce|nothing actionable|no reduction possible|no changes needed/i.test(suggestion)) {
    suggestion = heuristicLead; // force back to the deterministic rule output
    source = 'heuristic';
  }

  return {
    source,
    suggestion,
    suggested_changes: changes,
    diagnostics: {
      cache_hit_rate: summary.yesterday.cacheHitRate,
      opus_share: +diag.opus_share.toFixed(3),
      sonnet_share: +diag.sonnet_share.toFixed(3),
      haiku_share: +diag.haiku_share.toFixed(3),
      cache_creation_ratio: +diag.cache_creation_ratio.toFixed(3),
      top_project_concentration: +diag.top_concentration.toFixed(3),
      top_project_label: diag.top_project_label,
      entries_per_session: +diag.entries_per_session.toFixed(1),
      trend_delta_pct: +diag.trend_delta_pct.toFixed(3),
      biggest_lever: diag.biggest_lever,
      total_input_like_M: +(diag.total_input_like / 1e6).toFixed(2),
    },
  };
}

// ExampleCo 2026-05-16 #gap: when the daily token-usage file is missing the
// suggester self-heals by running the collector instead of asking ExampleCo.
// Returns null on success, or a short error string the card can name.
function runCollector(target) {
  const collector = path.join(REPO, 'scripts', 'collect-daily-token-usage.js');
  try {
    const { spawnSync } = require('child_process');
    const r = spawnSync(process.execPath, [collector, '--date', target], {
      encoding: 'utf8', timeout: 120000, cwd: REPO,
    });
    if (r.status === 0) {
      console.log(`[suggest-token-reduction] self-heal: collector regenerated ${target}`);
      return null;
    }
    return (r.stderr || r.stdout || `collector exited ${r.status}`).trim().slice(0, 200);
  } catch (e) {
    return String(e && e.message || e).slice(0, 200);
  }
}

function main() {
  const args = process.argv.slice(2);
  const dateArg = args.indexOf('--date');
  const target = dateArg >= 0 ? args[dateArg + 1] : ctDateKey(Date.now() - 24 * 60 * 60 * 1000);
  console.log(`[suggest-token-reduction] target=${target}`);

  let files = loadUsageFiles(target);
  let summary = summarizeForPrompt(files, target);
  let collectorError = null;
  if (!summary) {
    // Self-heal: the daily token-usage file is missing. Run the collector
    // ourselves rather than telling ExampleCo to. The collector exits 0 even
    // with zero rows, so after this summary is non-null unless it errored.
    collectorError = runCollector(target);
    files = loadUsageFiles(target);
    summary = summarizeForPrompt(files, target);
  }
  const built = buildSuggestion(summary, collectorError);

  const outPath = path.join(OUT_DIR, `token-reduction-suggestion-${target}.json`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({
    date: target,
    generated_at: new Date().toISOString(),
    suggestion: built.suggestion,
    suggested_changes: built.suggested_changes,
    diagnostics: built.diagnostics,
    source: built.source,
    summary,
  }, null, 2) + '\n');
  console.log(`wrote ${outPath}`);
  console.log(`  source: ${built.source}`);
  console.log(`  changes: ${built.suggested_changes.length}`);
  console.log(`  suggestion: ${String(built.suggestion).slice(0, 120)}...`);
}

if (require.main === module) {
  main();
}

module.exports = {
  summarizeForPrompt,
  loadUsageFiles,
  buildDiagnostics,
  heuristicChanges,
  heuristicHeadline,
  buildSuggestion,
};
