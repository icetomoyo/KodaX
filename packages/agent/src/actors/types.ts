export type AgentActorState = 'running' | 'idle' | 'closed';
export type AgentTurnState = 'accepted' | 'running' | 'completed' | 'failed' | 'interrupted';
export type AgentExecutionKind = 'native' | 'constructed' | 'workflow' | 'external';
export type AgentForkTurns = 'all' | 'none' | number;
export type AgentDataClassification = 'public' | 'internal' | 'sensitive';
export type AgentProgressKind = 'status' | 'tool' | 'assistant';
export type AgentInterruptScope = 'turn' | 'subtree';
export type AgentMetadataValue =
  | string
  | number
  | boolean
  | null
  | readonly AgentMetadataValue[]
  | { readonly [key: string]: AgentMetadataValue };

export interface AgentCapabilities {
  readonly tools: readonly string[];
  readonly filesystem: 'none' | 'read' | 'write';
  readonly network: boolean;
  readonly providers: readonly string[];
  readonly canAskUser: boolean;
  /** Backend operation support. Omitted means the complete native contract. */
  readonly control?: {
    readonly followup: boolean;
    readonly interrupt: boolean;
    readonly streaming: boolean;
    readonly artifacts: boolean;
  };
}

export interface AgentActor {
  readonly path: string;
  readonly taskName: string;
  readonly parentPath?: string;
  readonly kind: AgentExecutionKind;
  readonly state: AgentActorState;
  readonly capabilities: AgentCapabilities;
  readonly turnIds: readonly string[];
  readonly currentTurnId?: string;
  readonly mailboxCursor: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly revision: number;
}

/** Executor-neutral artifact metadata retained beside the legacy string reference. */
export interface AgentArtifactDescriptor {
  readonly name: string;
  readonly uri?: string;
  readonly mimeType?: string;
  readonly size?: number;
  readonly hash?: string;
  readonly provenance?: string;
  readonly producingAgentId?: string;
  readonly remoteTaskId?: string;
}

/** One executor invocation; max=0 means no finite iteration limit. */
export interface AgentIterationProgress {
  readonly current: number;
  readonly max: number;
}

export interface AgentTurn {
  readonly iteration?: AgentIterationProgress;
  readonly terminationReason?: 'iteration_limit';
  readonly turnId: string;
  readonly actorPath: string;
  readonly sequence: number;
  readonly state: AgentTurnState;
  readonly objective: string;
  readonly forkTurns: AgentForkTurns;
  readonly metadata?: Readonly<Record<string, AgentMetadataValue>>;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly output?: string;
  readonly artifacts?: readonly string[];
  readonly artifactDetails?: readonly AgentArtifactDescriptor[];
  readonly structured?: AgentMetadataValue;
  readonly error?: string;
  /** Bounded Runtime-owned activity projection; full transcripts remain executor-owned. */
  readonly progress?: readonly AgentProgressItem[];
  readonly revision: number;
}

export interface AgentProgressUpdate {
  readonly iteration?: AgentIterationProgress;
  readonly kind: AgentProgressKind;
  readonly summary: string;
}

export interface AgentProgressItem extends AgentProgressUpdate {
  readonly sequence: number;
  readonly createdAt: string;
}

export interface AgentMailboxMessage {
  readonly messageId: string;
  readonly sequence: number;
  readonly senderPath: string;
  readonly recipientPath: string;
  readonly turnId?: string;
  readonly kind: 'message' | 'followup' | 'completion';
  readonly classification: AgentDataClassification;
  /** Canonical actors that handled this chain; absent only on pre-hardening schema-v1 snapshots. */
  readonly lineage?: readonly string[];
  readonly forwardedMessageId?: string;
  readonly content: string;
  readonly createdAt: string;
}

export type AgentEventKind =
  | 'actor_spawned'
  | 'turn_started'
  | 'message_delivered'
  | 'turn_progress'
  | 'turn_completed'
  | 'turn_failed'
  | 'turn_interrupted'
  | 'actor_closed';

export interface AgentEvent {
  readonly sequence: number;
  readonly kind: AgentEventKind;
  readonly actorPath: string;
  readonly turnId?: string;
  readonly parentPath?: string;
  readonly progress?: AgentProgressItem;
  readonly createdAt: string;
}

export interface AgentSpawnInput {
  readonly taskName: string;
  readonly objective: string;
  readonly kind?: AgentExecutionKind;
  readonly forkTurns?: AgentForkTurns;
  readonly capabilities?: Partial<AgentCapabilities>;
  readonly metadata?: Readonly<Record<string, AgentMetadataValue>>;
}

export interface AgentTurnRef {
  readonly actorPath: string;
  readonly turnId: string;
  readonly state: 'accepted' | 'running';
}

