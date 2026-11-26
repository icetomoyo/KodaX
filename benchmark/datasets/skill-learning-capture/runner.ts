/**
 * Skill learning capture eval runner (docs/designs/skill-learning-capture-eval.md).
 *
 * One reflection call per cell (alias, case, repetition, arm). Arm N is the notes-only
 * request (production once skill proposals are removed), arm S the current production
 * request. What the call returns is applied through the real host guards into a throwaway
 * store, and the stored text is scored against the case's facts, order and traps.
 *
 *   prepare  zero provider calls: gate check, input sizes, case hash
 *   run      paid calls for a scope (pilot | full); one in flight per alias; exact confirmation
 *   pack     zero provider calls: blinded pack, its key and per-arm tallies, each in its own review/ file
 */
import { appendFileSync, mkdirSync, rmSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  applyReflectionOperation,
  buildEvidence,
  createNoteStore,
  renderDeclarativeSkill,
  shouldReflect,
  type DeclarativeSkillSpec,
  type MemoryOpResult,
} from '@kodax-ai/agent';
import type { KodaXTokenUsage } from '@kodax-ai/llm';

import { buildReflectionRequest, parseReflectionCall, parseSkillCall, REFLECT_TOOL, SKILL_TOOL_NAME } from '../../../packages/coding/src/memory/note-reflection.js';
import { MODEL_ALIASES, type ModelAlias } from '../../harness/aliases.js';
import { runOneShot } from '../../harness/harness.js';
import { estimateCost, ledgerState, readLedger, sha256, type LedgerEntry, type LedgerState } from '../feature-308-baseline/runner.js';
import { notesOnlyReflectionPrompt, type ModelInput, type RecordedCall } from '../skill-learning-value/inputs.js';
import { CAPTURE_CASES, caseOf, type CaptureCase } from './cases.js';

export const CAPTURE_REVISION = 'skill-capture-r1' as const;
export const CAPTURE_ROOT = path.join(os.tmpdir(), 'kodax-eval-dumps', 'skill-learning-capture', CAPTURE_REVISION);
const FIXTURE_ROOT = path.join(os.tmpdir(), 'kodax-eval-fixtures', 'skill-learning-capture');
const BYTES_PER_TOKEN = 3;
const MAX_OUTPUT_TOKENS = 8192;
const TIMEOUT_MS = 180_000;

export type Arm = 'N' | 'S';
export const ARMS: readonly Arm[] = ['N', 'S'];
export type Scope = 'pilot' | 'full';
type CaseId = CaptureCase['id'];

interface ScopeSpec {
  readonly cases: readonly CaseId[];
  readonly aliases: readonly ModelAlias[];
  readonly repetitions: number;
  /** Cap on all ledger calls so far, pilot included. */
  readonly maxProviderCalls: number;
  readonly maxTotalTokens: number;
  readonly maxExternalSpendUsd: number;
}

/** Caps frozen before any paid call; see the design record for how they were derived. */
export const SCOPES: Readonly<Record<Scope, ScopeSpec>> = {
  pilot: { cases: ['k1', 'k3'], aliases: ['kimi', 'zhipu/glm53flash'], repetitions: 1, maxProviderCalls: 10, maxTotalTokens: 400_000, maxExternalSpendUsd: 0.3 },
  full: { cases: ['k1', 'k2', 'k3', 'k4', 'k5', 'k6'], aliases: ['kimi', 'zhipu/glm53flash', 'ds/flash'], repetitions: 2, maxProviderCalls: 80, maxTotalTokens: 3_000_000, maxExternalSpendUsd: 1 },
};

export const confirmation = (scope: Scope): string => {
  const spec = SCOPES[scope];
  return `${CAPTURE_REVISION}:${scope}:calls=${spec.maxProviderCalls}:tokens=${spec.maxTotalTokens}:usd=${spec.maxExternalSpendUsd}`;
};

export interface Cell {
  readonly alias: ModelAlias;
  readonly caseId: CaseId;
  readonly repetition: number;
}

const aliasDir = (alias: ModelAlias): string => alias.replace('/', '_');
export const cellKey = (cell: Cell, arm: Arm): string => `${aliasDir(cell.alias)}__${cell.caseId}__${arm}__r${cell.repetition}`;

