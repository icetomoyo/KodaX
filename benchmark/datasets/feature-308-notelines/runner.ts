/**
 * FEATURE_308 note-line A/B runner.
 *
 *   prepare  zero provider calls: builds both arms' inputs from production code,
 *            checks the pinned hashes, writes the contract and the estimate.
 *   run      paid calls (--stage pilot|full); one in flight per alias, aliases in
 *            parallel; only with the exact budget confirmation string; a
 *            pre-request ledger enforces every cap across both stages.
 *   pack     zero provider calls: blinded review pack (X/Y per case, alias and
 *            repetition) plus a separate unblind map.
 *   tally    zero provider calls: mechanical diagnostics per arm, read after the
 *            blind review is written.
 */
import { appendFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { KodaXTokenUsage } from '@kodax-ai/llm';

import { MODEL_ALIASES, type ModelAlias } from '../../harness/aliases.js';
import { runOneShot } from '../../harness/harness.js';
import type { ModelOutput, Scored } from '../feature-308-baseline/oracles.js';
import { estimateCost, ledgerState, readLedger, sha256, type LedgerEntry, type LedgerState } from '../feature-308-baseline/runner.js';
import { hashOf } from '../feature-308-reflect/experiment-contract.js';
import { replayReflectCalls, type ReflectCellInput } from '../feature-308-reflect/inputs.js';
import { reflectCalls } from '../feature-308-reflect/oracles.js';
import { NOTELINE_CASES, type NoteLineCase } from './cases.js';
import {
  NOTELINE_ALIASES,
  NOTELINE_ARM_A_SHA256,
  NOTELINE_BUDGET,
  NOTELINE_BUDGET_CONFIRMATION,
  NOTELINE_RAW_ROOT,
  NOTELINE_REVISION,
  PILOT_ALIASES,
  PILOT_CASE_IDS,
  buildNoteLineExperimentContract,
} from './experiment-contract.js';
import { ARMS, buildNoteLineInput, type Arm } from './inputs.js';
import { addedLines, scoreNoteLineCell } from './oracles.js';

export type Stage = 'pilot' | 'full';

export interface Cell {
  readonly key: string;
  readonly stage: Stage;
  readonly caseId: string;
  readonly alias: ModelAlias;
  readonly arm: Arm;
  readonly repetition: number;
}

export interface PreparedCell extends Cell {
  readonly input: ReflectCellInput;
  readonly inputHash: string;
  readonly estimatedInputTokens: number;
}

interface CellResponse extends ModelOutput {
  readonly usage: KodaXTokenUsage;
  readonly durationMs: number;
}

interface CellResult {
  readonly schemaVersion: 1;
  readonly revision: string;
  readonly cell: Cell;
  readonly inputHash: string;
  readonly response: CellResponse;
  readonly estimatedCostUsd: number;
}

const BYTES_PER_TOKEN = 3;
const EXPECTED_OUTPUT_TOKENS = 4_096;
const TOKEN_BUDGET_SLACK = 1.25;
const TOKEN_BUDGET_ROUNDING = 50_000;
const BLIND_SEED = NOTELINE_REVISION;

const CASE_BY_ID = new Map<string, NoteLineCase>(NOTELINE_CASES.map((item) => [item.id, item]));
const aliasDir = (alias: ModelAlias): string => alias.replace('/', '_');

export function cellKey(cell: Omit<Cell, 'key'>): string {
  return `${cell.stage}__${aliasDir(cell.alias)}__${cell.caseId}__${cell.arm}__rep${cell.repetition}`;
}

export function plannedCells(stage: Stage): readonly Cell[] {
  const aliases = stage === 'pilot' ? PILOT_ALIASES : NOTELINE_ALIASES;
  const cases = stage === 'pilot' ? NOTELINE_CASES.filter((item) => PILOT_CASE_IDS.includes(item.id)) : NOTELINE_CASES;
  const repetitions = stage === 'pilot' ? 1 : NOTELINE_BUDGET.repetitions;
  const cells: Cell[] = [];
  for (let repetition = 1; repetition <= repetitions; repetition++) {
    for (const alias of aliases) {
      for (const item of cases) {
        for (const arm of ARMS) {
          const cell = { stage, caseId: item.id, alias, arm, repetition };
          cells.push({ key: cellKey(cell), ...cell });
        }
      }
    }
  }
  return cells;
}

function estimateInputTokens(input: ReflectCellInput): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(input), 'utf8') / BYTES_PER_TOKEN);
}

