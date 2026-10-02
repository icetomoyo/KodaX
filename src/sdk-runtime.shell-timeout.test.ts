import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ManagedChildProcessMetadata, ManagedChildRegistrationOptions } from '@kodax-ai/agent';
import { expect, it, vi } from 'vitest';
import { clearRuntimeModelProviders, KodaXBaseProvider, registerModelProvider } from '@kodax-ai/llm';
import type { KodaXMessage, KodaXProviderConfig, KodaXStreamResult } from '@kodax-ai/llm';

const cleanup = vi.hoisted(() => ({ verified: false, children: [] as ChildProcess[],
  failStatusWrite: false, writeFailed: false }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, renameSync: (source: import('node:fs').PathLike, target: import('node:fs').PathLike) => {
    if (cleanup.failStatusWrite && !cleanup.writeFailed && String(target).endsWith('status.json')
      && actual.readFileSync(source, 'utf8').includes('"deferred": true')) {
      cleanup.writeFailed = true;
      throw new Error('temporary cleanup status write failure');
    }
    return actual.renameSync(source, target);
  } };
});
vi.mock('@kodax-ai/agent', async (importOriginal) => ({
  ...await importOriginal<typeof import('@kodax-ai/agent')>(),
  isCurrentProcessWindowsJobContained: () => true,
  killChildProcessTree: async () => ({ status: cleanup.verified ? 'already-exited' as const : 'unknown' as const }),
  registerManagedChildProcess: (child: ChildProcess, metadata: ManagedChildProcessMetadata,
    options: ManagedChildRegistrationOptions) => {
    cleanup.children.push(child);
    options.onRegistered?.({ runtimeRunId: metadata.runtimeRunId!, pid: child.pid!,
      registrationId: '12345678-1234-4234-8234-123456789abc' });
    return () => undefined;
  },
}));
import { createKodaXRuntime } from './sdk-runtime.js';
import { connectKodaXClient } from './sdk-client.js';
import { startRuntimeDaemonHost } from './runtime-daemon/host.js';
import { resolveRuntimeDaemonPaths, tryAcquireRuntimeDaemonLock } from './runtime-daemon/state.js';

const command = 'node -e "process.stdout.write(\'partial-diagnostic\');setTimeout(() => {}, 150)"';
let providerCalls = 0;
let receivedToolResult = '';
let explicitStop = false;
class TimeoutProvider extends KodaXBaseProvider {
  readonly name = 'shell-timeout-test';
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'SHELL_TIMEOUT_TEST_KEY', model: 'offline', supportsThinking: false,
    contextWindow: 64_000, maxOutputTokens: 2_048,
  };
  async stream(messages: KodaXMessage[]): Promise<KodaXStreamResult> {
    providerCalls++;
    if (providerCalls > 1) {
      receivedToolResult += JSON.stringify(messages);
      return { textBlocks: [{ type: 'text', text: 'The command timed out. I can inspect its partial output and continue.' }],
        thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' };
    }
    return { textBlocks: [], thinkingBlocks: [], stopReason: 'tool_use',
      toolBlocks: [{ type: 'tool_use', id: `bash-${providerCalls}`, name: 'bash',
        input: { command, timeout: explicitStop ? 30 : 0.02 } }] };
  }
}

