import { describe, expect, it } from 'vitest';
import { renderAmaPatternPlaybook } from '../orchestration/pattern-catalog.js';
import { createTodoStore } from '../task-engine/todo-store.js';
import {
  executeTool,
  getAllRegisteredTools,
  getTool,
  getRequiredToolParams,
  getToolDefinition,
  isToolFileMutation,
  isToolMutation,
  isToolNetworkRead,
  isToolPlanModeAllowed,
  listBuiltinToolDefinitions,
  registerTool,
} from './index.js';
import type { KodaXToolExecutionContext } from '../types.js';
import type { LocalToolDefinition } from './types.js';

const TEST_CONTEXT: KodaXToolExecutionContext = {
  backups: new Map(),
  executionCwd: process.cwd(),
};

describe('tool registry', () => {
  it('keeps internal legacy todo initialization and subsequent incremental execution available', async () => {
    const store = createTodoStore();
    const ctx = { ...TEST_CONTEXT, todoStore: store };
    const seeded = await executeTool('todo_update', {
      op: 'init', items: [{ id: 'seed_1', subject: 'Verify the change' }],
    }, ctx);
    expect(JSON.parse(seeded as string)).toEqual({ ok: true, count: 1 });
    const updated = await executeTool('todo_update', { id: 'seed_1', description: 'Inspect the rendered artifact' }, ctx);
    expect(JSON.parse(updated as string)).toMatchObject({ ok: true });
    expect(store.getAll()).toMatchObject([{ id: 'seed_1', description: 'Inspect the rendered artifact', status: 'pending' }]);
  });

  it('executes questions-only requests through the registry without a redundant single question', async () => {
    const result = await executeTool('ask_user_question', {
      questions: [{ question: 'Color?', options: [{ label: 'Blue', value: 'blue' }] }],
    }, {
      ...TEST_CONTEXT,
      askUserMulti: async () => ({ color: 'blue' }),
    });

    expect(JSON.parse(result as string)).toEqual({
      success: true,
      answers: { color: 'blue' },
    });
    expect(getToolDefinition('ask_user_question')?.input_schema.properties).not.toHaveProperty('agent_id');
  });

  it('makes the resident spawn surface explicit for broad read-only review fan-out', () => {
    const description = getToolDefinition('spawn_agent')?.description ?? '';

    expect(description).toContain('broad multi-file review');
    expect(description).toContain('distinct read-only lanes');
    expect(description).toContain('generated outputs');
    expect(description).toContain('disjoint write ownership');
    expect(description).toContain('read_only:false');
    expect(description).toMatch(/shared isolation \(default\)/);
    expect(description).toContain('exact exclusive paths');
    expect(description).toMatch(/Shared edits.*root workspace.*do not reapply/);
    expect(description).toContain('explicit merge-back strategy');
  });

  it('keeps changed_scope limited to change-set review surfaces', () => {
    const description = getToolDefinition('changed_scope')?.description ?? '';

    expect(description).toContain('current-worktree');
    expect(description).toContain('change-set review');
    expect(description).toContain('Do not use it to expand an explicitly scoped');
    expect(description).not.toContain('canonical entry point for any review');
  });

  it('F274: keeps the dormant catalog renderer and optional telemetry schemas within budget', () => {
    const schemaDeltas = ['spawn_agent', 'followup_task'].map((name) => {
      const definition = getToolDefinition(name);
      if (definition === undefined) throw new Error(`${name} tool definition is missing`);
      const baselineSchema = structuredClone(definition.input_schema) as {
        readonly type: string;
        readonly properties: Readonly<Record<string, unknown>>;
        readonly required?: readonly string[];
      };
      const {
        quality_strategy: qualityStrategySchema,
        ...baselineProperties
      } = baselineSchema.properties;
      expect(qualityStrategySchema, `${name}.quality_strategy`).toBeDefined();
      return Buffer.byteLength(JSON.stringify(definition.input_schema), 'utf8')
        - Buffer.byteLength(JSON.stringify({
          ...baselineSchema,
          properties: baselineProperties,
        }), 'utf8');
    });
    const promptDelta = Buffer.byteLength(
      `\n\n${renderAmaPatternPlaybook()}`,
      'utf8',
    );
    const toolSchemaDelta = schemaDeltas.reduce((total, delta) => total + delta, 0);
    const staticInputDelta = promptDelta + toolSchemaDelta;

    expect({ promptDelta, schemaDeltas, toolSchemaDelta, staticInputDelta }).toEqual({
      promptDelta: 2_418,
      schemaDeltas: [257, 215],
      toolSchemaDelta: 472,
      staticInputDelta: 2_890,
    });
    expect(staticInputDelta).toBeLessThanOrEqual(3_000);
  });

  it('FEATURE_075: exit_plan_mode plan description enforces structural length budget', () => {
    // LLM-first defense against oversized plans that blow past terminal
    // height. Scroll in the approval dialog is the mechanical fallback.
    // FEATURE_189 Batch 4 audit kept the quantitative anchors here: 3-judge
    // pilot showed dropping "40 lines / 3 depth / 1 sentence per bullet"
    // triggers verbosity drift (multi-paragraph bullets / >5000 chars). The
    // anchor is load-bearing for this tool description.
    const def = getToolDefinition('exit_plan_mode');
    const planSchema = (def?.input_schema as {
      properties?: { plan?: { description?: string } };
    } | undefined)?.properties?.plan;
    const desc = planSchema?.description ?? '';

    expect(desc).toMatch(/40 lines/);
    expect(desc).toMatch(/3 bullet-depth|3 levels|3 depth/i);
    expect(desc).toMatch(/one sentence|1 sentence|single sentence/i);
    expect(desc).toMatch(/phases|split/i);
  });

  it('F270: spawn_agent schema exposes optional specialist and effort fields', () => {
    const def = getToolDefinition('spawn_agent');
    const props = (def?.input_schema as {
      properties?: Record<string, { type?: string; description?: string }>;
      required?: readonly string[];
    } | undefined)?.properties;
    const required = (def?.input_schema as { required?: readonly string[] } | undefined)?.required ?? [];

    expect(props).toBeDefined();
    expect(props?.agent_id?.type).toBe('string');
    expect(props?.effort?.type).toBe('string');
    expect(props?.effort?.description).toMatch(/Reasoning effort/);
    expect(props?.model_hint?.description).toMatch(/Routing tier/);
    expect(props?.model_hint?.description).toMatch(/fast.*focused lookups/);
    expect(props?.model_hint?.description).toMatch(/deep.*multi-file/);
    expect(props?.model_hint?.description).toMatch(/Unconfigured tiers.*inherited provider\/model/);
    expect(props?.model_hint?.description).not.toMatch(/no-op|future routing/i);
    expect(required).not.toContain('agent_id');
    expect(required).not.toContain('effort');
  });

  it('FEATURE_191 A.0: KodaXChildContextBundle declares optional specialistName field', () => {
    // Type-level guard — the bundle must carry specialistName from
    // toolDispatchChildTask through executeChildAgents to
    // executeReadChild/executeWriteChild. Compile-time check via
    // structural assignment in TypeScript; runtime smoke verifies the
    // field accepts a string.
    const bundle: import('../types.js').KodaXChildContextBundle = {
      id: 'test',
      fanoutClass: 'read' as import('../types.js').KodaXChildFanoutClass,
      objective: 'noop',
      evidenceRefs: [],
      constraints: [],
      readOnly: true,
      specialistName: 'db-reviewer',
    };
    expect(bundle.specialistName).toBe('db-reviewer');
  });

  it('FEATURE_191 A.0b: AgentContent declares optional description field', () => {
    // Compile-time check via structural assignment; runtime asserts the
    // object accepts the field. Aligns with FEATURE_089 minimal-agent
    // pattern (only `instructions` required).
    const content: import('../construction/types.js').AgentContent = {
      instructions: 'noop',
      description: 'Reviews DB migrations for safety',
    };
    expect(content.description).toBe('Reviews DB migrations for safety');
  });

  it('derives required params from the active tool schema', () => {
    expect(getRequiredToolParams('read')).toEqual(['path']);
    expect(getRequiredToolParams('ask_user_question')).toEqual([]);
    expect(getRequiredToolParams('web_search')).toEqual(['query']);
    expect(getRequiredToolParams('code_search')).toEqual(['query']);
    expect(getRequiredToolParams('semantic_lookup')).toEqual(['query']);
    expect(getRequiredToolParams('mcp_search')).toEqual([]);
    expect(getRequiredToolParams('mcp_describe')).toEqual(['id']);
    expect(getRequiredToolParams('mcp_call')).toEqual(['id']);
    expect(getRequiredToolParams('mcp_read_resource')).toEqual(['id']);
    // The handler validates legacy path vs canonical paths; neither branch is globally required.
    expect(getRequiredToolParams('changed_diff')).toEqual([]);
    expect(getRequiredToolParams('changed_diff_bundle')).toEqual(['paths']);
    expect(getRequiredToolParams('insert_after_anchor')).toEqual(['path', 'anchor', 'content']);
  });

  it('keeps built-in web search independent from extension capability catalogs', () => {
    const webSearch = listBuiltinToolDefinitions().find((tool) => tool.name === 'web_search');

    expect(webSearch?.input_schema.properties).not.toHaveProperty('provider_id');
    expect(webSearch?.input_schema.properties).toHaveProperty('query');
    expect(webSearch?.input_schema.properties).toHaveProperty('limit');
  });

  it('keeps MCP tool descriptions on the canonical capability id format', () => {
    const descriptions = [
      'mcp_search',
      'mcp_call',
      'mcp_read_resource',
      'mcp_get_prompt',
    ]
      .map((name) => getToolDefinition(name)?.description ?? '')
      .join('\n');

    expect(descriptions).toContain('mcp:<server-id>:<kind>:<capability-name>');
    expect(descriptions).toContain('including the `mcp:` prefix');
    expect(descriptions).not.toContain('server.name');
    expect(descriptions).not.toContain('server.tool');
    expect(descriptions).not.toContain('mcp://<serverId>');
  });

  it('supports same-name override and restore via disposer', async () => {
    const originalHandler = getTool('read');
    const dispose = registerTool({
      name: 'read',
      description: 'Test override',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
        },
        required: ['path'],
      },
      handler: async (input) => `override:${String(input.path)}`,
      sideEffect: 'readonly',
      toClassifierInput: () => '',
    });

    await expect(
      executeTool('read', { path: '/tmp/demo.txt' }, TEST_CONTEXT),
    ).resolves.toBe('override:/tmp/demo.txt');

    dispose();

    expect(getTool('read')).toBe(originalHandler);
  });

  it('normalizes legacy JavaScript tools to a fail-closed classifier contract', () => {
    const dispose = registerTool({
      name: 'legacy_writer_without_metadata',
      description: 'Legacy JavaScript extension shape',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
      },
      handler: async () => 'ok',
    } as unknown as LocalToolDefinition);

    try {
      const definition = getAllRegisteredTools()
        .find((tool) => tool.name === 'legacy_writer_without_metadata');
      const projection = definition?.toClassifierInput({
        path: 'src/a.ts',
        content: 'PRIVATE_EXTENSION_BODY',
      });

      expect(definition?.sideEffect).toBe('mutates-state');
      expect(projection).toContain('path=src/a.ts');
      expect(projection).toContain('content_chars=22');
      expect(projection).not.toContain('PRIVATE_EXTENSION_BODY');
    } finally {
      dispose();
    }
  });

  it('does not let a non-readonly extension bypass classification with an accidental empty projection', () => {
    const dispose = registerTool({
      name: 'extension_with_empty_projection',
      description: 'Mutating extension',
      input_schema: { type: 'object', properties: { path: { type: 'string' } } },
      handler: async () => 'ok',
      sideEffect: 'mutates-fs',
      toClassifierInput: () => '',
    });

    try {
      const definition = getAllRegisteredTools()
        .find((tool) => tool.name === 'extension_with_empty_projection');
      expect(definition?.toClassifierInput({ path: 'src/a.ts' }))
        .toContain('path=src/a.ts');
    } finally {
      dispose();
    }
  });
});

