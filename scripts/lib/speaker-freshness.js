'use strict';

/**
 * Shared freshness/staleness computation for the briefing speaker card.
 *
 * The Otter enrichment that advances the speaker roster does not yet run
 * continuously on the cloud, so speaker-pareto-latest.json `last_archive_day`
 * can freeze and the card would render frozen data as if current. ExampleCo's
 * contract: never silently stale -- always show "as of <latest archive day>",
 * trail honestly when behind, and block when too far behind to trust.
 *
 * One module owns the rule so the cloud builder markdown
 * (refresh-briefing-generated-sections.js), the ec2-server render parse, and the
 * voiceprint-health-report all agree (the recurring bug class is builder/render
 * divergence). Lag is whole CT calendar days between last_archive_day.date and
 * today.
 *
 * Thresholds:
 *   lag <= 1 day             -> 'fresh'   (just the as-of line, no defect)
 *   lag 2 to 4 days          -> 'note'    (visible "N days behind" note, data ok,
 *                                          BUT a surfaced DEFECT)
 *   lag > 4 days OR empty    -> 'blocker' (cannot trust speaker data, DEFECT)
 *
 * ExampleCo 2026-06-22: "that should be a defect to report, not a silent note." Any
 * lag at or beyond DEFECT_MIN_LAG_DAYS (2) is a real defect: callers must
 * surface a non-green SYSTEM HEALTH row AND a named BLOCKERS entry so the live
 * render-QC counts it, even though the trailing data still renders. The `defect`
 * flag plus `subsystemLabel` / `blockerTitle` / `blockerEvidence` / `blockerNeed`
 * give every caller the SAME escalation text so the builder, the render, and the
 * validator never drift.
 */

const NOTE_MAX_LAG_DAYS = 4; // up to and including 4 days behind is a note
const FRESH_MAX_LAG_DAYS = 1; // up to and including 1 day behind is clean
const DEFECT_MIN_LAG_DAYS = 2; // 2+ days behind is a surfaced defect (ExampleCo 2026-06-22)

// One shared subsystem label so the SYSTEM HEALTH row name, the BLOCKERS entry,
// and the validator's set-diff all match on the same bare phrase. Must satisfy
// the validator's nonGreenSubsystems name regex (letters/words/colon/space/dash)
// and appear verbatim in both the health row and the blocker title.
const SPEAKER_SUBSYSTEM_LABEL = 'Otter speaker enrichment';

function todayCt() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

