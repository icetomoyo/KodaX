/**
 * Command system type definitions.
 */

import type {
  KodaXSessionLineage,
  WorkflowProcessSource,
} from '@kodax-ai/agent';
import type {
  AgentsFile,
  KodaXAgentMode,
  KodaXRepoIntelligenceMode,
  KodaXOptions,
  KodaXReasoningMode,
  KodaXSkillInvocationContext,
} from '@kodax-ai/coding';
import type * as readline from 'readline';
import type { InteractiveContext } from '../interactive/context.js';
import type { PermissionMode } from '../permission/types.js';
import type { UIContext } from '../ui/context.js';
import type { LearningBinding, LearningSurfaceSnapshot } from '../ui/types.js';

export type CommandSource = 'builtin' | 'extension' | 'skill' | 'prompt';

export type CommandPriority = 'critical' | 'high' | 'medium' | 'low';

export interface CommandHook {
  matcher?: string;
  command: string;
}

export interface CommandHooks {
  SessionStart?: CommandHook[];
  UserPromptSubmit?: CommandHook[];
  PreToolUse?: CommandHook[];
  PostToolUse?: CommandHook[];
  Stop?: CommandHook[];
  SubagentStop?: CommandHook[];
  Notification?: CommandHook[];
}

export interface CommandExecutionMetadata {
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
  allowedTools?: string;
  context?: 'fork';
  agent?: string;
  argumentHint?: string;
  model?: string;
  hooks?: CommandHooks;
  frontmatter?: Record<string, unknown>;
}

export interface CurrentConfig {
  provider: string;
  model?: string;
  effort?: string;
  effortOverride?: boolean;
  planModeEffort?: string;
  thinking: boolean;
  reasoningMode: KodaXReasoningMode;
  agentMode: KodaXAgentMode;
  permissionMode: PermissionMode;
  repoIntelligenceMode?: KodaXRepoIntelligenceMode;
  repoIntelligenceTrace?: boolean;
  /** FEATURE_102 Phase 3 — cross-provider child fallback chain. */
  fallbackProviders?: string[];
}

export type RuntimeSurfaceMode = 'embedded' | 'daemon';

export interface RuntimeSurfaceStatus {
  readonly mode: RuntimeSurfaceMode;
  readonly runtimeId: string;
  readonly profile: string;
  readonly startedAt?: string;
  readonly endpoint?: string;
  readonly health?: string;
  readonly sessions?: number;
  readonly runs?: number;
  readonly activeRuns?: number;
  readonly queuedRuns?: number;
  readonly pendingPermissions?: number;
  readonly workflows?: number;
}

export type SessionLoadStatus = 'loaded' | 'missing' | 'blocked';
export type SessionBranchSwitchStatus = 'switched' | 'missing' | 'blocked';
export type SessionForkStatus = 'forked' | 'failed' | 'blocked';
export type SessionRewindStatus = 'rewound' | 'failed' | 'blocked';
export type SessionRecoverStatus = 'recovered' | 'empty' | 'failed' | 'blocked';

/**
 * FEATURE_298 T34 — goal persistence is Host-owned: the command plane
 * sends the session id and objective; lineage mutation and journal
 * writes happen inside the Host. Unbound REPLs keep the local
 * appendGoalEntry + saveSession path (standalone capability).
 */
export interface SessionGoalBinding {
  read(sessionId: string): Promise<import('@kodax-ai/agent').KodaXGoalState | null>;
  create(input: {
    readonly sessionId: string;
    readonly objective: string;
    readonly tokenBudget?: number;
  }): Promise<import('@kodax-ai/agent').KodaXGoalState>;
  pause(sessionId: string): Promise<import('@kodax-ai/agent').KodaXGoalState>;
  resume(sessionId: string): Promise<import('@kodax-ai/agent').KodaXGoalState>;
  clear(sessionId: string): Promise<void>;
}

/**
 * FEATURE_298 T34 — session-command mutations are Host-owned: the surface
 * sends ids/selectors only and re-reads the session file the Host wrote;
 * unbound REPLs keep the direct SessionStorage paths (standalone).
 */
