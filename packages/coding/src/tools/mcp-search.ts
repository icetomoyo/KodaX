import type { KodaXToolExecutionContext } from '../types.js';
import { readOptionalString } from './internal.js';
import { finalizeRetrievalResult } from './retrieval.js';
import type { KodaXRetrievalArtifact, KodaXRetrievalItem } from './types.js';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function clampLimit(input: unknown): number {
  const value = typeof input === 'number' && Number.isFinite(input)
    ? Math.floor(input)
    : 10;
  return Math.max(1, Math.min(20, value));
}

export async function toolMcpSearch(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  try {
    if (!ctx.extensionRuntime) {
      throw new Error('mcp_search requires an active extension runtime.');
    }

    const query = readOptionalString(input, 'query');
    if (!query) {
      throw new Error('query is required.');
    }

    const kind = readOptionalString(input, 'kind');
    const server = readOptionalString(input, 'server');
    const limit = clampLimit(input.limit);
    const results = await ctx.extensionRuntime.searchCapabilities('mcp', query, {
      kind: kind as 'tool' | 'resource' | 'prompt' | undefined,
      limit,
      server,
    });

    const items: KodaXRetrievalItem[] = results.map((entry) => {
      const record = asRecord(entry);
      const kindLabel = readString(record?.kind) ?? 'capability';
      const name = readString(record?.title)
        ?? readString(record?.name)
        ?? readString(record?.id)
        ?? 'mcp capability';
      return {
        title: `[${kindLabel}] ${name}`,
        locator: readString(record?.id),
        snippet: readString(record?.summary),
        metadata: {
          serverId: readString(record?.serverId),
          trust: readString(record?.trust),
          risk: readString(record?.risk),
          kind: kindLabel,
        },
      };
    });
    const artifacts = items.reduce<KodaXRetrievalArtifact[]>((all, item) => {
      if (item.locator) {
        all.push({
          kind: 'provider',
          label: item.title,
          value: item.locator,
        });
      }
      return all;
    }, []);

    return finalizeRetrievalResult({
      tool: 'mcp_search',
      query,
      scope: 'remote',
      trust: 'provider',
      freshness: 'unknown',
      provider: server ? `mcp:${server}` : 'mcp',
      summary: items.length > 0
        ? `Found ${items.length} MCP capability result(s) for "${query}".`
        : `No MCP capability results for "${query}".`,
      items,
      artifacts,
      metadata: {
        kind: kind ?? 'all',
        server: server ?? 'all',
      },
    }, ctx);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `[Tool Error] mcp_search: ${message}`;
  }
}
