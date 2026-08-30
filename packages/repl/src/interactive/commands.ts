/**
 * KodaX Interactive Command System
 */

import type * as readline from 'readline';
import * as fsSync from 'fs';
import path from 'path';
import chalk from 'chalk';
import { InteractiveContext, InteractiveMode } from './context.js';
import {
  createExtensionRuntime,
  dedupeExtensionPathsByEntrypoint,
  discoverDefaultExtensions,
  excludeExtensionPathsByEntrypoint,
  estimateTokens,
  type ExtensionRuntimeDiagnostics,
  type KodaXAgentMode,
  type KodaXRepoIntelligenceMode,
  type RepoIntelligenceRuntimeInspection,
  getActiveExtensionRuntime,
  inspectRepoIntelligenceRuntime,
  isKnownProvider,
  getAvailableProviderNames,
  resolveProvider,
  type ExtensionCommandDefinition,
  type ExtensionCommandResult,
  type KodaXReasoningMode,
  KodaXOptions,
  normalizeReasoningEffortValue,
  CODING_SUMMARY_PROMPT,
  CODING_UPDATE_SUMMARY_PROMPT,
  resolveKodaXManual,
} from '@kodax-ai/coding';
import type { AgentsFile } from '@kodax-ai/coding';
import {
  PermissionMode,
  PERMISSION_MODES,
  canonicalizePermissionMode,
  normalizePermissionMode,
} from '../permission/types.js';
import {
  describeProviderCapabilitySummary,
  formatProviderCapabilityDetailLines,
  formatProviderSourceKind,
  formatReasoningEffortStatusLabel,
  getProviderReasoningEffortOptions,
  formatReasoningCapabilityShort,
  getProviderCapabilitySnapshot,
  getProviderCapabilityProfile,
  getProviderCommonPolicyScenarios,
  getProviderPolicyDecision,
  getProviderAvailableModels,
  getProviderList,
  loadConfig,
  resolvePermissionModeEffort,
  saveConfig,
} from '../common/utils.js';
import {
  providerSetupRestartInstructions,
} from '../common/provider-setup.js';
import { initializeSetupConfiguration } from '../common/setup-config.js';
import { renderSetupGuide } from '../common/setup-guide.js';
import {
  runProviderSetupWizard,
  type ProviderSetupInteraction,
} from './provider-setup.js';
import { probeProviderReasoningEfforts } from '../common/capability-probe.js';
import { savePermissionModeUser } from '../common/permission-config.js';
import { nextAgentMode } from '../common/agent-mode.js';
import {
  clearCapabilityCache,
  compact,
  emitKodaXDiagnostic,
  getAgentConfigHome,
  getCachedRejectedEfforts,
} from '@kodax-ai/agent';
import type { CompactionConfig, KodaXDiagnosticLevel } from '@kodax-ai/agent';
import { loadCompactionConfig } from '../common/compaction-config.js';
import {
  getSkillRegistry,
  initializeSkillRegistry,
  type SkillMetadata,
} from '@kodax-ai/agent';
import {
  assertSingleKnownUserSkillReference,
  createUserSkillInvocation,
  MultipleUserSkillReferencesError,
} from './user-skill-invocation.js';
import { CommandRegistry } from '../commands/registry.js';
import { formatLearningStatus } from '../ui/view-models/learning-summary.js';
import { copyCommand } from '../commands/copy-command.js';
import { learnCommand } from '../commands/learn-command.js';
import { memoryCommand } from '../commands/memory-command.js';
import { goalCommand } from '../commands/goal-command.js';
import { workflowCommand } from '../commands/workflow-command.js';
import { newCommand } from '../commands/new-command.js';
import { recoverCommand } from '../commands/recover-command.js';
import { reviewCommand } from '../commands/review-command.js';
import { agentsCommand } from '../commands/agents-command.js';
import {
  printLearningPendingForFilter,
  resolveLearningCommandCwd,
} from '../commands/learning-inbox.js';
import { getActivePasteStore } from '../ui/utils/paste-store.js';
import { retrievePastedText } from '../ui/utils/paste-cache.js';
import {
  toCommandDefinition,
  type Command as RegisteredCommand,
  type CommandCallbacks,
  type CommandHandler as RegisteredCommandHandler,
  type CommandInvocationRequest,
  type CommandWorkflowInvocationRequest,
  type CurrentConfig,
  type RuntimeSurfaceStatus,
} from '../commands/types.js';
import { registerAllCommands } from '../commands/index.js';
import { formatWorkspaceTruth } from './workspace-runtime.js';

// Re-export types needed by downstream modules.
export type {
  CommandCallbacks,
  CurrentConfig,
  RuntimeSurfaceMode,
  RuntimeSurfaceStatus,
} from '../commands/types.js';

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

async function reloadSkillRegistry(gitRoot: string | undefined): Promise<number> {
  const registry = getSkillRegistry(gitRoot);
  await registry.reload();
  return registry.size;
}

interface ReloadExtensionRuntimeSummary {
  reloaded: number;
  loaded: number;
  failures: number;
}

interface ExtensionReloadConfig extends Readonly<Record<string, unknown>> {
  extensions?: string[];
}

function normalizeConfiguredExtensionPaths(configFile: string, configured: unknown): string[] {
  if (!Array.isArray(configured)) {
    return [];
  }

  const result: string[] = [];
  for (const value of configured) {
    if (typeof value !== 'string') {
      continue;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }
    result.push(path.isAbsolute(trimmed)
      ? trimmed
      : path.resolve(path.dirname(configFile), trimmed));
  }
  return result;
}