// Whole calendar days between two YYYY-MM-DD strings (later - earlier). Uses UTC
// midnight of each date so DST never shifts the day count.
function dayDiff(fromIsoDate, toIsoDate) {
  const a = Date.parse(`${fromIsoDate}T00:00:00Z`);
  const b = Date.parse(`${toIsoDate}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

/**
 * Compute the speaker-card freshness signal.
 *
 * @param {object} opts
 * @param {object|null} opts.pareto   the speaker-pareto-latest.json object (or null/missing)
 * @param {string}      [opts.today]  override for today's CT date (YYYY-MM-DD), for tests
 * @returns {{
 *   status: 'fresh'|'note'|'blocker',
 *   lagDays: number|null,
 *   lastArchiveDay: string,
 *   today: string,
 *   asOfLine: string,
 *   freshnessLine: string,
 *   reason: string
 * }}
 */
function computeSpeakerFreshness({ pareto, today } = {}) {
  const todayDate = today || todayCt();
  const recent = pareto && (pareto.last_archive_day || null);
  const lastDay = recent && recent.status !== 'missing' && recent.date ? String(recent.date) : '';

  // Empty/missing roster: cannot trust speaker data at all.
  if (!pareto || !lastDay) {
    return {
      status: 'blocker',
      defect: true,
      lagDays: null,
      lastArchiveDay: lastDay,
      today: todayDate,
      asOfLine: 'As of: speaker roster unavailable (no processed archive day).',
      freshnessLine:
        'BLOCKER: speaker roster is empty or missing; cloud enrichment/backfill has not produced a processed archive day. Speaker data cannot be trusted until ingest advances it.',
      reason: 'empty_or_missing',
      subsystemLabel: SPEAKER_SUBSYSTEM_LABEL,
      blockerTitle: `${SPEAKER_SUBSYSTEM_LABEL} has no processed archive day`,
      blockerEvidence:
        'The cloud speaker roster is empty or missing; Otter enrichment has not produced a processed archive day, so speaker data cannot be trusted.',
      blockerNeed:
        'No action needed from ExampleCo unless he wants Amy to pause Otter ingest; Amy advances the processed archive day automatically once cloud enrichment catches up.',
    };
  }

  const lag = dayDiff(lastDay, todayDate);
  const asOfLine = `As of: ${lastDay} (latest processed archive day).`;

  if (lag == null) {
    // Unparseable date is as untrustworthy as a missing one.
    return {
      status: 'blocker',
      defect: true,
      lagDays: null,
      lastArchiveDay: lastDay,
      today: todayDate,
      asOfLine,
      freshnessLine: `BLOCKER: cannot compute speaker enrichment lag for archive day ${lastDay}; treat speaker data as untrusted until ingest advances it.`,
      reason: 'unparseable_date',
      subsystemLabel: SPEAKER_SUBSYSTEM_LABEL,
      blockerTitle: `${SPEAKER_SUBSYSTEM_LABEL} lag could not be computed`,
      blockerEvidence: `The cloud build could not compute the speaker enrichment lag for archive day ${lastDay}, so speaker data is treated as untrusted.`,
      blockerNeed:
        'No action needed from ExampleCo; Amy re-derives the lag automatically once the archive day timestamp is readable again.',
    };
  }

  if (lag > NOTE_MAX_LAG_DAYS) {
    return {
      status: 'blocker',
      defect: true,
      lagDays: lag,
      lastArchiveDay: lastDay,
      today: todayDate,
      asOfLine,
      freshnessLine: `BLOCKER: speaker enrichment is ${lag} days behind; latest processed day is ${lastDay} and the cloud enrichment/backfill has not advanced it. Speaker data cannot be trusted until ingest catches up.`,
      reason: 'stale_blocker',
      subsystemLabel: SPEAKER_SUBSYSTEM_LABEL,
      blockerTitle: `${SPEAKER_SUBSYSTEM_LABEL} is ${lag} days behind`,
      blockerEvidence: `The speaker roster's latest processed day is ${lastDay}, ${lag} days behind today; cloud Otter enrichment has not advanced it, so speaker data cannot be trusted.`,
      blockerNeed:
        'No action needed from ExampleCo unless he wants Amy to pause Otter ingest; Amy keeps retrying the cloud enrichment until the roster catches up.',
    };
  }

  if (lag >= DEFECT_MIN_LAG_DAYS) {
    // 2 to 4 days behind: the trailing data still renders, but the staleness is
    // a SURFACED DEFECT (ExampleCo 2026-06-22), not a silent note. Callers escalate
    // it to a non-green SYSTEM HEALTH row + a BLOCKERS entry via the shared
    // subsystemLabel/blocker* fields below.
    return {
      status: 'note',
      defect: true,
      lagDays: lag,
      lastArchiveDay: lastDay,
      today: todayDate,
      asOfLine,
      freshnessLine: `Speaker enrichment is ${lag} days behind; latest processed day is ${lastDay}. The shown data is correct but trailing.`,
      reason: 'trailing_note',
      subsystemLabel: SPEAKER_SUBSYSTEM_LABEL,
      blockerTitle: `${SPEAKER_SUBSYSTEM_LABEL} is ${lag} days behind`,
      blockerEvidence: `The speaker roster's latest processed day is ${lastDay}, ${lag} days behind today. The shown data is correct but trailing because cloud Otter enrichment has not advanced the processed archive day.`,
      blockerNeed:
        'No action needed from ExampleCo; Amy keeps advancing the cloud Otter enrichment until the roster is current again.',
    };
  }

  return {
    status: 'fresh',
    defect: false,
    lagDays: lag,
    lastArchiveDay: lastDay,
    today: todayDate,
    asOfLine,
    freshnessLine: '',
    reason: 'fresh',
    subsystemLabel: SPEAKER_SUBSYSTEM_LABEL,
  };
}

module.exports = {
  NOTE_MAX_LAG_DAYS,
  FRESH_MAX_LAG_DAYS,
  DEFECT_MIN_LAG_DAYS,
  SPEAKER_SUBSYSTEM_LABEL,
  todayCt,
  dayDiff,
  computeSpeakerFreshness,
};
