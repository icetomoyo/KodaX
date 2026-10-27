/** Manual L3.5 observation: three candidate-only Runs, never a causal comparison. Import is offline. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { getProvider, getProviderModels, getCostRate, calculateCost, type KodaXStreamResult } from '../packages/llm/src/index.js';
import { runWithProviderRequestAttribution as publicAttribution } from '@kodax-ai/llm';
import { runWithProviderRequestAttribution, currentProviderRequestAttribution, observeProviderOperation,
  runWithAdditionalProviderRequestObserver, type ProviderRequestObservation } from '../packages/llm/src/provider-request-observation.js';
import { buildScriptModelDescription } from '../packages/coding/src/agent-runtime/script/model.js';
import { inputHash, type FrozenInput } from './first-turn-eval-support.js';
import { restructuredContractInput } from './restructured-contract.js';
import { assertSemanticReview } from './managed-tool-contract.eval.js';
import { settleComplexAttempt } from './first-turn-complex-budget.js';
import { runNaturalRuntime } from './shared-contract-natural-runtime.js';

const REVISION = 'shared-native-smoke-r1-20261027';
const LIMITS = { calls: 32, tools: 80, timeoutMs: 600000, tokens: 1200000, usd: 0.30, output: 8192, requestMs: 180000 };
const CELLS = [
  { id: 'glm-agent', provider: 'zhipu-coding', model: 'glm-5.3', env: 'ZHIPU_CODING_API_KEY', mode: 'agent' },
  { id: 'kimi-coding', provider: 'kimi-code', model: 'kimi-for-coding', env: 'KIMI_CODE_API_KEY', mode: 'coding' },
  { id: 'deepseek-coding', provider: 'deepseek', model: 'deepseek-flash', env: 'DEEPSEEK_API_KEY', mode: 'coding' },
] as const;
type ScriptContracts = NonNullable<Parameters<typeof restructuredContractInput>[2]>;
interface Capture { externalCalls: number; checkpoints: { id: string; input: FrozenInput; scriptContracts?: ScriptContracts }[] }
interface Manifest {
  revision: string; limits: typeof LIMITS; cells: typeof CELLS; captureHash: string;
  sources: Record<string, string>; rates: Record<string, unknown>; protocol: Record<string, string>;
}
interface Qualification {
  reviewer: string; manifestHash: string; l2FinalReviewFile: string; l2FinalReviewSha256: string;
  allowSmoke: boolean; negativeBlocker: boolean; cells: string[]; reason: string;
  sourceChanges: SourceChange[];
  deepseekReviewFile: string; deepseekReviewSha256: string;
}
interface SourceChange { source: string; before: string; after: string; reason: string }
/** Historical GLM/Kimi generation is reused only when candidate/provider/production bytes are unchanged. */
export function assertReusedL2SourceChange(source: string, before: string, after: string | undefined, changes: SourceChange[]): void {
  const allowed = ['tests/restructured-contract.eval.ts', 'tests/shared-contract-natural-smoke.eval.ts',
    'tests/shared-contract-natural-smoke.eval.test.ts', 'tests/shared-contract-natural-runtime.ts', 'tests/shared-contract-natural-runtime.test.ts'];
  const change = changes.find(item => item.source === source);
  if (!allowed.includes(source.replaceAll('\\', '/')) || !change || change.before !== before || change.after !== after || !change.reason.trim()) {
    throw new Error(`L2/source mismatch: ${source}`);
  }
}
const read = async <T>(file: string): Promise<T> => JSON.parse(await fs.readFile(file, 'utf8')) as T;
const save = (file: string, value: unknown, exclusive = false) => fs.writeFile(file, JSON.stringify(value, null, 2), exclusive ? { flag: 'wx' } : undefined);
const hashFile = async (file: string) => createHash('sha256').update(await fs.readFile(file)).digest('hex');
function assertTemp(directory: string): void {
  const relative = path.relative(os.tmpdir(), path.resolve(directory));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Use a child directory of OS Temp');
}
function redact(error: unknown): string {
  let message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  for (const cell of CELLS) { const secret = process.env[cell.env]; if (secret) message = message.replaceAll(secret, '[REDACTED]'); }
  return message;
}

