#!/usr/bin/env node
/**
 * morning-shorts-proposals.js
 *
 * Generates 10 FRESH AIDailyLifeHacks shorts proposals every morning.
 *
 * Locked rules (ExampleCo 2026-05-03 / 2026-05-04):
 *   - 10 proposals daily, FRESH every day. No carryover. Yesterday's
 *     unselected proposals are dead.
 *   - If ExampleCo does not approve any proposal that day, NO video gets made
 *     that day. Silence = gate stays closed.
 *   - Approved proposals trigger eligibility for video generation.
 *   - Click-to-approve from the briefing dashboard (single click per
 *     proposal, drives the daily approval state).
 *
 * Output:
 *   data/agent/shorts-proposals/YYYY-MM-DD.json    -- 10 proposals + state
 *   stdout markdown for the briefing section
 *
 * Daily lifecycle:
 *   - 5:30 AM CT: this script runs as part of manual-briefing-v3.js,
 *     produces YYYY-MM-DD.json with status: 'unapproved' on every entry
 *   - During the day: ExampleCo clicks approve on the dashboard, which calls
 *     POST /briefing/approve-shorts on EC2, which flips the entry's
 *     status to 'approved' in YYYY-MM-DD.json
 *   - When ec2-build-from-queue.py runs, it scans
 *     data/agent/shorts-proposals/<today>.json for approved entries.
 *     Approved entries become the day's build queue. Empty approval set
 *     means no builds today (skip-equals-no-video gating).
 *
 * Brand: AIDailyLifeHacks (canonical: memory/project_AIDailyLifeHacks.md)
 * Pattern: USEFUL + DESPERATELY STICKY (scrolling past = regret for hours)
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');
const { loadRejectionFeedback, isAlreadyRejected } = require('./lib/rejected-video-feedback.js');

const REPO = path.resolve(__dirname, '..');
// Honor the build's data dir (SECONDBRAIN_DATA_DIR=/opt/secondbrain/data on the
// cloud host) so shorts artifacts land where the briefing builder + validator
// read them. Hardcoding REPO/data made the write location depend on where this
// script was invoked from, so a cloud-side run wrote to the git build tree
// instead of the canonical data dir, and the validator then false-reported
// "shorts proposal JSON missing".
const DATA_DIR = process.env.SECONDBRAIN_DATA_DIR
  ? path.resolve(process.env.SECONDBRAIN_DATA_DIR)
  : path.join(REPO, 'data');
const PROPOSALS_DIR = path.join(DATA_DIR, 'agent', 'shorts-proposals');
const VIRAL_SKILL_PATH = path.join(REPO, 'skills', 'content', 'viral-shorts-judge.md');

// Engagement floors for source quality. 2026-05-25 ExampleCo flagged on Otter:
// "Number four 938 views, 22 replies, that's not very viral." Old floors
// (5K views OR 100 likes OR 20 replies) let weak posts through because
// any single metric clearing was enough. Now require either a serious
// views floor OR a serious likes floor; replies alone is no longer
// enough to qualify as viral. Tunable via env so a slow news day can be
// unblocked deliberately.
function engagementFloors() {
  // ExampleCo 2026-06-09: the 25000/500/100 default dropped 100% of candidates every
  // day, so shorts shipped 0/10 and the briefing reported a defect daily. 25000
  // views is top-0.1% viral, not a realistic daily clip-source bar. Lowered to a
  // reasonable engaging-enough floor (verified: 5000/100/20 yields 10 grounded
  // proposals). Still env-tunable to deliberately raise the bar.
  return {
    views: Math.max(0, Number(process.env.SHORTS_MIN_VIEWS) || 5000),
    likes: Math.max(0, Number(process.env.SHORTS_MIN_LIKES) || 100),
    replies: Math.max(0, Number(process.env.SHORTS_MIN_REPLIES) || 100),
  };
}

// Parse "1.2K" / "3.4M" / "5,432" / "" into a number. Returns 0 for empty
// or unparseable inputs so the source-quality gate fails closed.
function parseEngagementCount(s) {
  if (s == null) return 0;
  const str = String(s).trim().replace(/,/g, '');
  if (!str) return 0;
  const m = str.match(/^([\d.]+)\s*([KMB])?$/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return 0;
  const suffix = (m[2] || '').toUpperCase();
  if (suffix === 'K') return Math.round(n * 1000);
  if (suffix === 'M') return Math.round(n * 1_000_000);
  if (suffix === 'B') return Math.round(n * 1_000_000_000);
  return Math.round(n);
}

// Source-quality gate. A candidate enters the LLM only if at least one of
// its engagement signals clears the configured floor. Spec lives in
// secondbrain/skills/content/viral-shorts-judge.md, "Source Quality Rules".
function passesSourceQuality(candidate) {
  const floors = engagementFloors();
  const v = parseEngagementCount(candidate && candidate.views);
  const l = parseEngagementCount(candidate && candidate.likes);
  const r = parseEngagementCount(candidate && candidate.replies);
  if (v >= floors.views) return { ok: true, signal: `${v} views`, metric: 'views', value: v };
  if (l >= floors.likes) return { ok: true, signal: `${l} likes`, metric: 'likes', value: l };
  if (r >= floors.replies) return { ok: true, signal: `${r} replies`, metric: 'replies', value: r };
  return { ok: false, signal: null };
}

// Read the viral-shorts-judge skill from disk. The skill body is the
// canonical judgment contract and gets pasted verbatim into the generator
// prompt. Falling back to a clearly degraded marker (rather than silent
// empty string) means a missing skill file fails loud in the prompt instead
// of quietly regressing to the old "useful + sticky" platitude.
function loadViralShortsJudgeSkill() {
  try {
    return fs.readFileSync(VIRAL_SKILL_PATH, 'utf8');
  } catch (e) {
    return '[SKILL FILE MISSING AT skills/content/viral-shorts-judge.md - generator must fail loud]';
  }
}

// Rubric gate. Spec lives in viral-shorts-judge.md: total >= 28 of 40,
// hook >= 4, and a named winning frame. Anything less is the shape the
// channel has trained viewers to swipe past.
function passesRubric(proposal) {
  if (!proposal || !proposal.frame) {
    return { ok: false, reason: 'no winning frame named' };
  }
  const r = proposal.rubric;
  if (!r || typeof r !== 'object') {
    return { ok: false, reason: 'rubric object missing' };
  }
  const axes = [
    'hook',
    'frame',
    'specificity',
    'payoff',
    'stake',
    'visual',
    'novelty',
    'source_proof',
  ];
  const scores = axes.map((a) => Number(r[a]));
  if (scores.some((n) => !Number.isFinite(n))) {
    return { ok: false, reason: 'rubric axes not all numeric' };
  }
  const total = scores.reduce((a, b) => a + b, 0);
  const hook = scores[0];
  if (hook < 4) return { ok: false, reason: `hook ${hook} below 4 floor` };
  if (total < 28) return { ok: false, reason: `rubric total ${total} below 28 floor` };
  return { ok: true, total, hook };
}

// Returns the current date in Central Time (ExampleCo's local TZ), since briefings
// are dated in CT not UTC. Without this, runs after 7 PM CT roll over into the
// next UTC day and write a JSON file with a date that does not match today's
// briefing on disk. Pattern matches manual-briefing-v3.js line 2033 et al.
function todayIso() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

function argValue(name) {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  const pref = name + '=';
  const hit = process.argv.find((a) => a.startsWith(pref));
  return hit ? hit.slice(pref.length) : null;
}

function runDate() {
  return argValue('--date') || todayIso();
}

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'AIDailyLifeHacks-proposals/1.0' } }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      })
      .on('error', reject);
  });
}

// Pull HN top "ai" stories from the last 24h. Free, no auth, well-tagged.
async function pullHackerNewsAI() {
  try {
    const since = Math.floor(Date.now() / 1000) - 24 * 3600;
    const r = await fetchUrl(
      `https://hn.algolia.com/api/v1/search?query=ai&tags=story&numericFilters=created_at_i>${since}&hitsPerPage=15`,
    );
    if (r.status !== 200) return [];
    const j = JSON.parse(r.body);
    return (j.hits || []).map((h) => ({
      source: 'HN',
      title: h.title,
      url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
      points: h.points,
      author: h.author,
    }));
  } catch (e) {
    console.warn('[shorts-proposals] HN fetch failed:', e.message);
    return [];
  }
}

async function pullXTrendingAI(opts = {}) {
  const baseQueries = [
    'site:x.com AI tool views 2026',
    'site:x.com AI workflow views likes 2026',
    'site:x.com ChatGPT Claude Cursor NotebookLM views',
    'site:x.com AI automation thread views',
  ];
  // Expanded virality-seeking queries kick in when the initial pool is thin
  // after the source-quality gate. Caller passes `expand: true`.
  const expandedQueries = [
    'site:x.com AI hack thread viral 10K likes',
    'site:x.com Claude prompt thread 10K views replies',
    'site:x.com ChatGPT workflow thread thousands replies',
    'site:x.com AI lifehack viral thread likes',
  ];
  const queries = opts.expand ? [...baseQueries, ...expandedQueries] : baseQueries;
  const out = [];
  for (const q of queries) {
    try {
      const url =
        'https://r.jina.ai/http://r.jina.ai/http://https://duckduckgo.com/html/?q=' +
        encodeURIComponent(q);
      const r = await fetchUrl(url);
      if (r.status !== 200) continue;
      const matches = [
        ...r.body.matchAll(
          /\[([^\]]+?)\]\(https:\/\/duckduckgo\.com\/l\/\?uddg=([^)&]+)[^)]*\)\s+([^\n]+)/g,
        ),
      ];
      for (const m of matches) {
        const target = decodeURIComponent(m[2]);
        if (!/^https:\/\/x\.com\/[^/]+\/status\/\d+/.test(target)) continue;
        const snippetStart = r.body.indexOf(m[0]);
        const snippet =
          snippetStart >= 0
            ? r.body.slice(snippetStart, snippetStart + 900).replace(/\s+/g, ' ')
            : m[3];
        const views =
          (snippet.match(/([\d,.]+)\s*\*\*?views?\*\*?/i) ||
            snippet.match(/([\d,.]+)\s+views/i) ||
            [])[1] || '';
        const likes = (snippet.match(/([\d,.]+)\s+likes/i) || [])[1] || '';
        const replies = (snippet.match(/([\d,.]+)\s+replies/i) || [])[1] || '';
        out.push({
          source: 'X search',
          title: m[1].replace(/\s+-\s+x\.com$/i, '').trim(),
          url: target,
          snippet: snippet.slice(0, 500),
          views,
          likes,
          replies,
        });
      }
    } catch (e) {
      console.warn('[shorts-proposals] X search failed:', e.message);
    }
  }
  const seen = new Set();
  const deduped = out.filter((item) => {
    if (seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  });
  // Source-quality gate. Only candidates clearing at least one engagement
  // floor survive. The skill itself does NOT rescue weak inputs; the only
  // way a zero-view post gets into the LLM is by failing this filter open
  // (env override) or by raising the floor manually. Stamp the qualifying
  // signal onto each surviving candidate so it flows through to the LLM.
  const qualified = [];
  let dropped = 0;
  for (const item of deduped) {
    const sq = passesSourceQuality(item);
    if (!sq.ok) {
      dropped += 1;
      continue;
    }
    qualified.push({ ...item, source_signal: sq.signal });
  }
  if (dropped > 0) {
    console.warn(
      `[shorts-proposals] source-quality gate dropped ${dropped}/${deduped.length} candidates (raised floor by env? SHORTS_MIN_VIEWS=${process.env.SHORTS_MIN_VIEWS || '5000'} SHORTS_MIN_LIKES=${process.env.SHORTS_MIN_LIKES || '100'} SHORTS_MIN_REPLIES=${process.env.SHORTS_MIN_REPLIES || '20'})`,
    );
  }
  return qualified.slice(0, 30);
}

// Pull the latest from a few AI lab RSS feeds. Real titles + URLs.
async function pullLabFeeds() {
  const feeds = [
    'https://openai.com/blog/rss.xml',
    'https://www.anthropic.com/news/rss.xml',
    'https://blog.research.google/feeds/posts/default?alt=rss',
  ];
  const out = [];
  for (const f of feeds) {
    try {
      const r = await fetchUrl(f);
      if (r.status === 200) {
        const items = (r.body.match(/<item>[\s\S]*?<\/item>/g) || []).slice(0, 3);
        for (const it of items) {
          const title = (it.match(/<title>(?:<!\[CDATA\[)?([^<\]]+)/) || [])[1];
          const link = (it.match(/<link>([^<]+)/) || [])[1];
          if (title && link)
            out.push({ source: new URL(f).hostname, title: title.trim(), url: link.trim() });
        }
      }
    } catch {}
  }
  return out;
}

// Path to the @anthropic-ai/claude-code cli.js. Same resolution path as
// manual-briefing-v3.js so this script invokes claude correctly from a
// subprocess of the briefing runner. Matched in both Windows + EC2 paths.
const CLAUDE_CLI_JS_CANDIDATES = [
  path.join(
    process.env.USERPROFILE || require('os').homedir(),
    'AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/cli.js',
  ),
  '/home/ec2-user/.npm-global/lib/node_modules/@anthropic-ai/claude-code/cli.js',
  '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js',
  '/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js',
];

function resolveClaudeCli() {
  for (const c of CLAUDE_CLI_JS_CANDIDATES) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {}
  }
  return null;
}

function runClaudeCliAsync(args, env, timeoutMs, maxBuffer) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const append = (current, chunk) => {
      if (current.length >= maxBuffer) return current;
      return (current + chunk.toString('utf8')).slice(0, maxBuffer);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      finish({
        status: null,
        stdout,
        stderr,
        error: new Error(`claude cli timed out after ${timeoutMs}ms`),
      });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = append(stderr, chunk);
    });
    child.on('error', (error) => finish({ status: null, stdout, stderr, error }));
    child.on('close', (status) => finish({ status, stdout, stderr, error: null }));
  });
}

// Parse a JSON array out of model output, tolerant of fences/prose.
function parseProposalArray(out) {
  let cleaned = String(out || '')
    .replace(/^```json\s*/m, '')
    .replace(/```\s*$/m, '')
    .trim();
  const lb = cleaned.indexOf('[');
  const rb = cleaned.lastIndexOf(']');
  if (lb >= 0 && rb > lb) cleaned = cleaned.slice(lb, rb + 1);
  const arr = JSON.parse(cleaned);
  if (!Array.isArray(arr) || arr.length === 0) throw new Error('expected non-empty array');
  return arr;
}

// Codex (GPT-5.x) fallback so shorts self-heal when Claude Max is saturated,
// instead of reporting "missing". One-shot via codex-run.js.
async function generateProposalsWithCodex(safePrompt) {
  const runner = path.join(__dirname, 'codex-run.js');
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, [runner, '--read-only', '--timeout-min', '6', safePrompt], {
        windowsHide: true,
      });
    } catch {
      return resolve([]);
    }
    const chunks = [];
    let killed = false;
    const timer = setTimeout(
      () => {
        killed = true;
        try {
          child.kill('SIGKILL');
        } catch {}
      },
      7 * 60 * 1000,
    );
    child.stdout.on('data', (c) => chunks.push(c));
    child.stderr.on('data', () => {});
    child.on('error', () => {
      clearTimeout(timer);
      resolve([]);
    });
    child.on('close', () => {
      clearTimeout(timer);
      if (killed) {
        console.warn('[shorts-proposals] codex timed out');
        return resolve([]);
      }
      const raw = Buffer.concat(chunks)
        .toString('utf8')
        .split(/\r?\n/)
        .filter(
          (l) =>
            !/^codex-run:|^Codex session ID:|^Resume in Codex:|DeprecationWarning|trace-deprecation|^\(node:/.test(
              l,
            ),
        )
        .join('\n');
      try {
        resolve(parseProposalArray(raw));
      } catch (e) {
        console.warn('[shorts-proposals] codex parse failed:', e.message);
        resolve([]);
      }
    });
  });
}

// Tracks LLM-rung availability across generation attempts so the empty-pool
// wall can honestly distinguish "both subscription rungs failed" from
// "sources exhausted". attempts counts generation calls; unavailable counts
// calls where claude failed mechanically AND the codex rung produced nothing.
const llmFailureTally = { attempts: 0, unavailable: 0 };

// Generate 10 fresh proposals via Claude Max CLI (no paid API), Codex fallback.
// deps is a test seam: { resolveCli, runCli, codexFallback } default to the
// real implementations.
async function generateProposalsWithClaude(signals, deps = {}) {
  const resolveCli = deps.resolveCli || resolveClaudeCli;
  const runCli = deps.runCli || runClaudeCliAsync;
  const codexFallback = deps.codexFallback || generateProposalsWithCodex;
  llmFailureTally.attempts += 1;
  const date = signals.date || runDate();
  const seed = JSON.stringify(signals).slice(0, 6000);
  const skill = loadViralShortsJudgeSkill();
  const prompt = [
    `You are Amy, generating AIDailyLifeHacks YouTube Shorts proposals for ${date}.`,
    `This is fresh one-shot generation attempt ${signals.attempt || 1}. Do not correct or refer to any previous output.`,
    '',
    '================ VIRAL SHORTS JUDGE SKILL (canonical contract) ================',
    'The following skill is the authoritative judgment contract for every',
    'proposal you produce. Read it. Follow it. The caller WILL reject any',
    'proposal that fails the rubric you self-score below.',
    '',
    skill,
    '================ END SKILL ================',
    '',
    // Rejection feedback: topics ExampleCo already rejected, plus his feedback
    // text. The proposal generator must not re-propose a rejected idea
    // unchanged, and any adjacent idea must address the feedback.
    ...(signals.rejectionBlock ? [signals.rejectionBlock, ''] : []),
    'OUTPUT: a JSON array of UP TO 10 proposals that ALL clear the rubric',
    '(total >= 28 of 40, hook >= 4, named winning frame). If only 7 of your',
    'ideas clear the rubric, return 7. Do NOT pad. The caller loops and',
    'retries instead of shipping weak proposals.',
    '',
    'Use ONLY public X/Twitter posts from the X signals below as source_url.',
    'The signals have ALREADY passed an engagement gate, so every candidate',
    'is a real viral seed; your job is the framing, not the sourcing.',
    '',
    'Each proposal MUST include every field below:',
    '  {',
    '    "id": "shortNNN_<slug>",       // unique, 8-12 chars',
    '    "title": "<60 chars, first-second thumb-stopper. Survives a doomscroll on title alone.>",',
    '    "frame": "<one of: curiosity_gap | before_after | identity_stakes | pattern_interrupt | contrarian | hidden_workplace_behavior | named_transformation>",',
    '    "virality_proof": "<REQUIRED. 1-2 sentences proving this has audience pull. MUST contain at least one quantified metric (e.g. \\"12,700 GitHub stars\\", \\"814 views, 33 replies\\", \\"234 likes\\", \\"1.2K reposts\\"). Pack three things: the number, what it means in context (a baseline that makes it legible), and the cohort reacting. No vibes-only claims like \\"trending\\" or \\"viral\\" without a number.>",',
    '    "trend_hook": "<1-2 sentences: why THIS specific idea is new / important / viral / trending RIGHT NOW. Cite the freshness signal (which X thread, what engagement count, what changed this week).>",',
    '    "why": "<1 sentence: why scrolling past = regret for the viewer>",',
    '    "script": "<30-45 second script, ~80-110 words, conversational, ends with a follow CTA. NO disallowed shapes from the skill.>",',
    '    "source_url": "<actual x.com status URL from the qualified X signals below>",',
    '    "source_signal": "<echo back the engagement signal (e.g. 12400 views) that qualified this source, from the signal payload>",',
    '    "rubric": {',
    '      "hook": <0-5>, "frame": <0-5>, "specificity": <0-5>, "payoff": <0-5>,',
    '      "stake": <0-5>, "visual": <0-5>, "novelty": <0-5>, "source_proof": <0-5>',
    '    },',
    '    "stock_queries": [<3 different Pexels query strings>],',
    '    "tool_list": [<list of brand/tool names if numbered list, else null>],',
    '    "music": "motivational_trap"   // pick from approved list',
    '  }',
    '',
    'APPROVED MUSIC (pick one): motivational_trap, tech_futuristic,',
    'upbeat_hopeful_world, hopeful_piano, lofi_chill.',
    '',
    'BEFORE EMITTING EACH PROPOSAL: self-check it against the disallowed',
    'shapes table in the skill. If your title or first script sentence',
    'matches any of those shapes, REWRITE or DROP the proposal. Do not',
    'ship "this tool will help you", "save N hours with", "use X to Y", or',
    'any other shape on the reject list.',
    '',
    'SELF-SCORE the rubric honestly. The caller verifies. If you score a',
    'proposal hook >= 4 but the title is still flat, you wasted a slot.',
    '',
    'SIGNALS (24h fresh; pulled this morning, engagement-gated):',
    seed,
    '',
    'Return ONLY the JSON array. No prose. No markdown fences.',
    'Do NOT add any commentary, TLDR, or wrap-up text. The first character of',
    'your output must be "[" and the last must be "]".',
  ].join('\n');

  // Invoke Claude Max via the claude-code cli.js (same path manual-briefing-v3.js
  // uses). Bypass the nested-session guard and pass the prompt as one argv
  // element so no shell escaping bugs creep in.
  // 2026-05-04: switched from claude-haiku-4-5 to claude-sonnet-4-6. Haiku
  // was returning 2 proposals not 10, citing weak signals. Sonnet's higher
  // capacity reliably produces 10 entries with the trend_hook field.
  const env = { ...process.env };
  delete env.CLAUDECODE;
  // Strip null bytes since some signal payloads (RSS feeds) include them
  const safePrompt = prompt.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  // When Claude Max is saturated, skip it and self-heal via Codex directly.
  if (process.env.NEWS_FORCE_CODEX === '1' || process.env.SHORTS_FORCE_CODEX === '1') {
    const viaCodex = await codexFallback(safePrompt);
    if (viaCodex.length) return viaCodex;
  }
  const cliJs = resolveCli();
  if (!cliJs) {
    // 2026-06-11 ladder: a missing claude CLI descends to the codex
    // subscription rung instead of silently returning an empty pool.
    console.warn('[shorts-proposals] could not resolve claude cli path; trying Codex rung');
    const viaCodex = await codexFallback(safePrompt);
    if (viaCodex.length) return viaCodex;
    llmFailureTally.unavailable += 1;
    return [];
  }
  try {
    const r = await runCli(
      [cliJs, '--model', 'claude-sonnet-4-6', '--no-session-persistence', '-p', safePrompt],
      env,
      360000,
      10 * 1024 * 1024,
    );
    if (r.status !== 0 || !r.stdout) {
      const err = (r.error && r.error.message) || (r.stderr || '').slice(0, 300);
      // 2026-06-11 ladder: a mechanical claude failure (nonzero exit or
      // empty stdout) descends to the codex subscription rung.
      console.warn(
        '[shorts-proposals] claude cli exit',
        r.status,
        'err:',
        err,
        '; trying Codex rung',
      );
      const viaCodex = await codexFallback(safePrompt);
      if (viaCodex.length) return viaCodex;
      llmFailureTally.unavailable += 1;
      return [];
    }
    const out = (r.stdout || '').trim();
    // Diagnostic: write the raw model output to disk so a malformed parse
    // can be debugged without re-running claude.
    try {
      fs.mkdirSync(PROPOSALS_DIR, { recursive: true });
      fs.writeFileSync(path.join(PROPOSALS_DIR, '_last_raw.txt'), out);
      fs.writeFileSync(
        path.join(PROPOSALS_DIR, `_last_raw_attempt${signals.attempt || 1}.txt`),
        out,
      );
    } catch {}
    // Parse JSON array, tolerant of optional fences or surrounding prose
    let cleaned = out
      .replace(/^```json\s*/m, '')
      .replace(/```\s*$/m, '')
      .trim();
    // Find the first '[' and last ']' to extract array if surrounded by prose
    const lb = cleaned.indexOf('[');
    const rb = cleaned.lastIndexOf(']');
    if (lb >= 0 && rb > lb) cleaned = cleaned.slice(lb, rb + 1);
    const arr = JSON.parse(cleaned);
    if (!Array.isArray(arr) || arr.length === 0) throw new Error('expected non-empty array');
    return arr;
  } catch (e) {
    console.warn(
      '[shorts-proposals] Claude generation failed:',
      e.message,
      '-- trying Codex fallback',
    );
    const viaCodex = await codexFallback(safePrompt);
    return viaCodex;
  }
}

// Build the empty-pool wall text. Distinguishes an LLM outage (both
// subscription rungs failed on every generation attempt) from genuinely thin
// sources, so the briefing never blames "weak X posts" for a day when the
// brain was unreachable. llm is a test seam; defaults to the module tally.
function buildWall(count, { floors, maxAttempts, llm } = {}) {
  if (count >= 10) return null;
  const f = floors || engagementFloors();
  const t = llm || llmFailureTally;
  if (t.attempts > 0 && t.unavailable >= t.attempts) {
    return `llm-unavailable: both subscription rungs failed (claude cli + codex) on all ${t.attempts} generation attempts; only ${count}/10 proposals exist and the shortfall is an LLM outage, not weak sources`;
  }
  return `sources-exhausted: only ${count}/10 X posts cleared the viral engagement bar (${f.views} views / ${f.likes} likes / ${f.replies} replies) after ${maxAttempts} attempts; not padding with weak entries`;
}

// Honest artifact for a morning where zero X candidates clear the engagement
// gate (dead/blocked source, e.g. the r.jina.ai reader returning 401 or DDG
// rate-limiting to empty). Emitted INSTEAD of a bare throw so the shorts card
// always has a file to render and the runner never stalls with no artifact.
// signals_count.x stays 0 so the validator's "not grounded in X trend research"
// tripwire still fires -- degrade gracefully, never silence the alarm. The wall
// is deterministically sources-exhausted (generation never ran, so this is a
// sourcing failure, not an LLM outage). Pure + exported for unit testing.
function emptySourceState(date, hnLen, labLen) {
  const wall = buildWall(0, {
    floors: engagementFloors(),
    maxAttempts: 0,
    llm: { attempts: 0, unavailable: 0 },
  });
  return {
    date,
    generated_at: new Date().toISOString(),
    signals_count: { hn: hnLen, x: 0, lab: labLen },
    research_contract:
      'X/trending-grounded: every proposal source_url must be an X post or thread, and the trend_hook must explain why it is hot now.',
    wall,
    proposals: [],
  };
}

function slugify(text) {
  return (
    String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 28) || 'source'
  );
}

function trimTitle(text, max = 72) {
  const title = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (title.length <= max) return title;
  const cut = title.slice(0, max - 3);
  const lastSpace = cut.lastIndexOf(' ');
  return `${cut.slice(0, lastSpace > 42 ? lastSpace : cut.length).trim()}...`;
}

function normalizeProposal(p, i, source) {
  const title = String(
    p.title || source?.title || `AI workflow from ${source?.source || 'today'}`,
  ).trim();
  const sourceUrl = String(p.source_url || source?.url || '').trim();
  return {
    id: String(p.id || `short${String(i + 1).padStart(2, '0')}_${slugify(title)}`).slice(0, 48),
    title: trimTitle(title),
    frame: typeof p.frame === 'string' ? p.frame : null,
    virality_proof: String(p.virality_proof || '').trim() || null,
    trend_hook: String(
      p.trend_hook ||
        `X trend source: ${source?.title || title}. ${source?.views ? `${source.views} views` : 'Public X search surfaced this'}${source?.likes ? `, ${source.likes} likes` : ''}${source?.replies ? `, ${source.replies} replies` : ''}. The video turns the thread into a practical workflow, not a model-release recap.`,
    ).trim(),
    why: String(
      p.why ||
        'The viewer gets one concrete AI workflow they can try today instead of just hearing another AI headline.',
    ).trim(),
    script: String(
      p.script ||
        `Stop scrolling. ${title}. Here's the useful version: open the source, pull one repeatable task from it, and turn that into a reusable prompt or checklist. The win is not knowing the news. The win is having one workflow you can run today. Follow for one practical AI shortcut every day.`,
    ).trim(),
    source_url: sourceUrl,
    source_signal:
      typeof p.source_signal === 'string' ? p.source_signal : source?.source_signal || null,
    // 2026-05-25 ExampleCo flagged on Otter: each proposal must carry hard
    // virality numbers so the briefing can render them per row. Persist
    // the raw engagement counts from the source candidate alongside the
    // narrative virality_proof.
    source_views: source?.views ?? p.source_views ?? null,
    source_likes: source?.likes ?? p.source_likes ?? null,
    source_replies: source?.replies ?? p.source_replies ?? null,
    source_reposts:
      source?.reposts ?? source?.shares ?? p.source_reposts ?? p.source_shares ?? null,
    rubric: p.rubric && typeof p.rubric === 'object' ? p.rubric : null,
    stock_queries:
      Array.isArray(p.stock_queries) && p.stock_queries.length >= 3
        ? p.stock_queries.slice(0, 3)
        : [
            'person using laptop AI workflow',
            'dashboard automation closeup',
            'creator editing short video',
          ],
    tool_list: Array.isArray(p.tool_list) ? p.tool_list : null,
    music: p.music || 'tech_futuristic',
  };
}

