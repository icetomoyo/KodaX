/** Product data shared by SDK clients and UIs; independent of Host implementation. */
import type {
  AgentDataClassification,
  AgentDetail,
  AgentEvent,
  AgentFollowupResult,
  AgentOutput,
  AgentRegistrationEnabledMutationOptions,
  AgentRegistrationMutationOptions,
  AgentSpawnInput,
  AgentTreeSnapshot,
  AgentTurnRef,
  AskUserAnswer,
  AskUserMultiOptions,
  AskUserQuestionOptions,
  ExternalAgentRegistration,
  ExternalAgentRegistrationSummary,
  KodaXGoalState,
  KodaXInputArtifact,
  KodaXSessionEntry,
} from '@kodax-ai/agent';
import type { KodaXResult } from './types.js';
import type { ClientCompactSessionResult, ClientMemoryService, ClientLearningService, ClientCommandService, ClientReviewService, ClientReviewInput, ClientCommandResult } from './client-domains.js';
export type * from './client-domains.js';

/** Display facts only; extension handlers and Host execution types stay private. */
export interface ClientLoadedExtension {
  readonly path: string;
  readonly label: string;
  readonly loadSource: string;
}

export interface ClientExtensionSource {
  readonly kind: string;
  readonly id?: string;
  readonly label?: string;
}

export interface ClientExtensionDiagnostics {
  readonly loadedExtensions: readonly ClientLoadedExtension[];
  readonly capabilityProviders: readonly {
    readonly id: string;
    readonly kinds: readonly string[];
    readonly metadata?: Record<string, unknown>;
  }[];
  readonly commands: readonly { readonly name: string; readonly aliases?: readonly string[]; readonly description: string }[];
  readonly tools: readonly { readonly name: string; readonly source: ClientExtensionSource; readonly shadowedSources: readonly ClientExtensionSource[] }[];
  readonly hooks: readonly { readonly hook: string; readonly order: number; readonly source: ClientExtensionSource }[];
  readonly failures: readonly { readonly stage: string; readonly target: string; readonly message: string; readonly source: ClientExtensionSource }[];
  readonly defaults: {
    readonly activeTools?: readonly string[];
    readonly modelSelection: { readonly provider?: string; readonly model?: string };
    readonly thinkingLevel?: string;
  };
}

export interface ClientSession {
  readonly id: string;
  readonly title: string;
  readonly gitRoot?: string;
  readonly workspaceRoot?: string;
  readonly surface?: string;
  readonly profileId?: string;
  readonly createdAt?: string;
}

export interface ClientSessionSummary extends ClientSession {
  /** Opaque continuation token for list pagination. */
  readonly cursor?: string;
  readonly msgCount: number;
  readonly tag?: string;
  readonly projectKey?: string;
  readonly archived?: boolean;
}

export interface ClientSessionFilter {
  readonly projectRoot?: string;
  readonly scope?: 'user' | 'managed-task-worker' | 'all';
  readonly includeArchived?: boolean;
  readonly limit?: number;
  readonly before?: string;
  readonly tag?: string;
  readonly surface?: string;
  readonly cursor?: string;
}

