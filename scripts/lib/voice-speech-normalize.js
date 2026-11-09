'use strict';

// Text that goes straight to text-to-speech, without a model turn in between,
// must already be speakable: no markdown, citations, or URLs, and numbers as
// words. On 2026-10-14 the news reader read "600,000 square foot" as a digit
// run. Used by the server-served news turn (scripts/lib/voice-news-server-turn.js).

const ONES = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
  'seventeen', 'eighteen', 'nineteen',
];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const SCALES = [
  [1e12, 'trillion'],
  [1e9, 'billion'],
  [1e6, 'million'],
  [1e3, 'thousand'],
];
const ORDINAL_WORDS = {
  one: 'first', two: 'second', three: 'third', five: 'fifth', eight: 'eighth',
  nine: 'ninth', twelve: 'twelfth',
};

function underHundred(n) {
  if (n < 20) return ONES[n];
  const t = TENS[Math.floor(n / 10)];
  return n % 10 ? `${t}-${ONES[n % 10]}` : t;
}

function underThousand(n) {
  const h = Math.floor(n / 100);
  const rest = n % 100;
  if (!h) return underHundred(rest);
  return rest ? `${ONES[h]} hundred ${underHundred(rest)}` : `${ONES[h]} hundred`;
}

function integerToWords(value) {
  let n = Math.floor(Math.abs(Number(value)));
  if (!Number.isFinite(n) || n >= 1e15) return String(value);
  if (n === 0) return 'zero';
  const parts = [];
  for (const [size, word] of SCALES) {
    if (n >= size) {
      parts.push(`${underThousand(Math.floor(n / size))} ${word}`);
      n %= size;
    }
  }
  if (n) parts.push(underThousand(n));
  return parts.join(' ');
}

function digitsToWords(digits) {
  return String(digits)
    .split('')
    .map((d) => ONES[Number(d)])
    .join(' ');
}

function decimalToWords(raw) {
  const clean = String(raw).replace(/,/g, '');
  const [whole, frac] = clean.split('.');
  const head = integerToWords(Number(whole || 0));
  return frac ? `${head} point ${digitsToWords(frac)}` : head;
}

function yearToWords(year) {
  const y = Number(year);
  if (y >= 2000 && y <= 2009) return integerToWords(y);
  const hi = Math.floor(y / 100);
  const lo = y % 100;
  if (lo === 0) return `${underHundred(hi)} hundred`;
  return `${underHundred(hi)} ${lo < 10 ? `oh ${ONES[lo]}` : underHundred(lo)}`;
}

function ordinalToWords(n) {
  const words = integerToWords(n);
  const lastSpace = Math.max(words.lastIndexOf(' '), words.lastIndexOf('-'));
  const head = words.slice(0, lastSpace + 1);
  const tail = words.slice(lastSpace + 1);
  if (ORDINAL_WORDS[tail]) return head + ORDINAL_WORDS[tail];
  if (tail.endsWith('y')) return `${head}${tail.slice(0, -1)}ieth`;
  return `${head}${tail}th`;
}

function stripMarkup(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\((?:https?:\/\/|www\.)[^)]*\)/gi, '$1')
    .replace(/\((?:source:\s*)?(?:https?:\/\/|www\.)[^)]*\)/gi, ' ')
    .replace(/(?:https?:\/\/|www\.)[^\s)>\]]*[^\s)>\].,;:!?]/gi, ' ')
    .replace(/\[(?:\d{1,3}(?:\s*[,-]\s*\d{1,3})*|citation needed)\]/gi, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*+]|\d{1,2}[.)])\s+/gm, '')
    .replace(/^\s*(?:Source|Sources|Coverage|Data refreshed):.*$/gim, ' ')
    .replace(/\*\*|__|~~/g, '')
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,;:!?]|$)/g, '$1$2')
    .replace(/[|]{1,}/g, ', ')
    .replace(/={2,}|-{3,}|_{3,}|\*{3,}/g, ' ');
}

function normalizeNumbers(text) {
  const scaleWord = '(thousand|million|billion|trillion)';
  return String(text || '')
    // $3.5 billion -> three point five billion dollars
    .replace(new RegExp(`\\$\\s?(\\d[\\d,]*(?:\\.\\d+)?)\\s?${scaleWord}\\b`, 'gi'),
      (_, num, scale) => `${decimalToWords(num)} ${scale.toLowerCase()} dollars`)
    // $1,200.50 -> one thousand two hundred dollars and fifty cents
    .replace(/\$\s?(\d[\d,]*)\.(\d{2})\b/g, (_, whole, cents) => {
      const c = Number(cents);
      const w = `${integerToWords(Number(whole.replace(/,/g, '')))} dollars`;
      return c ? `${w} and ${integerToWords(c)} cents` : w;
    })
    .replace(/\$\s?(\d[\d,]*)\b/g, (_, whole) => {
      const n = Number(whole.replace(/,/g, ''));
      return `${integerToWords(n)} ${n === 1 ? 'dollar' : 'dollars'}`;
    })
    // 25% / 3.5 percent
    .replace(/(\d[\d,]*(?:\.\d+)?)\s?%/g, (_, num) => `${decimalToWords(num)} percent`)
    // clock times: 8:30 -> eight thirty, 9:05 -> nine oh five, 7:00 -> seven
    .replace(/\b(\d{1,2}):(\d{2})\b/g, (_, h, m) => {
      const mm = Number(m);
      const hh = integerToWords(Number(h));
      if (!mm) return hh;
      return `${hh} ${mm < 10 ? `oh ${ONES[mm]}` : underHundred(mm)}`;
    })
    // ordinals: 1st, 22nd, 103rd, 4th
    .replace(/\b(\d{1,4})(st|nd|rd|th)\b/gi, (_, num) => ordinalToWords(Number(num)))
    // years: 1900-2099 standing alone (not part of a larger number or decimal)
    .replace(/(^|[^\d.,$])((?:19|20)\d{2})(?![\d,]|\.\d)/g, (_, pre, year) => `${pre}${yearToWords(year)}`)
    // decimals and grouped integers: 600,000 / 3.5 / 1200
    .replace(/(^|[^\d.])(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+\.\d+|\d+)(?![\d])/g,
      (_, pre, num) => `${pre}${decimalToWords(num)}`);
}

function normalizeForSpeech(text) {
  const out = normalizeNumbers(stripMarkup(text))
    .replace(/&/g, ' and ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/,\s*,/g, ',');
  return out.trim();
}

module.exports = {
  normalizeForSpeech,
  stripMarkup,
  normalizeNumbers,
  integerToWords,
  decimalToWords,
  yearToWords,
  ordinalToWords,
};
