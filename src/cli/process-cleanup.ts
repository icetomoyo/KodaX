import { shutdownDefaultLspService, awaitLatestCodingMemoryReviewDrain } from '@kodax-ai/coding';
import {
  cleanupRegisteredManagedChildren,
  isCurrentProcessWindowsJobContained,
  shutdownTracing,
} from '@kodax-ai/agent';
import { normalizeCliError } from './util.js';

// A daemon may legitimately spend up to 130 seconds draining the shared ASRT
// workspace queue, followed by the 15-second memory review durability window.
const DEFAULT_DAEMON_FINAL_CLEANUP_TIMEOUT_MS = 160_000;
const DEFAULT_INTERACTIVE_FINAL_CLEANUP_TIMEOUT_MS = 5_000;
const MEMORY_REVIEW_DRAIN_TIMEOUT_MS = 15_000;
const MEMORY_REVIEW_CLEANUP_GUARD_TIMEOUT_MS = MEMORY_REVIEW_DRAIN_TIMEOUT_MS + 1_000;

function daemonFinalCleanupTimeoutMs(): number {
  const configured = Number.parseInt(
    process.env.KODAX_INTERNAL_DAEMON_FINAL_CLEANUP_TIMEOUT_MS ?? '',
    10,
  );
  return Number.isSafeInteger(configured) && configured > 0
    ? configured
    : DEFAULT_DAEMON_FINAL_CLEANUP_TIMEOUT_MS;
}

function interactiveFinalCleanupTimeoutMs(): number {
  const configured = Number.parseInt(
    process.env.KODAX_INTERNAL_INTERACTIVE_FINAL_CLEANUP_TIMEOUT_MS ?? '',
    10,
  );
  return Number.isSafeInteger(configured) && configured > 0
    ? configured
    : DEFAULT_INTERACTIVE_FINAL_CLEANUP_TIMEOUT_MS;
}

export async function cleanupInteractiveProcessResources(input: {
  readonly closeA2A?: () => void;
  readonly closeRuntime: () => Promise<void>;
  readonly closeHotReload?: () => void;
  readonly disposeExtensions?: () => Promise<void>;
}): Promise<void> {
  const errors: Error[] = [];
  // FEATURE_289: preserve the independent durability window before closing
  // any Runtime/provider resource the active reviewer may still need.
  await awaitLatestCodingMemoryReviewDrain(MEMORY_REVIEW_DRAIN_TIMEOUT_MS);
  const totalTimeoutMs = interactiveFinalCleanupTimeoutMs();
  const deadline = Date.now() + totalTimeoutMs;
  const phaseTimeoutMs = Math.max(1, Math.min(1_000, Math.floor(totalTimeoutMs / 5)));
  const attempt = async (
    label: string,
    operation: (() => void | Promise<void>) | undefined,
    maximumMs = phaseTimeoutMs,
    reserveMs = 0,
  ): Promise<void> => {
    const availableMs = Math.max(0, deadline - Date.now() - reserveMs);
    const timeoutMs = Math.max(1, Math.min(availableMs, maximumMs));
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const operationPromise = Promise.resolve().then(operation);
      await Promise.race([
        operationPromise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            reject(new Error(`${label} cleanup timed out after ${timeoutMs}ms.`));
          }, timeoutMs);
        }),
      ]);
    } catch (error: unknown) {
      const normalized = normalizeCliError(error);
      if (timedOut) {
        process.emitWarning(normalized.message, { code: 'KODAX_INTERACTIVE_CLEANUP' });
      } else {
        errors.push(normalized);
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  // Preserve one bounded slot for the final managed-child sweep even when an
  // earlier Runtime/MCP/LSP phase hangs during shutdown.
  const managedChildReserveMs = phaseTimeoutMs;
  await attempt('A2A', input.closeA2A, phaseTimeoutMs, managedChildReserveMs);
  await attempt('Runtime', input.closeRuntime, phaseTimeoutMs, managedChildReserveMs);
  await attempt('integration hot-reload', input.closeHotReload, phaseTimeoutMs, managedChildReserveMs);
  await attempt('extension Runtime', input.disposeExtensions, phaseTimeoutMs, managedChildReserveMs);
  await attempt('LSP', shutdownDefaultLspService, phaseTimeoutMs, managedChildReserveMs);
  await attempt('managed child process', async () => {
    await cleanupRegisteredManagedChildren({ scope: 'current-owner', includeCurrentOwner: true });
  });
  await attempt('tracing', shutdownTracing);

  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, 'Interactive process cleanup failed.');
  }
}

export async function cleanupDaemonServeProcessResources(input: {
  readonly closeA2A: () => void;
  readonly closeHotReload: () => void;
  readonly disposeExtensions: () => Promise<void>;
}): Promise<void> {
  const errors: Error[] = [];
  const totalTimeoutMs = daemonFinalCleanupTimeoutMs();
  const deadline = Date.now() + totalTimeoutMs;
  const phaseTimeoutMs = Math.max(1, Math.min(2_000, Math.floor(totalTimeoutMs / 4)));
  const attempt = async (
    label: string,
    operation: (() => void | Promise<void>) | undefined,
    maximumMs = phaseTimeoutMs,
  ): Promise<void> => {
    const remainingMs = Math.max(0, deadline - Date.now());
    const timeoutMs = Math.min(remainingMs, maximumMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const operationPromise = Promise.resolve().then(operation);
      await Promise.race([
        operationPromise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`${label} cleanup timed out after ${timeoutMs}ms.`));
          }, timeoutMs);
        }),
      ]);
    } catch (error: unknown) {
      const normalized = normalizeCliError(error);
      errors.push(new Error(
        `Daemon ${label} cleanup failed. ${normalized.message}`,
        { cause: normalized },
      ));
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  await attempt('A2A', input.closeA2A);
  await attempt('integration hot-reload', input.closeHotReload);
  await attempt('extension Runtime', input.disposeExtensions);
  await attempt(
    'memory review drain',
    () => awaitLatestCodingMemoryReviewDrain(MEMORY_REVIEW_DRAIN_TIMEOUT_MS),
    // The drain installs its own 15-second timer after this outer guard timer.
    // Leave headroom so the bounded drain wins the race at its documented limit.
    MEMORY_REVIEW_CLEANUP_GUARD_TIMEOUT_MS,
  );
  await attempt('LSP', shutdownDefaultLspService);
  await attempt('managed child process', async () => {
    await cleanupRegisteredManagedChildren({
      scope: 'current-owner',
      includeCurrentOwner: true,
      requireCurrentOwnerCleanup: true,
      currentOwnerJobContained: isCurrentProcessWindowsJobContained(),
    });
  }, Math.max(0, deadline - Date.now()));
  await attempt('tracing', shutdownTracing);
  if (process.env.KODAX_INTERNAL_DAEMON_TEST_FINAL_CLEANUP_ERROR === '1') {
    await attempt('injected final', () => {
      throw new Error('Injected daemon final cleanup failure.');
    });
  }

  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, 'Runtime daemon process cleanup failed.');
  }
}
