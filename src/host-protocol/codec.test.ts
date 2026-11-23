import { describe, expect, it, vi } from 'vitest';
import {
  HOST_ERROR_CODES,
  HostProtocolError,
  classifyHostRpcMessage,
  hostProtocolErrorFrom,
  hostRpcFailure,
  hostRpcNotification,
  hostRpcRequest,
  hostRpcSuccess,
  isHostRpcFrame,
  parseHostRpcFrame,
  type HostRpcFailure,
} from './codec.js';

function roundTrip(message: unknown): ReturnType<typeof parseHostRpcFrame> {
  return parseHostRpcFrame(JSON.stringify(message));
}

describe('host protocol codec', () => {
  it('recognizes a protocol error made by another copy of this module, as another bundle has', async () => {
    vi.resetModules();
    const other = await import('./codec.js');
    expect(other.HostProtocolError).not.toBe(HostProtocolError);
    const error = new other.HostProtocolError('not_found', 'The Run has not ended yet.');
    expect(error).toBeInstanceOf(HostProtocolError);
    expect(new HostProtocolError('conflict', 'x')).toBeInstanceOf(other.HostProtocolError);
    expect(new Error('plain')).not.toBeInstanceOf(HostProtocolError);
    expect(Object.assign(new Error('look-alike'), { kodaxCode: 'not_found' })).not.toBeInstanceOf(HostProtocolError);
    expect({ ...error }).not.toBeInstanceOf(HostProtocolError);
  });

  it('round-trips each kind of message', () => {
    expect(roundTrip(hostRpcRequest('r1', 'ping', { a: 1 }))).toEqual({
      kind: 'request',
      message: { jsonrpc: '2.0', id: 'r1', method: 'ping', params: { a: 1 } },
    });
    expect(roundTrip(hostRpcRequest(7, 'ping'))).toMatchObject({ kind: 'request', message: { id: 7 } });
    expect(roundTrip(hostRpcNotification('view.patch', { seq: 3 }))).toEqual({
      kind: 'notification',
      message: { jsonrpc: '2.0', method: 'view.patch', params: { seq: 3 } },
    });
    expect(roundTrip(hostRpcSuccess('r1', { ok: true }))).toEqual({
      kind: 'success',
      message: { jsonrpc: '2.0', id: 'r1', result: { ok: true } },
    });
    const failure = hostRpcFailure('r1', new HostProtocolError('conflict', 'Taken.', { reason: 'request_id_reused' }));
    expect(roundTrip(failure)).toEqual({ kind: 'failure', message: failure });
  });

  it('carries the client action in data and a JSON-RPC code beside it', () => {
    expect(hostRpcFailure(1, new HostProtocolError('invalid_params', 'Bad.')).error).toEqual({
      code: -32602,
      message: 'Bad.',
      data: { kodaxCode: 'invalid_params', retryable: false },
    });
    expect(hostRpcFailure(1, new HostProtocolError('overloaded', 'Busy.', { retryAfterMs: 500 })).error.data).toEqual({
      kodaxCode: 'overloaded',
      retryable: true,
      retryAfterMs: 500,
    });
  });

  it('gives every error code its own JSON-RPC code', () => {
    const codes = HOST_ERROR_CODES.map(code => hostRpcFailure(1, new HostProtocolError(code, 'x')).error.code);
    expect(new Set(codes).size).toBe(HOST_ERROR_CODES.length);
    expect(HOST_ERROR_CODES).toHaveLength(15);
  });

  it('marks only overloaded, unavailable and timeout as retryable by default', () => {
    const retryable = HOST_ERROR_CODES.filter(code => new HostProtocolError(code, 'x').retryable);
    expect(retryable.sort()).toEqual(['overloaded', 'timeout', 'unavailable']);
  });

  it('rebuilds the same error from a failure frame', () => {
    const sent = new HostProtocolError('unavailable', 'Draining.', { reason: 'host_draining', retryAfterMs: 1_000 });
    const received = hostProtocolErrorFrom(hostRpcFailure('r1', sent));
    expect(received).toBeInstanceOf(HostProtocolError);
    expect(received).toMatchObject({
      kodaxCode: 'unavailable',
      message: 'Draining.',
      reason: 'host_draining',
      retryable: true,
      retryAfterMs: 1_000,
    });
  });

  it('carries the incident of an internal error both ways', () => {
    const sent = new HostProtocolError('internal', 'The Host could not complete this request.', { incidentId: 'inc-1' });
    expect(hostRpcFailure('r1', sent).error.data).toEqual({ kodaxCode: 'internal', retryable: false, incidentId: 'inc-1' });
    expect(hostProtocolErrorFrom(hostRpcFailure('r1', sent))).toMatchObject({ kodaxCode: 'internal', incidentId: 'inc-1' });
  });

  it('reports an error code from a newer peer as internal and keeps the unknown code as the reason', () => {
    const failure = {
      jsonrpc: '2.0',
      id: 'r1',
      error: { code: -32050, message: 'New.', data: { kodaxCode: 'quota_frozen', retryable: true } },
    } as unknown as HostRpcFailure;
    expect(hostProtocolErrorFrom(failure)).toMatchObject({
      kodaxCode: 'internal',
      reason: 'unknown_error_code:quota_frozen',
      retryable: false,
    });
    const bare = { jsonrpc: '2.0', id: 'r1', error: { code: -32000, message: 'Plain.' } } as unknown as HostRpcFailure;
    expect(hostProtocolErrorFrom(bare)).toMatchObject({ kodaxCode: 'internal', reason: 'unknown_error_code:-32000' });
  });

  it('answers a frame that is not JSON with a parse error and no id', () => {
    expect(parseHostRpcFrame('{nope')).toMatchObject({
      kind: 'invalid',
      failure: { id: null, error: { code: -32700, data: { kodaxCode: 'invalid_params', reason: 'parse_error' } } },
    });
  });

  it('refuses a batch', () => {
    expect(roundTrip([hostRpcRequest('a', 'ping'), hostRpcRequest('b', 'ping')])).toMatchObject({
      kind: 'invalid',
      failure: { id: null, error: { code: -32600, data: { reason: 'batch_unsupported' } } },
    });
  });

  it.each([
    ['a v1 frame', { protocol: 'kodax-runtime-daemon', version: 1, kind: 'request', id: 'x', method: 'ping' }],
    ['a wrong version', { jsonrpc: '1.0', id: 'x', method: 'ping' }],
    ['a scalar', 3],
    ['a null id on a request', { jsonrpc: '2.0', id: null, method: 'ping' }],
    ['a fractional id', { jsonrpc: '2.0', id: 1.5, method: 'ping' }],
    ['an empty id', { jsonrpc: '2.0', id: '', method: 'ping' }],
    ['an oversized id', { jsonrpc: '2.0', id: 'x'.repeat(129), method: 'ping' }],
    ['an empty method', { jsonrpc: '2.0', id: 'x', method: '' }],
    ['positional params', { jsonrpc: '2.0', id: 'x', method: 'ping', params: [1] }],
    ['a scalar result', { jsonrpc: '2.0', id: 'x', result: 3 }],
    ['an array result', { jsonrpc: '2.0', id: 'x', result: [] }],
    ['neither method nor outcome', { jsonrpc: '2.0', id: 'x' }],
    ['a result without an id', { jsonrpc: '2.0', result: {} }],
  ])('rejects %s as an invalid request', (_name, frame) => {
    expect(roundTrip(frame)).toMatchObject({ kind: 'invalid', failure: { error: { code: -32600 } } });
  });

  it('echoes the id of an invalid request when the id itself was readable', () => {
    expect(roundTrip({ jsonrpc: '2.0', id: 'x', method: 'ping', params: [1] }))
      .toMatchObject({ kind: 'invalid', failure: { id: 'x' } });
  });

  it('accepts a failure whose id is null', () => {
    const failure = hostRpcFailure(null, new HostProtocolError('invalid_params', 'Bad frame.'));
    expect(roundTrip(failure)).toEqual({ kind: 'failure', message: failure });
  });

  it('classifies a decoded frame without re-encoding it', () => {
    const request = hostRpcRequest('r1', 'ping');
    expect(classifyHostRpcMessage(request)).toEqual({ kind: 'request', message: request });
  });

  it('tells a JSON-RPC frame from a v1 frame', () => {
    expect(isHostRpcFrame(hostRpcRequest('r1', 'initialize'))).toBe(true);
    expect(isHostRpcFrame([hostRpcRequest('r1', 'initialize')])).toBe(true);
    expect(isHostRpcFrame({ protocol: 'kodax-runtime-daemon', version: 1, kind: 'request' })).toBe(false);
    expect(isHostRpcFrame('jsonrpc')).toBe(false);
    expect(isHostRpcFrame(null)).toBe(false);
  });
});
