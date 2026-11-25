import { describe, expect, it } from 'vitest';
import { isReadOnlyMcpCall } from './mcp-call.js';

function runtimeWith(annotations: Record<string, unknown> | undefined) {
  return { describeCapability: async () => ({ id: 'mcp:docs:tool:search', annotations }) };
}

describe('isReadOnlyMcpCall', () => {
  it('trusts a server readOnlyHint', async () => {
    await expect(isReadOnlyMcpCall({ id: 'mcp:docs:tool:search' }, runtimeWith({ readOnlyHint: true }))).resolves.toBe(true);
  });

  it('lets a destructive hint win over readOnlyHint', async () => {
    await expect(isReadOnlyMcpCall({ id: 'mcp:docs:tool:search' },
      runtimeWith({ readOnlyHint: true, destructiveHint: true }))).resolves.toBe(false);
  });

  it('treats an unannotated tool as mutating', async () => {
    await expect(isReadOnlyMcpCall({ id: 'mcp:docs:tool:search' }, runtimeWith(undefined))).resolves.toBe(false);
  });

  it('keeps the mutating gate when the target cannot be described', async () => {
    const runtime = { describeCapability: async () => { throw new Error('server offline'); } };
    await expect(isReadOnlyMcpCall({ id: 'mcp:docs:tool:search' }, runtime)).resolves.toBe(false);
    await expect(isReadOnlyMcpCall({}, runtimeWith({ readOnlyHint: true }))).resolves.toBe(false);
    await expect(isReadOnlyMcpCall({ id: 'mcp:docs:tool:search' }, undefined)).resolves.toBe(false);
  });
});
