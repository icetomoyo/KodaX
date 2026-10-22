import { expect, it, vi } from 'vitest';
import { ContextCapacityError } from '@kodax-ai/agent';
import { waitForContextRecovery } from './context-recovery-wait.js';

const error = new ContextCapacityError({ contextWindow: 32_768, currentTokens: 40_000 });
const messages = [{ role: 'user' as const, content: 'Keep public APIs unchanged.' }];

it('saves exact history before entering recovery and never calls a provider while waiting', async () => {
  const order: string[] = [];
  let wake!: () => void;
  const pending = waitForContextRecovery(error, messages, {
    onCompactedMessages: async (saved, update) => {
      expect(saved).toEqual(messages);
      expect(update?.preCompactionMessages).toBe(messages);
      order.push('durable');
    },
    onContextCapacityBlocked: async () => {
      order.push('waiting');
      await new Promise<void>(resolve => { wake = resolve; });
    },
  });
  await vi.waitFor(() => expect(order).toEqual(['durable', 'waiting']));
  wake();
  expect(await pending).toBe(true);
});

it('never enters a waiting state if the transcript could not be saved', async () => {
  const blocked = vi.fn();
  const failure = new Error('disk unavailable');
  await expect(waitForContextRecovery(error, messages, {
    onCompactedMessages: async () => { throw failure; }, onContextCapacityBlocked: blocked,
  })).rejects.toBe(failure);
  expect(blocked).not.toHaveBeenCalled();
});

it('keeps unrelated failures and a cancelled run out of the capacity recovery path', async () => {
  const blocked = vi.fn();
  expect(await waitForContextRecovery(new Error('network'), messages, { onContextCapacityBlocked: blocked })).toBe(false);
  const controller = new AbortController();
  controller.abort();
  await expect(waitForContextRecovery(error, messages, { onContextCapacityBlocked: blocked }, controller.signal))
    .rejects.toMatchObject({ name: 'AbortError' });
  expect(blocked).not.toHaveBeenCalled();
});
