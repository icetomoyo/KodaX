import { isDeepStrictEqual } from 'node:util';
import type { Agent } from '@kodax-ai/agent';
import type { KodaXToolDefinition } from '@kodax-ai/llm';
import type { KodaXContextOptions } from '../types.js';
import { getBuiltinToolDefinition, getRegisteredToolDefinition } from './registry.js';
import { getRegistryManagedAgentContext, projectModelToolDefinition } from './model-tool-definition.js';
import { managedToolText } from './managed-tool-text.js';

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

/** One canonical contract; no policy, discovery, execution or parameter constraints are changed. */
export function projectManagedToolContract(tool: KodaXToolDefinition): KodaXToolDefinition {
  const text = managedToolText[tool.name];
  const builtin = getBuiltinToolDefinition(tool.name);
  if (!text || !builtin || getRegisteredToolDefinition(tool.name)?.source.kind !== 'builtin') return tool;
  const canonical = projectModelToolDefinition(builtin, { kind: 'builtin' });
  // A same-name host override (including branded instructions) keeps its own contract.
  if (tool.description !== canonical.description || !isDeepStrictEqual(tool.input_schema, canonical.input_schema)) return tool;
  const schema = structuredClone(tool.input_schema);
  for (const [path, description] of Object.entries(text.annotations ?? {})) {
    let node: unknown = schema;
    for (const part of path.split('.')) {
      node = node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined;
    }
    // Schema evolution must never cause a partial rewrite or delete a business parameter.
    if (!node || typeof node !== 'object' || Array.isArray(node) || !('description' in node)) return tool;
    if (description === null) delete (node as Record<string, unknown>).description;
    else (node as Record<string, unknown>).description = description;
  }
  return { ...tool, description: text.description ?? tool.description, input_schema: schema };
}

/** Presentation only: execution, visibility, Worker strategy and schema constraints stay unchanged. */
export function projectManagedToolContracts(
  agent: Agent,
  tools: readonly KodaXToolDefinition[],
  hostContext?: KodaXContextOptions,
): readonly KodaXToolDefinition[] {
  return canProjectManagedToolContracts(agent, hostContext) ? tools.map(projectManagedToolContract) : tools;
}