export interface KodaXProductClient {
  readonly commands: ClientCommandService;
  readonly review: ClientReviewService;
  readonly memory: ClientMemoryService;
  readonly learning: ClientLearningService;
  readonly host: {
    /** Request an idle Host to shut down. Acceptance does not prove cleanup has completed. */
    shutdown(): Promise<{ readonly accepted: true }>;
  };
  readonly sessions: {
    cancel(input: ClientSessionCancelInput): Promise<ClientSessionCancelReceipt>;
    compact(sessionId: string, input?: { readonly customInstructions?: string }): Promise<ClientCompactSessionResult>;
    create(input?: ClientCreateSessionInput): Promise<ClientSession>;
    list(filter?: ClientSessionFilter): Promise<readonly ClientSessionSummary[]>;
    read(sessionId: string): Promise<ClientSession>;
    delete(sessionId: string): Promise<void>;
    archive(sessionId: string): Promise<void>;
    unarchive(sessionId: string): Promise<void>;
    getSettings(sessionId: string): Promise<ClientSessionSettings>;
    /** Read the Host's existing settings revision for a conditional edit or restoration. */
    getSettingsVersioned(sessionId: string): Promise<ClientSessionSettingsSnapshot>;
    /** Reject with conflict if another settings edit has occurred since expectedRevision. */
    updateSettingsVersioned(sessionId: string, patch: ClientSessionSettingsPatch,
      options: { readonly expectedRevision: number }): Promise<ClientSessionSettingsSnapshot>;
    /** Existing Host Auto reviewer diagnostics; undefined when Auto mode is not selected. */
    getAutoModeStats(sessionId: string): Promise<ClientAutoModeStats | undefined>;
    /** Change this Session only. The next physical request uses the updated selection. */
    updateSettings(sessionId: string, patch: ClientSessionSettingsPatch): Promise<ClientSessionSettings>;
    /** Delivers the current view first, then replacements; no event cursor is needed. */
    observe(sessionId: string, onView: (view: ClientSessionView) => void, options?: ClientObserveOptions): Promise<ClientObservation>;
    /** Read the original content behind a bounded display item. Offsets are UTF-16 characters. */
    readItem(sessionId: string, itemId: string, options?: ClientItemReadOptions): Promise<ClientItemContent | null>;
    /** Newest page of the canonical conversation first; older pages via nextCursor. */
    readHistory(sessionId: string, options?: ClientHistoryReadOptions): Promise<ClientHistoryPage>;
    /** Full body behind one oversized history entry, chunked like readItem. */
    readHistoryEntry(sessionId: string, itemId: string, options?: ClientItemReadOptions): Promise<ClientItemContent | null>;
    /** Search the whole Session history; entryIndex values are stable within the returned revision. */
    searchHistory(sessionId: string, input: ClientHistorySearchInput): Promise<ClientHistorySearchResult>;
    /** Persistent session goal owned by the Host; every client reads the same state. */
    readGoal(sessionId: string): Promise<ClientSessionGoal | null>;
    /** Create a goal; conflicts while a non-complete goal is active. Budget rules are the domain's. */
    createGoal(sessionId: string, input: ClientGoalCreateInput): Promise<ClientSessionGoal>;
    /** Pause an active goal; conflicts from any other status. */
    pauseGoal(sessionId: string): Promise<ClientSessionGoal>;
    /** Resume a paused goal; conflicts from any other status. */
    resumeGoal(sessionId: string): Promise<ClientSessionGoal>;
    /** Clear the current goal; conflicts when no goal exists. */
    clearGoal(sessionId: string): Promise<void>;
    /** Host-owned notice append; UIs never write lineage or session files directly. */
    appendNotice(sessionId: string, input: { readonly content: string; readonly source?: string }): Promise<void>;
    /** Branch structure owned by the Host; both clients see the same head. Null when the session predates lineage. */
    readLineage(sessionId: string): Promise<ClientLineageSummary | null>;
    /** Label (or unlabel when `label` is omitted) one entry by id or existing label; unknown selectors conflict. */
    labelEntry(sessionId: string, input: ClientLineageLabelInput): Promise<ClientLineageSummary>;
    /** Move the active head to an entry by id or label; stale selectors conflict, never silently no-op. */
    selectBranch(sessionId: string, selector: string, options?: { readonly summarizeCurrentBranch?: boolean }): Promise<ClientSession>;
    /** Move the head back to an entry; idle sessions only, and file effects are never rolled back. */
    rewindSession(sessionId: string, input: { readonly selector?: string; readonly expectedHead: string | null }): Promise<ClientSession>;
    /** Derive a new Session from this idle session's history; the source stays unchanged. */
    forkSession(sessionId: string, input?: ClientSessionForkInput): Promise<ClientSession>;
    /** Derive a new Session from a deterministic recovery seed (no LLM call); continue with a normal input submit. */
    recoverSession(sessionId: string, input?: ClientSessionRecoverInput): Promise<ClientSession>;
  };
  readonly inputs: {
    submit(input: ClientSubmitInput): Promise<ClientInputAcceptance>;
    read(sessionId: string, inputId: string): Promise<ClientInputAcceptance | null>;
    withdraw(sessionId: string, inputId: string): Promise<ClientSubmitInput>;
  };
  readonly runs: {
    /** Explicit tool execution through the Host's ordinary tool gates, without a model prompt. */
    startTool(input: ClientToolInvocationInput): Promise<{ readonly runId: string; readonly sessionId: string }>;
    /** Current lifecycle facts of one Run; internal stages stay internal. */
    read(runId: string): Promise<ClientRunStatus>;
    /** Request a stop; accepted only means the durable Stop request was created. */
    stop(runId: string): Promise<ClientRunStopReceipt>;
    /** Resolve at a terminal phase; `unknown` means the outcome could not be confirmed, never success. */
    await(runId: string): Promise<ClientRunOutcome>;
  };
  /**
   * FEATURE_298 T22 — Host-owned workflow control. `start` takes a declarative
   * source (validated/resolved inside the Host, never a prepared module), so
   * every client of the same Host observes and controls the same work.
   */
  readonly workflows: {
    start(input: ClientWorkflowStartInput): Promise<ClientWorkflowStartResult>;
    list(filter?: { readonly runId?: string; readonly limit?: number }): Promise<readonly ClientWorkflowRun[]>;
    get(runId: string): Promise<ClientWorkflowProcess | undefined>;
    /** Existing Host process events; subscriptions carry facts, never executable workflow modules. */
    subscribe(filter: { readonly runId?: string }, listener: (event: ClientWorkflowEvent) => void): { close(): void };
    pause(runId: string): Promise<boolean>;
    resume(runId: string): Promise<boolean>;
    stop(runId: string, options?: { readonly sessionId: string }): Promise<boolean>;
  };
  readonly interactions: {
    /** Answers the Host is currently waiting for. */
    list(filter?: { readonly sessionId?: string }): Promise<readonly ClientInteraction[]>;
    /** Precise request ID + typed response; only the first valid answer counts. */
    respond(requestId: string, response: ClientInteractionResponse): Promise<ClientInteractionResult>;
  };
  readonly permissions: {
    /** Effective explicit grants; every client sees the same revision. */
    listGrants(): Promise<ClientPermissionGrants>;
    /** Revoke exactly one grant by its domain identity; the revision must match. */
    revokeGrant(grantId: string, expectedRevision: number): Promise<boolean>;
  };
  /**
   * FEATURE_298 T30 — Host-owned external Agent registry. Mutations use the
   * registry's own domain identity (configuration revision CAS, management
   * ownership), never a generic operation envelope.
   */
  readonly registrations: {
    list(): Promise<readonly ExternalAgentRegistrationSummary[]>;
    upsert(registration: ExternalAgentRegistration, options?: AgentRegistrationMutationOptions): Promise<ExternalAgentRegistrationSummary>;
    setEnabled(agentId: string, enabled: boolean, options?: AgentRegistrationEnabledMutationOptions): Promise<ExternalAgentRegistrationSummary | undefined>;
    remove(agentId: string, options?: AgentRegistrationMutationOptions): Promise<boolean>;
  };
  /**
   * FEATURE_298 T30 — collaboration control over the Host's Session Actors.
   * Reads return the actual domain objects; `wait` resolves one Agent event.
   */
  readonly agents: {
    reviewLean(input: Omit<ClientReviewInput, 'args'>): Promise<ClientCommandResult>;
    tree(sessionId: string): Promise<AgentTreeSnapshot>;
    detail(sessionId: string, actorPath: string): Promise<AgentDetail>;
    spawn(sessionId: string, input: AgentSpawnInput): Promise<AgentTurnRef>;
    send(sessionId: string, actorPath: string, content: string, classification?: AgentDataClassification): Promise<void>;
    followup(sessionId: string, actorPath: string, objective: string, options?: { readonly expectedRevision?: number }): Promise<AgentFollowupResult>;
    interrupt(sessionId: string, actorPath: string, reason?: string): Promise<void>;
    output(sessionId: string, actorPath: string, turnId?: string): Promise<AgentOutput>;
    wait(sessionId: string, afterSequence?: number, timeoutMs?: number, options?: { readonly signal?: AbortSignal }): Promise<AgentEvent | undefined>;
  };
  readonly config: {
    /** Saved user defaults. Session overrides remain independent. */
    read(): Promise<ClientConfig>;
    patch(patch: Partial<ClientConfig>): Promise<ClientConfig>;
    reload(): Promise<{ readonly ok: true; readonly config: ClientConfig }>;
  };
  readonly catalog: {
    extensions(): Promise<{
      readonly active: boolean;
      readonly extensions: readonly ClientLoadedExtension[];
      readonly diagnostics?: ClientExtensionDiagnostics;
    }>;
    providers(): Promise<readonly ClientProviderInfo[]>;
    models(filter?: { readonly provider?: string }): Promise<readonly ClientModelCatalog[]>;
    reasoningEfforts(input: ClientModelSelection): Promise<readonly string[]>;
    /** Explicitly sends minimal Provider requests; never runs during connect or discovery. */
    probeReasoningEfforts(input: ClientModelSelection & { readonly efforts: readonly string[] }): Promise<readonly ClientCapabilityProbeResult[]>;
    forgetCapabilities(input?: { readonly provider?: string; readonly model?: string }): Promise<void>;
    /**
     * Slash commands visible for a workspace. `source` is where the Host
     * resolved the command from — one of the registry origins ("builtin",
     * "user", "project", "learned", "extension") — reported as a string so
     * the contract stays forward-compatible with new origins.
     */
    commands(workspaceRoot: string): Promise<readonly ClientCommandInfo[]>;
    /**
     * Skills the Host can invoke. `source` uses the same registry-origin
     * vocabulary as `commands`; see {@link ClientSkillInfo}.
     */
    skills(input?: { readonly userInvocableOnly?: boolean }): Promise<readonly ClientSkillInfo[]>;
  };
  readonly mcp: {
    /** Current Host diagnostics; never connects or refreshes a server. */
    status(): Promise<readonly ClientMcpServerStatus[]>;
    listServers(): Promise<Readonly<Record<string, ClientMcpServerConfig>>>;
    getServer(name: string): Promise<ClientMcpServerConfig | undefined>;
    validateServer(name: string, config: unknown): Promise<{ readonly ok: true; readonly config: ClientMcpServerConfig } | { readonly ok: false; readonly error: string }>;
    upsertServer(name: string, config: ClientMcpServerConfig): Promise<ClientMcpServerConfig>;
    deleteServer(name: string): Promise<boolean>;
    reloadServers(): Promise<{ readonly ok: true; readonly servers: readonly ClientMcpServerStatus[] }>;
    listTools(filter?: { readonly server?: string; readonly forceRefresh?: boolean }): Promise<readonly { readonly serverId: string; readonly tools: readonly ClientMcpTool[]; readonly cachedAt?: string }[]>;
  };
  /** Release this connection. The Host and its work retain their own lifetime. */
  disconnect(): Promise<void>;
}