type BuiltInput = Pick<PreparedCell, 'input' | 'inputHash' | 'estimatedInputTokens'>;

/** Builds every case in both arms once; inputs do not depend on alias or repetition. */
export async function buildArmInputs(): Promise<ReadonlyMap<string, BuiltInput>> {
  const built = new Map<string, BuiltInput>();
  for (const item of NOTELINE_CASES) {
    for (const arm of ARMS) {
      const input = await buildNoteLineInput(item, arm);
      built.set(`${item.id}:${arm}`, { input, inputHash: sha256(JSON.stringify(input)), estimatedInputTokens: estimateInputTokens(input) });
    }
  }
  return built;
}

/** Arm A must still be the pinned pre-change bytes, and arm B must differ from it. */
export function checkArms(built: ReadonlyMap<string, BuiltInput>): { readonly armAHash: string; readonly identicalCases: readonly string[] } {
  const armAHash = hashOf(NOTELINE_CASES.map((item) => built.get(`${item.id}:A`)!.inputHash));
  const identicalCases = NOTELINE_CASES.filter((item) => built.get(`${item.id}:A`)!.inputHash === built.get(`${item.id}:B`)!.inputHash).map((item) => item.id);
  return { armAHash, identicalCases };
}

function assertArms(built: ReadonlyMap<string, BuiltInput>): void {
  const { armAHash, identicalCases } = checkArms(built);
  if (armAHash !== NOTELINE_ARM_A_SHA256) throw new Error(`note-line arm A inputs changed (${armAHash}); arm A must stay the pinned pre-change bytes.`);
  if (identicalCases.length > 0) throw new Error(`note-line arms are identical for ${identicalCases.join(', ')}; arm B is not the changed prompt.`);
}

export async function prepareCells(stage: Stage): Promise<readonly PreparedCell[]> {
  const built = await buildArmInputs();
  assertArms(built);
  return plannedCells(stage).map((cell) => ({ ...cell, ...built.get(`${cell.caseId}:${cell.arm}`)! }));
}

export interface TokenBudgetDerivation {
  readonly estimatedInputTokens: number;
  readonly expectedOutputTokens: number;
  readonly derivedMaxTotalTokens: number;
}

export function deriveTokenBudget(cells: readonly Pick<PreparedCell, 'estimatedInputTokens'>[]): TokenBudgetDerivation {
  const estimatedInputTokens = cells.reduce((sum, cell) => sum + cell.estimatedInputTokens, 0);
  const expectedOutputTokens = cells.length * EXPECTED_OUTPUT_TOKENS;
  const raw = (estimatedInputTokens + expectedOutputTokens) * TOKEN_BUDGET_SLACK;
  return { estimatedInputTokens, expectedOutputTokens, derivedMaxTotalTokens: Math.ceil(raw / TOKEN_BUDGET_ROUNDING) * TOKEN_BUDGET_ROUNDING };
}

