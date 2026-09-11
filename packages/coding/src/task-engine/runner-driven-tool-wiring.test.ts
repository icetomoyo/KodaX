/**
 * FEATURE_168 (v0.7.40 hotfix) — AMA agent tool-wiring contract tests.
 *
 * Pins the runtime tool surface of each AMA role to the
 * `getAmaRoleExpectedToolNames(role)` derivation (registry minus
 * `AMA_BASELINE_EXCLUDE ∪ <ROLE>_EXTRA_EXCLUDE`).
 *
 * Why this file exists: before FEATURE_168 the per-role tool lists were
 * manually push'd into agent.tools arrays in runner-driven.ts. Three separate
 * features (FEATURE_120 send_message/task_stop, FEATURE_161 4 of 8 repo-intel
 * pull tools, FEATURE_168 4 web tools) silently dropped tools from production
 * AMA agents because no test asserted "the runtime agent.tools array contains
 * a schema entry with this name". This file closes that hole.
 *
 * FEATURE_184 (v0.7.42) Phase C.1: Evaluator removed from AmaRole.
 * FEATURE_193 (v0.7.43): V1 chain (Scout/Planner/Generator) retired —
 * only Worker remains. The scout/planner/generator role wiring tests were
 * deleted alongside the V1 chain agent declarations.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunnableTool } from '@kodax-ai/agent';

import {
  type AmaRole,
  buildRunnerAgentChain,
  getAmaRoleEffectiveExclude,
  getAmaRoleExpectedToolNames,
} from './runner-driven.js';
import {
  getToolDefinition,
  listToolDefinitions,
  MCP_TOOL_NAMES,
  registerTool,
} from '../tools/registry.js';
import { DEFERRED_TOOL_HINTS } from '../tools/deferred-tools.js';
import { createExtensionRuntime } from '../extensions/index.js';
import type { KodaXEvents, KodaXToolExecutionContext } from '../types.js';

const cleanupToolRegistrations: Array<() => void> = [];

afterEach(() => {
  while (cleanupToolRegistrations.length > 0) {
    cleanupToolRegistrations.pop()?.();
  }
});

// FEATURE_246: the standard workflow-capable Worker is the AMAW (or AMA
// /workflow-command-elevated) Worker, whose ctx carries a workflowHost. run_workflow
// is host-conditional now — visible only when the host is wired — so the default
// test ctx includes one. A separate test pins the no-host (plain AMA) surface.
function makeCtx(hasCapabilityRuntime = true, hasWorkflowHost = true): KodaXToolExecutionContext {
  return {
    backups: new Map<string, string>(),
    gitRoot: process.cwd(),
    executionCwd: process.cwd(),
    ...(hasCapabilityRuntime
      ? { extensionRuntime: {} as KodaXToolExecutionContext['extensionRuntime'] }
      : {}),
    ...(hasWorkflowHost
      ? { workflowHost: {} as KodaXToolExecutionContext['workflowHost'] }
      : {}),
  };
}

function makeHistoryCtx(): KodaXToolExecutionContext {
  return {
    ...makeCtx(),
    loadSessionHistory: async () => null,
  };
}

function makeRecorder() {
  return {} as Parameters<typeof buildRunnerAgentChain>[1];
}

function getAgentToolNames(
  role: AmaRole,
  hasCapabilityRuntime = true,
  hasWorkflowHost = true,
  hasSessionHistory = false,
): readonly string[] {
  const ctx = hasSessionHistory
    ? { ...makeCtx(hasCapabilityRuntime, hasWorkflowHost), loadSessionHistory: async () => null }
    : makeCtx(hasCapabilityRuntime, hasWorkflowHost);
  const chain = buildRunnerAgentChain(ctx, makeRecorder());
  if (role !== 'worker') {
    throw new Error(`FEATURE_193: role '${role}' retired with V1 chain`);
  }
  return (chain.worker.tools ?? [])
    .map((t) => (t as { name: string }).name)
    .filter((name): name is string => typeof name === 'string')
    .sort();
}

describe('FEATURE_168 — AMA agent tool wiring (per-role full set)', () => {
  it(`worker.tools === getAmaRoleExpectedToolNames('worker')`, () => {
    const actual = getAgentToolNames('worker');
    const expected = getAmaRoleExpectedToolNames('worker');
    expect(actual).toEqual(expected);
  });

  it('exposes exact-history tools only when the runtime bound a supported lineage loader', () => {
    const unsupported = getAgentToolNames('worker');
    expect(unsupported).not.toContain('session_history_search');
    expect(unsupported).not.toContain('session_history_read');

    const chain = buildRunnerAgentChain(makeHistoryCtx(), makeRecorder());
    const supported = (chain.worker.tools ?? []).map((tool) => tool.name);
    expect(supported).toContain('session_history_search');
    expect(supported).toContain('session_history_read');
  });

  it('applies caller tool exclusions and visibility policy to the Worker schema', () => {
    const ctx: KodaXToolExecutionContext = {
      ...makeCtx(),
      excludeTools: ['read'],
      toolVisibilityPolicy: (tool) => tool.sideEffect === 'readonly',
    };
    const chain = buildRunnerAgentChain(ctx, makeRecorder());
    const names = (chain.worker.tools ?? []).map((tool) => tool.name);

    expect(names).not.toContain('read');
    expect(names).not.toContain('bash');
    expect(names).toContain('glob');
  });

  it('worker hides MCP tools when no extension runtime is bound', () => {
    const actual = getAgentToolNames('worker', false);
    const expected = getAmaRoleExpectedToolNames('worker', false);
    expect(actual).toEqual(expected);
    for (const mcpTool of MCP_TOOL_NAMES) {
      expect(actual, `worker should hide ${mcpTool} without extension runtime`).not.toContain(mcpTool);
    }
  });

  it('worker exposes MCP tools when an extension runtime is bound', () => {
    const actual = getAgentToolNames('worker', true);
    for (const mcpTool of MCP_TOOL_NAMES) {
      expect(actual, `worker should expose ${mcpTool} with extension runtime`).toContain(mcpTool);
    }
  });

  it('run_workflow is host-conditional for an explicit Workflow request', () => {
    expect(getAgentToolNames('worker', true, true)).toContain('run_workflow');
    expect(getAgentToolNames('worker', true, false)).not.toContain('run_workflow');
  });

  it('exposes the explicit Workflow activation policy only with a Workflow host', () => {
    const workflowDescription = (hasWorkflowHost: boolean): string => {
      const chain = buildRunnerAgentChain(makeCtx(true, hasWorkflowHost), makeRecorder());
      const workflow = (chain.worker.tools ?? []).find(
        (t) => (t as { name?: string }).name === 'run_workflow',
      ) as { description?: string } | undefined;
      return workflow?.description ?? '';
    };
    expect(workflowDescription(true)).toContain('Explicitly requested Workflow execution');
    expect(workflowDescription(false)).toBe('');
  });

  it('worker has no V1 emit tools (F193 V1 chain retired) and no emit_handoff (F190)', () => {
    const allNames = getAgentToolNames('worker');
    for (const banned of ['emit_scout_verdict', 'emit_contract', 'emit_handoff', 'emit_verdict']) {
      expect(allNames, `worker should not carry ${banned}`).not.toContain(banned);
    }
  });
});

describe('F270 — canonical Agent collaboration tools are wired', () => {
  it('worker exposes the unified Actor control surface', () => {
    const names = getAgentToolNames('worker');
    for (const name of [
      'spawn_agent',
      'send_message',
      'followup_task',
      'wait_agent',
      'interrupt_agent',
      'list_agents',
      'agent_output',
    ]) {
      expect(names).toContain(name);
    }
    for (const retired of ['dispatch_child_task', 'task_stop', 'task_output']) {
      expect(names).not.toContain(retired);
    }
  });
});

describe('FEATURE_168 — repo-intel pull tools (FEATURE_161 v0.7.41 wiring fix)', () => {
  const PULL_TOOLS = [
    'repo_overview',
    'changed_scope',
    'changed_diff',
    'changed_diff_bundle',
    'module_context',
    'symbol_context',
    'process_context',
    'impact_estimate',
    'relationship_scan',
  ] as const;

  it('worker has all repo-intel pull tools (Worker prompt FEATURE_161+ teaches them)', () => {
    const names = getAgentToolNames('worker');
    for (const pullTool of PULL_TOOLS) {
      expect(names, `worker missing ${pullTool}`).toContain(pullTool);
    }
  });
});

describe('FEATURE_168 — web/search tools (FEATURE_168 Tier D wiring fix)', () => {
  const WEB_TOOLS = ['web_search', 'web_fetch', 'code_search', 'semantic_lookup'] as const;

  it('worker has web/search tools', () => {
    const names = getAgentToolNames('worker');
    for (const webTool of WEB_TOOLS) {
      expect(names, `worker missing ${webTool}`).toContain(webTool);
    }
  });
});

describe('FEATURE_250 — managed-path progressive disclosure (deferred hint-swap)', () => {
  const MCP_SET = new Set<string>([...MCP_TOOL_NAMES]);

  function workerTools(): Array<{ name: string; description?: string }> {
    const chain = buildRunnerAgentChain(makeCtx(true, true), makeRecorder());
    return (chain.worker.tools ?? []) as Array<{ name: string; description?: string }>;
  }
  function workerTool(name: string): { name: string; description?: string } | undefined {
    return workerTools().find((t) => t.name === name);
  }

  it('every deferred non-mcp tool on the worker shows its one-line searchHint (not the full description)', () => {
    const deferredPresent = workerTools().filter(
      (t) => DEFERRED_TOOL_HINTS[t.name] !== undefined && !MCP_SET.has(t.name),
    );
    // repo-intel (6) + web/code (4) are always wired to the worker, so the
    // deferred-on-worker set is non-trivial.
    expect(deferredPresent.length).toBeGreaterThanOrEqual(10);
    for (const t of deferredPresent) {
      expect(t.description, `${t.name} should be hint-swapped to its searchHint`).toBe(
        DEFERRED_TOOL_HINTS[t.name],
      );
    }
  });

  it('the searchHint is a strict shrink of the full description (real token savings)', () => {
    // Sanity that the swap actually reduces bytes — not a no-op.
    for (const name of ['module_context', 'web_fetch', 'code_search']) {
      const hint = DEFERRED_TOOL_HINTS[name]!;
      const full = getToolDefinition(name)?.description ?? '';
      expect(hint.length, `${name} hint should be shorter than full`).toBeLessThan(full.length);
      expect(workerTool(name)?.description).toBe(hint);
    }
  });

  it('mcp_* tools stay resident with their full description (NOT hint-swapped — mutation risk / uneval\'d)', () => {
    for (const name of MCP_TOOL_NAMES) {
      const tool = workerTool(name);
      expect(tool, `worker missing mcp tool ${name}`).toBeTruthy();
      expect(tool!.description, `${name} must NOT be hint-swapped`).not.toBe(DEFERRED_TOOL_HINTS[name]);
      expect(tool!.description).toBe(getToolDefinition(name)?.description);
    }
  });

  it('tool_search is wired (the fetch path for deferred schemas) with its own full description', () => {
    const tool = workerTool('tool_search');
    expect(tool, 'worker missing tool_search').toBeTruthy();
    expect(tool!.description).toBe(getToolDefinition('tool_search')?.description);
  });

  it('portable bridge meta-tools are executable on the managed path', async () => {
    cleanupToolRegistrations.push(registerTool({
      name: 'managed_bridge_target',
      description: 'Managed bridge test target.',
      input_schema: {
        type: 'object',
        properties: {
          value: { type: 'string' },
        },
        required: ['value'],
      },
      handler: async (input) => `managed-target:${String(input.value)}`,
      sideEffect: 'readonly',
      toClassifierInput: () => '',
    }));

    const chain = buildRunnerAgentChain(makeCtx(true, true), makeRecorder());
    const tools = (chain.worker.tools ?? []) as Array<{
      name: string;
      execute?: (input: Record<string, unknown>, ctx: { agent: typeof chain.worker; toolCallId: string }) => Promise<{ content: string | readonly unknown[] }>;
    }>;
    const describeTool = tools.find((tool) => tool.name === 'tool_describe');
    const callTool = tools.find((tool) => tool.name === 'tool_call');

    expect(describeTool?.execute, 'worker missing executable tool_describe').toBeTypeOf('function');
    expect(callTool?.execute, 'worker missing executable tool_call').toBeTypeOf('function');

    const describeResult = await describeTool!.execute!(
      { name: 'managed_bridge_target' },
      { agent: chain.worker, toolCallId: 'describe-1' },
    );
    expect(String(describeResult.content)).toContain('"name":"managed_bridge_target"');
    expect(String(describeResult.content)).toContain('Managed bridge test target.');

    const callResult = await callTool!.execute!(
      { name: 'managed_bridge_target', input: { value: 'ok' } },
      { agent: chain.worker, toolCallId: 'call-1' },
    );
    expect(callResult.content).toBe('managed-target:ok');
  });

  it('preserves registered multimodal results through the managed bridge', async () => {
    const content = [{ type: 'text', text: 'image result' },
      { type: 'image', path: '/pixel.png', mediaType: 'image/png' }] as const;
    cleanupToolRegistrations.push(registerTool({
      name: 'managed_image_target', description: 'Image target',
      input_schema: { type: 'object', properties: {} },
      handler: async () => content, sideEffect: 'readonly', toClassifierInput: () => '',
    }));
    const chain = buildRunnerAgentChain(makeCtx(false, false), makeRecorder());
    const bridge = chain.worker.tools?.find((tool) => tool.name === 'tool_call') as RunnableTool | undefined;
    expect(bridge).toBeDefined();
    const result = await bridge!.execute({ name: 'managed_image_target', input: {} },
      { agent: chain.worker, toolCallId: 'image-bridge' });
    expect(result.content).toEqual(content);
    expect(result.isError).toBe(false);
  });

  it('does not start a bridge target after cancellation during an extension permission hook', async () => {
    const targetExecuted = vi.fn(async () => 'unexpected');
    cleanupToolRegistrations.push(registerTool({
      name: 'managed_bridge_cancel_target',
      description: 'Managed bridge cancellation target.',
      input_schema: { type: 'object', properties: {} },
      handler: targetExecuted,
      sideEffect: 'write',
      toClassifierInput: () => '',
    }));
    let releaseHook: (() => void) | undefined;
    let hookEntered: (() => void) | undefined;
    const hookStarted = new Promise<void>((resolve) => { hookEntered = resolve; });
    const extensionRuntime = createExtensionRuntime().activate();
    extensionRuntime.registerHook('tool:before', async () => {
      hookEntered?.();
      await new Promise<void>((resolve) => { releaseHook = resolve; });
    });
    const events: KodaXEvents = {
      beforeToolExecute: async () => true,
    };
    const chain = buildRunnerAgentChain(
      makeCtx(true, true),
      makeRecorder(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      events,
    );
    const callTool = (chain.worker.tools ?? []).find((tool) => tool.name === 'tool_call') as {
      execute?: (
        input: Record<string, unknown>,
        ctx: {
          agent: typeof chain.worker;
          toolCallId: string;
          abortSignal?: AbortSignal;
        },
      ) => Promise<{ content: string | readonly unknown[] }>;
    } | undefined;
    const controller = new AbortController();

    try {
      const executing = callTool!.execute!(
        { name: 'managed_bridge_cancel_target', input: {} },
        {
          agent: chain.worker,
          toolCallId: 'call-cancelled',
          abortSignal: controller.signal,
        },
      );
      await hookStarted;
      controller.abort(new Error('runtime run aborted'));
      releaseHook?.();

      await expect(executing).rejects.toMatchObject({ name: 'AbortError' });
      expect(targetExecuted).not.toHaveBeenCalled();
    } finally {
      releaseHook?.();
      await extensionRuntime.dispose();
    }
  });

  it('managed tool_describe preserves every requested schema without character caps', async () => {
    const names = Array.from({ length: 9 }, (_, index) => `managed_full_schema_${index}`);
    for (const [index, name] of names.entries()) {
      cleanupToolRegistrations.push(registerTool({
        name,
        description: index === 8
          ? `large-start-${'detail '.repeat(2_400)}large-end`
          : `schema ${index}`,
        input_schema: { type: 'object', properties: {} },
        handler: async () => 'ok',
        sideEffect: 'readonly',
        toClassifierInput: () => '',
      }));
    }

    const chain = buildRunnerAgentChain(makeCtx(true, true), makeRecorder());
    const describeTool = (chain.worker.tools ?? []).find((tool) => tool.name === 'tool_describe') as {
      execute?: (input: Record<string, unknown>, ctx: { agent: typeof chain.worker; toolCallId: string }) => Promise<{ content: string | readonly unknown[] }>;
    } | undefined;
    const result = await describeTool!.execute!(
      { names },
      { agent: chain.worker, toolCallId: 'describe-full' },
    );
    const content = String(result.content);

    expect(content).toContain('"name":"managed_full_schema_8"');
    expect(content).toContain('large-start-');
    expect(content).toContain('large-end');
    expect(content).not.toContain('tool_describe output truncated');
  });

  it('non-deferred tools keep their full description (e.g. bash)', () => {
    expect(workerTool('bash')?.description).toBe(getToolDefinition('bash')?.description);
  });

  it('keeps goal lifecycle tools resident with full descriptions', () => {
    for (const name of ['get_goal', 'create_goal', 'update_goal']) {
      expect(workerTool(name)?.description).toBe(getToolDefinition(name)?.description);
      expect(DEFERRED_TOOL_HINTS[name]).toBeUndefined();
    }
  });

  it('input_schema is UNCHANGED by the hint-swap (tool stays directly callable off the hint)', () => {
    for (const name of ['module_context', 'web_fetch']) {
      const tool = workerTool(name) as { input_schema?: unknown } | undefined;
      expect(tool?.input_schema).toEqual(getToolDefinition(name)?.input_schema);
    }
  });
});

describe('FEATURE_168 — registry orphan check (no registered tool falls off Worker)', () => {
  it('every non-specialized registry tool appears in the Worker role', () => {
    const allRegistered = listToolDefinitions().map((d) => d.name);
    const specializedPaths = getAmaRoleEffectiveExclude('worker'); // worker has only BASELINE
    const nonSpecialized = allRegistered.filter((name) => !specializedPaths.has(name));

    const workerTools = new Set<string>(getAgentToolNames('worker', true, true, true));

    const orphans = nonSpecialized.filter((name) => !workerTools.has(name));
    expect(orphans, 'tools registered but exposed to no AMA role').toEqual([]);
  });
});

describe('FEATURE_294 — run-scoped host tools on the AMA managed path', () => {
  function makeHostCtx(): KodaXToolExecutionContext {
    return {
      ...makeCtx(true, true),
      extensionRuntime: {
        listRunTools: () => [{
          name: 'space_artifact_create',
          description: 'Create a Space artifact.',
          inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
          capabilityId: 'host:lease-ama:space_artifact_create',
          sideEffect: 'mutates-state',
          planModeAllowed: false,
        }],
        executeCapability: async (providerId, capabilityId) => ({
          kind: 'tool' as const,
          content: `host-called:${providerId}:${capabilityId}`,
        }),
      },
    };
  }

  it('worker materializes run-scoped host tools next to the registry set', () => {
    const chain = buildRunnerAgentChain(makeHostCtx(), makeRecorder());
    const names = (chain.worker.tools ?? []).map((tool) => (tool as { name: string }).name);
    expect(names).toContain('space_artifact_create');
    // Plain runs without a host binding keep the surface unchanged.
    expect(getAgentToolNames('worker', true, true)).not.toContain('space_artifact_create');
  });

  it('materialized host tool execution routes through the capability channel', async () => {
    const chain = buildRunnerAgentChain(makeHostCtx(), makeRecorder());
    const tools = (chain.worker.tools ?? []) as Array<{
      name: string;
      execute?: (input: Record<string, unknown>, ctx: { agent: unknown; toolCallId: string }) => Promise<{ content: string | readonly unknown[] }>;
    }>;
    const hostTool = tools.find((tool) => tool.name === 'space_artifact_create');
    expect(hostTool?.execute, 'worker missing executable host tool').toBeTypeOf('function');
    const result = await hostTool!.execute!(
      { title: 'Report' },
      { agent: chain.worker, toolCallId: 'host-1' },
    );
    expect(String(result.content)).toContain('host-called:mcp:host:lease-ama:space_artifact_create');
  });
});
