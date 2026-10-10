'use strict';

function sourceFamily(value) {
  const source = String(value || '')
    .trim()
    .replace(
      /\s*[-\u2013\u2014]\s*(?:\d{4}-\d{2}-\d{2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:,\s*\d{4})?)\s*$/i,
      '',
    )
    // Google News relay titles end "- Thu, 24 Se" (weekday, day, clipped
    // month). Left in place, every date became its own "publisher" and the
    // card listed Eurasia Review three times (ExampleCo, 2026-09-26).
    .replace(/\s*[^\w\s]\s*(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,?\s+\d{1,2}(?:\s+[A-Za-z]{0,9}\.?)?(?:\s+\d{4})?\s*$/i, '')
    .replace(/^www\./i, '')
    .trim();
  // Google News is transport, never the publisher. If an old rendered row
  // still carries a Google News feed label, omit it from the denominator and
  // let missingCoverage fail the card instead of inventing a relay bucket.
  if (!source || /\bgoogle news\b/i.test(source)) return '';
  if (/\bnpr\b/i.test(source)) return 'NPR';
  if (/\bcbs\b/i.test(source)) return 'CBS';
  if (/\bfox news\b|\bfoxnews\b/i.test(source)) return 'Fox News';
  if (/\bbreitbart\b/i.test(source)) return 'Breitbart';
  if (/\bassociated press\b|\bap(?: news)?\b/i.test(source)) return 'Associated Press';
  if (/\breuters\b/i.test(source)) return 'Reuters';
  if (/\bbbc\b/i.test(source)) return 'BBC';
  if (/\bguardian\b/i.test(source)) return 'The Guardian';
  if (/\btechcrunch\b/i.test(source)) return 'TechCrunch';
  if (/\bars technica\b/i.test(source)) return 'Ars Technica';
  return source.replace(/\s+(?:via Google|News|US|World|Politics)$/i, '').trim();
}

function isRightOfCenter(row) {
  return /\bfox news\b|\bfoxnews\b|\bbreitbart\b|\bdaily wire\b|\bwashington examiner\b|\bnational review\b|\bepoch times\b|\bnew york post\b|\bnypost\b|\bwall street journal\b|\bwsj\b/i.test(
    String(row?.source || ''),
  );
}

function isBreitbart(row) {
  return /\bbreitbart\b/i.test(String(row?.source || ''));
}

function conservativePriority(row) {
  const source = String(row?.source || '');
  if (/\bbreitbart\b/i.test(source)) return 0;
  if (/\bfox news\b|\bfoxnews\b/i.test(source)) return 1;
  if (/\bnew york post\b|\bnypost\b/i.test(source)) return 2;
  return 3;
}

const POLITICAL_BALANCE_CARDS = new Set(['us', 'aitech', 'policy', 'finance', 'science']);

function isLikelyUsWireStory(row) {
  const family = sourceFamily(row?.source);
  if (!['Associated Press', 'Reuters'].includes(family)) return true;
  const text = `${String(row?.title || '')} ${String(row?.excerpt || '')}`;
  return /\b(?:U\.?S\.?|United States|American|America|White House|Congress|Senate|House|Trump|Republican|Democrat|ICE|DHS|Mississippi|California|Washington)\b/i.test(
    text,
  );
}

function financeTopicalRank(row) {
  const text = [row?.title, row?.source, row?.excerpt, row?.url]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  let score = 0;
  if (
    /\b(trade press|industry insider|regulatory filing)\b/.test(
      text,
    )
  ) {
    score -= 4;
  }
  if (
    /\b(trade publication)\b/.test(
      text,
    )
  ) {
    score -= 2;
  }
  if (
    /\b(finance|refinance|refi) (?:interest )?rates? (?:today|forecast|prediction)/.test(text) ||
    /\bcurrent (?:finance|refinance|refi) (?:interest )?rates?(?: report)?\b/.test(text) ||
    /\b(?:today|current|july \d{1,2}, 20\d{2}).{0,80}\b(?:30-year|15-year|basis points?)\b/.test(
      text,
    )
  ) {
    score += 6;
  }
  return score;
}

function selectBalancedNewsRows(rows, target, { cardKey = '' } = {}) {
  const input = Array.isArray(rows) ? rows : [];
  const limit = Math.max(0, Number(target || 0));
  // Google wire-service searches sometimes return foreign-only stories even
  // when the query says "US news". Keep those relays out of the US card while
  // leaving native US feeds untouched.
  const eligible = cardKey === 'us' ? input.filter(isLikelyUsWireStory) : input;
  const selected = [];
  const used = new Set();
  const counts = new Map();
  const add = (row, index) => {
    if (used.has(index) || selected.length >= limit) return false;
    const family = sourceFamily(row?.source);
    if ((counts.get(family) || 0) >= 3) return false;
    selected.push(row);
    used.add(index);
    counts.set(family, (counts.get(family) || 0) + 1);
    return true;
  };
  // World News remains outside the domestic political-balance quota. Every
  // other news pool applies it only after topical, freshness, and summary-
  // quality admission. Inside that qualified pool, ExampleCo asked to consider
  // Breitbart first, so publisher priority intentionally precedes input rank.
  if (POLITICAL_BALANCE_CARDS.has(cardKey)) {
    const conservativeTarget = Math.min(limit, Math.ceil(limit * 0.6));
    eligible
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => isRightOfCenter(row))
      .sort(
        (a, b) => conservativePriority(a.row) - conservativePriority(b.row) || a.index - b.index,
      )
      .forEach(({ row, index }) => {
        if (selected.filter(isRightOfCenter).length < conservativeTarget) add(row, index);
      });
  }
  eligible.forEach((row, index) => add(row, index));
  // If the available pool cannot meet the family cap, fill honestly rather
  // than publishing a short card. The Pareto card exposes the residual skew.
  eligible.forEach((row, index) => {
    if (!used.has(index) && selected.length < limit) {
      selected.push(row);
      used.add(index);
    }
  });
  if (cardKey === 'finance') {
    const originalIndex = new Map(eligible.map((row, index) => [row, index]));
    selected.sort(
      (a, b) =>
        financeTopicalRank(a) - financeTopicalRank(b) ||
        (originalIndex.get(a) || 0) - (originalIndex.get(b) || 0),
    );
  }
  return selected;
}

