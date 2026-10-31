import { staticText } from '../prompts/static-text.js';
/**
 * FEATURE_200 Phase D (v0.7.45) — built-in tool definitions extracted from registry.ts.
 *
 * Flat data: the BUILTIN_TOOL_DEFINITIONS array + its only local helper
 * (stageArtifactPreview). Handlers are imported references; the registry
 * accessors (registry.ts) consume this array. No back-edges -> no cycle.
 */
import type { KodaXToolDefinition } from '@kodax-ai/llm';
import { normalizeMcpCapabilityId, parseMcpCapabilityId } from '@kodax-ai/agent';
import type { LocalToolDefinition } from './types.js';
import { mcpToClassifierInput } from './classifier-projection.js';
import { toolRead } from './read.js';
import { VISUAL_CODING_TOOLS } from './visual.js';
import {
  MEMORY_RECALL_TOOL_DESCRIPTION,
  MEMORY_RECALL_TOOL_NAME,
  MEMORY_RECALL_TOOL_SCHEMA,
  toolMemoryRecall,
} from './memory-recall.js';
import {
  MEMORY_INTENT_TOOL_DESCRIPTION,
  MEMORY_INTENT_TOOL_NAME,
  MEMORY_INTENT_TOOL_SCHEMA,
  toolMemoryIntent,
} from './memory-intent.js';
import {
  SESSION_HISTORY_READ_DESCRIPTION,
  SESSION_HISTORY_READ_SCHEMA,
  SESSION_HISTORY_READ_TOOL_NAME,
  SESSION_HISTORY_SEARCH_DESCRIPTION,
  SESSION_HISTORY_SEARCH_SCHEMA,
  SESSION_HISTORY_SEARCH_TOOL_NAME,
  toolSessionHistoryRead,
  toolSessionHistorySearch,
} from './session-history.js';
import { toolKodaxManual } from './manual.js';
import { buildManualToolDescription } from '../self-knowledge/tool-description.js';
import { EXPLICIT_WORKFLOW_POLICY } from '../agents/worker-role-prompt.js';
import {
  WORKFLOW_REVIEW_COMPOSITION_GUIDANCE,
  renderWorkflowPatternGuidance,
} from '../orchestration/pattern-catalog.js';
import { toolSkill } from './skill.js';
import { toolRunSkillScript } from './skill-script.js';
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
import { toolRelationshipScan } from './relationship-scan.js';
import { toolCyclicDependencies } from './cyclic-dependencies.js';
import {
  toolLspDefinition,
  toolLspHover,
  toolLspReferences,
  toolLspDocumentSymbols,
  toolLspWorkspaceSymbols,
  toolLspImplementation,
  toolLspPrepareCallHierarchy,
  toolLspIncomingCalls,
  toolLspOutgoingCalls,
} from './lsp-navigation.js';
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
import { toolListDispatchableAgents } from './list-dispatchable-agents.js';
import { toolRunWorkflow } from './run-workflow.js';
import {
  toolAgentOutput,
  toolFollowupTask,
  toolInterruptAgent,
  toolListAgents,
  toolSendAgentMessage,
  toolSpawnAgent,
  toolWaitAgent,
} from './agent-collaboration.js';
import { toolGetGoal, toolCreateGoal, toolUpdateGoal } from './goal-tools.js';
// FEATURE_155 v0.7.39 Slice C1 — `await_child_task` removed. Idle-yield
// (default ON since Slice B1.D) is the canonical wait mechanic.
import {
  TOOL_CALL_DEFINITION,
  TOOL_DESCRIBE_DEFINITION,
} from './tool-bridge.js';
import { TOOL_SEARCH_DEFINITION } from './tool-search.js';
import { toolTodoUpdate } from './todo-update.js';
import { toolTodoList } from './todo-list.js';
import { toolTodoCreate } from './todo-create.js';
import { toolTodoGet } from './todo-get.js';
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

function mcpCapabilityPreview(capabilityId: string | undefined, args: unknown): string {
  if (!capabilityId) {
    return mcpToClassifierInput('<no-server>', '<no-tool>', args);
  }

  try {
    const { serverId, kind, name } = parseMcpCapabilityId(normalizeMcpCapabilityId(capabilityId));
    return mcpToClassifierInput(serverId, `${kind}:${name}`, args);
  } catch {
    return mcpToClassifierInput(capabilityId, '<invalid-id>', args);
  }
}

function boundedText(value: unknown, limit = 200, fallback = '<missing>'): string {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  if (value.length <= limit) return value;
  const tailLength = Math.min(48, Math.floor((limit - 1) / 3));
  const headLength = limit - tailLength - 1;
  return `${value.slice(0, headLength)}…${value.slice(-tailLength)}`;
}

function stringArrayPreview(value: unknown, limit = 8): string {
  if (!Array.isArray(value)) return '[]';
  const items = value.slice(0, limit)
    .filter((item): item is string => typeof item === 'string')
    .map((item) => boundedText(item, 120));
  return `[${items.join(', ')}${value.length > limit ? ', …' : ''}]`;
}

function mappedPathPreview(
  value: unknown,
  sourceKey: string,
  targetKey: string,
): string {
  if (!Array.isArray(value)) return '[]';
  const items = value.slice(0, 8).map((item) => {
    if (item === null || typeof item !== 'object') return '<invalid>';
    const record = item as Record<string, unknown>;
    const source = boundedText(record[sourceKey], 120);
    const target = boundedText(record[targetKey], 120, '');
    return target ? `${source}->${target}` : source;
  });
  return `[${items.join(', ')}${value.length > 8 ? ', …' : ''}]`;
}

function objectKeysPreview(value: unknown): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return '[]';
  const keys = Object.keys(value);
  return `[${keys.slice(0, 16).join(', ')}${keys.length > 16 ? ', …' : ''}]`;
}

const RUN_WORKFLOW_DESCRIPTION = [
  EXPLICIT_WORKFLOW_POLICY,
  staticText("tool.RUN_WORKFLOW_DESCRIPTION.text"),
  staticText("tool.RUN_WORKFLOW_DESCRIPTION.text.1"),
  staticText("tool.RUN_WORKFLOW_DESCRIPTION.text.2"),
  staticText("tool.RUN_WORKFLOW_DESCRIPTION.text.3"),
  `Available single-phase shapes:\n${renderWorkflowPatternGuidance().slice(0, -1).join('\n')}`,
  `${WORKFLOW_REVIEW_COMPOSITION_GUIDANCE} Chain more than one pattern when the protocol has more than one shape, match the effort to the request, and disclose every bounded or silent cap.`,
  staticText("tool.RUN_WORKFLOW_DESCRIPTION.text.4"),
].join('\n\n');

