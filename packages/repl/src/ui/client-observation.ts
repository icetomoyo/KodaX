/** Guard only operations that can start work; observation and read/control faces stay usable. */
export function withObservedExecution<Args extends unknown[], Result>(
  ready: () => Promise<void>,
  execute: (...args: Args) => Promise<Result>,
): (...args: Args) => Promise<Result> {
  return async (...args) => { await ready(); return execute(...args); };
}

export const OBSERVATION_UNAVAILABLE = 'Host observation unavailable. Input not submitted; press Up to restore or edit it, then retry.';
export class ClientObservationUnavailableError extends Error {
  constructor() { super(OBSERVATION_UNAVAILABLE); }
}

export function isCommandHelp(args?: readonly string[]): boolean {
  return ['help', '--help', '-h'].includes(args?.[0]?.trim().toLowerCase() ?? '');
}
