/** FEATURE_311 step 2, manual L2 system+tools experiment: prepare → pilot → blind review → remaining → review → reveal.
 * Persona and host-system-prompt roots move from the canonical Worker to the source-built Worker and the root tool view.
 * Arms come from real Runtime captures (tests/managed-first-turn.capture.ts) on the baseline and candidate
 * trees. Never executes model-selected tools. Raw inputs, mapping and accounting stay in OS Temp.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomInt } from 'node:crypto';
import { getProvider, getProviderModels, getCostRate, calculateCost } from '../packages/llm/src/index.js';
import type { KodaXMessage, KodaXStreamResult } from '../packages/llm/src/types.js';
import { observeProviderOperation, runWithProviderRequestObserver, type ProviderRequestObservation } from '../packages/llm/src/provider-request-observation.js';
import { inputHash, firstTurnReasoningFor, type FrozenInput } from './first-turn-eval-support.js';
import { semanticProbeEvidence } from './compact-teaching-eval-support.js';
import { prepareContractFixture } from './first-turn-compact-contract-fixture.js';
import { assertSemanticReview } from './managed-tool-contract.eval.js';

const REVISION = 'f311-step2-worker-root-r1';
const LIMITS = { calls: 72, perCell: 1, rounds: 1, output: 8192, tokens: 2_500_000, usd: 2, timeoutMs: 240_000 };
const PROTOCOL = {
  layer: 'L2',
  question: 'When persona roots move from the canonical Worker to the source-built Worker (neutral identity), and host-system-prompt roots move to KodaX guidance omitted, both with the root tool view, are the next actions at dispatch, ownership, Todo, question, edit-recovery and Memory checkpoints preserved?',
  whyNotOfflineOnly: 'System bytes, tool view and ordinary-root identity are proven offline; model interpretation of the halved persona system and the omitted host-prompt guidance is not.',
  sample: 'One observation per arm/entry/case/model. Twelve pilot cells (override D1+E1 and persona D1 on glm and deepseek); main-session task-validity review may stop without expanding. At most sixty remaining cells, never retries.',
  value: 'Preserve useful legal actions, ownership and recovery; avoid needless discovery, duplicate plans, repeated stale edits, split questions and unfaithful Memory writes. Judge necessary reconnaissance semantically.',
  attribution: ['eval-design', 'provider-noise', 'prompt-regression', 'inconclusive'],
  decision: 'Main-session blind review records validity, lift/harm, attribution and recommendation before labels or usage are revealed. No automatic ship gate.',
  limits: 'Single-response evidence cannot prove whole-task quality, turns or time. Ordinary roots are byte-identical (offline capture). Visibility-policy roots are not sampled: they now receive the ordinary-root system and tool view, which earlier compact-contract evals covered.',
};
const ROUTES = [
  { id: 'glm', provider: 'zhipu-coding', model: 'glm-5.3-flash', env: 'ZHIPU_CODING_API_KEY' },
  { id: 'kimi', provider: 'kimi-code', model: 'kimi-for-coding', env: 'KIMI_CODE_API_KEY' },
  { id: 'deepseek', provider: 'deepseek', model: 'deepseek-flash', env: 'DEEPSEEK_API_KEY' },
] as const;
const ENTRIES = { persona: ['D1', 'O1', 'T1', 'A1', 'E1', 'M1'], override: ['D1', 'O1', 'T1', 'A1', 'E1', 'M1'] } as const;
type Entry = keyof typeof ENTRIES;
// Capture ids map onto the audited contract checkpoints; M1 is new.
const FIXTURE_CASE: Record<string, string> = { D1: 'P03', O1: 'P05', T1: 'P02', A1: 'P07', E1: 'C02' };
const MEMORY_CASE = {
  state: 'No plan or children. The user states a durable project preference; no code change is requested this turn.',
  rubric: 'Record the durable preference with the Memory tool, faithful in scope (this project) and content (Chinese commit messages, title within 50 characters). No code edit, Todo, child Agent or needless question. A short acknowledgement after the call is fine.',
};
type Pair = { route: string; caseId: string };
type Cell = Pair & { arm: 'A' | 'B'; input: FrozenInput };
interface CaseRecord { id: string; entry: Entry; task: string; state: string; rubric: string }
interface Capture { fixtureRoot: string; cases: { id: string; task: string; input: FrozenInput }[] }
interface Ledger { calls: number; chargedTokens: number; chargedUsd: number; reservedTokens: number; reservedUsd: number; unknownUsageCalls: number }
interface Manifest { revision: string; limits: typeof LIMITS; protocol: typeof PROTOCOL; cellsHash: string; mappingHash: string;
  casesHash: string; sourceHashes: Record<string, string>; rates: Record<string, unknown> }

const rawHash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const read = async <T>(file: string): Promise<T> => JSON.parse(await fs.readFile(file, 'utf8')) as T;
const save = (file: string, value: unknown, exclusive = false) => fs.writeFile(file, JSON.stringify(value, null, 2), exclusive ? { flag: 'wx' } : undefined);
const exists = (file: string) => fs.stat(file).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error; });
const key = (cell: Cell) => `${cell.route}-${cell.caseId}-${cell.arm}`;
const pairKey = (pair: Pair) => `${pair.route}/${pair.caseId}`;
const pairsFor = (cells: Cell[]) => [...new Map(cells.map(cell => [pairKey(cell), { route: cell.route, caseId: cell.caseId }])).values()];
const isPilotCell = (cell: Pair) => cell.route !== 'kimi' && ['override-D1', 'override-E1', 'persona-D1'].includes(cell.caseId);
const sources = ['tests/f311-worker-root.eval.ts', 'tests/managed-first-turn.capture.ts', 'tests/first-turn-compact-contract-fixture.ts',
  'tests/first-turn-compact-contract-cases.ts', 'packages/coding/src/tools/tool-definitions.ts', 'packages/coding/src/prompts/static-text.json',
  'packages/coding/src/agents/worker-role-prompt.ts', 'packages/coding/src/prompts/capability-sections.ts',
  'packages/coding/src/task-engine/_internal/managed-task/role-prompt.ts', 'packages/coding/src/task-engine/runner-driven.ts',
  'packages/coding/src/prompts/text/tools/tool-definitions.schemas.json', 'benchmark/EVAL_GUIDELINES.md'];

function assertTemp(root: string): void {
  const relative = path.relative(os.tmpdir(), root);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Raw output must be a child directory of OS Temp');
}

/** Random capture identifiers differ between the two Runtime runs; the candidate messages serve both arms. */
function normalized(input: FrozenInput, root: string): string {
  const roots = [root, root.replaceAll('\\', '\\\\'), root.replaceAll('\\', '/')];
  let text = JSON.stringify({ messages: input.messages });
  for (const value of roots) text = text.replaceAll(value, '<ROOT>');
  return text.replace(/<ROOT>[\\/]+(\w+)-\w{6}/g, '<ROOT>/$1-X').replace(/\d{8}_\d{6}_\w{12,16}/g, '<SESSION>').replace(/turn_[0-9a-f]{16}/g, '<TURN>')
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, '<TIME>').replace(routingLine(input), '<ROUTING>');
}

