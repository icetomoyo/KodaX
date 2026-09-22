import { createHash, randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  hashMemoryIdentityComponent,
  type MemoryContextIdentity,
} from '../memory/index.js';
import { emitKodaXDiagnostic } from '../diagnostics.js';
import { withLearningFileLock } from '../learning/store-lock.js';
import { getAgentConfigPath } from '../runtime/agent-home.js';
import type { KodaXMemoryOutcomeDigest } from '../types.js';

export interface PendingEpisodeReviewV1 {
  readonly version: 1;
  readonly reviewKey: string;
  readonly digest: KodaXMemoryOutcomeDigest;
  readonly ownerSessionRef: string;
  readonly ownerAgentHash: string;
  readonly ownerProjectHash?: string;
  readonly createdAt: string;
}

export interface PendingEpisodeReviewV2 {
  readonly version: 2;
  readonly jobId: string;
  readonly reviewKey: string;
  readonly digest: KodaXMemoryOutcomeDigest;
  readonly ownerSessionRef: string;
  readonly ownerAgentHash: string;
  readonly ownerProjectHash?: string;
  readonly branchId: string;
  readonly branchEpoch: number;
  readonly authorityCeiling: 'memory_and_project_skill';
  readonly createdAt: string;
}

export type PendingEpisodeReview = PendingEpisodeReviewV1 | PendingEpisodeReviewV2;

export interface PendingEpisodeReviewFilter {
  readonly configHome?: string;
  readonly tenantId: string;
  readonly agentId?: string;
  /** Omit for every project; pass null for ownerless reviews only. */
  readonly projectId?: string | null;
}

export type EpisodeReviewJobStatus =
  | 'pending'
  | 'processing'
  | 'decided'
  | 'completed'
  | 'attention';

export interface EpisodeReviewJobState {
  readonly schemaVersion: 1;
  readonly jobId: string;
  readonly status: EpisodeReviewJobStatus;
  readonly claimEpoch: number;
  readonly claimToken?: string;
  readonly leaseDeadline?: string;
  readonly providerAttempts: number;
  readonly applyAttempts: number;
  readonly applyAttemptsByCarrier: {
    readonly memory: number;
    readonly skill: number;
  };
  readonly completionAttempts: number;
  readonly nextAttemptAt?: string;
  readonly nextApplyAttemptAt?: string;
  readonly nextCompletionAttemptAt?: string;
  readonly lastError?: string;
  readonly updatedAt: string;
}

export interface PendingEpisodeReviewSummary {
  readonly version: 1 | 2;
  readonly jobId?: string;
  readonly reviewKey: string;
  readonly ownerSessionRef: string;
  readonly createdAt: string;
  readonly status: EpisodeReviewJobStatus | 'unknown';
  readonly providerAttempts?: number;
  readonly applyAttempts?: number;
  readonly completionAttempts?: number;
  readonly nextAttemptAt?: string;
  readonly nextApplyAttemptAt?: string;
  readonly nextCompletionAttemptAt?: string;
  readonly lastError?: string;
}

export interface EpisodeReviewClaim {
  readonly jobId: string;
  readonly reviewKey: string;
  readonly ownerSessionRef: string;
  readonly branchId: string;
  readonly branchEpoch: number;
  readonly epoch: number;
  readonly token: string;
  readonly leaseDeadline: string;
}

export interface EpisodeReviewInputSpec {
  readonly evidence: unknown;
  readonly promptRevision: string;
  readonly schemaRevision: string;
  readonly policyRevision: string;
  readonly providerRevision: string;
}

export interface EpisodeReviewInputCheckpoint extends EpisodeReviewInputSpec {
  readonly version: 1;
  readonly jobId: string;
  readonly evidenceBytes: string;
  readonly evidenceHash: string;
  readonly createdAt: string;
}

export interface EpisodeReviewDecisionInput {
  readonly inputHash: string;
  readonly memoryProposalIds: readonly string[];
  readonly requiredCarriers?: readonly ('memory' | 'skill')[];
  readonly memoryPlan?: unknown;
  readonly capabilityDecision?: unknown;
}

export interface EpisodeReviewDecision extends EpisodeReviewDecisionInput {
  readonly version: 1;
  readonly jobId: string;
  readonly decisionId: string;
  readonly committedAt: string;
}

export interface EpisodeReviewActionInput {
  readonly actionId: string;
  readonly decisionId: string;
  readonly carrier: 'memory' | 'skill';
  readonly resultRefs: readonly string[];
}

export interface EpisodeReviewActionReceipt extends EpisodeReviewActionInput {
  readonly version: 1;
  readonly jobId: string;
  readonly committedAt: string;
}

export type EpisodeReviewFailureKind =
  | 'provider_timeout'
  | 'provider_error'
  | 'malformed_response'
  | 'shutdown'
  | 'budget_unavailable'
  | 'provider_unavailable';

export class EpisodeReviewFailure extends Error {
  constructor(
    readonly kind: EpisodeReviewFailureKind,
    message: string,
  ) {
    super(message);
    this.name = 'EpisodeReviewFailure';
  }
}

export interface EpisodeReviewJobSnapshot {
  readonly envelope: PendingEpisodeReviewV2;
  readonly state: EpisodeReviewJobState;
  readonly input?: EpisodeReviewInputCheckpoint;
  readonly decision?: EpisodeReviewDecision;
  readonly actions: readonly EpisodeReviewActionReceipt[];
}

export interface EpisodeReviewReceipt {
  readonly version: 1;
  readonly jobId?: string;
  readonly reviewKey: string;
  readonly ownerAgentHash?: string;
  readonly ownerProjectHash?: string;
  readonly proposalIds: readonly string[];
  readonly completedAt: string;
}

export type EpisodeReviewDrainEligibility = 'eligible' | 'discard' | 'defer';

export interface EpisodeReviewDrainOptions {
  readonly maxEntries?: number;
  /** Process this just-persisted job before bounded backlog work. */
  readonly preferredJobId?: string;
  /** Skip unrelated backlog when searching across alternate project identities. */
  readonly onlyPreferred?: boolean;
  /** Epoch-ms deadline: stop claiming new jobs once passed and release an
   * in-flight claim instead of committing a decision. */
  readonly deadlineAtMs?: number;
  /** Cancel new work and await the active reviewer before releasing its claim.
   * Owned reviewers must honor their signal and settle; neither cancellation nor
   * the provider timeout detaches a still-running owned reviewer. */
  readonly abortSignal?: AbortSignal;
  readonly revalidate: (
    entry: PendingEpisodeReview,
  ) => Promise<EpisodeReviewDrainEligibility>;
  readonly review: (
    entry: PendingEpisodeReview,
    signal?: AbortSignal,
  ) => Promise<readonly string[]>;
  readonly prepareV2Input?: (
    entry: PendingEpisodeReviewV2,
  ) => Promise<EpisodeReviewInputSpec>;
  readonly decideV2?: (
    entry: PendingEpisodeReviewV2,
    input: EpisodeReviewInputCheckpoint,
    signal: AbortSignal,
  ) => Promise<EpisodeReviewDecisionInput>;
  readonly listV2Actions?: (
    entry: PendingEpisodeReviewV2,
    decision: EpisodeReviewDecision,
  ) => readonly ('memory' | 'skill')[];
  readonly applyV2Action?: (
    entry: PendingEpisodeReviewV2,
    decision: EpisodeReviewDecision,
    carrier: 'memory' | 'skill',
    claim: EpisodeReviewClaim,
    commitWithAuthority: (
      effect: (revalidateAuthority: () => Promise<void>) => Promise<readonly string[]>,
    ) => Promise<readonly string[]>,
  ) => Promise<readonly string[]>;
  readonly onV2Completed?: (
    entry: PendingEpisodeReviewV2,
    decision: EpisodeReviewDecision,
    proposalIds: readonly string[],
  ) => Promise<void>;
}

interface EpisodeReviewBranchAuthority {
  readonly schemaVersion: 1;
  readonly epoch: number;
  readonly rewinds: readonly {
    readonly epoch: number;
    readonly throughSequence: number;
    readonly createdAt: string;
  }[];
  readonly exactFences?: readonly {
    readonly epoch: number;
    readonly retiredJobIds: readonly string[];
    readonly createdAt: string;
  }[];
}

export interface EpisodeReviewDrainResult {
  readonly reviewed: number;
  readonly discarded: number;
  readonly deferred: number;
  readonly failed: number;
  readonly failures: readonly {
    readonly reviewKey: string;
    readonly error: string;
  }[];
}

const REVIEW_CLAIM_STALE_MS = 5 * 60_000;
const REVIEW_AUTHORITY_LOCK_ACQUIRE_TIMEOUT_MS = REVIEW_CLAIM_STALE_MS;

export class EpisodeReviewBranchChangedError extends Error {
  constructor() {
    super('episode review branch changed before persistence');
    this.name = 'EpisodeReviewBranchChangedError';
  }
}

export async function captureEpisodeReviewBranchEpoch(
  identity: MemoryContextIdentity,
): Promise<number> {
  return withEpisodeReviewSessionLock(
    identity,
    async () => (await readOrCreateBranchAuthority(identity)).epoch,
  );
}

export async function persistPendingEpisodeReview(
  identity: MemoryContextIdentity,
  digest: KodaXMemoryOutcomeDigest,
  options: {
    readonly expectedBranchEpoch?: number;
    readonly persistOwner?: (entry: PendingEpisodeReviewV2) => Promise<void>;
  } = {},
): Promise<{ readonly path: string; readonly entry: PendingEpisodeReviewV2 }> {
  if (!isOutcomeDigest(digest)) {
    throw new Error('invalid outcome digest for review inbox');
  }
  if (digest.sessionId !== identity.sessionId) {
    throw new Error('outcome digest session does not match review-inbox owner');
  }
  return withEpisodeReviewSessionLock(identity, async () => {
    const branchAuthority = await readOrCreateBranchAuthority(identity);
    if (options.expectedBranchEpoch !== undefined
      && options.expectedBranchEpoch !== branchAuthority.epoch) {
      throw new EpisodeReviewBranchChangedError();
    }
    const entry: PendingEpisodeReviewV2 = {
      version: 2,
      jobId: episodeReviewJobId(identity, digest, branchAuthority.epoch),
      reviewKey: digest.reviewKey,
      digest,
      ownerSessionRef: identity.sessionId,
      ownerAgentHash: hashMemoryIdentityComponent('agent', identity.agentId),
      ...(identity.projectId !== undefined
        ? { ownerProjectHash: hashMemoryIdentityComponent('project', identity.projectId) }
        : {}),
      branchId: digest.branchId,
      branchEpoch: branchAuthority.epoch,
      authorityCeiling: 'memory_and_project_skill',
      createdAt: digest.createdAt,
    };
    const target = pendingV2Path(identity, entry.jobId);
    await withEpisodeReviewJobLock(identity, entry.jobId, async () => {
      const state = await readJobState(identity, entry.jobId);
      if (state?.status === 'completed' || state?.status === 'attention') return;
      const existing = await readV2Envelope(target);
      if (existing !== undefined && existing.jobId !== entry.jobId) {
        throw new Error('v2 review job path collision');
      }
      if (existing === undefined) await writeJsonAtomic(target, entry);
      if (state === undefined) {
        await writeJsonAtomic(jobStatePath(identity, entry.jobId), {
          schemaVersion: 1,
          jobId: entry.jobId,
          status: 'pending',
          claimEpoch: 0,
          providerAttempts: 0,
          applyAttempts: 0,
          applyAttemptsByCarrier: { memory: 0, skill: 0 },
          completionAttempts: 0,
          updatedAt: entry.createdAt,
        } satisfies EpisodeReviewJobState);
      }
    });
    await options.persistOwner?.(entry);
    return { path: target, entry };
  });
}

