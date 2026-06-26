#!/usr/bin/env node
/**
 * niche-to-legacy-spec.js
 *
 * 2026-05-26 ExampleCo: during the migration week, the OLD
 * scripts/ec2-build-from-queue.py path keeps running for daily
 * generation. This adapter stamps the legacy spec with the channel
 * niche YAML so daily-generation does not drift from the craft
 * contract while the planner+executor pipeline is bedding in.
 *
 * Per Codex review issue #4: prevents split-brain where regen learns
 * but daily-generation keeps shipping the same rejected patterns.
 *
 * Public API:
 *   stampNicheOntoSpec(spec, niche) -> spec'  (NEW object; pure)
 *
 *   - Fills voice_id when missing (from niche.voice.id)
 *   - Fills music_mood when missing (from niche.music.mood)
 *   - Merges banned_phrases (niche.script.forbidden +
 *     niche.tags.forbidden + spec.banned_phrases, dedup case-insensitive)
 *   - Records niche_applied_at and niche_voice_id for audit
 *
 * Contract pinned by scripts/__tests__/niche-to-legacy-spec.test.js.
 */
'use strict';

function dedupCaseInsensitive(arr) {
  const seen = new Set();
  const out = [];
  for (const item of arr || []) {
    if (typeof item !== 'string') continue;
    const k = item.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

function stampNicheOntoSpec(spec, niche) {
  if (!niche || typeof niche !== 'object') {
    throw new Error('ADAPTER_NICHE_REQUIRED: niche is required');
  }
  if (!spec || !spec.channel) {
    throw new Error('ADAPTER_SPEC_INCOMPLETE: spec.channel is required');
  }
  const out = { ...spec };

  // Voice id: fill when empty, never override.
  if (!out.voice_id && niche.voice && niche.voice.id) {
    out.voice_id = niche.voice.id;
  }

  // Music mood: fill when empty.
  if (!out.music_mood && niche.music && niche.music.mood) {
    out.music_mood = niche.music.mood;
  }

  // Banned phrases: merge niche-script-forbidden + niche-tags-forbidden +
  // existing spec.banned_phrases. Niche wins on order (the existing
  // apply_regen_overrides regex consumes them in order).
  const nicheScript = (niche.script && niche.script.forbidden) || [];
  const nicheTags = (niche.tags && niche.tags.forbidden) || [];
  const existing = Array.isArray(spec.banned_phrases) ? spec.banned_phrases : [];
  out.banned_phrases = dedupCaseInsensitive([...nicheScript, ...nicheTags, ...existing]);

  // Audit provenance.
  out.niche_applied_at = new Date().toISOString();
  out.niche_voice_id = niche.voice && niche.voice.id ? niche.voice.id : null;

  return out;
}

module.exports = {
  stampNicheOntoSpec,
};
