'use strict';

const { ownerRootCauseUsesProofJargon } = require('./briefing-owner-language.js');
const { tokenExplorerReportCitation } = require('./token-explorer.js');

const HEADING = "Here's what you asked for in round two.";
const COMPLETION_STATUSES = new Set([
  'COMPLETE AND VERIFIED',
  'APPROVED, NOT YET COMPLETE',
  'CURRENTLY RED',
  'PAST FAILURE; STILL COUNTS TODAY',
]);
const LABELS = Object.freeze([
  'What went wrong',
  'How to fix or improve it',
  'Impact, complexity, and risk',
]);
const WORKFLOW_STAGES = new Set([
  'planned',
  'approved',
  'source',
  'landed',
  'deployed',
  'verified',
  'completed',
  'diagnosed',
  'historical',
  'blocked',
]);

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function text(value, label) {
  const out = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  if (!out) throw new Error(`owner-feedback delta requires ${label}`);
  return out;
}

function normalize(packet = {}) {
  const date = text(packet.date, 'date');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('date must be YYYY-MM-DD');
  const summary = (Array.isArray(packet.summary) ? packet.summary : []).map((row, index) =>
    text(row, `summary ${index + 1}`),
  );
  if (summary.length < 1 || summary.length > 2) throw new Error('summary must have one or two paragraphs');
  const completionVocabulary = packet.completionVocabulary === true;
  const seen = new Set();
  const sections = (Array.isArray(packet.sections) ? packet.sections : []).map((section, sectionIndex) => ({
    heading: text(section.heading, `section ${sectionIndex + 1} heading`),
    note: String(section.note || '').replace(/\s+/g, ' ').trim(),
    rows: (Array.isArray(section.rows) ? section.rows : []).map((row, rowIndex) => {
      const stableId = text(row.stableId, `section ${sectionIndex + 1} row ${rowIndex + 1} stableId`);
      if (!/^(?:ACTION|TOKEN|STRATEGIC|WATCHER|T|S|RED|W)-\d+$/.test(stableId)) throw new Error(`invalid stable id ${stableId}`);
      if (seen.has(stableId)) throw new Error(`duplicate stable id ${stableId}`);
      seen.add(stableId);
      const normalized = {
        stableId,
        title: text(row.title, `${stableId} title`),
        status: text(row.status, `${stableId} status`),
        stage: text(row.stage, `${stableId} workflow stage`).toLowerCase(),
        whatWentWrong: text(row.whatWentWrong, `${stableId} What went wrong`),
        howToFix: text(row.howToFix, `${stableId} How to fix or improve it`),
        impactRisk: text(row.impactRisk, `${stableId} Impact, complexity, and risk`),
        evidence: String(row.evidence || '').replace(/\s+/g, ' ').trim(),
        href: String(row.href || '').trim(),
        linkLabel: String(row.linkLabel || '').replace(/\s+/g, ' ').trim(),
      };
      if (normalized.href && !/^\/briefing(?:\/|\?)/.test(normalized.href)) {
        throw new Error(`${stableId} link must stay inside the authenticated briefing surface`);
      }
      if (normalized.href && !normalized.linkLabel) {
        throw new Error(`${stableId} link requires a label`);
      }
      if (!normalized.href && normalized.linkLabel) {
        throw new Error(`${stableId} link label requires a link`);
      }
      if (completionVocabulary && !COMPLETION_STATUSES.has(normalized.status)) {
        throw new Error(`${stableId} must use the closed completion vocabulary`);
      }
      if (!WORKFLOW_STAGES.has(normalized.stage)) {
        throw new Error(`${stableId} has invalid workflow stage ${normalized.stage}`);
      }
      if (ownerRootCauseUsesProofJargon(normalized.whatWentWrong)) {
        throw new Error(`${stableId} substitutes proof jargon for an owner outcome`);
      }
      return normalized;
    }),
  }));
  if (!sections.length || sections.some((section) => !section.rows.length)) {
    throw new Error('every owner-feedback delta section needs at least one row');
  }
  return {
    date,
    summary,
    sections,
    originalHref: text(packet.originalHref, 'frozen original report link'),
    heading: text(packet.heading || HEADING, 'report heading'),
    version: String(packet.version || 'revised').trim(),
    completionVocabulary,
  };
}

function field(label, value) {
  return `<p><strong>${escapeHtml(label)}</strong><br>${escapeHtml(value)}</p>`;
}