// v0.7.42 — tool sideEffect metadata + plan-mode-allowed predicate.
//
// Closes gap 2 (KodaX Space): every built-in tool now declares
// `sideEffect` and (optionally) `planModeAllowed`, so SDK consumers can
// build dynamic blocklists instead of hardcoding tool-name `Set`s that
// silently drift.
describe('v0.7.42 — tool sideEffect metadata', () => {
  it('every built-in tool declares a sideEffect', () => {
    const builtins = listBuiltinToolDefinitions();
    expect(builtins.length).toBeGreaterThan(20); // sanity: shouldn't shrink
    for (const tool of builtins) {
      expect(
        tool.sideEffect,
        `built-in tool "${tool.name}" is missing sideEffect`,
      ).toBeDefined();
      expect(
        ['readonly', 'reads-network', 'mutates-fs', 'mutates-shell', 'mutates-network', 'mutates-state'],
      ).toContain(tool.sideEffect);
    }
  });

  it('readonly tools bypass the Auto[LLM] classifier', () => {
    for (const tool of listBuiltinToolDefinitions()) {
      if (tool.sideEffect !== 'readonly') continue;
      expect(
        tool.toClassifierInput({}),
        `readonly tool "${tool.name}" must have an empty classifier projection`,
      ).toBe('');
    }
  });

  it('requires an explicit exemption for non-readonly tools with empty projections', () => {
    for (const tool of listBuiltinToolDefinitions()) {
      if (tool.sideEffect === 'readonly') continue;
      if (tool.toClassifierInput({}) !== '') continue;
      expect(
        tool.classifierExemptReason,
        `non-readonly tool "${tool.name}" needs an explicit classifier exemption`,
      ).toBeTruthy();
    }
  });

  it('surfaces risk-bearing fields for high-impact built-in tools', () => {
    const projection = (name: string, input: Record<string, unknown>): string => {
      const tool = listBuiltinToolDefinitions().find((entry) => entry.name === name);
      expect(tool, `missing built-in ${name}`).toBeDefined();
      return tool!.toClassifierInput(input);
    };

    expect(projection('run_skill_script', {
      skill: 'reports',
      script: 'render.py',
      args: ['--delete-stale'],
      inputs: [{ path: 'data/input.csv', as: 'input.csv' }],
      outputs: [{ path: 'report.pdf', target: 'deliverables/report.pdf' }],
    })).toMatch(/--delete-stale.*data\/input\.csv.*deliverables\/report\.pdf/);
    const longSkillPath = `C:/workspace/${'nested/'.repeat(30)}source-tail.csv`;
    const longSkillProjection = projection('run_skill_script', {
      skill: 'reports',
      script: 'render.py',
      inputs: [{ path: longSkillPath, as: 'staged.csv' }],
    });
    expect(longSkillProjection).toContain('C:/workspace/');
    expect(longSkillProjection).toContain('source-tail.csv');

    expect(projection('run_workflow', {
      manifest: {
        name: 'writer', readOnly: false, maxAgents: 6, maxConcurrency: 3,
        patterns: ['pipeline'],
      },
      source: 'async function run(wf) { return wf.runAgent({ readOnly: false }); }',
      args: { request: 'private body' },
    })).toMatch(/readOnly=false.*maxAgents=6.*maxConcurrency=3.*source_chars=/);
    expect(projection('run_workflow', {
      manifest: { name: 'writer', readOnly: false },
      source: 'PRIVATE_WORKFLOW_SOURCE',
      args: { request: 'PRIVATE_WORKFLOW_ARGUMENT' },
    })).not.toMatch(/PRIVATE_WORKFLOW_(SOURCE|ARGUMENT)/);

    const spawnProjection = projection('spawn_agent', {
      task_name: 'reviewer', objective: 'PRIVATE_AGENT_OBJECTIVE', read_only: false,
      scope: 'packages/auth', evidence_refs: ['file:packages/auth/src/index.ts'],
      constraints: ['PRIVATE_AGENT_CONSTRAINT'], model_hint: 'deep',
      isolation: 'worktree', provider: 'zai', model: 'glm-5',
    });
    expect(spawnProjection).toMatch(
      /task=reviewer.*scope=packages\/auth.*isolation=worktree.*provider=zai.*model=glm-5.*model_hint=deep/,
    );
    expect(spawnProjection).toContain('evidence=[file:packages/auth/src/index.ts]');
    expect(spawnProjection).toContain('objective_chars=23');
    expect(spawnProjection).toContain('constraints_count=1');
    expect(spawnProjection).not.toMatch(/PRIVATE_AGENT_(OBJECTIVE|CONSTRAINT)/);

    const followupProjection = projection('followup_task', {
      target: 'reviewer', objective: 'PRIVATE_FOLLOWUP_OBJECTIVE',
    });
    expect(followupProjection).toMatch(/target=reviewer.*objective_chars=26/);
    expect(followupProjection).not.toContain('PRIVATE_FOLLOWUP_OBJECTIVE');
    expect(projection('interrupt_agent', {
      target: 'reviewer', scope: 'subtree', reason: 'user redirected',
    })).toContain('scope=subtree');
    const sendProjection = projection('send_message', {
      to: 'reviewer', classification: 'sensitive', content: 'PRIVATE_AGENT_MESSAGE',
    });
    expect(sendProjection).toMatch(/target=reviewer.*classification=sensitive.*content_chars=21/);
    expect(sendProjection).not.toContain('PRIVATE_AGENT_MESSAGE');
    expect(projection('web_fetch', {
      provider_id: 'remote-fetch', capability_id: 'fetch:get',
    })).toMatch(/provider=remote-fetch.*capability=fetch:get/);
    expect(projection('web_search', {
      query: 'current API documentation',
    })).toBe('WebSearch query=current API documentation');
    expect(projection('code_search', {
      query: 'local symbol', path: 'src',
    })).toBe('');
    expect(projection('code_search', {
      query: 'remote symbol', path: 'src', provider_id: 'remote-code',
    })).toMatch(/remote symbol.*provider=remote-code/);
    const worktreeProjection = projection('worktree_create', {
      description: 'PRIVATE_WORKTREE_DESCRIPTION',
    });
    expect(worktreeProjection).toContain('description_chars=28');
    expect(worktreeProjection).not.toContain('PRIVATE_WORKTREE_DESCRIPTION');
    expect(projection('mcp_get_prompt', {
      id: 'mcp:prompts:prompt:release',
      args: { path: 'docs/release.md', body: 'PRIVATE_PROMPT_BODY' },
    })).toMatch(/path=docs\/release.md.*body_chars=19/);
    expect(projection('mcp_get_prompt', {
      id: 'mcp:prompts:prompt:release',
      args: { body: 'PRIVATE_PROMPT_BODY' },
    })).not.toContain('PRIVATE_PROMPT_BODY');
  });

  it('only projects semantic_lookup when refresh rebuilds the index', () => {
    const semanticLookup = listBuiltinToolDefinitions()
      .find((tool) => tool.name === 'semantic_lookup');

    expect(semanticLookup?.toClassifierInput({ query: 'actor routing' })).toBe('');
    expect(semanticLookup?.toClassifierInput({
      query: 'actor routing',
      refresh: true,
    })).toContain('refresh=true');
    expect(semanticLookup?.toClassifierInput({
      query: 'PRIVATE_LOCAL_QUERY',
      refresh: true,
    })).not.toContain('PRIVATE_LOCAL_QUERY');
  });

  it('classifies read/glob/grep as readonly', () => {
    for (const name of ['read', 'glob', 'grep', 'code_search', 'todo_list', 'todo_get']) {
      const tool = listBuiltinToolDefinitions().find((t) => t.name === name);
      expect(tool?.sideEffect, `${name} sideEffect`).toBe('readonly');
    }
  });

  it('classifies write/edit/multi_edit/insert_after_anchor/undo as mutates-fs', () => {
    for (const name of ['write', 'edit', 'multi_edit', 'insert_after_anchor', 'undo']) {
      const tool = listBuiltinToolDefinitions().find((t) => t.name === name);
      expect(tool?.sideEffect, `${name} sideEffect`).toBe('mutates-fs');
    }
  });

  it('classifies bash as mutates-shell (its own category)', () => {
    const bash = listBuiltinToolDefinitions().find((t) => t.name === 'bash');
    expect(bash?.sideEffect).toBe('mutates-shell');
  });

  it('classifies mcp_call as mutates-network', () => {
    const mcpCall = listBuiltinToolDefinitions().find((t) => t.name === 'mcp_call');
    expect(mcpCall?.sideEffect).toBe('mutates-network');
  });

  // FEATURE_247 (R9): read-only network research is a distinct side-effect
  // class so a Partner/permission policy can allow research while blocking
  // mutating network calls.
  it('classifies network retrieval tools as reads-network', () => {
    for (const name of ['web_search', 'web_fetch', 'mcp_read_resource', 'mcp_get_prompt']) {
      const tool = listBuiltinToolDefinitions().find((t) => t.name === name);
      expect(tool?.sideEffect, `${name} sideEffect`).toBe('reads-network');
    }
  });

  it('isToolNetworkRead: true only for reads-network tools, false for mutating network tools', () => {
    expect(isToolNetworkRead('web_search')).toBe(true);
    expect(isToolNetworkRead('mcp_read_resource')).toBe(true);
    expect(isToolNetworkRead('mcp_get_prompt')).toBe(true);
    expect(isToolNetworkRead('web_fetch')).toBe(true);
    expect(isToolNetworkRead('mcp_call')).toBe(false);
    expect(isToolNetworkRead('read')).toBe(false);
    expect(isToolNetworkRead('totally_unknown_tool')).toBe(false); // fail-closed
  });

  it('reclassification preserves existing semantics: reads-network stays plan-allowed + mutation-true + not-fs', () => {
    // planModeAllowed unchanged (research-during-plan still permitted)
    expect(isToolPlanModeAllowed('web_search')).toBe(true);
    expect(isToolPlanModeAllowed('mcp_read_resource')).toBe(true);
    // isToolMutation still treats non-readonly as mutating (no gate regression)
    expect(isToolMutation('web_search')).toBe(true);
    // not a filesystem mutation
    expect(isToolFileMutation('web_search')).toBe(false);
  });

  it('marks plan-loop tools planModeAllowed: true', () => {
    const planLoopTools = [
      'exit_plan_mode',
      'wait_agent',
      'interrupt_agent',
      'list_agents',
      'agent_output',
      'todo_update',
      'todo_create',
      'todo_list',
      'todo_get',
      'ask_user_question',
    ];
    for (const name of planLoopTools) {
      const tool = listBuiltinToolDefinitions().find((t) => t.name === name);
      expect(
        tool?.planModeAllowed,
        `${name} should be planModeAllowed: true`,
      ).toBe(true);
    }
  });

  it('marks network-query tools planModeAllowed: true (research-during-plan)', () => {
    const queryTools = ['web_search', 'mcp_search', 'mcp_describe', 'mcp_read_resource', 'mcp_get_prompt'];
    for (const name of queryTools) {
      const tool = listBuiltinToolDefinitions().find((t) => t.name === name);
      expect(
        tool?.planModeAllowed,
        `${name} should be planModeAllowed: true (network query)`,
      ).toBe(true);
    }
  });

  it('does NOT mark mutating network/FS tools planModeAllowed', () => {
    const blockedInPlan = ['web_fetch', 'mcp_call', 'write', 'edit', 'multi_edit', 'worktree_create'];
    for (const name of blockedInPlan) {
      const tool = listBuiltinToolDefinitions().find((t) => t.name === name);
      expect(
        tool?.planModeAllowed,
        `${name} should NOT be planModeAllowed`,
      ).not.toBe(true);
    }
  });
});

