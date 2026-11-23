import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod/v4';

import {
  HOST_PROTOCOL,
  HOST_PROTOCOL_REVISION,
  HostProtocolError,
  hostRpcNotification,
  hostRpcRequest,
  type HostRpcFailure,
  type HostRpcSuccess,
} from './codec.js';
import { createHostConnection, type HostAdmission, type HostAdmissionRequest, type HostIncident } from './connection.js';
import { HOST_METHODS, hostParams, hostResult, type HostMethodRegistry } from './methods.js';

const METHODS: HostMethodRegistry = {
  initialize: HOST_METHODS.initialize,
  ping: HOST_METHODS.ping,
  'request.cancel': HOST_METHODS['request.cancel'],
  echo: {
    primitive: 'query',
    plane: 'data',
    params: hostParams({ text: z.string() }),
    result: hostResult({ text: z.string() }),
  },
  'host.stop': { primitive: 'command', plane: 'local', params: hostParams({}), result: hostResult({}) },
  'host.get': { primitive: 'query', plane: 'local', params: hostParams({}), result: hostResult({}) },
  'skill.list': {
    primitive: 'query',
    plane: 'data',
    params: hostParams({ projectRoot: z.string().optional(), policy: z.string().optional() }),
    restricted: { projectRoot: 'local', policy: 'trusted' },
    result: hostResult({ items: z.array(z.object({ name: z.string() })) }),
    localResult: hostResult({ items: z.array(z.object({ name: z.string(), path: z.string() })) }),
  },
};

const INITIALIZE = {
  protocol: HOST_PROTOCOL,
  revision: HOST_PROTOCOL_REVISION,
  client: { name: 'test', version: '1.0.0', instanceId: 'instance-1' },
  auth: { scheme: 'ipc', token: 'secret' },
};

interface Harness {
  readonly frames: Array<HostRpcSuccess | HostRpcFailure>;
  readonly admitted: HostAdmissionRequest[];
  readonly faults: string[];
  readonly incidents: HostIncident[];
  readonly disconnect: ReturnType<typeof vi.fn>;
  readonly closeAdmission: ReturnType<typeof vi.fn>;
  receive(message: unknown): void;
  close(): void;
  /** Sends a request and resolves with its response. */
  request(id: string, method: string, params?: Record<string, unknown>): Promise<HostRpcSuccess | HostRpcFailure>;
}

function harness(overrides: {
  readonly role?: HostAdmission['role'];
  readonly admit?: (request: HostAdmissionRequest) => Promise<HostAdmission>;
  readonly call?: HostAdmission['call'];
  readonly initializeTimeoutMs?: number;
} = {}): Harness {
  const frames: Array<HostRpcSuccess | HostRpcFailure> = [];
  const waiting = new Map<string, (frame: HostRpcSuccess | HostRpcFailure) => void>();
  const admitted: HostAdmissionRequest[] = [];
  const faults: string[] = [];
  const incidents: HostIncident[] = [];
  const disconnect = vi.fn();
  const closeAdmission = vi.fn();
  const admission: HostAdmission = {
    role: overrides.role ?? 'owner',
    subject: 'person',
    host: { id: 'runtime_1', version: '0.0.0-test' },
    features: [],
    locks: [],
    limits: { maxFrameBytes: 1024 },
    call: overrides.call ?? (async (_method, params) => ({ text: String(params.text) })),
    close: closeAdmission,
  };
  const connection = createHostConnection({
    methods: METHODS,
    send: (frame) => {
      const message = JSON.parse(frame) as HostRpcSuccess | HostRpcFailure;
      frames.push(message);
      if (typeof message.id === 'string') waiting.get(message.id)?.(message);
    },
    disconnect,
    admit: overrides.admit ?? (async (request) => { admitted.push(request); return admission; }),
    onInternalError: (method, error, incident) => {
      faults.push(`${method}: ${error instanceof Error ? error.message : String(error)}`);
      incidents.push(incident);
    },
    ...(overrides.initializeTimeoutMs !== undefined ? { initializeTimeoutMs: overrides.initializeTimeoutMs } : {}),
  });
  cleanup.push(() => connection.close());
  const receive = (message: unknown): void => connection.receive(typeof message === 'string' ? message : JSON.stringify(message));
  return {
    frames, admitted, faults, incidents, disconnect, closeAdmission, receive,
    close: () => connection.close(),
    request: (id, method, params) => new Promise((resolve) => {
      waiting.set(id, resolve);
      receive(hostRpcRequest(id, method, params));
    }),
  };
}

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const task of cleanup.splice(0)) task();
  vi.useRealTimers();
});

