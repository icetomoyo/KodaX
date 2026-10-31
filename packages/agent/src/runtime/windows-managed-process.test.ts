import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareWindowsManagedProcess } from './windows-managed-process.js';
import { killChildProcessTree } from './process-tree.js';
import { cleanupRegisteredManagedChildren, registerManagedChildProcess,
  withManagedChildProcessConfigHome } from './managed-child-processes.js';

describe.runIf(process.platform === 'win32')('Windows managed process admission and cleanup', () => {
  let child: ChildProcess | undefined;
  let directory = '';
  afterEach(async () => {
    if (child !== undefined) expect((await killChildProcessTree(child)).status).not.toBe('unknown');
    child = undefined;
    if (directory) {
      expect(directory.startsWith(join(tmpdir(), 'kodax-managed-gate-'))).toBe(true);
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      directory = '';
    }
  });

  it('holds user effects until registration and preserves original stdin, environment and exit status', async () => {
    directory = await mkdtemp(join(tmpdir(), 'kodax-managed-gate-'));
    await withManagedChildProcessConfigHome(directory, async () => {
      const prepared = await prepareWindowsManagedProcess({
        executable: process.execPath, cwd: directory, env: { ...process.env, KODAX_TEST_GATE: 'target' },
        deadlineAt: Date.now() + 30_000,
        args: ['-e', `require('node:fs').writeFileSync('started', process.env.KODAX_TEST_GATE);
          process.stdin.pipe(process.stdout); process.stdin.on('end', () => { process.exitCode = 7; });`],
      });
      child = prepared.child;
      await expect(readFile(join(directory, 'started'))).rejects.toMatchObject({ code: 'ENOENT' });
      const unregister = registerManagedChildProcess(child, { kind: 'gate-acceptance', command: 'stdin' }, {
        manualUnregister: true, requireDurableRecord: true,
      });
      let output = '';
      child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
      const closed = new Promise<number | null>(resolve => child!.once('close', resolve));
      await prepared.start();
      child.stdin?.end('target-stdin');
      expect(await closed).toBe(7);
      await prepared.drained;
      unregister();
      expect(output).toBe('target-stdin');
      expect(await readFile(join(directory, 'started'), 'utf8')).toBe('target');
      expect(await readdir(join(directory, 'runtime/processes/children'))).toEqual([]);
    });
  });

  it('allows the owner sweep to drain a still-gated child without starting user code', async () => {
    directory = await mkdtemp(join(tmpdir(), 'kodax-managed-gate-'));
    await withManagedChildProcessConfigHome(directory, async () => {
      const prepared = await prepareWindowsManagedProcess({
        executable: process.execPath, args: ['-e', "require('node:fs').writeFileSync('escaped','started')"],
        cwd: directory, env: process.env,
        deadlineAt: Date.now() + 30_000,
      });
      child = prepared.child;
      registerManagedChildProcess(child, { kind: 'gate-acceptance', command: 'not-admitted' });
      await expect(cleanupRegisteredManagedChildren({ configHome: directory,
        includeCurrentOwner: true, requireCurrentOwnerCleanup: true }))
        .resolves.toMatchObject({ skipped: 0 });
      await prepared.drained;
      await expect(readFile(join(directory, 'escaped'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readdir(join(directory, 'runtime/processes/children'))).toEqual([]);
    });
  });

  it('does not execute target NODE_OPTIONS preloads in the gate before admission', async () => {
    directory = await mkdtemp(join(tmpdir(), 'kodax-managed-gate-'));
    const preload = join(directory, 'preload.cjs');
    await writeFile(preload, "require('node:fs').writeFileSync('preloaded', 'target-only');");
    const prepared = await prepareWindowsManagedProcess({
      executable: process.execPath, args: ['-e', "process.stdout.write('target')"], cwd: directory,
      env: { ...process.env, node_options: `--require=${preload}` }, deadlineAt: Date.now() + 30_000,
    });
    child = prepared.child;
    await expect(readFile(join(directory, 'preloaded'))).rejects.toMatchObject({ code: 'ENOENT' });
    child.stdout?.resume();
    await prepared.start();
    child.stdin?.end();
    await prepared.drained;
    expect(await readFile(join(directory, 'preloaded'), 'utf8')).toBe('target-only');
  });

  it('keeps an expired command behind the gate without starting its effects', async () => {
    directory = await mkdtemp(join(tmpdir(), 'kodax-managed-gate-'));
    const deadlineAt = Date.now() + 30_000;
    const prepared = await prepareWindowsManagedProcess({
      executable: process.execPath, args: ['-e', "require('node:fs').writeFileSync('escaped','started')"],
      cwd: directory, env: process.env, deadlineAt,
    });
    child = prepared.child;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(deadlineAt);
    try { await expect(prepared.start()).rejects.toMatchObject({ name: 'TimeoutError' }); }
    finally { clock.mockRestore(); }
    expect((await killChildProcessTree(child)).status).not.toBe('unknown');
    await expect(readFile(join(directory, 'escaped'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('observes a gate input failure and rejects admission without an unhandled stream error', async () => {
    directory = await mkdtemp(join(tmpdir(), 'kodax-managed-gate-'));
    const prepared = await prepareWindowsManagedProcess({
      executable: process.execPath, args: ['-e', "require('node:fs').writeFileSync('escaped','started')"],
      cwd: directory, env: process.env, deadlineAt: Date.now() + 30_000,
    });
    child = prepared.child;
    child.stdin?.destroy(new Error('header pipe failed'));
    await new Promise<void>(resolve => setImmediate(resolve));
    await expect(prepared.start()).rejects.toThrow('header pipe failed');
    expect((await killChildProcessTree(child)).status).not.toBe('unknown');
    await expect(readFile(join(directory, 'escaped'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
