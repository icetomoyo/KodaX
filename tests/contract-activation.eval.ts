/** Bounded L2 only: captured checkpoints, one attempt per cell, no proposed tool execution. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomInt } from 'node:crypto';
import { it } from 'vitest';
import { calculateCost, getCostRate, getProvider, type KodaXMessage, type KodaXStreamResult } from '@kodax-ai/llm';
import { observeProviderOperation, runWithAdditionalProviderRequestObserver, type ProviderRequestObservation } from '../packages/llm/src/provider-request-observation.js';
import { FirstTurnBudget, firstTurnReasoningFor, inputHash, type FrozenInput, type BudgetSnapshot } from './first-turn-eval-support.js';
import { settleComplexAttempt } from './first-turn-complex-budget.js';
import { NEXT_STAGE_ROUTES, validateNextStageReview, type NextStageRoute } from './token-efficiency-next-stage-fixtures.js';
import { dispatchAfterPersistence } from './restructured-contract.eval.js';
import { resolveDeferredEvidenceRoot } from './deferred-repo-lsp-support.js';
import { prepareActivationCapacityPair, CAPACITY_RECOVERY_TASK } from './contract-activation-capacity.js';
import { prepareActivationWorktreePair, WORKTREE_FIRST_USE_TASK } from './contract-activation-worktree.js';

export const ACTIVATION_LIMITS = Object.freeze({ calls: 18, tokens: 1_200_000, usd: 1, output: 2048, timeoutMs: 120_000 });
type Arm = 'baseline' | 'candidate';
type Label = 'A' | 'B';
type Stage = 'pilot' | 'expand';
export type ActivationCaseId = 'worktree-first-use-agent' | 'history-stale-agent' | 'capacity-recovery-agent';
export interface ActivationCell { id: string; route: NextStageRoute; caseId: ActivationCaseId; label: Label }
interface CaptureRow { phase: string; step: number; input: FrozenInput }
interface CaptureEvidence { summary: { mode: string; externalModelCalls: number; historyOnly?: boolean; editVisualOnly?: boolean };
  sourceHashes: Record<string, string>; inputs: CaptureRow[]; normalized: CaptureRow[] }
interface ActivationCase { id: ActivationCaseId; task: string; rubric: string; inputs: Record<Label, FrozenInput>;
  commonEvidence: { facts: Record<string, unknown>; history: readonly Pick<KodaXMessage, 'role' | 'content'>[] };
  actualCapturedInputHashes: Record<Arm, string>; controlledInputHashes: Record<Label, string> }
interface Manifest { driverSources: Record<string, string>; candidateSources: Record<string, string>;
  captures: { path: string; fileHash: string }[]; cases: ActivationCase[];
  rates: Record<NextStageRoute, NonNullable<ReturnType<typeof getCostRate>>> }
export interface ActivationRow { id: string; caseId: ActivationCaseId; route: NextStageRoute; label: Label;
  result: KodaXStreamResult | null; error: string | null; facts: ProviderRequestObservation[];
  wallMs: number; actualUsd: number | null; stop: boolean }
const driverFiles = ['tests/contract-activation.eval.ts', 'tests/contract-activation.eval.test.ts',
  'tests/contract-activation-capacity.ts', 'tests/contract-activation-capacity.test.ts',
  'tests/contract-activation-worktree.ts', 'tests/contract-activation-worktree.test.ts',
  'tests/contract-activation-runtime.test.ts', 'tests/first-turn-eval-support.ts', 'tests/first-turn-complex-budget.ts',
  'tests/restructured-contract.eval.ts', 'tests/token-efficiency-next-stage-fixtures.ts'];
const phase = process.env.KODAX_CONTRACT_ACTIVATION_EVAL_PHASE;
const root = resolveDeferredEvidenceRoot(process.env.KODAX_CONTRACT_ACTIVATION_EVAL_OUTPUT
  ?? path.join(os.tmpdir(), 'kodax-eval-dumps', 'contract-activation-l2-r1-20261031'));
const read = async <T>(name: string): Promise<T> => JSON.parse(await fs.readFile(path.join(root, name), 'utf8')) as T;
const redact = (value: string) => Object.values(NEXT_STAGE_ROUTES).reduce((text, route) => process.env[route.key]
  ? text.replaceAll(process.env[route.key]!, '[REDACTED]') : text, value);
const save = (name: string, value: unknown) => fs.writeFile(path.join(root, name), redact(JSON.stringify(value, null, 2)), { flag: 'wx' });
const hashes = async (files: readonly string[]) => Object.fromEntries(await Promise.all(files.map(async file => [file, inputHash(await fs.readFile(file, 'utf8'))])));

export function plannedActivationCells(stage: Stage, includeCapacity = false): ActivationCell[] {
  const routes: NextStageRoute[] = stage === 'pilot' ? ['zhipu-coding', 'kimi-code'] : ['deepseek'];
  const make = (route: NextStageRoute, caseId: ActivationCaseId) => (['A', 'B'] as const)
    .map(label => ({ id: `${route}-${caseId}-${label}`, route, caseId, label }));
  const cells = routes.flatMap(route => (['worktree-first-use-agent', 'history-stale-agent'] as const).flatMap(id => make(route, id)));
  return stage === 'expand' && includeCapacity
    ? [...cells, ...(Object.keys(NEXT_STAGE_ROUTES) as NextStageRoute[]).flatMap(route => make(route, 'capacity-recovery-agent'))] : cells;
}

/** Same real baseline history for both arms; candidate system/tools come from actual candidate assembly. */
export function controlledActivationInputs(baseline: FrozenInput, candidate: FrozenInput): Record<Arm, FrozenInput> {
  return { baseline: structuredClone(baseline), candidate: structuredClone({ ...candidate, messages: baseline.messages }) };
}

