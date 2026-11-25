/**
 * Contract test for CAP-025: MCP fallback hint
 *
 * Inventory entry: docs/features/v0.7.29-capability-inventory.md#cap-025-mcp-fallback-resolution
 *
 * Test obligations:
 * - CAP-MCP-FALLBACK-001: a failed built-in names its same-named MCP tool
 *
 * Risk: LOW
 *
 * Class: 1
 *
 * Verified location: agent-runtime/tool-dispatch.ts
 *
 * Time-ordering constraint: AFTER the built-in tool returns `[Tool Error]`;
 * BEFORE the result reaches the model.
 *
 * Active here:
 *   1. **Allow-list gate** - only the read-only/network-fetch tools in
 *      `MCP_FALLBACK_ALLOWED_TOOLS` get a hint.
 *   2. **Name-match gate** - capability `id` ends in `:<toolName>` OR
 *      capability `name` equals `toolName`.
 *   3. **Scope gate** - a capability the run cannot call through `mcp_call`
 *      is never named.
 *   4. **Hint only** - the MCP tool is never executed here. Running it under
 *      the built-in tool's permission would skip plan mode, accept-edits
 *      confirmation and the Auto reviewer that `mcp_call` goes through.
 *   5. **Best-effort** - a failed lookup leaves the original error unchanged.
 */

import { describe, expect, it } from 'vitest';

import type { KodaXToolExecutionContext } from '../../types.js';
import type { CapabilityRuntimeContract } from '../../extensions/runtime-contract.js';
import {
  MCP_FALLBACK_ALLOWED_TOOLS,
  withMcpFallbackHint,
} from '../tool-dispatch.js';

interface FakeMcpHit {
  id?: string;
  name?: string;
}

const TOOL_ERROR = '[Tool Error] read: File not found: docs/guide.md';

function fakeRuntime(opts: { hits?: FakeMcpHit[]; searchThrows?: Error } = {}): {
  runtime: CapabilityRuntimeContract;
  executed: () => number;
} {
  let executions = 0;
  return {
    executed: () => executions,
    runtime: {
      searchCapabilities: async () => {
        if (opts.searchThrows) throw opts.searchThrows;
        return opts.hits ?? [];
      },
      executeCapability: async () => {
        executions += 1;
        return { kind: 'tool', content: 'must-not-run' };
      },
      describeCapability: async () => undefined,
      readCapability: async () => ({ kind: 'resource', content: '' }),
      getCapabilityPrompt: async () => undefined,
      getCapabilityPromptContext: async () => undefined,
    },
  };
}

function makeCtx(runtime: CapabilityRuntimeContract): KodaXToolExecutionContext {
  return { backups: new Map(), extensionRuntime: runtime };
}

describe('CAP-025: MCP fallback hint - allow-list gate', () => {
  it('CAP-MCP-FALLBACK-ALLOWLIST-1: the allowed tool names are exactly read/grep/glob/web_search/web_fetch/code_search/semantic_lookup', () => {
    expect([...MCP_FALLBACK_ALLOWED_TOOLS].sort()).toEqual([
      'code_search', 'glob', 'grep', 'read', 'semantic_lookup', 'web_fetch', 'web_search',
    ]);
  });

  it('CAP-MCP-FALLBACK-ALLOWLIST-2: mutating tools keep their error and never search', async () => {
    let searched = false;
    const { runtime } = fakeRuntime({ hits: [{ id: 'mcp:ops:tool:bash', name: 'bash' }] });
    runtime.searchCapabilities = async () => { searched = true; return []; };
    for (const mutating of ['write', 'edit', 'bash']) {
      expect(await withMcpFallbackHint(mutating, makeCtx(runtime), TOOL_ERROR)).toBe(TOOL_ERROR);
    }
    expect(searched).toBe(false);
  });
});

describe('CAP-025: MCP fallback hint - name and scope gates', () => {
  it('CAP-MCP-FALLBACK-001: names a same-named MCP tool without running it', async () => {
    const { runtime, executed } = fakeRuntime({ hits: [{ id: 'mcp:docs:tool:read', name: 'read' }] });
    const result = await withMcpFallbackHint('read', makeCtx(runtime), TOOL_ERROR);
    expect(result).toMatch(/^\[Tool Error\] read: File not found/);
    expect(result).toContain('mcp_call');
    expect(result).toContain('mcp:docs:tool:read');
    expect(executed()).toBe(0);
  });

  it('CAP-MCP-FALLBACK-NAME-MATCH-2: an id ending in `:<toolName>` also matches', async () => {
    const { runtime } = fakeRuntime({ hits: [{ id: 'mcp:docs:tool:read', name: 'aliased-name' }] });
    expect(await withMcpFallbackHint('read', makeCtx(runtime), TOOL_ERROR)).toContain('mcp:docs:tool:read');
  });

  it('CAP-MCP-FALLBACK-NAME-MISMATCH: a different tool is not named', async () => {
    const { runtime } = fakeRuntime({ hits: [{ id: 'mcp:docs:tool:other', name: 'other' }] });
    expect(await withMcpFallbackHint('read', makeCtx(runtime), TOOL_ERROR)).toBe(TOOL_ERROR);
  });

  it('CAP-MCP-FALLBACK-EMPTY-HITS / MISSING-ID: no usable hit keeps the error', async () => {
    for (const hits of [[], [{ name: 'read' }]]) {
      const { runtime } = fakeRuntime({ hits });
      expect(await withMcpFallbackHint('read', makeCtx(runtime), TOOL_ERROR)).toBe(TOOL_ERROR);
    }
  });

  it('does not name a Host capability that is not bound to the run', async () => {
    const { runtime } = fakeRuntime({ hits: [{ id: 'host:lease-gone:read', name: 'read' }] });
    expect(await withMcpFallbackHint('read', makeCtx(runtime), TOOL_ERROR)).toBe(TOOL_ERROR);
  });

  it('CAP-MCP-FALLBACK-SEARCH-ERROR: a failed lookup keeps the error', async () => {
    const { runtime } = fakeRuntime({ searchThrows: new Error('mcp connection lost') });
    expect(await withMcpFallbackHint('read', makeCtx(runtime), TOOL_ERROR)).toBe(TOOL_ERROR);
  });

  it('appends the hint as a text item to a multimodal error result', async () => {
    const { runtime } = fakeRuntime({ hits: [{ id: 'mcp:docs:tool:read', name: 'read' }] });
    const result = await withMcpFallbackHint('read', makeCtx(runtime), [{ type: 'text', text: TOOL_ERROR }]);
    expect(Array.isArray(result)).toBe(true);
    expect(JSON.stringify(result)).toContain('mcp:docs:tool:read');
  });

  it('leaves a successful result alone', async () => {
    let searched = false;
    const { runtime } = fakeRuntime({ hits: [{ id: 'mcp:docs:tool:read', name: 'read' }] });
    runtime.searchCapabilities = async () => { searched = true; return []; };
    expect(await withMcpFallbackHint('read', makeCtx(runtime), 'file body')).toBe('file body');
    expect(searched).toBe(false);
  });
});
