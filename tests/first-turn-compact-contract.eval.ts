/** Manual, frozen L2/L3 experiment. No model-selected tool is executed. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomInt } from 'node:crypto';
import { getProvider, getProviderModels, getCostRate, calculateCost } from '../packages/llm/src/index.js';
import type { KodaXMessage, KodaXStreamResult, KodaXToolDefinition } from '../packages/llm/src/types.js';
import { observeProviderOperation, runWithProviderRequestObserver, type ProviderRequestObservation } from '../packages/llm/src/provider-request-observation.js';
import { buildWorkerActorCapacityContract, buildWorkerRoutingContext } from '../packages/coding/src/agents/worker-role-prompt.js';
import { buildFallbackRoutingDecision } from '../packages/coding/src/reasoning.js';
import { FirstTurnBudget, inputHash, firstTurnReasoningFor, type BudgetSnapshot, type FrozenInput } from './first-turn-eval-support.js';
import { semanticProbeEvidence } from './compact-teaching-eval-support.js';
import { compactContractInput } from './first-turn-compact-contract.js';
import { prepareContractFixture } from './first-turn-compact-contract-fixture.js';
import { controlledActionKind, type ContractCase } from './first-turn-compact-contract-cases.js';

const REVISION = 'compact-contract-r3-20261025';
const ROOT = path.join(os.tmpdir(), 'kodax-eval-dumps', REVISION);
const ROUTES = [
  { id: 'glm', provider: 'zhipu-coding', model: 'glm-5.3', env: 'ZHIPU_CODING_API_KEY' },
  { id: 'kimi', provider: 'kimi-code', model: 'kimi-for-coding', env: 'KIMI_CODE_API_KEY' },
  { id: 'deepseek', provider: 'deepseek', model: 'deepseek-flash', env: 'DEEPSEEK_API_KEY' },
] as const;
const LIMITS = { calls: 84, perRoute: 28, output: 8192, tokens: 2_700_000, usd: 4.5, timeoutMs: 180_000 };
const rawHash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const save = (name: string, value: unknown, exclusive = false) => fs.writeFile(path.join(ROOT, name), JSON.stringify(value, null, 2), exclusive ? { flag: 'wx' } : undefined);
const load = async <T>(name: string): Promise<T> => JSON.parse(await fs.readFile(path.join(ROOT, name), 'utf8')) as T;
type Fixture = Awaited<ReturnType<typeof prepareContractFixture>>;
interface Row {
  text: string; toolCalls: KodaXStreamResult['toolBlocks']; thinking: KodaXStreamResult['thinkingBlocks'];
  usage: KodaXStreamResult['usage'] | null; referenceUsd: number | null; durationMs: number;
  error: string | null; physicalAttempts: number; stopReason: KodaXStreamResult['stopReason'] | null;
}
interface Cell {
  route: typeof ROUTES[number]; caseId: string; arm: string; input: FrozenInput;
  calls: number; terminal: boolean; stopped?: string; rows: Row[];
  completed?: boolean; read?: boolean; edited?: boolean;
  receipts?: KodaXMessage[];
}
interface Manifest { revision: string; limits: typeof LIMITS; cellsHash: string; fixtureHash: string; sourceHashes: Record<string, string>; rates: Record<string, unknown> }

export function assertFrozenCell(frozen: unknown, current: unknown): void {
  if (inputHash(frozen) !== inputHash(current)) throw new Error('Frozen cell changed before dispatch');
}
export const emptyResponse = (row: Pick<Row, 'text' | 'toolCalls'>): boolean => !row.text.trim() && row.toolCalls.length === 0;

async function prepare() {
  const capture = process.env.KODAX_CONTRACT_CAPTURE;
  if (!capture) throw new Error('Explicit baseline wire capture required');
  const inventory = JSON.parse(await fs.readFile(path.join(capture, 'inventory.json'), 'utf8')) as { sourceHashes: Record<string, string> };
  for (const [file, hash] of Object.entries(inventory.sourceHashes)) if (rawHash(await fs.readFile(file)) !== hash) throw new Error(`Stale capture: ${file}`);
  await fs.mkdir(ROOT, { recursive: false }); // Never overwrite an earlier revision.
  const fixture = await prepareContractFixture(ROOT);
  const sources = ['tests/first-turn-eval-support.ts', 'tests/compact-teaching-eval-support.ts', 'benchmark/EVAL_GUIDELINES.md',
    'src/windows-text-transaction.ts', 'src/windows-native-artifacts.ts',
    'docs/designs/compact-contract-plan.md', 'docs/designs/compact-contract-validation-cases.md', 'package-lock.json',
    ...(await fs.readdir('tests')).filter(file => file.startsWith('first-turn-compact-contract') && file.endsWith('.ts')).map(file => `tests/${file}`)];
  for (const base of ['packages/llm/src', 'packages/coding/src/prompts', 'packages/coding/src/agents', 'benchmark/datasets/search-entry-complex']) {
    sources.push(...(await fs.readdir(base, { recursive: true })).filter(file => /\.(ts|json)$/.test(file)).map(file => `${base}/${file.replaceAll('\\', '/')}`));
  }
  const sourceHashes = { ...inventory.sourceHashes };
  for (const file of sources) sourceHashes[file] = rawHash(await fs.readFile(file));
  const cells: Cell[] = []; const mapping: unknown[] = [];
  for (const route of ROUTES) for (const scenario of fixture.cases) {
    const wire = JSON.parse(await fs.readFile(path.join(capture, `openai-${scenario.mode}-runtime-host/normalized-model-input.json`), 'utf8')) as {
      messages: { role: string; content: string }[]; tools: { function: { name: string; description: string; parameters: KodaXToolDefinition['input_schema'] } }[];
    };
    const tools = wire.tools.map(({ function: tool }) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }));
    const system = wire.messages.find(message => message.role === 'system')!.content;
    let context = wire.messages[1]!.content.replace(/<FIXTURE_ROOT>[^\r\n]*<SESSION_ID>/g,
      path.join(fixture.workspace, '.agent', 'tmp', 'sessions', 'controlled-contract'));
    context = context.replace(/You are the Worker[\s\S]*?(?=\n\nProject:)/, buildWorkerRoutingContext(buildFallbackRoutingDecision(scenario.task)));
    const active = scenario.id === 'P06' ? 3 : ['P03', 'P05'].includes(scenario.id) ? 1 : 0;
    context = context.replace(/ACTOR CAPACITY[\s\S]*?(?=\n\nYou are the Worker)/,
      buildWorkerActorCapacityContract({ maxConcurrentThreads: 4, activeNonRootTurns: active }, tools.map(tool => tool.name))!);
    context = context.replace('=== End Managed Run Context ===', `## Controlled checkpoint\n${scenario.state}\n=== End Managed Run Context ===`);
    const baseline: FrozenInput = { system, tools, messages: [{ role: 'user', content: context, _synthetic: true }, { role: 'user', content: scenario.task }, ...scenario.history] };
    const candidate = compactContractInput(baseline, true);
    if (candidate.system === baseline.system) throw new Error('Candidate failed to project production Worker');
    const reverse = randomInt(2) === 1;
    mapping.push({ route: route.id, caseId: scenario.id, A: reverse ? 'candidate' : 'baseline', B: reverse ? 'baseline' : 'candidate' });
    for (const [index, input] of (reverse ? [candidate, baseline] : [baseline, candidate]).entries()) {
      cells.push({ route, caseId: scenario.id, arm: index === 0 ? 'A' : 'B', input, calls: 0, terminal: false, rows: [] });
    }
  }
  const manifest: Manifest = { revision: REVISION, limits: LIMITS, cellsHash: inputHash(cells), fixtureHash: inputHash(fixture), sourceHashes,
    rates: Object.fromEntries(ROUTES.map(route => [route.id, getCostRate(route.provider, route.model)])) };
  await save('fixture.json', fixture, true); await save('manifest.json', manifest, true);
  await save('initial-cells.json', cells, true); await save('state.json', cells, true); await save('mapping.json', mapping, true);
  await save('budgets.json', Object.fromEntries(ROUTES.map(route => [route.id, new FirstTurnBudget(undefined, LIMITS.perRoute).state])), true);
  process.stdout.write(JSON.stringify({ directory: ROOT, manifestHash: inputHash(manifest), externalCalls: 0,
    routes: ROUTES.map(route => ({ ...route, credentialPresent: Boolean(process.env[route.env]), modelKnown: getProviderModels(route.provider).includes(route.model), rate: getCostRate(route.provider, route.model) })) }) + '\n');
}

/** Only preregistered paths receive frozen real handler receipts; no invocation or argument rewrite. */
export function continuation(cell: Pick<Cell, 'caseId' | 'completed' | 'read' | 'edited'>, calls: Row['toolCalls'], fixture: Fixture): KodaXMessage {
  const content = calls.map(call => {
    const kind = controlledActionKind(cell.caseId, call);
    let result: string;
    if (kind === 'todo-complete') { cell.completed = true; result = fixture.receipts.complete; }
    else if (kind === 'todo-list') result = (cell.completed ? fixture.receipts.listAfter : fixture.receipts.listBefore)[call.input.id ? 'item' : 'all'];
    else if (kind === 'read' && !cell.edited) { cell.read = true; result = fixture.receipts.read; }
    else if (kind === 'edit' && cell.read && !cell.edited) { cell.edited = true; result = fixture.receipts.edit; }
    else if (kind === 'test' && cell.edited) result = fixture.receipts.test;
    else throw new Error(`Unregistered continuation: ${call.name}; preserved for task-validity review`);
    return { type: 'tool_result' as const, tool_use_id: call.id, content: result };
  });
  return { role: 'user', content };
}

