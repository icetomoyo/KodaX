import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { executeChildAgents } from '../packages/coding/src/child-executor.js';
import { createKodaXRuntime } from '../tests/runtime-fixture.js';
import type { ActorCrashBoundary, ActorCrashMarker } from '../tests/fixtures/actor-crash.fixture.js';

vi.mock('../packages/coding/src/child-executor.js', async importOriginal => ({
  ...await importOriginal<typeof import('../packages/coding/src/child-executor.js')>(),
  executeChildAgents: vi.fn(),
}));

function parseMarker(value: unknown): ActorCrashMarker {
  if (typeof value !== 'object' || value === null
    || !('pid' in value) || typeof value.pid !== 'number'
    || !('boundary' in value) || (value.boundary !== 'before-actor-canonical' && value.boundary !== 'before-run-terminal')
    || !('sessionId' in value) || typeof value.sessionId !== 'string'
    || !('actorPath' in value) || typeof value.actorPath !== 'string'
    || !('turnId' in value) || typeof value.turnId !== 'string'
    || !('runId' in value) || typeof value.runId !== 'string'
    || !('actorSavePhase' in value) || typeof value.actorSavePhase !== 'string'
    || !('runPhase' in value) || typeof value.runPhase !== 'string'
    || !('executorCalls' in value) || typeof value.executorCalls !== 'number') {
    throw new Error('Dedicated Actor process returned an invalid crash-boundary marker.');
  }
  return value as ActorCrashMarker;
}

for (const boundary of ['before-actor-canonical', 'before-run-terminal'] satisfies ActorCrashBoundary[]) {
  it(`recovers the exact independent Actor after a real process crash (${boundary})`, async ({ signal }) => {
    const temporaryRoot = resolve(tmpdir());
    const fixtureRoot = await mkdtemp(join(temporaryRoot, 'kodax-actor-crash-'));
    const homeDir = join(fixtureRoot, 'home');
    const markerFile = join(fixtureRoot, 'boundary.json');
    const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
    const environment: NodeJS.ProcessEnv = { ...process.env, KODAX_ACTOR_CRASH_HOME: homeDir,
      KODAX_ACTOR_CRASH_MARKER: markerFile, KODAX_ACTOR_CRASH_BOUNDARY: boundary, NO_COLOR: '1' };
    delete environment.VITEST;
    delete environment.VITEST_WORKER_ID;
    delete environment.VITEST_POOL_ID;
    delete environment.FORCE_COLOR;
    const child = spawn(process.execPath, [join(repositoryRoot, 'node_modules', 'vitest', 'vitest.mjs'), 'run',
      '--root', repositoryRoot, '--config', join(repositoryRoot, 'tests', 'fixtures', 'actor-crash.config.ts'),
      '--pool', 'threads', '--maxWorkers', '1', '--reporter', 'default'],
    { cwd: repositoryRoot, env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let childOutput = '';
    const capture = (chunk: Buffer) => { childOutput = (childOutput + chunk.toString('utf8')).slice(-16_384); };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    let spawnError: Error | undefined;
    const closed = new Promise<void>(resolveClosed => {
      child.once('error', error => { spawnError = error; resolveClosed(); });
      child.once('close', () => resolveClosed());
    });
    const killChild = () => { child.kill('SIGKILL'); };
    signal.addEventListener('abort', killChild, { once: true });
    let runtime: Awaited<ReturnType<typeof createKodaXRuntime>> | undefined;
    try {
      vi.mocked(executeChildAgents).mockImplementation(async () => { throw new Error('Restart must not dispatch the old Actor again.'); });
      let marker: ActorCrashMarker | undefined;
      while (!marker) {
        signal.throwIfAborted();
        if (spawnError) throw spawnError;
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Actor child exited before its crash boundary.\n${childOutput}`);
        try { marker = parseMarker(JSON.parse(await readFile(markerFile, 'utf8'))); }
        catch (error: unknown) {
          if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')) throw error;
          await delay(25, undefined, { signal });
        }
      }
      const evidence = JSON.stringify(marker);
      expect(marker.pid, evidence).toBe(child.pid);
      expect(marker.pid, evidence).not.toBe(process.pid);
      expect(marker.boundary, evidence).toBe(boundary);
      expect(marker.actorSavePhase, evidence).toBe(boundary === 'before-actor-canonical' ? 'commit_inflight' : 'committed');
      expect(['completed', 'failed', 'cancelled', 'interrupted'], evidence).not.toContain(marker.runPhase);
      expect(marker.executorCalls, evidence).toBe(1);
      expect(child.kill('SIGKILL'), evidence).toBe(true);
      await closed;
      runtime = await createKodaXRuntime({ homeDir, defaultProvider: 'deepseek' });
      const run = await runtime.runs.get(marker.runId);
      const actor = await runtime.agents.output(marker.sessionId, marker.actorPath, marker.turnId);
      if (boundary === 'before-actor-canonical') {
        expect(['interrupted', 'unknown'], evidence).toContain(run.phase);
        expect(run.terminal?.kind, evidence).not.toBe('completed');
        expect(actor.state, evidence).toBe('interrupted');
      } else {
        expect(run, evidence).toMatchObject({ phase: 'completed', terminal: { kind: 'completed' } });
        expect(actor.state, evidence).toBe('completed');
      }
      expect(executeChildAgents).not.toHaveBeenCalled();
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await closed;
      signal.removeEventListener('abort', killChild);
      await runtime?.close();
      vi.mocked(executeChildAgents).mockReset();
      if (dirname(fixtureRoot) !== temporaryRoot) throw new Error('Refusing to remove a fixture outside its temporary root.');
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  }, 90_000);
}
