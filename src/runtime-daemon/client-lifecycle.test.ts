import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { ClientExitReceipt } from '@kodax-ai/coding/client-contract';
import { verifyExitReceipt } from './client-lifecycle.js';
import { resolveRuntimeDaemonPaths } from './state.js';

vi.mock('./lifecycle.js', () => ({ isRuntimeDaemonPidAlive: () => false }));
afterEach(() => vi.restoreAllMocks());

it.each([true, false])('recovers an unconfirmed client cleanup after owner loss (shutdownHost=%s)', async requested => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-exit-recovery-'));
  try {
    const receipt: ClientExitReceipt = { requestId: 'crash', clientId: 'client', runtimeId: 'lost-host', accepted: true,
      requestedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      cleanup: { state: 'pending', runIds: ['unfinished'], operationIds: [], actorTurns: [], withdrawnInputs: [], issues: [] },
      host: { requested, state: requested ? 'pending' : 'not_requested', owner: { runtimeId: 'lost-host', pid: 42, kind: 'daemon' } } };
    const recovered = await verifyExitReceipt(resolveRuntimeDaemonPaths(homeDir), receipt);
    expect(recovered.cleanup).toMatchObject({ state: 'unknown', runIds: ['unfinished'] });
    expect(recovered.cleanup.issues).toHaveLength(1);
    expect(recovered.host.state).toBe(requested ? 'unknown' : 'not_requested');
    expect(recovered.host.cleanup).toBeUndefined();
    expect(receipt.cleanup.state).toBe('pending');
  } finally { await rm(homeDir, { recursive: true, force: true }); }
});
