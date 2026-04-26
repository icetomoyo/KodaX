/**
 * Contract test for CAP-020: extensionRuntime per-turn queued message consumption
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-020-extensionruntime-per-turn-queued-message-consumption
 *
 * Test obligations:
 * - CAP-EXT-QUEUE-001: queued message reaches next turn (via settleExtensionTurn → appendQueuedRuntimeMessages)
 * - CAP-EXT-QUEUE-002: extension state persists across turns (per-extension RuntimeSessionState bucket)
 * - CAP-EXT-QUEUE-003: snapshot/restore round-trips (handled in CAP-050; cross-referenced here)
 *
 * Risk: MEDIUM
 *
 * Class: 1 — substrate middleware. Active here:
 * - `appendQueuedRuntimeMessages` drain semantics (splice-out + return-true-iff-drained).
 * - `settleExtensionTurn` invokes the `turn:settle` extension hook with the
 *   three contractually-exposed callbacks (queueUserMessage, setModelSelection,
 *   setThinkingLevel) — all of which mutate `RuntimeSessionState`.
 * - `createExtensionRuntimeSessionController` factory exposes 14 callbacks
 *   that mutate `RuntimeSessionState` consistently (queueUserMessage,
 *   set/getActiveTools, set/getModelSelection, set/getThinkingLevel,
 *   appendSessionRecord with dedupeKey, listSessionRecords, clearSessionRecords).
 *
 * Verified location: agent-runtime/middleware/extension-queue.ts (extracted from
 * agent.ts:330-414 + 458-468 + 594-620 — pre-FEATURE_100 baseline — during FEATURE_100 P2)
 *
 * Time-ordering constraint: AFTER current turn's tool results;
 * `settleExtensionTurn` runs BEFORE microcompact (CAP-014); queue drain runs AFTER settle.
 * The four call sites in agent.ts (success / COMPLETE / BLOCKED / error) all preserve this order.
 *
 * STATUS: ACTIVE since FEATURE_100 P2.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import type { KodaXMessage } from '@kodax/ai';

import {
  KodaXExtensionRuntime,
  setActiveExtensionRuntime,
} from '../../extensions/runtime.js';
import {
  appendQueuedRuntimeMessages,
  createExtensionRuntimeSessionController,
  settleExtensionTurn,
} from '../middleware/extension-queue.js';
import {
  buildRuntimeSessionState,
  type RuntimeSessionState,
} from '../runtime-session-state.js';

function freshState(): RuntimeSessionState {
  return buildRuntimeSessionState({
    activeTools: ['read'],
    modelSelection: { provider: 'p', model: 'm' },
    thinkingLevel: 'balanced',
  });
}

describe('CAP-020: appendQueuedRuntimeMessages — drain semantics', () => {
  it('CAP-EXT-QUEUE-DRAIN-EMPTY: empty queue → returns false, leaves messages untouched', () => {
    const state = freshState();
    const messages: KodaXMessage[] = [{ role: 'user', content: 'pre' }];
    const drained = appendQueuedRuntimeMessages(messages, state);
    expect(drained).toBe(false);
    expect(messages).toEqual([{ role: 'user', content: 'pre' }]);
    expect(state.queuedMessages).toEqual([]);
  });

  it('CAP-EXT-QUEUE-001: non-empty queue → appends in-order, returns true, queue is emptied (splice semantics)', () => {
    const state = freshState();
    state.queuedMessages.push({ role: 'user', content: 'q1' });
    state.queuedMessages.push({ role: 'user', content: 'q2' });
    const messages: KodaXMessage[] = [{ role: 'user', content: 'pre' }];

    const drained = appendQueuedRuntimeMessages(messages, state);

    expect(drained).toBe(true);
    expect(messages).toEqual([
      { role: 'user', content: 'pre' },
      { role: 'user', content: 'q1' },
      { role: 'user', content: 'q2' },
    ]);
    expect(state.queuedMessages).toEqual([]);
  });
});

describe('CAP-020: settleExtensionTurn — turn:settle hook callbacks mutate RuntimeSessionState', () => {
  let runtime: KodaXExtensionRuntime;

  beforeEach(() => {
    runtime = new KodaXExtensionRuntime();
    setActiveExtensionRuntime(runtime);
  });

  afterEach(async () => {
    setActiveExtensionRuntime(null);
    await runtime.dispose();
  });

  it('CAP-EXT-QUEUE-001a: queueUserMessage callback inside turn:settle queues a string shorthand as a user message', async () => {
    runtime.registerHook('turn:settle', (ctx) => {
      ctx.queueUserMessage('please continue');
    });

    const state = freshState();
    await settleExtensionTurn('s1', 'final', state, {
      hadToolCalls: false,
      success: true,
      signal: 'COMPLETE',
    });

    expect(state.queuedMessages).toEqual([
      { role: 'user', content: 'please continue' },
    ]);
  });

  it('CAP-EXT-QUEUE-MODEL-SELECT: setModelSelection callback inside turn:settle normalizes provider/model (trims, drops empty)', async () => {
    runtime.registerHook('turn:settle', (ctx) => {
      ctx.setModelSelection({ provider: '  openai  ', model: '' });
    });

    const state = freshState();
    await settleExtensionTurn('s1', 'final', state, {
      hadToolCalls: false,
      success: true,
    });

    expect(state.modelSelection).toEqual({ provider: 'openai' });
  });

  it('CAP-EXT-QUEUE-THINKING-LEVEL: setThinkingLevel callback inside turn:settle writes through to state', async () => {
    runtime.registerHook('turn:settle', (ctx) => {
      ctx.setThinkingLevel('deep');
    });

    const state = freshState();
    await settleExtensionTurn('s1', 'final', state, {
      hadToolCalls: false,
      success: true,
    });

    expect(state.thinkingLevel).toBe('deep');
  });

  it('CAP-EXT-QUEUE-ORDERING: settleExtensionTurn → appendQueuedRuntimeMessages preserves the invariant — queueUserMessage during settle is drained on the very next append', async () => {
    runtime.registerHook('turn:settle', (ctx) => {
      ctx.queueUserMessage({ role: 'user', content: 'follow-up' });
    });

    const state = freshState();
    const messages: KodaXMessage[] = [];

    await settleExtensionTurn('s1', '', state, {
      hadToolCalls: false,
      success: true,
    });
    const drained = appendQueuedRuntimeMessages(messages, state);

    expect(drained).toBe(true);
    expect(messages).toEqual([{ role: 'user', content: 'follow-up' }]);
    expect(state.queuedMessages).toEqual([]);
  });

  it('CAP-EXT-QUEUE-NO-RUNTIME: with no active extension runtime, settleExtensionTurn is a no-op (does not throw)', async () => {
    setActiveExtensionRuntime(null);
    const state = freshState();
    await expect(
      settleExtensionTurn('s1', 'final', state, { hadToolCalls: false, success: true }),
    ).resolves.toBeUndefined();
    expect(state.queuedMessages).toEqual([]);
  });
});

describe('CAP-020: createExtensionRuntimeSessionController — controller mutators', () => {
  it('CAP-EXT-QUEUE-CTRL-QUEUE: queueUserMessage normalises a string into a user message', () => {
    const state = freshState();
    const controller = createExtensionRuntimeSessionController(state);

    controller.queueUserMessage('hi' as unknown as KodaXMessage);

    expect(state.queuedMessages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('CAP-EXT-QUEUE-002: per-extension state bucket survives multiple set/get cycles within the same RuntimeSessionState (cross-turn persistence proxy)', () => {
    const state = freshState();
    const controller = createExtensionRuntimeSessionController(state);

    controller.setSessionState('ext-a', 'counter', 1);
    controller.setSessionState('ext-a', 'label', 'first');
    expect(controller.getSessionState('ext-a', 'counter')).toBe(1);
    expect(controller.getSessionState('ext-a', 'label')).toBe('first');

    controller.setSessionState('ext-a', 'counter', 2);
    expect(controller.getSessionState('ext-a', 'counter')).toBe(2);
    expect(controller.getSessionStateSnapshot('ext-a')).toEqual({
      counter: 2,
      label: 'first',
    });
  });

  it('CAP-EXT-QUEUE-CTRL-SNAPSHOT-ISOLATION: getSessionStateSnapshot returns a plain-object clone — mutating the snapshot does NOT alter the live bucket', () => {
    const state = freshState();
    const controller = createExtensionRuntimeSessionController(state);

    controller.setSessionState('ext-a', 'k', 'v');
    const snapshot = controller.getSessionStateSnapshot('ext-a') as Record<string, unknown>;
    snapshot.k = 'tampered';
    snapshot.injected = 'should-not-leak';

    expect(controller.getSessionState('ext-a', 'k')).toBe('v');
    expect(controller.getSessionState('ext-a', 'injected')).toBeUndefined();
  });

  it('CAP-EXT-QUEUE-CTRL-CLEAR: setSessionState(value=undefined) deletes the key, and an empty bucket evicts the extensionId', () => {
    const state = freshState();
    const controller = createExtensionRuntimeSessionController(state);

    controller.setSessionState('ext-a', 'k1', 'v1');
    expect(state.extensionState.has('ext-a')).toBe(true);

    controller.setSessionState('ext-a', 'k1', undefined);
    expect(state.extensionState.has('ext-a')).toBe(false);
  });

  it('CAP-EXT-QUEUE-CTRL-DEDUPE: appendSessionRecord with dedupeKey replaces a previous record of the same (extensionId,type,dedupeKey)', () => {
    const state = freshState();
    const controller = createExtensionRuntimeSessionController(state);

    controller.appendSessionRecord('ext-a', 'note', { v: 1 }, { dedupeKey: 'k' });
    controller.appendSessionRecord('ext-a', 'note', { v: 2 }, { dedupeKey: 'k' });
    controller.appendSessionRecord('ext-a', 'note', { v: 99 }, { dedupeKey: 'other' });

    const records = controller.listSessionRecords('ext-a', 'note');
    expect(records).toHaveLength(2);
    expect(records.map((r) => (r.data as { v: number }).v).sort()).toEqual([2, 99]);
  });

  it('CAP-EXT-QUEUE-CTRL-LIST-CLONES: listSessionRecords returns top-level clones (mutating returned record does not affect source)', () => {
    const state = freshState();
    const controller = createExtensionRuntimeSessionController(state);

    controller.appendSessionRecord('ext-a', 'evt', { x: 1 });
    const [first] = controller.listSessionRecords('ext-a');
    expect(first).toBeDefined();
    first!.type = 'mutated';

    const [stillFirst] = controller.listSessionRecords('ext-a');
    expect(stillFirst!.type).toBe('evt');
  });

  it('CAP-EXT-QUEUE-CTRL-CLEAR-COUNT: clearSessionRecords returns the number of removed records and respects the optional type filter', () => {
    const state = freshState();
    const controller = createExtensionRuntimeSessionController(state);

    controller.appendSessionRecord('ext-a', 'evt', {});
    controller.appendSessionRecord('ext-a', 'evt', {});
    controller.appendSessionRecord('ext-a', 'note', {});
    controller.appendSessionRecord('ext-b', 'evt', {});

    expect(controller.clearSessionRecords('ext-a', 'evt')).toBe(2);
    expect(controller.listSessionRecords('ext-a').map((r) => r.type)).toEqual(['note']);
    expect(controller.listSessionRecords('ext-b').map((r) => r.type)).toEqual(['evt']);
  });

  it('CAP-EXT-QUEUE-CTRL-TOOLS: setActiveTools deduplicates and trims tool names', () => {
    const state = freshState();
    const controller = createExtensionRuntimeSessionController(state);

    controller.setActiveTools(['  read  ', 'edit', 'read', '', '   ']);
    expect(controller.getActiveTools()).toEqual(['read', 'edit']);
  });

  it('CAP-EXT-QUEUE-CTRL-MODEL: setModelSelection trims and drops empty strings; getModelSelection returns a clone', () => {
    const state = freshState();
    const controller = createExtensionRuntimeSessionController(state);

    controller.setModelSelection({ provider: '  vertex  ', model: '' });
    expect(controller.getModelSelection()).toEqual({ provider: 'vertex' });

    const snapshot = controller.getModelSelection();
    snapshot.provider = 'tampered';
    expect(controller.getModelSelection()).toEqual({ provider: 'vertex' });
  });

  it.todo('CAP-EXT-QUEUE-003: session snapshot includes extension state; restore reproduces the same per-extension buckets and pending queue (covered by CAP-050 round-trip via createRuntimeExtensionState/snapshotRuntimeExtensionState)');
  it.todo('CAP-EXT-QUEUE-004: settleExtensionTurn runs BEFORE microcompact (CAP-014) — call-site ordering invariant lives in agent.ts P2 / runner-frame in P3');
});
