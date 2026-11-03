import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { tryAcquireStorageFileLock, withStorageFileLock } from './storage-file-lock.js';

it.each(['write', 'sync', 'link'] as const)('never publishes an incomplete owner after a %s failure', stage => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-storage-publish-'));
  const file = path.join(home, '.store.lock');
  const failure = Object.assign(new Error('fixture publication failure'), { code: 'EIO' });
  const fault = stage === 'write' ? vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => { throw failure; })
    : stage === 'sync' ? vi.spyOn(fs, 'fsyncSync').mockImplementationOnce(() => { throw failure; })
    : vi.spyOn(fs, 'linkSync').mockImplementationOnce(() => { throw failure; });
  try {
    expect(() => tryAcquireStorageFileLock(file)).toThrow(failure);
    expect(fs.existsSync(file)).toBe(false); expect(fs.readdirSync(home)).toEqual([]);
  } finally { fault.mockRestore(); fs.rmSync(home, { recursive: true, force: true }); }
});

it('reclaims only a proven dead generation and retains its permanent claim', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-storage-dead-owner-'));
  const file = path.join(home, '.store.lock');
  const fault = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('dead'), { code: 'ESRCH' }); });
  try {
    fs.writeFileSync(file, JSON.stringify({ version: 1, pid: 123, token: 'old' }));
    const lock = tryAcquireStorageFileLock(file)!; expect(lock).toBeDefined(); lock.assertOwned(); lock.release(); lock.release();
    expect(() => lock.assertOwned()).toThrow(/ownership/);
    expect(fs.readdirSync(home)).toHaveLength(1); expect(fs.readdirSync(home)[0]).toContain('.reclaim.');
    fs.writeFileSync(file, '');
    await expect(withStorageFileLock(file, async () => undefined, 0)).rejects.toThrow(file);
    expect(fs.readFileSync(file, 'utf8')).toBe('');
  } finally { fault.mockRestore(); fs.rmSync(home, { recursive: true, force: true }); }
});

it('keeps a replacement owner after a delayed reclaimer and reports operation/release double failures', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-storage-replacement-'));
  const file = path.join(home, '.store.lock');
  const linking = fs.linkSync;
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('dead'), { code: 'ESRCH' }); });
  const link = vi.spyOn(fs, 'linkSync').mockImplementation((source, destination) => {
    linking(source, destination);
    if (String(destination).includes('.reclaim.')) fs.writeFileSync(file, 'replacement');
  });
  try {
    fs.writeFileSync(file, JSON.stringify({ version: 1, pid: 123, token: 'old' }));
    expect(tryAcquireStorageFileLock(file)).toBeUndefined(); expect(fs.readFileSync(file, 'utf8')).toBe('replacement');
    link.mockRestore(); kill.mockRestore(); fs.unlinkSync(file);
    const operationFailure = new Error('fixture operation failure');
    await expect(withStorageFileLock(file, async () => { fs.writeFileSync(file, 'new-owner'); throw operationFailure; }))
      .rejects.toThrow(expect.objectContaining({ errors: expect.arrayContaining([operationFailure]) }));
    expect(fs.readFileSync(file, 'utf8')).toBe('new-owner');
  } finally { link.mockRestore(); kill.mockRestore(); fs.rmSync(home, { recursive: true, force: true }); }
});

it('serializes storage maintenance with writers and retains unknown ownership regardless of age', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-storage-lease-'));
  const file = path.join(home, '.store.lock');
  try {
    const first = tryAcquireStorageFileLock(file);
    expect(first).toBeDefined();
    expect(tryAcquireStorageFileLock(file)).toBeUndefined();
    first!.release();
    const order: string[] = [];
    await Promise.all([withStorageFileLock(file, async () => { order.push('first'); await new Promise(resolve => setTimeout(resolve, 20)); order.push('first-end'); }),
      withStorageFileLock(file, async () => { order.push('second'); })]);
    expect(order).toEqual(['first', 'first-end', 'second']);
    fs.writeFileSync(file, ''); fs.utimesSync(file, new Date(0), new Date(0));
    expect(tryAcquireStorageFileLock(file)).toBeUndefined();
    expect(fs.readFileSync(file, 'utf8')).toBe('');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

it('reports temporary and rollback cleanup errors together and retries only its inactive owner', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kodax-storage-double-cleanup-'));
  const file = path.join(home, '.store.lock');
  const remove = fs.rmSync, unlink = fs.unlinkSync;
  const temporaryFailure = Object.assign(new Error('fixture temporary cleanup'), { code: 'EACCES' });
  const rollbackFailure = Object.assign(new Error('fixture rollback cleanup'), { code: 'EBUSY' });
  const faults = [vi.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
    if (String(target).endsWith('.tmp')) throw temporaryFailure;
    return remove(target, options);
  }), vi.spyOn(fs, 'unlinkSync').mockImplementation(target => { if (target === file) throw rollbackFailure; unlink(target); })];
  try {
    expect(() => tryAcquireStorageFileLock(file)).toThrow(expect.objectContaining({ errors: expect.arrayContaining([temporaryFailure, rollbackFailure]) }));
    expect(fs.existsSync(file)).toBe(true);
    for (const fault of faults) fault.mockRestore();
    const next = tryAcquireStorageFileLock(file);
    expect(next).toBeDefined(); next!.release();
  } finally { for (const fault of faults) fault.mockRestore(); fs.rmSync(home, { recursive: true, force: true }); }
});
