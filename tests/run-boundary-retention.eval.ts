/**
 * Manual Run-boundary retention eval; ordinary test runs never call a provider.
 * prepare: offline. A scripted Run 1 (fixed tool calls, no model) runs through
 *   the real Runtime twice: production retention (candidate) and retention
 *   disabled plus the pre-fix trust text (baseline). Captures each arm's last
 *   Run-1 request and first Run-2 request.
 * cache: per route, send each arm's two requests in order and read cache usage.
 * probe: L2 blind A/B of the first Run-2 request; one call per cell, no tools run.
 * variant-prepare / variant: r2 diagnostic of the candidate with the unchanged
 *   project snapshot restated in its update envelope.
 * task-register / task / task-analyze: r4 L3.5 two-Run full tasks on DeepSeek,
 *   one process per cell (KODAX_RETENTION_EVAL_CELL); model-chosen tools run
 *   inside the fixture guard. Arms stay sealed until blind-review.json exists.
 *   r4 supersedes r3, whose pilot was invalid from a harness defect.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomInt } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { it, vi } from 'vitest';
import { getProvider, getCostRate, calculateCost, type KodaXMessage, type KodaXStreamResult,
  type KodaXToolUseBlock, type KodaXProviderStreamOptions } from '../packages/llm/src/index.js';
import { observeProviderOperation, currentProviderRequestAttribution, runWithAdditionalProviderRequestObserver,
  type ProviderRequestObservation } from '../packages/llm/src/provider-request-observation.js';
import { PRODUCT_CASES, type ProductCaseId } from '../benchmark/datasets/product-multiturn/fixture.js';
import { runNaturalRuntime, type NaturalInvoke } from './shared-contract-natural-runtime.js';
import { firstTurnReasoningFor, inputHash, type FrozenInput } from './first-turn-eval-support.js';
import { settleComplexAttempt } from './first-turn-complex-budget.js';
import { WORKER_TRUST_BEFORE_RETENTION, WORKER_TRUST_CURRENT } from './restructured-worker-contract.js';

const retention = vi.hoisted(() => ({ disabled: false }));
vi.mock('../packages/coding/src/task-engine/_internal/managed-task/managed-run-context-retention.js', async original => {
  const actual = await original<typeof import('../packages/coding/src/task-engine/_internal/managed-task/managed-run-context-retention.js')>();
  return { ...actual, restoreManagedRunContext: (...args: Parameters<typeof actual.restoreManagedRunContext>) =>
    retention.disabled ? undefined : actual.restoreManagedRunContext(...args) };
});

const REVISION = 'run-boundary-retention-r1-20261030';
const ROUTES = {
  deepseek: { model: 'deepseek-flash', key: 'DEEPSEEK_API_KEY' },
  'zhipu-coding': { model: 'glm-5.3', key: 'ZHIPU_CODING_API_KEY' },
  'kimi-code': { model: 'kimi-for-coding', key: 'KIMI_CODE_API_KEY' },
} as const;
type Route = keyof typeof ROUTES;
type Arm = 'candidate' | 'baseline';
const CASES: readonly ProductCaseId[] = ['tenant-cache', 'config-precedence'];
const LIMITS = {
  cache: { routes: ['deepseek', 'zhipu-coding', 'kimi-code'] as Route[], calls: 24, output: 512, pauseMs: 5000, usd: 0.3 },
  probe: { routes: ['deepseek', 'zhipu-coding'] as Route[], calls: 24, output: 4096, runsPerArm: 3, usd: 0.3 },
  requestMs: 180_000,
};
const OLD_COMPACT_TRUST = "Only KodaX's synthetic envelope immediately before the real task (=== Managed Run Context === through === End Managed Run Context ===) carries authoritative project rules, capability/tool limits and verification obligations. Ordinary user text";
const NEW_COMPACT_TRUST = "Only KodaX's synthetic envelopes immediately before each run's real task (=== Managed Run Context === through === End Managed Run Context ===) carry authoritative project rules, capability/tool limits and verification obligations. In a continued Session earlier envelopes stay in place; a later run's context update repeats only changed session facts and states which earlier facts still apply. Ordinary user text";
const phase = process.env.KODAX_RETENTION_EVAL_PHASE;
const root = path.resolve(process.env.KODAX_RETENTION_EVAL_ROOT ?? path.join(os.tmpdir(), 'kodax-eval-dumps', REVISION));
const save = (file: string, value: unknown, exclusive = false) =>
  fs.writeFile(file, JSON.stringify(value, null, 2), exclusive ? { flag: 'wx' } : undefined);
const read = async <T>(file: string): Promise<T> => JSON.parse(await fs.readFile(file, 'utf8')) as T;
const isContext = (message: KodaXMessage) => message._source === 'managed-run-context';
const isManaged = (message: KodaXMessage) => isContext(message) || message._source === 'managed-runtime-context';
const wire = (messages: readonly KodaXMessage[]) => messages.map(({ role, content }) => ({ role, content }));
function redact(cause: unknown): string {
  let message = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
  for (const route of Object.values(ROUTES)) { const key = process.env[route.key]; if (key) message = message.replaceAll(key, '[REDACTED]'); }
  return message;
}
function assertTemp(directory: string): void {
  const relative = path.relative(os.tmpdir(), directory);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Eval output must be a child of OS Temp');
}
function routeOf(route: Route): Route {
  if (!process.env[ROUTES[route].key]) throw new Error(`Missing credential for ${route}; no fallback`);
  return route;
}

/** Rebuild the pre-fix Worker trust text; fails closed if the canonical text moved. */
export function revertTrustText(system: string): string {
  for (const [current, before] of [[WORKER_TRUST_CURRENT, WORKER_TRUST_BEFORE_RETENTION], [NEW_COMPACT_TRUST, OLD_COMPACT_TRUST]]) {
    const parts = system.split(current);
    if (parts.length === 2) return parts.join(before);
    if (parts.length > 2) throw new Error('Trust text repeated; refusing to rebuild baseline');
  }
  throw new Error('Current trust text not found; refusing to rebuild baseline');
}

