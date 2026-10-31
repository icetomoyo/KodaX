/** Eval-only fail-stop seams; persistence must finish before any paid dispatch. */
export async function persistFinalEvidence(persist: () => Promise<void>, stop: (reason: string) => Promise<void>): Promise<void> {
  try { await persist(); }
  catch (cause) {
    await stop(`Evidence persistence failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    throw cause;
  }
}

export async function assertFinalSource(check: () => Promise<boolean>, stop: (reason: string) => Promise<void>): Promise<void> {
  let unchanged: boolean;
  try { unchanged = await check(); }
  catch (cause) {
    await stop(`Frozen source unreadable: ${cause instanceof Error ? cause.message : String(cause)}`);
    throw cause;
  }
  if (unchanged) return;
  await stop('Frozen source drift');
  throw new Error('Frozen source drift');
}
