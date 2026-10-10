'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = 'secondbrain.scheduled-activity-graph.v1';

function processNode(id, label, owner, timing) {
  return Object.freeze({ id, type: 'process', label, owner, timing });
}

function informationArc(from, to, information, condition = 'always') {
  return Object.freeze({ from, to, information, condition });
}

function activityGraph({
  activity,
  label,
  startCt = '00:00',
  deadlineCt,
  retry,
  specificNodes = [],
  specificArcs = [],
}) {
  const nodes = [
    processNode('admission', 'Admit exact activity', 'cloud scheduled fleet', `${startCt} CT fleet scan`),
    ...specificNodes,
    processNode('classify', 'Classify terminal result', 'activity graph', 'immediately after producer exit'),
    processNode('healer-handoff', 'Handoff exact implementation failure', 'System Health self-heal', 'same run'),
    processNode('terminal-proof', 'Write exact terminal proof', 'activity graph', `before ${deadlineCt} CT`),
  ];
  const firstSpecific = specificNodes[0]?.id || 'classify';
  const lastSpecific = specificNodes.at(-1)?.id || 'admission';
  const arcs = [
    informationArc('admission', firstSpecific, `${activity} exact scope, schedule date, deadline`),
    ...specificArcs,
    informationArc(lastSpecific, 'classify', 'exit, artifact proof, failure evidence'),
    informationArc(
      'classify',
      'healer-handoff',
      'exact activity, failure fingerprint, failed node, evidence',
      'implementation-contract only',
    ),
    informationArc(
      'classify',
      'terminal-proof',
      'verified result, retryable transport, owner wall, or source wall',
      'not an implementation-contract failure',
    ),
    informationArc(
      'healer-handoff',
      'terminal-proof',
      'durable exact healer handoff receipt',
      'handoff persisted',
    ),
  ];
  return Object.freeze({
    schema: SCHEMA,
    activity,
    label,
    schedule: Object.freeze({ startCt, deadlineCt }),
    retry: Object.freeze(retry),
    healer: Object.freeze({
      on: Object.freeze(['implementation-contract']),
      skip: Object.freeze(['owner-wall', 'source-wall', 'retryable-transport']),
      target: `system_health:scheduled-tasks/${activity}`,
    }),
    nodes: Object.freeze(nodes),
    arcs: Object.freeze(arcs),
  });
}

