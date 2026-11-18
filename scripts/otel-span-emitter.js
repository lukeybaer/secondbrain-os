#!/usr/bin/env node
// otel-span-emitter.js
//
// W3C Trace Context + OpenTelemetry GenAI semantic-convention span emitter.
//
// The existing src/main/tool-trace.ts emits a SecondBrain-custom shape
// {timestamp, tool, duration_ms, success, ...}. Useful for the briefing,
// but Jaeger / Tempo / Honeycomb / Grafana viewers consume the OTel JSON
// shape (trace_id / span_id / parent_span_id, start_ns / end_ns, status,
// attributes). This module emits OTel-shaped spans to a local jsonl so
// any standard viewer can render the call tree, and so attribute names
// follow gen_ai.* semantic conventions for cross-tool comparability.
//
// References:
//   - W3C Trace Context Level 2 (Mar 2026 candidate rec): traceparent
//     16-byte trace_id + 8-byte parent_id + 1-byte flags
//   - OpenTelemetry GenAI semantic conventions, Section 5 invoke_agent and
//     execute_tool spans (opentelemetry.io/docs/specs/semconv/gen-ai/)
//   - Agno 2026 multi-level metric rollup pattern (per-message, per-tool,
//     aggregated) maps cleanly to nested spans
//
// Pure module: no electron coupling, no network. Caller supplies the
// jsonl path (or env SECONDBRAIN_ROOT and the default location is used).
// Tests run against tmp dirs.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO_ROOT = () => process.env.SECONDBRAIN_ROOT || path.join(__dirname, '..');
const DEFAULT_SPANS_PATH = () => path.join(REPO_ROOT(), 'data', 'agent', 'otel-spans.jsonl');

const STATUS_OK = 'OK';
const STATUS_ERROR = 'ERROR';
const STATUS_UNSET = 'UNSET';

function newTraceId() {
  return crypto.randomBytes(16).toString('hex');
}

function newSpanId() {
  return crypto.randomBytes(8).toString('hex');
}

function nowNs() {
  // Process hrtime is monotonic; bigint nanoseconds + UNIX-epoch base.
  return BigInt(Date.now()) * 1_000_000n + (process.hrtime.bigint() % 1_000_000n);
}

function parseTraceparent(header) {
  if (typeof header !== 'string') return null;
  const parts = header.trim().split('-');
  if (parts.length !== 4) return null;
  const [version, traceId, parentId, flags] = parts;
  if (version.length !== 2) return null;
  if (traceId.length !== 32 || /[^0-9a-f]/i.test(traceId)) return null;
  if (parentId.length !== 16 || /[^0-9a-f]/i.test(parentId)) return null;
  if (flags.length !== 2 || /[^0-9a-f]/i.test(flags)) return null;
  if (/^0+$/.test(traceId) || /^0+$/.test(parentId)) return null;
  return { version, traceId, parentId, flags };
}

function formatTraceparent({ traceId, spanId, flags = '01' }) {
  if (!traceId || !spanId) throw new Error('formatTraceparent requires traceId and spanId');
  return `00-${traceId}-${spanId}-${flags}`;
}

function makeFileWriter(spanPath) {
  return (record) => {
    try {
      fs.mkdirSync(path.dirname(spanPath), { recursive: true });
      fs.appendFileSync(spanPath, JSON.stringify(record) + '\n');
    } catch {
      /* tracing is best-effort; never break the caller */
    }
  };
}

function _normalizeAttributes(attrs) {
  if (!attrs || typeof attrs !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue;
    out[k] = v;
  }
  return out;
}

function startSpan({
  name,
  traceId,
  parentSpanId = null,
  spanId = null,
  attributes = {},
  kind = 'INTERNAL',
  startTimeNs = null,
}) {
  if (!name || typeof name !== 'string') throw new Error('startSpan requires a non-empty name');
  const resolvedTraceId = traceId && /^[0-9a-f]{32}$/i.test(traceId) ? traceId : newTraceId();
  const resolvedSpanId = spanId && /^[0-9a-f]{16}$/i.test(spanId) ? spanId : newSpanId();
  return {
    name,
    trace_id: resolvedTraceId,
    span_id: resolvedSpanId,
    parent_span_id: parentSpanId || null,
    kind,
    start_time_unix_nano: (startTimeNs != null ? startTimeNs : nowNs()).toString(),
    attributes: _normalizeAttributes(attributes),
  };
}

