/**
 * Command Arguments Registry - 命令参数注册表
 *
 * Defines argument completions for built-in commands.
 * 为内置命令定义参数补全。
 */

// FEATURE_093 (v0.7.24): import types from ./types.ts to break the
// `argument-completer.ts ↔ command-arguments.ts` cycle.
import type { ArgumentDefinition, CommandArgumentsRegistry } from './types.js';
import { REPOINTEL_DEFAULT_ENDPOINT, getAvailableProviderNames, isKnownProvider } from '@kodax/coding';
import { getProviderAvailableModels } from '../../common/utils.js';

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
    description: 'Map to reasoning auto',
    type: 'enum',
  },
  {
    name: 'off',
    description: 'Disable reasoning',
    type: 'enum',
  },
  {
    name: 'auto',
    description: 'Use semantic routing with adaptive depth',
    type: 'enum',
  },
  {
    name: 'quick',
    description: 'Low-depth reasoning mode',
    type: 'enum',
  },
  {
    name: 'balanced',
    description: 'Medium-depth reasoning mode',
    type: 'enum',
  },
  {
    name: 'deep',
    description: 'High-depth reasoning mode',
    type: 'enum',
  },
];

const REASONING_ARGS = THINKING_ARGS.slice(2).concat([
  {
    name: 'off',
    description: 'Disable reasoning',
    type: 'enum',
  },
]);

/**
 * Model command arguments - /model 命令参数
 * Dynamically populated from available providers (includes custom providers).
 * Supports two-stage completion: provider names, then provider/model combinations.
 */
function getModelArgs(partial?: string): ArgumentDefinition[] {
  // Two-stage: if partial contains a known provider followed by /, show models for that provider
  if (partial && partial.includes('/')) {
    const slashIdx = partial.indexOf('/');
    const providerName = partial.slice(0, slashIdx);
    const modelPartial = partial.slice(slashIdx + 1);
    if (isKnownProvider(providerName)) {
      try {
        const models = getProviderAvailableModels(providerName);
        return models
          .filter(m => !modelPartial || m.toLowerCase().includes(modelPartial.toLowerCase()))
          .map(m => ({
            name: `${providerName}/${m}`,
            description: m,
            type: 'enum' as const,
          }));
      } catch { /* fall through */ }
    }
    // Unknown provider with / format — no completions
    return [];
  }
  // Default: show provider names
  return getAvailableProviderNames().map(
    (provider) => ({
      name: provider,
      description: `Switch to ${provider} provider`,
      type: 'enum' as const,
    })
  );
}

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

const STATUS_ARGS: ArgumentDefinition[] = [
  {
    name: 'workspace',
    description: 'Inspect current workspace/runtime truth in more detail',
    type: 'enum',
  },
  {
    name: 'runtime',
    description: 'Alias for workspace runtime inspection',
    type: 'enum',
  },
  {
    name: 'worktree',
    description: 'Alias for workspace runtime inspection',
    type: 'enum',
  },
];

/**
 * Project command arguments - /project 命令参数
 */
