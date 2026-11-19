/** FEATURE_311 step 3, manual L2 system+tools experiment: prepare → pilot → blind review → remaining → review → reveal.
 * An SDK caller's default root (runs.start without mode or agentMode) moves from the direct engine (system.md,
 * task-only messages) to the managed Worker with its Run Context envelope. Arms come from real Runtime captures
 * (tests/managed-first-turn.capture.ts, KODAX_MANAGED_CAPTURE_ENTRY=sdk-default, builtin Skill catalog) on the
 * baseline and candidate trees. Never executes model-selected tools. Raw inputs, mapping and accounting stay in OS Temp.
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

const REVISION = 'f311-step3-sdk-default-root-r1';
const LIMITS = { calls: 48, perCell: 1, rounds: 1, output: 8192, tokens: 1_500_000, usd: 1, timeoutMs: 240_000 };
const PROTOCOL = {
  layer: 'L2',
  question: 'When an SDK default root moves from the direct engine (system.md, task-only messages) to the managed Worker with its Run Context envelope, are the next actions at parallel-dispatch, ownership, Todo continuation, question, edit-recovery, Memory, Skill-trigger and plain-lookup checkpoints preserved?',
  whyNotOfflineOnly: 'Entry routing, Worker bytes and tool texts are proven offline by tests/f311-entry-matrix.test.ts; model interpretation of a different system prompt and message shape is not.',
  sample: 'One observation per arm/case/model. Twelve pilot cells (D1, E1 and S1 on glm and deepseek); main-session task-validity review may stop without expanding. At most thirty-six remaining cells, never retries.',
  value: 'Preserve useful legal actions and recovery; load a matching Skill first and only then; avoid needless discovery, duplicate plans, repeated stale edits, split questions and unfaithful Memory writes. Judge necessary reconnaissance semantically.',
  attribution: ['eval-design', 'provider-noise', 'prompt-regression', 'inconclusive'],
  decision: 'Main-session blind review records validity, lift/harm, attribution and recommendation before labels or usage are revealed. No automatic ship gate.',
  limits: 'Single-response evidence cannot prove whole-task quality, turns or time. The arms differ in system, tools and message shape together: the direct engine has no Run Context envelope, so its checkpoint state is a separate user message before the task. The Runtime Host runs a default root as AMA, so both arms can dispatch child Agents.',
};
const ROUTES = [
  { id: 'glm', provider: 'zhipu-coding', model: 'glm-5.3-flash', env: 'ZHIPU_CODING_API_KEY' },
  { id: 'kimi', provider: 'kimi-code', model: 'kimi-for-coding', env: 'KIMI_CODE_API_KEY' },
  { id: 'deepseek', provider: 'deepseek', model: 'deepseek-flash', env: 'DEEPSEEK_API_KEY' },
] as const;
const CASES = ['D1', 'O1', 'T1', 'A1', 'E1', 'M1', 'S1', 'S2'] as const;
// Capture ids map onto the audited contract checkpoints; the rest are defined here.
const FIXTURE_CASE: Record<string, string> = { D1: 'P03', O1: 'P05', T1: 'P02', A1: 'P07', E1: 'C02' };
const LOCAL_CASES: Record<string, { state: string; rubric: string }> = {
  M1: { state: 'No plan or children. The user states a durable project preference; no code change is requested this turn.',
    rubric: 'Record the durable preference with the Memory tool, faithful in scope (this project) and content (Chinese commit messages, title within 50 characters). No code edit, Todo, child Agent or needless question. A short acknowledgement after the call is fine.' },
  S1: { state: 'Clean start. No plan or children. The builtin Skill catalog is listed in the request.',
    rubric: 'The request is a change review, which the listed code-review Skill covers: load it with the skill tool before other tools. Reviewing the diff without loading the Skill, or loading an unrelated Skill, is a miss.' },
  S2: { state: 'Clean start. No plan or children. The builtin Skill catalog is listed in the request.',
    rubric: 'A small factual lookup: read or search the cache client code and answer. No Skill matches, so loading one is a miss; a Todo plan or child Agent for this lookup is needless.' },
};
type Pair = { route: string; caseId: string };
type Cell = Pair & { arm: 'A' | 'B'; input: FrozenInput };
interface CaseRecord { id: string; task: string; state: string; rubric: string }
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
const isPilotCell = (cell: Pair) => cell.route !== 'kimi' && ['D1', 'E1', 'S1'].includes(cell.caseId);
const sources = ['tests/f311-sdk-default-root.eval.ts', 'tests/managed-first-turn.capture.ts', 'tests/first-turn-compact-contract-fixture.ts',
  'tests/first-turn-compact-contract-cases.ts', 'packages/coding/src/tools/tool-definitions.ts', 'packages/coding/src/prompts/static-text.json',
  'packages/coding/src/agents/worker-role-prompt.ts', 'packages/coding/src/prompts/capability-sections.ts',
  'packages/coding/src/task-engine/_internal/managed-task/role-prompt.ts', 'packages/coding/src/task-engine/runner-driven.ts',
  'packages/coding/src/prompts/text/tools/tool-definitions.schemas.json', 'benchmark/EVAL_GUIDELINES.md'];

function assertTemp(root: string): void {
  const relative = path.relative(os.tmpdir(), root);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Raw output must be a child directory of OS Temp');
}

/** Replays fixture history against the captured workspace path of one arm. */
function replay(history: readonly KodaXMessage[], fixtureWorkspace: string, workspace: string): KodaXMessage[] {
  return JSON.parse(JSON.stringify(history).replaceAll(JSON.stringify(fixtureWorkspace).slice(1, -1), JSON.stringify(workspace).slice(1, -1))) as KodaXMessage[];
}

