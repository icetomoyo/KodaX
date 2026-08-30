/**
 * Process-local file mutation ordering.
 *
 * Same-path text mutations are serialized so concurrent agents in one Runtime
 * cannot lose a read-modify-write update. Different paths and independent
 * KodaX processes use the operating system's ordinary concurrency semantics.
 * Sandbox commands never acquire a command-lifetime filesystem mutex.
 */

import {
  isAgentHomeHardMutationTarget,
} from '../../permissions/agent-home-policy.js';
import { withPathMutation } from './file-mutation-primitives.js';

export {
  _peekFileMutationQueueSizeForTests,
  _resetFileMutationQueueForTests,
  normalizePathForKey,
  recordResolvedFileBackup,
  resolveFileBackupPath,
  withPathMutation,
} from './file-mutation-primitives.js';

/** Compatibility shape retained for embedders compiled against pre-0.7.96. */
export interface FileSystemMutationLeaseRelease {
  (): Promise<void>;
  bindEffectProcess(pid: number, windowsJobContained: boolean): Promise<void>;
  finishEffectProcess(): Promise<void>;
  readonly released: Promise<void>;
}

/** @deprecated Cleanup no longer waits on command-lifetime filesystem leases. */
export class FileSystemCleanupAdmissionTimeoutError extends Error {
  constructor() {
    super('Filesystem cleanup could not drain active effects before its deadline.');
    this.name = 'FileSystemCleanupAdmissionTimeoutError';
  }
}

function createCompatibilityLease(): FileSystemMutationLeaseRelease {
  let settled = false;
  let reportReleased!: () => void;
  const released = new Promise<void>((resolve) => { reportReleased = resolve; });
  const release = async (): Promise<void> => {
    if (settled) return;
    settled = true;
    reportReleased();
  };
  return Object.assign(release, {
    bindEffectProcess: async (_pid: number, _windowsJobContained: boolean): Promise<void> => {},
    finishEffectProcess: async (): Promise<void> => {},
    released,
  });
}

/** @deprecated Returns a non-blocking compatibility lease. */
export function acquireFileSystemMutationLease(
  _sandboxPolicyKey?: string,
): Promise<FileSystemMutationLeaseRelease> {
  return Promise.resolve(createCompatibilityLease());
}

/** @deprecated Returns a non-blocking compatibility lease. */
export function acquireExclusiveFileSystemEffectLease(
  _sandboxPolicyKey?: string,
): Promise<FileSystemMutationLeaseRelease> {
  return Promise.resolve(createCompatibilityLease());
}

export async function finishAndReleaseFileSystemEffectLease(
  lease: FileSystemMutationLeaseRelease,
): Promise<void> {
  const failures: unknown[] = [];
  try {
    await lease.finishEffectProcess();
  } catch (error: unknown) {
    failures.push(error);
  }
  try {
    await lease();
  } catch (error: unknown) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, 'Filesystem-effect finish and release both failed.');
  }
}

export function scheduleUnrefBackgroundRetry(
  operation: () => Promise<void>,
  onSuccess: () => void,
  onRetryFailure: (error: unknown, attempt: number) => void,
): void {
  let attempt = 0;
  const retry = (): void => {
    const delayMs = Math.min(250 * (2 ** attempt), 5_000);
    attempt += 1;
    const timer = setTimeout(() => {
      void operation().then(onSuccess).catch((error: unknown) => {
        onRetryFailure(error, attempt);
        retry();
      });
    }, delayMs);
    timer.unref?.();
  };
  retry();
}

/** Compatibility wrapper with no command-lifetime global fence. */
export function withExclusiveFileSystemCleanupLease<T>(
  _sandboxPolicyKey: string,
  _cleanupProcess: {
    readonly pid: number;
    readonly windowsJobContained: boolean;
  },
  action: () => Promise<T>,
  _onDeferredFailure?: (error: unknown) => Promise<void>,
  onLeaseAcquired?: (lease: FileSystemMutationLeaseRelease) => void,
  onLeaseReleased?: (lease: FileSystemMutationLeaseRelease) => void,
  onWorkflow?: (workflow: Promise<unknown>) => void,
): Promise<T> {
  const lease = createCompatibilityLease();
  onLeaseAcquired?.(lease);
  const workflow = Promise.resolve().then(action).finally(async () => {
    await lease();
    onLeaseReleased?.(lease);
  });
  onWorkflow?.(workflow);
  return workflow;
}

/** @deprecated Returns a non-blocking compatibility lease. */
export function acquireHostFileSystemMutationLease(): Promise<FileSystemMutationLeaseRelease> {
  return Promise.resolve(createCompatibilityLease());
}

/** Run a host-side mutation without a command-lifetime global fence. */
export function withHostFileSystemMutation<T>(operation: () => Promise<T>): Promise<T> {
  return Promise.resolve().then(operation);
}

/** Run a namespace mutation without blocking unrelated shell commands. */
export function withHostFileSystemNamespaceMutation<T>(
  operation: (
    bindEffectProcess: FileSystemMutationLeaseRelease['bindEffectProcess'],
    finishEffectProcess: FileSystemMutationLeaseRelease['finishEffectProcess'],
  ) => Promise<T>,
): Promise<T> {
  const lease = createCompatibilityLease();
  return Promise.resolve()
    .then(() => operation(lease.bindEffectProcess, lease.finishEffectProcess))
    .finally(lease);
}

/** Path-local queue plus the internal-state Agent Home hard boundary. */
export function withFileMutation<T>(
  absolutePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withPathMutation(absolutePath, async () => {
    if (isAgentHomeHardMutationTarget(absolutePath)) {
      throw new Error(`Mutation targets protected KodaX state: ${absolutePath}`);
    }
    return fn();
  });
}

export async function _resetFileSystemEffectLeasesForTests(): Promise<void> {
  if (process.env.VITEST_WORKER_ID === undefined) {
    throw new Error('Filesystem-effect lease reset is only available under Vitest.');
  }
}
