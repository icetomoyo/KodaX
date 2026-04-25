/**
 * Provider-specific tool input_schema validation.
 *
 * Constructed tool input_schema is JSON Schema, but each LLM provider
 * accepts a different subset. KodaX builtin tool schemas were authored
 * by hand and stay within the Anthropic intersection; LLM-generated
 * constructed handler schemas need a runtime gate.
 *
 * v0.7.28 ships the `'anthropic'` validator (the main verification path).
 * Other providers fall through with a warning so the existing builtin
 * dispatch path continues to work — they just don't get schema-level
 * pre-flight checks for constructed tools.
 *
 * Reference: Anthropic public API docs and observed 4xx behavior.
 */

export type SchemaProvider = 'anthropic' | 'openai' | string;

export interface SchemaValidationResult {
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

interface SchemaValidationContext {
  readonly errors: string[];
  readonly warnings: string[];
}

export function validateToolSchemaForProvider(
  inputSchema: unknown,
  provider: SchemaProvider = 'anthropic',
): SchemaValidationResult {
  const ctx: SchemaValidationContext = { errors: [], warnings: [] };

  if (provider === 'anthropic') {
    validateAnthropic(inputSchema, ctx, '$');
  } else {
    ctx.warnings.push(
      `No constructed-tool schema validator for provider '${provider}'; relying on builtin dispatch path.`,
    );
  }

  return {
    ok: ctx.errors.length === 0,
    errors: ctx.errors,
    warnings: ctx.warnings,
  };
}

// ----------------------------------------------------------------
// Anthropic validator
// ----------------------------------------------------------------

function validateAnthropic(
  schema: unknown,
  ctx: SchemaValidationContext,
  pathStr: string,
): void {
  if (!isPlainObject(schema)) {
    ctx.errors.push(`${pathStr}: input_schema must be a JSON object.`);
    return;
  }

  // Top-level only: must be an object schema with declared properties.
  if (pathStr === '$') {
    if (schema.type !== 'object') {
      ctx.errors.push(
        `${pathStr}.type: Anthropic requires top-level input_schema.type === 'object' (got ${formatLiteral(schema.type)}).`,
      );
    }
    if (!('properties' in schema)) {
      ctx.errors.push(
        `${pathStr}.properties: Anthropic requires top-level input_schema.properties (object).`,
      );
    }
  }

  // $ref is unsupported by Anthropic input_schema (no resolver).
  if ('$ref' in schema) {
    ctx.errors.push(
      `${pathStr}: $ref is not supported by Anthropic input_schema (no schema resolver). Inline the referenced shape.`,
    );
  }

  // Composition keywords have known compatibility wrinkles. Warn rather
  // than block — recent SDK versions handle simple cases.
  for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
    if (key in schema) {
      ctx.warnings.push(
        `${pathStr}.${key}: Anthropic support for '${key}' is partial. Test with the target model before relying on it.`,
      );
    }
  }

  // 'required' must be string[] if present.
  if ('required' in schema) {
    const required = (schema as { required: unknown }).required;
    if (!Array.isArray(required) || required.some((r) => typeof r !== 'string')) {
      ctx.errors.push(
        `${pathStr}.required: must be an array of strings (got ${formatLiteral(required)}).`,
      );
    }
  }

  // Walk into properties and items.
  if (
    isPlainObject((schema as { properties?: unknown }).properties)
  ) {
    const props = (schema as { properties: Record<string, unknown> }).properties;
    for (const [propName, propSchema] of Object.entries(props)) {
      validateAnthropic(propSchema, ctx, `${pathStr}.properties.${propName}`);
    }
  }
  if ('items' in schema) {
    const items = (schema as { items: unknown }).items;
    if (Array.isArray(items)) {
      items.forEach((item, idx) => {
        validateAnthropic(item, ctx, `${pathStr}.items[${idx}]`);
      });
    } else if (items !== undefined) {
      validateAnthropic(items, ctx, `${pathStr}.items`);
    }
  }
}

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatLiteral(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
