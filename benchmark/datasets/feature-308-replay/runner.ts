/**
 * FEATURE_308 Phase 2c runner: the reflection job on REAL local sessions.
 *
 *   prepare  zero provider calls: picks a deterministic sample of gate-passing
 *            sessions, builds every request with production code, writes the estimate.
 *   run      paid calls; one in flight per alias; exact budget confirmation string;
 *            pre-request ledger; a cell with a ledger entry is never called again.
 *   pack     zero provider calls: replays recorded calls through the real operation
 *            into an empty throwaway store and writes the review pack.
 *
 * Raw sessions are private: everything this runner writes stays under the OS temp
 * directory, and nothing from the sessions is committed.
 */
import { appendFileSync, mkdirSync, rmSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { applyReflectionOperation, buildEvidence, createNoteStore, type MemoryNote, type NoteScope, type NoteStore } from '@kodax-ai/agent';
import type { KodaXTokenUsage } from '@kodax-ai/llm';

import { buildReflectionRequest, parseReflectionCall, REFLECT_TOOL_NAME } from '../../../packages/coding/src/memory/note-reflection.js';
import { MODEL_ALIASES, type ModelAlias } from '../../harness/aliases.js';
import { runOneShot } from '../../harness/harness.js';
import { estimateCost, ledgerState, readLedger, sha256, type LedgerEntry, type LedgerState } from '../feature-308-baseline/runner.js';
import { listSessions, readMessages, surveySession, type RealSession } from './sessions.js';

export const REPLAY_REVISION = 'f306-phase2c-r2' as const;
/** Fixed so a new revision replays the same sessions as the one before it. */
const SAMPLE_SEED = 'f306-phase2c';
export const REPLAY_ALIASES: readonly ModelAlias[] = Object.freeze(['ark/k27', 'zhipu/glm52', 'ark/v4flash']);
export const REPLAY_ROOT = path.join(os.tmpdir(), 'kodax-eval-dumps', 'feature-306', REPLAY_REVISION);

const SAMPLE_SIZE = 16;
const PER_PROJECT = 4;
const MIN_MESSAGES = 6;

export const REPLAY_BUDGET = {
  plannedCalls: SAMPLE_SIZE * REPLAY_ALIASES.length,
  /** Planned 48 plus 25% headroom for authorized infrastructure reruns. */
  maxProviderCalls: 60,
  /** One response per cell; no retry. */
  maxOutputTokensPerCall: 8192,
  /** 48 requests of at most ~20k estimated input tokens plus 8192 reserved output each, rounded up. */
  maxTotalTokens: 1_500_000,
  maxExternalSpendUsd: 2,
  timeoutMs: 180_000,
} as const;

export const REPLAY_BUDGET_CONFIRMATION =
  `${REPLAY_REVISION}:calls=${REPLAY_BUDGET.maxProviderCalls}:tokens=${REPLAY_BUDGET.maxTotalTokens}:usd=${REPLAY_BUDGET.maxExternalSpendUsd}` as const;

const aliasDir = (alias: ModelAlias): string => alias.replace('/', '_');
const BYTES_PER_TOKEN = 3;

export function selectSessions(sessions: readonly RealSession[]): readonly RealSession[] {
  const eligible = sessions.filter((session) => session.bytes < 8_000_000).flatMap((session) => {
    const survey = surveySession(session);
    return survey.gate && survey.messages >= MIN_MESSAGES ? [session] : [];
  });
  const byProject = new Map<string, RealSession[]>();
  for (const session of eligible) byProject.set(session.project, [...(byProject.get(session.project) ?? []), session]);
  const picked = [...byProject.values()].flatMap((group) =>
    [...group].sort((a, b) => sha256(a.id).localeCompare(sha256(b.id))).slice(0, PER_PROJECT));
  return picked.sort((a, b) => sha256(`${SAMPLE_SEED}:${a.id}`).localeCompare(sha256(`${SAMPLE_SEED}:${b.id}`))).slice(0, SAMPLE_SIZE);
}

interface Cell {
  readonly key: string;
  readonly alias: ModelAlias;
  readonly session: RealSession;
  readonly systemPrompt: string;
  readonly userMessage: string;
  readonly tools: ReturnType<typeof buildReflectionRequest>['tools'];
  readonly estimatedInputTokens: number;
  readonly inputHash: string;
}

function prepareCells(): readonly Cell[] {
  const cells: Cell[] = [];
  for (const session of selectSessions(listSessions())) {
    const messages = readMessages(session.file);
    const request = buildReflectionRequest(buildEvidence(messages), []);
    const body = JSON.stringify(request);
    for (const alias of REPLAY_ALIASES) {
      cells.push({
        key: `${aliasDir(alias)}__${session.id}`, alias, session,
        systemPrompt: request.systemPrompt, userMessage: request.userMessage, tools: request.tools,
        estimatedInputTokens: Math.ceil(Buffer.byteLength(body, 'utf8') / BYTES_PER_TOKEN),
        inputHash: sha256(body),
      });
    }
  }
  return cells;
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

function appendLedger(root: string, entry: LedgerEntry): void {
  appendFileSync(path.join(root, 'ledger.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, 'utf8');
}

function assertLedgerAllows(state: LedgerState, cell: Pick<Cell, 'key' | 'alias' | 'estimatedInputTokens'>): void {
  const reserved = REPLAY_BUDGET.maxOutputTokensPerCall;
  if (state.requestedCells.has(cell.key)) throw new Error(`feature-308-replay per-cell call cap exceeded for ${cell.key}`);
  if (state.calls + 1 > REPLAY_BUDGET.maxProviderCalls) throw new Error('feature-308-replay provider call cap exceeded');
  if (state.committedTokens + cell.estimatedInputTokens + reserved > REPLAY_BUDGET.maxTotalTokens) throw new Error('feature-308-replay total token cap exceeded');
  const usd = state.committedUsd + estimateCost(cell.alias, { inputTokens: cell.estimatedInputTokens, outputTokens: reserved });
  if (usd > REPLAY_BUDGET.maxExternalSpendUsd) throw new Error('feature-308-replay spend cap exceeded');
}

// ---------------------------------------------------------------- prepare

export async function prepare(root: string = REPLAY_ROOT): Promise<object> {
  const cells = prepareCells();
  const tokens = cells.reduce((sum, cell) => sum + cell.estimatedInputTokens, 0);
  await writeJsonAtomic(path.join(root, 'selection.json'), [...new Set(cells.map((cell) => cell.session.id))].map((id) => {
    const cell = cells.find((item) => item.session.id === id)!;
    return { id, project: cell.session.project, bytes: cell.session.bytes, estimatedInputTokens: cell.estimatedInputTokens };
  }));
  return {
    sessions: new Set(cells.map((cell) => cell.session.id)).size,
    cells: cells.length,
    estimatedInputTokens: tokens,
    worstCaseTokens: tokens + cells.length * REPLAY_BUDGET.maxOutputTokensPerCall,
    frozenMaxTotalTokens: REPLAY_BUDGET.maxTotalTokens,
    worstCaseUsd: cells.reduce((sum, cell) => sum + estimateCost(cell.alias, { inputTokens: cell.estimatedInputTokens, outputTokens: REPLAY_BUDGET.maxOutputTokensPerCall }), 0),
  };
}

// ---------------------------------------------------------------- run

interface CellResult {
  readonly key: string;
  readonly alias: ModelAlias;
  readonly sessionId: string;
  readonly inputHash: string;
  readonly text: string;
  readonly toolCalls: readonly { readonly name: string; readonly input: unknown }[];
  readonly usage: KodaXTokenUsage;
  readonly durationMs: number;
  readonly estimatedCostUsd: number;
}

export async function run(confirmBudget: string, root: string = REPLAY_ROOT): Promise<object> {
  if (confirmBudget !== REPLAY_BUDGET_CONFIRMATION) throw new Error(`feature-308-replay paid run needs --confirm-budget ${REPLAY_BUDGET_CONFIRMATION}`);
  const missing = REPLAY_ALIASES.filter((alias) => (process.env[MODEL_ALIASES[alias].apiKeyEnv] ?? '').length === 0);
  if (missing.length > 0) throw new Error(`feature-308-replay missing API key env for: ${missing.join(', ')}`);
  await prepare(root);
  const cells = prepareCells();
  let external = 0;
  let failure: unknown;
  const lane = async (laneCells: readonly Cell[]): Promise<void> => {
    for (const cell of laneCells) {
      if (failure !== undefined) return;
      const existing = await readJson<CellResult>(cellPath(root, cell));
      if (existing !== undefined) {
        if (existing.inputHash !== cell.inputHash) throw new Error(`cached result for ${cell.key} has a different input hash`);
        continue;
      }
      if (ledgerState(readLedger(root)).requestedCells.has(cell.key)) continue;
      assertLedgerAllows(ledgerState(readLedger(root)), cell);
      appendLedger(root, { event: 'requested', cellKey: cell.key, alias: cell.alias, estimatedInputTokens: cell.estimatedInputTokens, reservedOutputTokens: REPLAY_BUDGET.maxOutputTokensPerCall });
      external++;
      try {
        const output = await runOneShot(cell.alias, {
          systemPrompt: cell.systemPrompt, userMessage: cell.userMessage, tools: cell.tools,
          timeoutMs: REPLAY_BUDGET.timeoutMs, maxOutputTokens: REPLAY_BUDGET.maxOutputTokensPerCall,
        });
        if (output.usage === undefined) throw new Error('provider usage is missing');
        const estimatedCostUsd = estimateCost(cell.alias, output.usage);
        await writeJsonAtomic(cellPath(root, cell), {
          key: cell.key, alias: cell.alias, sessionId: cell.session.id, inputHash: cell.inputHash,
          text: output.text, toolCalls: output.toolCalls, usage: output.usage, durationMs: output.durationMs, estimatedCostUsd,
        } satisfies CellResult);
        appendLedger(root, { event: 'completed', cellKey: cell.key, alias: cell.alias, usage: output.usage, estimatedCostUsd });
      } catch (error) {
        appendLedger(root, { event: 'failed', cellKey: cell.key, alias: cell.alias, error: error instanceof Error ? error.message : String(error) });
        failure ??= error;
        throw error;
      }
    }
  };
  const settled = await Promise.allSettled(REPLAY_ALIASES.map((alias) => lane(cells.filter((cell) => cell.alias === alias))));
  const rejected = settled.find((item): item is PromiseRejectedResult => item.status === 'rejected');
  if (rejected !== undefined) throw rejected.reason;
  const { calls, committedTokens, committedUsd } = ledgerState(readLedger(root));
  return { externalCallsThisRun: external, ledger: { calls, committedTokens, committedUsd } };
}

// ---------------------------------------------------------------- pack

function emptyStores(name: string): Readonly<Record<NoteScope, NoteStore>> {
  const dir = path.join(os.tmpdir(), 'kodax-eval-fixtures', 'feature-308-replay', name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return { project: createNoteStore(path.join(dir, 'project'), 'project'), user: createNoteStore(path.join(dir, 'user'), 'user') };
}

const preview = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max)}...`);

export async function pack(root: string = REPLAY_ROOT): Promise<object> {
  const entries: unknown[] = [];
  const perAlias = new Map<string, { sessions: number; withCalls: number; writes: number; active: number; candidate: number; rejected: number; costUsd: number }>();
  for (const cell of prepareCells()) {
    const result = await readJson<CellResult>(cellPath(root, cell));
    if (result === undefined) continue;
    const messages = readMessages(cell.session.file);
    const evidence = buildEvidence(messages);
    const stores = emptyStores(`${result.key}`);
    const trace: string[] = [];
    let rejected = 0;
    for (const call of result.toolCalls.filter((item) => item.name === REFLECT_TOOL_NAME)) {
      const input = typeof call.input === 'object' && call.input !== null ? parseReflectionCall(call.input as Record<string, unknown>) : undefined;
      const outcome = input === undefined
        ? { ok: false, message: 'malformed memory_reflect call' }
        : await applyReflectionOperation({ stores, evidence, sessionId: `replay-${cell.session.id}` }, input);
      if (!outcome.ok) rejected++;
      trace.push(`${input?.operation ?? '?'} ${input?.id ?? '?'}: ${outcome.message}`);
    }
    const notes: readonly MemoryNote[] = [...await stores.project.list(), ...await stores.user.list()];
    const stat = perAlias.get(cell.alias) ?? { sessions: 0, withCalls: 0, writes: 0, active: 0, candidate: 0, rejected: 0, costUsd: 0 };
    perAlias.set(cell.alias, {
      sessions: stat.sessions + 1,
      withCalls: stat.withCalls + (result.toolCalls.length > 0 ? 1 : 0),
      writes: stat.writes + notes.length,
      active: stat.active + notes.filter((note) => note.status === 'active').length,
      candidate: stat.candidate + notes.filter((note) => note.status === 'candidate').length,
      rejected: stat.rejected + rejected,
      costUsd: stat.costUsd + result.estimatedCostUsd,
    });
    entries.push({
      key: result.key, alias: result.alias, sessionId: cell.session.id, project: cell.session.project,
      userMessages: evidence.segments.filter((segment) => segment.source === 'user').map((segment) => preview(segment.text, 240)),
      omitted: evidence.omitted,
      notes: notes.map((note) => ({ id: note.id, status: note.status, source: note.source, description: note.description, why: note.why, check: note.check, body: preview(note.body, 400) })),
      trace, usage: result.usage, durationMs: result.durationMs,
      ...(result.text.length > 0 ? { text: preview(result.text, 300) } : {}),
    });
  }
  await writeJsonAtomic(path.join(root, 'review', 'pack.json'), entries);
  return { entries: entries.length, perAlias: Object.fromEntries(perAlias) };
}

// ---------------------------------------------------------------- CLI

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  const root = flag('raw-root');
  const out = (value: unknown): void => { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); };
  if (mode === 'prepare') out(await prepare(root));
  else if (mode === 'run') out(await run(flag('confirm-budget') ?? '', root));
  else if (mode === 'pack') out(await pack(root));
  else throw new Error('usage: runner.ts <prepare|run|pack> [--raw-root DIR] [--confirm-budget TOKEN]');
}

if (process.env.VITEST === undefined && import.meta.url === pathToFileURL(process.argv[1] ?? '').href
  && ['prepare', 'run', 'pack'].includes(process.argv[2] ?? '')) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