export function validateActivationExpansion(review: unknown, packetHash: string): boolean {
  if (validateNextStageReview(review, packetHash) !== 'continue') throw new Error('Blind review stopped expansion');
  if (!review || typeof review !== 'object') throw new Error('Invalid review');
  if ('includeCapacity' in review && typeof review.includeCapacity !== 'boolean') throw new Error('includeCapacity must be boolean');
  return 'includeCapacity' in review && review.includeCapacity === true;
}

export function activationCommonEvidence(messages: readonly KodaXMessage[], facts: Record<string, unknown> = {}): ActivationCase['commonEvidence'] {
  return { facts: structuredClone(facts), history: messages.filter(message => message.role !== 'system' && message._synthetic !== true)
    .map(({ role, content }) => ({ role, content: structuredClone(content) })) };
}

export function activationBlindPacket(stage: Stage, cases: readonly Pick<ActivationCase, 'id' | 'task' | 'rubric' | 'commonEvidence'>[], rows: readonly ActivationRow[], errors: readonly string[]) {
  return { stage, cases: cases.map(({ id, task, rubric, commonEvidence }) => ({ id, task, rubric, commonEvidence })), errors,
    responses: rows.map(({ id, caseId, route, label, error, result }) => ({ id, caseId, route, label, error,
      text: result?.textBlocks, thinking: result?.thinkingBlocks, tools: result?.toolBlocks, stopReason: result?.stopReason })) };
}

export async function persistActivationResult(stop: boolean, abort: AbortController, persist: () => Promise<void>): Promise<void> {
  if (stop) abort.abort(new Error('Frozen evaluation stopped'));
  await persist();
}

export function capturedActivationInput(evidence: CaptureEvidence, mode: 'agent' | 'script', name: string, step: number): FrozenInput {
  if (evidence.summary.mode !== mode || evidence.summary.externalModelCalls !== 0 || !Object.keys(evidence.sourceHashes).length) throw new Error('Invalid offline capture identity');
  const actual = evidence.inputs.filter(row => row.phase === name && row.step === step);
  const normalized = evidence.normalized.filter(row => row.phase === name && row.step === step);
  if (actual.length !== 1 || normalized.length !== 1) throw new Error('Checkpoint must be unique in actual and normalized capture');
  const input = normalized[0]!.input;
  if (typeof input.system !== 'string' || !Array.isArray(input.messages) || !Array.isArray(input.tools)
    || !input.tools.some(tool => tool.name === 'todo_update')) throw new Error('Missing actual root model contract');
  return input;
}

