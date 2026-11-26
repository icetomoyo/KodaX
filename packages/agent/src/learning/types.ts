import type { ResolvedSkillSource } from '../capabilities/skills/types.js';
import type { MemoryApplicability } from '../memory/identity.js';

export type SkillWriteOrigin =
  | 'foreground_user'
  | 'assistant_tool'
  | 'background_learning';

export type ProceduralLearningDestination =
  | 'skill_patch'
  | 'skill_create'
  | 'workflow_handoff'
  | 'memdir_handoff'
  | 'reasoning_handoff'
  | 'trace_only'
  | 'discard';

export type LearningUserLabel =
  | 'method_guide'
  | 'runnable_workflow'
  | 'context_note'
  | 'reasoning_report'
  | 'trace_only';

export type MemoryWriteOrigin =
  | 'foreground_user'
  | 'assistant_tool'
  | 'background_learning'
  | 'external_provider';

export type MemoryExecutionContext =
  | 'primary'
  | 'subagent'
  | 'workflow_child'
  | 'cron'
  | 'flush'
  | 'compression';

export interface MemoryHandoffMetadata {
  readonly writeOrigin: MemoryWriteOrigin;
  readonly executionContext: MemoryExecutionContext;
  readonly sessionId: string;
  readonly parentSessionId?: string;
  readonly platform?: string;
  readonly sourceTool?: string;
  readonly sourceRefs: readonly string[];
  readonly completedTurn: boolean;
  readonly claimKind?: 'fact' | 'policy' | 'preference' | 'procedure' | 'episode';
  readonly claimKey?: string;
  readonly actionSignature?: string;
  readonly persistenceKind?: 'create' | 'evidence_update' | 'condition_refinement' | 'conflict';
  /** User-facing explanation preserved across proposal-store restarts. */
  readonly reviewRationale?: string;
  /** User-facing risk preserved across proposal-store restarts. */
  readonly reviewRisk?: LearningRisk;
  readonly targetRefId?: string;
  readonly targetStorageUri?: string;
  readonly authorizationTargetFingerprint?: string;
  readonly preconditions?: string;
  readonly applicability?: MemoryApplicability;
  readonly requestedLifecycle?: 'active' | 'provisional';
  readonly episodeOutcome?: 'succeeded' | 'failed' | 'cancelled';
  readonly verifiedEvidence?: boolean;
  readonly evidenceProjectId?: string;
}

export interface SkillConsumerImpact {
  readonly workflowCapsules: readonly string[];
  readonly savedWorkflows: readonly string[];
  readonly constructedAgents: readonly string[];
  readonly promptReferences: readonly string[];
  readonly action: 'none' | 'rewrite_proposal' | 'block_until_manual_review';
}

export type WorkflowLearningSuggestedAction =
  | 'save_from_run'
  | 'revise_capsule'
  | 'add_skill_reference'
  | 'report_only';

export type LearningRisk = 'low' | 'medium' | 'high';

export type LearningCandidate =
  | {
      readonly kind: 'skill_patch';
      readonly skillName: string;
      readonly whyDurable: string;
      readonly trigger: string;
      readonly changeSummary: string;
      readonly confidence?: number;
    }
  | {
      readonly kind: 'skill_create';
      readonly skillName: string;
      readonly whyDurable: string;
      readonly trigger: string;
      readonly changeSummary: string;
      readonly confidence?: number;
    }
  | {
      readonly kind: 'workflow_handoff';
      readonly workflowRunId: string;
      readonly workflowStatus: 'running' | 'completed' | 'failed' | 'stopped' | 'cancelled';
      readonly suggestedAction: WorkflowLearningSuggestedAction;
      readonly whyWorkflowNotSkill: string;
      readonly requiredWorkflowEvidence: readonly string[];
      readonly risk: LearningRisk;
      readonly consumerImpact: SkillConsumerImpact;
    }
  | {
      readonly kind: 'memdir_handoff';
      readonly memoryKind: 'user' | 'feedback' | 'project' | 'reference' | 'semantic_memory';
      readonly body: string;
      readonly metadata: MemoryHandoffMetadata;
    }
  | {
      readonly kind: 'reasoning_handoff';
      readonly title: string;
      readonly body: string;
      readonly sourceRefs: readonly string[];
    }
  | {
      readonly kind: 'trace_only';
      readonly reason: string;
    };

export interface ProceduralLearningInput {
  readonly proposalId: string;
  readonly origin: SkillWriteOrigin;
  readonly completedTurn: boolean;
  readonly sourceRefs: readonly string[];
  readonly candidate: LearningCandidate;
}

export interface DiscardedLearningReport {
  readonly destination: 'discard';
  readonly proposalId: string;
  readonly reason: string;
}

export interface TraceOnlyLearningReport {
  readonly destination: 'trace_only';
  readonly proposalId: string;
  readonly userLabel: 'trace_only';
  readonly reason: string;
  readonly sourceTraceIds: readonly string[];
}

export interface SkillLearningProposal {
  readonly destination: 'skill_patch' | 'skill_create';
  readonly proposalId: string;
  readonly origin: SkillWriteOrigin;
  readonly userLabel: 'method_guide';
  readonly skillName: string;
  readonly whyDurable: string;
  readonly trigger: string;
  readonly changeSummary: string;
  readonly sourceTraceIds: readonly string[];
  readonly confidence: number;
}

