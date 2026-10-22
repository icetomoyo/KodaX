import { expect, it, vi } from 'vitest';
import { SessionInputQueue } from './session-input-queue.js';
import { withProductExecution, type ProductExecutionContext } from './product-execution-authorization.js';

it.each([undefined, 'immediate', 'after_turn', 'redirect'] as const)('preserves exact queued delivery intent %s across restart and fresh authorization', (delivery) => {
  const input = { sessionId: 's', inputId: 'pending', text: 'Keep the original constraint.',
    ...(delivery !== undefined ? { delivery } : {}),
    ...(delivery === 'redirect' ? { targetRunId: 'original-run' } : {}) };
  const original: ProductExecutionContext = { principalId: 'A', key: 'old', bindRun: async value => value };
  const fresh = { ...original, key: 'fresh' };
  const first = new SessionInputQueue(() => {});
  withProductExecution(original, () => first.enqueue(input, false));
  const saved = first.snapshot('s');
  expect(saved).toEqual([{ input, skill: false, principalId: 'A' }]);
  const second = new SessionInputQueue(() => {});
  second.restore(saved, true);
  withProductExecution(fresh, () => expect(second.rebind(input)).toMatchObject({ state: 'queued' }));
  expect(second.batch('s')).toMatchObject([{ input }]);
});

it('preserves other principals in order without blocking recovery or borrowing authority', async () => {
  const context = (principalId: string): ProductExecutionContext => ({ principalId, key: `fresh-${principalId}`, bindRun: async input => input });
  const inputs = ['A', 'B'].map(principalId => ({ principalId, skill: false,
    input: { sessionId: 's', inputId: principalId, text: `Keep ${principalId}`, delivery: 'after_turn' as const } }));
  const queue = new SessionInputQueue(() => {});
  withProductExecution(context('A'), () => queue.restore(inputs));
  expect(queue.snapshot('s')).toEqual(inputs);
  expect(await queue.consumePlainBatch('s', 'root', async () => {}, 'fresh-A', 'A')).toMatchObject([{ inputId: 'A' }]);
  expect(queue.batch('s')).toEqual([]);
  expect(await queue.consumePlainBatch('s', 'root', async () => {}, 'fresh-A', 'A')).toEqual([]);
  expect(() => withProductExecution(context('A'), () => queue.rebind(inputs[1]!.input))).toThrow(/principal/);
  withProductExecution(context('B'), () => queue.rebind(inputs[1]!.input));
  expect(await queue.consumePlainBatch('s', 'next', async () => {}, 'fresh-B', 'B')).toMatchObject([{ inputId: 'B', content: 'Keep B' }]);
  expect(queue.snapshot('s')).toEqual([]);
});

it('rejects conflicting duplicate IDs before restoring any body', () => {
  const queue = new SessionInputQueue(() => {});
  expect(() => queue.restore(['One', 'Different'].map(text => ({ skill: false, input: { sessionId: 's', inputId: 'one', text } })))).toThrow(/intent/);
  expect(queue.list('s')).toEqual([]);
});

it('retains client ownership during withdrawal and enforces restore identity before any mutation', () => {
  const queue = new SessionInputQueue(() => {});
  const a: ProductExecutionContext = { principalId: 'A', key: 'fresh-A', bindRun: async input => input };
  const b: ProductExecutionContext = { principalId: 'B', key: 'fresh-B', bindRun: async input => input };
  const input = { sessionId: 's', inputId: 'a', text: 'Keep A', delivery: 'after_turn' as const };
  withProductExecution(a, () => {
    queue.enqueue(input, false);
    expect(queue.enqueue(input, false)).toMatchObject({ state: 'queued' });
    expect(() => queue.enqueue({ ...input, text: 'Changed' }, false)).toThrow(/intent/);
    queue.restore(queue.snapshot('s'));
    expect(() => queue.validateRestore([{ input, skill: false, principalId: 'B' }])).toThrow(/intent/);
    queue.recordAccepted({ ...input, inputId: 'steer' }, 'root', 'queued');
    expect(() => queue.withdraw('s', 'steer')).toThrow(/bound/);
    queue.markDropped('s', 'steer');
    expect(queue.read('s', 'steer')?.state).toBe('dropped');
  });
  withProductExecution(b, () => queue.enqueue({ ...input, inputId: 'b' }, false));
  expect(queue.clientSessions('A')).toEqual(['s']);
  expect(queue.withdrawClient('A', 's')).toEqual([{ sessionId: 's', inputId: 'a' }]);
  expect(queue.list('s')).toMatchObject([{ inputId: 'b' }]);
  queue.releaseSession('s');
  expect(queue.list('s')).toEqual([]);
  expect(() => queue.withdraw('s', 'missing')).toThrow(/submitted/);
  expect(() => queue.submitBatch('s', ['missing'], 'root')).toThrow(/available/);
});

