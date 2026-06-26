const CT_TIME_ZONE = 'America/Chicago';

function ctDayKeyForInstant(dateOrMs = Date.now()) {
  const date = dateOrMs instanceof Date ? dateOrMs : new Date(dateOrMs);
  return date.toLocaleDateString('en-CA', { timeZone: CT_TIME_ZONE });
}

function addDaysToDayKey(dayKey, days) {
  const date = new Date(`${dayKey}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return date.toISOString().slice(0, 10);
}

module.exports = {
  CT_TIME_ZONE,
  ctDayKeyForInstant,
  addDaysToDayKey,
};