export async function claimEpisodeReview(
  identity: MemoryContextIdentity,
  reviewKeyOrJobId: string,
  options: {
    readonly now?: Date;
    readonly leaseMs?: number;
  } = {},
): Promise<EpisodeReviewClaim | undefined> {
  const now = options.now ?? new Date();
  const leaseMs = Math.max(1_000, options.leaseMs ?? REVIEW_CLAIM_STALE_MS);
  return withEpisodeReviewSessionLock(identity, async () => {
    const envelope = await resolvePendingV2Envelope(identity, reviewKeyOrJobId);
    if (envelope === undefined) return undefined;
    return withEpisodeReviewJobLock(identity, envelope.jobId, async () => {
      const state = await readJobState(identity, envelope.jobId);
      const branchAuthority = await readOrCreateBranchAuthority(identity);
      if (state === undefined || isRewound(envelope, branchAuthority)) return undefined;
      if (state.status === 'completed' || state.status === 'attention') return undefined;
      if (state.nextAttemptAt !== undefined && Date.parse(state.nextAttemptAt) > now.getTime()) {
        return undefined;
      }
      if (state.nextApplyAttemptAt !== undefined
        && Date.parse(state.nextApplyAttemptAt) > now.getTime()) {
        return undefined;
      }
      if (state.nextCompletionAttemptAt !== undefined
        && Date.parse(state.nextCompletionAttemptAt) > now.getTime()) {
        return undefined;
      }
      if (state.claimToken !== undefined
        && state.leaseDeadline !== undefined
        && Date.parse(state.leaseDeadline) > now.getTime()) {
        return undefined;
      }
      const epoch = state.claimEpoch + 1;
      const token = randomUUID();
      const leaseDeadline = new Date(now.getTime() + leaseMs).toISOString();
      await writeJsonAtomic(jobStatePath(identity, envelope.jobId), {
        ...state,
        status: 'processing',
        nextAttemptAt: undefined,
        nextApplyAttemptAt: undefined,
        nextCompletionAttemptAt: undefined,
        claimEpoch: epoch,
        claimToken: token,
        leaseDeadline,
        updatedAt: now.toISOString(),
      } satisfies EpisodeReviewJobState);
      return {
        jobId: envelope.jobId,
        reviewKey: envelope.reviewKey,
        ownerSessionRef: envelope.ownerSessionRef,
        branchId: envelope.branchId,
        branchEpoch: envelope.branchEpoch,
        epoch,
        token,
        leaseDeadline,
      };
    });
  });
}

export async function freezeEpisodeReviewInput(
  identity: MemoryContextIdentity,
  claim: EpisodeReviewClaim,
  spec: EpisodeReviewInputSpec,
  now = new Date(),
): Promise<EpisodeReviewInputCheckpoint> {
  assertNonEmptyString(spec.promptRevision, 'promptRevision');
  assertNonEmptyString(spec.schemaRevision, 'schemaRevision');
  assertNonEmptyString(spec.policyRevision, 'policyRevision');
  assertNonEmptyString(spec.providerRevision, 'providerRevision');
  return withEpisodeReviewSessionLock(identity, () => {
    return withEpisodeReviewJobLock(identity, claim.jobId, async () => {
      await assertAuthoritativeClaim(identity, claim, now);
      const existing = await readTypedJson(
        jobInputPath(identity, claim.jobId),
        isEpisodeReviewInputCheckpoint,
      );
      if (existing !== undefined) {
        assertEpisodeReviewInputIdentity(existing, claim.jobId);
        return existing;
      }
      const evidenceBytes = stableJson(spec.evidence);
      const checkpoint: EpisodeReviewInputCheckpoint = {
        version: 1,
        jobId: claim.jobId,
        evidence: JSON.parse(evidenceBytes) as unknown,
        evidenceBytes,
        evidenceHash: sha256(evidenceBytes),
        promptRevision: spec.promptRevision,
        schemaRevision: spec.schemaRevision,
        policyRevision: spec.policyRevision,
        providerRevision: spec.providerRevision,
        createdAt: now.toISOString(),
      };
      await writeJsonAtomic(jobInputPath(identity, claim.jobId), checkpoint);
      return checkpoint;
    });
  });
}

export async function commitEpisodeReviewDecision(
  identity: MemoryContextIdentity,
  claim: EpisodeReviewClaim,
  input: EpisodeReviewDecisionInput,
  now = new Date(),
): Promise<EpisodeReviewDecision> {
  assertNonEmptyStrings(input.memoryProposalIds, 'memoryProposalIds');
  const requiredCarriers = input.requiredCarriers ?? ['memory'];
  assertUniqueEpisodeReviewCarriers(requiredCarriers);
  if (!requiredCarriers.includes('memory')) {
    throw new Error('requiredCarriers must include memory');
  }
  return withEpisodeReviewSessionLock(identity, () => {
    return withEpisodeReviewJobLock(identity, claim.jobId, async () => {
      const state = await assertAuthoritativeClaim(identity, claim, now);
      const checkpoint = await readTypedJson(
        jobInputPath(identity, claim.jobId),
        isEpisodeReviewInputCheckpoint,
      );
      if (checkpoint === undefined) {
        throw new Error('review decision requires a frozen input');
      }
      assertEpisodeReviewInputIdentity(checkpoint, claim.jobId);
      const existing = await readTypedJson(
        jobDecisionPath(identity, claim.jobId),
        isEpisodeReviewDecision,
      );
      if (existing !== undefined) {
        assertEpisodeReviewDecisionIdentity(
          existing,
          claim.jobId,
          checkpoint.evidenceHash,
        );
        return existing;
      }
      if (checkpoint.evidenceHash !== input.inputHash) {
        throw new Error('review decision does not reference the frozen input');
      }
      const committedAt = now.toISOString();
      const decision: EpisodeReviewDecision = {
        version: 1,
        jobId: claim.jobId,
        decisionId: sha256(`${claim.jobId}:${input.inputHash}`),
        inputHash: input.inputHash,
        memoryProposalIds: [...input.memoryProposalIds],
        requiredCarriers: [...requiredCarriers],
        ...(input.memoryPlan === undefined ? {} : { memoryPlan: input.memoryPlan }),
        ...(input.capabilityDecision === undefined
          ? {}
          : { capabilityDecision: input.capabilityDecision }),
        committedAt,
      };
      await writeJsonAtomic(jobDecisionPath(identity, claim.jobId), decision);
      await writeJsonAtomic(jobStatePath(identity, claim.jobId), {
        ...state,
        status: 'decided',
        updatedAt: committedAt,
      } satisfies EpisodeReviewJobState);
      return decision;
    });
  });
}

export async function commitEpisodeReviewAction(
  identity: MemoryContextIdentity,
  claim: EpisodeReviewClaim,
  input: EpisodeReviewActionInput,
  now = new Date(),
): Promise<EpisodeReviewActionReceipt> {
  return withEpisodeReviewSessionLock(identity, () => {
    return commitEpisodeReviewActionWithSessionFence(identity, claim, input, now);
  });
}

export async function withEpisodeReviewClaimAuthority<T>(
  identity: MemoryContextIdentity,
  claim: EpisodeReviewClaim,
  operation: (revalidateAuthority: () => Promise<void>) => Promise<T>,
): Promise<T> {
  return withEpisodeReviewSessionLock(identity, async () => {
    await assertEpisodeReviewClaimWithSessionFence(identity, claim);
    return operation(async () => {
      await assertEpisodeReviewClaimWithSessionFence(identity, claim);
    });
  });
}

async function commitEpisodeReviewActionWithSessionFence(
  identity: MemoryContextIdentity,
  claim: EpisodeReviewClaim,
  input: EpisodeReviewActionInput,
  now = new Date(),
): Promise<EpisodeReviewActionReceipt> {
  assertNonEmptyString(input.actionId, 'actionId');
  assertNonEmptyString(input.decisionId, 'decisionId');
  assertEpisodeReviewCarrier(input.carrier);
  assertNonEmptyStrings(input.resultRefs, 'resultRefs');
  return withEpisodeReviewJobLock(identity, claim.jobId, async () => {
    await assertAuthoritativeClaim(identity, claim, now);
    const checkpoint = await readTypedJson(
      jobInputPath(identity, claim.jobId),
      isEpisodeReviewInputCheckpoint,
    );
    if (checkpoint === undefined) {
      throw new Error('review action requires a frozen input');
    }
    assertEpisodeReviewInputIdentity(checkpoint, claim.jobId);
    const decision = await readTypedJson(
      jobDecisionPath(identity, claim.jobId),
      isEpisodeReviewDecision,
    );
    if (decision === undefined) {
      throw new Error('review action does not reference the committed decision');
    }
    assertEpisodeReviewDecisionIdentity(decision, claim.jobId, checkpoint.evidenceHash);
    if (decision.requiredCarriers !== undefined
      && !decision.requiredCarriers.includes(input.carrier)) {
      throw new Error(`review action carrier is not required: ${input.carrier}`);
    }
    const expectedActionId = `${decision.decisionId}:${input.carrier}`;
    if (decision.decisionId !== input.decisionId || input.actionId !== expectedActionId) {
      throw new Error('review action does not use the committed deterministic identity');
    }
    const receiptPath = jobActionPath(identity, claim.jobId, input.actionId);
    const existing = await readTypedJson(receiptPath, isEpisodeReviewActionReceipt);
    if (existing !== undefined) {
      assertEpisodeReviewActionReceiptIdentity(existing, {
        jobId: claim.jobId,
        actionId: input.actionId,
        decisionId: input.decisionId,
        carrier: input.carrier,
      });
      return existing;
    }
    const receipt: EpisodeReviewActionReceipt = {
      version: 1,
      jobId: claim.jobId,
      actionId: input.actionId,
      decisionId: input.decisionId,
      carrier: input.carrier,
      resultRefs: [...input.resultRefs],
      committedAt: now.toISOString(),
    };
    await writeJsonAtomic(receiptPath, receipt);
    return receipt;
  });
}

async function assertEpisodeReviewClaimWithSessionFence(
  identity: MemoryContextIdentity,
  claim: EpisodeReviewClaim,
): Promise<void> {
  await withEpisodeReviewJobLock(identity, claim.jobId, async () => {
    await assertAuthoritativeClaim(identity, claim, new Date());
  });
}

export async function failEpisodeReviewAttempt(
  identity: MemoryContextIdentity,
  claim: EpisodeReviewClaim,
  failure: {
    readonly kind: EpisodeReviewFailureKind;
    readonly message: string;
  },
  now = new Date(),
): Promise<EpisodeReviewJobState> {
  return withEpisodeReviewSessionLock(identity, () => {
    return withEpisodeReviewJobLock(identity, claim.jobId, async () => {
      const state = await assertAuthoritativeClaim(identity, claim, now);
      const consumesAttempt = failure.kind === 'provider_timeout'
        || failure.kind === 'provider_error'
        || failure.kind === 'malformed_response';
      const providerAttempts = state.providerAttempts + (consumesAttempt ? 1 : 0);
      const exhausted = providerAttempts >= 4;
      const retryDelay = consumesAttempt && !exhausted
        ? [60_000, 5 * 60_000, 30 * 60_000][providerAttempts - 1]
        : undefined;
      const nextState: EpisodeReviewJobState = {
        ...state,
        status: exhausted ? 'attention' : 'pending',
        providerAttempts,
        ...(retryDelay === undefined
          ? { nextAttemptAt: undefined }
          : { nextAttemptAt: new Date(now.getTime() + retryDelay).toISOString() }),
        lastError: failure.message,
        claimToken: undefined,
        leaseDeadline: undefined,
        updatedAt: now.toISOString(),
      };
      await writeJsonAtomic(jobStatePath(identity, claim.jobId), nextState);
      return nextState;
    });
  });
}

export async function failEpisodeReviewApply(
  identity: MemoryContextIdentity,
  claim: EpisodeReviewClaim,
  failure: {
    readonly carrier: 'memory' | 'skill';
    readonly message: string;
  },
  now = new Date(),
): Promise<EpisodeReviewJobState> {
  return withEpisodeReviewSessionLock(identity, () => {
    return withEpisodeReviewJobLock(identity, claim.jobId, async () => {
      const state = await assertAuthoritativeClaim(identity, claim, now);
      const carrierAttempts = state.applyAttemptsByCarrier[failure.carrier] + 1;
      const applyAttemptsByCarrier = {
        ...state.applyAttemptsByCarrier,
        [failure.carrier]: carrierAttempts,
      };
      const applyAttempts = applyAttemptsByCarrier.memory + applyAttemptsByCarrier.skill;
      const exhausted = carrierAttempts >= 4;
      const retryDelay = exhausted
        ? undefined
        : [60_000, 5 * 60_000, 30 * 60_000][carrierAttempts - 1];
      const nextState: EpisodeReviewJobState = {
        ...state,
        status: exhausted ? 'attention' : 'pending',
        applyAttempts,
        applyAttemptsByCarrier,
        ...(retryDelay === undefined
          ? { nextApplyAttemptAt: undefined }
          : { nextApplyAttemptAt: new Date(now.getTime() + retryDelay).toISOString() }),
        lastError: `${failure.carrier} apply failed: ${failure.message}`,
        claimToken: undefined,
        leaseDeadline: undefined,
        updatedAt: now.toISOString(),
      };
      await writeJsonAtomic(jobStatePath(identity, claim.jobId), nextState);
      return nextState;
    });
  });
}

