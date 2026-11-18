'use strict';

// Structural validation at the shared native/launcher egress. This cannot prove
// a completion percentage or live delivery, and never fabricates response text.
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
    const suffix = label === 'TLDR' ? '(?:\\s*\\(([^)]*)\\))?' : '';
    const regex = new RegExp('^\\s*(?:#{1,6}\\s+)?(?:\\*\\*)?' + label + suffix + '(?:\\*\\*)?\\s*:(?:\\*\\*)?\\s*(.*)$', 'i');
    return lines.flatMap((line, index) => {
      const match = prose[index] && line.match(regex);
      return match ? [{ index, content: match.at(-1), format: label === 'TLDR' ? match[1] : undefined }] : [];
    });
  });
  // Legacy simple answers keep a final TLDR: line. Current task closeouts end
  // with a percent TLDR header and Need then Done bullets. Optional peer lines
  // remain optional; old Graphiti lines are tolerated for compatibility only.
  const errors = [];
  labels.forEach((label, index) => {
    const count = matches[index].length;
    if (label === 'TLDR' && count !== 1) errors.push('exactly one TLDR: line is required');
    else if (label !== 'TLDR' && count > 1) errors.push('at most one ' + label + ': line is allowed');
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
    if (tldr.format !== undefined) {
      const header = /^(100|[0-9]{1,2})(?:\.[0-9]+)?% done(?: - (?:rest on me|need [1-9][0-9]* more yes))?$/i.exec(tldr.format);
      if (!header || Number.parseFloat(tldr.format) > 100) errors.push('invalid TLDR completion format');
      const bullet = /^([ \t]*)[-*+]\s+(?:\*\*)?(Need|Done)(?:\*\*)?\s*:(?:\*\*)?\s*(.*)$/i;
      const items = [];
      let validTail = true;
      for (let index = tldr.index + 1; index < lines.length; index += 1) {
        const line = lines[index];
        if (!line.trim()) continue;
        if (!prose[index]) { validTail = false; break; }
        const match = line.match(bullet);
        const indent = line.match(/^[ \t]*/)[0].replace(/\t/g, '    ').length;
        const current = items.at(-1);
        if (match && (!current || indent <= current.indent)) {
          items.push({ label: match[2].toLowerCase(), indent, hasContent: Boolean(match[3].trim()) });
        } else if (current && indent > current.indent) {
          // Markdown continuation belongs to the current bullet; unindented
          // prose and a third top-level item are never trailer content.
          current.hasContent = true;
        } else { validTail = false; break; }
      }
      if (!validTail || items.length !== 2 || items[0].label !== 'need' || items[1].label !== 'done' || items.some(item => !item.hasContent)) {
        errors.push('task TLDR must end with nonempty Need: then Done: bullets');
      }
    } else if (tldr.index !== lines.length - 1) errors.push('TLDR must be the final line');
    matches.forEach((items, index) => { if (items[0] && !items[0].content.trim()) errors.push(labels[index] + ' requires content'); });
  }
  return { valid: errors.length === 0, errors };
}
function assertOwnerResponse(text, options) {
  const result = validateOwnerResponse(text, options);
  if (!result.valid) throw new Error('owner response contract failed: ' + result.errors.join('; '));
  return text;
}
module.exports = { validateOwnerResponse, assertOwnerResponse };
