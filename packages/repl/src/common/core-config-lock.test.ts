import {
  closeSync,
  mkdtempSync,
  openSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CoreConfigWriteConflictError,
  claimConfigLockReclamation,
  coreConfigWriteLockPath,
  withCoreConfigWriteLock,
  writeCoreConfigAtomically,
} from './core-config-lock.js';

describe('withCoreConfigWriteLock', () => {
  afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); });
  it.skipIf(process.platform !== 'win32')('publishes after a transient reader denies Windows replacement', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'kodax-core-rename-'));
    const file = path.join(home, 'config.json');
    writeFileSync(file, 'old');
    const rename = fs.renameSync;
    const calls = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('Fixture reader denial'), { code: 'EPERM' });
    }).mockImplementation(rename);
    syncBuiltinESMExports();
    try {
      withCoreConfigWriteLock(file, () => writeCoreConfigAtomically(file, 'new'));
      expect(readFileSync(file, 'utf8')).toBe('new');
      expect(calls).toHaveBeenCalledTimes(2);
    } finally { calls.mockRestore(); syncBuiltinESMExports(); rmSync(home, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== 'win32').each(['permanent', 'oversleep', 'different-error'] as const)
    ('bounds Windows config replacement retries and preserves the original on %s', failure => {
      const home = mkdtempSync(path.join(tmpdir(), 'kodax-core-rename-budget-'));
      const file = path.join(home, 'config.json');
      writeFileSync(file, 'old');
      let elapsed = 0;
      vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
      vi.spyOn(Atomics, 'wait').mockImplementation((_cell, _index, _value, timeout) => {
        elapsed += failure === 'oversleep' ? 1_250 : timeout ?? 0;
        return 'timed-out';
      });
      const denial = Object.assign(new Error('Fixture permission denial'), { code: 'EPERM' });
      const ioError = Object.assign(new Error('Fixture permanent IO failure'), { code: 'EIO' });
      const starts: number[] = [];
      const calls = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
        starts.push(elapsed);
        if (starts.length > 1 && failure === 'different-error') throw ioError;
        if (starts.length > 1) elapsed += 40;
        throw denial;
      });
      syncBuiltinESMExports();
      try {
        expect(() => withCoreConfigWriteLock(file, () => writeCoreConfigAtomically(file, 'new')))
          .toThrow(failure === 'different-error' ? ioError : denial);
        expect(readFileSync(file, 'utf8')).toBe('old');
        expect(starts.every(start => start < 1_000)).toBe(true);
        expect(calls.mock.calls.length).toBe(failure === 'oversleep' ? 1 : failure === 'different-error' ? 2 : 21);
      } finally { calls.mockRestore(); syncBuiltinESMExports(); rmSync(home, { recursive: true, force: true }); }
    });

  it.each(['write', 'sync', 'link', 'close', 'temporary-cleanup'] as const)('never starts a config write after failed lock %s', failure => {
    const home = mkdtempSync(path.join(tmpdir(), 'kodax-core-publication-'));
    const config = path.join(home, 'config.json'), lock = coreConfigWriteLockPath(config);
    const action = vi.fn();
    const fail = () => { throw Object.assign(new Error('fixture publication failure'), { code: 'EIO' }); };
    const close = fs.closeSync, remove = fs.rmSync;
    const fault = failure === 'write' ? vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(fail)
      : failure === 'sync' ? vi.spyOn(fs, 'fsyncSync').mockImplementationOnce(fail)
      : failure === 'link' ? vi.spyOn(fs, 'linkSync').mockImplementationOnce(fail)
      : failure === 'close' ? vi.spyOn(fs, 'closeSync').mockImplementationOnce(fd => { close(fd); fail(); })
      : vi.spyOn(fs, 'rmSync').mockImplementation((file, options) => { if (String(file).endsWith('.tmp')) fail(); remove(file, options); });
    syncBuiltinESMExports();
    try {
      expect(() => withCoreConfigWriteLock(config, action)).toThrow('fixture publication failure');
      expect(action).not.toHaveBeenCalled();
      expect(fs.existsSync(lock)).toBe(false);
      fault.mockRestore(); syncBuiltinESMExports();
      expect(withCoreConfigWriteLock(config, () => 'retry')).toBe('retry');
    } finally { fault.mockRestore(); syncBuiltinESMExports(); remove(home, { recursive: true, force: true }); }
  });
  it('preserves a legacy config symlink while atomically replacing its target', context => {
    const home = mkdtempSync(path.join(tmpdir(), 'kodax-core-symlink-'));
    const target = path.join(home, 'target.json'), config = path.join(home, 'config.json');
    try {
      writeFileSync(target, 'old');
      try { fs.symlinkSync(target, config, 'file'); }
      catch (error) {
        if (process.platform === 'win32' && (error as NodeJS.ErrnoException).code === 'EPERM') { context.skip('File symlink privilege is unavailable.'); return; }
        throw error;
      }
      writeCoreConfigAtomically(config, 'new');
      expect(fs.lstatSync(config).isSymbolicLink()).toBe(true);
      expect(readFileSync(target, 'utf8')).toBe('new');
      fs.unlinkSync(target);
      expect(() => writeCoreConfigAtomically(config, 'must not replace link')).toThrow();
      expect(fs.lstatSync(config).isSymbolicLink()).toBe(true);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
  it('retries only its own inactive release after a transient Windows cleanup failure', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'kodax-core-release-'));
    const config = path.join(home, 'config.json'), lock = coreConfigWriteLockPath(config);
    const remove = fs.rmSync;
    const fault = vi.spyOn(fs, 'rmSync').mockImplementation((file, options) => {
      if (file === lock) throw Object.assign(new Error('fixture release busy'), { code: 'EBUSY' });
      remove(file, options);
    });
    syncBuiltinESMExports();
    try {
      expect(() => withCoreConfigWriteLock(config, () => writeFileSync(config, 'retain'))).toThrow('fixture release busy');
      fault.mockRestore(); syncBuiltinESMExports();
      expect(withCoreConfigWriteLock(config, () => readFileSync(config, 'utf8'))).toBe('retain');
      writeFileSync(lock, JSON.stringify({ version: 1, pid: process.pid, nonce: 'foreign-live' }));
      expect(() => withCoreConfigWriteLock(config, () => undefined)).toThrow(CoreConfigWriteConflictError);
    } finally { fault.mockRestore(); syncBuiltinESMExports(); remove(home, { recursive: true, force: true }); }
  });
  it('never transfers an interrupted reclamation claim to another writer', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'kodax-core-claim-'));
    const config = path.join(home, 'config.json'), lock = coreConfigWriteLockPath(config);
    try {
      writeFileSync(lock, JSON.stringify({ version: 1, pid: 2_146_999_999, nonce: 'retired' }));
      expect(claimConfigLockReclamation(lock, 'retired')).toBe(true);
      expect(() => withCoreConfigWriteLock(config, () => undefined)).toThrow(CoreConfigWriteConflictError);
      expect(JSON.parse(readFileSync(lock, 'utf8')).nonce).toBe('retired');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
  it('recovers a dead writer once while retaining unknown locks and replacement owners', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'kodax-core-dead-lock-'));
    const config = path.join(home, 'config.json'), lock = coreConfigWriteLockPath(config);
    const deadPid = 2_146_999_999;
    expect(() => process.kill(deadPid, 0)).toThrow();
    try {
      writeFileSync(lock, JSON.stringify({ version: 1, pid: deadPid, nonce: 'dead-fixture' }));
      expect(withCoreConfigWriteLock(config, () => {
        const owner = JSON.parse(readFileSync(lock, 'utf8')) as { pid: number; nonce: string };
        expect(owner.pid).toBe(process.pid);
        expect(owner.nonce).not.toBe('dead-fixture');
        expect(() => withCoreConfigWriteLock(config, () => undefined)).toThrow(CoreConfigWriteConflictError);
        return 'recovered';
      })).toBe('recovered');
      writeFileSync(lock, '');
      expect(() => withCoreConfigWriteLock(config, () => undefined)).toThrow(CoreConfigWriteConflictError);
      expect(readFileSync(lock, 'utf8')).toBe('');
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
  it('serializes cooperating core-config writers and releases the lock', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'kodax-core-lock-'));
    const configPath = path.join(home, 'config.json');
    const lockPath = coreConfigWriteLockPath(configPath);
    const lock = openSync(lockPath, 'wx');
    try {
      expect(() => withCoreConfigWriteLock(configPath, () => undefined))
        .toThrow(CoreConfigWriteConflictError);
    } finally {
      closeSync(lock);
      rmSync(lockPath, { force: true });
    }

    expect(withCoreConfigWriteLock(configPath, () => 'written')).toBe('written');
    const released = openSync(lockPath, 'wx');
    closeSync(released);
    rmSync(home, { recursive: true, force: true });
  });
});