interface Ledger { calls: number; usd: number; unknownUsage: number; stops: string[] }
/** Single attempt, frozen bytes; spend is settled from reported usage after each call. */
async function dispatch(route: Route, input: FrozenInput, output: number, ledger: Ledger, limit: { calls: number; usd: number }) {
  const rate = getCostRate(route, ROUTES[route].model);
  if (!rate) throw new Error(`No frozen cost rate for ${route}`);
  if (ledger.calls >= limit.calls || ledger.usd >= limit.usd) throw new Error('Phase budget exhausted');
  ledger.calls++;
  const facts: ProviderRequestObservation[] = [];
  const started = Date.now();
  let result: KodaXStreamResult | undefined;
  let error: string | null = null;
  try {
    const signal = AbortSignal.timeout(LIMITS.requestMs);
    result = await runWithAdditionalProviderRequestObserver(fact => facts.push(fact), () => observeProviderOperation(route, 'primary', undefined,
      () => getProvider(route).stream([...input.messages], [...input.tools], input.system, firstTurnReasoningFor(route),
        { modelOverride: ROUTES[route].model, maxOutputTokensOverride: output, singleAttempt: true } satisfies KodaXProviderStreamOptions, signal),
      undefined, signal));
  } catch (cause) { error = redact(cause); }
  const usage = result?.usage;
  // Unknown usage is charged as if every input byte were an uncached token plus the full output cap.
  if (usage) ledger.usd += calculateCost(rate, usage.inputTokens, usage.outputTokens, usage.cachedReadTokens ?? 0, usage.cachedWriteTokens ?? 0);
  else { ledger.unknownUsage++; ledger.usd += calculateCost(rate, Buffer.byteLength(JSON.stringify(input)), output); }
  const attempts = new Set(facts.filter(fact => fact.boundary === 'physical_attempt' && fact.state === 'started').map(fact => fact.requestId)).size;
  return { result, usage: usage ?? null, error, attempts, wallMs: Date.now() - started };
}
const tool = (id: string, name: string, input: Record<string, unknown>): KodaXToolUseBlock => ({ type: 'tool_use', id, name, input });
const reply = (calls: KodaXToolUseBlock[], text = ''): KodaXStreamResult => ({
  toolBlocks: calls, textBlocks: text ? [{ type: 'text', text }] : [], thinkingBlocks: [], stopReason: calls.length ? 'tool_use' : 'end_turn',
});
/** Fixed Run 1: read, repair with the case golden, run the public tests, report honestly. */
function scriptedRunOne(caseId: ProductCaseId, index: number): KodaXStreamResult {
  const definition = PRODUCT_CASES[caseId];
  if (index === 0) return reply([tool('read-entry', 'read', { path: definition.entry }), tool('read-tests', 'read', { path: 'tests/basic.test.js' })]);
  if (index === 1) return reply(Object.entries(definition.golden).map(([file, content], at) => tool(`repair-${at}`, 'write', { path: file, content })));
  if (index === 2) return reply([tool('public-tests', 'bash', { command: 'node --test' })]);
  return reply([], '已修复问题，公共测试通过；尚未新增专门的回归测试。');
}

interface Capture { directory: string; sessionId: string; provider: string; runOneLast: FrozenInput; runTwoFirst: FrozenInput }
async function captureArm(caseId: ProductCaseId, arm: Arm): Promise<Capture> {
  const directory = path.join(root, 'replays', `${caseId}-${arm}`);
  await fs.mkdir(path.dirname(directory), { recursive: true });
  await fs.mkdir(directory);
  const inputs: FrozenInput[] = [];
  retention.disabled = arm === 'baseline';
  try {
    const record = await runNaturalRuntime(directory, caseId, async (input, _signal, index, meta) => {
      if (meta.kind !== 'root' || index > 4) throw new Error(`${caseId}/${arm}: unexpected call ${index} (${meta.kind})`);
      inputs.push(input);
      return index < 4 ? scriptedRunOne(caseId, index) : reply([], 'Capture complete.');
    }, { workMode: 'coding', limits: { calls: 5, tools: 8, timeoutMs: 120_000 },
      followUps: [{ prompt: PRODUCT_CASES[caseId].followUp, permissionMode: 'full-access' }] });
    if (record.error || record.runs.map(run => run.requests).join() !== '4,1' || record.verification.public.status !== 0) {
      throw new Error(`${caseId}/${arm}: scripted Runs failed (${record.error ?? JSON.stringify(record.runs)})`);
    }
    const provider = inputs[4]!.system.match(/natural-runtime-[0-9a-f-]{36}/)?.[0];
    if (!provider) throw new Error(`${caseId}/${arm}: provider id not found`);
    return { directory, sessionId: record.runs[0]!.sessionId, provider, runOneLast: inputs[3]!, runTwoFirst: inputs[4]! };
  } finally { retention.disabled = false; }
}

function identityNormalizer(from: Capture, to: Capture): (text: string) => string {
  const pairs = [[from.directory, to.directory], [from.sessionId, to.sessionId], [from.provider, to.provider]]
    .flatMap(([a, b]) => [[a!, b!], [JSON.stringify(a).slice(1, -1), JSON.stringify(b).slice(1, -1)]]);
  return text => pairs.reduce((value, [a, b]) => value.replaceAll(a, b), text);
}
const sharedMessages = (before: FrozenInput, after: FrozenInput) => {
  const [a, b] = [wire(before.messages), wire(after.messages)];
  let shared = 0;
  while (shared < a.length && inputHash(a[shared]) === inputHash(b[shared])) shared++;
  return shared;
};
interface ArmInputs { runOneLast: FrozenInput; runTwoFirst: FrozenInput; hash: string }
interface Pair { caseId: ProductCaseId; followUp: string; arms: Record<Arm, ArmInputs> }
const arm = (runOneLast: FrozenInput, runTwoFirst: FrozenInput): ArmInputs =>
  ({ runOneLast, runTwoFirst, hash: inputHash({ runOneLast, runTwoFirst }) });

/**
 * Both arms share the candidate's ordinary history bytes. Baseline = pre-fix
 * layout (stripped history + one full envelope before the follow-up) and the
 * pre-fix trust text. Replay noise such as test durations is reported.
 */
async function preparePairs(): Promise<void> {
  const pairs: Pair[] = [];
  const diagnostics = [];
  for (const caseId of CASES) {
    const candidate = await captureArm(caseId, 'candidate');
    const baseline = await captureArm(caseId, 'baseline');
    const normalize = identityNormalizer(baseline, candidate);
    const candidateContexts = candidate.runTwoFirst.messages.filter(isContext);
    const baselineContexts = baseline.runTwoFirst.messages.filter(isContext);
    if (baselineContexts.length !== 1 || String(baselineContexts[0]!.content).includes('Context update for this task.')) throw new Error(`${caseId}: baseline is not one full envelope`);
    if (candidateContexts.length !== 2 || !String(candidateContexts[1]!.content).includes('Context update for this task.')) throw new Error(`${caseId}: candidate did not retain and update`);
    const ordinary = (messages: readonly KodaXMessage[]) => messages.filter(message => !isManaged(message));
    const candidateOrdinary = ordinary(candidate.runTwoFirst.messages);
    const baselineOrdinary = ordinary(baseline.runTwoFirst.messages).map(message => ({ ...message, content: JSON.parse(normalize(JSON.stringify(message.content))) }));
    if (candidateOrdinary.length !== baselineOrdinary.length) throw new Error(`${caseId}: ordinary history length differs`);
    const last = candidateOrdinary.at(-1)!;
    if (last.role !== 'user' || last.content !== PRODUCT_CASES[caseId].followUp) throw new Error(`${caseId}: last message is not the follow-up`);
    const envelope = { ...baselineContexts[0]!, content: normalize(String(baselineContexts[0]!.content)) };
    const baselineRunTwo: FrozenInput = { system: revertTrustText(candidate.runTwoFirst.system),
      messages: [...candidateOrdinary.slice(0, -1), envelope, last], tools: candidate.runTwoFirst.tools };
    const baselineRunOne: FrozenInput = { ...candidate.runOneLast, system: revertTrustText(candidate.runOneLast.system) };
    const pair: Pair = { caseId, followUp: last.content, arms: {
      candidate: arm(candidate.runOneLast, candidate.runTwoFirst), baseline: arm(baselineRunOne, baselineRunTwo) } };
    pairs.push(pair);
    diagnostics.push({ caseId, ordinaryMessages: candidateOrdinary.length,
      ordinaryReplayDiffs: candidateOrdinary.flatMap((message, index) => inputHash(wire([message])) === inputHash(wire([baselineOrdinary[index]!])) ? [] : [index]),
      replaySystemsEqual: normalize(baseline.runTwoFirst.system) === candidate.runTwoFirst.system,
      replayToolsEqual: inputHash(baseline.runTwoFirst.tools) === inputHash(candidate.runTwoFirst.tools),
      replayRunOneEqual: normalize(JSON.stringify(wire(baseline.runOneLast.messages))) === JSON.stringify(wire(candidate.runOneLast.messages)),
      candidateSharedMessages: sharedMessages(candidate.runOneLast, candidate.runTwoFirst), candidatePreviousMessages: candidate.runOneLast.messages.length,
      baselineSharedMessages: sharedMessages(baselineRunOne, baselineRunTwo),
      runTwoMessages: { candidate: candidate.runTwoFirst.messages.length, baseline: baselineRunTwo.messages.length },
      envelopeChars: { full: String(envelope.content).length, update: String(candidateContexts[1]!.content).length },
      runTwoBytes: { candidate: Buffer.byteLength(JSON.stringify(candidate.runTwoFirst)), baseline: Buffer.byteLength(JSON.stringify(baselineRunTwo)) } });
  }
  await save(path.join(root, 'pairs.json'), pairs, true);
  await save(path.join(root, 'pairs-diagnostics.json'), diagnostics, true);
  process.stdout.write(JSON.stringify(diagnostics, null, 2) + '\n');
}
async function loadPairs(): Promise<Pair[]> {
  const pairs = await read<Pair[]>(path.join(root, 'pairs.json'));
  for (const pair of pairs) for (const inputs of Object.values(pair.arms)) {
    if (inputHash({ runOneLast: inputs.runOneLast, runTwoFirst: inputs.runTwoFirst }) !== inputs.hash) throw new Error(`${pair.caseId}: frozen pair changed`);
  }
  return pairs;
}

