import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  KodaXBaseProvider,
  clearRuntimeModelProviders,
  registerModelProvider,
  registerCustomProviders,
  type KodaXProviderConfig,
  type KodaXStreamResult,
} from '@kodax-ai/llm';
import { connectKodaXClient } from '@kodax-ai/kodax/client';
import { FileSessionStorage } from '@kodax-ai/repl';
import { createKodaXRuntime } from './sdk-runtime.js';
import { startRuntimeDaemonHost } from './runtime-daemon/host.js';
import { resolveRuntimeDaemonPaths, tryAcquireRuntimeDaemonLock } from './runtime-daemon/state.js';

class InputTestProvider extends KodaXBaseProvider {
  readonly name = 'product-input-test';
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'KODAX_PRODUCT_INPUT_TEST_KEY',
    model: 'product-input-test',
    supportsThinking: false,
  };
  constructor(private readonly onRequest: () => void | Promise<void>) { super(); }
  async stream(): Promise<KodaXStreamResult> {
    await this.onRequest();
    return {
      textBlocks: [{ type: 'text', text: 'The requested input was processed.' }],
      thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn',
    };
  }
}

it('accepts an immediate input once across clients and rejects reuse for a different intent', async () => {
  const second = await connectKodaXClient({ homeDir, endpoint: endpointPath });
  try {
    const session = await client.sessions.create({ title: 'One input', projectPath: homeDir });
    await runtime.sessions.updateSettings(session.id, { permissionMode: 'full-access', agentMode: 'sa' });
    const input = { sessionId: session.id, inputId: 'input-one', text: 'Process this request once.' };
    const [accepted, duplicate] = await Promise.all([client.inputs.submit(input), second.inputs.submit(input)]);
    expect(accepted.state).toBe('submitted');
    expect(duplicate).toEqual(accepted);
    await runtime.runs.await(accepted.runId!);
    expect(requests).toBe(1);
    expect(await second.inputs.submit(input)).toEqual(accepted);
    expect(await second.inputs.read(session.id, input.inputId)).toEqual(accepted);
    await expect(second.inputs.submit({ ...input, text: 'A different request.' })).rejects.toMatchObject({ code: 'conflict' });
    expect(requests).toBe(1);
  } finally {
    await second.disconnect();
  }
});

let homeDir: string;
let endpointPath: string;
let storage: FileSessionStorage;
let runtime: Awaited<ReturnType<typeof createKodaXRuntime>>;
let host: Awaited<ReturnType<typeof startRuntimeDaemonHost>>;
let client: Awaited<ReturnType<typeof connectKodaXClient>>;
let onRequest: () => void | Promise<void> = () => undefined;
let requests = 0;

beforeEach(async () => {
  homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-input-durability-'));
  storage = new FileSessionStorage({ sessionsDir: path.join(homeDir, '.kodax', 'sessions') });
  requests = 0;
  onRequest = () => undefined;
  vi.stubEnv('KODAX_PRODUCT_INPUT_TEST_KEY', 'test-only');
  registerModelProvider('product-input-test', () => new InputTestProvider(async () => {
    requests += 1;
    await onRequest();
  }));
  runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true, defaultProvider: 'product-input-test' });
  const paths = resolveRuntimeDaemonPaths(homeDir);
  const lock = tryAcquireRuntimeDaemonLock(paths, {
    runtimeId: runtime.identity.runtimeId, pid: process.pid, createdAt: runtime.identity.startedAt,
  });
  if (!lock) throw new Error('Could not acquire isolated test Host.');
  const endpoint = process.platform === 'win32'
    ? { kind: 'pipe' as const, path: `\\\\.\\pipe\\kodax-input-${randomUUID()}` }
    : { kind: 'unix' as const, path: path.join(homeDir, 'host.sock') };
  host = await startRuntimeDaemonHost({ runtime, paths, lock, endpoint });
  endpointPath = endpoint.path;
  client = await connectKodaXClient({ homeDir, endpoint: endpoint.path });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await client.disconnect();
  await host.close();
  await runtime.close();
  clearRuntimeModelProviders();
  vi.unstubAllEnvs();
  await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

