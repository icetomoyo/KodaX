import type { KodaXToolExecutionContext } from '../types.js';
import { readOptionalString } from './internal.js';
import { finalizeRetrievalResult } from './retrieval.js';

function stringifyValue(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === 'string') {
    return value.trim() || undefined;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export async function toolMcpReadResource(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  try {
    if (!ctx.extensionRuntime) {
      throw new Error('mcp_read_resource requires an active extension runtime.');
    }

    const id = readOptionalString(input, 'id');
    if (!id) {
      throw new Error('id is required.');
    }

    const {
      id: _id,
      ...options
    } = input;
    const result = await ctx.extensionRuntime.readCapability('mcp', id, options);
    return finalizeRetrievalResult({
      tool: 'mcp_read_resource',
      scope: 'remote',
      trust: 'provider',
      freshness: 'unknown',
      provider: 'mcp',
      summary: `Read MCP resource ${id}.`,
      content: stringifyValue(result.content) ?? stringifyValue(result.structuredContent),
      items: [],
      artifacts: [{
        kind: 'provider',
        label: id,
        value: id,
      }],
      metadata: {
        capabilityId: id,
        capabilityKind: result.kind,
        ...(result.metadata ?? {}),
      },
    }, ctx);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `[Tool Error] mcp_read_resource: ${message}`;
  }
}