/** Per route and arm: the last Run-1 request, then the first Run-2 request. Baseline first. */
async function runCache(): Promise<void> {
  const pairs = await loadPairs();
  const routes = LIMITS.cache.routes.map(routeOf);
  const planned = routes.length * pairs.length * 4;
  if (planned > LIMITS.cache.calls) throw new Error(`Planned ${planned} calls exceed ${LIMITS.cache.calls}`);
  const directory = path.join(root, 'cache');
  await fs.mkdir(directory);
  const ledgers = await Promise.all(routes.map(async route => {
    const ledger: Ledger = { calls: 0, usd: 0, unknownUsage: 0, stops: [] };
    const rows = [];
    lane: for (const pair of pairs) for (const armName of ['baseline', 'candidate'] as const) {
      const sent = [];
      for (const step of ['runOneLast', 'runTwoFirst'] as const) {
        const response = await dispatch(route, pair.arms[armName][step], LIMITS.cache.output, ledger, LIMITS.cache);
        await save(path.join(directory, `${route}-${pair.caseId}-${armName}-${step}.json`), { route, caseId: pair.caseId, arm: armName, step, ...response }, true);
        if (response.error || !response.usage || response.attempts !== 1) { ledger.stops.push(`${route}: ${response.error ?? 'usage/attempt mismatch'}`); break lane; }
        sent.push(response.usage);
        await delay(LIMITS.cache.pauseMs);
      }
      const [previous, next] = sent;
      rows.push({ route, caseId: pair.caseId, arm: armName, runOneInput: previous!.inputTokens, runTwoInput: next!.inputTokens,
        runTwoCacheRead: next!.cachedReadTokens ?? 0, runTwoUncached: next!.inputTokens - (next!.cachedReadTokens ?? 0),
        coverageOfRunOne: Number(((next!.cachedReadTokens ?? 0) / previous!.inputTokens).toFixed(3)) });
    }
    return { route, ledger, rows };
  }));
  await save(path.join(directory, 'summary.json'), ledgers, true);
  process.stdout.write(JSON.stringify(ledgers, null, 2) + '\n');
}
/** L2 blind A/B of the first Run-2 request; arm identities stay sealed until the review is written. */
async function runProbe(): Promise<void> {
  const pairs = await loadPairs();
  const routes = LIMITS.probe.routes.map(routeOf);
  const planned = routes.length * pairs.length * 2 * LIMITS.probe.runsPerArm;
  if (planned > LIMITS.probe.calls) throw new Error(`Planned ${planned} calls exceed ${LIMITS.probe.calls}`);
  const directory = path.join(root, 'probe');
  await fs.mkdir(directory);
  const mapping = Object.fromEntries(pairs.map(pair => [pair.caseId, randomInt(2) === 0
    ? { X: 'candidate', Y: 'baseline' } : { X: 'baseline', Y: 'candidate' }])) as Record<string, Record<'X' | 'Y', Arm>>;
  await save(path.join(directory, 'sealed-mapping.json'), mapping, true);
  const lanes = await Promise.all(routes.map(async route => {
    const ledger: Ledger = { calls: 0, usd: 0, unknownUsage: 0, stops: [] };
    const rows = [];
    lane: for (const pair of pairs) for (let run = 0; run < LIMITS.probe.runsPerArm; run++) {
      for (const label of run % 2 === 0 ? ['X', 'Y'] as const : ['Y', 'X'] as const) {
        const response = await dispatch(route, pair.arms[mapping[pair.caseId]![label]].runTwoFirst, LIMITS.probe.output, ledger, LIMITS.probe);
        const row = { caseId: pair.caseId, route, label, run, error: response.error, attempts: response.attempts,
          text: response.result?.textBlocks.map(block => block.text).join('\n') ?? '',
          toolCalls: response.result?.toolBlocks.map(({ name, input }) => ({ name, input })) ?? [],
          stopReason: response.result?.stopReason ?? null, usage: response.usage, wallMs: response.wallMs };
        await save(path.join(directory, `${pair.caseId}-${route}-${label}-${run}.json`), row, true);
        rows.push(row);
        if (response.error || response.attempts !== 1) { ledger.stops.push(`${route}: ${response.error ?? 'attempt mismatch'}`); break lane; }
      }
    }
    return { route, ledger, rows };
  }));
  const rows = lanes.flatMap(lane => lane.rows);
  const packet = pairs.map(pair => ({ caseId: pair.caseId, followUp: pair.followUp,
    responses: rows.filter(row => row.caseId === pair.caseId).map(({ route, label, run, text, toolCalls, stopReason, error }) =>
      ({ route, label, run, text, toolCalls, stopReason, error })) }));
  await save(path.join(directory, 'blind-packet.json'), packet, true);
  await save(path.join(directory, 'ledgers.json'), lanes.map(({ route, ledger }) => ({ route, ledger })), true);
  process.stdout.write(JSON.stringify({ ledgers: lanes.map(({ route, ledger }) => ({ route, ledger })), packet: path.join(directory, 'blind-packet.json') }) + '\n');
}

const VARIANT_REVISION = 'run-boundary-retention-r2-20261030';
const variantRoot = path.join(path.dirname(root), VARIANT_REVISION);
const VARIANT_LIMIT = { routes: ['deepseek', 'zhipu-coding'] as Route[], calls: 12, output: 4096, runsPerCase: 3, usd: 0.3 };

