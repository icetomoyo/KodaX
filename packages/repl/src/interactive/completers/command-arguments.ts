/**
 * Command Arguments Registry - 命令参数注册表
 *
 * Defines argument completions for built-in commands.
 * 为内置命令定义参数补全。
 */

import type { ArgumentDefinition, CommandArgumentsRegistry } from './argument-completer.js';
import { KODAX_PROVIDERS } from '@kodax/coding';

/**
 * Mode command arguments - /mode 命令参数
 */
const MODE_ARGS: ArgumentDefinition[] = [
  {
    name: 'plan',
    description: 'Read-only planning mode - blocks all modifications',
    type: 'enum',
  },
  {
    name: 'default',
    description: 'All tools require confirmation',
    type: 'enum',
  },
  {
    name: 'accept-edits',
    description: 'File edits auto-approved, bash requires confirmation',
    type: 'enum',
  },
  {
    name: 'auto-in-project',
    description: 'All tools auto within project directory',
    type: 'enum',
  },
];

/**
 * Thinking command arguments - /thinking 命令参数
 */
const THINKING_ARGS: ArgumentDefinition[] = [
  {
    name: 'on',
    description: 'Enable extended thinking mode',
    type: 'enum',
  },
  {
    name: 'off',
    description: 'Disable extended thinking mode',
    type: 'enum',
  },
];

/**
 * Model command arguments - /model 命令参数
 * Dynamically populated from available providers
 */
const MODEL_ARGS: ArgumentDefinition[] = Object.keys(KODAX_PROVIDERS).map(
  (provider) => ({
    name: provider,
    description: `Switch to ${provider} provider`,
    type: 'enum' as const,
  })
);

/**
 * Plan command arguments - /plan 命令参数
 */
const PLAN_ARGS: ArgumentDefinition[] = [
  {
    name: 'on',
    description: 'Enable plan mode for all requests',
    type: 'enum',
  },
  {
    name: 'off',
    description: 'Disable plan mode',
    type: 'enum',
  },
  {
    name: 'once',
    description: 'Run plan mode for a single request (followed by task)',
    type: 'enum',
  },
  {
    name: 'list',
    description: 'List all saved plans',
    type: 'enum',
  },
  {
    name: 'resume',
    description: 'Resume a saved plan (followed by plan ID)',
    type: 'enum',
  },
  {
    name: 'clear',
    description: 'Clear completed plans',
    type: 'enum',
  },
];

/**
 * Project command arguments - /project 命令参数
 */
const PROJECT_ARGS: ArgumentDefinition[] = [
  {
    name: 'init',
    description: 'Initialize a new long-running project task',
    type: 'enum',
  },
  {
    name: 'status',
    description: 'Show current project status',
    type: 'enum',
  },
  {
    name: 'next',
    description: 'Get next feature to work on',
    type: 'enum',
  },
  {
    name: 'auto',
    description: 'Auto-continue project execution',
    type: 'enum',
  },
  {
    name: 'pause',
    description: 'Pause auto-continue mode',
    type: 'enum',
  },
  {
    name: 'list',
    description: 'List all project features',
    type: 'enum',
  },
  {
    name: 'mark',
    description: 'Mark a feature as completed (followed by feature ID)',
    type: 'enum',
  },
  {
    name: 'progress',
    description: 'Show detailed progress report',
    type: 'enum',
  },
];

/**
 * Delete command arguments - /delete 命令参数
 */
const DELETE_ARGS: ArgumentDefinition[] = [
  {
    name: 'all',
    description: 'Delete ALL sessions',
    type: 'enum',
  },
];

/**
 * Global command arguments registry
 * 全局命令参数注册表
 */
export const COMMAND_ARGUMENTS: CommandArgumentsRegistry = new Map([
  ['mode', MODE_ARGS],
  ['m', MODE_ARGS], // alias
  ['thinking', THINKING_ARGS],
  ['think', THINKING_ARGS], // alias
  ['t', THINKING_ARGS], // alias
  ['model', MODEL_ARGS],
  ['plan', PLAN_ARGS],
  ['p', PLAN_ARGS], // alias
  ['project', PROJECT_ARGS],
  ['proj', PROJECT_ARGS], // alias
  ['delete', DELETE_ARGS],
  ['rm', DELETE_ARGS], // alias
  ['del', DELETE_ARGS], // alias
]);

/**
 * Get argument definitions for a command
 * 获取命令的参数定义
 */
export function getCommandArguments(commandName: string): ArgumentDefinition[] {
  return COMMAND_ARGUMENTS.get(commandName.toLowerCase()) ?? [];
}

/**
 * Check if a command has argument completions
 * 检查命令是否有参数补全
 */
export function hasCommandArguments(commandName: string): boolean {
  return COMMAND_ARGUMENTS.has(commandName.toLowerCase());
}
