/**
 * FEATURE_309 episode-reviewer A/B runner.
 *
 *   prepare  zero provider calls: builds both arms' requests, checks the pinned
 *            hashes, writes the contract and the estimate.
 *   run      paid calls (--stage pilot|full); one in flight per alias, aliases in
 *            parallel; only with the exact budget confirmation; a pre-request
 *            ledger enforces every cap across both stages.
 *   pack     zero provider calls: blinded pack of Memory actions (X/Y per case,
 *            alias and repetition) plus a separate unblind map.
 *   tally    zero provider calls: mechanical scores and arm A's Skill decisions,
 *            read after the blind review is written.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  normalizeUnifiedLearningReview,
  sanitizeUnifiedLearningReviewInput,
  type KodaXMemoryOutcomeDigest,
  type LearningReviewEvidencePacket,
  type UnifiedLearningReviewModelInput,
} from '@kodax-ai/agent';
import type { KodaXTokenUsage, KodaXToolDefinition } from '@kodax-ai/llm';

import { LEARNING_REVIEW_SYSTEM_PROMPT, LEARNING_REVIEW_TOOL } from '../../../packages/coding/src/learning-reviewer.js';
import { MODEL_ALIASES, type ModelAlias } from '../../harness/aliases.js';
import { runOneShot } from '../../harness/harness.js';
import { REVIEW_TOOL_NAME, seedStore, type SeededStore } from '../feature-308-baseline/inputs.js';
import { scoreWriteCell, type ModelOutput, type Scored } from '../feature-308-baseline/oracles.js';
import { estimateCost, ledgerState, readLedger, sha256, type LedgerEntry, type LedgerState } from '../feature-308-baseline/runner.js';
import { FEATURE_309_REVIEWER_CASES, type ReviewerCase } from './cases.js';
import {
  PILOT_CASE_IDS,
  REVIEWER_ALIASES,
  REVIEWER_ARM_A_SHA256,
  REVIEWER_BUDGET,
  REVIEWER_BUDGET_CONFIRMATION,
  REVIEWER_RAW_ROOT,
  REVIEWER_REVISION,
  buildReviewerExperimentContract,
} from './experiment-contract.js';

export type Arm = 'A' | 'B';
export type Stage = 'pilot' | 'full';
export const ARMS: readonly Arm[] = ['A', 'B'];

export interface Cell {
  readonly key: string;
  readonly stage: Stage;
  readonly caseId: string;
  readonly alias: ModelAlias;
  readonly arm: Arm;
  readonly repetition: number;
}

export interface ReviewerRequest {
  readonly systemPrompt: string;
  readonly userMessage: string;
  readonly tools: readonly KodaXToolDefinition[];
}

export interface PreparedCell extends Cell {
  readonly input: ReviewerRequest;
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
const EXPECTED_OUTPUT_TOKENS = 1_200;
const TOKEN_BUDGET_SLACK = 1.25;
const TOKEN_BUDGET_ROUNDING = 50_000;
const PRODUCTION_OUTPUT_CAP = 1_200;

const ARM_A_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'arm-a.json');
const CASE_BY_ID = new Map<string, ReviewerCase>(FEATURE_309_REVIEWER_CASES.map((item) => [item.id, item]));
const aliasDir = (alias: ModelAlias): string => alias.replace('/', '_');

// ---------------------------------------------------------------- inputs

interface ArmAFile {
  readonly systemPrompt: string;
  readonly tool: KodaXToolDefinition;
}

export function armAHash(): string {
  return sha256(readFileSync(ARM_A_PATH, 'utf8').replace(/\r\n/g, '\n'));
}

function readArmA(): ArmAFile {
  return JSON.parse(readFileSync(ARM_A_PATH, 'utf8')) as ArmAFile;
}

function isTrustedTerminalEvidence(evidence: NonNullable<KodaXMemoryOutcomeDigest['evidence']>[number]): boolean {
  return (evidence.grade === 'verified' || evidence.grade === 'authoritative') && evidence.source !== 'agent';
}

/** Offline mirror of the private `buildUnifiedReviewInput` in memory-runtime.ts. */
export async function buildReviewerInput(
  item: ReviewerCase,
  controller?: SeededStore['controller'],
): Promise<UnifiedLearningReviewModelInput> {
  const reviewController = controller ?? (await seedStore(`f309-${item.id}`, [])).controller;
  const memory = await reviewController.prepareEpisodeReview!(item.digest);
  const { digest, priorDigests } = item;
  const evidence = digest.evidence ?? [];
  const expectedVerdict = digest.outcome === 'succeeded' ? 'passed' : 'failed';
  const matching = [digest, ...priorDigests].filter((candidate) => digest.actionSignature !== undefined
    && candidate.actionSignature === digest.actionSignature
    && candidate.outcome === 'succeeded'
    && (candidate.evidence ?? []).some((entry) => isTrustedTerminalEvidence(entry) && entry.verdict === 'passed'));
  const packet: LearningReviewEvidencePacket = {
    outcomeDigest: digest,
    verifierFacts: evidence
      .filter((entry) => isTrustedTerminalEvidence(entry) && (entry.verdict === 'passed' || entry.verdict === 'failed'))
      .map((entry) => ({ ref: entry.ref, verdict: entry.verdict as 'passed' | 'failed' })),
    priorDigests,
    qualification: {
      reusableMethodEvidence: digest.actionSignature !== undefined && digest.outcome === 'succeeded'
        && (digest.lesson !== undefined || digest.preconditions !== undefined),
      independentEpisodeCount: new Set(matching.map((entry) => entry.reviewKey)).size,
      verifiedOutcome: evidence.some((entry) => isTrustedTerminalEvidence(entry) && entry.verdict === expectedVerdict),
      failedWithLesson: digest.outcome === 'failed' && digest.lesson !== undefined,
    },
  };
  return sanitizeUnifiedLearningReviewInput({ cacheDomain: 'learning-review', memory, evidence: packet });
}

