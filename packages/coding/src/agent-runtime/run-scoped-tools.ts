/**
 * Run-scoped tool materialization — Host Tools first-class visibility.
 *
 * A run-bound capability source (e.g. a daemon Host Tool lease) exposes its
 * tools through `ExtensionRuntimeContract.listRunTools`. These helpers bridge
 * those definitions into the existing tool surface WITHOUT the process-global
 * TOOL_REGISTRY, so concurrent runs with different leases never shadow each
 * other:
 *
 *   - tool-table assembly appends run-scoped names plus their model
 *     definitions (schema materialization);
 *   - `applyToolVisibilityPolicy` and the registry metadata predicates accept
 *     a run-scoped definition map as a fallback resolver, keeping fail-closed
 *     semantics for names resolvable nowhere;
 *   - dispatch routes a run-scoped tool call to
 *     `executeCapability('mcp', capabilityId)`, reusing the reverse bridge's
 *     timeout/idempotency/invocation state machine; results render through the
 *     same retrieval pipeline as `mcp_call`.
 */

import type { KodaXToolDefinition } from '@kodax-ai/llm';
import type {
  ExtensionRuntimeContract,
  RunScopedToolDefinition,
} from '../extensions/runtime-contract.js';
import { renderRetrievalResult } from '../tools/retrieval.js';
import { renderCapabilityToolResult } from '../tools/capability-result.js';
import type { ToolResult } from '../tools/types.js';
import type { KodaXToolExecutionContext } from '../types.js';

export function listRunScopedTools(
  runtime: ExtensionRuntimeContract | null | undefined,
  providerId = 'mcp',
): readonly RunScopedToolDefinition[] {
  return runtime?.listRunTools?.(providerId) ?? [];
}

export function runScopedToolMap(
  definitions: readonly RunScopedToolDefinition[],
): ReadonlyMap<string, RunScopedToolDefinition> {
  return new Map(definitions.map((definition) => [definition.name, definition]));
}

export function lookupRunScopedTool(
  runtime: ExtensionRuntimeContract | null | undefined,
  name: string,
  providerId = 'mcp',
): RunScopedToolDefinition | undefined {
  return listRunScopedTools(runtime, providerId).find((definition) => definition.name === name);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Normalize an open lease/embedder schema onto the provider contract
 *  (`{ type: 'object', properties }`); a missing type makes Anthropic-
 *  compatible providers reject the whole request. */
function normalizeInputSchema(
  schema: Readonly<Record<string, unknown>>,
): KodaXToolDefinition['input_schema'] {
  const required = Array.isArray(schema.required)
    ? schema.required.filter((name): name is string => typeof name === 'string')
    : undefined;
  return {
    type: 'object',
    properties: isPlainRecord(schema.properties) ? schema.properties : {},
    ...(required !== undefined ? { required } : {}),
  };
}

export function toModelToolDefinition(definition: RunScopedToolDefinition): KodaXToolDefinition {
  return {
    name: definition.name,
    description: definition.description,
    // Single materialization point shared by the daemon lease path and the
    // embedder path; the reverse-bridge registration gate is bypassed by
    // non-daemon embedders, so normalize here.
    input_schema: normalizeInputSchema(definition.inputSchema),
  };
}

export async function executeRunScopedTool(
  ctx: KodaXToolExecutionContext,
  definition: RunScopedToolDefinition,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  if (!ctx.extensionRuntime) {
    return `[Tool Error] ${definition.name}: Tool is not active in the current runtime.`;
  }
  try {
    const result = await ctx.extensionRuntime.executeCapability(
      'mcp',
      definition.capabilityId,
      input,
    );
    return renderCapabilityToolResult(result, (content) => renderRetrievalResult({
      tool: 'mcp_call',
      scope: 'remote',
      trust: 'provider',
      freshness: 'unknown',
      provider: 'mcp',
      summary: `Executed MCP tool ${definition.capabilityId}.`,
      content,
      items: [],
      metadata: { ...result.metadata, capabilityKind: result.kind },
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `[Tool Error] ${definition.name}: ${message}`;
  }
}
