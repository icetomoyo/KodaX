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
  KodaXMessage,
  KodaXResult,
  KodaXReasoningMode,
  KodaXSessionData,
  mergeArtifactLedger,
  runManagedTask,
  resolveRepoIntelligenceRuntimeConfig,
  appendSessionLineageLabel,
  buildSessionTree,
  countActiveLineageMessages,
  createSessionLineage,
  estimateTokens,
  forkSessionLineage,
  generateSessionId as generateCoreSessionId,
  findPreviousUserEntryId,
  getSessionMessagesFromLineage,
  rewindSessionLineage,
  KodaXSessionStorage,
  KodaXError,
  KodaXRateLimitError,
  KodaXProviderError,
  KODAX_DEFAULT_PROVIDER,
  setSessionLineageActiveEntry,
  getCustomProvider,
} from '@kodax/coding';
import type { AgentsFile } from '@kodax/coding';
import type { PermissionMode, ConfirmResult } from '../permission/types.js';
import { computeConfirmTools, FILE_MODIFICATION_TOOLS, normalizePermissionMode } from '../permission/types.js';
import { isToolCallAllowed, isAlwaysConfirmPath, isBashReadCommand, getPlanModeBlockReason } from '../permission/permission.js';
import { getGitRoot, prepareRuntimeConfig, getProviderModel, getProviderAvailableModels, KODAX_VERSION } from '../common/utils.js';
import {
  InteractiveContext,
  InteractiveMode,
  createInteractiveContext,
  generateSessionId as generateInteractiveSessionId,
  touchContext,
} from './context.js';
import {
  parseCommand,
  executeCommand,
  CommandCallbacks,
  CurrentConfig,
} from './commands.js';
import { runWithPlanMode } from '../common/plan-mode.js';
import { loadCompactionConfig } from '../common/compaction-config.js';
import { loadAlwaysAllowTools, saveAlwaysAllowToolPattern } from '../common/permission-config.js';
import {
  confirmToolExecution,
  getTerminalWidth,
} from './prompts.js';
import {
  StatusBar,
  createStatusBarState,
  supportsStatusBar,
  formatTokenCount,
} from './status-bar.js';
import {
  createCompleter,
  getCompletionSuggestions,
  type Completion,
} from './autocomplete.js';
import { getCurrentTheme, setTheme, type Theme } from './themes.js';
import { ReadlineUIContext } from '../ui/readline-ui.js';
import { extractLastAssistantText, extractTitle as extractSessionTitle } from '../ui/utils/message-utils.js';
import { executeShellCommand, isShellCommandHandled } from '../ui/utils/shell-executor.js';
import { prepareInvocationExecution } from './invocation-runtime.js';
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

// Extended session storage interface (adds list method) - 扩展的会话存储接口（增加 list 方法）
interface SessionStorage extends KodaXSessionStorage {
  list(gitRoot?: string): Promise<Array<{
    id: string;
    title: string;
    msgCount: number;
    runtimeInfo?: KodaXSessionData['runtimeInfo'];
  }>>;
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

function printWorkspaceEntryNotice(runtimeInfo: InteractiveContext['runtimeInfo']): void {
  if (!runtimeInfo?.workspaceRoot) {
    return;
  }

  console.log(chalk.dim(`  Workspace: ${formatWorkspaceTruth(runtimeInfo)}`));
  console.log(chalk.dim('  Use /status workspace for runtime details.\n'));
}

// REPL options - REPL 选项
export interface RepLOptions extends KodaXOptions {
  storage?: SessionStorage;
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
  const gitRoot = startupRuntime.workspaceRoot ?? await getGitRoot() ?? undefined;
  const storage = options.storage ?? new MemorySessionStorage();

  // Load config (priority: CLI args > config file > defaults) - 加载配置（优先级：CLI参数 > 配置文件 > 默认值）
  const config = prepareRuntimeConfig();

