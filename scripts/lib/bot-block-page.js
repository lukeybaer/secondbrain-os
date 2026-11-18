'use strict';

// S-3 (Nov 4 #b, the owner approved 2026-11-04): a Cloudflare or bot-check page is
// not article text. On Nov 4 a real lead industry story fetched an
// "Attention Required" page, which then stood in for the
// story's body. A block page reads as "no text" so the next source is tried.
const BLOCK_TEXT_RE =
  /\b(?:Attention Required!?\s*\|\s*Cloudflare|Just a moment\.\.\.|Checking your browser before accessing|Enable JavaScript and cookies to continue|Sorry, you have been blocked|Performance (?:&|and) security by Cloudflare|Verify you are human by completing)/i;
const BLOCK_HTML_RE = /__cf_chl_|cf-browser-verification|\/cdn-cgi\/challenge-platform\//i;

function isBotBlockPage({ html = '', text = '' } = {}) {
  return BLOCK_TEXT_RE.test(String(text).slice(0, 1200)) || BLOCK_HTML_RE.test(String(html).slice(0, 20000));
}

module.exports = { isBotBlockPage };
