import { createHash } from 'node:crypto';
import { readdir, readFile, realpath, rename, rm, writeFile, mkdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  initializeSkillRegistry,
  type SkillMetadata,
} from '../capabilities/skills/index.js';
import {
  matchesMemoryApplicability,
  MEMORY_POLICY_VERSION,
  memoryApplicabilityFingerprint,
  parseMemoryFile,
  resolveMemoryRoot,
  resolveScopedMemoryRoot,
  type MemoryApplicability,
  type MemoryContextIdentity,
  type MemoryType,
} from '../memory/index.js';
import {
  readLearningProposalStore,
  resolveLearningProposalStore,
  updateLearningProposalStatus,
  upsertLearningProposal,
} from '../learning/store.js';
import { withLearningFileLock } from '../learning/store-lock.js';
import { memoryProposalRevision } from './proposal-revision.js';
import { matchesMemoryMutationHandle } from './mutation-handle.js';
import type {
  MemoryLearningHandoff,
  ReasoningLearningHandoff,
  StoredLearningProposal,
} from '../learning/types.js';
import type {
  KodaXSessionArtifactLedgerEntry,
  KodaXSessionEntry,
  KodaXSessionLineage,
} from '../types.js';
import type {
  MemoryActionProposal,
  MemoryApplyPreview,
  MemoryApplyResult,
  MemoryApproval,
  MemoryAutoCuratorInput,
  MemoryAutoCuratorResult,
  MemoryBodySnapshot,
  MemoryManagementController,
  MemoryEpisodeReviewResult,
  MemoryCuratorInput,
  MemoryEvent,
  MemoryGovernanceFinding,
  MemoryGovernanceReport,
  MemoryItemRef,
  MemoryLifecycleOperationResult,
  MemoryPack,
  MemoryPackHint,
  MemoryPackInput,
  MemoryRefFilter,
  MemoryRememberInput,
  MemoryRememberResult,
  MemoryRejectResult,
  MemoryReviewCandidateRef,
  MemoryReviewDraftAction,
  MemoryReviewInput,
  MemoryReviewModelInput,
  MemoryReviewPlan,
  MemoryReviewPersistenceDecision,
  MemoryReviewRunner,
  MemoryReviewTrigger,
  MemoryScope,
  MemorySourceAdapter,
  MemoryVisibility,
} from './types.js';
import { sanitizePromptSafeMemoryClaim } from './prompt-safety.js';
import {
  archiveManagedMemoryRef,
  forgetManagedMemoryRef,
  resolveManagedLifecycle,
} from './lifecycle.js';

const MISSING_FINGERPRINT = 'missing';
const AUTO_CURATOR_STATE_VERSION = 1;
const DEFAULT_AUTO_CURATOR_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_AUTO_CURATOR_MIN_REFS = 2;
const AUTO_CURATOR_REPORT_CAP = 200;

export interface CreateMemoryControlPlaneOptions {
  readonly cwd: string;
  readonly identity?: MemoryContextIdentity;
  readonly learningStorePath?: string;
  readonly memoryRoot?: string;
  readonly projectDocs?: readonly string[];
  readonly extraRefs?: readonly MemoryItemRef[];
  readonly sessionId?: string;
  readonly sessionLineage?: KodaXSessionLineage;
  readonly artifactLedger?: readonly KodaXSessionArtifactLedgerEntry[];
  readonly now?: () => string;
  readonly onEvent?: (event: MemoryEvent) => void;
  readonly discoverSkills?: boolean;
  readonly memoryReviewer?: MemoryReviewRunner;
}

interface ReadTextResult {
  readonly exists: boolean;
  readonly content: string;
}

interface PersistedReviewPlan {
  readonly proposalIds: readonly string[];
  readonly decisions: readonly MemoryReviewPersistenceDecision[];
}

interface ReviewMemoryPlacement {
  readonly memoryKind: MemoryLearningHandoff['memoryKind'];
  readonly applicability?: MemoryApplicability;
  readonly requestedLifecycle: 'active' | 'provisional';
}

interface MemdirWritePlan {
  readonly targetPath: string;
  readonly entrypointPath: string;
  readonly content: string;
  readonly indexLine: string;
}

interface AutoCuratorState {
  readonly version: 1;
  readonly lastCheckedAt?: string;
  readonly lastRunAt?: string;
  readonly lastInventoryFingerprint?: string;
  readonly lastReportPath?: string;
}

interface ReviewCandidateSelection {
  readonly candidateRefs: readonly MemoryReviewCandidateRef[];
  readonly warnings: readonly string[];
}

interface PreparedMemoryRememberInput {
  readonly operation: NonNullable<MemoryRememberInput['operation']>;
  readonly statement: string;
  readonly normalizedStatement: string;
}

interface MemoryRememberInventory {
  readonly allRefs: readonly MemoryItemRef[];
  readonly refs: readonly MemoryItemRef[];
  readonly target?: MemoryItemRef;
}

interface MemoryRememberClaim {
  readonly claimKind: NonNullable<MemoryRememberInput['claimKind']>;
  readonly claimKey: string;
  readonly actionTarget?: MemoryItemRef;
  readonly conflictNeedsDecision: boolean;
}

type MemoryRejectTransition =
  | { readonly proposal: MemoryActionProposal }
  | { readonly result: MemoryRejectResult };

export function createMemoryControlPlane(options: CreateMemoryControlPlaneOptions): MemoryManagementController {
  return new MemoryControlPlane(options);
}

export class MemoryControlPlane implements MemoryManagementController {
  private readonly cwd: string;
  private readonly learningStorePath: string;
  private readonly memoryRoot: string;
  private readonly now: () => string;
  private readonly onEvent?: (event: MemoryEvent) => void;
  private readonly projectDocs: readonly string[];
  private readonly extraRefs: readonly MemoryItemRef[];
  private readonly sessionId: string;
  private readonly sessionLineage?: KodaXSessionLineage;
  private readonly artifactLedger: readonly KodaXSessionArtifactLedgerEntry[];
  private readonly discoverSkills: boolean;
  private readonly memoryReviewer?: MemoryReviewRunner;
  private readonly identity?: MemoryContextIdentity;
  private readonly applicability?: MemoryApplicability;
  private readonly scopedRoots: readonly {
    readonly root: string;
    readonly scope: Extract<MemoryScope, 'project' | 'workspace' | 'agent' | 'user'>;
    readonly applicability: MemoryApplicability;
  }[];

  constructor(options: CreateMemoryControlPlaneOptions) {
    this.cwd = options.cwd;
    this.learningStorePath = options.learningStorePath
      ?? resolveLearningProposalStore(options.cwd, options.identity?.configHome);
    this.identity = options.identity;
    this.applicability = options.identity?.projectId !== undefined
      ? { tenantId: options.identity.tenantId, projectId: options.identity.projectId }
      : undefined;
    this.memoryRoot = options.memoryRoot
      ?? (options.identity?.projectId !== undefined
        ? resolveScopedMemoryRoot(options.identity, 'project')
        : resolveMemoryRoot(options.cwd));
    this.scopedRoots = options.memoryRoot !== undefined || options.identity === undefined
      ? []
      : buildScopedRoots(options.identity);
    this.now = options.now ?? (() => new Date().toISOString());
    this.onEvent = options.onEvent;
    this.projectDocs = options.projectDocs ?? defaultProjectDocs(options.cwd);
    this.extraRefs = options.extraRefs ?? [];
    this.sessionId = options.sessionId ?? 'current';
    this.sessionLineage = options.sessionLineage;
    this.artifactLedger = options.artifactLedger ?? [];
    this.discoverSkills = options.discoverSkills ?? true;
    this.memoryReviewer = options.memoryReviewer;
  }

  async listInbox(): Promise<readonly MemoryActionProposal[]> {
    const store = await readLearningProposalStore(this.learningStorePath);
    if (store.warnings.length > 0) return [];
    const proposals: MemoryActionProposal[] = [];
    for (const entry of store.proposals) {
      if (entry.status !== 'pending') continue;
      const proposal = await this.projectLearningProposal(entry);
      if (proposal !== undefined) proposals.push(proposal);
    }
    return proposals;
  }

  async showProposal(id: string): Promise<MemoryActionProposal | undefined> {
    const store = await readLearningProposalStore(this.learningStorePath);
    if (store.warnings.length > 0) return undefined;
    const entry = store.proposals.find((proposal) => memoryProposalId(proposal.proposalId) === id);
    return entry === undefined ? undefined : this.projectLearningProposal(entry);
  }

  async listHostAppliedEpisodeProposalIds(
    proposalIds: readonly string[],
  ): Promise<readonly string[]> {
    if (proposalIds.length === 0) return [];
    const requested = new Set(proposalIds);
    const store = await readLearningProposalStore(this.learningStorePath);
    if (store.warnings.length > 0) return [];
    return store.proposals
      .filter((entry) => (
        requested.has(entry.proposalId)
        && entry.status === 'approved'
        && entry.approvedBy === 'host'
        && entry.approvalPolicyId === `${MEMORY_POLICY_VERSION}:episode-promotion`
      ))
      .map((entry) => entry.proposalId);
  }

  async approveProposal(
    id: string,
    expectedFingerprints: Readonly<Record<string, string>>,
    expectedRevision?: string,
  ): Promise<MemoryApplyResult> {
    return withLearningFileLock(this.explicitMemoryLockPath(), () => (
      this.approveProposalWithLock(id, expectedFingerprints, expectedRevision)
    ));
  }

  private async approveProposalWithLock(
    id: string,
    expectedFingerprints: Readonly<Record<string, string>>,
    expectedRevision?: string,
  ): Promise<MemoryApplyResult> {
    return withLearningFileLock(this.proposalDecisionLockPath(), async () => {
      const proposal = (await this.listInbox()).find((candidate) => candidate.id === id);
      if (proposal === undefined) return skippedApply(id, 'memory proposal is not pending');
      if (expectedFingerprints === undefined) {
        return skippedApply(id, 'approval requires fingerprints from a shown proposal preview');
      }
      if (expectedRevision !== undefined && memoryProposalRevision(proposal) !== expectedRevision) {
        return skippedApply(id, 'memory proposal changed after preview');
      }
      const staleClaim = await this.staleProposalClaimReason(proposal);
      if (staleClaim !== undefined) return skippedApply(id, staleClaim);
      const approval: MemoryApproval = {
        proposalId: proposal.id,
        approvedBy: 'user',
        approvedAt: this.now(),
        expectedFingerprints,
      };
      const result = await this.adapterForProposal(proposal).applyProposal(proposal, approval);
      if (result.applied) this.emit({ type: 'proposal.approved', proposalId: id });
      return result;
    });
  }

  async rejectProposal(
    id: string,
    reason?: string,
    expectedRevision?: string,
  ): Promise<MemoryRejectResult> {
    const proposalId = parseMemoryProposalId(id);
    if (proposalId === undefined) {
      return {
        proposalId: id,
        rejected: false,
        skippedReason: `invalid memory proposal id: ${id}`,
        warnings: [],
      };
    }
    const transition = await withLearningFileLock(this.explicitMemoryLockPath(), () => (
      withLearningFileLock(this.proposalDecisionLockPath(), () => (
        this.rejectProposalWithLocks(id, proposalId, reason, expectedRevision)
      ))
    ));
    return 'result' in transition
      ? transition.result
      : this.reviewRejectedProposal(id, transition.proposal, reason);
  }

  private async rejectProposalWithLocks(
    id: string,
    proposalId: string,
    reason: string | undefined,
    expectedRevision: string | undefined,
  ): Promise<MemoryRejectTransition> {
    const proposal = (await this.listInbox()).find((candidate) => candidate.id === id);
    if (proposal === undefined) {
      return { result: skippedReject(id, 'memory proposal is not pending') };
    }
    if (expectedRevision !== undefined && memoryProposalRevision(proposal) !== expectedRevision) {
      return { result: skippedReject(id, 'memory proposal changed after preview') };
    }
    await updateLearningProposalStatus(this.learningStorePath, proposalId, 'rejected', {
      expectedStatus: 'pending',
      ...(reason !== undefined && reason.trim().length > 0 ? { rejectedReason: reason } : {}),
    });
    this.emit({ type: 'proposal.rejected', proposalId: id });
    return { proposal };
  }

  private async reviewRejectedProposal(
    id: string,
    proposal: MemoryActionProposal,
    reason: string | undefined,
  ): Promise<MemoryRejectResult> {
    const trimmedReason = reason?.trim();
    let review: MemoryReviewPlan | undefined;
    let warnings: readonly string[] = [];
    if (trimmedReason !== undefined && trimmedReason.length > 0) {
      try {
        review = await this.reviewMemoryFeedback({
          trigger: 'proposal_rejected',
          userFeedback: trimmedReason,
          sourceRefs: proposal.sourceRefs.map((ref) => ref.id),
          candidateRefIds: [
            ...proposal.targetRefs.map((ref) => ref.id),
            ...proposal.sourceRefs.map((ref) => ref.id),
          ],
        });
        warnings = review.warnings;
      } catch (error) {
        warnings = [`memory feedback review failed: ${errorMessage(error)}`];
      }
    }
    return {
      proposalId: id,
      rejected: true,
      ...(review !== undefined ? { review } : {}),
      warnings,
    };
  }

  private proposalDecisionLockPath(): string {
    return `${this.learningStorePath}.decision.lock`;
  }

  async listRefs(filter: MemoryRefFilter = {}): Promise<readonly MemoryItemRef[]> {
    const refs: MemoryItemRef[] = [];
    refs.push(...await this.listLearningRefs());
    for (const adapter of this.memdirAdapters()) refs.push(...await adapter.listRefs(filter));
    refs.push(...this.listSessionTraceRefs());
    refs.push(...this.listArtifactLedgerRefs());
    refs.push(...await this.listProjectDocRefs());
    refs.push(...await this.listSkillRefs());
    refs.push(...this.extraRefs);
    return refs.filter((ref) => matchesFilter(ref, filter));
  }

  async readRef(ref: MemoryItemRef): Promise<MemoryBodySnapshot> {
    if (ref.kind === 'learning_proposal' || ref.kind === 'reasoning_report') {
      return this.readLearningRef(ref);
    }
    if (ref.kind === 'memdir') {
      return this.memdirAdapter().readRef(ref);
    }
    if (ref.kind === 'session_trace') {
      return this.readSessionTraceRef(ref);
    }
    if (ref.kind === 'artifact_ledger') {
      return this.readArtifactLedgerRef(ref);
    }
    return readStorageBackedRef(ref, this.now);
  }

  async remember(input: MemoryRememberInput): Promise<MemoryRememberResult> {
    return withLearningFileLock(this.explicitMemoryLockPath(), () => (
      this.rememberWithLock(input)
    ));
  }

  private explicitMemoryLockPath(): string {
    const identity = this.identity;
    if (this.scopedRoots.length === 0 || identity === undefined) {
      return join(this.memoryRoot, '.explicit-memory.lock');
    }
    const agentRoot = resolveScopedMemoryRoot(identity, 'agent');
    return join(dirname(dirname(agentRoot)), '.explicit-memory.lock');
  }

