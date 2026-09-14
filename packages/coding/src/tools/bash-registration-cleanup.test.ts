import type { ChildProcess } from 'node:child_process';
import type { ManagedChildProcessMetadata, ManagedChildRegistrationOptions } from '@kodax-ai/agent';
import { expect, it, vi } from 'vitest';
import { toolBash } from './bash.js';

vi.mock('@kodax-ai/agent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kodax-ai/agent')>()),
  registerManagedChildProcess: (child: ChildProcess, metadata: ManagedChildProcessMetadata,
    options: ManagedChildRegistrationOptions) => {
    options.onRegistered?.({ runtimeRunId: metadata.runtimeRunId!, pid: child.pid!,
      registrationId: '12345678-1234-1234-1234-123456789abc' });
    return () => undefined;
  },
}));

it('retains sandbox cleanup failure after the Run registration callback throws and retries without executing again', async () => {
  let retryCleanup: (() => Promise<void>) | undefined;
  let child: ChildProcess | undefined;
  const cleanup = vi.fn(async (): Promise<void> => { throw new Error('sandbox cleanup unavailable'); });
  const terminate = vi.fn(async (processChild: ChildProcess) => {
    child = processChild;
    if (processChild.exitCode !== null || processChild.signalCode !== null) return;
    const closed = new Promise<void>((resolve) => processChild.once('close', () => resolve()));
    processChild.kill('SIGKILL');
    await closed;
  });
  const prepare = vi.fn(async () => ({
    executable: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], env: process.env,
    processTreeContainment: 'native-job' as const,
    processControl: { closeInput: async () => undefined, terminate }, cleanup,
  }));
  try {
    await expect(toolBash({ command: 'registration-cleanup-test' }, {
      backups: new Map(), toolCallId: 'registration-cleanup-test', runtimeRunId: 'run-registration-cleanup',
      shellSandbox: { prepare },
      registerShellCleanup: (_reference, retry) => {
        retryCleanup = retry;
        throw new Error('Run registration persistence failed');
      },
    })).rejects.toThrow('Run registration persistence failed');
    expect(retryCleanup).toBeTypeOf('function');
    await expect(retryCleanup!()).rejects.toThrow('sandbox cleanup unavailable');
    cleanup.mockResolvedValueOnce(undefined);
    await expect(retryCleanup!()).resolves.toBeUndefined();
    expect(cleanup).toHaveBeenCalledTimes(3);
    expect(prepare).toHaveBeenCalledOnce();
    expect(terminate).toHaveBeenCalledOnce();
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) await terminate(child);
  }
});
