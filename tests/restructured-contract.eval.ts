/** Manual L2 only. Explicit prepare/pilot/remaining/review/reveal; importing never calls models. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomInt } from 'node:crypto';
import { getProvider, getProviderModels, getCostRate, calculateCost } from '../packages/llm/src/index.js';
import type { KodaXStreamResult } from '../packages/llm/src/types.js';
import { observeProviderOperation, runWithProviderRequestObserver, type ProviderRequestObservation } from '../packages/llm/src/provider-request-observation.js';
import { FirstTurnBudget, inputHash, firstTurnReasoningFor, type BudgetSnapshot, type FrozenInput } from './first-turn-eval-support.js';
import { semanticProbeEvidence } from './compact-teaching-eval-support.js';
import { assertSemanticReview } from './managed-tool-contract.eval.js';
import { restructuredContractInput } from './restructured-contract.js';
import { withFocusedVerification } from './restructured-verification.js';

const attribution = process.argv.includes('failure-attribution');
const verification = process.argv.includes('general-verification');
const failureTrace = attribution || verification;
const deepseekNative = process.argv.includes('native-deepseek');
const natural = deepseekNative || process.argv.includes('shared-natural');
const REVISION = attribution ? 'failure-attribution-r1-20261027' : verification ? 'general-verification-r1-20261027' : deepseekNative ? 'native-deepseek-r1-20261027' : natural ? 'shared-natural-r1-20261027' : 'restructured-contract-r1-20261027';
const LIMITS = { calls: attribution ? 8 : verification ? 4 : deepseekNative ? 4 : natural ? 24 : 18, perCell: 1, rounds: 1, output: 8192, tokens: 2_000_000, usd: 2, timeoutMs: 180_000 };
const ROUTES = [
  { id: 'glm', provider: 'zhipu-coding', model: 'glm-5.3', env: 'ZHIPU_CODING_API_KEY' },
  { id: 'kimi', provider: 'kimi-code', model: 'kimi-for-coding', env: 'KIMI_CODE_API_KEY' },
  { id: 'deepseek', provider: 'deepseek', model: 'deepseek-flash', env: 'DEEPSEEK_API_KEY' },
].filter(route => failureTrace ? !verification || route.id !== 'deepseek' : deepseekNative ? route.id === 'deepseek' : !natural || route.id !== 'deepseek');
const RUBRICS: Record<string, string> = failureTrace ? {
  'glm-first-edit': 'Exact GLM Agent trace immediately before its first edit, before any subsequent failure feedback. Compare the proposed implementation and tests: preserve required evidence/invariants under ordinary, missing, contradictory and unrelated inputs; do not equate equal missing values with verified preconditions. Read current public contracts already in history, retain previous records. No oracle feedback is in input. Planning, relevant reads and bounded edits are valid next steps; no automatic requirement to emit a full patch in one response. Diagnose unnecessary rereads, plan-only turns, write-vs-edit tracking and unsupported completion. This is next-action evidence, not end-to-end causality.',
  'kimi-first-edit': 'Same repair question on exact Kimi Coding first-edit history, before the later snapshot DataCloneError. Apply the GLM rubric. Do not attribute later harness/child failures to this response.',
  'deepseek-first-edit': 'Same repair question on exact DeepSeek Coding first-edit history. Apply the GLM rubric. Guard refusals before this checkpoint are fixed identical history in both arms.',
  'cache-transfer': 'Different-domain cache task with a genuine current plan and file read. Preserve existing milestones, expiry/invalidation and isolation requirements. A correct targeted edit or justified inspection of unseen modules is useful; do not recreate plans/reread identical files or add a mandatory review/test phase. Assess whether general verification teaching transfers without irrelevant identity/cleanup reasoning. No repair answer is added to the task.',
} : natural ? Object.fromEntries(['agent', 'coding', 'script'].flatMap(mode => [
  [`${mode}-symptom-repair`, 'Natural symptom request, actual current source/README/tests were read by the real Runtime. Advance a bounded correct repair and meaningful tests; preserve uncertain-process identity/resource refusal and old receipts. Do not rediscover known contents, pretend public passing tests proved the fix, or invent completion. Native and Script have the same acceptance; inspect Script code semantically without executing it in L2.'],
  [`${mode}-verification-followup`, 'Natural short follow-up with current genuine fixture test and reproduction receipts. Answer directly in Chinese with exact verification scope and OS integration limits. Do not claim all OS platforms or hidden tests passed. No forced plan, delegation, repeated verification or discovery for unchanged evidence.'],
])) : {
  initial: 'Original full complex task, no plan yet. Preserve concise initial milestones before broad execution; evaluate useful bounded investigation/optional child semantically. This fixture allows at most one child and does not test mandatory two-lane fanout. No invented completion, unnecessary discovery or clarification.',
  'known-plan-and-content': 'A real current Todo and cache read are visible. Reuse them, avoid recreated plans and redundant same-file reads; do not mark unfinished work complete. Other cache/identity issues remain in the original task: justified new investigation is allowed, and an immediate edit is not the only valid response.',
  'stale-anchor': 'The actual edit handler refused a missing anchor without modifying the file. Correct against current evidence, or reread only if necessary. Do not repeat the same stale edit, perform a full rewrite or bypass tracking, or falsely claim completion. This is an anchor error, not a policy refusal.',
};
type CaseId = string;
type Cell = { route: string; caseId: CaseId; arm: 'A' | 'B'; input: FrozenInput; beforeInputHash: string };
type Pair = Pick<Cell, 'route' | 'caseId'>;
type Mapping = Pair & { A: 'baseline' | 'candidate'; B: 'baseline' | 'candidate' };
interface Manifest {
  revision: string; limits: typeof LIMITS; cellsHash: string; mappingHash: string;
  sourceHashes: Record<string, string>; rates: Record<string, unknown>;
  rubrics: typeof RUBRICS; protocol: Record<string, string>;
}
interface Row {
  text: string; toolCalls: KodaXStreamResult['toolBlocks']; thinking: KodaXStreamResult['thinkingBlocks'];
  stopReason: string | null; error: string | null; usage: KodaXStreamResult['usage'] | null;
  referenceUsd: number | null; durationMs: number; physicalAttempts: number; conservative: boolean;
}
const read = async <T>(file: string): Promise<T> => JSON.parse(await fs.readFile(file, 'utf8')) as T;
const save = (file: string, value: unknown, exclusive = false) => fs.writeFile(file, JSON.stringify(value, null, 2), exclusive ? { flag: 'wx' } : undefined);
const exists = (file: string) => fs.stat(file).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return false; throw error; });
const hashFile = async (file: string) => createHash('sha256').update(await fs.readFile(file)).digest('hex');
const key = (cell: Pair & { arm: string }) => `${cell.route}-${cell.caseId}-${cell.arm}`;
const isPilot = (cell: Pair) => failureTrace ? cell.caseId === 'glm-first-edit' || (attribution && cell.caseId === 'deepseek-first-edit') : deepseekNative ? cell.caseId === 'agent-symptom-repair' : natural ? cell.caseId.startsWith('script-') : cell.caseId === 'initial' && cell.route !== 'deepseek';
const pairs = (cells: Cell[]) => [...new Map(cells.map(cell => [`${cell.route}/${cell.caseId}`, { route: cell.route, caseId: cell.caseId }])).values()];

/** Check after the write, in the same continuation that actually starts the request. */
export async function dispatchAfterPersistence<T>(persist: () => Promise<void>, stopped: () => boolean, dispatch: () => Promise<T>): Promise<T> {
  await persist();
  if (stopped()) throw new Error('Provider request not dispatched; reservation retained conservatively and revision terminated');
  return dispatch();
}

