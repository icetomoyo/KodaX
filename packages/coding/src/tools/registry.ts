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
import {
  defaultToClassifierInput,
  mcpToClassifierInput,
} from './classifier-projection.js';
import { toolRead } from './read.js';
import { toolWrite } from './write.js';
import { toolEdit } from './edit.js';
import { toolMultiEdit } from './multi-edit.js';
import { toolInsertAfterAnchor } from './insert-after-anchor.js';
import { toolBash } from './bash.js';
import { toolGlob } from './glob.js';
import { toolGrep } from './grep.js';
import { toolUndo } from './undo.js';
import { toolAskUserQuestion } from './ask-user-question.js';
import { toolExitPlanMode } from './exit-plan-mode.js';
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
import { toolDispatchChildTask } from './dispatch-child-tasks.js';
import { toolTodoUpdate } from './todo-update.js';
import {
  toolScaffoldTool,
  toolValidateTool,
  toolStageConstruction,
  toolTestTool,
  toolActivateTool,
} from './construction.js';
import {
  toolScaffoldAgent,
  toolValidateAgent,
  toolStageAgentConstruction,
  toolTestAgent,
  toolActivateAgent,
} from './agent-construction.js';
import {
  toolStageSelfModify,
  SELF_MODIFY_TOOL_NAME,
} from './self-modify-tool.js';

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

/**
 * Classifier projection helper for `stage_*` construction tools whose input
 * is the artifact serialized as a JSON string. Parses opportunistically and
 * extracts `name@version` for the projection; falls back to "<unparseable>"
 * if the input is malformed (the classifier still sees the tool name as
 * context, so a parse failure is informative on its own).
 */
