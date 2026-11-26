import type { KodaXMemoryOutcomeDigest } from '../types.js';
import type {
  MemoryReviewDraftAction,
  MemoryReviewModelInput,
  MemoryReviewPlan,
  MemoryReviewTrigger,
} from './types.js';
import { sanitizePromptSafeMemoryClaim } from './prompt-safety.js';
import { EpisodeReviewFailure } from './review-inbox.js';

export interface LearningReviewVerifierFact {
  readonly ref: string;
  readonly verdict: 'passed' | 'failed' | 'inconclusive';
}

export interface LearningReviewQualification {
  readonly reusableMethodEvidence: boolean;
  readonly independentEpisodeCount: number;
  readonly verifiedOutcome: boolean;
  /**
   * FEATURE_290 §3.3: additive admission signal
   * (`outcome === 'failed' && lesson !== undefined`). No existing predicate
   * reads it; absent on pre-F290 frozen inputs.
   */
  readonly failedWithLesson?: boolean;
}

export interface LearningReviewEvidencePacket {
  readonly outcomeDigest: KodaXMemoryOutcomeDigest;
  readonly verifierFacts: readonly LearningReviewVerifierFact[];
  readonly priorDigests: readonly KodaXMemoryOutcomeDigest[];
  readonly qualification: LearningReviewQualification;
}

export interface UnifiedLearningReviewModelInput {
  readonly cacheDomain: 'learning-review';
  readonly memory: MemoryReviewModelInput;
  readonly evidence: LearningReviewEvidencePacket;
}

export interface UnifiedLearningReviewResult {
  readonly memoryPlan: MemoryReviewPlan;
}

export type UnifiedLearningReviewRunner = (
  input: UnifiedLearningReviewModelInput,
  signal?: AbortSignal,
) => Promise<unknown>;

export function sanitizeUnifiedLearningReviewInput(
  input: UnifiedLearningReviewModelInput,
): UnifiedLearningReviewModelInput {
  return {
    cacheDomain: 'learning-review',
    memory: {
      ...input.memory,
      userFeedback: safeReviewText(input.memory.userFeedback, 'unsafe feedback'),
      ...(input.memory.task === undefined
        ? {}
        : { task: safeReviewText(input.memory.task, 'unsafe task') }),
      sourceRefs: safeReviewRefs(input.memory.sourceRefs),
      candidateRefs: input.memory.candidateRefs
        .filter((candidate) => candidate.ref.visibility === 'prompt_safe')
        .map((candidate) => {
          const {
            storageUri: _storageUri,
            scopeId: _scopeId,
            applicability: _applicability,
            claimKey,
            title,
            sourceRefs,
            relatedRefs,
            ...safeRef
          } = candidate.ref;
          const safeSnippet = candidate.bodySnippet === undefined
            ? undefined
            : sanitizePromptSafeMemoryClaim(candidate.bodySnippet, 512);
          const safeTitle = title === undefined
            ? undefined
            : sanitizePromptSafeMemoryClaim(title, 160);
          const safeClaimKey = claimKey === undefined
            ? undefined
            : sanitizePromptSafeMemoryClaim(claimKey, 160);
          return {
            ref: {
              ...safeRef,
              id: safeReviewText(candidate.ref.id, 'unsafe ref'),
              sourceRefs: safeReviewRefs(sourceRefs),
              relatedRefs: safeReviewRefs(relatedRefs),
              ...(safeTitle === undefined ? {} : { title: safeTitle }),
              ...(safeClaimKey === undefined ? {} : { claimKey: safeClaimKey }),
            },
            ...(safeSnippet === undefined ? {} : { bodySnippet: safeSnippet }),
            ...(candidate.bodyFingerprint === undefined
              ? {}
              : { bodyFingerprint: candidate.bodyFingerprint }),
            warnings: [],
          };
        }),
      warnings: ['provider evidence omits local paths, source warnings, and unsafe text'],
    },
    evidence: {
      outcomeDigest: sanitizeOutcomeDigest(input.evidence.outcomeDigest),
      verifierFacts: input.evidence.verifierFacts.map((fact) => ({
        ...fact,
        ref: safeReviewText(fact.ref, 'unsafe verifier ref'),
      })),
      priorDigests: input.evidence.priorDigests.map(sanitizeOutcomeDigest),
      qualification: input.evidence.qualification,
    },
  };
}