  // Initialize custom providers from config - 从配置初始化自定义 Provider
  const initialProvider = options.provider ?? config.provider ?? KODAX_DEFAULT_PROVIDER;
  const initialModel = options.model ?? config.model;
  const initialReasoningMode = resolveInitialReasoningMode(options, config);
  const initialAgentMode = options.agentMode ?? (config as { agentMode?: 'ama' | 'sa' }).agentMode ?? 'ama';
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
    thinking: initialThinking,
    reasoningMode: initialReasoningMode,
    agentMode: initialAgentMode,
    permissionMode: initialPermissionMode,
    repoIntelligenceMode: repoIntelligenceRuntime.mode,
    repointelEndpoint: repoIntelligenceRuntime.endpoint,
    repointelBin: repoIntelligenceRuntime.bin,
    repoIntelligenceTrace: repoIntelligenceRuntime.trace,
  };

  // Local permission state - 本地权限状态
  let currentPermissionMode: PermissionMode = initialPermissionMode;
  let alwaysAllowTools: string[] = loadAlwaysAllowTools();

  // Plan mode state - Plan mode 状态
  let planMode = false;

  // Esc+Esc edit state - Esc+Esc 编辑状态
  let lastEscTime = 0;
  let lastUserMessage = '';
  let pendingEdit = false;  // Flag for editing last message in external editor - 标记是否需要在外部编辑器中编辑上一条消息
  const ESC_DOUBLE_PRESS_MS = 500;

  const context = await createInteractiveContext({
    sessionId: options.session?.id,
    gitRoot,
    runtimeInfo: startupRuntime,
  });

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
  const { resolveProvider } = await import('@kodax/coding');
  const providerInstance = resolveProvider(currentConfig.provider);
  const effectiveContextWindow = compactionConfig.contextWindow
    ?? providerInstance.getContextWindow?.()
    ?? 200000;

