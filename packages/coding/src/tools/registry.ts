import type { KodaXToolDefinition } from '@kodax/ai';
import type { KodaXToolExecutionContext } from '../types.js';
import type {
  LocalToolDefinition,
  RegisteredToolDefinition,
  ToolDefinitionSource,
  ToolHandler,
  ToolRegistry,
  ToolRegistrationOptions,
} from './types.js';
import { toolRead } from './read.js';
import { toolWrite } from './write.js';
import { toolEdit } from './edit.js';
import { toolInsertAfterAnchor } from './insert-after-anchor.js';
import { toolBash } from './bash.js';
import { toolGlob } from './glob.js';
import { toolGrep } from './grep.js';
import { toolUndo } from './undo.js';
import { toolAskUserQuestion } from './ask-user-question.js';
import { toolRepoOverview } from './repo-overview.js';
import { toolChangedScope } from './changed-scope.js';
import { toolChangedDiff, toolChangedDiffBundle } from './changed-diff.js';
import { toolModuleContext } from './module-context.js';
import { toolSymbolContext } from './symbol-context.js';
import { toolProcessContext } from './process-context.js';
import { toolImpactEstimate } from './impact-estimate.js';
import { toolEmitManagedProtocol } from './emit-managed-protocol.js';
import { toolWebSearch } from './web-search.js';
import { toolWebFetch } from './web-fetch.js';
import { toolCodeSearch } from './code-search.js';
import { toolSemanticLookup } from './semantic-lookup.js';
import { toolMcpSearch } from './mcp-search.js';
import { toolMcpDescribe } from './mcp-describe.js';
import { toolMcpCall } from './mcp-call.js';
import { toolMcpReadResource } from './mcp-read-resource.js';
import { toolMcpGetPrompt } from './mcp-get-prompt.js';
import { toolWorktreeCreate, toolWorktreeRemove } from './worktree.js';

const TOOL_REGISTRY: ToolRegistry = new Map();
let nextToolRegistrationId = 0;

export const REPO_INTELLIGENCE_WORKING_TOOL_NAMES = [
  'repo_overview',
  'changed_scope',
  'changed_diff',
  'changed_diff_bundle',
  'module_context',
  'symbol_context',
  'process_context',
  'impact_estimate',
] as const;

const REPO_INTELLIGENCE_WORKING_TOOL_NAME_SET = new Set<string>(
  REPO_INTELLIGENCE_WORKING_TOOL_NAMES,
);

export const MCP_TOOL_NAMES = [
  'mcp_search',
  'mcp_describe',
  'mcp_call',
  'mcp_read_resource',
  'mcp_get_prompt',
] as const;

const MCP_TOOL_NAME_SET = new Set<string>(MCP_TOOL_NAMES);

function extractRequiredParams(
  inputSchema: KodaXToolDefinition['input_schema'] | undefined,
): string[] {
  if (
    !inputSchema
    || typeof inputSchema !== 'object'
    || !('required' in inputSchema)
    || !Array.isArray(inputSchema.required)
  ) {
    return [];
  }

  return inputSchema.required.filter(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  );
}

function toToolDefinition(definition: RegisteredToolDefinition): KodaXToolDefinition {
  const { handler: _handler, registrationId: _registrationId, requiredParams: _requiredParams, source: _source, ...tool } = definition;
  return tool;
}

function getActiveToolRegistration(name: string): RegisteredToolDefinition | undefined {
  const registrations = TOOL_REGISTRY.get(name);
  if (!registrations || registrations.length === 0) {
    return undefined;
  }
  return registrations[registrations.length - 1];
}

function removeToolRegistration(registrationId: string): void {
  for (const [name, registrations] of TOOL_REGISTRY) {
    const nextRegistrations = registrations.filter(
      (registration) => registration.registrationId !== registrationId,
    );

    if (nextRegistrations.length === registrations.length) {
      continue;
    }

    if (nextRegistrations.length === 0) {
      TOOL_REGISTRY.delete(name);
    } else {
      TOOL_REGISTRY.set(name, nextRegistrations);
    }
    return;
  }
}

