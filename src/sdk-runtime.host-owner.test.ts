import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

import { afterEach, describe, expect, it } from 'vitest';
import { connectKodaXRuntime, createKodaXRuntime, type KodaXRuntime } from './sdk-runtime.js';

const roots: string[] = [];
const runtimes: KodaXRuntime[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('product Host Session storage ownership', () => {
  it('rejects a live Host in another process and permits startup after that process crashes', async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-host-process-'));
    roots.push(homeDir);
    const sessionsDir = path.join(homeDir, 'sessions');
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', `
      import { createKodaXRuntime } from './src/sdk-runtime.ts';
      await createKodaXRuntime({ homeDir: process.argv[1], sessionsDir: process.argv[2], profile: 'child', sharedDaemonHost: true });
      process.stdout.write('ready');
      process.stdin.resume();
      process.stdin.on('end', () => process.exit(0));
    `, homeDir, sessionsDir], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const exited = once(child, 'exit');
    let errors = '';
    child.stderr.on('data', (chunk: Buffer) => { errors += chunk.toString(); });
    try {
      await Promise.race([
        once(child.stdout, 'data'),
        exited.then(() => { throw new Error(`Host fixture exited before ready: ${errors}`); }),
      ]);
      await expect(createKodaXRuntime({ homeDir, sessionsDir, profile: 'parent', sharedDaemonHost: true }))
        .rejects.toMatchObject({ code: 'session_storage_owned' });
      child.stdin.end();
      await exited;
      const replacement = await createKodaXRuntime({ homeDir, sessionsDir, profile: 'parent', sharedDaemonHost: true });
      runtimes.push(replacement);
      await expect(replacement.sessions.list()).resolves.toEqual([]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    }
  });

  it('does not let a passive connection request start or replace a Host', async () => {
    await expect(connectKodaXRuntime({ autoStart: true, transport: {
      async request() { throw new Error('A passive connection must reject startup before connecting'); },
      subscribe() { return { close() {} }; },
    } })).rejects.toThrow('ensureKodaXRuntime');
  });
  it('rejects another profile writing the same actual Session root and releases it on close', async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-host-owner-'));
    roots.push(homeDir);
    const sessionsDir = path.join(homeDir, 'sessions');
    const first = await createKodaXRuntime({ homeDir, sessionsDir, profile: 'first', sharedDaemonHost: true });
    runtimes.push(first);
    const saved = await first.sessions.create({ title: 'Owned session' });

    const alias = path.join(homeDir, 'session-alias');
    fs.symlinkSync(sessionsDir, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(createKodaXRuntime({
      homeDir, sessionsDir: alias, profile: 'alias', sharedDaemonHost: true,
    })).rejects.toMatchObject({ code: 'session_storage_owned' });

    const separate = await createKodaXRuntime({
      homeDir, sessionsDir: path.join(homeDir, 'other-sessions'), profile: 'separate', sharedDaemonHost: true,
    });
    runtimes.push(separate);
    await expect(separate.sessions.list()).resolves.toEqual([]);

    const competing = createKodaXRuntime({ homeDir, sessionsDir, profile: 'second', sharedDaemonHost: true });
    void competing.then((runtime) => runtimes.push(runtime), () => undefined);
    await expect(competing).rejects.toMatchObject({ code: 'session_storage_owned' });

    await first.close();
    const next = await createKodaXRuntime({ homeDir, sessionsDir, profile: 'second', sharedDaemonHost: true });
    runtimes.push(next);
    await expect(next.sessions.load(saved.id)).resolves.toMatchObject({ title: 'Owned session' });
  });
});
