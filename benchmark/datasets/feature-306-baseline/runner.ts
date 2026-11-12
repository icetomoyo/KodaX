/**
 * FEATURE_306 Phase 0 runner.
 *
 *   prepare  zero provider calls: builds every cell input from production code,
 *            writes the contract, byte/token estimate, Layer-1 hint observations,
 *            a blinded evidence skeleton and the unblind map.
 *   run      paid calls, sequential (one in flight), only with the exact budget
 *            confirmation string; a pre-request ledger enforces every frozen cap.
 *   pack     zero provider calls: scores raw results, builds the blinded Arm X/Arm Y
 *            evidence pack for the main-session review, and replays the write-side
 *            reviewer output through the production normalizer offline.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { normalizeUnifiedLearningReview } from '@kodax-ai/agent';
import { calculateCost, getCostRate, type CostRate, type KodaXMessage, type KodaXTokenUsage, type KodaXToolDefinition } from '@kodax-ai/llm';

import { MODEL_ALIASES, type ModelAlias } from '../../harness/aliases.js';
import { runOneShot } from '../../harness/harness.js';
import {
  FEATURE_306_READ_CASES,
  FEATURE_306_WRITE_CASES,
  type ReadCase,
  type WriteCase,
} from './cases.js';
import {
  FEATURE_306_ALIASES,
  FEATURE_306_BUDGET,
  FEATURE_306_BUDGET_CONFIRMATION,
  FEATURE_306_RAW_ROOT,
  FEATURE_306_REVISION,
  buildFeature306ExperimentContract,
} from './experiment-contract.js';
import {
  REVIEW_TOOL_NAME,
  buildReadCellInput,
  buildReviewerInput,
  buildSeededPack,
  buildWriteCellInput,
  observeHint,
  seedStore,
  type Arm,
} from './inputs.js';
import { scoreReadCell, scoreWriteCell, type ModelOutput, type Scored } from './oracles.js';

export type CellArm = Arm | 'reviewer';

export interface Cell {
  readonly key: string;
  readonly side: 'read' | 'write';
  readonly caseId: string;
  readonly arm: CellArm;
  readonly alias: ModelAlias;
  readonly repetition: number;
}

interface CellInput {
  readonly systemPrompt: string;
  readonly priorMessages: readonly KodaXMessage[];
  readonly userMessage: string;
  readonly tools: readonly KodaXToolDefinition[];
  readonly forcedToolName?: string;
}

export interface PreparedCell extends Cell {
  readonly input: CellInput;
  readonly inputHash: string;
  readonly estimatedInputTokens: number;
}

export interface CellResponse extends ModelOutput {
  readonly usage: KodaXTokenUsage;
  readonly durationMs: number;
}

interface CellResult {
  readonly schemaVersion: 1;
  readonly revision: string;
  readonly cell: Cell;
  readonly inputHash: string;
  readonly response: CellResponse;
  readonly runsRaw: readonly ModelOutput[];
  readonly estimatedCostUsd: number;
  readonly mechanical: Scored;
}

/** Heuristic for the pre-call estimate only; the ledger records provider-reported usage. */
const BYTES_PER_TOKEN = 3;
/** Reasoning plus the answer; a planning figure, not a cap (the cap is maxOutputTokensPerCall). */
const EXPECTED_OUTPUT_TOKENS = 4_096;
const TOKEN_BUDGET_SLACK = 1.25;
const TOKEN_BUDGET_ROUNDING = 50_000;

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function aliasDir(alias: ModelAlias): string {
  return alias.replace('/', '_');
}

export function cellKey(alias: ModelAlias, caseId: string, arm: CellArm, repetition: number): string {
  return `${aliasDir(alias)}__${caseId}__${arm}__rep${repetition}`;
}

export function plannedCells(): readonly Cell[] {
  const cells: Cell[] = [];
  for (let repetition = 1; repetition <= FEATURE_306_BUDGET.repetitions; repetition++) {
    for (const alias of FEATURE_306_ALIASES) {
      for (const readCase of FEATURE_306_READ_CASES) {
        for (const arm of ['A', 'B'] as const) {
          cells.push({ key: cellKey(alias, readCase.id, arm, repetition), side: 'read', caseId: readCase.id, arm, alias, repetition });
        }
      }
      for (const writeCase of FEATURE_306_WRITE_CASES) {
        cells.push({ key: cellKey(alias, writeCase.id, 'reviewer', repetition), side: 'write', caseId: writeCase.id, arm: 'reviewer', alias, repetition });
      }
    }
  }
  return cells;
}

