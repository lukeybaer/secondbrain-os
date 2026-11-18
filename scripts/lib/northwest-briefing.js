'use strict';

// PRIVATE_NAME documents in the briefing (owner decision):
// "you have to actually open the files ... tell me what's in it." The portal
// reader (scripts/northwest-mail-reader.js) already downloads, OCRs and
// summarizes each scan into data/northwest/documents.jsonl. Every briefing
// surface that mentions a PRIVATE_NAME document uses this module to carry that
// summary's content, or the exact reason Amy could not open the document.
// Never "log in and read it".

const fs = require('node:fs');
const path = require('node:path');

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DASH_RE = /[‒-―−]/g;
const NORTHWEST_RE = /northwest\s+registered\s+agent|PRIVATE_NAME/i;
const DOC_TYPES = 'Federal Notice|Regular Mail|State Notice|Service of Process|Annual Report|Legal Notice|Tax Notice|Certified Mail|Compliance';

function readLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Token forms a portal row title might print for an MM/DD/YYYY upload date. */
function dateForms(uploaded, dayShift = 0) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(uploaded || '').trim());
  if (!m) return [];
  const at = new Date(Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]) + dayShift));
  const [mo, d, y] = [at.getUTCMonth() + 1, at.getUTCDate(), String(at.getUTCFullYear())];
  const pad = (n) => String(n).padStart(2, '0');
  const name = MONTHS[mo - 1];
  return [
    `${pad(mo)}/${pad(d)}/${y}`, `${mo}/${d}/${y}`, `${y}-${pad(mo)}-${pad(d)}`,
    `${name} ${d}, ${y}`, `${name.slice(0, 3)} ${d}, ${y}`,
    `${pad(mo)}/${pad(d)}/${y.slice(2)}`, `${mo}/${d}/${y.slice(2)}`,
    `${pad(mo)}-${pad(d)}-${y.slice(2)}`, `${mo}-${d}-${y.slice(2)}`,
  ];
}

function hasDate(text, form) {
  const esc = form.toLowerCase().replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  return new RegExp(`(^|[^0-9])${esc}($|[^0-9])`).test(String(text || '').toLowerCase());
}

function rowFitsDate(rowText, uploaded) {
  return [0, 1].some((shift) => dateForms(uploaded, shift).some((f) => hasDate(rowText, f)));
}

