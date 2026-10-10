'use strict';
/**
 * directive-fidelity-receipt.js
 *
 * Generic producer-side writer for the SHA-bound receipt that
 * analyze-rejection-directive-fidelity.py (video-quality-tools) requires
 * before it will score `rejection_directive_fidelity` above 0.
 *
 * Human rejection feedback often names production facts pixels alone
 * cannot verify (speaker identity, source lineage, an exact requested
 * wording change). The producer that applies the fix is the only party
 * that can measure whether the fix actually landed in the final bytes,
 * so it writes this receipt beside the final MP4. The analyzer then
 * independently re-hashes the video and validates the receipt's shape;
 * it never trusts the content of an assertion, only that the schema is
 * satisfied and every assertion is honestly reported as passed.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DIRECTIVE_FIDELITY_SCHEMA = 'secondbrain.video-directive-fidelity.v1';

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function directiveFidelityReceiptPath(videoPath) {
  return `${path.resolve(String(videoPath))}.directive-fidelity.json`;
}

/**
 * @param {object} opts
 * @param {string} opts.videoPath - path to the final, already-written MP4.
 * @param {Array<{id: string, description?: string, passed: boolean, method: string, evidence: string}>} opts.assertions
 * @returns {string} the receipt path written.
 */
function writeDirectiveFidelityReceipt({ videoPath, assertions, feedback }) {
  if (!videoPath || !fs.existsSync(videoPath)) {
    throw new Error(`writeDirectiveFidelityReceipt: video not found at ${videoPath}`);
  }
  if (!Array.isArray(assertions) || assertions.length === 0) {
    throw new Error('writeDirectiveFidelityReceipt requires at least one assertion');
  }
  const ids = assertions.map((a) => a && a.id);
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
    throw new Error('directive assertion ids must be unique and non-empty');
  }
  for (const a of assertions) {
    if (!a.method || !a.evidence) {
      throw new Error(`directive assertion "${a.id}" must carry measured method + evidence`);
    }
  }

  const receipt = {
    schema: DIRECTIVE_FIDELITY_SCHEMA,
    video_sha256: sha256File(videoPath),
    video_bytes: fs.statSync(videoPath).size,
    generated_at: new Date().toISOString(),
    assertions,
    ...(feedback ? { feedback: String(feedback) } : {}),
    required_assertion_ids: ids,
  };

  const receiptPath = directiveFidelityReceiptPath(videoPath);
  fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2), 'utf8');
  return receiptPath;
}

module.exports = {
  DIRECTIVE_FIDELITY_SCHEMA,
  sha256File,
  directiveFidelityReceiptPath,
  writeDirectiveFidelityReceipt,
};
