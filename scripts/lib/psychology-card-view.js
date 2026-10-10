'use strict';
const escapeHtml = (value) => String(value || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function renderPsychology(data, detail = false) {
  if (data.status !== 'ready') return '<div class="tile-metric metric-red">BLOCKED</div><p>The psychology pair is unavailable.</p>';
  const items = data.items.map((item) => `<article class="${detail ? 'detail-item' : 'item-row'} psychology-concept" data-item="${escapeHtml(item.id)}" style="display:block;margin:16px 0">
    <${detail ? 'h3' : 'h4'} class="${detail ? 'detail-h' : 'item-title'}" style="margin:0 0 6px">${escapeHtml(item.name)}</${detail ? 'h3' : 'h4'}>
    <p class="psychology-definition" style="margin:0 0 7px;line-height:1.5">${escapeHtml(item.definition)}</p>
    <p class="item-why psychology-application" style="margin:0;line-height:1.5"><strong>For you:</strong> ${escapeHtml(item.application)}</p>
    ${detail ? `<p class="detail-meta">${item.sources.map((s) => `<a href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(s.title)}</a>`).join(' · ')}</p>` : ''}
  </article>`).join('');
  return `${detail ? '' : '<div class="tile-metric metric-green">2</div><div class="tile-label">psychological concepts for your day</div>'}${items}<p class="tile-footnote">${escapeHtml(data.date)}. This pair stays until you open the card. A new pair can appear the next day.</p>`;
}
module.exports = { renderPsychology };
