'use strict';

// scripts/lib/briefing-heal-run-graph.js
//
// PHASE 4a, item 5: MODE-EQUIVALENCE PREFLIGHT.
//
// scripts/lib/briefing-heal-run-graph.json is the ONE authority for the heal
// run-graph (the ordered list of heal stages). The overnight (deadline-bounded) path
// and the attended/babysitter (midday, no-deadline) path must both read THIS graph.
// Before any worker spawn, the orchestrator asserts the two paths resolve to the SAME
// stage list; if they diverge the assertion fails and the caller exits nonzero BEFORE
// spawning anything (a divergence means one path is healing differently than the
// other, which is exactly the split-brain Phase 4a forbids).
//
// Modes are allowed to differ ONLY in modeKnobs (deadline vs none, sequential vs
// parallel) -- never in WHICH stages run or their ORDER. Pure; no spawn, no network.

const fs = require('node:fs');
const path = require('node:path');

const GRAPH_PATH = path.join(__dirname, 'briefing-heal-run-graph.json');

function loadRunGraph(graphPath = GRAPH_PATH) {
  const raw = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
  if (!raw || !Array.isArray(raw.stages) || raw.stages.length === 0) {
    throw new Error(`briefing heal run-graph at ${graphPath} has no stages`);
  }
  return raw;
}

function sameStageList(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (String(a[i]) !== String(b[i])) return false;
  }
  return true;
}

// Assert the overnight path and the attended path read the SAME run-graph stages.
// Each path supplies its resolved stage list (read from THIS graph in production; a
// test may inject divergent lists to prove the guard fires). Returns
// { ok, stages, divergence } and NEVER throws -- the caller decides to exit nonzero.
function assertModeEquivalence(opts = {}) {
  const graph = opts.graph || loadRunGraph(opts.graphPath);
  const expected = graph.stages;
  const overnight = Array.isArray(opts.overnightStages) ? opts.overnightStages : expected;
  const attended = Array.isArray(opts.attendedStages) ? opts.attendedStages : expected;
  const overnightOk = sameStageList(overnight, expected);
  const attendedOk = sameStageList(attended, expected);
  const pathsAgree = sameStageList(overnight, attended);
  if (overnightOk && attendedOk && pathsAgree) {
    return { ok: true, stages: expected.slice() };
  }
  const divergence = [];
  if (!overnightOk) divergence.push(`overnight path stages diverge from the authority graph`);
  if (!attendedOk) divergence.push(`attended path stages diverge from the authority graph`);
  if (!pathsAgree) divergence.push(`overnight and attended paths read different stages`);
  return {
    ok: false,
    stages: expected.slice(),
    divergence: divergence.join('; '),
    overnight,
    attended,
  };
}

module.exports = {
  GRAPH_PATH,
  loadRunGraph,
  sameStageList,
  assertModeEquivalence,
};