  private async rememberWithLock(input: MemoryRememberInput): Promise<MemoryRememberResult> {
    const prepared = prepareMemoryRememberInput(input);
    if ('status' in prepared) return prepared;
    const inventory = await this.inspectMemoryRemember(input, prepared);
    if ('status' in inventory) return inventory;
    const claim = resolveMemoryRememberClaim(input, prepared, inventory);
    if ('status' in claim) return claim;
    const duplicate = await this.resolveRememberDuplicate(
      prepared,
      inventory,
      claim,
      input.expectedTargetFingerprint,
    );
    if (duplicate !== undefined) return duplicate;
    return this.applyExplicitMemoryRemember(input, prepared, inventory, claim);
  }

  private async inspectMemoryRemember(
    input: MemoryRememberInput,
    prepared: PreparedMemoryRememberInput,
  ): Promise<MemoryRememberInventory | MemoryRememberResult> {
    const allRefs = await this.listRefs({ kinds: ['memdir'], includePrivate: true });
    const refs = allRefs.filter((ref) => ref.lifecycle === 'active' || ref.lifecycle === 'trusted');
    const targetMatches = input.targetRefId === undefined
      ? []
      : allRefs.filter((ref) => matchesMemoryMutationHandle(ref, input.targetRefId!));
    if (targetMatches.length > 1) {
      return memoryRememberResult(
        'needs_clarification',
        `Memory ref is ambiguous across scopes: ${input.targetRefId}`,
      );
    }
    const target = targetMatches[0];
    if (input.targetRefId !== undefined && target === undefined) {
      return memoryRememberResult(
        prepared.operation === 'correct' ? 'needs_clarification' : 'rejected',
        `Memory ref not found: ${input.targetRefId}`,
      );
    }
    if (input.expectedTargetFingerprint !== undefined
      && target?.bodyFingerprint !== input.expectedTargetFingerprint) {
      return memoryRememberResult(
        'needs_clarification',
        'That Memory changed after it was shown; list it again before correcting it',
      );
    }
    return { allRefs, refs, ...(target === undefined ? {} : { target }) };
  }

  private async resolveRememberDuplicate(
    prepared: PreparedMemoryRememberInput,
    inventory: MemoryRememberInventory,
    claim: MemoryRememberClaim,
    expectedTargetFingerprint?: string,
  ): Promise<MemoryRememberResult | undefined> {
    const duplicate = await this.findRememberDuplicate(inventory.refs, prepared.normalizedStatement, claim);
    if (duplicate !== undefined) {
      if (prepared.operation === 'correct'
        && inventory.target !== undefined
        && duplicate.id !== inventory.target.id) {
        const forgotten = await forgetManagedMemoryRef(
          this.memoryRootForRef(inventory.target),
          inventory.target,
          this.now(),
          expectedTargetFingerprint,
        );
        if (!forgotten) {
          return memoryRememberResult(
            'needs_clarification',
            'That Memory changed after it was shown; list it again before correcting it',
          );
        }
        return memoryRememberResult(
          'updated',
          undefined,
          [duplicate.id],
          ['The corrected value already existed in the same semantic slot; the superseded Memory was forgotten.'],
        );
      }
      return memoryRememberResult('already_known', undefined, [duplicate.id]);
    }
    if (prepared.operation === 'remember') {
      const archived = await this.findRememberDuplicate(
        inventory.allRefs.filter((ref) => ref.lifecycle === 'archived'),
        prepared.normalizedStatement,
        claim,
      );
      if (archived !== undefined) {
        await forgetManagedMemoryRef(this.memoryRootForRef(archived), archived, this.now());
      }
    }
    return undefined;
  }

  private async findRememberDuplicate(
    refs: readonly MemoryItemRef[],
    normalizedStatement: string,
    claim: MemoryRememberClaim,
  ): Promise<MemoryItemRef | undefined> {
    for (const ref of refs) {
      if (canonicalClaimKey(ref.claimKey) !== canonicalClaimKey(claim.claimKey)
        || (ref.claimKind !== undefined && ref.claimKind !== claim.claimKind)) continue;
      if (normalizeClaimBody((await this.readRef(ref)).body) === normalizedStatement) return ref;
    }
    return undefined;
  }

  private async applyExplicitMemoryRemember(
    input: MemoryRememberInput,
    prepared: PreparedMemoryRememberInput,
    inventory: MemoryRememberInventory,
    claim: MemoryRememberClaim,
  ): Promise<MemoryRememberResult> {
    if (claim.conflictNeedsDecision) {
      const existingDecision = (await readLearningProposalStore(this.learningStorePath)).proposals.find((entry) => (
        entry.status === 'pending'
        && entry.proposal.destination === 'memdir_handoff'
        && canonicalClaimKey(entry.proposal.metadata.claimKey) === canonicalClaimKey(claim.claimKey)
        && entry.proposal.metadata.targetRefId === claim.actionTarget?.id
        && normalizeClaimBody(entry.proposal.body) === prepared.normalizedStatement
      ));
      if (existingDecision !== undefined) {
        return memoryRememberResult(
          'needs_review',
          `This claim conflicts with accepted Memory for ${claim.claimKey}`,
          [],
          [],
          [memoryProposalId(existingDecision.proposalId)],
        );
      }
    }
    const createdAt = this.now();
    const evidenceRef = input.evidenceRef?.trim() || createExplicitMemoryEvidenceRef(prepared, createdAt);
    const { digest, plan } = buildExplicitMemoryReview(
      prepared,
      claim,
      evidenceRef,
      createdAt,
      this.identity?.sessionId ?? this.sessionId,
      input.expectedTargetFingerprint,
    );
    const result = await this.applyReviewedEpisodeWithLock(plan, digest);
    return this.mapExplicitMemoryResult(prepared, inventory, result);
  }

  private async mapExplicitMemoryResult(
    prepared: PreparedMemoryRememberInput,
    inventory: MemoryRememberInventory,
    result: MemoryEpisodeReviewResult,
  ): Promise<MemoryRememberResult> {
    const proposalIds = result.proposalIds.map(memoryProposalId);
    const decision = result.decisions[0];
    if (decision?.kind === 'no_action' && decision.existingRefId !== undefined) {
      return memoryRememberResult('already_known', undefined, [decision.existingRefId], result.warnings, proposalIds);
    }
    if (result.appliedProposalIds.length === 0) {
      const status = decision?.kind === 'reject' || decision?.kind === 'quarantine'
        ? 'rejected'
        : 'needs_review';
      return memoryRememberResult(
        status,
        decision?.reason ?? result.warnings[0] ?? 'Memory was not applied automatically',
        [],
        result.warnings,
        proposalIds,
      );
    }
    const changedRefIds = prepared.operation === 'correct' && inventory.target !== undefined
      ? [inventory.target.id]
      : await this.findRememberedRefIds(prepared.normalizedStatement);
    return memoryRememberResult(
      prepared.operation === 'correct' ? 'updated' : 'remembered',
      undefined,
      changedRefIds,
      result.warnings,
      proposalIds,
    );
  }

  private async findRememberedRefIds(normalizedStatement: string): Promise<readonly string[]> {
    const refs = await this.listRefs({ kinds: ['memdir'], includePrivate: true });
    const snapshots = await Promise.all(refs.map(async (ref) => ({
      ref,
      body: (await this.readRef(ref)).body,
    })));
    return snapshots
      .filter(({ body }) => normalizeClaimBody(body) === normalizedStatement)
      .map(({ ref }) => ref.id);
  }

  async archiveRef(id: string): Promise<MemoryLifecycleOperationResult> {
    return withLearningFileLock(this.explicitMemoryLockPath(), () => this.archiveRefWithLock(id));
  }

  private async archiveRefWithLock(id: string): Promise<MemoryLifecycleOperationResult> {
    const matches = (await this.listRefs()).filter((candidate) => matchesMemoryMutationHandle(candidate, id));
    if (matches.length > 1) return lifecycleAmbiguous(id, 'archive');
    const ref = matches[0];
    if (ref?.kind !== 'memdir') return lifecycleNotFound(id, 'archive');
    await archiveManagedMemoryRef(this.memoryRootForRef(ref), ref, this.now());
    return {
      refId: id,
      operation: 'archive',
      acknowledged: true,
      residualSourceRefs: ref.sourceRefs,
      warnings: [],
    };
  }

  async forgetRef(
    id: string,
    expectedBodyFingerprint?: string,
  ): Promise<MemoryLifecycleOperationResult> {
    return withLearningFileLock(this.explicitMemoryLockPath(), () => (
      this.removeManagedRef(id, 'forget', expectedBodyFingerprint)
    ));
  }

  async purgeRef(id: string): Promise<MemoryLifecycleOperationResult> {
    return withLearningFileLock(this.explicitMemoryLockPath(), () => this.removeManagedRef(id, 'purge'));
  }

  private async removeManagedRef(
    id: string,
    operation: 'forget' | 'purge',
    expectedBodyFingerprint?: string,
  ): Promise<MemoryLifecycleOperationResult> {
    const matches = (await this.listRefs()).filter((candidate) => matchesMemoryMutationHandle(candidate, id));
    if (matches.length > 1) return lifecycleAmbiguous(id, operation);
    const ref = matches[0];
    if (ref?.kind !== 'memdir') return lifecycleNotFound(id, operation);
    const removed = await forgetManagedMemoryRef(
      this.memoryRootForRef(ref),
      ref,
      this.now(),
      expectedBodyFingerprint,
    );
    if (!removed) {
      return {
        refId: id,
        operation,
        acknowledged: false,
        residualSourceRefs: ref.sourceRefs,
        warnings: ['Memory changed after it was shown; list it again before mutating it'],
      };
    }
    return {
      refId: id,
      operation,
      acknowledged: true,
      residualSourceRefs: ref.sourceRefs,
      warnings: operation === 'purge' && ref.sourceRefs.length > 0
        ? ['source carriers follow their independent retention lifecycle']
        : [],
    };
  }

  async runCurator(input: MemoryCuratorInput = {}): Promise<MemoryGovernanceReport> {
    const refs = await this.listRefs({
      includePrivate: input.includePrivate,
      includeSensitive: input.includeSensitive,
    });
    const report = this.buildGovernanceReport(refs);
    this.emit({ type: 'curator.completed', reportId: report.reportId });
    return report;
  }

