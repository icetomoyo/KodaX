import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  accessSync: vi.fn(), realpathSync: vi.fn(), statSync: vi.fn(),
  access: vi.fn(), realpath: vi.fn(), stat: vi.fn(),
  execFile: vi.fn(), execFileSync: vi.fn(),
}));
vi.mock('node:fs', () => ({
  constants: { X_OK: 1 },
  accessSync: mocks.accessSync, realpathSync: mocks.realpathSync, statSync: mocks.statSync,
  promises: { access: mocks.access, realpath: mocks.realpath, stat: mocks.stat },
}));
vi.mock('node:child_process', () => ({ execFile: mocks.execFile, execFileSync: mocks.execFileSync }));

import { assertNoGitInstallPrompt, assertNoGitInstallPromptSync } from './macos-git.js';

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
let sequence = 0;
let options = { cwd: '/workspace', env: { PATH: '/usr/bin:/bin' } };

beforeEach(() => {
  vi.resetAllMocks();
  options = { cwd: `/workspace/${++sequence}`, env: { PATH: '/usr/bin:/bin' } };
  Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'darwin' });
  mocks.realpathSync.mockImplementation((value: string) => value);
  mocks.realpath.mockImplementation(async (value: string) => value);
  mocks.statSync.mockReturnValue({ isFile: () => true });
  mocks.stat.mockResolvedValue({ isFile: () => true });
  mocks.execFileSync.mockImplementation(() => { throw Object.assign(new Error('no developer directory'), { status: 2 }); });
  mocks.execFile.mockImplementation((_file: string, _args: string[], _opts: unknown, callback: (error: Error) => void) => {
    callback(Object.assign(new Error('no developer directory'), { code: 2 }));
  });
});
afterEach(() => {
  Object.defineProperty(process, 'platform', originalPlatform);
  vi.useRealTimers();
});

