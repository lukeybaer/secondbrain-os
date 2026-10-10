'use strict';

// Validate generated owner prose at a code-owned egress, never fabricate a
// summary or launch an additional model to repair it. Machine checkpoints are
// explicitly exempt; the caller, not model text, chooses the output kind.
function validateOwnerResponse(text, { outputKind = 'owner' } = {}) {
  if (outputKind === 'checkpoint') return { valid: true, errors: [], exempt: true };
  if (outputKind !== 'owner') return { valid: false, errors: ['unknown output kind'] };
  if (typeof text !== 'string' || !text.trim()) return { valid: false, errors: ['owner response is empty'] };
  const lines = text.trim().replace(/\r\n/g, '\n').split('\n');
  let fence = null;
  const prose = lines.map((line) => {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      return false;
    }
    return !fence;
  });
  const labels = ['Impact of adversarial review', 'Graphiti impact', 'TLDR'];
  const matches = labels.map((label) => {
    const regex = new RegExp(`^\\s*(?:#{1,6}\\s+)?(?:\\*\\*)?${label}(?:\\*\\*)?\\s*:(?:\\*\\*)?\\s*(.*)$`, 'i');
    return lines.flatMap((line, index) => {
      const match = prose[index] && line.match(regex);
      return match ? [{ index, content: match[1] }] : [];
    });
  });
  // Closing block (ExampleCo, 2026-09-24): TLDR is required, exactly once, on the
  // final line. `Impact of adversarial review` appears only when a peer
  // actually reviewed; `Graphiti impact` is dropped while Graphiti is off but
  // tolerated so an answer written to the older contract still validates.
  // Present lines keep the order review, Graphiti, TLDR.
  const errors = [];
  const REQUIRED = new Set(['TLDR']);
  labels.forEach((label, index) => {
    const count = matches[index].length;
    if (REQUIRED.has(label) && count !== 1) errors.push(`exactly one ${label}: line is required`);
    else if (!REQUIRED.has(label) && count > 1) errors.push(`at most one ${label}: line is allowed`);
  });
  if (!errors.length) {
    const present = matches.map((items) => items[0]).filter(Boolean);
    for (let i = 1; i < present.length; i += 1) {
      if (!(present[i - 1].index < present[i].index)) {
        errors.push('trailer order must be Impact of adversarial review, Graphiti impact, TLDR');
        break;
      }
    }
    const tldr = matches[2][0];
    if (tldr.index !== lines.length - 1) errors.push('TLDR must be the final line');
    matches.forEach((items, index) => { if (items[0] && !items[0].content.trim()) errors.push(`${labels[index]} requires content`); });
  }
  return { valid: errors.length === 0, errors };
}

function assertOwnerResponse(text, options) {
  const result = validateOwnerResponse(text, options);
  if (!result.valid) throw new Error(`owner response contract failed: ${result.errors.join('; ')}`);
  return text;
}

module.exports = { validateOwnerResponse, assertOwnerResponse };
