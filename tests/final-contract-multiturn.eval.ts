/** Explicit final-version product acceptance. No historical or candidate re-generation. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, watch } from 'node:fs';
import { it } from 'vitest';
import { getProvider, getCostRate, calculateCost, type KodaXStreamResult } from '@kodax-ai/llm';
import { observeProviderOperation, runWithAdditionalProviderRequestObserver, currentProviderRequestAttribution,
  type ProviderRequestObservation } from '../packages/llm/src/provider-request-observation.js';
import { runNaturalRuntime, type NaturalInvoke } from './shared-contract-natural-runtime.js';
import { runFinalHistoryRuntime, HISTORY_FILES, HISTORY_MEMO, HISTORY_SEED_PROMPT, HISTORY_RECOVERY_PROMPT } from './final-contract-history-runtime.js';
import { PRODUCT_CASES } from '../benchmark/datasets/product-multiturn/fixture.js';
import { NEXT_STAGE_ROUTES, type NextStageRoute } from './token-efficiency-next-stage-fixtures.js';
import { FirstTurnBudget, inputHash } from './first-turn-eval-support.js';
import { settleComplexAttempt } from './first-turn-complex-budget.js';
import { assertFinalSource, persistFinalEvidence } from './final-contract-eval-integrity.js';

export const FINAL_LIMITS = {
  'output-retention': { calls: 24, tools: 80, tokens: 1_200_000, usd: 0.60 },
  'history-child-recovery': { calls: 16, tools: 80, tokens: 600_000, usd: 0.30 },
} as const;
type CaseId = keyof typeof FINAL_LIMITS;
type Cell = { id: string; route: NextStageRoute; caseId: CaseId };
type OriginalRetention = { caseId: string; provider: string; directory: string; resultHash: string; manifestHash: string;
  evidence: { file: string; expected: string }[] };
type Manifest = { revision: string; sources: Record<string, string>; critical: Record<string, string>; cells: Cell[];
  rates: Record<NextStageRoute, NonNullable<ReturnType<typeof getCostRate>>>; originalRetention: OriginalRetention[]; originalAuditHash: string };
const phase = process.env.KODAX_FINAL_MULTITURN_PHASE;
const output = process.env.KODAX_FINAL_MULTITURN_ROOT;
const critical = ['tests/final-contract-multiturn.eval.ts', 'tests/final-contract-history-runtime.ts', 'tests/shared-contract-natural-runtime.ts',
  'tests/final-contract-eval-integrity.ts', 'tests/first-turn-compact-recovery.ts',
  'tests/first-turn-complex-guard.ts', 'tests/first-turn-complex-budget.ts', 'tests/first-turn-eval-support.ts',
  'benchmark/datasets/product-multiturn/fixture.ts', 'benchmark/harness/natural-execution-environment.ts',
  'benchmark/harness/isolated-output-binding.mjs', 'packages/coding/src/child-executor.ts', 'packages/coding/src/agent-runtime/run-substrate.ts',
  'packages/coding/src/tools/session-history.ts', 'packages/coding/src/tools/managed-tool-text.ts',
  'packages/coding/src/task-engine/_internal/managed-task/llm-adapter.ts', 'packages/agent/src/session-lineage/history-retrieval.ts',
  'packages/llm/src/providers/anthropic.ts', 'packages/llm/src/providers/registry.ts', 'src/sdk-runtime.ts'];
const fileHash = async (file: string) => createHash('sha256').update(await fs.readFile(file)).digest('hex');
const hashes = async (files: readonly string[]) => {
  const result: Record<string, string> = {};
  for (let index = 0; index < files.length; index += 32) {
    for (const [file, hash] of await Promise.all(files.slice(index, index + 32).map(async file => [file, await fileHash(file)] as const))) result[file] = hash;
  }
  return result;
};
function rootPath() {
  if (!output || !path.isAbsolute(output)) throw new Error('Explicit final eval output required');
  const relative = path.relative(os.tmpdir(), output);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Output must be a child of OS Temp');
  return output;
}
function redact(text: string) {
  for (const route of Object.values(NEXT_STAGE_ROUTES)) {
    const key = process.env[route.key];
    if (key) text = text.replaceAll(key, '[REDACTED]');
  }
  return text;
}
const write = (file: string, value: unknown, exclusive = true) => fs.writeFile(file, redact(JSON.stringify(value, null, 2)), exclusive ? { flag: 'wx' } : {});
async function stopped(root: string) {
  try { await fs.stat(path.join(root, 'STOP')); return true; }
  catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
async function prepare() {
  const root = rootPath();
  await fs.mkdir(root, { recursive: false });
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--',
    'packages', 'src', 'tests', 'benchmark', 'package.json', 'package-lock.json', 'vitest.config.ts', 'vitest.eval.config.ts', 'tsconfig.json'],
    { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/).filter(file => /\.(?:[cm]?[jt]sx?|json|toml|rs|lock|md)$/.test(file));
  const cells: Cell[] = (Object.keys(FINAL_LIMITS) as CaseId[]).flatMap((caseId, caseIndex) =>
    (Object.keys(NEXT_STAGE_ROUTES) as NextStageRoute[]).map((route, routeIndex) => ({ id: `cell-0${1 + caseIndex * 3 + routeIndex}`, route, caseId })));
  const rates = Object.fromEntries((Object.keys(NEXT_STAGE_ROUTES) as NextStageRoute[]).map(route => {
    const rate = route === 'deepseek' ? { inputPer1M: 0.3, outputPer1M: 1.2, cacheReadPer1M: 0.006 } : getCostRate(route, NEXT_STAGE_ROUTES[route].model);
    if (!rate) throw new Error(`Missing reference rate: ${route}`);
    return [route, rate];
  })) as Manifest['rates'];
  const auditFile = path.join(os.tmpdir(), 'kodax-final-original-reuse-20261031/audit.json');
  const originalRetention = (JSON.parse(await fs.readFile(auditFile, 'utf8')) as { rows: OriginalRetention[] }).rows
    .filter(row => row.caseId === 'output-retention');
  if (originalRetention.length !== 3) throw new Error('Missing immutable original observations');
  for (const row of originalRetention) {
    for (const item of row.evidence) if (await fileHash(item.file) !== item.expected) throw new Error('Original evidence changed');
  }
  const manifest: Manifest = { revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(),
    sources: await hashes(files), critical: await hashes(critical), cells, rates, originalRetention, originalAuditHash: await fileHash(auditFile) };
  await write(path.join(root, 'manifest.json'), manifest);
  await write(path.join(root, 'preregistration.json'), { manifestHash: inputHash(manifest),
    purpose: 'Owner-authorized final-version bounded multi-turn acceptance, not prompt A/B or statistical non-inferiority.',
    whyNotLayer1: 'Offline seams already prove execution. Actual model selection of entryRevision, response to read-route failure, editing, tests and honest AMA delivery require real model decisions.',
    exception: 'Six current-only acceptance cells explicitly implement the owner request across three families; exceeds the usual three-smoke guideline. No original regeneration, no mode/version matrix.',
    limits: FINAL_LIMITS, sharedCaps: { calls: 120, tokens: 5_400_000, referenceUsd: 2.70 }, output: 8192, requestMs: 180_000, cellMs: 600_000,
    concurrency: 'One physical request per family via actual Relay queue; independent families may run concurrently. No retry/fallback.',
    tasks: { 'output-retention': { prompt: PRODUCT_CASES['output-retention'].prompt, followUp: PRODUCT_CASES['output-retention'].followUp },
      'history-child-recovery': { seed: HISTORY_SEED_PROMPT, followUp: HISTORY_RECOVERY_PROMPT, evidence: HISTORY_MEMO, files: HISTORY_FILES } },
    review: 'A: opaque paired original/current final reports, final files, tests and common README before reveal; evaluate requirements/accuracy, not mere completion. B: standalone evidence quality, entry version/paging, child guard→legal evidence→terminal summary→root integration. Missing exercised paths remain coverage gaps, never rerun for coverage.',
    original: 'A reuses bd4479 GLM R13 cell-05, Kimi R14 cell-06, DeepSeek R14 cell-08; GLM older environment is a historical reference. B original N/A. Whole-version observations, not prompt causal inference.',
    freeze: 'Full source snapshot before/after cell; critical model/execution chain checked before each dispatch. Input bytes and physical observations are saved before/after every request; any detected source drift stops globally.',
    stop: 'Unknown/invalid usage, transport/auth failure, reservation overrun, source drift or evidence write failure aborts the lane and publishes global STOP before further dispatch. Preserve the existing narrowly bounded AMA sidecar cancellation exception, conservatively reserve unknown usage and never count it as known billing. Valid quality failures do not trigger reruns or quota increases.',
    fees: 'Frozen reference rates only, not current prices, cash invoices or subscription quota accounting. Original reference fees retain their original rate; compare unified recalculation separately.',
  });
}
async function runCell() {
  const root = rootPath(), id = process.env.KODAX_FINAL_MULTITURN_CELL;
  const abort = new AbortController();
  const fatal = async (message: string) => {
    abort.abort(new Error(message));
    await write(path.join(root, 'STOP'), { cell: id, reason: message }, false);
  };
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8')) as Manifest;
  const prereg = JSON.parse(await fs.readFile(path.join(root, 'preregistration.json'), 'utf8')) as { manifestHash: string };
  if (inputHash(manifest) !== prereg.manifestHash) throw new Error('Manifest changed');
  const cell = manifest.cells.find(item => item.id === id);
  if (!cell || await stopped(root)) throw new Error('Unknown or stopped cell');
  const config = NEXT_STAGE_ROUTES[cell.route], limit = FINAL_LIMITS[cell.caseId];
  if (!process.env[config.key]) throw new Error(`Missing configured ${cell.route} credential`);
  await assertFinalSource(async () => inputHash(await hashes(Object.keys(manifest.sources))) === inputHash(manifest.sources), fatal);
  const directory = path.join(root, cell.id);
  if (process.env.KODAX_TOOL_OUTPUT_DIR !== path.join(directory, 'workspace/.agent/tmp/tool-results')) throw new Error('Missing isolated output preload');
  await fs.mkdir(directory, { recursive: false });
  const backups = [path.join(root, 'backup-a', cell.id), path.join(root, 'backup-b', cell.id)];
  for (const target of backups) await fs.mkdir(target, { recursive: true });
  const save = async (name: string, data: unknown, exclusive = true) => {
    await persistFinalEvidence(async () => {
      for (const target of [directory, ...backups]) await write(path.join(target, name), data, exclusive);
    }, fatal);
  };
  await save('manifest.json', { ...cell, revision: manifest.revision, sourceManifestHash: inputHash(manifest), limits: limit, rate: manifest.rates[cell.route] });
  const budget = new FirstTurnBudget(undefined, limit.calls);
  const watcher = watch(root, () => {
    if (existsSync(path.join(root, 'STOP'))) abort.abort(new Error('Global final evaluation STOP'));
  });
  const timer = setTimeout(() => abort.abort(new Error('Final cell timeout')), 600_000);
  const observations: Record<string, unknown>[] = [];
  const invoke: NaturalInvoke = async (input, signal, index, meta) => {
    if (await stopped(root)) { abort.abort(); throw new Error('Global STOP'); }
    await assertFinalSource(async () => inputHash(await hashes(critical)) === inputHash(manifest.critical), fatal);
    abort.signal.throwIfAborted(); signal.throwIfAborted();
    const outputCap = Math.min(meta.streamOptions?.maxOutputTokensOverride ?? 8192, 8192);
    const upper = Buffer.byteLength(JSON.stringify(input), 'utf8') + 4096;
    const reservedTokens = upper + outputCap, rate = manifest.rates[cell.route];
    const reservedUsd = calculateCost(rate, upper, outputCap);
    if (budget.state.chargedTokens + budget.state.reservedTokens + reservedTokens > limit.tokens
      || budget.state.chargedUsd + budget.state.reservedUsd + reservedUsd > limit.usd) {
      await fatal('Frozen cell reservation cap'); throw new Error('Frozen cell reservation cap');
    }
    budget.reserve(reservedTokens, reservedUsd);
    await save(`call-${index}.input.json`, { input, inputHash: inputHash(input), kind: meta.kind, reasoning: meta.reasoning, streamOptions: meta.streamOptions, outputCap, reservedTokens, reservedUsd });
    await save('ledger.json', budget.state, false);
    const facts: ProviderRequestObservation[] = [], start = Date.now();
    const combined = AbortSignal.any([signal, abort.signal, AbortSignal.timeout(180_000)]);
    let result: KodaXStreamResult | undefined, error: string | null = null;
    try {
      result = await runWithAdditionalProviderRequestObserver(fact => facts.push(fact), () => observeProviderOperation(cell.route,
        meta.kind === 'auxiliary' ? 'sidecar' : 'primary', currentProviderRequestAttribution(), () => {
          if (existsSync(path.join(root, 'STOP'))) abort.abort(new Error('Global final evaluation STOP'));
          combined.throwIfAborted();
          return getProvider(cell.route).stream([...input.messages], [...input.tools], input.system, meta.reasoning,
            { ...meta.streamOptions, modelOverride: config.model, maxOutputTokensOverride: outputCap, singleAttempt: true }, combined);
        }, undefined, combined));
    } catch (cause) { error = redact(cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)); }
    const terminal = facts.filter(fact => fact.boundary === 'physical_attempt' && fact.state === 'succeeded').at(-1);
    const usage = terminal?.usage;
    const usd = usage ? calculateCost(rate, usage.inputTokens, usage.outputTokens, usage.cachedReadTokens ?? 0, usage.cachedWriteTokens ?? 0) : undefined;
    const settled = settleComplexAttempt({ reservedTokens, reservedUsd, facts, tools: input.tools.map(tool => tool.name), reasoning: meta.reasoning,
      outputCap, requestCancelled: combined.aborted, taskCancelled: abort.signal.aborted, failed: error !== null, actualUsd: usd });
    budget.settle(reservedTokens, reservedUsd, settled.unknownUsage ? undefined : usage, usd);
    const overrun = (usage?.totalTokens ?? 0) > reservedTokens || (usage?.outputTokens ?? 0) > outputCap || (usd ?? 0) > reservedUsd;
    const invalid = settled.stop || overrun || (!result && !settled.boundedAuxiliaryCancellation);
    if (invalid) await fatal(error ?? 'Physical request/usage integrity failure');
    const observation = { index, kind: meta.kind, result, error, facts, settlement: settled, usage, referenceUsd: usd, wallMs: Date.now() - start };
    observations.push(observation); await save(`call-${index}.result.json`, observation); await save('ledger.json', budget.state, false);
    if (invalid || !result) throw new Error(error ?? 'Invalid provider attempt');
    return result;
  };
  try {
    const record = cell.caseId === 'output-retention'
      ? await runNaturalRuntime(directory, 'output-retention', invoke, { signal: abort.signal, model: config.model,
        workMode: 'coding', limits: { calls: limit.calls, tools: limit.tools, timeoutMs: 600_000 }, maxOutputTokens: 8192,
        reasoning: cell.route === 'kimi-code' ? 'on' : 'off', effort: cell.route === 'kimi-code' ? 'low' : 'none',
        followUps: [{ prompt: PRODUCT_CASES['output-retention'].followUp, permissionMode: 'full-access' }] })
      : await runFinalHistoryRuntime(directory, invoke, { model: config.model, reasoning: cell.route === 'kimi-code' ? 'on' : 'off',
        signal: abort.signal, calls: limit.calls, tools: limit.tools });
    await save('observations.json', observations);
    const after = await hashes(Object.keys(manifest.sources));
    await save('source-after.json', after);
    await assertFinalSource(async () => inputHash(after) === inputHash(manifest.sources), fatal);
    await save('summary.json', { cell, revision: manifest.revision, budget: budget.state, counts: record.counts, error: record.error,
      runs: record.runs, protectedUnchanged: record.protectedUnchanged, wallMs: record.wallMs });
    for (const target of backups) await write(path.join(target, 'result.json'), record);
    const finalFiles: Record<string, string> = {};
    for (const entry of await fs.readdir(path.join(directory, 'workspace'), { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const absolute = path.join(entry.parentPath, entry.name);
      const relative = path.relative(path.join(directory, 'workspace'), absolute).replaceAll('\\', '/');
      if (/^(?:src|tests?)\//.test(relative)) finalFiles[relative] = await fs.readFile(absolute, 'utf8');
    }
    await save('final-files.json', finalFiles);
    process.stdout.write(JSON.stringify({ cell: cell.id, finished: true }) + '\n');
  } catch (cause) {
    const message = redact(cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause));
    await fatal(message); await save('driver-error.json', { error: message, budget: budget.state }); throw new Error(message);
  } finally { clearTimeout(timer); watcher.close(); }
}

it.skipIf(!phase)('executes only an explicitly selected final acceptance phase', async () => {
  if (phase === 'prepare') await prepare();
  else if (phase === 'cell') await runCell();
  else throw new Error('Unsupported final eval phase');
}, 660_000);