function finishSpan(span, { status = STATUS_OK, error = null, attributes = {}, endTimeNs = null } = {}) {
  const finalAttrs = { ...span.attributes, ..._normalizeAttributes(attributes) };
  let finalStatus = status;
  if (error) {
    finalStatus = STATUS_ERROR;
    finalAttrs['error.type'] = error.name || 'Error';
    finalAttrs['error.message'] = error.message || String(error);
  }
  const endNs = (endTimeNs != null ? endTimeNs : nowNs()).toString();
  return {
    name: span.name,
    trace_id: span.trace_id,
    span_id: span.span_id,
    parent_span_id: span.parent_span_id,
    kind: span.kind,
    start_time_unix_nano: span.start_time_unix_nano,
    end_time_unix_nano: endNs,
    duration_ms: Number((BigInt(endNs) - BigInt(span.start_time_unix_nano)) / 1_000_000n),
    status: { code: finalStatus, message: error ? finalAttrs['error.message'] : undefined },
    attributes: finalAttrs,
  };
}

async function traceSpan(name, fn, options = {}) {
  const { writer, traceId, parentSpanId, attributes = {}, kind } = options;
  const span = startSpan({ name, traceId, parentSpanId, attributes, kind });
  try {
    const result = await fn({ traceId: span.trace_id, spanId: span.span_id, traceparent: formatTraceparent({ traceId: span.trace_id, spanId: span.span_id }) });
    const finished = finishSpan(span, { status: STATUS_OK, attributes: options.exitAttributes });
    if (writer) writer(finished);
    return result;
  } catch (err) {
    const finished = finishSpan(span, { error: err, attributes: options.exitAttributes });
    if (writer) writer(finished);
    throw err;
  }
}

function readSpans(spanPath) {
  if (!fs.existsSync(spanPath)) return [];
  return fs.readFileSync(spanPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function buildSpanTree(spans) {
  // Group spans by trace_id; under each trace, build a parent_span_id -> children map
  // and return roots (parent_span_id null OR parent not present in trace).
  const byTrace = new Map();
  for (const s of spans) {
    if (!byTrace.has(s.trace_id)) byTrace.set(s.trace_id, []);
    byTrace.get(s.trace_id).push(s);
  }
  const trees = [];
  for (const [traceId, traceSpans] of byTrace) {
    const ids = new Set(traceSpans.map((s) => s.span_id));
    const childrenOf = new Map();
    const roots = [];
    for (const s of traceSpans) {
      const parent = s.parent_span_id;
      if (!parent || !ids.has(parent)) roots.push(s);
      else {
        if (!childrenOf.has(parent)) childrenOf.set(parent, []);
        childrenOf.get(parent).push(s);
      }
    }
    function attach(s) {
      const children = (childrenOf.get(s.span_id) || []).map(attach);
      return { ...s, children };
    }
    trees.push({ trace_id: traceId, span_count: traceSpans.length, roots: roots.map(attach) });
  }
  return trees;
}

function summariseTraces(spans) {
  const trees = buildSpanTree(spans);
  let totalSpans = 0;
  let errorSpans = 0;
  let maxDepth = 0;
  function walk(node, depth) {
    totalSpans += 1;
    if (node.status && node.status.code === STATUS_ERROR) errorSpans += 1;
    if (depth > maxDepth) maxDepth = depth;
    for (const c of node.children || []) walk(c, depth + 1);
  }
  for (const tree of trees) for (const r of tree.roots) walk(r, 1);
  return {
    trace_count: trees.length,
    total_spans: totalSpans,
    error_spans: errorSpans,
    max_depth: maxDepth,
    error_rate: totalSpans === 0 ? 0 : errorSpans / totalSpans,
  };
}

module.exports = {
  STATUS_OK,
  STATUS_ERROR,
  STATUS_UNSET,
  newTraceId,
  newSpanId,
  parseTraceparent,
  formatTraceparent,
  makeFileWriter,
  startSpan,
  finishSpan,
  traceSpan,
  readSpans,
  buildSpanTree,
  summariseTraces,
  DEFAULT_SPANS_PATH,
};

if (require.main === module) {
  const spans = readSpans(DEFAULT_SPANS_PATH());
  process.stdout.write(JSON.stringify(summariseTraces(spans), null, 2) + '\n');
}
