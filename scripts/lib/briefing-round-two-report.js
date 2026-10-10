'use strict';

const { tokenExplorerReportCitation } = require('./token-explorer.js');

const ROUND_TWO_HEADING = "Here's what you asked for in round two.";
const OWNER_FEEDBACK_HEADING = 'Feedback from ExampleCo with answers';

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function stableRedRegister({ previous = [], current = [] } = {}) {
  const prior = new Map();
  let maxNumber = 0;
  for (const row of previous || []) {
    const id = String(row && row.id ? row.id : '').trim();
    const number = Number(row && row.number);
    if (!id || !Number.isInteger(number) || number < 1) continue;
    prior.set(id, number);
    maxNumber = Math.max(maxNumber, number);
  }
  return (current || []).map((row) => {
    const id = String(row && row.id ? row.id : '').trim();
    if (!id) throw new Error('round-two red rows require a stable id');
    const number = prior.get(id) || ++maxNumber;
    return { ...row, id, number };
  });
}

function requireText(value, label) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  if (!text) throw new Error(`owner feedback revision requires ${label}`);
  return text;
}

function requireExactIds(rows, prefix, count, label) {
  if (!Array.isArray(rows) || rows.length !== count) {
    throw new Error(`owner feedback revision requires exactly ${count} ${label}`);
  }
  return rows.map((row, index) => {
    const stableId = requireText(row?.stableId, `${label} ${index + 1} stableId`);
    const expected = `${prefix}-${index + 1}`;
    if (stableId !== expected) {
      throw new Error(`${label} stable ids must be ${prefix}-1 through ${prefix}-${count}`);
    }
    return { ...row, stableId };
  });
}

