/** Bounded L2: prepare, pilot, blind review, expand, blind review, reveal. Never executes proposed tools. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomInt } from 'node:crypto';
import { it } from 'vitest';
import { calculateCost, getCostRate, getProvider, type KodaXStreamResult } from '@kodax-ai/llm';
import { observeProviderOperation, runWithAdditionalProviderRequestObserver, type ProviderRequestObservation } from '../packages/llm/src/provider-request-observation.js';
import { DEFERRED_TOOL_HINTS } from '../packages/coding/src/tools/deferred-tools.js';
import { FirstTurnBudget, firstTurnReasoningFor, inputHash, type FrozenInput, type BudgetSnapshot } from './first-turn-eval-support.js';
import { settleComplexAttempt } from './first-turn-complex-budget.js';
import { NEXT_STAGE_ROUTES, validateNextStageReview, type NextStageRoute } from './token-efficiency-next-stage-fixtures.js';
import { resolveDeferredEvidenceRoot } from './deferred-repo-lsp-support.js';

const phase = process.env.KODAX_DEFERRED_CONTRACT_PHASE;
const root = resolveDeferredEvidenceRoot(process.env.KODAX_DEFERRED_CONTRACT_OUTPUT
  ?? path.join(os.tmpdir(), 'kodax-eval-dumps', 'deferred-tool-contract-r1-20261031'));
const limits = { calls: 12, tokens: 1_000_000, usd: 1, output: 2048, timeoutMs: 120_000 };
const sourceFiles = ['tests/deferred-tool-contract.eval.ts', 'tests/deferred-tool-direct-runtime.test.ts',
  'packages/coding/src/tools/deferred-tools.ts', 'packages/coding/src/tools/tool-search-model-result.ts',
  'packages/coding/src/task-engine/_internal/managed-task/llm-adapter.ts'];
type Arm = 'baseline' | 'candidate';
type Label = 'A' | 'B';
interface Evidence { inputs: FrozenInput[]; canonicalInputs: FrozenInput[] }
interface Case { id: 'agent-direct' | 'script-help'; task: string; rubric: string; inputs: Record<Label, FrozenInput> }
interface Manifest { sources: Record<string, string>; cases: Case[]; rates: Record<NextStageRoute, NonNullable<ReturnType<typeof getCostRate>>> }
interface Row { id: string; caseId: string; route: NextStageRoute; label: Label; result: KodaXStreamResult | null;
  error: string | null; facts: ProviderRequestObservation[]; wallMs: number; actualUsd: number | null; stop: boolean }
const read = async <T>(name: string): Promise<T> => JSON.parse(await fs.readFile(path.join(root, name), 'utf8')) as T;
const redact = (value: string) => Object.values(NEXT_STAGE_ROUTES).reduce((text, item) => process.env[item.key]
  ? text.replaceAll(process.env[item.key]!, '[REDACTED]') : text, value);
const save = (name: string, value: unknown) => fs.writeFile(path.join(root, name), redact(JSON.stringify(value, null, 2)), { flag: 'wx' });
const hashes = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, inputHash(await fs.readFile(file, 'utf8'))])));

async function prepare() {
  const agentPath = process.env.KODAX_DEFERRED_AGENT_EVIDENCE;
  const scriptPath = process.env.KODAX_DEFERRED_SCRIPT_EVIDENCE;
  const previousPath = process.env.KODAX_DEFERRED_BASELINE_CAPTURE;
  if (!agentPath || !scriptPath || !previousPath) throw new Error('Explicit retained Agent/Script evidence and baseline capture are required');
  const agent: Evidence = JSON.parse(await fs.readFile(agentPath, 'utf8')) as Evidence;
  const script: Evidence = JSON.parse(await fs.readFile(scriptPath, 'utf8')) as Evidence;
  const previous = JSON.parse(await fs.readFile(previousPath, 'utf8')) as { tools: { function: { name: string; description: string } }[] };
  const old = new Map(previous.tools.map(tool => [tool.function.name, tool.function.description]));
  const first = agent.inputs[0], helped = script.inputs[1], canonical = script.canonicalInputs[1];
  if (!first || !helped || !canonical || !first.tools.some(tool => tool.name === 'web_fetch')
    || helped.tools.some(tool => tool.name === 'web_fetch') || !helped.tools.some(tool => tool.name === 'script_exec')) throw new Error('Invalid retained production surfaces');
  const baseline = { ...first, tools: first.tools.map(tool => DEFERRED_TOOL_HINTS[tool.name] && old.has(tool.name)
    ? { ...tool, description: old.get(tool.name)! } : tool) };
  const pairs: { id: Case['id']; task: string; rubric: string; baseline: FrozenInput; candidate: FrozenInput }[] = [
    { id: 'agent-direct', task: 'Read the supplied Node.js fs URL, save and verify the report.',
      rubric: 'Useful legal first step with valid arguments and no invented page evidence. Direct fetch is efficient; justified planning or Skill use is not automatically wrong. Diagnose unnecessary discovery; proposed actions are not execution.', baseline, candidate: first },
    { id: 'script-help', task: 'Continue the same natural task after optional tool help, before the page has been fetched.',
      rubric: 'Use disclosed Script or bridge arguments correctly to obtain the page. Do not invent page contents or claim a saved/verified report. Repeating discovery for already supplied parameters is diagnostic overhead, not an automatic universal veto.', baseline: canonical, candidate: helped },
  ];
  const mapping: Record<string, Record<Label, Arm>> = {};
  const cases = pairs.map(pair => {
    if (inputHash(pair.baseline) === inputHash(pair.candidate)) throw new Error('Pair has no input difference');
    mapping[pair.id] = randomInt(2) === 0 ? { A: 'baseline', B: 'candidate' } : { A: 'candidate', B: 'baseline' };
    return { id: pair.id, task: pair.task, rubric: pair.rubric, inputs: { A: pair[mapping[pair.id]!.A], B: pair[mapping[pair.id]!.B] } };
  });
  const rates = Object.fromEntries((Object.keys(NEXT_STAGE_ROUTES) as NextStageRoute[]).map(route => {
    const rate = getCostRate(route, NEXT_STAGE_ROUTES[route].model); if (!rate) throw new Error('Missing reference rate'); return [route, rate];
  })) as Manifest['rates'];
  const manifest = { sources: await hashes(), cases, rates } satisfies Manifest;
  await save('manifest.json', manifest);
  await save('sealed-mapping.json', mapping);
  await save('preregistration.json', { manifestHash: inputHash(manifest), limits, inputSources: { agentPath, scriptPath, previousPath },
    design: 'L2, two distinct controlled checkpoints. Agent compares old/new descriptions only; Script compares complete/projected receipt only with identical current tools. Eight-call GLM/Kimi pilot, review, then four DeepSeek calls. One attempt per cell, no execution/retries/fallback.',
    whyModel: 'Layer 1 proves contract and execution preservation; it cannot prove next-action comprehension of optional help and native/Script parameter references.',
    review: 'Main session reads blind packet before mapping/cost, preserves case-level task validity, safe progress, truthfulness, discovery overhead and attribution. Do not claim full-task non-inferiority or actual round savings from L2.',
    original: 'Original bd4479d historical data remain in the original-baseline test guide. No matched original generation for this new component checkpoint; never rename the 0b8/native receipt control as original.',
    pricing: 'Repository reference rates, not subscription quota or cash bill. Unknown usage charged at reservation; stop on error, source drift, cap or physical-attempt mismatch.' });
}

async function run(stage: 'pilot' | 'expand') {
  const manifest = await read<Manifest>('manifest.json');
  if ((await read<{ manifestHash: string }>('preregistration.json')).manifestHash !== inputHash(manifest)) throw new Error('Frozen manifest changed');
  if (inputHash(manifest.sources) !== inputHash(await hashes())) throw new Error('Source drift; no dispatch');
  const initial = stage === 'expand' ? await read<BudgetSnapshot>('pilot-budget.json') : undefined;
  if (stage === 'expand') {
    validateNextStageReview(await read('pilot-review.json'), inputHash(await read('pilot.blind.json')));
    if (initial?.calls !== 8 || initial.unknownUsageCalls !== 0 || initial.reservedTokens !== 0) throw new Error('Incomplete pilot accounting');
  }
  const routes: NextStageRoute[] = stage === 'pilot' ? ['zhipu-coding', 'kimi-code'] : ['deepseek'];
  for (const route of routes) if (!process.env[NEXT_STAGE_ROUTES[route].key]) throw new Error(`Missing ${route} key; no fallback`);
  await save(`${stage}.lock`, { started: new Date().toISOString() });
  const budget = new FirstTurnBudget(initial, limits.calls), abort = new AbortController(), rows: Row[] = [];
  const lanes = await Promise.allSettled(routes.map(async route => {
    for (const item of manifest.cases) for (const label of ['A', 'B'] as const) {
      if (abort.signal.aborted) return;
      if (inputHash(manifest.sources) !== inputHash(await hashes())) throw new Error('Source drift');
      const input = item.inputs[label], upper = Buffer.byteLength(JSON.stringify(input), 'utf8') + 4096;
      const reservedTokens = upper + limits.output, reservedUsd = calculateCost(manifest.rates[route], upper, limits.output);
      if (budget.state.chargedTokens + budget.state.reservedTokens + reservedTokens > limits.tokens
        || budget.state.chargedUsd + budget.state.reservedUsd + reservedUsd > limits.usd) throw new Error('Frozen total budget reached');
      const id = `${route}-${item.id}-${label}`;
      budget.reserve(reservedTokens, reservedUsd);
      await save(`${id}.reservation.json`, { reservedTokens, reservedUsd, inputHash: inputHash(input) });
      const facts: ProviderRequestObservation[] = [], started = Date.now(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(limits.timeoutMs)]);
      let result: KodaXStreamResult | undefined, error: string | null = null;
      try { result = await runWithAdditionalProviderRequestObserver(fact => facts.push(fact), () => observeProviderOperation(route, 'primary', undefined,
        () => getProvider(route).stream([...input.messages], [...input.tools], input.system, firstTurnReasoningFor(route),
          { modelOverride: NEXT_STAGE_ROUTES[route].model, maxOutputTokensOverride: limits.output, singleAttempt: true }, signal), undefined, signal)); }
      catch (cause) { error = redact(cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)); }
      const usage = result?.usage, actualUsd = usage ? calculateCost(manifest.rates[route], usage.inputTokens, usage.outputTokens, usage.cachedReadTokens ?? 0, usage.cachedWriteTokens ?? 0) : undefined;
      const settled = settleComplexAttempt({ reservedTokens, reservedUsd, facts, tools: input.tools.map(tool => tool.name), reasoning: firstTurnReasoningFor(route),
        outputCap: limits.output, requestCancelled: signal.aborted, taskCancelled: abort.signal.aborted, failed: error !== null, actualUsd });
      budget.settle(reservedTokens, reservedUsd, settled.unknownUsage ? undefined : usage, actualUsd);
      const stop = settled.stop || (usage?.totalTokens ?? 0) > reservedTokens || (usage?.outputTokens ?? 0) > limits.output || (actualUsd ?? 0) > reservedUsd;
      const row: Row = { id, caseId: item.id, route, label, result: result ?? null, error, facts, wallMs: Date.now() - started, actualUsd: actualUsd ?? null, stop };
      await save(`${id}.result.json`, { ...row, settlement: settled }); rows.push(row);
      if (stop) { abort.abort(new Error('Frozen evaluation stopped')); return; }
    }
  }).map(lane => lane.catch(error => { abort.abort(error); throw error; })));
  const errors = lanes.flatMap(lane => lane.status === 'rejected' ? [redact(String(lane.reason))] : []);
  await save(`${stage}-results.json`, rows); await save(`${stage}-budget.json`, budget.state);
  const packet = { stage, cases: manifest.cases.map(({ inputs: _inputs, ...item }) => item), errors,
    responses: rows.map(({ result, id, caseId, route, label, error }) => ({ id, caseId, route, label, error, text: result?.textBlocks,
      thinking: result?.thinkingBlocks, tools: result?.toolBlocks, stopReason: result?.stopReason })) };
  await save(`${stage}.blind.json`, packet);
  process.stdout.write(JSON.stringify({ root, stage, completed: rows.length, budget: budget.state, packetHash: inputHash(packet) }) + '\n');
  if (abort.signal.aborted || errors.length || rows.length !== routes.length * 4) throw new Error('Incomplete; retain failed cells, never rerun');
}

it.skipIf(!phase)('runs one frozen deferred-contract evaluation phase', async () => {
  await fs.mkdir(root, { recursive: true });
  if (phase === 'prepare') await prepare();
  else if (phase === 'pilot' || phase === 'expand') await run(phase);
  else if (phase === 'reveal') {
    validateNextStageReview(await read('expand-review.json'), inputHash(await read('expand.blind.json')));
    const mapping = await read<Record<string, Record<Label, Arm>>>('sealed-mapping.json');
    const rows = [...await read<Row[]>('pilot-results.json'), ...await read<Row[]>('expand-results.json')];
    await save('revealed-results.json', rows.map(row => ({ ...row, arm: mapping[row.caseId]![row.label] })));
  } else throw new Error('Expected prepare/pilot/expand/reveal');
}, 900_000);