describe('macOS automatic Git launch protection', () => {
  it.each(['win32', 'linux'])('does no filesystem or process probing on %s', async (platform) => {
    Object.defineProperty(process, 'platform', { ...originalPlatform, value: platform });
    await assertNoGitInstallPrompt(options);
    assertNoGitInstallPromptSync(options);
    expect(mocks.access).not.toHaveBeenCalled();
    expect(mocks.accessSync).not.toHaveBeenCalled();
    expect(mocks.execFile).not.toHaveBeenCalled();
    expect(mocks.execFileSync).not.toHaveBeenCalled();
  });

  it('does not inspect Xcode when PATH selects an independent Git', async () => {
    const independent = { ...options, env: { PATH: '/opt/homebrew/bin:/usr/bin' } };
    await assertNoGitInstallPrompt(independent);
    assertNoGitInstallPromptSync(independent);
    expect(mocks.execFile).not.toHaveBeenCalled();
    expect(mocks.execFileSync).not.toHaveBeenCalled();
  });

  it('allows installed system Git and inherits a custom developer directory', async () => {
    const installed = { ...options, env: { ...options.env, DEVELOPER_DIR: '/Applications/Custom Xcode.app/Contents/Developer' } };
    mocks.execFile.mockImplementation((_file: string, _args: string[], _opts: unknown, callback: (error: null) => void) => callback(null));
    await assertNoGitInstallPrompt(installed);
    assertNoGitInstallPromptSync(installed);
    expect(mocks.execFile).toHaveBeenCalledWith('/usr/bin/xcode-select', ['-p'], expect.objectContaining({ env: installed.env }), expect.any(Function));
  });

  it('checks an explicitly selected executable without changing PATH priority', async () => {
    const explicit = { ...options, executable: '/opt/custom/git', env: { PATH: '/usr/bin' } };
    await assertNoGitInstallPrompt(explicit);
    assertNoGitInstallPromptSync(explicit);
    expect(mocks.execFile).not.toHaveBeenCalled();
    mocks.realpath.mockResolvedValue('/usr/bin/git');
    await expect(assertNoGitInstallPrompt(explicit)).rejects.toThrow(/developer tools/);
  });

  it('resolves relative and empty PATH entries against the command cwd', async () => {
    const relative = { ...options, env: { PATH: 'bin::/usr/bin' } };
    mocks.access.mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    await assertNoGitInstallPrompt(relative);
    expect(mocks.access.mock.calls.map(([file]) => file)).toEqual([`${options.cwd}/bin/git`, `${options.cwd}/git`]);
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it('does not mistake an unresolved selected Git for a later system launcher', async () => {
    const independent = { ...options, env: { PATH: '/opt/custom/bin:/usr/bin' } };
    mocks.realpath.mockRejectedValueOnce(new Error('unreadable realpath'));
    mocks.realpathSync.mockImplementationOnce(() => { throw new Error('unreadable realpath'); });
    await expect(assertNoGitInstallPrompt(independent)).resolves.toBeUndefined();
    expect(() => assertNoGitInstallPromptSync(independent)).not.toThrow();
    expect(mocks.execFile).not.toHaveBeenCalled();
    expect(mocks.execFileSync).not.toHaveBeenCalled();
  });

  it('retains execution after inconclusive checks and does not cache them as unavailable', async () => {
    mocks.execFile.mockImplementation((_file: string, _args: string[], _opts: unknown, callback: (error: Error) => void) => callback(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
    await assertNoGitInstallPrompt(options);
    await assertNoGitInstallPrompt(options);
    expect(mocks.execFile).toHaveBeenCalledTimes(2);
    mocks.execFileSync.mockImplementation(() => { throw Object.assign(new Error('failed'), { status: 1 }); });
    assertNoGitInstallPromptSync(options);
    assertNoGitInstallPromptSync(options);
    expect(mocks.execFileSync).toHaveBeenCalledTimes(2);
  });

  it('does not block Git if the probe cannot be spawned synchronously', async () => {
    mocks.execFile.mockImplementation(() => { throw new Error('spawn failed'); });
    await expect(assertNoGitInstallPrompt(options)).resolves.toBeUndefined();
  });

  it('does not retain a missing result after the developer directory changes', async () => {
    await expect(assertNoGitInstallPrompt(options)).rejects.toThrow(/developer tools/);
    mocks.execFile.mockImplementation((_file: string, _args: string[], _opts: unknown, callback: (error: null) => void) => callback(null));
    await assertNoGitInstallPrompt({ ...options, env: { ...options.env, DEVELOPER_DIR: '/Applications/Xcode.app/Contents/Developer' } });
    expect(mocks.execFile).toHaveBeenCalledTimes(2);
  });

  it('expires synchronous missing results and notices newly installed independent Git', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    expect(() => assertNoGitInstallPromptSync(options)).toThrow(/developer tools/);
    assertNoGitInstallPromptSync({ ...options, env: { PATH: '/opt/homebrew/bin:/usr/bin' } });
    mocks.execFileSync.mockReturnValue('/Library/Developer/CommandLineTools');
    vi.setSystemTime(Date.now() + 6_000);
    assertNoGitInstallPromptSync(options);
    expect(mocks.execFileSync).toHaveBeenCalledTimes(2);
  });

  it('rejects the system Git before it can launch the installer, for async and sync callers', async () => {
    await expect(assertNoGitInstallPrompt(options)).rejects.toThrow(/command line developer tools/i);
    expect(() => assertNoGitInstallPromptSync(options)).toThrow(/command line developer tools/i);
    expect(mocks.execFile).toHaveBeenCalledWith('/usr/bin/xcode-select', ['-p'], expect.objectContaining({ cwd: options.cwd, env: options.env }), expect.any(Function));
    expect(mocks.execFile.mock.calls.every(([file]) => file !== 'git' && file !== '/usr/bin/git')).toBe(true);
  });

  it('coalesces concurrent probes and expires a missing result so installation can recover', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const results = await Promise.allSettled(Array.from({ length: 3 }, () => assertNoGitInstallPrompt(options)));
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected', 'rejected']);
    expect(mocks.execFile).toHaveBeenCalledTimes(1);
    mocks.execFile.mockImplementation((_file: string, _args: string[], _opts: unknown, callback: (error: null) => void) => callback(null));
    vi.setSystemTime(Date.now() + 6_000);
    await expect(assertNoGitInstallPrompt(options)).resolves.toBeUndefined();
    expect(mocks.execFile).toHaveBeenCalledTimes(2);
  });
});
