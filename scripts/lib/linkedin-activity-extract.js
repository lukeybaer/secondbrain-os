'use strict';

// LinkedIn recent-activity post extraction (2026-10-09 zero-capture repair).
//
// The bulk scanner matched only `div.feed-shared-update-v2`. On the Oct 7 and
// Oct 9 EC2 scans every one of 89 authenticated activity pages returned zero
// posts with no auth wall, so the canonical intel was never published. LinkedIn
// now renders some activity feeds without that legacy class, while the
// activity URN attributes remain. The extractor accepts every known post
// container, keeps only the outermost match, and reads the URN from data-urn,
// data-id, or an activity link.
//
// extractActivityPosts runs inside the browser through page.evaluate, so it
// must stay self-contained: no closures over module scope.

const ACTIVITY_POST_SELECTORS = Object.freeze([
  'div.feed-shared-update-v2',
  '[data-urn^="urn:li:activity:"]',
  '[data-urn^="urn:li:share:"]',
  '[data-urn^="urn:li:ugcPost:"]',
  '[data-id^="urn:li:activity:"]',
  '[data-id^="urn:li:share:"]',
  '[data-id^="urn:li:ugcPost:"]',
  'li.profile-creator-shared-feed-update__container',
  '[data-view-name="feed-full-update"]',
  '[componentkey*="urn:li:activity:"]',
  '[componentkey*="urn:li:share:"]',
  '[componentkey*="urn:li:ugcPost:"]',
]);

// A post permalink. LinkedIn's newer activity DOM can render posts with hashed
// class names and no URN attribute on the container; the permalink anchor is
// then the only stable marker (2026-10-10).
const ACTIVITY_POST_LINK_SELECTOR =
  'a[href*="urn:li:activity:"], a[href*="urn:li:share:"], a[href*="urn:li:ugcPost:"]';

function extractActivityPosts({ selectors, linkSelector, limit } = {}) {
  const max = Number(limit) > 0 ? Number(limit) : 6;
  const seen = new Set();
  const matched = [];
  for (const selector of selectors || []) {
    let nodes = [];
    try {
      nodes = Array.from(document.querySelectorAll(selector));
    } catch {
      nodes = [];
    }
    for (const node of nodes) {
      if (seen.has(node)) continue;
      seen.add(node);
      matched.push(node);
    }
  }
  // A post container often nests another matching element; keep the outermost.
  const outer = matched.filter(
    (node) => !matched.some((other) => other !== node && other.contains && other.contains(node)),
  );
  const urnPattern = /urn:li:(?:activity|share|ugcPost):\d+/;
  const urnOf = (node) => {
    let host = node;
    while (host) {
      for (const attr of ['data-urn', 'data-id', 'componentkey']) {
        const value = host.getAttribute ? String(host.getAttribute(attr) || '') : '';
        const hit = value.match(urnPattern);
        if (hit) return hit[0];
      }
      host = host.parentElement || null;
    }
    const links = node.querySelectorAll ? Array.from(node.querySelectorAll('a[href]')) : [];
    for (const link of links) {
      const hit = String(link.getAttribute('href') || '').match(urnPattern);
      if (hit) return hit[0];
    }
    return '';
  };
  // Link-anchored fallback: when no container selector matched, climb from
  // each permalink to the largest ancestor that holds no other post's URN.
  if (outer.length === 0 && linkSelector) {
    let anchors = [];
    try {
      anchors = Array.from(document.querySelectorAll(linkSelector));
    } catch {
      anchors = [];
    }
    const hrefUrn = (link) => {
      const href = link.getAttribute ? String(link.getAttribute('href') || '') : '';
      const hit = href.match(urnPattern);
      return hit ? hit[0] : '';
    };
    const claimed = new Set();
    for (const anchor of anchors) {
      const own = hrefUrn(anchor);
      if (!own || claimed.has(own)) continue;
      let container = anchor;
      for (let depth = 0; depth < 15; depth += 1) {
        const parent = container.parentElement;
        if (!parent || !parent.querySelectorAll) break;
        const foreign = Array.from(parent.querySelectorAll('a[href]')).some((link) => {
          const urn = hrefUrn(link);
          return urn && urn !== own;
        });
        if (foreign) break;
        container = parent;
      }
      claimed.add(own);
      outer.push(container);
    }
  }
  const posts = [];
  const urns = new Set();
  for (const node of outer) {
    const text = String(node.innerText || node.textContent || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 600);
    if (!text) continue;
    const urn = urnOf(node);
    if (urn && urns.has(urn)) continue;
    if (urn) urns.add(urn);
    const ageMatch = text.match(/(\d+)\s*(mo|w|d|h|yr)\s*•/);
    posts.push({ age: ageMatch ? ageMatch[0] : '?', text, urn });
    if (posts.length >= max) break;
  }
  return posts;
}

// Bounded page evidence for a zero-post activity page (2026-10-10). The Oct 10
// scan still captured zero posts from 89 contacts after the selector repair,
// with no redirect to /login or /authwall, and nothing recorded what each page
// actually rendered. This probe runs inside the browser through page.evaluate
// and must stay self-contained.
function probeActivityPage() {
  const html = String((document.documentElement && document.documentElement.outerHTML) || '');
  const bodyText = String((document.body && document.body.innerText) || '');
  const count = (re) => (html.match(re) || []).length;
  return {
    url: String(location.href || '').slice(0, 300),
    title: String(document.title || '').slice(0, 200),
    htmlBytes: html.length,
    bodyTextBytes: bodyText.length,
    activityUrnMentions: count(/urn:li:(?:activity|share|ugcPost):\d+/g),
    signInForm: Boolean(
      document.querySelector('form[action*="login"], input[name="session_key"], .authwall-join-form'),
    ),
    bodyHead: bodyText.replace(/\s+/g, ' ').trim().slice(0, 240),
  };
}

