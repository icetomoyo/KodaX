import { describe, expect, it } from 'vitest';
import { measureModelFields, measureTemplate } from './first-turn-uniform-costs.js';

describe('uniform first-turn accounting', () => {
  it('counts embedded AdditionalTools even when the top-level tools are empty', () => {
    const input = [{ type: 'additional_tools', role: 'developer', tools: [
      { name: 'execute', description: 'Complete parameters and recovery contract. '.repeat(40) },
    ] }];
    const result = measureModelFields({ input, tools: [], model: 'not-prompt', dsh_session_log: 'metadata'.repeat(500) });
    expect(result.includedFields).toEqual(['input', 'tools']);
    expect(result.excludedFields).toEqual(['model', 'dsh_session_log']);
    expect(result.utf16Chars).toBe(JSON.stringify({ input, tools: [] }).length);
    expect(result.estimatedTokens).toBeGreaterThan(measureModelFields({ input: [], tools: [] }).estimatedTokens + 100);
  });

  it('uses compact parsed JSON rather than whitespace or excluded HTTP metadata', () => {
    const compact = { messages: [{ role: 'user', content: '你好 😀' }], tools: [] };
    const pretty = JSON.parse(JSON.stringify(compact, null, 4)) as unknown;
    expect(measureModelFields(pretty)).toEqual(measureModelFields(compact));
    expect(measureModelFields(compact).utf8Bytes).toBeGreaterThan(measureModelFields(compact).utf16Chars);
    expect(() => measureModelFields({ model: 'no model-visible fields' })).toThrow('No model-visible fields');
    expect(() => measureModelFields([])).toThrow('object');
  });

  it('keeps raw base-template text distinct from a full serialized request', () => {
    const raw = measureTemplate('a\n中😀');
    expect(raw.utf16Chars).toBe(5);
    expect(raw.utf8Bytes).toBe(9);
    expect(raw.representation).toBe('raw-template-text');
    const full = measureModelFields({ instructions: 'a\n中😀' });
    expect(full.representation).toBe('compact-model-fields-json');
    expect(full.utf16Chars).toBeGreaterThan(raw.utf16Chars);
  });
});
