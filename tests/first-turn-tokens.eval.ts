/** Manual bounded Layer-2 probe. Default is preflight only: no model calls.
 * KODAX_FIRST_TURN_EVAL_RUN=1 requires an explicitly approved preregistered batch.
 * Run with vite-node, not the repository-wide paid eval suite.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomInt } from 'node:crypto';
import { getProvider, getProviderModels, getCostRate, calculateCost, resolveModelCapabilities } from '../packages/llm/src/index.js';
import { observeProviderOperation, runWithProviderRequestObserver, type ProviderRequestObservation } from '../packages/llm/src/provider-request-observation.js';
import type { CostRate } from '../packages/llm/src/cost-rates.js';
import { FirstTurnBudget, FIRST_TURN_LIMITS, comparisonInputs, firstTurnReasoningFor, inputHash, observeFirstTurn, type FrozenCapture, type ComparisonAxis, type BudgetSnapshot } from './first-turn-eval-support.js';

const routes = {
  'zhipu/glm53flash': { provider: 'zhipu-coding', model: 'glm-5.3-flash', env: 'ZHIPU_CODING_API_KEY', billing: 'coding-plan' },
  'zhipu/glm53': { provider: 'zhipu-coding', model: 'glm-5.3', env: 'ZHIPU_CODING_API_KEY', billing: 'coding-plan' },
  'zai/glm53': { provider: 'zai-coding', model: 'glm-5.3', env: 'ZAI_CODING_API_KEY', billing: 'coding-plan' },
  'zai/glm53flash': { provider: 'zai-coding', model: 'glm-5.3-flash', env: 'ZAI_CODING_API_KEY', billing: 'coding-plan' },
  'ds/flash': { provider: 'deepseek', model: 'deepseek-flash', env: 'DEEPSEEK_API_KEY', billing: 'token-bill' },
  kimi: { provider: 'kimi-code', model: 'kimi-for-coding', env: 'KIMI_CODE_API_KEY', billing: 'coding-plan' },
} as const;
type RouteId = keyof typeof routes;
const isRoute = (value: string): value is RouteId => Object.hasOwn(routes, value);
const dumpRoot = path.join(os.tmpdir(), 'kodax-eval-dumps', 'first-turn-tokens-v1');
const baselinePath = process.env.KODAX_FIRST_TURN_BASELINE_INPUT ?? path.join(dumpRoot, 'baseline-r3-inputs.json');
const candidatePath = process.env.KODAX_FIRST_TURN_CANDIDATE_INPUT ?? path.join(dumpRoot, 'candidate-r3-inputs.json');
const axis = process.env.KODAX_FIRST_TURN_AXIS ?? 'todo-tools';
if (!['todo-tools', 'worker-prompt', 'combined'].includes(axis)) throw new Error('Unknown comparison axis');
const phase = process.env.KODAX_FIRST_TURN_PHASE ?? 'pilot';
if (!['pilot', 'followup'].includes(phase)) throw new Error('Unknown case phase');
const requested = (process.env.KODAX_FIRST_TURN_ROUTES ?? 'zhipu/glm53flash,kimi').split(',');
if (requested.some(r => !isRoute(r)) || new Set(requested).size !== requested.length) throw new Error('Unknown/duplicate route');
const selectedRoutes = requested.filter(isRoute);
// A single batch is at most 2 routes × 2 cases × 2 arms = 8 calls.
if (selectedRoutes.length > 2 || selectedRoutes.length < 1) throw new Error('A reviewed batch needs one or two routes');
const baseline = JSON.parse(await fs.readFile(baselinePath, 'utf8')) as FrozenCapture;
let candidate: FrozenCapture | undefined;
try { candidate = JSON.parse(await fs.readFile(candidatePath, 'utf8')) as FrozenCapture; }
catch (error: unknown) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
const availability = Object.entries(routes).map(([id, route]) => ({ id, provider: route.provider, model: route.model, credentialPresent: Boolean(process.env[route.env]), descriptorPresent: getProviderModels(route.provider).includes(route.model), billing: route.billing }));
for (const id of selectedRoutes) {
  const route = routes[id];
  if (resolveModelCapabilities(route.provider, route.model)?.reasoningProfile?.localRejectEfforts?.includes(firstTurnReasoningFor(route.provider).effort)) throw new Error('Frozen reasoning is locally rejected; fix preflight before paid calls');
}
const reusePath = process.env.KODAX_FIRST_TURN_REUSE_EVIDENCE;
let reusableRows: readonly Record<string, unknown>[] = [];
let priorReasoning: unknown;
if (reusePath) {
  const prior = JSON.parse(await fs.readFile(path.join(path.dirname(reusePath), 'preflight.json'), 'utf8')) as Record<string, unknown>;
  if (prior.axis !== axis) throw new Error('Cannot reuse another comparison axis');
  const evidence = JSON.parse(await fs.readFile(reusePath, 'utf8')) as { runsRaw: readonly Record<string, unknown>[] };
  reusableRows = evidence.runsRaw; priorReasoning = prior.reasoning;
}
const selectedCaseIds = process.env.KODAX_FIRST_TURN_CASES?.split(',');
const pilotCases = baseline.cases.filter(c => c.phase === phase && (!selectedCaseIds || selectedCaseIds.includes(c.id)));
if (pilotCases.length < 1 || pilotCases.length > 2 || (selectedCaseIds && (new Set(selectedCaseIds).size !== selectedCaseIds.length || pilotCases.length !== selectedCaseIds.length))) throw new Error('Frozen batch must select one or two recognized cases in its phase');
const preflight = { revision: 'r3', axis, phase, limits: FIRST_TURN_LIMITS, routes: availability, selectedRoutes, selectedCases: pilotCases.map(c => c.id), baselinePath, candidatePath, candidatePresent: candidate !== undefined, baselineHash: inputHash(baseline), candidateHash: candidate ? inputHash(candidate) : null, batchCalls: selectedRoutes.length * pilotCases.length * 2, reasoningByRoute: Object.fromEntries(selectedRoutes.map(id => [id, firstTurnReasoningFor(routes[id].provider)])), reusePath: reusePath ?? null, newCallsBeforeThisBatch: 0 };
process.stdout.write(JSON.stringify(preflight, null, 2) + '\n');
if (process.env.KODAX_FIRST_TURN_EVAL_RUN === '1') {
  if (!candidate) throw new Error('Candidate must be frozen before a paid run');
  if (selectedRoutes.some(id => !availability.find(r => r.id === id)?.credentialPresent || !availability.find(r => r.id === id)?.descriptorPresent)) throw new Error('Selected credential or source descriptor missing; no fallback');
  const runId = process.env.KODAX_FIRST_TURN_BATCH_ID;
  if (!runId || !/^[a-z0-9-]+$/.test(runId)) throw new Error('Explicit unique reviewed batch id required');
  const directory = path.join(dumpRoot, runId);
  await fs.mkdir(directory); // Existing batch is never silently retried/overwritten.
  const backupDirectories = ['evidence-backup-a', 'evidence-backup-b'].map(name => path.join(os.tmpdir(), name, runId));
  for (const backup of backupDirectories) await fs.mkdir(backup, { recursive: true });
  for (const target of [directory, ...backupDirectories]) await fs.writeFile(path.join(target, 'preflight.json'), JSON.stringify(preflight, null, 2));
  const ledgerPath = path.join(dumpRoot, 'paid-budget-ledger.json');
  const lockPath = path.join(dumpRoot, 'paid-budget.lock');
  const lock = await fs.open(lockPath, 'wx');
  let initial: BudgetSnapshot;
  try { initial = JSON.parse(await fs.readFile(ledgerPath, 'utf8')) as BudgetSnapshot; }
  catch (error: unknown) {
    await lock.close(); await fs.unlink(lockPath);
    throw new Error('Existing shared budget ledger is required; never reset missing evidence to zero spend', { cause: error });
  }
  let budget: FirstTurnBudget;
  try { budget = new FirstTurnBudget(initial); }
  catch (error: unknown) { await lock.close(); await fs.unlink(lockPath); throw error; }
  let persistence = Promise.resolve();
  const persist = (file: string, content: unknown): Promise<void> => {
    const serialized = JSON.stringify(content, null, 2);
    persistence = persistence.then(async () => {
      await fs.writeFile(file, serialized);
      // Mirror raw rows, blind bundle, and mapping before dispatching the next cell.
      if (path.dirname(file) === directory) {
        for (const backup of backupDirectories) await fs.writeFile(path.join(backup, path.basename(file)), serialized);
      }
    });
    return persistence;
  };
  const saveBudget = () => persist(ledgerPath, budget.state);
  const evidence: unknown[] = [];
  const mapping: unknown[] = [];
  const persistEvidence = async (id: string, caseId: string, arm: string, row: unknown): Promise<void> => {
    evidence.push(row);
    await persist(path.join(directory, `${id.replaceAll('/', '-')}-${caseId}-${arm}.json`), row);
    await persist(path.join(directory, 'blind-evidence.json'), { preRegisteredRubric: 'Main-session blind paired review: task validity, preferred arm/tie, value none/minor/material, regression severity, cause eval-design/provider-noise/prompt-regression/inconclusive, reason. No automatic ship boolean.', runsRaw: evidence, mainSessionReview: [] });
  };
  const redactedError = (error: unknown): string => {
    let message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    for (const route of Object.values(routes)) { const value = process.env[route.env]; if (value) message = message.replaceAll(value, '[REDACTED]'); }
    return message;
  };
  try {
    // Distinct providers may run in parallel; routes sharing a provider share one sequential lane.
    const lanes = new Map<string, RouteId[]>();
    for (const id of selectedRoutes) { const provider = routes[id].provider; lanes.set(provider, [...(lanes.get(provider) ?? []), id]); }
    let stopping = false;
    const outcomes = await Promise.allSettled([...lanes.values()].map(async ids => {
      try {
      for (const id of ids) {
        const route = routes[id];
        const reasoning = firstTurnReasoningFor(route.provider);
        let rate = getCostRate(route.provider, route.model);
        if (route.billing === 'token-bill') {
          const verifiedPricePath = process.env.KODAX_FIRST_TURN_VERIFIED_PRICE;
          if (!verifiedPricePath) throw new Error('Official DeepSeek route requires newly verified price evidence before dispatch');
          const verified = JSON.parse(await fs.readFile(verifiedPricePath, 'utf8')) as { model: string; source: string; checkedAt: string; rate: CostRate };
          if (verified.model !== route.model || !verified.source.startsWith('https://') || !verified.checkedAt || !(verified.rate.inputPer1M > 0) || !(verified.rate.outputPer1M > 0)) throw new Error('Invalid verified DeepSeek price evidence');
          rate = verified.rate;
        }
        if (!rate) throw new Error('No rate for conservative budget accounting');
        for (const baseCase of pilotCases) {
          const nextCase = candidate.cases.find(c => c.id === baseCase.id);
          if (!nextCase) throw new Error('Candidate missing frozen case');
          const inputs = comparisonInputs(baseCase, nextCase, axis as ComparisonAxis);
          const reverse = randomInt(2) === 1;
          const ordered = reverse ? [inputs[1], inputs[0]] : inputs;
          mapping.push({ route: id, case: baseCase.id, A: reverse ? 'candidate' : 'baseline', B: reverse ? 'baseline' : 'candidate', inputHashes: ordered.map(inputHash) });
          await persist(path.join(directory, 'unblind-mapping.json'), mapping);
          for (const [armIndex, input] of ordered.entries()) {
            if (stopping) return;
            const arm = armIndex === 0 ? 'A' : 'B';
            const reused = reusableRows.find(row => row.route === id && row.provider === route.provider && row.model === route.model && row.case === baseCase.id && row.inputHash === inputHash(input) && row.error === null && row.usage !== null && row.usage !== undefined && JSON.stringify(row.reasoning ?? priorReasoning) === JSON.stringify(reasoning));
            if (reused) {
              await persistEvidence(id, baseCase.id, arm, { ...reused, arm, reasoning, reusedFrom: { evidencePath: reusePath, rowHash: inputHash(reused), note: 'Same route/model/input hash/reasoning and successful raw; original physical observation may be unavailable. No new provider call.' } });
              continue;
            }
            // Conservative pre-dispatch allowance: serialized UTF-8 bytes + protocol margin, not chars/4.
            const reservedInputTokens = Buffer.byteLength(JSON.stringify(input)) + 4096;
            const reservedTokens = reservedInputTokens + FIRST_TURN_LIMITS.maxOutputTokens;
            const reservedUsd = calculateCost(rate, reservedInputTokens, FIRST_TURN_LIMITS.maxOutputTokens);
            budget.reserve(reservedTokens, reservedUsd);
            await saveBudget();
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(new Error('Frozen per-call timeout')), FIRST_TURN_LIMITS.timeoutMs);
            const observations: ProviderRequestObservation[] = [];
            const start = Date.now();
            let result: Awaited<ReturnType<ReturnType<typeof getProvider>['stream']>> | undefined;
            let errorText: string | undefined;
            try {
              result = await runWithProviderRequestObserver(fact => { observations.push(fact); }, () => observeProviderOperation(route.provider, 'utility', undefined, () => getProvider(route.provider).stream([...input.messages], [...input.tools], input.system, reasoning, { modelOverride: route.model, maxOutputTokensOverride: FIRST_TURN_LIMITS.maxOutputTokens, singleAttempt: true, signal: controller.signal }), undefined, controller.signal));
            } catch (error: unknown) { errorText = redactedError(error); }
            finally { clearTimeout(timer); }
            const usage = result?.usage;
            const cost = usage ? calculateCost(rate, usage.inputTokens, usage.outputTokens, usage.cachedReadTokens ?? 0, usage.cachedWriteTokens ?? 0) : undefined;
            budget.settle(reservedTokens, reservedUsd, usage, cost);
            await saveBudget();
            const toolCalls = result?.toolBlocks.map(t => ({ name: t.name, input: t.input })) ?? [];
            const row = { route: id, provider: route.provider, model: route.model, billing: route.billing, reasoning, case: baseCase.id, task: baseCase.task, rubric: baseCase.rubric, arm, inputHash: inputHash(input), text: result?.textBlocks.map(t => t.text).join('') ?? '', thinking: result?.thinkingBlocks ?? [], toolCalls, stopReason: result?.stopReason, usage: usage ?? null, priceRate: rate, estimatedUsd: cost ?? null, unknownUsageReservationUsd: cost === undefined ? reservedUsd : null, durationMs: Date.now() - start, error: errorText ?? null, physicalRequestObservations: observations, mechanical: observeFirstTurn(baseCase.id, toolCalls) };
            await persistEvidence(id, baseCase.id, arm, row);
            if (new Set(observations.filter(f => f.boundary === 'physical_attempt' && f.state === 'started').map(f => f.requestId)).size > 1) throw new Error('Unexpected hidden retry; stop experiment');
            if (!usage || !Number.isFinite(cost) || errorText) throw new Error('Provider error/missing usage retained and conservatively charged; stop lane for review, no retry');
            if (budget.state.chargedTokens > FIRST_TURN_LIMITS.maxTotalTokens || budget.state.chargedUsd > FIRST_TURN_LIMITS.maxExternalSpendUsd) throw new Error('Actual budget reached; stop experiment');
          }
        }
      }
      } catch (error: unknown) { stopping = true; throw error; }
    }));
    const errors = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
    if (errors.length) throw new Error(errors.map(error => redactedError(error.reason)).join('\n'));
    process.stdout.write(JSON.stringify({ directory, budget: budget.state, status: 'generated-awaiting-main-session-blind-review' }, null, 2) + '\n');
  } finally { await lock.close(); await fs.unlink(lockPath); }
}
