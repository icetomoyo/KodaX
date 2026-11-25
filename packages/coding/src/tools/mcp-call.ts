import { normalizeMcpCapabilityId } from '@kodax-ai/agent';
import type { KodaXToolExecutionContext } from '../types.js';
import type { CapabilityRuntimeContract } from '../extensions/runtime-contract.js';
import { readOptionalString } from './internal.js';
import { renderRetrievalResult } from './retrieval.js';
import { renderCapabilityToolResult } from './capability-result.js';
import type { ToolResult } from './types.js';
import { isMcpCapabilityVisible } from './mcp-visibility.js';

function omitRepeatedMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(metadata ?? {}).filter(([key]) => key !== 'providerId' && key !== 'capabilityId'),
  );
}

/**
 * Whether one mcp_call targets a tool its server declares read-only. A
 * destructive hint wins over a read-only one. The hint is server-declared;
 * the user already trusts a configured server to run its own code.
 */
export async function isReadOnlyMcpCall(
  input: Record<string, unknown>,
  runtime: Pick<CapabilityRuntimeContract, 'describeCapability'> | undefined,
): Promise<boolean> {
  const id = readOptionalString(input, 'id');
  if (!id || !runtime) return false;
  let descriptor: unknown;
  try {
    descriptor = await runtime.describeCapability('mcp', normalizeMcpCapabilityId(id));
  } catch {
    // Fail closed: an unknown target keeps the mutating gate, and the call
    // itself reports the real lookup error to the model.
    return false;
  }
  const annotations = (descriptor as { annotations?: unknown } | undefined)?.annotations;
  if (!annotations || typeof annotations !== 'object') return false;
  const hints = annotations as Record<string, unknown>;
  return hints.readOnlyHint === true && hints.destructiveHint !== true && hints.destructive !== true;
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
    if (!isMcpCapabilityVisible(capabilityId, ctx)) throw new Error('Tool is not active in the current execution scope.');

    const args = input.args && typeof input.args === 'object' && !Array.isArray(input.args)
      ? input.args as Record<string, unknown>
      : {};

    const result = await ctx.extensionRuntime.executeCapability('mcp', capabilityId, args, {
      signal: ctx.abortSignal,
    });
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
    }), ctx);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `[Tool Error] mcp_call: ${message}`;
  }
}
