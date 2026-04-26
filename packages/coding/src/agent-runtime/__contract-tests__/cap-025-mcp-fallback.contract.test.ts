/**
 * Contract test for CAP-025: MCP fallback resolution
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-025-mcp-fallback-resolution
 *
 * Test obligations:
 * - CAP-MCP-FALLBACK-001: MCP-only tool resolves via fallback
 *
 * Risk: LOW
 *
 * Class: 1
 *
 * Verified location: agent-runtime/tool-dispatch.ts (extracted from
 * agent.ts:1384-1392 + 1394-1428 — pre-FEATURE_100 baseline — during
 * FEATURE_100 P2)
 *
 * Time-ordering constraint: AFTER local registry lookup fails; BEFORE
 * error propagation.
 *
 * Active here:
 *   1. **Allow-list gate** — only the seven read-only/network-fetch
 *      tools in `MCP_FALLBACK_ALLOWED_TOOLS` may fall back. Mutating
 *      tools (`write`, `edit`, `bash`) MUST never silently redirect.
 *   2. **Name-match gate** — capability `id` ends in `:<toolName>` OR
 *      capability `name` equals `toolName`; otherwise return undefined.
 *   3. **Result wrapping** — successful MCP fallback wraps content with
 *      `[MCP Fallback via <id>]` marker so CAP-037 classifiers can
 *      distinguish it from a primary result.
 *   4. **Best-effort error swallow** — exceptions inside the MCP call
 *      return undefined (caller surfaces the original `[Tool Error]`).
 *
 * STATUS: ACTIVE since FEATURE_100 P2.
 */

import { describe, expect, it } from 'vitest';

import type { CapabilityResult } from '@kodax/core';
import type { KodaXToolExecutionContext } from '../../types.js';
import type { ExtensionRuntimeContract } from '../../extensions/runtime-contract.js';
import {
  MCP_FALLBACK_ALLOWED_TOOLS,
  tryMcpFallback,
} from '../tool-dispatch.js';

interface FakeMcpHit {
  id?: string;
  name?: string;
}

function fakeRuntime(opts: {
  hits?: FakeMcpHit[];
  result?: CapabilityResult;
  searchThrows?: Error;
  executeThrows?: Error;
}): ExtensionRuntimeContract {
  return {
    searchCapabilities: async () => {
      if (opts.searchThrows) throw opts.searchThrows;
      return opts.hits ?? [];
    },
    executeCapability: async () => {
      if (opts.executeThrows) throw opts.executeThrows;
      return (opts.result ?? { content: 'mcp-result' }) as CapabilityResult;
    },
    describeCapability: async () => undefined,
    readCapability: async () => ({ content: '' } as CapabilityResult),
    getCapabilityPrompt: async () => undefined,
    getCapabilityPromptContext: async () => undefined,
  };
}

function makeCtx(runtime: ExtensionRuntimeContract): KodaXToolExecutionContext {
  return { backups: new Map(), extensionRuntime: runtime };
}

describe('CAP-025: tryMcpFallback — allow-list gate', () => {
  it('CAP-MCP-FALLBACK-ALLOWLIST-1: the seven allowed tool names are exactly read/grep/glob/web_search/web_fetch/code_search/semantic_lookup (parity guard)', () => {
    expect([...MCP_FALLBACK_ALLOWED_TOOLS].sort()).toEqual([
      'code_search',
      'glob',
      'grep',
      'read',
      'semantic_lookup',
      'web_fetch',
      'web_search',
    ]);
  });

  it('CAP-MCP-FALLBACK-ALLOWLIST-2: mutating tools (`write`, `edit`, `bash`) MUST return undefined without ever calling the runtime — silent redirect would bypass CAP-010 permission gate', async () => {
    let searchCalled = false;
    const runtime: ExtensionRuntimeContract = {
      searchCapabilities: async () => {
        searchCalled = true;
        return [{ id: 'mcp:bash', name: 'bash' }];
      },
      executeCapability: async () => ({ content: 'should-not-execute' } as CapabilityResult),
      describeCapability: async () => undefined,
      readCapability: async () => ({ content: '' } as CapabilityResult),
      getCapabilityPrompt: async () => undefined,
      getCapabilityPromptContext: async () => undefined,
    };

    for (const mutating of ['write', 'edit', 'bash']) {
      expect(await tryMcpFallback(mutating, {}, makeCtx(runtime))).toBeUndefined();
    }
    expect(searchCalled).toBe(false);
  });
});