async function failEpisodeReviewCompletion(
  identity: MemoryContextIdentity,
  claim: EpisodeReviewClaim,
  message: string,
  now = new Date(),
): Promise<EpisodeReviewJobState> {
  return withEpisodeReviewSessionLock(identity, () => {
    return withEpisodeReviewJobLock(identity, claim.jobId, async () => {
      const state = await assertAuthoritativeClaim(identity, claim, now);
      const completionAttempts = state.completionAttempts + 1;
      const exhausted = completionAttempts >= 4;
      const retryDelay = exhausted
        ? undefined
        : [60_000, 5 * 60_000, 30 * 60_000][completionAttempts - 1];
      const nextState: EpisodeReviewJobState = {
        ...state,
        status: exhausted ? 'attention' : 'pending',
        completionAttempts,
        ...(retryDelay === undefined
          ? { nextCompletionAttemptAt: undefined }
          : { nextCompletionAttemptAt: new Date(now.getTime() + retryDelay).toISOString() }),
        lastError: `completion delivery failed: ${message}`,
        claimToken: undefined,
        leaseDeadline: undefined,
        updatedAt: now.toISOString(),
      };
      await writeJsonAtomic(jobStatePath(identity, claim.jobId), nextState);
      return nextState;
    });
  });
}

export async function deferEpisodeReview(
  identity: MemoryContextIdentity,
  claim: EpisodeReviewClaim,
  reason: string,
  now = new Date(),
): Promise<EpisodeReviewJobState> {
  return withEpisodeReviewSessionLock(identity, () => {
    return withEpisodeReviewJobLock(identity, claim.jobId, async () => {
      const state = await assertAuthoritativeClaim(identity, claim, now);
      const next: EpisodeReviewJobState = {
        ...state,
        status: 'pending',
        lastError: reason,
        claimToken: undefined,
        leaseDeadline: undefined,
        updatedAt: now.toISOString(),
      };
      await writeJsonAtomic(jobStatePath(identity, claim.jobId), next);
      return next;
    });
  });
}

export async function completeFencedEpisodeReview(
  identity: MemoryContextIdentity,
  claim: EpisodeReviewClaim,
  proposalIds: readonly string[],
  now = new Date(),
): Promise<{ readonly acknowledged: boolean; readonly receiptPath: string }> {
  return withEpisodeReviewSessionLock(identity, () =>
    completeFencedEpisodeReviewWithSessionFence(identity, claim, proposalIds, now));
}

async function completeFencedEpisodeReviewWithSessionFence(
  identity: MemoryContextIdentity,
  claim: EpisodeReviewClaim,
  proposalIds: readonly string[],
  now = new Date(),
): Promise<{ readonly acknowledged: boolean; readonly receiptPath: string }> {
  assertNonEmptyStrings(proposalIds, 'proposalIds');
  return withEpisodeReviewJobLock(identity, claim.jobId, async () => {
    const state = await assertAuthoritativeClaim(identity, claim, now);
    const input = await readTypedJson(
      jobInputPath(identity, claim.jobId),
      isEpisodeReviewInputCheckpoint,
    );
    if (input === undefined) throw new Error('review completion requires a frozen input');
    assertEpisodeReviewInputIdentity(input, claim.jobId);
    const decision = await readTypedJson(
      jobDecisionPath(identity, claim.jobId),
      isEpisodeReviewDecision,
    );
    if (decision === undefined) throw new Error('review completion requires a decision');
    assertEpisodeReviewDecisionIdentity(decision, claim.jobId, input.evidenceHash);
    const actions = await readVerifiedEpisodeReviewActions(
      identity,
      claim.jobId,
      decision,
    );
    const requiredCarriers = decision.requiredCarriers ?? ['memory'];
    const committedCarriers = new Set(actions.map((action) => action.carrier));
    for (const carrier of requiredCarriers) {
      if (!committedCarriers.has(carrier)) {
        throw new Error(`review completion is missing required ${carrier} action receipt`);
      }
    }
    const committedMemoryRefs = actions
      .filter((action) => action.carrier === 'memory')
      .flatMap((action) => action.resultRefs);
    if (!sameStrings(committedMemoryRefs, proposalIds)) {
      throw new Error('review completion payload mismatch');
    }
    const receiptPath = await writeEpisodeReviewReceipt(
      identity,
      claim.reviewKey,
      proposalIds,
      claim.jobId,
    );
    await writeJsonAtomic(jobStatePath(identity, claim.jobId), {
      ...state,
      status: 'completed',
      claimToken: undefined,
      leaseDeadline: undefined,
      updatedAt: now.toISOString(),
    } satisfies EpisodeReviewJobState);
    await removeCompletedPendingBestEffort(
      pendingV2Path(identity, claim.jobId),
      claim.jobId,
    );
    return { acknowledged: true, receiptPath };
  });
}

export async function discardFencedEpisodeReview(
  identity: MemoryContextIdentity,
  claim: EpisodeReviewClaim,
  reason: string,
  now = new Date(),
): Promise<void> {
  await withEpisodeReviewSessionLock(identity, () => {
    return withEpisodeReviewJobLock(identity, claim.jobId, async () => {
      const state = await assertAuthoritativeClaim(identity, claim, now);
      await writeJsonAtomic(jobStatePath(identity, claim.jobId), {
        ...state,
        status: 'completed',
        lastError: reason,
        claimToken: undefined,
        leaseDeadline: undefined,
        updatedAt: now.toISOString(),
      } satisfies EpisodeReviewJobState);
      await removeCompletedPendingBestEffort(
        pendingV2Path(identity, claim.jobId),
        claim.jobId,
      );
    });
  });
}

export async function inspectEpisodeReviewJob(
  identity: MemoryContextIdentity,
  reviewKeyOrJobId: string,
): Promise<EpisodeReviewJobSnapshot | undefined> {
  return withEpisodeReviewSessionLock(identity, async () => {
    const envelope = await resolvePendingV2Envelope(identity, reviewKeyOrJobId);
    if (envelope === undefined) return undefined;
    const state = await readJobState(identity, envelope.jobId);
    if (state === undefined) return undefined;
    const input = await readTypedJson(
      jobInputPath(identity, envelope.jobId),
      isEpisodeReviewInputCheckpoint,
    );
    if (input !== undefined) assertEpisodeReviewInputIdentity(input, envelope.jobId);
    const decision = await readTypedJson(
      jobDecisionPath(identity, envelope.jobId),
      isEpisodeReviewDecision,
    );
    if (decision !== undefined) {
      if (input === undefined) throw new Error('review decision is missing its frozen input');
      assertEpisodeReviewDecisionIdentity(decision, envelope.jobId, input.evidenceHash);
    }
    const actions = await readVerifiedEpisodeReviewActions(
      identity,
      envelope.jobId,
      decision,
    );
    return {
      envelope,
      state,
      ...(input === undefined ? {} : { input }),
      ...(decision === undefined ? {} : { decision }),
      actions,
    };
  });
}

async function readVerifiedEpisodeReviewActions(
  identity: MemoryContextIdentity,
  jobId: string,
  decision: EpisodeReviewDecision | undefined,
): Promise<readonly EpisodeReviewActionReceipt[]> {
  const actions: EpisodeReviewActionReceipt[] = [];
  const actionsRoot = jobActionsRoot(identity, jobId);
  for (const filename of await readJsonFiles(actionsRoot)) {
    const receipt = await readTypedJson(
      path.join(actionsRoot, filename),
      isEpisodeReviewActionReceipt,
    );
    if (receipt === undefined) continue;
    if (decision === undefined) {
      throw new Error('review action receipt is missing its committed decision');
    }
    const expectedActionId = `${decision.decisionId}:${receipt.carrier}`;
    if (filename !== `${safeKey(expectedActionId)}.json`) {
      throw new Error('review action receipt identity mismatch');
    }
    assertEpisodeReviewActionReceiptIdentity(receipt, {
      jobId,
      actionId: expectedActionId,
      decisionId: decision.decisionId,
      carrier: receipt.carrier,
    });
    if (decision.requiredCarriers !== undefined
      && !decision.requiredCarriers.includes(receipt.carrier)) {
      throw new Error(`review action receipt carrier is not required: ${receipt.carrier}`);
    }
    actions.push(receipt);
  }
  return actions.sort((left, right) => left.actionId.localeCompare(right.actionId));
}

interface PendingEpisodeReviewRecord {
  readonly entry: PendingEpisodeReview;
  readonly state?: EpisodeReviewJobState;
  readonly stateError?: string;
  readonly completed?: boolean;
}

async function countForeignProjectPendingReviews(
  filter: Pick<PendingEpisodeReviewFilter, 'configHome' | 'tenantId' | 'agentId'>,
): Promise<number> {
  const tenantRoot = tenantInboxRoot(filter.tenantId, filter.configHome);
  const expectedAgent = filter.agentId === undefined
    ? undefined
    : hashMemoryIdentityComponent('agent', filter.agentId);
  let count = 0;
  for (const sessionDir of await readDirectories(tenantRoot)) {
    const pendingDir = path.join(tenantRoot, sessionDir, 'pending');
    for (const filename of await readJsonFiles(pendingDir)) {
      try {
        const record = await readPendingRecord(path.join(pendingDir, filename), {
          cleanupCompleted: false,
          tolerateInvalidState: true,
          ownerMatches: (entry) => (
            entry.ownerProjectHash !== undefined
            && (expectedAgent === undefined || entry.ownerAgentHash === expectedAgent)
          ),
        });
        if (record !== undefined && record.completed !== true) count += 1;
      } catch (error) {
        count += 1;
        emitKodaXDiagnostic({
          source: 'memory.review-inbox',
          level: 'warn',
          message: 'Foreign project review could not be classified during deferred counting.',
          detail: { sessionDir, filename, error: error instanceof Error ? error.message : String(error) },
        });
      }
    }
  }
  return count;
}

async function scanPendingEpisodeReviews(
  filter: PendingEpisodeReviewFilter,
  tolerateInvalidState = false,
): Promise<readonly PendingEpisodeReviewRecord[]> {
  const tenantRoot = tenantInboxRoot(filter.tenantId, filter.configHome);
  const expectedAgent = filter.agentId === undefined
    ? undefined
    : hashMemoryIdentityComponent('agent', filter.agentId);
  const expectedProject = typeof filter.projectId === 'string'
    ? hashMemoryIdentityComponent('project', filter.projectId)
    : undefined;
  const ownerMatches = (entry: PendingEpisodeReview): boolean => (
    (expectedAgent === undefined || entry.ownerAgentHash === expectedAgent)
    && (filter.projectId === undefined
      || (filter.projectId === null
        ? entry.ownerProjectHash === undefined
        : entry.ownerProjectHash === expectedProject))
  );
  const sessionDirs = await readDirectories(tenantRoot);
  const records: PendingEpisodeReviewRecord[] = [];
  for (const sessionDir of sessionDirs) {
    try {
      await recoverStaleClaimsWithAuthority(
        filter.configHome,
        tenantRoot,
        sessionDir,
        ownerMatches,
      );
    } catch (error) {
      if (!tolerateInvalidState) throw error;
      emitKodaXDiagnostic({
        source: 'memory.review-inbox',
        level: 'warn',
        message: 'Episode review summary skipped stale-claim recovery for an invalid Session.',
        detail: { sessionDir, error: error instanceof Error ? error.message : String(error) },
      });
    }
    const pendingDir = path.join(tenantRoot, sessionDir, 'pending');
    for (const filename of await readJsonFiles(pendingDir)) {
      const record = await readPendingRecord(
        path.join(pendingDir, filename),
        { tolerateInvalidState, ownerMatches },
      );
      if (record === undefined) continue;
      records.push(record);
    }
  }
  return records.sort((left, right) =>
    left.entry.createdAt.localeCompare(right.entry.createdAt)
    || left.entry.reviewKey.localeCompare(right.entry.reviewKey));
}