export interface AgentFollowupResult {
  readonly delivery: 'started_turn' | 'current_turn';
  readonly turn: AgentTurnRef;
}

export interface AgentTreeSnapshot {
  readonly rootPath: '/root';
  readonly actors: readonly AgentListEntry[];
  readonly activeNonRootTurns: number;
  readonly maxConcurrentThreads: number;
  readonly revision: number;
  /** Turn-admission state revision; absent only on older/custom clients. */
  readonly admissionRevision?: number;
}

export interface AgentTurnSummary {
  readonly iteration?: AgentIterationProgress;
  readonly terminationReason?: 'iteration_limit';
  readonly turnId: string;
  readonly state: AgentTurnState;
  readonly summary: string;
  readonly summaryTruncated: boolean;
  readonly recentActivity: readonly AgentProgressItem[];
}

export interface AgentListEntry extends AgentActor {
  readonly latestTurn?: AgentTurnSummary;
}

export interface AgentDetail {
  readonly actor: AgentActor;
  readonly turns: readonly AgentTurn[];
  readonly mailbox: readonly AgentMailboxMessage[];
}

export interface AgentOutput {
  readonly iteration?: AgentIterationProgress;
  readonly terminationReason?: 'iteration_limit';
  readonly actorPath: string;
  readonly turnId: string;
  readonly state: AgentTurnState;
  readonly output?: string;
  readonly outputTruncated?: boolean;
  readonly artifacts: readonly string[];
  readonly artifactDetails?: readonly AgentArtifactDescriptor[];
  readonly progress: readonly AgentProgressItem[];
  readonly structured?: AgentMetadataValue;
  readonly error?: string;
}

export interface AgentLimitReached {
  readonly code: 'agent_limit_reached';
  readonly maxConcurrentThreads: number;
  readonly activeNonRootTurns: number;
  readonly availableNonRootSlots: 0;
  readonly retryable: true;
}

export interface AgentBudgetExhausted {
  readonly code: 'agent_budget_exhausted';
  readonly retryable: false;
  readonly reason: string;
}

export interface AgentBudgetAdmissionInput {
  readonly actorPath: string;
  readonly parentPath: string;
  readonly turnId: string;
  readonly kind: AgentExecutionKind;
  readonly units: 1;
}

export type AgentBudgetAdmission =
  | { readonly admitted: true }
  | { readonly admitted: false; readonly fact: AgentBudgetExhausted };

export interface AgentBudgetPort {
  admit(input: AgentBudgetAdmissionInput): Promise<AgentBudgetAdmission>;
  refund?(turnId: string): Promise<void>;
  snapshot?(): unknown;
}

export interface AgentExecutionInput {
  readonly actor: AgentActor;
  readonly turn: AgentTurn;
  readonly priorTurns: readonly AgentTurn[];
  readonly signal: AbortSignal;
  drainMailbox(): Promise<readonly AgentMailboxMessage[]>;
  reportProgress(update: AgentProgressUpdate): Promise<void>;
}

export interface AgentExecutionResult {
  readonly iteration?: AgentIterationProgress;
  readonly terminationReason?: 'iteration_limit';
  readonly output: string;
  readonly artifacts?: readonly string[];
  readonly artifactDetails?: readonly AgentArtifactDescriptor[];
  readonly structured?: AgentMetadataValue;
  /** Runtime-observed completion facts merged into the durable Turn metadata. */
  readonly turnMetadata?: Readonly<Record<string, AgentMetadataValue>>;
}

export interface AgentMutationOptions {
  /** Optimistic Actor revision checked inside the serialized durable mutation. */
  readonly expectedRevision?: number;
  /** Optimistic tree revision checked inside the serialized durable mutation. */
  readonly expectedTreeRevision?: number;
  /** Optimistic turn-admission revision, excluding progress and mailbox writes. */
  readonly expectedAdmissionRevision?: number;
}

export interface AgentTurnExecutor {
  execute(input: AgentExecutionInput): Promise<AgentExecutionResult>;
}

interface AgentActorSnapshotContents {
  readonly revision: number;
  /** Added after schema v2; legacy snapshots derive it from revision on load. */
  readonly admissionRevision?: number;
  readonly maxConcurrentThreads: number;
  readonly actors: readonly AgentActor[];
  readonly turns: readonly AgentTurn[];
  readonly mailboxes: Readonly<Record<string, readonly AgentMailboxMessage[]>>;
  /** Terminal child turns explicitly observed by their direct parent. */
  readonly acknowledgedCompletionTurnIds?: readonly string[];
  /** Root completion notifications that must survive process-local queue loss. */
  readonly pendingRootCompletionTurnIds?: readonly string[];
  readonly events: readonly AgentEvent[];
}