/** Plain one-line text: no markdown, no long dashes, no angle brackets. */
function flatten(text) {
  return String(text || '')
    .replace(/\*\*|__|`/g, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(DASH_RE, ', ')
    .replace(/--+/g, ', ')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+,/g, ',')
    .trim();
}

function capWords(text, max) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  if (words.length <= max) return words.join(' ');
  return words.slice(0, max).join(' ').replace(/[,;:]$/, '') + ' ...';
}

function normalizeMessageId(value) {
  return String(value || '')
    .replace(/\r?\n[ \t]+/g, '')
    .trim()
    .replace(/^<([\s\S]*)>$/, '$1')
    .trim();
}

function safeExecutiveSummary(text) {
  return flatten(text)
    .replace(/https?:\/\/\S+/gi, '[secure link redacted]')
    .replace(/\b\d{2}-\d{7}\b/g, '[taxpayer ID redacted]')
    .replace(/\b((?:one[- ]time\s+)?(?:pin|registration code|access code|verification code))\s*[:#-]?\s*[A-Z0-9-]{4,}\b/gi, '$1 [redacted]')
    .replace(/\b(taxpayer (?:identification|id)(?: number)?)\s*[:#-]?\s*[A-Z0-9-]{4,}\b/gi, '$1 [redacted]')
    .replace(/\b((?:taxpayer\s+)?authentication)\s*#\s*:?\s*[A-Z0-9][A-Z0-9-]{3,}\b/gi, '$1 [redacted]')
    .replace(/\b((?:irs\s+)?(?:authentication|reference|trace)\s+(?:number|no\.?|id|code))\s*[:#-]?\s*[A-Z0-9][A-Z0-9-]{3,}\b/gi, '$1 [redacted]');
}

function documentClassification(doc, index = 0) {
  const row = flatten(doc && doc.rowText);
  const type = new RegExp(`\\b(${DOC_TYPES})\\b`, 'i').exec(row)?.[1] || '';
  const forms = [...new Set((row + ' ' + safeExecutiveSummary(doc?.summary)).match(/\bCP\s*\d{2,4}[A-Z]?\b/gi)?.map(value => value.replace(/\s+/g, '').toUpperCase()) || [])];
  const form = forms.length === 1 ? forms[0] : '';
  const pinLetter = /\bPIN letter\b/i.test(row) ? 'PIN letter' : '';
  const labels = [...new Set([type, form, pinLetter].filter(Boolean))];
  return labels.length ? labels.join(', ') : `Document ${index + 1}`;
}

/** Every fully read document in the ledger, newest read first. */
function readDocuments(dataDir) {
  const out = [];
  const lines = readLines(path.join(dataDir, 'northwest', 'documents.jsonl'));
  for (let i = lines.length - 1; i >= 0; i--) {
    let row;
    try {
      row = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    for (const d of Array.isArray(row.documents) ? row.documents : []) {
      if (d && d.ok && String(d.summary || '').trim()) out.push({ ...d, readAt: row.ts || '' });
    }
  }
  return out;
}

/**
 * Resolve the read document bound to one notice by the reader's own identity
 * records: a ledger row's notices (Gmail message id, document type, upload
 * date) -> pairs (notice message id -> document sha256) -> documents. A notice
 * matches by Gmail message id, else by exact document type AND exact upload
 * date. The paired document's portal row must also name the notice's type.
 * Exactly one distinct document may result; zero or several yield no summary,
 * so one document's contents are never presented as another's.
 */
function resolveReadDocument(dataDir, { messageId, uploaded, docType } = {}) {
  const wantId = normalizeMessageId(messageId);
  const wantType = String(docType || '').trim().toLowerCase();
  const wantDate = String(uploaded || '').trim();
  const typed = wantType && wantType !== 'document';
  if (!wantId && !(typed && wantDate)) return { doc: null, ambiguous: false };
  const found = new Map();
  for (const line of readLines(path.join(dataDir, 'northwest', 'documents.jsonl'))) {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const notices = Array.isArray(row.notices) ? row.notices : [];
    const pairs = Array.isArray(row.pairs) ? row.pairs : [];
    const docs = Array.isArray(row.documents) ? row.documents : [];
    for (const n of notices) {
      if (!n || typeof n !== 'object' || !n.message_id) continue;
      const nType = String(n.doc_type || '').trim().toLowerCase();
      const nDate = String(n.uploaded || '').trim();
      if (!nType) continue;
      const identity = wantId
        ? normalizeMessageId(n.message_id) === wantId && (!typed || nType === wantType)
        : nType === wantType && nDate === wantDate;
      if (!identity) continue;
      for (const p of pairs) {
        if (!p || normalizeMessageId(p.notice) !== normalizeMessageId(n.message_id) || !p.sha256) continue;
        const d = docs.find((x) => x && x.ok && x.sha256 === p.sha256 && String(x.summary || '').trim());
        if (!d || !String(d.rowText || '').toLowerCase().includes(nType)) continue;
        found.set(d.sha256, { ...d, readAt: row.ts || '' });
      }
    }
  }
  const docs = [...found.values()];
  if (docs.length === 1) return { doc: docs[0], docs, ambiguous: false };
  // One exact Gmail notice may announce several captured PDFs. Returning the
  // complete exact-bound set is safe; choosing one of them would be a guess.
  if (wantId && docs.length > 1) return { doc: null, docs, ambiguous: false };
  return { doc: null, docs: [], ambiguous: found.size > 1 };
}

/** The read document bound to this exact notice, or null (never a guess). */
function findReadDocument(dataDir, query = {}) {
  return resolveReadDocument(dataDir, query).doc;
}

/** Why Amy could not open a document yet, from the reader's own state. */
function readerBlocker(dataDir) {
  const root = path.join(dataDir, 'northwest');
  const state = readJson(path.join(root, 'state.json')) || {};
  const latest = readJson(path.join(root, 'latest.json')) || {};
  const status = state.lastStatus || latest.status || '';
  const err = flatten(latest.error || '').split(' Call log')[0];
  const failures = Number(state.failures || 0);
  if (!status) return 'the portal reader has not run on this document yet';
  if (status === 'read' || status === 'nothing-new') {
    return 'the portal reader has not captured this document yet (its notice is outside the reader window or its row is unmatched)';
  }
  const why =
    {
      failed: err ? `the last portal read failed (${capWords(err, 18)})` : 'the last portal read failed',
      'needs-password': 'the portal password is missing on the server',
      'signed-in-no-document': 'the reader signed in but the portal listed no matching document',
      partial: 'the reader opened the portal but this scan was unreadable or unmatched',
      stuck: 'the reader paused after repeated failures',
      backoff: 'the reader is waiting out its retry delay',
    }[status] || `the last reader status was ${status}`;
  return failures ? `${why}, ${failures} failed attempt${failures === 1 ? '' : 's'} in a row` : why;
}

/**
 * The text a briefing surface shows for one PRIVATE_NAME document: the summary's
 * content when Amy read it, else which document is still unopened and why.
 */
function describeNorthwestDocument(dataDir, { uploaded, docType, company, messageId, maxWords = 90 } = {}) {
  const label = [docType || 'document', company ? `for ${company}` : '', uploaded ? `uploaded ${uploaded}` : '']
    .filter(Boolean)
    .join(' ');
  const { doc, docs = [], ambiguous } = dataDir ? resolveReadDocument(dataDir, { uploaded, docType, messageId }) : { doc: null, docs: [], ambiguous: false };
  if (!doc && docs.length > 1) {
    const perDocumentWords = Math.max(12, Math.floor((Number(maxWords) || 90) / docs.length) - 4);
    const documentSummaries = docs.map((item, index) => ({
      classification: documentClassification(item, index),
      // Keep the complete sanitized per-document content as structured proof.
      // The legacy combined text below remains capped for compact surfaces.
      summary: safeExecutiveSummary(item.summary),
    }));
    const content = documentSummaries
      .map((item) => `${item.classification}: ${capWords(item.summary, perDocumentWords)}`)
      .join(' | ');
    return {
      read: true,
      label,
      documentCount: docs.length,
      documents: documentSummaries,
      content,
      text: `Amy opened ${docs.length} documents exactly bound to the ${label} and read them. ${content}`,
      readAt: docs.map((item) => item.readAt).filter(Boolean).sort().pop() || '',
    };
  }
  if (doc) {
    const summary = safeExecutiveSummary(doc.summary);
    return {
      read: true,
      label,
      documentCount: 1,
      documents: [{ classification: documentClassification(doc, 0), summary }],
      content: capWords(summary, maxWords),
      text: `Amy opened the ${label} and read it. ${capWords(summary, maxWords)}`,
      readAt: doc.readAt,
    };
  }
  const why = !dataDir
    ? 'no portal reader data is available on this host'
    : ambiguous
      ? 'more than one captured document could match this notice, so Amy will not guess which one it is'
      : readerBlocker(dataDir);
  return { read: false, label, reason: why, text: `Amy has not been able to open the ${label}: ${why}.` };
}

/** "A Federal Notice document was uploaded to your account for X on 6/29/2026". */
function parseNoticeText(text) {
  const t = String(text || '').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ');
  const m = /An? (.+?) document was uploaded to your account for\s+(.+?) on (\d{1,2}\/\d{1,2}\/\d{4})/i.exec(t);
  if (m) return { docType: m[1].trim(), company: m[2].trim(), uploaded: m[3] };
  const u = /(?:uploaded|dated)\s+(\d{1,2}\/\d{1,2}\/\d{4})/i.exec(t);
  const type = new RegExp(`\\b(${DOC_TYPES})\\b`, 'i').exec(t);
  const co = /\b(Example Holdings LLC)\b/i.exec(t);
  return u ? { docType: type ? type[1] : 'document', company: co ? co[1] : '', uploaded: u[1] } : null;
}

/**
 * Rewrite any briefing line that mentions PRIVATE_NAME and points the owner at the
 * portal ("still unread", "log in and read") so it carries the document's
 * contents instead. Lines with no parseable document date stay unchanged.
 */
function enrichNorthwestLine(line, dataDir) {
  const text = String(line || '');
  if (!NORTHWEST_RE.test(text) && !/\bunread LLC docs?\b/i.test(text)) return text;
  const doc = parseNoticeText(text);
  if (!doc) return text;
  if (/Amy (?:opened|has not been able to open) the /i.test(text)) return text;
  const d = describeNorthwestDocument(dataDir, doc);
  const stripped = text
    .replace(/\s*Log in to PRIVATE_NAME and read the [^.]*\.?/gi, '')
    .replace(/,?\s*still unread after \d+ reminders?/gi, '')
    .trim();
  return `${stripped} ${d.text}`.replace(/\s+/g, ' ').trim();
}

module.exports = {
  NORTHWEST_RE,
  dateForms,
  rowFitsDate,
  flatten,
  capWords,
  normalizeMessageId,
  safeExecutiveSummary,
  documentClassification,
  readDocuments,
  findReadDocument,
  readerBlocker,
  describeNorthwestDocument,
  parseNoticeText,
  enrichNorthwestLine,
};