/** The run-context routing line carries the Worker identity, so it belongs to the contract under test. */
const ROUTING_LINES = ["You are the Worker — KodaX's single primary agent for this task. Routing decision summary:", 'Routing decision summary for this task:'];
function routingLine(input: FrozenInput): string {
  const context = input.messages[0]?.content;
  const found = ROUTING_LINES.filter(line => typeof context === 'string' && context.includes(line));
  if (found.length !== 1) throw new Error('Expected one routing line in the managed run context');
  return found[0]!;
}

function withRoutingLine(input: FrozenInput, line: string): FrozenInput {
  const [context, ...rest] = input.messages;
  return { ...input, messages: [{ ...context!, content: (context!.content as string).replace(routingLine(input), line) }, ...rest] };
}

function workingDirectory(input: FrozenInput): string {
  const found = /^Working Directory: (.+)$/m.exec(input.system)?.[1];
  if (!found || input.system.split(found).length !== 2) throw new Error('Expected one working directory in the system prompt');
  return found;
}

function checkpointInput(captured: FrozenInput, task: string, state: string, history: readonly KodaXMessage[], fixtureWorkspace: string): FrozenInput {
  const [context, request, ...rest] = captured.messages;
  if (rest.length || typeof context?.content !== 'string' || request?.content !== task) throw new Error('Unexpected captured first request shape');
  if (!context.content.includes('=== End Managed Run Context ===')) throw new Error('Missing managed run context envelope');
  const workspace = /Session Scratch Directory: (.*?)[\\/]\.agent[\\/]/.exec(context.content)?.[1];
  if (!workspace) throw new Error('Captured workspace not found');
  const content = context.content.replace('=== End Managed Run Context ===', `## Controlled checkpoint\n${state}\n=== End Managed Run Context ===`);
  const replayed = JSON.parse(JSON.stringify(history).replaceAll(JSON.stringify(fixtureWorkspace).slice(1, -1), JSON.stringify(workspace).slice(1, -1))) as KodaXMessage[];
  return { system: captured.system, tools: captured.tools, messages: [{ ...context, content }, request, ...replayed] };
}