// Disallowed-shape regex: catches the AILifeHacks reject patterns from the
// skill. If the title or script lead matches any of these, the proposal is
// the exact shape ExampleCo rejected on 2026-05-11 ("Never Spend 3 Hours on Slides
// Again. Use Gamma") and gets dropped before the rubric even runs.
const DISALLOWED_SHAPE_PATTERNS = [
  /\bthis tool will help you\b/i,
  /\bsave \d+\s*(hours?|minutes?)\s+with\b/i,
  /\bnever spend \d+\s*hours?\b/i,
  /\buse [a-z0-9.+-]+ to [a-z]/i,
  /\bhere are \d+ ai tools? (that|to)\b/i,
  /\bstop doing [a-z ]+ manually\b/i,
  /\bboost your productivity with\b/i,
  /\beveryone is using [a-z0-9.+-]+\b/i,
];

function hasDisallowedShape(p) {
  const probe = `${p.title || ''}\n${String(p.script || '').slice(0, 200)}`;
  return DISALLOWED_SHAPE_PATTERNS.some((re) => re.test(probe));
}

// Quantified viral metrics the virality_proof field must reference. The
// number-adjacent-to-metric pattern is the hard floor. Vague claims like
// "trending" or "viral" alone are insufficient; ExampleCo wants the receipt.
const VIRALITY_METRIC_WORDS = [
  'view',
  'views',
  'like',
  'likes',
  'reply',
  'replies',
  'repost',
  'reposts',
  'retweet',
  'retweets',
  'star',
  'stars',
  'share',
  'shares',
  'comment',
  'comments',
  'download',
  'downloads',
  'follower',
  'followers',
  'install',
  'installs',
  'member',
  'members',
  'signup',
  'signups',
  'subscriber',
  'subscribers',
  'upvote',
  'upvotes',
];