function sanitizeOutcomeDigest(
  digest: KodaXMemoryOutcomeDigest,
): KodaXMemoryOutcomeDigest {
  const { lesson, preconditions, memoryIntent, handledMemoryOperations, ...required } = digest;
  const safeLesson = lesson === undefined
    ? undefined
    : sanitizePromptSafeMemoryClaim(lesson, 512);
  const safePreconditions = preconditions === undefined
    ? undefined
    : sanitizePromptSafeMemoryClaim(preconditions, 512);
  const safeCandidateStatement = memoryIntent === undefined
    ? undefined
    : sanitizePromptSafeMemoryClaim(memoryIntent.candidateStatement, 512);
  const safeUserQuote = memoryIntent === undefined
    ? undefined
    : sanitizePromptSafeMemoryClaim(memoryIntent.userQuote, 512);
  const hasAuthoritativeEvidence = memoryIntent !== undefined
    && digest.evidence?.some((evidence) => (
      evidence.ref === memoryIntent.evidenceRef
      && evidence.grade === 'authoritative'
      && evidence.source === 'user'
    )) === true;
  return {
    ...required,
    objective: safeReviewText(digest.objective, 'unsafe objective'),
    approach: safeReviewText(digest.approach, 'unsafe approach'),
    summary: safeReviewText(digest.summary, 'unsafe summary'),
    evidenceRefs: safeReviewRefs(digest.evidenceRefs),
    ...(digest.evidence === undefined
      ? {}
      : {
          evidence: digest.evidence.map((item) => ({
            ...item,
            ref: safeReviewText(item.ref, 'unsafe evidence ref'),
          })),
        }),
    ...(safeLesson === undefined ? {} : { lesson: safeLesson }),
    ...(safePreconditions === undefined ? {} : { preconditions: safePreconditions }),
    ...(handledMemoryOperations === undefined
      ? {}
      : {
          handledMemoryOperations: handledMemoryOperations.flatMap((operation) => {
            const statement = operation.statement === undefined
              ? undefined
              : sanitizePromptSafeMemoryClaim(operation.statement, 1_024);
            const claimKey = operation.claimKey === undefined
              ? undefined
              : sanitizePromptSafeMemoryClaim(operation.claimKey, 160);
            const targetRefIds = safeReviewRefs(operation.targetRefIds);
            if (statement === undefined && claimKey === undefined && targetRefIds.length === 0) return [];
            return [{
              operation: operation.operation,
              ...(operation.disposition === undefined ? {} : { disposition: operation.disposition }),
              ...(statement === undefined ? {} : { statement }),
              ...(claimKey === undefined ? {} : { claimKey }),
              targetRefIds,
            }];
          }),
        }),
    ...(!hasAuthoritativeEvidence
      || safeCandidateStatement === undefined
      || safeUserQuote === undefined
      ? {}
      : {
          memoryIntent: {
            operation: memoryIntent.operation,
            evidenceRef: safeReviewText(memoryIntent.evidenceRef, 'unsafe intent ref'),
            candidateStatement: safeCandidateStatement,
            userQuote: safeUserQuote,
          },
        }),
  };
}

function safeReviewRefs(refs: readonly string[]): readonly string[] {
  return refs
    .map((ref) => sanitizePromptSafeMemoryClaim(ref, 256))
    .filter((ref): ref is string => ref !== undefined);
}

function safeReviewText(value: string, omission: string): string {
  return sanitizePromptSafeMemoryClaim(value, 1_024) ?? `[omitted: ${omission}]`;
}

