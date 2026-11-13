import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('runtime config patch validation', () => {
  let tempRoot: string;
  let previousKodaxHome: string | undefined;
  const daemonOwners: string[] = [];

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-runtime-config-'));
    previousKodaxHome = process.env.KODAX_HOME;
    process.env.KODAX_HOME = path.join(tempRoot, '.kodax');
    vi.resetModules();
  });

  afterEach(async () => {
    vi.restoreAllMocks(); syncBuiltinESMExports();
    try {
      for (const owner of daemonOwners.splice(0)) {
        await shutdownRuntimeDaemon(owner);
      }
    } finally {
      if (previousKodaxHome === undefined) {
        delete process.env.KODAX_HOME;
      } else {
        process.env.KODAX_HOME = previousKodaxHome;
      }
      vi.resetModules();
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('keeps the committed file and execution defaults when a Runtime patch disk write fails', async () => {
    const configFile = path.join(tempRoot, '.kodax', 'config.json');
    await fs.mkdir(path.dirname(configFile), { recursive: true });
    await fs.writeFile(configFile, JSON.stringify({ model: 'before', unknown: { retain: true },
      apiKeys: { deepseek: 'fixture-runtime-preserve-account' } }));
    const { createKodaXRuntime } = await import('../tests/runtime-fixture.js');
    const runtime = await createKodaXRuntime({ homeDir: tempRoot });
    const original = await fs.readFile(configFile, 'utf8');
    const previousTokens = process.env.KODAX_MAX_OUTPUT_TOKENS;
    const write = syncFs.writeFileSync;
    const fault = vi.spyOn(syncFs, 'writeFileSync').mockImplementation((target, data, options) => {
      if (typeof data === 'string' && data.includes('fixture-runtime-preserve-account')) {
        write(target, data.slice(0, 17), options);
        throw Object.assign(new Error('Fixture disk full'), { code: 'ENOSPC' });
      }
      write(target, data, options);
    });
    syncBuiltinESMExports();
    try {
      await expect(runtime.config.patch({ model: 'after', maxOutputTokens: 1234 })).rejects.toThrow('Fixture disk full');
      expect(await fs.readFile(configFile, 'utf8')).toBe(original);
      expect(process.env.KODAX_MAX_OUTPUT_TOKENS).toBe(previousTokens);
      expect(await runtime.config.read()).toMatchObject({ model: 'before', unknown: { retain: true } });
      fault.mockRestore(); syncBuiltinESMExports();
      await runtime.config.patch({ model: 'after' });
      expect(JSON.parse(await fs.readFile(configFile, 'utf8'))).toMatchObject({ model: 'after', unknown: { retain: true },
        apiKeys: { deepseek: 'fixture-runtime-preserve-account' } });
    } finally { fault.mockRestore(); syncBuiltinESMExports(); await runtime.close(); }
  });

  it.each([{ broken: 'fixture-saved-account' }, [
    { name: 'duplicate', protocol: 'openai', baseUrl: 'https://example.local/v1', apiKeyEnv: 'FIXTURE_UNUSED_KEY', model: 'fixture' },
    { name: 'duplicate', protocol: 'openai', baseUrl: 'https://example.local/v1', apiKeyEnv: 'FIXTURE_UNUSED_KEY', model: 'fixture' },
  ]])('retains malformed saved provider bindings before accepting a catalog mutation (%#)', async customProviders => {
    const { createKodaXRuntime } = await import('../tests/runtime-fixture.js');
    const runtime = await createKodaXRuntime({ homeDir: tempRoot });
    const file = path.join(tempRoot, '.kodax', 'config.json');
    const original = JSON.stringify({ customProviders });
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, original);
    try {
      await expect(runtime.catalog.upsertCustomProvider({ name: 'new', protocol: 'openai', baseUrl: 'https://example.local/v1',
        apiKeyEnv: 'FIXTURE_UNUSED_KEY', model: 'fixture' })).rejects.toThrow(/core configuration/i);
      expect(await fs.readFile(file, 'utf8')).toBe(original);
    } finally { await runtime.close(); }
  });

  it('allows explicit public keys and rejects admin-plane keys that have dedicated APIs', async () => {
    const { createKodaXRuntime } = await import("../tests/runtime-fixture.js");
    const runtime = await createKodaXRuntime({
      homeDir: tempRoot,
      sessionsDir: path.join(tempRoot, 'sessions'),
    });
    const configFile = path.join(process.env.KODAX_HOME ?? '', 'config.json');

    try {
      await expect(runtime.config.patch({
        provider: 'openai',
        model: 'gpt-test',
        repoIntelligenceMode: 'light',
      })).resolves.toMatchObject({
        provider: 'openai',
        model: 'gpt-test',
        repoIntelligenceMode: 'light',
      });

      await expect(runtime.config.patch({
        mcpServers: {},
      } as unknown as Parameters<typeof runtime.config.patch>[0]))
        .rejects.toThrow('runtime.config.patch does not support config key: mcpServers');
      await expect(runtime.config.patch({
        customProviders: [],
      } as unknown as Parameters<typeof runtime.config.patch>[0]))
        .rejects.toThrow('runtime.config.patch does not support config key: customProviders');
      await expect(runtime.config.patch({
        arbitrary: 'value',
      } as unknown as Parameters<typeof runtime.config.patch>[0]))
        .rejects.toThrow('runtime.config.patch does not support config key: arbitrary');

      const persisted = JSON.parse(await fs.readFile(configFile, 'utf8')) as Record<string, unknown>;
      expect(persisted).toMatchObject({
        provider: 'openai',
        model: 'gpt-test',
        repoIntelligenceMode: 'light',
      });
      expect(persisted.mcpServers).toBeUndefined();
      expect(persisted.customProviders).toBeUndefined();
      expect(persisted.arbitrary).toBeUndefined();
    } finally {
      await runtime.close();
    }
  });

  it('uses the runtime homeDir for config, custom providers, and MCP servers', async () => {
    const runtimeHome = path.join(tempRoot, 'runtime-home');
    const envHome = path.join(tempRoot, 'env-home');
    process.env.KODAX_HOME = envHome;
    vi.resetModules();
    const { createKodaXRuntime } = await import("../tests/runtime-fixture.js");
    const runtime = await createKodaXRuntime({
      homeDir: runtimeHome,
      sessionsDir: path.join(runtimeHome, '.kodax', 'sessions'),
    });

    try {
      await runtime.config.patch({
        provider: 'openai',
        model: 'home-model',
      });
      await expect(runtime.catalog.upsertCustomProvider({
        name: 'home-custom',
        protocol: 'openai',
        baseUrl: 'https://example.invalid/v1',
        apiKeyEnv: 'HOME_CUSTOM_KEY',
        model: 'home-custom-model',
      })).resolves.toMatchObject({
        name: 'home-custom',
      });
      await expect(runtime.mcp.upsertServer('home-mcp', {
        type: 'stdio',
        command: 'echo',
      })).resolves.toEqual({
        type: 'stdio',
        command: 'echo',
      });
      await expect(runtime.catalog.customProviders()).resolves.toEqual([
        expect.objectContaining({ name: 'home-custom' }),
      ]);
      await expect(runtime.mcp.listServers()).resolves.toEqual({
        'home-mcp': { type: 'stdio', command: 'echo' },
      });

      const runtimeConfigFile = path.join(runtimeHome, '.kodax', 'config.json');
      const runtimeConfig = JSON.parse(await fs.readFile(runtimeConfigFile, 'utf8')) as Record<string, unknown>;
      expect(runtimeConfig).toMatchObject({
        provider: 'openai',
        model: 'home-model',
        customProviders: [expect.objectContaining({ name: 'home-custom' })],
      });
      expect(runtimeConfig.mcpServers).toBeUndefined();
      const mcpConfig = JSON.parse(await fs.readFile(path.join(runtimeHome, '.kodax', 'integrations', 'mcp.json'), 'utf8')) as Record<string, unknown>;
      expect(mcpConfig).toMatchObject({ servers: { 'home-mcp': { type: 'stdio', command: 'echo' } } });
      await expect(fs.access(path.join(envHome, 'config.json'))).rejects.toThrow();
    } finally {
      await runtime.close();
    }
  });

  it('uses homeDir config for SDK auto-started daemon runtimes', async () => {
    const runtimeHome = path.join(tempRoot, 'daemon-runtime-home');
    const envHome = path.join(tempRoot, 'daemon-env-home');
    process.env.KODAX_HOME = envHome;
    vi.resetModules();
    const { createKodaXRuntime } = await import("../tests/runtime-fixture.js");
    daemonOwners.push(runtimeHome);
    const runtime = await createKodaXRuntime({
      mode: 'daemon',
      homeDir: runtimeHome,
      sessionsDir: path.join(runtimeHome, '.kodax', 'sessions'),
      autoStartDaemon: true,
    });

    try {
      await expect(runtime.config.patch({
        provider: 'openai',
        model: 'daemon-home-model',
      })).resolves.toMatchObject({
        provider: 'openai',
        model: 'daemon-home-model',
      });
      const runtimeConfig = JSON.parse(
        await fs.readFile(path.join(runtimeHome, '.kodax', 'config.json'), 'utf8'),
      ) as Record<string, unknown>;
      expect(runtimeConfig).toMatchObject({
        provider: 'openai',
        model: 'daemon-home-model',
      });
      const file = path.join(runtimeHome, '.kodax', 'config.json');
      const original = await fs.readFile(file, 'utf8');
      const lock = `${file}.write.lock`;
      await fs.writeFile(lock, JSON.stringify({ version: 1, pid: process.pid, nonce: 'fixture-live-writer' }));
      try {
        await expect(runtime.config.patch({ model: 'must-not-write' })).rejects.toMatchObject({ code: 'conflict',
          data: { source: 'configuration', reason: 'lock_busy' } });
        expect(await fs.readFile(file, 'utf8')).toBe(original);
      } finally { await fs.rm(lock); }
      await fs.writeFile(file, 'PRIVATE_CONFIG_FRAGMENT');
      try {
        await expect(runtime.config.read()).rejects.toMatchObject({ code: 'internal_error',
          data: { source: 'configuration', reason: 'read_failed' } });
        await expect(runtime.config.patch({ model: 'must-not-clear' })).rejects.not.toThrow('PRIVATE_CONFIG_FRAGMENT');
        expect(await fs.readFile(file, 'utf8')).toBe('PRIVATE_CONFIG_FRAGMENT');
      } finally { await fs.writeFile(file, original); }
      await expect(fs.access(path.join(envHome, 'config.json'))).rejects.toThrow();
    } finally {
      await runtime.close();
    }
    await shutdownRuntimeDaemon(runtimeHome);
    const { readRuntimeDaemonState, resolveRuntimeDaemonPaths } = await import('./runtime-daemon/state.js');
    expect(readRuntimeDaemonState(resolveRuntimeDaemonPaths(runtimeHome))).toBeUndefined();
  });
});

