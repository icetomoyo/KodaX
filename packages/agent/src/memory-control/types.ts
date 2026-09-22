export type MemoryRefKind =
  | 'working_context'
  | 'session_trace'
  | 'artifact_ledger'
  | 'learning_proposal'
  | 'memdir'
  | 'skill'
  | 'workflow_run'
  | 'reasoning_report'
  | 'self_manual'
  | 'project_doc';

import type {
  MemoryApplicability,
  MemoryContextIdentity,
} from '../memory/identity.js';
import type { KodaXMemoryOutcomeDigest } from '../types.js';

export type { MemoryApplicability, MemoryContextIdentity } from '../memory/identity.js';

export type MemoryScope =
  | 'turn'
  | 'session'
  | 'project'
  | 'workspace'
  | 'agent'
  | 'user'
  | 'builtin';

export type MemoryClaimKind = 'fact' | 'policy' | 'preference' | 'procedure' | 'episode';

export type MemoryLifecycle =
  | 'pending'
  | 'active'
  | 'provisional'
  | 'trusted'
  | 'stale'
  | 'quarantined'
  | 'archived'
  | 'readonly';

export type MemoryAuthority =
  | 'read_only'
  | 'proposal_only'
  | 'approved_write';

export type MemoryVisibility =
  | 'prompt_safe'
  | 'private'
  | 'sensitive';

export interface MemoryItemRef {
  readonly kind: MemoryRefKind;
  readonly id: string;
  readonly scope: MemoryScope;
  readonly scopeId?: string;
  readonly applicability?: MemoryApplicability;
  readonly claimKind?: MemoryClaimKind;
  readonly claimKey?: string;
  readonly actionSignature?: string;
  readonly title?: string;
  readonly owner: 'user' | 'project' | 'kodax' | 'external';
  readonly lifecycle: MemoryLifecycle;
  readonly authority: MemoryAuthority;
  readonly visibility: MemoryVisibility;
  readonly sourceRefs: readonly string[];
  readonly relatedRefs: readonly string[];
  readonly version?: string;
  readonly bodyFingerprint?: string;
  readonly storageUri?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly lastUsedAt?: string;
  readonly pinned?: boolean;
  readonly applyReceiptRef?: string;
  readonly expectedFingerprint?: string;
  readonly resultingFingerprint?: string;
}

export interface MemoryRefFilter {
  readonly kinds?: readonly MemoryRefKind[];
  readonly scopes?: readonly MemoryScope[];
  readonly lifecycles?: readonly MemoryLifecycle[];
  readonly includePrivate?: boolean;
  readonly includeSensitive?: boolean;
  readonly query?: string;
}

export interface MemoryBodySnapshot {
  readonly ref: MemoryItemRef;
  readonly body: string;
  readonly bodyFingerprint: string;
  readonly frontmatter?: Readonly<Record<string, string>>;
  readonly readAt: string;
  readonly warnings: readonly string[];
}

export type MemoryProposalAction =
  | 'no_op'
  | 'link_refs'
  | 'write_memdir'
  | 'patch_memdir'
  | 'handoff_to_skill_loop'
  | 'quarantine'
  | 'archive'
  | 'conflict_report';

export interface MemoryApplyPreview {
  readonly summary: string;
  readonly changedRefs: readonly MemoryItemRef[];
  readonly changedPaths: readonly string[];
  readonly beforeFingerprints: Readonly<Record<string, string>>;
  readonly afterFingerprints?: Readonly<Record<string, string>>;
  readonly diff?: string;
  readonly warnings: readonly string[];
}

export interface MemoryActionProposal {
  readonly id: string;
  readonly action: MemoryProposalAction;
  readonly targetRefs: readonly MemoryItemRef[];
  readonly sourceRefs: readonly MemoryItemRef[];
  readonly expectedFingerprints: Readonly<Record<string, string>>;
  readonly rationale: string;
  readonly risk: 'low' | 'medium' | 'high';
  readonly preview: MemoryApplyPreview;
  readonly requiresApproval: true;
  readonly createdAt: string;
}

