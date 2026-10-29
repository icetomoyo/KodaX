import { normalizeMcpCapabilityId } from '@kodax-ai/agent';
import type { KodaXToolExecutionContext } from '../types.js';
import { readOptionalString } from './internal.js';
import { renderRetrievalResult } from './retrieval.js';
import { renderCapabilityToolResult } from './capability-result.js';
import type { ToolResult } from './types.js';

function omitRepeatedMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(metadata ?? {}).filter(([key]) => key !== 'providerId' && key !== 'capabilityId'),
  );
}

export async function toolMcpReadResource(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<ToolResult> {
  try {
    if (!ctx.extensionRuntime) {
      throw new Error('mcp_read_resource requires an active extension runtime.');
    }

    const id = readOptionalString(input, 'id');
    if (!id) {
      throw new Error('id is required.');
    }
    const capabilityId = normalizeMcpCapabilityId(id);

    const {
      id: _id,
      ...options
    } = input;
    const result = await ctx.extensionRuntime.readCapability('mcp', capabilityId, options);
    return renderCapabilityToolResult(result, content => renderRetrievalResult({
      tool: 'mcp_read_resource',
      scope: 'remote',
      trust: 'provider',
      freshness: 'unknown',
      provider: 'mcp',
      summary: `Read MCP resource ${capabilityId}.`,
      content,
      items: [],
      metadata: {
        capabilityKind: result.kind,
        ...omitRepeatedMetadata(result.metadata),
      },
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `[Tool Error] mcp_read_resource: ${message}`;
  }
}
