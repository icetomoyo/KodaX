import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { createExtensionRuntime } from '@kodax-ai/coding';
import { executeCommand } from '@kodax-ai/repl';
import { KodaXBaseProvider, registerModelProvider, type KodaXProviderConfig, type KodaXStreamResult } from '@kodax-ai/llm';
import { createKodaXRuntime } from './sdk-runtime.js';
import { createRuntimeDaemonClient } from './runtime-daemon/client.js';
import { createRuntimeDaemonDispatcher } from './runtime-daemon/server.js';
import { startRuntimeDaemonHost } from './runtime-daemon/host.js';
import { readRuntimeDaemonToken, resolveRuntimeDaemonPaths, tryAcquireRuntimeDaemonLock } from './runtime-daemon/state.js';
import { createRuntimeDaemonSocketServer, createRuntimeDaemonSocketClientTransport, defaultRuntimeDaemonEndpoint } from './runtime-daemon/transport.js';

it('executes explicit tools from daemon negotiation with permissions, events and durable history without a model', async () => {
  // Plan mode intentionally permits writes under the system temp directory.
  const root = await mkdtemp(path.join(process.cwd(), '.kodax-daemon-tools-'));
  const sessionsDir = path.join(root, 'sessions');
  const providerCalls = vi.fn();
  class NoModelProvider extends KodaXBaseProvider {
    readonly name = 'daemon-explicit-tools';
    readonly supportsThinking = false;
    protected readonly config: KodaXProviderConfig = {
      apiKeyEnv: 'KODAX_EXPLICIT_TOOLS_TEST_KEY', model: 'offline', supportsThinking: false,
    };
    async stream(): Promise<KodaXStreamResult> {
      providerCalls();
      throw new Error('Explicit tool execution must not call a model.');
    }
  }
  vi.stubEnv('KODAX_HOME', path.join(root, '.kodax'));
  vi.stubEnv('KODAX_EXPLICIT_TOOLS_TEST_KEY', 'offline-test');
  const unregister = registerModelProvider('daemon-explicit-tools', () => new NoModelProvider());
  const runtime = await createKodaXRuntime({ homeDir: root, sessionsDir, sharedDaemonHost: true,
    defaultProvider: 'daemon-explicit-tools' });
  const paths = resolveRuntimeDaemonPaths(root, 'default');
  const lock = tryAcquireRuntimeDaemonLock(paths, { runtimeId: runtime.identity.runtimeId,
    pid: process.pid, createdAt: runtime.identity.startedAt });
  if (!lock) throw new Error('Expected isolated daemon owner lock.');
  const host = await startRuntimeDaemonHost({ runtime, paths, lock, endpoint: defaultRuntimeDaemonEndpoint('explicit-tools', root) });
  const transport = await createRuntimeDaemonSocketClientTransport(host.endpoint);
  const initialized = await transport.request('initialize', { profile: 'default', token: readRuntimeDaemonToken(paths),
    capabilities: { operationDeduplication: true } }) as {
    identity: typeof runtime.identity; capabilities: Readonly<Record<string, unknown>>;
  };
  const client = createRuntimeDaemonClient({ ...initialized, transport });
  try {
    await expect(transport.request('runtime.capabilities')).resolves.toEqual(initialized.capabilities);
    const session = await client.sessions.create({ projectPath: root });
    await runtime.sessions.updateSettings(session.id, { permissionMode: 'plan' });
    const target = path.join(root, 'read.txt');
    await writeFile(target, 'durable explicit read');
    const seen: string[] = [];
    const finishedRuns: string[] = [];
    const subscription = client.events.subscribe({ sessionId: session.id }, event => {
      seen.push(event.type);
      if (event.type === 'tool.finished') finishedRuns.push(event.runId);
    });
    await subscription.ready;
    try {
      const read = await client.runs.start({ sessionId: session.id, prompt: 'read without model', options: {
        lsp: false, toolInvocation: { name: 'read', input: { path: target } },
      } });
      await expect(read.result).resolves.toMatchObject({ phase: 'completed', result: {
        success: true, lastText: expect.stringContaining('durable explicit read'),
      } });
      const denied = await client.runs.start({ sessionId: session.id, prompt: 'deny write in plan mode', options: {
        lsp: false, toolInvocation: { name: 'write', input: { path: target, content: 'must not write' } },
      } });
      const deniedResult = await denied.result;
      await expect(readFile(target, 'utf8')).resolves.toBe('durable explicit read');
      expect(deniedResult.result).toMatchObject({ success: false, lastText: expect.stringContaining('[Blocked]') });
      await expect(client.sessions.cancel({ sessionId: session.id, expectedRunId: read.runId,
        requestId: 'completed-explicit-tool' })).rejects.toMatchObject({ code: 'conflict', data: { denialSource: 'stale_run' } });
      await vi.waitFor(() => expect(seen).toContain('tool.finished'));
      expect(finishedRuns).toEqual(expect.arrayContaining([read.runId, denied.runId]));
      const transcript = await client.sessions.transcript(session.id);
      expect(JSON.stringify(transcript)).toContain('durable explicit read');
      expect(JSON.stringify(transcript)).toContain('deny write in plan mode');
      await runtime.close();
      const restarted = await createKodaXRuntime({ homeDir: root, sessionsDir, sharedDaemonHost: true });
      try {
        expect((await restarted.sessions.transcript(session.id))?.messages).toEqual(transcript?.messages);
        await expect(restarted.runs.get(read.runId)).resolves.toMatchObject({ phase: 'completed' });
        await expect(restarted.runs.get(denied.runId)).resolves.toMatchObject({ phase: 'failed' });
      } finally { await restarted.close(); }
      expect(providerCalls).not.toHaveBeenCalled();
    } finally { subscription.close(); }
  } finally {
    await client.close(); await host.close(); await runtime.close();
    unregister(); vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

it('owns explicit Shell effects and confirms process cleanup through real shared Runtime Stop', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-owned-shell-'));
  const extensions = createExtensionRuntime().activate();
  vi.stubEnv('KODAX_HOME', path.join(root, '.kodax'));
  const sessionsDir = path.join(root, 'sessions');
  const runtime = await createKodaXRuntime({ homeDir: root, sessionsDir, sharedDaemonHost: true, defaultProvider: 'openai' });
  const session = await runtime.sessions.create({ projectPath: root });
  await runtime.sessions.updateSettings(session.id, { permissionMode: 'full-access' });
  const server = await createRuntimeDaemonSocketServer({ endpoint: defaultRuntimeDaemonEndpoint('owned-shell', root),
    createDispatcher: (notify, disconnect) => createRuntimeDaemonDispatcher({ runtime, notify, disconnect }) });
  const transport = await createRuntimeDaemonSocketClientTransport(server.endpoint);
  const initialized = await transport.request('initialize', { profile: 'default' }) as {
    identity: typeof runtime.identity; capabilities: Readonly<Record<string, unknown>>;
  };
  const client = createRuntimeDaemonClient({ ...initialized, transport });
  const lock = path.join(sessionsDir, '.write-locks', `${createHash('sha256').update(session.id).digest('hex')}.lock`);
  let childPid: number | undefined;
  let testFailure: unknown;
  try {
    const extensionFile = path.join(root, 'managed-command.mjs');
    await writeFile(extensionFile, `export default api => api.registerCommand({ name: 'managed-stop', description: 'managed Stop test',
      handler: async args => ({ message: String(await api.getExecutionScope().invokeTool('bash', { command: args[0] })) }) });`);
    await extensions.loadExtension(extensionFile);
    await writeFile(path.join(root, 'read.txt'), 'owned invocation');
    const read = await client.runs.start({ sessionId: session.id, prompt: 'read explicitly', options: {
      lsp: false, toolInvocation: { name: 'read', input: { path: path.join(root, 'read.txt') } },
    } });
    await expect(read.result).resolves.toMatchObject({ phase: 'completed', result: { success: true,
      lastText: expect.stringContaining('owned invocation') } });
    for (const command of ['node -e "process.exit(7)"', 'kodax_nonexistent_command_299']) {
      const failed = await client.runs.start({ sessionId: session.id, prompt: `!${command}`, options: {
        lsp: false, toolInvocation: { name: 'bash', input: { command } },
      } });
      await expect(failed.result).resolves.toMatchObject({ result: { success: false } });
    }
    const pidFile = path.join(root, 'child.pid');
    const command = `node -e "require('fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)" "${pidFile}"`;
    const run = await client.runs.start({ sessionId: session.id, prompt: '!owned shell', options: {
      lsp: false, toolInvocation: { name: 'bash', input: { command } },
    } });
    await vi.waitFor(async () => { childPid = Number(await readFile(pidFile, 'utf8')); expect(childPid).toBeGreaterThan(0); }, { timeout: 15_000 });
    await mkdir(path.dirname(lock), { recursive: true });
    await writeFile(lock, `${process.pid} owned-shell-test`, { flag: 'wx' });
    const receipt = await client.sessions.cancel({ sessionId: session.id, expectedRunId: run.runId, requestId: 'stop-shell' });
    expect(receipt.receipts[0]).toMatchObject({ runId: run.runId, accepted: true });
    await rm(lock);
    await expect(run.result).resolves.toMatchObject({ stop: { state: 'confirmed', outcome: 'interrupted' } });
    expect(() => process.kill(childPid!, 0)).toThrow();
    await rm(pidFile);
    let commandRunId: string | undefined;
    const commandResult = executeCommand({ command: 'managed-stop', args: [command] },
      { sessionId: session.id, gitRoot: root } as never,
      { executeToolInvocation: async (toolInvocation: { name: string; input: Record<string, unknown> }, prompt: string) => {
        const handle = await client.runs.start({ sessionId: session.id, prompt, options: { lsp: false, toolInvocation } });
        commandRunId = handle.runId;
        const result = await handle.result;
        return result.result ?? { success: false, lastText: '[Cancelled] stopped', messages: [], sessionId: session.id };
      } } as never, {} as never);
    await vi.waitFor(async () => { childPid = Number(await readFile(pidFile, 'utf8')); expect(commandRunId).toBeDefined(); }, { timeout: 15_000 });
    await writeFile(lock, `${process.pid} command-stop-test`, { flag: 'wx' });
    await client.sessions.cancel({ sessionId: session.id, expectedRunId: commandRunId!, requestId: 'stop-extension-command' });
    await rm(lock);
    await expect(commandResult).resolves.toBe(false);
    expect(() => process.kill(childPid!, 0)).toThrow();
  } catch (error: unknown) {
    testFailure = error;
    throw error;
  } finally {
    const cleanupFailures: unknown[] = [];
    for (const cleanup of [
      () => rm(lock, { force: true }),
      () => client.close(), () => server.close(), () => runtime.close(),
      () => extensions.dispose(),
      () => { vi.unstubAllEnvs(); },
      () => rm(root, { recursive: true, force: true, maxRetries: 3 }),
    ]) {
      try { await cleanup(); } catch (error: unknown) { cleanupFailures.push(error); }
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(testFailure === undefined ? cleanupFailures : [testFailure, ...cleanupFailures],
        'Owned Shell test cleanup failed.', { cause: testFailure });
    }
  }
}, 60_000);
