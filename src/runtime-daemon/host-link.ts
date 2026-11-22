import type { RuntimeDaemonEndpoint } from './transport.js';

/** Where a daemon facade reached its Host, so a launcher can open a v2 connection to that same Host. */
export interface RuntimeDaemonHostLink {
  readonly endpoint: RuntimeDaemonEndpoint;
  readonly token: string | undefined;
}

// Kept beside the facade rather than on it: the facade is public, and the token is not.
const links = new WeakMap<object, RuntimeDaemonHostLink>();

export function rememberRuntimeDaemonHostLink<T extends object>(runtime: T, link: RuntimeDaemonHostLink): T {
  links.set(runtime, link);
  return runtime;
}

export function runtimeDaemonHostLink(runtime: object): RuntimeDaemonHostLink | undefined {
  return links.get(runtime);
}
