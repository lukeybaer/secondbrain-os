'use strict';

const crypto = require('node:crypto');
const { isBriefingGenerationPreviewUrl } = require('./briefing-dashboard-cache.js');

const PREVIEW_UNAVAILABLE_CODES = new Set([
  'BRIEFING_PREVIEW_BINDING_INVALID',
  'BRIEFING_SCOPED_PREVIEW_UNAVAILABLE',
]);

function isAuthenticatedExactPreview(req) {
  return Boolean(
    req &&
    req._briefingAuthVia &&
    isBriefingGenerationPreviewUrl(req.url || '/briefing'),
  );
}

function isBriefingPreviewUnavailableError(error, req) {
  const code = String((error && error.code) || '');
  if (PREVIEW_UNAVAILABLE_CODES.has(code)) return true;
  return code === 'BRIEFING_ACCEPTED_GENERATION_UNAVAILABLE' && isAuthenticatedExactPreview(req);
}

function renderBriefingDashboardResponse({ req, res, render }) {
  let html;
  try {
    html = render(req.url || '/briefing');
  } catch (error) {
    if (!isBriefingPreviewUnavailableError(error, req)) throw error;
    res.writeHead(409, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end('<!doctype html><title>Briefing preview unavailable</title><p>The exact preview binding is unavailable.</p>');
    return { served: true, statusCode: 409 };
  }
  const etag = `"${crypto.createHash('sha256').update(html).digest('base64url')}"`;
  if (String(req.headers && req.headers['if-none-match'] || '') === etag) {
    res.writeHead(304, {
      'Cache-Control': 'private, no-cache',
      ETag: etag,
    });
    res.end();
    return { served: true, statusCode: 304 };
  }
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'private, no-cache',
    ETag: etag,
  });
  res.end(html);
  return { served: true, statusCode: 200 };
}

module.exports = {
  isAuthenticatedExactPreview,
  isBriefingPreviewUnavailableError,
  renderBriefingDashboardResponse,
};
