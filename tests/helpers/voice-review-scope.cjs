'use strict';
// Test helper: the real voice review page helpers from ec2-server.js, ready to
// drop into a compileBlock scope for the voice-confirmation card branches.
const H = require('./ec2-render-block.cjs');

function voiceReviewScope() {
  const VOICE_REVIEW_INLINE_LIMIT = H.topLevelConst('VOICE_REVIEW_INLINE_LIMIT');
  const VOICE_REVIEW_RANKED_CEILING = H.topLevelConst('VOICE_REVIEW_RANKED_CEILING');
  const helpers = H.compileBlock(
    [],
    `${H.sliceBlock('function voiceReviewPageState(d) {', '\nfunction voiceClusterMaximumState(data) {')}\nreturn { voiceReviewPageState, voiceProposedNameStat };`,
    { VOICE_REVIEW_INLINE_LIMIT, VOICE_REVIEW_RANKED_CEILING },
  )();
  return { VOICE_REVIEW_INLINE_LIMIT, VOICE_REVIEW_RANKED_CEILING, ...helpers };
}

module.exports = { voiceReviewScope };
