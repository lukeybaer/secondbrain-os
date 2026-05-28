#!/usr/bin/env node
// Fetch the current mortgage-rate index snapshot for the daily briefing.
//
// 2026-05-08 Luke dispatch (PM revision): the dashboard tile must show
// industry-standard rate INDEX SOURCES, not 4 mortgage product types. The
// canonical names are:
//
//   1. Blend of Indexes  - average of the 2 populated source indexes below
//   2. FHLMC PMMS        - Freddie Mac Primary Mortgage Market Survey
//                          (weekly Thursday lender survey, public)
//   3. Mortgage News Daily - daily lender survey (RSS, public)
//
// Each entry is a 30-year fixed conforming rate. Output JSON shape:
//   { date, generatedAt, source, indexes: [
//       { id, label, today, dod, wow, mom, source, link }, ...
//   ]}
//
// History file at data/agent/mortgage-rates/history.jsonl rolls forward each
// day so DoD / WoW / MoM deltas come from real prior readings, never
// fabricated.

const fs = require('fs');
const path = require('path');
const https = require('https');

const REPO_ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(REPO_ROOT, 'data', 'agent', 'mortgage-rates');
const HISTORY_FILE = path.join(OUT_DIR, 'history.jsonl');

const INDEX_DEFS = [
  {
    id: 'blend_of_indexes',
    label: 'Blend of Indexes',
    link: 'https://www.mortgagenewsdaily.com/mortgage-rates',
    note: 'Average of FHLMC PMMS + MND.',
  },
  {
    id: 'fhlmc_pmms',
    label: 'FHLMC PMMS',
    link: 'https://www.freddiemac.com/pmms',
    note: 'Freddie Mac Primary Mortgage Market Survey, weekly Thursday lender survey.',
  },
  {
    id: 'mortgage_news_daily',
    label: 'Mortgage News Daily',
    link: 'https://www.mortgagenewsdaily.com/mortgage-rates',
    note: 'Daily lender survey aggregated by Mortgage News Daily.',
  },
];

function argValue(name) {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  const pref = `${name}=`;
  const hit = process.argv.find((a) => a.startsWith(pref));
  return hit ? hit.slice(pref.length) : null;
}

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { 'user-agent': 'secondbrain-briefing/1.0' } },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return fetchUrl(res.headers.location).then(resolve, reject);
        }
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ statusCode: res.statusCode, body }));
      },
    );
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(new Error('timeout')); });
  });
}

// Pull today's MND 30yr fixed rate from the RSS description text.
function parseRateFromRssDescription(rss) {
  const m = rss.match(/<description><!\[CDATA\[([^\]]+)\]\]><\/description>/i)
    || rss.match(/<description>([^<]+)<\/description>/i);
  if (!m) return null;
  const text = m[1].replace(/<[^>]+>/g, ' ');
  const rm = text.match(/\b([5-9]\.\d{2})\s*%/);
  return rm ? parseFloat(rm[1]) : null;
}

// Pull MND HTML rate snapshot as a fallback (more reliable when RSS lags).
function parseTodayRatesFromMnd(html) {
  // Returns { mortgage_news_daily: <rate> } when recognized, else {}.
  const out = {};
  const m = html.match(/30 ?Year ?Fixed[^<]*<\/[^>]+>[^<]*<[^>]+>\s*(\d\.\d{2})/i);
  if (m) out.mortgage_news_daily = parseFloat(m[1]);
  return out;
}

function extractJsonAfter(html, marker) {
  const markerIdx = html.indexOf(marker);
  if (markerIdx < 0) return null;
  const start = html.indexOf('{', markerIdx);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < html.length; i += 1) {
    const ch = html[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }
  return null;
}

function parseMndChartSeries(html) {
  try {
    const raw = extractJsonAfter(html, 'var chartData =');
    if (!raw) return [];
    const chart = JSON.parse(raw);
    const series = (chart.chartSeries || []).find((s) => /30\s*Yr\.?\s*Fixed/i.test(s.dataType?.description || s.dataType?.shortName || ''));
    return (series?.data || [])
      .map((row) => ({ date: String(row.d || '').slice(0, 10), value: Number(row.v) }))
      .filter((row) => row.date && Number.isFinite(row.value))
      .sort((a, b) => a.date.localeCompare(b.date));
  } catch {
    return [];
  }
}