export interface SessionCommandBinding {
  delete(sessionId: string): Promise<void>;
  deleteAll(input: { readonly gitRoot?: string }): Promise<void>;
  /** Returns false when no lineage entry matches the selector. */
  setActiveEntry(input: {
    readonly sessionId: string;
    readonly selector: string;
    readonly summarizeCurrentBranch?: boolean;
  }): Promise<boolean>;
  /** Returns false when no lineage entry matches the selector. */
  setLabel(input: {
    readonly sessionId: string;
    readonly selector: string;
    readonly label?: string;
  }): Promise<boolean>;
  /** Returns the new session id, or undefined when the fork failed. */
  fork(input: {
    readonly sessionId: string;
    readonly selector?: string;
  }): Promise<string | undefined>;
  /** Returns false when the rewind failed. */
  rewind(input: {
    readonly sessionId: string;
    readonly selector?: string;
  }): Promise<boolean>;
  /** Recovers into a fresh Host-derived seed session; returns its id. */
  recover(input: {
    readonly sessionId: string;
    readonly reason?: string;
  }): Promise<string | undefined>;
  create(input: {
    readonly sessionId: string;
    readonly title: string;
    readonly gitRoot?: string;
    readonly surface: string;
  }): Promise<void>;
}

/**
 * FEATURE_298 T34 — manual compaction is a Host session command: the Host
 * replays its journal through the compaction domain and persists the
 * result; the REPL only refreshes its display context.
 */
export interface SessionCompactBinding {
  compact(input: {
    readonly sessionId: string;
    readonly customInstructions?: string;
  }): Promise<{
    readonly compacted: boolean;
    readonly tokensBefore: number;
    readonly tokensAfter: number;
    readonly messages: readonly import('@kodax-ai/agent').KodaXMessage[];
    readonly reason?: string;
  }>;
}

