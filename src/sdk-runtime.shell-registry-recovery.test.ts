import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';

const processTree = vi.hoisted(() => ({ killPid: vi.fn() }));
vi.mock('../packages/agent/src/runtime/process-tree.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../packages/agent/src/runtime/process-tree.js')>(),
  captureWindowsProcessTree: () => undefined,
  killPidTree: processTree.killPid,
}));

import { cleanupRegisteredManagedChildren } from '@kodax-ai/agent';
import { setAgentConfigHome } from '../packages/agent/src/runtime/agent-home.js';
import { createKodaXRuntime } from './sdk-runtime.js';

it('recovers a swept Shell witness through the SDK before admitting a successor Run', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kodax-shell-registry-recovery-'));
  const configHome = path.join(root, '.kodax');
  vi.stubEnv('KODAX_HOME', configHome);
  setAgentConfigHome(configHome);
  const options = { homeDir: root, sessionsDir: path.join(root, 'sessions'), sharedDaemonHost: true,
    defaultProvider: 'unconfigured-provider' };
  const source = path.join(root, 'fixture.txt');
  await writeFile(source, 'Shell recovery fixture');
  const runtime = await createKodaXRuntime(options);
  let recovered: Awaited<ReturnType<typeof createKodaXRuntime>> | undefined;
  try {
    const session = await runtime.sessions.create({ projectPath: root });
    await runtime.sessions.updateSettings(session.id, { permissionMode: 'full-access' });
    const runInput = { sessionId: session.id, prompt: 'Read the fixture', options: {
      lsp: false, toolInvocation: { name: 'read', input: { path: source } },
    } };
    const run = await runtime.runs.start(runInput);
    await expect(run.result).resolves.toMatchObject({ phase: 'completed' });
    await runtime.close();

    const statusFile = path.join(configHome, 'runtime', 'profiles', 'default', 'runs', run.runId, 'status.json');
    const status = JSON.parse(await readFile(statusFile, 'utf8')) as Record<string, unknown>;
    const reference = { runtimeRunId: run.runId, pid: 2147483646, registrationId: randomUUID() };
    status.phase = 'unknown';
    status.stage = 'unknown';
    delete status.terminal;
    delete status.endedAt;
    status.stop = { requestedAt: new Date().toISOString(), state: 'unknown', outcome: 'unknown', reason: 'stop' };
    (status._runtime as Record<string, unknown>).shellCleanups = [reference];
    await writeFile(statusFile, JSON.stringify(status));

    const registryDirectory = path.join(configHome, 'runtime', 'processes', 'children');
    const registryFile = path.join(registryDirectory, `${reference.pid}.${reference.registrationId}.json`);
    await mkdir(registryDirectory, { recursive: true });
    await writeFile(registryFile, JSON.stringify({
      ...reference, version: 4, ownerPid: 2147483647, registeredAtMs: 100,
      kind: 'bash', command: 'previous-owner-shell', runCleanupRequired: true,
      processStartIdentity: '111', processTreeIdentities: [{ pid: reference.pid, creationTime: '111' }],
      processTreeComplete: true,
    }));
    processTree.killPid.mockResolvedValue({ status: 'terminated' });
    expect(await cleanupRegisteredManagedChildren()).toMatchObject({ killed: 1, skipped: 0 });
    expect(JSON.parse(await readFile(registryFile, 'utf8'))).toMatchObject({ ...reference, cleanupVerified: true });
    expect(JSON.parse(await readFile(statusFile, 'utf8'))._runtime.shellCleanups).toEqual([reference]);

    // The exited process cannot provide fresh identity evidence after restart.
    // Recovery must consume the durable verification left by the sweep.
    processTree.killPid.mockResolvedValue({ status: 'unknown' });
    recovered = await createKodaXRuntime(options);
    expect(await recovered.runs.get(run.runId)).not.toMatchObject({ phase: 'unknown' });
    expect(JSON.parse(await readFile(statusFile, 'utf8'))._runtime.shellCleanups).toEqual([]);
    await expect(readFile(registryFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(processTree.killPid).toHaveBeenCalledOnce();
    const successor = await recovered.runs.start(runInput);
    await expect(successor.result).resolves.toMatchObject({ phase: 'completed' });
  } finally {
    await recovered?.close();
    await runtime.close();
    processTree.killPid.mockReset();
    setAgentConfigHome(undefined);
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});
