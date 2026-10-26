/** Manual L2 tools-only experiment: prepare → pilot → blind review → remaining → review → reveal.
 * Never executes model-selected tools. Raw inputs, mapping and accounting stay in OS Temp.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomInt } from 'node:crypto';
import { getProvider, getProviderModels, getCostRate, calculateCost } from '../packages/llm/src/index.js';
import type { KodaXStreamResult, KodaXToolDefinition } from '../packages/llm/src/types.js';
import { observeProviderOperation, runWithProviderRequestObserver, type ProviderRequestObservation } from '../packages/llm/src/provider-request-observation.js';
import { buildWorkerActorCapacityContract, buildWorkerRoutingContext } from '../packages/coding/src/agents/worker-role-prompt.js';
import { buildFallbackRoutingDecision } from '../packages/coding/src/reasoning.js';
import { FirstTurnBudget, inputHash, firstTurnReasoningFor, type BudgetSnapshot, type FrozenInput } from './first-turn-eval-support.js';
import { semanticProbeEvidence } from './compact-teaching-eval-support.js';
import { prepareContractFixture } from './first-turn-compact-contract-fixture.js';

// Separate from the historical 33-tool experiment; its frozen inputs/results remain in OS Temp.
const REVISION = 'worker-teaching-dedup-r1';
const LIMITS = { calls: 12, perCell: 1, rounds: 1, output: 8192, tokens: 500_000, usd: 1, timeoutMs: 180_000 };
const PROTOCOL = {
  layer: 'L2',
  question: 'Does production tool-description compression preserve valid next-action parameters, bounded collaboration, known-state interaction and legitimate refusal recovery?',
  whyNotOfflineOnly: 'Schema/permission equivalence is offline-testable; model interpretation of shorter tool teaching is not.',
  sample: 'One observation per arm/case/model. Eight pilot cells; main-session task-validity review may stop without expanding. At most ten remaining cells, never retries.',
  value: 'Preserve useful legal actions and ownership; avoid discovery, redundant state reads/questions, forbidden-operation aliases and stale-edit retries. Judge necessary reconnaissance semantically.',
  attribution: ['eval-design', 'provider-noise', 'prompt-regression', 'inconclusive'],
  decision: 'Main-session blind review records validity, lift/harm, attribution and recommendation in reasons before revealing labels or efficiency. No automatic ship gate.',
  limits: 'Single-response evidence cannot prove unchanged total-task quality, turns or time. Usage and reference prices are revealed only after review. Reuse existing offline/runtime E2E evidence for those properties.',
};
const ROUTES = [
  { id: 'glm', provider: 'zhipu-coding', model: 'glm-5.3', env: 'ZHIPU_CODING_API_KEY' },
  { id: 'kimi', provider: 'kimi-code', model: 'kimi-for-coding', env: 'KIMI_CODE_API_KEY' },
  { id: 'deepseek', provider: 'deepseek', model: 'deepseek-flash', env: 'DEEPSEEK_API_KEY' },
] as const;
type Pair = { route: string; caseId: string };
type Cell = Pair & { arm: 'A' | 'B'; input: FrozenInput };
type Review = { reviewer: 'main-session'; allowRemaining?: boolean; judgments: (Pair & { preferred: string; reason: string })[] };
interface Manifest { revision: string; limits: typeof LIMITS; cellsHash: string; mappingHash: string; casesHash: string;
  protocol: typeof PROTOCOL; sourceHashes: Record<string, string>; rates: Record<string, unknown>; captures: { baseline: string; candidate: string } }
interface Row { text: string; toolCalls: KodaXStreamResult['toolBlocks']; thinking: KodaXStreamResult['thinkingBlocks'];
  stopReason: KodaXStreamResult['stopReason'] | null; error: string | null; durationMs: number;
  usage: KodaXStreamResult['usage'] | null; referenceUsd: number | null; physicalAttempts: number;
  chargedTokens: number; chargedUsd: number; conservative: boolean; reservedTokens: number; reservedUsd: number }
const rawHash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const read = async <T>(file: string): Promise<T> => JSON.parse(await fs.readFile(file, 'utf8')) as T;
const save = (file: string, value: unknown, exclusive = false) => fs.writeFile(file, JSON.stringify(value, null, 2), exclusive ? { flag: 'wx' } : undefined);
const exists = (file: string) => fs.stat(file).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error; });
const key = (cell: Cell) => `${cell.route}-${cell.caseId}-${cell.arm}`;
const pairKey = (pair: Pair) => `${pair.route}/${pair.caseId}`;
const pairsFor = (cells: Cell[]) => [...new Map(cells.map(cell => [pairKey(cell), { route: cell.route, caseId: cell.caseId }])).values()];
export const isPilotCell = (cell: Pair): boolean => cell.route !== 'deepseek' && cell.caseId === 'collaboration';

/** Preserve schema business keys named description, and literal enum/default data. */
function stripDescriptions(value: unknown, propertyMap = false): unknown {
  if (Array.isArray(value)) return value.map(item => stripDescriptions(item));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([name]) => propertyMap || name !== 'description').map(([name, child]) =>
    [name, !propertyMap && ['const', 'enum', 'default', 'examples'].includes(name) ? child
      : stripDescriptions(child, !propertyMap && ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'].includes(name))]));
}
export function assertToolsOnlyPair(baseline: FrozenInput, candidate: FrozenInput): void {
  if (baseline.system !== candidate.system || inputHash(baseline.messages) !== inputHash(candidate.messages)) throw new Error('Worker/system/history changed: not tools-only');
  const shape = (input: FrozenInput) => input.tools.map(tool => ({ name: tool.name, schema: stripDescriptions(tool.input_schema) }));
  if (inputHash(shape(baseline)) !== inputHash(shape(candidate))) throw new Error('Tool menu or executable schema changed: not annotation-only');
  if (inputHash(baseline.tools) === inputHash(candidate.tools)) throw new Error('No tool-text intervention');
}
export function assertSemanticReview(value: unknown, pairs: Pair[], pilot: boolean): asserts value is Review {
  const review = value as Partial<Review> | null;
  if (!review || review.reviewer !== 'main-session' || !Array.isArray(review.judgments)
    || (pilot && typeof review.allowRemaining !== 'boolean')) throw new Error('Main-session semantic review required');
  const expected = new Set(pairs.map(pairKey));
  if (review.judgments.length !== expected.size) throw new Error('Review must cover every registered pair, including missing evidence');
  for (const judgment of review.judgments) {
    if (!judgment || !expected.delete(pairKey(judgment)) || !['A', 'B', 'tie', 'mixed', 'inconclusive', 'eval-invalid'].includes(judgment.preferred)
      || typeof judgment.reason !== 'string' || !judgment.reason.trim()) throw new Error('Invalid, duplicate or unexplained judgment');
  }
}
function assertTemp(root: string): void {
  const relative = path.relative(os.tmpdir(), root);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Raw output must be a new child directory of OS Temp');
}

async function prepare(root: string, baseline: string, candidate: string) {
  if (!baseline || !candidate) throw new Error('Explicit --baseline and --candidate capture directories required');
  await fs.mkdir(root, { recursive: false });
  const fixture = await prepareContractFixture(root);
  const selected = [['P03', 'collaboration'], ['C01', 'closure']] as const;
  const cases = selected.map(([id, name]) => ({ ...fixture.cases.find(item => item.id === id)!, id: name, mode: 'agent' as const, rounds: 1 }));
  cases[1]!.rubric = 'Next response should integrate current delivered evidence and complete the known todo_2. No redundant list/read/output/wait, re-created plan, new delegation or repeated tests. Do not require the final text-only response before the update receipt; this L2 checkpoint does not measure full closure.';
  const capturePaths = [baseline, candidate].map(directory => path.resolve(directory, 'openai-agent-runtime-host/normalized-model-input.json'));
  const captures = await Promise.all(capturePaths.map(file => read<{ messages: { role: string; content: string }[];
    tools: { function: { name: string; description: string; parameters: KodaXToolDefinition['input_schema'] } }[] }>(file)));
  if (inputHash(captures[0]!.messages) !== inputHash(captures[1]!.messages)) throw new Error('Captured system/history differs; do not splice Worker compression');
  const toolsFor = (index: number) => captures[index]!.tools.map(({ function: tool }) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }));
  const system = captures[0]!.messages.find(message => message.role === 'system')?.content;
  const originalContext = captures[0]!.messages[1]?.content;
  if (!system || !originalContext?.includes('=== End Managed Run Context ===') || !originalContext.includes('ACTOR CAPACITY')) throw new Error('Missing complete production managed context');
  const cells: Cell[] = []; const mapping: (Pair & { A: string; B: string })[] = [];
  for (const route of ROUTES) for (const scenario of cases) {
    let context = originalContext.replace(/<FIXTURE_ROOT>[^\r\n]*<SESSION_ID>/g, path.join(fixture.workspace, '.agent', 'tmp', 'sessions', 'managed-tools'));
    context = context.replace(/You are the Worker[\s\S]*?(?=\n\nProject:)/, buildWorkerRoutingContext(buildFallbackRoutingDecision(scenario.task)));
    context = context.replace(/ACTOR CAPACITY[\s\S]*?(?=\n\nYou are the Worker)/,
      buildWorkerActorCapacityContract({ maxConcurrentThreads: 4, activeNonRootTurns: scenario.id === 'collaboration' ? 1 : 0 }, toolsFor(0).map(tool => tool.name))!);
    context = context.replace('=== End Managed Run Context ===', `## Controlled checkpoint\n${scenario.state}\n=== End Managed Run Context ===`);
    const base: FrozenInput = { system, tools: toolsFor(0), messages: [{ role: 'user', content: context, _synthetic: true }, { role: 'user', content: scenario.task }, ...scenario.history] };
    const next: FrozenInput = { ...base, tools: toolsFor(1) };
    assertToolsOnlyPair(base, next);
    const reverse = randomInt(2) === 1;
    mapping.push({ route: route.id, caseId: scenario.id, A: reverse ? 'candidate' : 'baseline', B: reverse ? 'baseline' : 'candidate' });
    for (const [index, input] of (reverse ? [next, base] : [base, next]).entries()) cells.push({ route: route.id, caseId: scenario.id, arm: index === 0 ? 'A' : 'B', input });
  }
  const inventory = await read<{ sourceHashes: Record<string, string> }>(path.join(candidate, 'inventory.json'));
  const sourceHashes = { ...inventory.sourceHashes };
  for (const [file, hash] of Object.entries(sourceHashes)) if (rawHash(await fs.readFile(file)) !== hash) throw new Error(`Stale candidate source: ${file}`);
  const sources = [...capturePaths, path.resolve(candidate, 'inventory.json'), 'tests/managed-tool-contract.eval.ts', 'tests/first-turn-eval-support.ts',
    'tests/compact-teaching-eval-support.ts', 'tests/first-turn-compact-contract-fixture.ts', 'tests/first-turn-compact-contract-cases.ts',
    'tests/first-turn-complex-guard.ts', 'benchmark/EVAL_GUIDELINES.md', 'package-lock.json'];
  for (const base of ['packages/llm/src', 'packages/coding/src/agents']) sources.push(...(await fs.readdir(base, { recursive: true })).filter(file => file.endsWith('.ts')).map(file => path.join(base, file)));
  for (const file of sources) sourceHashes[file] = rawHash(await fs.readFile(file));
  const manifest: Manifest = { revision: REVISION, limits: LIMITS, protocol: PROTOCOL, cellsHash: inputHash(cells), mappingHash: inputHash(mapping), casesHash: inputHash(cases), sourceHashes,
    rates: Object.fromEntries(ROUTES.map(route => [route.id, getCostRate(route.provider, route.model)])), captures: { baseline, candidate } };
  await save(path.join(root, 'cells.json'), cells, true); await save(path.join(root, 'mapping.json'), mapping, true);
  await save(path.join(root, 'cases.json'), cases, true); await save(path.join(root, 'manifest.json'), manifest, true);
  await save(path.join(root, 'budget.json'), new FirstTurnBudget(undefined, LIMITS.calls).state, true);
  process.stdout.write(JSON.stringify({ directory: root, manifestHash: inputHash(manifest), externalCalls: 0, pilotCalls: 4, remainingCalls: 8 }) + '\n');
}

