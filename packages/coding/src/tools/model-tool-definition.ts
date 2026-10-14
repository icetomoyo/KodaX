import type { KodaXToolDefinition } from '@kodax-ai/llm';

/** Keep runner-only list seeding callable internally, outside the model contract. */
export function projectModelToolDefinition<T extends KodaXToolDefinition>(tool: T): T {
  if (tool.name !== 'todo_update') return tool;
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
