'use strict';

const fs = require('node:fs');
const { sessionCloudPaths } = require('./session-cloud-plane.js');

const METRICS = Object.freeze([
  ['transcript_freshness', 'Session transcript freshness'],
  ['terminal_receipts', 'Session terminal receipts'],
  ['search_projection', 'Session search projection'],
]);

function readSessionCloudHealth({ dataDir } = {}) {
  try {
    const value = JSON.parse(fs.readFileSync(sessionCloudPaths(dataDir).health, 'utf8').replace(/^\uFEFF/, ''));
    return value?.schema === 'amy.session_cloud_health.v1' ? value : null;
  } catch {
    return null;
  }
}

function glyph(status) {
  if (status === 'green') return '✓';
  if (status === 'red') return '✗';
  if (status === 'yellow') return '⚠';
  return '?';
}

function formatSessionCloudHealthRows({ dataDir } = {}) {
  const health = readSessionCloudHealth({ dataDir });
  return METRICS.map(([key, label]) => {
    const metric = health?.metrics?.[key];
    if (!metric) return `? ${label}: no cloud session health receipt is available`;
    return `${glyph(metric.status)} ${label}: ${String(metric.detail || 'metric returned no detail')}`;
  });
}

module.exports = {
  METRICS,
  formatSessionCloudHealthRows,
  readSessionCloudHealth,
};
