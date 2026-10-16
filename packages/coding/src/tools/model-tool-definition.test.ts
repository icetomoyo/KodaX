import { describe, expect, it } from 'vitest';
import { getToolDefinition } from './index.js';
import { projectModelToolDefinition } from './model-tool-definition.js';

describe('model tool contracts', () => {
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

  it.each(['edit', 'changed_diff', 'grep', 'lsp_implementation', 'lsp_prepare_call_hierarchy', 'lsp_incoming_calls', 'lsp_outgoing_calls'])('leaves custom %s contracts and metadata untouched', (name) => {
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

  it('preserves the existing todo model projection without requiring new origin metadata', () => {
    const raw = getToolDefinition('todo_update')!;
    const before = JSON.stringify(raw);
    const model = projectModelToolDefinition(raw);
    expect(model.input_schema.required).toContain('id');
    expect(model.input_schema.properties).not.toHaveProperty('op');
    expect(model.input_schema.properties).not.toHaveProperty('items');
    expect(JSON.stringify(raw)).toBe(before);
  });
});
