/**
 * Command Arguments Registry - 命令参数注册表
 *
 * Defines argument completions for built-in commands.
 * 为内置命令定义参数补全。
 */

// FEATURE_093 (v0.7.24): import types from ./types.ts to break the
// `argument-completer.ts ↔ command-arguments.ts` cycle.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ArgumentDefinition, CommandArgumentsRegistry } from './types.js';
import { getAgentConfigPath } from '@kodax-ai/agent';
import {
  getAvailableProviderNames,
  getDefaultWorkflowRunManager,
  isKnownProvider,
  listBuiltinWorkflows,
} from '@kodax-ai/coding';
import { getProviderAvailableModels } from '../../common/utils.js';
import { deriveProjectKeyFromRoot } from '../project-key.js';

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
    description: 'Sandbox first; user decides only at the host boundary',
    type: 'enum',
  },
  {
    name: 'auto',
    description: 'Use sandbox execution with LLM review at the host boundary',
    type: 'enum',
  },
  {
    name: 'full-access',
    description: 'Direct host execution; Exec Policy still applies',
    type: 'enum',
  },
];

/**
 * Thinking command arguments - /thinking 命令参数
 */
const REASONING_EFFORT_ARGS: ArgumentDefinition[] = [
  {
    name: 'none',
    description: 'Disable reasoning when the model supports it',
    type: 'enum',
  },
  {
    name: 'auto',
    description: 'Clear the explicit effort override',
    type: 'enum',
  },
  {
    name: 'low',
    description: 'Use low reasoning effort',
    type: 'enum',
  },
  {
    name: 'medium',
    description: 'Use medium reasoning effort',
    type: 'enum',
  },
  {
    name: 'high',
    description: 'Use high reasoning effort',
    type: 'enum',
  },
  {
    name: 'xhigh',
    description: 'Use extra-high reasoning effort',
    type: 'enum',
  },
  {
    name: 'max',
    description: 'Use maximum reasoning effort',
    type: 'enum',
  },
];

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
 * Status command arguments - /status 命令参数
 */
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
 * Delete command arguments - /delete 命令参数
 */
const DELETE_ARGS: ArgumentDefinition[] = [
  {
    name: 'all',
    description: 'Delete ALL sessions',
    type: 'enum',
  },
];

const MCP_ARGS: ArgumentDefinition[] = [
  { name: 'status', description: 'Show MCP server status', type: 'enum' },
  { name: 'refresh', description: 'Refresh MCP server catalogs', type: 'enum' },
];

const FALLBACK_ARGS: ArgumentDefinition[] = [
  { name: 'status', description: 'Show child-task fallback order', type: 'enum' },
  { name: 'off', description: 'Disable child-task fallback providers', type: 'enum' },
];

const AGENT_MODE_ARGS: ArgumentDefinition[] = [
  { name: 'ama', description: 'Use AMA agent mode', type: 'enum' },
  { name: 'sa', description: 'Use single-agent mode', type: 'enum' },
  { name: 'toggle', description: 'Cycle to the next agent mode', type: 'enum' },
];

const TOGGLE_ARGS: ArgumentDefinition[] = [
  { name: 'on', description: 'Enable logging', type: 'enum' },
  { name: 'off', description: 'Disable logging', type: 'enum' },
];

const MEMORY_ARGS: ArgumentDefinition[] = [
  { name: 'list', description: 'Summarize accepted Memory', type: 'enum' },
  { name: 'remember', description: 'Remember one explicit keyed claim now', type: 'enum' },
  { name: 'forget', description: 'Forget one exact accepted Memory', type: 'enum' },
  { name: 'decisions', description: 'List exceptional changes that need you', type: 'enum' },
  { name: 'show', description: 'Show one accepted Memory or decision', type: 'enum' },
  { name: 'approve', description: 'Approve one reviewed decision', type: 'enum' },
  { name: 'reject', description: 'Reject one reviewed decision', type: 'enum' },
  { name: 'doctor', description: 'Diagnose the Memory pipeline', type: 'enum' },
  { name: 'open', description: 'Open Memory in an external editor', type: 'enum' },
  { name: 'help', description: 'Show memory help', type: 'enum' },
];

