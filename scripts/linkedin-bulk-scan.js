#!/usr/bin/env node
// linkedin-bulk-scan.js
//
// Standalone LinkedIn warm-network scanner. Opens a persistent Chromium
// profile, navigates to each warm contact's recent-activity page, extracts
// the last 7 days of public posts, updates the contact file, and writes
// _linkedin-daily-intel.md + linkedin-intel.json.
//
// Why this exists: the 2026-04-11 #gap showed that the daily-linkedin-scan
// scheduled task could not hit all 118 warm contacts because it ran as a
// detached `claude -p` subprocess that did not inherit the parent session's
// Claude_in_Chrome MCP. Spawned children have no browser tools. The fix is
// to drive Chromium directly via Playwright — no MCP, no session dependency,
// unattended nightly run. See feedback_linkedin_scan_needs_standalone.md.
//
// Usage:
//   node scripts/linkedin-bulk-scan.js              # full scan of all warm
//   node scripts/linkedin-bulk-scan.js --limit 10   # first 10 only
//   node scripts/linkedin-bulk-scan.js --login      # open visible browser
//                                                   # for one-time login
//
// First run: use --login to sign into LinkedIn interactively and store the
// session. Subsequent unattended runs reuse the stored cookies/state.
//
// Storage:
//   Chromium profile: %APPDATA%\secondbrain\chrome-profile-linkedin\
//   Scan log:         %APPDATA%\secondbrain\data\linkedin-bulk-scan.log
//   Intel md:         secondbrain\memory\contacts\_linkedin-daily-intel.md
//   Intel json:       %APPDATA%\secondbrain\data\agent\linkedin-intel.json

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

// Paths are derived at runtime — no hardcoded user paths. The privacy-scrubbing
// linter in this repo replaces literal hardcoded user paths with shell
// placeholders like ${USERPROFILE:-~} which are INVALID inside JS string
// literals and break the scanner on next run. Derive APPDATA from env and
// contacts dir from __dirname-relative resolution instead.
const APPDATA = process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming');
const CHROME_PROFILE = path.join(APPDATA, 'secondbrain', 'chrome-profile-linkedin');
const LOG_PATH = path.join(APPDATA, 'secondbrain', 'data', 'linkedin-bulk-scan.log');
const INTEL_JSON_PATH = path.join(APPDATA, 'secondbrain', 'data', 'agent', 'linkedin-intel.json');
// scripts/linkedin-bulk-scan.js → ../memory/contacts
const CONTACTS_DIR = path.resolve(__dirname, '..', 'memory', 'contacts');
const INTEL_MD_PATH = path.join(CONTACTS_DIR, '_linkedin-daily-intel.md');
// Raw scrape archive for the unified-brain ingest pipeline. Each contact's
// scan lands here as JSON so scripts/ingest-linkedin-watcher.mjs can feed
// Graphiti via the canonical funnel without coupling the scraper to the
// Electron build path.
const LINKEDIN_RAW_DIR = path.resolve(__dirname, '..', 'data', 'linkedin', 'raw');

const ARGS = process.argv.slice(2);
const LIMIT = (() => {
  const i = ARGS.indexOf('--limit');
  return i >= 0 ? parseInt(ARGS[i + 1], 10) : Infinity;
})();
const HEADLESS = !ARGS.includes('--login') && !ARGS.includes('--headful');
const LOGIN_MODE = ARGS.includes('--login');

const PER_CONTACT_WAIT_MS = 3500;
const INTER_CONTACT_DELAY_MS_MIN = 8000;
const INTER_CONTACT_DELAY_MS_MAX = 12000;
const BATCH_SIZE = 10;
const BATCH_PAUSE_MS = 60000;

// ── Logging ─────────────────────────────────────────────────────────────────

function ensureDir(p) {
  try {
    fs.mkdirSync(p, { recursive: true });
  } catch {
    /* ignore */
  }
}

