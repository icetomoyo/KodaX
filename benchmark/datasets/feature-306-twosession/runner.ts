/**
 * FEATURE_306 Phase 3 runner: the two-session gate for default-on.
 *
 *   arm A  session 2 with no memory (same input bytes as the Phase 0 arm A)
 *   arm C  session 1 -> the real reflection job -> the notes it wrote -> session 2
 *          with the note index injected (production path, KODAX_MEMORY_NOTES=1)
 *
 * Arm B (old memory, seeded by hand) is not rerun: Phase 0/1b already measured it and
 * it is the more favourable seeding for the old system. Arm D (failure-time
 * intervention) cannot differ from C here: every oracle looks at the first action,
 * before any failure exists to intervene on.
 *
 *   prepare  zero provider calls: session-1 gate check and input sizes
 *   run      paid calls; one in flight per alias; exact budget confirmation string
 *   pack     zero provider calls: mechanical scores plus a blinded evidence set
 */
import { appendFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { applyReflectionOperation, buildEvidence, shouldReflect, type MemoryNote } from '@kodax-ai/agent';
import type { KodaXMessage, KodaXTokenUsage, KodaXToolDefinition } from '@kodax-ai/llm';

import { buildReflectionRequest, parseReflectionCall, REFLECT_TOOL_NAME } from '../../../packages/coding/src/memory/note-reflection.js';
import { MODEL_ALIASES, type ModelAlias } from '../../harness/aliases.js';
import { runOneShot } from '../../harness/harness.js';
import { FEATURE_306_READ_CASES, scaleDistractorSeeds, type ReadCase } from '../feature-306-baseline/cases.js';
import { buildReadCellInput } from '../feature-306-baseline/inputs.js';
import { firstActionSignature, scoreReadCell, type ModelOutput, type Scored } from '../feature-306-baseline/oracles.js';
import { estimateCost, ledgerState, readLedger, sha256, type LedgerEntry, type LedgerState } from '../feature-306-baseline/runner.js';
import { buildNotesCellInputFrom, seedNotes } from '../feature-306-notes/inputs.js';
import { scoreNotesReadCell } from '../feature-306-notes/oracles.js';
import { SESSION_ONE, TWO_SESSION_CASE_IDS, type TwoSessionCaseId } from './sessions.js';

export const TWO_REVISION = 'f306-phase3-r1' as const;
export const TWO_ALIASES: readonly ModelAlias[] = Object.freeze(['ark/k27', 'zhipu/glm52', 'ark/v4flash']);
export const TWO_ROOT = path.join(os.tmpdir(), 'kodax-eval-dumps', 'feature-306', TWO_REVISION);
const REPETITIONS = 2;
const SCALE_NOTES = 39;
const BYTES_PER_TOKEN = 3;

export const TWO_BUDGET = {
  /** 7 cases x 3 aliases x 2 reps x (A + reflect + session 2) = 126. */
  plannedCalls: TWO_SESSION_CASE_IDS.length * 3 * REPETITIONS * 3,
  maxProviderCalls: 160,
  maxOutputTokensPerCall: 8192,
  /** Requests of about 10k input tokens plus 8192 reserved output each, rounded up. */
  maxTotalTokens: 3_000_000,
  maxExternalSpendUsd: 3,
  timeoutMs: 180_000,
} as const;

export const TWO_BUDGET_CONFIRMATION =
  `${TWO_REVISION}:calls=${TWO_BUDGET.maxProviderCalls}:tokens=${TWO_BUDGET.maxTotalTokens}:usd=${TWO_BUDGET.maxExternalSpendUsd}` as const;

const READ_CASES = new Map<string, ReadCase>(FEATURE_306_READ_CASES.map((item) => [item.id, item]));
const aliasDir = (alias: ModelAlias): string => alias.replace('/', '_');
const readCaseOf = (id: TwoSessionCaseId): ReadCase => READ_CASES.get(id)!;
const distractorsOf = (id: TwoSessionCaseId) => (id === 'c6' || id === 'c7' ? scaleDistractorSeeds(SCALE_NOTES) : []);

export interface Chain {
  readonly alias: ModelAlias;
  readonly caseId: TwoSessionCaseId;
  readonly repetition: number;
}

export const chainKey = (chain: Chain, arm: 'A' | 'C'): string => `${aliasDir(chain.alias)}__${chain.caseId}__${arm}__r${chain.repetition}`;

export function plannedChains(): readonly Chain[] {
  return TWO_ALIASES.flatMap((alias) => TWO_SESSION_CASE_IDS.flatMap((caseId) =>
    Array.from({ length: REPETITIONS }, (_, index) => ({ alias, caseId, repetition: index + 1 }))));
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

const filePath = (root: string, kind: 'reflect' | 'cells', alias: ModelAlias, key: string): string => path.join(root, kind, aliasDir(alias), `${key}.json`);

function appendLedger(root: string, entry: LedgerEntry): void {
  appendFileSync(path.join(root, 'ledger.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, 'utf8');
}

function assertLedgerAllows(state: LedgerState, key: string, alias: ModelAlias, estimatedInputTokens: number): void {
  const reserved = TWO_BUDGET.maxOutputTokensPerCall;
  if (state.requestedCells.has(key)) throw new Error(`feature-306-twosession per-call cap exceeded for ${key}`);
  if (state.calls + 1 > TWO_BUDGET.maxProviderCalls) throw new Error('feature-306-twosession provider call cap exceeded');
  if (state.committedTokens + estimatedInputTokens + reserved > TWO_BUDGET.maxTotalTokens) throw new Error('feature-306-twosession total token cap exceeded');
  if (state.committedUsd + estimateCost(alias, { inputTokens: estimatedInputTokens, outputTokens: reserved }) > TWO_BUDGET.maxExternalSpendUsd) {
    throw new Error('feature-306-twosession spend cap exceeded');
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

function reflectInput(caseId: TwoSessionCaseId): ModelInput {
  return buildReflectionRequest(buildEvidence(SESSION_ONE[caseId]), []);
}

/** The fixture directory and agent home are process-global and their path shows in the prompt, so building is serial. */
let fixtureLock: Promise<unknown> = Promise.resolve();
function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const next = fixtureLock.then(work, work);
  fixtureLock = next.catch(() => undefined);
  return next;
}

interface ReflectOutcome {
  readonly toolCalls: readonly { readonly name: string; readonly input: unknown }[];
}

interface SessionTwo {
  readonly input: ModelInput;
  readonly notes: readonly MemoryNote[];
  readonly trace: readonly string[];
}

/** Applies the recorded reflection calls through the real host guards, then builds session 2 over the resulting store. */
export function buildSessionTwo(caseId: TwoSessionCaseId, reflect: ReflectOutcome): Promise<SessionTwo> {
  return exclusive(async () => {
    const readCase = readCaseOf(caseId);
    const distractors = distractorsOf(caseId);
    const seeded = await seedNotes(`chain-${caseId}`, distractors);
    const evidence = buildEvidence(SESSION_ONE[caseId]);
    const trace: string[] = [];
    for (const call of reflect.toolCalls.filter((item) => item.name === REFLECT_TOOL_NAME)) {
      const op = typeof call.input === 'object' && call.input !== null ? parseReflectionCall(call.input as Record<string, unknown>) : undefined;
      const outcome = op === undefined
        ? { ok: false, message: 'malformed memory_reflect call' }
        : await applyReflectionOperation({ stores: seeded.stores, evidence, sessionId: `session-one-${caseId}` }, op);
      trace.push(`${op?.operation ?? '?'} ${op?.id ?? '?'}: ${outcome.message}`);
    }
    const skip = new Set(distractors.map((seed) => seed.claimKey));
    const notes = [...await seeded.stores.project.list(), ...await seeded.stores.user.list()].filter((note) => !skip.has(note.id));
    return { input: await buildNotesCellInputFrom(readCase, seeded), notes, trace };
  });
}

// ---------------------------------------------------------------- prepare

export async function prepare(root: string = TWO_ROOT): Promise<object> {
  const cases = TWO_SESSION_CASE_IDS.map((caseId) => ({
    caseId,
    gate: shouldReflect(SESSION_ONE[caseId]),
    reflectTokens: sizeOf(reflectInput(caseId)),
  }));
  const bad = cases.filter((item) => !item.gate);
  if (bad.length > 0) throw new Error(`session one of ${bad.map((item) => item.caseId).join(', ')} does not pass the reflection gate`);
  const sessionTwoTokens = sizeOf(await buildReadCellInput(readCaseOf('c6'), 'A')) + 4_000;
  const caseHash = sha256(JSON.stringify(TWO_SESSION_CASE_IDS.map((id) => [id, SESSION_ONE[id], readCaseOf(id).userMessage])));
  await writeJsonAtomic(path.join(root, 'prepare.json'), { revision: TWO_REVISION, caseHash, cases });
  return { chains: plannedChains().length, plannedCalls: TWO_BUDGET.plannedCalls, caseHash, cases, sessionTwoTokensEstimate: sessionTwoTokens };
}

// ---------------------------------------------------------------- run

interface Call {
  readonly text: string;
  readonly toolCalls: readonly { readonly name: string; readonly input: unknown }[];
  readonly usage: KodaXTokenUsage;
  readonly durationMs: number;
  readonly estimatedCostUsd: number;
  readonly inputHash: string;
}

async function callModel(root: string, alias: ModelAlias, key: string, input: ModelInput): Promise<Call> {
  const estimated = sizeOf(input);
  assertLedgerAllows(ledgerState(readLedger(root)), key, alias, estimated);
  appendLedger(root, { event: 'requested', cellKey: key, alias, estimatedInputTokens: estimated, reservedOutputTokens: TWO_BUDGET.maxOutputTokensPerCall });
  try {
    const output = await runOneShot(alias, {
      systemPrompt: input.systemPrompt,
      ...(input.priorMessages === undefined ? {} : { priorMessages: input.priorMessages }),
      userMessage: input.userMessage,
      tools: input.tools,
      timeoutMs: TWO_BUDGET.timeoutMs,
      maxOutputTokens: TWO_BUDGET.maxOutputTokensPerCall,
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
async function cached(file: string, root: string, alias: ModelAlias, key: string, input: () => Promise<ModelInput>): Promise<Call> {
  const existing = await readJson<Call>(file);
  if (existing !== undefined) return existing;
  if (ledgerState(readLedger(root)).requestedCells.has(key)) throw new Error(`${key} was requested but has no result; inspect the ledger before retrying`);
  const result = await callModel(root, alias, key, await input());
  await writeJsonAtomic(file, result);
  return result;
}

async function runChain(root: string, chain: Chain): Promise<void> {
  const readCase = readCaseOf(chain.caseId);
  const keyA = chainKey(chain, 'A');
  const keyC = chainKey(chain, 'C');
  await cached(filePath(root, 'cells', chain.alias, keyA), root, chain.alias, `${keyA}:s2`, () => buildReadCellInput(readCase, 'A'));
  const reflect = await cached(filePath(root, 'reflect', chain.alias, keyC), root, chain.alias, `${keyC}:reflect`, async () => reflectInput(chain.caseId));
  const sessionTwo = await buildSessionTwo(chain.caseId, reflect);
  await cached(filePath(root, 'cells', chain.alias, keyC), root, chain.alias, `${keyC}:s2`, async () => sessionTwo.input);
}

export async function run(confirmBudget: string, root: string = TWO_ROOT): Promise<object> {
  if (confirmBudget !== TWO_BUDGET_CONFIRMATION) throw new Error(`feature-306-twosession paid run needs --confirm-budget ${TWO_BUDGET_CONFIRMATION}`);
  const missing = TWO_ALIASES.filter((alias) => (process.env[MODEL_ALIASES[alias].apiKeyEnv] ?? '').length === 0);
  if (missing.length > 0) throw new Error(`feature-306-twosession missing API key env for: ${missing.join(', ')}`);
  await prepare(root);
  let failure: unknown;
  const lane = async (alias: ModelAlias): Promise<void> => {
    for (const chain of plannedChains().filter((item) => item.alias === alias)) {
      if (failure !== undefined) return;
      try {
        await runChain(root, chain);
      } catch (error) {
        failure ??= error;
        throw error;
      }
    }
  };
  const settled = await Promise.allSettled(TWO_ALIASES.map(lane));
  const rejected = settled.find((item): item is PromiseRejectedResult => item.status === 'rejected');
  if (rejected !== undefined) throw rejected.reason;
  const { calls, committedTokens, committedUsd } = ledgerState(readLedger(root));
  return { ledger: { calls, committedTokens, committedUsd } };
}

// ---------------------------------------------------------------- pack

const asOutput = (call: Call): ModelOutput => ({ text: call.text, toolCalls: call.toolCalls });

interface Pair {
  readonly chain: Chain;
  readonly a: { readonly call: Call; readonly scored: Scored };
  readonly c: { readonly call: Call; readonly scored: Scored; readonly notes: readonly MemoryNote[]; readonly trace: readonly string[]; readonly detailActive: boolean };
}

async function loadPair(root: string, chain: Chain): Promise<Pair | undefined> {
  const readCase = readCaseOf(chain.caseId);
  const callA = await readJson<Call>(filePath(root, 'cells', chain.alias, chainKey(chain, 'A')));
  const reflect = await readJson<Call>(filePath(root, 'reflect', chain.alias, chainKey(chain, 'C')));
  const callC = await readJson<Call>(filePath(root, 'cells', chain.alias, chainKey(chain, 'C')));
  if (callA === undefined || reflect === undefined || callC === undefined) return undefined;
  const sessionTwo = await buildSessionTwo(chain.caseId, reflect);
  return {
    chain,
    a: { call: callA, scored: scoreReadCell(readCase.oracle, asOutput(callA)) },
    c: {
      call: callC,
      scored: scoreNotesReadCell(readCase.oracle, asOutput(callC)),
      notes: sessionTwo.notes,
      trace: sessionTwo.trace,
      detailActive: sessionTwo.notes.some((note) => note.status === 'active' && JSON.stringify(note).includes(readCase.decisiveDetail)),
    },
  };
}

const passes = (items: readonly { readonly verdict: Scored['verdict'] }[]): string => `${items.filter((item) => item.verdict === 'pass').length}/${items.length}`;

export async function pack(root: string = TWO_ROOT): Promise<object> {
  const pairs: Pair[] = [];
  const missing: string[] = [];
  for (const chain of plannedChains()) {
    const pair = await loadPair(root, chain);
    if (pair === undefined) missing.push(chainKey(chain, 'C'));
    else pairs.push(pair);
  }
  const byCase = Object.fromEntries(TWO_SESSION_CASE_IDS.map((caseId) => {
    const rows = pairs.filter((pair) => pair.chain.caseId === caseId);
    return [caseId, {
      family: readCaseOf(caseId).family,
      armA: passes(rows.map((row) => row.a.scored)),
      armC: passes(rows.map((row) => row.c.scored)),
      noteWithDetailActive: `${rows.filter((row) => row.c.detailActive).length}/${rows.length}`,
    }];
  }));
  const byAlias = Object.fromEntries(TWO_ALIASES.map((alias) => {
    const rows = pairs.filter((pair) => pair.chain.alias === alias);
    return [alias, { armA: passes(rows.map((row) => row.a.scored)), armC: passes(rows.map((row) => row.c.scored)) }];
  }));
  const blind = pairs.map((pair) => {
    const key = chainKey(pair.chain, 'C');
    const cFirst = parseInt(sha256(key).slice(0, 2), 16) % 2 === 0;
    const arm = (label: 'A' | 'C') => (label === 'A' ? pair.a : pair.c);
    const [x, y] = cFirst ? (['C', 'A'] as const) : (['A', 'C'] as const);
    return {
      key, caseId: pair.chain.caseId, alias: pair.chain.alias, userMessage: readCaseOf(pair.chain.caseId).userMessage,
      X: { firstAction: firstActionSignature(asOutput(arm(x).call)), mechanical: arm(x).scored },
      Y: { firstAction: firstActionSignature(asOutput(arm(y).call)), mechanical: arm(y).scored },
      unblind: { X: x, Y: y },
      notesWritten: pair.c.notes.map((note) => ({ id: note.id, status: note.status, source: note.source, description: note.description })),
      reflectTrace: pair.c.trace,
    };
  });
  await writeJsonAtomic(path.join(root, 'review', 'pack.json'), blind);
  const { calls, committedTokens, committedUsd } = ledgerState(readLedger(root));
  return { entries: pairs.length, missing, byCase, byAlias, ledger: { calls, committedTokens, committedUsd } };
}

// ---------------------------------------------------------------- cli

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  const root = flag('raw-root') ?? TWO_ROOT;
  const out = (value: object): void => console.log(JSON.stringify(value, null, 2));
  if (mode === 'prepare') out(await prepare(root));
  else if (mode === 'run') out(await run(flag('confirm-budget') ?? '', root));
  else if (mode === 'pack') out(await pack(root));
  else throw new Error('usage: runner.ts <prepare|run|pack> [--raw-root DIR] [--confirm-budget TOKEN]');
}

if (process.env.VITEST === undefined && import.meta.url === pathToFileURL(process.argv[1] ?? '').href
  && ['prepare', 'run', 'pack'].includes(process.argv[2] ?? '')) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
