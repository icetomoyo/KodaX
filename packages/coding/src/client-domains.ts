/** Existing product domain operations. This module has no Host or UI dependencies. */
import type {
  CompactionReport, KodaXMessage, MemoryActionProposal, MemoryApplyResult,
  MemoryBodySnapshot, MemoryItemRef, MemoryLifecycleOperationResult,
  MemoryRefFilter, MemoryRejectResult, MemoryRememberInput, MemoryRememberResult,
  PendingEpisodeReviewSummary,
  LearnedCapabilityRecord, LearningEvent, LearningPage, LearningQuery,
  LearningSubscribeOptions, LearningSurfaceSnapshot,
} from '@kodax-ai/agent';

export interface ClientCompactSessionResult {
  readonly compacted: boolean;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  /** Host-committed context, or the unchanged context for a no-op. */
  readonly messages: KodaXMessage[];
  readonly report?: CompactionReport;
  /** A no-op or failure explanation; a lost reply never implies success. */
  readonly reason?: string;
}

/** Preview revision accompanies fingerprints so a second UI need not recreate it. */
export interface ClientMemoryProposal extends MemoryActionProposal {
  readonly revision: string;
}

export interface ClientMemoryController {
  listInbox(): Promise<readonly ClientMemoryProposal[]>;
  showProposal(id: string): Promise<ClientMemoryProposal | undefined>;
  approveProposal(id: string, expectedFingerprints: Readonly<Record<string, string>>, expectedRevision?: string): Promise<MemoryApplyResult>;
  rejectProposal(id: string, reason?: string, expectedRevision?: string): Promise<MemoryRejectResult>;
  listRefs(filter?: MemoryRefFilter): Promise<readonly MemoryItemRef[]>;
  /** Host resolves the exact ref ID; a supplied storage path is never write authority. */
  readRef(ref: MemoryItemRef): Promise<MemoryBodySnapshot>;
  remember(input: MemoryRememberInput): Promise<MemoryRememberResult>;
  forgetRef(id: string, expectedBodyFingerprint?: string): Promise<MemoryLifecycleOperationResult>;
}

export interface ClientMemoryRebuildResult {
  readonly status: 'missing-dir' | 'no-topics' | 'rebuilt';
  readonly memoryRoot: string;
  readonly entrypointPath: string;
  readonly entryCount: number;
  readonly malformedFiles: readonly string[];
  readonly warnings: readonly string[];
}

export interface ClientMemoryPlane {
  readonly controller: ClientMemoryController;
  readonly memoryRoot: string;
  readonly entrypointPath: string;
  listReviews(): Promise<readonly PendingEpisodeReviewSummary[]>;
  reviewerProviderConfigured(): boolean;
  rebuild(): Promise<ClientMemoryRebuildResult>;
  /** Validate containment and required directories; the UI launches its own editor. */
  ensureOpenTarget(targetPath: string): Promise<string>;
}

export interface ClientMemoryService {
  /** Host derives the project identity and rechecks authorization for each operation. */
  forProject(projectRoot: string): Promise<ClientMemoryPlane>;
}

/** Learning notifications belong to the authenticated client; governance is shared. */
export interface ClientLearningService {
  list(query?: LearningQuery): Promise<LearningPage>;
  get(nameOrSlugOrId: string): Promise<LearnedCapabilityRecord>;
  getSnapshot(): Promise<LearningSurfaceSnapshot>;
  events(afterRevision?: number): Promise<readonly LearningEvent[]>;
  subscribe(options?: LearningSubscribeOptions): AsyncIterable<LearningEvent>;
  acknowledge(nameOrSlugOrId: string): Promise<void>;
  snooze(nameOrSlugOrId: string, until: string): Promise<void>;
  reject(nameOrSlugOrId: string): Promise<void>;
  disable(nameOrSlugOrId: string): Promise<void>;
  rollback(nameOrSlugOrId: string): Promise<void>;
  promote(nameOrSlugOrId: string, scope: 'user'): Promise<void>;
  review(nameOrSlugOrId: string): Promise<void>;
  trust(nameOrSlugOrId: string): Promise<void>;
}

export interface ClientCommandInput {
  readonly sessionId: string;
  readonly inputId: string;
  readonly name: string;
  readonly args?: readonly string[];
}

export type ClientCommandResult =
  | { readonly kind: 'completed'; readonly success: boolean; readonly message?: string }
  | { readonly kind: 'started'; readonly runId: string; readonly message?: string };

export interface ClientReviewInput {
  readonly sessionId: string;
  readonly inputId: string;
  readonly args?: readonly string[];
}

export interface ClientReviewService {
  start(input: ClientReviewInput): Promise<ClientCommandResult>;
}

export interface ClientCommandService {
  /** Plain editable text only. Reading or cancelling a draft has no execution effects. */
  readPrompt(input: Omit<ClientCommandInput, 'inputId'>): Promise<{ readonly title: string; readonly text: string } | null>;
  /** Execute an existing registered command. Never automatically replay a lost reply. */
  execute(input: ClientCommandInput): Promise<ClientCommandResult>;
}
