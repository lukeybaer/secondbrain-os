#!/usr/bin/env node
// lessons-aggregator.js
//
// Cross-skill LESSONS.md aggregator. The companion skill-lessons.js is
// per-skill (appendLesson / readRecentLessons). This module walks every
// scheduled-tasks/<skill>/LESSONS.md, normalizes outcome tokens, and surfaces:
//
//   1. Per-skill outcome breakdown (ok / fail / partial / ExampleCo)
//   2. Skills with >= N repeating same-outcome entries (auto-escalation signal)
//   3. Cross-skill failure clusters (same failure phrase across distinct skills)
//   4. Briefing-shaped tier1 + tier2 lines for ExampleCo's CEO three-tier rule.
//
// Why this exists: Letta's Skill Learning 2026 paper showed that
// feedback-informed lessons aggregated across trajectories beat per-task
// reflection alone (+6.7% relative on Terminal Bench). Amy already writes
// per-skill lessons; this is the cross-skill rollup the briefing needs to
// answer "which skill is failing the same way over and over?" in one glance.
//
// Pure module, env-configurable root, tmp-dir-isolated tests.

const fs = require('fs');
const path = require('path');

const REPO_ROOT = () => process.env.SECONDBRAIN_ROOT || path.join(__dirname, '..');

const OK_TOKENS = ['ok', 'success', 'succeed', 'pass', 'passed', 'completed', 'green', 'done', 'shipped'];
const FAIL_TOKENS = ['fail', 'failed', 'error', 'broken', 'red', 'rejected', 'denied', 'blocked', 'timeout', 'crashed'];
const PARTIAL_TOKENS = ['partial', 'ExampleCo', 'warn', 'warning', 'degraded', 'skipped', 'flaky', 'retry'];

function tasksDir() {
  return path.join(REPO_ROOT(), 'scheduled-tasks');
}

function lessonsPath(skillName) {
  return path.join(tasksDir(), skillName, 'LESSONS.md');
}

function classifyOutcome(outcome) {
  if (!outcome || typeof outcome !== 'string') return 'ExampleCo';
  const low = outcome.toLowerCase();
  for (const t of FAIL_TOKENS) if (low.includes(t)) return 'fail';
  for (const t of PARTIAL_TOKENS) if (low.includes(t)) return 'partial';
  for (const t of OK_TOKENS) if (low.includes(t)) return 'ok';
  return 'ExampleCo';
}

