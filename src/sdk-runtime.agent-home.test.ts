import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { getActiveAgentHomes, setAgentConfigHome } from '@kodax-ai/agent';
import { createKodaXRuntime, type KodaXRuntime } from '../tests/runtime-fixture.js';

// Model-side write protection must cover the agent home an inline Runtime loads
// extensions and integrations from, not only the process agent home.
it('protects the inline Runtime agent home while the Runtime is open', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-sdk-agent-home-'));
  const homeDir = path.join(root, 'sdk');
  const configHome = path.resolve(homeDir, '.kodax');
  setAgentConfigHome(path.join(root, 'default'));
  let runtime: KodaXRuntime | undefined;
  try {
    runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true });
    expect(getActiveAgentHomes()).toContain(configHome);

    await runtime.close();
    runtime = undefined;
    expect(getActiveAgentHomes()).not.toContain(configHome);
  } finally {
    await runtime?.close();
    setAgentConfigHome(undefined);
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 60_000);
