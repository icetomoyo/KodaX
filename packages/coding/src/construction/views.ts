/**
 * View-layer queries over TOOL_REGISTRY for constructed tools.
 *
 * These are pure read helpers — they do NOT re-implement lookup logic;
 * they enumerate / filter the existing registry stack. Lookup itself
 * remains owned by `getActiveToolRegistration()` in registry.ts (D2
 * decision — no Resolver class).
 */

import { getToolRegistrations, listTools } from '../tools/registry.js';
import type { RegisteredToolDefinition } from '../tools/types.js';

/**
 * All registrations whose source.kind === 'constructed', across every
 * name in the registry. Order: registry insertion order per name; names
 * in `listTools()` order.
 */
export function listConstructed(): RegisteredToolDefinition[] {
  const out: RegisteredToolDefinition[] = [];
  for (const name of listTools()) {
    for (const reg of getToolRegistrations(name)) {
      if (reg.source.kind === 'constructed') {
        out.push(reg);
      }
    }
  }
  return out;
}

/**
 * Locate a specific constructed registration by name + semver. Returns
 * undefined if no match exists. Useful for `revoke()` callers and CLI
 * `inspect` commands.
 */
export function findByVersion(
  name: string,
  version: string,
): RegisteredToolDefinition | undefined {
  return getToolRegistrations(name).find(
    (reg) => reg.source.kind === 'constructed' && reg.source.version === version,
  );
}

/**
 * Every registration in the stack across every name (builtin + extension
 * + constructed). Caller filters as needed.
 */
export function listAll(): RegisteredToolDefinition[] {
  const out: RegisteredToolDefinition[] = [];
  for (const name of listTools()) {
    out.push(...getToolRegistrations(name));
  }
  return out;
}