function normalizeOwnerFeedbackPacket(packet = {}) {
  const date = requireText(packet.date, 'date');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('owner feedback revision date must be YYYY-MM-DD');
  }
  const executiveSummary = Array.isArray(packet.executiveSummary)
    ? packet.executiveSummary.map((row, index) => requireText(row, `executive summary paragraph ${index + 1}`))
    : [];
  if (executiveSummary.length < 1 || executiveSummary.length > 2) {
    throw new Error('owner feedback revision executive summary must be one or two paragraphs');
  }
  const feedbackAnswers = Array.isArray(packet.feedbackAnswers)
    ? packet.feedbackAnswers.map((row, index) => ({
        question: requireText(row?.question, `feedback answer ${index + 1} question`),
        answer: requireText(row?.answer, `feedback answer ${index + 1} answer`),
      }))
    : [];
  if (!feedbackAnswers.length) {
    throw new Error('owner feedback revision requires feedback answers');
  }
  const tokenControls = requireExactIds(packet.tokenControls, 'TOKEN', 7, 'token controls').map(
    (row, index) => ({
      ...row,
      title: requireText(row.title, `TOKEN-${index + 1} title`),
      status: requireText(row.status, `TOKEN-${index + 1} status`),
      problem: requireText(row.problem, `TOKEN-${index + 1} problem`),
      rootCause: requireText(row.rootCause, `TOKEN-${index + 1} root cause`),
      change: requireText(row.change, `TOKEN-${index + 1} change`),
      estimatedSavings: requireText(
        row.estimatedSavings,
        `TOKEN-${index + 1} estimated savings`,
      ),
      savingsBasis: requireText(row.savingsBasis, `TOKEN-${index + 1} savings basis`),
    }),
  );
  const strategicPriorities = requireExactIds(
    packet.strategicPriorities,
    'STRATEGIC',
    5,
    'strategic priorities',
  ).map((row, index) => ({
    ...row,
    title: requireText(row.title, `STRATEGIC-${index + 1} title`),
    disposition: requireText(row.disposition, `STRATEGIC-${index + 1} disposition`),
    outcome: requireText(row.outcome, `STRATEGIC-${index + 1} outcome`),
    problem: requireText(row.problem, `STRATEGIC-${index + 1} problem`),
    change: requireText(row.change, `STRATEGIC-${index + 1} change`),
    value: requireText(row.value, `STRATEGIC-${index + 1} value`),
    estimatedSavings: requireText(
      row.estimatedSavings,
      `STRATEGIC-${index + 1} estimated savings`,
    ),
    savingsBasis: requireText(row.savingsBasis, `STRATEGIC-${index + 1} savings basis`),
    evidence: requireText(row.evidence, `STRATEGIC-${index + 1} evidence`),
    risk: requireText(row.risk, `STRATEGIC-${index + 1} risk`),
  }));
  const redDeltas = requireExactIds(packet.redDeltas, 'RED', 13, 'red deltas').map(
    (row, index) => ({
        ...row,
        title: requireText(row?.title, `red delta ${index + 1} title`),
        disposition: requireText(row?.disposition, `red delta ${index + 1} disposition`),
        problem: requireText(row?.problem, `red delta ${index + 1} problem`),
        rootCause: requireText(row?.rootCause, `red delta ${index + 1} root cause`),
        attempts: requireText(row?.attempts, `red delta ${index + 1} attempts`),
        change: requireText(row?.change, `red delta ${index + 1} change`),
        value: requireText(row?.value, `red delta ${index + 1} value`),
        greenProof: requireText(row?.greenProof, `red delta ${index + 1} green proof`),
        ExampleCoAction: requireText(row?.ExampleCoAction, `red delta ${index + 1} ExampleCo action`),
        impactRisk: requireText(row?.impactRisk, `red delta ${index + 1} impact and risk`),
      }),
  );
  const watcherDeltas = requireExactIds(
    packet.watcherDeltas,
    'WATCHER',
    9,
    'watcher deltas',
  ).map((row, index) => ({
        ...row,
        title: requireText(row?.title, `watcher delta ${index + 1} title`),
        disposition: requireText(row?.disposition, `watcher delta ${index + 1} disposition`),
        problem: requireText(row?.problem, `watcher delta ${index + 1} problem`),
        rootCause: requireText(row?.rootCause, `watcher delta ${index + 1} root cause`),
        action: requireText(row?.action, `watcher delta ${index + 1} action`),
        result: requireText(row?.result, `watcher delta ${index + 1} result`),
        proposedFix: requireText(row?.proposedFix, `watcher delta ${index + 1} proposed fix`),
        value: requireText(row?.value, `watcher delta ${index + 1} value`),
        ExampleCoAction: requireText(row?.ExampleCoAction, `watcher delta ${index + 1} ExampleCo action`),
      }));
  return {
    ...packet,
    date,
    executiveSummary,
    feedbackAnswers,
    tokenControls,
    strategicPriorities,
    redDeltas,
    watcherDeltas,
    savingsNote: requireText(packet.savingsNote, 'non-additive savings note'),
    originalHref: requireText(packet.originalHref, 'original report link'),
  };
}

function renderField(label, value) {
  return `<p><strong>${escapeHtml(label)}</strong><br>${escapeHtml(value)}</p>`;
}

