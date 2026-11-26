/**
 * Skill learning value eval runner (docs/designs/skill-learning-value-eval.md).
 *
 * Per chain (alias, case, repetition) and arm (N notes only, S notes + skills):
 *   reflect   session 1 through the arm's reflection request
 *   d         session 2 probe D, the task in a fresh session
 *   p<i>      session 2 probe P at checkpoint i, after loading what the arm stored
 *
 *   prepare  zero provider calls: gate check, a synthetic dry run of every chain, input sizes
 *   run      paid calls for a scope (pilot | full); one in flight per alias; exact confirmation
 *   pack     zero provider calls: mechanical classes plus a blinded N/S pair file
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { shouldReflect } from '@kodax-ai/agent';
import type { KodaXTokenUsage } from '@kodax-ai/llm';

import { REFLECT_TOOL_NAME, SKILL_TOOL_NAME } from '../../../packages/coding/src/memory/note-reflection.js';
import { MODEL_ALIASES, type ModelAlias } from '../../harness/aliases.js';
import { runOneShot } from '../../harness/harness.js';
import type { ModelOutput } from '../feature-308-baseline/oracles.js';
import { estimateCost, ledgerState, readLedger, sha256, type LedgerEntry, type LedgerState } from '../feature-308-baseline/runner.js';
import { SKILL_VALUE_CASES, caseOf, type ValueCase, type ValueCaseId } from './cases.js';
import { ARMS, buildSessionTwo, reflectInput, type Arm, type ModelInput, type RecordedCall } from './inputs.js';
import { classifyCheckpoint, classifyDiscovery, storedFacts } from './oracles.js';

export const VALUE_REVISION = 'skill-value-r1' as const;
export const VALUE_ROOT = path.join(os.tmpdir(), 'kodax-eval-dumps', 'skill-learning-value', VALUE_REVISION);
const BYTES_PER_TOKEN = 3;
const MAX_OUTPUT_TOKENS = 8192;
const TIMEOUT_MS = 180_000;

export type Scope = 'pilot' | 'full';

interface ScopeSpec {
  readonly cases: readonly ValueCaseId[];
  readonly aliases: readonly ModelAlias[];
  readonly repetitions: number;
  /** Cap on all ledger calls so far, pilot included. */
  readonly maxProviderCalls: number;
  readonly maxTotalTokens: number;
  readonly maxExternalSpendUsd: number;
}

/**
 * Caps frozen before any paid call, derived from `prepare` (case hash 362e3767…):
 * planned input is 0.32M tokens for the pilot and 2.55M for the full run, and every call
 * reserving the full 8192 output tokens brings that to 0.58M and 4.62M. The caps add about
 * 30% for stored artifacts larger than the dry run's. Worst-case spend is about $0.09 for
 * the pilot and $1.06 for the full run (only glm-5.3-flash and deepseek-flash are priced).
 * The full run's caps count the pilot calls it reuses.
 */
export const SCOPES: Readonly<Record<Scope, ScopeSpec>> = {
  pilot: { cases: ['c1', 's1'], aliases: ['kimi', 'zhipu/glm53flash'], repetitions: 1, maxProviderCalls: 40, maxTotalTokens: 800_000, maxExternalSpendUsd: 0.5 },
  full: { cases: ['s1', 's2', 'c1', 'c2', 'c3'], aliases: ['kimi', 'zhipu/glm53flash', 'ds/flash'], repetitions: 2, maxProviderCalls: 300, maxTotalTokens: 6_000_000, maxExternalSpendUsd: 2 },
};

export const confirmation = (scope: Scope): string => {
  const spec = SCOPES[scope];
  return `${VALUE_REVISION}:${scope}:calls=${spec.maxProviderCalls}:tokens=${spec.maxTotalTokens}:usd=${spec.maxExternalSpendUsd}`;
};

export interface Chain {
  readonly alias: ModelAlias;
  readonly caseId: ValueCaseId;
  readonly repetition: number;
}

const aliasDir = (alias: ModelAlias): string => alias.replace('/', '_');
export const chainKey = (chain: Chain, arm: Arm): string => `${aliasDir(chain.alias)}__${chain.caseId}__${arm}__r${chain.repetition}`;

