#!/usr/bin/env node
// collect-daily-token-usage.js
//
// Walks every `~/.claude/projects/*/` directory and aggregates yesterday's
// message.usage tokens across all sessions. Writes a daily snapshot to
// data/agent/token-usage-YYYY-MM-DD.json.
//
// Feeds the morning briefing §11 token usage section + suggest-token-reduction.js.
// Runs at 5:15 AM CT via scheduled task.
//
// Exit codes:
//   0 -- wrote the file (even if zero entries found for yesterday)
//   1 -- fatal error
//
// Usage:
//   node scripts/collect-daily-token-usage.js                 # yesterday in CT
//   node scripts/collect-daily-token-usage.js --date 2026-04-19
//   node scripts/collect-daily-token-usage.js --stdout        # print JSON, don't write

const fs = require('fs');
const path = require('path');

const HOME = process.env.USERPROFILE || process.env.HOME || '';
const PROJECTS_DIR = path.join(HOME, '.claude', 'projects');
const REPO = process.env.SECONDBRAIN_ROOT || path.join(__dirname, '..');
const OUT_DIR = process.env.SECONDBRAIN_DATA_DIR
  ? path.join(process.env.SECONDBRAIN_DATA_DIR, 'agent')
  : path.join(REPO, 'data', 'agent');

function parseArgs(argv) {
  const args = { date: null, stdout: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--date' && argv[i + 1]) { args.date = argv[i + 1]; i++; }
    else if (argv[i] === '--stdout') args.stdout = true;
  }
  return args;
}

