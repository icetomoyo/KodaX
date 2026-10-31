import { expect, it, vi } from 'vitest';
import { assertFinalSource, persistFinalEvidence } from './final-contract-eval-integrity.js';

it('stops the lane and publishes STOP when evidence persistence fails, before any dispatch or later attempt', async () => {
  const abort = new AbortController(), dispatch = vi.fn(), publish = vi.fn();
  const stop = async (reason: string) => { abort.abort(new Error(reason)); publish(reason); };
  const attempt = async (persist: () => Promise<void>) => {
    abort.signal.throwIfAborted();
    await persistFinalEvidence(persist, stop);
    abort.signal.throwIfAborted();
    dispatch();
  };
  await expect(attempt(async () => { throw new Error('disk failure'); })).rejects.toThrow('disk failure');
  await expect(attempt(async () => undefined)).rejects.toThrow('Evidence persistence failed');
  expect(dispatch).not.toHaveBeenCalled();
  expect(publish).toHaveBeenCalledExactlyOnceWith('Evidence persistence failed: disk failure');
});

it('publishes STOP for a source mismatch even before a cell starts', async () => {
  const abort = new AbortController(), publish = vi.fn();
  const stop = async (reason: string) => { abort.abort(new Error(reason)); publish(reason); };
  await assertFinalSource(async () => true, stop);
  expect(publish).not.toHaveBeenCalled();
  await expect(assertFinalSource(async () => false, stop)).rejects.toThrow('Frozen source drift');
  expect(abort.signal.aborted).toBe(true);
  expect(publish).toHaveBeenCalledExactlyOnceWith('Frozen source drift');
});

it('publishes STOP when a frozen source cannot be read, before any dispatch', async () => {
  const abort = new AbortController(), publish = vi.fn(), dispatch = vi.fn();
  const stop = async (reason: string) => { abort.abort(new Error(reason)); publish(reason); };
  await expect((async () => {
    await assertFinalSource(async () => { throw new Error('ENOENT frozen file'); }, stop);
    dispatch();
  })()).rejects.toThrow('ENOENT frozen file');
  expect(abort.signal.aborted).toBe(true);
  expect(publish).toHaveBeenCalledExactlyOnceWith('Frozen source unreadable: ENOENT frozen file');
  expect(dispatch).not.toHaveBeenCalled();
});
