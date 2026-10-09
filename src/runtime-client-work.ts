import type { KodaXRuntime } from './sdk-runtime.js';

export interface ClientWorkCleanup {
  readonly actorTurns: readonly { readonly actorPath: string; readonly turnId: string }[];
  readonly operationIds: readonly string[];
  readonly runIds: readonly string[];
  readonly withdrawnInputs: readonly { readonly sessionId: string; readonly inputId: string }[];
  readonly state: 'succeeded' | 'unknown';
  readonly issues: readonly string[];
}
const owners = new WeakMap<KodaXRuntime['identity'], (principalId: string) => Promise<ClientWorkCleanup>>();
/** Cancellation acceptance cannot depend indefinitely on a custom executor. */
export async function settleClientWork(pending: readonly Promise<unknown>[]): Promise<boolean> {
  if (pending.length === 0) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.allSettled(pending).then(() => true),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 1_000); })]);
  } finally { if (timer) clearTimeout(timer); }
}
export function registerClientWorkCleanup(runtime: KodaXRuntime, cleanup: (principalId: string) => Promise<ClientWorkCleanup>): void {
  owners.set(runtime.identity, cleanup);
}
export function cleanupClientWork(runtime: KodaXRuntime, principalId: string): Promise<ClientWorkCleanup> {
  const cleanup = owners.get(runtime.identity);
  if (!cleanup) throw new Error('Client work cleanup is unavailable on this Host.');
  return cleanup(principalId);
}
