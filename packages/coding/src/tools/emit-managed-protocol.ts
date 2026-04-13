import type { KodaXToolExecutionContext } from '../types.js';
import {
  coerceManagedProtocolToolPayload,
  MANAGED_PROTOCOL_TOOL_NAME,
} from '../managed-protocol.js';

type ManagedProtocolRole = 'scout' | 'planner' | 'generator' | 'evaluator';

export async function toolEmitManagedProtocol(
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  const role = typeof input.role === 'string'
    ? input.role.trim().toLowerCase()
    : '';
  if (!role || !['scout', 'planner', 'generator', 'evaluator'].includes(role)) {
    return `[Tool Error] ${MANAGED_PROTOCOL_TOOL_NAME}: Missing or invalid required parameter: role`;
  }

  const expectedRole = ctx.managedProtocolRole;
  if (!expectedRole || !ctx.emitManagedProtocol) {
    return `[Tool Error] ${MANAGED_PROTOCOL_TOOL_NAME}: Managed protocol emission is not enabled in this run`;
  }
  if (expectedRole !== role) {
    return `[Tool Error] ${MANAGED_PROTOCOL_TOOL_NAME}: Role mismatch, expected ${expectedRole} but received ${role}`;
  }

  if (!input.payload || typeof input.payload !== 'object' || Array.isArray(input.payload)) {
    return `[Tool Error] ${MANAGED_PROTOCOL_TOOL_NAME}: Missing or invalid required parameter: payload`;
  }

  const normalized = coerceManagedProtocolToolPayload(
    role as ManagedProtocolRole,
    input.payload,
  );
  if (!normalized) {
    return `[Tool Error] ${MANAGED_PROTOCOL_TOOL_NAME}: Payload could not be normalized for role ${role}`;
  }

  ctx.emitManagedProtocol(normalized);

  return `managed protocol recorded for ${role}`;
}
