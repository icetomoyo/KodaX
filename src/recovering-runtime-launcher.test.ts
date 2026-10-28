import { expect, it, vi } from 'vitest';
import type { KodaXRuntime, RuntimeConnectionState } from './sdk-runtime.js';
import { ensureKodaXRuntime } from './sdk-runtime.js';
import { ensureRecoveringKodaXRuntime } from './recovering-runtime-client.js';
import { ensureKodaXClient, type EnsureKodaXClientOptions } from './sdk-client.js';

vi.mock('./sdk-runtime.js', () => ({ ensureKodaXRuntime: vi.fn() }));

it.each([0, 300_000])('forwards the Product launcher ordinary-question deadline (%s) to a new Host', async userInputTimeoutMs => {
  const host = { close: async () => {} } as unknown as Awaited<ReturnType<typeof ensureKodaXRuntime>>;
  vi.mocked(ensureKodaXRuntime).mockReset().mockResolvedValue(host);
  const options: EnsureKodaXClientOptions = { userInputTimeoutMs };
  const client = await ensureKodaXClient(options);
  try {
    expect(ensureKodaXRuntime).toHaveBeenCalledWith(expect.objectContaining({ userInputTimeoutMs }));
  } finally { await client.disconnect(); }
});

it.each([false, true])('keeps the authenticated identity across Host connections (supplied=%s)', async supplied => {
  let disconnect!: (state: RuntimeConnectionState) => void;
  const host = { identity: { runtimeId: 'host' }, close: async () => {},
    connection: { current: () => ({ state: 'connected' }), subscribe: (listener: typeof disconnect) => { disconnect = listener; return { close() {} }; } },
  } as unknown as Awaited<ReturnType<typeof ensureKodaXRuntime>>;
  vi.mocked(ensureKodaXRuntime).mockReset().mockResolvedValue(host);
  const identity = { name: 'test', instanceId: 'stable-client', instanceSecret: 'fixture-only-secret-'.repeat(3) };
  const controller = new AbortController();
  const runtime: KodaXRuntime = await ensureRecoveringKodaXRuntime(supplied ? { clientInfo: identity, daemonStartupSignal: controller.signal } : {});
  try {
    disconnect({ state: 'disconnected', connectionId: 'old', runtimeEpoch: 'old', code: 'protocol_closed', reconnectable: true });
    await vi.waitFor(() => expect(ensureKodaXRuntime).toHaveBeenCalledTimes(2));
    const [initial, replacement] = vi.mocked(ensureKodaXRuntime).mock.calls.map(call => call[0]!);
    expect(replacement!.clientInfo).toEqual(initial!.clientInfo);
    expect(initial!.clientInfo!.instanceSecret!.length).toBeGreaterThanOrEqual(32);
    if (supplied) expect(initial!.clientInfo).toEqual(identity);
    const other = await ensureRecoveringKodaXRuntime();
    try { expect(vi.mocked(ensureKodaXRuntime).mock.calls[2]![0]!.clientInfo!.instanceId).not.toBe(initial!.clientInfo!.instanceId); }
    finally { await other.close(); }
  } finally { await runtime.close(); }
});
