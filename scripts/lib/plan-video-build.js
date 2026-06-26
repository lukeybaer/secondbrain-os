#!/usr/bin/env node
/**
 * plan-video-build.js
 *
 * 2026-05-26 ExampleCo: the planner is the Claude-driven brain of the new
 * pipeline. It takes (spec + rejection history + compiled channel
 * memory + niche YAML + rubric) and emits a concrete build plan JSON
 * the executor can run mechanically. No hardcoded heuristics live in
 * the executor; all craft decisions are made here, per-build, by an
 * LLM call.
 *
 * Public API:
 *
 *   buildPrompt(spec, reflections, niche, opts?) -> string
 *     Pure prompt builder; no side effects. Surfaces every niche field
 *     and every reflection id+lesson so the LLM can address each.
 *
 *   buildPlan(spec, reflections, niche, opts?) -> { plan, validation, raw }
 *     - spec: { id, title, channel, script (optional input draft), ... }
 *     - reflections: array of { id, channel, lesson, ts, canonical }
 *     - niche: merged niche YAML object (from niche-loader.loadNiche)
 *     - opts.llmFn(prompt): async; defaults to the askAI ladder (codex ->
 *       claude-proxy -> claude-cli -> openai floor)
 *     - opts.voiceDurationS: number; passed to validatePlan for timeline checks
 *     - opts.allowRepair: not consumed here; repair is a separate module
 *     Throws PLANNER_NICHE_REQUIRED or PLANNER_SPEC_INCOMPLETE on
 *     missing inputs (fail closed).
 *     Returns { plan: <object|null>, validation: { ok, errors }, raw: <string> }
 *
 * Plan ref: ~/.claude/plans/distributed-questing-wilkinson.md (module #2)
 * Contract pinned by scripts/__tests__/plan-video-build.test.js.
 */
'use strict';

const fs = require('fs');
const path = require('path');
// 2026-06-11 universal LLM ladder: the default LLM call descends
// codex -> claude-proxy -> claude-cli -> openai floor via ask-ai.js. The
// claude-cli oauth env lesson (buildClaudeCliEnv) lives inside the ladder.
const { askAI } = require(path.join(__dirname, 'ask-ai.js'));
const { validatePlan } = require(path.join(__dirname, 'validate-plan.js'));

function buildPrompt(spec, reflections, niche, opts = {}) {
  const reflectionLines = (reflections || []).map((r) => `[${r.id}] ${r.lesson || ''}`);
  const nichePretty = JSON.stringify(niche || {}, null, 2);

  return [
    'You are the BUILD PLANNER for a short-form vertical video. Your job is to produce a SINGLE JSON plan the executor will run mechanically. The executor has NO opinions and NO fallbacks: every craft decision (voice, captions, tags, stock clips with timestamps, music, animations, thumbnail) must be made HERE.',
    '',
    'CONTEXT',
    `channel: ${spec.channel}`,
    `video_id: ${spec.id}`,
    `title: ${spec.title || ''}`,
    `source_url: ${spec.source_url || ''}`,
    spec.script ? `draft script (you may refine): ${spec.script}` : '',
    '',
    'NICHE PROFILE (hard constraints):',
    nichePretty,
    '',
    `CHANNEL REFLECTION STACK (${reflectionLines.length} lesson(s) learned from prior rejections):`,
    reflectionLines.join('\n') || '(none)',
    '',
    'HARD RULES',
    '- Output ONLY a JSON object. No prose, no commentary, no markdown fences.',
    '- voice.id MUST default to the niche.voice.id unless a reflection explicitly says to change it.',
    '- music.track MUST be EXACTLY the value of niche.music.track (verbatim). NEVER invent a filename from the mood string; the executor resolves the filename against the music asset directory and fails fast if missing.',
    '- script word count MUST be inside niche.script.word_count [min, max].',
    '- script MUST NOT contain any niche.script.forbidden phrase (case-insensitive).',
    '- tags[].text MUST NOT contain any niche.tags.forbidden phrase.',
    '- tags count MUST be inside niche.tags.count_range [min, max].',
    '- gap between consecutive tags[].t_s MUST be at least niche.tags.cadence_s[0] seconds.',
    '- every tags[].t_s MUST be within [0, voice_duration_s] (you do not know voice_duration_s exactly; assume the script runs at ~165 wpm and clamp).',
    '- stock_clips MUST cover [0, voice_duration_s] with NO gaps, NO overlaps.',
    '- each stock_clips[i] duration (t_out_s - t_in_s) MUST be inside niche.stock.cadence_s [min, max], INCLUDING THE LAST CLIP. If the total voice duration does not divide evenly, REDISTRIBUTE durations across all clips so every clip lands inside the cadence band. Never emit a tail clip shorter than the minimum.',
    '- captions.emphasis_color MUST be a valid #RRGGBB hex string from niche.captions.emphasis_color.',
    '- animations.density MUST be one of low|normal|high.',
    '- reflections_addressed MUST list every reflection id from the input stack that this plan addresses (do not invent ids; do not silently drop ones you addressed).',
    '- plan_confidence MUST be in [0, 1].',
    '',
    'OUTPUT SHAPE (every field required; do not skip; do not invent fields):',
    '{',
    '  "plan_version": "1.0",',
    `  "video_id": "${spec.id}",`,
    `  "channel": "${spec.channel}",`,
    '  "voice": { "id": "...", "model": "..." },',
    '  "script": "...",',
    '  "captions": { "style": "...", "emphasis_color": "#RRGGBB", "emphasis_word_indices": [int...] },',
    '  "tags": [ { "text": "ALLCAPS 1-3 WORDS", "subtitle": "short", "t_s": 0.0 } ],',
    '  "stock_clips": [ { "query": "...", "t_in_s": 0.0, "t_out_s": 0.0 } ],',
    '  "music": { "track": "filename.mp3", "duck_db": -18 },',
    '  "animations": { "density": "low|normal|high" },',
    '  "thumbnail": { "focal_subject": "...", "title_overlay": "...", "background_style": "..." },',
    '  "reflections_addressed": [ "id1", "id2" ],',
    '  "plan_confidence": 0.0',
    '}',
  ]
    .filter(Boolean)
    .join('\n');
}