  async maybeRunAutoCurator(input: MemoryAutoCuratorInput = {}): Promise<MemoryAutoCuratorResult> {
    if (input.enabled === false) {
      return { ran: false, skippedReason: 'disabled' };
    }
    const now = this.now();
    const intervalMs = Math.max(0, input.intervalMs ?? DEFAULT_AUTO_CURATOR_INTERVAL_MS);
    const minRefs = Math.max(1, input.minRefs ?? DEFAULT_AUTO_CURATOR_MIN_REFS);
    const statePath = autoCuratorStatePath(this.memoryRoot);
    const state = await readAutoCuratorState(statePath);
    const lastCheckedAt = state?.lastCheckedAt ?? state?.lastRunAt;
    const nextEligibleAt = lastCheckedAt === undefined ? undefined : addMs(lastCheckedAt, intervalMs);
    if (nextEligibleAt !== undefined && compareIso(nextEligibleAt, now) > 0) {
      return { ran: false, skippedReason: 'not_due', nextEligibleAt };
    }

    const refs = (await this.listRefs({
      includePrivate: input.includePrivate,
      includeSensitive: input.includeSensitive,
    })).filter(isAutoCuratorCandidate);
    if (refs.length < minRefs) {
      return { ran: false, skippedReason: 'insufficient_refs' };
    }

    const report = this.buildGovernanceReport(refs);
    const reportPath = autoCuratorReportPath(this.memoryRoot, report);
    await writeFileAtomic(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    await pruneAutoCuratorReports(this.memoryRoot, AUTO_CURATOR_REPORT_CAP);
    await writeAutoCuratorState(statePath, {
      version: AUTO_CURATOR_STATE_VERSION,
      lastCheckedAt: now,
      lastRunAt: now,
      lastInventoryFingerprint: fingerprint(memoryInventoryPayload(refs)),
      lastReportPath: reportPath,
    });
    this.emit({ type: 'curator.completed', reportId: report.reportId });
    return {
      ran: true,
      report,
      reportPath,
      nextEligibleAt: addMs(now, intervalMs),
    };
  }

  async buildMemoryPack(input: MemoryPackInput): Promise<MemoryPack> {
    const generatedAt = this.now();
    const rankingText = memoryPackRankingText(input);
    const taskFingerprint = fingerprint(rankingText);
    if (input.ignoreMemory === true || shouldIgnoreMemory(input.task)) {
      return {
        generatedAt,
        taskFingerprint,
        memoryRevision: fingerprint('suppressed'),
        candidates: [],
        promptHints: [],
        hints: [],
        omitted: ['memory intentionally suppressed by request'],
        traceMetadata: {
          selectedRefIds: [],
          omittedRefIds: [],
          taskFingerprint,
          suppressed: true,
        },
      };
    }
    const refs = await this.listRefs({
      includePrivate: input.includePrivate,
      includeSensitive: input.includeSensitive,
    });
    const eligible = refs
      .filter((ref) => isPackEligible(ref, input))
      .sort((left, right) => (
        structuredMatchScore(right, input) - structuredMatchScore(left, input)
        || scoreRef(right, rankingText) - scoreRef(left, rankingText)
        || left.id.localeCompare(right.id)
      ));
    const maxCandidates = Math.max(0, input.maxCandidates ?? 12);
    const maxHints = Math.min(maxCandidates, Math.max(0, input.maxHints ?? 5));
    const selectedCandidates = eligible.slice(0, maxCandidates);
    const candidates = await this.buildPackHints(selectedCandidates, {
      ...input,
      includeSnippets: false,
    });
    const promptHints = await this.buildPackHints(selectedCandidates.slice(0, maxHints), input);
    this.emit({ type: 'pack.selected', refIds: promptHints.map((hint) => hint.ref.id) });
    return {
      generatedAt,
      taskFingerprint,
      memoryRevision: fingerprint(memoryInventoryPayload(eligible)),
      candidates,
      promptHints,
      hints: promptHints,
      omitted: eligible.slice(maxCandidates).map((ref) => ref.id),
      traceMetadata: {
        selectedRefIds: promptHints.map((hint) => hint.ref.id),
        omittedRefIds: eligible.slice(maxCandidates).map((ref) => ref.id),
        taskFingerprint,
        suppressed: false,
      },
    };
  }

  async reviewMemoryFeedback(input: MemoryReviewInput, signal?: AbortSignal): Promise<MemoryReviewPlan> {
    signal?.throwIfAborted();
    const createdAt = this.now();
    const modelInput = await this.prepareReviewInput(input);
    signal?.throwIfAborted();
    const sourceRefs = modelInput.sourceRefs;

    if (this.memoryReviewer === undefined) {
      const plan: MemoryReviewPlan = {
        trigger: input.trigger,
        createdAt,
        sourceRefs,
        candidateRefs: modelInput.candidateRefs,
        actions: [],
        warnings: [
          ...modelInput.warnings,
          'memory reviewer unavailable; semantic memory review was not run',
        ],
        ...(input.episodeDigest !== undefined ? { episodeDigest: input.episodeDigest } : {}),
      };
      this.emit({ type: 'review.completed', trigger: input.trigger, actionCount: 0 });
      return plan;
    }

    let reviewed: MemoryReviewPlan;
    try {
      reviewed = await this.memoryReviewer(modelInput, signal);
    } catch (error) {
      signal?.throwIfAborted();
      throw error;
    }
    signal?.throwIfAborted();
    const plan: MemoryReviewPlan = input.episodeDigest === undefined
      ? reviewed
      : { ...reviewed, episodeDigest: input.episodeDigest };
    this.emit({ type: 'review.completed', trigger: input.trigger, actionCount: plan.actions.length });
    return plan;
  }

  async prepareEpisodeReview(
    digest: import('../types.js').KodaXMemoryOutcomeDigest,
  ): Promise<MemoryReviewModelInput> {
    return this.prepareReviewInput({
      trigger: episodeReviewTrigger(digest),
      episodeDigest: digest,
      userFeedback: digest.summary,
      task: digest.objective,
      sourceRefs: digest.evidenceRefs,
    });
  }

  private async prepareReviewInput(input: MemoryReviewInput): Promise<MemoryReviewModelInput> {
    const sourceRefs = input.sourceRefs ?? [];
    const selection = await this.selectReviewCandidateRefs(input);
    return {
      trigger: input.trigger,
      userFeedback: input.userFeedback ?? input.episodeDigest?.summary ?? '',
      ...(input.task !== undefined ? { task: input.task } : {}),
      sourceRefs,
      candidateRefs: selection.candidateRefs,
      warnings: selection.warnings,
    };
  }

  async persistReviewPlan(plan: MemoryReviewPlan): Promise<readonly string[]> {
    return (await this.persistReviewPlanWithDecisions(plan)).proposalIds;
  }

  private async persistReviewPlanWithDecisions(
    plan: MemoryReviewPlan,
    revalidateAuthority?: () => Promise<void>,
  ): Promise<PersistedReviewPlan> {
    const proposalIds: string[] = [];
    const decisions: MemoryReviewPersistenceDecision[] = [];
    const existingRefs = await this.listRefs({ includePrivate: true });
    const storedProposals = (await readLearningProposalStore(this.learningStorePath)).proposals;
    for (let actionIndex = 0; actionIndex < plan.actions.length; actionIndex += 1) {
      const action = canonicalizeReviewAction(plan.actions[actionIndex]!);
      const consultation = await this.consultReviewAction(plan, action, actionIndex, existingRefs);
      if ((consultation.kind === 'conflict' && consultation.existingRefId === undefined)
        || consultation.kind === 'no_action'
        || consultation.kind === 'reject'
        || consultation.kind === 'quarantine') {
        decisions.push(consultation);
        continue;
      }
      const existingRef = consultation.existingRefId === undefined
        ? undefined
        : existingRefs.find((ref) => ref.id === consultation.existingRefId);
      const body = consultation.kind === 'evidence_update' && existingRef !== undefined
        ? extractClaimBody((await this.readRef(existingRef)).body)
        : action.proposedBody?.trim();
      if (body === undefined || body.length === 0) {
        decisions.push({
          actionIndex,
          kind: 'reject',
          reason: 'memory proposal body is empty',
          ...(consultation.existingRefId !== undefined
            ? { existingRefId: consultation.existingRefId }
            : {}),
        });
        continue;
      }
      const proposalId = `memory-review-${fingerprint([
        plan.trigger,
        ...plan.sourceRefs,
        consultation.kind,
        consultation.existingRefId ?? '',
        action.summary,
        body,
      ].join('\0')).slice(0, 24)}`;
      const digest = plan.episodeDigest;
      const sourceRefs = uniqueStrings([
        ...(existingRef?.sourceRefs ?? []),
        ...(digest?.evidenceRefs ?? plan.sourceRefs),
      ]);
      const placement = await this.resolveReviewMemoryPlacement(
        plan,
        action,
        existingRef,
        storedProposals,
      );
      const handoff: MemoryLearningHandoff = {
        destination: 'memdir_handoff',
        proposalId,
        origin: 'background_learning',
        userLabel: 'context_note',
        memoryKind: placement.memoryKind,
        body,
        metadata: {
          writeOrigin: 'background_learning',
          executionContext: 'primary',
          sessionId: digest?.sessionId ?? 'memory-review',
          sourceRefs,
          completedTurn: true,
          persistenceKind: consultation.kind,
          reviewRationale: action.rationale.slice(0, 1_024),
          reviewRisk: action.risk,
          ...(action.claimKind !== undefined ? { claimKind: action.claimKind } : {}),
          ...(action.claimKey !== undefined ? { claimKey: action.claimKey } : {}),
          ...(action.actionSignature !== undefined ? { actionSignature: action.actionSignature } : {}),
          ...(action.preconditions !== undefined ? { preconditions: action.preconditions } : {}),
          ...(placement.applicability !== undefined
            ? { applicability: placement.applicability }
            : {}),
          requestedLifecycle: placement.requestedLifecycle,
          ...(digest !== undefined ? {
            episodeOutcome: digest.outcome,
            verifiedEvidence: hasVerifiedDigestEvidence(digest),
            ...(this.identity?.projectId !== undefined
              ? { evidenceProjectId: this.identity.projectId }
              : {}),
          } : {}),
          ...(existingRef !== undefined ? {
            targetRefId: existingRef.id,
            ...(existingRef.storageUri !== undefined ? { targetStorageUri: existingRef.storageUri } : {}),
          } : {}),
          ...(action.authorizationTargetFingerprint === undefined
            ? {}
            : { authorizationTargetFingerprint: action.authorizationTargetFingerprint }),
        },
      };
      await upsertLearningProposal(this.learningStorePath, handoff, {
        now: this.now,
        ...(revalidateAuthority === undefined ? {} : { revalidateAuthority }),
      });
      if (action.claimKind === 'procedure' && digest !== undefined && hasVerifiedDigestEvidence(digest)) {
        await upsertLearningProposal(this.procedurePromotionStorePath(), handoff, { now: this.now });
      }
      proposalIds.push(proposalId);
      decisions.push({ ...consultation, proposalId });
      this.emit({ type: 'proposal.created', proposalId: memoryProposalId(proposalId) });
    }
    return { proposalIds, decisions };
  }

  private async resolveReviewMemoryPlacement(
    plan: MemoryReviewPlan,
    action: MemoryReviewDraftAction,
    existingRef: MemoryItemRef | undefined,
    proposals: readonly StoredLearningProposal[],
  ): Promise<ReviewMemoryPlacement> {
    if (this.scopedRoots.length === 0) {
      return this.customRootPlacement(action, existingRef);
    }
    const promotionProposals = action.claimKind === 'procedure' && this.identity !== undefined
      ? (await readLearningProposalStore(this.procedurePromotionStorePath())).proposals
      : [];
    const historyProposals = [...proposals, ...promotionProposals];
    if (existingRef !== undefined) return this.existingRefPlacement(plan, action, existingRef, historyProposals);
    return this.newClaimPlacement(plan, action, historyProposals);
  }

  private customRootPlacement(
    action: MemoryReviewDraftAction,
    existingRef: MemoryItemRef | undefined,
  ): ReviewMemoryPlacement {
    if (existingRef === undefined) return this.projectPlacement(action.claimKind);
    return {
      memoryKind: 'project',
      ...(existingRef.applicability === undefined ? {} : { applicability: existingRef.applicability }),
      requestedLifecycle: existingRef.lifecycle === 'provisional' ? 'provisional' : 'active',
    };
  }

  private existingRefPlacement(
    plan: MemoryReviewPlan,
    action: MemoryReviewDraftAction,
    existingRef: MemoryItemRef,
    historyProposals: readonly StoredLearningProposal[],
  ): ReviewMemoryPlacement {
    if (action.claimKind === 'procedure' && action.claimKey !== undefined && existingRef.scope === 'agent') {
      const digest = plan.episodeDigest;
      const currentVerified = digest !== undefined && hasVerifiedDigestEvidence(digest);
      const history = procedurePromotionHistory(
        action.claimKey,
        historyProposals,
        currentVerified && digest?.outcome === 'succeeded' ? this.identity?.projectId : undefined,
        currentVerified && digest?.outcome === 'failed',
      );
      const active = history.successes >= 3 && history.projects.size >= 2 && !history.hasCounterexample;
      return {
        memoryKind: 'semantic_memory',
        ...(existingRef.applicability === undefined ? {} : { applicability: existingRef.applicability }),
        requestedLifecycle: active ? 'active' : 'provisional',
      };
    }
    return {
      memoryKind: existingRef.scope === 'user'
        ? 'user'
        : existingRef.scope === 'agent'
          ? 'semantic_memory'
          : 'project',
      ...(existingRef.applicability === undefined ? {} : { applicability: existingRef.applicability }),
      requestedLifecycle: existingRef.lifecycle === 'provisional' ? 'provisional' : 'active',
    };
  }

  private newClaimPlacement(
    plan: MemoryReviewPlan,
    action: MemoryReviewDraftAction,
    historyProposals: readonly StoredLearningProposal[],
  ): ReviewMemoryPlacement {
    if (action.claimKind === 'preference'
      && (plan.trigger === 'explicit_remember' || plan.trigger === 'user_correction')
      && this.identity?.userId !== undefined) {
      return {
        memoryKind: 'user',
        applicability: { tenantId: this.identity.tenantId, userId: this.identity.userId },
        requestedLifecycle: 'active',
      };
    }
    if (action.claimKind !== 'procedure' || action.claimKey === undefined || this.identity === undefined) {
      return this.projectPlacement(action.claimKind);
    }
    const digest = plan.episodeDigest;
    const currentVerified = digest !== undefined && hasVerifiedDigestEvidence(digest);
    const history = procedurePromotionHistory(
      action.claimKey,
      historyProposals,
      currentVerified && digest?.outcome === 'succeeded' ? this.identity.projectId : undefined,
      currentVerified && digest?.outcome === 'failed',
    );
    const agentScoped = history.projects.size >= 2;
    if (!agentScoped) return this.projectPlacement('procedure');
    const active = history.successes >= 3 && history.projects.size >= 2 && !history.hasCounterexample;
    return {
      memoryKind: 'semantic_memory',
      applicability: { tenantId: this.identity.tenantId, agentId: this.identity.agentId },
      requestedLifecycle: active ? 'active' : 'provisional',
    };
  }

  private procedurePromotionStorePath(): string {
    const root = this.identity === undefined
      ? this.memoryRoot
      : resolveScopedMemoryRoot(this.identity, 'agent');
    return join(root, '.governance', 'procedure-evidence.json');
  }

  private projectPlacement(claimKind: MemoryReviewDraftAction['claimKind']): ReviewMemoryPlacement {
    if (this.identity?.projectId === undefined) {
      return { memoryKind: 'project', requestedLifecycle: 'active' };
    }
    return {
      memoryKind: 'project',
      applicability: {
        tenantId: this.identity.tenantId,
        ...(claimKind === 'procedure' ? { agentId: this.identity.agentId } : {}),
        projectId: this.identity.projectId,
      },
      requestedLifecycle: 'active',
    };
  }

  async reviewEpisode(
    digest: import('../types.js').KodaXMemoryOutcomeDigest,
    signal?: AbortSignal,
  ): Promise<MemoryEpisodeReviewResult> {
    const plan = await this.reviewMemoryFeedback({
      trigger: episodeReviewTrigger(digest),
      episodeDigest: digest,
      userFeedback: digest.summary,
      task: digest.objective,
      sourceRefs: digest.evidenceRefs,
    }, signal);
    return this.applyReviewedEpisode(plan, digest, signal);
  }

  async applyReviewedEpisode(
    reviewedPlan: MemoryReviewPlan,
    digest: import('../types.js').KodaXMemoryOutcomeDigest,
    signal?: AbortSignal,
    revalidateAuthority?: () => Promise<void>,
  ): Promise<MemoryEpisodeReviewResult> {
    return withLearningFileLock(this.explicitMemoryLockPath(), () => (
      this.applyReviewedEpisodeWithLock(reviewedPlan, digest, signal, revalidateAuthority)
    ));
  }

  private async applyReviewedEpisodeWithLock(
    reviewedPlan: MemoryReviewPlan,
    digest: import('../types.js').KodaXMemoryOutcomeDigest,
    signal?: AbortSignal,
    revalidateAuthority?: () => Promise<void>,
  ): Promise<MemoryEpisodeReviewResult> {
    const plan = reviewedPlan.episodeDigest === digest
      ? reviewedPlan
      : { ...reviewedPlan, episodeDigest: digest };
    // Before the first durable effect, cancellation must remain retryable work.
    // Returning an empty success here would let legacy drains commit a receipt.
    signal?.throwIfAborted();
    const persisted = await this.persistReviewPlanWithDecisions(plan, revalidateAuthority);
    const proposalIds = persisted.proposalIds;
    const appliedProposalIds: string[] = [];
    const warnings = [...plan.warnings];
    for (const decision of persisted.decisions) {
      if (isAborted(signal)) {
        warnings.push('episode review timed out before governed apply');
        break;
      }
      const proposalId = decision.proposalId;
      if (proposalId === undefined) continue;
      if (decision.kind === 'conflict') continue;
      const action = plan.actions[decision.actionIndex];
      if (action === undefined || !isEligibleEpisodePromotion(action, digest)) continue;
      const result = await this.applyHostEligibleProposal(
        memoryProposalId(proposalId),
        `${MEMORY_POLICY_VERSION}:episode-promotion`,
        'verified low-risk episode memory',
        revalidateAuthority,
      );
      if (result.applied) appliedProposalIds.push(proposalId);
      else if (result.skippedReason !== undefined) warnings.push(result.skippedReason);
    }
    return { plan, proposalIds, appliedProposalIds, decisions: persisted.decisions, warnings };
  }

  private async consultReviewAction(
    plan: MemoryReviewPlan,
    action: MemoryReviewDraftAction,
    actionIndex: number,
    existingRefs: readonly MemoryItemRef[],
  ): Promise<MemoryReviewPersistenceDecision> {
    if (action.action === 'quarantine' || isRestrictedMemoryBody(action.proposedBody ?? '')) {
      return { actionIndex, kind: 'quarantine', reason: 'memory content is restricted or explicitly quarantined' };
    }
    if ((action.action !== 'write_memdir'
        && action.action !== 'patch_memdir'
        && action.action !== 'conflict_report')
      || action.proposedBody === undefined
      || action.proposedBody.trim().length === 0) {
      return { actionIndex, kind: 'reject', reason: 'review action is not a supported durable-memory mutation' };
    }
    if (action.claimKind === undefined || !isStableMemoryClaimKey(action.claimKey)) {
      return { actionIndex, kind: 'reject', reason: 'durable-memory mutation requires a stable claimKind and claimKey' };
    }
    const candidateIds = new Set(plan.candidateRefs.map((candidate) => candidate.ref.id));
    if (action.targetRefIds.some((targetRefId) => !candidateIds.has(targetRefId))) {
      return { actionIndex, kind: 'reject', reason: 'review action target was not in the frozen candidate set' };
    }
    const unboundClaim = existingRefs.find((ref) => (
      !candidateIds.has(ref.id)
      && canonicalClaimKey(ref.claimKey) === canonicalClaimKey(action.claimKey)
    ));
    if (action.targetRefIds.length === 0 && unboundClaim !== undefined) {
      return { actionIndex, kind: 'reject', reason: 'matching claim was not in the frozen candidate set' };
    }
    const existing = findCompatibleReviewRef(action, plan, existingRefs);
    if (action.action === 'conflict_report' || action.relationship === 'conflict') {
      return existing === undefined
        ? { actionIndex, kind: 'reject', reason: 'review conflict has no frozen compatible target' }
        : {
            actionIndex,
            kind: 'conflict',
            existingRefId: existing.id,
            reason: 'review reported an unresolved contradiction',
          };
    }
    const handled = handledExplicitMemoryDisposition(plan, action, existing);
    if (handled === 'same') {
      return {
        actionIndex,
        kind: 'no_action',
        ...(existing === undefined ? {} : { existingRefId: existing.id }),
        reason: 'explicit Memory operation already handled this claim',
      };
    }
    if (handled === 'conflict') {
      return {
        actionIndex,
        kind: 'conflict',
        ...(existing === undefined ? {} : { existingRefId: existing.id }),
        reason: 'episode review conflicts with an explicit Memory operation from the same episode',
      };
    }
    if (existing === undefined) {
      return action.action === 'patch_memdir'
        ? { actionIndex, kind: 'reject', reason: 'patch target is missing or governance-incompatible' }
        : { actionIndex, kind: 'create', reason: 'no compatible governed claim exists' };
    }
    if (existing.lifecycle === 'quarantined') {
      return {
        actionIndex,
        kind: 'quarantine',
        existingRefId: existing.id,
        reason: 'compatible claim is quarantined',
      };
    }
    if (existing.lifecycle === 'archived' || existing.authority === 'proposal_only') {
      return {
        actionIndex,
        kind: 'reject',
        existingRefId: existing.id,
        reason: 'compatible claim is not eligible for governed update',
      };
    }
    const snapshot = await this.readRef(existing);
    const sameClaim = action.relationship === 'same_claim'
      || normalizeClaimBody(snapshot.body) === normalizeClaimBody(action.proposedBody);
    const incomingEvidence = plan.episodeDigest?.evidenceRefs ?? plan.sourceRefs;
    const hasNewEvidence = incomingEvidence.some((ref) => !existing.sourceRefs.includes(ref));
    if (sameClaim && !hasNewEvidence) {
      return {
        actionIndex,
        kind: 'no_action',
        existingRefId: existing.id,
        reason: 'compatible claim and evidence already exist',
      };
    }
    return {
      actionIndex,
      kind: sameClaim && action.relationship !== 'condition_refinement'
        ? 'evidence_update'
        : 'condition_refinement',
      existingRefId: existing.id,
      reason: sameClaim
        ? 'compatible claim has new independent evidence'
        : 'compatible claim receives a reviewed condition refinement',
    };
  }

  private async applyHostEligibleProposal(
    id: string,
    policyId: string,
    policyReason: string,
    revalidateAuthority?: () => Promise<void>,
  ): Promise<MemoryApplyResult> {
    return withLearningFileLock(this.proposalDecisionLockPath(), async () => {
      const proposal = (await this.listInbox()).find((candidate) => candidate.id === id);
      if (proposal === undefined) return skippedApply(id, 'memory proposal is not pending');
      const staleClaim = await this.staleProposalClaimReason(proposal);
      if (staleClaim !== undefined) return skippedApply(id, staleClaim);
      const result = await this.adapterForProposal(proposal).applyProposal(proposal, {
        proposalId: proposal.id,
        approvedBy: 'host',
        approvedAt: this.now(),
        expectedFingerprints: proposal.expectedFingerprints,
        policyId,
        policyReason,
        ...(revalidateAuthority === undefined ? {} : { revalidateAuthority }),
      });
      if (result.applied) this.emit({ type: 'proposal.approved', proposalId: id });
      return result;
    });
  }

  private async staleProposalClaimReason(proposal: MemoryActionProposal): Promise<string | undefined> {
    if (proposal.action !== 'write_memdir' && proposal.action !== 'patch_memdir') return undefined;
    const target = proposal.targetRefs.find((ref) => ref.kind === 'memdir');
    if (target?.claimKey === undefined) return undefined;
    const refs = await this.listRefs({
      kinds: ['memdir'],
      lifecycles: ['active', 'trusted'],
      includePrivate: true,
    });
    const competing = refs.find((ref) => (
      canonicalClaimKey(ref.claimKey) === canonicalClaimKey(target.claimKey)
      && !sameMemoryStorage(ref, target)
    ));
    return competing === undefined
      ? undefined
      : `memory semantic slot changed after proposal preview: ${target.claimKey}`;
  }

  private async projectLearningProposal(entry: StoredLearningProposal): Promise<MemoryActionProposal | undefined> {
    if (entry.proposal.destination === 'memdir_handoff') {
      return this.projectMemdirHandoff(entry, entry.proposal);
    }
    if (entry.proposal.destination === 'reasoning_handoff') {
      return this.projectReasoningHandoff(entry, entry.proposal);
    }
    return undefined;
  }

  private async projectMemdirHandoff(
    entry: StoredLearningProposal,
    handoff: MemoryLearningHandoff,
  ): Promise<MemoryActionProposal | undefined> {
    const targetRoot = this.memoryRootForHandoff(handoff);
    if (targetRoot === undefined) return undefined;
    if (handoff.metadata.targetStorageUri !== undefined
      && !await isContainedMemoryPath(targetRoot, handoff.metadata.targetStorageUri)) {
      return undefined;
    }
    const descriptor = this.scopedRoots.find((candidate) => candidate.root === targetRoot);
    const plan = buildMemdirWritePlan(targetRoot, handoff, entry.proposalId);
    const targetRef = await buildMemdirTargetRef(plan.targetPath, handoff, entry, descriptor);
    const indexRef = await buildEntrypointRef(plan.entrypointPath, descriptor);
    const sourceRef = learningRefFromEntry(entry);
    const beforeFingerprints = {
      [targetRef.id]: handoff.metadata.authorizationTargetFingerprint
        ?? targetRef.bodyFingerprint
        ?? MISSING_FINGERPRINT,
      [indexRef.id]: indexRef.bodyFingerprint ?? MISSING_FINGERPRINT,
    };
    const preview: MemoryApplyPreview = {
      summary: `${handoff.metadata.persistenceKind === 'evidence_update'
        || handoff.metadata.persistenceKind === 'condition_refinement'
        || handoff.metadata.persistenceKind === 'conflict' ? 'Update' : 'Write'} ${handoff.memoryKind} memory from learning proposal ${entry.proposalId}.`,
      changedRefs: [targetRef, indexRef],
      changedPaths: [plan.targetPath, plan.entrypointPath],
      beforeFingerprints,
      afterFingerprints: {
        [targetRef.id]: fingerprint(plan.content),
      },
      diff: plan.content,
      warnings: [],
    };
    return {
      id: memoryProposalId(entry.proposalId),
      action: handoff.metadata.persistenceKind === 'evidence_update'
        || handoff.metadata.persistenceKind === 'condition_refinement'
        || handoff.metadata.persistenceKind === 'conflict'
        ? 'patch_memdir'
        : 'write_memdir',
      targetRefs: [targetRef, indexRef],
      sourceRefs: [sourceRef],
      expectedFingerprints: beforeFingerprints,
      rationale: handoff.metadata.reviewRationale
        ?? `F224 classified this as ${handoff.memoryKind} memory.`,
      risk: handoff.metadata.reviewRisk ?? 'medium',
      preview,
      requiresApproval: true,
      createdAt: entry.createdAt,
    };
  }

  private projectReasoningHandoff(
    entry: StoredLearningProposal,
    handoff: ReasoningLearningHandoff,
  ): MemoryActionProposal {
    const reasoningRef = reasoningRefFromEntry(entry);
    const sourceRef = learningRefFromEntry(entry);
    const preview: MemoryApplyPreview = {
      summary: `Record reasoning report handoff: ${handoff.title}`,
      changedRefs: [],
      changedPaths: [],
      beforeFingerprints: { [reasoningRef.id]: reasoningRef.bodyFingerprint ?? fingerprint(handoff.body) },
      warnings: ['No stable reasoning-strategy carrier exists yet; approval records the handoff only.'],
    };
    return {
      id: memoryProposalId(entry.proposalId),
      action: 'no_op',
      targetRefs: [reasoningRef],
      sourceRefs: [sourceRef],
      expectedFingerprints: preview.beforeFingerprints,
      rationale: 'Reasoning handoff stays as a report until a stable carrier exists.',
      risk: 'low',
      preview,
      requiresApproval: true,
      createdAt: entry.createdAt,
    };
  }

  private async listLearningRefs(): Promise<readonly MemoryItemRef[]> {
    const store = await readLearningProposalStore(this.learningStorePath);
    if (store.warnings.length > 0) return [];
    const refs: MemoryItemRef[] = [];
    for (const entry of store.proposals) {
      if (entry.proposal.destination === 'memdir_handoff' || entry.proposal.destination === 'reasoning_handoff') {
        refs.push(learningRefFromEntry(entry));
      }
      if (entry.proposal.destination === 'reasoning_handoff') {
        refs.push(reasoningRefFromEntry(entry));
      }
    }
    return refs;
  }

  private async readLearningRef(ref: MemoryItemRef): Promise<MemoryBodySnapshot> {
    const proposalId = ref.kind === 'reasoning_report'
      ? ref.id.replace(/^reasoning_report:/, '')
      : ref.id.replace(/^learning_proposal:/, '');
    const store = await readLearningProposalStore(this.learningStorePath);
    const entry = store.proposals.find((proposal) => proposal.proposalId === proposalId);
    if (entry === undefined) {
      return {
        ref,
        body: '',
        bodyFingerprint: fingerprint(''),
        readAt: this.now(),
        warnings: [`learning proposal not found: ${proposalId}`],
      };
    }
    const body = learningBody(entry);
    return {
      ref: { ...ref, bodyFingerprint: fingerprint(body) },
      body,
      bodyFingerprint: fingerprint(body),
      readAt: this.now(),
      warnings: store.warnings,
    };
  }

  private async listProjectDocRefs(): Promise<readonly MemoryItemRef[]> {
    const refs: MemoryItemRef[] = [];
    for (const docPath of this.projectDocs) {
      const read = await readTextIfExists(docPath);
      if (!read.exists) continue;
      refs.push({
        kind: 'project_doc',
        id: `project_doc:${relative(this.cwd, docPath).replace(/\\/g, '/')}`,
        scope: 'project',
        title: basename(docPath),
        owner: 'project',
        lifecycle: 'readonly',
        authority: 'read_only',
        visibility: 'prompt_safe',
        sourceRefs: [],
        relatedRefs: [],
        bodyFingerprint: fingerprint(read.content),
        storageUri: docPath,
      });
    }
    return refs;
  }

  private listSessionTraceRefs(): readonly MemoryItemRef[] {
    if (this.sessionLineage === undefined) return [];
    return this.sessionLineage.entries.map((entry) => sessionTraceRefFromEntry(this.sessionId, entry));
  }

  private listArtifactLedgerRefs(): readonly MemoryItemRef[] {
    return this.artifactLedger.map((entry) => artifactLedgerRefFromEntry(this.sessionId, entry));
  }

  private readSessionTraceRef(ref: MemoryItemRef): MemoryBodySnapshot {
    const entryId = parseScopedMemoryRefId(ref.id, 'session_trace', this.sessionId);
    const entry = this.sessionLineage?.entries.find((candidate) => candidate.id === entryId);
    const body = entry === undefined ? '' : stringifyJson(entry);
    return {
      ref: { ...ref, bodyFingerprint: fingerprint(body) },
      body,
      bodyFingerprint: fingerprint(body),
      readAt: this.now(),
      warnings: entry === undefined ? [`session trace entry not found: ${ref.id}`] : [],
    };
  }

  private readArtifactLedgerRef(ref: MemoryItemRef): MemoryBodySnapshot {
    const entryId = parseScopedMemoryRefId(ref.id, 'artifact_ledger', this.sessionId);
    const entry = this.artifactLedger.find((candidate) => candidate.id === entryId);
    const body = entry === undefined ? '' : stringifyJson(entry);
    return {
      ref: { ...ref, bodyFingerprint: fingerprint(body) },
      body,
      bodyFingerprint: fingerprint(body),
      readAt: this.now(),
      warnings: entry === undefined ? [`artifact ledger entry not found: ${ref.id}`] : [],
    };
  }

  private async listSkillRefs(): Promise<readonly MemoryItemRef[]> {
    if (!this.discoverSkills) return [];
    let skills: readonly SkillMetadata[];
    try {
      const registry = await initializeSkillRegistry(this.cwd);
      skills = registry.list();
    } catch {
      return [];
    }
    return skills.map((skill) => ({
      kind: 'skill',
      id: `skill:${skill.name}`,
      scope: skill.source === 'builtin' ? 'builtin' : skill.source === 'user' ? 'user' : 'project',
      title: skill.name,
      owner: skill.source === 'builtin' ? 'kodax' : skill.source === 'user' ? 'user' : 'project',
      lifecycle: skill.source === 'builtin' ? 'readonly' : 'active',
      authority: 'read_only',
      visibility: 'prompt_safe',
      sourceRefs: [],
      relatedRefs: [],
      storageUri: join(skill.path, 'SKILL.md'),
    } satisfies MemoryItemRef));
  }

  private async buildPackHints(
    refs: readonly MemoryItemRef[],
    input: MemoryPackInput,
  ): Promise<readonly MemoryPackHint[]> {
    const hints: MemoryPackHint[] = [];
    for (const ref of refs) {
      const snapshot = input.includeSnippets === true ? await this.readRef(ref) : undefined;
      const hook = sanitizePromptSafeMemoryClaim(ref.title ?? ref.id, 240) ?? ref.id;
      const rawSnippet = snapshot === undefined || snapshot.body.trim().length === 0
        ? undefined
        : input.purpose === 'deliberate_query' || input.purpose === 'intervention'
          ? promptSafeClaimSnippet(snapshot.body)
          : firstSnippet(snapshot.body);
      const bodySnippet = rawSnippet === undefined
        ? undefined
        : sanitizePromptSafeMemoryClaim(rawSnippet, 512);
      hints.push({
        ref,
        hook,
        reason: packReason(ref, memoryPackRankingText(input)),
        ...(bodySnippet !== undefined && snapshot !== undefined
          ? {
              bodySnippet,
              bodyFingerprint: snapshot.bodyFingerprint,
            }
          : ref.bodyFingerprint !== undefined ? { bodyFingerprint: ref.bodyFingerprint } : {}),
      });
    }
    return hints;
  }

  private async selectReviewCandidateRefs(input: MemoryReviewInput): Promise<ReviewCandidateSelection> {
    const maxRefs = Math.max(0, input.maxRefs ?? 6);
    if (maxRefs === 0) return { candidateRefs: [], warnings: [] };

    const refs = await this.listRefs({
      includePrivate: input.includePrivate,
      includeSensitive: input.includeSensitive,
    });
    const warnings: string[] = [];
    const selected = input.candidateRefIds !== undefined && input.candidateRefIds.length > 0
      ? selectRefsById(refs, input.candidateRefIds, maxRefs, warnings)
      : refs
          .filter(isReviewCandidateEligible)
          .sort((left, right) => scoreRef(right, reviewTask(input)) - scoreRef(left, reviewTask(input)))
          .slice(0, maxRefs);

    const candidateRefs: MemoryReviewCandidateRef[] = [];
    for (const ref of selected) {
      candidateRefs.push(await this.readReviewCandidateRef(ref));
    }
    return { candidateRefs, warnings };
  }

  private async readReviewCandidateRef(ref: MemoryItemRef): Promise<MemoryReviewCandidateRef> {
    try {
      const snapshot = await this.readRef(ref);
      return {
        ref: snapshot.ref,
        ...(snapshot.body.trim().length > 0 ? { bodySnippet: firstSnippet(snapshot.body) } : {}),
        bodyFingerprint: snapshot.bodyFingerprint,
        warnings: snapshot.warnings,
      };
    } catch (error) {
      return {
        ref,
        ...(ref.bodyFingerprint !== undefined ? { bodyFingerprint: ref.bodyFingerprint } : {}),
        warnings: [`failed to read memory ref: ${errorMessage(error)}`],
      };
    }
  }

  private adapterForProposal(proposal: MemoryActionProposal): MemorySourceAdapter {
    if (proposal.action === 'write_memdir' || proposal.action === 'patch_memdir') {
      const target = proposal.targetRefs.find((ref) => ref.kind === 'memdir' && ref.storageUri !== undefined);
      return this.memdirAdapters().find((adapter) => adapter.owns(target)) ?? this.memdirAdapter();
    }
    return new LearningHandoffAdapter(this.learningStorePath, this.now);
  }

  private memdirAdapter(): MemdirMemoryAdapter {
    return this.memdirAdapters()[0]
      ?? new MemdirMemoryAdapter(this.memoryRoot, this.learningStorePath, this.now);
  }

  private memdirAdapters(): readonly MemdirMemoryAdapter[] {
    if (this.scopedRoots.length === 0) {
      return [new MemdirMemoryAdapter(
        this.memoryRoot,
        this.learningStorePath,
        this.now,
        this.applicability,
        'project',
      )];
    }
    return this.scopedRoots.map((entry) => new MemdirMemoryAdapter(
      entry.root,
      this.learningStorePath,
      this.now,
      entry.applicability,
      entry.scope,
    ));
  }

  private memoryRootForHandoff(handoff: MemoryLearningHandoff): string | undefined {
    if (handoff.metadata.targetStorageUri !== undefined) {
      const targetStorage = resolve(handoff.metadata.targetStorageUri);
      const existingRoot = [this.memoryRoot, ...this.scopedRoots.map((entry) => entry.root)]
        .find((root) => {
        const targetRelative = relative(root, targetStorage);
        return targetRelative.length > 0
          && targetRelative !== '..'
          && !targetRelative.startsWith(`..${sep}`)
          && !isAbsolute(targetRelative);
      });
      return existingRoot;
    }
    const targetScope = handoff.memoryKind === 'user'
      ? 'user'
      : handoff.memoryKind === 'semantic_memory'
        ? 'agent'
        : 'project';
    return this.scopedRoots.find((entry) => entry.scope === targetScope)?.root ?? this.memoryRoot;
  }

  private memoryRootForRef(ref: MemoryItemRef): string {
    const storage = ref.storageUri === undefined ? undefined : resolve(ref.storageUri);
    return this.scopedRoots.find((entry) =>
      storage?.startsWith(`${resolve(entry.root)}${sep}`))?.root ?? this.memoryRoot;
  }

  private emit(event: MemoryEvent): void {
    this.onEvent?.(event);
  }

  private buildGovernanceReport(refs: readonly MemoryItemRef[]): MemoryGovernanceReport {
    const generatedAt = this.now();
    const findings = buildGovernanceFindings(refs);
    const reportId = `memory-governance:${fingerprint(`${generatedAt}:${findings.length}`).slice(0, 12)}`;
    return {
      reportId,
      generatedAt,
      findings: findings.length > 0
        ? findings
        : [{
            kind: 'no_op',
            severity: 'info',
            refIds: [],
            summary: 'No memory governance findings.',
            suggestedAction: 'no_op',
          }],
      warnings: [],
    };
  }
}

class LearningHandoffAdapter implements MemorySourceAdapter {
  readonly kind = 'learning_proposal' as const;

