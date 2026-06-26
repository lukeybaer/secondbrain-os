const fs = require('node:fs');
const path = require('node:path');

const THEME_IDS = ['legacy', 'command', 'kingdom'];

const DEFAULT_BRIEFING_THEME = 'kingdom';

const DEFAULT_MILESTONES = [
  {
    id: 'debt-freedom',
    label: 'Financial launchpad',
    targetDate: '2027-02-28',
    text: 'Freedom from all debt, $100k in the bank, titles protected, liability bulletproof.',
    accent: 'gold',
  },
  {
    id: 'retirement-secured',
    label: 'Retirement secured',
    targetDate: '2028-06-13',
    text: '$20M equity cashed out, retirement secured.',
    accent: 'green',
  },
  {
    id: 'family-started',
    label: 'Family started',
    targetDate: '2029-06-13',
    text: 'Family started.',
    accent: 'rose',
  },
  {
    id: 'lean-155',
    label: '155 lb target',
    targetDate: '2026-07-28',
    text: 'Lean, strong, disciplined: 155 lb target.',
    accent: 'blue',
  },
  {
    id: 'kids-graduate',
    label: 'Kids graduate',
    targetDate: '2052-06-13',
    text: 'Kids graduate in 2052.',
    accent: 'violet',
  },
  {
    id: 'kingdom-north-star',
    label: 'North star',
    targetDate: null,
    text: "World hunger crushed, child trafficking eliminated, CCP replaced with Jesus's kingdom.",
    accent: 'white',
  },
];

function toDate(value) {
  if (value instanceof Date) return new Date(value.getTime());
  if (value === undefined || value === null) return new Date();
  return new Date(value);
}

function targetDateToMs(targetDate) {
  if (!targetDate) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(targetDate));
  if (!m) return null;
  // Use the end of the CT target day. 05:59:59Z is midnight-ish CT across
  // standard/daylight time and keeps the display stable enough for goals.
  return Date.parse(`${m[1]}-${m[2]}-${m[3]}T05:59:59.000Z`) + 24 * 60 * 60 * 1000;
}

function addMonthsClampedUtc(date, months) {
  const d = new Date(date.getTime());
  const originalDay = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(originalDay, lastDay));
  return d;
}

function countdownParts(targetDate, now) {
  const targetMs = targetDateToMs(targetDate);
  if (!targetMs) return null;
  const start = toDate(now);
  if (!Number.isFinite(start.getTime())) throw new TypeError('now must be a valid date');
  if (targetMs <= start.getTime()) {
    return { months: 0, days: 0, hours: 0, done: true };
  }
  const target = new Date(targetMs);
  let months =
    (target.getUTCFullYear() - start.getUTCFullYear()) * 12 +
    (target.getUTCMonth() - start.getUTCMonth());
  while (months > 0 && addMonthsClampedUtc(start, months).getTime() > targetMs) months -= 1;
  const anchor = addMonthsClampedUtc(start, months);
  let remainderMs = Math.max(0, targetMs - anchor.getTime());
  const days = Math.floor(remainderMs / (24 * 60 * 60 * 1000));
  remainderMs -= days * 24 * 60 * 60 * 1000;
  const hours = Math.floor(remainderMs / (60 * 60 * 1000));
  return { months, days, hours, done: false };
}

function plural(n, unit) {
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

function formatCountdownWords(countdown) {
  if (!countdown) return '';
  if (countdown.done) return 'today';
  const years = Math.floor(Number(countdown.months || 0) / 12);
  const months = Number(countdown.months || 0) % 12;
  const parts = [];
  if (years > 0) parts.push(plural(years, 'year'));
  if (months > 0) parts.push(plural(months, 'month'));
  if (Number(countdown.days || 0) > 0) parts.push(plural(Number(countdown.days || 0), 'day'));
  if (Number(countdown.hours || 0) > 0 || parts.length === 0) {
    parts.push(plural(Number(countdown.hours || 0), 'hour'));
  }
  return parts.join(' ');
}

function buildMilestoneView(now, milestones = DEFAULT_MILESTONES) {
  return milestones
    .slice()
    .sort((a, b) => {
      const an = a && (a.id === 'kingdom-north-star' || /north star/i.test(a.label || ''));
      const bn = b && (b.id === 'kingdom-north-star' || /north star/i.test(b.label || ''));
      if (an !== bn) return an ? -1 : 1;
      const ad = a && a.targetDate ? String(a.targetDate) : '9999-12-31';
      const bd = b && b.targetDate ? String(b.targetDate) : '9999-12-31';
      return ad.localeCompare(bd);
    })
    .map((milestone) => {
      const countdown = countdownParts(milestone.targetDate, now);
      return {
        ...milestone,
        countdown,
        countdownText: formatCountdownWords(countdown),
        targetYear: milestone.targetDate ? String(milestone.targetDate).slice(0, 4) : null,
      };
    });
}

function normalizeTheme(theme) {
  return THEME_IDS.includes(theme) ? theme : DEFAULT_BRIEFING_THEME;
}

function defaultPreferences(now) {
  return {
    schemaVersion: 1,
    theme: DEFAULT_BRIEFING_THEME,
    updatedAt: toDate(now).toISOString(),
  };
}

function normalizePreferences(input, now) {
  const fallback = defaultPreferences(now);
  if (!input || typeof input !== 'object') return fallback;
  return {
    schemaVersion: 1,
    theme: normalizeTheme(input.theme),
    updatedAt:
      typeof input.updatedAt === 'string' && input.updatedAt ? input.updatedAt : fallback.updatedAt,
  };
}

function loadBriefingPreferences(filePath, now) {
  try {
    return normalizePreferences(JSON.parse(fs.readFileSync(filePath, 'utf8')), now);
  } catch (err) {
    if (err && err.code === 'ENOENT') return defaultPreferences(now);
    if (err instanceof SyntaxError) return defaultPreferences(now);
    throw err;
  }
}

function saveBriefingPreferences(filePath, prefs, now) {
  const normalized = normalizePreferences(
    {
      ...prefs,
      updatedAt: toDate(now).toISOString(),
    },
    now,
  );
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  return normalized;
}

module.exports = {
  DEFAULT_BRIEFING_THEME,
  DEFAULT_MILESTONES,
  THEME_IDS,
  buildMilestoneView,
  countdownParts,
  formatCountdownWords,
  loadBriefingPreferences,
  saveBriefingPreferences,
  normalizeTheme,
};
