import { describe, expect, it } from 'vitest';
import { validateToolSchemaForProvider } from './provider-schema.js';

describe('validateToolSchemaForProvider', () => {
  describe('anthropic', () => {
    it('accepts a minimal valid object schema', () => {
      const schema = {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      };
      const result = validateToolSchemaForProvider(schema, 'anthropic');
      expect(result.ok).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('rejects top-level type !== object', () => {
      const schema = { type: 'string' };
      const result = validateToolSchemaForProvider(schema, 'anthropic');
      expect(result.ok).toBe(false);
      expect(result.errors[0]).toMatch(/top-level input_schema\.type === 'object'/);
    });

    it('rejects missing top-level properties', () => {
      const schema = { type: 'object' };
      const result = validateToolSchemaForProvider(schema, 'anthropic');
      expect(result.ok).toBe(false);
      expect(result.errors[0]).toMatch(/properties/);
    });

    it('rejects $ref anywhere in the tree', () => {
      const schema = {
        type: 'object',
        properties: {
          x: { $ref: '#/defs/Foo' },
        },
      };
      const result = validateToolSchemaForProvider(schema, 'anthropic');
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => /\$ref is not supported/.test(e))).toBe(true);
    });

    it('warns on oneOf / anyOf / allOf without blocking', () => {
      const schema = {
        type: 'object',
        properties: {
          x: { oneOf: [{ type: 'string' }, { type: 'number' }] },
        },
      };
      const result = validateToolSchemaForProvider(schema, 'anthropic');
      expect(result.ok).toBe(true);
      expect(result.warnings.some((w) => /oneOf/.test(w))).toBe(true);
    });

    it('rejects non-string entries in `required`', () => {
      const schema = {
        type: 'object',
        properties: { x: { type: 'string' } },
        required: ['x', 42],
      };
      const result = validateToolSchemaForProvider(schema, 'anthropic');
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => /required.*array of strings/.test(e))).toBe(true);
    });

    it('walks nested properties and items', () => {
      const schema = {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: { $ref: '#/defs/Item' }, // should be flagged
          },
        },
      };
      const result = validateToolSchemaForProvider(schema, 'anthropic');
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => /\$ref/.test(e))).toBe(true);
    });

    it('rejects non-object top-level input', () => {
      const result = validateToolSchemaForProvider('not a schema', 'anthropic');
      expect(result.ok).toBe(false);
      expect(result.errors[0]).toMatch(/must be a JSON object/);
    });
  });

  describe('non-anthropic provider', () => {
    it("returns ok with a warning when validator is not implemented", () => {
      const schema = { type: 'object', properties: {} };
      const result = validateToolSchemaForProvider(schema, 'openai');
      expect(result.ok).toBe(true);
      expect(result.warnings.some((w) => /openai/.test(w))).toBe(true);
    });

    it('still returns ok for unknown provider names', () => {
      const result = validateToolSchemaForProvider({ type: 'object' }, 'mystery');
      expect(result.ok).toBe(true);
    });
  });
});