export interface MemoryApproval {
  readonly proposalId: string;
  readonly approvedBy: 'user' | 'host';
  readonly approvedAt: string;
  readonly expectedFingerprints: Readonly<Record<string, string>>;
  readonly policyId?: string;
  readonly policyReason?: string;
  readonly revalidateAuthority?: () => Promise<void>;
}

export interface MemoryApplyResult {
  readonly proposalId: string;
  readonly applied: boolean;
  readonly changedRefs: readonly MemoryItemRef[];
  readonly changedPaths: readonly string[];
  readonly skippedReason?: string;
  readonly warnings: readonly string[];
}

export interface MemoryRejectResult {
  readonly proposalId: string;
  readonly rejected: boolean;
  readonly skippedReason?: string;
  readonly review?: MemoryReviewPlan;
  readonly warnings: readonly string[];
}

export interface MemoryLifecycleOperationResult {
  readonly refId: string;
  readonly operation: 'archive' | 'forget' | 'purge';
  readonly acknowledged: boolean;
  readonly residualSourceRefs: readonly string[];
  readonly warnings: readonly string[];
}

export interface MemoryRememberInput {
  /** `correct` requires an exact managed Memory ref so the host never guesses a destructive target. */
  readonly operation?: 'remember' | 'correct';
  readonly statement: string;
  readonly targetRefId?: string;
  readonly claimKind?: MemoryClaimKind;
  readonly claimKey?: string;
  /** Stable evidence identity supplied by the user-facing host. */
  readonly evidenceRef?: string;
  /** Optional version guard for a target selected from a previously shown view. */
  readonly expectedTargetFingerprint?: string;
}

export interface MemoryRememberResult {
  readonly status:
    | 'remembered'
    | 'updated'
    | 'already_known'
    | 'needs_clarification'
    | 'needs_review'
    | 'rejected';
  readonly changedRefIds: readonly string[];
  readonly proposalIds: readonly string[];
  readonly reason?: string;
  readonly warnings: readonly string[];
}

export interface MemorySourceAdapter {
  readonly kind: MemoryRefKind;
  listRefs(filter?: MemoryRefFilter): Promise<readonly MemoryItemRef[]>;
  readRef(ref: MemoryItemRef): Promise<MemoryBodySnapshot>;
  previewProposal(proposal: MemoryActionProposal): Promise<MemoryApplyPreview>;
  applyProposal(
    proposal: MemoryActionProposal,
    approval: MemoryApproval,
  ): Promise<MemoryApplyResult>;
}

export interface MemoryCuratorInput {
  readonly includePrivate?: boolean;
  readonly includeSensitive?: boolean;
}

export interface MemoryAutoCuratorInput extends MemoryCuratorInput {
  readonly enabled?: boolean;
  readonly intervalMs?: number;
  readonly minRefs?: number;
}

export type MemoryAutoCuratorSkipReason =
  | 'disabled'
  | 'not_due'
  | 'insufficient_refs';

export interface MemoryAutoCuratorResult {
  readonly ran: boolean;
  readonly skippedReason?: MemoryAutoCuratorSkipReason;
  readonly report?: MemoryGovernanceReport;
  readonly reportPath?: string;
  readonly nextEligibleAt?: string;
}

export type MemoryGovernanceFindingKind =
  | 'duplicate'
  | 'conflict'
  | 'stale'
  | 'quarantined'
  | 'orphaned'
  | 'no_op';

export interface MemoryGovernanceFinding {
  readonly kind: MemoryGovernanceFindingKind;
  readonly severity: 'info' | 'warning' | 'error';
  readonly refIds: readonly string[];
  readonly summary: string;
  readonly suggestedAction: MemoryProposalAction;
}

export interface MemoryGovernanceReport {
  readonly reportId: string;
  readonly generatedAt: string;
  readonly findings: readonly MemoryGovernanceFinding[];
  readonly warnings: readonly string[];
}