const checkpoint = (state: string) => `## Controlled checkpoint\n${state}`;

/** Managed arm: the checkpoint state joins the Run Context envelope, as in the step 1 and 2 experiments. */
function managedInput(captured: FrozenInput, task: string, state: string, history: readonly KodaXMessage[], fixtureWorkspace: string): FrozenInput {
  const [context, request, ...rest] = captured.messages;
  if (rest.length || typeof context?.content !== 'string' || request?.content !== task) throw new Error('Unexpected managed first request shape');
  if (!context.content.includes('=== End Managed Run Context ===')) throw new Error('Missing managed run context envelope');
  const workspace = /Session Scratch Directory: (.*?)[\\/]\.agent[\\/]/.exec(context.content)?.[1];
  if (!workspace) throw new Error('Captured managed workspace not found');
  const content = context.content.replace('=== End Managed Run Context ===', `${checkpoint(state)}\n=== End Managed Run Context ===`);
  return { system: captured.system, tools: captured.tools, messages: [{ ...context, content }, request, ...replay(history, fixtureWorkspace, workspace)] };
}

/** Direct arm: no envelope exists, so the same checkpoint state is a user message before the task. */
function directInput(captured: FrozenInput, task: string, state: string, history: readonly KodaXMessage[], fixtureWorkspace: string): FrozenInput {
  const [request, ...rest] = captured.messages;
  if (rest.length || request?.content !== task) throw new Error('Unexpected direct first request shape');
  const workspace = /^Working Directory: (.+?)\r?$/m.exec(captured.system)?.[1];
  if (!workspace) throw new Error('Captured direct workspace not found');
  return { system: captured.system, tools: captured.tools,
    messages: [{ role: 'user', content: checkpoint(state) }, request, ...replay(history, fixtureWorkspace, workspace)] };
}

async function prepare(root: string, captures: string) {
  if (!captures) throw new Error('--captures <directory with capture-{base,cand}-sdk-default.json> required');
  await fs.mkdir(root, { recursive: false });
  const fixture = await prepareContractFixture(root);
  const [base, cand] = await Promise.all(['base', 'cand'].map(arm => read<Capture>(path.join(captures, `capture-${arm}-sdk-default.json`))));
  const cells: Cell[] = []; const mapping: (Pair & { A: string; B: string })[] = []; const cases: CaseRecord[] = [];
  for (const id of CASES) {
    const baseline = base!.cases.find(item => item.id === id)!; const candidate = cand!.cases.find(item => item.id === id)!;
    if (baseline.task !== candidate.task) throw new Error(`${id}: task differs between captures`);
    if (!baseline.input.system.includes('helpful multi-provider coding agent')) throw new Error(`${id}: baseline is not the direct engine`);
    if (candidate.input.system.includes('helpful multi-provider coding agent')) throw new Error(`${id}: candidate still sends system.md`);
    const source = FIXTURE_CASE[id] ? fixture.cases.find(item => item.id === FIXTURE_CASE[id])! : undefined;
    if (source && source.task !== candidate.task) throw new Error(`${id}: capture task differs from the audited checkpoint`);
    const state = source?.state ?? LOCAL_CASES[id]!.state; const rubric = source?.rubric ?? LOCAL_CASES[id]!.rubric;
    const history = source?.history ?? [];
    const next = managedInput(candidate.input, candidate.task, state, history, fixture.workspace);
    const prior = directInput(baseline.input, baseline.task, state, history, fixture.workspace);
    cases.push({ id, task: candidate.task, state, rubric });
    for (const route of ROUTES) {
      const reverse = randomInt(2) === 1;
      mapping.push({ route: route.id, caseId: id, A: reverse ? 'candidate' : 'baseline', B: reverse ? 'baseline' : 'candidate' });
      for (const [index, input] of (reverse ? [next, prior] : [prior, next]).entries()) cells.push({ route: route.id, caseId: id, arm: index === 0 ? 'A' : 'B', input });
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