function estimateInputTokens(input: CellInput): number {
  const bytes = Buffer.byteLength(JSON.stringify({
    system: input.systemPrompt,
    messages: input.priorMessages,
    user: input.userMessage,
    tools: input.tools,
  }), 'utf8');
  return Math.ceil(bytes / BYTES_PER_TOKEN);
}

async function buildInput(cell: Cell): Promise<CellInput> {
  if (cell.side === 'read') {
    const readCase = FEATURE_306_READ_CASES.find((item) => item.id === cell.caseId)!;
    return buildReadCellInput(readCase, cell.arm as Arm);
  }
  const writeCase = FEATURE_306_WRITE_CASES.find((item) => item.id === cell.caseId)!;
  const built = await buildWriteCellInput(writeCase);
  return {
    systemPrompt: built.systemPrompt,
    priorMessages: [],
    userMessage: built.userMessage,
    tools: built.tools,
    forcedToolName: built.forcedToolName,
  };
}

/** Inputs do not depend on alias or repetition, so each (case, arm) is built once. */
export async function prepareCells(): Promise<readonly PreparedCell[]> {
  const built = new Map<string, { input: CellInput; inputHash: string; estimatedInputTokens: number }>();
  const prepared: PreparedCell[] = [];
  for (const cell of plannedCells()) {
    const shape = `${cell.caseId}/${cell.arm}`;
    if (!built.has(shape)) {
      const input = await buildInput(cell);
      built.set(shape, { input, inputHash: sha256(JSON.stringify(input)), estimatedInputTokens: estimateInputTokens(input) });
    }
    prepared.push({ ...cell, ...built.get(shape)! });
  }
  return prepared;
}

function pricing(alias: ModelAlias): CostRate {
  const target = MODEL_ALIASES[alias];
  const direct = getCostRate(target.provider, target.model);
  if (direct !== undefined) return direct;
  const routed = alias === 'zhipu/glm52' ? getCostRate('zhipu-coding', 'glm-5.2') : undefined;
  if (routed === undefined) throw new Error(`feature-306 pricing unavailable for ${alias}`);
  return routed;
}

interface UsageForCost {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedReadTokens?: number;
  readonly cachedWriteTokens?: number;
}

export function estimateCost(alias: ModelAlias, usage: UsageForCost): number {
  return calculateCost(
    pricing(alias),
    usage.inputTokens,
    usage.outputTokens,
    usage.cachedReadTokens ?? 0,
    usage.cachedWriteTokens ?? 0,
  );
}

export interface TokenBudgetDerivation {
  readonly estimatedInputTokens: number;
  readonly expectedOutputTokens: number;
  readonly derivedMaxTotalTokens: number;
}

export function deriveTokenBudget(cells: readonly PreparedCell[]): TokenBudgetDerivation {
  const estimatedInputTokens = cells.reduce((sum, cell) => sum + cell.estimatedInputTokens, 0);
  const expectedOutputTokens = cells.length * EXPECTED_OUTPUT_TOKENS;
  const raw = (estimatedInputTokens + expectedOutputTokens) * TOKEN_BUDGET_SLACK;
  return {
    estimatedInputTokens,
    expectedOutputTokens,
    derivedMaxTotalTokens: Math.ceil(raw / TOKEN_BUDGET_ROUNDING) * TOKEN_BUDGET_ROUNDING,
  };
}

// ---------------------------------------------------------------- ledger

export type LedgerEntry =
  | { readonly event: 'requested'; readonly cellKey: string; readonly alias: ModelAlias; readonly estimatedInputTokens: number; readonly reservedOutputTokens: number }
  | { readonly event: 'completed'; readonly cellKey: string; readonly alias: ModelAlias; readonly usage: KodaXTokenUsage; readonly estimatedCostUsd: number }
  | { readonly event: 'failed'; readonly cellKey: string; readonly alias: ModelAlias; readonly error: string };