export interface MemoryPackInput {
  readonly task: string;
  readonly identity?: MemoryContextIdentity;
  readonly decisionIntent?: string;
  readonly actionSignature?: string;
  readonly maxCandidates?: number;
  readonly maxHints?: number;
  readonly includePrivate?: boolean;
  readonly includeSensitive?: boolean;
  readonly includeSnippets?: boolean;
  readonly ignoreMemory?: boolean;
  readonly purpose?: 'automatic' | 'deliberate_query' | 'intervention';
}

export interface MemoryPackHint {
  readonly ref: MemoryItemRef;
  readonly hook: string;
  readonly reason: string;
  readonly bodySnippet?: string;
  readonly bodyFingerprint?: string;
}

export interface MemoryPack {
  readonly generatedAt: string;
  readonly taskFingerprint: string;
  readonly memoryRevision: string;
  readonly candidates: readonly MemoryPackHint[];
  readonly promptHints: readonly MemoryPackHint[];
  /** @deprecated Use promptHints. Retained for F228 source compatibility. */
  readonly hints: readonly MemoryPackHint[];
  readonly omitted: readonly string[];
  readonly traceMetadata: MemoryPackTraceMetadata;
}

export interface MemoryPackTraceMetadata {
  readonly selectedRefIds: readonly string[];
  readonly omittedRefIds: readonly string[];
  readonly taskFingerprint: string;
  readonly suppressed: boolean;
}

export type MemoryReviewTrigger =
  | 'user_correction'
  | 'explicit_remember'
  | 'explicit_forget'
  | 'proposal_rejected'
  | 'conflict_detected'
  | 'episode_completed';

export interface MemoryReviewCandidateRef {
  readonly ref: MemoryItemRef;
  readonly bodySnippet?: string;
  readonly bodyFingerprint?: string;
  readonly warnings: readonly string[];
}

export interface MemoryReviewInput {
  readonly trigger: MemoryReviewTrigger;
  readonly userFeedback?: string;
  readonly episodeDigest?: KodaXMemoryOutcomeDigest;
  readonly task?: string;
  readonly sourceRefs?: readonly string[];
  readonly candidateRefIds?: readonly string[];
  readonly includePrivate?: boolean;
  readonly includeSensitive?: boolean;
  readonly maxRefs?: number;
}

export interface MemoryReviewModelInput {
  readonly trigger: MemoryReviewTrigger;
  readonly userFeedback: string;
  readonly task?: string;
  readonly sourceRefs: readonly string[];
  readonly candidateRefs: readonly MemoryReviewCandidateRef[];
  readonly warnings: readonly string[];
}

export interface MemoryReviewDraftAction {
  readonly action: MemoryProposalAction;
  readonly targetRefIds: readonly string[];
  readonly summary: string;
  readonly rationale: string;
  readonly confidence: 'low' | 'medium' | 'high';
  readonly risk: 'low' | 'medium' | 'high';
  readonly requiresApproval: true;
  readonly proposedBody?: string;
  readonly claimKind?: MemoryClaimKind;
  readonly claimKey?: string;
  readonly actionSignature?: string;
  readonly preconditions?: string;
  /** Host-bound version for an explicitly presented correction target. */
  readonly authorizationTargetFingerprint?: string;
  readonly counterexamples?: readonly string[];
  readonly relationship?: 'same_claim' | 'condition_refinement' | 'conflict';
}

export interface MemoryReviewPlan {
  readonly trigger: MemoryReviewTrigger;
  readonly createdAt: string;
  readonly sourceRefs: readonly string[];
  readonly candidateRefs: readonly MemoryReviewCandidateRef[];
  readonly actions: readonly MemoryReviewDraftAction[];
  readonly warnings: readonly string[];
  readonly episodeDigest?: KodaXMemoryOutcomeDigest;
}

export interface MemoryEpisodeReviewResult {
  readonly plan: MemoryReviewPlan;
  readonly proposalIds: readonly string[];
  readonly appliedProposalIds: readonly string[];
  readonly decisions: readonly MemoryReviewPersistenceDecision[];
  readonly warnings: readonly string[];
}