async function prepare(root: string, captures: string) {
  if (!captures) throw new Error('--captures <directory with capture-{base,cand}-{persona,override}.json> required');
  await fs.mkdir(root, { recursive: false });
  const fixture = await prepareContractFixture(root);
  const cells: Cell[] = []; const mapping: (Pair & { A: string; B: string })[] = []; const cases: CaseRecord[] = [];
  for (const entry of Object.keys(ENTRIES) as Entry[]) {
    const [base, cand] = await Promise.all(['base', 'cand'].map(arm => read<Capture>(path.join(captures, `capture-${arm}-${entry}.json`))));
    for (const id of ENTRIES[entry]) {
      const baseline = base!.cases.find(item => item.id === id)!; const candidate = cand!.cases.find(item => item.id === id)!;
      if (normalized(baseline.input, base!.fixtureRoot) !== normalized(candidate.input, cand!.fixtureRoot)) throw new Error(`${entry}/${id}: history differs between captures`);
      const source = FIXTURE_CASE[id] ? fixture.cases.find(item => item.id === FIXTURE_CASE[id])! : undefined;
      if (source && source.task !== candidate.task) throw new Error(`${entry}/${id}: capture task differs from the audited checkpoint`);
      const state = source?.state ?? MEMORY_CASE.state; const rubric = source?.rubric ?? MEMORY_CASE.rubric;
      const next = checkpointInput(candidate.input, candidate.task, state, source?.history ?? [], fixture.workspace);
      // Only the contract differs: the baseline system is rebased onto the candidate workspace path.
      const prior = { ...withRoutingLine(next, routingLine(baseline.input)), system: baseline.input.system.replaceAll(workingDirectory(baseline.input), workingDirectory(candidate.input)), tools: baseline.input.tools };
      if (prior.system === next.system || prior.system.includes(base!.fixtureRoot)) throw new Error(`${entry}/${id}: unexpected system pair`);
      const caseId = `${entry}-${id}`;
      cases.push({ id: caseId, entry, task: candidate.task, state, rubric });
      for (const route of ROUTES) {
        const reverse = randomInt(2) === 1;
        mapping.push({ route: route.id, caseId, A: reverse ? 'candidate' : 'baseline', B: reverse ? 'baseline' : 'candidate' });
        for (const [index, input] of (reverse ? [next, prior] : [prior, next]).entries()) cells.push({ route: route.id, caseId, arm: index === 0 ? 'A' : 'B', input });
      }
    }
  }
  if (cells.length !== LIMITS.calls) throw new Error('Registered cell count changed');
  const sourceHashes: Record<string, string> = {};
  for (const file of [...sources, ...(await fs.readdir(captures)).filter(file => file.startsWith('capture-')).map(file => path.join(captures, file))]) sourceHashes[file] = rawHash(await fs.readFile(file));
  const manifest: Manifest = { revision: REVISION, limits: LIMITS, protocol: PROTOCOL, cellsHash: inputHash(cells), mappingHash: inputHash(mapping), casesHash: inputHash(cases),
    sourceHashes, rates: Object.fromEntries(ROUTES.map(route => [route.id, getCostRate(route.provider, route.model)])) };
  const ledger: Ledger = { calls: 0, chargedTokens: 0, chargedUsd: 0, reservedTokens: 0, reservedUsd: 0, unknownUsageCalls: 0 };
  await save(path.join(root, 'cells.json'), cells, true); await save(path.join(root, 'mapping.json'), mapping, true);
  await save(path.join(root, 'cases.json'), cases, true); await save(path.join(root, 'manifest.json'), manifest, true);
  await save(path.join(root, 'budget.json'), ledger, true);
  process.stdout.write(JSON.stringify({ directory: root, manifestHash: inputHash(manifest), externalCalls: 0,
    pilotCalls: cells.filter(isPilotCell).length, remainingCalls: cells.filter(cell => !isPilotCell(cell)).length }) + '\n');
}