const LEARN_SUBCOMMAND_ARGS: ArgumentDefinition[] = [
  { name: 'list', description: 'List learned capabilities', type: 'enum' },
  { name: 'ready', description: 'List capabilities ready for review/control', type: 'enum' },
  { name: 'pending', description: 'Compatibility alias for ready capabilities', type: 'enum' },
  { name: 'show', description: 'Inspect one exact learned capability', type: 'enum' },
  { name: 'review', description: 'Start or restart bounded canary review', type: 'enum' },
  { name: 'trust', description: 'Explicitly trust a reviewed revision', type: 'enum' },
  { name: 'reject', description: 'Reject a learned capability', type: 'enum' },
  { name: 'disable', description: 'Disable an active learned capability', type: 'enum' },
  { name: 'rollback', description: 'Restore the previous good revision', type: 'enum' },
  { name: 'promote', description: 'Promote an exact revision to the user Skill catalog', type: 'enum' },
  { name: 'help', description: 'Show Learning Center help', type: 'enum' },
];

function getLearnArgs(argParts: string[]): ArgumentDefinition[] {
  const [subcommand = ''] = argParts;
  const normalizedSubcommand = subcommand.toLowerCase();
  const effectiveLength = argParts.length === 1 && argParts[0] === '' ? 0 : argParts.length;
  if (effectiveLength <= 1) return LEARN_SUBCOMMAND_ARGS;
  if (normalizedSubcommand === 'help' && effectiveLength <= 2) {
    return [{ name: 'promote', description: 'Show dedicated promotion help', type: 'enum' }];
  }
  if (normalizedSubcommand !== 'promote') return [];
  if (effectiveLength <= 2) {
    return [{ name: '--help', description: 'Show dedicated promotion help', type: 'enum' }];
  }
  if (effectiveLength <= 3) {
    return [{ name: '--scope', description: 'Choose the formal user Skill scope', type: 'enum' }];
  }
  if (argParts[2]?.toLowerCase() === '--scope' && effectiveLength <= 4) {
    return [{ name: 'user', description: 'Promote to the formal user Skill catalog', type: 'enum' }];
  }
  return [];
}

const GOAL_ARGS: ArgumentDefinition[] = [
  { name: 'status', description: 'Show current persistent goal', type: 'enum' },
  { name: 'pause', description: 'Pause the active goal', type: 'enum' },
  { name: 'resume', description: 'Resume a paused goal', type: 'enum' },
  { name: 'clear', description: 'Clear the current goal', type: 'enum' },
  { name: 'help', description: 'Show goal help', type: 'enum' },
  { name: '--tokens', description: 'Set an optional goal token budget', type: 'enum' },
];

const PASTE_ARGS: ArgumentDefinition[] = [
  { name: 'show', description: 'Show a captured paste by id', type: 'enum' },
  { name: 'list', description: 'List captured pastes', type: 'enum' },
];

const REVIEW_ARGS: ArgumentDefinition[] = [
  { name: '--lean', description: 'Add a minimal-diff/YAGNI review pass', type: 'enum' },
  { name: '--workflow', description: 'Review through a dynamic workflow', type: 'enum' },
  { name: 'base', description: 'Review changes against the detected base branch', type: 'enum' },
  { name: 'sha', description: 'Review a specific commit', type: 'enum' },
  { name: 'help', description: 'Show review help', type: 'enum' },
];

const AGENTS_ARGS: ArgumentDefinition[] = [
  { name: 'init', description: 'Create AGENTS.md in the target project if absent', type: 'enum' },
  { name: 'lean', description: 'Initialize or LLM-review AGENTS.md for Lean Mode guidance', type: 'enum' },
  { name: 'help', description: 'Show agents help', type: 'enum' },
];

