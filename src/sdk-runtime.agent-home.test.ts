import { mkdtemp, rm } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { getActiveAgentHomes, setAgentConfigHome } from '@kodax-ai/agent';
import { createKodaXRuntime, type KodaXRuntime } from '../tests/runtime-fixture.js';
import { isAgentHomeHostLoadedTarget } from '../packages/coding/src/permissions/agent-home-policy.js';

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

it('keeps other Runtime homes protected through repeated close and a failed initialization', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-sdk-multiple-homes-'));
  const firstHome = path.join(root, 'first');
  const secondHome = path.join(root, 'second');
  const failedHome = path.join(root, 'failed');
  const configHome = (home: string) => path.resolve(home, '.kodax');
  const loadedCode = (home: string) => path.join(configHome(home), 'extensions', 'example.ts');
  const runtimes: KodaXRuntime[] = [];
  setAgentConfigHome(path.join(root, 'process-default'));
  try {
    const first = await createKodaXRuntime({ homeDir: firstHome, sharedDaemonHost: true });
    runtimes.push(first);
    const second = await createKodaXRuntime({ homeDir: secondHome, sharedDaemonHost: true });
    runtimes.push(second);
    for (const home of [firstHome, secondHome]) {
      expect(getActiveAgentHomes()).toContain(configHome(home));
      expect(isAgentHomeHostLoadedTarget(loadedCode(home))).toBe(true);
    }
    await first.close();
    await first.close();
    expect(getActiveAgentHomes()).not.toContain(configHome(firstHome));
    expect(isAgentHomeHostLoadedTarget(loadedCode(firstHome))).toBe(false);
    expect(getActiveAgentHomes()).toContain(configHome(secondHome));
    expect(isAgentHomeHostLoadedTarget(loadedCode(secondHome))).toBe(true);

    const config = path.join(configHome(failedHome), 'config.json');
    mkdirSync(path.dirname(config), { recursive: true });
    writeFileSync(config, '{}');
    let injected = false;
    await expect(createKodaXRuntime({ homeDir: failedHome, sharedDaemonHost: true,
      onStartupProgress(progress) {
        if (progress.stage === 'initializing' && progress.phase === 'mcp') {
          injected = true;
          writeFileSync(config, '{broken');
        }
      },
    })).rejects.toThrow();
    expect(injected).toBe(true);
    expect(getActiveAgentHomes()).not.toContain(configHome(failedHome));
    expect(isAgentHomeHostLoadedTarget(loadedCode(failedHome))).toBe(false);
    expect(isAgentHomeHostLoadedTarget(loadedCode(secondHome))).toBe(true);

    writeFileSync(config, '{}');
    const recovered = await createKodaXRuntime({ homeDir: failedHome, sharedDaemonHost: true });
    runtimes.push(recovered);
    expect(isAgentHomeHostLoadedTarget(loadedCode(failedHome))).toBe(true);
    await recovered.close();
    await second.close();
    for (const home of [firstHome, secondHome, failedHome]) {
      expect(getActiveAgentHomes()).not.toContain(configHome(home));
      expect(isAgentHomeHostLoadedTarget(loadedCode(home))).toBe(false);
    }
  } finally {
    await Promise.all(runtimes.map(runtime => runtime.close()));
    setAgentConfigHome(undefined);
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 60_000);
