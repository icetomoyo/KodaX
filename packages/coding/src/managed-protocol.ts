import type {
  KodaXManagedProtocolPayload,
  KodaXManagedVerdictPayload,
  KodaXTaskRole,
} from './types.js';

// FEATURE_193 (v0.7.43) deep V1 cleanup: legacy `emit_managed_protocol` tool
// was the SA-preset entry for the V1 chain (Scout/Planner/Generator). With
// the chain retired and the AMA `worker` role excluding this tool by name
// (`AMA_BASELINE_EXCLUDE`), it is unreachable from V2 production. The
// constant remains so legacy tool-permission / contract tests can continue
// to assert the gate-off semantics; the registered tool implementation has
// been deleted.
export const MANAGED_PROTOCOL_TOOL_NAME = 'emit_managed_protocol';
// NOTE: When adding a new kodax-* fence block name, also add it to
// MANAGED_FENCE_NAMES in task-engine.ts (near sanitizeManagedUserFacingText)
// so that truncated versions are correctly stripped from user-facing output.
// The three V1 block names (CONTRACT / SCOUT / HANDOFF) are retained for
// the sanitizer's defensive fence-detection sweep — LLMs sometimes emit a
// hallucinated `kodax-task-scout` / `kodax-task-handoff` block even after
// the V1 chain retired, and the sanitizer must still strip them before
// user-facing text is shown.
export const MANAGED_TASK_CONTRACT_BLOCK = 'kodax-task-contract';
export const MANAGED_TASK_VERDICT_BLOCK = 'kodax-task-verdict';
export const MANAGED_TASK_SCOUT_BLOCK = 'kodax-task-scout';
export const MANAGED_TASK_HANDOFF_BLOCK = 'kodax-task-handoff';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function isManagedProtocolToolName(name: string): boolean {
  return name.trim().toLowerCase() === MANAGED_PROTOCOL_TOOL_NAME;
}

export function mergeManagedProtocolPayload(
  base: KodaXManagedProtocolPayload | undefined,
  patch: Partial<KodaXManagedProtocolPayload> | undefined,
): KodaXManagedProtocolPayload | undefined {
  if (!base && !patch) {
    return undefined;
  }

  return {
    verdict: patch?.verdict
      ? { ...(base?.verdict ?? {}), ...patch.verdict }
      : base?.verdict,
  };
}

export function hydrateManagedProtocolPayloadVisibleText(
  payload: KodaXManagedProtocolPayload | undefined,
  visibleText: string,
): KodaXManagedProtocolPayload | undefined {
  const merged = mergeManagedProtocolPayload(undefined, payload);
  if (!merged) {
    return undefined;
  }

  if (merged.verdict && !merged.verdict.userFacingText?.trim()) {
    merged.verdict = { ...merged.verdict, userFacingText: visibleText };
  }
  return merged;
}

export function normalizeManagedVerdictStatus(
  candidate: string,
): KodaXManagedVerdictPayload['status'] | undefined {
  const trimmed = candidate.trim().toLowerCase();
  if (!trimmed) {
    return undefined;
  }

  const normalized = trimmed
    .replace(/[`"'()[\]{}<>]+/g, '')
    .replace(/[.:;!?]+$/g, '')
    .replace(/[_\s-]+/g, ' ')
    .trim();
  const firstToken = normalized.split(/\s+/, 1)[0] ?? '';
  if (!firstToken) {
    return undefined;
  }

  if (/^accept(?:ed|s|ing)?$/.test(firstToken) || firstToken === 'approve' || firstToken === 'approved') {
    return 'accept';
  }
  if (/^revis(?:e|ed|es|ing)?$/.test(firstToken)) {
    return 'revise';
  }
  if (/^block(?:ed|ing)?$/.test(firstToken)) {
    return 'blocked';
  }
  return undefined;
}

export function normalizeManagedNextHarness(
  candidate: string,
): KodaXManagedVerdictPayload['nextHarness'] | undefined {
  const trimmed = candidate.trim();
  if (!trimmed) {
    return undefined;
  }
  const normalized = trimmed
    .replace(/[`"'()[\]{}<>]+/g, '')
    .replace(/[.:;!?]+$/g, '')
    .replace(/[\s-]+/g, '_')
    .trim()
    .toUpperCase();
  if (normalized === 'H1_EXECUTE_EVAL' || normalized === 'H1') {
    return 'H1_EXECUTE_EVAL';
  }
  if (normalized === 'H2_PLAN_EXECUTE_EVAL' || normalized === 'H2') {
    return 'H2_PLAN_EXECUTE_EVAL';
  }
  return undefined;
}

export function normalizeStringListValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(/\r?\n/)
      .map((item) => item.replace(/^-+\s*/, '').trim())
      .filter(Boolean);
  }
  return [];
}

export function coerceManagedProtocolToolPayload(
  role: Exclude<KodaXTaskRole, 'direct'>,
  candidate: unknown,
  visibleText = '',
): Partial<KodaXManagedProtocolPayload> | undefined {
  const payload = asRecord(candidate);
  if (!payload) {
    return undefined;
  }

  if (role !== 'evaluator') {
    return undefined;
  }

  const status = typeof payload.status === 'string'
    ? normalizeManagedVerdictStatus(payload.status)
    : undefined;
  if (!status) {
    return undefined;
  }
  return {
    verdict: {
      source: 'evaluator',
      status,
      reason: typeof payload.reason === 'string' ? payload.reason.trim() || undefined : undefined,
      followups: normalizeStringListValue(payload.followup ?? payload.followups),
      userFacingText: visibleText,
      userAnswer: typeof payload.user_answer === 'string'
        ? payload.user_answer.trim() || undefined
        : typeof payload.userAnswer === 'string'
          ? payload.userAnswer.trim() || undefined
          : undefined,
      nextHarness: typeof (payload.next_harness ?? payload.nextHarness) === 'string'
        ? normalizeManagedNextHarness(String(payload.next_harness ?? payload.nextHarness))
        : undefined,
      // Risk-3: Evaluator may flag an explicit budget-extension request
      // via a free-form string (one-line reason). `wrapEmitterWithRecorder`
      // surfaces this to the user regardless of the 90% auto-threshold.
      budgetRequest: typeof (payload.budget_request ?? payload.budgetRequest) === 'string'
        ? String(payload.budget_request ?? payload.budgetRequest).trim() || undefined
        : undefined,
    },
  };
}

/**
 * Map a task role to its required managed protocol fenced-block name.
 */
export function getManagedBlockNameForRole(role: string): string | undefined {
  if (role === 'evaluator') {
    return MANAGED_TASK_VERDICT_BLOCK;
  }
  return undefined;
}

/**
 * Check whether a managed protocol payload already contains the required field for the given role.
 */
export function hasManagedProtocolForRole(
  payload: KodaXManagedProtocolPayload | undefined,
  role: string,
): boolean {
  if (!payload) return false;
  if (role === 'evaluator') {
    return !!payload.verdict;
  }
  return false;
}

/**
 * Lightweight check: does `text` contain a complete fenced block for `blockName`?
 * Uses the same backtick-fence convention as `findLastFencedBlock` in task-engine.
 */
export function textContainsManagedBlock(text: string, blockName: string): boolean {
  const pattern = new RegExp(String.raw`\`\`\`${blockName}\s*[\s\S]*?\`\`\``, 'i');
  return pattern.test(text);
}
