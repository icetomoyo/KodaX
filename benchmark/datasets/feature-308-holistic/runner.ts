/**
 * FEATURE_308 holistic experiment: what happens to a note after it is written.
 *
 *   confirm  one reflection call per chain over the second session, with the
 *            candidate and 39 other notes in the store. The answer is applied
 *            through the real host guards; the result is the candidate's fate.
 *   use      the session after confirmation, in a 40-note store, three arms:
 *              N  the lesson is not stored
 *              O  the lesson is active with the old-style index line
 *              R  the lesson is active with the rule-style index line
 *            O and R share id and body. Up to three rounds; exploration gets the
 *            inferred case's world, and a note read gets the stored note.
 *
 *   prepare  zero provider calls: gate check, case hash, input and index sizes
 *   run      paid calls; one in flight per alias; exact budget confirmation string
 *            (`--pilot` runs only ark/k27, repetition 1)
 *   pack     zero provider calls: mechanical outcomes plus a blinded use-stage set
 */
import { appendFileSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  applyReflectionOperation,
  buildEvidence,
  countTokens,
  INDEX_FILE,
  shouldReflect,
  type MemoryNote,
} from '@kodax-ai/agent';
import type { KodaXAssistantBlock, KodaXContentBlock, KodaXMessage, KodaXTokenUsage, KodaXToolDefinition } from '@kodax-ai/llm';

import { buildReflectionRequest, parseReflectionCall, REFLECT_TOOL_NAME } from '../../../packages/coding/src/memory/note-reflection.js';
import { MODEL_ALIASES, type ModelAlias } from '../../harness/aliases.js';
import { runOneShot } from '../../harness/harness.js';
import { scaleDistractorSeeds } from '../feature-308-baseline/cases.js';
import type { Scored } from '../feature-308-baseline/oracles.js';
import { estimateCost, ledgerState, readLedger, sha256, type LedgerEntry } from '../feature-308-baseline/runner.js';
import { scoreCommand } from '../feature-308-inferred/oracles.js';
import { answerToolCall, noteFileMap, turnSettles } from '../feature-308-inferred/world.js';
import { buildNotesCellInputFrom, seedNotes, type SeededNotes } from '../feature-308-notes/inputs.js';
import { CONFIRM_CASES, SESSION_ONE, USE_CASES, type ConfirmCase, type UseCase } from './cases.js';

export const HOLISTIC_REVISION = 'f308-holistic-r1' as const;
export const HOLISTIC_ALIASES: readonly ModelAlias[] = Object.freeze(['ark/k27', 'zhipu/glm52', 'ark/v4flash']);
export const HOLISTIC_ROOT = path.join(os.tmpdir(), 'kodax-eval-dumps', 'feature-308', HOLISTIC_REVISION);
const PILOT_ALIAS: ModelAlias = 'ark/k27';
const REPETITIONS = 2;
const MAX_ROUNDS = 3;
const BYTES_PER_TOKEN = 3;
/** The store holds the lesson plus this many unrelated notes: 40 in all. */
export const OTHER_NOTES = 39;
const SESSION_TWO = 'session-two';
export type Arm = 'N' | 'O' | 'R';
export const ARMS: readonly Arm[] = ['N', 'O', 'R'];

const CONFIRM_CALLS = CONFIRM_CASES.length * HOLISTIC_ALIASES.length * REPETITIONS;
const USE_CALLS = USE_CASES.length * HOLISTIC_ALIASES.length * REPETITIONS * ARMS.length * MAX_ROUNDS;

export const HOLISTIC_BUDGET = {
  /** 11 confirm chains x 3 aliases x 2 reps, one call each. */
  confirmCalls: CONFIRM_CALLS,
  /** Upper bound: 4 use cases x 3 aliases x 2 reps x 3 arms x 3 rounds; early stops cut it well below. */
  useCalls: USE_CALLS,
  /** The pilot is the k27 repetition-1 slice of the full plan, so it adds nothing; 20% headroom on top. */
  maxProviderCalls: 340,
  maxOutputTokensPerCall: 8192,
  /** prepare measures about 8k input per confirm call and 13k per use call; every call at the output cap stays under this. */
  maxTotalTokens: 7_000_000,
  maxExternalSpendUsd: 3,
  timeoutMs: 180_000,
} as const;

export const HOLISTIC_BUDGET_CONFIRMATION =
  `${HOLISTIC_REVISION}:calls=${HOLISTIC_BUDGET.maxProviderCalls}:tokens=${HOLISTIC_BUDGET.maxTotalTokens}:usd=${HOLISTIC_BUDGET.maxExternalSpendUsd}` as const;