/** The pre-FEATURE_309 check for "save this as a skill", which fed the old qualification. */
function explicitSkillPreservationRequested(memory: UnifiedLearningReviewModelInput['memory']): boolean {
  const text = `${memory.userFeedback}\n${memory.task}`;
  return /\b(?:save|preserve|remember|keep)\b.{0,80}\b(?:as\s+(?:a\s+)?skill|skill)\b/i.test(text)
    || /(?:保存|保留|记住).{0,40}(?:为|成)?(?:一个)?(?:技能|Skill)/iu.test(text);
}

/** Arm A's input carries the fields the old reviewer read, in their old order. */
export function oldInputShape(input: UnifiedLearningReviewModelInput): unknown {
  const { outcomeDigest, verifierFacts, priorDigests, qualification } = input.evidence;
  return {
    ...input,
    evidence: {
      outcomeDigest,
      exactInvokedSkill: null,
      verifierFacts,
      priorDigests,
      qualification: {
        reusableMethodEvidence: qualification.reusableMethodEvidence,
        explicitSkillPreservation: explicitSkillPreservationRequested(input.memory),
        independentEpisodeCount: qualification.independentEpisodeCount,
        verifiedOutcome: qualification.verifiedOutcome,
        exactSkillInvoked: false,
        failedWithLesson: qualification.failedWithLesson ?? false,
      },
    },
  };
}

export async function buildRequest(item: ReviewerCase, arm: Arm): Promise<ReviewerRequest> {
  const input = await buildReviewerInput(item);
  if (arm === 'B') {
    return { systemPrompt: LEARNING_REVIEW_SYSTEM_PROMPT, userMessage: JSON.stringify(input), tools: [LEARNING_REVIEW_TOOL] };
  }
  const old = readArmA();
  return { systemPrompt: old.systemPrompt, userMessage: JSON.stringify(oldInputShape(input)), tools: [old.tool] };
}

