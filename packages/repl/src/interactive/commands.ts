/**
 * KodaX Interactive Command System
 */

import type * as readline from 'readline';
import chalk from 'chalk';
import { InteractiveContext, InteractiveMode } from './context.js';
import {
  estimateTokens,
  type ExtensionRuntimeDiagnostics,
  type KodaXAgentMode,
  type KodaXRepoIntelligenceMode,
  type RepoIntelligenceRuntimeInspection,
  KODAX_REASONING_MODE_SEQUENCE,
  getActiveExtensionRuntime,
  inspectRepoIntelligenceRuntime,
  isKnownProvider,
  getAvailableProviderNames,
  resolveProvider,
  type ExtensionCommandDefinition,
  type ExtensionCommandResult,
  type KodaXReasoningMode,
  KodaXOptions,
  warmRepoIntelligenceRuntime,
} from '@kodax/coding';
import type { AgentsFile } from '@kodax/coding';
import {
  PermissionMode,
  PERMISSION_MODES,
  normalizePermissionMode,
} from '../permission/types.js';
import {
  describeProviderCapabilitySummary,
  formatProviderCapabilityDetailLines,
  formatProviderSourceKind,
  describeReasoningCapabilityControl,
  describeReasoningExecution,
  formatReasoningCapabilityShort,
  getProviderCapabilitySnapshot,
  getProviderCapabilityProfile,
  getProviderCommonPolicyScenarios,
  getProviderPolicyDecision,
  getProviderReasoningCapability,
  getProviderAvailableModels,
  getProviderList,
  loadConfig,
  saveConfig,
} from '../common/utils.js';
import { savePermissionModeUser } from '../common/permission-config.js';
import { compact } from '@kodax/agent';
import type { CompactionConfig } from '@kodax/agent';
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
import { getActivePasteStore } from '../ui/utils/paste-store.js';
import { retrievePastedText } from '../ui/utils/paste-cache.js';
import {
  toCommandDefinition,
  type Command as RegisteredCommand,
  type CommandCallbacks,
  type CommandHandler as RegisteredCommandHandler,
  type CommandInvocationRequest,
  type CurrentConfig,
} from '../commands/types.js';
import { registerAllCommands } from '../commands/index.js';
import { formatWorkspaceTruth } from './workspace-runtime.js';

// Re-export types needed by downstream modules.
export type { CommandCallbacks, CurrentConfig } from '../commands/types.js';

// Builtin commands use the shared command definition so registry metadata stays in one model.
export type CommandHandler = RegisteredCommandHandler;
export type Command = RegisteredCommand;

// Built-in commands.
function summarizeAgentsFiles(files: AgentsFile[]): { global: number; directory: number; project: number } {
  return {
    global: files.filter(file => file.scope === 'global').length,
    directory: files.filter(file => file.scope === 'directory').length,
    project: files.filter(file => file.scope === 'project').length,
  };
}

function createManualCompactionConfig(
  config: CompactionConfig,
  currentTokens: number,
  contextWindow: number
): CompactionConfig {
  if (!Number.isFinite(currentTokens) || currentTokens <= 0 || contextWindow <= 0) {
    return { ...config, enabled: true };
  }

  const currentUsagePercent = (currentTokens / contextWindow) * 100;
  const forcedTriggerPercent = Math.max(1, Math.ceil(currentUsagePercent) - 1);

  return {
    ...config,
    enabled: true,
    triggerPercent: Math.min(config.triggerPercent, forcedTriggerPercent),
  };
}

function printWorkspaceUnchangedNote(context: InteractiveContext): void {
  if (context.runtimeInfo?.workspaceRoot) {
    console.log(chalk.dim(`  Workspace unchanged: ${formatWorkspaceTruth(context.runtimeInfo)}`));
  } else {
    console.log(chalk.dim('  Workspace unchanged.'));
  }
}

