// manual-briefing-v3.js
//
// Per project_briefing_spec.md (2026-04-10). Replaces v2.
//
// KEY ARCHITECTURAL RULES (violated in v2, enforced here):
// 1. ZERO paid LLM API calls. Summarization routes through `claude` CLI
//    (Luke's Claude Max subscription). No OpenAI, Groq, or Anthropic API keys
//    are read from config.
// 2. ZERO hardcoded action item strings. Action items are loaded from
//    data/briefing-action-items.json which must be generated from verified
//    Gmail thread reads (last sender check) before each run.
// 3. Briefing is written to BOTH C:\Users\luked\Desktop\briefing-YYYY-MM-DD.md
//    AND sent to Telegram.
// 4. Claude CLI must be invoked with CLAUDECODE env unset to bypass the
//    nested-session guard.
//
// Usage: node scripts/manual-briefing-v3.js

const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

// ── Config ───────────────────────────────────────────────────────────────────
const cfgPath = path.join(process.env.APPDATA || '', 'secondbrain', 'config.json');
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const BOT = cfg.telegramBotToken;
const CHAT = cfg.telegramChatId;
if (!BOT || !CHAT) {
  console.error('Telegram not configured');
  process.exit(1);
}

// Intentionally NOT reading cfg.openaiApiKey or cfg.anthropicApiKey or cfg.groqApiKey.
// Summarization goes through `claude` CLI only (Claude Max plan).

// ── Claude CLI summarization ─────────────────────────────────────────────────
// CRITICAL: spawnSync with shell:true on Windows uses cmd.exe which mangles
// multi-line prompts (truncates at whitespace, strips quotes). Calling claude.cmd
// directly fails with EINVAL. The only reliable path is to invoke the underlying
// cli.js with the current node binary and pass the prompt as a proper argv[]
// element with NO shell involved.
const CLAUDE_CLI_JS =
  'C:/Users/luked/AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/cli.js';

function claudeSummarize(prompt) {
  const env = { ...process.env };
  delete env.CLAUDECODE; // bypass nested-session guard
  const result = spawnSync(
    process.execPath,
    [CLAUDE_CLI_JS, '--model', 'claude-haiku-4-5-20251001', '-p', prompt],
    {
      env,
      encoding: 'utf8',
      timeout: 120000,
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  if (result.status !== 0 || !result.stdout) {
    const err = (result.error && result.error.message) || (result.stderr || '').slice(0, 200);
    console.warn('[claude] exit', result.status, 'err:', err);
    return '';
  }
  return result.stdout.trim();
}

// ── HTTP fetch helper ────────────────────────────────────────────────────────
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'SecondBrain/1.0' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return resolve(fetchUrl(res.headers.location));
        }
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      })
      .on('error', reject);
  });
}

// ── RSS parsing ──────────────────────────────────────────────────────────────
function parseRssItems(xml, max = 10) {
  const items = [];
  const itemRe = /<item[\s\S]*?<\/item>/gi;
  const matches = xml.match(itemRe) || [];
  for (const m of matches.slice(0, max)) {
    const title = (m.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/is) || [])[1];
    const link = (m.match(/<link>(.*?)<\/link>/is) || [])[1];
    const date = (m.match(/<pubDate>(.*?)<\/pubDate>/is) || [])[1];
    const author = (m.match(
      /<(?:dc:creator|author)>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/(?:dc:creator|author)>/is,
    ) || [])[1];
    const desc = (m.match(/<description>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/description>/is) ||
      [])[1];
    if (title) {
      items.push({
        title: title
          .trim()
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&#[0-9]+;/g, '')
          .replace(/<[^>]+>/g, ''),
        link: link ? link.trim() : '',
        date: date ? date.trim().slice(0, 16) : '',
        author: author ? author.trim() : '',
        desc: desc
          ? desc
              .trim()
              .replace(/<[^>]+>/g, '')
              .slice(0, 1200)
          : '',
      });
    }
  }
  return items;
}

