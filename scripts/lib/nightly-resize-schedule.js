'use strict';

// Single source of truth for the nightly EC2 resize schedule. Three places
// must move together whenever this schedule changes: the EventBridge
// Scheduler cron expressions (scripts/infra/apply-nightly-ec2-resize.js),
// the systemd pre-drain timer OnCalendar lines (scripts/install-ec2-resize-drain.sh),
// and the window constants read by scripts/ec2-nightly-resize-health.js.
// scripts/__tests__/nightly-resize-schedule-drift.test.js pins all three to
// the constants below; edit only here, then re-run that test.

const TIMEZONE = 'America/Chicago';

// The AWS-ResizeInstance automation itself runs at these clock times.
const SCALE_UP = { hour: 22, minute: 15 };
const SCALE_DOWN = { hour: 5, minute: 35 };

// The pre-drain timer fires this many minutes before the scale event, and
// the transition grace (used to classify yellow/markerStuck) extends this
// many minutes after it.
const PREPARE_LEAD_MINUTES = 5;
const TRANSITION_GRACE_MINUTES = 15;

function hhmm(hour, minute) {
  return hour * 100 + minute;
}

function addMinutes(hour, minute, deltaMinutes) {
  const total = (((hour * 60 + minute + deltaMinutes) % (24 * 60)) + 24 * 60) % (24 * 60);
  return { hour: Math.floor(total / 60), minute: total % 60 };
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function onCalendarTime({ hour, minute }) {
  return `${pad2(hour)}:${pad2(minute)}:00`;
}

function cronExpression({ hour, minute }) {
  return `cron(${minute} ${hour} * * ? *)`;
}

const SCALE_UP_HHMM = hhmm(SCALE_UP.hour, SCALE_UP.minute);
const SCALE_DOWN_HHMM = hhmm(SCALE_DOWN.hour, SCALE_DOWN.minute);

const PREPARE_UP = addMinutes(SCALE_UP.hour, SCALE_UP.minute, -PREPARE_LEAD_MINUTES);
const PREPARE_DOWN = addMinutes(SCALE_DOWN.hour, SCALE_DOWN.minute, -PREPARE_LEAD_MINUTES);
const TRANSITION_UP_END = addMinutes(SCALE_UP.hour, SCALE_UP.minute, TRANSITION_GRACE_MINUTES);
const TRANSITION_DOWN_END = addMinutes(
  SCALE_DOWN.hour,
  SCALE_DOWN.minute,
  TRANSITION_GRACE_MINUTES,
);

const PREPARE_UP_HHMM = hhmm(PREPARE_UP.hour, PREPARE_UP.minute);
const PREPARE_DOWN_HHMM = hhmm(PREPARE_DOWN.hour, PREPARE_DOWN.minute);
const TRANSITION_UP_END_HHMM = hhmm(TRANSITION_UP_END.hour, TRANSITION_UP_END.minute);
const TRANSITION_DOWN_END_HHMM = hhmm(TRANSITION_DOWN_END.hour, TRANSITION_DOWN_END.minute);

const SCALE_UP_CRON = cronExpression(SCALE_UP);
const SCALE_DOWN_CRON = cronExpression(SCALE_DOWN);
const PREPARE_UP_ON_CALENDAR = `OnCalendar=*-*-* ${onCalendarTime(PREPARE_UP)} ${TIMEZONE}`;
const PREPARE_DOWN_ON_CALENDAR = `OnCalendar=*-*-* ${onCalendarTime(PREPARE_DOWN)} ${TIMEZONE}`;

const NIGHT_INSTANCE_TYPE = 'm7i.xlarge';
const DAY_INSTANCE_TYPE = 't3.medium';

const WINDOW_LABEL = `${pad2(SCALE_UP.hour)}:${pad2(SCALE_UP.minute)}-${pad2(SCALE_DOWN.hour)}:${pad2(SCALE_DOWN.minute)} ${TIMEZONE}`;

function ctParts(now = new Date()) {
  const rows = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(now);
  const value = Object.fromEntries(rows.map((row) => [row.type, row.value]));
  return { hour: Number(value.hour) % 24, minute: Number(value.minute) };
}

function resizeExpectation(now = new Date()) {
  const { hour, minute } = ctParts(now);
  const nowHhmm = hhmm(hour, minute);
  const transition =
    (nowHhmm >= SCALE_DOWN_HHMM && nowHhmm < TRANSITION_DOWN_END_HHMM) ||
    (nowHhmm >= SCALE_UP_HHMM && nowHhmm < TRANSITION_UP_END_HHMM);
  return {
    expectedType:
      nowHhmm >= SCALE_UP_HHMM || nowHhmm < SCALE_DOWN_HHMM
        ? NIGHT_INSTANCE_TYPE
        : DAY_INSTANCE_TYPE,
    transition,
    hhmm: nowHhmm,
  };
}

function resizeDrainWindow(now = new Date()) {
  const { hour, minute } = ctParts(now);
  const nowHhmm = hhmm(hour, minute);
  return (
    (nowHhmm >= PREPARE_DOWN_HHMM && nowHhmm < TRANSITION_DOWN_END_HHMM) ||
    (nowHhmm >= PREPARE_UP_HHMM && nowHhmm < TRANSITION_UP_END_HHMM)
  );
}

module.exports = {
  TIMEZONE,
  SCALE_UP,
  SCALE_DOWN,
  PREPARE_LEAD_MINUTES,
  TRANSITION_GRACE_MINUTES,
  SCALE_UP_HHMM,
  SCALE_DOWN_HHMM,
  PREPARE_UP_HHMM,
  PREPARE_DOWN_HHMM,
  TRANSITION_UP_END_HHMM,
  TRANSITION_DOWN_END_HHMM,
  SCALE_UP_CRON,
  SCALE_DOWN_CRON,
  PREPARE_UP_ON_CALENDAR,
  PREPARE_DOWN_ON_CALENDAR,
  NIGHT_INSTANCE_TYPE,
  DAY_INSTANCE_TYPE,
  WINDOW_LABEL,
  ctParts,
  resizeExpectation,
  resizeDrainWindow,
};
