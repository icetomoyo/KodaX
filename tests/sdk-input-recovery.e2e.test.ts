import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createConnection, createServer as createSocketServer, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { PASTE_TMP_TTL_MS, persistImageAsBlock } from '@kodax-ai/agent';
import { connectKodaXClient } from '../src/sdk-client.js';
import { connectKodaXRuntime } from '../src/sdk-runtime.js';
import type { KodaXClientHostAuthorization } from '../src/client-host-authorization.js';

const ownerIdentity = { name: 'Input owner', instanceId: 'input-owner', instanceSecret: 'owner'.repeat(16) };

async function bounded<T>(promise: Promise<T>, message: string, timeoutMs = 30_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  })]); } finally { clearTimeout(timer); }
}

async function startHost(homeDir: string) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(API_KEY|TOKEN|SECRET|PASSWORD)$/.test(key)));
  const child = spawn(process.execPath, ['--import', 'tsx', resolve('tests/sdk-contract-host.fixture.ts'), homeDir], {
    cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
  });
  let errors = '';
  child.stdout!.resume();
  child.stderr!.on('data', chunk => { errors = (errors + String(chunk)).slice(-16_000); });
  const ready = await bounded(Promise.race([
    once(child, 'message').then(([value]) => value as { endpoint: string; pid: number }),
    once(child, 'exit').then(([code]) => { throw new Error(`Fixture Host exited ${String(code)}: ${errors}`); }),
  ]), 'Input fixture Host readiness timed out');
  expect(ready.pid).not.toBe(process.pid);
  return { child, endpoint: ready.endpoint, async close() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.send('close');
    try { await bounded(exited, 'Input fixture Host close timed out', 15_000); }
    catch { child.kill('SIGKILL'); await bounded(exited, 'Input fixture Host cleanup failed', 5_000); }
  } };
}

async function startMain(homeDir: string, endpoint: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', resolve('tests/sdk-input-main.fixture.ts'), homeDir, endpoint], {
    cwd: process.cwd(), env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(API_KEY|TOKEN|SECRET|PASSWORD)$/.test(key))),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
  });
  child.stdout!.resume();
  let errors = '';
  child.stderr!.on('data', chunk => { errors = (errors + String(chunk)).slice(-16_000); });
  await bounded(Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error(errors); })]), 'Main readiness timed out');
  return { child,
    async submit(input: Parameters<Awaited<ReturnType<typeof connectKodaXClient>>['inputs']['submit']>[0]) {
      const response = once(child, 'message');
      child.send({ input });
      const [value] = await bounded(response, 'Main submit timed out');
      const result = value as { result?: { state: string }; error?: string };
      if (result.error) throw new Error(result.error);
      return result.result;
    },
    async crash() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await bounded(exited, 'Main crash timed out');
    },
  };
}