export interface LedgerState {
  readonly calls: number;
  /** Provider-reported tokens for completed calls, worst case (estimate + reserved output) otherwise. */
  readonly committedTokens: number;
  readonly committedUsd: number;
  readonly requestedCells: ReadonlySet<string>;
}

export function ledgerState(entries: readonly LedgerEntry[]): LedgerState {
  const completed = new Map<string, Extract<LedgerEntry, { event: 'completed' }>>();
  for (const entry of entries) if (entry.event === 'completed') completed.set(entry.cellKey, entry);
  let committedTokens = 0;
  let committedUsd = 0;
  const requestedCells = new Set<string>();
  for (const entry of entries) {
    if (entry.event !== 'requested') continue;
    requestedCells.add(entry.cellKey);
    const done = completed.get(entry.cellKey);
    const usage = done?.usage ?? { inputTokens: entry.estimatedInputTokens, outputTokens: entry.reservedOutputTokens };
    committedTokens += usage.inputTokens + usage.outputTokens;
    committedUsd += done?.estimatedCostUsd ?? estimateCost(entry.alias, usage);
  }
  return { calls: requestedCells.size, committedTokens, committedUsd, requestedCells };
}

/** Throws unless this call fits every frozen cap even if it spends its full output reservation. */
export function assertLedgerAllows(state: LedgerState, cell: PreparedCell): void {
  const reserved = FEATURE_306_BUDGET.maxOutputTokensPerCall;
  if (state.requestedCells.has(cell.key)) throw new Error(`feature-306 per-cell call cap exceeded for ${cell.key}`);
  if (state.calls + 1 > FEATURE_306_BUDGET.maxProviderCalls) throw new Error('feature-306 provider call cap exceeded');
  const tokens = state.committedTokens + cell.estimatedInputTokens + reserved;
  if (tokens > FEATURE_306_BUDGET.maxTotalTokens) throw new Error('feature-306 total token cap exceeded');
  const usd = state.committedUsd + estimateCost(cell.alias, { inputTokens: cell.estimatedInputTokens, outputTokens: reserved });
  if (usd > FEATURE_306_BUDGET.maxExternalSpendUsd) throw new Error('feature-306 spend cap exceeded');
}

function ledgerPath(root: string): string {
  return path.join(root, 'ledger.jsonl');
}

export function readLedger(root: string): readonly LedgerEntry[] {
  const file = ledgerPath(root);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line) as LedgerEntry);
}

/** Synchronous append so the request is on disk before the provider is contacted. */
function appendLedger(root: string, entry: LedgerEntry): void {
  appendFileSync(ledgerPath(root), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, 'utf8');
}

// ---------------------------------------------------------------- blinding

export function packId(alias: ModelAlias, caseId: string, repetition: number): string {
  return `${aliasDir(alias)}__${caseId}__rep${repetition}`;
}

/** Which arm is shown as Arm X; fixed per pack from the revision so prepare and pack agree. */
export function xArmFor(id: string): Arm {
  return Number.parseInt(sha256(`${FEATURE_306_REVISION}:${id}`).slice(0, 2), 16) % 2 === 0 ? 'A' : 'B';
}

function readPairs(): readonly { readonly packId: string; readonly alias: ModelAlias; readonly readCase: ReadCase; readonly repetition: number }[] {
  return plannedCells().filter((cell) => cell.side === 'read' && cell.arm === 'A').map((cell) => ({
    packId: packId(cell.alias, cell.caseId, cell.repetition),
    alias: cell.alias,
    readCase: FEATURE_306_READ_CASES.find((item) => item.id === cell.caseId)!,
    repetition: cell.repetition,
  }));
}

function unblindMap(): Readonly<Record<string, { readonly X: Arm; readonly Y: Arm }>> {
  const entries = readPairs().map((pair): [string, { X: Arm; Y: Arm }] => {
    const x = xArmFor(pair.packId);
    return [pair.packId, { X: x, Y: x === 'A' ? 'B' : 'A' }];
  });
  return Object.fromEntries(entries);
}

// ---------------------------------------------------------------- files

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, filePath);
}

function cellPath(root: string, cell: Cell): string {
  return path.join(root, 'cells', aliasDir(cell.alias), `${cell.key}.json`);
}

async function readJson<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

// ---------------------------------------------------------------- prepare

