import type { KodaXToolDefinition } from '@kodax-ai/llm';
import type { ToolDefinitionSource } from './types.js';
import type { Agent } from '@kodax-ai/agent';

const registryManagedAgents = new WeakSet<Agent>();

/** Only the coding factory knows whether an Agent uses its registry contracts. */
export function markRegistryManagedAgent(agent: Agent): Agent {
  registryManagedAgents.add(agent);
  return agent;
}

export function isRegistryManagedAgent(agent: Agent): boolean {
  return registryManagedAgents.has(agent);
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
      description: 'Edit one existing file with one or more replacements in edits. Read first. Each old_string must be unique in the whole current file unless replace_all is true. Matching tries exact text then normalized anchors. Edits apply sequentially; later anchors must refer to the result of earlier edits. Any failed edit leaves the file unchanged; successful batches commit once. On failure, inspect the reported edit index and re-read or use a smaller unique anchor; do not rewrite the whole file to bypass an edit failure. Split oversized replacements into smaller edits.',
      input_schema: { ...tool.input_schema, properties: { path, edits }, required: ['path', 'edits'] },
    };
  }
  if (source?.kind === 'builtin' && tool.name === 'changed_diff') {
    const { path: _path, limit: _limit, ...properties } = tool.input_schema.properties;
    return {
      ...tool,
      description: 'Read paged diffs for one or more explicit changed paths. Prefer this over broad git diff output during reviews. Includes untracked files; use base_ref and optional target_ref for a comparison range. offset and limit_per_path apply independently to every path. Follow per-path continuation hints when truncated; at most 64 unique paths per call.',
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