export function validateSmokeCapture(value: unknown): Capture {
  const captured = value as Capture | null;
  if (!captured || captured.externalCalls !== 0) throw new Error('Expected offline capture');
  const ids = ['agent', 'coding', 'script'].flatMap(mode => ['symptom-repair', 'verification-followup'].map(id => `${mode}-${id}`));
  if (!Array.isArray(captured.checkpoints) || inputHash(captured.checkpoints.map(item => item.id).sort()) !== inputHash(ids.sort())) throw new Error('Expected exactly six natural checkpoints');
  for (const checkpoint of captured.checkpoints) {
    if (!checkpoint.input || typeof checkpoint.input.system !== 'string' || !Array.isArray(checkpoint.input.messages)
      || !Array.isArray(checkpoint.input.tools)) throw new Error('Invalid checkpoint input');
    const entry = checkpoint.input.tools.find(tool => tool.name === 'script_exec');
    if (checkpoint.id.startsWith('script-')) {
      const contracts = checkpoint.scriptContracts;
      if (!entry || !contracts || !Array.isArray(contracts.leaves) || inputHash(entry) !== inputHash(contracts.entry)
        || entry.description !== buildScriptModelDescription(contracts.leaves)) throw new Error('Invalid structured Script capture');
    } else if (entry || checkpoint.scriptContracts) throw new Error('Script metadata in native checkpoint');
  }
  return captured;
}

export function projectNaturalSmokeInput(original: FrozenInput, kind: 'root' | 'child' | 'auxiliary', mode: 'agent' | 'coding' | 'script', script?: ScriptContracts): FrozenInput {
  if (kind !== 'root') return original;
  const entry = original.tools.find(tool => tool.name === 'script_exec');
  if (mode === 'script' && (!entry || !script || inputHash(entry) !== inputHash(script.entry)
    || entry.description !== buildScriptModelDescription(script.leaves))) throw new Error('Live Script contracts differ from frozen structured capture');
  if (mode !== 'script' && entry) throw new Error('Live tool menu differs from registered mode');
  const candidate = restructuredContractInput(original, true, mode === 'script' ? script : undefined);
  if (candidate === original || candidate.system === original.system) throw new Error('Candidate did not project eligible root');
  const shape = (input: FrozenInput) => input.tools.map(tool => ({ name: tool.name, input_schema: tool.input_schema }));
  if (inputHash(candidate.messages) !== inputHash(original.messages) || inputHash(shape(candidate)) !== inputHash(shape(original))) throw new Error('Candidate changed history, tool names or schema');
  return candidate;
}

async function sourceHashes(): Promise<Record<string, string>> {
  const files = ['package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.test.json', 'benchmark/EVAL_GUIDELINES.md'];
  for (const directory of ['src', 'packages', 'tests', 'benchmark/datasets/shared-contract-natural', 'benchmark/datasets/search-entry-complex', 'benchmark/datasets/tool-entry-complex']) {
    files.push(...(await fs.readdir(directory, { recursive: true })).filter(file => /\.(?:ts|tsx|json|js|mjs|md|txt|sql|wasm)$/.test(file)
      && !/(?:^|[/\\])(?:node_modules|dist)(?:[/\\]|$)/.test(file)).map(file => path.join(directory, file)));
  }
  return Object.fromEntries(await Promise.all(files.sort().map(async file => [file, await hashFile(file)])));
}
async function prepare(root: string, captureFile: string): Promise<void> {
  assertTemp(captureFile);
  const capture = validateSmokeCapture(await read(captureFile));
  const sources = await sourceHashes();
  for (const mode of ['agent', 'coding'] as const) {
    const checkpoint = capture.checkpoints.find(item => item.id === `${mode}-symptom-repair`)!;
    projectNaturalSmokeInput(checkpoint.input, 'root', mode, checkpoint.scriptContracts);
  }
  await fs.mkdir(root, { recursive: false });
  for (const file of Object.keys(sources)) {
    const target = path.join(root, 'frozen-source', file);
    await fs.mkdir(path.dirname(target), { recursive: true }); await fs.copyFile(file, target);
    if (await hashFile(target) !== sources[file]) throw new Error(`Source changed while freezing: ${file}`);
  }
  if (inputHash(await sourceHashes()) !== inputHash(sources)) throw new Error('Sources changed during preparation');
  const manifest: Manifest = { revision: REVISION, limits: LIMITS, cells: CELLS, sources, captureHash: inputHash(capture),
    rates: Object.fromEntries(CELLS.map(cell => [cell.id, getCostRate(cell.provider, cell.model)])), protocol: {
      layer: 'L3.5 candidate-only observational smoke; at most three Runs, not a causal prompt comparison or non-inferiority proof.',
      purpose: 'L1 proves executable boundaries; L2 next responses cannot establish end-to-end repair, testing, rejection recovery and AMA closure.',
      task: 'Natural symptom-repair from the fixed local-log-inspired fixture. Public files are available; hidden oracle runs only after model completion.',
      execution: 'Only root shared teaching is projected. Child/auxiliary unchanged. Original arguments/results and real Runtime guardrails unchanged.',
      calls: 'Per Run root+child+auxiliary share 32 calls, 80 tools, 600s, 1.2M tokens, USD0.30 reference. Three-case maximum: 96 calls, 3.6M tokens, USD0.90 reference.',
      concurrency: 'Manual one-cell launch only; providers may run concurrently, one lane per provider. Three independent native cells: GLM Agent, Kimi Coding, DeepSeek Coding. This is not a full provider-by-mode matrix. No retries/fallback or reruns after start.',
      judgment: 'Manual final L2 review and explicit no-negative-blocker qualification are mandatory. Assess task correctness, truthful evidence, refusals/recovery, AMA terminal state, rounds, whole-task tokens, reference cost and time; completion alone is not quality.',
    } };
  await save(path.join(root, 'capture.json'), capture, true); await save(path.join(root, 'manifest.json'), manifest, true);
  process.stdout.write(JSON.stringify({ prepared: root, manifestHash: inputHash(manifest), paidCalls: 0 }) + '\n');
}

