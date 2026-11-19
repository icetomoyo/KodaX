import type { Agent } from '@kodax-ai/agent';
import type { KodaXContextOptions } from '../types.js';
import { getRegistryManagedAgentContext } from './model-tool-definition.js';

const ordinaryRoots = new WeakSet<Agent>();

/** Internal production assembly marker; SDK factories and wrappers do not inherit it automatically. */
export function markOrdinaryRootToolContract(agent: Agent): void {
  ordinaryRoots.add(agent);
}

export function canProjectManagedToolContracts(agent: Agent, hostContext?: KodaXContextOptions): boolean {
  const context = getRegistryManagedAgentContext(agent);
  return ordinaryRoots.has(agent) && !!context
    && ![context, hostContext].some(value => value?.currentAgentId || value?.agentProfile
      || (value && 'systemPromptOverride' in value && value.systemPromptOverride) || value?.toolVisibilityPolicy);
}

/** Production Script assembly explicitly transfers provenance; ordinary SDK wrapping never does. */
export function inheritOrdinaryRootToolContract(source: Agent, wrapper: Agent, hostContext?: KodaXContextOptions): void {
  if (canProjectManagedToolContracts(source, hostContext)) ordinaryRoots.add(wrapper);
}
