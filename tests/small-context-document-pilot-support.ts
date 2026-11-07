/** Test/eval-only transport guard. Shared by the document and DOCX pilots. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { countTokens, estimateTokens } from '../packages/agent/src/tokenizer.js';
import type { KodaXBaseProvider } from '../packages/llm/src/index.js';
import type { KodaXMessage, KodaXProviderStreamOptions, KodaXStreamResult, KodaXTokenUsage, KodaXToolDefinition } from '../packages/llm/src/types.js';
import type { BudgetSnapshot } from './first-turn-eval-support.js';

export const PILOT_LIMITS = Object.freeze({ maxProviderCalls: 40, maxTotalTokens: 600_000, maxExternalSpendUsd: 5,
  applicationWindow: 65_536, maxEstimatedInputTokens: 12_000, maxOutputTokens: 2048, protocolReserve: 4096, timeoutMs: 90_000 });
export const pilotHash = (value: unknown): string => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const R3_REPLAY_CALL_IDS = Object.freeze([
  'sc-deepseek-deepseek-flash-RUNBOOK_A-reference',
  'sc-deepseek-deepseek-flash-RUNBOOK_A-g1',
  'sc-deepseek-deepseek-flash-RUNBOOK_A-s1',
  'sc-zhipu-coding-glm-5.3-flash-RUNBOOK_A-reference',
  'sc-zhipu-coding-glm-5.3-flash-RUNBOOK_A-g1',
  'sc-zhipu-coding-glm-5.3-flash-RUNBOOK_A-s1',
]);
export interface PilotRoute {
  readonly provider: string; readonly model: string;
  readonly billing: 'token-bill' | 'coding-subscription';
  /** Explicit peak liability; coding subscription has no assumed per-token bill. */
  readonly peakInputUsdPerMillion: number; readonly peakOutputUsdPerMillion: number;
}
interface Reservation { callId: string; lane: string; tokens: number; usd: number }
export interface PilotLedger extends BudgetSnapshot {
  limits: typeof PILOT_LIMITS; reservations: Reservation[]; stopped?: string;
}
export interface PilotBudget {
  readonly directory: string;
  readonly offline: boolean;
  readonly transport: typeof fetch;
  snapshot(): Promise<PilotLedger>;
  journal(event: Record<string, unknown>): Promise<void>;
  reserve(callId: string, lane: string, tokens: number, usd: number): Promise<void>;
  settle(callId: string, usage: KodaXTokenUsage | undefined, route: PilotRoute): Promise<void>;
  stop(reason: string): Promise<void>;
}

