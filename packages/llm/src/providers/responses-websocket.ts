import type { Response as OpenAIResponse, ResponseStreamEvent } from 'openai/resources/responses/responses';
import type { KodaXProviderStreamOptions } from '../types.js';
import { KodaXProviderError } from '../errors.js';
import { observeProviderSocketDispatch, observeProviderStreamUsage } from '../provider-request-observation.js';
import { normalizeResponsesUsage } from './cache-usage.js';
import { providerStreamEvent, observePreparedProviderPayload } from './request-extensions.js';
import { acquireResponsesSocket, responsesContinuationFrame, type ResponsesSocketSession } from './responses-websocket-session.js';

interface Request {
  provider: string; url: string; headers: Record<string, string>; frame: Record<string, unknown>; scope: string;
  options?: KodaXProviderStreamOptions; signal?: AbortSignal;
  fallback?(): Promise<AsyncIterable<ResponseStreamEvent>>;
  validateCompleted(response: OpenAIResponse): readonly unknown[];
}
interface Progress { started: boolean; completed: boolean; }
class MissingContinuation extends Error {}
function failure(provider: string, message: string): KodaXProviderError {
  return new KodaXProviderError(`WebSocket ${message}`, provider, { failureCode: 'response_stream_error', stage: 'response_stream', retryable: false });
}
function readEvent(frame: string, provider: string): Record<string, unknown> {
  if (typeof frame !== 'string' || Buffer.byteLength(frame) > 24 * 1024 * 1024) throw failure(provider, 'frame exceeds the processing limit.');
  const event: unknown = JSON.parse(frame);
  if (!event || typeof event !== 'object' || !('type' in event) || typeof event.type !== 'string') throw failure(provider, 'returned an invalid event.');
  return event as Record<string, unknown>;
}
function upstreamError(input: Request, event: Record<string, unknown>, started: boolean, hasPrevious: boolean): never {
  providerStreamEvent(event);
  const detail = event.error && typeof event.error === 'object' ? event.error as Record<string, unknown> : event;
  const message = typeof detail.message === 'string' ? detail.message : 'upstream error';
  if (!started && hasPrevious && event.status === 400 && detail.code === 'previous_response_not_found') throw new MissingContinuation(message);
  if (!started && (event.status === 400 || event.status === 422)) throw Object.assign(new Error(message), { status: event.status });
  throw failure(input.provider, message);
}
async function* consume(input: Request, session: ResponsesSocketSession, frame: Record<string, unknown>, progress: Progress): AsyncGenerator<ResponseStreamEvent> {
  input.signal?.throwIfAborted(); observePreparedProviderPayload(frame); observeProviderSocketDispatch(); await session.socket.send(JSON.stringify(frame));
  while (true) {
    input.signal?.throwIfAborted();
    const event = readEvent(await session.socket.receive(input.signal), input.provider);
    const response = event.response && typeof event.response === 'object' ? event.response as Record<string, unknown> : undefined;
    if (response) observeProviderStreamUsage(normalizeResponsesUsage(response.usage));
    if (event.type === 'error') upstreamError(input, event, progress.started, typeof frame.previous_response_id === 'string');
    progress.started = true;
    if (event.type === 'response.failed' || event.type === 'response.incomplete') { providerStreamEvent(event); throw failure(input.provider, 'generation did not complete.'); }
    if (event.type === 'response.completed') {
      if (!response || response.status !== 'completed' || response.error) throw failure(input.provider, 'returned an invalid completed response.');
      if (session.cached) {
        const output = input.validateCompleted(response as unknown as OpenAIResponse);
        session.continuation = typeof response.id === 'string' && response.id && Array.isArray(input.frame.input)
          ? { responseId: response.id, body: structuredClone(input.frame), baseline: [...structuredClone(input.frame.input), ...output] } : undefined;
      }
      progress.completed = true;
    }
    yield event as unknown as ResponseStreamEvent;
    if (progress.completed) return;
  }
}
export async function* responsesWebSocketEvents(input: Request): AsyncGenerator<ResponseStreamEvent> {
  const timeoutMs = input.options?.webSocketConnectTimeoutMs ?? 10000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) throw failure(input.provider, 'connect timeout is invalid.');
  for (let attempt = 0; attempt < 2; attempt++) {
    let session: ResponsesSocketSession;
    try { session = await acquireResponsesSocket({ ...input, timeoutMs }); }
    catch (error) {
      input.signal?.throwIfAborted();
      const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
      if (attempt === 0 && input.fallback && ![401, 403, 429].includes(status as number)) { yield* await input.fallback(); return; }
      throw failure(input.provider, `handshake failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const progress: Progress = { started: false, completed: false };
    const frame = attempt === 0 ? responsesContinuationFrame(session, input.frame) : input.frame;
    try { yield* consume(input, session, frame, progress); return; }
    catch (error) {
      input.signal?.throwIfAborted();
      if (error instanceof MissingContinuation && attempt === 0 && !input.options?.singleAttempt) continue;
      if (!progress.started && error && typeof error === 'object' && 'status' in error) throw error;
      if (error instanceof KodaXProviderError) throw error;
      throw failure(input.provider, `stream failed after dispatch: ${error instanceof Error ? error.message : String(error)}`);
    } finally { session.busy = false; if (!session.cached || !progress.completed) session.destroy(); }
  }
}
