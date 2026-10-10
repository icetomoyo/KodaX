import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { KodaXBaseProvider, registerModelProvider, clearRuntimeModelProviders,
  type KodaXProviderConfig, type KodaXStreamResult, type KodaXProviderStreamOptions, type KodaXMessage,
  type KodaXToolDefinition, type KodaXReasoningRequest } from '@kodax-ai/llm';
import { connectKodaXClient, readKodaXClientExits, type KodaXClientHostAuthorization } from '@kodax-ai/kodax/client';
import { connectKodaXRuntime, createKodaXRuntime, type RuntimeSubmitInput } from './sdk-runtime.js';
import { startRuntimeDaemonHost } from './runtime-daemon/host.js';
import { resolveRuntimeDaemonPaths, tryAcquireRuntimeDaemonLock } from './runtime-daemon/state.js';

it('durably settles only this client work, protects the other client, and resumes the receipt after disconnect', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-product-exit-'));
  let release!: () => void;
  const done = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  class Provider extends KodaXBaseProvider {
    readonly name = 'exit-test'; readonly supportsThinking = false;
    protected readonly config: KodaXProviderConfig = { apiKeyEnv: 'KODAX_EXIT_TEST', model: 'test', supportsThinking: false };
    async stream(_messages: KodaXMessage[], _tools: KodaXToolDefinition[], _system: string,
      _reasoning?: boolean | KodaXReasoningRequest, _options?: KodaXProviderStreamOptions, signal?: AbortSignal): Promise<KodaXStreamResult> {
      calls += 1;
      await Promise.race([done, new Promise<never>((_, reject) => signal?.addEventListener('abort',
        () => reject(new DOMException('Cancelled', 'AbortError')), { once: true }))]);
      return { textBlocks: [{ type: 'text', text: 'done' }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' };
    }
  }
  vi.stubEnv('KODAX_EXIT_TEST', 'fixture');
  registerModelProvider('exit-test', () => new Provider());
  const runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true, defaultProvider: 'exit-test' });
  const paths = resolveRuntimeDaemonPaths(homeDir);
  const lock = tryAcquireRuntimeDaemonLock(paths, { runtimeId: runtime.identity.runtimeId, pid: process.pid, createdAt: runtime.identity.startedAt });
  if (!lock) throw new Error('Missing Host lock');
  const endpoint = { kind: process.platform === 'win32' ? 'pipe' as const : 'unix' as const,
    path: process.platform === 'win32' ? `\\\\.\\pipe\\kodax-exit-${randomUUID()}` : path.join(homeDir, 'host.sock') };
  const host = await startRuntimeDaemonHost({ runtime, paths, lock, endpoint });
  const info = { name: 'Space', instanceId: 'space-exit', instanceSecret: 's'.repeat(32) };
  const authorizeExecution: KodaXClientHostAuthorization = async (request, services) => {
    if (request.kind !== 'agent_spawn' && request.kind !== 'agent_followup') return undefined;
    const lease = await services.credentials.registerScoped({ providers: ['exit-test'] }, async () => 'fixture');
    return { credential: { leaseId: lease.id, mode: 'scoped', providers: ['exit-test'] }, tools: [] };
  };
  const first = await connectKodaXClient({ homeDir, endpoint: endpoint.path, clientInfo: info, authorizeExecution });
  const other = await connectKodaXClient({ homeDir, endpoint: endpoint.path, authorizeExecution });
  try {
    const a = await first.sessions.create({ projectPath: homeDir });
    const b = await other.sessions.create({ projectPath: homeDir });
    for (const session of [a, b]) await first.sessions.updateSettings(session.id, { provider: 'exit-test', agentMode: 'sa', permissionMode: 'full-access' });
    const own = await first.inputs.submit({ sessionId: a.id, inputId: 'own', text: 'Wait.' });
    const foreign = await other.inputs.submit({ sessionId: b.id, inputId: 'foreign', text: 'Keep working.' });
    await expect.poll(async () => {
      for (const id of [own.runId!, foreign.runId!]) {
        const status = await first.runs.read(id);
        if (status.phase === 'failed') throw new Error(status.error);
      }
      return calls;
    }, { timeout: 10_000 }).toBe(2);
    const ownActor = await first.agents.spawn(a.id, { taskName: 'own-actor', objective: 'Wait independently.', capabilities: { providers: ['exit-test'], tools: [] } });
    const foreignActor = await other.agents.spawn(a.id, { taskName: 'foreign-actor', objective: 'Keep inspecting independently.', capabilities: { providers: ['exit-test'], tools: [] } });
    await expect.poll(() => calls, { timeout: 10_000 }).toBe(4);
    await first.inputs.submit({ sessionId: a.id, inputId: 'queued', text: 'Never consume.', delivery: 'after_turn' });
    await other.inputs.submit({ sessionId: a.id, inputId: 'foreign-queued', text: 'Keep this client work.', delivery: 'after_turn' });
    const receipt = await first.lifecycle.requestExit({ requestId: 'quit-space', shutdownHost: true });
    expect(receipt).toMatchObject({ accepted: true, cleanup: { state: 'pending' } });
    await expect(first.lifecycle.requestExit({ requestId: 'quit-space' })).rejects.toMatchObject({ code: 'conflict' });
    await expect(other.lifecycle.requestExit({ requestId: ' ' })).rejects.toMatchObject({ code: 'invalid_params' });
    expect(await other.lifecycle.readExit('quit-space')).toBeNull();
    expect(await other.lifecycle.listPendingExits()).toEqual([]);
    await expect.poll(async () => {
      const result = await first.lifecycle.readExit('quit-space');
      if (result?.cleanup.state === 'failed') throw new Error(result.cleanup.issues.join('; '));
      return result?.cleanup.state;
    }).toBe('succeeded');
    await expect.poll(async () => (await first.lifecycle.readExit('quit-space'))?.host.state).toBe('protected');
    const settled = await first.lifecycle.readExit('quit-space');
    expect(settled).toMatchObject({ cleanup: { runIds: expect.arrayContaining([own.runId]),
      actorTurns: [{ actorPath: ownActor.actorPath, turnId: ownActor.turnId }],
      withdrawnInputs: [{ sessionId: a.id, inputId: 'queued' }] }, host: { state: 'protected' } });
    expect((await other.agents.output(a.id, foreignActor.actorPath)).state).toBe('running');
    expect((await other.runs.read(foreign.runId!)).phase).toBe('running');
    await expect.poll(async () => (await other.inputs.read(a.id, 'foreign-queued'))?.runId).toBeTruthy();
    const queuedForeign = await other.inputs.read(a.id, 'foreign-queued');
    expect((await other.runs.read(queuedForeign!.runId!)).phase).toBe('running');
    await expect(first.inputs.submit({ sessionId: a.id, inputId: 'late', text: 'Too late.' })).rejects.toMatchObject({ code: 'conflict' });
    await expect(first.sessions.compact(a.id)).rejects.toMatchObject({ code: 'conflict' });
    await expect(first.workflows.start({ projectRoot: homeDir, source: { kind: 'name', name: 'research' } })).rejects.toMatchObject({ code: 'conflict' });
    await first.disconnect();
    const resumed = await connectKodaXClient({ homeDir, endpoint: endpoint.path, clientInfo: info });
    try {
      expect(await resumed.lifecycle.readExit('quit-space')).toMatchObject({ runtimeId: receipt.runtimeId, host: { state: 'protected' } });
      expect(await resumed.lifecycle.listPendingExits()).toHaveLength(1);
      expect(await readKodaXClientExits({ homeDir, clientInfo: info })).toHaveLength(1);
      expect(await readKodaXClientExits({ homeDir, clientInfo: { ...info, instanceSecret: 'x'.repeat(32) } })).toEqual([]);
    } finally { await resumed.disconnect(); }
    const legacy = await connectKodaXRuntime({ homeDir, endpoint: endpoint.path, autoStart: false, clientInfo: info });
    try {
      for (const delivery of ['after_turn', 'interrupt'] as const) {
        await expect(legacy.runs.submitInput({ sessionId: b.id, afterRunId: foreign.runId!, delivery,
          input: { type: 'text', text: 'New intent after this identity exited.' } })).rejects.toMatchObject({ code: 'conflict' });
      }
    } finally { await legacy.close(); }
    release();
    expect((await other.runs.await(foreign.runId!)).phase).toBe('completed');
  } finally {
    release(); await first.disconnect(); await other.disconnect(); await host.close(); await runtime.close();
    clearRuntimeModelProviders(); vi.unstubAllEnvs();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 60_000);

it('rechecks the trusted Host fence after asynchronous access and before interrupt enqueue', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-exit-interrupt-fence-'));
  let signalEntered: () => void = () => {};
  const providerEntered = new Promise<void>((resolve) => { signalEntered = resolve; });
  class Provider extends KodaXBaseProvider {
    readonly name = 'interrupt-fence'; readonly supportsThinking = false;
    protected readonly config: KodaXProviderConfig = { apiKeyEnv: 'KODAX_INTERRUPT_FENCE', model: 'fixture', supportsThinking: false };
    async stream(_messages: KodaXMessage[], _tools: KodaXToolDefinition[], _system: string,
      _reasoning?: boolean | KodaXReasoningRequest, _options?: KodaXProviderStreamOptions, signal?: AbortSignal): Promise<KodaXStreamResult> {
      signalEntered();
      await new Promise<never>((_, reject) => signal!.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true }));
      throw new Error('Unreachable after cancellation.');
    }
  }
  vi.stubEnv('KODAX_INTERRUPT_FENCE', 'fixture'); registerModelProvider('interrupt-fence', () => new Provider());
  const runtime = await createKodaXRuntime({ homeDir, defaultProvider: 'interrupt-fence' });
  try {
    const session = await runtime.sessions.create({ gitRoot: homeDir });
    await runtime.sessions.updateSettings(session.id, { agentMode: 'ama', permissionMode: 'full-access' });
    const active = await runtime.runs.start({ sessionId: session.id, input: { type: 'text', text: 'Wait.' },
      options: { agentMode: 'ama' } });
    // Cold Actor preparation may exceed the poll helper's default deadline.
    // Leave time for cleanup even if the fixture never reaches the Provider.
    let readinessTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        providerEntered,
        active.result.then((result) => { throw new Error(`Fixture ended before Provider entry: ${result.phase}`); }),
        new Promise<never>((_, reject) => {
          readinessTimer = setTimeout(() => reject(new Error('Fixture Provider did not enter.')), 15_000);
        }),
      ]);
    } finally {
      clearTimeout(readinessTimer);
    }
    let allowed = true;
    let checks = 0;
    const assertAdmission = () => {
      checks += 1;
      if (!allowed) throw Object.assign(new Error('Client exit accepted'), { code: 'conflict' });
      queueMicrotask(() => { allowed = false; });
    };
    // The callback is supplied by the trusted Host, never serialized from a client.
    await expect(runtime.runs.submitInput({ sessionId: session.id, afterRunId: active.runId,
      delivery: 'interrupt', input: { type: 'text', text: 'Late intent.' }, assertAdmission } as RuntimeSubmitInput))
      .rejects.toMatchObject({ code: 'conflict' });
    expect(checks).toBe(2);
    await runtime.runs.abort(active.runId);
    // The session write-lock queue releases its directory slightly after the
    // runtime closes; give the removal the same retry budget the other cases
    // in this file use.
  } finally { await runtime.close(); clearRuntimeModelProviders(); vi.unstubAllEnvs(); await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}, 30_000);

