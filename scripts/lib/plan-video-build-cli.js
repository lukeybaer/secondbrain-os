#!/usr/bin/env node
/**
 * Thin CLI wrapper around plan-video-build.buildPlan so the sync
 * auto-regen-rejected-videos.js main loop can spawnSync into it.
 * Same shape as interpret-rejection-cli.js.
 *
 * Usage:
 *   node scripts/lib/plan-video-build-cli.js \
 *     --spec        <path to spec.json>  (or --spec-json '<inline>')
 *     --reflections <path to reflections.jsonl>  (or omit for empty)
 *     --niche       <channel name>  (loaded via niche-loader)
 *     --out         <path to write plan.json>
 *     [--voice-duration-s <number>]
 *
 * Exit codes:
 *   0 success: plan validated, written to --out
 *   1 missing args / spec / niche / planner threw
 *   2 plan failed validation (validation.errors printed to stderr;
 *     plan still written to --out with .invalid suffix for inspection)
 *
 * Plan ref: ~/.claude/plans/distributed-questing-wilkinson.md
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { loadNiche } = require(path.join(__dirname, 'niche-loader.js'));
const { loadReflections } = require(path.join(__dirname, 'rejection-reflections.js'));
const { compileChannelMemory } = require(path.join(__dirname, 'compile-channel-memory.js'));
const { buildPlan } = require(path.join(__dirname, 'plan-video-build.js'));

function argv(name, fallback = null) {
  const ix = process.argv.indexOf(name);
  if (ix < 0) return fallback;
  return process.argv[ix + 1] || fallback;
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { throw new Error(`could not read ${p}: ${e.message}`); }
}

async function main() {
  const specPath = argv('--spec');
  const specJson = argv('--spec-json');
  const niche = argv('--niche');
  const outPath = argv('--out');
  const voiceDurationS = parseFloat(argv('--voice-duration-s', '0')) || undefined;

  if (!outPath) {
    process.stderr.write('MISSING_ARG: --out is required\n');
    process.exit(1);
  }
  if (!niche) {
    process.stderr.write('MISSING_ARG: --niche <channel> is required\n');
    process.exit(1);
  }
  if (!specPath && !specJson) {
    process.stderr.write('MISSING_ARG: --spec <path> or --spec-json <inline> is required\n');
    process.exit(1);
  }

  let spec;
  try {
    spec = specJson ? JSON.parse(specJson) : readJson(specPath);
  } catch (e) {
    process.stderr.write(`SPEC_PARSE_FAIL: ${e.message}\n`);
    process.exit(1);
  }

  let nicheObj;
  try {
    nicheObj = loadNiche(niche);
  } catch (e) {
    process.stderr.write(`NICHE_LOAD_FAIL: ${e.message}\n`);
    process.exit(1);
  }

  // Reflections: compiled bounded view per Codex review issue #5.
  // Pass active + canonical lessons to the planner as the verbal critique stack.
  const rawRefs = loadReflections(niche);
  const compiled = compileChannelMemory(niche);
  const reflectionsForPlanner = [...compiled.canonical, ...compiled.active]
    .map(r => ({ id: r.id, channel: niche, lesson: r.lesson, ts: r.last_seen, canonical: r.canonical }));

  let result;
  try {
    result = await buildPlan(spec, reflectionsForPlanner, nicheObj, { voiceDurationS });
  } catch (e) {
    process.stderr.write(`PLANNER_THREW: ${e.message}\n`);
    process.exit(1);
  }

  if (!result.plan) {
    process.stderr.write(`PLAN_PARSE_FAIL: ${JSON.stringify(result.validation.errors)}\n`);
    if (result.raw) {
      const invalidOut = outPath + '.raw';
      fs.writeFileSync(invalidOut, String(result.raw));
      process.stderr.write(`(raw LLM output saved to ${invalidOut})\n`);
    }
    process.exit(2);
  }

  // Always write the plan so the operator can inspect it; signal invalid
  // via exit code (2) and stderr instead.
  fs.writeFileSync(outPath, JSON.stringify(result.plan, null, 2));

  if (!result.validation.ok) {
    process.stderr.write(`PLAN_VALIDATION_FAILED:\n  ${result.validation.errors.join('\n  ')}\n`);
    process.exit(2);
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    out: outPath,
    rawAlsoExternal: !!specJson,
    refl_count: reflectionsForPlanner.length,
    plan_confidence: result.plan.plan_confidence,
  }) + '\n');
  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(`UNCAUGHT: ${e.message}\n`);
  process.exit(1);
});