/** r2 diagnostic: the candidate request with the unchanged project snapshot restated in its update envelope. */
export function restateProjectSnapshot(runTwoFirst: FrozenInput): FrozenInput {
  const contexts = runTwoFirst.messages.filter(isContext);
  const snapshot = String(contexts[0]?.content ?? '').match(/^Project: [^\n]*(?:\n {2}[^\n]*)*/m)?.[0];
  const update = contexts[1];
  const anchor = 'Task-relevant memory hints';
  if (!snapshot || !update || contexts.length !== 2 || String(update.content).split(anchor).length !== 2
    || String(update.content).includes(snapshot)) {
    throw new Error('Unexpected candidate envelope layout; refusing to build the variant');
  }
  const content = String(update.content).replace(anchor, `${snapshot}\n\n${anchor}`);
  return { ...runTwoFirst, messages: runTwoFirst.messages.map(message => message === update ? { ...message, content } : message) };
}
interface VariantInput { caseId: ProductCaseId; runTwoFirst: FrozenInput; hash: string }
async function prepareVariant(): Promise<void> {
  await fs.mkdir(variantRoot);
  await save(path.join(variantRoot, 'preregistration.json'), VARIANT_PREREGISTRATION, true);
  const inputs: VariantInput[] = (await loadPairs()).map(pair => {
    const runTwoFirst = restateProjectSnapshot(pair.arms.candidate.runTwoFirst);
    return { caseId: pair.caseId, runTwoFirst, hash: inputHash(runTwoFirst) };
  });
  await save(path.join(variantRoot, 'inputs.json'), inputs, true);
  const added = inputs.map(input => ({ caseId: input.caseId, update: String(input.runTwoFirst.messages.filter(isContext)[1]!.content) }));
  process.stdout.write(JSON.stringify(added, null, 2) + '\n');
}
async function runVariant(): Promise<void> {
  const inputs = await read<VariantInput[]>(path.join(variantRoot, 'inputs.json'));
  for (const input of inputs) if (inputHash(input.runTwoFirst) !== input.hash) throw new Error(`${input.caseId}: frozen variant changed`);
  const routes = VARIANT_LIMIT.routes.map(routeOf);
  if (routes.length * inputs.length * VARIANT_LIMIT.runsPerCase > VARIANT_LIMIT.calls) throw new Error('Planned variant calls exceed the limit');
  const directory = path.join(variantRoot, 'probe');
  await fs.mkdir(directory);
  const lanes = await Promise.all(routes.map(async route => {
    const ledger: Ledger = { calls: 0, usd: 0, unknownUsage: 0, stops: [] };
    lane: for (const input of inputs) for (let run = 0; run < VARIANT_LIMIT.runsPerCase; run++) {
      const response = await dispatch(route, input.runTwoFirst, VARIANT_LIMIT.output, ledger, VARIANT_LIMIT);
      await save(path.join(directory, `${input.caseId}-${route}-variant-${run}.json`), { caseId: input.caseId, route, run, error: response.error,
        attempts: response.attempts, text: response.result?.textBlocks.map(block => block.text).join('\n') ?? '',
        toolCalls: response.result?.toolBlocks.map(({ name, input: args }) => ({ name, input: args })) ?? [],
        stopReason: response.result?.stopReason ?? null, usage: response.usage, wallMs: response.wallMs }, true);
      if (response.error || response.attempts !== 1) { ledger.stops.push(`${route}: ${response.error ?? 'attempt mismatch'}`); break lane; }
    }
    return { route, ledger };
  }));
  await save(path.join(directory, 'ledgers.json'), lanes, true);
  process.stdout.write(JSON.stringify(lanes) + '\n');
}
const VARIANT_PREREGISTRATION = {
  experiment: VARIANT_REVISION,
  basedOn: REVISION,
  reason: 'r1 unblinded: the candidate never read README.md in its first Run-2 response (0/12) while the baseline did (6/12; deepseek 5/6). The candidate update omits the unchanged project listing, which the baseline repeats right before the follow-up.',
  question: 'Does restating the unchanged project snapshot in the update envelope restore those contract reads?',
  design: 'The r1 candidate first Run-2 request with only the project snapshot inserted into its update envelope; same system, tools and history. Single attempt, no tool executed.',
  reuse: 'r1 baseline and candidate raw outputs are reused, not rerun.',
  review: 'Mechanical README/contract-read rate, then a main-session read of the variant outputs against the r1 rubric. Not blind relative to r1, whose mapping is known. Diagnostic for a design choice, not a ship decision.',
  decision: 'Deepseek reads recover to about the baseline rate: snapshot position is the main cause; propose restating it. No recovery: position alone does not explain it; examine the trust text before changing the design. Partial: report as inconclusive.',
  limits: VARIANT_LIMIT,
  stop: 'No retries or fallback. Stop a lane on its first provider or attempt mismatch.',
};

const TASK_REVISION = 'run-boundary-retention-r4-20261030';
const SUPERSEDED_TASK = 'run-boundary-retention-r3-20261030';
const taskRoot = path.join(path.dirname(root), TASK_REVISION);
const TASK_ROUTE = 'deepseek' satisfies Route;
const TASK_LIMITS = { cells: 4, calls: 32, tools: 80, tokens: 1_500_000, cellUsd: 0.035, totalUsd: 0.083,
  output: 8192, reserveMargin: 4096, requestMs: 180_000, timeoutMs: 600_000 };
const RETENTION_WORDING = ['In a continued Session', 'Context update for this task.'];
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FROZEN_SOURCES = [
  'packages/coding/src/task-engine/runner-driven.ts',
  'packages/coding/src/task-engine/_internal/managed-task/managed-run-context-retention.ts',
  'packages/coding/src/task-engine/_internal/managed-task/managed-run-context.ts',
  'packages/coding/src/task-engine/_internal/managed-task/role-prompt.ts',
  'packages/coding/src/task-engine/_internal/managed-task/role-prompts.ts',
  'packages/coding/src/agents/worker-role-prompt.ts',
  'packages/coding/src/prompts/compact-worker-contract.ts',
  'src/sdk-runtime.ts',
  'benchmark/datasets/product-multiturn/fixture.ts',
  'tests/shared-contract-natural-runtime.ts',
  'tests/restructured-worker-contract.ts',
];
interface TaskCell { cell: string; caseId: ProductCaseId }
interface TaskBudget { calls: number; chargedTokens: number; chargedUsd: number; reservedTokens: number;
  reservedUsd: number; unknownUsageCalls: number; stopped: boolean }
interface SentCall { input: FrozenInput; inputTokens: number }
type TaskRecord = Awaited<ReturnType<typeof runNaturalRuntime>>;
type InvokeMeta = Parameters<NaturalInvoke>[3];
const sha256 = async (file: string) => createHash('sha256').update(await fs.readFile(file)).digest('hex');
const clip = (text: string, limit: number) => (text.length > limit ? `${text.slice(0, limit)}…[+${text.length - limit} chars]` : text);
async function readIfPresent<T>(file: string): Promise<T | undefined> {
  try { return await read<T>(file); }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw cause; }
}