function validateOwnerFeedbackRevisionHtml(html, packet) {
  const failures = [];
  const requiredHeadings = [
    OWNER_FEEDBACK_HEADING,
    'Executive summary',
    '24-hour token spend Pareto and causal controls',
    'Top five strategic fixes',
    'Cards still red and what it takes to fix them',
    'Watcher interventions and what it takes to fix them',
  ];
  for (const heading of requiredHeadings) {
    if (!String(html).includes(`<h2>${heading}</h2>`)) failures.push(`missing section ${heading}`);
  }
  if ((String(html).match(/class="item token-control"/g) || []).length !== 7) {
    failures.push('token-control register is not exactly seven rows');
  }
  if ((String(html).match(/class="item strategic-fix priority-summary"/g) || []).length !== 5) {
    failures.push('strategic register is not exactly five rows');
  }
  if (
    (String(html).match(/<strong>ExampleCo decision and implementation status<\/strong>/g) || [])
      .length !== 5
  ) {
    failures.push('strategic decisions are not visible on all five rows');
  }
  if ((String(html).match(/class="item red-item"/g) || []).length !== packet.redDeltas.length) {
    failures.push('red register row count does not match the owner packet');
  }
  if (
    (String(html).match(/<strong>Approval and implementation status<\/strong>/g) || [])
      .length !== packet.redDeltas.length
  ) {
    failures.push('red decisions are not visible on every row');
  }
  if (
    (String(html).match(/class="item watcher-item"/g) || []).length !==
    packet.watcherDeltas.length
  ) {
    failures.push('watcher register row count does not match the owner packet');
  }
  if (
    (String(html).match(/<strong>Implementation status<\/strong>/g) || []).length !==
    packet.watcherDeltas.length
  ) {
    failures.push('watcher implementation status is not visible on every row');
  }
  if (packet.executiveSummary.length < 1 || packet.executiveSummary.length > 2) {
    failures.push('executive summary is not one or two narrative paragraphs');
  }
  if (!String(html).includes('id="original-report-link"')) {
    failures.push('frozen original report link is missing');
  }
  if (/<th>State<\/th>|<th>Complete answer<\/th>/.test(String(html))) {
    failures.push('rejected State/Complete-answer report framing returned');
  }
  if (failures.length) {
    throw new Error(`owner feedback revision final QC failed: ${failures.join('; ')}`);
  }
  return { ok: true, failures: [] };
}