it.each(['direct', 'managed', 'managed-retry', 'stopped', 'product'] as const)('keeps the session usable after %s Shell cleanup remains unknown', async (mode) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-shell-timeout-'));
  vi.stubEnv('KODAX_HOME', path.join(root, '.kodax'));
  vi.stubEnv('SHELL_TIMEOUT_TEST_KEY', 'offline-test');
  registerModelProvider('shell-timeout-test', () => new TimeoutProvider());
  providerCalls = 0;
  receivedToolResult = '';
  explicitStop = mode === 'stopped';
  cleanup.verified = false;
  cleanup.children = [];
  cleanup.failStatusWrite = mode === 'managed-retry';
  cleanup.writeFailed = false;
  const runtime = await createKodaXRuntime({ homeDir: root, sessionsDir: path.join(root, 'sessions'),
    sharedDaemonHost: true, defaultProvider: 'shell-timeout-test' });
  let runId: string | undefined;
  let runResult: Promise<unknown> | undefined;
  let closing = false;
  let host: Awaited<ReturnType<typeof startRuntimeDaemonHost>> | undefined;
  let client: Awaited<ReturnType<typeof connectKodaXClient>> | undefined;
  try {
    if (mode === 'product') {
      const paths = resolveRuntimeDaemonPaths(root);
      const lock = tryAcquireRuntimeDaemonLock(paths, { runtimeId: runtime.identity.runtimeId, pid: process.pid, createdAt: runtime.identity.startedAt });
      if (!lock) throw new Error('Isolated Shell Host lock unavailable');
      const endpoint = process.platform === 'win32'
        ? { kind: 'pipe' as const, path: `\\\\.\\pipe\\kodax-shell-product-${randomUUID()}` }
        : { kind: 'unix' as const, path: path.join(root, 'shell-host.sock') };
      host = await startRuntimeDaemonHost({ runtime, paths, lock, endpoint });
      client = await connectKodaXClient({ homeDir: root, endpoint: endpoint.path });
    }
    const session = await runtime.sessions.create({ projectPath: root });
    await runtime.sessions.updateSettings(session.id, { permissionMode: 'full-access', ...(client ? { agentMode: 'ama' as const } : {}) });
    const run = client ? await (async () => {
      const accepted = await client.inputs.submit({ sessionId: session.id, inputId: 'timeout', text: 'timeout' });
      return { runId: accepted.runId!, result: runtime.runs.await(accepted.runId!) };
    })() : await runtime.runs.start({ sessionId: session.id, prompt: 'timeout', options: {
      lsp: false, ...(mode !== 'direct' ? { agentMode: 'ama' as const } : {
        toolInvocation: { name: 'bash', input: { command, timeout: 0.02 } },
      }),
    } });
    runId = run.runId;
    runResult = run.result;
    await writeFile(path.join(root, 'later.txt'), 'successor');
    let queuedRunId: string | undefined;
    if (explicitStop) {
      await vi.waitFor(() => expect(cleanup.children.length).toBeGreaterThan(0), { timeout: 5_000 });
      await runtime.sessions.cancel({ sessionId: session.id, expectedRunId: run.runId, requestId: 'stop' });
      const input = { sessionId: session.id, afterRunId: run.runId, delivery: 'after_turn' as const,
        input: [{ type: 'text' as const, text: 'continue after Stop' }], options: {
          lsp: false, toolInvocation: { name: 'read', input: { path: path.join(root, 'later.txt') } },
        } };
      const queued = await runtime.runs.submitInput(input);
      expect(queued.accepted).toBe(true);
      if (queued.accepted) queuedRunId = queued.runId;
    } else if (mode.startsWith('managed')) {
      await vi.waitFor(() => expect(cleanup.children.length).toBeGreaterThan(0), { timeout: 5_000 });
      const interrupt = await runtime.runs.submitInput({ sessionId: session.id,
        afterRunId: run.runId, delivery: 'interrupt', input: [{ type: 'text', text: 'report cleanup diagnosis' }] });
      expect(interrupt.accepted).toBe(true);
    }
    let finished = false;
    void run.result.then(() => { finished = true; });
    await vi.waitFor(() => expect(finished).toBe(true), { timeout: 15_000 });
    const result = await run.result;
    expect(result.phase).toBe(mode === 'stopped' ? 'interrupted' : mode === 'direct' ? 'failed' : 'completed');
    expect(result.terminal?.effectOutcome).toBe('unknown');
    if (mode.startsWith('managed') || client) {
      expect(providerCalls).toBeGreaterThanOrEqual(2);
      expect(receivedToolResult).toContain('partial-diagnostic');
      expect(receivedToolResult).toContain('Shell PID:');
      expect(receivedToolResult).toContain('[Unknown]');
      if (!client) expect(receivedToolResult).toContain('report cleanup diagnosis');
      expect(result.stop).toBeUndefined();
      if (mode === 'managed-retry') expect(cleanup.writeFailed).toBe(true);
    } else expect(providerCalls).toBe(mode === 'stopped' ? 1 : 0);
    const file = path.join(root, '.kodax', 'runtime', 'profiles', 'default', 'runs', run.runId, 'status.json');
    expect(JSON.parse(await readFile(file, 'utf8'))._runtime.shellCleanups).toEqual([
      expect.objectContaining({ deferred: true }),
    ]);
    if (client) {
      expect(await client.runs.await(run.runId)).toMatchObject({ phase: 'completed', terminal: { effectOutcome: 'unknown' } });
      expect(await client.runs.read(run.runId)).toMatchObject({ terminal: { effectOutcome: 'unknown' } });
      const accepted = await client.inputs.submit({ sessionId: session.id, inputId: 'product-successor', text: 'Continue after the unknown Shell cleanup.' });
      expect(await client.runs.await(accepted.runId!)).toMatchObject({ phase: 'completed' });
    }
    await writeFile(path.join(root, 'later.txt'), 'successor');
    const later = await runtime.runs.start({ sessionId: session.id, prompt: 'later', options: {
      lsp: false, toolInvocation: { name: 'read', input: { path: path.join(root, 'later.txt') } },
    } });
    await expect(later.result).resolves.toMatchObject({ phase: 'completed' });
    if (queuedRunId) await expect(runtime.runs.await(queuedRunId)).resolves.toMatchObject({ phase: 'completed' });
    // Even close must not turn this deferred OS cleanup into a session lock.
    closing = true;
    await client?.disconnect(); await host?.close();
    await runtime.close();
  } finally {
    cleanup.verified = true;
    if (runId && !closing) await runtime.runs.abort(runId);
    await runResult;
    await client?.disconnect(); await host?.close();
    await runtime.close();
    for (const child of cleanup.children) if (child.exitCode === null) child.kill();
    cleanup.children = [];
    clearRuntimeModelProviders();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
}, 30_000);