it('commits pending bodies before accepting enqueue or withdrawal and permits retry after failed persistence', () => {
  let fail = true;
  let saved: unknown;
  const queue = new SessionInputQueue(() => {}, (_session, pending) => {
    if (fail) throw new Error('EIO');
    saved = structuredClone(pending);
  });
  const input = { sessionId: 's', inputId: 'one', text: 'Never deploy.', delivery: 'after_turn' as const };
  expect(() => queue.enqueue(input, false)).toThrow('EIO');
  expect(queue.read('s', 'one')).toBeUndefined();
  fail = false;
  queue.enqueue(input, false);
  expect(saved).toEqual([{ input, skill: false }]);
  fail = true;
  expect(() => queue.withdraw('s', 'one')).toThrow('EIO');
  expect(queue.list('s')).toHaveLength(1);
  fail = false;
  queue.withdraw('s', 'one');
  expect(saved).toEqual([]);
});

it('preflights the entire restored queue before mutating any input', () => {
  const queue = new SessionInputQueue(() => {});
  const pending = Array.from({ length: 6 }, (_, index) => ({ input: { sessionId: 's', inputId: String(index), text: 'Keep' }, skill: false }));
  expect(() => queue.validateRestore(pending)).toThrow(/limit/);
  expect(() => queue.restore(pending)).toThrow(/limit/);
  expect(queue.list('s')).toEqual([]);
});

it('restores exact pending constraints without replaying already submitted inputs', async () => {
  const first = new SessionInputQueue(() => {});
  first.enqueue({ sessionId: 's', inputId: 'done', text: 'Old instruction' }, false);
  await first.consumePlainBatch('s', 'r', async () => {});
  const full = 'Do not change exports.\n'.repeat(80);
  first.enqueue({ sessionId: 's', inputId: 'pending', text: full }, false);
  const saved = first.snapshot('s');
  first.close();
  const second = new SessionInputQueue(() => {});
  second.restore(saved);
  expect(await second.consumePlainBatch('s', 'r', async () => {})).toMatchObject([{ inputId: 'pending', content: full }]);
  expect(saved).toHaveLength(1);
});

it('retains queued identity and bodies until canonical persistence succeeds', async () => {
  const queue = new SessionInputQueue(() => {});
  const input = { sessionId: 's', inputId: 'one', text: 'Keep this', delivery: 'after_turn' as const };
  queue.enqueue(input, false);
  const failedSave = vi.fn(async () => { throw new Error('save rejected'); });
  await expect(queue.consumePlainBatch('s', 'run', failedSave)).rejects.toThrow('save rejected');
  expect(queue.read('s', 'one')).toMatchObject({ state: 'queued' });
  expect(queue.list('s')).toHaveLength(1);
  const persist = vi.fn(async () => {
    expect(queue.read('s', 'one')).toMatchObject({ state: 'queued' });
    expect(queue.list('s')).toHaveLength(1);
  });
  expect(await queue.consumePlainBatch('s', 'run', persist)).toMatchObject([{ inputId: 'one', content: 'Keep this' }]);
  expect(persist).toHaveBeenCalledTimes(1);
  expect(queue.read('s', 'one')).toMatchObject({ state: 'submitted', runId: 'run' });
  expect(queue.list('s')).toEqual([]);
  expect(await queue.consumePlainBatch('s', 'run', persist)).toEqual([]);
  expect(persist).toHaveBeenCalledTimes(1);
  expect(() => queue.withdraw('s', 'one')).toThrow('already been submitted');
});

it('keeps a Skill barrier and later plain inputs pending while consuming only the earlier plain batch', async () => {
  const queue = new SessionInputQueue(() => {});
  for (const [inputId, text] of [['before', 'First'], ['skill', '/inspect'], ['after', 'Last']]) {
    queue.enqueue({ sessionId: 's', inputId: inputId!, text: text!, delivery: 'after_turn' }, inputId === 'skill');
  }
  const persist = vi.fn(async () => {});
  expect(await queue.consumePlainBatch('s', 'run', persist)).toMatchObject([{ inputId: 'before' }]);
  expect(await queue.consumePlainBatch('s', 'run', persist)).toEqual([]);
  expect(persist).toHaveBeenCalledTimes(1);
  expect(queue.list('s').map(input => input.inputId)).toEqual(['skill', 'after']);
  expect(queue.withdraw('s', 'skill').text).toBe('/inspect');
  expect(await queue.consumePlainBatch('s', 'run', persist)).toMatchObject([{ inputId: 'after' }]);
});

it('keeps another Session input separate even when both clients used the same inputId', async () => {
  const queue = new SessionInputQueue(() => {});
  queue.enqueue({ sessionId: 'a', inputId: 'same', text: 'A', delivery: 'after_turn' }, false);
  queue.enqueue({ sessionId: 'b', inputId: 'same', text: 'B', delivery: 'after_turn' }, false);
  expect(await queue.consumePlainBatch('a', 'run-a', async () => {})).toMatchObject([{ content: 'A' }]);
  expect(queue.read('b', 'same')).toMatchObject({ state: 'queued' });
  expect(queue.withdraw('b', 'same').text).toBe('B');
});
