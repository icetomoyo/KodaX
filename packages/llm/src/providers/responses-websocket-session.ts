import { createHash } from 'node:crypto';
import type { KodaXProviderStreamOptions, KodaXResponsesSocket, KodaXResponsesSocketFactory } from '../types.js';
import { getProviderTransportLifetime } from '../provider-credential-context.js';
import { createResponsesSocket } from './responses-socket.js';
import { KodaXProviderError } from '../errors.js';

export interface ResponsesSocketSession {
  socket: KodaXResponsesSocket; cached: boolean; busy: boolean; owner?: AbortSignal; group: string;
  factory: KodaXResponsesSocketFactory; destroy(): void;
  continuation?: { responseId: string; body: Record<string, unknown>; baseline: readonly unknown[] };
}
const sessions = new Map<string, ResponsesSocketSession>();
type Input = { provider: string; url: string; headers: Record<string, string>; scope: string; options?: KodaXProviderStreamOptions; signal?: AbortSignal; timeoutMs: number };
function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
async function connect(factory: KodaXResponsesSocketFactory, input: Input, lifetime?: AbortSignal): Promise<{ socket: KodaXResponsesSocket; destroy(): void }> {
  const controller = new AbortController();
  let socket: KodaXResponsesSocket | undefined, destroyed = false;
  const destroy = () => { if (destroyed) return; destroyed = true; lifetime?.removeEventListener('abort', ownerAbort); controller.abort(); socket?.close(); };
  const ownerAbort = () => { controller.abort(lifetime?.reason); destroy(); };
  const requestAbort = () => controller.abort(input.signal?.reason);
  lifetime?.addEventListener('abort', ownerAbort, { once: true }); input.signal?.addEventListener('abort', requestAbort, { once: true });
  if (lifetime?.aborted) ownerAbort(); if (input.signal?.aborted) requestAbort();
  const timeout = setTimeout(() => controller.abort(new DOMException('WebSocket handshake timed out.', 'TimeoutError')), input.timeoutMs);
  let onAbort = (): void => {};
  try {
    const pending = factory({ url: input.url, headers: input.headers, timeoutMs: input.timeoutMs, signal: controller.signal }).then(link => {
      socket = link;
      if (controller.signal.aborted) { link.close(); throw controller.signal.reason; }
      return link;
    });
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(controller.signal.reason); controller.signal.addEventListener('abort', onAbort, { once: true });
      if (controller.signal.aborted) onAbort();
    });
    return { socket: await Promise.race([pending, aborted]), destroy };
  } catch (error) { destroy(); throw error; }
  finally { clearTimeout(timeout); controller.signal.removeEventListener('abort', onAbort); input.signal?.removeEventListener('abort', requestAbort); }
}
export async function acquireResponsesSocket(input: Input): Promise<ResponsesSocketSession> {
  const factory = input.options?.webSocketFactory ?? createResponsesSocket;
  const cached = input.options?.transport === 'websocket-cached';
  const standalone = input.options?.webSocketLifetime;
  const lifetime = getProviderTransportLifetime(input.provider) ?? (standalone ? { owner: standalone, signal: standalone, isActive: () => !standalone.aborted } : undefined);
  const sessionId = input.options?.sessionId ?? input.options?.promptCacheKey;
  if (cached && (!sessionId || !lifetime || !lifetime.isActive() || lifetime.signal.aborted)) throw new KodaXProviderError('Cached WebSocket requires an active lifetime and session ID.', input.provider, { retryable: false });
  const headers = { ...input.headers }; delete headers['x-client-request-id'];
  const group = digest([input.provider, input.url, sessionId]);
  const key = digest([group, input.scope, headers]);
  const existing = cached ? sessions.get(key) : undefined;
  if (existing && !existing.busy && !existing.socket.closed && existing.owner === lifetime?.owner && existing.factory === factory) { existing.busy = true; return existing; }
  for (const entry of sessions.values()) if (entry.group === group && !entry.busy && (entry !== existing || entry.socket.closed || entry.owner !== lifetime?.owner || entry.factory !== factory)) entry.destroy();
  const connection = await connect(factory, input, cached ? lifetime!.signal : input.signal);
  // Concurrent calls keep separate sockets; continuation state is never shared while a request is active.
  const retained = cached && !existing?.busy;
  const session: ResponsesSocketSession = { socket: connection.socket, cached: retained, busy: true, owner: lifetime?.owner, group, factory,
    destroy() { connection.destroy(); if (sessions.get(key) === session) sessions.delete(key); lifetime?.signal.removeEventListener('abort', session.destroy); } };
  if (retained) { sessions.set(key, session); lifetime!.signal.addEventListener('abort', session.destroy, { once: true }); }
  if (cached && !lifetime!.isActive()) { session.destroy(); throw new DOMException('WebSocket owner revoked', 'AbortError'); }
  return session;
}
function withoutInput(body: Record<string, unknown>): Record<string, unknown> { const { input: _input, previous_response_id: _previous, ...rest } = body; return rest; }
export function responsesContinuationFrame(session: ResponsesSocketSession, body: Record<string, unknown>): Record<string, unknown> {
  const prior = session.continuation, input = body.input;
  if (!prior || !Array.isArray(input) || JSON.stringify(withoutInput(body)) !== JSON.stringify(withoutInput(prior.body))
    || input.length < prior.baseline.length || JSON.stringify(input.slice(0, prior.baseline.length)) !== JSON.stringify(prior.baseline)) return body;
  return { ...body, previous_response_id: prior.responseId, input: input.slice(prior.baseline.length) };
}