function parseLessonsFile(content) {
  if (!content || typeof content !== 'string') return [];
  const blocks = content.split(/\n## /).slice(1);
  return blocks.map((block) => {
    const lines = ('## ' + block).split('\n');
    const date = (lines[0] || '').replace(/^## /, '').trim();
    const input = (lines[1] || '').replace(/^- input:\s*/i, '').trim();
    const outcome = (lines[2] || '').replace(/^- outcome:\s*/i, '').trim();
    return { date, input, outcome, classification: classifyOutcome(outcome) };
  }).filter((e) => e.date || e.input || e.outcome);
}

function listSkillsWithLessons() {
  const dir = tasksDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => {
    try {
      return fs.statSync(lessonsPath(name)).isFile();
    } catch {
      return false;
    }
  }).sort();
}

function readSkillEntries(skillName) {
  const f = lessonsPath(skillName);
  if (!fs.existsSync(f)) return [];
  return parseLessonsFile(fs.readFileSync(f, 'utf8'));
}

function summariseSkill(skillName, { window = 50 } = {}) {
  const all = readSkillEntries(skillName);
  const recent = all.slice(-window);
  const counts = { ok: 0, fail: 0, partial: 0, ExampleCo: 0 };
  for (const e of recent) counts[e.classification] += 1;
  const total = recent.length;
  return {
    skill: skillName,
    total_recent: total,
    counts,
    success_rate: total === 0 ? null : counts.ok / total,
    failure_rate: total === 0 ? null : counts.fail / total,
    last_entry: recent[recent.length - 1] || null,
  };
}

function summariseAll({ window = 50 } = {}) {
  return listSkillsWithLessons().map((s) => summariseSkill(s, { window }));
}

function _tokens(s) {
  if (!s) return new Set();
  return new Set(
    s.toLowerCase()
      .replace(/[^a-z0-9_]+/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 3),
  );
}

function _jaccard(a, b) {
  if (!a.size && !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function detectRecurringFailuresInSkill(skillName, { minCount = 3, similarity = 0.5, window = 50 } = {}) {
  const recent = readSkillEntries(skillName).slice(-window).filter((e) => e.classification === 'fail');
  if (recent.length < minCount) return [];
  const clusters = [];
  for (const entry of recent) {
    const toks = _tokens(entry.outcome);
    let placed = false;
    for (const c of clusters) {
      if (_jaccard(toks, c.tokens) >= similarity) {
        c.entries.push(entry);
        for (const t of toks) c.tokens.add(t);
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push({ tokens: toks, entries: [entry] });
  }
  return clusters
    .filter((c) => c.entries.length >= minCount)
    .map((c) => ({
      skill: skillName,
      count: c.entries.length,
      sample_outcome: c.entries[0].outcome,
      last_seen: c.entries[c.entries.length - 1].date,
    }))
    .sort((a, b) => b.count - a.count);
}

function detectCrossSkillFailureModes({ similarity = 0.5, minSkills = 2, window = 20 } = {}) {
  const skills = listSkillsWithLessons();
  const perSkillFails = new Map();
  for (const s of skills) {
    const fails = readSkillEntries(s).slice(-window).filter((e) => e.classification === 'fail');
    if (fails.length) perSkillFails.set(s, fails);
  }
  const clusters = [];
  for (const [skill, fails] of perSkillFails) {
    for (const f of fails) {
      const toks = _tokens(f.outcome);
      if (toks.size === 0) continue;
      let placed = false;
      for (const c of clusters) {
        if (_jaccard(toks, c.tokens) >= similarity) {
          c.skills.add(skill);
          c.entries.push({ skill, outcome: f.outcome, date: f.date });
          for (const t of toks) c.tokens.add(t);
          placed = true;
          break;
        }
      }
      if (!placed) clusters.push({ tokens: toks, skills: new Set([skill]), entries: [{ skill, outcome: f.outcome, date: f.date }] });
    }
  }
  return clusters
    .filter((c) => c.skills.size >= minSkills)
    .map((c) => ({
      skills: [...c.skills].sort(),
      skill_count: c.skills.size,
      total_occurrences: c.entries.length,
      sample_outcome: c.entries[0].outcome,
    }))
    .sort((a, b) => b.skill_count - a.skill_count || b.total_occurrences - a.total_occurrences);
}

function buildBriefingDigest(options = {}) {
  const window = options.window ?? 50;
  const minCount = options.minCount ?? 3;
  const similarity = options.similarity ?? 0.5;
  const summaries = summariseAll({ window });
  const totalSkills = summaries.length;
  const skillsWithFailures = summaries.filter((s) => s.counts.fail > 0).length;
  const recurring = summaries.flatMap((s) => detectRecurringFailuresInSkill(s.skill, { minCount, similarity, window }));
  const cross = detectCrossSkillFailureModes({ similarity, minSkills: 2, window: Math.min(window, 20) });

  let tier1;
  if (totalSkills === 0) tier1 = 'Lessons: no skill has logged a LESSONS.md entry yet.';
  else if (skillsWithFailures === 0 && recurring.length === 0 && cross.length === 0) tier1 = `Lessons: ${totalSkills} skills tracked, none failing.`;
  else {
    const bits = [];
    bits.push(`${skillsWithFailures}/${totalSkills} skills hit failures`);
    if (recurring.length) bits.push(`${recurring.length} recurring per-skill pattern${recurring.length === 1 ? '' : 's'}`);
    if (cross.length) bits.push(`${cross.length} cross-skill failure mode${cross.length === 1 ? '' : 's'}`);
    tier1 = `Lessons: ${bits.join(', ')}.`;
  }
  const tier2 = [];
  for (const r of recurring.slice(0, 5)) tier2.push(`${r.skill}: same failure x${r.count} (last ${r.last_seen}): "${(r.sample_outcome || '').slice(0, 80)}"`);
  for (const c of cross.slice(0, 5)) tier2.push(`Cross-skill ${c.skill_count} skills [${c.skills.join(', ')}]: "${(c.sample_outcome || '').slice(0, 80)}"`);
  if (tier2.length === 0) tier2.push('Nothing recurring.');
  return {
    generated_at: new Date().toISOString(),
    window,
    tier1,
    tier2,
    tier3: { summaries, recurring, cross_skill: cross, total_skills: totalSkills, skills_with_failures: skillsWithFailures },
    all_clear: skillsWithFailures === 0 && recurring.length === 0 && cross.length === 0,
  };
}

module.exports = {
  classifyOutcome,
  parseLessonsFile,
  listSkillsWithLessons,
  readSkillEntries,
  summariseSkill,
  summariseAll,
  detectRecurringFailuresInSkill,
  detectCrossSkillFailureModes,
  buildBriefingDigest,
  lessonsPath,
};

if (require.main === module) {
  const out = buildBriefingDigest();
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}
