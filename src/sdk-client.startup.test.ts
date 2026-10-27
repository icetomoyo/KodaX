import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import * as sdk from './sdk-client.js';
import { readRuntimeDaemonLockOwner, resolveRuntimeDaemonPaths } from './runtime-daemon/state.js';
import { waitForRuntimeDaemonOwnerExit } from './runtime-daemon/process.js';

it('starts one Host through the product SDK and shares its Session with passive clients', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-product-startup-'));
  const profile = 'product-startup';
  let client: Awaited<ReturnType<typeof sdk.connectKodaXClient>> | undefined;
  try {
    const failedProgress: sdk.ClientStartupProgress[] = [];
    await expect(sdk.connectKodaXClient({ homeDir, profile,
      onStartupProgress: (event) => { failedProgress.push(event); }, })).rejects.toThrow();
    expect(failedProgress).toEqual([{ stage: 'connecting' }]);
    const progress: sdk.ClientStartupProgress[] = [];
    client = await sdk.ensureKodaXClient({ homeDir, profile, daemonStartupTimeoutMs: 60_000,
      onStartupProgress: (event) => { progress.push(event); }, });
    expect(progress.some(event => event.stage === 'initializing')).toBe(true);
    expect(progress.filter(event => event.stage !== 'initializing')).toEqual([
      { stage: 'checking' }, { stage: 'starting' }, { stage: 'waiting', reason: 'host_starting' },
      { stage: 'connecting' }, { stage: 'ready' },
    ]);
    const session = await client.sessions.create({ title: 'Shared product Session', projectPath: homeDir });
    const attachedProgress: sdk.ClientStartupProgress[] = [];
    const observer = await sdk.connectKodaXClient({ homeDir, profile,
      onStartupProgress: (event) => { attachedProgress.push(event); }, });
    try {
      expect(attachedProgress).toEqual([{ stage: 'connecting' }, { stage: 'ready' }]);
      await expect(observer.sessions.read(session.id)).resolves.toMatchObject({ id: session.id, title: session.title });
    } finally { await observer.disconnect(); }
    const ensuredProgress: sdk.ClientStartupProgress[] = [];
    const ensured = await sdk.ensureKodaXClient({ homeDir, profile,
      onStartupProgress: (event) => { ensuredProgress.push(event); }, });
    try {
      expect(ensuredProgress).toEqual([{ stage: 'checking' }, { stage: 'connecting' }, { stage: 'ready' }]);
      await expect(ensured.sessions.read(session.id)).resolves.toMatchObject({ id: session.id });
    } finally { await ensured.disconnect(); }
  } finally {
    if (client) {
      const owner = readRuntimeDaemonLockOwner(resolveRuntimeDaemonPaths(homeDir, profile).lockFile);
      await client.host.shutdown();
      await client.disconnect();
      if (owner) await waitForRuntimeDaemonOwnerExit(owner, 30_000);
    }
    await rm(homeDir, { recursive: true, force: true });
  }
}, 120_000);

it('reports MCP initialization while a configured server is still starting', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-product-slow-startup-'));
  const profile = 'slow-startup';
  const script = path.join(homeDir, 'server.cjs');
  const release = path.join(homeDir, 'release');
  const entered = path.join(homeDir, 'entered');
  await writeFile(script, `const fs = require('node:fs');
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', async line => {
  const request = JSON.parse(line);
  if (!request.id) return;
  if (request.method === 'initialize') {
    fs.writeFileSync(process.argv[3], 'entered');
    while (!fs.existsSync(process.argv[2])) await new Promise(resolve => setTimeout(resolve, 10));
  }
  const result = request.method === 'initialize'
    ? { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'slow', version: '1' } }
    : { tools: [] };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
});`);
  await mkdir(path.join(homeDir, '.kodax', 'integrations'), { recursive: true });
  await writeFile(path.join(homeDir, '.kodax', 'integrations', 'mcp.json'), JSON.stringify({
    version: 1, servers: { slow: { type: 'stdio', command: process.execPath, args: [script, release, entered],
      connect: 'prewarm', startupTimeoutMs: 20_000 } },
  }));
  const progress: sdk.ClientStartupProgress[] = [];
  const startup = sdk.ensureKodaXClient({ homeDir, profile, daemonStartupTimeoutMs: 60_000,
    onStartupProgress: event => { progress.push(event); } });
  void startup.catch(() => undefined); // The finally block joins startup even if an assertion fails.
  try {
    await expect.poll(() => existsSync(entered), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => progress.at(-1), { timeout: 2_000 })
      .toEqual({ stage: 'initializing', phase: 'mcp' });
    expect(progress.some(event => event.stage === 'ready')).toBe(false);
    await writeFile(release, 'release');
    await expect(startup).resolves.toBeDefined();
    expect(progress.at(-1)?.stage).toBe('ready');
  } finally {
    await writeFile(release, 'release');
    const result = await Promise.allSettled([startup]);
    if (result[0]!.status === 'fulfilled') {
      const client = result[0]!.value;
      const owner = readRuntimeDaemonLockOwner(resolveRuntimeDaemonPaths(homeDir, profile).lockFile);
      await client.host.shutdown();
      await client.disconnect();
      if (owner) await waitForRuntimeDaemonOwnerExit(owner, 30_000);
    }
    await rm(homeDir, { recursive: true, force: true });
  }
}, 90_000);
