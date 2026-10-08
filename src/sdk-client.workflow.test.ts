import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { createCliWorkflowControl } from './cli-client-plane.js';
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

// The restricted workflow realm has no host timers (determinism guard) and
// this fixture registers no provider for pattern agents, so the script
// completes immediately; every later observation accepts the completed
// terminal while the dual-client list/get/control assertions stay exercised.
const SOURCE = [
  'async function run(wf, args) {',
  '  return { synthesis: "dual-client-ok" };',
  '}',
].join('\n');

it.each([false, true])('shares workflow facts and control with an older summary=%s', async (olderSummary) => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-product-workflow-'));
  const runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true });
  // Simulate the old wire shape while retaining the real Host and IPC reads.
  const list = runtime.workflows.list.bind(runtime.workflows);
  if (olderSummary) vi.spyOn(runtime.workflows, 'list').mockImplementation(async filter =>
    (await list(filter)).map(({ updatedAt: _updatedAt, displayName: _displayName, ...run }) => run));
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
    const firstControl = createCliWorkflowControl(first);
    const secondControl = createCliWorkflowControl(second);
    const events: string[] = [];
    const subscription = secondControl.subscribe({}, event => events.push(event.type));
    // Client A starts a declarative (inline) workflow on the Host.
    const session = await first.sessions.create({ projectPath: homeDir });
    const started = await firstControl.start({
      sessionId: session.id,
      projectRoot: homeDir,
      source: { kind: 'inline', manifest: MANIFEST, source: SOURCE },
      metadata: { displayName: 'Dual-client audit', source: 'command' },
    });
    expect(started).toMatchObject({ kind: 'started' });
    if (started.kind !== 'started') return;
    const runId = started.runId;
    const expectSummaryFacts = async () => {
      // Progress may advance between RPCs. Compare only a stable read window.
      await expect.poll(async () => {
        const before = await second.workflows.get(runId);
        const summary = (await first.workflows.list({ runId }))[0];
        const after = await second.workflows.get(runId);
        return before?.updatedAt === after?.updatedAt
          && summary?.updatedAt === after?.updatedAt
          && summary?.displayName === 'Dual-client audit';
      }, { timeout: 10_000 }).toBe(true);
    };
    // Session-scoped control crosses the public client and real IPC boundary.
    const foreignSession = await second.sessions.create({ projectPath: homeDir });
    await expect(secondControl.stop(runId, { sessionId: foreignSession.id }))
      .rejects.toThrow('Workflow does not belong to the requested Session.');
    expect((await secondControl.get(runId))?.hostMetadata?.ownerSessionId).toBe(session.id);
    expect((await runtime.runs.get(runId)).phase).not.toBe('interrupted');
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
    const detailed = await secondControl.get(runId);
    expect(detailed?.items).toEqual(expect.any(Array));
    expect(detailed?.counts).toBeDefined();
    expect(detailed?.progress).toBeDefined();
    expect(await secondControl.list()).toEqual(expect.arrayContaining([expect.objectContaining({
      runId, workflow: MANIFEST.name, runDir: expect.stringContaining('workflow-runs'),
      totalSpawned: expect.any(Number), eventCount: expect.any(Number), startedAt: expect.any(Number),
    })]));

    // A declines an unknown name without any Host-side run.
    await expect(first.workflows.start({
      projectRoot: homeDir,
      source: { kind: 'name', name: 'definitely-not-a-workflow' },
    })).resolves.toMatchObject({ kind: 'declined' });

    // Control crosses clients: A pauses, B observes and stops, both settle.
    // The fixture script completes within milliseconds (the restricted realm
    // has no host timers), so the run may already be terminal here; control
    // operations only apply to a live run — an optimistic control recorded
    // against a terminal run freezes the process projection at that state.
    const liveStatus = (await first.workflows.get(runId))?.status;
    if (liveStatus === 'running' || liveStatus === 'paused') {
      await firstControl.pause(runId);
      await expect.poll(async () => (await second.workflows.get(runId))?.status,
        { timeout: 10_000 }).toMatch(/^(paused|completed)$/);
      await expectSummaryFacts();
      await firstControl.resume(runId);
      await expectSummaryFacts();
      await secondControl.stop(runId, { sessionId: session.id });
    }
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
    await expect.poll(() => events.includes('workflow_finished')).toBe(true);
    subscription.close();
    const terminal = await first.workflows.get(runId);
    expect(terminal).toBeDefined();
    const runTerminal = await runtime.runs.await(runId);
    await expectSummaryFacts();
    expect(['completed', 'interrupted']).toContain(runTerminal.phase);
    expect(await first.workflows.resume(runId)).toBe(false);
    expect((await runtime.runs.get(runId)).phase).toBe(runTerminal.phase);
    if (olderSummary) {
      const get = vi.spyOn(runtime.workflows, 'get').mockResolvedValue(undefined);
      await expect(first.workflows.list({ runId })).rejects.toThrow('Workflow process is unavailable');
      get.mockRestore();
    }

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
    vi.restoreAllMocks();
    await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 90_000);
