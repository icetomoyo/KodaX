import type { KodaXToolExecutionContext } from '../types.js';

/** Materialized aliases retain the assembled tool ceiling and explicit target policy. */
export function isMcpCapabilityVisible(id: string, ctx: KodaXToolExecutionContext): boolean {
  const target = ctx.extensionRuntime?.listRunTools?.('mcp').find(tool => tool.capabilityId === id);
  if (target) return !ctx.excludeTools?.includes(target.name)
    && (ctx.discoveryToolNames === undefined || ctx.discoveryToolNames.includes(target.name))
    && (ctx.toolVisibilityPolicy?.(target) ?? true);
  // Host IDs always identify materialized lease tools. Missing means unbound/revoked.
  // Host admission rejects registry-name collisions; builtin mode exclusions cannot acquire a Host alias.
  return !id.startsWith('host:');
}
