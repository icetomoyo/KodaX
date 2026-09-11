import { expect, it } from 'vitest';
import type { CapabilityResult } from '@kodax-ai/llm';
import { toolMcpCall } from './mcp-call.js';
import { toolWebFetch } from './web-fetch.js';
import { executeRunScopedTool } from '../agent-runtime/run-scoped-tools.js';
import { tryMcpFallback } from '../agent-runtime/tool-dispatch.js';
import { isToolResultErrorContent } from '../agent-runtime/tool-result-classify.js';
import type { KodaXToolExecutionContext } from '../types.js';

const image = { type: 'image', path: '/retained-image.png', mediaType: 'image/png' } as const;
const content = [{ type: 'text', text: 'before' }, image, { type: 'text', text: 'after' }] as const;

it.each(['mcp_call', 'run-scoped', 'fallback', 'resource'])(
  '%s preserves image order and explicit provider failure alongside structured evidence', async (route) => {
    const result: CapabilityResult = { kind: 'tool', content, isError: true,
      structuredContent: { title: 'independent evidence' } };
    const ctx = { backups: new Map(), extensionRuntime: {
      executeCapability: async () => result, readCapability: async () => result,
      searchCapabilities: async () => [{ id: 'mcp:test:tool:read', name: 'read' }],
    } } as unknown as KodaXToolExecutionContext;
    const actual = route === 'mcp_call' ? await toolMcpCall({ id: 'mcp:test:tool:read' }, ctx)
      : route === 'resource' ? await toolWebFetch({ provider_id: 'mcp', capability_id: 'image://test' }, ctx)
      : route === 'fallback' ? await tryMcpFallback('read', {}, ctx)
      : await executeRunScopedTool(ctx, { name: 'host_read', description: 'read',
        inputSchema: { type: 'object' }, capabilityId: 'mcp:test:tool:read', sideEffect: 'readonly',
        planModeAllowed: true }, {});
    expect(actual).toBeDefined();
    expect(isToolResultErrorContent(actual!)).toBe(true);
    expect(Array.isArray(actual)).toBe(true);
    if (typeof actual === 'string' || !actual) throw new Error('Expected native image content.');
    expect(actual.slice(1, 4)).toEqual(content);
    expect(JSON.stringify(actual).match(/independent evidence/g)).toHaveLength(1);
    expect(result.content).toBe(content);
  },
);

it('keeps metadata-only MCP fallback evidence visible', async () => {
  const ctx = { backups: new Map(), extensionRuntime: {
    executeCapability: async () => ({ kind: 'tool', metadata: { receipt: 'receipt-42' } }),
    searchCapabilities: async () => [{ id: 'mcp:test:tool:read', name: 'read' }],
  } } as unknown as KodaXToolExecutionContext;
  expect(await tryMcpFallback('read', {}, ctx)).toContain('receipt-42');
});
