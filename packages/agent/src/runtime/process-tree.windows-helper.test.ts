import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const { spawnSyncMock } = vi.hoisted(() => ({ spawnSyncMock: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawnSync: spawnSyncMock,
}));

const { installWindowsProcessHelper, killPidTree, readProcessStartIdentities } = await import('./process-tree.js');

const HELPER = 'C:\\kodax\\kodax-windows-sandbox.exe';
const originalPlatform = process.platform;
const ok = (stdout: string) => ({ error: undefined, status: 0, signal: null, stdout, stderr: '', pid: 1, output: [] });
const failed = { ...ok(''), error: new Error('spawn failed'), status: null };
const calls = () => spawnSyncMock.mock.calls.map(([command, args]) => [command, ...(args as string[]).slice(0, 2)]);

beforeEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
  spawnSyncMock.mockReset();
});
afterEach(() => {
  installWindowsProcessHelper(undefined);
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform });
});

it('reads start identities through the installed helper instead of PowerShell', () => {
  installWindowsProcessHelper(() => HELPER);
  spawnSyncMock.mockReturnValueOnce(ok('4101,100\n4102,0\n'));
  expect(readProcessStartIdentities([4101, 4102])).toEqual(new Map([[4101, '100'], [4102, undefined]]));
  expect(spawnSyncMock).toHaveBeenCalledWith(HELPER, ['__process-start-identities', '4101', '4102'], expect.anything());
});

it('captures and terminates an exact tree through the helper, children first', async () => {
  installWindowsProcessHelper(() => HELPER);
  spawnSyncMock
    .mockReturnValueOnce(ok('4242,1,111\n4300,4242,222\n'))
    .mockReturnValueOnce(ok('KODAX_TERMINATION_COMPLETED\n1,0,5\nKODAX_SNAPSHOT_COMPLETED\n'));
  await expect(killPidTree(4242, { expectedProcessStartIdentity: '111', forceMs: 0 }))
    .resolves.toEqual({ status: 'terminated' });
  expect(spawnSyncMock.mock.calls.map(([command, args]) => [command, args])).toEqual([
    [HELPER, ['__process-snapshot']],
    [HELPER, ['__process-terminate-exact', '--snapshot', '4300:222', '4242:111']],
  ]);
});

it('falls back to PowerShell when the helper cannot run', () => {
  installWindowsProcessHelper(() => HELPER);
  spawnSyncMock.mockReturnValueOnce(failed).mockReturnValueOnce(ok('4101,100\n'));
  expect(readProcessStartIdentities([4101]).get(4101)).toBe('100');
  expect(calls().map(([command]) => command)).toEqual([HELPER, 'powershell.exe']);
});

it('stops trying a helper that cannot start, so fallback does not pay twice per call', () => {
  installWindowsProcessHelper(() => HELPER);
  const missing = { ...failed, error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) };
  spawnSyncMock.mockReturnValueOnce(missing).mockReturnValue(ok('4101,100\n'));
  readProcessStartIdentities([4101]);
  readProcessStartIdentities([4101]);
  expect(calls().map(([command]) => command)).toEqual([HELPER, 'powershell.exe', 'powershell.exe']);
});

it('keeps the helper after a timeout, which says nothing about whether it can run', () => {
  installWindowsProcessHelper(() => HELPER);
  const timedOut = { ...failed, error: Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' }) };
  spawnSyncMock.mockReturnValueOnce(timedOut).mockReturnValue(ok('4101,100\n'));
  readProcessStartIdentities([4101]);
  readProcessStartIdentities([4101]);
  expect(calls().map(([command]) => command)).toEqual([HELPER, 'powershell.exe', HELPER]);
});

it('resolves the helper once and uses PowerShell when it is unavailable', () => {
  const resolve = vi.fn(() => { throw new Error('artifact missing'); });
  installWindowsProcessHelper(resolve);
  spawnSyncMock.mockReturnValue(ok('4101,100\n'));
  readProcessStartIdentities([4101]);
  readProcessStartIdentities([4101]);
  expect(resolve).toHaveBeenCalledTimes(1);
  expect(calls().map(([command]) => command)).toEqual(['powershell.exe', 'powershell.exe']);
});