export interface PrepareSummary {
  readonly cells: number;
  readonly derivation: TokenBudgetDerivation;
  readonly frozenMaxTotalTokens: number;
  readonly frozenCoversDerived: boolean;
  readonly estimatedCostUsdAtWorstCaseOutput: number;
  readonly layer1: readonly { readonly caseId: string; readonly surfaced: boolean; readonly decisiveDetailInHook: boolean }[];
}

export async function prepare(root: string = FEATURE_306_RAW_ROOT): Promise<PrepareSummary> {
  const cells = await prepareCells();
  const derivation = deriveTokenBudget(cells);
  const worstCaseUsd = cells.reduce((sum, cell) => sum + estimateCost(cell.alias, {
    inputTokens: cell.estimatedInputTokens,
    outputTokens: FEATURE_306_BUDGET.maxOutputTokensPerCall,
  }), 0);
  const hints = await Promise.all(FEATURE_306_READ_CASES.map(async (readCase) => {
    const { pack } = await buildSeededPack(readCase);
    return { caseId: readCase.id, ...observeHint(readCase, pack), refs: pack.promptHints.map((hint) => hint.ref.id) };
  }));
  await writeJsonAtomic(path.join(root, 'contract.json'), buildFeature306ExperimentContract());
  await writeJsonAtomic(path.join(root, 'prepare', 'cells.json'), cells.map((cell) => ({
    key: cell.key,
    inputHash: cell.inputHash,
    estimatedInputTokens: cell.estimatedInputTokens,
    systemChars: cell.input.systemPrompt.length,
    toolBytes: Buffer.byteLength(JSON.stringify(cell.input.tools), 'utf8'),
    priorMessages: cell.input.priorMessages.length,
  })));
  await writeJsonAtomic(path.join(root, 'prepare', 'estimate.json'), {
    bytesPerToken: BYTES_PER_TOKEN,
    expectedOutputTokensPerCall: EXPECTED_OUTPUT_TOKENS,
    slack: TOKEN_BUDGET_SLACK,
    ...derivation,
    frozenMaxTotalTokens: FEATURE_306_BUDGET.maxTotalTokens,
    estimatedCostUsdAtWorstCaseOutput: worstCaseUsd,
  });
  await writeJsonAtomic(path.join(root, 'prepare', 'layer1-hints.json'), hints);
  await writeJsonAtomic(path.join(root, 'main-session-review', 'evidence-skeleton.json'), readPairs().map((pair) => ({
    packId: pair.packId,
    alias: pair.alias,
    caseId: pair.readCase.id,
    repetition: pair.repetition,
    X: null,
    Y: null,
  })));
  await writeJsonAtomic(path.join(root, 'main-session-review', 'unblind-map.json'), unblindMap());
  return {
    cells: cells.length,
    derivation,
    frozenMaxTotalTokens: FEATURE_306_BUDGET.maxTotalTokens,
    frozenCoversDerived: FEATURE_306_BUDGET.maxTotalTokens >= derivation.derivedMaxTotalTokens,
    estimatedCostUsdAtWorstCaseOutput: worstCaseUsd,
    layer1: hints.map((hint) => ({ caseId: hint.caseId, surfaced: hint.surfaced, decisiveDetailInHook: hint.decisiveDetailInHook })),
  };
}

// ---------------------------------------------------------------- scoring

export function scoreCell(cell: Cell, output: ModelOutput): Scored {
  if (cell.side === 'read') {
    return scoreReadCell(FEATURE_306_READ_CASES.find((item) => item.id === cell.caseId)!.oracle, output);
  }
  const raw = output.toolCalls.find((call) => call.name === REVIEW_TOOL_NAME)?.input;
  return scoreWriteCell(FEATURE_306_WRITE_CASES.find((item) => item.id === cell.caseId)!.oracle, raw);
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
  if (missing.length > 0) throw new Error(`feature-306 missing API key env for: ${missing.join(', ')}`);
}

