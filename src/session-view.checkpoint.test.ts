import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { FileSessionStorage } from '@kodax-ai/repl';
import { SessionViewOwner } from './session-view.js';

it.each([false, true])('drains an in-flight view read before close permits removal of its storage root (released=%s)', async released => {
  const root = await mkdtemp(path.join(tmpdir(), 'kodax-view-close-read-'));
  const sessionsDir = path.join(root, '.kodax', 'sessions');
  const storage = new FileSessionStorage({ sessionsDir, configHome: path.join(root, '.kodax'), cwd: root });
  let releaseRead!: () => void;
  const held = new Promise<void>(resolve => { releaseRead = resolve; });
  let enterRead!: () => void;
  const entered = new Promise<void>(resolve => { enterRead = resolve; });
  let finishRead!: () => void;
  const finished = new Promise<void>(resolve => { finishRead = resolve; });
  let reads = 0;
  let readFailure: unknown;
  const owner = new SessionViewOwner(async sessionId => {
    if (++reads === 2) {
      enterRead();
      try {
        await held;
        await storage.load('missing-session');
      } catch (error: unknown) { readFailure = error; }
      finally { finishRead(); }
    }
    return { session: { id: sessionId, title: 'Closing read' }, settings: {}, items: [], queue: [], interactions: [], runs: [] };
  }, async () => undefined);
  let closing: Promise<void> | undefined;
  try {
    const observation = await owner.observe('session', () => undefined);
    owner.changed('session', true);
    await entered;
    observation.close();
    if (released) owner.release('session');
    let closeReturns = 0;
    const secondClose = owner.close().then(() => { closeReturns += 1; });
    closing = owner.close().then(async () => {
      closeReturns += 1;
      await rm(root, { recursive: true, force: true });
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    const returnedWhileReadHeld = closeReturns > 0;
    if (returnedWhileReadHeld) await closing;
    releaseRead();
    await finished;
    await Promise.all([closing, secondClose]);
    expect(closeReturns).toBe(2);
    expect(readFailure).toBeUndefined();
    expect({ returnedWhileReadHeld, rootRecreated: existsSync(root),
      indexRecreated: existsSync(path.join(sessionsDir, '.location-index')) }).toEqual({
      returnedWhileReadHeld: false, rootRecreated: false, indexRecreated: false,
    });
  } finally {
    releaseRead();
    await Promise.allSettled([owner.close(), ...(closing ? [closing] : [])]);
    await rm(root, { recursive: true, force: true });
  }
});

it('does not publish or requeue an observation whose read finishes after closing starts', async () => {
  let releaseRead!: () => void;
  const held = new Promise<void>(resolve => { releaseRead = resolve; });
  let enterRead!: () => void;
  const entered = new Promise<void>(resolve => { enterRead = resolve; });
  let reads = 0;
  let views = 0;
  const owner = new SessionViewOwner(async sessionId => {
    reads += 1;
    enterRead();
    await held;
    return { session: { id: sessionId, title: 'Closing observe' }, settings: {}, items: [], queue: [], interactions: [], runs: [] };
  }, async () => undefined);
  const observing = owner.observe('session', () => { views += 1; }).catch((error: unknown) => error);
  try {
    await entered;
    const closing = owner.close();
    owner.resetHistory('session');
    releaseRead();
    await closing;
    expect(await observing).toBeInstanceOf(Error);
    expect(views).toBe(0);
    expect(reads).toBe(1);
    await expect(owner.observe('late', () => undefined)).rejects.toThrow('closed');
  } finally { releaseRead(); await owner.close(); }
});

it('waits for an admitted committed-item read before closing', async () => {
  let releaseRead!: () => void;
  const held = new Promise<void>(resolve => { releaseRead = resolve; });
  let enterRead!: () => void;
  const entered = new Promise<void>(resolve => { enterRead = resolve; });
  const owner = new SessionViewOwner(async sessionId => ({
    session: { id: sessionId, title: 'Closing item' }, settings: {}, items: [], queue: [], interactions: [], runs: [],
  }), async () => undefined, async () => { enterRead(); await held; return null; });
  const reading = owner.readItem('session', 'missing-item');
  try {
    await entered;
    let closed = false;
    const closing = owner.close().then(() => { closed = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    const returnedWhileReadHeld = closed;
    releaseRead();
    await closing;
    await expect(reading).resolves.toBeNull();
    expect(returnedWhileReadHeld).toBe(false);
    await expect(owner.readItem('session', 'late-item')).rejects.toThrow('closed');
  } finally { releaseRead(); await Promise.allSettled([reading, owner.close()]); }
});

it.each([new Error('Checkpoint failed'), undefined])('retains settled checkpoint rejection %s for late flush and close', async failure => {
  const owner = new SessionViewOwner(async sessionId => ({
    session: { id: sessionId, title: 'Checkpoint' }, settings: {}, items: [], queue: [], interactions: [], runs: [],
  }), async () => { throw failure; });
  const statuses: string[] = [];
  await owner.observe('session', () => undefined, { onStatus: status => statuses.push(status.state) });
  owner.events('session', 'run');
  owner.checkpoint('session');
  await new Promise<void>(resolve => setImmediate(resolve));
  await expect(owner.flush('session')).rejects.toBe(failure);
  await expect(owner.flush('session')).rejects.toBe(failure);
  await expect(owner.close()).rejects.toBe(failure);
  expect(statuses).toEqual(['live', 'closed']);
  await expect(owner.close()).resolves.toBeUndefined();
});

it('rejects history refresh after a settled save failure and recovers only after the same session saves', async () => {
  const failure = new Error('Checkpoint unavailable');
  let failSave = true;
  let reads = 0;
  const owner = new SessionViewOwner(async sessionId => {
    reads += 1;
    return { session: { id: sessionId, title: 'Checkpoint' }, settings: {}, items: [], queue: [], interactions: [], runs: [] };
  }, async sessionId => { if (sessionId === 'failed' && failSave) throw failure; });
  owner.events('failed', 'run');
  owner.checkpoint('failed');
  await new Promise<void>(resolve => setImmediate(resolve));
  try {
    await expect(owner.observe('failed', () => undefined)).rejects.toBe(failure);
    expect(reads).toBe(0);
    owner.events('other', 'other-run');
    owner.checkpoint('other');
    await owner.flush('other');
    await expect(owner.flush('failed')).rejects.toBe(failure);
    failSave = false;
    owner.checkpoint('failed');
    await owner.flush('failed');
    const observation = await owner.observe('failed', () => undefined);
    expect(reads).toBe(1);
    observation.close();
  } finally { await Promise.allSettled([owner.close()]); }
});
