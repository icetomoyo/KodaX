import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { cleanupRegisteredManagedChildren, setAgentConfigHome } from '@kodax-ai/agent';
import { createKodaXRuntime } from './sdk-runtime.js';

it('registers tool children in the SDK Runtime home rather than the process default home', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-shell-private-home-'));
  const homeDir = path.join(root, 'sdk');
  const configHome = path.join(homeDir, '.kodax');
  const defaultHome = path.join(root, 'default-home');
  setAgentConfigHome(defaultHome);
  const runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true, defaultProvider: 'unconfigured-provider' });
  try {
    const session = await runtime.sessions.create({ projectPath: root });
    await runtime.sessions.updateSettings(session.id, { permissionMode: 'full-access' });
    const run = await runtime.runs.start({ sessionId: session.id, prompt: 'local tool test', options: {
      lsp: false, toolInvocation: { name: 'bash', input: { command: 'node -e "setInterval(()=>{},1000)"', run_in_background: true } },
    } });
    await expect(run.result).resolves.toMatchObject({ phase: 'completed' });
    const directory = path.join(configHome, 'runtime', 'processes', 'children');
    const records = (await readdir(directory)).filter(name => name.endsWith('.json'));
    expect(records.length).toBeGreaterThan(0);
    for (const file of records) expect(JSON.parse(await readFile(path.join(directory, file), 'utf8')))
      .toMatchObject({ runtimeRunId: run.runId, ownerPid: process.pid });
  } finally {
    for (const home of [configHome, defaultHome]) {
      await cleanupRegisteredManagedChildren({ scope: 'current-owner', includeCurrentOwner: true, configHome: home });
    }
    await runtime.close();
    setAgentConfigHome(undefined);
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 60_000);
