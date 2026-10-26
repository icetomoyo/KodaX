import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { readProcessStartIdentity } from '@kodax-ai/agent';
import type { ClientExitReceipt } from '@kodax-ai/coding/client-contract';
import { readKodaXClientExits } from './sdk-client.js';
import { runtimeClientPrincipal } from './runtime-daemon/client-lifecycle.js';
import { resolveRuntimeDaemonPaths, tryAcquireRuntimeDaemonLock, writeRuntimeDaemonShutdownOutcome } from './runtime-daemon/state.js';

const directories: string[] = [];
const clientInfo = { name: 'Space', instanceId: 'space-recovery', instanceSecret: 'fixture-secret-for-exit-recovery-32' };
const deadPid = 2_147_483_647;

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true, maxRetries: 5 })));
});

async function fixture() {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-client-exit-recovery-'));
  directories.push(homeDir);
  const paths = resolveRuntimeDaemonPaths(homeDir);
  const receipt: ClientExitReceipt = {
    requestId: 'space-exit', clientId: runtimeClientPrincipal(clientInfo.instanceId, clientInfo.instanceSecret),
    runtimeId: `rt_${randomUUID()}`, accepted: true, requestedAt: '2026-10-26T00:00:00.000Z', updatedAt: '2026-10-26T00:00:00.000Z',
    cleanup: { state: 'unknown', runIds: ['unknown-execution'], actorTurns: [], operationIds: ['unknown-memory'],
      withdrawnInputs: [], issues: ['Client memory work remains unconfirmed.'] },
    host: { requested: true, state: 'accepted', owner: {
      runtimeId: '', pid: deadPid, kind: 'daemon', processStartIdentity: 'retired-host-generation',
      processContainment: 'windows-job', supervisorPid: deadPid - 1, supervisorProcessStartIdentity: 'retired-job-supervisor-generation',
    } },
  };
  const original = { ...receipt, host: { ...receipt.host, owner: { ...receipt.host.owner, runtimeId: receipt.runtimeId } } };
  const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
  const dir = path.join(paths.rootDir, 'client-exits', digest(original.clientId));
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${digest(original.requestId)}.json`);
  await writeFile(file, JSON.stringify(original));
  const outcome = (status: 'succeeded' | 'failed' = 'succeeded') => writeRuntimeDaemonShutdownOutcome(paths, {
    version: 1, runtimeId: original.runtimeId, pid: original.host.owner.pid, status,
    completedAt: '2026-10-26T00:01:00.000Z', ...(status === 'failed' ? { error: 'Managed resource release failed.' } : {}),
  });
  return { homeDir, paths, receipt: original, file, outcome };
}

it('converges across repeated Space restarts without promoting unknown work or rewriting the original receipt', async () => {
  const { homeDir, file, receipt, outcome } = await fixture();
  outcome();
  const original = await readFile(file, 'utf8');
  for (let restart = 0; restart < 4; restart += 1) {
    const [recovered] = await readKodaXClientExits({ homeDir, clientInfo });
    expect(recovered).toMatchObject({ cleanup: receipt.cleanup, host: { state: 'succeeded' },
      recovery: { state: 'ready', reason: 'host_shutdown_verified', nextAction: 'start_or_connect' } });
    expect(await readFile(file, 'utf8')).toBe(original);
  }
});

it('remains blocked through retries without evidence, then converges when the exact shutdown outcome arrives', async () => {
  const { homeDir, receipt, outcome } = await fixture();
  for (let restart = 0; restart < 3; restart += 1) {
    expect((await readKodaXClientExits({ homeDir, clientInfo }))[0]).toMatchObject({ cleanup: receipt.cleanup,
      recovery: { state: 'blocked', reason: 'outcome_missing', nextAction: 'retry_verification' } });
  }
  outcome();
  expect((await readKodaXClientExits({ homeDir, clientInfo }))[0]).toMatchObject({ cleanup: receipt.cleanup, recovery: { state: 'ready' } });
});

it('retains recovery proof referenced by an old unknown exit across the ordinary shutdown retention window', async () => {
  const { homeDir, paths, outcome, receipt } = await fixture();
  outcome();
  for (let restart = 0; restart < 40; restart += 1) writeRuntimeDaemonShutdownOutcome(paths, {
    version: 1, runtimeId: `replacement-${restart}`, pid: 1_000 + restart, status: 'succeeded',
    completedAt: new Date(Date.UTC(2026, 9, 26, 0, 2, restart)).toISOString(),
  });
  expect((await readKodaXClientExits({ homeDir, clientInfo }))[0]).toMatchObject({ cleanup: receipt.cleanup, recovery: { state: 'ready' } });
});

it('does not trust an outcome file whose contents identify a different Host', async () => {
  const { homeDir, paths, receipt } = await fixture();
  await writeFile(path.join(paths.rootDir, `shutdown-outcome.${encodeURIComponent(receipt.runtimeId)}.${receipt.host.owner.pid}.json`), JSON.stringify({
    version: 1, runtimeId: 'unrelated-host', pid: receipt.host.owner.pid, status: 'succeeded', completedAt: '2026-10-26T00:01:00.000Z',
  }));
  expect((await readKodaXClientExits({ homeDir, clientInfo }))[0]).toMatchObject({
    recovery: { state: 'blocked', reason: 'outcome_missing', nextAction: 'retry_verification' },
  });
});

it('keeps an actually live containment supervisor blocked despite a successful shutdown record', async () => {
  const { homeDir, file, receipt, outcome } = await fixture();
  const identity = readProcessStartIdentity(process.pid);
  expect(identity).toBeTruthy();
  await writeFile(file, JSON.stringify({ ...receipt, host: { ...receipt.host, owner: { ...receipt.host.owner,
    supervisorPid: process.pid, supervisorProcessStartIdentity: identity } } }));
  outcome();
  expect((await readKodaXClientExits({ homeDir, clientInfo }))[0]).toMatchObject({
    recovery: { state: 'blocked', reason: 'containment_active', nextAction: 'retry_verification' },
  });
});

it.each([true, false])('does not permit restart while the original Host process is alive (owns profile=%s)', async ownsProfile => {
  const { homeDir, file, receipt, paths } = await fixture();
  const identity = readProcessStartIdentity(process.pid);
  expect(identity).toBeTruthy();
  const owner = { ...receipt.host.owner, pid: process.pid, processStartIdentity: identity };
  await writeFile(file, JSON.stringify({ ...receipt, host: { ...receipt.host, owner } }));
  if (ownsProfile) expect(tryAcquireRuntimeDaemonLock(paths, { ...owner, createdAt: receipt.requestedAt })).toBeTruthy();
  expect((await readKodaXClientExits({ homeDir, clientInfo }))[0]).toMatchObject({ cleanup: receipt.cleanup,
    recovery: { state: 'blocked', reason: ownsProfile ? 'client_cleanup_unknown' : 'daemon_active',
      nextAction: ownsProfile ? 'retry_exit' : 'retry_verification' } });
});

it('keeps failed managed-resource cleanup blocked after the Host process has exited', async () => {
  const { homeDir, outcome } = await fixture();
  outcome('failed');
  expect((await readKodaXClientExits({ homeDir, clientInfo }))[0]).toMatchObject({
    recovery: { state: 'blocked', reason: 'cleanup_failed', nextAction: 'inspect_failure' },
  });
});

it('does not reuse a live Host with a resource failure merely because this client work settled', async () => {
  const { homeDir, file, receipt, paths } = await fixture();
  const owner = { ...receipt.host.owner, pid: process.pid, processStartIdentity: readProcessStartIdentity(process.pid) };
  expect(owner.processStartIdentity).toBeTruthy();
  expect(tryAcquireRuntimeDaemonLock(paths, { ...owner, createdAt: receipt.requestedAt })).toBeTruthy();
  await writeFile(file, JSON.stringify({ ...receipt, cleanup: { ...receipt.cleanup, state: 'succeeded' },
    host: { ...receipt.host, requested: false, state: 'not_requested', cleanup: 'failed', owner } }));
  expect((await readKodaXClientExits({ homeDir, clientInfo }))[0]).toMatchObject({
    recovery: { state: 'blocked', reason: 'cleanup_failed', nextAction: 'inspect_failure' },
  });
});

it('requires exact process-generation evidence even if the numeric PIDs are gone', async () => {
  const { homeDir, receipt, file, outcome } = await fixture();
  const { processStartIdentity: _identity, ...owner } = receipt.host.owner;
  await writeFile(file, JSON.stringify({ ...receipt, host: { ...receipt.host, owner } }));
  outcome();
  expect((await readKodaXClientExits({ homeDir, clientInfo }))[0]).toMatchObject({
    recovery: { state: 'blocked', reason: 'owner_identity_unverified', nextAction: 'inspect_failure' },
  });
});

it('accepts late client cleanup acknowledgement without discarding its earlier execution references', async () => {
  const { homeDir, receipt, file, outcome } = await fixture();
  outcome();
  expect((await readKodaXClientExits({ homeDir, clientInfo }))[0]?.cleanup.state).toBe('unknown');
  await writeFile(file, JSON.stringify({ ...receipt, cleanup: { ...receipt.cleanup, state: 'succeeded', issues: [] } }));
  expect((await readKodaXClientExits({ homeDir, clientInfo }))[0]).toMatchObject({
    cleanup: { state: 'succeeded', runIds: receipt.cleanup.runIds, operationIds: receipt.cleanup.operationIds }, recovery: { state: 'ready' },
  });
});
