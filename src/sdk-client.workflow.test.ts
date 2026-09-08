import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { connectKodaXClient } from '@kodax-ai/kodax/client';
import { createKodaXRuntime } from './sdk-runtime.js';
import { startRuntimeDaemonHost } from './runtime-daemon/host.js';
import { resolveRuntimeDaemonPaths, tryAcquireRuntimeDaemonLock } from './runtime-daemon/state.js';

const MANIFEST = {
  name: 'dual-client-wf',
  description: 'T22 S1 dual-client visibility workflow',
  phases: ['investigate'],
  readOnly: true,
  maxAgents: 2,
  maxConcurrency: 1,
  patterns: ['fan-out-and-synthesize'],
};

const SOURCE = [
  'async function run(wf, args) {',
  '  await new Promise((resolve) => setTimeout(resolve, 4000));',
  '  return { synthesis: "dual-client-ok" };',
  '}',
].join('\n');

it('runs one workflow on the Host that both clients observe and control', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-product-workflow-'));
  const runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true });
  const paths = resolveRuntimeDaemonPaths(homeDir);
  const lock = tryAcquireRuntimeDaemonLock(paths, {
    runtimeId: runtime.identity.runtimeId, pid: process.pid, createdAt: runtime.identity.startedAt,
  });
  if (!lock) throw new Error('Could not acquire the workflow Host.');
  const endpointPath = process.platform === 'win32'
    ? `\\\\.\\pipe\\kodax-workflow-${randomUUID()}`
    : path.join(homeDir, 'host.sock');
  const endpoint = process.platform === 'win32'
    ? { kind: 'pipe' as const, path: endpointPath }
    : { kind: 'unix' as const, path: endpointPath };
  const host = await startRuntimeDaemonHost({ runtime, paths, lock, endpoint });
  const first = await connectKodaXClient({ homeDir, endpoint: endpointPath });
  const second = await connectKodaXClient({ homeDir, endpoint: endpointPath });
  try {
    // Client A starts a declarative (inline) workflow on the Host.
    const session = await first.sessions.create({ projectPath: homeDir });
    const started = await first.workflows.start({
      sessionId: session.id,
      projectRoot: homeDir,
      source: { kind: 'inline', manifest: MANIFEST, source: SOURCE },
      metadata: { displayName: 'Dual-client audit', source: 'command' },
    });
    expect(started).toMatchObject({ kind: 'started' });
    if (started.kind !== 'started') return;
    const runId = started.runId;
    expect(await runtime.workflows.list({ runId })).toEqual([
      expect.objectContaining({ runId, runDir: expect.stringContaining(path.join('workflow-runs')) }),
    ]);

    // Client B sees the same work through its own connection.
    await expect.poll(async () =>
      (await second.workflows.list()).some((run) => run.runId === runId), { timeout: 10_000 },
    ).toBe(true);
    const seen = (await second.workflows.list()).find((run) => run.runId === runId);
    expect(seen?.workflowName).toBe('dual-client-wf');
    expect(seen?.status === 'running' || seen?.status === 'completed').toBe(true);

    // FEATURE_298 T22 — the declarative start's lineage metadata is attached
    // verbatim to the Host-minted run.
    const seenDetail = await second.workflows.get(runId);
    expect(seenDetail?.displayName).toBe('Dual-client audit');

    // A declines an unknown name without any Host-side run.
    await expect(first.workflows.start({
      projectRoot: homeDir,
      source: { kind: 'name', name: 'definitely-not-a-workflow' },
    })).resolves.toMatchObject({ kind: 'declined' });

    // Control crosses clients: A pauses, B observes and stops, both settle.
    await first.workflows.pause(runId);
    const paused = await second.workflows.get(runId);
    expect(['paused', 'pausing', 'completed']).toContain(paused?.status ?? 'completed');
    await second.workflows.stop(runId);
    // workflows.get projects the WorkflowProcess snapshot; a Host stop settles
    // the process as 'cancelled' (run.status is 'stopped', but that never
    // reaches this view — the process statuses are the contract here).
    await expect.poll(async () => {
      const settled = await first.workflows.get(runId);
      return settled !== undefined
        && (settled.status === 'completed'
          || settled.status === 'cancelled'
          || settled.status === 'failed');
    }, { timeout: 20_000 }).toBe(true);
    const terminal = await first.workflows.get(runId);
    expect(terminal).toBeDefined();
    const runTerminal = await runtime.runs.await(runId);
    expect(['completed', 'interrupted']).toContain(runTerminal.phase);
    expect(await first.workflows.resume(runId)).toBe(false);
    expect((await runtime.runs.get(runId)).phase).toBe(runTerminal.phase);

    // Validation settles the admitted Run even when no Workflow manager starts.
    await expect(first.workflows.start({
      projectRoot: homeDir,
      provider: 'unavailable-workflow-fixture-provider',
      source: { kind: 'inline', manifest: MANIFEST, source: 'not valid JavaScript !!!' },
    })).rejects.toThrow();
  } finally {
    await first.disconnect();
    await second.disconnect();
    await host.close();
    await runtime.close();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 90_000);