export interface ClientObservation {
  close(): void;
}

export type ClientObservationStatus =
  | { readonly state: 'live' }
  | { readonly state: 'interrupted'; readonly message?: string }
  | { readonly state: 'closed'; readonly reason: 'client' | 'unavailable'; readonly message?: string };

export interface ClientObserveOptions {
  /** Live is emitted only after delivery of a complete current view. */
  readonly onStatus?: (status: ClientObservationStatus) => void;
}

export interface ClientModelSelection {
  readonly provider: string;
  readonly model?: string;
}

export interface ClientModelCatalog {
  readonly provider: string;
  readonly models: readonly string[];
}

/** `source`: registry origin — "builtin" | "user" | "project" | "learned" | "extension". */
export interface ClientCommandInfo {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly description: string;
  /** Where the Host discovered the command (builtin/project/extension/...). */
  readonly source: string;
  readonly userInvocable?: boolean;
}

/** `source`: same registry-origin vocabulary as ClientCommandInfo. */
export interface ClientSkillInfo {
  readonly name: string;
  readonly description: string;
  readonly userInvocable: boolean;
  readonly path: string;
  /** Where the Host discovered the Skill (builtin/user/project/...). */
  readonly source: string;
}

export interface ClientProviderInfo {
  readonly name: string;
  readonly model: string;
  readonly models: readonly string[];
  readonly configured: boolean;
  readonly source: 'builtin' | 'config' | 'runtime';
  readonly reasoningCapability: string;
  readonly capabilityProfile: {
    readonly transport: 'native-api' | 'cli-bridge';
    readonly conversationSemantics: 'full-history' | 'last-user-message';
    readonly mcpSupport: 'native' | 'none';
    readonly contextFidelity?: 'full' | 'partial' | 'lossy';
    readonly toolCallingFidelity?: 'full' | 'limited' | 'none';
    readonly sessionSupport?: 'full' | 'limited' | 'stateless';
    readonly longRunningSupport?: 'full' | 'limited' | 'none';
    readonly multimodalSupport?: 'none' | 'image-input' | 'full';
    readonly evidenceSupport?: 'full' | 'limited' | 'none';
  };
}

