/**
 * Tests for FEATURE_115 (v0.7.36) — agentId-scoped 2-tier priority queue.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  MessageQueue,
  _resetMessageQueueForTests,
  getMessageQueue,
} from './queue.js';
import type { QueueEvent } from './types.js';

describe('MessageQueue', () => {
  describe('enqueue + dequeue basics', () => {
    it('returns empty array when queue is empty', () => {
      const q = new MessageQueue();
      expect(q.dequeue({ maxPriority: 'background' })).toEqual([]);
    });

    it('drains in FIFO order within same priority', () => {
      const q = new MessageQueue();
      q.enqueue({ priority: 'user', mode: 'prompt', content: 'a' });
      q.enqueue({ priority: 'user', mode: 'prompt', content: 'b' });
      q.enqueue({ priority: 'user', mode: 'prompt', content: 'c' });
      const drained = q.dequeue({ maxPriority: 'user' });
      expect(drained.map((m) => m.content)).toEqual(['a', 'b', 'c']);
      expect(q.size()).toBe(0);
    });

    it('returns assigned id from enqueue (msg-<seq> format)', () => {
      const q = new MessageQueue();
      const id1 = q.enqueue({ priority: 'user', mode: 'prompt', content: 'a' });
      const id2 = q.enqueue({ priority: 'user', mode: 'prompt', content: 'b' });
      expect(id1).toBe('msg-1');
      expect(id2).toBe('msg-2');
    });

    it('removes drained messages from queue', () => {
      const q = new MessageQueue();
      q.enqueue({ priority: 'user', mode: 'prompt', content: 'a' });
      expect(q.size()).toBe(1);
      q.dequeue({ maxPriority: 'user' });
      expect(q.size()).toBe(0);
    });

    it('records enqueuedAt timestamp', () => {
      const q = new MessageQueue();
      const before = Date.now();
      q.enqueue({ priority: 'user', mode: 'prompt', content: 'a' });
      const drained = q.dequeue({ maxPriority: 'user' });
      const after = Date.now();
      expect(drained[0]?.enqueuedAt).toBeGreaterThanOrEqual(before);
      expect(drained[0]?.enqueuedAt).toBeLessThanOrEqual(after);
    });

    it('preserves input artifacts on queued prompt messages', () => {
      const q = new MessageQueue();
      q.enqueue({
        priority: 'user',
        mode: 'prompt',
        content: 'look',
        inputArtifacts: [
          {
            kind: 'image',
            path: '/tmp/shot.png',
            mediaType: 'image/png',
          },
        ],
      });
      const drained = q.dequeue({ maxPriority: 'user', mode: 'prompt' });
      expect(drained[0]?.inputArtifacts).toEqual([
        {
          kind: 'image',
          path: '/tmp/shot.png',
          mediaType: 'image/png',
        },
      ]);
    });
  });

  describe('priority ordering (user > background)', () => {
    it('user priority drains before background regardless of enqueue order', () => {
      const q = new MessageQueue();
      q.enqueue({ priority: 'background', mode: 'task-notification', content: 'bg-1' });
      q.enqueue({ priority: 'user', mode: 'prompt', content: 'user-1' });
      q.enqueue({ priority: 'background', mode: 'task-notification', content: 'bg-2' });
      q.enqueue({ priority: 'user', mode: 'prompt', content: 'user-2' });

      const drained = q.dequeue({ maxPriority: 'background' });
      expect(drained.map((m) => m.content)).toEqual([
        'user-1',
        'user-2',
        'bg-1',
        'bg-2',
      ]);
    });

    it('maxPriority=user only drains user, leaves background in queue', () => {
      const q = new MessageQueue();
      q.enqueue({ priority: 'background', mode: 'task-notification', content: 'bg' });
      q.enqueue({ priority: 'user', mode: 'prompt', content: 'user' });

      const drained = q.dequeue({ maxPriority: 'user' });
      expect(drained.map((m) => m.content)).toEqual(['user']);
      expect(q.size()).toBe(1);

      const remaining = q.dequeue({ maxPriority: 'background' });
      expect(remaining.map((m) => m.content)).toEqual(['bg']);
    });

    it('maxPriority=background drains both tiers in user-first order', () => {
      const q = new MessageQueue();
      q.enqueue({ priority: 'background', mode: 'task-notification', content: 'bg' });
      q.enqueue({ priority: 'user', mode: 'prompt', content: 'user' });
      const drained = q.dequeue({ maxPriority: 'background' });
      expect(drained.map((m) => m.content)).toEqual(['user', 'bg']);
    });
  });

  describe('agentId routing', () => {
    it('main thread (filter agentId=undefined) only drains undefined-agentId messages', () => {
      const q = new MessageQueue();
      q.enqueue({ priority: 'user', mode: 'prompt', content: 'main' });
      q.enqueue({
        priority: 'background',
        mode: 'task-notification',
        content: 'sub',
        agentId: 'sub-1',
      });

      const drained = q.dequeue({ maxPriority: 'background' });
      expect(drained.map((m) => m.content)).toEqual(['main']);
      expect(q.size()).toBe(1);
    });

    it('subagent only drains its own messages', () => {
      const q = new MessageQueue();
      q.enqueue({ priority: 'user', mode: 'prompt', content: 'main' });
      q.enqueue({
        priority: 'background',
        mode: 'task-notification',
        content: 'for-sub-1',
        agentId: 'sub-1',
      });
      q.enqueue({
        priority: 'background',
        mode: 'task-notification',
        content: 'for-sub-2',
        agentId: 'sub-2',
      });

      const drained = q.dequeue({ agentId: 'sub-1', maxPriority: 'background' });
      expect(drained.map((m) => m.content)).toEqual(['for-sub-1']);
      expect(q.size()).toBe(2);
    });

    it('different agents do not see each other messages even at user priority', () => {
      const q = new MessageQueue();
      q.enqueue({
        priority: 'user',
        mode: 'prompt',
        content: 'for-sub-1',
        agentId: 'sub-1',
      });
      const drainedSub2 = q.dequeue({
        agentId: 'sub-2',
        maxPriority: 'user',
      });
      expect(drainedSub2).toEqual([]);
      expect(q.size()).toBe(1);
    });
  });

  describe('limit', () => {
    it('limit caps drain count, leaves leftover in original FIFO order', () => {
      const q = new MessageQueue();
      for (let i = 0; i < 5; i++) {
        q.enqueue({ priority: 'user', mode: 'prompt', content: `m${i}` });
      }
      const first = q.dequeue({ maxPriority: 'user', limit: 2 });
      expect(first.map((m) => m.content)).toEqual(['m0', 'm1']);
      expect(q.size()).toBe(3);

      const rest = q.dequeue({ maxPriority: 'user' });
      expect(rest.map((m) => m.content)).toEqual(['m2', 'm3', 'm4']);
    });

    it('limit cap of 0 drains nothing', () => {
      const q = new MessageQueue();
      q.enqueue({ priority: 'user', mode: 'prompt', content: 'a' });
      const drained = q.dequeue({ maxPriority: 'user', limit: 0 });
      expect(drained).toEqual([]);
      expect(q.size()).toBe(1);
    });

    it('limit larger than available returns all matching', () => {
      const q = new MessageQueue();
      q.enqueue({ priority: 'user', mode: 'prompt', content: 'a' });
      const drained = q.dequeue({ maxPriority: 'user', limit: 10 });
      expect(drained.map((m) => m.content)).toEqual(['a']);
    });
  });

  describe('peek / count / has', () => {
    it('peek returns matching without removing', () => {
      const q = new MessageQueue();
      q.enqueue({ priority: 'user', mode: 'prompt', content: 'a' });
      const peeked = q.peek({ maxPriority: 'user' });
      expect(peeked.map((m) => m.content)).toEqual(['a']);
      expect(q.size()).toBe(1);
    });

    it('peek returns user-first priority order matching dequeue', () => {
      const q = new MessageQueue();
      q.enqueue({ priority: 'background', mode: 'task-notification', content: 'bg-1' });
      q.enqueue({ priority: 'user', mode: 'prompt', content: 'user-1' });
      q.enqueue({ priority: 'background', mode: 'task-notification', content: 'bg-2' });
      q.enqueue({ priority: 'user', mode: 'prompt', content: 'user-2' });

      // peek must yield the same order dequeue would (user-first FIFO),
      // so a caller can `peek` to decide whether to actually drain.
      const peeked = q.peek({ maxPriority: 'background' });
      expect(peeked.map((m) => m.content)).toEqual([
        'user-1',
        'user-2',
        'bg-1',
        'bg-2',
      ]);
      expect(q.size()).toBe(4);
    });

    it('peek with limit takes the first N in priority order, not insertion order', () => {
      const q = new MessageQueue();
      q.enqueue({ priority: 'background', mode: 'task-notification', content: 'bg' });
      q.enqueue({ priority: 'user', mode: 'prompt', content: 'user' });

      const peeked = q.peek({ maxPriority: 'background', limit: 1 });
      expect(peeked.map((m) => m.content)).toEqual(['user']);
    });

    it('count returns matching count', () => {
      const q = new MessageQueue();
      q.enqueue({ priority: 'user', mode: 'prompt', content: 'a' });
      q.enqueue({ priority: 'background', mode: 'task-notification', content: 'b' });
      expect(q.count({ maxPriority: 'user' })).toBe(1);
      expect(q.count({ maxPriority: 'background' })).toBe(2);
    });

    it('has returns false on empty, true after enqueue', () => {
      const q = new MessageQueue();
      expect(q.has({ maxPriority: 'background' })).toBe(false);
      q.enqueue({ priority: 'user', mode: 'prompt', content: 'a' });
      expect(q.has({ maxPriority: 'user' })).toBe(true);
    });
  });

  describe('clear', () => {
    it('removes all messages across all priorities/agents', () => {
      const q = new MessageQueue();
      q.enqueue({ priority: 'user', mode: 'prompt', content: 'a' });
      q.enqueue({
        priority: 'background',
        mode: 'task-notification',
        content: 'b',
        agentId: 'sub-1',
      });
      q.clear();
      expect(q.size()).toBe(0);
    });
  });

  describe('requeue', () => {
    it('restores claimed messages ahead of later arrivals with their original ids', () => {
      const q = new MessageQueue();
      const events: QueueEvent[] = [];
      q.enqueue({ priority: 'user', mode: 'prompt', content: 'a' });
      q.enqueue({ priority: 'user', mode: 'prompt', content: 'b' });
      const claimed = q.dequeue({ maxPriority: 'user' });
      q.enqueue({ priority: 'user', mode: 'prompt', content: 'c' });
      q.subscribe(event => events.push(event));
      q.requeue(claimed);
      expect(q.peek({ maxPriority: 'user' }).map(m => [m.id, m.content])).toEqual([
        ['msg-1', 'a'], ['msg-2', 'b'], ['msg-3', 'c'],
      ]);
      expect(events.map(event => event.kind === 'enqueued' ? event.message.id : event.kind)).toEqual(['msg-1', 'msg-2']);
      q.requeue([]);
      expect(events).toHaveLength(2);
    });
  });

  describe('mode tagging', () => {
    it('preserves prompt / agent-message / task-notification / system-reminder modes', () => {
      const q = new MessageQueue();
      q.enqueue({ priority: 'user', mode: 'prompt', content: 'p' });
      q.enqueue({ priority: 'background', mode: 'agent-message', content: 'am' });
      q.enqueue({ priority: 'background', mode: 'task-notification', content: 'tn' });
      q.enqueue({ priority: 'background', mode: 'system-reminder', content: 'sr' });

      const drained = q.dequeue({ maxPriority: 'background' });
      expect(drained.map((m) => m.mode)).toEqual([
        'prompt',
        'agent-message',
        'task-notification',
        'system-reminder',
      ]);
    });
  });

  // FEATURE_159 (v0.7.40) — mode + id filter additions to DequeueFilter.
  describe('FEATURE_159 mode filter', () => {
    it('mode filter narrows drain to a single mode', () => {
      const q = new MessageQueue();
      q.enqueue({ priority: 'user', mode: 'prompt', content: 'p1' });
      q.enqueue({ priority: 'background', mode: 'task-notification', content: 'tn1' });
      q.enqueue({ priority: 'user', mode: 'prompt', content: 'p2' });

      const prompts = q.dequeue({ maxPriority: 'background', mode: 'prompt' });
      expect(prompts.map((m) => m.content)).toEqual(['p1', 'p2']);
      // task-notification stays.
      expect(q.size()).toBe(1);
      expect(q.peek({ maxPriority: 'background' })[0]?.mode).toBe('task-notification');
    });

    it('mode filter on peek / count / has', () => {
      const q = new MessageQueue();
      q.enqueue({ priority: 'user', mode: 'prompt', content: 'p' });
      q.enqueue({ priority: 'background', mode: 'task-notification', content: 'tn' });

      expect(q.count({ maxPriority: 'background', mode: 'prompt' })).toBe(1);
      expect(q.count({ maxPriority: 'background', mode: 'task-notification' })).toBe(1);
      expect(q.has({ maxPriority: 'background', mode: 'system-reminder' })).toBe(false);
      expect(q.peek({ maxPriority: 'background', mode: 'prompt' })[0]?.content).toBe('p');
    });
  });

  // FEATURE_159 (v0.7.40) — id filter enables Esc-pop-this-uuid surgery.
  describe('FEATURE_159 id filter', () => {
    it('id filter removes a single message by id', () => {
      const q = new MessageQueue();
      const id1 = q.enqueue({ priority: 'user', mode: 'prompt', content: 'a' });
      q.enqueue({ priority: 'user', mode: 'prompt', content: 'b' });
      const id3 = q.enqueue({ priority: 'user', mode: 'prompt', content: 'c' });

      const removed = q.dequeue({ maxPriority: 'user', id: id1 });
      expect(removed.map((m) => m.id)).toEqual([id1]);
      expect(q.size()).toBe(2);

      const removed2 = q.dequeue({ maxPriority: 'user', id: id3 });
      expect(removed2.map((m) => m.content)).toEqual(['c']);
      // The middle entry survives both targeted removals.
      expect(q.peek({ maxPriority: 'user' }).map((m) => m.content)).toEqual(['b']);
    });

    it('id filter combined with mode / agentId still respects scope', () => {
      const q = new MessageQueue();
      const subId = q.enqueue({
        priority: 'user',
        mode: 'prompt',
        content: 'sub',
        agentId: 'sub-1',
      });
      // Wrong agentId scope — must NOT drain even though id matches.
      const removed = q.dequeue({ maxPriority: 'user', id: subId });
      expect(removed).toEqual([]);
      expect(q.size()).toBe(1);

      const removedCorrect = q.dequeue({
        maxPriority: 'user',
        id: subId,
        agentId: 'sub-1',
      });
      expect(removedCorrect.map((m) => m.id)).toEqual([subId]);
    });
  });

  // FEATURE_159 (v0.7.40) — predicate escape-hatch for SDK consumers.
  describe('FEATURE_159 predicate filter', () => {
    it('predicate runs AFTER typed filters and is AND-ed with them', () => {
      const q = new MessageQueue();
      q.enqueue({ priority: 'user', mode: 'prompt', content: 'keep' });
      q.enqueue({ priority: 'user', mode: 'prompt', content: 'drop-me' });
      q.enqueue({ priority: 'background', mode: 'task-notification', content: 'drop-me' });

      const removed = q.dequeue({
        maxPriority: 'background',
        mode: 'prompt',
        predicate: (m) => m.content === 'drop-me',
      });
      // Only the prompt-mode 'drop-me' is removed; background 'drop-me'
      // doesn't match the typed mode filter so predicate never inspects it.
      expect(removed.map((m) => m.content)).toEqual(['drop-me']);
      expect(q.peek({ maxPriority: 'background' }).map((m) => m.content)).toEqual([
        'keep',
        'drop-me',
      ]);
    });

    it('predicate never observes messages outside agentId scope', () => {
      const q = new MessageQueue();
      q.enqueue({ priority: 'user', mode: 'prompt', content: 'main' });
      q.enqueue({
        priority: 'user',
        mode: 'prompt',
        content: 'sub',
        agentId: 'sub-1',
      });

      const seen: string[] = [];
      q.dequeue({
        maxPriority: 'user',
        predicate: (m) => {
          seen.push(m.content);
          return true;
        },
      });

      // agentId=undefined filter excludes sub-1; predicate only sees 'main'.
      expect(seen).toEqual(['main']);
    });
  });

  // FEATURE_159 (v0.7.40) — observable surface for useSyncExternalStore + SDK.
  describe('FEATURE_159 subscribe + getSnapshot', () => {
    it('subscribe fires after every mutation', () => {
      const q = new MessageQueue();
      let calls = 0;
      const unsubscribe = q.subscribe(() => {
        calls++;
      });

      q.enqueue({ priority: 'user', mode: 'prompt', content: 'a' });
      q.enqueue({ priority: 'user', mode: 'prompt', content: 'b' });
      q.dequeue({ maxPriority: 'user' });

      expect(calls).toBe(3);
      unsubscribe();

      q.enqueue({ priority: 'user', mode: 'prompt', content: 'c' });
      expect(calls).toBe(3);
    });

    it('subscribe carries typed QueueEvent payload', () => {
      const q = new MessageQueue();
      const events: QueueEvent[] = [];
      q.subscribe((event) => {
        events.push(event);
      });

      q.enqueue({ priority: 'user', mode: 'prompt', content: 'a' });
      q.enqueue({ priority: 'user', mode: 'prompt', content: 'b' });
      q.dequeue({ maxPriority: 'user' });
      q.enqueue({ priority: 'user', mode: 'prompt', content: 'c' });
      q.clear();

      expect(events).toHaveLength(5);
      expect(events[0]).toMatchObject({ kind: 'enqueued' });
      expect(events[0]).toHaveProperty('message');
      expect((events[0] as { message: { content: string } }).message.content).toBe('a');

      expect(events[2]).toMatchObject({ kind: 'dequeued' });
      const dequeued = events[2] as { kind: 'dequeued'; messages: readonly { content: string }[] };
      expect(dequeued.messages.map((m) => m.content)).toEqual(['a', 'b']);

      expect(events[4]).toMatchObject({ kind: 'cleared' });
      const cleared = events[4] as { kind: 'cleared'; messages: readonly { content: string }[] };
      expect(cleared.messages.map((m) => m.content)).toEqual(['c']);
    });

    it('no-op dequeue does NOT fire subscribers', () => {
      const q = new MessageQueue();
      let calls = 0;
      q.subscribe(() => {
        calls++;
      });

      // Empty queue — nothing to drain.
      q.dequeue({ maxPriority: 'user' });
      expect(calls).toBe(0);

      q.enqueue({ priority: 'user', mode: 'prompt', content: 'a' });
      expect(calls).toBe(1);

      // Mode mismatch — no message removed, no notify.
      q.dequeue({ maxPriority: 'user', mode: 'task-notification' });
      expect(calls).toBe(1);
    });

    it('clear() fires subscribers only when something was actually cleared', () => {
      const q = new MessageQueue();
      let calls = 0;
      q.subscribe(() => {
        calls++;
      });

      q.clear();
      expect(calls).toBe(0);

      q.enqueue({ priority: 'user', mode: 'prompt', content: 'a' });
      q.clear();
      expect(calls).toBe(2); // one for enqueue, one for clear.
    });

    it('getSnapshot returns stable reference across no-op reads', () => {
      const q = new MessageQueue();
      const snap0 = q.getSnapshot();
      const snap0Repeat = q.getSnapshot();
      expect(snap0).toBe(snap0Repeat);

      q.enqueue({ priority: 'user', mode: 'prompt', content: 'a' });
      const snap1 = q.getSnapshot();
      expect(snap1).not.toBe(snap0);
      expect(snap1.map((m) => m.content)).toEqual(['a']);

      const snap1Repeat = q.getSnapshot();
      expect(snap1Repeat).toBe(snap1);
    });

    it('snapshot is frozen (defends against caller mutation)', () => {
      const q = new MessageQueue();
      q.enqueue({ priority: 'user', mode: 'prompt', content: 'a' });
      const snap = q.getSnapshot();
      expect(Object.isFrozen(snap)).toBe(true);
    });

    it('one subscriber throwing does not break others', () => {
      const q = new MessageQueue();
      let goodCalls = 0;
      q.subscribe(() => {
        throw new Error('bad subscriber');
      });
      q.subscribe(() => {
        goodCalls++;
      });

      // Should not throw despite the broken subscriber.
      q.enqueue({ priority: 'user', mode: 'prompt', content: 'a' });
      expect(goodCalls).toBe(1);
    });

    it('useSyncExternalStore-style bare-callback subscribers ignore event payload', () => {
      // React passes `() => void`; structurally compatible with the typed
      // listener signature. This test pins that the call site keeps
      // compiling and working when the consumer doesn't care about the
      // event content.
      const q = new MessageQueue();
      let storeChangeCount = 0;
      const subscribe = (onStoreChange: () => void): (() => void) =>
        q.subscribe(onStoreChange);
      const unsubscribe = subscribe(() => {
        storeChangeCount++;
      });

      q.enqueue({ priority: 'user', mode: 'prompt', content: 'a' });
      q.dequeue({ maxPriority: 'user' });
      expect(storeChangeCount).toBe(2);
      unsubscribe();
    });
  });
});

describe('getMessageQueue (process-global singleton)', () => {
  afterEach(() => {
    _resetMessageQueueForTests();
  });

  it('returns the same instance on repeated calls', () => {
    const q1 = getMessageQueue();
    const q2 = getMessageQueue();
    expect(q1).toBe(q2);
  });

  it('persists state across getMessageQueue() calls', () => {
    getMessageQueue().enqueue({
      priority: 'user',
      mode: 'prompt',
      content: 'persistent',
    });
    expect(getMessageQueue().size()).toBe(1);
  });

  it('_resetMessageQueueForTests creates a fresh instance on next call', () => {
    const before = getMessageQueue();
    before.enqueue({ priority: 'user', mode: 'prompt', content: 'old' });
    _resetMessageQueueForTests();
    const after = getMessageQueue();
    expect(after).not.toBe(before);
    expect(after.size()).toBe(0);
  });
});