async function run(command: 'pilot' | 'panel') {
  const manifest = await load<Manifest>('manifest.json');
  if (process.env.KODAX_CONTRACT_MANIFEST_HASH !== inputHash(manifest) || inputHash(manifest.limits) !== inputHash(LIMITS)) throw new Error('Frozen manifest hash required');
  for (const [file, hash] of Object.entries(manifest.sourceHashes)) if (rawHash(await fs.readFile(file)) !== hash) throw new Error(`Source changed: ${file}`);
  const fixture = await load<Fixture>('fixture.json');
  if (inputHash(fixture) !== manifest.fixtureHash || inputHash(await load('initial-cells.json')) !== manifest.cellsHash) throw new Error('Frozen inputs changed');
  if (await fs.stat(path.join(ROOT, 'fatal.json')).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error; })) throw new Error('Prior fatal; do not resume');
  if (command === 'panel') {
    const review = await load<{ allowPanel: boolean; evidenceHash: string }>('pilot-review.json');
    if (!review.allowPanel || review.evidenceHash !== inputHash(await load('blind.json'))) throw new Error('Valid blind pilot review required');
  }
  for (const route of ROUTES) if (!process.env[route.env] || !getProviderModels(route.provider).includes(route.model)
    || !getCostRate(route.provider, route.model) || inputHash(getCostRate(route.provider, route.model)) !== inputHash(manifest.rates[route.id])) throw new Error(`Unavailable/changed route: ${route.id}`);
  const lock = await fs.open(path.join(ROOT, 'run.lock'), 'wx');
  try {
    const cells = await load<Cell[]>('state.json');
    const initial = await load<Cell[]>('initial-cells.json');
    for (const cell of cells.filter(cell => !cell.calls)) {
      const frozen = initial.find(item => item.route.id === cell.route.id && item.caseId === cell.caseId && item.arm === cell.arm);
      if (!frozen) throw new Error('Unknown frozen cell');
      assertFrozenCell(frozen, cell);
    }
    if (cells.length !== initial.length || new Set(cells.map(cell => `${cell.route.id}/${cell.caseId}/${cell.arm}`)).size !== initial.length) throw new Error('Frozen cell set changed');
    const states = await load<Record<string, BudgetSnapshot>>('budgets.json');
    const budgets = Object.fromEntries(ROUTES.map(route => [route.id, new FirstTurnBudget(states[route.id], LIMITS.perRoute)]));
    if (Object.values(budgets).some(b => b.state.reservedTokens !== 0 || b.state.unknownUsageCalls !== 0)) throw new Error('Interrupted or unknown-usage ledger');
    await save(`${command}-started.json`, { at: new Date().toISOString() }, true);
    let stopped = false; let persistence = Promise.resolve();
    const persist = async () => {
      const values = { state: cells, budgets: Object.fromEntries(Object.entries(budgets).map(([id, budget]) => [id, budget.state])),
        blind: { cases: fixture.cases, registeredReceipts: fixture.receipts, cells: cells.filter(cell => cell.calls).map(cell => ({ route: cell.route.id, caseId: cell.caseId, arm: cell.arm,
          calls: cell.calls, terminal: cell.terminal, stopped: cell.stopped, receipts: cell.receipts, rows: cell.rows.map(semanticProbeEvidence) })) } };
      const serialized = Object.entries(values).map(([name, value]) => [name, JSON.stringify(value, null, 2)] as const);
      persistence = persistence.then(async () => { for (const [name, value] of serialized) await fs.writeFile(path.join(ROOT, `${name}.json`), value); });
      await persistence;
    };
    const lanes = await Promise.allSettled(ROUTES.map(async route => {
      try {
        const budget = budgets[route.id]!; const rate = getCostRate(route.provider, route.model)!;
        for (const cell of cells.filter(cell => cell.route.id === route.id)) {
          const scenario = fixture.cases.find(row => row.id === cell.caseId)!;
          if (scenario.pilot !== (command === 'pilot')) continue;
          if (cell.calls) throw new Error('Cell cannot be rerun');
          while (!stopped && !cell.terminal && !cell.stopped && cell.calls < scenario.rounds) {
            const reservedInput = Buffer.byteLength(JSON.stringify(cell.input)) + 4096;
            const reservedTokens = reservedInput + LIMITS.output;
            const reservedUsd = calculateCost(rate, reservedInput, LIMITS.output);
            const aggregate = Object.values(budgets).reduce((sum, item) => ({ calls: sum.calls + item.state.calls,
              tokens: sum.tokens + item.state.chargedTokens + item.state.reservedTokens, usd: sum.usd + item.state.chargedUsd + item.state.reservedUsd }), { calls: 0, tokens: 0, usd: 0 });
            if (aggregate.calls >= LIMITS.calls || aggregate.tokens + reservedTokens > LIMITS.tokens || aggregate.usd + reservedUsd > LIMITS.usd) throw new Error('Global budget exhausted');
            budget.reserve(reservedTokens, reservedUsd); cell.calls++; await persist();
            const facts: ProviderRequestObservation[] = []; const started = Date.now();
            let result: KodaXStreamResult | undefined; let error: string | null = null;
            try {
              const signal = AbortSignal.timeout(LIMITS.timeoutMs);
              result = await runWithProviderRequestObserver(fact => facts.push(fact), () => observeProviderOperation(route.provider, 'utility', undefined,
                () => getProvider(route.provider).stream([...cell.input.messages], [...cell.input.tools], cell.input.system, firstTurnReasoningFor(route.provider),
                  { modelOverride: route.model, maxOutputTokensOverride: LIMITS.output, singleAttempt: true }, signal), undefined, signal));
            } catch (cause: unknown) {
              error = cause instanceof Error ? cause.message : String(cause);
              for (const entry of ROUTES) { const key = process.env[entry.env]; if (key) error = error.replaceAll(key, '[REDACTED]'); }
            }
            const attempts = new Set(facts.filter(fact => fact.boundary === 'physical_attempt' && fact.state === 'started').map(fact => fact.requestId)).size;
            const usage = result?.usage;
            const known = !error && attempts === 1 && usage && Number.isFinite(usage.inputTokens) && usage.inputTokens >= 0
              && Number.isFinite(usage.outputTokens) && usage.outputTokens >= 0 && usage.totalTokens === usage.inputTokens + usage.outputTokens && usage.totalTokens > 0;
            const cost = known ? calculateCost(rate, usage.inputTokens, usage.outputTokens, usage.cachedReadTokens ?? 0, usage.cachedWriteTokens ?? 0) : undefined;
            budget.settle(reservedTokens, reservedUsd, known ? usage : undefined, cost);
            if (!known || cost === undefined || !Number.isFinite(cost)) error ??= 'Unknown usage or physical request count';
            const row: Row = { text: result?.textBlocks.map(block => block.text).join('') ?? '', toolCalls: result?.toolBlocks ?? [], thinking: result?.thinkingBlocks ?? [],
              usage: usage ?? null, referenceUsd: cost ?? null, durationMs: Date.now() - started, error, physicalAttempts: attempts, stopReason: result?.stopReason ?? null };
            cell.rows.push(row);
            cell.terminal = !error && !row.toolCalls.length && Boolean(row.text.trim()) && row.stopReason !== 'max_tokens';
            if (error) { stopped = true; cell.stopped = error; await save('fatal.json', { route: route.id, error }); }
            if (row.stopReason === 'max_tokens') cell.stopped = 'Output budget censored';
            if (!error && emptyResponse(row)) cell.stopped = 'Inconclusive empty response; no automatic follow-up';
            await save(`${route.id}-${cell.caseId}-${cell.arm}-${cell.calls}.json`, { input: cell.input, result, row, facts }, true);
            // Register even the final round's proposed effects; never buy a fourth response.
            if (!cell.stopped && scenario.rounds > 1 && row.toolCalls.length) {
              try {
                const receipt = continuation(cell, row.toolCalls, fixture);
                cell.receipts = [...(cell.receipts ?? []), receipt];
                cell.input = { ...cell.input, messages: [...cell.input.messages,
                  { role: 'assistant', content: [...row.thinking, ...row.toolCalls, ...(row.text ? [{ type: 'text' as const, text: row.text }] : [])] }, receipt] };
              } catch (cause: unknown) { cell.stopped = cause instanceof Error ? cause.message : String(cause); }
            }
            await persist();
            process.stdout.write(JSON.stringify({ route: route.id, caseId: cell.caseId, arm: cell.arm, calls: cell.calls, stopped: cell.stopped }) + '\n');
          }
        }
      } catch (error: unknown) { stopped = true; await save('fatal.json', { route: route.id, reason: 'Lane aborted; preserve evidence and ledger' }); throw error; }
    }));
    for (const lane of lanes) if (lane.status === 'rejected') throw lane.reason;
    process.stdout.write(JSON.stringify({ directory: ROOT, budgets: Object.fromEntries(Object.entries(budgets).map(([id, budget]) => [id, budget.state])) }) + '\n');
  } finally { await lock.close(); await fs.unlink(path.join(ROOT, 'run.lock')); }
}

const command = process.env.KODAX_CONTRACT_COMMAND;
if (command === 'prepare') await prepare();
else if (command === 'pilot' || command === 'panel') await run(command);
