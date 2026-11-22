/**
 * The REPL's session commands over v2, against a real Host with a scripted model.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { disposeReplHosts, replHost } from '../../tests/repl-v2-host.js';
import { createRequestId } from '../host-protocol/host-client.js';
import { createReplSessionBindings } from './sessions.js';

afterEach(disposeReplHosts, 60_000);

async function hostWithTurns(turns: number) {
  const host = await replHost('answer');
  for (let turn = 0; turn < turns; turn += 1) {
    const accepted = await host.plane.submit({ sessionId: host.sessionId, text: `turn ${turn}`, inputId: createRequestId() });
    await host.plane.awaitRun(host.sessionId, accepted.runId!);
  }
  return { ...host, ...createReplSessionBindings(host.client, async () => undefined) };
}

describe('the REPL session commands over v2', () => {
  it('lists, reads and creates Sessions in the shapes the REPL reads', async () => {
    const { sessions, sessionId } = await hostWithTurns(1);
    const created = await sessions.create({ title: 'Draft', surface: 'repl' });
    expect(created).not.toBe(sessionId);

    const listed = await sessions.list!({ scope: 'user', limit: Number.MAX_SAFE_INTEGER });
    // The draft holds no input yet, so it is not saved and not listed.
    expect(listed.map(session => session.id)).toEqual([sessionId]);
    expect(listed[0]!.msgCount).toBeGreaterThan(0);
    expect(await sessions.read!(sessionId)).toMatchObject({ id: sessionId, title: 'REPL' });
    expect(await sessions.getSettings!(sessionId)).toEqual(expect.any(Object));
    await expect(sessions.list!({ scope: 'all' })).rejects.toThrow(/task workers/);
  });

  it('reads the tree, labels an entry and moves between branches', async () => {
    const { sessions, sessionId } = await hostWithTurns(2);
    const tree = (await sessions.readLineage!(sessionId))!;
    const messages = tree.entries.filter(entry => entry.type === 'message');
    expect(messages.map(entry => entry.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(tree.activeEntryId).toBe(messages.at(-1)!.id);
    expect(messages[1]!.parentId).toBe(messages[0]!.id);
    expect(Date.parse(messages[0]!.timestamp)).toBeGreaterThan(0);

    expect(await sessions.setLabel({ sessionId, selector: messages[1]!.id, label: 'first' })).toBe(true);
    expect(await sessions.setLabel({ sessionId, selector: 'no-such-entry', label: 'x' })).toBe(false);
    expect(await sessions.setActiveEntry({ sessionId, selector: 'first' })).toBe(true);
    expect((await sessions.readLineage!(sessionId))!.activeEntryId).toBe(messages[1]!.id);
    expect(await sessions.setActiveEntry({ sessionId, selector: 'no-such-entry' })).toBe(false);
  });

  it('takes back the newest turn when no place is named, and refuses when there is no turn before', async () => {
    const { sessions, sessionId } = await hostWithTurns(2);
    expect(await sessions.rewind({ sessionId })).toBe(true);
    const after = (await sessions.readLineage!(sessionId))!;
    const kept = after.entries.filter(entry => entry.type === 'message');
    expect(after.activeEntryId).toBe(kept[1]!.id);
    expect(await sessions.rewind({ sessionId })).toBe(false);
  });

  it('names the newest turn again when the Session is written between naming and taking it back', async () => {
    // A Run's memory review writes the Session for a while after the Run ends. A label stands in for it here:
    // it changes the Session without moving its head.
    const host = await hostWithTurns(2);
    let writes = 0;
    const racing = {
      ...host.client,
      call: (async (method: string, params?: unknown) => {
        if (method === 'session.rewind' && writes < 2) {
          writes += 1;
          const tree = (await host.sessions.readLineage!(host.sessionId))!;
          await host.client.call('session.lineage.label', {
            requestId: createRequestId(), sessionId: host.sessionId, entry: tree.activeEntryId!, label: `write-${writes}`,
          });
        }
        return (host.client.call as (method: string, params?: unknown) => Promise<unknown>)(method, params);
      }) as typeof host.client.call,
    };
    const { sessions } = createReplSessionBindings(racing, async () => undefined);
    expect(await sessions.rewind({ sessionId: host.sessionId })).toBe(true);
    expect(writes).toBe(2);
    const kept = (await sessions.readLineage!(host.sessionId))!.entries.filter(entry => entry.type === 'message');
    expect((await sessions.readLineage!(host.sessionId))!.activeEntryId).toBe(kept[1]!.id);
  });

  it('rewinds to a named entry only from the head it was read at', async () => {
    const { sessions, sessionId } = await hostWithTurns(2);
    const tree = (await sessions.readLineage!(sessionId))!;
    const first = tree.entries.filter(entry => entry.type === 'message')[1]!;
    expect(await sessions.rewind({ sessionId, selector: 'no-such-entry', expectedHead: tree.activeEntryId })).toBe(false);
    expect(await sessions.rewind({ sessionId, selector: first.id, expectedHead: tree.activeEntryId })).toBe(true);
    expect((await sessions.readLineage!(sessionId))!.activeEntryId).toBe(first.id);
  });

  it('forks, recovers and deletes', async () => {
    const { sessions, sessionId } = await hostWithTurns(1);
    const forked = await sessions.fork({ sessionId });
    const recovered = await sessions.recover({ sessionId, reason: 'too long' });
    expect(new Set([sessionId, forked, recovered]).size).toBe(3);
    expect((await sessions.read!(forked!)).msgCount).toBeGreaterThan(0);

    await sessions.deleteAll({});
    expect(await sessions.list!({})).toEqual([]);
  });

  it('keeps the goal of a Session', async () => {
    const { goal, sessionId } = await hostWithTurns(1);
    expect(await goal.read(sessionId)).toBeNull();
    expect(await goal.create({ sessionId, objective: 'Ship it', tokenBudget: 1_000 }))
      .toMatchObject({ version: 1, objective: 'Ship it', status: 'active', tokenBudget: 1_000, lastBlockerKind: null });
    expect((await goal.pause(sessionId)).status).toBe('paused');
    expect((await goal.resume(sessionId)).status).toBe('active');
    await goal.clear(sessionId);
    expect(await goal.read(sessionId)).toBeNull();
  });

  it('compacts with the leases the CLI lends', async () => {
    const host = await hostWithTurns(1);
    const asked: unknown[] = [];
    const { compact } = createReplSessionBindings(host.client, async (request) => { asked.push(request); return undefined; });
    const result = await compact.compact({ sessionId: host.sessionId, customInstructions: '  ' });
    expect(result).toEqual({ compacted: expect.any(Boolean), tokensBefore: expect.any(Number), tokensAfter: expect.any(Number) });
    expect(asked).toEqual([{ kind: 'compaction', input: { sessionId: host.sessionId } }]);
  });
});