export interface ClientMcpTool {
  readonly id: string;
  readonly serverId: string;
  readonly name: string;
  readonly title?: string;
  readonly summary: string;
  readonly cachedAt: string;
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
  readonly annotations?: Readonly<Record<string, unknown>>;
  readonly risk?: 'read' | 'write' | 'network' | 'exec';
  readonly taskSupport?: 'forbidden' | 'optional' | 'required';
}

export interface ClientCapabilityProbeResult {
  readonly effort: string;
  readonly status: 'accepted' | 'rejected' | 'error';
  readonly error?: string;
}

export interface ClientItemReadOptions {
  readonly offset?: number;
  readonly part?: 'text' | 'input';
}

/** Paging over a Session's canonical conversation history. */
export interface ClientHistoryReadOptions {
  /** Cursor from a previous page's nextCursor; omit to read the newest page. */
  readonly cursor?: string;
  readonly limit?: number;
}

export interface ClientHistoryPage {
  /** This page's entries projected like view items, oldest first. */
  readonly items: readonly ClientViewItem[];
  /** Conversation revision this page was read at. */
  readonly revision: string;
  /** Cursor of the next older page; absent when this is the oldest page. */
  readonly nextCursor?: string;
  /**
   * Entries too large to inline as items. Read the full body by itemId with
   * readHistoryEntry; the page never substitutes a truncated preview.
   */
  readonly oversized: readonly { readonly itemId: string; readonly byteLength: number }[];
}

export interface ClientHistorySearchInput {
  readonly query: string;
  readonly limit?: number;
  readonly role?: 'user' | 'assistant';
  /** 'all' (default) searches active and compacted history; 'compacted' only the compacted tail. */
  readonly scope?: 'all' | 'compacted';
}

/** The domain's persistent goal state, written only by Host commands. */
export type ClientSessionGoal = KodaXGoalState;

