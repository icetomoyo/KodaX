import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { createSessionLineage } from '@kodax-ai/agent';
import { FileSessionStorage } from '@kodax-ai/repl';
import { connectKodaXClient } from '../src/sdk-client.js';
import { runtimeClientPrincipal } from '../src/runtime-daemon/client-lifecycle.js';
import type { RuntimeExecutionAuthorization } from '../src/client-host-authorization.js';

it.each(['agent', 'coding'] as const)('retains the original Agent constraint on cold recovery into %s', async workMode => {
  const homeDir = await mkdtemp(join(tmpdir(), 'kodax-mode-recovery-'));
  const configHome = join(homeDir, '.kodax');
  const clientInfo = { name: 'Partner', instanceId: 'mode-recovery', instanceSecret: 'mode-recovery'.repeat(8) };
  let requests = 0;
  const wire = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Drain fixture request. */ }
    requests++;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: { content: 'Recovered.' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(done => wire.listen(0, '127.0.0.1', done));
  const address = wire.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture address.');
  await mkdir(configHome, { recursive: true });
  await writeFile(join(configHome, 'config.json'), JSON.stringify({ customProviders: [{ name: 'mode-recovery', protocol: 'openai',
    model: 'fixture', apiKeyEnv: 'UNUSED_MODE_RECOVERY', baseUrl: `http://127.0.0.1:${address.port}/v1` }] }));
  const sessionId = 'original-session'; const runId = 'original-run';
  const executionBinding = { businessBinding: { id: 'partner', revision: '1' } };
  const messages = [{ role: 'user' as const, content: 'Original question' }];
  const lineage = createSessionLineage(messages);
  await new FileSessionStorage({ sessionsDir: join(configHome, 'sessions'), configHome }).save(sessionId,
    { title: 'Constrained recovery', gitRoot: homeDir, messages, lineage, runtimeInfo: { surface: 'partner' } });
  const checkpoint = { version: 1, sessionId, turnId: 'original-turn', activeEntryId: lineage.activeEntryId,
    messagesDigest: createHash('sha256').update(JSON.stringify(messages)).digest('hex') };
  const runDir = join(configHome, 'runtime', 'profiles', 'default', 'runs', runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, 'status.json'), JSON.stringify({ runId, sessionId, phase: 'recovering', provider: 'mode-recovery',
    model: 'fixture', workMode, requiredWorkMode: 'agent', executionBinding, startedAt: '2026-11-01T00:00:00Z',
    origin: { principalId: runtimeClientPrincipal(clientInfo.instanceId, clientInfo.instanceSecret) },
    contextRecovery: { waitingSince: '2026-11-01T00:00:00Z', checkpoint },
    _runtime: { revision: 1, owner: { ownerId: 'stopped-owner', runtimeId: 'stopped-runtime', pid: 2147483647, startedAt: '2026-11-01T00:00:00Z' } } }));
  await writeFile(join(runDir, 'generation-recovery.json'), JSON.stringify({ version: 3, checkpoint,
    start: { prompt: 'Original question', options: { provider: 'mode-recovery', workMode, agentMode: 'sa', executionWorkMode: 'agent', executionBinding,
      context: { gitRoot: homeDir, executionCwd: homeDir } }, requiredBindings: [] },
    requiresCredential: true, requiresHostTools: false, actorTurnBaseline: [] }));
  const pending = { sessionId, inputId: 'pending-agent', text: 'Keep the pending Agent constraint.', delivery: 'after_turn' as const };
  const pendingDir = join(configHome, 'runtime', 'profiles', 'default', 'pending-inputs');
  await mkdir(pendingDir, { recursive: true });
  await writeFile(join(pendingDir, `${sessionId}.json`), JSON.stringify({ version: 2, withdrawn: [], pending: [{
    input: pending, skill: false, requiredWorkMode: 'agent', principalId: runtimeClientPrincipal(clientInfo.instanceId, clientInfo.instanceSecret),
  }] }));
  const child = spawn(process.execPath, ['--import', 'tsx', resolve('tests/sdk-contract-host.fixture.ts'), homeDir], {
    cwd: process.cwd(), env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(API_KEY|TOKEN|SECRET|PASSWORD)$/.test(key))),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
  });
  child.stdout!.resume(); child.stderr!.resume();
  const [ready] = await once(child, 'message');
  let leaseId: string | undefined;
  let required: string | undefined;
  const client = await connectKodaXClient({ homeDir, endpoint: (ready as { endpoint: string }).endpoint, clientInfo,
    async authorizeExecution(_request, services) {
      leaseId ??= (await services.executionBindings.register(async (request, scoped) => {
        required = request.recovery?.profile.requiredWorkMode;
        const credential = await scoped.credentials.registerScoped({ providers: ['mode-recovery'] }, async () => 'fixture-only');
        // Fresh authority may omit the constraint; persisted original authority must still apply.
        return { credential: { mode: 'scoped', leaseId: credential.id, providers: ['mode-recovery'] },
          businessBinding: executionBinding.businessBinding,
          profile: await scoped.createExecutionProfile({}) };
      })).id;
      return { binding: { leaseId } };
    } });
  try {
    if (workMode === 'coding') {
      await expect(client.runs.recover({ sessionId, runId })).rejects.toMatchObject({ code: 'execution_mode_mismatch' });
      expect(requests).toBe(0);
    } else {
      await client.runs.recover({ sessionId, runId });
      expect((await client.runs.await(runId)).phase).toBe('completed');
      expect(requests).toBe(1);
    }
    expect(required).toBe('agent');
    if (workMode === 'agent') {
      await client.sessions.updateSettings(sessionId, { provider: 'mode-recovery', model: 'fixture', workMode: 'coding', agentMode: 'sa', permissionMode: 'full-access' });
      await client.inputs.submit(pending);
      await expect.poll(async () => (await client.inputs.read(sessionId, pending.inputId))?.admissionError?.code,
        { timeout: 5_000 }).toBe('execution_mode_mismatch');
      expect(requests).toBe(1);
      expect(await client.inputs.withdraw(sessionId, pending.inputId)).toEqual(pending);
    }
  } finally {
    await client.disconnect();
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    wire.closeAllConnections(); await new Promise<void>((done, reject) => wire.close(error => error ? reject(error) : done()));
    const target = resolve(homeDir);
    if (!target.startsWith(resolve(tmpdir()) + '\\') && !target.startsWith(resolve(tmpdir()) + '/')) throw new Error('Unsafe fixture cleanup path.');
    await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 120_000);

