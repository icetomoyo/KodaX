import { allowAll } from './permission-gate.js';
import { describe, expect, it } from 'vitest';

import type { RunScopedToolDefinition } from '../extensions/runtime-contract.js';
import {
  executeRunScopedTool,
  listRunScopedTools,
  lookupRunScopedTool,
  runScopedToolMap,
  toModelToolDefinition,
} from './run-scoped-tools.js';
import { applyToolVisibilityPolicy, getActiveToolDefinitions } from './tool-resolution.js';
import { isToolMutation, isToolPlanModeAllowed } from '../tools/index.js';
import { executeToolCall } from './tool-dispatch.js';
import { buildRuntimeSessionState } from './runtime-session-state.js';
import { buildToolExecutionContext } from './tool-execution-context.js';
import type { KodaXEvents, KodaXToolExecutionContext } from '../types.js';
import type { ExtensionRuntimeContract } from '../extensions/runtime-contract.js';

/**
 * FEATURE_294 — Host Tools first-class visibility. Run-scoped definitions ride
 * on the per-run extensionRuntime (`listRunTools`) and must bridge into the
 * tool surface WITHOUT entering the process-global TOOL_REGISTRY: name-list
 * assembly, policy/metadata predicates, model schema materialization, and
 * dispatch all resolve them from the run scope, fail-closed elsewhere.
 */

function hostDefinition(overrides: Partial<RunScopedToolDefinition> = {}): RunScopedToolDefinition {
  return {
    name: 'space_artifact_create',
    description: 'Create an artifact in Space',
    inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
    capabilityId: 'host:lease-1:space_artifact_create',
    sideEffect: 'mutates-state',
    planModeAllowed: false,
    ...overrides,
  };
}

function fakeRuntime(
  definitions: readonly RunScopedToolDefinition[],
  execute?: ExtensionRuntimeContract['executeCapability'],
): ExtensionRuntimeContract {
  return {
    listRunTools: (providerId?: string) => (providerId === 'mcp' ? [...definitions] : []),
    executeCapability: execute ?? (async () => {
      throw new Error('unexpected capability execution');
    }),
  } as Partial<ExtensionRuntimeContract> as ExtensionRuntimeContract;
}

function ctxWith(runtime: ExtensionRuntimeContract | undefined): KodaXToolExecutionContext {
  const base = buildToolExecutionContext({
    options: { provider: 'openai' },
    runtime: undefined,
    managedProtocolPayloadRef: { current: undefined },
  });
  return runtime === undefined ? base : { ...base, extensionRuntime: runtime };
}

describe('run-scoped tool helpers', () => {
  it('lists definitions only for the mcp provider and tolerates absent runtimes', () => {
    const definition = hostDefinition();
    const runtime = fakeRuntime([definition]);
    expect(listRunScopedTools(runtime)).toEqual([definition]);
    expect(listRunScopedTools(runtime, 'github')).toEqual([]);
    expect(listRunScopedTools(undefined)).toEqual([]);
    expect(listRunScopedTools(null)).toEqual([]);
    expect(listRunScopedTools({} as ExtensionRuntimeContract)).toEqual([]);
  });

  it('maps and looks up definitions by name', () => {
    const definition = hostDefinition();
    const map = runScopedToolMap([definition]);
    expect(map.get('space_artifact_create')).toBe(definition);
    expect(lookupRunScopedTool(fakeRuntime([definition]), 'space_artifact_create')).toBe(definition);
    expect(lookupRunScopedTool(fakeRuntime([definition]), 'missing_tool')).toBeUndefined();
    expect(lookupRunScopedTool(undefined, 'space_artifact_create')).toBeUndefined();
  });

  it('projects a definition onto the model tool shape', () => {
    const definition = hostDefinition();
    const model = toModelToolDefinition(definition);
    expect(model.name).toBe('space_artifact_create');
    expect(model.description).toBe(definition.description);
    expect(model.input_schema).toEqual(definition.inputSchema);
  });

  it('normalizes an open schema shape onto the provider contract', () => {
    const empty = toModelToolDefinition({ ...hostDefinition(), inputSchema: {} });
    expect(empty.input_schema).toEqual({ type: 'object', properties: {} });

    const partial = toModelToolDefinition({
      ...hostDefinition(),
      inputSchema: { properties: { title: { type: 'string' } }, required: ['title', 42] },
    });
    expect(partial.input_schema).toEqual({
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
    });
  });

  it('executes through the capability channel and renders content', async () => {
    const definition = hostDefinition();
    const calls: Array<{ id: string; input: Record<string, unknown> }> = [];
    const ctx = ctxWith(fakeRuntime([definition], async (providerId, id, input) => {
      calls.push({ id, input: input as Record<string, unknown> });
      expect(providerId).toBe('mcp');
      return {
        kind: 'tool',
        content: 'artifact-1',
      } as Awaited<ReturnType<ExtensionRuntimeContract['executeCapability']>>;
    }));
    const result = await executeRunScopedTool(ctx, definition, { title: 'Report' });
    expect(calls).toEqual([{ id: 'host:lease-1:space_artifact_create', input: { title: 'Report' } }]);
    expect(result).toContain('artifact-1');
  });

  it('fail-closes when the run carries no capability runtime', async () => {
    const definition = hostDefinition();
    const result = await executeRunScopedTool(ctxWith(undefined), definition, {});
    expect(result.startsWith('[Tool Error]')).toBe(true);
  });

  it('surfaces capability failures as tool errors', async () => {
    const definition = hostDefinition();
    const ctx = ctxWith(fakeRuntime([definition], async () => {
      throw new Error('lease revoked');
    }));
    const result = await executeRunScopedTool(ctx, definition, {});
    expect(result.startsWith('[Tool Error]')).toBe(true);
    expect(result).toContain('lease revoked');
  });
});