export interface CommandCallbacks {
  exit: () => void | Promise<void>;
  saveSession: () => Promise<void>;
  /** FEATURE_298 T34 — Host-owned goal plane; unbound keeps the local lineage path. */
  readonly goal?: SessionGoalBinding;
  /**
   * FEATURE_298 T34 — after a bound session mutation, re-read the lineage
   * the Host just wrote so local display and the embedded goal runtime
   * stay coherent without a second writer.
   */
  readonly refreshSessionLineage?: () => Promise<KodaXSessionLineage | undefined>;
  /** FEATURE_298 T34 — Host-owned manual compaction; unbound compacts locally. */
  readonly compactSession?: SessionCompactBinding;
  startNewSession?: () => void;
  loadSession: (id: string) => Promise<SessionLoadStatus>;
  listSessions: () => Promise<void>;
  clearHistory: () => void;
  printHistory: () => void;
  switchProvider?: (provider: string, model?: string) => void;
  setEffort?: (effort?: string) => void;
  setReasoningMode?: (mode: KodaXReasoningMode) => void;
  setAgentMode?: (mode: KodaXAgentMode) => void;
  setPermissionMode?: (mode: PermissionMode) => void | Promise<void>;
  setRepoIntelligenceRuntime?: (update: {
    mode?: KodaXRepoIntelligenceMode;
    trace?: boolean;
  }) => void;
  deleteSession?: (id: string) => Promise<void>;
  deleteAllSessions?: () => Promise<void>;
  createKodaXOptions?: () => KodaXOptions;
  /** Opens a path in the host's external editor/file browser. */
  openExternalPath?: (targetPath: string) => Promise<void>;
  reloadAgentsFiles?: () => Promise<AgentsFile[]>;
  confirm?: (message: string) => Promise<boolean>;
  readline?: readline.Interface;
  onWorkflowBuilderEvent?: (event: {
    readonly stage: string;
    readonly message: string;
  }) => void;
  onWorkflowRunMessage?: (event: {
    readonly type: 'info' | 'success' | 'error' | 'event' | 'assistant';
    readonly text: string;
    readonly final?: boolean;
  }) => void;
  onWorkflowRunUpdate?: (event: {
    readonly runId: string;
    readonly workflow: string;
    readonly status: 'running' | 'completed' | 'failed' | 'stopped';
    readonly phase?: string;
    readonly phaseIndex?: number;
    readonly phaseTotal?: number;
    readonly startedAt?: number;
    readonly elapsedMs?: number;
    readonly activeAgents: readonly string[];
    readonly totalSpawned: number;
    readonly plannedAgents?: number;
    readonly agentCap?: number;
    readonly tokenBudgetSpent?: number;
    readonly tokenBudgetTotal?: number;
    readonly completedAgents: number;
    readonly failedAgents: number;
    readonly stoppedAgents: number;
    readonly message?: string;
    readonly locale?: 'en' | 'zh';
  }) => void;
  startCompacting?: () => void;
  stopCompacting?: () => void;
  /**
   * Fired by `/compact` after a successful manual compaction so the UI
   * layer can update its live token count (mirrors the agent-runtime
   * `onCompactStats` for auto-compaction). Without this, the status bar
   * keeps showing the pre-compact `liveTokenCount` because that field
   * outranks `context.contextTokenSnapshot` in the cascade.
   */
  onCompactStats?: (info: { tokensBefore: number; tokensAfter: number }) => void;
  printSessionTree?: () => Promise<void>;
  switchSessionBranch?: (selector: string) => Promise<SessionBranchSwitchStatus>;
  labelSessionBranch?: (selector: string, label?: string) => Promise<boolean>;
  forkSession?: (selector?: string) => Promise<SessionForkStatus>;
  recoverSession?: (prompt?: string) => Promise<SessionRecoverStatus>;
  rewindSession?: (selector?: string) => Promise<SessionRewindStatus>;
  getCostReport?: () => string | null;
  getRuntimeStatus?: () => Promise<RuntimeSurfaceStatus | undefined>;
  /** Canonical host parser used by `/setup` for the root-owned A2A schema. */
  validateSetupA2AConfig?: (value: unknown) => unknown;
  /** Root-owned sandbox activation because ASRT is distributed by the host package. */
  prepareSetupSandbox?: () => Promise<{
    readonly status: 'ready' | 'cancelled' | 'unavailable';
    readonly lines: readonly string[];
  }>;
  /** Explicit read-only `/sandbox` probe. Ordinary startup never calls it. */
  inspectSandbox?: () => Promise<{
    readonly ready: boolean;
    readonly platform: string;
    readonly version: string;
    readonly backend: string;
    readonly diagnostics: readonly string[];
    readonly guidance: readonly string[];
  }>;
  learning?: LearningBinding;
  /**
   * FEATURE_298 T36 — Host-owned Memory management plane for a project
   * root. Absent means Memory controls report unavailable; the UI never
   * builds its own identity/controller.
   */
  memory?: (projectRoot: string) => MemoryCommandPlane;
  /**
   * FEATURE_298 T22 — Host-owned workflow control plane. When present,
   * run/control operations (list/get/pause/resume/stop/start) route to the
   * Host manager so every client of the same Host sees the same work.
   */
  workflows?: WorkflowHostControl;
  /**
   * FEATURE_298 T37 — Host-side trusted Skill preparation. When present,
   * explicit Skill invocations load/expand against the Host's trusted
   * registry (client supplies only name + argument text); absent keeps the
   * local preparation until the fallback removal slice.
   */
  prepareSkillInvocation?: SkillPreparationBinding;
  /**
   * FEATURE_298 T37 — Host-side trusted preparation for discovered prompt
   * commands (markdown frontmatter + content); builtin/skill/extension
   * commands stay client-side.
   */
  prepareCommandInvocation?: CommandPreparationBinding;
  /** FEATURE_298 T37 — Host-side /review preparation (diff + packets). */
  prepareReview?: ReviewPreparationBinding;
  /** FEATURE_298 T37 — Host-side /agents lean prompt preparation. */
  prepareAgentsLean?: (input: {
    readonly projectRoot: string;
  }) => Promise<
    | {
      readonly kind: 'prepared';
      readonly invocation: {
        readonly prompt: string;
        readonly source: 'prompt';
        readonly displayName: string;
      };
    }
    | { readonly kind: 'missing' }
  >;
  getLearningSummary?: () => Promise<LearningSurfaceSnapshot>;
  openLearningCenter?: (nameOrSlug?: string) => Promise<void>;
  /**
   * FEATURE_092 phase 2b.8: read-only stats accessor for the auto-mode
   * classifier guardrail. Returns undefined when the guardrail hasn't been
   * constructed yet (REPL never entered auto mode this session). The
   * returned snapshot is a copy of references — caller cannot mutate
   * guardrail state through it. Used by `/auto-denials` diagnostics.
   */
  getAutoModeStats?: () =>
    | import('@kodax-ai/coding').AutoModeStats
    | undefined
    | Promise<import('@kodax-ai/coding').AutoModeStats | undefined>;
  ui: UIContext;
}

