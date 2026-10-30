/**
 * Cold-start cache probe: does a fresh Session's first request in the same
 * project reuse the DeepSeek prompt cache written by an earlier Session's
 * first request?
 *
 * Phases (KODAX_COLD_START_EVAL_PHASE): register -> prepare (offline) ->
 * probe (2 paid DeepSeek calls) -> analyze. Output lives under OS Temp.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { it } from 'vitest';
import { getProvider, getCostRate, calculateCost, type KodaXStreamResult,
  type KodaXProviderStreamOptions } from '../packages/llm/src/index.js';
import { observeProviderOperation, runWithAdditionalProviderRequestObserver,
  type ProviderRequestObservation } from '../packages/llm/src/provider-request-observation.js';
import { runNaturalRuntime } from './shared-contract-natural-runtime.js';
import { firstTurnReasoningFor, type FrozenInput } from './first-turn-eval-support.js';

const REVISION = 'cold-start-cache-r1-20261030';
const ROUTE = 'deepseek';
const MODEL = 'deepseek-flash';
const KEY = 'DEEPSEEK_API_KEY';
const CASE = 'tenant-cache';
const LIMITS = { calls: 2, output: 256, usd: 0.01, pauseMs: 10_000, requestMs: 180_000 };
const SESSIONS = ['session-a', 'session-b'] as const;
type SessionName = (typeof SESSIONS)[number];
type Usage = NonNullable<KodaXStreamResult['usage']>;

const phase = process.env.KODAX_COLD_START_EVAL_PHASE;
const root = path.resolve(process.env.KODAX_COLD_START_EVAL_ROOT ?? path.join(os.tmpdir(), 'kodax-eval-dumps', REVISION));
const save = (file: string, value: unknown) => fs.writeFile(file, JSON.stringify(value, null, 2), { flag: 'wx' });
const read = async <T>(file: string): Promise<T> => JSON.parse(await fs.readFile(file, 'utf8')) as T;
const redact = (text: string) => { const key = process.env[KEY]; return key ? text.replaceAll(key, '[REDACTED]') : text; };

const PREREGISTRATION = {
  revision: REVISION,
  question: 'Does a fresh Session first request in the same project hit the DeepSeek prompt cache written by an earlier Session first request?',
  authorization: 'Owner asked for one or two DeepSeek calls to measure this (2026-10-30).',
  design: [
    'Offline: capture the first Provider request of two fresh embedded Runtimes on byte-identical copies of the tenant-cache workspace.',
    'Rewrite Session B workspace path and eval provider id to Session A values, fail closed if any remain. Session id, scratch path and timestamps keep their real per-Session values.',
    'Record the first divergence of B from A in DeepSeek order (system, tools, messages) before any paid call.',
    'Paid: send A, wait 10 s, send B. Frozen bytes, single attempt, no retry, no fallback. DeepSeek sends no per-Session cache key, so frozen replay matches production for this route.',
  ],
  limitations: [
    'B runs in a copy, so it does not see files Session A left behind in its own workspace.',
    'One case and one provider; kimi-code and ark-coding send a per-Session cache key and are not covered.',
  ],
  limits: { providerCalls: LIMITS.calls, callsPerCell: 1, maxOutputTokens: LIMITS.output, maxTotalUsd: LIMITS.usd, requestMs: LIMITS.requestMs },
  expected: 'A cacheRead about 0: its cwd is new and DeepSeek caches system ahead of tools. B cacheRead covers system, tools and the shared part of the first message.',
  decision: 'B cacheRead / inputTokens >= 0.8 -> same-project new Sessions already reuse the cache; < 0.2 -> they do not; otherwise compare with the offline divergence point.',
  stop: 'Stop on the first error, attempt mismatch or missing usage. Never overwrite a phase output.',
};

interface Capture { directory: string; provider: string; input: FrozenInput }
async function captureFirstRequest(name: SessionName): Promise<Capture> {
  const directory = path.join(root, name);
  await fs.mkdir(directory);
  const inputs: FrozenInput[] = [];
  const record = await runNaturalRuntime(directory, CASE, async (input, _signal, index, meta) => {
    if (meta.kind !== 'root' || index > 0) throw new Error(`${name}: unexpected call ${index} (${meta.kind})`);
    inputs.push(input);
    return { textBlocks: [{ type: 'text', text: 'Capture complete.' }], toolBlocks: [], thinkingBlocks: [], stopReason: 'end_turn' };
  }, { workMode: 'coding', model: MODEL, limits: { calls: 2, tools: 1, timeoutMs: 120_000 } });
  if (record.error || inputs.length !== 1) throw new Error(`${name}: capture failed (${record.error ?? `${inputs.length} requests`})`);
  const provider = inputs[0]!.system.match(/natural-runtime-[0-9a-f-]{36}/)?.[0];
  if (!provider) throw new Error(`${name}: provider id not found`);
  return { directory, provider, input: inputs[0]! };
}

/** Rewrite B's workspace path and eval provider id to A's; fail closed if either survives. */
function alignToSession(from: Capture, to: Capture): FrozenInput {
  let text = JSON.stringify(from.input);
  for (const [a, b] of [[from.directory, to.directory], [from.provider, to.provider]] as const) {
    text = text.replaceAll(JSON.stringify(a).slice(1, -1), JSON.stringify(b).slice(1, -1));
  }
  if (text.includes(path.basename(from.directory)) || text.includes(from.provider)) throw new Error('Session B identity survived alignment');
  return JSON.parse(text) as FrozenInput;
}

