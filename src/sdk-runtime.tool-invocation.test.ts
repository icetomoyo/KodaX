import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { createExtensionRuntime } from '@kodax-ai/coding';
import { executeCommand } from '@kodax-ai/repl';
import { createKodaXRuntime } from './sdk-runtime.js';
import { createRuntimeDaemonClient } from './runtime-daemon/client.js';
import { createRuntimeDaemonDispatcher } from './runtime-daemon/server.js';
import { createRuntimeDaemonSocketServer, createRuntimeDaemonSocketClientTransport, defaultRuntimeDaemonEndpoint } from './runtime-daemon/transport.js';

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
  await transport.request('initialize', { profile: 'default' });
  const client = createRuntimeDaemonClient({ identity: runtime.identity, capabilities: runtime.capabilities, transport });
  const lock = path.join(sessionsDir, '.write-locks', `${createHash('sha256').update(session.id).digest('hex')}.lock`);
  let childPid: number | undefined;
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
  } finally {
    await rm(lock, { force: true });
    await client.close(); await server.close(); await runtime.close();
    await extensions.dispose();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
}, 60_000);
