import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getActiveExtensionRuntime } from '@kodax-ai/coding';
import { withExtensionRuntimeContext } from '../packages/coding/src/extensions/runtime.js';
import { createInteractiveContext, executeCommand } from '@kodax-ai/repl';
import { createMcpTestServerFixture } from '@kodax-ai/agent';
import { connectKodaXClient } from '@kodax-ai/kodax/client';
import { createKodaXRuntime } from './sdk-runtime.js';
import { startRuntimeDaemonHost } from './runtime-daemon/host.js';
import { resolveRuntimeDaemonPaths, tryAcquireRuntimeDaemonLock } from './runtime-daemon/state.js';

let directory: string;
let runtime: Awaited<ReturnType<typeof createKodaXRuntime>>;
let host: Awaited<ReturnType<typeof startRuntimeDaemonHost>>;
let client: Awaited<ReturnType<typeof connectKodaXClient>>;
const currentConfig: Parameters<typeof executeCommand>[3] = {
  provider: 'unused', thinking: false, reasoningMode: 'off', agentMode: 'sa', permissionMode: 'auto',
};
const callbacks: Parameters<typeof executeCommand>[2] = {
  exit: () => undefined, saveSession: async () => undefined, loadSession: async () => 'missing',
  listSessions: async () => undefined, clearHistory: () => undefined, printHistory: () => undefined,
  ui: { select: async () => undefined, confirm: async () => false, input: async () => undefined },
};
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'kodax-host-diagnostics-'));
  vi.stubEnv('KODAX_HOME', path.join(directory, '.kodax'));
  runtime = await createKodaXRuntime({ homeDir: directory, sharedDaemonHost: true });
  const paths = resolveRuntimeDaemonPaths(directory);
  const lock = tryAcquireRuntimeDaemonLock(paths, { runtimeId: runtime.identity.runtimeId, pid: process.pid, createdAt: runtime.identity.startedAt });
  if (!lock) throw new Error('Could not acquire isolated diagnostics Host.');
  const endpoint = process.platform === 'win32'
    ? { kind: 'pipe' as const, path: `\\\\.\\pipe\\kodax-diagnostics-${randomUUID()}` }
    : { kind: 'unix' as const, path: path.join(directory, 'host.sock') };
  host = await startRuntimeDaemonHost({ runtime, paths, lock, endpoint });
  client = await connectKodaXClient({ homeDir: directory, endpoint: endpoint.path });
});
afterEach(async () => {
  await client?.disconnect(); await host?.close(); await runtime?.close();
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

it('renders Host extension diagnostics through /ext when the client has no local extension runtime', async () => {
  const extensionPath = path.join(directory, 'host-diagnostic-extension.mjs');
  await writeFile(extensionPath, `export default api => api.registerCommand({ name: 'host-diagnostic-command',
    description: 'Only loaded inside the Host', execution: 'configuration', handler: () => undefined });`);
  await getActiveExtensionRuntime()!.loadExtension(extensionPath);
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  await withExtensionRuntimeContext(async () => {
    expect(getActiveExtensionRuntime()).toBeNull();
    await executeCommand({ command: 'ext', args: [] }, await createInteractiveContext({ sessionId: 'unused' }),
      { ...callbacks, inspectExtensions: () => client.catalog.extensions() }, currentConfig);
  }, null);
  const text = output.mock.calls.map(parts => parts.join(' ')).join('\n');
  expect(text).toContain('host-diagnostic-extension');
  expect(text).toContain('/host-diagnostic-command');
  expect(text).not.toContain('No active extension runtime');
});

it('reads actual Host MCP status without waking lazy servers and refreshes their catalogs explicitly', async () => {
  const fixture = await createMcpTestServerFixture(directory);
  await client.mcp.upsertServer(fixture.serverId, { ...fixture.servers[fixture.serverId]!, connect: 'lazy' });
  await vi.waitFor(async () => expect((await client.catalog.extensions()).diagnostics?.capabilityProviders.map(provider => provider.id)).toContain('mcp'), { timeout: 10_000 });
  expect(await client.mcp.reloadServers()).toMatchObject({ servers: [{ serverId: fixture.serverId, status: 'idle', tools: 0 }] });
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  await withExtensionRuntimeContext(async () => {
    expect(getActiveExtensionRuntime()).toBeNull();
    const context = await createInteractiveContext({ sessionId: 'unused' });
    const invoke = (args: string[]) => executeCommand({ command: 'mcp', args }, context,
      { ...callbacks, mcp: client.mcp }, currentConfig);
    await invoke(['status']);
    expect(output.mock.calls.flat().join('\n')).toContain(fixture.serverId);
    expect(await client.mcp.status()).toMatchObject([{ serverId: fixture.serverId, status: 'idle', tools: 0 }]);
    output.mockClear();
    await invoke(['refresh']);
    expect(output.mock.calls.flat().join('\n')).toContain('MCP catalogs refreshed.');
    expect(await client.mcp.status()).toMatchObject([{ serverId: fixture.serverId, status: 'ready', tools: 1, resources: 1, prompts: 1 }]);
    output.mockClear();
    await invoke([]);
    const displayed = output.mock.calls.flat().join('\n');
    expect(displayed).toContain('ready');
    expect(displayed).toContain('tools=1  resources=1  prompts=1');
  }, null);
});

it('drains an admitted catalog read before disposing the MCP provider during configuration reload', async () => {
  const fixture = await createMcpTestServerFixture(directory);
  const entered = path.join(directory, 'initialize-entered');
  const release = path.join(directory, 'initialize-release');
  const source = await readFile(fixture.scriptPath, 'utf8');
  await writeFile(fixture.scriptPath, source.replace("if (method === 'initialize') {", `if (method === 'initialize') {
    const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(entered)}, 'entered');
    const gate = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) {
      clearInterval(gate); handleRequest({ ...message, method: 'initialize-released' });
    } }, 10); return;
  }
  if (method === 'initialize-released') {`));
  await client.mcp.upsertServer(fixture.serverId, { ...fixture.servers[fixture.serverId]!, connect: 'lazy' });
  await vi.waitFor(async () => expect((await client.catalog.extensions()).diagnostics?.capabilityProviders.map(provider => provider.id)).toContain('mcp'), { timeout: 10_000 });
  const previous = getActiveExtensionRuntime()!.getCapabilityProvider('mcp');
  const reading = client.mcp.listTools({ forceRefresh: true });
  const readResult = reading.then(value => ({ value }), error => ({ error: String(error) }));
  await vi.waitFor(async () => expect(await readFile(entered, 'utf8')).toBe('entered'), { timeout: 10_000 });
  let replacementSettled = false;
  const replacing = client.mcp.reloadServers().finally(() => { replacementSettled = true; });
  try {
    await vi.waitFor(() => expect(getActiveExtensionRuntime()!.getCapabilityProvider('mcp')).not.toBe(previous), { timeout: 10_000 });
    expect(replacementSettled).toBe(false);
  } finally {
    await writeFile(release, 'release');
    await replacing;
  }
  expect(await readResult).toMatchObject({ value: [{ serverId: fixture.serverId, tools: [{ name: 'echo_tool' }] }] });
  expect(await client.mcp.status()).toMatchObject([{ serverId: fixture.serverId, status: 'idle' }]);
});
