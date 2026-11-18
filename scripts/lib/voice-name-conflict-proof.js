'use strict';

const fs = require('node:fs');
const path = require('node:path');

function safeAudioUrl(row) {
  const probePath = String(row?.probe_audio_path || '').trim();
  if (
    !probePath ||
    probePath.includes('..') ||
    /^[a-z]+:/i.test(probePath) ||
    probePath.startsWith('/') ||
    probePath.startsWith('\\')
  ) {
    return '';
  }
  return `/life-archive/voice-audio?path=${encodeURIComponent(probePath)}`;
}

function readConflictArtifact(dataDir, fsApi = fs) {
  const file = path.join(
    dataDir,
    'life-archive',
    'voiceprints',
    'voice-name-conflicts-latest.json',
  );
  try {
    return JSON.parse(fsApi.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function renderVoiceNameConflictProof({
  itemName,
  dataDir,
  escapeHtml,
  fsApi = fs,
} = {}) {
  if (!/voice name conflicts/i.test(String(itemName || ''))) return '';
  const artifact = readConflictArtifact(dataDir, fsApi);
  const rows = Array.isArray(artifact?.conflicts) ? artifact.conflicts : [];
  if (!rows.length) {
    return '<p class="detail-help">No current calibrated acoustic contradiction against an assigned voiceprint is recorded.</p>';
  }
  const esc = typeof escapeHtml === 'function' ? escapeHtml : (value) => String(value || '');
  return `<div class="voice-name-conflict-proof" data-role="voice-name-conflict-proof">
    <h4>Review the durable voice evidence</h4>
    ${rows
      .map((row) => {
        const audioUrl = safeAudioUrl(row);
        const reviewUrl = String(row?.review_url || '');
        const provisionalMismatch =
          row?.conflict_type === 'provisional_promotion_name_mismatch';
        return `<article class="voice-name-conflict-row detail-item">
          ${
            provisionalMismatch
              ? `<p><strong>Promotion blocked:</strong> the voice candidate is <strong>${esc(row?.candidate_display_name || row?.candidate_person_id || 'unknown')}</strong>, while current complete marked-speaker review strongly names <strong>${esc(row?.marked_call_best_name || 'someone else')}</strong>. This does not change any confirmed voiceprint.</p>`
              : `<p><strong>Assigned voiceprint:</strong> ${esc(row?.confirmed_display_name || row?.person_id || 'Known voice')}.</p>
          <p><strong>Acoustic contradiction:</strong> the calibrated model favors <strong>${esc(row?.best_alternative_display_name || row?.best_alternative_person_id || 'another enrolled voice')}</strong>${Number.isFinite(Number(row?.best_alternative_probability)) ? ` at ${Math.round(Number(row.best_alternative_probability) * 100)}% calibrated probability` : ''}${Number.isFinite(Number(row?.alternative_margin_over_assigned)) ? `, with a ${Number(row.alternative_margin_over_assigned).toFixed(3)} raw-score margin over the assigned voiceprint` : ''}. Text-name guesses are not used to make this claim.</p>`
          }
          ${
            audioUrl
              ? `<audio controls preload="none" src="${esc(audioUrl)}"></audio>`
              : '<p class="tile-banner-warn">No playable voiceprint clip is attached to this conflict. The conflict remains red.</p>'
          }
          ${
            reviewUrl.startsWith('/life-archive/voice-sequence')
              ? `<p><a href="${esc(reviewUrl)}" target="_blank" rel="noopener">Review the marked whole-call evidence</a></p>`
              : ''
          }
          ${
            !provisionalMismatch &&
            row?.action_voice_cluster_id &&
            row?.assignment_cluster_id &&
            row?.person_id &&
            row?.cluster_fingerprint
              ? `<p><button type="button" class="act voice-tool-btn voice-action-btn" data-action="voice-confirm" data-voice-action="keep_voiceprint" data-id="${esc(row.action_voice_cluster_id)}" data-assignment-cluster-id="${esc(row.assignment_cluster_id)}" data-guess="${esc(row.confirmed_display_name || row.person_id)}" data-person-id="${esc(row.person_id)}" data-cluster-fingerprint="${esc(row.cluster_fingerprint)}">No, keep this voiceprint</button></p>`
              : ''
          }
        </article>`;
      })
      .join('')}
  </div>`;
}

module.exports = {
  safeAudioUrl,
  readConflictArtifact,
  renderVoiceNameConflictProof,
};