describe('CAP-025: tryMcpFallback — name-match gate', () => {
  it('CAP-MCP-FALLBACK-001: hit with `name === toolName` resolves and result is wrapped with [MCP Fallback via <id>] marker', async () => {
    const runtime = fakeRuntime({
      hits: [{ id: 'mcp-server-x:read', name: 'read' }],
      result: { content: 'file contents' } as CapabilityResult,
    });

    const result = await tryMcpFallback('read', {}, makeCtx(runtime));
    expect(result).toBe('[MCP Fallback via mcp-server-x:read]\nfile contents');
  });

  it('CAP-MCP-FALLBACK-NAME-MATCH-2: hit with `id` ending in `:<toolName>` (different `name` field) also resolves', async () => {
    const runtime = fakeRuntime({
      hits: [{ id: 'mcp-server:read', name: 'aliased-name' }],
      result: { content: 'ok' } as CapabilityResult,
    });
    const result = await tryMcpFallback('read', {}, makeCtx(runtime));
    expect(result).toContain('[MCP Fallback via mcp-server:read]');
  });

  it('CAP-MCP-FALLBACK-NAME-MISMATCH: hit whose name does NOT match AND whose id does not end in `:<toolName>` → undefined (name-mismatch guard)', async () => {
    const runtime = fakeRuntime({
      hits: [{ id: 'mcp-server:other-tool', name: 'other-tool' }],
    });
    expect(await tryMcpFallback('read', {}, makeCtx(runtime))).toBeUndefined();
  });

  it('CAP-MCP-FALLBACK-EMPTY-HITS: zero hits → undefined', async () => {
    const runtime = fakeRuntime({ hits: [] });
    expect(await tryMcpFallback('read', {}, makeCtx(runtime))).toBeUndefined();
  });

  it('CAP-MCP-FALLBACK-MISSING-ID: hit with no `id` field → undefined', async () => {
    const runtime = fakeRuntime({
      hits: [{ name: 'read' }],
    });
    expect(await tryMcpFallback('read', {}, makeCtx(runtime))).toBeUndefined();
  });
});

describe('CAP-025: tryMcpFallback — result wrapping + error best-effort', () => {
  it('CAP-MCP-FALLBACK-STRUCTURED: structuredContent is JSON-stringified when content is not a string', async () => {
    const runtime = fakeRuntime({
      hits: [{ id: 'mcp:read', name: 'read' }],
      result: { content: undefined, structuredContent: { lines: 42 } } as unknown as CapabilityResult,
    });
    const result = await tryMcpFallback('read', {}, makeCtx(runtime));
    expect(result).toContain('[MCP Fallback via mcp:read]');
    expect(result).toContain('"lines": 42');
  });

  it('CAP-MCP-FALLBACK-SEARCH-ERROR: searchCapabilities throws → undefined (best-effort, original [Tool Error] surfaces)', async () => {
    const runtime = fakeRuntime({ searchThrows: new Error('mcp connection lost') });
    expect(await tryMcpFallback('read', {}, makeCtx(runtime))).toBeUndefined();
  });

  it('CAP-MCP-FALLBACK-EXEC-ERROR: executeCapability throws → undefined', async () => {
    const runtime = fakeRuntime({
      hits: [{ id: 'mcp:read', name: 'read' }],
      executeThrows: new Error('mcp execute failed'),
    });
    expect(await tryMcpFallback('read', {}, makeCtx(runtime))).toBeUndefined();
  });
});
