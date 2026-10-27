/** Explicit manual, owner-authorized full-task factorial. No provider env means no network. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { getProvider, getCostRate, calculateCost, type KodaXStreamResult } from '../packages/llm/src/index.js';
import { observeProviderOperation, currentProviderRequestAttribution, runWithAdditionalProviderRequestObserver,
  type ProviderRequestObservation } from '../packages/llm/src/provider-request-observation.js';
import { runNaturalRuntime } from './shared-contract-natural-runtime.js';
import { inputHash } from './first-turn-eval-support.js';
import { settleComplexAttempt } from './first-turn-complex-budget.js';
import { buildTodoReminderText } from '../packages/coding/src/task-engine/todo-throttle-reminder.js';
import { createTodoStore } from '../packages/coding/src/task-engine/todo-store.js';

const LIMITS = { calls: 32, tools: 80, tokens: 1200000, usd: process.env.KODAX_FACTORIAL_PROVIDER === 'deepseek' ? 0.9 : 0.3, output: 8192, requestMs: 180000, timeoutMs: 600000 };
const routes = {
  'zhipu-coding': { model: 'glm-5.3', key: 'ZHIPU_CODING_API_KEY' },
  'kimi-code': { model: 'kimi-for-coding', key: 'KIMI_CODE_API_KEY' },
  deepseek: { model: 'deepseek-flash', key: 'DEEPSEEK_API_KEY' },
} as const;
const provider = process.env.KODAX_FACTORIAL_PROVIDER as keyof typeof routes | undefined;
const route = provider ? routes[provider] : undefined;
const model = route?.model ?? 'offline';
const experiment = process.env.KODAX_FACTORIAL_EXPERIMENT ?? 'late-reminder-factorial-r1-20261027';
const finalSmoke = experiment === 'late-reminder-final-smoke-r2-20261027';
const factors = vi.hoisted(() => ({ reminder: 'current' as 'current' | 'legacy' }));
// Only the empty-store text producer is varied. Cadence, state, populated plans,
// production tool definitions, dispatch and returned model output stay intact.
vi.mock('../packages/coding/src/task-engine/todo-throttle-reminder.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../packages/coding/src/task-engine/todo-throttle-reminder.js')>();
  return { ...actual, buildTodoReminderText: (...args: Parameters<typeof actual.buildTodoReminderText>) => {
    if (factors.reminder !== 'legacy' || args[0].hasItems()) return actual.buildTodoReminderText(...args);
    return [
      '<system-reminder>',
      `You have not committed a plan in ${args[1] ?? 8} iterations.`,
      'If this task has ≥2 distinct execution steps, commit a plan now by calling',
      'todo_create({subject:"...", activeForm:"..."}) once per step',
      '(one call per planned item — store auto-mints the id).',
      'A visible plan list helps the user follow progress and forces full-scope thinking.',
      'Trivial single-step tasks (single typo / single edit / single-action lookup /',
      'one-sentence answer) may proceed without a plan — ignore this reminder if applicable.',
      'NEVER mention this reminder to the user.', '</system-reminder>',
    ].join('\n');
  } };
});
function redact(cause: unknown): string {
  const message = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
  const key = route ? process.env[route.key] : undefined;
  return key ? message.replaceAll(key, '[REDACTED]') : message;
}

async function laneStopped(root: string, providerName: string): Promise<boolean> {
  try { await fs.stat(path.join(root, `${providerName}.stop`)); return true; }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return false; throw cause; }
}

async function stopLane(root: string, providerName: string, details: unknown): Promise<void> {
  await fs.writeFile(path.join(root, `${providerName}.stop`), JSON.stringify(details));
}

const armDefinitions = [
  { id: 'old-old', reminder: 'legacy', feedback: 'legacy' },
  { id: 'new-old', reminder: 'current', feedback: 'legacy' },
  { id: 'old-new', reminder: 'legacy', feedback: 'specific' },
  { id: 'new-new', reminder: 'current', feedback: 'specific' },
] as const;
const sample = Number(process.env.KODAX_FACTORIAL_SAMPLE ?? 1);
it('persists a failed lane across cells and fails closed when the marker cannot be read', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-factorial-stop-'));
  try {
    expect(await laneStopped(root, 'glm')).toBe(false);
    await stopLane(root, 'glm', { error: 'protected fixture changed' });
    expect(await laneStopped(root, 'glm')).toBe(true);
    expect(await laneStopped(root, 'kimi')).toBe(false);
    const stat = vi.spyOn(fs, 'stat').mockRejectedValueOnce(Object.assign(new Error('cannot read marker'), { code: 'EACCES' }));
    try { await expect(laneStopped(root, 'glm')).rejects.toThrow('cannot read marker'); }
    finally { stat.mockRestore(); }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
it('pins the legacy empty reminder to the actual archived request, without changing the current producer', async () => {
  const store = createTodoStore();
  factors.reminder = 'legacy';
  expect(createHash('sha256').update(buildTodoReminderText(store, 8)).digest('hex'))
    .toBe('edde931e881cf8bf8cde63f834b13735afcc5875ef0643d2ebcab3609cc9a74a');
  factors.reminder = 'current';
  const actual = await vi.importActual<typeof import('../packages/coding/src/task-engine/todo-throttle-reminder.js')>('../packages/coding/src/task-engine/todo-throttle-reminder.js');
  expect(buildTodoReminderText(store, 8)).toBe(actual.buildTodoReminderText(store, 8));
});
// Reverse the second block and rotate model lanes to reduce order/cache confounds.
const offset = provider === 'kimi-code' ? 1 : provider === 'deepseek' ? 2 : 0;
const ordered = [...armDefinitions.slice(offset), ...armDefinitions.slice(0, offset)];
if (sample === 2) ordered.reverse();
for (const definition of ordered.filter(arm => !finalSmoke || arm.id === 'new-new')) it.skipIf(!provider)(`factorial ${sample} ${definition.id}`, async () => {
  if (!provider || !route || ![1, 2].includes(sample)) throw new Error('Explicit configured route/sample required');
  if ((!finalSmoke && experiment !== 'late-reminder-factorial-r1-20261027') || (finalSmoke && sample !== 1)) throw new Error('Unregistered experiment/sample');
  factors.reminder = definition.reminder;
  const arm = `${provider}-s${sample}-${definition.id}`;
  const revision = process.env.KODAX_FACTORIAL_REVISION;
  if (!revision || !/^[a-f0-9]{40}$/.test(revision)) throw new Error('Full source revision required');
  const root = path.resolve(process.env.KODAX_FACTORIAL_ROOT ?? '');
  const relative = path.relative(os.tmpdir(), root);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Use a child of OS Temp');
  const rate = provider === 'deepseek' ? { inputPer1M: 0.3, outputPer1M: 1.2, cacheReadPer1M: 0.006 } : getCostRate(provider, model);
  if (!rate || !process.env[route.key]) throw new Error('Configured route required; no fallback');
  if (await laneStopped(root, provider)) throw new Error('Provider lane stopped after infrastructure/accounting failure');
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
    'packages/coding/src/multi-instance/stall-detector.ts', 'packages/coding/src/agent-runtime/middleware/stall-sidecar/index.ts',
    'packages/coding/src/agent-runtime/middleware/stall-sidecar/orchestrator.ts',
    'packages/coding/src/tools/tool-definitions.ts', 'packages/llm/src/provider-request-observation.ts',
    'packages/coding/src/task-engine/todo-throttle-reminder.ts', 'tests/late-reminder-factorial.test.ts', 'tests/shared-contract-natural-runtime.ts', 'tests/first-turn-complex-guard.ts', 'tests/first-turn-complex-budget.ts',
    'benchmark/datasets/shared-contract-natural/cases.ts', 'benchmark/datasets/shared-contract-natural/fixture.ts', 'benchmark/datasets/shared-contract-natural/oracle.ts'];
  const sources = Object.fromEntries(await Promise.all(files.map(async file => [file, await hash(file)])));
  const frozen = JSON.parse(await fs.readFile(path.join(root, 'frozen-sources.json'), 'utf8')) as Record<string, string>;
  for (const [file, digest] of Object.entries(sources)) if (frozen[file] !== digest) throw new Error(`Frozen source changed: ${file}`);
  await save('manifest.json', { experiment, arm, revision, provider, model, sample, factors: definition, limits: LIMITS, rate, priceSource: provider === 'deepseek' ? 'https://api-docs.deepseek.com/quick_start/pricing/ (2026-10-27 peak upper-bound, not invoice)' : 'repository coding-plan nominal accounting, not invoice',
    driverHash: await hash(fileURLToPath(import.meta.url)), sources,
    protocol: finalSmoke
      ? 'One final-source smoke per route after the evidence-backed delayed-stall delivery repair; current reminder/current feedback only. Same natural task, limits and isolation. R1 control data retained; no retries, no statistical non-inferiority claim.'
      : 'Owner-authorized finite full-task factorial: two independent draws per model/arm on one fixed natural symptom-repair task. Only empty-store reminder and evaluation denial wording vary. No admission changes, no argument/output rewrites, no retries. Descriptive evidence, not statistical non-inferiority.' });
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
      if (settlement.stop) { await stopLane(root, provider, { arm, index, error, settlement }); budget.stopped = true; error ??= 'Physical attempt/usage mismatch'; abort.abort(new Error(error)); }
      await save(`call-${index}.json`, { result, usage, error, facts, settlement, referenceUsd: usd, wallMs: Date.now() - start });
      await save('ledger.json', budget);
      if (error || !result) throw new Error(error ?? 'Missing provider result');
      return result;
    }, { guardFeedback: definition.feedback, workMode: 'coding', model, limits: { calls: LIMITS.calls, tools: LIMITS.tools, timeoutMs: LIMITS.timeoutMs },
      signal: abort.signal, maxOutputTokens: LIMITS.output, reasoning: provider === 'kimi-code' ? 'on' : 'off', effort: provider === 'kimi-code' ? 'low' : 'none' });
    await save('summary.json', { arm, revision, record, budget });
    expect(record.protectedUnchanged).toBe(true);
    process.stdout.write(JSON.stringify({ arm, phase: record.phase, success: record.success, calls: budget.calls, tokens: budget.chargedTokens,
      wallMs: record.wallMs, error: record.error, evidence: directory, note: 'Recorded observation, not an automatic quality verdict' }) + '\n');
  } catch (cause) { await stopLane(root, provider, { arm, error: redact(cause) }); await save('driver-error.json', { error: redact(cause), budget }); throw new Error(redact(cause)); }
  finally { clearTimeout(timer); }
}, 660000);