// ---------------------------------------------------------------- cells

export function cellKey(cell: Omit<Cell, 'key'>): string {
  return `${cell.stage}__${aliasDir(cell.alias)}__${cell.caseId}__${cell.arm}__rep${cell.repetition}`;
}

export function plannedCells(stage: Stage): readonly Cell[] {
  const cases = stage === 'pilot'
    ? FEATURE_309_REVIEWER_CASES.filter((item) => PILOT_CASE_IDS.includes(item.id))
    : FEATURE_309_REVIEWER_CASES;
  const repetitions = stage === 'pilot' ? 1 : REVIEWER_BUDGET.repetitions;
  const cells: Cell[] = [];
  for (let repetition = 1; repetition <= repetitions; repetition++) {
    for (const alias of REVIEWER_ALIASES) {
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

type BuiltInput = Pick<PreparedCell, 'input' | 'inputHash' | 'estimatedInputTokens'>;

async function buildArmInputs(): Promise<ReadonlyMap<string, BuiltInput>> {
  const built = new Map<string, BuiltInput>();
  for (const item of FEATURE_309_REVIEWER_CASES) {
    for (const arm of ARMS) {
      const input = await buildRequest(item, arm);
      const bytes = JSON.stringify(input);
      built.set(`${item.id}:${arm}`, { input, inputHash: sha256(bytes), estimatedInputTokens: Math.ceil(Buffer.byteLength(bytes, 'utf8') / BYTES_PER_TOKEN) });
    }
  }
  return built;
}

function assertArms(): void {
  const actual = armAHash();
  if (actual !== REVIEWER_ARM_A_SHA256) throw new Error(`reviewer arm A changed (${actual}); arm A must stay the pinned pre-change prompt and tool.`);
  if (readArmA().systemPrompt === LEARNING_REVIEW_SYSTEM_PROMPT) throw new Error('reviewer arm B equals arm A; production is not the changed prompt.');
}

export async function prepareCells(stage: Stage): Promise<readonly PreparedCell[]> {
  assertArms();
  const built = await buildArmInputs();
  return plannedCells(stage).map((cell) => ({ ...cell, ...built.get(`${cell.caseId}:${cell.arm}`)! }));
}

export function assertLedgerAllows(state: LedgerState, cell: Pick<PreparedCell, 'key' | 'alias' | 'estimatedInputTokens'>): void {
  const reserved = REVIEWER_BUDGET.maxOutputTokensPerCall;
  if (state.requestedCells.has(cell.key)) throw new Error(`feature-309-reviewer per-cell call cap exceeded for ${cell.key}`);
  if (state.calls + 1 > REVIEWER_BUDGET.maxProviderCalls) throw new Error('feature-309-reviewer provider call cap exceeded');
  if (state.committedTokens + cell.estimatedInputTokens + reserved > REVIEWER_BUDGET.maxTotalTokens) {
    throw new Error('feature-309-reviewer total token cap exceeded');
  }
  const usd = state.committedUsd + estimateCost(cell.alias, { inputTokens: cell.estimatedInputTokens, outputTokens: reserved });
  if (usd > REVIEWER_BUDGET.maxExternalSpendUsd) throw new Error('feature-309-reviewer spend cap exceeded');
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
  readonly estimatedInputTokens: number;
  readonly worstCaseTokens: number;
  readonly derivedMaxTotalTokens: number;
  readonly frozenMaxTotalTokens: number;
  readonly estimatedCostUsdAtWorstCaseOutput: number;
}

export async function prepare(root: string = REVIEWER_RAW_ROOT): Promise<PrepareSummary> {
  const cells = [...await prepareCells('pilot'), ...await prepareCells('full')];
  const estimatedInputTokens = cells.reduce((sum, cell) => sum + cell.estimatedInputTokens, 0);
  const derived = (estimatedInputTokens + cells.length * EXPECTED_OUTPUT_TOKENS) * TOKEN_BUDGET_SLACK;
  const summary: PrepareSummary = {
    calls: cells.length,
    estimatedInputTokens,
    worstCaseTokens: estimatedInputTokens + cells.length * REVIEWER_BUDGET.maxOutputTokensPerCall,
    derivedMaxTotalTokens: Math.ceil(derived / TOKEN_BUDGET_ROUNDING) * TOKEN_BUDGET_ROUNDING,
    frozenMaxTotalTokens: REVIEWER_BUDGET.maxTotalTokens,
    estimatedCostUsdAtWorstCaseOutput: cells.reduce((sum, cell) => sum + estimateCost(cell.alias, {
      inputTokens: cell.estimatedInputTokens, outputTokens: REVIEWER_BUDGET.maxOutputTokensPerCall,
    }), 0),
  };
  await writeJsonAtomic(path.join(root, 'contract.json'), buildReviewerExperimentContract());
  await writeJsonAtomic(path.join(root, 'prepare', 'cells.json'), cells.map((cell) => ({
    key: cell.key, inputHash: cell.inputHash, estimatedInputTokens: cell.estimatedInputTokens,
  })));
  await writeJsonAtomic(path.join(root, 'prepare', 'estimate.json'), {
    bytesPerToken: BYTES_PER_TOKEN, expectedOutputTokensPerCall: EXPECTED_OUTPUT_TOKENS, slack: TOKEN_BUDGET_SLACK, ...summary,
  });
  return summary;
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
  if (missing.length > 0) throw new Error(`feature-309-reviewer missing API key env for: ${missing.join(', ')}`);
}

/** Production sends the reviewer request with reasoning off and the report tool forced. */
async function callCell(cell: PreparedCell): Promise<CellResponse> {
  const output = await runOneShot(cell.alias, {
    systemPrompt: cell.input.systemPrompt,
    userMessage: cell.input.userMessage,
    tools: cell.input.tools,
    forcedToolName: REVIEW_TOOL_NAME,
    reasoning: { enabled: false },
    timeoutMs: REVIEWER_BUDGET.timeoutMs,
    maxOutputTokens: REVIEWER_BUDGET.maxOutputTokensPerCall,
  });
  if (output.usage === undefined) throw new Error('provider usage is missing');
  return { text: output.text, toolCalls: output.toolCalls, usage: output.usage, durationMs: output.durationMs };
}

export async function run(options: RunOptions): Promise<RunSummary> {
  if (options.confirmBudget !== REVIEWER_BUDGET_CONFIRMATION) {
    throw new Error(`feature-309-reviewer paid run needs --confirm-budget ${REVIEWER_BUDGET_CONFIRMATION}`);
  }
  const root = options.rawRoot ?? REVIEWER_RAW_ROOT;
  const cells = await prepareCells(options.stage);
  assertCredentials(REVIEWER_ALIASES);
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
        if (existing.inputHash !== cell.inputHash) throw new Error(`feature-309-reviewer cached result for ${cell.key} has a different input hash`);
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
        estimatedInputTokens: cell.estimatedInputTokens, reservedOutputTokens: REVIEWER_BUDGET.maxOutputTokensPerCall,
      });
      external++;
      try {
        const response = await callCell(cell);
        const estimatedCostUsd = estimateCost(cell.alias, response.usage);
        const { key, stage, caseId, alias, arm, repetition } = cell;
        await writeJsonAtomic(cellPath(root, cell), {
          schemaVersion: 1, revision: REVIEWER_REVISION, cell: { key, stage, caseId, alias, arm, repetition },
          inputHash: cell.inputHash, response, estimatedCostUsd,
        } satisfies CellResult);
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

  const settled = await Promise.allSettled(REVIEWER_ALIASES.map((alias) => runLane(cells.filter((cell) => cell.alias === alias))));
  const rejected = settled.find((item): item is PromiseRejectedResult => item.status === 'rejected');
  if (rejected !== undefined) throw rejected.reason;
  const { calls, committedTokens, committedUsd } = ledgerState(readLedger(root));
  return { externalCallsThisRun: external, completedCells: completed, plannedCells: cells.length, skippedAfterFailure: skipped, ledger: { calls, committedTokens, committedUsd } };
}

// ---------------------------------------------------------------- replay and scoring

export interface Replay {
  readonly status: 'applied' | 'rejected' | 'no-review-call';
  readonly error?: string;
  readonly actions: readonly string[];
  readonly decisions: readonly string[];
  readonly warnings: readonly string[];
}

const rawReview = (output: ModelOutput): unknown =>
  output.toolCalls.find((call) => call.name === REVIEW_TOOL_NAME)?.input;

/** Runs the reviewer output through the production normalizer and governed apply, in a throwaway store. */
export async function replayCell(item: ReviewerCase, output: ModelOutput, tag: string): Promise<Replay> {
  const raw = rawReview(output);
  if (raw === undefined) return { status: 'no-review-call', actions: [], decisions: [], warnings: [] };
  const store = await seedStore(`f309-replay-${item.id}-${tag}`, []);
  try {
    const input = await buildReviewerInput(item, store.controller);
    const { memoryPlan } = normalizeUnifiedLearningReview(input, raw);
    const applied = await store.controller.applyReviewedEpisode!(memoryPlan, item.digest);
    return {
      status: 'applied',
      actions: memoryPlan.actions.map((action) => [
        action.action,
        action.claimKind === undefined ? '' : `[${action.claimKind}]`,
        action.claimKey ?? '',
        `risk=${action.risk}`,
        action.proposedBody === undefined ? '' : `: ${action.proposedBody.replace(/\s+/g, ' ')}`,
      ].filter((part) => part.length > 0).join(' ')),
      decisions: applied.decisions.map((decision) => `${decision.kind}: ${decision.reason}`),
      warnings: applied.warnings,
    };
  } catch (error) {
    return { status: 'rejected', error: error instanceof Error ? error.message : String(error), actions: [], decisions: [], warnings: [] };
  }
}

export function scoreCell(item: ReviewerCase, output: ModelOutput): Scored {
  return scoreWriteCell(item.oracle, rawReview(output));
}

/** Arm A's Skill decision, a diagnostic that would unblind the pack. */
export function skillDecision(output: ModelOutput): string {
  const raw = rawReview(output);
  const decision = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>).capabilityDecision : undefined;
  if (typeof decision !== 'object' || decision === null) return 'none';
  const record = decision as Record<string, unknown>;
  const spec = record.spec as Record<string, unknown> | undefined;
  return [record.disposition, record.operation, spec?.name].filter((part) => typeof part === 'string').join(' ');
}

// ---------------------------------------------------------------- pack

/** Deterministic per-pair coin so the reviewer cannot learn which side is which from position. */
export function armShownAsX(pairId: string): Arm {
  return Number.parseInt(sha256(`${REVIEWER_REVISION}:${pairId}`).slice(0, 8), 16) % 2 === 0 ? 'A' : 'B';
}

const pairIdOf = (cell: Cell): string => `${cell.stage}__${aliasDir(cell.alias)}__${cell.caseId}__rep${cell.repetition}`;

function renderReplay(label: string, replay: Replay): string {
  if (replay.status !== 'applied') return `  ${label}: ${replay.status}${replay.error === undefined ? '' : ` (${replay.error})`}`;
  const actions = replay.actions.length > 0 ? replay.actions.map((line) => `    ${line}`).join('\n') : '    (no action)';
  const decisions = replay.decisions.length > 0 ? replay.decisions.map((line) => `    ${line}`).join('\n') : '    (none)';
  const warnings = replay.warnings.length > 0 ? `\n  ${label} warnings: ${replay.warnings.join(' | ')}` : '';
  return `  ${label} actions:\n${actions}\n  ${label} governed apply:\n${decisions}${warnings}`;
}

function renderCase(item: ReviewerCase): string {
  const { digest } = item;
  const lines = [
    `objective: ${digest.objective}`,
    `summary: ${digest.summary}`,
    ...(digest.lesson === undefined ? [] : [`lesson: ${digest.lesson}`]),
    ...(digest.preconditions === undefined ? [] : [`preconditions: ${digest.preconditions}`]),
    ...item.priorDigests.map((prior) => `earlier episode: ${prior.summary}`),
  ];
  return lines.map((line) => `    ${line}`).join('\n');
}

async function readResult(root: string, cell: Cell): Promise<CellResult | undefined> {
  return readJson<CellResult>(cellPath(root, cell));
}

export interface PackSummary {
  readonly pairs: number;
  readonly missing: readonly string[];
}

export async function pack(stage: Stage, rawRoot: string = REVIEWER_RAW_ROOT): Promise<PackSummary> {
  const missing: string[] = [];
  const unblind: Record<string, { X: Arm; Y: Arm }> = {};
  const byCase = new Map<string, string[]>();
  for (const cell of plannedCells(stage).filter((item) => item.arm === 'A')) {
    const pairId = pairIdOf(cell);
    const item = CASE_BY_ID.get(cell.caseId)!;
    const other = { ...cell, arm: 'B' as const, key: cellKey({ ...cell, arm: 'B' }) };
    const [a, b] = [await readResult(rawRoot, cell), await readResult(rawRoot, other)];
    if (a === undefined || b === undefined) { missing.push(pairId); continue; }
    const x = armShownAsX(pairId);
    unblind[pairId] = { X: x, Y: x === 'A' ? 'B' : 'A' };
    const [shownX, shownY] = x === 'A' ? [a, b] : [b, a];
    const block = `- ${pairId}\n${renderReplay('X', await replayCell(item, shownX.response, shownX.cell.key))}\n${renderReplay('Y', await replayCell(item, shownY.response, shownY.cell.key))}`;
    byCase.set(cell.caseId, [...(byCase.get(cell.caseId) ?? []), block]);
  }
  const sections = [...byCase].map(([caseId, blocks]) => {
    const item = CASE_BY_ID.get(caseId)!;
    return `## ${caseId} (${item.family})\n\nEpisode:\n${renderCase(item)}\n\n${blocks.join('\n\n')}\n`;
  });
  const dir = path.join(rawRoot, 'main-session-review', stage);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'blind-pack.md'), `# ${REVIEWER_REVISION} ${stage} blind pack\n\n${sections.join('\n')}`, 'utf8');
  await writeJsonAtomic(path.join(dir, 'unblind.json'), unblind);
  return { pairs: Object.keys(unblind).length, missing };
}

/** Mechanical scores, Skill decisions and output sizes per cell; read only after the blind review is on disk. */
export async function tally(stage: Stage, rawRoot: string = REVIEWER_RAW_ROOT): Promise<readonly string[]> {
  const rows: string[] = [];
  for (const cell of plannedCells(stage)) {
    const result = await readResult(rawRoot, cell);
    if (result === undefined) continue;
    const item = CASE_BY_ID.get(cell.caseId)!;
    const scored = scoreCell(item, result.response);
    const output = result.response.usage.outputTokens;
    rows.push([
      cell.key,
      scored.verdict,
      scored.reasons.join('; '),
      cell.arm === 'A' ? `skill=${skillDecision(result.response)}` : '',
      `out=${output}${output > PRODUCTION_OUTPUT_CAP ? ' (over the production cap)' : ''}`,
    ].filter((part) => part.length > 0).join(' | '));
  }
  return rows;
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