const PROJECT_ARGS: ArgumentDefinition[] = [
  {
    name: 'init',
    description: 'Initialize a new project with AI-generated feature list',
    type: 'enum',
  },
  {
    name: 'status',
    description: 'View project status (default), features, or progress',
    type: 'enum',
  },
  {
    name: 'next',
    description: 'Execute next pending feature',
    type: 'enum',
  },
  {
    name: 'auto',
    description: 'Auto-execute all pending features',
    type: 'enum',
  },
  {
    name: 'edit',
    description: 'AI-driven feature editing (e.g., edit #3 "标记为完成")',
    type: 'enum',
  },
  {
    name: 'reset',
    description: 'Clear progress or delete all project files',
    type: 'enum',
  },
  {
    name: 'analyze',
    description: 'AI-powered project analysis',
    type: 'enum',
  },
  {
    name: 'pause',
    description: 'Pause auto-continue mode',
    type: 'enum',
  },
  {
    name: 'list',
    description: '[Deprecated] Use /project status --features',
    type: 'enum',
  },
  {
    name: 'mark',
    description: '[Deprecated] Use /project edit instead',
    type: 'enum',
  },
  {
    name: 'progress',
    description: '[Deprecated] Use /project status --progress',
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

const REPOINTEL_SUBCOMMAND_ARGS: ArgumentDefinition[] = [
  {
    name: 'status',
    description: 'Inspect the current repo-intelligence runtime state',
    type: 'enum',
  },
  {
    name: 'warm',
    description: 'Warm or start the local premium runtime if available',
    type: 'enum',
  },
  {
    name: 'mode',
    description: 'Switch repo-intelligence runtime mode',
    type: 'enum',
  },
  {
    name: 'trace',
    description: 'Toggle repo-intelligence trace output',
    type: 'enum',
  },
  {
    name: 'endpoint',
    description: 'Inspect or override the local repointel daemon endpoint',
    type: 'enum',
  },
  {
    name: 'bin',
    description: 'Inspect or override the local repointel command or path',
    type: 'enum',
  },
];

const REPOINTEL_MODE_ARGS: ArgumentDefinition[] = [
  {
    name: 'auto',
    description: 'Resolve to premium-native when available, otherwise fall back to oss',
    type: 'enum',
  },
  {
    name: 'off',
    description: 'Disable repo-intelligence injection',
    type: 'enum',
  },
  {
    name: 'oss',
    description: 'Use only the public OSS repo-intelligence baseline',
    type: 'enum',
  },
  {
    name: 'premium-shared',
    description: 'Use premium without the native KodaX auto lane',
    type: 'enum',
  },
  {
    name: 'premium-native',
    description: 'Use premium through the native KodaX bridge',
    type: 'enum',
  },
];

const REPOINTEL_TRACE_ARGS: ArgumentDefinition[] = [
  {
    name: 'on',
    description: 'Enable repo-intelligence trace output',
    type: 'enum',
  },
  {
    name: 'off',
    description: 'Disable repo-intelligence trace output',
    type: 'enum',
  },
  {
    name: 'toggle',
    description: 'Toggle repo-intelligence trace output',
    type: 'enum',
  },
];

const REPOINTEL_RESETTABLE_ARGS: ArgumentDefinition[] = [
  {
    name: 'default',
    description: 'Clear the override and use the default value again',
    type: 'enum',
  },
];

function getRepointelArgs(argParts: string[]): ArgumentDefinition[] {
  const [subcommand = ''] = argParts;
  const normalizedSubcommand = subcommand.toLowerCase();
  const effectiveLength = argParts.length === 1 && argParts[0] === '' ? 0 : argParts.length;

  if (effectiveLength <= 1) {
    return REPOINTEL_SUBCOMMAND_ARGS;
  }

  if (effectiveLength > 2) {
    return [];
  }

  if (normalizedSubcommand === 'mode') {
    return REPOINTEL_MODE_ARGS;
  }

  if (normalizedSubcommand === 'trace') {
    return REPOINTEL_TRACE_ARGS;
  }

  if (normalizedSubcommand === 'endpoint') {
    return [
      ...REPOINTEL_RESETTABLE_ARGS,
      {
        name: REPOINTEL_DEFAULT_ENDPOINT,
        description: 'Default local repointel daemon endpoint',
        type: 'string',
      },
    ];
  }

  if (normalizedSubcommand === 'bin') {
    return REPOINTEL_RESETTABLE_ARGS;
  }

  return [];
}

/**
 * Global command arguments registry
 * 全局命令参数注册表
 */
export const COMMAND_ARGUMENTS: CommandArgumentsRegistry = new Map([
  ['mode', MODE_ARGS],
  ['thinking', THINKING_ARGS],
  ['think', THINKING_ARGS], // alias
  ['t', THINKING_ARGS], // alias
  ['reasoning', REASONING_ARGS],
  ['reason', REASONING_ARGS],
  // 'model' and 'm' handled dynamically in getCommandArguments()
  ['plan', PLAN_ARGS],
  ['p', PLAN_ARGS], // alias
  ['status', STATUS_ARGS],
  ['info', STATUS_ARGS],
  ['ctx', STATUS_ARGS],
  ['delete', DELETE_ARGS],
  ['rm', DELETE_ARGS], // alias
  ['del', DELETE_ARGS], // alias
]);

/**
 * Get argument definitions for a command
 * 获取命令的参数定义
 * Returns dynamic list for /model (includes custom providers).
 * For /model, supports two-stage completion when partial contains provider/.
 */
const MODEL_COMMAND_NAMES = new Set(['model', 'm']);
const REPOINTEL_COMMAND_NAMES = new Set(['repointel', 'ri']);

export function getCommandArguments(commandName: string, partial?: string, argParts: string[] = []): ArgumentDefinition[] {
  const key = commandName.toLowerCase();
  if (MODEL_COMMAND_NAMES.has(key)) {
    return getModelArgs(partial);
  }
  if (REPOINTEL_COMMAND_NAMES.has(key)) {
    return getRepointelArgs(argParts);
  }
  return COMMAND_ARGUMENTS.get(key) ?? [];
}

/**
 * Check if a command has argument completions
 * 检查命令是否有参数补全
 */
export function hasCommandArguments(commandName: string): boolean {
  const key = commandName.toLowerCase();
  if (COMMAND_ARGUMENTS.has(key)) return true;
  return getCommandArguments(key).length > 0;
}
