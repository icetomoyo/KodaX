/** Manual v2: default preflight sends no requests. Commands: prepare, layer2, smoke.
 * KODAX_EDIT_EVAL_RUN=1 is additionally required for live commands.
 * The owner reviews the immutable manifest before dispatch; v1 is read-only.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomInt } from 'node:crypto';
import { getProvider, getProviderModels, getCostRate, calculateCost, resolveModelCapabilities } from '../packages/llm/src/index.js';
import { observeProviderOperation, runWithProviderRequestObserver, type ProviderRequestObservation } from '../packages/llm/src/provider-request-observation.js';
import type { KodaXStreamResult } from '../packages/llm/src/types.js';
import { inputHash, comparisonInputs, firstTurnReasoningFor, type FrozenCapture, type FrozenInput } from './first-turn-eval-support.js';
import { EDIT_CASES, EDIT_REVISION, editDumpRoot, assertEditSourcesCurrent } from './first-turn-edit-inputs.capture.js';
import { EDIT_LIMITS, EditRevisionBudget, assertEditLedger, createEditLedger, type EditRoute, type CallEvidence } from './first-turn-edit-eval-support.js';
import { runEditRuntimeSmoke, runEditSmokeLanes } from './first-turn-edit-runtime-smoke.js';
import { writeEditEvidence } from './first-turn-edit-artifacts.js';

export const EDIT_ROUTES = {
  kimi: { provider: 'kimi-code', model: 'kimi-for-coding', env: 'KIMI_CODE_API_KEY' },
  'zai/glm53flash': { provider: 'zai-coding', model: 'glm-5.3-flash', env: 'ZAI_CODING_API_KEY' },
  'zai/glm53': { provider: 'zai-coding', model: 'glm-5.3', env: 'ZAI_CODING_API_KEY' },
  'zhipu/glm53flash': { provider: 'zhipu-coding', model: 'glm-5.3-flash', env: 'ZHIPU_CODING_API_KEY' },
} as const;
interface Manifest { revision: string; limits: typeof EDIT_LIMITS; routes: readonly EditRoute[]; baselineHash: string; candidateHash: string; priorLedgerHash: string; design: Record<string, unknown> }
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
export function redactEditError(error: unknown): string {
  let text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  for (const route of Object.values(EDIT_ROUTES)) { const key = process.env[route.env]; if (key) text = text.replaceAll(key, '[REDACTED]'); }
  return text;
}

export async function budgetedEditCall(route: EditRoute, input: FrozenInput, budget: EditRevisionBudget, saveBudget: () => Promise<void>, signal?: AbortSignal, onFailure?: (reason: string) => void, beforeDispatch?: () => void): Promise<CallEvidence> {
  signal?.throwIfAborted();
  const inputAllowance = Buffer.byteLength(JSON.stringify(input)) + 4096;
  const tokens = inputAllowance + EDIT_LIMITS.maxOutputTokens;
  const dollars = calculateCost(route.rate, inputAllowance, EDIT_LIMITS.maxOutputTokens);
  budget.reserve(tokens, dollars); await saveBudget();
  const facts: ProviderRequestObservation[] = [];
  const started = Date.now();
  let result: KodaXStreamResult | undefined;
  let error: string | null = null;
  try {
    const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(EDIT_LIMITS.timeoutMs)]) : AbortSignal.timeout(EDIT_LIMITS.timeoutMs);
    result = await runWithProviderRequestObserver(fact => facts.push(fact), () => observeProviderOperation(route.provider, 'utility', undefined,
      () => {
        requestSignal.throwIfAborted(); beforeDispatch?.();
        return getProvider(route.provider).stream([...input.messages], [...input.tools], input.system, route.reasoning,
          { modelOverride: route.model, maxOutputTokensOverride: EDIT_LIMITS.maxOutputTokens, singleAttempt: true, signal: requestSignal });
      }, undefined, requestSignal));
  } catch (cause: unknown) { error = redactEditError(cause); onFailure?.(error); }
  const usage = result?.usage;
  const cost = usage ? calculateCost(route.rate, usage.inputTokens, usage.outputTokens, usage.cachedReadTokens ?? 0, usage.cachedWriteTokens ?? 0) : undefined;
  budget.settle(tokens, dollars, usage, cost);
  const physicalAttempts = new Set(facts.filter(fact => fact.boundary === 'physical_attempt' && fact.state === 'started').map(fact => fact.requestId)).size;
  if (physicalAttempts !== 1) error ??= 'Expected exactly one physical request; no retry or zero-request sample is valid';
  if (!usage || cost === undefined || !Number.isFinite(cost)) error ??= 'Unknown usage/cost retained and conservatively charged; review before any next call';
  if (budget.state.chargedTokens >= EDIT_LIMITS.maxTotalTokens || budget.state.chargedUsd >= EDIT_LIMITS.maxExternalSpendUsd) error ??= 'Actual revision budget reached';
  if (error) onFailure?.(error);
  await saveBudget();
  return { inputHash: inputHash(input), result, text: result?.textBlocks.map(block => block.text).join('') ?? '',
    toolCalls: result?.toolBlocks.map(block => ({ name: block.name, input: block.input })) ?? [], usage: usage ?? null,
    estimatedUsd: cost ?? null, error, physicalRequestObservations: facts, physicalAttempts, durationMs: Date.now() - started };
}

async function loadCapture(stage: 'baseline' | 'candidate'): Promise<FrozenCapture> {
  const capture = JSON.parse(await fs.readFile(path.join(editDumpRoot(), `${stage}-inputs.json`), 'utf8')) as FrozenCapture & { revision: string };
  if (capture.revision !== EDIT_REVISION || capture.stage !== stage || capture.cases.length !== EDIT_CASES.length) throw new Error('Capture revision/stage/case mismatch');
  for (const testCase of EDIT_CASES) {
    const row = capture.cases.find(candidate => candidate.id === testCase.id);
    if (!row || row.task !== testCase.task || row.rubric !== testCase.rubric || row.hash !== inputHash(row.input)) throw new Error('Changed frozen task/rubric/input');
  }
  return capture;
}

async function prepare(): Promise<void> {
  const baseline = await loadCapture('baseline');
  const candidate = await loadCapture('candidate');
  await assertEditSourcesCurrent(candidate);
  const glm = process.env.KODAX_EDIT_GLM_ROUTE ?? 'zai/glm53flash';
  if (glm === 'kimi' || !Object.hasOwn(EDIT_ROUTES, glm)) throw new Error('Select one supported GLM route');
  const routes: EditRoute[] = ['kimi', glm].map(id => {
    const route = EDIT_ROUTES[id as keyof typeof EDIT_ROUTES];
    const reasoning = firstTurnReasoningFor(route.provider);
    const rate = getCostRate(route.provider, route.model);
    if (!rate || !getProviderModels(route.provider).includes(route.model) || !process.env[route.env]
      || resolveModelCapabilities(route.provider, route.model)?.reasoningProfile?.localRejectEfforts?.includes(reasoning.effort)) throw new Error(`Route unavailable: ${id}; no fallback`);
    return { id, ...route, rate, reasoning, billing: 'coding-plan-reference-only' };
  });
  const priorPath = process.env.KODAX_EDIT_V1_LEDGER;
  if (!priorPath || !path.isAbsolute(priorPath)) throw new Error('Explicit historical v1 ledger absolute path is required');
  const ledger = createEditLedger(priorPath, await fs.readFile(priorPath, 'utf8'));
  const manifest: Manifest = { revision: EDIT_REVISION, limits: EDIT_LIMITS, routes,
    baselineHash: inputHash(baseline), candidateHash: inputHash(candidate), priorLedgerHash: ledger.prior.sha256,
    design: {
      layer1: 'Production schema/projection/SDK compatibility and Runtime authority are zero-network tests. They cannot answer model batching correctness or concrete plan quality.',
      layer2: '2 representative coding providers × 2 affected cases × 2 blind arms × 1 response = 8 calls; complete frozen production tools channel, no tool execution, no external judge.',
      changedInputs: 'New task inputs and changed edit/diff/Worker substrate require new revision; v1 raw/charges remain history, no wholesale rerun.',
      smoke: 'At most 2 candidate-only real Runtime Sessions. Four dependent model responses are necessary: read current file → one atomic edit → run node --test sum.test.js → honest final response after test evidence. This preregistered >3-round exception is smoke, never prompt comparison. Exactly one tool per first three responses, no children/retries.',
      concurrency: 'One in-flight request per provider; distinct providers run in parallel. No fallback and singleAttempt=true.',
      rubric: 'Main-session blind paired review: task validity; preferred arm/tie; material user value; concrete plan and edit correctness; honest execution status; regressions caused by eval-design/provider-noise/prompt-regression/inconclusive. Tokens/latency/call shapes are diagnostic, never an automatic ship vote.',
      stop: 'Stop for design invalidity, provider error/timeout/missing usage/hidden retry, evidence persistence failure, or any budget. Review pilot before optional smoke; unused allowance is not a target.',
      cost: 'Both routes are user-requested coding plans. Rates are nominal/reference accounting, not an incremental subscription bill. 16 planned calls, 18 absolute maximum; 600000 tokens and reference USD1 hard ceilings.',
    } };
  await writeEditEvidence(path.join(editDumpRoot(), 'manifest.json'), JSON.stringify(manifest, null, 2), true);
  await writeEditEvidence(path.join(editDumpRoot(), 'paid-budget-ledger.json'), JSON.stringify(ledger, null, 2), true);
  process.stdout.write(JSON.stringify({ prepared: true, directory: editDumpRoot(), manifestHash: inputHash(manifest), manifest, paidCalls: 0 }) + '\n');
}

async function runLive(command: 'layer2' | 'smoke'): Promise<void> {
  if (process.env.KODAX_EDIT_EVAL_RUN !== '1') throw new Error('Live execution flag required after owner reviews manifest');
  const root = editDumpRoot();
  const lockPath = path.join(root, 'paid-budget.lock');
  const lock = await fs.open(lockPath, 'wx');
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8')) as Manifest;
    if (process.env.KODAX_EDIT_MANIFEST_HASH !== inputHash(manifest)) throw new Error('Owner-reviewed manifest hash is required before live dispatch');
    const ledger: unknown = JSON.parse(await fs.readFile(path.join(root, 'paid-budget-ledger.json'), 'utf8'));
    assertEditLedger(ledger);
    const baseline = await loadCapture('baseline'); const candidate = await loadCapture('candidate');
    if (manifest.revision !== EDIT_REVISION || inputHash(manifest.limits) !== inputHash(EDIT_LIMITS)
      || manifest.baselineHash !== inputHash(baseline) || manifest.candidateHash !== inputHash(candidate)
      || manifest.priorLedgerHash !== ledger.prior.sha256 || sha256(await fs.readFile(ledger.prior.path, 'utf8')) !== ledger.prior.sha256
      || inputHash(JSON.parse(await fs.readFile(ledger.prior.path, 'utf8')) as unknown) !== inputHash(ledger.prior.snapshot)) throw new Error('Frozen manifest/capture/history changed');
    await assertEditSourcesCurrent(candidate);
    if (manifest.routes.length !== 2 || new Set(manifest.routes.map(route => route.provider)).size !== 2) throw new Error('Frozen provider lanes changed');
    for (const route of manifest.routes) {
      const known = EDIT_ROUTES[route.id as keyof typeof EDIT_ROUTES];
      if (!known || route.provider !== known.provider || route.model !== known.model || route.env !== known.env || !process.env[route.env]) throw new Error('Frozen route unavailable; no fallback');
    }
    const budget = new EditRevisionBudget(ledger.budget);
    let persistence = Promise.resolve();
    const save = (name: string, content: unknown): Promise<void> => {
      const text = JSON.stringify(content, null, 2);
      persistence = persistence.then(() => writeEditEvidence(path.join(root, name), text));
      return persistence;
    };
    const saveBudget = () => save('paid-budget-ledger.json', ledger);
    const directory = path.join(root, command);
    if (command === 'smoke') {
      const reviewed = JSON.parse(await fs.readFile(path.join(root, 'layer2-main-session-review.json'), 'utf8')) as { evidenceHash: string; reviewer: string; taskValid: boolean; allowSmoke: boolean; reason: string };
      const evidence = JSON.parse(await fs.readFile(path.join(root, 'layer2', 'blind-evidence.json'), 'utf8')) as unknown;
      if (reviewed.reviewer !== 'main-session' || reviewed.taskValid !== true || reviewed.allowSmoke !== true || !reviewed.reason || reviewed.evidenceHash !== inputHash(evidence)) throw new Error('Valid main-session pilot review required before smoke');
      await fs.mkdir(directory); // Never overwrite/retry a completed or interrupted batch.
      await runEditSmokeLanes(manifest.routes, (route, input, signal, onFailure, beforeDispatch) => budgetedEditCall(route, input, budget, saveBudget, signal, onFailure, beforeDispatch),
        (route, call, control) => runEditRuntimeSmoke(route, call, path.join(directory, `${route.id.replaceAll('/', '-')}.json`), 'live', control));
    } else {
      await fs.mkdir(directory);
      const rows: unknown[] = []; const blind: unknown[] = []; const mapping: unknown[] = [];
      let stopping = false;
      const outcomes = await Promise.allSettled(manifest.routes.map(async route => {
        try {
          for (const base of baseline.cases) {
            const next = candidate.cases.find(row => row.id === base.id)!;
            const inputs = comparisonInputs(base, next, 'combined'); const reverse = randomInt(2) === 1;
            const ordered = reverse ? [inputs[1]!, inputs[0]!] : inputs;
            mapping.push({ route: route.id, case: base.id, A: reverse ? 'candidate' : 'baseline', B: reverse ? 'baseline' : 'candidate', inputHashes: ordered.map(inputHash) });
            await save('layer2/unblind-mapping.json', mapping);
            for (const [index, input] of ordered.entries()) {
              if (stopping) return;
              const arm = index === 0 ? 'A' : 'B';
              const evidence = await budgetedEditCall(route, input, budget, saveBudget, undefined, () => { stopping = true; },
                () => { if (stopping) throw new Error('Layer2 lanes stopped before dispatch'); });
              const { result: _result, inputHash: _inputHash, ...blindResponse } = evidence;
              const labels = { route: route.id, case: base.id, task: base.task, rubric: base.rubric, arm };
              const row = { ...labels, ...evidence }; rows.push(row); blind.push({ ...labels, ...blindResponse,
                thinking: evidence.result?.thinkingBlocks ?? [], stopReason: evidence.result?.stopReason ?? null });
              await writeEditEvidence(path.join(directory, `${route.id.replaceAll('/', '-')}-${base.id}-${arm}.json`), JSON.stringify(row, null, 2), true);
              await save('layer2/raw-evidence.json', { runsRaw: rows });
              await save('layer2/blind-evidence.json', { rubric: manifest.design.rubric, runsRaw: blind, mainSessionReview: [] });
              if (evidence.error) throw new Error(evidence.error);
            }
          }
        } catch (cause: unknown) { stopping = true; throw cause; }
      }));
      for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
    }
    process.stdout.write(JSON.stringify({ directory, budget: budget.state, status: 'evidence-saved-awaiting-main-session-review' }) + '\n');
  } finally { await lock.close(); await fs.unlink(lockPath); }
}

const command = process.env.KODAX_EDIT_EVAL_COMMAND;
if (command === 'prepare') await prepare();
else if (command === 'layer2' || command === 'smoke') await runLive(command);
else if (command !== undefined && command !== 'preflight') throw new Error('Unknown edit evaluation command');
else if (command === 'preflight') process.stdout.write(JSON.stringify({ revision: EDIT_REVISION, directory: editDumpRoot(), limits: EDIT_LIMITS, noProviderCalls: true, routes: Object.entries(EDIT_ROUTES).map(([id, route]) => ({ id, provider: route.provider, model: route.model, credentialPresent: Boolean(process.env[route.env]), descriptorPresent: getProviderModels(route.provider).includes(route.model) })) }) + '\n');