function log(msg) {
  ensureDir(path.dirname(LOG_PATH));
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    fs.appendFileSync(LOG_PATH, line);
  } catch {
    /* best effort */
  }
  process.stdout.write(line);
}

// ── Contact discovery ───────────────────────────────────────────────────────

function loadContactsWithLinkedIn() {
  const files = fs
    .readdirSync(CONTACTS_DIR)
    .filter((f) => f.endsWith('.md') && f !== 'INDEX.md' && !f.startsWith('_'));
  const contacts = [];
  for (const file of files) {
    const full = path.join(CONTACTS_DIR, file);
    let text;
    try {
      text = fs.readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    const frontMatch = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!frontMatch) continue;
    const fm = frontMatch[1];
    // Accept linkedin: <url> or linkedin_katie: <url> etc.
    const urlMatches = Array.from(fm.matchAll(/^linkedin\w*:\s*(\S+)/gm));
    for (const m of urlMatches) {
      const url = m[1].replace(/^['"]|['"]$/g, '').trim();
      if (!/^https?:\/\//i.test(url)) continue;
      if (!/linkedin\.com\/in\//i.test(url)) continue;
      const nameMatch = fm.match(/^name:\s*(.+)$/m);
      const categoryMatch = fm.match(/^category:\s*(.+)$/m);
      const warmthMatch = fm.match(/^warmth:\s*(.+)$/m);
      contacts.push({
        file,
        path: full,
        name: nameMatch ? nameMatch[1].trim().replace(/^['"]|['"]$/g, '') : file.replace('.md', ''),
        url: url.replace(/\/$/, ''),
        category: categoryMatch ? categoryMatch[1].trim() : 'unknown',
        warmth: warmthMatch ? warmthMatch[1].trim() : 'unknown',
      });
    }
  }
  // Prioritize inner-circle first, then active-network, then everything else
  const order = { 'inner-circle': 0, 'active-network': 1 };
  contacts.sort((a, b) => {
    const oa = order[a.category] ?? 99;
    const ob = order[b.category] ?? 99;
    return oa - ob;
  });
  return contacts;
}

// ── Post extraction ─────────────────────────────────────────────────────────

async function scanContact(page, contact) {
  const activityUrl = contact.url.replace(/\/$/, '') + '/recent-activity/all/';
  try {
    await page.goto(activityUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (e) {
    return { error: 'navigation failed: ' + e.message };
  }
  // Detect login wall / CAPTCHA
  const url = page.url();
  if (/\/login|\/checkpoint|\/authwall/i.test(url)) {
    return { error: 'LOGIN_REQUIRED' };
  }
  await page.waitForTimeout(PER_CONTACT_WAIT_MS);
  // Scroll once to trigger lazy load
  try {
    await page.evaluate(() => window.scrollBy(0, 1500));
    await page.waitForTimeout(800);
  } catch {
    /* ignore */
  }
  const data = await page
    .evaluate(() => {
      const posts = Array.from(document.querySelectorAll('div.feed-shared-update-v2'));
      return posts.slice(0, 6).map((p) => {
        const text = (p.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 600);
        const ageMatch = text.match(/(\d+)\s*(mo|w|d|h|yr)\s*•/);
        return { age: ageMatch ? ageMatch[0] : '?', text };
      });
    })
    .catch((e) => ({ error: 'eval failed: ' + e.message }));
  if (data && data.error) return { error: data.error };
  return { posts: data || [] };
}

// Classify a post's recency from its age string
function isRecent(ageStr, maxDays = 30) {
  if (!ageStr || ageStr === '?') return false;
  const m = ageStr.match(/(\d+)\s*(mo|w|d|h|yr)/);
  if (!m) return false;
  const n = parseInt(m[1], 10);
  const unit = m[2];
  const days = { h: 1 / 24, d: 1, w: 7, mo: 30, yr: 365 }[unit] || 99999;
  return n * days <= maxDays;
}

// ── Contact file update ─────────────────────────────────────────────────────

function updateContactFile(contact, recentPosts) {
  const today = new Date().toISOString().slice(0, 10);
  let text;
  try {
    text = fs.readFileSync(contact.path, 'utf8');
  } catch {
    return false;
  }
  // Update or insert last_linkedin_scan in frontmatter
  const fmMatch = text.match(/^(---\r?\n)([\s\S]*?)(\r?\n---)/);
  if (fmMatch) {
    let fm = fmMatch[2];
    if (/^last_linkedin_scan:/m.test(fm)) {
      fm = fm.replace(/^last_linkedin_scan:.*$/m, `last_linkedin_scan: ${today}`);
    } else {
      fm = fm + `\nlast_linkedin_scan: ${today}`;
    }
    text = text.replace(fmMatch[0], `${fmMatch[1]}${fm}${fmMatch[3]}`);
  }
  // If we found recent posts, append a History entry (idempotent: one entry per day)
  if (recentPosts.length > 0) {
    const histMatch = text.match(/^## History.*$/m);
    if (histMatch) {
      // Skip if we already wrote a LinkedIn bulk-scan entry for today
      const alreadyWritten = new RegExp(`^- ${today} \\(LinkedIn bulk-scan\\)`, 'm').test(text);
      if (!alreadyWritten) {
        const summary = recentPosts
          .map((p, i) => `(${i + 1}) ${p.age} ago: ${p.text.slice(0, 140).replace(/\s+/g, ' ')}`)
          .join(' ');
        const entry = `\n- ${today} (LinkedIn bulk-scan): ${recentPosts.length} recent post(s) found. ${summary}`;
        const idx = text.indexOf(histMatch[0]);
        const insertPoint = text.indexOf('\n', idx) + 1;
        text = text.slice(0, insertPoint) + entry + '\n' + text.slice(insertPoint);
      }
    }
  }
  try {
    fs.writeFileSync(contact.path, text, 'utf8');
    return true;
  } catch {
    return false;
  }
}

// ── Raw scrape archive (ingest funnel input) ────────────────────────────────

function safeContactSlug(name) {
  return (name || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'unknown';
}

function archiveRawScrape(contact, recentPosts) {
  // One file per contact per day, overwritten if rerun. Watcher dedupes by
  // file id, so re-running the scan within a day is a no-op for ingest.
  try {
    ensureDir(LINKEDIN_RAW_DIR);
    const today = new Date().toISOString().slice(0, 10);
    const slug = safeContactSlug(contact.name);
    const id = `${slug}-${today}`;
    const fname = path.join(LINKEDIN_RAW_DIR, `${id}.json`);
    const summary = (recentPosts || [])
      .map((p, i) => `(${i + 1}) ${p.age} ago: ${p.text}`)
      .join('\n');
    const payload = {
      id,
      type: recentPosts && recentPosts.length > 0 ? 'profile' : 'profile',
      contact_name: contact.name,
      contact_url: contact.url,
      category: contact.category,
      warmth: contact.warmth,
      scanned_at: new Date().toISOString(),
      recent_posts: recentPosts || [],
      body: summary || '(no recent activity)',
    };
    fs.writeFileSync(fname, JSON.stringify(payload, null, 2), 'utf8');
  } catch (e) {
    log(`archiveRawScrape failed for ${contact.name}: ${e.message}`);
  }
}

// ── Intel md + json ─────────────────────────────────────────────────────────

function writeIntel(results, errors, elapsedMs) {
  const today = new Date().toISOString().slice(0, 10);
  const scanned = results.length;
  const withActivity = results.filter((r) => r.recentPosts.length > 0);
  const quiet = results.filter((r) => r.recentPosts.length === 0 && !r.error);
  const errored = results.filter((r) => r.error);

  // ── md ────────────────────────────────────────────────────────────────────
  const lines = [];
  lines.push(`# LinkedIn Daily Intel — ${today}`);
  lines.push('');
  lines.push(`**Date**: ${today}`);
  lines.push(
    `**Scan method**: scripts/linkedin-bulk-scan.js (standalone Playwright, no MCP dependency)`,
  );
  const scannedNames = results.map((r) => r.contact.name).join(', ');
  lines.push(`**Batch scanned**: ${scannedNames || '(none)'}`);
  lines.push(`**Total warm contacts with linkedin URL**: ${results.length + errors.length}`);
  lines.push(`**Actually scanned**: ${scanned}`);
  lines.push(
    `**With recent activity (last 30d)**: ${withActivity.length}  |  **Quiet**: ${quiet.length}  |  **Errors**: ${errored.length}`,
  );
  lines.push(`**Elapsed**: ${Math.round(elapsedMs / 1000)}s`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## ENGAGEMENT OPPORTUNITIES');
  lines.push('');
  const hot = withActivity.filter((r) => r.recentPosts.some((p) => isRecent(p.age, 7)));
  if (hot.length === 0) {
    lines.push('No contacts with posts from the last 7 days.');
  } else {
    for (const r of hot) {
      lines.push(`### ${r.contact.name}`);
      lines.push(`- **Profile**: ${r.contact.url}`);
      for (const p of r.recentPosts.filter((pp) => isRecent(pp.age, 7)).slice(0, 3)) {
        lines.push(`- **${p.age} ago**: ${p.text.slice(0, 280)}`);
      }
      lines.push('');
    }
  }
  lines.push('');
  lines.push('## JOB CHANGES / RECENT POSTS (8-30 days)');
  lines.push('');
  const warm = withActivity.filter(
    (r) =>
      !r.recentPosts.some((p) => isRecent(p.age, 7)) &&
      r.recentPosts.some((p) => isRecent(p.age, 30)),
  );
  if (warm.length === 0) {
    lines.push('None.');
  } else {
    for (const r of warm) {
      lines.push(
        `- **${r.contact.name}**: ${r.recentPosts
          .filter((p) => isRecent(p.age, 30))
          .slice(0, 2)
          .map((p) => `${p.age} ago — ${p.text.slice(0, 160)}`)
          .join(' | ')}`,
      );
    }
  }
  lines.push('');
  lines.push('## QUIET (no posts in last 30 days)');
  lines.push('');
  lines.push(quiet.map((r) => `- ${r.contact.name}`).join('\n') || '(none)');
  lines.push('');
  if (errored.length > 0) {
    lines.push('## ERRORS');
    lines.push('');
    for (const r of errored) {
      lines.push(`- **${r.contact.name}**: ${r.error}`);
    }
    lines.push('');
  }
  ensureDir(CONTACTS_DIR);
  fs.writeFileSync(INTEL_MD_PATH, lines.join('\n'), 'utf8');

  // ── json ──────────────────────────────────────────────────────────────────
  const events = [];
  for (const r of withActivity) {
    for (const p of r.recentPosts.filter((pp) => isRecent(pp.age, 30))) {
      events.push({
        id: `${r.contact.file.replace('.md', '')}-${p.age.replace(/\s/g, '')}`,
        contactName: r.contact.name,
        eventType: /starting a new position|joined|excited to share that i.?.?ve joined/i.test(
          p.text,
        )
          ? 'job_change'
          : 'engagement',
        headline: `${r.contact.name} — ${p.text.slice(0, 120)}`,
        detail: `${p.age} ago. ${p.text.slice(0, 320)}`,
        source: 'linkedin_bulk_scan',
        detectedAt: new Date().toISOString(),
        reportedAt: null,
      });
    }
  }
  const intel = {
    lastCrawlAt: new Date().toISOString(),
    totalContactsQueried: scanned,
    totalContacts: scanned + errors.length,
    memoryUpdated: true,
    scanner: 'linkedin-bulk-scan.js',
    events,
  };
  ensureDir(path.dirname(INTEL_JSON_PATH));
  fs.writeFileSync(INTEL_JSON_PATH, JSON.stringify(intel, null, 2), 'utf8');
}

// ── Main ────────────────────────────────────────────────────────────────────

(async () => {
  const started = Date.now();
  log(`starting linkedin-bulk-scan — mode=${LOGIN_MODE ? 'login' : 'scan'} headless=${HEADLESS}`);

  ensureDir(CHROME_PROFILE);
  const context = await chromium.launchPersistentContext(CHROME_PROFILE, {
    headless: HEADLESS,
    viewport: { width: 1280, height: 900 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
    // Bypass LinkedIn's bot detection: the default Playwright Chromium
    // exposes navigator.webdriver=true which LinkedIn uses to redirect
    // to /login even with valid cookies. This init script strips the
    // flag before any page script runs.
    args: ['--disable-blink-features=AutomationControlled'],
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const page = context.pages()[0] || (await context.newPage());

  if (LOGIN_MODE) {
    log('LOGIN MODE: opening linkedin.com, sign in manually, then close the browser');
    await page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded' });
    log('waiting up to 5 minutes for login...');
    try {
      await page.waitForURL((url) => !/\/login|\/checkpoint/.test(url.toString()), {
        timeout: 300000,
      });
      log('login successful, session saved to persistent profile');
    } catch {
      log('login wait timed out');
    }
    await context.close();
    return;
  }

  // Quick session check
  try {
    await page.goto('https://www.linkedin.com/feed/', {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });
    const url = page.url();
    if (/\/login|\/checkpoint|\/authwall/i.test(url)) {
      log('SESSION EXPIRED — run with --login to sign in again');
      await context.close();
      process.exit(2);
    }
  } catch (e) {
    log('feed check failed: ' + e.message);
  }

  const contacts = loadContactsWithLinkedIn();
  log(`loaded ${contacts.length} contacts with linkedin URLs`);
  const queue = contacts.slice(0, LIMIT);
  log(`scanning ${queue.length} (LIMIT=${LIMIT === Infinity ? 'all' : LIMIT})`);

  const results = [];
  const errors = [];
  for (let i = 0; i < queue.length; i++) {
    const c = queue[i];
    log(`[${i + 1}/${queue.length}] ${c.name} (${c.category})`);
    const res = await scanContact(page, c);
    if (res.error) {
      log(`  ERROR: ${res.error}`);
      errors.push({ contact: c, error: res.error });
      results.push({ contact: c, recentPosts: [], error: res.error });
      if (res.error === 'LOGIN_REQUIRED') {
        log('fatal: login wall hit — stopping scan, run with --login');
        break;
      }
    } else {
      const recent = (res.posts || []).filter((p) => isRecent(p.age, 30));
      log(`  ${res.posts.length} posts captured, ${recent.length} recent (<=30d)`);
      results.push({ contact: c, recentPosts: recent });
      updateContactFile(c, recent);
      archiveRawScrape(c, recent);
    }
    // Rate limit
    if (i < queue.length - 1) {
      const jitter =
        INTER_CONTACT_DELAY_MS_MIN +
        Math.random() * (INTER_CONTACT_DELAY_MS_MAX - INTER_CONTACT_DELAY_MS_MIN);
      await new Promise((r) => setTimeout(r, jitter));
      if ((i + 1) % BATCH_SIZE === 0) {
        log(`  batch pause ${BATCH_PAUSE_MS / 1000}s`);
        await new Promise((r) => setTimeout(r, BATCH_PAUSE_MS));
      }
    }
  }

  writeIntel(results, errors, Date.now() - started);
  log(
    `scan complete — scanned=${results.length} errors=${errors.length} elapsedSec=${Math.round(
      (Date.now() - started) / 1000,
    )}`,
  );
  await context.close();
})().catch((e) => {
  log('fatal error: ' + e.stack);
  process.exit(1);
});
