'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { legacySection } = require('./card-format.js');
const { POINT_URL, buildSnapshot, chicagoReportWindowStart } = require('../../ExampleCo-weather.js');

const CARD_ID = 'ExampleCo_weather';
const TITLE = 'ExampleCo 48-HOUR WEATHER';
const MAX_AGE_MS = 12 * 60 * 60 * 1000;

function intervalAmount(hour) {
  return hour && hour.precipitation_interval_amount_in != null
    ? hour.precipitation_interval_amount_in
    : hour && hour.precipitation_amount_in != null
      ? hour.precipitation_amount_in
      : null;
}

function normalizeSnapshot(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.hours)) return snapshot;
  const normalized = {
    ...snapshot,
    hours: snapshot.hours.map((hour) => {
      const legacyAmountOnly = hour && hour.precipitation_interval_amount_in == null
        && hour.precipitation_amount_in != null
        && (hour.precipitation_interval_hours == null || hour.precipitation_interval_start == null);
      return {
        ...hour,
        precipitation_interval_amount_in: legacyAmountOnly ? null : intervalAmount(hour),
      };
    }),
  };
  const legacyContract = normalized.source && normalized.source.kind === 'api.weather.gov-hourly-forecast'
    || !normalized.report_window_start
    || !normalized.window_alignment
    || !Array.isArray(normalized.days)
    || normalized.days.some((day) => !day || !day.low_at_iso || !day.high_at_iso);
  if (!legacyContract) return normalized;
  const generatedMs = Date.parse(String(normalized.generated_at || ''));
  const firstAtMs = Date.parse(String(normalized.hours[0] && normalized.hours[0].at || ''));
  const rebuilt = buildSnapshot({
    date: normalized.date,
    now: new Date(Math.min(generatedMs, firstAtMs)),
    periods: normalized.hours.map((hour) => ({
      startTime: hour.at,
      temperature: hour.temperature,
      shortForecast: hour.short_forecast,
      detailedForecast: hour.detailed_forecast,
      probabilityOfPrecipitation: { value: hour.precipitation_probability },
      precipitationAmountIn: hour.precipitation_interval_amount_in,
      precipitationIntervalHours: hour.precipitation_interval_hours,
      precipitationIntervalStart: hour.precipitation_interval_start,
    })),
  });
  return {
    ...rebuilt,
    generated_at: normalized.generated_at,
    source: { ...normalized.source, precipitation_amounts: 'legacy-receipt' },
  };
}

