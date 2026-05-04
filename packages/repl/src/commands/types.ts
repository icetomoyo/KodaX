/**
 * Command system type definitions.
 */

import type {
  AgentsFile,
  KodaXAgentMode,
  KodaXRepoIntelligenceMode,
  KodaXOptions,
  KodaXReasoningMode,
  KodaXSkillInvocationContext,
} from '@kodax/coding';
import type * as readline from 'readline';
import type { InteractiveContext } from '../interactive/context.js';
import type { PermissionMode } from '../permission/types.js';
import type { UIContext } from '../ui/context.js';

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
  thinking: boolean;
  reasoningMode: KodaXReasoningMode;
  agentMode: KodaXAgentMode;
  permissionMode: PermissionMode;
  repoIntelligenceMode?: KodaXRepoIntelligenceMode;
  repointelEndpoint?: string;
  repointelBin?: string;
  repoIntelligenceTrace?: boolean;
}

export type SessionLoadStatus = 'loaded' | 'missing' | 'blocked';
export type SessionBranchSwitchStatus = 'switched' | 'missing' | 'blocked';
export type SessionForkStatus = 'forked' | 'failed' | 'blocked';
export type SessionRewindStatus = 'rewound' | 'failed' | 'blocked';

export interface CommandCallbacks {
  exit: () => void | Promise<void>;
  saveSession: () => Promise<void>;
  startNewSession?: () => void;
  loadSession: (id: string) => Promise<SessionLoadStatus>;
  listSessions: () => Promise<void>;
  clearHistory: () => void;
  printHistory: () => void;
  switchProvider?: (provider: string, model?: string) => void;
  setThinking?: (enabled: boolean) => void;
  setReasoningMode?: (mode: KodaXReasoningMode) => void;
  setAgentMode?: (mode: KodaXAgentMode) => void;
  setPermissionMode?: (mode: PermissionMode) => void;
  setRepoIntelligenceRuntime?: (update: {
    mode?: KodaXRepoIntelligenceMode;
    endpoint?: string | null;
    bin?: string | null;
    trace?: boolean;
  }) => void;
  deleteSession?: (id: string) => Promise<void>;
  deleteAllSessions?: () => Promise<void>;
  createKodaXOptions?: () => KodaXOptions;
  reloadAgentsFiles?: () => Promise<AgentsFile[]>;
  confirm?: (message: string) => Promise<boolean>;
  readline?: readline.Interface;
  startCompacting?: () => void;
  stopCompacting?: () => void;
  printSessionTree?: () => Promise<void>;
  switchSessionBranch?: (selector: string) => Promise<SessionBranchSwitchStatus>;
  labelSessionBranch?: (selector: string, label?: string) => Promise<boolean>;
  forkSession?: (selector?: string) => Promise<SessionForkStatus>;
  rewindSession?: (selector?: string) => Promise<SessionRewindStatus>;
  getCostReport?: () => string | null;
  /**
   * FEATURE_092 phase 2b.8: read-only stats accessor for the auto-mode
   * classifier guardrail. Returns undefined when the guardrail hasn't been
   * constructed yet (REPL never entered auto mode this session). The
   * returned snapshot is a copy of references — caller cannot mutate
   * guardrail state through it. Used by `/auto-engine` (show), `/auto-denials`,
   * and the status bar engine indicator.
   */
  getAutoModeStats?: () => import('@kodax/coding').AutoModeStats | undefined;
  /**
   * FEATURE_092 phase 2b.8: manual engine setter for `/auto-engine llm|rules`.
   * No-op when the guardrail hasn't been constructed yet. Threshold downgrades
   * still operate normally — a subsequent denial cross will downgrade again.
   */
  setAutoModeEngine?: (engine: 'llm' | 'rules') => void;
  ui: UIContext;
}

export interface CommandResultData {
  success?: boolean;
  message?: string;
  data?: unknown;
  skillContent?: string;
  invocation?: CommandInvocationRequest;
}

export interface CommandInvocationRequest extends CommandExecutionMetadata {
  prompt: string;
  source: 'skill' | 'prompt' | 'extension';
  displayName: string;
  path?: string;
  skillInvocation?: KodaXSkillInvocationContext;
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
  detailedHelp?: () => void;
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
  detailedHelp?: () => void;
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
