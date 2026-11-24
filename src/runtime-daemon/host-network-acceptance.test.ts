/**
 * The M1b acceptance path: a real Host network listener behind a reverse proxy,
 * reached only through the proxy with the SDK's own `connectKodaXHost`, JWTs
 * from a loopback key set, and a scripted model.
 *
 * Node's global WebSocket sends no `Origin`, so the Host treats these clients as
 * non-browser ones. This proves the protocol path a web UI takes, not a browser
 * engine; the real-browser check waits for the Space web UI.
 */
import { createHash, createSign, generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer, request as httpRequest, type Server } from 'node:http';
import { connect as connectTcp, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { awaitLatestCodingMemoryReviewDrain } from '@kodax-ai/coding';
import {
  KodaXBaseProvider, registerModelProvider, type KodaXMessage, type KodaXProviderConfig, type KodaXStreamResult,
} from '@kodax-ai/llm';

import { createKodaXRuntime } from '../../tests/runtime-fixture.js';
import { createHostA2AMount, type HostA2AMount } from '../a2a/host-mount.js';
import { realmA2APrincipalKey } from '../a2a/principal-key.js';
import { prepareKodaXA2AServer } from '../a2a/server.js';
import type { HostConnectionState, KodaXHostClient } from '../host-protocol/host-client.js';
import { connectKodaXHost, openHostWebSocket } from '../host-protocol/remote-host.js';
import { startRuntimeDaemonHost } from './host.js';
import { readRuntimeDaemonLog, resolveRuntimeDaemonPaths, tryAcquireRuntimeDaemonLock } from './state.js';
import type { RuntimeDaemonEndpoint } from './transport.js';

const MODEL = 'host-network-acceptance-provider';
const AUDIENCE = 'kodax-host-acceptance';
const ONE_PIXEL_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
// Writing a project's own KodaX configuration always needs a person's answer.
const WRITE = { path: '.kodax/note.txt', content: 'note' };
const QUESTION = { question: 'Which colour?', options: [{ label: 'Red', value: 'red' }, { label: 'Blue', value: 'blue' }] };
const LOOKUP = {
  name: 'lookup_order', description: 'Finds an order by its id.', sideEffect: 'none' as const,
  inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
};

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  // Newest first: clients close before the Host, the Host before its files go.
  for (const task of cleanup.splice(0).reverse()) await task();
});

/** What the model answers for one request; `undefined` answers `done`. */
type ModelTurn = (messages: readonly KodaXMessage[]) => KodaXStreamResult | undefined;

/** A model that calls one tool and, once it has the result, answers `done`. */
function callsToolOnce(name: string, input: Record<string, unknown>): ModelTurn {
  return (messages) => {
    const last = messages.at(-1)?.content;
    if (Array.isArray(last) && last.some(block => block.type === 'tool_result')) return undefined;
    return { textBlocks: [], thinkingBlocks: [], stopReason: 'tool_use', toolBlocks: [{ type: 'tool_use', id: 'call-1', name, input }] };
  };
}

