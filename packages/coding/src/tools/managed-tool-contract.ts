import type { Agent } from '@kodax-ai/agent';
import type { KodaXContextOptions } from '../types.js';
import { getRegistryManagedAgentContext } from './model-tool-definition.js';

/**
 * A registry-assembled root Worker, or its Script wrapper, gets the managed request view:
 * activation bridges, compact search results and the code_search presentation filter.
 * Child Agents keep the native view because their parent already chose their tools.
 */
export function usesManagedToolView(agent: Agent, hostContext?: KodaXContextOptions): boolean {
  const context = getRegistryManagedAgentContext(agent);
  return context !== undefined && !context.currentAgentId && !hostContext?.currentAgentId;
}