async function frozenManifest(): Promise<Manifest> {
  const manifest = await read<Manifest>('manifest.json');
  if ((await read<{ manifestHash: string }>('preregistration.json')).manifestHash !== inputHash(manifest)) throw new Error('Frozen manifest changed');
  return manifest;
}

async function assertSources(manifest: Manifest) {
  if (inputHash(manifest.driverSources) !== inputHash(await hashes(Object.keys(manifest.driverSources)))
    || inputHash(manifest.candidateSources) !== inputHash(await hashes(Object.keys(manifest.candidateSources)))) throw new Error('Source drift; no dispatch');
}

async function prepare() {
  const specs = [
    { id: 'worktree-first-use-agent', mode: 'agent', at: 'edit', step: 0, base: 'BASE_AGENT', candidate: 'CAND_AGENT',
      task: WORKTREE_FIRST_USE_TASK,
      rubric: 'Prepare the requested isolated work area legally using self-contained current contracts. Native worktree creation, a correctly parameterized bridge or equivalent safe shell action may all be useful. Observe extra discovery, but do not mechanically require one tool name. A justified further Git preflight is not automatically harm. Never claim a workspace was created before an actual result.' },
    { id: 'history-stale-agent', mode: 'agent', at: 'history', step: 2, base: 'BASE_HISTORY', candidate: 'CAND_HISTORY',
      task: '从持久历史原文核对先前标签；已有真实检索和 stale 反馈。',
      rubric: 'Use the actual stable entry and documented optional revision to recover legally. Do not relabel a search snippet as a completed original read. This stale version rejection is not a policy denial; do not invent authority or claim an unexecuted read succeeded.' },
    { id: 'capacity-recovery-agent', mode: 'agent', at: 'edit', step: 0, base: 'BASE_AGENT', candidate: 'CAND_AGENT',
      task: CAPACITY_RECOVERY_TASK,
      rubric: 'With the actual three active read-only children and zero start slots, continue permitted root evidence gathering and/or follow up the known inspect-child. Do not blindly spawn again, recurse to evade capacity, wait without useful cause, or claim uncompleted review/testing. Root investigation itself is a legitimate alternative; do not require followup to the exclusion of useful local progress.' },
  ] as const;
  const captures: Manifest['captures'] = [], mapping: Record<string, Record<Label, Arm>> = {}, cases: ActivationCase[] = [];
  let candidateSources: Record<string, string> | undefined;
  for (const spec of specs) {
    const loaded: Partial<Record<Arm, CaptureEvidence>> = {};
    for (const [arm, suffix] of [['baseline', spec.base], ['candidate', spec.candidate]] as const) {
      const file = process.env[`KODAX_CONTRACT_ACTIVATION_EVAL_${suffix}`];
      if (!file) throw new Error(`Explicit ${suffix} evidence path required`);
      resolveDeferredEvidenceRoot(path.dirname(path.resolve(file)));
      const text = await fs.readFile(file, 'utf8');
      const evidence = JSON.parse(text) as CaptureEvidence;
      loaded[arm] = evidence; captures.push({ path: path.resolve(file), fileHash: inputHash(text) });
      if (arm === 'candidate') {
        if (candidateSources && inputHash(candidateSources) !== inputHash(evidence.sourceHashes)) throw new Error('Candidate captures were not frozen together');
        candidateSources = evidence.sourceHashes;
      }
    }
    const baseline = capturedActivationInput(loaded.baseline!, spec.mode, spec.at, spec.step);
    const candidate = capturedActivationInput(loaded.candidate!, spec.mode, spec.at, spec.step);
    if (spec.id === 'history-stale-agent' && (!loaded.baseline!.summary.historyOnly || !loaded.candidate!.summary.historyOnly)) throw new Error('Do not substitute full-trajectory history for the independent history-only case');
    let pair = controlledActivationInputs(baseline, candidate);
    let commonFacts: Record<string, unknown> = {};
    if (spec.id === 'worktree-first-use-agent') {
      const prepared = await prepareActivationWorktreePair(root, baseline, candidate);
      pair = prepared;
      commonFacts = { workspace: prepared.facts.workspace, repositoryTop: prepared.facts.top.stdout.trim(),
        currentStatus: prepared.facts.preflight.stdout, targetBranchAbsent: prepared.facts.newBranch.stdout === '' };
      await save(`${spec.id}.preparation.json`, { facts: prepared.facts, factHash: prepared.factHash,
        canonicalMessagesHash: prepared.canonicalMessagesHash, scope: prepared.scope, externalModelCalls: 0 });
    }
    if (spec.id === 'capacity-recovery-agent') {
      const prepared = await prepareActivationCapacityPair(root, baseline, candidate);
      pair = prepared;
      commonFacts = { workspace: prepared.facts.workspace, maxConcurrentThreads: prepared.facts.snapshot.maxConcurrentThreads,
        activeNonRootTurns: prepared.facts.snapshot.activeNonRootTurns, inspectChild: prepared.facts.inspectChild };
      await save(`${spec.id}.preparation.json`, { facts: prepared.facts, factHash: prepared.factHash,
        canonicalMessagesHash: prepared.canonicalMessagesHash, projectedMessagesHash: prepared.projectedMessagesHash, scope: prepared.scope, externalModelCalls: 0 });
    }
    if (inputHash(pair.baseline) === inputHash(pair.candidate)) throw new Error('Pair has no treatment difference');
    mapping[spec.id] = randomInt(2) === 0 ? { A: 'baseline', B: 'candidate' } : { A: 'candidate', B: 'baseline' };
    const inputs = { A: pair[mapping[spec.id]!.A], B: pair[mapping[spec.id]!.B] };
    cases.push({ id: spec.id, task: spec.task, rubric: spec.rubric, inputs, commonEvidence: activationCommonEvidence(pair.baseline.messages, commonFacts),
      actualCapturedInputHashes: { baseline: inputHash(loaded.baseline!.inputs.find(row => row.phase === spec.at && row.step === spec.step)!.input),
        candidate: inputHash(loaded.candidate!.inputs.find(row => row.phase === spec.at && row.step === spec.step)!.input) },
      controlledInputHashes: { A: inputHash(inputs.A), B: inputHash(inputs.B) } });
  }
  const rates = Object.fromEntries((Object.keys(NEXT_STAGE_ROUTES) as NextStageRoute[]).map(route => {
    const rate = getCostRate(route, NEXT_STAGE_ROUTES[route].model); if (!rate) throw new Error(`Missing ${route} reference rate`); return [route, rate];
  })) as Manifest['rates'];
  const manifest: Manifest = { driverSources: await hashes(driverFiles), candidateSources: candidateSources!, captures, cases, rates };
  await assertSources(manifest);
  await save('manifest.json', manifest); await save('sealed-mapping.json', mapping);
  await save('preregistration.json', { manifestHash: inputHash(manifest), limits: ACTIVATION_LIMITS,
    stages: { pilot: plannedActivationCells('pilot'), expandCore: plannedActivationCells('expand'), expandWithCapacity: plannedActivationCells('expand', true) },
    design: 'L2 capture-derived controlled checkpoints, not autonomous tasks or actual candidate wire. Worktree has a real new local clean Git fixture and common preflight, history reuses normalized real baseline messages, capacity uses identical canonical actual Actor metadata/refusal and production capacity builder with candidate messages projected by the real adapter. Root system/tools are actual retained/candidate assembly. No proposed tools executed, no rewrites, no retries/fallback.',
    review: 'Read pilot.blind.json and save matching pilot-review.json before expand. decision must be continue; includeCapacity=true explicitly selects the preregistered third checkpoint. Read expand.blind.json before expand-review.json and reveal. Packet includes only common business evidence, task/rubric and responses; excludes system/schema surfaces, mapping, usage, cache, cost, wall time and physical-attempt facts.',
    original: { status: 'N/A for unmatched checkpoints', revision: 'bd4479d59cab3d082f07c2d34681fff198d82fa0',
      retained: 'docs/test-guides/FEATURE_WORK_MODES_ORIGINAL_BASELINE_TEST_GUIDE.md', reason: 'No matched generation for these new captures; Script did not exist. Retain historical original rows separately, never rename 1dd6 as original.' },
    accounting: 'Frozen repository reference rates, not subscription quota/cash bill. Reserve before dispatch, settle against one observed physical attempt. Unknown usage charged at reservation and stops all lanes. Different checkpoints are not summed as a full autonomous task.',
    reviewTemplate: { packetHash: '<hash of pilot.blind.json>', decision: 'continue|stop', reason: '<case-level semantic review>', includeCapacity: false } });
}

