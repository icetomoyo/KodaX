import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  copyKodaXDataRoot,
  KODAX_DATA_ROOT_COPY_MARKER,
  KodaXDataRootCopyError,
  type CopyKodaXDataRootProgress,
} from './data-root-copy.js';

const DEAD_PID = 2_147_483_647;
const scratch: string[] = [];

afterEach(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function workspace(): { from: string; to: string; put: (relative: string, content?: string) => void } {
  const base = mkdtempSync(path.join(os.tmpdir(), 'kodax-root-copy-'));
  scratch.push(base);
  const from = path.join(base, 'source', '.kodax');
  mkdirSync(from, { recursive: true });
  const put = (relative: string, content = relative): void => {
    const file = path.join(from, ...relative.split('/'));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  };
  return { from, to: path.join(base, 'target', '.kodax'), put };
}

function files(root: string, prefix = ''): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    return entry.isDirectory() ? files(path.join(root, entry.name), relative) : [relative];
  }).sort();
}

function snapshot(root: string): Record<string, string> {
  return Object.fromEntries(files(root).map((relative) => [relative, readFileSync(path.join(root, ...relative.split('/')), 'utf8')]));
}

function lock(pid: number): string {
  return JSON.stringify({ runtimeId: 'rt_0123456789ab', pid, createdAt: new Date().toISOString(), kind: 'daemon' });
}

function seedPortableAndHostState(put: (relative: string, content?: string) => void): void {
  for (const portable of [
    'config.json', 'auth.json', 'sessions/a.jsonl', 'skills/demo/SKILL.md',
    'runtime/agents/registrations.json', 'runtime/profiles/default/runs/r1/status.json',
  ]) put(portable);
  for (const hostState of [
    'runtime/daemon/default/daemon.json', 'runtime/daemon/default/daemon.token',
    'runtime/daemon/default/client-exits/abc/receipt.json', 'runtime/processes/children/1.json',
    'sessions/.product-host/startup.lock', 'instances/123/state.json',
    'sandbox-runtime/acl-poison/x.json', 'native-text-state-v1/artifacts-v1/a',
    'runtime/construction-budget-locks/hash.lock', 'sessions/b.jsonl.lock',
  ]) put(hostState);
  put('space/runtime-client-identity.json');
}