/** A scripted model registered as a provider. `turn` decides each answer; `hold()` makes it wait. */
function registerScriptedModel() {
  let turn: ModelTurn = () => undefined;
  const requests: Array<{ readonly tools: readonly string[]; readonly text: string }> = [];
  let gate: Promise<void> = Promise.resolve();
  let release = (): void => undefined;
  let entered = (): void => undefined;
  class ScriptedProvider extends KodaXBaseProvider {
    readonly name = MODEL;
    readonly supportsThinking = false;
    protected readonly config: KodaXProviderConfig = {
      apiKeyEnv: 'KODAX_HOST_ACCEPTANCE_KEY', model: 'host-acceptance', supportsThinking: false,
    };
    async stream(...args: Parameters<KodaXBaseProvider['stream']>): Promise<KodaXStreamResult> {
      const tools = args[1].map(tool => tool.name);
      requests.push({ tools, text: JSON.stringify([args[2], args[0]]) });
      // The memory review a finished Run starts is not part of the script.
      const review = tools.includes('commit_episode_learning_review');
      if (!review) entered();
      const signal = args[5];
      await new Promise<void>((resolve, reject) => {
        const aborted = () => reject(signal!.reason);
        if (signal?.aborted) return aborted();
        signal?.addEventListener('abort', aborted, { once: true });
        void gate.then(() => {
          signal?.removeEventListener('abort', aborted);
          resolve();
        });
      });
      signal?.throwIfAborted();
      return (review ? undefined : turn(args[0])) ?? { textBlocks: [{ type: 'text', text: 'done' }], toolBlocks: [], thinkingBlocks: [] };
    }
  }
  vi.stubEnv('KODAX_HOST_ACCEPTANCE_KEY', 'offline-test');
  const unregister = registerModelProvider(MODEL, () => new ScriptedProvider());
  return {
    script: (next: ModelTurn) => { turn = next; },
    /** The last request of a Run, leaving out memory reviews. */
    lastRunRequest: () => [...requests].reverse().find(request => !request.tools.includes('commit_episode_learning_review'))!,
    hold(): { readonly called: Promise<void>; readonly release: () => void } {
      gate = new Promise<void>((resolve) => { release = resolve; });
      return { called: new Promise<void>((resolve) => { entered = resolve; }), release: () => release() };
    },
    dispose: async () => {
      release();
      await awaitLatestCodingMemoryReviewDrain(5_000);
      unregister();
    },
  };
}

/** A key set on loopback, and tokens it signs for this Host. */
async function startIdentityProvider() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig' };
  const server = createHttpServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ keys: [jwk] }));
  });
  await listen(server);
  const issuer = 'https://idp.example.test/realm';
  return {
    issuer,
    jwksUrl: `http://127.0.0.1:${portOf(server)}/jwks`,
    /** A token for `sub` that lives `seconds`. */
    token: (sub: string, seconds = 300) => signJwt(privateKey, {
      iss: issuer, aud: AUDIENCE, sub, exp: Math.floor(Date.now() / 1000) + seconds,
    }),
    close: () => closeServer(server),
  };
}

function signJwt(key: KeyObject, claims: Record<string, unknown>): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  const input = `${encode({ alg: 'RS256', kid: 'k1', typ: 'JWT' })}.${encode(claims)}`;
  return `${input}.${createSign('sha256').update(input).sign(key).toString('base64url')}`;
}

