'use strict';

const {
  chicagoReportWindowStart,
  precipitationIntensity,
  precipitationKinds,
} = require('../ExampleCo-weather.js');

const HOUR_MS = 60 * 60 * 1000;
const CT_HOUR = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago',
  hour: 'numeric',
});
const CT_HOUR_DAY = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago',
  weekday: 'short',
  hour: 'numeric',
});
const CT_HOUR_DAY_ZONE = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago',
  weekday: 'short',
  hour: 'numeric',
  timeZoneName: 'short',
});

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function weatherConditionKind(hour) {
  const kinds = precipitationKinds([hour || {}]);
  if (kinds.hail) return 'hail';
  if (kinds.snow) return 'snow';
  if (kinds.rain) return 'rain';
  return '';
}

function weatherPrecipitationDetail(hour) {
  const kind = weatherConditionKind(hour);
  if (!kind) return null;
  const amount = hour && hour.precipitation_interval_amount_in != null
    ? Number(hour.precipitation_interval_amount_in)
    : Number.NaN;
  const intervalHours = hour && hour.precipitation_interval_hours != null
    ? Number(hour.precipitation_interval_hours)
    : Number.NaN;
  const probability = hour && hour.precipitation_probability != null
    ? Number(hour.precipitation_probability)
    : Number.NaN;
  return {
    kind,
    intensity: precipitationIntensity([hour], kind),
    amount: Number.isFinite(amount) && amount >= 0 ? amount : null,
    intervalHours: Number.isFinite(intervalHours) && intervalHours > 0 ? intervalHours : null,
    intervalStart: hour && hour.precipitation_interval_start || null,
    probability: Number.isFinite(probability) && probability >= 0 && probability <= 100 ? probability : null,
  };
}

function weatherCurvePath(points) {
  if (!points.length) return '';
  let pathValue = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  for (let index = 1; index < points.length; index += 1) {
    const prior = points[index - 1];
    const current = points[index];
    const midX = ((prior.x + current.x) / 2).toFixed(1);
    pathValue += ` C ${midX} ${prior.y.toFixed(1)}, ${midX} ${current.y.toFixed(1)}, ${current.x.toFixed(1)} ${current.y.toFixed(1)}`;
  }
  return pathValue;
}

function nullPreservingMax(left, right) {
  const values = [left, right].filter((value) => value != null && Number.isFinite(value));
  return values.length ? Math.max(...values) : null;
}

function precipitationAmountLabel(amount, intervalHours, intervalStart) {
  if (amount == null || !(intervalHours > 0)) return 'amount unavailable';
  const value = amount === 0 ? '0.00' : amount < 0.01 ? '<0.01' : amount.toFixed(2);
  const duration = `${Number.isInteger(intervalHours) ? intervalHours : intervalHours.toFixed(1)}h`;
  const startMs = Date.parse(String(intervalStart || ''));
  const ending = Number.isFinite(startMs) ? ` ending ${CT_HOUR_DAY.format(new Date(startMs + intervalHours * HOUR_MS))}` : '';
  return `${value} in over ${duration}${ending}`;
}

function blockedWeatherHtml(message = 'Fresh 48-hour forecast pending.') {
  return `<section class="weather-hero weather-hero-blocked"><strong>ExampleCo weather unavailable</strong><span>${escapeHtml(message)}</span></section>`;
}

