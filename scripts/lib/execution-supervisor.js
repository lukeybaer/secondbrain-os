'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { executionPhaseMetadata } = require('./briefing-model-context');
const { buildCodexCliEnv } = require('./cli-output-guard');
const { ensureCodexWorktree } = require('./codex-worktree');
const { decideSpawnModel } = require('./model-router');
const { resolveDirectCodex } = require('./codex-executable');

const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const textList = value => Array.isArray(value) ? value : typeof value === 'string' && value.trim() ? [value] : [];
function writeJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n'); fs.renameSync(temporary, file);
}

const RESULT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    unitId: { type: 'string' }, phase: { type: 'string' }, status: { enum: ['completed', 'handoff', 'needs-input'] },
    summary: { type: 'string' }, decisions: { type: 'array', items: { type: 'string' } },
    evidence: { type: 'array', items: { type: 'string' } }, unfinishedWork: { type: 'array', items: { type: 'string' } },
    nextAction: { type: 'string' }, nextPhase: { enum: ['', 'execute', 'diagnose', 'implement', 'verify', 'review', 'deliver'] },
    complexity: { enum: ['routine', 'complex', 'critical'] }, complexityReason: { type: 'string' }, ownerResponse: { type: 'string' }, output: { type: 'string' },
  },
};
RESULT_SCHEMA.required = Object.keys(RESULT_SCHEMA.properties);

function planFromPrompt(prompt, opts = {}) {
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('A complete objective is required');
  const complexity = opts.complexity || ({ low: 'routine', high: 'complex', xhigh: 'critical' }[opts.effort]) || 'routine';
  const phase = opts.phase || (opts.readOnly ? 'diagnose' : 'execute');
  executionPhaseMetadata({ phase, complexity, complexityReason: opts.complexityReason });
  return {
    unitId: `direct-${digest(prompt).slice(0, 16)}`, objective: prompt,
    scope: ['Only the current owner request and its necessary dependencies.'],
    requirements: ['Preserve canonical authority, authorization, isolation and applicable quality gates.',
      'Inspect the exact applicable sources; preserve every requested result and unresolved question.',
      'Delegate deterministic commands to the operation runner; finish a phase with a compact checkpoint.'],
    currentEvidence: ['The full owner request is the objective. Retrieve current evidence from the selected workspace.'],
    acceptance: ['Every requested result is supported by exact evidence; remaining work is explicit.'],
    nonGoals: ['No new recurring work or external communication authority is granted by this packet.'],
    phases: [{ id: 'direct', phase, complexity, complexityReason: opts.complexityReason || '' }],
  };
}

function validatePlan(plan) {
  if (!plan || typeof plan !== 'object' || !/^[a-zA-Z0-9._-]+$/.test(plan.unitId || '')) throw new Error('Execution plan requires a safe unitId');
  for (const field of ['objective', 'scope', 'requirements', 'currentEvidence', 'acceptance']) {
    if (!textList(plan[field]).length || !textList(plan[field]).every(x => typeof x === 'string' && x.trim())) throw new Error(`Plan ${field} requires text`);
  }
  if (!Array.isArray(plan.phases) || !plan.phases.length) throw new Error('Plan requires phases');
  const ids = new Set();
  for (const phase of plan.phases) {
    if (!phase || !/^[a-zA-Z0-9._-]+$/.test(phase.id || '') || ids.has(phase.id)) throw new Error('Each phase requires a unique safe id');
    ids.add(phase.id); executionPhaseMetadata({ ...phase, unitId: plan.unitId });
    if (phase.phase === 'operations' && !phase.operation) throw new Error('Operations phase requires an operation packet');
  }
}

