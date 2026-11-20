import type { KodaXOptions } from './types.js';

/** Child Agents and Runs marked `hostMemory: 'off'` neither read nor write Host memory. */
export function usesHostMemory(options: KodaXOptions): boolean {
  return options.context?.currentAgentId === undefined
    && options.context?.parentAgentId === undefined
    && options.context?.hostMemory !== 'off';
}