const aliasDir = (alias: ModelAlias): string => alias.replace('/', '_');

export interface Chain<T> {
  readonly alias: ModelAlias;
  readonly item: T;
  readonly repetition: number;
}

const chainKey = (stage: string, chain: Chain<{ readonly id: string }>): string => `${stage}__${aliasDir(chain.alias)}__${chain.item.id}__r${chain.repetition}`;

export function plannedChains<T>(items: readonly T[], pilot = false): readonly Chain<T>[] {
  const aliases = pilot ? [PILOT_ALIAS] : HOLISTIC_ALIASES;
  const repetitions = pilot ? 1 : REPETITIONS;
  return aliases.flatMap((alias) => items.flatMap((item) =>
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

async function filesUnder(dir: string): Promise<{ path: string; content: string }[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return Promise.all(entries.filter((entry) => entry.isFile()).map(async (entry) => {
    const file = path.join(entry.parentPath, entry.name);
    return { path: file, content: await readFile(file, 'utf8') };
  }));
}

/** The fixture directory and agent home are process-global and their path shows in the prompt, so building is serial. */
let fixtureLock: Promise<unknown> = Promise.resolve();
function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const next = fixtureLock.then(work, work);
  fixtureLock = next.catch(() => undefined);
  return next;
}

// ---------------------------------------------------------------- model calls

interface ModelInput {
  readonly systemPrompt: string;
  readonly priorMessages?: readonly KodaXMessage[];
  readonly userMessage?: string;
  readonly tools: readonly KodaXToolDefinition[];
}

const sizeOf = (input: ModelInput): number => Math.ceil(Buffer.byteLength(JSON.stringify(input), 'utf8') / BYTES_PER_TOKEN);

interface Call {
  readonly text: string;
  readonly toolCalls: readonly { readonly name: string; readonly input: unknown }[];
  readonly assistantContent: readonly KodaXAssistantBlock[];
  readonly usage: KodaXTokenUsage;
  readonly durationMs: number;
  readonly estimatedCostUsd: number;
  readonly inputHash: string;
}

function appendLedger(root: string, entry: LedgerEntry): void {
  appendFileSync(path.join(root, 'ledger.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, 'utf8');
}

function assertLedgerAllows(root: string, key: string, alias: ModelAlias, estimatedInputTokens: number): void {
  const state = ledgerState(readLedger(root));
  const reserved = HOLISTIC_BUDGET.maxOutputTokensPerCall;
  if (state.requestedCells.has(key)) throw new Error(`${key} was requested but has no result; inspect the ledger before retrying`);
  if (state.calls + 1 > HOLISTIC_BUDGET.maxProviderCalls) throw new Error('feature-308-holistic provider call cap exceeded');
  if (state.committedTokens + estimatedInputTokens + reserved > HOLISTIC_BUDGET.maxTotalTokens) throw new Error('feature-308-holistic total token cap exceeded');
  if (state.committedUsd + estimateCost(alias, { inputTokens: estimatedInputTokens, outputTokens: reserved }) > HOLISTIC_BUDGET.maxExternalSpendUsd) {
    throw new Error('feature-308-holistic spend cap exceeded');
  }
}

/** One provider call unless its result is already on disk (resume after an interruption). */
async function cached(root: string, file: string, alias: ModelAlias, key: string, input: ModelInput): Promise<Call> {
  const existing = await readJson<Call>(file);
  if (existing !== undefined) return existing;
  const estimated = sizeOf(input);
  assertLedgerAllows(root, key, alias, estimated);
  appendLedger(root, { event: 'requested', cellKey: key, alias, estimatedInputTokens: estimated, reservedOutputTokens: HOLISTIC_BUDGET.maxOutputTokensPerCall });
  try {
    const output = await runOneShot(alias, {
      systemPrompt: input.systemPrompt,
      ...(input.priorMessages === undefined ? {} : { priorMessages: input.priorMessages }),
      ...(input.userMessage === undefined ? {} : { userMessage: input.userMessage }),
      tools: input.tools,
      timeoutMs: HOLISTIC_BUDGET.timeoutMs,
      maxOutputTokens: HOLISTIC_BUDGET.maxOutputTokensPerCall,
    });
    if (output.usage === undefined) throw new Error('provider usage is missing');
    const estimatedCostUsd = estimateCost(alias, output.usage);
    appendLedger(root, { event: 'completed', cellKey: key, alias, usage: output.usage, estimatedCostUsd });
    const result: Call = {
      text: output.text, toolCalls: output.toolCalls, assistantContent: output.assistantContent, usage: output.usage,
      durationMs: output.durationMs, estimatedCostUsd, inputHash: sha256(JSON.stringify(input)),
    };
    await writeJsonAtomic(file, result);
    return result;
  } catch (error) {
    appendLedger(root, { event: 'failed', cellKey: key, alias, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

const callFile = (root: string, alias: ModelAlias, key: string, name: string): string => path.join(root, 'calls', aliasDir(alias), `${key}__${name}.json`);

// ---------------------------------------------------------------- confirm stage

interface ConfirmStore {
  readonly seeded: SeededNotes;
  readonly notes: readonly MemoryNote[];
}

/** A fresh 40-note store: the 39 other notes active, the candidate as session one left it. */
async function seedConfirm(item: ConfirmCase): Promise<ConfirmStore> {
  const seeded = await seedNotes(`holistic-confirm-${item.id}`, scaleDistractorSeeds(OTHER_NOTES));
  const stored = await seeded.stores[item.scope].write(item.candidate);
  if (!stored.ok) throw new Error(`candidate for ${item.id} was not stored: ${stored.reason}`);
  return { seeded, notes: [...await seeded.stores.project.list(), ...await seeded.stores.user.list()] };
}

export function confirmInput(item: ConfirmCase): Promise<ModelInput> {
  return exclusive(async () => buildReflectionRequest(buildEvidence(item.session), (await seedConfirm(item)).notes));
}

export type Fate = 'confirmed' | 'disputed' | 'rewritten' | 'left';

export interface ConfirmOutcome {
  readonly fate: Fate;
  /** Notes the job wrote instead of, or besides, acting on the candidate. */
  readonly newNotes: readonly { readonly id: string; readonly status: string; readonly description: string }[];
  readonly trace: readonly string[];
}

/** Applies a recorded reflection answer to a fresh store through the real host guards. */
export function applyConfirm(item: ConfirmCase, answer: { readonly toolCalls: Call['toolCalls'] }): Promise<ConfirmOutcome> {
  return exclusive(async () => {
    const { seeded, notes: before } = await seedConfirm(item);
    const context = { stores: seeded.stores, evidence: buildEvidence(item.session), sessionId: SESSION_TWO, project: item.project };
    const trace: string[] = [];
    for (const call of answer.toolCalls.filter((entry) => entry.name === REFLECT_TOOL_NAME)) {
      const op = typeof call.input === 'object' && call.input !== null ? parseReflectionCall(call.input as Record<string, unknown>) : undefined;
      if (op === undefined) {
        trace.push('? ?: malformed memory_reflect call');
        continue;
      }
      const outcome = await applyReflectionOperation(context, op);
      trace.push(`${op.operation} ${op.scope ?? 'project'}/${op.id}: ${outcome.message}`);
    }
    const after = [...await seeded.stores.project.list(), ...await seeded.stores.user.list()];
    const candidate = after.find((note) => note.id === item.candidate.id && note.scope === item.scope)!;
    const fate: Fate = candidate.status === 'active' ? 'confirmed'
      : candidate.status === 'disputed' ? 'disputed'
        : candidate.description !== item.candidate.description ? 'rewritten' : 'left';
    const known = new Set(before.map((note) => `${note.scope}/${note.id}`));
    const newNotes = after.filter((note) => !known.has(`${note.scope}/${note.id}`)).map((note) => ({ id: note.id, status: note.status, description: note.description }));
    return { fate, newNotes, trace };
  });
}

async function runConfirm(root: string, chain: Chain<ConfirmCase>): Promise<void> {
  const key = chainKey('confirm', chain);
  await cached(root, callFile(root, chain.alias, key, 'reflect'), chain.alias, key, await confirmInput(chain.item));
}

// ---------------------------------------------------------------- use stage

export interface ArmState {
  readonly input: ModelInput;
  readonly noteFiles: ReadonlyMap<string, string>;
  /** Note directories, slash-normalised and lower-cased, to recognise a note read. */
  readonly noteRoots: readonly string[];
  readonly indexTokens: number;
}

/** One fixture path per case, so the three arms differ only in the stored lesson. */
export function buildUseArm(item: UseCase, arm: Arm): Promise<ArmState> {
  return exclusive(async () => {
    const seeded = await seedNotes(`holistic-use-${item.id}`, scaleDistractorSeeds(OTHER_NOTES));
    if (arm !== 'N') {
      const stored = await seeded.stores.project.write({
        id: item.noteId, type: 'project', description: arm === 'O' ? item.oldLine : item.ruleLine, body: item.body,
        status: 'active', source: 'inferred', session: SESSION_ONE,
      });
      if (!stored.ok) throw new Error(`lesson for ${item.id} was not stored: ${stored.reason}`);
    }
    const input = await buildNotesCellInputFrom({ id: item.id, seeds: [], ...item.base.sessionTwo }, seeded);
    const noteFiles = noteFileMap([...await filesUnder(seeded.home), ...await filesUnder(seeded.cwd)]);
    const index = await readFile(path.join(seeded.stores.project.root, INDEX_FILE), 'utf8');
    const noteRoots = [seeded.stores.project.root, seeded.stores.user.root].map((root) => root.replace(/\\/g, '/').toLowerCase());
    return { input, noteFiles, noteRoots, indexTokens: countTokens(index) };
  });
}

function continueWith(item: UseCase, state: ArmState, previous: ModelInput, call: Call): ModelInput {
  const results: KodaXContentBlock[] = call.assistantContent.flatMap((block) => block.type !== 'tool_use' ? [] : [{
    type: 'tool_result' as const,
    tool_use_id: block.id,
    content: answerToolCall(item.base.world, state.noteFiles, block),
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

async function runUse(root: string, chain: Chain<UseCase>): Promise<void> {
  const key = chainKey('use', chain);
  for (const arm of ARMS) {
    const state = await buildUseArm(chain.item, arm);
    let input = state.input;
    for (let round = 1; round <= MAX_ROUNDS; round += 1) {
      const call = await cached(root, callFile(root, chain.alias, key, `${arm}.round${round}`), chain.alias, `${key}:${arm}.round${round}`, input);
      if (turnSettles(chain.item.base.oracle, call.toolCalls)) break;
      input = continueWith(chain.item, state, input, call);
    }
  }
}

// ---------------------------------------------------------------- prepare / run

export function caseHash(): string {
  return sha256(JSON.stringify({
    confirm: CONFIRM_CASES.map((item) => [item.id, item.expect, item.scope, item.project, item.candidate, item.session]),
    use: USE_CASES.map((item) => [item.id, item.base.id, item.noteId, item.oldLine, item.ruleLine, item.body]),
    others: scaleDistractorSeeds(OTHER_NOTES),
  }));
}

export async function prepare(root: string = HOLISTIC_ROOT): Promise<object> {
  const closed = CONFIRM_CASES.filter((item) => !shouldReflect(item.session)).map((item) => item.id);
  if (closed.length > 0) throw new Error(`the second session of ${closed.join(', ')} does not pass the reflection gate`);
  const confirmTokens = await Promise.all(CONFIRM_CASES.map(async (item) => sizeOf(await confirmInput(item))));
  const use: { id: string; arms: Record<string, { inputTokens: number; indexTokens: number }> }[] = [];
  for (const item of USE_CASES) {
    const arms: Record<string, { inputTokens: number; indexTokens: number }> = {};
    for (const arm of ARMS) {
      const state = await buildUseArm(item, arm);
      arms[arm] = { inputTokens: sizeOf(state.input), indexTokens: state.indexTokens };
    }
    use.push({ id: item.id, arms });
  }
  const worstCaseUsd = HOLISTIC_ALIASES.reduce((sum, alias) => sum
    + REPETITIONS * confirmTokens.reduce((total, tokens) => total + estimateCost(alias, { inputTokens: tokens, outputTokens: HOLISTIC_BUDGET.maxOutputTokensPerCall }), 0)
    + REPETITIONS * use.reduce((total, item) => total + Object.values(item.arms).reduce((armTotal, arm) =>
      armTotal + MAX_ROUNDS * estimateCost(alias, { inputTokens: arm.inputTokens * 1.3, outputTokens: HOLISTIC_BUDGET.maxOutputTokensPerCall }), 0), 0), 0);
  const summary = { revision: HOLISTIC_REVISION, caseHash: caseHash(), confirmTokens, use, worstCaseUsd: Number(worstCaseUsd.toFixed(3)) };
  await writeJsonAtomic(path.join(root, 'prepare.json'), summary);
  return { ...summary, plannedConfirmCalls: HOLISTIC_BUDGET.confirmCalls, plannedUseCallsMax: HOLISTIC_BUDGET.useCalls };
}

export async function run(confirmBudget: string, pilot: boolean, root: string = HOLISTIC_ROOT): Promise<object> {
  if (confirmBudget !== HOLISTIC_BUDGET_CONFIRMATION) throw new Error(`feature-308-holistic paid run needs --confirm-budget ${HOLISTIC_BUDGET_CONFIRMATION}`);
  const aliases = pilot ? [PILOT_ALIAS] : HOLISTIC_ALIASES;
  const missing = aliases.filter((alias) => (process.env[MODEL_ALIASES[alias].apiKeyEnv] ?? '').length === 0);
  if (missing.length > 0) throw new Error(`feature-308-holistic missing API key env for: ${missing.join(', ')}`);
  await mkdir(root, { recursive: true });
  await prepare(root);
  let failure: unknown;
  const lane = async (alias: ModelAlias): Promise<void> => {
    const work = [
      ...plannedChains(CONFIRM_CASES, pilot).filter((chain) => chain.alias === alias).map((chain) => () => runConfirm(root, chain)),
      ...plannedChains(USE_CASES, pilot).filter((chain) => chain.alias === alias).map((chain) => () => runUse(root, chain)),
    ];
    for (const step of work) {
      if (failure !== undefined) return;
      try {
        await step();
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

/** Which notes a run opened: the lesson, the index files, or one of the other notes. */
export function noteReads(state: ArmState, noteId: string, calls: readonly { readonly name: string; readonly input: unknown }[]): { lesson: number; index: number; other: number } {
  const counts = { lesson: 0, index: 0, other: 0 };
  for (const call of calls) {
    const text = JSON.stringify(call.input ?? '').replace(/\\\\/g, '/').replace(/\\/g, '/').toLowerCase();
    if (!state.noteRoots.some((root) => text.includes(root))) continue;
    if (text.includes(`${noteId.toLowerCase()}.md`)) counts.lesson += 1;
    else if (/memory(?:\.more)?\.md/.test(text)) counts.index += 1;
    else counts.other += 1;
  }
  return counts;
}

async function loadRounds(root: string, alias: ModelAlias, key: string, arm: Arm): Promise<readonly Call[]> {
  const rounds: Call[] = [];
  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    const call = await readJson<Call>(callFile(root, alias, key, `${arm}.round${round}`));
    if (call === undefined) break;
    rounds.push(call);
  }
  return rounds;
}

/** Fixed per-chain shuffle of the three arms, so the reviewer cannot tell which run had which line. */
function blindOrder(key: string): readonly Arm[] {
  const orders: readonly (readonly Arm[])[] = [['N', 'O', 'R'], ['N', 'R', 'O'], ['O', 'N', 'R'], ['O', 'R', 'N'], ['R', 'N', 'O'], ['R', 'O', 'N']];
  return orders[parseInt(sha256(key).slice(0, 4), 16) % orders.length]!;
}

const briefCall = (call: { readonly name: string; readonly input: unknown }): string => `${call.name}: ${JSON.stringify(call.input).slice(0, 400)}`;
const tally = (items: readonly string[]): Record<string, number> => items.reduce<Record<string, number>>((acc, item) => ({ ...acc, [item]: (acc[item] ?? 0) + 1 }), {});

interface ConfirmRow extends ConfirmOutcome {
  readonly key: string;
  readonly caseId: string;
  readonly alias: ModelAlias;
  readonly expect: ConfirmCase['expect'];
  readonly truth: string;
  readonly candidate: string;
  readonly calls: readonly string[];
  readonly text: string;
}

async function packConfirm(root: string, pilot: boolean): Promise<object> {
  const rows: ConfirmRow[] = [];
  const missing: string[] = [];
  for (const chain of plannedChains(CONFIRM_CASES, pilot)) {
    const key = chainKey('confirm', chain);
    const answer = await readJson<Call>(callFile(root, chain.alias, key, 'reflect'));
    if (answer === undefined) {
      missing.push(key);
      continue;
    }
    const outcome = await applyConfirm(chain.item, answer);
    rows.push({
      key, caseId: chain.item.id, alias: chain.alias, expect: chain.item.expect, truth: chain.item.truth,
      candidate: chain.item.candidate.description, ...outcome,
      calls: answer.toolCalls.map(briefCall), text: answer.text.slice(0, 600),
    });
  }
  await writeJsonAtomic(path.join(root, 'review', pilot ? 'pilot-confirm.json' : 'confirm.json'), rows);
  const byCase = Object.fromEntries(CONFIRM_CASES.map((item) => {
    const subset = rows.filter((row) => row.caseId === item.id);
    return [item.id, { expect: item.expect, ...tally(subset.map((row) => row.fate)), newNotes: subset.reduce((sum, row) => sum + row.newNotes.length, 0) }];
  }));
  return { entries: rows.length, missing, byCase };
}

interface UseArmResult {
  readonly rounds: readonly Call[];
  readonly scored: Scored;
  readonly reads: ReturnType<typeof noteReads>;
  readonly indexTokens: number;
  readonly inputTokens: number;
}

async function packUse(root: string, pilot: boolean): Promise<object> {
  const rows: { chain: Chain<UseCase>; key: string; arms: Record<Arm, UseArmResult> }[] = [];
  const missing: string[] = [];
  for (const chain of plannedChains(USE_CASES, pilot)) {
    const key = chainKey('use', chain);
    const arms: Partial<Record<Arm, UseArmResult>> = {};
    for (const arm of ARMS) {
      const rounds = await loadRounds(root, chain.alias, key, arm);
      if (rounds.length === 0) break;
      const state = await buildUseArm(chain.item, arm);
      const calls = rounds.flatMap((round) => round.toolCalls);
      arms[arm] = {
        rounds,
        scored: scoreCommand(chain.item.base.oracle, { text: rounds.at(-1)?.text ?? '', toolCalls: calls }),
        reads: noteReads(state, chain.item.noteId, calls),
        indexTokens: state.indexTokens,
        inputTokens: rounds.reduce((sum, round) => sum + round.usage.inputTokens, 0),
      };
    }
    if (ARMS.some((arm) => arms[arm] === undefined)) {
      missing.push(key);
      continue;
    }
    rows.push({ chain, key, arms: arms as Record<Arm, UseArmResult> });
  }
  const summary = Object.fromEntries(ARMS.map((arm) => {
    const results = rows.map((row) => row.arms[arm]);
    return [arm, {
      pass: results.filter((item) => item.scored.verdict === 'pass').length,
      fail: results.filter((item) => item.scored.verdict === 'fail').length,
      review: results.filter((item) => item.scored.verdict === 'needs_review').length,
      lessonReads: results.reduce((sum, item) => sum + item.reads.lesson, 0),
      indexReads: results.reduce((sum, item) => sum + item.reads.index, 0),
      otherNoteReads: results.reduce((sum, item) => sum + item.reads.other, 0),
      rounds: results.reduce((sum, item) => sum + item.rounds.length, 0),
      providerInputTokens: results.reduce((sum, item) => sum + item.inputTokens, 0),
    }];
  }));
  const byCase = Object.fromEntries(USE_CASES.map((item) => [item.id, Object.fromEntries(ARMS.map((arm) => {
    const results = rows.filter((row) => row.chain.item.id === item.id).map((row) => row.arms[arm]);
    return [arm, `${results.filter((entry) => entry.scored.verdict === 'pass').length}/${results.length}; index ${results[0]?.indexTokens ?? 0} tokens`];
  }))]));
  const labels = ['X', 'Y', 'Z'] as const;
  const blind = rows.map((row) => {
    const order = blindOrder(row.key);
    return {
      key: row.key,
      caseId: row.chain.item.id,
      truthForReviewer: row.chain.item.base.truth,
      request: row.chain.item.base.sessionTwo.userMessage,
      answers: Object.fromEntries(order.map((arm, index) => [labels[index], {
        rounds: row.arms[arm].rounds.map((round) => ({ toolCalls: round.toolCalls.map(briefCall), text: round.text.slice(0, 600) })),
      }])),
      unblind: Object.fromEntries(order.map((arm, index) => [labels[index], arm])),
      mechanical: Object.fromEntries(order.map((arm, index) => [labels[index], { verdict: row.arms[arm].scored.verdict, reasons: row.arms[arm].scored.reasons, reads: row.arms[arm].reads }])),
    };
  });
  await writeJsonAtomic(path.join(root, 'review', pilot ? 'pilot-use.json' : 'use.json'), blind);
  return { entries: rows.length, missing, summary, byCase };
}

export async function pack(root: string = HOLISTIC_ROOT, pilot = false): Promise<object> {
  const { calls, committedTokens, committedUsd } = ledgerState(readLedger(root));
  return { confirm: await packConfirm(root, pilot), use: await packUse(root, pilot), ledger: { calls, committedTokens, committedUsd } };
}

// ---------------------------------------------------------------- cli

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  const root = flag('raw-root') ?? HOLISTIC_ROOT;
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
