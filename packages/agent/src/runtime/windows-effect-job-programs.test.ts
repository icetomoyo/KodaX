import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: vi.fn(() => { throw new Error('Fixture captured the command without launching it.'); }),
}));

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.resetModules(); vi.mocked(spawn).mockClear(); });

it.runIf(process.platform === 'win32')('fails closed when a packaged binary cannot find its Windows programs', async () => {
  const read = fs.readFileSync;
  vi.spyOn(fs, 'readFileSync').mockImplementation((file, options) => {
    if (String(file).endsWith('windows-effect-job-programs.json')) {
      throw Object.assign(new Error('Fixture Windows program resource is missing.'), { code: 'ENOENT' });
    }
    return read(file, options);
  });
  const runtime = await import('./windows-effect-job.js');
  vi.stubEnv('KODAX_BUNDLED', 'true');
  await expect(runtime.terminateWindowsEffectJob('Global\\KodaXEffect-00000000-0000-4000-8000-000000000001'))
    .rejects.toThrow('Fixture Windows program resource is missing.');
  expect(spawn).not.toHaveBeenCalled();
});

it.runIf(process.platform === 'win32')('rejects modified packaged Windows programs before launching a process', async () => {
  const read = fs.readFileSync;
  vi.spyOn(fs, 'readFileSync').mockImplementation((file, options) => String(file).endsWith('windows-effect-job-programs.json')
    ? JSON.stringify({ effectJob: 'modified', sidProbe: 'modified' }) : read(file, options));
  const runtime = await import('./windows-effect-job.js');
  expect(spawn).not.toHaveBeenCalled();
  await expect(runtime.terminateWindowsEffectJob('Global\\KodaXEffect-00000000-0000-4000-8000-000000000001'))
    .rejects.toThrow('Packaged Windows program is missing or does not match the audited program.');
  expect(spawn).not.toHaveBeenCalled();
});

it.runIf(process.platform === 'win32')('loads programs only on use and preserves both pre-extraction command byte hashes', async () => {
  const read = vi.spyOn(fs, 'readFileSync');
  const runtime = await import('./windows-effect-job.js');
  const programReads = () => read.mock.calls.filter(([file]) => String(file).endsWith('windows-effect-job-programs.json')).length;
  expect(programReads()).toBe(0);
  await expect(runtime.terminateWindowsEffectJob('Global\\KodaXEffect-00000000-0000-4000-8000-000000000001')).rejects.toThrow('Fixture captured');
  await expect(runtime.windowsSandboxSidHasActiveProcesses('S-1-5-21-123-456-789-1001')).rejects.toThrow('Fixture captured');
  const hashes = vi.mocked(spawn).mock.calls.map(([, args]) => {
    const command = args?.at(-1);
    if (typeof command !== 'string') throw new Error('Fixture did not capture an encoded command.');
    return createHash('sha256').update(Buffer.from(command, 'base64').toString('utf16le'), 'utf8').digest('hex');
  });
  expect(hashes).toEqual(['a2fd25dbd7c7dcf8438d3d048b4040db49ee380090dd83c77ca5ad9eb7842f76',
    '02307259d2398a467692c41e5673fccd141f7ad08d4862601e99f6fae63f05ce']);
  expect(programReads()).toBe(2);
});
