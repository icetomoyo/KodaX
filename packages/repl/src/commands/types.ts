/**
 * Command system type definitions.
 */

import type {
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

export interface CommandCallbacks {
  exit: () => void | Promise<void>;
  saveSession: () => Promise<void>;
  startNewSession?: () => void;
  loadSession: (id: string) => Promise<SessionLoadStatus>;
  listSessions: () => Promise<void>;
  clearHistory: () => void;
  printHistory: () => void;
  switchProvider?: (provider: string, model?: string) => void;
  setEffort?: (effort?: string) => void;
  setThinking?: (enabled: boolean) => void;
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
