import type { KodaXToolExecutionContext } from '../types.js';
import { readOptionalString } from './internal.js';
import { finalizeRetrievalResult } from './retrieval.js';

function formatValue(label: string, value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value === 'string') {
    return `${label}: ${value}`;
  }
  try {
    return `${label}: ${JSON.stringify(value, null, 2)}`;
  } catch {
    return `${label}: ${String(value)}`;
  }
}

export async function toolMcpDescribe(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  try {
    if (!ctx.extensionRuntime) {
      throw new Error('mcp_describe requires an active extension runtime.');
    }

    const id = readOptionalString(input, 'id');
    if (!id) {
      throw new Error('id is required.');
    }

    const descriptor = await ctx.extensionRuntime.describeCapability('mcp', id) as Record<string, unknown> | undefined;
    if (!descriptor) {
      throw new Error(`Unknown MCP capability: ${id}`);
    }

    const content = [
      formatValue('ID', descriptor.id),
      formatValue('Server', descriptor.serverId),
      formatValue('Kind', descriptor.kind),
      formatValue('Name', descriptor.name),
      formatValue('Title', descriptor.title),
      formatValue('Summary', descriptor.summary),
      formatValue('Risk', descriptor.risk),
      formatValue('URI', descriptor.uri),
      formatValue('MIME', descriptor.mimeType),
      formatValue('Input Schema', descriptor.inputSchema),
      formatValue('Output Schema', descriptor.outputSchema),
      formatValue('Prompt Args Schema', descriptor.promptArgsSchema),
      formatValue('Annotations', descriptor.annotations),
    ]
      .filter((line): line is string => line !== undefined)
      .join('\n');

    return finalizeRetrievalResult({
      tool: 'mcp_describe',
      scope: 'remote',
      trust: 'provider',
      freshness: 'unknown',
      provider: 'mcp',
      summary: `Described MCP capability ${id}.`,
      content,
      items: [],
      artifacts: [{
        kind: 'provider',
        label: String(descriptor.name ?? descriptor.id ?? id),
        value: id,
      }],
      metadata: {
        capabilityId: id,
        kind: descriptor.kind,
        serverId: descriptor.serverId,
      },
    }, ctx);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `[Tool Error] mcp_describe: ${message}`;
  }
}
