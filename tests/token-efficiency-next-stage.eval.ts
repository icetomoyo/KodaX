/** Manual L2 only: prepare -> pilot -> owner blind review -> expand -> review -> reveal.
 * No proposed model tool is executed. Each frozen cell is dispatched once.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomInt } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { it } from 'vitest';
import { getProvider, getCostRate, calculateCost, type KodaXStreamResult } from '../packages/llm/src/index.js';
import { observeProviderOperation, runWithAdditionalProviderRequestObserver, type ProviderRequestObservation } from '../packages/llm/src/provider-request-observation.js';
import { FirstTurnBudget, firstTurnReasoningFor, inputHash, type BudgetSnapshot, type FrozenInput } from './first-turn-eval-support.js';
import { settleComplexAttempt } from './first-turn-complex-budget.js';
import {
  NEXT_STAGE_CASES, NEXT_STAGE_LIMITS, NEXT_STAGE_ROUTES, assertNextStageReservation, buildNextStagePairs,
  plannedNextStageCells, validateNextStageReview, type NextStageArm, type NextStageCase,
  type NextStageRoute, type BlindArm, type NextStageCell,
} from './token-efficiency-next-stage-fixtures.js';

const REVISION = 'token-efficiency-next-stage-r1-20261031';
const phase = process.env.KODAX_NEXT_STAGE_PHASE;
const root = path.resolve(process.env.KODAX_NEXT_STAGE_ROOT ?? path.join(os.tmpdir(), 'kodax-eval-dumps', REVISION));
const SOURCE_FILES = [
  'tests/token-efficiency-next-stage.eval.ts', 'tests/token-efficiency-next-stage-fixtures.ts',
  'packages/coding/src/prompts/compact-child-contract.ts', 'packages/coding/src/child-executor.ts',
  'packages/coding/src/prompts/child-system-contract.ts',
  'packages/coding/src/tools/edit.ts', 'packages/coding/src/tools/managed-tool-text.ts',
  'packages/coding/src/tools/tool-definitions.ts', 'packages/coding/src/tools/managed-tool-contract.ts',
];
const redact = (text: string) => Object.values(NEXT_STAGE_ROUTES).reduce((value, route) => {
  const key = process.env[route.key];
  return key ? value.replaceAll(key, '[REDACTED]') : value;
}, text);
const save = (file: string, value: unknown) => fs.writeFile(path.join(root, file), redact(JSON.stringify(value, null, 2)), { flag: 'wx' });
const read = async <T>(file: string): Promise<T> => JSON.parse(await fs.readFile(path.join(root, file), 'utf8')) as T;
const sourceHashes = async () => Object.fromEntries(await Promise.all(SOURCE_FILES.map(async file => [file, inputHash(await fs.readFile(file, 'utf8'))])));
type Rate = NonNullable<ReturnType<typeof getCostRate>>;
interface Manifest {
  revision: string; head: string; sources: Record<string, string>;
  limits: typeof NEXT_STAGE_LIMITS; rates: Record<NextStageRoute, Rate>;
  cases: { id: NextStageCase; task: string; rubric: string; inputs: Record<BlindArm, { file: string; hash: string }> }[];
  cells: NextStageCell[];
}

async function prepare(): Promise<void> {
  await save('prepare.lock', { started: new Date().toISOString() });
  const initialSources = await sourceHashes();
  const pairs = await buildNextStagePairs(root);
  if (inputHash(initialSources) !== inputHash(await sourceHashes())) throw new Error('Source changed during offline capture; freeze a new revision');
  const mapping = Object.fromEntries(NEXT_STAGE_CASES.map(id => [id, randomInt(2) === 0
    ? { A: 'baseline', B: 'candidate' } : { A: 'candidate', B: 'baseline' }])) as Record<NextStageCase, Record<BlindArm, NextStageArm>>;
  const cases: Manifest['cases'] = [];
  for (const pair of pairs) {
    const inputs = {} as Record<BlindArm, { file: string; hash: string }>;
    for (const label of ['A', 'B'] as const) {
      const input = pair[mapping[pair.id][label]];
      const file = `${pair.id}-${label}.input.json`;
      await save(file, input);
      inputs[label] = { file, hash: inputHash(input) };
    }
    cases.push({ id: pair.id, task: pair.task, rubric: pair.rubric, inputs });
    if (pair.id === 'edit-warning' && inputs.A.hash !== inputs.B.hash) throw new Error('Negative control inputs must be byte-equivalent');
  }
  const rates = Object.fromEntries((Object.keys(NEXT_STAGE_ROUTES) as NextStageRoute[]).map(route => {
    const rate = getCostRate(route, NEXT_STAGE_ROUTES[route].model);
    if (!rate) throw new Error(`Missing reference rate: ${route}`);
    return [route, rate];
  })) as Record<NextStageRoute, Rate>;
  const manifest: Manifest = { revision: REVISION, head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    sources: initialSources, limits: NEXT_STAGE_LIMITS, rates, cases, cells: plannedNextStageCells() };
  await save('sealed-mapping.json', mapping);
  await save('manifest.json', manifest);
  await save('preregistration.json', {
    revision: REVISION, manifestHash: inputHash(manifest), limits: NEXT_STAGE_LIMITS,
    whyModel: 'Offline tests prove output and contract assembly. A next-response pair observes whether shorter receipts or moved child obligations induce extra confirmation reads, invalid recovery, omission or false reporting.',
    design: 'Two independent candidates; two natural checkpoints each. Same task/history/tool schemas within each pair. Pilot GLM/Kimi on edit-exact and child-readonly (8 calls); expand only after bound blind review, then DeepSeek and the other cases (13 calls). One attempt per cell, no tool execution, no retries/fallback.',
    negativeControl: 'edit-warning has hash-identical A/B inputs verified offline. Only A is dispatched once per model. This shared observation is not an independent candidate sample or an estimate of sampling variance.',
    review: 'Read phase.blind.json before mapping; write phase-review.json with packetHash, decision continue|stop and nonempty reason. Include case-level quality, recovery, proposed reads/tests, truthful reporting, attribution and uncertainty. Mechanical names are diagnostics, not a pass verdict.',
    original: 'Original unoptimized examples remain retained historical evidence; no original-version generation in this experiment. This baseline is current production, not the original project baseline.',
    scope: 'Child fixture has repo intelligence off, no bound visual/MCP owner and no custom specialist. Root contracts come from the actual Coding Runtime. Histories are scripted checkpoints, not claims that a real model completed earlier steps.',
    stop: 'Any source/input drift, request failure, unknown usage, attempt count mismatch, cap overrun or owner stop prevents further dispatch. A failed cell is preserved, never rerun in this revision.',
    pricing: 'Frozen repository reference rates. Coding subscription placeholder rates are not a cash bill or quota measurement.',
  });
  process.stdout.write(`Prepared ${manifest.cells.length} frozen cells at ${root}; no model called.\n`);
}

interface CellRecord {
  id: string; caseId: NextStageCase; route: NextStageRoute; label: BlindArm; inputHash: string;
  result: KodaXStreamResult | null; error: string | null; facts: ProviderRequestObservation[];
  wallMs: number; reservedTokens: number; reservedUsd: number; actualUsd: number | null;
  settlement: ReturnType<typeof settleComplexAttempt>;
}

async function runStage(stage: 'pilot' | 'expand'): Promise<void> {
  const manifest = await read<Manifest>('manifest.json');
  if (manifest.revision !== REVISION || inputHash(manifest.sources) !== inputHash(await sourceHashes())
    || inputHash(manifest.limits) !== inputHash(NEXT_STAGE_LIMITS)) throw new Error('Frozen source/limit mismatch');
  let initial: BudgetSnapshot | undefined;
  if (stage === 'expand') {
    const packet = await read<unknown>('pilot.blind.json');
    if (validateNextStageReview(await read('pilot-review.json'), inputHash(packet)) !== 'continue') throw new Error('Owner stopped after pilot');
    initial = await read<BudgetSnapshot>('pilot-budget.json');
    if (initial.calls !== 8 || initial.reservedTokens !== 0 || initial.unknownUsageCalls !== 0) throw new Error('Pilot accounting incomplete');
    const pilotRows = await read<CellRecord[]>('pilot-results.json');
    if (pilotRows.length !== 8 || pilotRows.some(row => row.settlement.stop)) throw new Error('Pilot did not finish cleanly');
  }
  const cells = manifest.cells.filter(cell => cell.phase === stage);
  const routes = [...new Set(cells.map(cell => cell.route))];
  for (const route of routes) if (!process.env[NEXT_STAGE_ROUTES[route].key]) throw new Error(`Missing ${route} credential; no fallback`);
  await save(`${stage}.lock`, { manifestHash: inputHash(manifest), started: new Date().toISOString() });
  const budget = new FirstTurnBudget(initial, NEXT_STAGE_LIMITS.calls);
  const abort = new AbortController();
  const rows: CellRecord[] = [];
  let stopped = false;
  const lanes = await Promise.allSettled(routes.map(async route => {
    for (const cell of cells.filter(item => item.route === route)) {
      if (stopped) return;
      const source = manifest.cases.find(item => item.id === cell.caseId)!.inputs[cell.label];
      const input = await read<FrozenInput>(source.file);
      if (inputHash(input) !== source.hash) throw new Error('Frozen input mismatch');
      const inputUpperBound = Buffer.byteLength(JSON.stringify(input), 'utf8') + 4096;
      const reservedTokens = inputUpperBound + NEXT_STAGE_LIMITS.output;
      const reservedUsd = calculateCost(manifest.rates[route], inputUpperBound, NEXT_STAGE_LIMITS.output);
      assertNextStageReservation(budget, reservedTokens, reservedUsd);
      await save(`${cell.id}.reservation.json`, { reservedTokens, reservedUsd, inputHash: source.hash });
      const facts: ProviderRequestObservation[] = [];
      const started = Date.now();
      let result: KodaXStreamResult | undefined;
      let error: string | null = null;
      const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(NEXT_STAGE_LIMITS.timeoutMs)]);
      try {
        result = await runWithAdditionalProviderRequestObserver(fact => facts.push(fact), () => observeProviderOperation(route, 'primary', undefined,
          () => getProvider(route).stream([...input.messages], [...input.tools], input.system, firstTurnReasoningFor(route), {
            modelOverride: NEXT_STAGE_ROUTES[route].model, maxOutputTokensOverride: NEXT_STAGE_LIMITS.output, singleAttempt: true,
          }, signal), undefined, signal));
      } catch (cause) { error = redact(cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)); }
      const usage = result?.usage;
      const actualUsd = usage ? calculateCost(manifest.rates[route], usage.inputTokens, usage.outputTokens, usage.cachedReadTokens ?? 0, usage.cachedWriteTokens ?? 0) : undefined;
      const settlement = settleComplexAttempt({ reservedTokens, reservedUsd, facts, tools: input.tools.map(tool => tool.name),
        reasoning: firstTurnReasoningFor(route), outputCap: NEXT_STAGE_LIMITS.output, requestCancelled: signal.aborted,
        taskCancelled: abort.signal.aborted, failed: error !== null, actualUsd });
      budget.settle(reservedTokens, reservedUsd, settlement.unknownUsage ? undefined : usage, actualUsd);
      const overrun = (usage?.totalTokens ?? 0) > reservedTokens || (usage?.outputTokens ?? 0) > NEXT_STAGE_LIMITS.output || (actualUsd ?? 0) > reservedUsd;
      const row: CellRecord = { id: cell.id, caseId: cell.caseId, route, label: cell.label, inputHash: source.hash,
        result: result ?? null, error, facts, wallMs: Date.now() - started, reservedTokens, reservedUsd, actualUsd: actualUsd ?? null,
        settlement: { ...settlement, stop: settlement.stop || overrun } };
      await save(`${cell.id}.result.json`, row);
      rows.push(row);
      if (row.settlement.stop) { stopped = true; abort.abort(new Error('Evaluation stopped; no retries')); return; }
    }
  }).map(lane => lane.catch(error => { stopped = true; abort.abort(error); throw error; })));
  const errors = lanes.flatMap(lane => lane.status === 'rejected' ? [redact(String(lane.reason))] : []);
  await save(`${stage}-results.json`, rows);
  await save(`${stage}-budget.json`, budget.state);
  const packet = { stage, manifestHash: inputHash(manifest), cases: manifest.cases.map(({ id, task, rubric }) => ({ id, task, rubric })),
    responses: rows.map(({ id, caseId, route, label, result, error }) => ({ id, caseId, route, label, error,
      textBlocks: result?.textBlocks ?? [], toolCalls: result?.toolBlocks ?? [], thinkingBlocks: result?.thinkingBlocks ?? [],
      stopReason: result?.stopReason ?? null })), errors };
  await save(`${stage}.blind.json`, packet);
  process.stdout.write(JSON.stringify({ stage, calls: budget.state.calls, completed: rows.length, stopped: stopped || errors.length > 0,
    packet: path.join(root, `${stage}.blind.json`), packetHash: inputHash(packet), budget: budget.state }) + '\n');
  if (stopped || errors.length > 0 || rows.length !== cells.length) throw new Error('Evaluation incomplete; inspect preserved evidence, do not rerun');
}

async function reveal(): Promise<void> {
  const packet = await read<unknown>('expand.blind.json');
  validateNextStageReview(await read('expand-review.json'), inputHash(packet));
  const mapping = await read<Record<NextStageCase, Record<BlindArm, NextStageArm>>>('sealed-mapping.json');
  const rows = [...await read<CellRecord[]>('pilot-results.json'), ...await read<CellRecord[]>('expand-results.json')];
  await save('revealed-results.json', rows.map(row => ({ ...row, arm: mapping[row.caseId][row.label] })));
  process.stdout.write(`Revealed ${rows.length} preserved observations; no automatic ship verdict.\n`);
}

it.skipIf(!phase)('runs a frozen token-efficiency next-stage phase', async () => {
  const relative = path.relative(os.tmpdir(), root);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Output must be an OS Temp child');
  await fs.mkdir(root, { recursive: true });
  if (phase === 'prepare') await prepare();
  else if (phase === 'pilot' || phase === 'expand') await runStage(phase);
  else if (phase === 'reveal') await reveal();
  else throw new Error('Expected prepare, pilot, expand or reveal');
}, 1_200_000);