/** First differing part and char in DeepSeek order (system, tools, messages). */
function firstDivergence(a: FrozenInput, b: FrozenInput) {
  const parts = ['system', 'tools', 'messages'] as const;
  const serial = (input: FrozenInput) => parts.map(part => JSON.stringify(input[part]));
  const left = serial(a), right = serial(b);
  let sharedChars = 0;
  for (const [index, part] of parts.entries()) {
    const x = left[index]!, y = right[index]!;
    if (x === y) { sharedChars += x.length; continue; }
    let at = 0;
    while (at < x.length && at < y.length && x[at] === y[at]) at++;
    return { part, char: at, sharedChars: sharedChars + at, totalChars: right.join('').length,
      a: x.slice(Math.max(0, at - 80), at + 120), b: y.slice(Math.max(0, at - 80), at + 120) };
  }
  return { part: null, char: null, sharedChars, totalChars: right.join('').length };
}

async function prepare(): Promise<void> {
  await fs.stat(path.join(root, 'preregistration.json'));
  const [a, b] = [await captureFirstRequest('session-a'), await captureFirstRequest('session-b')];
  const aligned = alignToSession(b, a);
  const divergence = firstDivergence(a.input, aligned);
  await save(path.join(root, 'session-a.input.json'), a.input);
  await save(path.join(root, 'session-b.input.json'), aligned);
  await save(path.join(root, 'divergence.json'), divergence);
  process.stdout.write(JSON.stringify(divergence, null, 2) + '\n');
}