it('cancels ordinary owned work while an uncooperative compaction stays unknown and recoverable', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-exit-compaction-'));
  let finishCompact!: () => void;
  const compactHold = new Promise<void>(resolve => { finishCompact = resolve; });
  let compactEntered = false;
  let runEntered = false;
  class Provider extends KodaXBaseProvider {
    readonly name = 'uncooperative-compact'; readonly supportsThinking = false;
    protected readonly config: KodaXProviderConfig = { apiKeyEnv: 'KODAX_EXIT_COMPACT_FIXTURE', model: 'test', supportsThinking: false };
    async stream(messages: KodaXMessage[], _tools: KodaXToolDefinition[], system: string,
      _reasoning?: boolean | KodaXReasoningRequest, _options?: KodaXProviderStreamOptions, signal?: AbortSignal): Promise<KodaXStreamResult> {
      const prompt = system + JSON.stringify(messages);
      if (prompt.includes('HOLD-COMPACTION')) { compactEntered = true; await compactHold; }
      else if (prompt.includes('CANCEL-ORDINARY-RUN')) {
        runEntered = true;
        await new Promise<never>((_, reject) => signal!.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true }));
      }
      return { textBlocks: [{ type: 'text', text: 'Fixture evidence.' }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' };
    }
  }
  vi.stubEnv('KODAX_EXIT_COMPACT_FIXTURE', 'fixture');
  registerModelProvider('uncooperative-compact', () => new Provider());
  const runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true, defaultProvider: 'uncooperative-compact' });
  const paths = resolveRuntimeDaemonPaths(homeDir);
  const lock = tryAcquireRuntimeDaemonLock(paths, { runtimeId: runtime.identity.runtimeId, pid: process.pid, createdAt: runtime.identity.startedAt });
  if (!lock) throw new Error('Missing Host lock');
  const endpoint = { kind: process.platform === 'win32' ? 'pipe' as const : 'unix' as const,
    path: process.platform === 'win32' ? `\\\\.\\pipe\\kodax-exit-compact-${randomUUID()}` : path.join(homeDir, 'host.sock') };
  const host = await startRuntimeDaemonHost({ runtime, paths, lock, endpoint });
  const client = await connectKodaXClient({ homeDir, endpoint: endpoint.path,
    clientInfo: { name: 'exit-compaction', instanceId: randomUUID(), instanceSecret: randomUUID() } });
  let compact: Promise<unknown> | undefined;
  try {
    const session = await client.sessions.create({ projectPath: homeDir });
    const busy = await client.sessions.create({ projectPath: homeDir });
    for (const item of [session, busy]) await client.sessions.updateSettings(item.id, { provider: 'uncooperative-compact', agentMode: 'sa', permissionMode: 'full-access' });
    for (let index = 0; index < 3; index += 1) {
      const warm = await client.inputs.submit({ sessionId: session.id, inputId: `warm-${index}`, text: 'Preserve ownership evidence. '.repeat(700) });
      expect((await client.runs.await(warm.runId!)).phase).toBe('completed');
    }
    await client.sessions.updateSettings(session.id, { compactionTriggerTokens: 5000 });
    const before = await client.sessions.readHistory(session.id);
    const active = await client.inputs.submit({ sessionId: busy.id, inputId: 'busy', text: 'CANCEL-ORDINARY-RUN' });
    await expect.poll(() => runEntered).toBe(true);
    compact = client.sessions.compact(session.id, { customInstructions: 'HOLD-COMPACTION' }).then(result => result, error => error as Error);
    await expect.poll(() => compactEntered).toBe(true);
    await client.lifecycle.requestExit({ requestId: 'quit' });
    await expect.poll(async () => (await client.runs.read(active.runId!)).phase, { timeout: 4_000 }).not.toBe('running');
    await expect.poll(async () => (await client.lifecycle.readExit('quit'))?.cleanup.state, { timeout: 5_000 }).toBe('unknown');
    const receipt = await client.lifecycle.readExit('quit');
    expect(receipt!.cleanup.operationIds).toHaveLength(1);
    expect(await client.lifecycle.listPendingExits()).toContainEqual(expect.objectContaining({ requestId: 'quit', cleanup: expect.objectContaining({ state: 'unknown' }) }));
    finishCompact(); await compact;
    expect((await client.sessions.readHistory(session.id)).sourceRevision).toBe(before.sourceRevision);
    await client.lifecycle.requestExit({ requestId: 'quit' });
    await expect.poll(async () => (await client.lifecycle.readExit('quit'))?.cleanup.state).toBe('succeeded');
  } finally {
    finishCompact(); await compact; await client.disconnect(); await host.close(); await runtime.close();
    clearRuntimeModelProviders(); vi.unstubAllEnvs(); await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 60_000);
