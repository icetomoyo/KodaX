/** Product data shared by SDK clients and UIs; independent of Host implementation. */
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
  readonly host: {
    /** Request an idle Host to shut down. Acceptance does not prove cleanup has completed. */
    shutdown(): Promise<{ readonly accepted: true }>;
  };
  readonly sessions: {
    create(input?: ClientCreateSessionInput): Promise<ClientSession>;
    list(filter?: ClientSessionFilter): Promise<readonly ClientSessionSummary[]>;
    read(sessionId: string): Promise<ClientSession>;
    delete(sessionId: string): Promise<void>;
    archive(sessionId: string): Promise<void>;
    unarchive(sessionId: string): Promise<void>;
    getSettings(sessionId: string): Promise<ClientSessionSettings>;
    /** Change this Session only. The next physical request uses the updated selection. */
    updateSettings(sessionId: string, patch: ClientSessionSettingsPatch): Promise<ClientSessionSettings>;
    /** Delivers the current view first, then replacements; no event cursor is needed. */
    observe(sessionId: string, onView: (view: ClientSessionView) => void): Promise<ClientObservation>;
    /** Read the original content behind a bounded display item. Offsets are UTF-16 characters. */
    readItem(sessionId: string, itemId: string, options?: ClientItemReadOptions): Promise<ClientItemContent | null>;
  };
  readonly inputs: {
    submit(input: ClientSubmitInput): Promise<ClientInputAcceptance>;
    read(sessionId: string, inputId: string): Promise<ClientInputAcceptance | null>;
    withdraw(sessionId: string, inputId: string): Promise<ClientSubmitInput>;
  };
  readonly config: {
    /** Saved user defaults. Session overrides remain independent. */
    read(): Promise<ClientConfig>;
    patch(patch: Partial<ClientConfig>): Promise<ClientConfig>;
    reload(): Promise<{ readonly ok: true; readonly config: ClientConfig }>;
  };
  readonly catalog: {
    providers(): Promise<readonly ClientProviderInfo[]>;
    models(filter?: { readonly provider?: string }): Promise<readonly ClientModelCatalog[]>;
    reasoningEfforts(input: ClientModelSelection): Promise<readonly string[]>;
    /** Explicitly sends minimal Provider requests; never runs during connect or discovery. */
    probeReasoningEfforts(input: ClientModelSelection & { readonly efforts: readonly string[] }): Promise<readonly ClientCapabilityProbeResult[]>;
    forgetCapabilities(input?: { readonly provider?: string; readonly model?: string }): Promise<void>;
  };
  readonly mcp: {
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

export interface ClientModelSelection {
  readonly provider: string;
  readonly model?: string;
}

export interface ClientModelCatalog {
  readonly provider: string;
  readonly models: readonly string[];
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

export interface ClientItemContent {
  readonly id: string;
  readonly text: string;
  readonly offset: number;
  readonly totalLength: number;
  readonly nextOffset?: number;
}

export interface ClientSessionView {
  readonly activity?: ClientSessionActivity;
  readonly queue: readonly ClientQueuedInput[];
  readonly session: ClientSession;
  readonly items: readonly ClientViewItem[];
  readonly settings: ClientSessionSettings;
  readonly runs: readonly {
    readonly runId: string;
    readonly phase: string;
    readonly provider: string;
    readonly model?: string;
    readonly error?: string;
  }[];
}

/** Display facts for the latest Run; worker context is distinct from parent context. */
export interface ClientSessionActivity {
  readonly runId: string;
  readonly costReport?: string;
  readonly children?: readonly {
    readonly id: string; readonly label: string; readonly source: 'workflow' | 'normal';
    readonly kind: 'assistant' | 'thinking' | 'tool' | 'progress' | 'prompt' | 'stream';
    readonly detail: string; readonly status: 'running' | 'completed'; readonly startedAt: number;
  }[];
  readonly managedTask?: {
    readonly phase?: string; readonly workerId?: string; readonly workerTitle?: string;
    readonly breadcrumb?: string; readonly expandedBreadcrumb?: string;
    readonly round?: number; readonly maximumRounds?: number; readonly idleWaiting: boolean;
    readonly pendingChildren?: number; readonly fanoutCount?: number;
  };
  readonly compacting?: boolean;
  readonly iteration?: { readonly current: number; readonly maximum: number };
  readonly context?: { readonly tokenCount: number; readonly tokenSource: 'api' | 'estimate'; readonly scope: 'parent' | 'worker' };
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
  readonly id: string;
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

export interface ClientSessionSettings {
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
