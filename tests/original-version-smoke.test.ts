/** Explicit manual L3.5 product-version observation; ordinary test runs never call a provider. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { getProvider, getCostRate, calculateCost, type KodaXStreamResult } from '../packages/llm/src/index.js';
import { observeProviderOperation, currentProviderRequestAttribution, runWithAdditionalProviderRequestObserver,
  type ProviderRequestObservation } from '../packages/llm/src/provider-request-observation.js';
import { runNaturalRuntime } from './shared-contract-natural-runtime.js';
import { inputHash } from './first-turn-eval-support.js';
import { settleComplexAttempt } from './first-turn-complex-budget.js';

const LIMITS = { calls: 32, tools: 80, tokens: 1200000, usd: 0.30, output: 8192, requestMs: 180000, timeoutMs: 600000 };
const provider = 'zhipu-coding';
const model = 'glm-5.3';
function redact(cause: unknown): string {
  const message = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
  const key = process.env.ZHIPU_CODING_API_KEY;
  return key ? message.replaceAll(key, '[REDACTED]') : message;
}

it.skipIf(!process.env.KODAX_ORIGINAL_SMOKE_ARM)('records one bounded original/current complete Runtime observation', async () => {
  const arm = process.env.KODAX_ORIGINAL_SMOKE_ARM!;
  const revision = process.env.KODAX_ORIGINAL_SMOKE_REVISION;
  if (!['original', 'current'].includes(arm) || !revision || !/^[a-f0-9]{40}$/.test(revision)) throw new Error('Explicit arm and full source revision required');
  const root = path.resolve(process.env.KODAX_ORIGINAL_SMOKE_ROOT ?? '');
  const relative = path.relative(os.tmpdir(), root);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Use a child of OS Temp');
  const rate = getCostRate(provider, model);
  if (!rate || !process.env.ZHIPU_CODING_API_KEY) throw new Error('Configured GLM route required; no fallback');
  const directory = path.join(root, arm);
  await fs.mkdir(directory, { recursive: false }); // Never rerun or overwrite a started arm.
  const backups = [path.join(root, 'backup-a', arm), path.join(root, 'backup-b', arm)];
  for (const backup of backups) await fs.mkdir(backup, { recursive: true });
  const save = async (name: string, data: unknown) => {
    const text = JSON.stringify(data, null, 2);
    for (const target of [directory, ...backups]) await fs.writeFile(path.join(target, name), text);
  };
  const hash = async (file: string) => createHash('sha256').update(await fs.readFile(file)).digest('hex');
  const files = ['src/sdk-runtime.ts', 'packages/coding/src/task-engine/runner-driven.ts', 'packages/coding/src/agents/worker-role-prompt.ts',
    'packages/coding/src/tools/tool-definitions.ts', 'packages/llm/src/provider-request-observation.ts',
    'tests/shared-contract-natural-runtime.ts', 'tests/first-turn-complex-guard.ts', 'tests/first-turn-complex-budget.ts',
    'benchmark/datasets/shared-contract-natural/cases.ts', 'benchmark/datasets/shared-contract-natural/fixture.ts', 'benchmark/datasets/shared-contract-natural/oracle.ts'];
  await save('manifest.json', { experiment: 'original-version-complete-observation-r2-20261027', arm, revision, provider, model, limits: LIMITS,
    driverHash: await hash(fileURLToPath(import.meta.url)), sources: Object.fromEntries(await Promise.all(files.map(async file => [file, await hash(file)]))),
    protocol: 'One fixed symptom-repair task per product version. R2 changes late reminder wording and composition-denial feedback only; original R1 evidence stays frozen. Actual Runtime/provider version; not isolated prompt causality or statistical non-inferiority. Natural prompt, unchanged admission rules, no output/argument rewrites, no reruns.' });
  const budget = { calls: 0, chargedTokens: 0, chargedUsd: 0, reservedTokens: 0, reservedUsd: 0, unknownUsageCalls: 0, stopped: false };
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error('Whole Run timeout')), LIMITS.timeoutMs);
  try {
    const record = await runNaturalRuntime(directory, 'symptom-repair', async (input, signal, index, meta) => {
      signal.throwIfAborted(); abort.signal.throwIfAborted();
      if (budget.stopped) throw new Error('No dispatch after accounting/provider stop');
      const outputCap = Math.min(LIMITS.output, meta.streamOptions?.maxOutputTokensOverride ?? LIMITS.output);
      const inputReserve = Buffer.byteLength(JSON.stringify(input)) + 4096;
      const reservedTokens = inputReserve + outputCap; const reservedUsd = calculateCost(rate, inputReserve, outputCap);
      if (budget.calls >= LIMITS.calls || budget.chargedTokens + budget.reservedTokens + reservedTokens > LIMITS.tokens
        || budget.chargedUsd + budget.reservedUsd + reservedUsd > LIMITS.usd) throw new Error('Hard whole-Run budget exhausted');
      budget.calls++; budget.reservedTokens += reservedTokens; budget.reservedUsd += reservedUsd;
      await save(`call-${index}.input.json`, { input, inputHash: inputHash(input), kind: meta.kind, reasoning: meta.reasoning, streamOptions: meta.streamOptions, outputCap });
      await save('ledger.json', budget);
      const facts: ProviderRequestObservation[] = []; const start = Date.now();
      const requestSignal = AbortSignal.any([signal, abort.signal, AbortSignal.timeout(LIMITS.requestMs)]);
      let result: KodaXStreamResult | undefined; let error: string | null = null;
      try {
        result = await runWithAdditionalProviderRequestObserver(fact => facts.push(fact), () => observeProviderOperation(provider,
          meta.kind === 'auxiliary' ? 'sidecar' : 'primary', currentProviderRequestAttribution(),
          () => getProvider(provider).stream([...input.messages], [...input.tools], input.system, meta.reasoning,
            { ...meta.streamOptions, modelOverride: model, maxOutputTokensOverride: outputCap, singleAttempt: true }, requestSignal), undefined, requestSignal));
      } catch (cause) { error = redact(cause); }
      const usage = result?.usage; const usd = usage ? calculateCost(rate, usage.inputTokens, usage.outputTokens, usage.cachedReadTokens ?? 0, usage.cachedWriteTokens ?? 0) : undefined;
      const settlement = settleComplexAttempt({ reservedTokens, reservedUsd, facts, tools: input.tools.map(tool => tool.name), reasoning: meta.reasoning,
        outputCap, requestCancelled: signal.aborted, taskCancelled: meta.taskSignal?.aborted ?? abort.signal.aborted, failed: error !== null, actualUsd: usd });
      budget.reservedTokens -= reservedTokens; budget.reservedUsd -= reservedUsd;
      budget.chargedTokens += settlement.chargedTokens; budget.chargedUsd += settlement.chargedUsd;
      if (settlement.unknownUsage) budget.unknownUsageCalls++;
      if (settlement.stop) { budget.stopped = true; error ??= 'Physical attempt/usage mismatch'; abort.abort(new Error(error)); }
      await save(`call-${index}.json`, { result, usage, error, facts, settlement, referenceUsd: usd, wallMs: Date.now() - start });
      await save('ledger.json', budget);
      if (error || !result) throw new Error(error ?? 'Missing provider result');
      return result;
    }, { workMode: 'coding', model, limits: { calls: LIMITS.calls, tools: LIMITS.tools, timeoutMs: LIMITS.timeoutMs },
      signal: abort.signal, maxOutputTokens: LIMITS.output, reasoning: 'off', effort: 'none' });
    await save('summary.json', { arm, revision, record, budget });
    expect(record.protectedUnchanged).toBe(true);
    process.stdout.write(JSON.stringify({ arm, phase: record.phase, success: record.success, calls: budget.calls, tokens: budget.chargedTokens,
      wallMs: record.wallMs, error: record.error, evidence: directory, note: 'Recorded observation, not an automatic quality verdict' }) + '\n');
  } catch (cause) { await save('driver-error.json', { error: redact(cause), budget }); throw new Error(redact(cause)); }
  finally { clearTimeout(timer); }
}, 660000);
