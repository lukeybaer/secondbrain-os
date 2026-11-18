'use strict';

const path = require('node:path');
const { VERBATIM_ROUTING_RULES } = require('./model-router.js');

const REPORT_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isReportDate(value) {
  const text = String(value || '');
  if (!REPORT_DATE_RE.test(text)) return false;
  const parsed = new Date(`${text}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text;
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}

function compact(value, max = 1200) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function formatTokens(value) {
  const number = Math.max(0, Number(value) || 0);
  if (number >= 1e9) return `${(number / 1e9).toFixed(2)}B`;
  if (number >= 1e6) return `${(number / 1e6).toFixed(1)}M`;
  if (number >= 1e3) return `${(number / 1e3).toFixed(1)}K`;
  return String(Math.round(number));
}

function tokenExplorerHref({ date = '', promptId = '', focus = '', quote = '' } = {}) {
  const query = new URLSearchParams();
  if (date) {
    if (!isReportDate(date)) {
      throw new Error('Token Explorer report date must be YYYY-MM-DD');
    }
    query.set('date', String(date));
  }
  if (promptId) query.set('prompt', String(promptId).slice(0, 160));
  if (focus) query.set('focus', String(focus).slice(0, 200));
  if (quote) query.set('quote', compact(quote, 500));
  const suffix = query.toString();
  const anchor = promptId ? `#prompt-${encodeURIComponent(String(promptId).slice(0, 160))}` : '';
  return `/briefing/token-explorer${suffix ? `?${suffix}` : ''}${anchor}`;
}

function tokenExplorerReportCitation({ date = '', promptId = '', focus = '', quote = '' } = {}) {
  const focused = Boolean(promptId && focus);
  return {
    href: tokenExplorerHref({ date, promptId, focus, quote }),
    label: focused
      ? 'Open the cited prompt and highlighted generation in Token Explorer'
      : 'Open this report date in Token Explorer',
    focused,
  };
}

function resolveTokenExplorerReportPath({ dataRoot, url = '/briefing/token-explorer' } = {}) {
  const parsed = new URL(url, 'http://localhost');
  const date = String(parsed.searchParams.get('date') || '');
  if (date && !isReportDate(date)) {
    return {
      ok: false,
      status: 400,
      reason: 'Token Explorer report date must be YYYY-MM-DD',
    };
  }
  return {
    ok: true,
    date,
    path: path.join(
      dataRoot,
      'agent',
      date ? `token-spend-pareto-overnight-${date}.json` : 'token-spend-pareto-latest.json',
    ),
  };
}

function routeChoice(meta = {}) {
  const actualModel = compact(meta.model || 'unknown', 100);
  const actualEffort = compact(meta.effort || 'unknown', 40);
  const receipt = meta.routeReceipt;
  const decision = receipt && receipt.decision;
  if (!decision) {
    return {
      verdict: 'unprovable',
      recommended: 'not recorded',
      explanation:
        meta.routeExplanation ||
        'No correlated route decision receipt exists. Optimality is not inferred from prompt prose.',
    };
  }
  const recommended = `${decision.model || 'unknown'} / ${decision.effort || 'unknown'}`;
  const matches = actualModel === decision.model && actualEffort === decision.effort;
  return {
    verdict: matches ? 'optimal' : 'sub-optimal',
    recommended,
    explanation: matches
      ? `Matched ${receipt.ruleId || 'the receipted rule'}: ${decision.reason || 'no reason recorded'}`
      : `Actual ${actualModel} / ${actualEffort}; ${receipt.ruleId || 'receipted rule'} required ${recommended}. ${decision.reason || 'No additional reason was recorded.'}`,
  };
}

function weeklyPlanAllocation(row, codexUsage = {}) {
  const usedPercent = Number(codexUsage.weekly_used_percent);
  const measuredWeekTokens =
    Number(codexUsage.weekly_input_tokens || 0) + Number(codexUsage.weekly_output_tokens || 0);
  const measuredPromptTokens = Number(row?.usage?.uncached || 0);
  if (!(usedPercent >= 0) || !(measuredWeekTokens > 0)) return null;
  return {
    percentagePoints: (usedPercent * measuredPromptTokens) / measuredWeekTokens,
    measuredWeekSharePercent: (100 * measuredPromptTokens) / measuredWeekTokens,
    measuredPromptTokens,
    measuredWeekTokens,
    usedPercent,
  };
}

function normalizeExplorerData(tokenReport = {}, codexUsage = {}) {
  const codex = tokenReport?.platforms?.codex || {};
  const claude = tokenReport?.platforms?.claude || {};
  const codexRows = Array.isArray(codex.sessionGraph)
    ? codex.sessionGraph
    : Array.isArray(codex.topSessions)
      ? codex.topSessions
      : [];
  const claudeRows = Array.isArray(claude.sessionGraph) ? claude.sessionGraph : [];
  const sourceRows = [...codexRows, ...claudeRows];
  const allNodes = sourceRows.map((row) => {
    const meta = row.meta || {};
    const platform = compact(
      meta.platform || (String(row.key || '').startsWith('claude:') || String(row.key || '').startsWith('claude-agent:') ? 'claude' : 'codex'),
      20,
    );
    const allocation = platform === 'codex' ? weeklyPlanAllocation(row, codexUsage) : null;
    return {
      id: String(row.key || ''),
      platform,
      label: compact(row.label || row.key || 'Untitled prompt', 220),
      prompt: String(meta.prompt || '').slice(0, 64 * 1024),
      promptChars: Number(meta.promptChars || String(meta.prompt || '').length),
      promptSha256: compact(meta.promptSha256 || '', 80),
      promptTruncated: Boolean(meta.promptTruncated),
      parentId: String(meta.parentSessionId || ''),
      depth: Math.max(0, Number(meta.depth) || 0),
      agentPath: compact(meta.agentPath || '', 180),
      agentName: compact(meta.agentName || '', 100),
      startedAt: String(meta.startedAt || tokenReport.generatedAt || ''),
      endedAt: String(meta.endedAt || ''),
      model: compact(meta.model || String(row.label || '').match(/(?:gpt|claude)-[\w.-]+/)?.[0] || 'unknown', 100),
      effort: compact(meta.effort || 'unknown', 40),
      tokens: Number(row.tokens || 0),
      usage: {
        processed: Number(row.usage?.processed || row.tokens || 0),
        uncached: Number(row.usage?.uncached || 0),
        cachedInput: Number(row.usage?.cachedInput || 0),
        input: Number(row.usage?.input || 0),
        output: Number(row.usage?.output || 0),
        reasoningOutput: Number(row.usage?.reasoningOutput || 0),
        unattributed: Number(row.usage?.unattributed || 0),
      },
      turns: Number(row.turns || 0),
      weeklyPercentagePoints: allocation ? allocation.percentagePoints : null,
      weeklyMeasuredSharePercent: allocation ? allocation.measuredWeekSharePercent : null,
      weeklyAllocation: allocation,
      route: routeChoice(meta),
    };
  });
  const allNodeById = new Map(allNodes.map((node) => [node.id, node]));
  const rootFor = (node) => {
    let current = node;
    const seen = new Set();
    while (current?.parentId && allNodeById.has(current.parentId) && !seen.has(current.id)) {
      seen.add(current.id);
      current = allNodeById.get(current.parentId);
    }
    return current || node;
  };
  for (const node of allNodes) node.rootId = rootFor(node).id;
  const recentRoots = allNodes
    .filter((node) => !node.parentId || !allNodeById.has(node.parentId))
    .sort((left, right) => Date.parse(right.startedAt || 0) - Date.parse(left.startedAt || 0))
    .slice(0, 10);
  const recentRootIds = new Set(recentRoots.map((node) => node.id));
  // The collector keeps the complete measured ledger. The interactive document
  // carries only the ten promised root trees so exact prompts do not turn a
  // useful drill-down into a multi-megabyte page.
  const nodes = allNodes.filter((node) => recentRootIds.has(node.rootId));
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const completeParentLinks = nodes.filter(
    (node) => !node.parentId || nodeById.has(node.parentId),
  ).length;
  const knownPrompts = nodes.filter((node) => Boolean(node.prompt)).length;
  const knownModels = nodes.filter((node) => node.model && node.model !== 'unknown').length;
  const knownEfforts = nodes.filter(
    (node) => node.effort && !/^(?:unknown|not exposed)$/i.test(node.effort),
  ).length;
  const receiptedRoutes = nodes.filter((node) => node.route.verdict !== 'unprovable').length;
  const roots = recentRoots.map((root) => {
      const tree = nodes.filter((node) => node.rootId === root.id);
      return {
        ...root,
        treeTokens: tree.reduce((sum, node) => sum + node.tokens, 0),
        treeWeeklyPercentagePoints: Number(
          tree
            .reduce((sum, node) => sum + Number(node.weeklyPercentagePoints || 0), 0)
            .toFixed(6),
        ),
        treeWeeklyMeasuredSharePercent: Number(
          tree
            .reduce((sum, node) => sum + Number(node.weeklyMeasuredSharePercent || 0), 0)
            .toFixed(6),
        ),
        descendants: Math.max(0, tree.length - 1),
        maxDepth: Math.max(...tree.map((node) => node.depth), 0),
      };
    });
  return {
    generatedAt: tokenReport.generatedAt || '',
    window: tokenReport.window || null,
    nodes,
    roots,
    weekly: {
      plan: codexUsage.plan || 'unknown',
      usedPercent:
        typeof codexUsage.weekly_used_percent === 'number'
          ? codexUsage.weekly_used_percent
          : null,
      resetsAt: codexUsage.weekly_resets_at || null,
      measuredTokens:
        Number(codexUsage.weekly_input_tokens || 0) +
        Number(codexUsage.weekly_output_tokens || 0),
      generatedAt: codexUsage.generated_at || '',
      allocationMethod:
        'provider weekly used percent × session measured non-cached tokens ÷ measured seven-day non-cached tokens',
    },
    rules: VERBATIM_ROUTING_RULES,
    attribution: {
      ledgerGenerations: allNodes.length,
      generations: nodes.length,
      completeParentLinks,
      knownPrompts,
      knownModels,
      knownEfforts,
      receiptedRoutes,
    },
  };
}

function renderTokenExplorerHtml({ tokenReport = {}, codexUsage = {}, url = '/briefing/token-explorer' } = {}) {
  const parsed = new URL(url, 'http://localhost');
  const reportDate = String(parsed.searchParams.get('date') || '');
  const datedUsage =
    tokenReport?.codexWeeklyUsage && typeof tokenReport.codexWeeklyUsage === 'object'
      ? tokenReport.codexWeeklyUsage
      : {};
  const data = normalizeExplorerData(tokenReport, reportDate ? datedUsage : codexUsage);
  const reportReceiptAvailable = Boolean(tokenReport?.generatedAt && tokenReport?.window);
  const selectedPrompt = String(parsed.searchParams.get('prompt') || data.roots[0]?.id || '');
  const focus = String(parsed.searchParams.get('focus') || '');
  const quote = compact(parsed.searchParams.get('quote') || '', 500);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Token Explorer</title>
<style>
:root{color-scheme:light dark;--bg:light-dark(#f4f7f5,#101513);--panel:light-dark(#fff,#18201d);--ink:light-dark(#14211f,#eef7f3);--muted:light-dark(#61716c,#a8bbb4);--line:light-dark(#d8e2de,#31413b);--deep:light-dark(#123f38,#0b2c27);--accent:light-dark(#137765,#69cbb0);--soft:light-dark(#dff1eb,#183a32);--warn:light-dark(#fff2d1,#4d3716);--bad:light-dark(#fde7e8,#4a2326)}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 Inter,system-ui,sans-serif}button,input{font:inherit}.top{background:var(--deep);color:#fff;padding:20px 24px}.top h1{margin:0;font-size:22px}.top p{margin:4px 0 0;color:#c7ddd6}.controls{display:grid;grid-template-columns:minmax(220px,1fr) repeat(2,minmax(135px,180px));gap:10px;margin-top:16px}.controls label{display:grid;gap:4px;font-size:11px;color:#c7ddd6}.controls input{height:38px;border:1px solid #ffffff35;border-radius:8px;background:#ffffff12;color:#fff;padding:0 10px}.summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;padding:16px 20px 0;max-width:1500px;margin:auto}.metric{background:var(--panel);border:1px solid var(--line);border-radius:11px;padding:12px}.metric span{display:block;color:var(--muted);font-size:11px}.metric strong{display:block;margin-top:4px;font-size:20px}.layout{display:grid;grid-template-columns:minmax(280px,.85fr) minmax(430px,1.45fr) minmax(300px,.8fr);gap:12px;max-width:1500px;margin:12px auto;padding:0 20px 28px;align-items:start}.pane{background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden}.pane h2{font-size:13px;margin:0;padding:13px 14px;border-bottom:1px solid var(--line)}.prompt-list{max-height:850px;overflow:auto}.prompt{width:100%;border:0;border-bottom:1px solid var(--line);background:transparent;color:inherit;text-align:left;padding:12px 14px}.prompt.selected{background:var(--soft);box-shadow:inset 3px 0 var(--accent)}.prompt time,.small{color:var(--muted);font-size:11px}.prompt strong{display:block;margin:5px 0}.prompt .nums{display:flex;gap:10px;flex-wrap:wrap;font-size:11px}.detail{padding:15px}.comment{display:none;background:var(--warn);border-left:4px solid #bd7b18;padding:10px 12px;margin-bottom:12px}.comment.visible{display:block}.prompt-copy{background:var(--soft);border-left:3px solid var(--accent);padding:10px 12px;margin:10px 0 14px;white-space:pre-wrap}.tree{display:grid;gap:8px}.node{border:1px solid var(--line);border-radius:9px;padding:10px;margin-left:calc(min(var(--depth),6)*18px);position:relative}.node.focused{background:var(--warn);outline:2px solid var(--accent)}.node-head{display:flex;justify-content:space-between;gap:12px}.node-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;margin-top:8px}.node-grid div{background:var(--bg);padding:6px;border-radius:6px}.node-grid span{display:block;color:var(--muted);font-size:10px}.token-split{display:flex;gap:6px;flex-wrap:wrap;margin-top:7px;color:var(--muted);font-size:10px}.token-split b{color:var(--ink)}.verdict{margin-top:8px;padding:8px;border-radius:7px;background:var(--soft)}.verdict.sub-optimal{background:var(--bad)}.verdict.unprovable{background:var(--warn)}.rules{max-height:850px;overflow:auto;padding:10px}.rule{border-bottom:1px solid var(--line);padding:9px 2px}.rule code{display:block;white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px}.rule span{color:var(--muted);font-size:10px}.empty{padding:30px;color:var(--muted)}@media(max-width:1050px){.layout{grid-template-columns:320px 1fr}.rules-pane{grid-column:1/-1}.rules{max-height:none;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 14px}}@media(max-width:720px){.top{padding:16px 13px}.controls{grid-template-columns:1fr 1fr}.controls label:first-child{grid-column:1/-1}.summary{grid-template-columns:1fr 1fr;padding:12px 10px 0}.layout{grid-template-columns:1fr;padding:0 10px}.rules-pane{grid-column:auto}.rules{display:block}.prompt-list{max-height:360px}.node-grid{grid-template-columns:1fr 1fr}.node{margin-left:calc(min(var(--depth),3)*10px)}}
</style></head><body>
<header class="top"><h1>Token Explorer</h1><p>${reportDate ? `${reportReceiptAvailable ? 'Report-date receipt' : 'Report-date receipt unavailable'}: ${escapeHtml(reportDate)}. ` : ''}Filter by date, open a prompt, then follow every agent generation and routing receipt.</p><div class="controls"><label>Prompt search<input id="search" type="search" placeholder="Search prompt or agent"></label><label>From<input id="from" type="date"></label><label>To<input id="to" type="date"></label></div></header>
<section class="summary"><div class="metric"><span>Codex weekly meter</span><strong>${data.weekly.usedPercent == null ? 'Unavailable' : `${data.weekly.usedPercent}%`}</strong><span>${escapeHtml(data.weekly.plan)} · provider reported${data.weekly.resetsAt ? ` · resets ${escapeHtml(data.weekly.resetsAt)}` : ''}</span></div><div class="metric"><span>Measured seven-day tokens</span><strong>${formatTokens(data.weekly.measuredTokens)}</strong><span>non-cached input + output</span></div><div class="metric"><span>Ten recent root prompts</span><strong>${data.roots.length}</strong><span>newest first · depth ${Math.max(...data.roots.map((row) => row.maxDepth),0)}</span></div><div class="metric"><span>Attribution coverage</span><strong>${data.attribution.knownPrompts}/${data.attribution.generations}</strong><span>shown prompts · parents ${data.attribution.completeParentLinks}/${data.attribution.generations} · models ${data.attribution.knownModels}/${data.attribution.generations} · efforts ${data.attribution.knownEfforts}/${data.attribution.generations} · routes ${data.attribution.receiptedRoutes}/${data.attribution.generations} · ledger ${data.attribution.ledgerGenerations}</span></div></section>
<main class="layout"><section class="pane"><h2>Prompts, date ordered</h2><div class="prompt-list" id="promptList"></div></section><section class="pane"><h2>Prompt and agent tree</h2><div class="detail" id="detail"></div></section><aside class="pane rules-pane"><h2>Verbatim executable routing rules</h2><div class="rules">${data.rules.map((rule) => `<div class="rule" data-rule-id="${escapeHtml(rule.id)}"><span>${escapeHtml(rule.id)}</span><code>${escapeHtml(rule.source)}</code></div>`).join('')}</div></aside></main>
<script>
const explorer=${safeJson(data)};let selected=${safeJson(selectedPrompt)};const focused=${safeJson(focus)};const citedQuote=${safeJson(quote)};
const byId=new Map(explorer.nodes.map(n=>[n.id,n]));const children=new Map();for(const n of explorer.nodes){if(!children.has(n.parentId))children.set(n.parentId,[]);children.get(n.parentId).push(n)}
const fmt=n=>n>=1e9?(n/1e9).toFixed(2)+'B':n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e3?(n/1e3).toFixed(1)+'K':Math.round(n).toString();const pct=n=>n==null?'unavailable':n.toFixed(n<.1?3:2)+' weekly points';const weekShare=n=>n==null?'unavailable':n.toFixed(n<.1?3:2)+'% of measured week';const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));const ct=v=>{if(!v)return'unknown time';const d=new Date(v);return Number.isNaN(d.getTime())?String(v):new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}).format(d)};
function rootsFiltered(){const q=document.getElementById('search').value.toLowerCase();const from=document.getElementById('from').value;const to=document.getElementById('to').value;return explorer.roots.filter(r=>{const day=(r.startedAt||'').slice(0,10);const tree=explorer.nodes.filter(n=>n.rootId===r.id);const hay=tree.map(n=>[n.label,n.prompt,n.agentPath,n.model,n.effort].join(' ')).join(' ').toLowerCase();return(!q||hay.includes(q))&&(!from||day>=from)&&(!to||day<=to)})}
function renderList(){const rows=rootsFiltered();const host=document.getElementById('promptList');host.innerHTML=rows.length?rows.map(r=>'<button class="prompt '+(r.id===selected?'selected':'')+'" id="prompt-'+esc(r.id)+'" data-id="'+esc(r.id)+'"><time>'+esc(ct(r.startedAt))+'</time><strong>'+esc(r.prompt||r.label)+'</strong><div class="nums"><span>'+fmt(r.treeTokens)+' processed</span><span>'+pct(r.treeWeeklyPercentagePoints)+'</span><span>'+weekShare(r.treeWeeklyMeasuredSharePercent)+'</span><span>'+r.descendants+' descendants</span><span>depth '+r.maxDepth+'</span></div></button>').join(''):'<div class="empty">No prompts match this date and text filter.</div>';host.querySelectorAll('button').forEach(b=>b.onclick=()=>{selected=b.dataset.id;history.replaceState(null,'','?prompt='+encodeURIComponent(selected)+'#prompt-'+encodeURIComponent(selected));renderList();renderDetail()})}
function flatten(id,out=[]){const node=byId.get(id);if(node)out.push(node);for(const child of(children.get(id)||[]).sort((a,b)=>a.startedAt.localeCompare(b.startedAt)))flatten(child.id,out);return out}
function promptProof(n,label='Prompt'){return n.promptTruncated?'<br><strong>'+label+' truncated in telemetry · '+n.promptChars+' characters · SHA-256 '+esc(n.promptSha256)+'</strong>':''}
function tokenSplit(n){return '<div class="token-split"><span>processed <b>'+fmt(n.usage.processed)+'</b></span><span>uncached <b>'+fmt(n.usage.uncached)+'</b></span><span>cached <b>'+fmt(n.usage.cachedInput)+'</b></span><span>output <b>'+fmt(n.usage.output)+'</b></span><span>reasoning <b>'+fmt(n.usage.reasoningOutput)+'</b></span><span>turns <b>'+n.turns+'</b></span></div>'}
function renderDetail(){let root=byId.get(selected)||byId.get(explorer.roots[0]?.id);if(root&&root.rootId&&root.rootId!==root.id)root=byId.get(root.rootId)||root;const host=document.getElementById('detail');if(!root){host.innerHTML='<div class="empty">No session-detail telemetry is available yet.</div>';return}const nodes=flatten(root.id);host.innerHTML='<div class="comment '+(citedQuote?'visible':'')+'"><strong>Nightly report citation</strong><br>'+esc(citedQuote)+'</div><div class="small">'+esc(ct(root.startedAt))+' · '+nodes.length+' measured generation'+(nodes.length===1?'':'s')+'</div><div class="prompt-copy">'+esc(root.prompt||root.label)+promptProof(root,'Root prompt')+'</div><div class="tree">'+nodes.map(n=>'<article class="node '+(focused===n.id||focused==='session:'+n.id?'focused':'')+'" data-session-id="'+esc(n.id)+'" style="--depth:'+n.depth+'"><div class="node-head"><strong>'+(n.depth===0?'Root prompt':esc(n.agentName||n.agentPath||'Agent generation'))+'</strong><span>'+fmt(n.tokens)+'</span></div><div class="small">'+esc(n.platform)+' · '+esc(n.id)+' · depth '+n.depth+' · '+esc(ct(n.startedAt))+'</div><div class="node-grid"><div><span>Actual model</span>'+esc(n.model)+'</div><div><span>Effort</span>'+esc(n.effort)+'</div><div><span>Weekly allocation</span>'+pct(n.weeklyPercentagePoints)+'<br>'+weekShare(n.weeklyMeasuredSharePercent)+'</div></div>'+tokenSplit(n)+'<div class="verdict '+esc(n.route.verdict)+'"><strong>'+esc(n.route.verdict)+'</strong><br>'+esc(n.route.explanation)+'</div>'+(n.prompt&&n.id!==root.id?'<div class="prompt-copy">'+esc(n.prompt)+promptProof(n)+'</div>':'')+'</article>').join('')+'</div>';const mark=host.querySelector('.focused');if(mark)mark.scrollIntoView({block:'center'})}
for(const id of ['search','from','to'])document.getElementById(id).addEventListener('input',renderList);renderList();renderDetail();
</script></body></html>`;
}

module.exports = {
  normalizeExplorerData,
  renderTokenExplorerHtml,
  resolveTokenExplorerReportPath,
  routeChoice,
  tokenExplorerHref,
  tokenExplorerReportCitation,
  weeklyPlanAllocation,
};