export type MemoryReviewPersistenceKind =
  | 'create'
  | 'evidence_update'
  | 'condition_refinement'
  | 'conflict'
  | 'no_action'
  | 'reject'
  | 'quarantine';

export interface MemoryReviewPersistenceDecision {
  readonly actionIndex: number;
  readonly kind: MemoryReviewPersistenceKind;
  readonly reason: string;
  readonly existingRefId?: string;
  readonly proposalId?: string;
}

/** Reviewers should honor cancellation and settle after their active work stops.
 * Runtime shutdown waits for that settlement rather than detaching the request. */
export type MemoryReviewRunner = (
  input: MemoryReviewModelInput,
  signal?: AbortSignal,
) => Promise<MemoryReviewPlan>;

export interface MemoryController {
  listInbox(): Promise<readonly MemoryActionProposal[]>;
  showProposal(id: string): Promise<MemoryActionProposal | undefined>;
  approveProposal(
    id: string,
    expectedFingerprints: Readonly<Record<string, string>>,
    expectedRevision?: string,
  ): Promise<MemoryApplyResult>;
  rejectProposal(id: string, reason?: string, expectedRevision?: string): Promise<MemoryRejectResult>;
  listRefs(filter?: MemoryRefFilter): Promise<readonly MemoryItemRef[]>;
  readRef(ref: MemoryItemRef): Promise<MemoryBodySnapshot>;
  runCurator(input?: MemoryCuratorInput): Promise<MemoryGovernanceReport>;
  maybeRunAutoCurator(input?: MemoryAutoCuratorInput): Promise<MemoryAutoCuratorResult>;
  buildMemoryPack(input: MemoryPackInput): Promise<MemoryPack>;
  reviewMemoryFeedback(input: MemoryReviewInput, signal?: AbortSignal): Promise<MemoryReviewPlan>;
  prepareEpisodeReview?(digest: KodaXMemoryOutcomeDigest): Promise<MemoryReviewModelInput>;
  applyReviewedEpisode?(
    plan: MemoryReviewPlan,
    digest: KodaXMemoryOutcomeDigest,
    signal?: AbortSignal,
    revalidateAuthority?: () => Promise<void>,
  ): Promise<MemoryEpisodeReviewResult>;
  persistReviewPlan(plan: MemoryReviewPlan): Promise<readonly string[]>;
  /**
   * Resolves which episode-review proposals were actually auto-applied by the
   * governed host policy. Used to keep durable receipts complete while user
   * notices remain truthful.
   */
  listHostAppliedEpisodeProposalIds?(
    proposalIds: readonly string[],
  ): Promise<readonly string[]>;
  reviewEpisode(
    digest: KodaXMemoryOutcomeDigest,
    signal?: AbortSignal,
  ): Promise<MemoryEpisodeReviewResult>;
  archiveRef(id: string): Promise<MemoryLifecycleOperationResult>;
  forgetRef(id: string, expectedBodyFingerprint?: string): Promise<MemoryLifecycleOperationResult>;
  purgeRef(id: string): Promise<MemoryLifecycleOperationResult>;
}

/** Additive management capability implemented by KodaX's default control plane. */
export interface MemoryManagementController extends MemoryController {
  /** Applies an explicit, prompt-safe user/host instruction without a second approval ceremony. */
  remember(input: MemoryRememberInput): Promise<MemoryRememberResult>;
}

export function isMemoryManagementController(
  controller: MemoryController,
): controller is MemoryManagementController {
  return 'remember' in controller && typeof controller.remember === 'function';
}

export type MemoryEvent =
  | { readonly type: 'proposal.created'; readonly proposalId: string }
  | { readonly type: 'proposal.approved'; readonly proposalId: string }
  | { readonly type: 'proposal.rejected'; readonly proposalId: string }
  | { readonly type: 'curator.completed'; readonly reportId: string }
  | { readonly type: 'pack.selected'; readonly refIds: readonly string[] }
  | { readonly type: 'review.completed'; readonly trigger: MemoryReviewTrigger; readonly actionCount: number };
