/**
 * FEATURE_308 experiment: can a guard lesson skip the second confirmation?
 *
 * A guard is a lesson from damage the session's own action did and traced: the
 * same action, with a step that prevents the damage. Each chain is session 1 ->
 * two reflection calls (production request, candidate request with the guard
 * paragraph and field) -> session 2 under four arms:
 *
 *   arm A  nothing from session 1 is stored
 *   arm C  production: production reflection answer, inferred notes stay candidates
 *   arm E  §18's no-quarantine reference: production answer, every inferred note active
 *   arm G  the rule under test: candidate answer; a write marked guard whose quote is
 *          found in local tool output is active at once, the rest stay candidates
 *
 * Session 2 runs up to three rounds against the case's fixed world. An arm whose
 * session-2 input is byte-identical to an earlier arm's reuses that trajectory.
 * Label-only cases (no session 2) make only the two reflection calls.
 *
 *   prepare  zero provider calls: gate check, case hash, input sizes
 *   run      paid calls; one in flight per alias; exact budget confirmation string
 *            (`--pilot` runs only ark/k27, repetition 1)
 *   pack     zero provider calls: mechanical scores, guard labels, blinded evidence
 */
import { appendFileSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  applyReflectionOperation,
  buildEvidence,
  quoteInEvidence,
  shouldReflect,
  type MemoryNote,
  type ReflectionOpInput,
} from '@kodax-ai/agent';
import type { KodaXAssistantBlock, KodaXContentBlock, KodaXMessage, KodaXTokenUsage, KodaXToolDefinition } from '@kodax-ai/llm';

import { buildReflectionRequest, parseReflectionCall, REFLECT_TOOL_NAME, SKILL_TOOL_NAME } from '../../../packages/coding/src/memory/note-reflection.js';
import { MODEL_ALIASES, type ModelAlias } from '../../harness/aliases.js';
import { runOneShot } from '../../harness/harness.js';
import type { ModelOutput, Scored } from '../feature-308-baseline/oracles.js';
import { estimateCost, ledgerState, readLedger, sha256, type LedgerEntry, type LedgerState } from '../feature-308-baseline/runner.js';
import { scoreCommand } from '../feature-308-inferred/oracles.js';
import { answerToolCall, noteFileMap, turnSettles } from '../feature-308-inferred/world.js';
import { buildNotesCellInputFrom, seedNotes, type SeededNotes } from '../feature-308-notes/inputs.js';
import { candidateRequest, marksGuard } from './candidate.js';
import { GUARD_CASES, REPLAYED_CASES, type GuardCase, type GuardKind } from './cases.js';

export const GUARD_REVISION = 'f308-guard-r1' as const;
export const GUARD_ALIASES: readonly ModelAlias[] = Object.freeze(['ark/k27', 'zhipu/glm52', 'ark/v4flash']);
export const GUARD_ROOT = path.join(os.tmpdir(), 'kodax-eval-dumps', 'feature-308', GUARD_REVISION);
const PILOT_ALIAS: ModelAlias = 'ark/k27';
const REPETITIONS = 3;
const MAX_ROUNDS = 3;
const BYTES_PER_TOKEN = 3;
const SESSION_ID = 'session-one';
type Arm = 'A' | 'C' | 'E' | 'G';
const ARMS: readonly Arm[] = ['A', 'C', 'E', 'G'];
type Reflection = 'reflect' | 'reflect-guard';
const CALLS_PER_REPLAYED_CHAIN = 2 + ARMS.length * MAX_ROUNDS;
const PLANNED_CALLS = GUARD_ALIASES.length * REPETITIONS
  * (REPLAYED_CASES.length * CALLS_PER_REPLAYED_CHAIN + (GUARD_CASES.length - REPLAYED_CASES.length) * 2);

export const GUARD_BUDGET = {
  /** Upper bound; reuse of identical inputs and early stops cut it well below. */
  plannedCalls: PLANNED_CALLS,
  maxProviderCalls: PLANNED_CALLS + 20,
  maxOutputTokensPerCall: 8192,
  /** Requests of about 12k input tokens each, rounded up. */
  maxTotalTokens: 16_000_000,
  maxExternalSpendUsd: 8,
  timeoutMs: 180_000,
} as const;

