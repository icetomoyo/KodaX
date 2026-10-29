import { describe, expect, it, vi } from 'vitest';
import { createKodaXRuntime, type KodaXRuntime } from './sdk-runtime.js';
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

  it('does not turn Product Host shutdown into private Runtime disposal', async () => {
    const close = vi.fn(async () => {});
    const client = toKodaXProductClient({ close } as unknown as KodaXRuntime);
    await expect(client.host.shutdown()).rejects.toThrow(/shared Host/);
    expect(close).not.toHaveBeenCalled();
  });
});