  // Load AGENTS.md files
  const { loadAgentsFiles } = await import('@kodax/coding');
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
    enabled: compactionConfig.enabled,
  }, agentsFiles);
  printWorkspaceEntryNotice(startupRuntime);

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

  // Initialize status bar (if terminal supports) - 初始化状态栏 (如果终端支持)
  const effectiveModel = currentConfig.model ?? getProviderModel(currentConfig.provider) ?? currentConfig.provider;
  let statusBar: StatusBar | null = null;
  if (supportsStatusBar()) {
    statusBar = new StatusBar(createStatusBarState(
      context.sessionId,
      currentConfig.permissionMode,
      currentConfig.provider,
      effectiveModel,
      currentConfig.reasoningMode,
    ));
  }

  // Keyboard shortcut state (Phase 2 will use) - 键盘快捷键状态 (Phase 2 将实际使用)
  // let showToolOutput = true;
  // let showTodoList = false;

  // Keyboard shortcut mapping - 键盘快捷键映射
  const KEYBOARD_SHORTCUTS_HELP = `
Keyboard Shortcuts:
  Tab       Auto-complete (@paths, /commands)
  Esc+Esc   Edit last message
  Ctrl+T    Cycle reasoning mode
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

  let isRunning = true;
  // Fix: Ensure session.id is set to reuse same session - 修复：确保 session.id 被设置以复用同一 session
  let currentOptions: RepLOptions = {
    ...options,
    reasoningMode: initialReasoningMode,
    thinking: initialThinking,
    context: {
      ...options.context,
      gitRoot,
      executionCwd: startupRuntime.executionCwd,
      repoIntelligenceMode: repoIntelligenceRuntime.mode,
      repoIntelligenceTrace: repoIntelligenceRuntime.trace,
    },
    session: {
      ...options.session,
      id: context.sessionId,
    },
  };

  // Cost tracking ref — agent populates this via events.getCostReport, /cost command reads it
  costReportRef.current = null;

  // Command callbacks - 命令回调
  const callbacks: CommandCallbacks = {
    exit: () => {
      isRunning = false;
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
        });
      }
    },
    startNewSession: () => {
      context.sessionId = generateInteractiveSessionId();
      context.title = '';
      context.contextTokenSnapshot = undefined;
      context.artifactLedger = undefined;
      context.createdAt = new Date().toISOString();
      context.lastAccessed = context.createdAt;
      applyRuntimeContext(context, currentOptions, startupRuntime);
      currentOptions.session = {
        ...currentOptions.session,
        id: context.sessionId,
      };
      statusBar?.update({
        sessionId: context.sessionId,
        messageCount: 0,
      });
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
        context.lastAccessed = new Date().toISOString();
        applyRuntimeContext(context, currentOptions, appliedRuntime);
        currentOptions.session = {
          ...currentOptions.session,
          id,
        };
        statusBar?.update({
          sessionId: id,
          messageCount: loaded.messages.length,
        });
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
      currentConfig.provider = provider;
      currentConfig.model = model;
      currentOptions.provider = provider;
      currentOptions.model = model;
      let newModel = model ?? getProviderModel(provider);
      if (!newModel) {
        // Fallback for custom providers - 自定义 Provider 的后备
        try {
          const custom = getCustomProvider(provider);
          newModel = custom?.getModel() ?? provider;
        } catch {
          newModel = provider;
        }
      }
      statusBar?.update({
        provider,
        model: newModel,
      });
    },
    setThinking: (enabled: boolean) => {
      currentConfig.thinking = enabled;
      currentOptions.thinking = enabled;
      currentConfig.reasoningMode = enabled ? 'auto' : 'off';
      currentOptions.reasoningMode = currentConfig.reasoningMode;
      statusBar?.update({ reasoningMode: currentConfig.reasoningMode });
    },
    setReasoningMode: (mode: KodaXReasoningMode) => {
      const thinking = mode !== 'off';
      currentConfig.reasoningMode = mode;
      currentConfig.thinking = thinking;
      currentOptions.reasoningMode = mode;
      currentOptions.thinking = thinking;
      statusBar?.update({ reasoningMode: mode });
    },
    setPermissionMode: (mode: PermissionMode) => {
      currentConfig.permissionMode = mode;
      currentPermissionMode = mode; // Sync with local permission state
      statusBar?.update({ permissionMode: mode });
      // Note: permissionMode is no longer part of KodaXOptions
      // Permission control is handled locally via beforeToolExecute callback
    },
    setRepoIntelligenceRuntime: (update) => {
      if (update.mode !== undefined) {
        currentConfig.repoIntelligenceMode = update.mode;
        process.env.KODAX_REPO_INTELLIGENCE_MODE = update.mode;
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
      if (update.endpoint !== undefined) {
        currentConfig.repointelEndpoint = update.endpoint ?? undefined;
        if (update.endpoint) {
          process.env.KODAX_REPOINTEL_ENDPOINT = update.endpoint;
        } else {
          delete process.env.KODAX_REPOINTEL_ENDPOINT;
        }
      }
      if (update.bin !== undefined) {
        currentConfig.repointelBin = update.bin ?? undefined;
        if (update.bin) {
          process.env.KODAX_REPOINTEL_BIN = update.bin;
        } else {
          delete process.env.KODAX_REPOINTEL_BIN;
        }
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
      statusBar?.update({ messageCount: context.messages.length });
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
      statusBar?.update({
        sessionId: forked.sessionId,
        messageCount: context.messages.length,
      });
      console.log(chalk.green(`\n[Forked session: ${forked.sessionId}]`));
      console.log(chalk.dim(`  Messages: ${forked.data.messages.length}`));
      return 'forked';
    },
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
      statusBar?.update({ messageCount: context.messages.length });
      console.log(chalk.green(`\n[Rewound session${selector ? ` to ${selector}` : ' to previous turn'}]`));
      console.log(chalk.dim(`  Messages: ${rewound.messages.length}`));
      return 'rewound';
    },
    setPlanMode: (enabled: boolean) => {
      planMode = enabled;
    },
    getCostReport: () => costReportRef.current?.() ?? null,
    createKodaXOptions: () => {
      // FEATURE_074: live plan-mode check for child agents. The closure reads
      // currentPermissionMode lazily, so mid-run parent-mode toggles propagate
      // into in-flight children (user flipping plan ↔ accept-edits mid-stream
      // is a common case and was the original request).
      const planModeBlockCheck = (tool: string, input: Record<string, unknown>): string | null => {
        if (currentPermissionMode !== 'plan') return null;
        return getPlanModeBlockReason(tool, input, gitRoot ?? process.cwd());
      };
      return {
        ...currentOptions,
        provider: currentConfig.provider,
        model: currentConfig.model,
        thinking: currentConfig.thinking,
        reasoningMode: currentConfig.reasoningMode,
        context: {
          ...currentOptions.context,
          planModeBlockCheck,
        },
        events: {
          ...currentOptions.events,
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
              statusBar?.update({ permissionMode: 'accept-edits' });
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

            // All modes: safe read-only bash commands are auto-allowed BEFORE protected path check
            // 所有模式：安全的只读 bash 命令在受保护路径检查之前就自动放行
            if (tool === 'bash') {
              const command = (input.command as string) ?? '';
              if (isBashReadCommand(command)) {
                return true; // Auto-allowed for safe read-only commands
              }
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
              // Check alwaysAllowTools in accept-edits mode for bash
              if (mode === 'accept-edits' && tool === 'bash') {
                if (isToolCallAllowed(tool, input, alwaysAllowTools)) {
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

  // Handle Ctrl+C - 处理 Ctrl+C
  rl.on('SIGINT', async () => {
    console.log(chalk.dim('\n\n[Press /exit to quit]'));
    rl.prompt();
  });

  // Handle cleanup on exit - 处理退出时清理状态栏
  const cleanup = () => {
    statusBar?.hide();
    rl.close();
  };

  process.on('exit', cleanup);
  process.on('SIGTERM', cleanup);

  const handleCommandResult = async (
    result: Awaited<ReturnType<typeof executeCommand>>,
    rawInput: string
  ): Promise<void> => {
    if (!result || typeof result !== 'object') {
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
      if (planMode) {
        await runWithPlanMode(prepared.prompt, prepared.options);
        await prepared.finalize();
        return;
      }

      const initialMessages = prepared.mode === 'fork' ? [] : context.messages;
      const runResult = await runAgentRound(
        prepared.options,
        context,
        prepared.prompt,
        initialMessages
      );

      if (prepared.mode === 'fork') {
        const assistantText = extractLastAssistantText(runResult.messages);
        if (assistantText.trim()) {
          console.log(`\n${assistantText}\n`);
          context.messages.push({ role: 'assistant', content: assistantText });
        }
      } else {
        context.messages = runResult.messages;
        context.contextTokenSnapshot = runResult.contextTokenSnapshot;
      }

      statusBar?.update({ messageCount: context.messages.length });
      if (context.messages.length > 0) {
        const title = extractTitle(context.messages);
        context.title = title;
        await storage.save(context.sessionId, {
          messages: context.messages,
          title,
          gitRoot: context.gitRoot ?? '',
          runtimeInfo: context.runtimeInfo,
        });
      }
      await prepared.finalize();
    } catch (error) {
      await prepared.finalize(error instanceof Error ? error : new Error(String(error)));
      throw error;
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

        // Process command - 处理命令
        const parsed = parseCommand(trimmed);
        if (parsed) {
          const commandResult = await executeCommand(parsed, context, callbacks, currentConfig);
          await handleCommandResult(commandResult, trimmed);
          continue;
        }

        // Process special syntax and update lastUserMessage - 处理特殊语法并更新 lastUserMessage
        const processed = await processSpecialSyntax(trimmed);
        if (trimmed.startsWith('!') && isShellCommandHandled(processed)) {
          continue;
        }
        const preparedArtifacts = preparePromptInputArtifacts(
          processed,
          currentOptions.context?.executionCwd ?? process.cwd(),
        );
        for (const warning of preparedArtifacts.warnings) {
          console.log(chalk.yellow(`\n${warning}`));
        }
        context.messages.push({ role: 'user', content: preparedArtifacts.messageContent });
        lastUserMessage = trimmed;
        statusBar?.update({ messageCount: context.messages.length });

        // Run agent (copy main loop logic) - 运行 agent (复制主循环逻辑)
        try {
          if (planMode) {
            await runWithPlanMode(processed, {
              ...currentOptions,
              provider: currentConfig.provider,
              thinking: currentConfig.thinking,
              reasoningMode: currentConfig.reasoningMode,
              context: {
                ...currentOptions.context,
                ...(preparedArtifacts.inputArtifacts.length > 0
                  ? { inputArtifacts: preparedArtifacts.inputArtifacts }
                  : {}),
              },
            });
          } else {
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
                },
              },
              processed
            );
            context.messages = result.messages;
            context.contextTokenSnapshot = result.contextTokenSnapshot;
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
              });
            }
          }
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          context.messages.pop();
          console.log(chalk.red(`\n[Error] ${error.message}`));
        }
        continue;
      } else if (edited === lastUserMessage) {
        console.log(chalk.dim('\n[No changes made, continuing...]'));
      }
    }

    const prompt = getPrompt(currentConfig.permissionMode, currentConfig, planMode);
    const input = await askInput(rl, prompt);

    if (!isRunning) break;

    const trimmed = input.trim();
    if (!trimmed) continue;

    touchContext(context);

    // Process command - 处理命令
    const parsed = parseCommand(trimmed);
    if (parsed) {
      const commandResult = await executeCommand(parsed, context, callbacks, currentConfig);
      await handleCommandResult(commandResult, trimmed);
      continue;
    }

    // Process special syntax - 处理特殊语法
    const processed = await processSpecialSyntax(trimmed);

    // Shell command handling: Warp style - Shell 命令处理：Warp 风格
    // - Success → skip (result shown) - 成功执行 → 跳过（结果已显示）
    // - Empty command → skip (user knows) - 空命令 → 跳过（用户知道）
    // - Failure/Error → send to LLM (needs smart help) - 失败/错误 → 发送给 LLM（需要智能帮助）
    if (trimmed.startsWith('!')) {
      if (isShellCommandHandled(processed)) {
        continue;
      }
    }

    // Add user message to context - 添加用户消息到上下文
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

    // Update status bar message count - 更新状态栏消息数量
    statusBar?.update({ messageCount: context.messages.length });

    // If Plan Mode is enabled, execute in plan mode - 如果启用了 Plan Mode，使用计划模式执行
    if (planMode) {
      try {
        await runWithPlanMode(processed, {
          ...currentOptions,
          provider: currentConfig.provider,
          thinking: currentConfig.thinking,
          reasoningMode: currentConfig.reasoningMode,
          context: {
            ...currentOptions.context,
            ...(preparedArtifacts.inputArtifacts.length > 0
              ? { inputArtifacts: preparedArtifacts.inputArtifacts }
              : {}),
          },
        });
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        console.log(chalk.red(`\n[Plan Mode Error] ${error.message}`));
      }
      continue;
    }

    // Run Agent - 运行 Agent
    try {
      const result = await runAgentRound(
        currentOptions,
        context,
        processed,
        context.messages,
        preparedArtifacts.inputArtifacts,
      );

      // Update context messages (runKodaX returns complete message list) - 更新上下文中的消息（runKodaX 返回完整的消息列表）
      context.messages = result.messages;
      context.contextTokenSnapshot = result.contextTokenSnapshot;
      // FEATURE_076: prefer pre-extracted result.artifactLedger; fall back
      // to walking result.messages for backward compatibility with paths
      // that have not yet been reshape-updated.
      context.artifactLedger = mergeArtifactLedger(
        context.artifactLedger ?? [],
        (result.artifactLedger as typeof context.artifactLedger | undefined)
          ?? extractArtifactLedger(result.messages),
      );

      // Update status bar - 更新状态栏
      statusBar?.update({
        messageCount: context.messages.length,
      });

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
        });
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
    }
  }
}

// Get prompt (responsive, using theme colors) - 获取提示符 (响应式，使用主题颜色)
function getPrompt(mode: string, config: CurrentConfig, planMode: boolean): string {
  const theme = getCurrentTheme();
  const modeColor = mode === 'plan' ? chalk.hex(theme.colors.warning) : chalk.hex(theme.colors.success);
  const model = config.model ?? getProviderModel(config.provider) ?? config.provider;
  const width = getTerminalWidth();

  // Decide prompt detail level based on terminal width - 根据终端宽度决定提示符详细程度
  if (width < 60) {
    // Narrow terminal: minimal prompt - 窄终端：最简提示符
    const modeIndicator = mode === 'plan' ? '?' : theme.symbols.prompt;
    return modeColor(`${modeIndicator} `);
  } else if (width < 100) {
    // Medium width: short prompt - 中等宽度：简短提示符
    const flagChar = planMode
      ? 'P'
      : config.reasoningMode !== 'off'
        ? config.reasoningMode[0]?.toUpperCase() ?? 'R'
        : '';
    const flagPart = flagChar ? chalk.hex(theme.colors.dim)(`[${flagChar}]`) : '';
    return modeColor(`kodax:${mode}${flagPart}> `);
  }

  // Wide terminal: full prompt - 宽终端：完整提示符
  const reasoningFlag = config.reasoningMode !== 'off'
    ? chalk.hex(theme.colors.info)(`[reason:${config.reasoningMode}]`)
    : '';
  const planFlag = planMode ? chalk.hex(theme.colors.accent)('[plan]') : '';
  const flags = [reasoningFlag, planFlag].filter(Boolean).join('');
  return modeColor(`kodax:${mode} (${config.provider}:${model})${flags}> `);
}

// Read input (supports multiline and external editor) - 读取输入 (支持多行和外部编辑器)
async function askInput(rl: readline.Interface, prompt: string): Promise<string> {
  const theme = getCurrentTheme();
  const lines: string[] = [];

  // Read first line - 读取第一行
  const firstLine = await new Promise<string>((resolve) => {
    rl.question(prompt, resolve);
  });

  // Check if user wants to open external editor (Ctrl+E is input as special char) - 检查是否要打开外部编辑器 (Ctrl+E 会被输入为特殊字符)
  if (firstLine === '\x05' || firstLine.toLowerCase() === '/e') {
    const edited = await openExternalEditor(lines.join('\n'));
    return edited;
  }

  lines.push(firstLine);

  // Detect if multiline input is needed - 检测是否需要多行输入
  // 1. Ends with \ (continuation char) - 以 \ 结尾 (续行符)
  // 2. Unclosed brackets/quotes - 括号/引号未闭合
  while (needsContinuation(lines.join('\n'))) {
    const continuationPrompt = chalk.hex(theme.colors.dim)('... ');
    const nextLine = await new Promise<string>((resolve) => {
      rl.question(continuationPrompt, resolve);
    });
    lines.push(nextLine);
  }

  // Process continuation: remove trailing \ - 处理续行符：移除行尾的 \
  const result = lines.join('\n').replace(/\\\n/g, '\n');
  return result;
}

// Open external editor - 打开外部编辑器
// Security note: Use spawnSync instead of execSync to avoid command injection - 安全说明: 使用 spawnSync 代替 execSync 避免命令注入
async function openExternalEditor(initialContent: string): Promise<string> {
  // Use os.tmpdir() to get system-safe temp directory - 使用 os.tmpdir() 获取系统安全的临时目录
  const tmpDir = path.join(os.tmpdir(), 'kodax');
  // Use random suffix to avoid filename conflicts - 使用随机后缀避免文件名冲突
  const tmpFile = path.join(tmpDir, `input-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);

  try {
    // Ensure temp directory exists - 确保临时目录存在
    await fs.promises.mkdir(tmpDir, { recursive: true });
    await fs.promises.writeFile(tmpFile, initialContent, 'utf-8');

    let editor = process.env.EDITOR ?? process.env.VISUAL ??
      (process.platform === 'win32' ? 'notepad.exe' : 'nano');

    // Basic security check: verify editor name doesn't contain path separators or suspicious chars - 基本的安全检查: 验证编辑器名称不包含路径分隔符或可疑字符
    // This prevents some obvious injection attempts but won't stop all attacks - 这可以防止一些明显的注入尝试，但不会阻止所有攻击
    // spawnSync itself doesn't execute through shell, so most command injection is prevented - spawnSync 本身不通过 shell 执行，所以大部分命令注入已被阻止
    if (editor.includes('/') || editor.includes('\\') || editor.includes('&&') || editor.includes('|')) {
      // If editor path contains special chars, try to extract base name - 如果编辑器路径包含特殊字符，尝试提取基本名称
      const baseName = path.basename(editor);
      console.log(chalk.yellow(`\n[Security] Editor path sanitized: ${baseName}`));
      editor = baseName;
    }

    console.log(chalk.dim(`\n[Opening editor: ${editor}]`));

    // Windows notepad special hint - Windows notepad 特殊提示
    const isWindowsNotepad = process.platform === 'win32' &&
      (editor.toLowerCase() === 'notepad' || editor.toLowerCase() === 'notepad.exe');

    if (isWindowsNotepad) {
      console.log(chalk.dim('Note: Please close Notepad manually after editing to continue.\n'));
    } else {
      console.log(chalk.dim('Save and close the editor to continue...\n'));
    }

    // Use spawnSync instead of execSync - avoid shell command injection - 使用 spawnSync 代替 execSync - 避免 shell 命令注入
    // spawnSync executes program directly, args passed as array, not parsed through shell - spawnSync 直接执行程序，参数作为数组传递，不经过 shell 解析
    childProcess.spawnSync(editor, [tmpFile], {
      stdio: 'inherit',
      timeout: 300000, // 5 minutes timeout
      shell: false,    // Explicitly disable shell - 明确禁用 shell
    });

    // Read edited content - 读取编辑后的内容
    const content = await fs.promises.readFile(tmpFile, 'utf-8');
    return content.trim();
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.log(chalk.red(`\n[Editor Error] ${err.message}`));
    return initialContent;
  } finally {
    // Clean up temp file - 清理临时文件
    try {
      await fs.promises.unlink(tmpFile);
    } catch {
      // Ignore cleanup errors - 忽略清理错误
    }
  }
}