function renderOwnerFeedbackRevisionReport(rawPacket = {}) {
  const packet = normalizeOwnerFeedbackPacket(rawPacket);
  const tokenCitation = tokenExplorerReportCitation({ date: packet.date });
  const feedbackHtml = packet.feedbackAnswers
    .map(
      (row) =>
        `<article class="answer"><h3>${escapeHtml(row.question)}</h3><p>${escapeHtml(row.answer)}</p></article>`,
    )
    .join('\n');
  const tokensHtml = packet.tokenControls
    .map(
      (row) => `<article class="item token-control" id="${escapeHtml(row.stableId.toLowerCase())}">
<div class="stable-id">${escapeHtml(row.stableId)}</div><div><h3>${escapeHtml(row.title)}</h3>
${renderField('Status', row.status)}
${renderField('What ExampleCo experiences', row.problem)}
${renderField('Why it happened', row.rootCause)}
${renderField('What changes', row.change)}
${renderField('Estimated share of the measured 24-hour spend saved', row.estimatedSavings)}
${renderField('Basis and overlap', row.savingsBasis)}</div></article>`,
    )
    .join('\n');
  const prioritiesHtml = packet.strategicPriorities
    .map(
      (row, index) => `<article class="item strategic-fix priority-summary" id="priority-${index + 1}" data-rank="${index + 1}">
<div class="stable-id">${escapeHtml(row.stableId)}</div><div><h3>${escapeHtml(row.title)}</h3><p class="outcome-labels"><span class="outcome-chip">${escapeHtml(row.outcome)}</span></p>
${renderField('What went wrong', row.problem)}
${renderField('ExampleCo decision and implementation status', row.disposition)}
${renderField('How to fix or improve it', row.change)}
${renderField('What ExampleCo gets', row.value)}
${renderField('Estimated share of the measured 24-hour spend saved', row.estimatedSavings)}
${renderField('Savings basis and overlap', row.savingsBasis)}
${renderField('Impact, complexity, and risk', row.risk)}</div></article>
<article class="strategic-fix-evidence" data-strategic-evidence-rank="${index + 1}"><p><strong>Evidence</strong><br>${escapeHtml(row.evidence)}</p><p><strong>Briefing truth refs</strong><br>briefing:${escapeHtml(packet.date)}:board; token-spend:${escapeHtml(packet.date)}:24h</p></article>`,
    )
    .join('\n');
  const redHtml = packet.redDeltas
    .map(
      (row) => `<article class="item red-item"><div class="stable-id red">${escapeHtml(row.stableId)}</div><div><h3>${escapeHtml(row.title)}</h3>
${renderField('Approval and implementation status', row.disposition)}
${renderField('What went wrong', row.problem)}
${renderField('Root cause', row.rootCause)}
${renderField('What was attempted', row.attempts)}
${renderField('How to fix or improve it', row.change)}
${renderField('What ExampleCo gets', row.value)}
${renderField('Green proof', row.greenProof)}
${renderField('What ExampleCo needs to do', row.ExampleCoAction)}
${renderField('Impact, complexity, and risk', row.impactRisk)}</div></article>`,
    )
    .join('\n');
  const watcherHtml = packet.watcherDeltas
    .map(
      (row) => `<article class="item watcher-item"><div class="stable-id watcher">${escapeHtml(row.stableId)}</div><div><h3>${escapeHtml(row.title)}</h3>
${renderField('Implementation status', row.disposition)}
${renderField('What happened', row.problem)}
${renderField('Why it happened', row.rootCause)}
${renderField('What Amy did', row.action)}
${renderField('Practical result', row.result)}
${renderField('What remains or prevents recurrence', row.proposedFix)}
${renderField('What ExampleCo gets', row.value)}
${renderField('What ExampleCo needs to do', row.ExampleCoAction)}</div></article>`,
    )
    .join('\n');
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="watch-report-analysis" content="llm"><meta name="watch-report-date" content="${escapeHtml(packet.date)}"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Owner-reviewed revision: Overnight Strategic Report: night ending ${escapeHtml(packet.date)}</title>
<style>:root{color-scheme:dark;--bg:#0f1115;--panel:#171a21;--ink:#e8eaf0;--dim:#a5adba;--accent:#5eead4;--warn:#fbbf24;--red:#f87171;--line:#303641}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15.5px/1.62 "Segoe UI",system-ui,sans-serif}.wrap{max-width:940px;margin:auto;padding:34px 20px 80px}h1{font-size:26px;margin:0}h2{color:var(--accent);border-bottom:1px solid var(--line);padding-bottom:7px;margin:38px 0 14px}h3{margin:0 0 8px}.meta,.note{color:var(--dim)}.answer,.summary,.item,.method{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:17px 18px;margin:12px 0}.summary{border-left:4px solid var(--accent)}.summary p{font-size:16px;margin:0 0 14px}.summary p:last-child{margin-bottom:0}.item{display:grid;grid-template-columns:105px 1fr;gap:14px}.stable-id{color:var(--warn);font-weight:900;letter-spacing:.04em}.stable-id.red{color:var(--red)}.stable-id.watcher{color:var(--accent)}.item p{margin:8px 0}.outcome-chip{display:inline-block;border:1px solid var(--accent);color:var(--accent);border-radius:999px;padding:2px 8px;font-size:12px;font-weight:800}.strategic-fix-evidence{display:none}a{color:var(--accent)}@media(max-width:650px){.item{grid-template-columns:1fr}.stable-id{margin-bottom:-4px}}</style></head>
<body><main class="wrap"><h1>Overnight Strategic Report, owner-reviewed revision</h1><p class="meta">Night ending ${escapeHtml(packet.date)}. Only ExampleCo's requested changes are repeated here; the delivered original remains frozen. <a class="token-explorer-citation" href="${escapeHtml(tokenCitation.href)}">${escapeHtml(tokenCitation.label)}</a>.</p>
<h2>${OWNER_FEEDBACK_HEADING}</h2>${feedbackHtml}
<h2>Executive summary</h2><div class="summary">${packet.executiveSummary.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join('')}</div>
<h2>24-hour token spend Pareto and causal controls</h2><p class="note">${escapeHtml(packet.savingsNote)}</p>${tokensHtml}
<h2>Top five strategic fixes</h2><p class="note">These are rewritten around the Daily Briefing components ExampleCo knows, the practical value, and an honest savings estimate.</p>${prioritiesHtml}
<h2>Cards still red and what it takes to fix them</h2><p class="note">Every frozen red item appears once. Status says what is completed, what ExampleCo approved, and which proposals are still pending.</p>${redHtml}
<h2>Watcher interventions and what it takes to fix them</h2><p class="note">Every attended intervention appears once. The immediate rescue and the durable prevention are reported separately so a successful rescue is never mistaken for a completed prevention fix.</p>${watcherHtml}
<section class="method"><h3>Original frozen report</h3><p>The original remains unchanged as delivery history. <a id="original-report-link" href="${escapeHtml(packet.originalHref)}">Open the original frozen report.</a></p></section>
</main><script>try{const token=new URLSearchParams(window.location.search).get('k');if(token){for(const link of document.querySelectorAll('a')){const target=new URL(link.getAttribute('href'),window.location.origin);target.searchParams.set('k',token);link.href=target.toString();}}}catch{}</script></body></html>`;
  validateOwnerFeedbackRevisionHtml(html, packet);
  return html;
}

const V4_PROMPT_HEADING = "Answers from ExampleCo's prompt at August 20, 2026 at 5:18 PM CT";
const THREE_PART_LABELS = [
  'What went wrong',
  'How to fix or improve it',
  'Impact, complexity, and risk',
];

function normalizeThreePartRow(row, label) {
  const whatWentWrong = requireText(row?.whatWentWrong, `${label} What went wrong`);
  const howToFix = requireText(row?.howToFix, `${label} How to fix or improve it`);
  const graphPart = requireText(row?.graphPart, `${label} failed graph part`);
  const accountableOwner = requireText(row?.accountableOwner, `${label} accountable owner`);
  const guardFailure = requireText(row?.guardFailure, `${label} failed protection`);
  const strongerGraphPart = requireText(row?.strongerGraphPart, `${label} strengthened graph part`);
  for (const [field, value, visible] of [
    ['failed graph part', graphPart, whatWentWrong],
    ['accountable owner', accountableOwner, whatWentWrong],
    ['failed protection', guardFailure, whatWentWrong],
    ['strengthened graph part', strongerGraphPart, howToFix],
  ]) {
    if (!visible.toLowerCase().includes(value.toLowerCase())) {
      throw new Error(`${label} ${field} must appear in the visible three-part explanation`);
    }
  }
  return {
    ...row,
    stableId: requireText(row?.stableId, `${label} stableId`),
    title: requireText(row?.title, `${label} title`),
    status: requireText(row?.status, `${label} status`),
    whatWentWrong,
    howToFix,
    impactRisk: requireText(row?.impactRisk, `${label} Impact, complexity, and risk`),
    diagrams: Array.isArray(row?.diagrams) ? row.diagrams : [],
  };
}

function normalizeOwnerFeedbackV4Packet(packet = {}) {
  const date = requireText(packet.date, 'V4 date');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('V4 date must be YYYY-MM-DD');
  const expectedRedCount = Number(packet.expectedRedCount ?? 13);
  const expectedWatcherCount = Number(packet.expectedWatcherCount ?? 9);
  if (!Number.isInteger(expectedRedCount) || expectedRedCount < 1) {
    throw new Error('V4 expectedRedCount must be a positive integer');
  }
  if (!Number.isInteger(expectedWatcherCount) || expectedWatcherCount < 1) {
    throw new Error('V4 expectedWatcherCount must be a positive integer');
  }
  const redDeltas = requireExactIds(
    packet.redDeltas,
    'RED',
    expectedRedCount,
    'V4 red deltas',
  ).map(
    (row, index) => normalizeThreePartRow(row, `RED-${index + 1}`),
  );
  const watcherDeltas = requireExactIds(
    packet.watcherDeltas,
    'WATCHER',
    expectedWatcherCount,
    'V4 watcher deltas',
  ).map((row, index) => normalizeThreePartRow(row, `WATCHER-${index + 1}`));
  const updates = (Array.isArray(packet.updates) ? packet.updates : []).map((row, index) => ({
    stableId: requireText(row?.stableId, `V4 update ${index + 1} stableId`),
    title: requireText(row?.title, `V4 update ${index + 1} title`),
    status: requireText(row?.status, `V4 update ${index + 1} status`),
    result: requireText(row?.result, `V4 update ${index + 1} result`),
    evidence: requireText(row?.evidence, `V4 update ${index + 1} evidence`),
  }));
  if (!updates.length) throw new Error('V4 requires at least one changed or completed update');
  const summary = (Array.isArray(packet.summary) ? packet.summary : []).map((row, index) =>
    requireText(row, `V4 summary paragraph ${index + 1}`),
  );
  if (summary.length < 1 || summary.length > 2) {
    throw new Error('V4 summary must contain one or two paragraphs');
  }
  const versions = (Array.isArray(packet.versions) ? packet.versions : []).map((row, index) => ({
    label: requireText(row?.label, `V4 prior version ${index + 1} label`),
    href: requireText(row?.href, `V4 prior version ${index + 1} href`),
  }));
  if (!versions.length) throw new Error('V4 requires links to earlier report versions');
  const recordingCohort = packet.recordingCohort
    ? {
        status: requireText(packet.recordingCohort.status, 'V4 recording cohort status'),
        scope: requireText(packet.recordingCohort.scope, 'V4 recording cohort scope'),
        result: requireText(packet.recordingCohort.result, 'V4 recording cohort result'),
        href: requireText(packet.recordingCohort.href, 'V4 recording cohort report link'),
      }
    : null;
  return {
    ...packet,
    date,
    promptHeading: requireText(packet.promptHeading || V4_PROMPT_HEADING, 'V4 prompt heading'),
    summary,
    updates,
    recordingCohort,
    redDeltas,
    watcherDeltas,
    versions,
    expectedRedCount,
    expectedWatcherCount,
  };
}

function renderThreePartRow(row, kind) {
  const diagramHtml = row.diagrams
    .map(
      (diagram) =>
        `<figure><figcaption>${escapeHtml(diagram.title || '')}</figcaption>${String(diagram.svg || '')}</figure>`,
    )
    .join('');
  return `<article class="item ${kind}-item three-part" id="${escapeHtml(row.stableId.toLowerCase())}"><div class="stable-id ${kind}">${escapeHtml(row.stableId)}</div><div><h3>${escapeHtml(row.title)}</h3><span class="status">${escapeHtml(row.status)}</span>${THREE_PART_LABELS.map((label, index) => renderField(label, [row.whatWentWrong, row.howToFix, row.impactRisk][index])).join('')}${diagramHtml}</div></article>`;
}

function validateOwnerFeedbackV4Html(html, packet) {
  const failures = [];
  if (!String(html).includes(`<h1>${escapeHtml(packet.promptHeading)}</h1>`)) {
    failures.push('prompt heading is missing or changed');
  }
  if (
    (String(html).match(/class="item red-item three-part"/g) || []).length !==
    packet.expectedRedCount
  ) {
    failures.push(`V4 does not contain all ${packet.expectedRedCount} stable red rows`);
  }
  if (
    (String(html).match(/class="item watcher-item three-part"/g) || []).length !==
    packet.expectedWatcherCount
  ) {
    failures.push(`V4 does not contain all ${packet.expectedWatcherCount} stable watcher rows`);
  }
  for (const label of THREE_PART_LABELS) {
    const count = (String(html).match(new RegExp(`<strong>${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}<\\/strong>`, 'g')) || []).length;
    if (count !== packet.expectedRedCount + packet.expectedWatcherCount) {
      failures.push(`${label} must appear exactly once on every red and watcher row`);
    }
  }
  for (const forbidden of [
    '<strong>Root cause</strong>',
    '<strong>What was attempted</strong>',
    '<strong>What ExampleCo gets</strong>',
    '<strong>Green proof</strong>',
    '<strong>What ExampleCo needs to do</strong>',
  ]) {
    if (String(html).includes(forbidden)) failures.push(`forbidden extra field returned: ${forbidden}`);
  }
  const changedIndex = String(html).indexOf('<h2>What changed and what is completed</h2>');
  const redIndex = String(html).indexOf('<h2>All red items, rewritten</h2>');
  const historyIndex = String(html).indexOf('<h2>Earlier report remainder and versions</h2>');
  if (!(changedIndex >= 0 && redIndex > changedIndex && historyIndex > redIndex)) {
    failures.push('new material is not first or earlier versions are not lower down');
  }
  if (failures.length) throw new Error(`owner feedback V4 final QC failed: ${failures.join('; ')}`);
  return { ok: true, failures: [] };
}

function renderOwnerFeedbackV4Report(rawPacket = {}) {
  const packet = normalizeOwnerFeedbackV4Packet(rawPacket);
  const tokenCitation = tokenExplorerReportCitation({ date: packet.date });
  const updatesHtml = packet.updates
    .map(
      (row) => `<article class="update"><div><span class="stable-id">${escapeHtml(row.stableId)}</span> <span class="status">${escapeHtml(row.status)}</span></div><h3>${escapeHtml(row.title)}</h3>${renderField('Result', row.result)}${renderField('Evidence', row.evidence)}</article>`,
    )
    .join('');
  const cohort = packet.recordingCohort;
  const cohortHtml = cohort
    ? `<h2>Two-month Otter auto-recording cohort</h2><article class="cohort"><span class="status">${escapeHtml(cohort.status)}</span>${renderField('Scope', cohort.scope)}${renderField('Result', cohort.result)}<p><a id="recording-cohort-link" href="${escapeHtml(cohort.href)}">Open the per-call HTML audit.</a></p></article>`
    : '';
  const redHtml = packet.redDeltas.map((row) => renderThreePartRow(row, 'red')).join('');
  const watcherHtml = packet.watcherDeltas
    .map((row) => renderThreePartRow(row, 'watcher'))
    .join('');
  const versionsHtml = packet.versions
    .map((row) => `<li><a href="${escapeHtml(row.href)}">${escapeHtml(row.label)}</a></li>`)
    .join('');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="sb-status" content="IMPLEMENTED"><meta name="watch-report-analysis" content="llm"><meta name="watch-report-date" content="${escapeHtml(packet.date)}"><meta name="watch-report-version" content="v4"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(packet.promptHeading)}</title><style>:root{color-scheme:dark;--bg:#0c1017;--panel:#151b25;--ink:#edf2f7;--dim:#a8b2c2;--accent:#67e8f9;--red:#fb7185;--line:#2c3747;--green:#86efac;--amber:#fbbf24}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15.5px/1.62 "Segoe UI",system-ui,sans-serif}.wrap{max-width:1040px;margin:auto;padding:34px 20px 90px}h1{font-size:27px;line-height:1.25;margin:0 0 10px}h2{margin:38px 0 14px;color:var(--accent);border-bottom:1px solid var(--line);padding-bottom:8px}h3{margin:4px 0 8px}.summary,.update,.cohort,.item,.history{background:var(--panel);border:1px solid var(--line);border-radius:13px;padding:18px;margin:12px 0}.summary{border-left:4px solid var(--accent)}.item{display:grid;grid-template-columns:108px 1fr;gap:15px}.stable-id{font-weight:900;color:var(--amber);letter-spacing:.04em}.stable-id.red{color:var(--red)}.stable-id.watcher{color:var(--accent)}.status{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:2px 9px;color:var(--green);font-size:12px;font-weight:800}.item p,.update p{margin:10px 0}.note{color:var(--dim)}a{color:var(--accent)}figure{margin:18px 0;padding:12px;background:#0f1520;border:1px solid var(--line);border-radius:10px;overflow:auto}figcaption{font-weight:800;margin-bottom:10px}figure svg{max-width:100%;height:auto}@media(max-width:680px){.item{grid-template-columns:1fr}}</style></head><body><main class="wrap"><h1>${escapeHtml(packet.promptHeading)}</h1><p class="note">Version 4. New decisions, implementation results, and rewritten explanations appear first. Earlier versions remain linked below as history. <a class="token-explorer-citation" href="${escapeHtml(tokenCitation.href)}">${escapeHtml(tokenCitation.label)}</a>.</p><h2>What changed and what is completed</h2><div class="summary">${packet.summary.map((row) => `<p>${escapeHtml(row)}</p>`).join('')}</div>${updatesHtml}${cohortHtml}<h2>All red items, rewritten</h2><p class="note">Stable IDs are unchanged. Each row has only the three approved explanations; the badge carries status.</p>${redHtml}<h2>All watcher interventions, rewritten</h2>${watcherHtml}<h2>Earlier report remainder and versions</h2><section class="history"><p>Unchanged token controls and strategic priorities stay in the earlier reports and are not repeated as if they changed.</p><ul>${versionsHtml}</ul></section></main><script>try{const token=new URLSearchParams(location.search).get('k');if(token){for(const link of document.querySelectorAll('a')){const url=new URL(link.getAttribute('href'),location.origin);url.searchParams.set('k',token);link.href=url.toString();}}}catch{}</script></body></html>`;
  validateOwnerFeedbackV4Html(html, packet);
  return html;
}

function renderRoundTwoReport({ date, summary = '', sections = [], redRegister = [] } = {}) {
  const tokenCitation = tokenExplorerReportCitation({ date });
  const sectionHtml = (sections || [])
    .map(
      (section) =>
        `<section><h2>${escapeHtml(section.heading)}</h2>${(section.paragraphs || [])
          .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
          .join('')}</section>`,
    )
    .join('');
  const redHtml = redRegister.length
    ? `<section><h2>Red-item deltas</h2>${redRegister
        .map(
          (row) =>
            `<article data-red-id="${escapeHtml(row.id)}"><h3>Red ${row.number}: ${escapeHtml(row.title || row.id)}</h3><p>${escapeHtml(row.delta || '')}</p></article>`,
        )
        .join('')}</section>`
    : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(
    date ? `Briefing follow-up ${date}` : 'Briefing follow-up',
  )}</title></head><body><main><h1>${ROUND_TWO_HEADING}</h1><p>${escapeHtml(
    summary,
  )}</p><p><a class="token-explorer-citation" href="${escapeHtml(tokenCitation.href)}">${escapeHtml(tokenCitation.label)}</a>.</p>${sectionHtml}${redHtml}</main><script>try{const token=new URLSearchParams(location.search).get('k');if(token){for(const link of document.querySelectorAll('a')){const target=new URL(link.getAttribute('href'),location.origin);target.searchParams.set('k',token);link.href=target.toString();}}}catch{}</script></body></html>`;
}

module.exports = {
  OWNER_FEEDBACK_HEADING,
  ROUND_TWO_HEADING,
  normalizeOwnerFeedbackPacket,
  renderOwnerFeedbackRevisionReport,
  renderOwnerFeedbackV4Report,
  renderRoundTwoReport,
  stableRedRegister,
  validateOwnerFeedbackRevisionHtml,
  validateOwnerFeedbackV4Html,
  normalizeOwnerFeedbackV4Packet,
};