export function plannedCells(scope: Scope): readonly Cell[] {
  const spec = SCOPES[scope];
  return spec.aliases.flatMap((alias) => spec.cases.flatMap((caseId) =>
    Array.from({ length: spec.repetitions }, (_, index) => ({ alias, caseId, repetition: index + 1 }))));
}

// ---------------------------------------------------------------- input

export function reflectInput(item: CaptureCase, arm: Arm): ModelInput {
  const request = buildReflectionRequest(buildEvidence(item.session), []);
  if (arm === 'S') return request;
  return { systemPrompt: notesOnlyReflectionPrompt(request.systemPrompt), userMessage: request.userMessage, tools: [REFLECT_TOOL] };
}

// ---------------------------------------------------------------- stored text and scoring

export interface Stored {
  /** Each note as one text: id, type, status, description, why, check, body. */
  readonly notes: readonly string[];
  readonly skills: readonly string[];
  readonly trace: readonly string[];
}

/** Applies the recorded calls through the host guards into a fresh store; nothing is promoted. */
export async function storeCalls(item: CaptureCase, arm: Arm, calls: readonly RecordedCall[], key = `${item.id}-${arm}`): Promise<Stored> {
  const root = path.join(FIXTURE_ROOT, key);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  try {
    const stores = { project: createNoteStore(path.join(root, 'project'), 'project'), user: createNoteStore(path.join(root, 'user'), 'user') };
    const evidence = buildEvidence(item.session);
    const skills: string[] = [];
    const sink = async (spec: DeclarativeSkillSpec): Promise<MemoryOpResult> => {
      try {
        skills.push(renderDeclarativeSkill(spec));
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
      return { ok: true, message: `skill ${spec.name} accepted` };
    };
    const trace: string[] = [];
    for (const call of calls) {
      const raw = typeof call.input === 'object' && call.input !== null ? call.input as Record<string, unknown> : undefined;
      // Arm N never offered skill_propose; a call to it anyway is refused like any unknown tool.
      const parse = call.name === SKILL_TOOL_NAME ? (arm === 'S' ? parseSkillCall : undefined) : parseReflectionCall;
      const op = raw === undefined || parse === undefined ? undefined : parse(raw);
      const outcome = op === undefined
        ? { ok: false, message: `unusable ${call.name} call` }
        : await applyReflectionOperation({ stores, evidence, sessionId: `capture-${item.id}`, ...(arm === 'S' ? { skills: sink } : {}) }, op);
      trace.push(`${outcome.ok ? 'ok' : 'REJECTED'} ${call.name} ${op?.operation ?? '?'} ${op?.id ?? '?'}: ${outcome.message}`);
    }
    const notes = [...await stores.project.list(), ...await stores.user.list()].map((note) =>
      [`${note.id} (${note.scope}, ${note.type}, ${note.status})`, note.description, note.why ?? '', note.check ?? '', note.body].join('\n'));
    return { notes, skills, trace };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export type OrderClass = 'ordered' | 'misordered' | 'incomplete' | 'none';

/** Whether the steps occur in `text` one after another, each found after the previous one. */
function inSequence(order: readonly RegExp[], text: string): boolean {
  let from = 0;
  for (const pattern of order) {
    const index = text.slice(from).search(pattern);
    if (index < 0) return false;
    from += index + 1;
  }
  return true;
}

/**
 * Whether one stored text carries every order-critical step, in order. A note often names
 * steps in its description before it spells out the order, so the steps only have to occur
 * as an in-order sequence, not at their first mentions.
 */
export function orderOf(item: CaptureCase, texts: readonly string[]): OrderClass {
  if (item.order.length === 0) return 'none';
  let best: OrderClass = 'incomplete';
  for (const text of texts) {
    if (item.order.some((pattern) => text.search(pattern) < 0)) continue;
    if (inSequence(item.order, text)) return 'ordered';
    best = 'misordered';
  }
  return best;
}

export interface Score {
  /** Facts carried by notes, the only artifact the next session can use without the user's review. */
  readonly inNotes: readonly boolean[];
  /** Facts carried by notes or skills. */
  readonly anywhere: readonly boolean[];
  readonly trapsInNotes: readonly string[];
  readonly trapsAnywhere: readonly string[];
  readonly orderInNotes: OrderClass;
  readonly orderAnywhere: OrderClass;
  readonly noteCount: number;
  readonly activeNotes: number;
  readonly skillCount: number;
  readonly noteChars: number;
}

export function score(item: CaptureCase, stored: Stored): Score {
  const all = [...stored.notes, ...stored.skills];
  const has = (texts: readonly string[]) => (pattern: RegExp) => texts.some((text) => pattern.test(text));
  return {
    inNotes: item.facts.map((fact) => has(stored.notes)(fact.pattern)),
    anywhere: item.facts.map((fact) => has(all)(fact.pattern)),
    trapsInNotes: item.traps.filter((trap) => has(stored.notes)(trap.pattern)).map((trap) => trap.label),
    trapsAnywhere: item.traps.filter((trap) => has(all)(trap.pattern)).map((trap) => trap.label),
    orderInNotes: orderOf(item, stored.notes),
    orderAnywhere: orderOf(item, all),
    noteCount: stored.notes.length,
    activeNotes: stored.notes.filter((text) => /, active\)\n/.test(text)).length,
    skillCount: stored.skills.length,
    noteChars: stored.notes.reduce((sum, text) => sum + text.length, 0),
  };
}

// ---------------------------------------------------------------- files and ledger

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

const callFile = (root: string, cell: Cell, arm: Arm): string => path.join(root, 'calls', aliasDir(cell.alias), `${cellKey(cell, arm)}.json`);

function appendLedger(root: string, entry: LedgerEntry): void {
  mkdirSync(root, { recursive: true });
  appendFileSync(path.join(root, 'ledger.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, 'utf8');
}

const sizeOf = (input: ModelInput): number => Math.ceil(Buffer.byteLength(JSON.stringify(input), 'utf8') / BYTES_PER_TOKEN);

function assertLedgerAllows(spec: ScopeSpec, state: LedgerState, key: string, alias: ModelAlias, estimatedInputTokens: number): void {
  if (state.requestedCells.has(key)) throw new Error(`skill-capture per-call cap exceeded for ${key}`);
  if (state.calls + 1 > spec.maxProviderCalls) throw new Error('skill-capture provider call cap exceeded');
  if (state.committedTokens + estimatedInputTokens + MAX_OUTPUT_TOKENS > spec.maxTotalTokens) throw new Error('skill-capture total token cap exceeded');
  if (state.committedUsd + estimateCost(alias, { inputTokens: estimatedInputTokens, outputTokens: MAX_OUTPUT_TOKENS }) > spec.maxExternalSpendUsd) {
    throw new Error('skill-capture spend cap exceeded');
  }
}

const caseHash = (): string => sha256(JSON.stringify(CAPTURE_CASES, (_key, value: unknown) => (value instanceof RegExp ? value.source : value)));

// ---------------------------------------------------------------- prepare

export async function prepare(root: string = CAPTURE_ROOT): Promise<object> {
  const bad = CAPTURE_CASES.filter((item) => !shouldReflect(item.session)).map((item) => item.id);
  if (bad.length > 0) throw new Error(`the session of ${bad.join(', ')} does not pass the reflection gate`);
  const cases = CAPTURE_CASES.map((item) => ({
    id: item.id,
    evidenceOmitted: buildEvidence(item.session).omitted,
    tokens: Object.fromEntries(ARMS.map((arm) => [arm, sizeOf(reflectInput(item, arm))])),
  }));
  const plan = Object.fromEntries((['pilot', 'full'] as const).map((scope) => {
    const cells = plannedCells(scope);
    const input = cells.reduce((sum, cell) => sum + ARMS.reduce((armSum, arm) => armSum + sizeOf(reflectInput(caseOf(cell.caseId), arm)), 0), 0);
    return [scope, { calls: cells.length * ARMS.length, inputTokens: input, withOutputReserve: input + cells.length * ARMS.length * MAX_OUTPUT_TOKENS, confirmation: confirmation(scope) }];
  }));
  const result = { revision: CAPTURE_REVISION, caseHash: caseHash(), cases, plan };
  await writeJsonAtomic(path.join(root, 'prepare.json'), result);
  return result;
}

// ---------------------------------------------------------------- run

interface Call {
  readonly text: string;
  readonly toolCalls: readonly RecordedCall[];
  readonly usage: KodaXTokenUsage;
  readonly durationMs: number;
  readonly estimatedCostUsd: number;
  readonly inputHash: string;
}

async function callModel(root: string, spec: ScopeSpec, alias: ModelAlias, key: string, input: ModelInput): Promise<Call> {
  const estimated = sizeOf(input);
  assertLedgerAllows(spec, ledgerState(readLedger(root)), key, alias, estimated);
  appendLedger(root, { event: 'requested', cellKey: key, alias, estimatedInputTokens: estimated, reservedOutputTokens: MAX_OUTPUT_TOKENS });
  try {
    const output = await runOneShot(alias, {
      systemPrompt: input.systemPrompt,
      ...(input.userMessage === undefined ? {} : { userMessage: input.userMessage }),
      tools: input.tools,
      timeoutMs: TIMEOUT_MS,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
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

/** Runs one call unless its result is already on disk (resume, and pilot reuse in the full run). */
async function cached(root: string, spec: ScopeSpec, cell: Cell, arm: Arm): Promise<Call> {
  const file = callFile(root, cell, arm);
  const existing = await readJson<Call>(file);
  if (existing !== undefined) return existing;
  const key = cellKey(cell, arm);
  if (ledgerState(readLedger(root)).requestedCells.has(key)) throw new Error(`${key} was requested but has no result; inspect the ledger before retrying`);
  const result = await callModel(root, spec, cell.alias, key, reflectInput(caseOf(cell.caseId), arm));
  await writeJsonAtomic(file, result);
  return result;
}

export async function run(scope: Scope, confirmBudget: string, root: string = CAPTURE_ROOT): Promise<object> {
  if (confirmBudget !== confirmation(scope)) throw new Error(`skill-capture ${scope} run needs --confirm-budget ${confirmation(scope)}`);
  const spec = SCOPES[scope];
  const missing = spec.aliases.filter((alias) => (process.env[MODEL_ALIASES[alias].apiKeyEnv] ?? '').length === 0);
  if (missing.length > 0) throw new Error(`skill-capture missing API key env for: ${missing.join(', ')}`);
  await prepare(root);
  let failure: unknown;
  const lane = async (alias: ModelAlias): Promise<void> => {
    for (const cell of plannedCells(scope).filter((item) => item.alias === alias)) {
      for (const arm of ARMS) {
        if (failure !== undefined) return;
        try {
          await cached(root, spec, cell, arm);
        } catch (error) {
          failure ??= error;
          throw error;
        }
      }
    }
  };
  const settled = await Promise.allSettled(spec.aliases.map(lane));
  const rejected = settled.find((item): item is PromiseRejectedResult => item.status === 'rejected');
  if (rejected !== undefined) throw rejected.reason;
  const { calls, committedTokens, committedUsd } = ledgerState(readLedger(root));
  return { scope, ledger: { calls, committedTokens, committedUsd } };
}

// ---------------------------------------------------------------- pack

interface ArmResult {
  readonly call: Call;
  readonly stored: Stored;
  readonly score: Score;
}

async function loadArm(root: string, cell: Cell, arm: Arm): Promise<ArmResult | undefined> {
  const call = await readJson<Call>(callFile(root, cell, arm));
  if (call === undefined) return undefined;
  const item = caseOf(cell.caseId);
  const stored = await storeCalls(item, arm, call.toolCalls, cellKey(cell, arm));
  return { call, stored, score: score(item, stored) };
}

const count = (values: readonly boolean[]): string => `${values.filter(Boolean).length}/${values.length}`;
const mean = (values: readonly number[]): number => (values.length === 0 ? 0 : Math.round(values.reduce((a, b) => a + b, 0) / values.length));

function summarize(rows: readonly { N: ArmResult; S: ArmResult }[]): object {
  return Object.fromEntries(ARMS.map((arm) => {
    const scores = rows.map((row) => row[arm].score);
    return [arm, {
      factsInNotes: count(scores.flatMap((s) => s.inNotes)),
      factsAnywhere: count(scores.flatMap((s) => s.anywhere)),
      traps: scores.flatMap((s) => s.trapsAnywhere).length,
      order: scores.map((s) => s.orderAnywhere).filter((o) => o !== 'none'),
      orderInNotes: scores.map((s) => s.orderInNotes).filter((o) => o !== 'none'),
      cellsWithSkill: scores.filter((s) => s.skillCount > 0).length,
      cellsWithSkillButNoNote: scores.filter((s) => s.skillCount > 0 && s.noteCount === 0).length,
      notesPerCell: (scores.reduce((sum, s) => sum + s.noteCount, 0) / Math.max(scores.length, 1)).toFixed(1),
      activeNotes: scores.reduce((sum, s) => sum + s.activeNotes, 0),
      noteCharsPerCell: mean(scores.map((s) => s.noteChars)),
      outputTokens: mean(rows.map((row) => row[arm].call.usage.outputTokens)),
      rejectedOps: rows.flatMap((row) => row[arm].stored.trace).filter((line) => line.startsWith('REJECTED')).length,
    }];
  }));
}

export async function pack(scope: Scope, root: string = CAPTURE_ROOT): Promise<object> {
  const rows: { cell: Cell; N: ArmResult; S: ArmResult }[] = [];
  const missing: string[] = [];
  for (const cell of plannedCells(scope)) {
    const N = await loadArm(root, cell, 'N');
    const S = await loadArm(root, cell, 'S');
    if (N === undefined || S === undefined) missing.push(cellKey(cell, 'S'));
    else rows.push({ cell, N, S });
  }
  // Paired per fact: does N's note carry a fact that S kept usable (in a note), and the other way round.
  const paired = { nOnly: 0, sOnly: 0, both: 0, neither: 0, sOnlyInSkill: 0 };
  for (const row of rows) {
    row.N.score.inNotes.forEach((n, index) => {
      const s = row.S.score.inNotes[index]!;
      if (n && s) paired.both += 1;
      else if (n) paired.nOnly += 1;
      else if (s) paired.sOnly += 1;
      else paired.neither += 1;
      if (!n && !s && row.S.score.anywhere[index]) paired.sOnlyInSkill += 1;
    });
  }
  const byAlias = Object.fromEntries(SCOPES[scope].aliases.map((alias) => [alias, summarize(rows.filter((row) => row.cell.alias === alias))]));
  const byCase = Object.fromEntries(SCOPES[scope].cases.map((caseId) => [caseId, summarize(rows.filter((row) => row.cell.caseId === caseId))]));
  // The reviewer reads only the pack. The key and the per-arm tallies sit in their own files
  // so the verdicts can be written before either is opened. Trace lines about the skill tool
  // would name arm S, so the pack leaves them out; a stored skill still shows.
  const key: Record<string, { X: Arm; Y: Arm }> = {};
  const blind = rows.map((row) => {
    const item = caseOf(row.cell.caseId);
    const cell = cellKey(row.cell, 'S');
    const sFirst = parseInt(sha256(cell).slice(0, 2), 16) % 2 === 0;
    const [x, y] = sFirst ? (['S', 'N'] as const) : (['N', 'S'] as const);
    key[cell] = { X: x, Y: y };
    const side = (arm: Arm) => ({
      notes: row[arm].stored.notes,
      skills: row[arm].stored.skills,
      trace: row[arm].stored.trace.filter((line) => !line.includes(SKILL_TOOL_NAME)),
      mechanical: row[arm].score,
    });
    return {
      key: cell, caseId: item.id, alias: row.cell.alias, shape: item.shape,
      facts: item.facts.map((fact) => fact.label), traps: item.traps.map((trap) => trap.label),
      X: side(x), Y: side(y),
    };
  });
  const review = path.join(root, 'review');
  const { calls, committedTokens, committedUsd } = ledgerState(readLedger(root));
  await writeJsonAtomic(path.join(review, `${scope}-pack.json`), blind);
  await writeJsonAtomic(path.join(review, `${scope}-key.json`), key);
  await writeJsonAtomic(path.join(review, `${scope}-summary.json`), { scope, caseHash: caseHash(), cells: rows.length, all: summarize(rows), paired, byAlias, byCase });
  return { scope, cells: rows.length, missing, review, ledger: { calls, committedTokens, committedUsd } };
}

// ---------------------------------------------------------------- cli

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  const root = flag('raw-root') ?? CAPTURE_ROOT;
  const scope = (flag('scope') ?? 'pilot') as Scope;
  if (scope !== 'pilot' && scope !== 'full') throw new Error('--scope must be pilot or full');
  const out = (value: object): void => { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); };
  if (mode === 'prepare') out(await prepare(root));
  else if (mode === 'run') out(await run(scope, flag('confirm-budget') ?? '', root));
  else if (mode === 'pack') out(await pack(scope, root));
  else throw new Error('usage: runner.ts <prepare|run|pack> [--scope pilot|full] [--raw-root DIR] [--confirm-budget TOKEN]');
}

if (process.env.VITEST === undefined && import.meta.url === pathToFileURL(process.argv[1] ?? '').href
  && ['prepare', 'run', 'pack'].includes(process.argv[2] ?? '')) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