function registerToolInternal(
  definition: LocalToolDefinition,
  options: ToolRegistrationOptions = {},
): () => void {
  const registrationId = `tool:${++nextToolRegistrationId}`;
  const source: ToolDefinitionSource = options.source ?? {
    kind: 'extension',
    id: registrationId,
    label: definition.name,
  };

  const registration: RegisteredToolDefinition = {
    ...definition,
    registrationId,
    requiredParams: extractRequiredParams(definition.input_schema),
    source,
  };

  const existing = TOOL_REGISTRY.get(definition.name) ?? [];
  TOOL_REGISTRY.set(definition.name, [...existing, registration]);

  return () => {
    removeToolRegistration(registrationId);
  };
}

const BUILTIN_TOOL_DEFINITIONS: LocalToolDefinition[] = [
  {
    name: 'read',
    description: 'Read a text file with bounded output. Large files are capped per call; use offset/limit to continue in smaller slices.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The absolute path to the file' },
        offset: { type: 'number', description: 'Line number to start from' },
        limit: { type: 'number', description: 'Number of lines to read' },
      },
      required: ['path'],
    },
    handler: toolRead,
  },
  {
    name: 'write',
    description: 'Write content to a file. Large diffs may be summarized in the tool result.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The absolute path to the file' },
        content: { type: 'string', description: 'The content to write' },
      },
      required: ['path', 'content'],
    },
    handler: toolWrite,
  },
  {
    name: 'edit',
    description: 'Perform safe exact-or-normalized string replacement in a file. If the anchor is unstable, retry with a smaller unique snippet instead of rewriting the whole file.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The file to edit' },
        old_string: { type: 'string', description: 'The text to replace' },
        new_string: { type: 'string', description: 'The replacement text' },
        replace_all: { type: 'boolean', description: 'Replace all occurrences' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
    handler: toolEdit,
  },
  {
    name: 'insert_after_anchor',
    description: 'Insert content after a unique anchor without rewriting the whole file. Prefer this for appending new sections to existing docs or configs.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The file to update' },
        anchor: { type: 'string', description: 'A unique heading or nearby marker to insert after' },
        content: { type: 'string', description: 'The content to insert after the anchor' },
      },
      required: ['path', 'anchor', 'content'],
    },
    handler: toolInsertAfterAnchor,
  },
  {
    name: 'bash',
    description: 'Execute a shell command. Large output may be truncated to the most relevant tail.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to execute' },
        timeout: { type: 'number', description: 'Timeout in seconds' },
      },
      required: ['command'],
    },
    handler: toolBash,
  },
  {
    name: 'glob',
    description: 'Find files matching a pattern.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'The glob pattern' },
        path: { type: 'string', description: 'Directory to search' },
      },
      required: ['pattern'],
    },
    handler: toolGlob,
  },
  {
    name: 'grep',
    description: 'Search for a pattern in files. Large result sets may be truncated; narrow the pattern or path when needed.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'The regex pattern' },
        path: { type: 'string', description: 'File or directory to search' },
        ignore_case: { type: 'boolean', description: 'Case insensitive search' },
        output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'] },
      },
      required: ['pattern', 'path'],
    },
    handler: toolGrep,
  },
  {
    name: 'emit_managed_protocol',
    description: 'Internal-only managed-task protocol side-channel for scout/planner/handoff/verdict payloads.',
    input_schema: {
      type: 'object',
      properties: {
        role: {
          type: 'string',
          enum: ['scout', 'planner', 'generator', 'evaluator'],
          description: 'Managed worker role emitting a structured protocol payload',
        },
        payload: {
          type: 'object',
          description: 'Role-specific structured protocol payload',
        },
      },
      required: ['role', 'payload'],
    },
    handler: toolEmitManagedProtocol,
  },
  {
    name: 'web_search',
    description: 'Search the web for discovery-oriented results with explicit trust and freshness signaling.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query to run' },
        limit: { type: 'number', description: 'Maximum number of search results to return' },
        provider_id: { type: 'string', description: 'Optional extension capability provider id for provider-backed search' },
      },
      required: ['query'],
    },
    handler: toolWebSearch,
  },
  {
    name: 'web_fetch',
    description: 'Fetch a specific remote source and return bounded text with provenance and trust hints.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Remote URL to fetch' },
        provider_id: { type: 'string', description: 'Optional extension capability provider id for provider-backed fetch' },
        capability_id: { type: 'string', description: 'Optional provider capability id for provider-backed fetch' },
      },
    },
    handler: toolWebFetch,
  },
  {
    name: 'code_search',
    description: 'Search local repository code with lower-noise output than ad hoc shell grep.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'String query to search for' },
        path: { type: 'string', description: 'Optional file or directory scope for the search' },
        limit: { type: 'number', description: 'Maximum number of matches to return' },
        case_sensitive: { type: 'boolean', description: 'Whether the query should be matched case-sensitively' },
        provider_id: { type: 'string', description: 'Optional extension capability provider id for provider-backed code search' },
      },
      required: ['query'],
    },
    handler: toolCodeSearch,
  },
  {
    name: 'semantic_lookup',
    description: 'Search repository intelligence for symbol-, module-, or process-aware semantic matches.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Semantic query to resolve inside repository intelligence' },
        kind: {
          type: 'string',
          enum: ['auto', 'symbol', 'module', 'process'],
          description: 'Optional semantic lookup category',
        },
        target_path: { type: 'string', description: 'Optional path hint to scope the semantic lookup' },
        limit: { type: 'number', description: 'Maximum number of semantic matches to return' },
        refresh: { type: 'boolean', description: 'When true, refresh repository intelligence before searching' },
      },
      required: ['query'],
    },
    handler: toolSemanticLookup,
  },
  {
    name: 'mcp_search',
    description: 'Search active MCP tools, resources, and prompts through the shared capability runtime.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query to run against active MCP catalogs' },
        server: { type: 'string', description: 'Optional MCP server id filter' },
        kind: {
          type: 'string',
          enum: ['tool', 'resource', 'prompt'],
          description: 'Optional MCP capability family filter',
        },
        limit: { type: 'number', description: 'Maximum number of search results to return' },
      },
      required: ['query'],
    },
    handler: toolMcpSearch,
  },
  {
    name: 'mcp_describe',
    description: 'Describe a specific MCP capability by id, including schemas, trust, and provenance.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'MCP capability id from mcp_search' },
      },
      required: ['id'],
    },
    handler: toolMcpDescribe,
  },
  {
    name: 'mcp_call',
    description: 'Invoke an MCP tool capability by id with structured arguments.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'MCP tool capability id from mcp_search' },
        args: {
          type: 'object',
          description: 'Structured arguments for the MCP tool call',
        },
      },
      required: ['id'],
    },
    handler: toolMcpCall,
  },
  {
    name: 'mcp_read_resource',
    description: 'Read an MCP resource capability by id.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'MCP resource capability id from mcp_search' },
      },
      required: ['id'],
    },
    handler: toolMcpReadResource,
  },
  {
    name: 'mcp_get_prompt',
    description: 'Retrieve an MCP prompt capability by id with optional arguments.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'MCP prompt capability id from mcp_search' },
        args: {
          type: 'object',
          description: 'Optional arguments for the MCP prompt',
        },
      },
      required: ['id'],
    },
    handler: toolMcpGetPrompt,
  },
  {
    name: 'worktree_create',
    description: 'Create a new git worktree with an isolated branch for safe agent work.',
    input_schema: {
      type: 'object',
      properties: {
        branch_name: { type: 'string', description: 'Optional explicit branch name' },
        description: { type: 'string', description: 'Optional description to auto-generate branch name from' },
      },
    },
    handler: toolWorktreeCreate,
  },
  {
    name: 'worktree_remove',
    description: 'Remove a git worktree and optionally its branch.',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['keep', 'remove'],
          description: 'Whether to keep or remove the worktree directory and branch',
        },
        worktree_path: { type: 'string', description: 'Absolute path to the worktree directory' },
        discard_changes: {
          type: 'boolean',
          description: 'If true, bypass safety checks for uncommitted changes or local commits',
        },
      },
      required: ['action', 'worktree_path'],
    },
    handler: toolWorktreeRemove,
  },
  {
    name: 'undo',
    description: 'Revert the last file modification.',
    input_schema: { type: 'object', properties: {} },
    handler: toolUndo,
  },
  {
    name: 'ask_user_question',
    description: 'Ask the user a question. Supports single-select (default), multi-select, or free-text input. Use this when you need the user to make a decision or provide input.',
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question to ask the user' },
        kind: {
          type: 'string',
          enum: ['select', 'input'],
          description: 'Interaction kind. "select" (default) shows options for the user to pick from. "input" shows a free-text prompt for the user to type anything. Use "input" when the user needs to provide an open-ended answer (e.g. step combinations like "1,3,5", version numbers, custom text).',
        },
        options: {
          type: 'array',
          description: 'Available options for the user to choose from. Required for kind="select", ignored for kind="input".',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'Display label for this option' },
              description: { type: 'string', description: 'Optional description of this option' },
              value: { type: 'string', description: 'Optional value to return (defaults to label)' },
            },
            required: ['label'],
          },
        },
        multi_select: {
          type: 'boolean',
          description: 'Allow the user to select multiple options (space to toggle, enter to confirm). Only applies to kind="select". Returns comma-separated values.',
        },
        default: { type: 'string', description: 'Optional default choice (for select) or default text (for input)' },
        intent: {
          type: 'string',
          enum: ['generic', 'plan-handoff'],
          description: 'Optional ask intent. Use "plan-handoff" only after the plan is complete and you need permission to continue in accept-edits mode.',
        },
        target_mode: {
          type: 'string',
          enum: ['accept-edits'],
          description: 'Target permission mode for a plan handoff request.',
        },
        scope: {
          type: 'string',
          enum: ['session'],
          description: 'Scope of the permission change. Only session scope is supported.',
        },
        resume_behavior: {
          type: 'string',
          enum: ['continue'],
          description: 'Whether execution should continue immediately after approval.',
        },
      },
      required: ['question'],
    },
    handler: toolAskUserQuestion,
  },
  {
    name: 'repo_overview',
    description: 'Summarize the repository structure, key areas, entry hints, and stored repo-intelligence snapshot for the current workspace.',
    input_schema: {
      type: 'object',
      properties: {
        target_path: { type: 'string', description: 'Optional path inside the workspace to resolve the repository root from' },
        refresh: { type: 'boolean', description: 'When true, rebuild the repo overview snapshot before returning it' },
      },
    },
    handler: toolRepoOverview,
  },
  {
    name: 'changed_scope',
    description: 'Analyze which files, areas, and categories are touched by the current git diff or a comparison range.',
    input_schema: {
      type: 'object',
      properties: {
        target_path: { type: 'string', description: 'Optional path inside the workspace to resolve the repository root from' },
        scope: {
          type: 'string',
          enum: ['unstaged', 'staged', 'all', 'compare'],
          description: 'Which git change set to inspect. Defaults to all.',
        },
        base_ref: { type: 'string', description: 'Base ref used when scope=compare. Defaults to HEAD~1.' },
        refresh_overview: { type: 'boolean', description: 'When true, rebuild the repo overview snapshot before analyzing changes' },
      },
    },
    handler: toolChangedScope,
  },
  {
    name: 'changed_diff',
    description: 'Read a paged diff slice for a specific changed file. Prefer this over broad git diff output during large reviews.',
    input_schema: {
      type: 'object',
      properties: {
        target_path: { type: 'string', description: 'Optional path inside the workspace to resolve the repository root from' },
        base_ref: { type: 'string', description: 'Optional base git ref for compare-range review' },
        target_ref: { type: 'string', description: 'Optional target git ref for compare-range review (defaults to HEAD when base_ref is provided)' },
        path: { type: 'string', description: 'Changed file path to inspect, relative to the workspace root or absolute inside it' },
        offset: { type: 'number', description: '1-based diff line offset for pagination' },
        limit: { type: 'number', description: 'Maximum diff lines to return in this slice' },
        context_lines: { type: 'number', description: 'Unified diff context lines to request' },
      },
      required: ['path'],
    },
    handler: toolChangedDiff,
  },
  {
    name: 'changed_diff_bundle',
    description: 'Read diff slices for multiple changed files in one call. Prefer this for large reviews before drilling down with changed_diff.',
    input_schema: {
      type: 'object',
      properties: {
        target_path: { type: 'string', description: 'Optional path inside the workspace to resolve the repository root from' },
        base_ref: { type: 'string', description: 'Optional base git ref for compare-range review' },
        target_ref: { type: 'string', description: 'Optional target git ref for compare-range review (defaults to HEAD when base_ref is provided)' },
        paths: {
          type: 'array',
          description: 'Changed file paths to inspect in one bundle, relative to the workspace root or absolute inside it',
          items: { type: 'string' },
        },
        offset: { type: 'number', description: '1-based diff line offset applied to each path in the bundle' },
        limit_per_path: { type: 'number', description: 'Maximum diff lines to return per path in this bundle' },
        context_lines: { type: 'number', description: 'Unified diff context lines to request' },
      },
      required: ['paths'],
    },
    handler: toolChangedDiffBundle,
  },
  {
    name: 'module_context',
    description: 'Return a task-shaped module capsule with dependencies, entry files, symbols, tests, docs, and follow-up handles.',
    input_schema: {
      type: 'object',
      properties: {
        module: { type: 'string', description: 'Module id, label, or package name to inspect' },
        target_path: { type: 'string', description: 'Optional path used to infer the enclosing module' },
        refresh: { type: 'boolean', description: 'When true, rebuild repo intelligence before returning the module capsule' },
      },
    },
    handler: toolModuleContext,
  },
  {
    name: 'symbol_context',
    description: 'Return definition, probable callers/callees, imports, and alternatives for a repository symbol.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'The symbol name to inspect' },
        module: { type: 'string', description: 'Optional module hint to disambiguate the symbol search' },
        target_path: { type: 'string', description: 'Optional path inside the workspace to resolve the repository root from' },
        refresh: { type: 'boolean', description: 'When true, rebuild repo intelligence before returning the symbol capsule' },
      },
    },
    handler: toolSymbolContext,
  },
  {
    name: 'process_context',
    description: 'Return an approximate static execution/process capsule for an entry symbol, module, or path.',
    input_schema: {
      type: 'object',
      properties: {
        entry: { type: 'string', description: 'Entry symbol or file hint for the process to trace' },
        module: { type: 'string', description: 'Optional module hint used to select a process capsule' },
        target_path: { type: 'string', description: 'Optional path used to infer the relevant module or entry file' },
        refresh: { type: 'boolean', description: 'When true, rebuild repo intelligence before returning the process capsule' },
      },
    },
    handler: toolProcessContext,
  },
  {
    name: 'impact_estimate',
    description: 'Estimate blast radius for a symbol, path, or module using local intelligence plus changed-scope overlap.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Optional symbol to estimate impact for' },
        module: { type: 'string', description: 'Optional module to estimate impact for' },
        path: { type: 'string', description: 'Optional repository-relative or absolute path to estimate impact for' },
        target_path: { type: 'string', description: 'Optional path used to resolve the repository root from' },
        refresh: { type: 'boolean', description: 'When true, rebuild repo intelligence before returning the impact estimate' },
      },
    },
    handler: toolImpactEstimate,
  },
];

