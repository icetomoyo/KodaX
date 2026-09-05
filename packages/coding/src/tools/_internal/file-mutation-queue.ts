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
