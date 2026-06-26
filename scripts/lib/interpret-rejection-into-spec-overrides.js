#!/usr/bin/env node
/**
 * interpret-rejection-into-spec-overrides.js
 *
 * 2026-05-25 ExampleCo #learn: rebuild produces identical content across
 * every rejection cycle because build_video() never consults the
 * rejection note content. This helper closes the loop by converting
 * the full rejection HISTORY into structured spec overrides that the
 * build pipeline CAN consume.
 *
 * Public API:
 *
 *   buildPrompt(rejectionHistory, spec) -> string
 *       Composes the Claude prompt. Pure; no side effects.
 *
 *   interpretRejection(rejectionHistory, spec, options?) -> overrides | null
 *       - returns null when there is no rejection history (nothing to interpret)
 *       - returns { error, raw } when the LLM output cannot be parsed (caller
 *         should hard-block instead of rebuilding blindly)
 *       - returns a normalized overrides object on success:
 *           {
 *             banned_phrases: string[],          // verbatim phrases that must NOT appear
 *             hook_phrase: string | null,        // opening line override
 *             opening_tag_override: string | null, // first kinetic-caption tag override
 *             voice_id_override: string | null,  // ElevenLabs voice ID
 *             animation_density: 'low'|'normal'|'high'|null,
 *             stock_query_override: string | null, // B-roll search override
 *             required_directives: string[],     // concrete asks the build must meet
 *             rejection_summary: string,         // 1-line summary for logs
 *             fix_confidence: number,            // 0..1, clamped
 *           }
 *
 *   options.llmFn(prompt) -> Promise<string>
 *       Defaults to the universal askAI ladder. Tests inject mocks.
 *
 * The default llmFn descends the 2026-06-11 LLM fallback ladder
 * (codex -> claude-proxy -> claude-cli -> openai floor) via
 * scripts/lib/ask-ai.js. If every rung fails, the interpreter surfaces
 * an error object so the caller can hard-block.
 */
'use strict';

const path = require('path');
// 2026-06-11 universal LLM ladder (approved plan): the default LLM call is
// no longer claude-only. The 2026-05-25 EC2 401 lesson (claude CLI needs
// CLAUDE_CODE_OAUTH_TOKEN via buildClaudeCliEnv) lives inside the ladder's
// claude-cli rung now.
const { askAI } = require(path.join(__dirname, 'ask-ai.js'));
// E6 2026-06-12: mechanical note -> production-directive translation. The
// prompt must carry BOTH the verbatim notes and the derived directives so
// the structured overrides cannot drift from what the rejection demands
// (feedback_regen_must_translate_rejection_into_build_param_changes.md).
const { buildRegenDirectives } = require(path.join(__dirname, 'regen-feedback-directives.js'));

const VALID_DENSITY = new Set(['low', 'normal', 'high']);

function buildPrompt(rejectionHistory, spec) {
  const histLines = (rejectionHistory || []).map((r, i) => {
    const date = String(r.ts || '').slice(0, 10);
    const target = r.target || 'ExampleCo';
    return `[${i + 1}] ${date} (${target}): ${r.note || ''}`;
  });
  const directives = buildRegenDirectives(rejectionHistory || []);
  const specSummary = [
    `id: ${spec.id || '?'}`,
    `title: ${spec.title || '?'}`,
    `channel: ${spec.channel || '?'}`,
  ].join('\n');

  return [
    'You are reviewing the rejection history of a short-form vertical video that ExampleCo has rejected multiple times. Your job is to translate the rejection text into STRUCTURED spec overrides that the build pipeline can consume on the next rebuild. Without this translation, the rebuild produces identical content.',
    '',
    'CURRENT SPEC:',
    specSummary,
    '',
    `REJECTION HISTORY (${histLines.length} total, oldest first):`,
    histLines.join('\n') || '(none)',
    '',
    'PRODUCTION DIRECTIVES (mechanically derived from the rejection history; the rebuilt video MUST satisfy every one, and your overrides must serve them):',
    directives.map((d) => `- ${d}`).join('\n') || '(none)',
    '',
    'Return a SINGLE JSON object (no prose) with the following fields. Every field is required; use null when the rejection history does not justify an override for that field. Be conservative: only set a field when you can justify it from a specific rejection.',
    '',
    'SCHEMA:',
    '{',
    '  "banned_phrases":         string[],            // exact phrases the next build MUST NOT contain (quote verbatim from the rejections)',
    '  "hook_phrase":            string | null,       // opening line override (1 short sentence) when prior opening was rejected',
    '  "voice_id_override":      string | null,       // ElevenLabs voice id to use when "voice changed" was a rejection',
    '  "animation_density":      "low" | "normal" | "high" | null,  // crank to high when "boring / same the whole time" was rejected',
    '  "stock_query_override":   string | null,       // different B-roll search when prior visuals were rejected',
    '  "required_directives":    string[],            // 1-5 concrete asks the build must meet (e.g. "drop the human taste tag entirely")',
    '  "rejection_summary":      string,              // 1 short sentence summarizing what was wrong',
    '  "fix_confidence":         number               // 0..1, your confidence these overrides will address the feedback',
    '}',
    '',
    'Guidance:',
    '- If the rejection history is empty, return all-null fields with fix_confidence: 0.',
    '- If the rejections contradict each other, prioritize the most recent one.',
    '- Banned phrases must be quoted from the rejections (e.g. if a note says \'first tag "human taste" makes no sense\', banned_phrases should include "human taste").',
    '- Do not guess a voice_id. If the rejection mentions voice but does not specify a voice id, set voice_id_override to null and put a required_directive instead (e.g. "restore the prior voice profile").',
    '- Tags / kinetic-caption overlays are CRAFTED from the actual script, not selected from a slot you can force. Never propose a tag literal as an override. If a tag was wrong, the right fix is a banned_phrase (so the renderer cannot land there) plus a required_directive describing what the tag should reflect (e.g. "first tag should reflect the AI research stack, not generic AI tropes").',
    '',
    'Output ONLY the JSON object. No code fences, no commentary.',
  ].join('\n');
}