export interface ClientGoalCreateInput {
  readonly objective: string;
  /** Optional hard token ceiling; the domain validates positive integers. */
  readonly tokenBudget?: number;
}

/** Metadata view of one lineage entry; message content stays out of shape. */
export interface ClientLineageEntry {
  readonly id: string;
  readonly parentId: string | null;
  readonly type: KodaXSessionEntry['type'];
  readonly timestamp: string;
  /** Present on label entries: the labeled target entry. */
  readonly targetId?: string;
  /** Present on label entries; absent means the label was removed. */
  readonly label?: string;
  /** Present on rewind markers: how many entries left the active branch. */
  readonly truncatedCount?: number;
}

export interface ClientLineageSummary {
  readonly activeEntryId: string | null;
  readonly entries: readonly ClientLineageEntry[];
}

export interface ClientLineageLabelInput {
  /** Entry id or an existing label name. */
  readonly selector: string;
  /** Omit to remove the target's label. */
  readonly label?: string;
}

export interface ClientSessionForkInput {
  /** Entry id or label naming the boundary; defaults to the active head. */
  readonly selector?: string;
  /** Explicit conversation-history boundary; stale revisions surface as resync_required. */
  readonly historyBoundary?: {
    readonly entryId: string;
    readonly sourceRevision: string;
  };
  readonly title?: string;
}

export interface ClientSessionRecoverInput {
  readonly title?: string;
  /** Free-form reason recorded in the seed header. */
  readonly reason?: string;
}

export interface ClientHistorySearchResult {
  readonly revision: string;
  readonly hits: readonly {
    /** Opaque reference readable through readHistoryEntry; expired snapshots require a new search. */
    readonly itemId: string;
    /** Stable within this revision; indexes the transcript at that revision. */
    readonly entryIndex: number;
    readonly role: 'user' | 'assistant';
    readonly timestamp?: string;
    readonly snippet: string;
  }[];
}

export interface ClientItemContent {
  readonly id: string;
  readonly text: string;
  readonly offset: number;
  readonly totalLength: number;
  readonly nextOffset?: number;
}

export interface ClientSessionView {
  /** Effective configuration for the current parent selection; not a physical request receipt. */
  readonly contextBudget?: ClientContextBudget;
  /** Host estimate of the saved parent context, available without a live Run. */
  readonly parentContextTokens?: number;
  readonly activity?: ClientSessionActivity;
  readonly queue: readonly ClientQueuedInput[];
  readonly session: ClientSession;
  readonly items: readonly ClientViewItem[];
  /** Effective Host profile values plus Session overrides; getSettings/updateSettings retain raw overrides. */
  readonly settings: ClientSessionSettings;
  /** Pending answers in this Session; all observers see the same identities. */
  readonly interactions: readonly ClientInteraction[];
  readonly runs: readonly {
    readonly runId: string;
    readonly phase: string;
    readonly provider: string;
    readonly model?: string;
    readonly error?: string;
  }[];
}

export interface ClientContextBudget {
  readonly scope: 'parent' | 'worker';
  readonly provider: string;
  readonly model: string;
  readonly contextWindow: number;
  readonly reservedResponseTokens: number;
  readonly reservedMemoryTokens?: number;
  readonly contextId?: string;
  readonly compaction: {
    readonly enabled: true;
    readonly triggerPercent: number;
    readonly absoluteTriggerTokens?: number;
    /** Present only when execution has supplied its Memory and provider-envelope capacity. */
    readonly triggerTokens?: number;
    readonly physicalCapacityTokens?: number;
  };
}

/** Display facts for the latest Run; worker context is distinct from parent context. */
export interface ClientSessionActivity {
  readonly workflow?: ClientWorkflowProcess;
  /** Latest execution budget, whose model and scope may differ from the current Session selection. */
  readonly contextBudget?: ClientContextBudget;
  readonly runId: string;
  readonly costReport?: string;
  readonly children?: readonly {
    readonly id: string; readonly label: string; readonly source: 'workflow' | 'normal';
    readonly kind: 'assistant' | 'thinking' | 'tool' | 'progress' | 'prompt' | 'stream';
    readonly detail: string; readonly status: 'running' | 'completed'; readonly startedAt: number;
  }[];
  readonly managedTask?: {
    readonly childFanoutClass?: 'finding-validation' | 'module-triage' | 'evidence-scan' | 'hypothesis-check';
    readonly harnessProfile?: string;
    readonly globalWorkBudget?: number; readonly budgetUsage?: number; readonly budgetApprovalRequired?: boolean;
    readonly phase?: string; readonly workerId?: string; readonly workerTitle?: string;
    readonly breadcrumb?: string; readonly expandedBreadcrumb?: string;
    readonly round?: number; readonly maximumRounds?: number; readonly idleWaiting: boolean;
    readonly pendingChildren?: number; readonly fanoutCount?: number;
  };
  readonly compacting?: boolean;
  readonly iteration?: { readonly current: number; readonly maximum: number };
  readonly context?: { readonly tokenCount: number; readonly tokenSource: 'api' | 'estimate'; readonly scope: 'parent' | 'worker' };
  /** Latest root iteration/compaction fact; child events never overwrite it. */
  readonly parentContextTokens?: number;
  readonly usage?: {
    readonly inputTokens: number; readonly outputTokens: number; readonly totalTokens: number;
    readonly cacheReadTokens?: number; readonly cacheWriteTokens?: number; readonly thoughtTokens?: number;
  };
  readonly todos?: readonly {
    readonly id: string; readonly subject: string; readonly status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped' | 'cancelled';
    readonly description?: string; readonly owner?: string; readonly note?: string; readonly activeForm?: string;
  }[];
}