it('persists the canonical input identity before the Provider can consume it', async () => {
  const session = await client.sessions.create({ projectPath: homeDir });
  await runtime.sessions.updateSettings(session.id, { permissionMode: 'full-access', agentMode: 'sa' });
  const input = { sessionId: session.id, inputId: 'durable-input', text: 'Save this before executing.' };
  let persistedAtRequest: Awaited<ReturnType<FileSessionStorage['load']>>;
  onRequest = async () => { persistedAtRequest = await storage.load(session.id); };
  const accepted = await client.inputs.submit(input);
  expect((await runtime.runs.await(accepted.runId!)).phase).toBe('completed');
  expect(persistedAtRequest!.messages).toContainEqual(expect.objectContaining({
    role: 'user', content: input.text, inputId: input.inputId,
  }));
  expect((await storage.load(session.id))!.messages.filter((message) => message.role === 'user')).toHaveLength(1);
});

it('returns the original acceptance during compaction while rejecting new input', async () => {
  const session = await client.sessions.create({ projectPath: homeDir });
  await client.sessions.updateSettings(session.id, { permissionMode: 'full-access', agentMode: 'sa' });
  const input = { sessionId: session.id, inputId: 'before-compact', text: 'Keep this accepted request identity.' };
  const accepted = await client.inputs.submit(input);
  await runtime.runs.await(accepted.runId!);
  let release = () => {};
  const waiting = new Promise<void>(resolve => { release = resolve; });
  let entered = false;
  onRequest = () => { entered = true; return waiting; };
  const compacting = runtime.sessions.compact({
    sessionId: session.id, provider: 'product-input-test', contextWindow: 60_000, triggerTokens: 1,
  });
  try {
    await expect.poll(() => entered).toBe(true);
    expect(await client.inputs.submit(input)).toEqual(accepted);
    await expect(client.inputs.submit({ ...input, inputId: 'new-during-compact' }))
      .rejects.toMatchObject({ code: 'conflict' });
  } finally {
    release();
    await compacting;
  }
});

it('rejects input persistence failure without starting a Provider or accepting the input', async () => {
  const session = await client.sessions.create({ projectPath: homeDir });
  await runtime.sessions.updateSettings(session.id, { permissionMode: 'full-access', agentMode: 'sa' });
  const input = { sessionId: session.id, inputId: 'cannot-save', text: 'This must not run.' };
  const originalSave = FileSessionStorage.prototype.save;
  vi.spyOn(FileSessionStorage.prototype, 'save').mockImplementation(function (this: FileSessionStorage, id, data) {
    if (id === session.id && data.messages.some((message) => message.content === input.text)) {
      return Promise.reject(new Error('Injected canonical input save failure'));
    }
    return originalSave.call(this, id, data);
  });
  await expect(client.inputs.submit(input)).rejects.toThrow('Injected canonical input save failure');
  expect(requests).toBe(0);
  expect(await client.inputs.read(session.id, input.inputId)).toBeNull();
});

it('deletes a temporary Session after its task settles even when the client disconnects', async () => {
  const session = await client.sessions.create({ projectPath: homeDir, temporary: true });
  await runtime.sessions.updateSettings(session.id, { permissionMode: 'full-access', agentMode: 'sa' });
  let release: () => void = () => undefined;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  let markEntered = () => {};
  const entered = new Promise<void>(resolve => { markEntered = resolve; });
  onRequest = () => { markEntered(); return waiting; };
  try {
    const accepted = await client.inputs.submit({ sessionId: session.id, inputId: 'temporary-input', text: 'Run temporarily.' });
    await entered;
    expect(requests).toBe(1);
    await client.disconnect();
    release();
    expect((await runtime.runs.await(accepted.runId!)).phase).toBe('completed');
    expect(await storage.load(session.id)).toBeNull();
    expect(await runtime.sessions.list()).not.toContainEqual(expect.objectContaining({ id: session.id }));
  } finally {
    release();
  }
});