export function assertLedgerAllows(state: LedgerState, cell: Pick<PreparedCell, 'key' | 'alias' | 'estimatedInputTokens'>): void {
  const reserved = NOTELINE_BUDGET.maxOutputTokensPerCall;
  if (state.requestedCells.has(cell.key)) throw new Error(`feature-308-notelines per-cell call cap exceeded for ${cell.key}`);
  if (state.calls + 1 > NOTELINE_BUDGET.maxProviderCalls) throw new Error('feature-308-notelines provider call cap exceeded');
  if (state.committedTokens + cell.estimatedInputTokens + reserved > NOTELINE_BUDGET.maxTotalTokens) {
    throw new Error('feature-308-notelines total token cap exceeded');
  }
  const usd = state.committedUsd + estimateCost(cell.alias, { inputTokens: cell.estimatedInputTokens, outputTokens: reserved });
  if (usd > NOTELINE_BUDGET.maxExternalSpendUsd) throw new Error('feature-308-notelines spend cap exceeded');
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

const cellPath = (root: string, cell: Pick<Cell, 'stage' | 'alias' | 'key'>): string =>
  path.join(root, 'cells', cell.stage, aliasDir(cell.alias), `${cell.key}.json`);

/** Synchronous append so the request is on disk before the provider is contacted. */
function appendLedger(root: string, entry: LedgerEntry): void {
  appendFileSync(path.join(root, 'ledger.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, 'utf8');
}

// ---------------------------------------------------------------- prepare

export interface PrepareSummary {
  readonly calls: number;
  readonly derivation: TokenBudgetDerivation;
  readonly frozenMaxTotalTokens: number;
  readonly frozenCoversDerived: boolean;
  readonly estimatedCostUsdAtWorstCaseOutput: number;
}

export async function prepare(root: string = NOTELINE_RAW_ROOT): Promise<PrepareSummary> {
  const cells = [...await prepareCells('pilot'), ...await prepareCells('full')];
  const derivation = deriveTokenBudget(cells);
  const worstCaseUsd = cells.reduce((sum, cell) => sum + estimateCost(cell.alias, {
    inputTokens: cell.estimatedInputTokens, outputTokens: NOTELINE_BUDGET.maxOutputTokensPerCall,
  }), 0);
  await writeJsonAtomic(path.join(root, 'contract.json'), buildNoteLineExperimentContract());
  await writeJsonAtomic(path.join(root, 'prepare', 'cells.json'), cells.map((cell) => ({
    key: cell.key, inputHash: cell.inputHash, estimatedInputTokens: cell.estimatedInputTokens,
  })));
  const summary = {
    calls: cells.length,
    derivation,
    frozenMaxTotalTokens: NOTELINE_BUDGET.maxTotalTokens,
    frozenCoversDerived: NOTELINE_BUDGET.maxTotalTokens >= derivation.derivedMaxTotalTokens,
    estimatedCostUsdAtWorstCaseOutput: worstCaseUsd,
  };
  await writeJsonAtomic(path.join(root, 'prepare', 'estimate.json'), {
    bytesPerToken: BYTES_PER_TOKEN, expectedOutputTokensPerCall: EXPECTED_OUTPUT_TOKENS, slack: TOKEN_BUDGET_SLACK, ...summary,
  });
  return summary;
}

// ---------------------------------------------------------------- scoring

interface ScoredCell {
  readonly scored: Scored;
  readonly lines: readonly string[];
  readonly replay: readonly string[];
}

export async function scoreCell(cell: Cell, output: ModelOutput): Promise<ScoredCell> {
  const item = CASE_BY_ID.get(cell.caseId)!;
  const replay = await replayReflectCalls(item, cell.key, reflectCalls(output));
  return {
    scored: scoreNoteLineCell(item, output, replay),
    lines: addedLines(replay),
    replay: replay.calls.map((call) => `${call.input?.operation ?? '?'} ${call.input?.id ?? '?'}: ${call.result.message}`),
  };
}

// ---------------------------------------------------------------- run

export interface RunOptions {
  readonly stage: Stage;
  readonly confirmBudget: string;
  readonly rawRoot?: string;
}

export interface RunSummary {
  readonly externalCallsThisRun: number;
  readonly completedCells: number;
  readonly plannedCells: number;
  readonly skippedAfterFailure: readonly string[];
  readonly ledger: Pick<LedgerState, 'calls' | 'committedTokens' | 'committedUsd'>;
}

function assertCredentials(aliases: readonly ModelAlias[]): void {
  const missing = aliases.filter((alias) => (process.env[MODEL_ALIASES[alias].apiKeyEnv] ?? '').length === 0);
  if (missing.length > 0) throw new Error(`feature-308-notelines missing API key env for: ${missing.join(', ')}`);
}

async function callCell(cell: PreparedCell): Promise<CellResponse> {
  const output = await runOneShot(cell.alias, {
    systemPrompt: cell.input.systemPrompt,
    userMessage: cell.input.userMessage,
    tools: cell.input.tools,
    timeoutMs: NOTELINE_BUDGET.timeoutMs,
    maxOutputTokens: NOTELINE_BUDGET.maxOutputTokensPerCall,
  });
  if (output.usage === undefined) throw new Error('provider usage is missing');
  return { text: output.text, toolCalls: output.toolCalls, usage: output.usage, durationMs: output.durationMs };
}

export async function run(options: RunOptions): Promise<RunSummary> {
  if (options.confirmBudget !== NOTELINE_BUDGET_CONFIRMATION) {
    throw new Error(`feature-308-notelines paid run needs --confirm-budget ${NOTELINE_BUDGET_CONFIRMATION}`);
  }
  const root = options.rawRoot ?? NOTELINE_RAW_ROOT;
  const cells = await prepareCells(options.stage);
  assertCredentials([...new Set(cells.map((cell) => cell.alias))]);
  await prepare(root);
  const skipped: string[] = [];
  let external = 0;
  let completed = 0;
  let failure: unknown;

  const runLane = async (laneCells: readonly PreparedCell[]): Promise<void> => {
    for (const cell of laneCells) {
      if (failure !== undefined) return;
      const existing = await readJson<CellResult>(cellPath(root, cell));
      if (existing !== undefined) {
        if (existing.inputHash !== cell.inputHash) throw new Error(`feature-308-notelines cached result for ${cell.key} has a different input hash`);
        completed++;
        continue;
      }
      if (ledgerState(readLedger(root)).requestedCells.has(cell.key)) {
        skipped.push(cell.key);
        continue;
      }
      // Check and append in one synchronous step so parallel lanes cannot both pass the same cap.
      assertLedgerAllows(ledgerState(readLedger(root)), cell);
      appendLedger(root, {
        event: 'requested', cellKey: cell.key, alias: cell.alias,
        estimatedInputTokens: cell.estimatedInputTokens, reservedOutputTokens: NOTELINE_BUDGET.maxOutputTokensPerCall,
      });
      external++;
      try {
        const response = await callCell(cell);
        const estimatedCostUsd = estimateCost(cell.alias, response.usage);
        const result: CellResult = {
          schemaVersion: 1,
          revision: NOTELINE_REVISION,
          cell: { key: cell.key, stage: cell.stage, caseId: cell.caseId, alias: cell.alias, arm: cell.arm, repetition: cell.repetition },
          inputHash: cell.inputHash,
          response,
          estimatedCostUsd,
        };
        await writeJsonAtomic(cellPath(root, cell), result);
        appendLedger(root, { event: 'completed', cellKey: cell.key, alias: cell.alias, usage: response.usage, estimatedCostUsd });
        completed++;
      } catch (error) {
        appendLedger(root, { event: 'failed', cellKey: cell.key, alias: cell.alias, error: error instanceof Error ? error.message : String(error) });
        // Fail fast across lanes: the lead inspects before any further spend; a failed cell is never retried.
        failure ??= error;
        throw error;
      }
    }
  };

  const aliases = [...new Set(cells.map((cell) => cell.alias))];
  const settled = await Promise.allSettled(aliases.map((alias) => runLane(cells.filter((cell) => cell.alias === alias))));
  const rejected = settled.find((item): item is PromiseRejectedResult => item.status === 'rejected');
  if (rejected !== undefined) throw rejected.reason;
  const { calls, committedTokens, committedUsd } = ledgerState(readLedger(root));
  return { externalCallsThisRun: external, completedCells: completed, plannedCells: cells.length, skippedAfterFailure: skipped, ledger: { calls, committedTokens, committedUsd } };
}

// ---------------------------------------------------------------- pack

/** Deterministic per-pair coin so the reviewer cannot learn which side is which from position. */
export function armShownAsX(pairId: string): Arm {
  return Number.parseInt(sha256(`${BLIND_SEED}:${pairId}`).slice(0, 8), 16) % 2 === 0 ? 'A' : 'B';
}

interface Side {
  readonly text: string;
  readonly lines: readonly string[];
  readonly replay: readonly string[];
  readonly mechanical: Scored['verdict'];
}

async function side(root: string, cell: Cell): Promise<Side | undefined> {
  const result = await readJson<CellResult>(cellPath(root, cell));
  if (result === undefined) return undefined;
  const { scored, lines, replay } = await scoreCell(cell, result.response);
  return { text: result.response.text.trim().slice(0, 600), lines, replay, mechanical: scored.verdict };
}

function pairIdOf(cell: Cell): string {
  return `${cell.stage}__${aliasDir(cell.alias)}__${cell.caseId}__rep${cell.repetition}`;
}

/** One line per block so the reviewer reads the session, not its JSON. */
function renderSession(messages: NoteLineCase['messages']): string {
  const lines: string[] = [];
  for (const message of messages) {
    const blocks = typeof message.content === 'string' ? [{ type: 'text' as const, text: message.content }] : message.content;
    for (const block of blocks) {
      if (block.type === 'text') lines.push(`${message.role}: ${block.text}`);
      else if (block.type === 'tool_use') lines.push(`${message.role} calls ${block.name}: ${JSON.stringify(block.input)}`);
      else if (block.type === 'tool_result') lines.push(`result: ${typeof block.content === 'string' ? block.content : JSON.stringify(block.content)}`);
    }
  }
  return lines.map((line) => `    ${line.replace(/\n/g, '\n      ')}`).join('\n');
}

function renderSide(label: string, value: Side): string {
  const lines = value.lines.length > 0 ? value.lines.map((line) => `    ${line}`).join('\n') : '    (no new note)';
  const replay = value.replay.length > 0 ? value.replay.map((line) => `    ${line}`).join('\n') : '    (no call)';
  return `  ${label} new index lines:\n${lines}\n  ${label} calls:\n${replay}${value.text.length > 0 ? `\n  ${label} text: ${value.text.replace(/\s+/g, ' ')}` : ''}`;
}

export interface PackSummary {
  readonly pairs: number;
  readonly missing: readonly string[];
}

export async function pack(stage: Stage, rawRoot: string = NOTELINE_RAW_ROOT): Promise<PackSummary> {
  const missing: string[] = [];
  const unblind: Record<string, { X: Arm; Y: Arm }> = {};
  const byCase = new Map<string, string[]>();
  for (const cell of plannedCells(stage).filter((item) => item.arm === 'A')) {
    const pairId = pairIdOf(cell);
    const other = { ...cell, arm: 'B' as const, key: cellKey({ ...cell, arm: 'B' }) };
    const [a, b] = [await side(rawRoot, cell), await side(rawRoot, other)];
    if (a === undefined || b === undefined) { missing.push(pairId); continue; }
    const x = armShownAsX(pairId);
    unblind[pairId] = { X: x, Y: x === 'A' ? 'B' : 'A' };
    const [shownX, shownY] = x === 'A' ? [a, b] : [b, a];
    const block = `- ${pairId}\n${renderSide('X', shownX)}\n${renderSide('Y', shownY)}`;
    byCase.set(cell.caseId, [...(byCase.get(cell.caseId) ?? []), block]);
  }
  const sections = [...byCase].map(([caseId, blocks]) => {
    const item = CASE_BY_ID.get(caseId)!;
    const seeds = item.seeds.map((seed) => `  [${seed.status}] ${seed.id}: ${seed.description}`).join('\n');
    return `## ${caseId} (${item.family})\n\nSession:\n${renderSession(item.messages)}\n${seeds.length > 0 ? `Notes before:\n${seeds}\n` : ''}\n${blocks.join('\n\n')}\n`;
  });
  const dir = path.join(rawRoot, 'main-session-review', stage);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'blind-pack.md'), `# ${NOTELINE_REVISION} ${stage} blind pack\n\n${sections.join('\n')}`, 'utf8');
  await writeJsonAtomic(path.join(dir, 'unblind.json'), unblind);
  return { pairs: Object.keys(unblind).length, missing };
}

/** Mechanical diagnostics per arm; read only after the blind review is on disk. */
export async function tally(stage: Stage, rawRoot: string = NOTELINE_RAW_ROOT): Promise<Readonly<Record<string, Readonly<Record<Arm, string>>>>> {
  const counts = new Map<string, Record<Arm, { pass: number; total: number }>>();
  for (const cell of plannedCells(stage)) {
    const value = await side(rawRoot, cell);
    if (value === undefined) continue;
    const kind = `${CASE_BY_ID.get(cell.caseId)!.expect.kind}`;
    const entry = counts.get(kind) ?? { A: { pass: 0, total: 0 }, B: { pass: 0, total: 0 } };
    entry[cell.arm] = { pass: entry[cell.arm].pass + (value.mechanical === 'pass' ? 1 : 0), total: entry[cell.arm].total + 1 };
    counts.set(kind, entry);
  }
  return Object.fromEntries([...counts].map(([kind, entry]) => [kind, { A: `${entry.A.pass}/${entry.A.total}`, B: `${entry.B.pass}/${entry.B.total}` }]));
}

// ---------------------------------------------------------------- CLI

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function stageFlag(): Stage {
  const value = flag('stage');
  if (value !== 'pilot' && value !== 'full') throw new Error('--stage must be pilot or full');
  return value;
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  const rawRoot = flag('raw-root');
  const out = (value: unknown): void => { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); };
  if (mode === 'prepare') out(await prepare(rawRoot));
  else if (mode === 'run') out(await run({ stage: stageFlag(), confirmBudget: flag('confirm-budget') ?? '', ...(rawRoot === undefined ? {} : { rawRoot }) }));
  else if (mode === 'pack') out(await pack(stageFlag(), rawRoot));
  else if (mode === 'tally') out(await tally(stageFlag(), rawRoot));
  else throw new Error('usage: runner.ts <prepare|run|pack|tally> [--stage pilot|full] [--raw-root DIR] [--confirm-budget TOKEN]');
}

if (process.env.VITEST === undefined && import.meta.url === pathToFileURL(process.argv[1] ?? '').href
  && ['prepare', 'run', 'pack', 'tally'].includes(process.argv[2] ?? '')) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