/** Main supplies the same OS-temp directory to both pilots. No second ledger is implied. */
export async function createPilotBudget(directory: string, options: { fetch?: typeof fetch; offline?: boolean } = {}): Promise<PilotBudget> {
  const root = path.resolve(directory);
  if (!root.startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('Pilot evidence must live in OS temporary storage.');
  await fs.mkdir(root, { recursive: true });
  const ledgerFile = path.join(root, 'global-budget.json');
  const initial: PilotLedger = { calls: 0, chargedTokens: 0, reservedTokens: 0, chargedUsd: 0, reservedUsd: 0,
    unknownUsageCalls: 0, limits: PILOT_LIMITS, reservations: [] };
  try { await fs.writeFile(ledgerFile, JSON.stringify(initial, null, 2), { flag: 'wx' }); }
  catch (error: unknown) {
    if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST')) throw error;
  }
  let tail = Promise.resolve();
  const locked = <T>(operation: (ledger: PilotLedger) => Promise<T>): Promise<T> => {
    const pending = tail.then(async () => {
      const deadline = Date.now() + 10_000;
      const acquire = async (): Promise<Awaited<ReturnType<typeof fs.open>>> => {
        for (;;) {
          try { return await fs.open(path.join(root, 'global-budget.lock'), 'wx'); }
          catch (error: unknown) {
            if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST')) throw error;
            if (Date.now() >= deadline) throw new Error('Shared pilot ledger lock did not become available within 10 seconds.', { cause: error });
            await delay(20);
          }
        }
      };
      const lock = await acquire();
      try {
        const ledger = JSON.parse(await fs.readFile(ledgerFile, 'utf8')) as PilotLedger;
        if (pilotHash(ledger.limits) !== pilotHash(PILOT_LIMITS)
          || ['calls', 'chargedTokens', 'reservedTokens', 'chargedUsd', 'reservedUsd', 'unknownUsageCalls']
            .some(key => !Number.isFinite(Reflect.get(ledger, key)) || Reflect.get(ledger, key) < 0)) throw new Error('Invalid shared pilot ledger.');
        const result = await operation(ledger);
        const temporary = path.join(root, 'global-budget.next.json');
        await fs.writeFile(temporary, JSON.stringify(ledger, null, 2));
        await fs.rename(temporary, ledgerFile);
        return result;
      } finally { await lock.close(); await fs.unlink(path.join(root, 'global-budget.lock')); }
    });
    tail = pending.then(() => undefined, () => undefined); // Caller still receives every failure.
    return pending;
  };
  const journal = (event: Record<string, unknown>): Promise<void> => locked(async () => {
    await fs.appendFile(path.join(root, 'journal.jsonl'), JSON.stringify({ time: new Date().toISOString(), ...event }) + '\n');
  });
  return {
    directory: root, offline: options.offline === true, transport: options.fetch ?? globalThis.fetch,
    snapshot: () => locked(async ledger => structuredClone(ledger)), journal,
    stop: reason => locked(async ledger => {
      ledger.stopped ??= reason;
      await fs.appendFile(path.join(root, 'journal.jsonl'), JSON.stringify({ event: 'stopped', reason }) + '\n');
    }),
    reserve: (callId, lane, tokens, usd) => locked(async ledger => {
      if (!Number.isSafeInteger(tokens) || tokens <= 0 || !Number.isFinite(usd) || usd < 0) throw new Error('Invalid pilot reservation.');
      if (ledger.stopped || ledger.reservations.some(item => item.lane === lane || item.callId === callId)) throw new Error('Pilot lane or ledger is fenced.');
      if (ledger.calls >= PILOT_LIMITS.maxProviderCalls
        || ledger.chargedTokens + ledger.reservedTokens + tokens > PILOT_LIMITS.maxTotalTokens
        || ledger.chargedUsd + ledger.reservedUsd + usd > PILOT_LIMITS.maxExternalSpendUsd) throw new Error('Global pilot budget exhausted before transport.');
      ledger.calls++; ledger.reservedTokens += tokens; ledger.reservedUsd += usd;
      ledger.reservations.push({ callId, lane, tokens, usd });
      await fs.appendFile(path.join(root, 'journal.jsonl'), JSON.stringify({ event: 'reserved', callId, lane, tokens, usd }) + '\n');
    }),
    settle: (callId, usage, route) => locked(async ledger => {
      const reservation = ledger.reservations.find(item => item.callId === callId);
      if (!reservation) return;
      const known = usage && Number.isSafeInteger(usage.totalTokens) && usage.totalTokens > 0
        && Number.isSafeInteger(usage.inputTokens) && usage.inputTokens >= 0
        && Number.isSafeInteger(usage.outputTokens) && usage.outputTokens >= 0
        && usage.totalTokens === usage.inputTokens + usage.outputTokens
        && usage.totalTokens <= reservation.tokens && usage.outputTokens <= PILOT_LIMITS.maxOutputTokens;
      if (!known) {
        ledger.unknownUsageCalls++; ledger.stopped = 'Usage unavailable: reservation retained; efficiency/cost comparison unverified.';
      } else {
        ledger.reservedTokens -= reservation.tokens; ledger.reservedUsd = Math.max(0, ledger.reservedUsd - reservation.usd);
        ledger.chargedTokens += usage.totalTokens;
        ledger.chargedUsd += route.billing === 'coding-subscription' ? 0
          : (usage.inputTokens * route.peakInputUsdPerMillion + usage.outputTokens * route.peakOutputUsdPerMillion) / 1_000_000;
        ledger.reservations = ledger.reservations.filter(item => item !== reservation);
        if (usage.outputTokens > PILOT_LIMITS.maxOutputTokens || ledger.chargedTokens + ledger.reservedTokens > PILOT_LIMITS.maxTotalTokens
          || ledger.chargedUsd + ledger.reservedUsd > PILOT_LIMITS.maxExternalSpendUsd) ledger.stopped = 'Provider usage exceeded the reserved hard budget.';
      }
      await fs.appendFile(path.join(root, 'journal.jsonl'), JSON.stringify({ event: 'settled', callId, usage: usage ?? null,
        billing: route.billing, ledger, costComparisonVerified: Boolean(known) && route.billing === 'token-bill' }) + '\n');
    }),
  };
}

export function estimatedPilotInput(messages: readonly KodaXMessage[], tools: readonly KodaXToolDefinition[], system: string,
  options?: KodaXProviderStreamOptions): number {
  return estimateTokens(messages) + countTokens(system) + countTokens(JSON.stringify(tools))
    + (options?.ephemeralSuffix ? countTokens(options.ephemeralSuffix.content) : 0);
}

export function inspectPilotWire(wire: string): { wireBytes: number; reservedTokens: number; wireHash: string } {
  const body = JSON.parse(wire) as Record<string, unknown>;
  const caps = [body.max_tokens, body.max_completion_tokens, body.max_output_tokens].filter(value => value !== undefined);
  if (!caps.length || caps.some(value => typeof value !== 'number' || value <= 0 || value > PILOT_LIMITS.maxOutputTokens)) throw new Error('Adapter did not enforce the inclusive 2048 output cap.');
  const wireBytes = Buffer.byteLength(wire, 'utf8');
  const reservedTokens = wireBytes + PILOT_LIMITS.maxOutputTokens + PILOT_LIMITS.protocolReserve;
  if (reservedTokens > PILOT_LIMITS.applicationWindow) throw new Error('Actual wire byte upper bound exceeds the 64K application budget before transport.');
  return { wireBytes, reservedTokens, wireHash: pilotHash(wire) };
}

/** Offline only: actual adapter serialization, first injected fetch stops before any network I/O. */
export async function capturePilotWire(provider: KodaXBaseProvider, route: PilotRoute,
  input: { messages: KodaXMessage[]; tools: KodaXToolDefinition[]; system: string }) {
  if (estimatedPilotInput(input.messages, input.tools, input.system) > PILOT_LIMITS.maxEstimatedInputTokens) throw new Error('Estimated input exceeds the separately labelled 12000-token pilot bound.');
  let wire: string | undefined;
  let attempted = 0;
  const stop = new Error('Offline pilot wire captured: transport intentionally not dispatched.');
  try {
    await provider.stream(input.messages, input.tools, input.system, { enabled: false, effort: 'none' }, {
      modelOverride: route.model, maxOutputTokensOverride: PILOT_LIMITS.maxOutputTokens, singleAttempt: true,
      fetch: async (_url, init) => {
        attempted++;
        if (typeof init?.body !== 'string') throw new Error('Adapter did not serialize a JSON string.');
        wire = init.body;
        throw stop;
      },
    }, AbortSignal.timeout(PILOT_LIMITS.timeoutMs));
  } catch (error: unknown) { if (wire === undefined) throw error; }
  if (attempted !== 1 || wire === undefined) throw new Error('Expected one offline serializer capture and no retry.');
  return { wire, ...inspectPilotWire(wire) };
}

/** Strict boundary before production strips wrappers; malformed summaries never enter later rounds. */
export function assertCompletePilotSummary(result: KodaXStreamResult): void {
  if (result.stopReason === 'max_tokens' || result.stopReason === 'length' || result.toolBlocks.length) throw new Error('Censored or tool-bearing summary is not injectable.');
  // Production generateSummary/compact owns analysis stripping, usable-body checks and reinsertion.
  // Closing-wrapper omissions are recorded below, not promoted into a stricter eval-only gate.
}

/** Wrap the actual adapter, preserving native serialization and production summary generation. */
export function createBudgetedProvider(provider: KodaXBaseProvider, route: PilotRoute, budget: PilotBudget,
  context: { callId: string; summary?: boolean; manifestHash?: string; manifestFile?: 'frozen-candidate.r3.json'; replayR2?: boolean }): KodaXBaseProvider {
  if (!/^[a-zA-Z0-9_.-]+$/.test(context.callId)) throw new Error('Unsafe pilot call identity.');
  let started = false;
  return new Proxy(provider, { get(target, key) {
    if (key === 'getEffectiveContextWindow') return () => PILOT_LIMITS.applicationWindow;
    if (key === 'getEffectiveMaxOutputTokens') return () => PILOT_LIMITS.maxOutputTokens;
    if (key === 'complete') return () => { throw new Error('Pilot permits only its registered stream calls.'); };
    if (key === 'stream') return async (...args: Parameters<KodaXBaseProvider['stream']>): Promise<KodaXStreamResult> => {
      if (started) throw new Error('A pilot call cannot be retried.');
      started = true;
      if (estimatedPilotInput(args[0], args[1], args[2], args[4]) > PILOT_LIMITS.maxEstimatedInputTokens) throw new Error('Estimated input exceeds the separately labelled 12000-token pilot bound.');
      if (!budget.offline) {
        const freeze = JSON.parse(await fs.readFile(path.join(budget.directory, context.manifestFile ?? 'frozen-candidate.json'), 'utf8')) as { manifestHash?: string };
        if (!context.manifestHash || freeze.manifestHash !== context.manifestHash) throw new Error('Main-session frozen candidate manifest required before live transport.');
      }
      const signal = AbortSignal.any([AbortSignal.timeout(PILOT_LIMITS.timeoutMs), ...(args[5] ? [args[5]] : [])]);
      let transports = 0;
      let reserved = false;
      let physical = false;
      let replayed = false;
      let guardFailure: unknown;
      const guardedFetch: typeof fetch = async (url, init) => {
        try {
        if (transports++) throw new Error('Automatic retry blocked before HTTP transport.');
        if (typeof init?.body !== 'string') throw new Error('Pilot requires the exact serialized JSON request body.');
        const wire = init.body;
        const { wireBytes, reservedTokens } = inspectPilotWire(wire);
        if (context.replayR2 && R3_REPLAY_CALL_IDS.includes(context.callId)) {
          const oldWire = await fs.readFile(path.join(budget.directory, `${context.callId}.request.json`), 'utf8');
          if (wire !== oldWire) throw new Error('Replay wire differs from its settled r2 request; fresh transport is forbidden.');
          const events = (await fs.readFile(path.join(budget.directory, 'journal.jsonl'), 'utf8')).split('\n').filter(Boolean)
            .map(line => JSON.parse(line) as Record<string, unknown>).filter(event => event.callId === context.callId);
          const request = events.find(event => event.event === 'request');
          const response = events.find(event => event.event === 'response');
          const originalReservation = events.find(event => event.event === 'reserved');
          const settled = events.find(event => event.event === 'settled');
          const oldUsage = settled?.usage as KodaXTokenUsage | undefined;
          const settledLedger = settled?.ledger as PilotLedger | undefined;
          const currentLedger = await budget.snapshot();
          const saved = await fs.readFile(path.join(budget.directory, `${context.callId}.response.txt`), 'utf8');
          if (request?.wireHash !== pilotHash(wire) || response?.status !== 200 || response.responseHash !== pilotHash(saved)
            || !/^data:/m.test(saved) || !oldUsage || !Number.isSafeInteger(oldUsage.totalTokens)
            || !Number.isSafeInteger(oldUsage.inputTokens) || !Number.isSafeInteger(oldUsage.outputTokens)
            || oldUsage.inputTokens < 0 || oldUsage.outputTokens < 0 || oldUsage.totalTokens <= 0
            || oldUsage.totalTokens !== oldUsage.inputTokens + oldUsage.outputTokens
            || typeof originalReservation?.tokens !== 'number' || !Number.isSafeInteger(originalReservation.tokens)
            || originalReservation.tokens !== reservedTokens || oldUsage.totalTokens > originalReservation.tokens || oldUsage.outputTokens > PILOT_LIMITS.maxOutputTokens
            || !settledLedger || settledLedger.unknownUsageCalls !== 0 || !Array.isArray(settledLedger.reservations)
            || settledLedger.chargedTokens < oldUsage.totalTokens
            || settledLedger.reservations.some(item => item.callId === context.callId)
            || currentLedger.unknownUsageCalls !== 0 || currentLedger.reservations.some(item => R3_REPLAY_CALL_IDS.includes(item.callId))) {
            throw new Error('Replay requires intact 200 SSE and genuinely settled credible usage, with no retained r2 reservation.');
          }
          replayed = true;
          await budget.journal({ event: 'replayed', callId: context.callId, physical: false, requestHash: pilotHash(wire),
            responseHash: pilotHash(saved), originalUsage: oldUsage, newCharges: 0, revision: 'r3' });
          return new Response(saved, { status: 200, headers: { 'content-type': 'text/event-stream' } });
        }
        const usd = route.billing === 'coding-subscription' ? 0
          : ((wireBytes + PILOT_LIMITS.protocolReserve) * route.peakInputUsdPerMillion
            + PILOT_LIMITS.maxOutputTokens * route.peakOutputUsdPerMillion) / 1_000_000;
        await budget.reserve(context.callId, `${route.provider}/${route.model}`, reservedTokens, usd);
        reserved = true;
        await fs.writeFile(path.join(budget.directory, `${context.callId}.request.json`), wire, { flag: 'wx' });
        await budget.journal({ event: 'request', callId: context.callId, url: String(url), wireBytes, wireHash: pilotHash(wire),
          estimatedInputTokens: estimatedPilotInput(args[0], args[1], args[2], args[4]), reservedTokens, usd });
        physical = true;
        const response = await budget.transport(url, { ...init, signal: AbortSignal.any([signal, ...(init.signal ? [init.signal] : [])]) });
        const rawResponse = await response.clone().text();
        await fs.writeFile(path.join(budget.directory, `${context.callId}.response.txt`), rawResponse, { flag: 'wx' });
        await budget.journal({ event: 'response', callId: context.callId, status: response.status,
          responseHash: pilotHash(rawResponse), responseBytes: Buffer.byteLength(rawResponse) });
        return response;
        } catch (error: unknown) {
          if (!physical) {
            guardFailure = error;
            await budget.journal({ event: 'transport-refused', callId: context.callId, physical: false,
              reason: error instanceof Error ? error.message : String(error) });
          }
          throw error;
        }
      };
      let result: KodaXStreamResult | undefined;
      let failure: unknown;
      try {
        result = await target.stream(args[0], args[1], args[2], args[3], { ...args[4], modelOverride: route.model,
          maxOutputTokensOverride: PILOT_LIMITS.maxOutputTokens, singleAttempt: true, fetch: guardedFetch }, signal);
        if (transports !== 1) throw new Error('Expected exactly one guarded provider HTTP request.');
        if (context.summary) assertCompletePilotSummary(result);
        return result;
      } catch (error: unknown) { failure = guardFailure ?? error; throw failure; }
      finally {
        if (reserved) await budget.settle(context.callId, result?.usage, route);
        await budget.journal({ event: 'provider-result', callId: context.callId, result: result ?? null,
          physical, replayed,
          ...(context.summary && result ? { summaryFormat: {
            openingTags: (result.textBlocks.map(block => block.text).join('\n').match(/<summary>/gi) ?? []).length,
            closingTags: (result.textBlocks.map(block => block.text).join('\n').match(/<\/summary>/gi) ?? []).length,
            acceptance: 'Production generateSummary/compact decides usable content; tags alone do not decide acceptance.',
          } } : {}),
          error: failure instanceof Error ? { name: failure.name, message: failure.message } : failure === undefined ? null : String(failure) });
        if (failure !== undefined) await budget.stop(`Call ${context.callId} failed; inspect its immutable evidence before a new revision.`);
      }
    };
    const value: unknown = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}
