import { emitKodaXDiagnostic } from '@kodax-ai/agent';
import type { ClientStartupProgress } from '@kodax-ai/coding/client-contract';

/** Local observation only: never await UI work or let observer failure change startup. */
export function createClientStartupProgressReporter(
  observer?: (progress: ClientStartupProgress) => void | Promise<void>,
): (progress: ClientStartupProgress) => void {
  let previous: string | undefined;
  return (progress) => {
    if (observer === undefined) return;
    const key = progress.stage === 'waiting' ? `${progress.stage}:${progress.reason}`
      : progress.stage === 'initializing' ? `${progress.stage}:${progress.phase}` : progress.stage;
    if (previous === key) return;
    previous = key;
    const reportFailure = (error: unknown): void => {
      emitKodaXDiagnostic({
        source: 'client.startup-progress',
        level: 'warn',
        message: 'Startup progress observer failed.',
        detail: error,
      });
    };
    try {
      const pending = observer(progress);
      if (pending !== undefined) void Promise.resolve(pending).catch(reportFailure);
    } catch (error: unknown) {
      reportFailure(error);
    }
  };
}