const REPO_INTEL_SUBCOMMAND_ARGS: ArgumentDefinition[] = [
  {
    name: 'status',
    description: 'Inspect the current repo-intelligence runtime state',
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
];

const REPO_INTEL_MODE_ARGS: ArgumentDefinition[] = [
  {
    name: 'auto',
    description: 'Let KodaX pick the best repo-intelligence engine',
    type: 'enum',
  },
  {
    name: 'full',
    description: 'Prefer the full repo-intelligence engine',
    type: 'enum',
  },
  {
    name: 'light',
    description: 'Use the light repo-intelligence engine',
    type: 'enum',
  },
  {
    name: 'off',
    description: 'Disable repo-intelligence injection',
    type: 'enum',
  },
];

const REPO_INTEL_TRACE_ARGS: ArgumentDefinition[] = [
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

const LEGACY_REPOINTEL_SUBCOMMAND_ARGS: ArgumentDefinition[] = [
  {
    name: 'status',
    description: 'Deprecated alias for /repo-intel status',
    type: 'enum',
  },
];

const WORKFLOW_SUBCOMMAND_ARGS: ArgumentDefinition[] = [
  { name: 'list', description: 'List built-in and saved workflows', type: 'enum' },
  { name: 'create', description: 'Generate and run a workflow from a request', type: 'enum' },
  { name: 'runs', description: 'List active and recent workflow runs', type: 'enum' },
  { name: 'show', description: 'Show latest run or a specific workflow run', type: 'enum' },
  { name: 'pause', description: 'Pause future child launches for a run', type: 'enum' },
  { name: 'resume', description: 'Resume a paused run', type: 'enum' },
  { name: 'stop', description: 'Stop an active workflow run', type: 'enum' },
  { name: 'delete', description: 'Delete one persisted workflow run or generated saved capsule', type: 'enum' },
  { name: 'prune', description: 'Preview or delete old terminal workflow runs', type: 'enum' },
  { name: 'rerun', description: 'Rerun a run id or saved workflow name', type: 'enum' },
  { name: 'save', description: 'Save a generated run as a workflow capsule', type: 'enum' },
  { name: 'rename', description: 'Rename a run display name or saved workflow capsule', type: 'enum' },
  { name: 'revise', description: 'Generate a revised workflow capsule', type: 'enum' },
  { name: 'help', description: 'Show workflow help', type: 'enum' },
];

const WORKFLOW_RUN_ID_SUBCOMMANDS = new Set([
  'show',
  'pause',
  'resume',
  'stop',
  'delete',
  'rerun',
  'save',
  'rename',
  'revise',
]);

const WORKFLOW_PERSISTED_RUN_ID_SUBCOMMANDS = new Set([
  'show',
  'delete',
  'rerun',
  'save',
  'rename',
  'revise',
]);

const WORKFLOW_RUNS_OPTION_ARGS: ArgumentDefinition[] = [
  { name: '--all', description: 'Show all persisted workflow runs', type: 'enum' },
  { name: '--limit', description: 'Show at most N persisted workflow runs', type: 'enum' },
];

const WORKFLOW_PRUNE_OPTION_ARGS: ArgumentDefinition[] = [
  { name: '--dry-run', description: 'Preview cleanup without deleting runs', type: 'enum' },
  { name: '--keep', description: 'Keep the newest N terminal runs', type: 'enum' },
  { name: '--older-than', description: 'Delete terminal runs older than Nd or Nh', type: 'enum' },
];

const WORKFLOW_DELETE_OPTION_ARGS: ArgumentDefinition[] = [
  { name: '--force', description: 'Delete stale non-terminal run records', type: 'enum' },
  { name: '--run', description: 'Treat the target as a workflow run record', type: 'enum' },
  { name: '--saved', description: 'Treat the target as a generated saved workflow capsule', type: 'enum' },
];

const WORKFLOW_SAVED_FILE_SUFFIXES = ['.workflow.json', '.ts', '.mjs', '.js'] as const;

function workflowRunMatchesSubcommand(subcommand: string, status: string): boolean {
  switch (subcommand) {
    case 'pause':
      return status === 'running';
    case 'resume':
      return status === 'paused';
    case 'stop':
      return status === 'running' || status === 'paused';
    case 'delete':
      return status !== 'running' && status !== 'paused';
    case 'show':
    case 'rerun':
    case 'save':
    default:
      return true;
  }
}

function isWorkflowRunEntryName(value: string): boolean {
  return (
    /^[a-zA-Z0-9._-]{1,120}$/.test(value) &&
    !value.startsWith('.') &&
    !value.includes('..')
  );
}

interface WorkflowRunArgumentCandidate {
  readonly arg: ArgumentDefinition;
  readonly endedAt: number;
}

function readWorkflowRunDisplayName(runDir: string, record: Record<string, unknown>): string | undefined {
  const metadataPath = join(runDir, 'workflow-metadata.json');
  if (existsSync(metadataPath)) {
    try {
      const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as unknown;
      if (typeof metadata === 'object' && metadata !== null) {
        const displayName = (metadata as Record<string, unknown>).displayName;
        if (typeof displayName === 'string' && isWorkflowRunEntryName(displayName.trim())) {
          return displayName.trim();
        }
      }
    } catch {
      // Ignore malformed metadata; run id completion remains available.
    }
  }
  const displayName = record.displayName;
  return typeof displayName === 'string' && isWorkflowRunEntryName(displayName.trim())
    ? displayName.trim()
    : undefined;
}

function getPersistedWorkflowRunIdArgs(): ArgumentDefinition[] {
  const projectKey = deriveProjectKeyFromRoot(process.cwd()).key;
  const baseDir = getAgentConfigPath('workflow-runs', projectKey);
  if (!existsSync(baseDir)) return [];

  const candidates: WorkflowRunArgumentCandidate[] = [];
  for (const entry of readdirSync(baseDir)) {
    if (!isWorkflowRunEntryName(entry)) continue;
    const runJsonPath = join(baseDir, entry, 'run.json');
    if (!existsSync(runJsonPath)) continue;
    try {
      const data = JSON.parse(readFileSync(runJsonPath, 'utf8')) as Record<string, unknown>;
      const workflow = typeof data.workflow === 'string' ? data.workflow : '?';
      const status = typeof data.status === 'string' ? data.status : '?';
      const endedAt = typeof data.endedAt === 'number' ? data.endedAt : 0;
      candidates.push({
        arg: {
          name: entry,
          description: `${workflow} - ${status}`,
          type: 'string',
        },
        endedAt,
      });
      const displayName = readWorkflowRunDisplayName(join(baseDir, entry), data);
      if (displayName && displayName !== entry) {
        candidates.push({
          arg: {
            name: displayName,
            description: `${workflow} alias for ${entry} - ${status}`,
            type: 'string',
          },
          endedAt,
        });
      }
    } catch {
      // Malformed persisted runs should not break command completion.
    }
  }

  return candidates
    .sort((a, b) => b.endedAt - a.endedAt)
    .map((candidate) => candidate.arg);
}

function getWorkflowRunIdArgs(subcommand: string): ArgumentDefinition[] {
  const activeArgs = getDefaultWorkflowRunManager()
    .list()
    .filter((run) => workflowRunMatchesSubcommand(subcommand, run.status))
    .map((run) => ({
      name: run.runId,
      description: `${run.workflow} - ${run.status}`,
      type: 'string' as const,
    }));
  const persistedArgs = WORKFLOW_PERSISTED_RUN_ID_SUBCOMMANDS.has(subcommand)
    ? getPersistedWorkflowRunIdArgs()
    : [];
  const seen = new Set<string>();
  return [...activeArgs, ...persistedArgs].filter((arg) => {
    if (seen.has(arg.name)) return false;
    seen.add(arg.name);
    return true;
  });
}

function savedWorkflowNameFromFile(entry: string): string | undefined {
  for (const suffix of WORKFLOW_SAVED_FILE_SUFFIXES) {
    if (entry.endsWith(suffix)) {
      const name = entry.slice(0, -suffix.length);
      return isWorkflowRunEntryName(name) ? name : undefined;
    }
  }
  return undefined;
}

function getSavedWorkflowNameArgs(
  options: { readonly generatedOnly?: boolean } = {},
): ArgumentDefinition[] {
  const dirs = [
    { path: getAgentConfigPath('workflows'), source: 'personal' },
    { path: join(process.cwd(), '.kodax', 'workflows'), source: 'project' },
  ] as const;
  const byName = new Map<string, ArgumentDefinition>();

  for (const dir of dirs) {
    if (!existsSync(dir.path)) continue;
    try {
      for (const entry of readdirSync(dir.path)) {
        if (options.generatedOnly === true && !entry.endsWith('.workflow.json')) continue;
        const name = savedWorkflowNameFromFile(entry);
        if (!name) continue;
        byName.set(name, {
          name,
          description: `${dir.source} saved workflow`,
          type: 'enum',
        });
      }
    } catch {
      // Saved workflow discovery should never break command completion.
    }
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function getWorkflowRerunArgs(): ArgumentDefinition[] {
  const byName = new Map<string, ArgumentDefinition>();
  for (const arg of getWorkflowRunIdArgs('rerun')) {
    byName.set(arg.name, {
      ...arg,
      description: `recent run: ${arg.description}`,
      type: 'string',
    });
  }
  for (const arg of getSavedWorkflowNameArgs()) {
    const existing = byName.get(arg.name);
    if (existing) {
      byName.set(arg.name, {
        ...existing,
        description: `${existing.description}; also ${arg.description}`,
      });
      continue;
    }
    byName.set(arg.name, {
      ...arg,
      description: arg.description,
      type: 'string',
    });
  }
  return [...byName.values()];
}

function getWorkflowRunOrSavedNameArgs(subcommand: string): ArgumentDefinition[] {
  const byName = new Map<string, ArgumentDefinition>();
  for (const arg of getWorkflowRunIdArgs(subcommand)) {
    byName.set(arg.name, {
      ...arg,
      description: `workflow run: ${arg.description}`,
      type: 'string',
    });
  }
  for (const arg of getSavedWorkflowNameArgs({ generatedOnly: subcommand === 'delete' })) {
    const existing = byName.get(arg.name);
    if (existing) {
      byName.set(arg.name, {
        ...existing,
        description: `${existing.description}; also ${arg.description}`,
      });
      continue;
    }
    byName.set(arg.name, {
      ...arg,
      description: arg.description,
      type: 'string',
    });
  }
  return [...byName.values()];
}

function getWorkflowDeleteTargetArgs(argParts: readonly string[]): ArgumentDefinition[] {
  const flags = new Set(argParts.slice(1).filter((arg) => arg.startsWith("--")));
  if (flags.has("--saved")) {
    return getSavedWorkflowNameArgs({ generatedOnly: true });
  }
  if (flags.has("--run")) {
    return getWorkflowRunIdArgs("delete");
  }
  return getWorkflowRunOrSavedNameArgs("delete");
}

function getWorkflowArgs(argParts: string[]): ArgumentDefinition[] {
  const [subcommand = ''] = argParts;
  const normalizedSubcommand = subcommand.toLowerCase();
  const effectiveLength = argParts.length === 1 && argParts[0] === '' ? 0 : argParts.length;

  if (effectiveLength <= 1) {
    return [
      ...WORKFLOW_SUBCOMMAND_ARGS,
      ...listBuiltinWorkflows().map((workflow) => ({
        name: workflow.name,
        description: workflow.description,
        type: 'enum' as const,
      })),
      ...getSavedWorkflowNameArgs(),
    ];
  }

  if (normalizedSubcommand === 'rerun' && effectiveLength <= 2) {
    return getWorkflowRerunArgs();
  }

  if (normalizedSubcommand === 'rename' && effectiveLength <= 2) {
    return getWorkflowRunOrSavedNameArgs('rename');
  }

  if (normalizedSubcommand === 'delete' && effectiveLength <= 2) {
    return [
      ...WORKFLOW_DELETE_OPTION_ARGS,
      ...getWorkflowDeleteTargetArgs(argParts),
    ];
  }

  if (
    normalizedSubcommand === 'delete'
    && effectiveLength <= 3
    && argParts.slice(1).some((arg) => arg.startsWith("--"))
  ) {
    return getWorkflowDeleteTargetArgs(argParts);
  }

  if (normalizedSubcommand === 'revise') {
    if (effectiveLength <= 2) {
      return [
        { name: '--replace', description: 'Replace a saved workflow after confirmation', type: 'enum' },
        ...getWorkflowRunOrSavedNameArgs('revise'),
      ];
    }
    if (argParts[1] === '--replace' && effectiveLength <= 3) {
      return getSavedWorkflowNameArgs();
    }
  }

  if (WORKFLOW_RUN_ID_SUBCOMMANDS.has(normalizedSubcommand) && effectiveLength <= 2) {
    return getWorkflowRunIdArgs(normalizedSubcommand);
  }

  if (normalizedSubcommand === 'runs' && effectiveLength <= 2) {
    return WORKFLOW_RUNS_OPTION_ARGS;
  }

  if (normalizedSubcommand === 'prune' && effectiveLength <= 2) {
    return WORKFLOW_PRUNE_OPTION_ARGS;
  }

  return [];
}

function getRepoIntelArgs(argParts: string[]): ArgumentDefinition[] {
  const [subcommand = ''] = argParts;
  const normalizedSubcommand = subcommand.toLowerCase();
  const effectiveLength = argParts.length === 1 && argParts[0] === '' ? 0 : argParts.length;

  if (effectiveLength <= 1) {
    return REPO_INTEL_SUBCOMMAND_ARGS;
  }

  if (effectiveLength > 2) {
    return [];
  }

  if (normalizedSubcommand === 'mode') {
    return REPO_INTEL_MODE_ARGS;
  }

  if (normalizedSubcommand === 'trace') {
    return REPO_INTEL_TRACE_ARGS;
  }

  return [];
}

/**
 * Global command arguments registry
 * 全局命令参数注册表
 */
export const COMMAND_ARGUMENTS: CommandArgumentsRegistry = new Map([
  ['mode', MODE_ARGS],
  ['thinking', REASONING_EFFORT_ARGS],
  ['think', REASONING_EFFORT_ARGS], // alias
  ['t', REASONING_EFFORT_ARGS], // alias
  ['reasoning', REASONING_EFFORT_ARGS],
  ['reason', REASONING_EFFORT_ARGS],
  ['effort', REASONING_EFFORT_ARGS],
  // 'model', 'm', and 'provider' handled dynamically in getCommandArguments()
  ['status', STATUS_ARGS],
  ['info', STATUS_ARGS],
  ['ctx', STATUS_ARGS],
  ['mcp', MCP_ARGS],
  ['fallback', FALLBACK_ARGS],
  ['agent-mode', AGENT_MODE_ARGS],
  ['am', AGENT_MODE_ARGS],
  ['verifier-log', TOGGLE_ARGS],
  ['stall-log', TOGGLE_ARGS],
  ['memory', MEMORY_ARGS],
  ['goal', GOAL_ARGS],
  ['paste', PASTE_ARGS],
  ['review', REVIEW_ARGS],
  ['agents', AGENTS_ARGS],
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
const MODEL_COMMAND_NAMES = new Set(['model', 'm', 'provider']);
const REPO_INTEL_COMMAND_NAMES = new Set(['repo-intel']);
const LEGACY_REPOINTEL_COMMAND_NAMES = new Set(['repointel', 'ri']);
const WORKFLOW_COMMAND_NAMES = new Set(['workflow']);
const LEARN_COMMAND_NAMES = new Set(['learn']);

export function getCommandArguments(commandName: string, partial?: string, argParts: string[] = []): ArgumentDefinition[] {
  const key = commandName.toLowerCase();
  if (MODEL_COMMAND_NAMES.has(key)) {
    return getModelArgs(partial);
  }
  if (REPO_INTEL_COMMAND_NAMES.has(key)) {
    return getRepoIntelArgs(argParts);
  }
  if (LEGACY_REPOINTEL_COMMAND_NAMES.has(key)) {
    return argParts.length <= 1 ? LEGACY_REPOINTEL_SUBCOMMAND_ARGS : [];
  }
  if (WORKFLOW_COMMAND_NAMES.has(key)) {
    return getWorkflowArgs(argParts);
  }
  if (LEARN_COMMAND_NAMES.has(key)) {
    return getLearnArgs(argParts);
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
