import type { ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ManagedChildProcessMetadata, ManagedChildRegistrationOptions } from '@kodax-ai/agent';
import { expect, it, vi } from 'vitest';
import { clearRuntimeModelProviders, KodaXBaseProvider, registerModelProvider } from '@kodax-ai/llm';
import type { KodaXProviderConfig, KodaXStreamResult } from '@kodax-ai/llm';

const cleanup = vi.hoisted(() => ({ verified: false, children: [] as ChildProcess[] }));
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

const command = 'node -e "setTimeout(() => {}, 150)"';
let providerCalls = 0;
class TimeoutProvider extends KodaXBaseProvider {
  readonly name = 'shell-timeout-test';
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'SHELL_TIMEOUT_TEST_KEY', model: 'offline', supportsThinking: false,
    contextWindow: 64_000, maxOutputTokens: 2_048,
  };
  async stream(): Promise<KodaXStreamResult> {
    providerCalls++;
    return { textBlocks: [], thinkingBlocks: [], stopReason: 'tool_use',
      toolBlocks: [{ type: 'tool_use', id: `bash-${providerCalls}`, name: 'bash',
        input: { command, timeout: 0.02 } }] };
  }
}

it.each(['direct', 'managed'] as const)('publishes %s Shell cleanup as unknown, fences successors, and recovers via Stop', async (mode) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-shell-timeout-'));
  vi.stubEnv('KODAX_HOME', path.join(root, '.kodax'));
  vi.stubEnv('SHELL_TIMEOUT_TEST_KEY', 'offline-test');
  registerModelProvider('shell-timeout-test', () => new TimeoutProvider());
  providerCalls = 0;
  cleanup.verified = false;
  const runtime = await createKodaXRuntime({ homeDir: root, sessionsDir: path.join(root, 'sessions'),
    sharedDaemonHost: true, defaultProvider: 'shell-timeout-test' });
  let runId: string | undefined;
  try {
    const session = await runtime.sessions.create({ projectPath: root });
    await runtime.sessions.updateSettings(session.id, { permissionMode: 'full-access' });
    const run = await runtime.runs.start({ sessionId: session.id, prompt: 'timeout', options: {
      lsp: false, ...(mode === 'managed' ? { agentMode: 'ama' as const } : {
        toolInvocation: { name: 'bash', input: { command, timeout: 0.02 } },
      }),
    } });
    runId = run.runId;
    await vi.waitFor(async () => expect(await runtime.runs.get(run.runId)).toMatchObject({
      phase: 'unknown', stop: { state: 'unknown' }, failureDetail: { failureKind: 'runtime_cleanup' },
    }), { timeout: 15_000 });
    // Allow the aborted model loop to unwind; cleanup must keep its identity.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await runtime.runs.get(run.runId)).toMatchObject({
      phase: 'unknown', failureDetail: { failureKind: 'runtime_cleanup' },
    });
    expect(providerCalls).toBe(mode === 'managed' ? 1 : 0);
    const file = path.join(root, '.kodax', 'runtime', 'profiles', 'default', 'runs', run.runId, 'status.json');
    expect(JSON.parse(await readFile(file, 'utf8'))._runtime.shellCleanups).toHaveLength(1);
    const stop = { sessionId: session.id, expectedRunId: run.runId, requestId: 'retry-cleanup' };
    await runtime.sessions.cancel(stop);
    await writeFile(path.join(root, 'later.txt'), 'successor');
    const later = await runtime.runs.start({ sessionId: session.id, prompt: 'later', options: {
      lsp: false, toolInvocation: { name: 'read', input: { path: path.join(root, 'later.txt') } },
    } });
    expect(await runtime.runs.get(later.runId)).toMatchObject({ phase: 'queued' });
    cleanup.verified = true;
    await runtime.sessions.cancel(stop);
    await expect(run.result).resolves.toMatchObject({ phase: 'interrupted' });
    await expect(later.result).resolves.toMatchObject({ phase: 'completed' });
    expect(JSON.parse(await readFile(file, 'utf8'))._runtime.shellCleanups).toEqual([]);
  } finally {
    cleanup.verified = true;
    if (runId) await runtime.runs.abort(runId);
    await runtime.close();
    for (const child of cleanup.children) if (child.exitCode === null) child.kill();
    cleanup.children = [];
    clearRuntimeModelProviders();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