export interface ClientViewItem {
  /** Host recovery metadata; clients render the supplied item order. */
  readonly afterInputId?: string;
  readonly id: string;
  /** Accepted input identity of a canonical user message; absent on legacy history. */
  readonly inputId?: string;
  readonly type: 'user' | 'assistant' | 'thinking' | 'info' | 'error' | 'event' | 'hint' | 'sidecar' | 'system' | 'tool';
  readonly text: string;
  /** Present when text is a bounded suffix; readItem retains the complete original. */
  readonly textOffset?: number;
  readonly totalTextLength?: number;
  readonly timestamp?: number;
  readonly icon?: string;
  readonly compactText?: string;
  readonly tool?: {
    readonly callId: string;
    readonly name: string;
    readonly status: 'running' | 'success' | 'error' | 'cancelled' | 'awaiting_approval';
    readonly inputText?: string;
    readonly totalInputLength?: number;
    readonly progress?: string;
    readonly startedAt?: number;
    readonly endedAt?: number;
  };
}

export interface ClientCreateSessionInput {
  readonly mcpServers?: Readonly<Record<string, ClientMcpServerConfig>>;
  /** Delete this Session when its task ends, including after the client detaches. */
  readonly temporary?: boolean;
  readonly sessionId?: string;
  readonly title?: string;
  readonly projectPath?: string;
  readonly gitRoot?: string;
  readonly surface?: string;
  readonly profileId?: string;
  readonly tag?: string;
}

export interface ClientSubmitInput {
  /** 'steer' and 'redirect' additionally require targetRunId. */
  readonly delivery?: 'immediate' | 'after_turn' | 'steer' | 'redirect';
  readonly sessionId: string;
  readonly inputId: string;
  readonly text: string;
  /** The only Run a 'steer' or 'redirect' delivery may act on. */
  readonly targetRunId?: string;
  /**
   * Image/file/video references anchored by the prompt (@path syntax,
   * clipboard, drag-drop). Part of the input's intent: resubmitting the same
   * inputId with a different artifact set is a conflict.
   */
  readonly inputArtifacts?: readonly KodaXInputArtifact[];
}

/** Identity of an accepted input in the current Host, not a completion receipt. */
export interface ClientInputAcceptance {
  /**
   * 'submitted' is saved in the conversation context (does not prove the
   * Provider received it); 'queued' waits for its slot; 'withdrawn' was
   * taken back by the user; 'dropped' means the target Run settled before
   * delivery — the text never entered the context, so resubmit with a new ID.
   */
  readonly state: 'submitted' | 'queued' | 'withdrawn' | 'dropped';
  readonly sessionId: string;
  readonly inputId: string;
  readonly runId?: string;
}

export interface ClientQueuedInput {
  readonly inputId: string;
  /** Bounded display preview; withdraw returns the complete original text. */
  readonly text: string;
  readonly enqueuedAt: number;
}

/** User-explainable lifecycle facts; accepting a Stop never implies them. */
export interface ClientRunStatus {
  readonly runId: string;
  readonly sessionId: string;
  readonly phase: string;
  readonly startedAt?: string;
  readonly error?: string;
  readonly stop?: {
    readonly requestedAt: string;
    readonly state: string;
    readonly outcome: string;
    readonly reason: string;
    readonly resolvedAt?: string;
  };
}

/** Stop acceptance is distinct from the Run's real terminal outcome. */
export interface ClientRunStopReceipt {
  readonly runId: string;
  readonly sessionId: string;
  /** True only when this call durably created the Stop request. */
  readonly accepted: boolean;
  readonly state: string;
  readonly outcome: string;
  readonly phase: string;
}

export interface ClientSessionSettingsSnapshot {
  readonly revision: number;
  readonly value: ClientSessionSettings;
}

export interface ClientSessionCancelInput {
  readonly sessionId: string;
  readonly expectedRunId: string;
  readonly requestId: string;
}

