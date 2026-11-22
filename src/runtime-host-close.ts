import type { KodaXRuntime } from './sdk-runtime.js';

/** What a Host-close quiesce left behind: the Runs that had not settled by its deadline. */
export interface HostCloseQuiesce {
  readonly unsettledRunIds: readonly string[];
}

type HostCloseQuiesceHook = (input: { readonly deadlineMs: number }) => Promise<HostCloseQuiesce>;

const owners = new WeakMap<KodaXRuntime['identity'], HostCloseQuiesceHook>();

export function registerHostCloseQuiesce(runtime: KodaXRuntime, quiesce: HostCloseQuiesceHook): void {
  owners.set(runtime.identity, quiesce);
}

/**
 * Stops admission and the in-flight Runs exactly as `close()` does, while
 * events keep flowing, so a Host can still tell its clients how each Run ended.
 * Settles by the deadline either way. A Runtime that registered no hook (a
 * facade or a test double) returns undefined and keeps today's close order.
 */
export function quiesceRuntimeForHostClose(
  runtime: KodaXRuntime,
  input: { readonly deadlineMs: number },
): Promise<HostCloseQuiesce> | undefined {
  return owners.get(runtime.identity)?.(input);
}
