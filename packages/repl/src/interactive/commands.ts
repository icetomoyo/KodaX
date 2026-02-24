/**
 * KodaX 交互式命令系统
 */

import * as readline from 'readline';
import chalk from 'chalk';
import { InteractiveContext, InteractiveMode } from './context.js';
import { estimateTokens, KODAX_PROVIDERS, getProviderList, KodaXOptions } from '@kodax/core';
import { saveConfig } from '../common/utils.js';
import { runWithPlanMode, listPlans, resumePlan, clearCompletedPlans } from '../common/plan-mode.js';
import { handleProjectCommand, printProjectHelp } from './project-commands.js';

// 当前配置状态（由 repl.ts 传入）
export interface CurrentConfig {
  provider: string;
  thinking: boolean;
  auto: boolean;
  mode?: 'code' | 'ask';
}

// 命令处理器类型
export type CommandHandler = (
  args: string[],
  context: InteractiveContext,
  callbacks: CommandCallbacks,
  currentConfig: CurrentConfig
) => Promise<void>;

// 命令回调
export interface CommandCallbacks {
  exit: () => void;
  saveSession: () => Promise<void>;
  loadSession: (id: string) => Promise<boolean>;
  listSessions: () => Promise<void>;
  clearHistory: () => void;
  printHistory: () => void;
  switchProvider?: (provider: string) => void;
  setThinking?: (enabled: boolean) => void;
  setAuto?: (enabled: boolean) => void;
  deleteSession?: (id: string) => Promise<void>;
  deleteAllSessions?: () => Promise<void>;
  setPlanMode?: (enabled: boolean) => void;
  createKodaXOptions?: () => KodaXOptions;
  /** REPL 的 readline 接口，供需要用户交互的命令使用 */
  readline?: readline.Interface;
}

// 命令定义
export interface Command {
  name: string;
  aliases?: string[];
  description: string;
  usage?: string;
  handler: CommandHandler;
  /** 详细帮助函数，返回多行帮助文本 */
  detailedHelp?: () => void;
}