async function callCell(cell: PreparedCell): Promise<CellResponse> {
  const output = await runOneShot(cell.alias, {
    systemPrompt: cell.input.systemPrompt,
    priorMessages: cell.input.priorMessages,
    userMessage: cell.input.userMessage,
    tools: cell.input.tools,
    ...(cell.input.forcedToolName === undefined
      ? {}
      : { forcedToolName: cell.input.forcedToolName, reasoning: { enabled: false } }),
    timeoutMs: FEATURE_306_BUDGET.timeoutMs,
    maxOutputTokens: FEATURE_306_BUDGET.maxOutputTokensPerCall,
  });
  if (output.usage === undefined) throw new Error('provider usage is missing');
  return { text: output.text, toolCalls: output.toolCalls, usage: output.usage, durationMs: output.durationMs };
}

export async function run(options: RunOptions): Promise<RunSummary> {
  if (options.confirmBudget !== FEATURE_306_BUDGET_CONFIRMATION) {
    throw new Error(`feature-306 paid run needs --confirm-budget ${FEATURE_306_BUDGET_CONFIRMATION}`);
  }
  const root = options.rawRoot ?? FEATURE_306_RAW_ROOT;
  assertCredentials(FEATURE_306_ALIASES);
  await prepare(root);
  const cells = await prepareCells();
  const skipped: string[] = [];
  let external = 0;
  let completed = 0;
  for (const cell of cells) {
    const existing = await readJson<CellResult>(cellPath(root, cell));
    if (existing !== undefined) {
      if (existing.inputHash !== cell.inputHash) throw new Error(`feature-306 cached result for ${cell.key} has a different input hash`);
      completed++;
      continue;
    }
    if (ledgerState(readLedger(root)).requestedCells.has(cell.key)) {
      skipped.push(cell.key);
      continue;
    }
    assertLedgerAllows(ledgerState(readLedger(root)), cell);
    appendLedger(root, {
      event: 'requested',
      cellKey: cell.key,
      alias: cell.alias,
      estimatedInputTokens: cell.estimatedInputTokens,
      reservedOutputTokens: FEATURE_306_BUDGET.maxOutputTokensPerCall,
    });
    external++;
    try {
      const response = await callCell(cell);
      const estimatedCostUsd = estimateCost(cell.alias, response.usage);
      const result: CellResult = {
        schemaVersion: 1,
        revision: FEATURE_306_REVISION,
        cell: { key: cell.key, side: cell.side, caseId: cell.caseId, arm: cell.arm, alias: cell.alias, repetition: cell.repetition },
        inputHash: cell.inputHash,
        response,
        runsRaw: [{ text: response.text, toolCalls: response.toolCalls }],
        estimatedCostUsd,
        mechanical: scoreCell(cell, response),
      };
      await writeJsonAtomic(cellPath(root, cell), result);
      appendLedger(root, { event: 'completed', cellKey: cell.key, alias: cell.alias, usage: response.usage, estimatedCostUsd });
      completed++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendLedger(root, { event: 'failed', cellKey: cell.key, alias: cell.alias, error: message });
      // Fail fast: the lead inspects before any further spend; a failed cell is never retried.
      throw error;
    }
  }
  const { calls, committedTokens, committedUsd } = ledgerState(readLedger(root));
  return {
    externalCallsThisRun: external,
    completedCells: completed,
    plannedCells: cells.length,
    skippedAfterFailure: skipped,
    ledger: { calls, committedTokens, committedUsd },
  };
}

// ---------------------------------------------------------------- pack

interface WriteProcessing {
  readonly status: 'normalized' | 'rejected' | 'no-review-call';
  readonly error?: string;
  readonly actions: readonly { readonly action: string; readonly claimKey?: string; readonly proposedBody?: string; readonly risk: string }[];
  readonly capabilityDisposition?: string;
  readonly decisions: readonly { readonly kind: string; readonly reason: string }[];
  readonly proposalCount: number;
  readonly autoAppliedCount: number;
  readonly warnings: readonly string[];
}

const EMPTY_PROCESSING: Omit<WriteProcessing, 'status'> = {
  actions: [], decisions: [], proposalCount: 0, autoAppliedCount: 0, warnings: [],
};

