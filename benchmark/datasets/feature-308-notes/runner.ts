/**
 * FEATURE_308 Phase 1b runner (arm N = the new note memory).
 *
 *   prepare  zero provider calls: builds every cell input from production code,
 *            checks the Phase 0 baseline inputs are unchanged, writes the contract
 *            and the byte/token estimate.
 *   run      paid calls; one in flight per alias, aliases in parallel; only with the
 *            exact budget confirmation string; a pre-request ledger enforces every cap.
 *   pack     zero provider calls: scores raw results, replays memory calls through the
 *            real operation, and writes the blinded X/Y/Z evidence set (A none / B old
 *            / N new) plus the unblind map for the main-session review.
 */
import { appendFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { KodaXMessage, KodaXTokenUsage, KodaXToolDefinition } from '@kodax-ai/llm';

import { MODEL_ALIASES, type ModelAlias } from '../../harness/aliases.js';
import { runOneShot } from '../../harness/harness.js';
import { FEATURE_308_READ_CASES, type ReadCase } from '../feature-308-baseline/cases.js';
import { buildReadCellInput } from '../feature-308-baseline/inputs.js';
import { scoreReadCell, type ModelOutput, type Scored } from '../feature-308-baseline/oracles.js';
import {
  cellKey as phase0CellKey,
  estimateCost,
  ledgerState,
  readLedger,
  sha256,
  type LedgerEntry,
  type LedgerState,
} from '../feature-308-baseline/runner.js';
import { FEATURE_308_PROBE_CASES, type ProbeCase } from './cases.js';
import {
  NEW_BASELINE_ALIASES,
  NOTES_ALIASES,
  NOTES_BUDGET,
  NOTES_BUDGET_CONFIRMATION,
  NOTES_RAW_ROOT,
  NOTES_REVISION,
  PHASE0_BASELINE_ALIASES,
  PHASE0_ROOT,
  buildNotesExperimentContract,
} from './experiment-contract.js';
import { buildNotesCellInput, replayMemoryCalls } from './inputs.js';
import { memoryCalls, scoreNotesReadCell, scoreProbeCell } from './oracles.js';

export type NotesArm = 'A' | 'B' | 'N';

export interface Cell {
  readonly key: string;
  readonly kind: 'read' | 'probe';
  readonly caseId: string;
  readonly arm: NotesArm;
  readonly alias: ModelAlias;
  readonly repetition: number;
}

interface CellInput {
  readonly systemPrompt: string;
  readonly priorMessages: readonly KodaXMessage[];
  readonly userMessage: string;
  readonly tools: readonly KodaXToolDefinition[];
}

export interface PreparedCell extends Cell {
  readonly input: CellInput;
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
  readonly mechanical: Scored;
  /** Probe/N cells: what the real `memory` operation did with each recorded call. */
  readonly replay?: readonly string[];
}

const BYTES_PER_TOKEN = 3;
const EXPECTED_OUTPUT_TOKENS = 4_096;
const TOKEN_BUDGET_SLACK = 1.25;
const TOKEN_BUDGET_ROUNDING = 50_000;

const READ_CASE_BY_ID = new Map<string, ReadCase>(FEATURE_308_READ_CASES.map((item) => [item.id, item]));
const PROBE_BY_ID = new Map<string, ProbeCase>(FEATURE_308_PROBE_CASES.map((item) => [item.id, item]));

export function cellKey(alias: ModelAlias, caseId: string, arm: NotesArm, repetition: number): string {
  return phase0CellKey(alias, caseId, arm as 'A' | 'B', repetition);
}

export function plannedCells(): readonly Cell[] {
  const cells: Cell[] = [];
  const add = (alias: ModelAlias, kind: Cell['kind'], caseId: string, arm: NotesArm, repetition: number): void => {
    cells.push({ key: cellKey(alias, caseId, arm, repetition), kind, caseId, arm, alias, repetition });
  };
  for (let repetition = 1; repetition <= NOTES_BUDGET.repetitions; repetition++) {
    for (const alias of NOTES_ALIASES) {
      for (const item of FEATURE_308_READ_CASES) add(alias, 'read', item.id, 'N', repetition);
      for (const item of FEATURE_308_PROBE_CASES) add(alias, 'probe', item.id, 'N', repetition);
    }
    for (const alias of NEW_BASELINE_ALIASES) {
      for (const item of FEATURE_308_READ_CASES) {
        add(alias, 'read', item.id, 'A', repetition);
        add(alias, 'read', item.id, 'B', repetition);
      }
    }
  }
  return cells;
}

async function buildInput(kind: Cell['kind'], caseId: string, arm: NotesArm): Promise<CellInput> {
  if (kind === 'probe') return buildNotesCellInput(PROBE_BY_ID.get(caseId)!);
  const readCase = READ_CASE_BY_ID.get(caseId)!;
  return arm === 'N' ? buildNotesCellInput(readCase) : buildReadCellInput(readCase, arm);
}

function estimateInputTokens(input: CellInput): number {
  const bytes = Buffer.byteLength(JSON.stringify({
    system: input.systemPrompt, messages: input.priorMessages, user: input.userMessage, tools: input.tools,
  }), 'utf8');
  return Math.ceil(bytes / BYTES_PER_TOKEN);
}

/** Inputs do not depend on alias or repetition, so each (case, arm) is built once. */
async function buildShapes(shapes: readonly { kind: Cell['kind']; caseId: string; arm: NotesArm }[]): Promise<Map<string, Omit<PreparedCell, keyof Cell>>> {
  const built = new Map<string, Omit<PreparedCell, keyof Cell>>();
  for (const shape of shapes) {
    const id = `${shape.caseId}/${shape.arm}`;
    if (built.has(id)) continue;
    const input = await buildInput(shape.kind, shape.caseId, shape.arm);
    built.set(id, { input, inputHash: sha256(JSON.stringify(input)), estimatedInputTokens: estimateInputTokens(input) });
  }
  return built;
}

export async function prepareCells(): Promise<readonly PreparedCell[]> {
  const cells = plannedCells();
  const built = await buildShapes(cells);
  return cells.map((cell) => ({ ...cell, ...built.get(`${cell.caseId}/${cell.arm}`)! }));
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
  const reserved = NOTES_BUDGET.maxOutputTokensPerCall;
  if (state.requestedCells.has(cell.key)) throw new Error(`feature-308-notes per-cell call cap exceeded for ${cell.key}`);
  if (state.calls + 1 > NOTES_BUDGET.maxProviderCalls) throw new Error('feature-308-notes provider call cap exceeded');
  if (state.committedTokens + cell.estimatedInputTokens + reserved > NOTES_BUDGET.maxTotalTokens) {
    throw new Error('feature-308-notes total token cap exceeded');
  }
  const usd = state.committedUsd + estimateCost(cell.alias, { inputTokens: cell.estimatedInputTokens, outputTokens: reserved });
  if (usd > NOTES_BUDGET.maxExternalSpendUsd) throw new Error('feature-308-notes spend cap exceeded');
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

const aliasDir = (alias: ModelAlias): string => alias.replace('/', '_');
const cellPath = (root: string, cell: Pick<Cell, 'alias' | 'key'>): string => path.join(root, 'cells', aliasDir(cell.alias), `${cell.key}.json`);

/** Synchronous append so the request is on disk before the provider is contacted. */
function appendLedger(root: string, entry: LedgerEntry): void {
  appendFileSync(path.join(root, 'ledger.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, 'utf8');
}

// ---------------------------------------------------------------- prepare

export interface PrepareSummary {
  readonly cells: number;
  readonly derivation: TokenBudgetDerivation;
  readonly frozenMaxTotalTokens: number;
  readonly frozenCoversDerived: boolean;
  readonly estimatedCostUsdAtWorstCaseOutput: number;
  /** Phase 0 cells whose stored input differs from what production code builds today. */
  readonly baselineHashMismatches: readonly string[];
  readonly baselineCellsMissing: readonly string[];
}

/** The reused A/B baselines are only comparable if production still builds byte-identical inputs. */
async function checkPhase0Baseline(): Promise<{ mismatches: string[]; missing: string[] }> {
  const shapes = FEATURE_308_READ_CASES.flatMap((item) => (['A', 'B'] as const).map((arm) => ({ kind: 'read' as const, caseId: item.id, arm })));
  const built = await buildShapes(shapes);
  const mismatches: string[] = [];
  const missing: string[] = [];
  for (const alias of PHASE0_BASELINE_ALIASES) {
    for (const shape of shapes) {
      const key = phase0CellKey(alias, shape.caseId, shape.arm, 1);
      const stored = await readJson<{ inputHash: string }>(cellPath(PHASE0_ROOT, { alias, key }));
      if (stored === undefined) missing.push(key);
      else if (stored.inputHash !== built.get(`${shape.caseId}/${shape.arm}`)!.inputHash) mismatches.push(key);
    }
  }
  return { mismatches, missing };
}

export async function prepare(root: string = NOTES_RAW_ROOT): Promise<PrepareSummary> {
  const cells = await prepareCells();
  const derivation = deriveTokenBudget(cells);
  const worstCaseUsd = cells.reduce((sum, cell) => sum + estimateCost(cell.alias, {
    inputTokens: cell.estimatedInputTokens, outputTokens: NOTES_BUDGET.maxOutputTokensPerCall,
  }), 0);
  const baseline = await checkPhase0Baseline();
  await writeJsonAtomic(path.join(root, 'contract.json'), buildNotesExperimentContract());
  await writeJsonAtomic(path.join(root, 'prepare', 'cells.json'), cells.map((cell) => ({
    key: cell.key,
    inputHash: cell.inputHash,
    estimatedInputTokens: cell.estimatedInputTokens,
    systemChars: cell.input.systemPrompt.length,
    toolNames: cell.input.tools.map((tool) => tool.name),
    toolBytes: Buffer.byteLength(JSON.stringify(cell.input.tools), 'utf8'),
    priorMessages: cell.input.priorMessages.length,
  })));
  await writeJsonAtomic(path.join(root, 'prepare', 'estimate.json'), {
    bytesPerToken: BYTES_PER_TOKEN,
    expectedOutputTokensPerCall: EXPECTED_OUTPUT_TOKENS,
    slack: TOKEN_BUDGET_SLACK,
    ...derivation,
    frozenMaxTotalTokens: NOTES_BUDGET.maxTotalTokens,
    estimatedCostUsdAtWorstCaseOutput: worstCaseUsd,
    baselineHashMismatches: baseline.mismatches,
    baselineCellsMissing: baseline.missing,
  });
  return {
    cells: cells.length,
    derivation,
    frozenMaxTotalTokens: NOTES_BUDGET.maxTotalTokens,
    frozenCoversDerived: NOTES_BUDGET.maxTotalTokens >= derivation.derivedMaxTotalTokens,
    estimatedCostUsdAtWorstCaseOutput: worstCaseUsd,
    baselineHashMismatches: baseline.mismatches,
    baselineCellsMissing: baseline.missing,
  };
}

// ---------------------------------------------------------------- scoring

/** Mechanical score plus, for arm N, the trace of what the real memory operation did with each call. */
export async function scoreCell(cell: Cell, output: ModelOutput): Promise<{ scored: Scored; replay?: readonly string[] }> {
  if (cell.kind === 'probe') {
    const probe = PROBE_BY_ID.get(cell.caseId)!;
    const replay = await replayMemoryCalls(probe, cell.key, memoryCalls(output).map((call) => call.input));
    return {
      scored: scoreProbeCell(probe, output, replay),
      replay: replay.calls.map((call) => `${call.input.operation} ${call.input.id}: ${call.result.message}`),
    };
  }
  const readCase = READ_CASE_BY_ID.get(cell.caseId)!;
  if (cell.arm !== 'N') return { scored: scoreReadCell(readCase.oracle, output) };
  const replay = await replayMemoryCalls(readCase, cell.key, memoryCalls(output).map((call) => call.input));
  return {
    scored: scoreNotesReadCell(readCase.oracle, output),
    replay: replay.calls.map((call) => `${call.input.operation} ${call.input.id}: ${call.result.message}`),
  };
}

// ---------------------------------------------------------------- run

export interface RunOptions {
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
  if (missing.length > 0) throw new Error(`feature-308-notes missing API key env for: ${missing.join(', ')}`);
}

async function callCell(cell: PreparedCell): Promise<CellResponse> {
  const output = await runOneShot(cell.alias, {
    systemPrompt: cell.input.systemPrompt,
    priorMessages: cell.input.priorMessages,
    userMessage: cell.input.userMessage,
    tools: cell.input.tools,
    timeoutMs: NOTES_BUDGET.timeoutMs,
    maxOutputTokens: NOTES_BUDGET.maxOutputTokensPerCall,
  });
  if (output.usage === undefined) throw new Error('provider usage is missing');
  return { text: output.text, toolCalls: output.toolCalls, usage: output.usage, durationMs: output.durationMs };
}

export async function run(options: RunOptions): Promise<RunSummary> {
  if (options.confirmBudget !== NOTES_BUDGET_CONFIRMATION) {
    throw new Error(`feature-308-notes paid run needs --confirm-budget ${NOTES_BUDGET_CONFIRMATION}`);
  }
  const root = options.rawRoot ?? NOTES_RAW_ROOT;
  assertCredentials(NOTES_ALIASES);
  const prepared = await prepare(root);
  if (prepared.baselineHashMismatches.length > 0) {
    throw new Error(`feature-308-notes: Phase 0 baseline inputs changed (${prepared.baselineHashMismatches.length} cells); bump the revision and rebaseline`);
  }
  const cells = await prepareCells();
  const skipped: string[] = [];
  let external = 0;
  let completed = 0;
  let failure: unknown;

  const runLane = async (laneCells: readonly PreparedCell[]): Promise<void> => {
    for (const cell of laneCells) {
      if (failure !== undefined) return;
      const existing = await readJson<CellResult>(cellPath(root, cell));
      if (existing !== undefined) {
        if (existing.inputHash !== cell.inputHash) throw new Error(`feature-308-notes cached result for ${cell.key} has a different input hash`);
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
        estimatedInputTokens: cell.estimatedInputTokens, reservedOutputTokens: NOTES_BUDGET.maxOutputTokensPerCall,
      });
      external++;
      try {
        const response = await callCell(cell);
        const estimatedCostUsd = estimateCost(cell.alias, response.usage);
        const { scored, replay } = await scoreCell(cell, response);
        const result: CellResult = {
          schemaVersion: 1,
          revision: NOTES_REVISION,
          cell: { key: cell.key, kind: cell.kind, caseId: cell.caseId, arm: cell.arm, alias: cell.alias, repetition: cell.repetition },
          inputHash: cell.inputHash,
          response,
          estimatedCostUsd,
          mechanical: scored,
          ...(replay === undefined ? {} : { replay }),
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

  const lanes = NOTES_ALIASES.map((alias) => cells.filter((cell) => cell.alias === alias));
  const settled = await Promise.allSettled(lanes.map(runLane));
  const rejected = settled.find((item): item is PromiseRejectedResult => item.status === 'rejected');
  if (rejected !== undefined) throw rejected.reason;
  const { calls, committedTokens, committedUsd } = ledgerState(readLedger(root));
  return { externalCallsThisRun: external, completedCells: completed, plannedCells: cells.length, skippedAfterFailure: skipped, ledger: { calls, committedTokens, committedUsd } };
}

// ---------------------------------------------------------------- pack

/** The three arms of one read case, shown as X/Y/Z in an order fixed by the revision. */
export function armOrder(id: string): readonly NotesArm[] {
  return (['A', 'B', 'N'] as const)
    .map((arm) => ({ arm, order: sha256(`${NOTES_REVISION}:${id}:${arm}`) }))
    .sort((left, right) => left.order.localeCompare(right.order))
    .map((item) => item.arm);
}

const LABELS = ['X', 'Y', 'Z'] as const;

async function loadResult(alias: ModelAlias, caseId: string, arm: NotesArm, repetition: number): Promise<CellResult | undefined> {
  const key = cellKey(alias, caseId, arm, repetition);
  const root = arm !== 'N' && PHASE0_BASELINE_ALIASES.includes(alias) ? PHASE0_ROOT : NOTES_RAW_ROOT;
  return readJson<CellResult>(cellPath(root, { alias, key }));
}

export interface PackSummary {
  readonly readPacks: number;
  readonly probeEntries: number;
  readonly missing: readonly string[];
}

export async function pack(rawRoot: string = NOTES_RAW_ROOT): Promise<PackSummary> {
  const reviewDir = path.join(rawRoot, 'main-session-review');
  const missing: string[] = [];
  const evidence: unknown[] = [];
  const unblind: Record<string, Record<string, NotesArm>> = {};
  const mechanical: unknown[] = [];
  for (const alias of NOTES_ALIASES) {
    for (let repetition = 1; repetition <= NOTES_BUDGET.repetitions; repetition++) {
      for (const readCase of FEATURE_308_READ_CASES) {
        const packId = `${aliasDir(alias)}__${readCase.id}__rep${repetition}`;
        const results = await Promise.all((['A', 'B', 'N'] as const).map((arm) => loadResult(alias, readCase.id, arm, repetition)));
        const byArm = Object.fromEntries((['A', 'B', 'N'] as const).map((arm, index) => [arm, results[index]]));
        const absent = (['A', 'B', 'N'] as const).filter((arm) => byArm[arm] === undefined);
        if (absent.length > 0) { missing.push(...absent.map((arm) => `${packId}/${arm}`)); continue; }
        const order = armOrder(packId);
        unblind[packId] = Object.fromEntries(order.map((arm, index) => [LABELS[index]!, arm]));
        evidence.push({
          packId, alias, caseId: readCase.id, family: readCase.family, repetition,
          history: readCase.history, userMessage: readCase.userMessage,
          ...Object.fromEntries(order.map((arm, index) => [LABELS[index]!, {
            text: byArm[arm]!.response.text,
            toolCalls: byArm[arm]!.response.toolCalls,
            ...(byArm[arm]!.replay === undefined ? {} : { memoryReplay: byArm[arm]!.replay }),
          }])),
        });
        for (const arm of ['A', 'B', 'N'] as const) mechanical.push({ packId, arm, ...(await scoreCell(byArm[arm]!.cell, byArm[arm]!.response)).scored });
      }
    }
  }
  const probes: unknown[] = [];
  for (const alias of NOTES_ALIASES) {
    for (let repetition = 1; repetition <= NOTES_BUDGET.repetitions; repetition++) {
      for (const probe of FEATURE_308_PROBE_CASES) {
        const result = await loadResult(alias, probe.id, 'N', repetition);
        if (result === undefined) { missing.push(cellKey(alias, probe.id, 'N', repetition)); continue; }
        const scored = await scoreCell(result.cell, result.response);
        probes.push({
          key: result.cell.key, alias, caseId: probe.id, family: probe.family, repetition,
          history: probe.history, userMessage: probe.userMessage,
          output: { text: result.response.text, toolCalls: result.response.toolCalls },
          memoryReplay: scored.replay,
        });
        mechanical.push({ packId: result.cell.key, arm: 'N', ...scored.scored });
      }
    }
  }
  await writeJsonAtomic(path.join(reviewDir, 'evidence.json'), evidence);
  await writeJsonAtomic(path.join(reviewDir, 'probes.json'), probes);
  await writeJsonAtomic(path.join(reviewDir, 'unblind-map.json'), unblind);
  await writeJsonAtomic(path.join(reviewDir, 'mechanical.json'), mechanical);
  return { readPacks: evidence.length, probeEntries: probes.length, missing };
}

// ---------------------------------------------------------------- CLI

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  const rawRoot = flag('raw-root');
  const out = (value: unknown): void => { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); };
  if (mode === 'prepare') out(await prepare(rawRoot));
  else if (mode === 'run') out(await run({ confirmBudget: flag('confirm-budget') ?? '', ...(rawRoot === undefined ? {} : { rawRoot }) }));
  else if (mode === 'pack') out(await pack(rawRoot));
  else throw new Error('usage: runner.ts <prepare|run|pack> [--raw-root DIR] [--confirm-budget TOKEN]');
}

if (process.env.VITEST === undefined && import.meta.url === pathToFileURL(process.argv[1] ?? '').href
  && ['prepare', 'run', 'pack'].includes(process.argv[2] ?? '')) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