const SCHEDULED_ACTIVITY_GRAPHS = Object.freeze({
  // The daytime 'secondbrain-nightly-enhancement' graph was removed when ExampleCo
  // retired that research and its Feature Backlog card on 2026-09-24.
  'daily-birthday-check': activityGraph({
    activity: 'daily-birthday-check',
    label: 'Birthdays',
    deadlineCt: '04:35',
    retry: {
      owner: 'none',
      maximumSameEvidenceAttempts: 1,
      reason: 'The full contact scan is deterministic for a fixed corpus; a second unchanged scan adds no evidence.',
    },
    specificNodes: [
      processNode('scan-contacts', 'Scan canonical contact corpus', 'birthday skill', 'activity lane'),
      processNode('validate-dates', 'Validate seven-day recurring-date window', 'birthday skill', 'after scan'),
      processNode('publish-dates', 'Publish upcoming-dates result', 'birthday skill', 'after validation'),
    ],
    specificArcs: [
      informationArc('scan-contacts', 'validate-dates', 'contact file, field, date, provenance'),
      informationArc('validate-dates', 'publish-dates', 'today, this week, coming soon, corpus counts'),
    ],
  }),
  'daily-gmail-scan': activityGraph({
    activity: 'daily-gmail-scan',
    label: 'Gmail scan',
    deadlineCt: '04:35',
    retry: {
      owner: 'inner-producer',
      maximumSameEvidenceAttempts: 1,
      reason: 'The producer owns message watermarks and attachment retries; the fleet never repeats the whole inbox scan unchanged.',
    },
    specificNodes: [
      processNode('scan-mail', 'Read mail after durable watermark', 'Gmail scan skill', 'activity lane'),
      processNode('quarantine-thread', 'Quarantine thread-local failure', 'Gmail scan skill', 'per thread'),
      processNode('publish-mail', 'Publish action and contact deltas', 'Gmail scan skill', 'after scan'),
    ],
    specificArcs: [
      informationArc('scan-mail', 'quarantine-thread', 'thread id, attachment state, failure evidence', 'thread fails'),
      informationArc('scan-mail', 'publish-mail', 'message delta, contact facts, action items', 'thread succeeds'),
      informationArc('quarantine-thread', 'publish-mail', 'successful sibling thread deltas plus quarantine receipt'),
    ],
  }),
  'values-equipping-ideas': activityGraph({
    activity: 'values-equipping-ideas',
    label: 'Values ideas',
    deadlineCt: '04:35',
    retry: {
      owner: 'next-fleet-tick',
      maximumSameEvidenceAttempts: 1,
      reason: 'One subscription-ladder attempt is allowed for unchanged evidence; a changed source fingerprint reopens the graph.',
    },
    specificNodes: [
      processNode('ground-ideas', 'Assemble grounded ministry evidence', 'Values producer', 'activity lane'),
      processNode('judge-ideas', 'Generate and validate three ideas', 'Values producer', 'after grounding'),
      processNode('publish-values', 'Publish dated Values artifact', 'Values producer', 'after validation'),
    ],
    specificArcs: [
      informationArc('ground-ideas', 'judge-ideas', 'source excerpts, current asks, duplicate exclusions'),
      informationArc('judge-ideas', 'publish-values', 'three validated idea packages or exact wall'),
    ],
  }),
  'communication-coaching-card': activityGraph({
    activity: 'communication-coaching-card',
    label: 'Communication coaching',
    deadlineCt: '04:35',
    retry: {
      owner: 'inner-producer',
      maximumSameEvidenceAttempts: 2,
      reason: 'The producer owns one model attempt and its deterministic fallback; the fleet does not re-run the whole card.',
    },
    specificNodes: [
      processNode('collect-coaching', 'Collect grounded communication evidence', 'coaching producer', 'activity lane'),
      processNode('coach-or-fallback', 'Produce coaching or deterministic fallback', 'coaching producer', 'after collection'),
      processNode('publish-coaching', 'Publish typed coaching status', 'coaching producer', 'after quality gate'),
    ],
    specificArcs: [
      informationArc('collect-coaching', 'coach-or-fallback', 'quotes, speaker, source call, coaching opportunity'),
      informationArc('coach-or-fallback', 'publish-coaching', 'quality verdict, fallback provenance, typed status'),
    ],
  }),
  'morning-shorts-proposals': activityGraph({
    activity: 'morning-shorts-proposals',
    label: 'Shorts proposals',
    deadlineCt: '04:35',
    retry: {
      owner: 'inner-producer',
      maximumSameEvidenceAttempts: 6,
      reason: 'The producer owns bounded source expansion and judging; the validator, not fleet exit alone, owns terminal success.',
    },
    specificNodes: [
      processNode('collect-shorts', 'Collect candidate clips and trends', 'Shorts producer', 'activity lane'),
      processNode('judge-shorts', 'Judge bounded proposal candidates', 'Shorts producer', 'bounded source expansion'),
      processNode('validate-shorts', 'Validate ten proposal packages', 'Shorts validator', 'after judging'),
      processNode('publish-shorts', 'Publish dated Shorts artifact', 'Shorts producer', 'after validator passes'),
    ],
    specificArcs: [
      informationArc('collect-shorts', 'judge-shorts', 'candidate, source, transcript, novelty evidence'),
      informationArc('judge-shorts', 'validate-shorts', 'ranked proposal packages and rejection reasons'),
      informationArc('validate-shorts', 'publish-shorts', 'ten accepted proposals or exact shortfall'),
    ],
  }),
});

function activityGraphFor(skill, { window } = {}) {
  const graph = SCHEDULED_ACTIVITY_GRAPHS[String(skill || '')];
  if (graph) return graph;
  const activity = String(skill || '').trim();
  if (!activity) throw new Error('scheduled activity graph requires a skill');
  // A named graph above always carries its own correct startCt/deadlineCt,
  // so this fallback only needs the window
  // for skills with no dedicated graph, e.g. video-quality-research and
  // weekly-warmth-audit after their 2026-09-14 move to the daytime fleet.
  const daytime = window === 'daytime';
  return activityGraph({
    activity,
    label: activity,
    startCt: daytime ? '13:10' : '00:00',
    deadlineCt: daytime ? '17:30' : '05:00',
    retry: {
      owner: 'next-fleet-tick',
      maximumSameEvidenceAttempts: 1,
      reason: 'Unchanged whole-task repetition is deferred to the next fleet tick.',
    },
    specificNodes: [
      processNode('producer', 'Run scheduled producer', activity, 'activity lane'),
      processNode('validate', 'Validate producer result', activity, 'after producer exit'),
    ],
    specificArcs: [informationArc('producer', 'validate', 'artifact, exit, validation evidence')],
  });
}

function compact(value, max = 1000) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function classifyActivityFailure(result = {}) {
  if (result.ok === true) return 'verified';
  const text = compact([result.error, result.raw].filter(Boolean).join(' '), 4000);
  if (/not logged in|login required|owner action|required consent|oauth.*(?:expired|missing)|credentials? (?:missing|not found)|permission denied.*owner/i.test(text)) {
    return 'owner-wall';
  }
  if (/sources?-exhausted|no (?:new|eligible|matching) (?:source|item|message|transcript)|upstream source wall/i.test(text)) {
    return 'source-wall';
  }
  if (/briefing night circuit denied|timeout|timed out|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|HTTP 429|HTTP 5\d\d|temporar(?:y|ily)|transport-failure|rate limit|usage limit|quota (?:reached|exceeded)|provider (?:capacity|overloaded)/i.test(text)) {
    return 'retryable-transport';
  }
  return 'implementation-contract';
}

