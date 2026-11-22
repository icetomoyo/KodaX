export type LearnedCapabilityCarrier = 'skill' | 'extension' | 'workflow_handoff';

export type LearnedCapabilityLifecycle =
  | 'opportunity'
  | 'drafting'
  | 'ready'
  | 'testing'
  | 'active_learned'
  | 'promoted_user'
  | 'quarantined'
  | 'archived'
  | 'rejected';

export type LearningEventKind =
  | 'opportunity'
  | 'drafting'
  | 'ready'
  | 'testing'
  | 'activated'
  | 'promoted'
  | 'attention'
  | 'archived'
  | 'rejected';

export type LearningAction =
  | 'review'
  | 'trust'
  | 'reject'
  | 'disable'
  | 'rollback'
  | 'archive'
  | 'restore'
  | 'promote';

export interface LearnedCapabilitySource {
  readonly kind:
    | 'learning_controller'
    | 'f224_proposal'
    | 'skill_learning_loop'
    | 'legacy_manual';
  readonly proposalId?: string;
}

interface LearnedCapabilityRecordBase {
  readonly capabilityId: string;
  readonly displayName: string;
  readonly slug: string;
  readonly carrier: LearnedCapabilityCarrier;
  readonly lifecycle: LearnedCapabilityLifecycle;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly source: LearnedCapabilitySource;
  /** The control action that produced this revision, when it is not implied by lifecycle. */
  readonly lastAction?: LearningAction;
  readonly artifactPath?: string;
  readonly previousGoodRevision?: number;
  readonly previousLifecycle?: LearnedCapabilityLifecycle;
  readonly diagnostics?: readonly string[];
}

export interface LearnedCapabilityRecordV1 extends LearnedCapabilityRecordBase {
  readonly schemaVersion: 1;
}

export interface LearnedCapabilityScope {
  readonly configHomeHash: string;
  readonly tenantHash: string;
  readonly projectHash: string;
}

export interface LearnedCapabilityArtifact {
  readonly kind: 'skill_markdown';
  readonly relativePath: string;
  readonly fingerprint: string;
  readonly contentRevision: number;
}

export interface LearnedCapabilityProvenance {
  readonly jobId: string;
  readonly inputHash: string;
  readonly decisionId: string;
  readonly actionId: string;
}

export interface LearnedCapabilityCanaryBinding {
  readonly bindingId: string;
  readonly ownerSessionRef: string;
  readonly expiresAt: string;
}

export interface LearnedCapabilityCanaryInvocation {
  readonly invocationId: string;
  readonly bindingId: string;
  /** Durable usage-ledger identity for recovery after the binding expires. */
  readonly usageSessionHash?: string;
  readonly artifactRevision?: number;
  readonly artifactFingerprint?: string;
  readonly status: 'pending' | 'verified_success' | 'credible_negative' | 'inconclusive';
  readonly evidenceRefs: readonly string[];
  readonly invokedAt: string;
  readonly completedAt?: string;
}

export interface LearnedCapabilityCanary {
  readonly maxInvocations: 3;
  readonly invocationCount: number;
  readonly verifiedSuccesses: number;
  readonly credibleNegatives: number;
  readonly binding?: LearnedCapabilityCanaryBinding;
  readonly invocations: readonly LearnedCapabilityCanaryInvocation[];
}

export interface LearnedCapabilityRecordV2 extends LearnedCapabilityRecordBase {
  readonly schemaVersion: 2;
  readonly carrier: 'skill';
  readonly scope: LearnedCapabilityScope;
  readonly artifact: LearnedCapabilityArtifact;
  readonly previousGoodArtifact?: LearnedCapabilityArtifact;
  readonly provenance: LearnedCapabilityProvenance;
  readonly canary: LearnedCapabilityCanary;
}

export type LearnedCapabilityRecord = LearnedCapabilityRecordV1 | LearnedCapabilityRecordV2;

export interface LearningEvent {
  readonly schemaVersion: 1;
  readonly sequence: number;
  readonly eventId: string;
  readonly capabilityId: string;
  readonly capabilityRevision: number;
  readonly kind: LearningEventKind;
  readonly lifecycle: LearnedCapabilityLifecycle;
  readonly displayName: string;
  readonly slug: string;
  readonly carrier: LearnedCapabilityCarrier;
  readonly createdAt: string;
}