export async function listPendingEpisodeReviews(
  filter: PendingEpisodeReviewFilter,
): Promise<readonly PendingEpisodeReview[]> {
  return (await scanPendingEpisodeReviews(filter)).map((record) => record.entry);
}

export async function listPendingEpisodeReviewSummaries(
  filter: PendingEpisodeReviewFilter,
): Promise<readonly PendingEpisodeReviewSummary[]> {
  return (await scanPendingEpisodeReviews(filter, true)).map(({ entry, state, stateError }) => ({
    version: entry.version,
    ...(entry.version === 2 ? { jobId: entry.jobId } : {}),
    reviewKey: entry.reviewKey,
    ownerSessionRef: entry.ownerSessionRef,
    createdAt: entry.createdAt,
    status: entry.version === 1 ? 'pending' : state?.status ?? 'unknown',
    ...(state === undefined ? {} : {
      providerAttempts: state.providerAttempts,
      applyAttempts: state.applyAttempts,
      completionAttempts: state.completionAttempts,
      ...(state.nextAttemptAt === undefined ? {} : { nextAttemptAt: state.nextAttemptAt }),
      ...(state.nextApplyAttemptAt === undefined
        ? {}
        : { nextApplyAttemptAt: state.nextApplyAttemptAt }),
      ...(state.nextCompletionAttemptAt === undefined
        ? {}
        : { nextCompletionAttemptAt: state.nextCompletionAttemptAt }),
      ...(state.lastError === undefined ? {} : { lastError: state.lastError }),
    }),
    ...(state === undefined && stateError !== undefined ? { lastError: stateError } : {}),
  }));
}

export async function completeEpisodeReview(
  identity: MemoryContextIdentity,
  reviewKey: string,
  proposalIds: readonly string[],
): Promise<{ readonly acknowledged: boolean; readonly receiptPath: string }> {
  assertNonEmptyString(reviewKey, 'reviewKey');
  assertNonEmptyStrings(proposalIds, 'proposalIds');
  return withEpisodeReviewSessionLock(identity, async () => {
    const v2 = await resolvePendingV2Envelope(identity, reviewKey);
    if (v2 !== undefined) {
      throw new Error(
        'v2 episode review requires frozen input, a committed decision, and action receipts',
      );
    }
    const legacyPath = pendingPath(identity, reviewKey);
    const pending = await readPending(legacyPath, { cleanupCompleted: false });
    const receiptPath = episodeReviewReceiptPath(sessionInboxRoot(identity), reviewKey);
    const existingReceipt = await readTypedJson(receiptPath, isEpisodeReviewReceipt);
    if (pending === undefined) {
      if (existingReceipt === undefined) {
        throw new Error('pending legacy episode review was not found');
      }
      assertEpisodeReviewReceiptIdentity(
        existingReceipt,
        reviewKey,
        undefined,
        receiptPath,
        proposalIds,
        identity,
      );
      return { acknowledged: true, receiptPath };
    }
    if (pending.version !== 1 || pending.reviewKey !== reviewKey) {
      throw new Error('legacy episode review identity mismatch');
    }
    assertEpisodeReviewOwnerIdentity(pending, identity);
    if (existingReceipt !== undefined) {
      assertEpisodeReviewReceiptEntryOwner(existingReceipt, pending);
      assertEpisodeReviewReceiptIdentity(
        existingReceipt,
        reviewKey,
        undefined,
        receiptPath,
        proposalIds,
      );
      await removeCompletedPendingBestEffort(legacyPath, reviewKey);
      return { acknowledged: true, receiptPath };
    }
    const committedReceiptPath = await writeEpisodeReviewReceipt(
      identity,
      reviewKey,
      proposalIds,
    );
    await removeCompletedPendingBestEffort(legacyPath, reviewKey);
    return { acknowledged: true, receiptPath: committedReceiptPath };
  });
}

/**
 * Establishes the lock order used by both review completion and Session branch
 * mutation: the Session root registry first, every sorted tenant branch fence
 * next, then the caller-owned Session transaction. The supplied fence operation
 * runs without reacquiring those locks, so a mutation can fence its prospective
 * lineage and persist that exact lineage atomically with respect to review
 * effects, new tenant registration and completion delivery.
 */
export async function withPendingEpisodeReviewSessionFence<T>(
  input: {
    readonly configHome?: string;
    readonly sessionId: string;
  },
  operation: (
    fence: (activeReviewIds: readonly string[]) => Promise<number>,
  ) => Promise<T>,
): Promise<T> {
  return withEpisodeReviewRootRegistryLock(input, async () => {
    const sessionRoots = [...await findSessionInboxRoots(input)].sort();
    return withEpisodeReviewRootLocks(sessionRoots, 0, () => operation(
      async (activeReviewIds) => {
        const active = new Set(activeReviewIds);
        const plans: EpisodeReviewMutationPlan[] = [];
        for (const sessionRoot of sessionRoots) {
          plans.push(await prepareEpisodeReviewMutationPlan(
            sessionRoot,
            ({ entry }) => !isActiveReview(entry, active),
            ({ entry, queue }) =>
              queue === 'processing' && isActiveReview(entry, active),
          ));
        }
        let removed = 0;
        for (const plan of plans) {
          removed += await applyFenceEpisodeReviewPlan(plan);
        }
        return removed;
      },
    ));
  });
}

