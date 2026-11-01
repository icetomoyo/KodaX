import { afterEach, describe, expect, it, vi } from 'vitest';

const launch = vi.hoisted(() => vi.fn(async (
  _shell: string, _args: readonly string[], _options: unknown,
) => ({ stdout: 'ok\n', stderr: '' })));

vi.mock('child_process', () => ({ execFile: Object.assign(vi.fn(), {
  [Symbol.for('nodejs.util.promisify.custom')]: launch,
}) }));

import { exec } from './helpers.js';

afterEach(() => { launch.mockClear(); vi.unstubAllEnvs(); });

describe('extension command shell contract', () => {
  it('starts PowerShell without profiles or interactive prompts', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'fixture-secret');
    await expect(exec('echo ok', { shell: 'powershell' })).resolves.toMatchObject({ exitCode: 0, stdout: 'ok' });
    expect(launch).toHaveBeenCalledExactlyOnceWith('powershell', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'echo ok',
    ], expect.objectContaining({ timeout: 30_000, windowsHide: true }));
    expect(launch.mock.calls[0]?.[2]).not.toEqual(expect.objectContaining({
      env: expect.objectContaining({ OPENAI_API_KEY: expect.anything() }),
    }));
  });

  it('retains explicit Bash execution and command budgets', async () => {
    await exec('echo ok', { shell: 'bash', timeout: 500, env: { FIXTURE: 'value' } });
    expect(launch).toHaveBeenCalledExactlyOnceWith('bash', ['-c', 'echo ok'], expect.objectContaining({
      timeout: 500, env: expect.objectContaining({ FIXTURE: 'value' }),
    }));
  });
});