describe('copyKodaXDataRoot', () => {
  it('copies portable data and reports every excluded entry', async () => {
    const { from, to, put } = workspace();
    seedPortableAndHostState(put);
    const result = await copyKodaXDataRoot({ from, to, exclude: ['space/runtime-client-identity.json'] });
    expect(files(to)).toEqual([
      'auth.json', 'config.json', 'runtime/agents/registrations.json',
      'runtime/profiles/default/runs/r1/status.json', 'sessions/a.jsonl', 'skills/demo/SKILL.md',
    ]);
    expect(result.files).toBe(6);
    expect(result.bytes).toBeGreaterThan(0);
    expect(Object.fromEntries(result.skipped.map((entry) => [entry.path, entry.reason]))).toEqual({
      'runtime/daemon': 'non-portable',
      'runtime/processes': 'non-portable',
      'sessions/.product-host': 'non-portable',
      instances: 'non-portable',
      'sandbox-runtime': 'non-portable',
      'native-text-state-v1': 'non-portable',
      'runtime/construction-budget-locks/hash.lock': 'non-portable',
      'sessions/b.jsonl.lock': 'non-portable',
      'space/runtime-client-identity.json': 'excluded',
    });
  });

  it('reports progress with totals known up front and ending complete', async () => {
    const { from, to, put } = workspace();
    seedPortableAndHostState(put);
    const events: CopyKodaXDataRootProgress[] = [];
    await copyKodaXDataRoot({ from, to, onProgress: (progress) => events.push(progress) });
    const last = events.at(-1);
    expect(events.length).toBeGreaterThan(0);
    expect(last).toMatchObject({ files: 7, totalFiles: 7 });
    expect(last?.bytes).toBe(last?.totalBytes);
    expect(events.every((event) => event.totalFiles === 7)).toBe(true);
  });

  it('refuses a non-empty target and leaves it and the source untouched', async () => {
    const { from, to, put } = workspace();
    put('config.json');
    mkdirSync(to, { recursive: true });
    writeFileSync(path.join(to, 'keep.txt'), 'mine');
    await expect(copyKodaXDataRoot({ from, to })).rejects.toMatchObject({ code: 'target_not_empty' });
    expect(files(to)).toEqual(['keep.txt']);
  });

  it('accepts an existing empty target directory', async () => {
    const { from, to, put } = workspace();
    put('config.json');
    mkdirSync(to, { recursive: true });
    await copyKodaXDataRoot({ from, to });
    expect(files(to)).toEqual(['config.json']);
  });

  it('accepts a target holding only OS housekeeping files and keeps them', async () => {
    const { from, to, put } = workspace();
    put('config.json');
    mkdirSync(to, { recursive: true });
    writeFileSync(path.join(to, '.DS_Store'), '');
    writeFileSync(path.join(to, 'desktop.ini'), '');
    await copyKodaXDataRoot({ from, to });
    expect(files(to)).toEqual(['.DS_Store', 'config.json', 'desktop.ini']);
  });

  it('marks the target incomplete until the copy is published', async () => {
    const { from, to, put } = workspace();
    put('a.json');
    put('b.json');
    const marked: boolean[] = [];
    await copyKodaXDataRoot({ from, to, onProgress: () => marked.push(existsSync(path.join(to, KODAX_DATA_ROOT_COPY_MARKER))) });
    expect(marked).toEqual([true, true]);
    expect(existsSync(path.join(to, KODAX_DATA_ROOT_COPY_MARKER))).toBe(false);
  });

  it.each([
    ['target is the source', (from: string) => from],
    ['target is inside the source', (from: string) => path.join(from, 'nested')],
    ['target contains the source', (from: string) => path.dirname(from)],
  ])('refuses nested roots when the %s', async (_name, target) => {
    const { from, put } = workspace();
    put('config.json');
    await expect(copyKodaXDataRoot({ from, to: target(from) })).rejects.toMatchObject({ code: 'nested_roots' });
  });

  it('refuses a missing source', async () => {
    const { from, to } = workspace();
    await expect(copyKodaXDataRoot({ from: path.join(from, 'missing'), to })).rejects.toMatchObject({ code: 'source_missing' });
  });

  it('refuses while a Host owns the source and allows a dead owner', async () => {
    const { from, to, put } = workspace();
    put('config.json');
    put('runtime/daemon/default/daemon.lock', lock(process.pid));
    await expect(copyKodaXDataRoot({ from, to })).rejects.toMatchObject({ code: 'host_running' });
    expect(existsSync(to)).toBe(false);
    put('runtime/daemon/default/daemon.lock', lock(DEAD_PID));
    await expect(copyKodaXDataRoot({ from, to })).resolves.toMatchObject({ files: 1 });
  });

  it('refuses while a legacy-slot Host or the Session storage owner is alive', async () => {
    const { from, to, put } = workspace();
    put('config.json');
    put('runtime/daemon/coder/daemon.lock', lock(process.pid));
    await expect(copyKodaXDataRoot({ from, to })).rejects.toMatchObject({ code: 'host_running' });
    rmSync(path.join(from, 'runtime'), { recursive: true });
    put('sessions/.product-host/owner.lock', lock(process.pid));
    await expect(copyKodaXDataRoot({ from, to })).rejects.toMatchObject({ code: 'host_running' });
  });

  it('never modifies the source', async () => {
    const { from, to, put } = workspace();
    seedPortableAndHostState(put);
    const before = snapshot(from);
    const mtime = lstatSync(path.join(from, 'sessions', 'a.jsonl')).mtimeMs;
    await copyKodaXDataRoot({ from, to });
    expect(snapshot(from)).toEqual(before);
    expect(lstatSync(path.join(from, 'sessions', 'a.jsonl')).mtimeMs).toBe(mtime);
  });

  it('preserves file modification times in the copy', async () => {
    const { from, to, put } = workspace();
    put('sessions/a.jsonl');
    const old = new Date('2024-01-02T03:04:05Z');
    const { utimesSync } = await import('node:fs');
    utimesSync(path.join(from, 'sessions', 'a.jsonl'), old, old);
    await copyKodaXDataRoot({ from, to });
    expect(lstatSync(path.join(to, 'sessions', 'a.jsonl')).mtimeMs).toBe(old.getTime());
  });

  it('skips links instead of following them out of the root', async () => {
    const { from, to, put } = workspace();
    put('config.json');
    const outside = path.join(path.dirname(path.dirname(from)), 'outside');
    mkdirSync(outside);
    writeFileSync(path.join(outside, 'secret.txt'), 'secret');
    symlinkSync(outside, path.join(from, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    const result = await copyKodaXDataRoot({ from, to });
    expect(files(to)).toEqual(['config.json']);
    expect(result.skipped).toEqual([{ path: 'linked', reason: 'symlink' }]);
  });

  it('cleans up when aborted and leaves no target or temporary copy', async () => {
    const { from, to, put } = workspace();
    put('a.json');
    put('b.json');
    const controller = new AbortController();
    await expect(copyKodaXDataRoot({ from, to, signal: controller.signal, onProgress: () => controller.abort() }))
      .rejects.toMatchObject({ code: 'aborted' });
    expect(existsSync(to)).toBe(false);
  });

  it('cleans up and rethrows when the copy fails midway', async () => {
    const { from, to, put } = workspace();
    put('a.json');
    put('b.json');
    const failure = new Error('disk full');
    await expect(copyKodaXDataRoot({ from, to, onProgress: () => { throw failure; } })).rejects.toBe(failure);
    expect(existsSync(to)).toBe(false);
  });

  it('empties but keeps a target directory that existed before a failed copy', async () => {
    const { from, to, put } = workspace();
    put('a.json');
    put('b.json');
    mkdirSync(to, { recursive: true });
    writeFileSync(path.join(to, 'desktop.ini'), 'folder view');
    await expect(copyKodaXDataRoot({ from, to, onProgress: () => { throw new Error('disk full'); } })).rejects.toThrow('disk full');
    expect(files(to)).toEqual(['desktop.ini']);
  });

  it('refuses to publish when a Host claimed the source during the copy', async () => {
    const { from, to, put } = workspace();
    put('a.json');
    await expect(copyKodaXDataRoot({
      from, to,
      onProgress: () => put('runtime/daemon/default/daemon.lock', lock(process.pid)),
    })).rejects.toMatchObject({ code: 'host_running' });
    expect(existsSync(to)).toBe(false);
  });

  it('replaces an interrupted copy left by a crashed run', async () => {
    const { from, to, put } = workspace();
    put('a.json');
    put('b.json');
    mkdirSync(path.join(to, 'sessions'), { recursive: true });
    writeFileSync(path.join(to, KODAX_DATA_ROOT_COPY_MARKER), '');
    writeFileSync(path.join(to, 'sessions', 'stale.jsonl'), 'left by a crashed run');
    const result = await copyKodaXDataRoot({ from, to });
    expect(files(to)).toEqual(['a.json', 'b.json']);
    expect(result.files).toBe(2);
  });

  it('never touches a sibling folder that happens to share the old temporary name', async () => {
    const { from, to, put } = workspace();
    put('a.json');
    mkdirSync(`${to}.copying`, { recursive: true });
    writeFileSync(path.join(`${to}.copying`, 'mine.txt'), 'user data');
    await copyKodaXDataRoot({ from, to });
    expect(files(`${to}.copying`)).toEqual(['mine.txt']);
  });

  it('uses a typed error', async () => {
    const { from, to } = workspace();
    const error = await copyKodaXDataRoot({ from: path.join(from, 'missing'), to }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(KodaXDataRootCopyError);
  });
});
