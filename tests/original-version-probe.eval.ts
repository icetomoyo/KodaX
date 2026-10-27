/** Manual, bounded product-version checkpoints. Importing never calls a model. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomInt, createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getProvider, getProviderModels, getCostRate, calculateCost, type KodaXStreamResult } from '../packages/llm/src/index.js';
import { observeProviderOperation, runWithProviderRequestObserver, type ProviderRequestObservation } from '../packages/llm/src/provider-request-observation.js';
import { FirstTurnBudget, firstTurnReasoningFor, inputHash, type FrozenInput, type BudgetSnapshot } from './first-turn-eval-support.js';
import { settleComplexAttempt } from './first-turn-complex-budget.js';

const REVISION = 'original-version-checkpoints-r1-20261027';
const LIMITS = { calls: 8, output: 8192, timeoutMs: 180000, tokens: 1200000, referenceUsd: 3 };
const IDS = ['coding-symptom-repair', 'coding-verification-followup'];
const ROUTES = [
  { id: 'glm', provider: 'zhipu-coding', model: 'glm-5.3', env: 'ZHIPU_CODING_API_KEY' },
  { id: 'kimi', provider: 'kimi-code', model: 'kimi-for-coding', env: 'KIMI_CODE_API_KEY' },
] as const;
interface Checkpoint { id: string; input: FrozenInput }
interface Pair { route: string; caseId: string; arms: { label: string; input: FrozenInput; hash: string }[] }
const read = async <T>(file: string): Promise<T> => JSON.parse(await fs.readFile(file, 'utf8')) as T;
const save = (file: string, value: unknown, exclusive = false) => fs.writeFile(file, JSON.stringify(value, null, 2), exclusive ? { flag: 'wx' } : undefined);
const hashFile = async (file: string) => createHash('sha256').update(await fs.readFile(file)).digest('hex');
function assertTemp(root: string): void {
  const relative = path.relative(os.tmpdir(), path.resolve(root));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Evidence must be a child of OS Temp');
}
export function assertProbeSettled(state: BudgetSnapshot): void {
  // No call/token allowance changes: only machine-precision USD subtraction.
  const roundoff = Number.EPSILON * LIMITS.referenceUsd * LIMITS.calls;
  if (state.unknownUsageCalls > 0 || state.reservedTokens > 0 || state.reservedUsd > roundoff) throw new Error('Unsettled/unknown prior usage; stop for review');
}
export function originalVersionCheckpoints(value: unknown): Checkpoint[] {
  const capture = value as { externalCalls?: number; checkpoints?: Checkpoint[] } | null;
  if (capture?.externalCalls !== 0 || !Array.isArray(capture.checkpoints)) throw new Error('Offline capture required');
  return IDS.map(id => {
    const matches = capture.checkpoints!.filter(row => row.id === id);
    const input = matches[0]?.input;
    if (matches.length !== 1 || !input || typeof input.system !== 'string' || !Array.isArray(input.messages)
      || !Array.isArray(input.tools) || input.tools.some(tool => tool.name === 'script_exec')) throw new Error(`Invalid native checkpoint: ${id}`);
    return { id, input };
  });
}
async function providerHashes(): Promise<Record<string, string>> {
  const root = 'packages/llm/src';
  const files = (await fs.readdir(root, { recursive: true })).filter(file => file.endsWith('.ts') && !file.endsWith('.test.ts'));
  return Object.fromEntries(await Promise.all(files.sort().map(async file => [file, await hashFile(path.join(root, file))])));
}
async function prepare(root: string, baselinePath: string, currentPath: string): Promise<void> {
  assertTemp(baselinePath); assertTemp(currentPath);
  const baseline = originalVersionCheckpoints(await read(baselinePath));
  const current = originalVersionCheckpoints(await read(currentPath));
  const pairs: Pair[] = []; const mapping: unknown[] = [];
  for (const route of ROUTES) for (const id of IDS) {
    const reverse = randomInt(2) === 1;
    const versions = reverse ? [current, baseline] : [baseline, current];
    pairs.push({ route: route.id, caseId: id, arms: versions.map((rows, i) => {
      const input = rows.find(row => row.id === id)!.input;
      return { label: i === 0 ? 'A' : 'B', input, hash: inputHash(input) };
    }) });
    mapping.push({ route: route.id, caseId: id, A: reverse ? 'current' : 'original', B: reverse ? 'original' : 'current' });
  }
  await fs.mkdir(root, { recursive: false });
  for (const dir of ['backup-a', 'backup-b']) await fs.mkdir(path.join(root, dir));
  const manifest = { revision: REVISION, limits: LIMITS, pairsHash: inputHash(pairs), sources: await providerHashes(),
    driverHash: await hashFile(fileURLToPath(import.meta.url)),
    baseline: { file: baselinePath, hash: await hashFile(baselinePath) }, current: { file: currentPath, hash: await hashFile(currentPath) },
    rates: Object.fromEntries(ROUTES.map(route => [route.id, getCostRate(route.provider, route.model)])),
    protocol: 'Two L2 checkpoints, 1 sample/version/provider. No tool execution or retries. Current transport for both versions. Not full-task quality/latency equivalence.' };
  for (const dir of [root, path.join(root, 'backup-a'), path.join(root, 'backup-b')]) {
    await save(path.join(dir, 'manifest.json'), manifest, true); await save(path.join(dir, 'pairs.private.json'), pairs, true);
    await save(path.join(dir, 'mapping.private.json'), mapping, true);
    await fs.copyFile(fileURLToPath(import.meta.url), path.join(dir, 'executed-driver.ts'));
  }
  await save(path.join(root, 'ledger.json'), new FirstTurnBudget(undefined, LIMITS.calls).state, true);
  process.stdout.write(JSON.stringify({ prepared: root, manifestHash: inputHash(manifest), paidCalls: 0 }) + '\n');
}
function redact(cause: unknown): string {
  let text = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
  for (const route of ROUTES) { const secret = process.env[route.env]; if (secret) text = text.replaceAll(secret, '[REDACTED]'); }
  return text;
}
async function run(root: string, caseId: string, manifestHash: string): Promise<void> {
  if (!IDS.includes(caseId)) throw new Error('Select a frozen checkpoint');
  const manifest = await read<{ revision: string; limits: typeof LIMITS; pairsHash: string; sources: Record<string, string>; driverHash: string; rates: Record<string, unknown> }>(path.join(root, 'manifest.json'));
  const pairs = await read<Pair[]>(path.join(root, 'pairs.private.json'));
  if (inputHash(manifest) !== manifestHash || manifest.revision !== REVISION || inputHash(manifest.limits) !== inputHash(LIMITS)
    || manifest.pairsHash !== inputHash(pairs) || inputHash(manifest.sources) !== inputHash(await providerHashes())
    || manifest.driverHash !== await hashFile(fileURLToPath(import.meta.url))) throw new Error('Frozen experiment changed');
  for (const route of ROUTES) if (!process.env[route.env] || !getProviderModels(route.provider).includes(route.model)
    || !getCostRate(route.provider, route.model) || inputHash(getCostRate(route.provider, route.model)) !== inputHash(manifest.rates[route.id])) throw new Error(`Unavailable route ${route.id}`);
  const lock = await fs.open(path.join(root, 'run.lock'), 'wx');
  try {
    const budget = new FirstTurnBudget(await read<BudgetSnapshot>(path.join(root, 'ledger.json')), LIMITS.calls);
    assertProbeSettled(budget.state);
    await save(path.join(root, `${caseId}.started.json`), { time: new Date().toISOString() }, true);
    let persistence = Promise.resolve();
    const persist = (name: string, value: unknown) => {
      const serialized = JSON.stringify(value, null, 2);
      persistence = persistence.then(async () => {
        for (const dir of [root, path.join(root, 'backup-a'), path.join(root, 'backup-b')]) await fs.writeFile(path.join(dir, name), serialized);
      }); return persistence;
    };
    let stopping = false;
    const outcomes = await Promise.allSettled(ROUTES.map(async route => {
      try {
        const pair = pairs.find(item => item.route === route.id && item.caseId === caseId)!;
        for (const arm of pair.arms) {
          if (stopping) return;
          if (inputHash(arm.input) !== arm.hash) throw new Error('Input hash mismatch');
          const rate = getCostRate(route.provider, route.model)!;
          const inputReserve = Buffer.byteLength(JSON.stringify(arm.input)) + 4096;
          const reserveTokens = inputReserve + LIMITS.output; const reserveUsd = calculateCost(rate, inputReserve, LIMITS.output);
          budget.reserve(reserveTokens, reserveUsd); await persist('ledger.json', budget.state);
          const signal = AbortSignal.timeout(LIMITS.timeoutMs); const started = Date.now();
          const facts: ProviderRequestObservation[] = []; const reasoning = firstTurnReasoningFor(route.provider);
          let result: KodaXStreamResult | undefined; let error: string | null = null;
          try {
            result = await runWithProviderRequestObserver(fact => facts.push(fact), () => observeProviderOperation(route.provider, 'utility', undefined,
              () => getProvider(route.provider).stream([...arm.input.messages], [...arm.input.tools], arm.input.system, reasoning,
                { modelOverride: route.model, maxOutputTokensOverride: LIMITS.output, singleAttempt: true }, signal), undefined, signal));
          } catch (cause) { error = redact(cause); }
          const usage = result?.usage; const usd = usage ? calculateCost(rate, usage.inputTokens, usage.outputTokens, usage.cachedReadTokens ?? 0, usage.cachedWriteTokens ?? 0) : undefined;
          const settlement = settleComplexAttempt({ reservedTokens: reserveTokens, reservedUsd: reserveUsd, facts,
            tools: arm.input.tools.map(tool => tool.name), reasoning, outputCap: LIMITS.output, requestCancelled: signal.aborted,
            taskCancelled: signal.aborted, failed: error !== null, actualUsd: usd });
          budget.settle(reserveTokens, reserveUsd, settlement.unknownUsage ? undefined : usage, settlement.unknownUsage ? undefined : usd);
          const id = `${route.id}-${caseId}-${arm.label}`;
          await persist(`${id}.json`, { route, caseId, arm: arm.label, inputHash: arm.hash, reasoning, result, usage, referenceUsd: usd,
            error, facts, settlement, wallMs: Date.now() - started });
          await persist(`${id}.blind.json`, { route: route.id, caseId, arm: arm.label, text: result?.textBlocks,
            tools: result?.toolBlocks, thinking: result?.thinkingBlocks, stopReason: result?.stopReason, error });
          await persist('ledger.json', budget.state);
          if (settlement.stop || error || budget.state.chargedTokens > LIMITS.tokens || budget.state.chargedUsd > LIMITS.referenceUsd) throw new Error(`Stop after ${id}; preserved error/usage, no retry`);
        }
      } catch (cause) { stopping = true; throw cause; }
    }));
    process.stdout.write(JSON.stringify({ root, caseId, budget: budget.state, errors: outcomes.filter(row => row.status === 'rejected').map(row => redact(row.reason)) }) + '\n');
    if (outcomes.some(row => row.status === 'rejected')) process.exitCode = 1;
  } finally { await lock.close(); await fs.unlink(path.join(root, 'run.lock')); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [command, root = '', arg1 = '', arg2 = ''] = process.argv.slice(2);
  try {
    assertTemp(root);
    if (command === 'prepare') await prepare(root, arg1, arg2);
    else if (command === 'run') await run(root, arg1, arg2);
    else throw new Error('Use prepare <temp-root> <original-capture> <current-capture> or run <temp-root> <case> <manifest-hash>');
  } catch (cause) { process.stderr.write(redact(cause) + '\n'); process.exitCode = 1; }
}
