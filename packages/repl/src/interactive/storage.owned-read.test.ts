import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { FileSessionStorage, type SessionReadOptions } from './storage.js';

it.each(['read', 'readFullSnapshot'] as const)('rejects invalid %s budgets without an orphaned rejection', async method => {
  const storage = new FileSessionStorage({ sessionsDir: path.join(os.tmpdir(), 'kodax-invalid-read') });
  const unhandled = vi.fn();
  process.on('unhandledRejection', unhandled);
  try {
    await expect(storage[method]('invalid', { timeoutMs: 0 })).rejects.toThrow('positive safe integer');
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(unhandled).not.toHaveBeenCalled();
  } finally { process.off('unhandledRejection', unhandled); }
});

async function heldWrite() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-owned-read-'));
  const sessionsDir = path.join(root, 'sessions');
  const storage = new FileSessionStorage({ sessionsDir });
  const data = { messages: [{ role: 'user' as const, content: 'saved' }], title: 'before', gitRoot: root };
  await storage.save('owned-read', data);
  let enter!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const rename = fs.rename.bind(fs);
  const probe = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (String(to).endsWith(`${path.sep}owned-read.jsonl`)) {
      enter();
      await gate;
    }
    return rename(from, to);
  });
  const writing = storage.save('owned-read', { ...data, title: 'after' });
  await entered;
  return { storage, sessionsDir, release, writing, async close() {
    release();
    try { await writing; }
    finally {
      probe.mockRestore();
      expect(path.dirname(root)).toBe(path.resolve(os.tmpdir()));
      await fs.rm(root, { recursive: true, force: true });
    }
  } };
}

it('waits for its own in-flight write before taking a strict read, retaining foreign-writer rejection', async () => {
  const f = await heldWrite();
  let settled = false;
  const result = f.storage.read('owned-read').then(
    data => { settled = true; return { data }; },
    error => { settled = true; return { error }; },
  );
  try {
    // This is a real held storage write. A separate reader has no ownership
    // evidence and must keep the existing strict boundary rejection.
    await expect(new FileSessionStorage({ sessionsDir: f.sessionsDir }).read('owned-read'))
      .rejects.toMatchObject({ code: 'data_changed' });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(settled).toBe(false);
    f.release();
    await f.writing;
    expect(await result).toMatchObject({ data: { title: 'after' } });
  } finally { await f.close(); }
});

it('waits for its own in-flight write before capturing a stable full snapshot', async () => {
  const f = await heldWrite();
  let settled = false;
  const result = f.storage.readFullSnapshot('owned-read').then(
    snapshot => { settled = true; return { snapshot }; },
    error => { settled = true; return { error }; },
  );
  try {
    await expect(new FileSessionStorage({ sessionsDir: f.sessionsDir }).readFullSnapshot('owned-read'))
      .rejects.toMatchObject({ code: 'data_changed' });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(settled).toBe(false);
    f.release();
    await f.writing;
    expect(await result).toMatchObject({ snapshot: { data: { title: 'after' } } });
  } finally { await f.close(); }
});

it.each(['read', 'readFullSnapshot'] as const)('honors timeout and cancellation while %s waits for its writer', async method => {
  const f = await heldWrite();
  const controller = new AbortController();
  const read = (options: SessionReadOptions) => f.storage[method]('owned-read', options);
  try {
    await expect(read({ timeoutMs: 20 })).rejects.toMatchObject({ code: 'read_timeout' });
    const cancelled = read({ signal: controller.signal });
    const rejected = expect(cancelled).rejects.toMatchObject({ code: 'read_cancelled' });
    controller.abort();
    await rejected;
    f.release();
    await f.writing;
    await expect(read({})).resolves.toBeTruthy();
  } finally { await f.close(); }
});

it('keeps the last committed data readable after an owned write fails', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-owned-read-'));
  const storage = new FileSessionStorage({ sessionsDir: path.join(root, 'sessions') });
  const data = { messages: [], title: 'committed', gitRoot: root };
  await storage.save('failed-read', data);
  const failure = new Error('Controlled commit failure');
  const rename = fs.rename.bind(fs);
  const probe = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (String(to).endsWith(`${path.sep}failed-read.jsonl`)) throw failure;
    return rename(from, to);
  });
  try {
    await expect(storage.save('failed-read', { ...data, title: 'uncommitted' })).rejects.toBe(failure);
    probe.mockRestore();
    await expect(storage.read('failed-read')).resolves.toMatchObject({ title: 'committed' });
  } finally {
    probe.mockRestore();
    expect(path.dirname(root)).toBe(path.resolve(os.tmpdir()));
    await fs.rm(root, { recursive: true, force: true });
  }
});

it.each(['read', 'readFullSnapshot'] as const)('waits for a second owned write queued while %s is waiting', async method => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kodax-owned-read-'));
  const storage = new FileSessionStorage({ sessionsDir: path.join(root, 'sessions') });
  const data = { messages: [], title: 'before', gitRoot: root };
  await storage.save('queued-read', data);
  const gates = Array.from({ length: 2 }, () => {
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    return { entered, wait, enter, release };
  });
  const rename = fs.rename.bind(fs);
  let commit = 0;
  const probe = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (String(to).endsWith(`${path.sep}queued-read.jsonl`)) {
      const gate = gates[commit++];
      if (gate) { gate.enter(); await gate.wait; }
    }
    return rename(from, to);
  });
  const first = storage.save('queued-read', { ...data, title: 'first' });
  let second: Promise<void> | undefined;
  try {
    await gates[0]!.entered;
    let settled = false;
    const reading = (method === 'read' ? storage.read('queued-read')
      : storage.readFullSnapshot('queued-read').then(snapshot => snapshot?.data)).then(
      value => { settled = true; return { value }; },
      error => { settled = true; return { error }; },
    );
    second = storage.save('queued-read', { ...data, title: 'second' });
    gates[0]!.release();
    await gates[1]!.entered;
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(settled).toBe(false);
    gates[1]!.release();
    await second;
    expect(await reading).toMatchObject({ value: { title: 'second' } });
  } finally {
    for (const gate of gates) gate.release();
    try { await Promise.all([first, second]); }
    finally {
      probe.mockRestore();
      expect(path.dirname(root)).toBe(path.resolve(os.tmpdir()));
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});