function loadExtensionReloadConfig(): ExtensionReloadConfig {
  const configFile = path.join(getAgentConfigHome(), 'config.json');
  try {
    if (!fsSync.existsSync(configFile)) {
      return {};
    }
    const parsed = JSON.parse(fsSync.readFileSync(configFile, 'utf-8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    const config = parsed as Record<string, unknown>;
    return {
      ...config,
      extensions: normalizeConfiguredExtensionPaths(configFile, config.extensions),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(chalk.yellow(`[extensions] Failed to read configured extensions: ${message}`));
    return {};
  }
}

async function discoverDefaultExtensionsForReload(): Promise<string[]> {
  try {
    return await discoverDefaultExtensions();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(chalk.yellow(`[extensions] Failed to discover default extensions: ${message}`));
    return [];
  }
}

async function reloadExtensionRuntimeFromDisk(): Promise<ReloadExtensionRuntimeSummary> {
  const config = loadExtensionReloadConfig();
  const configuredExtensions = await dedupeExtensionPathsByEntrypoint(config.extensions ?? []);
  const discoveredExtensions = await dedupeExtensionPathsByEntrypoint(
    await discoverDefaultExtensionsForReload(),
  );
  const discoveredOnlyExtensions = await excludeExtensionPathsByEntrypoint(
    discoveredExtensions,
    configuredExtensions,
  );
  const candidateExtensions = [
    ...discoveredOnlyExtensions,
    ...configuredExtensions,
  ];

  let extensionRuntime = getActiveExtensionRuntime();
  if (!extensionRuntime && candidateExtensions.length > 0) {
    extensionRuntime = createExtensionRuntime({ config }).activate();
  }
  if (!extensionRuntime) {
    return { reloaded: 0, loaded: 0, failures: 0 };
  }

  const before = getExtensionRuntimeDiagnostics(extensionRuntime);
  const beforeFailureCount = before.failures.length;
  await extensionRuntime.reloadExtensions({ continueOnError: true });

  const afterReload = getExtensionRuntimeDiagnostics(extensionRuntime);
  const reloadFailures = Math.max(0, afterReload.failures.length - beforeFailureCount);
  const loadedPaths = afterReload.loadedExtensions.map((extension) => extension.path);
  const newDiscovered = await excludeExtensionPathsByEntrypoint(
    discoveredOnlyExtensions,
    loadedPaths,
  );
  const newConfigured = await excludeExtensionPathsByEntrypoint(
    configuredExtensions,
    [...loadedPaths, ...newDiscovered],
  );

  await extensionRuntime.loadExtensions(newDiscovered, {
    continueOnError: true,
    loadSource: 'discovery',
    stage: 'reload',
  });
  await extensionRuntime.loadExtensions(newConfigured, {
    continueOnError: true,
    loadSource: 'config',
    stage: 'reload',
  });

  const afterLoad = getExtensionRuntimeDiagnostics(extensionRuntime);
  return {
    reloaded: Math.max(0, before.loadedExtensions.length - reloadFailures),
    loaded: Math.max(0, afterLoad.loadedExtensions.length - afterReload.loadedExtensions.length),
    failures: Math.max(0, afterLoad.failures.length - beforeFailureCount),
  };
}

function createManualCompactionConfig(
  config: CompactionConfig,
): CompactionConfig {
  return {
    ...config,
    enabled: true,
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
        const name = args[0]!;
        if (commandRegistry.size === 0) {
          initCommandRegistry();
        }
        const isKnownCommand =
          commandRegistry.has(name.toLowerCase()) || Boolean(getActiveExtensionCommand(name));
        if (isKnownCommand) {
          // Show detailed help for a specific command.
          printDetailedHelp(name, args.slice(1));
        } else {
          // FEATURE_218 — fall through to the KodaX self-knowledge manual for
          // product topics (/help providers, /help config, ...). Unknown topics
          // return the manual index, not an "unknown command" error.
          printManualTopic(name);
        }
      } else {
        printHelp();
      }
    },
    detailedHelp: () => {
      console.log(chalk.cyan('\n/help - Show Command Help\n'));
      console.log(chalk.bold('Usage:'));
      console.log(chalk.dim('  /help              ') + 'Show all available commands');
      console.log(chalk.dim('  /help <command>    ') + 'Show detailed help for a specific command');
      console.log(chalk.dim('  /<command> help    ') + 'Shortcut for command-specific help');
      console.log();
      console.log(chalk.bold('Examples:'));
      console.log(chalk.dim('  /help              ') + '# List all commands');
      console.log(chalk.dim('  /help mode         ') + '# Detailed help for /mode');
      console.log(chalk.dim('  /mode help         ') + '# Same detailed help shortcut');
      console.log();
    },
  },
  {
    name: 'setup',
    description: 'Initialize configuration and configure a provider',
    usage: '/setup [--custom|--help]',
    handler: async (args, _context, callbacks) => {
      const customOnly = args.length === 1 && args[0] === '--custom';
      if (args.length > 0 && !customOnly) {
        console.log(chalk.red('\n[Usage: /setup [--custom|--help]]'));
        return;
      }

      console.log(`\n${renderSetupGuide()}\n`);
      if (callbacks.prepareSetupSandbox) {
        const sandbox = await callbacks.prepareSetupSandbox();
        const label = sandbox.status === 'ready'
          ? chalk.green('active')
          : sandbox.status === 'cancelled'
            ? chalk.yellow('cancelled')
            : chalk.yellow('not active');
        console.log(`Sandbox: [${label}]`);
        for (const line of sandbox.lines) console.log(`  ${line}`);
        console.log();
      }
      const initialized = initializeSetupConfiguration({
        validateA2A: callbacks.validateSetupA2AConfig,
      });
      for (const file of initialized.files) {
        const marker = file.status === 'created'
          ? chalk.green('created')
          : file.status === 'invalid'
            ? chalk.red('invalid')
            : file.status === 'missing'
              ? chalk.yellow('missing')
              : chalk.dim('existing');
        console.log(`  [${marker}] ${file.path}`);
        if (file.diagnostic) console.log(`      ${chalk.red(file.diagnostic)}`);
      }
      console.log();
      if (initialized.files.some((file) => file.status === 'invalid')) {
        console.log(chalk.red(
          'Setup stopped: fix the invalid active configuration above, then run /setup again.',
        ));
        return;
      }

      const interaction: ProviderSetupInteraction = {
        choose: async (message, items) => {
          const labels = items.map((item) => item.label);
          const selected = await callbacks.ui.select(message, labels);
          return items.find((item) => item.label === selected)?.value;
        },
        text: (message, defaultValue) => callbacks.ui.input(message, defaultValue),
        confirm: (message) => callbacks.ui.confirm(message),
      };
      const result = await runProviderSetupWizard({ interaction, customOnly });
      if (result.status === 'cancelled') {
        console.log(chalk.dim('\nProvider setup cancelled. Configuration files remain initialized.\n'));
        return;
      }

      console.log(chalk.green(
        `\nProvider setup saved: ${result.selection.provider}/${result.selection.model}`,
      ));
      console.log(chalk.dim(`Config: ${result.selection.configPath}`));
      for (const line of providerSetupRestartInstructions({
        apiKeyEnv: result.selection.apiKeyEnv,
      })) {
        console.log(`  ${line}`);
      }
      console.log();
    },
    detailedHelp: () => {
      console.log(`\n${renderSetupGuide()}\n`);
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
        const manualConfig = createManualCompactionConfig(config);

        console.log(chalk.dim('\n[Compacting conversation...]'));

        // Start compacting indicator
        callbacks.startCompacting?.();

        try {
          // Manual compaction bypasses threshold comparison; automatic compaction remains on.
          const result = await compact(
            context.messages,
            manualConfig,
            provider,
            contextWindow,
            customInstructions,
            undefined,
            currentTokens,
            CODING_SUMMARY_PROMPT,
            CODING_UPDATE_SUMMARY_PROMPT,
            currentConfig.model,
            true,
            provider.getEffectiveMaxOutputTokens(currentConfig.model),
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
            baselineEstimatedTokens: estimateTokens(result.messages),
            source: context.contextTokenSnapshot?.source ?? 'estimate',
          };

          // Push the post-compact token count into the UI layer's live
          // counter. `contextUsage` in InkREPL reads `liveTokenCount`
          // before `context.contextTokenSnapshot`, so without this hook
          // the status bar would keep showing the stale pre-compact
          // value despite the snapshot above being up to date.
          callbacks.onCompactStats?.({
            tokensBefore: result.tokensBefore,
            tokensAfter: result.tokensAfter,
          });

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
      console.log(chalk.dim('  All eligible older messages are replaced atomically with a structured checkpoint.'));
      console.log(chalk.dim('  Automatic large compaction is always enabled; /compact bypasses its trigger comparison.'));
      console.log();
      console.log(chalk.bold('What it does:'));
      console.log(chalk.dim('  1. Protects 20% of the effective trigger as recent raw context'));
      console.log(chalk.dim('  2. Summarizes the complete eligible prefix in one atomic wave'));
      console.log(chalk.dim('  3. Tracks files that were read/modified in the conversation'));
      console.log(chalk.dim('  4. Replaces old messages with summary to save tokens'));
      console.log();
      console.log(chalk.bold('Configuration:'));
      console.log(chalk.dim('  Config file: ~/.kodax/config.json'));
      console.log(chalk.dim('  Settings:'));
      console.log(chalk.dim('    - compaction.triggerPercent: 15-90, default 75'));
      console.log(chalk.dim('    - compaction.triggerTokens: Optional absolute token threshold; 0 disables this limiter'));
      console.log(chalk.dim('    - The smaller percentage/absolute threshold wins'));
      console.log(chalk.dim('    - compaction.enabled: deprecated and ignored; automatic compaction stays on'));
      console.log(chalk.dim('    - compaction.contextWindow: Optional token-window override'));
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
    description: 'Reload project rules, skills, and active extensions',
    handler: async (_args, context, callbacks, _currentConfig) => {
      console.log(chalk.cyan('\nReloading project rule files, skills, and runtime extensions...\n'));

      try {
        const files = await callbacks.reloadAgentsFiles?.() ?? [];
        const result = summarizeAgentsFiles(files);
        const skillCount = await reloadSkillRegistry(context.gitRoot);
        const extensionSummary = await reloadExtensionRuntimeFromDisk();
        const extensionCount = extensionSummary.reloaded + extensionSummary.loaded;
        const reloadFailures = extensionSummary.failures;

        if (files.length === 0 && skillCount === 0 && extensionCount === 0 && reloadFailures === 0) {
          console.log(chalk.yellow('No project rule files, skills, or active extensions found.\n'));
          console.log(chalk.dim('  Create AGENTS.md or CLAUDE.md in your project, add skills, or load extensions with --extension.'));
          console.log();
          return;
        }

        console.log(chalk.green('Reloaded successfully:\n'));
        if (result.global > 0) {
          console.log(chalk.dim(`  - Global: ${result.global} file(s)`));
        }
        if (result.directory > 0) {
          console.log(chalk.dim(`  - Directory: ${result.directory} file(s)`));
        }
        if (result.project > 0) {
          console.log(chalk.dim(`  - Project: ${result.project} file(s)`));
        }
        if (extensionSummary.reloaded > 0) {
          console.log(chalk.dim(`  - Extensions reloaded: ${extensionSummary.reloaded} module(s)`));
        }
        if (extensionSummary.loaded > 0) {
          console.log(chalk.dim(`  - Extensions loaded: ${extensionSummary.loaded} module(s)`));
        }
        if (skillCount > 0) {
          console.log(chalk.dim(`  - Skills: ${skillCount} skill(s)`));
        }
        if (reloadFailures > 0) {
          console.log(chalk.yellow(`  - Failures: ${reloadFailures} recorded (run /extensions for details)`));
        }
        console.log(chalk.dim('  Updated rules, skills, and extensions will apply to subsequent requests in this session.'));
        console.log();
        return;
      } catch (error) {
        console.log(chalk.red('Failed to reload.\n'));
        console.log(chalk.dim(`  Error: ${error instanceof Error ? error.message : String(error)}`));
        console.log();
      }
    },
    detailedHelp: () => {
      console.log(chalk.cyan('\n/reload - Reload Project Context\n'));
      console.log(chalk.bold('Usage:'));
      console.log(chalk.dim('  /reload            ') + 'Reload project rule files, skills, and active extensions');
      console.log();
      console.log(chalk.bold('Description:'));
      console.log('  Reloads project-level context rules from AGENTS.md, CLAUDE.md, and .kodax/AGENTS.md files.');
      console.log('  Reloads skills from .kodax/skills/, ~/.kodax/skills/, ~/.agents/skills/, plugins, and builtins.');
      console.log('  Rediscovers default/configured extensions, creates a runtime if needed, and hot-reloads loaded extensions.');
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
    name: 'sandbox',
    description: 'Inspect the optional ASRT sandbox backend',
    usage: '/sandbox',
    handler: async (args, _context, callbacks) => {
      if (args.length > 0) {
        console.log(chalk.red('\n[Usage: /sandbox]'));
        return;
      }
      if (!callbacks.inspectSandbox) {
        console.log(chalk.dim(
          '\nSandbox diagnostics are unavailable because this host did not provide them.\n',
        ));
        return;
      }

      const report = await callbacks.inspectSandbox();
      const status = report.ready ? chalk.green('ready') : chalk.yellow('unavailable');
      console.log(chalk.bold('\nSandbox\n'));
      console.log(chalk.dim(`  Status:      ${status}`));
      console.log(chalk.dim(`  Platform:    ${report.platform}`));
      console.log(chalk.dim(`  Backend:     ${report.backend}`));
      console.log(chalk.dim(`  ASRT:        ${report.version}`));
      for (const diagnostic of report.diagnostics) {
        console.log(chalk.dim(`  Diagnostic:  ${diagnostic}`));
      }
      if (!report.ready) {
        for (const guidance of report.guidance) {
          console.log(chalk.dim(`  Guidance:    ${guidance}`));
        }
      }
      console.log();
    },
    detailedHelp: () => {
      console.log(chalk.cyan('\n/sandbox - Inspect Sandbox Readiness\n'));
      console.log(chalk.bold('Usage:'));
      console.log(chalk.dim('  /sandbox    ') + 'Refresh and display ASRT readiness');
      console.log();
      console.log(chalk.dim(
        'This command is read-only. It never activates ASRT or requests elevation.',
      ));
      console.log(chalk.dim(
        'Use `kodax sandbox setup` explicitly when activation is required.',
      ));
      console.log();
    },
  },
  {
    name: 'status',
    aliases: ['info', 'ctx'],
    description: 'Show current session status',
    handler: async (args, context, callbacks, currentConfig) => {
      await printStatus(context, currentConfig, args, callbacks);
    },
    detailedHelp: () => {
      console.log(chalk.cyan('\n/status - Show Session Status\n'));
      console.log(chalk.bold('Usage:'));
      console.log(chalk.dim('  /status            ') + 'Display current session information');
      console.log(chalk.dim('  /status workspace  ') + 'Show deeper workspace/runtime details');
      console.log(chalk.dim('  /status runtime    ') + 'Show SDK runtime mode, identity, and queue counters');
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
        console.log(chalk.dim(
          '  Add servers to ~/.kodax/integrations/mcp.json or run `kodax mcp add`.\n',
        ));
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
      console.log(chalk.dim('  Config: ~/.kodax/integrations/mcp.json'));
      console.log(chalk.dim('  Template: ~/.kodax/integrations/mcp.example.jsonc'));
      console.log();
    },
  },
  {
    name: 'repo-intel',
    description: 'Inspect built-in repo intelligence',
    usage: '/repo-intel [status|mode|trace]',
    handler: async (args, context, callbacks, currentConfig) => {
      const subcommand = args[0]?.toLowerCase() ?? 'status';

      if (subcommand === 'status') {
        const inspection = await inspectRepoIntelligenceRuntime({
          mode: currentConfig.repoIntelligenceMode,
          trace: currentConfig.repoIntelligenceTrace,
          probe: true,
          workspaceRoot: getRepoIntelInspectionWorkspaceRoot(context),
        });
        printRepoIntelStatus(inspection);
        return;
      }

      if (subcommand === 'mode') {
        if (args.length === 1) {
          console.log(chalk.dim(`\nCurrent repo-intelligence mode: ${chalk.cyan(formatRepoIntelPublicMode(currentConfig.repoIntelligenceMode ?? 'auto'))}`));
          console.log(chalk.dim('Usage: /repo-intel mode [auto|full|light|off]\n'));
          return;
        }

        const mode = normalizeRepoIntelPublicMode(args[1]);
        if (!mode) {
          console.log(chalk.red(`\n[Invalid repo-intelligence mode: ${args[1]}]`));
          console.log(chalk.dim('Usage: /repo-intel mode [auto|full|light|off]\n'));
          return;
        }

        const persistence = applyRepoIntelligenceRuntimeConfig(
          { mode },
          { repoIntelligenceMode: mode },
          callbacks,
          currentConfig,
        );
        printPersistedCommandStatus(`Repo intelligence mode: ${formatRepoIntelPublicMode(mode)}`, persistence);
        return;
      }

      if (subcommand === 'trace') {
        const raw = args[1]?.toLowerCase();
        if (!raw) {
          console.log(chalk.dim(`\nCurrent repo-intelligence trace: ${chalk.cyan(currentConfig.repoIntelligenceTrace ? 'on' : 'off')}`));
          console.log(chalk.dim('Usage: /repo-intel trace [on|off|toggle]\n'));
          return;
        }

        const nextValue = resolveToggleFlag(raw, currentConfig.repoIntelligenceTrace ?? false);
        if (nextValue === null) {
          console.log(chalk.red(`\n[Invalid trace value: ${args[1]}]`));
          console.log(chalk.dim('Usage: /repo-intel trace [on|off|toggle]\n'));
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

      if (subcommand === 'refresh') {
        console.log(chalk.yellow('\n[Repo intelligence refresh is automatic in this build]'));
        console.log(chalk.dim('Use /repo-intel status to inspect the current engine state.\n'));
        return;
      }

      console.log(chalk.red(`\n[Unknown /repo-intel subcommand: ${args[0]}]`));
      console.log(chalk.dim('Usage: /repo-intel [status|mode|trace]\n'));
    },
    detailedHelp: () => {
      console.log(chalk.cyan('\n/repo-intel - Built-in Repo Intelligence\n'));
      console.log(chalk.bold('Usage:'));
      console.log(chalk.dim('  /repo-intel                            ') + 'Show built-in repo-intelligence status');
      console.log(chalk.dim('  /repo-intel status                     ') + 'Show built-in engine status without probing an external daemon');
      console.log(chalk.dim('  /repo-intel mode auto                  ') + 'Let KodaX pick the best repo-intelligence engine');
      console.log(chalk.dim('  /repo-intel mode full                  ') + 'Prefer the full repo-intelligence engine');
      console.log(chalk.dim('  /repo-intel mode light                 ') + 'Use the light repo-intelligence engine');
      console.log(chalk.dim('  /repo-intel mode off                   ') + 'Disable repo-intelligence injection');
      console.log(chalk.dim('  /repo-intel trace on|off|toggle        ') + 'Toggle repo-intelligence trace output');
      console.log();
      console.log(chalk.bold('Notes:'));
      console.log(chalk.dim('  - /status now includes a compact repo-intelligence summary.'));
      console.log(chalk.dim('  - External repointel endpoint/bin controls are deprecated for built-in KodaX.'));
      console.log();
    },
  },
  {
    name: 'repointel',
    aliases: ['ri'],
    description: 'Deprecated alias for /repo-intel status',
    usage: '/repointel [status]',
    userInvocable: false,
    handler: async (args, context, _callbacks, currentConfig) => {
      const subcommand = args[0]?.toLowerCase() ?? 'status';
      console.log(chalk.yellow('\n[/repointel is deprecated; use /repo-intel status]\n'));

      if (subcommand === 'status') {
        const inspection = await inspectRepoIntelligenceRuntime({
          mode: currentConfig.repoIntelligenceMode,
          trace: currentConfig.repoIntelligenceTrace,
          probe: true,
          workspaceRoot: getRepoIntelInspectionWorkspaceRoot(context),
        });
        printRepoIntelStatus(inspection);
        return;
      }

      if (subcommand === 'mode') {
        console.log(chalk.dim('Use /repo-intel mode [auto|full|light|off] to change repo-intelligence mode.\n'));
        return;
      }

      if (subcommand === 'trace') {
        console.log(chalk.dim('Use /repo-intel trace [on|off|toggle] to change repo-intelligence trace output.\n'));
        return;
      }

      if (subcommand === 'warm' || subcommand === 'endpoint' || subcommand === 'bin') {
        console.log(chalk.dim('Repo intelligence is built into KodaX; external daemon/bin controls are no longer a normal REPL command surface.'));
        console.log(chalk.dim('Use /repo-intel status to inspect the active engine.\n'));
        return;
      }

      console.log(chalk.dim('Usage: /repointel [status]\n'));
    },
    detailedHelp: () => {
      console.log(chalk.cyan('\n/repointel - Deprecated\n'));
      console.log(chalk.dim('Use /repo-intel status for built-in repo-intelligence diagnostics.'));
      console.log(chalk.dim('External endpoint/bin/warm controls are deprecated for KodaX.'));
      console.log();
    },
  },
  {
    name: 'fallback',
    description: 'Configure the cross-provider fallback chain for child tasks',
    usage: '/fallback [status | <p1,p2,...> | off]',
    handler: async (args, _context, _callbacks, _currentConfig) => {
      // Read the live env (set at startup from config, or updated by this
      // command) so status always reflects the running session.
      const current = (process.env.KODAX_FALLBACK_PROVIDERS ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
      const sub = args[0]?.toLowerCase();

      if (!sub || sub === 'status') {
        if (current.length === 0) {
          console.log(chalk.dim('\nChild-task provider fallback: ') + chalk.yellow('off') + chalk.dim(' (no chain configured)'));
        } else {
          console.log(chalk.dim('\nChild-task provider fallback: ') + chalk.green('on'));
          console.log(chalk.dim('  Order: ') + chalk.cyan(current.join(' → ')));
        }
        console.log(chalk.dim('\n  When a child\'s primary provider is exhausted/down, KodaX re-runs it'));
        console.log(chalk.dim('  on the next provider in this list. Set: /fallback ark-coding,kimi-code\n'));
        return;
      }

      if (sub === 'off' || sub === 'clear' || sub === 'none') {
        saveConfig({ fallbackProviders: undefined });
        delete process.env.KODAX_FALLBACK_PROVIDERS;
        console.log(chalk.green('\n✓ ') + chalk.dim('Child-task provider fallback disabled.\n'));
        return;
      }

      // Treat the rest as the chain — accept comma- or space-separated ids.
      const chain = args
        .join(',')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
      if (chain.length === 0) {
        console.log(chalk.red('\n[/fallback: no provider ids given]'));
        console.log(chalk.dim('Usage: /fallback ark-coding,kimi-code   (or /fallback off)\n'));
        return;
      }

      saveConfig({ fallbackProviders: chain });
      // Live override (the startup env mirror is env-wins, so set it directly).
      process.env.KODAX_FALLBACK_PROVIDERS = chain.join(',');
      console.log(chalk.green('\n✓ ') + chalk.dim('Child-task fallback order: ') + chalk.cyan(chain.join(' → ')));
      console.log(chalk.dim('  Provider ids must match your configured providers (see /status or kodax doctor).\n'));
    },
  },
  {
    name: 'mode',
    description: 'Show or switch permission mode (plan/accept-edits/auto/full-access)',
    usage: '/mode [plan|accept-edits|auto|full-access]',
    handler: async (args, _context, callbacks, currentConfig) => {
      if (args.length === 0) {
        const m = normalizePermissionMode(currentConfig.permissionMode, 'accept-edits') ?? 'accept-edits';
        console.log(chalk.dim(`\nCurrent mode: ${chalk.cyan(m)}`));
        console.log(chalk.dim('Usage: /mode [plan|accept-edits|auto|full-access]'));
        return;
      }
      const requestedMode = args[0] as PermissionMode;
      if (PERMISSION_MODES.includes(requestedMode)) {
        const newMode = canonicalizePermissionMode(requestedMode);
        if (callbacks.setPermissionMode) {
          await callbacks.setPermissionMode(newMode);
        } else {
          currentConfig.permissionMode = newMode;
        }
        savePermissionModeUser(newMode);
        console.log(chalk.cyan(`\n[Switched to ${newMode} mode] (saved)`));
      } else {
        console.log(chalk.red(`\n[Unknown mode: ${args[0]}. Use: plan | accept-edits | auto | full-access]`));
      }
    },
    detailedHelp: () => {
      console.log(chalk.cyan('\n/mode - Switch Permission Mode\n'));
      console.log(chalk.bold('Usage:'));
      console.log(chalk.dim('  /mode                        ') + 'Show current permission mode');
      console.log(chalk.dim('  /mode plan                   ') + 'Read-only: blocks all modifications');
      console.log(chalk.dim('  /mode accept-edits           ') + 'File edits auto, bash requires confirmation');
      console.log(chalk.dim('  /mode auto                   ') + 'Sandbox first; LLM review only at the host boundary');
      console.log(chalk.dim('  /mode full-access            ') + 'Run directly on the host without sandbox or Auto review');
      console.log();
      console.log(chalk.bold('Permission Levels:'));
      console.log(chalk.yellow('  plan          ') + chalk.dim('- Read-only planning, no file/command modifications'));
      console.log(chalk.green('  accept-edits  ') + chalk.dim('- File edits auto-approved, bash still requires confirmation'));
      console.log(chalk.green('  auto          ') + chalk.dim('- Sandbox first; LLM reviews host-boundary fallbacks'));
      console.log(chalk.red('  full-access   ') + chalk.dim('- Unrestricted host execution'));
      console.log();
      console.log(chalk.bold('Notes:'));
      console.log(chalk.dim('  - Mode is saved to ~/.kodax/config.json (user-level)'));
      console.log();
    },
  },
  {
    // FEATURE_092 phase 2b.8: dump tracker + breaker stats. Useful for the
    // pilot to verify fallback paths manually + for debugging classifier health.
    name: 'auto-denials',
    description: 'Show Auto reviewer denial tracker + circuit breaker stats',
    usage: '/auto-denials',
    handler: async (_args, _context, callbacks) => {
      const stats = await callbacks.getAutoModeStats?.();
      if (!stats) {
        console.log(chalk.yellow('\n[auto-denials] not in auto mode — switch via /mode auto first'));
        return;
      }
      console.log(chalk.cyan('\n[auto-mode reviewer stats]'));
      console.log(chalk.dim(`  reviewer health:      ${stats.classifierHealth}`));
      console.log(chalk.dim('  Denial tracker:'));
      console.log(chalk.dim(`    consecutive blocks: ${stats.denials.consecutive} / 3`));
      console.log(chalk.dim(`    cumulative blocks:  ${stats.denials.cumulative} / 20`));
      console.log(chalk.dim('  Circuit breaker:'));
      console.log(chalk.dim(`    errors in window:   ${stats.breaker.timestamps.filter((t) => t >= Date.now() - 10 * 60 * 1000).length} / 5 (10 min)`));
      console.log();
      if (stats.classifierHealth === 'degraded') {
        console.log(chalk.yellow(
          '  ↪ reviewer calls are temporarily skipped; host-boundary operations fail closed with safer-route guidance.',
        ));
      }
      console.log();
    },
    detailedHelp: () => {
      console.log(chalk.cyan('\n/auto-denials - Auto Reviewer Diagnostic Dump\n'));
      console.log(chalk.bold('Usage:'));
      console.log(chalk.dim('  /auto-denials                ') + 'Print reviewer tracker + breaker counters');
      console.log();
      console.log(chalk.bold('Diagnostics and fail-closed behavior:'));
      console.log(chalk.dim('  - Block counters are diagnostic only.'));
      console.log(chalk.dim('  - 5 errors in 10 min → skip the reviewer temporarily and block host-boundary operations.'));
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

      // `/provider forget-capability [<provider>[/<model>]]` — clear the learned
      // capability cache so an effort that was (mis)recorded as rejected is
      // offered again. With no target, clears the whole cache.
      if (input === 'forget-capability') {
        const target = (args[1] ?? '').trim();
        if (!target) {
          clearCapabilityCache();
          console.log(chalk.dim('\n[Cleared all learned capability overrides]\n'));
          return;
        }
        const slash = target.indexOf('/');
        const fp = slash === -1 ? target : target.slice(0, slash);
        const fm = slash === -1 ? undefined : target.slice(slash + 1) || undefined;
        clearCapabilityCache(fp, fm);
        console.log(chalk.dim(`\n[Cleared learned capability overrides for ${fp}${fm ? `/${fm}` : ''}]\n`));
        return;
      }

      // `/provider probe` — proactively send a minimal request per candidate
      // effort and record the ones the active model rejects. Reuses the same
      // signal as passive learning (source: probed). Real requests, a few
      // tokens each; explicit and user-invoked only.
      if (input === 'probe') {
        const candidates = getProviderReasoningEffortOptions(
          currentConfig.provider,
          currentConfig.model,
        ).filter((e) => e !== 'auto' && e !== 'off');
        const label = `${currentConfig.provider}/${currentConfig.model ?? '(default)'}`;
        console.log(chalk.dim(`\n[Probing ${label} — ${candidates.length} efforts, minimal requests…]`));
        try {
          const results = await probeProviderReasoningEfforts({
            provider: currentConfig.provider,
            model: currentConfig.model,
            efforts: candidates,
            resolve: resolveProvider,
            now: () => new Date().toISOString(),
          });
          for (const r of results) {
            const mark = r.status === 'accepted'
              ? chalk.green('✓')
              : r.status === 'rejected'
                ? chalk.red('✗')
                : chalk.yellow('!');
            console.log(chalk.dim(`  ${mark} ${r.effort}${r.error ? ` — ${r.error}` : ''}`));
          }
          console.log(chalk.dim('  (rejections recorded; undo with /provider forget-capability)\n'));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.log(chalk.red(`\n[Probe failed: ${message}]\n`));
        }
        return;
      }

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
      console.log(chalk.dim(`  - Session effort: ${formatReasoningEffortDisplay(currentConfig.effort)}`));
      const learnedRejections = getCachedRejectedEfforts(targetProvider, targetModel);
      if (learnedRejections.length > 0) {
        console.log(chalk.dim(`  - Learned unsupported: ${learnedRejections.join(', ')} (clear with /provider forget-capability)`));
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
      console.log(chalk.dim('  /provider probe                ') + 'Send minimal requests to learn which efforts the model rejects');
      console.log(chalk.dim('  /provider forget-capability [<provider>[/<model>]]'));
      console.log(chalk.dim('                                 ') + 'Clear learned (observed/probed) effort rejections; re-offer those rungs');
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
    description: 'Show or set native reasoning effort',
    usage: '/thinking [none|auto|low|medium|high|xhigh|max]',
    handler: async (args, _context, callbacks, currentConfig) => {
      await handleReasoningEffortCommand('thinking', args, callbacks, currentConfig);
    },
    detailedHelp: () => {
      console.log(chalk.cyan('\n/thinking - Set Native Reasoning Effort\n'));
      console.log(chalk.bold('Usage:'));
      printReasoningEffortHelp('thinking');
      console.log(chalk.dim('  /t                 ') + 'Alias for /thinking');
      console.log();
    },
  },
  {
    name: 'reasoning',
    aliases: ['reason'],
    description: 'Show or set native reasoning effort',
    usage: '/reasoning [none|auto|low|medium|high|xhigh|max]',
    handler: async (args, _context, callbacks, currentConfig) => {
      await handleReasoningEffortCommand('reasoning', args, callbacks, currentConfig);
    },
    detailedHelp: () => {
      console.log(chalk.cyan('\n/reasoning - Set Native Reasoning Effort\n'));
      console.log(chalk.bold('Usage:'));
      printReasoningEffortHelp('reasoning');
      console.log(chalk.dim('  /reason                ') + 'Alias for /reasoning');
      console.log();
    },
  },
  {
    name: 'effort',
    description: 'Show or set native reasoning effort',
    usage: '/effort [level]',
    handler: async (args, _context, callbacks, currentConfig) => {
      await handleReasoningEffortCommand('effort', args, callbacks, currentConfig);
    },
    detailedHelp: () => {
      console.log(chalk.cyan('\n/effort - Set Native Reasoning Effort\n'));
      console.log(chalk.bold('Usage:'));
      console.log(chalk.dim('  /effort             ') + 'Show current native reasoning effort');
      console.log(chalk.dim('  /effort auto        ') + 'Clear the explicit effort override');
      console.log(chalk.dim('  /effort off         ') + 'Disable reasoning effort');
      console.log(chalk.dim('  /effort low         ') + 'Use low native reasoning effort');
      console.log(chalk.dim('  /effort medium      ') + 'Use medium native reasoning effort');
      console.log(chalk.dim('  /effort high        ') + 'Use high native reasoning effort');
      console.log(chalk.dim('  /effort xhigh       ') + 'Use extra-high effort when the model supports it');
      console.log(chalk.dim('  /effort max         ') + 'Use max effort when the model supports it');
      console.log(chalk.dim('  /effort none        ') + 'Legacy alias for /effort off');
      console.log(chalk.dim('\nRun /effort to see the active model\'s supported values.'));
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
      if (raw === 'amaw' || raw === 'ama-workflow') {
        console.log(chalk.yellow('\n[AMAW was retired in v0.7.72. Use AMA; Workflow execution now requires an explicit /workflow request.]'));
        return;
      }
      const nextMode: KodaXAgentMode | undefined =
        raw === 'toggle'
          ? nextAgentMode(currentConfig.agentMode)
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
      console.log(chalk.dim('  /agent-mode ama        ') + 'Adaptive multi-agent mode; workflows require an explicit /workflow request');
      console.log(chalk.dim('  /agent-mode sa         ') + 'Force single-agent execution');
      console.log(chalk.dim('  /agent-mode toggle     ') + 'Cycle AMA -> SA');
      console.log(chalk.dim('  /am                    ') + 'Alias for /agent-mode');
      console.log();
      console.log(chalk.bold('Description:'));
      console.log(chalk.dim('  AMA runs the adaptive multi-agent harness. Sub-agents are available when parallel'));
      console.log(chalk.dim('      work materially improves speed or quality. Workflows only run when explicitly'));
      console.log(chalk.dim('      requested with /workflow or by naming a Workflow.'));
      console.log(chalk.dim('  SA forces a single solo agent — no sub-agents and no workflows — to save tokens.'));
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
      console.log(chalk.dim('  Auto runs sandboxed calls first, then uses the LLM reviewer at the host boundary;'));
      console.log(chalk.dim('  ordinary actions continue silently; reviewer concerns block the exact attempt with recovery guidance.'));
      console.log();
      console.log(chalk.dim('  See also: /help mode, /auto-denials'));
      console.log();
    },
  },
  {
    name: 'skill',
    description: 'Skill namespace - list, invoke, or review skill learning',
    usage: '/skill[:name] [pending|args]',
    handler: async (args, context) => {
      if ((args[0] ?? '').toLowerCase() === 'pending') {
        await printLearningPendingForFilter(resolveLearningCommandCwd(context), 'skill');
        return;
      }
      // When /skill:name is used, parseCommand extracts the name and executeCommand
      // calls executeSkillCommand directly. Plain /skill lists the namespace.
      await handleSkillNamespaceCommand(args, context);
    },
    detailedHelp: () => {
      console.log(chalk.cyan('\n/skill - Skill Namespace\n'));
      console.log(chalk.bold('Usage:'));
      console.log(chalk.dim('  /skill               ') + 'List all available skills');
      console.log(chalk.dim('  /<skill-name> [args] ') + 'Invoke a skill when no command uses that name');
      console.log(chalk.dim('  /skill:<name> [args] ') + 'Invoke a skill with the compatibility form');
      console.log(chalk.dim('  /skill reload        ') + 'Reload skills from disk');
      console.log(chalk.dim('  /skill pending       ') + 'List pending method-guide learning suggestions');
      console.log();
      console.log(chalk.bold('Description:'));
      console.log(chalk.dim('  Direct slash skill invocation follows the Claude Code style.'));
      console.log(chalk.dim('  Built-in and extension commands keep priority when names overlap.'));
      console.log(chalk.dim('  The /skill:<name> form remains supported for compatibility.'));
      console.log(chalk.dim('  Skills can also be triggered by natural language - just ask!'));
      console.log();
      console.log(chalk.bold('Examples:'));
      console.log(chalk.dim('  /skill                    ') + '# List all skills');
      console.log(chalk.dim('  /skill reload             ') + '# Reload skills after editing ~/.kodax/skills');
      console.log(chalk.dim('  /code-review src/         ') + '# Invoke code-review skill');
      console.log(chalk.dim('  /skill:code-review src/   ') + '# Compatibility form');
      console.log(chalk.dim('  /skill:tdd auth           ') + '# Invoke TDD skill');
      console.log();
    },
  },
  {
    name: 'verifier-log',
    description: 'Toggle Sidecar Verifier log line (off by default)',
    usage: '/verifier-log [on|off]',
    argumentHint: 'on | off',
    handler: async (args) => {
      const raw = args[0]?.toLowerCase();
      const envOn = process.env.KODAX_VERIFIER_LOG === '1';

      if (!raw) {
        const configOn = loadConfig().verifierLog === true;
        const effective = envOn ? 'on' : 'off';
        // Show config-vs-env divergence without asserting precedence —
        // it depends on whether env came from shell (overrides config)
        // or from `applyVerifierRuntimeEnv` (config-derived).
        const persistedSuffix =
          configOn === envOn
            ? ''
            : ` (env=${envOn ? 'on' : 'off'}, config=${configOn ? 'on' : 'off'})`;
        console.log(
          chalk.dim(`\nSidecar Verifier log: ${chalk.cyan(effective)}${persistedSuffix}`),
        );
        console.log(
          chalk.dim(
            '  When on, a one-line summary persists per verifier call:\n' +
            '  `[Sidecar Verifier] {verdict} · {provider}/{model} · {ms}ms · {trace}`',
          ),
        );
        console.log(chalk.dim('Usage: /verifier-log [on|off]\n'));
        return;
      }

      let nextValue: boolean;
      if (raw === 'on' || raw === 'true' || raw === '1') {
        nextValue = true;
      } else if (raw === 'off' || raw === 'false' || raw === '0') {
        nextValue = false;
      } else {
        console.log(chalk.red(`\n[Invalid value: ${args[0]}]`));
        console.log(chalk.dim('Usage: /verifier-log [on|off]\n'));
        return;
      }

      // Mutate runtime env so the change takes effect immediately
      // (next sidecar call reads `process.env.KODAX_VERIFIER_LOG`).
      if (nextValue) {
        process.env.KODAX_VERIFIER_LOG = '1';
      } else {
        delete process.env.KODAX_VERIFIER_LOG;
      }

      const persistence = persistUserConfig({ verifierLog: nextValue });
      printPersistedCommandStatus(
        `Sidecar Verifier log: ${nextValue ? 'on' : 'off'}`,
        persistence,
      );
    },
    detailedHelp: () => {
      console.log(chalk.cyan('\n/verifier-log - Sidecar Verifier Log Toggle\n'));
      console.log(chalk.bold('Usage:'));
      console.log(chalk.dim('  /verifier-log           ') + 'Show current state');
      console.log(chalk.dim('  /verifier-log on        ') + 'Enable + persist to config');
      console.log(chalk.dim('  /verifier-log off       ') + 'Disable + persist to config');
      console.log();
      console.log(chalk.bold('Description:'));
      console.log(chalk.dim('  The Sidecar Verifier is the second-pass LLM judgment that fires'));
      console.log(chalk.dim('  after a Worker terminates text-only. Off by default (silent happy'));
      console.log(chalk.dim('  path). When on, every verifier call emits a one-line summary:'));
      console.log(chalk.dim('    [Sidecar Verifier] accept · anthropic/claude-sonnet-4-6 · 3214ms · verifier_ok'));
      console.log();
      console.log(chalk.bold('Equivalent env var:'));
      console.log(chalk.dim('  KODAX_VERIFIER_LOG=1   ') + 'Same effect, env wins over config');
      console.log();
    },
  },
  {
    name: 'stall-log',
    description: 'Toggle Stall Sidecar log line (off by default)',
    usage: '/stall-log [on|off]',
    argumentHint: 'on | off',
    handler: async (args) => {
      const raw = args[0]?.toLowerCase();
      const envOn = process.env.KODAX_STALL_LOG === '1';

      if (!raw) {
        const configOn = loadConfig().stallLog === true;
        const effective = envOn ? 'on' : 'off';
        // Same env-vs-config divergence handling as /verifier-log.
        const persistedSuffix =
          configOn === envOn
            ? ''
            : ` (env=${envOn ? 'on' : 'off'}, config=${configOn ? 'on' : 'off'})`;
        console.log(
          chalk.dim(`\nStall Sidecar log: ${chalk.cyan(effective)}${persistedSuffix}`),
        );
        console.log(
          chalk.dim(
            '  When on, a one-line summary persists per L2 stall verdict:\n' +
            '  `[Stall Sidecar] isStuck={true|false} · {provider}/{model} · {ms}ms · {trace}`',
          ),
        );
        console.log(chalk.dim('Usage: /stall-log [on|off]\n'));
        return;
      }

      let nextValue: boolean;
      if (raw === 'on' || raw === 'true' || raw === '1') {
        nextValue = true;
      } else if (raw === 'off' || raw === 'false' || raw === '0') {
        nextValue = false;
      } else {
        console.log(chalk.red(`\n[Invalid value: ${args[0]}]`));
        console.log(chalk.dim('Usage: /stall-log [on|off]\n'));
        return;
      }

      // Mutate runtime env so the change takes effect on the next stall
      // verdict (no restart needed). Read by the stall sidecar factory's
      // onVerdict gate in `runner-driven.ts`.
      if (nextValue) {
        process.env.KODAX_STALL_LOG = '1';
      } else {
        delete process.env.KODAX_STALL_LOG;
      }

      const persistence = persistUserConfig({ stallLog: nextValue });
      printPersistedCommandStatus(
        `Stall Sidecar log: ${nextValue ? 'on' : 'off'}`,
        persistence,
      );
    },
    detailedHelp: () => {
      console.log(chalk.cyan('\n/stall-log - Stall Sidecar Log Toggle\n'));
      console.log(chalk.bold('Usage:'));
      console.log(chalk.dim('  /stall-log           ') + 'Show current state');
      console.log(chalk.dim('  /stall-log on        ') + 'Enable + persist to config');
      console.log(chalk.dim('  /stall-log off       ') + 'Disable + persist to config');
      console.log();
      console.log(chalk.bold('Description:'));
      console.log(chalk.dim('  The Stall Sidecar (FEATURE_178) is the L2 anti-loop LLM judge that'));
      console.log(chalk.dim('  fires when the L1 rule-based detector spots a repeat-tool pattern.'));
      console.log(chalk.dim('  Off by default (silent happy path). When on, every L2 verdict emits'));
      console.log(chalk.dim('  a one-line summary:'));
      console.log(chalk.dim('    [Stall Sidecar] isStuck=true · zhipu/glm-5.1 (inherit) · 1842ms · sidecar_ok'));
      console.log();
      console.log(chalk.bold('Equivalent env var:'));
      console.log(chalk.dim('  KODAX_STALL_LOG=1   ') + 'Same effect, env wins over config');
      console.log();
    },
  },
  copyCommand,
  learnCommand,
  memoryCommand,
  goalCommand,
  workflowCommand,
  newCommand,
  recoverCommand,
  reviewCommand,
  agentsCommand,
];

// Print help.
const COMMAND_CATEGORIES: Record<string, string[]> = {
  General: ['help', 'copy', 'exit', 'clear', 'compact', 'reload', 'extensions', 'status', 'agents'],
  Permission: ['mode', 'auto'],
  Session: ['new', 'recover', 'save', 'load', 'sessions', 'history', 'delete'],
  Settings: ['model', 'provider', 'thinking', 'reasoning', 'effort', 'agent-mode', 'plan', 'repo-intel'],
  Skills: ['skill', 'learn'],
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

function formatReasoningEffortDisplay(effort: string | undefined): string {
  return effort === 'none' ? 'off' : effort ?? 'auto';
}

function getCanonicalReasoningEffortOptions(currentConfig: CurrentConfig): string[] {
  return getProviderReasoningEffortOptions(
    currentConfig.provider,
    currentConfig.model,
  ).map((effort) => effort === 'off' ? 'none' : effort);
}

function formatReasoningEffortUsage(
  commandName: string,
  currentConfig: CurrentConfig,
): string {
  return `Usage: /${commandName} ${getCanonicalReasoningEffortOptions(currentConfig).join('|')}|<provider-value>`;
}

function formatCurrentReasoningEffortStatus(config: CurrentConfig): string {
  const effectiveEffort = resolvePermissionModeEffort(config);
  return formatReasoningEffortStatusLabel({
    provider: config.provider,
    model: config.model,
    effort: effectiveEffort,
    effortOverride: config.effortOverride,
    thinking: config.thinking,
    reasoningMode: config.reasoningMode,
  });
}

const REPO_INTELLIGENCE_MODES: KodaXRepoIntelligenceMode[] = [
  'auto',
  'off',
  'light',
  'full',
];
type RepoIntelPublicMode = 'auto' | 'full' | 'light' | 'off';

type ConfigPersistenceResult =
  | { saved: true }
  | { saved: false; error: Error };

function normalizeRepoIntelPublicMode(
  value: string | undefined,
): KodaXRepoIntelligenceMode | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'auto') {
    return 'auto';
  }
  if (normalized === 'full') {
    return 'full';
  }
  if (normalized === 'light') {
    return 'light';
  }
  if (normalized === 'off') {
    return 'off';
  }
  return null;
}

function formatRepoIntelPublicMode(mode: KodaXRepoIntelligenceMode): RepoIntelPublicMode {
  return mode;
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

const LEGACY_REASONING_EFFORT_ALIASES: Readonly<Record<string, string>> = {
  on: 'auto',
  off: 'none',
  quick: 'low',
  balanced: 'medium',
  deep: 'high',
  med: 'medium',
};

async function handleReasoningEffortCommand(
  commandName: string,
  args: string[],
  callbacks: CommandCallbacks,
  currentConfig: CurrentConfig,
): Promise<void> {
  const usage = formatReasoningEffortUsage(commandName, currentConfig);
  if (args.length === 0) {
    const effortLabel = formatCurrentReasoningEffortStatus(currentConfig);
    console.log(chalk.dim(`\nReasoning effort: ${chalk.cyan(effortLabel)}`));
    console.log(chalk.dim(`Compatibility:    ${chalk.cyan(currentConfig.reasoningMode)}`));
    console.log(chalk.dim(`Available:        ${getCanonicalReasoningEffortOptions(currentConfig).join(', ')}`));
    console.log(chalk.dim(`${usage}\n`));
    return;
  }

  if (args.length > 1) {
    console.log(chalk.red('\n[Reasoning effort accepts exactly one value]'));
    console.log(chalk.dim(`${usage}\n`));
    return;
  }

  const raw = args[0].toLowerCase();
  let value: string;
  try {
    value = normalizeReasoningEffortValue(
      LEGACY_REASONING_EFFORT_ALIASES[raw] ?? raw,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(chalk.red(`\n[Invalid reasoning effort: ${message}]`));
    console.log(chalk.dim(`${usage}\n`));
    return;
  }

  const effort = value === 'auto' || value === 'unset' || value === 'clear' || value === 'reset'
    ? undefined
    : value;
  if (
    effort === 'none' &&
    !getProviderReasoningEffortOptions(
      currentConfig.provider,
      currentConfig.model,
    ).includes('off')
  ) {
    const model = currentConfig.model
      ? `${currentConfig.provider}/${currentConfig.model}`
      : currentConfig.provider;
    console.log(chalk.red(`\n[${model} does not support disabling reasoning]`));
    console.log(chalk.dim(`${usage}\n`));
    return;
  }

  const nextConfig = resolveConfigAfterReasoningEffort(effort, currentConfig);
  const persistence = applyReasoningEffort(effort, callbacks, currentConfig);
  printPersistedCommandStatus(
    `Reasoning effort: ${formatCurrentReasoningEffortStatus(nextConfig)}`,
    persistence,
  );
}

function printReasoningEffortHelp(commandName: string): void {
  console.log(chalk.dim(`  /${commandName}             `) + 'Show current native reasoning effort');
  console.log(chalk.dim(`  /${commandName} none        `) + 'Disable reasoning when supported');
  console.log(chalk.dim(`  /${commandName} auto        `) + 'Clear the explicit effort override');
  console.log(chalk.dim(`  /${commandName} low         `) + 'Use low native reasoning effort');
  console.log(chalk.dim(`  /${commandName} medium      `) + 'Use medium native reasoning effort');
  console.log(chalk.dim(`  /${commandName} high        `) + 'Use high native reasoning effort');
  console.log(chalk.dim(`  /${commandName} xhigh       `) + 'Use extra-high native reasoning effort');
  console.log(chalk.dim(`  /${commandName} max         `) + 'Use maximum native reasoning effort');
}

// V2: `reasoningMode` is a derived compatibility field that is only ever 'off'
// (thinking disabled via the `none` effort) or 'auto' (any thinking-on effort,
// including a cleared `auto`). Normalize it on every `/effort` so a stale legacy
// value (quick/balanced/deep) never lingers to mislead the status label or the
// legacy display, and so the persisted state matches the Ctrl+T toggle's full
// `{ effort, reasoningMode, thinking }` write (round-trip parity).
function resolveReasoningModeAfterEffort(
  effort: string | undefined,
): KodaXReasoningMode {
  return effort === 'none' ? 'off' : 'auto';
}

function resolveConfigAfterReasoningEffort(
  effort: string | undefined,
  currentConfig: CurrentConfig,
): CurrentConfig {
  const nextReasoningMode = resolveReasoningModeAfterEffort(effort);
  return {
    ...currentConfig,
    effort,
    effortOverride: effort !== undefined,
    reasoningMode: nextReasoningMode,
    thinking: reasoningModeToLegacyThinking(nextReasoningMode),
  };
}

function applyReasoningEffort(
  effort: string | undefined,
  callbacks: CommandCallbacks,
  currentConfig: CurrentConfig,
): ConfigPersistenceResult {
  const nextReasoningMode = resolveReasoningModeAfterEffort(effort);
  const thinking = reasoningModeToLegacyThinking(nextReasoningMode);
  const persistence = persistUserConfig({
    effort,
    reasoningMode: nextReasoningMode,
    thinking,
  });

  if (callbacks.setEffort) {
    callbacks.setEffort(effort);
  } else {
    currentConfig.effort = effort;
    currentConfig.effortOverride = effort !== undefined;
  }

  if (callbacks.setReasoningMode) {
    callbacks.setReasoningMode(nextReasoningMode);
  } else {
    currentConfig.reasoningMode = nextReasoningMode;
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
    trace?: boolean;
  },
  persistedConfig: {
    repoIntelligenceMode?: KodaXRepoIntelligenceMode;
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
  const fallbackLabel = inspection.fallbackToLight ? ', fallback=light' : '';
  return `${requestedLabel} => ${inspection.effectiveEngine} (${inspection.status}${fallbackLabel})`;
}

function getRepoIntelInspectionWorkspaceRoot(context: InteractiveContext): string | undefined {
  return context.runtimeInfo?.workspaceRoot
    ?? context.gitRoot
    ?? context.runtimeInfo?.executionCwd;
}

function formatRepoIntelStatusLabel(inspection: RepoIntelligenceRuntimeInspection): string {
  return inspection.status;
}

function formatRepoIntelActiveEngine(inspection: RepoIntelligenceRuntimeInspection): string {
  if (inspection.effectiveEngine === 'off') {
    return 'off';
  }
  return inspection.effectiveEngine;
}

function normalizeRepoIntelWarning(warning: string): string {
  return warning;
}

function printRepoIntelStatus(
  inspection: RepoIntelligenceRuntimeInspection,
): void {
  console.log(chalk.bold('\nRepo Intelligence:\n'));
  console.log(chalk.dim(`  Mode:        ${chalk.cyan(formatRepoIntelPublicMode(inspection.configuredMode))}`));
  console.log(chalk.dim(`  Engine:      ${chalk.cyan(formatRepoIntelActiveEngine(inspection))}`));
  console.log(chalk.dim(`  Status:      ${chalk.cyan(formatRepoIntelStatusLabel(inspection))}`));
  console.log(chalk.dim(`  Trace:       ${chalk.cyan(inspection.traceEnabled ? 'on' : 'off')}`));
  if (inspection.workerPath) {
    console.log(chalk.dim(`  Worker:      ${inspection.workerPath}`));
  }
  if (inspection.storageRoot) {
    console.log(chalk.dim(`  Cache:       ${inspection.storageRoot}`));
  }
  if (inspection.fallbackToLight) {
    console.log(chalk.yellow('  Fallback:    light engine is currently active'));
  }
  if (inspection.error) {
    console.log(chalk.red(`  Error:       ${inspection.error}`));
  }
  for (const warning of inspection.warnings) {
    console.log(chalk.yellow(`  Warning:     ${normalizeRepoIntelWarning(warning)}`));
  }
  console.log();
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
  console.log(`  ${chalk.cyan('/<skill-name>')}     Invoke a skill when no command has that name`);
  console.log(`  ${chalk.cyan('/skill:<name>')}     Compatibility form (e.g., /skill:code-review)`);
  console.log(`  ${chalk.cyan('/skill pending')}    Review pending skill learning suggestions`);
  console.log();
  console.log(chalk.dim(`Tip: ${chalk.cyan('/<command> help')} shows command-specific help.`));
  console.log();
}

// Print detailed help for a specific command.
/**
 * FEATURE_218 — render a KodaX self-knowledge manual topic in the REPL,
 * reusing the same structured resolver the `kodax_manual` tool uses. Unknown
 * topics resolve to the manual index instead of erroring.
 */
function printManualTopic(topic: string): void {
  const result = resolveKodaXManual({ topic });
  console.log(`\n${chalk.cyan(result.title)}`);
  console.log(result.content);
  if (result.topics.length > 0) {
    console.log();
    for (const topic of result.topics) {
      console.log(`- ${topic.id}: ${topic.summary}`);
    }
  }
  if (result.topics.length === 0 && result.nextTopics.length > 0) {
    console.log(chalk.dim(`\nRelated topics: ${result.nextTopics.join(', ')}`));
  }
  console.log();
}

function printDetailedHelp(
  commandName: string,
  args: readonly string[] = [],
): void {
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
    cmd.detailedHelp(args);
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
  callbacks?: CommandCallbacks,
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
  console.log(chalk.dim(`  Effort:      ${chalk.cyan(formatReasoningEffortDisplay(currentConfig.effort))}`));
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
    probe: true,
    workspaceRoot: getRepoIntelInspectionWorkspaceRoot(context),
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
  if (detailMode === 'runtime') {
    await printRuntimeSurfaceStatus(callbacks);
  }
  await printLearningSurfaceStatus(callbacks);
  console.log(chalk.dim(`  Created:     ${context.createdAt}`));
  console.log(chalk.dim(`  Last Active: ${context.lastAccessed}`));
  console.log();
}

async function printLearningSurfaceStatus(callbacks: CommandCallbacks | undefined): Promise<void> {
  if (!callbacks?.getLearningSummary) return;
  try {
    console.log(chalk.dim(`  Learning:    ${formatLearningStatus(await callbacks.getLearningSummary())}`));
  } catch (error: unknown) {
    console.log(chalk.dim(
      `  Learning:    unavailable (${error instanceof Error ? error.message : String(error)})`,
    ));
  }
}

async function printRuntimeSurfaceStatus(callbacks: CommandCallbacks | undefined): Promise<void> {
  if (!callbacks?.getRuntimeStatus) {
    console.log(chalk.dim('  SDK Runtime: unavailable (host did not provide runtime status)'));
    return;
  }

  let status: RuntimeSurfaceStatus | undefined;
  try {
    status = await callbacks.getRuntimeStatus();
  } catch (error: unknown) {
    console.log(chalk.dim(
      `  SDK Runtime: unavailable (${error instanceof Error ? error.message : String(error)})`,
    ));
    return;
  }

  if (!status) {
    console.log(chalk.dim('  SDK Runtime: unavailable'));
    return;
  }

  console.log(chalk.dim(
    `  SDK Runtime: ${chalk.cyan(status.mode)}  profile=${chalk.cyan(status.profile)}`,
  ));
  console.log(chalk.dim(`  Runtime ID:  ${status.runtimeId}`));
  if (status.health) {
    console.log(chalk.dim(`  Health:      ${status.health}`));
  }
  if (status.endpoint) {
    console.log(chalk.dim(`  Endpoint:    ${status.endpoint}`));
  }
  if (status.startedAt) {
    console.log(chalk.dim(`  Runtime Up:  ${status.startedAt}`));
  }
  const counters = [
    formatRuntimeCount('sessions', status.sessions),
    formatRuntimeCount('runs', status.runs),
    formatRuntimeCount('active', status.activeRuns),
    formatRuntimeCount('queued', status.queuedRuns),
    formatRuntimeCount('pending permissions', status.pendingPermissions),
    formatRuntimeCount('workflows', status.workflows),
  ].filter((line): line is string => line !== undefined);
  if (counters.length > 0) {
    console.log(chalk.dim(`  Runtime Ctrs:${' '} ${counters.join('  ')}`));
  }
}

function formatRuntimeCount(label: string, value: number | undefined): string | undefined {
  return value === undefined ? undefined : `${label}=${value}`;
}

// Handle the /skill namespace command.
async function handleSkillNamespaceCommand(args: string[], context: InteractiveContext): Promise<void> {
  const registry = getSkillRegistry(context.gitRoot);
  const subcommand = args[0]?.toLowerCase();

  if (subcommand === 'reload') {
    const count = await reloadSkillRegistry(context.gitRoot);
    console.log(chalk.green(`\nSkills reloaded: ${count} skill(s)`));
    console.log(chalk.dim('Updated skills will apply to subsequent requests in this session.'));
    console.log();
    return;
  }

  if (registry.size === 0) {
    await initializeSkillRegistry(context.gitRoot);
  }

  // /skill without :name shows the list.
  printSkillsListPiMonoStyle(registry.listUserInvocable());
}

// Print skills list with direct slash invocation as the primary form.
function printSkillsListPiMonoStyle(skills: SkillMetadata[]): void {
  console.log(chalk.bold('\nAvailable Skills:\n'));

  if (skills.length === 0) {
    console.log(chalk.dim('  No skills found.'));
    console.log(chalk.dim('\n  Skills can be placed in:'));
    console.log(chalk.dim('    - .kodax/skills/'));
    console.log(chalk.dim('    - ~/.kodax/skills/'));
    console.log(chalk.dim('    - ~/.agents/skills/'));
    return;
  }

  const slashCommands = getCommandRegistry();
  const rows = skills.map((skill) => {
    const commandNameTaken =
      slashCommands.get(skill.name) !== undefined || getActiveExtensionCommand(skill.name) !== undefined;
    return {
      skill,
      invocation: commandNameTaken ? `/skill:${skill.name}` : `/${skill.name}`,
      commandNameTaken,
    };
  });
  const maxInvocationLen = Math.max(...rows.map((row) => row.invocation.length));

  for (const row of rows) {
    const { skill } = row;
    // Pad first, then color so ANSI escapes do not affect width calculation.
    const paddedInvocation = row.invocation.padEnd(maxInvocationLen);
    const hint = skill.argumentHint ? ` ${skill.argumentHint}` : '';
    // Show source for all skills except project level, which is the default.
    const sourceLabel = skill.source === 'builtin' ? ' [builtin]'
      : skill.source === 'user' ? ' [user]'
      : skill.source === 'plugin' ? ' [plugin]'
      : '';
    const conflictLabel = row.commandNameTaken ? ' [command name exists]' : '';
    const desc = skill.description.length > 50
      ? skill.description.slice(0, 50) + '...'
      : skill.description;
    console.log(`  ${chalk.cyan(paddedInvocation)}${chalk.dim(hint)}${chalk.dim(sourceLabel)}${chalk.dim(conflictLabel)}  ${chalk.dim(desc)}`);
  }

  console.log();
  console.log(chalk.dim(`Total: ${skills.length} skills`));
  console.log(chalk.dim('Usage: /<skill-name> [args], legacy /skill:<name> [args], or ask naturally'));
  console.log(chalk.dim('Review pending skill learning suggestions with /skill pending'));
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

export function isRegisteredUserCommand(name: string, projectRoot?: string): boolean {
  return getCommandRegistry(projectRoot).has(name) || Boolean(getActiveExtensionCommand(name));
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

function formatDiagnosticParts(parts: readonly unknown[]): string {
  return parts.map((part) => {
    if (typeof part === 'string') {
      return part;
    }
    if (part instanceof Error) {
      return part.stack ?? part.message;
    }
    try {
      return JSON.stringify(part);
    } catch {
      return String(part);
    }
  }).join(' ');
}

function emitCommandDiagnostic(source: string, level: KodaXDiagnosticLevel, parts: readonly unknown[]): void {
  emitKodaXDiagnostic({
    source,
    level,
    message: formatDiagnosticParts(parts),
  });
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
      debug: (...parts) => emitCommandDiagnostic(`repl:extension-command:${command.name}`, 'debug', parts),
      info: (...parts) => emitCommandDiagnostic(`repl:extension-command:${command.name}`, 'info', parts),
      warn: (...parts) => emitCommandDiagnostic(`repl:extension-command:${command.name}`, 'warn', parts),
      error: (...parts) => emitCommandDiagnostic(`repl:extension-command:${command.name}`, 'error', parts),
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

  // Check for legacy /skill:name format.
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

function isCommandHelpRequest(args: readonly string[]): boolean {
  const firstArg = args[0]?.trim().toLowerCase();
  return firstArg === 'help' || firstArg === '--help' || firstArg === '-h';
}

// Execute command.
export type CommandResult = boolean | {
  skillContent?: string;
  invocation?: CommandInvocationRequest;
  workflow?: CommandWorkflowInvocationRequest;
};

export async function executeCommand(
  parsed: { command: string; args: string[]; skillInvocation?: { name: string } },
  context: InteractiveContext,
  callbacks: CommandCallbacks,
  currentConfig: CurrentConfig,
  rawInput?: string,
): Promise<CommandResult> {
  // Lazy initialization.
  if (commandRegistry.size === 0) {
    initCommandRegistry(context.gitRoot);
  }

  if (rawInput !== undefined) {
    let skillRegistry = getSkillRegistry(context.gitRoot);
    if (skillRegistry.size === 0) {
      skillRegistry = await initializeSkillRegistry(context.gitRoot);
    }
    try {
      assertSingleKnownUserSkillReference(rawInput, (name) => skillRegistry.has(name));
    } catch (error: unknown) {
      if (!(error instanceof MultipleUserSkillReferencesError)) throw error;
      console.log(chalk.yellow(`\n${error.message}\n`));
      return false;
    }
  }

  // Handle legacy /skill:name format.
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

    if (isCommandHelpRequest(parsed.args)) {
      printDetailedHelp(parsed.command, parsed.args.slice(1));
      return true;
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
    if (isCommandHelpRequest(parsed.args)) {
      printDetailedHelp(parsed.command);
      return true;
    }

    try {
      return await executeExtensionCommand(extensionCommand, parsed.args, context);
    } catch (error) {
      console.log(chalk.red(`\n[Extension command failed: ${error instanceof Error ? error.message : String(error)}]`));
      return false;
    }
  }

  const namespacedDirectSkill = await resolveNamespacedDirectSkillCommand(parsed, context);
  if (namespacedDirectSkill) {
    return await executeSkillCommand(
      { command: namespacedDirectSkill.skill.name, args: namespacedDirectSkill.args },
      context
    );
  }

  const directSkill = await resolveDirectSkillCommand(parsed.command, context);
  if (directSkill) {
    return await executeSkillCommand(
      { command: directSkill.name, args: parsed.args },
      context
    );
  }

  console.log(chalk.yellow(`\n[Unknown command: /${parsed.command}. Type /help for available commands]`));
  return false;
}

async function resolveNamespacedDirectSkillCommand(
  parsed: { command: string; args: string[] },
  context: InteractiveContext
): Promise<{ skill: SkillMetadata; args: string[] } | undefined> {
  const firstArg = parsed.args[0];
  if (!firstArg) return undefined;

  const candidateName = `${parsed.command}:${firstArg}`;
  const skill = await resolveDirectSkillCommand(candidateName, context);
  if (!skill) return undefined;

  return {
    skill,
    args: parsed.args.slice(1),
  };
}

async function resolveDirectSkillCommand(
  name: string,
  context: InteractiveContext
): Promise<SkillMetadata | undefined> {
  let registry = getSkillRegistry(context.gitRoot);
  if (registry.size === 0) {
    registry = await initializeSkillRegistry(context.gitRoot);
  }

  const skill = registry.get(name);
  return skill;
}

// Execute skill command.
async function executeSkillCommand(
  parsed: { command: string; args: string[] },
  context: InteractiveContext
): Promise<CommandResult> {
  let registry = getSkillRegistry(context.gitRoot);
  const skillName = parsed.command;
  const skillArgs = parsed.args.join(' ');

  if (registry.size === 0) {
    registry = await initializeSkillRegistry(context.gitRoot);
  }

  try {
    const skill = registry.get(skillName);
    if (!skill) {
      console.log(chalk.red(`\n[Skill not found: ${skillName}]`));
      return false;
    }
    console.log(chalk.cyan(`\n[Invoking skill: ${skillName}]`));
    if (skill.argumentHint) {
      console.log(chalk.dim(`Arguments: ${skillArgs || '(none)'}`));
    }
    console.log();

    const invocation = await createUserSkillInvocation(skillName, skillArgs, {
      workingDirectory: context.runtimeInfo?.executionCwd ?? process.cwd(),
      projectRoot: context.gitRoot ?? undefined,
      sessionId: context.sessionId,
      environment: {},
      // FEATURE_222 (R4): honor the host dynamic-context policy on the user-typed
      // /skill path too, so a sandbox host's disable/broker applies everywhere.
      executeDynamicContext: context.skillDynamicContext?.execute,
      disableDynamicContext: context.skillDynamicContext?.disable,
    });
    if (!invocation) return false;

    // Show skill activation message.
    console.log(chalk.green(`Skill activated: ${skillName}`));
    console.log(chalk.dim('The skill context has been prepared for the AI.'));
    console.log();

    return {
      invocation,
    };
  } catch (error) {
    console.log(chalk.red(`\n[Error invoking skill: ${error instanceof Error ? error.message : String(error)}]`));
    return false;
  }
}