/** Seal arm order per case; cell-01 is the pilot. Cells of one case run back to back. */
async function registerTask(): Promise<void> {
  assertTemp(taskRoot);
  await fs.mkdir(taskRoot);
  await save(path.join(taskRoot, 'preregistration.json'), TASK_PREREGISTRATION, true);
  const cells: TaskCell[] = [];
  const mapping: Record<string, Arm> = {};
  for (const caseId of CASES) {
    const order: Arm[] = randomInt(2) === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline'];
    for (const armName of order) {
      const cell = `cell-0${cells.length + 1}`;
      cells.push({ cell, caseId });
      mapping[cell] = armName;
    }
  }
  const frozen = Object.fromEntries(await Promise.all(FROZEN_SOURCES.map(async file => [file, await sha256(path.join(repoRoot, file))])));
  await save(path.join(taskRoot, 'cells.json'), cells, true);
  await save(path.join(taskRoot, 'sealed-mapping.json'), mapping, true);
  await save(path.join(taskRoot, 'frozen-sources.json'), frozen, true);
  process.stdout.write(JSON.stringify({ cells, frozen: Object.keys(frozen).length }) + '\n');
}
/** Pre-fix request: trust text reverted where present; fails closed on any retention wording. */
function baselineInput(input: FrozenInput): FrozenInput {
  const hasTrust = [WORKER_TRUST_CURRENT, NEW_COMPACT_TRUST].some(text => input.system.includes(text));
  const system = hasTrust ? revertTrustText(input.system) : input.system;
  if (RETENTION_WORDING.some(text => system.includes(text))) throw new Error('Baseline system still carries retention wording');
  if (input.messages.some(message => JSON.stringify(message.content).includes(RETENTION_WORDING[1]!))) {
    throw new Error('Baseline request carries a context update');
  }
  return { ...input, system };
}
/** DeepSeek bills double on Beijing weekdays 9-12 and 14-18; the caps assume the idle rate. */
function isDeepSeekPeak(now = new Date()): boolean {
  const beijing = new Date(now.getTime() + 8 * 3_600_000);
  const day = beijing.getUTCDay();
  const hour = beijing.getUTCHours();
  return day >= 1 && day <= 5 && ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18));
}
async function assertTaskReady(cell: string): Promise<void> {
  if (await readIfPresent(path.join(taskRoot, 'STOP')) !== undefined) throw new Error('Experiment already stopped');
  const frozen = await read<Record<string, string>>(path.join(taskRoot, 'frozen-sources.json'));
  for (const [file, hash] of Object.entries(frozen)) {
    if (await sha256(path.join(repoRoot, file)) !== hash) throw new Error(`Frozen source changed: ${file}`);
  }
  if (isDeepSeekPeak()) throw new Error('DeepSeek peak pricing window; the idle-rate caps would not hold');
  const expected = path.join(taskRoot, cell, 'workspace', '.agent', 'tmp', 'tool-results');
  if (path.resolve(process.env.KODAX_TOOL_OUTPUT_DIR ?? '') !== expected) throw new Error(`Preload KODAX_TOOL_OUTPUT_DIR=${expected}`);
}
/** Spend of earlier cells, including any reservation a crashed cell left unsettled. */
async function spentBefore(cells: readonly TaskCell[]): Promise<number> {
  let usd = 0;
  for (const { cell } of cells) {
    const ledger = await readIfPresent<TaskBudget>(path.join(taskRoot, cell, 'ledger.json'));
    if (ledger) usd += ledger.chargedUsd + ledger.reservedUsd;
  }
  return usd;
}
/** One provider attempt with request observation; no retry. */
async function sendLive(input: FrozenInput, meta: InvokeMeta, outputCap: number, signal: AbortSignal) {
  const facts: ProviderRequestObservation[] = [];
  let result: KodaXStreamResult | undefined;
  let error: string | null = null;
  try {
    result = await runWithAdditionalProviderRequestObserver(fact => facts.push(fact), () => observeProviderOperation(TASK_ROUTE,
      meta.kind === 'auxiliary' ? 'sidecar' : 'primary', currentProviderRequestAttribution(),
      () => getProvider(TASK_ROUTE).stream([...input.messages], [...input.tools], input.system, meta.reasoning,
        { ...meta.streamOptions, modelOverride: ROUTES[TASK_ROUTE].model, maxOutputTokensOverride: outputCap, singleAttempt: true }, signal),
      undefined, signal));
  } catch (cause) { error = redact(cause); }
  return { result, error, facts };
}
/**
 * Input-token bound for one request: the previous request's reported input
 * tokens plus the bytes of every part this request does not share with it
 * (one byte never yields more than one token), else all bytes. A reported
 * usage above the bound stops the cell, so a wrong bound cannot repeat.
 */
export function inputTokenReserve(input: FrozenInput, previous: SentCall | undefined): number {
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
  if (!previous) return bytes(input) + TASK_LIMITS.reserveMargin;
  const unmatched = new Map<string, number>();
  for (const message of previous.input.messages) {
    const key = JSON.stringify(message);
    unmatched.set(key, (unmatched.get(key) ?? 0) + 1);
  }
  let added = input.system === previous.input.system ? 0 : bytes(input.system);
  if (inputHash(input.tools) !== inputHash(previous.input.tools)) added += bytes(input.tools);
  for (const message of input.messages) {
    const key = JSON.stringify(message);
    const left = unmatched.get(key) ?? 0;
    if (left > 0) unmatched.set(key, left - 1);
    else added += Buffer.byteLength(key);
  }
  return previous.inputTokens + added + TASK_LIMITS.reserveMargin;
}
/**
 * Reserve-then-settle invoke: each call reserves its input-token bound as
 * uncached tokens plus the full output cap, so no call can push spend past the cap.
 */