export interface CommandResultData {
  success?: boolean;
  message?: string;
  data?: unknown;
  skillContent?: string;
  invocation?: CommandInvocationRequest;
  workflow?: CommandWorkflowInvocationRequest;
}

export interface CommandInvocationRequest extends CommandExecutionMetadata {
  prompt: string;
  source: 'skill' | 'prompt' | 'extension';
  displayName: string;
  path?: string;
  skillInvocation?: KodaXSkillInvocationContext;
  /** Trusted host marker set only by an explicit Workflow command. */
  workflowIntent?: 'explicit';
}

export interface CommandWorkflowInvocationRequest {
  request: string;
  source: 'command' | 'natural-language';
  displayName: string;
  processSource?: WorkflowProcessSource;
  builtin?: {
    name: string;
    args: unknown;
  };
}

export type CommandResult = boolean | CommandResultData;

export type CommandHandler = (
  args: string[],
  context: InteractiveContext,
  callbacks: CommandCallbacks,
  currentConfig: CurrentConfig
) => Promise<CommandResult | void>;

export interface CommandDefinition {
  name: string;
  aliases?: string[];
  description: string;
  usage?: string;
  detailedHelp?: (args?: readonly string[]) => void;
  handler: CommandHandler;
  source?: CommandSource;
  priority?: CommandPriority;
  location?: 'user' | 'project' | 'path';
  path?: string;
  userInvocable?: boolean;
  disableModelInvocation?: boolean;
  allowedTools?: string;
  context?: 'fork';
  agent?: string;
  argumentHint?: string;
  model?: string;
  hooks?: CommandHooks;
  frontmatter?: Record<string, unknown>;
}

export interface CommandInfo {
  name: string;
  aliases?: string[];
  description: string;
  source: CommandSource;
  usage?: string;
  priority?: CommandPriority;
  location?: 'user' | 'project' | 'path';
  path?: string;
  userInvocable?: boolean;
  disableModelInvocation?: boolean;
  allowedTools?: string;
  context?: 'fork';
  agent?: string;
  argumentHint?: string;
  model?: string;
}

/**
 * Legacy command shape used by the existing REPL command table.
 */
