#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');

function todayCt() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

function argValue(name) {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  const pref = `${name}=`;
  const hit = process.argv.find((a) => a.startsWith(pref));
  return hit ? hit.slice(pref.length) : null;
}

const date = argValue('--date') || todayCt();
const briefingPath = path.join(REPO, 'data', 'briefings', `briefing-${date}.md`);
const failures = [];

function fail(msg) {
  failures.push(msg);
}

function readJson(rel) {
  try {
    return JSON.parse(fs.readFileSync(path.join(REPO, rel), 'utf8'));
  } catch {
    return null;
  }
}

function readJsonAbs(absPath) {
  try {
    return JSON.parse(fs.readFileSync(absPath, 'utf8'));
  } catch {
    return null;
  }
}

if (!fs.existsSync(briefingPath)) {
  fail(`briefing markdown missing for ${date}`);
}

const md = fs.existsSync(briefingPath) ? fs.readFileSync(briefingPath, 'utf8') : '';

function briefingModeFromMarkdown(markdown) {
  const m = String(markdown || '').match(/^Briefing mode:\s*(overnight|off-cycle)\b/im);
  return m ? m[1].toLowerCase() : '';
}

const briefingMode = briefingModeFromMarkdown(md);
const isOffCycle = briefingMode === 'off-cycle';
const isOvernight = briefingMode === 'overnight';
if (!briefingMode) fail('Briefing mode missing: expected "Briefing mode: overnight" or "Briefing mode: off-cycle"');