function clamp01(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function normalize(parsed) {
  return {
    banned_phrases: Array.isArray(parsed.banned_phrases)
      ? parsed.banned_phrases.filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim())
      : [],
    hook_phrase:
      typeof parsed.hook_phrase === 'string' && parsed.hook_phrase.trim()
        ? parsed.hook_phrase.trim()
        : null,
    // 2026-05-25 ExampleCo: dropped opening_tag_override. Tags are crafted
    // from the script by the playwright overlay renderer, not selected
    // from a slot. A rejected tag is now expressed as a banned_phrase
    // plus a required_directive describing what the tag should reflect.
    voice_id_override:
      typeof parsed.voice_id_override === 'string' && parsed.voice_id_override.trim()
        ? parsed.voice_id_override.trim()
        : null,
    animation_density:
      typeof parsed.animation_density === 'string' && VALID_DENSITY.has(parsed.animation_density)
        ? parsed.animation_density
        : null,
    stock_query_override:
      typeof parsed.stock_query_override === 'string' && parsed.stock_query_override.trim()
        ? parsed.stock_query_override.trim()
        : null,
    required_directives: Array.isArray(parsed.required_directives)
      ? parsed.required_directives
          .filter((d) => typeof d === 'string' && d.trim())
          .map((d) => d.trim())
      : [],
    rejection_summary:
      typeof parsed.rejection_summary === 'string' ? parsed.rejection_summary.trim() : '',
    fix_confidence: clamp01(parsed.fix_confidence),
  };
}

// Strip ```json fences or ``` fences the LLM sometimes adds.
function stripFences(s) {
  const m = String(s || '').match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (m) return m[1].trim();
  return String(s || '').trim();
}

// Default LLM call via the universal ladder (codex -> claude-proxy ->
// claude-cli -> openai floor). silent:true returns null when every rung
// fails; throw so the interpreter wraps it in error handling and returns
// an error object instead of crashing the caller (contract unchanged).
async function defaultLlmFn(prompt) {
  const out = await askAI(prompt, {
    surface: 'interpret-rejection-into-spec-overrides',
    silent: true,
  });
  if (!out || !out.text) throw new Error('all LLM rungs failed (codex + claude + paid floor)');
  return out.text;
}

async function interpretRejection(rejectionHistory, spec, options = {}) {
  if (!Array.isArray(rejectionHistory) || rejectionHistory.length === 0) return null;
  const llmFn = options.llmFn || defaultLlmFn;
  const prompt = buildPrompt(rejectionHistory, spec || {});
  let raw;
  try {
    raw = await llmFn(prompt);
  } catch (e) {
    return { error: `llm call failed: ${e.message}`, raw: '' };
  }
  const cleaned = stripFences(raw);
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    return { error: `json parse failed: ${e.message}`, raw: String(raw || '').slice(0, 600) };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { error: 'json parse produced non-object', raw: String(raw || '').slice(0, 600) };
  }
  return normalize(parsed);
}

module.exports = {
  buildPrompt,
  interpretRejection,
  normalize,
  clamp01,
  stripFences,
};