async function loadFrozen(root: string, suppliedHash?: string) {
  const manifest = await read<Manifest>(path.join(root, 'manifest.json'));
  if (suppliedHash !== inputHash(manifest) || manifest.revision !== REVISION || inputHash(manifest.limits) !== inputHash(LIMITS)) throw new Error('Exact --manifest hash required');
  const cells = await read<Cell[]>(path.join(root, 'cells.json'));
  if (inputHash(cells) !== manifest.cellsHash || new Set(cells.map(key)).size !== LIMITS.calls) throw new Error('Frozen cells changed');
  if (inputHash(await read(path.join(root, 'mapping.json'))) !== manifest.mappingHash || inputHash(await read(path.join(root, 'cases.json'))) !== manifest.casesHash) throw new Error('Frozen cases/mapping changed');
  for (const [file, hash] of Object.entries(manifest.sourceHashes)) if (rawHash(await fs.readFile(file)) !== hash) throw new Error(`Source changed: ${file}`);
  return { manifest, cells };
}

async function blind(root: string, cells: Cell[], phase: string) {
  const rows = await Promise.all(cells.map(async cell => ({ route: cell.route, caseId: cell.caseId, arm: cell.arm,
    evidence: await exists(path.join(root, `${key(cell)}.json`)) ? semanticProbeEvidence((await read<{ row: Row }>(path.join(root, `${key(cell)}.json`))).row) : null })));
  const value = { phase, cases: await read<CaseRecord[]>(path.join(root, 'cases.json')), rows };
  await save(path.join(root, `${phase}-blind.json`), value);
  return value;
}

interface Row { text: string; toolCalls: KodaXStreamResult['toolBlocks']; thinking: KodaXStreamResult['thinkingBlocks'];
  stopReason: KodaXStreamResult['stopReason'] | null; error: string | null; durationMs: number; usage: KodaXStreamResult['usage'] | null;
  referenceUsd: number | null; physicalAttempts: number; chargedTokens: number; chargedUsd: number; conservative: boolean }

async function callCell(cell: Cell, route: typeof ROUTES[number]) {
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
  return { result, error, facts, durationMs: Date.now() - started };
}

