import * as filePromises from 'node:fs/promises';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanupRegisteredManagedChildren } from './managed-child-processes.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

let configHome: string | undefined;
afterEach(async () => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
  if (configHome) await rm(configHome, { recursive: true, force: true });
  configHome = undefined;
});

it('keeps historical cleanup pending and responsive while registry reads await disk', async () => {
  configHome = await mkdtemp(path.join(tmpdir(), 'kodax-registry-read-'));
  const directory = path.join(configHome, 'runtime/processes/children');
  await mkdir(directory, { recursive: true });
  const files = Array.from({ length: 50 }, (_, index) => path.join(directory, `record-${index}.json`));
  for (const [index, file] of files.entries()) {
    await writeFile(file, JSON.stringify({ version: 4, pid: 100_000_000 + index, ownerPid: process.pid,
      registrationId: `pending-${index}`, registeredAtMs: Date.now(), kind: 'test', command: 'node',
      runtimeRunId: `run-${index}`, runCleanupRequired: true, processTreeComplete: false }));
  }
  let unblock: () => void = () => undefined;
  const disk = new Promise<void>(resolve => { unblock = resolve; });
  let reads = 0;
  const actualRead = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).readFile;
  vi.mocked(filePromises.readFile).mockImplementation(async (...args: Parameters<typeof actualRead>) => {
    if (files.includes(String(args[0]))) { reads += 1; await disk; }
    return actualRead(...args);
  });
  let settled = false;
  const cleanup = cleanupRegisteredManagedChildren({ configHome }).finally(() => { settled = true; });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled, 'Cleanup must wait for pending disk reads without blocking the event loop').toBe(false);
    expect(reads, 'Independent historical records must be read without serial disk waits').toBeGreaterThan(1);
    expect(reads, 'Registry disk reads must have a bounded number in flight').toBeLessThan(files.length);
  } finally {
    unblock();
    await expect(cleanup).resolves.toMatchObject({ killed: 0, pruned: 0, skipped: files.length });
  }
  for (const file of files) expect(JSON.parse(await readFile(file, 'utf8')).version).toBe(4);
});

it('retains registry evidence when its historical disk read is denied', async () => {
  configHome = await mkdtemp(path.join(tmpdir(), 'kodax-registry-denied-'));
  const directory = path.join(configHome, 'runtime/processes/children');
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, 'unreadable.json');
  const record = { version: 4, pid: 100_000_000, ownerPid: process.pid,
    registrationId: 'denied-record', registeredAtMs: Date.now(), kind: 'test', command: 'node' };
  await writeFile(file, JSON.stringify(record));
  vi.mocked(filePromises.readFile).mockRejectedValueOnce(Object.assign(new Error('Permission denied'), { code: 'EACCES' }));
  await expect(cleanupRegisteredManagedChildren({ configHome })).resolves.toMatchObject({ killed: 0, pruned: 0, skipped: 1 });
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(record);
});
