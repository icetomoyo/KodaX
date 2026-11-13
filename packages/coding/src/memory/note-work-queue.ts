/**
 * FEATURE_306 — the per-process queue for the note memory's background work.
 * It lives apart from the job so shutdown code can wait for it without
 * importing the job (which would make an import cycle with memory-runtime).
 */

let tail: Promise<void> = Promise.resolve();

/** Runs `task` after the earlier ones, so two finishing runs never write the same store together. */
export function enqueueNoteWork(task: () => Promise<void>): Promise<void> {
  const next = tail.then(task);
  tail = next.catch(() => undefined);
  return next;
}

/** Settles once everything queued so far has finished; never rejects. */
export function noteWorkSettled(): Promise<void> {
  return tail;
}
