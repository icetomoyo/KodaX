/**
 * KodaX Interactive Command System - 交互式命令系统
 */

import type * as readline from 'readline';
import chalk from 'chalk';
import { InteractiveContext, InteractiveMode } from './context.js';
import {
  estimateTokens,
  KODAX_REASONING_MODE_SEQUENCE,
  isKnownProvider,
  getAvailableProviderNames,
  resolveProvider,
  type KodaXReasoningMode,
  KodaXOptions,
} from '@kodax/coding';
import type { AgentsFile } from '@kodax/coding';
import { PermissionMode } from '../permission/types.js';
import {
  describeProviderCapabilitySummary,
  describeReasoningCapabilityControl,
  describeReasoningExecution,
  formatReasoningCapabilityShort,
  getProviderCapabilityProfile,
  getProviderReasoningCapability,
  getProviderAvailableModels,
  getProviderList,
  loadConfig,
  saveConfig,
} from '../common/utils.js';
import { savePermissionModeUser } from '../common/permission-config.js';
import { runWithPlanMode, listPlans, resumePlan, clearCompletedPlans } from '../common/plan-mode.js';
import { handleProjectCommand, printProjectHelp } from './project-commands.js';
import { compact } from '@kodax/agent';
import { loadCompactionConfig } from '../common/compaction-config.js';
import {
  getSkillRegistry,
  initializeSkillRegistry,
  expandSkillForLLM,
  type SkillMetadata,
  type SkillContext,
} from '@kodax/skills';
import { CommandRegistry } from '../commands/registry.js';
import { copyCommand } from '../commands/copy-command.js';
import { newCommand } from '../commands/new-command.js';
import {
  toCommandDefinition,
  type CommandCallbacks,
  type CommandInvocationRequest,
  type CurrentConfig,
} from '../commands/types.js';
import { registerAllCommands } from '../commands/index.js';

// Re-export types needed by downstream modules - 重新导出下游模块需要的类型
export type { CommandCallbacks, CurrentConfig } from '../commands/types.js';

// Command handler type - 命令处理器类型
export type CommandHandler = (
  args: string[],
  context: InteractiveContext,
  callbacks: CommandCallbacks,
  currentConfig: CurrentConfig
) => Promise<CommandResult | void>;

// Command definition - 命令定义
export interface Command {
  name: string;
  aliases?: string[];
  description: string;
  usage?: string;
  handler: CommandHandler;
  /** Detailed help function returning multi-line help text - 详细帮助函数，返回多行帮助文本 */
  detailedHelp?: () => void;
}

// Built-in commands - 内置命令
function summarizeAgentsFiles(files: AgentsFile[]): { global: number; directory: number; project: number } {
  return {
    global: files.filter(file => file.scope === 'global').length,
    directory: files.filter(file => file.scope === 'directory').length,
    project: files.filter(file => file.scope === 'project').length,
  };
}