it('keeps a cold mixed pending queue separated after both inputs bind to the same fresh static lease', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'kodax-mixed-mode-recovery-'));
  const configHome = join(homeDir, '.kodax');
  const clientInfo = { name: 'Mixed recovery owner', instanceId: 'mixed-recovery', instanceSecret: 'mixed-recovery'.repeat(8) };
  const sessionId = 'mixed-session';
  const plain = { sessionId, inputId: 'plain-first', text: 'Execute this plain Coding input.\n', delivery: 'after_turn' as const };
  const constrained = { sessionId, inputId: 'agent-second', text: 'Never consume my Agent-only input in Coding.\n'.repeat(80), delivery: 'after_turn' as const };
  const requests: string[] = [];
  const wire = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += String(chunk);
    requests.push(body);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ id: 'mixed-fixture', choices: [{ index: 0,
      delta: { content: 'Plain input completed.' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(done => wire.listen(0, '127.0.0.1', done));
  const address = wire.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture address.');
  await mkdir(configHome, { recursive: true });
  await writeFile(join(configHome, 'config.json'), JSON.stringify({ provider: 'mixed-fixture', model: 'fixture',
    customProviders: [{ name: 'mixed-fixture', protocol: 'openai', model: 'fixture',
      apiKeyEnv: 'UNUSED_MIXED_RECOVERY', baseUrl: `http://127.0.0.1:${address.port}/v1` }] }));
  await new FileSessionStorage({ sessionsDir: join(configHome, 'sessions'), configHome }).save(sessionId,
    { title: 'Mixed pending constraints', gitRoot: homeDir, messages: [], runtimeInfo: { surface: 'partner' } });
  const principalId = runtimeClientPrincipal(clientInfo.instanceId, clientInfo.instanceSecret);
  const pendingDir = join(configHome, 'runtime', 'profiles', 'default', 'pending-inputs');
  await mkdir(pendingDir, { recursive: true });
  await writeFile(join(pendingDir, `${sessionId}.json`), JSON.stringify({ version: 2, withdrawn: [], pending: [
    { input: plain, skill: false, principalId }, { input: constrained, skill: false, principalId, requiredWorkMode: 'agent' },
  ] }));
  const child = spawn(process.execPath, ['--import', 'tsx', resolve('tests/sdk-contract-host.fixture.ts'), homeDir], {
    cwd: process.cwd(), env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(API_KEY|TOKEN|SECRET|PASSWORD)$/.test(key))),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
  });
  child.stdout!.resume(); child.stderr!.resume();
  const [ready] = await once(child, 'message');
  const endpoint = (ready as { endpoint: string; pid: number }).endpoint;
  expect((ready as { pid: number }).pid).not.toBe(process.pid);
  let release = () => {};
  const held = new Promise<void>(done => { release = done; });
  let holding = false;
  let cached: RuntimeExecutionAuthorization | undefined;
  let registrations = 0;
  const client = await connectKodaXClient({ homeDir, endpoint, clientInfo, async authorizeExecution(_request, services) {
    if (cached === undefined) {
      registrations++;
      const credential = await services.credentials.registerScoped({ providers: ['mixed-fixture'] }, async () => 'fixture-only');
      const tools = await services.hostTools.register([{ name: 'hold_mixed_queue', description: 'Hold the mixed queue fixture.',
        inputSchema: { type: 'object', properties: {} }, sideEffect: 'none' }], {
        async hold_mixed_queue() { holding = true; await held; return { content: 'Hold released.' }; },
      });
      cached = { credential: { mode: 'scoped', leaseId: credential.id, providers: ['mixed-fixture'] },
        hostTools: { leaseId: tools.id }, profile: await services.createExecutionProfile({}, tools.tools) };
    }
    return cached;
  } });
  const peer = await connectKodaXClient({ homeDir, endpoint });
  try {
    await peer.sessions.updateSettings(sessionId, { workMode: 'coding', agentMode: 'sa', permissionMode: 'full-access' });
    const active = await client.runs.startTool({ sessionId, inputId: 'hold-before-rebind', rawInput: 'Hold while rebinding both inputs.',
      name: 'hold_mixed_queue', input: {} });
    await expect.poll(() => holding, { timeout: 10_000 }).toBe(true);
    expect(await client.inputs.submit(plain)).toMatchObject({ state: 'queued' });
    expect(await client.inputs.submit(constrained)).toMatchObject({ state: 'queued' });
    expect(registrations).toBe(1);
    const queues: string[][] = [];
    const observation = await peer.sessions.observe(sessionId, view => { queues.push(view.queue.map(item => item.inputId)); });
    try { expect(queues.at(-1)).toEqual([plain.inputId, constrained.inputId]); }
    finally { observation.close(); }
    release();
    expect((await client.runs.await(active.runId)).phase).toBe('completed');
    await expect.poll(async () => (await peer.inputs.read(sessionId, constrained.inputId))?.admissionError?.code,
      { timeout: 15_000 }).toBe('execution_mode_mismatch');
    const consumed = await peer.inputs.read(sessionId, plain.inputId);
    expect(consumed).toMatchObject({ state: 'submitted' });
    expect((await client.runs.await(consumed!.runId!)).phase).toBe('completed');
    expect(await peer.inputs.read(sessionId, constrained.inputId)).toMatchObject({ state: 'queued' });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain(plain.text.trim());
    expect(requests[0]).not.toContain(constrained.text.trim());
    const texts = (await peer.sessions.readHistory(sessionId)).items.filter(item => item.type === 'user').map(item => item.text);
    expect(texts).toContain(plain.text);
    expect(texts).not.toContain(constrained.text);
    expect(await client.inputs.withdraw(sessionId, constrained.inputId)).toEqual(constrained);
  } finally {
    release(); await client.disconnect(); await peer.disconnect();
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    wire.closeAllConnections(); await new Promise<void>((done, reject) => wire.close(error => error ? reject(error) : done()));
    const target = resolve(homeDir);
    if (!target.startsWith(resolve(tmpdir()) + '\\') && !target.startsWith(resolve(tmpdir()) + '/')) throw new Error('Unsafe fixture cleanup path.');
    await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 120_000);