function validSnapshot(snapshot, date, now) {
  try { snapshot = normalizeSnapshot(snapshot); } catch { return false; }
  const generatedMs = Date.parse(String(snapshot && snapshot.generated_at || ''));
  const sourceKindValid = snapshot && snapshot.source && (snapshot.source.kind === 'api.weather.gov-hourly-and-grid-forecast'
    || (snapshot.source.kind === 'api.weather.gov-hourly-forecast' && snapshot.source.precipitation_amounts === 'legacy-receipt'));
  const amountSourceValid = snapshot && snapshot.source && (snapshot.source.precipitation_amounts == null
    || ['nws-grid', 'unavailable', 'partial-malformed', 'legacy-receipt'].includes(snapshot.source.precipitation_amounts));
  if (!snapshot || snapshot.schema_version !== 1 || snapshot.date !== date || snapshot.location !== 'ExampleCo'
    || !sourceKindValid || !amountSourceValid || snapshot.source.point !== POINT_URL
    || !Number.isFinite(generatedMs) || generatedMs > now.getTime() || now.getTime() - generatedMs > MAX_AGE_MS) return false;
  if (Date.parse(snapshot.report_window_start) !== chicagoReportWindowStart(date)) return false;
  if (!['report-day-8am', 'late-run-future-fallback'].includes(snapshot.window_alignment)) return false;
  if (!Array.isArray(snapshot.hours) || snapshot.hours.length !== 48 || typeof snapshot.graph !== 'string' || [...snapshot.graph].length !== 48) return false;
  for (let index = 0; index < snapshot.hours.length; index += 1) {
    const hour = snapshot.hours[index];
    const at = Date.parse(String(hour && hour.at || ''));
    if (!Number.isFinite(at) || !Number.isFinite(hour && hour.temperature)
      || typeof hour.short_forecast !== 'string' || typeof hour.detailed_forecast !== 'string'
      || !(hour.precipitation_probability == null || (Number.isFinite(hour.precipitation_probability) && hour.precipitation_probability >= 0 && hour.precipitation_probability <= 100))
      || !(hour.precipitation_interval_amount_in == null || (Number.isFinite(hour.precipitation_interval_amount_in) && hour.precipitation_interval_amount_in >= 0))
      || !(hour.precipitation_interval_hours == null || (Number.isFinite(hour.precipitation_interval_hours) && hour.precipitation_interval_hours > 0))
      || !(hour.precipitation_interval_start == null || Number.isFinite(Date.parse(hour.precipitation_interval_start)))
      || (!hour.short_forecast.trim() && !hour.detailed_forecast.trim())) return false;
    const hasAmount = hour.precipitation_interval_amount_in != null;
    const hasHours = hour.precipitation_interval_hours != null;
    const hasStart = hour.precipitation_interval_start != null;
    if (hasHours !== hasStart || (hasAmount && !hasHours)) return false;
    const elapsedHours = (at - Date.parse(snapshot.report_window_start)) / (60 * 60 * 1000);
    if (Math.abs(elapsedHours - Math.round(elapsedHours)) > 5 / 60) return false;
    if (index > 0 && at - Date.parse(snapshot.hours[index - 1].at) !== 60 * 60 * 1000) return false;
  }
  if (!Array.isArray(snapshot.days) || snapshot.days.length !== 2) return false;
  const daysValid = snapshot.days.every((day) => day
    && String(day.label || '').trim()
    && Number.isFinite(Date.parse(String(day.starts_at || '')))
    && Number.isFinite(Date.parse(String(day.ends_at || '')))
    && Number.isFinite(day.low)
    && Number.isFinite(day.high)
    && String(day.low_at || '').trim()
    && Number.isFinite(Date.parse(String(day.low_at_iso || '')))
    && String(day.high_at || '').trim()
    && Number.isFinite(Date.parse(String(day.high_at_iso || '')))
    && day.precipitation
    && ['rain', 'snow', 'hail'].every((kind) => typeof day.precipitation[kind] === 'boolean'));
  if (!daysValid) return false;
  try {
    const expected = buildSnapshot({
      date,
      now: new Date(generatedMs),
      periods: snapshot.hours.map((hour) => ({
        startTime: hour.at,
        temperature: hour.temperature,
        shortForecast: hour.short_forecast,
        detailedForecast: hour.detailed_forecast,
        probabilityOfPrecipitation: { value: hour.precipitation_probability },
        precipitationAmountIn: hour.precipitation_interval_amount_in,
        precipitationIntervalHours: hour.precipitation_interval_hours,
        precipitationIntervalStart: hour.precipitation_interval_start,
      })),
    });
    return snapshot.graph === expected.graph
      && JSON.stringify(snapshot.days) === JSON.stringify(expected.days)
      && snapshot.report_window_start === expected.report_window_start
      && snapshot.window_alignment === expected.window_alignment;
  } catch {
    return false;
  }
}

function buildExampleCoWeatherCard(dataDir, date, now = new Date()) {
  const file = path.join(dataDir, 'agent', 'ExampleCo-weather', 'latest.json');
  let snapshot = null;
  try { snapshot = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const valid = validSnapshot(snapshot, date, now);
  if (!valid) {
    const reason = snapshot ? 'the saved hourly forecast is stale or incomplete' : 'today’s hourly forecast receipt is missing';
    return { markdown: legacySection(TITLE, `Blocked: ${reason}.\nNeed: node scripts/ExampleCo-weather.js --date ${date}`), state: { id: CARD_ID, ok: false, reason } };
  }
  try { snapshot = normalizeSnapshot(snapshot); } catch {
    const reason = 'the saved hourly forecast could not be normalized';
    return { markdown: legacySection(TITLE, `Blocked: ${reason}.\nNeed: node scripts/ExampleCo-weather.js --date ${date}`), state: { id: CARD_ID, ok: false, reason } };
  }
  const yesNo = (value) => value ? 'yes' : 'no';
  const lines = [
    `Temperature graph (${snapshot.hours.length} hourly points): ${snapshot.graph}`,
    ...snapshot.days.map((day) => `${day.label}: low ${day.low}°F at ${day.low_at}; high ${day.high}°F at ${day.high_at}; rain ${yesNo(day.precipitation.rain)}, snow ${yesNo(day.precipitation.snow)}, hail ${yesNo(day.precipitation.hail)}.`),
    `As of: ${snapshot.generated_at}`,
    'Source: National Weather Service hourly forecast for ExampleCo.',
  ];
  return { markdown: legacySection(TITLE, lines.join('\n')), state: { id: CARD_ID, ok: true, ...snapshot } };
}

module.exports = { CARD_ID, TITLE, MAX_AGE_MS, intervalAmount, normalizeSnapshot, validSnapshot, buildExampleCoWeatherCard };