for (const definition of BUILTIN_TOOL_DEFINITIONS) {
  registerToolInternal(definition, {
    source: {
      kind: 'builtin',
      id: `builtin:${definition.name}`,
      label: definition.name,
    },
  });
}

export const KODAX_TOOLS: KodaXToolDefinition[] = BUILTIN_TOOL_DEFINITIONS.map((definition) => {
  const { handler: _handler, ...tool } = definition;
  return tool;
});

export function registerTool(
  definition: LocalToolDefinition,
  options: ToolRegistrationOptions = {},
): () => void {
  return registerToolInternal(definition, options);
}

export function getTool(name: string): ToolHandler | undefined {
  return getActiveToolRegistration(name)?.handler;
}

export function getToolDefinition(name: string): KodaXToolDefinition | undefined {
  const registration = getActiveToolRegistration(name);
  return registration ? toToolDefinition(registration) : undefined;
}

export function getRegisteredToolDefinition(name: string): RegisteredToolDefinition | undefined {
  return getActiveToolRegistration(name);
}

export function getToolRegistrations(name: string): RegisteredToolDefinition[] {
  return [...(TOOL_REGISTRY.get(name) ?? [])];
}

export function getBuiltinToolDefinition(name: string): KodaXToolDefinition | undefined {
  const definition = BUILTIN_TOOL_DEFINITIONS.find((entry) => entry.name === name);
  if (!definition) {
    return undefined;
  }
  const { handler: _handler, ...tool } = definition;
  return tool;
}

