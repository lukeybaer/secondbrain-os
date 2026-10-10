'use strict';

const fs = require('node:fs');
const path = require('node:path');

const RED_PLAN_SCRIPT_ID = 'watch-report-red-plan';
const FINALIZED_REPORT_MARKER = '<meta name="watch-report-finalized" content="true">';
const LLM_ANALYSIS_MARKER = '<meta name="watch-report-analysis" content="llm">';

const { assignBlockerIds, blockerStableId } = require('./briefing-blocker-ids.js');

function buildWatchReportRedPlan(model, practicalRedExplanations, options = {}) {
  // Stable ids ride along with the plan so the briefing's blockers drill-down
  // shows the same RED-n, W-n and S-n the overnight report shows, without
  // recomputing an ordering that could drift from the report's roster.
  const stableIds = assignBlockerIds({
    red: Array.isArray(model.redItems) ? model.redItems : [],
    watcher: Array.isArray(model.interventions) ? model.interventions : [],
  });
  const redStableIdByWorkUnit = new Map(
    stableIds.red.map((item, index) => [
      String((Array.isArray(model.redItems) ? model.redItems[index] : {}).id || ''),
      item.stableId,
    ]),
  );
  const priorities = new Map(
    (Array.isArray(model.recommendations) ? model.recommendations : []).map((item, index) => [
      Number.isInteger(Number(item.displayRank)) ? Number(item.displayRank) : index + 1,
      item,
    ]),
  );
  const practical = new Map(
    practicalRedExplanations(model.redItems, model.redExplanations, {
      recommendations: model.recommendations,
      date: model.date,
    }).map((item) => [
      String(item.workUnitId),
      item,
    ]),
  );
  return {
    schema: 'watch-report-red-plan@1',
    date: String(model.date || '').slice(0, 10),
    source: 'final-overnight-watch-report',
    evidenceSha256: String(model.evidenceSha256 || ''),
    executiveSummary: String(options.executiveSummary || model.executiveSummary || ''),
    recommendations: (Array.isArray(model.recommendations) ? model.recommendations : []).map(
      (item, index) => ({
        rank: Number.isInteger(Number(item.displayRank)) ? Number(item.displayRank) : index + 1,
        stableId: blockerStableId(
          'strategic',
          (Number.isInteger(Number(item.displayRank)) ? Number(item.displayRank) : index + 1) - 1,
        ),
        title: String(item.title || ''),
        outcomes: (Array.isArray(item.outcomeLabels)
          ? item.outcomeLabels
          : Array.isArray(item.outcomes)
            ? item.outcomes
            : []
        ).map(String),
        currentProblem: String(item.painPoint || ''),
        proposedSolution: String(item.proposedSolution || ''),
        complexityRisksCost: String(item.complexityRisksCost || ''),
      }),
    ),
    interventions: (Array.isArray(model.interventions) ? model.interventions : []).map(
      (item, index) => ({
        key: String(item.key || ''),
        stableId: blockerStableId('watcher', index),
        title: String(item.title || ''),
        trigger: String(item.trigger || ''),
        rootCause: String(item.rootCause || ''),
        rootCauseEvidenceSource: String(item.rootCauseEvidenceSource || ''),
        rootCauseResearchComplete: item.rootCauseResearchComplete === true,
        action: String(item.action || ''),
        result: String(item.result || ''),
        recurrenceFix: String(item.recurrenceFix || ''),
        preventionDesign: String(item.preventionDesign || ''),
        autonomous: item.autonomous !== false,
      }),
    ),
    items: (Array.isArray(model.redItems) ? model.redItems : []).map((item) => {
      const plain = practical.get(String(item.id)) || {};
      const priorityRank = Number(item.strategicPriority);
      const priority = priorities.get(priorityRank);
      const reflection = item.standingReflection || {};
      return {
        workUnitId: String(item.id || ''),
        stableId: redStableIdByWorkUnit.get(String(item.id || '')) || '',
        cardId: String(item.cardId || ''),
        title: String(item.title || item.id || ''),
        status: String(item.status || 'red'),
        whatThisMeans: String(plain.whatItMeans || ''),
        rootCause: String(plain.rootCause || reflection.rootCause || ''),
        rootCauseEvidenceSource: String(item.rootCauseEvidenceSource || ''),
        rootCauseResearchComplete: item.rootCauseResearchComplete === true,
        practicalNextOutcome: String(plain.whatNeedsToHappen || ''),
        impactRisksCost: String(plain.impactRisksCost || ''),
        strategicPriority: priority
          ? { rank: priorityRank, title: String(priority.title || '') }
          : null,
        exactGreenProof: String(
          plain.exactGreenProof ||
            (priority ? item.makeGreenRemainder || '' : item.makeGreen || ''),
        ),
        whatAmyAlreadyTried: String(item.attempted || ''),
        whyItSurvived: String(item.survivedBecause || ''),
        whatExampleCoNeedsToDo: String(plain.ExampleCoAction || ''),
        whereItStands: String(item.executionStatus || ''),
        currentEvidence: String(item.evidence || ''),
        watcherDetail: String(item.watcherEvidence || ''),
      };
    }),
  };
}

