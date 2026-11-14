/**
 * FEATURE_308 experiment: should a lesson the agent inferred by itself be used in
 * the very next session, or wait as a candidate until it is confirmed?
 *
 * Each chain is session 1 (a command fails, the agent recovers, the user never
 * states the rule) -> the real reflection job -> session 2, whose first relevant
 * command is observed. The one reflection answer is applied two ways:
 *
 *   arm A  nothing from session 1 is stored (the agent starts cold)
 *   arm C  production: an inferred note is a candidate, hidden from the index
 *   arm E  no quarantine: an inferred project note is active at once; a write the
 *          host refused only because its quote came from local output is kept too
 *
 * A, C and E share one fixture path per case, so when C or E stores nothing
 * visible its session-2 input is byte-identical to A and A's answer is reused
 * instead of paying for the same input twice.
 *
 *   prepare  zero provider calls: gate check, case hash, input sizes
 *   run      paid calls; one in flight per alias; exact budget confirmation string
 *            (`--pilot` runs only ark/k27, repetition 1)
 *   pack     zero provider calls: mechanical scores plus a blinded evidence set
 */
import { appendFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
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
import type { KodaXMessage, KodaXTokenUsage, KodaXToolDefinition } from '@kodax-ai/llm';

import { buildReflectionRequest, parseReflectionCall, REFLECT_TOOL_NAME } from '../../../packages/coding/src/memory/note-reflection.js';
import { MODEL_ALIASES, type ModelAlias } from '../../harness/aliases.js';
import { runOneShot } from '../../harness/harness.js';
import { firstActionSignature, type ModelOutput, type Scored } from '../feature-308-baseline/oracles.js';
import { estimateCost, ledgerState, readLedger, sha256, type LedgerEntry, type LedgerState } from '../feature-308-baseline/runner.js';
import { buildNotesCellInputFrom, seedNotes, type SeededNotes } from '../feature-308-notes/inputs.js';
import { INFERRED_CASES, type InferredCase } from './cases.js';
import { scoreCommand } from './oracles.js';

export const INFERRED_REVISION = 'f308-inferred-r1' as const;
export const INFERRED_ALIASES: readonly ModelAlias[] = Object.freeze(['ark/k27', 'zhipu/glm52', 'ark/v4flash']);
export const INFERRED_ROOT = path.join(os.tmpdir(), 'kodax-eval-dumps', 'feature-308', INFERRED_REVISION);
const PILOT_ALIAS: ModelAlias = 'ark/k27';
const REPETITIONS = 2;
const BYTES_PER_TOKEN = 3;
const SESSION_ID = 'session-one';
type Arm = 'A' | 'C' | 'E';
const ARMS: readonly Arm[] = ['A', 'C', 'E'];

export const INFERRED_BUDGET = {
  /** cases x 3 aliases x 2 reps x (reflect + A + C + E); C and E reuse A when their input is identical. */
  plannedCalls: INFERRED_CASES.length * 3 * REPETITIONS * 4,
  maxProviderCalls: INFERRED_CASES.length * 3 * REPETITIONS * 4 + 20,
  maxOutputTokensPerCall: 8192,
  /** Requests of about 12k input tokens plus 8192 reserved output each, rounded up. */
  maxTotalTokens: 6_000_000,
  maxExternalSpendUsd: 3,
  timeoutMs: 180_000,
} as const;

export const INFERRED_BUDGET_CONFIRMATION =
  `${INFERRED_REVISION}:calls=${INFERRED_BUDGET.maxProviderCalls}:tokens=${INFERRED_BUDGET.maxTotalTokens}:usd=${INFERRED_BUDGET.maxExternalSpendUsd}` as const;

const aliasDir = (alias: ModelAlias): string => alias.replace('/', '_');

export interface Chain {
  readonly alias: ModelAlias;
  readonly item: InferredCase;
  readonly repetition: number;
}

const chainKey = (chain: Chain): string => `${aliasDir(chain.alias)}__${chain.item.id}__r${chain.repetition}`;

export function plannedChains(pilot = false): readonly Chain[] {
  const aliases = pilot ? [PILOT_ALIAS] : INFERRED_ALIASES;
  const repetitions = pilot ? 1 : REPETITIONS;
  return aliases.flatMap((alias) => INFERRED_CASES.flatMap((item) =>
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

function appendLedger(root: string, entry: LedgerEntry): void {
  appendFileSync(path.join(root, 'ledger.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, 'utf8');
}

function assertLedgerAllows(state: LedgerState, key: string, alias: ModelAlias, estimatedInputTokens: number): void {
  const reserved = INFERRED_BUDGET.maxOutputTokensPerCall;
  if (state.requestedCells.has(key)) throw new Error(`feature-308-inferred per-call cap exceeded for ${key}`);
  if (state.calls + 1 > INFERRED_BUDGET.maxProviderCalls) throw new Error('feature-308-inferred provider call cap exceeded');
  if (state.committedTokens + estimatedInputTokens + reserved > INFERRED_BUDGET.maxTotalTokens) throw new Error('feature-308-inferred total token cap exceeded');
  if (state.committedUsd + estimateCost(alias, { inputTokens: estimatedInputTokens, outputTokens: reserved }) > INFERRED_BUDGET.maxExternalSpendUsd) {
    throw new Error('feature-308-inferred spend cap exceeded');
  }
}

// ---------------------------------------------------------------- inputs

interface ModelInput {
  readonly systemPrompt: string;
  readonly priorMessages?: readonly KodaXMessage[];
  readonly userMessage: string;
  readonly tools: readonly KodaXToolDefinition[];
}

const sizeOf = (input: ModelInput): number => Math.ceil(Buffer.byteLength(JSON.stringify(input), 'utf8') / BYTES_PER_TOKEN);

export function reflectInput(item: InferredCase): ModelInput {
  return buildReflectionRequest(buildEvidence(item.sessionOne), []);
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
  readonly trace: readonly string[];
}

const LOCAL_QUOTE_REFUSED = 'quote must be a full statement from a user message';

/** Applies the recorded reflection calls through the real host guards, then the arm's rule, and builds session 2. */
export function buildArm(item: InferredCase, arm: Arm, reflect: ToolCalls | undefined): Promise<ArmState> {
  return exclusive(async () => {
    const seeded: SeededNotes = await seedNotes(`inferred-${item.id}`, []);
    const evidence = buildEvidence(item.sessionOne);
    const trace: string[] = [];
    const calls = arm === 'A' || reflect === undefined ? [] : reflect.toolCalls.filter((call) => call.name === REFLECT_TOOL_NAME);
    for (const call of calls) {
      const op = typeof call.input === 'object' && call.input !== null ? parseReflectionCall(call.input as Record<string, unknown>) : undefined;
      if (op === undefined) {
        trace.push('? ?: malformed memory_reflect call');
        continue;
      }
      const context = { stores: seeded.stores, evidence, sessionId: SESSION_ID };
      let outcome = await applyReflectionOperation(context, op);
      if (arm === 'E' && !outcome.ok && outcome.message.startsWith(LOCAL_QUOTE_REFUSED)
        && op.quote !== undefined && quoteInEvidence(evidence, op.quote, ['local'])) {
        const { quote: _quote, ...unquoted } = op;
        outcome = await applyReflectionOperation(context, unquoted satisfies ReflectionOpInput);
        trace.push(`${op.operation} ${op.id}: kept without its local quote -> ${outcome.message}`);
      } else {
        trace.push(`${op.operation} ${op.id}: ${outcome.message}`);
      }
    }
    if (arm === 'E') {
      for (const note of await seeded.stores.project.list()) {
        if (note.status !== 'candidate') continue;
        const done = await seeded.stores.project.edit(note.id, { status: 'active' });
        trace.push(`E promotes ${note.id}: ${done.ok ? 'active' : 'failed'}`);
      }
    }
    const notes = [...await seeded.stores.project.list(), ...await seeded.stores.user.list()];
    const input = await buildNotesCellInputFrom({ id: item.id, seeds: [], ...item.sessionTwo }, seeded);
    return { input, inputHash: sha256(JSON.stringify(input)), notes, trace };
  });
}

// ---------------------------------------------------------------- prepare

export function caseHash(): string {
  return sha256(JSON.stringify(INFERRED_CASES.map((item) => [item.id, item.sessionOne, item.sessionTwo, String(item.oracle.pick), (item.oracle.needs ?? []).map(String), (item.oracle.avoid ?? []).map(String)])));
}

export async function prepare(root: string = INFERRED_ROOT): Promise<object> {
  const cases = INFERRED_CASES.map((item) => ({ id: item.id, kind: item.kind, gate: shouldReflect(item.sessionOne), reflectTokens: sizeOf(reflectInput(item)) }));
  const closed = cases.filter((item) => !item.gate);
  if (closed.length > 0) throw new Error(`session one of ${closed.map((item) => item.id).join(', ')} does not pass the reflection gate`);
  const sessionTwoTokens = sizeOf((await buildArm(INFERRED_CASES[0]!, 'A', undefined)).input);
  await writeJsonAtomic(path.join(root, 'prepare.json'), { revision: INFERRED_REVISION, caseHash: caseHash(), cases });
  return { chains: plannedChains().length, plannedCalls: INFERRED_BUDGET.plannedCalls, caseHash: caseHash(), cases, sessionTwoTokensEstimate: sessionTwoTokens };
}

// ---------------------------------------------------------------- run

interface Call {
  readonly text: string;
  readonly toolCalls: readonly { readonly name: string; readonly input: unknown }[];
  readonly usage: KodaXTokenUsage;
  readonly durationMs: number;
  readonly estimatedCostUsd: number;
  readonly inputHash: string;
  /** Set when this arm's input equalled another arm's and that answer was reused. */
  readonly reusedFrom?: Arm;
}

async function callModel(root: string, alias: ModelAlias, key: string, input: ModelInput): Promise<Call> {
  const estimated = sizeOf(input);
  assertLedgerAllows(ledgerState(readLedger(root)), key, alias, estimated);
  appendLedger(root, { event: 'requested', cellKey: key, alias, estimatedInputTokens: estimated, reservedOutputTokens: INFERRED_BUDGET.maxOutputTokensPerCall });
  try {
    const output = await runOneShot(alias, {
      systemPrompt: input.systemPrompt,
      ...(input.priorMessages === undefined ? {} : { priorMessages: input.priorMessages }),
      userMessage: input.userMessage,
      tools: input.tools,
      timeoutMs: INFERRED_BUDGET.timeoutMs,
      maxOutputTokens: INFERRED_BUDGET.maxOutputTokensPerCall,
    });
    if (output.usage === undefined) throw new Error('provider usage is missing');
    const estimatedCostUsd = estimateCost(alias, output.usage);
    appendLedger(root, { event: 'completed', cellKey: key, alias, usage: output.usage, estimatedCostUsd });
    return { text: output.text, toolCalls: output.toolCalls, usage: output.usage, durationMs: output.durationMs, estimatedCostUsd, inputHash: sha256(JSON.stringify(input)) };
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

async function runChain(root: string, chain: Chain): Promise<void> {
  const key = chainKey(chain);
  const reflect = await cached(callFile(root, chain, 'reflect'), root, chain.alias, `${key}:reflect`, reflectInput(chain.item));
  const answers = new Map<string, { arm: Arm; call: Call }>();
  for (const arm of ARMS) {
    const file = callFile(root, chain, arm);
    const state = await buildArm(chain.item, arm, reflect);
    const same = answers.get(state.inputHash);
    if (same !== undefined && (await readJson<Call>(file)) === undefined) {
      await writeJsonAtomic(file, { ...same.call, reusedFrom: same.arm, estimatedCostUsd: 0 });
    }
    const call = same?.call ?? await cached(file, root, chain.alias, `${key}:${arm}`, state.input);
    if (same === undefined) answers.set(state.inputHash, { arm, call });
  }
}

export async function run(confirmBudget: string, pilot: boolean, root: string = INFERRED_ROOT): Promise<object> {
  if (confirmBudget !== INFERRED_BUDGET_CONFIRMATION) throw new Error(`feature-308-inferred paid run needs --confirm-budget ${INFERRED_BUDGET_CONFIRMATION}`);
  const aliases = pilot ? [PILOT_ALIAS] : INFERRED_ALIASES;
  const missing = aliases.filter((alias) => (process.env[MODEL_ALIASES[alias].apiKeyEnv] ?? '').length === 0);
  if (missing.length > 0) throw new Error(`feature-308-inferred missing API key env for: ${missing.join(', ')}`);
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

const asOutput = (call: Call): ModelOutput => ({ text: call.text, toolCalls: call.toolCalls });

interface ArmResult {
  readonly call: Call;
  readonly scored: Scored;
  readonly state: ArmState;
}

async function loadChain(root: string, chain: Chain): Promise<Record<Arm, ArmResult> | undefined> {
  const reflect = await readJson<Call>(callFile(root, chain, 'reflect'));
  if (reflect === undefined) return undefined;
  const entries: [Arm, ArmResult][] = [];
  for (const arm of ARMS) {
    const call = await readJson<Call>(callFile(root, chain, arm));
    if (call === undefined) return undefined;
    entries.push([arm, { call, scored: scoreCommand(chain.item.oracle, asOutput(call)), state: await buildArm(chain.item, arm, reflect) }]);
  }
  return Object.fromEntries(entries) as Record<Arm, ArmResult>;
}

const passes = (items: readonly Scored[]): string =>
  `${items.filter((item) => item.verdict === 'pass').length} pass / ${items.filter((item) => item.verdict === 'fail').length} fail / ${items.filter((item) => item.verdict === 'needs_review').length} review`;

/** Fixed per-chain shuffle of the three arms, so the reviewer cannot tell which answer came from which rule. */
function blindOrder(key: string): readonly Arm[] {
  const orders: readonly (readonly Arm[])[] = [['A', 'C', 'E'], ['A', 'E', 'C'], ['C', 'A', 'E'], ['C', 'E', 'A'], ['E', 'A', 'C'], ['E', 'C', 'A']];
  return orders[parseInt(sha256(key).slice(0, 4), 16) % orders.length]!;
}

export async function pack(root: string = INFERRED_ROOT, pilot = false): Promise<object> {
  const rows: { chain: Chain; arms: Record<Arm, ArmResult> }[] = [];
  const missing: string[] = [];
  for (const chain of plannedChains(pilot)) {
    const arms = await loadChain(root, chain);
    if (arms === undefined) missing.push(chainKey(chain));
    else rows.push({ chain, arms });
  }
  const summarize = (subset: typeof rows) => Object.fromEntries(ARMS.map((arm) => [arm, passes(subset.map((row) => row.arms[arm].scored))]));
  const byCase = Object.fromEntries(INFERRED_CASES.map((item) => {
    const subset = rows.filter((row) => row.chain.item.id === item.id);
    return [item.id, {
      kind: item.kind,
      ...summarize(subset),
      notesVisibleInC: subset.filter((row) => row.arms.C.state.notes.some((note) => note.status === 'active')).length,
      notesVisibleInE: subset.filter((row) => row.arms.E.state.notes.some((note) => note.status === 'active')).length,
    }];
  }));
  const byKind = Object.fromEntries(['durable', 'spurious', 'misattributed'].map((kind) => [kind, summarize(rows.filter((row) => row.chain.item.kind === kind))]));
  const byAlias = Object.fromEntries((pilot ? [PILOT_ALIAS] : INFERRED_ALIASES).map((alias) => [alias, summarize(rows.filter((row) => row.chain.alias === alias))]));
  const blind = rows.map(({ chain, arms }) => {
    const key = chainKey(chain);
    const order = blindOrder(key);
    const labels = ['X', 'Y', 'Z'] as const;
    return {
      key,
      caseId: chain.item.id,
      truthForReviewer: chain.item.truth,
      sessionTwoRequest: chain.item.sessionTwo.userMessage,
      answers: Object.fromEntries(order.map((arm, index) => [labels[index], {
        firstAction: firstActionSignature(asOutput(arms[arm].call)),
        toolCalls: arms[arm].call.toolCalls,
        text: arms[arm].call.text.slice(0, 1500),
        visibleNotes: arms[arm].state.notes.filter((note) => note.status === 'active').map((note) => ({ id: note.id, description: note.description, body: note.body })),
        mechanical: arms[arm].scored,
      }])),
      unblind: Object.fromEntries(order.map((arm, index) => [labels[index], arm])),
      notesWritten: arms.C.state.notes.map((note) => ({ id: note.id, status: note.status, source: note.source, description: note.description, why: note.why })),
      reflectTraceC: arms.C.state.trace,
      reflectTraceE: arms.E.state.trace,
    };
  });
  await writeJsonAtomic(path.join(root, 'review', pilot ? 'pilot-pack.json' : 'pack.json'), blind);
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
  const root = flag('raw-root') ?? INFERRED_ROOT;
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