export const GUARD_BUDGET_CONFIRMATION =
  `${GUARD_REVISION}:calls=${GUARD_BUDGET.maxProviderCalls}:tokens=${GUARD_BUDGET.maxTotalTokens}:usd=${GUARD_BUDGET.maxExternalSpendUsd}` as const;

const aliasDir = (alias: ModelAlias): string => alias.replace('/', '_');

export interface Chain {
  readonly alias: ModelAlias;
  readonly item: GuardCase;
  readonly repetition: number;
}

const chainKey = (chain: Chain): string => `${aliasDir(chain.alias)}__${chain.item.id}__r${chain.repetition}`;

export function plannedChains(pilot = false): readonly Chain[] {
  const aliases = pilot ? [PILOT_ALIAS] : GUARD_ALIASES;
  const repetitions = pilot ? 1 : REPETITIONS;
  return aliases.flatMap((alias) => GUARD_CASES.flatMap((item) =>
    Array.from({ length: repetitions }, (_, index) => ({ alias, item, repetition: index + 1 }))));
}

// ---------------------------------------------------------------- files

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, filePath);
}

async function readJson<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

const callFile = (root: string, chain: Chain, name: string): string => path.join(root, 'calls', aliasDir(chain.alias), `${chainKey(chain)}__${name}.json`);
const roundName = (arm: Arm, round: number): string => `${arm}.round${round}`;

