import { afterEach, describe, expect, it, vi } from 'vitest';
import { setKodaXDiagnosticSink, type KodaXDiagnostic } from '@kodax-ai/agent';

const { spawnSyncMock } = vi.hoisted(() => ({ spawnSyncMock: vi.fn() }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()), spawnSync: spawnSyncMock,
}));
import { readWindowsSandboxBootIdentity, resetSandboxRuntimeForTest } from './sandbox-runtime.js';

const platform = process.platform;
afterEach(async () => {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform });
  await resetSandboxRuntimeForTest();
  vi.clearAllMocks();
});

describe('Windows boot identity diagnostics', () => {
  it.each([false, true])('retains negative caching and failure semantics with sink throwing=%s', (throws) => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
    spawnSyncMock.mockReturnValue({ status: null, stdout: 'secret-output', stderr: 'secret-error',
      error: Object.assign(new Error('secret-command'), { code: 'ETIMEDOUT' }) });
    const diagnostics: KodaXDiagnostic[] = [];
    const restore = setKodaXDiagnosticSink((diagnostic) => {
      diagnostics.push(diagnostic);
      if (throws) throw new Error('sink failure');
    });
    try {
      expect(readWindowsSandboxBootIdentity()).toBeUndefined();
      expect(readWindowsSandboxBootIdentity()).toBeUndefined();
      expect(spawnSyncMock).toHaveBeenCalledTimes(1);
      expect(spawnSyncMock.mock.calls[0]?.[2]).toMatchObject({ timeout: 5000, windowsHide: true });
      expect(diagnostics).toContainEqual(expect.objectContaining({ detail: expect.objectContaining({
        stage: 'boot-identity', cached: false, available: false, errorCode: 'ETIMEDOUT', timeoutMs: 5000,
      }) }));
      expect(diagnostics).toContainEqual(expect.objectContaining({ detail: {
        stage: 'boot-identity', cached: true, available: false,
      } }));
      expect(JSON.stringify(diagnostics)).not.toContain('secret-');
    } finally { restore(); }
  });
});
