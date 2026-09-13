import type { ChildProcess } from 'node:child_process';
import type { ManagedChildProcessMetadata, ManagedChildRegistrationOptions } from '@kodax-ai/agent';
import { expect, it, vi } from 'vitest';
import { buildChildEvents } from './child-executor.js';
import { toolBash } from './tools/bash.js';

const processTree = vi.hoisted(() => ({ blocked: false, child: undefined as ChildProcess | undefined }));
vi.mock('@kodax-ai/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kodax-ai/agent')>();
  return {
    ...actual,
    killChildProcessTree: async (child: ChildProcess) => {
      processTree.child = child;
      if (processTree.blocked) return { status: 'unknown' as const };
      if (child.exitCode === null && child.signalCode === null) {
        const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
        child.kill('SIGKILL');
        await closed;
      }
      return { status: 'terminated' as const };
    },
    registerManagedChildProcess: (child: ChildProcess, metadata: ManagedChildProcessMetadata,
      options: ManagedChildRegistrationOptions) => {
      options.onRegistered?.({ runtimeRunId: metadata.runtimeRunId!, pid: child.pid!,
        registrationId: '12345678-1234-1234-1234-123456789abc' });
      return () => undefined;
    },
  };
});

it('keeps a child Shell pending until its owner retries and verifies sandbox cleanup', async () => {
  const abort = new AbortController();
  let retryCleanup: (() => Promise<void>) | undefined;
  let child: ChildProcess | undefined;
  let settled = false;
  const release = vi.fn();
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
    processControl: { closeInput: async () => { setTimeout(() => abort.abort(), 20); }, terminate }, cleanup,
  }));
  const events = buildChildEvents('child', undefined, undefined, undefined, {
    registerShellCleanup: (reference, retry) => {
      expect(reference.runtimeRunId).toBe('run-child-cleanup');
      retryCleanup = retry;
      return release;
    },
  });
  const execution = toolBash({ command: 'child-cleanup-test' }, {
    backups: new Map(), runtimeRunId: 'run-child-cleanup', toolCallId: 'child-cleanup-test',
    abortSignal: abort.signal, shellSandbox: { prepare },
    registerShellCleanup: events?.registerShellCleanup,
  }).then((result) => { settled = true; return result; });
  try {
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalled());
    expect(settled).toBe(false);
    expect(release).not.toHaveBeenCalled();
    expect(retryCleanup).toBeTypeOf('function');
    cleanup.mockResolvedValue(undefined);
    await retryCleanup!();
    expect(await execution).toContain('[Cancelled]');
    expect(release).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledOnce();
    expect(terminate).toHaveBeenCalledOnce();
  } finally {
    cleanup.mockResolvedValue(undefined);
    await retryCleanup?.();
    if (child && child.exitCode === null && child.signalCode === null) await terminate(child);
  }
});

it('retains the child cleanup fence when the owner retries before the child AbortSignal arrives', async () => {
  const abort = new AbortController();
  let retryCleanup: (() => Promise<void>) | undefined;
  let settled = false;
  const release = vi.fn();
  const prepare = vi.fn(async () => ({
    executable: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], env: process.env,
    cleanup: async () => undefined,
  }));
  const events = buildChildEvents('child', undefined, undefined, undefined, {
    registerShellCleanup: (_reference, retry) => { retryCleanup = retry; return release; },
  });
  processTree.blocked = true;
  const execution = toolBash({ command: 'owner-stop-before-child-abort' }, {
    backups: new Map(), runtimeRunId: 'run-owner-stop', toolCallId: 'owner-stop-before-child-abort',
    abortSignal: abort.signal, shellSandbox: { prepare },
    registerShellCleanup: events?.registerShellCleanup,
  }).then((result) => { settled = true; return result; });
  try {
    await vi.waitFor(() => expect(retryCleanup).toBeTypeOf('function'));
    expect(abort.signal.aborted).toBe(false);
    await retryCleanup!();
    expect(release).not.toHaveBeenCalled();
    expect(settled).toBe(false);
    abort.abort();
    processTree.blocked = false;
    await retryCleanup!();
    expect(await execution).toContain('[Cancelled]');
    expect(release).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledOnce();
  } finally {
    processTree.blocked = false;
    abort.abort();
    await retryCleanup?.();
    if (processTree.child) {
      const actual = await vi.importActual<typeof import('@kodax-ai/agent')>('@kodax-ai/agent');
      await actual.killChildProcessTree(processTree.child);
    }
    processTree.child = undefined;
  }
});
