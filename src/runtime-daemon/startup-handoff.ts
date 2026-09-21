import { closeSync, openSync } from 'node:fs';

/** Capture before extensions can spawn children; only this daemon may publish. */
export function captureRuntimeDaemonStartupHandoff(
  environment: NodeJS.ProcessEnv = process.env,
): () => void {
  const decisionFile = environment.KODAX_INTERNAL_WINDOWS_JOB_HANDOFF;
  delete environment.KODAX_INTERNAL_WINDOWS_JOB_HANDOFF;
  let committed = false;
  let failure: Error | undefined;
  return () => {
    if (failure) throw failure;
    if (decisionFile === undefined || committed) return;
    try {
      const descriptor = openSync(decisionFile, 'wx', 0o600);
      committed = true;
      closeSync(descriptor);
    } catch (error: unknown) {
      failure = (error as NodeJS.ErrnoException).code === 'EEXIST'
        ? new Error('Runtime daemon startup cancelled before service publication.', { cause: error })
        : error instanceof Error ? error : new Error(String(error));
      throw failure;
    }
  };
}