async function loadFrozen(root: string, suppliedHash?: string) {
  const manifest = await read<Manifest>(path.join(root, 'manifest.json'));
  if (suppliedHash !== inputHash(manifest) || manifest.revision !== REVISION || inputHash(manifest.limits) !== inputHash(LIMITS)) throw new Error('Exact --manifest hash required');
  const cells = await read<Cell[]>(path.join(root, 'cells.json'));
  if (inputHash(cells) !== manifest.cellsHash || cells.length !== LIMITS.calls || new Set(cells.map(key)).size !== LIMITS.calls) throw new Error('Frozen cells changed');
  if (inputHash(await read(path.join(root, 'mapping.json'))) !== manifest.mappingHash || inputHash(await read(path.join(root, 'cases.json'))) !== manifest.casesHash) throw new Error('Frozen cases/mapping changed');
  for (const [file, hash] of Object.entries(manifest.sourceHashes)) if (rawHash(await fs.readFile(file)) !== hash) throw new Error(`Source changed: ${file}`);
  return { manifest, cells };
}
async function blind(root: string, cells: Cell[], phase: string) {
  const rows = await Promise.all(cells.map(async cell => ({ route: cell.route, caseId: cell.caseId, arm: cell.arm,
    evidence: await exists(path.join(root, `${key(cell)}.json`)) ? semanticProbeEvidence((await read<{ row: Row }>(path.join(root, `${key(cell)}.json`))).row) : null })));
  const cases = await read<Awaited<ReturnType<typeof prepareContractFixture>>['cases']>(path.join(root, 'cases.json'));
  const value = { phase, cases, rows };
  await save(path.join(root, `${phase}-blind.json`), value);
  return value;
}
async function run(root: string, phase: string, hash?: string) {
  if (!['pilot', 'remaining'].includes(phase)) throw new Error('--phase must be pilot or remaining');
  const { manifest, cells } = await loadFrozen(root, hash);
  if (await exists(path.join(root, 'revealed.json')) || await exists(path.join(root, 'final-review.json')) || await exists(path.join(root, 'stopped.json'))) throw new Error('Experiment already finalized or stopped; no reruns');
  if (phase === 'remaining') {
    const approval = await read<{ review: Review; evidenceHash: string }>(path.join(root, 'pilot-review.json'));
    assertSemanticReview(approval.review, pairsFor(cells.filter(isPilotCell)), true);
    if (!approval.review.allowRemaining || approval.evidenceHash !== inputHash(await blind(root, cells.filter(isPilotCell), 'pilot'))) throw new Error('Unchanged blind pilot review permitting continuation required');
    for (const cell of cells.filter(isPilotCell)) if (!await exists(path.join(root, `${key(cell)}.json`))) throw new Error('Incomplete pilot; do not continue');
  }
  const selected = cells.filter(cell => isPilotCell(cell) === (phase === 'pilot'));
  for (const route of ROUTES.filter(route => selected.some(cell => cell.route === route.id))) {
    if (!process.env[route.env] || !getProviderModels(route.provider).includes(route.model) || !getCostRate(route.provider, route.model)
      || inputHash(getCostRate(route.provider, route.model)) !== inputHash(manifest.rates[route.id])) throw new Error(`Unavailable or changed route: ${route.id}`);
  }
  const budget = new FirstTurnBudget(await read<BudgetSnapshot>(path.join(root, 'budget.json')), LIMITS.calls);
  if (budget.state.reservedTokens !== 0 || budget.state.unknownUsageCalls !== 0) throw new Error('Interrupted or unknown accounting; do not resume');
  const lock = await fs.open(path.join(root, 'run.lock'), 'wx');
  let stopped = false; let persistence = Promise.resolve();
  const persist = () => { const snapshot = structuredClone(budget.state); persistence = persistence.then(() => save(path.join(root, 'budget.json'), snapshot)); return persistence; };
  try {
    await save(path.join(root, `${phase}-started.json`), { at: new Date().toISOString() }, true);
    const lanes = await Promise.allSettled(ROUTES.map(async route => {
      try {
      for (const cell of selected.filter(cell => cell.route === route.id)) {
        if (stopped) break;
        const rate = getCostRate(route.provider, route.model)!;
        const reservedInput = Buffer.byteLength(JSON.stringify(cell.input)) + 4096;
        const reservedTokens = reservedInput + LIMITS.output;
        const reservedUsd = calculateCost(rate, reservedInput, LIMITS.output);
        if (budget.state.chargedTokens + budget.state.reservedTokens + reservedTokens > LIMITS.tokens
          || budget.state.chargedUsd + budget.state.reservedUsd + reservedUsd > LIMITS.usd) { stopped = true; await save(path.join(root, 'stopped.json'), { reason: 'Conservative budget exhausted' }); break; }
        // Reserve synchronously before yielding, so concurrent provider lanes see each other.
        budget.reserve(reservedTokens, reservedUsd);
        await save(path.join(root, `${key(cell)}-started.json`), { at: new Date().toISOString(), reservedTokens, reservedUsd }, true);
        await persist();
        const facts: ProviderRequestObservation[] = []; const started = Date.now();
        let result: KodaXStreamResult | undefined; let error: string | null = null;
        try {
          const signal = AbortSignal.timeout(LIMITS.timeoutMs);
          result = await runWithProviderRequestObserver(fact => facts.push(fact), () => observeProviderOperation(route.provider, 'utility', undefined,
            () => getProvider(route.provider).stream([...cell.input.messages], [...cell.input.tools], cell.input.system, firstTurnReasoningFor(route.provider),
              { modelOverride: route.model, maxOutputTokensOverride: LIMITS.output, singleAttempt: true }, signal), undefined, signal));
        } catch (cause: unknown) {
          error = cause instanceof Error ? cause.message : String(cause);
          for (const item of ROUTES) { const secret = process.env[item.env]; if (secret) error = error.replaceAll(secret, '[REDACTED]'); }
        }
        const attempts = new Set(facts.filter(fact => fact.boundary === 'physical_attempt' && fact.state === 'started').map(fact => fact.requestId)).size;
        const usage = result?.usage;
        const known = !error && attempts === 1 && usage && Number.isFinite(usage.inputTokens) && usage.inputTokens >= 0
          && Number.isFinite(usage.outputTokens) && usage.outputTokens >= 0 && usage.totalTokens === usage.inputTokens + usage.outputTokens && usage.totalTokens > 0;
        const cost = known ? calculateCost(rate, usage.inputTokens, usage.outputTokens, usage.cachedReadTokens ?? 0, usage.cachedWriteTokens ?? 0) : undefined;
        const accounted = known && cost !== undefined && Number.isFinite(cost) && cost >= 0;
        budget.settle(reservedTokens, reservedUsd, accounted ? usage : undefined, accounted ? cost : undefined);
        if (Math.abs(budget.state.reservedUsd) < 1e-12) budget.state.reservedUsd = 0;
        if (!accounted) error ??= 'Unknown usage or physical attempt count';
        const row: Row = { text: result?.textBlocks.map(block => block.text).join('') ?? '', toolCalls: result?.toolBlocks ?? [], thinking: result?.thinkingBlocks ?? [],
          stopReason: result?.stopReason ?? null, error, durationMs: Date.now() - started, usage: usage ?? null, referenceUsd: cost ?? null, physicalAttempts: attempts,
          chargedTokens: accounted ? usage!.totalTokens : reservedTokens, chargedUsd: accounted ? cost! : reservedUsd, conservative: !accounted, reservedTokens, reservedUsd };
        const names = row.toolCalls.map(call => call.name);
        await save(path.join(root, `${key(cell)}.json`), { inputHash: inputHash(cell.input), row, facts,
          observations: { toolNames: names, todoReads: names.filter(name => name === 'todo_list').length, spawnCalls: names.filter(name => name === 'spawn_agent').length,
            questionCalls: names.filter(name => name === 'ask_user_question').length, mutationCalls: names.filter(name => ['edit', 'write', 'multi_edit'].includes(name)).length } }, true);
        await persist();
        if (error || row.stopReason === 'max_tokens' || (!row.text.trim() && !row.toolCalls.length)
          || budget.state.chargedTokens > LIMITS.tokens || budget.state.chargedUsd > LIMITS.usd) {
          stopped = true; await save(path.join(root, 'stopped.json'), { cell: key(cell), reason: error ?? 'Censored/empty response or budget exceeded; no retry' });
        }
        process.stdout.write(JSON.stringify({ route: cell.route, caseId: cell.caseId, arm: cell.arm, completed: true, stopped }) + '\n');
      }
      } catch (error: unknown) { stopped = true; throw error; }
    }));
    for (const lane of lanes) if (lane.status === 'rejected') { await save(path.join(root, 'stopped.json'), { reason: 'Lane/persistence failure; preserve raw, no resume' }); throw lane.reason; }
  } finally {
    await persist(); await blind(root, phase === 'pilot' ? cells.filter(isPilotCell) : cells, phase === 'pilot' ? 'pilot' : 'final');
    await lock.close(); await fs.unlink(path.join(root, 'run.lock'));
  }
}

