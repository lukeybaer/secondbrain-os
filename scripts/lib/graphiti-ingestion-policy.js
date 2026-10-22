'use strict';

const fs = require('node:fs');
const path = require('node:path');
const POLICY_PATH = path.resolve(__dirname, '../../config/graphiti-runtime-policy.json');

// Read on every boundary. Missing, invalid, or pre-shutdown policy fails closed.
function graphitiIngestionAdmission({ policyPath = POLICY_PATH } = {}) {
  try {
    const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
    const allowed = policy.state === 'enabled' && policy.ingestion_state === 'enabled';
    const ownerDisabled = policy.schema === 'secondbrain.graphiti-runtime-policy.v1' &&
      policy.state === 'disabled' && policy.ingestion_state === 'disabled';
    return {
      allowed,
      ownerDisabled,
      deferred: !allowed,
      reason: allowed ? 'graphiti-ingestion-enabled' : 'graphiti-ingestion-disabled-by-owner',
      resumeAfter: null,
    };
  } catch {
    return { allowed: false, ownerDisabled: false, deferred: true, reason: 'graphiti-ingestion-policy-unavailable', resumeAfter: null };
  }
}

function assertGraphitiIngestionEnabled() {
  const admission = graphitiIngestionAdmission();
  if (!admission.allowed) throw new Error(admission.reason);
}

module.exports = { graphitiIngestionAdmission, assertGraphitiIngestionEnabled };
if (require.main === module) {
  const admission = graphitiIngestionAdmission();
  console.log(JSON.stringify(admission));
  process.exitCode = admission.allowed ? 0 : 3;
}
