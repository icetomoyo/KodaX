import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  KodaXBaseProvider, clearRuntimeModelProviders, registerModelProvider,
  type KodaXProviderConfig, type KodaXStreamResult,
} from '@kodax-ai/llm';
import { connectKodaXClient } from '@kodax-ai/kodax/client';
import { createKodaXRuntime } from './sdk-runtime.js';
import { startRuntimeDaemonHost } from './runtime-daemon/host.js';
import { resolveRuntimeDaemonPaths, tryAcquireRuntimeDaemonLock } from './runtime-daemon/state.js';

class CatalogProvider extends KodaXBaseProvider {
  readonly name = 'product-catalog-test';
  readonly supportsThinking = false;
  protected readonly config: KodaXProviderConfig = {
    apiKeyEnv: 'KODAX_PRODUCT_CATALOG_TEST_KEY', model: 'catalog-test', supportsThinking: false,
  };
  async stream(): Promise<KodaXStreamResult> {
    return { textBlocks: [{ type: 'text', text: 'ok' }], thinkingBlocks: [], toolBlocks: [], stopReason: 'end_turn' };
  }
}

let homeDir: string;
let runtime: Awaited<ReturnType<typeof createKodaXRuntime>>;
let host: Awaited<ReturnType<typeof startRuntimeDaemonHost>>;
let first: Awaited<ReturnType<typeof connectKodaXClient>>;
let second: Awaited<ReturnType<typeof connectKodaXClient>>;

beforeEach(async () => {
  homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-product-catalog-'));
  registerModelProvider('product-catalog-test', () => new CatalogProvider());
  vi.stubEnv('KODAX_PRODUCT_CATALOG_TEST_KEY', 'test-only');
  runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true, defaultProvider: 'product-catalog-test' });
  const paths = resolveRuntimeDaemonPaths(homeDir);
  const lock = tryAcquireRuntimeDaemonLock(paths, {
    runtimeId: runtime.identity.runtimeId, pid: process.pid, createdAt: runtime.identity.startedAt,
  });
  if (!lock) throw new Error('Could not acquire the catalog Host.');
  const endpointPath = process.platform === 'win32'
    ? '\\\\.\\pipe\\kodax-catalog-' + randomUUID()
    : path.join(homeDir, 'host.sock');
  const endpoint = process.platform === 'win32'
    ? { kind: 'pipe' as const, path: endpointPath }
    : { kind: 'unix' as const, path: endpointPath };
  host = await startRuntimeDaemonHost({ runtime, paths, lock, endpoint });
  first = await connectKodaXClient({ homeDir, endpoint: endpointPath });
  second = await connectKodaXClient({ homeDir, endpoint: endpointPath });
});

afterEach(async () => {
  await Promise.allSettled([first?.disconnect(), second?.disconnect()]);
  await host?.close();
  await runtime.close();
  clearRuntimeModelProviders();
  vi.unstubAllEnvs();
  await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}, 30_000);

it('lists real Host skills, commands, and effective config through typed queries', async () => {
  // Skills come from the Host's real registry: built-in Skills ship with the
  // product, so both clients see the same non-empty typed inventory.
  const skills = await first.catalog.skills();
  expect(skills.length).toBeGreaterThan(0);
  // The registry resolves from real installed locations (user overrides may
  // shadow the built-in), so the typed shape is pinned, not the origin.
  const review = skills.find((skill) => skill.name === 'code-review');
  expect(review).toBeDefined();
  expect(review!.source.length).toBeGreaterThan(0);
  expect(typeof review!.description).toBe('string');
  expect(review!.description.length).toBeGreaterThan(0);
  expect(review!.path.length).toBeGreaterThan(0);
  expect((await second.catalog.skills()).map((skill) => skill.name))
    .toEqual(skills.map((skill) => skill.name));
  const userInvocable = await first.catalog.skills({ userInvocableOnly: true });
  const invocableNames = new Set(userInvocable.map((skill) => skill.name));
  for (const name of invocableNames) {
    expect(skills.some((skill) => skill.name === name)).toBe(true);
  }

  // Commands come from the Host's real command registry for the workspace.
  const commands = await first.catalog.commands(homeDir);
  expect(commands.length).toBeGreaterThan(0);
  for (const command of commands) {
    expect(typeof command.name).toBe('string');
    expect(typeof command.description).toBe('string');
    expect(typeof command.source).toBe('string');
  }

  // Config-effective: a saved default is readable by both clients and a real
  // reload confirms the same effective state.
  const config = await first.config.read();
  const reloaded = await second.config.reload();
  expect(reloaded).toMatchObject({ ok: true });
  expect(reloaded.config).toEqual(config);

  // A patch through one client must reach the other client after reload:
  // the saved-defaults file is Host-owned state, not per-connection cache.
  const desiredVerifierLog = !(config.verifierLog ?? false);
  const patched = await first.config.patch({ verifierLog: desiredVerifierLog });
  expect(patched.verifierLog).toBe(desiredVerifierLog);
  const observed = await second.config.reload();
  expect(observed).toMatchObject({ ok: true });
  expect(observed.config.verifierLog).toBe(desiredVerifierLog);
  expect((await second.config.read()).verifierLog).toBe(desiredVerifierLog);
}, 60_000);
