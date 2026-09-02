/**
 * KodaX Interactive REPL Mode - 交互式 REPL 模式
 */

import * as readline from 'readline';
import * as childProcess from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import chalk from 'chalk';

// Export Ink UI version entry point - 导出 Ink UI 版本的入口
export { runInkInteractiveMode } from '../ui/index.js';
export type { InkREPLOptions } from '../ui/index.js';
import {
  extractArtifactLedger,
  KodaXInputArtifact,
  KodaXOptions,
  type KodaXAgentMode,
  KodaXResult,
  KodaXReasoningMode,
  mergeArtifactLedger,
  runManagedTask,
  resolveRepoIntelligenceRuntimeConfig,
  KodaXError,
  KodaXRateLimitError,
  KodaXProviderError,
  KODAX_DEFAULT_PROVIDER,
  buildGoalRuntimeBinding,
  actorQueueId,
  decideWorkflowInvocation,
  workflowStartOutcomeConsumesTurn,
} from '@kodax-ai/coding';
import {
  appendSessionLineageLabel,
  appendMemoryClientNotice,
  appendMemoryOutcomeDigest,
  appendMemoryReviewReceipt,
  buildSessionTree,
  countActiveLineageMessages,
  createSessionLineage,
  evictOldIslandMessageContent,
  estimateTokens,
  emitKodaXDiagnostic,
  forkSessionLineage,
  generateSessionId as generateCoreSessionId,
  findPreviousUserEntryId,
  getAgentConfigPath,
  getMessageQueue,
  getSessionMessagesFromLineage,
  rewindSessionLineage,
  setSessionLineageActiveEntry,
} from '@kodax-ai/agent';
import type {
  KodaXMessage,
  KodaXSessionData,
  KodaXSessionRuntimeInfo,
  KodaXSessionStorage,
  KodaXSessionUiHistoryItem,
} from '@kodax-ai/agent';
import type { AgentsFile, KodaXWorkflowAgentDigestEvent } from '@kodax-ai/coding';
import type { CompactionUpdate, KodaXActivityEventMeta } from '@kodax-ai/coding';
import type { PermissionMode, ConfirmResult } from '../permission/types.js';
import {
  resolveReplRuntimePermissionDecision,
  toReplRuntimeAutoModeSettings,
  type ReplRuntimeAutoModeControl,
  type ReplRuntimeAutoModeSettings,
  type ReplRuntimePermissionPrompt,
} from '../runtime-permission.js';
import {
  computeConfirmTools,
  canonicalizePermissionMode,
  FILE_MODIFICATION_TOOLS,
  isAutoMode,
  normalizePermissionMode,
} from '../permission/types.js';
import { bootstrapAutoMode, type AutoModeBootstrapResult } from './auto-mode-bootstrap.js';
import {
  createStandaloneShellPermissionBoundary,
  type StandaloneExecPolicyOptions,
} from '../permission/standalone-shell-boundary.js';
import { formatLearningRecoverySummary } from '../ui/view-models/learning-summary.js';
import { createBashPrefixExtractor, type BashPrefixExtractor } from '@kodax-ai/coding';
import { bootstrapTeamMode, type TeamModeHandle, type WorkflowProcessEvent } from '@kodax-ai/agent';
import {
  isToolCallAllowed,
  isAlwaysConfirmPath,
  isBashReadCommandAutoAllowed,
  getPlanModeBlockReason,
} from '../permission/permission.js';
import { replBashPathSignalCollector } from '../permission/repl-bash-signals.js';
import {
  getGitRoot,
  prepareRuntimeConfig,
  getProviderAvailableModels,
  KODAX_VERSION,
  resolveRuntimeEffortSelection,
  resolveRuntimeModelSelection,
  resolveRuntimeProviderSelection,
  resolveInitialEffortOverride,
  resolveProviderReasoningRuntimeEffort,
} from '../common/utils.js';
import {
  InteractiveContext,
  InteractiveMode,
  createInteractiveContext,
  generateSessionId as generateInteractiveSessionId,
  touchContext,
} from './context.js';
import { deriveProjectKeyFromRoot } from './project-key.js';
import {
  parseCommand,
  executeCommand,
  CommandCallbacks,
  CurrentConfig,
} from './commands.js';
import {
  MultipleUserSkillReferencesError,
  resolveUserSkillInvocation,
} from './user-skill-invocation.js';
import type {
  CommandWorkflowInvocationRequest,
  RuntimeSurfaceStatus,
  SessionRecoverStatus,
} from '../commands/types.js';
import type { LearningBinding } from '../ui/types.js';
import { loadCompactionConfig } from '../common/compaction-config.js';
import { loadAlwaysAllowTools, loadAutoModeSettings, saveAlwaysAllowToolPattern } from '../common/permission-config.js';
import {
  confirmToolExecution,
  getTerminalWidth,
} from './prompts.js';
import {
  createCompleter,
  getCompletionSuggestions,
  type Completion,
} from './autocomplete.js';
import { getCurrentTheme, setTheme, type Theme } from './themes.js';
import { getSkillRegistry, initializeSkillRegistry } from '@kodax-ai/agent';
import { ReadlineUIContext } from '../ui/readline-ui.js';
import { extractLastAssistantText, extractTitle as extractSessionTitle } from '../ui/utils/message-utils.js';
import { prepareRootCompactionLineage } from '../ui/utils/compaction-commit.js';
import { executeShellCommand, isShellCommandHandled } from '../ui/utils/shell-executor.js';
import { prepareInvocationExecution } from './invocation-runtime.js';
import {
  resolveConfirm,
  startGeneratedWorkflowFromRequest,
} from '../commands/workflow-command.js';
import { formatWorkflowAgentDigest, inferWorkflowLocaleFromParts } from '../commands/workflow-command-results.js';
import {
  enforceSessionTransitionGuard,
} from './session-guardrails.js';
import { formatSessionTree } from './session-tree.js';
import {
  formatWorkspaceTruth,
  inspectWorkspaceRuntime,
  resolveSessionRuntimeInfo,
  workspaceExists,
} from './workspace-runtime.js';
import { preparePromptInputArtifacts } from '../common/input-artifacts.js';
import {
  buildRecoverySeed,
  normalizeRecoveryPrompt,
  SESSION_RECOVERY_CONFIRM_MESSAGE,
  SESSION_RECOVERY_HINT_MESSAGE,
  shouldOfferSessionRecovery,
} from '../session/recovery.js';
import { findMostRecentResumableSession } from '../session/resumable-session.js';

// Extended session storage interface (adds list method) - 扩展的会话存储接口（增加 list 方法）
interface SessionStorage extends KodaXSessionStorage {
  list(
    gitRoot?: string,
    options?: { limit?: number; includeArchived?: boolean },
  ): Promise<Array<{
    id: string;
    title: string;
    msgCount: number;
    tag?: string;
    runtimeInfo?: KodaXSessionData['runtimeInfo'];
  }>>;
}

export async function loadClassicStartupSession(
  session: KodaXOptions['session'],
  storage: SessionStorage,
  gitRoot?: string,
): Promise<{
  id: string;
  data: KodaXSessionData;
  kind: 'load' | 'continue';
  runtimeInfo?: KodaXSessionRuntimeInfo;
} | null> {
  if (session?.id) {
    const data = await storage.load(session.id);
    if (!data) return null;
    const runtimeInfo = resolveSessionRuntimeInfo(data);
    return {
      id: session.id,
      data,
      kind: 'load',
      ...(runtimeInfo ? { runtimeInfo } : {}),
    };
  }

  if (session?.resume || session?.autoResume) {
    const recent = await findMostRecentResumableSession(storage, gitRoot);
    if (!recent) return null;
    const data = await storage.load(recent.id);
    if (!data) return null;
    const runtimeInfo = resolveSessionRuntimeInfo(data);
    return {
      id: recent.id,
      data,
      kind: 'continue',
      ...(runtimeInfo ? { runtimeInfo } : {}),
    };
  }

  return null;
}

export async function buildClassicCliSkillsPrompt(gitRoot?: string): Promise<string> {
  const registry = await initializeSkillRegistry(gitRoot);
  return registry.getSystemPromptSnippet();
}

function syncClassicCliSkillsPrompt(
  gitRoot: string | undefined,
  options: KodaXOptions,
): void {
  const registry = getSkillRegistry(gitRoot);
  options.context = {
    ...options.context,
    skillsPrompt: registry.getSystemPromptSnippet(),
  };
}

// Simple in-memory session storage (replaceable with persistent storage) - 简单的内存会话存储（可替换为持久化存储）
class MemorySessionStorage implements SessionStorage {
  private sessions = new Map<string, { data: KodaXSessionData; createdAt: string }>();

  async save(id: string, data: KodaXSessionData): Promise<void> {
    const existing = this.sessions.get(id);
    const lineage = createSessionLineage(
      data.messages,
      data.lineage ?? existing?.data.lineage,
    );
    this.sessions.set(id, {
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      data: {
        ...structuredClone(data),
        scope: data.scope ?? existing?.data.scope ?? 'user',
        uiHistory: data.uiHistory ?? existing?.data.uiHistory,
        extensionState: data.extensionState ?? existing?.data.extensionState,
        extensionRecords: data.extensionRecords ?? existing?.data.extensionRecords,
        tag: data.tag ?? existing?.data.tag,
        lineage,
      },
    });
  }

  async load(id: string): Promise<KodaXSessionData | null> {
    return structuredClone(this.sessions.get(id)?.data ?? null);
  }

  async getLineage(id: string) {
    return structuredClone(this.sessions.get(id)?.data.lineage ?? null);
  }

  async loadFullLineage(id: string) {
    return this.getLineage(id);
  }

  async setActiveEntry(
    id: string,
    selector: string,
    options?: { summarizeCurrentBranch?: boolean },
  ): Promise<KodaXSessionData | null> {
    const current = this.sessions.get(id);
    if (!current?.data.lineage) {
      return null;
    }

    const lineage = setSessionLineageActiveEntry(current.data.lineage, selector, options);
    if (!lineage) {
      return null;
    }

    const data: KodaXSessionData = {
      ...structuredClone(current.data),
      messages: getSessionMessagesFromLineage(lineage),
      lineage,
    };
    this.sessions.set(id, { ...current, data });
    return structuredClone(data);
  }

  async setLabel(id: string, selector: string, label?: string): Promise<KodaXSessionData | null> {
    const current = this.sessions.get(id);
    if (!current?.data.lineage) {
      return null;
    }

    const lineage = appendSessionLineageLabel(current.data.lineage, selector, label);
    if (!lineage) {
      return null;
    }

    const data: KodaXSessionData = {
      ...structuredClone(current.data),
      lineage,
    };
    this.sessions.set(id, { ...current, data });
    return structuredClone(data);
  }

