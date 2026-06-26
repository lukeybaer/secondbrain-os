#!/usr/bin/env node
/**
 * validate-plan.js
 *
 * 2026-05-26 ExampleCo: validatePlan is the FAIL-CLOSED pure validator. It
 * receives a build plan plus context (niche YAML, reflection stack,
 * voice duration in seconds when known) and returns a list of every
 * violation. NEVER mutates the plan. NEVER fixes anything. Repair is
 * handled separately by repair-plan.js with an explicit audit log.
 *
 * Public API:
 *   validatePlan(plan, ctx) -> { ok: boolean, errors: string[] }
 *     ctx: { niche: <merged niche YAML>, reflections: [...], voiceDurationS: number }
 *
 * Plan ref: ~/.claude/plans/distributed-questing-wilkinson.md (Categories 1, 6, 7)
 * Contract pinned by scripts/__tests__/validate-plan.test.js.
 */
'use strict';

const REQUIRED_TOP = [
  'plan_version', 'video_id', 'channel',
  'voice', 'script', 'captions', 'stock_clips',
  'music', 'animations', 'reflections_addressed', 'plan_confidence',
];

const HEX_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;
const VALID_DENSITIES = new Set(['low', 'normal', 'high']);

function wordCount(s) {
  return String(s || '').split(/\s+/).filter(Boolean).length;
}

function validateSchema(plan, errors) {
  if (plan === null || typeof plan !== 'object') {
    errors.push('SCHEMA_INVALID: plan must be an object');
    return;
  }
  for (const k of REQUIRED_TOP) {
    if (plan[k] === undefined || plan[k] === null) {
      errors.push(`SCHEMA_MISSING_FIELD: ${k}`);
    }
  }
  if (plan.plan_version !== undefined && plan.plan_version !== '1.0') {
    errors.push(`SCHEMA: plan_version must be "1.0" (got ${JSON.stringify(plan.plan_version)})`);
  }
  if (plan.voice && (typeof plan.voice !== 'object' || !plan.voice.id || !plan.voice.model)) {
    errors.push('SCHEMA_MISSING_FIELD: voice.id and voice.model required');
  }
  if (plan.captions) {
    if (!plan.captions.style) errors.push('SCHEMA_MISSING_FIELD: captions.style');
    if (!plan.captions.emphasis_color) errors.push('SCHEMA_MISSING_FIELD: captions.emphasis_color');
    if (plan.captions.emphasis_color && !HEX_COLOR_RE.test(plan.captions.emphasis_color)) {
      errors.push(`SCHEMA: captions.emphasis_color must match #RRGGBB`);
    }
    if (!Array.isArray(plan.captions.emphasis_word_indices)) {
      errors.push('SCHEMA_MISSING_FIELD: captions.emphasis_word_indices (array)');
    }
  }
  if (plan.animations && plan.animations.density !== undefined
      && !VALID_DENSITIES.has(plan.animations.density)) {
    errors.push(`SCHEMA: animations.density must be one of low|normal|high (got ${plan.animations.density})`);
  }
  if (plan.music) {
    if (!plan.music.track) errors.push('SCHEMA_MISSING_FIELD: music.track');
    if (typeof plan.music.duck_db !== 'number') errors.push('SCHEMA_MISSING_FIELD: music.duck_db (number)');
  }
  if (plan.stock_clips !== undefined) {
    if (!Array.isArray(plan.stock_clips) || plan.stock_clips.length === 0) {
      errors.push('SCHEMA: stock_clips must be a non-empty array');
    } else {
      for (let i = 0; i < plan.stock_clips.length; i += 1) {
        const c = plan.stock_clips[i];
        if (!c || !c.query) errors.push(`SCHEMA_MISSING_FIELD: stock_clips[${i}].query`);
        if (typeof c?.t_in_s !== 'number' || typeof c?.t_out_s !== 'number') {
          errors.push(`SCHEMA_MISSING_FIELD: stock_clips[${i}].t_in_s / t_out_s (numbers)`);
        }
        if (c && c.t_in_s >= c.t_out_s) {
          errors.push(`SCHEMA: stock_clips[${i}] t_in_s (${c.t_in_s}) must be < t_out_s (${c.t_out_s})`);
        }
      }
    }
  }
  if (plan.tags !== undefined && !Array.isArray(plan.tags)) {
    errors.push('SCHEMA: tags must be an array when present');
  }
  if (plan.plan_confidence !== undefined) {
    if (typeof plan.plan_confidence !== 'number' || plan.plan_confidence < 0 || plan.plan_confidence > 1) {
      errors.push(`SCHEMA_VALUE_OUT_OF_RANGE: plan_confidence must be in [0, 1] (got ${plan.plan_confidence})`);
    }
  }
  if (plan.reflections_addressed !== undefined && !Array.isArray(plan.reflections_addressed)) {
    errors.push('SCHEMA: reflections_addressed must be an array');
  }
}