async function qualification(root: string, manifest: Manifest, cellId: string, file: string, sha256: string): Promise<Qualification> {
  assertTemp(file);
  if (await hashFile(file) !== sha256) throw new Error('Exact qualification file SHA256 required');
  const value = await read<Qualification>(file);
  if (value.reviewer !== 'main-session' || value.manifestHash !== inputHash(manifest) || value.allowSmoke !== true
    || value.negativeBlocker !== false || !Array.isArray(value.cells) || !value.cells.includes(cellId)
    || value.cells.some(id => !CELLS.some(cell => cell.id === id)) || typeof value.reason !== 'string' || !value.reason.trim()) throw new Error('Explicit manual L2 qualification required; no automatic quality gate');
  assertTemp(value.l2FinalReviewFile);
  if (path.basename(value.l2FinalReviewFile) !== 'final-review.json' || await hashFile(value.l2FinalReviewFile) !== value.l2FinalReviewSha256) throw new Error('L2 final review missing or changed');
  const l2 = path.dirname(value.l2FinalReviewFile);
  const final = await read<{ review: unknown; evidenceHash: string }>(value.l2FinalReviewFile);
  const pairs = ['glm', 'kimi'].flatMap(route => ['agent', 'coding', 'script'].flatMap(mode => ['symptom-repair', 'verification-followup'].map(id => ({ route, caseId: `${mode}-${id}` }))));
  assertSemanticReview(final.review, pairs, false);
  if (final.evidenceHash !== inputHash(await read(path.join(l2, 'final-blind.json')))) throw new Error('L2 reviewed evidence changed');
  const l2Manifest = await read<{ revision: string; sourceHashes: Record<string, string>; cellsHash: string; mappingHash: string }>(path.join(l2, 'manifest.json'));
  if (l2Manifest.revision !== 'shared-natural-r1-20261027') throw new Error('Wrong L2 qualification revision');
  for (const [source, hash] of Object.entries(l2Manifest.sourceHashes)) {
    if (manifest.sources[source] === hash) continue;
    assertReusedL2SourceChange(source, hash, manifest.sources[source], value.sourceChanges ?? []);
  }
  if (l2Manifest.cellsHash !== inputHash(await read(path.join(l2, 'cells.json')))
    || l2Manifest.mappingHash !== inputHash(await read(path.join(l2, 'mapping.private.json')))) throw new Error('L2 frozen inputs/mapping changed');
  assertTemp(value.deepseekReviewFile);
  if (path.basename(value.deepseekReviewFile) !== 'final-review.json' || await hashFile(value.deepseekReviewFile) !== value.deepseekReviewSha256) throw new Error('Current DeepSeek review missing or changed');
  const dsRoot = path.dirname(value.deepseekReviewFile);
  const dsReview = await read<{ review: unknown; evidenceHash: string }>(value.deepseekReviewFile);
  assertSemanticReview(dsReview.review, ['agent', 'coding'].map(mode => ({ route: 'deepseek', caseId: `${mode}-symptom-repair` })), false);
  if (dsReview.evidenceHash !== inputHash(await read(path.join(dsRoot, 'final-blind.json')))) throw new Error('DeepSeek evidence changed');
  const dsManifest = await read<typeof l2Manifest>(path.join(dsRoot, 'manifest.json'));
  if (dsManifest.revision !== 'native-deepseek-r1-20261027') throw new Error('Wrong DeepSeek revision');
  for (const [source, hash] of Object.entries(dsManifest.sourceHashes)) {
    if (manifest.sources[source] !== hash) throw new Error(`Current DeepSeek/source mismatch: ${source}`);
  }
  if (dsManifest.cellsHash !== inputHash(await read(path.join(dsRoot, 'cells.json')))
    || dsManifest.mappingHash !== inputHash(await read(path.join(dsRoot, 'mapping.private.json')))) throw new Error('DeepSeek inputs/mapping changed');
  await save(path.join(root, `${cellId}-qualification.json`), { file, sha256, qualification: value }, true);
  return value;
}

