'use strict';

// Paged broker reads (Chat harness fix 3, owner decision).
//
// The checker shows the judge at most RESULT_EXCERPT_CHARS of any one result and
// cuts the middle out of anything longer, so a fact that sits in the middle of a
// long transcript or thread could never be shown. Every read capability now takes
// page_offset and page_chars: the broker runs the read as usual, turns the result
// into plain text, and returns just that window with where the next one starts.
// A page is never longer than the judge's excerpt, so it is seen whole.

const PAGE_CHARS_MAX = 10_000;
// A result longer than this is cut in the judge's view (RESULT_EXCERPT_CHARS).
const LONG_RESULT_CHARS = 12_000;

const PAGING_PROPERTIES = Object.freeze({
  page_offset: {
    type: 'integer',
    description: 'Paged read: the character to start at in this result as plain text (0 for the start). Use next_offset from the last page.',
  },
  page_chars: {
    type: 'integer',
    description: `Paged read: how many characters to return, at most ${PAGE_CHARS_MAX}.`,
  },
});

// One plain-text rendering of any result, used for paging and for checking quotes,
// so a quote copied from a page is found in the same text.
function readableText(value, depth = 0) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (depth > 12) return '';
  if (Array.isArray(value)) {
    return value
      .map((item) => readableText(item, depth + 1))
      .filter(Boolean)
      .join('\n');
  }
  if (typeof value === 'object') {
    return Object.entries(value)
      .map(([key, item]) => {
        const text = readableText(item, depth + 1);
        if (!text) return '';
        return item !== null && typeof item === 'object' ? `${key}:\n${text}` : `${key}: ${text}`;
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function wholeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : null;
}

// Paging arguments are the broker's, not the executor's: they are taken off before
// the capability's own schema check and executor see the call.
function splitPaging(args = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { paging: null, rest: args };
  if (args.page_offset === undefined && args.page_chars === undefined) return { paging: null, rest: args };
  const { page_offset: offset, page_chars: chars, ...rest } = args;
  return {
    paging: {
      offset: wholeNumber(offset) ?? 0,
      chars: Math.min(PAGE_CHARS_MAX, Math.max(1, wholeNumber(chars) || PAGE_CHARS_MAX)),
    },
    rest,
  };
}

// A successful read result, shaped for paging. A failed result is left alone.
function pageReadResult(result, paging) {
  if (!result || typeof result !== 'object' || result.ok === false) return result;
  if (!paging) {
    const total = readableText(result).length;
    if (total <= LONG_RESULT_CHARS) return result;
    return {
      ...result,
      paging_hint: `This result is ${total} characters as text; the checker sees only part of anything over ${LONG_RESULT_CHARS}. To read or cite a part past the start, call this tool again with the same arguments plus page_offset and page_chars (at most ${PAGE_CHARS_MAX}).`,
    };
  }
  const text = readableText(result);
  const start = Math.min(paging.offset, text.length);
  const end = Math.min(text.length, start + paging.chars);
  return {
    ok: true,
    page: {
      offset: start,
      chars: end - start,
      total_chars: text.length,
      next_offset: end < text.length ? end : null,
    },
    text: text.slice(start, end),
  };
}

// Every read capability publishes the paging arguments, so the engine sees them in
// tools/list. A schema with no properties object gets one.
function withPagingSchema(schema) {
  const base = schema && typeof schema === 'object' ? schema : { type: 'object', additionalProperties: true };
  return Object.freeze({ ...base, properties: { ...(base.properties || {}), ...PAGING_PROPERTIES } });
}

module.exports = {
  LONG_RESULT_CHARS,
  PAGE_CHARS_MAX,
  PAGING_PROPERTIES,
  pageReadResult,
  readableText,
  splitPaging,
  withPagingSchema,
};
