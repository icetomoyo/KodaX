import { describe, expect, it } from 'vitest';
import { getToolDefinition } from './index.js';
import { projectModelToolDefinition } from './model-tool-definition.js';
import { registerTool, executeTool } from './index.js';
import { getActiveToolDefinitions } from '../agent-runtime/tool-resolution.js';
import { toolSearchHandler } from './tool-search.js';
import { buildRunnerAgentChain } from '../task-engine/_internal/managed-task/agent-chain.js';
import { buildRunnerLlmAdapter } from '../task-engine/_internal/managed-task/llm-adapter.js';
import type { KodaXToolDefinition } from '@kodax-ai/llm';

describe('model tool contracts', () => {
  it('documents specialist effort locking through the actual spawn selector', () => {
    const spawn = getToolDefinition('spawn_agent')!;
    const effort = spawn.input_schema.properties.effort as { description: string };
    expect(spawn.input_schema.properties).toHaveProperty('agent_id');
    expect(spawn.input_schema.properties).not.toHaveProperty('subagent_type');
    expect(effort.description).toContain('agent_id');
    expect(effort.description).not.toContain('subagent_type');
    expect(effort.description).toMatch(/lock/);
    expect(effort.description).toMatch(/reject/);
  });

  it('projects builtin changed_diff onto one-or-many paths without changing raw SDK input', () => {
    const raw = getToolDefinition('changed_diff')!;
    const before = JSON.stringify(raw);
    const model = projectModelToolDefinition(raw, { kind: 'builtin' });
    expect(model.input_schema.required).toEqual(['paths']);
    expect(model.input_schema.properties).toHaveProperty('limit_per_path');
    expect(model.input_schema.properties).not.toHaveProperty('path');
    expect(model.input_schema.properties).not.toHaveProperty('limit');
    expect(JSON.stringify(raw)).toBe(before);
  });

  it.each(['edit', 'changed_diff', 'grep', 'lsp_implementation', 'lsp_prepare_call_hierarchy', 'lsp_incoming_calls', 'lsp_outgoing_calls', 'todo_update'])('leaves custom %s contracts and metadata untouched', (name) => {
    const raw = { ...getToolDefinition(name)!, input_schema: { type: 'object' as const, properties: { custom: { type: 'string' } }, required: ['custom'] } };
    expect(projectModelToolDefinition(raw, { kind: 'extension' })).toBe(raw);
    expect(projectModelToolDefinition(raw, { kind: 'constructed' })).toBe(raw);
    expect(projectModelToolDefinition(raw)).toBe(raw);
  });

  it.each([
    ['grep', ['-i', '-C'], ['pattern', 'path', 'glob', 'type', 'output_mode', 'ignore_case', '-A', '-B', 'context', 'multiline', 'head_limit', 'offset', 'scan_offset']],
    ['lsp_implementation', ['column'], ['path', 'line', 'character']],
    ['lsp_prepare_call_hierarchy', ['column'], ['path', 'line', 'character']],
    ['lsp_incoming_calls', ['column'], ['path', 'line', 'character']],
    ['lsp_outgoing_calls', ['column'], ['path', 'line', 'character']],
  ] as const)('shows canonical %s arguments while retaining raw SDK aliases', (name, aliases, canonical) => {
    const raw = getToolDefinition(name)!;
    const before = JSON.stringify(raw);
    const model = projectModelToolDefinition(raw, { kind: 'builtin' });
    for (const alias of aliases) {
      expect(raw.input_schema.properties).toHaveProperty(alias);
      expect(Object.hasOwn(model.input_schema.properties, alias)).toBe(false);
    }
    for (const field of canonical) expect(model.input_schema.properties[field]).toEqual(raw.input_schema.properties[field]);
    expect(Object.keys(model.input_schema.properties)).toEqual(canonical);
    expect(model.input_schema.required).toEqual(raw.input_schema.required);
    expect(JSON.stringify(raw)).toBe(before);
  });

  it('projects the builtin todo contract without mutating raw SDK input', () => {
    const raw = getToolDefinition('todo_update')!;
    const before = JSON.stringify(raw);
    const model = projectModelToolDefinition(raw, { kind: 'builtin' });
    expect(model.input_schema.required).toContain('id');
    expect(model.input_schema.properties).not.toHaveProperty('op');
    expect(model.input_schema.properties).not.toHaveProperty('items');
    expect(JSON.stringify(raw)).toBe(before);
  });

  it.each(['extension', 'constructed'] as const)('preserves a %s todo contract across model publication and exact discovery', async (kind) => {
    const schema = { type: 'object' as const, properties: {
      op: { type: 'string' }, items: { type: 'array', items: { type: 'string' } },
    }, required: ['op', 'items'] };
    const unregister = registerTool({ name: 'todo_update', description: 'Independent queue update.',
      input_schema: schema, sideEffect: 'readonly', handler: async input => JSON.stringify(input),
    }, { source: { kind, id: 'independent-todo' } });
    const ctx = { backups: new Map<string, string>() };
    try {
      expect(getActiveToolDefinitions(['todo_update'])[0]?.input_schema).toEqual(schema);
      const lookup = String(await toolSearchHandler({ query: 'select:todo_update' }, ctx));
      const contract = JSON.parse(lookup.slice('<function>'.length, lookup.indexOf('</function>'))) as { parameters: unknown };
      expect(contract.parameters).toEqual(schema);
      let sent: readonly KodaXToolDefinition[] = [];
      const adapter = buildRunnerLlmAdapter({}, async (_messages, tools) => {
        sent = tools;
        return { textBlocks: [{ text: 'done' }], toolBlocks: [] };
      });
      await adapter([{ role: 'user', content: 'Inspect the custom queue.' }], buildRunnerAgentChain(ctx).worker);
      expect(sent.find(tool => tool.name === 'todo_update')?.input_schema).toEqual(schema);
      const input = { op: 'inspect', items: ['existing'] };
      expect(await executeTool('todo_update', input, ctx)).toBe(JSON.stringify(input));
    } finally { unregister(); }
    expect(getActiveToolDefinitions(['todo_update'])[0]?.input_schema.required).toEqual(['id']);
  });
});
