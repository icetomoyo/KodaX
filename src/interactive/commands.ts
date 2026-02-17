/**
 * KodaX 交互式命令系统
 */

import chalk from 'chalk';
import { InteractiveContext, InteractiveMode, setMode } from './context.js';
import { estimateTokens, KODAX_PROVIDERS, getProviderList, saveConfig } from '../kodax_core.js';

// 当前配置状态（由 repl.ts 传入）
export interface CurrentConfig {
  provider: string;
  thinking: boolean;
  noConfirm: boolean;
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
  setNoConfirm?: (enabled: boolean) => void;
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
    handler: async (_args, context) => {
      printStatus(context);
    },
  },
  {
    name: 'mode',
    aliases: ['m'],
    description: 'Switch between code and ask mode',
    usage: '/mode [code|ask]',
    handler: async (args, context) => {
      if (args.length === 0) {
        console.log(chalk.dim(`\nCurrent mode: ${chalk.cyan(context.mode)}`));
        console.log(chalk.dim('Usage: /mode [code|ask]'));
        return;
      }
      const newMode = args[0] as InteractiveMode;
      if (newMode === 'code' || newMode === 'ask') {
        setMode(context, newMode);
        console.log(chalk.cyan(`\n[Switched to ${newMode} mode]`));
      } else {
        console.log(chalk.red(`\n[Unknown mode: ${args[0]}. Use 'code' or 'ask']`));
      }
    },
  },
  {
    name: 'ask',
    description: 'Switch to ask mode (read-only)',
    handler: async (_args, context) => {
      setMode(context, 'ask');
      console.log(chalk.cyan('\n[Switched to ask mode - no file modifications]'));
    },
  },
  {
    name: 'code',
    description: 'Switch to code mode (default)',
    handler: async (_args, context) => {
      setMode(context, 'code');
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
        console.log(chalk.dim(`\nCurrent: provider=${currentConfig.provider}, thinking=${currentConfig.thinking}, noConfirm=${currentConfig.noConfirm}`));
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
    name: 'noconfirm',
    aliases: ['nc', 'auto'],
    description: 'Show or toggle auto-confirm mode',
    usage: '/noconfirm [on|off]',
    handler: async (args, _context, callbacks, currentConfig) => {
      if (args.length === 0) {
        const status = currentConfig.noConfirm ? chalk.green('ON (auto)') : chalk.dim('OFF (confirm)');
        console.log(chalk.dim(`\nAuto-confirm: ${status}`));
        console.log(chalk.dim('Usage: /noconfirm on|off to toggle\n'));
        return;
      }

      const value = args[0].toLowerCase();
      if (value === 'on' || value === 'off') {
        const enabled = value === 'on';
        saveConfig({ noConfirm: enabled });
        callbacks.setNoConfirm?.(enabled);
        console.log(chalk.cyan(`\n[Auto-confirm ${enabled ? 'enabled' : 'disabled'}] (已保存)`));
      } else {
        console.log(chalk.red(`\n[Invalid value: ${args[0]}]`));
        console.log(chalk.dim('Usage: /noconfirm on|off\n'));
      }
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
    'Session': BUILTIN_COMMANDS.filter(c => ['save', 'load', 'sessions', 'history'].includes(c.name)),
  };

  for (const [category, commands] of Object.entries(categories)) {
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
function printStatus(context: InteractiveContext): void {
  const tokens = estimateTokens(context.messages);
  console.log(chalk.bold('\nSession Status:\n'));
  console.log(chalk.dim(`  Mode:        ${chalk.cyan(context.mode)}`));
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
