'use strict';

// Quotes behind a reply (Chat harness fix 3, owner decision).
//
// On Nov 9, three of four unfinished chat asks were call or contact recaps the
// checker refused because their details did not appear in the parts of the
// results it was shown: a long read is cut in the middle for the judge. So the
// engine ends a fact-bearing reply with a SOURCES block of exact quotes. The
// harness checks each quote word for word against the FULL text of everything
// read on the turn, shows the judge which quotes were found, and strips the block
// before the owner sees the reply.

const { readableText } = require('./read-paging.js');

const SOURCES_HEADING = /^[ \t]*(?:\*\*)?SOURCES(?:\*\*)?:?[ \t]*(?:\*\*)?[ \t]*$/im;
const QUOTE = /["“”]([^"“”\n]{6,600})["“”]/g;
const MAX_QUOTES = 40;

function normalize(text) {
  return String(text || '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// The reply the owner reads and the quotes behind it. The last SOURCES heading wins, so
// the word "sources" earlier in a reply is left alone.
function splitSources(reply) {
  const text = String(reply || '');
  let match = null;
  const heading = new RegExp(SOURCES_HEADING.source, 'gim');
  for (let next = heading.exec(text); next; next = heading.exec(text)) match = next;
  if (!match) return { text: text.trim(), quotes: [] };
  const block = text.slice(match.index + match[0].length);
  const quotes = [];
  for (const line of block.split(/\r?\n/)) {
    for (const found of line.matchAll(QUOTE)) {
      const after = line.slice(found.index + found[0].length).replace(/^[\s,:;-]+/, '').trim();
      quotes.push({ quote: found[1].trim(), where: after.replace(/^\((.*)\)$/, '$1').slice(0, 200) });
      if (quotes.length >= MAX_QUOTES) break;
    }
    if (quotes.length >= MAX_QUOTES) break;
  }
  return { text: text.slice(0, match.index).trim(), quotes };
}

// Each quote, found or not in the full text of what was read on this turn.
function verifyQuotes(quotes, sources) {
  const haystacks = (sources || []).map((source) => normalize(readableText(source))).filter(Boolean);
  return (quotes || []).map((entry) => {
    const needle = normalize(entry.quote);
    return { ...entry, found: Boolean(needle) && haystacks.some((haystack) => haystack.includes(needle)) };
  });
}

module.exports = { normalize, splitSources, verifyQuotes };