function stripFences(s) {
  const m = String(s || '').match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (m) return m[1].trim();
  return String(s || '').trim();
}

// Default LLM call via the universal ladder. silent:true returns null when
// every rung fails; throw so callLlmOnce surfaces LLM_CALL_FAILED and
// validatePlan stays the gate (contract unchanged).
async function defaultLlmFn(prompt) {
  const out = await askAI(prompt, { surface: 'plan-video-build', silent: true });
  if (!out || !out.text) throw new Error('all LLM rungs failed (codex + claude + paid floor)');
  return out.text;
}

async function callLlmOnce(llmFn, prompt) {
  let raw;
  try {
    raw = await llmFn(prompt);
  } catch (e) {
    return { error: `LLM_CALL_FAILED: ${e.message}`, raw: '' };
  }
  const cleaned = stripFences(raw);
  try {
    return { plan: JSON.parse(cleaned), raw };
  } catch (e) {
    return { error: `LLM_PARSE_FAIL: ${e.message}`, raw: String(raw || '').slice(0, 1000) };
  }
}

async function buildPlan(spec, reflections, niche, opts = {}) {
  if (!niche || typeof niche !== 'object') {
    throw new Error('PLANNER_NICHE_REQUIRED: niche is required');
  }
  if (!spec || !spec.id || !spec.channel) {
    throw new Error('PLANNER_SPEC_INCOMPLETE: spec.id and spec.channel are required');
  }
  const llmFn = opts.llmFn || defaultLlmFn;
  const noRetry = opts.noRetry === true;

  // First attempt.
  const prompt = buildPrompt(spec, reflections, niche, opts);
  const first = await callLlmOnce(llmFn, prompt);
  if (first.error) {
    return {
      plan: null,
      validation: { ok: false, errors: [first.error] },
      raw: first.raw,
    };
  }
  const firstValidation = validatePlan(first.plan, {
    niche,
    reflections,
    voiceDurationS: opts.voiceDurationS,
  });
  if (firstValidation.ok || noRetry) {
    return { plan: first.plan, validation: firstValidation, raw: first.raw };
  }

  // 2026-05-26 ExampleCo #learn: ONE retry with the prior validation errors
  // surfaced as feedback. This is GENUINE re-planning, not silent repair:
  // the LLM gets to see exactly what was wrong and produce a corrected
  // plan. Repair via mutation stays opt-in via the separate repairPlan
  // module (planned).
  const retryPrompt = [
    prompt,
    '',
    'PREVIOUS ATTEMPT FAILED VALIDATION. Fix these specific errors in your next plan:',
    ...firstValidation.errors.map((e) => `  - ${e}`),
    '',
    'Emit a corrected JSON plan that resolves every listed error. Do NOT repeat the same mistake.',
  ].join('\n');
  const second = await callLlmOnce(llmFn, retryPrompt);
  if (second.error) {
    // Return the first plan's validation result; the retry failed to even
    // produce a parseable plan, so surface the first attempt's errors to
    // the caller as the source of truth.
    return {
      plan: first.plan,
      validation: firstValidation,
      raw: first.raw,
      retried: true,
      retry_error: second.error,
    };
  }
  const secondValidation = validatePlan(second.plan, {
    niche,
    reflections,
    voiceDurationS: opts.voiceDurationS,
  });
  return {
    plan: second.plan,
    validation: secondValidation,
    raw: second.raw,
    retried: true,
  };
}

module.exports = {
  buildPlan,
  buildPrompt,
  stripFences,
};
