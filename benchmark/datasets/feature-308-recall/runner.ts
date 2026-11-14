/**
 * FEATURE_308 (results in docs/ADR.md ADR-076): does a reminder after a failure make the agent use its notes?
 *
 * Each chain is one user message against the case's fixed world under three arms:
 *
 *   arm A  no notes
 *   arm C  production now: the store's notes in the index, no reminder
 *   arm D  C plus the production failure reminder on the request after a failed
 *          batch, attached the way a provider lowers an ephemeral suffix (a text
 *          block on the last user message) and left out of the stored history
 *
 * A chain runs up to eight rounds and settles on its first right or harmful
 * action, or on a turn without tool calls. A round whose request is
 * byte-identical to an earlier arm's round (C and D before the first failure)
 * reuses that answer.
 *
 *   prepare  zero provider calls: case hash, input sizes
 *   run      paid calls; one in flight per alias; exact budget confirmation string
 *            (`--pilot` runs only ark/k27, repetition 1)
 *   pack     zero provider calls: mechanical scores, note reads, blinded evidence
 */
import { appendFileSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { KodaXAssistantBlock, KodaXContentBlock, KodaXMessage, KodaXTokenUsage, KodaXToolDefinition, KodaXToolResultBlock } from '@kodax-ai/llm';

import { toolBatchFailed } from '../../../packages/coding/src/memory/note-memory.js';
import { staticText } from '../../../packages/coding/src/prompts/static-text.js';
import { MODEL_ALIASES, type ModelAlias } from '../../harness/aliases.js';
import { runOneShot } from '../../harness/harness.js';
import type { ModelOutput, Scored } from '../feature-308-baseline/oracles.js';
import { estimateCost, ledgerState, readLedger, sha256, type LedgerEntry, type LedgerState } from '../feature-308-baseline/runner.js';
import { scoreCommand } from '../feature-308-inferred/oracles.js';
import { answerToolCall, noteFileMap, turnSettles } from '../feature-308-inferred/world.js';
import { buildNotesCellInputFrom, seedNotes } from '../feature-308-notes/inputs.js';
import { RECALL_CASES, STORE_NOTES, storeOf, type RecallCase, type RecallKind } from './cases.js';
import { answerShell } from './shell.js';

export const RECALL_REVISION = 'f308-recall-r3' as const;
export const RECALL_ALIASES: readonly ModelAlias[] = Object.freeze(['ark/k27', 'zhipu/glm52', 'ark/v4flash']);
export const RECALL_ROOT = path.join(os.tmpdir(), 'kodax-eval-dumps', 'feature-308', RECALL_REVISION);
const PILOT_ALIAS: ModelAlias = 'ark/k27';
const REPETITIONS = 3;
const MAX_ROUNDS = 8;
const BYTES_PER_TOKEN = 3;
export type Arm = 'A' | 'C' | 'D';
const ARMS: readonly Arm[] = ['A', 'C', 'D'];
const PLANNED_CALLS = RECALL_ALIASES.length * REPETITIONS * RECALL_CASES.length * ARMS.length * MAX_ROUNDS;
/** The production text, so the run measures exactly what ships. */
export const REMINDER = staticText('t13.prompts/note-failure-reminder.0');

export const RECALL_BUDGET = {
  /** Upper bound; reuse of identical requests and early stops cut it well below. */
  plannedCalls: PLANNED_CALLS,
  maxProviderCalls: PLANNED_CALLS + 20,
  maxOutputTokensPerCall: 8192,
  /** Requests of about 12k to 25k input tokens each, rounded up. */
  maxTotalTokens: 45_000_000,
  maxExternalSpendUsd: 8,
  timeoutMs: 180_000,
} as const;

export const RECALL_BUDGET_CONFIRMATION =
  `${RECALL_REVISION}:calls=${RECALL_BUDGET.maxProviderCalls}:tokens=${RECALL_BUDGET.maxTotalTokens}:usd=${RECALL_BUDGET.maxExternalSpendUsd}` as const;

const aliasDir = (alias: ModelAlias): string => alias.replace('/', '_');

export interface Chain {
  readonly alias: ModelAlias;
  readonly item: RecallCase;
  readonly repetition: number;
}

const chainKey = (chain: Chain): string => `${aliasDir(chain.alias)}__${chain.item.id}__r${chain.repetition}`;

export function plannedChains(pilot = false): readonly Chain[] {
  const aliases = pilot ? [PILOT_ALIAS] : RECALL_ALIASES;
  const repetitions = pilot ? 1 : REPETITIONS;
  return aliases.flatMap((alias) => RECALL_CASES.flatMap((item) =>
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

const callFile = (root: string, chain: Chain, arm: Arm, round: number): string =>
  path.join(root, 'calls', aliasDir(chain.alias), `${chainKey(chain)}__${arm}.round${round}.json`);

function appendLedger(root: string, entry: LedgerEntry): void {
  appendFileSync(path.join(root, 'ledger.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, 'utf8');
}

function assertLedgerAllows(state: LedgerState, key: string, alias: ModelAlias, estimatedInputTokens: number): void {
  const reserved = RECALL_BUDGET.maxOutputTokensPerCall;
  if (state.requestedCells.has(key)) throw new Error(`feature-308-recall per-call cap exceeded for ${key}`);
  if (state.calls + 1 > RECALL_BUDGET.maxProviderCalls) throw new Error('feature-308-recall provider call cap exceeded');
  if (state.committedTokens + estimatedInputTokens + reserved > RECALL_BUDGET.maxTotalTokens) throw new Error('feature-308-recall total token cap exceeded');
  if (state.committedUsd + estimateCost(alias, { inputTokens: estimatedInputTokens, outputTokens: reserved }) > RECALL_BUDGET.maxExternalSpendUsd) {
    throw new Error('feature-308-recall spend cap exceeded');
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

export interface ModelInput {
  readonly systemPrompt: string;
  readonly priorMessages?: readonly KodaXMessage[];
  readonly userMessage?: string;
  readonly tools: readonly KodaXToolDefinition[];
}

const sizeOf = (input: ModelInput): number => Math.ceil(Buffer.byteLength(JSON.stringify(input), 'utf8') / BYTES_PER_TOKEN);

/** The fixture directory and agent home are process-global and their path shows in the prompt, so building is serial. */
let fixtureLock: Promise<unknown> = Promise.resolve();
function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const next = fixtureLock.then(work, work);
  fixtureLock = next.catch(() => undefined);
  return next;
}

export interface ArmState {
  readonly input: ModelInput;
  /** Every file in the arm's note fixture, so a read of a note returns what is stored. */
  readonly noteFiles: ReadonlyMap<string, string>;
}

/** Arm A gets an empty store; C and D the case's store, so their first requests are byte-identical. */
export function buildArm(item: RecallCase, arm: Arm): Promise<ArmState> {
  return exclusive(async () => {
    const seeded = await seedNotes(arm === 'A' ? 'recall-empty' : `recall-${item.id}`, []);
    if (arm !== 'A') {
      for (const note of storeOf(item)) {
        const saved = await seeded.stores.project.write({ id: note.id, type: 'project', description: note.description, body: note.body, status: 'active' });
        if (!saved.ok) throw new Error(`note ${note.id} was not stored: ${saved.reason}`);
      }
    }
    const input = await buildNotesCellInputFrom({ id: item.id, seeds: [], history: [], userMessage: item.userMessage }, seeded);
    const noteFiles = noteFileMap([...await filesUnder(seeded.home), ...await filesUnder(seeded.cwd)]);
    return { input, noteFiles };
  });
}

const commandOf = (input: unknown): string | undefined => {
  const command = typeof input === 'object' && input !== null ? (input as Record<string, unknown>).command : undefined;
  return typeof command === 'string' ? command : undefined;
};

/** The world's answers to one turn's tool calls, in call order; shell commands go through the recall shell. */
export function answersFor(item: RecallCase, state: ArmState, assistantContent: readonly KodaXAssistantBlock[]): KodaXToolResultBlock[] {
  return assistantContent.flatMap((block) => {
    if (block.type !== 'tool_use') return [];
    const command = block.name === 'bash' ? commandOf(block.input) : undefined;
    return [{
      type: 'tool_result' as const,
      tool_use_id: block.id,
      content: command === undefined ? answerToolCall(item.world, state.noteFiles, block) : answerShell(item.world, command),
    }];
  });
}

/** The next round's stored history: the previous turn, then the world's answers. */
function continueWith(previous: ModelInput, assistantContent: readonly KodaXAssistantBlock[], results: readonly KodaXToolResultBlock[]): ModelInput {
  return {
    systemPrompt: previous.systemPrompt,
    tools: previous.tools,
    priorMessages: [
      ...(previous.priorMessages ?? []),
      ...(previous.userMessage === undefined ? [] : [{ role: 'user' as const, content: previous.userMessage }]),
      { role: 'assistant', content: [...assistantContent] as KodaXContentBlock[] },
      { role: 'user', content: [...results] as KodaXContentBlock[] },
    ],
  };
}

/** The request with the reminder lowered as an ephemeral suffix: a text block on the last user message. */
export function withReminder(history: ModelInput): ModelInput {
  const messages = [...(history.priorMessages ?? [])];
  const last = messages.at(-1);
  if (last === undefined || last.role !== 'user' || typeof last.content === 'string') throw new Error('the reminder follows a tool result turn');
  messages[messages.length - 1] = { ...last, content: [...last.content, { type: 'text', text: REMINDER }] };
  return { ...history, priorMessages: messages };
}

// ---------------------------------------------------------------- prepare

export function caseHash(): string {
  return sha256(JSON.stringify([
    REMINDER,
    STORE_NOTES,
    RECALL_CASES.map((item) => [
      item.id, item.kind, item.userMessage, item.targetNote ?? null, item.decoyNote ?? null, storeOf(item).map((note) => note.id),
      [String(item.oracle.pick), (item.oracle.needs ?? []).map(String), (item.oracle.avoid ?? []).map(String), item.oracle.edits === true],
      [item.world.files, (item.world.commands ?? []).map((command) => [String(command.match), command.exit, command.stdout, command.stderr ?? ''])],
    ]),
  ]));
}

export async function prepare(root: string = RECALL_ROOT): Promise<object> {
  const sizes = Object.fromEntries(await Promise.all(ARMS.map(async (arm) => [arm, sizeOf((await buildArm(RECALL_CASES[0]!, arm)).input)] as const)));
  await writeJsonAtomic(path.join(root, 'prepare.json'), { revision: RECALL_REVISION, caseHash: caseHash() });
  return { chains: plannedChains().length, maxCalls: RECALL_BUDGET.plannedCalls, caseHash: caseHash(), firstRequestTokens: sizes };
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
  /** True when this round's request carried the reminder. */
  readonly reminded?: boolean;
  readonly reusedFrom?: Arm;
}

async function callModel(root: string, alias: ModelAlias, key: string, input: ModelInput): Promise<Call> {
  const estimated = sizeOf(input);
  assertLedgerAllows(ledgerState(readLedger(root)), key, alias, estimated);
  appendLedger(root, { event: 'requested', cellKey: key, alias, estimatedInputTokens: estimated, reservedOutputTokens: RECALL_BUDGET.maxOutputTokensPerCall });
  try {
    const output = await runOneShot(alias, {
      systemPrompt: input.systemPrompt,
      ...(input.priorMessages === undefined ? {} : { priorMessages: input.priorMessages }),
      ...(input.userMessage === undefined ? {} : { userMessage: input.userMessage }),
      tools: input.tools,
      timeoutMs: RECALL_BUDGET.timeoutMs,
      maxOutputTokens: RECALL_BUDGET.maxOutputTokensPerCall,
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

/**
 * Set by `--resume-interrupted`: a call without a result is retried under its own ledger key.
 * A call that died in flight may have been billed, so it is retried once. A call the provider
 * refused (a `failed` entry, such as a 429) may be retried again, up to two retries in all.
 */
let resumeInterrupted = false;

/** The ledger key for the next attempt at `key`, or undefined when no retry is allowed. */
export function nextAttemptKey(entries: readonly LedgerEntry[], key: string, resume: boolean): string | undefined {
  const attempts = [key, `${key}#retry`, `${key}#retry2`];
  const requested = ledgerState(entries).requestedCells;
  const refused = new Set(entries.filter((entry) => entry.event === 'failed').map((entry) => entry.cellKey));
  const tried = attempts.filter((attempt) => requested.has(attempt));
  if (tried.length === 0) return key;
  const diedInFlight = tried.filter((attempt) => !refused.has(attempt)).length;
  if (!resume || diedInFlight > 1) return undefined;
  return attempts[tried.length];
}

/** Runs one call unless its result is already on disk (resume after an interruption). */
async function cached(file: string, root: string, alias: ModelAlias, key: string, input: ModelInput, extra: Partial<Call>): Promise<Call> {
  const existing = await readJson<Call>(file);
  if (existing !== undefined) return existing;
  const attemptKey = nextAttemptKey(readLedger(root), key, resumeInterrupted);
  if (attemptKey === undefined) {
    throw new Error(`${key} was requested but has no result; inspect the ledger, then rerun with --resume-interrupted to retry it`);
  }
  const result = { ...await callModel(root, alias, attemptKey, input), ...extra };
  await writeJsonAtomic(file, result);
  return result;
}

/** Answers already given in this chain, by request hash, so C and D share their rounds before the first failure. */
type Seen = Map<string, { readonly arm: Arm; readonly call: Call }>;

async function runArm(root: string, chain: Chain, arm: Arm, seen: Seen): Promise<void> {
  const state = await buildArm(chain.item, arm);
  let history = state.input;
  let remind = false;
  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    const request = remind ? withReminder(history) : history;
    const hash = sha256(JSON.stringify(request));
    const file = callFile(root, chain, arm, round);
    const earlier = seen.get(hash);
    let call: Call;
    if (earlier !== undefined && earlier.arm !== arm) {
      call = (await readJson<Call>(file)) ?? { ...earlier.call, reusedFrom: earlier.arm, estimatedCostUsd: 0 };
      await writeJsonAtomic(file, call);
    } else {
      call = await cached(file, root, chain.alias, `${chainKey(chain)}:${arm}.round${round}`, request, remind ? { reminded: true } : {});
      seen.set(hash, { arm, call });
    }
    if (turnSettles(chain.item.oracle, call.toolCalls)) return;
    const results = answersFor(chain.item, state, call.assistantContent);
    remind = arm === 'D' && toolBatchFailed(results);
    history = continueWith(history, call.assistantContent, results);
  }
}

async function runChain(root: string, chain: Chain): Promise<void> {
  const seen: Seen = new Map();
  for (const arm of ARMS) await runArm(root, chain, arm, seen);
}

export async function run(confirmBudget: string, pilot: boolean, root: string = RECALL_ROOT): Promise<object> {
  if (confirmBudget !== RECALL_BUDGET_CONFIRMATION) throw new Error(`feature-308-recall paid run needs --confirm-budget ${RECALL_BUDGET_CONFIRMATION}`);
  const aliases = pilot ? [PILOT_ALIAS] : RECALL_ALIASES;
  const missing = aliases.filter((alias) => (process.env[MODEL_ALIASES[alias].apiKeyEnv] ?? '').length === 0);
  if (missing.length > 0) throw new Error(`feature-308-recall missing API key env for: ${missing.join(', ')}`);
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

type Outcome = 'right' | 'harm' | 'none';
const outcomeOf = (scored: Scored): Outcome => (scored.verdict === 'pass' ? 'right' : scored.verdict === 'fail' ? 'harm' : 'none');
const asOutput = (rounds: readonly Call[]): ModelOutput => ({ text: rounds.at(-1)?.text ?? '', toolCalls: rounds.flatMap((round) => round.toolCalls) });

interface ArmResult {
  readonly rounds: readonly Call[];
  readonly scored: Scored;
  readonly outcome: Outcome;
  /** Note files the arm opened, by id, in order. */
  readonly notesRead: readonly string[];
  readonly reminders: number;
}

async function loadRounds(root: string, chain: Chain, arm: Arm): Promise<readonly Call[]> {
  const rounds: Call[] = [];
  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    const call = await readJson<Call>(callFile(root, chain, arm, round));
    if (call === undefined) break;
    rounds.push(call);
  }
  return rounds;
}

/** Ids of note files a call opened, with the read tool or a shell read. */
export function notesOpened(calls: readonly { readonly name: string; readonly input: unknown }[]): readonly string[] {
  const ids = new Set(STORE_NOTES.map((note) => note.id));
  return calls.flatMap((call) => {
    const text = JSON.stringify(call.input ?? {});
    return [...text.matchAll(/([a-z0-9-]+)\.md\b/g)].map((match) => match[1]!).filter((id) => ids.has(id));
  });
}

function armResult(item: RecallCase, rounds: readonly Call[]): ArmResult {
  const scored = scoreCommand(item.oracle, asOutput(rounds));
  return {
    rounds,
    scored,
    outcome: outcomeOf(scored),
    notesRead: notesOpened(rounds.flatMap((round) => round.toolCalls)),
    reminders: rounds.filter((round) => round.reminded === true).length,
  };
}

const tally = (results: readonly ArmResult[]): string =>
  `${results.filter((item) => item.outcome === 'right').length} right / ${results.filter((item) => item.outcome === 'harm').length} harm / ${results.filter((item) => item.outcome === 'none').length} none`;

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

/** Fixed per-chain shuffle of the arms, so the reviewer cannot tell which answer came from which arm. */
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

export async function pack(root: string = RECALL_ROOT, pilot = false): Promise<object> {
  const rows: { chain: Chain; arms: Record<Arm, ArmResult> }[] = [];
  const missing: string[] = [];
  for (const chain of plannedChains(pilot)) {
    const entries: [Arm, ArmResult][] = [];
    for (const arm of ARMS) {
      const rounds = await loadRounds(root, chain, arm);
      if (rounds.length > 0) entries.push([arm, armResult(chain.item, rounds)]);
    }
    if (entries.length < ARMS.length) missing.push(chainKey(chain));
    else rows.push({ chain, arms: Object.fromEntries(entries) as Record<Arm, ArmResult> });
  }
  const summarize = (subset: typeof rows) => ({
    ...Object.fromEntries(ARMS.map((arm) => [arm, tally(subset.map((row) => row.arms[arm]))])),
    medianRounds: Object.fromEntries(ARMS.map((arm) => [arm, median(subset.map((row) => row.arms[arm].rounds.length))])),
    targetRead: Object.fromEntries(ARMS.map((arm) => [arm, subset.filter((row) => row.chain.item.targetNote !== undefined && row.arms[arm].notesRead.includes(row.chain.item.targetNote)).length])),
    decoyRead: Object.fromEntries(ARMS.map((arm) => [arm, subset.filter((row) => row.chain.item.decoyNote !== undefined && row.arms[arm].notesRead.includes(row.chain.item.decoyNote)).length])),
    anyNoteRead: Object.fromEntries(ARMS.map((arm) => [arm, subset.filter((row) => row.arms[arm].notesRead.length > 0).length])),
    remindedChainsD: subset.filter((row) => row.arms.D.reminders > 0).length,
    pairedCtoD: subset.reduce<Record<string, number>>((acc, row) => {
      const key = `${row.arms.C.outcome}->${row.arms.D.outcome}`;
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {}),
  });
  const kinds: readonly RecallKind[] = ['lift', 'control'];
  const byKind = Object.fromEntries(kinds.map((kind) => [kind, summarize(rows.filter((row) => row.chain.item.kind === kind))]));
  const byCase = Object.fromEntries(RECALL_CASES.map((item) => [item.id, summarize(rows.filter((row) => row.chain.item.id === item.id))]));
  const byAlias = Object.fromEntries((pilot ? [PILOT_ALIAS] : RECALL_ALIASES).map((alias) => [alias, summarize(rows.filter((row) => row.chain.alias === alias))]));
  const letters = ['X', 'Y', 'Z'] as const;
  const blind = rows.map(({ chain, arms }) => {
    const key = chainKey(chain);
    const order = blindOrder(key);
    return {
      key,
      caseId: chain.item.id,
      truthForReviewer: chain.item.truth,
      request: chain.item.userMessage,
      answers: Object.fromEntries(order.map((arm, index) => [letters[index], {
        rounds: arms[arm].rounds.map((round) => ({ toolCalls: round.toolCalls.map(briefCall), text: round.text.slice(0, 800) })),
        mechanical: arms[arm].scored,
      }])),
      unblind: Object.fromEntries(order.map((arm, index) => [letters[index], arm])),
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
  const root = flag('raw-root') ?? RECALL_ROOT;
  const pilot = process.argv.includes('--pilot');
  resumeInterrupted = process.argv.includes('--resume-interrupted');
  const out = (value: object): void => { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); };
  if (mode === 'prepare') out(await prepare(root));
  else if (mode === 'run') out(await run(flag('confirm-budget') ?? '', pilot, root));
  else if (mode === 'pack') out(await pack(root, pilot));
  else throw new Error('usage: runner.ts <prepare|run|pack> [--pilot] [--resume-interrupted] [--raw-root DIR] [--confirm-budget TOKEN]');
}

if (process.env.VITEST === undefined && import.meta.url === pathToFileURL(process.argv[1] ?? '').href
  && ['prepare', 'run', 'pack'].includes(process.argv[2] ?? '')) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
