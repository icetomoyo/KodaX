/** L3.5 candidate-combination usability only; not a prompt A/B experiment. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { getProvider, getCostRate, calculateCost, type KodaXStreamResult } from '../packages/llm/src/index.js';
import { observeProviderOperation, runWithAdditionalProviderRequestObserver, type ProviderRequestObservation } from '../packages/llm/src/provider-request-observation.js';
import { FirstTurnBudget, firstTurnReasoningFor, inputHash, type FrozenInput } from './first-turn-eval-support.js';
import { settleComplexAttempt } from './first-turn-complex-budget.js';
import { NEXT_STAGE_ROUTES, type NextStageRoute } from './token-efficiency-next-stage-fixtures.js';
import { PRODUCT_CASES } from '../benchmark/datasets/product-multiturn/fixture.js';
import { CHILD_AGENT_SYSTEM_PROMPT } from '../packages/coding/src/prompts/child-system-contract.js';
import { withEffectivePermissionContext } from '../packages/coding/src/prompts/effective-permissions.js';
import { buildCompactChildContractCandidate } from '../packages/coding/src/prompts/compact-child-contract.js';

vi.mock('../packages/coding/src/tools/edit.js', async importOriginal => {
  const original = await importOriginal<typeof import('../packages/coding/src/tools/edit.js')>();
  return { ...original, toolEdit: original.toolEditWithCompactReceipt };
});

const revision = 'token-efficiency-next-stage-smoke-r1-20261031';
const routeValue = process.env.KODAX_NEXT_STAGE_SMOKE_ROUTE;
const limits = { calls: 24, tools: 80, tokens: 500_000, usd: 1, timeoutMs: 600_000, callTimeoutMs: 120_000, output: 4096 };
// This isolated fixture creates no custom specialists or SDK system overrides.
// Only its exact built-in readonly child + generated host authority is eligible.
function projectFixtureChild(input: FrozenInput, kind: string): { input: FrozenInput; applied: boolean } {
  if (kind !== 'child') return { input, applied: false };
  for (const mode of [undefined, 'plan', 'accept-edits', 'auto', 'full-access'] as const) {
    const exact = withEffectivePermissionContext(CHILD_AGENT_SYSTEM_PROMPT, {
      resolveShellPermissionMode: mode ? () => mode : undefined, permissionIntent: { readOnly: true },
    });
    if (input.system !== exact) continue;
    const canonical = { system: CHILD_AGENT_SYSTEM_PROMPT, tools: input.tools };
    const pair = buildCompactChildContractCandidate(canonical, { source: 'builtin-child' });
    if (pair === canonical) return { input, applied: false };
    return { input: { ...input, ...pair, system: pair.system + exact.slice(CHILD_AGENT_SYSTEM_PROMPT.length) }, applied: true };
  }
  return { input, applied: false };
}

it('preserves exact live permission suffix and does not project unknown or root systems', async () => {
  const { getActiveToolDefinitions } = await import('../packages/coding/src/agent-runtime/tool-resolution.js');
  const tools = getActiveToolDefinitions(['read', 'bash', 'glob', 'grep'], 'off')
    .map(({ name, description, input_schema }) => ({ name, description, input_schema }));
  const system = withEffectivePermissionContext(CHILD_AGENT_SYSTEM_PROMPT, {
    resolveShellPermissionMode: () => 'full-access', permissionIntent: { readOnly: true },
  });
  const input = { system, tools, messages: [] };
  const projected = projectFixtureChild(input, 'child');
  expect(projected.applied).toBe(true);
  expect(projected.input.system).toContain(system.slice(CHILD_AGENT_SYSTEM_PROMPT.length));
  expect(projectFixtureChild(input, 'root').input).toBe(input);
  expect(projectFixtureChild({ ...input, system: system + '\nCustom instructions' }, 'child').applied).toBe(false);
});

it.skipIf(!routeValue)('runs one bounded two-Run candidate smoke for one provider family', async () => {
  if (!routeValue || !Object.hasOwn(NEXT_STAGE_ROUTES, routeValue)) throw new Error('Expected an explicit supported smoke route');
  const route = routeValue as NextStageRoute;
  const config = NEXT_STAGE_ROUTES[route];
  if (!process.env[config.key]) throw new Error(`Missing ${route} credential`);
  const root = path.join(os.tmpdir(), 'kodax-eval-dumps', revision, route);
  await fs.mkdir(root, { recursive: true });
  const redact = (value: string) => Object.values(NEXT_STAGE_ROUTES).reduce((text, item) => {
    const key = process.env[item.key]; return key ? text.replaceAll(key, '[REDACTED]') : text;
  }, value);
  const save = (file: string, value: unknown) => fs.writeFile(path.join(root, file), redact(JSON.stringify(value, null, 2)), { flag: 'wx' });
  const sources = ['tests/token-efficiency-next-stage-smoke.eval.ts', 'tests/shared-contract-natural-runtime.ts',
    'packages/coding/src/prompts/compact-child-contract.ts', 'packages/coding/src/prompts/child-system-contract.ts',
    'packages/coding/src/tools/edit.ts', 'packages/coding/src/prompts/effective-permissions.ts'];
  const sourceHashes = async () => Object.fromEntries(await Promise.all(sources.map(async file => [file, inputHash(await fs.readFile(file, 'utf8'))])));
  const frozenSources = await sourceHashes();
  const rate = getCostRate(route, config.model);
  if (!rate) throw new Error('Missing frozen reference rate');
  await save('preregistration.json', { revision, route, model: config.model, limits, rate, sources: frozenSources,
    task: PRODUCT_CASES['config-precedence'].prompt, followUp: PRODUCT_CASES['config-precedence'].followUp,
    scope: 'L3.5 usability only: candidate edit receipt plus eligible builtin readonly child contract. Natural prompts unchanged. No mandatory child or refusal; missing exercised paths are reported as coverage gaps.',
    aggregateCaps: { families: 3, calls: 72, tokens: 1_500_000, referenceUsd: 3 },
    baseline: 'R16 config-precedence retained evidence may be shown separately, not causal. No new original-version run.',
    stop: 'One run per family; no retry or fallback. Unknown usage, physical-attempt mismatch, budget/timeout/source drift stops further calls. Reference subscription rates are not billed cash.',
  });
  const budget = new FirstTurnBudget(undefined, limits.calls);
  const abort = new AbortController();
  const observations: Record<string, unknown>[] = [];
  let projectedChildren = 0;
  const { runNaturalRuntime } = await import('./shared-contract-natural-runtime.js');
  const started = Date.now();
  const record = await runNaturalRuntime(root, 'config-precedence', async (canonical, signal, index, meta) => {
    if (inputHash(frozenSources) !== inputHash(await sourceHashes())) { abort.abort(); throw new Error('Frozen source drift'); }
    const projection = projectFixtureChild(canonical, meta.kind);
    const input = projection.input;
    if (projection.applied) projectedChildren++;
    const inputUpper = Buffer.byteLength(JSON.stringify(input), 'utf8') + 4096;
    const outputCap = Math.min(meta.streamOptions?.maxOutputTokensOverride ?? limits.output, limits.output);
    const reservedTokens = inputUpper + outputCap;
    const reservedUsd = calculateCost(rate, inputUpper, outputCap);
    if (budget.state.chargedTokens + reservedTokens > limits.tokens || budget.state.chargedUsd + reservedUsd > limits.usd) {
      abort.abort(); throw new Error('Smoke budget exhausted before dispatch');
    }
    budget.reserve(reservedTokens, reservedUsd);
    await save(`call-${index}.input.json`, { canonical, sent: input, inputHash: inputHash(input), projectedChild: projection.applied, kind: meta.kind, reservedTokens, reservedUsd });
    const facts: ProviderRequestObservation[] = [];
    const combined = AbortSignal.any([signal, abort.signal, AbortSignal.timeout(limits.callTimeoutMs)]);
    const reasoning = meta.kind === 'auxiliary' ? meta.reasoning : firstTurnReasoningFor(route);
    let result: KodaXStreamResult | undefined;
    let error: string | null = null;
    const callStarted = Date.now();
    try {
      result = await runWithAdditionalProviderRequestObserver(fact => facts.push(fact), () => observeProviderOperation(route,
        meta.kind === 'auxiliary' ? 'sidecar' : 'primary', undefined, () => getProvider(route).stream(
          [...input.messages], [...input.tools], input.system, reasoning,
          { ...meta.streamOptions, modelOverride: config.model, maxOutputTokensOverride: outputCap, singleAttempt: true }, combined), undefined, combined));
    } catch (cause) { error = redact(cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)); }
    const usage = result?.usage;
    const actualUsd = usage ? calculateCost(rate, usage.inputTokens, usage.outputTokens, usage.cachedReadTokens ?? 0, usage.cachedWriteTokens ?? 0) : undefined;
    const settlement = settleComplexAttempt({ reservedTokens, reservedUsd, facts, tools: input.tools.map(tool => tool.name), reasoning,
      outputCap, requestCancelled: combined.aborted, taskCancelled: signal.aborted || abort.signal.aborted, failed: error !== null, actualUsd });
    budget.settle(reservedTokens, reservedUsd, settlement.unknownUsage ? undefined : usage, actualUsd);
    const overrun = (usage?.totalTokens ?? 0) > reservedTokens || (usage?.outputTokens ?? 0) > outputCap || (actualUsd ?? 0) > reservedUsd;
    const row = { index, kind: meta.kind, projectedChild: projection.applied, inputHash: inputHash(input), result, error, facts,
      settlement, overrun, actualUsd, wallMs: Date.now() - callStarted, budget: { ...budget.state } };
    observations.push(row); await save(`call-${index}.result.json`, row);
    if (settlement.stop || overrun) abort.abort(new Error('Smoke stopped; no retry'));
    if (!result || error || settlement.stop || overrun) throw new Error(error ?? 'Incomplete provider attempt');
    return result;
  }, { workMode: 'coding', limits, model: config.model, maxOutputTokens: limits.output,
    reasoning: route === 'kimi-code' ? 'quick' : 'off', effort: route === 'kimi-code' ? 'low' : 'none', signal: abort.signal,
    followUps: [{ prompt: PRODUCT_CASES['config-precedence'].followUp, permissionMode: 'full-access' }] });
  const summary = { revision, route, quality: { phase: record.phase, success: record.success, error: record.error,
    publicStatus: record.verification.public.status, oracleStatus: record.verification.oracle.status,
    protectedUnchanged: record.protectedUnchanged, attemptedRuns: record.runs.length,
    completedRuns: record.runs.filter(run => run.phase === 'completed').length }, counts: record.counts,
    budget: budget.state, wallMs: Date.now() - started, projectedChildren,
    childCoverage: projectedChildren ? 'projected real child requests' : 'not exercised; no child quality claim',
    scope: 'Combination smoke only. Inspect final reports and actual test/tool receipts before judging quality or efficiency.' };
  await save('observations.json', observations); await save('summary.json', summary);
  process.stdout.write(JSON.stringify({ root, ...summary }) + '\n');
}, 650_000);