export function getBuiltinRegisteredToolDefinition(
  name: string,
): RegisteredToolDefinition | undefined {
  const definition = BUILTIN_TOOL_DEFINITIONS.find((entry) => entry.name === name);
  if (!definition) {
    return undefined;
  }

  return {
    ...definition,
    registrationId: `builtin:${definition.name}`,
    requiredParams: extractRequiredParams(definition.input_schema),
    source: {
      kind: 'builtin',
      id: `builtin:${definition.name}`,
      label: definition.name,
    },
  };
}

export function createBuiltinToolDefinition(
  name: string,
): LocalToolDefinition | undefined {
  const definition = BUILTIN_TOOL_DEFINITIONS.find((entry) => entry.name === name);
  if (!definition) {
    return undefined;
  }
  return {
    ...definition,
    input_schema: definition.input_schema
      ? JSON.parse(JSON.stringify(definition.input_schema))
      : definition.input_schema,
  };
}

export function listBuiltinToolDefinitions(): RegisteredToolDefinition[] {
  return BUILTIN_TOOL_DEFINITIONS.map((definition) => ({
    ...definition,
    registrationId: `builtin:${definition.name}`,
    requiredParams: extractRequiredParams(definition.input_schema),
    source: {
      kind: 'builtin',
      id: `builtin:${definition.name}`,
      label: definition.name,
    },
  }));
}

