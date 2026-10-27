import { expect, it, vi } from 'vitest';
import { dispatchAfterPersistence } from './restructured-contract.eval.js';

it('does not dispatch a reserved lane when another lane fails during persistence', async () => {
  let release!: () => void;
  const pendingWrite = new Promise<void>(resolve => { release = resolve; });
  let stopped = false;
  const dispatch = vi.fn(async () => 'sent');
  const pending = dispatchAfterPersistence(() => pendingWrite, () => stopped, dispatch);
  stopped = true;
  release();
  await expect(pending).rejects.toThrow('not dispatched');
  expect(dispatch).not.toHaveBeenCalled();
});

it('dispatches exactly once after persistence when no lane has failed', async () => {
  let release!: () => void;
  const pendingWrite = new Promise<void>(resolve => { release = resolve; });
  const dispatch = vi.fn(async () => 'sent');
  const pending = dispatchAfterPersistence(() => pendingWrite, () => false, dispatch);
  expect(dispatch).not.toHaveBeenCalled();
  release();
  await expect(pending).resolves.toBe('sent');
  expect(dispatch).toHaveBeenCalledOnce();
});

it.each(['--contract', '--work-modes'])('rejects mixing --restructured with %s before any evaluation', async flag => {
  const previous = process.argv;
  vi.resetModules();
  process.argv = [...previous, '--restructured', flag, 'offline-invalid-command'];
  try { await expect(import('./first-turn-compact-complex.eval.js')).rejects.toThrow('Select one frozen experiment'); }
  finally { process.argv = previous; }
});