async function run(root: string, id: string, manifestHash: string, qualificationFile: string, qualificationHash: string): Promise<void> {
  const cell = CELLS.find(item => item.id === id); if (!cell) throw new Error('Select one of glm-agent | kimi-coding | deepseek-coding');
  const manifest = await read<Manifest>(path.join(root, 'manifest.json'));
  if (inputHash(manifest) !== manifestHash || manifest.revision !== REVISION || inputHash(manifest.limits) !== inputHash(LIMITS)
    || inputHash(manifest.cells) !== inputHash(CELLS)) throw new Error('Exact frozen manifest/limits/mapping required');
  if (inputHash(await sourceHashes()) !== inputHash(manifest.sources)) throw new Error('Current sources changed after freeze');
  for (const [file, hash] of Object.entries(manifest.sources)) if (await hashFile(path.join(root, 'frozen-source', file)) !== hash) throw new Error(`Frozen source changed: ${file}`);
  const captured = validateSmokeCapture(await read(path.join(root, 'capture.json')));
  if (inputHash(captured) !== manifest.captureHash) throw new Error('Capture changed');
  const script = captured.checkpoints.find(item => item.id === 'script-symptom-repair')!.scriptContracts!;
  const rate = getCostRate(cell.provider, cell.model);
  if (!rate || !process.env[cell.env] || !getProviderModels(cell.provider).includes(cell.model)
    || inputHash(rate) !== inputHash(manifest.rates[cell.id])) throw new Error(`Unavailable or changed route: ${cell.id}`);
  const lanePath = path.join(root, `${cell.provider}.lock`);
  const lane = await fs.open(lanePath, 'wx');
  try {
    await qualification(root, manifest, cell.id, qualificationFile, qualificationHash);
    await save(path.join(root, `${cell.id}-started.json`), { at: new Date().toISOString(), manifestHash, qualificationHash }, true);
    const directory = path.join(root, cell.id); await fs.mkdir(directory, { recursive: false });
    const budget = { calls: 0, chargedTokens: 0, chargedUsd: 0, reservedTokens: 0, reservedUsd: 0, unknownUsageCalls: 0, stopped: false };
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(new Error('Natural smoke total timeout')), LIMITS.timeoutMs);
    try {
      const record = await runNaturalRuntime(directory, 'symptom-repair', async (original, signal, index, meta) => {
        signal.throwIfAborted();
        if (budget.stopped) throw new Error('No request after terminal budget/accounting failure');
        const input = projectNaturalSmokeInput(original, meta.kind, cell.mode, script);
        const outputCap = Math.min(LIMITS.output, meta.streamOptions?.maxOutputTokensOverride ?? LIMITS.output);
        const reservedInput = Buffer.byteLength(JSON.stringify(input)) + 4096;
        const reservedTokens = reservedInput + outputCap; const reservedUsd = calculateCost(rate, reservedInput, outputCap);
        if (!Number.isInteger(outputCap) || outputCap < 1 || budget.calls >= LIMITS.calls
          || budget.chargedTokens + budget.reservedTokens + reservedTokens > LIMITS.tokens
          || budget.chargedUsd + budget.reservedUsd + reservedUsd > LIMITS.usd) {
          budget.stopped = true; abort.abort(new Error('Hard smoke budget exhausted')); throw abort.signal.reason;
        }
        budget.calls++; budget.reservedTokens += reservedTokens; budget.reservedUsd += reservedUsd;
        const file = path.join(directory, `call-${index}`);
        await save(file + '.input.json', { originalInputHash: inputHash(original), inputHash: inputHash(input), input, kind: meta.kind,
          reasoning: meta.reasoning, streamOptions: meta.streamOptions, outputCap, model: cell.model }, true);
        await save(path.join(directory, 'ledger.json'), budget);
        signal.throwIfAborted(); abort.signal.throwIfAborted();
        const facts: ProviderRequestObservation[] = []; const started = Date.now();
        let result: KodaXStreamResult | undefined; let error: string | null = null;
        const requestSignal = AbortSignal.any([signal, abort.signal, AbortSignal.timeout(LIMITS.requestMs)]);
        try {
          result = await runWithAdditionalProviderRequestObserver(fact => facts.push(fact), () => observeProviderOperation(cell.provider,
            meta.kind === 'auxiliary' ? 'sidecar' : 'primary', currentProviderRequestAttribution(),
            () => getProvider(cell.provider).stream([...input.messages], [...input.tools], input.system, meta.reasoning,
              { ...meta.streamOptions, modelOverride: cell.model, maxOutputTokensOverride: outputCap, singleAttempt: true }, requestSignal), undefined, requestSignal));
        } catch (cause) { error = redact(cause); }
        const usage = result?.usage;
        const cost = usage ? calculateCost(rate, usage.inputTokens, usage.outputTokens, usage.cachedReadTokens ?? 0, usage.cachedWriteTokens ?? 0) : undefined;
        const settlement = settleComplexAttempt({ reservedTokens, reservedUsd, facts, tools: input.tools.map(tool => tool.name), reasoning: meta.reasoning,
          outputCap, requestCancelled: signal.aborted, taskCancelled: meta.taskSignal?.aborted ?? abort.signal.aborted, failed: error !== null, actualUsd: cost });
        budget.reservedTokens -= reservedTokens; budget.reservedUsd -= reservedUsd;
        budget.chargedTokens += settlement.chargedTokens; budget.chargedUsd += settlement.chargedUsd;
        if (settlement.unknownUsage) budget.unknownUsageCalls++;
        if (settlement.stop) { budget.stopped = true; error ??= 'Physical attempt/usage verification failed'; abort.abort(new Error(error)); }
        await save(file + '.json', { result, usage: usage ?? null, referenceUsd: cost ?? null, error, facts, settlement, wallMs: Date.now() - started }, true);
        await save(path.join(directory, 'ledger.json'), budget);
        if (error || !result) throw new Error(error ?? 'Provider returned no result');
        return result;
      }, { workMode: cell.mode, model: cell.model,
        limits: { calls: LIMITS.calls, tools: LIMITS.tools, timeoutMs: LIMITS.timeoutMs },
        signal: abort.signal, maxOutputTokens: LIMITS.output,
        reasoning: cell.provider === 'kimi-code' ? 'auto' : 'off', effort: cell.provider === 'kimi-code' ? 'low' : 'none' });
      await save(path.join(directory, 'summary.json'), { kind: 'L3.5-observation-not-causal-comparison', cell, manifestHash, qualificationHash,
        phase: record.phase, success: record.success, error: record.error, counts: record.counts, wallMs: record.wallMs, budget,
        protectedUnchanged: record.protectedUnchanged, verification: record.verification }, true);
      process.stdout.write(JSON.stringify({ cell: cell.id, directory, phase: record.phase, calls: budget.calls, wallMs: record.wallMs }) + '\n');
    } catch (cause) { abort.abort(cause); await save(path.join(directory, 'driver-error.json'), { error: redact(cause), budget }, true); throw new Error(redact(cause)); }
    finally { clearTimeout(timer); }
  } finally { await lane.close(); await fs.unlink(lanePath); }
}

async function main(args: string[]): Promise<void> {
  if (publicAttribution !== runWithProviderRequestAttribution) throw new Error('Set TSX_TSCONFIG_PATH=tsconfig.test.json; mixed src/dist registries are forbidden');
  const [command, ...rest] = args; const options = new Map<string, string>();
  const allowed = new Set(['out', 'capture', 'cell', 'manifest', 'qualification', 'qualification-hash']);
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index]?.slice(2);
    if (!rest[index]?.startsWith('--') || !name || !allowed.has(name) || options.has(name) || !rest[index + 1]) throw new Error('Use unique --name value arguments');
    options.set(name, rest[index + 1]!);
  }
  const root = path.resolve(options.get('out') ?? ''); assertTemp(root);
  if (command === 'prepare') await prepare(root, options.get('capture') ?? '');
  else if (command === 'run') await run(root, options.get('cell') ?? '', options.get('manifest') ?? '', options.get('qualification') ?? '', options.get('qualification-hash') ?? '');
  else throw new Error('Use prepare or run for one explicitly selected cell; importing never calls models');
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await main(process.argv.slice(2)); } catch (cause) { process.stderr.write(redact(cause) + '\n'); process.exitCode = 1; }
}
