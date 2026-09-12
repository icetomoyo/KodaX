import { expect, it, vi } from 'vitest';
import { SessionInputQueue } from './session-input-queue.js';

it('retains queued identity and bodies until canonical persistence succeeds', async () => {
  const queue = new SessionInputQueue(() => {});
  const input = { sessionId: 's', inputId: 'one', text: 'Keep this', delivery: 'after_turn' as const };
  queue.enqueue(input);
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
    queue.enqueue({ sessionId: 's', inputId: inputId!, text: text!, delivery: 'after_turn' });
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
  queue.enqueue({ sessionId: 'a', inputId: 'same', text: 'A', delivery: 'after_turn' });
  queue.enqueue({ sessionId: 'b', inputId: 'same', text: 'B', delivery: 'after_turn' });
  expect(await queue.consumePlainBatch('a', 'run-a', async () => {})).toMatchObject([{ content: 'A' }]);
  expect(queue.read('b', 'same')).toMatchObject({ state: 'queued' });
  expect(queue.withdraw('b', 'same').text).toBe('B');
});