function weatherHeroHtml(weather, { detail = false } = {}) {
  if (!weather || weather.blocked || !Array.isArray(weather.hours) || weather.hours.length !== 48) {
    return blockedWeatherHtml();
  }
  let reportStartMs;
  try {
    reportStartMs = chicagoReportWindowStart(weather.date);
  } catch {
    return blockedWeatherHtml('The saved forecast does not declare a valid report date.');
  }
  if (Date.parse(String(weather.report_window_start || '')) !== reportStartMs) {
    return blockedWeatherHtml('The saved forecast does not declare the report-day 8:00 AM window.');
  }
  const reportEndMs = reportStartMs + 48 * HOUR_MS;
  const width = detail ? 980 : 560;
  const height = detail ? 300 : 190;
  const pad = detail ? { left: 48, right: 24, top: 26, bottom: 44 } : { left: 34, right: 14, top: 22, bottom: 34 };
  const chartW = width - pad.left - pad.right;
  const chartH = height - pad.top - pad.bottom;
  const visibleHours = weather.hours
    .map((hour) => ({ hour, atMs: Date.parse(String(hour && hour.at || '')) }))
    .filter((row) => Number.isFinite(row.atMs) && row.atMs >= reportStartMs && row.atMs < reportEndMs && Number.isFinite(Number(row.hour.temperature)));
  if (!visibleHours.length || !Array.isArray(weather.days) || weather.days.length !== 2) {
    return blockedWeatherHtml('The report-day 8:00 AM window is not covered by the saved forecast.');
  }
  const temps = visibleHours.map((row) => Number(row.hour.temperature));
  const low = Math.min(...temps);
  const high = Math.max(...temps);
  let yMin = Math.floor(low / 5) * 5;
  let yMax = Math.ceil(high / 5) * 5;
  if (yMin === yMax) { yMin -= 5; yMax += 5; }
  const spread = yMax - yMin;
  const xForMs = (value) => pad.left + ((value - reportStartMs) / (reportEndMs - reportStartMs)) * chartW;
  const points = visibleHours.map((row) => ({
    x: xForMs(row.atMs),
    y: pad.top + ((yMax - Number(row.hour.temperature)) / spread) * chartH,
    temperature: Number(row.hour.temperature),
    atMs: row.atMs,
    hour: row.hour,
  }));
  const pointSegments = [];
  points.forEach((point) => {
    const activeSegment = pointSegments[pointSegments.length - 1];
    if (!activeSegment || point.atMs - activeSegment[activeSegment.length - 1].atMs > HOUR_MS + 5 * 60 * 1000) {
      pointSegments.push([point]);
    } else {
      activeSegment.push(point);
    }
  });
  const linePath = pointSegments.map(weatherCurvePath).join(' ');
  const areaPath = pointSegments.map((segment) => {
    const segmentPath = weatherCurvePath(segment);
    const lastPoint = segment[segment.length - 1];
    return `${segmentPath} L ${lastPoint.x.toFixed(1)} ${(pad.top + chartH).toFixed(1)} L ${segment[0].x.toFixed(1)} ${(pad.top + chartH).toFixed(1)} Z`;
  }).join(' ');
  const extrema = weather.days.flatMap((day) => {
    const lowPoint = points.find((point) => point.atMs === Date.parse(String(day.low_at_iso || '')));
    const highPoint = points.find((point) => point.atMs === Date.parse(String(day.high_at_iso || '')));
    return [
      lowPoint && { ...lowPoint, label: `${day.low}° · ${day.low_at}`, kind: 'low' },
      highPoint && { ...highPoint, label: `${day.high}° · ${day.high_at}`, kind: 'high' },
    ].filter(Boolean);
  });
  const conditionRuns = [];
  let active = null;
  points.forEach((point) => {
    const detailRow = weatherPrecipitationDetail(point.hour);
    if (!detailRow) { active = null; return; }
    if (!active || active.kind !== detailRow.kind || active.intensity !== detailRow.intensity
      || active.intervalStart !== detailRow.intervalStart || active.endMs !== point.atMs - HOUR_MS) {
      active = { ...detailRow, startMs: point.atMs, endMs: point.atMs };
      conditionRuns.push(active);
    } else {
      active.endMs = point.atMs;
      active.amount = nullPreservingMax(active.amount, detailRow.amount);
      active.intervalHours = nullPreservingMax(active.intervalHours, detailRow.intervalHours);
      active.probability = nullPreservingMax(active.probability, detailRow.probability);
    }
  });
  const bands = conditionRuns.map((run) => {
    const x = xForMs(Math.max(reportStartMs, run.startMs));
    const endX = xForMs(Math.min(reportEndMs, run.endMs + HOUR_MS));
    const bandWidth = Math.max(5, endX - x);
    const amount = precipitationAmountLabel(run.amount, run.intervalHours, run.intervalStart);
    const probability = run.probability != null ? `${Math.round(run.probability)}% peak` : '';
    const qualifiers = [probability, amount].filter(Boolean).join(' · ');
    const label = `${run.intensity ? `${run.intensity} ` : ''}${run.kind}${qualifiers ? ` · ${qualifiers}` : ''}`;
    const opacityBasis = run.probability == null ? 20 : run.probability;
    const opacity = Math.min(.42, .16 + opacityBasis / 500);
    const shortLabel = `${run.intensity ? `${run.intensity} ` : ''}${run.kind}${probability ? ` ${probability}` : ''}`;
    const visibleLabel = shortLabel.length * 5.2 <= bandWidth - 6 ? shortLabel : run.kind;
    return `<g class="weather-precip-period"><rect class="weather-band weather-band-${run.kind}" x="${x.toFixed(1)}" y="${pad.top}" width="${bandWidth.toFixed(1)}" height="${chartH}" rx="4" opacity="${opacity.toFixed(2)}"><title>${escapeHtml(label)}</title></rect><rect class="weather-precip-ribbon weather-band-${run.kind}" x="${x.toFixed(1)}" y="${pad.top}" width="${bandWidth.toFixed(1)}" height="7" rx="3"></rect>${bandWidth >= 24 ? `<text class="weather-band-label" x="${(x + bandWidth / 2).toFixed(1)}" y="${(pad.top + 18).toFixed(1)}" text-anchor="middle">${escapeHtml(visibleLabel)}</text>` : ''}</g>`;
  }).join('');
  const markers = extrema.map((point) => {
    const above = point.kind === 'high';
    const labelY = Math.max(12, Math.min(height - 8, point.y + (above ? -10 : 18)));
    return `<g class="weather-extreme weather-extreme-${point.kind}"><circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="4.5"></circle><text x="${point.x.toFixed(1)}" y="${labelY.toFixed(1)}" text-anchor="middle">${escapeHtml(point.label)}</text></g>`;
  }).join('');
  // The hover layer sits above the precipitation bands, so a wet hour carries
  // its own chance and amount in the readout instead of the band's <title>.
  const hourLabels = points.map((point) => CT_HOUR_DAY.format(new Date(point.atMs)));
  // Each zone covers only its own hour, so a missing-temperature gap stays
  // inactive instead of showing a neighbor's reading.
  const halfHourWidth = (xForMs(reportStartMs + HOUR_MS) - xForMs(reportStartMs)) / 2;
  const hoverHours = points.map((point, index) => {
    const left = Math.max(pad.left, point.x - halfHourWidth);
    const right = Math.min(width - pad.right, point.x + halfHourWidth);
    const hourLabel = hourLabels.indexOf(hourLabels[index]) !== hourLabels.lastIndexOf(hourLabels[index])
      ? CT_HOUR_DAY_ZONE.format(new Date(point.atMs))
      : hourLabels[index];
    const lines = [`${Math.round(point.temperature)}° · ${hourLabel}`];
    const wet = weatherPrecipitationDetail(point.hour);
    if (wet) {
      const chance = wet.probability != null ? `${Math.round(wet.probability)}% chance` : '';
      const amount = precipitationAmountLabel(wet.amount, wet.intervalHours, null);
      lines.push([`${wet.intensity ? `${wet.intensity} ` : ''}${wet.kind}`, chance, amount].filter(Boolean).join(' · '));
    }
    const halfWidth = Math.max(...lines.map((line) => line.length)) * 3.2 + 6;
    const labelX = Math.max(pad.left + halfWidth, Math.min(width - pad.right - halfWidth, point.x));
    const below = point.y - 12 - (lines.length - 1) * 14 < pad.top + 4;
    const labelY = below ? point.y + 20 : point.y - 12 - (lines.length - 1) * 14;
    const text = lines.map((line, lineIndex) => `<tspan x="${labelX.toFixed(1)}" dy="${lineIndex ? 14 : 0}">${escapeHtml(line)}</tspan>`).join('');
    return `<g class="weather-hover-hour" data-hour-at="${new Date(point.atMs).toISOString()}"><rect class="weather-hover-hit" x="${left.toFixed(1)}" y="${pad.top}" width="${Math.max(1, right - left).toFixed(1)}" height="${chartH}"></rect><g class="weather-hover-readout"><line x1="${point.x.toFixed(1)}" y1="${pad.top}" x2="${point.x.toFixed(1)}" y2="${pad.top + chartH}"></line><circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="4.5"></circle><text x="${labelX.toFixed(1)}" y="${labelY.toFixed(1)}" text-anchor="middle">${text}</text></g></g>`;
  }).join('');
  const horizontalValues = Array.from({ length: Math.round((yMax - yMin) / 5) + 1 }, (_, index) => yMax - index * 5);
  const horizontalGrid = horizontalValues.map((value, index) => {
    const y = pad.top + ((yMax - value) / spread) * chartH;
    const showLabel = detail || horizontalValues.length <= 8 || index % 2 === 0 || index === horizontalValues.length - 1;
    return `<line class="weather-grid-horizontal" x1="${pad.left}" y1="${y.toFixed(1)}" x2="${width - pad.right}" y2="${y.toFixed(1)}"></line>${showLabel ? `<text x="${pad.left - 6}" y="${(y + 4).toFixed(1)}" text-anchor="end">${value}°</text>` : ''}`;
  }).join('');
  const verticalGrid = Array.from({ length: 25 }, (_, index) => index * 2).map((hourOffset) => {
    const x = xForMs(reportStartMs + hourOffset * HOUR_MS);
    const label = hourOffset % 6 === 0
      ? `<text x="${x.toFixed(1)}" y="${height - 8}" text-anchor="${hourOffset === 0 ? 'start' : hourOffset === 48 ? 'end' : 'middle'}">${escapeHtml(CT_HOUR.format(new Date(reportStartMs + hourOffset * HOUR_MS)))}</text>`
      : '';
    return `<line class="weather-grid-vertical" data-hour-offset="${hourOffset}" x1="${x.toFixed(1)}" y1="${pad.top}" x2="${x.toFixed(1)}" y2="${pad.top + chartH}"></line>${label}`;
  }).join('');
  const title = detail ? 'ExampleCo · next 48 hours' : 'ExampleCo · 48 hours';
  return `<section class="weather-hero${detail ? ' weather-hero-detail' : ''}" data-report-date="${escapeHtml(weather.date)}" data-report-window-start="${escapeHtml(weather.report_window_start)}">
    <div class="weather-hero-heading"><strong>${title}</strong><span>National Weather Service</span></div>
    <svg class="weather-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="48-hour ExampleCo temperature curve from 8:00 AM CT with daily high and low times and precipitation periods">
      <defs><linearGradient id="weatherArea${detail ? 'Detail' : ''}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#df7650" stop-opacity=".34"></stop><stop offset="1" stop-color="#df7650" stop-opacity=".02"></stop></linearGradient><linearGradient id="weatherLine${detail ? 'Detail' : ''}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#3d7ea6"></stop><stop offset=".52" stop-color="#d26843"></stop><stop offset="1" stop-color="#9c4a35"></stop></linearGradient></defs>
      <g class="weather-grid">${horizontalGrid}${verticalGrid}</g>${bands}
      <line class="weather-day-divider" x1="${xForMs(reportStartMs + 24 * HOUR_MS).toFixed(1)}" y1="${pad.top}" x2="${xForMs(reportStartMs + 24 * HOUR_MS).toFixed(1)}" y2="${pad.top + chartH}"></line>
      <path class="weather-area" d="${areaPath}" fill="url(#weatherArea${detail ? 'Detail' : ''})"></path>
      <path class="weather-line" d="${linePath}" stroke="url(#weatherLine${detail ? 'Detail' : ''})"></path>${markers}
      <g class="weather-hover">${hoverHours}</g>
    </svg>
  </section>`;
}

module.exports = {
  blockedWeatherHtml,
  nullPreservingMax,
  precipitationAmountLabel,
  weatherConditionKind,
  weatherCurvePath,
  weatherHeroHtml,
  weatherPrecipitationDetail,
};