function graphStatusFor(failureClass) {
  if (failureClass === 'verified') return 'verified';
  if (failureClass === 'implementation-contract') return 'healer-handoff';
  if (failureClass === 'owner-wall') return 'blocked-owner';
  if (failureClass === 'source-wall') return 'blocked-source';
  return 'retry-next-tick';
}

function appendJsonl(file, row) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
}

function receiptId(activity, date, startedAt) {
  return crypto
    .createHash('sha256')
    .update(`${activity}\0${date}\0${startedAt}`)
    .digest('hex')
    .slice(0, 20);
}

async function executeScheduledActivity(task, {
  dataDir,
  date,
  trigger,
  runSkill,
  now = () => new Date(),
} = {}) {
  const graph = activityGraphFor(task.skill, { window: task.window });
  const startedAt = now().toISOString();
  const id = receiptId(task.skill, date, startedAt);
  const pathTaken = ['admission', graph.nodes[1].id];
  let result;
  try {
    result = await runSkill(task, {
      dataDir,
      date,
      trigger,
      activityGraphId: id,
      retryPolicy: graph.retry,
    });
  } catch (error) {
    result = { ok: false, rung: 'none', exitCode: 1, error: error?.message || String(error) };
  }
  for (const node of graph.nodes.slice(2, -3)) pathTaken.push(node.id);
  pathTaken.push('classify');
  const failureClass = classifyActivityFailure(result);
  const graphStatus = graphStatusFor(failureClass);
  const healerHandoff = failureClass === 'implementation-contract';
  if (healerHandoff) pathTaken.push('healer-handoff');
  pathTaken.push('terminal-proof');
  const finishedAt = now().toISOString();
  const receipt = {
    schema: SCHEMA,
    receiptId: id,
    activity: task.skill,
    label: graph.label,
    scheduleDate: date,
    trigger,
    startedAt,
    finishedAt,
    status: graphStatus,
    failureClass,
    path: pathTaken,
    nodeReceipts: graph.nodes.map((node) => {
      if (node.id === 'admission') return { node: node.id, status: 'observed', at: startedAt };
      if (node.id === 'classify') return { node: node.id, status: failureClass, at: finishedAt };
      if (node.id === 'healer-handoff') {
        return {
          node: node.id,
          status: healerHandoff ? 'queued' : 'not-applicable',
          at: healerHandoff ? finishedAt : null,
        };
      }
      if (node.id === 'terminal-proof') return { node: node.id, status: graphStatus, at: finishedAt };
      const supplied = (Array.isArray(result?.nodeReceipts) ? result.nodeReceipts : []).find(
        (candidate) => candidate && candidate.node === node.id,
      );
      return supplied
        ? { ...supplied, node: node.id }
        : {
            node: node.id,
            status: result?.ok === true ? 'producer-contract-passed' : 'not-individually-observed',
            at: null,
          };
    }),
    retry: graph.retry,
    healer: graph.healer,
    result: {
      ok: result?.ok === true,
      rung: result?.rung || 'none',
      exitCode: Number.isFinite(Number(result?.exitCode)) ? Number(result.exitCode) : result?.ok ? 0 : 1,
      evidence: compact(result?.raw || result?.error || '', 1000),
    },
  };
  if (healerHandoff) {
    appendJsonl(path.join(dataDir, 'agent', 'scheduled-activity-healer-handoffs.jsonl'), {
      schema: 'secondbrain.scheduled-activity-healer-handoff.v1',
      ts: finishedAt,
      receiptId: id,
      activity: task.skill,
      workUnitId: `system_health:scheduled-tasks/${task.skill}`,
      failedNode: compact(result?.failedNode || graph.nodes.at(-4)?.id || 'producer', 120),
      failureClass,
      failureEvidence: receipt.result.evidence,
    });
  }
  return { result, receipt, graphStatus, failureClass, healerHandoff };
}

async function runActivitiesConcurrently(tasks, execute, concurrency = 7) {
  const list = Array.isArray(tasks) ? tasks : [];
  const results = new Array(list.length);
  const bound = Math.max(1, Math.min(Number(concurrency) || 1, list.length || 1));
  let next = 0;
  async function worker() {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= list.length) return;
      results[index] = await execute(list[index], index);
    }
  }
  await Promise.all(Array.from({ length: bound }, () => worker()));
  return results;
}

module.exports = {
  SCHEMA,
  SCHEDULED_ACTIVITY_GRAPHS,
  activityGraphFor,
  classifyActivityFailure,
  executeScheduledActivity,
  graphStatusFor,
  runActivitiesConcurrently,
};
