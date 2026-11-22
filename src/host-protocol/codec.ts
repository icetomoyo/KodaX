/**
 * The v2 Host protocol on the wire: JSON-RPC 2.0, one message per frame, no
 * batches. This module has no Node dependency, so the browser SDK shares it.
 */
export const HOST_PROTOCOL = 'kodax/2';

/**
 * The newest contract revision this build speaks. A connection uses the lower
 * of the two sides' revisions, so raise it only together with the change that
 * needs it.
 */
export const HOST_PROTOCOL_REVISION = 1;

/**
 * What a client should do about a failure. The set is closed: a new code needs
 * a new revision. `rpc` is the JSON-RPC error code that carries it.
 */
const ERROR_CODES = {
  invalid_params: { rpc: -32602, retryable: false },
  method_not_found: { rpc: -32601, retryable: false },
  internal: { rpc: -32603, retryable: false },
  unauthorized: { rpc: -32001, retryable: false },
  forbidden: { rpc: -32002, retryable: false },
  not_found: { rpc: -32003, retryable: false },
  conflict: { rpc: -32004, retryable: false },
  invalid_state: { rpc: -32005, retryable: false },
  resync_required: { rpc: -32006, retryable: false },
  limit_exceeded: { rpc: -32007, retryable: false },
  overloaded: { rpc: -32008, retryable: true },
  unavailable: { rpc: -32009, retryable: true },
  timeout: { rpc: -32010, retryable: true },
  cancelled: { rpc: -32011, retryable: false },
  unknown_outcome: { rpc: -32012, retryable: false },
} as const;

export type HostErrorCode = keyof typeof ERROR_CODES;

export const HOST_ERROR_CODES = Object.keys(ERROR_CODES) as readonly HostErrorCode[];

/** JSON-RPC codes for a frame that is not a usable message at all. */
const RPC_PARSE_ERROR = -32700;
const RPC_INVALID_REQUEST = -32600;

export interface HostErrorData {
  readonly kodaxCode: HostErrorCode;
  /** Open-ended detail for display and diagnosis. Clients never branch on it. */
  readonly reason?: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
}

export type HostRpcId = string | number;

export interface HostRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id: HostRpcId;
  readonly method: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

export interface HostRpcNotification {
  readonly jsonrpc: '2.0';
  readonly method: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

export interface HostRpcSuccess {
  readonly jsonrpc: '2.0';
  readonly id: HostRpcId;
  readonly result: Readonly<Record<string, unknown>>;
}

export interface HostRpcFailure {
  readonly jsonrpc: '2.0';
  /** `null` when the failing frame had no readable id. */
  readonly id: HostRpcId | null;
  readonly error: {
    readonly code: number;
    readonly message: string;
    readonly data: HostErrorData;
  };
}

export type HostRpcMessage = HostRpcRequest | HostRpcNotification | HostRpcSuccess | HostRpcFailure;

/** The one error type both ends use. Clients branch on `kodaxCode`, never on the message. */
export class HostProtocolError extends Error {
  readonly kodaxCode: HostErrorCode;
  readonly reason?: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(
    kodaxCode: HostErrorCode,
    message: string,
    detail: {
      readonly reason?: string;
      readonly retryable?: boolean;
      readonly retryAfterMs?: number;
      /** Kept on this side for diagnosis. It never travels in a frame. */
      readonly cause?: unknown;
    } = {},
  ) {
    super(message, detail.cause !== undefined ? { cause: detail.cause } : undefined);
    this.name = 'HostProtocolError';
    this.kodaxCode = kodaxCode;
    this.retryable = detail.retryable ?? ERROR_CODES[kodaxCode].retryable;
    if (detail.reason !== undefined) this.reason = detail.reason;
    if (detail.retryAfterMs !== undefined) this.retryAfterMs = detail.retryAfterMs;
  }
}

export function hostRpcRequest(
  id: HostRpcId,
  method: string,
  params?: Readonly<Record<string, unknown>>,
): HostRpcRequest {
  return { jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) };
}

export function hostRpcNotification(
  method: string,
  params?: Readonly<Record<string, unknown>>,
): HostRpcNotification {
  return { jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) };
}

export function hostRpcSuccess(id: HostRpcId, result: Readonly<Record<string, unknown>>): HostRpcSuccess {
  return { jsonrpc: '2.0', id, result };
}

