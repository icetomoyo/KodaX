import type { KodaXToolExecutionContext } from '../types.js';
import {
  coerceManagedProtocolToolPayload,
  MANAGED_PROTOCOL_TOOL_NAME,
} from '../managed-protocol.js';

type ManagedProtocolRole = 'scout' | 'planner' | 'generator' | 'evaluator';

const SCOPE_AWARENESS_FILE_THRESHOLD = 3;
const SCOPE_AWARENESS_LINES_THRESHOLD = 80;

function buildScopeAwarenessNote(
  tracker: NonNullable<KodaXToolExecutionContext['mutationTracker']>,
  declaredHarness: string | undefined,
): string | undefined {
  if (!declaredHarness || !declaredHarness.startsWith('H0')) return undefined;
  if (tracker.files.size < SCOPE_AWARENESS_FILE_THRESHOLD) {
    const totalLines = [...tracker.files.values()].reduce((a, b) => a + b, 0);
    if (totalLines < SCOPE_AWARENESS_LINES_THRESHOLD) return undefined;
  }

  const fileList = [...tracker.files.entries()]
    .map(([file, lines]) => `  - ${file} (~${lines} lines)`)
    .join('\n');
  const totalLines = [...tracker.files.values()].reduce((a, b) => a + b, 0);

  return [
    `[Scope Observation] You declared H0_DIRECT. Your session has modified ${tracker.files.size} file(s), ~${totalLines} lines:`,
    fileList,
    '',
    'As a senior engineer — would you ship these changes without review?',
    'To keep H0: no action needed, task will complete.',
    'To escalate: call emit_managed_protocol again with H1_EXECUTE_EVAL or H2_PLAN_EXECUTE_EVAL.',
  ].join('\n');
}

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

  // Scope-aware response for Scout: if H0 is declared with significant mutations,
  // include concrete scope data to help the model reconsider if needed.
  if (role === 'scout' && ctx.mutationTracker) {
    const harness = (normalized.scout as Record<string, unknown> | undefined)?.confirmed_harness
      ?? (normalized.scout as Record<string, unknown> | undefined)?.confirmedHarness;
    const scopeNote = buildScopeAwarenessNote(
      ctx.mutationTracker,
      typeof harness === 'string' ? harness : undefined,
    );
    if (scopeNote) {
      return `managed protocol recorded for ${role}\n\n${scopeNote}`;
    }
  }

  return `managed protocol recorded for ${role}`;
}
