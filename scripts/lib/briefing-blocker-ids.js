'use strict';

// Stable ids so ExampleCo can reply by number.
//
// The conventions are locked in memory/feedback_ExampleCo_communication_standard.md
// section 11: RED for cards still red, W for watcher interventions, S for
// strategic fixes, T for token reduction. The point of putting them in one
// module is that the overnight report and the briefing blockers drill-down
// assign the SAME id to the SAME work unit, so "repropose RED-2" means one
// thing on both surfaces. Before this module the report numbered its red list
// inline and the briefing's blockers had no ids at all, which is why the two
// lists could not be cross-referenced.
//
// Numbering follows list position, one based. Both surfaces therefore have to
// be handed the same ordered list. That ordering is the report's red roster,
// which freezes once per night, so a number stays put for the whole day.

const BLOCKER_ID_PREFIXES = Object.freeze({
  red: 'RED',
  watcher: 'W',
  strategic: 'S',
  token: 'T',
});

// Section 11 shows only the top five token reduction priorities.
const TOKEN_REGISTER_LIMIT = 5;

function blockerIdPrefix(kind) {
  const prefix = BLOCKER_ID_PREFIXES[String(kind)];
  if (!prefix) {
    throw new Error(
      `unknown blocker kind "${kind}"; expected one of ${Object.keys(BLOCKER_ID_PREFIXES).join(', ')}`,
    );
  }
  return prefix;
}

function blockerStableId(kind, index) {
  const position = Number(index);
  if (!Number.isInteger(position) || position < 0) {
    throw new Error(`blocker index must be a non-negative integer, received "${index}"`);
  }
  return `${blockerIdPrefix(kind)}-${position + 1}`;
}

// The identity a blocker is tracked by. For a red card this is the work unit
// id the controller and the report already use, for example "meetings" or
// "system_health:watcher-liveness". Falling back through the other name fields
// lets the watcher, strategic and token registers share this module without
// each inventing its own key.
function blockerItemKey(item) {
  if (item === null || item === undefined) return '';
  if (typeof item === 'string') return item;
  const candidate = item.id ?? item.workUnitId ?? item.key ?? item.name ?? item.title;
  return candidate === undefined || candidate === null ? '' : String(candidate);
}

function assignKind(kind, items) {
  const list = Array.isArray(items) ? items : [];
  const capped = kind === 'token' ? list.slice(0, TOKEN_REGISTER_LIMIT) : list;
  return capped.map((item, index) => {
    const base = item && typeof item === 'object' ? item : { id: blockerItemKey(item) };
    return {
      ...base,
      kind,
      stableId: blockerStableId(kind, index),
      blockerKey: blockerItemKey(base),
    };
  });
}

// Assign ids across all four registers at once. Each register is numbered
// independently, so adding a watcher intervention never renumbers a red card.
function assignBlockerIds(groups = {}) {
  return {
    red: assignKind('red', groups.red),
    watcher: assignKind('watcher', groups.watcher),
    strategic: assignKind('strategic', groups.strategic),
    token: assignKind('token', groups.token),
  };
}

// Look up "which id did this work unit get" across every register. Keys are
// namespaced as "kind:key" so a watcher item and a red card that happen to
// share a name cannot collide, and so one item never occupies two entries.
function blockerIdIndex(assigned = {}) {
  const index = new Map();
  for (const kind of Object.keys(BLOCKER_ID_PREFIXES)) {
    for (const item of assigned[kind] || []) {
      const key = item.blockerKey || blockerItemKey(item);
      if (!key) continue;
      index.set(`${kind}:${key}`, item.stableId);
    }
  }
  return index;
}

// The same lookup scoped to one register, keyed by the bare work unit id. This
// is what a surface rendering only red cards wants, because it already knows
// the kind and holds plain work unit ids.
function blockerIdsForKind(assigned = {}, kind = 'red') {
  blockerIdPrefix(kind);
  const index = new Map();
  for (const item of assigned[kind] || []) {
    const key = item.blockerKey || blockerItemKey(item);
    if (!key) continue;
    index.set(key, item.stableId);
  }
  return index;
}

module.exports = {
  BLOCKER_ID_PREFIXES,
  TOKEN_REGISTER_LIMIT,
  blockerIdPrefix,
  blockerStableId,
  blockerItemKey,
  assignBlockerIds,
  blockerIdIndex,
  blockerIdsForKind,
};