export interface ClientSessionCancelReceipt extends ClientSessionCancelInput {
  readonly frontier: number;
  readonly receipts: readonly ClientRunStopReceipt[];
}

export interface ClientToolInvocationInput {
  readonly sessionId: string;
  readonly inputId: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
  readonly rawInput: string;
}

/**
 * Terminal facts of one Run. `result` is present only for settled runs the
 * Host could observe; `phase: 'unknown'` means settlement could not be
 * confirmed, even on a healthy connection. Preserve error; transport failures
 * reject separately. Unknown is never success or cancellation.
 */
export interface ClientRunOutcome {
  readonly runId: string;
  readonly sessionId: string;
  readonly phase: string;
  readonly result?: KodaXResult;
  readonly error?: string;
}

/** Facts of one concrete operation awaiting an approval decision. */
export interface ClientPermissionInteractionOptions {
  /** Complete finalized plan for exit_plan_mode approval; never a truncated input preview. */
  readonly plan?: string;
  readonly toolName: string;
  readonly toolCallId?: string;
  readonly reason?: string;
  readonly risk?: 'low' | 'medium' | 'high';
  readonly inputPreview?: string;
  readonly executionCwd?: string;
  /** Opaque pending-request-local ids; return one unchanged to widen a decision. */
  readonly grantSuggestions?: readonly {
    readonly id: string;
    readonly kind: 'session' | 'persistent';
    readonly label: string;
  }[];
}

/**
 * One pending answer the Host is waiting for. `kind` selects both the typed
 * payload and the typed response this request accepts.
 */
export type ClientInteraction =
  | ClientInteractionBase & { readonly kind: 'question'; readonly options: AskUserQuestionOptions; readonly expiresAt: string }
  | ClientInteractionBase & { readonly kind: 'question_multi'; readonly options: AskUserMultiOptions; readonly expiresAt: string }
  | ClientInteractionBase & { readonly kind: 'question_input'; readonly options: { readonly question: string; readonly default?: string }; readonly expiresAt: string }
  | ClientInteractionBase & { readonly kind: 'permission'; readonly options: ClientPermissionInteractionOptions; readonly expiresAt?: string };

interface ClientInteractionBase {
  readonly requestId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly createdAt: string;
}

/** Typed answer for one pending interaction; kinds must match the request. */
export type ClientInteractionResponse =
  | { readonly kind: 'question'; readonly answer: AskUserAnswer }
  | { readonly kind: 'question_multi'; readonly answers: Readonly<Record<string, AskUserAnswer>> }
  | { readonly kind: 'question_input'; readonly text: string }
  | { readonly kind: 'permission'; readonly decision: ClientPermissionDecision }
  | { readonly kind: 'cancel'; readonly reason?: string };

export type ClientPermissionDecision =
  | { readonly type: 'allow_once' }
  | { readonly type: 'allow_session'; readonly suggestionId: string }
  | { readonly type: 'allow_always'; readonly suggestionId: string }
  | { readonly type: 'reject'; readonly reason?: string };

/** First valid answer wins; every other case is explicitly not accepted. */
export interface ClientInteractionResult {
  readonly requestId: string;
  readonly accepted: boolean;
  /** 'already_resolved' covers late, duplicate, cancelled, expired and unknown targets. */
  readonly status: 'answered' | 'dismissed' | 'already_resolved';
}

export interface ClientPermissionGrant {
  readonly id: string;
  readonly label?: string;
  readonly persistence?: 'session' | 'persistent';
}

export interface ClientPermissionGrants {
  readonly revision: number;
  readonly grants: readonly ClientPermissionGrant[];
}

export interface ClientSessionSettings {
  readonly repoIntelligenceMode?: 'auto' | 'off' | 'light' | 'full';
  readonly repoIntelligenceTrace?: boolean;
  /** Shared manual/automatic summary policy, independent of main-turn effort. */
  readonly compactionReasoning?: boolean | { readonly effort: string };
  readonly provider?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly thinking?: boolean;
  readonly reasoningMode?: 'off' | 'auto' | 'quick' | 'balanced' | 'deep';
  readonly permissionMode?: 'plan' | 'accept-edits' | 'auto' | 'full-access';
  readonly agentMode?: 'ama' | 'sa' | 'amaw';
  readonly autoModeClassifierModel?: string;
  readonly compactionTriggerPercent?: number;
  readonly compactionTriggerTokens?: number;
  /** Per-run iteration fuse; unset falls back to the engine default. */
  readonly maxIter?: number;
}

export type ClientSessionSettingsPatch = {
  readonly [Key in keyof ClientSessionSettings]?: ClientSessionSettings[Key] | null;
};

