import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { setAgentConfigHome } from './agent-home.js';
import { cleanupManagedRunChildProcess, cleanupRegisteredManagedChildren } from './managed-child-processes.js';

const roots: string[] = [];
afterEach(async () => {
  setAgentConfigHome(undefined);
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

it('leaves historical evidence untouched during current-owner-only cleanup', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-cleanup-scope-'));
  roots.push(root);
  setAgentConfigHome(root);
  const directory = path.join(root, 'runtime', 'processes', 'children');
  await fs.mkdir(directory, { recursive: true });
  const evidence = path.join(directory, 'historical.json');
  await fs.writeFile(evidence, '{untrusted');
  await expect(cleanupRegisteredManagedChildren({ scope: 'current-owner', includeCurrentOwner: true }))
    .resolves.toEqual({ killed: 0, pruned: 0, skipped: 0 });
  expect(await fs.readFile(evidence, 'utf8')).toBe('{untrusted');
});

it('binds historical recovery to the explicit config home', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-cleanup-home-'));
  roots.push(root);
  const other = path.join(root, 'other-home');
  setAgentConfigHome(root);
  for (const home of [root, other]) {
    const directory = path.join(home, 'runtime', 'processes', 'children');
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'invalid.json'), '{untrusted');
  }
  await expect(cleanupRegisteredManagedChildren({ configHome: other }))
    .resolves.toMatchObject({ pruned: 1 });
  expect(await fs.readFile(path.join(root, 'runtime', 'processes', 'children', 'invalid.json'), 'utf8'))
    .toBe('{untrusted');
  await expect(fs.access(path.join(other, 'runtime', 'processes', 'children', 'invalid.json')))
    .rejects.toMatchObject({ code: 'ENOENT' });
});

it('keeps exact Run recovery and its later release bound to the same private home', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-private-run-cleanup-'));
  roots.push(root);
  const privateHome = path.join(root, 'private');
  setAgentConfigHome(root);
  const reference = { runtimeRunId: 'private-run', pid: 999_999, registrationId: '95bc0da4-8673-43c6-a8e7-a2c081da6dce' };
  const relative = path.join('runtime', 'processes', 'children', `${reference.pid}.${reference.registrationId}.json`);
  for (const home of [root, privateHome]) {
    await fs.mkdir(path.dirname(path.join(home, relative)), { recursive: true });
    await fs.writeFile(path.join(home, relative), JSON.stringify({ ...reference,
      version: 4, ownerPid: 999_998, registeredAtMs: 1, kind: 'test', command: 'test', cleanupVerified: true,
    }));
  }
  const cleanup = await cleanupManagedRunChildProcess(reference, { configHome: privateHome });
  expect(cleanup.status).toBe('verified');
  if (cleanup.status !== 'verified') throw new Error('Expected a durable cleanup witness');
  cleanup.release();
  await expect(fs.access(path.join(privateHome, relative))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(fs.access(path.join(root, relative))).resolves.toBeUndefined();
});