  async fork(
    id: string,
    selector?: string,
    options?: { sessionId?: string; title?: string },
  ): Promise<{ sessionId: string; data: KodaXSessionData } | null> {
    const current = this.sessions.get(id);
    if (!current?.data.lineage) {
      return null;
    }

    const lineage = forkSessionLineage(current.data.lineage, selector);
    if (!lineage) {
      return null;
    }

    const sessionId = options?.sessionId ?? await generateCoreSessionId();
    const data: KodaXSessionData = {
      messages: getSessionMessagesFromLineage(lineage),
      title: options?.title ?? current.data.title,
      gitRoot: current.data.gitRoot,
      tag: current.data.tag,
      runtimeInfo: current.data.runtimeInfo
        ? structuredClone(current.data.runtimeInfo)
        : undefined,
      scope: current.data.scope ?? 'user',
      extensionState: current.data.extensionState
        ? structuredClone(current.data.extensionState)
        : undefined,
      extensionRecords: current.data.extensionRecords
        ? structuredClone(current.data.extensionRecords)
        : undefined,
      lineage,
    };
    this.sessions.set(sessionId, {
      createdAt: new Date().toISOString(),
      data,
    });
    return {
      sessionId,
      data: structuredClone(data),
    };
  }

  async rewind(id: string, selector?: string): Promise<KodaXSessionData | null> {
    const current = this.sessions.get(id);
    if (!current?.data.lineage) {
      return null;
    }

    const targetId = selector ?? findPreviousUserEntryId(current.data.lineage);
    if (!targetId) return null;

    const lineage = rewindSessionLineage(current.data.lineage, targetId);
    if (!lineage) {
      return null;
    }

    const data: KodaXSessionData = {
      ...current.data,
      messages: getSessionMessagesFromLineage(lineage),
      lineage,
    };
    this.sessions.set(id, { ...current, data });
    return structuredClone(data);
  }

  async list(_gitRoot?: string): Promise<Array<{
    id: string;
    title: string;
    msgCount: number;
    tag?: string;
    runtimeInfo?: KodaXSessionData['runtimeInfo'];
  }>> {
    return Array.from(this.sessions.entries())
      .filter(([, session]) => (session.data.scope ?? 'user') === 'user')
      .map(([id, session]) => ({
        id,
        title: session.data.title,
        msgCount: session.data.lineage
          ? countActiveLineageMessages(session.data.lineage)
          : session.data.messages.length,
        ...(session.data.tag !== undefined ? { tag: session.data.tag } : {}),
        ...(session.data.runtimeInfo
          ? {
            runtimeInfo: structuredClone(session.data.runtimeInfo),
          }
          : {}),
      }));
  }

  async delete(id: string): Promise<void> {
    this.sessions.delete(id);
  }

  async deleteAll(_gitRoot?: string): Promise<void> {
    this.sessions.clear();
  }
}

export { MemorySessionStorage };

function applyRuntimeContext(
  context: InteractiveContext,
  currentOptions: RepLOptions,
  runtimeInfo: InteractiveContext['runtimeInfo'],
): void {
  context.runtimeInfo = runtimeInfo;
  context.gitRoot = runtimeInfo?.workspaceRoot ?? context.gitRoot;
  currentOptions.context = {
    ...currentOptions.context,
    gitRoot: context.gitRoot,
    executionCwd: runtimeInfo?.executionCwd ?? process.cwd(),
  };
}

function applyRuntimeSessionSnapshot(context: InteractiveContext, result: KodaXResult): void {
  const snapshot = result.runtimeSessionSnapshot;
  if (!snapshot) return;
  if ('extensionState' in snapshot) {
    context.extensionState = snapshot.extensionState
      ? structuredClone(snapshot.extensionState)
      : {};
    context.extensionStateDirty = true;
  }
  if ('extensionRecords' in snapshot) {
    context.extensionRecords = snapshot.extensionRecords?.map((record) => ({ ...record })) ?? [];
    context.extensionRecordsDirty = true;
  }
}

export function contextExtensionSessionData(
  context: InteractiveContext,
): Pick<KodaXSessionData, 'extensionState' | 'extensionRecords'> {
  return {
    ...(context.extensionStateDirty ? { extensionState: context.extensionState ?? {} } : {}),
    ...(context.extensionRecordsDirty ? { extensionRecords: context.extensionRecords ?? [] } : {}),
  };
}

function markExtensionSessionPersisted(context: InteractiveContext): void {
  context.extensionStateDirty = false;
  context.extensionRecordsDirty = false;
}

// REPL options - REPL 选项
export interface ReplRuntimeRunnerInput {
  readonly options: KodaXOptions;
  readonly prompt: string;
  readonly sessionId: string;
  readonly permissionMode: PermissionMode;
  readonly autoModeSettings?: ReplRuntimeAutoModeSettings;
  readonly requestPermission?: ReplRuntimePermissionPrompt;
  /** Marks the callback installed by the REPL's legacy permission UI. */
  readonly legacyPermissionHook?: true;
}

export type ReplRuntimeRunner = (input: ReplRuntimeRunnerInput) => Promise<KodaXResult>;
export type ReplRuntimeStatusProvider = () => Promise<RuntimeSurfaceStatus | undefined>;

export interface RepLOptions extends KodaXOptions {
  storage?: SessionStorage;
  execPolicy?: StandaloneExecPolicyOptions;
  runtimeRunner?: ReplRuntimeRunner;
  runtimeAutoModeControl?: ReplRuntimeAutoModeControl;
  getRuntimeStatus?: ReplRuntimeStatusProvider;
  validateSetupA2AConfig?: (value: unknown) => unknown;
  prepareSetupSandbox?: CommandCallbacks['prepareSetupSandbox'];
  inspectSandbox?: CommandCallbacks['inspectSandbox'];
  learning?: LearningBinding;
}

function resolveInitialReasoningMode(
  options: Pick<KodaXOptions, 'reasoningMode' | 'thinking'>,
  config: { reasoningMode?: KodaXReasoningMode; thinking?: boolean },
): KodaXReasoningMode {
  if (options.reasoningMode) {
    return options.reasoningMode;
  }
  if (config.reasoningMode) {
    return config.reasoningMode;
  }
  if (options.thinking === true || config.thinking === true) {
    return 'auto';
  }
  return 'auto';
}

// Module-level cost report ref — agent populates via events.getCostReport, /cost reads it
const costReportRef: { current: (() => string) | null } = { current: null };

