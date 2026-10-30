import type { KodaXToolDefinition, KodaXToolCapabilities } from '../types.js';
import { toolParameters } from './tool-constraints.js';

export function projectGoogleTools(provider: string, tools: KodaXToolDefinition[], capabilities: KodaXToolCapabilities, forcedToolName?: string) {
  if (forcedToolName && !tools.some(tool => tool.name === forcedToolName)) throw new Error('Forced tool is absent from cache declarations.');
  const definitions = tools.map(tool => ({ tool, constraints: toolParameters(tool, capabilities, provider) }));
  return { tools: definitions.length ? [{ functionDeclarations: definitions.map(({ tool, constraints }) => ({ name: tool.name, description: tool.description,
    parametersJsonSchema: constraints.input_schema })) }] : [],
    ...(forcedToolName || definitions.some(entry => entry.constraints.strict) ? { toolConfig: { functionCallingConfig: forcedToolName
      ? { mode: 'ANY', allowedFunctionNames: [forcedToolName] } : { mode: 'VALIDATED' } } } : {}) };
}
