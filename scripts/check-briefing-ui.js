'use strict';
/**
 * Render the live briefing dashboard in a real browser and read it the way ExampleCo
 * does: full-page screenshot + per-card extracted text + quality flags. This is
 * the source of truth for "clean", not the markdown. A card is NOT clean if it
 * shows a blocker, 0/empty/$0/?, "dropped", "failed", "stale", "missing", or
 * "unavailable".
 *
 * Usage: node scripts/check-briefing-ui.js [url] [screenshotPath]
 */
const { chromium } = require('playwright');
const os = require('os');
const path = require('path');

const { buildBriefingDashboardUrl } = require('./lib/briefing-auth.js');
const URL = buildBriefingDashboardUrl(
  process.argv[2] || 'http://ExampleCo:3001/briefing',
  process.env.SB_BRIEFING_TOKEN,
);
const SHOT =
  process.argv[3] ||
  process.env.BRIEFING_UI_SCREENSHOT ||
  path.join(os.tmpdir(), 'briefing-ui-check.png');

const PROBLEM =
  /known blocker|hard blocker|dropped|unreadable|unavailable|\bfailed\b|\bstale\b|\bmissing\b|not started|no heartbeat|ran short|system health (red|yellow)|scan failed|do not trust|\?$|^\s*0\s|\$0\b/i;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
  await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(2500);
  await page.screenshot({ path: SHOT, fullPage: true });

  // Header / overall.
  const header = await page.evaluate(() =>
    (document.querySelector('header, h1') || document.body).innerText
      .split('\n')
      .slice(0, 3)
      .join(' | '),
  );

  // Extract each card. Cards are tiles with a heading; grab heading + body text.
  const cards = await page.evaluate(() => {
    const out = [];
    // Heuristic: a "card" is a block that contains an uppercase heading near its top.
    const blocks = Array.from(document.querySelectorAll('section, article, div')).filter((el) => {
      const t = (el.innerText || '').trim();
      if (!t || t.length < 8 || t.length > 1400) return false;
      const first = t.split('\n')[0] || '';
      // Heading-ish: mostly uppercase or ends with NEWS/HEALTH/ITEMS/etc.
      return (
        /[A-Z]{3,}/.test(first) &&
        (el.querySelector('h1,h2,h3,h4,[class*=title],[class*=head]') ||
          /^[A-Z0-9 ,&'()/.\-]+$/.test(first))
      );
    });
    // Dedup nested: keep the smallest block per heading.
    const seen = new Map();
    for (const el of blocks) {
      const t = (el.innerText || '').trim();
      const head = t.split('\n')[0].slice(0, 60);
      if (!seen.has(head) || t.length < seen.get(head).len)
        seen.set(head, { text: t, len: t.length });
    }
    for (const [head, v] of seen) out.push({ head, text: v.text.slice(0, 400) });
    return out;
  });

  await browser.close();

  const flagged = [];
  const clean = [];
  for (const c of cards) {
    const bad = c.text
      .split('\n')
      .filter((l) => PROBLEM.test(l))
      .slice(0, 3);
    if (bad.length) flagged.push({ head: c.head, problems: bad });
    else clean.push(c.head);
  }

  const report = {
    url: URL,
    header,
    screenshot: SHOT,
    totalCards: cards.length,
    flaggedCount: flagged.length,
    flagged,
    cleanCards: clean,
  };
  process.stdout.write(JSON.stringify(report, null, 2));
})().catch((e) => {
  process.stdout.write(JSON.stringify({ error: String((e && e.message) || e) }));
  process.exit(1);
});
