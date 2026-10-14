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

  it.each(['edit', 'changed_diff'])('leaves custom %s contracts and metadata untouched', (name) => {
    const raw = { ...getToolDefinition(name)!, input_schema: { type: 'object' as const, properties: { custom: { type: 'string' } }, required: ['custom'] } };
    expect(projectModelToolDefinition(raw, { kind: 'extension' })).toBe(raw);
    expect(projectModelToolDefinition(raw, { kind: 'constructed' })).toBe(raw);
    expect(projectModelToolDefinition(raw)).toBe(raw);
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