// Detect if continuation is needed - 检测是否需要续行
function needsContinuation(input: string): boolean {
  // Ends with \ (continuation char) - 以 \ 结尾（续行符）
  if (input.endsWith('\\') && !input.endsWith('\\\\')) {
    return true;
  }

  // Detect unclosed brackets - 检测未闭合的括号
  const openBrackets = { '(': 0, '[': 0, '{': 0 };
  const closeBrackets = { ')': '(', ']': '[', '}': '{' };
  let inString: string | null = null;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    // Handle strings - 处理字符串
    if ((char === '"' || char === "'" || char === '`') && input[i - 1] !== '\\') {
      if (inString === char) {
        inString = null;
      } else if (inString === null) {
        inString = char;
      }
      continue;
    }

    // Don't detect brackets inside strings - 在字符串内不检测括号
    if (inString) continue;

    // Detect brackets - 检测括号
    if (char in openBrackets) {
      openBrackets[char as keyof typeof openBrackets]++;
    } else if (char in closeBrackets) {
      const openChar = closeBrackets[char as keyof typeof closeBrackets];
      if (openChar) {
        openBrackets[openChar as keyof typeof openBrackets]--;
      }
    }
  }

  // Has unclosed brackets - 有未闭合的括号
  if (Object.values(openBrackets).some(count => count > 0)) {
    return true;
  }

  // Has unclosed string - 有未闭合的字符串
  if (inString) {
    return true;
  }

  return false;
}

