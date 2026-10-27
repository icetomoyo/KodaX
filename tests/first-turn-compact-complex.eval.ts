/** Manual Layer 3.5 observational smoke. Never a causal prompt-quality benchmark.
 * prepare freezes sources; mode qualification selects one explicitly registered cell.
 * No retries, fallback, output rewriting or production prompt/default changes.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { getProvider, getProviderModels, getCostRate, calculateCost, type KodaXStreamResult } from '../packages/llm/src/index.js';
import { currentProviderRequestAttribution, observeProviderOperation, runWithAdditionalProviderRequestObserver, type ProviderRequestObservation } from '../packages/llm/src/provider-request-observation.js';
import { runComplexRuntime } from './first-turn-complex-runtime.js';
import { createCompactReadRecoveryFault } from './first-turn-compact-recovery.js';
import { compactManagedWorkerInput } from './first-turn-compact-candidate.js';
import { inputHash, type FrozenInput } from './first-turn-eval-support.js';
import { settleComplexAttempt } from './first-turn-complex-budget.js';
import type { CallEvidence } from './first-turn-edit-eval-support.js';
import { CACHE_TASK } from '../benchmark/datasets/search-entry-complex/fixture.js';
import { compactContractInput } from './first-turn-compact-contract.js';
import { restructuredContractInput } from './restructured-contract.js';
import { runWithProviderRequestAttribution as publicAttribution } from '@kodax-ai/llm';
import { runWithProviderRequestAttribution as sourceAttribution } from '../packages/llm/src/provider-request-observation.js';

// Mixing dist and src creates independent AsyncLocalStorage/registries. Fail before
// fixture creation or any request; manual source evals must use the test path map.
if (publicAttribution !== sourceAttribution) throw new Error('Mixed source/build modules: set TSX_TSCONFIG_PATH=tsconfig.test.json before launching this source eval');

// Separate frozen revision; the legacy compact-teaching evidence is never overwritten.
const workModes = process.argv.includes('--work-modes');
const contract = process.argv.includes('--contract');
const restructured = process.argv.includes('--restructured');
if ([workModes, contract, restructured].filter(Boolean).length > 1) throw new Error('Select one frozen experiment');
const ROOT = path.join(os.tmpdir(), 'kodax-eval-dumps', restructured ? 'restructured-full-complex-20261027-r1' : contract ? 'compact-contract-full-complex-20261025-r2' : workModes ? 'work-modes-full-complex-20261025-r3' : 'compact-full-complex-20261025-r1');
const routes = [
  { id: 'glm', provider: 'zhipu-coding', model: 'glm-5.3', env: 'ZHIPU_CODING_API_KEY', order: restructured || contract ? ['candidate'] : workModes ? [] : ['baseline', 'candidate'] },
  { id: 'kimi', provider: 'kimi-code', model: 'kimi-for-coding', env: 'KIMI_CODE_API_KEY', order: restructured ? ['candidate'] : contract ? ['baseline', 'candidate'] : workModes ? ['agent', 'script'] : ['candidate', 'baseline'] },
] as const;
const limits = { calls: 32, tools: 80, timeoutMs: 900000, tokens: contract || restructured ? 1500000 : 1200000, usd: contract || restructured ? 0.30 : 0.15, output: contract || restructured ? 8192 : 4096, requestMs: 180000 };
const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const save = async (file: string, value: unknown, exclusive = false) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2), exclusive ? { flag: 'wx' } : undefined);
};
interface Manifest { sourceHashes: Record<string, string>; limits: typeof limits }
const command = process.argv.at(-1);
if (command === 'prepare') {
  for (const route of routes) if (route.order.length && (!process.env[route.env] || !getCostRate(route.provider, route.model) || !getProviderModels(route.provider).includes(route.model))) throw new Error(`Unavailable route ${route.id}`);
  const sourceHashes: Record<string, string> = {};
  for (const directory of ['src', 'packages', 'tests', 'benchmark/datasets/search-entry-complex']) {
    for (const relative of await fs.readdir(directory, { recursive: true })) {
      if (!/\.(?:ts|tsx|js|mjs|json|md|txt|sql|wasm)$/.test(relative) || /(?:^|[/\\])(?:node_modules|dist)(?:[/\\]|$)/.test(relative)) continue;
      const file = path.join(directory, relative); sourceHashes[file] = hash(await fs.readFile(file));
    }
  }
  for (const file of ['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.test.json', 'vitest.config.ts']) sourceHashes[file] = hash(await fs.readFile(file));
  await fs.mkdir(ROOT);
  for (const file of Object.keys(sourceHashes)) {
    const target = path.join(ROOT, 'frozen-source', file);
    await fs.mkdir(path.dirname(target), { recursive: true }); await fs.copyFile(file, target);
  }
  await save(path.join(ROOT, 'manifest.json'), { sourceHashes, routes, limits, workModes, contract, restructured,
    design: restructured ? 'Layer 3.5 observational smoke after reviewed L2 restructured-contract qualification; not a causal comparison. At most two candidate-only Agent Runs: GLM once and Kimi once, separate provider lanes may run concurrently. Root-only restructuredContractInput on authenticated eligible actor; child, auxiliary, SDK, AMA and all tools/guardrails unchanged. Real readonly child refusal and autonomous legal recovery retained. Per Run: 32 calls, 80 tools, 15min, 1.5M tokens, USD0.30 reference, output8192 and maxIter24; total at most 64 calls/3M tokens/USD0.60. No retries, reruns, fallback or output/parameter rewriting. No production default change or non-inferiority claim from n=1.' : contract ? 'Layer 3.5: only after controlled compact-contract qualification. Three Agent Runs total: Kimi baseline then candidate; GLM candidate. Preserve AMA, native tools, one readonly child and persistent real read refusal. Root-only compactContractInput; child/aux unchanged. Each Run 32 provider requests, 80 tool attempts, 1.5M token, USD0.30 reference, 15min; output8192 and maxIter24. No retries, no fourth Run, no causal prompt ranking. DeepSeek covered by controlled probes only.' : workModes
      ? 'Layer 3.5 r3 final qualification: one fixture, Kimi Agent and Script once each sequentially; at most two runs, 64 calls/2.4M tokens/USD0.30 nominal maximum. GLM completed evidence retained, no GLM rerun. Minimal production change suppresses legacy standalone reflection only in borrowed parent Runner Script cells; tracking, budgets, recovery and standalone SDK behavior retained. No compact transform. AMA retained, one inherited-model readonly child. Child first read target stays refused by that tool; other legal tools remain available. All shell refusals return original errors, with unchanged allowlists, parsing and path checks. No forbidden execution, retries, fallback, output rewriting or budget extensions. Nonblocking observations recorded without starting another experiment. Stop further runs only on isolation, unbounded execution or invalid-evaluation defects. Historical Coding/r1/r2 runs are descriptive context, not a causal baseline. Same provider has one in-flight request.'
      : 'One complex fixture, one observation per route/arm, four runs total; 128 calls/4.8M tokens/USD0.60 nominal maximum. Full task data are descriptive, not causal prompt comparison. Earlier controlled probes provide decision-point evidence. Root ordinary Worker teaching only; all tool schemas and child/specialist/partial SDK prompts unchanged. First child read target is persistently denied through a real guardrail; model must recover without intervention. No forbidden command executed. No retries or reruns to force success.',
    rubric: 'Inspect quality before token/time: three source fixes, new regression tests, actual node tests, independent six-test oracle, original protected files, real readonly child refusal delivered unchanged and subsequent allowed evidence, truthful child/report limitations, root integration, AMA terminal state and no live abandoned children. Record missing coverage, censoring, provider errors separately. Runtime completion alone is not quality. No default enablement based on n=1.',
    layer1: 'Offline verifies rule preservation, identities, tool/schema equality, rejection execution and recovery, budget settlement and AMA closure; cannot establish autonomous real-model choices or task efficiency.',
  }, true);
  process.stdout.write(JSON.stringify({ prepared: ROOT, files: Object.keys(sourceHashes).length, limits }) + '\n');
} else {
  const [routeId, selectedMode] = (command ?? '').split('-');
  const route = routes.find(value => value.id === routeId);
  if (!route || (workModes && !route.order.includes(selectedMode ?? ''))) throw new Error('Expected prepare/glm/kimi, or --work-modes kimi-agent/kimi-script');
  const manifest = JSON.parse(await fs.readFile(path.join(ROOT, 'manifest.json'), 'utf8')) as Manifest;
  if (inputHash(manifest.limits) !== inputHash(limits)) throw new Error('Changed limits');
  for (const [file, digest] of Object.entries(manifest.sourceHashes)) if (hash(await fs.readFile(file)) !== digest) throw new Error(`Changed frozen source ${file}`);
  const rate = getCostRate(route.provider, route.model);
  if (!rate || !process.env[route.env]) throw new Error('Missing route');
  await save(path.join(ROOT, (workModes ? command : route.id) + '-started.json'), { at: new Date().toISOString() }, true);
  process.env.NODE_ENV = 'production';
  for (const arm of route.order) {
    if (workModes && arm !== selectedMode) continue;
    const directory = path.join(ROOT, route.id, arm); await fs.mkdir(directory, { recursive: true });
    const fault = createCompactReadRecoveryFault(path.join(directory, 'workspace'));
    const budget = { calls: 0, chargedTokens: 0, chargedUsd: 0, unknownUsageCalls: 0, stopped: false };
    const invoke: Parameters<typeof runComplexRuntime>[2] = async (original, signal, index, meta) => {
      if (budget.stopped || signal.aborted) throw new Error('Stopped before dispatch');
      const attribution = currentProviderRequestAttribution();
      const auxiliary = original.tools.length === 1 && original.tools[0]?.name === 'report_stall_judgment';
      if (!auxiliary && attribution?.kind !== 'actor_turn') throw new Error('Missing authenticated evaluation actor attribution');
      const eligible = attribution?.kind === 'actor_turn' && attribution.actorPath === '/root';
      if (workModes && index === 0 && eligible && original.tools.some(tool => tool.name === 'script_exec') !== (arm === 'script')) throw new Error('Work-mode menu does not match the registered cell');
      const input: FrozenInput = arm === 'candidate' ? (restructured ? restructuredContractInput(original, eligible) : contract ? compactContractInput(original, eligible) : compactManagedWorkerInput(original, eligible)) : original;
      if (arm === 'candidate' && eligible && !auxiliary && input === original) throw new Error('Candidate did not replace ordinary root teaching');
      const outputCap = Math.min(limits.output, meta.streamOptions?.maxOutputTokensOverride ?? limits.output);
      const reservedInput = Buffer.byteLength(JSON.stringify(input)) + 4096;
      const reservedTokens = reservedInput + outputCap; const reservedUsd = calculateCost(rate, reservedInput, outputCap);
      if (budget.calls >= limits.calls || budget.chargedTokens + reservedTokens > limits.tokens || budget.chargedUsd + reservedUsd > limits.usd) { budget.stopped = true; throw new Error('Hard budget exhausted'); }
      budget.calls++;
      const file = path.join(directory, `call-${index}`);
      await save(file + '.input.json', { input, attribution, compacted: input !== original, originalSystemHash: hash(original.system) }, true);
      await save(path.join(directory, 'ledger.json'), { ...budget, reservedTokens, reservedUsd });
      const facts: ProviderRequestObservation[] = []; const start = Date.now();
      let result: KodaXStreamResult | undefined; let error: string | null = null;
      const abort = AbortSignal.any([signal, AbortSignal.timeout(limits.requestMs)]);
      try {
        result = await runWithAdditionalProviderRequestObserver(fact => facts.push(fact), () => observeProviderOperation(route.provider,
          input.tools.length === 1 && input.tools[0]?.name === 'report_stall_judgment' ? 'sidecar' : 'primary', attribution,
          () => getProvider(route.provider).stream([...input.messages], [...input.tools], input.system, meta.reasoning,
            { ...meta.streamOptions, modelOverride: route.model, maxOutputTokensOverride: outputCap, singleAttempt: true }, abort), undefined, abort));
      } catch (cause: unknown) {
        error = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
        const secret = process.env[route.env]; if (secret) error = error.replaceAll(secret, '[REDACTED]');
      }
      const usage = result?.usage; const cost = usage ? calculateCost(rate, usage.inputTokens, usage.outputTokens, usage.cachedReadTokens ?? 0, usage.cachedWriteTokens ?? 0) : undefined;
      const settlement = settleComplexAttempt({ reservedTokens, reservedUsd, facts, tools: input.tools.map(tool => tool.name), reasoning: meta.reasoning,
        outputCap, requestCancelled: signal.aborted, taskCancelled: meta.taskSignal?.aborted ?? false, failed: error !== null, actualUsd: cost });
      const physicalAttempts = new Set(facts.filter(fact => fact.boundary === 'physical_attempt' && fact.state === 'started').map(fact => fact.requestId)).size;
      if (settlement.stop) { budget.stopped = true; error ??= 'Physical attempt/usage verification failed'; }
      budget.chargedTokens += settlement.chargedTokens; budget.chargedUsd += settlement.chargedUsd;
      if (settlement.unknownUsage) budget.unknownUsageCalls++;
      const evidence: CallEvidence & { boundedAuxiliaryCancellation: boolean } = { inputHash: inputHash(input), result, text: result?.textBlocks.map(block => block.text).join('') ?? '',
        toolCalls: result?.toolBlocks ?? [], usage: usage ?? null, estimatedUsd: cost ?? null, error, physicalRequestObservations: facts, physicalAttempts,
        durationMs: Date.now() - start, boundedAuxiliaryCancellation: settlement.boundedAuxiliaryCancellation };
      await save(file + '.json', { ...evidence, settlement }); await save(path.join(directory, 'ledger.json'), budget);
      return evidence;
    };
    const record = await runComplexRuntime(route, directory, invoke, limits, true, CACHE_TASK, [fault.guardrail], contract || restructured ? 'agent' : arm === 'agent' || arm === 'script' ? arm : 'coding');
    await save(path.join(directory, 'fault.json'), fault.events);
    await save(path.join(directory, 'summary.json'), { phase: record.phase, success: record.success, error: record.error, counts: record.counts, wallMs: record.wallMs, budget });
    process.stdout.write(JSON.stringify({ route: route.id, arm, phase: record.phase, error: record.error, calls: budget.calls, elapsedMs: record.wallMs }) + '\n');
    if (budget.stopped || record.error) break;
  }
}
