import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createKodaXRuntime } from './sdk-runtime.js';

it('embedded credential methods reject scoped broker operations explicitly', async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-embedded-credentials-'));
  const runtime = await createKodaXRuntime({ mode: 'embedded', isolation: 'inline', homeDir });
  try {
    await expect(runtime.credentials.registerScoped({
      providers: ['test'],
    }, async () => undefined)).rejects.toThrow('shared daemon client');
    await expect(runtime.credentials.resumeScoped('lease', async () => undefined))
      .rejects.toThrow('shared daemon client');
  } finally {
    await runtime.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});
