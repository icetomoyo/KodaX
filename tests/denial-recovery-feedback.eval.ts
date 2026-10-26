/** Manual single-response probes; never execute generated tools or retry cells. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomInt } from 'node:crypto';
import { getProvider, getCostRate, calculateCost } from '../packages/llm/src/index.js';
import type { KodaXStreamResult } from '../packages/llm/src/types.js';
import { observeProviderOperation, runWithProviderRequestObserver, type ProviderRequestObservation } from '../packages/llm/src/provider-request-observation.js';
import { buildWorkerStableInstructions } from '../packages/coding/src/agents/worker-role-prompt.js';
import { TOOL_RECOVERY_GUIDANCE } from '../packages/coding/src/prompts/execution-guidance.js';
import { checkComplexTool } from './first-turn-complex-guard.js';
import { FirstTurnBudget, firstTurnReasoningFor, inputHash, type BudgetSnapshot, type FrozenInput } from './first-turn-eval-support.js';
import { semanticProbeEvidence } from './compact-teaching-eval-support.js';

const root = path.join(os.tmpdir(), 'kodax-eval-dumps/denial-recovery-r2-20261026');
const prior = path.join(os.tmpdir(), 'kodax-eval-dumps/compact-contract-full-complex-20261025-r2');
const controlled = path.join(os.tmpdir(), 'kodax-eval-dumps/compact-contract-r3-20261025');
const routes = [
  { id: 'kimi', provider: 'kimi-code', model: 'kimi-for-coding', env: 'KIMI_CODE_API_KEY' },
  { id: 'glm', provider: 'zhipu-coding', model: 'glm-5.3', env: 'ZHIPU_CODING_API_KEY' },
  { id: 'deepseek', provider: 'deepseek', model: 'deepseek-flash', env: 'DEEPSEEK_API_KEY' },
] as const;
const limits = { calls: 12, tokens: 700000, usd: 1.5, output: 8192, timeoutMs: 180000 };
type Arm = 'A' | 'B';
interface Cell { route: string; caseId: string; arm: Arm; input: FrozenInput }
interface Manifest { cellsHash: string; sourceHashes: Record<string, string>; limits: typeof limits }
const read = async <T>(file: string): Promise<T> => JSON.parse(await fs.readFile(file, 'utf8')) as T;
const save = (file: string, value: unknown) => fs.writeFile(path.join(root, file), JSON.stringify(value, null, 2), { flag: 'wx' });
const phase = process.argv[2];

if (phase === 'prepare') {
  const original = (await read<{ input: FrozenInput }>(path.join(prior, 'kimi/baseline/call-0.input.json'))).input;
  const denied = (await read<{ input: FrozenInput }>(path.join(prior, 'kimi/candidate/call-16.input.json'))).input;
  // The historical controlled file stores route objects, unlike this experiment.
  const sourceCells = await read<{ route: { id: string }; caseId: string; arm: Arm; input: FrozenInput }[]>(path.join(controlled, 'initial-cells.json'));
  const oldMap = await read<{ route: string; caseId: string; A: string; B: string }[]>(path.join(controlled, 'mapping.json'));
  const mapping = oldMap.find(row => row.route === 'kimi' && row.caseId === 'C02');
  const repair = sourceCells.find(row => row.route.id === 'kimi' && row.caseId === 'C02' && mapping?.[row.arm] === 'baseline')?.input;
  if (!repair) throw new Error('Missing frozen stale-anchor case');
  const baselineDenial: FrozenInput = { system: original.system, tools: original.tools, messages: denied.messages };
  const cases = [{ id: 'cleanup', input: baselineDenial }, { id: 'stale-anchor', input: repair }];
  const cells: Cell[] = []; const map: unknown[] = [];
  for (const route of routes) for (const scenario of cases) {
    const next = buildWorkerStableInstructions(scenario.input.tools.map(tool => tool.name));
    const before = next.replace(`\n- ${TOOL_RECOVERY_GUIDANCE}`, '');
    if (before === next || scenario.input.system.split(before).length !== 2) throw new Error('Historical Worker no longer matches current pre-change contract');
    let candidate: FrozenInput = { ...scenario.input, system: scenario.input.system.replace(before, () => next) };
    if (scenario.id === 'cleanup') {
      let replaced = 0;
      candidate = { ...candidate, messages: candidate.messages.map(message => !Array.isArray(message.content) ? message : {
        ...message, content: message.content.map(block => {
          if (block.type !== 'tool_result' || typeof block.content !== 'string'
            || !block.content.endsWith('Executable is outside the fixture test and inspection scope.')) return block;
          replaced++;
          const reason = checkComplexTool(path.join(prior, 'kimi/candidate/workspace'), 'bash', { command: 'del tests/debug.test.js && npm test' }, false);
          if (!reason) throw new Error('Cleanup unexpectedly admitted');
          return { ...block, content: block.content.replace('Executable is outside the fixture test and inspection scope.', reason) };
        }),
      }) };
      if (replaced !== 1) throw new Error('Expected one original cleanup refusal');
    }
    const reversed = randomInt(2) === 1;
    cells.push({ route: route.id, caseId: scenario.id, arm: 'A', input: reversed ? candidate : scenario.input },
      { route: route.id, caseId: scenario.id, arm: 'B', input: reversed ? scenario.input : candidate });
    map.push({ route: route.id, caseId: scenario.id, A: reversed ? 'candidate' : 'baseline', B: reversed ? 'baseline' : 'candidate' });
  }
  const files = ['tests/denial-recovery-feedback.eval.ts', 'tests/first-turn-complex-guard.ts', 'tests/first-turn-eval-support.ts',
    'tests/compact-teaching-eval-support.ts', 'package-lock.json', 'docs/designs/denial-recovery-validation.md'];
  for (const dir of ['packages/llm/src', 'packages/coding/src/prompts', 'packages/coding/src/agents']) {
    files.push(...(await fs.readdir(dir, { recursive: true })).filter(file => file.endsWith('.ts')).map(file => `${dir}/${file.replaceAll('\\', '/')}`));
  }
  const sourceHashes = Object.fromEntries(await Promise.all(files.map(async file => [file, inputHash(await fs.readFile(file, 'utf8'))])));
  await fs.mkdir(root, { recursive: false });
  await save('cells.json', cells); await save('mapping.json', map);
  await save('manifest.json', { cellsHash: inputHash(cells), sourceHashes, limits,
    sources: [prior, controlled], rates: Object.fromEntries(routes.map(route => [route.id, getCostRate(route.provider, route.model)])) });
  process.stdout.write(`Prepared ${cells.length} cells; ${root}\n`);
} else if (phase === 'pilot' || phase === 'panel') {
  const manifest = await read<Manifest>(path.join(root, 'manifest.json'));
  const cells = await read<Cell[]>(path.join(root, 'cells.json'));
  if (inputHash(cells) !== manifest.cellsHash || inputHash(limits) !== inputHash(manifest.limits)) throw new Error('Frozen inputs/limits changed');
  for (const [file, hash] of Object.entries(manifest.sourceHashes)) if (inputHash(await fs.readFile(file, 'utf8')) !== hash) throw new Error(`Source changed: ${file}`);
  if (phase === 'panel' && !(await read<{ allowPanel: boolean }>(path.join(root, 'pilot-review.json'))).allowPanel) throw new Error('Pilot review required');
  const selected = routes.filter(route => (route.id === 'kimi') === (phase === 'pilot'));
  for (const route of selected) if (!process.env[route.env] || !getCostRate(route.provider, route.model)) throw new Error(`Missing configured route: ${route.id}`);
  const budget = new FirstTurnBudget(phase === 'panel' ? await read<BudgetSnapshot>(path.join(root, 'pilot-budget.json')) : undefined, limits.calls);
  if (budget.state.reservedTokens || budget.state.unknownUsageCalls) throw new Error('Unsettled pilot');
  await save(`${phase}-started.json`, { time: new Date().toISOString() });
  let stopped = false;
  const outcomes = await Promise.allSettled(selected.map(async route => {
    const rate = getCostRate(route.provider, route.model)!;
    for (const cell of cells.filter(item => item.route === route.id)) {
      if (stopped) break;
      const reservedInput = Buffer.byteLength(JSON.stringify(cell.input)) + 4096;
      const reserved = reservedInput + limits.output; const usd = calculateCost(rate, reservedInput, limits.output);
      if (budget.state.chargedTokens + budget.state.reservedTokens + reserved > limits.tokens
        || budget.state.chargedUsd + budget.state.reservedUsd + usd > limits.usd) throw new Error('Global budget exhausted');
      budget.reserve(reserved, usd);
      const label = `${cell.route}-${cell.caseId}-${cell.arm}`;
      await save(`${label}-started.json`, { inputHash: inputHash(cell.input), reserved, usd, budget: budget.state });
      const facts: ProviderRequestObservation[] = []; const start = Date.now();
      let result: KodaXStreamResult | undefined; let error: string | null = null;
      try {
        const signal = AbortSignal.timeout(limits.timeoutMs);
        result = await runWithProviderRequestObserver(fact => facts.push(fact), () => observeProviderOperation(route.provider, 'utility', undefined,
          () => getProvider(route.provider).stream([...cell.input.messages], [...cell.input.tools], cell.input.system, firstTurnReasoningFor(route.provider),
            { modelOverride: route.model, maxOutputTokensOverride: limits.output, singleAttempt: true }, signal), undefined, signal));
      } catch (cause: unknown) {
        error = cause instanceof Error ? cause.message : String(cause);
        for (const item of routes) if (process.env[item.env]) error = error.replaceAll(process.env[item.env]!, '[REDACTED]');
      }
      const physical = new Set(facts.filter(fact => fact.boundary === 'physical_attempt' && fact.state === 'started').map(fact => fact.requestId)).size;
      const usage = result?.usage;
      const known = !error && physical === 1 && usage && Number.isFinite(usage.inputTokens) && usage.inputTokens >= 0
        && Number.isFinite(usage.outputTokens) && usage.outputTokens >= 0 && usage.totalTokens > 0 && usage.totalTokens === usage.inputTokens + usage.outputTokens;
      const cost = known ? calculateCost(rate, usage.inputTokens, usage.outputTokens, usage.cachedReadTokens ?? 0, usage.cachedWriteTokens ?? 0) : undefined;
      budget.settle(reserved, usd, known ? usage : undefined, cost);
      if (!known) error ??= 'Unknown usage or physical attempts';
      if (error || result?.stopReason === 'max_tokens') stopped = true;
      const row = { text: result?.textBlocks.map(block => block.text).join('') ?? '', toolCalls: result?.toolBlocks ?? [],
        thinking: result?.thinkingBlocks ?? [], stopReason: result?.stopReason ?? null, error, usage, referenceUsd: cost, durationMs: Date.now() - start };
      await save(`${label}.json`, { row, facts, physical, inputHash: inputHash(cell.input), budget: budget.state });
      await save(`${label}-blind.json`, { route: cell.route, caseId: cell.caseId, arm: cell.arm, ...semanticProbeEvidence(row) });
    }
  }));
  await save(`${phase}-budget.json`, budget.state);
  for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
  process.stdout.write(JSON.stringify({ phase, stopped, budget: budget.state }));
} else throw new Error('Use prepare, pilot or panel; no automatic continuation');