  constructor(
    private readonly learningStorePath: string,
    private readonly now: () => string,
  ) {}

  async listRefs(filter: MemoryRefFilter = {}): Promise<readonly MemoryItemRef[]> {
    const store = await readLearningProposalStore(this.learningStorePath);
    if (store.warnings.length > 0) return [];
    return store.proposals
      .filter((entry) => entry.proposal.destination === 'memdir_handoff' || entry.proposal.destination === 'reasoning_handoff')
      .map(learningRefFromEntry)
      .filter((ref) => matchesFilter(ref, filter));
  }

  async readRef(ref: MemoryItemRef): Promise<MemoryBodySnapshot> {
    return readStorageBackedRef(ref, this.now);
  }

  async previewProposal(proposal: MemoryActionProposal): Promise<MemoryApplyPreview> {
    return proposal.preview;
  }

  async applyProposal(
    proposal: MemoryActionProposal,
    approval: MemoryApproval,
  ): Promise<MemoryApplyResult> {
    const proposalId = parseMemoryProposalId(proposal.id);
    if (proposalId === undefined) return skippedApply(proposal.id, 'invalid memory proposal id');
    if (!fingerprintsMatch(proposal.expectedFingerprints, approval.expectedFingerprints)) {
      return skippedApply(proposal.id, 'approval fingerprints do not match proposal preview');
    }
    const updated = await updateLearningProposalStatus(
      this.learningStorePath,
      proposalId,
      'approved',
      {
        expectedStatus: 'pending',
        appliedChangedPaths: [],
        approvedBy: approval.approvedBy,
        approvedAt: approval.approvedAt,
        approvalPolicyId: approval.policyId,
        approvalPolicyReason: approval.policyReason,
        approvalExpectedFingerprints: approval.expectedFingerprints,
        approvalResultingFingerprints: approval.expectedFingerprints,
        now: this.now,
        ...(approval.revalidateAuthority === undefined
          ? {}
          : { revalidateAuthority: approval.revalidateAuthority }),
      },
    );
    return {
      proposalId: proposal.id,
      applied: true,
      changedRefs: proposal.targetRefs,
      changedPaths: [],
      warnings: updated.status === 'approved' ? [] : ['proposal status did not become approved'],
    };
  }
}

class MemdirMemoryAdapter implements MemorySourceAdapter {
  readonly kind = 'memdir' as const;