async function run(root: string, phase: string, hash?: string) {
  if (!['pilot', 'remaining'].includes(phase)) throw new Error('--phase must be pilot or remaining');
  const { manifest, cells } = await loadFrozen(root, hash);
  if (await exists(path.join(root, 'revealed.json')) || await exists(path.join(root, 'stopped.json'))) throw new Error('Experiment finalized or stopped; no reruns');
  if (phase === 'remaining') {
    const approval = await read<{ review: { allowRemaining?: boolean }; evidenceHash: string }>(path.join(root, 'pilot-review.json'));
    assertSemanticReview(approval.review, pairsFor(cells.filter(isPilotCell)), true);
    if (!approval.review.allowRemaining || approval.evidenceHash !== inputHash(await blind(root, cells.filter(isPilotCell), 'pilot'))) throw new Error('Unchanged blind pilot review permitting continuation required');
  }
  const selected = cells.filter(cell => isPilotCell(cell) === (phase === 'pilot'));
  for (const route of ROUTES.filter(route => selected.some(cell => cell.route === route.id))) {
    if (!process.env[route.env] || !getProviderModels(route.provider).includes(route.model)
      || inputHash(getCostRate(route.provider, route.model)) !== inputHash(manifest.rates[route.id])) throw new Error(`Unavailable or changed route: ${route.id}`);
  }
  const ledger = await read<Ledger>(path.join(root, 'budget.json'));
  if (ledger.reservedTokens !== 0 || ledger.unknownUsageCalls !== 0) throw new Error('Interrupted or unknown accounting; do not resume');
  const lock = await fs.open(path.join(root, 'run.lock'), 'wx');
  let stopped = false;
  try {
    // One request in flight per provider; different providers run in parallel.
    const lanes = await Promise.allSettled(ROUTES.map(async route => {
      for (const cell of selected.filter(item => item.route === route.id)) {
        if (stopped) return;
        if (await exists(path.join(root, `${key(cell)}.json`))) throw new Error(`Cell already recorded: ${key(cell)}`);
        const rate = getCostRate(route.provider, route.model)!;
        const reservedInput = Buffer.byteLength(JSON.stringify(cell.input)) + 4096;
        const reservedTokens = reservedInput + LIMITS.output; const reservedUsd = calculateCost(rate, reservedInput, LIMITS.output);
        if (ledger.calls >= LIMITS.calls || ledger.chargedTokens + ledger.reservedTokens + reservedTokens > LIMITS.tokens
          || ledger.chargedUsd + ledger.reservedUsd + reservedUsd > LIMITS.usd) { stopped = true; await save(path.join(root, 'stopped.json'), { reason: 'Conservative budget exhausted' }); return; }
        ledger.calls += 1; ledger.reservedTokens += reservedTokens; ledger.reservedUsd += reservedUsd;
        await save(path.join(root, 'budget.json'), ledger);
        const { result, error: failure, facts, durationMs } = await callCell(cell, route);
        let error = failure;
        const attempts = new Set(facts.filter(fact => fact.boundary === 'physical_attempt' && fact.state === 'started').map(fact => fact.requestId)).size;
        const usage = result?.usage;
        const known = !error && attempts === 1 && !!usage && usage.inputTokens >= 0 && usage.outputTokens >= 0 && usage.totalTokens === usage.inputTokens + usage.outputTokens && usage.totalTokens > 0;
        const cost = known ? calculateCost(rate, usage!.inputTokens, usage!.outputTokens, usage!.cachedReadTokens ?? 0, usage!.cachedWriteTokens ?? 0) : null;
        const accounted = known && cost !== null && Number.isFinite(cost) && cost >= 0;
        ledger.reservedTokens -= reservedTokens; ledger.reservedUsd = Math.max(0, ledger.reservedUsd - reservedUsd);
        ledger.chargedTokens += accounted ? usage!.totalTokens : reservedTokens; ledger.chargedUsd += accounted ? cost! : reservedUsd;
        if (!accounted) { ledger.unknownUsageCalls += 1; error ??= 'Unknown usage or physical attempt count'; }
        const row: Row = { text: result?.textBlocks.map(block => block.text).join('') ?? '', toolCalls: result?.toolBlocks ?? [], thinking: result?.thinkingBlocks ?? [],
          stopReason: result?.stopReason ?? null, error, durationMs, usage: usage ?? null, referenceUsd: cost, physicalAttempts: attempts,
          chargedTokens: accounted ? usage!.totalTokens : reservedTokens, chargedUsd: accounted ? cost! : reservedUsd, conservative: !accounted };
        await save(path.join(root, `${key(cell)}.json`), { inputHash: inputHash(cell.input), row, facts, toolNames: row.toolCalls.map(call => call.name) }, true);
        await save(path.join(root, 'budget.json'), ledger);
        if (error || row.stopReason === 'max_tokens' || (!row.text.trim() && !row.toolCalls.length)) {
          stopped = true; await save(path.join(root, 'stopped.json'), { cell: key(cell), reason: error ?? 'Censored or empty response; no retry' });
        }
        process.stdout.write(JSON.stringify({ route: cell.route, caseId: cell.caseId, arm: cell.arm, tools: row.toolCalls.map(call => call.name), stopped }) + '\n');
      }
    }));
    for (const lane of lanes) if (lane.status === 'rejected') { await save(path.join(root, 'stopped.json'), { reason: String(lane.reason) }); throw lane.reason; }
  } finally {
    await blind(root, phase === 'pilot' ? cells.filter(isPilotCell) : cells, phase === 'pilot' ? 'pilot' : 'final');
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
  process.stdout.write(JSON.stringify({ reviewSaved: phase }) + '\n');
}

async function reveal(root: string) {
  if (await exists(path.join(root, 'run.lock'))) throw new Error('Run is active');
  const cells = await read<Cell[]>(path.join(root, 'cells.json'));
  const reviewed = await read<{ review: unknown; evidenceHash: string }>(path.join(root, 'final-review.json'));
  assertSemanticReview(reviewed.review, pairsFor(cells), false);
  if (reviewed.evidenceHash !== inputHash(await blind(root, cells, 'final'))) throw new Error('Blind evidence changed since semantic review');
  const accounting = await Promise.all(cells.map(async cell => ({ route: cell.route, caseId: cell.caseId, arm: cell.arm,
    row: await exists(path.join(root, `${key(cell)}.json`)) ? (await read<{ row: Row }>(path.join(root, `${key(cell)}.json`))).row : null })));
  await save(path.join(root, 'revealed.json'), { mapping: await read(path.join(root, 'mapping.json')), review: reviewed.review, accounting,
    budget: await read(path.join(root, 'budget.json')), limitations: PROTOCOL.limits }, true);
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
  if (command === 'prepare') await prepare(root, options.get('captures') ?? '');
  else if (command === 'run') await run(root, options.get('phase') ?? '', options.get('manifest'));
  else if (command === 'review') await review(root, options.get('phase') ?? '', options.get('file') ?? '');
  else if (command === 'reveal') await reveal(root);
  else throw new Error('Use prepare | run | review | reveal; no operation invokes models implicitly');
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main(process.argv.slice(2));
