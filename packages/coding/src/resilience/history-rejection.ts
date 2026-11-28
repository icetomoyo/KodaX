/**
 * Detects a session the Provider keeps refusing (Issue 450). When two Runs in a row
 * end with the same content rejection, the new input is unlikely to be the cause:
 * something already in the history is. The failure is marked `historyRejected`, so a
 * client can offer to continue in a recovered session. Nothing is changed automatically.
 */
import type { KodaXMessage } from '@kodax-ai/llm';
import { attachFailureResult, attachProviderFailure, readFailureResult, readProviderFailure } from '../execution-failure.js';
import type { KodaXExecutionFailure, KodaXResult } from '../types.js';

// Account and access failures arrive as 400/422 from some providers; changing the request cannot fix them.
export const ACCOUNT_FAILURE = /api[ _-]?key|authenticat|unauthori[sz]ed|credential|access denied|permission|quota|credits?|balance|billing|rate.?limit|鉴权|认证|密钥|权限|配额|余额|限流/i;
const CONTENT_REJECTION_STATUSES = [400, 413, 422];
const TRACKED_SESSIONS_LIMIT = 256;
/** Last content rejection per session; kept in memory, so a Host restart needs two failures again. */
const lastRejection = new Map<string, string>();

function rejectionKey(failure: KodaXExecutionFailure | undefined): string | undefined {
  if (failure?.source !== 'provider' || !CONTENT_REJECTION_STATUSES.includes(failure.httpStatus ?? 0)) return undefined;
  if (ACCOUNT_FAILURE.test(failure.message)) return undefined;
  return [failure.provider, failure.model, failure.httpStatus, failure.upstreamCode].join('\0');
}

/** Returns whether this failure repeats the session's previous content rejection. */
function isRepeatedRejection(sessionId: string | undefined, failure: KodaXExecutionFailure | undefined,
  messages: readonly KodaXMessage[]): boolean {
  const key = rejectionKey(failure);
  // Failures that say nothing about the request (5xx, network, local) leave the streak as it is.
  if (sessionId === undefined || key === undefined) return false;
  const repeated = lastRejection.get(sessionId) === key && messages.some(message => message.role === 'assistant');
  lastRejection.delete(sessionId);
  lastRejection.set(sessionId, key);
  if (lastRejection.size > TRACKED_SESSIONS_LIMIT) lastRejection.delete(lastRejection.keys().next().value!);
  return repeated;
}

const marked = (failure: KodaXExecutionFailure): KodaXExecutionFailure => ({ ...failure, historyRejected: true });

/** Call with every settled Run result. A success clears the session's streak. */
export function recordRunResult(sessionId: string | undefined, result: KodaXResult): KodaXResult {
  if (result.success && sessionId !== undefined) lastRejection.delete(sessionId);
  if (result.success || !isRepeatedRejection(sessionId, result.failure, result.messages)) return result;
  return { ...result, failure: marked(result.failure!) };
}

/** Call with every error a Run throws. A repeat is marked on the error's failure carriers. */
export function recordRunError(sessionId: string | undefined, error: unknown): void {
  const settled = readFailureResult(error);
  const provider = readProviderFailure(error);
  if (!(error instanceof Error) || !isRepeatedRejection(sessionId, settled?.failure ?? provider, settled?.messages ?? [])) return;
  if (provider !== undefined) attachProviderFailure(error, marked(provider));
  if (settled?.failure !== undefined) attachFailureResult(error, { ...settled, failure: marked(settled.failure) });
}

/** Accepts a failure, a failure detail, or an error carrying either. */
export function isHistoryRejected(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  return (value as { historyRejected?: unknown }).historyRejected === true
    || readProviderFailure(value)?.historyRejected === true
    || readFailureResult(value)?.failure?.historyRejected === true;
}