  constructor(
    private readonly memoryRoot: string,
    private readonly learningStorePath: string,
    private readonly now: () => string,
    private readonly applicability?: MemoryApplicability,
    private readonly scope: Extract<MemoryScope, 'project' | 'workspace' | 'agent' | 'user'> = 'project',
  ) {}

  owns(ref: MemoryItemRef | undefined): boolean {
    if (ref?.storageUri === undefined) return false;
    const targetRelative = relative(this.memoryRoot, ref.storageUri);
    return targetRelative.length > 0
      && targetRelative !== '..'
      && !targetRelative.startsWith(`..${sep}`)
      && !isAbsolute(targetRelative);
  }

  async listRefs(filter: MemoryRefFilter = {}): Promise<readonly MemoryItemRef[]> {
    const refs: MemoryItemRef[] = [];
    const proposalStore = await readLearningProposalStore(this.learningStorePath);
    const receiptStorePath = sharedMemoryReceiptStore(this.memoryRoot);
    const receiptStore = receiptStorePath === this.learningStorePath
      ? proposalStore
      : await readLearningProposalStore(receiptStorePath);
    const receipts = [...proposalStore.proposals, ...receiptStore.proposals];
    let entries: readonly { readonly name: string; readonly isFile: () => boolean }[];
    try {
      entries = await readdir(this.memoryRoot, { withFileTypes: true });
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name === 'MEMORY.md') continue;
      const filePath = join(this.memoryRoot, entry.name);
      const read = await readTextIfExists(filePath);
      if (!read.exists) continue;
      const ref = memdirRefFromFile(filePath, read.content);
      const lifecycle = await resolveManagedLifecycle(this.memoryRoot, ref);
      if (lifecycle === 'forgotten') continue;
      const governedRef = lifecycle === ref.lifecycle ? ref : { ...ref, lifecycle };
      const scopedRef = this.applicability === undefined
        ? governedRef
        : decorateScopedRef(governedRef, this.scope, this.applicability);
      const receipt = findApplyReceipt(receipts, scopedRef, read.content);
      const receiptMetadata = receipt?.proposal.destination === 'memdir_handoff'
        ? receipt.proposal.metadata
        : undefined;
      const governedScopedRef = this.applicability === undefined
        ? governedRef
        : receiptMetadata?.applicability === undefined
        ? scopedRef
        : decorateScopedRef(governedRef, this.scope, receiptMetadata.applicability);
      refs.push(receipt === undefined
        ? (this.applicability === undefined
          ? governedRef
          : { ...scopedRef, lifecycle: 'provisional', authority: 'proposal_only' })
        : {
            ...governedScopedRef,
            lifecycle: governedScopedRef.lifecycle === 'archived'
              ? 'archived'
              : receiptMetadata?.requestedLifecycle ?? 'active',
            sourceRefs: receipt.proposal.destination === 'memdir_handoff'
              ? receipt.proposal.metadata.sourceRefs
              : governedScopedRef.sourceRefs,
            ...(receipt.proposal.destination === 'memdir_handoff'
              && receipt.proposal.metadata.claimKind !== undefined
              ? { claimKind: receipt.proposal.metadata.claimKind }
              : {}),
            ...(receipt.proposal.destination === 'memdir_handoff'
              && receipt.proposal.metadata.claimKey !== undefined
              ? { claimKey: receipt.proposal.metadata.claimKey }
              : {}),
            ...(receipt.proposal.destination === 'memdir_handoff'
              && receipt.proposal.metadata.actionSignature !== undefined
              ? { actionSignature: receipt.proposal.metadata.actionSignature }
              : {}),
            applyReceiptRef: `learning_proposal:${receipt.proposalId}`,
            expectedFingerprint: receipt.approvalExpectedFingerprints?.[governedScopedRef.id],
            resultingFingerprint: receipt.approvalResultingFingerprints?.[governedScopedRef.id],
          });
    }
    return refs.filter((ref) => matchesFilter(ref, filter));
  }

  async readRef(ref: MemoryItemRef): Promise<MemoryBodySnapshot> {
    return readStorageBackedRef(ref, this.now);
  }

  async previewProposal(proposal: MemoryActionProposal): Promise<MemoryApplyPreview> {
    return proposal.preview;
  }

  async applyProposal(
    proposal: MemoryActionProposal,
    approval: MemoryApproval,
  ): Promise<MemoryApplyResult> {
    return withLearningFileLock(join(this.memoryRoot, '.memory-review.lock'), () => (
      this.applyProposalWithLock(proposal, approval)
    ));
  }

  private async applyProposalWithLock(
    proposal: MemoryActionProposal,
    approval: MemoryApproval,
  ): Promise<MemoryApplyResult> {
    const proposalId = parseMemoryProposalId(proposal.id);
    if (proposalId === undefined) return skippedApply(proposal.id, 'invalid memory proposal id');
    const target = proposal.targetRefs.find((ref) => ref.kind === 'memdir' && ref.storageUri !== undefined);
    const indexRef = proposal.targetRefs.find((ref) =>
      ref.storageUri !== undefined && basename(ref.storageUri) === 'MEMORY.md');
    if (target?.storageUri === undefined || indexRef?.storageUri === undefined) {
      return skippedApply(proposal.id, 'memory proposal has no memdir target');
    }
    if (!await isContainedMemoryPath(this.memoryRoot, target.storageUri)
      || !await isContainedMemoryPath(this.memoryRoot, indexRef.storageUri)) {
      return skippedApply(proposal.id, 'memory proposal target is outside its governed root');
    }
    const expectedTargetFingerprint = approval.expectedFingerprints[target.id];
    const expectedIndexFingerprint = approval.expectedFingerprints[indexRef.id];
    if (expectedTargetFingerprint === undefined || expectedIndexFingerprint === undefined) {
      return skippedApply(proposal.id, 'approval fingerprints do not cover proposal preview');
    }
    const mutableRefs = [target, indexRef];
    const protectedRef = mutableRefs.find((ref) => isProtectedFromMutation(ref));
    if (protectedRef !== undefined) {
      return skippedApply(proposal.id, `${protectedRef.id} is not mutable by memory governance`);
    }
    const currentTarget = await readTextIfExists(target.storageUri);
    const currentIndex = await readTextIfExists(indexRef.storageUri);
    const content = proposal.preview.diff ?? '';
    const indexLine = indexLineFromContent(target.storageUri, content);
    const targetAlreadyApplied = currentTarget.exists && currentTarget.content === content;
    const resultingIndexContent = upsertIndexLine(currentIndex.content, target.storageUri, indexLine);
    const indexAlreadyApplied = currentIndex.exists && currentIndex.content === resultingIndexContent;
    if (fingerprintOrMissing(currentTarget) !== expectedTargetFingerprint && !targetAlreadyApplied) {
      return skippedApply(proposal.id, 'target memory changed after preview');
    }
    if (
      fingerprintOrMissing(currentIndex) !== expectedIndexFingerprint
      && !targetAlreadyApplied
      && !indexAlreadyApplied
    ) {
      return skippedApply(proposal.id, 'MEMORY.md changed after preview');
    }
    const changedPaths: string[] = [];
    const warnings: string[] = [];
    const receiptStorePath = sharedMemoryReceiptStore(this.memoryRoot);
    if (receiptStorePath !== this.learningStorePath) {
      const sourceStore = await readLearningProposalStore(this.learningStorePath);
      const sourceEntry = sourceStore.proposals.find((entry) => entry.proposalId === proposalId);
      if (sourceEntry === undefined || sourceEntry.proposal.destination !== 'memdir_handoff') {
        return skippedApply(proposal.id, 'memory proposal receipt source is missing');
      }
      await upsertLearningProposal(receiptStorePath, sourceEntry.proposal, { now: this.now });
    }
    if (!targetAlreadyApplied) {
      await approval.revalidateAuthority?.();
      await writeFileAtomic(target.storageUri, content);
      changedPaths.push(target.storageUri);
    } else {
      warnings.push('target memory already matched proposal content; completing approval');
    }
    if (!indexAlreadyApplied) {
      await approval.revalidateAuthority?.();
      await writeFileAtomic(indexRef.storageUri, resultingIndexContent);
      changedPaths.push(indexRef.storageUri);
    } else {
      warnings.push('MEMORY.md already contained the proposal index line; completing approval');
    }
    const approvalStatus = {
      expectedStatus: 'pending',
      appliedAt: this.now(),
      appliedChangedPaths: [target.storageUri, indexRef.storageUri],
      approvedBy: approval.approvedBy,
      approvedAt: approval.approvedAt,
      approvalPolicyId: approval.policyId,
      approvalPolicyReason: approval.policyReason,
      approvalExpectedFingerprints: approval.expectedFingerprints,
      approvalResultingFingerprints: {
        [target.id]: fingerprint(content),
        [indexRef.id]: fingerprint(resultingIndexContent),
      },
      now: this.now,
      ...(approval.revalidateAuthority === undefined
        ? {}
        : { revalidateAuthority: approval.revalidateAuthority }),
    } as const;
    if (receiptStorePath !== this.learningStorePath) {
      const receipt = (await readLearningProposalStore(receiptStorePath)).proposals
        .find((entry) => entry.proposalId === proposalId);
      if (receipt?.status === 'pending') {
        await updateLearningProposalStatus(receiptStorePath, proposalId, 'approved', approvalStatus);
      } else if (receipt?.status !== 'approved'
        || receipt.approvalResultingFingerprints?.[target.id] !== fingerprint(content)
        || receipt.approvalResultingFingerprints?.[indexRef.id] !== fingerprint(resultingIndexContent)) {
        return skippedApply(proposal.id, 'shared memory approval receipt is not recoverable');
      }
    }
    await updateLearningProposalStatus(
      this.learningStorePath,
      proposalId,
      'approved',
      approvalStatus,
    );
    return {
      proposalId: proposal.id,
      applied: true,
      changedRefs: proposal.targetRefs,
      changedPaths,
      warnings,
    };
  }
}

