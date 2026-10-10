'use strict';

const path = require('path');

const DEFAULT_VIRAL_CLIP_THEME = 'narrator-in-a-box';
const VIRAL_CLIP_LOGO_BASELINE_WIDTH = 150;
const VIRAL_CLIP_LOGO_SCALE = 0.6;
const VIRAL_CLIP_LOGO_WIDTH = Math.round(VIRAL_CLIP_LOGO_BASELINE_WIDTH * VIRAL_CLIP_LOGO_SCALE);
const VIRAL_CLIP_THEME_VERSION = 'examplechannel-narrator-themes-v2-clean-header-2026-08-29';

const VIRAL_CLIP_THEMES = Object.freeze({
  'narrator-in-a-box': Object.freeze({
    id: 'narrator-in-a-box',
    label: 'Narrator in a box',
    description: 'Editorial frame around the speaker with the full Examplechannel package.',
    fullBleedSource: false,
    speakerFrame: true,
    decorativeBroll: false,
  }),
  'narrator-not-in-a-box': Object.freeze({
    id: 'narrator-not-in-a-box',
    label: 'Narrator not in a box',
    description: 'Full-page authentic speaker footage with restrained brand treatment.',
    fullBleedSource: true,
    speakerFrame: false,
    decorativeBroll: false,
  }),
});

function normalizeViralClipTheme(value, { fallback = DEFAULT_VIRAL_CLIP_THEME } = {}) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return fallback;
  const normalized = raw
    .toLowerCase()
    .replace(/[_\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (!Object.prototype.hasOwnProperty.call(VIRAL_CLIP_THEMES, normalized)) {
    throw new Error(
      `unknown viral clip theme: ${raw}; choose ${Object.keys(VIRAL_CLIP_THEMES).join(' or ')}`,
    );
  }
  return normalized;
}

function applyViralClipTheme(
  proposal,
  value,
  { now = () => new Date(), selectedBy = 'briefing-dashboard' } = {},
) {
  if (!proposal || typeof proposal !== 'object') throw new Error('proposal object required');
  const theme = normalizeViralClipTheme(value);
  proposal.video_theme = theme;
  proposal.video_theme_selected_at = now().toISOString();
  proposal.video_theme_selected_by = selectedBy;
  return theme;
}

function resolveViralClipRoot(proposalFile) {
  const input = String(proposalFile || '');
  const pathApi = input.startsWith('/') ? path.posix : path.win32;
  const resolved = pathApi.resolve(input);
  const filename = pathApi.basename(resolved);
  const clipsDir = pathApi.dirname(resolved);
  if (!/^\d{4}-\d{2}-\d{2}\.json$/i.test(filename)) {
    throw new Error(`viral clip proposal path must end in a dated JSON file: ${proposalFile}`);
  }
  if (pathApi.basename(clipsDir) !== 'viral-tech-clips') {
    throw new Error(`viral clip proposal path is outside viral-tech-clips: ${proposalFile}`);
  }
  const agentDir = pathApi.dirname(clipsDir);
  const dataDir = pathApi.dirname(agentDir);
  if (pathApi.basename(agentDir) !== 'agent' || pathApi.basename(dataDir) !== 'data') {
    throw new Error(
      `viral clip proposal path does not match data/agent/viral-tech-clips: ${proposalFile}`,
    );
  }
  return pathApi.dirname(dataDir);
}

module.exports = {
  DEFAULT_VIRAL_CLIP_THEME,
  VIRAL_CLIP_LOGO_BASELINE_WIDTH,
  VIRAL_CLIP_LOGO_SCALE,
  VIRAL_CLIP_LOGO_WIDTH,
  VIRAL_CLIP_THEME_VERSION,
  VIRAL_CLIP_THEMES,
  normalizeViralClipTheme,
  applyViralClipTheme,
  resolveViralClipRoot,
};