export const BUILTIN_COMMANDS: Command[] = [
  {
    name: 'help',
    aliases: ['h', '?'],
    description: 'Show all available commands',
    usage: '/help [command]',
    handler: async (args) => {
      if (args.length > 0) {
        // Show detailed help for a specific command.
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
      console.log();
    },
  },
  {
    name: 'exit',
    aliases: ['quit', 'q', 'bye'],
    description: 'Exit interactive mode',
    handler: async (_args, context, callbacks) => {
      await callbacks.saveSession();
      console.log(chalk.green('\nSession saved. Goodbye!'));
      await callbacks.exit();
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
      console.log(chalk.dim('  Exiting never removes or mutates the current workspace.'));
      console.log();
    },
  },
  {
    name: 'clear',
    description: 'Clear conversation history',
    handler: async (_args, context, callbacks) => {
      context.messages = [];  // Clear messages first
      context.contextTokenSnapshot = undefined;
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
    name: 'cost',
    description: 'Show session cost report',
    usage: '/cost',
    handler: async (_args, _context, callbacks) => {
      const report = callbacks.getCostReport?.();
      if (!report) {
        console.log(chalk.dim('\n[No cost data available yet]'));
        return;
      }
      console.log(chalk.cyan('\n' + report));
    },
    detailedHelp: () => {
      console.log(chalk.cyan('\n/cost - Session Cost Report\n'));
      console.log(chalk.bold('Description:'));
      console.log(chalk.dim('  Shows token usage and estimated cost for the current session,'));
      console.log(chalk.dim('  broken down by provider and AMA role.'));
      console.log();
    },
  },
  {
    // Issue 121: inspect a `[Pasted text #N]` placeholder's original content.
    name: 'paste',
    description: 'Inspect pasted text stored in the input buffer',
    usage: '/paste show <id> | /paste list',
    argumentHint: 'show <id> | list',
    handler: async (args) => {
      const sub = args[0]?.toLowerCase();

      if (!sub || sub === 'help') {
        console.log(chalk.cyan('\n/paste - Inspect stored paste contents'));
        console.log(chalk.dim('  /paste list           - Show all pasted text ids in this session'));
        console.log(chalk.dim('  /paste show <id>      - Print the full content of paste #<id>'));
        console.log();
        return;
      }

      const store = getActivePasteStore();
      if (!store) {
        console.log(chalk.yellow('\n[No paste registry active]'));
        console.log(chalk.dim('  The REPL composer is not mounted, or no paste has been captured yet.'));
        return;
      }

      if (sub === 'list') {
        const entries = store.export();
        if (entries.length === 0) {
          console.log(chalk.dim('\n[No pasted content in this session yet]'));
          return;
        }
        console.log(chalk.bold('\nPasted content in this session:\n'));
        for (const entry of entries) {
          const len = entry.content?.length ?? 0;
          const hashTag = entry.contentHash ? ` (hash ${entry.contentHash.slice(0, 8)})` : '';
          console.log(`  ${chalk.cyan(`#${entry.id}`)} ${entry.type} ${len} chars${hashTag}`);
        }
        console.log();
        return;
      }

      if (sub === 'show') {
        const rawId = args[1];
        const id = rawId ? Number.parseInt(rawId, 10) : NaN;
        if (!Number.isFinite(id) || id <= 0) {
          console.log(chalk.yellow('\nUsage: /paste show <id>'));
          return;
        }
        const entry = store.get(id);
        if (!entry) {
          console.log(chalk.dim(`\n[No paste registered with id #${id}]`));
          return;
        }
        let body = entry.content ?? '';
        if (!body && entry.contentHash) {
          const cached = await retrievePastedText(entry.contentHash);
          if (cached) body = cached;
        }
        if (!body) {
          console.log(chalk.yellow(`\n[Paste #${id} has no stored content (hash ${entry.contentHash ?? 'n/a'})]`));
          return;
        }
        console.log(chalk.bold(`\nPasted text #${id} (${body.length} chars):\n`));
        console.log(body);
        console.log();
        return;
      }

      console.log(chalk.yellow(`\n[Unknown /paste subcommand: ${sub}]`));
      console.log(chalk.dim('  Try /paste show <id> or /paste list'));
    },
    detailedHelp: () => {
      console.log(chalk.cyan('\n/paste - Inspect stored paste contents\n'));
      console.log(chalk.bold('Usage:'));
      console.log(chalk.dim('  /paste list           - Show all pasted text ids in this session'));
      console.log(chalk.dim('  /paste show <id>      - Print the full content of paste #<id>'));
      console.log();
      console.log(chalk.bold('Description:'));
      console.log(chalk.dim('  When you paste more than ~800 chars into the input bar, KodaX'));
      console.log(chalk.dim('  replaces the pasted text with a `[Pasted text #N +K lines]` anchor'));
      console.log(chalk.dim('  to keep the UI responsive. The full content is preserved and sent'));
      console.log(chalk.dim('  to the LLM on submit. Use this command to see what was captured.'));
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

        // Get provider instance
        const providerName = currentConfig.provider;
        const provider = resolveProvider(providerName);

        if (!provider) {
          console.log(chalk.red(`\n[Provider not found: ${providerName}]`));
          return;
        }

        // Get custom instructions if provided
        const customInstructions = args.length > 0 ? args.join(' ') : undefined;

        // Get contextWindow:
        //   user config (manual override)
        //   > active model descriptor (FEATURE_098)
        //   > provider default
        //   > 200k fallback
        const contextWindow = config.contextWindow
          ?? provider.getEffectiveContextWindow?.(currentConfig.model)
          ?? provider.getContextWindow?.()
          ?? 200000;
        const currentTokens = context.contextTokenSnapshot?.currentTokens ?? estimateTokens(context.messages);
        const manualConfig = createManualCompactionConfig(config, currentTokens, contextWindow);

        console.log(chalk.dim('\n[Compacting conversation...]'));

        // Start compacting indicator
        callbacks.startCompacting?.();

        try {
          // Manual compaction stays available even when auto-compaction is disabled
          // or the automatic threshold has not been reached yet.
          const result = await compact(
            context.messages,
            manualConfig,
            provider,
            contextWindow,
            customInstructions,
            undefined,
            currentTokens
          );

          if (!result.compacted) {
            console.log(chalk.green('\n[No compaction needed]'));
            console.log(chalk.dim(`Current token usage: ${result.tokensBefore.toLocaleString()}\n`));
            return;
          }

          // Update context with compacted messages
          context.messages = result.messages;
          context.contextTokenSnapshot = {
            currentTokens: result.tokensAfter,
            baselineEstimatedTokens: result.tokensAfter,
            source: 'estimate',
          };

          // Clear UI history - it will be re-created from the new context.messages
          // This ensures the UI shows the summary + protected recent context.
          // Clear UI history so it can be rebuilt from the compacted messages.
          // This keeps the summary and protected recent context visible.
          callbacks.clearHistory?.();

          // Save compacted messages to session storage
          await callbacks.saveSession();

          // Display statistics
          console.log(chalk.green(`\n[Compaction complete: ${Math.round(result.tokensBefore / 1000)}k -> ${Math.round(result.tokensAfter / 1000)}k tokens, ${Math.round((1 - result.tokensAfter / result.tokensBefore) * 100)}% reduced]`));
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
      console.log(chalk.dim('  /compact still works even if auto-compaction is disabled or the auto threshold is not reached.'));
      console.log();
      console.log(chalk.bold('What it does:'));
      console.log(chalk.dim('  1. Protects a recent slice of context from pruning/summary'));
      console.log(chalk.dim('  2. Generates structured summary of older messages using LLM'));
      console.log(chalk.dim('  3. Tracks files that were read/modified in the conversation'));
      console.log(chalk.dim('  4. Replaces old messages with summary to save tokens'));
      console.log();
      console.log(chalk.bold('Configuration:'));
      console.log(chalk.dim('  Config file: ~/.kodax/config.json'));
      console.log(chalk.dim('  Settings:'));
      console.log(chalk.dim('    - compaction.triggerPercent: Usage percentage that triggers compaction'));
      console.log(chalk.dim('    - compaction.enabled: Controls auto-compaction only; /compact always remains available'));
      console.log(chalk.dim('    - compaction.contextWindow: Optional token-window override'));
      console.log(chalk.dim('    - compaction.protectionPercent / rollingSummaryPercent / pruningThresholdTokens: Advanced tuning'));
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
    description: 'Reload project rules and active extensions',
    handler: async (_args, _context, callbacks, _currentConfig) => {
      console.log(chalk.cyan('\nReloading project rule files and runtime extensions...\n'));

      try {
        const files = await callbacks.reloadAgentsFiles?.() ?? [];
        const result = summarizeAgentsFiles(files);
        const extensionRuntime = getActiveExtensionRuntime();
        const extensionCount = extensionRuntime
          ? getExtensionRuntimeDiagnostics(extensionRuntime).loadedExtensions.length
          : 0;
        const previousFailureCount = extensionRuntime
          ? getExtensionRuntimeDiagnostics(extensionRuntime).failures.length
          : 0;
        let reloadedExtensions = 0;
        let reloadFailures = 0;

        if (extensionRuntime) {
          await extensionRuntime.reloadExtensions({ continueOnError: true });
          const diagnostics = getExtensionRuntimeDiagnostics(extensionRuntime);
          reloadedExtensions = extensionCount || diagnostics.loadedExtensions.length;
          reloadFailures = Math.max(0, diagnostics.failures.length - previousFailureCount);
        }

        if (files.length === 0 && reloadedExtensions === 0) {
          console.log(chalk.yellow('No project rule files or active extensions found.\n'));
          console.log(chalk.dim('  Create AGENTS.md or CLAUDE.md in your project, or load extensions with --extension.'));
          console.log();
          return;
        }

        console.log(chalk.green('Rules reloaded successfully:\n'));
        if (result.global > 0) {
          console.log(chalk.dim(`  - Global: ${result.global} file(s)`));
        }
        if (result.directory > 0) {
          console.log(chalk.dim(`  - Directory: ${result.directory} file(s)`));
        }
        if (result.project > 0) {
          console.log(chalk.dim(`  - Project: ${result.project} file(s)`));
        }
        if (reloadedExtensions > 0) {
          console.log(chalk.dim(`  - Extensions: ${reloadedExtensions} module(s)`));
        }
        if (reloadFailures > 0) {
          console.log(chalk.yellow(`  - Failures: ${reloadFailures} recorded (run /extensions for details)`));
        }
        console.log(chalk.dim('  Updated rules will apply to subsequent requests in this session.'));
        console.log();
        return;
      } catch (error) {
        console.log(chalk.red('Failed to reload rules.\n'));
        console.log(chalk.dim(`  Error: ${error instanceof Error ? error.message : String(error)}`));
        console.log();
      }
    },
    detailedHelp: () => {
      console.log(chalk.cyan('\n/reload - Reload Project Rules\n'));
      console.log(chalk.bold('Usage:'));
      console.log(chalk.dim('  /reload            ') + 'Reload project rule files and active extensions');
      console.log();
      console.log(chalk.bold('Description:'));
      console.log('  Reloads project-level context rules from AGENTS.md, CLAUDE.md, and .kodax/AGENTS.md files.');
      console.log('  If a runtime extension host is active, it also hot-reloads loaded extensions.');
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
    name: 'extensions',
    aliases: ['ext'],
    description: 'Show active extension runtime diagnostics',
    usage: '/extensions',
    handler: async () => {
      const runtime = getActiveExtensionRuntime();
      if (!runtime) {
        console.log(chalk.yellow('\n[No active extension runtime]\n'));
        return;
      }

      const diagnostics = getExtensionRuntimeDiagnostics(runtime);
      const extensionTools = diagnostics.tools.filter((tool) => tool.source.kind === 'extension');

      console.log(chalk.bold('\nExtension Runtime:\n'));
      console.log(chalk.dim(`  Loaded:          ${diagnostics.loadedExtensions.length}`));
      console.log(chalk.dim(`  Capabilities:    ${diagnostics.capabilityProviders.length}`));
      console.log(chalk.dim(`  Commands:        ${diagnostics.commands.length}`));
      console.log(chalk.dim(`  Hooks:           ${diagnostics.hooks.length}`));
      console.log(chalk.dim(`  Failures:        ${diagnostics.failures.length}`));
      console.log(chalk.dim(`  Extension Tools: ${extensionTools.length}`));
      if (diagnostics.defaults.activeTools !== undefined) {
        console.log(chalk.dim(`  Active Tools:    ${diagnostics.defaults.activeTools.join(', ') || '(none)'}`));
      }
      if (diagnostics.defaults.modelSelection.provider || diagnostics.defaults.modelSelection.model) {
        console.log(chalk.dim(`  Model Override:  ${diagnostics.defaults.modelSelection.provider ?? '(inherit)'} / ${diagnostics.defaults.modelSelection.model ?? '(inherit)'}`));
      }
      if (diagnostics.defaults.thinkingLevel) {
        console.log(chalk.dim(`  Thinking:        ${diagnostics.defaults.thinkingLevel}`));
      }
      console.log();

      if (diagnostics.loadedExtensions.length > 0) {
        console.log(chalk.bold('Loaded Extensions:'));
        for (const loaded of diagnostics.loadedExtensions) {
          console.log(chalk.dim(`  - ${loaded.label} [${loaded.loadSource}] (${loaded.path})`));
        }
        console.log();
      }

      if (diagnostics.commands.length > 0) {
        console.log(chalk.bold('Extension Commands:'));
        for (const command of diagnostics.commands) {
          const aliases = command.aliases?.length ? ` [${command.aliases.join(', ')}]` : '';
          console.log(chalk.dim(`  - /${command.name}${aliases}  ${command.description}`));
        }
        console.log();
      }

      if (diagnostics.capabilityProviders.length > 0) {
        console.log(chalk.bold('Capability Providers:'));
        for (const provider of diagnostics.capabilityProviders) {
          const metadata = formatExtensionDiagnosticMetadata(provider.metadata);
          console.log(chalk.dim(`  - ${provider.id} [${provider.kinds.join(', ')}]${metadata ? `  ${metadata}` : ''}`));
        }
        console.log();
      }

      if (extensionTools.length > 0) {
        console.log(chalk.bold('Extension Tools:'));
        for (const tool of extensionTools) {
          const overrideNote = tool.shadowedSources.length > 0
            ? `  overrides: ${tool.shadowedSources.map((source) => source.label ?? source.id ?? source.kind).join(', ')}`
            : '';
          console.log(chalk.dim(`  - ${tool.name}${overrideNote}`));
        }
        console.log();
      }

      if (diagnostics.hooks.length > 0) {
        console.log(chalk.bold('Hook Participation:'));
        for (const hook of diagnostics.hooks) {
          console.log(chalk.dim(`  - ${hook.hook} [#${hook.order}] ${hook.source.label}`));
        }
        console.log();
      }

      if (diagnostics.failures.length > 0) {
        console.log(chalk.bold('Recent Failures:'));
        for (const failure of diagnostics.failures.slice(-10)) {
          console.log(chalk.dim(`  - [${failure.stage}] ${failure.source.label}: ${failure.target} -> ${failure.message}`));
        }
        console.log();
      }
    },
  },
  {
    name: 'status',
    aliases: ['info', 'ctx'],
    description: 'Show current session status',
    handler: async (args, context, _callbacks, currentConfig) => {
      await printStatus(context, currentConfig, args);
    },
    detailedHelp: () => {
      console.log(chalk.cyan('\n/status - Show Session Status\n'));
      console.log(chalk.bold('Usage:'));
      console.log(chalk.dim('  /status            ') + 'Display current session information');
      console.log(chalk.dim('  /status workspace  ') + 'Show deeper workspace/runtime details');
      console.log(chalk.dim('  /info, /ctx        ') + 'Aliases for /status');
      console.log();
      console.log(chalk.bold('Displays:'));
      console.log(chalk.dim('  - Current mode (code/ask)'));
      console.log(chalk.dim('  - Session ID'));
      console.log(chalk.dim('  - Message count'));
      console.log(chalk.dim('  - Estimated token usage'));
      console.log(chalk.dim('  - Current workspace truth'));
      console.log(chalk.dim('  - Session timestamps'));
      console.log(chalk.dim('  - Repo-intelligence mode and active runtime summary'));
      console.log();
    },
  },
  {
    name: 'mcp',
    description: 'Show MCP server status or refresh catalogs',
    usage: '/mcp [status|refresh]',
    handler: async (args) => {
      const extensionRuntime = getActiveExtensionRuntime();
      if (!extensionRuntime) {
        console.log(chalk.yellow('\n[No extension runtime active — MCP is not available]'));
        return;
      }
      const diagnostics = getExtensionRuntimeDiagnostics(extensionRuntime);
      const mcpProvider = diagnostics.capabilityProviders.find((p) => p.id === 'mcp');

      const subcommand = args[0]?.toLowerCase() ?? 'status';

      if (subcommand === 'refresh') {
        console.log(chalk.dim('\nRefreshing MCP catalogs...'));
        try {
          await extensionRuntime.refreshCapabilityProviders('mcp');
          console.log(chalk.green('MCP catalogs refreshed.'));
        } catch (error) {
          console.log(chalk.red(`Refresh failed: ${error instanceof Error ? error.message : String(error)}`));
        }
        return;
      }

      // Default: status
      console.log(chalk.cyan('\nMCP Status\n'));
      if (!mcpProvider) {
        console.log(chalk.yellow('  No MCP provider registered.'));
        console.log(chalk.dim('  Add mcpServers to ~/.kodax/config.json to enable MCP.\n'));
        return;
      }

      const meta = mcpProvider.metadata as Record<string, unknown> | undefined;
      const servers = (meta?.servers ?? []) as Array<{
        serverId: string; connect: string; status: string;
        tools: number; resources: number; prompts: number;
        lastError?: string; cachedAt?: string;
      }>;

      console.log(chalk.dim(`  Servers: ${servers.length}`));
      console.log();
      for (const s of servers) {
        const statusColor = s.status === 'ready' ? chalk.green
          : s.status === 'error' ? chalk.red
          : chalk.yellow;
        console.log(`  ${chalk.bold(s.serverId)}  ${statusColor(s.status)}  connect=${chalk.dim(s.connect)}`);
        if (s.cachedAt) {
          console.log(chalk.dim(`    tools=${s.tools}  resources=${s.resources}  prompts=${s.prompts}`));
        }
        if (s.lastError) {
          console.log(chalk.red(`    error: ${s.lastError}`));
        }
      }
      console.log();
    },
    detailedHelp: () => {
      console.log(chalk.cyan('\n/mcp - MCP Server Management\n'));
      console.log(chalk.bold('Usage:'));
      console.log(chalk.dim('  /mcp            ') + 'Show MCP server status');
      console.log(chalk.dim('  /mcp status     ') + 'Same as /mcp');
      console.log(chalk.dim('  /mcp refresh    ') + 'Force-refresh all MCP server catalogs');
      console.log();
    },
  },
  {
    name: 'repointel',
    aliases: ['ri'],
    description: 'Inspect or control the repo-intelligence premium runtime',
    usage: '/repointel [status|mode|trace|warm|endpoint|bin]',
    handler: async (args, _context, callbacks, currentConfig) => {
      const subcommand = args[0]?.toLowerCase() ?? 'status';

      if (subcommand === 'status') {
        const inspection = await inspectRepoIntelligenceRuntime({
          mode: currentConfig.repoIntelligenceMode,
          trace: currentConfig.repoIntelligenceTrace,
          probePremium: true,
        });
        printRepoIntelligenceInspection(inspection);
        return;
      }

      if (subcommand === 'warm') {
        const result = await warmRepoIntelligenceRuntime({
          mode: currentConfig.repoIntelligenceMode,
          trace: currentConfig.repoIntelligenceTrace,
        });
        printRepoIntelligenceWarmResult(result);
        return;
      }

      if (subcommand === 'mode') {
        if (args.length === 1) {
          console.log(chalk.dim(`\nCurrent repo-intelligence mode: ${chalk.cyan(currentConfig.repoIntelligenceMode ?? 'auto')}`));
          console.log(chalk.dim('Usage: /repointel mode [auto|off|oss|premium-shared|premium-native]\n'));
          return;
        }

        const mode = normalizeRepoIntelligenceMode(args[1]);
        if (!mode) {
          console.log(chalk.red(`\n[Invalid repo-intelligence mode: ${args[1]}]`));
          console.log(chalk.dim('Usage: /repointel mode [auto|off|oss|premium-shared|premium-native]\n'));
          return;
        }

        const persistence = applyRepoIntelligenceRuntimeConfig(
          { mode },
          { repoIntelligenceMode: mode },
          callbacks,
          currentConfig,
        );
        printPersistedCommandStatus(`Repo intelligence mode: ${mode}`, persistence);
        return;
      }

      if (subcommand === 'trace') {
        const raw = args[1]?.toLowerCase();
        if (!raw) {
          console.log(chalk.dim(`\nCurrent repo-intelligence trace: ${chalk.cyan(currentConfig.repoIntelligenceTrace ? 'on' : 'off')}`));
          console.log(chalk.dim('Usage: /repointel trace [on|off|toggle]\n'));
          return;
        }

        const nextValue = resolveToggleFlag(raw, currentConfig.repoIntelligenceTrace ?? false);
        if (nextValue === null) {
          console.log(chalk.red(`\n[Invalid trace value: ${args[1]}]`));
          console.log(chalk.dim('Usage: /repointel trace [on|off|toggle]\n'));
          return;
        }

        const persistence = applyRepoIntelligenceRuntimeConfig(
          { trace: nextValue },
          { repoIntelligenceTrace: nextValue },
          callbacks,
          currentConfig,
        );
        printPersistedCommandStatus(`Repo intelligence trace: ${nextValue ? 'on' : 'off'}`, persistence);
        return;
      }

      if (subcommand === 'endpoint') {
        if (args.length === 1) {
          const inspection = await inspectRepoIntelligenceRuntime({
            mode: currentConfig.repoIntelligenceMode,
            trace: currentConfig.repoIntelligenceTrace,
          });
          console.log(chalk.dim(`\nCurrent repointel endpoint: ${chalk.cyan(inspection.endpoint)}`));
          console.log(chalk.dim('Usage: /repointel endpoint [http://host:port|default]\n'));
          return;
        }

        const nextEndpoint = normalizeRuntimeOverride(args[1]);
        const persistence = applyRepoIntelligenceRuntimeConfig(
          { endpoint: nextEndpoint },
          { repointelEndpoint: nextEndpoint ?? undefined },
          callbacks,
          currentConfig,
        );
        printPersistedCommandStatus(
          `Repointel endpoint: ${nextEndpoint ?? 'default'}`,
          persistence,
        );
        return;
      }

      if (subcommand === 'bin') {
        if (args.length === 1) {
          const inspection = await inspectRepoIntelligenceRuntime({
            mode: currentConfig.repoIntelligenceMode,
            trace: currentConfig.repoIntelligenceTrace,
          });
          console.log(chalk.dim(`\nCurrent repointel bin: ${chalk.cyan(inspection.bin)}`));
          console.log(chalk.dim('Usage: /repointel bin [<path-or-command>|default]\n'));
          return;
        }

        const nextBin = normalizeRuntimeOverride(args.slice(1).join(' '));
        const persistence = applyRepoIntelligenceRuntimeConfig(
          { bin: nextBin },
          { repointelBin: nextBin ?? undefined },
          callbacks,
          currentConfig,
        );
        printPersistedCommandStatus(
          `Repointel bin: ${nextBin ?? 'default'}`,
          persistence,
        );
        return;
      }

      console.log(chalk.red(`\n[Unknown /repointel subcommand: ${args[0]}]`));
      console.log(chalk.dim('Usage: /repointel [status|mode|trace|warm|endpoint|bin]\n'));
    },
    detailedHelp: () => {
      console.log(chalk.cyan('\n/repointel - Repo-Intelligence Runtime Control\n'));
      console.log(chalk.bold('Usage:'));
      console.log(chalk.dim('  /repointel                             ') + 'Show current repo-intelligence and premium runtime status');
      console.log(chalk.dim('  /repointel status                      ') + 'Probe the local premium frontdoor and print detailed status');
      console.log(chalk.dim('  /repointel mode auto                   ') + 'Prefer premium-native when available, otherwise fall back to OSS');
      console.log(chalk.dim('  /repointel mode off                    ') + 'Strictly disable repo-intelligence working tools and auto lane for this session');
      console.log(chalk.dim('  /repointel mode oss                    ') + 'Force the OSS baseline only');
      console.log(chalk.dim('  /repointel mode premium-shared         ') + 'Use premium without KodaX native auto lane');
      console.log(chalk.dim('  /repointel mode premium-native         ') + 'Use the KodaX flagship premium path');
      console.log(chalk.dim('  /repointel trace on|off|toggle         ') + 'Toggle repo-intelligence trace output');
      console.log(chalk.dim('  /repointel endpoint http://127.0.0.1:47891') + 'Override the local premium daemon endpoint');
      console.log(chalk.dim('  /repointel endpoint default            ') + 'Clear the endpoint override and use the default');
      console.log(chalk.dim('  /repointel bin repointel               ') + 'Use a PATH-visible repointel command');
      console.log(chalk.dim('  /repointel bin <path>                  ') + 'Use an explicit repointel launcher path');
      console.log(chalk.dim('  /repointel bin default                 ') + 'Clear the bin override and use the default command');
      console.log(chalk.dim('  /repointel warm                        ') + 'Try to start or warm the local premium daemon');
      console.log();
      console.log(chalk.bold('Notes:'));
      console.log(chalk.dim('  - /status now includes a compact repo-intelligence summary.'));
      console.log(chalk.dim('  - /repointel warm is operational: it can warm the premium runtime even when your current mode is oss/off.'));
      console.log(chalk.dim('  - If the local service cannot be started, KodaX will continue with the OSS baseline and this command will explain why.'));
      console.log();
    },
  },
  {
    name: 'mode',
    description: 'Show or switch permission mode (plan/accept-edits/auto)',
    usage: '/mode [plan|accept-edits|auto]',
    handler: async (args, _context, callbacks, currentConfig) => {
      if (args.length === 0) {
        const m = normalizePermissionMode(currentConfig.permissionMode, 'accept-edits') ?? 'accept-edits';
        console.log(chalk.dim(`\nCurrent mode: ${chalk.cyan(m)}`));
        console.log(chalk.dim('Usage: /mode [plan|accept-edits|auto]'));
        return;
      }
      const newMode = args[0] as PermissionMode;
      if (PERMISSION_MODES.includes(newMode)) {
        currentConfig.permissionMode = newMode;
        callbacks.setPermissionMode?.(newMode);
        savePermissionModeUser(newMode);
        console.log(chalk.cyan(`\n[Switched to ${newMode} mode] (saved)`));
      } else {
        console.log(chalk.red(`\n[Unknown mode: ${args[0]}. Use: plan | accept-edits | auto]`));
      }
    },
    detailedHelp: () => {
      console.log(chalk.cyan('\n/mode - Switch Permission Mode\n'));
      console.log(chalk.bold('Usage:'));
      console.log(chalk.dim('  /mode                        ') + 'Show current permission mode');
      console.log(chalk.dim('  /mode plan                   ') + 'Read-only: blocks all modifications');
      console.log(chalk.dim('  /mode accept-edits           ') + 'File edits auto, bash requires confirmation');
      console.log(chalk.dim('  /mode auto                   ') + 'LLM classifier reviews each tool call (FEATURE_092)');
      console.log(chalk.dim('  /mode auto-in-project        ') + chalk.gray('(deprecated alias for auto; will be removed in v0.7.38)'));
      console.log();
      console.log(chalk.bold('Permission Levels:'));
      console.log(chalk.yellow('  plan          ') + chalk.dim('- Read-only planning, no file/command modifications'));
      console.log(chalk.green('  accept-edits  ') + chalk.dim('- File edits auto-approved, bash still requires confirmation'));
      console.log(chalk.green('  auto          ') + chalk.dim('- LLM classifier (engine=llm, default) or rules engine reviews each call'));
      console.log();
      console.log(chalk.bold('Notes:'));
      console.log(chalk.dim('  - .kodax/ directory and project-external paths always require confirmation'));
      console.log(chalk.dim('  - Mode is saved to ~/.kodax/config.json (user-level)'));
      console.log();
    },
  },
  {
    // FEATURE_092 phase 2b.8: read-only or set classifier engine for current session.
    name: 'auto-engine',
    description: 'Show or set auto-mode classifier engine (llm | rules)',
    usage: '/auto-engine [llm|rules]',
    handler: async (args, _context, callbacks) => {
      const stats = callbacks.getAutoModeStats?.();
      if (!stats) {
        console.log(chalk.yellow('\n[auto-engine] not in auto mode — switch via /mode auto first'));
        return;
      }
      if (args.length === 0) {
        console.log(chalk.dim(`\nClassifier engine: ${chalk.cyan(stats.engine)}`));
        console.log(chalk.dim(`  consecutive denials: ${stats.denials.consecutive}`));
        console.log(chalk.dim(`  cumulative denials:  ${stats.denials.cumulative}`));
        console.log(chalk.dim(`  breaker errors:      ${stats.breaker.timestamps.filter((t) => t >= Date.now() - 10 * 60 * 1000).length}`));
        console.log(chalk.dim('Usage: /auto-engine [llm|rules]'));
        return;
      }
      const newEngine = args[0];
      if (newEngine !== 'llm' && newEngine !== 'rules') {
        console.log(chalk.red(`\n[auto-engine] unknown engine "${args[0]}" — use llm or rules`));
        return;
      }
      callbacks.setAutoModeEngine?.(newEngine);
      console.log(chalk.cyan(`\n[auto-engine] switched to ${newEngine}`));
      if (newEngine === 'rules') {
        console.log(chalk.dim('  every non-Tier-1 tool call now escalates to user confirmation'));
      } else {
        console.log(chalk.dim('  classifier consultation resumed; threshold downgrades still apply'));
      }
    },
    detailedHelp: () => {
      console.log(chalk.cyan('\n/auto-engine - Auto-Mode Classifier Engine Toggle\n'));
      console.log(chalk.bold('Usage:'));
      console.log(chalk.dim('  /auto-engine                 ') + 'Show current engine + denial/breaker counts');
      console.log(chalk.dim('  /auto-engine llm             ') + 'Resume classifier consultation (default)');
      console.log(chalk.dim('  /auto-engine rules           ') + 'Skip classifier; every non-Tier-1 call asks user');
      console.log();
      console.log(chalk.bold('Notes:'));
      console.log(chalk.dim('  - Only meaningful in auto mode (/mode auto).'));
      console.log(chalk.dim('  - The classifier may auto-downgrade to rules after 3 consecutive blocks,'));
      console.log(chalk.dim('    20 cumulative blocks, or 5 errors in a 10-minute window. /auto-engine llm'));
      console.log(chalk.dim('    manually flips back to llm.'));
      console.log(chalk.dim('  - Override via env: KODAX_AUTO_MODE_ENGINE=rules.'));
      console.log();
    },
  },
  {
    // FEATURE_092 phase 2b.8: dump tracker + breaker stats. Useful for the
    // pilot to verify "5 fallback paths" manually + for debugging downgrades.
    name: 'auto-denials',
    description: 'Show auto-mode classifier denial tracker + circuit breaker stats',
    usage: '/auto-denials',
    handler: async (_args, _context, callbacks) => {
      const stats = callbacks.getAutoModeStats?.();
      if (!stats) {
        console.log(chalk.yellow('\n[auto-denials] not in auto mode — switch via /mode auto first'));
        return;
      }
      console.log(chalk.cyan('\n[auto-mode classifier stats]'));
      console.log(chalk.dim(`  engine:               ${chalk.cyan(stats.engine)}`));
      console.log(chalk.dim('  Denial tracker:'));
      console.log(chalk.dim(`    consecutive blocks: ${stats.denials.consecutive} / 3`));
      console.log(chalk.dim(`    cumulative blocks:  ${stats.denials.cumulative} / 20`));
      console.log(chalk.dim('  Circuit breaker:'));
      console.log(chalk.dim(`    errors in window:   ${stats.breaker.timestamps.filter((t) => t >= Date.now() - 10 * 60 * 1000).length} / 5 (10 min)`));
      console.log();
      if (stats.engine === 'rules') {
        console.log(chalk.yellow('  ↪ engine has downgraded to rules. /auto-engine llm to flip back.'));
      }
      console.log();
    },
    detailedHelp: () => {
      console.log(chalk.cyan('\n/auto-denials - Auto-Mode Classifier Diagnostic Dump\n'));
      console.log(chalk.bold('Usage:'));
      console.log(chalk.dim('  /auto-denials                ') + 'Print engine + tracker + breaker counters');
      console.log();
      console.log(chalk.bold('Thresholds (FEATURE_092):'));
      console.log(chalk.dim('  - 3 consecutive blocks  → engine downgrade to rules'));
      console.log(chalk.dim('  - 20 cumulative blocks  → engine downgrade to rules'));
      console.log(chalk.dim('  - 5 errors in 10-min    → circuit breaker trips → engine downgrade'));
      console.log();
    },
  },
  {
    name: 'save',
    description: 'Save current session',
    handler: async (_args, context, callbacks) => {
      await callbacks.saveSession();
      console.log(chalk.green('\n[Session saved]'));
      printWorkspaceUnchangedNote(context);
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
      console.log(chalk.dim('  Saving updates session storage only; the current workspace stays untouched.'));
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
      const status = await callbacks.loadSession(args[0]!);
      if (status === 'missing') {
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
      console.log(chalk.bold('Workspace behavior:'));
      console.log(chalk.dim('  /load can resume sessions from sibling workspaces in the same canonical repo.'));
      console.log(chalk.dim('  If a saved workspace is unavailable, KodaX explains the fallback before loading.'));
      console.log();
      console.log(chalk.dim('  See also: /help sessions, /help save'));
      console.log();
    },
  },
  {
    name: 'tree',
    description: 'Inspect or switch the current session tree',
    usage: '/tree [entry-id|label] | /tree label <entry-id|label> <name> | /tree unlabel <entry-id|label>',
    handler: async (args, _context, callbacks) => {
      if (args.length === 0) {
        await callbacks.printSessionTree?.();
        return;
      }

      const subcommand = args[0]?.trim().toLowerCase();
      if (subcommand === 'label') {
        if (args.length < 3) {
          console.log(chalk.red('\n[Usage: /tree label <entry-id|label> <name>]'));
          return;
        }
        const success = await callbacks.labelSessionBranch?.(args[1]!, args.slice(2).join(' '));
        if (!success) {
          console.log(chalk.red(`\n[Tree entry not found: ${args[1]}]`));
        }
        return;
      }

      if (subcommand === 'unlabel') {
        if (args.length < 2) {
          console.log(chalk.red('\n[Usage: /tree unlabel <entry-id|label>]'));
          return;
        }
        const success = await callbacks.labelSessionBranch?.(args[1]!, undefined);
        if (!success) {
          console.log(chalk.red(`\n[Tree entry not found: ${args[1]}]`));
        }
        return;
      }

      const status = await callbacks.switchSessionBranch?.(args[0]!);
      if (status === 'missing') {
        console.log(chalk.red(`\n[Tree entry not found: ${args[0]}]`));
      }
    },
    detailedHelp: () => {
      console.log(chalk.cyan('\n/tree - Inspect Session Lineage\n'));
      console.log(chalk.bold('Usage:'));
      console.log(chalk.dim('  /tree                              ') + 'Show the current session tree');
      console.log(chalk.dim('  /tree <entry-id|label>             ') + 'Jump to a previous branch point');
      console.log(chalk.dim('  /tree label <entry-id|label> <name>') + 'Attach a lightweight checkpoint label');
      console.log(chalk.dim('  /tree unlabel <entry-id|label>     ') + 'Clear an existing checkpoint label');
      console.log();
      console.log(chalk.bold('Description:'));
      console.log(chalk.dim('  Session history is stored as a branchable tree. Use /tree to'));
      console.log(chalk.dim('  inspect the lineage, revisit an earlier branch safely, and add'));
      console.log(chalk.dim('  bookmark-style checkpoint labels without changing git state.'));
      console.log();
    },
  },
  {
    name: 'fork',
    description: 'Fork the current branch into a new session',
    usage: '/fork [entry-id|label]',
    handler: async (args, _context, callbacks) => {
      const status = await callbacks.forkSession?.(args[0]);
      if (status === 'failed') {
        console.log(chalk.red(`\n[Unable to fork session${args[0] ? ` from ${args[0]}` : ''}]`));
      }
    },
    detailedHelp: () => {
      console.log(chalk.cyan('\n/fork - Export a Branch to a New Session\n'));
      console.log(chalk.bold('Usage:'));
      console.log(chalk.dim('  /fork                 ') + 'Fork from the active branch');
      console.log(chalk.dim('  /fork <entry-id|label>') + 'Fork from a selected tree node');
      console.log();
      console.log(chalk.bold('Description:'));
      console.log(chalk.dim('  Creates a new session file from the selected branch so you can'));
      console.log(chalk.dim('  continue there without mutating the current session lineage.'));
      console.log();
    },
  },
  {
    name: 'rewind',
    description: 'Rewind the current session to a previous point',
    usage: '/rewind [entry-id|label]',
    handler: async (args, _context, callbacks) => {
      const status = await callbacks.rewindSession?.(args[0]);
      if (status === 'failed') {
        console.log(chalk.red(`\n[Unable to rewind${args[0] ? ` to ${args[0]}` : ' — no previous turn found'}]`));
      }
    },
    detailedHelp: () => {
      console.log(chalk.cyan('\n/rewind - Rewind Session to a Previous Point\n'));
      console.log(chalk.bold('Usage:'));
      console.log(chalk.dim('  /rewind                 ') + 'Rewind to the previous user input');
      console.log(chalk.dim('  /rewind <entry-id|label>') + 'Rewind to a specific tree node');
      console.log();
      console.log(chalk.bold('Description:'));
      console.log(chalk.dim('  Truncates the session after the target entry. Unlike /fork,'));
      console.log(chalk.dim('  this modifies the current session in place. The rewind event'));
      console.log(chalk.dim('  is recorded in the lineage for auditability.'));
      console.log();
      console.log(chalk.yellow('  ⚠ This is irreversible. Use /fork first to preserve a copy.'));
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
      console.log(chalk.dim('  message counts, titles, and workspace truth. Use /load <id> to resume.'));
      console.log(chalk.dim('  This keeps sibling worktree sessions inspectable without a persistent cockpit.'));
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
    handler: async (args, context, callbacks) => {
      if (args.length === 0) {
        console.log(chalk.red('\n[Usage: /delete <session-id> or /delete all]'));
        await callbacks.listSessions?.();
        return;
      }
      if (args[0] === 'all') {
        await callbacks.deleteAllSessions?.();
        console.log(chalk.green('\n[All sessions deleted]'));
        printWorkspaceUnchangedNote(context);
      } else {
        await callbacks.deleteSession?.(args[0]!);
        console.log(chalk.green(`\n[Session deleted: ${args[0]}]`));
        printWorkspaceUnchangedNote(context);
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
      console.log(chalk.bold('Workspace behavior:'));
      console.log(chalk.dim('  Deletes saved session records only.'));
      console.log(chalk.dim('  Current workspaces and checkouts remain untouched.'));
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
        // Show all providers with their models.
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

      // /model /<model-id>: switch model within current provider
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

      // /model <provider>/<model-id>: switch provider and model
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

      // /model <provider>: switch provider using its default model
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
    name: 'provider',
    description: 'Inspect provider semantics and policy constraints',
    usage: '/provider [<provider>[/<model>]]',
    handler: async (args, _context, _callbacks, currentConfig) => {
      const input = (args[0] ?? '').trim();

      let targetProvider = currentConfig.provider;
      let targetModel = currentConfig.model;

      if (input) {
        if (input.includes('/')) {
          const slashIndex = input.indexOf('/');
          targetProvider = input.slice(0, slashIndex).trim();
          targetModel = input.slice(slashIndex + 1).trim() || undefined;
        } else {
          targetProvider = input;
          targetModel = undefined;
        }
      }

      if (!isKnownProvider(targetProvider)) {
        console.log(chalk.red(`\n[Unknown provider: ${targetProvider}]`));
        console.log(chalk.dim(`Available: ${getAvailableProviderNames().join(', ')}\n`));
        return;
      }

      const snapshot = getProviderCapabilitySnapshot(targetProvider, targetModel);
      if (!snapshot) {
        console.log(chalk.red(`\n[Provider details unavailable: ${targetProvider}]`));
        console.log();
        return;
      }

      const commonScenarios = getProviderCommonPolicyScenarios(
        targetProvider,
        targetModel,
        currentConfig.reasoningMode,
      );

      console.log(chalk.bold('\nProvider Details:\n'));
      console.log(chalk.dim(`  Provider: ${chalk.cyan(snapshot.provider)}${snapshot.model ? ` / ${chalk.cyan(snapshot.model)}` : ''}`));
      console.log(chalk.dim(`  Source:   ${formatProviderSourceKind(snapshot.sourceKind)}`));
      console.log();

      console.log(chalk.bold('Capability Matrix:'));
      for (const line of formatProviderCapabilityDetailLines(snapshot)) {
        console.log(chalk.dim(`  - ${line}`));
      }
      console.log();

      if (commonScenarios.length > 0) {
        console.log(chalk.bold('Common Scenarios:'));
        for (const scenario of commonScenarios) {
          const color =
            scenario.decision.status === 'block'
              ? chalk.red
              : scenario.decision.status === 'warn'
                ? chalk.yellow
                : chalk.green;
          console.log(color(`  - ${scenario.label}: ${scenario.decision.status.toUpperCase()}`));
          console.log(chalk.dim(`    ${scenario.decision.summary}`));
        }
        console.log();
      }
    },
    detailedHelp: () => {
      console.log(chalk.cyan('\n/provider - Inspect Provider Semantics\n'));
      console.log(chalk.bold('Usage:'));
      console.log(chalk.dim('  /provider                      ') + 'Inspect the current provider/model');
      console.log(chalk.dim('  /provider <provider>           ') + 'Inspect a provider using its default model');
      console.log(chalk.dim('  /provider <provider>/<model>   ') + 'Inspect a specific provider/model pair');
      console.log();
      console.log(chalk.bold('Description:'));
      console.log(chalk.dim('  Shows the provider capability matrix and common 029 policy outcomes.'));
      console.log(chalk.dim('  Use this to understand why long-running, harness, or evidence-heavy flows may warn or block.'));
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
        const capability = getProviderReasoningCapability(currentConfig.provider, currentConfig.model);
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
        const capability = getProviderReasoningCapability(currentConfig.provider, currentConfig.model);
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
    name: 'agent-mode',
    aliases: ['am'],
    description: 'Show or set agent mode',
    usage: '/agent-mode [ama|sa|toggle]',
    handler: async (args, _context, callbacks, currentConfig) => {
      if (args.length === 0) {
        console.log(chalk.dim(`\nAgent mode: ${chalk.cyan(currentConfig.agentMode.toUpperCase())}`));
        console.log(chalk.dim('Usage: /agent-mode [ama|sa|toggle]\n'));
        return;
      }

      const raw = args[0]?.toLowerCase();
      const nextMode: KodaXAgentMode | undefined =
        raw === 'toggle'
          ? (currentConfig.agentMode === 'ama' ? 'sa' : 'ama')
          : raw === 'ama' || raw === 'sa'
            ? raw
            : undefined;

      if (!nextMode) {
        console.log(chalk.red(`\n[Invalid agent mode: ${args[0]}]`));
        console.log(chalk.dim('Usage: /agent-mode [ama|sa|toggle]\n'));
        return;
      }

      const persistence = applyAgentMode(nextMode, callbacks, currentConfig);
      printPersistedCommandStatus(`Agent mode: ${nextMode.toUpperCase()}`, persistence);
    },
    detailedHelp: () => {
      console.log(chalk.cyan('\n/agent-mode - Adaptive Multi-Agent Mode Control\n'));
      console.log(chalk.bold('Usage:'));
      console.log(chalk.dim('  /agent-mode            ') + 'Show current agent mode');
      console.log(chalk.dim('  /agent-mode ama        ') + 'Enable adaptive multi-agent mode');
      console.log(chalk.dim('  /agent-mode sa         ') + 'Force single-agent execution');
      console.log(chalk.dim('  /agent-mode toggle     ') + 'Switch between AMA and SA');
      console.log(chalk.dim('  /am                    ') + 'Alias for /agent-mode');
      console.log();
      console.log(chalk.bold('Description:'));
      console.log(chalk.dim('  AMA keeps adaptive multi-agent harness selection enabled.'));
      console.log(chalk.dim('  SA keeps routing and task artifacts, but forces single-agent execution to save tokens.'));
      console.log();
    },
  },
  {
    name: 'auto',
    aliases: ['a'],
    description: 'Quick switch to auto mode',
    handler: async (_args, _context, callbacks, currentConfig) => {
      currentConfig.permissionMode = 'auto';
      callbacks.setPermissionMode?.('auto');
      savePermissionModeUser('auto');
      console.log(chalk.cyan('\n[Switched to auto mode] (saved)'));
    },
    detailedHelp: () => {
      console.log(chalk.cyan('\n/auto - Quick Switch to Auto Mode\n'));
      console.log(chalk.bold('Usage:'));
      console.log(chalk.dim('  /auto              ') + 'Switch to auto mode');
      console.log(chalk.dim('  /a                 ') + 'Alias for /auto');
      console.log();
      console.log(chalk.bold('Description:'));
      console.log(chalk.dim('  Equivalent to /mode auto.'));
      console.log(chalk.dim('  Auto-mode classifier evaluates each non-Tier-1 tool call;'));
      console.log(chalk.dim('  benign actions auto-approve, risky ones escalate to user confirm.'));
      console.log();
      console.log(chalk.dim('  See also: /help mode, /auto-engine, /auto-denials'));
      console.log();
    },
  },
  {
    name: 'skills',
    description: '(Deprecated) Use /skill instead',
    usage: '/skill',
    handler: async (args, context) => {
      // Redirect to the /skill namespace command.
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

// Print help.
const COMMAND_CATEGORIES: Record<string, string[]> = {
  General: ['help', 'copy', 'exit', 'clear', 'compact', 'reload', 'extensions', 'status'],
  Permission: ['mode', 'auto'],
  Session: ['new', 'save', 'load', 'sessions', 'history', 'delete'],
  Settings: ['model', 'provider', 'thinking', 'reasoning', 'agent-mode', 'plan', 'repointel'],
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

const REPO_INTELLIGENCE_MODES: KodaXRepoIntelligenceMode[] = [
  'auto',
  'off',
  'oss',
  'premium-shared',
  'premium-native',
];

type ConfigPersistenceResult =
  | { saved: true }
  | { saved: false; error: Error };

function normalizeRepoIntelligenceMode(
  value: string | undefined,
): KodaXRepoIntelligenceMode | null {
  if (!value) {
    return null;
  }

  return REPO_INTELLIGENCE_MODES.includes(value as KodaXRepoIntelligenceMode)
    ? value as KodaXRepoIntelligenceMode
    : null;
}

function normalizeRuntimeOverride(value: string | undefined): string | null {
  const normalized = value?.trim();
  if (!normalized || normalized === 'default' || normalized === 'reset' || normalized === 'clear') {
    return null;
  }
  return normalized;
}

function resolveToggleFlag(
  value: string | undefined,
  currentValue: boolean,
): boolean | null {
  if (!value) {
    return null;
  }
  if (value === 'toggle') {
    return !currentValue;
  }
  if (value === 'on' || value === 'true' || value === '1') {
    return true;
  }
  if (value === 'off' || value === 'false' || value === '0') {
    return false;
  }
  return null;
}

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

function applyAgentMode(
  mode: KodaXAgentMode,
  callbacks: CommandCallbacks,
  currentConfig: CurrentConfig,
): ConfigPersistenceResult {
  const persistence = persistUserConfig({ agentMode: mode });

  if (callbacks.setAgentMode) {
    callbacks.setAgentMode(mode);
  } else {
    currentConfig.agentMode = mode;
  }

  return persistence;
}

function applyRepoIntelligenceRuntimeConfig(
  update: {
    mode?: KodaXRepoIntelligenceMode;
    endpoint?: string | null;
    bin?: string | null;
    trace?: boolean;
  },
  persistedConfig: {
    repoIntelligenceMode?: KodaXRepoIntelligenceMode;
    repointelEndpoint?: string | undefined;
    repointelBin?: string | undefined;
    repoIntelligenceTrace?: boolean;
  },
  callbacks: CommandCallbacks,
  currentConfig: CurrentConfig,
): ConfigPersistenceResult {
  const persistence = persistUserConfig(persistedConfig);

  if (callbacks.setRepoIntelligenceRuntime) {
    callbacks.setRepoIntelligenceRuntime(update);
  } else {
    if (update.mode !== undefined) {
      currentConfig.repoIntelligenceMode = update.mode;
    }
    if (update.endpoint !== undefined) {
      currentConfig.repointelEndpoint = update.endpoint ?? undefined;
    }
    if (update.bin !== undefined) {
      currentConfig.repointelBin = update.bin ?? undefined;
    }
    if (update.trace !== undefined) {
      currentConfig.repoIntelligenceTrace = update.trace;
    }
  }

  return persistence;
}

function formatRepoIntelligenceSummary(
  inspection: RepoIntelligenceRuntimeInspection,
): string {
  const requestedLabel = inspection.configuredMode === inspection.requestedMode
    ? inspection.configuredMode
    : `${inspection.configuredMode} -> ${inspection.requestedMode}`;
  const activeLabel = `${inspection.effectiveEngine}/${inspection.effectiveBridge}`;
  const transportLabel = inspection.transport ? `, ${inspection.transport}` : '';
  const fallbackLabel = inspection.fallbackToOss ? ', fallback=oss' : '';
  return `${requestedLabel} => ${activeLabel} (${inspection.status}${transportLabel}${fallbackLabel})`;
}

function printRepoIntelligenceInspection(
  inspection: RepoIntelligenceRuntimeInspection,
): void {
  console.log(chalk.bold('\nRepo Intelligence:\n'));
  console.log(chalk.dim(`  Configured:  ${chalk.cyan(inspection.configuredMode)}`));
  console.log(chalk.dim(`  Requested:   ${chalk.cyan(inspection.requestedMode)}`));
  console.log(chalk.dim(`  Active:      ${chalk.cyan(`${inspection.effectiveEngine}/${inspection.effectiveBridge}`)}`));
  console.log(chalk.dim(`  Status:      ${chalk.cyan(inspection.status)}${inspection.transport ? chalk.dim(` (${inspection.transport})`) : ''}`));
  console.log(chalk.dim(`  Trace:       ${chalk.cyan(inspection.traceEnabled ? 'on' : 'off')}`));
  console.log(chalk.dim(`  Endpoint:    ${inspection.endpoint}`));
  console.log(chalk.dim(`  Bin:         ${inspection.bin}`));
  if (inspection.clientBuildId) {
    console.log(chalk.dim(`  Client ID:   ${inspection.clientBuildId}`));
  }
  if (inspection.daemonBuildId) {
    console.log(chalk.dim(`  Daemon ID:   ${inspection.daemonBuildId}`));
  }
  if (inspection.daemonPid !== undefined) {
    console.log(chalk.dim(`  Daemon PID:  ${inspection.daemonPid}`));
  }
  if (inspection.daemonStartedAt) {
    console.log(chalk.dim(`  Daemon Up:   ${inspection.daemonStartedAt}`));
  }
  if (inspection.fallbackToOss) {
    console.log(chalk.yellow('  Fallback:    OSS baseline is currently active'));
  }
  if (inspection.error) {
    console.log(chalk.red(`  Error:       ${inspection.error}`));
  }
  for (const warning of inspection.warnings) {
    console.log(chalk.yellow(`  Warning:     ${warning}`));
  }
  console.log();
}

function printRepoIntelligenceWarmResult(
  result: Awaited<ReturnType<typeof warmRepoIntelligenceRuntime>>,
): void {
  if (result.warmed) {
    console.log(chalk.green('\n[repointel warmed successfully]'));
  } else {
    console.log(chalk.yellow('\n[repointel warm did not reach a ready daemon state]'));
  }
  if (result.warmLatencyMs !== undefined) {
    console.log(chalk.dim(`  Warm latency: ${result.warmLatencyMs} ms`));
  }
  printRepoIntelligenceInspection(result);
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

  for (const cmd of getActiveExtensionCommands()) {
    if (categorizedNames.has(cmd.name.toLowerCase())) {
      continue;
    }

    const commands = dynamicSections.get('Extensions') ?? [];
    commands.push({
      name: cmd.name,
      aliases: cmd.aliases,
      description: cmd.description,
    });
    dynamicSections.set('Extensions', commands);
  }

  for (const sectionTitle of ['Extensions', 'Skill Commands', 'Prompt Commands', 'Other Commands']) {
    printCommandSection(sectionTitle, dynamicSections.get(sectionTitle) ?? []);
  }

  console.log(chalk.dim('Special syntax:'));
  console.log(`  ${chalk.cyan('@path')}             Attach image to context`);
  console.log(`  ${chalk.cyan('!command')}         Execute shell command`);
  console.log();
  console.log(chalk.dim('Skills:'));
  console.log(`  ${chalk.cyan('/skill')}            List all available skills`);
  console.log(`  ${chalk.cyan('/skill:<name>')}     Invoke a skill (e.g., /skill:code-review)`);
  console.log();
}

// Print detailed help for a specific command.
function printDetailedHelp(commandName: string): void {
  // Lazy initialization.
  if (commandRegistry.size === 0) {
    initCommandRegistry();
  }

  const cmd = commandRegistry.get(commandName.toLowerCase());
  if (!cmd) {
    const extensionCommand = getActiveExtensionCommand(commandName);
    if (!extensionCommand) {
      console.log(chalk.yellow(`\n[Unknown command: /${commandName}. Type /help for available commands]`));
      return;
    }

    console.log(chalk.cyan(`\n/${extensionCommand.name}`));
    if (extensionCommand.aliases?.length) {
      console.log(chalk.dim(`Aliases: ${extensionCommand.aliases.join(', ')}`));
    }
    console.log(chalk.dim(`\n${extensionCommand.description}`));
    console.log(chalk.dim(`\nUsage: ${formatExtensionCommandUsage(extensionCommand)}`));
    console.log();
    return;
  }

  // If the command has a detailed help function, call it.
  if (cmd.detailedHelp) {
    cmd.detailedHelp();
  } else {
    // Otherwise show basic info.
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

// Print status.
async function printStatus(
  context: InteractiveContext,
  currentConfig: CurrentConfig,
  args: string[] = [],
): Promise<void> {
  const detailMode = args[0]?.toLowerCase();
  const tokens = context.contextTokenSnapshot?.currentTokens ?? estimateTokens(context.messages);
  const tokenSource = context.contextTokenSnapshot?.source ?? 'estimate';
  const capabilityProfile = getProviderCapabilityProfile(currentConfig.provider);
  const generalProviderPolicy = getProviderPolicyDecision(
    currentConfig.provider,
    currentConfig.model,
    currentConfig.reasoningMode,
  );
  console.log(chalk.bold('\nSession Status:\n'));
  console.log(chalk.dim(`  Provider:    ${chalk.cyan(currentConfig.provider)}${currentConfig.model ? ` / ${chalk.cyan(currentConfig.model)}` : ''}`));
  console.log(chalk.dim(`  Permission:  ${chalk.cyan(currentConfig.permissionMode)}`));
  console.log(chalk.dim(`  Reasoning:   ${chalk.cyan(currentConfig.reasoningMode)}`));
  console.log(chalk.dim(`  Agent Mode:  ${chalk.cyan(currentConfig.agentMode.toUpperCase())}`));
  if (capabilityProfile) {
    const capabilitySummary = describeProviderCapabilitySummary(capabilityProfile);
    const capabilityColor = capabilityProfile.transport === 'cli-bridge'
      ? chalk.yellow(capabilitySummary)
      : chalk.cyan(capabilitySummary);
    console.log(chalk.dim(`  Provider Cap:${' '} ${capabilityColor}`));
  }
  if (generalProviderPolicy && generalProviderPolicy.status !== 'allow') {
    const policyColor =
      generalProviderPolicy.status === 'block' ? chalk.red : chalk.yellow;
    console.log(chalk.dim(`  Provider Policy: ${policyColor(generalProviderPolicy.summary)}`));
  }
  console.log(chalk.dim(`  Session ID:  ${context.sessionId}`));
  console.log(chalk.dim(`  Messages:    ${context.messages.length}`));
  console.log(chalk.dim(`  Tokens:      ~${tokens} (${tokenSource})`));
  const repoInspection = await inspectRepoIntelligenceRuntime({
    mode: currentConfig.repoIntelligenceMode,
    trace: currentConfig.repoIntelligenceTrace,
  });
  console.log(chalk.dim(`  Repo Intel:  ${chalk.cyan(formatRepoIntelligenceSummary(repoInspection))}`));
  if (context.runtimeInfo?.workspaceRoot) {
    console.log(chalk.dim(`  Workspace:   ${chalk.cyan(formatWorkspaceTruth(context.runtimeInfo))}`));
  } else if (context.gitRoot) {
    console.log(chalk.dim(`  Workspace:   ${chalk.cyan(context.gitRoot)}`));
  }
  if (detailMode === 'workspace' || detailMode === 'worktree' || detailMode === 'runtime') {
    if (context.runtimeInfo?.canonicalRepoRoot) {
      console.log(chalk.dim(`  Canonical:   ${context.runtimeInfo.canonicalRepoRoot}`));
    }
    if (context.runtimeInfo?.executionCwd) {
      console.log(chalk.dim(`  Exec CWD:    ${context.runtimeInfo.executionCwd}`));
    }
    if (context.runtimeInfo?.workspaceKind) {
      console.log(chalk.dim(`  Kind:        ${context.runtimeInfo.workspaceKind}`));
    }
  }
  console.log(chalk.dim(`  Created:     ${context.createdAt}`));
  console.log(chalk.dim(`  Last Active: ${context.lastAccessed}`));
  console.log();
}

// Handle /skill namespace command (pi-mono style).
async function handleSkillNamespaceCommand(args: string[], context: InteractiveContext): Promise<void> {
  const registry = getSkillRegistry(context.gitRoot);

  // Ensure skills are discovered.
  if (registry.size === 0) {
    await initializeSkillRegistry(context.gitRoot);
  }

  // /skill without :name shows the list.
  printSkillsListPiMonoStyle(registry.listUserInvocable());
}

// Print skills list in pi-mono style.
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
    // Pad first, then color so ANSI escapes do not affect width calculation.
    const paddedName = skill.name.padEnd(maxNameLen);
    const hint = skill.argumentHint ? ` ${skill.argumentHint}` : '';
    // Show source for all skills except project level, which is the default.
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

// Command registry.
const commandRegistry = new CommandRegistry();

// Initialize command registry.
function initCommandRegistry(projectRoot?: string): void {
  if (commandRegistry.size > 0) {
    return;
  }

  // Register all commands: built-in plus discovered user/project commands.
  registerAllCommands(commandRegistry, projectRoot);
}

export function getCommandRegistry(projectRoot?: string): CommandRegistry {
  initCommandRegistry(projectRoot);
  return commandRegistry;
}

// Parse command.
function getActiveExtensionCommands(): ExtensionCommandDefinition[] {
  const runtime = getActiveExtensionRuntime();
  return runtime?.listCommands().filter((command) => command.metadata?.userInvocable !== false) ?? [];
}

function getActiveExtensionCommand(name: string): ExtensionCommandDefinition | undefined {
  const runtime = getActiveExtensionRuntime();
  const normalized = name.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  const command = runtime?.listCommands().find((candidate) =>
    candidate.name.trim().toLowerCase() === normalized
    || (candidate.aliases ?? []).some((alias) => alias.trim().toLowerCase() === normalized),
  );
  if (!command) {
    return undefined;
  }
  return command.metadata?.userInvocable === false ? undefined : command;
}

function formatExtensionCommandUsage(command: ExtensionCommandDefinition): string {
  return command.usage ?? `/${command.name}`;
}

function formatExtensionDiagnosticValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry)).join(', ');
  }
  if (value && typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}

function formatExtensionDiagnosticMetadata(
  metadata: Record<string, unknown> | undefined,
): string | undefined {
  if (!metadata) {
    return undefined;
  }

  const entries = Object.entries(metadata)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${formatExtensionDiagnosticValue(value)}`);

  return entries.length > 0 ? entries.join(' | ') : undefined;
}

function getExtensionRuntimeDiagnostics(runtime: NonNullable<ReturnType<typeof getActiveExtensionRuntime>>): ExtensionRuntimeDiagnostics {
  const diagnosticsGetter = (runtime as {
    getDiagnostics?: () => ExtensionRuntimeDiagnostics;
  }).getDiagnostics;

  if (typeof diagnosticsGetter === 'function') {
    return diagnosticsGetter.call(runtime);
  }

  const defaultsGetter = (runtime as {
    getDefaults?: () => {
      activeTools?: string[];
      modelSelection?: { provider?: string; model?: string };
      thinkingLevel?: KodaXReasoningMode;
    };
  }).getDefaults;
  const defaults = typeof defaultsGetter === 'function'
    ? defaultsGetter.call(runtime)
    : undefined;

  return {
    loadedExtensions: [],
    capabilityProviders: runtime.listCapabilityProviders().map((provider) => ({
      id: provider.id,
      kinds: [...provider.kinds],
      source: {
        kind: 'extension',
        id: `extension:${provider.id}`,
        label: provider.id,
        path: '(runtime)',
      },
    })),
    commands: runtime.listCommands().map((command) => ({
      name: command.name,
      aliases: command.aliases,
      description: command.description,
      usage: command.usage,
      metadata: command.metadata,
      source: {
        kind: 'extension',
        id: `extension-command:${command.name}`,
        label: command.name,
        path: '(runtime)',
      },
    })),
    tools: [],
    hooks: [],
    failures: [],
    defaults: {
      activeTools: defaults?.activeTools,
      modelSelection: defaults?.modelSelection ?? {},
      thinkingLevel: defaults?.thinkingLevel,
    },
  };
}

function toExtensionInvocationRequest(
  command: ExtensionCommandDefinition,
  result: ExtensionCommandResult,
): CommandInvocationRequest | undefined {
  if (!result.invocation) {
    return undefined;
  }

  return {
    prompt: result.invocation.prompt,
    source: 'extension',
    displayName: result.invocation.displayName ?? `/${command.name}`,
    disableModelInvocation: result.invocation.disableModelInvocation,
    allowedTools: result.invocation.allowedTools,
    context: result.invocation.context,
    model: result.invocation.model,
  };
}

async function executeExtensionCommand(
  command: ExtensionCommandDefinition,
  args: string[],
  context: InteractiveContext,
): Promise<CommandResult> {
  const runtime = getActiveExtensionRuntime();
  if (!runtime) {
    console.log(chalk.yellow(`\n[Extension runtime is not active for /${command.name}]`));
    return false;
  }

  const result = await command.handler(args, {
    sessionId: context.sessionId,
    gitRoot: context.gitRoot,
    workingDirectory: context.runtimeInfo?.executionCwd ?? context.gitRoot ?? process.cwd(),
    reloadExtensions: () => runtime.reloadExtensions(),
    getDiagnostics: () => getExtensionRuntimeDiagnostics(runtime),
    logger: {
      debug: (...parts) => console.debug(`[kodax:extension-command:${command.name}]`, ...parts),
      info: (...parts) => console.info(`[kodax:extension-command:${command.name}]`, ...parts),
      warn: (...parts) => console.warn(`[kodax:extension-command:${command.name}]`, ...parts),
      error: (...parts) => console.error(`[kodax:extension-command:${command.name}]`, ...parts),
    },
  });

  if (!result) {
    return true;
  }

  if (result.message) {
    console.log(result.message);
  }

  const invocation = toExtensionInvocationRequest(command, result);
  if (invocation) {
    return { invocation };
  }

  return true;
}

export function parseCommand(input: string): { command: string; args: string[]; skillInvocation?: { name: string } } | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return null;

  const parts = trimmed.slice(1).split(/\s+/);
  const rawCommand = parts[0]?.toLowerCase();
  let command = rawCommand;
  let args = parts.slice(1).filter(Boolean);

  if (!command) return null;

  // Check for /skill:name format (pi-mono style).
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

// Execute command.
export type CommandResult = boolean | {
  skillContent?: string;
  invocation?: CommandInvocationRequest;
};

export async function executeCommand(
  parsed: { command: string; args: string[]; skillInvocation?: { name: string } },
  context: InteractiveContext,
  callbacks: CommandCallbacks,
  currentConfig: CurrentConfig
): Promise<CommandResult> {
  // Lazy initialization.
  if (commandRegistry.size === 0) {
    initCommandRegistry(context.gitRoot);
  }

  // Handle /skill:name format (pi-mono style).
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
      // Handle project init prompt.
      if (result && typeof result === 'object') {
        return result;
      }
      return true;
    } catch (error) {
      console.log(chalk.red(`\n[Command failed: ${error instanceof Error ? error.message : String(error)}]`));
      return false;
    }
  }

  const extensionCommand = getActiveExtensionCommand(parsed.command);
  if (extensionCommand) {
    try {
      return await executeExtensionCommand(extensionCommand, parsed.args, context);
    } catch (error) {
      console.log(chalk.red(`\n[Extension command failed: ${error instanceof Error ? error.message : String(error)}]`));
      return false;
    }
  }

  console.log(chalk.yellow(`\n[Unknown command: /${parsed.command}. Type /help for available commands]`));
  return false;
}

// Execute skill command.
async function executeSkillCommand(
  parsed: { command: string; args: string[] },
  context: InteractiveContext
): Promise<CommandResult> {
  const registry = getSkillRegistry(context.gitRoot);
  const skillName = parsed.command;
  const skillArgs = parsed.args.join(' ');

  // Ensure skills are discovered.
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

    // Load the full skill and get its resolved content.
    const fullSkill = await registry.loadFull(skillName);

    // Create skill context for variable resolution.
    const skillContext: SkillContext = {
      workingDirectory: process.cwd(),
      projectRoot: context.gitRoot ?? undefined,
      sessionId: context.sessionId,
      environment: {},
    };

    // Expand the skill content for LLM injection.
    const expanded = await expandSkillForLLM(fullSkill, skillArgs, skillContext);

    // Show skill activation message.
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
        skillInvocation: {
          name: skillName,
          path: fullSkill.skillFilePath,
          description: fullSkill.description,
          arguments: skillArgs || undefined,
          allowedTools: fullSkill.allowedTools,
          context: fullSkill.context,
          agent: fullSkill.agent,
          argumentHint: fullSkill.argumentHint,
          model: fullSkill.model,
          hookEvents: fullSkill.hooks
            ? Object.entries(fullSkill.hooks)
                .filter(([, hooks]) => Array.isArray(hooks) && hooks.length > 0)
                .map(([eventName]) => eventName)
            : undefined,
          expandedContent: expanded.content,
        },
      },
    };
  } catch (error) {
    console.log(chalk.red(`\n[Error invoking skill: ${error instanceof Error ? error.message : String(error)}]`));
    return false;
  }
}