async function findSessionInboxRoots(input: {
  readonly configHome?: string;
  readonly sessionId: string;
}): Promise<readonly string[]> {
  const tenantsRoot = input.configHome === undefined
    ? getAgentConfigPath('memory-review-inbox')
    : path.join(input.configHome, 'memory-review-inbox');
  const sessionDirectory = hashMemoryIdentityComponent('session', input.sessionId);
  let tenantDirectories: Dirent[];
  try {
    tenantDirectories = await readdir(tenantsRoot, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const roots: string[] = [];
  for (const tenant of tenantDirectories) {
    if (!tenant.isDirectory() || tenant.name.startsWith('.')) continue;
    const sessionRoot = path.join(tenantsRoot, tenant.name, sessionDirectory);
    try {
      if ((await stat(sessionRoot)).isDirectory()) roots.push(sessionRoot);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  return roots;
}

async function withEpisodeReviewRootLocks<T>(
  sessionRoots: readonly string[],
  index: number,
  operation: () => Promise<T>,
): Promise<T> {
  const sessionRoot = sessionRoots[index];
  if (sessionRoot === undefined) return operation();
  return withLearningFileLock(
    path.join(sessionRoot, '.branch-authority.lock'),
    () => withEpisodeReviewRootLocks(sessionRoots, index + 1, operation),
    REVIEW_AUTHORITY_LOCK_ACQUIRE_TIMEOUT_MS,
  );
}

interface EpisodeReviewMutationPlan {
  readonly sessionRoot: string;
  readonly authorityFile: string;
  readonly current: EpisodeReviewBranchAuthority;
  readonly retired: readonly QueuedReviewFile[];
  readonly recoverable: readonly QueuedReviewFile[];
  readonly retiredStates: ReadonlyMap<string, EpisodeReviewJobState | undefined>;
}

async function prepareEpisodeReviewMutationPlan(
  sessionRoot: string,
  shouldRetire: (queued: QueuedReviewFile) => boolean,
  shouldRecover: (queued: QueuedReviewFile) => boolean,
): Promise<EpisodeReviewMutationPlan> {
  const queued = await listQueuedReviewFiles(sessionRoot);
  const authorityFile = path.join(sessionRoot, 'branch-authority.json');
  const current = await readBranchAuthorityAtPath(authorityFile);
  const retired = queued.filter(shouldRetire);
  const retiredStates = new Map<string, EpisodeReviewJobState | undefined>();
  for (const { entry } of retired) {
    if (entry.version !== 2 || retiredStates.has(entry.jobId)) continue;
    const state = await readTypedJson(
      path.join(sessionRoot, 'jobs', safeKey(entry.jobId), 'state.json'),
      isEpisodeReviewJobState,
    );
    if (state !== undefined && state.jobId !== entry.jobId) {
      throw new Error(`review job state identity mismatch: ${entry.jobId}`);
    }
    retiredStates.set(entry.jobId, state);
  }
  return {
    sessionRoot,
    authorityFile,
    current,
    retired,
    recoverable: queued.filter(shouldRecover),
    retiredStates,
  };
}

async function applyFenceEpisodeReviewPlan(
  plan: EpisodeReviewMutationPlan,
): Promise<number> {
  const now = new Date().toISOString();
  const epoch = plan.current.epoch + 1;
  await writeJsonAtomic(plan.authorityFile, {
    ...plan.current,
    epoch,
    exactFences: [
      ...(plan.current.exactFences ?? []),
      ...(plan.retired.some(({ entry }) => entry.version === 2)
        ? [{
            epoch,
            retiredJobIds: plan.retired
              .flatMap(({ entry }) => entry.version === 2 ? [entry.jobId] : [])
              .sort(),
            createdAt: now,
          }]
        : []),
    ],
  } satisfies EpisodeReviewBranchAuthority);

  let removed = 0;
  for (const { entry, filePath } of plan.retired) {
    if (entry.version === 2) {
      const root = path.join(plan.sessionRoot, 'jobs', safeKey(entry.jobId));
      await withLearningFileLock(path.join(root, '.authority.lock'), async () => {
        const stateFile = path.join(root, 'state.json');
        const state = plan.retiredStates.get(entry.jobId);
        if (state !== undefined && state.status !== 'completed') {
          await writeJsonAtomic(stateFile, {
            ...state,
            status: 'completed',
            claimToken: undefined,
            leaseDeadline: undefined,
            lastError: 'review job is outside the active Session branch',
            updatedAt: now,
          } satisfies EpisodeReviewJobState);
        }
        await rm(filePath, { force: true });
      });
    } else {
      await rm(filePath, { force: true });
    }
    removed += 1;
  }
  await restoreQueuedReviewFiles(plan.sessionRoot, plan.recoverable);
  return removed;
}

function isActiveReview(
  entry: PendingEpisodeReview,
  activeReviewIds: ReadonlySet<string>,
): boolean {
  return (entry.version === 2 && activeReviewIds.has(entry.jobId))
    || activeReviewIds.has(entry.digest.id);
}

export async function drainPendingEpisodeReviews(
  identity: MemoryContextIdentity,
  options: EpisodeReviewDrainOptions,
): Promise<EpisodeReviewDrainResult> {
  if (options.abortSignal?.aborted) {
    return { reviewed: 0, discarded: 0, deferred: 0, failed: 0, failures: [] };
  }
  const ownerFilter = {
    ...(identity.configHome === undefined ? {} : { configHome: identity.configHome }),
    tenantId: identity.tenantId,
    agentId: identity.agentId,
  } satisfies PendingEpisodeReviewFilter;
  const listed = await listPendingEpisodeReviews({
    ...ownerFilter,
    projectId: identity.projectId ?? null,
  });
  const preferred = options.preferredJobId === undefined
    ? undefined
    : listed.find((entry) => entry.version === 2 && entry.jobId === options.preferredJobId);
  const owned = options.onlyPreferred === true
    ? (preferred === undefined ? [] : [preferred])
    : preferred === undefined
      ? (listed.length < 2 ? listed : [listed[listed.length - 1]!, ...listed.slice(0, -1)])
      : [preferred, ...listed.filter((entry) => entry !== preferred)];
  const foreignProjectCount = identity.projectId === undefined && options.onlyPreferred !== true
    ? await countForeignProjectPendingReviews(ownerFilter)
    : 0;
  const maxEntries = Math.max(1, Math.min(8, options.maxEntries ?? 8));
  const result: {
    reviewed: number;
    discarded: number;
    deferred: number;
    failed: number;
    failures: Array<{ reviewKey: string; error: string }>;
  } = {
    reviewed: 0,
    discarded: 0,
    deferred: foreignProjectCount,
    failed: 0,
    failures: [],
  };
  let spentEntries = 0;
  let visitedEntries = 0;
  for (const entry of owned) {
    if (options.abortSignal?.aborted) break;
    if (spentEntries >= maxEntries) break;
    // Past the deadline no new job is claimed; unvisited entries are counted
    // as deferred by the tail accounting below.
    if (options.deadlineAtMs !== undefined && Date.now() >= options.deadlineAtMs) break;
    visitedEntries += 1;
    const ownerIdentity = { ...identity, sessionId: entry.ownerSessionRef };
    if (entry.version === 2) {
      const outcome = await drainFencedEpisodeReview(ownerIdentity, entry, options);
      // Deferred work released its claim without progress; like an unclaimed
      // entry it must not consume the per-drain entry budget.
      if (outcome.kind === 'not_claimed' || outcome.kind === 'deferred') {
        result.deferred += 1;
        continue;
      }
      spentEntries += 1;
      if (outcome.kind === 'reviewed') result.reviewed += 1;
      else if (outcome.kind === 'discarded') result.discarded += 1;
      else if (outcome.kind === 'failed') {
        result.failed += 1;
        result.failures.push({ reviewKey: entry.reviewKey, error: outcome.error });
      }
      continue;
    }
    const outcome = await drainLegacyEpisodeReview(ownerIdentity, entry, options);
    if (outcome.kind === 'not_claimed' || outcome.kind === 'deferred') {
      result.deferred += 1;
      continue;
    }
    spentEntries += 1;
    if (outcome.kind === 'reviewed') result.reviewed += 1;
    else if (outcome.kind === 'discarded') result.discarded += 1;
    else if (outcome.kind === 'failed') {
      result.failed += 1;
      result.failures.push({
        reviewKey: entry.reviewKey,
        error: outcome.error,
      });
    }
  }
  result.deferred += Math.max(0, owned.length - visitedEntries);
  return result;
}

async function drainLegacyEpisodeReview(
  identity: MemoryContextIdentity,
  entry: PendingEpisodeReviewV1,
  options: EpisodeReviewDrainOptions,
): Promise<
  | { readonly kind: 'reviewed' | 'discarded' | 'deferred' | 'not_claimed' }
  | { readonly kind: 'failed'; readonly error: string }
> {
  return withEpisodeReviewSessionLock(identity, async () => {
    if (options.abortSignal?.aborted) return { kind: 'deferred' };
    const claimPath = await claimPendingReview(identity, entry.reviewKey);
    if (claimPath === undefined) return { kind: 'not_claimed' };
    try {
      options.abortSignal?.throwIfAborted();
      const eligibility = await options.revalidate(entry);
      options.abortSignal?.throwIfAborted();
      if (eligibility === 'defer') {
        await restoreClaim(identity, entry, claimPath);
        return { kind: 'deferred' };
      }
      if (eligibility === 'discard') {
        await rm(claimPath, { force: true });
        return { kind: 'discarded' };
      }
      const proposalIds = await options.review(entry, options.abortSignal);
      // A successful legacy effect has no action checkpoint: commit its receipt
      // even if shutdown arrived during the effect, so recovery cannot replay it.
      await writeEpisodeReviewReceipt(identity, entry.reviewKey, proposalIds);
      await removeCompletedPendingBestEffort(claimPath, entry.reviewKey);
      return { kind: 'reviewed' };
    } catch (error) {
      await restoreClaim(identity, entry, claimPath);
      if (isReviewDrainCancellation(error, options.abortSignal)) return { kind: 'deferred' };
      return {
        kind: 'failed',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

async function drainFencedEpisodeReview(
  identity: MemoryContextIdentity,
  entry: PendingEpisodeReviewV2,
  options: EpisodeReviewDrainOptions,
): Promise<
  | { readonly kind: 'reviewed' | 'discarded' | 'deferred' | 'not_claimed' }
  | { readonly kind: 'failed'; readonly error: string }
> {
  const claim = await claimEpisodeReview(identity, entry.jobId);
  if (claim === undefined) return { kind: 'not_claimed' };
  let applyingCarrier: 'memory' | 'skill' | undefined;
  let decisionCommitted = false;
  let deliveringCompletion = false;
  try {
    options.abortSignal?.throwIfAborted();
    const eligibility = await options.revalidate(entry);
    options.abortSignal?.throwIfAborted();
    if (eligibility === 'defer') {
      await deferEpisodeReview(identity, claim, 'review eligibility deferred');
      return { kind: 'deferred' };
    }
    if (eligibility === 'discard') {
      await discardFencedEpisodeReview(identity, claim, 'review eligibility discarded');
      return { kind: 'discarded' };
    }
    const snapshot = await inspectEpisodeReviewJob(identity, entry.jobId);
    options.abortSignal?.throwIfAborted();
    const input = snapshot?.input ?? await freezeEpisodeReviewInput(
      identity,
      claim,
      options.prepareV2Input === undefined
        ? {
            evidence: { outcomeDigest: entry.digest },
            promptRevision: 'memory-review-compat-v1',
            schemaRevision: 'memory-review-plan-v1',
            policyRevision: 'memory-review-policy-v1',
            providerRevision: 'host-injected',
          }
        : await options.prepareV2Input(entry),
    );
    options.abortSignal?.throwIfAborted();
    let decision = snapshot?.decision;
    decisionCommitted = decision !== undefined;
    if (decision === undefined) {
      let decisionInput: EpisodeReviewDecisionInput;
      try {
        decisionInput = options.decideV2 === undefined
          ? { inputHash: input.evidenceHash, memoryProposalIds: [] }
          : await decideEpisodeReviewWithHardTimeout(
            options.decideV2, entry, input, options.abortSignal,
          );
      } catch (error) {
        if (isReviewDrainCancellation(error, options.abortSignal)) throw error;
        const message = error instanceof Error ? error.message : String(error);
        const kind = classifyEpisodeReviewFailure(error);
        await failEpisodeReviewAttempt(
          identity,
          claim,
          { kind, message },
        );
        return { kind: 'failed', error: message };
      }
      options.abortSignal?.throwIfAborted();
      const beforeDecision = await options.revalidate(entry);
      options.abortSignal?.throwIfAborted();
      if (beforeDecision !== 'eligible') {
        if (beforeDecision === 'discard') {
          await discardFencedEpisodeReview(identity, claim, 'review branch changed before decision');
          return { kind: 'discarded' };
        }
        await deferEpisodeReview(identity, claim, 'review branch unavailable before decision');
        return { kind: 'deferred' };
      }
      // Enforce the drain deadline before committing: release the claim instead of
      // leaving the job in processing until its lease expires.
      if (options.deadlineAtMs !== undefined && Date.now() >= options.deadlineAtMs) {
        await deferEpisodeReview(identity, claim, 'drain deadline reached before decision commit');
        return { kind: 'deferred' };
      }
      decision = await commitEpisodeReviewDecision(identity, claim, decisionInput);
      decisionCommitted = true;
    }
    options.abortSignal?.throwIfAborted();
    const beforeEffects = await options.revalidate(entry);
    options.abortSignal?.throwIfAborted();
    if (beforeEffects !== 'eligible') {
      if (beforeEffects === 'discard') {
        await discardFencedEpisodeReview(identity, claim, 'review branch changed before effects');
        return { kind: 'discarded' };
      }
      await deferEpisodeReview(identity, claim, 'review branch unavailable before effects');
      return { kind: 'deferred' };
    }
    let actions: readonly {
      readonly carrier: 'memory' | 'skill';
      readonly resultRefs: readonly string[];
    }[];
    if (options.applyV2Action !== undefined) {
      const committed = new Map(
        (snapshot?.actions ?? []).map((action) => [action.carrier, action]),
      );
      const applied = [...committed.values()].map((action) => ({
        carrier: action.carrier,
        resultRefs: action.resultRefs,
      }));
      const requiredCarriers = decision.requiredCarriers;
      const carriers = options.listV2Actions?.(entry, decision)
        ?? requiredCarriers
        ?? ['memory'];
      assertUniqueEpisodeReviewCarriers(carriers);
      if (requiredCarriers === undefined && !carriers.includes('memory')) {
        throw new Error('legacy review action carriers must include memory');
      }
      if (requiredCarriers !== undefined && !sameStrings(carriers, requiredCarriers)) {
        throw new Error('review action carriers do not match the committed decision');
      }
      for (const carrier of carriers) {
        if (committed.has(carrier)) continue;
        options.abortSignal?.throwIfAborted();
        const authority = await options.revalidate(entry);
        options.abortSignal?.throwIfAborted();
        if (authority !== 'eligible') {
          if (authority === 'discard') {
            await discardFencedEpisodeReview(identity, claim, 'review branch changed before effect');
            return { kind: 'discarded' };
          }
          await deferEpisodeReview(identity, claim, 'review branch unavailable before effect');
          return { kind: 'deferred' };
        }
        applyingCarrier = carrier;
        const resultRefs = await options.applyV2Action(
          entry,
          decision,
          carrier,
          claim,
          (effect) => withEpisodeReviewClaimAuthority(
            identity,
            claim,
            async (revalidateAuthority) => {
              options.abortSignal?.throwIfAborted();
              const refs = await effect(revalidateAuthority);
              await commitEpisodeReviewActionWithSessionFence(identity, claim, {
                actionId: `${decision.decisionId}:${carrier}`,
                decisionId: decision.decisionId,
                carrier,
                resultRefs: refs,
              });
              return refs;
            },
          ),
        );
        applyingCarrier = undefined;
        applied.push({ carrier, resultRefs });
      }
      actions = applied;
    } else {
      actions = await withEpisodeReviewClaimAuthority(identity, claim, async () => {
        options.abortSignal?.throwIfAborted();
        const committed = snapshot?.actions.find((action) => action.carrier === 'memory');
        if (committed !== undefined) return [committed];
        const results = [{
          carrier: 'memory' as const,
          resultRefs: await options.review(entry, options.abortSignal),
        }];
        for (const action of results) {
          await commitEpisodeReviewActionWithSessionFence(identity, claim, {
            actionId: `${decision.decisionId}:${action.carrier}`,
            decisionId: decision.decisionId,
            carrier: action.carrier,
            resultRefs: action.resultRefs,
          });
        }
        return results;
      });
    }
    options.abortSignal?.throwIfAborted();
    const memoryRefs = actions
      .filter((action) => action.carrier === 'memory')
      .flatMap((action) => action.resultRefs);
    deliveringCompletion = true;
    if (options.onV2Completed !== undefined) {
      await withEpisodeReviewClaimAuthority(identity, claim, async (revalidateAuthority) => {
        options.abortSignal?.throwIfAborted();
        await options.onV2Completed?.(entry, decision, memoryRefs);
        await revalidateAuthority();
        await completeFencedEpisodeReviewWithSessionFence(identity, claim, memoryRefs);
      });
    } else {
      await completeFencedEpisodeReview(identity, claim, memoryRefs);
    }
    deliveringCompletion = false;
    return { kind: 'reviewed' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const cancelled = isReviewDrainCancellation(error, options.abortSignal);
    try {
      if (cancelled) {
        await deferEpisodeReview(identity, claim, 'review drain cancelled');
      } else if (decisionCommitted) {
        if (deliveringCompletion) {
          await failEpisodeReviewCompletion(identity, claim, message);
        } else {
          await failEpisodeReviewApply(identity, claim, {
            carrier: applyingCarrier ?? 'memory',
            message,
          });
        }
      } else {
        // Failures before a decision is committed (input freeze, decide
        // setup, commit) must consume provider attempts so repeated crashes
        // back off and eventually escalate to attention.
        await failEpisodeReviewAttempt(identity, claim, {
          kind: classifyEpisodeReviewFailure(error),
          message,
        });
      }
    } catch (cleanupError) {
      if (!(cleanupError instanceof Error)
        || cleanupError.message !== 'review claim is no longer authoritative') {
        throw cleanupError;
      }
    }
    if (cancelled) return { kind: 'deferred' };
    return { kind: 'failed', error: message };
  }
}

const EPISODE_REVIEW_PROVIDER_TIMEOUT_MS = 90_000;

async function decideEpisodeReviewWithHardTimeout(
  decide: NonNullable<EpisodeReviewDrainOptions['decideV2']>,
  entry: PendingEpisodeReviewV2,
  input: EpisodeReviewInputCheckpoint,
  abortSignal?: AbortSignal,
): Promise<EpisodeReviewDecisionInput> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let timeoutError: EpisodeReviewFailure | undefined;
  const abort = () => controller.abort(abortSignal?.reason);
  abortSignal?.throwIfAborted();
  abortSignal?.addEventListener('abort', abort, { once: true });
  try {
    const decision = await new Promise<EpisodeReviewDecisionInput>((resolve, reject) => {
      timeout = setTimeout(() => {
        timeoutError = new EpisodeReviewFailure(
          'provider_timeout',
          `episode reviewer timed out after ${EPISODE_REVIEW_PROVIDER_TIMEOUT_MS}ms`,
        );
        controller.abort();
        // An owned drain must retain the reviewer until it really settles.
        // Unowned callers keep the existing hard-timeout compatibility.
        if (abortSignal === undefined) reject(timeoutError);
      }, EPISODE_REVIEW_PROVIDER_TIMEOUT_MS);
      void decide(entry, input, controller.signal).then(resolve, reject);
    });
    abortSignal?.throwIfAborted();
    if (timeoutError !== undefined) throw timeoutError;
    return decision;
  } catch (error) {
    // Normalize provider-specific abort wrappers only at the model-call boundary.
    // Storage failures elsewhere retain their original failure classification.
    abortSignal?.throwIfAborted();
    if (timeoutError !== undefined) throw timeoutError;
    throw error;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    abortSignal?.removeEventListener('abort', abort);
  }
}

function isReviewDrainCancellation(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true && (
    error === signal.reason
    || (error instanceof Error && (
      error.name === 'AbortError' || ('code' in error && error.code === 'ABORT_ERR')
    ))
  );
}

function classifyEpisodeReviewFailure(error: unknown): EpisodeReviewFailureKind {
  if (error instanceof EpisodeReviewFailure) return error.kind;
  if (error instanceof Error
    && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return 'provider_timeout';
  }
  return 'provider_error';
}

async function claimPendingReview(
  identity: MemoryContextIdentity,
  reviewKey: string,
): Promise<string | undefined> {
  const processingDir = path.join(sessionInboxRoot(identity), 'processing');
  await mkdir(processingDir, { recursive: true });
  const claimPath = path.join(processingDir, `${safeKey(reviewKey)}.${randomUUID()}.json`);
  try {
    await rename(pendingPath(identity, reviewKey), claimPath);
    return claimPath;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function restoreClaim(
  identity: MemoryContextIdentity,
  entry: PendingEpisodeReview,
  claimPath: string,
): Promise<void> {
  await restoreQueuedReviewFiles(sessionInboxRoot(identity), [{
    entry,
    filePath: claimPath,
    queue: 'processing',
  }]);
}

async function recoverStaleClaims(
  tenantRoot: string,
  sessionDir: string,
  ownerMatches: (entry: PendingEpisodeReview) => boolean,
): Promise<void> {
  const sessionRoot = path.join(tenantRoot, sessionDir);
  const processingDir = path.join(sessionRoot, 'processing');
  const claims: Array<QueuedReviewFile & { readonly stale: boolean }> = [];
  for (const filename of await readJsonFiles(processingDir)) {
    const claimPath = path.join(processingDir, filename);
    try {
      const stale = Date.now() - (await stat(claimPath)).mtimeMs > REVIEW_CLAIM_STALE_MS;
      const entry = await readPending(claimPath, { ownerMatches });
      if (entry === undefined) continue;
      claims.push({ entry, filePath: claimPath, queue: 'processing', stale });
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  const byTarget = groupQueuedReviewsByPendingTarget(sessionRoot, claims);
  for (const [target, matching] of byTarget) {
    const stale = matching.filter((claim) => claim.stale);
    if (stale.length === 0) continue;
    const representative = matching[0];
    if (representative !== undefined
      && await episodeReviewReceiptExists(sessionRoot, representative.entry)) {
      for (const { filePath } of stale) await rm(filePath, { force: true });
      continue;
    }
    if (await readPending(target, { ownerMatches }) !== undefined) {
      await restoreQueuedReviewFiles(sessionRoot, stale, ownerMatches);
      continue;
    }
    const liveIdentities = new Set(
      matching
        .filter((claim) => !claim.stale)
        .map(({ entry }) => queuedReviewIdentity(entry)),
    );
    if (liveIdentities.size > 0) {
      for (const claim of stale) {
        if (liveIdentities.has(queuedReviewIdentity(claim.entry))) {
          await rm(claim.filePath, { force: true });
        }
      }
      continue;
    }
    await restoreQueuedReviewFiles(sessionRoot, stale, ownerMatches);
  }
}

async function writeEpisodeReviewReceipt(
  identity: MemoryContextIdentity,
  reviewKey: string,
  proposalIds: readonly string[],
  jobId?: string,
): Promise<string> {
  assertNonEmptyString(reviewKey, 'reviewKey');
  if (jobId !== undefined) assertNonEmptyString(jobId, 'jobId');
  assertNonEmptyStrings(proposalIds, 'proposalIds');
  const receiptPath = episodeReviewReceiptPath(sessionInboxRoot(identity), jobId ?? reviewKey);
  const existing = await readTypedJson(receiptPath, isEpisodeReviewReceipt);
  if (existing !== undefined) {
    assertEpisodeReviewReceiptIdentity(
      existing,
      reviewKey,
      jobId,
      receiptPath,
      proposalIds,
      jobId === undefined ? identity : undefined,
    );
    return receiptPath;
  }
  const receipt: EpisodeReviewReceipt = {
    version: 1,
    ...(jobId === undefined ? {} : { jobId }),
    reviewKey,
    ...(jobId === undefined
      ? {
          ownerAgentHash: hashMemoryIdentityComponent('agent', identity.agentId),
          ...(identity.projectId === undefined
            ? {}
            : {
                ownerProjectHash: hashMemoryIdentityComponent('project', identity.projectId),
              }),
        }
      : {}),
    proposalIds: [...proposalIds],
    completedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(receiptPath, receipt);
  return receiptPath;
}

function episodeReviewReceiptPath(sessionRoot: string, receiptKey: string): string {
  return path.join(sessionRoot, 'receipts', `${safeKey(receiptKey)}.json`);
}

async function episodeReviewReceiptExists(
  sessionRoot: string,
  entry: PendingEpisodeReview,
): Promise<boolean> {
  const receiptKey = entry.version === 2 ? entry.jobId : entry.reviewKey;
  const receiptPath = episodeReviewReceiptPath(sessionRoot, receiptKey);
  const receipt = await readTypedJson(receiptPath, isEpisodeReviewReceipt);
  if (receipt === undefined) return false;
  assertEpisodeReviewReceiptIdentity(
    receipt,
    entry.reviewKey,
    entry.version === 1 ? undefined : entry.jobId,
    receiptPath,
  );
  if (entry.version === 1) assertEpisodeReviewReceiptEntryOwner(receipt, entry);
  return true;
}

function tenantInboxRoot(tenantId: string, configHome?: string): string {
  return path.join(
    reviewInboxRoot(configHome),
    hashMemoryIdentityComponent('tenant', tenantId),
  );
}

function sessionInboxRoot(identity: MemoryContextIdentity): string {
  return path.join(
    tenantInboxRoot(identity.tenantId, identity.configHome),
    hashMemoryIdentityComponent('session', identity.sessionId),
  );
}

function pendingPath(identity: MemoryContextIdentity, reviewKey: string): string {
  return path.join(sessionInboxRoot(identity), 'pending', `${safeKey(reviewKey)}.json`);
}

function pendingV2Path(identity: MemoryContextIdentity, jobId: string): string {
  return path.join(sessionInboxRoot(identity), 'pending', `${jobId}.json`);
}

function episodeReviewJobId(
  identity: MemoryContextIdentity,
  digest: KodaXMemoryOutcomeDigest,
  branchEpoch: number,
): string {
  return sha256([
    identity.configHome ?? '',
    identity.tenantId,
    identity.agentId,
    identity.projectId ?? '',
    identity.sessionId,
    digest.branchId,
    String(branchEpoch),
    String(digest.sequence),
    digest.id,
    digest.reviewKey,
  ].join('\n'));
}

function jobRoot(identity: MemoryContextIdentity, jobId: string): string {
  return path.join(sessionInboxRoot(identity), 'jobs', safeKey(jobId));
}

function jobStatePath(identity: MemoryContextIdentity, jobId: string): string {
  return path.join(jobRoot(identity, jobId), 'state.json');
}

function jobInputPath(identity: MemoryContextIdentity, jobId: string): string {
  return path.join(jobRoot(identity, jobId), 'review-input.json');
}

function jobDecisionPath(identity: MemoryContextIdentity, jobId: string): string {
  return path.join(jobRoot(identity, jobId), 'decision.json');
}

function jobActionsRoot(identity: MemoryContextIdentity, jobId: string): string {
  return path.join(jobRoot(identity, jobId), 'actions');
}

function jobActionPath(identity: MemoryContextIdentity, jobId: string, actionId: string): string {
  return path.join(jobActionsRoot(identity, jobId), `${safeKey(actionId)}.json`);
}

function jobLockPath(identity: MemoryContextIdentity, jobId: string): string {
  return path.join(jobRoot(identity, jobId), '.authority.lock');
}

function withEpisodeReviewJobLock<T>(
  identity: MemoryContextIdentity,
  jobId: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withLearningFileLock(jobLockPath(identity, jobId), operation);
}

function branchAuthorityPath(identity: MemoryContextIdentity): string {
  return path.join(sessionInboxRoot(identity), 'branch-authority.json');
}

function withEpisodeReviewSessionLock<T>(
  identity: MemoryContextIdentity,
  operation: () => Promise<T>,
): Promise<T> {
  return withEpisodeReviewRootRegistryLock(
    identity,
    () => withLearningFileLock(
      path.join(sessionInboxRoot(identity), '.branch-authority.lock'),
      operation,
      REVIEW_AUTHORITY_LOCK_ACQUIRE_TIMEOUT_MS,
    ),
  );
}

function reviewInboxRoot(configHome?: string): string {
  return configHome === undefined
    ? getAgentConfigPath('memory-review-inbox')
    : path.join(configHome, 'memory-review-inbox');
}

function withEpisodeReviewRootRegistryLock<T>(
  input: {
    readonly configHome?: string;
    readonly sessionId: string;
  },
  operation: () => Promise<T>,
): Promise<T> {
  const sessionKey = hashMemoryIdentityComponent('session', input.sessionId);
  return withEpisodeReviewRootRegistryKeyLock(input.configHome, sessionKey, operation);
}

function withEpisodeReviewRootRegistryKeyLock<T>(
  configHome: string | undefined,
  sessionKey: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withLearningFileLock(
    path.join(reviewInboxRoot(configHome), '.session-authority', `${sessionKey}.lock`),
    operation,
    REVIEW_AUTHORITY_LOCK_ACQUIRE_TIMEOUT_MS,
  );
}

function safeKey(value: string): string {
  return hashMemoryIdentityComponent('review', value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value: unknown): string {
  return JSON.stringify(normalizeJson(value));
}

function normalizeJson(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('review input must contain finite JSON numbers');
    return value;
  }
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (!isRecord(value)) throw new Error('review input must be JSON serializable');
  const normalized = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(value).sort()) {
    const item = value[key];
    if (item === undefined) continue;
    normalized[key] = normalizeJson(item);
  }
  return normalized;
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

async function readDirectories(root: string): Promise<readonly string[]> {
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

async function readJsonFiles(root: string): Promise<readonly string[]> {
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

async function readPendingRecord(
  filePath: string,
  options: {
    readonly cleanupCompleted?: boolean;
    readonly tolerateInvalidState?: boolean;
    readonly ownerMatches?: (entry: PendingEpisodeReview) => boolean;
  } = {},
): Promise<PendingEpisodeReviewRecord | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(filePath, 'utf8'));
    if (!isRecord(value)
      || (value.version !== 1 && value.version !== 2)
      || typeof value.reviewKey !== 'string') {
      return invalidPending(filePath, 'invalid envelope');
    }
    if (value.version === 2
      && (typeof value.jobId !== 'string'
        || typeof value.branchId !== 'string'
        || !Number.isSafeInteger(value.branchEpoch)
        || value.authorityCeiling !== 'memory_and_project_skill')) {
      return invalidPending(filePath, 'invalid v2 envelope');
    }
    if (typeof value.ownerSessionRef !== 'string' || typeof value.ownerAgentHash !== 'string') {
      return invalidPending(filePath, 'invalid owner');
    }
    if (value.ownerProjectHash !== undefined && typeof value.ownerProjectHash !== 'string') {
      return invalidPending(filePath, 'invalid project owner');
    }
    if (typeof value.createdAt !== 'string' || !isOutcomeDigest(value.digest)) {
      return invalidPending(filePath, 'invalid digest');
    }
    const entry = value as unknown as PendingEpisodeReview;
    if (options.ownerMatches !== undefined && !options.ownerMatches(entry)) return undefined;
    let completed = false;
    if (entry.version === 1
      && await episodeReviewReceiptExists(path.dirname(path.dirname(filePath)), entry)) {
      if (options.cleanupCompleted !== false) {
        await removeCompletedPendingBestEffort(filePath, entry.reviewKey);
        return undefined;
      }
      completed = true;
    }
    let state: EpisodeReviewJobState | undefined;
    let stateError: string | undefined;
    if (entry.version === 2) {
      const jobId = entry.jobId;
      const statePath = path.join(
        path.dirname(path.dirname(filePath)),
        'jobs',
        safeKey(jobId),
        'state.json',
      );
      try {
        state = await readTypedJson(statePath, isEpisodeReviewJobState);
        if (state !== undefined && state.jobId !== jobId) {
          throw new Error(`review job state identity mismatch: ${jobId}`);
        }
      } catch (error) {
        if (!options.tolerateInvalidState) throw error;
        state = undefined;
        stateError = 'invalid persisted review job state';
        emitKodaXDiagnostic({
          source: 'memory.review-inbox',
          level: 'warn',
          message: 'Episode review summary found an invalid job state.',
          detail: { statePath, error: error instanceof Error ? error.message : String(error) },
        });
      }
      if (state?.status === 'completed') {
        if (options.cleanupCompleted !== false) {
          await removeCompletedPendingBestEffort(filePath, jobId);
          return undefined;
        }
        completed = true;
      }
    }
    return {
      entry,
      ...(state === undefined ? {} : { state }),
      ...(stateError === undefined ? {} : { stateError }),
      ...(completed ? { completed: true } : {}),
    };
  } catch (error) {
    if (isMissing(error)) return undefined;
    if (error instanceof SyntaxError) return invalidPending(filePath, 'invalid JSON');
    throw error;
  }
}

async function readPending(
  filePath: string,
  options: {
    readonly cleanupCompleted?: boolean;
    readonly ownerMatches?: (entry: PendingEpisodeReview) => boolean;
  } = {},
): Promise<PendingEpisodeReview | undefined> {
  return (await readPendingRecord(filePath, options))?.entry;
}

async function removeCompletedPendingBestEffort(
  filePath: string,
  jobId: string,
): Promise<void> {
  try {
    await rm(filePath, { force: true });
  } catch (error) {
    emitKodaXDiagnostic({
      source: 'memory.review-inbox',
      level: 'warn',
      message: 'Completed episode review left a recoverable pending residue.',
      detail: {
        filePath,
        jobId,
        error: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

async function recoverStaleClaimsWithAuthority(
  configHome: string | undefined,
  tenantRoot: string,
  sessionDir: string,
  ownerMatches: (entry: PendingEpisodeReview) => boolean,
): Promise<void> {
  const sessionRoot = path.join(tenantRoot, sessionDir);
  await withEpisodeReviewRootRegistryKeyLock(configHome, sessionDir, () => (
    withLearningFileLock(
      path.join(sessionRoot, '.branch-authority.lock'),
      () => recoverStaleClaims(tenantRoot, sessionDir, ownerMatches),
      REVIEW_AUTHORITY_LOCK_ACQUIRE_TIMEOUT_MS,
    )
  ));
}

interface QueuedReviewFile {
  readonly entry: PendingEpisodeReview;
  readonly filePath: string;
  readonly queue: 'pending' | 'processing';
}

async function listQueuedReviewFiles(
  sessionRoot: string,
): Promise<readonly QueuedReviewFile[]> {
  const queued: QueuedReviewFile[] = [];
  for (const queue of ['pending', 'processing'] as const) {
    const root = path.join(sessionRoot, queue);
    for (const filename of await readJsonFiles(root)) {
      const filePath = path.join(root, filename);
      const entry = await readPending(filePath, { cleanupCompleted: false });
      if (entry !== undefined) queued.push({ entry, filePath, queue });
    }
  }
  return queued;
}

function queuedReviewPendingTarget(
  sessionRoot: string,
  queued: Pick<QueuedReviewFile, 'entry'>,
): string {
  const key = queued.entry.version === 2
    ? queued.entry.jobId
    : safeKey(queued.entry.reviewKey);
  return path.join(sessionRoot, 'pending', `${key}.json`);
}

function groupQueuedReviewsByPendingTarget<T extends Pick<QueuedReviewFile, 'entry'>>(
  sessionRoot: string,
  queued: readonly T[],
): ReadonlyMap<string, readonly T[]> {
  const grouped = new Map<string, T[]>();
  for (const candidate of queued) {
    const target = queuedReviewPendingTarget(sessionRoot, candidate);
    grouped.set(target, [...(grouped.get(target) ?? []), candidate]);
  }
  return grouped;
}

function compareQueuedReviewRecoveryPriority(
  left: QueuedReviewFile,
  right: QueuedReviewFile,
): number {
  if (left.entry.digest.sequence !== right.entry.digest.sequence) {
    return left.entry.digest.sequence > right.entry.digest.sequence ? -1 : 1;
  }
  const createdAt = right.entry.createdAt.localeCompare(left.entry.createdAt);
  if (createdAt !== 0) return createdAt;
  const digestId = right.entry.digest.id.localeCompare(left.entry.digest.id);
  return digestId !== 0 ? digestId : left.filePath.localeCompare(right.filePath);
}

function queuedReviewIdentity(entry: PendingEpisodeReview): string {
  return entry.version === 2 ? entry.jobId : entry.digest.id;
}

async function restoreQueuedReviewFiles(
  sessionRoot: string,
  queued: readonly QueuedReviewFile[],
  ownerMatches?: (entry: PendingEpisodeReview) => boolean,
): Promise<void> {
  for (const [target, matching] of groupQueuedReviewsByPendingTarget(sessionRoot, queued)) {
    let winner = await readPending(target, { ownerMatches });
    if (winner === undefined) {
      let targetOccupied = false;
      try {
        await lstat(target);
        targetOccupied = true;
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      if (!targetOccupied) {
        const selected = [...matching].sort(compareQueuedReviewRecoveryPriority)[0];
        if (selected !== undefined) {
          await writeJsonAtomic(target, selected.entry);
          winner = selected.entry;
        }
      }
    }
    if (winner === undefined) continue;
    const winnerIdentity = queuedReviewIdentity(winner);
    for (const { entry, filePath } of matching) {
      if (queuedReviewIdentity(entry) === winnerIdentity) {
        await rm(filePath, { force: true });
      }
    }
  }
}

async function readV2Envelope(filePath: string): Promise<PendingEpisodeReviewV2 | undefined> {
  const envelope = await readPending(filePath, { cleanupCompleted: false });
  return envelope?.version === 2 ? envelope : undefined;
}

async function resolvePendingV2Envelope(
  identity: MemoryContextIdentity,
  reviewKeyOrJobId: string,
): Promise<PendingEpisodeReviewV2 | undefined> {
  const exact = await readV2Envelope(pendingV2Path(identity, reviewKeyOrJobId));
  if (exact !== undefined) return exact;
  const pendingDir = path.join(sessionInboxRoot(identity), 'pending');
  const matches: PendingEpisodeReviewV2[] = [];
  for (const filename of await readJsonFiles(pendingDir)) {
    const candidate = await readV2Envelope(path.join(pendingDir, filename));
    if (candidate?.reviewKey === reviewKeyOrJobId) matches.push(candidate);
  }
  if (matches.length > 1) {
    throw new Error('reviewKey is ambiguous across distinct v2 jobs; use jobId');
  }
  return matches[0];
}

async function readJobState(
  identity: MemoryContextIdentity,
  jobId: string,
): Promise<EpisodeReviewJobState | undefined> {
  const state = await readTypedJson(jobStatePath(identity, jobId), isEpisodeReviewJobState);
  if (state === undefined) return undefined;
  return {
    ...state,
    applyAttemptsByCarrier: state.applyAttemptsByCarrier ?? {
      memory: state.applyAttempts,
      skill: 0,
    },
    completionAttempts: state.completionAttempts ?? 0,
  };
}

async function readOrCreateBranchAuthority(
  identity: MemoryContextIdentity,
): Promise<EpisodeReviewBranchAuthority> {
  return readOrCreateBranchAuthorityAtPath(branchAuthorityPath(identity));
}

async function readBranchAuthorityAtPath(
  filePath: string,
): Promise<EpisodeReviewBranchAuthority> {
  return await readTypedJson(filePath, isEpisodeReviewBranchAuthority) ?? {
    schemaVersion: 1,
    epoch: 0,
    rewinds: [],
  };
}

async function readOrCreateBranchAuthorityAtPath(
  filePath: string,
): Promise<EpisodeReviewBranchAuthority> {
  const existing = await readTypedJson(filePath, isEpisodeReviewBranchAuthority);
  if (existing !== undefined) return existing;
  const initial: EpisodeReviewBranchAuthority = {
    schemaVersion: 1,
    epoch: 0,
    rewinds: [],
  };
  await writeJsonAtomic(filePath, initial);
  return initial;
}

function isRewound(
  envelope: PendingEpisodeReviewV2,
  authority: EpisodeReviewBranchAuthority,
): boolean {
  return (authority.exactFences ?? []).some((fence) => (
    fence.epoch > envelope.branchEpoch
    && fence.retiredJobIds.includes(envelope.jobId)
  ));
}

async function assertAuthoritativeClaim(
  identity: MemoryContextIdentity,
  claim: EpisodeReviewClaim,
  now: Date,
): Promise<EpisodeReviewJobState> {
  const envelope = await readV2Envelope(pendingV2Path(identity, claim.jobId));
  const state = await readJobState(identity, claim.jobId);
  const branchAuthority = await readOrCreateBranchAuthority(identity);
  const authoritative = envelope !== undefined
    && envelope.jobId === claim.jobId
    && envelope.branchId === claim.branchId
    && envelope.branchEpoch === claim.branchEpoch
    && !isRewound(envelope, branchAuthority)
    && state !== undefined
    && state.claimEpoch === claim.epoch
    && state.claimToken === claim.token
    && state.leaseDeadline === claim.leaseDeadline
    && Date.parse(claim.leaseDeadline) > now.getTime();
  if (!authoritative || state === undefined) {
    throw new Error('review claim is no longer authoritative');
  }
  return state;
}

async function readTypedJson<T>(
  filePath: string,
  validate: (value: unknown) => value is T,
): Promise<T | undefined> {
  try {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(filePath, 'utf8')) as unknown;
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`invalid review protocol record: ${filePath}`);
      }
      throw error;
    }
    if (!validate(value)) throw new Error(`invalid review protocol record: ${filePath}`);
    return value;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function isEpisodeReviewJobState(value: unknown): value is EpisodeReviewJobState {
  return isRecord(value)
    && value.schemaVersion === 1
    && typeof value.jobId === 'string'
    && ['pending', 'processing', 'decided', 'completed', 'attention'].includes(String(value.status))
    && Number.isSafeInteger(value.claimEpoch)
    && Number.isSafeInteger(value.providerAttempts)
    && Number.isSafeInteger(value.applyAttempts)
    && (value.applyAttemptsByCarrier === undefined
      || (isRecord(value.applyAttemptsByCarrier)
        && Number.isSafeInteger(value.applyAttemptsByCarrier.memory)
        && Number.isSafeInteger(value.applyAttemptsByCarrier.skill)))
    && (value.completionAttempts === undefined
      || Number.isSafeInteger(value.completionAttempts))
    && typeof value.updatedAt === 'string'
    && (value.claimToken === undefined || typeof value.claimToken === 'string')
    && (value.leaseDeadline === undefined || typeof value.leaseDeadline === 'string')
    && (value.nextAttemptAt === undefined || typeof value.nextAttemptAt === 'string')
    && (value.nextApplyAttemptAt === undefined || typeof value.nextApplyAttemptAt === 'string')
    && (value.nextCompletionAttemptAt === undefined
      || typeof value.nextCompletionAttemptAt === 'string')
    && (value.lastError === undefined || typeof value.lastError === 'string');
}

function isEpisodeReviewReceipt(value: unknown): value is EpisodeReviewReceipt {
  if (!isRecord(value)) return false;
  const expectedKeys = value.jobId !== undefined
    ? ['completedAt', 'jobId', 'proposalIds', 'reviewKey', 'version']
    : value.ownerAgentHash === undefined
      ? ['completedAt', 'proposalIds', 'reviewKey', 'version']
      : value.ownerProjectHash === undefined
        ? ['completedAt', 'ownerAgentHash', 'proposalIds', 'reviewKey', 'version']
        : [
            'completedAt',
            'ownerAgentHash',
            'ownerProjectHash',
            'proposalIds',
            'reviewKey',
            'version',
          ];
  const keys = Object.keys(value).sort();
  return keys.length === expectedKeys.length
    && keys.every((key, index) => key === expectedKeys[index])
    && value.version === 1
    && (value.jobId === undefined
      || (typeof value.jobId === 'string' && value.jobId.length > 0))
    && (value.ownerAgentHash === undefined
      || (typeof value.ownerAgentHash === 'string' && value.ownerAgentHash.length > 0))
    && (value.ownerProjectHash === undefined
      || (typeof value.ownerProjectHash === 'string' && value.ownerProjectHash.length > 0))
    && typeof value.reviewKey === 'string'
    && value.reviewKey.length > 0
    && Array.isArray(value.proposalIds)
    && value.proposalIds.every((id) => typeof id === 'string' && id.length > 0)
    && isCanonicalIsoTimestamp(value.completedAt);
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function assertNonEmptyString(value: string, field: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
}

function assertNonEmptyStrings(values: readonly string[], field: string): void {
  if (!Array.isArray(values)
    || values.some((value) => typeof value !== 'string' || value.length === 0)) {
    throw new Error(`${field} must contain only non-empty strings`);
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function assertEpisodeReviewCarrier(value: 'memory' | 'skill'): void {
  if (value !== 'memory' && value !== 'skill') {
    throw new Error('carrier must be memory or skill');
  }
}

function assertUniqueEpisodeReviewCarriers(
  carriers: readonly ('memory' | 'skill')[],
): void {
  if (!Array.isArray(carriers)) {
    throw new Error('required carriers must be an array');
  }
  const seen = new Set<'memory' | 'skill'>();
  for (const carrier of carriers) {
    assertEpisodeReviewCarrier(carrier);
    if (seen.has(carrier)) throw new Error(`duplicate review carrier: ${carrier}`);
    seen.add(carrier);
  }
}

function assertEpisodeReviewInputIdentity(
  checkpoint: EpisodeReviewInputCheckpoint,
  jobId: string,
): void {
  if (checkpoint.jobId !== jobId
    || checkpoint.evidenceBytes !== stableJson(checkpoint.evidence)
    || checkpoint.evidenceHash !== sha256(checkpoint.evidenceBytes)) {
    throw new Error('review input identity mismatch');
  }
}

function assertEpisodeReviewDecisionIdentity(
  decision: EpisodeReviewDecision,
  jobId: string,
  inputHash: string,
): void {
  if (decision.jobId !== jobId
    || decision.inputHash !== inputHash
    || decision.decisionId !== sha256(`${jobId}:${inputHash}`)) {
    throw new Error('review decision identity mismatch');
  }
}

function assertEpisodeReviewActionReceiptIdentity(
  receipt: EpisodeReviewActionReceipt,
  expected: Pick<
    EpisodeReviewActionReceipt,
    'jobId' | 'actionId' | 'decisionId' | 'carrier'
  >,
): void {
  if (receipt.jobId !== expected.jobId
    || receipt.actionId !== expected.actionId
    || receipt.decisionId !== expected.decisionId
    || receipt.carrier !== expected.carrier) {
    throw new Error('review action receipt identity mismatch');
  }
}

function assertEpisodeReviewReceiptIdentity(
  receipt: EpisodeReviewReceipt,
  reviewKey: string,
  jobId: string | undefined,
  receiptPath: string,
  proposalIds?: readonly string[],
  owner?: MemoryContextIdentity,
): void {
  if (receipt.reviewKey !== reviewKey || receipt.jobId !== jobId) {
    throw new Error(`review receipt identity mismatch: ${receiptPath}`);
  }
  if (proposalIds !== undefined && !sameStrings(receipt.proposalIds, proposalIds)) {
    throw new Error('review receipt payload mismatch');
  }
  if (owner !== undefined) {
    const expectedProjectHash = owner.projectId === undefined
      ? undefined
      : hashMemoryIdentityComponent('project', owner.projectId);
    if (receipt.ownerAgentHash !== hashMemoryIdentityComponent('agent', owner.agentId)
      || receipt.ownerProjectHash !== expectedProjectHash) {
      throw new Error('review owner identity mismatch');
    }
  }
}

function assertEpisodeReviewOwnerIdentity(
  entry: PendingEpisodeReviewV1,
  identity: MemoryContextIdentity,
): void {
  const expectedProjectHash = identity.projectId === undefined
    ? undefined
    : hashMemoryIdentityComponent('project', identity.projectId);
  if (entry.ownerSessionRef !== identity.sessionId
    || entry.ownerAgentHash !== hashMemoryIdentityComponent('agent', identity.agentId)
    || entry.ownerProjectHash !== expectedProjectHash) {
    throw new Error('review owner identity mismatch');
  }
}

function assertEpisodeReviewReceiptEntryOwner(
  receipt: EpisodeReviewReceipt,
  entry: PendingEpisodeReviewV1,
): void {
  if (receipt.ownerAgentHash !== undefined
    && (receipt.ownerAgentHash !== entry.ownerAgentHash
      || receipt.ownerProjectHash !== entry.ownerProjectHash)) {
    throw new Error('review owner identity mismatch');
  }
}

function isEpisodeReviewBranchAuthority(value: unknown): value is EpisodeReviewBranchAuthority {
  return isRecord(value)
    && value.schemaVersion === 1
    && Number.isSafeInteger(value.epoch)
    && Array.isArray(value.rewinds)
    && value.rewinds.every((rewind) => (
      isRecord(rewind)
      && Number.isSafeInteger(rewind.epoch)
      && Number.isSafeInteger(rewind.throughSequence)
      && typeof rewind.createdAt === 'string'
    ))
    && (value.exactFences === undefined
      || (Array.isArray(value.exactFences) && value.exactFences.every((fence) => (
        isRecord(fence)
        && Number.isSafeInteger(fence.epoch)
        && Array.isArray(fence.retiredJobIds)
        && fence.retiredJobIds.every((id) => typeof id === 'string')
        && typeof fence.createdAt === 'string'
      ))));
}

function isEpisodeReviewInputCheckpoint(value: unknown): value is EpisodeReviewInputCheckpoint {
  return isRecord(value)
    && value.version === 1
    && typeof value.jobId === 'string'
    && value.jobId.length > 0
    && typeof value.evidenceBytes === 'string'
    && value.evidenceBytes.length > 0
    && typeof value.evidenceHash === 'string'
    && value.evidenceHash.length > 0
    && typeof value.promptRevision === 'string'
    && value.promptRevision.length > 0
    && typeof value.schemaRevision === 'string'
    && value.schemaRevision.length > 0
    && typeof value.policyRevision === 'string'
    && value.policyRevision.length > 0
    && typeof value.providerRevision === 'string'
    && value.providerRevision.length > 0
    && isCanonicalIsoTimestamp(value.createdAt)
    && 'evidence' in value;
}

function isEpisodeReviewDecision(value: unknown): value is EpisodeReviewDecision {
  return isRecord(value)
    && value.version === 1
    && typeof value.jobId === 'string'
    && value.jobId.length > 0
    && typeof value.decisionId === 'string'
    && value.decisionId.length > 0
    && typeof value.inputHash === 'string'
    && value.inputHash.length > 0
    && Array.isArray(value.memoryProposalIds)
    && value.memoryProposalIds.every((id) => typeof id === 'string' && id.length > 0)
    && (value.requiredCarriers === undefined
      || (Array.isArray(value.requiredCarriers)
        && value.requiredCarriers.includes('memory')
        && value.requiredCarriers.every(
          (carrier) => carrier === 'memory' || carrier === 'skill',
        )
        && new Set(value.requiredCarriers).size === value.requiredCarriers.length))
    && isCanonicalIsoTimestamp(value.committedAt);
}

function isEpisodeReviewActionReceipt(value: unknown): value is EpisodeReviewActionReceipt {
  return isRecord(value)
    && value.version === 1
    && typeof value.jobId === 'string'
    && value.jobId.length > 0
    && typeof value.actionId === 'string'
    && value.actionId.length > 0
    && typeof value.decisionId === 'string'
    && value.decisionId.length > 0
    && (value.carrier === 'memory' || value.carrier === 'skill')
    && Array.isArray(value.resultRefs)
    && value.resultRefs.every((ref) => typeof ref === 'string' && ref.length > 0)
    && isCanonicalIsoTimestamp(value.committedAt);
}

function invalidPending(filePath: string, reason: string): undefined {
  emitKodaXDiagnostic({
    source: 'memory.review-inbox',
    level: 'warn',
    message: 'Invalid pending episode review was skipped.',
    detail: { filePath, reason },
  });
  return undefined;
}

function isOutcomeDigest(value: unknown): value is KodaXMemoryOutcomeDigest {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string'
    && typeof value.reviewKey === 'string'
    && typeof value.sessionId === 'string'
    && typeof value.branchId === 'string'
    && Number.isSafeInteger(value.sequence)
    && typeof value.objective === 'string'
    && typeof value.approach === 'string'
    && (value.outcome === 'succeeded'
      || value.outcome === 'failed'
      || value.outcome === 'cancelled')
    && typeof value.summary === 'string'
    && (value.actionSignature === undefined || typeof value.actionSignature === 'string')
    && (value.preconditions === undefined || typeof value.preconditions === 'string')
    && (value.lesson === undefined || typeof value.lesson === 'string')
    && Array.isArray(value.evidenceRefs)
    && value.evidenceRefs.every((ref) => typeof ref === 'string')
    && (value.evidence === undefined
      || (Array.isArray(value.evidence) && value.evidence.every(isOutcomeEvidence)))
    && (value.outcome !== 'cancelled' || isIntentOnlyCancelledDigest(value))
    && (value.memoryInfluence === undefined
      || (Array.isArray(value.memoryInfluence) && value.memoryInfluence.every(isMemoryInfluence)))
    && (value.handledMemoryOperations === undefined
      || (Array.isArray(value.handledMemoryOperations)
        && value.handledMemoryOperations.every(isHandledMemoryOperation)))
    && (value.visibility === 'prompt_safe' || value.visibility === 'private' || value.visibility === 'sensitive')
    && typeof value.createdAt === 'string';
}

function isHandledMemoryOperation(value: unknown): boolean {
  return isRecord(value)
    && (value.operation === 'remember' || value.operation === 'correct' || value.operation === 'forget')
    && (value.disposition === undefined
      || value.disposition === 'applied'
      || value.disposition === 'decision'
      || value.disposition === 'blocked')
    && (value.statement === undefined || typeof value.statement === 'string')
    && (value.claimKey === undefined || typeof value.claimKey === 'string')
    && Array.isArray(value.targetRefIds)
    && value.targetRefIds.every((ref) => typeof ref === 'string');
}

function isOutcomeEvidence(value: unknown): boolean {
  return isRecord(value)
    && typeof value.ref === 'string'
    && (value.grade === 'authoritative' || value.grade === 'verified'
      || value.grade === 'corroborated' || value.grade === 'observed' || value.grade === 'inferred')
    && (value.source === 'user' || value.source === 'host' || value.source === 'tool'
      || value.source === 'environment' || value.source === 'agent')
    && (value.verdict === undefined || value.verdict === 'passed'
      || value.verdict === 'failed' || value.verdict === 'inconclusive')
    && typeof value.observedAt === 'string';
}

function isIntentOnlyCancelledDigest(value: Record<string, unknown>): boolean {
  const intent = value.memoryIntent;
  const evidence = value.evidence;
  const evidenceRefs = value.evidenceRefs;
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
    && value.objective === intent.candidateStatement
    && value.approach === 'episode completion'
    && value.actionSignature === undefined
    && value.preconditions === undefined
    && value.lesson === undefined
    && value.handledMemoryOperations === undefined
    && value.memoryInfluence === undefined;
}

function isMemoryInfluence(value: unknown): boolean {
  return isRecord(value)
    && typeof value.decisionReceiptRef === 'string'
    && (value.grade === 'direct' || value.grade === 'supporting'
      || value.grade === 'exposed' || value.grade === 'unknown');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}