function validateResult(result, plan, phase) {
  if (!result || result.unitId !== plan.unitId || result.phase !== phase.phase) throw new Error('Phase result unit/phase identity mismatch');
  for (const field of ['decisions', 'evidence', 'unfinishedWork']) {
    if (!Array.isArray(result[field]) || !result[field].every(x => typeof x === 'string')) throw new Error(`Result ${field} must be a text array`);
  }
  if (!['completed', 'handoff', 'needs-input'].includes(result.status)) throw new Error('Invalid phase result status');
  if (!result.summary || !result.evidence.length) throw new Error('Phase result requires summary and evidence');
  if (result.status === 'handoff') {
    if (!result.unfinishedWork.length || !result.nextAction || !result.nextPhase) throw new Error('Handoff requires unfinished work and an exact next phase/action');
    executionPhaseMetadata({ phase: result.nextPhase, complexity: result.complexity, complexityReason: result.complexityReason });
  }
  return result;
}

// This is the actual model invocation, not a recommendation to a calling model.
async function runCliPhase({ plan, phase, built, runDir, cwd, timeoutMin = 20 }, deps = {}) {
  const { buildDirectLaunchArgs } = require('../codex-run');
  const routed = (deps.route || decideSpawnModel)('codex-run', 'codex', {
    taskType: phase.readOnly ? 'review' : 'repair-code', complexity: phase.complexity || 'routine', complexityReason: phase.complexityReason || '',
  });
  const answerFile = path.join(runDir, 'answer.json'); const schemaFile = path.join(runDir, 'result-schema.json');
  writeJson(schemaFile, RESULT_SCHEMA);
  const args = [...buildDirectLaunchArgs({ readOnly: Boolean(phase.readOnly) }, answerFile, routed), '--output-schema', schemaFile];
  // Keep the stdin marker last: every phase starts a new exec, never resume/fork.
  args.splice(args.indexOf('-'), 1); args.push('-');
  const executable = (deps.resolveExecutable || resolveDirectCodex)();
  const prompt = `${built.prompt || built.context.prompt}\n\nMACHINE PHASE RESULT CONTRACT:\nReturn only the required JSON checkpoint, not an owner-facing answer. unitId=${plan.unitId}; phase=${phase.phase}.\n` +
    'Complete only this phase. For a substantial next phase return handoff with changed evidence, unfinishedWork, exact nextAction and nextPhase. The supervisor launches it fresh. Never start another model runner or replay a transcript. Deterministic test/release sequences use codex-run --operation-file. If completed, cite real acceptance evidence. Use needs-input for a genuine missing prerequisite. Put the exact requested deliverable (including JSON or prose if requested) in output. Keep ownerResponse empty unless a final owner answer with its official trailer was explicitly requested.\n';
  fs.writeFileSync(path.join(runDir, 'prompt.txt'), prompt);
  const output = fs.openSync(path.join(runDir, 'model-events.jsonl'), 'w'); const errors = fs.openSync(path.join(runDir, 'stderr.txt'), 'w');
  const usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, source: 'CLI turn.completed events' };
  let result;
  try {
    result = await new Promise(resolve => {
      let buffer = ''; let error = null;
      const child = (deps.spawn || spawn)(executable.command, [...executable.prefix, ...args], {
        cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', errors],
        env: { ...buildCodexCliEnv(process.env), SECONDBRAIN_HARNESS_PHASE: phase.id, SECONDBRAIN_ROOT: cwd, SECONDBRAIN_RESPONSE_FORMAT: 'machine' },
        timeout: timeoutMin * 60000,
      });
      child.stdout.on('data', chunk => {
        fs.writeSync(output, chunk); buffer += chunk.toString();
        let index; while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
          try { const event = JSON.parse(line); if (event.type === 'turn.completed' && event.usage) {
            usage.inputTokens += event.usage.input_tokens || 0; usage.cachedInputTokens += event.usage.cached_input_tokens || 0; usage.outputTokens += event.usage.output_tokens || 0;
          } } catch { /* Complete raw event remains on disk. */ }
        }
      });
      child.on('error', e => { error = e.message; });
      child.on('close', (code, signal) => resolve({ code, signal, error }));
      child.stdin.on('error', () => {}); child.stdin.end(prompt);
    });
  } finally { fs.closeSync(output); fs.closeSync(errors); }
  writeJson(path.join(runDir, 'invocation.json'), { ...result, routed, usage, cwd, args, promptBytes: Buffer.byteLength(prompt) });
  if (result.error || result.code !== 0) throw new Error(`Phase process failed (${result.code}, ${result.error || result.signal || 'see stderr.txt'}); logs: ${runDir}`);
  return { result: JSON.parse(fs.readFileSync(answerFile, 'utf8')), usage, invocationPath: path.join(runDir, 'invocation.json') };
}

