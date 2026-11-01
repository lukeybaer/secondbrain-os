'use strict';

// Configuration and observed faults are not a live successful model probe.
// /health is read-only: no retired-proxy probe, model call, or health-state write.
function buildSubscriptionBackendHealth({ readBrainStatus = () => require('./brain-switch').statusReport(), includeFaultDetails = false } = {}) {
  let brainState;
  try {
    const status = readBrainStatus();
    brainState = {
      order: status.order, reason: status.reason,
      demoted: Object.fromEntries(Object.entries(status.demoted || {}).map(([brain, fault]) => [brain, {
        kind: fault.kind, since: fault.since, until: fault.until,
        ...(includeFaultDetails ? { source: fault.source, sample: fault.sample } : {}),
      }])),
      strikes: status.strikes || {},
      ...(includeFaultDetails ? { recentEvents: status.history || [], lastReceiptError: status.lastReceiptError || null } : {}),
    };
  } catch (error) {
    brainState = { readError: includeFaultDetails ? String(error.message || error).slice(0, 300) : 'brain-switch health evidence unavailable' };
  }
  return {
    source: 'subscription CLI (Claude Code / Codex)',
    routeType: 'subscription-cli', scope: 'nonvoice-default',
    cost: 'subscription (no per-token API fallback)',
    availability: 'unverified', brainState,
    maxPlanProxy: 'retired', maxPlanProxyState: 'retired',
    maxPlanProxyDetail: 'Desktop proxy is retired from normal backend routing.',
    maxPlanProxyOwnerAction: null, maxPlanProxyProofAt: null, maxPlanProxyProofSource: null,
  };
}

function classifyLlmHealth(llm = {}) {
  const src = llm.source || 'unknown LLM source';
  if (llm.routeType === 'subscription-cli') {
    const state = llm.brainState || {};
    const faults = Object.entries(state.demoted || {}).map(([brain, fault]) =>
      `${brain}: ${fault.kind}, until ${fault.until}; ${fault.sample || 'inspect local provider receipts for detail'}`);
    for (const [brain, count] of Object.entries(state.strikes || {})) {
      if (count > 0) faults.push(`${brain}: ${count} unresolved failure strike(s)`);
    }
    return {
      status: faults.length ? 'red' : 'yellow',
      detail: `${src}; ${faults.length ? faults.join(' | ') : 'provider availability unverified'}${state.readError ? `; ${state.readError}` : ''}`,
      routeType: llm.routeType, proxyState: 'retired', ownerAction: null,
      brainState: state,
    };
  }
  const proxyState =
    llm.maxPlanProxyState || (llm.maxPlanProxy === 'connected' ? 'healthy' : 'unreachable');
  if (llm.maxPlanProxy === 'connected' && /claude-max-plan|FREE/.test(src)) {
    return {
      status: 'green',
      detail: llm.maxPlanProxyProofSource
        ? `${src}, live proof ${llm.maxPlanProxyProofSource}`
        : src,
      proxyState,
      ownerAction: null,
    };
  }
  const detail = llm.maxPlanProxyDetail || 'no current live proof';
  return {
    status: 'red',
    detail: `${src}, maxPlanProxy ${proxyState}: ${detail}`,
    proxyState,
    ownerAction: llm.maxPlanProxyOwnerAction || null,
  };
}

module.exports = { buildSubscriptionBackendHealth, classifyLlmHealth };
