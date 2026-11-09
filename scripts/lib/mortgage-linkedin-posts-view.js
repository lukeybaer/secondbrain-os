'use strict';

// Dashboard rendering for the FINANCE LINKEDIN POSTS card. Links only: each
// post opens on LinkedIn (class `act` so the click does not open the overlay).
// There is deliberately no send, comment, like or repost control.

const escapeHtml = (value) =>
  String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const safeUrl = (url) => (/^https:\/\/www\.linkedin\.com\/feed\/update\/urn:li:(?:activity|share|ugcPost):\d+\/$/.test(String(url || '')) ? String(url) : '');

function openLink(row) {
  const url = safeUrl(row.link);
  return url ? `<a class="act mlp-open" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Open post</a>` : '';
}

function author(row) {
  return `<span class="mlp-author"><strong>${escapeHtml(row.author)}</strong>${row.headline ? ` <span class="mlp-headline">${escapeHtml(row.headline)}</span>` : ''}</span>`;
}

function renderTake(row, detail) {
  const tag = detail ? 'article' : 'li';
  return `<${tag} class="${detail ? 'detail-item' : 'item-row'} mlp-item mlp-take" data-item="take-${escapeHtml(row.rank)}">
    <div class="mlp-head"><span class="item-num">${escapeHtml(row.rank)}.</span> ${author(row)}</div>
    <p class="mlp-take-text">${escapeHtml(row.take)}</p>
    <blockquote class="mlp-quote">"${escapeHtml(row.quote)}"</blockquote>
    <p class="mlp-eng">${escapeHtml(row.engagement)} ${openLink(row)}</p>
  </${tag}>`;
}

function renderReshare(row, detail) {
  const tag = detail ? 'article' : 'li';
  return `<${tag} class="${detail ? 'detail-item' : 'item-row'} mlp-item mlp-reshare" data-item="reshare-${escapeHtml(row.rank)}">
    <div class="mlp-head"><span class="item-num">${escapeHtml(row.rank)}.</span> ${author(row)} <span class="mlp-age">${escapeHtml(row.age || '')}</span></div>
    <p class="mlp-summary">${escapeHtml(row.summary)}</p>
    <p class="mlp-why"><strong>Why reshare:</strong> ${escapeHtml(row.why)}</p>
    <p class="mlp-eng">${escapeHtml(row.engagement)} ${openLink(row)}</p>
  </${tag}>`;
}

function renderFinanceLinkedInPosts(data, detail = false) {
  if (!data || !data.available) {
    return `<div class="tile-metric metric-red">BLOCKED</div><p>${escapeHtml((data && data.reason) || 'The finance LinkedIn posts card is unavailable.')}</p>`;
  }
  const list = (rows, render, cls) => (detail ? rows.map((r) => render(r, true)).join('') : `<ol class="mlp-list ${cls}">${rows.map((r) => render(r, false)).join('')}</ol>`);
  // Answer first (EXEC-CRISPNESS): the face leads with the reshare count.
  const head = detail ? '' : `<div class="tile-metric metric-green">${data.reshares.length}</div><div class="tile-label">finance posts to reshare</div>`;
  return `${head}<p class="mlp-summary-block"><strong>Executive summary:</strong> ${escapeHtml(data.summary)}</p>
<h4 class="mlp-section">Top takes:</h4>${list(data.takes, renderTake, 'mlp-takes')}
<h4 class="mlp-section">Reshare these ${data.reshares.length}:</h4>${list(data.reshares, renderReshare, 'mlp-reshares')}
<p class="tile-footnote mlp-note">${escapeHtml(data.note)}</p>
<p class="tile-footnote">${escapeHtml(data.date)}. ${escapeHtml(data.scannedLine || '')}</p>`;
}

const FINANCE_LINKEDIN_POSTS_CSS = `
.mlp-list { list-style:none; padding:0; margin:6px 0 0; }
.mlp-item { display:block !important; margin:0 0 10px; padding:0 0 8px; border-bottom:1px solid var(--line, #e4ddd0); }
.mlp-section { margin:10px 0 2px; font-size:0.95em; }
.mlp-headline, .mlp-age, .mlp-eng { color:var(--muted, #6b6457); font-size:0.9em; }
.mlp-take-text, .mlp-summary, .mlp-why { margin:2px 0; line-height:1.45; }
.mlp-quote { margin:4px 0; padding:2px 8px; border-left:3px solid var(--copper, #b87333); font-style:italic; }
.mlp-open { font-size:0.85em; margin-left:6px; }
`;

module.exports = { renderFinanceLinkedInPosts, FINANCE_LINKEDIN_POSTS_CSS, safeUrl };