function encodeRedPlanForHtml(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

function extractWatchReportRedPlan(html) {
  const source = String(html || '');
  const match = source.match(
    new RegExp(`(<script[^>]+id=["']${RED_PLAN_SCRIPT_ID}["'][^>]*>)([\\s\\S]*?)<\\/script>`, 'i'),
  );
  if (!match) return null;
  try {
    const payload = /data-encoding=["']base64["']/i.test(match[1])
      ? Buffer.from(match[2].trim(), 'base64').toString('utf8')
      : match[2];
    const parsed = JSON.parse(payload);
    if (!parsed || parsed.schema !== 'watch-report-red-plan@1' || !Array.isArray(parsed.items)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function extractFinalWatchReportRedPlan(html) {
  const source = String(html || '');
  if (!source.includes(FINALIZED_REPORT_MARKER) || !source.includes(LLM_ANALYSIS_MARKER)) {
    return null;
  }
  return extractWatchReportRedPlan(source);
}

function readFinalWatchReportRedPlan({ dataDir, date } = {}) {
  const day = String(date || '').slice(0, 10);
  if (!dataDir || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  try {
    const html = fs.readFileSync(
      path.join(dataDir, 'briefings', `watch-report-${day}.html`),
      'utf8',
    );
    const plan = extractFinalWatchReportRedPlan(html);
    return plan && plan.date === day ? plan : null;
  } catch {
    return null;
  }
}

const GREEN_OR_INFORMATIONAL_STATUSES = new Set([
  'clean',
  'green',
  'info',
  'informational',
  'healthy',
  'ok',
  'pass',
  'passed',
  'verified',
]);

function finalRedPlanItemForExactUnit(plan, workUnitId, { currentStatus = '' } = {}) {
  const id = String(workUnitId || '').trim();
  if (!id || !plan || !Array.isArray(plan.items)) return null;
  if (
    GREEN_OR_INFORMATIONAL_STATUSES.has(
      String(currentStatus || '')
        .trim()
        .toLowerCase(),
    )
  ) {
    return null;
  }
  return plan.items.find((item) => String((item && item.workUnitId) || '').trim() === id) || null;
}

function finalRedPlanItemForBlocker(plan, blocker, { currentStatus = '' } = {}) {
  if (!blocker) return null;
  if (
    GREEN_OR_INFORMATIONAL_STATUSES.has(
      String(currentStatus || '')
        .trim()
        .toLowerCase(),
    )
  ) {
    return null;
  }
  const explicitWorkUnitId = String(blocker.workUnitId || '').trim();
  if (explicitWorkUnitId) {
    return finalRedPlanItemForExactUnit(plan, explicitWorkUnitId, { currentStatus });
  }

  const candidateIds = [
    ...new Set(
      [blocker.cardId, blocker.id].map((value) => String(value || '').trim()).filter(Boolean),
    ),
  ];
  for (const candidateId of candidateIds) {
    if (candidateId === 'system_health' || candidateId.startsWith('system_health:')) continue;
    const exactUnit = finalRedPlanItemForExactUnit(plan, candidateId, { currentStatus });
    if (exactUnit) return exactUnit;
    const cardMatches = (Array.isArray(plan && plan.items) ? plan.items : []).filter(
      (item) => String((item && item.cardId) || '').trim() === candidateId,
    );
    if (cardMatches.length === 1) return cardMatches[0];
  }
  return null;
}

module.exports = {
  RED_PLAN_SCRIPT_ID,
  buildWatchReportRedPlan,
  encodeRedPlanForHtml,
  extractWatchReportRedPlan,
  extractFinalWatchReportRedPlan,
  finalRedPlanItemForBlocker,
  finalRedPlanItemForExactUnit,
  readFinalWatchReportRedPlan,
};
