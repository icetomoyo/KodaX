/**
 * KodaX 交互式命令系统
 */

import chalk from 'chalk';
import { InteractiveContext, InteractiveMode } from './context.js';
import { estimateTokens, KODAX_PROVIDERS, getProviderList, saveConfig } from '../kodax_core.js';
import { runWithPlanMode, listPlans, resumePlan, clearCompletedPlans } from '../cli/plan-mode.js';
import { handleProjectCommand } from './project-commands.js';
import { KodaXOptions } from '../core/index.js';

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
}

// 命令定义
export interface Command {
  name: string;
  aliases?: string[];
  description: string;
  usage?: string;
  handler: CommandHandler;
}

// 内置命令
export const BUILTIN_COMMANDS: Command[] = [
  {
    name: 'help',
    aliases: ['h', '?'],
    description: 'Show all available commands',
    handler: async () => {
      printHelp();
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
  },
  {
    name: 'clear',
    description: 'Clear conversation history',
    handler: async (_args, _context, callbacks) => {
      callbacks.clearHistory();
      console.log(chalk.yellow('\n[Conversation cleared]'));
    },
  },
  {
    name: 'status',
    aliases: ['info', 'ctx'],
    description: 'Show current session status',
    handler: async (_args, context, _callbacks, currentConfig) => {
      printStatus(context, currentConfig);
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
  },
  {
    name: 'ask',
    description: 'Switch to ask mode (read-only)',
    handler: async (_args, _context, _callbacks, currentConfig) => {
      currentConfig.mode = 'ask';
      console.log(chalk.cyan('\n[Switched to ask mode - no file modifications]'));
    },
  },
  {
    name: 'code',
    description: 'Switch to code mode (default)',
    handler: async (_args, _context, _callbacks, currentConfig) => {
      currentConfig.mode = 'code';
      console.log(chalk.cyan('\n[Switched to code mode]'));
    },
  },
  {
    name: 'save',
    description: 'Save current session',
    handler: async (_args, _context, callbacks) => {
      await callbacks.saveSession();
      console.log(chalk.green('\n[Session saved]'));
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
  },
  {
    name: 'sessions',
    aliases: ['ls', 'list'],
    description: 'List recent sessions',
    handler: async (_args, _context, callbacks) => {
      await callbacks.listSessions();
    },
  },
  {
    name: 'history',
    aliases: ['hist'],
    description: 'Show conversation history',
    handler: async (_args, _context, callbacks) => {
      callbacks.printHistory();
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
  },
  {
    name: 'thinking',
    aliases: ['t'],
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
  },
  {
    name: 'project',
    aliases: ['proj'],
    description: 'Project long-running task management',
    usage: '/project [init|status|next|auto|pause|list|mark|progress]',
    handler: async (args, context, callbacks, currentConfig) => {
      await handleProjectCommand(args, context, callbacks, currentConfig);
    },
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
    console.log();
  }

  console.log(chalk.dim('Special syntax:'));
  console.log(`  ${chalk.cyan('@file')}             Add file to context`);
  console.log(`  ${chalk.cyan('!command')}         Execute shell command`);
  console.log();
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