async function runExecutionPlan(plan, opts = {}, deps = {}) {
  validatePlan(plan);
  const cwd = opts.readOnly ? path.resolve(opts.cwd || process.cwd()) : (deps.ensureWorktree || ensureCodexWorktree)({ repoRoot: path.resolve(opts.cwd || process.cwd()), purpose: 'execution-plan' }).cwd;
  const repoRoot = opts.repoRoot || cwd;
  const root = path.resolve(opts.receiptDir || path.join(os.homedir(), '.codex', 'codex-run-receipts'));
  fs.mkdirSync(root, { recursive: true });
  const runDir = opts.resumePath ? path.dirname(path.resolve(opts.resumePath)) : fs.mkdtempSync(path.join(root, `${plan.unitId}-`));
  const checkpointPath = path.join(runDir, 'checkpoint.json'); const planIdentity = digest({ plan, cwd });
  let state = opts.resumePath ? JSON.parse(fs.readFileSync(opts.resumePath, 'utf8')) : {
    schemaVersion: 1, planIdentity, unitId: plan.unitId, cwd, status: 'pending', phaseIndex: 0, activePhase: null,
    phases: plan.phases, checkpoint: null, completed: [], modelCalls: 0, usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
  };
  if (state.planIdentity !== planIdentity) throw new Error('Resume plan/cwd identity changed; reconcile the saved work first');
  const receipt = () => ({ ...state, checkpointPath, receiptPath: path.join(runDir, 'outcome.json'),
    acceptanceStatus: 'Evidence is recorded; process success alone does not prove production acceptance.' });
  if (state.status === 'succeeded') return receipt();
  if (opts.resumePath && (state.activePhase || state.status !== 'pending')) return { ...receipt(), status: 'needs-reconciliation' };
  const lockRoot = path.join(process.env.APPDATA || os.homedir(), 'secondbrain', 'execution-plan-locks');
  fs.mkdirSync(lockRoot, { recursive: true });
  const lock = path.join(lockRoot, `${digest({ cwd, unitId: plan.unitId })}.lock`); const lockFd = fs.openSync(lock, 'wx');
  fs.writeSync(lockFd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  const event = (type, detail = {}) => { const row = { type, unitId: plan.unitId, at: new Date().toISOString(), ...detail };
    fs.appendFileSync(path.join(runDir, 'events.jsonl'), JSON.stringify(row) + '\n');
    if (opts.onEvent) { try { opts.onEvent(row); } catch (error) { fs.appendFileSync(path.join(runDir, 'event-delivery-errors.txt'), error.message + '\n'); } } };
  const save = () => writeJson(checkpointPath, state);
  try {
    event('execution-started');
    while (state.phaseIndex < state.phases.length) {
      const phase = { ...state.phases[state.phaseIndex], readOnly: Boolean(opts.readOnly || state.phases[state.phaseIndex].readOnly) };
      const phaseDir = path.join(runDir, `${state.phaseIndex}-${phase.id}`); fs.mkdirSync(phaseDir, { recursive: true });
      state.activePhase = phase.id; state.status = 'running'; save(); event('phase-started', { phase: phase.id });
      let result;
      if (phase.phase === 'operations') {
        const runOperations = deps.runOperations || require('./execution-operations').runOperationSequence;
        const operation = { unitId: `${plan.unitId}-${phase.id}`, objective: plan.objective, acceptance: plan.acceptance, cwd, ...phase.operation };
        const proof = await runOperations(operation, { receiptDir: phaseDir, onEvent: opts.onEvent });
        if (proof.status !== 'succeeded') throw new Error(`Operation sequence unfinished: ${proof.status}; ${proof.receiptPath || phaseDir}`);
        result = { unitId: plan.unitId, phase: phase.phase, status: 'completed', summary: 'Declared operation sequence completed', decisions: [],
          evidence: [proof.receiptPath || phaseDir], unfinishedWork: [], nextAction: '' };
      } else {
        const buildPacket = deps.buildPacket || require('./execution-phase-packet').buildExecutionPhasePacket;
        const built = buildPacket({ plan, phase, priorCheckpoint: state.checkpoint, repoRoot });
        writeJson(path.join(phaseDir, 'source-manifest.json'), built.sourceManifest);
        state.modelCalls++; save();
        const effectivePhase = { ...phase, complexity: built.context.execution.complexity || phase.complexity || 'routine',
          complexityReason: built.context.execution.complexityReason || phase.complexityReason || '' };
        const response = await (deps.runPhase || runCliPhase)({ plan, phase: effectivePhase, built, priorCheckpoint: state.checkpoint, runDir: phaseDir, cwd, timeoutMin: opts.timeoutMin || 20 });
        result = validateResult(response.result, plan, phase);
        for (const key of Object.keys(state.usage)) state.usage[key] += response.usage && response.usage[key] || 0;
      }
      const progressIdentity = digest({ decisions: result.decisions, evidence: result.evidence, unfinishedWork: result.unfinishedWork, nextAction: result.nextAction });
      const unchanged = state.checkpoint && state.checkpoint.progressIdentity === progressIdentity;
      state.checkpoint = { unitId: plan.unitId, objective: plan.objective, requirements: plan.requirements, scope: plan.scope, acceptance: plan.acceptance,
        phase: phase.phase, decisions: [...new Set([...(state.checkpoint?.decisions || []), ...result.decisions])],
        evidence: [...new Set([...(state.checkpoint?.evidence || []), ...result.evidence])], unfinishedWork: result.unfinishedWork,
        nextAction: result.nextAction || `Current phase complete. Continue the declared ${state.phases[state.phaseIndex + 1]?.id || 'final acceptance'} step using this checkpoint.`, summary: result.summary, progressIdentity };
      state.activePhase = null;
      if (typeof result.output === 'string') {
        state.outputPath = path.join(runDir, 'result.txt'); fs.writeFileSync(state.outputPath, result.output);
      }
      if (result.ownerResponse) {
        require('./execution-response-contract').assertOwnerResponse(result.ownerResponse);
        fs.writeFileSync(path.join(runDir, 'owner-response.txt'), result.ownerResponse);
      }
      if (result.status === 'needs-input') { state.status = 'needs-input'; save(); break; }
      if (result.status === 'handoff') {
        if (unchanged) { state.status = 'no-progress-unfinished'; save(); break; }
        state.phases.splice(state.phaseIndex + 1, 0, { id: `continuation-${state.phaseIndex + 1}`, phase: result.nextPhase,
          complexity: result.complexity || 'routine', complexityReason: result.complexityReason || '' });
      } else if (result.unfinishedWork.length && state.phaseIndex === state.phases.length - 1) {
        state.status = 'failed-unfinished'; state.error = 'Final phase still has unfinished work'; save(); break;
      }
      state.completed.push({ phase: phase.id, evidence: result.evidence, checkpointPath: path.join(phaseDir, 'completed.json') });
      writeJson(path.join(phaseDir, 'completed.json'), state.checkpoint);
      state.phaseIndex++; state.status = 'pending'; save(); event('phase-completed', { phase: phase.id });
    }
    if (state.phaseIndex === state.phases.length) state.status = 'succeeded';
  } catch (error) { state.status = 'failed-unfinished'; state.error = error.message; }
  finally {
    save(); writeJson(path.join(runDir, 'outcome.json'), receipt()); event('execution-completed', { status: state.status, checkpointPath });
    fs.closeSync(lockFd); fs.unlinkSync(lock);
  }
  return receipt();
}

module.exports = { RESULT_SCHEMA, planFromPrompt, validatePlan, validateResult, runCliPhase, runExecutionPlan };