// Process special syntax - 处理特殊语法
export async function processSpecialSyntax(input: string): Promise<string> {
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
    return executeShellCommand(command, { cwd: process.cwd() });
  }

  return input;
}

// Run one round of Agent - 运行一轮 Agent
async function runAgentRound(
  options: KodaXOptions,
  context: InteractiveContext,
  prompt: string,
  initialMessages: KodaXMessage[] = context.messages,
  inputArtifacts?: readonly KodaXInputArtifact[],
): Promise<KodaXResult> {
  // Create event callbacks - 创建事件回调
  const events = {
    ...(options.events ?? {}),
    getCostReport: costReportRef,
  };

  // Pass existing conversation history for multi-turn dialogue - 传递已有的对话历史，实现多轮对话
  return runManagedTask(
    {
      ...options,
      events,
      session: {
        ...options.session,
        initialMessages,  // Pass existing messages - 传递已有消息
      },
      context: {
        ...options.context,
        contextTokenSnapshot: context.contextTokenSnapshot,
        taskSurface: 'repl',
        ...(inputArtifacts && inputArtifacts.length > 0
          ? { inputArtifacts: [...inputArtifacts] }
          : {}),
      },
    },
    prompt
  );
}

// Extract title from messages - 从消息中提取标题
function extractTitle(messages: KodaXMessage[]): string {
  return extractSessionTitle(messages);
}