// 内置命令
export const BUILTIN_COMMANDS: Command[] = [
  {
    name: 'help',
    aliases: ['h', '?'],
    description: 'Show all available commands',
    usage: '/help [command]',
    handler: async (args) => {
      if (args.length > 0) {
        // 显示特定命令的详细帮助
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
    handler: async (_args, _context, callbacks) => {
      callbacks.clearHistory();
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
    aliases: ['m'],
    description: 'Switch between code and ask mode',
    usage: '/mode [code|ask]',
    handler: async (args, _context, _callbacks, currentConfig) => {
      if (args.length === 0) {
        console.log(chalk.dim(`\nCurrent mode: ${chalk.cyan(currentConfig.mode ?? 'code')}`));
        console.log(chalk.dim('Usage: /mode [code|ask]'));
        return;
      }
      const newMode = args[0] as InteractiveMode;
      if (newMode === 'code' || newMode === 'ask') {
        currentConfig.mode = newMode;
        console.log(chalk.cyan(`\n[Switched to ${newMode} mode]`));
      } else {
        console.log(chalk.red(`\n[Unknown mode: ${args[0]}. Use 'code' or 'ask']`));
      }
    },
    detailedHelp: () => {
      console.log(chalk.cyan('\n/mode - Switch Interaction Mode\n'));
      console.log(chalk.bold('Usage:'));
      console.log(chalk.dim('  /mode              ') + 'Show current mode');
      console.log(chalk.dim('  /mode code         ') + 'Switch to code mode (default)');
      console.log(chalk.dim('  /mode ask          ') + 'Switch to ask mode');
      console.log();
      console.log(chalk.bold('Modes:'));
      console.log(chalk.green('  code') + chalk.dim('  - Full capabilities: read, write, execute commands'));
      console.log(chalk.yellow('  ask') + chalk.dim('   - Read-only: answer questions without modifying files'));
      console.log();
      console.log(chalk.bold('Examples:'));
      console.log(chalk.dim('  /mode              ') + '# Check current mode');
      console.log(chalk.dim('  /mode ask          ') + '# Switch to Q&A mode');
      console.log(chalk.dim('  /ask               ') + '# Quick switch to ask mode');
      console.log(chalk.dim('  /code              ') + '# Quick switch to code mode');
      console.log();
    },
  },
  {
    name: 'ask',
    description: 'Switch to ask mode (read-only)',
    handler: async (_args, _context, _callbacks, currentConfig) => {
      currentConfig.mode = 'ask';
      console.log(chalk.cyan('\n[Switched to ask mode - no file modifications]'));
    },
    detailedHelp: () => {
      console.log(chalk.cyan('\n/ask - Quick Switch to Ask Mode\n'));
      console.log(chalk.bold('Usage:'));
      console.log(chalk.dim('  /ask               ') + 'Switch to ask mode immediately');
      console.log();
      console.log(chalk.bold('Description:'));
      console.log(chalk.dim('  Equivalent to /mode ask. Switches to read-only mode.'));
      console.log(chalk.dim('  In ask mode, the agent will NOT modify any files.'));
      console.log();
      console.log(chalk.dim('  See also: /help mode, /help code'));
      console.log();
    },
  },
  {
    name: 'code',
    description: 'Switch to code mode (default)',
    handler: async (_args, _context, _callbacks, currentConfig) => {
      currentConfig.mode = 'code';
      console.log(chalk.cyan('\n[Switched to code mode]'));
    },
    detailedHelp: () => {
      console.log(chalk.cyan('\n/code - Quick Switch to Code Mode\n'));
      console.log(chalk.bold('Usage:'));
      console.log(chalk.dim('  /code              ') + 'Switch to code mode immediately');
      console.log();
      console.log(chalk.bold('Description:'));
      console.log(chalk.dim('  Equivalent to /mode code. Switches to full capability mode.'));
      console.log(chalk.dim('  In code mode, the agent can read, write, and execute.'));
      console.log();
      console.log(chalk.dim('  See also: /help mode, /help ask'));
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
    description: 'Show or switch provider',
    usage: '/model [provider-name]',
    handler: async (args, _context, callbacks, currentConfig) => {
      if (args.length === 0) {
        // 显示所有 Provider 及状态
        console.log(chalk.bold('\nAvailable Providers:\n'));
        const providers = getProviderList();
        const maxNameLen = Math.max(...providers.map(p => p.name.length));
        for (const p of providers) {
          const paddedName = p.name.padEnd(maxNameLen);
          const configured = p.configured ? chalk.green('[已配置]') : chalk.red('[未配置]');
          const current = p.name === currentConfig.provider ? chalk.cyan(' *') : '';
          console.log(`  ${paddedName} (${p.model}) ${configured}${current}`);
        }
        console.log(chalk.dim(`\nCurrent: provider=${currentConfig.provider}, thinking=${currentConfig.thinking}, auto=${currentConfig.auto}`));
        console.log(chalk.dim('Usage: /model <provider-name> to switch\n'));
        return;
      }

      const newProvider = args[0];
      if (KODAX_PROVIDERS[newProvider]) {
        // 保存到配置
        saveConfig({ provider: newProvider });
        callbacks.switchProvider?.(newProvider);
        console.log(chalk.cyan(`\n[Switched to ${newProvider}] (已保存)`));
      } else {
        console.log(chalk.red(`\n[Unknown provider: ${newProvider}]`));
        console.log(chalk.dim(`Available: ${Object.keys(KODAX_PROVIDERS).join(', ')}\n`));
      }
    },
    detailedHelp: () => {
      console.log(chalk.cyan('\n/model - Switch LLM Provider\n'));
      console.log(chalk.bold('Usage:'));
      console.log(chalk.dim('  /model             ') + 'List all available providers');
      console.log(chalk.dim('  /model <name>      ') + 'Switch to a specific provider');
      console.log();
      console.log(chalk.bold('Description:'));
      console.log(chalk.dim('  Switch between different LLM providers. The setting is'));
      console.log(chalk.dim('  saved to config file and persists across sessions.'));
      console.log();
      console.log(chalk.bold('Examples:'));
      console.log(chalk.dim('  /model             ') + '# See available providers');
      console.log(chalk.dim('  /model anthropic   ') + '# Switch to Anthropic Claude');
      console.log(chalk.dim('  /model openai      ') + '# Switch to OpenAI');
      console.log();
    },
  },
  {
    name: 'thinking',
    aliases: ['think', 't'],
    description: 'Show or toggle thinking mode',
    usage: '/thinking [on|off]',
    handler: async (args, _context, callbacks, currentConfig) => {
      if (args.length === 0) {
        const status = currentConfig.thinking ? chalk.green('ON') : chalk.dim('OFF');
        console.log(chalk.dim(`\nThinking: ${status}`));
        console.log(chalk.dim('Usage: /thinking on|off to toggle\n'));
        return;
      }

      const value = args[0].toLowerCase();
      if (value === 'on' || value === 'off') {
        const enabled = value === 'on';
        saveConfig({ thinking: enabled });
        callbacks.setThinking?.(enabled);
        console.log(chalk.cyan(`\n[Thinking ${enabled ? 'enabled' : 'disabled'}] (已保存)`));
      } else {
        console.log(chalk.red(`\n[Invalid value: ${args[0]}]`));
        console.log(chalk.dim('Usage: /thinking on|off\n'));
      }
    },
    detailedHelp: () => {
      console.log(chalk.cyan('\n/thinking - Toggle Extended Thinking Mode\n'));
      console.log(chalk.bold('Usage:'));
      console.log(chalk.dim('  /thinking          ') + 'Show current thinking status');
      console.log(chalk.dim('  /thinking on       ') + 'Enable extended thinking');
      console.log(chalk.dim('  /thinking off      ') + 'Disable extended thinking');
      console.log(chalk.dim('  /t                 ') + 'Alias for /thinking');
      console.log();
      console.log(chalk.bold('Description:'));
      console.log(chalk.dim('  Extended thinking allows the model to reason through'));
      console.log(chalk.dim('  complex problems before responding. Useful for:'));
      console.log(chalk.dim('  - Complex architectural decisions'));
      console.log(chalk.dim('  - Multi-step reasoning tasks'));
      console.log(chalk.dim('  - Deep code analysis'));
      console.log();
    },
  },
  {
    name: 'auto',
    aliases: ['a'],
    description: 'Show or toggle auto mode (skip confirmations)',
    usage: '/auto [on|off]',
    handler: async (args, _context, callbacks, currentConfig) => {
      if (args.length === 0) {
        const status = currentConfig.auto ? chalk.green('ON') : chalk.dim('OFF');
        console.log(chalk.dim(`\nAuto: ${status}`));
        console.log(chalk.dim('Usage: /auto on|off to toggle\n'));
        return;
      }

      const value = args[0].toLowerCase();
      if (value === 'on' || value === 'off') {
        const enabled = value === 'on';
        saveConfig({ auto: enabled });
        callbacks.setAuto?.(enabled);
        console.log(chalk.cyan(`\n[Auto ${enabled ? 'enabled' : 'disabled'}] (已保存)`));
      } else {
        console.log(chalk.red(`\n[Invalid value: ${args[0]}]`));
        console.log(chalk.dim('Usage: /auto on|off\n'));
      }
    },
    detailedHelp: () => {
      console.log(chalk.cyan('\n/auto - Toggle Auto Mode\n'));
      console.log(chalk.bold('Usage:'));
      console.log(chalk.dim('  /auto              ') + 'Show current auto status');
      console.log(chalk.dim('  /auto on           ') + 'Enable auto mode');
      console.log(chalk.dim('  /auto off          ') + 'Disable auto mode');
      console.log(chalk.dim('  /a                 ') + 'Alias for /auto');
      console.log();
      console.log(chalk.bold('Description:'));
      console.log(chalk.dim('  When auto mode is ON, the agent will skip confirmation'));
      console.log(chalk.dim('  prompts for file operations. Useful for:'));
      console.log(chalk.dim('  - Trusted environments'));
      console.log(chalk.dim('  - Automated workflows'));
      console.log(chalk.dim('  - Faster iteration'));
      console.log();
      console.log(chalk.yellow('  Warning: Without confirmations, changes happen faster!'));
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
    usage: '/project [init|status|next|auto|pause|list|mark|progress]',
    handler: async (args, context, callbacks, currentConfig) => {
      await handleProjectCommand(args, context, callbacks, currentConfig);
    },
    detailedHelp: printProjectHelp,
  },
];

// 打印帮助
function printHelp(): void {
  console.log(chalk.bold('\nAvailable Commands:\n'));

  // 按类别分组
  const categories: Record<string, Command[]> = {
    'General': BUILTIN_COMMANDS.filter(c => ['help', 'exit', 'clear', 'status'].includes(c.name)),
    'Mode': BUILTIN_COMMANDS.filter(c => ['mode', 'ask', 'code'].includes(c.name)),
    'Session': BUILTIN_COMMANDS.filter(c => ['save', 'load', 'sessions', 'history', 'delete'].includes(c.name)),
    'Settings': BUILTIN_COMMANDS.filter(c => ['model', 'thinking', 'auto', 'plan'].includes(c.name)),
    'Project': BUILTIN_COMMANDS.filter(c => ['project'].includes(c.name)),
  };

  for (const [category, commands] of Object.entries(categories)) {
    if (commands.length === 0) continue;
    console.log(chalk.dim(`${category}:`));
    for (const cmd of commands) {
      const aliases = cmd.aliases ? chalk.dim(` (${cmd.aliases.join(', ')})`) : '';
      console.log(`  ${chalk.cyan(`/${cmd.name}`)}${aliases.padEnd(20)} ${cmd.description}`);
    }
    // 为 Project 类别添加子命令提示
    if (category === 'Project') {
      console.log(chalk.dim('    Subcommands: init, status, next, auto, pause, list, mark, progress'));
    }
    console.log();
  }

  console.log(chalk.dim('Special syntax:'));
  console.log(`  ${chalk.cyan('@file')}             Add file to context`);
  console.log(`  ${chalk.cyan('!command')}         Execute shell command`);
  console.log();
}

// 打印特定命令的详细帮助
function printDetailedHelp(commandName: string): void {
  // 延迟初始化
  if (commandRegistry.size === 0) {
    initCommandRegistry();
  }

  const cmd = commandRegistry.get(commandName.toLowerCase());
  if (!cmd) {
    console.log(chalk.yellow(`\n[Unknown command: /${commandName}. Type /help for available commands]`));
    return;
  }

  // 如果命令有详细帮助函数，调用它
  if (cmd.detailedHelp) {
    cmd.detailedHelp();
  } else {
    // 否则显示基本信息
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

// 打印状态
function printStatus(context: InteractiveContext, currentConfig: CurrentConfig): void {
  const tokens = estimateTokens(context.messages);
  console.log(chalk.bold('\nSession Status:\n'));
  console.log(chalk.dim(`  Mode:        ${chalk.cyan(currentConfig.mode ?? 'code')}`));
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

// 命令注册表
const commandRegistry = new Map<string, Command>();

// 初始化命令注册表
function initCommandRegistry(): void {
  for (const cmd of BUILTIN_COMMANDS) {
    commandRegistry.set(cmd.name, cmd);
    if (cmd.aliases) {
      for (const alias of cmd.aliases) {
        commandRegistry.set(alias, cmd);
      }
    }
  }
}

// 解析命令
export function parseCommand(input: string): { command: string; args: string[] } | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return null;

  const parts = trimmed.slice(1).split(/\s+/);
  const command = parts[0]?.toLowerCase();
  const args = parts.slice(1).filter(Boolean);

  return command ? { command, args } : null;
}

// 执行命令
export async function executeCommand(
  parsed: { command: string; args: string[] },
  context: InteractiveContext,
  callbacks: CommandCallbacks,
  currentConfig: CurrentConfig
): Promise<boolean> {
  // 延迟初始化
  if (commandRegistry.size === 0) {
    initCommandRegistry();
  }

  const cmd = commandRegistry.get(parsed.command);
  if (cmd) {
    await cmd.handler(parsed.args, context, callbacks, currentConfig);
    return true;
  }

  console.log(chalk.yellow(`\n[Unknown command: /${parsed.command}. Type /help for available commands]`));
  return false;
}
