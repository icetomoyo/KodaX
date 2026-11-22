/**
 * The REPL's client plane over v2, against a real Host with a scripted model.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readClientItemRange } from '@kodax-ai/coding';

import { readClientPlaneHistory } from '../../packages/repl/src/ui/client-plane.js';
import { disposeReplHosts, LONG_REPLY, MODEL, replHost, viewWhere } from '../../tests/repl-v2-host.js';
import { createRequestId } from '../host-protocol/host-client.js';
import { createReplLeases } from './leases.js';

afterEach(disposeReplHosts, 60_000);

describe('the REPL client plane over v2', () => {
  it('submits an input, follows its Run to the end and reads the whole reply', async () => {
    const { plane, sessionId } = await replHost('answer');
    const accepted = await plane.submit({ sessionId, text: 'hello', inputId: createRequestId() });
    expect(accepted.state).toBe('submitted');
    const outcome = await plane.awaitRun(sessionId, accepted.runId!);
    expect(outcome).toMatchObject({ phase: 'completed', result: { success: true, sessionId } });
    expect(await plane.activeRun(sessionId)).toBeUndefined();

    const view = await viewWhere(plane, sessionId, current => current.items.some(item => item.type === 'assistant'));
    const reply = view.items.find(item => item.type === 'assistant')!;
    expect(view.items.find(item => item.type === 'user')).toMatchObject({ text: 'hello' });
    expect(reply).toMatchObject({ outputState: 'committed', textRevision: 0, totalTextLength: LONG_REPLY.length });
    expect(reply.textOffset).toBeGreaterThan(0);

    // The REPL reads the omitted start of a long reply from the Host, page by page, at the version it saw.
    const close = await plane.observe(sessionId, () => undefined);
    try {
      const whole = await readClientItemRange(offset => plane.readItem(sessionId, reply.id, { offset }), reply.id,
        { length: LONG_REPLY.length, version: { textRevision: 0, outputState: 'committed' } });
      expect(whole).toBe(LONG_REPLY);
      const middle = await plane.readItem(sessionId, reply.id, { offset: 5 });
      expect(middle).toMatchObject({ id: reply.id, offset: 5, totalLength: LONG_REPLY.length });
      expect(middle!.text.startsWith(LONG_REPLY.slice(5, 20))).toBe(true);
    } finally {
      close();
    }

    const history = await readClientPlaneHistory(plane, sessionId);
    expect(history.map(item => item.type)).toEqual(expect.arrayContaining(['user', 'assistant']));
    expect(history.find(item => item.type === 'assistant')).toMatchObject({ text: LONG_REPLY });
  });

  it('shows a question the model asks and takes the first answer only', async () => {
    const { plane, sessionId } = await replHost('ask');
    const accepted = await plane.submit({ sessionId, text: 'pick', inputId: createRequestId() });
    const view = await viewWhere(plane, sessionId, current => current.interactions.length > 0);
    const [question] = view.interactions;
    expect(question).toMatchObject({ sessionId, runId: accepted.runId, kind: 'question' });
    expect(typeof question!.createdAt).toBe('string');
    expect(await plane.respondInteraction(question!.requestId, { kind: 'question', answer: 'red' })).toBe(true);
    expect(await plane.respondInteraction(question!.requestId, { kind: 'question', answer: 'blue' })).toBe(false);
    expect(await plane.awaitRun(sessionId, accepted.runId!)).toMatchObject({ phase: 'completed' });
  });

  it('stops the Session\'s Run and reports what the Host recorded', async () => {
    const { plane, sessionId } = await replHost('hold');
    const accepted = await plane.submit({ sessionId, text: 'wait', inputId: createRequestId() });
    await viewWhere(plane, sessionId, current => current.runs.some(run => run.phase === 'running'));
    expect(await plane.activeRun(sessionId)).toBe(accepted.runId);
    const receipt = await plane.cancelSession({ sessionId, expectedRunId: accepted.runId!, requestId: createRequestId() });
    expect(receipt.receipts).toEqual([expect.objectContaining({ runId: accepted.runId, accepted: true })]);
    const outcome = await plane.awaitRun(sessionId, accepted.runId!);
    expect(['cancelled', 'interrupted']).toContain(outcome.phase);
    expect(outcome.error).toBeUndefined();
    expect(await plane.stop(accepted.runId!)).toMatchObject({ runId: accepted.runId, state: 'confirmed' });
  });

  it('changes settings v2 knows, leaving out the ones effort replaced, and keeps notices and side chats', async () => {
    const { client, plane, sessionId } = await replHost('answer');
    await plane.updateSettings!(sessionId, { permissionMode: 'plan', reasoningMode: 'deep', thinking: true });
    expect((await client.call('session.settings.get', { sessionId })).settings.permissionMode).toBe('plan');
    await plane.appendNotice!(sessionId, { content: 'Saved by /test', source: 'test' });
    const view = await viewWhere(plane, sessionId, current => current.items.some(item => item.text.includes('Saved by /test')));
    expect(view.session.id).toBe(sessionId);
    const side = await plane.openSide!(sessionId);
    expect(side.id).not.toBe(sessionId);
    await expect(plane.delete!(side.id)).resolves.toBeUndefined();
  });
});

describe('the leases the REPL lends a v2 Host', () => {
  it('registers a credential lease with the Host and names it for the Run', async () => {
    const { client } = await replHost('answer');
    const leases = createReplLeases(client, async (_request, services) => {
      expect(services.identity.runtimeId).toBe(client.handshake.host.id);
      const lease = await services.credentials.registerScoped({ providers: [MODEL] }, async () => ({ credential: 'key' }) as never);
      return { credential: { leaseId: lease.id, mode: 'scoped', providers: [MODEL] } };
    });
    const leased = await leases({ kind: 'compaction', input: { sessionId: 'any' } });
    expect(leased).toEqual({ credential: expect.any(String) });
  });

  it('lends nothing when the CLI has no keys to lend, and refuses grants v2 cannot carry', async () => {
    const { client } = await replHost('answer');
    expect(await createReplLeases(client, async () => undefined)({ kind: 'compaction', input: { sessionId: 'any' } }))
      .toBeUndefined();
    const granting = createReplLeases(client, async () => ({ tools: ['read'] }));
    await expect(granting({ kind: 'compaction', input: { sessionId: 'any' } })).rejects.toThrow(/takes no tools/);
  });
});