// Run interactive mode - 运行交互式模式
export async function runInteractiveMode(options: RepLOptions): Promise<void> {
  const startupRuntime = await inspectWorkspaceRuntime({ cwd: process.cwd() });
  const startupGitRoot = startupRuntime.workspaceRoot ?? await getGitRoot() ?? undefined;
  const storage = options.storage ?? new MemorySessionStorage();
  const startupSession = await loadClassicStartupSession(
    options.session,
    storage,
    startupGitRoot,
  );
  const activeRuntime = startupSession
    ? startupSession.runtimeInfo ?? startupRuntime
    : startupRuntime;
  const gitRoot = activeRuntime.workspaceRoot ?? startupGitRoot;
  if (startupSession) {
    options = {
      ...options,
      session: {
        ...(options.session ?? {}),
        id: startupSession.id,
        tag: startupSession.data.tag,
      },
    };
  }

  // FEATURE_125 v0.7.41 — Bootstrap Team Mode (multi-instance auto
  // coordination). Returns null when KODAX_DISABLE_MULTI_INSTANCE=1
  // is set; otherwise registers this session under
  // `<configHome>/instances/<pid>/`, reaps stale peer directories
  // from crashed sessions, and installs the writer in the
  // process-level singleton. Tools / runner-driven adapter consume
  // the singleton via `getActiveTeamModeWriter()`.
  const teamModeHandle: TeamModeHandle | null = bootstrapTeamMode({
    meta: {
      cwd: process.cwd(),
      startedAt: Date.now(),
    },
  });

  // Load config (priority: CLI args > config file > defaults) - 加载配置（优先级：CLI参数 > 配置文件 > 默认值）
  const config = prepareRuntimeConfig();

  // Initialize custom providers from config - 从配置初始化自定义 Provider
  const initialProvider = resolveRuntimeProviderSelection({
    explicitProvider: options.provider,
    environmentProvider: process.env.KODAX_PROVIDER,
    configuredProvider: config.provider,
    defaultProvider: KODAX_DEFAULT_PROVIDER,
  });
  const initialModel = resolveRuntimeModelSelection({
    explicitProvider: options.provider,
    environmentProvider: process.env.KODAX_PROVIDER,
    explicitModel: options.model,
    configuredProvider: config.provider,
    configuredModel: config.model,
  });
  const initialReasoningMode = resolveInitialReasoningMode(options, config);
  const initialEffort = resolveRuntimeEffortSelection({
    explicitEffort: options.effort,
    environmentEffort: process.env.KODAX_EFFORT,
    configuredEffort: config.effort,
  });
  const initialEffortOverride = resolveInitialEffortOverride(
    options,
    config,
    process.env.KODAX_EFFORT,
  );
  const initialAgentMode = options.agentMode ?? (config as { agentMode?: KodaXAgentMode }).agentMode ?? 'ama';
  const initialThinking = initialReasoningMode !== 'off';
  const initialPermissionMode: PermissionMode =
    normalizePermissionMode((config as { permissionMode?: string }).permissionMode, 'accept-edits') ?? 'accept-edits';
  const repoIntelligenceRuntime = resolveRepoIntelligenceRuntimeConfig();

  const configuredTheme = (config as { theme?: string }).theme;
  if (configuredTheme) {
    setTheme(configuredTheme);
  }
  const theme = getCurrentTheme();

  // Current config state - 当前配置状态
  let currentConfig: CurrentConfig = {
    provider: initialProvider,
    model: initialModel,
    effort: initialEffort,
    effortOverride: initialEffortOverride,
    planModeEffort: config.planModeEffort,
    thinking: initialThinking,
    reasoningMode: initialReasoningMode,
    agentMode: initialAgentMode,
    permissionMode: initialPermissionMode,
    repoIntelligenceMode: repoIntelligenceRuntime.mode,
    repoIntelligenceTrace: repoIntelligenceRuntime.trace,
    fallbackProviders: config.fallbackProviders,
  };

  // Local permission state - 本地权限状态
  let currentPermissionMode: PermissionMode = initialPermissionMode;
  let alwaysAllowTools: string[] = loadAlwaysAllowTools();

  const resolveCurrentRuntimeEffort = (override?: {
    provider?: string;
    model?: string;
    permissionMode?: PermissionMode;
  }): ReturnType<typeof resolveProviderReasoningRuntimeEffort> =>
    resolveProviderReasoningRuntimeEffort({
      provider: override?.provider ?? currentConfig.provider,
      model: override?.model ?? currentConfig.model,
      effort: currentConfig.effort,
      effortOverride: currentConfig.effortOverride,
      permissionMode: override?.permissionMode ?? currentConfig.permissionMode,
      planModeEffort: currentConfig.planModeEffort,
      thinking: currentConfig.thinking,
      reasoningMode: currentConfig.reasoningMode,
    });

  // Esc+Esc edit state - Esc+Esc 编辑状态
  let lastEscTime = 0;
  let lastUserMessage = '';
  let pendingEdit = false;  // Flag for editing last message in external editor - 标记是否需要在外部编辑器中编辑上一条消息
  const ESC_DOUBLE_PRESS_MS = 500;

  const context = await createInteractiveContext({
    sessionId: startupSession?.id ?? options.session?.id,
    gitRoot,
    runtimeInfo: activeRuntime,
    existingMessages: startupSession?.data.messages,
    existingUiHistory: startupSession?.data.uiHistory,
    existingLineage: startupSession?.data.lineage,
    existingArtifactLedger: startupSession?.data.artifactLedger,
    existingExtensionState: startupSession?.data.extensionState,
    existingExtensionRecords: startupSession?.data.extensionRecords,
  });
  context.title = startupSession?.data.title ?? '';
  if (startupSession) {
    const label = startupSession.kind === 'continue' ? 'Continuing session' : 'Session loaded';
    process.stdout.write(`${chalk.green(`[${label}: ${startupSession.id}]`)}\n`);
  }
  // FEATURE_222 (R4): forward the host skill dynamic-context policy so the
  // user-typed `/skill` slash path is gated the same as the model-triggered tool.
  context.skillDynamicContext = options.skillDynamicContext;

  // v0.7.43 (FEATURE_173 Part B follow-up) — publish the resolved
  // sessionId to the FEATURE_125 heartbeat so `listRunningSessions()`
  // can correlate a running instance with its `.jsonl` file.
  teamModeHandle?.writer.update({ sessionId: context.sessionId });

  const guardSessionTransition = (action: string): boolean => {
    return enforceSessionTransitionGuard(currentConfig, action, (status, headline, details) => {
      console.log((status === 'block' ? chalk.red : chalk.yellow)(`\n${headline}`));
      for (const detail of details) {
        console.log(chalk.dim(detail));
      }
      console.log();
    });
  };

  // Load compaction config for banner display
  const compactionConfig = await loadCompactionConfig(gitRoot ?? undefined);
  const { resolveProvider } = await import('@kodax-ai/coding');
  const providerInstance = resolveProvider(currentConfig.provider);
  const effectiveContextWindow = compactionConfig.contextWindow
    ?? providerInstance.getEffectiveContextWindow?.(currentConfig.model)
    ?? providerInstance.getContextWindow?.()
    ?? 200000;

  // Load AGENTS.md files
  const { loadAgentsFiles } = await import('@kodax-ai/coding');
  const reloadAgentsFiles = async (): Promise<AgentsFile[]> => {
    return loadAgentsFiles({
      cwd: process.cwd(),
      projectRoot: context.gitRoot ?? undefined,
    });
  };
  let agentsFiles = await reloadAgentsFiles();

  // Print startup Banner - 打印启动 Banner
  printStartupBanner(currentConfig, currentConfig.permissionMode, {
    contextWindow: effectiveContextWindow,
    triggerPercent: compactionConfig.triggerPercent,
    triggerTokens: compactionConfig.triggerTokens,
    enabled: compactionConfig.enabled,
  }, agentsFiles);
  printWorkspaceEntryNotice(activeRuntime);
  if (options.learning) {
    try {
      const recovery = formatLearningRecoverySummary(await options.learning.getSnapshot());
      if (recovery) console.log(chalk.yellow(`\n${recovery}\n`));
    } catch (error: unknown) {
      emitKodaXDiagnostic({
        source: 'repl:learning',
        level: 'warn',
        message: 'Failed to recover the Learning Center startup summary.',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Detect and show project hint - 检测并显示项目提示

  // Create autocomplete - 创建自动补全器
  const completer = createCompleter(() => context.gitRoot ?? process.cwd());

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdout.isTTY ?? true,
    historySize: 100,
    completer: (line: string, callback: (err: null | Error, result: [string[], string]) => void) => {
      // Async completion - 异步补全
      completer(line).then(result => {
        callback(null, result);
      }).catch(() => {
        callback(null, [[], line]);
      });
    },
  });

  const requestRuntimePermission: ReplRuntimePermissionPrompt = async (request, promptContext) => {
    const result = await confirmToolExecution(
      rl,
      request.toolName,
      {
        ...request.input,
        ...(request.reason !== undefined ? { _reason: request.reason } : {}),
        ...(request.executionCwd !== undefined ? { _executionCwd: request.executionCwd } : {}),
        ...(request.risk !== undefined ? { _runtimeRisk: request.risk } : {}),
      },
      {
        permissionMode: currentPermissionMode,
        runtimeGrantSuggestions: request.grantSuggestions ?? [],
        signal: promptContext.signal,
      },
    );
    return resolveReplRuntimePermissionDecision(request, result);
  };

  // FEATURE_092 phase 2b.7b: bootstrap auto-mode guardrail (factory only;
  // the guardrail is constructed lazily on first 'auto' tool call so the
  // cost is paid only by users who actually use auto mode).
  // Slice C: settings/env block resolved here so the bootstrap stays free
  // of file-system I/O — env override layers feed the resolver chain.
  const autoModeSettings = loadAutoModeSettings();
  const runtimeAutoModeSettings = toReplRuntimeAutoModeSettings(autoModeSettings);
  await options.runtimeAutoModeControl?.syncSettings?.(
    context.sessionId,
    currentPermissionMode,
    runtimeAutoModeSettings,
  );
  const autoModeBootstrap: AutoModeBootstrapResult = await bootstrapAutoMode({
    projectRoot: gitRoot ?? process.cwd(),
    executionCwd: activeRuntime.executionCwd ?? gitRoot ?? process.cwd(),
    getCurrentProviderName: () => currentConfig.provider,
    getCurrentModel: () => currentConfig.model,
    getCurrentPermissionMode: () => currentPermissionMode,
    autoModeSettings,
    log: (level, msg) => {
      if (level === 'warn') console.log(chalk.yellow(msg));
      else console.log(chalk.dim(msg));
    },
    // FEATURE_158: inject the REPL-side path-aware bash signal collector.
    extraCollectors: [replBashPathSignalCollector],
  });

  // FEATURE_153 (v0.7.38): build the LLM-backed bash prefix extractor used by
  // `isToolCallAllowed`. Live getters re-resolve provider + model on every
  // call, so mid-session `/provider` and `/model` swaps redirect the
  // extractor without an explicit reset (mirrors the auto-mode guardrail's
  // hotfix-3 LIVE getter pattern).
  const bashPrefixExtractor: BashPrefixExtractor = createBashPrefixExtractor({
    getProvider: () => resolveProvider(currentConfig.provider),
    getModel: () => currentConfig.model ?? '',
  });

  // Keyboard shortcut state (Phase 2 will use) - 键盘快捷键状态 (Phase 2 将实际使用)
  // let showToolOutput = true;
  // let showTodoList = false;

  // Keyboard shortcut mapping - 键盘快捷键映射
  const KEYBOARD_SHORTCUTS_HELP = `
Keyboard Shortcuts:
  Tab       Auto-complete (@paths, /commands)
  Esc+Esc   Edit last message
  Ctrl+T    Cycle reasoning effort
  Ctrl+E    Open external editor
  Ctrl+R    Search command history (built-in)
  Ctrl+C    Cancel current input
  Ctrl+D    Exit REPL`;

  // Print keyboard shortcuts help (can be called in /help command) - 打印快捷键帮助 (可在 /help 命令中调用)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _printKeyboardShortcuts = (): void => {
    console.log(chalk.dim(KEYBOARD_SHORTCUTS_HELP));
  };

  // Listen for keyboard events (for Esc+Esc and Ctrl+E) - 监听键盘事件 (用于 Esc+Esc 和 Ctrl+E)
  if (process.stdin.isTTY) {
    process.stdin.on('keypress', (char: string | undefined, key: readline.Key | undefined) => {
      if (!key) return;

      // Esc+Esc detection - Esc+Esc 检测
      if (key.name === 'escape') {
        const now = Date.now();
        if (now - lastEscTime < ESC_DOUBLE_PRESS_MS && lastUserMessage) {
          // Double Esc - flag for editing last message in editor - 双击 Esc - 标记需要在编辑器中编辑上一条消息
          pendingEdit = true;
          console.log(chalk.dim('\n[Opening editor with last message...]'));
          // Close current readline prompt so main loop can handle editing - 关闭当前 readline 问题以便主循环可以处理编辑
          rl.pause();
        }
        lastEscTime = now;
      }
    });
  }

  // FEATURE_143 (v0.7.36) — classic CLI parity with InkREPL: build the
  // skill registry's system-prompt snippet at startup and forward it via
  // `context.skillsPrompt`. Without this, classic CLI users got an empty
  // skills list in the system prompt while Ink TUI users got the full
  // hardened skills manifest. See `getSystemPromptSnippet()` for the
  // hardened wording.
  const classicCliSkillsPrompt = await buildClassicCliSkillsPrompt(gitRoot);

  let isRunning = true;
  // Fix: Ensure session.id is set to reuse same session - 修复：确保 session.id 被设置以复用同一 session
  let currentOptions: RepLOptions = {
    ...options,
    provider: initialProvider,
    model: initialModel,
    effort: resolveCurrentRuntimeEffort().runtimeEffort,
    agentMode: initialAgentMode,
    reasoningMode: initialReasoningMode,
    thinking: initialThinking,
    // FEATURE_246 A5 (ADR-047): the session options that flow to runAgentRound
    // must carry the workflow runs dir so the Worker's tool-execution context
    // wires ctx.workflowHost and the run_workflow tool is live on NL turns (not
    // just the /workflow command path). The createKodaXOptions closure inherits
    // this via its `...currentOptions` spread.
    workflowRunsBaseDir: getAgentConfigPath(
      'workflow-runs',
      deriveProjectKeyFromRoot(gitRoot ?? activeRuntime.executionCwd ?? process.cwd()).key,
    ),
    context: {
      ...options.context,
      gitRoot,
      executionCwd: activeRuntime.executionCwd,
      repoIntelligenceMode: repoIntelligenceRuntime.mode,
      repoIntelligenceTrace: repoIntelligenceRuntime.trace,
      skillsPrompt: classicCliSkillsPrompt,
    },
    session: {
      ...options.session,
      id: context.sessionId,
      storage,
      // FEATURE_173 dual-writer fix: the REPL owns session persistence
      // (full lineage + uiHistory + artifactLedger via persistContextState).
      // Suppress the runner's redundant flat snapshot so it can't clobber.
      persistedByHost: true,
    },
  };

  // Cost tracking ref — agent populates this via events.getCostReport, /cost command reads it
  const refreshCurrentEffort = (): void => {
    const effortResolution = resolveCurrentRuntimeEffort();
    currentOptions.effort = effortResolution.runtimeEffort;
  };

  costReportRef.current = null;

  const recoverCurrentSession = async (prompt?: string): Promise<SessionRecoverStatus> => {
    if (context.messages.length === 0) {
      return 'empty';
    }
    if (!guardSessionTransition('Recovering into a new session')) {
      return 'blocked';
    }

    const sourceSessionId = context.sessionId;
    const sourceLineage = context.lineage ?? createSessionLineage(context.messages);
    context.lineage = sourceLineage;
    const sourceArtifactLedger = context.artifactLedger
      ? structuredClone(context.artifactLedger)
      : undefined;
    const sourceTitle = context.title || extractTitle(context.messages);
    const seed = buildRecoverySeed({
      sourceSessionId,
      messages: context.messages,
      lineage: sourceLineage,
      artifactLedger: sourceArtifactLedger,
      reason: 'provider session recovery',
    });

    await storage.save(sourceSessionId, {
      messages: context.messages,
      title: sourceTitle,
      gitRoot: context.gitRoot ?? '',
      runtimeInfo: context.runtimeInfo,
      lineage: sourceLineage,
      artifactLedger: sourceArtifactLedger,
      uiHistory: context.uiHistory,
      ...contextExtensionSessionData(context),
      ...(currentOptions.session?.tag !== undefined ? { tag: currentOptions.session.tag } : {}),
    });

    const nextSessionId = generateInteractiveSessionId();
    const seedLineage = createSessionLineage(seed.messages);
    await storage.save(nextSessionId, {
      messages: seed.messages,
      title: seed.title,
      gitRoot: context.gitRoot ?? '',
      runtimeInfo: context.runtimeInfo,
      lineage: seedLineage,
      artifactLedger: sourceArtifactLedger,
      ...(currentOptions.session?.tag !== undefined ? { tag: currentOptions.session.tag } : {}),
    });

    const now = new Date().toISOString();
    context.sessionId = nextSessionId;
    context.messages = seed.messages;
    context.title = seed.title;
    context.contextTokenSnapshot = undefined;
    context.lineage = seedLineage;
    context.artifactLedger = sourceArtifactLedger;
    context.extensionState = undefined;
    context.extensionRecords = undefined;
    context.extensionStateDirty = false;
    context.extensionRecordsDirty = false;
    context.createdAt = now;
    context.lastAccessed = now;
    currentOptions.session = {
      ...currentOptions.session,
      id: nextSessionId,
    };
    teamModeHandle?.writer.update({ sessionId: nextSessionId });

    console.log(chalk.green(`\n[Recovered session: ${nextSessionId}]`));
    console.log(chalk.dim(`  Source session saved: ${sourceSessionId}`));
    console.log(chalk.dim('  Raw provider history was not replayed.'));

    let result: KodaXResult;
    try {
      result = await runAgentRound(
        currentOptions,
        context,
        normalizeRecoveryPrompt(prompt),
        context.messages,
        undefined,
        options.runtimeRunner,
        currentPermissionMode,
        requestRuntimePermission,
        runtimeAutoModeSettings,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(chalk.red(`\n[Recover failed] ${message}`));
      return 'failed';
    }
    context.messages = result.messages;
    context.contextTokenSnapshot = result.contextTokenSnapshot;
    applyRuntimeSessionSnapshot(context, result);
    context.artifactLedger = mergeArtifactLedger(
      context.artifactLedger ?? [],
      (result.artifactLedger as typeof context.artifactLedger | undefined)
        ?? extractArtifactLedger(result.messages),
    );
    context.lineage = createSessionLineage(context.messages, context.lineage);
    const title = extractTitle(context.messages);
    context.title = title;
    await storage.save(context.sessionId, {
      messages: context.messages,
      title,
      gitRoot: context.gitRoot ?? '',
      runtimeInfo: context.runtimeInfo,
      lineage: context.lineage,
      artifactLedger: context.artifactLedger,
      ...contextExtensionSessionData(context),
      ...(currentOptions.session?.tag !== undefined ? { tag: currentOptions.session.tag } : {}),
    });
    markExtensionSessionPersisted(context);
    return 'recovered';
  };

  // Command callbacks - 命令回调
  const callbacks: CommandCallbacks = {
    getRuntimeStatus: options.getRuntimeStatus,
    validateSetupA2AConfig: options.validateSetupA2AConfig,
    prepareSetupSandbox: options.prepareSetupSandbox,
    inspectSandbox: options.inspectSandbox,
    learning: options.learning,
    getLearningSummary: options.learning ? () => options.learning!.getSnapshot() : undefined,
    exit: () => {
      isRunning = false;
      // FEATURE_125 — release the instance directory + clear the
      // process-level singleton on /exit so the next session's
      // discovery scan does not have to reap us as a stale peer.
      void teamModeHandle?.shutdown();
      rl.close();
    },
    saveSession: async () => {
      if (context.messages.length > 0) {
        const title = extractTitle(context.messages);
        context.title = title;
        await storage.save(context.sessionId, {
          messages: context.messages,
          title,
          gitRoot: context.gitRoot ?? '',
          runtimeInfo: context.runtimeInfo,
          artifactLedger: context.artifactLedger,
          ...contextExtensionSessionData(context),
          // FEATURE_226: carry the session tag so a brand-new session's first
          // save persists it (storage merges `data.tag ?? existing` otherwise).
          ...(currentOptions.session?.tag !== undefined ? { tag: currentOptions.session.tag } : {}),
        });
        markExtensionSessionPersisted(context);
      }
    },
    startNewSession: () => {
      context.sessionId = generateInteractiveSessionId();
      context.title = '';
      context.contextTokenSnapshot = undefined;
      context.artifactLedger = undefined;
      context.extensionState = undefined;
      context.extensionRecords = undefined;
      context.extensionStateDirty = false;
      context.extensionRecordsDirty = false;
      context.createdAt = new Date().toISOString();
      context.lastAccessed = context.createdAt;
      applyRuntimeContext(context, currentOptions, startupRuntime);
      currentOptions.session = {
        ...currentOptions.session,
        id: context.sessionId,
      };
      teamModeHandle?.writer.update({ sessionId: context.sessionId });
    },
    loadSession: async (id: string) => {
      const loaded = await storage.load(id);
      if (loaded) {
        if (!guardSessionTransition('Resuming a saved session')) {
          return 'blocked';
        }
        const currentWorkspaceRuntime = await inspectWorkspaceRuntime({ cwd: process.cwd() });
        const savedRuntime = resolveSessionRuntimeInfo(loaded);
        let appliedRuntime = savedRuntime ?? currentWorkspaceRuntime;
        if (savedRuntime?.workspaceRoot && !workspaceExists(savedRuntime)) {
          console.log(chalk.yellow('\n[Saved workspace unavailable]'));
          console.log(chalk.dim(`  Session workspace: ${formatWorkspaceTruth(savedRuntime)}`));
          console.log(chalk.dim(`  Falling back to current workspace: ${formatWorkspaceTruth(currentWorkspaceRuntime)}`));
          appliedRuntime = currentWorkspaceRuntime;
        } else if (
          savedRuntime?.workspaceRoot
          && currentWorkspaceRuntime.workspaceRoot
          && savedRuntime.workspaceRoot !== currentWorkspaceRuntime.workspaceRoot
        ) {
          console.log(chalk.cyan('\n[Loading sibling workspace session]'));
          console.log(chalk.dim(`  Current workspace: ${formatWorkspaceTruth(currentWorkspaceRuntime)}`));
          console.log(chalk.dim(`  Session workspace: ${formatWorkspaceTruth(savedRuntime)}`));
        }

        context.messages = loaded.messages;
        context.title = loaded.title;
        context.sessionId = id;
        context.contextTokenSnapshot = undefined;
        context.artifactLedger = loaded.artifactLedger;
        context.extensionState = loaded.extensionState
          ? structuredClone(loaded.extensionState)
          : undefined;
        context.extensionRecords = loaded.extensionRecords?.map((record) => ({ ...record }));
        context.extensionStateDirty = false;
        context.extensionRecordsDirty = false;
        context.lastAccessed = new Date().toISOString();
        applyRuntimeContext(context, currentOptions, appliedRuntime);
        currentOptions.session = {
          ...currentOptions.session,
          id,
          // FEATURE_226: reflect the loaded session's tag in-memory so saves
          // / forks carry it (storage merges `data.tag ?? existing` on save).
          tag: loaded.tag,
        };
        teamModeHandle?.writer.update({ sessionId: id });
        console.log(chalk.green(`\n[Loaded session: ${id}]`));
        console.log(chalk.dim(`  Messages: ${loaded.messages.length}`));
        if (context.runtimeInfo?.workspaceRoot) {
          console.log(chalk.dim(`  Workspace: ${formatWorkspaceTruth(context.runtimeInfo)}`));
        }
        return 'loaded';
      }
      return 'missing';
    },
      listSessions: async () => {
        const sessions = await storage.list(context.gitRoot ?? undefined);
        if (sessions.length === 0) {
          console.log(chalk.dim('\n[No saved sessions]'));
          return;
      }
      console.log(chalk.bold('\nRecent Sessions:\n'));
        if (context.runtimeInfo?.workspaceRoot) {
          console.log(chalk.dim(`  Current workspace: ${formatWorkspaceTruth(context.runtimeInfo)}`));
          console.log();
        }
        for (const s of sessions.slice(0, 10)) {
          console.log(`  ${chalk.cyan(s.id)} ${chalk.dim(`(${s.msgCount} messages)`)} ${s.title.slice(0, 40)}`);
          if (s.runtimeInfo?.workspaceRoot) {
            const sameWorkspace = context.runtimeInfo?.workspaceRoot === s.runtimeInfo.workspaceRoot;
            const suffix = sameWorkspace ? ' (current workspace)' : '';
            console.log(chalk.dim(`      workspace: ${formatWorkspaceTruth(s.runtimeInfo)}${suffix}`));
          }
        }
        console.log();
      },
    clearHistory: () => {
      context.messages = [];
      context.contextTokenSnapshot = undefined;
    },
    printHistory: () => {
      if (context.messages.length === 0) {
        console.log(chalk.dim('\n[No conversation history]'));
        return;
      }
      console.log(chalk.bold('\nConversation History:\n'));
      const recent = context.messages.slice(-20);
      for (let i = 0; i < recent.length; i++) {
        const m = recent[i]!;
        const role = chalk.cyan(m.role.padEnd(10));
        const content = typeof m.content === 'string' ? m.content : '[Complex content]';
        const preview = content.slice(0, 60).replace(/\n/g, ' ');
        const ellipsis = content.length > 60 ? '...' : '';
        console.log(`  ${(i + 1).toString().padStart(2)}. ${role} ${preview}${ellipsis}`);
      }
      console.log();
    },
    switchProvider: (provider: string, model?: string) => {
      const effortResolution = resolveCurrentRuntimeEffort({ provider, model });
      currentConfig.provider = provider;
      currentConfig.model = model;
      currentOptions.provider = provider;
      currentOptions.model = model;
      currentOptions.effort = effortResolution.runtimeEffort;
      if (effortResolution.diagnostic) {
        console.log(chalk.yellow(`\n[${effortResolution.diagnostic}]`));
      }
    },
    setThinking: (enabled: boolean) => {
      currentConfig.thinking = enabled;
      currentOptions.thinking = enabled;
      currentConfig.reasoningMode = enabled ? 'auto' : 'off';
      currentOptions.reasoningMode = currentConfig.reasoningMode;
    },
    setEffort: (effort?: string) => {
      currentConfig.effort = effort;
      currentConfig.effortOverride = effort !== undefined;
      refreshCurrentEffort();
    },
    setReasoningMode: (mode: KodaXReasoningMode) => {
      const thinking = mode !== 'off';
      currentConfig.reasoningMode = mode;
      currentConfig.thinking = thinking;
      currentOptions.reasoningMode = mode;
      currentOptions.thinking = thinking;
    },
    setAgentMode: (mode: KodaXAgentMode) => {
      currentConfig.agentMode = mode;
      currentOptions.agentMode = mode;
    },
    setPermissionMode: async (mode: PermissionMode) => {
      const canonicalMode = canonicalizePermissionMode(mode);
      await options.runtimeAutoModeControl?.syncSettings?.(
        context.sessionId,
        canonicalMode,
        runtimeAutoModeSettings,
      );
      currentConfig.permissionMode = canonicalMode;
      currentPermissionMode = canonicalMode; // Sync with local permission state
      refreshCurrentEffort();
      // Note: permissionMode is no longer part of KodaXOptions
      // Permission control is handled locally via beforeToolExecute callback
    },
    setRepoIntelligenceRuntime: (update) => {
      if (update.mode !== undefined) {
        currentConfig.repoIntelligenceMode = update.mode;
          process.env.KODAX_REPO_INTELLIGENCE = update.mode;
        currentOptions.context = {
          ...currentOptions.context,
          repoIntelligenceMode: update.mode,
        };
      }
      if (update.trace !== undefined) {
        currentConfig.repoIntelligenceTrace = update.trace;
        if (update.trace) {
          process.env.KODAX_REPO_INTELLIGENCE_TRACE = '1';
        } else {
          delete process.env.KODAX_REPO_INTELLIGENCE_TRACE;
        }
        currentOptions.context = {
          ...currentOptions.context,
          repoIntelligenceTrace: update.trace,
        };
      }
    },
    deleteSession: async (id: string) => {
      await storage.delete?.(id);
    },
    deleteAllSessions: async () => {
      await storage.deleteAll?.(context.gitRoot ?? undefined);
    },
    printSessionTree: async () => {
      const lineage = await storage.getLineage?.(context.sessionId);
      if (!lineage) {
        console.log(chalk.dim('\n[No session tree available for this session]'));
        return;
      }

      const lines = formatSessionTree(buildSessionTree(lineage));
      console.log(chalk.bold('\nSession Tree:\n'));
      for (const line of lines) {
        console.log(`  ${line}`);
      }
      console.log();
    },
    switchSessionBranch: async (selector: string) => {
      if (!guardSessionTransition('Switching session branches')) {
        return 'blocked';
      }

      const loaded = await storage.setActiveEntry?.(
        context.sessionId,
        selector,
        { summarizeCurrentBranch: true },
      );
      if (!loaded) {
        return 'missing';
      }

      context.messages = loaded.messages;
      context.title = loaded.title;
      context.contextTokenSnapshot = undefined;
      console.log(chalk.green(`\n[Switched to tree entry: ${selector}]`));
      console.log(chalk.dim(`  Messages: ${loaded.messages.length}`));
      return 'switched';
    },
    labelSessionBranch: async (selector: string, label?: string) => {
      const updated = await storage.setLabel?.(context.sessionId, selector, label);
      if (!updated) {
        return false;
      }

      const action = label && label.trim()
        ? `checkpoint label set: ${label.trim()}`
        : 'checkpoint label cleared';
      console.log(chalk.green(`\n[${action}]`));
      return true;
    },
    forkSession: async (selector?: string) => {
      if (!guardSessionTransition('Forking a session branch')) {
        return 'blocked';
      }

      const forked = await storage.fork?.(context.sessionId, selector);
      if (!forked) {
        return 'failed';
      }

      context.sessionId = forked.sessionId;
      context.messages = forked.data.messages;
      context.title = forked.data.title;
      context.contextTokenSnapshot = undefined;
      context.createdAt = new Date().toISOString();
      context.lastAccessed = context.createdAt;
      applyRuntimeContext(context, currentOptions, resolveSessionRuntimeInfo(forked.data) ?? context.runtimeInfo);
      currentOptions.session = {
        ...currentOptions.session,
        id: forked.sessionId,
      };
      console.log(chalk.green(`\n[Forked session: ${forked.sessionId}]`));
      console.log(chalk.dim(`  Messages: ${forked.data.messages.length}`));
      return 'forked';
    },
    recoverSession: recoverCurrentSession,
    rewindSession: async (selector?: string) => {
      if (!guardSessionTransition('Rewinding session')) {
        return 'blocked';
      }

      const rewound = await storage.rewind?.(context.sessionId, selector);
      if (!rewound) {
        return 'failed';
      }

      context.messages = rewound.messages;
      context.title = rewound.title;
      context.contextTokenSnapshot = undefined;
      context.lastAccessed = new Date().toISOString();
      console.log(chalk.green(`\n[Rewound session${selector ? ` to ${selector}` : ' to previous turn'}]`));
      console.log(chalk.dim(`  Messages: ${rewound.messages.length}`));
      return 'rewound';
    },
    getCostReport: () => costReportRef.current?.() ?? null,
    // Auto-mode read-only diagnostics for /auto-denials. The accessor
    // delegate to the lazy guardrail factory — when REPL never enters auto
    // mode, the guardrail is never constructed and the stats are undefined.
    getAutoModeStats: async () => {
      if (!isAutoMode(currentPermissionMode)) return undefined;
      if (options.runtimeAutoModeControl) {
        return options.runtimeAutoModeControl.getStats(context.sessionId);
      }
      return autoModeBootstrap.getGuardrail().getStats();
    },
    createKodaXOptions: () => {
      // FEATURE_074: live plan-mode check for child agents. The closure reads
      // currentPermissionMode lazily, so mid-run parent-mode toggles propagate
      // into in-flight children (user flipping plan ↔ accept-edits mid-stream
      // is a common case and was the original request).
      const planModeBlockCheck = (tool: string, input: Record<string, unknown>): string | null => {
        if (currentPermissionMode !== 'plan') return null;
        return getPlanModeBlockReason(tool, input, gitRoot ?? process.cwd());
      };
      const standaloneShellBoundary = options.runtimeRunner
        ? undefined
        : createStandaloneShellPermissionBoundary({
            getPermissionMode: () => currentPermissionMode,
            getAutoGuardrail: autoModeBootstrap.getGuardrail,
            shellSandbox: currentOptions.context?.shellSandbox,
            trustedTextMutationHost: currentOptions.context?.trustedTextMutationHost,
            userConfigDir: currentOptions.context?.configHome,
            projectRoot: gitRoot ?? process.cwd(),
            execPolicy: options.execPolicy,
            resolvePlanHostExecution: (request) => (
              isBashReadCommandAutoAllowed(
                request.command,
                gitRoot ?? process.cwd(),
                activeRuntime.executionCwd ?? gitRoot ?? process.cwd(),
              )
                ? true
                : '[Blocked] Plan mode cannot escalate this command to unsandboxed host execution.'
            ),
            requestUserPermission: async (request, reason) => {
              const input = { ...request.toolInput, command: request.command };
              if (
                reason === 'mode_boundary'
                && currentPermissionMode === 'accept-edits'
                && await isToolCallAllowed('bash', input, alwaysAllowTools, bashPrefixExtractor)
              ) return true;
              const result = await confirmToolExecution(rl, 'bash', input, {
                permissionMode: currentPermissionMode,
              });
              if (
                result.confirmed
                && result.always
                && reason === 'mode_boundary'
                && currentPermissionMode === 'accept-edits'
              ) {
                saveAlwaysAllowToolPattern('bash', input, false);
                alwaysAllowTools = loadAlwaysAllowTools();
              }
              return result.confirmed;
            },
          });
      const guardrails = standaloneShellBoundary !== undefined
        && isAutoMode(currentPermissionMode)
        ? [standaloneShellBoundary.autoGuardrail]
        : undefined;
      return {
        ...currentOptions,
        provider: currentConfig.provider,
        model: currentConfig.model,
        effort: resolveCurrentRuntimeEffort().runtimeEffort,
        thinking: currentConfig.thinking,
        reasoningMode: currentConfig.reasoningMode,
        guardrails,
        // workflowRunsBaseDir is inherited from `...currentOptions` (set at
        // session init for FEATURE_246 A5) — no need to re-derive here.
        context: {
          ...currentOptions.context,
          planModeBlockCheck,
          ...(standaloneShellBoundary === undefined
            ? {}
            : {
                shellSandbox: standaloneShellBoundary.shellSandbox,
                resolveShellPermissionMode: standaloneShellBoundary.resolveShellPermissionMode,
                authorizeShellHostExecution: standaloneShellBoundary.authorizeShellHostExecution,
                ...(standaloneShellBoundary.trustedTextMutationHost === undefined
                  ? {}
                  : { trustedTextMutationHost: standaloneShellBoundary.trustedTextMutationHost }),
              }),
        },
        events: {
          ...currentOptions.events,
          onMemoryOutcomeDigest: (digest, metadata) => {
            if (digest.sessionId !== context.sessionId) {
              currentOptions.events?.onMemoryOutcomeDigest?.(digest, metadata);
              return;
            }
            context.lineage = appendMemoryOutcomeDigest(
              context.lineage ?? createSessionLineage(context.messages),
              digest,
              metadata?.jobId,
            );
            currentOptions.events?.onMemoryOutcomeDigest?.(digest, metadata);
          },
          onMemoryReviewReceipt: (receipt) => {
            if (receipt.sessionId !== undefined && receipt.sessionId !== context.sessionId) {
              currentOptions.events?.onMemoryReviewReceipt?.(receipt);
              return;
            }
            context.lineage = appendMemoryReviewReceipt(
              context.lineage ?? createSessionLineage(context.messages),
              receipt,
            );
            currentOptions.events?.onMemoryReviewReceipt?.(receipt);
          },
          onMemoryNotice: (notice) => {
            if (notice.sessionId !== undefined && notice.sessionId !== context.sessionId) {
              currentOptions.events?.onMemoryNotice?.(notice);
              return;
            }
            const lineage = context.lineage ?? createSessionLineage(context.messages);
            const nextLineage = appendMemoryClientNotice(
              lineage,
              { ...notice, createdAt: new Date().toISOString() },
            );
            context.lineage = nextLineage;
            if (nextLineage !== lineage) {
              console.log(chalk.dim(`\n[memory] ${notice.summaries.slice(0, 3).join('; ')}`));
            }
            currentOptions.events?.onMemoryNotice?.(notice);
          },
          // FEATURE_074: exit_plan_mode tool callback. Three-state return:
          //   'not-in-plan-mode' when called outside plan mode (tool turns this
          //   into an explicit error); true on approval; false on rejection.
          // buildToolConfirmationDisplay renders the full plan from input.plan,
          // so the user actually sees what they're approving.
          exitPlanMode: async (plan: string): Promise<boolean | 'not-in-plan-mode'> => {
            if (currentPermissionMode !== 'plan') return 'not-in-plan-mode';
            const result = await confirmToolExecution(rl, 'exit_plan_mode', { plan }, {
              isProtectedPath: false,
              permissionMode: currentPermissionMode,
            });
            if (result.confirmed) {
              currentConfig.permissionMode = 'accept-edits';
              currentPermissionMode = 'accept-edits';
              refreshCurrentEffort();
              return true;
            }
            return false;
          },
          // Permission control via beforeToolExecute hook - 通过 beforeToolExecute 钩子控制权限
          beforeToolExecute: async (tool: string, input: Record<string, unknown>): Promise<boolean | string> => {
            const mode = currentPermissionMode;
            const confirmTools = computeConfirmTools(mode);

            if (mode === 'plan') {
              const planModeBlockReason = getPlanModeBlockReason(tool, input, gitRoot ?? process.cwd());
              if (planModeBlockReason) {
                console.log(chalk.yellow(planModeBlockReason));
                return `${planModeBlockReason} Do not modify files while planning. Finish the plan first, then call exit_plan_mode with the finalized plan — the user will review and approve or reject.`;
              }
            }

            // Standalone Bash always enters the Coding-owned sandbox/host
            // boundary. Mode review and Edits prompts happen there.
            if (!options.runtimeRunner && tool === 'bash') return true;

            // All modes: safe read-only bash commands are auto-allowed BEFORE protected path check
            // 所有模式：安全的只读 bash 命令在受保护路径检查之前就自动放行
            if (tool === 'bash') {
              const command = (input.command as string) ?? '';
              if (isBashReadCommandAutoAllowed(
                command,
                gitRoot ?? process.cwd(),
                activeRuntime.executionCwd ?? gitRoot ?? process.cwd(),
              )) {
                return true; // Auto-allowed for safe read-only commands
              }
            }

            if (mode === 'full-access') {
              return true;
            }

            // Auto has a single decision owner. The runner guardrail has
            // already reviewed this exact call before this legacy observer is
            // invoked, so protected-path and confirmTools checks below must
            // not manufacture a second approval after an LLM allow. Explicit
            // reviewed it before this observer runs.
            if (isAutoMode(mode)) {
              return true;
            }

            // Protected paths: always confirm
            if (gitRoot && FILE_MODIFICATION_TOOLS.has(tool)) {
              const targetPath = input.path as string | undefined;
              if (targetPath && isAlwaysConfirmPath(targetPath, gitRoot)) {
                const result = await confirmToolExecution(rl, tool, input, {
                  isProtectedPath: true,
                  permissionMode: mode,
                });
                if (!result.confirmed) {
                  console.log(chalk.dim('[Cancelled] Operation on protected path requires confirmation'));
                  return false;
                }
                return true;
              }
            }

            // Check if tool needs confirmation based on mode
            if (confirmTools.has(tool)) {
              // Check alwaysAllowTools in accept-edits mode for bash.
              // FEATURE_153: pass LLM extractor (constructed at REPL bootstrap;
              // see bashPrefixExtractor below) so allowlist patterns match
              // against extracted safe prefix instead of naive startsWith.
              if (mode === 'accept-edits' && tool === 'bash') {
                if (
                  await isToolCallAllowed(
                    tool,
                    input,
                    alwaysAllowTools,
                    bashPrefixExtractor,
                  )
                ) {
                  return true;
                }
              }

              // Show confirmation dialog
              const result = await confirmToolExecution(rl, tool, input, {
                isOutsideProject: input._outsideProject === true,
                reason: input._reason as string | undefined,
                permissionMode: mode,
              });

              if (!result.confirmed) {
                console.log(chalk.dim('[Cancelled] Operation cancelled by user'));
                return false;
              }

              // Handle "always" selection
              if (result.always) {
                if (mode === 'accept-edits') {
                  saveAlwaysAllowToolPattern(tool, input, false);
                  alwaysAllowTools = loadAlwaysAllowTools();
                }
              }
            }

            return true;
          },
        },
      };
    },
    // Pass readline interface for commands requiring user interaction - 传递 readline 接口供需要用户交互的命令使用
    reloadAgentsFiles: async () => {
      agentsFiles = await reloadAgentsFiles();
      return agentsFiles;
    },
    readline: rl,
    ui: new ReadlineUIContext(rl),
  };

  const appendPersistedUiHistoryItem = async (item: KodaXSessionUiHistoryItem): Promise<void> => {
    context.uiHistory = [...(context.uiHistory ?? []), item];
    const title = context.title || extractTitle(context.messages);
    context.title = title;
    await storage.save(context.sessionId, {
      messages: context.messages,
      title,
      gitRoot: context.gitRoot ?? '',
      runtimeInfo: context.runtimeInfo,
      lineage: context.lineage,
      artifactLedger: context.artifactLedger,
      uiHistory: context.uiHistory,
      ...contextExtensionSessionData(context),
      ...(currentOptions.session?.tag !== undefined ? { tag: currentOptions.session.tag } : {}),
    });
  };

  const maybeRecoverAfterProviderError = async (error: Error, prompt: string): Promise<boolean> => {
    if (!shouldOfferSessionRecovery({ error, messageCount: context.messages.length })) {
      return false;
    }
    console.log(chalk.dim(`\n${SESSION_RECOVERY_HINT_MESSAGE}`));
    try {
      await appendPersistedUiHistoryItem({
        type: 'info',
        text: SESSION_RECOVERY_HINT_MESSAGE,
      });
    } catch (historyError: unknown) {
      const message = historyError instanceof Error ? historyError.message : String(historyError);
      console.log(chalk.dim(`Could not persist recovery hint: ${message}`));
    }
    const confirm = resolveConfirm(callbacks);
    if (!confirm) {
      console.log();
      return false;
    }

    const approved = await confirm(SESSION_RECOVERY_CONFIRM_MESSAGE);
    if (!approved) {
      return false;
    }

    let status: SessionRecoverStatus | undefined;
    try {
      status = await callbacks.recoverSession?.(prompt);
    } catch (recoverError: unknown) {
      const message = recoverError instanceof Error ? recoverError.message : String(recoverError);
      console.log(chalk.red(`\n[Recover failed] ${message}`));
      return false;
    }
    if (status === 'failed') {
      console.log(chalk.dim('Recovery session was created, but the continuation request still failed.\n'));
    }
    return status === 'recovered';
  };

  // Handle Ctrl+C - 处理 Ctrl+C
  rl.on('SIGINT', async () => {
    console.log(chalk.dim('\n\n[Press /exit to quit]'));
    rl.prompt();
  });

  // Handle cleanup on exit
  const cleanup = () => {
    // FEATURE_125 — fire-and-forget Team Mode shutdown. The
    // state-writer's shutdown() does its work synchronously
    // (clearInterval + fs.rmSync) before the trailing
    // `await Promise.resolve()`, so the instance directory is
    // gone by the time the 'exit' handler returns even though
    // the promise is unawaited.
    void teamModeHandle?.shutdown();
    rl.close();
  };

  process.on('exit', cleanup);
  process.on('SIGTERM', cleanup);

  const startWorkflowInvocation = async (
    workflow: CommandWorkflowInvocationRequest,
    rawInput: string,
  ): Promise<boolean> => {
    const decision = decideWorkflowInvocation({ source: workflow.source });

    // FEATURE_246 A5 (ADR-047): this launcher is reached only from a parsed
    // `/workflow` command (the natural-language intercept was removed), so the
    // policy returns 'suggest'. 'none' stays as a defensive guard.
    if (decision.action === 'none') {
      return false;
    }

    let workflowUserCommitted = false;
    const commitWorkflowFinal = (text: string): void => {
      if (!workflowUserCommitted) {
        workflowUserCommitted = true;
        context.messages.push({
          role: 'user',
          content: rawInput || workflow.request,
          // GOAL 2: real time for the workflow-commit echo (bypasses runner/substrate).
          timestamp: new Date().toISOString(),
        });
      }
      context.messages.push({ role: 'assistant', content: text, timestamp: new Date().toISOString() });
      const title = extractTitle(context.messages);
      context.title = title;
      void storage.save(context.sessionId, {
        messages: context.messages,
        title,
        gitRoot: context.gitRoot ?? '',
        runtimeInfo: context.runtimeInfo,
        artifactLedger: context.artifactLedger,
        ...(currentOptions.session?.tag !== undefined ? { tag: currentOptions.session.tag } : {}),
      }).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.log(chalk.red(`\n[workflow] failed to save final answer: ${message}\n`));
      });
    };
    const workflowCallbacks: CommandCallbacks = {
      ...callbacks,
      onWorkflowRunMessage: (event) => {
        if (event.type === 'event') return;
        const text = event.text.trimEnd();
        if (!text.trim()) return;
        if (event.type === 'error') {
          console.log(chalk.red(`\n${text}\n`));
          return;
        }
        if (event.type === 'success') {
          console.log(chalk.green(`\n${text}\n`));
          return;
        }
        if (event.type === 'assistant') {
          console.log(`\n${text}\n`);
          if (event.final === true) {
            commitWorkflowFinal(text);
          }
          return;
        }
        console.log(chalk.dim(`\n${text}\n`));
      },
    };

    const outcome = await startGeneratedWorkflowFromRequest({
      request: workflow.request,
      callbacks: workflowCallbacks,
      approval: currentConfig.permissionMode === 'plan' ? 'required' : 'silent',
      presentation: 'agentic',
      sourceLabel: workflow.displayName,
      processSource: workflow.processSource ?? 'command',
      ...(workflow.builtin !== undefined ? { builtin: workflow.builtin } : {}),
    });

    return workflowStartOutcomeConsumesTurn({ outcome });
  };

  const handleCommandResult = async (
    result: Awaited<ReturnType<typeof executeCommand>>,
    rawInput: string
  ): Promise<void> => {
    if (!result || typeof result !== 'object') {
      return;
    }

    if (result.workflow) {
      await startWorkflowInvocation(result.workflow, rawInput);
      return;
    }

    if (!result.invocation) {
      return;
    }

    const prepared = await prepareInvocationExecution(
      {
        ...currentOptions,
        provider: currentConfig.provider,
        thinking: currentConfig.thinking,
        reasoningMode: currentConfig.reasoningMode,
      },
      result.invocation,
      rawInput,
      (message) => console.log(chalk.dim(`\n${message}`))
    );

    if (prepared.mode === 'manual') {
      if (prepared.manualOutput) {
        console.log(chalk.yellow(`\n${prepared.manualOutput}\n`));
      }
      await prepared.finalize();
      return;
    }

    if (!prepared.prompt || !prepared.options) {
      await prepared.finalize();
      return;
    }

    try {
      const initialMessages = prepared.mode === 'fork' ? [] : context.messages;
      const runResult = await runAgentRound(
        prepared.options,
        context,
        prepared.prompt,
        initialMessages,
        undefined,
        options.runtimeRunner,
        currentPermissionMode,
        requestRuntimePermission,
        runtimeAutoModeSettings,
      );

      if (prepared.mode === 'fork') {
        const assistantText = extractLastAssistantText(runResult.messages);
        if (assistantText.trim()) {
          console.log(`\n${assistantText}\n`);
          // GOAL 2: real time for the fork-mode assistant echo (manual push).
          context.messages.push({ role: 'assistant', content: assistantText, timestamp: new Date().toISOString() });
        }
      } else {
        context.messages = runResult.messages;
        context.contextTokenSnapshot = runResult.contextTokenSnapshot;
      }
      applyRuntimeSessionSnapshot(context, runResult);

      if (context.messages.length > 0) {
        const title = extractTitle(context.messages);
        context.title = title;
        await storage.save(context.sessionId, {
          messages: context.messages,
          title,
          gitRoot: context.gitRoot ?? '',
          runtimeInfo: context.runtimeInfo,
          ...contextExtensionSessionData(context),
          ...(currentOptions.session?.tag !== undefined ? { tag: currentOptions.session.tag } : {}),
        });
        markExtensionSessionPersisted(context);
      }
      await prepared.finalize();
    } catch (error) {
      await prepared.finalize(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  };

  const resolveInlineSkillInvocation = async (input: string) => {
    try {
      return {
        invocation: await resolveUserSkillInvocation(input, {
          workingDirectory: currentOptions.context?.executionCwd ?? process.cwd(),
          projectRoot: context.gitRoot ?? undefined,
          sessionId: context.sessionId,
          environment: {},
          executeDynamicContext: context.skillDynamicContext?.execute,
          disableDynamicContext: context.skillDynamicContext?.disable,
        }),
        rejected: false,
      } as const;
    } catch (error: unknown) {
      if (!(error instanceof MultipleUserSkillReferencesError)) throw error;
      console.log(chalk.yellow(`\n${error.message}\n`));
      return { invocation: undefined, rejected: true } as const;
    }
  };

  // Main loop - 主循环
  while (isRunning) {
    // Check if need to edit last message (Esc+Esc triggered) - 检查是否需要编辑上一条消息 (Esc+Esc 触发)
    if (pendingEdit && lastUserMessage) {
      pendingEdit = false;
      rl.resume();  // Resume readline - 恢复 readline
      // Open last message in external editor - 在外部编辑器中打开上一条消息
      const edited = await openExternalEditor(lastUserMessage);
      if (edited && edited.trim() && edited !== lastUserMessage) {
        // If modified, process as new input - 如果有修改，作为新输入处理
        console.log(chalk.dim(`\n[Edited message ready to send]`));
        // Process edited content directly, skip askInput - 直接处理编辑后的内容，跳过 askInput
        const trimmed = edited.trim();
        touchContext(context);
        autoModeBootstrap.resetTurn();

        // Process command - 处理命令
        const parsed = parseCommand(trimmed);
        if (parsed) {
          const commandResult = await executeCommand(
            parsed,
            context,
            callbacks,
            currentConfig,
            trimmed,
          );
          await handleCommandResult(commandResult, trimmed);
          continue;
        }
        // Process special syntax and update lastUserMessage - 处理特殊语法并更新 lastUserMessage
        const processed = await processSpecialSyntax(
          trimmed,
          currentOptions.context?.executionCwd,
        );
        if (trimmed.startsWith('!') && isShellCommandHandled(processed)) {
          continue;
        }
        const inlineSkill = await resolveInlineSkillInvocation(trimmed);
        if (inlineSkill.rejected) continue;
        if (inlineSkill.invocation) {
          await handleCommandResult({ invocation: inlineSkill.invocation }, trimmed);
          continue;
        }
        // FEATURE_246 A5 (ADR-047): natural language is never intercepted into a
        // host-generated workflow; it flows to the agent, which authors workflows
        // itself via the run_workflow tool. Only `/workflow` commands launch here.
        const preparedArtifacts = preparePromptInputArtifacts(
          processed,
          currentOptions.context?.executionCwd ?? process.cwd(),
        );
        for (const warning of preparedArtifacts.warnings) {
          console.log(chalk.yellow(`\n${warning}`));
        }
        context.messages.push({ role: 'user', content: preparedArtifacts.messageContent });
        lastUserMessage = trimmed;

        // Run agent (copy main loop logic) - 运行 agent (复制主循环逻辑)
        // FEATURE_192 v0.7.44 — build the goal runtime binding so the
        // runner-driven adapter can wire turn-end accounting + auto-
        // continue on a Worker text-only termination. Default ON; the
        // binding is a no-op until the user creates a goal via `/goal`
        // or the model calls `create_goal` (the ADR-033 §1 prompt
        // discourages autonomous goal creation on simple tasks).
        const goalRuntime =
          context.lineage
            ? buildGoalRuntimeBinding({
                getLineage: () => context.lineage!,
                setLineage: (next) => {
                  context.lineage = next;
                },
                saveSession: async () => {
                  await storage.save(context.sessionId, {
                    messages: context.messages,
                    title: context.title ?? extractTitle(context.messages),
                    gitRoot: context.gitRoot ?? '',
                    runtimeInfo: context.runtimeInfo,
                    artifactLedger: context.artifactLedger,
                    lineage: context.lineage,
                    ...contextExtensionSessionData(context),
                    ...(currentOptions.session?.tag !== undefined ? { tag: currentOptions.session.tag } : {}),
                  });
                  markExtensionSessionPersisted(context);
                },
                // getLatestUsage + getTurnStartMs are overridden inside
                // runner-driven.ts (it owns the per-turn token state +
                // turn-start clock). Stubs here.
                getLatestUsage: () => undefined,
                getTurnStartMs: () => undefined,
                getPermissionMode: () => currentPermissionMode,
                // user-priority `mode:'prompt'` messages on the main
                // queue mean the user is typing — defer goal auto-
                // continue so their input lands naturally.
                hasPendingUserInput: () =>
                  getMessageQueue().has({
                    agentId: actorQueueId(context.sessionId, '/root'),
                    maxPriority: 'user',
                    mode: 'prompt',
                  }),
                // STUB — Commit 3 of the v0.7.44 review-cycle replaces
                // this with a real verifier wire that closes over the
                // runner's per-turn transcript + fileEdits. Until the
                // adapter extraction lands (Commit 2 of the same cycle),
                // verifyComplete is constructed inside runner-driven.ts
                // (where transcript/edits are accessible) and overrides
                // the stub via the same dep-injection pattern as
                // getLatestUsage / getTurnStartMs.
                verifyComplete: async () => ({ ok: true }),
              })
            : undefined;

        try {
          const result = await runManagedTask(
            {
              ...currentOptions,
              provider: currentConfig.provider,
              thinking: currentConfig.thinking,
              reasoningMode: currentConfig.reasoningMode,
              session: {
                ...currentOptions.session,
                // FEATURE_072: Scout / managed-task workers inherit the
                // derived view (summary + attachments + kept tail) when a
                // lineage is available, instead of the flat `context.messages`
                // snapshot. Behaviour is identical post-072-Phase-B because
                // lineage is reconciled on every compaction; the derived
                // view is preferred as the authoritative source.
                initialMessages: context.lineage
                  ? getSessionMessagesFromLineage(context.lineage, context.lineage.activeEntryId)
                  : context.messages,
                initialExtensionState: context.extensionState ?? {},
                initialExtensionRecords: context.extensionRecords ?? [],
              },
              context: {
                ...currentOptions.context,
                taskSurface: 'repl',
                // FEATURE_074: live plan-mode check for child-agent inheritance.
                // Separate code path from createKodaXOptions — must propagate too.
                planModeBlockCheck: (tool: string, input: Record<string, unknown>): string | null => {
                  if (currentPermissionMode !== 'plan') return null;
                  return getPlanModeBlockReason(tool, input, gitRoot ?? process.cwd());
                },
                ...(preparedArtifacts.inputArtifacts.length > 0
                  ? { inputArtifacts: preparedArtifacts.inputArtifacts }
                  : {}),
                ...(goalRuntime ? { goalRuntime } : {}),
              },
            },
            processed
          );
          context.messages = result.messages;
          context.contextTokenSnapshot = result.contextTokenSnapshot;
          applyRuntimeSessionSnapshot(context, result);
          // FEATURE_076: prefer pre-extracted result.artifactLedger; fall
          // back to walking result.messages for backward compatibility
          // with paths that have not yet been reshape-updated.
          context.artifactLedger = mergeArtifactLedger(
            context.artifactLedger ?? [],
            (result.artifactLedger as typeof context.artifactLedger | undefined)
              ?? extractArtifactLedger(result.messages),
          );

          // Auto save - 自动保存
          if (context.messages.length > 0) {
            const title = extractTitle(context.messages);
            context.title = title;
            await storage.save(context.sessionId, {
              messages: context.messages,
              title,
              gitRoot: context.gitRoot ?? '',
              runtimeInfo: context.runtimeInfo,
              artifactLedger: context.artifactLedger,
              ...contextExtensionSessionData(context),
              ...(currentOptions.session?.tag !== undefined ? { tag: currentOptions.session.tag } : {}),
            });
            markExtensionSessionPersisted(context);
          }
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          context.messages.pop();
          console.log(chalk.red(`\n[Error] ${error.message}`));
          if (await maybeRecoverAfterProviderError(error, processed)) {
            continue;
          }
        }
        continue;
      } else if (edited === lastUserMessage) {
        console.log(chalk.dim('\n[No changes made, continuing...]'));
      }
    }

    const prompt = getPrompt(currentConfig.permissionMode, currentConfig);
    const input = await askInput(rl, prompt);

    if (!isRunning) break;

    const trimmed = input.trim();
    if (!trimmed) continue;

    touchContext(context);
    autoModeBootstrap.resetTurn();

    // Process command - 处理命令
    const parsed = parseCommand(trimmed);
    if (parsed) {
      const commandResult = await executeCommand(
        parsed,
        context,
        callbacks,
        currentConfig,
        trimmed,
      );
      await handleCommandResult(commandResult, trimmed);
      continue;
    }
    // Process special syntax - 处理特殊语法
    const processed = await processSpecialSyntax(
      trimmed,
      currentOptions.context?.executionCwd,
    );

    // Shell command handling: Warp style - Shell 命令处理：Warp 风格
    // - Success → skip (result shown) - 成功执行 → 跳过（结果已显示）
    // - Empty command → skip (user knows) - 空命令 → 跳过（用户知道）
    // - Failure/Error → send to LLM (needs smart help) - 失败/错误 → 发送给 LLM（需要智能帮助）
    if (trimmed.startsWith('!')) {
      if (isShellCommandHandled(processed)) {
        continue;
      }
    }
    const inlineSkill = await resolveInlineSkillInvocation(trimmed);
    if (inlineSkill.rejected) continue;
    if (inlineSkill.invocation) {
      await handleCommandResult({ invocation: inlineSkill.invocation }, trimmed);
      continue;
    }

    // Add user message to context - 添加用户消息到上下文
    // FEATURE_246 A5 (ADR-047): no natural-language workflow intercept — NL flows
    // to the agent (which owns run_workflow); only `/workflow` commands launch.
    const preparedArtifacts = preparePromptInputArtifacts(
      processed,
      currentOptions.context?.executionCwd ?? process.cwd(),
    );
    for (const warning of preparedArtifacts.warnings) {
      console.log(chalk.yellow(`\n${warning}`));
    }
    context.messages.push({ role: 'user', content: preparedArtifacts.messageContent });

    // Save last user message (for Esc+Esc editing) - 保存最后一条用户消息 (用于 Esc+Esc 编辑)
    lastUserMessage = trimmed;

    // Run Agent - 运行 Agent
    try {
      const result = await runAgentRound(
        currentOptions,
        context,
        processed,
        context.messages,
        preparedArtifacts.inputArtifacts,
        options.runtimeRunner,
        currentPermissionMode,
        requestRuntimePermission,
        runtimeAutoModeSettings,
      );

      // Update context messages (runKodaX returns complete message list) - 更新上下文中的消息（runKodaX 返回完整的消息列表）
      context.messages = result.messages;
      context.contextTokenSnapshot = result.contextTokenSnapshot;
      applyRuntimeSessionSnapshot(context, result);
      // FEATURE_076: prefer pre-extracted result.artifactLedger; fall back
      // to walking result.messages for backward compatibility with paths
      // that have not yet been reshape-updated.
      context.artifactLedger = mergeArtifactLedger(
        context.artifactLedger ?? [],
        (result.artifactLedger as typeof context.artifactLedger | undefined)
          ?? extractArtifactLedger(result.messages),
      );

      // Auto save - 自动保存
      if (context.messages.length > 0) {
        const title = extractTitle(context.messages);
        context.title = title;
        await storage.save(context.sessionId, {
          messages: context.messages,
          title,
          gitRoot: context.gitRoot ?? '',
          runtimeInfo: context.runtimeInfo,
          artifactLedger: context.artifactLedger,
          ...contextExtensionSessionData(context),
          ...(currentOptions.session?.tag !== undefined ? { tag: currentOptions.session.tag } : {}),
        });
        markExtensionSessionPersisted(context);
      }
    } catch (err) {
      // Handle different error types - 处理不同类型的错误
      const error = err instanceof Error ? err : new Error(String(err));

      // Remove failed user message (avoid duplicates) - 移除失败的用户消息（避免重复）
      context.messages.pop();

      // Provide recovery suggestions based on error type - 根据错误类型提供不同的恢复建议
      if (error.message.includes('rate limit') || error.message.includes('Rate limit')) {
        console.log(chalk.yellow(`\n[Rate Limit] ${error.message}`));
        console.log(chalk.dim('Suggestion: Wait a moment and try again, or switch provider with /mode\n'));
      } else if (error.message.includes('API key') || error.message.includes('not configured')) {
        console.log(chalk.red(`\n[Configuration Error] ${error.message}`));
        console.log(chalk.dim('Suggestion: Set the required API key environment variable\n'));
      } else if (error.message.includes('network') || error.message.includes('ECONNREFUSED') || error.message.includes('ETIMEDOUT')) {
        console.log(chalk.red(`\n[Network Error] ${error.message}`));
        console.log(chalk.dim('Suggestion: Check your internet connection and try again\n'));
      } else if (error.message.includes('token') || error.message.includes('context too long')) {
        console.log(chalk.yellow(`\n[Context Error] ${error.message}`));
        console.log(chalk.dim('Suggestion: Use /clear to start a fresh conversation\n'));
      } else {
        console.log(chalk.red(`\n[Error] ${error.message}`));
        console.log(chalk.dim('Your message was not sent. Please try again.\n'));
      }
      await maybeRecoverAfterProviderError(error, processed);
    }
  }
}

// Get prompt (responsive, using theme colors) - 获取提示符 (响应式，使用主题颜色)
export async function processSpecialSyntax(
  input: string,
  executionCwd: string = process.cwd(),
): Promise<string> {
  // @path syntax: attach image artifacts to context - @path 语法：将图片工件附加到上下文
  const fileRefs = input.match(/@[\w./-]+/g);
  if (fileRefs) {
    for (const ref of fileRefs) {
      const filePath = ref.slice(1); // Remove @ - 移除 @
      // Can read file and add to context here - 这里可以读取文件并添加到上下文
      // Temporarily keep as is, implement later - 暂时保留原样，后续实现
    }
  }

  // !command syntax: execute shell command - !command 语法：执行 shell 命令
  if (input.startsWith('!')) {
    const command = input.slice(1).trim();
    return executeShellCommand(command, { cwd: executionCwd });
  }

  return input;
}

// Run one round of Agent - 运行一轮 Agent
// FEATURE_246 (P1 review): concise console progress for the model-launched
// run_workflow path. The Ink UI renders a live work-strip; the plain console REPL
// just prints start / finish (and any runtime-surfaced message) so an inline
// workflow is not an opaque long tool call. Stateless — one line per event, and
// only on the events worth surfacing (no per-agent spam).
function renderInlineWorkflowProcessLine(event: WorkflowProcessEvent): string | undefined {
  const s = event.snapshot;
  if (event.type === 'workflow_started') {
    return chalk.dim(`\n▶ workflow ${s.workflowName} started (${s.runId})`);
  }
  if (event.type === 'workflow_finished') {
    const mark = s.status === 'completed' ? chalk.green('✓')
      : s.status === 'failed' ? chalk.red('✗')
      : chalk.yellow('•');
    const summary = s.resultSummary ? ` — ${s.resultSummary.split('\n')[0]}` : '';
    return `${mark} workflow ${s.workflowName} ${s.status}${summary}`;
  }
  if (event.type === 'workflow_updated' && event.message) {
    return chalk.dim(`  ${event.message}`);
  }
  return undefined;
}

async function runAgentRound(
  options: KodaXOptions,
  context: InteractiveContext,
  prompt: string,
  initialMessages: KodaXMessage[] = context.messages,
  inputArtifacts?: readonly KodaXInputArtifact[],
  runtimeRunner?: ReplRuntimeRunner,
  permissionMode: PermissionMode = 'accept-edits',
  requestPermission?: ReplRuntimePermissionPrompt,
  autoModeSettings?: ReplRuntimeAutoModeSettings,
): Promise<KodaXResult> {
  // Create event callbacks - 创建事件回调
  const events = {
    ...(options.events ?? {}),
    getCostReport: costReportRef,
    // FEATURE_246 (P1 review): surface inline run_workflow progress in the console.
    onWorkflowProcessEvent: (event: WorkflowProcessEvent) => {
      const line = renderInlineWorkflowProcessLine(event);
      if (line) console.log(line);
    },
    // ADR-049: print each workflow child agent's completion digest so the
    // console REPL keeps the same scrollback record the Ink UI + slash path do.
    onWorkflowAgentDigest: ({ runId, event }: KodaXWorkflowAgentDigestEvent) => {
      const data = event.data ?? {};
      const summary = typeof data.summary === 'string' ? data.summary : undefined;
      const name = typeof data.name === 'string' ? data.name : undefined;
      const locale = inferWorkflowLocaleFromParts(summary, name);
      const digest = formatWorkflowAgentDigest(event, locale, runId);
      if (digest) console.log(`\n${digest}\n`);
    },
    onCompactedMessages: async (
      messages: KodaXMessage[],
      update?: CompactionUpdate,
      meta?: KodaXActivityEventMeta,
    ) => {
      const durableLineage = prepareRootCompactionLineage(
        context.lineage,
        messages,
        update,
        meta,
      );
      if (!durableLineage) {
        await options.events?.onCompactedMessages?.(messages, update, meta);
        return;
      }
      context.messages = messages;
      context.lineage = durableLineage;
      if (update?.artifactLedger?.length) {
        context.artifactLedger = mergeArtifactLedger(
          context.artifactLedger ?? [],
          update.artifactLedger,
        );
      }
      if (runtimeRunner) {
        // Runtime-owned runs commit exact lineage before invoking this local
        // projection. Do not re-enter Session storage through a second writer.
        context.lineage = evictOldIslandMessageContent(durableLineage);
      } else {
        const storage = options.session?.storage;
        if (!storage) {
          throw new Error('Classic REPL compaction requires Session storage.');
        }
        try {
          await storage.save(context.sessionId, {
            messages,
            title: extractTitle(messages),
            gitRoot: context.gitRoot ?? '',
            runtimeInfo: context.runtimeInfo,
            lineage: durableLineage,
            artifactLedger: context.artifactLedger,
            ...contextExtensionSessionData(context),
            ...(options.session?.tag !== undefined ? { tag: options.session.tag } : {}),
          });
          context.lineage = evictOldIslandMessageContent(durableLineage);
        } catch (error: unknown) {
          emitKodaXDiagnostic({
            source: 'repl:compaction',
            level: 'error',
            message: 'Failed to durably persist compacted session history.',
            detail: error,
          });
          throw error;
        }
      }
      await options.events?.onCompactedMessages?.(messages, update, meta);
    },
  };

  syncClassicCliSkillsPrompt(context.gitRoot, options);

  const runOptions: KodaXOptions = {
    ...options,
    events,
    session: {
      ...options.session,
      initialExtensionState: context.extensionState ?? {},
      initialExtensionRecords: context.extensionRecords ?? [],
      initialMessages,
    },
    context: {
      ...options.context,
      contextTokenSnapshot: context.contextTokenSnapshot,
      taskSurface: 'repl',
      ...(inputArtifacts && inputArtifacts.length > 0
        ? { inputArtifacts: [...inputArtifacts] }
        : {}),
    },
  };
  if (runtimeRunner) {
    return runtimeRunner({
      options: runOptions,
      prompt,
      sessionId: context.sessionId,
      permissionMode,
      ...(autoModeSettings !== undefined ? { autoModeSettings } : {}),
      ...(requestPermission !== undefined ? { requestPermission } : {}),
      legacyPermissionHook: true,
    });
  }
  return runManagedTask(runOptions, prompt);
}

// Extract title from messages - 从消息中提取标题
function extractTitle(messages: KodaXMessage[]): string {
  return extractSessionTitle(messages);
}

// Print startup Banner (using theme colors) - 打印启动 Banner (使用主题颜色)
// FEATURE_200 Phase E: readline/input helpers extracted to ./readline-helpers.ts.
import { getPrompt, askInput, openExternalEditor, needsContinuation } from './readline-helpers.js';

// FEATURE_200 Phase E: startup banner extracted to ./startup-banner.ts.
import { printStartupBanner, printWorkspaceEntryNotice } from './startup-banner.js';