// Print startup Banner (using theme colors) - 打印启动 Banner (使用主题颜色)
function printStartupBanner(config: CurrentConfig, mode: string, compactionInfo?: { contextWindow: number; triggerPercent: number; enabled: boolean }, agentsFiles?: AgentsFile[]): void {
  const theme = getCurrentTheme();
  const model = config.model ?? getProviderModel(config.provider) ?? config.provider;

  // KODAX block character logo - KODAX 方块字符 logo
  const logo = `
  ██╗  ██╗  ██████╗  ██████╗    █████╗   ██╗  ██╗
  ██║ ██╔╝ ██╔═══██╗ ██╔══██╗  ██╔══██╗  ╚██╗██╔╝
  █████╔╝  ██║   ██║ ██║  ██║  ███████║   ╚███╔╝
  ██╔═██╗  ██║   ██║ ██║  ██║  ██╔══██║   ██╔██╗
  ██║  ██╗ ╚██████╔╝ ██████╔╝  ██║  ██║  ██╔╝ ██╗
  ╚═╝  ╚═╝  ╚═════╝  ╚═════╝   ╚═╝  ╚═╝  ╚═╝  ╚═╝`;

  console.log(chalk.hex(theme.colors.primary)('\n' + logo));
  console.log(chalk.hex(theme.colors.text)(`\n  v${KODAX_VERSION}  |  AI Coding Agent  |  ${config.provider}:${model}`));
  console.log(chalk.hex(theme.colors.dim)('\n  ────────────────────────────────────────────────────────'));
  console.log(
    chalk.hex(theme.colors.dim)('  Mode: ') +
    chalk.hex(theme.colors.primary)(mode) +
    chalk.hex(theme.colors.dim)('  |  Reasoning: ') +
    (config.reasoningMode === 'off'
      ? chalk.hex(theme.colors.dim)('off')
      : chalk.hex(theme.colors.success)(config.reasoningMode))
  );

  // Compaction info
  if (compactionInfo) {
    const ctxK = Math.round(compactionInfo.contextWindow / 1000);
    const triggerK = Math.round(compactionInfo.contextWindow * compactionInfo.triggerPercent / 100 / 1000);
    const statusText = compactionInfo.enabled ? chalk.hex(theme.colors.success)('on') : chalk.hex(theme.colors.dim)('off');
    console.log(chalk.hex(theme.colors.dim)(`  Context: ${ctxK}k  |  Compaction: `) + statusText + chalk.hex(theme.colors.dim)(` @ ${compactionInfo.triggerPercent}% (${triggerK}k)`));
  }

  console.log(chalk.hex(theme.colors.dim)('  ────────────────────────────────────────────────────────\n'));

  // Show AGENTS.md loading status
  if (agentsFiles) {
    const totalFiles = agentsFiles.length;
    console.log(chalk.hex(theme.colors.dim)('  Project Rules: ') + chalk.hex(theme.colors.success)(`${totalFiles} rule file(s) loaded`));
    console.log(chalk.hex(theme.colors.dim)('  Use /reload to refresh rules\n'));
  }

  console.log(chalk.hex(theme.colors.dim)('  Quick tips:'));
  console.log(chalk.hex(theme.colors.primary)('    /help      ') + chalk.hex(theme.colors.dim)('Show all commands'));
  console.log(chalk.hex(theme.colors.primary)('    /mode      ') + chalk.hex(theme.colors.dim)('Switch permission mode'));
  console.log(chalk.hex(theme.colors.primary)('    /clear     ') + chalk.hex(theme.colors.dim)('Clear conversation'));
  console.log(chalk.hex(theme.colors.primary)('    @path      ') + chalk.hex(theme.colors.dim)('Attach image to context'));
  console.log(chalk.hex(theme.colors.primary)('    !cmd       ') + chalk.hex(theme.colors.dim)('Run read-only shell command'));
  console.log(chalk.hex(theme.colors.dim)('\n  Keyboard: Tab (complete) | Esc+Esc (edit last) | Ctrl+T (reasoning) | Ctrl+E (editor) | Ctrl+R (history)\n'));
}
