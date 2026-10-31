import { staticText } from '../prompts/static-text.js';
import type { KodaXToolDefinition } from '@kodax-ai/llm';
import type { ToolDefinitionSource } from './types.js';
import type { Agent } from '@kodax-ai/agent';
import type { KodaXToolExecutionContext } from '../types.js';

const registryManagedAgents = new WeakMap<Agent, KodaXToolExecutionContext>();

/** Only the coding factory knows whether an Agent uses its registry contracts. */
export function markRegistryManagedAgent(agent: Agent, context: KodaXToolExecutionContext): Agent {
  registryManagedAgents.set(agent, context);
  return agent;
}

export function getRegistryManagedAgentContext(agent: Agent): KodaXToolExecutionContext | undefined {
  return registryManagedAgents.get(agent);
}

/** Keep runner-only list seeding callable internally, outside the model contract. */
export function projectModelToolDefinition<T extends KodaXToolDefinition>(tool: T, source?: ToolDefinitionSource): T {
  if (source?.kind === 'builtin') {
    const aliases = tool.name === 'grep' ? ['-i', '-C']
      : ['lsp_implementation', 'lsp_prepare_call_hierarchy', 'lsp_incoming_calls', 'lsp_outgoing_calls'].includes(tool.name) ? ['column'] : [];
    if (aliases.length > 0) return {
      ...tool,
      input_schema: { ...tool.input_schema, properties: Object.fromEntries(
        Object.entries(tool.input_schema.properties).filter(([name]) => !aliases.includes(name)),
      ) },
    };
  }
  if (source?.kind === 'builtin' && tool.name === 'edit') {
    const { path, edits } = tool.input_schema.properties;
    return {
      ...tool,
      description: staticText("t12.tools/model-tool-definition.0"),
      input_schema: { ...tool.input_schema, properties: { path, edits }, required: ['path', 'edits'] },
    };
  }
  if (source?.kind === 'builtin' && tool.name === 'changed_diff') {
    const { path: _path, limit: _limit, ...properties } = tool.input_schema.properties;
    return {
      ...tool,
      description: staticText("t12.tools/model-tool-definition.1"),
      input_schema: { ...tool.input_schema, properties, required: ['paths'] },
    };
  }
  if (source?.kind !== 'builtin' || tool.name !== 'todo_update') return tool;
  const { op: _op, items: _items, ...fields } = tool.input_schema.properties;
  const properties = Object.fromEntries(Object.entries(fields).map(([name, schema]) => {
    if (!schema || typeof schema !== 'object' || !('description' in schema)
      || typeof schema.description !== 'string') return [name, schema];
    return [name, { ...schema, description: schema.description.replace(/^op="update" only\. /, '') }];
  }));
  return {
    ...tool,
    input_schema: {
      ...tool.input_schema,
      properties,
      required: [...new Set([...(tool.input_schema.required ?? []).filter((key) => key !== 'op' && key !== 'items'), 'id'])],
    },
  };
}
