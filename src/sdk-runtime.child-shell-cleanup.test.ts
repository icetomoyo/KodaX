import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { clearRuntimeModelProviders, KodaXBaseProvider, registerModelProvider } from '@kodax-ai/llm';
import type { KodaXMessage, KodaXProviderConfig, KodaXStreamResult } from '@kodax-ai/llm';

const cleanup = vi.hoisted(() => ({ blocked: true, calls: 0,
  child: undefined as Parameters<typeof import('@kodax-ai/agent').killChildProcessTree>[0] | undefined }));
vi.mock('@kodax-ai/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kodax-ai/agent')>();
  return { ...actual, killChildProcessTree: async (...args: Parameters<typeof actual.killChildProcessTree>) => {
    cleanup.child = args[0];
    cleanup.calls++;
    return cleanup.blocked ? { status: 'unknown' as const } : actual.killChildProcessTree(...args);
  } };
});
import { createKodaXRuntime } from './sdk-runtime.js';

const providerName = 'child-shell-cleanup-test';
let command = '';
let parentCalls = 0;
class ChildShellProvider extends KodaXBaseProvider {
  readonly name = providerName;
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'CHILD_SHELL_TEST_KEY', model: 'offline', supportsThinking: false,
    contextWindow: 64_000, maxOutputTokens: 2_048,
  };
  async stream(messages: KodaXMessage[]): Promise<KodaXStreamResult> {
    const child = JSON.stringify(messages.find((message) => message.role === 'user')?.content)
      .includes('CHILD_SHELL_OBJECTIVE');
    const invocation = child
      ? { name: 'bash', input: { command } }
      : ++parentCalls === 1
        ? { name: 'spawn_agent', input: { task_name: 'worker', objective: 'CHILD_SHELL_OBJECTIVE', read_only: false } }
        : { name: 'wait_agent', input: { timeout_ms: 10_000 } };
    return { textBlocks: [], thinkingBlocks: [], stopReason: 'tool_use',
      toolBlocks: [{ type: 'tool_use', id: `call-${messages.length}`, ...invocation }] };
  }
}

it('keeps a child Actor Shell fenced through SDK Stop and the same-request recovery', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-child-shell-stop-'));
  vi.stubEnv('KODAX_HOME', path.join(root, '.kodax'));
  vi.stubEnv('CHILD_SHELL_TEST_KEY', 'offline-test');
  registerModelProvider(providerName, () => new ChildShellProvider());
  cleanup.blocked = true; cleanup.calls = 0; parentCalls = 0;
  const runtime = await createKodaXRuntime({ homeDir: root, sessionsDir: path.join(root, 'sessions'),
    sharedDaemonHost: true, defaultProvider: providerName });
  try {
    const session = await runtime.sessions.create({ projectPath: root });
    await runtime.sessions.updateSettings(session.id, { permissionMode: 'full-access' });
    const pidFile = path.join(root, 'child.pid');
    await writeFile(path.join(root, 'read.txt'), 'later input');
    command = `node -e "require('fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)" "${pidFile}"`;
    const run = await runtime.runs.start({ sessionId: session.id, prompt: 'Start a worker and wait.',
      options: { lsp: false, agentMode: 'ama' } });
    await vi.waitFor(async () => expect(Number(await readFile(pidFile, 'utf8'))).toBeGreaterThan(0), { timeout: 20_000 });
    const statusFile = path.join(root, '.kodax', 'runtime', 'profiles', 'default', 'runs', run.runId, 'status.json');
    const durable = JSON.parse(await readFile(statusFile, 'utf8'));
    expect(durable._runtime.shellCleanups).toEqual([
      expect.objectContaining({ runtimeRunId: run.runId, pid: expect.any(Number) }),
    ]);
    const request = { sessionId: session.id, expectedRunId: run.runId, requestId: 'child-stop' };
    await expect(runtime.sessions.cancel(request)).resolves.toMatchObject({
      receipts: [expect.objectContaining({ accepted: true, state: 'unknown' })],
    });
    const later = await runtime.runs.start({ sessionId: session.id, prompt: 'later', options: {
      lsp: false, toolInvocation: { name: 'read', input: { path: path.join(root, 'read.txt') } },
    } });
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    await expect(runtime.runs.get(run.runId)).resolves.toMatchObject({ stop: { state: 'unknown' } });
    await expect(runtime.runs.get(later.runId)).resolves.toMatchObject({ phase: 'queued' });
    cleanup.blocked = false;
    const replay = await runtime.sessions.cancel(request);
    expect(replay.receipts.map((receipt) => receipt.runId)).toEqual([run.runId]);
    await expect(run.result).resolves.toMatchObject({ phase: 'interrupted', stop: { state: 'confirmed' } });
    await expect(later.result).resolves.toMatchObject({ phase: 'completed' });
    expect(JSON.parse(await readFile(statusFile, 'utf8'))._runtime.shellCleanups).toEqual([]);
    const childPid = Number(await readFile(pidFile, 'utf8'));
    expect(() => process.kill(childPid, 0)).toThrow();
  } finally {
    cleanup.blocked = false;
    if (cleanup.child) {
      const actual = await vi.importActual<typeof import('@kodax-ai/agent')>('@kodax-ai/agent');
      await actual.killChildProcessTree(cleanup.child);
    }
    await runtime.close(); cleanup.child = undefined;
    clearRuntimeModelProviders(); vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
}, 60_000);