function validateNiche(plan, niche, errors) {
  if (!niche) return;
  // 1. Forbidden phrases in script (case-insensitive substring).
  const script = String(plan.script || '').toLowerCase();
  for (const phrase of niche.script?.forbidden || []) {
    const needle = String(phrase || '').toLowerCase();
    if (needle && script.includes(needle)) {
      errors.push(`SCRIPT_CONTAINS_FORBIDDEN: ${phrase}`);
    }
  }
  // 2. Forbidden tag strings (case-insensitive substring).
  if (Array.isArray(plan.tags)) {
    for (const phrase of niche.tags?.forbidden || []) {
      const needle = String(phrase || '').toLowerCase();
      if (!needle) continue;
      for (let i = 0; i < plan.tags.length; i += 1) {
        const text = String(plan.tags[i]?.text || '').toLowerCase();
        if (text.includes(needle)) {
          errors.push(`TAG_FORBIDDEN: tags[${i}] contains "${phrase}"`);
        }
      }
    }
    // 3. Tag count range.
    if (Array.isArray(niche.tags?.count_range)) {
      const [lo, hi] = niche.tags.count_range;
      if (plan.tags.length < lo || plan.tags.length > hi) {
        errors.push(`TAG_COUNT_OUT_OF_RANGE: ${plan.tags.length} tags; niche allows [${lo}, ${hi}]`);
      }
    }
  }
  // 4. Script word count.
  if (Array.isArray(niche.script?.word_count)) {
    const wc = wordCount(plan.script);
    const [lo, hi] = niche.script.word_count;
    if (wc < lo || wc > hi) {
      errors.push(`SCRIPT_WORD_COUNT_OUT_OF_RANGE: ${wc} words; niche allows [${lo}, ${hi}]`);
    }
  }
  // 5. Stock clip duration cadence.
  if (Array.isArray(plan.stock_clips) && Array.isArray(niche.stock?.cadence_s)) {
    const [lo, hi] = niche.stock.cadence_s;
    for (let i = 0; i < plan.stock_clips.length; i += 1) {
      const c = plan.stock_clips[i];
      const dur = (c?.t_out_s || 0) - (c?.t_in_s || 0);
      if (dur < lo || dur > hi) {
        errors.push(`STOCK_CADENCE_VIOLATION: stock_clips[${i}] duration ${dur.toFixed(2)}s outside niche.stock.cadence_s [${lo}, ${hi}]`);
      }
    }
  }
  // 6. Tag cadence (gap between consecutive t_s).
  if (Array.isArray(plan.tags) && Array.isArray(niche.tags?.cadence_s)) {
    const [lo] = niche.tags.cadence_s;
    const sorted = [...plan.tags].sort((a, b) => (a.t_s || 0) - (b.t_s || 0));
    for (let i = 1; i < sorted.length; i += 1) {
      const gap = (sorted[i].t_s || 0) - (sorted[i - 1].t_s || 0);
      if (gap < lo) {
        errors.push(`TAG_CADENCE_VIOLATION: gap ${gap.toFixed(2)}s between tags at t_s=${sorted[i - 1].t_s} and t_s=${sorted[i].t_s} below niche min ${lo}s`);
      }
    }
  }
}

function validateTimeline(plan, voiceDurationS, errors) {
  if (typeof voiceDurationS !== 'number' || voiceDurationS <= 0) return;
  // 1. Tag t_s in range.
  if (Array.isArray(plan.tags)) {
    for (let i = 0; i < plan.tags.length; i += 1) {
      const t = plan.tags[i]?.t_s;
      if (typeof t !== 'number' || t < 0 || t > voiceDurationS) {
        errors.push(`TAG_TS_OUT_OF_RANGE: tags[${i}].t_s=${t} outside [0, ${voiceDurationS}]`);
      }
    }
  }
  // 2. Stock coverage.
  if (Array.isArray(plan.stock_clips) && plan.stock_clips.length > 0) {
    const sorted = [...plan.stock_clips].sort((a, b) => a.t_in_s - b.t_in_s);
    // First clip must start at 0 (allow small epsilon).
    if (sorted[0].t_in_s > 0.05) {
      errors.push(`STOCK_COVERAGE_GAP: first clip starts at ${sorted[0].t_in_s}s, need 0`);
    }
    // Adjacent gaps + overlap.
    for (let i = 1; i < sorted.length; i += 1) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      if (cur.t_in_s > prev.t_out_s + 0.05) {
        errors.push(`STOCK_COVERAGE_GAP: gap between ${prev.t_out_s}s and ${cur.t_in_s}s`);
      } else if (cur.t_in_s < prev.t_out_s - 0.05 && !plan.allow_overlap) {
        errors.push(`STOCK_OVERLAP: stock_clips[${i - 1}] ends ${prev.t_out_s}s but next starts ${cur.t_in_s}s (set allow_overlap:true to permit)`);
      }
    }
    // Last clip must reach the end.
    const last = sorted[sorted.length - 1];
    if (last.t_out_s < voiceDurationS - 0.05) {
      errors.push(`STOCK_COVERAGE_GAP: last clip ends at ${last.t_out_s}s, need ${voiceDurationS}`);
    }
  }
}

function validateReflectionAddresses(plan, reflections, errors) {
  if (!Array.isArray(plan.reflections_addressed) || !Array.isArray(reflections)) return;
  const known = new Set(reflections.map(r => r.id));
  for (const id of plan.reflections_addressed) {
    if (!known.has(id)) {
      errors.push(`HALLUCINATED_REFLECTION_ADDRESS: "${id}" not in input reflection stack`);
    }
  }
}

function validatePlan(plan, ctx = {}) {
  const errors = [];
  validateSchema(plan, errors);
  // Only run deeper checks when the schema base is sane enough to inspect.
  validateNiche(plan, ctx.niche, errors);
  validateTimeline(plan, ctx.voiceDurationS, errors);
  validateReflectionAddresses(plan, ctx.reflections, errors);
  return { ok: errors.length === 0, errors };
}

module.exports = {
  validatePlan,
  REQUIRED_TOP,
};
