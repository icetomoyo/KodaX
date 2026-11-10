import { describe, expect, it, vi } from 'vitest';
import { connectKodaXRuntime, createKodaXRuntime, ensureKodaXRuntime, getKodaXRuntimeOwnerState, waitForRuntimeDaemonShutdown, type KodaXRuntime } from './sdk-runtime.js';
import { connectKodaXClient, ensureKodaXClient, readKodaXClientExits } from './sdk-client.js';
import { toKodaXProductClient } from './client-runtime-adapter.js';

describe('public Runtime construction boundary', () => {
  it.each([
    ['default ownership', {}],
    ['embedded ownership', { mode: 'embedded' }],
    ['internal Host switch', { mode: 'daemon', sharedDaemonHost: false }],
    ['internal owner identity', { mode: 'daemon', daemonHostRuntimeId: 'rt_123456789abc' }],
    ['function-based executor injection', { mode: 'daemon', externalAgents: { factories: [] } }],
  ])('rejects %s before consulting startup inputs', async (_name, retired) => {
    const options = Object.defineProperty({ ...retired }, 'homeDir', {
      get() { throw new Error('Startup inputs must not be consulted for a retired constructor.'); },
    });
    // JavaScript callers can still send retired fields after declarations remove them.
    const construct = createKodaXRuntime as (input: unknown) => Promise<unknown>;
    await expect(construct(options)).rejects.toMatchObject({
      code: 'runtime_host_migration_required',
      name: 'RuntimeHostMigrationRequiredError',
    });
  });

  it('removes the Host-location profile from public SDK types (FEATURE_305)', () => {
    const typeOnly = () => {
      // @ts-expect-error One Host serves each KODAX_HOME.
      void ensureKodaXRuntime({ profile: 'coder' });
      // @ts-expect-error One Host serves each KODAX_HOME.
      void connectKodaXRuntime({ profile: 'coder' });
      // @ts-expect-error One Host serves each KODAX_HOME.
      void createKodaXRuntime({ mode: 'daemon', profile: 'coder' });
      // @ts-expect-error One Host serves each KODAX_HOME.
      void getKodaXRuntimeOwnerState({ profile: 'coder' });
      // @ts-expect-error One Host serves each KODAX_HOME.
      void connectKodaXClient({ profile: 'coder' });
      // @ts-expect-error One Host serves each KODAX_HOME.
      void ensureKodaXClient({ profile: 'coder' });
      // @ts-expect-error One Host serves each KODAX_HOME.
      void readKodaXClientExits({ profile: 'coder', clientInfo: { name: 'x' } });
      // @ts-expect-error One Host serves each KODAX_HOME.
      void waitForRuntimeDaemonShutdown({ profile: 'coder', configHome: 'x', owner: { runtimeId: 'rt', pid: 1 } });
    };
    expect(typeof typeOnly).toBe('function');
  });

  it.each<readonly [string, (input: object) => Promise<unknown>]>([
    ['ensureKodaXRuntime', (input: object) => ensureKodaXRuntime(input)],
    ['connectKodaXRuntime', (input: object) => connectKodaXRuntime(input)],
    ['createKodaXRuntime', (input: object) => createKodaXRuntime(Object.assign(input, { mode: 'daemon' as const }))],
    ['getKodaXRuntimeOwnerState', async (input: object) => getKodaXRuntimeOwnerState(input)],
    ['connectKodaXClient', (input: object) => connectKodaXClient(input)],
    ['ensureKodaXClient', (input: object) => ensureKodaXClient(input)],
    ['readKodaXClientExits', (input: object) => readKodaXClientExits(Object.assign(input, { clientInfo: { name: 'x' } }))],
    ['waitForRuntimeDaemonShutdown', (input: object) => waitForRuntimeDaemonShutdown(Object.assign(input, { configHome: 'x', owner: { runtimeId: 'rt', pid: 1 } }))],
  ])('%s rejects a JavaScript profile with migration guidance before startup', async (name, call) => {
    const options = Object.defineProperty({ profile: 'coder' }, 'homeDir', {
      enumerable: true,
      get() { throw new Error('Startup inputs must not be consulted when profile is passed.'); },
    });
    const error = await Promise.resolve().then(() => call(options)).then(() => undefined, (reason: unknown) => reason);
    expect(error).toMatchObject({ code: 'runtime_host_migration_required', name: 'RuntimeHostMigrationRequiredError' });
    const { message } = error as Error;
    expect(message).toContain(name);
    expect(message).toContain('"profile"');
    expect(message).toMatch(/homeDir or KODAX_HOME/);
    expect(message).toContain('docs/SDK_MIGRATION.md');
  });

  it('does not turn Product Host shutdown into private Runtime disposal', async () => {
    const close = vi.fn(async () => {});
    const client = toKodaXProductClient({ close } as unknown as KodaXRuntime);
    await expect(client.host.shutdown()).rejects.toThrow(/shared Host/);
    expect(close).not.toHaveBeenCalled();
  });
});