describe('v0.7.42 — query API for SDK embedders', () => {
  it('getAllRegisteredTools returns every active registration sorted by name', () => {
    const all = getAllRegisteredTools();
    expect(all.length).toBeGreaterThan(20);
    const names = all.map((t) => t.name);
    expect(names).toEqual([...names].sort());
    expect(names).toContain('read');
    expect(names).toContain('write');
    expect(names).toContain('bash');
  });

  it('isToolPlanModeAllowed: readonly tools permitted', () => {
    expect(isToolPlanModeAllowed('read')).toBe(true);
    expect(isToolPlanModeAllowed('glob')).toBe(true);
    expect(isToolPlanModeAllowed('grep')).toBe(true);
  });

  it('isToolPlanModeAllowed: explicit planModeAllowed:true overrides non-readonly', () => {
    expect(isToolPlanModeAllowed('skill')).toBe(true);
    expect(isToolPlanModeAllowed('exit_plan_mode')).toBe(true);
    expect(isToolPlanModeAllowed('todo_update')).toBe(true);
    expect(isToolPlanModeAllowed('wait_agent')).toBe(true);
    expect(isToolPlanModeAllowed('interrupt_agent')).toBe(true);
    expect(isToolPlanModeAllowed('web_search')).toBe(true);
  });

  it('isToolPlanModeAllowed: mutating tools without override blocked', () => {
    expect(isToolPlanModeAllowed('write')).toBe(false);
    expect(isToolPlanModeAllowed('edit')).toBe(false);
    expect(isToolPlanModeAllowed('multi_edit')).toBe(false);
    expect(isToolPlanModeAllowed('bash')).toBe(false);
    expect(isToolPlanModeAllowed('worktree_create')).toBe(false);
    expect(isToolPlanModeAllowed('spawn_agent')).toBe(false);
    expect(isToolPlanModeAllowed('web_fetch')).toBe(false);
    expect(isToolPlanModeAllowed('mcp_call')).toBe(false);
  });

  it('isToolPlanModeAllowed: unknown tools fail-closed (blocked)', () => {
    expect(isToolPlanModeAllowed('this_tool_does_not_exist')).toBe(false);
    expect(isToolPlanModeAllowed('')).toBe(false);
  });

  it('isToolFileMutation: only mutates-fs tools', () => {
    expect(isToolFileMutation('write')).toBe(true);
    expect(isToolFileMutation('edit')).toBe(true);
    expect(isToolFileMutation('multi_edit')).toBe(true);
    expect(isToolFileMutation('insert_after_anchor')).toBe(true);
    expect(isToolFileMutation('undo')).toBe(true);
    expect(isToolFileMutation('worktree_create')).toBe(true);

    expect(isToolFileMutation('read')).toBe(false);
    expect(isToolFileMutation('bash')).toBe(false); // mutates-shell, not mutates-fs
    expect(isToolFileMutation('web_search')).toBe(false);
    expect(isToolFileMutation('spawn_agent')).toBe(false);
  });

  it('isToolMutation: anything non-readonly returns true', () => {
    expect(isToolMutation('write')).toBe(true);
    expect(isToolMutation('bash')).toBe(true);
    expect(isToolMutation('web_fetch')).toBe(true);
    expect(isToolMutation('spawn_agent')).toBe(true);
    expect(isToolMutation('exit_plan_mode')).toBe(true); // mutates-state

    expect(isToolMutation('read')).toBe(false);
    expect(isToolMutation('grep')).toBe(false);
    expect(isToolMutation('todo_list')).toBe(false);

    // Unknown: fail-closed (assume mutating)
    expect(isToolMutation('totally_unknown_tool')).toBe(true);
  });
});
