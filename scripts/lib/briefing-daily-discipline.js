const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 1;
const CT_TIME_ZONE = 'America/Chicago';

const DEFAULT_DAILY_DISCIPLINE_ITEMS = [
  { id: 'amy-first', text: 'placed wifey first and loved her' },
  { id: 'wake-on-time', text: 'woke up on time without snoozing' },
  { id: 'resistance-training', text: 'worked out first thing (resistance training)' },
  {
    id: 'morning-plan-review',
    text: "reviewed the plan/strategy for the day's success before day started",
  },
  {
    id: 'next-day-plan',
    text: "created the next day's plan for success before the day ended",
  },
  { id: 'bed-by-930', text: 'bed by 9:30pm' },
  { id: 'educated-myself', text: 'educated myself' },
  {
    id: 'kept-peace',
    text: 'never lost temper/peace/control/spoke too quickly',
  },
  { id: 'bed-hungry', text: 'went to bed hungry' },
  { id: 'slept-well', text: 'slept well' },
];

function toDate(dateOrMs) {
  if (dateOrMs === undefined || dateOrMs === null) return new Date();
  if (dateOrMs instanceof Date) return new Date(dateOrMs.getTime());
  return new Date(dateOrMs);
}

function ctParts(dateOrMs) {
  const date = toDate(dateOrMs);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError('dateOrMs must be a valid Date, timestamp, or ISO date string');
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: CT_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: Number(values.hour),
  };
}

function ctDayKeyForInstant(dateOrMs) {
  const { year, month, day } = ctParts(dateOrMs);
  return `${year}-${month}-${day}`;
}

function disciplineDayKey(dateOrMs) {
  const date = toDate(dateOrMs);
  const parts = ctParts(date);
  if (parts.hour < 2) {
    return ctDayKeyForInstant(date.getTime() - 24 * 60 * 60 * 1000);
  }
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function nowIso(now) {
  return toDate(now).toISOString();
}

function cloneDefaultItems() {
  return DEFAULT_DAILY_DISCIPLINE_ITEMS.map((item) => ({ ...item }));
}

function defaultStore(now) {
  return {
    schemaVersion: SCHEMA_VERSION,
    items: cloneDefaultItems(),
    checksByDay: {},
    updatedAt: nowIso(now),
  };
}

function normalizeItem(item, fallbackId) {
  if (!item || typeof item !== 'object') return null;
  const id = String(item.id || fallbackId || '').trim();
  const text = String(item.text || '').trim();
  if (!id || !text) return null;
  return { id, text };
}

function normalizeChecksByDay(checksByDay) {
  if (!checksByDay || typeof checksByDay !== 'object' || Array.isArray(checksByDay)) return {};
  const normalized = {};
  for (const [day, checks] of Object.entries(checksByDay)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !checks || typeof checks !== 'object') continue;
    normalized[day] = {};
    for (const [itemId, checked] of Object.entries(checks)) {
      if (checked === true) normalized[day][itemId] = true;
    }
  }
  return normalized;
}

function normalizeStore(input, now) {
  const fallback = defaultStore(now);
  if (!input || typeof input !== 'object') return fallback;
  const items = Array.isArray(input.items)
    ? input.items.map((item, index) => normalizeItem(item, `item-${index + 1}`)).filter(Boolean)
    : [];
  return {
    schemaVersion: SCHEMA_VERSION,
    items: items.length ? items : cloneDefaultItems(),
    checksByDay: normalizeChecksByDay(input.checksByDay),
    updatedAt: typeof input.updatedAt === 'string' && input.updatedAt ? input.updatedAt : fallback.updatedAt,
  };
}

function loadDailyDisciplineStore(filePath, now) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return normalizeStore(JSON.parse(raw), now);
  } catch (err) {
    if (err && err.code === 'ENOENT') return defaultStore(now);
    if (err instanceof SyntaxError) return defaultStore(now);
    throw err;
  }
}

function saveDailyDisciplineStore(filePath, store) {
  const normalized = normalizeStore(store);
  normalized.updatedAt = store && store.updatedAt ? store.updatedAt : new Date().toISOString();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  return normalized;
}

function getDailyDisciplineView(store, now) {
  const normalized = normalizeStore(store, now);
  const dayKey = disciplineDayKey(now);
  const checks = normalized.checksByDay[dayKey] || {};
  return {
    dayKey,
    items: normalized.items.map((item) => ({
      id: item.id,
      text: item.text,
      checked: checks[item.id] === true,
    })),
    completedCount: normalized.items.filter((item) => checks[item.id] === true).length,
    totalCount: normalized.items.length,
    updatedAt: normalized.updatedAt,
    schemaVersion: normalized.schemaVersion,
  };
}

function nextItemId(items, text, now) {
  const base = String(text || 'item')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'item';
  let candidate = base;
  let suffix = 2;
  const ids = new Set(items.map((item) => item.id));
  while (ids.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate || `item-${toDate(now).getTime()}`;
}

function applyDailyDisciplineAction(store, action, now) {
  if (!action || typeof action !== 'object') {
    throw new TypeError('action is required');
  }
  const next = normalizeStore(store, now);
  const type = action.type || action.action;
  const dayKey = action.dayKey || disciplineDayKey(now);
  next.checksByDay[dayKey] = next.checksByDay[dayKey] || {};

  if (type === 'addItem') {
    const text = String(action.text || '').trim();
    if (!text) throw new Error('Item text is required');
    const id = String(action.id || nextItemId(next.items, text, now)).trim();
    if (next.items.some((item) => item.id === id)) throw new Error(`Item id already exists: ${id}`);
    next.items.push({ id, text });
  } else if (type === 'updateItem') {
    const id = String(action.id || '').trim();
    const text = String(action.text || '').trim();
    if (!id || !text) throw new Error('Item id and text are required');
    const item = next.items.find((candidate) => candidate.id === id);
    if (!item) throw new Error(`PRIVATE_NAME item id: ${id}`);
    item.text = text;
  } else if (type === 'deleteItem') {
    const id = String(action.id || '').trim();
    if (!id) throw new Error('Item id is required');
    next.items = next.items.filter((item) => item.id !== id);
    for (const checks of Object.values(next.checksByDay)) {
      delete checks[id];
    }
  } else if (type === 'setChecked') {
    const id = String(action.id || '').trim();
    if (!next.items.some((item) => item.id === id)) throw new Error(`PRIVATE_NAME item id: ${id}`);
    if (action.checked) next.checksByDay[dayKey][id] = true;
    else delete next.checksByDay[dayKey][id];
  } else if (type === 'toggleChecked') {
    const id = String(action.id || '').trim();
    if (!next.items.some((item) => item.id === id)) throw new Error(`PRIVATE_NAME item id: ${id}`);
    if (next.checksByDay[dayKey][id]) delete next.checksByDay[dayKey][id];
    else next.checksByDay[dayKey][id] = true;
  } else {
    throw new Error(`Unsupported daily discipline action: ${type}`);
  }

  next.updatedAt = nowIso(now);
  if (Object.keys(next.checksByDay[dayKey]).length === 0) delete next.checksByDay[dayKey];
  return next;
}

module.exports = {
  DEFAULT_DAILY_DISCIPLINE_ITEMS,
  SCHEMA_VERSION,
  disciplineDayKey,
  loadDailyDisciplineStore,
  saveDailyDisciplineStore,
  getDailyDisciplineView,
  applyDailyDisciplineAction,
};