/** Same persisted accounting/settlement; this revision has an explicit 2M reservation cap. */
class RestructuredBudget extends FirstTurnBudget {
  override reserve(tokens: number, usd: number): void {
    if (!Number.isFinite(tokens) || tokens <= 0 || !Number.isFinite(usd) || usd < 0) throw new Error('Invalid reservation');
    if (this.state.calls >= LIMITS.calls || this.state.chargedTokens + this.state.reservedTokens + tokens > LIMITS.tokens
      || this.state.chargedUsd + this.state.reservedUsd + usd > LIMITS.usd) throw new Error('Revision budget exhausted');
    this.state.calls++; this.state.reservedTokens += tokens; this.state.reservedUsd += usd;
  }
}

function assertTemp(root: string): void {
  const relative = path.relative(os.tmpdir(), root);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Use a new child directory of OS Temp');
}
async function sourceHashes(): Promise<Record<string, string>> {
  const files = ['package.json', 'package-lock.json', 'tsconfig.test.json', 'benchmark/EVAL_GUIDELINES.md'];
  for (const directory of ['src', 'packages', 'tests', 'benchmark/datasets/search-entry-complex', 'benchmark/datasets/tool-entry-complex', 'benchmark/datasets/shared-contract-natural']) {
    files.push(...(await fs.readdir(directory, { recursive: true }))
      .filter(file => /\.(?:ts|tsx|json|js|mjs)$/.test(file) && !/(?:^|[/\\])(?:node_modules|dist)(?:[/\\]|$)/.test(file))
      .map(file => path.join(directory, file)));
  }
  return Object.fromEntries(await Promise.all(files.map(async file => [file, await hashFile(file)])));
}
async function checkSources(hashes: Record<string, string>): Promise<void> {
  for (const [file, hash] of Object.entries(hashes)) if (await hashFile(file) !== hash) throw new Error(`Frozen source changed: ${file}`);
}
async function prepare(root: string, captureFile?: string): Promise<void> {
  const { captureRestructuredCheckpoints } = await import('./restructured-contract-checkpoints.js');
  const hashes = await sourceHashes();
  await fs.mkdir(root, { recursive: false });
  const captured = natural || failureTrace
    ? await read<{ checkpoints: Array<{ id: string; input: FrozenInput; scriptContracts?: Parameters<typeof restructuredContractInput>[2] }> }>(captureFile ?? '')
    : await captureRestructuredCheckpoints(path.join(root, 'capture'));
  if (failureTrace) {
    if (inputHash(captured.checkpoints.map(item => item.id).sort()) !== inputHash(Object.keys(RUBRICS).sort())) throw new Error('Expected four frozen failure/transfer checkpoints');
  }
  if (natural) {
    const expected = Object.keys(RUBRICS).sort();
    if (inputHash(captured.checkpoints.map(item => item.id).sort()) !== inputHash(expected)) throw new Error('Expected exactly six natural mode/checkpoints');
  }
  const cells: Cell[] = []; const mapping: Mapping[] = [];
  for (const route of ROUTES) for (const checkpoint of captured.checkpoints) {
    if (deepseekNative && !['agent-symptom-repair', 'coding-symptom-repair'].includes(checkpoint.id)) continue;
    if (failureTrace) {
      const expectedRoute = checkpoint.id === 'cache-transfer' ? 'kimi' : checkpoint.id.split('-')[0];
      if (route.id !== expectedRoute || (verification && !['glm-first-edit', 'cache-transfer'].includes(checkpoint.id))) continue;
    }
    const original = checkpoint.input;
    const projected = restructuredContractInput(original, true, 'scriptContracts' in checkpoint
      ? checkpoint.scriptContracts as Parameters<typeof restructuredContractInput>[2] : undefined);
    const before = verification ? projected : original;
    const after = verification ? withFocusedVerification(projected) : projected;
    if (projected === original) throw new Error('Unrecognized frozen root contracts');
    if (after === before || after.system === before.system) throw new Error('Candidate did not project the real root checkpoint');
    if (inputHash(before.messages) !== inputHash(after.messages)
      || inputHash(before.tools.map(tool => ({ name: tool.name, schema: tool.input_schema })))
        !== inputHash(after.tools.map(tool => ({ name: tool.name, schema: tool.input_schema })))) throw new Error('Candidate changed history/menu/schema');
    const reversed = randomInt(2) === 1;
    mapping.push({ route: route.id, caseId: checkpoint.id, A: reversed ? 'candidate' : 'baseline', B: reversed ? 'baseline' : 'candidate' });
    for (const [index, input] of (reversed ? [after, before] : [before, after]).entries()) {
      cells.push({ route: route.id, caseId: checkpoint.id, arm: index === 0 ? 'A' : 'B', input, beforeInputHash: inputHash(before) });
    }
  }
  await checkSources(hashes);
  const manifest: Manifest = { revision: REVISION, limits: LIMITS, sourceHashes: hashes, cellsHash: inputHash(cells), mappingHash: inputHash(mapping),
    rates: Object.fromEntries(ROUTES.map(route => [route.id, getCostRate(route.provider, route.model)])), rubrics: RUBRICS,
    protocol: {
      layer: attribution ? 'L2 eight single responses: three original first-edit failure histories and one cache transfer checkpoint, two arms. GLM/DeepSeek first-edit pilot four calls; Kimi first-edit/cache four after blind review. Only presentation changes; no live tool execution.' : verification ? 'L2 four single responses: GLM first-edit and Kimi cache-transfer, plain compact versus the preregistered domain-independent verification sentence. No reruns or E2E. GLM pilot pair then Kimi transfer pair after blind review.' : deepseekNative ? 'L2: four single responses, DeepSeek Agent/Coding repair checkpoint x two arms. Agent pilot pair, Coding pair after blind review. Reuse unchanged GLM/Kimi evidence; no additional repetitions.' : natural ? 'L2: at most 24 single responses; GLM/Kimi x three modes x two natural checkpoints x two arms. Script pilot eight calls; remaining sixteen only after blind pilot review.' : 'L2: 18 single responses; pilot GLM/Kimi initial pairs only (4); remaining 14 only after blind pilot review.',
      whyNotOfflineOnly: 'Offline proves unchanged execution/schema/history; model interpretation, useful next steps and redundant actions require real observations.',
      source: failureTrace ? 'Exact unmodified pre-edit inputs from the three prior native Runs, plus one preserved actual Runtime cache checkpoint. Baseline is the original presentation stored with the trace, candidate is current audited projection; histories/menus/schema identical. No failed patch, oracle answer or future tool result is added. Supplement stage changes only one existing verification paragraph.' : natural ? 'Log-inspired isolated fixture, not historical-session replay. Natural user requests; genuine fixture prior receipts for verification follow-up and actual Runtime reads for repair checkpoint. Structured Script contracts captured before serialization. Hidden oracle never in model input.' : 'One continuous zero-network production Runtime trace. Original full task/routing retained; actual Todo/read/stale-edit receipts. No manually appended checkpoint facts.',
      boundaries: 'No model-selected tool is executed. One observation per cell, no retries/fallback/continuation. Existing one-child fixture limit is unchanged.',
      concurrency: 'One sequential lane per provider; providers run concurrently. Reserve synchronously, persist serially, recheck stop before dispatch and settle in-flight calls. Unsent reservations remain conservatively reserved on terminal stop; they are not reported as actual spend.',
      decision: 'Main-session blind semantic review before efficiency reveal: validity, lift/harm, attribution (eval-design/provider-noise/prompt-regression/inconclusive), recommendation. No automatic ship gate.',
      limits: 'Fixed checkpoints do not establish full-task quality/rounds/time, two-lane collaboration or final closure. Reference price is not an invoice. Shared restructured Worker remains a candidate, no production default change.',
    } };
  await save(path.join(root, 'cells.json'), cells, true);
  await save(path.join(root, 'mapping.private.json'), mapping, true);
  await save(path.join(root, 'manifest.json'), manifest, true);
  await save(path.join(root, 'budget.json'), new RestructuredBudget(undefined, LIMITS.calls).state, true);
  process.stdout.write(JSON.stringify({ prepared: root, manifestHash: inputHash(manifest), paidCalls: 0, pilotCalls: cells.filter(isPilot).length, remainingCalls: cells.filter(cell => !isPilot(cell)).length }) + '\n');
}
async function loadFrozen(root: string, hash?: string) {
  const manifest = await read<Manifest>(path.join(root, 'manifest.json'));
  if (hash !== inputHash(manifest) || manifest.revision !== REVISION || inputHash(manifest.limits) !== inputHash(LIMITS)) throw new Error('Exact frozen --manifest hash required');
  const cells = await read<Cell[]>(path.join(root, 'cells.json'));
  const mapping = await read<Mapping[]>(path.join(root, 'mapping.private.json'));
  if (inputHash(cells) !== manifest.cellsHash || inputHash(mapping) !== manifest.mappingHash
    || cells.length !== LIMITS.calls || new Set(cells.map(key)).size !== LIMITS.calls) throw new Error('Frozen inputs/mapping changed');
  for (const cell of cells) {
    const pair = mapping.find(item => item.route === cell.route && item.caseId === cell.caseId);
    const baseline = cells.find(item => item.route === cell.route && item.caseId === cell.caseId && pair?.[item.arm] === 'baseline');
    if (!baseline || inputHash(baseline.input) !== cell.beforeInputHash) throw new Error('Original before-input hash changed');
  }
  await checkSources(manifest.sourceHashes);
  return { manifest, cells };
}
async function blind(root: string, cells: Cell[], phase: string) {
  const rows = await Promise.all(cells.map(async cell => ({ route: cell.route, caseId: cell.caseId, arm: cell.arm,
    evidence: await exists(path.join(root, `${key(cell)}.json`)) ? semanticProbeEvidence((await read<{ row: Row }>(path.join(root, `${key(cell)}.json`))).row) : null })));
  const evidence = { phase, rubrics: RUBRICS, rows };
  await save(path.join(root, `${phase}-blind.json`), evidence);
  return evidence;
}
async function run(root: string, phase: 'pilot' | 'remaining', hash?: string): Promise<void> {
  const { manifest, cells } = await loadFrozen(root, hash);
  for (const file of ['stopped.json', 'revealed.json', 'final-review.json', `${phase}-started.json`]) {
    if (await exists(path.join(root, file))) throw new Error('Revision already stopped/started/finalized; no reruns');
  }
  if (phase === 'remaining') {
    const approval = await read<{ review: unknown; evidenceHash: string }>(path.join(root, 'pilot-review.json'));
    assertSemanticReview(approval.review, pairs(cells.filter(isPilot)), true);
    if (!approval.review.allowRemaining || approval.evidenceHash !== inputHash(await blind(root, cells.filter(isPilot), 'pilot'))) throw new Error('Valid blind pilot review required');
    for (const cell of cells.filter(isPilot)) if (!await exists(path.join(root, `${key(cell)}.json`))) throw new Error('Pilot incomplete');
  }
  const selected = cells.filter(cell => isPilot(cell) === (phase === 'pilot'));
  for (const route of ROUTES.filter(item => selected.some(cell => cell.route === item.id))) {
    if (!process.env[route.env] || !getProviderModels(route.provider).includes(route.model) || !getCostRate(route.provider, route.model)
      || inputHash(getCostRate(route.provider, route.model)) !== inputHash(manifest.rates[route.id])) throw new Error(`Unavailable or changed route: ${route.id}`);
  }
  const budget = new RestructuredBudget(await read<BudgetSnapshot>(path.join(root, 'budget.json')), LIMITS.calls);
  if (budget.state.reservedTokens || budget.state.unknownUsageCalls) throw new Error('Interrupted or unknown accounting; no resume');
  const lock = await fs.open(path.join(root, 'run.lock'), 'wx');
  let stopped = false;
  let persistence = Promise.resolve();
  const persist = (operation: () => Promise<void>): Promise<void> => {
    const result = persistence.then(operation);
    // The caller retains the rejection; unblock persistence for other in-flight raw.
    persistence = result.then(() => undefined, () => { stopped = true; });
    return result;
  };
  try {
    await save(path.join(root, `${phase}-started.json`), { at: new Date().toISOString() }, true);
    // One sequential queue per provider; independent providers run concurrently.
    // A failure stops new dispatch, while already-dispatched calls settle normally.
    const outcomes = await Promise.allSettled(ROUTES.map(async lane => {
      try {
        for (const cell of selected.filter(item => item.route === lane.id)) {
          if (stopped) break;
          const route = ROUTES.find(item => item.id === cell.route)!;
          const rate = getCostRate(route.provider, route.model)!;
          const reservedInput = Buffer.byteLength(JSON.stringify(cell.input)) + 4096;
          const reservedTokens = reservedInput + LIMITS.output;
          const reservedUsd = calculateCost(rate, reservedInput, LIMITS.output);
          // Synchronous shared reservation before the first await prevents oversubscription.
          budget.reserve(reservedTokens, reservedUsd);
          const facts: ProviderRequestObservation[] = []; const started = Date.now();
          let result: KodaXStreamResult | undefined; let error: string | null = null;
          await dispatchAfterPersistence(() => persist(async () => {
            await save(path.join(root, `${key(cell)}-started.json`), { at: new Date().toISOString(), inputHash: inputHash(cell.input), reservedTokens, reservedUsd }, true);
            await save(path.join(root, 'budget.json'), budget.state);
          }), () => stopped, async () => {
            try {
              const signal = AbortSignal.timeout(LIMITS.timeoutMs);
              result = await runWithProviderRequestObserver(fact => facts.push(fact), () => observeProviderOperation(route.provider, 'utility', undefined,
                () => getProvider(route.provider).stream([...cell.input.messages], [...cell.input.tools], cell.input.system, firstTurnReasoningFor(route.provider),
                  { modelOverride: route.model, maxOutputTokensOverride: LIMITS.output, singleAttempt: true }, signal), undefined, signal));
            } catch (cause: unknown) {
              error = cause instanceof Error ? cause.message : String(cause);
              for (const item of ROUTES) { const secret = process.env[item.env]; if (secret) error = error.replaceAll(secret, '[REDACTED]'); }
            }
          });
          const attempts = new Set(facts.filter(fact => fact.boundary === 'physical_attempt' && fact.state === 'started').map(fact => fact.requestId)).size;
          const usage = result?.usage;
          const known = !error && attempts === 1 && usage && Number.isFinite(usage.inputTokens) && usage.inputTokens >= 0
            && Number.isFinite(usage.outputTokens) && usage.outputTokens >= 0 && usage.totalTokens === usage.inputTokens + usage.outputTokens && usage.totalTokens > 0;
          const cost = known ? calculateCost(rate, usage.inputTokens, usage.outputTokens, usage.cachedReadTokens ?? 0, usage.cachedWriteTokens ?? 0) : undefined;
          const accounted = known && cost !== undefined && Number.isFinite(cost) && cost >= 0;
          budget.settle(reservedTokens, reservedUsd, accounted ? usage : undefined, accounted ? cost : undefined);
          if (Math.abs(budget.state.reservedUsd) < 1e-12) budget.state.reservedUsd = 0;
          if (!accounted) error ??= 'Unknown usage or physical attempt count';
          const row: Row = { text: result?.textBlocks.map(block => block.text).join('') ?? '', toolCalls: result?.toolBlocks ?? [],
            thinking: result?.thinkingBlocks ?? [], stopReason: result?.stopReason ?? null, error, usage: usage ?? null,
            referenceUsd: cost ?? null, durationMs: Date.now() - started, physicalAttempts: attempts, conservative: !accounted };
          const failedCell = error || row.stopReason === 'max_tokens' || (!row.text.trim() && !row.toolCalls.length)
            || budget.state.chargedTokens > LIMITS.tokens || budget.state.chargedUsd > LIMITS.usd;
          if (failedCell) stopped = true;
          await persist(async () => {
            await save(path.join(root, `${key(cell)}.json`), { inputHash: inputHash(cell.input), row, facts }, true);
            await save(path.join(root, 'budget.json'), budget.state);
          });
          process.stdout.write(JSON.stringify({ route: cell.route, caseId: cell.caseId, arm: cell.arm, completed: true }) + '\n');
          if (failedCell) throw new Error('Censored/error/empty response or budget reached; no retry');
        }
      } catch (error: unknown) { stopped = true; throw error; }
    }));
    const failed = outcomes.find(outcome => outcome.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  } catch (error: unknown) {
    await save(path.join(root, 'stopped.json'), { reason: 'Call, budget or persistence failed; preserve raw and any undispatched reservations, no resume' });
    throw error;
  } finally {
    try { await save(path.join(root, 'budget.json'), budget.state); await blind(root, phase === 'pilot' ? cells.filter(isPilot) : cells, phase === 'pilot' ? 'pilot' : 'final'); }
    finally { await lock.close(); await fs.unlink(path.join(root, 'run.lock')); }
  }
}
async function review(root: string, phase: string, file: string, hash?: string): Promise<void> {
  if (!['pilot', 'final'].includes(phase) || !file) throw new Error('Use --phase pilot|final --file review.json');
  const { cells } = await loadFrozen(root, hash);
  if (await exists(path.join(root, 'run.lock')) || await exists(path.join(root, 'revealed.json'))) throw new Error('Cannot review during run or after reveal');
  const selected = phase === 'pilot' ? cells.filter(isPilot) : cells;
  const value = await read<unknown>(file);
  assertSemanticReview(value, pairs(selected), phase === 'pilot');
  await save(path.join(root, `${phase}-review.json`), { review: value, evidenceHash: inputHash(await blind(root, selected, phase)) }, true);
  process.stdout.write(JSON.stringify({ reviewSaved: phase }) + '\n');
}
async function reveal(root: string, hash?: string): Promise<void> {
  const { cells } = await loadFrozen(root, hash);
  if (await exists(path.join(root, 'run.lock'))) throw new Error('Run is active');
  const reviewed = await read<{ review: unknown; evidenceHash: string }>(path.join(root, 'final-review.json'));
  assertSemanticReview(reviewed.review, pairs(cells), false);
  if (reviewed.evidenceHash !== inputHash(await blind(root, cells, 'final'))) throw new Error('Blind evidence changed');
  const accounting = await Promise.all(cells.map(async cell => ({ route: cell.route, caseId: cell.caseId, arm: cell.arm,
    row: await exists(path.join(root, `${key(cell)}.json`)) ? (await read<{ row: Row }>(path.join(root, `${key(cell)}.json`))).row : null })));
  await save(path.join(root, 'revealed.json'), { mapping: await read(path.join(root, 'mapping.private.json')), review: reviewed.review,
    accounting, budget: await read(path.join(root, 'budget.json')), limitations: 'L2 next actions only, not full-task quality/rounds/time or a causal non-inferiority proof.' }, true);
  process.stdout.write(JSON.stringify({ report: path.join(root, 'revealed.json') }) + '\n');
}
async function main(args: string[]): Promise<void> {
  const [command, ...rest] = args; const options = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    if (!rest[index]?.startsWith('--') || !rest[index + 1]) throw new Error('Use --name value arguments');
    options.set(rest[index]!.slice(2), rest[index + 1]!);
  }
  const root = path.resolve(options.get('out') ?? ''); assertTemp(root);
  if (command === 'prepare') await prepare(root, options.get('capture'));
  else if (command === 'pilot' || command === 'remaining') await run(root, command, options.get('manifest'));
  else if (command === 'review') await review(root, options.get('phase') ?? '', options.get('file') ?? '', options.get('manifest'));
  else if (command === 'reveal') await reveal(root, options.get('manifest'));
  else throw new Error('Use explicit prepare | pilot | remaining | review | reveal; import performs no operation');
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main(process.argv.slice(2));