interface ProbeRecord { session: SessionName; usage: Usage | null; error: string | null; attempts: number; wallMs: number; text: string; usd: number }
async function probe(): Promise<void> {
  if (!process.env[KEY]) throw new Error(`Missing credential for ${ROUTE}; no fallback`);
  const rate = getCostRate(ROUTE, MODEL);
  if (!rate) throw new Error(`No frozen cost rate for ${ROUTE}`);
  await fs.writeFile(path.join(root, 'probe.lock'), new Date().toISOString(), { flag: 'wx' });
  let usd = 0;
  for (const [index, session] of SESSIONS.entries()) {
    if (index > 0) await delay(LIMITS.pauseMs);
    if (index >= LIMITS.calls || usd >= LIMITS.usd) throw new Error('Probe budget exhausted');
    const input = await read<FrozenInput>(path.join(root, `${session}.input.json`));
    const facts: ProviderRequestObservation[] = [];
    const started = Date.now();
    let result: KodaXStreamResult | undefined;
    let error: string | null = null;
    try {
      const signal = AbortSignal.timeout(LIMITS.requestMs);
      result = await runWithAdditionalProviderRequestObserver(fact => facts.push(fact), () => observeProviderOperation(ROUTE, 'primary', undefined,
        () => getProvider(ROUTE).stream([...input.messages], [...input.tools], input.system, firstTurnReasoningFor(ROUTE),
          { modelOverride: MODEL, maxOutputTokensOverride: LIMITS.output, singleAttempt: true } satisfies KodaXProviderStreamOptions, signal),
        undefined, signal));
    } catch (cause) { error = redact(cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)); }
    const usage = result?.usage ?? null;
    usd += usage
      ? calculateCost(rate, usage.inputTokens, usage.outputTokens, usage.cachedReadTokens ?? 0, usage.cachedWriteTokens ?? 0)
      : calculateCost(rate, Buffer.byteLength(JSON.stringify(input)), LIMITS.output);
    const attempts = new Set(facts.filter(fact => fact.boundary === 'physical_attempt' && fact.state === 'started').map(fact => fact.requestId)).size;
    const text = redact(result?.textBlocks.map(block => block.text).join('\n') ?? '');
    const record: ProbeRecord = { session, usage, error, attempts, wallMs: Date.now() - started, text, usd };
    await save(path.join(root, `${session}.probe.json`), record);
    process.stdout.write(JSON.stringify({ session, usage, error, attempts, usd }) + '\n');
    if (error || !usage || attempts !== 1) throw new Error(`${session}: stopped (${error ?? (usage ? `${attempts} attempts` : 'missing usage')})`);
  }
}

async function analyze(): Promise<void> {
  const divergence = await read<ReturnType<typeof firstDivergence>>(path.join(root, 'divergence.json'));
  const [a, b] = await Promise.all(SESSIONS.map(session => read<ProbeRecord>(path.join(root, `${session}.probe.json`))));
  const share = (record: ProbeRecord) => record.usage ? (record.usage.cachedReadTokens ?? 0) / record.usage.inputTokens : null;
  const bShare = share(b!);
  const verdict = bShare === null ? 'invalid' : bShare >= 0.8 ? 'reused' : bShare < 0.2 ? 'not-reused' : 'partial';
  const key = process.env[KEY];
  let secretLeaks = 0;
  if (key) {
    for (const entry of await fs.readdir(root, { recursive: true, withFileTypes: true })) {
      if (entry.isFile() && (await fs.readFile(path.join(entry.parentPath, entry.name), 'utf8')).includes(key)) secretLeaks++;
    }
  }
  const analysis = {
    revision: REVISION,
    sessions: [a!, b!].map(record => ({ session: record.session, usage: record.usage, cacheShare: share(record), wallMs: record.wallMs })),
    offlineDivergence: { part: divergence.part, char: divergence.char, sharedCharShare: divergence.sharedChars / divergence.totalChars },
    verdict,
    totalUsd: b!.usd,
    secretLeaks,
  };
  await save(path.join(root, 'analysis.json'), analysis);
  process.stdout.write(JSON.stringify(analysis, null, 2) + '\n');
}

it.skipIf(!phase)('runs one registered cold-start cache probe phase', async () => {
  const relative = path.relative(os.tmpdir(), root);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Eval output must be a child of OS Temp');
  await fs.mkdir(root, { recursive: true });
  if (phase === 'register') await save(path.join(root, 'preregistration.json'), PREREGISTRATION);
  else if (phase === 'prepare') await prepare();
  else if (phase === 'probe') await probe();
  else if (phase === 'analyze') await analyze();
  else throw new Error(`Unknown phase: ${phase}`);
}, 600_000);
