'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { parseBriefingMarkdown } = require('./briefing-markdown-sections');

const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const EXCLUDED_NEWS_SECTION_RE = /\b(?:IMMIGRATION|COVID)\b/i;
const SECTION_SPEECH = {
  'AI & TECH NEWS': 'AI and tech news',
  'US NEWS': 'US news',
  'WORLD NEWS': 'World news',
  'MORTGAGE INDUSTRY NEWS': 'Mortgage industry news',
  'ExampleCo GROUP NEWS': 'ExampleCo group news',
};
const SECTION_ORDER = [
  /^AI\s*&\s*TECH NEWS\b/i,
  /^US NEWS\b/i,
  /^WORLD NEWS\b/i,
  /^MORTGAGE INDUSTRY NEWS\b/i,
  /^[A-Z0-9 .'&-]+GROUP NEWS\b/i,
];
const NEWS_READER_INTENT_RE =
  /\b(?:read|play|start|give|tell)\s+(?:me\s+)?(?:the\s+)?(?:latest\s+|morning\s+|briefing\s+)?(?:news|headlines)\b|\bnews[-\s]?reader\b|\bread\s+the\s+news\b|\bdirect\s+(?:capability|ability)\s+to\s+read\s+(?:the\s+)?(?:latest\s+)?news\b/i;

const readerSessions = new Map();

function stripCount(title) {
  return String(title || '')
    .replace(/\s*\(\d+\)\s*$/g, '')
    .trim();
}

function speechSectionTitle(title) {
  const base = stripCount(title).replace(/\s+/g, ' ').trim();
  const upper = base.toUpperCase();
  if (SECTION_SPEECH[upper]) return SECTION_SPEECH[upper];
  return base
    .replace(/&/g, 'and')
    .toLowerCase()
    .replace(/\bai\b/g, 'AI')
    .replace(/\bus\b/g, 'US');
}

function centralDate(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function repoRoot() {
  return path.resolve(__dirname, '..', '..');
}

function appDataDir(env = process.env) {
  if (env.APPDATA) return path.join(env.APPDATA, 'secondbrain', 'data');
  if (process.platform === 'win32') {
    return path.join(os.homedir(), 'AppData', 'Roaming', 'secondbrain', 'data');
  }
  return '';
}

function dataDirCandidates(env = process.env, cwd = process.cwd()) {
  const candidates = [
    env.SECONDBRAIN_DATA_DIR,
    '/opt/secondbrain/data',
    path.join(repoRoot(), 'data'),
    path.join(cwd || '', 'data'),
    appDataDir(env),
  ].filter(Boolean);
  return [...new Set(candidates.map((p) => path.resolve(p)))];
}

function briefingFileCandidates({ date = '', env = process.env, cwd = process.cwd() } = {}) {
  const out = [];
  const explicit = env.AMY_NEWS_READER_BRIEFING_FILE || env.SB_BRIEFING_MARKDOWN_PATH;
  if (explicit) out.push(path.resolve(explicit));

  for (const dataDir of dataDirCandidates(env, cwd)) {
    const dir = path.join(dataDir, 'briefings');
    if (date) {
      out.push(path.join(dir, `briefing-${date}.md`));
      continue;
    }
    let files = [];
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (/^briefing-\d{4}-\d{2}-\d{2}\.md$/.test(file)) out.push(path.join(dir, file));
    }
  }
  return [...new Set(out)];
}

function readLatestBriefing({ date = '', env = process.env, cwd = process.cwd() } = {}) {
  const explicit = env.AMY_NEWS_READER_BRIEFING_FILE || env.SB_BRIEFING_MARKDOWN_PATH;
  if (explicit) {
    const file = path.resolve(explicit);
    try {
      const m = path.basename(file).match(/^briefing-(\d{4}-\d{2}-\d{2})\.md$/);
      return {
        file,
        date: m ? m[1] : date,
        raw: fs.readFileSync(file, 'utf8'),
      };
    } catch {
      // Fall through to the normal runtime search.
    }
  }

  const candidates = briefingFileCandidates({ date, env, cwd })
    .map((file) => {
      try {
        const stat = fs.statSync(file);
        const m = path.basename(file).match(/^briefing-(\d{4}-\d{2}-\d{2})\.md$/);
        return { file, date: m ? m[1] : '', mtimeMs: stat.mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || b.mtimeMs - a.mtimeMs);

  const chosen = candidates[0];
  if (!chosen) return null;
  return {
    file: chosen.file,
    date: chosen.date,
    raw: fs.readFileSync(chosen.file, 'utf8'),
  };
}

function cleanTitle(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/\s+[|]\s+.*$/g, '')
    .trim();
}

function isMetadataLine(line) {
  const s = String(line || '').trim();
  if (!s) return false;
  if (/^(?:Source|Coverage|Shortfall|Source snapshot|Data refreshed):/i.test(s)) return true;
  if (/^https?:\/\//i.test(s)) return true;
  if (/^No source-backed stories are ready yet/i.test(s)) return true;
  if (/^The full article body was not accessible/i.test(s)) return true;
  if (/^[A-Z][A-Za-z0-9 .&'-]{1,90}\s+-\s+[^.?!]{2,80}$/.test(s)) return true;
  return !/[.?!]/.test(s) && s.length <= 120;
}

function ExampleCoraphText(lines) {
  return lines
    .map((line) => String(line || '').trim())
    .filter((line) => line && !isMetadataLine(line))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function articleExampleCoraphs(lines) {
  const body = [...(lines || [])];
  while (body.length && !body[0].trim()) body.shift();
  while (body.length && isMetadataLine(body[0])) body.shift();
  while (body.length && !body[0].trim()) body.shift();

  const paras = [];
  let cur = [];
  for (const line of body) {
    if (!String(line || '').trim()) {
      const text = ExampleCoraphText(cur);
      if (text) paras.push(text);
      cur = [];
      continue;
    }
    cur.push(line);
  }
  const last = ExampleCoraphText(cur);
  if (last) paras.push(last);
  return paras
    .filter((p) => p.length >= 60)
    .filter((p) => !/^The full article body was not accessible/i.test(p))
    .slice(0, 3);
}

function parseArticleBlocks(body) {
  const lines = String(body || '').split(/\r?\n/);
  const blocks = [];
  let cur = null;
  for (const line of lines) {
    const m = line.match(/^\s*(\d{1,2})\.\s+(.+?)\s*$/);
    if (m) {
      if (cur) blocks.push(cur);
      cur = { title: cleanTitle(m[2]), lines: [] };
      continue;
    }
    if (cur) cur.lines.push(line);
  }
  if (cur) blocks.push(cur);
  return blocks
    .map((block) => ({
      title: block.title,
      ExampleCoraphs: articleExampleCoraphs(block.lines),
    }))
    .filter((article) => article.title && article.ExampleCoraphs.length >= 3);
}

function sectionRank(title) {
  const t = stripCount(title);
  const idx = SECTION_ORDER.findIndex((re) => re.test(t));
  return idx === -1 ? 999 : idx;
}

function parseBriefingNewsForReader(raw) {
  const parsed = parseBriefingMarkdown(raw);
  const sections = [];
  for (const section of parsed.sections || []) {
    const title = stripCount(section.title);
    if (!/\bNEWS\b/i.test(title)) continue;
    if (EXCLUDED_NEWS_SECTION_RE.test(title)) continue;
    if (sectionRank(title) === 999) continue;
    const articles = parseArticleBlocks(section.body);
    if (!articles.length) continue;
    sections.push({
      title,
      spokenTitle: speechSectionTitle(title),
      articles,
      rank: sectionRank(title),
    });
  }
  return sections.sort((a, b) => a.rank - b.rank || a.title.localeCompare(b.title));
}

function loadBriefingNewsSequence(opts = {}) {
  const source = readLatestBriefing(opts);
  if (!source) {
    return {
      ok: false,
      reason: `No briefing markdown found for ${opts.date || 'the latest available date'}.`,
      sections: [],
    };
  }
  const sections = parseBriefingNewsForReader(source.raw);
  return {
    ok: sections.length > 0,
    reason: sections.length
      ? ''
      : 'No briefing news articles with three ExampleCoraphs are ready in the latest briefing.',
    source,
    sections,
  };
}

function normalizeAction(params = {}) {
  const raw = String(params.action || params.command || params.intent || 'start')
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .trim();
  if (['skip_section', 'next_section', 'section'].includes(raw)) return 'next_section';
  if (['skip', 'next', 'next_article', 'article'].includes(raw)) return 'next_article';
  if (['repeat', 'current', 'again'].includes(raw)) return 'current';
  if (['stop', 'end', 'cancel'].includes(raw)) return 'stop';
  return 'start';
}

function isBriefingNewsReaderIntentText(value) {
  return NEWS_READER_INTENT_RE.test(String(value || ''));
}

function cleanupSessions(nowMs = Date.now()) {
  for (const [key, session] of readerSessions.entries()) {
    if (!session || nowMs - session.updatedAtMs > SESSION_TTL_MS) readerSessions.delete(key);
  }
}

function callSessionKey(params = {}, callObj = {}) {
  return (
    String(params.session_id || params.sessionId || '').trim() ||
    String((callObj && callObj.id) || '').trim() ||
    'manual'
  );
}

function atEnd(session) {
  return !session || session.sectionIndex >= session.sections.length;
}

function advanceArticle(session) {
  if (!session) return;
  const previousSectionIndex = session.sectionIndex;
  session.articleIndex += 1;
  while (
    session.sectionIndex < session.sections.length &&
    session.articleIndex >= session.sections[session.sectionIndex].articles.length
  ) {
    session.sectionIndex += 1;
    session.articleIndex = 0;
  }
  if (session.sectionIndex !== previousSectionIndex) {
    session.lastSpokenSectionIndex = -1;
  }
}

function advanceSection(session) {
  if (!session) return;
  session.sectionIndex += 1;
  session.articleIndex = 0;
  session.lastSpokenSectionIndex = -1;
}

function currentSpeech(session) {
  if (atEnd(session)) return 'End of briefing news.';
  const section = session.sections[session.sectionIndex];
  const article = section.articles[session.articleIndex];
  const parts = [];
  if (session.lastSpokenSectionIndex !== session.sectionIndex) {
    parts.push(`${section.spokenTitle}.`);
    session.lastSpokenSectionIndex = session.sectionIndex;
  }
  parts.push(`${article.title}.`);
  parts.push(...article.ExampleCoraphs.slice(0, 3));
  return parts.join('\n\n');
}

function startSession(key, params = {}, opts = {}) {
  const date =
    params.date === 'today' || params.date === true
      ? centralDate(opts.now || new Date())
      : String(params.date || '').trim();
  const loaded = loadBriefingNewsSequence({ ...opts, date });
  if (!loaded.ok) return { error: loaded.reason };
  const session = {
    sections: loaded.sections,
    source: loaded.source,
    sectionIndex: 0,
    articleIndex: 0,
    lastSpokenSectionIndex: -1,
    updatedAtMs: Date.now(),
  };
  readerSessions.set(key, session);
  return { session };
}

function handleBriefingNewsReader(params = {}, callObj = {}, opts = {}) {
  cleanupSessions();
  const key = callSessionKey(params, callObj);
  const action = normalizeAction(params);
  if (action === 'stop') {
    readerSessions.delete(key);
    return 'Done.';
  }

  let session = readerSessions.get(key);
  if (!session || action === 'start' || params.reload === true) {
    const started = startSession(key, params, opts);
    if (started.error) return started.error;
    session = started.session;
  } else if (action === 'next_section') {
    advanceSection(session);
  } else if (action === 'next_article') {
    advanceArticle(session);
  }

  session.updatedAtMs = Date.now();
  return currentSpeech(session);
}

function resetBriefingNewsReaderSessions() {
  readerSessions.clear();
}

module.exports = {
  parseBriefingNewsForReader,
  parseArticleBlocks,
  loadBriefingNewsSequence,
  handleBriefingNewsReader,
  resetBriefingNewsReaderSessions,
  briefingFileCandidates,
  dataDirCandidates,
  isBriefingNewsReaderIntentText,
};