describe('run-scoped metadata in visibility policy and predicates', () => {
  it('resolves policy metadata from the run-scoped map', () => {
    const readOnly = hostDefinition({
      name: 'space_artifact_read',
      capabilityId: 'host:lease-1:space_artifact_read',
      sideEffect: 'readonly',
      planModeAllowed: true,
    });
    const mutating = hostDefinition();
    const map = runScopedToolMap([readOnly, mutating]);
    const allowReadOnlyOnly: Parameters<typeof applyToolVisibilityPolicy>[1] = (candidate) => (
      candidate.sideEffect === 'readonly'
    );
    expect(applyToolVisibilityPolicy(
      ['space_artifact_read', 'space_artifact_create'],
      allowReadOnlyOnly,
      map,
    )).toEqual(['space_artifact_read']);
  });

  it('drops names resolvable nowhere (fail-closed)', () => {
    expect(applyToolVisibilityPolicy(
      ['totally_unknown_tool'],
      () => true,
      runScopedToolMap([]),
    )).toEqual([]);
  });

  it('feeds run-scoped metadata into the registry predicates', () => {
    const readOnly = hostDefinition({
      name: 'space_artifact_read',
      sideEffect: 'readonly',
      planModeAllowed: true,
    });
    const map = runScopedToolMap([readOnly, hostDefinition()]);
    expect(isToolPlanModeAllowed('space_artifact_read', map)).toBe(true);
    expect(isToolPlanModeAllowed('space_artifact_create', map)).toBe(false);
    expect(isToolMutation('space_artifact_read', map)).toBe(false);
    expect(isToolMutation('space_artifact_create', map)).toBe(true);
  });
});

describe('run-scoped definitions in the active tool surface', () => {
  it('appends schemas for run-scoped names without registry registration', () => {
    const definition = hostDefinition();
    const names = getActiveToolDefinitions(
      ['read', definition.name],
      undefined,
      false,
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      [definition],
    ).map((tool) => tool.name);
    expect(names).toContain('read');
    expect(names).toContain('space_artifact_create');
  });

  it('keeps the registry definition when names collide', () => {
    const definition = hostDefinition({ name: 'read' });
    const tools = getActiveToolDefinitions(
      ['read'],
      undefined,
      false,
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      [definition],
    );
    expect(tools).toHaveLength(1);
    expect(tools[0]?.description).not.toBe(definition.description);
  });
});

describe('run-scoped dispatch through executeToolCall', () => {
  it('routes a run-scoped name to the capability channel when the registry cannot resolve it', async () => {
    const definition = hostDefinition();
    const executed: string[] = [];
    const ctx = ctxWith(fakeRuntime([definition], async (_providerId, id) => {
      executed.push(id);
      return { kind: 'tool', content: 'made-artifact' } as Awaited<
        ReturnType<ExtensionRuntimeContract['executeCapability']>
      >;
    }));
    const events: KodaXEvents = { beforeToolExecute: allowAll };
    const result = await executeToolCall(
      events,
      { id: 'call-1', name: definition.name, input: { title: 'Report' } },
      ctx,
      buildRuntimeSessionState({ activeTools: [definition.name] }),
      [definition.name],
      undefined,
    );
    expect(executed).toEqual(['host:lease-1:space_artifact_create']);
    expect(result).toContain('made-artifact');
  });

  it('prefers the registered implementation when a registry name also exists as a run-scoped lease tool', async () => {
    // Registry-first dispatch: the schema the model saw (the registry table)
    // is the implementation that executes; a same-name lease tool must never
    // intercept a registered tool call.
    const definition = hostDefinition({ name: 'read' });
    const executed: string[] = [];
    const ctx = ctxWith(fakeRuntime([definition], async (_providerId, id) => {
      executed.push(id);
      return { kind: 'tool', content: 'lease-side-read' } as Awaited<
        ReturnType<ExtensionRuntimeContract['executeCapability']>
      >;
    }));
    const result = await executeToolCall(
      {},
      { id: 'call-3', name: 'read', input: {} },
      ctx,
      buildRuntimeSessionState({ activeTools: ['read'] }),
      ['read'],
      undefined,
    );
    expect(executed).toEqual([]);
    expect(result).not.toContain('lease-side-read');
  });

  it('reports a revoked host tool lease when a frozen run candidate resolves nowhere', async () => {
    // The name passed the frozen per-run candidate gate (activeToolNames) but
    // resolves in neither the registry nor the live lease list: the lease was
    // revoked or expired mid-run. Dispatch must fail closed with the revoked
    // attribution instead of executing anything.
    const ctx = ctxWith(fakeRuntime([]));
    const result = await executeToolCall(
      { beforeToolExecute: allowAll },
      { id: 'call-4', name: 'space_artifact_create', input: {} },
      ctx,
      buildRuntimeSessionState({ activeTools: ['space_artifact_create'] }),
      ['space_artifact_create'],
      undefined,
    );
    expect(result.startsWith('[Tool Error]')).toBe(true);
    expect(result).toContain('revoked');
  });

  it('rejects a run-scoped name that is not active for the run', async () => {
    const definition = hostDefinition();
    const ctx = ctxWith(fakeRuntime([definition]));
    const result = await executeToolCall(
      { beforeToolExecute: allowAll },
      { id: 'call-2', name: definition.name, input: {} },
      ctx,
      buildRuntimeSessionState({ activeTools: ['read'] }),
      ['read'],
      undefined,
    );
    expect(result.startsWith('[Tool Error]')).toBe(true);
    expect(result).toContain('not active');
  });
});