function appendLedger(root: string, entry: LedgerEntry): void {
  appendFileSync(path.join(root, 'ledger.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, 'utf8');
}

function assertLedgerAllows(state: LedgerState, key: string, alias: ModelAlias, estimatedInputTokens: number): void {
  const reserved = GUARD_BUDGET.maxOutputTokensPerCall;
  if (state.requestedCells.has(key)) throw new Error(`feature-308-guard per-call cap exceeded for ${key}`);
  if (state.calls + 1 > GUARD_BUDGET.maxProviderCalls) throw new Error('feature-308-guard provider call cap exceeded');
  if (state.committedTokens + estimatedInputTokens + reserved > GUARD_BUDGET.maxTotalTokens) throw new Error('feature-308-guard total token cap exceeded');
  if (state.committedUsd + estimateCost(alias, { inputTokens: estimatedInputTokens, outputTokens: reserved }) > GUARD_BUDGET.maxExternalSpendUsd) {
    throw new Error('feature-308-guard spend cap exceeded');
  }
}

async function filesUnder(dir: string): Promise<{ path: string; content: string }[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return Promise.all(entries.filter((entry) => entry.isFile()).map(async (entry) => {
    const file = path.join(entry.parentPath, entry.name);
    return { path: file, content: await readFile(file, 'utf8') };
  }));
}

// ---------------------------------------------------------------- inputs

interface ModelInput {
  readonly systemPrompt: string;
  readonly priorMessages?: readonly KodaXMessage[];
  readonly userMessage?: string;
  readonly tools: readonly KodaXToolDefinition[];
}

const sizeOf = (input: ModelInput): number => Math.ceil(Buffer.byteLength(JSON.stringify(input), 'utf8') / BYTES_PER_TOKEN);

export function reflectInput(item: GuardCase, which: Reflection): ModelInput {
  const production = buildReflectionRequest(buildEvidence(item.sessionOne), []);
  return which === 'reflect' ? production : candidateRequest(production);
}

/** The fixture directory and agent home are process-global and their path shows in the prompt, so building is serial. */
let fixtureLock: Promise<unknown> = Promise.resolve();
function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const next = fixtureLock.then(work, work);
  fixtureLock = next.catch(() => undefined);
  return next;
}

interface ToolCalls {
  readonly toolCalls: readonly { readonly name: string; readonly input: unknown }[];
}

export interface ArmState {
  readonly input: ModelInput;
  readonly inputHash: string;
  readonly notes: readonly MemoryNote[];
  readonly noteFiles: ReadonlyMap<string, string>;
  readonly trace: readonly string[];
}

const LOCAL_QUOTE_REFUSED = 'quote must be a full statement from a user message';

function parsed(call: { readonly input: unknown }): ReflectionOpInput | undefined {
  return typeof call.input === 'object' && call.input !== null ? parseReflectionCall(call.input as Record<string, unknown>) : undefined;
}

/** Applies the arm's reflection calls through the real host guards, then the arm's rule, and builds session 2. */
export function buildArm(item: GuardCase, arm: Arm, reflections: Readonly<Record<Reflection, ToolCalls>>): Promise<ArmState> {
  if (item.sessionTwo === undefined) throw new Error(`${item.id} is label-only`);
  const sessionTwo = item.sessionTwo;
  return exclusive(async () => {
    const seeded: SeededNotes = await seedNotes(`guard-${item.id}`, []);
    const evidence = buildEvidence(item.sessionOne);
    const context = { stores: seeded.stores, evidence, sessionId: SESSION_ID };
    const trace: string[] = [];
    const source = arm === 'G' ? reflections['reflect-guard'] : reflections.reflect;
    const calls = arm === 'A' ? [] : source.toolCalls.filter((call) => call.name === REFLECT_TOOL_NAME);
    for (const call of calls) {
      const op = parsed(call);
      if (op === undefined) {
        trace.push('? ?: malformed memory_reflect call');
        continue;
      }
      let outcome = await applyReflectionOperation(context, op);
      if (arm === 'E' && !outcome.ok && outcome.message.startsWith(LOCAL_QUOTE_REFUSED)
        && op.quote !== undefined && quoteInEvidence(evidence, op.quote, ['local'])) {
        const { quote: _quote, ...unquoted } = op;
        outcome = await applyReflectionOperation(context, unquoted satisfies ReflectionOpInput);
        trace.push(`${op.operation} ${op.id}: kept without its local quote -> ${outcome.message}`);
      } else {
        trace.push(`${op.operation} ${op.id}${marksGuard(call.input) ? ' [guard]' : ''}: ${outcome.message}`);
      }
      if (arm === 'G' && outcome.ok && op.operation === 'write' && marksGuard(call.input)) {
        const store = op.scope === 'user' ? seeded.stores.user : seeded.stores.project;
        const local = op.quote !== undefined && quoteInEvidence(evidence, op.quote, ['local']);
        const note = (await store.list()).find((candidate) => candidate.id === op.id);
        if (!local) trace.push(`G keeps ${op.id} a candidate: its quote is not local output`);
        else if (note?.status === 'candidate') {
          const done = await store.edit(op.id, { status: 'active' });
          trace.push(`G promotes guard ${op.id}: ${done.ok ? 'active' : 'failed'}`);
        }
      }
    }
    if (arm === 'E') {
      for (const store of [seeded.stores.project, seeded.stores.user]) {
        for (const note of await store.list()) {
          if (note.status !== 'candidate') continue;
          const done = await store.edit(note.id, { status: 'active' });
          trace.push(`E promotes ${note.id}: ${done.ok ? 'active' : 'failed'}`);
        }
      }
    }
    const notes = [...await seeded.stores.project.list(), ...await seeded.stores.user.list()];
    const input = await buildNotesCellInputFrom({ id: item.id, seeds: [], ...sessionTwo }, seeded);
    const noteFiles = noteFileMap([...await filesUnder(seeded.home), ...await filesUnder(seeded.cwd)]);
    return { input, inputHash: sha256(JSON.stringify(input)), notes, noteFiles, trace };
  });
}

/** The next round's input: the previous turn as production stores it, then the world's answers to its tool calls. */
function continueWith(item: GuardCase, state: ArmState, previous: ModelInput, call: Call): ModelInput {
  const world = item.world ?? { files: {} };
  const results: KodaXContentBlock[] = call.assistantContent.flatMap((block) => block.type !== 'tool_use' ? [] : [{
    type: 'tool_result' as const,
    tool_use_id: block.id,
    content: answerToolCall(world, state.noteFiles, block),
  }]);
  return {
    systemPrompt: previous.systemPrompt,
    tools: previous.tools,
    priorMessages: [
      ...(previous.priorMessages ?? []),
      ...(previous.userMessage === undefined ? [] : [{ role: 'user' as const, content: previous.userMessage }]),
      { role: 'assistant', content: [...call.assistantContent] as KodaXContentBlock[] },
      { role: 'user', content: results },
    ],
  };
}

// ---------------------------------------------------------------- prepare

export function caseHash(): string {
  return sha256(JSON.stringify(GUARD_CASES.map((item) => [
    item.id, item.kind, item.sessionOne, item.sessionTwo ?? null,
    item.oracle === undefined ? null : [String(item.oracle.pick), (item.oracle.needs ?? []).map(String), (item.oracle.avoid ?? []).map(String)],
    item.world === undefined ? null : [item.world.files, (item.world.commands ?? []).map((command) => [String(command.match), command.exit, command.stdout, command.stderr ?? ''])],
  ])));
}

export async function prepare(root: string = GUARD_ROOT): Promise<object> {
  const cases = GUARD_CASES.map((item) => ({
    id: item.id,
    kind: item.kind,
    gate: shouldReflect(item.sessionOne),
    reflectTokens: sizeOf(reflectInput(item, 'reflect')),
    candidateExtraTokens: sizeOf(reflectInput(item, 'reflect-guard')) - sizeOf(reflectInput(item, 'reflect')),
    replayed: item.sessionTwo !== undefined,
  }));
  const closed = cases.filter((item) => !item.gate);
  if (closed.length > 0) throw new Error(`session one of ${closed.map((item) => item.id).join(', ')} does not pass the reflection gate`);
  const empty = { toolCalls: [] };
  const sessionTwoTokens = sizeOf((await buildArm(REPLAYED_CASES[0]!, 'A', { reflect: empty, 'reflect-guard': empty })).input);
  await writeJsonAtomic(path.join(root, 'prepare.json'), { revision: GUARD_REVISION, caseHash: caseHash(), cases });
  return { chains: plannedChains().length, maxCalls: GUARD_BUDGET.plannedCalls, caseHash: caseHash(), cases, sessionTwoTokensEstimate: sessionTwoTokens };
}

// ---------------------------------------------------------------- run

interface Call {
  readonly text: string;
  readonly toolCalls: readonly { readonly name: string; readonly input: unknown }[];
  readonly assistantContent: readonly KodaXAssistantBlock[];
  readonly usage: KodaXTokenUsage;
  readonly durationMs: number;
  readonly estimatedCostUsd: number;
  readonly inputHash: string;
  readonly reusedFrom?: Arm;
}

async function callModel(root: string, alias: ModelAlias, key: string, input: ModelInput): Promise<Call> {
  const estimated = sizeOf(input);
  assertLedgerAllows(ledgerState(readLedger(root)), key, alias, estimated);
  appendLedger(root, { event: 'requested', cellKey: key, alias, estimatedInputTokens: estimated, reservedOutputTokens: GUARD_BUDGET.maxOutputTokensPerCall });
  try {
    const output = await runOneShot(alias, {
      systemPrompt: input.systemPrompt,
      ...(input.priorMessages === undefined ? {} : { priorMessages: input.priorMessages }),
      ...(input.userMessage === undefined ? {} : { userMessage: input.userMessage }),
      tools: input.tools,
      timeoutMs: GUARD_BUDGET.timeoutMs,
      maxOutputTokens: GUARD_BUDGET.maxOutputTokensPerCall,
    });
    if (output.usage === undefined) throw new Error('provider usage is missing');
    const estimatedCostUsd = estimateCost(alias, output.usage);
    appendLedger(root, { event: 'completed', cellKey: key, alias, usage: output.usage, estimatedCostUsd });
    return {
      text: output.text, toolCalls: output.toolCalls, assistantContent: output.assistantContent, usage: output.usage,
      durationMs: output.durationMs, estimatedCostUsd, inputHash: sha256(JSON.stringify(input)),
    };
  } catch (error) {
    appendLedger(root, { event: 'failed', cellKey: key, alias, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

/** Runs one call unless its result is already on disk (resume after an interruption). */
async function cached(file: string, root: string, alias: ModelAlias, key: string, input: ModelInput): Promise<Call> {
  const existing = await readJson<Call>(file);
  if (existing !== undefined) return existing;
  if (ledgerState(readLedger(root)).requestedCells.has(key)) throw new Error(`${key} was requested but has no result; inspect the ledger before retrying`);
  const result = await callModel(root, alias, key, input);
  await writeJsonAtomic(file, result);
  return result;
}

async function runArm(root: string, chain: Chain, arm: Arm, state: ArmState): Promise<readonly Call[]> {
  const oracle = chain.item.oracle!;
  const rounds: Call[] = [];
  let input = state.input;
  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    const call = await cached(callFile(root, chain, roundName(arm, round)), root, chain.alias, `${chainKey(chain)}:${roundName(arm, round)}`, input);
    rounds.push(call);
    if (turnSettles(oracle, call.toolCalls)) break;
    input = continueWith(chain.item, state, input, call);
  }
  return rounds;
}

async function reflectBoth(root: string, chain: Chain): Promise<Record<Reflection, Call>> {
  const key = chainKey(chain);
  const reflect = await cached(callFile(root, chain, 'reflect'), root, chain.alias, `${key}:reflect`, reflectInput(chain.item, 'reflect'));
  const guard = await cached(callFile(root, chain, 'reflect-guard'), root, chain.alias, `${key}:reflect-guard`, reflectInput(chain.item, 'reflect-guard'));
  return { reflect, 'reflect-guard': guard };
}

async function runChain(root: string, chain: Chain): Promise<void> {
  const reflections = await reflectBoth(root, chain);
  if (chain.item.sessionTwo === undefined) return;
  const trajectories = new Map<string, { arm: Arm; rounds: readonly Call[] }>();
  for (const arm of ARMS) {
    const state = await buildArm(chain.item, arm, reflections);
    const same = trajectories.get(state.inputHash);
    if (same === undefined) {
      trajectories.set(state.inputHash, { arm, rounds: await runArm(root, chain, arm, state) });
      continue;
    }
    for (const [index, call] of same.rounds.entries()) {
      const file = callFile(root, chain, roundName(arm, index + 1));
      if ((await readJson<Call>(file)) === undefined) await writeJsonAtomic(file, { ...call, reusedFrom: same.arm, estimatedCostUsd: 0 });
    }
  }
}

export async function run(confirmBudget: string, pilot: boolean, root: string = GUARD_ROOT): Promise<object> {
  if (confirmBudget !== GUARD_BUDGET_CONFIRMATION) throw new Error(`feature-308-guard paid run needs --confirm-budget ${GUARD_BUDGET_CONFIRMATION}`);
  const aliases = pilot ? [PILOT_ALIAS] : GUARD_ALIASES;
  const missing = aliases.filter((alias) => (process.env[MODEL_ALIASES[alias].apiKeyEnv] ?? '').length === 0);
  if (missing.length > 0) throw new Error(`feature-308-guard missing API key env for: ${missing.join(', ')}`);
  await prepare(root);
  let failure: unknown;
  const lane = async (alias: ModelAlias): Promise<void> => {
    for (const chain of plannedChains(pilot).filter((item) => item.alias === alias)) {
      if (failure !== undefined) return;
      try {
        await runChain(root, chain);
      } catch (error) {
        failure ??= error;
        throw error;
      }
    }
  };
  const settled = await Promise.allSettled(aliases.map(lane));
  const rejected = settled.find((item): item is PromiseRejectedResult => item.status === 'rejected');
  if (rejected !== undefined) throw rejected.reason;
  const { calls, committedTokens, committedUsd } = ledgerState(readLedger(root));
  return { ledger: { calls, committedTokens, committedUsd } };
}

// ---------------------------------------------------------------- pack

const asOutput = (rounds: readonly Call[]): ModelOutput => ({ text: rounds.at(-1)?.text ?? '', toolCalls: rounds.flatMap((round) => round.toolCalls) });

interface ArmResult {
  readonly rounds: readonly Call[];
  readonly scored: Scored;
  readonly state: ArmState;
}

async function loadRounds(root: string, chain: Chain, arm: Arm): Promise<readonly Call[]> {
  const rounds: Call[] = [];
  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    const call = await readJson<Call>(callFile(root, chain, roundName(arm, round)));
    if (call === undefined) break;
    rounds.push(call);
  }
  return rounds;
}

async function loadArms(root: string, chain: Chain, reflections: Record<Reflection, Call>): Promise<Record<Arm, ArmResult> | undefined> {
  const entries: [Arm, ArmResult][] = [];
  for (const arm of ARMS) {
    const rounds = await loadRounds(root, chain, arm);
    if (rounds.length === 0) return undefined;
    entries.push([arm, { rounds, scored: scoreCommand(chain.item.oracle!, asOutput(rounds)), state: await buildArm(chain.item, arm, reflections) }]);
  }
  return Object.fromEntries(entries) as Record<Arm, ArmResult>;
}

const passes = (items: readonly Scored[]): string =>
  `${items.filter((item) => item.verdict === 'pass').length} pass / ${items.filter((item) => item.verdict === 'fail').length} fail / ${items.filter((item) => item.verdict === 'needs_review').length} review`;

/** Fixed per-chain shuffle of the four arms, so the reviewer cannot tell which answer came from which rule. */
function blindOrder(key: string): readonly Arm[] {
  const order = [...ARMS];
  let seed = parseInt(sha256(key).slice(0, 8), 16);
  for (let index = order.length - 1; index > 0; index -= 1) {
    const pick = seed % (index + 1);
    seed = Math.floor(seed / (index + 1));
    [order[index], order[pick]] = [order[pick]!, order[index]!];
  }
  return order;
}

const briefCall = (call: { readonly name: string; readonly input: unknown }): string => `${call.name}: ${JSON.stringify(call.input).slice(0, 400)}`;

/** What one reflection answer wrote, and which writes it marked as guards. */
function writes(call: Call): { id: string; guard: boolean; quote: string | undefined; description: string | undefined; body: string | undefined; scope: string | undefined }[] {
  return call.toolCalls.filter((item) => item.name === REFLECT_TOOL_NAME).flatMap((item) => {
    const op = parsed(item);
    return op === undefined || op.operation !== 'write' ? [] : [{
      id: op.id, guard: marksGuard(item.input), quote: op.quote, description: op.description, body: op.body?.slice(0, 600), scope: op.scope,
    }];
  });
}

interface Row {
  readonly chain: Chain;
  readonly reflections: Record<Reflection, Call>;
  readonly arms?: Record<Arm, ArmResult>;
}

export async function pack(root: string = GUARD_ROOT, pilot = false): Promise<object> {
  const rows: Row[] = [];
  const missing: string[] = [];
  for (const chain of plannedChains(pilot)) {
    const reflect = await readJson<Call>(callFile(root, chain, 'reflect'));
    const guard = await readJson<Call>(callFile(root, chain, 'reflect-guard'));
    if (reflect === undefined || guard === undefined) {
      missing.push(chainKey(chain));
      continue;
    }
    const reflections = { reflect, 'reflect-guard': guard };
    if (chain.item.sessionTwo === undefined) {
      rows.push({ chain, reflections });
      continue;
    }
    const arms = await loadArms(root, chain, reflections);
    if (arms === undefined) missing.push(chainKey(chain));
    else rows.push({ chain, reflections, arms });
  }
  const replayed = rows.filter((row): row is Row & { arms: Record<Arm, ArmResult> } => row.arms !== undefined);
  const summarize = (subset: typeof replayed) => Object.fromEntries(ARMS.map((arm) => [arm, passes(subset.map((row) => row.arms[arm].scored))]));
  const labels = (subset: readonly Row[]) => {
    const candidateWrites = subset.flatMap((row) => writes(row.reflections['reflect-guard']));
    return {
      chainsWithProductionWrite: subset.filter((row) => writes(row.reflections.reflect).length > 0).length,
      chainsWithCandidateWrite: subset.filter((row) => writes(row.reflections['reflect-guard']).length > 0).length,
      candidateWrites: candidateWrites.length,
      markedGuard: candidateWrites.filter((item) => item.guard).length,
      chainsWithGuardActiveInG: subset.filter((row) => row.arms?.G.state.notes.some((note) => note.status === 'active') === true).length,
    };
  };
  const byCase = Object.fromEntries(GUARD_CASES.map((item) => {
    const subset = rows.filter((row) => row.chain.item.id === item.id);
    const replayedSubset = replayed.filter((row) => row.chain.item.id === item.id);
    return [item.id, { kind: item.kind, ...(item.sessionTwo === undefined ? {} : summarize(replayedSubset)), ...labels(subset) }];
  }));
  const kinds: readonly GuardKind[] = ['guard', 'lookalike', 'control'];
  const byKind = Object.fromEntries(kinds.map((kind) => [kind, summarize(replayed.filter((row) => row.chain.item.kind === kind))]));
  const byAlias = Object.fromEntries((pilot ? [PILOT_ALIAS] : GUARD_ALIASES).map((alias) => [alias, summarize(replayed.filter((row) => row.chain.alias === alias))]));
  const blind = replayed.map(({ chain, arms }) => {
    const key = chainKey(chain);
    const order = blindOrder(key);
    const letters = ['W', 'X', 'Y', 'Z'] as const;
    return {
      key,
      caseId: chain.item.id,
      truthForReviewer: chain.item.truth,
      sessionTwoRequest: chain.item.sessionTwo!.userMessage,
      answers: Object.fromEntries(order.map((arm, index) => [letters[index], {
        rounds: arms[arm].rounds.map((round) => ({ toolCalls: round.toolCalls.map(briefCall), text: round.text.slice(0, 800) })),
        visibleNotes: arms[arm].state.notes.filter((note) => note.status === 'active').map((note) => ({ id: note.id, description: note.description, body: note.body })),
        mechanical: arms[arm].scored,
      }])),
      unblind: Object.fromEntries(order.map((arm, index) => [letters[index], arm])),
    };
  });
  const notesReview = rows.map(({ chain, reflections, arms }) => ({
    key: chainKey(chain),
    caseId: chain.item.id,
    kind: chain.item.kind,
    truthForReviewer: chain.item.truth,
    production: { writes: writes(reflections.reflect), skills: reflections.reflect.toolCalls.filter((call) => call.name === SKILL_TOOL_NAME).map((call) => call.input), text: reflections.reflect.text.slice(0, 400) },
    candidate: { writes: writes(reflections['reflect-guard']), skills: reflections['reflect-guard'].toolCalls.filter((call) => call.name === SKILL_TOOL_NAME).map((call) => call.input), text: reflections['reflect-guard'].text.slice(0, 400) },
    traceG: arms?.G.state.trace ?? [],
  }));
  const reviewDir = path.join(root, 'review');
  await writeJsonAtomic(path.join(reviewDir, pilot ? 'pilot-pack.json' : 'pack.json'), blind);
  await writeJsonAtomic(path.join(reviewDir, pilot ? 'pilot-notes.json' : 'notes.json'), notesReview);
  const { calls, committedTokens, committedUsd } = ledgerState(readLedger(root));
  return { entries: rows.length, missing, byKind, byCase, byAlias, ledger: { calls, committedTokens, committedUsd } };
}

// ---------------------------------------------------------------- cli

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  const root = flag('raw-root') ?? GUARD_ROOT;
  const pilot = process.argv.includes('--pilot');
  const out = (value: object): void => { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); };
  if (mode === 'prepare') out(await prepare(root));
  else if (mode === 'run') out(await run(flag('confirm-budget') ?? '', pilot, root));
  else if (mode === 'pack') out(await pack(root, pilot));
  else throw new Error('usage: runner.ts <prepare|run|pack> [--pilot] [--raw-root DIR] [--confirm-budget TOKEN]');
}

if (process.env.VITEST === undefined && import.meta.url === pathToFileURL(process.argv[1] ?? '').href
  && ['prepare', 'run', 'pack'].includes(process.argv[2] ?? '')) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
