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
  MEMORY_TOOL_DESCRIPTION,
  MEMORY_TOOL_NAME,
  MEMORY_TOOL_SCHEMA,
  toolMemory,
} from './memory.js';
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

/** Pure, versioned JSON data; loaded once with the existing tool descriptions. */
function toolInputSchema(key: Parameters<typeof staticText>[0]): KodaXToolDefinition['input_schema'] {
  return JSON.parse(staticText(key)) as KodaXToolDefinition['input_schema'];
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
    input_schema: toolInputSchema('tool.read.input_schema'),
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
    name: MEMORY_TOOL_NAME,
    description: MEMORY_TOOL_DESCRIPTION,
    input_schema: MEMORY_TOOL_SCHEMA,
    handler: toolMemory,
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
    input_schema: toolInputSchema('tool.kodax_manual.input_schema'),
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
    input_schema: toolInputSchema('tool.skill.input_schema'),
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
    input_schema: toolInputSchema('tool.run_skill_script.input_schema'),
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
    input_schema: toolInputSchema('tool.edit.input_schema'),
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
    input_schema: toolInputSchema('tool.multi_edit.input_schema'),
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
    input_schema: toolInputSchema('tool.insert_after_anchor.input_schema'),
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
    input_schema: toolInputSchema('tool.bash.input_schema'),
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
    input_schema: toolInputSchema('tool.grep.input_schema'),
    handler: toolGrep,
    sideEffect: 'readonly',
    toClassifierInput: () => '',
  },
  {
    name: 'list_dispatchable_agents',
    description: staticText("tool.list_dispatchable_agents.description"),
    input_schema: toolInputSchema('tool.list_dispatchable_agents.input_schema'),
    handler: toolListDispatchableAgents,
    sideEffect: 'readonly',
    toClassifierInput: () => '',
  },
  {
    name: 'spawn_agent',
    description: staticText("tool.spawn_agent.description"),
    input_schema: toolInputSchema('tool.spawn_agent.input_schema'),
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
    input_schema: toolInputSchema('tool.run_workflow.input_schema'),
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
    input_schema: toolInputSchema('tool.send_message.input_schema'),
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
    input_schema: toolInputSchema('tool.followup_task.input_schema'),
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
    input_schema: toolInputSchema('tool.list_agents.input_schema'),
    handler: toolListAgents,
    sideEffect: 'readonly',
    planModeAllowed: true,
    toClassifierInput: () => '',
  },
  {
    name: 'interrupt_agent',
    description:
      staticText("tool.interrupt_agent.description"),
    input_schema: toolInputSchema('tool.interrupt_agent.input_schema'),
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
    input_schema: toolInputSchema('tool.web_fetch.input_schema'),
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
    input_schema: toolInputSchema('tool.code_search.input_schema'),
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
    input_schema: toolInputSchema('tool.semantic_lookup.input_schema'),
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
    input_schema: toolInputSchema('tool.mcp_search.input_schema'),
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
    input_schema: toolInputSchema('tool.worktree_remove.input_schema'),
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
    input_schema: toolInputSchema('tool.ask_user_question.input_schema'),
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
    input_schema: toolInputSchema('tool.update_goal.input_schema'),
    handler: toolUpdateGoal,
    sideEffect: 'mutates-state',
    planModeAllowed: false,
    classifierExemptReason: 'Updates only session-local goal status; the persistent blocker counter is enforced by the runtime.',
    toClassifierInput: () => '',
  },
  {
    name: 'exit_plan_mode',
    description: staticText("tool.exit_plan_mode.description"),
    input_schema: toolInputSchema('tool.exit_plan_mode.input_schema'),
    handler: toolExitPlanMode,
    sideEffect: 'mutates-state',
    planModeAllowed: true,
    classifierExemptReason: 'Already requires a dedicated interactive plan-approval boundary.',
    toClassifierInput: () => '',
  },
  {
    name: 'todo_update',
    description: staticText("tool.todo_update.description"),
    input_schema: toolInputSchema('tool.todo_update.input_schema'),
    handler: toolTodoUpdate,
    sideEffect: 'mutates-state',
    planModeAllowed: true,
    classifierExemptReason: 'Mutates only the visible session-local progress checklist.',
    toClassifierInput: () => '',
  },
  {
    name: 'todo_create',
    description: staticText("tool.todo_create.description"),
    input_schema: toolInputSchema('tool.todo_create.input_schema'),
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
    input_schema: toolInputSchema('tool.repo_overview.input_schema'),
    handler: toolRepoOverview,
    sideEffect: 'readonly',
    toClassifierInput: () => '',
  },
  {
    name: 'changed_scope',
    workSurface: 'coding',
    description: staticText("tool.changed_scope.description"),
    input_schema: toolInputSchema('tool.changed_scope.input_schema'),
    handler: toolChangedScope,
    sideEffect: 'readonly',
    toClassifierInput: () => '',
  },
  {
    name: 'changed_diff',
    workSurface: 'coding',
    description: staticText("tool.changed_diff.description"),
    input_schema: toolInputSchema('tool.changed_diff.input_schema'),
    handler: toolChangedDiff,
    sideEffect: 'readonly',
    toClassifierInput: () => '',
  },
  {
    name: 'changed_diff_bundle',
    workSurface: 'coding',
    description: staticText("tool.changed_diff_bundle.description"),
    input_schema: toolInputSchema('tool.changed_diff_bundle.input_schema'),
    handler: toolChangedDiffBundle,
    sideEffect: 'readonly',
    toClassifierInput: () => '',
  },
  {
    name: 'module_context',
    workSurface: 'coding',
    description: staticText("tool.module_context.description"),
    input_schema: toolInputSchema('tool.module_context.input_schema'),
    handler: toolModuleContext,
    sideEffect: 'readonly',
    toClassifierInput: () => '',
  },
  {
    name: 'lsp_definition',
    workSurface: 'coding',
    description: staticText("tool.lsp_definition.description"),
    input_schema: toolInputSchema('tool.lsp_definition.input_schema'),
    handler: toolLspDefinition,
    sideEffect: 'readonly',
    toClassifierInput: () => '',
  },
  {
    name: 'lsp_hover',
    workSurface: 'coding',
    description: staticText("tool.lsp_hover.description"),
    input_schema: toolInputSchema('tool.lsp_hover.input_schema'),
    handler: toolLspHover,
    sideEffect: 'readonly',
    toClassifierInput: () => '',
  },
  {
    name: 'lsp_references',
    workSurface: 'coding',
    description: staticText("tool.lsp_references.description"),
    input_schema: toolInputSchema('tool.lsp_references.input_schema'),
    handler: toolLspReferences,
    sideEffect: 'readonly',
    toClassifierInput: () => '',
  },
  {
    name: 'lsp_document_symbols',
    workSurface: 'coding',
    description: staticText("tool.lsp_document_symbols.description"),
    input_schema: toolInputSchema('tool.lsp_document_symbols.input_schema'),
    handler: toolLspDocumentSymbols,
    sideEffect: 'readonly',
    toClassifierInput: () => '',
  },
  {
    name: 'lsp_workspace_symbols',
    workSurface: 'coding',
    description: staticText("tool.lsp_workspace_symbols.description"),
    input_schema: toolInputSchema('tool.lsp_workspace_symbols.input_schema'),
    handler: toolLspWorkspaceSymbols,
    sideEffect: 'readonly',
    toClassifierInput: () => '',
  },
  {
    name: 'lsp_implementation',
    workSurface: 'coding',
    description: staticText("tool.lsp_implementation.description"),
    input_schema: toolInputSchema('tool.lsp_implementation.input_schema'),
    handler: toolLspImplementation,
    sideEffect: 'readonly',
    toClassifierInput: () => '',
  },
  {
    name: 'lsp_prepare_call_hierarchy',
    workSurface: 'coding',
    description: staticText("tool.lsp_prepare_call_hierarchy.description"),
    input_schema: toolInputSchema('tool.lsp_prepare_call_hierarchy.input_schema'),
    handler: toolLspPrepareCallHierarchy,
    sideEffect: 'readonly',
    toClassifierInput: () => '',
  },
  {
    name: 'lsp_incoming_calls',
    workSurface: 'coding',
    description: staticText("tool.lsp_incoming_calls.description"),
    input_schema: toolInputSchema('tool.lsp_incoming_calls.input_schema'),
    handler: toolLspIncomingCalls,
    sideEffect: 'readonly',
    toClassifierInput: () => '',
  },
  {
    name: 'lsp_outgoing_calls',
    workSurface: 'coding',
    description: staticText("tool.lsp_outgoing_calls.description"),
    input_schema: toolInputSchema('tool.lsp_outgoing_calls.input_schema'),
    handler: toolLspOutgoingCalls,
    sideEffect: 'readonly',
    toClassifierInput: () => '',
  },
  {
    name: 'relationship_scan',
    workSurface: 'coding',
    description: staticText("tool.relationship_scan.description"),
    input_schema: toolInputSchema('tool.relationship_scan.input_schema'),
    handler: toolRelationshipScan,
    sideEffect: 'readonly',
    toClassifierInput: () => '',
  },
  {
    name: 'symbol_context',
    workSurface: 'coding',
    description: staticText("tool.symbol_context.description"),
    input_schema: toolInputSchema('tool.symbol_context.input_schema'),
    handler: toolSymbolContext,
    sideEffect: 'readonly',
    toClassifierInput: () => '',
  },
  {
    name: 'process_context',
    workSurface: 'coding',
    description: staticText("tool.process_context.description"),
    input_schema: toolInputSchema('tool.process_context.input_schema'),
    handler: toolProcessContext,
    sideEffect: 'readonly',
    toClassifierInput: () => '',
  },
  {
    name: 'impact_estimate',
    workSurface: 'coding',
    description: staticText("tool.impact_estimate.description"),
    input_schema: toolInputSchema('tool.impact_estimate.input_schema'),
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
    input_schema: toolInputSchema('tool.scaffold_tool.input_schema'),
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
    input_schema: toolInputSchema('tool.validate_tool.input_schema'),
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
    input_schema: toolInputSchema('tool.test_tool.input_schema'),
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
    input_schema: toolInputSchema('tool.scaffold_agent.input_schema'),
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