function stageArtifactPreview(artifactJson: string | undefined): string {
  if (typeof artifactJson !== 'string' || artifactJson.length === 0) {
    return '<no-artifact>';
  }
  try {
    const parsed = JSON.parse(artifactJson) as { name?: unknown; version?: unknown };
    const name = typeof parsed?.name === 'string' ? parsed.name : '<no-name>';
    const version = typeof parsed?.version === 'string' ? parsed.version : '<no-version>';
    return `${name}@${version}`;
  } catch {
    return '<unparseable>';
  }
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
    toClassifierInput: () => '',
  },
  {
    name: 'write',
    description:
      'Write a file to the local filesystem. Large diffs may be summarized in the tool result. '
      + 'ALWAYS prefer the `edit` tool over `write` when modifying an existing file — `edit` sends only the '
      + 'diff and avoids output-token pressure. Only use `write` to create new files or for a complete rewrite '
      + 'that the user explicitly asked for. '
      + 'For new files up to ~500 lines, call `write` directly. For files larger than that, use this two-step pattern: '
      + '(1) `write(path, skeleton)` — a structural skeleton with placeholder markers like `<!-- SECTION_A -->` or '
      + '`// === SECTION_A ===`, kept under ~300 lines; (2) one `edit(path, "<!-- SECTION_A -->", <real content>)` '
      + 'per section. Each edit streams reliably. '
      + 'NEVER fall back to `bash` (python/node heredoc, `echo >`, `cat > file <<EOF`) to generate a source file — '
      + 'it bypasses mutation tracking, loses diff visibility, and recurses the same streaming limit onto the generator '
      + 'script itself. If a `write` failed mid-stream, retry with a smaller skeleton, then `edit` each section. '
      + 'Encoding note: `write` calls Node `fs.writeFile(path, content, "utf-8")` — the content goes directly from your '
      + 'tool_use input to disk WITHOUT passing through any shell. There are NO "Windows shell encoding issues" for `write`. '
      + 'Do NOT switch to `python`/`bash` scripts to "avoid encoding problems" — UTF-8 (including Chinese / emoji / etc.) '
      + 'works correctly through `write` by default, and routing through a shell script adds encoding surface area '
      + 'rather than removing it.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The absolute path to the file' },
        content: { type: 'string', description: 'The content to write' },
      },
      required: ['path', 'content'],
    },
    handler: toolWrite,
    toClassifierInput: (input) => {
      const i = input as { path?: string; content?: string };
      const size = typeof i?.content === 'string' ? i.content.length : 0;
      return `Write ${i?.path ?? '<unknown>'} (${size} bytes)`;
    },
  },
  {
    name: 'edit',
    description:
      'Perform safe exact-or-normalized string replacement in a file. '
      + 'ALWAYS prefer editing an existing file with `edit` over rewriting the whole file with `write` — '
      + '`edit` only sends the diff, avoiding output-token pressure and mid-stream truncation on large files. '
      + 'REQUIREMENT: call `read` on this file at least once in the conversation BEFORE calling `edit`. '
      + 'If you skip the read, your `old_string` is almost certainly wrong and the edit will fail with an '
      + '"old_string not found" error — forcing a retry that costs more than the initial read. '
      + 'When making multiple independent edits to the same file, use `multi_edit` instead — one tool call '
      + 'batches N edits atomically. '
      + 'If the anchor is unstable, retry with a smaller unique snippet or use `insert_after_anchor`; '
      + 'do NOT fall back to `write` for the whole file as a recovery.',
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
    toClassifierInput: (input) => {
      const i = input as { path?: string; replace_all?: boolean };
      return `Edit ${i?.path ?? '<unknown>'}${i?.replace_all ? ' [replace_all]' : ''}`;
    },
  },
  {
    name: 'multi_edit',
    description:
      'Apply multiple exact-text replacements to a single file in ONE tool call. '
      + 'Prefer this over N separate `edit` calls when you have several independent edits '
      + 'to the same file — especially when filling in a skeleton you just created with `write`. '
      + 'REQUIREMENT: call `read` on this file at least once in the conversation BEFORE calling `multi_edit`. '
      + 'Skipping the read means your first failing `old_string` aborts the ENTIRE batch — '
      + 'you pay for all the edits in tokens but land none of them. '
      + 'Edits apply sequentially (each edit sees the result of the previous one), and the '
      + 'whole batch is ATOMIC: if any single old_string fails to match, NO edits are written '
      + 'to disk and you get back an index pointing at the failing edit. '
      + 'ANCHOR WARNING: edits compose — when edits[k] rewrites a region, text inside it stops '
      + 'being a valid anchor for edits[k+1..]. If later edits need to reference text an earlier '
      + 'edit overlaps, either shrink the earlier edit so it preserves that anchor, or merge them '
      + 'into one edit. '
      + 'UNIQUENESS RULE: each `old_string` must be unique in the WHOLE current file, not just in '
      + 'the window you last read. A short snippet from a narrow `read` (a single line, a 6-line '
      + 'window, a common phrase) is the #1 cause of "matched N places" errors. Widen the anchor '
      + 'with a nearby unique landmark (heading, function signature, distinctive comment, or a '
      + 'multi-line block), or set `replace_all: true` if every occurrence should change. '
      + 'Each `edits[i]` has the same semantics as one `edit` call — exact-match first, then '
      + 'safe-normalized anchor fallback; `replace_all: true` per edit for bulk renames. '
      + 'Typical skeleton-then-fill flow: '
      + '(1) `write(path, skeleton_with_<!-- SECTION_A -->_placeholders)`; '
      + '(2) `multi_edit(path, [{SECTION_A, realA}, {SECTION_B, realB}, ...])` — one batched call.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The absolute path to the file' },
        edits: {
          type: 'array',
          description: 'Sequence of edit operations to apply in order',
          items: {
            type: 'object',
            properties: {
              old_string: { type: 'string', description: 'The text to replace (matched exactly, then via normalized fallback)' },
              new_string: { type: 'string', description: 'The replacement text' },
              replace_all: { type: 'boolean', description: 'When true, replace every occurrence of old_string (defaults to false)' },
            },
            required: ['old_string', 'new_string'],
          },
        },
      },
      required: ['path', 'edits'],
    },
    handler: toolMultiEdit,
    toClassifierInput: (input) => {
      const i = input as { path?: string; edits?: unknown[] };
      const count = Array.isArray(i?.edits) ? i.edits.length : 0;
      return `MultiEdit ${i?.path ?? '<unknown>'}: ${count} edits`;
    },
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
    toClassifierInput: (input) => {
      const i = input as { path?: string; anchor?: string };
      const anchor = typeof i?.anchor === 'string' ? i.anchor.slice(0, 40) : '<no-anchor>';
      return `InsertAfterAnchor ${i?.path ?? '<unknown>'} after "${anchor}"`;
    },
  },
  {
    name: 'bash',
    description:
      'Execute a shell command. Use run_in_background for long-running commands. '
      + 'Large output may be truncated to the most relevant tail. '
      + 'When producing a SINGLE file whose content you already have, use the `write` / `edit` tools — '
      + 'do NOT route it through shell (no `cat > file <<EOF`, no `echo ... >`, no PowerShell `Set-Content` / '
      + '`Out-File`, no python/node heredoc). Shell redirection for a known-content file bypasses the mutation tracker, '
      + 'loses diff visibility to downstream verification, and re-encounters the same streaming limit on the generator '
      + 'script itself. Use a shell script ONLY when the output is computed (loops, templating over many files, data '
      + 'transformation of an input you are reading) — e.g. generating 50 similar test fixtures from a template is a '
      + 'legitimate script use; reproducing one hand-written HTML file you already have in memory is not. '
      + 'Appropriate uses of `bash`: tests, builds, lint, git, package managers, grep/ls/cat for inspection, '
      + 'process management, computed/templated multi-file generation.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to execute' },
        description: { type: 'string', description: 'Clear, concise description of what this command does' },
        timeout: { type: 'number', description: 'Timeout in seconds' },
        run_in_background: {
          type: 'boolean',
          description: 'Run command in background. Returns immediately with output file path. Use read tool to check output later.',
        },
      },
      required: ['command'],
    },
    handler: toolBash,
    toClassifierInput: (input) => {
      const i = input as { command?: string };
      return `Bash: ${typeof i?.command === 'string' ? i.command : '<no-command>'}`;
    },
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
    toClassifierInput: () => '',
  },
  {
    name: 'grep',
    description: 'Search for a regex pattern in file contents. Supports context lines, multiline matching, file type filtering, and pagination.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'The regex pattern to search for in file contents' },
        path: { type: 'string', description: 'File or directory to search in. Defaults to current working directory.' },
        glob: { type: 'string', description: 'Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}")' },
        type: { type: 'string', description: 'File type to search (e.g. js, ts, py, go, rust, java). More efficient than glob for standard types.' },
        output_mode: {
          type: 'string',
          enum: ['content', 'files_with_matches', 'count'],
          description: 'Output mode. "content" shows matching lines (default), "files_with_matches" shows file paths only, "count" shows match counts.',
        },
        ignore_case: { type: 'boolean', description: 'Case insensitive search (default false)' },
        '-i': { type: 'boolean', description: 'Alias for ignore_case' },
        '-A': { type: 'number', description: 'Number of lines to show after each match. Requires output_mode "content".' },
        '-B': { type: 'number', description: 'Number of lines to show before each match. Requires output_mode "content".' },
        '-C': { type: 'number', description: 'Alias for context' },
        context: { type: 'number', description: 'Number of lines to show before and after each match. Requires output_mode "content".' },
        multiline: { type: 'boolean', description: 'Enable multiline mode where . matches newlines and patterns can span lines. Default: false.' },
        head_limit: { type: 'number', description: 'Limit output to first N entries. Defaults to 250. Pass 0 for unlimited.' },
        offset: { type: 'number', description: 'Skip first N entries before applying head_limit. Defaults to 0.' },
      },
      required: ['pattern'],
    },
    handler: toolGrep,
    toClassifierInput: () => '',
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
    toClassifierInput: () => '',
  },
  {
    name: 'dispatch_child_task',
    description: 'Execute a single child agent for an independent sub-task. The child runs its own multi-turn investigation loop and returns findings. Call multiple times in parallel for concurrent sub-tasks — each call appears as a separate tool with its own status in the transcript.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Unique child task identifier' },
        objective: { type: 'string', description: 'Detailed multi-step goal for this child agent' },
        readOnly: { type: 'boolean', description: 'true=investigation only (default), false=code changes (Generator only)' },
        scope_summary: { type: 'string', description: 'Optional scope hint (e.g. "packages/ai/src/")' },
        evidence_refs: { type: 'array', items: { type: 'string' }, description: 'Optional known evidence: "file:path", "diff:path", or "finding:text"' },
        constraints: { type: 'array', items: { type: 'string' }, description: 'Optional constraints' },
      },
      required: ['objective'],
    },
    handler: toolDispatchChildTask,
    toClassifierInput: (input) => {
      const i = input as { objective?: string; readOnly?: boolean };
      const obj = typeof i?.objective === 'string' ? i.objective.slice(0, 200) : '<no-objective>';
      const mutability = i?.readOnly === false ? 'mutating' : 'readonly';
      return `Dispatch(${mutability}): ${obj}`;
    },
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
    toClassifierInput: () => '',
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
    toClassifierInput: (input) => {
      const i = input as { url?: string };
      return `WebFetch ${typeof i?.url === 'string' ? i.url : '<no-url>'}`;
    },
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
    toClassifierInput: () => '',
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
    // refresh: true rebuilds the repo-intel snapshot (disk side effect),
    // so this is not strictly Tier 1 — surface name + truncated input via
    // the helper so the classifier can see when refresh is requested.
    toClassifierInput: (input) => defaultToClassifierInput('semantic_lookup', input),
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
    toClassifierInput: () => '',
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
    toClassifierInput: () => '',
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
    toClassifierInput: (input) => {
      const i = input as { id?: string; args?: unknown };
      const capability = typeof i?.id === 'string' ? i.id : '<no-id>';
      // Capability id (from mcp_search) is the "server.tool" form already.
      // Split on the first '.' to recover the real server / tool pair so the
      // helper produces `MCP[server.tool]: …` (not `MCP[server.tool.call]`).
      const dotIdx = capability.indexOf('.');
      const server = dotIdx > 0 ? capability.slice(0, dotIdx) : capability;
      const tool = dotIdx > 0 ? capability.slice(dotIdx + 1) : '<no-tool>';
      return mcpToClassifierInput(server, tool, i?.args ?? {});
    },
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
    toClassifierInput: () => '',
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
    toClassifierInput: () => '',
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
    toClassifierInput: (input) => {
      const i = input as { branch_name?: string; description?: string };
      const branch = typeof i?.branch_name === 'string'
        ? i.branch_name
        : (typeof i?.description === 'string' ? `<auto from "${i.description.slice(0, 40)}">` : '<auto>');
      return `WorktreeCreate ${branch}`;
    },
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
    toClassifierInput: (input) => {
      const i = input as { action?: string; worktree_path?: string; discard_changes?: boolean };
      const flags = i?.discard_changes ? ' [discard_changes]' : '';
      return `WorktreeRemove ${i?.action ?? '<no-action>'} ${i?.worktree_path ?? '<no-path>'}${flags}`;
    },
  },
  {
    name: 'undo',
    description: 'Revert the last file modification.',
    input_schema: { type: 'object', properties: {} },
    handler: toolUndo,
    toClassifierInput: () => 'Undo: revert last file modification',
  },
  {
    name: 'ask_user_question',
    description: 'Ask the user a question. Supports single-select (default), multi-select, or free-text input. When you have multiple independent questions, use the "questions" array — each question is presented separately with its own options. Do NOT combine multiple questions into a single question string.',
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question to ask the user. Use this for a single question. For multiple independent questions, use the "questions" array instead.' },
        questions: {
          type: 'array',
          description: 'Multiple independent questions (1-4). Each question is presented separately with its own options. Use this instead of combining multiple questions into a single "question" string. Takes precedence over "question"+"options" when provided.',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string', description: 'The question text' },
              header: { type: 'string', description: 'Short label (max 12 chars) shown in progress indicator, e.g. "环境" or "Deploy"' },
              options: {
                type: 'array',
                description: 'Available options for this question.',
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
                description: 'Allow multiple selections for this question.',
              },
            },
            required: ['question', 'options'],
          },
          minItems: 1,
          maxItems: 4,
        },
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
      },
      required: ['question'],
    },
    handler: toolAskUserQuestion,
    toClassifierInput: () => '',
  },
  {
    name: 'exit_plan_mode',
    description: 'Exit plan mode by presenting the finalized plan to the user for approval. On approval, the session flips to accept-edits and implementation can proceed. On rejection, the session remains in plan mode so the plan can be revised. Use this tool once the plan is ready for user review — do NOT combine with set_permission_mode. Parent-only: requires an interactive approval UI (wired only in REPL sessions).',
    input_schema: {
      type: 'object',
      properties: {
        plan: {
          type: 'string',
          description: 'The finalized plan to present to the user. Include the full plan content, not a summary, so the user can make an informed approval decision. Keep the plan tight: at most 40 lines total, 3 bullet-depth levels, one sentence per bullet. If the plan exceeds this budget, split it into phases and present only the current phase — the user can approve phase-by-phase.',
        },
      },
      required: ['plan'],
    },
    handler: toolExitPlanMode,
    toClassifierInput: () => '',
  },
  {
    name: 'todo_update',
    description:
      'Update the status of a planned todo item so the user can see real-time progress on the visible plan checklist. Use this every time you start or finish a major step. Rules: ' +
      '(1) Set status="in_progress" BEFORE starting work on an item. ' +
      '(2) Set status="completed" AFTER finishing that item. ' +
      '(3) Only ONE item should be in_progress per owner at any time — finish or fail the current item before starting the next. ' +
      '(4) Use status="failed" if an attempt clearly failed and needs retry. ' +
      '(5) Use status="skipped" only when the item turned out to be unnecessary (e.g. Planner merged two obligations into one). ' +
      'If the call returns ok=false with reason "Unknown todo id", inspect the listed valid ids and retry with a correct one. ' +
      'If the call returns ok=false with reason "todo_update is not active", the current run has no plan list and you may continue working without further todo_update calls.',
    input_schema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The id of the todo item to update (e.g. "todo_3"). Must match a current valid id in the plan list.',
        },
        status: {
          type: 'string',
          enum: ['in_progress', 'completed', 'failed', 'skipped'],
          description: 'New status. "pending" is intentionally not allowed — items start as pending automatically and only the runner moves them back to pending after a revise verdict.',
        },
        note: {
          type: 'string',
          description: 'Optional free-text reason or detail. When omitted, any pre-existing note on the item is preserved.',
        },
      },
      required: ['id', 'status'],
    },
    handler: toolTodoUpdate,
    toClassifierInput: () => '',
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
    toClassifierInput: () => '',
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
    toClassifierInput: () => '',
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
    toClassifierInput: () => '',
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
    toClassifierInput: () => '',
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
    toClassifierInput: () => '',
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
    toClassifierInput: () => '',
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
    toClassifierInput: () => '',
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
    toClassifierInput: () => '',
  },
  // ====================================================================
  // Tool Construction (FEATURE_087 + FEATURE_088, v0.7.28)
  //
  // Five-step staircase the LLM walks through to author and ship a tool
  // at runtime: scaffold → validate → stage → test → activate. The
  // generated artifact lands in `.kodax/constructed/tools/<name>/<version>.json`
  // and the activated handler is registered into TOOL_REGISTRY for use
  // in subsequent turns. Gated at the agent layer: not exposed unless
  // the session is in tool-construction mode.
  // ====================================================================
  {
    name: 'scaffold_tool',
    description:
      'Generate a fillable ConstructionArtifact JSON skeleton for a new tool. Returns a draft you must edit before calling validate_tool / stage_construction. '
      + 'Use this as the FIRST step when authoring a runtime tool — do NOT hand-write the JSON shape from scratch.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Tool name (must match the value the LLM will use to invoke it).' },
        version: { type: 'string', description: 'Semver string. Defaults to "0.1.0".' },
        description: { type: 'string', description: 'One-sentence description of what the tool does.' },
        capabilities: {
          type: 'object',
          description: 'Optional starter capabilities; defaults to {tools: []}.',
          properties: {
            tools: {
              type: 'array',
              items: { type: 'string' },
              description: 'Whitelist of builtin tool names the handler may call via ctx.tools.<name>.',
            },
          },
        },
      },
      required: ['name'],
    },
    handler: toolScaffoldTool,
    toClassifierInput: () => '',
  },
  {
    name: 'validate_tool',
    description:
      'Dry-run validate a candidate tool artifact JSON: shape sanity + AST hard rules (no-eval / no-Function-constructor / require-handler-signature) + provider schema validation. '
      + 'Does NOT touch disk. Use this BEFORE stage_construction to fail fast on malformed handlers.',
    input_schema: {
      type: 'object',
      properties: {
        artifact_json: { type: 'string', description: 'The full ConstructionArtifact as a JSON string.' },
        provider: {
          type: 'string',
          description: "Provider whose tool-schema constraints are checked. Defaults to 'anthropic'.",
        },
      },
      required: ['artifact_json'],
    },
    handler: toolValidateTool,
    toClassifierInput: () => '',
  },
  {
    name: 'stage_construction',
    description:
      'Persist an artifact to .kodax/constructed/<kind>s/<name>/<version>.json with status=staged. Refuses to overwrite an active artifact at the same name+version (bump the version instead). '
      + 'Run validate_tool first; this tool itself does not re-validate the AST or schema.',
    input_schema: {
      type: 'object',
      properties: {
        artifact_json: { type: 'string', description: 'The full ConstructionArtifact as a JSON string.' },
      },
      required: ['artifact_json'],
    },
    handler: toolStageConstruction,
    toClassifierInput: (input) => {
      const i = input as { artifact_json?: string };
      return `StageTool: ${stageArtifactPreview(i?.artifact_json)}`;
    },
  },
  {
    name: 'test_tool',
    description:
      'Run the full Phase 2 check pipeline (shape → AST → provider schema → handler materialize) on a staged artifact. Returns ok=true/false plus errors/warnings. '
      + 'On ok=true the artifact is ready for activate_tool. LLM static review is NOT run from this tool — the calling agent must drive that separately if desired.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Artifact name as stored on disk.' },
        version: { type: 'string', description: 'Artifact version as stored on disk.' },
        provider: {
          type: 'string',
          description: "Provider whose tool-schema constraints are checked. Defaults to 'anthropic'.",
        },
      },
      required: ['name', 'version'],
    },
    handler: toolTestTool,
    toClassifierInput: () => '',
  },
  {
    name: 'activate_tool',
    description:
      'Activate a staged-and-tested artifact. Invokes the construction policy gate, registers the handler into TOOL_REGISTRY, flips status=active. The tool is then immediately callable as `<name>` in subsequent turns. '
      + 'Policy: in the Ink REPL, an approve/reject dialog is shown to the user; in non-interactive surfaces (ACP / single-shot CLI / child agents) activation is rejected by default to prevent silent activation.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Artifact name to activate.' },
        version: { type: 'string', description: 'Artifact version to activate.' },
      },
      required: ['name', 'version'],
    },
    handler: toolActivateTool,
    toClassifierInput: (input) => {
      const i = input as { name?: string; version?: string };
      return `ActivateTool: ${i?.name ?? '<no-name>'}@${i?.version ?? '<no-version>'}`;
    },
  },
  // ====================================================================
  // FEATURE_089 (v0.7.31) — runtime AGENT construction staircase. Mirrors
  // the FEATURE_088 tool-construction tools above. Each tool produces a
  // manifest under `.kodax/constructed/agents/<name>/<version>.json`.
  // The activated agent goes through `Runner.admit` (FEATURE_101 5-step
  // audit) at test time. Gated at the agent layer:
  // `filterAgentConstructionToolNames` mirrors the tool-construction
  // gate; not exposed unless the session enables agent-construction mode.
  // ====================================================================
  {
    name: 'scaffold_agent',
    description:
      'Generate a fillable AgentArtifact JSON skeleton for a new agent. Returns a draft you must edit before calling validate_agent / stage_agent_construction. '
      + 'Use this as the FIRST step when authoring a runtime agent — do NOT hand-write the JSON shape from scratch.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Agent name (resolver lookup key once activated).' },
        version: { type: 'string', description: 'Semver string. Defaults to "0.1.0".' },
        description: {
          type: 'string',
          description: 'One-sentence description of the agent\'s purpose. Becomes the lead line of `instructions`.',
        },
      },
      required: ['name'],
    },
    handler: toolScaffoldAgent,
    toClassifierInput: () => '',
  },
  {
    name: 'validate_agent',
    description:
      'Dry-run admission audit (Runner.admit, FEATURE_101 5-step) on a candidate agent manifest JSON: schema validation + invariant.admit hooks + tool-capability cap + budget cap + handoff DAG check. '
      + 'Does NOT touch disk. Use this BEFORE stage_agent_construction to fail fast on rejected manifests.',
    input_schema: {
      type: 'object',
      properties: {
        artifact_json: { type: 'string', description: 'The full AgentArtifact as a JSON string.' },
      },
      required: ['artifact_json'],
    },
    handler: toolValidateAgent,
    toClassifierInput: () => '',
  },
  {
    name: 'stage_agent_construction',
    description:
      'Persist an agent manifest to .kodax/constructed/agents/<name>/<version>.json with status=staged. Refuses to overwrite an existing same-name+version (bump the version instead). '
      + 'Run validate_agent first; this tool itself does not re-run admission.',
    input_schema: {
      type: 'object',
      properties: {
        artifact_json: { type: 'string', description: 'The full AgentArtifact as a JSON string.' },
      },
      required: ['artifact_json'],
    },
    handler: toolStageAgentConstruction,
    toClassifierInput: (input) => {
      const i = input as { artifact_json?: string };
      return `StageAgent: ${stageArtifactPreview(i?.artifact_json)}`;
    },
  },
  {
    name: 'test_agent',
    description:
      'Run the agent test pipeline (manifest shape check + Runner.admit + sandbox case execution) on a staged agent. '
      + 'Returns ok=true/false with errors / warnings. On ok=true the agent is ready for activate_agent.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Agent name as stored on disk.' },
        version: { type: 'string', description: 'Agent version as stored on disk.' },
      },
      required: ['name', 'version'],
    },
    handler: toolTestAgent,
    toClassifierInput: () => '',
  },
  {
    name: 'activate_agent',
    description:
      'Activate a staged-and-tested agent. Invokes the construction policy gate, flips status=active, records contentHash, '
      + 'and registers the agent in the resolver so Runner.run can find it by name. '
      + 'Policy: in the Ink REPL, an approve/reject dialog is shown to the user; in non-interactive surfaces activation is rejected by default.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Agent name to activate.' },
        version: { type: 'string', description: 'Agent version to activate.' },
      },
      required: ['name', 'version'],
    },
    handler: toolActivateAgent,
    toClassifierInput: (input) => {
      const i = input as { name?: string; version?: string };
      return `ActivateAgent: ${i?.name ?? '<no-name>'}@${i?.version ?? '<no-version>'}`;
    },
  },

  // ====================================================================
  // FEATURE_090 (v0.7.32) — Self-modify staircase. The stage step is
  // separated from `stage_agent_construction` (above) so the LLM picks
  // its intent explicitly: "I am modifying myself" vs "I am creating
  // a different agent." Test/activate are reused from FEATURE_089 —
  // admission audit + sandbox runner work identically regardless of
  // which stage tool produced the manifest.
  // ====================================================================
  {
    name: SELF_MODIFY_TOOL_NAME,
    description:
      'Stage a new version of YOURSELF — the active constructed agent calling this tool. '
      + 'Requires artifact.name === artifact.sourceAgent === your own name, plus an existing active version on disk. '
      + 'Runs hard checks (guardrail ratchet — cannot remove existing guardrails; reasoning ceiling; modification budget) before persisting. '
      + 'Then call test_agent and activate_agent on the staged version. Activation force-prompts the user (no auto-approve for self-modify) and only takes effect on the NEXT Runner.run, never within the run that submitted the change.',
    input_schema: {
      type: 'object',
      properties: {
        artifact_json: {
          type: 'string',
          description: 'The full AgentArtifact as a JSON string. artifact.name must equal artifact.sourceAgent.',
        },
      },
      required: ['artifact_json'],
    },
    handler: toolStageSelfModify,
    toClassifierInput: (input) => {
      const i = input as { artifact_json?: string };
      return `StageSelfModify: ${stageArtifactPreview(i?.artifact_json)}`;
    },
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

/**
 * Detect whether a handler's return value is an AsyncGenerator (streaming tool).
 * Async generators have Symbol.asyncIterator; Promises do not.
 */
function isAsyncGenerator(value: unknown): value is AsyncGenerator<unknown, unknown, unknown> {
  return (
    value !== null
    && value !== undefined
    && typeof value === 'object'
    && Symbol.asyncIterator in (value as object)
  );
}

/**
 * Consume an async generator: forward each yield as a progress update,
 * then return the generator's final return value.
 *
 * NOTE: `for await...of` does NOT capture the return value of a generator.
 * We must use manual .next() iteration to capture `{ done: true, value }`.
 */
async function consumeToolGenerator(
  gen: AsyncGenerator<import('./types.js').ToolProgress, string, void>,
  onProgress?: (message: string) => void,
): Promise<string> {
  let step = await gen.next();
  while (!step.done) {
    const progress = step.value;
    if (progress && typeof progress.message === 'string') {
      onProgress?.(progress.message);
    }
    step = await gen.next();
  }
  // step.done === true → step.value is the return value (string)
  return step.value;
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
    const result = definition.handler(input, ctx);

    // Streaming tool (async generator): consume yields as progress, return final value
    if (isAsyncGenerator(result)) {
      return await consumeToolGenerator(
        result as AsyncGenerator<import('./types.js').ToolProgress, string, void>,
        ctx.reportToolProgress,
      );
    }

    // Standard tool (Promise<string>): await as before
    return await (result as Promise<string>);
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