function markdownSourceFamilies(markdown) {
  const lines = String(markdown || '').split(/\r?\n/);
  const families = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^\s*\d+\.\s+/.test(lines[i])) continue;
    let source = '';
    for (let j = i + 1; j < Math.min(lines.length, i + 5); j += 1) {
      if (/^\s*\d+\.\s+/.test(lines[j])) break;
      const current = String(lines[j] || '').trim();
      const next = String(lines[j + 1] || '').trim();
      // Some live rows have no display date on the publisher line, especially
      // SCIENCE rows sourced through Google News. In that shape the publisher is
      // a plain line immediately followed by `Source: https://...`. The URL
      // adjacency distinguishes it from summary prose without guessing.
      if (
        current &&
        !/^https?:\/\//i.test(current) &&
        !/^Source:/i.test(current) &&
        /^(?:Source:\s*)?https?:\/\//i.test(next)
      ) {
        source = current;
        break;
      }
      // Current cloud cards render publisher, byline, and date with middle
      // dots, for example "TechCrunch AI Â· Anthony Ha Â· Sat, 08 Aug 2026".
      // The original Pareto reader knew only the older dash/date and
      // "Source: outlet | URL" shapes, so it reported zero sources while the
      // same briefing visibly contained dozens of articles.
      const middleDotParts = String(lines[j] || '')
        .replace(/Â·/g, '·')
        .split('·')
        .map((part) => part.trim())
        .filter(Boolean);
      if (middleDotParts.length >= 2) source = middleDotParts[0];
      const explicit = lines[j].match(
        /^\s*([^|]+?)\s+-\s+(?:\d{4}-\d{2}-\d{2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:,\s*\d{4})?)\s*$/i,
      );
      if (explicit) source = explicit[1].trim();
      const sourceLine = lines[j].match(/^\s*Source:\s*(?:([^|]+?)\s*\|\s*)?https?:/i);
      if (sourceLine && sourceLine[1]) source = sourceLine[1].trim();
    }
    if (source) {
      const family = sourceFamily(source);
      if (family) families.push(family);
    }
  }
  return families;
}