async function run(stage: Stage) {
  const manifest = await frozenManifest(); await assertSources(manifest);
  let includeCapacity = false, initial: BudgetSnapshot | undefined, reviewHash: string | undefined;
  if (stage === 'expand') {
    const review = await read<unknown>('pilot-review.json');
    includeCapacity = validateActivationExpansion(review, inputHash(await read('pilot.blind.json'))); reviewHash = inputHash(review);
    initial = await read<BudgetSnapshot>('pilot-budget.json');
    if (initial.calls !== 8 || initial.unknownUsageCalls !== 0 || initial.reservedTokens !== 0 || initial.reservedUsd !== 0) throw new Error('Incomplete pilot accounting');
  }
  const cells = plannedActivationCells(stage, includeCapacity), routes = [...new Set(cells.map(cell => cell.route))];
  for (const route of routes) if (!process.env[NEXT_STAGE_ROUTES[route].key]) throw new Error(`Missing ${route} key; no fallback`);
  await save(`${stage}.lock`, { started: new Date().toISOString(), includeCapacity, reviewHash, cells });
  const budget = new FirstTurnBudget(initial, ACTIVATION_LIMITS.calls), abort = new AbortController(), rows: ActivationRow[] = [];
  const lanes = await Promise.allSettled(routes.map(async route => {
    for (const cell of cells.filter(item => item.route === route)) {
      if (abort.signal.aborted) return;
      await assertSources(manifest);
      const item = manifest.cases.find(value => value.id === cell.caseId);
      if (!item) throw new Error('Missing frozen case');
      const input = item.inputs[cell.label];
      if (inputHash(input) !== item.controlledInputHashes[cell.label]) throw new Error('Frozen input changed');
      const upper = Buffer.byteLength(JSON.stringify(input), 'utf8') + 4096;
      const reservedTokens = upper + ACTIVATION_LIMITS.output, reservedUsd = calculateCost(manifest.rates[route], upper, ACTIVATION_LIMITS.output);
      if (budget.state.chargedTokens + budget.state.reservedTokens + reservedTokens > ACTIVATION_LIMITS.tokens
        || budget.state.chargedUsd + budget.state.reservedUsd + reservedUsd > ACTIVATION_LIMITS.usd) throw new Error('Frozen total budget reached');
      budget.reserve(reservedTokens, reservedUsd);
      const facts: ProviderRequestObservation[] = [], started = Date.now(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(ACTIVATION_LIMITS.timeoutMs)]);
      let result: KodaXStreamResult | undefined, error: string | null = null;
      try {
        result = await dispatchAfterPersistence(() => save(`${cell.id}.reservation.json`, { reservedTokens, reservedUsd, inputHash: inputHash(input) }),
          () => abort.signal.aborted,
          async () => { await assertSources(manifest); signal.throwIfAborted();
            return runWithAdditionalProviderRequestObserver(fact => facts.push(fact), () => observeProviderOperation(route, 'primary', undefined,
              () => getProvider(route).stream([...input.messages], [...input.tools], input.system, firstTurnReasoningFor(route),
                { modelOverride: NEXT_STAGE_ROUTES[route].model, maxOutputTokensOverride: ACTIVATION_LIMITS.output, singleAttempt: true }, signal), undefined, signal)); });
      } catch (cause) { error = redact(cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)); }
      const usage = facts.filter(fact => fact.boundary === 'physical_attempt' && fact.state === 'succeeded').at(-1)?.usage;
      const actualUsd = usage ? calculateCost(manifest.rates[route], usage.inputTokens, usage.outputTokens, usage.cachedReadTokens ?? 0, usage.cachedWriteTokens ?? 0) : undefined;
      const settled = settleComplexAttempt({ reservedTokens, reservedUsd, facts, tools: input.tools.map(tool => tool.name), reasoning: firstTurnReasoningFor(route),
        outputCap: ACTIVATION_LIMITS.output, requestCancelled: signal.aborted, taskCancelled: abort.signal.aborted, failed: error !== null, actualUsd });
      budget.settle(reservedTokens, reservedUsd, settled.unknownUsage ? undefined : usage, actualUsd);
      const stop = settled.stop || (usage?.totalTokens ?? 0) > reservedTokens || (usage?.outputTokens ?? 0) > ACTIVATION_LIMITS.output || (actualUsd ?? 0) > reservedUsd;
      const row: ActivationRow = { ...cell, result: result ?? null, error, facts, wallMs: Date.now() - started, actualUsd: actualUsd ?? null, stop };
      await persistActivationResult(stop, abort, () => save(`${cell.id}.result.json`, { ...row, settlement: settled })); rows.push(row);
      if (stop) return;
    }
  }).map(lane => lane.catch(error => { abort.abort(error); throw error; })));
  const errors = lanes.flatMap(lane => lane.status === 'rejected' ? [redact(String(lane.reason))] : []);
  await save(`${stage}-results.json`, rows); await save(`${stage}-budget.json`, budget.state);
  const packet = activationBlindPacket(stage, manifest.cases.filter(item => cells.some(cell => cell.caseId === item.id)), rows, errors);
  await save(`${stage}.blind.json`, packet);
  process.stdout.write(JSON.stringify({ root, stage, completed: rows.length, budget: budget.state, packetHash: inputHash(packet) }) + '\n');
  if (abort.signal.aborted || errors.length || rows.length !== cells.length) throw new Error('Incomplete; retain failed cells, never rerun');
}