export function isUnifiedLearningReviewModelInput(
  value: unknown,
): value is UnifiedLearningReviewModelInput {
  if (!isRecord(value)
    || value.cacheDomain !== 'learning-review'
    || !isRecord(value.memory)
    || !isRecord(value.evidence)) return false;
  const memory = value.memory;
  const evidence = value.evidence;
  const digest = evidence.outcomeDigest;
  const qualification = evidence.qualification;
  return isMemoryReviewTrigger(memory.trigger)
    && typeof memory.userFeedback === 'string'
    && isStringArray(memory.sourceRefs)
    && Array.isArray(memory.candidateRefs)
    && isStringArray(memory.warnings)
    && isRecord(digest)
    && typeof digest.reviewKey === 'string'
    && typeof digest.sessionId === 'string'
    && typeof digest.branchId === 'string'
    && (digest.outcome === 'succeeded'
      || digest.outcome === 'failed'
      || (digest.outcome === 'cancelled' && isIntentOnlyCancelledDigest(digest)))
    && isStringArray(digest.evidenceRefs)
    && Array.isArray(evidence.verifierFacts)
    && Array.isArray(evidence.priorDigests)
    && evidence.priorDigests.length <= 2
    && isRecord(qualification)
    && typeof qualification.reusableMethodEvidence === 'boolean'
    && Number.isSafeInteger(qualification.independentEpisodeCount)
    && typeof qualification.verifiedOutcome === 'boolean'
    && (qualification.failedWithLesson === undefined
      || typeof qualification.failedWithLesson === 'boolean');
}

function isIntentOnlyCancelledDigest(digest: Record<string, unknown>): boolean {
  const intent = digest.memoryIntent;
  const evidence = digest.evidence;
  const evidenceRefs = digest.evidenceRefs;
  if (!isRecord(intent)
    || (intent.operation !== 'remember' && intent.operation !== 'correct')
    || typeof intent.evidenceRef !== 'string'
    || typeof intent.candidateStatement !== 'string'
    || typeof intent.userQuote !== 'string'
    || !Array.isArray(evidence)
    || evidence.length !== 1
    || !Array.isArray(evidenceRefs)
    || evidenceRefs.length !== 1) return false;
  const boundEvidence = evidence[0];
  return isRecord(boundEvidence)
    && boundEvidence.ref === intent.evidenceRef
    && boundEvidence.grade === 'authoritative'
    && boundEvidence.source === 'user'
    && evidenceRefs[0] === intent.evidenceRef
    && digest.objective === intent.candidateStatement
    && digest.approach === 'episode completion'
    && digest.actionSignature === undefined
    && digest.preconditions === undefined
    && digest.lesson === undefined
    && digest.memoryInfluence === undefined;
}

export function normalizeUnifiedLearningReview(
  input: UnifiedLearningReviewModelInput,
  raw: unknown,
): UnifiedLearningReviewResult {
  const record = isRecord(raw) ? raw : {};
  const providerMemoryPlan = normalizeProviderMemoryPlan(
    record.memoryPlan,
    input.memory,
    input.evidence.outcomeDigest,
  );
  if (providerMemoryPlan === undefined) {
    throw new EpisodeReviewFailure(
      'malformed_response',
      'unified reviewer returned an invalid Memory plan',
    );
  }
  const memoryPlan = bindMemoryPlanToInput(
    providerMemoryPlan,
    input.memory,
    input.evidence.outcomeDigest,
    input.evidence.qualification,
  );
  return { memoryPlan };
}

function normalizeProviderMemoryPlan(
  value: unknown,
  input: MemoryReviewModelInput,
  digest: KodaXMemoryOutcomeDigest,
): MemoryReviewPlan | undefined {
  if (isMemoryReviewPlan(value)) return value;
  if (!isRecord(value)
    || !Array.isArray(value.actions)
    || !value.actions.every(isMemoryReviewAction)
    || (value.warnings !== undefined && !isStringArray(value.warnings))) return undefined;
  return {
    trigger: input.trigger,
    createdAt: digest.createdAt,
    sourceRefs: input.sourceRefs,
    candidateRefs: input.candidateRefs,
    actions: value.actions,
    warnings: value.warnings ?? [],
  };
}