function errorData(frame: HostRpcSuccess | HostRpcFailure): unknown {
  return 'error' in frame ? frame.error.data : undefined;
}

describe('host connection handshake', () => {
  it('admits a client and tells it what this connection may call', async () => {
    const h = harness({ role: 'user' });
    const reply = await h.request('i', 'initialize', INITIALIZE);

    expect(reply).toEqual({
      jsonrpc: '2.0',
      id: 'i',
      result: {
        protocol: HOST_PROTOCOL,
        revision: HOST_PROTOCOL_REVISION,
        role: 'user',
        subject: 'person',
        host: { id: 'runtime_1', version: '0.0.0-test' },
        methods: ['initialize', 'ping', 'request.cancel', 'echo', 'skill.list'],
        features: [],
        locks: [],
        limits: { maxFrameBytes: 1024 },
      },
    });
    expect(h.admitted).toEqual([{ client: INITIALIZE.client, auth: INITIALIZE.auth, revision: HOST_PROTOCOL_REVISION }]);
  });

  it('lists the local plane only for a role that has it', async () => {
    const h = harness({ role: 'owner' });
    const reply = await h.request('i', 'initialize', INITIALIZE) as HostRpcSuccess;
    expect(reply.result.methods).toContain('host.stop');
  });

  it('limits a probe connection to reading whether the Host is up', async () => {
    const h = harness({ role: 'owner' });
    const reply = await h.request('i', 'initialize', { ...INITIALIZE, purpose: 'probe' }) as HostRpcSuccess;
    expect(reply.result.methods).toEqual(['ping', 'host.get']);
    expect(h.admitted[0]?.purpose).toBe('probe');
    expect(errorData(await h.request('s', 'host.stop'))).toMatchObject({ kodaxCode: 'method_not_found' });
  });

  it('settles on the lower of the two revisions', async () => {
    const h = harness();
    const reply = await h.request('i', 'initialize', { ...INITIALIZE, revision: HOST_PROTOCOL_REVISION + 7 }) as HostRpcSuccess;
    expect(reply.result.revision).toBe(HOST_PROTOCOL_REVISION);
    expect(h.admitted[0]?.revision).toBe(HOST_PROTOCOL_REVISION);
  });

  it('refuses every other method until the handshake is done', async () => {
    const h = harness();
    const reply = await h.request('p', 'ping');
    expect(errorData(reply)).toEqual({ kodaxCode: 'invalid_state', reason: 'not_initialized', retryable: false });
    expect(h.admitted).toEqual([]);
  });

  it('refuses a second handshake', async () => {
    const h = harness();
    await h.request('i', 'initialize', INITIALIZE);
    const reply = await h.request('j', 'initialize', INITIALIZE);
    expect(errorData(reply)).toMatchObject({ kodaxCode: 'invalid_state', reason: 'already_initialized' });
    expect(h.admitted).toHaveLength(1);
  });

  it.each([
    ['another protocol', { ...INITIALIZE, protocol: 'kodax/3' }],
    ['an unknown field', { ...INITIALIZE, extra: true }],
    ['a revision below one', { ...INITIALIZE, revision: 0 }],
    // A paired browser's cookie travels in the transport, so a missing credential is for the admitter to judge.
    ['a credential scheme it does not know', { ...INITIALIZE, auth: { scheme: 'pairing', token: 't' } }],
  ])('rejects a handshake with %s and lets the client try again', async (_name, params) => {
    const h = harness();
    const reply = await h.request('i', 'initialize', params);
    expect(errorData(reply)).toMatchObject({ kodaxCode: 'invalid_params' });
    expect(h.admitted).toEqual([]);
    expect(h.disconnect).not.toHaveBeenCalled();

    expect(await h.request('j', 'initialize', INITIALIZE)).toMatchObject({ id: 'j', result: { protocol: HOST_PROTOCOL } });
  });

  it('hangs up after answering a refused credential', async () => {
    const h = harness({
      admit: async () => { throw new HostProtocolError('unauthorized', 'The credential is not valid.'); },
    });
    const reply = await h.request('i', 'initialize', INITIALIZE);
    expect(errorData(reply)).toMatchObject({ kodaxCode: 'unauthorized' });
    expect(h.disconnect).toHaveBeenCalledTimes(1);
    expect(h.disconnect).toHaveBeenCalledWith('credential');
  });

  it('tells a client the Host cannot check credentials right now, so it retries later', async () => {
    const h = harness({
      admit: async () => { throw new HostProtocolError('unavailable', 'The issuer cannot be reached.'); },
    });
    expect(errorData(await h.request('i', 'initialize', INITIALIZE))).toMatchObject({ kodaxCode: 'unavailable' });
    expect(h.disconnect).toHaveBeenCalledWith('unavailable');
  });

  it('hangs up on a connection that does not finish the handshake in time', async () => {
    vi.useFakeTimers();
    const h = harness({ initializeTimeoutMs: 50 });
    h.receive(hostRpcRequest('p', 'ping'));
    await vi.advanceTimersByTimeAsync(49);
    expect(h.disconnect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(h.disconnect).toHaveBeenCalledTimes(1);
    expect(h.disconnect).toHaveBeenCalledWith('protocol');
  });

  it('keeps a connection that finished the handshake past the deadline', async () => {
    vi.useFakeTimers();
    const h = harness({ initializeTimeoutMs: 50 });
    const reply = h.request('i', 'initialize', INITIALIZE);
    await vi.advanceTimersByTimeAsync(0);
    await reply;
    await vi.advanceTimersByTimeAsync(500);
    expect(h.disconnect).not.toHaveBeenCalled();
  });

  it('refuses a large frame before the handshake and hangs up', () => {
    const h = harness();
    h.receive(hostRpcRequest('i', 'initialize', { ...INITIALIZE, auth: { scheme: 'ipc', token: 'x'.repeat(64 * 1024) } }));
    expect(h.frames).toHaveLength(1);
    expect(h.frames[0]).toMatchObject({ id: null, error: { data: { kodaxCode: 'limit_exceeded' } } });
    expect(h.disconnect).toHaveBeenCalledWith('protocol');
  });

  it('releases an admission that arrives after the connection closed', async () => {
    let admit: ((admission: HostAdmission) => void) | undefined;
    const closeAdmission = vi.fn();
    const h = harness({
      admit: () => new Promise<HostAdmission>((resolve) => { admit = resolve; }),
    });
    h.receive(hostRpcRequest('i', 'initialize', INITIALIZE));
    await vi.waitFor(() => expect(admit).toBeDefined());
    h.close();
    admit!({
      role: 'owner', subject: 'person', host: { id: 'r', version: 'v' }, features: [], locks: [],
      limits: { maxFrameBytes: 1024 }, call: async () => ({}), close: closeAdmission,
    });
    await vi.waitFor(() => expect(closeAdmission).toHaveBeenCalledTimes(1));
    expect(h.frames).toEqual([]);
  });
});

describe('host connection requests', () => {
  async function ready(overrides: Parameters<typeof harness>[0] = {}): Promise<Harness> {
    const h = harness(overrides);
    await h.request('i', 'initialize', INITIALIZE);
    return h;
  }

  it('answers ping itself', async () => {
    const call = vi.fn();
    const h = await ready({ call });
    expect(await h.request('p', 'ping')).toEqual({ jsonrpc: '2.0', id: 'p', result: {} });
    expect(call).not.toHaveBeenCalled();
  });

  it('runs a method and returns its result', async () => {
    const h = await ready();
    expect(await h.request('e', 'echo', { text: 'hi', _meta: { trace: 'abc' } }))
      .toEqual({ jsonrpc: '2.0', id: 'e', result: { text: 'hi' } });
  });

  it('runs what a method left for after its answer once the answer is sent', async () => {
    const order: string[] = [];
    const h = await ready({
      call: async (_method, params, _signal, afterAnswer) => {
        afterAnswer(() => order.push(`after: ${h.frames.at(-1)!.id}`));
        // Other work finishing between the method and its answer must not let what follows overtake it.
        queueMicrotask(() => order.push('meanwhile'));
        return { text: String(params.text) };
      },
    });
    await h.request('e', 'echo', { text: 'hi' });
    expect(order).toEqual(['meanwhile', 'after: e']);
  });

  it('reports a method the Host does not have and one this role may not call the same way', async () => {
    const h = await ready({ role: 'user' });
    const unknown = await h.request('a', 'nope');
    const denied = await h.request('b', 'host.stop');
    expect(errorData(unknown)).toEqual({ kodaxCode: 'method_not_found', retryable: false });
    expect(errorData(denied)).toEqual({ kodaxCode: 'method_not_found', retryable: false });
  });

  it('rejects params the method does not define and names the field', async () => {
    const h = await ready();
    const reply = await h.request('e', 'echo', { text: 'hi', loud: true }) as HostRpcFailure;
    expect(reply.error.data).toMatchObject({ kodaxCode: 'invalid_params' });
    expect(reply.error.message).toContain('loud');
    const missing = await h.request('f', 'echo') as HostRpcFailure;
    expect(missing.error.message).toContain('text');
  });

  it('passes on the failure a method reports', async () => {
    const h = await ready({
      call: async () => { throw new HostProtocolError('not_found', 'No such session.', { reason: 'session_missing' }); },
    });
    const reply = await h.request('e', 'echo', { text: 'hi' }) as HostRpcFailure;
    expect(reply.error).toEqual({
      code: -32003,
      message: 'No such session.',
      data: { kodaxCode: 'not_found', reason: 'session_missing', retryable: false },
    });
  });

  it('hides an unexpected failure behind an internal error and reports it to the Host', async () => {
    const h = await ready({ call: async () => { throw new Error('ENOENT C:\\secret\\path'); } });
    const reply = await h.request('e', 'echo', { text: 'hi' }) as HostRpcFailure;
    expect(reply.error.data).toMatchObject({ kodaxCode: 'internal' });
    expect(reply.error.message).not.toContain('secret');
    expect(h.faults).toEqual(['echo: ENOENT C:\\secret\\path']);
    // The client and the Host log name the same incident.
    const { incidentId } = reply.error.data as { readonly incidentId?: string };
    expect(incidentId).toEqual(expect.any(String));
    expect(reply.error.message).toContain(incidentId);
    expect(h.incidents).toEqual([{ incidentId, rpcId: 'e' }]);
  });

  it('hides what an internal failure a method reports says, and keeps its reason', async () => {
    const h = await ready({
      call: async () => { throw new HostProtocolError('internal', 'store at C:\\secret\\db is corrupt', { reason: 'data_corrupt' }); },
    });
    const reply = await h.request('e', 'echo', { text: 'hi' }) as HostRpcFailure;
    expect(reply.error.message).not.toContain('secret');
    expect(reply.error.data).toEqual({ kodaxCode: 'internal', reason: 'data_corrupt', retryable: false, incidentId: expect.any(String) });
    expect(h.faults).toEqual(['echo: store at C:\\secret\\db is corrupt']);
    expect(h.incidents).toEqual([{ incidentId: (reply.error.data as { readonly incidentId: string }).incidentId, rpcId: 'e' }]);
  });

  it('drops what a result carries beyond the contract', async () => {
    const h = await ready({ call: async () => ({ text: 'hi', homeDir: 'C:\\Users\\someone' }) });
    expect(await h.request('e', 'echo', { text: 'hi' })).toEqual({ jsonrpc: '2.0', id: 'e', result: { text: 'hi' } });
    expect(h.faults).toEqual([]);
  });

  it('refuses to send a result that does not match the contract', async () => {
    const h = await ready({ call: async () => ({ text: { homeDir: 'C:\\Users\\someone' } }) });
    const reply = await h.request('e', 'echo', { text: 'hi' }) as HostRpcFailure;
    expect(reply.error.data).toMatchObject({ kodaxCode: 'internal' });
    expect(JSON.stringify(reply)).not.toContain('someone');
    expect(h.faults).toHaveLength(1);
    expect(h.incidents[0]!.incidentId).toBe((reply.error.data as { readonly incidentId?: string }).incidentId);
  });

  it.each([
    ['user', { projectRoot: '/srv/app' }, 'projectRoot'],
    ['user', { policy: 'strict' }, 'policy'],
    ['service', { projectRoot: '/srv/app', policy: 'strict' }, 'projectRoot'],
  ] as const)('refuses a %s the params its role may not send', async (role, params, refused) => {
    const call = vi.fn();
    const h = await ready({ role, call });
    const reply = await h.request('s', 'skill.list', params) as HostRpcFailure;
    expect(reply.error.data).toEqual({ kodaxCode: 'forbidden', reason: 'param_not_allowed', retryable: false });
    expect(reply.error.message).toContain(refused);
    expect(call).not.toHaveBeenCalled();
  });

  it('accepts restricted params from a role that reaches their plane', async () => {
    const call = vi.fn(async () => ({ items: [] }));
    const service = await ready({ role: 'service', call });
    expect(await service.request('s', 'skill.list', { policy: 'strict' })).toMatchObject({ result: { items: [] } });
    const owner = await ready({ role: 'owner', call });
    expect(await owner.request('s', 'skill.list', { projectRoot: '/srv/app', policy: 'strict' })).toMatchObject({ result: { items: [] } });
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('sends Host paths to the owner only', async () => {
    const call = async (): Promise<unknown> => ({ items: [{ name: 'review', path: '/home/someone/.kodax/skills/review' }] });
    const owner = await ready({ role: 'owner', call });
    expect(await owner.request('s', 'skill.list')).toMatchObject({
      result: { items: [{ name: 'review', path: '/home/someone/.kodax/skills/review' }] },
    });
    for (const role of ['user', 'service'] as const) {
      const other = await ready({ role, call });
      expect(await other.request('s', 'skill.list')).toEqual({ jsonrpc: '2.0', id: 's', result: { items: [{ name: 'review' }] } });
    }
  });

  it('refuses a request id that is still in flight', async () => {
    let release: (() => void) | undefined;
    const h = await ready({
      call: (_method, params) => new Promise((resolve) => { release = () => resolve({ text: String(params.text) }); }),
    });
    h.receive(hostRpcRequest('same', 'echo', { text: 'one' }));
    h.receive(hostRpcRequest('same', 'echo', { text: 'two' }));
    await vi.waitFor(() => expect(h.frames).toHaveLength(2));
    expect(errorData(h.frames[1]!)).toMatchObject({ kodaxCode: 'invalid_params', reason: 'request_id_in_flight' });
    release!();
    await vi.waitFor(() => expect(h.frames).toHaveLength(3));
    expect(h.frames[2]).toMatchObject({ id: 'same', result: { text: 'one' } });
    // The id is free again once its answer is out.
    expect(await h.request('same', 'ping')).toMatchObject({ id: 'same', result: {} });
  });

  it('cancels a request in flight when the client says so', async () => {
    const h = await ready({
      call: (_method, _params, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new HostProtocolError('cancelled', 'Cancelled by the client.')));
      }),
    });
    const pending = h.request('e', 'echo', { text: 'hi' });
    h.receive(hostRpcNotification('request.cancel', { id: 'e' }));
    expect(errorData(await pending)).toMatchObject({ kodaxCode: 'cancelled' });
    // Cancelling something that already finished is not an error and gets no reply.
    h.receive(hostRpcNotification('request.cancel', { id: 'e' }));
    h.receive(hostRpcNotification('some.future.notice', { a: 1 }));
    expect(h.frames).toHaveLength(2);
  });

  it('answers a frame that is not a message', async () => {
    const h = await ready();
    h.receive('{nope');
    h.receive([hostRpcRequest('a', 'ping')]);
    expect(h.frames.slice(1).map(errorData)).toMatchObject([
      { kodaxCode: 'invalid_params', reason: 'parse_error' },
      { kodaxCode: 'invalid_params', reason: 'batch_unsupported' },
    ]);
  });

  it('stops work in flight and sends nothing more once closed', async () => {
    let aborted = false;
    let finish: (() => void) | undefined;
    const h = await ready({
      call: (_method, _params, signal) => new Promise((resolve) => {
        signal.addEventListener('abort', () => { aborted = true; });
        finish = () => resolve({ text: 'late' });
      }),
    });
    h.receive(hostRpcRequest('e', 'echo', { text: 'hi' }));
    await vi.waitFor(() => expect(finish).toBeDefined());
    h.close();
    h.close();
    finish!();
    h.receive(hostRpcRequest('p', 'ping'));
    await new Promise<void>((resolve) => { setImmediate(resolve); });

    expect(aborted).toBe(true);
    expect(h.closeAdmission).toHaveBeenCalledTimes(1);
    expect(h.frames).toHaveLength(1);
  });
});
