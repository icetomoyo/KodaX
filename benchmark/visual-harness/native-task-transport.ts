/** Benchmark-only native Messages recorder. Never stores credential headers. */
import { createHash } from 'node:crypto';
import { appendFile, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertTaskDumpDirectory } from './task-transport.js';

export interface NativeTaskRates {
  inputUsdPerMillion: number; cacheReadUsdPerMillion: number; cacheWriteUsdPerMillion: number;
  outputUsdPerMillion: number; source: string;
}
export interface NativeTaskTransportInput {
  directory: string; cell: string; provider: 'deepseek' | 'kimi-code'; model: string;
  maxCallsPerCell: number; maxTotalCalls: number; maxCellTokens: number; maxTotalTokens: number;
  maxOutputTokens: number; timeoutMs: number; maxSpendUsd: number;
  maxMetadataRequests?: number;
  /** Explicit r5 policy: isolate bounded generation failures; never retry a failed cell. */
  failurePolicy?: 'r5-cell-isolated';
  rates?: NativeTaskRates;
  /** External hard cap established before this run, e.g. disabled subscription overage. */
  spendControl?: { preflightEvidence: string; maxAdditionalSpendUsd: number };
  /** Kimi observation stop, potentially delayed; not a guarantee of a hard financial ceiling.
   * Reader uses the original fetch with the supplied signal and retains raw account evidence itself. */
  spendObservation?: { preflightEvidence: string;
    read: (signal: AbortSignal) => Promise<{ currency: 'CNY'; priceInCents: number; configurationHash: string }> };
  fetcher?: typeof fetch; onStop?: (reason: Error) => void;
}
export interface NativeUsage {
  inputTokens: number; outputTokens: number; totalTokens: number; cachedReadTokens: number; cachedWriteTokens: number;
}
interface NativeReservation {
  inputTokens: number; cachedReadTokens: number; cachedWriteTokens: number; maxOutputTokens: number;
  totalTokens: number; spendUsd: number | null; evidence: string;
}
/** Only the two production optional judges' documented failures may bypass cell.stop. */
export class NativeRecoverableAuxiliaryError extends Error {
  override name = 'NativeRecoverableAuxiliaryError';
  toolName?: 'report_stall_judgment' | 'commit_episode_learning_review';
  requestSha256?: string;
}
export interface NativeTaskLedger {
  provider: string; model: string; policyHash: string; calls: number; accountedCalls: number; metadata: number;
  tokens: number; spendUsd: number | null; stopped: boolean; stopReason?: string;
  initialWalletCents?: number; lastWalletCents?: number; walletConfigurationHash?: string;
  observedSpendCny?: number; observedSpendConservativeUsd?: number;
  cleanupErrors?: string[];
  /** Conservative bounds for missing final usage, excluded from actual tokens/spendUsd. */
  reservedTokens?: number; reservedSpendUsd?: number;
  cells: Record<string, { calls: number; tokens: number; accountedCalls: number; stopped?: boolean; stopReason?: string;
    reservation?: NativeReservation; reservations?: NativeReservation[];
    auxiliaryFailures?: { requestSha256: string; evidence: string; error: string; dispatched?: boolean }[] }>;
}
class CellFailure extends Error {
  partial?: { raw: string; evidence: string; maxOutputTokens: number };
}
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** SDK fetch/ReadableStream implementations are not necessarily cooperative with AbortSignal. */
async function raceAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try { return await Promise.race([operation, aborted]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

export function parseNativeResponseEvents(raw: string, streaming: boolean): Record<string, unknown>[] {
  return streaming
    ? raw.replace(/\r\n/g, '\n').split('\n\n').filter(frame => frame.split('\n').some(line => line.startsWith('data:'))).map(frame => {
      const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      const value: unknown = JSON.parse(data); if (!record(value)) throw new Error('Invalid native SSE event.'); return value;
    }) : [JSON.parse(raw) as Record<string, unknown>];
}

function readUsage(events: readonly Record<string, unknown>[], streaming: boolean): { usage: NativeUsage; model: string; stopReason: string } {
  let input: number | undefined; let output: number | undefined; let read = 0; let write = 0;
  let complete = !streaming; let terminalOutput = !streaming; let model = ''; let stopReason = '';
  for (const event of events) {
    if (event.type === 'error') throw new Error('Provider SSE error; see saved raw response.');
    if (event.type === 'message_stop') complete = true;
    const message = event.type === 'message_start' && record(event.message) ? event.message : event;
    if (typeof message.model === 'string') model = message.model;
    const delta = record(event.delta) ? event.delta : message;
    if (typeof delta.stop_reason === 'string') stopReason = delta.stop_reason;
    if (!record(message.usage)) continue;
    const usage = message.usage;
    for (const field of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
      if (usage[field] !== undefined && !count(usage[field])) throw new Error(`Invalid native usage field ${field}.`);
    }
    if (count(usage.input_tokens)) input = usage.input_tokens;
    if (count(usage.cache_read_input_tokens)) read = usage.cache_read_input_tokens;
    if (count(usage.cache_creation_input_tokens)) write = usage.cache_creation_input_tokens;
    if (count(usage.output_tokens)) {
      if (output !== undefined && usage.output_tokens < output) throw new Error('Native cumulative output usage decreased.');
      output = usage.output_tokens;
      if (event.type === 'message_delta' && typeof delta.stop_reason === 'string') terminalOutput = true;
    }
  }
  if (!complete) throw new Error('Incomplete native SSE; final usage unavailable.');
  if (input === undefined || output === undefined || !terminalOutput || !model || !stopReason) throw new Error('Native terminal usage/model/stop reason missing.');
  const inputTokens = input + read + write;
  if (!count(inputTokens + output)) throw new Error('Native usage total invalid.');
  return { usage: { inputTokens, outputTokens: output, totalTokens: inputTokens + output, cachedReadTokens: read, cachedWriteTokens: write }, model, stopReason };
}

/** Reject cases the production SDK/adapter would otherwise repair with another generation. */
function assertNoResponseRepair(events: readonly Record<string, unknown>[], request: Record<string, unknown>): void {
  let text = '';
  const calls: { block: Record<string, unknown>; partialJson?: string }[] = [];
  const streamedCalls = new Map<number, (typeof calls)[number]>();
  const acceptBlock = (block: unknown, index?: number) => {
    if (!record(block)) return;
    if (block.type === 'text' && typeof block.text === 'string') text += block.text;
    if (block.type === 'tool_use') {
      const call = { block }; calls.push(call);
      if (index !== undefined) streamedCalls.set(index, call);
    }
  };
  for (const event of events) {
    if (Array.isArray(event.content)) event.content.forEach(block => acceptBlock(block));
    if (event.type === 'content_block_start') acceptBlock(event.content_block, typeof event.index === 'number' ? event.index : undefined);
    if (event.type !== 'content_block_delta' || !record(event.delta)) continue;
    if (event.delta.type === 'text_delta' && typeof event.delta.text === 'string') text += event.delta.text;
    if (event.delta.type === 'input_json_delta') {
      const call = typeof event.index === 'number' ? streamedCalls.get(event.index) : undefined;
      if (!call || typeof event.delta.partial_json !== 'string') throw new Error('Malformed native tool input delta; repair is disabled.');
      call.partialJson = (call.partialJson ?? '') + event.delta.partial_json;
    }
  }
  for (const call of calls) {
    let args: unknown = call.block.input;
    if (call.partialJson !== undefined) {
      try { args = JSON.parse(call.partialJson) as unknown; }
      catch { throw new Error('Malformed native tool input JSON; repair is disabled.'); }
    }
    if (!record(args) || typeof call.block.name !== 'string' || !call.block.name || typeof call.block.id !== 'string' || !call.block.id) {
      throw new Error('Malformed native tool input/identity; repair is disabled.');
    }
    const definition = Array.isArray(request.tools) ? request.tools.find(tool => record(tool) && tool.name === call.block.name) : undefined;
    const required: unknown = record(definition) && record(definition.input_schema) ? definition.input_schema.required : undefined;
    if (Array.isArray(required) && required.some(field => typeof field === 'string' && !Object.hasOwn(args, field))) {
      throw new Error('Malformed native tool input lacks a required field; repair is disabled.');
    }
  }
  if (!text.trim() && calls.length === 0) throw new Error('Empty native completion; automatic empty-turn retry is disabled.');
}

export async function createNativeTaskTransport(input: NativeTaskTransportInput) {
  const directory = await assertTaskDumpDirectory(input.directory);
  const maxMetadataRequests = input.maxMetadataRequests ?? 80;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(input.cell)
    || !((input.provider === 'deepseek' && input.model === 'deepseek-flash') || (input.provider === 'kimi-code' && input.model === 'kimi-for-coding'))
    || ![input.maxCallsPerCell, input.maxTotalCalls, input.maxCellTokens, input.maxTotalTokens, input.maxOutputTokens, input.timeoutMs].every(value => count(value) && value > 0)
    || !count(maxMetadataRequests) || maxMetadataRequests < 2
    || (input.failurePolicy !== undefined && input.failurePolicy !== 'r5-cell-isolated')
    || !Number.isFinite(input.maxSpendUsd) || input.maxSpendUsd <= 0) throw new Error('Invalid frozen native transport limits.');
  if (input.rates && (!input.rates.source.trim() || ![input.rates.inputUsdPerMillion, input.rates.cacheReadUsdPerMillion,
    input.rates.cacheWriteUsdPerMillion, input.rates.outputUsdPerMillion].every(value => Number.isFinite(value) && value >= 0))) throw new Error('Verified rates required.');
  const lockPath = path.join(directory, 'native-provider.lock');
  const lock = await open(lockPath, 'wx');
  let released = false;
  const release = async () => { if (!released) { await lock.close(); await unlink(lockPath); released = true; } };
  try {
    const policy = { provider: input.provider, model: input.model, maxTotalCalls: input.maxTotalCalls, maxTotalTokens: input.maxTotalTokens,
      maxOutputTokens: input.maxOutputTokens, maxMetadataRequests, maxSpendUsd: input.maxSpendUsd, rates: input.rates ?? null, spendControl: input.spendControl ?? null,
      spendObservation: input.spendObservation ? { preflightEvidence: input.spendObservation.preflightEvidence,
        conservativeUsdPerCny: 1, accounting: 'observed-stop-not-a-hard-cap' } : null,
      ...(input.failurePolicy ? { failurePolicy: input.failurePolicy } : {}) };
    const policyHash = digest(JSON.stringify(policy));
    const ledgerPath = path.join(directory, 'native-ledger.json');
    let ledger: NativeTaskLedger;
    try { ledger = JSON.parse(await readFile(ledgerPath, 'utf8')) as NativeTaskLedger; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      ledger = { provider: input.provider, model: input.model, policyHash, calls: 0, accountedCalls: 0, metadata: 0,
        tokens: 0, spendUsd: input.rates ? 0 : null, stopped: false, cells: {} };
    }
    if (ledger.policyHash !== policyHash) throw new Error('Frozen provider/budget/billing policy changed.');
    if (ledger.stopped) throw new Error(ledger.stopReason ?? 'Native provider ledger already stopped.');
    await writeFile(path.join(directory, `${input.cell}.native-started.json`), JSON.stringify({ at: new Date().toISOString(), policy,
      maxCallsPerCell: input.maxCallsPerCell, maxCellTokens: input.maxCellTokens, timeoutMs: input.timeoutMs }), { flag: 'wx' });
    const cell = ledger.cells[input.cell] ??= { calls: 0, tokens: 0, accountedCalls: 0 };
    const save = async () => { await writeFile(`${ledgerPath}.pending`, JSON.stringify(ledger, null, 2)); await rename(`${ledgerPath}.pending`, ledgerPath); };
    await save();
    const fetcher = input.fetcher ?? globalThis.fetch;
    const base = input.provider === 'kimi-code' ? 'https://api.kimi.com/coding/v1/' : 'https://api.deepseek.com/anthropic/v1/';
    let closed = false; let notified = false;
    let queue: Promise<void> = Promise.resolve();
    const fail = async (cause: unknown): Promise<never> => {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      if (input.failurePolicy === 'r5-cell-isolated' && error instanceof CellFailure) {
        cell.stopped = true; cell.stopReason ??= error.message;
      } else { ledger.stopped = true; ledger.stopReason ??= error.message; }
      const failures: unknown[] = [error];
      if (!notified) { notified = true; try { input.onStop?.(error); } catch (notifyError) { failures.push(notifyError); } }
      try { await save(); } catch (saveError) { failures.push(saveError); }
      if (failures.length > 1) throw new AggregateError(failures, 'Native request and failure settlement failed.');
      throw error;
    };
    const observeSpend = async (signal: AbortSignal) => {
      if (!input.spendObservation) return;
      if (input.provider !== 'kimi-code' || !input.spendObservation.preflightEvidence.trim()) throw new Error('Kimi spend observation preflight required.');
      if (ledger.metadata >= maxMetadataRequests) throw new Error('Metadata budget exhausted.');
      ledger.metadata++; await save();
      const observationSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.min(15000, input.timeoutMs))]);
      observationSignal.throwIfAborted();
      const value = await raceAbort(input.spendObservation.read(observationSignal), observationSignal);
      await writeFile(path.join(directory, `${input.cell}-wallet-${ledger.metadata}.json`), JSON.stringify(value), { flag: 'wx' });
      if (value.currency !== 'CNY' || !count(value.priceInCents) || !value.configurationHash?.trim()) throw new Error('Kimi spend observation missing/invalid.');
      if (ledger.walletConfigurationHash !== undefined && ledger.walletConfigurationHash !== value.configurationHash) throw new Error('Kimi account configuration changed.');
      if (value.priceInCents < (ledger.lastWalletCents ?? 0)) throw new Error('Kimi spend counter decreased/reset.');
      ledger.initialWalletCents ??= value.priceInCents;
      ledger.lastWalletCents = value.priceInCents;
      ledger.walletConfigurationHash = value.configurationHash;
      ledger.observedSpendCny = (value.priceInCents - ledger.initialWalletCents) / 100;
      ledger.observedSpendConservativeUsd = ledger.observedSpendCny;
      await save();
      if (ledger.observedSpendConservativeUsd >= input.maxSpendUsd) throw new Error('Observed spend stop reached; observation may lag actual charges.');
    };
    const boundedFailure = (cause: unknown, raw: string, evidence: string, maxOutputTokens: number): CellFailure => {
      const error = new CellFailure(cause instanceof Error ? cause.message : String(cause), { cause });
      error.partial = { raw, evidence, maxOutputTokens }; return error;
    };
    const accountUsage = (usage: NativeUsage) => {
      ledger.tokens += usage.totalTokens; cell.tokens += usage.totalTokens; ledger.accountedCalls++; cell.accountedCalls++;
      if (input.rates && ledger.spendUsd !== null) {
        const uncached = usage.inputTokens - usage.cachedReadTokens - usage.cachedWriteTokens;
        ledger.spendUsd += (uncached * input.rates.inputUsdPerMillion + usage.cachedReadTokens * input.rates.cacheReadUsdPerMillion
          + usage.cachedWriteTokens * input.rates.cacheWriteUsdPerMillion + usage.outputTokens * input.rates.outputUsdPerMillion) / 1000000;
      }
    };
    const settleFailedUsage = async (partial: NonNullable<CellFailure['partial']>) => {
      // Only fully received SSE frames can establish the input bound. Never guess from request bytes.
      const raw = partial.raw.replace(/\r\n/g, '\n');
      const events = parseNativeResponseEvents(raw.slice(0, raw.lastIndexOf('\n\n') + 2), true);
      if (events.some(event => event.type === 'message_stop')) {
        const parsed = readUsage(events, true);
        accountUsage(parsed.usage);
        const evidencePath = path.join(directory, partial.evidence);
        const evidence: unknown = JSON.parse(await readFile(evidencePath, 'utf8'));
        if (!record(evidence)) throw new Error('Native request evidence is invalid.');
        await writeFile(evidencePath, JSON.stringify({ ...evidence, ...parsed, requestedModel: input.model }));
      } else {
        const starts = events.filter(event => event.type === 'message_start');
        const message = starts.length === 1 && record(starts[0]?.message) ? starts[0].message : undefined;
        const usage = message && record(message.usage) ? message.usage : undefined;
        if (!usage || message?.model !== input.model || !count(usage.input_tokens)
          || !count(usage.cache_read_input_tokens) || !count(usage.cache_creation_input_tokens)
          || events.some(event => record(event.usage) && count(event.usage.output_tokens) && event.usage.output_tokens > partial.maxOutputTokens)) {
          throw new Error('Missing final usage cannot be bounded by a complete native message_start; provider stopped.');
        }
        const inputTokens = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens;
        const totalTokens = inputTokens + partial.maxOutputTokens;
        if (!count(totalTokens)) throw new Error('Native missing-usage reservation is invalid.');
        const spendUsd = input.rates ? (usage.input_tokens * input.rates.inputUsdPerMillion
          + usage.cache_read_input_tokens * input.rates.cacheReadUsdPerMillion
          + usage.cache_creation_input_tokens * input.rates.cacheWriteUsdPerMillion
          + partial.maxOutputTokens * input.rates.outputUsdPerMillion) / 1000000 : null;
        cell.reservation = { inputTokens, cachedReadTokens: usage.cache_read_input_tokens, cachedWriteTokens: usage.cache_creation_input_tokens,
          maxOutputTokens: partial.maxOutputTokens, totalTokens, spendUsd, evidence: partial.evidence };
        (cell.reservations ??= []).push(cell.reservation);
        ledger.reservedTokens = (ledger.reservedTokens ?? 0) + totalTokens;
        if (spendUsd !== null) ledger.reservedSpendUsd = (ledger.reservedSpendUsd ?? 0) + spendUsd;
      }
      await save();
      // The generation deadline may be aborted. A fresh bounded wallet read must succeed before isolation.
      await observeSpend(new AbortController().signal);
      if (ledger.tokens + (ledger.reservedTokens ?? 0) >= input.maxTotalTokens) throw new Error('Token budget reached including missing-usage reservations.');
      if (ledger.spendUsd !== null && ledger.spendUsd + (ledger.reservedSpendUsd ?? 0) >= input.maxSpendUsd) throw new Error('Spend budget reached including missing-usage reservations.');
      if (cell.tokens + (cell.reservations ?? []).reduce((sum, reservation) => sum + reservation.totalTokens, 0) >= input.maxCellTokens) {
        throw new CellFailure('Token budget reached for cell including missing-usage reservations.');
      }
    };
    const execute: typeof fetch = async (source, init) => {
      if (closed) throw new Error('Native transport is closed.');
      if (ledger.stopped) throw new Error(ledger.stopReason);
      if (cell.stopped) throw new Error(cell.stopReason);
      let recoverableAuxiliaryRequestHash: string | undefined;
      let optionalToolName: NativeRecoverableAuxiliaryError['toolName'];
      let accountedAuxiliaryEvidence: string | undefined;
      let sentMaxOutputTokens = input.maxOutputTokens;
      const auxiliaryError = (message: string, cause?: unknown) => {
        const error = new NativeRecoverableAuxiliaryError(message, { cause });
        error.toolName = optionalToolName; error.requestSha256 = recoverableAuxiliaryRequestHash; return error;
      };
      const recoverAuxiliary = async (error: Error, evidence: string): Promise<never> => {
        (cell.auxiliaryFailures ??= []).push({ requestSha256: recoverableAuxiliaryRequestHash!, evidence, error: error.message, dispatched: true });
        try { await save(); } catch (saveError) { return fail(saveError); }
        throw auxiliaryError(error.message, error);
      };
      try {
        const request = new Request(source, init);
        const url = new URL(request.url);
        const endpoint = `${url.origin}${url.pathname}`;
        const generation = endpoint === `${base}messages` && request.method === 'POST';
        const metadata = (endpoint === `${base}models` && request.method === 'GET')
          || (endpoint === `${base}messages/count_tokens` && request.method === 'POST');
        if ((!generation && !metadata) || url.username || url.password || [...url.searchParams.keys()].some(key => key !== 'beta')) {
          throw new Error('Unregistered native HTTP route.');
        }
        const original = request.method === 'POST' ? await request.text() : '';
        let body = original;
        if (generation) {
          if (ledger.calls >= input.maxTotalCalls) throw new Error('Call budget exhausted.');
          if (cell.calls >= input.maxCallsPerCell) throw new CellFailure('Call budget exhausted for cell.');
          if (ledger.tokens + (ledger.reservedTokens ?? 0) >= input.maxTotalTokens) throw new Error('Token budget exhausted.');
          if (cell.tokens >= input.maxCellTokens) throw new CellFailure('Token budget exhausted for cell.');
          const parsed: unknown = JSON.parse(original);
          if (!record(parsed) || parsed.model !== input.model || !Array.isArray(parsed.messages)) throw new Error('Frozen native model/messages mismatch.');
          if (input.failurePolicy === 'r5-cell-isolated') {
            if (!count(parsed.max_tokens) || parsed.max_tokens === 0) throw new Error('Native production output limit is invalid.');
            sentMaxOutputTokens = Math.min(parsed.max_tokens, input.maxOutputTokens);
          }
          body = JSON.stringify({ ...parsed, max_tokens: sentMaxOutputTokens });
          if (input.failurePolicy === 'r5-cell-isolated' && Array.isArray(parsed.tools) && parsed.tools.length === 1
            && record(parsed.tools[0]) && (parsed.tools[0].name === 'report_stall_judgment' || parsed.tools[0].name === 'commit_episode_learning_review')) {
            optionalToolName = parsed.tools[0].name;
            recoverableAuxiliaryRequestHash = digest(body);
            if (cell.auxiliaryFailures?.some(failure => failure.requestSha256 === recoverableAuxiliaryRequestHash)) {
              throw auxiliaryError('Failed optional consultation cannot be retried.');
            }
          }
          if (request.signal.aborted && optionalToolName === 'report_stall_judgment' && recoverableAuxiliaryRequestHash && request.signal.reason instanceof Error
            && ['AbortError', 'TimeoutError'].includes(request.signal.reason.name)) {
            const evidence = `${input.cell}-auxiliary-before-dispatch-${(cell.auxiliaryFailures?.length ?? 0) + 1}.json`;
            const failure = { requestSha256: recoverableAuxiliaryRequestHash, evidence, error: request.signal.reason.message, dispatched: false };
            await writeFile(path.join(directory, evidence), JSON.stringify({ ...failure, at: new Date().toISOString(), request: JSON.parse(body) }), { flag: 'wx' });
            (cell.auxiliaryFailures ??= []).push(failure); await save();
            throw auxiliaryError(failure.error, request.signal.reason);
          }
          if (request.signal.aborted) throw request.signal.reason;
          if (input.rates) {
            // Provider context ceiling, not remaining cell tokens: a single request can overshoot a cell stop.
            // These are the two frozen production routes; no local token estimate is presented as actual usage.
            const maximumInputRate = Math.max(input.rates.inputUsdPerMillion, input.rates.cacheReadUsdPerMillion, input.rates.cacheWriteUsdPerMillion);
            const contextCeiling = input.provider === 'deepseek' ? 1000000 : 262144;
            const reserve = (contextCeiling * maximumInputRate + input.maxOutputTokens * input.rates.outputUsdPerMillion) / 1000000;
            if ((ledger.spendUsd ?? 0) + (ledger.reservedSpendUsd ?? 0) + reserve > input.maxSpendUsd) throw new Error('Spend budget cannot cover the next request.');
          } else if (!input.spendObservation && (!input.spendControl?.preflightEvidence.trim() || !Number.isFinite(input.spendControl.maxAdditionalSpendUsd)
            || input.spendControl.maxAdditionalSpendUsd < 0 || input.spendControl.maxAdditionalSpendUsd > input.maxSpendUsd)) {
            throw new Error('Spend control unavailable; unknown fees cannot be assumed zero.');
          }
          if (input.spendObservation) {
            if (ledger.metadata > maxMetadataRequests - 2) throw new Error('Metadata budget cannot cover pre/post spend observations.');
            await observeSpend(request.signal);
          }
        } else if (ledger.metadata >= maxMetadataRequests) throw new Error('Metadata budget exhausted.');
        if (request.signal.aborted) throw request.signal.reason;
        const stem = generation ? `${input.cell}-${cell.calls + 1}` : `${input.cell}-metadata-${ledger.metadata + 1}`;
        await writeFile(path.join(directory, `${stem}.production.json`), original || '{}', { flag: 'wx' });
        await writeFile(path.join(directory, `${stem}.request.json`), body || '{}', { flag: 'wx' });
        const responsePath = path.join(directory, `${stem}.response.txt`);
        await writeFile(responsePath, '', { flag: 'wx' });
        if (generation) { ledger.calls++; cell.calls++; } else ledger.metadata++;
        await save();
        const started = Date.now();
        const signal = AbortSignal.any([request.signal, AbortSignal.timeout(input.timeoutMs)]);
        const headers = new Headers(request.headers); headers.delete('content-length');
        const cancelWithoutWaiting = (cancellation: Promise<void>) => {
          // A stream's cancel hook may itself never settle. It cannot keep the provider queue open.
          void cancellation.catch(error => { (ledger.cleanupErrors ??= []).push(error instanceof Error ? error.message : String(error)); });
        };
        let response: Response | undefined;
        try {
          signal.throwIfAborted();
          const fetching = fetcher(request.url, { method: request.method, headers, body: request.method === 'POST' ? body : undefined,
            redirect: 'error', signal }).then(value => {
            if (signal.aborted && value.body) cancelWithoutWaiting(value.body.cancel(signal.reason));
            return value;
          });
          response = await raceAbort(fetching, signal);
          signal.throwIfAborted();
          if (!response.body) throw new Error('Native provider response has no body.');
          const reader = response.body.getReader();
          try {
            while (true) {
              signal.throwIfAborted();
              const chunk = await raceAbort(reader.read(), signal);
              if (chunk.done) break;
              await appendFile(responsePath, chunk.value);
            }
          } catch (error) {
            cancelWithoutWaiting(reader.cancel(error));
            throw error;
          } finally { reader.releaseLock(); }
        } catch (error) {
          const partialRaw = await readFile(responsePath);
          await writeFile(path.join(directory, `${stem}.http.json`), JSON.stringify({ endpoint, status: response?.status ?? null,
            durationMs: Date.now() - started, productionSha256: digest(original), requestSha256: digest(body), responseSha256: digest(partialRaw),
            partial: true, failure: error instanceof Error ? { name: error.name, message: error.message } : { message: String(error) } }), { flag: 'wx' });
          if (generation && input.failurePolicy === 'r5-cell-isolated') throw boundedFailure(error, partialRaw.toString('utf8'), `${stem}.http.json`, sentMaxOutputTokens);
          throw error;
        }
        const raw = await readFile(responsePath, 'utf8');
        const evidence = { endpoint, status: response.status, durationMs: Date.now() - started, productionSha256: digest(original),
          requestSha256: digest(body), responseSha256: digest(raw) };
        await writeFile(path.join(directory, `${stem}.http.json`), JSON.stringify(evidence), { flag: 'wx' });
        if (!response.ok) throw new Error(`Native provider HTTP ${response.status}; no retry.`);
        if (generation) {
          const streaming = response.headers.get('content-type')?.includes('text/event-stream') === true || /^(?:event:|data:|:)/.test(raw.trimStart());
          let responseEvents: Record<string, unknown>[]; let parsed: ReturnType<typeof readUsage>;
          try { responseEvents = parseNativeResponseEvents(raw, streaming); parsed = readUsage(responseEvents, streaming); }
          catch (error) {
            if (input.failurePolicy === 'r5-cell-isolated') throw boundedFailure(error, raw, `${stem}.http.json`, sentMaxOutputTokens);
            throw error;
          }
          const { usage } = parsed;
          accountUsage(usage);
          await save();
          await writeFile(path.join(directory, `${stem}.http.json`), JSON.stringify({ ...evidence, ...parsed, requestedModel: input.model }));
          await observeSpend(request.signal);
          if (ledger.tokens + (ledger.reservedTokens ?? 0) >= input.maxTotalTokens) throw new Error('Token budget reached after actual usage settlement.');
          if (ledger.spendUsd !== null && ledger.spendUsd + (ledger.reservedSpendUsd ?? 0) >= input.maxSpendUsd) throw new Error('Spend budget reached after actual usage settlement.');
          if (cell.tokens + (cell.reservations ?? []).reduce((sum, reservation) => sum + reservation.totalTokens, 0) >= input.maxCellTokens) throw new CellFailure('Token budget reached after actual usage settlement for cell.');
          if (usage.outputTokens > sentMaxOutputTokens) throw new CellFailure('Native output token cap exceeded.');
          accountedAuxiliaryEvidence = `${stem}.http.json`;
          if (['max_tokens', 'length', 'model_context_window_exceeded'].includes(parsed.stopReason.trim().toLowerCase())) {
            throw new CellFailure('Truncated native response; automatic retry/continuation is outside the frozen call graph.');
          }
          try { assertNoResponseRepair(responseEvents, JSON.parse(body) as Record<string, unknown>); }
          catch (error) { throw new CellFailure(error instanceof Error ? error.message : String(error), { cause: error }); }
        }
        const publicHeaders = new Headers(response.headers); publicHeaders.delete('content-length'); publicHeaders.delete('content-encoding');
        return new Response(raw, { status: response.status, statusText: response.statusText, headers: publicHeaders });
      } catch (error) {
        if (error instanceof NativeRecoverableAuxiliaryError) throw error;
        if (recoverableAuxiliaryRequestHash && accountedAuxiliaryEvidence && error instanceof CellFailure && !error.partial) {
          return recoverAuxiliary(error, accountedAuxiliaryEvidence);
        }
        if (input.failurePolicy === 'r5-cell-isolated' && error instanceof CellFailure && error.partial) {
          try { await settleFailedUsage(error.partial); }
          catch (settlementError) {
            if (settlementError instanceof CellFailure) return fail(settlementError);
            return fail(new AggregateError([error, settlementError], `Native failure cannot be isolated: ${settlementError instanceof Error ? settlementError.message : String(settlementError)}`));
          }
          if (optionalToolName === 'report_stall_judgment' && recoverableAuxiliaryRequestHash && error.cause instanceof Error && ['AbortError', 'TimeoutError'].includes(error.cause.name)) {
            return recoverAuxiliary(error, error.partial.evidence);
          }
        }
        return fail(error);
      }
    };
    const proxy: typeof fetch = (source, init) => {
      const pending = queue.then(() => execute(source, init));
      // Queue bookkeeping only; the caller receives the original rejection.
      queue = pending.then(() => undefined, () => undefined);
      return pending;
    };
    return { fetch: proxy, getLedger: () => structuredClone(ledger),
      settle: async () => { await queue; closed = true; await save(); await release(); } };
  } catch (error) { await release(); throw error; }
}
