import type { ChildProcess } from 'node:child_process';
import type { ManagedChildProcessMetadata, ManagedChildRegistrationOptions } from '@kodax-ai/agent';
import { expect, it, vi } from 'vitest';

const probe = vi.hoisted(() => ({ verified: false, calls: 0, child: undefined as ChildProcess | undefined }));
vi.mock('@kodax-ai/agent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kodax-ai/agent')>()),
  isCurrentProcessWindowsJobContained: () => true,
  killChildProcessTree: async () => {
    probe.calls++;
    return { status: probe.verified ? 'already-exited' as const : 'unknown' as const };
  },
  registerManagedChildProcess: (child: ChildProcess, metadata: ManagedChildProcessMetadata,
    options: ManagedChildRegistrationOptions) => {
    probe.child = child;
    options.onRegistered?.({ runtimeRunId: metadata.runtimeRunId!, pid: child.pid!,
      registrationId: '12345678-1234-4234-8234-123456789abc' });
    return () => undefined;
  },
}));
import { toolBash } from './bash.js';

it.each([false, true])('settles cleanup after exhausted retries even with a throwing owner callback (%s)', async (throws) => {
  probe.verified = false; probe.calls = 0;
  let retry: (() => Promise<void>) | undefined;
  let settled = false;
  const release = vi.fn();
  const unconfirmed = vi.fn(() => { if (throws) throw new Error('owner notification failed'); });
  const result = toolBash({ command: 'node -e "setTimeout(() => {}, 150)"', timeout: 0.02 }, {
    backups: new Map(), executionCwd: process.cwd(), runtimeRunId: 'run-cleanup-liveness',
    registerShellCleanup: (_reference, callback) => { retry = callback; return release; },
    onShellCleanupUnconfirmed: unconfirmed,
  }).then((value) => { settled = true; return value; });
  try {
    await vi.waitFor(() => expect(probe.calls).toBeGreaterThanOrEqual(4), { timeout: 12_000 });
    await vi.waitFor(() => expect(settled).toBe(true), { timeout: 500 });
    expect(await result).toContain('[Unknown]');
    expect(unconfirmed).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
    probe.verified = true;
    await retry!();
    expect(release).toHaveBeenCalledOnce();
  } finally {
    probe.verified = true;
    await retry?.();
    await result;
    if (probe.child?.exitCode === null) probe.child.kill();
  }
}, 15_000);