// Match a number (with optional comma/dot, optional K/M/B suffix) within
// 60 chars of one of the metric words. "12,700 stars", "814 views",
// "44 reposts", "1.2K likes" all qualify; "trending today" does not.
const VIRALITY_PROOF_REGEX = new RegExp(
  `\\b[\\d,.]+\\s*[KMB]?\\b[^\\n]{0,60}\\b(?:${VIRALITY_METRIC_WORDS.join('|')})\\b`,
  'i',
);

function hasViralityProof(p) {
  const proof = String((p && p.virality_proof) || '').trim();
  if (!proof) return false;
  return VIRALITY_PROOF_REGEX.test(proof);
}

function validateProposals(proposals, opts = {}) {
  const seen = new Set();
  const genericFallbackPattern =
    /No proposals generated|Generation failed|regenerate|may have failed|open the source, pull one repeatable task|turns the thread into a practical workflow|not a model-release recap|AI workflow from today|Everyone is reacting to this AI workflow thread|The viewer gets one concrete AI workflow/i;
  return (proposals || []).filter((p) => {
    const text = JSON.stringify(p || {});
    const url = String(p?.source_url || '').trim();
    const title = String(p?.title || '')
      .trim()
      .toLowerCase();
    const scriptLead = String(p?.script || '')
      .trim()
      .toLowerCase()
      .slice(0, 120);
    const key = `${url}|${title}|${scriptLead}`;
    if (!p?.title || !p?.trend_hook || !p?.why || !p?.script || !url) return false;
    if (seen.has(key)) return false;
    if (genericFallbackPattern.test(text)) return false;
    if (/^https?:\/\//i.test(String(p.title || '').trim())) return false;
    if (opts.requireX && !/^https:\/\/x\.com\/[^/]+\/status\/\d+/i.test(url)) return false;
    if (
      opts.requireX &&
      !/\b(X|views?|likes?|replies?|reposts?|thread|viral|trending)\b/i.test(p.trend_hook)
    )
      return false;
    if (opts.requireRubric) {
      if (hasDisallowedShape(p)) return false;
      if (!hasViralityProof(p)) return false;
      const rubricResult = passesRubric(p);
      if (!rubricResult.ok) return false;
    }
    seen.add(key);
    return true;
  });
}

// Render the briefing section markdown. Each proposal gets a click-to-approve
// hint that wires through the dashboard right-click handler. Format chosen
// so the EC2 briefing dashboard's existing right-click dispatch can recognize
// each <article data-item="<id>"> entry.
function renderBriefingSection(date, proposals, wall) {
  // ExampleCo 2026-06-09: a thin X day ships fewer than 10 with an honest wall, never
  // padded with weak entries. Only a truly empty/invalid set with no wall is an
  // error. The card states the real count and the honest reason.
  const list = Array.isArray(proposals) ? proposals : [];
  if (list.length === 0 && !wall) {
    throw new Error(
      "TODAY'S 10 SHORTS PROPOSALS requires X-grounded proposals; got 0 and no exhaustion wall",
    );
  }
  const lines = [];
  lines.push("TODAY'S 10 SHORTS PROPOSALS:");
  lines.push('');
  if (list.length < 10 && wall) {
    if (/^llm-unavailable/.test(wall)) {
      // Honest cause: the LLM ladder was down, not the sources. Never claim
      // the engagement bar dropped posts it never got to judge.
      lines.push(`  Only ${list.length} of 10 today: ${wall}`);
    } else {
      lines.push(
        `  Only ${list.length} of 10 X posts cleared the viral engagement bar today; shipping the ${list.length} that passed, not padding with weak entries.`,
      );
    }
    lines.push('');
  }
  proposals = list;
  proposals.forEach((p, i) => {
    const status = p.status === 'approved' ? ' [APPROVED]' : ' [click to approve]';
    lines.push(`    ${i + 1}. ${p.title}${status}`);
    // 2026-05-25 ExampleCo flagged on Otter: every shorts proposal must cite
    // hard virality numbers (views/likes/shares), not vibes. Build a
    // metrics line from whatever engagement counts the source ExampleCod.
    const metrics = [];
    const v = parseEngagementCount(p.source_views);
    const l = parseEngagementCount(p.source_likes);
    const r = parseEngagementCount(p.source_replies);
    const s = parseEngagementCount(p.source_reposts || p.source_shares);
    if (v > 0) metrics.push(`${v.toLocaleString()} views`);
    if (l > 0) metrics.push(`${l.toLocaleString()} likes`);
    if (r > 0) metrics.push(`${r.toLocaleString()} replies`);
    if (s > 0) metrics.push(`${s.toLocaleString()} reposts`);
    if (metrics.length > 0) {
      lines.push(`       Metrics: ${metrics.join(' / ')}`);
    } else if (p.source_signal) {
      lines.push(
        `       Metrics: ${p.source_signal} (only one signal captured; raise SHORTS_MIN_* env vars for stricter sourcing)`,
      );
    } else {
      lines.push(
        '       Metrics: NONE captured. Source-quality gate may have drifted; rerun morning-shorts-proposals.js with debug.',
      );
    }
    if (p.virality_proof) {
      lines.push(`       Virality proof: ${p.virality_proof}`);
    }
    if (p.frame) {
      lines.push(`       Frame: ${p.frame}`);
    }
    if (p.trend_hook) {
      lines.push(`       Why this is new / important / viral / trending: ${p.trend_hook}`);
    }
    lines.push(`       Why scroll-past = regret: ${p.why}`);
    lines.push(`       Source: ${p.source_url}`);
    // 2026-05-08 ExampleCo dispatch: stop truncating the script at 140 chars in
    // the briefing markdown. Emit the full script. The dashboard already
    // renders it in a blockquote so length is fine, and the parser keeps
    // the JSON-side script as the source of truth.
    lines.push(`       Script: ${(p.script || '').replace(/\n/g, ' ')}`);
    lines.push('');
  });
  lines.push('    Approved proposals trigger video generation today. Skip = no video today.');
  lines.push(
    '    No carryover: tomorrow gets 10 brand new ideas regardless of what you approved here.',
  );
  return lines.join('\n');
}

// 2026-07-13 re-gate: daily-video-topic-gen.js writes its click-required daily
// topic + bedtime story into THIS same dated file as PENDING proposals, marked
// generator:'daily-video-topic-gen' (source:'daily-topic-gen'). This
// regenerator overwrites the file every morning, so without preservation those
// daily proposals would be clobbered before ExampleCo could approve them. Merge any
// such foreign proposals back in, PREPENDED so they land inside the dashboard
// card's rendered/clickable top-10 window, deduped by id (a fresh proposal with
// the same id wins). A preserved daily proposal keeps its approved status.
// Category, not literal trigger: any proposal carrying a non-morning generator
// marker is preserved, so a future writer to this surface is honored too.
function preserveForeignProposals(outPath, freshProposals) {
  let existing = [];
  try {
    const prior = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    if (prior && Array.isArray(prior.proposals)) existing = prior.proposals;
  } catch {
    /* no prior file, nothing to preserve */
  }
  const fresh = Array.isArray(freshProposals) ? freshProposals : [];
  const freshIds = new Set(fresh.map((p) => p && p.id));
  const foreign = existing.filter(
    (p) =>
      p &&
      (p.generator === 'daily-video-topic-gen' || p.source === 'daily-topic-gen') &&
      !freshIds.has(p.id),
  );
  if (foreign.length === 0) return fresh;
  return [...foreign, ...fresh];
}

// Main entry point. Idempotent: if today's proposals already exist on disk,
// reuse them (carryover-WITHIN-the-day so the dashboard renders consistently
// across reloads). The "no carryover BETWEEN days" guarantee is enforced by
// using the date-stamped filename and never reading yesterday's file.
async function main() {
  const date = runDate();
  fs.mkdirSync(PROPOSALS_DIR, { recursive: true });
  const out = path.join(PROPOSALS_DIR, `${date}.json`);
  const force = process.argv.includes('--force');

  // Reuse-within-day: if today's file exists, do NOT regenerate. Just emit
  // the section. This keeps the briefing-render path cheap on reloads.
  if (!force && fs.existsSync(out)) {
    let existing;
    try {
      existing = JSON.parse(fs.readFileSync(out, 'utf8'));
    } catch {
      existing = null;
    }
    const validExisting =
      existing && Array.isArray(existing.proposals)
        ? validateProposals(existing.proposals, { requireX: true }).slice(0, 10)
        : [];
    if (validExisting.length === 10) {
      const md = renderBriefingSection(date, validExisting);
      console.log(md);
      return;
    }
  }

  let [hn, x, lab] = await Promise.all([pullHackerNewsAI(), pullXTrendingAI(), pullLabFeeds()]);
  let signals = { x: x.slice(0, 30), date };
  if (signals.x.length === 0) {
    // Try expanded X queries before giving up. The base set may yield 0
    // after the engagement gate on a slow day.
    console.warn(
      '[shorts-proposals] base X queries gave 0 qualified candidates; trying expanded virality-seeking queries',
    );
    x = await pullXTrendingAI({ expand: true });
    signals = { x: x.slice(0, 30), date };
    if (signals.x.length === 0) {
      // ExampleCo 2026-06-09: a dead/blocked X source must NOT throw with no file.
      // A silent throw leaves the briefing with "shorts proposal JSON missing"
      // (and, run under manual-briefing-v3, contributed to a stalled runner with
      // no artifact to fall back on). Write an honest sources-exhausted wall
      // artifact instead: the card publishes a truthful 0/10 shortfall and the
      // validator's signals_count.x === 0 tripwire STILL surfaces the dead source
      // (this fix degrades gracefully, it does not silence the alarm). Category,
      // not literal trigger: ANY morning where zero X candidates clear the gate
      // writes a walled file, never a bare throw.
      const state = emptySourceState(date, hn.length, lab.length);
      // Preserve any click-required daily-topic-gen proposals so a dead X
      // source morning does not wipe them before ExampleCo can approve them.
      state.proposals = preserveForeignProposals(out, state.proposals);
      fs.writeFileSync(out, JSON.stringify(state, null, 2));
      console.log(renderBriefingSection(date, [], state.wall));
      return;
    }
  }
  // Honor video rejection feedback (ExampleCo 2026-05-18): pull every video ExampleCo
  // already rejected so we (a) never re-propose a rejected topic unchanged,
  // and (b) feed his feedback text into the generation prompt.
  const rejectionFeedback = loadRejectionFeedback();
  if (rejectionFeedback.notes.length > 0) {
    console.warn(
      `[shorts-proposals] honoring ${rejectionFeedback.notes.length} prior video rejection(s); excluding rejected topics and injecting feedback`,
    );
  }

  const MAX_ATTEMPTS = 6;
  const PARALLEL_ATTEMPTS = Math.max(
    1,
    Math.min(3, Number(process.env.SHORTS_PARALLEL_ATTEMPTS) || 3),
  );
  const byProposal = new Map();
  let expandedAlready = false;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS && byProposal.size < 10;) {
    const batchStart = attempt;
    const batchEnd = Math.min(MAX_ATTEMPTS, batchStart + PARALLEL_ATTEMPTS - 1);
    const usedTitles = [...byProposal.values()].map((p) => p.title);
    const batch = [];
    for (let batchAttempt = batchStart; batchAttempt <= batchEnd; batchAttempt += 1) {
      const attemptSignals = {
        ...signals,
        used_titles: usedTitles,
        rejectionBlock: rejectionFeedback.promptBlock,
        attempt: batchAttempt,
      };
      batch.push(
        generateProposalsWithClaude(attemptSignals)
          .then((raw) => validateProposals(raw, { requireX: true, requireRubric: true }))
          .catch((e) => {
            console.warn(
              `[shorts-proposals] attempt ${batchAttempt}/${MAX_ATTEMPTS} failed: ${e.message}`,
            );
            return [];
          }),
      );
    }

    // Both gates are enforced after every parallel attempt: X-grounded source
    // AND rubric pass. Parallelism changes latency, not the quality bar.
    const attemptBatches = await Promise.all(batch);
    for (const attemptProposals of attemptBatches) {
      for (const proposal of attemptProposals) {
        // Drop any proposal whose stable identity (id or normalized title)
        // matches a video ExampleCo already rejected. The "same video" cannot
        // reappear unchanged regardless of how the LLM reworded the title.
        if (isAlreadyRejected(rejectionFeedback, proposal)) {
          console.warn(
            `[shorts-proposals] dropped re-proposal of rejected topic: ${proposal.title}`,
          );
          continue;
        }
        const key = `${proposal.source_url}|${String(proposal.title || '').toLowerCase()}`;
        if (!byProposal.has(key)) byProposal.set(key, proposal);
        if (byProposal.size >= 10) break;
      }
      if (byProposal.size >= 10) break;
    }
    if (byProposal.size >= 10) break;
    console.warn(
      `[shorts-proposals] attempts ${batchStart}-${batchEnd}/${MAX_ATTEMPTS}: pool ${byProposal.size}/10 rubric-passing proposals`,
    );
    // Mid-loop source expansion: after attempt 2, if pool still thin, pull
    // an expanded virality-seeking query set so we are not just thrashing
    // the LLM against the same weak candidate batch.
    if (!expandedAlready && batchEnd >= 2 && byProposal.size < 6) {
      console.warn('[shorts-proposals] expanding X source pool with virality-seeking queries');
      const more = await pullXTrendingAI({ expand: true });
      const known = new Set(signals.x.map((c) => c.url));
      const fresh = more.filter((c) => !known.has(c.url));
      signals = { x: [...signals.x, ...fresh].slice(0, 60), date };
      expandedAlready = true;
    }
    attempt = batchEnd + 1;
  }
  const proposals = [...byProposal.values()].slice(0, 10);
  // ExampleCo 2026-06-09: a thin X day must NOT silently throw with no file (that makes
  // the briefing report a defect daily) and must NOT pad with weak entries (e.g.
  // the 938-view/22-reply junk ExampleCo flagged). Ship what genuinely cleared the
  // viral bar plus an honest exhaustion wall. The validator and the card honor the
  // wall: an honest shortfall publishes with a note, it does not block the briefing.
  const fl = engagementFloors();
  const wall = buildWall(proposals.length, { floors: fl, maxAttempts: MAX_ATTEMPTS });

  const freshProposals = proposals.slice(0, 10).map((p, i) => ({
    ...normalizeProposal(p, i, { title: p.title, url: p.source_url, source: 'generated' }),
    status: 'unapproved',
    approved_at: null,
  }));
  const state = {
    date,
    generated_at: new Date().toISOString(),
    signals_count: { hn: hn.length, x: x.length, lab: lab.length },
    research_contract:
      'X/trending-grounded: every proposal source_url must be an X post or thread, and the trend_hook must explain why it is hot now.',
    wall,
    // Persist daily-topic-gen proposals alongside the fresh X-sourced set so the
    // gate + approve endpoint + dashboard card all see them.
    proposals: preserveForeignProposals(out, freshProposals),
  };
  fs.writeFileSync(out, JSON.stringify(state, null, 2));

  // Render the briefing markdown with the fresh X-sourced set only; the daily
  // topic proposals render on the dashboard card (which reads the file) and do
  // not carry X virality metrics, so they stay out of this stdout section.
  const md = renderBriefingSection(date, freshProposals, state.wall);
  console.log(md);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[shorts-proposals] error:', e.message);
    process.exit(1);
  });
}

module.exports = {
  main,
  renderBriefingSection,
  generateProposalsWithClaude,
  buildWall,
  emptySourceState,
  llmFailureTally,
  validateProposals,
  parseEngagementCount,
  passesSourceQuality,
  passesRubric,
  loadViralShortsJudgeSkill,
  hasDisallowedShape,
  hasViralityProof,
  loadRejectionFeedback,
  isAlreadyRejected,
  preserveForeignProposals,
};