function declaredNewsCount(markdown) {
  const text = String(markdown || '');
  const heading = text.match(/^\s*[A-Z0-9 &/+'’-]+NEWS[^\n]*?\((\d+)\)\s*:/im);
  if (heading) return Number(heading[1]);
  const rowNumbers = [...text.matchAll(/^\s*(\d+)\.\s+/gm)].map((match) => Number(match[1]));
  return rowNumbers.length ? Math.max(...rowNumbers) : 0;
}

// ExampleCo, 2026-08-16: "this one was supposed to be how many articles you sourced
// from that network, and how many you ultimately used."
//
// The card previously counted rendered rows only, so every publisher looked
// perfectly efficient and the card could not answer the question it exists for:
// which feeds earn their place and which are dead weight. On the day he asked,
// 161 articles were collected and 37 rendered, x.com supplied 28 of the 161 and
// none were used, and Associated Press supplied 12 for one used. None of that
// was visible.
//
// sourcedCounts is a publisher -> collected-count map from the day's collection
// receipt. When it is absent the card says so and reports used only; it never
// invents a sourced number.
function buildNewsSourceParetoCard({ date, newsCards = [], sourcedCounts = null } = {}) {
  const families = newsCards.flatMap((card) => markdownSourceFamilies(card?.markdown));
  const declared = newsCards.reduce((sum, card) => sum + declaredNewsCount(card?.markdown), 0);
  const counts = new Map();
  families.forEach((family) => counts.set(family, (counts.get(family) || 0) + 1));
  const total = families.length;

  // The collection receipt keys publishers by feed label or domain
  // ("breitbart.com") while rendered rows use the display name ("Breitbart").
  // Unjoined keys produced "14 used of 0 pulled in" beside "breitbart.com
  // supplied 19 and none were used" (ExampleCo, 2026-09-26). Both sides now go
  // through the same family normalizer.
  let sourced = null;
  if (sourcedCounts && typeof sourcedCounts === 'object') {
    sourced = {};
    for (const [name, n] of Object.entries(sourcedCounts)) {
      const family = sourceFamily(name);
      if (!family) continue;
      sourced[family] = (sourced[family] || 0) + (Number(n) || 0);
    }
  }
  const sourcedTotal = sourced
    ? Object.values(sourced).reduce((sum, n) => sum + (Number(n) || 0), 0)
    : null;

  // Rank over the union, so a publisher that supplied articles and had none
  // used still appears. Zero-used is the finding, not an absence.
  const publishers = new Set([...counts.keys(), ...(sourced ? Object.keys(sourced) : [])]);
  const ranked = [...publishers]
    .map((name) => ({
      family: name,
      used: counts.get(name) || 0,
      sourced: sourced ? Number(sourced[name]) || 0 : null,
    }))
    .sort(
      (a, b) =>
        (b.sourced ?? b.used) - (a.sourced ?? a.used) ||
        b.used - a.used ||
        a.family.localeCompare(b.family),
    );

  // A used count above sourced means the two sides came from inconsistent runs,
  // which makes every ratio on the card meaningless.
  const inconsistentPublishers = sourced
    ? ranked.filter((r) => r.used > r.sourced).map((r) => r.family)
    : [];
  const unusedPublishers = sourced
    ? ranked.filter((r) => r.sourced > 0 && r.used === 0).map((r) => r.family)
    : [];
  const largestUnused = sourced
    ? ranked
        .filter((r) => r.sourced > 0 && r.used === 0)
        .map((r) => ({ publisher: r.family, sourced: r.sourced }))[0] || null
    : null;

  const lines = [
    `As of: ${String(date || '').slice(0, 10) || 'unknown'}.`,
    'Source classification: right-of-center-v2 effective 2026-08-13; this version adds Breitbart, Daily Wire, Washington Examiner, National Review, Epoch Times, New York Post, and Wall Street Journal to the prior Fox News class.',
    // The Coverage line is load-bearing for the live QC parser: it reads the
    // rendered total and the family count from this exact shape, and it counts
    // only families that actually rendered. The pulled-in figure is a separate
    // sentence so the parser contract is untouched.
    `Coverage: ${total} rendered articles across ${ranked.filter((r) => r.used > 0).length} outlet families.`,
    sourced
      ? `Supply: ${sourcedTotal} articles were pulled in from ${ranked.length} publishers to produce those ${total}.`
      : 'Supply: no collection receipt exists for this date, so how many articles were pulled in is unavailable and only used counts are shown.',
  ];
  if (largestUnused) {
    lines.push(
      `Biggest waste: ${largestUnused.publisher} supplied ${largestUnused.sourced} article${largestUnused.sourced === 1 ? '' : 's'} and none were used.`,
    );
  }
  // ExampleCo, 2026-09-25: "Why are you listing sources from which you got zero
  // articles? You don't have to show where you got 0 articles from." Only
  // publishers that supplied a rendered article are listed; the Biggest waste
  // line above still names the largest unused supplier.
  ranked.filter((row) => row.used > 0).forEach((row, index) => {
    const pct = total ? ((row.used / total) * 100).toFixed(1) : '0.0';
    // The leading `N. Family: used (pct%)` shape is load-bearing: the live QC
    // parser and the dashboard tile both read it. The pulled-in figure is
    // APPENDED rather than folded in, so the card gains ExampleCo's second number
    // without breaking the surface that renders it.
    lines.push(
      row.sourced === null
        ? `${index + 1}. ${row.family}: ${row.used} (${pct}%)`
        : row.sourced < row.used
          ? // Never print a denominator below the used count ("14 of 0").
            // The row keeps the parser's `N. Family: used (pct%)` shape and
            // the Note line below names these publishers.
            `${index + 1}. ${row.family}: ${row.used} (${pct}%)`
          : `${index + 1}. ${row.family}: ${row.used} (${pct}%) of ${row.sourced} pulled in`,
    );
  });
  if (!ranked.length) lines.push('No rendered news rows were available to count.');
  if (inconsistentPublishers.length) {
    // A note, not a card failure. A publisher can render an article that is not
    // in today collection receipt because the row came from a cached summary or
    // an earlier candidate pool, which is normal. Failing the whole card for it
    // turns a green card red for a benign cause, which is the exact false-red
    // class ExampleCo has repeatedly rejected. Observed live 2026-08-16: one
    // publisher, ABC, out of 38.
    lines.push(
      `Note: ${inconsistentPublishers.join(', ')} rendered more articles than today collection receipt lists, so those rows came from a cached summary rather than today fetch.`,
    );
  }
  const missingCoverage = Math.max(0, declared - total);
  if (missingCoverage) {
    lines.push(
      `DEFECT: ${missingCoverage} rendered news row${missingCoverage === 1 ? '' : 's'} ${missingCoverage === 1 ? 'is' : 'are'} missing outlet-family coverage; the Pareto is incomplete.`,
    );
  }
  lines.push('Source: rendered briefing news cards for this date.');
  return {
    markdown: `NEWS SOURCE PARETO:\n${lines.join('\n')}`,
    state: {
      id: 'news_source_pareto',
      count: total,
      sourcedTotal,
      unusedPublishers,
      largestUnused,
      inconsistentPublishers,
      declared,
      missingCoverage,
      ok: total > 0 && missingCoverage === 0,
      source: sourced ? 'collection-receipt-and-rendered-news-cards' : 'rendered-news-cards',
      sourceClassificationVersion: 'right-of-center-v2',
      sourceClassificationEffectiveDate: '2026-08-13',
    },
  };
}

module.exports = {
  POLITICAL_BALANCE_CARDS,
  sourceFamily,
  isRightOfCenter,
  isBreitbart,
  conservativePriority,
  isLikelyUsWireStory,
  selectBalancedNewsRows,
  markdownSourceFamilies,
  declaredNewsCount,
  buildNewsSourceParetoCard,
};