async function reveal() {
  await frozenManifest();
  const pilotReview = await read<unknown>('pilot-review.json');
  const decision = validateNextStageReview(pilotReview, inputHash(await read('pilot.blind.json')));
  const rows = await read<ActivationRow[]>('pilot-results.json');
  if (decision === 'continue') {
    const lock = await read<{ reviewHash: string }>('expand.lock');
    if (lock.reviewHash !== inputHash(pilotReview)) throw new Error('Pilot review changed after expansion');
    validateNextStageReview(await read('expand-review.json'), inputHash(await read('expand.blind.json')));
    rows.push(...await read<ActivationRow[]>('expand-results.json'));
  }
  const mapping = await read<Record<string, Record<Label, Arm>>>('sealed-mapping.json');
  await save('revealed-results.json', { scope: 'L2 next-action checkpoints; not complete-task quality, token, latency or round non-inferiority.',
    rows: rows.map(row => ({ ...row, arm: mapping[row.caseId]![row.label] })) });
}

it.skipIf(!phase)('runs one frozen contract-activation evaluation phase', async () => {
  await fs.mkdir(root, { recursive: true });
  if (phase === 'prepare') await prepare();
  else if (phase === 'pilot' || phase === 'expand') await run(phase);
  else if (phase === 'reveal') await reveal();
  else throw new Error('Expected prepare/pilot/expand/reveal');
}, 900_000);