const banned = [
  /Read the full article/i,
  /RSS-derived summary/i,
  /operator must/i,
  /must scrub/i,
  /verify speaker/i,
  /manifest has no timestamped videos/i,
  /will draft/i,
  /next pass/i,
  /Nothing from you/i,
  /Nothing required/i,
  /Nothing immediate/i,
  /Nothing if/i,
  /What I need from you:\s*Nothing\b/i,
  /nothing unless/i,
  /looping until/i,
  /until it clears/i,
  /red-blocking/i,
  /watch only/i,
  /Generator returned no output/i,
  /Generation failed/i,
  /No proposals generated/i,
  /no articles in window/i,
  /Drafts loaded from/i,
  /today's scan was empty/i,
  /Corrected paragraph/i,
  /EM DASH SENTENCE/i,
  /sentence\s*(?:for paragraph|\([^)]*em dash|:\*\*)/i,
  /\bTLDR:/i,
  /<!\[CDATA\[/i,
  /Text settings/i,
  /Story text Size/i,
  /SKIP ADVERTISEMENT/i,
  /hide caption toggle caption/i,
  /Minimize to nav/i,
  /Download the NEW APP/i,
  /Toggle navigation/i,
  /Current Mortgage Rates/i,
  /Mortgage Rates and MBS/i,
  /Rate Volatility Index/i,
  /This website requires Javascrip/i,
  /\batdigit\b/i,
  /Subscribers only/i,
  /Standard\s+Wide\s+Links/i,
  /Today's Videos/i,
  /Sponsor Message/i,
  /Toggle more options/i,
  /Download Embed/i,
  /Heard on [A-Z]/i,
  /\b(?:News|Analysis|Politics|Elections|Media|Obituaries|Europe)\s+[A-Z][^.!?]{0,180}\s+May\s+\d{1,2},\s+2026\s+\d{1,2}:\d{2}\s+(?:AM|PM)\s+ET\s+By\b/i,
  /This item did not pass the executive-detail bar/i,
  /not ready for approval/i,
  /Related contacts/i,
  /Related insights/i,
  /Related offices/i,
  /Share Twitter Facebook LinkedIn/i,
  /Explore more at Fragomen/i,
  /Email \[emailprotected\]/i,
  /Quick Hits/i,
  /Read more Overview/i,
  /Alerts driven thinking/i,
  /Overview The Department/i,
  /Each month, the USCIS/i,
  /^\d+\s+(?:minutes?|hours?|days?)\s+ago\b/im,
  /\b(?:Correspondent|Reporter|Editor),\s+[A-Z][A-Za-z ,.-]+/,
  /not a law firm/i,
  /does not provide legal advice/i,
  /Reach out today/i,
  /support your company.?s immigration needs/i,
  /Set Yourself Apart from your Competition/i,
  /Become the market expert/i,
];

for (const re of banned) {
  if (re.test(md)) fail(`placeholder text leaked into briefing: ${re}`);
}

function findSectionStart(lines, label) {
  return lines.findIndex((line) => new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(line));
}

function sectionBody(label, options = {}) {
  const lines = md.split(/\r?\n/);
  const start = findSectionStart(lines, label);
  if (start < 0) {
    if (!options.optional) fail(`${label} section missing`);
    return '';
  }
  let end = lines.length;
  const nextHeaderRe = /^[A-Z][A-Z0-9 &/().,'+-]+(?:\s+\([^)]*\))*:\s*$/;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^---\s*$/.test(lines[i]) || nextHeaderRe.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join('\n').trim();
}

function sectionBodyAny(labels, displayLabel) {
  for (const label of labels) {
    const body = sectionBody(label, { optional: true });
    if (body) return body;
  }
  fail(`${displayLabel || labels[0]} section missing`);
  return '';
}

function parseNumberedItems(body) {
  const lines = body.split(/\r?\n/);
  const items = [];
  let cur = null;
  for (const line of lines) {
    const head = line.match(/^\s*(\d+)\.\s+(.+)$/);
    if (head) {
      if (cur) items.push(cur);
      cur = { n: Number(head[1]), title: head[2].trim(), lines: [] };
      continue;
    }
    if (cur) cur.lines.push(line);
  }
  if (cur) items.push(cur);
  return items;
}

function readJsonl(rel) {
  try {
    return fs.readFileSync(path.join(REPO, rel), 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function hoursOld(ts) {
  const t = ts ? new Date(ts).getTime() : NaN;
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((Date.now() - t) / 3600000));
}

function escapeRe(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const systemHealthBody = sectionBody('SYSTEM HEALTH');
const healthLines = systemHealthBody.split(/\r?\n/);
const nonGreenHealth = [];
for (const line of healthLines) {
  const m = line.match(/^\s*([✗?])\s+([A-Za-z][\w:\s-]*?):\s+(.+)$/);
  if (m) nonGreenHealth.push({ mark: m[1], name: m[2].trim() });
}
if (nonGreenHealth.length) {
  if (!/Attention on \d+ subsystem/i.test(systemHealthBody)) fail('system health has non-green rows without an Attention block');
  for (const item of nonGreenHealth) {
    const blockMatch = systemHealthBody.match(new RegExp(`\\n\\s*[✗?]\\s+${escapeRe(item.name)}\\s*\\n([\\s\\S]*?)(?=\\n\\s*[✗?]\\s+[A-Za-z]|\\n\\s*Overall:|$)`, 'i'));
    const block = blockMatch ? blockMatch[1] : '';
    for (const field of ['requirement:', 'risk if not fixed:', 'what I tried:', 'current wall:', 'what I need from you:', 'next action:']) {
      if (!block.toLowerCase().includes(field.toLowerCase())) fail(`system health ${item.name} missing executive field "${field}"`);
    }
    if (isOffCycle && !/Off-cycle refresh/i.test(`${systemHealthBody}\n${block}`)) {
      fail('off-cycle non-green health row must say off-cycle refresh, no overnight auto-heal attempted');
    }
    if (isOvernight) {
      if (/Off-cycle refresh/i.test(block)) {
        fail('overnight result cannot contain off-cycle refresh language');
      }
      if (/what I need from you:\s*(?:nothing|no\b)|Amy owns|Amy must|will fix|will rerun|must repair|must rerun|heal loop|next action:\s*(?:heal|fix|rerun|refresh|restart|build)/i.test(block)) {
        fail('overnight result cannot contain Amy-owned future repair language');
      }
      if (!/(hard blocker:|current wall:.*(?:cannot|failed after|exhausted|blocked by|credential|permission|auth|timeout|unreachable|external))/i.test(block)) {
        fail('overnight non-green health row must name a hard blocker, not future repair work');
      }
    }
  }
}

const blockersBody = sectionBodyAny(['BLOCKERS - briefing quality gates', 'BLOCKERS / NEEDS FROM LUKE'], 'BLOCKERS');
const linkedinBody = sectionBody('LINKEDIN');
const linkedinStatus = readJsonAbs(path.join(process.env.APPDATA || '', 'secondbrain', 'data', 'agent', 'linkedin-scan-status.json'));
const linkedinStatusAt = linkedinStatus && linkedinStatus.checkedAt ? new Date(linkedinStatus.checkedAt).getTime() : NaN;
const linkedInFreshRed = Number.isFinite(linkedinStatusAt) && (Date.now() - linkedinStatusAt) <= 24 * 3600000 && linkedinStatus.status === 'red';
const currentLinkedInExpired = linkedInFreshRed || /SESSION EXPIRED|login\/CAPTCHA|authwall/i.test(linkedinBody);
if (currentLinkedInExpired && !/LinkedIn scanner auth/i.test(blockersBody)) {
  fail('LinkedIn session blocker not surfaced in top blockers');
}
if (/Action items source freshness/i.test(blockersBody)) {
  fail('action-items freshness is Amy-owned unless a Gmail auth wall is named; do not surface it as a Luke blocker');
}

const actionSource = readJson('data/briefing-action-items.json');
const actionStamps = actionSource
  // Only a base artifact rebuild clears Action Items freshness. A reply
  // verification timestamp proves old candidates were checked, but it can
  // never make the source current by itself.
  ? [actionSource.lastFullReviewAt, actionSource.generatedAt]
    .map((ts) => (ts && ts !== 'never' ? new Date(ts).getTime() : NaN))
    .filter(Number.isFinite)
  : [];
const actionEffectiveAt = actionStamps.length ? new Date(Math.max(...actionStamps)).toISOString() : null;
const actionAge = actionEffectiveAt ? hoursOld(actionEffectiveAt) : null;
const gmailHeartbeats = readJsonl('data/agent/gmail-scan-heartbeat.jsonl');
const gmailHeartbeat = gmailHeartbeats[gmailHeartbeats.length - 1] || null;
const gmailHeartbeatAge = gmailHeartbeat && gmailHeartbeat.ts ? hoursOld(gmailHeartbeat.ts) : null;
if (isOvernight && (!actionSource || actionAge == null || actionAge > 24 || gmailHeartbeatAge == null || gmailHeartbeatAge > 1)) {
  if (/Gmail authorization|Gmail permission|re-authorize/i.test(blockersBody)) {
    const actionBody = sectionBody('ACTION ITEMS');
    if (/^\s*\d+\.\s+/m.test(actionBody) || /OPEN COMMITMENTS/i.test(actionBody)) {
      fail('Gmail-auth-blocked action items rendered old asks/commitments as if verified');
    }
  } else {
    fail('action-items source is stale; Amy must rerun Gmail scan/reply verification before publishing');
  }
}

function paragraphsForArticle(item) {
  const linkIdx = item.lines.findIndex((line) => /https?:\/\//.test(line));
  const contentLines = linkIdx >= 0 ? item.lines.slice(linkIdx + 1) : item.lines;
  return contentLines.join('\n').trim().split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

function newsArtifactRe() {
  return /&(?:apos|amp|quot|nbsp|middot|ndash|mdash|#\d+|#x[0-9a-f]+);|\u00e2\u20ac|<!\[CDATA\[|Text settings|Story text Size|SKIP ADVERTISEMENT|hide caption toggle caption|Minimize to nav|Download the NEW APP|Toggle navigation|Current Mortgage Rates|Mortgage Rates and MBS|Rate Volatility Index|This website requires Javascrip|\batdigit\b|Subscribers only|Standard\s+Wide\s+Links|Today's Videos|Sponsor Message|Related contacts|Related insights|Related offices|Share Twitter Facebook LinkedIn|Explore more at Fragomen|Media mentions|Email \[emailprotected\]|Quick Hits|Read more Overview|Alerts driven thinking|Overview The Department|Each month, the USCIS|Toggle more options|Download Embed|Heard on [A-Z]|Transcript\b|Back transcript|This is a locator map|\bBy The Associated Press\b|\b(?:AP|Reuters|Getty Images|AFP)\s+(?:AP|Reuters|Getty Images|AFP)\b|^\d+\s+(?:minutes?|hours?|days?)\s+ago\b|\b(?:Correspondent|Reporter|Editor),\s+[A-Z][A-Za-z ,.-]+|Country \/ Territory|Don't Miss an Update|Attorney Insights|not a law firm|does not provide legal advice|friendly legal teams|Reach out today|support your company.?s immigration needs|Set Yourself Apart from your Competition|Become the market expert|\b(?:News|Analysis|Politics|Elections|Media|Obituaries|Europe)\s+[A-Z][^.!?]{0,180}\s+May\s+\d{1,2},\s+2026\s+\d{1,2}:\d{2}\s+(?:AM|PM)\s+ET\s+By\b/i;
}

function paragraphWordCount(p) {
  return String(p || '').split(/\s+/).filter(Boolean).length;
}

const newsExpectations = new Map([
  ['AI & TECH NEWS', 10],
  ['US NEWS', 10],
  ['WORLD NEWS', 10],
  ['US IMMIGRATION NEWS', 10],
  ['MORTGAGE INDUSTRY NEWS', 10],
]);

for (const [label, expectedCount] of newsExpectations) {
  const body = sectionBody(label);
  const articles = parseNumberedItems(body);
  if (articles.length !== expectedCount) fail(`${label} has ${articles.length}/${expectedCount} articles`);
  for (const article of articles) {
    const text = article.lines.join('\n');
    if (/\btranscript\b/i.test(article.title)) {
      fail(`${label} item ${article.n} is a transcript, not a news article`);
    }
    if (!/https?:\/\//.test(text)) fail(`${label} item ${article.n} has no source link`);
    const paras = paragraphsForArticle(article);
    if (paras.length !== 3) fail(`${label} item ${article.n} has ${paras.length}/3 paragraphs`);
    if (paras.some((p) => /^(What happened|Why it matters|What to watch):/i.test(p))) {
      fail(`${label} item ${article.n} uses labeled bullets instead of a three-paragraph narrative summary`);
    }
    if (paras.some((p) => p.length < 110 || paragraphWordCount(p) < 18)) {
      fail(`${label} item ${article.n} has a too-thin paragraph`);
    }
    if (paras.some((p) => !/[.!?]["']?$/.test(p))) {
      fail(`${label} item ${article.n} has a paragraph that does not end as prose`);
    }
    if (paras.some((p) => newsArtifactRe().test(p))) {
      fail(`${label} item ${article.n} contains publisher chrome instead of briefing prose`);
    }
  }
}

const amyBody = sectionBody('AMY PROJECTS ASSIGNED');
const recentAmyQueue = readJsonl('data/agent/dispatch-queue.jsonl').filter((obj) => {
  const source = String(obj.source || '');
  if (!/(gmail_amy_email|vapi_call|otter)/i.test(source)) return false;
  const ts = new Date(obj.ts || obj.call_started_at || obj.date || '').getTime();
  return Number.isFinite(ts) && Date.now() - ts <= 24 * 3600 * 1000;
});
const recentAgentSessions = [
  readJson('data/agent-collab/current-session.json'),
  readJson('data/agent-collab/amy-outbox.json'),
  readJson('data/agent-collab/codex-outbox.json'),
].filter((obj) => {
  if (!obj) return false;
  const raw = obj.timestamp || obj.last_update || obj.started;
  const ts = typeof raw === 'number'
    ? raw * 1000
    : typeof raw === 'string' && /^\d{10}$/.test(raw)
      ? Number(raw) * 1000
      : new Date(raw || '').getTime();
  return Number.isFinite(ts) && Date.now() - ts <= 24 * 3600 * 1000;
});
const recentAmyWorkCount = recentAmyQueue.length + recentAgentSessions.length;
if (recentAmyWorkCount && !/^\s*[^\n]*\[(#Amy email|phone call|voice note|session)\]/m.test(amyBody)) {
  fail(`AMY PROJECTS has ${recentAmyWorkCount} recent user-originated task/session item(s) but no rendered rows`);
}
if (/No dashboard prompts, #Amy emails, voice notes, phone-call tasks, or agent sessions/i.test(amyBody) && recentAmyWorkCount) {
  fail('AMY PROJECTS says zero despite recent #Amy/call/voice/session activity');
}

const featureBody = sectionBody('FEATURE BACKLOG');
if (/No approval asks today|failed the quality bar|weak suggestion\(s\) hidden/i.test(featureBody)) {
  if (!/Feature backlog has \d+ weak suggestion\(s\)|weak suggestion\(s\) hidden by its own quality gate/i.test(blockersBody)) {
    fail('FEATURE BACKLOG weak-suggestions quality gate is not surfaced in top blockers');
  }
}
if (!/^\s+\d+\.\s+\[\d+\]\s+/m.test(featureBody)) {
  fail('FEATURE BACKLOG has no current scored approval asks');
}

const contentPipelineBody = sectionBody('CONTENT PIPELINE');
if (!/CONTENT WORK QUEUES/i.test(contentPipelineBody)) {
  fail('CONTENT PIPELINE must explain active work in business lanes, not a vague TEED UP list');
}
if (/^\s+TEED UP\b/im.test(contentPipelineBody)) {
  fail('CONTENT PIPELINE still uses vague TEED UP wording');
}
if (/#FEATURE_BACKLOG/i.test(contentPipelineBody)) {
  fail('CONTENT PIPELINE must not duplicate feature-backlog decisions; those belong in Feature Backlog');
}
if (/Decide \(approve \/ reject\).+backlog/i.test(contentPipelineBody)) {
  fail('CONTENT PIPELINE is mixing backlog approvals into the content work queue');
}

const shorts = readJson(`data/agent/shorts-proposals/${date}.json`);
if (!shorts || !Array.isArray(shorts.proposals)) {
  fail('shorts proposal JSON missing');
} else {
  if (shorts.proposals.length !== 10) fail(`shorts proposals has ${shorts.proposals.length}/10 items`);
  if (!shorts.signals_count || Number(shorts.signals_count.x || 0) <= 0) {
    fail('shorts proposals are not grounded in X trend research');
  }
  shorts.proposals.forEach((p, i) => {
    const missing = ['title', 'trend_hook', 'why', 'script', 'source_url'].filter((k) => !p[k]);
    if (missing.length) fail(`shorts proposal ${i + 1} missing ${missing.join(', ')}`);
    const proposalText = JSON.stringify(p);
    if (/open the source, pull one repeatable task|turns the thread into a practical workflow|not a model-release recap|The viewer gets one concrete AI workflow/i.test(proposalText)) {
      fail(`shorts proposal ${i + 1} contains generic fallback copy`);
    }
    if (/x\.com\/[^ ]+\/status/i.test(String(p.title || ''))) {
      fail(`shorts proposal ${i + 1} title is a raw source URL`);
    }
    if (!/^https:\/\/x\.com\//i.test(String(p.source_url || ''))) {
      fail(`shorts proposal ${i + 1} source is not an X post`);
    }
    if (!/\b(X|views|likes|replies|thread|viral|trending)\b/i.test(String(p.trend_hook || ''))) {
      fail(`shorts proposal ${i + 1} does not explain why it is viral/trending on X`);
    }
  });
}
const shortsMdItems = parseNumberedItems(sectionBody("TODAY'S 10 SHORTS PROPOSALS"));
if (shortsMdItems.length !== 10) fail(`shorts markdown has ${shortsMdItems.length}/10 items`);

const timestampRe = /\b\d{1,2}:\d{2}(?::\d{2})?\s*[-–]\s*\d{1,2}:\d{2}(?::\d{2})?\b/;
const viral = readJson(`data/agent/viral-tech-clips/${date}.json`);
if (!viral || !Array.isArray(viral.proposals)) {
  fail('viral tech clip JSON missing');
} else {
  if (viral.proposals.length < 3) fail(`viral tech clips has ${viral.proposals.length}/3 timestamped items`);
  const viralIds = new Set();
  viral.proposals.forEach((p, i) => {
    const missing = ['source_url', 'clip_url', 'embed_url', 'source_title', 'speaker', 'insight', 'approx_timestamp', 'short_description', 'virality_signal']
      .filter((k) => !p[k]);
    if (missing.length) fail(`viral clip ${i + 1} missing ${missing.join(', ')}`);
    if (p.id && viralIds.has(p.id)) fail(`viral clip ${i + 1} duplicates id ${p.id}`);
    if (p.id) viralIds.add(p.id);
    if (!/youtu\.?be|youtube\.com|vimeo\.com|x\.com|twitter\.com/i.test(String(p.clip_url || p.source_url || ''))) {
      fail(`viral clip ${i + 1} does not link to a source video`);
    }
    if (!timestampRe.test(String(p.approx_timestamp || ''))) fail(`viral clip ${i + 1} has no timestamp window`);
    if (/unknown|operator must|must scrub|verify speaker|verify timestamp|no description/i.test(JSON.stringify(p))) {
      fail(`viral clip ${i + 1} contains placeholder language`);
    }
  });
}
const viralMdBody = sectionBody('VIRAL TECH CLIP PROPOSALS');
const viralPreviewLines = (viralMdBody.match(/Preview clip:/g) || []).length;
if (viral && Array.isArray(viral.proposals) && viralPreviewLines < Math.min(viral.proposals.length, 3)) {
  fail(`viral clip markdown has ${viralPreviewLines}/${Math.min(viral.proposals.length, 3)} preview links`);
}

const mortgage = readJson(`data/agent/mortgage-rates/${date}.json`);
if (!mortgage || !Array.isArray(mortgage.indexes)) {
  fail('mortgage-rate JSON missing');
} else {
  const populated = mortgage.indexes.filter((ix) => ix.today != null);
  if (populated.length < 2) fail(`mortgage rates has only ${populated.length} populated sources`);
  for (const id of ['blend_of_indexes', 'fhlmc_pmms', 'mortgage_news_daily']) {
    const ix = mortgage.indexes.find((row) => row.id === id);
    if (!ix || ix.today == null) {
      fail(`mortgage ${id} missing today's rate`);
      continue;
    }
    if (ix.dod == null) fail(`mortgage ${id} missing day-over-day delta`);
    if (ix.wow == null) fail(`mortgage ${id} missing week-over-week delta`);
    if (ix.mom == null) fail(`mortgage ${id} missing month-over-month delta`);
  }
}

const mortgageBody = sectionBody('MORTGAGE RATE INDEXES');
if (!/\|\s*Index\s*\|\s*Today\s*\|\s*DoD\s*\|\s*WoW\s*\|\s*MoM\s*\|/i.test(mortgageBody)) {
  fail('mortgage rate markdown missing week-over-week column');
}
if (/\bn\/a\b/i.test(mortgageBody)) {
  fail('mortgage rate markdown uses n/a instead of a real delta or named blocker');
}

const aws = readJson(`data/agent/aws-costs-${date}.json`);
if (aws && aws.profiles) {
  const verifiedTotal = Object.values(aws.profiles).reduce((sum, profile) => {
    if (!profile || profile.ok === false) return sum;
    return sum + Object.values(profile.services || {}).reduce((a, b) => a + Number(b || 0), 0);
  }, 0);
  const awsBody = sectionBody('AWS COSTS');
  const titleTotal = (md.match(/^AWS COSTS \([^$]*\$([\d.]+)\s+total/im) || [])[1];
  if (!titleTotal) {
    fail('AWS costs title missing verified total');
  } else if (Math.abs(Number(titleTotal) - verifiedTotal) > 0.75) {
    fail(`AWS costs title total $${titleTotal} does not match verified accessible total $${verifiedTotal.toFixed(2)}`);
  }
  if (Object.values(aws.profiles).some((profile) => profile && profile.ok === false) && !/verified accessible AWS spend/i.test(awsBody)) {
    fail('AWS costs with inaccessible account must say the total is verified accessible spend only');
  }
  if (!/Snapshot:/i.test(awsBody) || !/older or partial snapshot/i.test(awsBody)) {
    fail('AWS costs must name the snapshot time so totals do not appear to flip between runs');
  }
  // Snack Dude account has Cost Explorer disabled at the account level (a
  // one-time AWS-console toggle without a programmatic enable API). The aws
  // cost section surfaces an estimate inline ($1-3/mo serverless), so this
  // is not a daily-briefing blocker. Removed the requirement that it appear
  // in top blockers 2026-05-11 per Luke feedback.
}

const jsonMode = process.argv.includes('--json');

if (failures.length) {
  if (jsonMode) {
    console.log(JSON.stringify({ ok: false, date, failures }, null, 2));
    process.exit(1);
  }
  console.error(`[briefing-quality] ${failures.length} failure(s) for ${date}`);
  for (const f of failures) console.error(`- ${f}`);
  process.exit(1);
}

if (jsonMode) {
  console.log(JSON.stringify({ ok: true, date, failures: [] }, null, 2));
  process.exit(0);
}

console.log(`[briefing-quality] PASS ${date}`);