export interface Command {
  name: string;
  aliases?: string[];
  description: string;
  usage?: string;
  handler: CommandHandler;
  detailedHelp?: (args?: readonly string[]) => void;
  source?: CommandSource;
  priority?: CommandPriority;
  location?: 'user' | 'project' | 'path';
  path?: string;
  userInvocable?: boolean;
  disableModelInvocation?: boolean;
  allowedTools?: string;
  context?: 'fork';
  agent?: string;
  argumentHint?: string;
  model?: string;
  hooks?: CommandHooks;
  frontmatter?: Record<string, unknown>;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function deriveArgumentHintFromUsage(usage: string | undefined, name: string): string | undefined {
  if (!usage) {
    return undefined;
  }

  const normalizedUsage = usage.trim();
  if (!normalizedUsage.startsWith('/')) {
    return undefined;
  }

  const prefixPattern = new RegExp(`^/${escapeRegExp(name)}(?:\\s+)?`, 'i');
  const derivedHint = normalizedUsage.replace(prefixPattern, '').trim();
  return derivedHint.length > 0 ? derivedHint : undefined;
}

export function toCommandDefinition(
  cmd: Command,
  source: CommandSource = 'builtin'
): CommandDefinition {
  return {
    ...cmd,
    source: cmd.source ?? source,
    userInvocable: cmd.userInvocable ?? true,
    disableModelInvocation: cmd.disableModelInvocation ?? false,
    argumentHint: cmd.argumentHint ?? deriveArgumentHintFromUsage(cmd.usage, cmd.name),
  };
}

export interface MemoryRebuildResult {
  readonly status: 'missing-dir' | 'no-topics' | 'rebuilt';
  readonly memoryRoot: string;
  readonly entrypointPath: string;
  readonly entryCount: number;
  readonly malformedFiles: readonly string[];
  readonly warnings: readonly string[];
}

export interface MemoryCommandPlane {
  readonly controller: import('@kodax-ai/agent').MemoryManagementController;
  readonly memoryRoot: string;
  readonly entrypointPath: string;
  listReviews(): Promise<readonly import('@kodax-ai/agent').PendingEpisodeReviewSummary[]>;
  reviewerProviderConfigured(): boolean;
  rebuild(): Promise<MemoryRebuildResult>;
  ensureOpenTarget(targetPath: string): Promise<string>;
}

/** FEATURE_298 T37 — Host-prepared explicit Skill invocation projection. */
export interface PreparedSkillInvocation {
  readonly prompt: string;
  readonly source: 'skill';
  readonly displayName: string;
  readonly path?: string;
  readonly disableModelInvocation?: boolean;
  readonly allowedTools?: string;
  readonly context?: 'fork';
  readonly agent?: string;
  readonly argumentHint?: string;
  readonly model?: string;
  readonly hooks?: CommandHooks;
  readonly skillInvocation: import('@kodax-ai/coding').KodaXSkillInvocationContext;
}

/** FEATURE_298 T37 — Host-prepared discovered prompt-command projection. */
export interface PreparedCommandInvocation {
  readonly prompt: string;
  readonly source: 'prompt';
  readonly displayName: string;
  readonly path?: string;
  readonly disableModelInvocation?: boolean;
  readonly userInvocable?: boolean;
  readonly allowedTools?: string;
  readonly context?: 'fork';
  readonly agent?: string;
  readonly argumentHint?: string;
  readonly model?: string;
  readonly hooks?: CommandHooks;
  readonly frontmatter?: Record<string, unknown>;
}

export interface CommandPreparationBinding {
  prepare(input: {
    readonly projectRoot: string;
    readonly name: string;
  }): Promise<
    | { readonly kind: 'prepared'; readonly invocation: PreparedCommandInvocation }
    | { readonly kind: 'local' }
    | { readonly kind: 'unknown' }
  >;
}

/** FEATURE_298 T37 — Host-prepared /review result projection. */
export type PreparedReview =
  | {
    readonly kind: 'prepared';
    readonly invocation: {
      readonly prompt: string;
      readonly source: 'prompt';
      readonly displayName: string;
    };
  }
  | {
    readonly kind: 'workflow';
    readonly workflow: {
      readonly request: string;
      readonly displayName: string;
      readonly builtinName: 'scoped-review';
      readonly builtinArgs: Record<string, unknown>;
    };
  }
  | { readonly kind: 'empty' }
  | { readonly kind: 'error'; readonly message: string };

export interface ReviewPreparationBinding {
  prepare(input: {
    readonly projectRoot: string;
    readonly sessionId: string;
    readonly args: readonly string[];
  }): Promise<PreparedReview>;
}

export interface SkillPreparationBinding {
  prepare(input: {
    readonly projectRoot: string;
    readonly name: string;
    readonly argumentsText?: string;
    readonly sessionId?: string;
  }): Promise<
    | { readonly kind: 'prepared'; readonly invocation: PreparedSkillInvocation }
    | { readonly kind: 'unknown' }
  >;
}

export interface WorkflowHostControl {
  start(input: {
    readonly projectRoot: string;
    readonly source:
      | { readonly kind: 'inline'; readonly manifest: unknown; readonly source: string }
      | { readonly kind: 'request'; readonly request: string }
      | { readonly kind: 'name'; readonly name: string };
    readonly args?: unknown;
    readonly provider?: string;
    readonly model?: string;
    /** FEATURE_298 T22 — serializable run lineage the Host attaches verbatim. */
    readonly metadata?: import('@kodax-ai/coding').WorkflowRunProcessMetadata;
  }): Promise<{ readonly kind: 'declined'; readonly reason: string } | { readonly kind: 'started'; readonly runId: string }>;
  list(): Promise<readonly import('@kodax-ai/coding').ManagedWorkflowSnapshot[]>;
  get(runId: string): Promise<import('@kodax-ai/agent').WorkflowProcessSnapshot | undefined>;
  /** FEATURE_298 T22 — live process events for a Host-minted run. */
  subscribe(
    filter: { readonly runId?: string },
    listener: (event: import('@kodax-ai/agent').WorkflowProcessEvent) => void,
  ): { close(): void };
  pause(runId: string): Promise<boolean>;
  resume(runId: string): Promise<boolean>;
  stop(runId: string): Promise<boolean>;
}
