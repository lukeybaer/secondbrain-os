#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { defaultDataDir } = require('./youtube-video-stats.js');

const POINT_URL = (process.env.WEATHER_POINT_URL || 'https://api.weather.gov/points/LAT,LON');
const USER_AGENT = 'SecondBrain briefing weather (example.com)';

function chicagoDate(value) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date(value));
}

function chicagoTime(value) {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' }).format(new Date(value));
}

function chicagoReportWindowStart(date) {
  const match = String(date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error('Briefing date must be YYYY-MM-DD');
  const target = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: 8,
  };
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  });
  let candidate = Date.UTC(target.year, target.month - 1, target.day, target.hour);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(candidate))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]));
    const rendered = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour);
    candidate += Date.UTC(target.year, target.month - 1, target.day, target.hour) - rendered;
  }
  return candidate;
}

function isoDurationHours(value) {
  const match = String(value || '').match(/^P(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i);
  if (!match) return Number.NaN;
  return Number(match[1] || 0) * 168 + Number(match[2] || 0) * 24
    + Number(match[3] || 0) + Number(match[4] || 0) / 60 + Number(match[5] || 0) / 3600;
}

function precipitationRateByHour(grid) {
  const rows = grid && grid.properties && grid.properties.quantitativePrecipitation;
  if (!rows || rows.uom !== 'wmoUnit:mm' || !Array.isArray(rows.values)) {
    const unavailable = new Map();
    unavailable.sourceStatus = 'unavailable';
    return unavailable;
  }
  const rates = new Map();
  rates.sourceStatus = 'nws-grid';
  for (const row of rows.values) {
    const [startText, durationText] = String(row && row.validTime || '').split('/');
    const startMs = Date.parse(startText);
    const durationHours = isoDurationHours(durationText);
    const millimeters = row && row.value != null ? Number(row.value) : Number.NaN;
    if (!Number.isFinite(startMs)) continue;
    if (!Number.isFinite(durationHours) || durationHours <= 0) {
      rates.sourceStatus = 'partial-malformed';
      continue;
    }
    const totalInches = Number.isFinite(millimeters) && millimeters >= 0 ? millimeters / 25.4 : null;
    for (let hour = 0; hour < Math.ceil(durationHours); hour += 1) {
      rates.set(startMs + hour * 60 * 60 * 1000, {
        totalInches,
        intervalHours: durationHours,
        intervalStart: new Date(startMs).toISOString(),
      });
    }
  }
  return rates;
}

function forecastClauses(periods) {
  return periods
    .flatMap((period) => `${period.shortForecast || period.short_forecast || ''}. ${period.detailedForecast || period.detailed_forecast || ''}`.toLowerCase().split(/[.!?;]/))
    .map((clause) => clause.trim())
    .filter(Boolean);
}

function clauseIsNegated(clause, terms) {
  const joined = terms.map((term) => term.source).join('|');
  return new RegExp(`\\bno\\b[^,]{0,50}(?:${joined})`).test(clause)
    || new RegExp(`(?:${joined})[^,]{0,50}\\bnot\\s+expected\\b`).test(clause);
}

function precipitationKinds(periods) {
  const clauses = forecastClauses(periods);
  const positiveMention = (terms) => clauses.some((clause) => {
    if (!terms.some((term) => term.test(clause))) return false;
    if (clauseIsNegated(clause, terms)) return false;
    return true;
  });
  return {
    rain: positiveMention([/\brain\b/, /\bshower/, /\bthunderstorm/, /\bdrizzle/]),
    snow: positiveMention([/\bsnow\b/, /\bflurr/, /\bsleet\b/, /\bwintry\b/]),
    hail: positiveMention([/\bhail\b/]),
  };
}

function precipitationIntensity(periods, kind) {
  const kindTerms = kind === 'hail'
    ? [/\bhail\b/]
    : kind === 'snow'
      ? [/\bsnow\b/, /\bflurr/, /\bsleet\b/, /\bwintry\b/]
      : [/\brain\b/, /\bshower/, /\bthunderstorm/, /\bdrizzle/];
  const clauses = forecastClauses(periods)
    .filter((clause) => kindTerms.some((term) => term.test(clause)) && !clauseIsNegated(clause, kindTerms));
  if (clauses.some((clause) => /\b(?:heavy|torrential|severe)\b/.test(clause))) return 'heavy';
  if (clauses.some((clause) => /\b(?:light|drizzle|sprinkle)\b/.test(clause))) return 'light';
  return '';
}

function summarizeReportDays(hours, reportWindowStartMs) {
  return [0, 1].map((index) => {
    const startMs = reportWindowStartMs + index * 24 * 60 * 60 * 1000;
    const endMs = startMs + 24 * 60 * 60 * 1000;
    const rows = hours.filter((hour) => {
      const atMs = Date.parse(hour.at);
      return Number.isFinite(atMs) && atMs >= startMs && atMs < endMs;
    });
    if (!rows.length) throw new Error('National Weather Service did not cover both report-day weather halves');
    const low = Math.min(...rows.map((period) => Number(period.temperature)));
    const high = Math.max(...rows.map((period) => Number(period.temperature)));
    const lowRow = rows.find((period) => Number(period.temperature) === low);
    const highRow = rows.find((period) => Number(period.temperature) === high);
    return {
      label: index === 0 ? 'Next 24 hours' : 'Following 24 hours',
      starts_at: new Date(startMs).toISOString(),
      ends_at: new Date(endMs - 60 * 60 * 1000).toISOString(),
      low,
      low_at: chicagoTime(lowRow.at),
      low_at_iso: lowRow.at,
      high,
      high_at: chicagoTime(highRow.at),
      high_at_iso: highRow.at,
      precipitation: precipitationKinds(rows),
    };
  });
}

function sparkline(values) {
  const bars = '▁▂▃▄▅▆▇█';
  const min = Math.min(...values);
  const max = Math.max(...values);
  return values.map((value) => bars[max === min ? 3 : Math.round(((value - min) / (max - min)) * (bars.length - 1))]).join('');
}

function reportWindowSparkline(hours, reportWindowStartMs) {
  const inWindow = hours.filter((hour) => {
    const atMs = Date.parse(hour.at);
    return Number.isFinite(atMs) && atMs >= reportWindowStartMs && atMs < reportWindowStartMs + 48 * 60 * 60 * 1000;
  });
  if (!inWindow.length) throw new Error('National Weather Service hourly forecast does not overlap the report-day weather window');
  const encoded = sparkline(inWindow.map((hour) => Number(hour.temperature)));
  const bySlot = new Map();
  inWindow.forEach((hour, index) => {
    const elapsed = (Date.parse(hour.at) - reportWindowStartMs) / (60 * 60 * 1000);
    const slot = Math.round(elapsed);
    if (slot >= 0 && slot < 48 && Math.abs(elapsed - slot) <= 5 / 60) bySlot.set(slot, encoded[index]);
  });
  if (!bySlot.size) throw new Error('National Weather Service hourly forecast is not aligned to the report-day weather window');
  return Array.from({ length: 48 }, (_, index) => bySlot.get(index) || '·').join('');
}

function buildSnapshot({ date, now = new Date(), periods }) {
  const usable = (Array.isArray(periods) ? periods : [])
    .filter((period) => Number.isFinite(Number(period.temperature)) && Number.isFinite(Date.parse(period.startTime)))
    .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
  const reportWindowStartMs = chicagoReportWindowStart(date);
  const reportWindowEndMs = reportWindowStartMs + 48 * 60 * 60 * 1000;
  const reportWindow = reportWindowStartMs >= now.getTime()
    ? usable.filter((period) => Date.parse(period.startTime) >= reportWindowStartMs && Date.parse(period.startTime) < reportWindowEndMs)
    : [];
  const upcoming = (reportWindow.length >= 48
    ? reportWindow
    : usable.filter((period) => Date.parse(period.startTime) >= now.getTime()))
    .slice(0, 48);
  if (upcoming.length !== 48) {
    throw new Error(`National Weather Service returned ${upcoming.length} usable future hourly periods; 48 are required`);
  }
  for (let index = 1; index < upcoming.length; index += 1) {
    const priorMs = Date.parse(upcoming[index - 1].startTime);
    const currentMs = Date.parse(upcoming[index].startTime);
    if (currentMs - priorMs !== 60 * 60 * 1000) {
      throw new Error('National Weather Service hourly periods are not a contiguous one-hour sequence');
    }
  }
  if (upcoming.some((period) => !String(period.shortForecast || '').trim() && !String(period.detailedForecast || '').trim())) {
    throw new Error('National Weather Service returned an hourly period with no forecast text');
  }
  const hours = upcoming.map((period) => ({
    at: period.startTime,
    temperature: Number(period.temperature),
    short_forecast: String(period.shortForecast || ''),
    detailed_forecast: String(period.detailedForecast || ''),
    precipitation_probability: period.probabilityOfPrecipitation && period.probabilityOfPrecipitation.value != null
      && Number.isFinite(Number(period.probabilityOfPrecipitation.value))
      ? Math.max(0, Math.min(100, Number(period.probabilityOfPrecipitation.value)))
      : null,
    precipitation_interval_amount_in: period.precipitationAmountIn != null && Number.isFinite(Number(period.precipitationAmountIn))
      ? Math.max(0, Number(Number(period.precipitationAmountIn).toFixed(4)))
      : null,
    precipitation_interval_hours: period.precipitationIntervalHours != null && Number.isFinite(Number(period.precipitationIntervalHours))
      ? Number(period.precipitationIntervalHours)
      : null,
    precipitation_interval_start: period.precipitationIntervalStart || null,
  }));
  const days = summarizeReportDays(hours, reportWindowStartMs);
  return {
    schema_version: 1,
    date,
    generated_at: now.toISOString(),
    location: 'ExampleCo',
    report_window_start: new Date(reportWindowStartMs).toISOString(),
    window_alignment: reportWindow.length >= 48 ? 'report-day-8am' : 'late-run-future-fallback',
    hours,
    graph: reportWindowSparkline(hours, reportWindowStartMs),
    days,
    source: { kind: 'api.weather.gov-hourly-and-grid-forecast', point: POINT_URL },
  };
}

async function getJson(url, fetchFn) {
  const response = await fetchFn(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/geo+json' } });
  if (!response.ok) throw new Error(`National Weather Service returned ${response.status}`);
  return response.json();
}

function writeAtomic(dataDir, date, snapshot) {
  const dir = path.join(dataDir, 'agent', 'ExampleCo-weather');
  fs.mkdirSync(dir, { recursive: true });
  const body = `${JSON.stringify(snapshot, null, 2)}\n`;
  const writeOne = (destination) => {
    const temp = `${destination}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temp, body);
    fs.renameSync(temp, destination);
  };
  const destination = path.join(dir, `${date}.json`);
  writeOne(destination);
  writeOne(path.join(dir, 'latest.json'));
  return destination;
}

async function collectExampleCoWeather({ date, dataDir = defaultDataDir(), now = new Date(), fetchFn = fetch } = {}) {
  const point = await getJson(POINT_URL, fetchFn);
  const hourlyUrl = point && point.properties && point.properties.forecastHourly;
  const gridUrl = point && point.properties && point.properties.forecastGridData;
  if (!hourlyUrl) throw new Error('National Weather Service returned no hourly forecast URL');
  const hourly = await getJson(hourlyUrl, fetchFn);
  let precipitationRates = precipitationRateByHour(null);
  if (gridUrl) {
    try {
      precipitationRates = precipitationRateByHour(await getJson(gridUrl, fetchFn));
    } catch {
      precipitationRates = precipitationRateByHour(null);
    }
  }
  const periods = (hourly && hourly.properties && hourly.properties.periods || []).map((period) => {
    const quantitative = precipitationRates.get(Date.parse(period.startTime));
    return {
      ...period,
      precipitationAmountIn: quantitative ? quantitative.totalInches : null,
      precipitationIntervalHours: quantitative ? quantitative.intervalHours : null,
      precipitationIntervalStart: quantitative ? quantitative.intervalStart : null,
    };
  });
  const snapshot = buildSnapshot({ date, now, periods });
  snapshot.source.precipitation_amounts = precipitationRates.sourceStatus;
  if (snapshot.hours.length !== 48 || snapshot.days.length !== 2) throw new Error('National Weather Service returned less than two complete days of hourly forecast data');
  return { file: writeAtomic(dataDir, date, snapshot), snapshot };
}

async function main() {
  const dateIndex = process.argv.indexOf('--date');
  const dataIndex = process.argv.indexOf('--data-dir');
  const now = new Date();
  const date = dateIndex >= 0 ? process.argv[dateIndex + 1] : chicagoDate(now);
  const dataDir = dataIndex >= 0 ? process.argv[dataIndex + 1] : defaultDataDir();
  const result = await collectExampleCoWeather({ date, dataDir, now });
  process.stdout.write(`${JSON.stringify({ ok: true, file: result.file, hours: result.snapshot.hours.length })}\n`);
}

if (require.main === module) main().catch((error) => { console.error(`[ExampleCo-weather] ${error.message}`); process.exitCode = 1; });

module.exports = {
  POINT_URL,
  precipitationKinds,
  precipitationIntensity,
  sparkline,
  reportWindowSparkline,
  chicagoReportWindowStart,
  isoDurationHours,
  precipitationRateByHour,
  summarizeReportDays,
  buildSnapshot,
  collectExampleCoWeather,
};
