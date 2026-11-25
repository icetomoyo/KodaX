import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRepoIntelSupervisor, type RepoIntelSupervisor } from './supervisor.js';

const fixture = fileURLToPath(new URL('./fake-engine.fixture.mjs', import.meta.url));
/** Built by `cargo build --release` in native/repo-intel; the test that needs it skips without it. */
const realEngine = fileURLToPath(new URL(
  `../../../../../native/repo-intel/target/release/kodax-repo-intel${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url));
const timing = { pollMs: 40, statusTimeoutMs: 300, idleMs: 60_000, restartMinMs: 20, restartMaxMs: 80 };

interface Received { readonly pid: number; readonly method: string; readonly params?: Record<string, unknown> }

let scratch: string;
let journal: string;
let supervisor: RepoIntelSupervisor | undefined;

beforeEach(() => {
  scratch = mkdtempSync(path.join(tmpdir(), 'kodax-repo-intel-supervisor-'));
  journal = path.join(scratch, 'journal.jsonl');
});

afterEach(async () => {
  await supervisor?.close();
  supervisor = undefined;
  await rm(scratch, { recursive: true, force: true });
});

function start(flags: readonly string[] = [], overrides: Partial<typeof timing> = {}): RepoIntelSupervisor {
  supervisor = createRepoIntelSupervisor({
    launch: { command: process.execPath, args: [fixture, '--journal', journal, ...flags] },
    storageRoot: path.join(scratch, 'storage'),
    timing: { ...timing, ...overrides },
  });
  return supervisor;
}

function received(): Received[] {
  if (!existsSync(journal)) return [];
  return readFileSync(journal, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Received);
}

async function until<T>(check: () => T | undefined | false, what: string, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; received ${JSON.stringify(received())}`);
    await new Promise(resolve => setTimeout(resolve, 15));
  }
}

const opens = (root: string): Received[] => received().filter(item => item.method === 'workspace.open' && item.params?.root === root);