export type LearningNotificationState = 'unread' | 'seen' | 'acknowledged' | 'snoozed';

export interface LearningClientEventState {
  readonly state: LearningNotificationState;
  readonly capabilityRevision: number;
  readonly updatedAt: string;
  readonly snoozedUntil?: string;
}

export interface LearningClientRecord {
  readonly schemaVersion: 1;
  readonly clientIdentity: string;
  readonly events: Readonly<Record<string, LearningClientEventState>>;
}

export interface LearningSurfaceSnapshot {
  readonly ready: number;
  readonly newlyActive: number;
  readonly attention: number;
  readonly active: number;
  readonly revision: number;
}

export interface LearningQuery {
  readonly search?: string;
  readonly carrier?: LearnedCapabilityCarrier;
  readonly lifecycle?: LearnedCapabilityLifecycle;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface LearningPage {
  readonly items: readonly LearnedCapabilityRecord[];
  readonly nextCursor?: string;
  readonly revision: number;
}

export interface LearningSubscribeOptions {
  readonly afterRevision?: number;
}

export interface LearningExplicitUserAuthority {
  readonly authority: 'explicit_user';
  readonly expectedRevision: number;
  readonly expectedFingerprint?: string;
}

export interface LearningActionDriver {
  readonly carrier: LearnedCapabilityCarrier;
  readonly actions: readonly LearningAction[];
  execute(
    action: LearningAction,
    capability: LearnedCapabilityRecord,
  ): Promise<LearnedCapabilityRecord>;
}

export type LearningCapabilityErrorCode =
  | 'ambiguous_name'
  | 'action_failed'
  | 'capability_not_found'
  | 'invalid_record'
  | 'invalid_transition'
  /** The capability changed after the person decided on it; read it again. */
  | 'revision_conflict'
  | 'store_integrity_error'
  | 'unsupported_action';

export class LearningCapabilityError extends Error {
  constructor(
    readonly code: LearningCapabilityErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LearningCapabilityError';
  }
}

const TRANSITIONS: Readonly<Record<LearnedCapabilityLifecycle, readonly LearnedCapabilityLifecycle[]>> = {
  opportunity: ['drafting', 'archived', 'rejected'],
  drafting: ['ready', 'archived', 'rejected'],
  ready: ['testing', 'active_learned', 'promoted_user', 'archived', 'rejected', 'quarantined'],
  testing: ['active_learned', 'quarantined', 'archived'],
  active_learned: ['testing', 'quarantined', 'archived', 'promoted_user'],
  promoted_user: [],
  quarantined: ['ready', 'testing', 'active_learned', 'archived', 'rejected'],
  archived: ['ready', 'active_learned', 'rejected'],
  rejected: [],
};

export function canTransitionLearnedCapability(
  from: LearnedCapabilityLifecycle,
  to: LearnedCapabilityLifecycle,
): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertLearnedCapabilityTransition(
  from: LearnedCapabilityLifecycle,
  to: LearnedCapabilityLifecycle,
): void {
  if (!canTransitionLearnedCapability(from, to)) {
    throw new LearningCapabilityError(
      'invalid_transition',
      `learned capability cannot transition from ${from} to ${to}`,
    );
  }
}

export function slugifyLearnedCapabilityName(displayName: string): string {
  const slug = displayName
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
  if (slug.length === 0) {
    throw new LearningCapabilityError('invalid_record', 'learned capability name must contain letters or numbers');
  }
  return slug;
}

export function learningEventKindForLifecycle(
  lifecycle: LearnedCapabilityLifecycle,
): LearningEventKind {
  if (lifecycle === 'active_learned') return 'activated';
  if (lifecycle === 'promoted_user') return 'promoted';
  if (lifecycle === 'quarantined') return 'attention';
  return lifecycle;
}

export function learningEventKindForRecord(
  record: LearnedCapabilityRecord,
): LearningEventKind {
  return record.lastAction === 'rollback'
    ? 'attention'
    : learningEventKindForLifecycle(record.lifecycle);
}

export function learningEventIdFor(record: LearnedCapabilityRecord): string {
  return `${record.capabilityId}-r${record.revision}-${learningEventKindForRecord(record)}`;
}