async function review(root: string, phase: string, file: string) {
  if (!['pilot', 'final'].includes(phase) || !file) throw new Error('review requires --phase pilot|final --file main-session-review.json');
  if (await exists(path.join(root, 'run.lock')) || await exists(path.join(root, 'revealed.json'))) throw new Error('Cannot review during a run or after reveal');
  const cells = await read<Cell[]>(path.join(root, 'cells.json'));
  const selected = phase === 'pilot' ? cells.filter(isPilotCell) : cells;
  const value = await read<unknown>(file);
  assertSemanticReview(value, pairsFor(selected), phase === 'pilot');
  const evidence = await blind(root, selected, phase);
  await save(path.join(root, `${phase}-review.json`), { review: value, evidenceHash: inputHash(evidence), reviewedAt: new Date().toISOString() }, true);
  process.stdout.write(JSON.stringify({ reviewSaved: phase, allowRemaining: phase === 'pilot' ? value.allowRemaining : false }) + '\n');
}
async function reveal(root: string) {
  if (await exists(path.join(root, 'run.lock'))) throw new Error('Run is active');
  const cells = await read<Cell[]>(path.join(root, 'cells.json'));
  const reviewed = await read<{ review: Review; evidenceHash: string }>(path.join(root, 'final-review.json'));
  assertSemanticReview(reviewed.review, pairsFor(cells), false);
  if (reviewed.evidenceHash !== inputHash(await blind(root, cells, 'final'))) throw new Error('Blind evidence changed since semantic review');
  const manifest = await read<Manifest>(path.join(root, 'manifest.json'));
  const mapping = await read<unknown>(path.join(root, 'mapping.json'));
  if (inputHash(mapping) !== manifest.mappingHash || inputHash(cells) !== manifest.cellsHash) throw new Error('Frozen mapping/inputs changed');
  const accounting = await Promise.all(cells.map(async cell => ({ route: cell.route, caseId: cell.caseId, arm: cell.arm,
    row: await exists(path.join(root, `${key(cell)}.json`)) ? (await read<{ row: Row }>(path.join(root, `${key(cell)}.json`))).row : null })));
  await save(path.join(root, 'revealed.json'), { mapping, review: reviewed.review, accounting, budget: await read(path.join(root, 'budget.json')),
    limitations: 'One next-action observation/cell. Not an end-to-end quality or total-task turns estimate. Reference API pricing, not invoiced cost. No automatic ship decision.' }, true);
  process.stdout.write(JSON.stringify({ report: path.join(root, 'revealed.json') }) + '\n');
}
async function main(args: string[]) {
  const [command, ...rest] = args;
  const options = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    if (!rest[index]?.startsWith('--') || !rest[index + 1]) throw new Error('Use --name value arguments');
    options.set(rest[index]!.slice(2), rest[index + 1]!);
  }
  const root = path.resolve(options.get('out') ?? ''); assertTemp(root);
  if (command === 'prepare') await prepare(root, options.get('baseline') ?? '', options.get('candidate') ?? '');
  else if (command === 'run') await run(root, options.get('phase') ?? '', options.get('manifest'));
  else if (command === 'review') await review(root, options.get('phase') ?? '', options.get('file') ?? '');
  else if (command === 'reveal') await reveal(root);
  else throw new Error('Use prepare | run | review | reveal; no operation invokes models implicitly');
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main(process.argv.slice(2));
