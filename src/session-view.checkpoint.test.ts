import { expect, it } from 'vitest';
import { SessionViewOwner } from './session-view.js';

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