/** The smallest reverse proxy: plain requests forwarded, WebSocket upgrades piped as bytes. */
/** With `blockWebSockets` it turns every WebSocket away, as some corporate proxies do, and passes plain HTTP. */
async function startReverseProxy(targetPort: number, blockWebSockets = false) {
  let upgrades = 0;
  const server = createHttpServer((request, response) => {
    const upstream = httpRequest({
      host: '127.0.0.1', port: targetPort, method: request.method, path: request.url, headers: request.headers,
    }, (answer) => {
      response.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(response);
    });
    upstream.on('error', () => response.destroy());
    request.pipe(upstream);
  });
  server.on('upgrade', (request, socket, head) => {
    upgrades += 1;
    if (blockWebSockets) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const upstream = connectTcp(targetPort, '127.0.0.1', () => {
      const lines = [`${request.method} ${request.url} HTTP/1.1`];
      for (let index = 0; index < request.rawHeaders.length; index += 2) {
        lines.push(`${request.rawHeaders[index]}: ${request.rawHeaders[index + 1]}`);
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
  await listen(server);
  return {
    url: `http://127.0.0.1:${portOf(server)}`, upgrades: () => upgrades, close: () => closeServer(server),
    /** Cuts every plain HTTP connection through it, as a network that drops does. */
    drop: () => server.closeAllConnections(),
  };
}

function listen(server: Server): Promise<void> {
  return new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
}

function portOf(server: Server): number {
  return (server.address() as AddressInfo).port;
}

function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise<void>(resolve => server.close(() => resolve()));
}

function testEndpoint(root: string): RuntimeDaemonEndpoint {
  return process.platform === 'win32'
    ? { kind: 'pipe', path: `\\\\.\\pipe\\kodax-host-acceptance-${randomUUID()}` }
    : { kind: 'unix', path: path.join(root, 'daemon.sock') };
}

/** What the Host's port serves at `/a2a` when a test asks for it: the Runtime default Agent, reading only. */
async function startA2A(runtime: Awaited<ReturnType<typeof createKodaXRuntime>>, dataDir: string): Promise<HostA2AMount> {
  const host = createHostA2AMount();
  const server = await prepareKodaXA2AServer({
    runtime,
    dataDir,
    agent: {
      name: 'Host Agent', description: 'Served on the Host port.', version: '1.0.0', publicBaseUrl: 'https://agent.example.test',
      skills: [], inputModes: ['text/plain'], outputModes: ['text/plain'],
    },
    execution: {
      kind: 'runtime-default',
      workspace: { mode: 'managed' },
      toolPolicy: {
        workspace: 'read', process: 'deny', network: { mode: 'deny' }, tools: [], mcp: {}, skillScripts: {}, subagents: 'deny',
      },
    },
    limits: {
      maxRequestBytes: 64 * 1024, maxPartBytes: 32 * 1024, maxConcurrentTasks: 2, maxTaskWaitMs: 10_000,
      maxWorkspaceBytesPerContext: 1024 * 1024,
    },
    authentication: host.authentication,
    authorize: async () => true,
  });
  cleanup.push(() => server.close());
  return host.mount(server);
}

/** A Host on a fresh home that listens on the network for `person-1` and `backend-1`, behind a reverse proxy. */
async function startProxiedHost(options: { readonly blockWebSockets?: boolean; readonly a2a?: boolean } = {}) {
  const homeDir = await realpath(await mkdtemp(path.join(tmpdir(), 'kodax-host-acceptance-')));
  cleanup.push(() => rm(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const kodaxHome = path.join(homeDir, '.kodax');
  const workspaceRoot = path.join(homeDir, 'workspace');
  await mkdir(path.join(workspaceRoot, 'app'), { recursive: true });
  await mkdir(path.join(kodaxHome, 'integrations'), { recursive: true });
  vi.stubEnv('KODAX_HOME', kodaxHome);
  const model = registerScriptedModel();
  cleanup.push(async () => {
    await model.dispose();
    vi.unstubAllEnvs();
  });
  const idp = await startIdentityProvider();
  cleanup.push(() => idp.close());
  await writeFile(path.join(kodaxHome, 'integrations', 'host.json'), JSON.stringify({
    version: 1,
    server: {
      listen: { hostname: '127.0.0.1', port: 0 },
      jwt: { issuer: idp.issuer, audience: AUDIENCE, jwksUrl: idp.jwksUrl },
      owner: 'person-1',
      services: ['backend-1'],
      workspaceRoot,
    },
  }));

  // As the Host starts it: interactions wait for an attached client instead of being refused.
  const runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true, defaultProvider: MODEL });
  cleanup.push(() => runtime.close());
  const a2aDataDir = path.join(homeDir, 'a2a-data');
  const a2a = options.a2a === true ? await startA2A(runtime, a2aDataDir) : undefined;
  const paths = resolveRuntimeDaemonPaths(kodaxHome, 'default');
  const lock = tryAcquireRuntimeDaemonLock(paths, {
    runtimeId: runtime.identity.runtimeId, pid: process.pid, createdAt: runtime.identity.startedAt,
  });
  if (!lock) throw new Error('Expected the daemon lock of a fresh home.');
  const host = await startRuntimeDaemonHost({
    runtime, paths, endpoint: testEndpoint(homeDir), lock, networkConfigHome: kodaxHome, orphanExitMs: 60_000,
    sessionsDir: path.join(kodaxHome, 'sessions'),
    ...(a2a !== undefined ? { a2a: () => a2a } : {}),
  });
  cleanup.push(() => host.close());
  const port = readRuntimeDaemonLog(paths).find(entry => entry.message === 'Runtime daemon listening on the network.')?.data?.port;
  if (typeof port !== 'number') throw new Error('Expected the Host to log the port it listens on.');
  const proxy = await startReverseProxy(port, options.blockWebSockets);
  cleanup.push(() => proxy.close());

  const errors: unknown[] = [];
  let instances = 0;
  const tokens = new Map<string, number>();
  /** A client of the Host through the proxy, fetching a token for `subject` for each connection and renewal. */
  const connect = async (subject: string, seconds?: number): Promise<KodaXHostClient> => {
    instances += 1;
    const client = await connectKodaXHost({
      url: proxy.url,
      client: { name: 'acceptance', version: '1.0.0', instanceId: `acceptance-${instances}` },
      credential: () => {
        tokens.set(subject, (tokens.get(subject) ?? 0) + 1);
        return idp.token(subject, seconds);
      },
      onError: error => errors.push(error),
    });
    cleanup.push(() => client.close());
    return client;
  };
  return {
    homeDir, projectRoot: path.join(workspaceRoot, 'app'), model, idp, proxy, connect, errors, a2aDataDir,
    /** How many tokens were fetched for `subject`: one per connection and one per renewal. */
    tokensFor: (subject: string) => tokens.get(subject) ?? 0,
  };
}

type Host = Awaited<ReturnType<typeof startProxiedHost>>;

/** The one interaction a Session is waiting on, once it is. */
function pendingInteraction(client: KodaXHostClient, sessionId: string) {
  return vi.waitFor(async () => {
    const { items } = await client.call('interaction.list', { sessionId });
    if (items.length !== 1) throw new Error(`Waiting for one interaction, there are ${items.length}.`);
    return items[0]!;
  }, { timeout: 10_000, interval: 20 });
}

/** Uploads bytes the way a client does: begin, write in one chunk, commit. */
async function uploadImage(client: KodaXHostClient, sessionId: string, bytes: Buffer) {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const { blobId } = await client.call('blob.begin', {
    requestId: 'begin-1', sessionId, mediaType: 'image/png', byteLength: bytes.length, sha256,
  });
  await client.call('blob.write', { requestId: 'write-1', sessionId, blobId, offset: 0, data: bytes.toString('base64') });
  return (await client.call('blob.commit', { requestId: 'commit-1', sessionId, blobId })).blob;
}

async function submit(client: KodaXHostClient, sessionId: string, requestId: string, text: string, extra: Record<string, unknown> = {}) {
  const { input } = await client.call('input.submit', { requestId, sessionId, text, ...extra });
  if (input.runId === undefined) throw new Error(`Input ${requestId} was given no Run.`);
  return input.runId;
}

describe('a Host reached through a reverse proxy with the SDK', () => {
  it('serves a person through submit, approval with the diff, a question, Stop, and images both ways', async () => {
    const host: Host = await startProxiedHost();
    const person = await host.connect('person-1');
    expect(person.handshake).toMatchObject({ role: 'user', subject: 'person' });
    expect(host.proxy.upgrades()).toBe(1);
    const { session } = await person.call('session.create', { requestId: 'create-1', project: 'app' });

    // Submit.
    const first = await submit(person, session.id, 'input-1', 'Say done.');
    expect((await person.call('run.wait', { runId: first })).run.outcome).toMatchObject({ status: 'completed' });

    // An approval the person sees with the diff, and allows.
    host.model.script(callsToolOnce('write', WRITE));
    const wrote = await submit(person, session.id, 'input-2', 'Take a note.');
    const permission = await pendingInteraction(person, session.id);
    expect(permission).toMatchObject({ kind: 'permission', runId: wrote, request: { toolName: 'write' } });
    expect(permission.kind === 'permission' ? permission.request.diff : undefined)
      .toEqual({ path: 'app/.kodax/note.txt', added: 1, removed: 0, unified: '@@ -0,0 +1,1 @@\n+note' });
    expect(await person.call('interaction.respond', {
      requestId: 'answer-1', interactionId: permission.id, response: { kind: 'permission', decision: { type: 'allow_once' } },
    })).toEqual({ status: 'answered' });
    expect((await person.call('run.wait', { runId: wrote })).run.outcome).toMatchObject({ status: 'completed' });
    expect(existsSync(path.join(host.projectRoot, WRITE.path))).toBe(true);

    // A question the person answers.
    host.model.script(callsToolOnce('ask_user_question', QUESTION));
    const asked = await submit(person, session.id, 'input-3', 'Ask me.');
    const question = await pendingInteraction(person, session.id);
    expect(question).toMatchObject({ kind: 'question', runId: asked, request: QUESTION });
    expect(await person.call('interaction.respond', {
      requestId: 'answer-2', interactionId: question.id, response: { kind: 'question', answer: 'red' },
    })).toEqual({ status: 'answered' });
    expect((await person.call('run.wait', { runId: asked })).run.outcome).toMatchObject({ status: 'completed' });
    expect(host.model.lastRunRequest().text).toContain('red');

    // Stop a Run while the model is still thinking.
    host.model.script(() => undefined);
    const held = host.model.hold();
    const slow = await submit(person, session.id, 'input-4', 'Wait.');
    await held.called;
    expect(await person.call('run.stop', { requestId: 'stop-1', runId: slow })).toEqual({});
    const stopped = (await person.call('run.wait', { runId: slow })).run;
    expect(stopped.outcome).toMatchObject({ status: 'interrupted', code: 'interrupted' });
    expect(stopped.stop).toEqual({ requestedAt: expect.any(Number), confirmed: true });
    held.release();

    // An image the person uploads reaches the model.
    const upload = await uploadImage(person, session.id, ONE_PIXEL_PNG);
    const looked = await submit(person, session.id, 'input-5', 'What is in this picture?', { attachments: [{ blobId: upload.blobId }] });
    expect((await person.call('run.wait', { runId: looked })).run.outcome).toMatchObject({ status: 'completed' });
    expect(host.model.lastRunRequest().text).toContain('"type":"image"');

    // An image a tool produced comes back as the attachment of its item, and downloads.
    await writeFile(path.join(host.projectRoot, 'pixel.png'), ONE_PIXEL_PNG);
    host.model.script(callsToolOnce('read', { path: 'pixel.png' }));
    const read = await submit(person, session.id, 'input-6', 'Look at pixel.png.');
    expect((await person.call('run.wait', { runId: read })).run.outcome).toMatchObject({ status: 'completed' });
    const views: unknown[] = [];
    const observation = await person.observeSession(session.id, { onView: view => views.push(view) });
    observation.close();
    const view = views.at(-1) as { readonly items: ReadonlyArray<{ readonly tool?: { readonly name: string }; readonly attachments?: ReadonlyArray<{ readonly blobId: string; readonly path?: string }> }> };
    const produced = view.items.find(item => item.tool?.name === 'read' && item.attachments !== undefined)?.attachments?.[0];
    if (produced === undefined) throw new Error('The read tool item carries no image attachment.');
    expect(produced.path).toBeUndefined();
    expect(await person.call('blob.read', { sessionId: session.id, blobId: produced.blobId })).toMatchObject({
      data: ONE_PIXEL_PNG.toString('base64'), mediaType: 'image/png', byteLength: ONE_PIXEL_PNG.length,
    });
    // One link the whole way, through the proxy.
    expect(host.proxy.upgrades()).toBe(1);
    expect(host.errors).toEqual([]);
  }, 120_000);

  it('reaches the Host over HTTP where the proxy lets no WebSocket through, and stays on HTTP when it reconnects', async () => {
    const host: Host = await startProxiedHost({ blockWebSockets: true });
    const person = await host.connect('person-1');
    expect(person.handshake).toMatchObject({ role: 'user', subject: 'person' });
    expect(host.proxy.upgrades()).toBe(1);
    const { session } = await person.call('session.create', { requestId: 'create-1', project: 'app' });

    // The view arrives over the event stream while a question waits, and the answer goes up in a POST.
    const views: Array<{ readonly items: readonly unknown[] }> = [];
    const observation = await person.observeSession(session.id, { onView: view => views.push(view as { readonly items: readonly unknown[] }) });
    host.model.script(callsToolOnce('ask_user_question', QUESTION));
    const asked = await submit(person, session.id, 'input-1', 'Ask me.');
    const question = await pendingInteraction(person, session.id);
    expect(await person.call('interaction.respond', {
      requestId: 'answer-1', interactionId: question.id, response: { kind: 'question', answer: 'red' },
    })).toEqual({ status: 'answered' });
    expect((await person.call('run.wait', { runId: asked })).run.outcome).toMatchObject({ status: 'completed' });
    await vi.waitFor(() => expect(views.at(-1)?.items.length).toBeGreaterThanOrEqual(2));
    observation.close();

    // A frame larger than one batch goes up on its own.
    const upload = await uploadImage(person, session.id, Buffer.alloc(500 * 1024, 1));
    expect(upload).toMatchObject({ byteLength: 500 * 1024 });

    // The network drops; the client comes back on HTTP without trying the WebSocket that failed.
    const states: string[] = [];
    person.onConnectionChange(state => states.push(state.state));
    host.proxy.drop();
    await vi.waitFor(() => expect(states).toEqual(['connected', 'reconnecting', 'connected']), { timeout: 10_000 });
    await expect(person.call('ping')).resolves.toEqual({});
    expect(host.proxy.upgrades()).toBe(1);
    expect(host.errors).toEqual([]);
  }, 120_000);

  it('ends a connection when its token runs out while its Run goes on, and keeps one that renews with its lease', async () => {
    const host: Host = await startProxiedHost();
    const person = await host.connect('person-1');
    const { session } = await person.call('session.create', { requestId: 'create-1', project: 'app' });

    // One connection of the SDK whose token lasts two seconds and is not renewed.
    let issued = 0;
    const renewals: unknown[] = [];
    const brief = await openHostWebSocket({
      url: host.proxy.url,
      client: { name: 'acceptance', version: '1.0.0', instanceId: 'acceptance-brief' },
      credential: () => {
        issued += 1;
        if (issued > 1) throw new Error('No second token for this connection.');
        return host.idp.token('person-1', 2);
      },
      onError: error => renewals.push(error),
    })(new AbortController().signal);
    cleanup.push(() => brief.close());
    expect(brief.handshake.expiresAt).toEqual(expect.any(Number));
    const held = host.model.hold();
    const { input } = await brief.request('input.submit', { requestId: 'input-1', sessionId: session.id, text: 'Wait.' }) as {
      readonly input: { readonly runId?: string };
    };
    await held.called;
    await brief.closed;
    expect(brief.ended?.error).toMatchObject({ kodaxCode: 'unauthorized', reason: 'credential' });
    expect(renewals).toEqual([expect.objectContaining({ message: 'No second token for this connection.' })]);
    // The Run did not end with the connection that submitted it.
    expect((await person.call('run.get', { runId: input.runId! })).run.outcome).toBeUndefined();
    held.release();
    expect((await person.call('run.wait', { runId: input.runId! })).run.outcome).toMatchObject({ status: 'completed' });

    // A backend whose tokens last three seconds renews them on the same connection, and its lease still serves.
    const backend = await host.connect('backend-1', 3);
    const states: HostConnectionState['state'][] = [];
    backend.onConnectionChange(state => states.push(state.state));
    expect(await backend.call('lease.register', { requestId: 'tools-1', kind: 'host_tool', tools: [LOOKUP] }))
      .toMatchObject({ lease: { id: 'tools-1' } });
    const firstExpiry = backend.handshake.expiresAt!;
    await vi.waitFor(() => expect(Date.now()).toBeGreaterThan(firstExpiry + 1_000), { timeout: 10_000, interval: 100 });
    expect(states).toEqual(['connected']);
    // The first token and at least one renewal, on the one link.
    expect(host.tokensFor('backend-1')).toBeGreaterThan(1);
    backend.answerToolCalls(async () => ({ content: 'Order A1 ships on Friday.' }));
    host.model.script((messages) => (JSON.stringify(messages).includes('tool_result') ? undefined
      : { textBlocks: [], thinkingBlocks: [], stopReason: 'tool_use', toolBlocks: [{ type: 'tool_use', id: 'call-1', name: 'lookup_order', input: { id: 'A1' } }] }));
    const lookup = await submit(backend, session.id, 'input-2', 'When does A1 ship?', { leases: { hostTools: 'tools-1' } });
    expect((await backend.call('run.wait', { runId: lookup })).run.outcome).toMatchObject({ status: 'completed' });
    expect(host.model.lastRunRequest().text).toContain('Order A1 ships on Friday.');
    expect(states).toEqual(['connected']);
    expect(host.errors).toEqual([]);
  }, 60_000);

  it('serves A2A at /a2a on the same port to whom it admits on v2, and keys its tasks by that identity', async () => {
    const host: Host = await startProxiedHost({ a2a: true });
    const rpc = (method: string, params: Record<string, unknown>, token?: string) => fetch(`${host.proxy.url}/a2a`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', 'a2a-version': '1.0',
        ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: method, method, params }),
    });
    const message = (messageId: string) => ({
      message: { messageId, contextId: 'ctx-1', role: 'ROLE_USER', parts: [{ text: 'Say done.' }] },
    });

    const card = await (await fetch(`${host.proxy.url}/.well-known/agent-card.json`)).json() as Record<string, unknown>;
    expect(card).toMatchObject({
      supportedInterfaces: [expect.objectContaining({ url: 'https://agent.example.test/a2a' })],
      securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: 'Bearer', bearerFormat: 'JWT' } } },
    });
    expect((await rpc('SendMessage', message('m-0'))).status).toBe(401);
    expect((await rpc('SendMessage', message('m-0'), host.idp.token('stranger'))).status).toBe(401);

    const sent = await (await rpc('SendMessage', message('m-1'), host.idp.token('backend-1'))).json() as {
      readonly result?: { readonly task?: { readonly id: string; readonly status: { readonly state: string } } };
    };
    expect(sent.result?.task?.status.state).toBe('TASK_STATE_COMPLETED');
    // Another backend cannot read the task: it belongs to service:backend-1.
    const other = await (await rpc('GetTask', { id: sent.result!.task!.id }, host.idp.token('person-1'))).json() as Record<string, unknown>;
    expect(other).toMatchObject({ error: expect.anything() });

    const tasks = JSON.parse(await readFile(path.join(host.a2aDataDir, 'tasks.json'), 'utf8')) as Array<{ readonly principalKey: string }>;
    expect(tasks.map(task => task.principalKey)).toEqual([
      realmA2APrincipalKey({ securityRealm: 'kodax-host', subject: 'service:backend-1' }),
    ]);
  }, 60_000);

  it('runs a backend Run that only has the business tool it lends', async () => {
    const host: Host = await startProxiedHost();
    const backend = await host.connect('backend-1');
    expect(backend.handshake).toMatchObject({ role: 'service', subject: 'service:backend-1' });
    await backend.call('lease.register', { requestId: 'tools-1', kind: 'host_tool', tools: [LOOKUP] });
    const calls: string[] = [];
    backend.answerToolCalls(async (call) => {
      calls.push(call.tool);
      return { content: 'Order A1 ships on Friday.' };
    });
    host.model.script((messages) => (JSON.stringify(messages).includes('tool_result') ? undefined
      : { textBlocks: [], thinkingBlocks: [], stopReason: 'tool_use', toolBlocks: [{ type: 'tool_use', id: 'call-1', name: 'lookup_order', input: { id: 'A1' } }] }));
    const { session } = await backend.call('session.create', { requestId: 'create-1', project: 'app', policy: { tools: ['lookup_order'] } });

    const runId = await submit(backend, session.id, 'input-1', 'When does A1 ship?', { leases: { hostTools: 'tools-1' } });
    expect((await backend.call('run.wait', { runId })).run.outcome).toMatchObject({ status: 'completed' });
    expect(host.model.lastRunRequest().tools).toEqual(['lookup_order']);
    expect(calls).toEqual(['lookup_order']);
    expect(host.model.lastRunRequest().text).toContain('Order A1 ships on Friday.');
    expect(host.errors).toEqual([]);
  }, 60_000);
});