export function hostRpcFailure(id: HostRpcId | null, error: HostProtocolError, rpcCode?: number): HostRpcFailure {
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code: rpcCode ?? ERROR_CODES[error.kodaxCode].rpc,
      message: error.message,
      data: {
        kodaxCode: error.kodaxCode,
        ...(error.reason !== undefined ? { reason: error.reason } : {}),
        retryable: error.retryable,
        ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
      },
    },
  };
}

/**
 * Rebuilds the error a failure frame carries. A code this build does not know
 * (a newer peer) is reported as `internal`, with the unknown code as the reason.
 */
export function hostProtocolErrorFrom(failure: HostRpcFailure): HostProtocolError {
  const data: Partial<HostErrorData> = isRecord(failure.error.data) ? failure.error.data : {};
  const known = typeof data.kodaxCode === 'string' && Object.hasOwn(ERROR_CODES, data.kodaxCode);
  return new HostProtocolError(known ? data.kodaxCode! : 'internal', failure.error.message, {
    reason: known
      ? (typeof data.reason === 'string' ? data.reason : undefined)
      : `unknown_error_code:${String(data.kodaxCode ?? failure.error.code)}`,
    retryable: known && typeof data.retryable === 'boolean' ? data.retryable : undefined,
    retryAfterMs: typeof data.retryAfterMs === 'number' ? data.retryAfterMs : undefined,
  });
}

export type HostRpcParsed =
  | { readonly kind: 'request'; readonly message: HostRpcRequest }
  | { readonly kind: 'notification'; readonly message: HostRpcNotification }
  | { readonly kind: 'success'; readonly message: HostRpcSuccess }
  | { readonly kind: 'failure'; readonly message: HostRpcFailure }
  /** Not a usable message. `failure` is the reply the receiver owes the sender. */
  | { readonly kind: 'invalid'; readonly failure: HostRpcFailure };

/** True for a decoded frame that speaks JSON-RPC: a v2 message or a batch. v1 frames are neither. */
export function isHostRpcFrame(value: unknown): boolean {
  return Array.isArray(value) || (isRecord(value) && value.jsonrpc === '2.0');
}

export function parseHostRpcFrame(text: string): HostRpcParsed {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return invalid(null, 'Frame is not valid JSON.', 'parse_error', RPC_PARSE_ERROR);
  }
  return classifyHostRpcMessage(value);
}

/** Classifies an already decoded frame. Field checks stop at the envelope; methods check their own params. */
export function classifyHostRpcMessage(value: unknown): HostRpcParsed {
  if (Array.isArray(value)) {
    return invalid(null, 'Batches are not supported. Send one message per frame.', 'batch_unsupported');
  }
  if (!isRecord(value) || value.jsonrpc !== '2.0') {
    return invalid(null, 'Frame is not a JSON-RPC 2.0 message.', 'invalid_request');
  }
  const hasId = Object.hasOwn(value, 'id');
  const id = hasId && isHostRpcId(value.id) ? value.id : null;
  // Only a failure may carry a null id: the reply to a frame whose id was unreadable.
  const nullIdFailure = value.id === null && isRecord(value.error);
  if (hasId && id === null && !nullIdFailure) {
    return invalid(null, 'Message id must be a non-empty string or an integer.', 'invalid_request');
  }
  if (typeof value.method === 'string') {
    if (value.method.length === 0) return invalid(id, 'Method name is empty.', 'invalid_request');
    if (value.params !== undefined && !isRecord(value.params)) {
      return invalid(id, 'Params must be an object; positional params are not supported.', 'invalid_request');
    }
    const message = value as unknown as HostRpcRequest;
    return id === null ? { kind: 'notification', message } : { kind: 'request', message };
  }
  if (id !== null && Object.hasOwn(value, 'result')) {
    if (!isRecord(value.result)) return invalid(id, 'Result must be an object.', 'invalid_request');
    return { kind: 'success', message: value as unknown as HostRpcSuccess };
  }
  if (isRecord(value.error) && typeof value.error.code === 'number' && typeof value.error.message === 'string') {
    return { kind: 'failure', message: { ...(value as unknown as HostRpcFailure), id } };
  }
  return invalid(id, 'Message is neither a request, a notification nor a response.', 'invalid_request');
}

function invalid(id: HostRpcId | null, message: string, reason: string, rpcCode = RPC_INVALID_REQUEST): HostRpcParsed {
  return {
    kind: 'invalid',
    failure: hostRpcFailure(id, new HostProtocolError('invalid_params', message, { reason }), rpcCode),
  };
}

function isHostRpcId(value: unknown): value is HostRpcId {
  return typeof value === 'string'
    ? value.length > 0 && value.length <= 128
    : typeof value === 'number' && Number.isSafeInteger(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
