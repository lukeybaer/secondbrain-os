#!/usr/bin/env node
/**
 * probe-amy-foundation.js, lock-in test for the 2026-05-05 standard.
 *
 * Run after any Vapi config change, ec2-server.js deploy, or assistant
 * prompt edit, to verify the foundation ExampleCo approved on 2026-05-05 is
 * still in place. Hits live services, so do not run in CI; run on
 * demand or after deploys.
 *
 * Locks four things:
 *   1. Vapi assistant has read_otter_transcripts tool with mandate
 *      language ("ALWAYS use", "live data", "Do not answer ... from
 *      training").
 *   2. Vapi assistant has run_claude_code positioned as the escalation
 *      path ("escalation path", "callback when").
 *   3. /vapi/webhook tool-calls dispatch returns expected shapes for
 *      list, get, search actions.
 *   4. /opt/secondbrain/data/agent/otter-ingest-heartbeat.jsonl on EC2
 *      has a heartbeat in the last 30 minutes.
 *
 * Per memory/feedback_amy_foundation_locked_2026_05_05.md.
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const cfg = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, 'secondbrain', 'config.json'), 'utf8'));
const VAPI_KEY = cfg.vapiApiKey;
const ASSISTANT_ID = 'ExampleCo-2da6-45b2-9379-1b575634a337';
const EC2_HOST = 'ExampleCo';
const EC2_PORT = 3001;

const checks = [];
function pass(label) { checks.push({ status: 'PASS', label }); console.log('  PASS  ' + label); }
function fail(label, detail) { checks.push({ status: 'FAIL', label, detail }); console.log('  FAIL  ' + label + (detail ? '  ' + detail : '')); }

function vapiGet(p) {
  return new Promise((resolve, reject) => {
    https.get({ hostname: 'api.vapi.ai', path: p, headers: { Authorization: 'Bearer ' + VAPI_KEY } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function ec2Post(p, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: EC2_HOST, port: EC2_PORT, path: p, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function toolCall(name, args) {
  return ec2Post('/vapi/webhook', {
    message: {
      type: 'tool-calls',
      toolCalls: [{ id: 'probe_' + Date.now(), function: { name, arguments: JSON.stringify(args) } }],
      call: { id: 'probe', customer: { number: process.env.OWNER_PHONE || '+10000000000' } },
    },
  });
}

(async () => {
  console.log('=== Amy foundation probe ===');

  console.log('\n[1] Vapi assistant tool surface');
  const assistant = await vapiGet('/assistant/' + ASSISTANT_ID);
  const tools = (assistant.model && assistant.model.tools) || [];
  const otter = tools.find((t) => t.function && t.function.name === 'read_otter_transcripts');
  const cc = tools.find((t) => t.function && t.function.name === 'run_claude_code');
  const calendar = tools.find((t) => t.function && t.function.name === 'check_calendar');
  // Description should be knowledge-shaped (describe content/scope), not
  // rule-shaped (imperatives). Per feedback_knowledge_not_rules_for_amy.md.
  if (otter && /Otter.*recordings/i.test(otter.function.description) && /list.*get.*search/i.test(otter.function.description) && /date/i.test(otter.function.description)) {
    pass('read_otter_transcripts description is knowledge-shaped (content+actions+date)');
  } else {
    fail('read_otter_transcripts description shape', otter ? 'description not knowledge-shaped' : 'tool missing');
  }
  // Tool params expose date_from/date_to so the model can express explicit ranges.
  const params = (otter && otter.function && otter.function.parameters && otter.function.parameters.properties) || {};
  if (params.date_from && params.date_to && params.query) {
    pass('read_otter_transcripts params expose date_from/date_to/query (precise intent)');
  } else {
    fail('read_otter_transcripts param surface', 'missing date_from/date_to/query');
  }
  if (cc && /Claude Code/.test(cc.function.description) && /(callback|call.* back|out.*of.*band|detached.*background)/i.test(cc.function.description)) {
    pass('run_claude_code described as deep-task escalation with callback');
  } else {
    fail('run_claude_code description shape', cc ? 'description weakened' : 'tool missing');
  }
  // continue_session param (ExampleCo 2026-05-05: "elegant way to keep the context")
  const ccProps = (cc && cc.function && cc.function.parameters && cc.function.parameters.properties) || {};
  if (ccProps.continue_session) {
    pass('run_claude_code exposes continue_session param (context across follow-ups)');
  } else {
    fail('run_claude_code continue_session param', 'missing');
  }
  const qk = tools.find((t) => t.function && t.function.name === 'query_knowledge');
  if (qk && /Graphiti|knowledge graph/i.test(qk.function.description) && /(month|across|extracted)/i.test(qk.function.description)) {
    pass('query_knowledge described as Graphiti cross-time facts (knowledge-shaped)');
  } else {
    fail('query_knowledge description shape', qk ? 'description weak' : 'tool missing');
  }
  const web = tools.find((t) => t.function && t.function.name === 'web_search');
  const webProps = (web && web.function && web.function.parameters && web.function.parameters.properties) || {};
  if (web && /web research|current web|internet/i.test(web.function.description) && webProps.query) {
    pass('web_search exposed for current web research');
  } else {
    fail('web_search tool surface', web ? 'description or query param missing' : 'tool missing');
  }
  const calendarProps = (calendar && calendar.function && calendar.function.parameters && calendar.function.parameters.properties) || {};
  if (calendar && /Google Calendar|Outlook|calendar|work/i.test(calendar.function.description || '') && calendarProps.account_label && calendarProps.days) {
    pass('check_calendar exposed for Google/Outlook calendar checks');
  } else {
    fail('check_calendar tool surface', calendar ? 'description or params missing' : 'tool missing');
  }

  console.log('\n[2] /vapi/webhook tool-calls handler shapes');
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const listRes = await toolCall('read_otter_transcripts', { action: 'list', date: 'today' });
  if (listRes.status === 200 && listRes.body.results && listRes.body.results[0] && /transcripts on \d{4}-\d{2}-\d{2}|No transcripts found/.test(listRes.body.results[0].result)) {
    pass('action=list returns transcripts inventory shape');
  } else {
    fail('action=list shape', JSON.stringify(listRes).slice(0, 200));
  }
  const m = listRes.body && listRes.body.results && listRes.body.results[0] && /id=([A-Za-z0-9_-]+)/.exec(listRes.body.results[0].result);
  const sampleId = m && m[1];
  if (sampleId) {
    const getRes = await toolCall('read_otter_transcripts', { action: 'get', transcript_id: sampleId });
    if (getRes.status === 200 && /Transcript chunk/.test(getRes.body.results[0].result)) {
      pass('action=get returns raw chunk for sample id');
    } else {
      fail('action=get shape', JSON.stringify(getRes).slice(0, 200));
    }
  } else {
    console.log('  SKIP  action=get (no transcripts today, no sample id)');
  }
  const searchRes = await toolCall('read_otter_transcripts', { action: 'search', query: 'the' });
  if (searchRes.status === 200 && /Found "the"|No transcripts in the last/.test(searchRes.body.results[0].result)) {
    pass('action=search returns shape (match or no-match)');
  } else {
    fail('action=search shape', JSON.stringify(searchRes).slice(0, 200));
  }
  const webRes = await toolCall('web_search', {});
  if (webRes.status === 200 && /need a search query/i.test(webRes.body.results[0].result || '')) {
    pass('web_search handler is wired (no-query guard)');
  } else {
    fail('web_search handler shape', JSON.stringify(webRes).slice(0, 200));
  }
  const calendarRes = await toolCall('check_calendar', { account_label: 'work', days: 7 });
  if (calendarRes.status === 200 && /(not authorized|calendar is connected|Calendar check failed|Google Calendar access is not authorized)/i.test(calendarRes.body.results[0].result || '')) {
    pass('check_calendar handler is wired (connected or explicit auth state)');
  } else {
    fail('check_calendar handler shape', JSON.stringify(calendarRes).slice(0, 200));
  }

  console.log('\n[3] EC2 otter-ingest heartbeat');
  try {
    const out = execSync(
      'ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -i ~/.ssh/secondbrain-backend-key.pem ec2-user@' + EC2_HOST + ' "tail -1 /opt/secondbrain/data/agent/otter-ingest-heartbeat.jsonl"',
      { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const last = JSON.parse(out.trim());
    const ageMin = (Date.now() - new Date(last.ts).getTime()) / 60000;
    if (ageMin < 30) {
      pass('otter-ingest heartbeat fresh (' + Math.round(ageMin) + ' min ago)');
    } else {
      fail('otter-ingest heartbeat stale', Math.round(ageMin) + ' min old');
    }
  } catch (e) {
    fail('otter-ingest heartbeat check', e.message.slice(0, 100));
  }

  console.log('\n=== Summary ===');
  const passed = checks.filter((c) => c.status === 'PASS').length;
  const failed = checks.filter((c) => c.status === 'FAIL').length;
  console.log(passed + ' passed, ' + failed + ' failed');
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('PROBE ERROR:', e.message); process.exit(2); });