export function getRequiredToolParams(name: string): string[] {
  return getActiveToolRegistration(name)?.requiredParams ?? [];
}

export function listTools(): string[] {
  return Array.from(TOOL_REGISTRY.keys())
    .filter((name) => getActiveToolRegistration(name) !== undefined)
    .sort((left, right) => left.localeCompare(right));
}

export function listToolDefinitions(): KodaXToolDefinition[] {
  return listTools()
    .map((name) => getToolDefinition(name))
    .filter((definition): definition is KodaXToolDefinition => definition !== undefined);
}

export function isRepoIntelligenceWorkingToolName(name: string): boolean {
  return REPO_INTELLIGENCE_WORKING_TOOL_NAME_SET.has(name);
}

export function filterRepoIntelligenceWorkingToolNames<T extends string>(
  toolNames: readonly T[],
): T[] {
  return toolNames.filter((name) => !isRepoIntelligenceWorkingToolName(name));
}

export function isMcpToolName(name: string): boolean {
  return MCP_TOOL_NAME_SET.has(name);
}

export function filterMcpToolNames<T extends string>(
  toolNames: readonly T[],
): T[] {
  return toolNames.filter((name) => !isMcpToolName(name));
}

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  ctx: KodaXToolExecutionContext,
): Promise<string> {
  const definition = getRegisteredToolDefinition(name);
  if (!definition) {
    return `[Tool Error] Unknown tool: ${name}. Available tools: ${listTools().join(', ')}`;
  }

  const missing = definition.requiredParams.filter(
    (param) => input[param] === undefined || input[param] === null,
  );
  if (missing.length > 0) {
    return `[Tool Error] ${name}: Missing required parameter(s): ${missing.join(', ')}`;
  }

  try {
    return await definition.handler(input, ctx);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    if (errorMsg.includes('ENOENT')) {
      return `[Tool Error] ${name}: File or directory not found`;
    }
    if (errorMsg.includes('EACCES') || errorMsg.includes('EPERM')) {
      return `[Tool Error] ${name}: Permission denied`;
    }
    if (errorMsg.includes('ENOSPC')) {
      return `[Tool Error] ${name}: No space left on device`;
    }
    return `[Tool Error] ${name}: ${errorMsg}`;
  }
}