export function plannedChains(scope: Scope): readonly Chain[] {
  const spec = SCOPES[scope];
  return spec.aliases.flatMap((alias) => spec.cases.flatMap((caseId) =>
    Array.from({ length: spec.repetitions }, (_, index) => ({ alias, caseId, repetition: index + 1 }))));
}

const callsPerChain = (item: ValueCase): number => ARMS.length * (2 + item.checkpoints.length);
export const plannedCalls = (scope: Scope): number => plannedChains(scope).reduce((sum, chain) => sum + callsPerChain(caseOf(chain.caseId)), 0);

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

const callFile = (root: string, chain: Chain, arm: Arm, probe: string): string =>
  path.join(root, 'calls', aliasDir(chain.alias), `${chainKey(chain, arm)}__${probe}.json`);

function appendLedger(root: string, entry: LedgerEntry): void {
  mkdirSync(root, { recursive: true });
  appendFileSync(path.join(root, 'ledger.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, 'utf8');
}

const sizeOf = (input: ModelInput): number => Math.ceil(Buffer.byteLength(JSON.stringify(input), 'utf8') / BYTES_PER_TOKEN);

function assertLedgerAllows(spec: ScopeSpec, state: LedgerState, key: string, alias: ModelAlias, estimatedInputTokens: number): void {
  if (state.requestedCells.has(key)) throw new Error(`skill-value per-call cap exceeded for ${key}`);
  if (state.calls + 1 > spec.maxProviderCalls) throw new Error('skill-value provider call cap exceeded');
  if (state.committedTokens + estimatedInputTokens + MAX_OUTPUT_TOKENS > spec.maxTotalTokens) throw new Error('skill-value total token cap exceeded');
  if (state.committedUsd + estimateCost(alias, { inputTokens: estimatedInputTokens, outputTokens: MAX_OUTPUT_TOKENS }) > spec.maxExternalSpendUsd) {
    throw new Error('skill-value spend cap exceeded');
  }
}

// ---------------------------------------------------------------- prepare

/** Stand-in reflection output for the dry run: one procedure note (N) or one skill (S). */
function syntheticCalls(item: ValueCase, arm: Arm): readonly RecordedCall[] {
  const lastUser = [...item.sessionOne].reverse().find((message) => message.role === 'user' && typeof message.content === 'string');
  const quote = typeof lastUser?.content === 'string' ? lastUser.content : '';
  const steps = item.steps.map((step) => JSON.stringify(step.input));
  if (arm === 'S') {
    return [{ name: SKILL_TOOL_NAME, input: { name: `dry-run-${item.id}`, description: item.family, purpose: item.family, triggers: [item.family], steps, verification: ['the last step succeeds'], pitfalls: item.checkpoints.map((checkpoint) => checkpoint.label), quote } }];
  }
  return [{ name: REFLECT_TOOL_NAME, input: { operation: 'write', id: `dry-run-${item.id}`, type: 'procedure', description: item.family, body: steps.join('\n'), quote } }];
}

export async function prepare(root: string = VALUE_ROOT): Promise<object> {
  const bad = SKILL_VALUE_CASES.filter((item) => !shouldReflect(item.sessionOne)).map((item) => item.id);
  if (bad.length > 0) throw new Error(`session one of ${bad.join(', ')} does not pass the reflection gate`);
  const cases = [];
  for (const item of SKILL_VALUE_CASES) {
    const arms: Record<string, object> = {};
    for (const arm of ARMS) {
      const session = await buildSessionTwo(item, arm, syntheticCalls(item, arm));
      if (session.world.notes.length + session.world.skills.length !== 1) throw new Error(`${item.id}/${arm}: dry run did not store its artifact: ${session.world.trace.join('; ')}`);
      if (arm === 'S' && !session.skillsPrompt.includes(`dry-run-${item.id}`)) throw new Error(`${item.id}: the stored skill is missing from the catalog`);
      arms[arm] = {
        reflectTokens: sizeOf(reflectInput(item, arm)),
        discoveryTokens: sizeOf(session.discovery),
        checkpointTokens: session.checkpoints.map(sizeOf),
      };
    }
    cases.push({ id: item.id, tier: item.tier, arms });
  }
  const caseHash = sha256(JSON.stringify(SKILL_VALUE_CASES, (_key, value: unknown) => (value instanceof RegExp ? value.source : value)));
  const plan = Object.fromEntries((['pilot', 'full'] as const).map((scope) => [scope, { chains: plannedChains(scope).length, calls: plannedCalls(scope), confirmation: confirmation(scope) }]));
  await writeJsonAtomic(path.join(root, 'prepare.json'), { revision: VALUE_REVISION, caseHash, cases, plan });
  return { revision: VALUE_REVISION, caseHash, cases, plan };
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
      ...(input.priorMessages === undefined ? {} : { priorMessages: input.priorMessages }),
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
async function cached(root: string, spec: ScopeSpec, chain: Chain, arm: Arm, probe: string, input: () => ModelInput | Promise<ModelInput>): Promise<Call> {
  const file = callFile(root, chain, arm, probe);
  const existing = await readJson<Call>(file);
  if (existing !== undefined) return existing;
  const key = `${chainKey(chain, arm)}:${probe}`;
  if (ledgerState(readLedger(root)).requestedCells.has(key)) throw new Error(`${key} was requested but has no result; inspect the ledger before retrying`);
  const result = await callModel(root, spec, chain.alias, key, await input());
  await writeJsonAtomic(file, result);
  return result;
}

async function runChain(root: string, spec: ScopeSpec, chain: Chain): Promise<void> {
  const item = caseOf(chain.caseId);
  for (const arm of ARMS) {
    const reflect = await cached(root, spec, chain, arm, 'reflect', () => reflectInput(item, arm));
    const session = await buildSessionTwo(item, arm, reflect.toolCalls);
    await cached(root, spec, chain, arm, 'd', () => session.discovery);
    for (const [index, input] of session.checkpoints.entries()) {
      await cached(root, spec, chain, arm, `p${index + 1}`, () => input);
    }
  }
}

export async function run(scope: Scope, confirmBudget: string, root: string = VALUE_ROOT): Promise<object> {
  if (confirmBudget !== confirmation(scope)) throw new Error(`skill-value ${scope} run needs --confirm-budget ${confirmation(scope)}`);
  const spec = SCOPES[scope];
  const missing = spec.aliases.filter((alias) => (process.env[MODEL_ALIASES[alias].apiKeyEnv] ?? '').length === 0);
  if (missing.length > 0) throw new Error(`skill-value missing API key env for: ${missing.join(', ')}`);
  await prepare(root);
  let failure: unknown;
  const lane = async (alias: ModelAlias): Promise<void> => {
    for (const chain of plannedChains(scope).filter((item) => item.alias === alias)) {
      if (failure !== undefined) return;
      try {
        await runChain(root, spec, chain);
      } catch (error) {
        failure ??= error;
        throw error;
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

const asOutput = (call: Call): ModelOutput => ({ text: call.text, toolCalls: call.toolCalls });
const clip = (text: string, max = 1200): string => (text.length > max ? `${text.slice(0, max)}…` : text);
const shown = (call: Call): object => ({ calls: call.toolCalls.map((item) => clip(JSON.stringify(item), 600)), text: clip(call.text, 600) });

interface ArmResult {
  readonly reflect: Call;
  readonly stored: { readonly notes: readonly string[]; readonly skills: readonly string[]; readonly trace: readonly string[]; readonly facts: readonly boolean[] };
  readonly d: { readonly call: Call; readonly cls: string };
  readonly p: readonly { readonly call: Call; readonly cls: string }[];
}

async function loadArm(root: string, chain: Chain, arm: Arm): Promise<ArmResult | undefined> {
  const item = caseOf(chain.caseId);
  const reflect = await readJson<Call>(callFile(root, chain, arm, 'reflect'));
  const d = await readJson<Call>(callFile(root, chain, arm, 'd'));
  const p = await Promise.all(item.checkpoints.map((_, index) => readJson<Call>(callFile(root, chain, arm, `p${index + 1}`))));
  if (reflect === undefined || d === undefined || p.some((call) => call === undefined)) return undefined;
  const { world } = await buildSessionTwo(item, arm, reflect.toolCalls);
  return {
    reflect,
    stored: {
      notes: world.notes.map((note) => `${note.id} (${note.type}): ${note.description}`),
      skills: world.skills.map((skill) => `${skill.name}: ${skill.steps.length} steps, ${skill.pitfalls.length} pitfalls`),
      trace: world.trace,
      facts: storedFacts(item, world),
    },
    d: { call: d, cls: classifyDiscovery(item, world, asOutput(d)) },
    p: p.map((call, index) => ({ call: call!, cls: classifyCheckpoint(item.checkpoints[index]!, asOutput(call!)) })),
  };
}

function tally(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

export async function pack(scope: Scope, root: string = VALUE_ROOT): Promise<object> {
  const rows: { chain: Chain; N: ArmResult; S: ArmResult }[] = [];
  const missing: string[] = [];
  for (const chain of plannedChains(scope)) {
    const [N, S] = await Promise.all([loadArm(root, chain, 'N'), loadArm(root, chain, 'S')]);
    if (N === undefined || S === undefined) missing.push(chainKey(chain, 'S'));
    else rows.push({ chain, N, S });
  }
  const summarize = (selected: typeof rows) => Object.fromEntries(ARMS.map((arm) => [arm, {
    d: tally(selected.map((row) => row[arm].d.cls)),
    p: tally(selected.flatMap((row) => row[arm].p.map((cell) => cell.cls))),
    skillsStored: selected.filter((row) => row[arm].stored.skills.length > 0).length,
    nothingStored: selected.filter((row) => row[arm].stored.skills.length + row[arm].stored.notes.length === 0).length,
    factsStored: `${selected.flatMap((row) => row[arm].stored.facts).filter(Boolean).length}/${selected.flatMap((row) => row[arm].stored.facts).length}`,
  }]));
  const byTier = Object.fromEntries((['simple', 'complex'] as const).map((tier) => [tier, summarize(rows.filter((row) => caseOf(row.chain.caseId).tier === tier))]));
  const byAlias = Object.fromEntries(SCOPES[scope].aliases.map((alias) => [alias, summarize(rows.filter((row) => row.chain.alias === alias && caseOf(row.chain.caseId).tier === 'complex'))]));
  const byCase = Object.fromEntries(SCOPES[scope].cases.map((caseId) => [caseId, summarize(rows.filter((row) => row.chain.caseId === caseId))]));

  const blind = rows.flatMap((row) => {
    const item = caseOf(row.chain.caseId);
    const probes = [
      { probe: 'd', label: 'first action in a fresh session', n: row.N.d, s: row.S.d },
      ...item.checkpoints.map((checkpoint, index) => ({ probe: `p${index + 1}`, label: checkpoint.label, n: row.N.p[index]!, s: row.S.p[index]! })),
    ];
    return probes.map((probe) => {
      const key = `${chainKey(row.chain, 'S')}:${probe.probe}`;
      const sFirst = parseInt(sha256(key).slice(0, 2), 16) % 2 === 0;
      const [x, y] = sFirst ? (['S', 'N'] as const) : (['N', 'S'] as const);
      const side = (arm: Arm) => (arm === 'N' ? probe.n : probe.s);
      return {
        key, caseId: item.id, tier: item.tier, alias: row.chain.alias, task: item.task, probe: probe.probe, expected: probe.label,
        X: { ...shown(side(x).call), mechanical: side(x).cls },
        Y: { ...shown(side(y).call), mechanical: side(y).cls },
        needsReview: side(x).cls !== side(y).cls || side(x).cls === 'review' || side(x).cls === 'other',
        unblind: { X: x, Y: y },
      };
    });
  });
  const stored = rows.map((row) => ({ key: chainKey(row.chain, 'S'), N: row.N.stored, S: row.S.stored }));
  await writeJsonAtomic(path.join(root, 'review', `${scope}-pack.json`), blind);
  await writeJsonAtomic(path.join(root, 'review', `${scope}-stored.json`), stored);
  const { calls, committedTokens, committedUsd } = ledgerState(readLedger(root));
  return { scope, chains: rows.length, missing, byTier, complexByAlias: byAlias, byCase, toReview: blind.filter((entry) => entry.needsReview).length, ledger: { calls, committedTokens, committedUsd } };
}

// ---------------------------------------------------------------- cli

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  const root = flag('raw-root') ?? VALUE_ROOT;
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