function renderOwnerFeedbackDeltaReport(rawPacket = {}) {
  const packet = normalize(rawPacket);
  const tokenCitation = tokenExplorerReportCitation({ date: packet.date });
  const sections = packet.sections.map((section) => {
    const rows = section.rows.map((row) => {
      const statusClass = row.status === 'CURRENTLY RED'
        ? ' status-red'
        : row.status === 'COMPLETE AND VERIFIED'
          ? ''
          : ' status-amber';
      return `<article class="item" id="${escapeHtml(row.stableId.toLowerCase())}" data-stable-id="${escapeHtml(row.stableId)}" data-workflow-stage="${escapeHtml(row.stage)}"><div class="id">${escapeHtml(row.stableId)}</div><div><h3>${escapeHtml(row.title)}</h3><span class="status${statusClass}">${escapeHtml(row.status)}</span>${row.href ? `<p><a class="result-link" href="${escapeHtml(row.href)}">${escapeHtml(row.linkLabel)}</a></p>` : ''}${field(LABELS[0], row.whatWentWrong)}${field(LABELS[1], row.howToFix)}${field(LABELS[2], row.impactRisk)}${row.evidence ? `<details><summary>Evidence</summary><p>${escapeHtml(row.evidence)}</p></details>` : ''}</div></article>`;
    }).join('\n');
    return `<h2>${escapeHtml(section.heading)}</h2>${section.note ? `<p class="note">${escapeHtml(section.note)}</p>` : ''}${rows}`;
  }).join('\n');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="sb-status" content="PROPOSED"><meta name="watch-report-date" content="${escapeHtml(packet.date)}"><meta name="watch-report-version" content="owner-feedback-${escapeHtml(packet.version)}"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Overnight report corrections | ${escapeHtml(packet.date)}</title><style>:root{color-scheme:dark;--bg:#0d1118;--panel:#161d28;--ink:#edf3fb;--muted:#aab6c8;--line:#2d394b;--cyan:#67e8f9;--green:#86efac;--amber:#fbbf24;--red:#fca5a5}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15.5px/1.62 "Segoe UI",system-ui,sans-serif}.wrap{max-width:1020px;margin:auto;padding:36px 20px 90px}h1{font-size:clamp(2rem,5vw,3.4rem);line-height:1.08;margin:0 0 12px}h2{color:var(--cyan);border-bottom:1px solid var(--line);padding-bottom:8px;margin:42px 0 14px}h3{margin:0 0 8px}.summary,.item,.history{background:var(--panel);border:1px solid var(--line);border-radius:13px;padding:18px;margin:12px 0}.summary{border-left:4px solid var(--cyan);font-size:16.5px}.summary p{margin:0 0 12px}.summary p:last-child{margin:0}.item{display:grid;grid-template-columns:90px 1fr;gap:16px}.id{font-weight:900;color:var(--amber);letter-spacing:.04em}.status{display:inline-block;color:var(--green);border:1px solid var(--line);border-radius:999px;padding:2px 9px;font-size:12px;font-weight:800}.status-red{color:var(--red)}.status-amber{color:var(--amber)}.item p{margin:11px 0}.note,.history{color:var(--muted)}details{margin-top:12px;border-top:1px solid var(--line);padding-top:10px}summary{cursor:pointer;color:var(--cyan);font-weight:700}a{color:var(--cyan)}@media(max-width:650px){.item{grid-template-columns:1fr}.id{margin-bottom:-6px}}</style></head><body><main class="wrap"><h1>${escapeHtml(packet.heading)}</h1><p class="note">Corrected same-day sibling report. Only changed answers are repeated; the delivered morning report remains frozen. <a class="token-explorer-citation" href="${escapeHtml(tokenCitation.href)}">${escapeHtml(tokenCitation.label)}</a>.</p><section class="summary">${packet.summary.map((row) => `<p>${escapeHtml(row)}</p>`).join('')}</section>${sections}<section class="history"><p><a id="original-report-link" href="${escapeHtml(packet.originalHref)}">Open the frozen original report.</a></p></section></main><script>try{const token=new URLSearchParams(location.search).get('k');if(token){for(const link of document.querySelectorAll('a')){const url=new URL(link.getAttribute('href'),location.origin);url.searchParams.set('k',token);link.href=url.toString();}}}catch{}</script></body></html>`;
  const expectedRows = packet.sections.reduce((sum, section) => sum + section.rows.length, 0);
  if (!html.includes(`<h1>${escapeHtml(packet.heading)}</h1>`)) throw new Error('owner-feedback heading is missing');
  if ((html.match(/class="item"/g) || []).length !== expectedRows) throw new Error('delta row count changed while rendering');
  for (const label of LABELS) {
    const count = (html.match(new RegExp(`<strong>${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}<\\/strong>`, 'g')) || []).length;
    if (count !== expectedRows) throw new Error(`${label} is not present on every delta row`);
  }
  return html;
}

module.exports = { COMPLETION_STATUSES, HEADING, LABELS, WORKFLOW_STAGES, normalize, renderOwnerFeedbackDeltaReport };
