import * as childProcess from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';

vi.mock('@kodax-ai/agent', async (importOriginal) => ({
  ...await importOriginal<typeof import('@kodax-ai/agent')>(),
  assertNoGitInstallPrompt: vi.fn(async () => {
    throw new Error('macOS command line developer tools are unavailable. Install them to use system Git.');
  }),
}));
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return { ...original, execFile: vi.fn(() => {
    throw new Error('Unexpected subprocess launch');
  }) };
});

import { connectKodaXClient } from './sdk-client.js';
import { createKodaXRuntime } from './sdk-runtime.js';
import { startRuntimeDaemonHost } from './runtime-daemon/host.js';
import { resolveRuntimeDaemonPaths, tryAcquireRuntimeDaemonLock } from './runtime-daemon/state.js';

it.each([
  { scope: 'ordinary', args: [] },
  { scope: 'workflow', args: ['--workflow'] },
  { scope: 'base', args: ['base'] },
  { scope: 'commit', args: ['sha', 'HEAD'] },
])(
  'reports unavailable macOS Git through Product $scope review without launching Git',
  async ({ args }) => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kodax-product-review-git-'));
    let runtime: Awaited<ReturnType<typeof createKodaXRuntime>> | undefined;
    let host: Awaited<ReturnType<typeof startRuntimeDaemonHost>> | undefined;
    let client: Awaited<ReturnType<typeof connectKodaXClient>> | undefined;
    try {
      runtime = await createKodaXRuntime({ homeDir, sharedDaemonHost: true });
      const paths = resolveRuntimeDaemonPaths(homeDir);
      const lock = tryAcquireRuntimeDaemonLock(paths, {
        runtimeId: runtime.identity.runtimeId, pid: process.pid, createdAt: runtime.identity.startedAt,
      });
      if (!lock) throw new Error('Could not acquire isolated review Host.');
      const endpoint = process.platform === 'win32'
        ? { kind: 'pipe' as const, path: `\\\\.\\pipe\\kodax-review-git-${randomUUID()}` }
        : { kind: 'unix' as const, path: path.join(homeDir, 'host.sock') };
      host = await startRuntimeDaemonHost({ runtime, paths, lock, endpoint });
      client = await connectKodaXClient({ homeDir, endpoint: endpoint.path });
      const session = await client.sessions.create({ projectPath: homeDir });
      vi.mocked(childProcess.execFile).mockClear();

      const result = await client.review.start({ sessionId: session.id, inputId: 'review', args });

      expect(result).toEqual({
        kind: 'completed', success: false,
        message: '/review: git failed - macOS command line developer tools are unavailable. Install them to use system Git.',
      });
      expect(childProcess.execFile).not.toHaveBeenCalled();
    } finally {
      await client?.disconnect();
      await host?.close();
      await runtime?.close();
      await rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  },
);