/** Replays the reviewer's tool input through the production normalizer and governed apply, in a throwaway store. */
export async function processWriteCell(writeCase: WriteCase, raw: unknown | undefined, tag = 'post'): Promise<WriteProcessing> {
  if (raw === undefined) return { status: 'no-review-call', ...EMPTY_PROCESSING };
  const store = await seedStore(`write-${writeCase.id}-${tag}`, []);
  try {
    const input = await buildReviewerInput(writeCase.digest, store.controller);
    const normalized = normalizeUnifiedLearningReview(input, raw);
    const applied = await store.controller.applyReviewedEpisode!(normalized.memoryPlan, writeCase.digest);
    return {
      status: 'normalized',
      actions: normalized.memoryPlan.actions.map((action) => ({
        action: action.action,
        ...(action.claimKey === undefined ? {} : { claimKey: action.claimKey }),
        ...(action.proposedBody === undefined ? {} : { proposedBody: action.proposedBody }),
        risk: action.risk,
      })),
      ...(normalized.capabilityDecision === undefined ? {} : { capabilityDisposition: normalized.capabilityDecision.disposition }),
      decisions: applied.decisions.map((decision) => ({ kind: decision.kind, reason: decision.reason })),
      proposalCount: applied.proposalIds.length,
      autoAppliedCount: applied.appliedProposalIds.length,
      warnings: applied.warnings,
    };
  } catch (error) {
    return { status: 'rejected', error: error instanceof Error ? error.message : String(error), ...EMPTY_PROCESSING };
  }
}

export interface PackSummary {
  readonly readPacks: number;
  readonly writeEntries: number;
  readonly missingCells: readonly string[];
}

export async function pack(rawRoot: string = FEATURE_306_RAW_ROOT): Promise<PackSummary> {
  const reviewDir = path.join(rawRoot, 'main-session-review');
  const missing: string[] = [];
  const results = new Map<string, CellResult>();
  for (const cell of plannedCells()) {
    const result = await readJson<CellResult>(cellPath(rawRoot, cell));
    if (result === undefined) missing.push(cell.key);
    else results.set(cell.key, result);
  }
  const evidence = readPairs().flatMap((pair) => {
    const a = results.get(cellKey(pair.alias, pair.readCase.id, 'A', pair.repetition));
    const b = results.get(cellKey(pair.alias, pair.readCase.id, 'B', pair.repetition));
    if (a === undefined || b === undefined) return [];
    const byArm = { A: a, B: b };
    const x = xArmFor(pair.packId);
    const show = (arm: Arm): ModelOutput => ({ text: byArm[arm].response.text, toolCalls: byArm[arm].response.toolCalls });
    return [{
      packId: pair.packId,
      alias: pair.alias,
      caseId: pair.readCase.id,
      family: pair.readCase.family,
      repetition: pair.repetition,
      history: pair.readCase.history,
      userMessage: pair.readCase.userMessage,
      X: show(x),
      Y: show(x === 'A' ? 'B' : 'A'),
    }];
  });
  const mechanical = [...results.values()].map((result) => ({
    key: result.cell.key,
    arm: result.cell.arm,
    ...scoreCell(result.cell, result.response),
  }));
  const writeEntries = [];
  for (const cell of plannedCells().filter((item) => item.side === 'write')) {
    const result = results.get(cell.key);
    if (result === undefined) continue;
    const writeCase = FEATURE_306_WRITE_CASES.find((item) => item.id === cell.caseId)!;
    const raw = result.response.toolCalls.find((call) => call.name === REVIEW_TOOL_NAME)?.input;
    writeEntries.push({
      key: cell.key,
      alias: cell.alias,
      caseId: cell.caseId,
      family: writeCase.family,
      reviewerOutput: { text: result.response.text, toolCalls: result.response.toolCalls },
      usage: result.response.usage,
      processing: await processWriteCell(writeCase, raw, cell.key),
    });
  }
  await writeJsonAtomic(path.join(reviewDir, 'evidence.json'), evidence);
  await writeJsonAtomic(path.join(reviewDir, 'unblind-map.json'), unblindMap());
  await writeJsonAtomic(path.join(reviewDir, 'mechanical.json'), mechanical);
  await writeJsonAtomic(path.join(reviewDir, 'write-side.json'), writeEntries);
  return { readPacks: evidence.length, writeEntries: writeEntries.length, missingCells: missing };
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

if (process.env.VITEST === undefined && import.meta.url === pathToFileURL(process.argv[1] ?? '').href && ['prepare', 'run', 'pack'].includes(process.argv[2] ?? '')) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