// Return YYYY-MM-DD in America/Chicago for a given ms timestamp.
function ctDateKey(ms) {
  const d = new Date(ms);
  // Central Time is UTC-6 (CST) or UTC-5 (CDT). `en-CA` returns ISO-format.
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

function decodeProjectName(dir) {
  // Claude Code encodes cwd like "C--Users-<user>-secondbrain"; pull the tail.
  const parts = dir.split('-').filter(Boolean);
  return parts[parts.length - 1] || dir;
}

function modelBucket(model) {
  if (!model) return 'ExampleCo';
  if (/opus/i.test(model)) return 'opus';
  if (/sonnet/i.test(model)) return 'sonnet';
  if (/haiku/i.test(model)) return 'haiku';
  return model.toLowerCase();
}

function addUsage(acc, u) {
  acc.input += u.input_tokens || 0;
  acc.output += u.output_tokens || 0;
  acc.cacheCreation += u.cache_creation_input_tokens || 0;
  acc.cacheRead += u.cache_read_input_tokens || 0;
}

function emptyUsage() { return { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 }; }

function totalInputLike(result) {
  const total = (result && result.total) || {};
  return (
    Number(total.input || 0) +
    Number(total.output || 0) +
    Number(total.cacheCreation || 0) +
    Number(total.cacheRead || 0)
  );
}

function readExistingUsage(outPath) {
  try {
    return JSON.parse(fs.readFileSync(outPath, 'utf8'));
  } catch {
    return null;
  }
}

function findRecentRealUsage(targetDate, maxDays = 21) {
  for (let back = 1; back <= maxDays; back += 1) {
    const probe = ctDateKey(Date.parse(`${targetDate}T12:00:00Z`) - back * 86400000);
    const r = aggregate(probe);
    if (!r.error && r.sessionsWithData > 0 && totalInputLike(r) > 0) return { result: r, dataDate: probe };
  }
  return null;
}

function aggregate(targetDate) {
  let projectDirs = [];
  try {
    projectDirs = fs.readdirSync(PROJECTS_DIR).filter((d) => {
      try { return fs.statSync(path.join(PROJECTS_DIR, d)).isDirectory(); } catch { return false; }
    });
  } catch (e) {
    return { error: `cannot read ${PROJECTS_DIR}: ${e.message.slice(0, 80)}` };
  }

  const total = emptyUsage();
  const byModel = {};
  const byProject = {};
  const byProjectSessions = {};
  let entries = 0;
  let sessionsScanned = 0;
  const sessionsWithData = new Set();

  for (const proj of projectDirs) {
    const projPath = path.join(PROJECTS_DIR, proj);
    let files = [];
    try { files = fs.readdirSync(projPath).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      sessionsScanned++;
      const filePath = path.join(projPath, f);
      let content;
      try { content = fs.readFileSync(filePath, 'utf8'); } catch { continue; }
      for (const line of content.split('\n')) {
        if (!line) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        const msg = obj && obj.message;
        const usage = msg && msg.usage;
        if (!usage) continue;
        const ts = obj.timestamp ? Date.parse(obj.timestamp) : 0;
        if (!ts) continue;
        if (ctDateKey(ts) !== targetDate) continue;

        const model = modelBucket(msg.model);
        if (!byModel[model]) byModel[model] = emptyUsage();
        if (!byProject[proj]) byProject[proj] = { ...emptyUsage(), label: decodeProjectName(proj) };
        if (!byProjectSessions[proj]) byProjectSessions[proj] = new Set();

        addUsage(total, usage);
        addUsage(byModel[model], usage);
        addUsage(byProject[proj], usage);
        entries++;
        sessionsWithData.add(proj + '/' + f);
        byProjectSessions[proj].add(f);
      }
    }
  }

  const denom = total.input + total.cacheCreation + total.cacheRead;
  const cacheHitRate = denom > 0 ? total.cacheRead / denom : 0;

  const topProjects = Object.entries(byProject)
    .map(([k, v]) => ({
      project: k,
      label: v.label,
      input: v.input,
      output: v.output,
      cacheRead: v.cacheRead,
      cacheCreation: v.cacheCreation,
      totalInputLike: v.input + v.cacheCreation + v.cacheRead,
      sessions: byProjectSessions[k] ? byProjectSessions[k].size : 0,
      cacheHitRate:
        v.input + v.cacheCreation + v.cacheRead > 0
          ? v.cacheRead / (v.input + v.cacheCreation + v.cacheRead)
          : 0,
    }))
    .sort((a, b) => b.totalInputLike - a.totalInputLike)
    .slice(0, 10);

  const modelMix = Object.fromEntries(
    Object.entries(byModel).map(([k, v]) => [k, v.input + v.cacheCreation + v.cacheRead]),
  );

  return {
    date: targetDate,
    generated_at: new Date().toISOString(),
    total,
    byModel,
    byProject,
    cacheHitRate,
    topProjects,
    modelMix,
    entries,
    sessionsScanned,
    sessionsWithData: sessionsWithData.size,
  };
}

function main() {
  const { date, stdout } = parseArgs(process.argv.slice(2));
  const target = date || ctDateKey(Date.now() - 24 * 60 * 60 * 1000);
  console.log(`[collect-token-usage] aggregating for ${target}`);

  let result = aggregate(target);
  if (result.error) {
    console.error(`error: ${result.error}`);
    process.exit(1);
  }
  const outPath = path.join(OUT_DIR, `token-usage-${target}.json`);
  const existing = readExistingUsage(outPath);
  if (totalInputLike(result) === 0 && result.sessionsWithData > 0) {
    if (existing && totalInputLike(existing) > 0) {
      result = {
        ...existing,
        generated_at: new Date().toISOString(),
        preservedExistingRollup: true,
        fallbackNote:
          existing.fallbackNote ||
          `The local collector saw ${result.sessionsWithData} synthetic zero-usage row(s) for ${target}; preserving the existing non-zero rollup instead of overwriting it.`,
      };
      console.log(
        `[collect-token-usage] ${target} local rows were synthetic zero; preserved existing non-zero rollup`,
      );
    } else {
      const recent = findRecentRealUsage(target);
      if (recent) {
        result = {
          ...recent.result,
          date: target,
          dataDate: recent.dataDate,
          syntheticTargetDay: true,
          fallbackNote: `Only synthetic zero-usage rows were available for ${target}; showing the most recent real usage day, ${recent.dataDate}.`,
        };
        console.log(
          `[collect-token-usage] ${target} had only synthetic zero rows; fell back to ${recent.dataDate}`,
        );
      }
    }
  }
  // 2026-06-07: if the target CT day had ZERO sessions with data (e.g. ExampleCo's PC
  // was off all day), the rollup is legitimately empty, but the dashboard then
  // renders the Token Usage card as "incomplete" and raises a hard blocker. That
  // is not a ExampleCo blocker -- there simply was no usage that day. Fall back to the
  // most recent PRIOR day that DID have usage so the card renders complete and
  // honest ("showing the most recent day with usage"), never incomplete.
  let dataDate = target;
  if (result.sessionsWithData === 0) {
    for (let back = 1; back <= 21; back += 1) {
      const probe = ctDateKey(Date.parse(`${target}T12:00:00Z`) - back * 86400000);
      const r = aggregate(probe);
      if (!r.error && r.sessionsWithData > 0 && totalInputLike(r) > 0) { result = r; dataDate = probe; break; }
    }
    result.date = target; // keep the file keyed to the requested day for the briefing
    result.dataDate = dataDate;
    result.emptyTargetDay = true;
    result.fallbackNote = dataDate !== target
      ? `No Claude Code sessions ran on ${target} (PC off / idle); showing the most recent day with usage, ${dataDate}.`
      : `No Claude Code usage recorded in the last 21 days.`;
    console.log(`[collect-token-usage] ${target} had no sessions; fell back to ${dataDate}`);
  }

  if (stdout) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n');
  console.log(`wrote ${outPath}`);
  console.log(
    `  total: ${(result.total.input / 1e6).toFixed(2)}M input, ${(result.total.output / 1e3).toFixed(0)}K output`,
  );
  console.log(`  cache hit rate: ${(result.cacheHitRate * 100).toFixed(1)}%`);
  console.log(`  entries: ${result.entries} across ${result.sessionsWithData} sessions`);
}

if (require.main === module) {
  main();
}

module.exports = { aggregate, ctDateKey, modelBucket, totalInputLike };