function parseFredCsv(csv) {
  return String(csv || '')
    .split(/\r?\n/)
    .slice(1)
    .map((line) => {
      const [date, value] = line.split(',');
      const num = Number(value);
      return { date, value: num };
    })
    .filter((row) => row.date && Number.isFinite(row.value))
    .sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchFredSeries(seriesId, startDate, endDate) {
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(seriesId)}&cosd=${encodeURIComponent(startDate)}&coed=${encodeURIComponent(endDate)}`;
  if (typeof fetch === 'function') {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const r = await fetch(url, { headers: { 'user-agent': 'secondbrain-briefing/1.0' }, signal: controller.signal });
      if (!r.ok) return [];
      return parseFredCsv(await r.text());
    } finally {
      clearTimeout(timer);
    }
  }
  const r = await fetchUrl(url);
  if (r.statusCode !== 200) return [];
  return parseFredCsv(r.body);
}

function latestOnOrBefore(series, date) {
  let best = null;
  for (const row of series || []) {
    if (row.date <= date) best = row;
    else break;
  }
  return best;
}

function rateAtCalendarDate(series, date) {
  const row = latestOnOrBefore(series, date);
  return row ? row.value : null;
}

function sourceDeltas(series, currentDate) {
  const current = latestOnOrBefore(series, currentDate);
  if (!current) return { today: null, effectiveDate: null, dodPrior: null, wowPrior: null, momPrior: null };
  return {
    today: current.value,
    effectiveDate: current.date,
    dodPrior: rateAtCalendarDate(series, addDays(current.date, -1)),
    wowPrior: rateAtCalendarDate(series, addDays(current.date, -7)),
    momPrior: rateAtCalendarDate(series, addDays(current.date, -30)),
  };
}

// Scrape Freddie Mac PMMS page for the most recent 30-year fixed reading.
function parseFhlmcPmmsRate(html) {
  // PMMS HTML carries a "30-Year Fixed Rate Mortgage" section followed by a
  // percentage. Be tolerant of layout changes by accepting any 5-9% number
  // appearing within ~400 chars after the label.
  const idx = html.search(/30[\s-]?year fixed[\s-]?rate mortgage/i);
  if (idx < 0) return null;
  const window = html.slice(idx, idx + 400);
  const m = window.match(/\b([5-9]\.\d{2})\s*%/);
  return m ? parseFloat(m[1]) : null;
}

function loadHistory() {
  if (!fs.existsSync(HISTORY_FILE)) return [];
  return fs
    .readFileSync(HISTORY_FILE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function findHistoricalRate(history, indexId, daysAgo) {
  const target = new Date(Date.now() - daysAgo * 24 * 3600 * 1000)
    .toISOString()
    .slice(0, 10);
  const sorted = history
    .filter((h) => h.date && h[indexId] != null)
    .sort((a, b) => a.date.localeCompare(b.date));
  let best = null;
  for (const h of sorted) {
    if (h.date <= target) best = h;
    else break;
  }
  return best ? best[indexId] : null;
}

function fmtDelta(today, prior) {
  if (today == null || prior == null) return null;
  const d = today - prior;
  const sign = d > 0 ? '+' : '';
  return `${sign}${d.toFixed(2)}`;
}

async function main() {
  // Use Chicago time for the file date so the dashboard's briefing-date
  // lookup (which keys off the briefing markdown filename, also CT-based)
  // matches. UTC dates lag by 5-6h and would write tomorrow's file when
  // run after 6-7 PM CT.
  const date = argValue('--date') || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const todayRates = {};
  const priorDayRates = {};
  const priorWeekRates = {};
  const priorMonthRates = {};
  const effectiveDates = {};

  // Mortgage News Daily, HTML primary, RSS fallback.
  let mndHtml = null;
  try {
    const html = await fetchUrl('https://www.mortgagenewsdaily.com/mortgage-rates');
    if (html.statusCode === 200) {
      mndHtml = html.body;
      const mndSeries = parseMndChartSeries(mndHtml);
      const deltas = sourceDeltas(mndSeries, date);
      if (deltas.today != null) {
        todayRates.mortgage_news_daily = deltas.today;
        priorDayRates.mortgage_news_daily = deltas.dodPrior;
        priorWeekRates.mortgage_news_daily = deltas.wowPrior;
        priorMonthRates.mortgage_news_daily = deltas.momPrior;
        effectiveDates.mortgage_news_daily = deltas.effectiveDate;
      } else {
        Object.assign(todayRates, parseTodayRatesFromMnd(html.body));
      }
    }
  } catch (e) {
    console.warn('[mortgage-rates] MND HTML scrape failed:', e.message);
  }
  if (todayRates.mortgage_news_daily == null) {
    try {
      const rss = await fetchUrl('https://www.mortgagenewsdaily.com/rss/rates');
      if (rss.statusCode === 200) {
        const rate = parseRateFromRssDescription(rss.body);
        if (rate != null) todayRates.mortgage_news_daily = rate;
      }
    } catch (e) {
      console.warn('[mortgage-rates] MND RSS fallback failed:', e.message);
    }
  }

  // Freddie Mac PMMS, public weekly survey. Use FRED's public CSV mirror so
  // day/month deltas are computed from dated observations instead of page text.
  try {
    const fred = await fetchFredSeries('MORTGAGE30US', addDays(date, -70), date);
    const deltas = sourceDeltas(fred, date);
    if (deltas.today != null) {
      todayRates.fhlmc_pmms = deltas.today;
      // PMMS is weekly, so a non-publication day carries the latest official
      // survey value. Calendar DoD is therefore unchanged until a new survey.
      priorDayRates.fhlmc_pmms = deltas.today;
      priorWeekRates.fhlmc_pmms = deltas.wowPrior;
      priorMonthRates.fhlmc_pmms = deltas.momPrior;
      effectiveDates.fhlmc_pmms = deltas.effectiveDate;
    } else {
      const r = await fetchUrl('https://www.freddiemac.com/pmms');
      if (r.statusCode === 200) {
        const rate = parseFhlmcPmmsRate(r.body);
        if (rate != null) todayRates.fhlmc_pmms = rate;
      }
    }
  } catch (e) {
    console.warn('[mortgage-rates] FHLMC PMMS scrape failed:', e.message);
  }

  // Blend of Indexes: average of the populated source indexes.
  const populatedSources = ['fhlmc_pmms', 'mortgage_news_daily']
    .map((k) => todayRates[k])
    .filter((v) => v != null);
  if (populatedSources.length > 0) {
    const avg = populatedSources.reduce((a, b) => a + b, 0) / populatedSources.length;
    todayRates.blend_of_indexes = parseFloat(avg.toFixed(2));
  }
  const blendDaySources = ['fhlmc_pmms', 'mortgage_news_daily']
    .map((k) => priorDayRates[k])
    .filter((v) => v != null);
  if (blendDaySources.length > 0) {
    priorDayRates.blend_of_indexes = parseFloat((blendDaySources.reduce((a, b) => a + b, 0) / blendDaySources.length).toFixed(2));
  }
  const blendWeekSources = ['fhlmc_pmms', 'mortgage_news_daily']
    .map((k) => priorWeekRates[k])
    .filter((v) => v != null);
  if (blendWeekSources.length > 0) {
    priorWeekRates.blend_of_indexes = parseFloat((blendWeekSources.reduce((a, b) => a + b, 0) / blendWeekSources.length).toFixed(2));
  }
  const blendMonthSources = ['fhlmc_pmms', 'mortgage_news_daily']
    .map((k) => priorMonthRates[k])
    .filter((v) => v != null);
  if (blendMonthSources.length > 0) {
    priorMonthRates.blend_of_indexes = parseFloat((blendMonthSources.reduce((a, b) => a + b, 0) / blendMonthSources.length).toFixed(2));
  }

  const history = loadHistory();
  const indexes = INDEX_DEFS.map((def) => {
    const today = todayRates[def.id] != null
      ? todayRates[def.id]
      : findHistoricalRate(history, def.id, 0);
    const dod = priorDayRates[def.id] != null ? priorDayRates[def.id] : findHistoricalRate(history, def.id, 1);
    const wow = priorWeekRates[def.id] != null ? priorWeekRates[def.id] : findHistoricalRate(history, def.id, 7);
    const mom = priorMonthRates[def.id] != null ? priorMonthRates[def.id] : findHistoricalRate(history, def.id, 30);
    return {
      id: def.id,
      label: def.label,
      today,
      dod: fmtDelta(today, dod),
      wow: fmtDelta(today, wow),
      mom: fmtDelta(today, mom),
      source: def.link,
      note: def.note,
      effectiveDate: effectiveDates[def.id] || date,
    };
  });

  const snapshot = {
    date,
    generatedAt: new Date().toISOString(),
    source: 'multi-source: FHLMC PMMS + MND + computed Blend',
    indexes,
  };
  fs.writeFileSync(path.join(OUT_DIR, `${date}.json`), JSON.stringify(snapshot, null, 2));

  // Append today's reading into the rolling history file so tomorrow's
  // DoD delta has a real number to compare against.
  const histRow = { date };
  for (const ix of indexes) if (ix.today != null) histRow[ix.id] = ix.today;
  if (Object.keys(histRow).length > 1) {
    fs.appendFileSync(HISTORY_FILE, JSON.stringify(histRow) + '\n');
  }

  console.log(
    `[mortgage-rates] wrote ${path.join(OUT_DIR, date + '.json')} ` +
    `(${Object.keys(todayRates).length} of ${INDEX_DEFS.length} indexes populated from sources, ` +
    `${indexes.filter((i) => i.today != null).length} total after history fallback)`,
  );
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exitCode = 1; });
}

module.exports = {
  parseTodayRatesFromMnd,
  parseRateFromRssDescription,
  parseFhlmcPmmsRate,
  loadHistory,
  findHistoricalRate,
  fmtDelta,
  INDEX_DEFS,
};