it('does not transparently resubmit an old connection after the Host changes', async () => {
  const session = await client.sessions.create({ projectPath: homeDir });
  await runtime.sessions.updateSettings(session.id, { permissionMode: 'full-access', agentMode: 'sa' });
  const input = { sessionId: session.id, inputId: 'old-host-input', text: 'Accept in this Host only.' };
  const accepted = await client.inputs.submit(input);
  await runtime.runs.await(accepted.runId!);
  const oldClient = client;
  await host.close();
  await runtime.close();
  runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true, defaultProvider: 'product-input-test' });
  const paths = resolveRuntimeDaemonPaths(homeDir);
  const lock = tryAcquireRuntimeDaemonLock(paths, {
    runtimeId: runtime.identity.runtimeId, pid: process.pid, createdAt: runtime.identity.startedAt,
  });
  if (!lock) throw new Error('Could not acquire replacement test Host.');
  const endpoint = { kind: process.platform === 'win32' ? 'pipe' as const : 'unix' as const, path: endpointPath };
  host = await startRuntimeDaemonHost({ runtime, paths, lock, endpoint });
  client = await connectKodaXClient({ homeDir, endpoint: endpointPath });
  await expect(oldClient.inputs.submit(input)).rejects.toThrow();
  await expect(oldClient.inputs.read(session.id, input.inputId)).rejects.toThrow();
  expect(await client.inputs.read(session.id, input.inputId)).toBeNull();
  expect(requests).toBe(1);
  await oldClient.disconnect();
});

it('reports temporary Session cleanup failure instead of claiming successful deletion', async () => {
  const session = await client.sessions.create({ projectPath: homeDir, temporary: true });
  await runtime.sessions.updateSettings(session.id, { permissionMode: 'full-access', agentMode: 'sa' });
  vi.spyOn(FileSessionStorage.prototype, 'deleteOwned').mockRejectedValue(new Error('Injected delete failure'));
  const accepted = await client.inputs.submit({ sessionId: session.id, inputId: 'cleanup-failure', text: 'Finish then clean up.' });
  await expect(runtime.runs.await(accepted.runId!)).rejects.toThrow();
  expect((await storage.load(session.id))?.runtimeInfo?.temporary).toBe(true);
  expect(requests).toBe(1);
});

it('delivers a busy queued image through the real Host to the next Provider request', async () => {
  let release = () => {};
  const waiting = new Promise<void>(resolve => { release = resolve; });
  let markEntered = () => {};
  const entered = new Promise<void>(resolve => { markEntered = resolve; });
  const wireRequests: unknown[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    wireRequests.push(JSON.parse(Buffer.concat(chunks).toString()));
    if (wireRequests.length === 1) { markEntered(); await waiting; }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('data: '+JSON.stringify({ id: 'image-test', object: 'chat.completion.chunk', created: 1, model: 'image-test',
      choices: [{ index: 0, delta: { content: 'Image received.' }, finish_reason: 'stop' }] })+'\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture server address');
  registerCustomProviders([{ name: 'product-image-test', protocol: 'openai', imageInput: true,
    baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKeyEnv: 'KODAX_PRODUCT_INPUT_TEST_KEY', model: 'image-test' }]);
  try {
    const session = await client.sessions.create({ projectPath: homeDir });
    await client.sessions.updateSettings(session.id, { provider: 'product-image-test', model: 'image-test', permissionMode: 'full-access', agentMode: 'sa' });
    const imagePath = path.join(homeDir, 'pixel.png');
    await writeFile(imagePath, await readFile('tests/fixtures/images/valid-png.png'));
    const first = await client.inputs.submit({ sessionId: session.id, inputId: 'busy', text: 'Wait before the image.' });
    await entered;
    expect(wireRequests.length).toBe(1);
    const input = { sessionId: session.id, inputId: 'picture', text: 'Describe this image.', delivery: 'after_turn' as const,
      inputArtifacts: [{ kind: 'image' as const, path: imagePath, mediaType: 'image/png' as const, source: 'clipboard' as const }] };
    expect((await client.inputs.submit(input)).state).toBe('queued');
    await expect(client.inputs.submit({ ...input, inputArtifacts: [] })).rejects.toMatchObject({ code: 'conflict' });
    release();
    await runtime.runs.await(first.runId!);
    await expect.poll(async () => (await client.inputs.read(session.id, 'picture'))?.runId).toBeTruthy();
    const accepted = await client.inputs.read(session.id, 'picture');
    const result = await runtime.runs.await(accepted!.runId!);
    expect(result.phase, JSON.stringify(result)).toBe('completed');
    expect(wireRequests.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(wireRequests[1])).toContain('data:image/png;base64,');
    expect(JSON.stringify(wireRequests[1])).toContain('Describe this image.');
  } finally {
    release();
    registerCustomProviders([]);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