/** Runtime process/controller identity that exclusively owns one durable Actor tree. */
export interface AgentActorOwner {
  readonly ownerId: string;
  readonly runtimeId: string;
  readonly pid: number;
  readonly startedAt: string;
  /** Opaque host identity for proving that this exact Runtime, not only its PID, remains alive. */
  readonly livenessId?: string;
  /** Loopback challenge endpoint paired with livenessId. */
  readonly livenessPort?: number;
}

export interface AgentActorSnapshotV1 extends AgentActorSnapshotContents {
  readonly schemaVersion: 1;
}

export interface AgentActorSnapshotV2 extends AgentActorSnapshotContents {
  readonly schemaVersion: 2;
  readonly owner?: AgentActorOwner;
}

export type AgentActorSnapshot = AgentActorSnapshotV1 | AgentActorSnapshotV2;

export type AgentActorSavePhase =
  | 'queued'
  | 'precommit'
  | 'commit_inflight'
  | 'committed'
  | 'not_committed';

export type AgentActorSaveTiming =
  | 'storageQueue'
  | 'fileLock'
  | 'readCas'
  | 'lineage'
  | 'topology'
  | 'tempWrite'
  | 'fsync'
  | 'rename'
  | 'postCommit'
  | 'total';

export interface AgentActorSaveDiagnostics {
  readonly attemptId: string;
  readonly phase: AgentActorSavePhase;
  readonly activeStage?: AgentActorSaveTiming;
  readonly activeStageElapsedMs?: number;
  readonly failedStage?: AgentActorSaveTiming;
  readonly canonicalOutcome?:
    | 'pending'
    | 'committed'
    | 'committed_by_readback'
    | 'not_committed'
    | 'ambiguous';
  readonly completionOutcome?: 'pending' | 'succeeded' | 'failed';
  readonly timingsMs: Readonly<Partial<Record<AgentActorSaveTiming, number>>>;
}

/** One storage-neutral Actor snapshot attempt with an explicit canonical boundary. */
export interface AgentActorSaveAttempt {
  /** Resolves after the process-local storage queue admits this attempt. */
  readonly dequeued: Promise<void>;
  /** Resolves after storage queueing and writer admission, before canonical preparation. */
  readonly eligible: Promise<void>;
  /** Resolves when the Actor snapshot is canonical; rejects before or during commit. */
  readonly canonical: Promise<void>;
  /** Full cache/watermark/topology maintenance completion for legacy callers and diagnostics. */
  readonly completion: Promise<void>;
  phase(): AgentActorSavePhase;
  /** Prevents a queued/precommit attempt from ever entering canonical commit. */
  cancelBeforeCommit(): boolean;
  diagnostics(): AgentActorSaveDiagnostics;
}

export interface AgentActorStore {
  load(): Promise<AgentActorSnapshot | undefined>;
  /** CAS save. Implementations must throw actor_snapshot_conflict on a revision mismatch. */
  save(snapshot: AgentActorSnapshot, expectedRevision: number): Promise<void>;
  /** Optional phase-aware save used by Actor settlement convergence v2. */
  beginSave?(
    snapshot: AgentActorSnapshot,
    expectedRevision: number,
  ): AgentActorSaveAttempt;
  /** Maximum expected writer-admission wait after a phase-aware save is dequeued. */
  readonly eligibilityTimeoutMs?: number;
}

/** Runtime-bound actor control surface. The caller path is minted by Runtime. */
export interface AgentActorClient {
  readonly callerPath: string;
  /** Stable in-process identity shared by clients bound to the same Actor tree. */
  readonly admissionScope?: object;
  spawn(input: AgentSpawnInput, options?: AgentMutationOptions): Promise<AgentTurnRef>;
  send(
    targetPath: string,
    content: string,
    classification?: AgentDataClassification,
    forwardedMessageId?: string,
  ): Promise<AgentMailboxMessage>;
  followup(
    targetPath: string,
    objective: string,
    metadata?: Readonly<Record<string, AgentMetadataValue>>,
    options?: AgentMutationOptions,
  ): Promise<AgentFollowupResult>;
  interrupt(targetPath: string, reason?: string, scope?: AgentInterruptScope): Promise<void>;
  acknowledgeCompletions(turnIds: readonly string[]): Promise<number>;
  list(): AgentTreeSnapshot;
  get(targetPath: string): AgentDetail;
  output(targetPath: string, turnId?: string): AgentOutput;
  eventSnapshot(afterSequence?: number): readonly AgentEvent[];
  wait(
    afterSequence?: number,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<AgentEvent | undefined>;
}
