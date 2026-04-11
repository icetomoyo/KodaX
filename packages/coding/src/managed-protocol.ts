import type {
  KodaXManagedContractPayload,
  KodaXManagedHandoffPayload,
  KodaXManagedProtocolPayload,
  KodaXManagedScoutPayload,
  KodaXManagedVerdictPayload,
  KodaXTaskRole,
} from './types.js';

export const MANAGED_PROTOCOL_TOOL_NAME = 'emit_managed_protocol';
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
    scout: patch?.scout
      ? { ...(base?.scout ?? {}), ...patch.scout }
      : base?.scout,
    contract: patch?.contract
      ? { ...(base?.contract ?? {}), ...patch.contract }
      : base?.contract,
    handoff: patch?.handoff
      ? { ...(base?.handoff ?? {}), ...patch.handoff }
      : base?.handoff,
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
  if (merged.scout && !merged.scout.userFacingText?.trim()) {
    merged.scout = { ...merged.scout, userFacingText: visibleText };
  }
  if (merged.handoff && !merged.handoff.userFacingText?.trim()) {
    merged.handoff = { ...merged.handoff, userFacingText: visibleText };
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

export function normalizeManagedScoutHarness(
  candidate: string,
): KodaXManagedScoutPayload['confirmedHarness'] | undefined {
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
  if (normalized === 'H0_DIRECT' || normalized === 'H0') {
    return 'H0_DIRECT';
  }
  if (normalized === 'H1_EXECUTE_EVAL' || normalized === 'H1') {
    return 'H1_EXECUTE_EVAL';
  }
  if (normalized === 'H2_PLAN_EXECUTE_EVAL' || normalized === 'H2') {
    return 'H2_PLAN_EXECUTE_EVAL';
  }
  return undefined;
}

export function normalizeManagedHandoffStatus(
  candidate: string,
): KodaXManagedHandoffPayload['status'] | undefined {
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
  if (firstToken === 'ready') {
    return 'ready';
  }
  if (firstToken === 'incomplete' || /^partial(?:ly)?$/.test(firstToken)) {
    return 'incomplete';
  }
  if (/^block(?:ed|ing)?$/.test(firstToken) || /^failed?$/.test(firstToken)) {
    return 'blocked';
  }
  return undefined;
}

export function normalizeManagedEvidenceAcquisitionMode(
  candidate: string,
): KodaXManagedScoutPayload['evidenceAcquisitionMode'] | undefined {
  const normalized = candidate
    .trim()
    .toLowerCase()
    .replace(/[`"'()[\]{}<>]+/g, '')
    .replace(/[.:;!?]+$/g, '')
    .replace(/[_\s-]+/g, '-')
    .trim();
  if (normalized === 'overview') {
    return 'overview';
  }
  if (normalized === 'diff-bundle' || normalized === 'bundle') {
    return 'diff-bundle';
  }
  if (normalized === 'diff-slice' || normalized === 'slice') {
    return 'diff-slice';
  }
  if (normalized === 'file-read' || normalized === 'read') {
    return 'file-read';
  }
  return undefined;
}

export function normalizeManagedProjectionConfidence(
  candidate: string,
): NonNullable<KodaXManagedScoutPayload['skillMap']>['projectionConfidence'] | undefined {
  const normalized = candidate
    .trim()
    .toLowerCase()
    .replace(/[`"'()[\]{}<>]+/g, '')
    .replace(/[.:;!?]+$/g, '')
    .trim();
  if (normalized === 'high' || normalized === 'medium' || normalized === 'low') {
    return normalized;
  }
  return undefined;
}

export function normalizeManagedDirectCompletionReady(
  candidate: string,
): KodaXManagedScoutPayload['directCompletionReady'] | undefined {
  const normalized = candidate
    .trim()
    .toLowerCase()
    .replace(/[`"'()[\]{}<>]+/g, '')
    .replace(/[.:;!?]+$/g, '')
    .trim();
  if (normalized === 'yes' || normalized === 'true' || normalized === 'ready') {
    return 'yes';
  }
  if (normalized === 'no' || normalized === 'false' || normalized === 'not-ready' || normalized === 'not ready') {
    return 'no';
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

  if (role === 'evaluator') {
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
      },
    };
  }

  if (role === 'planner') {
    const summary = typeof payload.summary === 'string' ? payload.summary.trim() || undefined : undefined;
    const successCriteria = normalizeStringListValue(payload.success_criteria ?? payload.successCriteria);
    const requiredEvidence = normalizeStringListValue(payload.required_evidence ?? payload.requiredEvidence);
    const constraints = normalizeStringListValue(payload.constraints);
    if (!summary && successCriteria.length === 0 && requiredEvidence.length === 0 && constraints.length === 0) {
      return undefined;
    }
    return {
      contract: {
        summary,
        successCriteria,
        requiredEvidence,
        constraints,
      },
    };
  }

  if (role === 'scout') {
    const summary = typeof payload.summary === 'string' ? payload.summary.trim() || undefined : undefined;
    const scope = normalizeStringListValue(payload.scope);
    const requiredEvidence = normalizeStringListValue(payload.required_evidence ?? payload.requiredEvidence);
    const reviewFilesOrAreas = normalizeStringListValue(payload.review_files_or_areas ?? payload.reviewFilesOrAreas);
    const blockingEvidence = normalizeStringListValue(payload.blocking_evidence ?? payload.blockingEvidence);
    const executionObligations = normalizeStringListValue(payload.execution_obligations ?? payload.executionObligations);
    const verificationObligations = normalizeStringListValue(payload.verification_obligations ?? payload.verificationObligations);
    const ambiguities = normalizeStringListValue(payload.ambiguities);
    const confirmedHarness = typeof (payload.confirmed_harness ?? payload.confirmedHarness) === 'string'
      ? normalizeManagedScoutHarness(String(payload.confirmed_harness ?? payload.confirmedHarness))
      : undefined;
    const evidenceAcquisitionMode = typeof (payload.evidence_acquisition_mode ?? payload.evidenceAcquisitionMode) === 'string'
      ? normalizeManagedEvidenceAcquisitionMode(String(payload.evidence_acquisition_mode ?? payload.evidenceAcquisitionMode))
      : undefined;
    const skillSummary = typeof payload.skill_summary === 'string'
      ? payload.skill_summary.trim() || undefined
      : typeof payload.skillSummary === 'string'
        ? payload.skillSummary.trim() || undefined
        : undefined;
    const projectionConfidence = typeof (payload.projection_confidence ?? payload.projectionConfidence) === 'string'
      ? normalizeManagedProjectionConfidence(String(payload.projection_confidence ?? payload.projectionConfidence))
      : undefined;
    const harnessRationale = typeof (payload.harness_rationale ?? payload.harnessRationale) === 'string'
      ? String(payload.harness_rationale ?? payload.harnessRationale).trim() || undefined
      : undefined;
    const directCompletionReady = typeof (payload.direct_completion_ready ?? payload.directCompletionReady) === 'string'
      ? normalizeManagedDirectCompletionReady(String(payload.direct_completion_ready ?? payload.directCompletionReady))
      : typeof (payload.direct_completion_ready ?? payload.directCompletionReady) === 'boolean'
        ? ((payload.direct_completion_ready ?? payload.directCompletionReady) ? 'yes' : 'no')
        : undefined;
    if (
      !summary
      && scope.length === 0
      && requiredEvidence.length === 0
      && reviewFilesOrAreas.length === 0
      && !confirmedHarness
      && !harnessRationale
      && blockingEvidence.length === 0
      && !directCompletionReady
      && !evidenceAcquisitionMode
      && !skillSummary
      && executionObligations.length === 0
      && verificationObligations.length === 0
      && ambiguities.length === 0
      && !projectionConfidence
      && !visibleText
    ) {
      return undefined;
    }
    return {
      scout: {
        summary,
        scope,
        requiredEvidence,
        reviewFilesOrAreas,
        evidenceAcquisitionMode,
        confirmedHarness,
        harnessRationale,
        blockingEvidence,
        directCompletionReady,
        userFacingText: visibleText || undefined,
        skillMap: skillSummary || executionObligations.length > 0 || verificationObligations.length > 0 || ambiguities.length > 0 || projectionConfidence
          ? {
              skillSummary,
              executionObligations,
              verificationObligations,
              ambiguities,
              projectionConfidence,
            }
          : undefined,
      },
    };
  }

  const status = typeof payload.status === 'string'
    ? normalizeManagedHandoffStatus(payload.status)
    : undefined;
  if (!status) {
    return undefined;
  }
  return {
    handoff: {
      status,
      summary: typeof payload.summary === 'string' ? payload.summary.trim() || undefined : undefined,
      evidence: normalizeStringListValue(payload.evidence),
      followup: normalizeStringListValue(payload.followup ?? payload.followups),
      userFacingText: visibleText,
    },
  };
}