async function isContainedMemoryPath(root: string, target: string): Promise<boolean> {
  const lexical = relative(resolve(root), resolve(target));
  if (lexical.length === 0 || lexical === '..' || lexical.startsWith(`..${sep}`) || isAbsolute(lexical)) {
    return false;
  }
  try {
    const canonicalRoot = await realpath(root);
    let canonicalTarget: string;
    try {
      canonicalTarget = await realpath(target);
    } catch {
      canonicalTarget = join(await realpath(dirname(target)), basename(target));
    }
    const physical = relative(canonicalRoot, canonicalTarget);
    return physical.length > 0
      && physical !== '..'
      && !physical.startsWith(`..${sep}`)
      && !isAbsolute(physical);
  } catch {
    return false;
  }
}

function defaultProjectDocs(cwd: string): readonly string[] {
  return [
    'README.md',
    'AGENTS.md',
    join('docs', 'PRD.md'),
    join('docs', 'ADR.md'),
    join('docs', 'HLD.md'),
    join('docs', 'DD.md'),
    join('docs', 'FEATURE_LIST.md'),
  ].map((item) => resolve(cwd, item));
}

function buildScopedRoots(identity: MemoryContextIdentity): readonly {
  readonly root: string;
  readonly scope: Extract<MemoryScope, 'project' | 'workspace' | 'agent' | 'user'>;
  readonly applicability: MemoryApplicability;
}[] {
  const roots: Array<{
    root: string;
    scope: Extract<MemoryScope, 'project' | 'workspace' | 'agent' | 'user'>;
    applicability: MemoryApplicability;
  }> = [];
  if (identity.projectId !== undefined) roots.push({
    root: resolveScopedMemoryRoot(identity, 'project'),
    scope: 'project',
    applicability: { tenantId: identity.tenantId, projectId: identity.projectId },
  });
  if (identity.workspaceId !== undefined) roots.push({
    root: resolveScopedMemoryRoot(identity, 'workspace'),
    scope: 'workspace',
    applicability: { tenantId: identity.tenantId, workspaceId: identity.workspaceId },
  });
  roots.push({
    root: resolveScopedMemoryRoot(identity, 'agent'),
    scope: 'agent',
    applicability: { tenantId: identity.tenantId, agentId: identity.agentId },
  });
  if (identity.userId !== undefined) roots.push({
    root: resolveScopedMemoryRoot(identity, 'user'),
    scope: 'user',
    applicability: { tenantId: identity.tenantId, userId: identity.userId },
  });
  return roots;
}

function memoryProposalId(proposalId: string): string {
  return `memory:${proposalId}`;
}

function parseMemoryProposalId(id: string): string | undefined {
  return id.startsWith('memory:') ? id.slice('memory:'.length) : undefined;
}