const BUILTIN_TOOL_DEFINITION_SOURCE: LocalToolDefinition[] = [
  {
    name: 'read',
    description: staticText("tool.read.description"),
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The absolute file path or a kodax-transient://text/ reference supplied by context recovery' },
        offset: { type: 'number', description: 'Line number to start from (text files only)' },
        limit: { type: 'number', description: 'Number of lines to read (text files only)' },
        line_offset: {
          type: 'number',
          description: staticText("tool.read.description.1"),
        },
      },
      required: ['path'],
    },
    handler: toolRead,
    sideEffect: 'readonly',
    toClassifierInput: () => '',
  },
  {
    name: MEMORY_RECALL_TOOL_NAME,
    description: MEMORY_RECALL_TOOL_DESCRIPTION,
    input_schema: MEMORY_RECALL_TOOL_SCHEMA,
    handler: toolMemoryRecall,
    sideEffect: 'readonly',
    toClassifierInput: () => '',
  },
  {
    name: MEMORY_INTENT_TOOL_NAME,
    description: MEMORY_INTENT_TOOL_DESCRIPTION,
    input_schema: MEMORY_INTENT_TOOL_SCHEMA,
    handler: toolMemoryIntent,
    sideEffect: 'mutates-state',
    planModeAllowed: false,
    classifierExemptReason:
      staticText("tool.BUILTIN_TOOL_DEFINITION_SOURCE.classifierExemptReason"),
    toClassifierInput: () => '',
  },
  {
    name: SESSION_HISTORY_SEARCH_TOOL_NAME,
    description: SESSION_HISTORY_SEARCH_DESCRIPTION,
    input_schema: SESSION_HISTORY_SEARCH_SCHEMA,
    handler: toolSessionHistorySearch,
    sideEffect: 'readonly',
    toClassifierInput: () => '',
  },
  {
    name: SESSION_HISTORY_READ_TOOL_NAME,
    description: SESSION_HISTORY_READ_DESCRIPTION,
    input_schema: SESSION_HISTORY_READ_SCHEMA,
    handler: toolSessionHistoryRead,
    sideEffect: 'readonly',
    toClassifierInput: () => '',
  },
  {
    name: 'kodax_manual',
    // FEATURE_221: single source of truth so an SDK consumer can white-label
    // the description per productName; default output is byte-identical to the
    // prior literal (pinned by tool-description.test.ts).
    description: buildManualToolDescription(),
    input_schema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: staticText("tool.kodax_manual.description"),
        },
        query: {
          type: 'string',
          description: 'A free-text question when you do not know the topic id (English or Chinese).',
        },
      },
      required: [],
    },
    handler: toolKodaxManual,
    sideEffect: 'readonly',
    toClassifierInput: () => '',
  },
  {
    name: 'skill',
    description: [
      staticText("tool.skill.text"),
      staticText("tool.skill.text.1"),
      staticText("tool.skill.text.2"),
      staticText("tool.skill.text.3"),
    ].join('\n'),
    input_schema: {
      type: 'object',
      properties: {
        skill: {
          type: 'string',
          description: 'The skill name (e.g. "commit", "review-pr"). Leading slash is tolerated.',
        },
        args: {
          type: 'string',
          description: 'Optional arguments forwarded to the skill resolver.',
        },
      },
      required: ['skill'],
    },
    handler: toolSkill,
    sideEffect: 'mutates-state',
    planModeAllowed: true,
    classifierExemptReason: 'Loads local skill instructions; it does not execute the skill or mutate external state.',
    toClassifierInput: () => '',
  },
  {
    name: 'run_skill_script',
    description: [
      'Run one exact script from an admitted Skill inside the remote OS sandbox.',
      'The script sees only its pinned Skill snapshot and a fresh staging directory.',
      staticText("tool.run_skill_script.text"),
      staticText("tool.run_skill_script.text.1"),
    ].join('\n'),
    input_schema: {
      type: 'object',
      properties: {
        skill: { type: 'string', description: 'Exact admitted Skill name.' },
        script: { type: 'string', description: 'Exact Skill-relative script path.' },
        args: { type: 'array', items: { type: 'string' }, description: 'Arguments passed as data to the script.' },
        inputs: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Workspace-relative source file.' },
              as: { type: 'string', description: 'Optional staging-relative destination.' },
            },
            required: ['path'],
          },
        },
        outputs: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Staging-relative generated file.' },
              target: { type: 'string', description: 'Workspace-relative destination.' },
            },
            required: ['path', 'target'],
          },
        },
      },
      required: ['skill', 'script'],
    },
    handler: toolRunSkillScript,
    sideEffect: 'mutates-shell',
    toClassifierInput: (input) => {
      const value = input as {
        skill?: unknown;
        script?: unknown;
        args?: unknown;
        inputs?: unknown;
        outputs?: unknown;
      };
      return [
        `RunSkillScript ${boundedText(value.skill)}/${boundedText(value.script)}`,
        `args=${stringArrayPreview(value.args)}`,
        `inputs=${mappedPathPreview(value.inputs, 'path', 'as')}`,
        `outputs=${mappedPathPreview(value.outputs, 'path', 'target')}`,
      ].join(' ');
    },
  },
  {
    name: 'write',
    description: staticText("tool.write.description"),
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The absolute path to the file' },
        content: { type: 'string', description: 'The content to write' },
      },
      required: ['path', 'content'],
    },
    handler: toolWrite,
    sideEffect: 'mutates-fs',
    toClassifierInput: (input) => {
      const i = input as { path?: string; content?: string };
      const size = typeof i?.content === 'string' ? i.content.length : 0;
      return `Write ${i?.path ?? '<unknown>'} (${size} chars)`;
    },
  },
  {
    name: 'edit',
    description:
      staticText("tool.edit.text")
      + '## When to Use This Tool\n\n'
      + '- Modifying an existing file with one targeted text change.\n'
      + staticText("tool.edit.text.1")
      + '- Filling in one placeholder produced by a prior `write(path, skeleton)`.\n\n'
      + '## When NOT to Use This Tool\n\n'
      + staticText("tool.edit.text.2")
      + staticText("tool.edit.text.3")
      + staticText("tool.edit.text.4"),
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The file to edit' },
        edits: {
          type: 'array', minItems: 1,
          description: 'Replacements applied sequentially to this file; any failure leaves the file unchanged.',
          items: {
            type: 'object',
            properties: {
              old_string: { type: 'string', description: 'Unique text to replace; exact match then normalized fallback' },
              new_string: { type: 'string', description: 'Replacement text' },
              replace_all: { type: 'boolean', description: 'Replace every occurrence; defaults to false' },
            },
            required: ['old_string', 'new_string'],
          },
        },
        old_string: { type: 'string', description: 'The text to replace' },
        new_string: { type: 'string', description: 'The replacement text' },
        replace_all: { type: 'boolean', description: 'Replace all occurrences' },
      },
      required: ['path'],
    },
    handler: toolEdit,
    sideEffect: 'mutates-fs',
    toClassifierInput: (input) => {
      const i = input as { path?: string; replace_all?: boolean };
      return `Edit ${i?.path ?? '<unknown>'}${i?.replace_all ? ' [replace_all]' : ''}`;
    },
  },
  {
    name: 'multi_edit',
    description:
      'Apply multiple exact-text replacements to a single file in ONE atomic tool call.\n\n'
      + '## When to Use This Tool\n\n'
      + staticText("tool.multi_edit.text")
      + '- Bulk renames within one file (use `replace_all: true` per edit).\n'
      + '- Refactors that touch multiple spots in one file and should land all-or-nothing.\n\n'
      + '## When NOT to Use This Tool\n\n'
      + '- For a single change — call `edit` directly; the extra wrapping is unnecessary overhead.\n'
      + staticText("tool.multi_edit.text.1")
      + staticText("tool.multi_edit.text.2")
      + '## Atomicity\n\n'
      + staticText("tool.multi_edit.text.3")
      + '## Uniqueness\n\n'
      + staticText("tool.multi_edit.text.4")
      + '## Typical Pattern\n\n'
      + staticText("tool.multi_edit.text.5"),
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
    sideEffect: 'mutates-fs',
    toClassifierInput: (input) => {
      const i = input as { path?: string; edits?: unknown[] };
      const count = Array.isArray(i?.edits) ? i.edits.length : 0;
      return `MultiEdit ${i?.path ?? '<unknown>'}: ${count} edits`;
    },
  },
  {
    name: 'insert_after_anchor',
    description: staticText("tool.insert_after_anchor.description"),
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
    sideEffect: 'mutates-fs',
    toClassifierInput: (input) => {
      const i = input as { path?: string; anchor?: string; content?: string };
      return `InsertAfterAnchor ${i?.path ?? '<unknown>'} anchor_chars=${i.anchor?.length ?? 0} content_chars=${i.content?.length ?? 0}`;
    },
  },
  {
    name: 'bash',
    description: staticText("tool.bash.description"),
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to execute' },
        description: { type: 'string', description: 'Clear, concise description of what this command does' },
        timeout: { type: 'number', description: 'Timeout in seconds' },
        run_in_background: {
          type: 'boolean',
          description: staticText("tool.bash.description.1"),
        },
      },
      required: ['command'],
    },
    handler: toolBash,
    sideEffect: 'mutates-shell',
    // FEATURE_149 (v0.7.38) — `interruptBehavior` is intentionally LEFT
    // UNSET (defaults to 'wait'). KodaX mirrors Claude Code's conservative
    // posture here: SIGTERM-mid-bash leaves half-written files, half-pushed
    // git, half-mutated databases — letting a long shell finish + queueing
    // the new prompt is safer than aborting. CC's `BashTool` likewise has
    // no `interruptBehavior` override (default `'block'` in CC = our
    // `'wait'`). The fast-abort path in `InkREPL.tsx:handleSubmit` stays
    // wired so a future side-effect-free wait-only tool (Sleep, Wait,
    // Schedule) can opt in by tagging `'cancel'` — that's the only safe
    // shape for fast-abort.
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
    sideEffect: 'readonly',
    toClassifierInput: () => '',
  },
  {
    name: 'grep',
    description: staticText("tool.grep.description"),
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: "Regex, or literal text when literal is true, to match in file contents." },
        literal: { type: 'boolean', description: 'Match text verbatim, including long strings. Default false (regex). Use glob for paths.' },
        path: { type: 'string', description: "File or directory; defaults to cwd." },
        glob: { type: 'string', description: "File glob, e.g. *.{ts,tsx}." },
        type: { type: 'string', description: "File type such as ts (includes .ts/.tsx/.mts/.cts). Use glob for an exact extension, e.g. *.ts." },
        output_mode: {
          type: 'string',
          enum: ['content', 'files_with_matches', 'count'],
          description: "content (default): matching lines; files_with_matches: paths; count: per-file match counts.",
        },
        ignore_case: { type: 'boolean', description: "Case-insensitive matching; default false." },
        '-i': { type: 'boolean', description: 'Alias for ignore_case' },
        '-A': { type: 'number', description: "Following context lines; content mode only." },
        '-B': { type: 'number', description: "Preceding context lines; content mode only." },
        '-C': { type: 'number', description: 'Alias for context' },
        context: { type: 'number', description: "Context lines on both sides; content mode only." },
        multiline: { type: 'boolean', description: "Allow . and matches across newlines; default false." },
        head_limit: { type: 'number', description: staticText("tool.grep.description.1") },
        offset: { type: 'number', description: "Entries to skip; default 0." },
        scan_offset: { type: 'number', description: "Candidate files skipped for SOURCE_INCOMPLETE continuation." },
      },
      required: ['pattern'],
    },
    handler: toolGrep,
    sideEffect: 'readonly',
    toClassifierInput: () => '',
  },
  {
    name: 'list_dispatchable_agents',
    description: staticText("tool.list_dispatchable_agents.description"),
    input_schema: {
      type: 'object',
      properties: {
        required_skills: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional skills every returned agent must declare.',
        },
        required_capabilities: {
          type: 'object',
          properties: {
            streaming: { type: 'boolean' },
            durableTasks: { type: 'boolean' },
            inputRequired: { type: 'boolean' },
            cancellation: { type: 'boolean' },
            artifacts: { type: 'boolean' },
          },
          description: 'Optional lifecycle capabilities required for this dispatch.',
        },
        read_only: {
          type: 'boolean',
          description: 'When true, exclude external agents whose declared remote effect is write or unknown.',
        },
      },
    },
    handler: toolListDispatchableAgents,
    sideEffect: 'readonly',
    toClassifierInput: () => '',
  },
  {
    name: 'spawn_agent',
    description: staticText("tool.spawn_agent.description"),
    input_schema: {
      type: 'object',
      properties: {
        task_name: { type: 'string', description: 'Stable direct-child name used in the Runtime-minted canonical actor path.' },
        objective: { type: 'string', description: 'Detailed multi-step goal for this child agent' },
        read_only: { type: 'boolean', description: 'true (default) narrows filesystem access to read-only; false retains the parent ceiling.' },
        scope: { type: 'string', description: 'Optional bounded scope hint (e.g. "packages/llm/src/")' },
        evidence_refs: { type: 'array', items: { type: 'string' }, description: staticText("tool.spawn_agent.description.1") },
        constraints: { type: 'array', items: { type: 'string' }, description: 'Optional constraints' },
        // FEATURE_120 + FEATURE_102 — model tier hint resolved by the child
        // executor against configured fast/deep operator tiers.
        model_hint: {
          type: 'string',
          enum: ['fast', 'balanced', 'deep'],
          description: staticText("tool.spawn_agent.description.2"),
        },
        agent_id: {
          type: 'string',
          description: 'Select a registered specialist matching the task instead of a generic child.',
        },
        // FEATURE_102 Phase 2 (v0.7.45) — explicit per-dispatch model targeting.
        provider: {
          type: 'string',
          description: staticText("tool.spawn_agent.description.3"),
        },
        model: {
          type: 'string',
          description: 'Model id paired with provider. Omit to inherit.',
        },
        effort: {
          type: 'string',
          description: staticText("tool.spawn_agent.description.4"),
        },
        isolation: { type: 'string', enum: ['shared', 'worktree'], description: 'Optional execution isolation.' },
        fork_turns: { description: 'History fork: all (default), none, or a positive recent-turn count.' },
        quality_strategy: {
          type: 'object',
          description: staticText("tool.spawn_agent.description.5"),
        },
      },
      required: ['task_name', 'objective'],
    },
    handler: toolSpawnAgent,
    sideEffect: 'mutates-state',
    toClassifierInput: (input) => {
      const i = input as Record<string, unknown>;
      const mutability = i?.read_only === false ? 'mutating' : 'readonly';
      return [
        `SpawnAgent(${mutability})`,
        `task=${boundedText(i.task_name)}`,
        `scope=${boundedText(i.scope, 160, '<inherit>')}`,
        `evidence=${stringArrayPreview(i.evidence_refs)}`,
        `isolation=${boundedText(i.isolation, 40, '<default>')}`,
        `provider=${boundedText(i.provider, 80, '<inherit>')}`,
        `model=${boundedText(i.model, 80, '<inherit>')}`,
        `model_hint=${boundedText(i.model_hint, 40, '<inherit>')}`,
        `effort=${boundedText(i.effort, 40, '<inherit>')}`,
        `agent=${boundedText(i.agent_id, 80, '<generic>')}`,
        `fork=${boundedText(i.fork_turns, 40, '<all>')}`,
        `objective_chars=${typeof i.objective === 'string' ? i.objective.length : 0}`,
        `constraints_count=${Array.isArray(i.constraints) ? i.constraints.length : 0}`,
      ].join(' ');
    },
  },
  {
    name: 'run_workflow',
    description: RUN_WORKFLOW_DESCRIPTION,
    input_schema: {
      type: 'object',
      properties: {
        manifest: {
          type: 'object',
          description:
            staticText("tool.run_workflow.description"),
          properties: {
            name: { type: 'string' },
            description: { type: 'string' },
            phases: { type: 'array', items: { type: 'string' }, description: 'Ordered phase names for progress display.' },
            readOnly: { type: 'boolean' },
            maxAgents: { type: 'number', description: 'Lifetime cap on total child agents across the run.' },
            maxConcurrency: { type: 'number', description: 'Max simultaneously in-flight child agents.' },
            patterns: { type: 'array', items: { type: 'string' } },
            plannedAgents: { type: 'number' },
          },
          required: ['name', 'description', 'phases', 'readOnly', 'maxAgents', 'maxConcurrency', 'patterns'],
        },
        source: {
          type: 'string',
          description:
            staticText("tool.run_workflow.description.1"),
        },
        args: {
          type: 'object',
          description: 'Optional initial arguments passed to run(wf, args).',
        },
        resumeFromRunId: {
          type: 'string',
          pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$',
          // ADR-033 §5: no FEATURE_xxx version metadata in the prompt body — it
          // is noise for the LLM and churns the tool-schema prompt cache.
          description:
            staticText("tool.run_workflow.description.2"),
        },
      },
      required: ['manifest', 'source'],
    },
    handler: toolRunWorkflow,
    sideEffect: 'mutates-state',
    toClassifierInput: (input) => {
      const i = input as { manifest?: Record<string, unknown>; source?: unknown; args?: unknown; resumeFromRunId?: unknown };
      const manifest = i.manifest ?? {};
      return [
        `RunWorkflow name=${boundedText(manifest.name, 120, '<workflow>')}`,
        `readOnly=${String(manifest.readOnly ?? '<missing>')}`,
        `maxAgents=${String(manifest.maxAgents ?? '<missing>')}`,
        `maxConcurrency=${String(manifest.maxConcurrency ?? '<missing>')}`,
        `plannedAgents=${String(manifest.plannedAgents ?? '<missing>')}`,
        `patterns=${stringArrayPreview(manifest.patterns)}`,
        `source_chars=${typeof i.source === 'string' ? i.source.length : 0}`,
        `args_keys=${objectKeysPreview(i.args)}`,
        `resume=${boundedText(i.resumeFromRunId, 120, '<none>')}`,
      ].join(' ');
    },
  },
  // Actor messaging and lifecycle controls share the Runtime-owned tree.
  {
    name: 'send_message',
    description:
      staticText("tool.send_message.description"),
    input_schema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description:
            staticText("tool.send_message.description.1"),
        },
        content: {
          type: 'string',
          description:
            'Message body. Runtime wraps it in an authenticated <agent-message> frame before delivery.',
        },
        forwarded_message_id: {
          type: 'string',
          description:
            staticText("tool.send_message.description.2"),
        },
        classification: {
          type: 'string',
          enum: ['public', 'internal', 'sensitive'],
          description:
            'Data classification. Defaults to internal; forwarding cannot downgrade the source classification.',
        },
      },
      required: ['to', 'content'],
    },
    handler: toolSendAgentMessage,
    sideEffect: 'mutates-state',
    toClassifierInput: (input) => {
      const i = input as Record<string, unknown>;
      return [
        `SendMessage target=${boundedText(i.to, 160, '<no-target>')}`,
        `classification=${boundedText(i.classification, 32, 'internal')}`,
        `forwarded=${typeof i.forwarded_message_id === 'string'}`,
        `content_chars=${typeof i.content === 'string' ? i.content.length : 0}`,
      ].join(' ');
    },
  },
  {
    name: 'followup_task',
    description: staticText("tool.followup_task.description"),
    input_schema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Canonical child path or direct-child task name.' },
        objective: { type: 'string', description: 'Additional objective or changed evidence.' },
        quality_strategy: {
          type: 'object',
          description: staticText("tool.followup_task.description.1"),
        },
      },
      required: ['target', 'objective'],
    },
    handler: toolFollowupTask,
    sideEffect: 'mutates-state',
    toClassifierInput: (input) => {
      const value = input as Record<string, unknown>;
      return `FollowupTask target=${boundedText(value.target, 160, '<no-target>')} objective_chars=${typeof value.objective === 'string' ? value.objective.length : 0}`;
    },
  },
  {
    name: 'wait_agent',
    description: staticText("tool.wait_agent.description"),
    input_schema: {
      type: 'object',
      properties: {
        timeout_ms: { type: 'number', minimum: 10000, maximum: 3600000, description: staticText("tool.wait_agent.description.1") },
      },
    },
    handler: toolWaitAgent,
    sideEffect: 'readonly',
    planModeAllowed: true,
    toClassifierInput: () => '',
  },
  {
    name: 'list_agents',
    description: staticText("tool.list_agents.description"),
    input_schema: {
      type: 'object',
      properties: {
        path_prefix: { type: 'string', description: 'Optional canonical or caller-relative Actor path prefix.' },
        state: {
          type: 'string',
          enum: ['running', 'idle', 'closed'],
          description: 'Optional Actor state filter.',
        },
        after_path: { type: 'string', description: 'Exclusive canonical path cursor returned as nextAfterPath.' },
        limit: { type: 'number', description: 'Page size, 1-50. Defaults to 20.' },
      },
    },
    handler: toolListAgents,
    sideEffect: 'readonly',
    planModeAllowed: true,
    toClassifierInput: () => '',
  },
  {
    name: 'interrupt_agent',
    description:
      staticText("tool.interrupt_agent.description"),
    input_schema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description:
            'Canonical controlled actor path or direct-child task name.',
        },
        reason: {
          type: 'string',
          description:
            'Optional attributable interruption reason.',
        },
        scope: {
          type: 'string',
          enum: ['turn', 'subtree'],
          description:
            staticText("tool.interrupt_agent.description.1"),
        },
      },
      required: ['target'],
    },
    handler: toolInterruptAgent,
    sideEffect: 'mutates-state',
    planModeAllowed: true,
    toClassifierInput: (input) => {
      const i = input as Record<string, unknown>;
      return `InterruptAgent target=${boundedText(i.target, 160, '<no-target>')} scope=${boundedText(i.scope, 32, 'turn')} reason_chars=${typeof i.reason === 'string' ? i.reason.length : 0}`;
    },
  },
  {
    name: 'agent_output',
    description:
      staticText("tool.agent_output.description"),
    input_schema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description:
            'Canonical controlled actor path or direct-child task name.',
        },
        turn_id: { type: 'string', description: 'Optional exact turn id. Defaults to the actor\'s latest turn.' },
      },
      required: ['target'],
    },
    handler: toolAgentOutput,
    sideEffect: 'readonly',
    planModeAllowed: true,
    toClassifierInput: () => '',
  },
  {
    name: 'web_search',
    description: staticText("tool.web_search.description"),
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query to run' },
        limit: { type: 'number', description: 'Maximum number of search results to return' },
      },
      required: ['query'],
    },
    handler: toolWebSearch,
    // FEATURE_247: read-only network research.
    sideEffect: 'reads-network',
    // Plan mode permits web_search: it's functionally a query (no remote
    // mutation), common in planning workflows ("research the API before
    // I propose the change"). web_fetch remains outside plan mode by its
    // explicit planModeAllowed policy, not because it mutates remote state.
    planModeAllowed: true,
    toClassifierInput: (input) => {
      const i = input as Record<string, unknown>;
      return `WebSearch query=${boundedText(i.query, 200, '<no-query>')}`;
    },
  },
  {
    name: 'web_fetch',
    description: staticText("tool.web_fetch.description"),
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Remote URL to fetch' },
        provider_id: { type: 'string', description: 'Optional extension capability provider id for provider-backed fetch' },
        capability_id: { type: 'string', description: 'Optional provider capability id for provider-backed fetch' },
      },
    },
    handler: toolWebFetch,
    sideEffect: 'reads-network',
    toClassifierInput: (input) => {
      const i = input as Record<string, unknown>;
      return [
        `WebFetch url=${boundedText(i.url, 240, '<provider-backed>')}`,
        `provider=${boundedText(i.provider_id, 80, '<default>')}`,
        `capability=${boundedText(i.capability_id, 120, '<default>')}`,
      ].join(' ');
    },
  },
  {
    name: 'code_search',
    description: staticText("tool.code_search.description"),
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'String query to search for' },
        path: { type: 'string', description: 'Optional file or directory scope for the search' },
        limit: { type: 'number', description: 'Maximum number of matches to return' },
        scan_offset: { type: 'number', description: 'Skip candidate files already scanned by a prior SOURCE_INCOMPLETE continuation.' },
        case_sensitive: { type: 'boolean', description: 'Whether the query should be matched case-sensitively' },
        provider_id: { type: 'string', description: 'Optional extension capability provider id for provider-backed code search' },
      },
      required: ['query'],
    },
    handler: toolCodeSearch,
    sideEffect: 'readonly',
    toClassifierInput: (input) => {
      const i = input as Record<string, unknown>;
      if (typeof i.provider_id !== 'string' || i.provider_id.length === 0) return '';
      return [
        `CodeSearch query=${boundedText(i.query, 200, '<no-query>')}`,
        `path=${boundedText(i.path, 160, '<workspace>')}`,
        `provider=${boundedText(i.provider_id, 80)}`,
      ].join(' ');
    },
  },
  {
    name: 'semantic_lookup',
    workSurface: 'coding',
    description: staticText("tool.semantic_lookup.description"),
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
    // sideEffect: 'readonly' — 95% of calls are pure queries against an
    // existing repo-intel index. The `refresh: true` option rebuilds the
    // local index (a derived-data side effect, not a source-tree mutation),
    // which the classifier projection surfaces; plan mode permits the read
    // path and the handler can gate refresh internally if needed.
    sideEffect: 'readonly',
    // refresh: true rebuilds the repo-intel snapshot (disk side effect),
    // so this is not strictly Tier 1 — surface name + truncated input via
    // the helper so the classifier can see when refresh is requested.
    toClassifierInput: (input) => {
      const i = input as Record<string, unknown>;
      if (i.refresh !== true) return '';
      return `SemanticLookup refresh=true kind=${boundedText(i.kind, 32, 'auto')} target=${boundedText(i.target_path, 160, '<workspace>')}`;
    },
  },
  {
    name: 'mcp_search',
    description: staticText("tool.mcp_search.description"),
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional search query. Omit or pass an empty string to browse active MCP catalogs.' },
        server: { type: 'string', description: 'Optional MCP server id filter' },
        kind: {
          type: 'string',
          enum: ['tool', 'resource', 'prompt'],
          description: 'Optional MCP capability family filter',
        },
        limit: {
          type: 'number',
          minimum: 1,
          description: staticText("tool.mcp_search.description.1"),
        },
        cursor: {
          type: 'string',
          description: 'Opaque continuation cursor returned by mcp_search. Pass it alone without query/server/kind/limit.',
        },
      },
    },
    handler: toolMcpSearch,
    sideEffect: 'readonly',
    planModeAllowed: true,
    toClassifierInput: () => '',
  },
  {
    name: 'mcp_describe',
    description: staticText("tool.mcp_describe.description"),
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'MCP capability id from mcp_search' },
      },
      required: ['id'],
    },
    handler: toolMcpDescribe,
    sideEffect: 'readonly',
    planModeAllowed: true,
    toClassifierInput: () => '',
  },
  {
    name: 'mcp_call',
    description: staticText("tool.mcp_call.description"),
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
    sideEffect: 'mutates-network',
    toClassifierInput: (input) => {
      const i = input as { id?: string; args?: unknown };
      const capability = typeof i?.id === 'string' ? i.id : '<no-id>';
      return mcpCapabilityPreview(capability, i?.args ?? {});
    },
  },
  {
    name: 'mcp_read_resource',
    description: staticText("tool.mcp_read_resource.description"),
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'MCP resource capability id from mcp_search' },
      },
      required: ['id'],
    },
    handler: toolMcpReadResource,
    // FEATURE_247: read against the remote MCP server, no remote mutation.
    sideEffect: 'reads-network',
    // Plan mode permits MCP read-resource: it's a read against the
    // remote server, functionally a query. mcp_call is NOT
    // planModeAllowed because it can invoke arbitrary MCP tools that
    // mutate remote state.
    planModeAllowed: true,
    toClassifierInput: (input) => {
      const i = input as { id?: unknown };
      return `McpReadResource id=${boundedText(i.id, 240, '<no-id>')}`;
    },
  },
  {
    name: 'mcp_get_prompt',
    description: staticText("tool.mcp_get_prompt.description"),
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
    // FEATURE_247: read of a server-side prompt definition, no remote mutation.
    sideEffect: 'reads-network',
    // Plan mode permits MCP get-prompt: it's a read of a server-side
    // prompt definition, functionally a query.
    planModeAllowed: true,
    toClassifierInput: (input) => {
      const i = input as { id?: string; args?: unknown };
      const capability = typeof i.id === 'string' ? i.id : '<no-id>';
      return mcpCapabilityPreview(capability, i.args ?? {});
    },
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
    sideEffect: 'mutates-fs',
    toClassifierInput: (input) => {
      const i = input as { branch_name?: string; description?: string };
      const branch = typeof i?.branch_name === 'string'
        ? i.branch_name
        : '<auto>';
      return `WorktreeCreate ${branch} description_chars=${i.description?.length ?? 0}`;
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
    sideEffect: 'mutates-fs',
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
    sideEffect: 'mutates-fs',
    toClassifierInput: () => 'Undo: revert last file modification',
  },
  {
    name: 'ask_user_question',
    description: staticText("tool.ask_user_question.description"),
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        questions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string' },
              header: { type: 'string', description: "Short progress label, at most 12 chars." },
              options: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string' },
                    description: { type: 'string' },
                    value: { type: 'string', description: "Returned value; defaults to label." },
                  },
                  required: ['label'],
                },
              },
              multi_select: {
                type: 'boolean',
              },
              min_selections: {
                type: 'integer',
                description: "Minimum choices when multi_select=true.",
              },
              max_selections: {
                type: 'integer',
                description: "Maximum choices when multi_select=true.",
              },
              default: {
                type: 'string',
                description: 'Suggested option value for display. Never submitted automatically.',
              },
              allow_custom_input: {
                type: 'boolean',
                description: "Defaults to the flat setting or true; false only for closed safety/protocol choices.",
              },
              custom_input_label: {
                type: 'string',
                description: "Custom-choice label; falls back to flat setting or \"Other...\".",
              },
              custom_input_prompt: {
                type: 'string',
                description: "Custom-choice prompt; falls back to flat setting.",
              },
              custom_input_default: {
                type: 'string',
                description: "Custom-choice initial text; falls back to flat setting.",
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
          description: "Default select; input ignores options and does not support questions[].",
        },
        options: {
          type: 'array',
          description: "Choices; required for select, ignored for input.",
          items: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              description: { type: 'string' },
              value: { type: 'string', description: "Returned value; defaults to label." },
            },
            required: ['label'],
          },
        },
        multi_select: {
          type: 'boolean',
          description: "Select only: allow multiple choices; answer is an array.",
        },
        min_selections: {
          type: 'integer',
          description: "Minimum choices when multi_select=true.",
        },
        max_selections: {
          type: 'integer',
          description: "Maximum choices when multi_select=true.",
        },
        allow_custom_input: {
          type: 'boolean',
          description: "Automatic custom choice defaults true; false only for closed safety/protocol choices.",
        },
        custom_input_label: {
          type: 'string',
          description: "Automatic custom-choice label; default \"Other...\".",
        },
        custom_input_prompt: {
          type: 'string',
          description: "Prompt for the automatic custom choice.",
        },
        custom_input_default: {
          type: 'string',
          description: "Initial text for the automatic custom choice.",
        },
        default: { type: 'string', description: 'Suggested option value (select) or initial text (input) for display. Never submitted automatically.' },
      },
      // The handler validates either a single question or a questions-only batch.
    },
    handler: toolAskUserQuestion,
    sideEffect: 'readonly',
    planModeAllowed: true,
    toClassifierInput: () => '',
  },
  // FEATURE_192 v0.7.44 — `/goal` Persistent Goal tools.
  // `ctx.goalContext` is wired by the REPL adapter for every session
  // with a lineage; in non-REPL test harnesses or sync-dispatch the
  // context stays undefined and the tools return a uniform "not wired
  // here" error so the model gets a clear signal rather than a silent
  // failure. Registry shape stays constant.
  {
    name: 'get_goal',
    description:
      staticText("tool.get_goal.description"),
    input_schema: { type: 'object', properties: {} },
    handler: toolGetGoal,
    sideEffect: 'readonly',
    planModeAllowed: true,
    toClassifierInput: () => '',
  },
  {
    name: 'create_goal',
    description:
      staticText("tool.create_goal.description"),
    input_schema: {
      type: 'object',
      properties: {
        objective: {
          type: 'string',
          description:
            staticText("tool.create_goal.description.1"),
        },
        token_budget: {
          type: 'number',
          description:
            staticText("tool.create_goal.description.2"),
        },
      },
      required: ['objective'],
    },
    handler: toolCreateGoal,
    sideEffect: 'mutates-state',
    planModeAllowed: true,
    classifierExemptReason: 'Creates only session-local goal bookkeeping after explicit user authorization.',
    toClassifierInput: () => '',
  },
  {
    name: 'update_goal',
    description:
      staticText("tool.update_goal.description"),
    input_schema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['complete', 'blocked'],
          description:
            "Target goal status.",
        },
        blocker_kind: {
          type: 'string',
          description:
            staticText("tool.update_goal.description.1"),
        },
      },
      required: ['status'],
    },
    handler: toolUpdateGoal,
    sideEffect: 'mutates-state',
    planModeAllowed: false,
    classifierExemptReason: 'Updates only session-local goal status; the persistent blocker counter is enforced by the runtime.',
    toClassifierInput: () => '',
  },
  {
    name: 'exit_plan_mode',
    description: staticText("tool.exit_plan_mode.description"),
    input_schema: {
      type: 'object',
      properties: {
        plan: {
          type: 'string',
          description: staticText("tool.exit_plan_mode.description.1"),
        },
      },
      required: ['plan'],
    },
    handler: toolExitPlanMode,
    sideEffect: 'mutates-state',
    planModeAllowed: true,
    classifierExemptReason: 'Already requires a dedicated interactive plan-approval boundary.',
    toClassifierInput: () => '',
  },
  {
    name: 'todo_update',
    description: staticText("tool.todo_update.description"),
    input_schema: {
      type: 'object',
      properties: {
        op: {
          type: 'string',
          enum: ['init', 'update'],
          description:
            staticText("tool.todo_update.description.1"),
        },
        items: {
          type: 'array',
          description:
            staticText("tool.todo_update.description.2"),
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Unique non-empty item id (e.g. "todo_1").' },
              subject: { type: 'string', description: 'Brief imperative title shown in the plan-list row (e.g. "Run failing tests").' },
              description: {
                type: 'string',
                description: staticText("tool.todo_update.description.3"),
              },
              activeForm: {
                type: 'string',
                description: staticText("tool.todo_update.description.4"),
              },
              evaluator: {
                type: 'string',
                enum: ['build', 'test', 'lint'],
                description: staticText("tool.todo_update.description.5"),
              },
            },
            required: ['id', 'subject'],
            // Note: ideally we'd set `additionalProperties: false` here so
            // an LLM passing `{id, content, status:'pending'}` (mixing
            // init-item shape with update shape) gets a schema-validation
            // error rather than a silent drop. But `KodaXToolDefinition['input_schema']`
            // does not currently model that field (see `packages/llm/src/types.ts:113`).
            // Runtime validator in `executeInitOp` already destructures only
            // the known keys, so extra fields are dropped harmlessly. Schema-layer
            // hardening tracked as a separate type-extension follow-up.
          },
        },
        id: {
          type: 'string',
          description: "Existing canonical todo id; must match the current plan.",
        },
        status: {
          type: 'string',
          enum: ['in_progress', 'completed', 'failed', 'skipped', 'cancelled', 'deleted'],
          description:
            staticText("tool.todo_update.description.6"),
        },
        note: {
          type: 'string',
          description: "Optional reason/detail; omit to preserve.",
        },
        activeForm: {
          type: 'string',
          description:
            staticText("tool.todo_update.description.7"),
        },
        subject: {
          type: 'string',
          description:
            "Optional replacement imperative title; must be non-empty.",
        },
        description: {
          type: 'string',
          description:
            "Optional replacement multi-line work context; empty string clears it.",
        },
        evaluator: {
          type: 'string',
          enum: ['build', 'test', 'lint'],
          description:
            staticText("tool.todo_update.description.8"),
        },
        metadata: {
          // Note: the handler also accepts JSON `null` as an explicit clear
          // signal (sets metadata back to undefined on the item). JSON Schema
          // `type:'object'` does NOT include null in its strict sense — providers
          // that pre-validate tool inputs against the schema may need a
          // `nullable:true` extension. KodaXToolDefinition['input_schema'] does
          // not currently model that field (see `packages/llm/src/types.ts`);
          // handler is authoritative.
          type: 'object',
          description:
            staticText("tool.todo_update.description.9"),
        },
      },
      // No top-level required fields — the handler validates per-op:
      //   op="init"   → requires `items`
      //   op="update" → requires `id` plus at least one of
      //     {status, subject, description, activeForm, note, evaluator, metadata}.
    },
    handler: toolTodoUpdate,
    sideEffect: 'mutates-state',
    planModeAllowed: true,
    classifierExemptReason: 'Mutates only the visible session-local progress checklist.',
    toClassifierInput: () => '',
  },
  {
    name: 'todo_create',
    description: staticText("tool.todo_create.description"),
    input_schema: {
      type: 'object',
      properties: {
        subject: {
          type: 'string',
          description: "Non-empty imperative milestone title shown in the plan row.",
        },
        status: {
          type: 'string',
          enum: ['pending', 'in_progress'],
          description: staticText("tool.todo_create.description.1"),
        },
        description: {
          type: 'string',
          description: staticText("tool.todo_create.description.2"),
        },
        activeForm: {
          type: 'string',
          description:
            "Optional present-continuous label shown by the in_progress spinner.",
        },
        evaluator: {
          type: 'string',
          enum: ['build', 'test', 'lint'],
          description:
            staticText("tool.todo_create.description.3"),
        },
        metadata: {
          type: 'object',
          description:
            "Optional opaque hook/eval data; not shown in UI. Omit when unused.",
        },
      },
      required: ['subject'],
    },
    handler: toolTodoCreate,
    sideEffect: 'mutates-state',
    planModeAllowed: true,
    classifierExemptReason: 'Adds only a session-local progress checklist item.',
    toClassifierInput: () => '',
  },
  {
    name: 'todo_list',
    description: staticText("tool.todo_list.description"),
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Optional stable todo id for full item detail; omit to list the plan.' },
      },
    },
    handler: toolTodoList,
    sideEffect: 'readonly',
    planModeAllowed: true,
    toClassifierInput: () => '',
  },
  {
    name: 'todo_get',
    description: staticText("tool.todo_get.description"),
    input_schema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The todo id to retrieve (e.g. "todo_3"). Must match a current valid id.',
        },
      },
      required: ['id'],
    },
    handler: toolTodoGet,
    sideEffect: 'readonly',
    planModeAllowed: true,
    toClassifierInput: () => '',
  },
  {
    name: 'repo_overview',
    workSurface: 'coding',
    description: staticText("tool.repo_overview.description"),
    input_schema: {
      type: 'object',
      properties: {
        target_path: { type: 'string', description: 'Optional path inside the workspace to resolve the repository root from' },
        refresh: { type: 'boolean', description: 'When true, rebuild the repo overview snapshot before returning it' },
      },
    },
    handler: toolRepoOverview,
    sideEffect: 'readonly',
    toClassifierInput: () => '',
  },
  {
    name: 'changed_scope',
    workSurface: 'coding',
    description: staticText("tool.changed_scope.description"),
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
    sideEffect: 'readonly',
    toClassifierInput: () => '',
  },
  {
    name: 'changed_diff',
    workSurface: 'coding',
    description: staticText("tool.changed_diff.description"),
    input_schema: {
      type: 'object',
      properties: {
        target_path: { type: 'string', description: 'Optional path inside the workspace to resolve the repository root from' },
        base_ref: { type: 'string', description: 'Optional base git ref for compare-range review' },
        target_ref: { type: 'string', description: 'Optional target git ref for compare-range review (defaults to HEAD when base_ref is provided)' },
        path: { type: 'string', description: 'Changed file path to inspect, relative to the workspace root or absolute inside it' },
        paths: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 64, description: 'Changed paths inside the workspace; one path is valid' },
        limit_per_path: { type: 'number', description: 'Maximum diff lines per path (default 200, maximum 800)' },
        offset: { type: 'number', description: '1-based diff line offset for pagination' },
        limit: { type: 'number', description: 'Maximum diff lines to return in this slice' },
        context_lines: { type: 'number', description: 'Unified diff context lines to request' },
      },
      required: [],
    },
    handler: toolChangedDiff,
    sideEffect: 'readonly',
    toClassifierInput: () => '',
  },
  {
    name: 'changed_diff_bundle',
    workSurface: 'coding',
    description: staticText("tool.changed_diff_bundle.description"),
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
          maxItems: 64,
        },
        offset: { type: 'number', description: '1-based diff line offset applied to each path in the bundle' },
        limit_per_path: { type: 'number', description: 'Maximum diff lines to return per path in this bundle' },
        context_lines: { type: 'number', description: 'Unified diff context lines to request' },
      },
      required: ['paths'],
    },
    handler: toolChangedDiffBundle,
    sideEffect: 'readonly',
    toClassifierInput: () => '',
  },
  {
    name: 'module_context',
    workSurface: 'coding',
    description: staticText("tool.module_context.description"),
    input_schema: {
      type: 'object',
      properties: {
        module: { type: 'string', description: 'Module id, label, or package name to inspect' },
        target_path: { type: 'string', description: 'Optional path used to infer the enclosing module' },
        refresh: { type: 'boolean', description: 'When true, rebuild repo intelligence before returning the module capsule' },
      },
    },
    handler: toolModuleContext,
    sideEffect: 'readonly',
    toClassifierInput: () => '',
  },
  {
    name: 'lsp_definition',
    workSurface: 'coding',
    description: staticText("tool.lsp_definition.description"),
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File containing the symbol' },
        line: { type: 'number', description: '1-based line of the symbol' },
        character: { type: 'number', description: 'Optional 1-based column of the symbol (defaults to the line start)' },
      },
      required: ['path', 'line'],
    },
    handler: toolLspDefinition,
    sideEffect: 'readonly',
    toClassifierInput: () => '',
  },
  {
    name: 'lsp_hover',
    workSurface: 'coding',
    description: staticText("tool.lsp_hover.description"),
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File containing the symbol' },
        line: { type: 'number', description: '1-based line of the symbol' },
        character: { type: 'number', description: 'Optional 1-based column of the symbol' },
      },
      required: ['path', 'line'],
    },
    handler: toolLspHover,
    sideEffect: 'readonly',
    toClassifierInput: () => '',
  },
  {
    name: 'lsp_references',
    workSurface: 'coding',
    description: staticText("tool.lsp_references.description"),
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File containing the symbol' },
        line: { type: 'number', description: '1-based line of the symbol' },
        character: { type: 'number', description: 'Optional 1-based column of the symbol' },
      },
      required: ['path', 'line'],
    },
    handler: toolLspReferences,
    sideEffect: 'readonly',
    toClassifierInput: () => '',
  },
  {
    name: 'lsp_document_symbols',
    workSurface: 'coding',
    description: staticText("tool.lsp_document_symbols.description"),
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File to outline' },
      },
      required: ['path'],
    },
    handler: toolLspDocumentSymbols,
    sideEffect: 'readonly',
    toClassifierInput: () => '',
  },
  {
    name: 'lsp_workspace_symbols',
    workSurface: 'coding',
    description: staticText("tool.lsp_workspace_symbols.description"),
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Symbol query text; may be empty for a broad server-supported listing' },
      },
    },
    handler: toolLspWorkspaceSymbols,
    sideEffect: 'readonly',
    toClassifierInput: () => '',
  },
  {
    name: 'lsp_implementation',
    workSurface: 'coding',
    description: staticText("tool.lsp_implementation.description"),
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File containing the symbol' },
        line: { type: 'number', description: '1-based line of the symbol' },
        character: { type: 'number', description: 'Optional 1-based column of the symbol' },
        column: { type: 'number', description: 'Alias for character' },
      },
      required: ['path', 'line'],
    },
    handler: toolLspImplementation,
    sideEffect: 'readonly',
    toClassifierInput: () => '',
  },
  {
    name: 'lsp_prepare_call_hierarchy',
    workSurface: 'coding',
    description: staticText("tool.lsp_prepare_call_hierarchy.description"),
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File containing the callable symbol' },
        line: { type: 'number', description: '1-based line of the symbol' },
        character: { type: 'number', description: 'Optional 1-based column of the symbol' },
        column: { type: 'number', description: 'Alias for character' },
      },
      required: ['path', 'line'],
    },
    handler: toolLspPrepareCallHierarchy,
    sideEffect: 'readonly',
    toClassifierInput: () => '',
  },
  {
    name: 'lsp_incoming_calls',
    workSurface: 'coding',
    description: staticText("tool.lsp_incoming_calls.description"),
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File containing the callable symbol' },
        line: { type: 'number', description: '1-based line of the symbol' },
        character: { type: 'number', description: 'Optional 1-based column of the symbol' },
        column: { type: 'number', description: 'Alias for character' },
      },
      required: ['path', 'line'],
    },
    handler: toolLspIncomingCalls,
    sideEffect: 'readonly',
    toClassifierInput: () => '',
  },
  {
    name: 'lsp_outgoing_calls',
    workSurface: 'coding',
    description: staticText("tool.lsp_outgoing_calls.description"),
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File containing the callable symbol' },
        line: { type: 'number', description: '1-based line of the symbol' },
        character: { type: 'number', description: 'Optional 1-based column of the symbol' },
        column: { type: 'number', description: 'Alias for character' },
      },
      required: ['path', 'line'],
    },
    handler: toolLspOutgoingCalls,
    sideEffect: 'readonly',
    toClassifierInput: () => '',
  },
  {
    name: 'relationship_scan',
    workSurface: 'coding',
    description: staticText("tool.relationship_scan.description"),
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Optional symbol/function/class name to trace' },
        module: { type: 'string', description: 'Optional module/package label to trace' },
        path: { type: 'string', description: 'Optional repository-relative or absolute path to trace' },
        entry: { type: 'string', description: 'Optional entry symbol or file hint for execution/process tracing' },
        direction: {
          type: 'string',
          enum: ['upstream', 'downstream', 'both'],
          description: 'Relationship direction to emphasize. Defaults to both.',
        },
        depth: {
          type: 'integer',
          minimum: 1,
          maximum: 3,
          description: staticText("tool.relationship_scan.description.1"),
        },
        target_path: { type: 'string', description: 'Optional path used to resolve the repository root or narrow context' },
        refresh: { type: 'boolean', description: 'When true, rebuild repo intelligence before the first relationship lookup' },
        include_lsp: { type: 'boolean', description: 'When true, attach LSP incoming/outgoing call hierarchy evidence when an LSP service is available' },
        include_text_search: { type: 'boolean', description: 'When true, attach bounded exact-name grep evidence for cross-checking static relationships' },
      },
    },
    handler: toolRelationshipScan,
    sideEffect: 'readonly',
    toClassifierInput: () => '',
  },
  {
    name: 'symbol_context',
    workSurface: 'coding',
    description: staticText("tool.symbol_context.description"),
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
    sideEffect: 'readonly',
    toClassifierInput: () => '',
  },
  {
    name: 'process_context',
    workSurface: 'coding',
    description: staticText("tool.process_context.description"),
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
    sideEffect: 'readonly',
    toClassifierInput: () => '',
  },
  {
    name: 'impact_estimate',
    workSurface: 'coding',
    description: staticText("tool.impact_estimate.description"),
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
    sideEffect: 'readonly',
    toClassifierInput: () => '',
  },
  {
    name: 'cyclic_dependencies',
    workSurface: 'coding',
    description: staticText("tool.cyclic_dependencies.description"),
    input_schema: {
      type: 'object',
      properties: {},
    },
    handler: toolCyclicDependencies,
    sideEffect: 'readonly',
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
      staticText("tool.scaffold_tool.text")
      + staticText("tool.scaffold_tool.text.1"),
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
    // Returns a fillable ConstructionArtifact JSON skeleton (you edit it, then
    // stage_construction persists it) — does NOT touch disk, so it is readonly,
    // not mutates-fs (ADR-043 / GPT review: it was mislabeled, which made the
    // Verifier over-fire on a pure draft generator). stage_construction below is
    // the genuine mutates-fs persist step.
    sideEffect: 'readonly',
    toClassifierInput: () => '',
  },
  {
    name: 'validate_tool',
    description:
      staticText("tool.validate_tool.text")
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
    sideEffect: 'readonly',
    toClassifierInput: () => '',
  },
  {
    name: 'stage_construction',
    description:
      staticText("tool.stage_construction.text")
      + 'Run validate_tool first; this tool itself does not re-validate the AST or schema.',
    input_schema: {
      type: 'object',
      properties: {
        artifact_json: { type: 'string', description: 'The full ConstructionArtifact as a JSON string.' },
      },
      required: ['artifact_json'],
    },
    handler: toolStageConstruction,
    sideEffect: 'mutates-fs',
    toClassifierInput: (input) => {
      const i = input as { artifact_json?: string };
      return `StageTool: ${stageArtifactPreview(i?.artifact_json)}`;
    },
  },
  {
    name: 'test_tool',
    description:
      staticText("tool.test_tool.text")
      + staticText("tool.test_tool.text.1"),
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
    sideEffect: 'mutates-state',
    classifierExemptReason: 'Runs the local validation pipeline without activating or expanding capability.',
    toClassifierInput: () => '',
  },
  {
    name: 'activate_tool',
    description:
      staticText("tool.activate_tool.text")
      + 'Policy: in the Ink REPL, the user sees an approve/reject dialog before activation. '
      + staticText("tool.activate_tool.text.1"),
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Artifact name to activate.' },
        version: { type: 'string', description: 'Artifact version to activate.' },
      },
      required: ['name', 'version'],
    },
    handler: toolActivateTool,
    sideEffect: 'mutates-state',
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
      staticText("tool.scaffold_agent.text")
      + staticText("tool.scaffold_agent.text.1"),
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
    // Returns a fillable agent skeleton (no disk write) — readonly, not
    // mutates-fs (mislabel; see scaffold_tool). stage_agent_construction is the
    // genuine persist step.
    sideEffect: 'readonly',
    toClassifierInput: () => '',
  },
  {
    name: 'validate_agent',
    description:
      staticText("tool.validate_agent.text")
      + 'Does NOT touch disk. Use this BEFORE stage_agent_construction to fail fast on rejected manifests.',
    input_schema: {
      type: 'object',
      properties: {
        artifact_json: { type: 'string', description: 'The full AgentArtifact as a JSON string.' },
      },
      required: ['artifact_json'],
    },
    handler: toolValidateAgent,
    sideEffect: 'readonly',
    toClassifierInput: () => '',
  },
  {
    name: 'stage_agent_construction',
    description:
      staticText("tool.stage_agent_construction.text")
      + 'Run validate_agent first; this tool itself does not re-run admission.',
    input_schema: {
      type: 'object',
      properties: {
        artifact_json: { type: 'string', description: 'The full AgentArtifact as a JSON string.' },
      },
      required: ['artifact_json'],
    },
    handler: toolStageAgentConstruction,
    sideEffect: 'mutates-fs',
    toClassifierInput: (input) => {
      const i = input as { artifact_json?: string };
      return `StageAgent: ${stageArtifactPreview(i?.artifact_json)}`;
    },
  },
  {
    name: 'test_agent',
    description:
      staticText("tool.test_agent.text")
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
    sideEffect: 'mutates-state',
    classifierExemptReason: 'Runs the local admission test pipeline without activating the agent.',
    toClassifierInput: () => '',
  },
  {
    name: 'activate_agent',
    description:
      staticText("tool.activate_agent.text")
      + 'and registers the agent in the resolver so Runner.run can find it by name. '
      + 'Policy: in the Ink REPL, the user sees an approve/reject dialog before activation. '
      + staticText("tool.activate_agent.text.1"),
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Agent name to activate.' },
        version: { type: 'string', description: 'Agent version to activate.' },
      },
      required: ['name', 'version'],
    },
    handler: toolActivateAgent,
    sideEffect: 'mutates-state',
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
      + staticText("tool.BUILTIN_TOOL_DEFINITION_SOURCE.text")
      + staticText("tool.BUILTIN_TOOL_DEFINITION_SOURCE.text.1")
      + staticText("tool.BUILTIN_TOOL_DEFINITION_SOURCE.text.2"),
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
    sideEffect: 'mutates-fs',
    toClassifierInput: (input) => {
      const i = input as { artifact_json?: string };
      return `StageSelfModify: ${stageArtifactPreview(i?.artifact_json)}`;
    },
  },
  // FEATURE_189 Batch 3 B.2 — progressive disclosure bootstrap. Always
  // loaded so the LLM can fetch full schemas for deferred web, repo-intel,
  // and workflow tools on demand. See `tool-search.ts` + `deferred-tools.ts`.
  TOOL_DESCRIBE_DEFINITION,
  TOOL_CALL_DEFINITION,
  TOOL_SEARCH_DEFINITION,
];

export const BUILTIN_TOOL_DEFINITIONS: LocalToolDefinition[] =
  [...BUILTIN_TOOL_DEFINITION_SOURCE, ...VISUAL_CODING_TOOLS];