// A page with a sign-in form, or a guest join/sign-in title, is a login wall
// even when LinkedIn did not redirect the URL.
function isInPageLoginWall(probe) {
  if (!probe || typeof probe !== 'object') return false;
  if (probe.signInForm) return true;
  return /sign in|join linkedin|sign up/i.test(String(probe.title || ''));
}

// Post age from the activity URN (2026-10-29). LinkedIn now renders the age
// label as "1w Follow" or "4w Connect" with no "•", so the in-page label regex
// returns "?" and the scanner dropped those posts as not recent: the Oct 29
// crawl logged "6 posts captured, 0 recent" for PRIVATE_NAME while his
// newest post (URN-dated Oct 22) was 7 days old. The URN's top bits are the
// creation time in ms, exact where the label is coarse ("1mo" spans 30-59
// days), so it wins; the label is the fallback for a post with no URN.
const URN_ID_PATTERN = /urn:li:(?:activity|share|ugcPost):(\d{15,})/;
const LABEL_DAYS = { h: 1 / 24, d: 1, w: 7, mo: 30, yr: 365 };

function urnPostedAtMs(urn) {
  const m = String(urn || '').match(URN_ID_PATTERN);
  if (!m) return 0;
  try {
    const ms = Number(BigInt(m[1]) >> 22n);
    return ms > Date.UTC(2010, 0, 1) ? ms : 0;
  } catch {
    return 0;
  }
}

function labelAge(post) {
  const label = String((post && post.age) || '');
  const text = String((post && post.text) || '');
  const m =
    label.match(/(\d+)\s*(mo|w|d|h|yr)\b/) ||
    text.match(/\b(\d+)\s*(mo|w|d|h|yr)\s+(?:•|Follow|Connect|Edited)/);
  return m ? { days: Number(m[1]) * LABEL_DAYS[m[2]], age: `${m[1]}${m[2]}` } : null;
}

// The scanner's recency gate: posts no older than maxDays, each with `age`
// rewritten to an exact "<n>h"/"<n>d" label and `postedAt` when the URN dates
// it, or to the visible "<n><unit>" label otherwise, so the later intel event
// filter (isRecentAge) never sees "?" for a kept post (Codex 0e36c0edceba).
function recentActivityPosts(posts, maxDays = 30, nowMs = Date.now()) {
  const out = [];
  for (const post of posts || []) {
    const postedMs = urnPostedAtMs(post && post.urn);
    let days = null;
    let next = post;
    if (postedMs) {
      days = Math.max(0, (nowMs - postedMs) / 86400000);
      const age = days < 1 ? `${Math.floor(days * 24)}h` : `${Math.floor(days)}d`;
      next = { ...post, age, postedAt: new Date(postedMs).toISOString() };
    } else {
      const label = labelAge(post);
      if (label) {
        days = label.days;
        next = { ...post, age: label.age };
      }
    }
    if (days !== null && days <= maxDays) out.push(next);
  }
  return out;
}

// Classify a post's recency from its age label ("6d", "2w", "1mo").
function isRecentAge(ageStr, maxDays = 30) {
  if (!ageStr || ageStr === '?') return false;
  const m = String(ageStr).match(/(\d+)\s*(mo|w|d|h|yr)/);
  if (!m) return false;
  return Number(m[1]) * (LABEL_DAYS[m[2]] || 99999) <= maxDays;
}

// A LinkedIn activity URN becomes the canonical post link. Anything that is
// not an exact activity, share, or ugcPost URN yields no link rather than a
// guessed one.
function linkedInPostUrl(urn) {
  const value = String(urn || '').trim();
  return /^urn:li:(?:activity|share|ugcPost):\d+$/.test(value)
    ? `https://www.linkedin.com/feed/update/${value}/`
    : '';
}

// The serialized intel events for every scanned contact with recent posts.
// Moved out of linkedin-bulk-scan.js unchanged so the scanner's last recency
// filter is tested end to end with recentActivityPosts.
const HEADLINE_SEP = ` ${String.fromCharCode(0x2014)} `; // unchanged scanner headline format
function intelEventsFromResults(results, { detectedAt = new Date().toISOString(), maxDays = 30 } = {}) {
  const events = [];
  for (const r of results || []) {
    for (const p of (r.recentPosts || []).filter((pp) => isRecentAge(pp.age, maxDays))) {
      events.push({
        id: `${r.contact.file.replace('.md', '')}-${p.age.replace(/\s/g, '')}`,
        contactName: r.contact.name,
        eventType: /starting a new position|joined|excited to share that i.?.?ve joined/i.test(p.text)
          ? 'job_change'
          : 'engagement',
        headline: `${r.contact.name}${HEADLINE_SEP}${p.text.slice(0, 120)}`,
        detail: `${p.age} ago. ${p.text.slice(0, 320)}`,
        // Network news fields (The owner): the full captured text, the
        // exact post link when LinkedIn exposed its activity URN, and the
        // People-file identity, so the card never guesses a link or a person.
        text: p.text,
        postUrl: linkedInPostUrl(p.urn),
        profileUrl: r.contact.url,
        contactFile: r.contact.file,
        source: 'linkedin_bulk_scan',
        detectedAt,
        reportedAt: null,
      });
    }
  }
  return events;
}

module.exports = {
  ACTIVITY_POST_SELECTORS,
  ACTIVITY_POST_LINK_SELECTOR,
  extractActivityPosts,
  recentActivityPosts,
  isRecentAge,
  linkedInPostUrl,
  intelEventsFromResults,
  urnPostedAtMs,
  probeActivityPage,
  isInPageLoginWall,
};