export interface WorkflowLearningHandoff {
  readonly destination: 'workflow_handoff';
  readonly proposalId: string;
  readonly origin: SkillWriteOrigin;
  readonly userLabel: 'runnable_workflow';
  readonly evidenceRunIds: readonly string[];
  readonly sourceTraceIds: readonly string[];
  readonly suggestedAction: WorkflowLearningSuggestedAction;
  readonly whyWorkflowNotSkill: string;
  readonly requiredWorkflowEvidence: readonly string[];
  readonly risk: LearningRisk;
  readonly consumerImpact: SkillConsumerImpact;
  readonly appliedByF224: false;
}

export interface MemoryLearningHandoff {
  readonly destination: 'memdir_handoff';
  readonly proposalId: string;
  readonly origin: SkillWriteOrigin;
  readonly userLabel: 'context_note';
  readonly memoryKind: 'user' | 'feedback' | 'project' | 'reference' | 'semantic_memory';
  readonly body: string;
  readonly metadata: MemoryHandoffMetadata;
}

export interface ReasoningLearningHandoff {
  readonly destination: 'reasoning_handoff';
  readonly proposalId: string;
  readonly origin: SkillWriteOrigin;
  readonly userLabel: 'reasoning_report';
  readonly title: string;
  readonly body: string;
  readonly sourceTraceIds: readonly string[];
}

export type ProceduralLearningResult =
  | SkillLearningProposal
  | WorkflowLearningHandoff
  | MemoryLearningHandoff
  | ReasoningLearningHandoff
  | TraceOnlyLearningReport
  | DiscardedLearningReport;

export type ReviewableLearningProposal = Exclude<
  ProceduralLearningResult,
  DiscardedLearningReport | TraceOnlyLearningReport
>;

export type LearningProposalReviewStatus =
  | 'pending'
  | 'approved'
  | 'rejected';

export interface StoredLearningProposal {
  readonly proposalId: string;
  readonly status: LearningProposalReviewStatus;
  readonly proposal: ReviewableLearningProposal;
  readonly applyPlan?: StoredLearningApplyPlan;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly appliedAt?: string;
  readonly appliedChangedPaths?: readonly string[];
  readonly appliedSnapshotPath?: string;
  readonly approvedBy?: 'user' | 'host';
  readonly approvedAt?: string;
  readonly approvalPolicyId?: string;
  readonly approvalPolicyReason?: string;
  readonly approvalExpectedFingerprints?: Readonly<Record<string, string>>;
  readonly approvalResultingFingerprints?: Readonly<Record<string, string>>;
  readonly rejectedReason?: string;
}

export interface LearningProposalStoreReadResult {
  readonly proposals: readonly StoredLearningProposal[];
  readonly warnings: readonly string[];
}

export interface StoredSkillLearningApplyPlan {
  readonly kind: 'skill';
  readonly governance: SkillGovernanceInput;
  readonly skillRoot: string;
  readonly changes: readonly SkillMutationChange[];
  readonly snapshotRoot?: string;
}

export type StoredLearningApplyPlan = StoredSkillLearningApplyPlan;

export type GovernedSkillSource = ResolvedSkillSource | 'learned' | 'external';

export type SkillOwnership =
  | 'system'
  | 'human'
  | 'background_created';

export type SkillGovernanceAction =
  | 'record_usage'
  | 'create'
  | 'patch'
  | 'archive'
  | 'quarantine'
  | 'delete'
  | 'consolidate'
  | 'direct_mutation';

export type SkillGovernanceMode =
  | 'telemetry'
  | 'proposal'
  | 'overlay_proposal'
  | 'blocked';

export interface SkillGovernanceInput {
  readonly action: SkillGovernanceAction;
  readonly source: GovernedSkillSource;
  readonly ownership: SkillOwnership;
  readonly origin: SkillWriteOrigin;
  readonly pinned?: boolean;
}

export interface SkillGovernanceDecision {
  readonly allowed: boolean;
  readonly mode: SkillGovernanceMode;
  readonly reason: string;
}

export type SkillMutationChange =
  | {
      readonly kind: 'write';
      readonly relativePath: string;
      readonly content: string;
    }
  | {
      readonly kind: 'delete';
      readonly relativePath: string;
    };

export interface SkillMutationApplyInput {
  readonly proposalId: string;
  readonly skillRoot: string;
  readonly changes: readonly SkillMutationChange[];
  readonly approved: boolean;
  readonly dryRun?: boolean;
  readonly snapshotRoot?: string;
  readonly createSkillRoot?: boolean;
}

export interface SkillMutationApplyResult {
  readonly proposalId: string;
  readonly validated: true;
  readonly applied: boolean;
  readonly changedPaths: readonly string[];
  readonly snapshotPath?: string;
}

export interface SkillLearningApplyInput {
  readonly proposal: ProceduralLearningResult;
  readonly governance: SkillGovernanceInput;
  readonly skillRoot: string;
  readonly changes: readonly SkillMutationChange[];
  readonly approved: boolean;
  readonly dryRun?: boolean;
  readonly snapshotRoot?: string;
}

export type LearningIntakeRecordResult =
  | {
      readonly stored: true;
      readonly result: ReviewableLearningProposal;
      readonly proposal: StoredLearningProposal;
    }
  | {
      readonly stored: false;
      readonly result: DiscardedLearningReport | TraceOnlyLearningReport;
    };