export interface ClientConfig {
  readonly provider?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly planModeEffort?: string;
  readonly thinking?: boolean;
  readonly reasoningMode?: ClientSessionSettings['reasoningMode'];
  readonly permissionMode?: ClientSessionSettings['permissionMode'];
  readonly agentMode?: ClientSessionSettings['agentMode'];
  readonly locale?: string;
  readonly providerModels?: Record<string, string[]>;
  readonly extensions?: string[];
  readonly fallbackProviders?: string[];
  readonly repoIntelligenceMode?: 'auto' | 'off' | 'light' | 'full';
  readonly repoIntelligenceTrace?: boolean;
  readonly verifierLog?: boolean;
  readonly stallLog?: boolean;
  readonly fastProvider?: string;
  readonly fastModel?: string;
  readonly deepProvider?: string;
  readonly deepModel?: string;
  readonly maxOutputTokens?: number;
  readonly disablePromptCache?: boolean;
  readonly lsp?: boolean;
  readonly lspAutoDownload?: boolean;
  readonly acpLogLevel?: string;
  readonly sessionRetentionDays?: number;
  readonly repoIntelligence?: {
    readonly toolWaitMs?: number;
    readonly workerTimeoutMs?: number;
    readonly workerOldSpaceMb?: number;
    readonly storageDir?: string;
  };
  readonly workflow?: { readonly maxConcurrency?: number };
}

/** MCP configuration only; executable connections and callbacks stay in the Host. */
export interface ClientMcpServerConfig {
  readonly type?: 'stdio' | 'sse' | 'streamable-http' | 'http';
  readonly command?: string;
  readonly args?: string[];
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly url?: string;
  readonly headers?: Record<string, string>;
  readonly connect?: 'lazy' | 'prewarm' | 'disabled';
  readonly startupTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly auth?: {
    readonly type: 'oauth2';
    readonly clientId?: string;
    readonly authorizationUrl?: string;
    readonly tokenUrl?: string;
    readonly scopes?: readonly string[];
    readonly redirectPort?: number;
  };
}

export interface ClientMcpServerStatus {
  readonly serverId: string;
  readonly config: ClientMcpServerConfig;
  readonly connect: 'lazy' | 'prewarm' | 'disabled';
  readonly status: 'idle' | 'connecting' | 'ready' | 'error' | 'disabled';
  readonly tools: number;
  readonly resources: number;
  readonly prompts: number;
  readonly dirty: boolean;
  readonly resolvedTransport?: string;
  readonly cachedAt?: string;
  readonly lastError?: string;
}

export type ClientWorkflowStartSource =
  | { readonly kind: 'inline'; readonly manifest: unknown; readonly source: string }
  | { readonly kind: 'request'; readonly request: string }
  | { readonly kind: 'name'; readonly name: string };

/**
 * FEATURE_298 T22 — serializable process metadata for a declarative start.
 * Mirrors the run-graph WorkflowRunProcessMetadata the Host attaches to the
 * minted run, so saved/rerun lineage (savedWorkflowName, sourceRunId, …)
 * survives the client→Host boundary.
 */
export interface ClientWorkflowStartMetadata {
  readonly displayName?: string;
  readonly goal?: string;
  readonly source?: 'command' | 'review' | 'sdk' | 'capsule' | 'extension' | 'automation';
  readonly savedWorkflowName?: string;
  readonly sourceRunId?: string;
  readonly sourceWorkflowName?: string;
  readonly revisionOf?: string;
  readonly resumedFromRunId?: string;
  readonly hostMetadata?: Readonly<Record<string, string>>;
}

export interface ClientWorkflowStartInput {
  readonly sessionId?: string;
  readonly projectRoot: string;
  readonly source: ClientWorkflowStartSource;
  readonly args?: unknown;
  readonly provider?: string;
  readonly model?: string;
  readonly metadata?: ClientWorkflowStartMetadata;
}

export type ClientWorkflowStartResult =
  | { readonly kind: 'declined'; readonly reason: string }
  | { readonly kind: 'started'; readonly runId: string };

export type ClientWorkflowProcess = import('@kodax-ai/agent').WorkflowProcessSnapshot;
export type ClientWorkflowEvent = import('@kodax-ai/agent').WorkflowProcessEvent;

export interface ClientWorkflowRun {
  readonly runId: string;
  readonly workflowName: string;
  readonly status: import('@kodax-ai/agent').ManagedWorkflowStatus;
  readonly totalSpawned: number;
  readonly eventCount: number;
  readonly runDir: string;
  readonly endedAt?: string;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly displayName?: string;
  readonly resultSummary?: string;
  readonly error?: string;
}

/** Read-only Auto review facts; changing permissions still uses Session settings. */
export interface ClientAutoModeStats {
  readonly classifierHealth: 'healthy' | 'degraded';
  readonly classifierModel?: string;
  readonly denials: import('./guardrails/auto-mode/denial-tracker.js').DenialTracker;
  readonly breaker: import('./guardrails/auto-mode/circuit-breaker.js').CircuitBreaker;
}
