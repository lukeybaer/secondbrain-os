'use strict';

function finite(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function parseClaudeJsonUsage(raw) {
  let payload;
  try {
    payload = JSON.parse(String(raw || '').trim());
  } catch {
    return { output: String(raw || ''), usage: null };
  }
  const source = payload.usage || {};
  const input = finite(source.input_tokens);
  const cached = finite(source.cache_creation_input_tokens) + finite(source.cache_read_input_tokens);
  const output = finite(source.output_tokens);
  const model = Object.keys(payload.modelUsage || {})[0] || payload.model || '';
  return {
    output: typeof payload.result === 'string' ? payload.result : String(raw || ''),
    usage: {
      provider: 'claude',
      model,
      input_tokens: input,
      cached_input_tokens: cached,
      output_tokens: output,
      total_tokens: input + cached + output,
      total_definition: 'non_cached_input_plus_cache_creation_plus_cache_read_plus_output',
    },
  };
}

function parseCodexJsonlUsage(raw) {
  const rows = String(raw || '')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((row) => row && row.type === 'turn.completed' && row.usage);
  if (!rows.length) return null;
  const source = rows[rows.length - 1].usage;
  const input = finite(source.input_tokens);
  const output = finite(source.output_tokens);
  return {
    provider: 'codex',
    model: rows[rows.length - 1].model || '',
    input_tokens: input,
    cached_input_tokens: finite(source.cached_input_tokens),
    output_tokens: output,
    total_tokens: input + output,
    total_definition: 'input_including_cached_subset_plus_output',
  };
}

module.exports = { parseClaudeJsonUsage, parseCodexJsonlUsage };