function liveInvoke(directory: string, armName: Arm, budget: TaskBudget, usdCap: number, abort: AbortController): NaturalInvoke {
  const rate = getCostRate(TASK_ROUTE, ROUTES[TASK_ROUTE].model);
  if (!rate) throw new Error('No frozen DeepSeek cost rate');
  let previous: SentCall | undefined;
  return async (frozen, signal, index, meta) => {
    signal.throwIfAborted(); abort.signal.throwIfAborted();
    if (budget.stopped) throw new Error('No dispatch after accounting/provider stop');
    const input = armName === 'baseline' ? baselineInput(frozen) : frozen;
    const outputCap = Math.min(TASK_LIMITS.output, meta.streamOptions?.maxOutputTokensOverride ?? TASK_LIMITS.output);
    const inputReserve = inputTokenReserve(input, previous);
    const reservedTokens = inputReserve + outputCap;
    const reservedUsd = calculateCost(rate, inputReserve, outputCap);
    if (budget.calls >= TASK_LIMITS.calls || budget.chargedTokens + budget.reservedTokens + reservedTokens > TASK_LIMITS.tokens
      || budget.chargedUsd + budget.reservedUsd + reservedUsd > usdCap) throw new Error('Hard cell budget exhausted');
    budget.calls++; budget.reservedTokens += reservedTokens; budget.reservedUsd += reservedUsd;
    await save(path.join(directory, `call-${index}.input.json`), { input, kind: meta.kind, reasoning: meta.reasoning,
      streamOptions: meta.streamOptions, outputCap }, true);
    await save(path.join(directory, 'ledger.json'), budget);
    const started = Date.now();
    const sent = await sendLive(input, meta, outputCap,
      AbortSignal.any([signal, abort.signal, AbortSignal.timeout(TASK_LIMITS.requestMs)]));
    const usage = sent.result?.usage;
    const usd = usage ? calculateCost(rate, usage.inputTokens, usage.outputTokens, usage.cachedReadTokens ?? 0, usage.cachedWriteTokens ?? 0) : undefined;
    const settlement = settleComplexAttempt({ reservedTokens, reservedUsd, facts: sent.facts, tools: input.tools.map(tool => tool.name),
      reasoning: meta.reasoning, outputCap, requestCancelled: signal.aborted, taskCancelled: meta.taskSignal?.aborted ?? abort.signal.aborted,
      failed: sent.error !== null, actualUsd: usd });
    budget.reservedTokens -= reservedTokens; budget.reservedUsd -= reservedUsd;
    budget.chargedTokens += settlement.chargedTokens; budget.chargedUsd += settlement.chargedUsd;
    if (settlement.unknownUsage) budget.unknownUsageCalls++;
    const overrun = usage !== undefined && (usage.inputTokens > inputReserve || usage.outputTokens > outputCap);
    const error = sent.error ?? (settlement.stop ? 'Physical attempt/usage mismatch' : overrun ? 'Reported usage above the reservation bound' : null);
    if (settlement.stop || overrun) { budget.stopped = true; abort.abort(new Error(error ?? 'Accounting stop')); }
    if (usage) previous = { input, inputTokens: usage.inputTokens };
    await save(path.join(directory, `call-${index}.json`), { result: sent.result, usage: usage ?? null, error, facts: sent.facts,
      settlement, inputReserve, referenceUsd: usd ?? null, wallMs: Date.now() - started }, true);
    await save(path.join(directory, 'ledger.json'), budget);
    if (error || !sent.result) throw new Error(error ?? 'Missing provider result');
    return sent.result;
  };
}
function boundaryRoots(record: TaskRecord) {
  const boundary = record.runs[0]?.requests ?? record.calls.length;
  const roots = record.calls.filter(call => call.kind === 'root');
  return { boundary, previous: roots.filter(call => call.index < boundary).at(-1), first: roots.find(call => call.index >= boundary) };
}
/** Each arm's own expected Run-2 layout; prefix and system facts are recorded, not gated. */
function taskLayout(record: TaskRecord, armName: Arm) {
  if (record.runs.length < 2) return { ok: true, checked: false, sealed: null };
  const { boundary, previous, first } = boundaryRoots(record);
  if (!previous || !first) return { ok: false, checked: true, sealed: null };
  const contexts = first.input.messages.filter(isContext);
  const update = contexts.some(message => String(message.content).includes(RETENTION_WORDING[1]!));
  const sealed = { boundary, previousIndex: previous.index, firstIndex: first.index, contexts: contexts.length, update,
    snapshotRestated: update && String(contexts.at(-1)!.content).includes('Project: '),
    sharedMessages: sharedMessages(previous.input, first.input), previousMessages: previous.input.messages.length,
    systemEqual: previous.input.system === first.input.system, toolsEqual: inputHash(previous.input.tools) === inputHash(first.input.tools) };
  const ok = armName === 'baseline' ? contexts.length === 1 && !update : contexts.length >= 2 && update;
  return { ok, checked: true, sealed };
}
async function workspaceFiles(workspace: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await fs.readdir(workspace, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const relative = path.relative(workspace, path.join(entry.parentPath, entry.name)).replaceAll('\\', '/');
    if (!/^\.(git|agent)\//.test(relative)) files[relative] = await fs.readFile(path.join(workspace, relative), 'utf8');
  }
  return files;
}
/** Arm-blind evidence for the main-session review: changed code, checks, reports and tool steps. */
function blindPacket(cell: string, caseId: ProductCaseId, record: TaskRecord, finalFiles: Record<string, string>) {
  const fixture: Readonly<Record<string, string>> = PRODUCT_CASES[caseId].files;
  const { boundary } = boundaryRoots(record);
  const results = new Map(record.events.filter(event => event.kind === 'result')
    .map(event => [String(event.id), clip(String(event.content ?? ''), 600)]));
  const steps = record.calls.map(call => ({ run: call.index < boundary ? 1 : 2, index: call.index, kind: call.kind,
    text: clip(call.result?.textBlocks.map(block => block.text).join('\n') ?? '', 600),
    tools: (call.result?.toolBlocks ?? []).map(block => ({ name: block.name, input: clip(JSON.stringify(block.input), 400),
      result: results.get(block.id) ?? null })),
    error: call.error ?? null }));
  const verification = Object.fromEntries(Object.entries(record.verification).map(([name, check]) => [name, { status: check.status,
    tail: clip(`${check.stdout.slice(-1500)}${check.stderr ? `\n[stderr] ${check.stderr.slice(-500)}` : ''}`, 2200) }]));
  return { cell, caseId, prompts: [PRODUCT_CASES[caseId].prompt, PRODUCT_CASES[caseId].followUp], readme: fixture['README.md'] ?? null,
    runs: record.runs.map(({ phase, requests, finalText }) => ({ phase, requests, finalText })),
    error: record.error, protectedUnchanged: record.protectedUnchanged, verification,
    changedFiles: Object.fromEntries(Object.entries(finalFiles).filter(([file, content]) => fixture[file] !== content)), steps };
}
const isCensored = (error: string | null) => error !== null && /budget-censored|Hard cell budget exhausted/.test(error);
/** One sealed two-Run cell; never reruns or overwrites a started cell. */
async function runTaskCell(cell: string): Promise<void> {
  const cells = await read<TaskCell[]>(path.join(taskRoot, 'cells.json'));
  const position = cells.findIndex(entry => entry.cell === cell);
  if (position < 0) throw new Error(`Unregistered cell: ${cell}`);
  if (position > 0 && !await readIfPresent(path.join(taskRoot, cells[position - 1]!.cell, 'summary.json'))) throw new Error('Run cells in order');
  routeOf(TASK_ROUTE);
  await assertTaskReady(cell);
  const usdCap = Math.min(TASK_LIMITS.cellUsd, TASK_LIMITS.totalUsd - await spentBefore(cells.slice(0, position)));
  if (usdCap <= 0) throw new Error('Global budget exhausted');
  const armName = (await read<Record<string, Arm>>(path.join(taskRoot, 'sealed-mapping.json')))[cell]!;
  const { caseId } = cells[position]!;
  const directory = path.join(taskRoot, cell);
  await fs.mkdir(directory);
  await save(path.join(directory, 'manifest.json'), { experiment: TASK_REVISION, cell, caseId, route: TASK_ROUTE,
    model: ROUTES[TASK_ROUTE].model, limits: { ...TASK_LIMITS, usdCap }, driverSha256: await sha256(fileURLToPath(import.meta.url)) }, true);
  const budget: TaskBudget = { calls: 0, chargedTokens: 0, chargedUsd: 0, reservedTokens: 0, reservedUsd: 0, unknownUsageCalls: 0, stopped: false };
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error('Whole cell timeout')), TASK_LIMITS.timeoutMs);
  retention.disabled = armName === 'baseline';
  try {
    const record = await runNaturalRuntime(directory, caseId, liveInvoke(directory, armName, budget, usdCap, abort), {
      workMode: 'coding', model: ROUTES[TASK_ROUTE].model, signal: abort.signal, maxOutputTokens: TASK_LIMITS.output,
      followUps: [{ prompt: PRODUCT_CASES[caseId].followUp, permissionMode: 'full-access' }],
      limits: { calls: TASK_LIMITS.calls, tools: TASK_LIMITS.tools, timeoutMs: TASK_LIMITS.timeoutMs }, reasoning: 'off', effort: 'none' });
    const layout = taskLayout(record, armName);
    const finalFiles = await workspaceFiles(record.prepared.workspace);
    await save(path.join(directory, 'layout-check.json'), { ok: layout.ok, checked: layout.checked }, true);
    await save(path.join(directory, 'layout-sealed.json'), layout.sealed, true);
    await save(path.join(directory, 'final-files.json'), finalFiles, true);
    await save(path.join(directory, 'blind.json'), blindPacket(cell, caseId, record, finalFiles), true);
    const censored = [record.error, ...record.calls.map(call => call.error ?? null)].some(isCensored);
    const outcome = record.error === null ? 'completed' : censored ? 'censored' : 'error';
    await save(path.join(directory, 'summary.json'), { cell, caseId, outcome, error: record.error, runs: record.runs.map(run => [run.phase, run.requests]),
      budget, layoutOk: layout.ok, protectedUnchanged: record.protectedUnchanged }, true);
    if (outcome === 'error' || budget.stopped || !layout.ok || !record.protectedUnchanged) {
      await save(path.join(taskRoot, 'STOP'), { cell, outcome, error: record.error, layoutOk: layout.ok, protectedUnchanged: record.protectedUnchanged });
    }
    process.stdout.write(JSON.stringify({ cell, caseId, outcome, runs: record.runs.map(run => [run.phase, run.requests]), calls: budget.calls,
      spentUsd: Number((budget.chargedUsd + budget.reservedUsd).toFixed(6)), layoutOk: layout.ok, oracle: record.verification.oracle.status,
      protectedUnchanged: record.protectedUnchanged, error: record.error }) + '\n');
  } catch (cause) {
    await save(path.join(taskRoot, 'STOP'), { cell, error: redact(cause) });
    await save(path.join(directory, 'driver-error.json'), { error: redact(cause), budget });
    throw new Error(redact(cause));
  } finally { clearTimeout(timer); retention.disabled = false; }
}
interface CallRecord { usage: { inputTokens: number; outputTokens: number; cachedReadTokens?: number } | null; referenceUsd: number | null }
/** Whole-task and Run-boundary cache facts from the saved per-call records. */
async function cellMetrics(directory: string, record: TaskRecord) {
  const { boundary, previous, first } = boundaryRoots(record);
  const calls = await Promise.all(record.calls.map(async call => ({ ...call,
    saved: await readIfPresent<CallRecord>(path.join(directory, `call-${call.index}.json`)) })));
  const usageOf = (index: number | undefined) => calls.find(call => call.index === index)?.saved?.usage ?? null;
  const total = { input: 0, output: 0, cacheRead: 0, referenceUsd: 0 };
  for (const { saved } of calls) {
    if (!saved?.usage) continue;
    total.input += saved.usage.inputTokens; total.output += saved.usage.outputTokens;
    total.cacheRead += saved.usage.cachedReadTokens ?? 0; total.referenceUsd += saved.referenceUsd ?? 0;
  }
  const [before, after] = [usageOf(previous?.index), usageOf(first?.index)];
  const runTwoReadme = calls.some(call => call.index >= boundary
    && (call.result?.toolBlocks ?? []).some(block => /readme/i.test(JSON.stringify(block.input))));
  return { requests: record.counts, total: { ...total, uncached: total.input - total.cacheRead },
    runTwoFirst: before && after ? { previousInput: before.inputTokens, input: after.inputTokens, cacheRead: after.cachedReadTokens ?? 0,
      uncached: after.inputTokens - (after.cachedReadTokens ?? 0),
      coverageOfPrevious: Number(((after.cachedReadTokens ?? 0) / before.inputTokens).toFixed(3)) } : null,
    runTwoReadme, oracle: record.verification.oracle.status, public: record.verification.public.status, wallMs: record.wallMs };
}
/** Unblind only after the main-session review is on disk. */
async function analyzeTask(): Promise<void> {
  const review = await readIfPresent(path.join(taskRoot, 'blind-review.json'));
  if (review === undefined) throw new Error('Write blind-review.json before unblinding');
  const mapping = await read<Record<string, Arm>>(path.join(taskRoot, 'sealed-mapping.json'));
  const rows = [];
  for (const { cell, caseId } of await read<TaskCell[]>(path.join(taskRoot, 'cells.json'))) {
    const directory = path.join(taskRoot, cell);
    const record = await readIfPresent<TaskRecord>(path.join(directory, 'result.json'));
    const summary = await readIfPresent<{ outcome: string; budget: TaskBudget }>(path.join(directory, 'summary.json'));
    rows.push({ cell, caseId, arm: mapping[cell], outcome: summary?.outcome ?? 'not-run', chargedUsd: summary?.budget.chargedUsd ?? null,
      layout: await readIfPresent(path.join(directory, 'layout-sealed.json')) ?? null,
      metrics: record ? await cellMetrics(directory, record) : null });
  }
  await save(path.join(taskRoot, 'unblinded-metrics.json'), rows, true);
  process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
}
/** Zero-call check of the r3 layout gate, blind packet and baseline guard on the offline restate-check replays. */
async function selfCheckTask(): Promise<void> {
  const replays = path.join(path.dirname(root), 'run-boundary-retention-restate-check-20261030', 'replays');
  const rows = [];
  for (const caseId of CASES) for (const armName of ['baseline', 'candidate'] as const) {
    const directory = path.join(replays, `${caseId}-${armName}`);
    const record = await read<TaskRecord>(path.join(directory, 'result.json'));
    const other: Arm = armName === 'baseline' ? 'candidate' : 'baseline';
    const runTwoFirst = boundaryRoots(record).first!.input;
    let guard = 'accepted';
    try { baselineInput(runTwoFirst); } catch (cause) { guard = cause instanceof Error ? cause.message : String(cause); }
    const packet = JSON.stringify(blindPacket('cell-xx', caseId, record, await workspaceFiles(record.prepared.workspace)));
    rows.push({ caseId, armName, own: taskLayout(record, armName), crossOk: taskLayout(record, other).ok, guard,
      packetChars: packet.length, packetLeaks: RETENTION_WORDING.concat('Managed Run Context').filter(text => packet.includes(text)),
      metrics: await cellMetrics(directory, record) });
  }
  process.stdout.write(JSON.stringify({ rows, reserve: await checkReserveOnPilot() }, null, 2) + '\n');
}
/** The input-token bound against every reported usage of the superseded r3 pilot (the only live usage on disk). */
async function checkReserveOnPilot() {
  const directory = path.join(path.dirname(taskRoot), SUPERSEDED_TASK, 'cell-01');
  let previous: SentCall | undefined;
  let minSlack = Infinity;
  let pairs = 0;
  for (let index = 0; ; index++) {
    const saved = await readIfPresent<CallRecord>(path.join(directory, `call-${index}.json`));
    if (!saved?.usage) break;
    const { input } = await read<{ input: FrozenInput }>(path.join(directory, `call-${index}.input.json`));
    if (previous) { minSlack = Math.min(minSlack, inputTokenReserve(input, previous) - saved.usage.inputTokens); pairs++; }
    previous = { input, inputTokens: saved.usage.inputTokens };
  }
  return { pairs, minSlack, held: pairs > 0 && minSlack > 0 };
}
const TASK_PREREGISTRATION = {
  experiment: TASK_REVISION,
  basedOn: [REVISION, VARIANT_REVISION],
  supersedes: {
    experiment: SUPERSEDED_TASK,
    status: 'eval-invalid at the pilot; arm mapping left sealed and unused.',
    reason: 'Harness defect. Reserving every input byte as an uncached token refused request 25 (Run 2) at the $0.035 cell cap after $0.0119 of real spend. The Runtime reported that refusal as "Provider request failed.", so the driver recorded a provider error instead of a censored cell.',
    chargedUsd: 0.0119,
    fixes: 'Input-token bound from the previous reported usage plus unshared bytes; a usage above the bound stops the cell; censoring is read from per-call errors. Cases, arms, rubric, call/tool/token caps and decision rules are unchanged.',
  },
  authorization: 'Owner, 2026-10-30: DeepSeek small full-task check, baseline vs new candidate, two cases, about 4 cells, hard cap under $0.10, R12-style limits; the agent loop may execute model-chosen tools on this machine. Later: run the paid calls directly in bypass mode; never expose plaintext keys.',
  question: 'With retained envelopes plus a context update that restates the project snapshot, does the candidate keep two-Run task quality and Run-2 behaviour, and does its first Run-2 request reuse the cached prefix in a live loop?',
  layer: 'L3.5 smoke, N=1 per case and arm. A check for candidate-only regressions and live engagement, not a baseline/candidate superiority claim.',
  arms: {
    candidate: 'Working tree: production retention plus the restated project snapshot.',
    baseline: 'Same process with Runtime retention restore disabled (strip + one full envelope, the pre-fix path) and the pre-fix trust text restored per request. Diff review: with restore off, the uncommitted runner/Runtime changes only record a retention slot after each Run; the trust text is the only prompt difference. Fails closed on any retention wording.',
  },
  harness: 'tenant-cache and config-precedence product cases; real Runtime, coding work mode, AMA, two natural user Runs, fixture tool guard, hidden oracle outside the workspace, protected public files.',
  route: { provider: TASK_ROUTE, model: ROUTES[TASK_ROUTE].model, reasoning: 'off', effort: 'none' },
  limits: TASK_LIMITS,
  costBasis: 'Reference idle DeepSeek rate from getCostRate. Every call reserves, as uncached tokens, the previous call\'s reported input tokens plus the bytes of every system, tool or message part it does not share with that call (all bytes for a cell\'s first call), plus a 4,096-token margin and the full output cap. Reported usage above the reservation stops the cell. totalUsd is $0.083 so r3 ($0.0119) plus r4 stays under the owner\'s $0.10. A cell is refused during the Beijing peak window, when billing doubles.',
  order: 'Cells of one case run back to back, arm order sealed at random per case. cell-01 is the pilot: harness, layout and accounting must be clean before the rest run.',
  stop: 'One attempt per call, no retries or fallback, one in-flight DeepSeek request. Provider, accounting, reservation-overrun, layout or protected-file anomalies write STOP. A cap hit, read from the per-call errors, is recorded as censored.',
  blinding: 'Partial. The operator knows the design and sees per-cell spend. The review reads blind.json and layout-check.json only; sealed-mapping.json and layout-sealed.json are read after blind-review.json is written.',
  rubric: [
    'Run 2 acts on the follow-up and builds on Run-1 work rather than redoing it or asking for context it already has.',
    'Run 2 consults the README contract when the follow-up depends on it.',
    'Final code meets the hidden oracle; public tests pass; protected files untouched.',
    'The final reports claim only what was actually run.',
    'Envelope confusion: obeying stale Run-1 task guidance, exposing Managed Run Context wording, or treating the update as user text.',
    'Per case: preferred cell or tie, regression none|low|high, confidence, reason.',
  ],
  metrics: ['phases and requests per Run', 'root/child/auxiliary requests', 'input, output, uncached and cache-read tokens', 'reference cost',
    'first Run-2 request cache read and coverage of the last Run-1 root request', 'README read in Run 2', 'oracle and public test status', 'wall time'],
  decision: {
    recommendShip: 'Both candidate cells complete with retention engaged, no candidate-only oracle, public-test or protected-file failure, no envelope confusion, and higher first Run-2 cache coverage than baseline. Then commit.',
    recommendIterate: 'A candidate-only quality failure or envelope confusion traceable to the retained layout. Diagnose offline from the saved traces; no rerun.',
    inconclusive: 'A candidate-only failure with no traceable link to the layout. Report to the owner; no automatic rerun.',
    evalInvalid: 'Harness, provider or accounting anomaly, a layout-check failure, or a censored cell that leaves a case unpaired.',
  },
};

