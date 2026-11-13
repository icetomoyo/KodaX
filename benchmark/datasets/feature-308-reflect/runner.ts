/**
 * FEATURE_308 Phase 2b runner (the reflection job).
 *
 *   prepare  zero provider calls: builds every cell input from production code,
 *            writes the contract and the byte/token estimate.
 *   run      paid calls; one in flight per alias, aliases in parallel; only with the
 *            exact budget confirmation string; a pre-request ledger enforces every cap.
 *   pack     zero provider calls: re-scores raw results and writes the review pack.
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
import { FEATURE_308_REFLECT_CASES, type ReflectCase } from './cases.js';
import {
  REFLECT_ALIASES,
  REFLECT_BUDGET,
  REFLECT_BUDGET_CONFIRMATION,
  REFLECT_RAW_ROOT,
  REFLECT_REVISION,
  buildReflectExperimentContract,
} from './experiment-contract.js';
import { buildReflectCellInput, replayReflectCalls, type ReflectCellInput } from './inputs.js';
import { reflectCalls, scoreReflectCell } from './oracles.js';

export interface Cell {
  readonly key: string;
  readonly caseId: string;
  readonly alias: ModelAlias;
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
  readonly mechanical: Scored;
  readonly replay: readonly string[];
}

const BYTES_PER_TOKEN = 3;
const EXPECTED_OUTPUT_TOKENS = 4_096;
const TOKEN_BUDGET_SLACK = 1.25;
const TOKEN_BUDGET_ROUNDING = 50_000;

const CASE_BY_ID = new Map<string, ReflectCase>(FEATURE_308_REFLECT_CASES.map((item) => [item.id, item]));
const aliasDir = (alias: ModelAlias): string => alias.replace('/', '_');

export function cellKey(alias: ModelAlias, caseId: string, repetition: number): string {
  return `${aliasDir(alias)}__${caseId}__rep${repetition}`;
}

export function plannedCells(): readonly Cell[] {
  const cells: Cell[] = [];
  for (let repetition = 1; repetition <= REFLECT_BUDGET.repetitions; repetition++) {
    for (const alias of REFLECT_ALIASES) {
      for (const item of FEATURE_308_REFLECT_CASES) {
        cells.push({ key: cellKey(alias, item.id, repetition), caseId: item.id, alias, repetition });
      }
    }
  }
  return cells;
}

function estimateInputTokens(input: ReflectCellInput): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(input), 'utf8') / BYTES_PER_TOKEN);
}

/** Inputs do not depend on alias or repetition, so each case is built once. */
export async function prepareCells(): Promise<readonly PreparedCell[]> {
  const built = new Map<string, Pick<PreparedCell, 'input' | 'inputHash' | 'estimatedInputTokens'>>();
  for (const item of FEATURE_308_REFLECT_CASES) {
    const input = await buildReflectCellInput(item);
    built.set(item.id, { input, inputHash: sha256(JSON.stringify(input)), estimatedInputTokens: estimateInputTokens(input) });
  }
  return plannedCells().map((cell) => ({ ...cell, ...built.get(cell.caseId)! }));
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
  const reserved = REFLECT_BUDGET.maxOutputTokensPerCall;
  if (state.requestedCells.has(cell.key)) throw new Error(`feature-308-reflect per-cell call cap exceeded for ${cell.key}`);
  if (state.calls + 1 > REFLECT_BUDGET.maxProviderCalls) throw new Error('feature-308-reflect provider call cap exceeded');
  if (state.committedTokens + cell.estimatedInputTokens + reserved > REFLECT_BUDGET.maxTotalTokens) {
    throw new Error('feature-308-reflect total token cap exceeded');
  }
  const usd = state.committedUsd + estimateCost(cell.alias, { inputTokens: cell.estimatedInputTokens, outputTokens: reserved });
  if (usd > REFLECT_BUDGET.maxExternalSpendUsd) throw new Error('feature-308-reflect spend cap exceeded');
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
}

export async function prepare(root: string = REFLECT_RAW_ROOT): Promise<PrepareSummary> {
  const cells = await prepareCells();
  const derivation = deriveTokenBudget(cells);
  const worstCaseUsd = cells.reduce((sum, cell) => sum + estimateCost(cell.alias, {
    inputTokens: cell.estimatedInputTokens, outputTokens: REFLECT_BUDGET.maxOutputTokensPerCall,
  }), 0);
  await writeJsonAtomic(path.join(root, 'contract.json'), buildReflectExperimentContract());
  await writeJsonAtomic(path.join(root, 'prepare', 'cells.json'), cells.map((cell) => ({
    key: cell.key,
    inputHash: cell.inputHash,
    estimatedInputTokens: cell.estimatedInputTokens,
    systemChars: cell.input.systemPrompt.length,
    userChars: cell.input.userMessage.length,
    toolNames: cell.input.tools.map((tool) => tool.name),
  })));
  await writeJsonAtomic(path.join(root, 'prepare', 'estimate.json'), {
    bytesPerToken: BYTES_PER_TOKEN,
    expectedOutputTokensPerCall: EXPECTED_OUTPUT_TOKENS,
    slack: TOKEN_BUDGET_SLACK,
    ...derivation,
    frozenMaxTotalTokens: REFLECT_BUDGET.maxTotalTokens,
    estimatedCostUsdAtWorstCaseOutput: worstCaseUsd,
  });
  return {
    cells: cells.length,
    derivation,
    frozenMaxTotalTokens: REFLECT_BUDGET.maxTotalTokens,
    frozenCoversDerived: REFLECT_BUDGET.maxTotalTokens >= derivation.derivedMaxTotalTokens,
    estimatedCostUsdAtWorstCaseOutput: worstCaseUsd,
  };
}

