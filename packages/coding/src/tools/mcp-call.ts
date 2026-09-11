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

export async function toolMcpCall(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<ToolResult> {
  try {
    if (!ctx.extensionRuntime) {
      throw new Error('mcp_call requires an active extension runtime.');
    }

    const id = readOptionalString(input, 'id');
    if (!id) {
      throw new Error('id is required.');
    }
    const capabilityId = normalizeMcpCapabilityId(id);

    const args = input.args && typeof input.args === 'object' && !Array.isArray(input.args)
      ? input.args as Record<string, unknown>
      : {};

    const result = await ctx.extensionRuntime.executeCapability('mcp', capabilityId, args);
    return renderCapabilityToolResult(result, (content) => renderRetrievalResult({
      tool: 'mcp_call',
      scope: 'remote',
      trust: 'provider',
      freshness: 'unknown',
      provider: 'mcp',
      summary: `Executed MCP tool ${capabilityId}.`,
      content,
      items: [],
      metadata: {
        capabilityKind: result.kind,
        ...omitRepeatedMetadata(result.metadata),
      },
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `[Tool Error] mcp_call: ${message}`;
  }
}
