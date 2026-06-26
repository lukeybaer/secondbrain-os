#!/usr/bin/env node
// Fetch the LIVE briefing dashboard and report the blocker count + each blocker
// title, so the heal loop can verify "clean = the dashboard shows zero blockers"
// without eyeballing. Ground truth is the rendered page, not the local validator.
// Usage: node scripts/check-live-blockers.mjs [YYYY-MM-DD]
import { buildBriefingDashboardUrl } from './lib/briefing-auth.js';
const date = process.argv[2] || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
const url = buildBriefingDashboardUrl(
  `http://ExampleCo:3001/briefing?date=${date}&_cb=${Date.now()}`,
  process.env.SB_BRIEFING_TOKEN
);

const res = await fetch(url, { headers: { 'Cache-Control': 'no-cache' } }).catch((e) => ({ _err: e.message }));
if (res._err || !res.ok) {
  console.log(JSON.stringify({ ok: false, error: res._err || `http ${res.status}` }));
  process.exit(2);
}
const html = await res.text();

// The BLOCKERS card headline is a big number followed by "hard blockers before
// the briefing is clean". Pull it out, plus each card name the page flags.
const flat = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
let count = null;
const m = flat.match(/(\d+)\s+hard blockers? before the briefing is clean/i);
if (m) count = Number(m[1]);
else if (/No hard blockers|hard blockers? .{0,8}\b0\b/i.test(flat)) count = 0;
// Fake-blocker phrases that must never appear on a clean page.
const fakePhrases = ['not a ExampleCo decision', 'overnight heal window closed', 'owning card must repair', 'self-heal Amy owns', 'is incomplete', 'Known blocker'];
const present = fakePhrases.filter((p) => html.includes(p));
// Single-encoded &#x27;/&quot; render correctly as '/" in the browser -- NOT a
// defect. Only DOUBLE-encoded entities (&amp;quot;) display as literal garbage.
const brokenEntities = (html.match(/&amp;(quot|#x27|#39|apos|amp);/g) || []).length;

console.log(JSON.stringify({
  ok: count === 0 && present.length === 0,
  date,
  blockerCount: count,
  fakeBlockerPhrasesPresent: present,
  doubleEncodedEntities: brokenEntities,
}, null, 2));
process.exit(count === 0 && present.length === 0 ? 0 : 1);