function fingerprint(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

function fingerprintOrMissing(read: ReadTextResult): string {
  return read.exists ? fingerprint(read.content) : MISSING_FINGERPRINT;
}

function lifecycleFromStatus(entry: StoredLearningProposal): MemoryItemRef['lifecycle'] {
  if (entry.status === 'pending') return 'pending';
  if (entry.status === 'approved') return 'trusted';
  return 'archived';
}

function learningRefFromEntry(entry: StoredLearningProposal): MemoryItemRef {
  const body = learningBody(entry);
  return {
    kind: 'learning_proposal',
    id: `learning_proposal:${entry.proposalId}`,
    scope: 'project',
    title: learningTitle(entry),
    owner: 'project',
    lifecycle: lifecycleFromStatus(entry),
    authority: 'proposal_only',
    visibility: 'prompt_safe',
    sourceRefs: learningSourceRefs(entry),
    relatedRefs: [],
    bodyFingerprint: fingerprint(body),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

function reasoningRefFromEntry(entry: StoredLearningProposal): MemoryItemRef {
  const title = entry.proposal.destination === 'reasoning_handoff'
    ? entry.proposal.title
    : entry.proposalId;
  const body = learningBody(entry);
  return {
    kind: 'reasoning_report',
    id: `reasoning_report:${entry.proposalId}`,
    scope: 'project',
    title,
    owner: 'project',
    lifecycle: lifecycleFromStatus(entry),
    authority: 'proposal_only',
    visibility: 'prompt_safe',
    sourceRefs: learningSourceRefs(entry),
    relatedRefs: [`learning_proposal:${entry.proposalId}`],
    bodyFingerprint: fingerprint(body),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

function sessionTraceRefFromEntry(sessionId: string, entry: KodaXSessionEntry): MemoryItemRef {
  const body = stringifyJson(entry);
  return {
    kind: 'session_trace',
    id: `session_trace:${sessionId}:${entry.id}`,
    scope: 'session',
    title: `Session ${entry.type}: ${entry.id}`,
    owner: 'project',
    lifecycle: 'provisional',
    authority: 'read_only',
    visibility: 'private',
    sourceRefs: [],
    relatedRefs: entry.parentId === null ? [] : [`session_trace:${sessionId}:${entry.parentId}`],
    version: '2',
    bodyFingerprint: fingerprint(body),
    createdAt: entry.timestamp,
    updatedAt: entry.timestamp,
  };
}

function artifactLedgerRefFromEntry(
  sessionId: string,
  entry: KodaXSessionArtifactLedgerEntry,
): MemoryItemRef {
  const body = stringifyJson(entry);
  return {
    kind: 'artifact_ledger',
    id: `artifact_ledger:${sessionId}:${entry.id}`,
    scope: 'session',
    title: entry.summary ?? entry.displayTarget ?? entry.target,
    owner: 'project',
    lifecycle: 'provisional',
    authority: 'read_only',
    visibility: 'prompt_safe',
    sourceRefs: entry.sessionEntryId === undefined
      ? []
      : [`session_trace:${sessionId}:${entry.sessionEntryId}`],
    relatedRefs: [],
    bodyFingerprint: fingerprint(body),
    createdAt: entry.timestamp,
    updatedAt: entry.timestamp,
  };
}

function parseScopedMemoryRefId(
  id: string,
  kind: 'session_trace' | 'artifact_ledger',
  sessionId: string,
): string {
  const prefix = `${kind}:${sessionId}:`;
  return id.startsWith(prefix) ? id.slice(prefix.length) : '';
}

function learningTitle(entry: StoredLearningProposal): string {
  const proposal = entry.proposal;
  if (proposal.destination === 'memdir_handoff') return `${proposal.memoryKind} memory handoff`;
  if (proposal.destination === 'reasoning_handoff') return proposal.title;
  return proposal.proposalId;
}

function learningSourceRefs(entry: StoredLearningProposal): readonly string[] {
  const proposal = entry.proposal;
  if (proposal.destination === 'memdir_handoff') return proposal.metadata.sourceRefs;
  if (proposal.destination === 'reasoning_handoff') return proposal.sourceTraceIds;
  return [];
}

function learningBody(entry: StoredLearningProposal): string {
  const proposal = entry.proposal;
  if (proposal.destination === 'memdir_handoff') return proposal.body;
  if (proposal.destination === 'reasoning_handoff') return proposal.body;
  return JSON.stringify(proposal, null, 2);
}

function buildMemdirWritePlan(memoryRoot: string, handoff: MemoryLearningHandoff, proposalId: string): MemdirWritePlan {
  const memoryType = memoryTypeForHandoff(handoff.memoryKind);
  const title = titleFromBody(handoff.body, `${handoff.memoryKind} memory`);
  const description = firstSentence(handoff.body) || title;
  const filename = handoff.metadata.targetStorageUri === undefined
    ? `${memoryType}_${slugify(title)}_${slugify(proposalId)}.md`
    : basename(handoff.metadata.targetStorageUri);
  const targetPath = handoff.metadata.targetStorageUri ?? join(memoryRoot, filename);
  const content = [
    '---',
    `name: ${quoteScalar(title)}`,
    `description: ${quoteScalar(description)}`,
    `type: ${memoryType}`,
    '---',
    '',
    handoff.body.trim(),
    '',
  ].join('\n');
  return {
    targetPath,
    entrypointPath: join(memoryRoot, 'MEMORY.md'),
    content,
    indexLine: `- [${title}](${filename}) - ${description}`,
  };
}

async function buildMemdirTargetRef(
  targetPath: string,
  handoff: MemoryLearningHandoff,
  entry: StoredLearningProposal,
  descriptor?: {
    readonly scope: Extract<MemoryScope, 'project' | 'workspace' | 'agent' | 'user'>;
    readonly applicability: MemoryApplicability;
  },
): Promise<MemoryItemRef> {
  const read = await readTextIfExists(targetPath);
  const ref: MemoryItemRef = {
    kind: 'memdir',
    id: `memdir:${basename(targetPath)}`,
    scope: handoff.memoryKind === 'user' ? 'user' : 'project',
    title: titleFromBody(handoff.body, `${handoff.memoryKind} memory`),
    owner: handoff.memoryKind === 'user' ? 'user' : 'project',
    lifecycle: read.exists ? 'active' : 'pending',
    authority: 'approved_write',
    visibility: 'prompt_safe',
    sourceRefs: [`learning_proposal:${entry.proposalId}`, ...handoff.metadata.sourceRefs],
    relatedRefs: [],
    ...(handoff.metadata.claimKind !== undefined ? { claimKind: handoff.metadata.claimKind } : {}),
    ...(handoff.metadata.claimKey !== undefined ? { claimKey: handoff.metadata.claimKey } : {}),
    ...(handoff.metadata.actionSignature !== undefined
      ? { actionSignature: handoff.metadata.actionSignature }
      : {}),
    bodyFingerprint: read.exists ? fingerprint(read.content) : MISSING_FINGERPRINT,
    storageUri: targetPath,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
  return descriptor === undefined
    ? ref
    : decorateScopedRef(
        ref,
        descriptor.scope,
        handoff.metadata.applicability ?? descriptor.applicability,
      );
}

async function buildEntrypointRef(
  entrypointPath: string,
  descriptor?: {
    readonly scope: Extract<MemoryScope, 'project' | 'workspace' | 'agent' | 'user'>;
    readonly applicability: MemoryApplicability;
  },
): Promise<MemoryItemRef> {
  const read = await readTextIfExists(entrypointPath);
  const ref: MemoryItemRef = {
    kind: 'memdir',
    id: 'memdir:MEMORY.md',
    scope: 'project',
    title: 'MEMORY.md',
    owner: 'project',
    lifecycle: read.exists ? 'active' : 'pending',
    authority: 'approved_write',
    visibility: 'prompt_safe',
    sourceRefs: [],
    relatedRefs: [],
    bodyFingerprint: read.exists ? fingerprint(read.content) : MISSING_FINGERPRINT,
    storageUri: entrypointPath,
  };
  return descriptor === undefined
    ? ref
    : decorateScopedRef(ref, descriptor.scope, descriptor.applicability);
}

function memdirRefFromFile(filePath: string, content: string): MemoryItemRef {
  const parsed = parseMemoryFile(content);
  const filename = basename(filePath);
  const memoryType = parsed.frontmatter.type;
  return {
    kind: 'memdir',
    id: `memdir:${filename}`,
    scope: memoryType === 'user' ? 'user' : 'project',
    title: parsed.frontmatter.name ?? filename,
    owner: memoryType === 'user' ? 'user' : 'project',
    lifecycle: 'active',
    authority: filename === 'MEMORY.md' ? 'read_only' : 'approved_write',
    visibility: 'prompt_safe',
    sourceRefs: [],
    relatedRefs: [],
    bodyFingerprint: fingerprint(content),
    storageUri: filePath,
  };
}

function decorateScopedRef(
  ref: MemoryItemRef,
  scope: Extract<MemoryScope, 'project' | 'workspace' | 'agent' | 'user'>,
  applicability: MemoryApplicability,
): MemoryItemRef {
  const scopeId = memoryApplicabilityFingerprint(applicability);
  const filename = ref.storageUri === undefined ? ref.id : basename(ref.storageUri);
  return {
    ...ref,
    id: `memdir:${scope}:${scopeId}:${filename}`,
    scope,
    scopeId,
    applicability,
  };
}

function findApplyReceipt(
  proposals: readonly StoredLearningProposal[],
  ref: MemoryItemRef,
  content: string,
): StoredLearningProposal | undefined {
  if (ref.storageUri === undefined) return undefined;
  const storageUri = ref.storageUri;
  const bodyFingerprint = fingerprint(content);
  for (let index = proposals.length - 1; index >= 0; index -= 1) {
    const proposal = proposals[index]!;
    if (proposal.status === 'approved'
      && proposal.appliedChangedPaths?.includes(storageUri) === true
      && Object.values(proposal.approvalResultingFingerprints ?? {}).includes(bodyFingerprint)) {
      return proposal;
    }
  }
  return undefined;
}

function sharedMemoryReceiptStore(memoryRoot: string): string {
  return join(memoryRoot, '.governance', 'receipts.json');
}

function memoryTypeForHandoff(kind: MemoryLearningHandoff['memoryKind']): MemoryType {
  if (kind === 'user' || kind === 'feedback' || kind === 'project' || kind === 'reference') return kind;
  return 'project';
}

function titleFromBody(body: string, fallback: string): string {
  const first = body.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0);
  if (first === undefined) return fallback;
  return first.replace(/^#+\s*/, '').slice(0, 80) || fallback;
}

function firstSentence(body: string): string | undefined {
  const compact = body.replace(/\s+/g, ' ').trim();
  if (compact.length === 0) return undefined;
  const sentenceEnd = compact.search(/[.!?。！？]/);
  const value = sentenceEnd >= 0 ? compact.slice(0, sentenceEnd + 1) : compact;
  return value.slice(0, 160);
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return slug.length > 0 ? slug : 'memory';
}

function quoteScalar(value: string): string {
  return JSON.stringify(value.replace(/\r?\n/g, ' '));
}

function indexLineFromContent(filePath: string, content: string): string {
  const parsed = parseMemoryFile(content);
  const title = parsed.frontmatter.name ?? basename(filePath, '.md');
  const description = parsed.frontmatter.description ?? title;
  return `- [${title}](${basename(filePath)}) - ${description}`;
}

function upsertIndexLine(current: string, targetPath: string, line: string): string {
  const trimmed = current.trimEnd();
  if (indexContainsLine(trimmed, line)) return `${trimmed}\n`;
  const targetFilename = basename(targetPath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const existingPattern = new RegExp(`^.*\\(${targetFilename}\\).*$`, 'm');
  if (existingPattern.test(trimmed)) return `${trimmed.replace(existingPattern, line)}\n`;
  return trimmed.length > 0 ? `${line}\n${trimmed}\n` : `${line}\n`;
}

function indexContainsLine(content: string, line: string): boolean {
  return content.trimEnd().split(/\r?\n/).includes(line);
}

async function readTextIfExists(filePath: string): Promise<ReadTextResult> {
  try {
    return { exists: true, content: await readFile(filePath, 'utf8') };
  } catch (error) {
    if (isMissingFile(error)) return { exists: false, content: '' };
    throw error;
  }
}

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = join(dirname(filePath), `.${basename(filePath)}.kodax-${process.pid}-${Date.now().toString(36)}.tmp`);
  try {
    await writeFile(tempPath, content, 'utf8');
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

function autoCuratorStatePath(memoryRoot: string): string {
  return join(memoryRoot, '.governance', 'auto-curate-state.json');
}

function autoCuratorReportPath(memoryRoot: string, report: MemoryGovernanceReport): string {
  const stamp = sanitizePathSegment(report.generatedAt);
  const reportId = sanitizePathSegment(report.reportId);
  return join(memoryRoot, '.governance', 'reports', `${stamp}-${reportId}.json`);
}

async function pruneAutoCuratorReports(memoryRoot: string, cap: number): Promise<void> {
  if (cap <= 0) return;
  const reportDir = join(memoryRoot, '.governance', 'reports');
  let entries: readonly { readonly name: string; readonly isFile: () => boolean }[];
  try {
    entries = await readdir(reportDir, { withFileTypes: true });
  } catch (error) {
    if (isMissingFile(error)) return;
    throw error;
  }
  const reports = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left));
  for (const staleName of reports.slice(cap)) {
    await rm(join(reportDir, staleName), { force: true });
  }
}

async function readAutoCuratorState(filePath: string): Promise<AutoCuratorState | undefined> {
  const read = await readTextIfExists(filePath);
  if (!read.exists) return undefined;
  try {
    const parsed: unknown = JSON.parse(read.content);
    return isAutoCuratorState(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function writeAutoCuratorState(filePath: string, state: AutoCuratorState): Promise<void> {
  await writeFileAtomic(filePath, `${JSON.stringify(state, null, 2)}\n`);
}

function isAutoCuratorState(value: unknown): value is AutoCuratorState {
  if (!isReadonlyRecord(value)) return false;
  return value.version === AUTO_CURATOR_STATE_VERSION
    && optionalStringField(value.lastCheckedAt)
    && optionalStringField(value.lastRunAt)
    && optionalStringField(value.lastInventoryFingerprint)
    && optionalStringField(value.lastReportPath);
}

function isReadonlyRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalStringField(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function addMs(isoTime: string, ms: number): string {
  const parsed = Date.parse(isoTime);
  const base = Number.isFinite(parsed) ? parsed : Date.now();
  return new Date(base + ms).toISOString();
}

function compareIso(left: string, right: string): number {
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) return 0;
  return leftTime - rightTime;
}

function isAutoCuratorCandidate(ref: MemoryItemRef): boolean {
  return ref.kind === 'memdir'
    || ref.kind === 'learning_proposal'
    || ref.kind === 'reasoning_report';
}

function memoryInventoryPayload(refs: readonly MemoryItemRef[]): string {
  return refs
    .map((ref) => [
      ref.id,
      ref.kind,
      ref.scope,
      ref.lifecycle,
      ref.authority,
      ref.visibility,
      ref.bodyFingerprint ?? '',
      ref.storageUri ?? '',
      ref.updatedAt ?? '',
      ref.title ?? '',
    ].join('\t'))
    .sort()
    .join('\n');
}

function sanitizePathSegment(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return sanitized.length > 0 ? sanitized : 'report';
}

async function readStorageBackedRef(
  ref: MemoryItemRef,
  now: () => string,
): Promise<MemoryBodySnapshot> {
  if (ref.storageUri === undefined) {
    return {
      ref,
      body: '',
      bodyFingerprint: fingerprint(''),
      readAt: now(),
      warnings: ['memory ref has no storageUri'],
    };
  }
  const read = await readTextIfExists(ref.storageUri);
  if (!read.exists) {
    return {
      ref,
      body: '',
      bodyFingerprint: fingerprint(''),
      readAt: now(),
      warnings: [`memory ref storage does not exist: ${ref.storageUri}`],
    };
  }
  const parsed = ref.kind === 'memdir' ? parseMemoryFile(read.content) : undefined;
  return {
    ref: { ...ref, bodyFingerprint: fingerprint(read.content) },
    body: read.content,
    bodyFingerprint: fingerprint(read.content),
    ...(parsed !== undefined ? { frontmatter: frontmatterRecord(parsed.frontmatter) } : {}),
    readAt: now(),
    warnings: [],
  };
}

function frontmatterRecord(frontmatter: {
  readonly name: string | undefined;
  readonly description: string | undefined;
  readonly type: string | undefined;
}): Readonly<Record<string, string>> {
  const fields: Record<string, string> = {};
  if (frontmatter.name !== undefined) fields.name = frontmatter.name;
  if (frontmatter.description !== undefined) fields.description = frontmatter.description;
  if (frontmatter.type !== undefined) fields.type = frontmatter.type;
  return fields;
}

function matchesFilter(ref: MemoryItemRef, filter: MemoryRefFilter): boolean {
  if (filter.kinds !== undefined && !filter.kinds.includes(ref.kind)) return false;
  if (filter.scopes !== undefined && !filter.scopes.includes(ref.scope)) return false;
  if (filter.lifecycles !== undefined && !filter.lifecycles.includes(ref.lifecycle)) return false;
  if (ref.visibility === 'private' && filter.includePrivate !== true) return false;
  if (ref.visibility === 'sensitive' && filter.includeSensitive !== true) return false;
  if (filter.query !== undefined && !refMatchesQuery(ref, filter.query)) return false;
  return true;
}

function refMatchesQuery(ref: MemoryItemRef, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;
  return [
    ref.id,
    ref.title ?? '',
    ref.kind,
    ref.scope,
    ref.owner,
    ...ref.sourceRefs,
    ...ref.relatedRefs,
  ].some((value) => value.toLowerCase().includes(needle));
}

function buildGovernanceFindings(refs: readonly MemoryItemRef[]): readonly MemoryGovernanceFinding[] {
  const findings: MemoryGovernanceFinding[] = [];
  findings.push(...duplicateFingerprintFindings(refs));
  findings.push(...conflictTitleFindings(refs));
  findings.push(...orphanedRefFindings(refs));
  for (const ref of refs) {
    if (ref.lifecycle === 'stale') {
      findings.push({
        kind: 'stale',
        severity: 'warning',
        refIds: [ref.id],
        summary: `${ref.id} is stale and excluded from normal memory packs.`,
        suggestedAction: 'archive',
      });
    }
    if (ref.lifecycle === 'quarantined') {
      findings.push({
        kind: 'quarantined',
        severity: 'warning',
        refIds: [ref.id],
        summary: `${ref.id} is quarantined and requires manual review.`,
        suggestedAction: 'conflict_report',
      });
    }
  }
  return findings;
}

function duplicateFingerprintFindings(refs: readonly MemoryItemRef[]): readonly MemoryGovernanceFinding[] {
  const groups = new Map<string, string[]>();
  for (const ref of refs) {
    if (ref.bodyFingerprint === undefined || ref.lifecycle === 'archived') continue;
    const group = groups.get(ref.bodyFingerprint) ?? [];
    group.push(ref.id);
    groups.set(ref.bodyFingerprint, group);
  }
  return Array.from(groups.entries())
    .filter(([, ids]) => ids.length > 1)
    .map(([fingerprintValue, ids]) => ({
      kind: 'duplicate',
      severity: 'warning',
      refIds: ids,
      summary: `Multiple refs share ${fingerprintValue}.`,
      suggestedAction: 'conflict_report',
    }));
}

function conflictTitleFindings(refs: readonly MemoryItemRef[]): readonly MemoryGovernanceFinding[] {
  const groups = new Map<string, MemoryItemRef[]>();
  for (const ref of refs) {
    const title = normalizeConflictTitle(ref.title);
    if (title === undefined || ref.bodyFingerprint === undefined || ref.lifecycle === 'archived') continue;
    const group = groups.get(title) ?? [];
    group.push(ref);
    groups.set(title, group);
  }
  return Array.from(groups.entries())
    .flatMap(([title, group]) => {
      const fingerprints = new Set(group.map((ref) => ref.bodyFingerprint));
      if (group.length < 2 || fingerprints.size <= 1) return [];
      return [{
        kind: 'conflict',
        severity: 'warning',
        refIds: group.map((ref) => ref.id),
        summary: `Multiple refs use the title "${title}" with different fingerprints.`,
        suggestedAction: 'conflict_report',
      } satisfies MemoryGovernanceFinding];
    });
}

function orphanedRefFindings(refs: readonly MemoryItemRef[]): readonly MemoryGovernanceFinding[] {
  const ids = new Set(refs.map((ref) => ref.id));
  return refs.flatMap((ref) => {
    const missing = ref.relatedRefs.filter((id) => isMemoryControlledRefId(id) && !ids.has(id));
    if (missing.length === 0) return [];
    return [{
      kind: 'orphaned',
      severity: 'warning',
      refIds: [ref.id, ...missing],
      summary: `${ref.id} points to missing memory ref(s): ${missing.join(', ')}.`,
      suggestedAction: 'conflict_report',
    } satisfies MemoryGovernanceFinding];
  });
}

function normalizeConflictTitle(title: string | undefined): string | undefined {
  const normalized = title?.trim().toLowerCase().replace(/\s+/g, ' ');
  return normalized !== undefined && normalized.length > 0 ? normalized : undefined;
}

function isMemoryControlledRefId(id: string): boolean {
  return /^(learning_proposal|reasoning_report|memdir|session_trace|artifact_ledger|skill|project_doc|self_manual|workflow_run|working_context):/.test(id);
}

function isProtectedFromMutation(ref: MemoryItemRef): boolean {
  return ref.authority === 'read_only' || ref.scope === 'builtin' || ref.pinned === true;
}

function isPackEligible(ref: MemoryItemRef, input: MemoryPackInput): boolean {
  if (ref.applicability !== undefined) {
    if (input.identity === undefined) return false;
    if (!matchesMemoryApplicability(input.identity, ref.applicability)) return false;
  }
  if (ref.visibility === 'private' && input.includePrivate !== true) return false;
  if (ref.visibility === 'sensitive' && input.includeSensitive !== true) return false;
  if (ref.authority === 'proposal_only') return false;
  return ref.lifecycle === 'trusted' || ref.lifecycle === 'active' || ref.lifecycle === 'readonly';
}

function isReviewCandidateEligible(ref: MemoryItemRef): boolean {
  if (ref.kind !== 'memdir' && ref.kind !== 'learning_proposal' && ref.kind !== 'reasoning_report') {
    return false;
  }
  return ref.lifecycle !== 'archived' && ref.lifecycle !== 'quarantined';
}

function isEligibleEpisodePromotion(
  action: MemoryReviewDraftAction,
  digest: import('../types.js').KodaXMemoryOutcomeDigest,
): boolean {
  if (action.confidence !== 'high' || action.risk !== 'low') return false;
  if (digest.visibility !== 'prompt_safe' || digest.evidenceRefs.length === 0) return false;
  if (!hasVerifiedDigestEvidence(digest)) return false;
  if (action.claimKind === 'procedure' && digest.outcome !== 'succeeded') return false;
  const body = action.proposedBody ?? '';
  if (body.length === 0) return false;
  return !/(?:api[_-]?key|authorization:\s*bearer|private key|password|secret|token\s*[:=])/i.test(body);
}

function findCompatibleReviewRef(
  action: MemoryReviewDraftAction,
  plan: MemoryReviewPlan,
  refs: readonly MemoryItemRef[],
): MemoryItemRef | undefined {
  const candidateIds = new Set(plan.candidateRefs.map((candidate) => candidate.ref.id));
  const targetIds = new Set(action.targetRefIds);
  const direct = refs.find((ref) => candidateIds.has(ref.id) && targetIds.has(ref.id));
  if (direct !== undefined) return isGovernanceCompatibleReviewRef(direct, action) ? direct : undefined;
  if (targetIds.size > 0) return undefined;

  if (action.claimKey !== undefined) {
    const byClaimKey = refs.find((ref) =>
      candidateIds.has(ref.id)
      &&
      canonicalClaimKey(ref.claimKey) === canonicalClaimKey(action.claimKey)
      && isGovernanceCompatibleReviewRef(ref, action));
    if (byClaimKey !== undefined) return byClaimKey;
  }

  return refs.find((ref) => candidateIds.has(ref.id) && isGovernanceCompatibleReviewRef(ref, action));
}

function isGovernanceCompatibleReviewRef(
  ref: MemoryItemRef,
  action: MemoryReviewDraftAction,
): boolean {
  if (ref.kind !== 'memdir' || ref.visibility !== 'prompt_safe') return false;
  if (action.claimKind !== undefined && ref.claimKind !== undefined && ref.claimKind !== action.claimKind) {
    return false;
  }
  return true;
}

function sameMemoryStorage(left: MemoryItemRef, right: MemoryItemRef): boolean {
  if (left.storageUri === undefined || right.storageUri === undefined) return left.id === right.id;
  const leftPath = resolve(left.storageUri);
  const rightPath = resolve(right.storageUri);
  return process.platform === 'win32'
    ? leftPath.toLowerCase() === rightPath.toLowerCase()
    : leftPath === rightPath;
}

function handledExplicitMemoryDisposition(
  plan: MemoryReviewPlan,
  action: MemoryReviewDraftAction,
  existing: MemoryItemRef | undefined,
): 'same' | 'conflict' | undefined {
  const handledOperations = plan.episodeDigest?.handledMemoryOperations ?? [];
  for (let index = handledOperations.length - 1; index >= 0; index -= 1) {
    const handled = handledOperations[index]!;
    const targetMatches = existing !== undefined && handled.targetRefIds.includes(existing.id)
      || action.targetRefIds.some((id) => handled.targetRefIds.includes(id));
    const claimKeyMatches = handled.claimKey !== undefined
      && action.claimKey !== undefined
      && canonicalClaimKey(handled.claimKey) === canonicalClaimKey(action.claimKey);
    const bodyMatches = handled.statement !== undefined
      && action.proposedBody !== undefined
      && normalizeClaimBody(handled.statement) === normalizeClaimBody(action.proposedBody);
    if (handled.disposition === 'blocked') {
      const hasIdentity = handled.statement !== undefined
        || handled.claimKey !== undefined
        || handled.targetRefIds.length > 0;
      if (hasIdentity && (targetMatches || claimKeyMatches || bodyMatches)) return 'conflict';
      continue;
    }
    if (handled.disposition === 'decision') {
      if (bodyMatches && (targetMatches || claimKeyMatches)) return 'same';
      if (targetMatches || claimKeyMatches || bodyMatches) return 'conflict';
      continue;
    }
    if (handled.operation === 'forget') {
      if (targetMatches || bodyMatches) return 'same';
      if (claimKeyMatches) return 'conflict';
      continue;
    }
    if (handled.operation === 'correct' && targetMatches) {
      return bodyMatches ? 'same' : 'conflict';
    }
    if (bodyMatches) return 'same';
    if (claimKeyMatches) return 'conflict';
  }
  return undefined;
}

function canonicalizeReviewAction(action: MemoryReviewDraftAction): MemoryReviewDraftAction {
  const claimKey = canonicalClaimKey(action.claimKey);
  return claimKey === undefined || claimKey === action.claimKey
    ? action
    : { ...action, claimKey };
}

function prepareMemoryRememberInput(
  input: MemoryRememberInput,
): PreparedMemoryRememberInput | MemoryRememberResult {
  const operation = input.operation ?? 'remember';
  const rawStatement = input.statement.trim();
  if (rawStatement.length === 0 || rawStatement.length > 1_024) {
    return memoryRememberResult(
      'needs_clarification',
      rawStatement.length === 0
        ? 'Memory must contain one non-empty claim'
        : 'Memory is too broad; narrow it to one claim of at most 1024 characters',
    );
  }
  const statement = sanitizePromptSafeMemoryClaim(rawStatement, 1_024);
  if (statement === undefined) {
    return memoryRememberResult(
      'rejected',
      'Memory contains restricted or sensitive content and was not stored automatically',
    );
  }
  if (operation === 'correct' && input.targetRefId === undefined) {
    return memoryRememberResult(
      'needs_clarification',
      'Correction requires one exact Memory ref; list memories and disambiguate the target first',
    );
  }
  return { operation, statement, normalizedStatement: normalizeClaimBody(statement) };
}

function resolveMemoryRememberClaim(
  input: MemoryRememberInput,
  prepared: PreparedMemoryRememberInput,
  inventory: MemoryRememberInventory,
): MemoryRememberClaim | MemoryRememberResult {
  const suppliedClaimKey = canonicalClaimKey(input.claimKey);
  if (suppliedClaimKey !== undefined && !/^[a-z0-9._:-]{1,160}$/i.test(suppliedClaimKey)) {
    return memoryRememberResult('needs_clarification', 'claimKey must be a stable semantic identifier');
  }
  if (prepared.operation === 'remember' && suppliedClaimKey === undefined) {
    return memoryRememberResult(
      'needs_clarification',
      'New Memory requires a stable semantic claimKey so later corrections and conflicts target the same claim',
    );
  }
  if (prepared.operation === 'correct'
    && input.claimKind !== undefined
    && inventory.target?.claimKind !== undefined
    && input.claimKind !== inventory.target.claimKind) {
    return memoryRememberResult(
      'needs_clarification',
      `Correction claimKind must remain ${inventory.target.claimKind} for the selected Memory`,
    );
  }
  const claimKey = canonicalClaimKey(inventory.target?.claimKey)
    ?? suppliedClaimKey
    ?? `explicit:${fingerprint(prepared.normalizedStatement).slice(0, 24)}`;
  const conflicting = inventory.refs.find((ref) => (
    canonicalClaimKey(ref.claimKey) === canonicalClaimKey(claimKey)
    && ref.id !== inventory.target?.id
  ));
  return {
    claimKind: inventory.target?.claimKind ?? input.claimKind ?? 'fact',
    claimKey,
    actionTarget: inventory.target ?? conflicting,
    conflictNeedsDecision: prepared.operation === 'remember' && conflicting !== undefined,
  };
}

function canonicalClaimKey(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

function isStableMemoryClaimKey(value: string | undefined): boolean {
  return value !== undefined && /^[a-z0-9._:-]{1,160}$/u.test(value);
}

function createExplicitMemoryEvidenceRef(
  prepared: PreparedMemoryRememberInput,
  createdAt: string,
): string {
  return `user-explicit:${fingerprint([
    prepared.operation,
    prepared.statement,
    createdAt,
  ].join('\0')).slice(0, 24)}`;
}

function buildExplicitMemoryReview(
  prepared: PreparedMemoryRememberInput,
  claim: MemoryRememberClaim,
  evidenceRef: string,
  createdAt: string,
  sessionId: string,
  authorizationTargetFingerprint?: string,
): {
  readonly digest: import('../types.js').KodaXMemoryOutcomeDigest;
  readonly plan: MemoryReviewPlan;
} {
  const digest = buildExplicitMemoryDigest(prepared, evidenceRef, createdAt, sessionId);
  const action = buildExplicitMemoryAction(prepared, claim, authorizationTargetFingerprint);
  return {
    digest,
    plan: {
      trigger: prepared.operation === 'correct' ? 'user_correction' : 'explicit_remember',
      createdAt,
      sourceRefs: [evidenceRef],
      candidateRefs: claim.actionTarget === undefined ? [] : [{ ref: claim.actionTarget, warnings: [] }],
      actions: [action],
      warnings: [],
      episodeDigest: digest,
    },
  };
}

function buildExplicitMemoryDigest(
  prepared: PreparedMemoryRememberInput,
  evidenceRef: string,
  createdAt: string,
  sessionId: string,
): import('../types.js').KodaXMemoryOutcomeDigest {
  const digest: import('../types.js').KodaXMemoryOutcomeDigest = {
    id: `explicit-${fingerprint([prepared.operation, prepared.statement, evidenceRef].join('\0')).slice(0, 24)}`,
    reviewKey: `explicit:${fingerprint([prepared.operation, prepared.statement, evidenceRef].join('\0')).slice(0, 24)}`,
    sessionId,
    branchId: 'explicit-memory',
    sequence: 0,
    objective: prepared.operation === 'correct' ? 'Correct durable Memory' : 'Remember durable information',
    approach: 'Apply an explicit user-authorized Memory operation',
    outcome: 'succeeded',
    summary: prepared.statement,
    evidenceRefs: [evidenceRef],
    evidence: [{
      ref: evidenceRef,
      grade: 'authoritative',
      source: 'user',
      verdict: 'passed',
      observedAt: createdAt,
    }],
    memoryIntent: {
      operation: prepared.operation,
      evidenceRef,
      candidateStatement: prepared.statement,
      userQuote: prepared.statement,
    },
    visibility: 'prompt_safe',
    createdAt,
  };
  return digest;
}

function buildExplicitMemoryAction(
  prepared: PreparedMemoryRememberInput,
  claim: MemoryRememberClaim,
  authorizationTargetFingerprint?: string,
): MemoryReviewDraftAction {
  return {
    action: prepared.operation === 'correct' || claim.conflictNeedsDecision ? 'patch_memdir' : 'write_memdir',
    targetRefIds: claim.actionTarget === undefined ? [] : [claim.actionTarget.id],
    summary: prepared.statement.slice(0, 160),
    rationale: claim.conflictNeedsDecision
      ? `The explicit request conflicts with the existing Memory that owns claim key ${claim.claimKey}.`
      : 'The user explicitly requested this prompt-safe Memory operation.',
    confidence: 'high',
    risk: claim.conflictNeedsDecision ? 'medium' : 'low',
    requiresApproval: true,
    proposedBody: prepared.statement,
    claimKind: claim.claimKind,
    claimKey: claim.claimKey,
    ...(authorizationTargetFingerprint === undefined ? {} : { authorizationTargetFingerprint }),
    ...(prepared.operation === 'correct' || claim.conflictNeedsDecision
      ? { relationship: 'condition_refinement' as const }
      : {}),
  };
}

function normalizeClaimBody(body: string): string {
  return parseMemoryFile(body).body
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function memoryRememberResult(
  status: MemoryRememberResult['status'],
  reason?: string,
  changedRefIds: readonly string[] = [],
  warnings: readonly string[] = [],
  proposalIds: readonly string[] = [],
): MemoryRememberResult {
  return {
    status,
    changedRefIds,
    proposalIds,
    ...(reason === undefined ? {} : { reason }),
    warnings,
  };
}

function procedurePromotionHistory(
  claimKey: string,
  proposals: readonly StoredLearningProposal[],
  currentProjectId: string | undefined,
  currentCounterexample: boolean,
): { readonly successes: number; readonly projects: Set<string>; readonly hasCounterexample: boolean } {
  let successes = currentProjectId === undefined ? 0 : 1;
  let hasCounterexample = currentCounterexample;
  const projects = new Set<string>();
  const seenProposalIds = new Set<string>();
  if (currentProjectId !== undefined) projects.add(currentProjectId);
  for (const entry of proposals) {
    if (seenProposalIds.has(entry.proposalId)) continue;
    seenProposalIds.add(entry.proposalId);
    if (entry.status === 'rejected' || entry.proposal.destination !== 'memdir_handoff') continue;
    const metadata = entry.proposal.metadata;
    if (metadata.claimKind !== 'procedure'
      || canonicalClaimKey(metadata.claimKey) !== canonicalClaimKey(claimKey)
      || metadata.verifiedEvidence !== true) continue;
    const projectId = metadata.evidenceProjectId ?? metadata.applicability?.projectId;
    if (metadata.episodeOutcome === 'succeeded') {
      successes += 1;
      if (projectId !== undefined) projects.add(projectId);
    } else if (metadata.episodeOutcome === 'failed') {
      hasCounterexample = true;
    }
  }
  return { successes, projects, hasCounterexample };
}

function hasVerifiedDigestEvidence(
  digest: import('../types.js').KodaXMemoryOutcomeDigest,
): boolean {
  const expectedVerdict = digest.outcome === 'succeeded' ? 'passed' : 'failed';
  return digest.evidence?.some((evidence) => (
    (evidence.grade === 'authoritative' || evidence.grade === 'verified')
    && (
      evidence.source === 'user'
      || evidence.source === 'host'
      || evidence.source === 'environment'
      || (evidence.source === 'tool' && evidence.verdict === expectedVerdict)
    )
  )) === true;
}

function episodeReviewTrigger(
  digest: import('../types.js').KodaXMemoryOutcomeDigest,
): MemoryReviewTrigger {
  if (!hasAuthoritativeMemoryIntentEvidence(digest)) return 'episode_completed';
  if (digest.memoryIntent?.operation === 'remember') return 'explicit_remember';
  if (digest.memoryIntent?.operation === 'correct') return 'user_correction';
  return 'episode_completed';
}

function hasAuthoritativeMemoryIntentEvidence(
  digest: import('../types.js').KodaXMemoryOutcomeDigest,
): boolean {
  const evidenceRef = digest.memoryIntent?.evidenceRef;
  return evidenceRef !== undefined && digest.evidence?.some((evidence) => (
    evidence.ref === evidenceRef
    && evidence.grade === 'authoritative'
    && evidence.source === 'user'
  )) === true;
}

function extractClaimBody(body: string): string {
  return parseMemoryFile(body).body.trim();
}

// Gate persisted memory bodies with the same unsafe-claim semantics used on
// the prompt-input side, so hostile content cannot bypass sanitization by
// being paraphrased into a review action's proposedBody. Reject-only: the
// body is never rewritten here.
function isRestrictedMemoryBody(body: string): boolean {
  return body.trim().length > 0 && sanitizePromptSafeMemoryClaim(body) === undefined;
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function selectRefsById(
  refs: readonly MemoryItemRef[],
  refIds: readonly string[],
  maxRefs: number,
  warnings: string[],
): readonly MemoryItemRef[] {
  const byId = new Map(refs.map((ref) => [ref.id, ref]));
  const selected: MemoryItemRef[] = [];
  for (const refId of refIds.slice(0, maxRefs)) {
    const ref = byId.get(refId);
    if (ref === undefined) {
      warnings.push(`memory review candidate not found: ${refId}`);
    } else {
      selected.push(ref);
    }
  }
  return selected;
}

function reviewTask(input: MemoryReviewInput): string {
  return [input.task, input.userFeedback]
    .filter((value): value is string => value !== undefined && value.trim().length > 0)
    .join('\n');
}

function shouldIgnoreMemory(task: string): boolean {
  return /\b(ignore|do not use|don't use|without)\s+(project\s+)?memory\b/i.test(task);
}

function memoryPackRankingText(input: MemoryPackInput): string {
  return [input.task, input.decisionIntent, input.actionSignature]
    .filter((value): value is string => value !== undefined && value.trim().length > 0)
    .join('\n');
}

function scoreRef(ref: MemoryItemRef, task: string): number {
  const taskLower = task.toLowerCase();
  const title = ref.title?.toLowerCase() ?? '';
  let score = 0;
  if (ref.pinned === true) score += 50;
  if (ref.scope === 'project') score += 20;
  if (ref.scope === 'user') score += 10;
  if (ref.lifecycle === 'trusted' || ref.lifecycle === 'readonly') score += 10;
  if (title.length > 0 && taskLower.includes(title)) score += 30;
  for (const token of title.split(/[^a-z0-9]+/).filter((entry) => entry.length >= 3)) {
    if (taskLower.includes(token)) score += 3;
  }
  return score;
}

function structuredMatchScore(ref: MemoryItemRef, input: MemoryPackInput): number {
  if (
    input.actionSignature !== undefined
    && ref.actionSignature !== undefined
    && ref.actionSignature === input.actionSignature
  ) {
    return 2;
  }
  if (
    input.decisionIntent !== undefined
    && ref.claimKey !== undefined
    && ref.claimKey === input.decisionIntent
  ) {
    return 1;
  }
  return 0;
}

function packReason(ref: MemoryItemRef, task: string): string {
  const title = ref.title ?? ref.id;
  return task.toLowerCase().includes(title.toLowerCase())
    ? 'Exact task/title overlap.'
    : `${ref.scope} ${ref.kind} is eligible for deterministic recall.`;
}

function firstSnippet(body: string): string {
  const compact = body.replace(/\s+/g, ' ').trim();
  return compact.slice(0, 240);
}

function promptSafeClaimSnippet(raw: string): string {
  const body = parseMemoryFile(raw).body;
  return body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<\/?[^>]+>/g, ' ')
    .replace(/^\s{0,3}(?:#{1,6}|[-*+]\s+|>\s*)/gm, '')
    .replace(/[`*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 512);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stringifyJson(value: KodaXSessionEntry | KodaXSessionArtifactLedgerEntry): string {
  return JSON.stringify(value, null, 2);
}

function fingerprintsMatch(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

function skippedApply(proposalId: string, skippedReason: string): MemoryApplyResult {
  return {
    proposalId,
    applied: false,
    changedRefs: [],
    changedPaths: [],
    skippedReason,
    warnings: [],
  };
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function lifecycleNotFound(
  refId: string,
  operation: MemoryLifecycleOperationResult['operation'],
): MemoryLifecycleOperationResult {
  return {
    refId,
    operation,
    acknowledged: false,
    residualSourceRefs: [],
    warnings: ['managed memory ref not found'],
  };
}

function skippedReject(proposalId: string, skippedReason: string): MemoryRejectResult {
  return {
    proposalId,
    rejected: false,
    skippedReason,
    warnings: [],
  };
}

function lifecycleAmbiguous(
  refId: string,
  operation: MemoryLifecycleOperationResult['operation'],
): MemoryLifecycleOperationResult {
  return {
    refId,
    operation,
    acknowledged: false,
    residualSourceRefs: [],
    warnings: ['managed memory ref is ambiguous across scopes'],
  };
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT';
}
