import type { KodaXToolCapabilities, KodaXToolDefinition } from '../types.js';
import { KodaXProviderError } from '../errors.js';
import type { ResponseCreateParamsBase } from 'openai/resources/responses/responses';

const SCHEMA_KEYS = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'anyOf', 'enum', 'const',
  '$ref', '$defs', 'definitions', 'description', 'title', 'format', 'minimum', 'maximum', 'multipleOf', 'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems']);
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Tool constraints require an object schema.');
  return value as Record<string, unknown>;
}
function strictSchema(value: unknown, depth = 0): Record<string, unknown> {
  const schema = record(value);
  if (depth > 32 || Object.keys(schema).some(key => !SCHEMA_KEYS.has(key))) throw new Error('Tool schema exceeds the supported strict subset.');
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) throw new Error('Strict tools cannot retain additional properties.');
  const output = structuredClone(schema);
  if (schema.type === 'object' || schema.properties !== undefined) {
    const properties = record(schema.properties ?? {});
    const required = schema.required ?? [];
    if (!Array.isArray(required) || required.some(key => typeof key !== 'string' || !Object.hasOwn(properties, key))) throw new Error('Invalid strict schema required keys.');
    output.properties = Object.fromEntries(Object.entries(properties).map(([key, child]) => {
      const normalized = strictSchema(child, depth + 1);
      const optional = !required.includes(key) && normalized.type !== 'null'
        && !(Array.isArray(normalized.type) && normalized.type.includes('null'));
      return [key, optional ? { anyOf: [normalized, { type: 'null' }] } : normalized];
    }));
    output.required = Object.keys(properties); output.additionalProperties = false;
  }
  if (schema.items !== undefined) output.items = strictSchema(schema.items, depth + 1);
  if (schema.anyOf !== undefined) {
    if (!Array.isArray(schema.anyOf)) throw new Error('Invalid strict anyOf.');
    output.anyOf = schema.anyOf.map(branch => strictSchema(branch, depth + 1));
  }
  for (const key of ['$defs', 'definitions']) {
    if (schema[key] !== undefined) output[key] = Object.fromEntries(Object.entries(record(schema[key])).map(([name, child]) => [name, strictSchema(child, depth + 1)]));
  }
  return output;
}
export function validateToolCapabilities(value: unknown): void {
  if (value === undefined) return;
  const capabilities = record(value);
  if ((capabilities.strict !== undefined && typeof capabilities.strict !== 'boolean') || (capabilities.grammar !== undefined
    && (!Array.isArray(capabilities.grammar) || capabilities.grammar.some(kind => !['lark', 'regex'].includes(kind as string))))) throw new Error('Invalid declared tool capabilities.');
}
export function toolParameters(tool: KodaXToolDefinition, capabilities: KodaXToolCapabilities, provider: string): {
  input_schema: KodaXToolDefinition['input_schema']; strict: boolean;
} {
  if (tool.grammar) toolGrammar(tool, { ...capabilities, grammar: [] }, provider);
  if (tool.strict === undefined) return { input_schema: tool.input_schema, strict: false };
  if (!['require', 'prefer'].includes(tool.strict)) throw new KodaXProviderError('Invalid tool strict policy.', provider, { failureCode: 'request_build_failed', retryable: false });
  try {
    if (!capabilities.strict) throw new Error('This connection/model does not declare strict tools.');
    return { input_schema: strictSchema(tool.input_schema) as KodaXToolDefinition['input_schema'], strict: true };
  } catch (error) {
    if (tool.strict === 'require') throw new KodaXProviderError(error instanceof Error ? error.message : 'Strict tool constraints cannot be satisfied.',
      provider, { failureCode: 'request_build_failed', stage: 'request_build', retryable: false });
    return { input_schema: tool.input_schema, strict: false };
  }
}
export function openAIChatTools(tools: KodaXToolDefinition[], capabilities: KodaXToolCapabilities, provider: string) {
  return tools.map(tool => {
    const constraints = toolParameters(tool, capabilities, provider);
    return { type: 'function' as const, function: { name: tool.name, description: tool.description,
      parameters: constraints.input_schema, ...(constraints.strict ? { strict: true } : {}) } };
  });
}
export function anthropicTools(tools: KodaXToolDefinition[], capabilities: KodaXToolCapabilities, provider: string) {
  return tools.map(tool => {
    const constraints = toolParameters(tool, capabilities, provider);
    return { name: tool.name, description: tool.description, input_schema: constraints.input_schema, ...(constraints.strict ? { strict: true } : {}) };
  });
}
export function withoutPreferredToolConstraints(tools: KodaXToolDefinition[], disabled?: boolean): KodaXToolDefinition[] {
  return disabled ? tools.map(tool => ({ ...tool, ...(tool.strict === 'prefer' ? { strict: undefined } : {}),
    ...(tool.grammar?.mode === 'prefer' ? { grammar: undefined } : {}) })) : tools;
}
export function toolGrammar(tool: KodaXToolDefinition, capabilities: KodaXToolCapabilities, provider: string) {
  if (!tool.grammar) return undefined;
  try {
    const grammar = tool.grammar;
    if (tool.strict !== undefined || !['lark', 'regex'].includes(grammar.syntax) || typeof grammar.definition !== 'string' || !grammar.definition.trim()
      || (grammar.mode !== undefined && !['require', 'prefer'].includes(grammar.mode))) throw new Error('Invalid or conflicting grammar tool constraints.');
    const properties = Object.keys(tool.input_schema.properties);
    const property = properties[0]!;
    if (properties.length !== 1 || !property.trim() || property.length > 256 || record(tool.input_schema.properties[property]).type !== 'string'
      || tool.input_schema.required?.length !== 1 || tool.input_schema.required[0] !== property) throw new Error('Grammar tools require exactly one required string property.');
    if (!capabilities.grammar?.includes(grammar.syntax)) throw new Error('This connection/model does not declare the requested grammar.');
    return { property, format: { type: 'grammar' as const, syntax: grammar.syntax, definition: grammar.definition } };
  } catch (error) {
    if (tool.grammar.mode === 'prefer' && tool.strict === undefined) return undefined;
    throw new KodaXProviderError(error instanceof Error ? error.message : 'Grammar constraints cannot be satisfied.', provider,
      { failureCode: 'request_build_failed', stage: 'request_build', retryable: false });
  }
}
export function responseTools(tools: KodaXToolDefinition[], capabilities: KodaXToolCapabilities, provider: string) {
  const customProperties = new Map<string, string>();
  const names = new Set<string>();
  const wire: NonNullable<ResponseCreateParamsBase['tools']> = tools.map(tool => {
    const grammar = toolGrammar(tool, capabilities, provider);
    if ((grammar && (typeof tool.name !== 'string' || !tool.name.trim() || tool.name.length > 256))
      || (names.has(tool.name) && (grammar || customProperties.has(tool.name)))) throw new KodaXProviderError('Custom tool names must be non-empty and unique.', provider,
        { failureCode: 'request_build_failed', stage: 'request_build', retryable: false });
    names.add(tool.name);
    if (grammar) {
      customProperties.set(tool.name, grammar.property);
      return { type: 'custom' as const, name: tool.name, description: tool.description, format: grammar.format };
    }
    const constraints = toolParameters(tool, capabilities, provider);
    return { type: 'function' as const, name: tool.name, description: tool.description, parameters: constraints.input_schema, strict: constraints.strict };
  });
  return { tools: wire, customProperties };
}
export function isToolConstraintRejection(status: number | undefined, message: string): boolean {
  return (status === 400 || status === 422) && /strict|constrained|grammar|json.?schema/i.test(message)
    && /unsupported|not.support|exceed|too many|limit|invalid schema/i.test(message);
}