export const BUILTIN_COMMANDS: Command[] = [
  {
    name: 'help',
    aliases: ['h', '?'],
    description: 'Show all available commands',
    usage: '/help [command]',
    handler: async (args) => {
      if (args.length > 0) {
        // Show detailed help for specific command - 显示特定命令的详细帮助
        printDetailedHelp(args[0]!);
      } else {
        printHelp();
      }
    },
    detailedHelp: () => {
      console.log(chalk.cyan('\n/help - Show Command Help\n'));
      console.log(chalk.bold('Usage:'));
      console.log(chalk.dim('  /help              ') + 'Show all available commands');
      console.log(chalk.dim('  /help <command>    ') + 'Show detailed help for a specific command');
      console.log();
      console.log(chalk.bold('Examples:'));
      console.log(chalk.dim('  /help              ') + '# List all commands');
      console.log(chalk.dim('  /help mode         ') + '# Detailed help for /mode');
      console.log(chalk.dim('  /help project      ') + '# Detailed help for /project');
      console.log();
    },
  },
  {
    name: 'exit',
    aliases: ['quit', 'q', 'bye'],
    description: 'Exit interactive mode',
    handler: async (_args, _context, callbacks) => {
      await callbacks.saveSession();
      console.log(chalk.green('\nSession saved. Goodbye!'));
      callbacks.exit();
    },
    detailedHelp: () => {
      console.log(chalk.cyan('\n/exit - Exit Interactive Mode\n'));
      console.log(chalk.bold('Usage:'));
      console.log(chalk.dim('  /exit              ') + 'Save session and exit');
      console.log(chalk.dim('  /quit, /q, /bye    ') + 'Aliases for /exit');
      console.log();
      console.log(chalk.bold('Description:'));
      console.log(chalk.dim('  Saves the current conversation session and exits interactive mode.'));
      console.log(chalk.dim('  Sessions can be resumed later with /load or CLI -c option.'));
      console.log();
    },
  },
  {
    name: 'clear',
    description: 'Clear conversation history',
    handler: async (_args, context, callbacks) => {
      context.messages = [];  // Clear messages first
      callbacks.clearHistory();  // Then clear UI
      console.log(chalk.yellow('\n[Conversation cleared]'));
    },
    detailedHelp: () => {
      console.log(chalk.cyan('\n/clear - Clear Conversation History\n'));
      console.log(chalk.bold('Usage:'));
      console.log(chalk.dim('  /clear             ') + 'Clear all messages in current session');
      console.log();
      console.log(chalk.bold('Description:'));
      console.log(chalk.dim('  Removes all messages from the current conversation context.'));
      console.log(chalk.dim('  Useful for starting fresh while keeping the session.'));
      console.log();
      console.log(chalk.yellow('  Warning: This action cannot be undone!'));
      console.log();
    },
  },
  {
    name: 'compact',
    description: 'Manually trigger context compaction',
    usage: '/compact [instructions]',
    handler: async (args, context, callbacks, currentConfig) => {
      try {
        // Load compaction config
        const config = await loadCompactionConfig(context.gitRoot);

        if (!config.enabled) {
          console.log(chalk.yellow('\n[Compaction is disabled in config]'));
          console.log(chalk.dim('Enable it in ~/.kodax/config.json or .kodax/config.json\n'));
          return;
        }

        // Get provider instance
        const providerName = currentConfig.provider;
        const provider = resolveProvider(providerName);

        if (!provider) {
          console.log(chalk.red(`\n[Provider not found: ${providerName}]`));
          return;
        }

        // Get custom instructions if provided
        const customInstructions = args.length > 0 ? args.join(' ') : undefined;

        // Get contextWindow: user config > provider > default 200k
        const contextWindow = config.contextWindow
          ?? provider.getContextWindow?.()
          ?? 200000;

        console.log(chalk.dim('\n[Compacting conversation...]'));

        // Start compacting indicator
        callbacks.startCompacting?.();

        try {
          // Perform compaction
          const result = await compact(context.messages, config, provider, contextWindow, customInstructions);

          if (!result.compacted) {
            console.log(chalk.green('\n[No compaction needed]'));
            console.log(chalk.dim(`Current token usage: ${result.tokensBefore.toLocaleString()}\n`));
            return;
          }

          // Update context with compacted messages
          context.messages = result.messages;

          // Clear UI history - it will be re-created from the new context.messages
          // This ensures the UI shows the summary + recent 10% messages
          // 清除 UI 历史 - 它会从新的 context.messages 重新创建
          // 这确保 UI 显示摘要 + 最近的 10% 消息
          callbacks.clearHistory?.();

          // Save compacted messages to session storage
          await callbacks.saveSession();

          // Display statistics
          console.log(chalk.green(`\n[Compaction complete: ${Math.round(result.tokensBefore / 1000)}k → ${Math.round(result.tokensAfter / 1000)}k tokens, ${Math.round((1 - result.tokensAfter / result.tokensBefore) * 100)}% reduced]`));
          console.log();
        } finally {
          // Stop compacting indicator
          callbacks.stopCompacting?.();
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.log(chalk.red(`\n[Compaction failed: ${errorMessage}]\n`));
      }
    },
    detailedHelp: () => {
      console.log(chalk.cyan('\n/compact - Manual Context Compaction\n'));
      console.log(chalk.bold('Usage:'));
      console.log(chalk.dim('  /compact           ') + 'Compact conversation with default instructions');
      console.log(chalk.dim('  /compact <text>    ') + 'Compact with custom instructions for the summary');
      console.log();
      console.log(chalk.bold('Description:'));
      console.log(chalk.dim('  Manually triggers context compaction using LLM-generated summaries.'));
      console.log(chalk.dim('  Older messages are replaced with a structured summary, keeping recent context.'));
      console.log();
      console.log(chalk.bold('What it does:'));
      console.log(chalk.dim('  1. Keeps recent messages (based on keepRecentTokens config)'));
      console.log(chalk.dim('  2. Generates structured summary of older messages using LLM'));
      console.log(chalk.dim('  3. Tracks files that were read/modified in the conversation'));
      console.log(chalk.dim('  4. Replaces old messages with summary to save tokens'));
      console.log();
      console.log(chalk.bold('Configuration:'));
      console.log(chalk.dim('  Config file: ~/.kodax/config.json or .kodax/config.json'));
      console.log(chalk.dim('  Settings:'));
      console.log(chalk.dim('    - compaction.enabled: Enable/disable auto-compaction'));
      console.log(chalk.dim('    - compaction.reserveTokens: Tokens to reserve for responses'));
      console.log(chalk.dim('    - compaction.keepRecentTokens: Recent tokens to preserve'));
      console.log();
      console.log(chalk.bold('Examples:'));
      console.log(chalk.dim('  /compact                        ') + '# Compact with default instructions');
      console.log(chalk.dim('  /compact focus on auth logic    ') + '# Emphasize authentication in summary');
      console.log();
      console.log(chalk.dim('  See also: /help status (shows token usage)'));
      console.log();
    },
  },
  {
    name: 'reload',
    description: 'Reload AGENTS.md project rules',
    handler: async (_args, _context, callbacks, _currentConfig) => {
      console.log(chalk.cyan('\nReloading project rule files...\n'));

      try {
        const files = await callbacks.reloadAgentsFiles?.() ?? [];
        const result = summarizeAgentsFiles(files);

        if (files.length > 0) {
          console.log(chalk.green('✓ Rules reloaded successfully:\n'));
          if (result.global > 0) {
            console.log(chalk.dim(`  • Global: ${result.global} file(s)`));
          }
          if (result.directory > 0) {
            console.log(chalk.dim(`  • Directory: ${result.directory} file(s)`));
          }
          if (result.project > 0) {
            console.log(chalk.dim(`  • Project: ${result.project} file(s)`));
          }
          console.log(chalk.dim('  Updated rules will apply to subsequent requests in this session.'));
          console.log();
        } else {
          console.log(chalk.yellow('No project rule files found.\n'));
          console.log(chalk.dim('  Create AGENTS.md or CLAUDE.md in your project, or .kodax/AGENTS.md for project-wide overrides.'));
          console.log();
        }
      } catch (error) {
        console.log(chalk.red('Failed to reload rules.\n'));
        console.log(chalk.dim(`  Error: ${error instanceof Error ? error.message : String(error)}`));
        console.log();
      }
    },
    detailedHelp: () => {
      console.log(chalk.cyan('\n/reload - Reload Project Rules\n'));
      console.log(chalk.bold('Usage:'));
      console.log(chalk.dim('  /reload            ') + 'Reload all discovered project rule files');
      console.log();
      console.log(chalk.bold('Description:'));
      console.log('  Reloads project-level context rules from AGENTS.md, CLAUDE.md, and .kodax/AGENTS.md files.');
      console.log();
      console.log(chalk.bold('Rule Priority:'));
      console.log(chalk.dim('  1. Global:   ') + '~/.kodax/AGENTS.md');
      console.log(chalk.dim('  2. Directory: ') + 'AGENTS.md or CLAUDE.md from project root to current directory');
      console.log(chalk.dim('  3. Project:  ') + '.kodax/AGENTS.md at the project root');
      console.log();
      console.log(chalk.bold('Examples:'));
      console.log(chalk.dim('  /reload            ') + '# Reload and show loaded rules');
      console.log();
    },
  },
  {
    name: 'status',
    aliases: ['info', 'ctx'],
    description: 'Show current session status',
    handler: async (_args, context, _callbacks, currentConfig) => {
      printStatus(context, currentConfig);
    },
    detailedHelp: () => {
      console.log(chalk.cyan('\n/status - Show Session Status\n'));
      console.log(chalk.bold('Usage:'));
      console.log(chalk.dim('  /status            ') + 'Display current session information');
      console.log(chalk.dim('  /info, /ctx        ') + 'Aliases for /status');
      console.log();
      console.log(chalk.bold('Displays:'));
      console.log(chalk.dim('  - Current mode (code/ask)'));
      console.log(chalk.dim('  - Session ID'));
      console.log(chalk.dim('  - Message count'));
      console.log(chalk.dim('  - Estimated token usage'));
      console.log(chalk.dim('  - Git root directory'));
      console.log(chalk.dim('  - Session timestamps'));
      console.log();
    },
  },
  {
    name: 'mode',
    description: 'Show or switch permission mode (plan/accept-edits/auto-in-project)',
    usage: '/mode [plan|accept-edits|auto-in-project]',
    handler: async (args, _context, callbacks, currentConfig) => {
      const VALID_MODES: PermissionMode[] = ['plan', 'accept-edits', 'auto-in-project'];
      if (args.length === 0) {
        const m = currentConfig.permissionMode;
        console.log(chalk.dim(`\nCurrent mode: ${chalk.cyan(m)}`));
        console.log(chalk.dim('Usage: /mode [plan|accept-edits|auto-in-project]'));
        return;
      }
      const newMode = args[0] as PermissionMode;
      if (VALID_MODES.includes(newMode)) {
        currentConfig.permissionMode = newMode;
        callbacks.setPermissionMode?.(newMode);
        savePermissionModeUser(newMode);
        console.log(chalk.cyan(`\n[Switched to ${newMode} mode] (saved)`));
      } else {
        console.log(chalk.red(`\n[Unknown mode: ${args[0]}. Use: plan | accept-edits | auto-in-project]`));
      }
    },
    detailedHelp: () => {
      console.log(chalk.cyan('\n/mode - Switch Permission Mode\n'));
      console.log(chalk.bold('Usage:'));
      console.log(chalk.dim('  /mode                        ') + 'Show current permission mode');
      console.log(chalk.dim('  /mode plan                   ') + 'Read-only: blocks all modifications');
      console.log(chalk.dim('  /mode accept-edits           ') + 'File edits auto, bash requires confirmation');
      console.log(chalk.dim('  /mode auto-in-project        ') + 'Project-internal fully auto');
      console.log();
      console.log(chalk.bold('Permission Levels:'));
      console.log(chalk.yellow('  plan          ') + chalk.dim('- Read-only planning, no file/command modifications'));
      console.log(chalk.green('  accept-edits  ') + chalk.dim('- File edits auto-approved, bash still requires confirmation'));
      console.log(chalk.green('  auto-in-project') + chalk.dim('- All tools auto within project, outside requires confirmation'));
      console.log();
      console.log(chalk.bold('Notes:'));
      console.log(chalk.dim('  - .kodax/ directory and project-external paths always require confirmation'));
      console.log(chalk.dim('  - Mode is saved to ~/.kodax/config.json (user-level)'));
      console.log();
    },
  },
  {
    name: 'save',
    description: 'Save current session',
    handler: async (_args, _context, callbacks) => {
      await callbacks.saveSession();
      console.log(chalk.green('\n[Session saved]'));
    },
    detailedHelp: () => {
      console.log(chalk.cyan('\n/save - Save Current Session\n'));
      console.log(chalk.bold('Usage:'));
      console.log(chalk.dim('  /save              ') + 'Save current conversation to session storage');
      console.log();
      console.log(chalk.bold('Description:'));
      console.log(chalk.dim('  Manually saves the current conversation session.'));
      console.log(chalk.dim('  Sessions are auto-saved after each message, but you can'));
      console.log(chalk.dim('  use this to ensure the session is persisted.'));
      console.log();
      console.log(chalk.dim('  See also: /help load, /help sessions'));
      console.log();
    },
  },
  {
    name: 'load',
    aliases: ['resume'],
    description: 'Load a session',
    usage: '/load <session-id>',
    handler: async (args, _context, callbacks) => {
      if (args.length === 0) {
        console.log(chalk.red('\n[Usage: /load <session-id>]'));
        await callbacks.listSessions();
        return;
      }
      const success = await callbacks.loadSession(args[0]!);
      if (!success) {
        console.log(chalk.red(`\n[Session not found: ${args[0]}]`));
      }
    },
    detailedHelp: () => {
      console.log(chalk.cyan('\n/load - Load a Saved Session\n'));
      console.log(chalk.bold('Usage:'));
      console.log(chalk.dim('  /load              ') + 'List available sessions');
      console.log(chalk.dim('  /load <session-id> ') + 'Load a specific session');
      console.log(chalk.dim('  /resume <id>       ') + 'Alias for /load');
      console.log();
      console.log(chalk.bold('Examples:'));
      console.log(chalk.dim('  /load              ') + '# See all sessions');
      console.log(chalk.dim('  /load 20260219_143052') + '# Load session by ID');
      console.log();
      console.log(chalk.dim('  See also: /help sessions, /help save'));
      console.log();
    },
  },
  {
    name: 'sessions',
    aliases: ['ls', 'list'],
    description: 'List recent sessions',
    handler: async (_args, _context, callbacks) => {
      await callbacks.listSessions();
    },
    detailedHelp: () => {
      console.log(chalk.cyan('\n/sessions - List Saved Sessions\n'));
      console.log(chalk.bold('Usage:'));
      console.log(chalk.dim('  /sessions          ') + 'List all saved sessions');
      console.log(chalk.dim('  /ls, /list         ') + 'Aliases for /sessions');
      console.log();
      console.log(chalk.bold('Description:'));
      console.log(chalk.dim('  Shows recent conversation sessions with their IDs,'));
      console.log(chalk.dim('  message counts, and titles. Use /load <id> to resume.'));
      console.log();
      console.log(chalk.dim('  See also: /help load, /help delete'));
      console.log();
    },
  },
  {
    name: 'history',
    aliases: ['hist'],
    description: 'Show conversation history',
    handler: async (_args, _context, callbacks) => {
      callbacks.printHistory();
    },
    detailedHelp: () => {
      console.log(chalk.cyan('\n/history - Show Conversation History\n'));
      console.log(chalk.bold('Usage:'));
      console.log(chalk.dim('  /history           ') + 'Display recent messages in current session');
      console.log(chalk.dim('  /hist              ') + 'Alias for /history');
      console.log();
      console.log(chalk.bold('Description:'));
      console.log(chalk.dim('  Shows the last 20 messages in the current conversation.'));
      console.log(chalk.dim('  Useful for reviewing what has been discussed.'));
      console.log();
    },
  },
  {
    name: 'delete',
    aliases: ['rm', 'del'],
    description: 'Delete a session',
    usage: '/delete <session-id> or /delete all',
    handler: async (args, _context, callbacks) => {
      if (args.length === 0) {
        console.log(chalk.red('\n[Usage: /delete <session-id> or /delete all]'));
        await callbacks.listSessions?.();
        return;
      }
      if (args[0] === 'all') {
        await callbacks.deleteAllSessions?.();
        console.log(chalk.green('\n[All sessions deleted]'));
      } else {
        await callbacks.deleteSession?.(args[0]!);
        console.log(chalk.green(`\n[Session deleted: ${args[0]}]`));
      }
    },
    detailedHelp: () => {
      console.log(chalk.cyan('\n/delete - Delete Saved Sessions\n'));
      console.log(chalk.bold('Usage:'));
      console.log(chalk.dim('  /delete            ') + 'Show usage (lists sessions)');
      console.log(chalk.dim('  /delete <id>       ') + 'Delete a specific session');
      console.log(chalk.dim('  /delete all        ') + 'Delete ALL sessions');
      console.log(chalk.dim('  /rm, /del          ') + 'Aliases for /delete');
      console.log();
      console.log(chalk.bold('Examples:'));
      console.log(chalk.dim('  /delete 20260219_143052') + '  # Delete specific session');
      console.log(chalk.dim('  /delete all        ') + '# Delete all sessions');
      console.log();
      console.log(chalk.yellow('  Warning: /delete all cannot be undone!'));
      console.log();
    },
  },
  {
    name: 'model',
    aliases: ['m'],
    description: 'Show or switch provider/model',
    usage: '/model [<provider>[/<model>] | /<model>]',
    handler: async (args, _context, callbacks, currentConfig) => {
      // Read config once and pass providerModels to avoid repeated file I/O
      const providerModels = loadConfig().providerModels;

      if (args.length === 0) {
        // Show all providers with their models - 显示所有 Provider 及模型
        console.log(chalk.bold('\nAvailable Providers:\n'));
        const providers = getProviderList(providerModels);
        for (const p of providers) {
          const configured = p.configured ? chalk.green('[configured]') : chalk.red('[not configured]');
          const customTag = p.custom ? chalk.yellow(' [custom]') : '';
          const currentProvider = p.name === currentConfig.provider;
          const providerTag = currentProvider ? chalk.cyan(' *') : '';
          console.log(`  ${chalk.bold(p.name)}${providerTag}  ${configured}${customTag}`);
          if (p.capabilityProfile.transport === 'cli-bridge') {
            console.log(chalk.yellow(`  ! ${describeProviderCapabilitySummary(p.capabilityProfile)}`));
          }

          const models = getProviderAvailableModels(p.name, providerModels);
          const effectiveModel = currentProvider ? currentConfig.model : null;
          for (const model of models) {
            const isActive = currentProvider && (effectiveModel === model || (!effectiveModel && model === p.model));
            const marker = isActive ? chalk.cyan('>') : ' ';
            console.log(`  ${marker} ${model}`);
          }
          console.log();
        }
        console.log(chalk.dim(`Current: provider=${currentConfig.provider}${currentConfig.model ? `, model=${currentConfig.model}` : ''}`));
        console.log(chalk.dim('Usage:'));
        console.log(chalk.dim('  /model <provider>           Switch provider'));
        console.log(chalk.dim('  /model <provider>/<model>  Switch to specific model'));
        console.log(chalk.dim('  /model /<model>            Switch model within current provider\n'));
        return;
      }

      const input = (args[0] ?? '').trim();
      if (!input) return;

      // /model /<model-id> — switch model within current provider
      if (input.startsWith('/')) {
        const targetModel = input.slice(1);
        if (!targetModel) {
          console.log(chalk.red('\n[Missing model name after /]'));
          return;
        }
        const models = getProviderAvailableModels(currentConfig.provider, providerModels);
        if (!models.includes(targetModel)) {
          console.log(chalk.red(`\n[Unknown model: ${targetModel}]`));
          console.log(chalk.dim(`Available models for ${currentConfig.provider}: ${models.join(', ')}\n`));
          return;
        }
        saveConfig({ model: targetModel });
        callbacks.switchProvider?.(currentConfig.provider, targetModel);
        console.log(chalk.cyan(`\n[Switched to ${targetModel}] (saved)`));
        return;
      }

      // /model <provider>/<model-id> — switch provider and model
      if (input.includes('/')) {
        const slashIdx = input.indexOf('/');
        const targetProvider = input.slice(0, slashIdx);
        const targetModel = input.slice(slashIdx + 1);
        if (!targetModel || !targetProvider) {
          console.log(chalk.red('\n[Invalid format. Use: /model <provider>/<model>]'));
          return;
        }
        if (!isKnownProvider(targetProvider)) {
          console.log(chalk.red(`\n[Unknown provider: ${targetProvider}]`));
          console.log(chalk.dim(`Available: ${getAvailableProviderNames().join(', ')}\n`));
          return;
        }
        const models = getProviderAvailableModels(targetProvider, providerModels);
        if (!models.includes(targetModel)) {
          console.log(chalk.red(`\n[Unknown model: ${targetModel}]`));
          console.log(chalk.dim(`Available models for ${targetProvider}: ${models.join(', ')}\n`));
          return;
        }
        saveConfig({ provider: targetProvider, model: targetModel });
        callbacks.switchProvider?.(targetProvider, targetModel);
        console.log(chalk.cyan(`\n[Switched to ${targetProvider}/${targetModel}] (saved)`));
        return;
      }

      // /model <provider> — switch provider (use default model)
      const newProvider = input;
      if (isKnownProvider(newProvider)) {
        saveConfig({ provider: newProvider, model: undefined });
        callbacks.switchProvider?.(newProvider);
        console.log(chalk.cyan(`\n[Switched to ${newProvider}] (saved)`));
      } else {
        console.log(chalk.red(`\n[Unknown provider: ${newProvider}]`));
        console.log(chalk.dim(`Available: ${getAvailableProviderNames().join(', ')}\n`));
      }
    },
    detailedHelp: () => {
      console.log(chalk.cyan('\n/model - Switch LLM Provider/Model\n'));
      console.log(chalk.bold('Usage:'));
      console.log(chalk.dim('  /model                       ') + 'List all providers with models');
      console.log(chalk.dim('  /model <provider>            ') + 'Switch to a provider (default model)');
      console.log(chalk.dim('  /model <provider>/<model>    ') + 'Switch to a specific model');
      console.log(chalk.dim('  /model /<model>              ') + 'Switch model within current provider');
      console.log();
      console.log(chalk.bold('Examples:'));
      console.log(chalk.dim('  /model                       ') + '# See available providers & models');
      console.log(chalk.dim('  /model anthropic             ') + '# Switch to Anthropic (default model)');
      console.log(chalk.dim('  /model openai/gpt-5.4        ') + '# Switch to OpenAI GPT-5.4');
      console.log(chalk.dim('  /model /claude-opus-4-6      ') + '# Switch to Opus within current provider');
      console.log();
    },
  },
  {
    name: 'thinking',
    aliases: ['think', 't'],
    description: 'Show or change reasoning mode (compat alias)',
    usage: '/thinking [on|off|auto|quick|balanced|deep]',
    handler: async (args, _context, callbacks, currentConfig) => {
      if (args.length === 0) {
        const capability = getProviderReasoningCapability(currentConfig.provider);
        const status = currentConfig.thinking ? chalk.green('ON') : chalk.dim('OFF');
        console.log(chalk.dim(`\nThinking: ${status}`));
        console.log(chalk.dim(`Reasoning mode: ${chalk.cyan(currentConfig.reasoningMode)}`));
        console.log(chalk.dim(`Effective control: ${chalk.cyan(describeReasoningCapabilityControl(capability))}`));
        console.log(chalk.dim(`Actual execution: ${describeReasoningExecution(currentConfig.reasoningMode, capability)}`));
        console.log(chalk.dim('Usage: /thinking on|off|auto|quick|balanced|deep\n'));
        return;
      }

      const value = args[0].toLowerCase();
      if (
        value === 'on' ||
        value === 'off' ||
        KODAX_REASONING_MODE_SEQUENCE.includes(value as KodaXReasoningMode)
      ) {
        const mode: KodaXReasoningMode =
          value === 'on'
            ? 'auto'
            : value === 'off'
              ? 'off'
              : value as KodaXReasoningMode;
        const persistence = applyReasoningMode(mode, callbacks, currentConfig);
        printPersistedCommandStatus(`Reasoning mode: ${mode}`, persistence);
        return;
      }

      console.log(chalk.red(`\n[Invalid value: ${args[0]}]`));
      console.log(chalk.dim('Usage: /thinking on|off|auto|quick|balanced|deep\n'));
    },
    detailedHelp: () => {
      console.log(chalk.cyan('\n/thinking - Legacy Alias for Reasoning Mode\n'));
      console.log(chalk.bold('Usage:'));
      console.log(chalk.dim('  /thinking          ') + 'Show current reasoning status');
      console.log(chalk.dim('  /thinking on       ') + 'Map to /reasoning auto');
      console.log(chalk.dim('  /thinking off      ') + 'Map to /reasoning off');
      console.log(chalk.dim('  /thinking auto     ') + 'Set reasoning mode to auto');
      console.log(chalk.dim('  /thinking quick    ') + 'Set reasoning mode to quick');
      console.log(chalk.dim('  /thinking balanced ') + 'Set reasoning mode to balanced');
      console.log(chalk.dim('  /thinking deep     ') + 'Set reasoning mode to deep');
      console.log(chalk.dim('  /t                 ') + 'Alias for /thinking');
      console.log();
      console.log(chalk.bold('Description:'));
      console.log(chalk.dim('  Compatibility command for the new unified reasoning modes.'));
      console.log(chalk.dim('  Use /reasoning for the primary interface.'));
      console.log();
    },
  },
  {
    name: 'reasoning',
    aliases: ['reason'],
    description: 'Show or set reasoning mode',
    usage: '/reasoning [off|auto|quick|balanced|deep]',
    handler: async (args, _context, callbacks, currentConfig) => {
      if (args.length === 0) {
        const capability = getProviderReasoningCapability(currentConfig.provider);
        console.log(chalk.dim(`\nReasoning mode: ${chalk.cyan(currentConfig.reasoningMode)}`));
        console.log(chalk.dim(`Thinking compatibility: ${currentConfig.thinking ? chalk.green('ON') : chalk.dim('OFF')}`));
        console.log(chalk.dim(`Effective control: ${chalk.cyan(describeReasoningCapabilityControl(capability))}`));
        console.log(chalk.dim(`Actual execution: ${describeReasoningExecution(currentConfig.reasoningMode, capability)}`));
        console.log(chalk.dim('Usage: /reasoning off|auto|quick|balanced|deep\n'));
        return;
      }

      const value = args[0].toLowerCase() as KodaXReasoningMode;
      if (!KODAX_REASONING_MODE_SEQUENCE.includes(value)) {
        console.log(chalk.red(`\n[Invalid reasoning mode: ${args[0]}]`));
        console.log(chalk.dim('Usage: /reasoning off|auto|quick|balanced|deep\n'));
        return;
      }

      const persistence = applyReasoningMode(value, callbacks, currentConfig);
      printPersistedCommandStatus(`Reasoning mode: ${value}`, persistence);
    },
    detailedHelp: () => {
      console.log(chalk.cyan('\n/reasoning - Set Reasoning Mode\n'));
      console.log(chalk.bold('Usage:'));
      console.log(chalk.dim('  /reasoning             ') + 'Show current reasoning mode');
      console.log(chalk.dim('  /reasoning off         ') + 'Disable reasoning');
      console.log(chalk.dim('  /reasoning auto        ') + 'Use semantic routing + adaptive depth');
      console.log(chalk.dim('  /reasoning quick       ') + 'Low-depth reasoning');
      console.log(chalk.dim('  /reasoning balanced    ') + 'Medium-depth reasoning');
      console.log(chalk.dim('  /reasoning deep        ') + 'High-depth reasoning');
      console.log(chalk.dim('  /reasoning:auto        ') + 'Inline form, equivalent to /reasoning auto');
      console.log(chalk.dim('  /reason                ') + 'Alias for /reasoning');
      console.log();
    },
  },
  {
    name: 'parallel',
    aliases: ['pm'],
    description: 'Show or toggle parallel tool execution',
    usage: '/parallel [on|off|toggle]',
    handler: async (args, _context, callbacks, currentConfig) => {
      if (args.length === 0) {
        const executionMode = currentConfig.parallel
          ? chalk.green(describeParallelExecution(currentConfig.parallel))
          : chalk.dim(describeParallelExecution(currentConfig.parallel));
        console.log(chalk.dim(`\nTool execution: ${executionMode}`));
        console.log(chalk.dim('Parallel mode lets the agent run independent tool calls concurrently.'));
        console.log(chalk.dim('Usage: /parallel on|off|toggle\n'));
        return;
      }

      const value = args[0].toLowerCase();
      if (!['on', 'off', 'toggle'].includes(value)) {
        console.log(chalk.red(`\n[Invalid value: ${args[0]}]`));
        console.log(chalk.dim('Usage: /parallel on|off|toggle\n'));
        return;
      }

      const nextValue =
        value === 'toggle'
          ? !currentConfig.parallel
          : value === 'on';

      const persistence = applyParallelMode(nextValue, callbacks, currentConfig);
      printPersistedCommandStatus(
        `Tool execution: ${describeParallelExecution(nextValue)}`,
        persistence,
      );
    },
    detailedHelp: () => {
      console.log(chalk.cyan('\n/parallel - Toggle Parallel Tool Execution\n'));
      console.log(chalk.bold('Usage:'));
      console.log(chalk.dim('  /parallel          ') + 'Show the current execution mode');
      console.log(chalk.dim('  /parallel on       ') + 'Enable parallel tool execution');
      console.log(chalk.dim('  /parallel off      ') + 'Disable parallel tool execution');
      console.log(chalk.dim('  /parallel toggle   ') + 'Switch between parallel and serial execution');
      console.log(chalk.dim('  /pm                ') + 'Alias for /parallel');
      console.log();
      console.log(chalk.bold('Description:'));
      console.log(chalk.dim('  When enabled, independent tool calls from a single agent turn can run concurrently.'));
      console.log(chalk.dim('  The current value is saved to your KodaX config and shown in the status bar.'));
      console.log();
    },
  },
  {
    name: 'auto',
    aliases: ['a'],
    description: 'Quick switch to auto-in-project mode',
    handler: async (_args, _context, callbacks, currentConfig) => {
      currentConfig.permissionMode = 'auto-in-project';
      callbacks.setPermissionMode?.('auto-in-project');
      savePermissionModeUser('auto-in-project');
      console.log(chalk.cyan('\n[Switched to auto-in-project mode] (saved)'));
    },
    detailedHelp: () => {
      console.log(chalk.cyan('\n/auto - Quick Switch to Auto-in-Project Mode\n'));
      console.log(chalk.bold('Usage:'));
      console.log(chalk.dim('  /auto              ') + 'Switch to auto-in-project mode');
      console.log(chalk.dim('  /a                 ') + 'Alias for /auto');
      console.log();
      console.log(chalk.bold('Description:'));
      console.log(chalk.dim('  Equivalent to /mode auto-in-project.'));
      console.log(chalk.dim('  All tools auto-approved within project directory.'));
      console.log(chalk.dim('  Operations outside project still require confirmation.'));
      console.log();
      console.log(chalk.dim('  See also: /help mode'));
      console.log();
    },
  },
  {
    name: 'plan',
    aliases: ['p'],
    description: 'Plan mode management',
    usage: '/plan [on|off|once|list|resume|clear] [args]',
    handler: async (args, _context, callbacks, _currentConfig) => {
      const subCommand = args[0]?.toLowerCase();

      switch (subCommand) {
        case 'on':
          callbacks.setPlanMode?.(true);
          console.log(chalk.cyan('\n[Plan mode enabled]'));
          break;

        case 'off':
          callbacks.setPlanMode?.(false);
          console.log(chalk.cyan('\n[Plan mode disabled]'));
          break;

        case 'once': {
          const prompt = args.slice(1).join(' ');
          if (!prompt) {
            console.log(chalk.yellow('\n[Usage: /plan once <your request>]'));
            return;
          }
          const options = callbacks.createKodaXOptions?.();
          if (options) {
            await runWithPlanMode(prompt, options);
          }
          break;
        }

        case 'list':
          await listPlans();
          break;

        case 'resume': {
          const planId = args[1];
          if (!planId) {
            console.log(chalk.yellow('\n[Usage: /plan resume <plan-id>]'));
            return;
          }
          const options = callbacks.createKodaXOptions?.();
          if (options) {
            await resumePlan(planId, options);
          }
          break;
        }

        case 'clear':
          await clearCompletedPlans();
          break;

        default:
          console.log(chalk.dim('\nUsage: /plan [on|off|once|list|resume|clear]'));
          console.log(chalk.dim('  on    - Enable plan mode for all requests'));
          console.log(chalk.dim('  off   - Disable plan mode'));
          console.log(chalk.dim('  once  - Run plan mode for a single request'));
          console.log(chalk.dim('  list  - List saved plans'));
          console.log(chalk.dim('  resume- Resume a saved plan'));
          console.log(chalk.dim('  clear - Clear completed plans\n'));
      }
    },
    detailedHelp: () => {
      console.log(chalk.cyan('\n/plan - Plan Mode Management\n'));
      console.log(chalk.bold('Usage:'));
      console.log(chalk.dim('  /plan              ') + 'Show usage help');
      console.log(chalk.dim('  /plan on           ') + 'Enable plan mode for all requests');
      console.log(chalk.dim('  /plan off          ') + 'Disable plan mode');
      console.log(chalk.dim('  /plan once <task>  ') + 'Run a single task in plan mode');
      console.log(chalk.dim('  /plan list         ') + 'List all saved plans');
      console.log(chalk.dim('  /plan resume <id>  ') + 'Resume a saved plan');
      console.log(chalk.dim('  /plan clear        ') + 'Clear completed plans');
      console.log(chalk.dim('  /p                 ') + 'Alias for /plan');
      console.log();
      console.log(chalk.bold('Description:'));
      console.log(chalk.dim('  Plan mode breaks down complex tasks into executable steps.'));
      console.log(chalk.dim('  The agent creates a structured plan before execution,'));
      console.log(chalk.dim('  allowing you to review and approve each step.'));
      console.log();
      console.log(chalk.bold('Workflow:'));
      console.log(chalk.dim('  1. Enable plan mode with /plan on'));
      console.log(chalk.dim('  2. Enter your complex request'));
      console.log(chalk.dim('  3. Review the generated plan'));
      console.log(chalk.dim('  4. Approve or modify the plan'));
      console.log(chalk.dim('  5. Execute step by step'));
      console.log();
      console.log(chalk.bold('Examples:'));
      console.log(chalk.dim('  /plan on                      ') + '# Enable persistent plan mode');
      console.log(chalk.dim('  /plan once refactor auth.ts   ') + '# Single task with planning');
      console.log(chalk.dim('  /plan list                    ') + '# See saved plans');
      console.log(chalk.dim('  /plan resume plan_20260219    ') + '# Resume a saved plan');
      console.log();
    },
  },
  {
    name: 'project',
    aliases: ['proj'],
    description: 'Project long-running task management',
    usage: '/project [init|status|plan|quality|brainstorm|next|auto|verify|pause|list|mark|progress]',
    handler: async (args, context, callbacks, currentConfig) => {
      return await handleProjectCommand(args, context, callbacks, currentConfig);
    },
    detailedHelp: printProjectHelp,
  },
  {
    name: 'skills',
    description: '(Deprecated) Use /skill instead',
    usage: '/skill',
    handler: async (args, context) => {
      // Redirect to /skill namespace command - 重定向到 /skill 命名空间命令
      console.log(chalk.dim('\n[/skills is deprecated. Use /skill instead]'));
      await handleSkillNamespaceCommand(args, context);
    },
    detailedHelp: () => {
      console.log(chalk.cyan('\n/skills - Deprecated\n'));
      console.log(chalk.yellow('This command is deprecated. Use /skill instead.'));
      console.log();
      console.log(chalk.dim('  /skill           ') + 'List all available skills');
      console.log(chalk.dim('  /skill:<name>    ') + 'Invoke a skill');
      console.log();
    },
  },
  {
    name: 'skill',
    description: 'Skill namespace - invoke skills with /skill:name',
    usage: '/skill[:name] [args]',
    handler: async (args, context, callbacks, currentConfig) => {
      // This handler is called when /skill is typed without :name
      // When /skill:name is used, parseCommand extracts the name and executeCommand
      // calls executeSkillCommand directly
      await handleSkillNamespaceCommand(args, context);
    },
    detailedHelp: () => {
      console.log(chalk.cyan('\n/skill - Skill Namespace\n'));
      console.log(chalk.bold('Usage:'));
      console.log(chalk.dim('  /skill               ') + 'List all available skills');
      console.log(chalk.dim('  /skill:<name> [args] ') + 'Invoke a skill by name');
      console.log();
      console.log(chalk.bold('Description:'));
      console.log(chalk.dim('  This is the pi-mono style skill invocation format.'));
      console.log(chalk.dim('  Skills can also be triggered by natural language - just ask!'));
      console.log();
      console.log(chalk.bold('Examples:'));
      console.log(chalk.dim('  /skill                    ') + '# List all skills');
      console.log(chalk.dim('  /skill:code-review src/   ') + '# Invoke code-review skill');
      console.log(chalk.dim('  /skill:tdd auth           ') + '# Invoke TDD skill');
      console.log();
    },
  },
  copyCommand,
  newCommand,
];

// Print help - 打印帮助
const COMMAND_CATEGORIES: Record<string, string[]> = {
  General: ['help', 'copy', 'exit', 'clear', 'compact', 'reload', 'status'],
  Permission: ['mode', 'auto'],
  Session: ['new', 'save', 'load', 'sessions', 'history', 'delete'],
  Settings: ['model', 'thinking', 'reasoning', 'parallel', 'plan'],
  Project: ['project'],
  Skills: ['skill'],
};

function getCommandsForCategory(names: string[]) {
  const registry = getCommandRegistry();
  return names
    .map((name) => registry.get(name))
    .filter((cmd): cmd is NonNullable<ReturnType<CommandRegistry['get']>> => cmd !== undefined)
    .filter((cmd) => cmd.userInvocable !== false);
}

function reasoningModeToLegacyThinking(mode: KodaXReasoningMode): boolean {
  return mode !== 'off';
}

function describeParallelExecution(enabled: boolean): 'parallel' | 'serial' {
  return enabled ? 'parallel' : 'serial';
}

type ConfigPersistenceResult =
  | { saved: true }
  | { saved: false; error: Error };

function persistUserConfig(
  config: Parameters<typeof saveConfig>[0],
): ConfigPersistenceResult {
  try {
    saveConfig(config);
    return { saved: true };
  } catch (error) {
    return {
      saved: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

function printPersistedCommandStatus(
  message: string,
  result: ConfigPersistenceResult,
): void {
  if (result.saved) {
    console.log(chalk.cyan(`\n[${message}] (saved)`));
    return;
  }

  console.log(chalk.yellow(`\n[${message}]`));
  console.log(chalk.red(`[Config save failed: ${result.error.message}]`));
}

function applyReasoningMode(
  mode: KodaXReasoningMode,
  callbacks: CommandCallbacks,
  currentConfig: CurrentConfig,
): ConfigPersistenceResult {
  const thinking = reasoningModeToLegacyThinking(mode);
  const persistence = persistUserConfig({
    reasoningMode: mode,
    thinking,
  });

  if (callbacks.setReasoningMode) {
    callbacks.setReasoningMode(mode);
  } else {
    currentConfig.reasoningMode = mode;
    currentConfig.thinking = thinking;
  }

  return persistence;
}

function applyParallelMode(
  enabled: boolean,
  callbacks: CommandCallbacks,
  currentConfig: CurrentConfig,
): ConfigPersistenceResult {
  const persistence = persistUserConfig({ parallel: enabled });

  if (callbacks.setParallel) {
    callbacks.setParallel(enabled);
  } else {
    currentConfig.parallel = enabled;
  }

  return persistence;
}

function printCommandSection(
  title: string,
  commands: Array<{ name: string; aliases?: string[]; description: string }>
): void {
  if (commands.length === 0) {
    return;
  }

  console.log(chalk.dim(`${title}:`));
  for (const cmd of commands) {
    const aliasLabel = cmd.aliases?.length ? ` (${cmd.aliases.join(', ')})` : '';
    console.log(`  ${chalk.cyan(`/${cmd.name}`)}${chalk.dim(aliasLabel)} ${cmd.description}`);
  }
  console.log();
}

function printHelp(): void {
  console.log(chalk.bold('\nAvailable Commands:\n'));
  const registry = getCommandRegistry();
  const categorizedNames = new Set<string>();

  for (const [category, names] of Object.entries(COMMAND_CATEGORIES)) {
    const commands = getCommandsForCategory(names);
    if (commands.length === 0) continue;

    for (const cmd of commands) {
      categorizedNames.add(cmd.name.toLowerCase());
    }
    printCommandSection(category, commands);

    if (category === 'Project') {
      console.log(chalk.dim('    Subcommands: init, status, plan, quality, brainstorm, next, auto, verify, pause, list, mark, progress'));
      console.log();
    }
  }

  const dynamicSections = new Map<string, Array<{ name: string; aliases?: string[]; description: string }>>();
  for (const cmd of registry.getAll()) {
    if (cmd.userInvocable === false) {
      continue;
    }

    if (categorizedNames.has(cmd.name.toLowerCase())) {
      continue;
    }

    const sectionTitle = cmd.source === 'extension'
      ? 'Extensions'
      : cmd.source === 'skill'
        ? 'Skill Commands'
        : cmd.source === 'prompt'
          ? 'Prompt Commands'
          : 'Other Commands';

    const commands = dynamicSections.get(sectionTitle) ?? [];
    commands.push(cmd);
    dynamicSections.set(sectionTitle, commands);
  }

  for (const sectionTitle of ['Extensions', 'Skill Commands', 'Prompt Commands', 'Other Commands']) {
    printCommandSection(sectionTitle, dynamicSections.get(sectionTitle) ?? []);
  }

  console.log(chalk.dim('Special syntax:'));
  console.log(`  ${chalk.cyan('@file')}             Add file to context`);
  console.log(`  ${chalk.cyan('!command')}         Execute shell command`);
  console.log();
  console.log(chalk.dim('Skills:'));
  console.log(`  ${chalk.cyan('/skill')}            List all available skills`);
  console.log(`  ${chalk.cyan('/skill:<name>')}     Invoke a skill (e.g., /skill:code-review)`);
  console.log();
}

// Print detailed help for specific command - 打印特定命令的详细帮助
function printDetailedHelp(commandName: string): void {
  // Lazy initialization - 延迟初始化
  if (commandRegistry.size === 0) {
    initCommandRegistry();
  }

  const cmd = commandRegistry.get(commandName.toLowerCase());
  if (!cmd) {
    console.log(chalk.yellow(`\n[Unknown command: /${commandName}. Type /help for available commands]`));
    return;
  }

  // If command has detailed help function, call it - 如果命令有详细帮助函数，调用它
  if (cmd.detailedHelp) {
    cmd.detailedHelp();
  } else {
    // Otherwise show basic info - 否则显示基本信息
    console.log(chalk.cyan(`\n/${cmd.name}`));
    if (cmd.aliases?.length) {
      console.log(chalk.dim(`Aliases: ${cmd.aliases.join(', ')}`));
    }
    console.log(chalk.dim(`\n${cmd.description}`));
    if (cmd.usage) {
      console.log(chalk.dim(`\nUsage: ${cmd.usage}`));
    }
    console.log();
  }
}

// Print status - 打印状态
function printStatus(context: InteractiveContext, currentConfig: CurrentConfig): void {
  const tokens = estimateTokens(context.messages);
  const capabilityProfile = getProviderCapabilityProfile(currentConfig.provider);
  console.log(chalk.bold('\nSession Status:\n'));
  console.log(chalk.dim(`  Provider:    ${chalk.cyan(currentConfig.provider)}${currentConfig.model ? ` / ${chalk.cyan(currentConfig.model)}` : ''}`));
  console.log(chalk.dim(`  Permission:  ${chalk.cyan(currentConfig.permissionMode)}`));
  console.log(chalk.dim(`  Reasoning:   ${chalk.cyan(currentConfig.reasoningMode)}`));
  console.log(chalk.dim(`  Execution:   ${chalk.cyan(describeParallelExecution(currentConfig.parallel))}`));
  if (capabilityProfile) {
    const capabilitySummary = describeProviderCapabilitySummary(capabilityProfile);
    const capabilityColor = capabilityProfile.transport === 'cli-bridge'
      ? chalk.yellow(capabilitySummary)
      : chalk.cyan(capabilitySummary);
    console.log(chalk.dim(`  Provider Cap:${' '} ${capabilityColor}`));
  }
  console.log(chalk.dim(`  Session ID:  ${context.sessionId}`));
  console.log(chalk.dim(`  Messages:    ${context.messages.length}`));
  console.log(chalk.dim(`  Tokens:      ~${tokens}`));
  if (context.gitRoot) {
    console.log(chalk.dim(`  Git Root:    ${context.gitRoot}`));
  }
  console.log(chalk.dim(`  Created:     ${context.createdAt}`));
  console.log(chalk.dim(`  Last Active: ${context.lastAccessed}`));
  console.log();
}

// Handle /skill namespace command (pi-mono style) - 处理 /skill 命名空间命令
async function handleSkillNamespaceCommand(args: string[], context: InteractiveContext): Promise<void> {
  const registry = getSkillRegistry(context.gitRoot);

  // Ensure skills are discovered - 确保已发现技能
  if (registry.size === 0) {
    await initializeSkillRegistry(context.gitRoot);
  }

  // /skill without :name shows the list - /skill 不带 :name 显示列表
  printSkillsListPiMonoStyle(registry.listUserInvocable());
}

// Print skills list in pi-mono style - 以 pi-mono 风格打印技能列表
function printSkillsListPiMonoStyle(skills: SkillMetadata[]): void {
  console.log(chalk.bold('\nAvailable Skills:\n'));

  if (skills.length === 0) {
    console.log(chalk.dim('  No skills found.'));
    console.log(chalk.dim('\n  Skills can be placed in:'));
    console.log(chalk.dim('    - .kodax/skills/'));
    console.log(chalk.dim('    - ~/.kodax/skills/'));
    return;
  }

  const maxNameLen = Math.max(...skills.map(s => s.name.length));

  for (const skill of skills) {
    // Pad first, then color - 避免 ANSI 码影响 padEnd 计算
    const paddedName = skill.name.padEnd(maxNameLen);
    const hint = skill.argumentHint ? ` ${skill.argumentHint}` : '';
    // Show source for all skills except project level (which is the default)
    // 显示所有技能来源，project 级别不显示（默认）
    const sourceLabel = skill.source === 'builtin' ? ' [builtin]'
      : skill.source === 'user' ? ' [user]'
      : skill.source === 'plugin' ? ' [plugin]'
            : '';
    // pi-mono style: /skill:name
    const desc = skill.description.length > 50
      ? skill.description.slice(0, 50) + '...'
      : skill.description;
    console.log(`  ${chalk.cyan(`/skill:${paddedName}`)}${chalk.dim(hint)}${chalk.dim(sourceLabel)}  ${chalk.dim(desc)}`);
  }

  console.log();
  console.log(chalk.dim(`Total: ${skills.length} skills`));
  console.log(chalk.dim('Usage: /skill:<name> [args] or ask naturally'));
  console.log();
}

// Command registry - 命令注册表
const commandRegistry = new CommandRegistry();

// Initialize command registry - 初始化命令注册表
function initCommandRegistry(projectRoot?: string): void {
  if (commandRegistry.size > 0) {
    return;
  }

  // Register all commands (builtin + discovered user/project commands)
  // 注册所有命令（内置 + 发现的用户/项目命令）
  registerAllCommands(commandRegistry, projectRoot);
}

export function getCommandRegistry(projectRoot?: string): CommandRegistry {
  initCommandRegistry(projectRoot);
  return commandRegistry;
}

// Parse command - 解析命令
export function parseCommand(input: string): { command: string; args: string[]; skillInvocation?: { name: string } } | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return null;

  const parts = trimmed.slice(1).split(/\s+/);
  const rawCommand = parts[0]?.toLowerCase();
  let command = rawCommand;
  let args = parts.slice(1).filter(Boolean);

  if (!command) return null;

  // Check for /skill:name format (pi-mono style) - 检查 /skill:name 格式
  if (command.startsWith('skill:')) {
    const skillName = command.slice(6); // Remove 'skill:' prefix
    if (skillName) {
      return { command: 'skill', args, skillInvocation: { name: skillName } };
    }
    // /skill: with no name - treat as /skill
    return { command: 'skill', args };
  }

  const colonIndex = command.indexOf(':');
  if (colonIndex > 0) {
    const inlineArg = command.slice(colonIndex + 1).trim();
    command = command.slice(0, colonIndex);
    args = inlineArg ? [inlineArg, ...args] : args;
  }

  return { command, args };
}

// Execute command - 执行命令
export type CommandResult = boolean | {
  skillContent?: string;
  projectInitPrompt?: string;
  invocation?: CommandInvocationRequest;
};

export async function executeCommand(
  parsed: { command: string; args: string[]; skillInvocation?: { name: string } },
  context: InteractiveContext,
  callbacks: CommandCallbacks,
  currentConfig: CurrentConfig
): Promise<CommandResult> {
  // Lazy initialization - 延迟初始化
  if (commandRegistry.size === 0) {
    initCommandRegistry(context.gitRoot);
  }

  // Handle /skill:name format (pi-mono style) - 处理 /skill:name 格式
  if (parsed.skillInvocation) {
    return await executeSkillCommand(
      { command: parsed.skillInvocation.name, args: parsed.args },
      context
    );
  }

  const cmd = commandRegistry.get(parsed.command);
  if (cmd) {
    if (cmd.userInvocable === false) {
      console.log(chalk.yellow(`\n[Command /${cmd.name} is not user-invocable]`));
      return false;
    }

    try {
      const result = await cmd.handler(parsed.args, context, callbacks, currentConfig);
      // Handle project init prompt - 处理项目初始化提示
      if (result && typeof result === 'object') {
        return result;
      }
      return true;
    } catch (error) {
      console.log(chalk.red(`\n[Command failed: ${error instanceof Error ? error.message : String(error)}]`));
      return false;
    }
  }

  console.log(chalk.yellow(`\n[Unknown command: /${parsed.command}. Type /help for available commands]`));
  return false;
}

// Execute skill command - 执行技能命令
async function executeSkillCommand(
  parsed: { command: string; args: string[] },
  context: InteractiveContext
): Promise<CommandResult> {
  const registry = getSkillRegistry(context.gitRoot);
  const skillName = parsed.command;
  const skillArgs = parsed.args.join(' ');

  // Ensure skills are discovered - 确保已发现技能
  if (registry.size === 0) {
    await initializeSkillRegistry(context.gitRoot);
  }

  try {
    const skill = registry.get(skillName);
    if (!skill) {
      console.log(chalk.red(`\n[Skill not found: ${skillName}]`));
      return false;
    }
    if (!skill.userInvocable) {
      console.log(chalk.yellow(`\n[Skill "${skillName}" is not user-invocable]`));
      return false;
    }

    console.log(chalk.cyan(`\n[Invoking skill: ${skillName}]`));
    if (skill.argumentHint) {
      console.log(chalk.dim(`Arguments: ${skillArgs || '(none)'}`));
    }
    console.log();

    // Load full skill and get resolved content - 加载完整技能并获取解析后的内容
    const fullSkill = await registry.loadFull(skillName);

    // Check if model invocation is disabled - 检查是否禁用模型调用
    // Create skill context for variable resolution - 创建变量解析上下文
    const skillContext: SkillContext = {
      workingDirectory: process.cwd(),
      projectRoot: context.gitRoot ?? undefined,
      sessionId: context.sessionId,
      environment: {},
    };

    // Expand skill for LLM injection - 展开技能以注入 LLM
    const expanded = await expandSkillForLLM(fullSkill, skillArgs, skillContext);

    // Show skill activation message - 显示技能激活消息
    console.log(chalk.green(`Skill activated: ${skillName}`));
    console.log(chalk.dim('The skill context has been prepared for the AI.'));
    console.log();

    return {
      invocation: {
        prompt: expanded.content,
        source: 'skill',
        displayName: skillName,
        path: fullSkill.skillFilePath,
        disableModelInvocation: expanded.disableModelInvocation,
        userInvocable: fullSkill.userInvocable,
        allowedTools: fullSkill.allowedTools,
        context: fullSkill.context,
        agent: fullSkill.agent,
        argumentHint: fullSkill.argumentHint,
        model: fullSkill.model,
        hooks: fullSkill.hooks,
      },
    };
  } catch (error) {
    console.log(chalk.red(`\n[Error invoking skill: ${error instanceof Error ? error.message : String(error)}]`));
    return false;
  }
}