describe('RepoIntel supervisor', () => {
  it('starts the engine only when a repository is opened, then initializes and opens it', async () => {
    const engine = start();
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(received()).toEqual([]);
    expect(engine.status().state).toBe('idle');

    engine.open(scratch);
    await until(() => opens(scratch).length === 1, 'workspace.open');
    const [initialize] = received();
    expect(initialize).toMatchObject({ method: 'initialize', params: { storageRoot: path.join(scratch, 'storage'), memoryBudgetMb: 300 } });
    expect(engine.status()).toMatchObject({ state: 'running', roots: [scratch] });
  });

  it('opens one repository once and relays the files an edit changed', async () => {
    const engine = start();
    engine.open(scratch);
    engine.open(scratch);
    await until(() => engine.status().state === 'running', 'the engine to run');
    engine.changed(scratch, ['src/a.ts']);
    await until(() => received().find(item => item.method === 'files.changed'), 'files.changed');
    expect(opens(scratch)).toHaveLength(1);
    expect(received().find(item => item.method === 'files.changed')?.params).toEqual({ root: scratch, paths: ['src/a.ts'] });
  });

  it('drops an edit that lands while the engine starts, since opening sweeps the repository', async () => {
    const engine = start();
    engine.open(scratch);
    engine.changed(scratch, ['src/a.ts']);
    await until(() => opens(scratch).length === 1, 'workspace.open');
    await until(() => received().some(item => item.method === 'engine.status'), 'a status poll');
    expect(received().some(item => item.method === 'files.changed')).toBe(false);
    expect(received().find(item => item.method === 'engine.status')).not.toHaveProperty('params');
  });

  it('opens a repository it was not watching when an edit lands in it', async () => {
    const engine = start();
    const other = path.join(scratch, 'other');
    engine.changed(other, ['b.ts']);
    await until(() => opens(other).length === 1, 'workspace.open for the edited repository');
    expect(engine.status().roots).toEqual([other]);
  });

  it('replaces an engine that stops answering and reopens its repositories', async () => {
    const engine = start(['--hang-status']);
    engine.open(scratch);
    await until(() => engine.status().restarts >= 1, 'a restart');
    await until(() => new Set(opens(scratch).map(item => item.pid)).size >= 2, 'the reopen in the new engine');
    expect(engine.status().problem).toMatch(/did not answer/);
  });

  it('replaces an engine that grows past the hard memory limit', async () => {
    const engine = start(['--rss', String(700 * 1024 * 1024)]);
    engine.open(scratch);
    await until(() => engine.status().restarts >= 1, 'a restart');
    expect(engine.status().problem).toMatch(/700 MB.*600 MB/);
  });

  it('restarts an engine that exits, waiting longer after each failure', async () => {
    const engine = start(['--exit-after-open']);
    engine.open(scratch);
    await until(() => engine.status().restarts >= 3, 'three restarts');
    const pids = opens(scratch).map(item => item.pid);
    expect(new Set(pids).size).toBeGreaterThanOrEqual(3);
    expect(engine.status().problem).toMatch(/exited with code 3/);
  });

  it('reports an engine that cannot start instead of failing the caller', async () => {
    supervisor = createRepoIntelSupervisor({
      launch: { command: path.join(scratch, 'missing-engine') },
      storageRoot: path.join(scratch, 'storage'),
      timing,
    });
    expect(() => supervisor!.open(scratch)).not.toThrow();
    await until(() => supervisor!.status().problem, 'a problem report');
    expect(supervisor.status().problem).toMatch(/cannot start/);
    expect(supervisor.status().restarts).toBeGreaterThanOrEqual(1);
  });

  it('reports a program the system refuses to run', async () => {
    const notAProgram = path.join(scratch, `not-a-program${process.platform === 'win32' ? '.exe' : ''}`);
    writeFileSync(notAProgram, '');
    supervisor = createRepoIntelSupervisor({ launch: { command: notAProgram }, storageRoot: path.join(scratch, 'storage'), timing });
    expect(() => supervisor!.open(scratch)).not.toThrow();
    await until(() => supervisor!.status().problem, 'a problem report');
    expect(supervisor.status().problem).toMatch(/cannot start/);
  });

  it('reports an engine that refuses initialize', async () => {
    const engine = start(['--fail-initialize']);
    engine.open(scratch);
    await until(() => engine.status().problem, 'a problem report');
    expect(engine.status().problem).toMatch(/storageRoot is not a folder/);
  });

  it('stops an idle engine and forgets its repositories until the next use', async () => {
    const engine = start([], { idleMs: 150 });
    engine.open(scratch);
    await until(() => received().some(item => item.method === 'exit'), 'exit after idling');
    expect(received().map(item => item.method)).toContain('shutdown');
    expect(engine.status()).toMatchObject({ state: 'idle', roots: [] });

    engine.open(scratch);
    await until(() => new Set(opens(scratch).map(item => item.pid)).size === 2, 'a fresh engine');
  });

  it.skipIf(!existsSync(realEngine))('drives the real engine through a repository and its memory report', async () => {
    execFileSync('git', ['init', '-q'], { cwd: scratch });
    supervisor = createRepoIntelSupervisor({ launch: { command: realEngine }, storageRoot: path.join(scratch, 'storage'), timing });
    supervisor.open(scratch);
    await until(() => supervisor!.status().residentBytes, 'a memory report');
    expect(supervisor.status()).toMatchObject({ state: 'running', roots: [scratch], restarts: 0 });
    expect(supervisor.status().problem).toBeUndefined();
    await supervisor.close();
    expect(supervisor.status().state).toBe('closed');
  });

  it('shuts the engine down on close and ignores later calls', async () => {
    const engine = start();
    engine.open(scratch);
    await until(() => opens(scratch).length === 1, 'workspace.open');
    await engine.close();
    expect(received().map(item => item.method).slice(-2)).toEqual(['shutdown', 'exit']);
    expect(engine.status().state).toBe('closed');
    engine.open(scratch);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(opens(scratch)).toHaveLength(1);
  });
});
