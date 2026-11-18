'use strict';

// Progress lines from a chat engine's stream (Chat harness fix 2, owner decision).
//
// A chat ask now runs as a watched job, like the overnight work: no guessed time
// limit, and the job progress reader reads its progress every five minutes and restarts
// it only when it has gone wrong. The reader reads a 16 KB tail, so the raw stream-json
// (whole tool results, system rows) would hide what the engine is doing. This turns each
// stream row into one short line: the tool it called and on what, what came back and how
// big, and what it said.

const LINE_CHARS = 240;
const TARGET_KEYS = ['file_path', 'path', 'pattern', 'query', 'url', 'command', 'q', 'thread_id', 'message_id', 'task_id'];

function clip(value, max = LINE_CHARS) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function targetOf(input) {
  if (!input || typeof input !== 'object') return '';
  for (const key of TARGET_KEYS) if (input[key] != null && input[key] !== '') return clip(input[key], 160);
  return clip(Object.keys(input).join(', '), 80);
}

function resultText(content) {
  if (Array.isArray(content)) return content.map((part) => (part?.type === 'text' ? part.text : '')).join(' ');
  return typeof content === 'string' ? content : JSON.stringify(content ?? '');
}

// The lines one stream row stands for; none for rows that say nothing about the work.
function linesFromRow(row) {
  if (!row || typeof row !== 'object') return [];
  const lines = [];
  // Claude stream-json.
  const content = Array.isArray(row.message?.content) ? row.message.content : [];
  if (row.type === 'assistant') {
    for (const block of content) {
      if (block?.type === 'tool_use') lines.push(`tool ${block.name} ${targetOf(block.input)}`.trim());
      else if (block?.type === 'text' && block.text?.trim()) lines.push(`said: ${clip(block.text)}`);
    }
  } else if (row.type === 'user') {
    for (const block of content) {
      if (block?.type !== 'tool_result') continue;
      const text = resultText(block.content);
      lines.push(`${block.is_error ? 'tool error' : 'tool result'} (${text.length} chars): ${clip(text, 160)}`);
    }
  } else if (row.type === 'result') {
    lines.push(`engine finished: ${row.subtype || (row.is_error ? 'error' : 'done')}`);
  }
  // Codex --json.
  const item = row.item;
  if (item && typeof item === 'object' && (row.type === 'item.started' || row.type === 'item.completed')) {
    const done = row.type === 'item.completed';
    if (item.type === 'agent_message' && done) lines.push(`said: ${clip(item.text)}`);
    else if (item.type === 'reasoning') {
      // Its thinking is not progress.
    } else if (item.type === 'mcp_tool_call') lines.push(`${done ? 'tool done' : 'tool'} ${item.tool || item.name || 'mcp'}${item.status === 'failed' ? ' (failed)' : ''}`);
    else if (item.type) {
      const what = clip(item.command || item.query || item.url || item.path || '', 160);
      const status = done ? (item.status === 'failed' || (item.exit_code != null && item.exit_code !== 0) ? ' (failed)' : ' (done)') : '';
      lines.push(`${item.type} ${what}${status}`.trim());
    }
  }
  return lines;
}

// Feed raw stdout chunks; each complete line becomes zero or more progress lines.
function createStreamProgress(note) {
  let pending = '';
  const emit = (line) => {
    if (!line.trim()) return;
    let row = null;
    try {
      row = JSON.parse(line);
    } catch {
      note(`output: ${clip(line)}`);
      return;
    }
    for (const text of linesFromRow(row)) note(text);
  };
  return {
    push(chunk) {
      pending += String(chunk || '');
      const parts = pending.split(/\r?\n/);
      pending = parts.pop() || '';
      for (const part of parts) emit(part);
    },
    flush() {
      const rest = pending;
      pending = '';
      emit(rest);
    },
  };
}

module.exports = { createStreamProgress, linesFromRow };