function isMemoryReviewPlan(value: unknown): value is MemoryReviewPlan {
  return isRecord(value)
    && isMemoryReviewTrigger(value.trigger)
    && typeof value.createdAt === 'string'
    && isStringArray(value.sourceRefs)
    && Array.isArray(value.candidateRefs)
    && Array.isArray(value.actions)
    && value.actions.every(isMemoryReviewAction)
    && isStringArray(value.warnings);
}

function isMemoryReviewAction(value: unknown): value is MemoryReviewDraftAction {
  if (!isRecord(value)) return false;
  const mutatesMemory = value.action === 'write_memdir'
    || value.action === 'patch_memdir'
    || value.action === 'conflict_report';
  const validClaimKind = ['fact', 'policy', 'preference', 'procedure', 'episode']
    .includes(String(value.claimKind));
  const validClaimKey = typeof value.claimKey === 'string'
    && /^[a-z0-9._:-]{1,160}$/iu.test(value.claimKey.trim());
  return [
    'no_op',
    'link_refs',
    'write_memdir',
    'patch_memdir',
    'handoff_to_skill_loop',
    'quarantine',
    'archive',
    'conflict_report',
  ].includes(String(value.action))
    && isStringArray(value.targetRefIds)
    && typeof value.summary === 'string'
    && typeof value.rationale === 'string'
    && ['low', 'medium', 'high'].includes(String(value.confidence))
    && ['low', 'medium', 'high'].includes(String(value.risk))
    && value.requiresApproval === true
    && optionalString(value.proposedBody)
    && (!mutatesMemory
      || (typeof value.proposedBody === 'string' && value.proposedBody.trim().length > 0))
    && (!mutatesMemory || (validClaimKind && validClaimKey))
    && optionalEnum(value.claimKind, ['fact', 'policy', 'preference', 'procedure', 'episode'])
    && optionalString(value.claimKey)
    && optionalString(value.actionSignature)
    && optionalString(value.preconditions)
    && (value.counterexamples === undefined || isStringArray(value.counterexamples))
    && optionalEnum(value.relationship, ['same_claim', 'condition_refinement', 'conflict']);
}

function isMemoryReviewTrigger(value: unknown): value is MemoryReviewTrigger {
  return [
    'explicit_remember',
    'explicit_forget',
    'user_correction',
    'proposal_rejected',
    'conflict_detected',
    'episode_completed',
  ].includes(String(value));
}

function bindMemoryPlanToInput(
  plan: MemoryReviewPlan,
  input: MemoryReviewModelInput,
  digest: KodaXMemoryOutcomeDigest,
  qualification: LearningReviewQualification,
): MemoryReviewPlan {
  // FEATURE_290 §3.4: proposals whose evidence basis is a failed-with-lesson
  // episode stay in the human approval queue. The deterministic floor
  // overrides the reviewer's self-assessed low risk; medium/high are kept.
  const floorToHumanQueue = qualification.failedWithLesson === true;
  return {
    ...plan,
    trigger: input.trigger,
    createdAt: digest.createdAt,
    sourceRefs: input.sourceRefs,
    candidateRefs: input.candidateRefs,
    warnings: unique([...input.warnings, ...plan.warnings]),
    episodeDigest: digest,
    actions: plan.actions.map((action) => ({
      ...action,
      ...(action.claimKey === undefined ? {} : { claimKey: action.claimKey.trim().toLowerCase() }),
      ...(floorToHumanQueue && action.risk === 'low' ? { risk: 'medium' as const } : {}),
    })),
  };
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function optionalEnum(value: unknown, allowed: readonly string[]): boolean {
  return value === undefined || (typeof value === 'string' && allowed.includes(value));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
