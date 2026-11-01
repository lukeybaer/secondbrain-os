'use strict';

// The one face-text algorithm for news rows (Codex dbea0b1bb2ac). ec2-server.js
// renders the tile face from it and the producer's finance topic gate judges
// the same text, so a row the producer accepts shows the text live QC grades.

function cleanNewsParagraphText(text) {
  let out = String(text || '')
    .replace(/\r/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!out) return '';
  if (/^\*{0,2}TLDR\*{0,2}:?/i.test(out)) return '';
  if (/^read the full article\b/i.test(out) || /RSS-derived summary/i.test(out)) return '';
  if (/^\d+\s+(?:minutes?|hours?|days?)\s+ago\b/i.test(out)) return '';
  if (/\b(?:Correspondent|Reporter|Editor),\s+[A-Z][A-Za-z ,.-]+/.test(out)) return '';
  if (
    /<!\[CDATA\[|Text settings|Story text Size|Subscribers only|Standard\s+Wide\s+Links|SKIP ADVERTISEMENT|hide caption toggle caption|Minimize to nav|Download the NEW APP|Toggle navigation|Current Finance Rates|Finance Rates and MBS|Rate Volatility Index|This website requires Javascrip|\batdigit\b|Today's Videos|Sponsor Message/i.test(
      out,
    )
  )
    return '';
  out = out
    .replace(
      /^\s*\*{0,2}(?:Corrected|Updated|Revised|Final)\s+paragraph\s+\d+(?:\s*\([^)]+\))?:?\*{0,2}\s*/i,
      '',
    )
    .replace(
      /^\s*\*{0,2}(?:Corrected|Updated|Revised|Final|Note|Adding|Rewritten)(?:\s+(?:summary|version|output|paragraph))?(?:\s*\([^)]+\))?:?\*{0,2}\s*/i,
      '',
    )
    .replace(/^(What happened|Why it matters|What to watch):\s*/i, '')
    .trim();
  if (
    /^\*{0,2}(?:Corrected|Updated|Revised|Final|Note|Adding|Rewritten)[^:\n]{0,80}:?\*{0,2}$/i.test(
      out,
    )
  )
    return '';
  return out;
}

// Paragraphs that survive to the rendered row.
function newsFaceParagraphs(paragraphs) {
  return (paragraphs || [])
    .map(cleanNewsParagraphText)
    .filter(Boolean)
    // Strip TLDR lines with or without bold markers
    .filter((p) => !/^\*?\*?tldr\*?\*?:?/i.test(p))
    // Strip bold meta-commentary labels: "**Corrected paragraph 3:**", "**Note:**" etc.
    .filter((p) => !/^\*\*[^*\n]{1,40}\*\*:?\s*$/.test(p));
}

function makeNewsTileTldr(item) {
  const first = (item && item.paragraphs && item.paragraphs[0]) || item?.blurb || '';
  const cleaned = cleanNewsParagraphText(first)
    .replace(/^(what happened|why it matters|what to watch):\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  const m = cleaned.match(/^(.{60,180}?[.!?])(\s|$)/);
  return m ? m[1] : cleaned.slice(0, 180);
}

// The tile renders at most this many tldr characters.
const NEWS_FACE_TLDR_MAX = 160;

// Face text for a stored summary: what the tile shows under the title.
function newsFaceTldr(summary) {
  const paragraphs = newsFaceParagraphs(String(summary || '').split(/\n\s*\n/));
  return makeNewsTileTldr({ paragraphs, blurb: paragraphs.join(' ') }).slice(0, NEWS_FACE_TLDR_MAX);
}

module.exports = {
  NEWS_FACE_TLDR_MAX,
  cleanNewsParagraphText,
  newsFaceParagraphs,
  makeNewsTileTldr,
  newsFaceTldr,
};
