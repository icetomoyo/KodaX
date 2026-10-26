import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { ClientExitReceipt } from '@kodax-ai/coding/client-contract';
import { createRuntimeClientLifecycleController, verifyExitReceipt } from './client-lifecycle.js';
import { resolveRuntimeDaemonPaths, tryAcquireRuntimeDaemonLock } from './state.js';
import * as shutdownVerifier from './shutdown-verifier.js';
import type { KodaXRuntime } from '../sdk-runtime.js';
import type { RuntimeDaemonManagementController } from './management.js';
import { registerClientWorkCleanup } from '../runtime-client-work.js';

async function receiptFile(homeDir: string, receipt: ClientExitReceipt): Promise<string> {
  const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
  const dir = path.join(resolveRuntimeDaemonPaths(homeDir).rootDir, 'client-exits', digest(receipt.clientId));
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${digest(receipt.requestId)}.json`);
  await writeFile(file, JSON.stringify(receipt));
  return file;
}

vi.mock('./lifecycle.js', () => ({ isRuntimeDaemonOwnerPidAlive: () => false }));
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function replacementController(homeDir: string) {
  const stop = vi.fn(async () => ({ ok: true as const }));
  const controller = createRuntimeClientLifecycleController({ paths: resolveRuntimeDaemonPaths(homeDir),
    runtime: { identity: { runtimeId: 'replacement' } } as KodaXRuntime,
    management: { stop } as unknown as RuntimeDaemonManagementController, retireClientLeases: vi.fn() });
  return { controller, stop };
}

function oldReceipt(): ClientExitReceipt {
  return { requestId: 'old-exit', clientId: 'client', runtimeId: 'old-host', accepted: true,
    requestedAt: '2026-10-26T00:00:00.000Z', updatedAt: '2026-10-26T00:00:00.000Z',
    cleanup: { state: 'unknown', runIds: ['old-run'], operationIds: [], actorTurns: [], withdrawnInputs: [],
      issues: ['Client memory work remains unconfirmed.'] },
    host: { requested: true, state: 'accepted', owner: { runtimeId: 'old-host', pid: 42, processStartIdentity: 'old-generation' } } };
}

function verifiedShutdown(): void {
  vi.spyOn(shutdownVerifier, 'waitForRuntimeDaemonShutdown').mockResolvedValue({ status: 'succeeded', outcome: {
    version: 1, runtimeId: 'old-host', pid: 42, status: 'succeeded', completedAt: '2026-10-26T00:01:00.000Z',
  } });
}

it('does not keep a safely recovered historical exit in the pending admission list', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-exit-pending-'));
  try {
    await receiptFile(homeDir, oldReceipt());
    verifiedShutdown();
    const { controller } = replacementController(homeDir);
    expect(await controller.pending('client')).toEqual([]);
    expect(await controller.read('client', 'old-exit')).toMatchObject({ cleanup: { state: 'unknown' }, recovery: { state: 'ready' } });
  } finally { await rm(homeDir, { recursive: true, force: true }); }
});

it('rechecks a replayed old exit without rewriting history or stopping the replacement Host', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-exit-replay-'));
  try {
    const receipt = oldReceipt();
    const file = await receiptFile(homeDir, receipt);
    const original = await readFile(file, 'utf8');
    verifiedShutdown();
    const { controller, stop } = replacementController(homeDir);
    vi.useFakeTimers();
    const replayed = await controller.request('client', { requestId: receipt.requestId, shutdownHost: true });
    await vi.runOnlyPendingTimersAsync();
    expect(stop).not.toHaveBeenCalled();
    expect(await readFile(file, 'utf8')).toBe(original);
    expect(replayed).toMatchObject({ cleanup: receipt.cleanup, recovery: { state: 'ready' } });
    expect(await controller.admit('client', async () => 'replacement work')).toBe('replacement work');
  } finally { await rm(homeDir, { recursive: true, force: true }); }
});

it('retains a Host cleanup acknowledgement that arrives while the exit stop request is settling', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-exit-late-host-ack-'));
  try {
    const receipt = oldReceipt();
    const file = await receiptFile(homeDir, receipt);
    const paths = resolveRuntimeDaemonPaths(homeDir);
    expect(tryAcquireRuntimeDaemonLock(paths, { ...receipt.host.owner, createdAt: receipt.requestedAt })).toBeTruthy();
    const runtime = { identity: { runtimeId: receipt.runtimeId } } as KodaXRuntime;
    registerClientWorkCleanup(runtime, async () => ({ ...receipt.cleanup, state: 'succeeded', issues: [] }));
    const controller = createRuntimeClientLifecycleController({ runtime, paths, retireClientLeases: vi.fn(),
      management: { stop: async () => { controller.hostCleanup('succeeded'); return { ok: true }; } } as RuntimeDaemonManagementController });
    vi.useFakeTimers();
    await controller.request(receipt.clientId, { requestId: receipt.requestId, shutdownHost: true });
    await vi.runOnlyPendingTimersAsync();
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({
      cleanup: { state: 'succeeded' }, host: { cleanup: 'succeeded' },
    });
  } finally { await rm(homeDir, { recursive: true, force: true }); }
});

it('allows a verified old Host to be replaced while preserving unknown client memory work', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-exit-convergence-'));
  try {
    const receipt: ClientExitReceipt = { requestId: 'quit', clientId: 'client', runtimeId: 'old-host', accepted: true,
      requestedAt: '2026-10-26T00:00:00.000Z', updatedAt: '2026-10-26T00:00:00.000Z',
      cleanup: { state: 'unknown', runIds: ['unknown-run'], operationIds: [], actorTurns: [], withdrawnInputs: [],
        issues: ['Client memory work remains unconfirmed.'] },
      host: { requested: true, state: 'accepted', owner: { runtimeId: 'old-host', pid: 42, kind: 'daemon',
        processStartIdentity: 'old-generation', processContainment: 'windows-job', supervisorPid: 43,
        supervisorProcessStartIdentity: 'old-supervisor-generation' } } };
    vi.spyOn(shutdownVerifier, 'waitForRuntimeDaemonShutdown').mockResolvedValue({ status: 'succeeded', outcome: {
      version: 1, runtimeId: 'old-host', pid: 42, status: 'succeeded', completedAt: '2026-10-26T00:01:00.000Z',
    } });
    const recovered = await verifyExitReceipt(resolveRuntimeDaemonPaths(homeDir), receipt);
    expect(recovered).toMatchObject({ cleanup: receipt.cleanup, host: { state: 'succeeded' },
      recovery: { state: 'ready', reason: 'host_shutdown_verified', nextAction: 'start_or_connect' } });
    expect(receipt.host.state).toBe('accepted');
    expect(receipt.cleanup.state).toBe('unknown');
  } finally { await rm(homeDir, { recursive: true, force: true }); }
});

it('uses a late durable cleanup result even when its timestamp matches the original snapshot', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-exit-late-cleanup-'));
  try {
    const receipt: ClientExitReceipt = { requestId: 'late', clientId: 'client', runtimeId: 'old-host', accepted: true,
      requestedAt: '2026-10-26T00:00:00.000Z', updatedAt: '2026-10-26T00:00:00.000Z',
      cleanup: { state: 'unknown', runIds: ['retained'], operationIds: [], actorTurns: [], withdrawnInputs: [], issues: ['Unconfirmed.'] },
      host: { requested: true, state: 'accepted', owner: { runtimeId: 'old-host', pid: 42,
        processStartIdentity: 'old-generation' } } };
    const file = await receiptFile(homeDir, receipt);
    vi.spyOn(shutdownVerifier, 'waitForRuntimeDaemonShutdown').mockImplementation(async () => {
      await writeFile(file, JSON.stringify({ ...receipt, cleanup: { ...receipt.cleanup, state: 'succeeded', issues: [] } }));
      return { status: 'succeeded', outcome: { version: 1, runtimeId: 'old-host', pid: 42,
        status: 'succeeded', completedAt: '2026-10-26T00:01:00.000Z' } };
    });
    const recovered = await verifyExitReceipt(resolveRuntimeDaemonPaths(homeDir), receipt);
    expect(recovered).toMatchObject({ cleanup: { state: 'succeeded', runIds: ['retained'] }, recovery: { state: 'ready' } });
    expect(JSON.parse(await readFile(file, 'utf8'))).not.toHaveProperty('recovery');
  } finally { await rm(homeDir, { recursive: true, force: true }); }
});

it('does not apply verified evidence to a different process generation written during the probe', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-exit-generation-'));
  try {
    const receipt: ClientExitReceipt = { requestId: 'same-request', clientId: 'client', runtimeId: 'old-host', accepted: true,
      requestedAt: '2026-10-26T00:00:00.000Z', updatedAt: '2026-10-26T00:00:00.000Z',
      cleanup: { state: 'unknown', runIds: [], operationIds: [], actorTurns: [], withdrawnInputs: [], issues: [] },
      host: { requested: true, state: 'accepted', owner: { runtimeId: 'old-host', pid: 42, processStartIdentity: 'old-generation' } } };
    const file = await receiptFile(homeDir, receipt);
    vi.spyOn(shutdownVerifier, 'waitForRuntimeDaemonShutdown').mockImplementation(async () => {
      await writeFile(file, JSON.stringify({ ...receipt, host: { ...receipt.host,
        owner: { ...receipt.host.owner, processStartIdentity: 'replacement-generation' } } }));
      return { status: 'succeeded', outcome: { version: 1, runtimeId: 'old-host', pid: 42,
        status: 'succeeded', completedAt: '2026-10-26T00:01:00.000Z' } };
    });
    expect(await verifyExitReceipt(resolveRuntimeDaemonPaths(homeDir), receipt)).toMatchObject({
      cleanup: { state: 'unknown' }, recovery: { state: 'blocked', reason: 'owner_identity_mismatch', nextAction: 'inspect_failure' },
    });
  } finally { await rm(homeDir, { recursive: true, force: true }); }
});

it('keeps a late Host resource-cleanup failure blocked instead of hiding it with earlier shutdown evidence', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-exit-late-failure-'));
  try {
    const receipt = oldReceipt();
    const file = await receiptFile(homeDir, receipt);
    vi.spyOn(shutdownVerifier, 'waitForRuntimeDaemonShutdown').mockImplementation(async () => {
      await writeFile(file, JSON.stringify({ ...receipt, host: { ...receipt.host,
        cleanup: 'failed', message: 'Managed resource release remains unverified.' } }));
      return { status: 'succeeded', outcome: { version: 1, runtimeId: 'old-host', pid: 42,
        status: 'succeeded', completedAt: '2026-10-26T00:01:00.000Z' } };
    });
    expect(await verifyExitReceipt(resolveRuntimeDaemonPaths(homeDir), receipt)).toMatchObject({
      host: { cleanup: 'failed' }, recovery: { state: 'blocked', reason: 'cleanup_failed', nextAction: 'inspect_failure' },
    });
  } finally { await rm(homeDir, { recursive: true, force: true }); }
});

it.each([true, false])('recovers an unconfirmed client cleanup after owner loss (shutdownHost=%s)', async requested => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-exit-recovery-'));
  try {
    const receipt: ClientExitReceipt = { requestId: 'crash', clientId: 'client', runtimeId: 'lost-host', accepted: true,
      requestedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      cleanup: { state: 'pending', runIds: ['unfinished'], operationIds: [], actorTurns: [], withdrawnInputs: [], issues: [] },
      host: { requested, state: requested ? 'pending' : 'not_requested', owner: { runtimeId: 'lost-host', pid: 42, kind: 'daemon' } } };
    await receiptFile(homeDir, receipt);
    const recovered = await verifyExitReceipt(resolveRuntimeDaemonPaths(homeDir), receipt);
    expect(recovered.cleanup).toMatchObject({ state: 'unknown', runIds: ['unfinished'] });
    expect(recovered.cleanup.issues).toHaveLength(1);
    expect(recovered.host.state).toBe(requested ? 'unknown' : 'not_requested');
    expect(recovered.host.cleanup).toBeUndefined();
    expect(receipt.cleanup.state).toBe('pending');
  } finally { await rm(homeDir, { recursive: true, force: true }); }
});