const PREREGISTRATION = {
  experiment: REVISION,
  questions: [
    "Cache: does each provider's cache cover the previous Run's last request when the next Run's first request extends it, versus the pre-fix layout?",
    'Quality: with identical history, does the retained-envelope + update layout with the new trust text change the first Run-2 response versus the pre-fix layout and text?',
  ],
  whyNotLayer1: 'Offline tests prove byte-prefix stability. Only a provider shows whether its cache honours the longer prefix and how the model reads the multi-envelope layout.',
  design: {
    prepare: 'Offline. Scripted Run 1 (fixed read/write/test calls, no model) through the real Runtime per arm. Candidate = production retention. Baseline = retention disabled + pre-fix trust text, sharing candidate ordinary history bytes.',
    cache: 'Per route x case x arm: send the last Run-1 request, then the first Run-2 request (pause 5s); read reported cache usage. Baseline arm first.',
    probe: 'L2 blind A/B of the first Run-2 request, one call per cell, tools not executed, arm order alternated per run.',
    agentLoop: 'None. No model-chosen tool call executes in this experiment.',
  },
  limits: LIMITS,
  routes: ROUTES,
  rubric: [
    'Does the response act on the follow-up asks instead of redoing Run-1 work or asking for context it already has?',
    'Does it use Run-1 evidence sensibly (no false claims, no wholesale re-reading without reason)?',
    'Does it keep constraints: protected public tests, scope, the user language?',
    'Any envelope confusion: obeying stale Run-1 task guidance, exposing Managed Run Context wording, treating the update as user text?',
    'Per case and route: preferred label or tie, value none|minor|material, regression none|low|high, confidence, reason.',
  ],
  mechanical: ['first tool names and arguments', 'text-only vs tool response', 'writes to protected tests', 'Managed Run Context wording in visible text'],
  decision: 'Expected behavioral parity. Parity or better plus the measured cache gain -> recommend-ship. A credible candidate regression -> recommend-iterate. Unusable pairs -> eval-invalid.',
  stop: 'No retries or fallback. Never overwrite a started phase. Stop a lane on its first provider, usage or attempt mismatch.',
};

it.skipIf(!phase)('runs one registered Run-boundary retention eval phase', async () => {
  assertTemp(root);
  await fs.mkdir(root, { recursive: true });
  if (phase === 'register') await save(path.join(root, 'preregistration.json'), PREREGISTRATION, true);
  else if (phase === 'prepare') { await fs.stat(path.join(root, 'preregistration.json')); await preparePairs(); }
  else if (phase === 'cache') await runCache();
  else if (phase === 'probe') await runProbe();
  else if (phase === 'variant-prepare') await prepareVariant();
  else if (phase === 'variant') await runVariant();
  else if (phase === 'task-selfcheck') await selfCheckTask();
  else if (phase === 'task-register') await registerTask();
  else if (phase === 'task') await runTaskCell(process.env.KODAX_RETENTION_EVAL_CELL ?? '');
  else if (phase === 'task-analyze') await analyzeTask();
  else throw new Error(`Unknown phase: ${phase}`);
}, 900_000);