// ---------------------------------------------------------------- scoring

export async function scoreCell(cell: Cell, output: ModelOutput): Promise<{ scored: Scored; replay: readonly string[] }> {
  const item = CASE_BY_ID.get(cell.caseId)!;
  const replay = await replayReflectCalls(item, cell.key, reflectCalls(output));
  return {
    scored: scoreReflectCell(item, output, replay),
    replay: replay.calls.map((call) => `${call.input?.operation ?? '?'} ${call.input?.id ?? '?'}: ${call.result.message}`),
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
  if (missing.length > 0) throw new Error(`feature-308-reflect missing API key env for: ${missing.join(', ')}`);
}

async function callCell(cell: PreparedCell): Promise<CellResponse> {
  const output = await runOneShot(cell.alias, {
    systemPrompt: cell.input.systemPrompt,
    userMessage: cell.input.userMessage,
    tools: cell.input.tools,
    timeoutMs: REFLECT_BUDGET.timeoutMs,
    maxOutputTokens: REFLECT_BUDGET.maxOutputTokensPerCall,
  });
  if (output.usage === undefined) throw new Error('provider usage is missing');
  return { text: output.text, toolCalls: output.toolCalls, usage: output.usage, durationMs: output.durationMs };
}

export async function run(options: RunOptions): Promise<RunSummary> {
  if (options.confirmBudget !== REFLECT_BUDGET_CONFIRMATION) {
    throw new Error(`feature-308-reflect paid run needs --confirm-budget ${REFLECT_BUDGET_CONFIRMATION}`);
  }
  const root = options.rawRoot ?? REFLECT_RAW_ROOT;
  assertCredentials(REFLECT_ALIASES);
  await prepare(root);
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
        if (existing.inputHash !== cell.inputHash) throw new Error(`feature-308-reflect cached result for ${cell.key} has a different input hash`);
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
        estimatedInputTokens: cell.estimatedInputTokens, reservedOutputTokens: REFLECT_BUDGET.maxOutputTokensPerCall,
      });
      external++;
      try {
        const response = await callCell(cell);
        const estimatedCostUsd = estimateCost(cell.alias, response.usage);
        const { scored, replay } = await scoreCell(cell, response);
        const result: CellResult = {
          schemaVersion: 1,
          revision: REFLECT_REVISION,
          cell: { key: cell.key, caseId: cell.caseId, alias: cell.alias, repetition: cell.repetition },
          inputHash: cell.inputHash,
          response,
          estimatedCostUsd,
          mechanical: scored,
          replay,
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

  const lanes = REFLECT_ALIASES.map((alias) => cells.filter((cell) => cell.alias === alias));
  const settled = await Promise.allSettled(lanes.map(runLane));
  const rejected = settled.find((item): item is PromiseRejectedResult => item.status === 'rejected');
  if (rejected !== undefined) throw rejected.reason;
  const { calls, committedTokens, committedUsd } = ledgerState(readLedger(root));
  return { externalCallsThisRun: external, completedCells: completed, plannedCells: cells.length, skippedAfterFailure: skipped, ledger: { calls, committedTokens, committedUsd } };
}

// ---------------------------------------------------------------- pack

export interface PackSummary {
  readonly entries: number;
  readonly missing: readonly string[];
  readonly passRateByCase: Readonly<Record<string, string>>;
}

export async function pack(rawRoot: string = REFLECT_RAW_ROOT): Promise<PackSummary> {
  const entries: unknown[] = [];
  const missing: string[] = [];
  const tally = new Map<string, { pass: number; total: number }>();
  for (const cell of plannedCells()) {
    const result = await readJson<CellResult>(cellPath(rawRoot, cell));
    if (result === undefined) { missing.push(cell.key); continue; }
    const item = CASE_BY_ID.get(cell.caseId)!;
    const { scored, replay } = await scoreCell(result.cell, result.response);
    const counts = tally.get(item.id) ?? { pass: 0, total: 0 };
    tally.set(item.id, { pass: counts.pass + (scored.verdict === 'pass' ? 1 : 0), total: counts.total + 1 });
    entries.push({
      key: cell.key, alias: cell.alias, caseId: item.id, family: item.family, repetition: cell.repetition,
      seeds: item.seeds.filter((seed) => !['docs-deploy', 'logging'].includes(seed.id)),
      transcript: item.messages,
      output: { text: result.response.text, toolCalls: result.response.toolCalls },
      replay, mechanical: scored,
    });
  }
  await writeJsonAtomic(path.join(rawRoot, 'main-session-review', 'pack.json'), entries);
  return {
    entries: entries.length,
    missing,
    passRateByCase: Object.fromEntries([...tally].map(([id, { pass, total }]) => [id, `${pass}/${total}`])),
  };
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
