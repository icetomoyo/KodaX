import { afterEach, expect, it, vi } from 'vitest';
const { spawnSync } = vi.hoisted(() => ({ spawnSync: vi.fn() }));
vi.mock('node:child_process', async () => ({
  ...await vi.importActual<typeof import('node:child_process')>('node:child_process'), spawnSync,
}));
import { readProcessStartIdentities } from './process-tree.js';
afterEach(() => spawnSync.mockReset());

it.runIf(process.platform === 'win32')('shares one snapshot inside a batch and refreshes it for the next check', () => {
  spawnSync.mockReturnValueOnce({ status: 0, stdout: '4101,1,100\n4102,1,200\n' });
  expect(readProcessStartIdentities([4101, 4102, 4101, -1])).toEqual(new Map([
    [4101, '100'], [4102, '200'],
  ]));
  expect(spawnSync).toHaveBeenCalledTimes(1);
  spawnSync.mockReturnValueOnce({ status: 0, stdout: '4101,1,300\n' });
  expect(readProcessStartIdentities([4101, 4102])).toEqual(new Map([
    [4101, '300'], [4102, undefined],
  ]));
  expect(spawnSync).toHaveBeenCalledTimes(2);
});