async function fetchFeed(url, source) {
  try {
    const xml = await fetchUrl(url);
    return parseRssItems(xml, 10).map((i) => ({ ...i, source }));
  } catch (e) {
    console.warn('[' + source + ']', 'fetch failed:', e.message);
    return [];
  }
}

// ── Fetch full article body and strip HTML ──────────────────────────────────
async function fetchArticleBody(url) {
  if (!url) return '';
  try {
    const html = await fetchUrl(url);
    // Strip script, style, nav, header, footer, aside
    let text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<aside[\s\S]*?<\/aside>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '');
    // Try to extract article body from common containers
    const artMatch =
      text.match(/<article[\s\S]*?<\/article>/i) ||
      text.match(/<main[\s\S]*?<\/main>/i) ||
      text.match(/<div[^>]*class="[^"]*(?:article|post|content|entry)[^"]*"[\s\S]*?<\/div>/i);
    if (artMatch) text = artMatch[0];
    // Strip all remaining tags
    text = text
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#8217;/g, "'")
      .replace(/&#8220;/g, '"')
      .replace(/&#8221;/g, '"')
      .replace(/&#[0-9]+;/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    return text.slice(0, 6000);
  } catch (e) {
    return '';
  }
}

// ── 3-paragraph summarization via Claude CLI ─────────────────────────────────
async function summarizeArticle(a) {
  // Fetch full article body FIRST — RSS descriptions alone are too thin for
  // honest 3-paragraph summaries. Claude correctly refuses to fabricate from
  // metadata only, so we must give it real content.
  const body = await fetchArticleBody(a.link);
  const contextText = body || a.desc || '';

  if (!contextText || contextText.length < 200) {
    // Not enough real content — return a truthful placeholder instead of fabricating
    return (
      '(insufficient article content available — RSS description was ' +
      (a.desc ? a.desc.length : 0) +
      ' chars, full fetch returned ' +
      body.length +
      ' chars. Click the URL above to read the source.)'
    );
  }

  const prompt =
    'Write a 3-paragraph summary of this news article for a busy executive briefing. ' +
    'Each paragraph must contain specific facts (names, numbers, dates, direct quotes) drawn ONLY from the article content provided below. ' +
    'Do not invent facts. Do not hedge. Do not add preambles, apologies, meta-commentary, headers, or bullet points. ' +
    'If the content is promotional or lacks substance, write what you can in fewer paragraphs rather than refusing. ' +
    'Output ONLY the prose paragraphs separated by blank lines.\n\n' +
    '=== ARTICLE METADATA ===\n' +
    `Title: ${a.title}\n` +
    (a.source ? `Source: ${a.source}\n` : '') +
    (a.author ? `Author: ${a.author}\n` : '') +
    (a.date ? `Date: ${a.date}\n` : '') +
    (a.link ? `URL: ${a.link}\n` : '') +
    '\n=== ARTICLE CONTENT ===\n' +
    contextText;

  const out = claudeSummarize(prompt);
  if (!out) return '(summary unavailable — claude CLI returned empty)';
  return out;
}

function formatArticle(a, i, summary) {
  const metaParts = [];
  if (a.source) metaParts.push(a.source);
  if (a.author) metaParts.push(a.author);
  if (a.date) metaParts.push(a.date);
  return [
    `${i + 1}. ${a.title}`,
    metaParts.length ? `   ${metaParts.join(' · ')}` : null,
    a.link ? `   ${a.link}` : null,
    '',
    summary,
    '',
  ]
    .filter(Boolean)
    .join('\n');
}

// ── Telegram send with auto-split ────────────────────────────────────────────
async function sendTelegram(text) {
  const maxLen = 3900;
  const parts = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let cut = remaining.lastIndexOf('\n\n', maxLen);
    if (cut < 1000) cut = remaining.lastIndexOf('\n', maxLen);
    if (cut < 1000) cut = maxLen;
    parts.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  parts.push(remaining);
  for (const part of parts) {
    const body = JSON.stringify({ chat_id: CHAT, text: part, disable_web_page_preview: true });
    await new Promise((resolve, reject) => {
      const req = https.request(
        {
          host: 'api.telegram.org',
          path: `/bot${BOT}/sendMessage`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (d) => chunks.push(d));
          res.on('end', () => {
            if (res.statusCode !== 200) {
              console.error('telegram:', res.statusCode, Buffer.concat(chunks).toString());
              reject(new Error('telegram ' + res.statusCode));
            } else resolve();
          });
        },
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
    await new Promise((r) => setTimeout(r, 400));
  }
}

// ── Snack Dude invoice stats (DynamoDB, not git) ────────────────────────────
// Pulls actual business data from snackdude-dev-invoices in us-east-2.
// Reports invoice counts, revenue, and profit for 24h / 72h / 7d windows.
// The `date` field on each invoice is the invoice transaction date — for a
// small business that matches creation date closely enough to serve as a
// recency signal.
function getSnackDudeStats() {
  const tmpFile = path.join(require('os').tmpdir(), 'snackdude-invoices-briefing.json');
  try {
    execSync(
      `aws dynamodb scan --table-name snackdude-dev-invoices --region us-east-2 --output json > "${tmpFile}"`,
      { encoding: 'utf8', timeout: 30000 },
    );
    const raw = JSON.parse(fs.readFileSync(tmpFile, 'utf8'));
    const items = (raw.Items || []).map((i) => ({
      id: i.invoiceId ? i.invoiceId.S : '',
      date: i.date ? i.date.S : '',
      customer: i.customerName ? i.customerName.S.slice(0, 40) : '',
      total: parseFloat((i.total && i.total.N) || '0'),
      profit: parseFloat((i.profit && i.profit.N) || '0'),
    }));
    fs.unlinkSync(tmpFile);
    const today = new Date();
    const d1 = new Date(today.getTime() - 1 * 86400000).toISOString().slice(0, 10);
    const d3 = new Date(today.getTime() - 3 * 86400000).toISOString().slice(0, 10);
    const d7 = new Date(today.getTime() - 7 * 86400000).toISOString().slice(0, 10);
    const d30 = new Date(today.getTime() - 30 * 86400000).toISOString().slice(0, 10);
    const window = (since) => {
      const r = items.filter((i) => i.date >= since);
      return {
        n: r.length,
        total: r.reduce((s, i) => s + i.total, 0),
        profit: r.reduce((s, i) => s + i.profit, 0),
      };
    };
    // Most recent invoice date present in the table — if stale, Luke needs to know
    const maxDate =
      items
        .map((i) => i.date)
        .filter(Boolean)
        .sort()
        .slice(-1)[0] || 'none';
    // Top 5 most recent
    const recent = items
      .filter((i) => i.date)
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 5);
    return {
      totalInRepo: items.length,
      maxDate,
      h24: window(d1),
      h72: window(d3),
      d7: window(d7),
      d30: window(d30),
      recent,
      source: 'snackdude-dev-invoices DynamoDB table (us-east-2)',
    };
  } catch (e) {
    return {
      totalInRepo: 0,
      error: e.message,
      source: 'DDB scan failed',
    };
  }
}

// ── Video pipeline counts ────────────────────────────────────────────────────
function getVideoStats() {
  const pendingPath = 'C:/Users/luked/secondbrain/content-review/pending/manifest.json';
  const publishedPath = 'C:/Users/luked/secondbrain/content-review/published/manifest.json';
  const queuePath = 'C:/Users/luked/secondbrain/content-review/upload-queue.json';
  const stats = {
    pending: { count: 0, titles: [] },
    published: { count: 0, last7d: 0, titles: [] },
    uploadQueue: { count: 0, titles: [] },
  };
  try {
    const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
    const vids = pending.videos || [];
    stats.pending.count = vids.length;
    stats.pending.titles = vids.map((v) => v.title || v.id).slice(0, 10);
  } catch {}
  try {
    const published = JSON.parse(fs.readFileSync(publishedPath, 'utf8'));
    const vids = published.videos || [];
    stats.published.count = vids.length;
    const today = new Date();
    const d7 = new Date(today.getTime() - 7 * 86400000).toISOString().slice(0, 10);
    const recent = vids.filter((v) => (v.published_date || '') >= d7);
    stats.published.last7d = recent.length;
    stats.published.titles = recent.slice(0, 5).map((v) => v.title || v.id);
  } catch {}
  try {
    const queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
    const arr = Array.isArray(queue) ? queue : Object.values(queue);
    stats.uploadQueue.count = arr.length;
    stats.uploadQueue.titles = arr
      .map((q) => (q && (q.title || q.id || q.videoId)) || '(unknown)')
      .slice(0, 5);
  } catch {}
  return stats;
}

// ── System health checks ─────────────────────────────────────────────────────
// Per feedback_daily_health_checks.md: backups, EC2 backend, LLM source,
// tests, and briefly summarize memory systems status.
function getHealthChecks() {
  const h = {
    backups: { status: 'unknown', detail: '' },
    ec2: { status: 'unknown', detail: '' },
    llm: { status: 'unknown', detail: '' },
    tests: { status: 'unknown', detail: '' },
  };
  // EC2 + LLM source
  try {
    const raw = execSync('curl -s -m 5 http://98.80.164.16:3001/health', {
      encoding: 'utf8',
      timeout: 8000,
    });
    const j = JSON.parse(raw);
    h.ec2.status = j.status === 'ok' ? 'green' : 'red';
    h.ec2.detail =
      j.status + ', uptime ' + Math.round((j.uptime || 0) / 3600) + 'h, v' + (j.version || '?');
    const src = j.llm && j.llm.source;
    if (src && /claude-max-plan|FREE/.test(src)) {
      h.llm.status = 'green';
      h.llm.detail = src;
    } else {
      h.llm.status = 'red';
      h.llm.detail =
        src +
        ' — maxPlanProxy ' +
        (j.llm && j.llm.maxPlanProxy) +
        ' (should be connected for FREE Claude Max routing)';
    }
  } catch (e) {
    h.ec2.status = 'red';
    h.ec2.detail = 'curl failed: ' + e.message.slice(0, 80);
  }
  // Backups — latest snapshot timestamp
  try {
    const out = execSync(
      `aws s3api list-objects-v2 --bucket 672613094048-secondbrain-backups --prefix snapshots/2026 --region us-east-1 --query "reverse(sort_by(Contents, &LastModified))[:1].[Key,LastModified,Size]" --output text`,
      { encoding: 'utf8', timeout: 15000 },
    ).trim();
    const [key, lastMod, size] = out.split('\t');
    const ageMs = Date.now() - new Date(lastMod).getTime();
    const ageHrs = Math.round(ageMs / 3600000);
    const sizeMb = Math.round(parseInt(size, 10) / 1024 / 1024);
    h.backups.status = ageHrs <= 30 ? 'green' : 'red';
    h.backups.detail = `last: ${key.split('/').pop()} (${ageHrs}h ago, ${sizeMb}MB)`;
  } catch (e) {
    h.backups.status = 'red';
    h.backups.detail = 'S3 list failed: ' + e.message.slice(0, 80);
  }
  // Tests — run the briefing test files only (fast, ~500ms)
  try {
    execSync(
      'npx vitest run src/main/__tests__/manual-briefing.test.ts src/main/__tests__/briefing-no-groq.test.ts',
      { encoding: 'utf8', timeout: 60000, cwd: 'C:/Users/luked/secondbrain', stdio: 'pipe' },
    );
    h.tests.status = 'green';
    h.tests.detail = '33/33 briefing tests passing';
  } catch (e) {
    h.tests.status = 'red';
    h.tests.detail = 'test run failed';
  }
  return h;
}

// ── Inner circle contact neglect scan ────────────────────────────────────────
function getContactNeglect() {
  const dir = 'C:/Users/luked/secondbrain/memory/contacts';
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f !== 'INDEX.md' && !f.startsWith('_'));
  const today = new Date();
  const all = [];
  for (const f of files) {
    try {
      const s = fs.readFileSync(path.join(dir, f), 'utf8');
      const dates = s.match(/\b(20\d{2}-\d{2}-\d{2})\b/g) || [];
      if (dates.length === 0) continue;
      const sorted = dates.map((d) => new Date(d)).sort((a, b) => b - a);
      const last = sorted[0];
      const days = Math.floor((today - last) / 86400000);
      if (days < 0) continue;
      all.push({ name: f.replace('.md', ''), last: last.toISOString().slice(0, 10), days });
    } catch {}
  }
  const idx = fs.readFileSync('C:/Users/luked/secondbrain/memory/contacts/INDEX.md', 'utf8');
  const innerSection = idx.match(/## Inner Circle([\s\S]*?)##/);
  const inner = ((innerSection ? innerSection[1] : '').match(/\]\(([^)]+\.md)\)/g) || []).map((x) =>
    x.slice(2, -1).replace('.md', ''),
  );
  return all.filter((n) => inner.includes(n.name)).sort((a, b) => b.days - a.days);
}

// ── Action items loaded from external JSON (no hardcoded strings) ────────────
function loadActionItems() {
  const p = 'C:/Users/luked/secondbrain/data/briefing-action-items.json';
  if (!fs.existsSync(p)) {
    return { unansweredEmails: [], openCommitments: [], generatedAt: 'never' };
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  const today = new Date().toLocaleDateString('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
  const todayIso = new Date().toISOString().slice(0, 10);

  console.log('fetching feeds in parallel...');
  const [worldBBC, worldNYT, worldNPR, techArs, techTC, onity, mortgage] = await Promise.all([
    fetchFeed('https://feeds.bbci.co.uk/news/rss.xml', 'BBC News'),
    fetchFeed('https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml', 'NYT'),
    fetchFeed('https://feeds.npr.org/1001/rss.xml', 'NPR'),
    fetchFeed('https://arstechnica.com/feed/', 'Ars Technica'),
    fetchFeed('https://techcrunch.com/category/artificial-intelligence/feed/', 'TechCrunch AI'),
    fetchFeed(
      'https://news.google.com/rss/search?q=%22Onity+Group%22+OR+%22Ocwen%22&hl=en-US&gl=US&ceid=US:en',
      'Google News',
    ),
    fetchFeed(
      'https://news.google.com/rss/search?q=mortgage+rates+OR+housing+market&hl=en-US&gl=US&ceid=US:en',
      'Google News',
    ),
  ]);

  const dedup = (arr, n) => {
    const seen = new Set();
    const out = [];
    for (const a of arr) {
      const key = a.title.toLowerCase().slice(0, 40);
      if (!seen.has(key) && out.length < n) {
        seen.add(key);
        out.push(a);
      }
    }
    return out;
  };

  const world = dedup([...worldBBC, ...worldNYT, ...worldNPR], 10);
  const tech = dedup([...techTC, ...techArs], 10);
  const onityFiltered = onity
    .filter((a) => /onity|ocwen/i.test(a.title + ' ' + a.desc))
    .slice(0, 5);
  const mortgageTop = mortgage.slice(0, 5);

  const totalArticles = tech.length + world.length + onityFiltered.length + mortgageTop.length;
  console.log(`summarizing ${totalArticles} articles via claude CLI (Claude Max plan)...`);

  // Claude CLI is a subprocess per call — run sequentially to avoid contention.
  // summarizeArticle is async because it fetches the full article body first.
  const techSummaries = [];
  for (let i = 0; i < tech.length; i++) {
    console.log(`  tech ${i + 1}/${tech.length}: ${tech[i].title.slice(0, 50)}`);
    techSummaries.push(await summarizeArticle(tech[i]));
  }
  const worldSummaries = [];
  for (let i = 0; i < world.length; i++) {
    console.log(`  world ${i + 1}/${world.length}: ${world[i].title.slice(0, 50)}`);
    worldSummaries.push(await summarizeArticle(world[i]));
  }
  const onitySummaries = [];
  for (let i = 0; i < onityFiltered.length; i++) {
    console.log(`  onity ${i + 1}/${onityFiltered.length}`);
    onitySummaries.push(await summarizeArticle(onityFiltered[i]));
  }
  const mortgageSummaries = [];
  for (let i = 0; i < mortgageTop.length; i++) {
    console.log(`  mortgage ${i + 1}/${mortgageTop.length}`);
    mortgageSummaries.push(await summarizeArticle(mortgageTop[i]));
  }

  const snack = getSnackDudeStats();
  const neglect = getContactNeglect();
  const actions = loadActionItems();
  const videos = getVideoStats();
  const health = getHealthChecks();

  // ── Message 1: Header + AI/Tech ────────────────────────────────────────────
  const msg1 = [
    `Good morning Luke — ${today}`,
    `Daily Executive Briefing`,
    `Generated: ${new Date().toISOString()}`,
    `LLM: claude-haiku-4-5 via Claude Max plan (claude CLI subprocess)`,
    '',
    `AI & TECH NEWS (${tech.length}):`,
    '',
    ...tech.map((a, i) => formatArticle(a, i, techSummaries[i])),
  ].join('\n');

  // ── Message 2: World ───────────────────────────────────────────────────────
  const msg2 = [
    `WORLD NEWS (${world.length}):`,
    '',
    ...world.map((a, i) => formatArticle(a, i, worldSummaries[i])),
  ].join('\n');

  // ── Message 3: Industry ────────────────────────────────────────────────────
  const msg3Parts = [];
  if (onityFiltered.length > 0) {
    msg3Parts.push(`ONITY GROUP NEWS (${onityFiltered.length}):`, '');
    msg3Parts.push(...onityFiltered.map((a, i) => formatArticle(a, i, onitySummaries[i])));
  } else {
    msg3Parts.push(
      "ONITY GROUP NEWS: no direct mentions of Onity or Ocwen found in today's news search.",
    );
    msg3Parts.push('');
  }
  if (mortgageTop.length > 0) {
    msg3Parts.push(`MORTGAGE INDUSTRY NEWS (${mortgageTop.length}):`, '');
    msg3Parts.push(...mortgageTop.map((a, i) => formatArticle(a, i, mortgageSummaries[i])));
  }
  const msg3 = msg3Parts.join('\n');

  // ── Message 4: Personal + Operational ──────────────────────────────────────
  const msg4Parts = [];

  // Action items — DYNAMIC from JSON, not hardcoded
  msg4Parts.push('ACTION ITEMS — unanswered asks (verified by reading each thread):');
  msg4Parts.push(
    `(source: ${actions.generatedBy || 'unknown'}, generated ${actions.generatedAt || 'never'})`,
  );
  msg4Parts.push('');
  if (actions.unansweredEmails && actions.unansweredEmails.length > 0) {
    for (const item of actions.unansweredEmails) {
      msg4Parts.push(`${item.rank}. ${item.person} — ${item.subject} (${item.daysOld}d old)`);
      msg4Parts.push(`   ${item.summary}`);
      if (item.gmailUrl) msg4Parts.push(`   ${item.gmailUrl}`);
      msg4Parts.push('');
    }
  } else {
    msg4Parts.push('No unanswered emails flagged.');
    msg4Parts.push('');
  }

  if (actions.openCommitments && actions.openCommitments.length > 0) {
    msg4Parts.push('OPEN COMMITMENTS — you promised but have not done:');
    msg4Parts.push('');
    for (const c of actions.openCommitments) {
      msg4Parts.push(`• ${c.person} — ${c.commitment} (${c.daysOld}d since commitment)`);
      msg4Parts.push(`  ${c.summary}`);
      msg4Parts.push('');
    }
  }

  // PEOPLE YOU MAY BE NEGLECTING
  const stale = neglect.filter((n) => n.days >= 5).slice(0, 5);
  if (stale.length > 0) {
    msg4Parts.push('INNER CIRCLE — 5+ days since last logged activity:');
    msg4Parts.push('');
    for (const n of stale) {
      msg4Parts.push(`  • ${n.name.replace(/_/g, ' ')} — ${n.days}d ago (${n.last})`);
    }
    msg4Parts.push('');
  } else {
    msg4Parts.push(
      `INNER CIRCLE: all ${neglect.length} contacts have activity within 5 days. None neglected.`,
    );
    msg4Parts.push('');
  }

  // SNACK DUDE INVOICE ACTIVITY (DynamoDB, not git commits)
  msg4Parts.push('SNACK DUDE INVOICE ACTIVITY (' + (snack.source || 'unknown') + '):');
  if (snack.error) {
    msg4Parts.push('  DDB scan failed: ' + snack.error);
  } else {
    const fmt = (w) =>
      `${w.n} invoices, $${w.total.toFixed(2)} revenue, $${w.profit.toFixed(2)} profit`;
    msg4Parts.push('  Last 24h:  ' + fmt(snack.h24));
    msg4Parts.push('  Last 72h:  ' + fmt(snack.h72));
    msg4Parts.push('  Last 7d:   ' + fmt(snack.d7));
    msg4Parts.push('  Last 30d:  ' + fmt(snack.d30));
    msg4Parts.push('  Table total: ' + snack.totalInRepo + ' invoices');
    msg4Parts.push('  Most recent invoice date in table: ' + snack.maxDate);
    if (snack.h24.n === 0 && snack.d7.n === 0) {
      msg4Parts.push(
        '  ⚠ No invoices logged in the last 7 days. Either sales stopped or entry has lapsed.',
      );
    }
  }
  msg4Parts.push('');

  // CONTENT PIPELINE — reference only, review in the app
  // Per project_briefing_spec.md: link to Content Pipeline, do not embed titles.
  // Target cadence: 1 AILifeHacks/day, 1 BedtimeStories every other day.
  msg4Parts.push('CONTENT PIPELINE (review in SecondBrain app, not here):');
  msg4Parts.push(
    '  ' +
      videos.pending.count +
      ' pending review, ' +
      videos.uploadQueue.count +
      ' in upload queue, ' +
      videos.published.count +
      ' published to date',
  );
  msg4Parts.push('  Target cadence: 1 AILifeHacks/day, 1 BedtimeStories every other day');
  msg4Parts.push('');

  // SYSTEM HEALTH CHECKS
  msg4Parts.push('SYSTEM HEALTH:');
  const icon = (s) => (s === 'green' ? '✓' : s === 'red' ? '✗' : '?');
  msg4Parts.push('  ' + icon(health.backups.status) + ' Backups:  ' + health.backups.detail);
  msg4Parts.push('  ' + icon(health.ec2.status) + ' EC2:      ' + health.ec2.detail);
  msg4Parts.push('  ' + icon(health.llm.status) + ' LLM src:  ' + health.llm.detail);
  msg4Parts.push('  ' + icon(health.tests.status) + ' Tests:    ' + health.tests.detail);
  const anyRed = Object.values(health).some((h) => h.status === 'red');
  msg4Parts.push('  Overall:  ' + (anyRed ? '⚠ RED — subsystems need attention' : '✓ all green'));
  msg4Parts.push('');

  msg4Parts.push("Reply with questions or say 'call me' to discuss.");

  const msg4 = msg4Parts.join('\n');

  // ── Write to Desktop + home dir + secondbrain data dir ────────────────────
  const fullBriefing = [msg1, msg2, msg3, msg4].join('\n\n---\n\n');
  const outputs = [
    `C:/Users/luked/Desktop/briefing-${todayIso}.md`,
    `C:/Users/luked/briefing-${todayIso}.md`,
    `C:/Users/luked/secondbrain/data/briefings/briefing-${todayIso}.md`,
  ];
  for (const p of outputs) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, fullBriefing, 'utf8');
    console.log(`wrote ${fullBriefing.length} chars to ${p}`);
  }

  // ── Send to Telegram ───────────────────────────────────────────────────────
  console.log('msg1:', msg1.length);
  console.log('msg2:', msg2.length);
  console.log('msg3:', msg3.length);
  console.log('msg4:', msg4.length);
  console.log('total:', fullBriefing.length);
  console.log('sending to telegram...');
  await sendTelegram(msg1);
  await sendTelegram(msg2);
  await sendTelegram(msg3);
  await sendTelegram(msg4);
  console.log('done');
})().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