async function shutdownRuntimeDaemon(homeDir: string): Promise<void> {
  const {
    readRuntimeDaemonState,
    readRuntimeDaemonLockOwner,
    readRuntimeDaemonToken,
    resolveRuntimeDaemonPaths,
  } = await import('./runtime-daemon/state.js');
  const paths = resolveRuntimeDaemonPaths(homeDir);
  const state = readRuntimeDaemonState(paths);
  if (!state) return;
  const owner = readRuntimeDaemonLockOwner(paths.lockFile);
  if (!owner) throw new Error(`The Runtime daemon of ${homeDir} has no verifiable owner.`);
  const { waitForRuntimeDaemonShutdown } = await import('./runtime-daemon/shutdown-verifier.js');
  const { runtimeDaemonEndpointFromState } = await import('./runtime-daemon/lifecycle.js');
  const { createRuntimeDaemonSocketClientTransport } = await import('./runtime-daemon/transport.js');
  const transport = await createRuntimeDaemonSocketClientTransport(runtimeDaemonEndpointFromState(state));
  try {
    await transport.request('initialize', {
      profile: paths.profile,
      token: readRuntimeDaemonToken(paths),
    });
    await transport.request('runtime.shutdown');
  } finally {
    await transport.close?.();
  }
  // Ownership files disappear before the daemon finishes process cleanup and
  // writes its final outcome/log. Wait for that exact process tree before rm.
  const result = await waitForRuntimeDaemonShutdown({
    configHome: paths.configHome,
    owner,
  });
  expect(result.status).toBe('succeeded');
}