async function dropWithdrawalResponse(target: string, homeDir: string) {
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\kodax-input-drop-${randomUUID()}` : join(homeDir, 'drop.sock');
  const sockets = new Set<Socket>();
  let dropped = false;
  const server = createSocketServer(downstream => {
    const upstream = createConnection(target);
    sockets.add(downstream); sockets.add(upstream);
    const inputDecoder = new StringDecoder('utf8'), outputDecoder = new StringDecoder('utf8');
    let input = '', output = '', withdrawalId: string | undefined;
    downstream.on('data', chunk => {
      input += inputDecoder.write(chunk);
      let newline: number;
      while ((newline = input.indexOf('\n')) >= 0) {
        const line = input.slice(0, newline); input = input.slice(newline + 1);
        if (!line.trim()) continue;
        const frame = JSON.parse(line) as { id?: string; method?: string };
        if (frame.method === 'input.withdraw') withdrawalId = frame.id;
      }
      upstream.write(chunk);
    });
    upstream.on('data', chunk => {
      output += outputDecoder.write(chunk);
      let newline: number;
      while ((newline = output.indexOf('\n')) >= 0) {
        const line = output.slice(0, newline); output = output.slice(newline + 1);
        if (!line.trim()) continue;
        const frame = JSON.parse(line) as { id?: string; result?: unknown };
        if (frame.id === withdrawalId && frame.result !== undefined) {
          dropped = true; downstream.destroy(); upstream.destroy(); return;
        }
        downstream.write(line + '\n');
      }
    });
    downstream.on('error', () => upstream.destroy()); upstream.on('error', () => downstream.destroy());
    downstream.on('close', () => { sockets.delete(downstream); upstream.destroy(); });
    upstream.on('close', () => { sockets.delete(upstream); downstream.destroy(); });
  });
  await new Promise<void>(done => server.listen(endpoint, done));
  return { endpoint, dropped: () => dropped, async close() {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
  } };
}

function authorizer(): KodaXClientHostAuthorization {
  let bindingId: string | undefined;
  return async (_request, services) => {
    bindingId ??= (await services.executionBindings.register(async (_input, scoped) => {
      const credential = await scoped.credentials.registerScoped({ providers: ['input-fixture'] }, async () => 'fixture-only');
      return { credential: { mode: 'scoped', leaseId: credential.id, providers: ['input-fixture'] },
        businessBinding: { id: 'input-expert', revision: '1' }, profile: {} };
    })).id;
    return { binding: { leaseId: bindingId } };
  };
}

async function fixture() {
  const homeDir = await mkdtemp(join(tmpdir(), 'kodax-input-recovery-'));
  let release = () => {};
  const gate = new Promise<void>(resolveGate => { release = resolveGate; });
  const requests: string[] = [];
  const wire = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += String(chunk);
    requests.push(body);
    await gate;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ id: 'input-fixture', choices: [{ index: 0,
      delta: { content: 'Input fixture completed.' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(done => wire.listen(0, '127.0.0.1', done));
  const address = wire.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address.');
  await mkdir(join(homeDir, '.kodax'), { recursive: true });
  await writeFile(join(homeDir, '.kodax', 'config.json'), JSON.stringify({ provider: 'input-fixture', model: 'fixture',
    customProviders: [{ name: 'input-fixture', protocol: 'openai', model: 'fixture',
      baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKeyEnv: 'KODAX_UNUSED_INPUT_FIXTURE_KEY', imageInput: true }] }));
  let host = await startHost(homeDir);
  let authorize = authorizer();
  const connect = () => connectKodaXClient({ homeDir, endpoint: host.endpoint, clientInfo: ownerIdentity,
    authorizeExecution: (...args) => authorize(...args) });
  let client = await connect();
  const peer = await connectKodaXClient({ homeDir, endpoint: host.endpoint, clientInfo: {
    name: 'Other input owner', instanceId: 'input-peer', instanceSecret: 'peer'.repeat(16),
  } });
  const session = await client.sessions.create({ projectPath: homeDir });
  await client.sessions.updateSettings(session.id, { agentMode: 'sa', workMode: 'agent', permissionMode: 'full-access' });
  const active = await client.inputs.submit({ sessionId: session.id, inputId: 'initial', text: 'Hold the first request.' });
  await expect.poll(() => requests.length, { timeout: 15_000 }).toBe(1);
  return { homeDir, requests, peer, session, active, release, get client() { return client; }, get host() { return host; },
    rotateAuthorization() { authorize = authorizer(); },
    async restartMain() { await client.disconnect(); authorize = authorizer(); client = await connect(); },
    async restartHost(crash = false) {
      if (crash) { const exited = once(host.child, 'exit'); host.child.kill('SIGKILL'); await bounded(exited, 'Host crash timed out'); }
      await client.disconnect(); await peer.disconnect(); await host.close();
      host = await startHost(homeDir);
      client = await connectKodaXClient({ homeDir, endpoint: host.endpoint, clientInfo: ownerIdentity, authorizeExecution: authorizer() });
    },
    async close() {
      release();
      await client.disconnect(); await peer.disconnect(); await host.close();
      wire.closeAllConnections();
      await new Promise<void>((resolveClose, reject) => wire.close(error => error ? reject(error) : resolveClose()));
      const target = resolve(homeDir);
      if (!target.startsWith(resolve(tmpdir()) + '\\') && !target.startsWith(resolve(tmpdir()) + '/')) throw new Error('Unsafe fixture cleanup path.');
      await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

it('returns the original owner a durable idempotent withdrawal with full text, attachments and delivery', async () => {
  const state = await fixture();
  try {
    const probe = await connectKodaXRuntime({ homeDir: state.homeDir, endpoint: state.host.endpoint, autoStart: false });
    try { expect(probe.capabilities?.productInputRecovery).toEqual({ version: 1 }); }
    finally { await probe.close(); }
    const original = { sessionId: state.session.id, inputId: 'withdraw-original', delivery: 'after_turn' as const,
      text: 'Preserve this exact input.\n'.repeat(100), inputArtifacts: [{ kind: 'image' as const,
        path: join(state.homeDir, 'original.png'), mediaType: 'image/png' as const }] };
    expect(await state.client.inputs.submit(original)).toMatchObject({ state: 'queued' });
    expect(await state.client.inputs.withdraw(original.sessionId, original.inputId)).toEqual(original);
    expect(await state.client.inputs.withdraw(original.sessionId, original.inputId)).toEqual(original);
    await expect(state.peer.inputs.withdraw(original.sessionId, original.inputId)).rejects.toMatchObject({ code: 'permission_denied' });
    state.release();
    await state.client.runs.await(state.active.runId!);
    await state.restartHost();
    expect(await state.client.inputs.read(original.sessionId, original.inputId)).toMatchObject({ state: 'withdrawn' });
    expect(await state.client.inputs.withdraw(original.sessionId, original.inputId)).toEqual(original);
    expect(await state.client.inputs.submit(original)).toMatchObject({ state: 'withdrawn' });
    expect(state.requests).toHaveLength(1);
  } finally { await state.close(); }
}, 120_000);

it('recovers an unconsumed original input after the actual Main process crashes without replacing its Host', async () => {
  const state = await fixture();
  let main: Awaited<ReturnType<typeof startMain>> | undefined;
  try {
    await state.client.disconnect();
    main = await startMain(state.homeDir, state.host.endpoint);
    const original = { sessionId: state.session.id, inputId: 'main-crash', text: 'Original body\n'.repeat(100), delivery: 'after_turn' as const };
    expect(await main.submit(original)).toMatchObject({ state: 'queued' });
    const hostPid = state.host.child.pid;
    await main.crash();
    await state.restartMain();
    expect(state.host.child.pid).toBe(hostPid);
    expect(state.host.child.exitCode).toBeNull();
    expect(await state.client.inputs.submit(original)).toMatchObject({ state: 'queued' });
    expect(await state.client.inputs.withdraw(original.sessionId, original.inputId)).toEqual(original);
    state.release();
    await state.client.runs.await(state.active.runId!);
    expect(state.requests).toHaveLength(1);
  } finally { await main?.crash(); await state.close(); }
}, 120_000);

it('retains a corrupt withdrawal record and blocks only its Session instead of returning malformed original input', async () => {
  const state = await fixture();
  try {
    const original = { sessionId: state.session.id, inputId: 'corrupt-receipt', text: 'Original retained input.', delivery: 'after_turn' as const };
    await state.client.inputs.submit(original);
    await state.client.inputs.withdraw(original.sessionId, original.inputId);
    state.release(); await state.client.runs.await(state.active.runId!);
    await state.host.close();
    const file = join(state.homeDir, '.kodax', 'runtime', 'profiles', 'default', 'pending-inputs', `${encodeURIComponent(state.session.id)}.json`);
    const stored = JSON.parse(await readFile(file, 'utf8')) as { withdrawn: { input: { inputArtifacts?: unknown } }[] };
    stored.withdrawn[0]!.input.inputArtifacts = [{ kind: 'image', path: 123 }];
    const corrupt = JSON.stringify(stored);
    await writeFile(file, corrupt);
    await state.restartHost();
    await expect(state.client.inputs.withdraw(original.sessionId, original.inputId)).rejects.toBeDefined();
    expect(await readFile(file, 'utf8')).toBe(corrupt);
    expect(await state.client.sessions.create({ projectPath: state.homeDir })).toHaveProperty('id');
  } finally { await state.close(); }
}, 120_000);

it('recovers the committed withdrawal after its success frame is lost and the Host crashes', async () => {
  const state = await fixture();
  const proxy = await dropWithdrawalResponse(state.host.endpoint, state.homeDir);
  let lossy: Awaited<ReturnType<typeof connectKodaXClient>> | undefined;
  try {
    const bytes = await readFile(resolve('tests/fixtures/images/valid-png.png'));
    const image = await persistImageAsBlock({ buffer: bytes, mediaType: 'image/png' },
      { directory: join(state.homeDir, 'paste'), fileNamePrefix: 'partner-clip' });
    if (!image.path) throw new Error('Missing persisted fixture image.');
    const olderThanPasteTtl = new Date(Date.now() - PASTE_TMP_TTL_MS * 2);
    await utimes(image.path, olderThanPasteTtl, olderThanPasteTtl);
    const original = { sessionId: state.session.id, inputId: 'lost-withdrawal', text: 'Never lose this body\n'.repeat(100),
      delivery: 'after_turn' as const, inputArtifacts: [{ kind: 'image' as const, path: image.path, mediaType: 'image/png' as const, source: 'clipboard' as const }] };
    await state.client.inputs.submit(original);
    const retained = { ...original, inputId: 'retained-legacy', text: 'This later input stays pending.' };
    await state.client.inputs.submit(retained);
    await state.client.disconnect();
    lossy = await connectKodaXClient({ homeDir: state.homeDir, endpoint: proxy.endpoint, clientInfo: ownerIdentity });
    await expect(lossy.inputs.withdraw(original.sessionId, original.inputId)).rejects.toThrow();
    expect(proxy.dropped()).toBe(true);
    await state.restartHost(true);
    expect(await state.client.inputs.withdraw(original.sessionId, original.inputId)).toEqual(original);
    expect(await state.client.inputs.read(retained.sessionId, retained.inputId)).toMatchObject({ state: 'queued' });
    expect(await state.client.inputs.withdraw(retained.sessionId, retained.inputId)).toEqual(retained);
    await state.restartHost();
    expect(await state.client.inputs.withdraw(original.sessionId, original.inputId)).toEqual(original);
    expect(await state.client.inputs.withdraw(retained.sessionId, retained.inputId)).toEqual(retained);
    expect(state.requests).toHaveLength(1);
    const recalled = await state.client.inputs.withdraw(original.sessionId, original.inputId);
    expect(await readFile(recalled.inputArtifacts![0]!.path)).toEqual(bytes);
    // The existing attachment contract is a retained local file reference. Exercise
    // the recalled bytes on the actual provider wire, without inventing an archive.
    state.release();
    const recalledSession = await state.client.sessions.create({ projectPath: state.homeDir });
    await state.client.sessions.updateSettings(recalledSession.id, { agentMode: 'sa', workMode: 'agent', permissionMode: 'full-access' });
    const submitted = await state.client.inputs.submit({ ...recalled, sessionId: recalledSession.id, inputId: 'recalled-image', delivery: 'immediate' });
    expect((await state.client.runs.await(submitted.runId!)).phase).toBe('completed');
    expect(state.requests).toHaveLength(2);
    expect(state.requests[1]).toContain(bytes.toString('base64'));
  } finally { await lossy?.disconnect(); await proxy.close(); await state.close(); }
}, 120_000);

it('rebinds only the original pending intent after its Main connection ends while the Host remains live', async () => {
  const state = await fixture();
  try {
    const original = { sessionId: state.session.id, inputId: 'rebind-original', delivery: 'after_turn' as const,
      text: 'Keep every original requirement.\n'.repeat(80) };
    const later = { ...original, inputId: 'rebind-later', text: 'This must remain the later input.' };
    await state.client.inputs.submit(original);
    await state.client.inputs.submit(later);
    state.rotateAuthorization();
    await expect(state.client.inputs.submit(original)).rejects.toMatchObject({ code: 'conflict' });
    const hostPid = state.host.child.pid;
    await state.restartMain();
    expect(state.host.child.pid).toBe(hostPid);
    expect(state.host.child.exitCode).toBeNull();
    await expect(state.peer.inputs.submit(original)).rejects.toMatchObject({ code: 'conflict' });
    await expect(state.client.inputs.submit({ ...original, text: 'Changed intent' })).rejects.toMatchObject({ code: 'conflict' });
    expect(await state.client.inputs.submit(original)).toMatchObject({ state: 'queued' });
    expect(await state.client.inputs.submit(later)).toMatchObject({ state: 'queued' });
    const observed: string[][] = [];
    const observation = await state.peer.sessions.observe(state.session.id, view => observed.push(view.queue.map(item => item.inputId)));
    expect(observed.at(-1)).toEqual([original.inputId, later.inputId]);
    observation.close();
    expect(state.requests).toHaveLength(1);
    state.release();
    await state.client.runs.await(state.active.runId!);
    await expect.poll(async () => (await state.client.inputs.read(later.sessionId, later.inputId))?.runId, { timeout: 20_000 }).toBeTruthy();
    const accepted = await state.client.inputs.read(later.sessionId, later.inputId);
    await state.client.runs.await(accepted!.runId!);
    const history = await state.client.sessions.readHistory(state.session.id);
    expect(history.items.filter(item => item.type === 'user').map(item => item.text))
      .toEqual(['Hold the first request.', original.text, later.text]);
  } finally { await state.close(); }
}, 120_000);

it('preserves an old array queue through cold recovery and serializes rebind with idempotent withdrawals', async () => {
  const state = await fixture();
  try {
    const original = { sessionId: state.session.id, inputId: 'old-array', delivery: 'after_turn' as const,
      text: 'Legacy full input\n'.repeat(100), inputArtifacts: [{ kind: 'image' as const, path: join(state.homeDir, 'legacy.png'), mediaType: 'image/png' as const }] };
    // Until its first withdrawal, the persisted pending format is the pre-receipt array.
    await state.client.inputs.submit(original);
    await state.restartHost(true);
    const results = await Promise.all([
      state.client.inputs.submit(original),
      state.client.inputs.withdraw(original.sessionId, original.inputId),
      state.client.inputs.withdraw(original.sessionId, original.inputId),
    ]);
    expect(results[0]).toMatchObject({ inputId: original.inputId });
    expect(results[1]).toEqual(original);
    expect(results[2]).toEqual(original);
    expect(await state.client.inputs.read(original.sessionId, original.inputId)).toMatchObject({ state: 'withdrawn' });
    await state.restartHost();
    expect(await state.client.inputs.withdraw(original.sessionId, original.inputId)).toEqual(original);
    expect(state.requests).toHaveLength(1);
  } finally { await state.close(); }
}, 120_000);
