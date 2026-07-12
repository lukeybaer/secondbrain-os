'use strict';

// scripts/lib/briefing-cards/snack-dude-invoice-card.js
//
// W6 generator merge, card 3. The SNACK DUDE INVOICE ACTIVITY render moved
// VERBATIM out of scripts/cloud-morning-briefing.js
// (formatSnackDudeInvoiceActivity + its invoice roll-up helpers); BOTH
// generators consume THIS module. Pure: takes the already-loaded invoice
// snapshot (cloud: <dataDir>/agent/snackdude-invoices-cache.json; desktop:
// the same cache refreshed by its DynamoDB scan) and the briefing date.
// Source refresh (DynamoDB scan / cache regeneration) STAYS in the
// generators; producers never live in shared card modules.

const { formatMoney, parseIsoDay, formatShortDate, legacySection } = require('./card-format.js');

const TITLE = 'SNACK DUDE INVOICE ACTIVITY';

function sumInvoiceRows(rows) {
  return {
    count: rows.length,
    revenue: rows.reduce((sum, row) => sum + Number(row.total || 0), 0),
    profit: rows.reduce((sum, row) => sum + Number(row.profit || 0), 0),
  };
}

function invoiceLine(label, rows) {
  const summary = sumInvoiceRows(rows);
  return `${label}: ${summary.count} invoice${summary.count === 1 ? '' : 's'}, ${formatMoney(summary.revenue)} revenue, ${formatMoney(summary.profit)} profit`;
}

function formatSnackDudeInvoiceActivity(raw, date) {
  const sourceRows = Array.isArray(raw) ? raw : Array.isArray(raw && raw.items) ? raw.items : [];
  const rows = sourceRows
    .map((row) => ({
      date: String(row && row.date ? row.date : '').slice(0, 10),
      total: Number(row && row.total ? row.total : 0),
      profit: Number(row && row.profit ? row.profit : 0),
    }))
    .filter(
      (row) => parseIsoDay(row.date) && Number.isFinite(row.total) && Number.isFinite(row.profit),
    );
  if (!rows.length) {
    return 'No Snack Dude invoice snapshot was available for this briefing.';
  }
  const sortedDates = [...new Set(rows.map((row) => row.date))].sort();
  const latestDate = sortedDates[sortedDates.length - 1];
  const priorDate = sortedDates.length > 1 ? sortedDates[sortedDates.length - 2] : '';
  const briefingDay = parseIsoDay(date) || parseIsoDay(latestDate) || new Date();
  const withinDays = (n) =>
    rows.filter((row) => {
      const day = parseIsoDay(row.date);
      return (
        day && day >= new Date(briefingDay.getTime() - (n - 1) * 86400000) && day <= briefingDay
      );
    });
  const latestRows = rows.filter((row) => row.date === latestDate);
  const lines = [
    invoiceLine('Last 24h', latestRows),
    invoiceLine('Last 48h', withinDays(2)),
    invoiceLine('Last week', withinDays(7)),
    `Table total: ${rows.length} invoices`,
    `Most recent invoice date in table: ${latestDate}`,
  ];
  if (priorDate) {
    const latestTotal = latestRows.reduce((sum, row) => sum + row.total, 0);
    const priorTotal = rows
      .filter((row) => row.date === priorDate)
      .reduce((sum, row) => sum + row.total, 0);
    const delta = priorTotal ? ((latestTotal - priorTotal) / priorTotal) * 100 : 0;
    lines.push(
      `Day-over-day check: ${formatMoney(latestTotal)} on ${formatShortDate(latestDate)} vs ${formatMoney(priorTotal)} on ${formatShortDate(priorDate)} (${delta >= 0 ? '+' : ''}${Math.round(delta)}%).`,
    );
  }
  return lines.join('\n');
}

function buildSnackDudeInvoiceCard(raw, date) {
  const body = formatSnackDudeInvoiceActivity(raw, date);
  return {
    markdown: legacySection(TITLE, body),
    state: {
      id: 'snack-dude-invoice',
      ok: !/^No Snack Dude invoice snapshot/.test(body),
      source: raw ? 'artifact' : 'missing',
    },
  };
}

module.exports = {
  TITLE,
  sumInvoiceRows,
  invoiceLine,
  formatSnackDudeInvoiceActivity,
  buildSnackDudeInvoiceCard,
};
